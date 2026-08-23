import { memo } from "react";
import { FiChevronDown } from "react-icons/fi";
import type { UiMessage } from "../types";
import { useT } from "../i18n";
import {
	asText,
	roleLabel,
} from "./Message";

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
export const CollapsedMessage = memo(function CollapsedMessage({
	message,
	onExpand,
}: CollapsedMessageProps) {
	const t = useT();

	// Windowed snapshot deliveries carry a ready-made summary (preview + counts);
	// otherwise compute the same from content.
	const preview =
		message.summary?.preview ??
		(() => {
			// Plain-text preview (first text block, first line, ~90 chars — no Markdown).
			let p = "";
			for (const b of message.content) {
				const text = asText(b);
				if (text && text.text.trim()) {
					const sb = parseSkillBlock(text.text);
					p = sb
						? `skill:${sb.name}` + (sb.userMessage ? ` · ${sb.userMessage.replace(/\s+/g, " ").trim()}` : "")
						: text.text.replace(/\s+/g, " ").trim();
					break;
				}
			}
				const t = p.length > 90 ? p.slice(0, 90) + "…" : p;
				return t;
			})();

	// Count heavy block types for the summary chips (from summary when provided).
	const thinking = message.summary?.thinking ?? 0;
	const tools = message.summary?.toolCall ?? 0;
	const bash = message.summary?.bash ?? 0;
	const images = message.summary?.image ?? 0;
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
				{message.role === "custom" && message.customType === "file"
					? t("attachment")
					: roleLabel(message.role, t)}
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
			{message.timestamp ? (
				<span className="msg-collapsed-time">
					{formatTime(message.timestamp)}
				</span>
			) : null}
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
