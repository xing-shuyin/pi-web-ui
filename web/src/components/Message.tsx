import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
	FiArchive,
	FiBookOpen,
	FiCheckCircle,
	FiChevronDown,
	FiChevronRight,
	FiChevronUp,
	FiClock,
	FiCode,
	FiCopy,
	FiEdit3,
	FiFileText,
	FiGitBranch,
	FiImage,
	FiRefreshCw,
	FiRotateCcw,
	FiSquare,
	FiVolume2,
	FiX,
	FiZap,
} from "react-icons/fi";
import type {
	TextQuote,
	PromptAttachment,
	ToolStatus,
	UiBashBlock,
	UiContentBlock,
	UiImageBlock,
	UiMessage,
	UiTextBlock,
	UiThinkingBlock,
	UiToolCallBlock,
} from "../types";
import { readTextQuote } from "../../../server/text-quote.js";
import { renderHighlightedCommand } from "../bash-danger.js";
import { TextQuoteCard } from "./TextQuoteCard";
import { Markdown, PluginWidgetBlock } from "./Markdown";
import { StreamMarkdown } from "./StreamMarkdown";
import { CollapsibleHead } from "./CollapsibleHead";
import { appUrl } from "../base-url";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallBlock, type ToolView } from "./ToolCallBlock";
import { useT, type Translate } from "../i18n";
import { buildSessionDeepLink, parseSessionHash } from "../session-url";
import { fetchCompactedHistory, useCompactedHistory } from "../compacted-history-state";
import { parseSkillBlock, type SkillBlock } from "../skill-block";
import { isRasterImage, fileToProcessedImage } from "../image-paste";
import { contextMenuItems, openContextMenu } from "../context-menu-state";
import { messageMarkdown, messagePlainText } from "../copy-text";
import { formatSize } from "../format-bytes";
import { copyTextToClipboard, useCopyFeedback } from "../use-copy-feedback";
import {
	isSpeaking,
	isTtsAvailable,
	loadTtsSettings,
	onSpeakingChange,
	speak,
	speakingSourceId,
	stopSpeaking,
	stripMarkdownForSpeech,
} from "../tts";
import { openExportImage, toggleExportImageSelect, useExportImage } from "../export-image-state";
import { hasMessageWidget } from "../plugin-fence";
import { openRollbackDialog } from "../rollback-state";
import { BUILTIN_UI_ITEMS, type UiSlotEntry } from "../ui-slots";
import { appSend } from "../app-globals";
import { isAbortedTurn } from "../aborted-turn";

/** 编辑重问编辑器里直接拖入/粘贴文件的上限（与服务端 MAX_UPLOAD_BYTES 一致）。 */
const MAX_EDIT_UPLOAD_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Narrowing guards. UiContentBlock is an open union (its last member is
// `{ type: string; [k: string]: unknown }`), so plain `switch` narrowing does
// not work — same pattern pi-vsc uses in shared/blocks.ts.
// ---------------------------------------------------------------------------

export function asText(block: UiContentBlock): UiTextBlock | null {
	return block.type === "text" && typeof (block as UiTextBlock).text === "string" ? (block as UiTextBlock) : null;
}

export function asThinking(block: UiContentBlock): UiThinkingBlock | null {
	return block.type === "thinking" && typeof (block as UiThinkingBlock).thinking === "string"
		? (block as UiThinkingBlock)
		: null;
}

export function asToolCall(block: UiContentBlock): UiToolCallBlock | null {
	return block.type === "toolCall" &&
		typeof (block as UiToolCallBlock).id === "string" &&
		typeof (block as UiToolCallBlock).name === "string"
		? (block as UiToolCallBlock)
		: null;
}

export function asImage(block: UiContentBlock): UiImageBlock | null {
	return block.type === "image" && typeof (block as UiImageBlock).dataUrl === "string" ? (block as UiImageBlock) : null;
}

export function asBash(block: UiContentBlock): UiBashBlock | null {
	return block.type === "bash" && typeof (block as UiBashBlock).command === "string" ? (block as UiBashBlock) : null;
}

/** Editor chip kind: raster image (thumb), restored upload (uploadPath),
 *  newly-added raw file (fileData) or workspace-path attachment. */
type EditAttKind = "image" | "upload" | "file" | "path";
function editAttKind(att: PromptAttachment): EditAttKind {
	if (att.imageData) return "image";
	if (att.uploadPath) return "upload";
	if (att.fileData) return "file";
	return "path";
}

/** Tooltip label for an editor chip (reuses the chat-input attachment i18n). */
function editAttLabel(att: PromptAttachment, t: Translate): string {
	if (att.mode === "quote" && att.quote) return att.quote.text;
	if (att.imageData) return t("attachImage", { name: att.name ?? "image" });
	if (att.uploadPath) return t("attachFile", { name: att.name ?? att.uploadPath });
	if (att.fileData) return t("attachFile", { name: att.name ?? "file" });
	const base = att.path.split("/").pop() ?? att.path;
	if (att.mode === "lines" && att.lines)
		return t("attachLines", {
			path: base,
			start: att.lines.start,
			end: att.lines.end,
		});
	if (att.mode === "page") return t("attachPage", { name: att.name ?? att.path });
	if (att.mode === "conversation") return t("attachConversation", { name: att.name ?? att.path });
	if (att.mode === "reference") return t("refOnly", { path: base });
	return t("attachContent", { path: base });
}

/**
 * 工具条图标：宿主的 icon 是**词表名**（`"edit"` / `"copy"`，见 ui-slots.ts 末尾那份词表），
 * 直接当文本画出来就是一个英文单词；插件条目的 icon 按协议本来就是 emoji / 单个符号。
 * 判定口径与 context-menu-state.ts 的 `contextMenuGlyph` 保持一致（那边画 unicode 字形，
 * 这边画 react-icons —— 本组件已经引了这几个图标，不为图标新增依赖）。
 */
const SLOT_ICONS: Record<string, ReactNode> = {
	edit: <FiEdit3 />,
	copy: <FiCopy />,
	branch: <FiGitBranch />,
	text: <FiFileText />,
	markdown: <FiCode />,
	image: <FiImage />,
	undo: <FiRotateCcw />,
	volume: <FiVolume2 />,
	refresh: <FiRefreshCw />,
	x: <FiX />,
};

/** 条目图标：词表命中 → react-icons；emoji/符号短串 → 原样文本；其余（含空）→ 通用图标。 */
function slotIcon(icon?: string): ReactNode {
	const s = (icon ?? "").trim();
	if (!s) return <FiZap />;
	const known = SLOT_ICONS[s.toLowerCase()];
	if (known) return known;
	// 不含字母数字（纯 emoji / 符号）且长度 ≤ 4（emoji 带修饰符可能占 2 个 code unit）。
	if (!/[\p{L}\p{N}]/u.test(s) && s.length <= 4) return <span className="msg-action-glyph">{s}</span>;
	return <FiZap />;
}

/** 压成一行 + 截断（右键菜单的 target.label 用：菜单与读屏只该看到一小段纯文本）。 */
function truncateText(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

interface MessageProps {
	message: UiMessage;
	/** toolResult messages by toolCallId (precomputed in MessageList, memoized). */
	toolResults: ReadonlyMap<string, UiMessage>;
	liveOutputs: ReadonlyMap<string, { toolName: string; text: string }>;
	/** tool_status entries (tool_execution_end) by toolCallId. */
	toolStatuses: ReadonlyMap<string, ToolStatus>;
	streaming: boolean;
	/** True when this is the last rendered message (stream cursor + live blocks). */
	isLast: boolean;
	/** Edit-and-re-ask handler (user messages only). Stable identity — Message is memoized.
	 *  Attachments are the images kept from the original message plus any newly
	 *  pasted/dropped ones; they re-fill the visual context the fork drops. */
	onEdit?: (messageId: string, text: string, attachments?: PromptAttachment[]) => void;
	/** Original attachments attached to this question (precomputed in MessageList
	 *  from the attachment-card run that follows it): pasted/uploaded images
	 *  (imageData), uploaded files (uploadPath) and workspace-path attachments
	 *  (path+mode) — restored in the editor because fork(entry.parent) drops
	 *  the persisted attachment asides. */
	questionAttachments?: PromptAttachment[];
	/** Kill the running bash command from its tool card (agent run continues). */
	onKillBash?: () => void;
	/** Manually retry the last failed model call (red error on the LAST message
	 *  while idle). Wired to the server `retry_last` message. */
	onRetry?: () => void;
	/** When set, shows a collapse button (message was expanded from the collapsed view). */
	onCollapse?: (messageId: string) => void;

	/** Question-nav tag (user questions only): ordinal, active highlight, jump. */
	qnIndex?: number;
	qnActive?: boolean;
	onJump?: (messageId: string) => void;
	/** 思考文本是否换行（设置面板开关；false = 不换行横向滚动）。 */
	thinkingWrap?: boolean;
	/** 工具调用是否默认展开（设置面板开关；false = 默认折叠）。 */
	toolsWrap?: boolean;
	/** 工具结果图片直接显示（设置面板开关；false = 不渲染缩略图）。 */
	toolImages?: boolean;
	/** 会话内搜索打开：强制展开思考/工具卡/附件卡/技能卡——折叠内容不在
	 *  DOM，折叠层搜索索引搜到的词会“展开后看不到”。不改变用户折叠状态。 */
	searchActive?: boolean;
	/** 新插入的压缩摘要卡：首次渲染即自动展开一次，之后用户可手动收起
	 *  （收起后不再自动打开）。 */
	autoExpand?: boolean;

	/** `message.actions` 槽位的最终条目（宿主用 buildUiSlots 算好）。
	 *  **数组顺序 = 渲染顺序**（排序是宿主的活）。
	 *  缺省（undefined）= 宿主还没接线 → 回落到内置的硬编码「编辑重问」，行为与旧版一致；
	 *  传了（哪怕空数组）= 完全数据驱动（见 Message 里的 renderMessageActions）。
	 *  提示：请把 `uiSlots["message.actions"]` 原样透传 —— Message 是 memo 的，中间
	 *  `?? []` 新建数组会让整条消息每次渲染都白重建。 */
	uiMessageActions?: UiSlotEntry[];
	/** `contextmenu.message` 槽位的最终条目：右键消息时用它们弹宿主唯一的右键菜单。
	 *  （ContextMenu 实例由 App 渲染，这里只负责 openContextMenu。） */
	uiContextMessage?: UiSlotEntry[];
	/** `contextmenu.toolcall` 槽位的最终条目：右键**工具卡的卡头**（工具名那一行）时用它们
	 *  弹菜单（今天只有宿主内置的「显示工具详细信息」，插件也可贡献）。
	 *  与 uiContextMessage 同一口径：数组顺序 = 渲染顺序，hidden 跳过。 */
	uiContextToolCall?: UiSlotEntry[];
	/** 点一个插件条目的回调（宿主按 kind 分发 view/action）。内置条目（host:msg-*）由本
	 *  组件自己处理，不会走这里 —— 避免「宿主与组件都处理一遍」的双分发。 */
	onUiAction?: (item: UiSlotEntry, value?: string) => void;
	/** 只读模式（被折叠历史流渲染时使用）：隐藏编辑重问、回滚等操作。 */
	readOnly?: boolean;
}

export const Message = memo(function Message({
	message,
	toolResults,
	liveOutputs,
	toolStatuses,
	streaming,
	isLast,
	onEdit,
	onKillBash,
	onRetry,
	onCollapse,
	questionAttachments,

	qnIndex,
	qnActive,
	onJump,
	thinkingWrap,
	toolsWrap,
	toolImages,
	searchActive,
	autoExpand,
	uiMessageActions,
	uiContextMessage,
	uiContextToolCall,
	onUiAction,
	readOnly = false,
}: MessageProps) {
	const t = useT();
	// Inline edit-and-re-ask editor (user messages only).
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	// Attachments kept for the edited message: pre-filled from the original
	// message's attachment cards (fork drops persisted asides — they live on
	// the old branch past the fork point), extended by paste/drop. Mix of
	// imageData (pasted images), uploadPath (restored uploads), fileData
	// (newly added files) and path+mode (workspace attachments).
	const [editAttachments, setEditAttachments] = useState<PromptAttachment[]>([]);
	const [editDragOver, setEditDragOver] = useState(false);
	// Transient inline notice for the editor (oversized/unreadable dropped
	// files) — Message has no toast access, so it renders under the chips.
	const [editNotice, setEditNotice] = useState<string | null>(null);
	const editNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// 卸载时清掉未触发的复位定时器，避免组件销毁后还回调 setState。
	useEffect(
		() => () => {
			if (editNoticeTimer.current) clearTimeout(editNoticeTimer.current);
		},
		[],
	);
	const pushEditNotice = (msg: string) => {
		setEditNotice(msg);
		if (editNoticeTimer.current) clearTimeout(editNoticeTimer.current);
		editNoticeTimer.current = setTimeout(() => setEditNotice((cur) => (cur === msg ? null : cur)), 4000);
	};
	// toolResult content is rendered inside its toolCall card — never standalone
	// (otherwise the same output shows twice: formatted card + plain text).
	if (message.role === "toolResult") return null;
	// system 消息(prompt sections 内部差量)不同步到浏览器——服务端已过滤，
	// 这里是兑底：旧快照/缓存里残留的也不画空泡。
	if (message.role === "system") return null;
	// Compaction summaries get a distinct collapsible card (the CLI's
	// CompactionSummaryMessageComponent counterpart): a long summary dumped as
	// a plain bubble buries what the compaction actually produced.
	if (message.role === "compactionSummary") {
		return <CompactionCard message={message} forceOpen={searchActive} autoExpand={autoExpand} />;
	}
	// Attached files are rendered as their own collapsible card, separate from
	// the user message text.
	const isFileAttachment = message.role === "custom" && message.customType === "file";
	const fileQuote =
		isFileAttachment && (message.details as { mode?: string })?.mode === "quote"
			? readTextQuote((message.details as { quote?: unknown }).quote)
			: null;
	const quoteValues = (message.details as { quotes?: unknown[] })?.quotes;
	const messageQuotes: TextQuote[] =
		message.role === "user" && Array.isArray(quoteValues)
			? quoteValues.map(readTextQuote).filter((q): q is TextQuote => q !== null)
			: [];
	// Question text for the per-question tag's tooltip.
	const userText = message.content
		.map((b) => asText(b)?.text ?? "")
		.filter(Boolean)
		.join("\n");
	// 右键菜单 target.label 用的单行纯文本（../copy-text 的去标记版本；
	// truncateText 会把换行压成空格，菜单定位信息不该带换行/标记）。
	// A user message whose text is a `<skill …>` block (the SDK's /skill:name
	// expansion) renders as a compact collapsible skill card instead of dumping
	// the whole SKILL.md into the user bubble — same as the pi CLI.
	const skillBlock = message.role === "user" ? parseSkillBlock(userText) : null;
	const questionText = skillBlock
		? (skillBlock.userMessage ?? `skill:${skillBlock.name}`)
		: userText.split("\n").join(" ").trim();
	// Streaming bubble with no content yet (first token not arrived) — show a
	// visible “thinking…” placeholder instead of an invisible empty bubble.
	const isEmptyStreaming = streaming && isLast && message.content.length === 0;

	const canEdit = !readOnly && message.role === "user" && !streaming && !isEmptyStreaming && !!onEdit;
	/** Paste/drop handler inside the edit composer — same downscale pipeline
	 *  as the main input bar so payloads stay under the server's cap. */
	const addEditImageFiles = async (files: File[]) => {
		const added: PromptAttachment[] = [];
		for (const f of files) {
			if (!isRasterImage(f.type)) continue;
			const img = await fileToProcessedImage(f);
			if (!img) continue;
			added.push({
				path: "",
				imageData: img.data,
				mimeType: img.mimeType,
				name: img.name,
			});
		}
		if (added.length > 0) setEditAttachments((prev) => [...prev, ...added]);
	};
	/** Add a raw uploaded file (non-image, dropped in the editor) — read into
	 *  base64 fileData, same 20MB cap as the main input bar. */
	const addEditFile = async (f: File) => {
		if (f.size > MAX_EDIT_UPLOAD_BYTES) {
			pushEditNotice(t("fileTooLarge", { name: f.name, size: 20 }));
			return;
		}
		let base64: string;
		try {
			const dataUrl = await new Promise<string>((res, rej) => {
				const r = new FileReader();
				r.onload = () => res(r.result as string);
				r.onerror = () => rej(r.error ?? new Error("read failed"));
				r.readAsDataURL(f);
			});
			base64 = dataUrl.replace(/^data:[^;]*;base64,/, "");
		} catch {
			pushEditNotice(t("fileLoadFailed", { name: f.name }));
			return;
		}
		setEditAttachments((prev) => [
			...prev,
			{
				path: "",
				fileData: base64,
				name: f.name,
				size: f.size,
				mimeType: f.type || undefined,
			},
		]);
	};
	/** Add any dropped file: raster images through the resize pipeline, all
	 *  other files (incl. SVG) as raw uploads. */
	const addEditDropFiles = async (files: File[]) => {
		const imgs: File[] = [];
		for (const f of files) {
			if (isRasterImage(f.type)) imgs.push(f);
			else void addEditFile(f);
		}
		if (imgs.length > 0) await addEditImageFiles(imgs);
	};
	const directReask = () => {
		const text = skillBlock
			? "/skill:" + skillBlock.name + (skillBlock.userMessage ? " " + skillBlock.userMessage : "")
			: message.content
					.map((b) => asText(b)?.text ?? "")
					.filter(Boolean)
					.join("\n");
		const trimmed = text.trim();
		const hasAttachments = Boolean(questionAttachments && questionAttachments.length > 0);
		if (!trimmed && !hasAttachments) return;
		onEdit?.(message.id, trimmed, hasAttachments ? questionAttachments : undefined);
	};
	const startEdit = () => {
		setDraft(
			skillBlock
				? `/skill:${skillBlock.name}${skillBlock.userMessage ? ` ${skillBlock.userMessage}` : ""}`
				: message.content
						.map((b) => asText(b)?.text ?? "")
						.filter(Boolean)
						.join("\n"),
		);
		setEditAttachments(questionAttachments ?? []);
		setEditing(true);
	};
	const submitEdit = () => {
		const text = draft.trim();
		if (!text && !editAttachments.some((a) => a.mode === "quote" && readTextQuote(a.quote))) return;
		onEdit?.(
			message.id,
			text,
			// Original attachments (images / uploads / path refs) are always
			// preserved — restoring the visual context the fork would drop; a
			// text-only edit with none stays undefined.
			editAttachments.length > 0 ? editAttachments : undefined,
		);
		setEditing(false);
	};

	// ---- 宿主 UI 扩展点（issue #146）：message.actions 工具条 + contextmenu.message ----

	/** `host:msg-copy` 的落点**不在** hover 工具条里，而是每个文本块上的复制键
	 *  （`.msg-text-copy`：单行行内、多行右上浮层，复制的粒度是「块」而不是「整条消息」）。
	 *  所以这里只取它的可见性：宿主（buildUiSlots）把它的 hidden 算好，本组件据此决定
	 *  文本块上的复制键画不画 —— 这样「布局页里隐藏复制消息」才真的有效。
	 *  宿主没传 entries（undefined）时保持旧行为：显示。 */
	const copyAllowed = uiMessageActions
		? uiMessageActions.some((e) => e?.id === "host:msg-copy" && e.hidden !== true)
		: true;

	// ---- 整条消息一键复制（issue #228）：纯文本 / Markdown / 长图 ----
	const cardRef = useRef<HTMLDivElement>(null);
	/** 最近一次整条复制的回显（成功 ✓ / 失败 title 报错），1.6s 后自动复位。 */
	const [copyState, setCopyState] = useState<{ id: string; ok: boolean } | null>(null);
	const exportImage = useExportImage();
	const copyTimer = useRef(0);
	const wholeMarkdown = messageMarkdown(message.content);
	/** 只有人/助手消息的文本才值得整条复制（工具卡片、附件卡各有自己的复制键）。 */
	const canCopyWhole =
		(message.role === "assistant" || message.role === "user") && wholeMarkdown.length > 0 && !streaming;
	const doWholeCopy = async (id: string) => {
		try {
			let ok = false;
			if (id === "host:msg-copy-text") ok = await copyTextToClipboard(messagePlainText(message.content));
			else if (id === "host:msg-copy-markdown") ok = await copyTextToClipboard(wholeMarkdown);
			else {
				openExportImage(message.id);
				return;
			}
			window.clearTimeout(copyTimer.current);
			setCopyState({ id, ok });
			copyTimer.current = window.setTimeout(() => setCopyState(null), 1600);
		} catch {
			window.clearTimeout(copyTimer.current);
			setCopyState({ id, ok: false });
			copyTimer.current = window.setTimeout(() => setCopyState(null), 1600);
		}
	};

	/** 右键目标的可读名：消息纯文本截到 40 字；纯工具调用的助手消息没有文本，
	 *  回落角色名 —— 菜单的定位信息（读屏 aria-label、宿主排障）不该是空的。 */
	const ctxLabel = truncateText(messagePlainText(message.content), 40) || roleLabel(message.role, t);

	// ---- 本地 TTS：消息工具条「朗读」按钮（host:msg-speak，复制三件套旁边） ----
	// speaking 状态是浏览器级单例（tts.ts），这里只订阅；sourceId = 消息 id，
	// 让「停止」只落在正在读的这一条上 —— 读着 A 时点 B 是改读 B，不是停止。
	const [_ttsSpeaking, setTtsSpeaking] = useState(isSpeaking());
	useEffect(() => onSpeakingChange(setTtsSpeaking), []);
	const canSpeak =
		message.role === "assistant" &&
		messagePlainText(message.content).trim().length > 0 &&
		!streaming &&
		isTtsAvailable();
	const speakActive = canSpeak && speakingSourceId() === message.id;
	const toggleSpeak = () => {
		if (speakActive) {
			stopSpeaking();
			return;
		}
		// 手动朗读是明确意图，不受设置里 enabled 门控；但沿用语音/语速偏好。
		speak(
			stripMarkdownForSpeech(messagePlainText(message.content)),
			{ ...loadTtsSettings(), enabled: true },
			message.id,
		);
	};
	// 下拉复制菜单展开状态（点击外部或 Esc 关闭）
	const [copyDropdownOpen, setCopyDropdownOpen] = useState(false);
	const copyGroupRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!copyDropdownOpen) return;
		const onDocClick = (e: MouseEvent) => {
			if (copyGroupRef.current && !copyGroupRef.current.contains(e.target as Node)) {
				setCopyDropdownOpen(false);
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setCopyDropdownOpen(false);
		};
		document.addEventListener("mousedown", onDocClick);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDocClick);
			document.removeEventListener("keydown", onKey);
		};
	}, [copyDropdownOpen]);

	const speakNode = (key: string): ReactNode =>
		canSpeak ? (
			<button
				key={key}
				type="button"
				className={`msg-action${speakActive ? " msg-action-speaking" : ""}`}
				title={speakActive ? t("stopSpeakingMsg") : t("speakMsg")}
				aria-label={speakActive ? t("stopSpeakingMsg") : t("speakMsg")}
				onClick={toggleSpeak}
			>
				{speakActive ? <FiSquare /> : <FiVolume2 />}{" "}
				<span className="msg-action-label">{speakActive ? t("stopSpeakingMsg") : t("speakMsg")}</span>
			</button>
		) : null;

	/** 右键菜单兜底条目：直接取 BUILTIN_UI_ITEMS 的 contextmenu.message 内置清单
	 *  （单源，勿在此手抄）——slot 数据未接线时也能弹出与正常路径一致的菜单。 */
	const msgCtxFallback = (): UiSlotEntry[] =>
		BUILTIN_UI_ITEMS.filter((b) => b.slot === "contextmenu.message").map((b) => ({
			id: b.id,
			slot: b.slot,
			source: "host" as const,
			label: t(b.labelKey as Parameters<typeof t>[0]),
			labelKey: b.labelKey,
			icon: b.icon,
			kind: b.kind,
			group: b.group,
			order: b.order ?? 100,
			align: b.align ?? "start",
			hidden: b.hidden ?? false,
			userOverrides: [],
			arrangedBy: [],
		}));

	/**
	 * 右键消息 → 宿主的通用右键菜单（ContextMenu 实例由 App 渲染，这里负责准备 entries + onHostAction）。
	 * 点在链接 / 输入框 或有文本选中时交回系统原生菜单（pre / code 不让路：整条复制与
	 * 重问对代码块同样有用）；其余弹出消息操作菜单。
	 */
	const onMsgContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
		const el = e.target;
		if (el instanceof Element && el.closest("a, input, textarea, [contenteditable='true']")) return;
		const sel = window.getSelection?.();
		if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;

		const rawEntries: UiSlotEntry[] =
			uiContextMessage && uiContextMessage.length > 0 ? uiContextMessage : msgCtxFallback();

		const entries = rawEntries.map((entry) => {
			if (entry.source !== "host") return entry;
			switch (entry.id) {
				case "host:msg-ctx-copy-markdown":
				case "host:msg-ctx-copy-text":
					return canCopyWhole ? entry : { ...entry, hidden: true };
				case "host:msg-ctx-copy-image":
					return canCopyWhole && !readOnly ? entry : { ...entry, hidden: true };
				case "host:msg-ctx-copy-link": {
					const sid = parseSessionHash(window.location.hash)?.sessionId;
					return !streaming && Boolean(sid && message.id) ? entry : { ...entry, hidden: true };
				}
				case "host:msg-ctx-reask":
				case "host:msg-ctx-edit-reask":
					return canEdit ? entry : { ...entry, hidden: true };
				case "host:msg-ctx-fork":
				case "host:msg-ctx-rollback":
					return !readOnly && !streaming && !editing ? entry : { ...entry, hidden: true };
				case "host:msg-ctx-speak":
					if (!canSpeak) return { ...entry, hidden: true };
					return speakActive ? { ...entry, label: t("stopSpeakingMsg"), icon: "square" } : entry;
				default:
					return entry;
			}
		});

		if (contextMenuItems(entries).length === 0) return;

		e.preventDefault();
		openContextMenu({
			x: e.clientX,
			y: e.clientY,
			slot: "contextmenu.message",
			target: { id: message.id, kind: "message", label: ctxLabel },
			entries,
			onHostAction: (entry) => {
				switch (entry.id) {
					case "host:msg-ctx-copy-markdown":
						void doWholeCopy("host:msg-copy-markdown");
						return undefined;
					case "host:msg-ctx-copy-text":
						void doWholeCopy("host:msg-copy-text");
						return undefined;
					case "host:msg-ctx-copy-image":
						void doWholeCopy("host:msg-copy-image");
						return undefined;
					case "host:msg-ctx-copy-link": {
						const sid = parseSessionHash(window.location.hash)?.sessionId;
						if (sid && message.id) {
							const url = buildSessionDeepLink(window.location.href, {
								sessionId: sid,
								messageId: message.id,
							});
							void copyTextToClipboard(url);
						}
						return undefined;
					}
					case "host:msg-ctx-reask":
						directReask();
						return undefined;
					case "host:msg-ctx-edit-reask":
						startEdit();
						return undefined;
					case "host:msg-ctx-fork":
						appSend({ type: "fork_session", messageId: message.id, position: "before" });
						return undefined;
					case "host:msg-ctx-rollback":
						openRollbackDialog({ messageId: message.id });
						return undefined;
					case "host:msg-ctx-speak":
						toggleSpeak();
						return undefined;
					default:
						onUiAction?.(entry);
						return undefined;
				}
			},
		});
	};

	/**
	 * 聚合复制按钮（下拉格式：Markdown / 纯文本 / 长图 PNG）。
	 * 点击主按钮直接复制最常用的 Markdown；点击小箭头展开下拉菜单选择其他格式。
	 */
	const renderCopyDropdown = (key: string, availableEntries?: UiSlotEntry[]): ReactNode => {
		if (!canCopyWhole) return null;
		const defs = [
			{ id: "host:msg-copy-markdown", label: t("copyMarkdown"), icon: <FiCode /> },
			{ id: "host:msg-copy-text", label: t("copyText"), icon: <FiFileText /> },
			{ id: "host:msg-copy-image", label: t("copyImage"), icon: <FiImage /> },
		] as const;
		const activeItems = defs.filter((d) => {
			if (!availableEntries) return true;
			const entry = availableEntries.find((e) => e.id === d.id);
			return !entry || entry.hidden !== true;
		});
		if (activeItems.length === 0) return null;

		const active = copyState !== null;
		const ok = copyState?.ok;
		const isFailed = active && !ok;

		return (
			<div key={key} ref={copyGroupRef} className={`msg-copy-group${copyDropdownOpen ? " has-open-dropdown" : ""}`}>
				<button
					type="button"
					className={`msg-action msg-copy-main-btn${ok ? " msg-copy-success" : ""}`}
					title={ok ? t("copied") : isFailed ? t("copyFailed") : t("copyMarkdown")}
					aria-label={t("copyMarkdown")}
					onClick={() => void doWholeCopy("host:msg-copy-markdown")}
				>
					{ok ? <FiCheckCircle /> : <FiCopy />}
					<span className="msg-action-label">{ok ? t("copied") : t("copy")}</span>
				</button>
				<button
					type="button"
					className={`msg-action msg-copy-caret-btn${copyDropdownOpen ? " active" : ""}`}
					title={t("copyMessage")}
					aria-label={t("copyMessage")}
					aria-expanded={copyDropdownOpen}
					onClick={(e) => {
						e.stopPropagation();
						setCopyDropdownOpen((prev) => !prev);
					}}
				>
					<FiChevronDown className={`msg-copy-caret-icon${copyDropdownOpen ? " open" : ""}`} />
				</button>
				{copyDropdownOpen && (
					<div className="msg-copy-dropdown" role="menu">
						{activeItems.map((item) => (
							<button
								key={item.id}
								type="button"
								className="msg-copy-menu-item"
								role="menuitem"
								onClick={() => {
									setCopyDropdownOpen(false);
									void doWholeCopy(item.id);
								}}
							>
								{item.icon}
								<span>{item.label}</span>
							</button>
						))}
					</div>
				)}
			</div>
		);
	};

	const renderActionsChildren = (): ReactNode[] | null => {
		if (!uiMessageActions) {
			const fallbackCopy = renderCopyDropdown("fb-copy");
			const speakFallback = speakNode("fb-speak");
			if (!canEdit && !fallbackCopy && !speakFallback) return null;
			const children: ReactNode[] = [];
			if (canEdit) {
				children.push(
					<Fragment key="fb-reask">
						<button
							type="button"
							className="msg-action"
							title={t("reaskDirectlyTip")}
							aria-label={t("reaskDirectly")}
							onClick={directReask}
						>
							<FiRefreshCw /> <span className="msg-action-label">{t("reaskDirectly")}</span>
						</button>
						<button
							type="button"
							className="msg-action"
							title={t("editReaskTip")}
							aria-label={t("editReask")}
							onClick={startEdit}
						>
							<FiEdit3 /> <span className="msg-action-label">{t("editReask")}</span>
						</button>
					</Fragment>,
				);
			}
			if (fallbackCopy) children.push(fallbackCopy);
			if (speakFallback) children.push(speakFallback);
			return children;
		}
		const nodes: ReactNode[] = [];
		let copyDropdownRendered = false;
		uiMessageActions.forEach((entry, i) => {
			if (!entry || entry.hidden === true) return;
			if (entry.id === "host:msg-copy") return;
			const key = `${entry.id}#${i}`;
			const label = entry.label || entry.id;
			// 一键复制三件套：聚合为单个下拉按钮（首次遇到时渲染，其余跳过）。
			if (
				entry.id === "host:msg-copy-text" ||
				entry.id === "host:msg-copy-markdown" ||
				entry.id === "host:msg-copy-image"
			) {
				if (!copyDropdownRendered) {
					copyDropdownRendered = true;
					const node = renderCopyDropdown("copy-dropdown", uiMessageActions);
					if (node) nodes.push(node);
				}
				return;
			}
			if (entry.id === "host:msg-speak") {
				const node = speakNode(key);
				if (node) nodes.push(node);
				return;
			}
			if (entry.id === "host:msg-reask") {
				if (!canEdit) return;
				nodes.push(
					<button
						key={key}
						type="button"
						className="msg-action"
						title={t("reaskDirectlyTip")}
						aria-label={label}
						onClick={directReask}
					>
						{slotIcon(entry.icon)} <span className="msg-action-label">{label}</span>
					</button>,
				);
				return;
			}
			if (entry.id === "host:msg-edit-reask") {
				if (!canEdit) return;
				nodes.push(
					<button key={key} type="button" className="msg-action" title={t("editReaskTip")} onClick={startEdit}>
						{slotIcon(entry.icon)} <span className="msg-action-label">{label}</span>
					</button>,
				);
				return;
			}
			if (entry.id === "host:msg-fork") {
				if (streaming || editing) return;
				nodes.push(
					<button
						key={key}
						type="button"
						className="msg-action"
						title={t("forkSessionTip")}
						aria-label={label}
						onClick={() => appSend({ type: "fork_session", messageId: message.id, position: "before" })}
					>
						{slotIcon(entry.icon)} <span className="msg-action-label">{label}</span>
					</button>,
				);
				return;
			}
			if (entry.id === "host:msg-rollback") {
				if (readOnly || streaming || editing) return;
				nodes.push(
					<button
						key={key}
						type="button"
						className="msg-action"
						title={t("rollbackSessionTip")}
						aria-label={label}
						onClick={() => {
							openRollbackDialog({ messageId: message.id });
						}}
					>
						{slotIcon(entry.icon)} <span className="msg-action-label">{label}</span>
					</button>,
				);
				return;
			}
			if (entry.kind === "divider") {
				nodes.push(<span key={key} className="msg-action-divider" aria-hidden="true" />);
				return;
			}
			if (entry.kind === "badge") {
				nodes.push(
					<span key={key} className="msg-action-badge" title={label}>
						{entry.badge ?? label}
					</span>,
				);
				return;
			}
			if (entry.kind === "select" && entry.options?.length) {
				nodes.push(
					<select
						key={key}
						className="msg-action msg-action-select"
						title={label}
						aria-label={label}
						value={
							entry.options.some((o) => o.value === entry.value) ? (entry.value as string) : entry.options[0]!.value
						}
						onChange={(e) => onUiAction?.(entry, e.target.value)}
					>
						{entry.options.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>,
				);
				return;
			}
			nodes.push(
				<button
					key={key}
					type="button"
					className="msg-action"
					title={label}
					aria-label={label}
					onClick={() => onUiAction?.(entry)}
				>
					{slotIcon(entry.icon)} <span className="msg-action-label">{label}</span>
					{entry.badge ? <span className="msg-action-count">{entry.badge}</span> : null}
				</button>,
			);
		});
		if (nodes.length === 0) return null;
		return nodes;
	};

	const renderMessageActions = () => {
		const children = renderActionsChildren();
		if (!children) return null;
		return <div className={`msg-actions${copyDropdownOpen ? " has-open-dropdown" : ""}`}>{children}</div>;
	};

	// Goal-review verdict cards (server customType "goal-review") and wizard
	// progress cards ("goal-wizard") get a distinct frame so they read as goal
	// feedback rather than a plain plugin message.
	const isGoalReview =
		message.role === "custom" && (message.customType === "goal-review" || message.customType === "goal-wizard");
	const isGoalWizard = message.role === "custom" && message.customType === "goal-wizard";
	// 插件认领的自定义消息类型（messageWidget 泛化）：file / goal-review /
	// goal-wizard 走上面的专属卡片，其余 customType 有插件认领时交 PluginWidgetBlock
	// 渲染（载荷 JSON.stringify({customType, details})），原文做回退 children。
	const isCustomWidget =
		message.role === "custom" &&
		!!message.customType &&
		message.customType !== "file" &&
		!isGoalReview &&
		hasMessageWidget(message.customType);
	const widgetPayload = isCustomWidget
		? JSON.stringify({ customType: message.customType, details: message.details ?? {} })
		: "";

	const exportSelected = exportImage.open && exportImage.selectedIds.includes(message.id);
	const showExportCheck = exportImage.open && canCopyWhole;
	const exportForceThinking = exportSelected && exportImage.includeThinking;
	const exportForceTools = exportSelected && exportImage.includeTools;

	// 消息级操作按钮（`.msg-actions`）只给「有正文的助手消息」与「用户消息」两种：
	//   · 卡片头（思考 / 工具 / 附件 / 技能 / 压缩摘要）**一律只留自己的复制键**
	//     （chead-copy：复制思考 / 复制参数）—— 不再挂整排消息级按钮，于是同一条
	//     回复里两张 bash 卡长得一模一样，窄屏上右端按钮数也永远一致。
	//   · 没有正文的消息（纯工具调用 / 纯思考 / 附件卡 / 插件消息）不渲染底部行：
	//     `canCopyWhole`（整条复制三件套要正文）与 `canSpeak` 本来就为假，那一行
	//     只剩「派生分支 / 回滚」这类对卡片无意义的按钮，而复制已在卡头。
	const showMessageActions = !editing && (message.role === "user" || canCopyWhole);

	// 按钮行锚点：助手消息把它插在**最后一个正文块之后**，而不是整条消息末尾 ——
	// 模型常常「先说话、再发工具」，挂在末尾时按钮会被工具卡隔开，看着像属于工具卡
	// （窄屏实报）。没有正文块 → anchorIndex = -1，退回消息末尾。
	// 用户消息不锚：`.msg-user .msg-body` 是紫色气泡，插进去会坐到气泡里面。
	const anchorIndex = useMemo(() => {
		if (message.role !== "assistant") return -1;
		for (let i = message.content.length - 1; i >= 0; i--) if (asText(message.content[i])) return i;
		return -1;
	}, [message.role, message.content]);

	return (
		<div
			ref={cardRef}
			className={`msg msg-${message.role}${isGoalReview ? " msg-goal-review" : ""}${
				exportSelected ? " msg-export-selected" : ""
			}${readOnly ? " msg-readonly" : ""}`}
			data-role={message.role}
			data-msg-id={message.id}
			onContextMenu={onMsgContextMenu}
		>
			{showExportCheck && (
				<input
					type="checkbox"
					className="msg-export-check"
					checked={exportSelected}
					title={t("copyImage")}
					aria-label={t("copyImage")}
					onClick={(e) => e.stopPropagation()}
					onChange={() => toggleExportImageSelect(message.id)}
				/>
			)}
			<div className="msg-meta">
				{onCollapse && (
					<button
						type="button"
						className="msg-collapse-btn"
						title={t("collapseMsg")}
						onClick={() => onCollapse(message.id)}
					>
						<FiChevronUp /> {t("collapseMsg")}
					</button>
				)}
				<span className="msg-role">
					{message.role === "custom"
						? isGoalWizard
							? t("goalWizardCard")
							: isGoalReview
								? t("goalBarTitle")
								: message.customType === "file"
									? t("attachment")
									: `${t("plugin")} · ${message.customType ?? t("unknown")}`
						: roleLabel(message.role, t)}
				</span>
				{message.model && <span className="msg-model">{message.model}</span>}
				{message.timestamp && <span className="msg-time">{formatTime(message.timestamp)}</span>}
				{qnIndex !== undefined && onJump && (
					<button
						type="button"
						className={`qn-tag ${qnActive ? "active" : ""}`}
						title={`${qnIndex + 1}. ${questionText}`}
						aria-label={`${qnIndex + 1}. ${questionText}`}
						onClick={() => onJump(message.id)}
					>
						<span className="qn-tag-bar" />
						<span className="qn-tag-idx">{qnIndex + 1}</span>
					</button>
				)}
			</div>
			<div className="msg-body">
				{editing ? (
					<div
						className={`msg-editor${editDragOver ? " drag-over" : ""}`}
						onDragOver={(e) => {
							e.preventDefault();
							e.stopPropagation();
							setEditDragOver(true);
						}}
						onDragLeave={(e) => {
							if (!e.currentTarget.contains(e.relatedTarget as Node)) setEditDragOver(false);
						}}
						onDrop={(e) => {
							e.preventDefault();
							e.stopPropagation();
							setEditDragOver(false);
							void addEditDropFiles(Array.from(e.dataTransfer?.files ?? []));
						}}
					>
						{editAttachments.length > 0 && (
							<div className="msg-editor-images">
								{editAttachments.map((att, i) => {
									if (att.mode === "quote" && att.quote)
										return (
											<TextQuoteCard
												key={`quote-${i}`}
												quote={att.quote}
												onRemove={() => setEditAttachments((prev) => prev.filter((_, j) => j !== i))}
											/>
										);
									const kind = editAttKind(att);
									return (
										<span
											key={`${att.name ?? att.path ?? "att"}-${i}`}
											className={`msg-editor-img ${kind === "image" ? "" : "file-chip"}`}
											title={editAttLabel(att, t)}
										>
											{kind === "image" ? (
												<img src={`data:${att.mimeType ?? "image/png"};base64,${att.imageData}`} alt={att.name} />
											) : (
												<span className="msg-editor-file">
													<span className="msg-editor-file-icon">
														{kind === "path"
															? att.mode === "page"
																? "🌐"
																: att.mode === "reference"
																	? "🔗"
																	: "📎"
															: "📄"}
													</span>
													<span className="msg-editor-file-name">{att.name ?? att.path?.split("/").pop()}</span>
												</span>
											)}
											<button
												type="button"
												className="msg-editor-img-remove"
												title={t("removeAttachment")}
												onClick={() => setEditAttachments((prev) => prev.filter((_, j) => j !== i))}
											>
												<FiX />
											</button>
										</span>
									);
								})}
							</div>
						)}
						{editNotice && <div className="msg-editor-notice">{editNotice}</div>}
						<textarea
							className="msg-editor-input"
							value={draft}
							autoFocus
							placeholder={t("editPlaceholder")}
							rows={Math.max(2, Math.min(10, draft.split("\n").length + 1))}
							onChange={(e) => setDraft(e.target.value)}
							onPaste={(e) => {
								const images: File[] = [];
								for (const item of e.clipboardData?.items ?? []) {
									if (item.kind === "file" && isRasterImage(item.type)) {
										const f = item.getAsFile();
										if (f) images.push(f);
									}
								}
								if (images.length === 0) return; // plain text paste
								e.preventDefault();
								void addEditImageFiles(images);
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
									e.preventDefault();
									submitEdit();
								} else if (e.key === "Escape") {
									setEditing(false);
								}
							}}
						/>
						<div className="msg-editor-actions">
							<span className="msg-editor-hint">
								<FiImage /> {t("editAttachmentHint")}
							</span>
							<button type="button" className="chip" onClick={() => setEditing(false)}>
								{t("cancel")}
							</button>
							<button
								type="button"
								className="chip primary"
								disabled={!draft.trim() && !editAttachments.some((a) => a.mode === "quote" && readTextQuote(a.quote))}
								title={t("reaskFromHere")}
								onClick={submitEdit}
							>
								<FiEdit3 /> {t("reaskFromHere")}
							</button>
						</div>
					</div>
				) : (
					<>
						{isAbortedTurn(message) ? (
							// #575：用户停止 / 被抢占的回合是中性的收尾，不是报错——不红、不给「立刻重试」
							<div className="msg-stopped" role="status">
								{t("turnStopped")}
							</div>
						) : (
							message.errorMessage && (
								<div className="msg-error">
									<span className="msg-error-text">{message.errorMessage}</span>
									{/* 最后一轮报错且已停止：给一个手动重试入口
									（自动重试次数用完，服务端 retry_last 续跑一轮） */}
									{isLast && !streaming && onRetry && (
										<button type="button" className="msg-retry-btn" title={t("retryLastTip")} onClick={onRetry}>
											<FiRefreshCw /> {t("retryNow")}
										</button>
									)}
								</div>
							)
						)}
						{messageQuotes.map((quote, i) => (
							<TextQuoteCard key={`quote-${i}`} quote={quote} forceOpen={searchActive} />
						))}
						{fileQuote ? (
							<TextQuoteCard quote={fileQuote} forceOpen={searchActive} />
						) : isFileAttachment ? (
							<AttachmentCard message={message} forceOpen={searchActive} />
						) : skillBlock ? (
							<>
								<SkillCard block={skillBlock} forceOpen={searchActive} />
								{skillBlock.userMessage && (
									<div className="msg-text">
										<Markdown text={skillBlock.userMessage} hardBreaks />
									</div>
								)}
								{message.content.map((block, i) =>
									block.type === "text" ? null : (
										<Block
											key={`${message.id}-${i}`}
											block={block}
											toolResults={toolResults}
											liveOutputs={liveOutputs}
											toolStatuses={toolStatuses}
											streaming={streaming}
											isLast={isLast}
											onKillBash={onKillBash}
											toolsWrap={toolsWrap}
											toolImages={toolImages}
											thinkingWrap={thinkingWrap}
											searchActive={searchActive}
											forceThinking={exportForceThinking}
											forceTools={exportForceTools}
											role={message.role}
											showCopy={copyAllowed}
											uiContextToolCall={uiContextToolCall}
											onUiAction={onUiAction}
										/>
									),
								)}
							</>
						) : isCustomWidget ? (
							<PluginWidgetBlock type={message.customType ?? ""} code={widgetPayload}>
								{message.content.map((block, i) => (
									<Block
										key={`${message.id}-${i}`}
										block={block}
										toolResults={toolResults}
										liveOutputs={liveOutputs}
										toolStatuses={toolStatuses}
										streaming={streaming}
										isLast={isLast}
										onKillBash={onKillBash}
										toolsWrap={toolsWrap}
										toolImages={toolImages}
										thinkingWrap={thinkingWrap}
										searchActive={searchActive}
										forceThinking={exportForceThinking}
										forceTools={exportForceTools}
										role={message.role}
										showCopy={copyAllowed}
										uiContextToolCall={uiContextToolCall}
										onUiAction={onUiAction}
									/>
								))}
							</PluginWidgetBlock>
						) : (
							message.content.map((block, i) => (
								<Fragment key={`${message.id}-${i}`}>
									<Block
										block={block}
										toolResults={toolResults}
										liveOutputs={liveOutputs}
										toolStatuses={toolStatuses}
										streaming={streaming}
										isLast={isLast}
										onKillBash={onKillBash}
										toolsWrap={toolsWrap}
										toolImages={toolImages}
										thinkingWrap={thinkingWrap}
										searchActive={searchActive}
										forceThinking={exportForceThinking}
										forceTools={exportForceTools}
										role={message.role}
										showCopy={copyAllowed}
										uiContextToolCall={uiContextToolCall}
										onUiAction={onUiAction}
									/>
									{i === anchorIndex && showMessageActions && renderMessageActions()}
								</Fragment>
							))
						)}
						{isEmptyStreaming && (
							<div className="thinking-wait">
								{t("thinkingWait")}
								<span className="dot" />
							</div>
						)}
						{streaming && isLast && !isEmptyStreaming && <span className="stream-cursor" />}
					</>
				)}
			</div>
			{showMessageActions && anchorIndex < 0 && renderMessageActions()}
		</div>
	);
});

/** Collapsible card for an attached file (customType "file"). */
function AttachmentCard({ message, forceOpen = false }: { message: UiMessage; forceOpen?: boolean }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const { copied, copy } = useCopyFeedback({ duration: 1200 });
	// 搜索期间 forceOpen 只是“视口展开”：内容进 DOM 让搜索高亮/定位可用
	const shown = open || forceOpen;
	const details = (message.details ?? {}) as {
		name?: string;
		path?: string;
		mode?: "inline" | "reference" | "lines" | "image" | "bridged" | "page" | "conversation";
		size?: number;
		lines?: number;
		startLine?: number;
		endLine?: number;
		type?: "folder";
	};
	const name = details.name ?? details.path ?? t("attachment");
	const isFolder = details.type === "folder";
	const isReference = details.mode === "reference";
	const isBridged = details.mode === "bridged";
	const isPage = details.mode === "page";
	const isConversation = details.mode === "conversation";
	// href 协议白名单（审查 #3）：网页附件的链接只放行 http/https，
	// javascript:/data:/vbscript: 等危险 scheme 一律回落纯文本渲染。
	const safePageHref = details.path && /^https?:\/\//i.test(details.path.trim()) ? details.path.trim() : null;

	const text = message.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	const clean = stripFileWrapper(text);
	const image = message.content.find((b) => b.type === "image") as { type: "image"; dataUrl?: string } | undefined;
	const lines = clean.split("\n").length;
	const canCopy = !isReference && !isPage && !isConversation && clean.length > 0;

	return (
		<div
			className={`attachcard ${isReference ? "reference" : ""}${isPage ? " page" : ""}${isConversation ? " conversation" : ""}`}
		>
			<CollapsibleHead
				open={shown}
				headClassName="attachcard-head"
				titleText={shown ? t("collapseMsg") : t("expandMsg")}
				onToggle={() => setOpen((v) => (forceOpen ? true : !v))}
				toggle={
					!isReference && !isPage && !isConversation ? (
						<span className="chead-toggle">{shown ? <FiChevronDown /> : <FiChevronRight />}</span>
					) : null
				}
				icon={isFolder ? "📁" : isPage ? "🌐" : isConversation ? "💬" : "📎"}
				iconClassName="attachcard-icon"
				titleClassName="attachcard-name"
				after={
					<>
						{details.path &&
							(isPage && safePageHref ? (
								<a className="attachcard-path attachcard-link" href={safePageHref} target="_blank" rel="noreferrer">
									{details.path}
								</a>
							) : (
								<span className="attachcard-path">{details.path}</span>
							))}
						<span
							className={`attachcard-mode ${details.mode === "lines" ? "lines" : isReference ? "ref" : isPage ? "page" : isConversation ? "conversation" : isBridged ? "bridged" : "inline"}`}
						>
							{isPage
								? t("attachPageShort")
								: isConversation
									? t("attachConversationShort")
									: isReference
										? isFolder
											? t("folderRefShort")
											: `${t("refOnlyShort")} · ${formatSize(details.size)}`
										: isBridged
											? t("bridgedVision")
											: image
												? t("image")
												: details.mode === "lines"
													? t("inlineLinesRange", {
															start: details.startLine ?? 1,
															end: details.endLine ?? details.lines ?? 1,
														})
													: t("inlineLines", { n: details.lines ?? lines })}
						</span>
						{canCopy && (
							<button
								type="button"
								className="chead-copy"
								title={copied ? t("copied") : t("copyMessage")}
								aria-label={t("copyMessage")}
								onClick={(e) => {
									e.stopPropagation();
									void copy(clean);
								}}
							>
								{copied ? <FiCheckCircle /> : <FiCopy />}
							</button>
						)}
					</>
				}
			>
				{name}
			</CollapsibleHead>
			{!isReference &&
				shown &&
				(() => {
					const imgSrc = image?.dataUrl
						? image.dataUrl.startsWith("/")
							? appUrl(image.dataUrl)
							: image.dataUrl
						: undefined;
					return isBridged ? (
						<>
							<div className="attachcard-bridgenote">{t("bridgedVisionDetail")}</div>
							{imgSrc && (
								<div className="attachcard-image">
									<img src={imgSrc} loading="lazy" decoding="async" alt={name} />
								</div>
							)}
							{clean && <pre className="attachcard-content">{clean}</pre>}
						</>
					) : imgSrc ? (
						<div className="attachcard-image">
							<img src={imgSrc} loading="lazy" decoding="async" alt={name} />
						</div>
					) : (
						<pre className="attachcard-content">{clean}</pre>
					);
				})()}
			{isReference && (
				<div className="attachcard-refnote">
					{isFolder ? t("folderNotExpanded") : t("fileNotExpanded", { size: formatSize(details.size) })}
				</div>
			)}
		</div>
	);
}

/** Strip the <file path="..."> ``` ... ``` </file> or <vision-bridge> ...
 * </vision-bridge> wrapper for display. */
function stripFileWrapper(text: string): string {
	const m = text.match(/^\s*<file path="[^"]*"(?:\s+lines="[^"]*")?>\s*```\s*\n?([\s\S]*?)\n?```\s*<\/file>\s*$/);
	if (m) return m[1].trim();
	const vb = text.match(/^\s*<vision-bridge>\s*([\s\S]*?)\s*<\/vision-bridge>\s*$/);
	return vb ? vb[1].trim() : text.trim();
}

/**
 * Collapsible card for a compaction summary — the web counterpart of the
 * CLI's CompactionSummaryMessageComponent. Collapsed shows "compacted from
 * N tokens" + expand affordance; expanded shows the full summary markdown
 * plus a hint that only recent messages stay in context.
 */
function CompactionCard({
	message,
	forceOpen = false,
	autoExpand = false,
}: {
	message: UiMessage;
	forceOpen?: boolean;
	autoExpand?: boolean;
}) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const { copied, copy } = useCopyFeedback({ duration: 1200 });
	// 新摘要到达自动展开一次：render 期间同步（仅上升沿开一次是受支持的
	// React 模式），之后用户手动收起不再打扰。
	const [prevAuto, setPrevAuto] = useState(autoExpand);
	if (autoExpand !== prevAuto) {
		setPrevAuto(autoExpand);
		if (autoExpand) setExpanded(true);
	}
	const shown = expanded || forceOpen;
	const historyState = useCompactedHistory(message.id);
	const [historyOpen, setHistoryOpen] = useState(false);
	const toggleHistory = () => {
		if (!historyOpen) {
			setHistoryOpen(true);
			if (historyState.status === "idle") {
				fetchCompactedHistory(message.id);
			}
		} else {
			setHistoryOpen(false);
		}
	};
	const text = message.content
		.map((b) => asText(b)?.text ?? "")
		.filter(Boolean)
		.join("\n");
	const tokens = typeof message.tokensBefore === "number" ? message.tokensBefore.toLocaleString() : null;
	return (
		<div className="msg msg-compactionSummary" data-role={message.role} data-msg-id={message.id}>
			<div className="msg-meta">
				<span className="msg-role">{t("role.compaction")}</span>
				{message.timestamp && <span className="msg-time">{formatTime(message.timestamp)}</span>}
			</div>
			<div className={`compaction-card${expanded ? " expanded" : ""}`}>
				<CollapsibleHead
					open={shown}
					headClassName="compaction-head"
					titleText={shown ? t("collapseMsg") : t("expandMsg")}
					onToggle={() => setExpanded((v) => (forceOpen ? true : !v))}
					toggle={<span className="chead-toggle">{shown ? <FiChevronDown /> : <FiChevronRight />}</span>}
					icon={<FiArchive />}
					iconClassName="compaction-icon"
					titleClassName="compaction-title"
					after={
						text && (
							<button
								type="button"
								className="chead-copy"
								title={copied ? t("copied") : t("copyMessage")}
								aria-label={t("copyMessage")}
								onClick={(e) => {
									e.stopPropagation();
									void copy(text);
								}}
							>
								{copied ? <FiCheckCircle /> : <FiCopy />}
							</button>
						)
					}
				>
					{tokens ? t("compactionFrom", { tokens }) : t("role.compaction")}
				</CollapsibleHead>
				{shown && (
					<div className="compaction-body">
						<Markdown text={text} />
						<div className="compaction-hint">{t("compactionKeptHint")}</div>
						<div className="compacted-history-action">
							<button
								type="button"
								className="compacted-history-toggle-btn"
								onClick={toggleHistory}
								aria-expanded={historyOpen}
							>
								<span className="compacted-history-chevron">
									{historyOpen ? <FiChevronDown /> : <FiChevronRight />}
								</span>
								<FiClock className="compacted-history-clock-icon" />
								<span className="compacted-history-btn-text">
									{historyOpen ? t("hideCompactedHistory") : t("viewCompactedHistory")}
								</span>
								{historyState.status === "ready" && historyState.messages.length > 0 && (
									<span className="compacted-history-count-pill">
										{t("compactedHistoryTurns", { count: historyState.messages.length })}
									</span>
								)}
							</button>
						</div>
						{historyOpen && (
							<div className="compacted-history-panel">
								{historyState.status === "loading" && (
									<div className="compacted-history-loading">
										<span className="compact-pulse" />
										<span>{t("compactedHistoryLoading")}</span>
									</div>
								)}
								{historyState.status === "error" && (
									<div className="compacted-history-error">
										<span>
											{historyState.error === "compactedHistoryNotFound" ||
											historyState.error === "Compaction entry not found"
												? t("compactedHistoryNotFound")
												: historyState.error || t("compactedHistoryEmpty")}
										</span>
									</div>
								)}
								{historyState.status === "ready" && historyState.messages.length === 0 && (
									<div className="compacted-history-empty">{t("compactedHistoryEmpty")}</div>
								)}
								{historyState.status === "ready" && historyState.messages.length > 0 && (
									<CompactedHistoryStream messages={historyState.messages} />
								)}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

function CompactedHistoryStream({ messages }: { messages: UiMessage[] }) {
	const t = useT();
	const toolResults = useMemo(() => {
		const m = new Map<string, UiMessage>();
		for (const msg of messages) {
			if (msg.role === "toolResult" && msg.toolCallId) m.set(msg.toolCallId, msg);
		}
		return m;
	}, [messages]);

	const emptyMap = useMemo(() => new Map(), []);

	return (
		<div className="compacted-history-stream">
			<div className="compacted-history-stream-header">
				<span className="compacted-history-badge">
					<FiArchive /> {t("compactedHistoryBadge")}
				</span>
				<span className="compacted-history-count">{t("compactedHistoryTurns", { count: messages.length })}</span>
			</div>
			<div className="compacted-history-messages">
				{messages.map((m) => (
					<Message
						key={m.id}
						message={m}
						toolResults={toolResults}
						liveOutputs={emptyMap}
						toolStatuses={emptyMap}
						streaming={false}
						isLast={false}
						readOnly={true}
					/>
				))}
			</div>
		</div>
	);
}

/**
 * Compact collapsible card for a skill invocation (the SDK's /skill:name
 * expansion) — the web counterpart of the CLI's SkillInvocationMessageComponent.
 * Collapsed shows a book icon + skill name + file path, expanded shows the
 * full SKILL.md content. The user's own question (args) renders separately.
 */
function SkillCard({ block, forceOpen = false }: { block: SkillBlock; forceOpen?: boolean }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const { copied, copy } = useCopyFeedback({ duration: 1200 });
	const shown = expanded || forceOpen;
	return (
		<div className={`skillcard${expanded ? " expanded" : ""}`}>
			<CollapsibleHead
				open={shown}
				headClassName="skillcard-head"
				titleText={block.location}
				onToggle={() => setExpanded((v) => (forceOpen ? true : !v))}
				toggle={<span className="chead-toggle">{shown ? <FiChevronDown /> : <FiChevronRight />}</span>}
				icon={<FiBookOpen />}
				iconClassName="skillcard-icon"
				titleClassName="skillcard-name"
				after={
					<>
						<span className="skillcard-path">{block.location}</span>
						<button
							type="button"
							className="chead-copy"
							title={copied ? t("copied") : t("copyMessage")}
							aria-label={t("copyMessage")}
							onClick={(e) => {
								e.stopPropagation();
								void copy(block.content);
							}}
						>
							{copied ? <FiCheckCircle /> : <FiCopy />}
						</button>
					</>
				}
			>
				{block.name}
			</CollapsibleHead>
			{shown && (
				<div className="skillcard-body">
					<Markdown text={block.content} />
				</div>
			)}
		</div>
	);
}

function Block({
	block,
	toolResults,
	liveOutputs,
	toolStatuses,
	streaming,
	isLast,
	onKillBash,
	thinkingWrap,
	toolsWrap,
	toolImages,
	searchActive,
	forceThinking,
	forceTools,
	role,
	showCopy,
	uiContextToolCall,
	onUiAction,
}: {
	block: UiContentBlock;
	toolResults: ReadonlyMap<string, UiMessage>;
	liveOutputs: ReadonlyMap<string, { toolName: string; text: string }>;
	toolStatuses: ReadonlyMap<string, ToolStatus>;
	streaming: boolean;
	isLast: boolean;
	onKillBash?: () => void;
	/** 思考文本是否换行（false = 不换行横向滚动）。 */
	thinkingWrap?: boolean;
	/** 工具调用是否默认展开（false = 默认折叠）。 */
	toolsWrap?: boolean;
	/** 工具结果图片直接显示（false = 不渲染缩略图）。 */
	toolImages?: boolean;
	/** 会话内搜索打开：强制展开思考/工具卡。 */
	searchActive?: boolean;
	/** 导出图勾了「包含思考」且本条被选中。 */
	forceThinking?: boolean;
	/** 导出图勾了「包含工具」且本条被选中。 */
	forceTools?: boolean;
	/** 消息角色 — assistant/user 的纯文本块显示复制按钮。 */
	role?: UiMessage["role"];
	/** 是否画文本块上的复制键（false = 宿主在布局里隐藏了 `host:msg-copy`）。 */
	showCopy?: boolean;
	/** `contextmenu.toolcall` 槽位的条目（工具卡右键菜单），原样透传给 ToolCallBlock。 */
	uiContextToolCall?: UiSlotEntry[];
	/** 插件条目动作分发（透传给 ToolCallBlock；内置的 host:tool-info 由它自己分派）。 */
	onUiAction?: (item: UiSlotEntry, value?: string) => void;
}) {
	const t = useT();
	const { copied, copy } = useCopyFeedback({ duration: 1200 });
	const text = asText(block);
	if (text) {
		const live = streaming && isLast;
		// 单行消息：复制键不再用绝对定位压住文字，改成行内 flex 右键——与各 head
		// 同样的 6px 间距、垂直居中、28px 尺寸。多行仍用右上浮层。
		// showCopy=false：宿主在布局里隐藏了 host:msg-copy（那个条目的落点就是这里）。
		const copyable = (role === "assistant" || role === "user") && showCopy !== false;
		const oneLiner = copyable && !text.text.includes("\n") && !text.truncated;
		const body =
			role === "user" ? (
				// 用户自己的气泡：保留输入/粘贴时的单个换行（CommonMark 软换行会把
				// 多行纯文本折叠成连续文字）。助手消息仍走标准 markdown 段落语义。
				<Markdown text={text.text} hardBreaks />
			) : live ? (
				<StreamMarkdown text={text.text} />
			) : (
				<Markdown text={text.text} />
			);
		/** 复制键：多行时排在正文**前面**（触屏下它是 float:right，浮动元素必须
		 *  是块级兄弟的前一个节点，正文的行盒才会绕开它 —— 见 styles.css 的
		 *  `@media (hover: none)`）。桌面端它是绝对定位，DOM 顺序无视觉影响。
		 *  单行时保持在正文后面（`.msg-text.single` 走流内 flex 的既有排法）。 */
		const copyBtn = copyable ? (
			<button
				key="msg-text-copy"
				type="button"
				className={`msg-text-copy${copied ? " copied" : ""}`}
				title={copied ? t("copied") : t("copyMessage")}
				aria-label={t("copyMessage")}
				onClick={() => {
					void copy(text.text);
				}}
			>
				{copied ? <FiCheckCircle /> : <FiCopy />}
			</button>
		) : null;
		return (
			<div className={`msg-text${oneLiner ? " single" : ""}`}>
				{oneLiner ? (
					<>
						<div className="msg-text-main">{body}</div>
						{copyBtn}
					</>
				) : (
					<>
						{copyBtn}
						{body}
						{text.truncated && <div className="trunc-note">{t("truncated")}</div>}
					</>
				)}
			</div>
		);
	}

	const thinking = asThinking(block);
	if (thinking) {
		return (
			<ThinkingBlock
				thinking={thinking.thinking}
				streaming={streaming && isLast}
				wrap={thinkingWrap}
				forceOpen={searchActive || forceThinking}
			/>
		);
	}

	const toolCall = asToolCall(block);
	if (toolCall) {
		const result = toolResults.get(toolCall.id);
		const live = liveOutputs.get(toolCall.id);
		const view: ToolView = {
			result,
			liveOutput: live?.text,
			streaming,
			status: toolStatuses.get(toolCall.id),
		};
		return (
			<ToolCallBlock
				block={toolCall}
				view={view}
				onKillBash={onKillBash}
				wrap={toolsWrap}
				showImages={toolImages ?? true}
				forceOpen={searchActive || forceTools}
				uiContextToolCall={uiContextToolCall}
				onUiAction={onUiAction}
			/>
		);
	}

	const image = asImage(block);
	if (image && image.dataUrl) {
		const src = image.dataUrl.startsWith("/") ? appUrl(image.dataUrl) : image.dataUrl;
		return (
			<div className="msg-image">
				<img src={src} loading="lazy" decoding="async" alt="attachment" />
			</div>
		);
	}

	const bash = asBash(block);
	if (bash) {
		return (
			<div className="bashblock">
				<div className="bashblock-command">
					<span className="bashblock-prompt">$</span>
					<code>{renderHighlightedCommand(bash.command)}</code>
					{bash.exitCode !== undefined && (
						<span className={`bashblock-exit ${bash.exitCode === 0 ? "ok" : "err"}`}>
							{t("exitCode", { code: bash.exitCode })}
						</span>
					)}
					{bash.cancelled && <span className="bashblock-exit err">{t("cancelled")}</span>}
				</div>
				{bash.output && <pre className="bashblock-output">{bash.output}</pre>}
				{bash.truncated && <div className="trunc-note">{t("outputTruncated")}</div>}
			</div>
		);
	}

	return null;
}

export function roleLabel(role: string, t: Translate): string {
	switch (role) {
		case "user":
			return t("role.user");
		case "assistant":
			return t("role.assistant");
		case "toolResult":
			return t("role.tool");
		case "bashExecution":
			return t("role.bash");
		case "branchSummary":
			return t("role.branch");
		case "compactionSummary":
			return t("role.compaction");
		default:
			return role;
	}
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}
