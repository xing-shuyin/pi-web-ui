import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import type { ToolStatus, UiMessage, UiState } from "../types";
import {
	classifyQuestionAddedScroll,
	classifyScroll,
	shouldEscapeOnScroll,
	shouldPreloadEarlier,
	shouldScrollToBottomOnStreamChange,
} from "./scroll-classify";

/**
 * 保护窗口时长（毫秒）：程序吸底后的短时间内，onScroll 产生的位移均视为程序吸底引起，
 * 绝不误判为用户向上离开意图。
 */
export const PROGRAMMATIC_SCROLL_GRACE_MS = 250;

/** 向上无限滚动自动静默预加载阈值（像素）：距离顶部不足此距离且仍有更早历史时，提前静默拉取。 */
export const PRELOAD_EARLIER_THRESHOLD_PX = 400;

export interface UseChatScrollOptions {
	messages: UiMessage[];
	isStreaming?: boolean;
	liveOutputs?: ReadonlyMap<string, { toolName: string; text: string }> | Map<string, string>;
	toolStatuses?: ReadonlyMap<string, ToolStatus>;
	queue?: UiState["queue"];
	conversationId?: string | null;
	sessionFile?: string | null;
	questions: { id: string; text: string }[];
	jumpTarget?: unknown;
	urlJumpMessageId?: string | null;
	hasEarlier: boolean;
	loadEarlier: () => void;
	scheduleActiveFromScroll: () => void;
	scheduleSweep: () => void;
	/** 可选注入外部已有的 scrollRef。若不提供则内部自动创建。 */
	scrollRef?: React.RefObject<HTMLDivElement | null>;
	/** 可选注入外部已有的 stickRef。若不提供则内部自动创建。 */
	stickRef?: React.MutableRefObject<boolean>;
	/** 可选注入外部已有的 escapedRef。若不提供则内部自动创建。 */
	escapedRef?: React.MutableRefObject<boolean>;
}

export interface UseChatScrollReturn {
	scrollRef: React.RefObject<HTMLDivElement | null>;
	railRef: React.RefObject<HTMLDivElement | null>;
	stickBottom: boolean;
	escapedRef: React.MutableRefObject<boolean>;
	stickRef: React.MutableRefObject<boolean>;
	scrollToBottom: () => void;
	pinToBottom: () => void;
	disengageStick: () => void;
	pauseForSelection: () => void;
	handleWheel: (e: React.WheelEvent<HTMLDivElement>) => void;
	handleTouchStart: (e: React.TouchEvent<HTMLDivElement>) => void;
	handleTouchMove: (e: React.TouchEvent<HTMLDivElement>) => void;
	handlePointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
	onScroll: () => void;
}

/**
 * useChatScroll — 对话流贴底滚动与用户逃逸阅读生命周期统一管理器。
 *
 * 核心设计准则：
 * 1. 职责彻底内聚：将手势感知、吸底定时器、流式追尾、逃逸保护及原生锚定交互从消息渲染树中解耦；
 * 2. 用户逃逸意图不可侵犯：一旦用户主动向上滚动（escaped=true），流式多回合、工具交替或页面刷新
 *    坚决不强行吸底打扰；
 * 3. 严格定时器生命周期：追帧定时器统一纳管，用户任何向上手势当场清理，杜绝后台偷袭。
 */
export function useChatScroll(opts: UseChatScrollOptions): UseChatScrollReturn {
	const {
		messages,
		isStreaming,
		liveOutputs,
		toolStatuses,
		queue,
		conversationId,
		sessionFile,
		questions,
		jumpTarget,
		urlJumpMessageId,
		hasEarlier,
		loadEarlier,
		scheduleActiveFromScroll,
		scheduleSweep,
	} = opts;

	const internalScrollRef = useRef<HTMLDivElement | null>(null);
	const scrollRef = opts.scrollRef ?? internalScrollRef;
	const railRef = useRef<HTMLDivElement | null>(null);

	const [stickBottom, setStickBottom] = useState(true);
	const internalStickRef = useRef(true);
	const stickRef = opts.stickRef ?? internalStickRef;
	const internalEscapedRef = useRef(false);
	const escapedRef = opts.escapedRef ?? internalEscapedRef;

	/** 上一帧 scrollTop —— 判定滚动方向（向上 = 用户要离开底部）。 */
	const prevStRef = useRef(0);
	/** 上一帧 scrollHeight —— 布局塌缩/增长的判据。 */
	const prevScrollHeightRef = useRef(0);
	/** Timestamp until which scroll events are treated as programmatic. */
	const progUntilRef = useRef(0);
	/** 用户物理向上滚动/滑动手势的最新时间戳。 */
	const userUpwardGestureTimeRef = useRef(0);
	/** 用户指针是否在容器内按下（用于识别按住滚动条滑块拖动）。 */
	const isPointerDownRef = useRef(false);
	/** 鼠标中键是否按下（中键自动滚动期间视为物理意图）。 */
	const middleDownRef = useRef(false);
	/** 触摸起始 clientY。 */
	const touchStartYRef = useRef(0);

	/** 在途的滚动吸底定时器（120ms/300ms/600ms），在用户主动向上滚动时当场清理。 */
	const scrollTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
	const clearScrollTimers = useCallback(() => {
		for (const t of scrollTimersRef.current) clearTimeout(t);
		scrollTimersRef.current = [];
	}, []);

	/** 框选文本暂停吸底。 */
	const pauseForSelection = useCallback(() => {
		clearScrollTimers();
		escapedRef.current = true;
		stickRef.current = false;
		setStickBottom(false);
	}, [clearScrollTimers]);

	/** 用户主动向上手势：当场同步切断吸底并清理所有在途定时器。 */
	const disengageStick = useCallback(() => {
		clearScrollTimers();
		userUpwardGestureTimeRef.current = Date.now();
		progUntilRef.current = 0;
		escapedRef.current = true;
		stickRef.current = false;
		setStickBottom(false);
	}, [clearScrollTimers]);

	/** 统一安全的程序吸底总阀门。 */
	const pinToBottom = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		if (escapedRef.current || !stickRef.current || Date.now() - userUpwardGestureTimeRef.current < 500) {
			return;
		}
		progUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS;
		el.scrollTop = el.scrollHeight;
		prevStRef.current = el.scrollTop;
		prevScrollHeightRef.current = el.scrollHeight;
	}, [scrollRef]);

	/** 主动滚动到底部（发新消息、点击回底按钮时触发）。 */
	const scrollToBottom = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		clearScrollTimers();
		userUpwardGestureTimeRef.current = 0;
		stickRef.current = true;
		escapedRef.current = false;
		setStickBottom(true);
		pinToBottom();
		requestAnimationFrame(() => requestAnimationFrame(pinToBottom));
		scrollTimersRef.current.push(setTimeout(pinToBottom, 120));
		scrollTimersRef.current.push(setTimeout(pinToBottom, 300));
		scrollTimersRef.current.push(setTimeout(pinToBottom, 600));
	}, [pinToBottom, clearScrollTimers, scrollRef]);

	// 滚轮事件监听：内部容器可滚时透传，否则识别向上离开/向下归底
	const hasEarlierRef = useRef(hasEarlier);
	hasEarlierRef.current = hasEarlier;
	const loadEarlierRef = useRef(loadEarlier);
	loadEarlierRef.current = loadEarlier;

	/** 向上无限滚动动态水位线预加载：进入第二页（上半部/距顶两屏内）即提前在后台拉取第三页 */
	const maybePreloadEarlier = useCallback(
		(isMovingUp: boolean) => {
			const el = scrollRef.current;
			if (!el) return;
			if (
				shouldPreloadEarlier({
					scrollTop: el.scrollTop,
					scrollHeight: el.scrollHeight,
					clientHeight: el.clientHeight,
					hasEarlier: hasEarlierRef.current,
					isMovingUp,
				})
			) {
				loadEarlierRef.current();
			}
		},
		[scrollRef],
	);

	const handleWheel = useCallback(
		(e: React.WheelEvent<HTMLDivElement>) => {
			if (e.deltaY < 0) {
				const target = e.target instanceof Element ? e.target : null;
				const innerScroll = target?.closest<HTMLElement>(".toolcall-output pre, .toolcall-args pre, .codemode-code");
				if (innerScroll && innerScroll.scrollHeight > innerScroll.clientHeight && innerScroll.scrollTop > 0) {
					return;
				}
				userUpwardGestureTimeRef.current = Date.now();
				disengageStick();
				maybePreloadEarlier(true);
			} else if (e.deltaY > 0) {
				userUpwardGestureTimeRef.current = 0;
				const el = scrollRef.current;
				if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 96) {
					escapedRef.current = false;
					stickRef.current = true;
					setStickBottom(true);
				}
			}
		},
		[disengageStick, maybePreloadEarlier, scrollRef],
	);

	const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
		if (e.touches.length > 0) {
			touchStartYRef.current = e.touches[0].clientY;
		}
	}, []);

	const handleTouchMove = useCallback(
		(e: React.TouchEvent<HTMLDivElement>) => {
			if (e.touches.length > 0) {
				const deltaY = e.touches[0].clientY - touchStartYRef.current;
				if (deltaY > 8) {
					disengageStick();
					maybePreloadEarlier(true);
				} else if (deltaY < -8) {
					userUpwardGestureTimeRef.current = 0;
					const el = scrollRef.current;
					if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 96) {
						escapedRef.current = false;
						stickRef.current = true;
						setStickBottom(true);
					}
				}
			}
		},
		[disengageStick, maybePreloadEarlier, scrollRef],
	);

	const handlePointerDown = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			if (e.button === 1) {
				userUpwardGestureTimeRef.current = Date.now();
				disengageStick();
				return;
			}
			if (e.button !== 0) return;
			const el = e.currentTarget;
			if (e.target === el && e.clientX >= el.getBoundingClientRect().left + el.clientWidth) {
				isPointerDownRef.current = true;
			}
		},
		[disengageStick],
	);

	// 全局 pointerup / pointerdown / keydown 监听
	useEffect(() => {
		const onPointerUp = (e?: MouseEvent | PointerEvent) => {
			isPointerDownRef.current = false;
			if (!e || (e as MouseEvent).button === 1) middleDownRef.current = false;
		};
		const onPointerDownGlobal = (e: MouseEvent | PointerEvent) => {
			if (e.button === 1) {
				middleDownRef.current = true;
				userUpwardGestureTimeRef.current = Date.now();
				disengageStick();
			}
		};
		const onKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement | null;
			if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
				return;
			}
			if (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home") {
				disengageStick();
			} else if (e.key === "End") {
				userUpwardGestureTimeRef.current = 0;
			}
		};
		window.addEventListener("pointerup", onPointerUp);
		window.addEventListener("pointercancel", onPointerUp);
		window.addEventListener("pointerdown", onPointerDownGlobal, { capture: true });
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", onPointerUp);
			window.removeEventListener("pointerdown", onPointerDownGlobal, { capture: true });
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [disengageStick]);

	// 容器 onScroll 统一分类与决策
	const onScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const dSt = el.scrollTop - prevStRef.current;
		const dSh = el.scrollHeight - prevScrollHeightRef.current;
		prevStRef.current = el.scrollTop;
		prevScrollHeightRef.current = el.scrollHeight;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 36;
		const programmatic = Date.now() < progUntilRef.current;

		// 只要发生非程序性的真实向上位移（无论来自拖动滑块、触控板、滚轮或键盘），当场切断吸底
		if (!programmatic && dSt < -1) {
			disengageStick();
		}
		if (middleDownRef.current && dSt < 0) {
			userUpwardGestureTimeRef.current = Date.now();
			disengageStick();
		}

		const hasUserUpwardIntent =
			Date.now() - userUpwardGestureTimeRef.current < 800 ||
			(isPointerDownRef.current && dSt < 0) ||
			middleDownRef.current;

		const decision = classifyScroll({
			dSt,
			dSh,
			escaped: escapedRef.current,
			graceActive: programmatic,
			stuck: stickRef.current,
		});
		if (decision.reassert && !hasUserUpwardIntent) {
			pinToBottom();
		}
		const { shouldEscape, shouldReassert } = shouldEscapeOnScroll({
			decisionFlipEscape: decision.flipEscape,
			hasUserUpwardIntent,
			stuck: stickRef.current,
			escaped: escapedRef.current,
		});
		if (shouldEscape) {
			escapedRef.current = true;
			stickRef.current = false;
		} else if (shouldReassert) {
			pinToBottom();
		}

		if (!programmatic && !hasUserUpwardIntent) {
			if (dSt < 0) {
				// 无向上意图的负位移不撤销 stickRef
			} else if (nearBottom && (dSt > 0 || !escapedRef.current)) {
				stickRef.current = true;
				escapedRef.current = false;
			}
		}
		const isMovingUp = dSt < 0 || Date.now() - userUpwardGestureTimeRef.current < 800;
		maybePreloadEarlier(isMovingUp);
		setStickBottom((prev) => (prev !== stickRef.current ? stickRef.current : prev));
		scheduleActiveFromScroll();
		scheduleSweep();
	}, [scheduleActiveFromScroll, scheduleSweep, pinToBottom, disengageStick, maybePreloadEarlier, scrollRef]);

	// 流式启闭：仅在未逃逸时吸底跟随；流结束时沉降吸底
	const wasStreamingRef = useRef(!!isStreaming);
	useEffect(() => {
		const was = wasStreamingRef.current;
		wasStreamingRef.current = !!isStreaming;
		if (
			shouldScrollToBottomOnStreamChange({
				wasStreaming: was,
				isStreaming: !!isStreaming,
				escaped: escapedRef.current,
				hasJumpTarget: Boolean(jumpTarget || urlJumpMessageId),
			})
		) {
			scrollToBottom();
			return;
		}
		if (was && !isStreaming && !escapedRef.current) {
			const snap = () => {
				if (scrollRef.current && !escapedRef.current) {
					stickRef.current = true;
					setStickBottom(true);
					pinToBottom();
				}
			};
			requestAnimationFrame(() => requestAnimationFrame(snap));
		}
	}, [isStreaming, jumpTarget, urlJumpMessageId, scrollToBottom, pinToBottom, scrollRef]);

	// 会话切换与提问变化吸底
	const lastQuestionId = questions.length > 0 ? questions[questions.length - 1].id : null;
	const prevConvKeyRef = useRef(`${conversationId ?? ""}:${sessionFile ?? ""}`);
	const prevLastQuestionIdRef = useRef<string | null>(lastQuestionId);
	useEffect(() => {
		const convKey = `${conversationId ?? ""}:${sessionFile ?? ""}`;
		const convChanged = convKey !== prevConvKeyRef.current;
		const el = scrollRef.current;
		const nearBottom = el ? el.scrollHeight - el.scrollTop - el.clientHeight < 36 : true;
		const { shouldScroll } = classifyQuestionAddedScroll({
			convChanged,
			lastQuestionId,
			prevLastQuestionId: prevLastQuestionIdRef.current,
			escaped: escapedRef.current,
			nearBottom,
			hasJumpTarget: Boolean(jumpTarget || urlJumpMessageId),
		});
		prevConvKeyRef.current = convKey;
		prevLastQuestionIdRef.current = lastQuestionId;
		if (shouldScroll) {
			scrollToBottom();
		}
	}, [conversationId, sessionFile, lastQuestionId, jumpTarget, urlJumpMessageId, scrollToBottom]);

	// 渲染 Paint 前同步贴底（消除微颤；仅当视口物理上就在底部且未逃逸时）
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 36;
		if (stickRef.current && !escapedRef.current && nearBottom) {
			pinToBottom();
		}
	}, [messages, isStreaming, liveOutputs, toolStatuses, pinToBottom, scrollRef]);

	// 排队/插队气泡吸底
	const queueSig = queue ? queue.steering.join("\u0000") + "\u0001" + queue.followUp.join("\u0000") : "";
	const queueTotal = queue ? queue.steering.length + queue.followUp.length : 0;
	const prevQueueTotalRef = useRef(queueTotal);
	useLayoutEffect(() => {
		const added = queueTotal > prevQueueTotalRef.current;
		prevQueueTotalRef.current = queueTotal;
		if (added) {
			scrollToBottom();
			return;
		}
		const el = scrollRef.current;
		if (el && stickRef.current && !escapedRef.current) {
			pinToBottom();
		}
	}, [queueSig, queueTotal, scrollToBottom, pinToBottom, scrollRef]);

	// ResizeObserver 容器尺寸收缩修正
	useEffect(() => {
		const el = scrollRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		let prevH = el.clientHeight;
		const ro = new ResizeObserver(() => {
			const h = el.clientHeight;
			const grew = h - prevH;
			prevH = h;
			if (grew > 0) el.scrollTop = Math.min(el.scrollTop, el.scrollHeight - el.clientHeight);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [scrollRef]);

	// MutationObserver 容器内容无状态变动长高修正
	useEffect(() => {
		const el = scrollRef.current;
		if (!el || typeof MutationObserver === "undefined") return;
		let queued = false;
		const mo = new MutationObserver(() => {
			if (queued) return;
			queued = true;
			requestAnimationFrame(() => {
				queued = false;
				const el2 = scrollRef.current;
				if (el2 && stickRef.current && !escapedRef.current) {
					pinToBottom();
					setStickBottom(true);
				}
			});
		});
		mo.observe(el, { childList: true, subtree: true, characterData: true });
		return () => mo.disconnect();
	}, [pinToBottom, scrollRef]);

	// 悬浮提问导轨滚轮事件转发
	useEffect(() => {
		const rail = railRef.current;
		const el = scrollRef.current;
		if (!rail || !el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const list = rail.querySelector<HTMLElement>(".qn-list");
			if (list && list.contains(e.target as Node) && list.scrollHeight > list.clientHeight) {
				list.scrollTop += e.deltaY;
				return;
			}
			if (e.deltaY < 0) {
				disengageStick();
			} else if (e.deltaY > 0) {
				userUpwardGestureTimeRef.current = 0;
				if (el.scrollHeight - el.scrollTop - el.clientHeight < 96) {
					escapedRef.current = false;
					stickRef.current = true;
					setStickBottom(true);
				}
			}
			el.scrollTop += e.deltaY;
		};
		rail.addEventListener("wheel", onWheel, { passive: false });
		return () => rail.removeEventListener("wheel", onWheel);
	}, [disengageStick, scrollRef]);

	// 卸载时彻底清理定时器
	useEffect(() => () => clearScrollTimers(), [clearScrollTimers]);

	return {
		scrollRef,
		railRef,
		stickBottom,
		escapedRef,
		stickRef,
		scrollToBottom,
		pinToBottom,
		disengageStick,
		pauseForSelection,
		handleWheel,
		handleTouchStart,
		handleTouchMove,
		handlePointerDown,
		onScroll,
	};
}
