// Compact parser for pi-background-tasks snapshot lists rendered in chat.
// Source format: `formatSnapshotList` in pi-background-tasks `src/core/common.ts`:
//   `<icon> <id> <status> <age>[ exit=N][ pid=N][ telemetry] — <name>[ error=...]`
//   `    output: <abs path>`
// Single purpose: turn that plain text into a structured snapshot so chat stays
// compact when collapsed. Returns empty items when the text is not a task list
// (e.g. log content, "No background tasks…"). Pure, no DOM.

export type BgTaskStatus = "running" | "completed" | "failed" | "killed";

export interface BgTaskItem {
	id: string;
	status: BgTaskStatus;
	age: string;
	name: string;
	outputPath: string;
	exitCode?: number;
}

export interface BgTaskSnapshot {
	items: BgTaskItem[];
	total: number;
	runningCount: number;
	truncated: boolean;
}

const MAX_DISPLAY_ITEMS = 50;
const ANSI_RE = /\x1b\[[0-9;]*m/gu;
const EMPTY_RE = /no background tasks/i;
const LINE_RE = /^[▶✓✗■]?\s*([A-Za-z0-9_-]{1,64})\s+(running|completed|done|failed|error|killed|stopped)\s*(.*)$/;
const OUTPUT_RE = /^output:\s*(\S.*)$/;
const EXIT_RE = /\bexit=(-?\d{1,6})/;
const DASH_SEP_RE = /\s(?:—|--|-)\s|—/;

function normStatus(raw: string): BgTaskStatus {
	if (raw === "done") return "completed";
	if (raw === "error") return "failed";
	if (raw === "stopped") return "killed";
	return raw as BgTaskStatus;
}

export function parseBgTaskSnapshot(text: string): BgTaskSnapshot {
	if (!text) return { items: [], total: 0, runningCount: 0, truncated: false };
	const clean = text.replace(ANSI_RE, "");
	if (EMPTY_RE.test(clean)) return { items: [], total: 0, runningCount: 0, truncated: false };

	const parsed: BgTaskItem[] = [];
	let cur: BgTaskItem | null = null;

	for (const rawLine of clean.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;

		const om = OUTPUT_RE.exec(line);
		if (om && cur) {
			cur.outputPath = om[1].trim();
			continue;
		}

		const m = LINE_RE.exec(line);
		if (!m) {
			cur = null;
			continue;
		}

		const rest = m[3].trim();
		const exitM = EXIT_RE.exec(rest);
		const dashMatch = DASH_SEP_RE.exec(rest);
		const head = dashMatch ? rest.slice(0, dashMatch.index).trim() : rest;
		const rawName = dashMatch ? rest.slice(dashMatch.index + dashMatch[0].length).trim() : "";
		const name = rawName.replace(/\s+error=.*$/, "").trim();

		cur = {
			id: m[1],
			status: normStatus(m[2]),
			age: head.split(/\s+/)[0] || "",
			name: name.slice(0, 120),
			outputPath: "",
			...(exitM ? { exitCode: Number(exitM[1]) } : {}),
		};
		parsed.push(cur);
	}

	const valid = parsed.filter((t) => t.outputPath || t.name);
	let runningCount = 0;
	for (const t of valid) {
		if (t.status === "running") runningCount++;
	}
	const truncated = valid.length > MAX_DISPLAY_ITEMS;
	return {
		items: truncated ? valid.slice(0, MAX_DISPLAY_ITEMS) : valid,
		total: valid.length,
		runningCount,
		truncated,
	};
}

export function parseBgTaskList(text: string): BgTaskItem[] {
	return parseBgTaskSnapshot(text).items;
}

export function countBgRunning(items: readonly BgTaskItem[]): number {
	let n = 0;
	for (const t of items) if (t.status === "running") n++;
	return n;
}
