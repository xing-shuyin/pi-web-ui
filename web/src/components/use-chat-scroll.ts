import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import type { ToolStatus, UiMessage, UiState } from "../types";
import { isEchoMessageId } from "../optimistic-queue";
import {
	classifyQuestionAddedScroll,
	classifyScroll,
	shouldEscapeOnScroll,
	shouldPreloadEarlier,
	shouldScrollToBottomOnStreamChange,
} from "./scroll-classify";

export const PROGRAMMATIC_SCROLL_GRACE_MS = 250;

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
	userPromptNonce?: number;
	scrollRef?: React.RefObject<HTMLDivElement | null>;
	stickRef?: React.MutableRefObject<boolean>;
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
		userPromptNonce,
	} = opts;

	const internalScrollRef = useRef<HTMLDivElement | null>(null);
	const scrollRef = opts.scrollRef ?? internalScrollRef;
	const railRef = useRef<HTMLDivElement | null>(null);

	const [stickBottom, setStickBottom] = useState(true);
	const internalStickRef = useRef(true);
	const stickRef = opts.stickRef ?? internalStickRef;
	const internalEscapedRef = useRef(false);
	const escapedRef = opts.escapedRef ?? internalEscapedRef;

	const prevStRef = useRef(0);
	const prevScrollHeightRef = useRef(0);
	const progUntilRef = useRef(0);
	const userUpwardGestureTimeRef = useRef(0);
	const isPointerDownRef = useRef(false);
	const middleDownRef = useRef(false);
	const touchStartYRef = useRef(0);

	const scrollTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
	const clearScrollTimers = useCallback(() => {
		for (const t of scrollTimersRef.current) clearTimeout(t);
		scrollTimersRef.current = [];
	}, []);

	const pauseForSelection = useCallback(() => {
		clearScrollTimers();
		escapedRef.current = true;
		stickRef.current = false;
		setStickBottom(false);
	}, [clearScrollTimers]);

	const disengageStick = useCallback(() => {
		clearScrollTimers();
		userUpwardGestureTimeRef.current = Date.now();
		progUntilRef.current = 0;
		escapedRef.current = true;
		stickRef.current = false;
		setStickBottom(false);
	}, [clearScrollTimers]);

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

	const hasEarlierRef = useRef(hasEarlier);
	hasEarlierRef.current = hasEarlier;
	const loadEarlierRef = useRef(loadEarlier);
	loadEarlierRef.current = loadEarlier;

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

	const onScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const dSt = el.scrollTop - prevStRef.current;
		const dSh = el.scrollHeight - prevScrollHeightRef.current;
		prevStRef.current = el.scrollTop;
		prevScrollHeightRef.current = el.scrollHeight;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 36;
		const programmatic = Date.now() < progUntilRef.current;

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

	const lastQuestionId = questions.length > 0 ? questions[questions.length - 1].id : null;
	const prevConvKeyRef = useRef(`${conversationId ?? ""}:${sessionFile ?? ""}`);
	const prevLastQuestionIdRef = useRef<string | null>(lastQuestionId);
	useEffect(() => {
		const convKey = `${conversationId ?? ""}:${sessionFile ?? ""}`;
		const convChanged = convKey !== prevConvKeyRef.current;
		const el = scrollRef.current;
		const nearBottom = el ? el.scrollHeight - el.scrollTop - el.clientHeight < 36 : true;
		const isOptimisticEcho = Boolean(lastQuestionId && isEchoMessageId(lastQuestionId));
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
		if (shouldScroll || isOptimisticEcho) {
			scrollToBottom();
		}
	}, [conversationId, sessionFile, lastQuestionId, jumpTarget, urlJumpMessageId, scrollToBottom]);

	const prevUserPromptNonceRef = useRef(userPromptNonce ?? 0);
	useEffect(() => {
		const nonce = userPromptNonce ?? 0;
		if (nonce > prevUserPromptNonceRef.current) {
			prevUserPromptNonceRef.current = nonce;
			scrollToBottom();
		}
	}, [userPromptNonce, scrollToBottom]);

	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		if (stickRef.current && !escapedRef.current) {
			pinToBottom();
		}
	}, [messages, isStreaming, liveOutputs, toolStatuses, pinToBottom, scrollRef]);

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
