/// <reference lib="dom" />

export function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function truncate(text: string, max: number): string {
	if (max <= 0) return "";
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function code(value: string): string {
	const flat = collapse(value);
	const ticks = "`".repeat(Math.max(1, longestTickRun(flat) + 1));
	const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
	return `${ticks}${pad}${flat}${pad}${ticks}`;
}

function longestTickRun(text: string): number {
	let best = 0;
	let run = 0;
	for (const ch of text) {
		run = ch === "`" ? run + 1 : 0;
		if (run > best) best = run;
	}
	return best;
}
