import { memo, useState } from "react";
import { useT } from "../i18n";
import type { BgTaskItem, BgTaskSnapshot } from "../bg-task-list";

function dotClassFor(status: BgTaskItem["status"]): string {
	switch (status) {
		case "running":
			return "bgc-dot run";
		case "completed":
			return "bgc-dot ok";
		case "failed":
			return "bgc-dot err";
		case "killed":
			return "bgc-dot stop";
	}
}

const Row = memo(function Row({ task }: { task: BgTaskItem }) {
	const exitText = task.exitCode !== undefined && task.exitCode !== 0 ? `exit=${task.exitCode}` : "";
	const label = `${task.id} ${task.status}${task.exitCode !== undefined ? ` exit=${task.exitCode}` : ""}${task.name ? ` — ${task.name}` : ""}${task.outputPath ? `\n${task.outputPath}` : ""}`;
	return (
		<div className="bgc-row" title={label}>
			<span className={dotClassFor(task.status)} aria-hidden />
			<span className="bgc-id">{task.id}</span>
			<span className="bgc-status">{task.status}</span>
			{exitText && <span className="bgc-exit">{exitText}</span>}
			{task.age && <span className="bgc-age">{task.age}</span>}
			{(task.name || task.outputPath) && <span className="bgc-name">{task.name || task.outputPath}</span>}
		</div>
	);
});

export interface BgTaskClusterProps {
	snapshot: BgTaskSnapshot;
	rawOutput: string;
	isError?: boolean;
	running?: boolean;
}

export const BgTaskCluster = memo(function BgTaskCluster({
	snapshot,
	rawOutput,
	isError = false,
	running = false,
}: BgTaskClusterProps) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [showRaw, setShowRaw] = useState(false);

	if (snapshot.items.length === 0) return null;

	const countText = snapshot.truncated ? `${snapshot.items.length}/${snapshot.total}` : String(snapshot.total);
	const summary =
		snapshot.runningCount > 0
			? t("bgTasksRunning", { count: countText, running: snapshot.runningCount })
			: t("bgTasksSummary", { count: countText });

	return (
		<div className="bgc">
			<div className="bgc-head">
				<button
					type="button"
					className="bgc-toggle"
					onClick={() => setOpen((v) => !v)}
					aria-expanded={open}
					title={t("expandMsg")}
				>
					<span className="bgc-caret" aria-hidden>
						{open ? "▾" : "▸"}
					</span>
					<span className="bgc-title">◉ {t("bgTasksTitle")}</span>
					<span className="bgc-count">{summary}</span>
				</button>
				<button type="button" className="bgc-raw-btn" onClick={() => setShowRaw((v) => !v)} aria-pressed={showRaw}>
					{showRaw ? t("bgTasksHideRaw") : t("bgTasksRaw")}
				</button>
			</div>
			{open && (
				<div className="bgc-list" role="list">
					{snapshot.items.map((task) => (
						<Row key={task.id} task={task} />
					))}
				</div>
			)}
			{showRaw && (
				<div className="toolcall-output bgc-raw">
					<div className="toolcall-output-label">
						{isError ? t("errorOutput") : t("output")}
						{running && <span className="cursor" />}
					</div>
					<pre>{rawOutput}</pre>
				</div>
			)}
		</div>
	);
});
