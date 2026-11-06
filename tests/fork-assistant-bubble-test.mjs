import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.argv[2] || 8961);
const MOCK_PORT = PORT + 1;
const repoRoot = realpathSync(dirname(fileURLToPath(import.meta.url)) + "/..");
const base = mkdtempSync(join(tmpdir(), "pi-web-fork-assistant-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const replyFor = (prompt) => (prompt.includes("第一个问题") ? "reply-one" : "reply-two");

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
	const reply = replyFor(prompt);
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const chunk = (content, finish) =>
		res.write(
			`data: ${JSON.stringify({
				id: "fork-assistant-test",
				object: "chat.completion.chunk",
				created: Date.now(),
				model: payload.model,
				choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish ?? null }],
			})}\n\n`,
		);
	chunk(reply);
	chunk("", "stop");
	res.write("data: [DONE]\n\n");
	res.end();
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "fork-assistant-test" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "fork-assistant-test",
				models: [
					{
						id: "fork-assistant-mock",
						name: "Fork Assistant Mock",
						input: ["text"],
						contextWindow: 32000,
						maxTokens: 4096,
					},
				],
			},
		},
	}),
);

const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
	cwd: repoRoot,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_SDK: "bundled",
		PI_WEB_PLUGIN_CATALOG_URL: "",
	},
	stdio: "ignore",
	windowsHide: true,
});

const waitForPort = async (port, timeout = 30000) => {
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
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = null;
		this.messages = [];
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
				this.messages = [...this.messages, ...(message.appended ?? [])];
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
		throw new Error(`timeout waiting for ${type}`);
	}
	async waitForState(predicate, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error("timeout waiting for state");
	}
	async waitForMessage(predicate, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			const message = this.messages.find(predicate);
			if (message) return message;
			await sleep(50);
		}
		throw new Error("timeout waiting for message");
	}
	sawErrorNotice() {
		return this.received.some(
			(m) =>
				m.type === "notice" && m.level === "error" && /找不到指定的消息节点|找不到指定的回滚检查点/.test(m.text ?? ""),
		);
	}
}

const assistantText = (messages, text) =>
	messages.find((m) => m.role === "assistant" && m.content.some?.((b) => b.type === "text" && b.text.includes(text)));

let client;
try {
	await waitForPort(PORT);
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	client = new Client(ws);
	client.send({ type: "hello", clientId: "fork-assistant-bubble-test" });
	await client.waitForType("ready");
	await client.waitForState((state) => Boolean(state.conversationId));

	client.send({ type: "set_model", modelId: "main/fork-assistant-mock" });
	await client.waitForState((state) => state.model?.id === "fork-assistant-mock");

	client.send({ type: "prompt", text: "第一个问题" });
	await client.waitForMessage((m) => assistantText([m], "reply-one"));
	client.send({ type: "prompt", text: "第二个问题" });
	await client.waitForMessage((m) => assistantText([m], "reply-two"));
	await client.waitForState((state) => !state.isStreaming);

	const assistant1 = assistantText(client.messages, "reply-one");
	if (!assistant1) throw new Error("assistant reply-one not rendered");
	if (!/^a-\d+-\d+$/.test(assistant1.id) || /^a-\d+-1$/.test(assistant1.id)) {
		throw new Error(`assistant id should use the global counter (not a-<ts>-1), got ${assistant1.id}`);
	}
	console.log(`[1] assistant bubble rendered as ${assistant1.id}`);

	client.send({ type: "rollback_session", messageId: assistant1.id });
	await client.waitForState((state) => state.messages.length === 2, 20000);
	await sleep(300);
	if (client.sawErrorNotice()) throw new Error("rollback on assistant bubble failed to resolve");
	const rolled = client.state.messages;
	if (rolled.length !== 2 || !assistantText(rolled, "reply-one")) {
		throw new Error(`rollback should keep [user1, reply-one], got ${rolled.length} messages`);
	}
	console.log("[2] rollback to assistant bubble resolved and truncated to 2 messages");

	const convBefore = client.state.conversationId;
	client.send({ type: "fork_session", messageId: assistant1.id, position: "at" });
	await client.waitForType(
		"notice",
		(m) => /已派生新分支|Forked new branch/.test(m.text ?? "") || m.level === "error",
		20000,
	);
	if (client.sawErrorNotice()) throw new Error("fork on assistant bubble failed to resolve");
	await client.waitForState((state) => state.conversationId !== convBefore, 20000);
	const forked = client.state.messages;
	if (!assistantText(forked, "reply-one")) {
		throw new Error(`forked conversation should contain reply-one, got ${forked.length} messages`);
	}
	console.log(`[3] fork from assistant bubble resolved; new conversation has ${forked.length} messages`);
	console.log("✓ fork/rollback resolve on assistant bubbles (issue #381)");
} catch (error) {
	console.error(`✗ ${error.message}`);
	process.exitCode = 1;
} finally {
	client?.ws.close();
	server.kill();
	mock.close();
}
