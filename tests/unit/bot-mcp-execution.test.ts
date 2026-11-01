import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpBridge, getMcpToolServer } from "../../server/mcp-bridge.js";
import { registerBotExecution } from "../../server/device-center/bot-execution.js";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";

const fixture = fileURLToPath(new URL("../fixtures/mcp-echo-server.mjs", import.meta.url));

describe("Bot MCP execution", () => {
	it("starts only selected servers, filters schemas and rejects stale tool execution", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bot-mcp-"));
		const bridge = new McpBridge(dataDir, undefined, {
			allowedServers: ["allowed"],
			specOverride: [
				{ name: "allowed", spec: { command: process.execPath, args: [fixture] } },
				{ name: "denied", spec: { command: process.execPath, args: [fixture] } },
			],
		});
		const binding = registerBotExecution({
			id: "bot",
			name: "bot",
			description: "",
			systemPrompt: "",
			cwd: resolve("."),
			tools: ["echo", "read"],
			skills: [],
			mcpServers: ["allowed"],
			enabled: true,
			revision: 1,
		});
		const client = fakeClientSession() as any;
		Object.assign(client, {
			botExecution: binding.capability,
			botMcpBridge: bridge,
			cwd: resolve("."),
			settingsSvc: { current: {} },
		});
		try {
			await bridge.load();
			expect(bridge.getServerStatus("allowed").status).toBe("running");
			expect(bridge.getServerStatus("denied").status).toBe("stopped");
			expect(getMcpToolServer(bridge.getTools()[0])).toBe("allowed");
			expect(getMcpToolServer({ label: "allowed · echo" })).toBeUndefined();
			const defs = client.enabledPluginToolDefs("standard", resolve("."));
			expect(defs.map((tool: any) => tool.name)).toEqual(["echo"]);
			expect(await defs[0].execute("call", { text: "hello" })).toMatchObject({ content: expect.any(Array) });
			expect(client.botToolAllowed("add")).toBe(false);
			await bridge.reload();
			await expect(defs[0].execute("call", { text: "stale" })).rejects.toThrow("authorization expired");
			const refreshed = client.enabledPluginToolDefs("standard", resolve("."));
			binding.capability.revoke();
			await expect(refreshed[0].execute("call", { text: "denied" })).rejects.toThrow();
		} finally {
			binding.release();
			bridge.dispose();
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("empty server allowlist starts nothing on load and reload", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bot-mcp-empty-"));
		const bridge = new McpBridge(dataDir, undefined, {
			allowedServers: [],
			specOverride: [{ name: "blocked", spec: { command: process.execPath, args: [fixture] } }],
		});
		try {
			await bridge.load();
			expect(await bridge.reload()).toMatchObject({ started: 0, servers: 0, tools: 0 });
			expect(bridge.getTools()).toEqual([]);
		} finally {
			bridge.dispose();
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
