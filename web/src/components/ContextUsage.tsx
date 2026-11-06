import { useId, useLayoutEffect, useRef, useState, type MouseEventHandler, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ContextCategory, UiState } from "../types";
import { useT } from "../i18n";
import { formatTokens } from "../format-tokens";
import { useFloatingPanel } from "../use-floating-panel";

const CATEGORY_LABELS = {
	systemPrompt: "settingsSystemPrompt",
	memoryFiles: "contextMemoryFiles",
	tools: "contextTools",
	skills: "contextSkills",
	toolResults: "contextToolResults",
	messages: "messages",
	other: "contextOther",
} as const satisfies Record<ContextCategory, string>;

export function ContextUsage({
	context,
	bar,
	title,
	onContextMenu,
	children,
}: {
	context?: UiState["stats"]["contextUsage"];
	bar: "top" | "bottom" | "left" | "right";
	title: string;
	onContextMenu: MouseEventHandler<HTMLElement>;
	children: ReactNode;
}) {
	const t = useT();
	const id = useId();
	const anchor = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const { panelRef, style, measure } = useFloatingPanel({
		open,
		anchor,
		side: bar === "bottom" ? "top" : "bottom",
		align: bar === "left" ? "left" : "right",
		onClose: () => setOpen(false),
	});
	const contextWindow = context?.contextWindow ?? 0;
	const cap = context?.softCap ?? 0;
	const max = cap > 0 && cap < contextWindow ? cap : contextWindow;
	const known = typeof context?.tokens === "number" && Number.isFinite(context.tokens) && max > 0;
	const used = known ? Math.max(0, context.tokens!) : 0;
	const percent = Math.min(100, Math.round((used / (max || 1)) * 100));
	const free = Math.max(0, max - used);
	const categories = context?.categories?.filter((row) => row.tokens > 0 && row.category in CATEGORY_LABELS) ?? [];
	const hasCategories = categories.length > 0;
	const rows = categories.map((row) => ({ ...row, label: t(CATEGORY_LABELS[row.category]) }));
	if (!hasCategories && used > 0) rows.push({ category: "other", tokens: used, label: t("contextUsed") });
	useLayoutEffect(() => {
		if (open) measure();
	});

	return (
		<>
			<button
				ref={anchor}
				type="button"
				className="bar-item status-item status-ctx bar-item-ctx"
				title={open ? undefined : title}
				data-tip={open ? undefined : title}
				data-bar-item="host:ctx"
				aria-label={title}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				onContextMenu={onContextMenu}
				onClick={() => setOpen((value) => !value)}
			>
				{children}
			</button>
			{open &&
				createPortal(
					<div
						ref={panelRef}
						id={id}
						style={style}
						className="context-usage-panel"
						role="dialog"
						aria-labelledby={`${id}-title`}
					>
						<header className="context-usage-header">
							<h3 id={`${id}-title`}>{t("context")}</h3>
							<span>{known ? t("contextPercent", { percent }) : "—"}</span>
						</header>
						{known ? (
							<>
								<div
									className="context-usage-bar"
									role="meter"
									aria-label={t("contextUsage")}
									aria-valuemin={0}
									aria-valuemax={max}
									aria-valuenow={Math.min(used, max)}
									aria-valuetext={`${formatTokens(used)} / ${formatTokens(max)}`}
								>
									{rows.map((row) => (
										<span key={row.category} data-category={row.category} style={{ flexGrow: row.tokens }} />
									))}
									<span data-category="free" style={{ flexGrow: free }} />
								</div>
								<p className="context-usage-tokens">
									{t(hasCategories || context?.estimated ? "contextTokensEstimated" : "contextTokens", {
										used: formatTokens(used),
										total: formatTokens(max),
									})}
								</p>
								<ul className="context-usage-categories" aria-label={t("contextUsage")}>
									{rows.map((row) => (
										<li key={row.category} data-category={row.category}>
											<span className="context-usage-dot" aria-hidden="true" />
											<span className="context-usage-label">{row.label}</span>
											<span className="context-usage-value" title={row.tokens.toLocaleString()}>
												{formatTokens(row.tokens)}
											</span>
										</li>
									))}
									<li data-category="free">
										<span className="context-usage-dot" aria-hidden="true" />
										<span className="context-usage-label">{t("contextFree")}</span>
										<span className="context-usage-value" title={free.toLocaleString()}>
											{formatTokens(free)}
										</span>
									</li>
								</ul>
								<p className="context-usage-note">
									{t(hasCategories ? "contextBreakdownEstimate" : "contextBreakdownUnavailable")}
								</p>
								{cap > 0 && (
									<p className="context-usage-note">
										{t("contextSoftCap", { cap: formatTokens(cap), max: formatTokens(contextWindow) })}
									</p>
								)}
							</>
						) : (
							<p className="context-usage-note">{t("contextUsageUnavailable")}</p>
						)}
					</div>,
					document.body,
				)}
		</>
	);
}
