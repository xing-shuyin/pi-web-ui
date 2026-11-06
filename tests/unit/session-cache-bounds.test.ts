import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync } from "node:fs";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { searchSessions } from "../../server/session-search.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";
import * as sessionListScan from "../../server/session-list-scan.js";

const CS = ClientSession as unknown as Record<string, any>;

function svcWith(cwd: string) {
	const svc = fakeClientSession() as { cwd: string };
	svc.cwd = cwd;
	return svc;
}

function dummyInfo(path: string) {
	return {
		path,
		id: "x",
		cwd: "",
		created: new Date(0),
		modified: new Date(0),
		messageCount: 0,
		firstMessage: "",
		allMessagesText: "",
	};
}

function transcript(id: string, messages: { role: "user" | "assistant"; text: string }[]) {
	const lines = [JSON.stringify({ type: "session", id, cwd: tmp, timestamp: "2026-01-01T00:00:00.000Z" })];
	for (const m of messages) {
		lines.push(
			JSON.stringify({ type: "message", message: { role: m.role, timestamp: 1700000000000, content: m.text } }),
		);
	}
	return lines.join("\n");
}

let tmp = "";
const originalEnv = process.env.PI_CODING_AGENT_SESSION_DIR;

beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), "piwui-session-cache-"));
	writeFileSync(
		join(tmp, "a.jsonl"),
		transcript("sess-a", [
			{ role: "user", text: "hello world" },
			{ role: "assistant", text: "hi there" },
		]),
	);
	writeFileSync(
		join(tmp, "big.jsonl"),
		transcript("sess-big", [
			{ role: "user", text: "head_marker" },
			{ role: "assistant", text: `${"y".repeat(300 * 1024)} tail_marker` },
		]),
	);
	process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
});

afterAll(() => {
	if (originalEnv === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
	else process.env.PI_CODING_AGENT_SESSION_DIR = originalEnv;
	rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
	writeFileSync(
		join(tmp, "a.jsonl"),
		transcript("sess-a", [
			{ role: "user", text: "hello world" },
			{ role: "assistant", text: "hi there" },
		]),
	);
	CS.sessionFileCache.clear();
	CS.sessionInfosCache.clear();
	CS.sessionInfosInFlight.clear();
});

afterEach(() => {
	CS.SESSION_FILE_CACHE_MAX = 2048;
	CS.SESSION_LIST_PARSE_LIMIT = 260;
});

describe("列表模式提前停止解析（listOnly）", () => {
	it("只解析 mtime 最新的一批；需要全集的调用不复用不完整缓存", async () => {
		const dir = mkdtempSync(join(tmpdir(), "piwui-session-listonly-"));
		const prevEnv = process.env.PI_CODING_AGENT_SESSION_DIR;
		process.env.PI_CODING_AGENT_SESSION_DIR = dir;
		try {
			const base = Date.now() - 100_000;
			for (let i = 0; i < 12; i++) {
				const p = join(dir, `s${i}.jsonl`);
				writeFileSync(
					p,
					[
						JSON.stringify({ type: "session", id: `id-${i}`, cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" }),
						JSON.stringify({
							type: "message",
							message: { role: "user", timestamp: base + i * 1000, content: `msg ${i}` },
						}),
					].join("\n"),
				);
				const t = new Date(base + i * 1000);
				utimesSync(p, t, t);
			}
			CS.SESSION_LIST_PARSE_LIMIT = 2;
			const proto = ClientSession.prototype as unknown as {
				loadSessionInfos: (cwd?: string, opts?: { listOnly?: boolean }) => Promise<SessionInfo[]>;
			};
			const listed = await proto.loadSessionInfos.call(svcWith(dir), undefined, { listOnly: true });
			const ids = listed.map((i) => i.id);
			expect(ids.length).toBeGreaterThanOrEqual(2);
			expect(ids.length).toBeLessThan(12);
			expect(ids.slice(0, 2)).toEqual(["id-11", "id-10"]);
			expect(CS.sessionInfosCache.get([...CS.sessionInfosCache.keys()][0]).complete).toBe(false);

			expect(await proto.loadSessionInfos.call(svcWith(dir), undefined, { listOnly: true })).toBe(listed);
			const full = await proto.loadSessionInfos.call(svcWith(dir));
			expect(full).toHaveLength(12);
			expect(CS.sessionInfosCache.get([...CS.sessionInfosCache.keys()][0]).complete).toBe(true);
			expect(await proto.loadSessionInfos.call(svcWith(dir), undefined, { listOnly: true })).toBe(full);
		} finally {
			if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
			else process.env.PI_CODING_AGENT_SESSION_DIR = prevEnv;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("sessionFileCache LRU（issue #440）", () => {
	it("条目超上限：从最旧端淘汰", () => {
		CS.SESSION_FILE_CACHE_MAX = 3;
		CS.sessionFileCacheStore("k1", { mtime: 1, size: 1, info: dummyInfo("k1") });
		CS.sessionFileCacheStore("k2", { mtime: 1, size: 1, info: dummyInfo("k2") });
		CS.sessionFileCacheStore("k3", { mtime: 1, size: 1, info: dummyInfo("k3") });
		expect(CS.sessionFileCache.size).toBe(3);
		CS.sessionFileCacheStore("k4", { mtime: 1, size: 1, info: dummyInfo("k4") });
		expect(CS.sessionFileCache.size).toBe(3);
		expect(CS.sessionFileCache.has("k1")).toBe(false);
		expect(CS.sessionFileCache.has("k4")).toBe(true);
	});

	it("LRU 命中续期：最近命中的条目不会被淘汰", () => {
		CS.SESSION_FILE_CACHE_MAX = 3;
		CS.sessionFileCacheStore("k1", { mtime: 1, size: 1, info: dummyInfo("k1") });
		CS.sessionFileCacheStore("k2", { mtime: 1, size: 1, info: dummyInfo("k2") });
		CS.sessionFileCacheStore("k3", { mtime: 1, size: 1, info: dummyInfo("k3") });
		const hit = CS.sessionFileCacheLookup("k1");
		expect(hit?.info.path).toBe("k1");
		CS.sessionFileCacheStore("k4", { mtime: 1, size: 1, info: dummyInfo("k4") });
		expect(CS.sessionFileCache.size).toBe(3);
		expect(CS.sessionFileCache.has("k1")).toBe(true);
		expect(CS.sessionFileCache.has("k2")).toBe(false);
		expect(CS.sessionFileCache.has("k3")).toBe(true);
	});
});

describe("invalidateSessionInfos 清理语义（issue #440 后保持）", () => {
	const p1 = resolve("/x/a.jsonl");
	const p2 = resolve("/x/b.jsonl");
	const invalidate = (ClientSession.prototype as unknown as Record<string, (this: unknown, filePath?: string) => void>)
		.invalidateSessionInfos;

	it("带 filePath：清该文件的元信息缓存，并清列表缓存", () => {
		CS.sessionFileCache.set(p1, { mtime: 1, size: 1, info: dummyInfo(p1) });
		CS.sessionFileCache.set(p2, { mtime: 1, size: 1, info: dummyInfo(p2) });
		CS.sessionInfosCache.set("somecwd", { infos: [], at: Date.now() });
		invalidate.call(svcWith("/x"), p1);
		expect(CS.sessionFileCache.has(p1)).toBe(false);
		expect(CS.sessionFileCache.has(p2)).toBe(true);
		expect(CS.sessionInfosCache.size).toBe(0);
	});

	it("rebuilds pending history scans after deletion instead of republishing the deleted session", async () => {
		const svc = svcWith(tmp) as any;
		const deleted = resolve(tmp, "a.jsonl");
		const scan = sessionListScan.scanSessionListInfo;
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let blocked = false;
		const spy = vi.spyOn(sessionListScan, "scanSessionListInfo").mockImplementation(async (...args) => {
			const result = await scan(...args);
			if (resolve(args[0]) === deleted && !blocked) {
				blocked = true;
				started();
				await gate;
			}
			return result;
		});
		const pending = svc.loadSessionInfos(tmp, { listOnly: true });
		try {
			await ready;
			rmSync(deleted);
			svc.invalidateSessionInfos(deleted);
			const refreshed = svc.loadSessionInfos(tmp, { listOnly: true });
			release();
			for (const infos of await Promise.all([pending, refreshed])) {
				expect(infos.some((info: SessionInfo) => resolve(info.path) === deleted)).toBe(false);
				expect(infos.some((info: SessionInfo) => info.path.endsWith("big.jsonl"))).toBe(true);
			}
			expect(CS.sessionFileCache.has(deleted)).toBe(false);
			expect(
				[...CS.sessionInfosCache.values()]
					.flatMap((entry: any) => entry.infos)
					.some((info) => resolve(info.path) === deleted),
			).toBe(false);
		} finally {
			release();
			await pending;
			spy.mockRestore();
		}
	});

	it("不带 filePath：只清列表缓存，文件元信息缓存保留", () => {
		CS.sessionFileCache.set(p1, { mtime: 1, size: 1, info: dummyInfo(p1) });
		CS.sessionInfosCache.set("somecwd", { infos: [], at: Date.now() });
		invalidate.call(svcWith("/x"));
		expect(CS.sessionFileCache.has(p1)).toBe(true);
		expect(CS.sessionInfosCache.size).toBe(0);
	});
});

describe("转录全文拆分与按需加载（issue #440）", () => {
	it("列表路径：返回值与缓存条目都不带全文，元信息完整", async () => {
		const infos = await (
			ClientSession.prototype as unknown as {
				loadSessionInfos: () => Promise<
					{ id: string; firstMessage: string; messageCount: number; allMessagesText: string }[]
				>;
			}
		).loadSessionInfos.call(svcWith(tmp));
		expect(infos).toHaveLength(2);
		const a = infos.find((i) => i.id === "sess-a")!;
		expect(a.firstMessage).toBe("hello world");
		expect(a.messageCount).toBe(2);
		expect(a.allMessagesText).toBe("");
		const cached = CS.sessionFileCache.get(resolve(join(tmp, "a.jsonl")));
		expect(cached?.info.allMessagesText).toBe("");
		expect(cached?.mtime).toBeGreaterThan(0);
	});

	it("mtime/size 未变：重扫时复用缓存里的同一 info 对象（不重读盘）", async () => {
		const proto = ClientSession.prototype as unknown as { loadSessionInfos: () => Promise<{ id: string }[]> };
		const first = await proto.loadSessionInfos.call(svcWith(tmp));
		CS.sessionInfosCache.clear();
		const second = await proto.loadSessionInfos.call(svcWith(tmp));
		expect(second.find((i) => i.id === "sess-a")).toBe(first.find((i) => i.id === "sess-a"));
	});

	it("mtime changes invalidate metadata even with unchanged size", async () => {
		const path = join(tmp, "a.jsonl");
		const proto = ClientSession.prototype as unknown as { loadSessionInfos: () => Promise<SessionInfo[]> };
		const first = await proto.loadSessionInfos.call(svcWith(tmp));
		const stat = statSync(path);
		utimesSync(path, stat.atime, new Date(stat.mtimeMs + 5000));
		CS.sessionInfosCache.clear();
		const second = await proto.loadSessionInfos.call(svcWith(tmp));
		expect(second.find((i) => i.id === "sess-a")).not.toBe(first.find((i) => i.id === "sess-a"));
	});

	it("size changes invalidate metadata even when mtime is preserved", async () => {
		const path = join(tmp, "a.jsonl");
		const proto = ClientSession.prototype as unknown as { loadSessionInfos: () => Promise<SessionInfo[]> };
		const first = await proto.loadSessionInfos.call(svcWith(tmp));
		const stat = statSync(path);
		writeFileSync(path, "\n", { flag: "a" });
		utimesSync(path, stat.atime, stat.mtime);
		CS.sessionFileCache.get(resolve(path)).mtime = statSync(path).mtimeMs;
		CS.sessionInfosCache.clear();
		const second = await proto.loadSessionInfos.call(svcWith(tmp));
		expect(second.find((i) => i.id === "sess-a")).not.toBe(first.find((i) => i.id === "sess-a"));
	});

	it("search reads current body without a full-text cache, leaving metadata reusable", async () => {
		const proto = ClientSession.prototype as unknown as { loadSessionInfos: () => Promise<SessionInfo[]> };
		const infos = await proto.loadSessionInfos.call(svcWith(tmp));
		const path = join(tmp, "a.jsonl");
		const stat = statSync(path);
		const byText = await searchSessions(infos, "hi there");
		expect(byText.map((hit) => hit.session.id)).toEqual(["sess-a"]);
		expect(byText[0].anchors).toEqual([{ role: "assistant", timestamp: 1700000000000 }]);
		writeFileSync(
			path,
			transcript("sess-a", [
				{ role: "user", text: "hello world" },
				{ role: "assistant", text: "new body" },
			]),
		);
		utimesSync(path, stat.atime, stat.mtime);
		expect(await searchSessions(infos, "hi there")).toEqual([]);
		expect((await searchSessions(infos, "new body")).map((hit) => hit.session.id)).toEqual(["sess-a"]);
		for (const { info } of CS.sessionFileCache.values()) expect(info.allMessagesText).toBe("");
		for (const { infos: cached } of CS.sessionInfosCache.values()) {
			for (const info of cached) expect(info.allMessagesText).toBe("");
		}
		expect(await proto.loadSessionInfos.call(svcWith(tmp))).toBe(infos);
	});
});
