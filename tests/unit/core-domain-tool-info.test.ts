import { describe, expect, it } from "vitest";
import { createToolInfoHandlersFor } from "../../packages/keel/src/app/tool-info-handlers.js";
import type { SessionRegistry } from "../../packages/keel/src/app/session-registry.js";
import type { ToolInfoPort } from "../../packages/keel/src/contracts/session.js";
import { createToolInfoHandlers } from "../../packages/keel/src/domains/tools/index.js";
import { Conversation, ConversationRegistry } from "../../packages/keel/src/kernel/conversation/index.js";
import type { ServerMessage } from "../../server/protocol.js";

function fakeTransport() {
	const sent: ServerMessage[] = [];
	const port = { send: (msg: ServerMessage) => void sent.push(msg), isClosed: () => false };
	return { sent, port };
}

function conversation(id = "c1"): Conversation {
	return new Conversation({ id, clientId: "cl-1", cwd: "/w", kind: "user", createdAt: 1 });
}

/** 宿主端口：真实现的两件事（覆盖解析 + 载荷截断）在 `server/core-tool-info-adapter.ts`，这里按契约同口径。 */
function fakePort(override: { description?: string } | null = null): ToolInfoPort {
	return {
		promptOverrideOf: () => override,
		presentInfo: ({ name, base, override: ov, active }) => {
			if (!base) return { name, found: false };
			const description = (ov?.description ?? base.description) as string | undefined;
			return {
				name,
				found: true,
				...(description ? { description } : {}),
				...(typeof base.promptSnippet === "string" ? { promptSnippet: base.promptSnippet } : {}),
				active,
			};
		},
	};
}

/** 一条 SDK 会话的窄面（只实现工具三件事）。 */
function fakeSession(defs: Record<string, { description?: string; promptSnippet?: string }>, active: string[]) {
	return {
		getAllTools: () => Object.keys(defs).map((name) => ({ name, exposure: "direct" })),
		getToolDefinition: (name: string) => defs[name],
		getActiveToolNames: () => active,
	};
}

function runtime(
	over: {
		session?: ReturnType<typeof fakeSession>;
		port?: ToolInfoPort;
		withConversation?: boolean;
	} = {},
) {
	const registry = new ConversationRegistry<Conversation>();
	const conv = conversation();
	if (over.withConversation !== false) {
		registry.add(conv);
		registry.activate(conv.id);
	}
	const sessions = {
		get: (id: string) => (over.session && id === conv.id ? { session: over.session } : undefined),
	} as unknown as SessionRegistry;
	const { sent, port } = fakeTransport();
	return {
		sent,
		handlers: createToolInfoHandlersFor({
			registry,
			options: { sessions, transport: port, ...(over.port ? { toolInfo: () => over.port } : {}) },
		}),
	};
}

describe("domains/tools · get_tool_info / get_tool_prompt", () => {
	it("getToolInfo：清单命中 + 覆盖生效 + 活动集判定（一帧 tool_info）", () => {
		const { sent, handlers } = runtime({
			session: fakeSession({ bash: { description: "默认描述", promptSnippet: "跑命令" } }, ["bash"]),
			port: fakePort({ description: "覆盖描述" }),
		});
		handlers.getToolInfo("bash");
		expect(sent).toEqual([
			{
				type: "tool_info",
				name: "bash",
				found: true,
				description: "覆盖描述",
				promptSnippet: "跑命令",
				active: true,
			},
		]);
	});

	it("getToolInfo：清单里没有这条工具 → found:false（不编定义）", () => {
		const { sent, handlers } = runtime({ session: fakeSession({ bash: {} }, ["bash"]), port: fakePort() });
		handlers.getToolInfo("nope");
		expect(sent).toEqual([{ type: "tool_info", name: "nope", found: false }]);
	});

	it("getToolInfo：会话没开 → 也是 found:false（老实现 catch 同一结果）", () => {
		const { sent, handlers } = runtime({ port: fakePort() });
		handlers.getToolInfo("bash");
		expect(sent).toEqual([{ type: "tool_info", name: "bash", found: false }]);
	});

	it("getToolPrompt：默认文案 + 当前覆盖（含 found）", () => {
		const { sent, handlers } = runtime({
			session: fakeSession({ bash: { description: "默认描述", promptSnippet: "跑命令" } }, ["bash"]),
			port: fakePort({ description: "覆盖描述" }),
		});
		handlers.getToolPrompt("bash");
		expect(sent).toEqual([
			{
				type: "tool_prompt",
				name: "bash",
				found: true,
				defaultDescription: "默认描述",
				defaultPromptSnippet: "跑命令",
				override: { description: "覆盖描述" },
			},
		]);
	});

	it("getToolPrompt：拿不到定义 → found:false 但仍把当前覆盖发回去", () => {
		const { sent, handlers } = runtime({ port: fakePort({ description: "覆盖描述" }) });
		handlers.getToolPrompt("bash");
		expect(sent).toEqual([{ type: "tool_prompt", name: "bash", found: false, override: { description: "覆盖描述" } }]);
	});
});

describe("domains/tools · 未注入端口即同步抛", () => {
	it("getToolInfo / getToolPrompt 都同步抛 CoreEngineNotReadyError（不是 rejected promise）", () => {
		const { sent, handlers } = runtime({ session: fakeSession({ bash: {} }, []) });
		expect(() => handlers.getToolInfo("bash")).toThrow(/CoreEngineNotReadyError|core engine: getToolInfo/);
		expect(() => handlers.getToolPrompt("bash")).toThrow(/core engine: getToolPrompt/);
		expect(sent).toEqual([]);
	});

	it("裸 domains 工厂同样同步抛（未注入 = 未接）", () => {
		const handlers = createToolInfoHandlers({ inventory: () => undefined, emit: () => {} });
		expect(() => handlers.getToolInfo("bash")).toThrow(/core engine: getToolInfo/);
	});
});
