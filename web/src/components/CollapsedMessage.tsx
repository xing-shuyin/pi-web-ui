import { memo } from "react";
import { FiChevronDown } from "react-icons/fi";
import type { UiMessage } from "../types";
import { useT } from "../i18n";
import { asBash, asImage, asText, asThinking, asToolCall, roleLabel } from "./Message";

import { parseSkillBlock } from "../skill-block";

interface CollapsedMessageProps {
	message: UiMessage;
	onExpand: (messageId: string) => void;
}

/**
 * Cheap summary row for messages outside the recent window. Renders NO heavy
 * content (no Markdown, no thinking, no tool output, no attachments) — just a
 * role label, a plain-text preview, and block-type counts. The full message is
 * only rendered after the user clicks to expand.
 */
export const CollapsedMessage = memo(function CollapsedMessage({ message, onExpand }: CollapsedMessageProps) {
	const t = useT();

	// Plain-text preview (first text block, first line, ~90 chars — no Markdown).
	let preview = "";
	for (const b of message.content) {
		const text = asText(b);
		if (text && text.text.trim()) {
			// Skill invocations collapse to a `skill:name · <args>` chip instead
			// of the raw SKILL.md dump.
			const sb = parseSkillBlock(text.text);
			if (sb) {
				preview = `skill:${sb.name}` + (sb.userMessage ? ` · ${sb.userMessage.replace(/\s+/g, " ").trim()}` : "");
			} else {
				preview = text.text.replace(/\s+/g, " ").trim();
			}
			break;
		}
	}
	// Attached files get their name as the preview.
	if (!preview && message.role === "custom" && message.customType === "file") {
		const details = (message.details ?? {}) as { name?: string; path?: string };
		preview = details.name ?? details.path ?? "";
	}
	const truncated = preview.length > 90;
	if (truncated) preview = `${preview.slice(0, 90)}…`;

	// Count heavy block types for the summary chips.
	let thinking = 0;
	let tools = 0;
	let bash = 0;
	let images = 0;
	for (const b of message.content) {
		if (asThinking(b)) thinking++;
		else if (asToolCall(b)) tools++;
		else if (asBash(b)) bash++;
		else if (asImage(b)) images++;
	}
	const chips: string[] = [];
	if (thinking) chips.push(`${t("thinking")} ${thinking}`);
	if (tools) chips.push(`${t("toolCalls")} ${tools}`);
	if (bash) chips.push(`${t("bashRuns")} ${bash}`);
	if (images) chips.push(`${t("images")} ${images}`);

	return (
		<button
			type="button"
			className="msg-collapsed"
			data-msg-id={message.id}
			title={`${t("expandMsg")} · ${preview || chips.join(" · ") || message.role}`}
			onClick={() => onExpand(message.id)}
		>
			<span className={`msg-collapsed-role role-${message.role}`}>
				{message.role === "custom" && message.customType === "file" ? t("attachment") : roleLabel(message.role, t)}
			</span>
			<span className="msg-collapsed-body">
				{preview && <span className="msg-collapsed-preview">{preview}</span>}
				{chips.length > 0 && (
					<span className="msg-collapsed-chips">
						{chips.map((c, i) => (
							<span key={i} className="msg-collapsed-chip">
								{c}
							</span>
						))}
					</span>
				)}
			</span>
			{message.timestamp ? <span className="msg-collapsed-time">{formatTime(message.timestamp)}</span> : null}
			<span className="msg-collapsed-action">
				<FiChevronDown /> {t("expandMsg")}
			</span>
		</button>
	);
});

function formatTime(ts: number): string {
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}
