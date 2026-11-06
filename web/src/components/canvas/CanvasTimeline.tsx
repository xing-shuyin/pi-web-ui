import { useMemo } from "react";
import { useT, useLocale } from "../../i18n";
import { formatCanvasMessage } from "./canvas-i18n";
import { getStatusMetas } from "./CanvasTypes";
import type { CanvasEdge, CanvasNode, CanvasNodeLogEntry } from "../../types";

export interface CanvasTimelineProps {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	logs: Record<string, CanvasNodeLogEntry[]>;
	onRunNode: (id: string) => void;
	onLocate: (id: string) => void;
}

export function CanvasTimeline({ nodes, edges, logs, onRunNode, onLocate }: CanvasTimelineProps) {
	const t = useT();
	const locale = useLocale();
	const statuses = getStatusMetas(t);
	const rows = useMemo(() => {
		const loopByTarget = new Map<string, number>();
		edges.forEach((e) => {
			if (e.currentLoopCount) loopByTarget.set(e.targetNodeId, e.currentLoopCount);
		});
		return nodes.map((n) => {
			const entries = logs[n.id] ?? [];
			const latestPrompt = entries.findLastIndex((e) => e.kind === "prompt");
			const attemptEntries = latestPrompt < 0 ? entries : entries.slice(latestPrompt);
			const ts = attemptEntries.map((e) => e.ts).filter((v) => Number.isFinite(v) && v > 0);
			const start = ts.length > 0 ? Math.min(...ts) : null;
			const end = ts.length > 0 ? Math.max(...ts) : null;
			const dur = start != null && end != null ? Math.max(0, end - start) : null;
			const errs = entries.filter((e) => e.kind === "error").length;
			const errorEntry = [...entries].reverse().find((e) => e.kind === "error");
			const lastErr = errorEntry
				? formatCanvasMessage(errorEntry.message, errorEntry.text, t)
				: formatCanvasMessage(n.errorMessage, n.error, t);
			return { node: n, count: entries.length, start, end, dur, errs, lastErr, loops: loopByTarget.get(n.id) ?? 0 };
		});
	}, [nodes, edges, logs, t]);
	const fmtDur = (ms: number) =>
		ms < 1000
			? `${ms}ms`
			: ms < 60000
				? `${(ms / 1000).toFixed(1)}s`
				: `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
	const fmtTime = (t: number) => new Date(t).toLocaleTimeString(locale);
	const failed = rows.filter((r) => r.node.status === "error");
	return (
		<div className="canvas-timeline">
			<div className="canvas-timeline-head">
				<b>{t("canvas.timeline.executionTimelineLatestAttemptEstimated")}</b>
				<span className="canvas-timeline-meta">
					{t("canvas.timeline.summary", {
						count: nodes.length,
						failed: failed.length,
						logs: rows.reduce((a, r) => a + r.count, 0),
					})}
				</span>
				{failed.length > 0 && (
					<button
						type="button"
						className="canvas-btn primary"
						onClick={() => failed.forEach((r) => onRunNode(r.node.id))}
					>
						{t("canvas.timeline.retryFailedCount", { count: failed.length })}
					</button>
				)}
			</div>
			<div className="canvas-timeline-list">
				{rows.map((r) => (
					<div key={r.node.id} className={`canvas-timeline-row st-${r.node.status}`}>
						<span className="canvas-timeline-dot" />
						<button
							type="button"
							className="canvas-timeline-title"
							onClick={() => onLocate(r.node.id)}
							title={t("canvas.timeline.locateNode")}
						>
							{r.node.title}
						</button>
						<span className="canvas-timeline-sub">
							{statuses[r.node.status]?.label ?? r.node.status}
							{r.loops > 0 ? ` · ${t("canvas.timeline.retryCount", { count: r.loops })}` : ""}
							{r.count > 0
								? ` · ${t("canvas.timeline.logCount", { count: r.count })}`
								: ` · ${t("canvas.timeline.noLogs")}`}
							{r.dur != null ? ` · ${fmtDur(r.dur)}` : ""}
							{r.start != null ? ` · ${fmtTime(r.start)}` : ""}
						</span>
						{r.node.status === "error" && (
							<button
								type="button"
								className="canvas-btn"
								onClick={() => onRunNode(r.node.id)}
								title={r.lastErr || t("canvas.timeline.retryNode")}
							>
								{t("canvas.timeline.retry")}
							</button>
						)}
					</div>
				))}
				{rows.length === 0 && <div className="canvas-timeline-empty">{t("canvas.timeline.noNodes")}</div>}
			</div>
		</div>
	);
}
