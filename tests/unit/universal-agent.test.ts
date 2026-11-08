import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	UniversalSessionStore,
	UniversalSession,
	UniversalAgentService,
	MockAgentDriver,
	ClaudeCodeDriver,
	type UniversalConversation,
} from "../../server/universal/index.js";
import "../../server/markers/index.js";
import type { ServerMessage } from "../../server/protocol.js";

describe("Universal Agent 底座体系单测", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-universal-test-"));
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
			} catch {}
		}
	});

	describe("1. UniversalSessionStore 会话持久化", () => {
		it("能够正确创建、保存、读取与列出会话", () => {
			const store = new UniversalSessionStore(tempDir);
			const cwd = join(tempDir, "workspace");

			const conv: UniversalConversation = {
				id: "uconv-1",
				title: "测试会话",
				createdAt: 1000,
				updatedAt: 1000,
				messages: [
					{
						id: "u-1",
						role: "user",
						content: [{ type: "text", text: "hello" }],
					},
				],
			};

			store.saveConversation(cwd, conv);

			const loaded = store.loadConversation(cwd, "uconv-1");
			expect(loaded).toBeDefined();
			expect(loaded?.id).toBe("uconv-1");
			expect(loaded?.title).toBe("测试会话");
			expect(loaded?.messages.length).toBe(1);

			const list = store.listConversations(cwd);
			expect(list.length).toBe(1);
			expect(list[0].id).toBe("uconv-1");
		});

		it("能够重命名、置顶与删除会话", () => {
			const store = new UniversalSessionStore(tempDir);
			const cwd = join(tempDir, "workspace");

			const conv: UniversalConversation = {
				id: "uconv-2",
				title: "旧标题",
				createdAt: 1000,
				updatedAt: 1000,
				messages: [],
			};
			store.saveConversation(cwd, conv);

			store.renameConversation(cwd, "uconv-2", "新标题");
			expect(store.loadConversation(cwd, "uconv-2")?.title).toBe("新标题");

			store.pinConversation(cwd, "uconv-2", true);
			expect(store.loadConversation(cwd, "uconv-2")?.pinned).toBe(true);

			store.deleteConversation(cwd, "uconv-2");
			expect(store.loadConversation(cwd, "uconv-2")).toBeNull();
			expect(store.listConversations(cwd).length).toBe(0);
		});
	});

	describe("2. MockAgentDriver 驱动行为", () => {
		it("能力声明符合降级约定（不支持树状分叉与历史修改）", () => {
			const driver = new MockAgentDriver(tempDir);
			expect(driver.capabilities.supportsTreeFork).toBe(false);
			expect(driver.capabilities.supportsHistoryEdit).toBe(false);
			expect(driver.capabilities.supportsToolPromptOverride).toBe(false);
		});

		it("能够按生命周期发射思考、工具与正文事件", async () => {
			const driver = new MockAgentDriver(tempDir);
			const events: string[] = [];

			await driver.sendPrompt("test tool execution", undefined, {
				onThinkingDelta: (delta) => events.push(`thinking:${delta}`),
				onTextDelta: (delta) => events.push(`text:${delta}`),
				onToolStart: (id, name) => events.push(`toolStart:${name}:${id}`),
				onToolEnd: (id, res) => events.push(`toolEnd:${id}:${res.output?.trim()}`),
				onTurnComplete: (meta) => events.push(`complete:${meta?.model}`),
				onError: (err) => events.push(`error:${err}`),
			});

			expect(events.some((e) => e.startsWith("thinking:"))).toBe(true);
			expect(events.some((e) => e.startsWith("toolStart:bash"))).toBe(true);
			expect(events.some((e) => e.startsWith("toolEnd:"))).toBe(true);
			expect(events.some((e) => e.startsWith("text:"))).toBe(true);
			expect(events.some((e) => e.startsWith("complete:mock-model-v1"))).toBe(true);
		});
	});

	describe("3. ClaudeCodeDriver 驱动行为与事件解析", () => {
		it("能力声明与模型列表正常", async () => {
			const driver = new ClaudeCodeDriver(tempDir);
			expect(driver.id).toBe("claude-code");
			expect(driver.capabilities.supportsTreeFork).toBe(false);
			expect(driver.capabilities.supportsHistoryEdit).toBe(false);

			const models = await driver.listModels();
			expect(models.length).toBeGreaterThan(0);
			expect(models[0].id).toBe("default");
			expect(models.map((m) => m.id)).toEqual(expect.arrayContaining(["opus", "sonnet", "haiku"]));
			expect(models.some((m) => m.id.startsWith("claude-3-"))).toBe(false);
		});

		it("能够正确解析 Claude Code NDJSON 事件流并分发到 sink", () => {
			const driver = new ClaudeCodeDriver(tempDir);
			const received: {
				text: string[];
				thinking: string[];
				toolsStarted: Array<{ id: string; name: string }>;
				toolsEnded: Array<{ id: string; output?: string; error?: string }>;
				completeMeta?: unknown;
			} = {
				text: [],
				thinking: [],
				toolsStarted: [],
				toolsEnded: [],
			};

			const sink = {
				onTextDelta: (d: string) => received.text.push(d),
				onThinkingDelta: (d: string) => received.thinking.push(d),
				onToolStart: (id: string, name: string) => received.toolsStarted.push({ id, name }),
				onToolEnd: (id: string, res: { output?: string; error?: string }) => received.toolsEnded.push({ id, ...res }),
				onTurnComplete: (meta: unknown) => {
					received.completeMeta = meta;
				},
				onError: () => {},
			};

			const activeJson = new Map<string, string>();
			const parse = (evt: Record<string, unknown>) => {
				(driver as any).handleClaudeEvent(evt, sink, activeJson);
			};

			parse({
				type: "content_block_delta",
				delta: { type: "thinking_delta", thinking: "Pondering problem..." },
			});
			expect(received.thinking).toEqual(["Pondering problem..."]);

			parse({
				type: "content_block_delta",
				delta: { type: "text_delta", text: "I will list the files." },
			});
			expect(received.text).toEqual(["I will list the files."]);

			parse({
				type: "tool_use",
				id: "call_abc",
				name: "Bash",
				input: { command: "ls -la" },
			});
			expect(received.toolsStarted).toEqual([{ id: "call_abc", name: "Bash" }]);

			parse({
				type: "tool_result",
				tool_use_id: "call_abc",
				content: "README.md\npackage.json",
				is_error: false,
			});
			expect(received.toolsEnded).toEqual([{ id: "call_abc", output: "README.md\npackage.json" }]);

			parse({
				type: "result",
				usage: {
					input_tokens: 150,
					output_tokens: 60,
					cache_read_input_tokens: 100,
					cache_creation_input_tokens: 0,
				},
				model: "claude-3-7-sonnet-20250219",
			});
			expect(received.completeMeta).toMatchObject({
				usage: {
					inputTokens: 150,
					outputTokens: 60,
					cacheReadTokens: 100,
					cacheWriteTokens: 0,
				},
				model: "claude-3-7-sonnet-20250219",
			});
		});
	});

	describe("4. UniversalSession 核心会话与协议汇聚", () => {
		it("执行 Prompt 并正确生成标准的 UiMessage 与流式快照", async () => {
			const store = new UniversalSessionStore(tempDir);
			const sentMessages: ServerMessage[] = [];
			const driver = new MockAgentDriver(tempDir);

			const session = new UniversalSession({
				clientId: "test-client",
				cwd: tempDir,
				send: (msg) => sentMessages.push(msg),
				store,
				driver,
			});

			const initialSnapshots = sentMessages.filter((m) => m.type === "snapshot");
			expect(initialSnapshots.length).toBeGreaterThanOrEqual(0);

			await session.prompt("please run tool command");

			const deltas = sentMessages.filter((m) => m.type === "message_delta");
			expect(deltas.length).toBeGreaterThan(0);

			session.flushSnapshot();
			const finalSnapshot = sentMessages.filter((m) => m.type === "snapshot").pop();
			expect(finalSnapshot).toBeDefined();
			if (finalSnapshot && finalSnapshot.type === "snapshot") {
				const msgs = finalSnapshot.state.messages;
				expect(msgs.length).toBeGreaterThanOrEqual(3);

				const userMsg = msgs.find((m) => m.role === "user");
				expect(userMsg).toBeDefined();
				expect(userMsg?.content[0]).toEqual({ type: "text", text: "please run tool command" });

				const assistantMsg = msgs.find((m) => m.role === "assistant");
				expect(assistantMsg).toBeDefined();
				const hasThinking = assistantMsg?.content.some((b) => b.type === "thinking");
				const hasToolCall = assistantMsg?.content.some((b) => b.type === "toolCall");
				expect(hasThinking).toBe(true);
				expect(hasToolCall).toBe(true);

				const toolResultMsg = msgs.find((m) => m.role === "toolResult");
				expect(toolResultMsg).toBeDefined();
				expect(toolResultMsg?.toolName || toolResultMsg?.toolCallId).toBeDefined();
			}

			session.dispose();
		});

		it("支持停止生成 (abort)", async () => {
			const store = new UniversalSessionStore(tempDir);
			const sentMessages: ServerMessage[] = [];
			const driver = new MockAgentDriver(tempDir);

			const session = new UniversalSession({
				clientId: "test-client-abort",
				cwd: tempDir,
				send: (msg) => sentMessages.push(msg),
				store,
				driver,
			});

			await session.abort();
			expect(session.isStreaming).toBe(false);

			session.dispose();
		});

		it("支持会话管理 (newChat, switchConversation, renameConversation)", async () => {
			const store = new UniversalSessionStore(tempDir);
			const sentMessages: ServerMessage[] = [];
			const driver = new MockAgentDriver(tempDir);

			const session = new UniversalSession({
				clientId: "test-client-mgmt",
				cwd: tempDir,
				send: (msg) => sentMessages.push(msg),
				store,
				driver,
			});

			await session.newChat();
			await session.refreshSessions();

			const convMsg = sentMessages.find((m) => m.type === "conversations");
			expect(convMsg).toBeDefined();
			if (convMsg && convMsg.type === "conversations") {
				expect(convMsg.conversations.length).toBeGreaterThanOrEqual(1);
			}

			session.dispose();
		});

		it("本轮回复中的内联标记（如 [[action:suggest:...]]）在 finalizeTurn 中能被正确捕获与解析", async () => {
			const store = new UniversalSessionStore(tempDir);
			const sentMessages: ServerMessage[] = [];
			const driver = new MockAgentDriver(tempDir);

			const session = new UniversalSession({
				clientId: "test-client-marker",
				cwd: tempDir,
				send: (msg) => sentMessages.push(msg),
				store,
				driver,
			});

			await session.prompt("please suggest [[action:suggest:QuickAction]]");
			await new Promise((r) => setTimeout(r, 50));
			const activeId = (session as any).activeConvId;
			const suggestions = (session as any).markerSvc.getActionSuggestions(activeId);
			expect(suggestions?.some((s: any) => s.label === "QuickAction")).toBe(true);

			session.dispose();
		});
	});

	describe("5. UniversalAgentService 引擎服务管理", () => {
		it("正确实现 EngineService 接口并管理客户端会话生命周期", async () => {
			const sentMessages: ServerMessage[] = [];
			const service = new UniversalAgentService({
				cwd: tempDir,
				dataDir: tempDir,
			});

			const session = await service.attach("client-1", (msg) => sentMessages.push(msg));
			expect(session).toBeDefined();
			expect(service.get("client-1")).toBe(session);

			const status = service.serviceStatus();
			expect(status.cwd).toBe(tempDir);
			expect(status.quiesced).toBe(false);

			service.quiesce();
			expect(service.isQuiesced()).toBe(true);
			service.unquiesce();
			expect(service.isQuiesced()).toBe(false);

			service.detach("client-1");
			expect(service.get("client-1")).toBeUndefined();

			await service.disposeAll();
		});
	});

	describe("6. ClaudeCodeDriver 事件流与工具调用解析", () => {
		it("正确解析 assistant 消息中的 thinking 与 tool_use，以及 user 消息中的 tool_result", () => {
			const driver = new ClaudeCodeDriver(tempDir);
			const starts: Array<{ id: string; name: string; input: unknown }> = [];
			const ends: Array<{ id: string; result: unknown }> = [];
			const deltas: string[] = [];
			const thinkings: string[] = [];

			const sink = {
				onTextDelta: (delta: string) => deltas.push(delta),
				onThinkingDelta: (th: string) => thinkings.push(th),
				onToolStart: (id: string, name: string, input: unknown) => starts.push({ id, name, input }),
				onToolEnd: (id: string, result: unknown) => ends.push({ id, result }),
				onTurnComplete: () => {},
				onError: () => {},
			};

			const activeToolJson = new Map<string, string>();

			(driver as any).handleClaudeEvent(
				{
					type: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "thinking", thinking: "正在构思方案..." }],
					},
				},
				sink,
				activeToolJson,
			);
			expect(thinkings).toEqual(["正在构思方案..."]);

			(driver as any).handleClaudeEvent(
				{
					type: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "tool_use", id: "call_read_1", name: "Read", input: { file_path: "a.ts" } }],
					},
				},
				sink,
				activeToolJson,
			);
			expect(starts).toHaveLength(1);
			expect(starts[0]).toEqual({ id: "call_read_1", name: "Read", input: { file_path: "a.ts" } });

			(driver as any).handleClaudeEvent(
				{
					type: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "tool_use", id: "call_read_1", name: "Read", input: { file_path: "a.ts" } }],
					},
				},
				sink,
				activeToolJson,
			);
			expect(starts).toHaveLength(1);

			(driver as any).handleClaudeEvent(
				{
					type: "user",
					message: {
						role: "user",
						content: [{ type: "tool_result", tool_use_id: "call_read_1", content: "file content" }],
					},
				},
				sink,
				activeToolJson,
			);
			expect(ends).toHaveLength(1);
			expect(ends[0]).toEqual({ id: "call_read_1", result: { output: "file content" } });

			(driver as any).handleClaudeEvent(
				{
					type: "stream_event",
					event: {
						type: "content_block_delta",
						delta: { type: "text_delta", text: "最终结果" },
					},
				},
				sink,
				activeToolJson,
			);
			expect(deltas).toEqual(["最终结果"]);
		});
	});
});
