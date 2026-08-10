import { memo, useState } from "react";
import {
	FiChevronDown,
	FiChevronRight,
	FiChevronUp,
	FiEdit3,
} from "react-icons/fi";
import type {
	ToolStatus,
	UiBashBlock,
	UiContentBlock,
	UiImageBlock,
	UiMessage,
	UiTextBlock,
	UiThinkingBlock,
	UiToolCallBlock,
} from "../types";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallBlock, type ToolView } from "./ToolCallBlock";
import { useT, type Translate } from "../i18n";

// ---------------------------------------------------------------------------
// Narrowing guards. UiContentBlock is an open union (its last member is
// `{ type: string; [k: string]: unknown }`), so plain `switch` narrowing does
// not work — same pattern pi-vsc uses in shared/blocks.ts.
// ---------------------------------------------------------------------------

export function asText(block: UiContentBlock): UiTextBlock | null {
	return block.type === "text" &&
		typeof (block as UiTextBlock).text === "string"
		? (block as UiTextBlock)
		: null;
}

export function asThinking(block: UiContentBlock): UiThinkingBlock | null {
	return block.type === "thinking" &&
		typeof (block as UiThinkingBlock).thinking === "string"
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
	return block.type === "image" &&
		typeof (block as UiImageBlock).dataUrl === "string"
		? (block as UiImageBlock)
		: null;
}

export function asBash(block: UiContentBlock): UiBashBlock | null {
	return block.type === "bash" &&
		typeof (block as UiBashBlock).command === "string"
		? (block as UiBashBlock)
		: null;
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
	/** Edit-and-re-ask handler (user messages only). Stable identity — Message is memoized. */
	onEdit?: (messageId: string, text: string) => void;
	/** When set, shows a collapse button (message was expanded from the collapsed view). */
	onCollapse?: (messageId: string) => void;
}

export const Message = memo(function Message({
	message,
	toolResults,
	liveOutputs,
	toolStatuses,
	streaming,
	isLast,
	onEdit,
	onCollapse,
}: MessageProps) {
	const t = useT();
	// Inline edit-and-re-ask editor (user messages only).
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	// toolResult content is rendered inside its toolCall card — never standalone
	// (otherwise the same output shows twice: formatted card + plain text).
	if (message.role === "toolResult") return null;
	// Attached files are rendered as their own collapsible card, separate from
	// the user message text.
	const isFileAttachment =
		message.role === "custom" && message.customType === "file";
	// Streaming bubble with no content yet (first token not arrived) — show a
	// visible “thinking…” placeholder instead of an invisible empty bubble.
	const isEmptyStreaming = streaming && isLast && message.content.length === 0;

	const canEdit =
		message.role === "user" && !streaming && !isEmptyStreaming && !!onEdit;
	const startEdit = () => {
		setDraft(
			message.content
				.map((b) => asText(b)?.text ?? "")
				.filter(Boolean)
				.join("\n"),
		);
		setEditing(true);
	};
	const submitEdit = () => {
		const text = draft.trim();
		if (!text) return;
		onEdit?.(message.id, text);
		setEditing(false);
	};

	return (
		<div
			className={`msg msg-${message.role}`}
			data-role={message.role}
			data-msg-id={message.id}
		>
			<div className="msg-meta">
				<span className="msg-role">
					{message.role === "custom"
						? message.customType === "file"
							? t("attachment")
							: `${t("plugin")} · ${message.customType ?? t("unknown")}`
						: roleLabel(message.role, t)}
				</span>
				{message.model && <span className="msg-model">{message.model}</span>}
				{message.timestamp && (
					<span className="msg-time">{formatTime(message.timestamp)}</span>
				)}
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
			</div>
			<div className="msg-body">
				{editing ? (
					<div className="msg-editor">
						<textarea
							className="msg-editor-input"
							value={draft}
							autoFocus
							placeholder={t("editPlaceholder")}
							rows={Math.max(2, Math.min(10, draft.split("\n").length + 1))}
							onChange={(e) => setDraft(e.target.value)}
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
							<span className="msg-editor-hint">{t("editHint")}</span>
							<button
								type="button"
								className="chip"
								onClick={() => setEditing(false)}
							>
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
							<div className="msg-error">{message.errorMessage}</div>
						)}
						{isFileAttachment ? (
							<AttachmentCard message={message} />
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
								/>
							))
						)}
						{isEmptyStreaming && (
							<div className="thinking-wait">
								{t("thinkingWait")}
								<span className="dot" />
							</div>
						)}
						{streaming && isLast && !isEmptyStreaming && (
							<span className="stream-cursor" />
						)}
					</>
				)}
			</div>
			{canEdit && !editing && (
				<div className="msg-actions">
					<button
						type="button"
						className="msg-action"
						title={t("editReaskTip")}
						onClick={startEdit}
					>
						<FiEdit3 /> {t("editReask")}
					</button>
				</div>
			)}
		</div>
	);
});

/** Collapsible card for an attached file (customType "file"). */
function AttachmentCard({ message }: { message: UiMessage }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const details = (message.details ?? {}) as {
		name?: string;
		path?: string;
		mode?: "inline" | "reference" | "lines";
		size?: number;
		lines?: number;
		startLine?: number;
		endLine?: number;
		type?: "folder";
	};
	const name = details.name ?? details.path ?? t("attachment");
	const isFolder = details.type === "folder";
	const isReference = details.mode === "reference";

	const text = message.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	const clean = stripFileWrapper(text);
	const image = message.content.find((b) => b.type === "image") as
		| { type: "image"; dataUrl?: string }
		| undefined;
	const lines = clean.split("\n").length;

	return (
		<div className={`attachcard ${isReference ? "reference" : ""}`}>
			<button
				type="button"
				className="attachcard-head"
				onClick={() => setOpen((v) => !v)}
			>
				<span className="attachcard-icon">{isFolder ? "📁" : "📎"}</span>
				<span className="attachcard-name">{name}</span>
				{details.path && (
					<span className="attachcard-path">{details.path}</span>
				)}
				<span
					className={`attachcard-mode ${details.mode === "lines" ? "lines" : isReference ? "ref" : "inline"}`}
				>
					{isReference
						? isFolder
							? t("folderRefShort")
							: `${t("refOnlyShort")} · ${formatSize(details.size)}`
						: image
							? t("image")
							: details.mode === "lines"
								? t("inlineLinesRange", {
										start: details.startLine ?? 1,
										end: details.endLine ?? details.lines ?? 1,
									})
								: t("inlineLines", { n: details.lines ?? lines })}
				</span>
				{!isReference && (open ? <FiChevronDown /> : <FiChevronRight />)}
			</button>
			{!isReference &&
				open &&
				(image?.dataUrl ? (
					<div className="attachcard-image">
						<img src={image.dataUrl} alt={name} />
					</div>
				) : (
					<pre className="attachcard-content">{clean}</pre>
				))}
			{isReference && (
				<div className="attachcard-refnote">
					{isFolder
						? t("folderNotExpanded")
						: t("fileNotExpanded", { size: formatSize(details.size) })}
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

/** Strip the <file path="..."> ``` ... ``` </file> wrapper for display. */
function stripFileWrapper(text: string): string {
	const m = text.match(
		/^\s*<file path="[^"]*"(?:\s+lines="[^"]*")?>\s*```\s*\n?([\s\S]*?)\n?```\s*<\/file>\s*$/,
	);
	return m ? m[1].trim() : text.trim();
}

function Block({
	block,
	toolResults,
	liveOutputs,
	toolStatuses,
	streaming,
	isLast,
}: {
	block: UiContentBlock;
	toolResults: ReadonlyMap<string, UiMessage>;
	liveOutputs: ReadonlyMap<string, { toolName: string; text: string }>;
	toolStatuses: ReadonlyMap<string, ToolStatus>;
	streaming: boolean;
	isLast: boolean;
}) {
	const t = useT();
	const text = asText(block);
	if (text) {
		return (
			<div className="msg-text">
				<Markdown text={text.text} />
				{text.truncated && <div className="trunc-note">{t("truncated")}</div>}
			</div>
		);
	}

	const thinking = asThinking(block);
	if (thinking) {
		return (
			<ThinkingBlock
				thinking={thinking.thinking}
				streaming={streaming && isLast}
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
		return <ToolCallBlock block={toolCall} view={view} />;
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
						<span
							className={`bashblock-exit ${bash.exitCode === 0 ? "ok" : "err"}`}
						>
							{t("exitCode", { code: bash.exitCode })}
						</span>
					)}
					{bash.cancelled && (
						<span className="bashblock-exit err">{t("cancelled")}</span>
					)}
				</div>
				{bash.output && <pre className="bashblock-output">{bash.output}</pre>}
				{bash.truncated && (
					<div className="trunc-note">{t("outputTruncated")}</div>
				)}
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
