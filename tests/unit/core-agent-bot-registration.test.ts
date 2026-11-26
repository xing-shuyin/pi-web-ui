import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoreBotChat } from "../../server/core-bot-adapter.js";
import { setAgentBotHost } from "../../server/device-center/bot-creation-tool.js";
import { createEngineSessionRegistry } from "../../packages/keel/src/app/engine-sessions.js";
import { PluginToolsBinder } from "../../packages/keel/src/app/plugin-tools-binder.js";
import { lazyCatalogInput } from "../../packages/keel/src/domains/tools/lazy-state.js";

afterEach(() => {
	setAgentBotHost(undefined);
});

describe("agent_bot 宿主端口与主对话注册", () => {
	it("createCoreBotChat().creationTool 仅在宿主接入草案仓库时返回 agent_bot", () => {
		const port = createCoreBotChat({ agentDir: "/tmp/agent-dir" });
		setAgentBotHost(undefined);
		expect(port.creationTool?.()).toBeUndefined();

		setAgentBotHost({
			draft: vi.fn(),
			list: vi.fn(async () => []),
			cancel: vi.fn(async () => {}),
		});
		const tool = port.creationTool?.() as { name?: string; promptSnippet?: string } | undefined;
		expect(tool?.name).toBe("agent_bot");
		expect(tool?.promptSnippet).toBeTruthy();
	});

	it("engine-sessions 只为普通主对话注册 agent_bot，子代理 / Bot 私聊 / Bot 执行均不注册", () => {
		setAgentBotHost({
			draft: vi.fn(),
			list: vi.fn(async () => []),
			cancel: vi.fn(async () => {}),
		});
		const port = createCoreBotChat({ agentDir: "/tmp/agent-dir" });
		let botExecActive = false;

		const registry = createEngineSessionRegistry({
			agentDir: "/tmp/agent-dir",
			cwd: "/tmp/work",
			clientId: "c1",
			stateStore: {
				getSettingsSnapshot: () => ({ toolLazyLoading: true, toolOnDemandTools: ["agent_bot"] }) as any,
				subscribeSettings: () => () => {},
			} as any,
			chatModes: { planModeOf: () => false, delegateModeOf: () => false } as any,
			presets: { agentPresetOf: () => undefined, permissionOf: () => undefined } as any,
			bashKills: {} as any,
			askWaiter: {} as any,
			approvalWaiter: {} as any,
			transport: { send: vi.fn() } as any,
			pluginTools: new PluginToolsBinder(() => undefined),
			pluginToolFilter: () => ({ tools: [] }) as any,
			langOf: () => "zh",
			bots: () => ({
				...port,
				toolFace: () => (botExecActive ? { allows: () => true, tools: () => [] } : undefined),
			}),
			getRuntime: () =>
				({ roots: ["/tmp/work"], publisher: { request: vi.fn() }, registry: { list: () => [] } }) as any,
			getFaces: () => ({ background: {} }) as any,
		});

		const options = (registry as unknown as { options: { customToolsFor: (conv: any) => Array<{ name?: string }> } })
			.options;

		const userNames = options
			.customToolsFor({ id: "u1", meta: { kind: "user", cwd: "/tmp/work", clientId: "c1" } })
			.map((t) => t.name);
		expect(userNames).toContain("agent_bot");

		const subagentNames = options
			.customToolsFor({ id: "s1", meta: { kind: "subagent", cwd: "/tmp/work", clientId: "c1" } })
			.map((t) => t.name);
		expect(subagentNames).not.toContain("agent_bot");

		const botChatNames = options
			.customToolsFor({ id: "b1", meta: { kind: "bot", botId: "bot-1", cwd: "/tmp/work", clientId: "c1" } })
			.map((t) => t.name);
		expect(botChatNames).not.toContain("agent_bot");

		botExecActive = true;
		const botExecNames = options
			.customToolsFor({ id: "e1", meta: { kind: "user", cwd: "/tmp/work", clientId: "device-task-1" } })
			.map((t) => t.name);
		expect(botExecNames).not.toContain("agent_bot");
	});

	it("注册进会话库存后，agent_bot 在按需名单里能进入提示词目录", () => {
		const part = lazyCatalogInput({
			all: ["bash", "read", "edit", "write", "load_tools", "agent_bot"],
			allowed: ["bash", "read", "edit", "write", "load_tools", "agent_bot"],
			onDemand: ["agent_bot"],
		});
		expect(part.catalog).toEqual(["agent_bot"]);
		expect(part.resident).not.toContain("agent_bot");
	});
});
