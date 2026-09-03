// clone_provider — built-in → custom provider draft test (zero token).
//
// The model-config modal offers "复制为自定义": the server copies a BUILT-IN
// provider's baseUrl + current model catalog into an editable UiProviderConfig
// draft (clone_provider_result) so the user can paste a SECOND API key without
// overwriting the built-in one. Nothing is persisted until save_model_config.
// This test verifies:
//   1. happy path: deepseek → deepseek-2 draft with api/baseUrl/models, NO apiKey
//   2. nothing saved server-side (list_models_config unchanged after clone)
//   3. saving the draft occupies the id; the next clone suggests deepseek-3
//   4. providers without baseUrl (opencode-go) now succeed with templated draft (models + default baseUrl)
//   5. unknown provider ids refuse with an error
//   6. reqId is echoed back
//
// Usage: npm run build && node tests/clone-provider-test.mjs [port]
import WebSocket from "ws";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

const PORT = Number(process.argv[2] || 8965);
const base = mkdtempSync(join(tmpdir(), "pi-web-cloneprov-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

// Minimal agent config so the server starts cleanly.
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "main-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:9",
				apiKey: "main-key",
				models: [{ id: "mock-a" }],
			},
		},
	}),
);

const NODE = realpathSync(process.execPath);
const server = spawn(NODE, ["dist/server/index.js"], {
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
server.stderr.on("data", (d) => process.stdout.write(`[srv-err] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
/** JSON comparison that ignores object key order. */
const sortKeysDeep = (o) => {
	if (Array.isArray(o)) return o.map(sortKeysDeep);
	if (o && typeof o === "object")
		return Object.fromEntries(
			Object.keys(o)
				.sort()
				.map((k) => [k, sortKeysDeep(o[k])]),
		);
	return o;
};
const canon = (o) => JSON.stringify(sortKeysDeep(o));
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
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
	async waitFor(type, timeout = 15000, pred) {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const m = this.received[i];
				if (m.type !== type) continue;
				if (pred && !pred(m)) continue; // keep unmatched (may be wanted by another waiter)
				this.received.splice(i, 1);
				return m;
			}
			await sleep(50);
		}
		throw new Error(`timeout waiting for ${type}`);
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

let clean = false;
async function cleanup() {
	if (clean) return;
	clean = true;
	try {
		process.kill(server.pid, "SIGTERM");
	} catch {
		/* gone */
	}
}
process.on("exit", () => void cleanup());
process.on("SIGINT", async () => {
	await cleanup();
	process.exit(1);
});

try {
	await sleep(1000);
	const c = await connect();
	c.send({ type: "hello", clientId: "clone-provider-test" });
	await c.waitFor("ready", 8000);
	console.log("  · ready");

	// Sanity: deepseek is listed as a built-in provider.
	c.send({ type: "list_providers" });
	const ps = await c.waitFor("providers_status");
	check(
		"deepseek is a known built-in provider",
		ps.providers.some((p) => p.id === "deepseek"),
	);

	// 1) happy path: clone deepseek
	c.send({ type: "clone_provider", provider: "deepseek", reqId: 11 });
	const r1 = await c.waitFor("clone_provider_result", 10000, (m) => m.reqId === 11);
	check("reqId echoed + ok", r1.reqId === 11 && r1.ok === true);
	check(
		"suggested id deepseek-2, api + baseUrl copied",
		r1.config?.providerId === "deepseek-2" &&
			r1.config.api === "openai-completions" &&
			r1.config.baseUrl === "https://api.deepseek.com",
	);
	check(
		"model catalog carried over with metadata",
		Array.isArray(r1.config.models) &&
			r1.config.models.length >= 1 &&
			r1.config.models.every((m) => typeof m.id === "string" && m.id),
	);
	check(
		"no credentials in the draft (apiKey/authHeader absent)",
		!("apiKey" in r1.config) && !("authHeader" in r1.config),
	);

	// 2) clone must not persist anything — custom list unchanged (only `main`).
	c.send({ type: "list_models_config" });
	const mc1 = await c.waitFor("models_config");
	check(
		"nothing saved server-side by clone alone",
		mc1.providers.length === 1 && mc1.providers[0].providerId === "main",
	);

	// 3) save the draft under deepseek-2, then clone again → deepseek-3.
	c.send({
		type: "save_model_config",
		providerId: "deepseek-2",
		config: {
			providerId: "deepseek-2",
			name: "DeepSeek 第二把钥匙",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			apiKey: "second-key",
			models: r1.config.models,
		},
	});
	await c.waitFor("models_config", 10000, (m) => m.providers.some((p) => p.providerId === "deepseek-2"));
	c.send({ type: "clone_provider", provider: "deepseek", reqId: 12 });
	const r2 = await c.waitFor("clone_provider_result", 10000, (m) => m.reqId === 12);
	check("id collision avoided: next suggestion is deepseek-3", r2.ok && r2.config?.providerId === "deepseek-3");

	// 4) provider without baseUrl now succeeds with templated draft (auto-filled models, no manual needed).
	//    单供应商全量模型（按占比最高 api），包含 muse-spark 等跨 api 模型
	c.send({ type: "clone_provider", provider: "opencode-go", reqId: 13 });
	const r3 = await c.waitFor("clone_provider_result", 10000, (m) => m.reqId === 13);
	check(
		"no-baseUrl provider → templated draft with models",
		r3.ok &&
			r3.config?.providerId === "opencode-go-2" &&
			Array.isArray(r3.config.models) &&
			r3.config.models.length >= 1 &&
			!("apiKey" in r3.config),
	);
	check(
		"opencode-go draft has templated baseUrl",
		r3.ok && typeof r3.config.baseUrl === "string" && r3.config.baseUrl.length > 0,
	);
	// 4b) opencode 含 muse-spark，验证全量模型包含 muse-spark（单供应商全量）
	c.send({ type: "clone_provider", provider: "opencode", reqId: 15 });
	const r5 = await c.waitFor("clone_provider_result", 10000, (m) => m.reqId === 15);
	check(
		"opencode includes muse-spark with full list",
		r5.ok && Array.isArray(r5.config.models) && r5.config.models.some((m) => m.id === "muse-spark-1.2"),
	);

	// 5) unknown provider refuses.
	c.send({ type: "clone_provider", provider: "no-such-provider", reqId: 14 });
	const r4 = await c.waitFor("clone_provider_result", 10000, (m) => m.reqId === 14);
	check("unknown provider → error", !r4.ok && (r4.error ?? "").includes("不存在"));

	console.log(`\n${passed} checks passed`);
} catch (err) {
	if (typeof c !== "undefined") {
		console.log("[debug] received so far:", c.received.map((m) => m.type).join(","));
	}
	throw err;
} finally {
	await cleanup();
}
