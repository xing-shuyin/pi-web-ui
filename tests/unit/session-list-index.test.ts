import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientSession } from "../../server/agent-service.js";
import { resetSessionListIndexCache } from "../../server/session-list-index.js";
import { fakeClientSession } from "../helpers/fake-session.js";

const CS = ClientSession as unknown as Record<string, any>;
let dir = "";
let dataDir = "";
let base = 0;
const prevEnv = process.env.PI_CODING_AGENT_SESSION_DIR;
const files: string[] = [];

beforeEach(() => {
	CS.sessionFileCache.clear();
	CS.sessionInfosCache.clear();
	CS.sessionInfosInFlight.clear();
	resetSessionListIndexCache();
	dir = mkdtempSync(join(tmpdir(), "piwui-index-sessions-"));
	dataDir = mkdtempSync(join(tmpdir(), "piwui-index-data-"));
	process.env.PI_CODING_AGENT_SESSION_DIR = dir;
	base = Math.floor((Date.now() - 600_000) / 1000) * 1000;
	files.length = 0;
	for (let i = 0; i < 6; i++) {
		const p = join(dir, `s${i}.jsonl`);
		writeFileSync(
			p,
			[
				JSON.stringify({ type: "session", id: `id-${i}`, cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" }),
				JSON.stringify({ type: "message", message: { role: "user", timestamp: base + i * 1000, content: `msg ${i}` } }),
			].join("\n") + "\n",
		);
		// 整秒 mtime：磁盘索引按 mtime + size 认人，utimes 能精确复现整秒值
		const t = new Date(base + i * 1000);
		utimesSync(p, t, t);
		files.push(p);
	}
});

afterEach(() => {
	resetSessionListIndexCache();
	if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
	else process.env.PI_CODING_AGENT_SESSION_DIR = prevEnv;
	rmSync(dir, { recursive: true, force: true });
	rmSync(dataDir, { recursive: true, force: true });
});

function svc() {
	const s = fakeClientSession() as any;
	s.cwd = dir;
	s.settingsSvc = { current: {} };
	s.stateStore = { ...(s.stateStore ?? {}), isSessionPinned: () => false, dataDir };
	s.sessionListLimits = new Map();
	return s;
}

/** 模拟「服务端重启」：内存里的列表缓存与每文件缓存都清掉，只留磁盘索引。 */
function simRestart() {
	CS.sessionFileCache.clear();
	CS.sessionInfosCache.clear();
	CS.sessionInfosInFlight.clear();
	resetSessionListIndexCache();
}

function indexFiles(): string[] {
	try {
		return readdirSync(join(dataDir, "cache", "session-list-index")).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
}

/** 等去抖（500ms）后的落盘完成。 */
async function waitForIndexFile(timeoutMs = 4000): Promise<string> {
	const started = Date.now();
	for (;;) {
		const list = indexFiles();
		if (list.length > 0) return join(dataDir, "cache", "session-list-index", list[0]!);
		if (Date.now() - started > timeoutMs) throw new Error("session index 没有落盘");
		await new Promise((r) => setTimeout(r, 50));
	}
}

/** 保持字节数与 mtime 不变，把内容换成无意义的 'x'（若被重扫必然解析不出会话）。 */
function corruptKeepingStamp(file: string): void {
	const buf = readFileSync(file);
	const stamp = statSync(file);
	writeFileSync(file, Buffer.alloc(buf.length, "x"));
	utimesSync(file, stamp.atime, stamp.mtime);
}

describe("会话列表磁盘索引", () => {
	it("落盘后在「重启」后仍然免解析：内容被换掉（mtime+size 不变）也照样给出原元信息", async () => {
		const s = svc();
		const first = await s.sessionListPayload(dir);
		expect(first.sessions.map((x: { sessionId: string }) => x.sessionId)).toEqual([
			"id-5",
			"id-4",
			"id-3",
			"id-2",
			"id-1",
			"id-0",
		]);

		const indexPath = await waitForIndexFile();
		const body = JSON.parse(readFileSync(indexPath, "utf8")) as { v: number; entries: Record<string, unknown> };
		expect(body.v).toBe(1);
		expect(Object.keys(body.entries)).toHaveLength(6);

		for (const f of files) corruptKeepingStamp(f);
		simRestart();

		const second = await s.sessionListPayload(dir);
		expect(second.sessions.map((x: { sessionId: string }) => x.sessionId)).toEqual([
			"id-5",
			"id-4",
			"id-3",
			"id-2",
			"id-1",
			"id-0",
		]);
	});

	it("文件变了（mtime 不同）就重新解析，不吃旧索引", async () => {
		const s = svc();
		await s.sessionListPayload(dir);
		await waitForIndexFile();

		const target = files[0]!;
		corruptKeepingStamp(target);
		const t = new Date(base + 600_000);
		utimesSync(target, t, t);
		simRestart();

		const after = await s.sessionListPayload(dir);
		// s0 内容已损坏且 mtime 变化 → 重扫后解析不出会话，只剩其余 5 条
		expect(after.sessions.map((x: { sessionId: string }) => x.sessionId)).toEqual([
			"id-5",
			"id-4",
			"id-3",
			"id-2",
			"id-1",
		]);
	});

	it("重启用增量续扫补齐追加的条数，不从文件开头重读", async () => {
		const s = svc();
		const before = await s.sessionListPayload(dir);
		expect(before.sessions.find((x: { sessionId: string }) => x.sessionId === "id-5")?.messageCount).toBe(1);
		await waitForIndexFile();

		const target = files[5]!;
		writeFileSync(
			target,
			`${JSON.stringify({ type: "message", message: { role: "assistant", timestamp: base + 900_000, content: "ok" } })}\n`,
			{ flag: "a" },
		);
		const t = new Date(base + 900_000);
		utimesSync(target, t, t);

		// 关键：清掉内存里的一切，只靠磁盘索引里的旧偏移续扫
		simRestart();
		const after = await s.sessionListPayload(dir);
		expect(after.sessions.find((x: { sessionId: string }) => x.sessionId === "id-5")?.messageCount).toBe(2);
	});

	it("文件被删掉后条目跟着从索引里消失（不会残留幻影会话）", async () => {
		const s = svc();
		await s.sessionListPayload(dir);
		const indexPath = await waitForIndexFile();

		rmSync(files[0]!, { force: true });
		simRestart();
		const after = await s.sessionListPayload(dir);
		expect(after.sessions.map((x: { sessionId: string }) => x.sessionId)).not.toContain("id-0");

		// 等新一轮的去抖落盘，索引里也不该再有它
		await new Promise((r) => setTimeout(r, 800));
		const body = JSON.parse(readFileSync(indexPath, "utf8")) as { entries: Record<string, unknown> };
		expect(Object.keys(body.entries).some((p) => p.endsWith("s0.jsonl"))).toBe(false);
	});

	it("没有 dataDir（无状态存储）时只是不落盘，列表照常出", async () => {
		const s = fakeClientSession() as any;
		s.cwd = dir;
		s.settingsSvc = { current: {} };
		s.stateStore = { ...(s.stateStore ?? {}), isSessionPinned: () => false };
		s.sessionListLimits = new Map();
		const payload = await s.sessionListPayload(dir);
		expect(payload.sessions).toHaveLength(6);
		await new Promise((r) => setTimeout(r, 700));
		expect(indexFiles()).toEqual([]);
	});
});
