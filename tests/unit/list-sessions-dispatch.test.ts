import { describe, expect, it, vi } from "vitest";
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

	it("isSessionMatchingProject accurately identifies sessions matching project slugs", () => {
		// Windows path with short project name like E:\t -> slug --e--t--
		expect(isSessionMatchingProject("C:/Users/c/.pi/agent/sessions/--e--t--/2026-03-31t11-00-00.jsonl", "E:/t")).toBe(
			true,
		);
		expect(
			isSessionMatchingProject("C:\\Users\\c\\.pi\\agent\\sessions\\--e--t--\\2026-03-31t11-00-00.jsonl", "E:\\t"),
		).toBe(true);

		// Windows path with desktop project
		expect(
			isSessionMatchingProject("C:/Users/c/.pi/agent/sessions/--c--users-c-desktop--/abc.jsonl", "C:/Users/c/Desktop"),
		).toBe(true);

		// Different project should not match
		expect(isSessionMatchingProject("C:/Users/c/.pi/agent/sessions/--e--other--/abc.jsonl", "E:/t")).toBe(false);
	});
});
