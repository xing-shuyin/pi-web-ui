import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import * as fs from "node:fs";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, readFile: vi.fn(actual.readFile) };
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionInfoFast } from "../../server/session-parser.js";
import { collectSessionAnchors, scanSessionForSearch, searchSessions } from "../../server/session-search.js";
import { mapSessionsConcurrent, sessionLines } from "../../server/session-scan.js";

const dirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const header = { type: "session", id: "test", cwd: "/workspace", timestamp: "2024-01-01T00:00:00Z" };
const message = (role: string, content: unknown, timestamp?: number) => ({
	type: "message",
	message: { role, content, timestamp },
});
async function transcript(records: unknown[]) {
	const dir = await mkdtemp(join(tmpdir(), "session-search-"));
	dirs.push(dir);
	const path = join(dir, "session.jsonl");
	await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n"));
	return path;
}

describe("streaming history search", () => {
	it("finds tail matches beyond the old 256K text budget, in one scan with ordered anchors", async () => {
		const path = await transcript([
			header,
			message("user", "start", 1),
			...Array.from({ length: 320 }, (_, i) => message("assistant", "x".repeat(1024), i + 2)),
			message("assistant", [{ type: "text", text: "TAIL Needle" }], 400),
			message("user", "needle again", 401),
		]);
		const readFile = vi.spyOn(fsPromises, "readFile");
		const info = (await parseSessionInfoFast(path, 1))!;
		expect(info.allMessagesText).toBe("");
		const openStream = vi.mocked(fs.createReadStream);
		openStream.mockClear();
		expect(await searchSessions([info], "NEEDLE")).toEqual([
			{
				session: info,
				anchors: [
					{ role: "assistant", timestamp: 400 },
					{ role: "user", timestamp: 401 },
				],
			},
		]);
		expect(readFile).not.toHaveBeenCalled();
		expect(openStream).toHaveBeenCalledTimes(1);
	});

	it("searches transcripts larger than the old 16MB whole-file cutoff", async () => {
		const path = await transcript([
			header,
			...Array.from({ length: 260 }, () => message("assistant", "x".repeat(65536), 1)),
			message("user", "very late match", 99),
		]);
		expect(await scanSessionForSearch(path, "late match")).toEqual({
			matched: true,
			anchors: [{ role: "user", timestamp: 99 }],
		});
	});

	it("filters roles and blocks, skips malformed records, and preserves valid anchors", async () => {
		const path = await transcript([
			header,
			null,
			message("toolResult", "secret needle", 1),
			message("system", "secret needle", 2),
			message(
				"assistant",
				[
					{ type: "thinking", text: "secret needle" },
					{ type: "image", text: "secret needle" },
				],
				3,
			),
			message("user", "needle without timestamp"),
			message("assistant", [{ type: "text", text: "中文 Needle" }], 5),
			message("user", "needle", 6),
		]);
		expect(await scanSessionForSearch(path, "secret")).toEqual({ matched: false, anchors: [] });
		expect(await collectSessionAnchors(path, "needle", 1)).toEqual([{ role: "assistant", timestamp: 5 }]);
		expect(await scanSessionForSearch(path, "without timestamp")).toEqual({ matched: true, anchors: [] });
		expect(await scanSessionForSearch(path, "needle", 0)).toEqual({ matched: true, anchors: [] });
		await writeFile(path, "\n{broken\n" + JSON.stringify(message("user", "最后 Needle", 7)), { flag: "a" });
		expect((await scanSessionForSearch(path, "needle")).anchors.map((a) => a.timestamp)).toEqual([5, 6, 7]);
	});

	it("handles UTF-8 across chunks, CRLF and an unterminated final record", async () => {
		const path = await transcript([]);
		await writeFile(
			path,
			JSON.stringify(header) + "\r\n" + JSON.stringify(message("user", "界".repeat(24000) + "尾部检索", 9)),
		);
		expect(await scanSessionForSearch(path, "尾部检索")).toEqual({
			matched: true,
			anchors: [{ role: "user", timestamp: 9 }],
		});
	});

	it("keeps metadata-only matches, handles missing files and does not cap candidates at 200", async () => {
		const path = await transcript([header, message("user", "hello", 1)]);
		const info = (await parseSessionInfoFast(path, 1))!;
		const candidates = Array.from({ length: 205 }, (_, i) => ({
			...info,
			path: join(dirs[0], `missing-${i}.jsonl`),
			name: i === 204 ? "Target" : "other",
		}));
		expect(await searchSessions(candidates, "target", { concurrency: 3 })).toEqual([
			{ session: candidates[204], anchors: [] },
		]);
		expect(await scanSessionForSearch(candidates[0].path, "hello")).toEqual({ matched: false, anchors: [] });
		expect(await searchSessions(candidates, "")).toHaveLength(205);
	});
});

describe("streaming list parser", () => {
	it("retains metadata, first message, counters, modified time and bounded legacy preview", async () => {
		const path = await transcript([
			{ ...header, parentSession: "/parent.jsonl" },
			message(
				"user",
				[
					{ type: "text", text: "first" },
					{ type: "text", text: "message" },
				],
				1705000000000,
			),
			message("toolResult", "x".repeat(300000), 1705000000001),
			{ type: "session_info", name: " latest name " },
		]);
		const info = await parseSessionInfoFast(path, 1);
		expect(info).toMatchObject({
			id: "test",
			cwd: "/workspace",
			name: "latest name",
			parentSessionPath: "/parent.jsonl",
			firstMessage: "first message",
			messageCount: 2,
			allMessagesText: "",
		});
		expect(info?.modified.getTime()).toBe(1705000000001);
		expect((await parseSessionInfoFast(path, 1, true))?.allMessagesText).toHaveLength(256 * 1024);
	});

	it("keeps fallback dates and ignores invalid records", async () => {
		const path = await transcript([header, { type: "session_info", name: "name" }]);
		await writeFile(path, "\n{broken\nnull\n", { flag: "a" });
		expect(await parseSessionInfoFast(path, 1)).toMatchObject({
			firstMessage: "(no messages)",
			messageCount: 0,
			modified: new Date(header.timestamp),
		});
		expect(await parseSessionInfoFast(path + ".missing", 1)).toBeNull();
	});
});

describe("scan cancellation", () => {
	it("rejects pre-aborted searches without opening files, including empty queries", async () => {
		const path = await transcript([header]);
		const info = (await parseSessionInfoFast(path, 1))!;
		const controller = new AbortController();
		controller.abort();
		const openStream = vi.mocked(fs.createReadStream);
		openStream.mockClear();
		await expect(scanSessionForSearch(path, "needle", 10, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		await expect(searchSessions([info], "", { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		await expect(sessionLines(path, controller.signal).next()).rejects.toMatchObject({ name: "AbortError" });
		expect(openStream).not.toHaveBeenCalled();
	});

	it("checks cancellation before yielding buffered lines and closes the stream", async () => {
		const path = await transcript([header, message("user", "needle", 1)]);
		const controller = new AbortController();
		const lines = sessionLines(path, controller.signal);
		await lines.next();
		const stream = vi.mocked(fs.createReadStream).mock.results.at(-1)!.value as fs.ReadStream;
		const reason = new Error("superseded search");
		controller.abort(reason);
		await expect(lines.next()).rejects.toBe(reason);
		expect(stream.destroyed).toBe(true);
	});

	it("propagates cancellation rather than returning partial search results and opens no queued files", async () => {
		const path = await transcript([header, message("user", "needle", 1)]);
		const info = (await parseSessionInfoFast(path, 1))!;
		const controller = new AbortController();
		const openStream = vi.mocked(fs.createReadStream);
		const { createReadStream: original } = await vi.importActual<typeof import("node:fs")>("node:fs");
		openStream.mockClear();
		openStream.mockImplementationOnce((...args: Parameters<typeof fs.createReadStream>) => {
			const stream = original(...args);
			queueMicrotask(() => controller.abort());
			return stream;
		});
		await expect(
			searchSessions(Array(20).fill(info), "needle", { concurrency: 1, signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(openStream).toHaveBeenCalledTimes(1);
		expect(openStream.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
	});

	it("stops queued worker tasks after cancellation even when active tasks resolve", async () => {
		const controller = new AbortController();
		const visited: number[] = [];
		await expect(
			mapSessionsConcurrent(
				[0, 1, 2, 3],
				async (n) => {
					visited.push(n);
					controller.abort();
					return n;
				},
				1,
				controller.signal,
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(visited).toEqual([0]);
	});
});

describe("scan scheduling", () => {
	it("discards huge inline image data before buffering a line, preserving text and following records", async () => {
		const path = await transcript([
			header,
			message(
				"user",
				[
					{ type: "image", data: "a".repeat(3 * 1024 * 1024), mimeType: "image/png" },
					{ type: "text", text: 'quoted \\" data: needle 中文' },
				],
				8,
			),
			message("assistant", "needle", 9),
		]);
		let longest = 0;
		for await (const line of sessionLines(path)) {
			longest = Math.max(longest, line.length);
			JSON.parse(line);
		}
		expect(longest).toBeLessThan(1024);
		expect((await scanSessionForSearch(path, "needle")).anchors).toEqual([
			{ role: "user", timestamp: 8 },
			{ role: "assistant", timestamp: 9 },
		]);
	});
	it("bounds active work and preserves candidate order", async () => {
		let active = 0;
		let maxActive = 0;
		const result = await mapSessionsConcurrent(
			[0, 1, 2, 3, 4],
			async (n) => {
				maxActive = Math.max(maxActive, ++active);
				await new Promise((resolve) => setTimeout(resolve, n === 0 ? 10 : 1));
				active--;
				return n * 2;
			},
			2,
		);
		expect(maxActive).toBe(2);
		expect(result).toEqual([0, 2, 4, 6, 8]);
		await expect(mapSessionsConcurrent([], async () => 1, 0)).rejects.toThrow(RangeError);
	});

	it("yields to the event loop while scanning buffered records", async () => {
		const path = await transcript(Array.from({ length: 2000 }, () => message("user", "small", 1)));
		let ticked = false;
		let count = 0;
		const timer = setTimeout(() => {
			ticked = true;
		}, 0);
		try {
			for await (const _line of sessionLines(path)) {
				if (++count === 1500) expect(ticked).toBe(true);
			}
		} finally {
			clearTimeout(timer);
		}
		expect(count).toBe(2000);
	});
});
