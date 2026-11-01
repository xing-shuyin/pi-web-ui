// Issue #567 回归：跨设备打开历史会话自动过户（单 runtime）与陈旧元数据侧枝纠偏
// Usage: node tests/cross-device-switch-session-test.mjs [port]
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { ensureBuild } from "./lib/ensure-build.mjs";
import { freePort } from "./lib/port-utils.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.argv[2] || 8975);
const MOCK_PORT = PORT + 1;
freePort(PORT);
freePort(MOCK_PORT);

const repoRoot = realpathSync(new URL("../", import.meta.url));
ensureBuild(repoRoot);

const base = mkdtempSync(join(tmpdir(), "pi-web-cross-device-567-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const MODEL_ID = "mock-model-567";
const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
};
const delta = (model, d, finish = null) => ({
	id: "mock-567",
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
	sse(res, [delta(payload.model, { content: "PHONE-TASK-RESULT" }), delta(payload.model, {}, "stop")]);
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

const waitForPort = async (port, timeout = 20000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/health`);
			if (response.ok) return;
		} catch {
			/* starting */
		}
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
	async waitForState(predicate, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error(`[${this.name}] timeout waiting for state`);
	}
	notices() {
		return this.received.filter((m) => m.type === "notice");
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
		await c.waitForState((s) => Boolean(s.conversationId));
		c.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
		await c.waitForState((s) => s.model?.id === MODEL_ID);
		return c;
	};

	// Part 1: Client A (手机端) 完成任务
	clientA = await openClient("phone-client-567");
	clientA.send({ type: "prompt", text: "task-from-phone" });
	await clientA.waitForState((s) => s.isStreaming === false, 60000);
	{
		const started = Date.now();
		let done = false;
		while (Date.now() - started < 30000) {
			const texts = (clientA.messages ?? [])
				.filter((m) => m.role === "assistant")
				.flatMap((m) => m.content ?? [])
				.map((b) => b.text ?? "")
				.join("\n");
			if (texts.includes("PHONE-TASK-RESULT")) {
				done = true;
				break;
			}
			await sleep(100);
		}
		check("手机端 A 的任务已完成并拿到最终结果", done);
	}

	const convAId = clientA.state.conversationId;
	const sessionFileA = clientA.state.sessionFile;
	check("手机端 A 会话已持久化至 sessionFile", Boolean(sessionFileA), sessionFileA);

	// Part 2: Client B (电脑端) 打开同一个 sessionFile (通过 switch_session，非 elsewhere 点击)
	clientB = await openClient("computer-client-567");

	// 电脑端直接打开该 sessionFile（用户在 History 列表中点击了该历史会话）
	clientB.send({ type: "switch_session", path: sessionFileA });

	// 验证：电脑端自动触发了 takeover，无需二次点击 elsewhere
	{
		const started = Date.now();
		let restored = false;
		while (Date.now() - started < 30000) {
			const texts = (clientB.messages ?? [])
				.flatMap((m) => m.content ?? [])
				.map((b) => b.text ?? "")
				.join("\n");
			if (texts.includes("PHONE-TASK-RESULT") && texts.includes("task-from-phone")) {
				restored = true;
				break;
			}
			await sleep(100);
		}
		check("电脑端 switch_session 自动过户接管，完整显示手机端结果（issue #567）", restored);
	}

	// 验证 A 侧该会话已安全迁出（不会保留双 runtime）
	{
		const started = Date.now();
		let goneFromA = false;
		while (Date.now() - started < 15000) {
			if (!clientA.conversations.some((c) => c.id === convAId)) {
				goneFromA = true;
				break;
			}
			await sleep(100);
		}
		check("手机端 A 的原会话已安全迁出，避免双 writer 冲突", goneFromA);
	}

	// Part 3: 验证损坏的历史文件自动拓扑纠偏与叶子校准（issue #567 确切现场）
	const sessionDir = dirname(sessionFileA);
	const corruptedFile = join(sessionDir, "corrupted-issue-567.jsonl");
	const headerLine = JSON.stringify({ type: "session", version: 3, id: "corrupt-s1", cwd: workdir });
	const m1 = JSON.stringify({
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: "2026-10-08T10:00:00.000Z",
		message: { role: "user", content: "hello" },
	});
	const m2 = JSON.stringify({
		type: "message",
		id: "8775fb27",
		parentId: "m1",
		timestamp: "2026-10-08T10:01:00.000Z",
		message: { role: "assistant", content: [{ type: "text", text: "step 1 done" }] },
	});
	const m3 = JSON.stringify({
		type: "message",
		id: "m3",
		parentId: "8775fb27",
		timestamp: "2026-10-08T11:00:00.000Z",
		message: { role: "user", content: "continue step 2" },
	});
	const m4 = JSON.stringify({
		type: "message",
		id: "c9560bdb",
		parentId: "m3",
		timestamp: "2026-10-08T11:14:41.139Z",
		message: { role: "assistant", content: [{ type: "text", text: "CORRUPTED-BRANCH-RESTORED-TARGET" }] },
	});
	// 尾部追加挂在 8775fb27 上的 custom entries
	const plan1 = JSON.stringify({
		type: "custom",
		customType: "plannotator",
		id: "plan-entry-1",
		parentId: "8775fb27",
		timestamp: "2026-10-08T11:53:01.358Z",
	});
	const plan2 = JSON.stringify({
		type: "custom",
		customType: "plannotator",
		id: "plan-entry-2",
		parentId: "plan-entry-1",
		timestamp: "2026-10-08T11:53:01.400Z",
	});
	writeFileSync(corruptedFile, [headerLine, m1, m2, m3, m4, plan1, plan2].join("\n") + "\n");

	// Client B 打开该被损坏的文件
	clientB.send({ type: "switch_session", path: corruptedFile });

	{
		const started = Date.now();
		let targetFound = false;
		while (Date.now() - started < 30000) {
			const texts = (clientB.messages ?? [])
				.flatMap((m) => m.content ?? [])
				.map((b) => b.text ?? "")
				.join("\n");
			if (texts.includes("CORRUPTED-BRANCH-RESTORED-TARGET")) {
				targetFound = true;
				break;
			}
			await sleep(100);
		}
		check("打开被旧侧枝劫持的历史文件时，自动纠偏并恢复主分支完整历史（issue #567）", targetFound);
	}

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
}

process.exit(failures === 0 ? 0 : 1);
