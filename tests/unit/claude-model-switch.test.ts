/**
 * claude-model-switch.test.ts — Claude 引擎模型切换与状态联动端到端单测。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UniversalSession } from "../../server/universal/universal-session.js";
import { UniversalSessionStore } from "../../server/universal/session-store.js";
import { ClaudeCodeDriver, resolveClaudeExecutable } from "../../server/universal/drivers/claude-code.js";
import type { ServerMessage, UiState } from "../../server/protocol.js";

describe("Claude 引擎模型切换与状态联动", () => {
	let testAgentDir: string;
	let testDataDir: string;
	let store: UniversalSessionStore;

	beforeEach(() => {
		testAgentDir = mkdtempSync(join(tmpdir(), "pi-claude-model-test-agent-"));
		testDataDir = mkdtempSync(join(tmpdir(), "pi-claude-model-test-data-"));
		store = new UniversalSessionStore(testDataDir);
	});

	afterEach(() => {
		try {
			rmSync(testAgentDir, { recursive: true, force: true });
			rmSync(testDataDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("Claude 引擎初始状态能够与官方首选模型正确对齐", async () => {
		const emitted: ServerMessage[] = [];
		const driver = new ClaudeCodeDriver(process.cwd(), { agentDir: testAgentDir });
		const session = new UniversalSession({
			clientId: "test-client",
			cwd: process.cwd(),
			agentDir: testAgentDir,
			send: (msg) => emitted.push(msg),
			store,
			driver,
		});

		// 触发首次快照与模型列表
		session.flushSnapshot(true);
		await session.listModels();

		const snapshots = emitted.filter((m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot");
		const modelsMsg = emitted.find((m): m is Extract<ServerMessage, { type: "models" }> => m.type === "models");

		expect(snapshots.length).toBeGreaterThan(0);
		expect(modelsMsg).toBeDefined();

		const latestState: UiState = snapshots[snapshots.length - 1].state;
		expect(latestState.model).toBeDefined();

		// 前端组件计算的 currentModelId = `${model.provider}/${model.id}`
		const currentModelId = `${latestState.model!.provider}/${latestState.model!.id}`;
		expect(currentModelId).toBe("claude-code/claude-3-7-sonnet-20250219");

		// 必须与 models 列表中的第一项严格匹配（确保顶栏勾选与高亮正确）
		const firstModel = modelsMsg!.models[0];
		expect(currentModelId).toBe(firstModel.id);
		expect(latestState.model!.name).toBe(firstModel.name);

		session.dispose();
	});

	it("在 Claude 引擎下切换到官方其他模型（如 Sonnet 3.5）时，状态、名称与前端计算 ID 完整更新", async () => {
		const emitted: ServerMessage[] = [];
		const driver = new ClaudeCodeDriver(process.cwd(), { agentDir: testAgentDir });
		const session = new UniversalSession({
			clientId: "test-client",
			cwd: process.cwd(),
			agentDir: testAgentDir,
			send: (msg) => emitted.push(msg),
			store,
			driver,
		});

		await session.listModels();
		emitted.length = 0; // 清空前置消息

		// 模拟用户在前端下拉框中点击切换到 Claude 3.5 Sonnet
		await session.setModel("claude-code/claude-3-5-sonnet-20241022");

		const snapshots = emitted.filter((m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot");
		const notices = emitted.filter((m): m is Extract<ServerMessage, { type: "notice" }> => m.type === "notice");

		expect(snapshots.length).toBeGreaterThan(0);
		const state: UiState = snapshots[snapshots.length - 1].state;

		// 1. 快照中的 bare ID 必须是 claude-3-5-sonnet-20241022（无重复前缀）
		expect(state.model?.id).toBe("claude-3-5-sonnet-20241022");
		expect(state.model?.provider).toBe("claude-code");

		// 2. 按钮显示的名称必须同步更新为 Claude 3.5 Sonnet（绝不能依然是 3.7）
		expect(state.model?.name).toBe("Claude 3.5 Sonnet");

		// 3. 前端拼接的 currentModelId 必须准确等于点击的 modelId
		const currentModelId = `${state.model?.provider}/${state.model?.id}`;
		expect(currentModelId).toBe("claude-code/claude-3-5-sonnet-20241022");

		// 4. 必须向客户端发送切换成功通知
		expect(notices.some((n) => n.text?.includes("Claude 3.5 Sonnet"))).toBe(true);

		session.dispose();
	});

	it("在 Claude 引擎下切换到 models.json 中配置的自定义代理模型时，正确解构并更新", async () => {
		// 写入自定义代理服务商与模型
		writeFileSync(
			join(testAgentDir, "models.json"),
			JSON.stringify({
				providers: {
					"my-proxy": {
						name: "专用中转站",
						baseUrl: "https://proxy.ai/v1",
						apiKey: "sk-proxy-key",
						models: [{ id: "claude-3-7-sonnet", name: "Claude 3.7 (代理)" }],
					},
				},
			}),
			"utf8",
		);

		const emitted: ServerMessage[] = [];
		const driver = new ClaudeCodeDriver(process.cwd(), { agentDir: testAgentDir });
		const session = new UniversalSession({
			clientId: "test-client",
			cwd: process.cwd(),
			agentDir: testAgentDir,
			send: (msg) => emitted.push(msg),
			store,
			driver,
		});

		await session.listModels();
		const modelsMsg = emitted.find((m): m is Extract<ServerMessage, { type: "models" }> => m.type === "models");
		expect(modelsMsg).toBeDefined();

		// 自定义模型必须在列表内
		const custom = modelsMsg!.models.find((m) => m.id === "my-proxy/claude-3-7-sonnet");
		expect(custom).toBeDefined();
		expect(custom?.provider).toBe("my-proxy");

		emitted.length = 0;
		// 切换到自定义代理模型
		await session.setModel("my-proxy/claude-3-7-sonnet");

		const snapshots = emitted.filter((m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot");
		expect(snapshots.length).toBeGreaterThan(0);
		const state: UiState = snapshots[snapshots.length - 1].state;

		// 验证解构正确性
		expect(state.model?.id).toBe("claude-3-7-sonnet");
		expect(state.model?.provider).toBe("my-proxy");
		expect(state.model?.name).toBe("Claude 3.7 (代理)");

		const currentModelId = `${state.model?.provider}/${state.model?.id}`;
		expect(currentModelId).toBe("my-proxy/claude-3-7-sonnet");

		session.dispose();
	});

	describe("Claude 引擎对话与流式渲染全链路测试", () => {
		it("完整测试对话提问、流式 Thinking 与正文增量、消息落盘与完成周期", async () => {
			const emitted: ServerMessage[] = [];
			// 创建可观测的测试驱动
			let capturedSink: any = null;
			let sentPromptText = "";
			const mockDriver = {
				id: "claude-code",
				name: "Claude Code",
				currentModel: "claude-3-7-sonnet-20250219",
				createSession: async () => "sess-1",
				resumeSession: async () => {},
				getActiveSessionId: () => "sess-1",
				sendPrompt: async (prompt: string, _attach: any, sink: any) => {
					sentPromptText = prompt;
					capturedSink = sink;
				},
				abort: async () => {},
				listModels: async () => [
					{ id: "claude-3-7-sonnet-20250219", name: "Claude 3.7 Sonnet" },
					{ id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet" },
				],
				setModel: async (_m: string) => {},
				setCwd: () => {},
				dispose: () => {},
			} as any;

			const session = new UniversalSession({
				clientId: "chat-test-client",
				cwd: process.cwd(),
				agentDir: testAgentDir,
				send: (msg) => emitted.push(msg),
				store,
				driver: mockDriver,
			});

			// 1. 用户发送提问
			await session.prompt("你好，请帮我分析一下代码");
			expect(sentPromptText).toBe("你好，请帮我分析一下代码");
			expect(session.isStreaming).toBe(true);

			// 验证用户消息已入库
			const promptSnapshots = emitted.filter(
				(m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot",
			);
			const firstState = promptSnapshots[promptSnapshots.length - 1].state;
			expect(firstState.messages.length).toBe(1);
			expect(firstState.messages[0].role).toBe("user");
			expect(firstState.messages[0].content).toEqual([{ type: "text", text: "你好，请帮我分析一下代码" }]);

			// 2. 模拟 Claude Code 返回 Thinking 思考过程
			capturedSink.onThinkingDelta("正在分析项目结构...");
			const delta1 = emitted.filter(
				(m): m is Extract<ServerMessage, { type: "message_delta" }> => m.type === "message_delta",
			);
			expect(delta1.length).toBeGreaterThan(0);
			expect((delta1[0].assistantMessageEvent as any)?.delta).toBe("正在分析项目结构...");

			// 3. 模拟返回正文增量
			capturedSink.onTextDelta("代码结构很清晰");
			const delta2 = emitted.filter(
				(m): m is Extract<ServerMessage, { type: "message_delta" }> => m.type === "message_delta",
			);
			expect(delta2.some((d) => (d.assistantMessageEvent as any)?.delta?.includes("代码结构很清晰"))).toBe(true);

			// 4. 模拟工具调用开始与结束
			capturedSink.onToolStart("call-1", "Read", { file_path: "package.json" });
			capturedSink.onToolEnd("call-1", { output: '{"name": "test"}' });

			// 5. 模拟本轮对话完成
			capturedSink.onTurnComplete({
				model: "claude-3-7-sonnet-20250219",
				usage: { inputTokens: 100, outputTokens: 50 },
			});
			expect(session.isStreaming).toBe(false);

			// 6. 验证最终落盘的 Assistant 消息包含思考块、正文块与工具调用
			session.flushSnapshot(true);
			const finalSnapshots = emitted.filter(
				(m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot",
			);
			const finalState = finalSnapshots[finalSnapshots.length - 1].state;
			expect(finalState.messages.length).toBe(3); // user, assistant, toolResult

			const assistantMsg = finalState.messages[1];
			expect(assistantMsg.role).toBe("assistant");
			expect(assistantMsg.content).toEqual([
				{ type: "thinking", thinking: "正在分析项目结构..." },
				{ type: "text", text: "代码结构很清晰" },
				{ type: "toolCall", id: "call-1", name: "Read", argumentsText: '{\n  "file_path": "package.json"\n}' },
			]);

			session.dispose();
		});

		it("多轮对话在切换模型后能保留历史并在新模型下继续", async () => {
			const emitted: ServerMessage[] = [];
			let currentModelInDriver = "claude-code/claude-3-7-sonnet-20250219";
			let lastTurnModel = "";
			const mockDriver = {
				id: "claude-code",
				name: "Claude Code",
				currentModel: currentModelInDriver,
				createSession: async () => "sess-2",
				resumeSession: async () => {},
				getActiveSessionId: () => "sess-2",
				sendPrompt: async (prompt: string, _attach: any, sink: any) => {
					sink.onTextDelta(`回答: ${prompt}`);
					lastTurnModel = currentModelInDriver;
					sink.onTurnComplete({ model: currentModelInDriver });
				},
				abort: async () => {},
				listModels: async () => [
					{ id: "claude-3-7-sonnet-20250219", name: "Claude 3.7 Sonnet" },
					{ id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet" },
				],
				setModel: async (_m: string) => {
					currentModelInDriver = _m;
				},
				setCwd: () => {},
				dispose: () => {},
			} as any;

			const session = new UniversalSession({
				clientId: "multi-turn-client",
				cwd: process.cwd(),
				agentDir: testAgentDir,
				send: (msg) => emitted.push(msg),
				store,
				driver: mockDriver,
			});

			// 第一轮：3.7 模型
			await session.prompt("第一轮问题");
			expect(lastTurnModel).toBe("claude-code/claude-3-7-sonnet-20250219");

			// 中途切换模型为 3.5
			await session.setModel("claude-code/claude-3-5-sonnet-20241022");

			// 第二轮：3.5 模型
			await session.prompt("第二轮问题");
			expect(lastTurnModel).toBe("claude-code/claude-3-5-sonnet-20241022");

			session.flushSnapshot(true);
			const snapshots = emitted.filter((m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot");
			const finalState = snapshots[snapshots.length - 1].state;

			// 验证拥有 4 条消息（2 问 2 答）
			expect(finalState.messages.length).toBe(4);
			expect(finalState.messages[0].content).toEqual([{ type: "text", text: "第一轮问题" }]);
			expect(finalState.messages[1].content).toEqual([{ type: "text", text: "回答: 第一轮问题" }]);
			expect(finalState.messages[2].content).toEqual([{ type: "text", text: "第二轮问题" }]);
			expect(finalState.messages[3].content).toEqual([{ type: "text", text: "回答: 第二轮问题" }]);

			session.dispose();
		});

		it("ClaudeCodeDriver 的 NDJSON 事件解析与异常诊断正确提取错误提示", () => {
			const driver = new ClaudeCodeDriver(process.cwd(), { agentDir: testAgentDir });
			const events: any[] = [];
			const sink = {
				onTextDelta: (t: string) => events.push({ type: "text", text: t }),
				onThinkingDelta: (t: string) => events.push({ type: "thinking", text: t }),
				onToolStart: (id: string, name: string, input: any) => events.push({ type: "toolStart", id, name, input }),
				onToolEnd: (id: string, res: any) => events.push({ type: "toolEnd", id, res }),
				onTurnComplete: (meta: any) => events.push({ type: "turnComplete", meta }),
				onError: (err: string) => events.push({ type: "error", err }),
			};

			const activeTools = new Map<string, string>();
			const handle = (driver as any).handleClaudeEvent.bind(driver);

			// 1. 测试 system 事件提取 session_id
			handle({ type: "system", session_id: "claude-uuid-123" }, sink, activeTools);
			expect(driver.getActiveSessionId()).toBe("claude-uuid-123");

			// 2. 测试 content_block_delta (text & thinking)
			handle({ type: "content_block_delta", delta: { type: "text_delta", text: "你好" } }, sink, activeTools);
			handle({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "思考中" } }, sink, activeTools);
			expect(events).toContainEqual({ type: "text", text: "你好" });
			expect(events).toContainEqual({ type: "thinking", text: "思考中" });

			// 3. 测试工具调用
			handle({ type: "tool_use", id: "t-1", name: "Bash", input: { command: "dir" } }, sink, activeTools);
			expect(events).toContainEqual({ type: "toolStart", id: "t-1", name: "Bash", input: { command: "dir" } });

			handle({ type: "tool_result", tool_use_id: "t-1", content: "file.txt", is_error: false }, sink, activeTools);
			expect(events).toContainEqual({ type: "toolEnd", id: "t-1", res: { output: "file.txt" } });

			// 4. 测试错误与完成
			handle(
				{
					type: "result",
					is_error: true,
					result: "Invalid API key · Fix external API key",
					usage: { input_tokens: 10, output_tokens: 5 },
				},
				sink,
				activeTools,
			);
			expect((driver as any).lastErrorHint).toBe("Invalid API key · Fix external API key");

			driver.dispose();
		});

		it("resolveClaudeExecutable 支持在常见安装路径与 PATH 中解析 claude 路径", () => {
			const res = resolveClaudeExecutable("claude");
			expect(typeof res).toBe("string");
			expect(res.length).toBeGreaterThan(0);

			// 绝对路径测试
			const dummyPath = process.cwd();
			expect(resolveClaudeExecutable(dummyPath)).toBe(dummyPath);
		});

		it("官方模型保证原生纯净环境变量，严禁注入 models.json 的代理与凭据", () => {
			// 在 models.json 与 auth.json 中配置第三方代理与密钥
			writeFileSync(
				join(testAgentDir, "models.json"),
				JSON.stringify({
					providers: {
						anthropic: {
							baseUrl: "https://tainted-proxy.example.com",
							apiKey: "sk-tainted-key",
						},
					},
				}),
				"utf8",
			);
			writeFileSync(
				join(testAgentDir, "auth.json"),
				JSON.stringify({
					anthropic: "sk-auth-tainted-key",
				}),
				"utf8",
			);

			const driver = new ClaudeCodeDriver(process.cwd(), { agentDir: testAgentDir });

			// 1. 针对官方模型（isOfficial = true），即便 models.json 存在 anthropic 配置，也绝不注入
			const officialEnv = driver.buildSpawnEnv(true, null);
			expect(officialEnv.ANTHROPIC_BASE_URL).toBeUndefined();
			expect(officialEnv.ANTHROPIC_API_KEY).toBeUndefined();
			expect(officialEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
			expect(officialEnv.NO_COLOR).toBe("1");

			// 2. 针对显式自定义代理模型（isOfficial = false, targetProvider = "anthropic"），正常注入
			const proxyEnv = driver.buildSpawnEnv(false, "anthropic");
			expect(proxyEnv.ANTHROPIC_BASE_URL).toBe("https://tainted-proxy.example.com");
			expect(proxyEnv.ANTHROPIC_API_KEY).toBe("sk-tainted-key");

			driver.dispose();
		});
	});
});
