/** B5：会话列表服务端分页（limit / hasMore / 按项目记住条数）+ 客户端 reducer 记录 hasMore。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";
import { _chatReducerForTest } from "../../web/src/use-chat.js";

const CS = ClientSession as unknown as Record<string, any>;
const saved: Record<string, unknown> = {};
let dir = "";
const prevEnv = process.env.PI_CODING_AGENT_SESSION_DIR;

beforeEach(() => {
	for (const k of ["SESSION_LIST_DEFAULT", "SESSION_LIST_PARSE_LIMIT", "SESSION_LIST_MAX"]) saved[k] = CS[k];
	// 缩小每页条数，避免测试里造几百个文件
	CS.SESSION_LIST_DEFAULT = 5;
	CS.SESSION_LIST_PARSE_LIMIT = 6;
	CS.SESSION_LIST_MAX = 50;
	CS.sessionFileCache.clear();
	CS.sessionInfosCache.clear();
	CS.sessionInfosInFlight.clear();
	dir = mkdtempSync(join(tmpdir(), "piwui-paging-"));
	process.env.PI_CODING_AGENT_SESSION_DIR = dir;
	const base = Date.now() - 100_000;
	for (let i = 0; i < 20; i++) {
		const p = join(dir, `s${String(i).padStart(2, "0")}.jsonl`);
		writeFileSync(
			p,
			[
				JSON.stringify({ type: "session", id: `id-${i}`, cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" }),
				JSON.stringify({ type: "message", message: { role: "user", timestamp: base + i * 1000, content: `msg ${i}` } }),
			].join("\n"),
		);
		const t = new Date(base + i * 1000);
		utimesSync(p, t, t);
	}
});

afterEach(() => {
	for (const [k, v] of Object.entries(saved)) CS[k] = v;
	if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
	else process.env.PI_CODING_AGENT_SESSION_DIR = prevEnv;
	rmSync(dir, { recursive: true, force: true });
});

function svc() {
	const s = fakeClientSession() as any;
	s.cwd = dir;
	s.settingsSvc = { current: {} };
	s.stateStore = { ...(s.stateStore ?? {}), isSessionPinned: () => false };
	s.sessionListLimits = new Map();
	return s;
}

describe("sessionListPayload", () => {
	it("默认一页 + hasMore；加大 limit 后翻到更多；全部下发后 hasMore=false；条数按项目记住", async () => {
		const s = svc();
		const page1 = await s.sessionListPayload(dir);
		expect(page1.sessions.map((x: { sessionId: string }) => x.sessionId)).toEqual([
			"id-19",
			"id-18",
			"id-17",
			"id-16",
			"id-15",
		]);
		expect(page1.hasMore).toBe(true);

		expect(s.setSessionListLimit(dir, 12)).toBe(12);
		const page2 = await s.sessionListPayload(dir);
		expect(page2.sessions).toHaveLength(12);
		expect(page2.sessions[11].sessionId).toBe("id-8");
		expect(page2.hasMore).toBe(true);

		s.setSessionListLimit(dir, 40);
		const all = await s.sessionListPayload(dir);
		expect(all.sessions).toHaveLength(20);
		expect(all.hasMore).toBe(false);

		// 不带 limit 的后续推送（每轮对话后的自动刷新）沿用记住的条数，不缩回第一页
		const again = await s.sessionListPayload(dir);
		expect(again.sessions).toHaveLength(20);
	});

	it("limit 夹在 [默认, 上限] 之间", () => {
		const s = svc();
		expect(s.setSessionListLimit(dir, 1)).toBe(5);
		expect(s.setSessionListLimit(dir, 10_000)).toBe(50);
		expect(s.setSessionListLimit(dir)).toBe(50);
		expect(s.setSessionListLimit(join(dir, "other"))).toBe(5);
	});
});

describe("reducer: sessions.hasMore", () => {
	it("按项目记录 / 清除 hasMore", () => {
		const base = { state: { cwd: "/p/a" }, sessions: [], projectSessions: {}, engine: undefined } as any;
		const s1 = _chatReducerForTest(base, { type: "sessions", sessions: [], cwd: "/p/a", hasMore: true } as any);
		expect(s1.projectSessionsHasMore).toEqual({ "/p/a": true });
		const s2 = _chatReducerForTest(s1, { type: "sessions", sessions: [], cwd: "/p/b", hasMore: true } as any);
		expect(Object.keys(s2.projectSessionsHasMore ?? {}).sort()).toEqual(["/p/a", "/p/b"]);
		const s3 = _chatReducerForTest(s2, { type: "sessions", sessions: [], cwd: "/p/a" } as any);
		expect(s3.projectSessionsHasMore).toEqual({ "/p/b": true });
	});
});
