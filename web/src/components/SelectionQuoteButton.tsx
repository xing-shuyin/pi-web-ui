import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { TextQuote } from "../types";
import { useT } from "../i18n";
import { readQuoteSelection } from "../quote-selection";
import { composeToComposer, focusComposer } from "../composer-bridge";
import { randomUuid } from "../uuid";
import { openQuickAsk } from "../quick-ask";

export function SelectionQuoteButton({
	rootRef,
	sessionId,
	enabled = true,
	translateEnabled = true,
	onSelect,
}: {
	rootRef: RefObject<HTMLDivElement | null>;
	sessionId: string;
	enabled?: boolean;
	translateEnabled?: boolean;
	onSelect?: () => void;
}) {
	const t = useT();
	const [pending, setPending] = useState<{ quote: TextQuote; left: number; top: number } | null>(null);
	useEffect(() => {
		setPending(null);
		const root = rootRef.current;
		if (!root || !enabled) return;
		let selecting = false;
		let frame = 0;
		const clear = () => {
			cancelAnimationFrame(frame);
			setPending(null);
		};
		const update = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const selection = window.getSelection();
				const quote = readQuoteSelection(root, selection, sessionId);
				if (!quote || !selection) {
					setPending(null);
					return;
				}
				const rect = selection.getRangeAt(0).getBoundingClientRect();
				if (!rect.width && !rect.height) {
					setPending(null);
					return;
				}
				onSelect?.();
				setPending({
					quote,
					left: Math.max(
						8,
						Math.min(rect.right - (translateEnabled ? 240 : 176), window.innerWidth - (translateEnabled ? 248 : 184)),
					),
					top: Math.max(8, Math.min(rect.top >= 44 ? rect.top - 40 : rect.bottom + 8, window.innerHeight - 42)),
				});
			});
		};
		const down = (event: MouseEvent) => {
			if ((event.target as Element)?.closest?.(".quote-selection-toolbar, .quick-ask-popover")) return;
			selecting = event.button === 0 && root.contains(event.target as Node);
			clear();
		};
		const up = (event: MouseEvent) => {
			selecting = false;
			if (event.button === 0) update();
		};
		const change = () => {
			if (!selecting) update();
		};
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") clear();
		};
		document.addEventListener("mousedown", down);
		document.addEventListener("mouseup", up);
		document.addEventListener("selectionchange", change);
		document.addEventListener("keydown", key);
		window.addEventListener("scroll", clear, true);
		window.addEventListener("resize", clear);
		window.addEventListener("blur", clear);
		return () => {
			cancelAnimationFrame(frame);
			document.removeEventListener("mousedown", down);
			document.removeEventListener("mouseup", up);
			document.removeEventListener("selectionchange", change);
			document.removeEventListener("keydown", key);
			window.removeEventListener("scroll", clear, true);
			window.removeEventListener("resize", clear);
			window.removeEventListener("blur", clear);
		};
	}, [rootRef, sessionId, enabled, translateEnabled, onSelect]);
	if (!enabled) return null;
	if (!pending || pending.quote.sessionId !== sessionId) return null;
	return createPortal(
		<div
			className="quote-selection-toolbar"
			role="group"
			style={{ left: pending.left, top: pending.top }}
			onMouseDown={(event) => event.preventDefault()}
		>
			<button
				type="button"
				className="quote-selection-button"
				onClick={() => {
					const accepted = composeToComposer({
						attachments: [{ path: "", name: t("quoteText"), mode: "quote", quote: pending.quote, key: randomUuid() }],
					});
					if (!accepted) return;
					setPending(null);
					window.getSelection()?.removeAllRanges();
					focusComposer();
				}}
			>
				<span aria-hidden="true">↪</span> {t("quoteSelection")}
			</button>
			<button
				type="button"
				className="quote-selection-button selection-explain-trigger"
				onClick={(event) => {
					const rect = event.currentTarget.parentElement!.getBoundingClientRect();
					openQuickAsk({
						selection: pending.quote.text,
						action: "explain",
						anchor: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
					});
					setPending(null);
					window.getSelection()?.removeAllRanges();
				}}
			>
				{t("explainSelection")}
			</button>
			{translateEnabled && (
				<button
					type="button"
					className="quote-selection-button selection-translate-trigger"
					onClick={(event) => {
						const rect = event.currentTarget.parentElement!.getBoundingClientRect();
						openQuickAsk({
							selection: pending.quote.text,
							action: "translate",
							anchor: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
						});
						setPending(null);
						window.getSelection()?.removeAllRanges();
					}}
				>
					{t("quickAskTranslate")}
				</button>
			)}
		</div>,
		document.body,
	);
}
