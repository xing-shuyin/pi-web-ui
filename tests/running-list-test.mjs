import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.argv[2] || 8918);
const MOCK_PORT = PORT + 1;
const base = mkdtempSync(join(tmpdir(), "pi-web-running-list-"));
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
	const slow = prompt.includes("SLOW");
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const writeChunk = (content) =>
		res.write(
			`data: ${JSON.stringify({
				id: "running-list-test",
				object: "chat.completion.chunk",
				created: Date.now(),
				model: payload.model,
				choices: [{ index: 0, delta: { content }, finish_reason: null }],
			})}\n\n`,
		);
	writeChunk(slow ? "thinking-" : "quick-");
	if (slow) await sleep(4000);
	writeChunk("done");
	res.write(
		`data: ${JSON.stringify({
			id: "running-list-test",
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

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "running-list-test" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "running-list-test",
				models: [
					{
						id: "running-list-mock",
						name: "Running List Mock",
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

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = null;
		this.messages = [];
		this.conversations = [];
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
				this.activeId = message.activeId;
			}
		});
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	row(id) {
		return this.conversations.find((c) => c.id === id);
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
		throw new Error(`timeout waiting for ${type}`);
	}
	async waitFor(predicate, what, timeout = 15000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (predicate()) return true;
			await sleep(50);
		}
		throw new Error(`timeout waiting for ${what}`);
	}
	async waitForState(predicate, timeout = 15000) {
		return this.waitFor(() => this.state && predicate(this.state), "state", timeout);
	}
	async waitForMessage(predicate, timeout = 15000) {
		return this.waitFor(() => this.messages.some(predicate), "message", timeout);
	}
}

let client;
try {
	await waitForPort(PORT);
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	client = new Client(ws);
	client.send({ type: "hello", clientId: "running-list-test" });
	await client.waitForType("ready");
	await client.waitForState((state) => Boolean(state.conversationId));
	client.send({ type: "set_model", modelId: "main/running-list-mock" });
	await client.waitForState((state) => state.model?.id === "running-list-mock");

	await sleep(400);
	check(
		"blank chat is NOT in the running list",
		client.conversations.length === 0,
		`${client.conversations.length} listed`,
	);

	const firstConvId = client.state.conversationId;
	client.send({ type: "prompt", text: "SLOW 第一条消息" });
	await client.waitForState((state) => state.isStreaming);
	await client.waitFor(
		() => Boolean(client.row(firstConvId)),
		"active conversation to enter the running list while streaming",
	);
	const streamingRow = client.row(firstConvId);
	check("active conversation is listed while streaming", Boolean(streamingRow));
	check("that row is marked as the active one", client.activeId === firstConvId, `activeId=${client.activeId}`);
	check("that row reports streaming", streamingRow?.isStreaming === true);
	check("title comes from the first prompt", streamingRow?.title === "SLOW 第一条消息", `title=${streamingRow?.title}`);
	check(
		"blank sibling rows were not invented",
		client.conversations.length === 1,
		client.conversations.map((c) => c.id).join(","),
	);

	await client.waitForState((state) => !state.isStreaming);
	await client.waitFor(
		() => client.row(firstConvId)?.isStreaming === false && (client.row(firstConvId)?.messageCount ?? 0) >= 2,
		"finished active conversation to stay listed with its message count",
	);
	check("finished active conversation stays listed", Boolean(client.row(firstConvId)));
	check("messageCount counts user + assistant", (client.row(firstConvId)?.messageCount ?? 0) >= 2);

	client.send({ type: "dismiss_conversation", id: firstConvId });
	await client.waitForState((state) => state.conversationId !== firstConvId);
	await client.waitFor(() => !client.row(firstConvId), "dismissed conversation to leave the list");
	check("dismissing the active row moves the active marker away", client.state.conversationId !== firstConvId);
	check("dismissing the active row removes it from the list", !client.row(firstConvId));
	check(
		"the replacement chat is a blank (unlisted) one",
		client.conversations.length === 0,
		`${client.conversations.length} listed`,
	);

	client.send({ type: "prompt", text: "SLOW 后台运行" });
	await client.waitForState((state) => state.isStreaming);
	const backgroundId = client.state.conversationId;
	await client.waitFor(() => Boolean(client.row(backgroundId)), "streaming row before new_chat");
	client.send({ type: "new_chat" });
	await client.waitForState((state) => state.conversationId !== backgroundId);
	await client.waitFor(
		() => client.row(backgroundId)?.isStreaming === true && !client.row(client.state.conversationId),
		"background run to stay listed while the new blank chat stays out",
	);
	check("background streaming run stays listed after new_chat", client.row(backgroundId)?.isStreaming === true);
	check("the new blank chat is not listed", !client.row(client.state.conversationId));
	check(
		"exactly one row (the background run)",
		client.conversations.length === 1,
		`${client.conversations.length} listed`,
	);

	await client.waitFor(() => client.row(backgroundId)?.isStreaming === false, "background run to finish");
	check("finished background run is still listed", Boolean(client.row(backgroundId)));
	client.send({ type: "switch_conversation", id: backgroundId });
	await client.waitForState((state) => state.conversationId === backgroundId);
	await client.waitForMessage(
		(message) => message.role === "assistant" && JSON.stringify(message.content).includes("thinking-done"),
	);
	check("switching back keeps the conversation in the list", Boolean(client.row(backgroundId)));
} catch (error) {
	console.error(`✗ ${error.message}`);
	process.exitCode = 1;
} finally {
	client?.ws.close();
	server.kill();
	mock.close();
}
console.log(failures === 0 && !process.exitCode ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? (process.exitCode ?? 0) : 1;
