import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	deriveMcpServerName,
	checkMcpServer,
	installMcpServer,
	listAllMcpServers,
	deleteMcpServer,
} from "../../server/mcp-manager.js";
import { makeMcpManageTool } from "../../server/mcp-agent-tool.js";
import { PluginManager, type PluginHost } from "../../server/plugins.js";
import type { McpBridge } from "../../server/mcp-bridge.js";

describe("deriveMcpServerName", () => {
	it("从 npm 包名、URL 或命令推导合法名称", () => {
		expect(deriveMcpServerName("@modelcontextprotocol/server-filesystem")).toBe("filesystem");
		expect(deriveMcpServerName("@modelcontextprotocol/server-memory@latest")).toBe("memory");
		expect(deriveMcpServerName("@playwright/mcp@0.0.20")).toBe("playwright");
		expect(deriveMcpServerName("mcp-server-sqlite")).toBe("sqlite");
		expect(deriveMcpServerName("https://mcp.example.com/sse")).toBe("mcp-example-com");
	});
});

describe("checkMcpServer & installMcpServer", () => {
	let dir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mcp-manage-test-"));
		agentDir = join(dir, "agent");
		cwd = join(dir, "workspace");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("未安装时 checkMcpServer 返回 installed=false，安装后可按名称或包名命中", async () => {
		const initial = checkMcpServer({ agentDir, cwd, dataDir: dir, query: "filesystem" });
		expect(initial.installed).toBe(false);
		expect(initial.server).toBeNull();

		let reloadCount = 0;
		const fakeBridge = {
			reload: async () => {
				reloadCount++;
				return { kept: 0, started: 1, stopped: 0, failed: 0, servers: 1, tools: 2 };
			},
			getServerStatus: (name: string) =>
				name === "filesystem"
					? {
							status: "running" as const,
							tools: [
								{ name: "read_file", description: "Read file" },
								{ name: "list_dir", description: "List dir" },
							],
						}
					: { status: "stopped" as const, tools: [] },
		} as unknown as McpBridge;

		const installed = await installMcpServer({
			agentDir,
			cwd,
			dataDir: dir,
			bridge: fakeBridge,
			spec: {
				package: "@modelcontextprotocol/server-filesystem",
				args: ["/workspace"],
				scope: "project",
			},
		});

		expect(installed.ok).toBe(true);
		expect(installed.name).toBe("filesystem");
		expect(installed.scope).toBe("project");
		expect(installed.status).toBe("running");
		expect(installed.tools).toHaveLength(2);
		expect(reloadCount).toBe(1);

		const byShort = checkMcpServer({ agentDir, cwd, dataDir: dir, bridge: fakeBridge, query: "filesystem" });
		expect(byShort.installed).toBe(true);
		expect(byShort.running).toBe(true);
		expect(byShort.server?.command).toBe("npx");
		expect(byShort.server?.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]);

		const byPkg = checkMcpServer({
			agentDir,
			cwd,
			dataDir: dir,
			bridge: fakeBridge,
			query: "@modelcontextprotocol/server-filesystem",
		});
		expect(byPkg.installed).toBe(true);
		expect(byPkg.server?.name).toBe("filesystem");
	});
});

describe("makeMcpManageTool (AI 工具)", () => {
	let dir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mcp-tool-test-"));
		agentDir = join(dir, "agent");
		cwd = join(dir, "workspace");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("支持 check → install → list → remove 全链路", async () => {
		const tool = makeMcpManageTool(
			{
				listServers: () => listAllMcpServers({ agentDir, cwd, dataDir: dir }),
				checkServer: (query) => checkMcpServer({ agentDir, cwd, dataDir: dir, query }),
				installServer: (spec) => installMcpServer({ agentDir, cwd, dataDir: dir, spec }),
				removeServer: async (name, scope = "project") => deleteMcpServer({ agentDir, cwd, dataDir: dir, name, scope }),
				reloadServers: async () => listAllMcpServers({ agentDir, cwd, dataDir: dir }),
			},
			() => "zh",
		);

		const c1 = (await tool.execute("1", { action: "check", query: "memory" }, undefined, undefined, {} as any)) as {
			details: { installed: boolean };
		};
		expect(c1.details.installed).toBe(false);

		const ins = (await tool.execute(
			"2",
			{ action: "install", package: "@modelcontextprotocol/server-memory" },
			undefined,
			undefined,
			{} as any,
		)) as { details: { ok: boolean; name: string } };
		expect(ins.details.ok).toBe(true);
		expect(ins.details.name).toBe("memory");

		const c2 = (await tool.execute("3", { action: "check", query: "memory" }, undefined, undefined, {} as any)) as {
			details: { installed: boolean; name: string };
		};
		expect(c2.details.installed).toBe(true);
		expect(c2.details.name).toBe("memory");

		const rem = (await tool.execute("4", { action: "remove", name: "memory" }, undefined, undefined, {} as any)) as {
			details: { ok: boolean };
		};
		expect(rem.details.ok).toBe(true);
	});
});

describe("PluginHost host.mcp", () => {
	let dir: string;
	let mgr: PluginManager;

	function makePlugin(id: string, manifest: Record<string, unknown>): void {
		const pdir = join(dir, "plugins", id);
		mkdirSync(pdir, { recursive: true });
		writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id, ...manifest }));
		writeFileSync(
			join(pdir, "index.mjs"),
			`export default { activate(h) { (globalThis.__mcpHosts ??= {})["${id}"] = h; } };`,
		);
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "plugin-mcp-host-test-"));
		(globalThis as unknown as { __mcpHosts: Record<string, PluginHost> }).__mcpHosts = {};
		mgr = new PluginManager(dir, dir);
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		mgr.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	it("只读 check/list 免权限；install 需 tools 权限；promptInstall 可投递安装指令", async () => {
		makePlugin("readonly-p", { permissions: ["ui"] });
		makePlugin("tools-p", { permissions: ["tools", "chat"] });
		await mgr.ensureLoaded();

		const hosts = (globalThis as unknown as { __mcpHosts: Record<string, PluginHost> }).__mcpHosts;
		const roHost = hosts["readonly-p"];
		const toolsHost = hosts["tools-p"];

		expect(await roHost.mcp.list()).toEqual([]);
		expect((await roHost.mcp.check("memory")).installed).toBe(false);
		const denied = await roHost.mcp.install({ package: "@modelcontextprotocol/server-memory" });
		expect(denied.ok).toBe(false);
		expect(denied.error).toContain("tools");

		const okRes = await toolsHost.mcp.install({ package: "@modelcontextprotocol/server-memory" });
		expect(okRes.ok).toBe(true);
		expect(okRes.name).toBe("memory");

		const checked = await roHost.mcp.check("@modelcontextprotocol/server-memory");
		expect(checked.installed).toBe(true);
		expect(checked.server?.name).toBe("memory");

		const sentPrompts: Array<{ cid: string; text: string }> = [];
		mgr.conversationProvider = () => ({
			clientId: "c1",
			conversationId: "conv-123",
			isSubagent: false,
			title: "test",
			isStreaming: false,
			messages: [],
			at: Date.now(),
			streamingMessage: null,
			stats: { totalMessages: 0, tokens: { input: 0, output: 0, total: 0 }, cost: 0 },
		});
		mgr.conversationWriter = async (cid, text) => {
			sentPrompts.push({ cid, text });
			return { ok: true };
		};

		const promptRes = await toolsHost.mcp.promptInstall("@modelcontextprotocol/server-filesystem");
		expect(promptRes.ok).toBe(true);
		expect(promptRes.conversationId).toBe("conv-123");
		expect(sentPrompts).toHaveLength(1);
		expect(sentPrompts[0]?.text).toContain("mcp_manage");
		expect(sentPrompts[0]?.text).toContain("@modelcontextprotocol/server-filesystem");
	});
});

describe("installMcpServer 重名保护（0.104 审计）", () => {
	it("同名 install 默认拒绝；overwrite=true 才覆盖", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-manage-overwrite-"));
		const agentDir = join(dir, "agent");
		const cwd = join(dir, "workspace");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const base = {
			agentDir,
			cwd,
			dataDir: dir,
			spec: {
				name: "github",
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-github"],
				scope: "project" as const,
			},
		};
		const first = await installMcpServer(base);
		expect(first.ok).toBe(true);

		const clash = await installMcpServer({
			...base,
			spec: { ...base.spec, args: ["-y", "@evil/replacement"] },
		});
		expect(clash.ok).toBe(false);
		expect(clash.error).toContain("overwrite=true");

		const overwrite = await installMcpServer({
			...base,
			spec: { ...base.spec, overwrite: true, args: ["-y", "@evil/replacement"] },
		});
		expect(overwrite.ok).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});
});
