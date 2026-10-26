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

import { collectQuestionAttachments } from "../question-attachments";

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

/** Stable shared empty map — passing this (instead of a fresh Map) lets
 *  React.memo skip messages that have no live tool output to show. */
const EMPTY_LIVE = new Map<string, { toolName: string; text: string }>();
/** 稳定共享空集合：窗口化关闭时（向上分页/短会话/搜索态）常驻区与占位指纹
 *  一律返回它，避免每次渲染都扫一遍全量消息。 */
const EMPTY_ID_SET: ReadonlySet<string> = new Set();
const EMPTY_FP: ReadonlyMap<string, number> = new Map();

/**
 * Messages beyond the most recent `keepRecent` are rendered as cheap collapsed
 * summary rows (no Markdown / thinking / tool output) until clicked. The window
 * size comes from the settings panel (keepRecentMessages, default 15); folding
 * only kicks in once history is at least twice the window, so short
 * conversations are untouched.
 */
const KEEP_RECENT_DEFAULT = 15;
const KEEP_RECENT_MIN = 5;
const KEEP_RECENT_MAX = 100;
/** 惰性窗口化（占位符）的启动门槛：与折叠判据解耦——折叠是显示偏好（随设置
 *  变化），窗口化是纯性能手段，门槛固定，不让大窗口用户牺牲渲染性能。 */
const VIRTUAL_MIN = 30;
/** 惰性窗口化挂载缓冲带：视口上下各多保留 1200px 的真实内容提前挂载。 */
const LAZY_MOUNT_MARGIN = 1200;
/** 惰性窗口化卸载缓冲带（迟滞安全区）：距离视口超过 2400px 时才卸载回占位符，
 *  1200px~2400px 之间保持现有挂载状态，彻底消除视口边缘反复横跳震荡。 */
const LAZY_UNMOUNT_MARGIN = 2400;
/** 底部常驻区高度预算（px）：贴底滚动 / 流式输出区域零占位延迟，
 *  但按累计高度截断——单条巨型消息不允许把常驻区撑成半个文档。 */
const ALWAYS_BUDGET = 1600;

/** 压缩进行中的常驻进度条：toast 会自动消失，而摘要 LLM 调用可能持续
 *  数十秒——这里跟随快照 compaction 字段常驻显示，并用 startedAt 滴答
 *  累计耗时，让用户知道压缩正在进行而不是卡死。 */
/** 排队/插队消息：和用户消息同结构（msg-user 气泡 + Markdown），仅多一个
 *  状态 tag + 右上角移除键，待服务端真正下发后变为正式用户消息。 */
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
	/** Position in queue.steering / queue.followUp — the ✕ removes THIS bubble. */
	index: number;
	id?: string;
	onRemoveQueued?: (kind: "steer" | "followUp", text: string, index: number, id?: string) => void;
	/** 撤回：把这条排队/插队消息从队列里取回，文字放回输入框（可编辑后重发）。 */
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
							{parsed.attachments.map((att, i) => (
								<span key={`att-${i}`} className="queued-att-chip">
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
							))}
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

/**
 * 保持流式助手气泡（`id = "stream-..."`）在定稿转入 `state.messages`（`id = "a-..."`）时的
 * React `key` 稳定一致，避免定稿瞬间 `<LazyMount>` 与 `<Message>` 整树卸载重建导致闪烁。
 */
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
	if (streamingMessage) {
		tracker.pending = { index: persistedMessages.length, streamKey: streamingMessage.id };
	}
	return tracker.finalizedMap;
}

/** 判断消息是否含有实质非空正文文本 */
function hasMeaningfulText(m: UiMessage): boolean {
	if (!Array.isArray(m.content)) return false;
	return m.content.some((b) => {
		const t = asText(b);
		return t && t.text.trim().length > 0;
	});
}

/** 判断消息是否为纯中间工具/思考调用（不含非空正文） */
export function isPureToolMessage(m: UiMessage): boolean {
	// 排除明确标为非 assistant 的角色；流式首帧若 role 尚未注入，亦可由 toolCall/thinking 正确归组
	if (m.role && m.role !== "assistant") return false;
	if (m.customType) return false;
	if (!Array.isArray(m.content) || m.content.length === 0) return false;
	if (hasMeaningfulText(m)) return false;
	return m.content.some((b) => b.type === "toolCall" || b.type === "thinking");
}

/** 助手产出（正文 / 思考 / 工具）——极简行文按回合合并的候选单位。 */
function isAssistantFlowMessage(m: UiMessage): boolean {
	if (m.customType) return false;
	return m.role === "assistant" || !m.role;
}

export type MessageClusterItem =
	{ type: "single"; message: UiMessage } | { type: "tool_cluster"; id: string; messages: UiMessage[] };

export interface ClusterOptions {
	/**
	 * 极简行文（字级输入流）：把**整个回合的助手产出**并成一个流单元，而不只是纯工具/思考。
	 * 正文与胶囊因此同处一条行内流（壳在 `.flow-turn` 里是 display:contents），
	 * 且一个回合仍然是一个可测量的惰性单元，窗口化粒度不变。
	 */
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
		// 当已有工具流集群正在进行中，且紧随其后的是末尾流式/生成中的助手消息时：
		// 若当前消息尚未吐出实质正文（即尚无非空 text 且无折叠），将其作为流式工具候选平滑并入集群，
		// 避免首帧因 toolCall 未就绪被短暂误判为 single 掉落至下一行、次帧就绪后再跳回上一行末尾。
		const isTrailingStreamCandidate =
			!pureTool && !!currentCluster && isAssistantCandidate && !fold && i === list.length - 1 && !hasMeaningfulText(m);

		// 极简行文：回合内所有助手消息（含带正文的）都进同一个流单元
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

/** 未实测时回合工具流集群的兜底高度估算（折叠态单卡片基准约 52px）。
 *  merged = 极简行文的「整回合一条行内流」：胶囊每行能排好几个，正文段落按块计，
 *  所以按「每 4 条一行的稠密行高」给个量级正确的粗估（实测值随后覆盖它）。 */
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
	/** 容器形态：trail = 逐消息块级壳外的工具流集群（普通主题，纵向卡片流）；
	 *  flow = 极简行文的 `字级输入流`回合容器（壳透明化，正文与胶囊连排）。 */
	variant?: "trail" | "flow";
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
		const h = el.offsetHeight;
		if (h > 0) onMeasured?.(id, h);
	}, [show, id, onMeasured]);

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
			className={variant === "flow" ? "flow-turn" : "turn-tools-trail"}
			data-cluster-id={id}
			data-lazy-id={id}
		>
			{children}
		</div>
	);
});

interface MessageListProps {
	/** 消息工具条条目（message.actions 槽位：内置 + 插件的最终结果）。 */
	uiMessageActions?: import("../ui-slots").UiSlotEntry[];
	/** 消息右键菜单条目（contextmenu.message 槽位）。 */
	uiContextMessage?: import("../ui-slots").UiSlotEntry[];
	/** 工具卡的工具名右键菜单条目（contextmenu.toolcall 槽位）。 */
	uiContextToolCall?: import("../ui-slots").UiSlotEntry[];
	/** 工具卡底部操作条目（tool.card.footer 槽位）。 */
	uiToolCardFooter?: import("../ui-slots").UiSlotEntry[];
	/** 空对话占位区条目（chat.empty 槽位：纯插件新增位，无条目时不渲染）。 */
	uiChatEmpty?: import("../ui-slots").UiSlotEntry[];
	/** 条目的动作分发（view 切视图 / action 交给插件）。 */
	onUiAction?: (item: import("../ui-slots").UiSlotEntry) => void;
	state: UiState;
	liveOutputs: ReadonlyMap<string, { toolName: string; text: string }>;
	toolStatuses: ReadonlyMap<string, ToolStatus>;
	/** Edit-and-re-ask handler (forwarded to user message bubbles). */
	onEdit?: (messageId: string, text: string, attachments?: PromptAttachment[]) => void;
	/** Kill the running bash command from its tool card (agent run continues). */
	onKillBash?: () => void;
	/** Manually retry the last failed model call (forwarded to the red error
	 *  on the last message; sends the server `retry_last` message). */
	onRetry?: () => void;
	/** Remove one queued prompt (the ✕ on a pending bubble). `id` = entry unique id, `index` = bubble position. */
	onRemoveQueued?: (kind: "steer" | "followUp", text: string, index: number, id?: string) => void;
	/** 撤回一条排队/插队消息（取回队列 + 文字回到输入框）。 */
	onRecallQueued?: (kind: "steer" | "followUp", text: string, index: number, id?: string) => void;
	/** 思考文本是否换行（设置面板开关；false = 不换行横向滚动）。 */
	thinkingWrap?: boolean;
	/** 工具调用是否默认展开（设置面板开关；false = 默认折叠）。 */
	toolsWrap?: boolean;
	/** 工具结果图片直接显示（设置面板开关；false = 不渲染缩略图）。 */
	toolImages?: boolean;
	/** 向上分页加载开关（设置面板的 reversePagination；true = 默认仅挂载最近历史消息）。 */
	reversePagination?: boolean;
	/** 尾部保持完整渲染的消息条数（设置面板的 keepRecentMessages；缺省 = 默认值）。 */
	keepRecent?: number;
	/** 极简新对话模式（设置面板开关；开 = 新对话隐藏提示词模板并隐藏快捷短语）。 */
	minimalNewChat?: boolean;
	/** 全局搜索「会话」结果的跳转请求：目标会话 path + 命中消息锚点。
	 *  消息载入后定位到对应消息并滚动高亮，完成后回调 onJumpDone。 */
	jumpTarget?: { path: string; role: string; timestamp: number } | null;
	onJumpDone?: () => void;
	/** URL 深链 `#s=<sessionId>&m=<messageId>` 的消息跳转目标（issue #587）。 */
	urlJumpMessageId?: string | null;
	onUrlJumpDone?: () => void;
	/** 切换会话过渡预览态（纯展示模式，禁用一切翻页网络请求与历史条渲染）。 */
	preview?: boolean;
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

	/** Messages the user expanded from the collapsed view — stay expanded. */
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	/** 会话内搜索栏（Ctrl+F / Cmd+F）。 */
	const [searchOpen, setSearchOpen] = useState(false);
	/** Persisted messages + the live in-progress assistant message (if any). */
	const messages = useMemo(
		() => (state.streamingMessage ? [...state.messages, state.streamingMessage] : state.messages),
		[state.messages, state.streamingMessage],
	);
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
	// system 消息不进渲染(见 serialize.ts)：从末尾逆向找第一条非 system 消息，零数组拷贝。
	const lastId = useMemo(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role !== "system") return messages[i].id;
		}
		return null;
	}, [messages]);
	// 尾部常驻窗口：设置面板的 keepRecentMessages（默认 15），钳到 [5, 100]——
	// 与服务端 normalizeKeepRecentMessages 同口径，值不合法时回落默认。
	// 用于保证底部常驻区至少覆盖指定数量的消息高度预算。
	const keepRecentCount = Math.min(
		KEEP_RECENT_MAX,
		Math.max(KEEP_RECENT_MIN, Math.floor(Number(keepRecent) || KEEP_RECENT_DEFAULT)),
	);

	/** 当前渲染为折叠摘要行的消息 id（SearchBar 的折叠层搜索索引用它；
	 *  toolResult 无独立折叠行——其结果文本已并入宿主 toolCall 卡）。
	 *  采用视口自适应机制后，仅目标审查语义折叠的消息属于折叠摘要。 */
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

	// ---- 惰性窗口化（lazy windowing，纯函数见 lazy-window.ts）----------------
	// 视口缓冲带之外的重型消息替换为等高占位 div；滚动临近时换回真实内容并
	// 在同一帧内补偿 scrollTop。占位保留 data-msg-id，导航/跳转/搜索不受影响。
	/** 极简行文（字级输入流）：按回合合并助手产出，正文与胶囊连成一条流。
	 *  其它主题为 false —— 分组/容器/外观全部走原有路径，零改动。 */
	const flowStream = useFlowStreamMode();
	const clusterOptions = useMemo<ClusterOptions | undefined>(
		() => (flowStream ? { mergeTurns: true } : undefined),
		[flowStream],
	);
	/** 当前处于占位状态的消息 id。长对话首帧即预置非可见区，避免大会话初次挂载时全量绘制导致卡顿。 */
	const [hidden, setHidden] = useState<Set<string>>(() => {
		// 向上分页模式下没有占位符，开机即不必全量扫描预置（大会话首帧提速）。
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
	/** 上次全量 sweep 时的 scrollTop 与消息条数：滚动位移小且总数未变时跳过全量 DOM 测量。 */
	const lastSweepStRef = useRef(0);
	const lastSweepCountRef = useRef(0);
	const sweepIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// ---- 向上分页加载状态（Reverse Pagination）-----------------------------
	// 初始默认加载 2 页（普通 60 条、极简 240 条），保证首载即具备双缓冲深度
	const defaultPageSize = flowStream ? Math.max(240, keepRecentCount * 2) : Math.max(60, keepRecentCount * 2);
	/** 向上翻页步长：极简行文下工具是行内小胶囊（约 4 条占一行），30 条只有 ~200px，
	 *  每滚一点就触发下一页、体感卡顿；按高度折算放大到 120 条 ≈ 一屏，翻页次数减到约 1/4。 */
	const earlierPageSize = flowStream ? 120 : 30;
	/** 分页模式首帧只挂最近这么多条，随后两帧内用 startTransition 补齐到整页：
	 *  打开长对话时先看到最新内容，重 Markdown/代码高亮的成本被推到可中断的后续渲染里，
	 *  不再白屏等一整页画完。 */
	const FIRST_PAINT_COUNT = 10;
	const firstPaintSize = Math.min(defaultPageSize, FIRST_PAINT_COUNT);
	const [visibleCount, setVisibleCount] = useState<number>(() => firstPaintSize);
	const convKey = `${state.conversationId ?? ""}:${state.sessionFile ?? ""}`;
	const prevPagingConvKeyRef = useRef(convKey);
	const prevMsgLenRef = useRef(messages.length);
	const prevFirstMsgIdRef = useRef(messages[0]?.id);
	const initialPreloadConvRef = useRef<string | null>(null);
	/** 前插锚点快照：捕获前插提交前的 scrollHeight/scrollTop + 视口顶部首个可见单元。
	 *  复位优先按锚点残差（与原生滚动锚定可叠加收敛），锚点在集群接缝合并中消失时退化为高度差。 */
	const pendingAnchorRef = useRef<{
		sh: number;
		st: number;
		id: string | null;
		top: number;
		msgLen: number;
		firstId: string | undefined;
	} | null>(null);
	/** 服务端翻页在途：滚轮在顶部会反复触发，只允许一个请求在路上。 */
	const pagePendingRef = useRef(false);
	/** 手动锚定期：前插复位 + 多帧沉降期间摘除原生 overflow-anchor，避免双重补偿打架；结束后恢复。 */
	const [anchorLock, setAnchorLock] = useState(false);
	const anchorLockRef = useRef(false);
	const setAnchorLockBoth = useCallback((v: boolean) => {
		anchorLockRef.current = v;
		setAnchorLock(v);
	}, []);
	/** 沉降循环句柄与基线（复位后多帧吸收图片/高亮等滞后高度）。 */
	const settleRafRef = useRef(0);
	const settleBaseRef = useRef<{ id: string | null; top: number; sh: number; st: number } | null>(null);
	/** 容器内首个可见的消息单元（data-lazy-id：单消息 LazyMount 与工具集群占位同名，隐藏占位同样可锚）。 */
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
	/** 前插前捕获：调用方在 setState/appSend 之前同步执行。 */
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
	/** 锚点残差复位（layout 阶段同步执行，paint 前完成，无闪烁）。 */
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
			// 锚点单元在集群接缝合并中被重建：高度差兜底（同步布局下精确）。
		}
		el.scrollTop = pend.st + (el.scrollHeight - pend.sh);
	}, []);
	/** 前插提交后：paint 前同步复位 + 多帧沉降吸收滞后高度；用户手势优先，绝不与之打架。 */
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
			// 锁定期原生锚定已摘除，scrollTop 变化只可能来自我们上一帧的修正或用户手势；
			// 用户一旦接管本帧只重建基线、不纠正，体感上绝不抢滚动条。
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
					// 锚点暂不可见（集群接缝重建/惰性占位切换）：退化为高度差跟随，本帧重建基线。
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
			// 连续 3 帧零漂移即提前收工；最多 30 帧（约 500ms）覆盖图片解码/字体回流，之后交还原生锚定。
			if ((still >= 3 && frames >= 4) || frames >= 30) {
				settleBaseRef.current = null;
				setAnchorLockBoth(false);
				return;
			}
			settleRafRef.current = requestAnimationFrame(step);
		};
		settleRafRef.current = requestAnimationFrame(step);
	}, [cancelSettle, findTopAnchor, restorePrependAnchor, setAnchorLockBoth]);
	if (prevPagingConvKeyRef.current !== convKey) {
		prevPagingConvKeyRef.current = convKey;
		initialPreloadConvRef.current = null;
		setVisibleCount(firstPaintSize);
		prevMsgLenRef.current = messages.length;
		prevFirstMsgIdRef.current = messages[0]?.id;
		pendingAnchorRef.current = null;
		cancelSettle();
		if (anchorLockRef.current) setAnchorLockBoth(false);
		pagePendingRef.current = false;
	}
	// 前插到达（messages 头部变化）只负责把可见窗口跟上 + 解锁翻页；
	// 滚动复位统一放到下面的 visibleCount 布局效应里（窗口补齐、paint 前同步完成，#680）。
	useLayoutEffect(() => {
		const delta = messages.length - prevMsgLenRef.current;
		prevMsgLenRef.current = messages.length;
		const firstId = messages[0]?.id;
		const isPrepend = firstId !== prevFirstMsgIdRef.current;
		prevFirstMsgIdRef.current = firstId;

		if (delta <= 0) return;
		// 到达一页（或流式新增）：可见窗口跟着长，尾部内容不移位。
		setVisibleCount((cur) => cur + delta);
		// 流式尾部追加不解锁服务端翻页、不消费锚点；只有真正的更早前插才算一页到位。
		// 严禁被并发在途的流式追加/新用户消息错误消费，彻底杜绝前插后视口跳动（#680）。
		if (!isPrepend) return;
		pagePendingRef.current = false;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [messages.length]);
	// 前插提交后的滚动复位（paint 前同步 + 多帧沉降）：本地展开与服务端前插都会改变
	// visibleCount，在窗口补齐的同一提交里锚定复位，用户视角内容零位移；
	// 流式尾部/首屏预热等其它 visibleCount 变化直接跳过。
	useLayoutEffect(() => {
		const pend = pendingAnchorRef.current;
		if (!pend) return;
		const firstId = messages[0]?.id;
		const serverArrived = firstId !== pend.firstId;
		const pureLocal = messages.length === pend.msgLen && !serverArrived;
		// 中间提交（等待服务端页期间的流式追加）：既不复位也不清除，等真正的前插提交。
		if (!serverArrived && !pureLocal) return;
		if (pagePendingRef.current && pureLocal) {
			// 本地余量已展开、服务端页仍在路上：复位本次，再为下一次前插重新武装。
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
	// 服务端回执到达（包括边界空页或自愈快照对齐时）：游标变更即时解除翻页防重锁
	useEffect(() => {
		pagePendingRef.current = false;
	}, [state.historyStart, state.historyTotal]);
	/** 服务端窗口起点（>0 = 服务端还握着更早的历史没下发，见 server/message-window.ts）。
	 *  老服务端/窗口化关闭时恒为 0，行为与之前完全一致。 */
	const historyStart = Math.max(0, state.historyStart ?? 0);
	const historyStartRef = useRef(historyStart);
	historyStartRef.current = historyStart;
	/** 更早消息总数 = 本地还没展示的（开启本地分页时） + 服务端还没下发的（窗口化截留）。 */
	const earlierCount = computeEarlierCount({
		isPagingActive,
		totalMessages: messages.length,
		visibleCount,
		historyStart,
	});
	const hasEarlier = !preview && !exportImage.open && !searchOpen && earlierCount > 0;
	const visibleMessages =
		isPagingActive && effectiveVisibleCount < messages.length ? messages.slice(-effectiveVisibleCount) : messages;

	/** 向服务端要一页更早的历史（窗口化扫码，前插到 messages 头部）。 */
	const requestServerPage = useCallback(
		(opts: { count?: number; all?: boolean }) => {
			if (preview) return;
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
			// 服务端窗口化关闭时不会有回执：兜底解锁，不影响继续点击（回执到也会提前清掉）。
			setTimeout(() => {
				pagePendingRef.current = false;
			}, 3000);
		},
		[preview, messages, earlierPageSize, cancelSettle, capturePrependAnchor, state.conversationId],
	);

	const loadEarlier = useCallback(
		(count?: number) => {
			if (preview) return;
			const page = count ?? earlierPageSize;
			cancelSettle();
			// 本地还有没展示的更早消息（开启向上分页模式下）：直接撑开，零网络（同样锚定复位）。
			if (isPagingActive && messages.length - visibleCount >= page) {
				capturePrependAnchor();
				setVisibleCount((cur) => Math.min(messages.length, cur + page));
				return;
			}
			// 本地已到底（或未开启分页模式）：先把本地没展示的撑开（若有，锚定复位），
			// 再向服务端要更早一页（窗口化，复位由 visibleCount 布局效应按两次提交各做一次）。
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

	// 会话首次挂载双缓冲预热：首屏贴底就绪后，若还有更早历史未下发，
	// 自动静默预取第 2 页，确保用户向上翻阅时开局就坐拥两页现成内容，绝无撞顶等待感。
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

	// 需要扫全文/全量的入口（页内搜索、导出图片）打开时：服务端窗口化时把更早历史
	// 一次拉全，否则搜不到/导出缺前半段。（用户主动触发，一次付清）
	const needsFullHistory = !preview && (searchOpen || exportImage.open);
	useEffect(() => {
		if (!needsFullHistory) return;
		if (historyStartRef.current > 0) requestServerPage({ all: true });
	}, [needsFullHistory, requestServerPage]);

	// 同一任务回合内的连续中间工具与思考消息聚类为单行流式排布单元（向上分页时只聚类可见切片）
	const clusteredItems = useMemo(
		() => clusterMessages(visibleMessages, clusterOptions),
		[visibleMessages, clusterOptions],
	);

	/** 短会话、搜索打开或开启向上分页期间不做窗口化（分页模式下全量真实渲染已挂载切片，无占位符）。 */
	const virtualOn = !reversePagination && state.messages.length > VIRTUAL_MIN && !searchOpen;
	const virtualOnRef = useRef(virtualOn);
	virtualOnRef.current = virtualOn;

	// 底部常驻区（永不占位）：按预算 + 最新实测高度计算，结合 keepRecentCount 保障常驻预算，
	// 首次全量测量后巨型消息会被预算挤出常驻区、参与正常窗口化。
	// 使用统一的 messages（包含当前流式消息），确保正在生成的末尾消息恒在常驻区内。
	//
	// 只在窗口化真正开启时算：分页/短会话/搜索态下一条占位符都不会出现，此时每次渲染
	// 全量扫一遍消息是纯浪费（长会话里这是最贵的「每帧固定成本」之一）。
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

	/** 每条消息的当前内容指纹（id → fingerprint，随 state.messages 重算）。
	 *  同时计算回合工具集群的聚合指纹，集群内任意消息变动即失效对应实测高度缓存。
	 *  指纹只服务于占位高度校验 —— 窗口化关闭时整段跳过。 */
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
	// 镜像供 sweep（rAF 回调）读取而不重建依赖
	const fpRef = useRef(fingerprints);
	fpRef.current = fingerprints;
	// 镜像最新值，供 rAF 回调 / 事件处理器读取而不重建（沿用 questionsRef 模式）
	const hiddenRef = useRef(hidden);
	hiddenRef.current = hidden;

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
	const prevLazyConvKeyRef = useRef(convKey);
	if (prevLazyConvKeyRef.current !== convKey) {
		prevLazyConvKeyRef.current = convKey;
		if (!reversePagination && state.messages.length > VIRTUAL_MIN) {
			const newAlways = pickAlways(state.messages, heightsRef.current, Math.max(ALWAYS_BUDGET, keepRecentCount * 120));
			const nextHidden = new Set<string>();
			for (const m of state.messages) {
				if (!newAlways.has(m.id)) nextHidden.add(m.id);
			}
			for (const it of clusterMessages(state.messages, clusterOptions)) {
				if (it.type === "tool_cluster" && it.messages.every((m) => !newAlways.has(m.id))) {
					nextHidden.add(it.id);
				}
			}
			setHidden(nextHidden);
			hiddenRef.current = nextHidden;
		} else if (hidden.size > 0) {
			const empty = new Set<string>();
			setHidden(empty);
			hiddenRef.current = empty;
		}
	}

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

	/** 全量测量受管元素 → 窗口计划（rAF 节流调用；也用于初始与特殊迁移后）。 */
	const sweep = useCallback(
		(force = false) => {
			const root = scrollRef.current;
			if (!root) return;
			if (!virtualOnRef.current) {
				setHidden((prev) => (prev.size ? new Set<string>() : prev));
				return;
			}

			// 滚动节流优化：视口上下各有 1200px~2400px 的迟滞安全区；
			// 若距上次测量位移不足 200px 且消息数未变，绝不可能跨越缓冲带，跳过本轮全量 DOM 测量。
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
				// 显示中的元素顺手记录实测高度——pickAlways 的预算与占位高度都靠它；
				// 只在隐藏时测量的话，「初始就显示」的消息会永远停留在估算值。
				if (!hiddenRef.current.has(id)) recordMeasured(id, b.bottom - b.top, fpRef.current.get(id));
			}
			const plan = planWindow(items, mountViewport, alwaysRef.current, hiddenRef.current, unmountViewport);
			// 收起时用刚实测的高度做占位 ⇒ 流总高度不变 ⇒ 无需任何 scrollTop 补偿。
			// （曾在此做 shrink 补偿：它触发的 scroll 事件会让缓冲带重新罩住刚收起的
			// 元素 → 再挂载 → 再收起，自搏循环把用户钉在原地永远滚不到底。）
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
		// 滚动静止后 120ms 执行一次最终收敛 sweep（force=true）
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

	// 初始挂载与切换会话/消息集更新：首帧绘制前就把远端内容换成占位（大会话 attach 不再全量布局绘制）
	useLayoutEffect(() => {
		sweep(true);
	}, [sweep, state.conversationId, state.sessionFile, state.messages.length]);

	// 搜索关闭瞬间重新收起远端内容（打开期间强制全渲染以兼容 DOM 高亮/Range 收集）
	const prevSearchRef = useRef(searchOpen);
	useLayoutEffect(() => {
		if (prevSearchRef.current && !searchOpen) sweep(true);
		prevSearchRef.current = searchOpen;
	}, [searchOpen, sweep]);

	/** 外层元素注册（sweep 测量用）；卸载侧由下方清理 effect 兑底（React 18 的
	 *  ref(null) 回调拿不到 data-lazy-id，无法定点反注册）。 */
	const attachEl = useCallback((el: HTMLDivElement | null) => {
		if (el) elsRef.current.set(el.dataset.lazyId ?? "", el);
	}, []);

	// 消息集或展开状态变化后，清掉已不存在的受管元素 / 高度缓存 / 隐藏项
	// （依赖用服务端缓存的消息数组——引用稳定，流式增量不会每帧重跑）
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
	const activeRafRef = useRef(0);
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
		// 快速路径：处于贴底跟随态时，当前屏幕活跃问题恒为最后一条提问，
		// 跳过流式每帧的 querySelector + getBoundingClientRect 全量强制回流！
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
			// 优先从已注册元素 Map O(1) 获取节点，彻底避免昂贵的全树 querySelector 遍历
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

	// Pick the initial active question when the message set changes (also
	// covers expand/collapse since it re-renders with new DOM).
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
			if (isPagingActive) {
				const targetIdx = messages.findIndex((m) => m.id === id);
				if (targetIdx !== -1 && targetIdx < messages.length - visibleCount) {
					flushSync(() => {
						setVisibleCount(messages.length - targetIdx + 5);
					});
				}
			}
			// 占位中的目标或折叠中的目标先同步恢复真实渲染，再滚动定位——
			// flushSync 保证本轮 commit 后 DOM 即为最终形态。
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
		[expand],
	);

	// ---- 新压缩摘要到达：自动展开 + 滚动定位 ------------------------------
	// 压缩动辄数十秒，用户很可能已上滚回看；完成 toast 出现时新摘要卡在下方
	// 看不见。检测到同对话新增 compactionSummary → 展开该卡 + jumpTo 定位闪光。
	// 首载 / 切换对话时静默记住现有 id（历史摘要不跳转）。
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
		// jumpTo 身份随 messages 变化，守卫保证每个新摘要只跳一次
		if (!freshCompactionId || jumpedCompactionRef.current === freshCompactionId) return;
		jumpedCompactionRef.current = freshCompactionId;
		jumpTo(freshCompactionId);
	}, [freshCompactionId, jumpTo]);

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

	// ---- URL 深链 `#s=<sessionId>&m=<messageId>` 消息跳转（issue #587）----
	useEffect(() => {
		if (!urlJumpMessageId) return;
		const resolved = resolveMessageIdForJump(state.messages, urlJumpMessageId);
		if (resolved) {
			jumpTo(resolved);
			onUrlJumpDone?.();
			return;
		}
		// 会话消息已载入但目标消息不存在（例如分支后或 m= 无效）→ 留在会话末尾并清除待跳状态
		if (state.messages.length > 0) {
			onUrlJumpDone?.();
		}
	}, [urlJumpMessageId, state.messages, jumpTo, onUrlJumpDone]);

	// ---- 对话流贴底滚动与用户逃逸阅读生命周期统一管理器 ----
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
	});

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
		<div className={`messages-wrap${exportImage.open ? " messages-exporting" : ""}`}>
			<SelectionQuoteButton
				rootRef={scrollRef}
				sessionId={state.sessionId}
				enabled={!exportImage.open}
				onSelect={pauseForSelection}
			/>
			<div
				// anchor-live：未钉底（逃逸阅读）时启用原生滚动锚定，兜住部分跨视口
				// 边缘消息的占位⇄真身互换跳动；与钉底期的程序性再钉互斥（那时无此类）。
				// 手动锚定期（anchorLock）摘除原生锚定，避免与 JS 复位双重补偿打架。
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
						{uiChatEmpty && uiChatEmpty.length > 0 && (
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
						const isClusterHidden = hidden.has(item.id);
						const showCluster =
							!virtualOn || isStreamingCluster || isClusterPinned || isClusterAlways || !isClusterHidden;
						// 密集批量工具流智能收敛：同一回合连续调用 ≥ 4 个工具时，
						// 已完成的历史工具默认折叠为单行卡头（避免数万像素大卡片撑爆视口）；
						// 正在实时生成的流式工具保持展开显示实时输出；少量工具（< 4）保持用户 toolsWrap 设置。
						const isDenseCluster = item.messages.length >= 4;

						return (
							<LazyToolCluster
								key={item.id}
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
								variant={flowStream ? "flow" : "trail"}
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
											onUiAction={onUiAction}
											key={renderKey}
											message={m}
											toolResults={toolResults}
											liveOutputs={hasToolCall(m) ? liveOutputs : EMPTY_LIVE}
											toolStatuses={toolStatuses}
											streaming={isStreamingThis}
											onKillBash={onKillBash}
											toolsWrap={effectiveToolsWrap}
											toolImages={toolImages}
											thinkingWrap={thinkingWrap}
											isLast={m.id === lastId}
											onEdit={onEdit}
											searchActive={searchOpen}
										/>
									);
								})}
							</LazyToolCluster>
						);
					}

					const m = item.message;
					// 目标审查回合的指令与纯 verdict 结论默认折叠成摘要行（结论卡已有人话
					// 翻译，裸 JSON 只留审计入口；点开展开看原文，记忆沿用 expanded）。
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
					const show = !virtualOn || alwaysSet.has(m.id) || pinned.has(m.id) || !hidden.has(m.id);
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
								onUiAction={onUiAction}
								key={renderKey}
								message={m}
								qnIndex={qIdx}
								qnActive={qIdx !== undefined ? qIdx === activeIdx : undefined}
								onJump={jumpTo}
								toolResults={toolResults}
								liveOutputs={hasToolCall(m) ? liveOutputs : EMPTY_LIVE}
								toolStatuses={toolStatuses}
								streaming={isStreamingThis}
								onKillBash={onKillBash}
								onRetry={m.id === lastId ? onRetry : undefined}
								toolsWrap={toolsWrap}
								toolImages={toolImages}
								thinkingWrap={thinkingWrap}
								isLast={m.id === lastId}
								onEdit={onEdit}
								questionAttachments={questionAttachments.get(m.id)}
								onCollapse={fold ? collapse : undefined}
								searchActive={searchOpen}
								autoExpand={m.id === freshCompactionId}
							/>
						</LazyMount>
					);
				})}
				{/* 仅流式中显示：isStreaming 为 false 说明运行已结算，此时若 retry
					残留必是过期 flag（结束信号丢失），不显示，后续成功消息/agent_end
					会把它清掉 */}
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
				{/* 压缩中常驻进度：不依赖 isStreaming（压缩本身也算 streaming，
					但即使结束信号丢失也要凭 compaction 字段显示，直到 compaction_end） */}
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
							onRemoveQueued={onRemoveQueued}
							onRecallQueued={onRecallQueued}
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
							onRemoveQueued={onRemoveQueued}
							onRecallQueued={onRecallQueued}
						/>
					);
				})}
				{state.actionSuggestions && state.actionSuggestions.length > 0 && (
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
					{/* 文字包 span：窄屏（≤380px）只藏它退成纯图标（.scroll-bottom-label），
					    藏的是标签而不是整块，按钮本体的点击区与 title/aria 都在。 */}
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
					// 搜索跳转让位贴底机制：之后再吸底部会覆盖搜索定位
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
			<SaveImageDialog />
		</div>
	);
}
