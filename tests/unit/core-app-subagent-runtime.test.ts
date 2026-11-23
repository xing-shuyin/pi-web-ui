import { describe, expect, it, vi } from "vitest";
import { createSubagentRuntime } from "../../server/core/app/subagent-runtime.js";
import { Conversation, ConversationRegistry } from "../../server/core/kernel/conversation/index.js";
import type { ClientRuntime } from "../../server/core/app/client-runtime.js";
import type { SessionRegistry } from "../../server/core/app/session-registry.js";

function fakeRuntime() {
	const registry = new ConversationRegistry<Conversation>();
	let active = "";
	const created: Conversation[] = [];
	const turns = { start: vi.fn(async () => "done" as const), steer: vi.fn(async () => {}) };
	const runtime = {
		registry,
		turns,
		activeConversationId: () => active || undefined,
		createConversation: (init: {
			id?: string;
			kind?: "user" | "subagent" | "cli" | "scheduled" | "bot";
			parentId?: string;
			title?: string;
			cwd?: string;
		}) => {
			const conv = new Conversation({
				id: init.id ?? `c-${registry.nextSeq()}`,
				clientId: "client-1",
				cwd: init.cwd ?? "/work",
				kind: init.kind ?? "user",
				createdAt: 1,
				parentId: init.parentId,
				title: init.title,
			});
			registry.add(conv);
			registry.activate(conv.id);
			active = conv.id;
			created.push(conv);
			return conv;
		},
	} as unknown as ClientRuntime;
	const sessions = {
		get: vi.fn(() => undefined),
		ensure: vi.fn(async () => ({ session: { dispose: () => {} }, sessionId: "s1", dispose: () => {} })),
		close: vi.fn(),
	} as unknown as SessionRegistry;
	return { runtime, sessions, created, turns, registry };
}

function make() {
	const fakes = fakeRuntime();
	fakes.runtime.createConversation({ id: "parent", kind: "user", title: "父对话" });
	const runtime = createSubagentRuntime({
		runtime: fakes.runtime,
		sessions: fakes.sessions,
		now: () => 1_000,
	});
	return { ...fakes, subagents: runtime };
}

describe("app · 子代理运行装配", () => {
	it("工具按对话身份装配", () => {
		const { subagents } = make();
		// 叶子把子代理能力对外暴露成 `conversation` 工具（CONVERSATION_TOOL_NAME 单源）
		const tool = subagents.toolFor("parent") as { name?: string };
		expect(tool.name).toBe("conversation");
	});

	it("settle 只对子代理对话生效", () => {
		const { subagents, runtime } = make();
		const parent = runtime.registry.get("parent");
		if (!parent) throw new Error("parent missing");
		subagents.settle("parent", "done");
		expect(subagents.registry.list()).toHaveLength(0);
	});

	it("子代理结算写进账本", async () => {
		const { subagents, runtime, turns } = make();
		const child = runtime.createConversation({ id: "child", kind: "subagent", parentId: "parent", title: "子任务" });
		subagents.registry.register({ id: child.id, parentId: "parent", title: "子任务", type: "general" });
		subagents.settle(child.id, "done");
		expect(subagents.registry.get(child.id)?.state).toBe("done");
		expect(turns.start).not.toHaveBeenCalled();
	});

	it("并发闸生效：超过上限再派发会抛", () => {
		const fakes = fakeRuntime();
		fakes.runtime.createConversation({ id: "parent", kind: "user", title: "父" });
		const subagents = createSubagentRuntime({
			runtime: fakes.runtime,
			sessions: fakes.sessions,
			now: () => 1,
			fanoutMax: 1,
		});
		subagents.registry.register({ id: "s1", parentId: "parent", title: "a", type: "general" });
		expect(() => subagents.registry.assertCanSpawn("parent")).toThrow();
	});
});
