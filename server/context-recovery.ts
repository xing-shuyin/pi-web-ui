import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";

/**
 * Recovery index appended to every compaction summary.
 *
 * Compaction is one-way: the folded entries leave the model's context for good
 * (`docs/tool-context-budget.md`). The transcript itself is append-only on disk
 * (SDK `docs/session-format.md#CompactionEntry`), so the missing piece is not
 * storage but *addressing*: without an entry id and a line number the model
 * cannot ask for a specific turn again.
 *
 * This block supplies exactly that, deterministically, from the session file.
 * It deliberately adds no new tool and writes no derived copy of the
 * transcript: the JSONL stays the single source of truth, the block is the
 * index into it, and `read` / `grep` are the access path.
 */

const START = "<context-recovery>";
const END = "</context-recovery>";
const BLOCK = /<context-recovery>[\s\S]*?<\/context-recovery>/g;

/** Newest folded user turns kept word for word; the rest stay addressable by id. */
export const MAX_VERBATIM_USER_TURNS = 3;
/** Per-turn clipping so three verbatim turns cannot crowd out real context. */
export const MAX_VERBATIM_CHARS = 300;
/** Older folded user turns kept as id + line only. */
export const MAX_INDEXED_USER_TURNS = 12;
/** A transcript larger than this is not scanned for line numbers. */
export const MAX_TRANSCRIPT_SCAN_BYTES = 64 * 1024 * 1024;
/** Only the head of a transcript line is buffered; entry ids live there. */
const ENTRY_HEAD_CHARS = 256;
const ENTRY_ID = /^\{"type":"[a-z_]+","id":"([A-Za-z0-9_-]{1,64})"/;
/** `read` refuses a single line above its per-call byte budget. */
const READ_LINE_LIMIT = `${Math.round(DEFAULT_MAX_BYTES / 1024)}KB`;

interface RecoveryMessage {
	role?: unknown;
	content?: unknown;
}

interface RecoveryEntry {
	id?: unknown;
	parentId?: unknown;
	type?: unknown;
	message?: RecoveryMessage;
}

export interface RecoverySessionLike {
	sessionManager?: {
		getSessionFile?: () => string | undefined;
		getEntries?: () => unknown[];
	} | null;
}

/** Drop previously injected blocks so every summary carries exactly one. */
export function stripRecoveryBlocks(text: string): string {
	return text.replace(BLOCK, "").trim();
}

/** Flatten message content to display text: text blocks only, whitespace collapsed. */
export function clipUserText(content: unknown, limit = MAX_VERBATIM_CHARS): string {
	const parts: string[] = [];
	if (typeof content === "string") parts.push(content);
	else if (Array.isArray(content)) {
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const typed = block as { type?: unknown; text?: unknown };
			if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
		}
	}
	const text = parts.join(" ").replace(/\s+/g, " ").trim();
	if (!text) return "";
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** Entries folded by this compaction, oldest first, via the parent chain. */
export function foldedEntries(entries: RecoveryEntry[], boundary: string | undefined): RecoveryEntry[] {
	if (!entries.length) return [];
	const byId = new Map<string, RecoveryEntry>();
	for (const entry of entries) if (typeof entry.id === "string") byId.set(entry.id, entry);
	// No boundary, or one that is not on the session yet (retain-none stores the
	// compaction's own id): treat the whole transcript as folded rather than
	// hiding it.
	if (!boundary || !byId.has(boundary)) return entries;
	const chain: RecoveryEntry[] = [];
	const seen = new Set<string>();
	let current: string | undefined = boundary;
	while (current && byId.has(current) && !seen.has(current)) {
		seen.add(current);
		const entry: RecoveryEntry = byId.get(current)!;
		chain.push(entry);
		current = typeof entry.parentId === "string" ? entry.parentId : undefined;
	}
	// Boundary itself is the first *kept* entry, so it is not folded.
	chain.shift();
	return chain.reverse();
}

/**
 * Line number of each entry id in the JSONL transcript. Entry lines start with
 * `{"type":"…","id":"…"`, so only the head of each line is buffered: tool
 * payloads of any size stream past without being held in memory.
 */
export async function entryLineNumbers(file: string, ids: Set<string>): Promise<Map<string, number>> {
	const found = new Map<string, number>();
	if (!ids.size) return found;
	try {
		const info = await stat(file);
		if (!info.isFile() || info.size > MAX_TRANSCRIPT_SCAN_BYTES) return found;
	} catch {
		return found;
	}
	const stream = createReadStream(file, { encoding: "utf8" });
	let head = "";
	let inLine = false;
	let line = 0;
	let done = false;
	for await (const chunk of stream) {
		const text = chunk as string;
		let index = 0;
		while (index <= text.length) {
			const newline = text.indexOf("\n", index);
			const end = newline === -1 ? text.length : newline;
			if (!inLine) {
				head = text.slice(index, Math.min(end, index + ENTRY_HEAD_CHARS));
				inLine = true;
			}
			if (newline === -1) break;
			line += 1;
			const id = ENTRY_ID.exec(head)?.[1];
			if (id && ids.has(id) && !found.has(id)) found.set(id, line);
			if (found.size === ids.size) done = true;
			head = "";
			inLine = false;
			index = newline + 1;
			if (done) break;
		}
		if (done) break;
	}
	// A transcript without a trailing newline still has a countable last line.
	if (!done && inLine && head.trim()) {
		const id = ENTRY_ID.exec(head)?.[1];
		if (id && ids.has(id) && !found.has(id)) found.set(id, line + 1);
	}
	return found;
}

/**
 * The `<context-recovery>` block for one compaction, or `""` when there is no
 * persisted transcript (ephemeral session, missing session manager, no folded
 * user turn). Never throws: a compaction must not fail because its index did.
 */
export async function buildContextRecoveryBlock(session: unknown, compaction: unknown): Promise<string> {
	try {
		const manager = (session as RecoverySessionLike | undefined)?.sessionManager;
		const file = manager?.getSessionFile?.();
		if (!file) return "";
		const entries = manager?.getEntries?.() as RecoveryEntry[] | undefined;
		if (!Array.isArray(entries) || !entries.length) return "";
		const boundary = (compaction as { firstKeptEntryId?: unknown } | undefined)?.firstKeptEntryId;

		const users = foldedEntries(entries, typeof boundary === "string" ? boundary : undefined).filter(
			(entry): entry is RecoveryEntry =>
				entry.type === "message" && typeof entry.id === "string" && entry.message?.role === "user",
		);
		if (!users.length) return "";

		const ids = new Set<string>();
		for (const entry of users.slice(-(MAX_VERBATIM_USER_TURNS + MAX_INDEXED_USER_TURNS))) ids.add(entry.id as string);
		const lines = await entryLineNumbers(file, ids);
		const at = (id: string): string => {
			const line = lines.get(id);
			return line === undefined ? "" : ` L${line}`;
		};

		const verbatim = users.slice(-MAX_VERBATIM_USER_TURNS);
		const older = users.slice(0, Math.max(0, users.length - MAX_VERBATIM_USER_TURNS)).slice(-MAX_INDEXED_USER_TURNS);

		const sections: string[] = [
			`Folded history is out of context but still on disk: the session transcript is JSON lines, one entry per line.`,
			`Transcript: ${JSON.stringify(file)}`,
			`Locate an entry: grep({pattern:"\\"id\\":\\"<entryId>\\"", path:<transcript>}) gives its line, then read({path:<transcript>, offset:<line>, limit:1}). A transcript line above ${READ_LINE_LIMIT} cannot be read in one call (the read tool rejects it); large tool outputs are reachable through their context-evidence handles instead.`,
		];
		const quoted = verbatim
			.map((entry) => {
				const text = clipUserText(entry.message?.content);
				return text ? `- ${entry.id}${at(entry.id as string)}: ${JSON.stringify(text)}` : "";
			})
			.filter(Boolean);
		if (quoted.length) {
			sections.push(`Folded user turns, verbatim (trimmed to ${MAX_VERBATIM_CHARS} chars, oldest first):`, ...quoted);
		}
		const indexed = older.map((entry) => `- ${entry.id}${at(entry.id as string)}`).filter(Boolean);
		if (indexed.length) sections.push("Earlier folded user turns (id and transcript line):", ...indexed);
		sections.push("Re-read a turn before quoting or acting on it; this index is not a substitute for its text.");

		return `${START}\n${sections.join("\n")}\n${END}`;
	} catch {
		return "";
	}
}
