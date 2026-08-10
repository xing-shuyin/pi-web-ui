import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { flushSync } from "react-dom";
import { FiArrowDown } from "react-icons/fi";
import type { ToolStatus, UiMessage, UiState } from "../types";
import { Message, asText } from "./Message";
import { CollapsedMessage } from "./CollapsedMessage";
import { useT, type Translate } from "../i18n";

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

function hasToolCall(m: UiMessage): boolean {
	return m.content.some((b) => b.type === "toolCall");
}

/** Suggested prompts shown on the empty-state welcome page. */
const EXAMPLE_DEFS: {
	key: "ex.understand" | "ex.debug" | "ex.test" | "ex.review";
	icon: string;
}[] = [
	{ key: "ex.understand", icon: "🔍" },
	{ key: "ex.debug", icon: "🐛" },
	{ key: "ex.test", icon: "🧪" },
	{ key: "ex.review", icon: "🧹" },
];

function examples(
	t: Translate,
): { icon: string; text: string; prompt: string }[] {
	return EXAMPLE_DEFS.map(({ key, icon }) => ({
		icon,
		text: t(key),
		prompt: t(`${key}.prompt`),
	}));
}

interface MessageListProps {
	state: UiState;
	liveOutputs: ReadonlyMap<string, { toolName: string; text: string }>;
	toolStatuses: ReadonlyMap<string, ToolStatus>;
	/** Edit-and-re-ask handler (forwarded to user message bubbles). */
	onEdit?: (messageId: string, text: string) => void;
}

export function MessageList({ state, liveOutputs, toolStatuses, onEdit }: MessageListProps) {
	const t = useT();
	const scrollRef = useRef<HTMLDivElement>(null);
	const [stickBottom, setStickBottom] = useState(true);
	const stickRef = useRef(true);
	/** Messages the user expanded from the collapsed view — stay expanded. */
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	/** Persisted messages + the live in-progress assistant message (if any). */
	const messages = state.streamingMessage
		? [...state.messages, state.streamingMessage]
		: state.messages;
	/**
	 * toolResult lookup, memoized on the messages array. The server keeps the
	 * array reference stable while the message set is unchanged, so this Map is
	 * rebuilt only when a new tool result actually arrives — not every snapshot.
	 */
	const toolResults = useMemo(() => {
		const m = new Map<string, UiMessage>();
		for (const msg of state.messages) {
			if (msg.role === "toolResult" && msg.toolCallId)
				m.set(msg.toolCallId, msg);
		}
		return m;
	}, [state.messages]);
	const lastId = messages.length > 0 ? messages[messages.length - 1].id : null;
	// Only the last KEEP_RECENT persisted messages are fully rendered; older
	// ones collapse to summary rows (unless the user expanded them).
	const recentStart =
		state.messages.length > COLLAPSE_MIN
			? Math.max(0, state.messages.length - KEEP_RECENT)
			: 0;

	// All user questions of the current conversation — the source for the
	// floating question-nav rail (memoized on the stable messages array).
	const questions = useMemo(() => {
		const qs: { id: string; text: string }[] = [];
		for (const m of state.messages) {
			if (m.role !== "user") continue;
			const text = m.content
				.map((b) => asText(b)?.text ?? "")
				.filter(Boolean)
				.join(" ")
				.trim();
			if (!text) continue;
			qs.push({ id: m.id, text });
		}
		return qs;
	}, [state.messages]);

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
			if (idx >= 0 && idx < recentStart && !expanded.has(id)) {
				// Collapsed row → expand synchronously so the full message is
				// in the DOM (and in its final position) before we scroll.
				flushSync(() => expand(id));
			}
			const qIdx = questionsRef.current.findIndex((q) => q.id === id);
			activeIdxRef.current = qIdx;
			setActiveIdx(qIdx);
			requestAnimationFrame(() => {
				const el = scrollRef.current?.querySelector<HTMLElement>(
					`[data-msg-id="${id}"]`,
				);
				if (el) {
					// Clear the flash from any previously jumped-to message, then
					// restart the highlight animation on the target.
					scrollRef.current
						?.querySelectorAll(".msg-flash")
						.forEach((n) => n.classList.remove("msg-flash"));
					el.scrollIntoView({ block: "start" });
					el.classList.remove("msg-flash");
					void el.offsetWidth; // restart the highlight animation
					el.classList.add("msg-flash");
				}
			});
		},
		[state.messages, recentStart, expanded, expand],
	);

	const onScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
		stickRef.current = nearBottom;
		setStickBottom(nearBottom);
		updateActiveFromScroll();
	}, [updateActiveFromScroll]);

	useEffect(() => {
		const el = scrollRef.current;
		if (el && stickRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages, state.isStreaming, liveOutputs]);

	const scrollToBottom = useCallback(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
		stickRef.current = true;
		setStickBottom(true);
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
		const update = () => setRailH(scrollRef.current?.clientHeight ?? 0);
		update();
		window.addEventListener("resize", update);
		return () => window.removeEventListener("resize", update);
	}, []);
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
			<div className="messages" ref={scrollRef} onScroll={onScroll}>
				{state.messages.length === 0 && !state.streamingMessage && (
					<div className="empty-state">
						<div className="empty-logo-wrap">
							<div className="empty-logo">π</div>
						</div>
						<h2 className="empty-title">{t("welcomeTitle")}</h2>
						<p className="empty-sub">{t("welcomeSub")}</p>
						<div className="empty-cwd">
							<span className="empty-cwd-label">{t("directory")}</span>
							<span className="empty-cwd-path">{state.cwd}</span>
						</div>
						<div className="empty-examples">
							{examples(t).map((ex) => (
								<button
									type="button"
									key={ex.prompt}
									className="empty-example"
									title={t("clickToFill")}
									onClick={() =>
										window.dispatchEvent(
											new CustomEvent("pi-web:fill", { detail: ex.prompt }),
										)
									}
								>
									<span className="empty-example-icon">{ex.icon}</span>
									<span className="empty-example-text">{ex.text}</span>
								</button>
							))}
						</div>
					</div>
				)}
				{state.messages.map((m, i) => {
					const isOld = i < recentStart;
					const isExpandedOld = isOld && expanded.has(m.id);
					if (isOld && !isExpandedOld) {
						// toolResult content lives inside its toolCall card — nothing to
						// show in the collapsed row either.
						if (m.role === "toolResult") return null;
						return (
							<CollapsedMessage key={m.id} message={m} onExpand={expand} />
						);
					}
					return (
						<Message
							key={m.id}
							message={m}
							toolResults={toolResults}
							liveOutputs={hasToolCall(m) ? liveOutputs : EMPTY_LIVE}
							toolStatuses={toolStatuses}
							streaming={state.isStreaming}
							isLast={m.id === lastId}
							onEdit={onEdit}
							onCollapse={isExpandedOld ? collapse : undefined}
						/>
					);
				})}
				{state.streamingMessage && (
					<Message
						key={state.streamingMessage.id}
						message={state.streamingMessage}
						toolResults={toolResults}
						liveOutputs={
							hasToolCall(state.streamingMessage) ? liveOutputs : EMPTY_LIVE
						}
						toolStatuses={toolStatuses}
						streaming
						isLast
						onEdit={onEdit}
					/>
				)}
				{state.isStreaming && messages.length === 0 && (
					<div className="streaming-wait">{t("waitingResponse")}</div>
				)}
			</div>
			{!stickBottom && (
				<button
					type="button"
					className="scroll-bottom"
					onClick={scrollToBottom}
				>
					<FiArrowDown /> {t("backToBottom")}
				</button>
			)}
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
							<span className="qn-bar-text">{i + 1}. {q.text}</span>
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
