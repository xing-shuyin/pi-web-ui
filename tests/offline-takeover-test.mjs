import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.argv[2] || 8969);
const MOCK_PORT = PORT + 1;
freePort(PORT);
freePort(MOCK_PORT);

const OFFLINE_TTL_MS = 4_000;
const MOCK_DELAY_MS = 4_000;

const base = mkdtempSync(join(tmpdir(), "pi-web-offline-takeover-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const MODEL_ID = "offline-mock";
const NL = String.fromCharCode(10) + String.fromCharCode(10);
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
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	res.write(": waiting" + NL);
	await sleep(MOCK_DELAY_MS);
	res.write("data: " + JSON.stringify(delta(payload.model, { content: "OFFLINE-TASK-RESULT" })) + NL);
	res.write("data: " + JSON.stringify(delta(payload.model, {}, "stop")) + NL);
	res.write("data: [DONE]" + NL);
	res.end();
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				name: "Mock",
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
				apiKey: "sk-mock",
				models: [{ id: MODEL_ID, name: "Mock", input: ["text"] }],
			},
		},
	}),
);

const repoRoot = realpathSync(new URL("../", import.meta.url));
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: repoRoot,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: workdir,
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_TOKEN: "",
		PI_WEB_PLUGIN_CATALOG_URL: "",
		PI_WEB_OFFLINE_ROWS_TTL_MS: String(OFFLINE_TTL_MS),
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
let serverOut = "";
server.stdout.on("data", (d) => (serverOut += String(d)));
server.stderr.on("data", (d) => (serverOut += String(d)));

const waitForPort = async (port, timeout = 20000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/health`);
			if (response.ok) return;
		} catch {}
		await sleep(100);
	}
	throw new Error(`server did not start on ${port}`);
};

class Client {
	constructor(ws, name) {
		this.ws = ws;
		this.name = name;
		this.received = [];
		this.state = null;
		this.messages = [];
		this.conversations = [];
		this.elsewhere = [];
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "snapshot") {
				this.state = message.state;
				this.messages = message.state.messages ?? [];
			} else if (
				message.type === "snapshot_delta" &&
				this.state &&
				this.state.rev === message.baseRev &&
				message.conversationId === this.state.conversationId
			) {
				this.state = { ...this.state, ...message.state };
				this.messages = [...this.messages, ...message.appended];
			} else if (message.type === "conversations") {
				this.conversations = message.conversations ?? [];
				this.elsewhere = message.elsewhere ?? [];
			}
		});
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	async waitForType(type, predicate = () => true, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const message = this.received[i];
				if (message.type !== type || !predicate(message)) continue;
				this.received.splice(i, 1);
				return message;
			}
			await sleep(50);
		}
		throw new Error(`[${this.name}] timeout waiting for ${type}`);
	}
	async waitForState(predicate, timeout = 20000, label = "") {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error(`[${this.name}] timeout waiting for state ${label}`);
	}
	async waitRow(predicate, timeout = 15000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			const hit = this.elsewhere.find(predicate);
			if (hit) return hit;
			await sleep(100);
		}
		return null;
	}
	async waitRowGone(predicate, timeout = 15000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (!this.elsewhere.some(predicate)) return true;
			await sleep(100);
		}
		return false;
	}
	notices() {
		return this.received.filter((m) => m.type === "notice");
	}
	texts() {
		return (this.messages ?? [])
			.flatMap((m) => m.content ?? [])
			.map((b) => b.text ?? "")
			.join("\n");
	}
}

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

let phone;
let phone2;
let pc;
try {
	await waitForPort(PORT);

	const openClient = async (clientId) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		await new Promise((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		const c = new Client(ws, clientId);
		c.send({ type: "hello", clientId, locale: "zh" });
		await c.waitForType("ready");
		c.send({ type: "get_state" });
		await c.waitForState((s) => Boolean(s.conversationId), 20000, "conversationId");
		c.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
		await c.waitForState((s) => s.model?.id === MODEL_ID, 20000, "model");
		return c;
	};

	const observer = await openClient("observer-page");
	check("观察者在线（阻断认领路径）", true);

	phone = await openClient("phone-page");
	phone.send({ type: "prompt", text: "手机端发起的任务" });
	await phone.waitForState((s) => s.isStreaming === true, 20000, "phone streaming");
	phone.ws.close();
	console.log("   手机页面已关闭（run 仍在服务端继续跑）");

	await sleep(1200);
	pc = await openClient("pc-page");
	const offlineRow = await pc.waitRow((w) => w.ownerOffline === true, 15000);
	check("PC 看到「另一处（离线）」行", !!offlineRow, `elsewhere=${JSON.stringify(pc.elsewhere)}`);
	check("离线行带过户定位（owner/convId）", Boolean(offlineRow?.owner && offlineRow?.convId));
	check("离线行不是只读（不是无头伪客户端）", offlineRow?.pseudo !== true);

	if (offlineRow) {
		pc.send({ type: "take_over_conversation", owner: offlineRow.owner, id: offlineRow.convId });
		let done = false;
		{
			const started = Date.now();
			while (Date.now() - started < 30000) {
				if (pc.texts().includes("OFFLINE-TASK-RESULT") && pc.texts().includes("手机端发起的任务")) {
					done = true;
					break;
				}
				await sleep(100);
			}
		}
		check("接管离线行后拿到完整转录（提问 + 回答）", done, `msgs=${pc.messages.length}`);
		check(
			"PC 收到过户成功通知",
			pc.notices().some((m) => (m.text ?? "").includes("过户到当前页面")),
			JSON.stringify(pc.notices().map((n) => n.text)),
		);
		check(
			"接管后该离线行消失（残骸不再持有）",
			await pc.waitRowGone((w) => w.owner === "phone-page", 15000),
			`elsewhere=${JSON.stringify(pc.elsewhere)}`,
		);
	}

	phone2 = await openClient("phone2-page");
	phone2.send({ type: "prompt", text: "手机端第二段任务" });
	await phone2.waitForState((s) => s.isStreaming === true, 20000, "phone2 streaming");
	phone2.ws.close();
	const idleRow = await pc.waitRow((w) => w.owner === "phone2-page" && w.isStreaming === false, 30000);
	check("run 跑完后离线行仍在下发（宽限期内可接管）", !!idleRow, `elsewhere=${JSON.stringify(pc.elsewhere)}`);
	check("空闲离线行同样带过户定位", Boolean(idleRow?.owner && idleRow?.convId));
	check(
		"宽限期到期后离线行自动消失（不再永久占位）",
		await pc.waitRowGone((w) => w.owner === "phone2-page", OFFLINE_TTL_MS + 12_000),
		`elsewhere=${JSON.stringify(pc.elsewhere)}`,
	);

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
} catch (err) {
	failures++;
	console.error("💥", err.message ?? err);
	console.error("--- server out ---\n" + serverOut.slice(-3000));
} finally {
	phone?.ws.close();
	phone2?.ws.close();
	pc?.ws.close();
	server.kill();
	mock.close();
	await sleep(500);
	await freePort(PORT);
	await freePort(MOCK_PORT);
}
process.exit(failures === 0 ? 0 : 1);
