import { memo, useRef, useState, type ReactNode } from "react";
import {
	FiArchive,
	FiBookOpen,
	FiCheckCircle,
	FiChevronDown,
	FiChevronRight,
	FiChevronUp,
	FiCode,
	FiCopy,
	FiEdit3,
	FiFileText,
	FiImage,
	FiRefreshCw,
	FiX,
	FiZap,
} from "react-icons/fi";
import type {
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
import { Markdown, PluginWidgetBlock } from "./Markdown";
import { StreamMarkdown } from "./StreamMarkdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallBlock, type ToolView } from "./ToolCallBlock";
import { useT, type Translate } from "../i18n";
import { parseSkillBlock, type SkillBlock } from "../skill-block";
import { isRasterImage, fileToProcessedImage } from "../image-paste";
import { openContextMenu } from "../context-menu-state";
import { messageMarkdown, messagePlainText } from "../copy-text";
import { openExportImage, toggleExportImageSelect, useExportImage } from "../export-image-state";
import { hasMessageWidget } from "../plugin-fence";
import type { UiSlotEntry } from "../ui-slots";

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
	text: <FiFileText />,
	markdown: <FiCode />,
	image: <FiImage />,
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
	const pushEditNotice = (msg: string) => {
		setEditNotice(msg);
		window.setTimeout(() => setEditNotice((cur) => (cur === msg ? null : cur)), 4000);
	};
	// toolResult content is rendered inside its toolCall card — never standalone
	// (otherwise the same output shows twice: formatted card + plain text).
	if (message.role === "toolResult") return null;
	// Compaction summaries get a distinct collapsible card (the CLI's
	// CompactionSummaryMessageComponent counterpart): a long summary dumped as
	// a plain bubble buries what the compaction actually produced.
	if (message.role === "compactionSummary") {
		return <CompactionCard message={message} forceOpen={searchActive} autoExpand={autoExpand} />;
	}
	// Attached files are rendered as their own collapsible card, separate from
	// the user message text.
	const isFileAttachment = message.role === "custom" && message.customType === "file";
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

	const canEdit = message.role === "user" && !streaming && !isEmptyStreaming && !!onEdit;
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
		if (!text) return;
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
			if (id === "host:msg-copy-text") await navigator.clipboard.writeText(messagePlainText(message.content));
			else if (id === "host:msg-copy-markdown") await navigator.clipboard.writeText(wholeMarkdown);
			else {
				openExportImage(message.id);
				return;
			}
			window.clearTimeout(copyTimer.current);
			setCopyState({ id, ok: true });
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

	/** 该槽位当前有没有可显示的东西：一条都没有就别抢浏览器菜单
	 *  （弹个空菜单比不弹更糟，还会顺手废掉「检查元素 / 复制」）。
	 *  判定与 contextMenuItems 同口径：hidden 跳过、divider 不算内容。 */
	const ctxMenuAvailable = (uiContextMessage ?? []).some((e) => e && e.hidden !== true && e.kind !== "divider");

	/**
	 * 右键消息 → 宿主的通用右键菜单（ContextMenu 实例由 App 渲染，这里只发请求）。
	 *
	 * 「不打扰」的三种取舍（一律交回浏览器默认菜单）：
	 *  1. 点在 `pre` / `code` / `a` / `input` / `textarea` / contenteditable 上 —— 代码要复制、
	 *     链接要「在新标签打开 / 另存」、输入框要系统菜单（拼写检查、粘贴），抢了是净损失。
	 *  2. 页面里已有选中的文本 —— 用户正在选字准备复制，此时右键的意图是复制/搜索。
	 *  3. 该槽位没有可用条目 —— 没有菜单可给，就别 preventDefault 了。
	 * 其余情况一律 preventDefault：消息级操作菜单是宿主给的，不该再冒出第二个菜单。
	 */
	const onMsgContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
		if (!ctxMenuAvailable) return;
		const el = e.target;
		if (el instanceof Element && el.closest("pre, code, a, input, textarea, [contenteditable='true']")) return;
		const sel = window.getSelection?.();
		if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;
		e.preventDefault();
		openContextMenu({
			x: e.clientX,
			y: e.clientY,
			slot: "contextmenu.message",
			target: { id: message.id, kind: "message", label: ctxLabel },
			entries: uiContextMessage ?? [],
		});
	};

	/**
	 * 消息 hover 工具条（`message.actions` 槽位）。
	 *  - 宿主没传 entries：回落到内置硬编码的「编辑重问」（App 未接线时行为不变）。
	 *  - 传了 entries（哪怕空数组）：完全数据驱动 —— 顺序 = 数组顺序（宿主已排好）、
	 *    `hidden === true` 跳过、内置条目走本组件的内置处理、其余条目点击交回 onUiAction。
	 *  - 一条可渲染的都没有 → 整个 `.msg-actions` 容器都不画（不留空壳）。
	 *  - 分隔线按传入位置照画（宿主已排好；这里不替它做「首尾去线」的优化）。
	 */
	/** 整条复制三件套的工具条按钮（数据驱动与无宿主回落共用）。 */
	const wholeCopyNodes = (keyPrefix: string): ReactNode[] => {
		if (!canCopyWhole) return [];
		const defs = [
			{ id: "host:msg-copy-text", label: t("copyText"), icon: "text" },
			{ id: "host:msg-copy-markdown", label: t("copyMarkdown"), icon: "markdown" },
			{ id: "host:msg-copy-image", label: t("copyImage"), icon: "image" },
		] as const;
		return defs.map((d) => {
			const active = copyState?.id === d.id;
			const ok = active && copyState.ok;
			return (
				<button
					key={`${keyPrefix}${d.id}`}
					type="button"
					className="msg-action"
					title={ok ? t("copied") : active ? t("copyFailed") : d.label}
					aria-label={d.label}
					onClick={() => void doWholeCopy(d.id)}
				>
					{ok ? <FiCheckCircle /> : slotIcon(d.icon)} {d.label}
				</button>
			);
		});
	};
	const renderMessageActions = () => {
		if (!uiMessageActions) {
			const fallback = wholeCopyNodes("fb:");
			if (!canEdit && fallback.length === 0) return null;
			return (
				<div className="msg-actions">
					{canEdit && (
						<button type="button" className="msg-action" title={t("editReaskTip")} onClick={startEdit}>
							<FiEdit3 /> {t("editReask")}
						</button>
					)}
					{fallback}
				</div>
			);
		}
		const nodes: ReactNode[] = [];
		uiMessageActions.forEach((entry, i) => {
			if (!entry || entry.hidden === true) return;
			// 复制键的真实落点是文本块上的 .msg-text-copy（见 copyAllowed），工具条里跳过它。
			if (entry.id === "host:msg-copy") return;
			const key = `${entry.id}#${i}`;
			const label = entry.label || entry.id;
			// 整条一键复制三件套（issue #228）：内置处理，不交回插件。
			if (
				entry.id === "host:msg-copy-text" ||
				entry.id === "host:msg-copy-markdown" ||
				entry.id === "host:msg-copy-image"
			) {
				if (!canCopyWhole) return;
				const active = copyState?.id === entry.id;
				const ok = active && copyState.ok;
				nodes.push(
					<button
						key={key}
						type="button"
						className="msg-action"
						title={ok ? t("copied") : active ? t("copyFailed") : label}
						aria-label={label}
						onClick={() => void doWholeCopy(entry.id)}
					>
						{ok ? <FiCheckCircle /> : slotIcon(entry.icon)} {label}
					</button>,
				);
				return;
			}
			// 内置「编辑重问」：只对用户消息、且不在流式/编辑态时出现（与旧逻辑同判据）。
			if (entry.id === "host:msg-edit-reask") {
				if (!canEdit) return;
				nodes.push(
					<button key={key} type="button" className="msg-action" title={t("editReaskTip")} onClick={startEdit}>
						{slotIcon(entry.icon)} {label}
					</button>,
				);
				return;
			}
			if (entry.kind === "divider") {
				nodes.push(<span key={key} className="msg-action-divider" aria-hidden="true" />);
				return;
			}
			if (entry.kind === "badge") {
				// badge = 只读文本/角标，不可点（与右键菜单里的 badge 同语义）。
				nodes.push(
					<span key={key} className="msg-action-badge" title={label}>
						{entry.badge ?? label}
					</span>,
				);
				return;
			}
			// 其余（action / view / menu / page / organizer）一律画成按钮：工具条只有一行，
			// 不做二级菜单 —— 带 children 的 menu 条目也整条交回宿主，由宿主自己展开。
			// kind="select" 落成小下拉（切换回插件，附带选中的 value）。
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
					{slotIcon(entry.icon)} {label}
					{entry.badge ? <span className="msg-action-count">{entry.badge}</span> : null}
				</button>,
			);
		});
		if (nodes.length === 0) return null;
		return <div className="msg-actions">{nodes}</div>;
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

	return (
		<div
			ref={cardRef}
			className={`msg msg-${message.role}${isGoalReview ? " msg-goal-review" : ""}${exportSelected ? " msg-export-selected" : ""}`}
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
								disabled={!draft.trim()}
								title={t("reaskFromHere")}
								onClick={submitEdit}
							>
								<FiEdit3 /> {t("reaskFromHere")}
							</button>
						</div>
					</div>
				) : (
					<>
						{message.errorMessage && (
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
						)}
						{isFileAttachment ? (
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
			{!editing && renderMessageActions()}
		</div>
	);
});

/** Collapsible card for an attached file (customType "file"). */
function AttachmentCard({ message, forceOpen = false }: { message: UiMessage; forceOpen?: boolean }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState(false);
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
			<div
				className="chead attachcard-head"
				role="button"
				tabIndex={0}
				aria-expanded={shown}
				title={shown ? t("collapseMsg") : t("expandMsg")}
				onClick={() => setOpen((v) => (forceOpen ? true : !v))}
				onKeyDown={(e) => {
					if (e.target !== e.currentTarget) return;
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						setOpen((v) => (forceOpen ? true : !v));
					}
				}}
			>
				{!isReference && !isPage && !isConversation && (
					<span className="chead-toggle">{shown ? <FiChevronDown /> : <FiChevronRight />}</span>
				)}
				<span className="chead-icon attachcard-icon">
					{isFolder ? "📁" : isPage ? "🌐" : isConversation ? "💬" : "📎"}
				</span>
				<span className="chead-title attachcard-name">{name}</span>
				{details.path &&
					(isPage ? (
						<a className="attachcard-path attachcard-link" href={details.path} target="_blank" rel="noreferrer">
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
							void navigator.clipboard.writeText(clean);
							setCopied(true);
							window.setTimeout(() => setCopied(false), 1200);
						}}
					>
						{copied ? <FiCheckCircle /> : <FiCopy />}
					</button>
				)}
			</div>
			{!isReference &&
				shown &&
				(isBridged ? (
					<>
						<div className="attachcard-bridgenote">{t("bridgedVisionDetail")}</div>
						{image?.dataUrl && (
							<div className="attachcard-image">
								<img src={image.dataUrl} alt={name} />
							</div>
						)}
						{clean && <pre className="attachcard-content">{clean}</pre>}
					</>
				) : image?.dataUrl ? (
					<div className="attachcard-image">
						<img src={image.dataUrl} alt={name} />
					</div>
				) : (
					<pre className="attachcard-content">{clean}</pre>
				))}
			{isReference && (
				<div className="attachcard-refnote">
					{isFolder ? t("folderNotExpanded") : t("fileNotExpanded", { size: formatSize(details.size) })}
				</div>
			)}
		</div>
	);
}

function formatSize(bytes?: number): string {
	if (bytes === undefined) return "";
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
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
	const [copied, setCopied] = useState(false);
	// 新摘要到达自动展开一次：render 期间同步（仅上升沿开一次是受支持的
	// React 模式），之后用户手动收起不再打扰。
	const [prevAuto, setPrevAuto] = useState(autoExpand);
	if (autoExpand !== prevAuto) {
		setPrevAuto(autoExpand);
		if (autoExpand) setExpanded(true);
	}
	const shown = expanded || forceOpen;
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
				<div
					className="chead compaction-head"
					role="button"
					tabIndex={0}
					aria-expanded={shown}
					title={shown ? t("collapseMsg") : t("expandMsg")}
					onClick={() => setExpanded((v) => (forceOpen ? true : !v))}
					onKeyDown={(e) => {
						if (e.target !== e.currentTarget) return;
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							setExpanded((v) => (forceOpen ? true : !v));
						}
					}}
				>
					<span className="chead-toggle">{shown ? <FiChevronDown /> : <FiChevronRight />}</span>
					<span className="chead-icon compaction-icon">
						<FiArchive />
					</span>
					<span className="chead-title compaction-title">
						{tokens ? t("compactionFrom", { tokens }) : t("role.compaction")}
					</span>
					{text && (
						<button
							type="button"
							className="chead-copy"
							title={copied ? t("copied") : t("copyMessage")}
							aria-label={t("copyMessage")}
							onClick={(e) => {
								e.stopPropagation();
								void navigator.clipboard.writeText(text);
								setCopied(true);
								window.setTimeout(() => setCopied(false), 1200);
							}}
						>
							{copied ? <FiCheckCircle /> : <FiCopy />}
						</button>
					)}
				</div>
				{shown && (
					<div className="compaction-body">
						<Markdown text={text} />
						<div className="compaction-hint">{t("compactionKeptHint")}</div>
					</div>
				)}
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
	const [copied, setCopied] = useState(false);
	const shown = expanded || forceOpen;
	return (
		<div className={`skillcard${expanded ? " expanded" : ""}`}>
			<div
				className="chead skillcard-head"
				role="button"
				tabIndex={0}
				aria-expanded={shown}
				title={block.location}
				onClick={() => setExpanded((v) => (forceOpen ? true : !v))}
				onKeyDown={(e) => {
					if (e.target !== e.currentTarget) return;
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						setExpanded((v) => (forceOpen ? true : !v));
					}
				}}
			>
				<span className="chead-toggle">{shown ? <FiChevronDown /> : <FiChevronRight />}</span>
				<span className="chead-icon skillcard-icon">
					<FiBookOpen />
				</span>
				<span className="chead-title skillcard-name">{block.name}</span>
				<span className="skillcard-path">{block.location}</span>
				<button
					type="button"
					className="chead-copy"
					title={copied ? t("copied") : t("copyMessage")}
					aria-label={t("copyMessage")}
					onClick={(e) => {
						e.stopPropagation();
						void navigator.clipboard.writeText(block.content);
						setCopied(true);
						window.setTimeout(() => setCopied(false), 1200);
					}}
				>
					{copied ? <FiCheckCircle /> : <FiCopy />}
				</button>
			</div>
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
	const [copied, setCopied] = useState(false);
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
		return (
			<div className={`msg-text${oneLiner ? " single" : ""}`}>
				{oneLiner ? (
					<div className="msg-text-main">{body}</div>
				) : (
					<>
						{body}
						{text.truncated && <div className="trunc-note">{t("truncated")}</div>}
					</>
				)}
				{copyable ? (
					<button
						type="button"
						className="msg-text-copy"
						title={copied ? t("copied") : t("copyMessage")}
						aria-label={t("copyMessage")}
						onClick={() => {
							void navigator.clipboard.writeText(text.text);
							setCopied(true);
							window.setTimeout(() => setCopied(false), 1200);
						}}
					>
						{copied ? <FiCheckCircle /> : <FiCopy />}
					</button>
				) : null}
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
		return (
			<div className="msg-image">
				<img src={image.dataUrl} alt="attachment" />
			</div>
		);
	}

	const bash = asBash(block);
	if (bash) {
		return (
			<div className="bashblock">
				<div className="bashblock-command">
					<span className="bashblock-prompt">$</span>
					<code>{bash.command}</code>
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
