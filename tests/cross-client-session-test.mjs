import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.argv[2] || 8969);
const MOCK_PORT = PORT + 1;
const base = mkdtempSync(join(tmpdir(), "pi-web-cross-client-"));
const workdir = join(base, "work");
const otherdir = join(base, "other");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(otherdir, { recursive: true });
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
	const slow = prompt.includes("SLOW");
	const first = slow ? "background-" : "seed-";
	const lastChunk = slow ? "finished" : "message";
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
	});
	const writeChunk = (content) =>
		res.write(
			`data: ${JSON.stringify({
				id: "cross-client-test",
				object: "chat.completion.chunk",
				created: Date.now(),
				model: payload.model,
				choices: [{ index: 0, delta: { content }, finish_reason: null }],
			})}\n\n`,
		);
	writeChunk(first);
	if (slow) await sleep(12000);
	writeChunk(lastChunk);
	res.write(
		`data: ${JSON.stringify({
			id: "cross-client-test",
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

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "cross-client-test" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "cross-client-test",
				models: [
					{
						id: "cross-client-mock",
						name: "Cross Client Mock",
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
	},
	stdio: "ignore",
	windowsHide: true,
});

const waitForPort = async (port, timeout = 15000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`);
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
	async waitForMessage(predicate, timeout = 20000) {
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
let clientF;
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
		await c.waitForState((s) => Boolean(s.conversationId));
		if (withModel) {
			c.send({ type: "set_model", modelId: "main/cross-client-mock" });
			await c.waitForState((s) => s.model?.id === "cross-client-mock");
		}
		return c;
	};

	clientA = await openClient("cross-client-A");

	clientA.send({ type: "prompt", text: "seed" });
	await clientA.waitForMessage(
		(m) => m.role === "assistant" && JSON.stringify(m.content).includes("seed-message"),
		20000,
	);
	clientA.send({ type: "prompt", text: "SLOW run A" });
	await clientA.waitForState((s) => s.isStreaming, 15000);
	const runningFile = await clientA.waitForState((s) => Boolean(s.sessionFile), 15000).then((s) => s.sessionFile);
	console.log(`✓ A streaming on ${runningFile}`);

	clientC = await openClient("cross-client-C", false);
	await clientC.waitForType("notice", (m) => noticeText(m).includes("停在了新对话"), 15000);
	await sleep(500);
	if (clientC.state.sessionFile === runningFile)
		throw new Error("新标签页默认打开了正在跑的对话 —— 首帧即应纠正为空白");
	if (clientC.messages.length !== 0) throw new Error("新标签页默认对话不是空白的");
	console.log("✓ 新标签页不再默认打开正在跑的对话（attach 即纠正，首帧空白）");
	clientC.ws.close();

	clientF = await openClient("cross-client-F", false);
	await clientF.waitForType("notice", (m) => noticeText(m).includes("停在了新对话"), 15000);
	clientF.send({ type: "set_cwd", path: otherdir });
	await clientF.waitForState((s) => s.cwd === otherdir, 15000);
	clientF.send({ type: "set_cwd", path: workdir });
	await clientF.waitForState((s) => s.cwd === workdir, 15000);
	await clientF.waitForType("notice", (m) => noticeText(m).includes("停在了新对话"), 15000);
	await sleep(500);
	if (clientF.state.sessionFile === runningFile) throw new Error("setCwd 首访恢复了正在跑的对话 —— 应停在空白新对话");
	if (clientF.messages.length !== 0) throw new Error("setCwd 后的默认对话不是空白的");
	console.log("✓ 切项目首访同样跳过正在跑的会话（停在空白新对话）");
	clientF.ws.close();

	clientB = await openClient("cross-client-B");
	await clientB.waitForType("notice", (m) => noticeText(m).includes("停在了新对话"), 15000);
	console.log("✓ B 上来同样不恢复正在跑的会话");

	const bSeesA = await (async () => {
		const started = Date.now();
		while (Date.now() - started < 15000) {
			if (clientB.elsewhere.some((w) => w.isStreaming)) return true;
			await sleep(100);
		}
		return false;
	})();
	if (!bSeesA) throw new Error("B 的左栏 elsewhere 没有出现 A 的运行（跨客户端感知缺失）");
	console.log("✓ B 在 elsewhere 看到 A 正在运行");

	const convBBefore = clientB.state.conversationId;
	clientB.send({ type: "switch_session", path: runningFile });
	const blocked = await clientB.waitForType("notice", (m) => noticeText(m).includes("另一处运行中"), 15000);
	if (!blocked) throw new Error("B 打开 streaming 会话未被拒绝");
	await sleep(500);
	if (clientB.state.conversationId !== convBBefore)
		throw new Error("B 的活动对话变了 —— 第二个 writer 已建（双写发生）");
	if (clientB.state.sessionFile === runningFile)
		throw new Error("B 持有了与 A 相同的文件 —— 第二个 writer 已建（双写发生）");
	console.log("✓ B 打开正在跑的会话被拒绝，未建第二个 writer");

	clientB.send({ type: "prompt", text: "hello from B" });
	await clientB.waitForType("notice", (m) => noticeText(m).includes("同项目并行"), 15000);
	console.log("✓ B 收到同项目并行提醒");
	await clientA.waitForType("notice", (m) => noticeText(m).includes("同项目并行"), 15000);
	console.log("✓ A 收到对端并行通告");
	await clientB.waitForMessage(
		(m) => m.role === "assistant" && JSON.stringify(m.content).includes("seed-message"),
		20000,
	);
	console.log("✓ B 的并行 run 正常跑完（未因防护被误杀）");
	await clientA.waitForMessage(
		(m) => m.role === "assistant" && JSON.stringify(m.content).includes("background-finished"),
		20000,
	);
	await clientA.waitForState((s) => !s.isStreaming, 15000);
	console.log("✓ A 的 run 正常跑完（不受 B 影响）");

	clientB.send({ type: "switch_session", path: runningFile });
	await clientB.waitForState((s) => s.sessionFile === runningFile, 15000);
	console.log("✓ A 结束后 B 可正常打开该会话");

	clientB.send({ type: "new_chat" });
	await clientB.waitForState((s) => !s.sessionFile || s.sessionFile !== runningFile, 15000);
	clientB.send({ type: "prompt", text: "B second file" });
	await clientB.waitForMessage(
		(m) => m.role === "assistant" && JSON.stringify(m.content).includes("seed-message"),
		20000,
	);
	const bFile = await clientB.waitForState((s) => Boolean(s.sessionFile), 15000).then((s) => s.sessionFile);
	clientB.ws.close();
	await sleep(1000);
	const nBefore = clientA.received.length;
	clientA.send({ type: "switch_session", path: bFile });
	await clientA.waitForState((s) => s.sessionFile === bFile, 15000);
	await sleep(2000);
	const ghostWarn = clientA.received
		.slice(nBefore)
		.filter((m) => m.type === "notice" && noticeText(m).includes("也开着"));
	if (ghostWarn.length > 0) throw new Error("对端已断开仍警告“另一处也开着”（幽灵持有者）");
	console.log("✓ 对端关闭后打开其会话不再误报（幽灵持有者不打扰）");
} catch (error) {
	console.error(`✗ ${error.message}`);
	for (const c of [clientA, clientB, clientC, clientF]) {
		if (!c) continue;
		console.error(
			`[${c.name}] state=isStreaming:${c.state?.isStreaming} conv:${c.state?.conversationId} msgs:${c.messages.length} received:[${c.received.map((m) => m.type).join(",")}]`,
		);
		for (const m of c.received.filter((m) => m.type === "notice").slice(-5))
			console.error(`[${c.name}] leftover notice: ${noticeText(m).slice(0, 200)}`);
		if (c.messages.length) console.error(`[${c.name}] messages: ${JSON.stringify(c.messages).slice(0, 600)}`);
	}
	process.exitCode = 1;
} finally {
	clientA?.ws.close();
	clientB?.ws.close();
	clientC?.ws.close();
	clientF?.ws.close();
	server.kill();
	mock.close();
}
