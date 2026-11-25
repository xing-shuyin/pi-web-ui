import { describe, expect, it, vi } from "vitest";
import { createSubagentRuntime } from "../../packages/keel/src/app/subagent-runtime.js";
import { Conversation, ConversationRegistry } from "../../packages/keel/src/kernel/conversation/index.js";
import type { ClientRuntime } from "../../packages/keel/src/app/client-runtime.js";
import type { SessionRegistry } from "../../packages/keel/src/app/session-registry.js";

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

describe("app · 子代理派发的运行态", () => {
	/** 派发真的会走：假运行时带 `openChildConversation`、会话注册表、设置帧（模板）与帧出口。 */
	function makeSpawn() {
		const registry = new ConversationRegistry<Conversation>();
		let seq = 0;
		const childSession = { thinkingLevel: "off", setThinkingLevel: vi.fn(), dispose: () => {} };
		const parentSession = { thinkingLevel: "low", dispose: () => {} };
		const sessions = {
			get: vi.fn((id: string) => (id === "parent" ? { session: parentSession } : undefined)),
			ensure: vi.fn(async () => ({ session: childSession, sessionId: "s-child", dispose: () => {} })),
			close: vi.fn(),
		};
		const turns = { start: vi.fn(async () => "done" as const), steer: vi.fn(async () => {}) };
		const transport = { send: vi.fn(), isClosed: () => false };
		const templates = [
			{ name: "thinker", description: "固定高强度", enabled: true, model: "", thinkingLevel: "high" },
			{ name: "inheritor", description: "跟随主对话", enabled: true, model: "", thinkingLevel: "" },
			{ name: "retired", description: "已停用", enabled: false, model: "", thinkingLevel: "max" },
		];
		const runtime = {
			registry,
			turns,
			options: {
				sessions,
				transport,
				settingsFrame: () => ({ subagentTemplates: () => templates }),
			},
			activeConversationId: () => "parent",
			openChildConversation: (init: { parentId: string; title: string; cwd?: string }) => {
				const conv = new Conversation({
					id: `sa-${++seq}`,
					clientId: "client-1",
					cwd: init.cwd ?? "/work",
					kind: "subagent",
					createdAt: 1,
					parentId: init.parentId,
					title: init.title,
				});
				registry.add(conv);
				return conv;
			},
		} as unknown as ClientRuntime;
		registry.add(
			new Conversation({
				id: "parent",
				clientId: "client-1",
				cwd: "/work",
				kind: "user",
				createdAt: 1,
				title: "父",
			}),
		);
		const subagents = createSubagentRuntime({
			runtime,
			sessions: sessions as unknown as SessionRegistry,
			now: () => 1,
		});
		const tool = subagents.toolFor("parent") as {
			execute: (id: string, params: unknown, a?: unknown, b?: unknown, ctx?: unknown) => Promise<unknown>;
		};
		return { subagents, tool, childSession, sessions };
	}

	it("模板档位落到子代理会话上", async () => {
		const { tool, childSession } = makeSpawn();
		await tool.execute("t1", { action: "spawn", prompt: "干活", type: "thinker" }, undefined, undefined, {
			cwd: "/work",
		});
		expect(childSession.setThinkingLevel).toHaveBeenCalledWith("high");
	});

	it("模板留空时跟随派发者当前档位（不是 SDK 默认）", async () => {
		const { tool, childSession } = makeSpawn();
		await tool.execute("t1", { action: "spawn", prompt: "干活", type: "inheritor" }, undefined, undefined, {
			cwd: "/work",
		});
		expect(childSession.setThinkingLevel).toHaveBeenCalledWith("low");
	});

	it("显式 thinking 优先于模板档位", async () => {
		const { tool, childSession } = makeSpawn();
		await tool.execute(
			"t1",
			{ action: "spawn", prompt: "干活", type: "thinker", thinking: "minimal" },
			undefined,
			undefined,
			{ cwd: "/work" },
		);
		expect(childSession.setThinkingLevel).toHaveBeenCalledWith("minimal");
	});

	it("停用的模板不可派发（也不产生子代理）", async () => {
		const { tool, sessions } = makeSpawn();
		const result = (await tool.execute(
			"t1",
			{ action: "spawn", prompt: "干活", template: "retired" },
			undefined,
			undefined,
			{ cwd: "/work" },
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("unavailable template: retired");
		expect(sessions.ensure).not.toHaveBeenCalled();
	});
});
