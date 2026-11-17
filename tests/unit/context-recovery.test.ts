import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildContextRecoveryBlock,
	clipUserText,
	entryLineNumbers,
	foldedEntries,
	MAX_VERBATIM_CHARS,
	MAX_VERBATIM_USER_TURNS,
	stripRecoveryBlocks,
} from "../../server/context-recovery.js";
import { installCompactionInstructions } from "../../server/compaction-instructions.js";

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function transcript(lines: unknown[]): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-recovery-"));
	dirs.push(dir);
	const file = join(dir, "session.jsonl");
	await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
	return file;
}

function message(id: string, parentId: string | null, role: string, content: unknown) {
	return { type: "message", id, parentId, timestamp: "2026-11-17T03:15:00.000Z", message: { role, content } };
}

function text(value: string) {
	return [{ type: "text", text: value }];
}

function sessionOf(file: string, entries: unknown[]) {
	return { sessionManager: { getSessionFile: () => file, getEntries: () => entries } };
}

describe("context recovery handles", () => {
	it("collapses whitespace and clips long user text", () => {
		expect(clipUserText(text("a\n\n  b\tc "))).toBe("a b c");
		expect(clipUserText(undefined)).toBe("");
		const long = "x".repeat(MAX_VERBATIM_CHARS + 50);
		expect(clipUserText(long)).toHaveLength(MAX_VERBATIM_CHARS + 1);
		expect(clipUserText(long).endsWith("…")).toBe(true);
	});

	it("walks the folded parent chain and excludes the kept boundary", () => {
		const entries = [
			{ type: "message", id: "u1", parentId: null },
			{ type: "message", id: "a1", parentId: "u1" },
			{ type: "message", id: "u2", parentId: "a1" },
			{ type: "message", id: "a2", parentId: "u2" },
			{ type: "message", id: "u3", parentId: "a2" },
		];
		expect(foldedEntries(entries, "u3").map((entry) => entry.id)).toEqual(["u1", "a1", "u2", "a2"]);
		expect(foldedEntries(entries, "u2").map((entry) => entry.id)).toEqual(["u1", "a1"]);
		// A boundary the session does not hold yet (retain-none) must not hide history.
		expect(foldedEntries(entries, "retain-none").map((entry) => entry.id)).toEqual(["u1", "a1", "u2", "a2", "u3"]);
		expect(foldedEntries(entries, undefined).map((entry) => entry.id)).toEqual(["u1", "a1", "u2", "a2", "u3"]);
	});

	it("maps entry ids to transcript line numbers without parsing payloads", async () => {
		const file = await transcript([
			{ type: "session", version: 3, id: "sess" },
			{ type: "model_change", id: "m1", parentId: null, provider: "p", modelId: "m" },
			message("u1", "m1", "user", text("first")),
			message("a1", "u1", "assistant", text('answer with "id":"u1" inside')),
		]);
		const lines = await entryLineNumbers(file, new Set(["u1", "a1", "missing"]));
		expect([...lines.entries()]).toEqual([
			["u1", 3],
			["a1", 4],
		]);
	});

	it("stops scanning a missing or oversized transcript instead of failing", async () => {
		expect((await entryLineNumbers(join(tmpdir(), "nope-missing-file.jsonl"), new Set(["u1"]))).size).toBe(0);
	});

	it("builds a block that makes folded user turns addressable", async () => {
		const entries = [
			{ type: "session", version: 3, id: "sess" },
			message("u1", null, "user", text("original requirement one")),
			message("a1", "u1", "assistant", text("answer")),
			message("u2", "a1", "user", text("second requirement")),
			message("u3", "u2", "user", text("third requirement")),
			message("u4", "u3", "user", text("kept tail")),
		];
		const file = await transcript(entries);
		const block = await buildContextRecoveryBlock(sessionOf(file, entries), { firstKeptEntryId: "u4" });
		expect(block.startsWith("<context-recovery>")).toBe(true);
		expect(block.endsWith("</context-recovery>")).toBe(true);
		expect(block).toContain(JSON.stringify(file));
		expect(block).toContain("grep(");
		expect(block).toContain('"original requirement one"');
		expect(block).toContain("u1 L2");
		expect(block).toContain("u2 L4");
		expect(block).toContain("u3 L5");
		expect(block).not.toContain("kept tail");
		expect(block).not.toContain("answer");
	});

	it("keeps only the newest user turns verbatim and indexes the rest by id", async () => {
		const entries: unknown[] = [{ type: "session", version: 3, id: "sess" }];
		let parent: string | null = null;
		for (let index = 0; index < MAX_VERBATIM_USER_TURNS + 3; index++) {
			const id = `u${index}`;
			entries.push(message(id, parent, "user", text(`requirement ${index}`)));
			parent = id;
		}
		entries.push(message("keep", parent, "user", text("kept")));
		const file = await transcript(entries);
		const block = await buildContextRecoveryBlock(sessionOf(file, entries), { firstKeptEntryId: "keep" });
		for (let index = MAX_VERBATIM_USER_TURNS + 2; index > 2; index--) {
			expect(block).toContain(`"requirement ${index}"`);
		}
		expect(block).not.toContain('"requirement 0"');
		expect(block).toContain("- u0 L2");
	});

	it("returns an empty block when there is nothing to recover from", async () => {
		expect(await buildContextRecoveryBlock({}, { firstKeptEntryId: "u1" })).toBe("");
		expect(await buildContextRecoveryBlock({ sessionManager: { getSessionFile: () => undefined } }, {})).toBe("");
		const file = await transcript([{ type: "session", version: 3, id: "sess" }]);
		const assistantOnly = [message("a1", null, "assistant", text("only answer"))];
		expect(await buildContextRecoveryBlock(sessionOf(file, assistantOnly), { firstKeptEntryId: "a1" })).toBe("");
	});

	it("never throws when the transcript cannot be read", async () => {
		const entries = [message("u1", null, "user", text("requirement")), message("u2", "u1", "user", text("tail"))];
		const missing = join(tmpdir(), "pi-recovery-missing", "session.jsonl");
		const block = await buildContextRecoveryBlock(sessionOf(missing, entries), { firstKeptEntryId: "u2" });
		expect(block).toContain("u1");
		expect(block).not.toContain("u1 L");
	});

	it("strips an earlier injected block and keeps model text intact", () => {
		const text = "## Goal\nship it\n\n<context-recovery>\nstale\n</context-recovery>\n\n## Next\nrun tests";
		expect(stripRecoveryBlocks(text)).toBe("## Goal\nship it\n\n\n\n## Next\nrun tests");
	});
});

describe("compaction summary enrichment", () => {
	it("appends exactly one recovery block and replaces a stale one", async () => {
		const entries = [
			message("u1", null, "user", text("original requirement")),
			message("u2", "u1", "user", text("kept tail")),
		];
		const file = await transcript(entries);
		const session = {
			sessionManager: { getSessionFile: () => file, getEntries: () => entries },
			_runDefaultCompaction(
				prep: unknown,
				model: unknown,
				instructions: unknown,
				signal: unknown,
				reason: unknown,
				...rest: unknown[]
			) {
				return Promise.resolve({
					summary: "## Goal\nkeep\n\n<context-recovery>\nstale block\n</context-recovery>",
					firstKeptEntryId: "u2",
					tokensBefore: 10,
				});
			},
		};
		expect(installCompactionInstructions(session)).toBe(true);
		const result = (await session._runDefaultCompaction({}, {}, undefined, undefined, "manual")) as { summary: string };
		expect(result.summary.match(/<context-recovery>/g)).toHaveLength(1);
		expect(result.summary).not.toContain("stale block");
		expect(result.summary).toContain("original requirement");
	});

	it("leaves the summary untouched without a persisted session", async () => {
		const session = {
			_runDefaultCompaction(
				_prep: unknown,
				_model: unknown,
				_instructions: unknown,
				_signal: unknown,
				_reason: unknown,
				..._rest: unknown[]
			) {
				return Promise.resolve({ summary: "## Goal\nkeep", firstKeptEntryId: "e1", tokensBefore: 1 });
			},
		};
		installCompactionInstructions(session);
		const result = (await session._runDefaultCompaction({}, {}, undefined, undefined, "manual")) as {
			summary: string;
		};
		expect(result.summary).toBe("## Goal\nkeep");
	});

	it("keeps the evidence index when the recovery index is unavailable", async () => {
		const getEvidenceIndex = vi.fn(async () => "[Context evidence: 1 files.]\ncontext-evidence:abc");
		const session = {
			_runDefaultCompaction(
				_prep: unknown,
				_model: unknown,
				_instructions: unknown,
				_signal: unknown,
				_reason: unknown,
				..._rest: unknown[]
			) {
				return Promise.resolve({ summary: "## Goal\nkeep", firstKeptEntryId: "e1", tokensBefore: 1 });
			},
		};
		installCompactionInstructions(session, { getEvidenceIndex });
		const result = (await session._runDefaultCompaction({}, {}, undefined, undefined, "manual")) as {
			summary: string;
		};
		expect(result.summary).toContain("## Goal\nkeep");
		expect(result.summary).toContain("[Context evidence: 1 files.]");
	});
});
