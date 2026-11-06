import {
	memo,
	startTransition,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { flushSync } from "react-dom";

import type { CSSProperties } from "react";
import { FiArrowDown } from "react-icons/fi";
import type { ClientMessage, PromptAttachment, ToolStatus, UiMessage, UiState } from "../types";
import { Message, asText } from "./Message";
import { Markdown } from "./Markdown";
import { appResourceUrl } from "../base-url";
import { openImageLightbox } from "../image-lightbox-bridge";
import { openFilePreview } from "../file-preview-bridge";

import { collectQuestionAttachments } from "../question-attachments";
import { questionNavLayout } from "../question-nav";

import { parseSkillBlock } from "../skill-block";
import { computeEarlierCount } from "../history-window";
import { CollapsedMessage } from "./CollapsedMessage";
import { reviewFoldKind } from "../goal-review-fold";
import { useFlowStreamMode } from "../flow-mode";
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
import { useChatScroll } from "./use-chat-scroll";
import { EmptyTemplateCards } from "./PromptTemplates";
import { renderSlotToolbar } from "../slot-toolbar";
import { useT } from "../i18n";
import { isExportableMessage, setExportMessageCatalog, useExportImage } from "../export-image-state";
import { SaveImageDialog } from "./SaveImageDialog";
import { SelectionQuoteButton } from "./SelectionQuoteButton";
import { TextQuoteCard } from "./TextQuoteCard";
import { splitQuotedPrompt } from "../../../server/text-quote.js";
import { appSend } from "../app-globals";
import { resolveMessageIdForJump } from "../session-url";

const EMPTY_LIVE = new Map<string, { toolName: string; text: string }>();
const EMPTY_ID_SET: ReadonlySet<string> = new Set();
const EMPTY_FP: ReadonlyMap<string, number> = new Map();

const KEEP_RECENT_DEFAULT = 15;
const KEEP_RECENT_MIN = 5;
const KEEP_RECENT_MAX = 100;
const VIRTUAL_MIN = 30;
const LAZY_MOUNT_MARGIN = 1200;
const LAZY_UNMOUNT_MARGIN = 2400;
const ALWAYS_BUDGET = 1600;

function QueuedMessage({
	kind,
	text,
	index,
	id,
	onRemoveQueued,
	onRecallQueued,
}: {
	kind: "steer" | "followUp";
	text: string;
	index: number;
	id?: string;
	onRemoveQueued?: (kind: "steer" | "followUp", text: string, index: number, id?: string) => void;
	onRecallQueued?: (kind: "steer" | "followUp", text: string, index: number, id?: string) => void;
}) {
	const t = useT();
	const parsed = splitQuotedPrompt(text);
	return (
		<div className="msg msg-user msg-queued" data-role="user">
			<div className="msg-meta">
				<span className="msg-role">{t("role.user")}</span>
				<span className={`queued-tag ${kind === "steer" ? "steer" : "follow"}`}>
					{kind === "steer" ? t("queueSteerTag") : t("queueFollowTag")}
				</span>
				<div className="msg-queued-actions">
					{onRecallQueued && (
						<button
							type="button"
							className="msg-queued-recall"
							title={t("queueRecallTip")}
							aria-label={t("queueRecallTip")}
							onClick={() => onRecallQueued(kind, text, index, id)}
						>
							↩
						</button>
					)}
					{onRemoveQueued && (
						<button
							type="button"
							className="msg-queued-remove"
							title={t("queueRemoveTip")}
							aria-label={t("queueRemoveTip")}
							onClick={() => onRemoveQueued(kind, text, index, id)}
						>
							✕
						</button>
					)}
				</div>
			</div>
			<div className="msg-body">
				<div className="msg-text">
					{parsed.quotes.map((quote, i) => (
						<TextQuoteCard key={`quote-${i}`} quote={quote} />
					))}
					{parsed.attachments && parsed.attachments.length > 0 && (
						<div className="queued-attachments">
							{parsed.attachments.map((att, i) => {
								const hasPath = Boolean(
									att.path && att.type !== "page" && att.type !== "conversation" && att.type !== "canvas",
								);
								const canPreview = Boolean(att.url || hasPath);
								const handleClick = () => {
									if (att.url) {
										openImageLightbox({
											src: att.url.startsWith("/") ? appResourceUrl(att.url) : att.url,
											alt: att.name,
										});
									} else if (hasPath && att.path) {
										openFilePreview({ path: att.path, name: att.name });
									}
								};
								return (
									<span
										key={`att-${i}`}
										className={`queued-att-chip${canPreview ? " previewable" : ""}`}
										title={
											canPreview ? `${att.name} (${att.url ? t("toolImageZoom") : t("fileOpenPreview")})` : att.name
										}
										onClick={canPreview ? handleClick : undefined}
										role={canPreview ? "button" : undefined}
										tabIndex={canPreview ? 0 : undefined}
										onKeyDown={
											canPreview
												? (e) => {
														if (e.key === "Enter" || e.key === " ") {
															e.preventDefault();
															handleClick();
														}
													}
												: undefined
										}
									>
										<span className="queued-att-icon">
											{att.type === "image" || att.type === "vision-bridge"
												? "🖼️"
												: att.type === "folder"
													? "📁"
													: att.type === "page"
														? "🌐"
														: att.type === "conversation"
															? "💬"
															: "📎"}
										</span>
										<span className="queued-att-name">{att.name}</span>
									</span>
								);
							})}
						</div>
					)}
					{parsed.text ? <Markdown text={parsed.text} hardBreaks /> : null}
				</div>
			</div>
		</div>
	);
}

function CompactionBanner({ compaction }: { compaction: NonNullable<UiState["compaction"]> }) {
	const t = useT();
	const [, setTick] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => setTick((n) => n + 1), 1000);
		return () => clearInterval(timer);
	}, []);
	const elapsed = Math.max(0, Math.floor((Date.now() - compaction.startedAt) / 1000));
	const reason =
		compaction.reason === "manual"
			? t("compactingReasonManual")
			: compaction.reason === "overflow"
				? t("compactingReasonOverflow")
				: t("compactingReasonThreshold");
	return (
		<div className="compact-notice" role="status">
			<span className="compact-pulse" />
			<span className="compact-text">
				{t("compactingContext")} · {elapsed}s
			</span>
			<span className="compact-reason">{reason}</span>
		</div>
	);
}

function hasToolCall(m: UiMessage): boolean {
	return m.content.some((b) => b.type === "toolCall");
}

export interface StreamKeyTracker {
	convKey: string;
	pending: { index: number; streamKey: string } | null;
	finalizedMap: Map<string, string>;
}

export function syncStreamRenderKeys(
	tracker: StreamKeyTracker,
	convKey: string,
	persistedMessages: readonly Pick<UiMessage, "id" | "role">[],
	streamingMessage: Pick<UiMessage, "id" | "role"> | null | undefined,
	onTransferred?: (fromStreamKey: string, toMessageId: string) => void,
): ReadonlyMap<string, string> {
	if (tracker.convKey !== convKey) {
		tracker.convKey = convKey;
		tracker.pending = null;
		tracker.finalizedMap.clear();
	}
	if (tracker.pending && streamingMessage?.id !== tracker.pending.streamKey) {
		const { index, streamKey } = tracker.pending;
		for (let i = Math.max(0, index); i < persistedMessages.length; i++) {
			const candidate = persistedMessages[i];
			if (candidate.role === "assistant" && !tracker.finalizedMap.has(candidate.id)) {
				tracker.finalizedMap.set(candidate.id, streamKey);
				onTransferred?.(streamKey, candidate.id);
				break;
			}
		}
		tracker.pending = null;
	}
	if (streamingMessage && tracker.pending?.streamKey !== streamingMessage.id) {
		tracker.pending = { index: persistedMessages.length, streamKey: streamingMessage.id };
	}
	return tracker.finalizedMap;
}

function hasMeaningfulText(m: UiMessage): boolean {
	if (!Array.isArray(m.content)) return false;
	return m.content.some((b) => {
		const t = asText(b);
		return t && t.text.trim().length > 0;
	});
}

export function isPureToolMessage(m: UiMessage): boolean {
	if (m.role && m.role !== "assistant") return false;
	if (m.customType) return false;
	if (!Array.isArray(m.content) || m.content.length === 0) return false;
	if (hasMeaningfulText(m)) return false;
	return m.content.some((b) => b.type === "toolCall" || b.type === "thinking");
}

function isAssistantFlowMessage(m: UiMessage): boolean {
	if (m.customType) return false;
	return m.role === "assistant" || !m.role;
}

export type MessageClusterItem =
	{ type: "single"; message: UiMessage } | { type: "tool_cluster"; id: string; messages: UiMessage[] };

export interface ClusterOptions {
	mergeTurns?: boolean;
}

export function clusterMessages(list: readonly UiMessage[], opts?: ClusterOptions): MessageClusterItem[] {
	const mergeTurns = !!opts?.mergeTurns;
	const out: MessageClusterItem[] = [];
	let currentCluster: { type: "tool_cluster"; id: string; messages: UiMessage[] } | null = null;

	for (let i = 0; i < list.length; i++) {
		const m = list[i];
		if (m.role === "system" || m.role === "toolResult") continue;
		const fold = reviewFoldKind(m);

		const isAssistantCandidate = isAssistantFlowMessage(m);
		const pureTool = isPureToolMessage(m);
		const isTrailingStreamCandidate =
			!pureTool && !!currentCluster && isAssistantCandidate && !fold && i === list.length - 1 && !hasMeaningfulText(m);

		const joinsCluster = fold ? false : mergeTurns ? isAssistantCandidate : pureTool || isTrailingStreamCandidate;

		if (joinsCluster) {
			if (!currentCluster) {
				currentCluster = { type: "tool_cluster", id: `cluster-${m.id}`, messages: [m] };
				out.push(currentCluster);
			} else {
				currentCluster.messages.push(m);
			}
		} else {
			currentCluster = null;
			out.push({ type: "single", message: m });
		}
	}
	return out;
}

export function estimateClusterHeight(messages: readonly UiMessage[], merged = false): number {
	if (merged) return Math.max(48, Math.ceil(messages.length / 4) * 30);
	return Math.max(48, messages.length * 52);
}

interface LazyToolClusterProps {
	id: string;
	show: boolean;
	placeholderHeight: number;
	attachEl: (el: HTMLDivElement | null) => void;
	onMeasured?: (id: string, h: number) => void;
	variant?: "trail" | "flow" | "contents";
	children: ReactNode;
}

const LazyToolCluster = memo(function LazyToolCluster({
	id,
	show,
	placeholderHeight,
	attachEl,
	onMeasured,
	variant = "trail",
	children,
}: LazyToolClusterProps) {
	const trailRef = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		if (!show) return;
		const el = trailRef.current;
		if (!el) return;
		const boxes = Array.from(el.children, (child) => child.getBoundingClientRect());
		const h =
			variant === "contents" && boxes.length
				? Math.max(...boxes.map((box) => box.bottom)) - Math.min(...boxes.map((box) => box.top))
				: el.offsetHeight;
		if (h > 0) onMeasured?.(id, h);
	}, [show, id, onMeasured, variant]);

	if (!show) {
		return (
			<div
				ref={attachEl}
				className="msg-lazy-ph msg-lazy-ph-cluster"
				data-cluster-id={id}
				data-lazy-id={id}
				style={{ height: placeholderHeight }}
				aria-hidden="true"
			/>
		);
	}

	return (
		<div
			ref={(el) => {
				trailRef.current = el;
				attachEl(el);
			}}
			className={variant === "flow" ? "flow-turn" : variant === "trail" ? "turn-tools-trail" : undefined}
			style={variant === "contents" ? { display: "contents" } : undefined}
			data-cluster-id={id}
			data-lazy-id={id}
		>
			{children}
		</div>
	);
});

interface MessageListProps {
	messageLabels?: ReadonlyMap<string, string>;
	readOnly?: boolean;
	uiMessageActions?: import("../ui-slots").UiSlotEntry[];
	uiContextMessage?: import("../ui-slots").UiSlotEntry[];
	uiContextToolCall?: import("../ui-slots").UiSlotEntry[];
	uiToolCardFooter?: import("../ui-slots").UiSlotEntry[];
	uiChatEmpty?: import("../ui-slots").UiSlotEntry[];
	onUiAction?: (item: import("../ui-slots").UiSlotEntry) => void;
	state: UiState;
	liveOutputs: ReadonlyMap<string, { toolName: string; text: string }>;
	toolStatuses: ReadonlyMap<string, ToolStatus>;
	onEdit?: (messageId: string, text: string, attachments?: PromptAttachment[]) => void;
	onKillBash?: () => void;
	onRetry?: () => void;
	onRemoveQueued?: (kind: "steer" | "followUp", text: string, index: number, id?: string) => void;
	onRecallQueued?: (kind: "steer" | "followUp", text: string, index: number, id?: string) => void;
	thinkingWrap?: boolean;
	quickAskTranslateEnabled?: boolean;
	toolsWrap?: boolean;
	toolImages?: boolean;
	reversePagination?: boolean;
	keepRecent?: number;
	minimalNewChat?: boolean;
	jumpTarget?: { path: string; role: string; timestamp: number } | null;
	onJumpDone?: () => void;
	urlJumpMessageId?: string | null;
	onUrlJumpDone?: () => void;
	preview?: boolean;
	userPromptNonce?: number;
}

export function MessageList({
	state,
	liveOutputs,
	toolStatuses,
	onEdit,
	onKillBash,
	onRetry,
	onRemoveQueued,
	onRecallQueued,
	thinkingWrap,
	quickAskTranslateEnabled = true,
	toolsWrap,
	toolImages,
	keepRecent,
	reversePagination = false,
	minimalNewChat = false,
	jumpTarget,
	onJumpDone,
	urlJumpMessageId,
	onUrlJumpDone,
	preview = false,
	userPromptNonce,
	messageLabels,
	readOnly = false,
	uiMessageActions,
	uiContextMessage,
	uiContextToolCall,
	uiToolCardFooter,
	uiChatEmpty,
	onUiAction,
}: MessageListProps) {
	const t = useT();
	const exportImage = useExportImage();
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);
	const escapedRef = useRef(false);

	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [searchOpen, setSearchOpen] = useState(false);
	const messages = useMemo(
		() => (state.streamingMessage ? [...state.messages, state.streamingMessage] : state.messages),
		[state.messages, state.streamingMessage],
	);
	const toolResults = useMemo(() => {
		const m = new Map<string, UiMessage>();
		for (const msg of state.messages) {
			if (msg.role === "toolResult" && msg.toolCallId) m.set(msg.toolCallId, msg);
		}
		return m;
	}, [state.messages]);
	const questionAttachments = useMemo(() => collectQuestionAttachments(state.messages), [state.messages]);
	const precedingQuestions = useMemo(() => {
		const targets = new Map<string, string>();
		let questionId: string | undefined;
		for (const message of state.messages) {
			if (message.role === "user") questionId = message.id;
			if (questionId) targets.set(message.id, questionId);
		}
		return targets;
	}, [state.messages]);
	const [editRequest, setEditRequest] = useState<{ id: string; session: typeof state.sessionFile } | null>(null);
	const lastId = useMemo(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role !== "system") return messages[i].id;
		}
		return null;
	}, [messages]);
	const keepRecentCount = Math.min(
		KEEP_RECENT_MAX,
		Math.max(KEEP_RECENT_MIN, Math.floor(Number(keepRecent) || KEEP_RECENT_DEFAULT)),
	);

	const collapsedIds = useMemo(() => {
		const s = new Set<string>();
		for (const m of state.messages) {
			if (m.role === "toolResult") continue;
			const fold = reviewFoldKind(m);
			if (fold && !expanded.has(m.id)) {
				s.add(m.id);
			}
		}
		return s;
	}, [state.messages, expanded]);

	const flowStream = useFlowStreamMode();
	const clusterOptions = useMemo<ClusterOptions>(() => ({ mergeTurns: true }), []);
	const [hidden, setHidden] = useState<Set<string>>(() => {
		if (reversePagination || state.messages.length <= VIRTUAL_MIN) return new Set();
		const always = pickAlways(state.messages, new Map(), Math.max(ALWAYS_BUDGET, keepRecentCount * 120));
		const init = new Set<string>();
		for (const m of state.messages) {
			if (!always.has(m.id)) init.add(m.id);
		}
		for (const it of clusterMessages(state.messages, clusterOptions)) {
			if (it.type === "tool_cluster" && it.messages.every((m) => !always.has(m.id))) {
				init.add(it.id);
			}
		}
		return init;
	});
	const [pinned, setPinned] = useState<Set<string>>(() => new Set());
	const heightsRef = useRef(new Map<string, number>());
	const heightMetaRef = useRef(new Map<string, HeightEntry>());
	const elsRef = useRef(new Map<string, HTMLDivElement>());
	const sweepRafRef = useRef(0);
	const lastSweepStRef = useRef(0);
	const lastSweepCountRef = useRef(0);
	const sweepIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const defaultPageSize = flowStream ? Math.max(240, keepRecentCount * 2) : Math.max(60, keepRecentCount * 2);
	const earlierPageSize = flowStream ? 120 : 30;
	const FIRST_PAINT_COUNT = 10;
	const firstPaintSize = Math.min(defaultPageSize, FIRST_PAINT_COUNT);
	const [visibleCount, setVisibleCount] = useState<number>(() => firstPaintSize);
	const convKey = `${state.conversationId ?? ""}:${state.sessionFile ?? ""}`;
	const [lastPreview, setLastPreview] = useState(preview);
	const previewHandoff = lastPreview && !preview;
	if (lastPreview !== preview) setLastPreview(preview);
	const prevPagingConvKeyRef = useRef(convKey);
	const prevMsgLenRef = useRef(messages.length);
	const prevFirstMsgIdRef = useRef(messages[0]?.id);
	const initialPreloadConvRef = useRef<string | null>(null);
	const pendingAnchorRef = useRef<{
		sh: number;
		st: number;
		id: string | null;
		top: number;
		msgLen: number;
		firstId: string | undefined;
	} | null>(null);
	const pagePendingRef = useRef(false);
	const [anchorLock, setAnchorLock] = useState(false);
	const anchorLockRef = useRef(false);
	const setAnchorLockBoth = useCallback((v: boolean) => {
		anchorLockRef.current = v;
		setAnchorLock(v);
	}, []);
	const settleRafRef = useRef(0);
	const settleBaseRef = useRef<{ id: string | null; top: number; sh: number; st: number } | null>(null);
	const findTopAnchor = useCallback((): { id: string | null; top: number } | null => {
		const el = scrollRef.current;
		if (!el) return null;
		const cTop = el.getBoundingClientRect().top;
		const nodes = el.querySelectorAll<HTMLElement>("[data-lazy-id]");
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			const r = node.getBoundingClientRect();
			if (r.bottom > cTop + 2) return { id: node.dataset.lazyId ?? null, top: r.top - cTop };
		}
		return null;
	}, []);
	const cancelSettle = useCallback(() => {
		if (settleRafRef.current) {
			cancelAnimationFrame(settleRafRef.current);
			settleRafRef.current = 0;
		}
		settleBaseRef.current = null;
	}, []);
	const capturePrependAnchor = useCallback(() => {
		const el = scrollRef.current;
		const a = findTopAnchor();
		pendingAnchorRef.current = {
			sh: el ? el.scrollHeight : 0,
			st: el ? el.scrollTop : 0,
			id: a?.id ?? null,
			top: a?.top ?? 0,
			msgLen: messages.length,
			firstId: messages[0]?.id,
		};
	}, [findTopAnchor, messages]);
	const restorePrependAnchor = useCallback((pend: { sh: number; st: number; id: string | null; top: number }) => {
		const el = scrollRef.current;
		if (!el) return;
		if (pend.id) {
			let node: HTMLElement | null = null;
			try {
				node = el.querySelector<HTMLElement>('[data-lazy-id="' + CSS.escape(pend.id) + '"]');
			} catch {
				node = null;
			}
			if (node) {
				const drift = node.getBoundingClientRect().top - el.getBoundingClientRect().top - pend.top;
				if (drift !== 0) el.scrollTop += drift;
				return;
			}
		}
		el.scrollTop = pend.st + (el.scrollHeight - pend.sh);
	}, []);
	const settlePrepend = useCallback(() => {
		const pend = pendingAnchorRef.current;
		const el = scrollRef.current;
		if (!el || !pend) return;
		cancelSettle();
		setAnchorLockBoth(true);
		restorePrependAnchor(pend);
		const cur = findTopAnchor();
		settleBaseRef.current = {
			id: cur?.id ?? null,
			top: cur?.top ?? 0,
			sh: el.scrollHeight,
			st: el.scrollTop,
		};
		let frames = 0;
		let still = 0;
		const step = () => {
			settleRafRef.current = 0;
			const root = scrollRef.current;
			const base = settleBaseRef.current;
			if (!root || !base) {
				setAnchorLockBoth(false);
				return;
			}
			if (Math.abs(root.scrollTop - base.st) > 2) {
				const fresh = findTopAnchor();
				settleBaseRef.current = {
					id: fresh?.id ?? null,
					top: fresh?.top ?? 0,
					sh: root.scrollHeight,
					st: root.scrollTop,
				};
				still = 0;
			} else {
				let drift = 0;
				let found = false;
				if (base.id) {
					let node: HTMLElement | null = null;
					try {
						node = root.querySelector<HTMLElement>('[data-lazy-id="' + CSS.escape(base.id) + '"]');
					} catch {
						node = null;
					}
					if (node) {
						found = true;
						drift = node.getBoundingClientRect().top - root.getBoundingClientRect().top - base.top;
					}
				}
				if (!found) {
					drift = root.scrollHeight - base.sh;
					const fresh = findTopAnchor();
					if (drift !== 0) root.scrollTop += drift;
					settleBaseRef.current = {
						id: fresh?.id ?? null,
						top: fresh?.top ?? 0,
						sh: root.scrollHeight,
						st: root.scrollTop,
					};
				} else {
					if (drift !== 0) root.scrollTop += drift;
					settleBaseRef.current = { ...base, sh: root.scrollHeight, st: root.scrollTop };
				}
				still = drift === 0 ? still + 1 : 0;
			}
			frames++;
			if ((still >= 3 && frames >= 4) || frames >= 30) {
				settleBaseRef.current = null;
				setAnchorLockBoth(false);
				return;
			}
			settleRafRef.current = requestAnimationFrame(step);
		};
		settleRafRef.current = requestAnimationFrame(step);
	}, [cancelSettle, findTopAnchor, restorePrependAnchor, setAnchorLockBoth]);
	if (prevPagingConvKeyRef.current !== convKey || previewHandoff) {
		prevPagingConvKeyRef.current = convKey;
		initialPreloadConvRef.current = null;
		setVisibleCount(
			previewHandoff ? Math.max(firstPaintSize, Math.min(visibleCount, prevMsgLenRef.current)) : firstPaintSize,
		);
		prevMsgLenRef.current = messages.length;
		prevFirstMsgIdRef.current = messages[0]?.id;
		pendingAnchorRef.current = null;
		cancelSettle();
		if (anchorLockRef.current) setAnchorLockBoth(false);
		pagePendingRef.current = false;
	}
	useLayoutEffect(() => {
		const delta = messages.length - prevMsgLenRef.current;
		prevMsgLenRef.current = messages.length;
		const firstId = messages[0]?.id;
		const isPrepend = firstId !== prevFirstMsgIdRef.current;
		prevFirstMsgIdRef.current = firstId;

		if (delta <= 0) return;
		setVisibleCount((cur) => cur + delta);
		if (!isPrepend) return;
		pagePendingRef.current = false;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [messages.length]);
	useLayoutEffect(() => {
		const pend = pendingAnchorRef.current;
		if (!pend) return;
		const firstId = messages[0]?.id;
		const serverArrived = firstId !== pend.firstId;
		const pureLocal = messages.length === pend.msgLen && !serverArrived;
		if (!serverArrived && !pureLocal) return;
		if (pagePendingRef.current && pureLocal) {
			settlePrepend();
			capturePrependAnchor();
			return;
		}
		pendingAnchorRef.current = null;
		settlePrepend();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [visibleCount]);

	const isPagingActive = !!reversePagination && !exportImage.open && !searchOpen;
	useEffect(() => {
		if (!isPagingActive || visibleCount >= defaultPageSize) return;
		let raf2 = 0;
		const raf1 = requestAnimationFrame(() => {
			raf2 = requestAnimationFrame(() => {
				startTransition(() => setVisibleCount((cur) => (cur < defaultPageSize ? defaultPageSize : cur)));
			});
		});
		return () => {
			cancelAnimationFrame(raf1);
			cancelAnimationFrame(raf2);
		};
	}, [isPagingActive, visibleCount, defaultPageSize, convKey]);
	const effectiveVisibleCount = isPagingActive ? Math.min(messages.length, visibleCount) : messages.length;
	useEffect(() => {
		pagePendingRef.current = false;
	}, [state.historyStart, state.historyTotal]);
	const historyStart = Math.max(0, state.historyStart ?? 0);
	const historyStartRef = useRef(historyStart);
	historyStartRef.current = historyStart;
	const earlierCount = computeEarlierCount({
		isPagingActive,
		totalMessages: messages.length,
		visibleCount,
		historyStart,
	});
	const hasEarlier = !preview && !exportImage.open && !searchOpen && earlierCount > 0;
	const visibleMessages =
		isPagingActive && effectiveVisibleCount < messages.length ? messages.slice(-effectiveVisibleCount) : messages;

	const requestServerPage = useCallback(
		(opts: { count?: number; all?: boolean }) => {
			if (preview || readOnly) return;
			if (pagePendingRef.current) return;
			pagePendingRef.current = true;
			cancelSettle();
			capturePrependAnchor();
			const firstMsgId = messages[0]?.id;
			const curStart = historyStartRef.current;
			appSend(
				opts.all
					? ({
							type: "load_earlier_messages",
							all: true,
							conversationId: state.conversationId ?? undefined,
							beforeId: firstMsgId,
							before: curStart,
						} satisfies ClientMessage)
					: ({
							type: "load_earlier_messages",
							count: opts.count ?? earlierPageSize,
							conversationId: state.conversationId ?? undefined,
							beforeId: firstMsgId,
							before: curStart,
						} satisfies ClientMessage),
			);
			setTimeout(() => {
				pagePendingRef.current = false;
			}, 3000);
		},
		[preview, readOnly, messages, earlierPageSize, cancelSettle, capturePrependAnchor, state.conversationId],
	);

	const loadEarlier = useCallback(
		(count?: number) => {
			if (preview) return;
			const page = count ?? earlierPageSize;
			cancelSettle();
			if (isPagingActive && messages.length - visibleCount >= page) {
				capturePrependAnchor();
				setVisibleCount((cur) => Math.min(messages.length, cur + page));
				return;
			}
			if (isPagingActive && messages.length > visibleCount) {
				capturePrependAnchor();
				setVisibleCount(messages.length);
			}
			if (historyStartRef.current > 0) requestServerPage({ count: page });
		},
		[isPagingActive, messages, visibleCount, requestServerPage, earlierPageSize, cancelSettle, capturePrependAnchor],
	);

	const hasEarlierRef = useRef(hasEarlier);
	hasEarlierRef.current = hasEarlier;
	const loadEarlierRef = useRef(loadEarlier);
	loadEarlierRef.current = loadEarlier;

	useEffect(() => {
		const cid = state.conversationId;
		if (!cid || initialPreloadConvRef.current === cid) return;
		if (!hasEarlier || preview) return;
		const timer = setTimeout(() => {
			if (initialPreloadConvRef.current === cid) return;
			initialPreloadConvRef.current = cid;
			if (hasEarlierRef.current) {
				loadEarlier();
			}
		}, 150);
		return () => clearTimeout(timer);
	}, [state.conversationId, hasEarlier, preview, loadEarlier]);

	const needsFullHistory = !preview && (searchOpen || exportImage.open);
	useEffect(() => {
		if (!needsFullHistory) return;
		if (historyStartRef.current > 0) requestServerPage({ all: true });
	}, [needsFullHistory, requestServerPage]);

	const clusteredItems = useMemo(
		() => clusterMessages(visibleMessages, clusterOptions),
		[visibleMessages, clusterOptions],
	);

	const virtualOn = !reversePagination && state.messages.length > VIRTUAL_MIN && !searchOpen;
	const virtualOnRef = useRef(virtualOn);
	virtualOnRef.current = virtualOn;

	const baseAlways = useMemo(
		() =>
			virtualOn
				? pickAlways(messages, heightsRef.current, Math.max(ALWAYS_BUDGET, keepRecentCount * 120))
				: EMPTY_ID_SET,
		[virtualOn, messages, keepRecentCount],
	);
	const alwaysSet = useMemo(() => {
		const set = new Set(baseAlways);
		for (const it of clusteredItems) {
			if (it.type === "tool_cluster" && it.messages.some((m) => baseAlways.has(m.id))) {
				set.add(it.id);
			}
		}
		return set;
	}, [baseAlways, clusteredItems]);
	const alwaysRef = useRef(alwaysSet);
	alwaysRef.current = alwaysSet;

	const fingerprints = useMemo(() => {
		if (!virtualOn) return EMPTY_FP;
		const m = new Map<string, number>();
		for (const msg of state.messages) m.set(msg.id, contentFingerprint(msg));
		for (const it of clusteredItems) {
			if (it.type === "tool_cluster") {
				let sum = 0;
				for (const msg of it.messages) sum += m.get(msg.id) ?? 0;
				m.set(it.id, sum);
			}
		}
		return m;
	}, [virtualOn, state.messages, clusteredItems]);
	const hiddenRef = useRef(hidden);
	let effectiveHidden = hidden;
	const prevLazyConvKeyRef = useRef(convKey);
	if (prevLazyConvKeyRef.current !== convKey || previewHandoff) {
		prevLazyConvKeyRef.current = convKey;
		{
			const keep = new Set(state.messages.map((m) => m.id));
			for (const it of clusterMessages(state.messages, clusterOptions)) {
				if (it.type === "tool_cluster") keep.add(it.id);
			}
			for (const id of elsRef.current.keys()) if (!keep.has(id)) elsRef.current.delete(id);
		}
		if (!reversePagination && state.messages.length > VIRTUAL_MIN) {
			const newAlways = pickAlways(state.messages, heightsRef.current, Math.max(ALWAYS_BUDGET, keepRecentCount * 120));
			const mountedNow = previewHandoff ? new Set(elsRef.current.keys()) : null;
			const nextHidden = new Set<string>();
			for (const m of state.messages) {
				if (!newAlways.has(m.id) && !mountedNow?.has(m.id)) nextHidden.add(m.id);
			}
			for (const it of clusterMessages(state.messages, clusterOptions)) {
				if (
					it.type === "tool_cluster" &&
					!mountedNow?.has(it.id) &&
					it.messages.every((m) => !newAlways.has(m.id) && !mountedNow?.has(m.id))
				) {
					nextHidden.add(it.id);
				}
			}
			effectiveHidden = nextHidden;
			setHidden(nextHidden);
			hiddenRef.current = nextHidden;
		} else if (hidden.size > 0) {
			const empty = new Set<string>();
			effectiveHidden = empty;
			setHidden(empty);
			hiddenRef.current = empty;
		}
	}
	hiddenRef.current = effectiveHidden;

	const fpRef = useRef(fingerprints);
	fpRef.current = fingerprints;

	const streamKeyTrackerRef = useRef<StreamKeyTracker>({
		convKey,
		pending: null,
		finalizedMap: new Map(),
	});
	const stableKeyMap = syncStreamRenderKeys(
		streamKeyTrackerRef.current,
		convKey,
		state.messages,
		state.streamingMessage,
		(fromStreamKey, toMessageId) => {
			const h = heightsRef.current.get(fromStreamKey);
			if (h !== undefined && !heightsRef.current.has(toMessageId)) {
				heightsRef.current.set(toMessageId, h);
			}
		},
	);

	const recordMeasured = useCallback((id: string, h: number, fp?: number) => {
		if (fp === undefined) return;
		heightMetaRef.current.set(id, { h, len: fp });
		heightsRef.current.set(id, h);
	}, []);

	const storeHeight = useCallback(
		(id: string, h: number) => {
			recordMeasured(id, h, fpRef.current.get(id));
		},
		[recordMeasured],
	);

	const sweep = useCallback(
		(force = false) => {
			const root = scrollRef.current;
			if (!root) return;
			if (!virtualOnRef.current) {
				setHidden((prev) => (prev.size ? new Set<string>() : prev));
				return;
			}

			if (!force) {
				const dSt = Math.abs(root.scrollTop - lastSweepStRef.current);
				if (dSt < 200 && state.messages.length === lastSweepCountRef.current) {
					return;
				}
			}
			lastSweepStRef.current = root.scrollTop;
			lastSweepCountRef.current = state.messages.length;

			const rootRect = root.getBoundingClientRect();
			const mountViewport = {
				top: rootRect.top - LAZY_MOUNT_MARGIN,
				bottom: rootRect.bottom + LAZY_MOUNT_MARGIN,
			};
			const unmountViewport = {
				top: rootRect.top - LAZY_UNMOUNT_MARGIN,
				bottom: rootRect.bottom + LAZY_UNMOUNT_MARGIN,
			};
			const items: WinRect[] = [];
			for (const [id, el] of elsRef.current) {
				const b = el.getBoundingClientRect();
				items.push({ id, top: b.top, bottom: b.bottom });
				if (!hiddenRef.current.has(id)) recordMeasured(id, b.bottom - b.top, fpRef.current.get(id));
			}
			const plan = planWindow(items, mountViewport, alwaysRef.current, hiddenRef.current, unmountViewport);
			for (const id of plan.hide) {
				const el = elsRef.current.get(id);
				if (el) recordMeasured(id, el.offsetHeight, fpRef.current.get(id));
			}
			setHidden((prev) => applyPlan(prev, plan));
		},
		[recordMeasured, state.messages.length],
	);

	const scheduleSweep = useCallback(() => {
		if (sweepIdleTimerRef.current) {
			clearTimeout(sweepIdleTimerRef.current);
		}
		sweepIdleTimerRef.current = setTimeout(() => {
			sweepIdleTimerRef.current = null;
			sweep(true);
		}, 120);

		if (sweepRafRef.current) return;
		sweepRafRef.current = requestAnimationFrame(() => {
			sweepRafRef.current = 0;
			sweep(false);
		});
	}, [sweep]);

	useEffect(() => {
		scheduleSweep();
	}, [scheduleSweep, state.conversationId, state.sessionFile, state.messages.length]);

	const prevSearchRef = useRef(searchOpen);
	useLayoutEffect(() => {
		if (prevSearchRef.current && !searchOpen) sweep(true);
		prevSearchRef.current = searchOpen;
	}, [searchOpen, sweep]);

	const attachEl = useCallback((el: HTMLDivElement | null) => {
		if (el) elsRef.current.set(el.dataset.lazyId ?? "", el);
	}, []);

	useEffect(() => {
		const ids = new Set(state.messages.map((m) => m.id));
		for (const it of clusteredItems) {
			if (it.type === "tool_cluster") ids.add(it.id);
		}
		for (const id of elsRef.current.keys()) {
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
	}, [state.messages, clusteredItems, expanded]);

	useEffect(
		() => () => {
			cancelAnimationFrame(sweepRafRef.current);
			cancelSettle();
			if (sweepIdleTimerRef.current) clearTimeout(sweepIdleTimerRef.current);
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[],
	);

	const questions = useMemo(() => {
		const qs: { id: string; text: string }[] = [];
		for (const m of state.messages) {
			if (m.role !== "user") continue;
			const joined = m.content
				.map((b) => asText(b)?.text ?? "")
				.filter(Boolean)
				.join(" ");
			const sb = parseSkillBlock(joined);
			const text = sb ? (sb.userMessage ?? `skill:${sb.name}`) : joined.trim();
			if (!text) continue;
			qs.push({ id: m.id, text });
		}
		return qs;
	}, [state.messages]);

	const qnIndex = useMemo(() => {
		const m = new Map<string, number>();
		questions.forEach((q, i) => m.set(q.id, i));
		return m;
	}, [questions]);

	const [activeIdx, setActiveIdx] = useState(-1);
	const activeIdxRef = useRef(-1);
	const activeRafRef = useRef(0);
	const questionsRef = useRef(questions);
	useEffect(() => {
		questionsRef.current = questions;
	}, [questions]);

	const updateActiveFromScroll = useCallback(() => {
		const el = scrollRef.current;
		const qs = questionsRef.current;
		if (!el || qs.length === 0) return;
		if (stickRef.current && !escapedRef.current) {
			const lastIdx = qs.length - 1;
			if (lastIdx !== activeIdxRef.current) {
				activeIdxRef.current = lastIdx;
				setActiveIdx(lastIdx);
			}
			return;
		}
		const containerTop = el.getBoundingClientRect().top;
		const margin = 140;
		let best = -1;
		for (let i = 0; i < qs.length; i++) {
			const node = elsRef.current.get(qs[i].id) ?? el.querySelector<HTMLElement>(`[data-msg-id="${qs[i].id}"]`);
			if (!node) continue;
			if (node.getBoundingClientRect().top <= containerTop + margin) best = i;
			else break;
		}
		if (best !== activeIdxRef.current) {
			activeIdxRef.current = best;
			setActiveIdx(best);
		}
	}, []);

	const scheduleActiveFromScroll = useCallback(() => {
		if (activeRafRef.current) return;
		activeRafRef.current = requestAnimationFrame(() => {
			activeRafRef.current = 0;
			updateActiveFromScroll();
		});
	}, [updateActiveFromScroll]);

	useEffect(() => () => cancelAnimationFrame(activeRafRef.current), []);

	useEffect(() => {
		updateActiveFromScroll();
	}, [questions, updateActiveFromScroll]);

	const expand = useCallback((id: string) => {
		setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
	}, []);

	useLayoutEffect(() => {
		setExportMessageCatalog(
			state.messages.filter(isExportableMessage).map((m) => ({ id: m.id, role: m.role, content: m.content })),
		);
	}, [state.messages]);

	useEffect(() => {
		if (!exportImage.open) return;
		for (const id of exportImage.selectedIds) expand(id);
		setPinned((prev) => {
			let changed = false;
			const next = new Set(prev);
			for (const id of exportImage.selectedIds) {
				if (!next.has(id)) {
					next.add(id);
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, [exportImage.open, exportImage.selectedIds, expand]);

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

	const jumpTo = useCallback(
		(id: string) => {
			if (isPagingActive) {
				const targetIdx = messages.findIndex((m) => m.id === id);
				if (targetIdx !== -1 && targetIdx < messages.length - visibleCount) {
					flushSync(() => {
						setVisibleCount(messages.length - targetIdx + 5);
					});
				}
			}
			flushSync(() => {
				expand(id);
				setPinned((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
			});
			const qIdx = questionsRef.current.findIndex((q) => q.id === id);
			activeIdxRef.current = qIdx;
			setActiveIdx(qIdx);
			requestAnimationFrame(() => {
				const el = scrollRef.current?.querySelector<HTMLElement>(`[data-msg-id="${id}"]`);
				if (el) {
					scrollRef.current?.querySelectorAll(".msg-flash").forEach((n) => n.classList.remove("msg-flash"));
					el.scrollIntoView({ block: "start" });
					el.classList.remove("msg-flash");
					void el.offsetWidth;
					el.classList.add("msg-flash");
					if (el !== scrollRef.current?.lastElementChild) escapedRef.current = true;
				}
			});
		},
		[expand],
	);

	const rollbackEdit = useCallback(
		(messageId: string) => {
			const id = precedingQuestions.get(messageId);
			if (!id || !onEdit) return;
			jumpTo(id);
			setEditRequest({ id, session: state.sessionFile });
		},
		[precedingQuestions, onEdit, jumpTo, state.sessionFile],
	);

	const [freshCompactionId, setFreshCompactionId] = useState<string | null>(null);
	const compactionSeenRef = useRef<{ convId: string; ids: Set<string> } | null>(null);
	const jumpedCompactionRef = useRef<string | null>(null);
	useEffect(() => {
		const cur = compactionSeenRef.current;
		if (!cur || cur.convId !== state.conversationId) {
			compactionSeenRef.current = {
				convId: state.conversationId,
				ids: new Set(state.messages.filter((m) => m.role === "compactionSummary").map((m) => m.id)),
			};
			jumpedCompactionRef.current = null;
			setFreshCompactionId(null);
			return;
		}
		for (const m of state.messages) {
			if (m.role === "compactionSummary" && !cur.ids.has(m.id)) {
				cur.ids.add(m.id);
				setFreshCompactionId(m.id);
				break;
			}
		}
	}, [state.messages, state.conversationId]);
	useEffect(() => {
		if (!freshCompactionId || jumpedCompactionRef.current === freshCompactionId) return;
		jumpedCompactionRef.current = freshCompactionId;
		jumpTo(freshCompactionId);
	}, [freshCompactionId, jumpTo]);

	const jumpMsgId = useMemo(() => {
		if (!jumpTarget) return null;
		return state.messages.find((m) => m.role === jumpTarget.role && m.timestamp === jumpTarget.timestamp)?.id ?? null;
	}, [state.messages, jumpTarget]);

	useEffect(() => {
		if (!jumpTarget) return;
		if (jumpMsgId) {
			jumpTo(jumpMsgId);
			onJumpDone?.();
			return;
		}
		if (state.sessionFile === jumpTarget.path && state.messages.length > 0) {
			onJumpDone?.();
		}
	}, [jumpMsgId, jumpTo, onJumpDone, jumpTarget, state.sessionFile, state.messages.length]);

	useEffect(() => {
		if (!urlJumpMessageId) return;
		const resolved = resolveMessageIdForJump(state.messages, urlJumpMessageId);
		if (resolved) {
			jumpTo(resolved);
			onUrlJumpDone?.();
			return;
		}
		if (state.messages.length > 0) {
			onUrlJumpDone?.();
		}
	}, [urlJumpMessageId, state.messages, jumpTo, onUrlJumpDone]);

	const {
		railRef,
		stickBottom,
		scrollToBottom,
		pauseForSelection,
		handleWheel,
		handleTouchStart,
		handleTouchMove,
		handlePointerDown,
		onScroll,
	} = useChatScroll({
		scrollRef,
		stickRef,
		escapedRef,
		messages,
		isStreaming: state.isStreaming,
		liveOutputs,
		toolStatuses,
		queue: state.queue,
		conversationId: state.conversationId,
		sessionFile: state.sessionFile,
		questions,
		jumpTarget,
		urlJumpMessageId,
		hasEarlier,
		loadEarlier,
		scheduleActiveFromScroll,
		scheduleSweep,
		userPromptNonce,
	});

	const [railH, setRailH] = useState(0);
	const hasQuestions = questions.length > 0;
	useLayoutEffect(() => {
		const rail = railRef.current;
		if (!rail) return;
		const update = () => setRailH(rail.clientHeight);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(rail);
		return () => observer.disconnect();
	}, [hasQuestions, railRef]);
	useEffect(() => {
		window.addEventListener("resize", scheduleSweep);
		return () => window.removeEventListener("resize", scheduleSweep);
	}, [scheduleSweep]);
	const {
		indices: railIndices,
		gap: railGap,
		many,
	} = useMemo(() => questionNavLayout(questions.length, railH, activeIdx), [questions.length, railH, activeIdx]);

	return (
		<div className={`messages-wrap${exportImage.open ? " messages-exporting" : ""}`}>
			<SelectionQuoteButton
				rootRef={scrollRef}
				sessionId={state.sessionId}
				enabled={!exportImage.open}
				translateEnabled={quickAskTranslateEnabled}
				onSelect={pauseForSelection}
			/>
			<div
				className={`messages${searchOpen || anchorLock ? "" : stickBottom && !escapedRef.current ? "" : " anchor-live"}`}
				ref={scrollRef}
				onScroll={onScroll}
				onWheel={handleWheel}
				onTouchStart={handleTouchStart}
				onTouchMove={handleTouchMove}
				onPointerDown={handlePointerDown}
			>
				{state.messages.length === 0 && !state.streamingMessage && !minimalNewChat && (
					<div className="empty-state">
						<EmptyTemplateCards />
						{!readOnly && uiChatEmpty && uiChatEmpty.length > 0 && (
							<div className="chat-empty-slots">{renderSlotToolbar(uiChatEmpty, onUiAction)}</div>
						)}
					</div>
				)}

				{clusteredItems.map((item) => {
					if (item.type === "tool_cluster") {
						const streamingId = state.streamingMessage?.id;
						const isStreamingCluster =
							(streamingId ? item.messages.some((m) => m.id === streamingId) : false) ||
							(state.isStreaming && item.messages.some((m) => m.id === lastId));
						const isClusterPinned = item.messages.some((m) => pinned.has(m.id));
						const isClusterAlways = item.messages.some((m) => alwaysSet.has(m.id));
						const isClusterHidden = effectiveHidden.has(item.id);
						const transparent = !flowStream && !item.messages.every(isPureToolMessage);
						const showCluster =
							!virtualOn || isStreamingCluster || isClusterPinned || isClusterAlways || !isClusterHidden;
						const isDenseCluster = item.messages.filter(isPureToolMessage).length >= 4;

						return (
							<LazyToolCluster
								key={`cluster-${stableKeyMap.get(item.messages[0].id) ?? item.messages[0].id}`}
								id={item.id}
								show={showCluster}
								placeholderHeight={getPlaceholderHeight(
									item.id,
									fingerprints.get(item.id) ?? -1,
									heightMetaRef.current,
									estimateClusterHeight(item.messages, flowStream),
								)}
								attachEl={attachEl}
								onMeasured={storeHeight}
								variant={flowStream ? "flow" : transparent ? "contents" : "trail"}
							>
								{item.messages.map((m) => {
									const isStreamingThis =
										(state.streamingMessage
											? m.id === state.streamingMessage.id
											: state.isStreaming && m.id === lastId) &&
										(m.role === "assistant" || !m.role);
									const renderKey = stableKeyMap.get(m.id) ?? m.id;
									const effectiveToolsWrap = isDenseCluster ? (isStreamingThis ? toolsWrap : false) : toolsWrap;

									return (
										<Message
											uiMessageActions={uiMessageActions}
											uiContextMessage={uiContextMessage}
											uiContextToolCall={uiContextToolCall}
											uiToolCardFooter={uiToolCardFooter}
											onUiAction={readOnly ? undefined : onUiAction}
											key={renderKey}
											message={m}
											toolResults={toolResults}
											liveOutputs={hasToolCall(m) ? liveOutputs : EMPTY_LIVE}
											toolStatuses={toolStatuses}
											streaming={isStreamingThis}
											onKillBash={readOnly ? undefined : onKillBash}
											onRetry={!readOnly && m.id === lastId ? onRetry : undefined}
											toolsWrap={effectiveToolsWrap}
											toolImages={toolImages}
											thinkingWrap={thinkingWrap}
											isLast={m.id === lastId}
											onEdit={readOnly ? undefined : onEdit}
											readOnly={readOnly}
											messageLabel={messageLabels?.get(m.id)}
											onRollbackEdit={rollbackEdit}
											canRollbackEdit={!readOnly && !!onEdit && precedingQuestions.has(m.id)}
											questionAttachments={questionAttachments.get(m.id)}
											editRequest={
												editRequest && editRequest.session === state.sessionFile && editRequest.id === m.id
													? editRequest
													: undefined
											}
											searchActive={searchOpen}
										/>
									);
								})}
							</LazyToolCluster>
						);
					}

					const m = item.message;
					const fold = reviewFoldKind(m);
					if (fold && !expanded.has(m.id)) {
						return (
							<CollapsedMessage
								key={m.id}
								message={m}
								onExpand={expand}
								summary={
									fold.kind === "prompt"
										? t("goalBarReviewing")
										: fold.verdict === "pass"
											? t("goalBarPassed")
											: t("goalBarFailed")
								}
							/>
						);
					}
					const qIdx = m.role === "user" ? qnIndex.get(m.id) : undefined;
					const show = !virtualOn || alwaysSet.has(m.id) || pinned.has(m.id) || !effectiveHidden.has(m.id);
					const isStreamingThis =
						(state.streamingMessage ? m.id === state.streamingMessage.id : state.isStreaming && m.id === lastId) &&
						(m.role === "assistant" || !m.role);
					const renderKey = stableKeyMap.get(m.id) ?? m.id;
					return (
						<LazyMount
							key={renderKey}
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
								uiMessageActions={uiMessageActions}
								uiContextMessage={uiContextMessage}
								uiContextToolCall={uiContextToolCall}
								uiToolCardFooter={uiToolCardFooter}
								onUiAction={readOnly ? undefined : onUiAction}
								key={renderKey}
								message={m}
								qnIndex={qIdx}
								qnActive={qIdx !== undefined ? qIdx === activeIdx : undefined}
								onJump={jumpTo}
								toolResults={toolResults}
								liveOutputs={hasToolCall(m) ? liveOutputs : EMPTY_LIVE}
								toolStatuses={toolStatuses}
								streaming={isStreamingThis}
								onKillBash={readOnly ? undefined : onKillBash}
								onRetry={!readOnly && m.id === lastId ? onRetry : undefined}
								toolsWrap={toolsWrap}
								toolImages={toolImages}
								thinkingWrap={thinkingWrap}
								isLast={m.id === lastId}
								onEdit={readOnly ? undefined : onEdit}
								readOnly={readOnly}
								messageLabel={messageLabels?.get(m.id)}
								onRollbackEdit={rollbackEdit}
								canRollbackEdit={!readOnly && !!onEdit && precedingQuestions.has(m.id)}
								editRequest={
									editRequest && editRequest.session === state.sessionFile && editRequest.id === m.id
										? editRequest
										: undefined
								}
								questionAttachments={questionAttachments.get(m.id)}
								onCollapse={fold ? collapse : undefined}
								searchActive={searchOpen}
								autoExpand={m.id === freshCompactionId}
							/>
						</LazyMount>
					);
				})}
				{state.retry && state.isStreaming && (
					<div className="retry-notice" role="status" title={state.retry.errorMessage || undefined}>
						<span className="retry-pulse" />
						<span className="retry-text">
							{state.retry.maxAttempts > 0
								? t("retryingApi", {
										attempt: Math.max(1, state.retry.attempt),
										max: state.retry.maxAttempts,
										error: state.retry.errorMessage,
									})
								: t("retryingApiSoon", { error: state.retry.errorMessage })}
						</span>
					</div>
				)}
				{state.compaction && <CompactionBanner compaction={state.compaction} />}
				{state.isStreaming && messages.length === 0 && <div className="streaming-wait">{t("waitingResponse")}</div>}
				{(state.queue.entries?.steering ?? state.queue.steering).map((item, i) => {
					const isObj = typeof item !== "string";
					const text = isObj ? item.text : item;
					const id = isObj ? item.id : undefined;
					return (
						<QueuedMessage
							key={id || `q-steer-${i}`}
							kind="steer"
							text={text}
							index={i}
							id={id}
							onRemoveQueued={readOnly ? undefined : onRemoveQueued}
							onRecallQueued={readOnly ? undefined : onRecallQueued}
						/>
					);
				})}
				{(state.queue.entries?.followUp ?? state.queue.followUp).map((item, i) => {
					const isObj = typeof item !== "string";
					const text = isObj ? item.text : item;
					const id = isObj ? item.id : undefined;
					return (
						<QueuedMessage
							key={id || `q-fu-${i}`}
							kind="followUp"
							text={text}
							index={i}
							id={id}
							onRemoveQueued={readOnly ? undefined : onRemoveQueued}
							onRecallQueued={readOnly ? undefined : onRecallQueued}
						/>
					);
				})}
				{!readOnly && state.actionSuggestions && state.actionSuggestions.length > 0 && (
					<div className="action-suggestions" aria-label={t("actionSuggestions")}>
						<div className="action-suggestions-list">
							{state.actionSuggestions.map((action) => (
								<button
									key={action.id}
									type="button"
									className="action-suggestion-chip"
									title={
										action.prompt !== action.label ? t("actionSuggestionsTip", { prompt: action.prompt }) : action.label
									}
									disabled={state.isStreaming}
									onClick={() => {
										scrollToBottom();
										appSend({ type: "prompt", text: action.prompt });
									}}
								>
									<span className="action-suggestion-label">{action.label}</span>
									<span className="action-suggestion-icon" aria-hidden="true">
										↵
									</span>
								</button>
							))}
						</div>
					</div>
				)}
			</div>
			{!stickBottom && (
				<button
					type="button"
					className="scroll-bottom"
					title={t("backToBottom")}
					aria-label={t("backToBottom")}
					onClick={scrollToBottom}
				>
					<FiArrowDown />
					<span className="scroll-bottom-label">{t("backToBottom")}</span>
				</button>
			)}
			<SearchBar
				containerRef={scrollRef}
				messages={messages}
				collapsedIds={collapsedIds}
				toolResults={toolResults}
				onExpand={expand}
				onProgrammaticScroll={() => {
					pauseForSelection();
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
					{railIndices.map((i) => {
						const q = questions[i];
						return (
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
						);
					})}
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
			<SaveImageDialog />
		</div>
	);
}
