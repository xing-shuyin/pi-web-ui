/** Metadata LRU, invalidation and file-stat reuse; streaming search never retains full text. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync } from "node:fs";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { searchSessions } from "../../server/session-search.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";

// 私有静态字段/方法：运行时都挂在 class 上，经 cast 访问（同 fake-this 思路）
const CS = ClientSession as unknown as Record<string, any>;

/** fake this：loadSessionInfos / invalidateSessionInfos 只触静态缓存与 this.cwd。 */
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
	// 小转录：全文远小于 256K 封顶
	writeFileSync(
		join(tmp, "a.jsonl"),
		transcript("sess-a", [
			{ role: "user", text: "hello world" },
			{ role: "assistant", text: "hi there" },
		]),
	);
	// 大转录：全文 > 256K 字符。首条消息（进 firstMessage 元信息）只含 head_marker，
	// tail_marker 位于第二条消息尾部，不进入 firstMessage 元信息。
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
	// 防止用例内对上限常量的临时改写泄漏
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
				// s11 最新，s0 最旧
				const t = new Date(base + i * 1000);
				utimesSync(p, t, t);
			}
			CS.SESSION_LIST_PARSE_LIMIT = 2;
			const proto = ClientSession.prototype as unknown as {
				loadSessionInfos: (cwd?: string, opts?: { listOnly?: boolean }) => Promise<SessionInfo[]>;
			};
			const listed = await proto.loadSessionInfos.call(svcWith(dir), undefined, { listOnly: true });
			const ids = listed.map((i) => i.id);
			// 并发 4 的工作池最多多解析 3 个；无论如何不会扫完 12 个，且最新的两条一定在内
			expect(ids.length).toBeGreaterThanOrEqual(2);
			expect(ids.length).toBeLessThan(12);
			expect(ids.slice(0, 2)).toEqual(["id-11", "id-10"]);
			expect(CS.sessionInfosCache.get([...CS.sessionInfosCache.keys()][0]).complete).toBe(false);

			// 再次列表请求：命中（不完整）缓存
			expect(await proto.loadSessionInfos.call(svcWith(dir), undefined, { listOnly: true })).toBe(listed);
			// 全集请求（搜索 / 按 id 定位）：不得复用不完整缓存
			const full = await proto.loadSessionInfos.call(svcWith(dir));
			expect(full).toHaveLength(12);
			expect(CS.sessionInfosCache.get([...CS.sessionInfosCache.keys()][0]).complete).toBe(true);
			// 完整缓存可服务后续列表请求
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
		expect(CS.sessionFileCache.has("k1")).toBe(false); // 最旧被淘汰
		expect(CS.sessionFileCache.has("k4")).toBe(true);
	});

	it("LRU 命中续期：最近命中的条目不会被淘汰", () => {
		CS.SESSION_FILE_CACHE_MAX = 3;
		CS.sessionFileCacheStore("k1", { mtime: 1, size: 1, info: dummyInfo("k1") });
		CS.sessionFileCacheStore("k2", { mtime: 1, size: 1, info: dummyInfo("k2") });
		CS.sessionFileCacheStore("k3", { mtime: 1, size: 1, info: dummyInfo("k3") });
		// k1 命中 → 续期到最新端；再写入 k4 时被淘汰的是未命中的 k2
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
	// private 方法：同 fake-this 模式经 cast 取原型实现
	const invalidate = (ClientSession.prototype as unknown as Record<string, (this: unknown, filePath?: string) => void>)
		.invalidateSessionInfos;

	it("带 filePath：清该文件的元信息缓存，并清列表缓存", () => {
		CS.sessionFileCache.set(p1, { mtime: 1, size: 1, info: dummyInfo(p1) });
		CS.sessionFileCache.set(p2, { mtime: 1, size: 1, info: dummyInfo(p2) });
		CS.sessionInfosCache.set("somecwd", { infos: [], at: Date.now() });
		invalidate.call(svcWith("/x"), p1);
		expect(CS.sessionFileCache.has(p1)).toBe(false);
		expect(CS.sessionFileCache.has(p2)).toBe(true); // 其他文件不受影响
		expect(CS.sessionInfosCache.size).toBe(0);
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
		expect(a.allMessagesText).toBe(""); // 拆分：列表不携带全文
		const cached = CS.sessionFileCache.get(resolve(join(tmp, "a.jsonl")));
		expect(cached?.info.allMessagesText).toBe("");
		expect(cached?.mtime).toBeGreaterThan(0);
	});

	it("mtime/size 未变：重扫时复用缓存里的同一 info 对象（不重读盘）", async () => {
		const proto = ClientSession.prototype as unknown as { loadSessionInfos: () => Promise<{ id: string }[]> };
		const first = await proto.loadSessionInfos.call(svcWith(tmp));
		// 只清列表 fridge，保留单文件缓存 → 第二次扫描应从 sessionFileCache 命中
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
		// Filesystem timestamp precision varies; pin the cached stat to the actual restored value.
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
		// Same-size rewrite and restored mtime: a stale metadata object cannot serve body text.
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
