import { useState } from "react";
import type { TextQuote } from "../types";
import { useT } from "../i18n";

export function TextQuoteCard({
	quote,
	onRemove,
	forceOpen = false,
}: {
	quote: TextQuote;
	onRemove?: () => void;
	forceOpen?: boolean;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const roleKey =
		quote.role === "user"
			? "role.user"
			: quote.role === "assistant"
				? "role.assistant"
				: quote.role === "toolResult"
					? "role.tool"
					: quote.role === "bashExecution"
						? "role.bash"
						: quote.role === "page"
							? "role.page"
							: "attachment";
	return (
		<div className="quote-card">
			<details open={open || forceOpen} onToggle={(event) => setOpen(event.currentTarget.open)}>
				<summary title={t("quoteSource", { id: quote.messageId })}>
					<span className="quote-source">
						↪ {t("quoteText")} · {t(roleKey)}
					</span>
					<span className="quote-preview">{quote.text.replace(/\s+/g, " ").slice(0, 80)}</span>
				</summary>
				<pre className="quote-content">{quote.text}</pre>
			</details>
			{onRemove && (
				<button
					type="button"
					className="quote-remove"
					aria-label={t("removeQuote")}
					title={t("removeQuote")}
					onClick={onRemove}
				>
					×
				</button>
			)}
		</div>
	);
}
