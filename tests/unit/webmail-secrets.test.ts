import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const PLUGIN = pathToFileURL(join(process.cwd(), "plugins/webmail/index.mjs")).href;

process.env.npm_config_offline = "true";
process.env.npm_config_registry = "http://127.0.0.1:9/";
process.env.npm_config_audit = "false";
process.env.npm_config_fund = "false";

interface PublicSection {
	user: string;
	hasPass: boolean;
}
interface PublicState {
	configured: boolean;
	config: { imap: PublicSection; smtp: PublicSection };
}
interface PluginMessage {
	kind?: string;
	state?: PublicState;
}
interface StoredConfig {
	imap?: { pass?: string };
	smtp?: { pass?: string };
}
interface ViewMessage {
	action: string;
	config?: unknown;
}
type PluginModule = { default: { activate: (host: unknown) => () => void } };

interface Harness {
	send: (msg: ViewMessage) => void;
	state: () => PublicState | null;
	configFile: () => StoredConfig | null;
	stop: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function activate(dir: string, secrets: Map<string, string>, failSecretWrites = false): Promise<Harness> {
	const mod = (await import(PLUGIN)) as PluginModule;
	const sent: PluginMessage[] = [];
	let handler: ((msg: ViewMessage, from?: string) => void) | null = null;
	const host = {
		dir,
		log: () => {},
		notify: () => {},
		broadcast: (p: PluginMessage) => sent.push(p),
		sendTo: (_clientId: string, p: PluginMessage) => sent.push(p),
		onMessage: (h: (msg: ViewMessage, from?: string) => void) => {
			handler = h;
			return () => {};
		},
		onToolEvent: () => () => {},
		onAttach: () => () => {},
		onCwdChange: () => () => {},
		registerAgentTool: () => () => {},
		registerBackgroundTask: () => ({ unregister() {} }),
		storage: { get: () => undefined, set() {}, delete() {}, all: () => ({}) },
		secrets: {
			set: (n: string, v: string) => {
				if (failSecretWrites) return;
				secrets.set(n, String(v));
			},
			get: (n: string) => secrets.get(n),
			has: (n: string) => secrets.has(n),
			delete: (n: string) => secrets.delete(n),
			list: () => [...secrets.keys()],
		},
	};
	const dispose = mod.default.activate(host);
	await sleep(120);
	return {
		send: (msg) => handler?.(msg, "c1"),
		state: () => {
			for (let i = sent.length - 1; i >= 0; i--) {
				const m = sent[i];
				if (m?.kind === "state" && m.state) return m.state;
			}
			return null;
		},
		configFile: () => {
			const f = join(dir, "config.json");
			return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as StoredConfig) : null;
		},
		stop: () => dispose(),
	};
}

function fullConfig(pass?: string): unknown {
	const imap = { host: "imap.example.com", port: 993, tls: true, user: "u@example.com", ...(pass ? { pass } : {}) };
	const smtp = {
		host: "smtp.example.com",
		port: 465,
		tls: true,
		user: "u@example.com",
		from: "u@example.com",
		...(pass ? { pass } : {}),
	};
	return { imap, smtp, pollSec: 60, notifyEnabled: true, aiEnabled: false };
}

const dirs: string[] = [];
function tempDir(): string {
	const d = mkdtempSync(join(tmpdir(), "webmail-test-"));
	dirs.push(d);
	return d;
}

afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("webmail 密码持久化", () => {
	it("机密可用：密码入机密、config.json 不落明文、重启后仍在", async () => {
		const dir = tempDir();
		const secrets = new Map<string, string>();
		let h = await activate(dir, secrets);
		h.send({ action: "save_config", config: fullConfig("SECRET123") });
		await sleep(200);
		h.send({ action: "get_state" });
		await sleep(50);

		expect(h.state()?.config?.imap?.hasPass).toBe(true);
		expect(h.configFile()?.imap?.pass).toBe("");
		expect(secrets.get("imap_pass")).toBe("SECRET123");
		h.stop();

		h = await activate(dir, secrets);
		h.send({ action: "get_state" });
		await sleep(50);
		expect(h.state()?.config?.imap?.hasPass).toBe(true);
		h.stop();
	});

	it("机密写入失败：回退明文落盘，密码不丢（修复前会丢）", async () => {
		const dir = tempDir();
		const secrets = new Map<string, string>();
		let h = await activate(dir, secrets, true);
		h.send({ action: "save_config", config: fullConfig("SECRET123") });
		await sleep(200);
		h.send({ action: "get_state" });
		await sleep(50);

		expect(h.state()?.config?.imap?.hasPass).toBe(true);
		expect(h.configFile()?.imap?.pass).toBe("SECRET123");
		expect(h.configFile()?.smtp?.pass).toBe("SECRET123");
		h.stop();

		h = await activate(dir, secrets, true);
		h.send({ action: "get_state" });
		await sleep(50);
		expect(h.state()?.config?.imap?.hasPass).toBe(true);
		h.stop();
	});

	it("二次保存留空 = 沿用已存密码", async () => {
		const dir = tempDir();
		const secrets = new Map<string, string>();
		const h = await activate(dir, secrets);
		h.send({ action: "save_config", config: fullConfig("SECRET123") });
		await sleep(200);
		h.send({ action: "save_config", config: fullConfig() });
		await sleep(200);
		h.send({ action: "get_state" });
		await sleep(50);

		expect(h.state()?.config?.imap?.hasPass).toBe(true);
		expect(secrets.get("imap_pass")).toBe("SECRET123");
		h.stop();
	});
});
