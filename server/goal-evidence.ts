import { checkBashCommandDanger } from "./approval-rules.js";

export interface EvidenceEntry {
	tool: string;
	hint: string;
	tail?: string;
	error?: boolean;
}

export interface EvidenceOptions {
	maxEntries?: number;
	maxTailChars?: number;
	maxTotalChars?: number;
	window?: number;
}

const DEFAULT_MAX_ENTRIES = 8;
const DEFAULT_MAX_TAIL_CHARS = 400;
const DEFAULT_MAX_TOTAL_CHARS = 6000;
const DEFAULT_WINDOW = 200;

const HINT_KEYS = ["command", "path", "file_path", "filePath", "pattern", "query", "url", "name"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function dangerPrefix(hits: { label: string }[]): string {
	if (hits.length === 0) return "";
	const labels = [...new Set(hits.map((h) => h.label))];
	return `⚠️ [${labels.join(" / ")}] `;
}

function oneLine(v: unknown, max = 120): string {
	if (typeof v !== "string") return "";
	const s = v.trim().replace(/\s+/g, " ");
	if (!s) return "";
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

function tailOf(v: unknown, max: number): string {
	if (typeof v !== "string") return "";
	const s = v.trim();
	if (!s) return "";
	return s.length > max ? `…${s.slice(-max)}` : s;
}

function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c) => (isRecord(c) && typeof c.text === "string" ? c.text : ""))
		.filter(Boolean)
		.join("\n");
}

export function collectToolEvidence(messages: unknown, opts: EvidenceOptions = {}): EvidenceEntry[] {
	if (!Array.isArray(messages) || messages.length === 0) return [];
	const maxEntries = Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES);
	const maxTail = Math.max(40, opts.maxTailChars ?? DEFAULT_MAX_TAIL_CHARS);
	const window = Math.max(1, opts.window ?? DEFAULT_WINDOW);
	const recent = messages.slice(-window);

	const calls = new Map<string, { name: string; hint: string }>();
	for (const m of recent) {
		if (!isRecord(m) || m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const b of m.content) {
			if (!isRecord(b) || b.type !== "toolCall") continue;
			const id = typeof b.toolCallId === "string" ? b.toolCallId : typeof b.id === "string" ? b.id : "";
			if (!id) continue;
			const args = isRecord(b.args) ? b.args : undefined;
			let hint = "";
			if (args) {
				for (const k of HINT_KEYS) {
					hint = oneLine(args[k]);
					if (hint) break;
				}
			}
			calls.set(id, { name: typeof b.name === "string" ? b.name : "", hint });
		}
	}

	const out: EvidenceEntry[] = [];
	for (let i = recent.length - 1; i >= 0 && out.length < maxEntries; i--) {
		const m = recent[i];
		if (!isRecord(m)) continue;
		if (m.role === "bashExecution") {
			const cmd = typeof m.command === "string" ? m.command : "";
			const dangerHits = checkBashCommandDanger(cmd);
			const prefix = dangerPrefix(dangerHits);
			out.push({
				tool: "bash",
				hint: `${prefix}${oneLine(m.command)}`,
				tail: tailOf(m.output, maxTail),
				error: typeof m.exitCode === "number" && m.exitCode !== 0,
			});
			continue;
		}
		if (m.role !== "toolResult") continue;
		const id = typeof m.toolCallId === "string" ? m.toolCallId : "";
		const call = id ? calls.get(id) : undefined;
		const toolName = typeof m.toolName === "string" ? m.toolName.trim() : "";
		const effectiveTool = toolName || call?.name || "tool";
		let hint = call?.hint ?? "";
		if (effectiveTool === "bash" && hint) {
			const dangerHits = checkBashCommandDanger(hint);
			if (dangerHits.length > 0) {
				hint = `${dangerPrefix(dangerHits)}${hint}`;
			}
		}
		out.push({
			tool: effectiveTool,
			hint,
			tail: tailOf(resultText(m.content), maxTail),
			error: m.isError === true,
		});
	}
	out.reverse();
	return out;
}

export function formatEvidenceDigest(entries: EvidenceEntry[], opts: EvidenceOptions = {}): string {
	if (entries.length === 0) return "";
	const maxTotal = Math.max(200, opts.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS);
	const bodies: string[] = [];
	let used = 0;
	let omitted = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]!;
		const head = `${e.tool}${e.error ? " (failed)" : ""}${e.hint ? `: ${e.hint}` : ""}`;
		const body = e.tail ? `${head}\n   out: ${e.tail}` : head;
		if (used + body.length + 4 > maxTotal) {
			omitted = i + 1;
			break;
		}
		bodies.push(body);
		used += body.length + 4;
	}
	bodies.reverse();
	const blocks = bodies.map((b, idx) => `${idx + 1}. ${b}`);
	const head = omitted > 0 ? `(${omitted} earlier event(s) omitted for brevity)\n` : "";
	return head + blocks.join("\n");
}

export function sessionMessagesOf(session: unknown): unknown[] {
	try {
		const s = session as { messages?: unknown; agent?: { state?: { messages?: unknown } } } | undefined;
		const msgs = s?.messages ?? s?.agent?.state?.messages;
		return Array.isArray(msgs) ? msgs : [];
	} catch {
		return [];
	}
}

export function buildEvidenceDigest(messages: unknown, opts: EvidenceOptions = {}): string {
	return formatEvidenceDigest(collectToolEvidence(messages, opts), opts);
}
