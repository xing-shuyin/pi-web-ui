import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	UniversalSessionStore,
	UniversalSession,
	MockAgentDriver,
	InternalMcpRegistry,
	internalMcpRegistry,
	unwrapInternalMcpToolName,
	isInternalMcpToolEligible,
	type InternalMcpEndpoint,
} from "../../server/universal/index.js";
import { ClientStateStore } from "../../server/client-state.js";
import { withInternalMcpServer, INTERNAL_MCP_SERVER_NAME } from "../../server/universal/engine-mcp.js";
import type { ServerMessage, UiState } from "../../server/protocol.js";
import { foldSnapshotFrames } from "../helpers/snapshot-frames.js";

function lastSnapshotState(outbox: ServerMessage[]): UiState {
	const folded = foldSnapshotFrames(outbox);
	if (!folded) throw new Error("No snapshot emitted in outbox");
	return folded;
}

function lastConversationTitle(outbox: ServerMessage[], convId: string): string | undefined {
	for (let i = outbox.length - 1; i >= 0; i--) {
		const m = outbox[i];
		if (m.type === "conversations") {
			return m.conversations.find((c) => c.id === convId)?.title;
		}
	}
	return undefined;
}

describe("通用底座 Marker 注入与内置 MCP Bridge", () => {
	let tempDir: string;
	let store: UniversalSessionStore;
	let outbox: ServerMessage[];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-universal-markers-mcp-"));
		store = new UniversalSessionStore(tempDir);
		outbox = [];
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
			} catch {}
		}
	});

	it("1. Marker 引导注入、执行并从展示消息中剥离", async () => {
		let receivedAppendix = "";
		class MarkerMockDriver extends MockAgentDriver {
			override setSystemPromptAppendix(appendix: string): void {
				receivedAppendix = appendix;
			}
			override async sendPrompt(
				_prompt: string,
				_attachments: undefined,
				sink: Parameters<MockAgentDriver["sendPrompt"]>[2],
			): Promise<void> {
				sink.onTextDelta("你好世界 [[conv:rename:新标题]] [[notify:info:完成]]");
				sink.onTurnComplete();
			}
		}

		const driver = new MarkerMockDriver(tempDir);
		const session = new UniversalSession({
			clientId: "marker-test",
			cwd: tempDir,
			dataDir: tempDir,
			agentDir: tempDir,
			send: (msg) => outbox.push(msg),
			store,
			driver,
			driverFactory: () => new MarkerMockDriver(tempDir),
			lang: "zh",
		});

		await session.newChat();
		await session.setSettings({ disabledMarkers: [] });
		await session.prompt("测试 marker");
		await new Promise((r) => setTimeout(r, 10));

		expect(receivedAppendix).toContain("Inline Markers");
		const snap = lastSnapshotState(outbox);
		const assistantMsg = snap.messages.find((m) => m.role === "assistant");
		const textBlock = assistantMsg?.content.find((b) => b.type === "text") as
			{ type: "text"; text: string } | undefined;
		expect(textBlock?.text).toBe("你好世界");
		expect(lastConversationTitle(outbox, snap.sessionId ?? "")).toBe("新标题");

		// 关闭所有 marker 后，引导应为空
		await session.setSettings({ disabledMarkers: ["conv", "notify", "action", "suggest"] });
		await session.prompt("再次测试");
		expect(receivedAppendix).toBe("");

		session.dispose();
	});

	it("2. 流式分片跨 [[...]] 边界时也能正确剥离", async () => {
		class SplitMarkerDriver extends MockAgentDriver {
			override async sendPrompt(
				_prompt: string,
				_attachments: undefined,
				sink: Parameters<MockAgentDriver["sendPrompt"]>[2],
			): Promise<void> {
				sink.onTextDelta("正文开始 [[conv:ren");
				sink.onTextDelta("ame:分片标题]] 结束");
				sink.onTurnComplete();
			}
		}

		const driver = new SplitMarkerDriver(tempDir);
		const session = new UniversalSession({
			clientId: "split-marker-test",
			cwd: tempDir,
			dataDir: tempDir,
			agentDir: tempDir,
			send: (msg) => outbox.push(msg),
			store,
			driver,
			driverFactory: () => new SplitMarkerDriver(tempDir),
			lang: "zh",
		});

		await session.newChat();
		await session.setSettings({ disabledMarkers: [] });
		await session.prompt("测试分片");
		await new Promise((r) => setTimeout(r, 10));

		const snap = lastSnapshotState(outbox);
		const assistantMsg = snap.messages.find((m) => m.role === "assistant");
		const textBlock = assistantMsg?.content.find((b) => b.type === "text") as
			{ type: "text"; text: string } | undefined;
		expect(textBlock?.text).toBe("正文开始  结束");
		expect(lastConversationTitle(outbox, snap.sessionId ?? "")).toBe("分片标题");

		session.dispose();
	});

	it("3. 外部引擎 mcp__pi_host__ 工具名应还原为原生工具名", async () => {
		class McpToolDriver extends MockAgentDriver {
			override async sendPrompt(
				_prompt: string,
				_attachments: undefined,
				sink: Parameters<MockAgentDriver["sendPrompt"]>[2],
			): Promise<void> {
				sink.onToolStart("call_1", `mcp__${INTERNAL_MCP_SERVER_NAME}__browser_page`, { url: "https://example.com" });
				sink.onToolEnd("call_1", { output: "ok" });
				sink.onTurnComplete();
			}
		}

		const driver = new McpToolDriver(tempDir);
		const session = new UniversalSession({
			clientId: "unwrap-test",
			cwd: tempDir,
			dataDir: tempDir,
			agentDir: tempDir,
			send: (msg) => outbox.push(msg),
			store,
			driver,
			driverFactory: () => new McpToolDriver(tempDir),
			lang: "zh",
		});

		await session.newChat();
		await session.prompt("打开网页");

		const snap = lastSnapshotState(outbox);
		const assistantMsg = snap.messages.find((m) => m.role === "assistant");
		const toolCall = assistantMsg?.content.find((b) => b.type === "toolCall") as
			{ type: "toolCall"; name: string } | undefined;
		expect(toolCall?.name).toBe("browser_page");
		expect(unwrapInternalMcpToolName("mcp__pi_host__terminal")).toBe("terminal");
		expect(unwrapInternalMcpToolName("mcp__other__tool")).toBe("mcp__other__tool");

		session.dispose();
	});

	it("4. InternalMcpRegistry JSON-RPC 鉴权、tools/list 与 tools/call", async () => {
		const registry = new InternalMcpRegistry();
		const token = registry.register({
			clientId: "c1",
			conversationId: "conv-1",
			cwd: tempDir,
			listTools: () => [
				{
					name: "echo_host",
					description: "Echo from host",
					inputSchema: { type: "object", properties: { msg: { type: "string" } } },
					execute: async (args) => ({ output: `host:${String(args.msg ?? "")}` }),
				},
			],
		});

		const unauth = await registry.handleJsonRpc("bad-token", { jsonrpc: "2.0", id: 1, method: "tools/list" });
		expect(unauth.status).toBe(401);

		const init = await registry.handleJsonRpc(token, { jsonrpc: "2.0", id: 1, method: "initialize" });
		expect(init.status).toBe(200);
		expect((init.body?.result as { serverInfo?: { name?: string } })?.serverInfo?.name).toBe(INTERNAL_MCP_SERVER_NAME);

		const list = await registry.handleJsonRpc(token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
		expect((list.body?.result as { tools?: Array<{ name: string }> })?.tools?.map((t) => t.name)).toEqual([
			"echo_host",
		]);

		const call = await registry.handleJsonRpc(token, {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "echo_host", arguments: { msg: "hi" } },
		});
		expect((call.body?.result as { content?: Array<{ text: string }> })?.content?.[0]?.text).toBe("host:hi");

		registry.unregister(token);
		const afterRevoke = await registry.handleJsonRpc(token, { jsonrpc: "2.0", id: 4, method: "ping" });
		expect(afterRevoke.status).toBe(401);
	});

	it("5. withInternalMcpServer 应合并宿主 HTTP MCP 配置", () => {
		const merged = withInternalMcpServer(
			{ user_mcp: { command: "npx", args: ["-y", "foo"] } },
			{ url: "http://127.0.0.1:8080/__pi/internal-mcp", token: "secret-tok" },
		);
		expect(Object.keys(merged)).toEqual(["user_mcp", INTERNAL_MCP_SERVER_NAME]);
		expect(merged[INTERNAL_MCP_SERVER_NAME]).toEqual({
			type: "http",
			url: "http://127.0.0.1:8080/__pi/internal-mcp",
			headers: { Authorization: "Bearer secret-tok" },
		});
	});

	it("6. UniversalSession 应向支持 HTTP MCP 的驱动注入宿主工具并按 disabledAgentTools 过滤", async () => {
		let capturedEndpoint: InternalMcpEndpoint | null = null;
		let listedToolNames: string[] = [];
		let blockedCallStatus = 0;
		let blockedCallErrorCode: number | undefined;

		class HttpMcpMockDriver extends MockAgentDriver {
			override readonly capabilities = {
				...super.capabilities,
				mcpTransport: "http" as const,
			};
			override setInternalMcp(endpoint: InternalMcpEndpoint | null): void {
				capturedEndpoint = endpoint;
			}
			override async sendPrompt(
				_prompt: string,
				_attachments: undefined,
				sink: Parameters<MockAgentDriver["sendPrompt"]>[2],
			): Promise<void> {
				if (capturedEndpoint) {
					const listRes = await internalMcpRegistry.handleJsonRpc(capturedEndpoint.token, {
						jsonrpc: "2.0",
						id: 1,
						method: "tools/list",
					});
					listedToolNames = ((listRes.body?.result as { tools?: Array<{ name: string }> })?.tools ?? []).map(
						(t) => t.name,
					);
					const blockedRes = await internalMcpRegistry.handleJsonRpc(capturedEndpoint.token, {
						jsonrpc: "2.0",
						id: 2,
						method: "tools/call",
						params: { name: "lsp", arguments: {} },
					});
					blockedCallStatus = blockedRes.status;
					blockedCallErrorCode = blockedRes.body?.error?.code;
				}
				sink.onTextDelta("done");
				sink.onTurnComplete();
			}
		}

		const stateStore = new ClientStateStore(join(tempDir, "client-state.json"));
		const driver = new HttpMcpMockDriver(tempDir);
		const session = new UniversalSession({
			clientId: "mcp-tools-test",
			cwd: tempDir,
			dataDir: tempDir,
			agentDir: tempDir,
			send: (msg) => outbox.push(msg),
			store,
			stateStore,
			driver,
			driverFactory: () => new HttpMcpMockDriver(tempDir),
			internalMcpUrl: () => "http://127.0.0.1:19999/__pi/internal-mcp",
			pluginToolsProvider: () => [
				{
					name: "custom_plugin_tool",
					label: "Custom Plugin Tool",
					description: "Dynamic plugin tool",
					parameters: { type: "object", properties: {} },
					execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
				},
				{
					// 已有独立 engine-mcp 通道的 mcp__* 以及显式排除名单中的工具不应重复注入
					name: "mcp__ext__foo",
					description: "external mcp",
					parameters: { type: "object", properties: {} },
					execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
				},
				{
					name: "bash",
					description: "native bash",
					parameters: { type: "object", properties: {} },
					execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
				},
			],
			lang: "zh",
		});

		await session.newChat();
		await session.setSettings({ disabledAgentTools: ["lsp"] });
		await session.prompt("检查宿主工具");

		expect(listedToolNames).toContain("terminal");
		expect(listedToolNames).toContain("browser_page");
		expect(listedToolNames).toContain("browser_script");
		expect(listedToolNames).toContain("browser_design");
		expect(listedToolNames).toContain("present_files");
		expect(listedToolNames).toContain("patch");
		expect(listedToolNames).toContain("agent_bot");
		expect(listedToolNames).toContain("custom_plugin_tool");
		expect(listedToolNames).not.toContain("lsp");
		expect(listedToolNames).not.toContain("mcp__ext__foo");
		expect(listedToolNames).not.toContain("bash");
		expect(isInternalMcpToolEligible("read")).toBe(false);
		expect(isInternalMcpToolEligible("compact_context")).toBe(false);
		expect(isInternalMcpToolEligible("future_custom_tool")).toBe(true);
		expect(blockedCallStatus).toBe(200);
		expect(blockedCallErrorCode).toBe(-32602);
		// 回合结束后 token 应被吊销且 driver.setInternalMcp(null) 已清理
		expect(capturedEndpoint).toBeNull();

		// 关闭 internalMcpEnabled 后，不再注入内部 MCP
		listedToolNames = [];
		await session.setSettings({ internalMcpEnabled: false });
		await session.prompt("关闭后再次测试");
		expect(listedToolNames).toEqual([]);
		expect(capturedEndpoint).toBeNull();

		session.dispose();
	});
});
