import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handleSessionLifecycleMessage } from "../../server/dispatch-domain-handlers.js";
import type { DispatchSession } from "../../server/index.js";
import { isSessionMatchingProject } from "../../web/src/use-chat.js";

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
});
