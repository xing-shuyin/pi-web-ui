import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { ClientStateStore } from "../../server/client-state.js";
import { DshAgentService } from "../../server/dsh/dsh-agent-service.js";
import { UniversalSessionStore, UniversalSession, BaseAgentDriver } from "../../server/universal/index.js";
import type { AgentCapabilities, AgentEventSink, InternalMcpEndpoint } from "../../server/universal/driver-base.js";
import { internalMcpRegistry } from "../../server/universal/internal-mcp.js";
import { ClaudeCodeDriver } from "../../server/universal/drivers/claude-code.js";
import { CodexDriver } from "../../server/universal/drivers/codex.js";
import { DurableAgentDriver } from "../../server/durable/durable-driver.js";
import type { ServerMessage } from "../../server/protocol.js";
import { createCoreStateStore } from "../../server/core-state-adapter.js";

const openTurnSessionMock = vi.fn();
vi.mock("../../packages/keel/src/adapters/sdk/session-opener.js", () => ({
	openTurnSession: (...args: unknown[]) => openTurnSessionMock(...args),
}));

const { CoreEngine } = await import("../../packages/keel/src/app/core-engine.js");

function makePluginTool(name: string, calls: Array<{ args: Record<string, unknown> }>) {
	return {
		name,
		label: name,
		description: `Plugin tool ${name}`,
		parameters: { type: "object", properties: { msg: { type: "string" } } },
		execute: async (_id: string, args: Record<string, unknown>) => {
			calls.push({ args });
			return { content: [{ type: "text", text: `ok:${name}:${String(args.msg ?? "")}` }] };
		},
	};
}

class HttpMcpProbeDriver extends BaseAgentDriver {
	readonly id: string;
	readonly name: string;
	readonly capabilities: AgentCapabilities = {
		supportsTreeFork: false,
		supportsHistoryEdit: false,
		supportsToolPromptOverride: false,
		supportsModelSwitch: true,
		supportsThinkingLevels: false,
		mcpTransport: "http",
	};
	private endpoint: InternalMcpEndpoint | null = null;
	constructor(
		cwd: string,
		id: string,
		private readonly onPromptProbe: (endpoint: InternalMcpEndpoint | null) => Promise<void>,
	) {
		super(cwd);
		this.id = id;
		this.name = id;
	}
	async createSession(): Promise<string> {
		return `${this.id}-sess-1`;
	}
	async resumeSession(): Promise<void> {}
	override setInternalMcp(endpoint: InternalMcpEndpoint | null): void {
		this.endpoint = endpoint;
	}
	async sendPrompt(_prompt: string, _attachments: undefined, sink: AgentEventSink): Promise<void> {
		await this.onPromptProbe(this.endpoint);
		sink.onTextDelta("done");
		sink.onTurnComplete();
	}
	async abort(): Promise<void> {}
	dispose(): void {}
}

describe("多引擎设置工具可见性端到端测试 (pi / dsh / claude / codex / durable)", () => {
	let dir: string;
	let httpServer: Server | null = null;
	let mcpUrl = "";

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "keel-tools-e2e-"));
		const app = express();
		app.use(express.json());
		app.post("/__pi/internal-mcp", async (req, res) => {
			const auth = String(req.headers.authorization || "");
			const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
			const out = await internalMcpRegistry.handleJsonRpc(token, req.body);
			if (out.status !== 200) {
				res.status(out.status).end();
				return;
			}
			res.json(out.body);
		});
		await new Promise<void>((resolve) => {
			httpServer = app.listen(0, "127.0.0.1", () => {
				const addr = httpServer!.address();
				if (addr && typeof addr === "object") {
					mcpUrl = `http://127.0.0.1:${addr.port}/__pi/internal-mcp`;
				}
				resolve();
			});
		});
	});

	afterEach(async () => {
		if (httpServer) {
			await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
			httpServer = null;
		}
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		}
	});

	it("1. Pi 引擎：设置中开启/关闭插件工具与内置工具，已开会话实时生效", async () => {
		const stateFile = join(dir, "client-state.json");
		const statePort = createCoreStateStore(stateFile);
		statePort.saveSettings("c-pi", {
			disabledAgentTools: ["patch"],
			disabledPluginTools: ["demo_plugin_tool"],
		});

		const pluginCalls: Array<{ args: Record<string, unknown> }> = [];
		let activeSet = new Set<string>(["read", "write", "edit", "bash", "patch"]);
		const allTools = [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" }, { name: "patch" }];
		const fakeSession = {
			getAllTools: () => [
				...allTools,
				...(syncedTools.includes("demo_plugin_tool") ? [{ name: "demo_plugin_tool" }] : []),
			],
			getActiveToolNames: () => [...activeSet],
			setActiveToolsByName: (names: string[]) => {
				activeSet = new Set(names);
			},
			getToolDefinition: (name: string) => ({ description: name }),
			isStreaming: false,
			sessionFile: undefined,
			messages: [],
			model: { provider: "anthropic", id: "claude" },
			sendUserMessage: vi.fn(async () => {}),
			subscribe: () => () => {},
			dispose: () => {},
		};
		openTurnSessionMock.mockReset();
		openTurnSessionMock.mockImplementation(async (opts: { customTools?: unknown[] }) => {
			for (const t of opts.customTools ?? []) {
				const name = (t as { name?: string })?.name;
				if (name) activeSet.add(name);
			}
			return { session: fakeSession, sessionId: "s-pi-1", dispose: () => {} };
		});

		let syncedTools: string[] = [];
		const engine = new CoreEngine(dir, {
			version: "test",
			attach: true,
			agentDir: dir,
			stateStore: statePort,
			settingsFrame: () =>
				({
					push: () => {},
					set: async (patch: Record<string, unknown>) => {
						statePort.saveSettings("c-pi", patch as any);
					},
				}) as any,
			pluginToolSync: () => ({
				syncIntoSession: (_session: unknown, defs: readonly unknown[], prev: ReadonlySet<string>) => {
					const names = defs.map((d) => (d as { name: string }).name);
					for (const old of prev) activeSet.delete(old);
					syncedTools = names;
					for (const n of names) activeSet.add(n);
					return new Set(names);
				},
			}),
		} as any);
		engine.pluginToolsProvider = () => [makePluginTool("demo_plugin_tool", pluginCalls)];

		const sent: ServerMessage[] = [];
		const ds = await engine.attach("c-pi", (m) => sent.push(m));
		await ds.newChat();
		// 确保初始门控下 patch 与 demo_plugin_tool 都不可见
		expect(activeSet.has("patch")).toBe(false);
		expect(activeSet.has("demo_plugin_tool")).toBe(false);

		// 在设置中启用 patch 与 demo_plugin_tool
		await ds.setSettings({
			disabledAgentTools: [],
			disabledPluginTools: [],
		} as any);

		expect(syncedTools).toContain("demo_plugin_tool");
		expect(activeSet.has("patch")).toBe(true);
		expect(activeSet.has("demo_plugin_tool")).toBe(true);

		// 再次关闭
		await ds.setSettings({
			disabledAgentTools: ["patch"],
			disabledPluginTools: ["demo_plugin_tool"],
		} as any);
		expect(syncedTools).not.toContain("demo_plugin_tool");
		expect(activeSet.has("patch")).toBe(false);

		await engine.disposeAll();
	});

	it("2. DSH 引擎：按设置过滤并实时同步内置桥接工具与插件工具，pushSettings 回传真实状态", async () => {
		const stateStore = new ClientStateStore(join(dir, "client-state.json"));
		stateStore.saveSettings("c-dsh", {
			disabledAgentTools: ["patch"],
			disabledPluginTools: ["demo_plugin_tool"],
		});

		const pluginCalls: Array<{ args: Record<string, unknown> }> = [];
		const syncTools = vi.fn().mockResolvedValue({ registered: [], count: 0 });
		const toolsCallResult = vi.fn().mockResolvedValue({ ok: true });
		const fakeRuntime = {
			alive: true,
			cwd: dir,
			setWorkingDirectory: vi.fn(async (_sid: string, path: string) => path),
			syncTools,
			toolsCallResult,
			listTools: vi.fn(async () => ({ tools: [] })),
			listSkills: vi.fn(async () => ({ skills: [] })),
			setDisabledSkills: vi.fn(async () => ({ ok: true })),
			close: vi.fn(async () => {}),
			kill: vi.fn(async () => {}),
		};

		const service = new DshAgentService(dir, stateStore, dir, dir);
		service.pluginToolsProvider = () => [makePluginTool("demo_plugin_tool", pluginCalls)];
		const sent: ServerMessage[] = [];
		const cs = (await service.attach("c-dsh", (m) => sent.push(m))) as any;

		// pushSettings 应回传真实的 disabledAgentTools / disabledPluginTools
		cs.pushSettings();
		const settingsMsg = [...sent].reverse().find((m) => m.type === "settings_state") as any;
		expect(settingsMsg?.settings?.disabledAgentTools).toContain("patch");
		expect(settingsMsg?.settings?.disabledPluginTools).toContain("demo_plugin_tool");

		// 初始同步不应包含被禁用的 patch 和 demo_plugin_tool，但应包含启用的 browser_page / present_files / bg_task
		await cs.syncPluginTools(fakeRuntime);
		const firstSynced = (syncTools.mock.calls[0]?.[0] as Array<{ name: string }>).map((t) => t.name);
		expect(firstSynced).toContain("browser_page");
		expect(firstSynced).toContain("present_files");
		expect(firstSynced).toContain("bg_task");
		expect(firstSynced).not.toContain("patch");
		expect(firstSynced).not.toContain("demo_plugin_tool");

		// 被禁用的工具调用应被拒绝
		await cs.handleToolCallRequest(
			{ id: "c1", name: "demo_plugin_tool", args: { msg: "x" } },
			{ runtime: fakeRuntime },
		);
		expect(toolsCallResult).toHaveBeenCalledWith("c1", expect.stringContaining("demo_plugin_tool"), true);

		// 在设置中开启 patch 和 demo_plugin_tool，应自动重新同步并可执行
		syncTools.mockClear();
		toolsCallResult.mockClear();
		cs.runtime = fakeRuntime;
		await cs.setSettings({ disabledAgentTools: [], disabledPluginTools: [] });
		const secondSynced = (syncTools.mock.calls[0]?.[0] as Array<{ name: string }>).map((t) => t.name);
		expect(secondSynced).toContain("patch");
		expect(secondSynced).toContain("demo_plugin_tool");

		await cs.handleToolCallRequest(
			{ id: "c2", name: "demo_plugin_tool", args: { msg: "hi" } },
			{ runtime: fakeRuntime },
		);
		expect(toolsCallResult).toHaveBeenCalledWith("c2", "ok:demo_plugin_tool:hi", false);
		expect(pluginCalls).toHaveLength(1);

		await service.disposeAll();
	});

	it.each(["claude", "codex", "durable"] as const)(
		"3. %s 引擎：通过真实 HTTP internal-mcp 端点验证设置启用的工具对 AI 可见且可调用",
		async (engine) => {
			// 确认真实驱动类本身也声明了 mcpTransport === "http"
			const realCap =
				engine === "claude"
					? new ClaudeCodeDriver(dir).capabilities
					: engine === "codex"
						? new CodexDriver(dir).capabilities
						: new DurableAgentDriver(dir, { dataDir: dir }).capabilities;
			expect(realCap.mcpTransport).toBe("http");

			const stateStore = new ClientStateStore(join(dir, "client-state.json"));
			stateStore.saveSettings(`c-${engine}`, {
				disabledAgentTools: ["patch"],
				disabledPluginTools: ["demo_plugin_tool"],
			});

			const store = new UniversalSessionStore(dir, engine);
			const pluginCalls: Array<{ args: Record<string, unknown> }> = [];
			let listedTools: string[] = [];
			let callResultText = "";

			const probe = async (endpoint: InternalMcpEndpoint | null) => {
				expect(endpoint).not.toBeNull();
				const listRes = await fetch(endpoint!.url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${endpoint!.token}`,
					},
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
				});
				expect(listRes.status).toBe(200);
				const listJson = (await listRes.json()) as { result?: { tools?: Array<{ name: string }> } };
				listedTools = (listJson.result?.tools ?? []).map((t) => t.name);

				if (listedTools.includes("demo_plugin_tool")) {
					const callRes = await fetch(endpoint!.url, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${endpoint!.token}`,
						},
						body: JSON.stringify({
							jsonrpc: "2.0",
							id: 2,
							method: "tools/call",
							params: { name: "demo_plugin_tool", arguments: { msg: engine } },
						}),
					});
					const callJson = (await callRes.json()) as { result?: { content?: Array<{ text?: string }> } };
					callResultText = callJson.result?.content?.[0]?.text ?? "";
				}
			};

			const sent: ServerMessage[] = [];
			const session = new UniversalSession({
				clientId: `c-${engine}`,
				cwd: dir,
				dataDir: dir,
				agentDir: dir,
				send: (m) => sent.push(m),
				store,
				stateStore,
				driver: new HttpMcpProbeDriver(dir, engine, probe),
				driverFactory: (cwd) => new HttpMcpProbeDriver(cwd, engine, probe),
				engine,
				internalMcpUrl: () => mcpUrl,
				pluginToolsProvider: () => [makePluginTool("demo_plugin_tool", pluginCalls)],
			});

			await session.newChat();
			session.pushSettings();
			const initialSettings = [...sent].reverse().find((m) => m.type === "settings_state") as any;
			expect(initialSettings?.settings?.disabledPluginTools).toContain("demo_plugin_tool");

			// 第 1 轮：patch 与 demo_plugin_tool 被禁用，不应出现在 tools/list
			await session.prompt("round 1");
			expect(listedTools).toContain("browser_page");
			expect(listedTools).toContain("present_files");
			expect(listedTools).toContain("bg_task");
			expect(listedTools).not.toContain("patch");
			expect(listedTools).not.toContain("demo_plugin_tool");

			// 第 2 轮：在设置中启用 patch 与 demo_plugin_tool，tools/list 应可见且 tools/call 可执行
			await session.setSettings({ disabledAgentTools: [], disabledPluginTools: [] });
			await session.prompt("round 2");
			expect(listedTools).toContain("patch");
			expect(listedTools).toContain("demo_plugin_tool");
			expect(callResultText).toBe(`ok:demo_plugin_tool:${engine}`);
			expect(pluginCalls).toHaveLength(1);

			session.dispose();
		},
	);
});
