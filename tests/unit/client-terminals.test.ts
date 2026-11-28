import { describe, expect, it, vi } from "vitest";
import { ClientTerminalRegistry } from "../../server/client-terminals.js";
import type { ServerMessage } from "../../server/protocol.js";

describe("ClientTerminalRegistry · 引擎无关的客户端用户终端", () => {
	it("attach 时下发 scope=client 的 terminal_list，detach 不销毁终端", () => {
		const registry = new ClientTerminalRegistry("/workspace");
		const sent1: ServerMessage[] = [];
		const sink1 = (msg: ServerMessage) => sent1.push(msg);

		registry.attach("c1", sink1, { getCwd: () => "/workspace/a", getLang: () => "zh" });
		expect(sent1).toEqual([{ type: "terminal_list", scope: "client", terminals: [] }]);

		registry.detach("c1", sink1);
		const sent2: ServerMessage[] = [];
		registry.attach("c1", (msg) => sent2.push(msg));
		expect(sent2).toEqual([{ type: "terminal_list", scope: "client", terminals: [] }]);
		registry.disposeAll();
	});

	it("只接管客户端级终端消息，conversation/agentBash 消息放行给引擎", () => {
		const registry = new ClientTerminalRegistry("/workspace");
		expect(
			registry.handleMessage("c1", {
				type: "terminal_create",
				terminalId: "conv-1",
				cwd: "/workspace",
				cols: 80,
				rows: 24,
				ownerKind: "conversation",
				conversationId: "conv-a",
			}),
		).toBe(false);

		expect(
			registry.handleMessage("c1", {
				type: "terminal_create",
				terminalId: "ai-bash-1",
				cwd: "/workspace",
				cols: 80,
				rows: 24,
				agentBash: true,
				conversationId: "conv-a",
			}),
		).toBe(false);

		expect(
			registry.handleMessage("c1", {
				type: "terminal_input",
				terminalId: "conv-1",
				data: "ls\r",
				ownerKind: "conversation",
				conversationId: "conv-a",
			}),
		).toBe(false);

		expect(
			registry.handleMessage("c1", {
				type: "terminal_attach",
				terminalId: "missing-client",
				cols: 80,
				rows: 24,
				ownerKind: "client",
			}),
		).toBe(true);

		expect(
			registry.handleMessage("c1", {
				type: "terminal_kill",
				terminalId: "missing-client",
				ownerKind: "client",
			}),
		).toBe(true);

		registry.disposeAll();
	});

	it("run_command 路由到独立终端管理器而不依赖任何引擎", () => {
		const registry = new ClientTerminalRegistry("/workspace");
		const sent: ServerMessage[] = [];
		registry.attach("c1", (msg) => sent.push(msg), { getCwd: () => "/workspace", getLang: () => "en" });

		// 即使没有 attach 任何引擎，run_command 也由 ClientTerminalRegistry 直接接管
		const handled = registry.handleMessage("c1", {
			type: "run_command",
			terminalId: "cmd-1",
			command: { name: "pwd", command: "echo ok" },
			cols: 80,
			rows: 24,
		});
		expect(handled).toBe(true);
		expect(registry.findManager("c1")).toBeDefined();
		registry.disposeAll();
	});
});
