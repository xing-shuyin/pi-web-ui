import { describe, expect, it, vi } from "vitest";
import type { DispatchSession, TerminalManagerLike } from "../../packages/keel/src/engine-service.js";
import { createTerminalHandlers } from "../../packages/keel/src/domains/terminals/index.js";
import { handleTerminalMessage } from "../../server/dispatch-domain-handlers.js";

function fakeTerminalManager(): { manager: TerminalManagerLike; calls: string[] } {
	const calls: string[] = [];
	const manager: TerminalManagerLike = {
		create: () => {
			calls.push("create");
		},
		input: () => {
			calls.push("input");
		},
		resize: () => {
			calls.push("resize");
		},
		kill: () => {
			calls.push("kill");
		},
		rename: () => {
			calls.push("rename");
		},
		runCommand: () => {
			calls.push("runCommand");
		},
	};
	return { manager, calls };
}

describe("getUserTerminalManager · 内核没有客户端级终端，如实 undefined", () => {
	it("恒返回 undefined：不伪造实例、也不抛（宿主按 ?? getTerminalManager 兜底）", () => {
		const handlers = createTerminalHandlers();
		expect(handlers.getUserTerminalManager()).toBeUndefined();
		// 反复调用也还是 undefined：不是「第一次没建好」的懒加载假象。
		expect(handlers.getUserTerminalManager()).toBeUndefined();
	});
});

describe("getUserTerminalManager · 语义落点：用户终端落到当前对话的管理器", () => {
	it("terminal_create（ownerKind=client）与 run_command 都走对话管理器，功能不丢", () => {
		const userTmCalls: string[] = [];
		const conv = fakeTerminalManager();
		const terminals = createTerminalHandlers();
		const cs = {
			getUserTerminalManager: () => {
				userTmCalls.push("called");
				return terminals.getUserTerminalManager();
			},
			getTerminalManager: vi.fn(() => conv.manager),
			getTerminalCwd: vi.fn(() => "/test"),
		} as unknown as DispatchSession;

		handleTerminalMessage(
			{
				type: "terminal_create",
				terminalId: "user-term",
				cwd: "/test",
				cols: 80,
				rows: 24,
				agentBash: false,
				ownerKind: "client",
				conversationId: "conv-1",
			},
			cs,
		);
		expect(userTmCalls).toEqual(["called"]);
		expect(conv.calls).toEqual(["create"]);

		handleTerminalMessage(
			{
				type: "run_command",
				terminalId: "cmd-term",
				command: { name: "build", command: "npm run build" },
				cols: 80,
				rows: 24,
				conversationId: "conv-1",
			},
			cs,
		);
		expect(conv.calls).toEqual(["create", "runCommand"]);
	});
});
