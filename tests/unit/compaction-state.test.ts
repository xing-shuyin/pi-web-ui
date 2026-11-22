import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as atomic from "../../server/atomic-file.js";
import { consumeInterrupted, finish, mark } from "../../server/compaction-state.js";
import { repairSessionTranscript } from "../../server/compaction-markers.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

let dir: string;
let file: string;
let sidecar: string;
const state = { reason: "manual", startedAt: 12345 };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "compaction-state-"));
	file = join(dir, "session.jsonl");
	sidecar = `${file}.compaction-state.json`;
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

describe("compaction sidecar", () => {
	it("persists across module reload and consumes exactly once", async () => {
		expect(await mark(file, state)).toBe(true);
		expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual({ version: 1, ...state });
		vi.resetModules();
		const reopened = await import("../../server/compaction-state.js");
		expect(reopened.consumeInterrupted(file)).toEqual(state);
		expect(reopened.consumeInterrupted(file)).toBeUndefined();
		expect(existsSync(sidecar)).toBe(false);
	});

	it("finish is idempotent and prevents a false interruption", async () => {
		await mark(file, state);
		expect(finish(file)).toBe(true);
		expect(finish(file)).toBe(false);
		expect(consumeInterrupted(file)).toBeUndefined();
	});

	it.each([undefined, null, ""])("skips nonpersistent/ephemeral session %s", async (file) => {
		expect(await mark(file, state)).toBe(false);
		expect(finish(file)).toBe(false);
		expect(consumeInterrupted(file)).toBeUndefined();
		expect(readdirSync(dir)).toEqual([]);
	});

	it("isolates sessions and replaces pending state atomically", async () => {
		const other = join(dir, "other.jsonl");
		const next = { reason: "auto", startedAt: 54321 };
		await mark(file, state);
		await mark(other, state);
		await mark(file, next);
		expect(consumeInterrupted(file)).toEqual(next);
		expect(consumeInterrupted(other)).toEqual(state);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("does not create a missing transcript or change an existing transcript", async () => {
		await mark(file, state);
		expect(existsSync(file)).toBe(false);
		const transcript = '{"type":"session","id":"s1"}\n';
		writeFileSync(file, transcript);
		await mark(file, state);
		consumeInterrupted(file);
		await mark(file, state);
		finish(file);
		expect(readFileSync(file, "utf8")).toBe(transcript);
	});

	it("propagates write failure and preserves the last durable state", async () => {
		await mark(file, state);
		const failure = new Error("disk full");
		vi.spyOn(atomic, "writeJsonAtomic").mockRejectedValueOnce(failure);
		await expect(mark(file, { reason: "auto", startedAt: 99999 })).rejects.toThrow(failure);
		expect(consumeInterrupted(file)).toEqual(state);
	});

	it("propagates actual atomic rename failure and cleans temporary files", async () => {
		mkdirSync(sidecar);
		await expect(mark(file, state)).rejects.toThrow();
		expect(readdirSync(dir)).toEqual(["session.jsonl.compaction-state.json"]);
	});

	it("propagates clear/consume failure without consuming the durable state", async () => {
		await mark(file, state);
		const failure = Object.assign(new Error("access denied"), { code: "EACCES" });
		vi.mocked(rmSync).mockImplementationOnce(() => {
			throw failure;
		});
		expect(() => finish(file)).toThrow(failure);
		vi.mocked(rmSync).mockImplementationOnce(() => {
			throw failure;
		});
		expect(() => consumeInterrupted(file)).toThrow(failure);
		expect(existsSync(sidecar)).toBe(true);
		expect(consumeInterrupted(file)).toEqual(state);
	});

	it.each(["{", '{"version":2,"reason":"auto","startedAt":1}', '{"version":1,"reason":"auto","startedAt":null}'])(
		"preserves invalid state and reports it: %s",
		(raw) => {
			writeFileSync(sidecar, raw);
			expect(() => consumeInterrupted(file)).toThrow();
			expect(readFileSync(sidecar, "utf8")).toBe(raw);
		},
	);

	it("rejects invalid pending state before replacing durable data", async () => {
		await mark(file, state);
		await expect(mark(file, { reason: "auto", startedAt: NaN })).rejects.toThrow("Invalid compaction state");
		expect(consumeInterrupted(file)).toEqual(state);
	});

	it("keeps legacy pending repair and SDK done entries compatible", async () => {
		const raw =
			[
				{ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/x" },
				{ type: "custom", id: "pending", parentId: null, customType: "pi-web-ui/compaction-pending", data: state },
				{
					type: "custom",
					id: "sdk-done",
					parentId: "pending",
					customType: "pi-web-ui/compaction-done",
					data: { ...state, status: "completed" },
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n") + "\n";
		await mark(file, state);
		const repaired = repairSessionTranscript(raw);
		expect(repaired.interrupted).toBe(true);
		expect(repaired.removedPending).toBe(1);
		expect(repaired.text).toContain('"sdk-done"');
		expect(repaired.text).toContain('"pi-web-ui/compaction-done"');
		expect(consumeInterrupted(file)).toEqual(state);
	});
});
