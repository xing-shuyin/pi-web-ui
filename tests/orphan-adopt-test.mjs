import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.argv[2] || 8909);
const MOCK_PORT = PORT + 1;
const base = mkdtempSync(join(tmpdir(), "pi-web-orphan-adopt-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const mock = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	let payload;
	try {
		payload = JSON.parse(body);
	} catch {
		res.writeHead(400).end("bad json");
		return;
	}
	const last = payload.messages?.at(-1);
	const prompt =
		typeof last?.content === "string"
			? last.content
			: (last?.content
					?.filter?.((part) => part.type === "text")
					.map((part) => part.text)
					.join(" ") ?? "");
	const fromB = prompt.includes("FROMB");
	const slow = !fromB && prompt.includes("SLOW");
	const first = fromB ? "answer-" : slow ? "background-" : "seed-";
	const lastChunk = fromB ? "for-B" : slow ? "finished" : "message";
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
	});
	res.write(
		`data: ${JSON.stringify({
			id: "orphan-adopt-test",
			object: "chat.completion.chunk",
			created: Date.now(),
			model: payload.model,
			choices: [{ index: 0, delta: { content: first }, finish_reason: null }],
		})}\n\n`,
	);
	if (slow) await sleep(12000);
	res.write(
		`data: ${JSON.stringify({
			id: "orphan-adopt-test",
			object: "chat.completion.chunk",
			created: Date.now(),
			model: payload.model,
			choices: [{ index: 0, delta: { content: lastChunk }, finish_reason: null }],
		})}\n\n`,
	);
	res.write(
		`data: ${JSON.stringify({
			id: "orphan-adopt-test",
			object: "chat.completion.chunk",
			created: Date.now(),
			model: payload.model,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		})}\n\n`,
	);
	res.write("data: [DONE]\n\n");
	res.end();
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "orphan-adopt-test" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "orphan-adopt-test",
				models: [
					{
						id: "orphan-mock",
						name: "Orphan Adopt Mock",
						input: ["text"],
						contextWindow: 32000,
						maxTokens: 4096,
					},
				],
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
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_TOKEN: "",
	},
	stdio: "ignore",
	windowsHide: true,
});

const waitForPort = async (port, timeout = 15000) => {
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
			} else if (message.type === "message_delta" && this.state) {
				this.sawDelta = true;
			} else if (message.type === "conversations") {
				this.conversations = message.conversations;
				this.elsewhere = message.elsewhere ?? [];
			}
		});
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	async waitForType(type, predicate = () => true, timeout = 15000) {
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
	async waitForState(predicate, timeout = 15000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error(`[${this.name}] timeout waiting for state`);
	}
	async waitForMessage(predicate, timeout = 25000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			const message = this.messages.find(predicate);
			if (message) return message;
			await sleep(50);
		}
		throw new Error(`[${this.name}] timeout waiting for message`);
	}
}

let clientA;
let clientB;
let clientC;
const noticeText = (m) => `${m.text ?? ""} ${m.textEn ?? ""}`;
try {
	await waitForPort(PORT);

	const openClient = async (clientId, withModel = true) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		await new Promise((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		const c = new Client(ws, clientId);
		c.send({ type: "hello", clientId });
		await c.waitForType("ready");
		c.send({ type: "get_state" });
		await c.waitForState((s) => Boolean(s.conversationId));
		if (withModel) {
			c.send({ type: "set_model", modelId: "main/orphan-mock" });
			await c.waitForState((s) => s.model?.id === "orphan-mock");
		}
		return c;
	};

	clientA = await openClient("orphan-A");
	clientA.send({ type: "prompt", text: "orphan seed hello" });
	await clientA.waitForMessage(
		(m) => m.role === "assistant" && JSON.stringify(m.content).includes("seed-message"),
		25000,
	);
	clientA.send({ type: "prompt", text: "SLOW orphan run" });
	await clientA.waitForState((s) => s.isStreaming, 15000);
	const convA = clientA.state.conversationId;
	console.log(`✓ A 正在跑（conv=${convA}），模拟关闭浏览器`);
	clientA.ws.close();
	clientA.ws.terminate();
	await sleep(1000);

	clientB = await openClient("orphan-B", false);
	await clientB.waitForType("notice", (m) => noticeText(m).includes("关闭浏览器前"), 15000);
	console.log("✓ B 收到认领 notice");
	if (clientB.state.conversationId !== convA)
		throw new Error(`B 没有认领 A 的会话（${clientB.state.conversationId} ≠ ${convA}）——仍是“另一处”`);
	console.log("✓ B 落在 A 的同一对话上（同 conversationId）");
	const rowB = clientB.conversations.find((c) => c.id === convA);
	if (!rowB || rowB.messageCount < 2) throw new Error("B 的运行列表里没有 A 的对话（含历史消息）");
	if (!rowB.isStreaming) throw new Error("B 看不到该对话正在跑");
	console.log("✓ B 的运行列表里有该对话（含历史、streaming 中）");
	if (clientB.elsewhere.length !== 0)
		throw new Error(`B 还有 elsewhere 行（${JSON.stringify(clientB.elsewhere)}）——认领后不应再有“另一处”`);
	console.log("✓ B 没有 elsewhere 行（不是只读感知，是真接管）");
	if (!clientB.messages.some((m) => JSON.stringify(m.content ?? "").includes("orphan seed hello")))
		throw new Error("B 看不到 A 的历史消息");
	console.log("✓ B 能看到 A 的历史消息");
	if (clientB.state.model?.id !== "orphan-mock") throw new Error("B 没继承 A 的模型（会话不连续）");
	console.log("✓ B 继承了 A 的模型（同一会话对象）");

	clientC = await openClient("orphan-C", false);
	await clientC.waitForType("notice", (m) => noticeText(m).includes("停在了新对话"), 15000);
	console.log("✓ C（B 在线时上线）走空白新对话，不抢认领");
	if (clientC.messages.length !== 0) throw new Error("C 的默认对话不是空白的");
	if (!clientC.elsewhere.some((w) => w.isStreaming)) throw new Error("C 的 elsewhere 看不到 B 正在跑（跨端感知缺失）");
	console.log("✓ C 在 elsewhere 只读看到 B 正在跑（issue #145 行为保留）");
	clientC.ws.close();
	clientC.ws.terminate();
	await sleep(500);

	clientB.send({ type: "prompt", text: "hello FROMB" });
	await clientB.waitForMessage(
		(m) => m.role === "assistant" && JSON.stringify(m.content).includes("answer-for-B"),
		30000,
	);
	console.log("✓ B 对认领来的对话 steer 成功（可操作，不只是可看）");

	console.log("\nALL PASS");
} catch (error) {
	console.error(`✗ ${error.message}`);
	for (const c of [clientA, clientB, clientC]) {
		if (!c) continue;
		console.error(
			`[${c.name}] state=isStreaming:${c.state?.isStreaming} conv:${c.state?.conversationId} msgs:${c.messages.length} received:[${c.received.map((m) => m.type).join(",")}]`,
		);
		for (const m of c.received.filter((m) => m.type === "notice").slice(-5))
			console.error(`[${c.name}] leftover notice: ${noticeText(m).slice(0, 200)}`);
	}
	process.exitCode = 1;
} finally {
	clientA?.ws.close();
	clientB?.ws.close();
	clientC?.ws.close();
	server.kill();
	mock.close();
}
