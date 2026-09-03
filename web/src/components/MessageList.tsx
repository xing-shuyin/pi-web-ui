import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import type { CSSProperties } from "react";
import { FiArrowDown } from "react-icons/fi";
import type { PromptAttachment, ToolStatus, UiMessage, UiState } from "../types";
import { Message, asText } from "./Message";

import { collectQuestionAttachments } from "../question-attachments";

import { parseSkillBlock } from "../skill-block";
import { CollapsedMessage } from "./CollapsedMessage";
import { LazyMount } from "./LazyMount";
import {
	applyPlan,
	contentFingerprint,
	estimateMessageHeight,
	getPlaceholderHeight,
	pickAlways,
	planWindow,
	type HeightEntry,
	type WinRect,
} from "../lazy-window";
import { SearchBar } from "./SearchBar";
import { classifyScroll } from "./scroll-classify";
import { EmptyTemplateCards } from "./PromptTemplates";
import { useT } from "../i18n";

/** Stable shared empty map — passing this (instead of a fresh Map) lets
 *  React.memo skip messages that have no live tool output to show. */
const EMPTY_LIVE = new Map<string, { toolName: string; text: string }>();

/**
 * Messages beyond the most recent KEEP_RECENT are rendered as cheap collapsed
 * summary rows (no Markdown / thinking / tool output) until clicked. Only kicks
 * in once the chat grows past COLLAPSE_MIN, so short conversations are untouched.
 */
const KEEP_RECENT = 15;
const COLLAPSE_MIN = 30;
/** Grace window after a programmatic scroll during which onScroll ignores
 *  negative scrollTop jumps from our own snap() re-asserts.
 *
 *  PRIMARY discriminator for layout shifts vs user intent is now the
 *  scrollHeight delta: user wheel-up never changes content height, while a
 *  layout collapse (tool card finalize, message trim, placeholder swap)
 *  always does. The grace window remains as a backstop for
 *  jump-while-growing races (scrollToBottom snap() firing during appends),
 *  and is re-stamped by the layout-shift re-assert.
 *
 *  Effective protection window is ~850ms, not 250ms: each snap() re-stamps
 *  progUntilRef to fireTime+250ms, and snaps keep firing through the 600ms
 *  re-assert timer, so the grace runs until ~600+250 = ~850ms. */
const PROGRAMMATIC_SCROLL_GRACE_MS = 250;

/** 惰性窗口化缓冲带：视口上下各多保留 1200px 的真实内容再开始收起。 */
const LAZY_MARGIN = 1200;
/** 底部常驻区高度预算（px）：贴底滚动 / 流式输出区域零占位延迟，
 *  但按累计高度截断——单条巨型消息不允许把常驻区撑成半个文档。 */
const ALWAYS_BUDGET = 1600;

function hasToolCall(m: UiMessage): boolean {
	return m.content.some((b) => b.type === "toolCall");
}

interface MessageListProps {
	state: UiState;
	liveOutputs: ReadonlyMap<string, { toolName: string; text: string }>;
	toolStatuses: ReadonlyMap<string, ToolStatus>;
	/** Edit-and-re-ask handler (forwarded to user message bubbles). */
	onEdit?: (messageId: string, text: string, attachments?: PromptAttachment[]) => void;
	/** Kill the running bash command from its tool card (agent run continues). */
	onKillBash?: () => void;
	/** Remove one queued prompt (the ✕ on a pending bubble). */
	onRemoveQueued?: (kind: "steer" | "followUp", text: string) => void;
	/** 思考文本是否换行（设置面板开关；false = 不换行横向滚动）。 */
	thinkingWrap?: boolean;
	/** 工具调用是否默认展开（设置面板开关；false = 默认折叠）。 */
	toolsWrap?: boolean;
	/** 全局搜索「会话」结果的跳转请求：目标会话 path + 命中消息锚点。
	 *  消息载入后定位到对应消息并滚动高亮，完成后回调 onJumpDone。 */
	jumpTarget?: { path: string; role: string; timestamp: number } | null;
	onJumpDone?: () => void;
}

export function MessageList({
	state,
	liveOutputs,
	toolStatuses,
	onEdit,
	onKillBash,
	onRemoveQueued,
	thinkingWrap,
	toolsWrap,
	jumpTarget,
	onJumpDone,
}: MessageListProps) {
	const t = useT();
	const scrollRef = useRef<HTMLDivElement>(null);
	const [stickBottom, setStickBottom] = useState(true);
	const stickRef = useRef(true);
	/** 上一帧 scrollTop —— 判定滚动方向（向上 = 用户要离开底部）。 */
	const prevStRef = useRef(0);
	/** 上一帧 scrollHeight —— 布局塌缩/增长的判据（用户滚轮不会改变内容高度）。 */
	const prevScrollHeightRef = useRef(0);
	/** 用户已主动离开底部：流式结束 / finalize 塌缩时不再自动吸回。 */
	const escapedRef = useRef(false);
	/** Timestamp until which scroll events are treated as programmatic. */
	const progUntilRef = useRef(0);
	/** Messages the user expanded from the collapsed view — stay expanded. */
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	/** 会话内搜索栏（Ctrl+F / Cmd+F）。 */
	const [searchOpen, setSearchOpen] = useState(false);
	/** Persisted messages + the live in-progress assistant message (if any). */
	const messages = state.streamingMessage ? [...state.messages, state.streamingMessage] : state.messages;
	/**
	 * toolResult lookup, memoized on the messages array. The server keeps the
	 * array reference stable while the message set is unchanged, so this Map is
	 * rebuilt only when a new tool result actually arrives — not every snapshot.
	 */
	const toolResults = useMemo(() => {
		const m = new Map<string, UiMessage>();
		for (const msg of state.messages) {
			if (msg.role === "toolResult" && msg.toolCallId) m.set(msg.toolCallId, msg);
		}
		return m;
	}, [state.messages]);
	/**
	 * Original attachments per user question (memoized on the stable messages
	 * array) — restored in the edit composer because the fork drops the
	 * attachment asides that follow the question. Pure logic lives in
	 * question-attachments.ts (unit-tested).
	 */
	const questionAttachments = useMemo(() => collectQuestionAttachments(state.messages), [state.messages]);
	const lastId = messages.length > 0 ? messages[messages.length - 1].id : null;
	// Only the last KEEP_RECENT persisted messages are fully rendered; older
	// ones collapse to summary rows (unless the user expanded them).
	const recentStart = state.messages.length > COLLAPSE_MIN ? Math.max(0, state.messages.length - KEEP_RECENT) : 0;

	/** 当前渲染为折叠摘要行的消息 id（SearchBar 的折叠层搜索索引用它；
	 *  toolResult 无独立折叠行——其结果文本已并入宿主 toolCall 卡）。
	 *  引用稳定：SearchBar 命中收集把它当依赖，只有消息集/展开态变化时才重算。 */
	const collapsedIds = useMemo(() => {
		const s = new Set<string>();
		for (let i = 0; i < recentStart; i++) {
			const m = state.messages[i];
			if (m.role === "toolResult") continue;
			if (!expanded.has(m.id)) s.add(m.id);
		}
		return s;
	}, [state.messages, recentStart, expanded]);

	// ---- 惰性窗口化（lazy windowing，纯函数见 lazy-window.ts）----------------
	// 视口缓冲带之外的重型消息替换为等高占位 div；滚动临近时换回真实内容并
	// 在同一帧内补偿 scrollTop。占位保留 data-msg-id，导航/跳转/搜索不受影响。
	/** 当前处于占位状态的消息 id。 */
	const [hidden, setHidden] = useState<Set<string>>(() => new Set());
	/** 用户跳转过的消息——永久保持真实渲染，避免占位符闪现。 */
	const [pinned, setPinned] = useState<Set<string>>(() => new Set());
	/** 已实测的消息高度（隐藏时用作占位高度）。 */
	const heightsRef = useRef(new Map<string, number>());
	/** 实测高度 + 记录时的内容指纹：指纹不符（消息被编辑）→ 条目失效。
	 *  占位高度一律经 getPlaceholderHeight 走「实测优先、指纹校验、估算兑底」。 */
	const heightMetaRef = useRef(new Map<string, HeightEntry>());
	/** 所有受管外层元素（sweep 测量用；挂载时注册，消息移除时清理）。 */
	const elsRef = useRef(new Map<string, HTMLDivElement>());
	const sweepRafRef = useRef(0);
	/** 每条消息的当前内容指纹（id → fingerprint，随 state.messages 重算）。 */
	const fingerprints = useMemo(() => {
		const m = new Map<string, number>();
		for (const msg of state.messages) m.set(msg.id, contentFingerprint(msg));
		return m;
	}, [state.messages]);
	// 镜像供 sweep（rAF 回调）读取而不重建依赖
	const fpRef = useRef(fingerprints);
	fpRef.current = fingerprints;
	// 镜像最新值，供 rAF 回调 / 事件处理器读取而不重建（沿用 questionsRef 模式）
	const hiddenRef = useRef(hidden);
	hiddenRef.current = hidden;
	/** 短会话与搜索打开期间不做窗口化（全量渲染，行为与旧版一致）。 */
	const virtualOn = state.messages.length > COLLAPSE_MIN && !searchOpen;
	const virtualOnRef = useRef(virtualOn);
	virtualOnRef.current = virtualOn;
	// 底部常驻区（永不占位）：随每次渲染按预算重算（读取最新实测高度），
	// 首次全量测量后巨型消息会被预算挤出常驻区、参与正常窗口化。
	const alwaysSet = pickAlways(state.messages, heightsRef.current, ALWAYS_BUDGET);
	const alwaysRef = useRef(alwaysSet);
	alwaysRef.current = alwaysSet;

	/** 全量测量受管元素 → 窗口计划（rAF 节流调用；也用于初始与特殊迁移后）。 */
	const sweep = useCallback(() => {
		const root = scrollRef.current;
		if (!root) return;
		if (!virtualOnRef.current) {
			setHidden((prev) => (prev.size ? new Set<string>() : prev));
			return;
		}
		const rootRect = root.getBoundingClientRect();
		const viewport = {
			top: rootRect.top - LAZY_MARGIN,
			bottom: rootRect.bottom + LAZY_MARGIN,
		};
		const items: WinRect[] = [];
		for (const [id, el] of elsRef.current) {
			const b = el.getBoundingClientRect();
			items.push({ id, top: b.top, bottom: b.bottom });
			// 显示中的元素顺手记录实测高度——pickAlways 的预算与占位高度都靠它；
			// 只在隐藏时测量的话，「初始就显示」的消息会永远停留在估算值。
			if (!hiddenRef.current.has(id)) recordMeasured(id, b.bottom - b.top, fpRef.current.get(id));
		}
		const plan = planWindow(items, viewport, alwaysRef.current, hiddenRef.current);
		// 收起时用刚实测的高度做占位 ⇒ 流总高度不变 ⇒ 无需任何 scrollTop 补偿。
		// （曾在此做 shrink 补偿：它触发的 scroll 事件会让缓冲带重新罩住刚收起的
		// 元素 → 再挂载 → 再收起，自搏循环把用户钉在原地永远滚不到底。）
		for (const id of plan.hide) {
			const el = elsRef.current.get(id);
			if (el) recordMeasured(id, el.offsetHeight, fpRef.current.get(id));
		}
		setHidden((prev) => applyPlan(prev, plan));
	}, []);

	const scheduleSweep = useCallback(() => {
		if (sweepRafRef.current) return;
		sweepRafRef.current = requestAnimationFrame(() => {
			sweepRafRef.current = 0;
			sweep();
		});
	}, [sweep]);

	// 初始挂载：首帧绘制前就把远端内容换成占位（大会话 attach 不再全量布局绘制）
	useLayoutEffect(() => {
		sweep();
	}, [sweep]);

	// 搜索关闭瞬间重新收起远端内容（打开期间强制全渲染以兼容 DOM 高亮/Range 收集）
	const prevSearchRef = useRef(searchOpen);
	useLayoutEffect(() => {
		if (prevSearchRef.current && !searchOpen) sweep();
		prevSearchRef.current = searchOpen;
	}, [searchOpen, sweep]);

	/** 实测高度统一入库：meta 始终记录；heights（pickAlways / 占位来源）仅在
	 *  指纹与当前内容一致时更新——消息被编辑后旧实测高度立即作废。 */
	const recordMeasured = useCallback((id: string, h: number, fp?: number) => {
		if (fp === undefined) return; // 元素不属于任何当前消息（清理竞态）
		heightMetaRef.current.set(id, { h, len: fp });
		heightsRef.current.set(id, h);
	}, []);

	const storeHeight = useCallback(
		(id: string, h: number) => {
			recordMeasured(id, h, fpRef.current.get(id));
		},
		[recordMeasured],
	);

	/** 外层元素注册（sweep 测量用）；卸载侧由下方清理 effect 兑底（React 18 的
	 *  ref(null) 回调拿不到 data-lazy-id，无法定点反注册）。 */
	const attachEl = useCallback((el: HTMLDivElement | null) => {
		if (el) elsRef.current.set(el.dataset.lazyId ?? "", el);
	}, []);

	// 消息集或展开状态变化后，清掉已不存在的受管元素 / 高度缓存 / 隐藏项
	// （依赖用服务端缓存的消息数组——引用稳定，流式增量不会每帧重跑）
	useEffect(() => {
		const ids = new Set(state.messages.map((m) => m.id));
		for (const [id, el] of elsRef.current) {
			if (ids.has(id)) continue;
			elsRef.current.delete(id);
			heightsRef.current.delete(id);
			heightMetaRef.current.delete(id);
		}
		setHidden((prev) => {
			let changed = false;
			const next = new Set<string>();
			for (const id of prev)
				if (ids.has(id)) next.add(id);
				else changed = true;
			return changed ? next : prev;
		});
	}, [state.messages, expanded]);

	useEffect(() => () => cancelAnimationFrame(sweepRafRef.current), []);

	// All user questions of the current conversation — the source for the
	// floating question-nav rail (memoized on the stable messages array).
	const questions = useMemo(() => {
		const qs: { id: string; text: string }[] = [];
		for (const m of state.messages) {
			if (m.role !== "user") continue;
			const joined = m.content
				.map((b) => asText(b)?.text ?? "")
				.filter(Boolean)
				.join(" ");
			// Skill invocations show the user's own args (or the skill name),
			// never the expanded SKILL.md dump.
			const sb = parseSkillBlock(joined);
			const text = sb ? (sb.userMessage ?? `skill:${sb.name}`) : joined.trim();
			if (!text) continue;
			qs.push({ id: m.id, text });
		}
		return qs;
	}, [state.messages]);

	/** Question ordinal by message id — each user question renders its own tag. */
	const qnIndex = useMemo(() => {
		const m = new Map<string, number>();
		questions.forEach((q, i) => m.set(q.id, i));
		return m;
	}, [questions]);

	// -- floating question-nav rail --------------------------------------------
	/** Index of the question currently on screen (or last jumped to); -1 = none. */
	const [activeIdx, setActiveIdx] = useState(-1);
	const activeIdxRef = useRef(-1);
	// Scroll handlers read the latest questions without recreating.
	const questionsRef = useRef(questions);
	useEffect(() => {
		questionsRef.current = questions;
	}, [questions]);

	// Which question is currently on screen (drives the bar highlight).
	const updateActiveFromScroll = useCallback(() => {
		const el = scrollRef.current;
		const qs = questionsRef.current;
		if (!el || qs.length === 0) return;
		const containerTop = el.getBoundingClientRect().top;
		const margin = 140;
		let best = -1;
		for (let i = 0; i < qs.length; i++) {
			const node = el.querySelector<HTMLElement>(`[data-msg-id="${qs[i].id}"]`);
			if (!node) continue;
			if (node.getBoundingClientRect().top <= containerTop + margin) best = i;
			else break;
		}
		if (best !== activeIdxRef.current) {
			activeIdxRef.current = best;
			setActiveIdx(best);
		}
	}, []);

	// Pick the initial active question when the message set changes (also
	// covers expand/collapse since it re-renders with new DOM).
	useEffect(() => {
		updateActiveFromScroll();
	}, [questions, updateActiveFromScroll]);

	const expand = useCallback((id: string) => {
		setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
	}, []);

	// Ctrl+F / Cmd+F 打开搜索（可编辑元素内不抢占）
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "f") return;
			const target = e.target as HTMLElement | null;
			if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
			e.preventDefault();
			setSearchOpen(true);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	const collapse = useCallback((id: string) => {
		setExpanded((prev) => {
			if (!prev.has(id)) return prev;
			const next = new Set(prev);
			next.delete(id);
			return next;
		});
	}, []);

	/** Scroll the conversation to a question; expand it first if it's collapsed. */
	const jumpTo = useCallback(
		(id: string) => {
			const idx = state.messages.findIndex((m) => m.id === id);
			// 占位中的目标先同步恢复真实渲染（折叠行同步展开），再滚动定位——
			// flushSync 保证本轮 commit 后 DOM 即为最终形态。
			flushSync(() => {
				if (idx >= 0 && idx < recentStart && !expanded.has(id)) expand(id);
				setPinned((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
			});
			const qIdx = questionsRef.current.findIndex((q) => q.id === id);
			activeIdxRef.current = qIdx;
			setActiveIdx(qIdx);
			requestAnimationFrame(() => {
				const el = scrollRef.current?.querySelector<HTMLElement>(`[data-msg-id="${id}"]`);
				if (el) {
					// Clear the flash from any previously jumped-to message, then
					// restart the highlight animation on the target.
					scrollRef.current?.querySelectorAll(".msg-flash").forEach((n) => n.classList.remove("msg-flash"));
					el.scrollIntoView({ block: "start" });
					el.classList.remove("msg-flash");
					void el.offsetWidth; // restart the highlight animation
					el.classList.add("msg-flash");
					// 问题跳转 = 主动离开底部；流结束时不要被吸回去
					if (el !== scrollRef.current?.lastElementChild) escapedRef.current = true;
				}
			});
		},
		[state.messages, recentStart, expanded, expand],
	);

	// ---- 全局搜索「会话」结果跳转 ----------------------------------------
	// 锚点 = role + timestamp；会话载入后从 UiMessage[] 解析出 message id。
	const jumpMsgId = useMemo(() => {
		if (!jumpTarget) return null;
		return state.messages.find((m) => m.role === jumpTarget.role && m.timestamp === jumpTarget.timestamp)?.id ?? null;
	}, [state.messages, jumpTarget]);

	useEffect(() => {
		if (!jumpTarget) return;
		if (jumpMsgId) {
			// 目标消息已就位：展开（如折叠）→ 滚动定位 → 高亮，再告诉上层结束
			jumpTo(jumpMsgId);
			onJumpDone?.();
			return;
		}
		// 目标会话已载入但找不到该消息（转录被压缩 / 锚点过期）→ 放弃
		if (state.sessionFile === jumpTarget.path && state.messages.length > 0) {
			onJumpDone?.();
		}
		// 会话还在切换中（快照未到）→ 保持等待，消息数组更新后再试
	}, [jumpMsgId, jumpTo, onJumpDone, jumpTarget, state.sessionFile, state.messages.length]);

	const onScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const dSt = el.scrollTop - prevStRef.current;
		const dSh = el.scrollHeight - prevScrollHeightRef.current;
		prevStRef.current = el.scrollTop;
		prevScrollHeightRef.current = el.scrollHeight;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
		// Programmatic jumps (scrollToBottom re-asserts) land here too — never
		// treat them as upward user intent, or the stick gets undone instantly.
		const programmatic = Date.now() < progUntilRef.current;
		const decision = classifyScroll({
			dSt,
			dSh,
			escaped: escapedRef.current,
			graceActive: programmatic,
			stuck: stickRef.current,
		});
		if (decision.reassert) {
			progUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS;
			el.scrollTop = el.scrollHeight;
		}
		if (decision.flipEscape) escapedRef.current = true;
		if (nearBottom && dSt >= 0) {
			escapedRef.current = false; // 滚回了底部
		}
		// A programmatic jump's echo scroll event can fire after the bottom moved
		// slightly (height corrections between assignment and event dispatch),
		// making nearBottom false at echo time — clearing stickRef here kills the
		// RO / MutationObserver / effect re-pin gates and the bottom drifts away
		// forever after (Back-to-bottom lands short, chip lingers). Within the
		// grace window the jump owns the stick: never clear it from its own echo.
		if (!programmatic) {
			if (dSt < 0) {
				// Upward intent: escape semantics exactly as before.
				stickRef.current = nearBottom && !escapedRef.current;
			} else if (nearBottom) {
				// Reached the bottom going down: re-arm.
				stickRef.current = true;
			}
			// dSt >= 0 && !nearBottom: NOT leaving intent — the user is moving
			// TOWARD the bottom while coalesced growth opens a gap under the
			// wheel (live dump: dSh=187 vs dSt=+93.6 → gap≈94 → disarmed stick,
			// unreachable bottom). Keep the current stick state so the RO/MO
			// re-pins can close the gap.
		}
		setStickBottom(stickRef.current);
		updateActiveFromScroll();
		scheduleSweep();
	}, [updateActiveFromScroll, scheduleSweep]);

	// 流结束兜底：finalize 瞬间 streaming→persisted 切换可能让内容高度塌缩一帧，
	// 浏览器把视口 clamp 到半路；若用户并未主动离开（!escaped），等布局稳定后吸回底部。
	const wasStreamingRef = useRef(false);
	useEffect(() => {
		const was = wasStreamingRef.current;
		wasStreamingRef.current = !!state.isStreaming;
		if (was && !state.isStreaming && !escapedRef.current) {
			const snap = () => {
				const el = scrollRef.current;
				if (el && !escapedRef.current) {
					el.scrollTop = el.scrollHeight;
					stickRef.current = true;
					setStickBottom(true);
				}
			};
			requestAnimationFrame(() => requestAnimationFrame(snap));
			const t = setTimeout(snap, 180);
			return () => clearTimeout(t);
		}
	}, [state.isStreaming]);

	useEffect(() => {
		const el = scrollRef.current;
		if (el && stickRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages, state.isStreaming, liveOutputs]);

	// Queued prompts (插队/排队) render as pending bubbles at the list bottom —
	// include them in the stick-to-bottom deps so a newly queued message is
	// scrolled into view when the user hasn't left the bottom.
	const queueSig = state.queue.steering.join("\u0000") + "\u0001" + state.queue.followUp.join("\u0000");
	useEffect(() => {
		const el = scrollRef.current;
		if (el && stickRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [queueSig]);

	// Geometry-driven stick (RO era): the composer sits BELOW this scroll
	// container in a flex column. Typing grows the composer → the container's
	// border-box shrinks → distance-to-bottom grows with NO scroll event (scrollTop
	// untouched), so the entire scroll-event-driven stick machinery is blind to
	// the drift. A ResizeObserver on the container catches it directly: any box
	// change while stuck && !escaped re-pins the bottom. Observing the container
	// (not the composer / a content sentinel) is sufficient: composer growth is
	// exactly a container-box shrink; content-height growth (streaming appends,
	// image loads) is already covered by the messages/liveOutputs snap effects.
	// No feedback loop: the snap mutates scrollTop only — RO reports box size,
	// which is unchanged. The snap's echo scroll event carries positive dSt with
	// dSh=0, which classifyScroll no-ops (dSt >= -4) — no grace restamp needed.
	useEffect(() => {
		const el = scrollRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => {
			if (stickRef.current && !escapedRef.current) {
				el.scrollTop = el.scrollHeight;
				// stickRef is already true; keep the chip's state source in sync so
				// the Back-to-bottom button can never linger after an RO re-pin.
				setStickBottom(true);
			}
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	// Content-level growth watch: the RO above only sees the BOX of .messages.
	// Content growing INSIDE the container without a React state change —
	// extension / liveOutputs / tool cards mutating via DOM, post-jump height
	// corrections in collapsed rows — is invisible to the RO AND to the
	// messages/liveOutputs snap effects: the bottom drifts away silently with
	// zero scroll events. A MutationObserver on the scroll content closes that
	// gap: any content mutation while stuck && !escaped re-pins the bottom,
	// coalesced to at most one snap per frame. No feedback loop: snap mutates
	// scrollTop only — no DOM mutation, so the observer never re-triggers.
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
					el2.scrollTop = el2.scrollHeight;
					// keep the chip's state source in sync (same as RO re-pin)
					setStickBottom(true);
				}
			});
		});
		mo.observe(el, { childList: true, subtree: true, characterData: true });
		return () => mo.disconnect();
	}, []);

	const scrollToBottom = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		stickRef.current = true;
		escapedRef.current = false;
		setStickBottom(true);
		// Mark programmatic scrolling so onScroll won't misread our own jumps
		// (or stream re-render layout shifts in the same window) as upward
		// user intent — that used to flip escapedRef and undo the stick.
		progUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS;
		const snap = () => {
			const el2 = scrollRef.current;
			if (!el2 || !stickRef.current || escapedRef.current) return;
			progUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS;
			el2.scrollTop = el2.scrollHeight;
		};
		snap();
		// Re-assert while live content keeps inflating the bottom: streaming
		// deltas / attach trickle append after the jump, and a one-shot
		// scrollTop=scrollHeight lands short of the moving bottom.
		requestAnimationFrame(() => requestAnimationFrame(snap));
		const t1 = setTimeout(snap, 120);
		const t2 = setTimeout(snap, 300);
		const t3 = setTimeout(snap, 600);
	}, []);

	// The rail is a pointer-event target so it can expand on hover; forward
	// wheel over it (collapsed strip or expanded panel) to the message list.
	const railRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const rail = railRef.current;
		const el = scrollRef.current;
		if (!rail || !el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			// In "many questions" mode the hover panel is a scrollable list —
			// wheel over it scrolls the list itself (when it overflows),
			// otherwise it falls through to the message list.
			const list = rail.querySelector<HTMLElement>(".qn-list");
			if (list && list.contains(e.target as Node) && list.scrollHeight > list.clientHeight) {
				list.scrollTop += e.deltaY;
				return;
			}
			el.scrollTop += e.deltaY;
		};
		rail.addEventListener("wheel", onWheel, { passive: false });
		return () => rail.removeEventListener("wheel", onWheel);
	}, []);

	// Visible height of the scroll area — drives the adaptive row gap so the
	// centered tick cluster always fits (no top/bottom clipping).
	const [railH, setRailH] = useState(0);
	useEffect(() => {
		const update = () => {
			setRailH(scrollRef.current?.clientHeight ?? 0);
			scheduleSweep(); // 宽高变化后旧占位高度可能失准，重新评估窗口
		};
		update();
		window.addEventListener("resize", update);
		return () => window.removeEventListener("resize", update);
	}, [scheduleSweep]);
	const n = questions.length;
	const railGap = useMemo(() => {
		if (n === 0) return 27;
		const h = railH || 600;
		return Math.max(4, Math.min(27, Math.floor((h - 16) / n) - 3));
	}, [n, railH]);
	/** Many questions: per-tick chips would overlap (pitch < ~24px), so the
	 *  hover panel becomes a scrollable list instead. */
	const many = railGap < 20;

	return (
		<div className="messages-wrap">
			<div
				// anchor-live：未钉底（逃逸阅读）时启用原生滚动锚定，兜住部分跨视口
				// 边缘消息的占位⇄真身互换跳动；与钉底期的程序性再钉互斥（那时无此类）。
				className={`messages${searchOpen ? "" : stickBottom ? "" : " anchor-live"}`}
				ref={scrollRef}
				onScroll={onScroll}
			>
				{state.messages.length === 0 && !state.streamingMessage && (
					<div className="empty-state">
						<EmptyTemplateCards />
					</div>
				)}
				{state.messages.map((m, i) => {
					const isOld = i < recentStart;
					const isExpandedOld = isOld && expanded.has(m.id);
					if (isOld && !isExpandedOld) {
						// toolResult content lives inside its toolCall card — nothing to
						// show in the collapsed row either.
						if (m.role === "toolResult") return null;
						return <CollapsedMessage key={m.id} message={m} onExpand={expand} />;
					}
					const qIdx = m.role === "user" ? qnIndex.get(m.id) : undefined;
					const show = !virtualOn || alwaysSet.has(m.id) || pinned.has(m.id) || !hidden.has(m.id);
					return (
						<LazyMount
							key={m.id}
							id={m.id}
							show={show}
							height={getPlaceholderHeight(
								m.id,
								fingerprints.get(m.id) ?? -1,
								heightMetaRef.current,
								estimateMessageHeight(m.role, m.customType),
							)}
							containerRef={scrollRef}
							onMeasured={storeHeight}
							lazyRef={attachEl}
						>
							<Message
								key={m.id}
								message={m}
								qnIndex={qIdx}
								qnActive={qIdx !== undefined ? qIdx === activeIdx : undefined}
								onJump={jumpTo}
								toolResults={toolResults}
								liveOutputs={hasToolCall(m) ? liveOutputs : EMPTY_LIVE}
								toolStatuses={toolStatuses}
								streaming={state.isStreaming}
								onKillBash={onKillBash}
								toolsWrap={toolsWrap}
								thinkingWrap={thinkingWrap}
								isLast={m.id === lastId}
								onEdit={onEdit}
								questionAttachments={questionAttachments.get(m.id)}
								onCollapse={isExpandedOld ? collapse : undefined}
								searchActive={searchOpen}
							/>
						</LazyMount>
					);
				})}
				{state.streamingMessage && (
					<Message
						key={state.streamingMessage.id}
						message={state.streamingMessage}
						toolResults={toolResults}
						liveOutputs={hasToolCall(state.streamingMessage) ? liveOutputs : EMPTY_LIVE}
						toolStatuses={toolStatuses}
						streaming
						isLast
						onEdit={onEdit}
						onKillBash={onKillBash}
						toolsWrap={toolsWrap}
						thinkingWrap={thinkingWrap}
						searchActive={searchOpen}
					/>
				)}
				{state.isStreaming && messages.length === 0 && <div className="streaming-wait">{t("waitingResponse")}</div>}
				{state.queue.steering.map((text, i) => (
					<div className="queued-msg" key={`q-steer-${i}`}>
						<div className="queued-bubble">
							<span className="queued-tag steer">{t("queueSteerTag")}</span>
							<div className="queued-text">{text}</div>
							{onRemoveQueued && (
								<button
									type="button"
									className="queued-remove"
									title={t("queueRemoveTip")}
									onClick={() => onRemoveQueued("steer", text)}
								>
									✕
								</button>
							)}
						</div>
					</div>
				))}
				{state.queue.followUp.map((text, i) => (
					<div className="queued-msg" key={`q-fu-${i}`}>
						<div className="queued-bubble">
							<span className="queued-tag follow">{t("queueFollowTag")}</span>
							<div className="queued-text">{text}</div>
							{onRemoveQueued && (
								<button
									type="button"
									className="queued-remove"
									title={t("queueRemoveTip")}
									onClick={() => onRemoveQueued("followUp", text)}
								>
									✕
								</button>
							)}
						</div>
					</div>
				))}
			</div>
			{!stickBottom && (
				<button type="button" className="scroll-bottom" onClick={scrollToBottom}>
					<FiArrowDown /> {t("backToBottom")}
				</button>
			)}
			<SearchBar
				containerRef={scrollRef}
				messages={messages}
				collapsedIds={collapsedIds}
				toolResults={toolResults}
				onExpand={expand}
				onProgrammaticScroll={() => {
					// 搜索跳转让位贴底机制：之后再吸底部会覆盖搜索定位
					escapedRef.current = true;
					stickRef.current = false;
					setStickBottom(false);
				}}
				open={searchOpen}
				onClose={() => setSearchOpen(false)}
			/>
			{questions.length > 0 && (
				<div
					className={`qn-rail ${many ? "many" : ""}`}
					ref={railRef}
					aria-label={t("questionNavTitle")}
					style={{ "--rail-gap": `${railGap}px` } as CSSProperties}
				>
					{questions.map((q, i) => (
						<button
							type="button"
							key={q.id}
							className={`qn-bar ${i === activeIdx ? "active" : ""}`}
							aria-label={`${i + 1}. ${q.text}`}
							onClick={() => jumpTo(q.id)}
						>
							<span className="qn-bar-text">
								{i + 1}. {q.text}
							</span>
						</button>
					))}
					{many && (
						<div className="qn-list">
							{questions.map((q, i) => (
								<button
									type="button"
									key={q.id}
									className={`qn-list-item ${i === activeIdx ? "active" : ""}`}
									aria-label={`${i + 1}. ${q.text}`}
									onClick={() => jumpTo(q.id)}
								>
									<span className="qn-list-idx">{i + 1}</span>
									<span className="qn-list-text">{q.text}</span>
								</button>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
