import { describe, expect, it, vi } from "vitest";
import { _chatReducerForTest, type ChatState } from "../../web/src/use-chat.js";
import { handleTerminalMessage } from "../../server/dispatch-domain-handlers.js";
import type { DispatchSession, TerminalManagerLike } from "../../server/index.js";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";

describe("用户直接创建的终端始终显示且不受对话影响和过滤", () => {
	const createInitialState = (): ChatState =>
		({
			status: "open",
			ready: true,
			appVersion: "1.0.0",
			managed: false,
			tabs: ["git", "files", "terminal"],
			state: {
				cwd: "/test",
				conversationId: "conv-1",
				sessionId: "s1",
				messages: [],
				model: { provider: "mock", id: "m1" },
				thinkingLevel: "high",
				busy: false,
				isStreaming: false,
				rev: 1,
				isEphemeral: false,
			} as any,
			activeConversationId: "conv-1",
			conversations: [],
			sessions: [],
			commands: [],
			terminals: [],
			terminalActiveId: null,
			optimisticQueue: { items: [], sentTracker: new Map() } as any,
			transition: null,
			approval: null,
			liveOutputs: new Map() as any,
			toolStatuses: new Map() as any,
			dsh: null,
			dshPatches: null,
			dshMarket: null,
			dshPresets: null,
			dshPermission: null,
			models: [],
			providers: [],
			notices: [],
			protocolMismatch: false,
			hostMetrics: null,
			latencyMs: null,
		}) as any as ChatState;

	it("1. 前端 Reducer：空权威 terminal_list 移除本地残留的用户终端", () => {
		const state0 = createInitialState();

		const state1 = _chatReducerForTest(state0, {
			type: "terminal_add",
			meta: {
				id: "user-term-1",
				title: "终端 1",
				cwd: "/test",
				cols: 80,
				rows: 24,
				running: true,
				exitCode: null,
				conversationId: "conv-1",
				agentBash: false,
			},
		});

		expect(state1.terminals).toHaveLength(1);
		expect(state1.terminals[0].id).toBe("user-term-1");

		const state2 = _chatReducerForTest(
			{ ...state1, activeConversationId: "conv-2" },
			{
				type: "terminal_list",
				conversationId: "conv-2",
				terminals: [],
			},
		);

		expect(state2.terminals).toEqual([]);
	});

	it("2. 前端 Reducer：新对话推来的 terminal_list 包含 AI 终端时，用户终端与新对话 AI 终端正确合并，旧对话 AI 终端不残留", () => {
		const state0 = createInitialState();

		const state1: ChatState = {
			...state0,
			activeConversationId: "conv-1",
			terminals: [
				{
					id: "user-term-1",
					title: "终端 1",
					cwd: "/test",
					cols: 80,
					rows: 24,
					running: true,
					exitCode: null,
					conversationId: "conv-1",
					agentBash: false,
				},
				{
					id: "ai-bash-conv1",
					title: "AI Bash",
					cwd: "/test",
					cols: 80,
					rows: 24,
					running: true,
					exitCode: null,
					conversationId: "conv-1",
					agentBash: true,
				},
			],
		};

		const state2 = _chatReducerForTest(
			{ ...state1, activeConversationId: "conv-2" },
			{
				type: "terminal_list",
				conversationId: "conv-2",
				terminals: [
					{
						id: "user-term-1",
						title: "终端 1",
						cwd: "/test",
						cols: 80,
						rows: 24,
						running: true,
						exitCode: null,
						agentBash: false,
					},
					{
						id: "ai-bash-conv2",
						title: "AI Bash 2",
						cwd: "/test",
						cols: 80,
						rows: 24,
						running: true,
						exitCode: null,
						agentBash: true,
					},
				],
			},
		);

		expect(state2.terminals).toHaveLength(2);
		expect(state2.terminals.find((t) => t.id === "user-term-1")).toBeDefined();
		expect(state2.terminals.find((t) => t.id === "ai-bash-conv1")).toBeUndefined();
		expect(state2.terminals.find((t) => t.id === "ai-bash-conv2")).toBeDefined();
	});

	it("3. 前端 Reducer：终端退出事件不受 conversationId 过滤阻断，跨对话也能正常标记退出状态", () => {
		const state0 = createInitialState();
		const state1: ChatState = {
			...state0,
			activeConversationId: "conv-2",
			terminals: [
				{
					id: "user-term-1",
					title: "终端 1",
					cwd: "/test",
					cols: 80,
					rows: 24,
					running: true,
					exitCode: null,
					conversationId: "conv-1",
					agentBash: false,
				},
			],
		};

		const state2 = _chatReducerForTest(state1, {
			type: "terminal_exit",
			terminalId: "user-term-1",
			conversationId: "conv-1",
			exitCode: 0,
		});

		expect(state2.terminals[0].running).toBe(false);
		expect(state2.terminals[0].exitCode).toBe(0);
	});

	it("4. 服务端路由：用户直接创建的终端（!agentBash）和命令运行分流至 getUserTerminalManager", () => {
		const userTm: TerminalManagerLike = {
			create: vi.fn(),
			input: vi.fn(),
			resize: vi.fn(),
			kill: vi.fn(),
			rename: vi.fn(),
			runCommand: vi.fn(),
		};
		const convTm: TerminalManagerLike = {
			create: vi.fn(),
			input: vi.fn(),
			resize: vi.fn(),
			kill: vi.fn(),
			rename: vi.fn(),
			runCommand: vi.fn(),
		};

		const cs = {
			getUserTerminalManager: vi.fn(() => userTm),
			getTerminalManager: vi.fn(() => convTm),
			findTerminalManager: vi.fn((terminalId: string) => {
				if (terminalId === "user-term") return userTm;
				return convTm;
			}),
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
				conversationId: "conv-1",
			},
			cs,
		);
		expect(userTm.create).toHaveBeenCalledWith("user-term", "/test", 80, 24, "/test", undefined, {
			locale: undefined,
			agentBash: false,
		});
		expect(convTm.create).not.toHaveBeenCalled();

		handleTerminalMessage(
			{
				type: "terminal_create",
				terminalId: "ai-bash",
				cwd: "/test",
				cols: 80,
				rows: 24,
				agentBash: true,
				conversationId: "conv-1",
			},
			cs,
		);
		expect(convTm.create).toHaveBeenCalledWith("ai-bash", "/test", 80, 24, "/test", undefined, {
			locale: undefined,
			agentBash: true,
		});

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
		expect(userTm.runCommand).toHaveBeenCalledWith(
			"cmd-term",
			{ name: "build", command: "npm run build" },
			80,
			24,
			"/test",
		);

		handleTerminalMessage(
			{
				type: "terminal_input",
				terminalId: "user-term",
				data: "ls\r",
				conversationId: "conv-99",
			},
			cs,
		);
		expect(userTm.input).toHaveBeenCalledWith("user-term", "ls\r");
	});

	it("retains client PTYs and both conversation identities when a list arrives before its snapshot", () => {
		const state = createInitialState();
		const base = { title: "Terminal", cwd: "/test", cols: 80, rows: 24, running: true, exitCode: null };
		state.terminals = [{ ...base, id: "active-ai", ownerKind: "conversation", conversationId: "conv-1" }];
		const next = _chatReducerForTest(state, {
			type: "terminal_list",
			conversationId: "conv-2",
			terminals: [
				{ ...base, id: "native", ownerKind: "client", nativeCli: { preset: "claude" } },
				{ ...base, id: "next-ai", ownerKind: "conversation" },
			],
		});
		expect(next.terminals.find((item) => item.id === "native")?.nativeCli?.preset).toBe("claude");
		expect(next.terminals.find((item) => item.id === "active-ai")?.conversationId).toBe("conv-1");
		expect(next.terminals.find((item) => item.id === "next-ai")?.conversationId).toBe("conv-2");
		expect(next.activeConversationId).toBe("conv-1");
	});

	it("never broadcasts a conversation-only empty list over live client CLI metadata", () => {
		const emitted: any[] = [];
		const cs = fakeClientSession() as any;
		cs.emit = (message: any) => emitted.push(message);
		cs.activeId = "active";
		cs.convs = new Map([["active", { id: "active", terminals: { list: () => [], replay: () => [] } }]]);
		cs.userTerminals = {
			list: () => [{ id: "native", ownerKind: "client", nativeCli: { preset: "claude" } }],
			replay: () => [],
		};
		cs.emitTerminal("active", { type: "terminal_list", terminals: [] });
		expect(emitted).toEqual([
			{
				type: "terminal_list",
				conversationId: "active",
				terminals: [{ id: "native", ownerKind: "client", nativeCli: { preset: "claude" } }],
			},
		]);
		cs.emitTerminal("background", { type: "terminal_list", terminals: [] });
		expect(emitted).toHaveLength(1);
	});

	it("5. 服务端 ClientSession.pushTerminals：始终合并下发 userTerminals 与当前对话 terminals", () => {
		const emitted: any[] = [];
		const cs = fakeClientSession() as any;
		cs.emit = (msg: any) => emitted.push(msg);

		cs.userTerminals = {
			list: () => [
				{
					id: "user-term-1",
					title: "终端 1",
					cwd: "/test",
					cols: 80,
					rows: 24,
					running: true,
					exitCode: null,
					agentBash: false,
				},
			],
			replay: () => [{ terminalId: "user-term-1", data: "user output\r\n" }],
		};

		const conv1 = {
			id: "conv-1",
			terminals: {
				list: () => [
					{
						id: "ai-bash-1",
						title: "AI Bash",
						cwd: "/test",
						cols: 80,
						rows: 24,
						running: true,
						exitCode: null,
						agentBash: true,
					},
				],
				replay: () => [{ terminalId: "ai-bash-1", data: "ai output\r\n" }],
			},
		};

		cs.pushTerminals(conv1);

		const listMsg = emitted.find((m) => m.type === "terminal_list");
		expect(listMsg).toBeDefined();
		expect(listMsg.conversationId).toBe("conv-1");
		expect(listMsg.terminals).toHaveLength(2);
		expect(listMsg.terminals[0].id).toBe("user-term-1");
		expect(listMsg.terminals[1].id).toBe("ai-bash-1");

		const outputMsgs = emitted.filter((m) => m.type === "terminal_output");
		expect(outputMsgs).toHaveLength(2);
		expect(outputMsgs.map((m) => m.terminalId)).toEqual(["user-term-1", "ai-bash-1"]);
	});
});
