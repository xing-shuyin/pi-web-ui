import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCorePlugins } from "../../server/core-plugin-adapter.js";
import { handlePluginMessage, type PluginDispatchContext } from "../../server/dispatch-plugin-handlers.js";
import type { DispatchSession } from "../../server/engine-service.js";
import type { PluginInstaller } from "../../server/plugin-installer.js";
import type { PluginManager } from "../../server/plugins.js";
import type { ServerMessage } from "../../server/protocol.js";

type InventoryFrame = Extract<ServerMessage, { type: "extension_inventory_data" }>;

function workspace() {
	const root = mkdtempSync(join(tmpdir(), "pi-core-inventory-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	const dataDir = join(root, "data");
	for (const dir of [cwd, agentDir, dataDir]) mkdirSync(dir, { recursive: true });
	return { root, cwd, agentDir, dataDir };
}

function writeProjectMcp(cwd: string, servers: Record<string, unknown>): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: servers }), "utf8");
}

/** core 引擎的会话：只有基本能力，`listMcpServers` / `watchMcpInventory` 都不提供。 */
function coreSession(extra: Record<string, unknown> = {}): DispatchSession {
	return {
		getLang: () => "en",
		emitNotice: () => {},
		...extra,
	} as unknown as DispatchSession;
}

function makeCtx(
	sent: ServerMessage[],
	cs: DispatchSession,
	dirs: { cwd: string; dataDir: string },
	clientId: string,
): PluginDispatchContext {
	return {
		pluginMgr: { list: async () => [] } as unknown as PluginManager,
		pluginInstaller: {} as unknown as PluginInstaller,
		cs,
		clientId,
		send: (msg) => void sent.push(msg),
		dataDir: dirs.dataDir,
		cwd: dirs.cwd,
		clients: [],
		pendingPathRequests: new Map(),
		pendingPermissionRequests: new Map(),
		pendingDomConsents: new Map(),
		findDomConsentById: () => undefined,
		applyDomConsent: () => {},
		pushPluginGrants: () => {},
		pushPluginPermissions: () => {},
		reloadPluginsAndPush: async () => {},
		confirmPluginInstallHelper: async () => true,
	};
}

async function waitInventoryFrame(sent: ServerMessage[]): Promise<InventoryFrame> {
	for (let i = 0; i < 200; i++) {
		const found = sent.find((msg) => msg.type === "extension_inventory_data");
		if (found) return found as InventoryFrame;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("extension_inventory_data 没有发出");
}

const externalNames = (frame: InventoryFrame): string[] =>
	frame.entries.filter((entry) => entry.source === "external").map((entry) => entry.name);

describe("extension_inventory 的 MCP 段 · core 引擎", () => {
	const cleanup: (() => void)[] = [];
	afterEach(() => {
		for (const fn of cleanup.splice(0)) fn();
	});

	function makePort(dirs: { cwd: string; agentDir: string; dataDir: string }) {
		const port = createCorePlugins({
			agentDir: dirs.agentDir,
			dataDir: dirs.dataDir,
			version: "9.9.9",
			emit: () => {},
			isDisposed: () => false,
			getCwd: () => dirs.cwd,
			getLang: () => "en",
			reloadSession: async () => {},
			getDisabledPlugins: () => [],
			setDisabledPlugins: async () => {},
		});
		cleanup.push(() => port.dispose?.());
		return port;
	}

	it("会话不带 listMcpServers 时读宿主句柄：真 mcp.json 的条目进 external 段", async () => {
		const dirs = workspace();
		cleanup.push(() => rmSync(dirs.root, { recursive: true, force: true }));
		writeProjectMcp(dirs.cwd, { fs: { command: "npx", args: ["-y", "mcp-fs"] } });
		makePort(dirs);

		const sent: ServerMessage[] = [];
		handlePluginMessage({ type: "extension_inventory", reqId: 7 }, makeCtx(sent, coreSession(), dirs, "core-a"));
		const frame = await waitInventoryFrame(sent);

		expect(externalNames(frame)).toEqual(["mcp:project:fs"]);
		expect(frame.entries.find((entry) => entry.name === "mcp:project:fs")?.enabled).toBe(true);
	});

	it("会话自带 listMcpServers（老树）时用它，不去读宿主句柄", async () => {
		const dirs = workspace();
		cleanup.push(() => rmSync(dirs.root, { recursive: true, force: true }));
		writeProjectMcp(dirs.cwd, { handled: { command: "npx" } });
		makePort(dirs);

		const sent: ServerMessage[] = [];
		const cs = coreSession({
			listMcpServers: () => ({ servers: [{ name: "legacy", scope: "global", enabled: true }] }),
		});
		handlePluginMessage({ type: "extension_inventory", reqId: 8 }, makeCtx(sent, cs, dirs, "core-b"));
		const frame = await waitInventoryFrame(sent);

		expect(externalNames(frame)).toEqual(["mcp:global:legacy"]);
	});

	it("宿主没登记 MCP 来源（插件面未接）时 MCP 段为空，不抛", async () => {
		const dirs = workspace();
		cleanup.push(() => rmSync(dirs.root, { recursive: true, force: true }));
		const sent: ServerMessage[] = [];
		handlePluginMessage({ type: "extension_inventory", reqId: 9 }, makeCtx(sent, coreSession(), dirs, "core-c"));
		const frame = await waitInventoryFrame(sent);

		expect(externalNames(frame)).toEqual([]);
	});
});
