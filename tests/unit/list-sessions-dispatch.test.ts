import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleSessionLifecycleMessage } from "../../server/dispatch-domain-handlers.js";
import type { DispatchSession } from "../../server/engine-service.js";
import { isSessionMatchingProject } from "../../web/src/use-chat.js";
import { ClientRuntime } from "../../packages/keel/src/app/client-runtime.js";
import { createHostFaces } from "../../packages/keel/src/app/host-faces.js";
import { DshClientSession } from "../../server/dsh/dsh-agent-service.js";
import { projectKey } from "../../server/dsh/dsh-sessions.js";
import { resolveWorkspaceSessionDir } from "../../packages/keel/src/remote-workspace.js";
import { sessionDirOfBase } from "../../packages/keel/src/adapters/sdk/session-persist.js";

describe("list_sessions dispatch and matching", () => {
	it("routes list_sessions without path or with current cwd to refreshSessions", () => {
		const refreshSessions = vi.fn().mockResolvedValue(undefined);
		const pushSessionsForCwd = vi.fn().mockResolvedValue(undefined);
		const cs = {
			cwd: "/work/current",
			refreshSessions,
			pushSessionsForCwd,
		} as unknown as DispatchSession;

		expect(handleSessionLifecycleMessage({ type: "list_sessions" }, cs)).toBe(true);
		expect(refreshSessions).toHaveBeenCalledTimes(1);
		expect(pushSessionsForCwd).not.toHaveBeenCalled();

		expect(handleSessionLifecycleMessage({ type: "list_sessions", path: "/work/current" }, cs)).toBe(true);
		expect(refreshSessions).toHaveBeenCalledTimes(2);
		expect(pushSessionsForCwd).not.toHaveBeenCalled();
	});

	it("routes list_sessions with other project path to pushSessionsForCwd", () => {
		const refreshSessions = vi.fn().mockResolvedValue(undefined);
		const pushSessionsForCwd = vi.fn().mockResolvedValue(undefined);
		const cs = {
			cwd: "/work/current",
			refreshSessions,
			pushSessionsForCwd,
		} as unknown as DispatchSession;

		expect(handleSessionLifecycleMessage({ type: "list_sessions", path: "/work/other-project" }, cs)).toBe(true);
		expect(pushSessionsForCwd).toHaveBeenCalledWith("/work/other-project");
		expect(refreshSessions).not.toHaveBeenCalled();
	});

	it("dismiss_conversation 走 daemon 的跨端路由（左栏 elsewhere / 离线残骸行也删得掉）", async () => {
		const dismissConversation = vi.fn().mockResolvedValue(true);
		const localDismiss = vi.fn().mockResolvedValue(undefined);
		const cs = { cwd: "/work", dismissConversation: localDismiss } as unknown as DispatchSession;
		const daemon = { dismissConversation } as unknown as Parameters<typeof handleSessionLifecycleMessage>[3];

		expect(
			handleSessionLifecycleMessage(
				{ type: "dismiss_conversation", id: "elsewhere-conv", force: true, owner: "other-client" },
				cs,
				undefined,
				daemon,
				"viewer",
			),
		).toBe(true);
		await vi.waitFor(() =>
			expect(dismissConversation).toHaveBeenCalledWith("viewer", {
				type: "dismiss_conversation",
				id: "elsewhere-conv",
				force: true,
				owner: "other-client",
			}),
		);
		expect(localDismiss).not.toHaveBeenCalled();
	});

	it("index.ts 的引擎门面真的把 dismissConversation 接线了（曾经只声明没实现）", () => {
		const source = readFileSync(fileURLToPath(new URL("../../server/index.ts", import.meta.url)), "utf8");
		expect(source).toMatch(/^\t(?:async\s+)?dismissConversation\(clientId, msg\) \{/m);
	});

	it("isSessionMatchingProject does not attach every session to a project that contains the agent dir", () => {
		const session = "C:/Users/x/.pi/agent/sessions/--D--pi-web-ui--/2026-11-07T01-00-00-000Z_abc.jsonl";
		expect(isSessionMatchingProject(session, "C:/Users/x")).toBe(false);
		expect(isSessionMatchingProject(session, "C:\\Users\\x")).toBe(false);
		expect(isSessionMatchingProject(session, "D:/pi-web-ui")).toBe(true);
		expect(
			isSessionMatchingProject(
				"C:/Users/x/.pi/agent/sessions/--C--Users-x--/2026-11-07T01-00-00-000Z_h.jsonl",
				"C:/Users/x",
			),
		).toBe(true);
	});

	it("isSessionMatchingProject scopes engine sessions without a transcript path by their cwd", () => {
		expect(
			isSessionMatchingProject({ path: "conv-1", cwd: "D:/a", firstMessage: "", messageCount: 0, modified: 0 }, "D:/b"),
		).toBe(false);
		expect(
			isSessionMatchingProject(
				{ path: "conv-1", cwd: "D:\\a", firstMessage: "", messageCount: 0, modified: 0 },
				"D:/a",
			),
		).toBe(true);
	});

	it("isSessionMatchingProject accurately identifies sessions matching project slugs", () => {
		expect(isSessionMatchingProject("C:/Users/c/.pi/agent/sessions/--e--t--/2026-03-31t11-00-00.jsonl", "E:/t")).toBe(
			true,
		);
		expect(
			isSessionMatchingProject("C:\\Users\\c\\.pi\\agent\\sessions\\--e--t--\\2026-03-31t11-00-00.jsonl", "E:\\t"),
		).toBe(true);

		expect(
			isSessionMatchingProject("C:/Users/c/.pi/agent/sessions/--c--users-c-desktop--/abc.jsonl", "C:/Users/c/Desktop"),
		).toBe(true);

		expect(
			isSessionMatchingProject(
				"C:/Users/c/.pi/agent/sessions/--E--pi-web-ui-site--/2026-11-05T05-06-31-801Z_01a1aa19.jsonl",
				"E:/pi-web-ui",
			),
		).toBe(false);
		expect(
			isSessionMatchingProject(
				"C:/Users/c/.pi/agent/sessions/--E--pi-web-ui-site--/2026-11-05T05-06-31-801Z_01a1aa19.jsonl",
				"E:/pi-web-ui-site",
			),
		).toBe(true);
		expect(
			isSessionMatchingProject(
				"C:/Users/c/.pi/agent/sessions/--E--pi-web-ui-plugins--/2026-11-05T05-06-31-801Z_01a1aa19.jsonl",
				"E:/pi-web-ui",
			),
		).toBe(false);
		expect(
			isSessionMatchingProject(
				"C:/Users/c/.pi/agent/sessions/--E--pi-web-ui--/2026-11-05T05-06-31-801Z_01a1aa19.jsonl",
				"E:/pi-web-ui",
			),
		).toBe(true);

		expect(
			isSessionMatchingProject(
				"/home/user/.pi/agent/sessions/--home-user-project-extra--/abc.jsonl",
				"/home/user/project",
			),
		).toBe(false);
		expect(
			isSessionMatchingProject("/home/user/.pi/agent/sessions/--home-user-project--/abc.jsonl", "/home/user/project"),
		).toBe(true);

		expect(
			isSessionMatchingProject(
				{
					path: "C:/custom/path/session-1.jsonl",
					cwd: "E:/pi-web-ui",
					firstMessage: "hi",
					messageCount: 1,
					modified: 1,
				},
				"E:/pi-web-ui",
			),
		).toBe(true);
		expect(
			isSessionMatchingProject(
				{
					path: "C:/custom/path/session-1.jsonl",
					cwd: "E:/pi-web-ui-site",
					firstMessage: "hi",
					messageCount: 1,
					modified: 1,
				},
				"E:/pi-web-ui",
			),
		).toBe(false);

		expect(isSessionMatchingProject("C:/Users/c/.pi/agent/sessions/--e--other--/abc.jsonl", "E:/t")).toBe(false);
	});

	it("keel 引擎对非当前项目调用 pushSessionsForCwd 会扫描目标项目并回发 sessions 帧", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "keel-push-cwd-"));
		const currentCwd = join(dataDir, "proj-current");
		const otherCwd = join(dataDir, "proj-other");
		mkdirSync(currentCwd, { recursive: true });
		mkdirSync(otherCwd, { recursive: true });
		const otherSessionDir = sessionDirOfBase(resolveWorkspaceSessionDir(dataDir, otherCwd));
		mkdirSync(otherSessionDir, { recursive: true });
		const sessionFile = join(otherSessionDir, "2026-11-26T00-00-00-000Z_s1.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-11-26T00:00:00.000Z", cwd: otherCwd })}\n` +
				`${JSON.stringify({ type: "message", id: "m1", timestamp: "2026-11-26T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "other project question" }] } })}\n`,
			"utf8",
		);

		try {
			const sent: Array<Record<string, unknown>> = [];
			const stateStore = {
				dataDir,
				isSessionPinned: () => false,
				getDefaultModel: () => undefined,
				getSettingsSnapshot: () => ({}),
			};
			const runtime = new ClientRuntime({
				clientId: "c1",
				cwd: currentCwd,
				workspaceRoots: [currentCwd],
				env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: false }),
				clock: { now: () => Date.now(), after: () => () => {} },
				transport: { send: (msg) => void sent.push(msg as unknown as Record<string, unknown>), isClosed: () => false },
				builders: { full: () => ({ type: "notice" }) as never, delta: () => ({ type: "notice" }) as never } as never,
				stateStore: () => stateStore as never,
			});
			createHostFaces({
				runtime,
				clientId: "c1",
				cwd: currentCwd,
				agentDir: dataDir,
				stateStore: stateStore as never,
				transport: {
					send: (msg: unknown) => void sent.push(msg as Record<string, unknown>),
					isClosed: () => false,
				},
				sessions: new Map() as never,
				terminalHost: { managerFor: () => ({}) } as never,
				langOf: () => "zh",
				projectSource: {
					getRecentProjects: async () => [],
					removeProject: () => {},
					touchProject: () => {},
				},
				isDisposed: () => false,
			} as never);

			await runtime.handlers().pushSessionsForCwd?.(otherCwd);

			const frame = sent.find((m) => m.type === "sessions" && m.cwd === otherCwd) as
				{ type: "sessions"; cwd: string; sessions: Array<{ path: string; cwd: string }> } | undefined;
			expect(frame).toBeDefined();
			expect(frame?.sessions.map((s) => s.path)).toEqual([sessionFile]);
			expect(frame?.sessions[0]?.cwd).toBe(otherCwd);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("DSH 引擎对非当前项目调用 pushSessionsForCwd 会扫描目标项目并回发 sessions 帧", async () => {
		const sessionRoot = mkdtempSync(join(tmpdir(), "dsh-push-cwd-"));
		const currentCwd = join(sessionRoot, "proj-a");
		const otherCwd = join(sessionRoot, "proj-b");
		mkdirSync(currentCwd, { recursive: true });
		mkdirSync(otherCwd, { recursive: true });
		const logFile = join(sessionRoot, projectKey(otherCwd), "dsh-s1", "session.jsonl");
		mkdirSync(dirname(logFile), { recursive: true });
		writeFileSync(
			logFile,
			`${JSON.stringify({ type: "session/init", data: { cwd: otherCwd, sessionId: "dsh-s1" } })}\n` +
				`${JSON.stringify({ type: "user/message", data: { content: "hello dsh other" } })}\n`,
			"utf8",
		);

		try {
			const emitted: Array<Record<string, unknown>> = [];
			const fake = {
				cwd: currentCwd,
				sessionRoot,
				convs: new Map(),
				stateStore: undefined,
				getLang: () => "zh",
				defaultTitle: () => "新对话",
				emit: (msg: Record<string, unknown>) => emitted.push(msg),
				resolveSessionDisplayName: DshClientSession.prototype.resolveSessionDisplayName,
				pushSessions: (DshClientSession.prototype as unknown as { pushSessions(c?: string): Promise<void> })
					.pushSessions,
			};
			await DshClientSession.prototype.pushSessionsForCwd.call(fake, otherCwd);

			const frame = emitted.find((m) => m.type === "sessions" && m.cwd === otherCwd) as
				{ type: "sessions"; cwd: string; sessions: Array<{ sessionId: string; cwd: string }> } | undefined;
			expect(frame).toBeDefined();
			expect(frame?.sessions.map((s) => s.sessionId)).toEqual(["dsh-s1"]);
			expect(frame?.sessions[0]?.cwd).toBe(otherCwd);
		} finally {
			rmSync(sessionRoot, { recursive: true, force: true });
		}
	});
});
