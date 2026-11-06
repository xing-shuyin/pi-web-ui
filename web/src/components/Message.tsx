import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
	FiEye,
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
import { appResourceCrossOrigin, appResourceUrl } from "../base-url";
import type { EditPromptAttachment } from "../question-attachments";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallBlock, type ToolView } from "./ToolCallBlock";
import { useT, type Translate } from "../i18n";
import { buildSessionDeepLink, parseSessionHash } from "../session-url";
import { fetchCompactedHistory, useCompactedHistory } from "../compacted-history-state";
import { parseSkillBlock, type SkillBlock } from "../skill-block";
import { isRasterImage, fileToProcessedImage } from "../image-paste";
import { contextMenuItems, openContextMenu } from "../context-menu-state";
import { openImageLightbox } from "../image-lightbox-bridge";
import { openFilePreview } from "../file-preview-bridge";
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
import { MessageActionButton } from "./MessageActionTooltip";
import { createPortal } from "react-dom";
import { useFloatingPanel } from "../use-floating-panel";
import { BUILTIN_UI_ITEMS, type UiSlotEntry } from "../ui-slots";
import { appSend, useAppField } from "../app-globals";
import { isAbortedTurn } from "../aborted-turn";

const INLINE_MARKER_TOKEN_RE = /\[\[\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*([A-Za-z][A-Za-z0-9_-]*)\s*:(.*?)\s*\]\]/g;
const BUILTIN_INLINE_MARKER_TOOLS: ReadonlySet<string> = new Set([
	"todo",
	"notify",
	"conv",
	"rename",
	"title",
	"action",
	"suggest",
]);
const KNOWN_INLINE_MARKER_TOOLS = new Set<string>(BUILTIN_INLINE_MARKER_TOOLS);

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTrailingIncompleteRegex(tools: Set<string>): RegExp {
	const pattern = [...tools].map(escapeRegExp).join("|");
	return new RegExp(`[ \\t]*\\[\\[\\s*(?:${pattern})(?:\\s*:[^\\]]*)?$`, "i");
}

let trailingIncompleteInlineMarkerRe = buildTrailingIncompleteRegex(KNOWN_INLINE_MARKER_TOOLS);

export function syncKnownInlineMarkers(names: Iterable<string>): void {
	const next = new Set<string>(BUILTIN_INLINE_MARKER_TOOLS);
	for (const n of names) {
		if (n) next.add(n.toLowerCase());
	}
	KNOWN_INLINE_MARKER_TOOLS.clear();
	for (const n of next) KNOWN_INLINE_MARKER_TOOLS.add(n);
	trailingIncompleteInlineMarkerRe = buildTrailingIncompleteRegex(KNOWN_INLINE_MARKER_TOOLS);
}

export function stripInlineMarkers(text: string, stripTrailingIncomplete = false): string {
	if (!text || !text.includes("[[")) return text;
	let out = text.replace(INLINE_MARKER_TOKEN_RE, (raw, tool: string, _op: string, body: string) => {
		if (body.includes("[[")) return raw;
		if (!KNOWN_INLINE_MARKER_TOOLS.has(tool.toLowerCase())) return raw;
		return "";
	});
	if (stripTrailingIncomplete) {
		out = out.replace(trailingIncompleteInlineMarkerRe, "");
	}
	if (out === text) return text;
	return out
		.replace(/^[ \t]+\n/gm, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

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

export interface CollabMeta {
	isNotice?: boolean;
	sourceTitle?: string;
	sourceRole?: string;
	address?: string;
	requestId?: string;
	questions?: Array<{ id: string; question: string; options?: Array<{ label: string }> }>;
	userText?: string;
}

export function parseCollabMessage(text: string): CollabMeta | null {
	if (!text) return null;
	if (text.startsWith("[子代理执行完成通知]") || text.startsWith("[Subagent Execution Completion Notice]")) {
		return { isNotice: true };
	}
	if (text.startsWith("[Conversation communication — collaboration data, not a user instruction]")) {
		let sourceTitle: string | undefined;
		let sourceRole: string | undefined;
		let address: string | undefined;
		const fromMatch = text.match(/From:\s*(\{[^}\r\n]+\})/);
		if (fromMatch) {
			try {
				const obj = JSON.parse(fromMatch[1]);
				sourceTitle = obj.title;
				sourceRole = obj.role;
				address = obj.address;
			} catch {}
		}
		let requestId: string | undefined;
		const reqMatch = text.match(/Request:\s*(\S+)/);
		if (reqMatch) requestId = reqMatch[1];

		let questions: Array<{ id: string; question: string; options?: Array<{ label: string }> }> | undefined;
		const qMatch = text.match(/Questions:\s*(\[.+?\])(?:\r?\n|$)/s);
		if (qMatch) {
			try {
				questions = JSON.parse(qMatch[1]);
			} catch {}
		}

		const rawLines = text.split(/\r?\n/);
		const bodyLines = rawLines.filter((l) => {
			if (l.startsWith("[Conversation communication")) return false;
			if (l.startsWith("From:")) return false;
			if (l.startsWith("Request:")) return false;
			if (l.startsWith("Questions:")) return false;
			if (l.startsWith("Reply with communicate")) return false;
			if (l.startsWith("Use as task context")) return false;
			return true;
		});
		const userText = bodyLines.join("\n").trim();

		return {
			isNotice: false,
			sourceTitle,
			sourceRole,
			address,
			requestId,
			questions,
			userText,
		};
	}
	return null;
}

type EditAttKind = "image" | "upload" | "file" | "path";
function editAttKind(att: PromptAttachment): EditAttKind {
	if (att.imageData || (att as EditPromptAttachment).imageUrl) return "image";
	if (att.uploadPath) return "upload";
	if (att.fileData) return "file";
	return "path";
}

function editAttLabel(att: PromptAttachment, t: Translate): string {
	if (att.mode === "quote" && att.quote) return att.quote.text;
	if (att.imageData || (att as EditPromptAttachment).imageUrl) return t("attachImage", { name: att.name ?? "image" });
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

export function slotIcon(icon?: string): ReactNode {
	const s = (icon ?? "").trim();
	if (!s) return <FiZap />;
	const known = SLOT_ICONS[s.toLowerCase()];
	if (known) return known;
	if (!/[\p{L}\p{N}]/u.test(s) && s.length <= 4) return <span className="msg-action-glyph">{s}</span>;
	return <FiZap />;
}

function truncateText(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

interface MessageProps {
	message: UiMessage;
	toolResults: ReadonlyMap<string, UiMessage>;
	liveOutputs: ReadonlyMap<string, { toolName: string; text: string }>;
	toolStatuses: ReadonlyMap<string, ToolStatus>;
	streaming: boolean;
	isLast: boolean;
	onEdit?: (messageId: string, text: string, attachments?: PromptAttachment[]) => void;
	questionAttachments?: PromptAttachment[];
	messageLabel?: string;
	onRollbackEdit?: (messageId: string) => void;
	canRollbackEdit?: boolean;
	editRequest?: object;
	onKillBash?: () => void;
	onRetry?: () => void;
	onCollapse?: (messageId: string) => void;

	qnIndex?: number;
	qnActive?: boolean;
	onJump?: (messageId: string) => void;
	thinkingWrap?: boolean;
	toolsWrap?: boolean;
	toolImages?: boolean;
	searchActive?: boolean;
	autoExpand?: boolean;

	uiMessageActions?: UiSlotEntry[];
	uiContextMessage?: UiSlotEntry[];
	uiContextToolCall?: UiSlotEntry[];
	uiToolCardFooter?: UiSlotEntry[];
	onUiAction?: (item: UiSlotEntry, value?: string) => void;
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
	messageLabel,
	onRollbackEdit,
	canRollbackEdit = false,
	editRequest,

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
	uiToolCardFooter,
	onUiAction,
	readOnly = false,
}: MessageProps) {
	const t = useT();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const [editAttachments, setEditAttachments] = useState<PromptAttachment[]>([]);
	const [editDragOver, setEditDragOver] = useState(false);
	const chatUploadMaxMb = useAppField("chatUploadMaxMb");
	const engine = useAppField("engine");
	const editReadId = useRef(0);
	const [editReads, setEditReads] = useState<{ id: number; name: string; percent: number | null }[]>([]);
	const finishEditRead = (id: number) => setEditReads((prev) => prev.filter((read) => read.id !== id));
	const [editNotice, setEditNotice] = useState<string | null>(null);
	const editNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
	if (message.role === "toolResult") return null;
	if (message.role === "system") return null;
	if (message.role === "compactionSummary") {
		return <CompactionCard message={message} forceOpen={searchActive} autoExpand={autoExpand} />;
	}
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
	const queuedAtts = (
		message.details as
			| {
					attachments?: {
						type: string;
						name: string;
						path?: string;
						url?: string;
						lines?: { start: number; end: number };
					}[];
			  }
			| undefined
	)?.attachments;
	const messageAttachments =
		message.role === "user" && Array.isArray(queuedAtts)
			? queuedAtts.filter((a) => a.type !== "image" || !message.content.some((b) => b.type === "image"))
			: [];
	const userText = message.content
		.map((b) => asText(b)?.text ?? "")
		.filter(Boolean)
		.join("\n");
	const skillBlock = message.role === "user" ? parseSkillBlock(userText) : null;
	const questionText = skillBlock
		? (skillBlock.userMessage ?? `skill:${skillBlock.name}`)
		: userText.split("\n").join(" ").trim();
	const isEmptyStreaming = streaming && isLast && message.role === "assistant" && message.content.length === 0;

	const canEdit = !readOnly && message.role === "user" && !streaming && !isEmptyStreaming && !!onEdit;
	const canDelete =
		!readOnly && engine === "pi" && !streaming && !editing && (message.role === "user" || message.role === "assistant");
	const deleteMessage = () => {
		if (canDelete) appSend({ type: "delete_message", messageId: message.id });
	};
	const addEditImageFiles = async (files: File[]) => {
		const added: PromptAttachment[] = [];
		for (const f of files) {
			if (!isRasterImage(f.type)) continue;
			if (f.size > chatUploadMaxMb * 1024 * 1024) {
				pushEditNotice(t("fileTooLarge", { name: f.name, size: chatUploadMaxMb }));
				continue;
			}
			const id = ++editReadId.current;
			setEditReads((prev) => [...prev, { id, name: f.name, percent: null }]);
			try {
				const img = await fileToProcessedImage(f);
				if (!img) {
					pushEditNotice(t("fileLoadFailed", { name: f.name }));
					continue;
				}
				added.push({
					path: "",
					imageData: img.data,
					mimeType: img.mimeType,
					name: img.name,
				});
			} catch {
				pushEditNotice(t("fileLoadFailed", { name: f.name }));
			} finally {
				finishEditRead(id);
			}
		}
		if (added.length > 0) setEditAttachments((prev) => [...prev, ...added]);
	};
	const addEditFile = async (f: File) => {
		if (f.size > chatUploadMaxMb * 1024 * 1024) {
			pushEditNotice(t("fileTooLarge", { name: f.name, size: chatUploadMaxMb }));
			return;
		}
		const id = ++editReadId.current;
		setEditReads((prev) => [...prev, { id, name: f.name, percent: 0 }]);
		let base64: string;
		try {
			const dataUrl = await new Promise<string>((res, rej) => {
				const r = new FileReader();
				r.onload = () => res(r.result as string);
				r.onerror = () => rej(r.error ?? new Error("read failed"));
				r.onabort = () => rej(new Error("read aborted"));
				r.onprogress = (event) => {
					const percent =
						event.lengthComputable && event.total > 0
							? Math.min(100, Math.round((event.loaded / event.total) * 100))
							: null;
					setEditReads((prev) => prev.map((read) => (read.id === id ? { ...read, percent } : read)));
				};
				r.readAsDataURL(f);
			});
			base64 = dataUrl.replace(/^data:[^;]*;base64,/, "");
		} catch {
			pushEditNotice(t("fileLoadFailed", { name: f.name }));
			return;
		} finally {
			finishEditRead(id);
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
	const addEditDropFiles = async (files: File[]) => {
		const imgs: File[] = [];
		for (const f of files) {
			if (isRasterImage(f.type)) imgs.push(f);
			else void addEditFile(f);
		}
		if (imgs.length > 0) await addEditImageFiles(imgs);
	};
	const [resending, setResending] = useState(false);
	const resendPending = useRef(false);
	const resend = async (text: string, attachments: EditPromptAttachment[]) => {
		if (resendPending.current) return;
		if (!attachments.some((att) => att.imageUrl)) {
			onEdit?.(message.id, text, attachments.length ? attachments : undefined);
			setEditing(false);
			return;
		}
		resendPending.current = true;
		setResending(true);
		try {
			const restored = await Promise.all(
				attachments.map(async ({ imageUrl, ...att }) => {
					if (!imageUrl) return att;
					const response = await fetch(appResourceUrl(imageUrl));
					if (!response.ok) throw new Error(`Image load failed: ${response.status}`);
					const blob = await response.blob();
					const dataUrl = await new Promise<string>((resolve, reject) => {
						const reader = new FileReader();
						reader.onload = () => resolve(String(reader.result));
						reader.onerror = () => reject(reader.error);
						reader.readAsDataURL(blob);
					});
					return { ...att, imageData: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: blob.type || att.mimeType };
				}),
			);
			onEdit?.(message.id, text, restored.length ? restored : undefined);
			setEditing(false);
		} catch {
			setEditing(true);
			pushEditNotice(t("fileLoadFailed", { name: attachments.find((att) => att.imageUrl)?.name ?? "image" }));
		} finally {
			resendPending.current = false;
			setResending(false);
		}
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
		setDraft(trimmed);
		setEditAttachments(questionAttachments ?? []);
		void resend(trimmed, questionAttachments ?? []);
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
	useEffect(() => {
		if (editRequest && canEdit) startEdit();
	}, [editRequest]);
	const rollbackEdit = () => {
		if (canEdit) startEdit();
		else onRollbackEdit?.(message.id);
	};
	const canRollback = !readOnly && !streaming && !editing && (canEdit || canRollbackEdit);
	const submitEdit = () => {
		const text = draft.trim();
		if (!text && !editAttachments.some((a) => a.mode === "quote" && readTextQuote(a.quote))) return;
		void resend(text, editAttachments);
	};

	const copyAllowed = uiMessageActions
		? uiMessageActions.some((e) => e?.id === "host:msg-copy" && e.hidden !== true)
		: true;

	const cardRef = useRef<HTMLDivElement>(null);
	const [copyState, setCopyState] = useState<{ id: string; ok: boolean } | null>(null);
	const exportImage = useExportImage();
	const copyTimer = useRef(0);
	const wholeMarkdown = messageMarkdown(message.content);
	const canCopyWhole = (message.role === "assistant" || message.role === "user") && wholeMarkdown.length > 0;
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

	const ctxLabel = truncateText(messagePlainText(message.content), 40) || roleLabel(message.role, t);

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
		speak(
			stripMarkdownForSpeech(messagePlainText(message.content), 5000),
			{ ...loadTtsSettings(), enabled: true },
			message.id,
		);
	};
	const [copyDropdownOpen, setCopyDropdownOpen] = useState(false);
	const copyGroupRef = useRef<HTMLDivElement>(null);

	const copyPanel = useFloatingPanel({
		open: copyDropdownOpen,
		anchor: copyGroupRef,
		onClose: () => setCopyDropdownOpen(false),
	});

	const speakNode = (key: string): ReactNode =>
		canSpeak ? (
			<MessageActionButton
				key={key}
				type="button"
				className={`msg-action${speakActive ? " msg-action-speaking" : ""}`}
				title={speakActive ? t("stopSpeakingMsg") : t("speakMsg")}
				aria-label={speakActive ? t("stopSpeakingMsg") : t("speakMsg")}
				onClick={toggleSpeak}
			>
				{speakActive ? <FiSquare /> : <FiVolume2 />}{" "}
				<span className="msg-action-label">{speakActive ? t("stopSpeakingMsg") : t("speakMsg")}</span>
			</MessageActionButton>
		) : null;

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

	const onMsgContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
		const el = e.target;
		if (el instanceof Element && el.closest("a, input, textarea, [contenteditable='true']")) return;
		const sel = window.getSelection?.();
		if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;

		const rawEntries: UiSlotEntry[] =
			uiContextMessage && uiContextMessage.length > 0 ? uiContextMessage : msgCtxFallback();

		const entries = rawEntries.map((entry) => {
			if (entry.source !== "host") return readOnly ? { ...entry, hidden: true } : entry;
			switch (entry.id) {
				case "host:msg-ctx-copy-markdown":
				case "host:msg-ctx-copy-text":
					return canCopyWhole ? entry : { ...entry, hidden: true };
				case "host:msg-ctx-copy-image":
					return canCopyWhole ? entry : { ...entry, hidden: true };
				case "host:msg-ctx-copy-link": {
					const sid = parseSessionHash(window.location.hash)?.sessionId;
					return !readOnly && !streaming && Boolean(sid && message.id) ? entry : { ...entry, hidden: true };
				}
				case "host:msg-ctx-reask":
				case "host:msg-ctx-edit-reask":
					return canEdit ? entry : { ...entry, hidden: true };
				case "host:msg-ctx-rollback":
					return canRollback ? entry : { ...entry, hidden: true };
				case "host:msg-ctx-fork":
					return !readOnly && !streaming && !editing ? entry : { ...entry, hidden: true };
				case "host:msg-ctx-delete":
					return canDelete ? entry : { ...entry, hidden: true };
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
						appSend({ type: "fork_session", messageId: message.id, position: "at" });
						return undefined;
					case "host:msg-ctx-rollback":
						rollbackEdit();
						return undefined;
					case "host:msg-ctx-delete":
						deleteMessage();
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
				<MessageActionButton
					type="button"
					className={`msg-action msg-copy-main-btn${ok ? " msg-copy-success" : ""}`}
					title={ok ? t("copied") : isFailed ? t("copyFailed") : t("copyMarkdown")}
					aria-label={t("copyMarkdown")}
					onClick={() => void doWholeCopy("host:msg-copy-markdown")}
				>
					{ok ? <FiCheckCircle /> : <FiCopy />}
					<span className="msg-action-label">{ok ? t("copied") : t("copy")}</span>
				</MessageActionButton>
				<MessageActionButton
					type="button"
					className={`msg-action msg-copy-caret-btn${copyDropdownOpen ? " active" : ""}`}
					title={t("moreCopyOptions")}
					aria-label={t("moreCopyOptions")}
					aria-expanded={copyDropdownOpen}
					onClick={(e) => {
						e.stopPropagation();
						setCopyDropdownOpen((prev) => !prev);
					}}
				>
					<FiChevronDown className={`msg-copy-caret-icon${copyDropdownOpen ? " open" : ""}`} />
				</MessageActionButton>
				{copyDropdownOpen &&
					createPortal(
						<div ref={copyPanel.panelRef} style={copyPanel.style} className="msg-copy-dropdown" role="menu">
							{activeItems.map((item) => (
								<MessageActionButton
									key={item.id}
									type="button"
									className="msg-copy-menu-item"
									title={item.label}
									role="menuitem"
									onClick={() => {
										setCopyDropdownOpen(false);
										void doWholeCopy(item.id);
									}}
								>
									{item.icon}
									<span>{item.label}</span>
								</MessageActionButton>
							))}
						</div>,
						document.body,
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
						<MessageActionButton
							type="button"
							className="msg-action"
							title={t("reaskDirectlyTip")}
							aria-label={t("reaskDirectly")}
							onClick={directReask}
						>
							<FiRefreshCw /> <span className="msg-action-label">{t("reaskDirectly")}</span>
						</MessageActionButton>
						<MessageActionButton
							type="button"
							className="msg-action"
							title={t("editReaskTip")}
							aria-label={t("editReask")}
							onClick={startEdit}
						>
							<FiEdit3 /> <span className="msg-action-label">{t("editReask")}</span>
						</MessageActionButton>
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
			if (entry.id === "host:msg-delete") {
				if (!canDelete) return;
				nodes.push(
					<MessageActionButton
						key={key}
						type="button"
						className="msg-action"
						title={label}
						aria-label={label}
						onClick={deleteMessage}
					>
						{slotIcon(entry.icon)} <span className="msg-action-label">{label}</span>
					</MessageActionButton>,
				);
				return;
			}
			if (entry.id === "host:msg-reask") {
				if (!canEdit) return;
				nodes.push(
					<MessageActionButton
						key={key}
						type="button"
						className="msg-action"
						title={t("reaskDirectlyTip")}
						aria-label={label}
						onClick={directReask}
					>
						{slotIcon(entry.icon)} <span className="msg-action-label">{label}</span>
					</MessageActionButton>,
				);
				return;
			}
			if (entry.id === "host:msg-edit-reask") {
				if (!canEdit) return;
				nodes.push(
					<MessageActionButton
						key={key}
						type="button"
						className="msg-action"
						title={t("editReaskTip")}
						onClick={startEdit}
					>
						{slotIcon(entry.icon)} <span className="msg-action-label">{label}</span>
					</MessageActionButton>,
				);
				return;
			}
			if (entry.id === "host:msg-fork") {
				if (readOnly || streaming || editing) return;
				nodes.push(
					<MessageActionButton
						key={key}
						type="button"
						className="msg-action"
						title={t("forkSessionTip")}
						aria-label={label}
						onClick={() => appSend({ type: "fork_session", messageId: message.id, position: "at" })}
					>
						{slotIcon(entry.icon)} <span className="msg-action-label">{label}</span>
					</MessageActionButton>,
				);
				return;
			}
			if (entry.id === "host:msg-rollback") {
				if (!canRollback) return;
				nodes.push(
					<MessageActionButton
						key={key}
						type="button"
						className="msg-action"
						title={t("rollbackSessionTip")}
						aria-label={label}
						onClick={() => {
							rollbackEdit();
						}}
					>
						{slotIcon(entry.icon)} <span className="msg-action-label">{label}</span>
					</MessageActionButton>,
				);
				return;
			}
			if (readOnly) return;
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
				<MessageActionButton
					key={key}
					type="button"
					className="msg-action"
					title={label}
					aria-label={label}
					onClick={() => onUiAction?.(entry)}
				>
					{slotIcon(entry.icon)} <span className="msg-action-label">{label}</span>
					{entry.badge ? <span className="msg-action-count">{entry.badge}</span> : null}
				</MessageActionButton>,
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

	const isGoalReview =
		message.role === "custom" && (message.customType === "goal-review" || message.customType === "goal-wizard");
	const isGoalWizard = message.role === "custom" && message.customType === "goal-wizard";
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

	const showMessageActions = !editing && (message.role === "user" || canCopyWhole);

	const anchorIndex = useMemo(() => {
		if (message.role !== "assistant") return -1;
		for (let i = message.content.length - 1; i >= 0; i--) if (asText(message.content[i])) return i;
		return -1;
	}, [message.role, message.content]);

	const collabMeta = useMemo(() => {
		if (message.role !== "user") return null;
		for (const b of message.content) {
			const t = asText(b);
			if (t) {
				const parsed = parseCollabMessage(t.text);
				if (parsed) return parsed;
			}
		}
		return null;
	}, [message.role, message.content]);

	return (
		<div
			ref={cardRef}
			className={`msg msg-${message.role}${collabMeta ? (collabMeta.isNotice ? " msg-collab-notice" : " msg-collaboration") : ""}${isGoalReview ? " msg-goal-review" : ""}${
				exportSelected ? " msg-export-selected" : ""
			}${readOnly ? " msg-readonly" : ""}${messageLabel && message.id.startsWith("group-") ? " msg-group" : ""}`}
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
						: collabMeta
							? collabMeta.isNotice
								? `${t("subagentBadge")} · 完成通知`
								: `${t("subagentBadge")} · ${collabMeta.sourceTitle || collabMeta.sourceRole || t("subagentBadge")}`
							: roleLabel(message.role, t)}
				</span>
				{messageLabel && (
					<span className="msg-sender" data-initial={Array.from(messageLabel)[0]}>
						{messageLabel}
					</span>
				)}
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
									const imageUrl = (att as EditPromptAttachment).imageUrl;
									const imageSrc = imageUrl
										? appResourceUrl(imageUrl)
										: `data:${att.mimeType ?? "image/png"};base64,${att.imageData}`;
									return (
										<span
											key={`${att.name ?? att.path ?? "att"}-${i}`}
											className={`msg-editor-img ${kind === "image" ? "" : "file-chip"}`}
											title={editAttLabel(att, t)}
										>
											{kind === "image" ? (
												<img
													crossOrigin={appResourceCrossOrigin(imageSrc)}
													src={imageSrc}
													alt={att.name}
													className="msg-editor-img-clickable"
													title={t("toolImageZoom")}
													onClick={() => openImageLightbox({ src: imageSrc, alt: att.name })}
												/>
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
						{editReads.length > 0 && (
							<div className="msg-editor-notice" role="status" aria-live="polite" aria-atomic="true">
								{editReads.map(({ id, name, percent }) => (
									<div key={id} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
										<progress
											max={100}
											value={percent ?? undefined}
											aria-label={
												percent === null ? t("uploadPreparing", { name }) : t("uploadReading", { name, percent })
											}
											style={{ width: 64, flexShrink: 0 }}
										/>
										<span style={{ overflowWrap: "anywhere", minWidth: 0 }}>
											{percent === null ? t("uploadPreparing", { name }) : t("uploadReading", { name, percent })}
										</span>
									</div>
								))}
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
								if (images.length === 0) return;
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
							<button type="button" className="btn sm" onClick={() => setEditing(false)}>
								{t("cancel")}
							</button>
							<button
								type="button"
								className="btn primary sm"
								disabled={
									resending ||
									(!draft.trim() && !editAttachments.some((a) => a.mode === "quote" && readTextQuote(a.quote)))
								}
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
							<div className="msg-stopped" role="status">
								{t("turnStopped")}
							</div>
						) : (
							message.errorMessage && (
								<div className="msg-error">
									<span className="msg-error-text">{message.errorMessage}</span>
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
						{messageAttachments.length > 0 && (
							<div className="msg-queued-atts-bar">
								{messageAttachments.map((att, i) => {
									let previewImgSrc: string | undefined;
									if (att.url) {
										previewImgSrc = att.url.startsWith("/") ? appResourceUrl(att.url) : att.url;
									} else if (att.type === "image" || att.type === "vision-bridge") {
										const match = questionAttachments?.find(
											(qa) => qa.name === att.name || qa.imageData || (qa as EditPromptAttachment).imageUrl,
										) as EditPromptAttachment | undefined;
										if (match?.imageUrl) previewImgSrc = appResourceUrl(match.imageUrl);
										else if (match?.imageData)
											previewImgSrc = `data:${match.mimeType ?? "image/png"};base64,${match.imageData}`;
										else {
											const imgB = message.content.find((b) => b.type === "image") as { dataUrl?: string } | undefined;
											if (imgB?.dataUrl)
												previewImgSrc = imgB.dataUrl.startsWith("/") ? appResourceUrl(imgB.dataUrl) : imgB.dataUrl;
										}
									}
									const hasPath = Boolean(
										att.path && att.type !== "page" && att.type !== "conversation" && att.type !== "canvas",
									);
									const canPreview = Boolean(previewImgSrc || hasPath);
									const handleChipClick = () => {
										if (previewImgSrc) {
											openImageLightbox({ src: previewImgSrc, alt: att.name });
										} else if (hasPath && att.path) {
											openFilePreview({ path: att.path, name: att.name });
										}
									};
									return (
										<span
											key={`qatt-${i}`}
											className={`queued-att-chip${canPreview ? " previewable" : ""}`}
											title={
												canPreview
													? `${att.name} (${previewImgSrc ? t("toolImageZoom") : t("fileOpenPreview")})`
													: att.name
											}
											onClick={canPreview ? handleChipClick : undefined}
											role={canPreview ? "button" : undefined}
											tabIndex={canPreview ? 0 : undefined}
											onKeyDown={
												canPreview
													? (e) => {
															if (e.key === "Enter" || e.key === " ") {
																e.preventDefault();
																handleChipClick();
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
											key={i}
											block={block}
											toolResults={toolResults}
											liveOutputs={liveOutputs}
											toolStatuses={toolStatuses}
											streaming={streaming}
											isLast={isLast}
											isTrailingBlock={i === message.content.length - 1}
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
											uiToolCardFooter={uiToolCardFooter}
											onUiAction={onUiAction}
										/>
									),
								)}
							</>
						) : isCustomWidget ? (
							<PluginWidgetBlock type={message.customType ?? ""} code={widgetPayload}>
								{message.content.map((block, i) => (
									<Block
										key={i}
										block={block}
										toolResults={toolResults}
										liveOutputs={liveOutputs}
										toolStatuses={toolStatuses}
										streaming={streaming}
										isLast={isLast}
										isTrailingBlock={i === message.content.length - 1}
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
										uiToolCardFooter={uiToolCardFooter}
										onUiAction={onUiAction}
									/>
								))}
							</PluginWidgetBlock>
						) : (
							message.content.map((block, i) => (
								<Fragment key={i}>
									<Block
										block={block}
										toolResults={toolResults}
										liveOutputs={liveOutputs}
										toolStatuses={toolStatuses}
										streaming={streaming}
										isLast={isLast}
										isTrailingBlock={i === message.content.length - 1}
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
										uiToolCardFooter={uiToolCardFooter}
										onUiAction={onUiAction}
									/>
									{i === anchorIndex && showMessageActions && renderMessageActions()}
								</Fragment>
							))
						)}
						{isEmptyStreaming && (
							<div
								className="thinking-wait minimal"
								title={t("thinkingWait")}
								aria-label={t("thinkingWait")}
								role="status"
							>
								<span className="dot" />
							</div>
						)}
					</>
				)}
			</div>
			{showMessageActions && anchorIndex < 0 && renderMessageActions()}
		</div>
	);
});

function AttachmentCard({ message, forceOpen = false }: { message: UiMessage; forceOpen?: boolean }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const { copied, copy } = useCopyFeedback({ duration: 1200 });
	const shown = open || forceOpen;
	const details = (message.details ?? {}) as {
		name?: string;
		path?: string;
		mode?: "inline" | "reference" | "lines" | "image" | "bridged" | "page" | "conversation" | "canvas";
		size?: number;
		lines?: number;
		startLine?: number;
		endLine?: number;
		type?: "folder";
	};
	const name = details.name ?? details.path ?? t("attachment");
	const isFolder = details.type === "folder";
	const isCanvas = details.mode === "canvas";
	const isReference = details.mode === "reference" || isCanvas;
	const isBridged = details.mode === "bridged";
	const isPage = details.mode === "page";
	const isConversation = details.mode === "conversation";
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
				icon={isCanvas ? "◈" : isFolder ? "📁" : isPage ? "🌐" : isConversation ? "💬" : "📎"}
				iconClassName="attachcard-icon"
				titleClassName="attachcard-name"
				after={
					<>
						{details.path &&
							(isPage && safePageHref ? (
								<a className="attachcard-path attachcard-link" href={safePageHref} target="_blank" rel="noreferrer">
									{details.path}
								</a>
							) : !isPage && !isConversation && !isFolder ? (
								<span
									className="attachcard-path attachcard-path-clickable"
									title={t("fileOpenPreview")}
									onClick={(e) => {
										e.stopPropagation();
										openFilePreview({ path: details.path!, name });
									}}
								>
									{details.path}
								</span>
							) : (
								<span className="attachcard-path">{details.path}</span>
							))}
						<span
							className={`attachcard-mode ${details.mode === "lines" ? "lines" : isReference ? "ref" : isPage ? "page" : isConversation ? "conversation" : isBridged ? "bridged" : "inline"}`}
						>
							{isCanvas
								? t("canvasTab")
								: isPage
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
							? appResourceUrl(image.dataUrl)
							: image.dataUrl
						: undefined;
					return isBridged ? (
						<>
							<div className="attachcard-bridgenote">{t("bridgedVisionDetail")}</div>
							{imgSrc && (
								<div className="attachcard-image">
									<img
										crossOrigin={appResourceCrossOrigin(imgSrc)}
										src={imgSrc}
										loading="lazy"
										decoding="async"
										alt={name}
										className="attachcard-image-clickable"
										title={t("toolImageZoom")}
										onClick={() => openImageLightbox({ src: imgSrc, alt: name })}
									/>
								</div>
							)}
							{clean && <pre className="attachcard-content">{clean}</pre>}
						</>
					) : imgSrc ? (
						<div className="attachcard-image">
							<img
								crossOrigin={appResourceCrossOrigin(imgSrc)}
								src={imgSrc}
								loading="lazy"
								decoding="async"
								alt={name}
								className="attachcard-image-clickable"
								title={t("toolImageZoom")}
								onClick={() => openImageLightbox({ src: imgSrc, alt: name })}
							/>
						</div>
					) : (
						<pre className="attachcard-content">{clean}</pre>
					);
				})()}
			{isReference && (
				<div className="attachcard-refnote">
					<span>{isFolder ? t("folderNotExpanded") : t("fileNotExpanded", { size: formatSize(details.size) })}</span>
					{!isFolder && details.path && (
						<button
							type="button"
							className="attachcard-ref-open"
							onClick={() => openFilePreview({ path: details.path!, name })}
						>
							<FiEye /> {t("fileOpenPreview")}
						</button>
					)}
				</div>
			)}
		</div>
	);
}

function stripFileWrapper(text: string): string {
	const m = text.match(/^\s*<file path="[^"]*"(?:\s+lines="[^"]*")?>\s*```\s*\n?([\s\S]*?)\n?```\s*<\/file>\s*$/);
	if (m) return m[1].trim();
	const vb = text.match(/^\s*<vision-bridge>\s*([\s\S]*?)\s*<\/vision-bridge>\s*$/);
	return vb ? vb[1].trim() : text.trim();
}

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
	isTrailingBlock,
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
	uiToolCardFooter,
	onUiAction,
}: {
	block: UiContentBlock;
	toolResults: ReadonlyMap<string, UiMessage>;
	liveOutputs: ReadonlyMap<string, { toolName: string; text: string }>;
	toolStatuses: ReadonlyMap<string, ToolStatus>;
	streaming: boolean;
	isLast: boolean;
	isTrailingBlock?: boolean;
	onKillBash?: () => void;
	thinkingWrap?: boolean;
	toolsWrap?: boolean;
	toolImages?: boolean;
	searchActive?: boolean;
	forceThinking?: boolean;
	forceTools?: boolean;
	role?: UiMessage["role"];
	showCopy?: boolean;
	uiContextToolCall?: UiSlotEntry[];
	uiToolCardFooter?: UiSlotEntry[];
	onUiAction?: (item: UiSlotEntry, value?: string) => void;
}) {
	const t = useT();
	const { copied, copy } = useCopyFeedback({ duration: 1200 });
	const isTrailing = isTrailingBlock ?? true;
	const rawText = asText(block);
	const live = !!(rawText && streaming && isLast && isTrailing);
	const liveRef = useRef(live);
	liveRef.current = live;
	const wasLiveRef = useRef(live);
	if (live) wasLiveRef.current = true;
	const isHidden = () => typeof document !== "undefined" && document.hidden;
	const [draining, setDraining] = useState(() => live && !isHidden());
	useEffect(() => {
		if (live && !isHidden()) setDraining(true);
		else if (!live && isHidden()) setDraining(false);
	}, [live]);
	useEffect(() => {
		if (typeof document === "undefined") return;
		const onVis = () => {
			if (!liveRef.current) setDraining(false);
		};
		document.addEventListener("visibilitychange", onVis);
		return () => document.removeEventListener("visibilitychange", onVis);
	}, []);
	const handleStreamSettled = useCallback(() => {
		if (!liveRef.current) setDraining(false);
	}, []);
	if (rawText) {
		const cleanedText = role === "user" ? rawText.text : stripInlineMarkers(rawText.text, live);
		if (!cleanedText.trim()) return null;
		const text = cleanedText === rawText.text ? rawText : { ...rawText, text: cleanedText };
		const collab = role === "user" ? parseCollabMessage(rawText.text) : null;
		const copyable = (role === "assistant" || role === "user") && showCopy !== false;
		const oneLiner = copyable && !text.text.includes("\n") && !text.truncated;
		const body =
			collab && !collab.isNotice ? (
				<div className="collab-request-box">
					{collab.userText ? <Markdown text={collab.userText} hardBreaks /> : null}
					{collab.questions && collab.questions.length > 0 && (
						<div className="collab-questions">
							{collab.questions.map((q, idx) => (
								<div key={q.id || idx} className="collab-q-item">
									<div className="collab-q-title">
										<strong>{q.question}</strong>
									</div>
									{q.options && q.options.length > 0 && (
										<div className="collab-q-options">
											{q.options.map((opt, oIdx) => (
												<span key={oIdx} className="collab-q-opt-tag">
													{opt.label}
												</span>
											))}
										</div>
									)}
								</div>
							))}
						</div>
					)}
					{collab.requestId && (
						<div className="collab-req-id">
							Request: <code>{collab.requestId}</code>
						</div>
					)}
				</div>
			) : role === "user" ? (
				<Markdown text={text.text} hardBreaks />
			) : live || draining || wasLiveRef.current ? (
				<StreamMarkdown text={text.text} finishing={!live && draining} onSettled={handleStreamSettled} />
			) : (
				<Markdown text={text.text} />
			);
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
				streaming={streaming && isLast && isTrailing}
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
				uiToolCardFooter={uiToolCardFooter}
				onUiAction={onUiAction}
			/>
		);
	}

	const image = asImage(block);
	if (image && image.dataUrl) {
		const src = image.dataUrl.startsWith("/") ? appResourceUrl(image.dataUrl) : image.dataUrl;
		return (
			<div className="msg-image">
				<img
					crossOrigin={appResourceCrossOrigin(src)}
					src={src}
					loading="lazy"
					decoding="async"
					alt="attachment"
					className="msg-image-clickable"
					title={t("toolImageZoom")}
					onClick={() => openImageLightbox({ src, alt: "attachment" })}
				/>
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
