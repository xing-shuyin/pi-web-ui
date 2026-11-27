// Compact parser for pi-background-tasks snapshot lists rendered in chat.
// Source format: `formatSnapshotList` in pi-background-tasks `src/core/common.ts`:
//   `<icon> <id> <status> <age>[ exit=N][ pid=N][ telemetry] — <name>[ error=...]`
//   `    output: <abs path>`
// Single purpose: turn that plain text into a tiny cluster so chat stays
// one line when collapsed. Returns [] when the text is not a task list
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

const ANSI_RE = /\x1b\[[0-9;]*m/gu;
const EMPTY_RE = /no background tasks/i;
// shortcut: icon?, id, status, rest — icon/status spellings stay in one place.
const LINE_RE = /^[▶✓✗■]?\s*([A-Za-z0-9_-]{1,64})\s+(running|completed|done|failed|error|killed|stopped)\s*(.*)$/;
const OUTPUT_RE = /^output:\s*(\S.*)$/;
const EXIT_RE = /\bexit=(-?\d{1,6})/;
const EM_DASH_RE = /—|--| - /;

function normStatus(raw: string): BgTaskStatus {
	if (raw === "done") return "completed";
	if (raw === "error") return "failed";
	if (raw === "stopped") return "killed";
	return raw as BgTaskStatus;
}

export function parseBgTaskList(text: string): BgTaskItem[] {
	if (!text || !text.includes("running") && !text.includes("completed") && !text.includes("failed") && !text.includes("killed") && !text.includes("done")) {
		if (!/▶|✓|✗|■/.test(text)) return [];
	}
	const clean = text.replace(ANSI_RE, "");
	if (EMPTY_RE.test(clean)) return [];
	const out: BgTaskItem[] = [];
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
		const dashIdx = (() => {
			const e = EM_DASH_RE.exec(rest);
			return e?.index ?? -1;
		})();
		const head = dashIdx >= 0 ? rest.slice(0, dashIdx).trim() : rest;
		const name = (dashIdx >= 0 ? rest.slice(dashIdx + 1).trim() : "").replace(/\s*error=.*$/, "").trim()
			|| head.split(/\s{2,}/)[0].trim();
		cur = {
			id: m[1],
			status: normStatus(m[2]),
			age: head.split(/\s+/)[0] || "",
			name: name.slice(0, 120),
			outputPath: "",
			...(exitM ? { exitCode: Number(exitM[1]) } : {}),
		};
		out.push(cur);
		if (out.length >= 50) break;
	}
	return out.filter((t) => t.outputPath || t.name);
}

export function countBgRunning(items: readonly BgTaskItem[]): number {
	let n = 0;
	for (const t of items) if (t.status === "running") n++;
	return n;
}
