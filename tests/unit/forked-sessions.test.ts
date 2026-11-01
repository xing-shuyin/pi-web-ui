import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { ClientStateStore } from "../../server/client-state.js";
import { filterForkedParentSessions } from "../../server/session-parser.js";
import { SettingsService, type SettingsHost } from "../../server/settings-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";

interface MockSessionInfo {
	path: string;
	parentSessionPath?: string;
	name?: string;
	modified: Date;
}

const roots: string[] = [];
function tempStore(): ClientStateStore {
	const dir = mkdtempSync(join(tmpdir(), "pi-forked-sessions-"));
	roots.push(dir);
	return new ClientStateStore(join(dir, "client-state.json"));
}

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Fork 会话历史过滤（filterForkedParentSessions）", () => {
	it("默认隐藏被后续 fork 掉的父会话，只保留链尾叶子会话", () => {
		const now = Date.now();
		const sessions: MockSessionInfo[] = [
			{ path: "/sessions/session-1.jsonl", modified: new Date(now - 3000) },
			{
				path: "/sessions/session-2.jsonl",
				parentSessionPath: "/sessions/session-1.jsonl",
				modified: new Date(now - 2000),
			},
			{
				path: "/sessions/session-3.jsonl",
				parentSessionPath: "/sessions/session-2.jsonl",
				modified: new Date(now - 1000),
			},
			{ path: "/sessions/independent.jsonl", modified: new Date(now - 500) },
		];

		const visible = filterForkedParentSessions(sessions, false);
		expect(visible.map((s) => s.path)).toEqual(["/sessions/session-3.jsonl", "/sessions/independent.jsonl"]);
	});

	it("开启 showForkedParents=true 时同时保留父会话和所有分支子会话", () => {
		const now = Date.now();
		const sessions: MockSessionInfo[] = [
			{ path: "/sessions/session-1.jsonl", modified: new Date(now - 2000) },
			{
				path: "/sessions/session-2.jsonl",
				parentSessionPath: "/sessions/session-1.jsonl",
				modified: new Date(now - 1000),
			},
		];

		const visible = filterForkedParentSessions(sessions, true);
		expect(visible.map((s) => s.path)).toEqual(["/sessions/session-1.jsonl", "/sessions/session-2.jsonl"]);
	});

	it("跨平台路径大小写与斜杠格式归一化比对", () => {
		const sessions: MockSessionInfo[] = [
			{ path: "C:\\Sessions\\Parent.jsonl", modified: new Date() },
			{
				path: "C:\\Sessions\\Child.jsonl",
				parentSessionPath: "c:/sessions/parent.jsonl",
				modified: new Date(),
			},
		];

		const visible = filterForkedParentSessions(sessions);
		expect(visible.map((s) => s.path)).toEqual(["C:\\Sessions\\Child.jsonl"]);
	});

	it("当父子链形成环时（即便列表同时存在其他独立会话）不会错误隐藏整条环链", () => {
		const sessions: MockSessionInfo[] = [
			{ path: "/sessions/a.jsonl", parentSessionPath: "/sessions/b.jsonl", modified: new Date() },
			{ path: "/sessions/b.jsonl", parentSessionPath: "/sessions/a.jsonl", modified: new Date() },
			{ path: "/sessions/independent.jsonl", modified: new Date() },
		];
		const visible = filterForkedParentSessions(sessions);
		expect(visible.map((s) => s.path)).toEqual([
			"/sessions/a.jsonl",
			"/sessions/b.jsonl",
			"/sessions/independent.jsonl",
		]);
	});

	it("自环 parentSessionPath（指向自身）不会把自己隐藏", () => {
		const sessions: MockSessionInfo[] = [
			{ path: "/sessions/self.jsonl", parentSessionPath: "/sessions/self.jsonl", modified: new Date() },
			{ path: "/sessions/other.jsonl", modified: new Date() },
		];
		const visible = filterForkedParentSessions(sessions);
		expect(visible.map((s) => s.path)).toEqual(["/sessions/self.jsonl", "/sessions/other.jsonl"]);
	});
});

describe("showForkedParentSessions 设置持久化与联动（#621）", () => {
	const templates = {
		list: () => [],
	} as unknown as import("../../server/subagent-templates.js").SubagentTemplatesStore;

	function makeHost(store: ClientStateStore): SettingsHost & { emitted: unknown[]; filterRefreshes: number } {
		const emitted: unknown[] = [];
		const host = {
			clientId: "forked-parent-test",
			stateStore: store,
			emit: (m: unknown) => {
				emitted.push(m);
			},
			flushSnapshot: () => {},
			isDisposed: () => false,
			getSession: () => {
				throw new Error("no session");
			},
			cwd: () => "/tmp",
			agentDir: () => "/tmp",
			isStreaming: () => false,
			reloadSession: async () => {},
			applyRetryOverrides: () => {},
			applyCompactionOverrides: () => {},
			applyToolGating: () => {},
			promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
			onSessionsFilterChanged: () => {
				host.filterRefreshes++;
			},
			emitted,
			filterRefreshes: 0,
		};
		return host as unknown as SettingsHost & { emitted: unknown[]; filterRefreshes: number };
	}

	it("默认值为 false，切换后持久化并触发 onSessionsFilterChanged 重推历史列表", async () => {
		const store = tempStore();
		expect(store.getSettings("c").showForkedParentSessions).toBe(false);

		const host = makeHost(store);
		const svc = new SettingsService(host, templates);
		expect(svc.current.showForkedParentSessions).toBe(false);

		await svc.set({ showForkedParentSessions: true });
		expect(svc.current.showForkedParentSessions).toBe(true);
		expect(store.getSettings("c").showForkedParentSessions).toBe(true);
		expect(host.filterRefreshes).toBe(1);

		const state = host.emitted.filter((m) => (m as { type?: string }).type === "settings_state").pop() as
			{ settings: { showForkedParentSessions?: boolean } } | undefined;
		expect(state?.settings.showForkedParentSessions).toBe(true);
	});

	it("editMessage 在原会话重问，提示不受 showForkedParentSessions 影响，并刷新会话缓存", async () => {
		const runEdit = async (showForkedParentSessions: boolean) => {
			const emitted: unknown[] = [];
			const session = fakeClientSession() as any;
			session.quiesceBlocked = () => false;
			session.emit = (msg: unknown) => emitted.push(msg);
			session.flushSnapshot = vi.fn();
			session.resolveUserMessageEntryId = vi.fn().mockReturnValue("entry-1");
			session.applySessionOverrides = vi.fn();
			session.invalidateSessionInfos = vi.fn();
			session.scheduleSessionsRefresh = vi.fn();
			session.prompt = vi.fn().mockResolvedValue(undefined);
			session.settingsSvc = { current: { showForkedParentSessions } };
			const conv = {
				id: "c1",
				session: {
					agent: { state: { model: null }, replaceMessages: vi.fn() },
					clearQueue: vi.fn(),
					reload: vi.fn().mockResolvedValue(undefined),
					thinkingLevel: null,
					sessionManager: {
						getLeafId: () => "entry-1",
						getEntry: () => ({ id: "entry-1", type: "message", message: { role: "user" }, parentId: null }),
						resetLeaf: vi.fn(),
						appendCustomEntry: vi.fn(),
						buildSessionContext: () => ({ messages: [] }),
					},
					sessionFile: "/sessions/parent.jsonl",
				},
				runtime: {
					newSession: vi.fn().mockResolvedValue({ cancelled: false }),
					fork: vi.fn().mockResolvedValue({ cancelled: false }),
				},
				uiMessageCache: new Map(),
				msgIds: new Map(),
				userSeqByTs: new Map(),
				nextMsgId: 2,
				lastMessagesSig: "sig",
				lastMessagesArray: [],
				queueSteering: [],
				queueFollowUp: [],
			};
			(conv.runtime as any).session = conv.session;
			session.activeId = "c1";
			session.convs = new Map([["c1", conv]]);

			await ClientSession.prototype.editMessage.call(session, "msg-1", "修改后的问题");
			expect(conv.runtime.fork).not.toHaveBeenCalled();
			expect(conv.runtime.newSession).not.toHaveBeenCalled();
			expect(session.prompt).toHaveBeenCalledExactlyOnceWith("修改后的问题", undefined, false, conv);
			expect(conv.session.sessionFile).toBe("/sessions/parent.jsonl");
			expect(session.convs.size).toBe(1);
			expect(session.invalidateSessionInfos).toHaveBeenCalledTimes(1);
			expect(session.scheduleSessionsRefresh).toHaveBeenCalledTimes(1);
			return emitted;
		};

		const emittedDefault = await runEdit(false);
		expect(emittedDefault).toEqual([
			expect.objectContaining({
				type: "notice",
				level: "info",
				text: "已在当前对话重新提问，后续历史已移除",
			}),
		]);

		const emittedShown = await runEdit(true);
		expect(emittedShown).toEqual([
			expect.objectContaining({
				type: "notice",
				level: "info",
				text: "已在当前对话重新提问，后续历史已移除",
			}),
		]);
	});
});
