import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = Number(process.argv[2] || 8991);
const base = mkdtempSync(join(tmpdir(), "pi-web-oauth-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const server = spawn(realpathSync(process.execPath), ["dist/server/index.js"], {
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
let serverOutput = "";
server.stdout.on("data", (data) => (serverOutput += data.toString()));
server.stderr.on("data", (data) => (serverOutput += data.toString()));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
	for (let attempt = 0; attempt < 60; attempt++) {
		try {
			const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
			await new Promise((resolve, reject) => {
				socket.on("open", resolve);
				socket.on("error", reject);
			});
			return socket;
		} catch {
			await sleep(250);
		}
	}
	throw new Error("server not ready");
}

async function waitFor(messages, predicate, label, timeout = 15_000) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const message = messages.find(predicate);
		if (message) return message;
		await sleep(25);
	}
	throw new Error(`timeout waiting for ${label}`);
}

let socket;
let exitCode = 1;
try {
	socket = await connect();
	const messages = [];
	socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
	socket.send(JSON.stringify({ type: "hello", clientId: "provider-oauth-test" }));
	await waitFor(messages, (message) => message.type === "ready", "ready");

	socket.send(JSON.stringify({ type: "list_providers" }));
	const status = await waitFor(messages, (message) => message.type === "providers_status", "provider status");
	const codex = status.providers.find((provider) => provider.id === "openai-codex");
	if (!codex || codex.supportsApiKey !== false || codex.supportsOAuth !== true) {
		throw new Error(`unexpected openai-codex capabilities: ${JSON.stringify(codex)}`);
	}

	socket.send(JSON.stringify({ type: "provider_oauth_start", provider: "openai-codex" }));
	const started = await waitFor(messages, (message) => message.type === "provider_oauth_started", "OAuth start");
	const prompt = await waitFor(
		messages,
		(message) => message.type === "provider_oauth_prompt" && message.flowId === started.flowId,
		"OAuth prompt",
	);
	if (prompt.prompt.type !== "select" || !prompt.prompt.options.some((option) => option.id === "device_code")) {
		throw new Error(`unexpected OAuth prompt: ${JSON.stringify(prompt.prompt)}`);
	}

	socket.send(JSON.stringify({ type: "provider_oauth_cancel", flowId: started.flowId }));
	const result = await waitFor(
		messages,
		(message) => message.type === "provider_oauth_result" && message.flowId === started.flowId,
		"OAuth cancellation",
	);
	if (result.ok !== false || result.cancelled !== true) {
		throw new Error(`unexpected OAuth result: ${JSON.stringify(result)}`);
	}

	console.log("  ✓ OAuth provider protocol");
	exitCode = 0;
} catch (error) {
	console.error("  ✗ OAuth provider protocol", error, serverOutput.trim());
} finally {
	try {
		socket?.close();
	} catch {}
	try {
		process.kill(server.pid, "SIGTERM");
	} catch {}
	await sleep(500);
	rmSync(base, { recursive: true, force: true });
	process.exit(exitCode);
}
