import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { ensureBuild } from "./lib/ensure-build.mjs";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const PORT = Number(process.argv[2] || 8908);
const MOCK_PORT = PORT + 1;
const base = mkdtempSync(join(tmpdir(), "pi-web-cross-project-"));
const projA = join(base, "projA");
const projB = join(base, "projB");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(projA, { recursive: true });
mkdirSync(projB, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(projA, "only-in-A.txt"), "A\n");
writeFileSync(join(projB, "only-in-B.txt"), "B\n");

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

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
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
	});
	const writeChunk = (content) =>
		res.write(
			`data: ${JSON.stringify({
				id: "cross-project-test",
				object: "chat.completion.chunk",
				created: Date.now(),
				model: payload.model,
				choices: [{ index: 0, delta: { content }, finish_reason: null }],
			})}\n\n`,
		);
	writeChunk(slow ? "cross-" : "seed-");
	if (slow) await sleep(2500);
	writeChunk(slow ? "project" : "message");
	res.write(
		`data: ${JSON.stringify({
			id: "cross-project-test",
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

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "cross-project-test" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "cross-project-test",
				models: [
					{
						id: "cross-project-mock",
						name: "Cross Project Mock",
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
try {
	ensureBuild(repoRoot, "conv-cross-project-test");
} catch (err) {
	console.error(String(err?.message ?? err));
	process.exit(1);
}
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: repoRoot,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: projA,
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
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = null;
		this.messages = [];
		this.conversations = [];
		this.files = [];
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
			} else if (message.type === "files") {
				this.files.push(message);
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
		throw new Error(`timeout waiting for ${type}`);
	}
	async waitForState(predicate, timeout = 15000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error("timeout waiting for state");
	}
	async waitForMessage(predicate, timeout = 15000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			const message = this.messages.find(predicate);
			if (message) return message;
			await sleep(50);
		}
		throw new Error("timeout waiting for message");
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
	client.send({ type: "hello", clientId: `cross-project-${randomUUID()}` });
	await client.waitForType("ready");
	await client.waitForState((state) => Boolean(state.conversationId));

	client.send({ type: "set_model", modelId: "main/cross-project-mock" });
	await client.waitForState((state) => state.model?.id === "cross-project-mock");

	client.send({ type: "prompt", text: "seed" });
	await client.waitForMessage((message) => message.role === "assistant");
	const seedId = client.state.conversationId;

	client.send({ type: "new_chat" });
	await client.waitForState((state) => state.conversationId !== seedId);

	client.send({ type: "prompt", text: "SLOW cross-project run" });
	const streamingState = await client.waitForState((state) => state.isStreaming && state.conversationId !== seedId);
	const aConvId = streamingState.conversationId;
	check("slow run is streaming in project A", aConvId === client.state.conversationId && client.state.cwd === projA);

	client.send({ type: "set_cwd", path: projB });
	await client.waitForState((state) => state.cwd === projB && state.conversationId !== aConvId);
	console.log(`     active now: cwd=${client.state.cwd} conversation=${client.state.conversationId}`);

	await client.waitForType("conversations", (message) =>
		message.conversations.some(
			(conversation) => conversation.id === aConvId && conversation.cwd === projA && conversation.isStreaming,
		),
	);
	check("A's streaming conversation stays visible after leaving the project", true);
	const named = client.conversations.find((c) => c.id === aConvId);
	check(
		"conversation is named from its first prompt immediately",
		named?.title === "SLOW cross-project run",
		`title="${named?.title}"`,
	);

	await client.waitForType(
		"conversations",
		(message) =>
			message.conversations.some(
				(conversation) => conversation.id === aConvId && conversation.cwd === projA && !conversation.isStreaming,
			),
		15000,
	);
	check("A's conversation stays listed after the run finishes", true);

	await client.waitForType("files", () => true);
	const filesBeforeSwitch = client.files.length;
	client.send({ type: "switch_conversation", id: aConvId });
	let switched = false;
	try {
		await client.waitForState((state) => state.conversationId === aConvId && state.cwd === projA);
		switched = true;
	} catch {
		switched = false;
	}
	check(
		"switch_conversation switches conversation AND project back to A",
		switched,
		`conversation=${client.state.conversationId} cwd=${client.state.cwd}`,
	);
	await client.waitForMessage(
		(message) => message.role === "assistant" && JSON.stringify(message.content).includes("cross-project"),
	);
	check("the background response is still there after switching back", true);

	const filesAfter = await client
		.waitForType("files", () => client.files.length > filesBeforeSwitch)
		.then(() => client.files.length);
	check(
		"server re-pushed a file listing after the cross-project switch",
		filesAfter > filesBeforeSwitch,
		`${filesBeforeSwitch} → ${filesAfter} pushes`,
	);
} catch (error) {
	console.error(`✗ ${error.message}`);
	failures++;
} finally {
	client?.ws.close();
	server.kill();
	mock.close();
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
