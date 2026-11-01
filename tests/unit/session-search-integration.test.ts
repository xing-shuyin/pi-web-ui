import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import * as transcriptSearch from "../../server/session-search.js";
import { fakeClientSession } from "../helpers/fake-session.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "session-search-integration-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function transcript(index: number, text: string): Promise<SessionInfo> {
	const path = join(dir, `session-${index}.jsonl`);
	await writeFile(
		path,
		[
			JSON.stringify({ type: "session", version: 3, id: `s${index}`, cwd: dir }),
			JSON.stringify({
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1000 + index },
			}),
			"",
		].join("\n"),
	);
	return {
		path,
		id: `s${index}`,
		cwd: dir,
		created: new Date(1000),
		modified: new Date(10000 - index),
		firstMessage: "ordinary first message",
		messageCount: 1,
	} as SessionInfo;
}

function fakeThis() {
	return Object.assign(fakeClientSession(), {
		cwd: dir,
		emit: vi.fn(),
		loadSessionInfos: vi.fn<(cwd: string) => Promise<SessionInfo[]>>(),
	});
}

describe("ClientSession.searchSessions integration", () => {
	it("aborts an older in-flight scan and publishes only the new query", async () => {
		const session = fakeThis();
		const infos = [await transcript(0, "old-query new-query")];
		session.loadSessionInfos.mockResolvedValue(infos);
		const entered = deferred<void>();
		const release = deferred<void>();
		const realSearch = transcriptSearch.searchSessions;
		let oldSignal: AbortSignal | undefined;
		vi.spyOn(transcriptSearch, "searchSessions").mockImplementationOnce(async (candidates, query, options) => {
			oldSignal = options?.signal;
			const results = await realSearch(candidates, query, options);
			entered.resolve();
			await release.promise;
			return results;
		});
		const oldSearch = session.searchSessions("old-query", 1);
		await entered.promise;
		try {
			await session.searchSessions("new-query", 2);
			expect(oldSignal?.aborted).toBe(true);
		} finally {
			release.resolve();
			await oldSearch;
		}
		expect(session.emit.mock.calls).toEqual([
			[
				expect.objectContaining({
					type: "session_search_results",
					reqId: 2,
					query: "new-query",
					ok: true,
					results: [
						expect.objectContaining({ path: infos[0].path, anchors: [{ role: "assistant", timestamp: 1000 }] }),
					],
				}),
			],
		]);
		expect(session.sessionSearchController).toBeUndefined();
	});

	it("does not let an aborted metadata load clear the newer query controller", async () => {
		const session = fakeThis();
		const oldLoad = deferred<SessionInfo[]>();
		const newLoad = deferred<SessionInfo[]>();
		session.loadSessionInfos.mockReturnValueOnce(oldLoad.promise).mockReturnValueOnce(newLoad.promise);
		const oldSearch = session.searchSessions("old-query", 1);
		const oldController = session.sessionSearchController;
		const newSearch = session.searchSessions("new-query", 2);
		const newController = session.sessionSearchController;
		expect(oldController.signal.aborted).toBe(true);
		oldLoad.resolve([]);
		await oldSearch;
		expect(session.emit).not.toHaveBeenCalled();
		expect(session.sessionSearchController).toBe(newController);
		newLoad.resolve([await transcript(0, "new-query")]);
		await newSearch;
		expect(session.emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reqId: 2, ok: true }));
		expect(session.sessionSearchController).toBeUndefined();
	});

	it.each([false, true])("suppresses stale cwd results even when loading fails: %s", async (fails) => {
		const session = fakeThis();
		const load = deferred<SessionInfo[]>();
		session.loadSessionInfos.mockReturnValueOnce(load.promise);
		const pending = session.searchSessions("needle", 3);
		expect(session.loadSessionInfos).toHaveBeenCalledWith(dir);
		session.cwd = join(dir, "other-project");
		if (fails) load.reject(new Error("old workspace unavailable"));
		else load.resolve([await transcript(0, "needle")]);
		await pending;
		expect(session.emit).not.toHaveBeenCalled();
		expect(session.sessionSearchController).toBeUndefined();
	});

	it("suppresses results when cwd changes after the transcript scan has started", async () => {
		const session = fakeThis();
		session.loadSessionInfos.mockResolvedValue([await transcript(0, "needle")]);
		const entered = deferred<void>();
		const release = deferred<void>();
		const realSearch = transcriptSearch.searchSessions;
		vi.spyOn(transcriptSearch, "searchSessions").mockImplementationOnce(async (infos, query, options) => {
			const results = await realSearch(infos, query, options);
			entered.resolve();
			await release.promise;
			return results;
		});
		const pending = session.searchSessions("needle", 5);
		await entered.promise;
		session.cwd = join(dir, "other-project");
		release.resolve();
		await pending;
		expect(session.emit).not.toHaveBeenCalled();
		expect(session.sessionSearchController).toBeUndefined();
	});

	it("searches all candidates past 200 and returns a transcript-only tail hit with anchors", async () => {
		const session = fakeThis();
		const infos = await Promise.all(
			Array.from({ length: 205 }, (_, index) =>
				transcript(index, index === 204 ? "deep-tail-needle" : "ordinary body"),
			),
		);
		session.loadSessionInfos.mockResolvedValue(infos);
		await session.searchSessions("  DEEP-TAIL-NEEDLE  ", 4);
		expect(session.emit).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				type: "session_search_results",
				reqId: 4,
				query: "  DEEP-TAIL-NEEDLE  ",
				ok: true,
				results: [
					expect.objectContaining({
						path: infos[204].path,
						sessionId: "s204",
						anchors: [{ role: "assistant", timestamp: 1204 }],
					}),
				],
			}),
		);
	});
});
