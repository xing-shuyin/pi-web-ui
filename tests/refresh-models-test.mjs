import WebSocket from "ws";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

const PORT = Number(process.argv[2] || 8957);
const MOCK_PORT = PORT + 1;
const base = mkdtempSync(join(tmpdir(), "pi-web-refreshmodels-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

let bumped = false;
const authSeen = [];
const mock = createServer((req, res) => {
	if (req.url?.includes("/models")) {
		authSeen.push(req.headers.authorization ?? null);
		const data = [
			{
				id: "mock-a",
				context_window: 999999,
				display_name: "Fetched A",
				reasoning_levels: ["low", "high", "xhigh"],
			},
			{ id: "mock-b" },
			...(bumped ? [{ id: "mock-new", reasoning: true, supported_reasoning_levels: [{ effort: "max" }] }] : []),
		];
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ data }));
		return;
	}
	res.writeHead(404).end("{}");
});
mock.listen(MOCK_PORT, "127.0.0.1");

const NODE = realpathSync(process.execPath);
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
				if (pred && !pred(m)) continue;
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
	} catch {}
	mock.close();
}
process.on("exit", cleanup);

try {
	await sleep(1000);
	const c = await connect();
	c.send({ type: "hello", clientId: "refresh-models-test" });
	await c.waitFor("ready", 8000);

	c.send({
		type: "save_model_config",
		providerId: "my-provider",
		config: {
			providerId: "my-provider",
			api: "openai-completions",
			baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
			apiKey: "saved-secret-key",
			models: [
				{
					id: "mock-a",
					name: "Manual A",
					contextWindow: 123456,
					input: ["text"],
				},
			],
		},
	});
	await c.waitFor("models_config", 10000, (m) => m.providers.some((p) => p.providerId === "my-provider"));

	c.send({ type: "refresh_provider_models", providerId: "my-provider", reqId: 11 });
	const r1 = await c.waitFor("refresh_provider_result", 15000, (m) => m.reqId === 11);
	check("refresh ok, added=1, total=2", r1.ok && r1.added === 1 && r1.total === 2, JSON.stringify(r1));

	let mc = await c.waitFor(
		"models_config",
		10000,
		(m) =>
			m.providers.find((p) => p.providerId === "my-provider") !== undefined &&
			m.providers.find((p) => p.providerId === "my-provider").models.length === 2,
	);
	const rowA = mc.providers.find((p) => p.providerId === "my-provider").models.find((m) => m.id === "mock-a");
	check(
		"manual fields preserved (name/contextWindow/input NOT overridden)",
		rowA.name === "Manual A" && rowA.contextWindow === 123456 && canonish(rowA.input) === canonish(["text"]),
		JSON.stringify(rowA),
	);
	const expectedMapA = { minimal: null, low: "low", medium: null, high: "high", xhigh: "xhigh", max: null };
	check(
		"existing row gains derived thinkingLevelMap (xhigh/max open up)",
		canonish(rowA.thinkingLevelMap) === canonish(expectedMapA),
		JSON.stringify(rowA.thinkingLevelMap),
	);

	bumped = true;
	c.send({ type: "refresh_provider_models", providerId: "my-provider", reqId: 12 });
	const r2 = await c.waitFor("refresh_provider_result", 15000, (m) => m.reqId === 12);
	check("refresh #2 ok, added=1, total=3", r2.ok && r2.added === 1 && r2.total === 3, JSON.stringify(r2));

	mc = await c.waitFor("models_config", 10000, (m) => {
		const p = m.providers.find((x) => x.providerId === "my-provider");
		return p && p.models.length === 3;
	});
	const rowNew = mc.providers.find((p) => p.providerId === "my-provider").models.find((m) => m.id === "mock-new");
	check("new id appended with endpoint metadata (reasoning)", rowNew?.reasoning === true);
	check(
		"new id also gains derived thinkingLevelMap (max)",
		canonish(rowNew?.thinkingLevelMap) ===
			canonish({ minimal: null, low: null, medium: null, high: null, xhigh: null, max: "max" }),
		JSON.stringify(rowNew?.thinkingLevelMap),
	);

	check(
		"probe used saved apiKey (Bearer saved-secret-key)",
		authSeen.some((a) => a === "Bearer saved-secret-key"),
		JSON.stringify(authSeen),
	);

	c.send({ type: "refresh_provider_models", providerId: "nope", reqId: 13 });
	const r4 = await c.waitFor("refresh_provider_result", 10000, (m) => m.reqId === 13);
	check("unknown provider → ok:false with error", !r4.ok && !!r4.error);

	function canonish(v) {
		return JSON.stringify(sortKeysDeep(v));
	}
	console.log(`\n${passed} passed, ${failed} failed`);
} catch (err) {
	failed++;
	console.error("test crashed:", err);
} finally {
	await cleanup();
	await sleep(500);
	process.exit(failed === 0 ? 0 : 1);
}
