import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager, type PluginHost } from "../../server/plugins.js";

let dir: string;
let mgr: PluginManager;

function makePlugin(id: string, code: string, manifest?: Record<string, unknown>): void {
	const pdir = join(dir, "plugins", id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(
		join(pdir, "manifest.json"),
		JSON.stringify({
			name: id,
			permissions: ["tools"],
			...(manifest ?? {}),
		}),
	);
	writeFileSync(join(pdir, "index.mjs"), code);
}

async function activate(id: string): Promise<PluginHost> {
	(globalThis as unknown as { __compatHosts?: Record<string, PluginHost> }).__compatHosts ??= {};
	makePlugin(id, `export default { activate(h) { globalThis.__compatHosts["${id}"] = h; } };`);
	await mgr.ensureLoaded();
	const host = (globalThis as unknown as { __compatHosts: Record<string, PluginHost> }).__compatHosts[id];
	expect(host).toBeTruthy();
	return host;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-compat-test-"));
	mgr = new PluginManager(dir, dir);
});

afterEach(() => {
	mgr.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("PluginHost compatibility APIs (Issue #615)", () => {
	it("host.secrets.getAll() recovers all decrypted secrets as a dictionary", async () => {
		const h = await activate("test-secrets");
		expect(h.secrets.getAll()).toEqual({});

		h.secrets.set("TOKEN", "secret-token-123");
		h.secrets.set("API_KEY", "my-super-key");

		const all = h.secrets.getAll();
		expect(all).toEqual({
			TOKEN: "secret-token-123",
			API_KEY: "my-super-key",
		});

		h.secrets.delete("TOKEN");
		expect(h.secrets.getAll()).toEqual({
			API_KEY: "my-super-key",
		});
	});

	it("host.onClientMessage(handler) dispatches client message and replies to caller", async () => {
		const h = await activate("test-on-client-message");
		const sent: Array<{ clientId: string; payload: unknown }> = [];
		mgr.sendTo = (clientId: string, pluginId: string, payload: unknown) => {
			if (pluginId === "test-on-client-message") {
				sent.push({ clientId, payload });
			}
		};

		let receivedMsg: unknown;
		const off = h.onClientMessage?.(async (msg, reply) => {
			receivedMsg = msg;
			reply({ type: "test_ack", status: "ok" });
		});
		expect(off).toBeTypeOf("function");

		mgr.handleMessage("test-on-client-message", { type: "ping" }, "client-session-abc");

		await new Promise((r) => setTimeout(r, 10));

		expect(receivedMsg).toEqual({ type: "ping" });
		expect(sent).toHaveLength(1);
		expect(sent[0]).toEqual({
			clientId: "client-session-abc",
			payload: { type: "test_ack", status: "ok" },
		});

		off?.();
		mgr.handleMessage("test-on-client-message", { type: "ping2" }, "client-session-abc");
		await new Promise((r) => setTimeout(r, 10));
		expect(sent).toHaveLength(1);
	});

	it("host.registerTool(tool) adapts single-argument execute(args) into AgentTool", async () => {
		const h = await activate("test-register-tool");
		let executedArgs: Record<string, unknown> | undefined;

		const off = h.registerTool?.({
			name: "my_im_bot",
			description: "Send message via IM bot",
			parameters: {
				type: "object",
				properties: {
					action: { type: "string" },
					text: { type: "string" },
				},
			},
			async execute(args) {
				executedArgs = args;
				return JSON.stringify({ sent: true, text: args.text });
			},
		});

		expect(off).toBeTypeOf("function");

		const tools = mgr.getAgentTools();
		const tool = tools.find((t) => t.name === "my_im_bot");
		expect(tool).toBeDefined();
		expect(tool?.description).toBe("Send message via IM bot");

		const res = await tool!.execute("call_12345", { action: "send", text: "hello world" });
		expect(executedArgs).toEqual({ action: "send", text: "hello world" });
		expect(res).toBe(JSON.stringify({ sent: true, text: "hello world" }));

		off?.();
		const toolsAfter = mgr.getAgentTools();
		expect(toolsAfter.find((t) => t.name === "my_im_bot")).toBeUndefined();
	});
});
