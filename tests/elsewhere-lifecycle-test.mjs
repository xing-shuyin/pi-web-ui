import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.argv[2] || 8981);
const MOCK_PORT = PORT + 1;
freePort(PORT);
freePort(MOCK_PORT);

const base = mkdtempSync(join(tmpdir(), "pi-web-elsewhere-lifecycle-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const MODEL_ID = "elsewhere-lifecycle-mock";
const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
};
const delta = (model, d, finish = null) => ({
	id: MODEL_ID,
	object: "chat.completion.chunk",
	created: Date.now(),
	model,
	choices: [{ index: 0, delta: d, finish_reason: finish }],
});
const mock = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${MOCK_PORT}`);
	if (url.pathname.endsWith("/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model", name: "Mock", input: ["text"] }] }),
		);
		return;
	}
	if (!url.pathname.endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	for await (const chunk of req) body += chunk;
	const payload = JSON.parse(body || "{}");
	sse(res, [delta(payload.model, { content: "ELSEWHERE-OK" }), delta(payload.model, {}, "stop")]);
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify(
		{
			providers: {
				mock: {
					name: "Mock",
					api: "openai-completions",
					baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
					apiKey: "sk-mock",
					models: [{ id: MODEL_ID, name: "Mock" }],
				},
			},
		},
		null,
		2,
	),
);

const server = spawn(process.execPath, [join(realpathSync("."), "dist", "server", "index.js")], {
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_HOST: "127.0.0.1",
		PI_WEB_CWD: workdir,
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_TOKEN: "",
		PI_WEB_PLUGIN_CATALOG_URL: "",
		PI_WEB_OFFLINE_ROWS_TTL_MS: "3000",
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});

let serverOut = "";
server.stdout.on("data", (d) => (serverOut += String(d)));
server.stderr.on("data", (d) => (serverOut += String(d)));

const cleanup = () => {
	try {
		clientB?.ws.close();
	} catch {}
	try {
		server.kill();
	} catch {}
	try {
		mock.close();
	} catch {}
};

class Client {
	constructor(ws, name) {
		this.ws = ws;
		this.name = name;
		this.received = [];
		this.state = null;
		this.conversations = [];
		this.elsewhere = [];
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "snapshot") this.state = message.state;
			else if (message.type === "conversations") {
				this.conversations = message.conversations ?? [];
				this.elsewhere = message.elsewhere ?? [];
			}
		});
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	async waitForType(type, predicate = () => true, timeout = 30000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const m = this.received[i];
				if (m.type !== type || !predicate(m)) continue;
				this.received.splice(i, 1);
				return m;
			}
			await sleep(50);
		}
		throw new Error(`[${this.name}] timeout waiting for ${type}`);
	}
	async waitForState(predicate, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error(`[${this.name}] timeout waiting for state`);
	}
}

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

const waitElsewhere = async (c, pred, what, timeout = 15000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const row = c.elsewhere.find(pred);
		if (row) return row;
		await sleep(100);
	}
	throw new Error(`[${c.name}] timeout waiting for elsewhere row: ${what}`);
};
const waitElsewhereGone = async (c, pred, what, timeout = 15000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		if (!c.elsewhere.some(pred)) return true;
		await sleep(100);
	}
	return false;
};

let clientA;
let clientB;
try {
	for (let i = 0; i < 160; i++) {
		try {
			const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
			if (r.ok) break;
		} catch {}
		await sleep(250);
		if (i === 159) throw new Error("server did not come up");
	}

	const openClient = async (clientId, withModel = true) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		await new Promise((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		const c = new Client(ws, clientId);
		c.send({ type: "hello", clientId, locale: "zh" });
		await c.waitForType("ready");
		c.send({ type: "get_state" });
		await c.waitForState((s) => Boolean(s), 20000);
		if (withModel) {
			c.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
			await c.waitForState((s) => s.model?.id === MODEL_ID);
		}
		return c;
	};

	clientB = await openClient("observer-b");

	const deadId = "probe-dead-1790000000000";
	clientA = await openClient(deadId);
	clientA.send({ type: "prompt", text: "残骸测试：只回复 OK" });
	await clientA.waitForState((s) => s.isStreaming === true, 20000).catch(() => {});
	const liveRow = await waitElsewhere(clientB, (w) => w.owner === deadId, "A live row");
	check("A 在线时 B 能看到其 elsewhere 行（正向对照）", !!liveRow, `owner=${liveRow.owner}`);
	check("普通客户端 elsewhere 条目 pseudo 为 false/undefined（#426）", !liveRow.pseudo);
	await clientA.waitForState((s) => s.isStreaming === false, 30000).catch(() => {});

	clientA.ws.close();
	const offlineRow = await waitElsewhere(
		clientB,
		(w) => w.owner === deadId && w.ownerOffline === true,
		"A offline row",
	);
	check(
		"A 断连后其行仍在且标 ownerOffline（宽限期内可过户）",
		offlineRow?.ownerOffline === true,
		`elsewhere=${JSON.stringify(clientB.elsewhere)}`,
	);
	const gone = await waitElsewhereGone(clientB, (w) => w.owner === deadId, "A row gone", 20000);
	check(
		"宽限期到期后其行自动消失（#291「残骸不永久占位」仍成立）",
		gone,
		`elsewhere=${JSON.stringify(clientB.elsewhere.map((w) => w.owner))}`,
	);

	const taskId = "task-lifecycle-291";
	clientB.send({
		type: "schedule_save",
		task: {
			id: taskId,
			name: "生命周期测试",
			kind: "cron",
			spec: "0 0 1 1 *",
			prompt: "hi",
			cwd: workdir,
			enabled: false,
			catchUp: "skip",
		},
	});
	await clientB.waitForType("scheduler_tasks", (m) => (m.tasks ?? []).some((t) => t.id === taskId), 15000);

	clientB.send({ type: "schedule_run", id: taskId });
	const schedRow = await waitElsewhere(clientB, (w) => w.owner === `scheduler:${taskId}`, "scheduler row", 30000);
	check("定时任务伪客户端出现在 elsewhere（正向对照）", !!schedRow, `owner=${schedRow.owner}`);
	check("定时任务伪客户端 elsewhere 条目标记为 pseudo（#426）", schedRow.pseudo === true);

	clientB.send({ type: "take_over_conversation", owner: schedRow.owner, id: schedRow.convId });
	const rejectNotice = await clientB.waitForType(
		"notice",
		(m) => m.text?.includes("定时任务会话不支持过户") || m.text?.includes("定时任务/插件会话不支持过户"),
		10000,
	);
	check("请求过户伪客户端时被拒并给出后台任务引导（#426）", rejectNotice.text.includes("后台任务面板"));

	clientB.send({ type: "schedule_delete", id: taskId });
	const schedGone = await waitElsewhereGone(
		clientB,
		(w) => w.owner === `scheduler:${taskId}`,
		"scheduler row gone",
		20000,
	);
	check(
		"删除定时任务后伪客户端从 elsewhere 消失（#291 修复点）",
		schedGone,
		`elsewhere=${JSON.stringify(clientB.elsewhere.map((w) => w.owner))}`,
	);
} catch (err) {
	console.error(`\nFAIL: ${err.message}`);
	console.error("--- server output ---\n" + serverOut.slice(-4000));
	cleanup();
	process.exit(1);
}

cleanup();
if (failures > 0) {
	console.error("--- server output ---\n" + serverOut.slice(-3000));
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nPASS: elsewhere 生命周期（#291）");
process.exit(0);
