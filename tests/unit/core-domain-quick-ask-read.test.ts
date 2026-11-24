import { describe, expect, it } from "vitest";
import { createQuickAskHandlersFor } from "../../packages/keel/src/app/quick-ask-handlers.js";
import type { SessionRegistry } from "../../packages/keel/src/app/session-registry.js";
import type {
	QuickAskConversationReadInput,
	QuickAskConversationReadPort,
} from "../../packages/keel/src/contracts/quick-ask.js";
import { readQuickAskConversation } from "../../packages/keel/src/domains/quick-ask/index.js";
import { Conversation, ConversationRegistry } from "../../packages/keel/src/kernel/conversation/index.js";

function conversation(id: string, kind: "user" | "cli" = "user", sessionFile?: string): Conversation {
	return new Conversation({ id, clientId: "cl-1", cwd: "/w", title: `对话 ${id}`, kind, createdAt: 1, sessionFile });
}

/** 宿主端口假体：把入参原样记下来，回一份固定快照（真实现的摘取逻辑在 `server/quick-ask-context.ts`）。 */
function fakePort(snapshot: { name: string; messages: { role: "user" | "assistant"; content: string }[] } | undefined) {
	const calls: Array<{ input: QuickAskConversationReadInput; aborted: boolean }> = [];
	const port: QuickAskConversationReadPort = {
		read: async (input, signal) => {
			calls.push({ input, aborted: signal.aborted });
			return snapshot
				? { ...snapshot, ...(input.conversation?.sessionFile ? { path: input.conversation.sessionFile } : {}) }
				: undefined;
		},
	};
	return { calls, port };
}

describe("domains/quick-ask · readQuickAskConversation（内核解析 + 宿主端口）", () => {
	it("按 conversationId 解出会话：标题 / 转录 / cwd 交给端口，返回端口给的快照", async () => {
		const registry = new ConversationRegistry<Conversation>();
		const conv = conversation("c1", "user", "/s/one.jsonl");
		registry.add(conv);
		const { calls, port } = fakePort({ name: "对话 c1", messages: [{ role: "user", content: "hi" }] });
		const snapshot = await readQuickAskConversation(
			{ kind: "conversation", conversationId: "c1" },
			new AbortController().signal,
			{
				registry,
				messagesOf: () => [{ role: "user", content: "hi" }],
				port: () => port,
			},
		);
		expect(snapshot).toEqual({ name: "对话 c1", path: "/s/one.jsonl", messages: [{ role: "user", content: "hi" }] });
		expect(calls).toHaveLength(1);
		expect(calls[0].input.conversation).toEqual({
			title: "对话 c1",
			cwd: "/w",
			sessionFile: "/s/one.jsonl",
			messages: [{ role: "user", content: "hi" }],
		});
	});

	it("给了 sessionFile 但与这条对话现在那份不是同一份 → undefined（换了转录就拒绝）", async () => {
		const registry = new ConversationRegistry<Conversation>();
		registry.add(conversation("c1", "user", "/s/one.jsonl"));
		const { calls, port } = fakePort({ name: "x", messages: [] });
		const snapshot = await readQuickAskConversation(
			{ kind: "conversation", conversationId: "c1", sessionFile: "/s/other.jsonl" },
			new AbortController().signal,
			{ registry, messagesOf: () => [], port: () => port },
		);
		expect(snapshot).toBeUndefined();
		expect(calls).toEqual([]);
	});

	it("按 sessionFile 找到已开着的对话（索引命中，不靠 id）", async () => {
		const registry = new ConversationRegistry<Conversation>();
		registry.add(conversation("c1", "user", "/s/one.jsonl"));
		const { calls, port } = fakePort({ name: "对话 c1", messages: [] });
		await readQuickAskConversation(
			{ kind: "conversation", sessionFile: "/s/one.jsonl" },
			new AbortController().signal,
			{
				registry,
				messagesOf: () => undefined,
				port: () => port,
			},
		);
		expect(calls[0].input.conversation?.title).toBe("对话 c1");
	});

	it("对话没开着 → 只把 source 交给端口读磁盘历史", async () => {
		const registry = new ConversationRegistry<Conversation>();
		const { calls, port } = fakePort({ name: "历史", messages: [] });
		await readQuickAskConversation(
			{ kind: "conversation", sessionFile: "/s/old.jsonl" },
			new AbortController().signal,
			{
				registry,
				messagesOf: () => undefined,
				port: () => port,
			},
		);
		expect(calls[0].input).toEqual({ source: { kind: "conversation", sessionFile: "/s/old.jsonl" } });
	});

	it("CLI 对话没有终端绑定 → 如实返回 undefined（不拿空转录糊弄）", async () => {
		const registry = new ConversationRegistry<Conversation>();
		registry.add(conversation("cli-1", "cli"));
		const { calls, port } = fakePort({ name: "cli", messages: [] });
		const snapshot = await readQuickAskConversation(
			{ kind: "conversation", conversationId: "cli-1" },
			new AbortController().signal,
			{
				registry,
				messagesOf: () => undefined,
				port: () => port,
			},
		);
		expect(snapshot).toBeUndefined();
		expect(calls).toEqual([]);
	});

	it("CLI 对话有终端绑定 → terminalId / preset 一起交给端口回放", async () => {
		const registry = new ConversationRegistry<Conversation>();
		registry.add(conversation("cli-1", "cli"));
		const { calls, port } = fakePort({ name: "cli", messages: [] });
		await readQuickAskConversation({ kind: "conversation", conversationId: "cli-1" }, new AbortController().signal, {
			registry,
			messagesOf: () => undefined,
			nativeCliOf: () => ({ terminalId: "t-1", preset: "codex" }),
			port: () => port,
		});
		expect(calls[0].input.conversation).toMatchObject({ terminalId: "t-1", preset: "codex" });
	});

	it("source 里既没 id 也没 sessionFile → undefined（不猜）", async () => {
		const registry = new ConversationRegistry<Conversation>();
		const { calls, port } = fakePort({ name: "x", messages: [] });
		expect(
			await readQuickAskConversation({ kind: "conversation" }, new AbortController().signal, {
				registry,
				messagesOf: () => undefined,
				port: () => port,
			}),
		).toBeUndefined();
		expect(calls).toEqual([]);
	});

	it("已中止的 signal → 直接抛（不带着 abort 的请求往下走）", async () => {
		const registry = new ConversationRegistry<Conversation>();
		const { calls, port } = fakePort({ name: "x", messages: [] });
		const controller = new AbortController();
		controller.abort();
		await expect(
			readQuickAskConversation({ kind: "conversation", conversationId: "c1" }, controller.signal, {
				registry,
				messagesOf: () => undefined,
				port: () => port,
			}),
		).rejects.toThrow();
		expect(calls).toEqual([]);
	});
});

describe("app/quick-ask-handlers · 装配与 fail-closed", () => {
	it("没注入宿主端口 → 同步抛 CoreEngineNotReadyError", () => {
		const registry = new ConversationRegistry<Conversation>();
		const handlers = createQuickAskHandlersFor({ registry, options: {} });
		expect(() =>
			handlers.readQuickAskConversation(
				{ kind: "conversation", sessionFile: "/s/a.jsonl" },
				new AbortController().signal,
			),
		).toThrow(/core engine: readQuickAskConversation/);
	});

	it("注入端口后转交成功（会话转录从 SessionRegistry 取）", async () => {
		const registry = new ConversationRegistry<Conversation>();
		const conv = conversation("c1", "user", "/s/one.jsonl");
		registry.add(conv);
		const { port } = fakePort({ name: "对话 c1", messages: [] });
		const sessions = {
			get: () => ({ session: { messages: [{ role: "user", content: "hi" }] } }),
		} as unknown as SessionRegistry;
		const handlers = createQuickAskHandlersFor({
			registry,
			options: { sessions, quickAskConversation: () => port },
		});
		const snapshot = await handlers.readQuickAskConversation(
			{ kind: "conversation", conversationId: "c1" },
			new AbortController().signal,
		);
		expect(snapshot?.name).toBe("对话 c1");
	});
});
