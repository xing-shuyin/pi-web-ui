// project-model-key — remember {model, key} PER PROJECT on project switch (zero token).
//
// A provider holds several models AND several API keys. Selecting a model in a
// project must remember BOTH the model and its provider's active key IMMEDIATELY
// (not only after a turn — a fresh conversation's model_change is only flushed to
// disk once an assistant message exists, so without client-state the choice would
// be lost on switch). Switching back to the project must restore the pair.
//
// Verifies:
//   1. set_model in A stores projectModels[A]=model and projectProviderKeys[A][main]=key
//   2. switching A→B→A restores the model (state.model.id is the A model, not B's)
//   3. the provider's ACTIVE key is restored to A's key (auth.json), overriding B's key
//
// Usage: npm run build && node tests/project-model-key-test.mjs [port]
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const PORT = Number(process.argv[2] || 8977);
const MOCK_PORT = PORT + 1;
const base = mkdtempSync(join(tmpdir(), "pi-web-project-model-key-"));
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

const MODELS = [
	{ id: "alpha-mock", name: "Alpha Mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 },
	{ id: "beta-mock", name: "Beta Mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 },
];

// Mock OpenAI-completions server. /models returns BOTH models so a provider
// refresh (triggered by activate_provider_key → applyActiveKey → refresh) never
// drops "beta-mock" out of the catalog; /chat/completions is not exercised here.
const mock = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${MOCK_PORT}`);
	if (url.pathname.endsWith("/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ object: "list", data: MODELS.map((m) => ({ ...m, object: "model" })) }));
		return;
	}
	if (url.pathname.endsWith("/chat/completions")) {
		let body = "";
		for await (const chunk of req) body += chunk;
		const payload = JSON.parse(body || "{}");
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
		});
		res.write(
			`data: ${JSON.stringify({
				id: "pmk",
				object: "chat.completion.chunk",
				created: Date.now(),
				model: payload.model,
				choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
			})}\n\n`,
		);
		res.write(
			`data: ${JSON.stringify({
				id: "pmk",
				object: "chat.completion.chunk",
				created: Date.now(),
				model: payload.model,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}\n\n`,
		);
		res.write("data: [DONE]\n\n");
		res.end();
		return;
	}
	res.writeHead(404).end();
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

// Multi-key provider "main": k1 active, k2 secondary (a custom provider is fine —
// provider-keys.json tracks any registered provider id, incl. models.json ones).
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "k1-val" } }));
writeFileSync(
	join(agentDir, "provider-keys.json"),
	JSON.stringify({
		main: {
			activeKeyName: "k1",
			keys: [
				{ name: "k1", apiKey: "k1-val" },
				{ name: "k2", apiKey: "k2-val" },
			],
		},
	}),
);
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "k1-val",
				models: MODELS,
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
		} catch {
			/* starting */
		}
		await sleep(100);
	}
	throw new Error(`server did not start on ${port}`);
};

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = null;
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "snapshot") {
				this.state = message.state;
			} else if (message.type === "snapshot_delta" && this.state && this.state.rev === message.baseRev) {
				this.state = { ...this.state, ...message.state };
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
}

const readClientState = () => {
	try {
		const data = JSON.parse(readFileSync(join(dataDir, "client-state.json"), "utf8"));
		return data[CLIENT_ID] ?? {};
	} catch {
		return {};
	}
};
const readAuth = () => {
	try {
		return JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
	} catch {
		return {};
	}
};

const CLIENT_ID = `pmk-${randomUUID()}`;
let client;
try {
	await waitForPort(PORT);
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	client = new Client(ws);
	client.send({ type: "hello", clientId: CLIENT_ID });
	await client.waitForType("ready");
	await client.waitForState((state) => Boolean(state.conversationId));

	// The default model = first available (alpha-mock). Select beta-mock in A.
	client.send({ type: "set_model", modelId: "main/beta-mock" });
	await client.waitForState((state) => state.model?.id === "beta-mock");
	check("project A model set to beta-mock", client.state.model?.id === "beta-mock");

	// (1) client-state recorded BOTH model and active key IMMEDIATELY on set_model.
	let cs = readClientState();
	check(
		"client-state remembers project A model",
		cs.projectModels?.[projA] === "main/beta-mock",
		JSON.stringify(cs.projectModels),
	);
	check(
		"client-state remembers project A provider key",
		cs.projectProviderKeys?.[projA]?.main === "k1",
		JSON.stringify(cs.projectProviderKeys),
	);

	// Move to B — a fresh conversation (A's blank one is dismissed). Default model = first (alpha-mock).
	client.send({ type: "set_cwd", path: projB });
	await client.waitForState((state) => state.cwd === projB);
	const bDefaultModel = client.state.model?.id;
	check(
		"project B defaults to alpha-mock (so restore is distinguishable)",
		bDefaultModel === "alpha-mock",
		`got ${bDefaultModel}`,
	);

	// In B switch the ACTIVE key to k2 (saves B→main→k2, global auth.json → k2-val).
	client.send({ type: "activate_provider_key", provider: "main", keyName: "k2" });
	cs = readClientState();
	await sleep(300);
	check("project B remembers provider key k2", readClientState().projectProviderKeys?.[projB]?.main === "k2");
	check("global auth.json is k2 while in B", readAuth().main?.key === "k2-val", readAuth().main?.key);

	// Back to A — model (beta) AND key (k1) must both be restored.
	client.send({ type: "set_cwd", path: projA });
	await client.waitForState((state) => state.cwd === projA && state.model?.id === "beta-mock");
	check("project A model restored (beta-mock, not B's/alpha default)", client.state.model?.id === "beta-mock");

	// The provider key must be restored to A's k1 (overriding the global k2 from B).
	const authAfter = await (async () => {
		const t0 = Date.now();
		while (Date.now() - t0 < 5000) {
			const a = readAuth();
			if (a.main?.key === "k1-val") return a;
			await sleep(100);
		}
		return readAuth();
	})();
	check("project A provider key restored to k1 in auth.json", authAfter.main?.key === "k1-val", authAfter.main?.key);
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
