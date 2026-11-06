import WebSocket from "ws";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const PORT = Number(process.argv[2] || 8972);
const base = mkdtempSync(join(tmpdir(), "pi-web-provkeys-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const NODE = realpathSync(process.execPath);
const authPath = join(agentDir, "auth.json");
writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "sk-legacy-a" } }, null, 2) + "\n");
const server = spawn(NODE, ["dist/server/index.js"], {
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "ignore", "ignore"],
	windowsHide: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
const check = (name, cond, extra = "") => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ FAIL ${name}${extra ? ` — ${extra}` : ""}`);
	}
};

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		ws.on("message", (d) => this.received.push(JSON.parse(d.toString())));
	}
	send(m) {
		this.ws.send(JSON.stringify(m));
	}
	async waitForNotice(substr, timeout = 25000) {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const m = this.received[i];
				if (m.type === "notice" && m.text?.includes(substr)) {
					this.received.splice(i, 1);
					return m;
				}
			}
			await sleep(50);
		}
		throw new Error(`timeout waiting for notice "${substr}"`);
	}
	lastProviderKeys() {
		let keys = null;
		for (const m of this.received) if (m.type === "provider_keys") keys = m.keys;
		return keys;
	}
	async waitProviderKeys(provider, n, timeout = 25000, ready = null) {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			const keys = this.lastProviderKeys();
			const list = keys && Array.isArray(keys[provider]) ? keys[provider] : null;
			if (list && list.length === n && (!ready || ready(list))) return list;
			await sleep(50);
		}
		throw new Error(`timeout waiting for provider_keys[${provider}] length ${n}`);
	}
}

async function connect() {
	for (let i = 0; i < 60; i++) {
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
			await new Promise((res, rej) => {
				ws.on("open", res);
				ws.on("error", rej);
			});
			return new Client(ws);
		} catch {
			await sleep(500);
		}
	}
	throw new Error("server not ready");
}

const readAuth = () => {
	try {
		return JSON.parse(readFileSync(authPath, "utf8"));
	} catch {
		return {};
	}
};
const keysPath = join(agentDir, "provider-keys.json");
const readKeys = () => {
	try {
		return JSON.parse(readFileSync(keysPath, "utf8"));
	} catch {
		return {};
	}
};

let clean = false;
function cleanup() {
	if (clean) return;
	clean = true;
	try {
		process.kill(server.pid, "SIGTERM");
	} catch {}
}
process.on("exit", cleanup);

try {
	await sleep(1000);
	const c = await connect();
	c.send({ type: "hello", clientId: "provider-keys-test" });
	await c.waitForNotice("", 1).catch(() => {});

	c.send({ type: "list_provider_keys" });
	let legacy = await c.waitProviderKeys("anthropic", 1);
	check(
		"legacy auth.json key seeded",
		legacy.length === 1 &&
			legacy[0].active === true &&
			legacy[0].name === "密钥 1" &&
			readKeys().anthropic?.keys?.[0]?.apiKey === "sk-legacy-a",
	);
	c.send({ type: "add_provider_key", provider: "anthropic", apiKey: "sk-new-b", name: "备用" });
	await c.waitForNotice("点击模型时可切换", 30000);
	legacy = await c.waitProviderKeys("anthropic", 2);
	check("adding a key keeps legacy active", legacy.find((k) => k.active)?.name === "密钥 1");
	check("no value/masked/id on the wire", !legacy.some((k) => ["id", "masked", "apiKey"].some((key) => key in k)));
	check("auth.json still legacy", readAuth().anthropic?.key === "sk-legacy-a");

	c.send({ type: "set_provider_api_key", provider: "deepseek", apiKey: "sk-A" });
	await c.waitForNotice("已保存", 30000);
	check("auth.json has deepseek", readAuth().deepseek?.key === "sk-A");
	check("provider-keys.json records deepseek", readKeys().deepseek?.keys?.length === 1);

	let ks = await c.waitProviderKeys("deepseek", 1);
	check(
		"provider_keys lists 1 active key (name only)",
		ks.length === 1 && ks[0].active === true && typeof ks[0].name === "string",
	);
	check("no value/masked/id on the wire", !ks.some((k) => ["id", "masked", "apiKey"].some((key) => key in k)));
	const keyAName = ks[0].name;

	c.send({ type: "add_provider_key", provider: "deepseek", apiKey: "sk-B", name: "备用" });
	await c.waitForNotice("点击模型时可切换", 30000);
	check("auth.json still sk-A", readAuth().deepseek?.key === "sk-A");

	ks = await c.waitProviderKeys("deepseek", 2);
	const keyBName = ks.find((k) => k.name === "备用")?.name;
	check("added key is inactive", ks.find((k) => k.name === keyBName)?.active === false);
	check("first key still active", ks.find((k) => k.name === keyAName)?.active === true);

	c.send({ type: "add_provider_key", provider: "deepseek", apiKey: "sk-B" });
	await c.waitForNotice("已存在该密钥", 30000);
	ks = await c.waitProviderKeys("deepseek", 2);
	check("duplicate add not duplicated", ks.length === 2);

	c.send({ type: "activate_provider_key", provider: "deepseek", keyName: keyBName });
	await c.waitForNotice("已切换", 30000);
	check("auth.json now sk-B", readAuth().deepseek?.key === "sk-B");
	ks = await c.waitProviderKeys("deepseek", 2, 25000, (list) => list.find((k) => k.name === keyBName)?.active === true);
	check("key B active now", ks.find((k) => k.name === keyBName)?.active === true);

	c.send({ type: "remove_provider_key", provider: "deepseek", keyName: keyBName });
	await c.waitForNotice("已切换", 30000);
	check("auth.json fell back to sk-A", readAuth().deepseek?.key === "sk-A");
	ks = await c.waitProviderKeys("deepseek", 1);
	check("only 1 key left", ks.length === 1 && ks[0].active === true);

	c.send({ type: "remove_provider_key", provider: "deepseek", keyName: keyAName });
	await c.waitForNotice("回到未配置状态", 30000);
	check("auth.json deepseek gone", !readAuth().deepseek);
	check("provider-keys.json deepseek gone", !readKeys().deepseek);

	console.log(`\n${passed} passed, ${failed} failed`);
} catch (err) {
	failed++;
	console.error("test crashed:", err);
} finally {
	cleanup();
	await sleep(500);
	process.exit(failed === 0 ? 0 : 1);
}
