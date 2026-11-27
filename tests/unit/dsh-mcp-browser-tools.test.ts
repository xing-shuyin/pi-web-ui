import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientStateStore } from "../../server/client-state.js";
import { DshAgentService, DshClientSession } from "../../server/dsh/dsh-agent-service.js";
import type { ServerMessage } from "../../server/protocol.js";

describe("DSH MCP & browser tool injection", () => {
	let dir: string;
	let dataDir: string;
	let agentDir: string;
	let stateStore: ClientStateStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "dsh-mcp-browser-"));
		dataDir = join(dir, "data");
		agentDir = join(dir, "agent");
		mkdirSync(dataDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		stateStore = new ClientStateStore(join(dataDir, "client-state.json"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("syncPluginTools 注入 browser_* 与 MCP 工具，并在 ensureConversationWorkspace 中等待 mcpProjects.prepare 完成", async () => {
		let prepared = false;
		const release = vi.fn();
		const prepare = vi.fn(async () => {
			await Promise.resolve();
			prepared = true;
		});
		const retain = vi.fn(() => release);
		const syncTools = vi.fn().mockResolvedValue({ registered: [], count: 0 });
		const toolsCallResult = vi.fn().mockResolvedValue(undefined);

		const service = new DshAgentService(dir, stateStore, dataDir, agentDir, undefined, () => ({
			retain,
			prepare,
		}));
		service.pluginToolsProvider = () =>
			prepared
				? [
						{
							name: "mcp__demo__ping",
							description: "Ping MCP",
							parameters: { type: "object", properties: { msg: { type: "string" } } },
							execute: async (_id: string, params: Record<string, unknown>) => ({
								content: [{ type: "text", text: `pong:${String(params.msg ?? "")}` }],
							}),
						},
					]
				: [];

		const sent: ServerMessage[] = [];
		const cs = await service.attach("c1", (m) => sent.push(m));
		const fakeRuntime = {
			alive: true,
			cwd: dir,
			start: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
			setWorkingDirectory: vi.fn().mockResolvedValue(dir),
			syncTools,
			toolsCallResult,
		};
		(cs as unknown as { runtime: unknown }).runtime = fakeRuntime;
		const activeConv = (cs as unknown as { conv: unknown }).conv;
		await (
			cs as unknown as {
				ensureConversationWorkspace(conv: unknown, entry: { runtime: unknown }): Promise<void>;
			}
		).ensureConversationWorkspace(activeConv, { runtime: fakeRuntime });

		expect(retain).toHaveBeenCalledWith(dir);
		expect(prepare).toHaveBeenCalledWith(dir);
		expect(syncTools).toHaveBeenCalledTimes(1);
		const syncedNames = (syncTools.mock.calls[0]?.[0] as { name: string }[]).map((t) => t.name);
		expect(syncedNames).toContain("browser_page");
		expect(syncedNames).toContain("browser_script");
		expect(syncedNames).toContain("browser_design");
		expect(syncedNames).toContain("mcp__demo__ping");

		// browser_page 调用经 page_request / resolvePageCall 往返
		const callPromise = (
			cs as unknown as {
				handleToolCallRequest(params: { id: string; name: string; args?: Record<string, unknown> }): Promise<void>;
			}
		).handleToolCallRequest({ id: "call-1", name: "browser_page", args: { op: "pages" } });
		const pageReq = sent.find((m) => m.type === "page_request") as
			{ type: "page_request"; id: string; op: string } | undefined;
		expect(pageReq?.op).toBe("pages");
		cs.resolvePageCall(pageReq!.id, true, { pages: [] });
		await callPromise;
		expect(toolsCallResult).toHaveBeenCalledWith("call-1", expect.stringContaining("pages"), false);

		// MCP 工具调用路由到 pluginToolsProvider
		await (
			cs as unknown as {
				handleToolCallRequest(params: { id: string; name: string; args?: Record<string, unknown> }): Promise<void>;
			}
		).handleToolCallRequest({ id: "call-2", name: "mcp__demo__ping", args: { msg: "hi" } });
		expect(toolsCallResult).toHaveBeenCalledWith("call-2", "pong:hi", false);

		// refreshMcpProject 触发重新同步
		syncTools.mockClear();
		service.refreshMcpProject(dir);
		await new Promise((r) => setTimeout(r, 10));
		expect(syncTools).toHaveBeenCalledTimes(1);

		// 关闭 internalMcpEnabled 后清空注入工具，重新开启后恢复
		syncTools.mockClear();
		await cs.setSettings({ internalMcpEnabled: false });
		expect(syncTools).toHaveBeenCalledWith([]);
		syncTools.mockClear();
		await cs.setSettings({ internalMcpEnabled: true });
		expect((syncTools.mock.calls[0]?.[0] as { name: string }[]).map((t) => t.name)).toContain("mcp__demo__ping");

		await service.disposeAll();
		expect(release).toHaveBeenCalledTimes(1);
	});
});
