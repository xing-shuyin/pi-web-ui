import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const PORT = Number(process.argv[2] || 8996);
const MOCK_PORT = PORT + 1;
freePort(PORT);
freePort(MOCK_PORT);
const base = mkdtempSync(join(tmpdir(), "pi-web-takeover-rollback-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const MODEL_ID = "rollback-mock";

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
	const delta = (d, finish = null) =>
		`data: ${JSON.stringify({
			id: "rollback-mock",
			object: "chat.completion.chunk",
			created: Date.now(),
			model: payload.model,
			choices: [{ index: 0, delta: d, finish_reason: finish }],
		})}\n\n`;
	res.write(delta({ content: "start" }));
	for (let i = 0; i < 200; i++) {
		await sleep(150);
		if (res.writableEnded) return;
		res.write(delta({ content: ` chunk${i}` }));
	}
	res.write(delta({}, "stop"));
	res.write("data: [DONE]\n\n");
	res.end();
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "mock-key",
				models: [{ id: MODEL_ID, name: "Mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 }],
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
		PI_WEB_TOOL_LAZY_LOADING: "0",
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_TOKEN: "",
		PI_WEB_TEST_TAKEOVER_FAIL_INSERT: "1",
	},
	stdio: "ignore",
	windowsHide: true,
});

const waitForPort = async (port, timeout = 30000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
		} catch {}
		await sleep(100);
	}
	throw new Error(`server did not start on ${port}`);
};

class Client {
	constructor(ws, name) {
		this.ws = ws;
		this.name = name;
		this.clientId = name;
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
				this.state.conversationId === message.conversationId
			) {
				this.state = { ...this.state, ...message.state };
				this.messages = [...this.messages, ...message.appended];
			} else if (message.type === "conversations") {
				this.conversations = message.conversations;
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
	async waitFor(predicate, what, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (predicate(this)) return true;
			await sleep(100);
		}
		throw new Error(`[${this.name}] timeout waiting for ${what}`);
	}
	text() {
		const settled = (this.messages ?? [])
			.filter((m) => m.role === "assistant")
			.flatMap((m) => m.content ?? [])
			.map((b) => b.text ?? "")
			.join("\n");
		const streaming = (this.state?.streamingMessage?.content ?? []).map((b) => b.text ?? "").join("");
		return settled + streaming;
	}
}

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

let clientA;
let clientB;
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
		await c.waitFor((x) => Boolean(x.state?.conversationId), "initial snapshot");
		c.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
		await c.waitFor((x) => x.state?.model?.id === MODEL_ID, "model switched");
		return c;
	};

	clientA = await openClient("rollback-A");
	clientA.send({ type: "prompt", text: "慢慢写" });
	await clientA.waitFor((c) => c.state?.isStreaming === true, "A streaming");
	const convA = clientA.state.conversationId;
	await clientA.waitFor((c) => c.text().includes("start"), "A first chunk");

	clientB = await openClient("rollback-B");
	await clientB.waitFor((c) => c.elsewhere.some((w) => w.isStreaming && w.owner && w.convId), "B elsewhere row");
	const row = clientB.elsewhere.find((w) => w.isStreaming && w.owner && w.convId);
	check("B 看到 A 正在跑的对话（另一处行）", row?.owner === clientA.clientId, `owner=${row?.owner}`);

	clientB.send({ type: "take_over_conversation", owner: row.owner, id: row.convId });
	const noticeB = await clientB.waitForType("notice", (m) => /过户失败|Takeover failed/.test(m.text ?? ""), 20000);
	check(
		"B 收到诚实的失败回执（不是静默失败）",
		/退回原页面|back on the source page/.test(noticeB.text ?? ""),
		noticeB.text,
	);

	await clientA.waitFor((c) => c.conversations.some((x) => x.id === convA), "A running row back");
	check(
		"A 的运行列表里那条对话回来了",
		clientA.conversations.some((x) => x.id === convA),
	);
	check(
		"A 的当前对话仍是它（active 修回）",
		clientA.state?.conversationId === convA,
		`now=${clientA.state?.conversationId}`,
	);

	check("B 没有把这条对话留在自己手里", !clientB.conversations.some((x) => x.title === "慢慢写"));
	await clientB.waitFor((c) => c.elsewhere.some((w) => w.convId), "elsewhere row again");
	check(
		"B 又能看到它作为「另一处」行（对话可达，没变成幽灵）",
		clientB.elsewhere.some((w) => w.isStreaming),
		JSON.stringify(clientB.elsewhere.map((w) => ({ id: w.convId, owner: w.owner }))),
	);

	const before = clientA.text();
	await clientA.waitFor((c) => c.text().length > before.length, "A keeps streaming");
	check("过户夭折没有打断正在跑的 run（A 仍在收流）", clientA.text().length > before.length);
	check("服务还活着（失败被就地兜住，没有把 handler 打崩）", (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok);

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
} catch (err) {
	failures++;
	console.error("💥", err.message ?? err);
} finally {
	clientA?.ws.close();
	clientB?.ws.close();
	server.kill();
	mock.close();
	await sleep(500);
	await freePort(PORT);
	await freePort(MOCK_PORT);
	process.exit(failures === 0 ? 0 : 1);
}
