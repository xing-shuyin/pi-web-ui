import { memo, useMemo, useState } from "react";
import { useT } from "../i18n";
import { countBgRunning, parseBgTaskList, type BgTaskItem } from "../bg-task-list";

function shortId(id: string): string {
	return id.length > 14 ? `${id.slice(0, 12)}…` : id;
}

function shortName(name: string): string {
	return name.length > 60 ? `${name.slice(0, 59)}…` : name;
}

const Row = memo(function Row({ task }: { task: BgTaskItem }) {
	const dotClass =
		task.status === "running"
			? "bgc-dot run"
			: task.status === "completed"
				? "bgc-dot ok"
				: task.status === "failed"
					? "bgc-dot err"
					: "bgc-dot stop";
	const label = `${task.id} ${task.status}${task.exitCode !== undefined ? ` exit=${task.exitCode}` : ""} — ${task.name || task.outputPath}`;
	return (
		<div className="bgc-row" title={label}>
			<span className={dotClass} aria-hidden />
			<span className="bgc-id">{shortId(task.id)}</span>
			<span className="bgc-status">{task.status}</span>
			{task.age && <span className="bgc-age">{task.age}</span>}
			{task.name && <span className="bgc-name">{shortName(task.name)}</span>}
		</div>
	);
});

// shortcut: collapsed one-liner; click expands. Additive only — returns null
// when the tool output is not a bg task list, so nothing else changes.
export const BgTaskCluster = memo(function BgTaskCluster({ text }: { text: string }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const items = useMemo(() => parseBgTaskList(text), [text]);
	if (items.length === 0) return null;
	const running = countBgRunning(items);
	const summary = running > 0 ? `${items.length} · ${running} running` : `${items.length}`;
	return (
		<div className="bgc">
			<button type="button" className="bgc-head" onClick={() => setOpen((v) => !v)} title={t("expandMsg")}>
				<span className="bgc-caret" aria-hidden>
					{open ? "▾" : "▸"}
				</span>
				<span className="bgc-title">◉ bg tasks</span>
				<span className="bgc-count">{summary}</span>
			</button>
			{open && (
				<div className="bgc-list" role="list">
					{items.map((task) => (
						<Row key={task.id} task={task} />
					))}
				</div>
			)}
		</div>
	);
});
