import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const PORT = Number(process.argv[2] || 8938);
const MOCK_PORT = PORT + 2;
freePort(PORT);
freePort(MOCK_PORT);

const base = mkdtempSync(join(tmpdir(), "pi-web-suberr-"));
const projDir = join(base, "proj");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
const extDir = join(agentDir, "extensions");
const ERR_TEXT = "probe requires a persistent Pi session directory";
for (const dir of [projDir, dataDir, agentDir, extDir]) mkdirSync(dir, { recursive: true });

const MODEL_ID = "mock-model";
const CLIENT_ID = "subagent-ext-error-client";
const REQ_LOG = join(base, "requests.log");

writeFileSync(
	join(extDir, "sessiondir-probe.ts"),
	`
export default function (pi: any) {
	pi.on("context", async (_event: any, ctx: any) => {
		const dir = ctx?.sessionManager?.getSessionDir?.() ?? "";
		if (!dir) throw new Error("empty session dir");
		if (!ctx?.sessionManager?.isPersisted?.()) throw new Error(${JSON.stringify(ERR_TEXT)});
		return undefined;
	});
}
`,
);

const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
};
const delta = (model, d, finish = null) => ({
	id: "subagent-ext-err-mock",
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
	const messages = Array.isArray(payload.messages) ? payload.messages : [];
	const flat = JSON.stringify(messages);
	const which = flat.includes("SUBAGENT_RUN") ? "SUB" : flat.includes("SPAWN_NOW") ? "MAIN" : "OTHER";
	appendFileSync(REQ_LOG, `${which} tools=${(payload.tools ?? []).map((t) => t?.function?.name).join(",")}\n`);

	if (flat.includes("SUBAGENT_RUN") && !messages.some((m) => m.role === "tool")) {
		sse(res, [
			delta(payload.model, {
				tool_calls: [
					{
						index: 0,
						id: "call_missing",
						type: "function",
						function: { name: "no_such_tool", arguments: "{}" },
					},
				],
			}),
			delta(payload.model, {}, "tool_calls"),
		]);
		return;
	}
	if (flat.includes("SUBAGENT_RUN")) {
		sse(res, [delta(payload.model, { content: "SUBAGENT_SMOKE_OK" }), delta(payload.model, {}, "stop")]);
		return;
	}
	const hasSubagentTool = (payload.tools ?? []).some((t) => t?.function?.name === "subagent");
	const hasToolResult = messages.some((m) => m.role === "tool");
	if (hasSubagentTool && !hasToolResult) {
		sse(res, [
			delta(payload.model, {
				tool_calls: [
					{
						index: 0,
						id: "call_spawn",
						type: "function",
						function: {
							name: "subagent",
							arguments: JSON.stringify({ action: "spawn", prompt: "SUBAGENT_RUN", type: "probe" }),
						},
					},
				],
			}),
			delta(payload.model, {}, "tool_calls"),
		]);
		return;
	}
	sse(res, [delta(payload.model, { content: "MAIN_DONE" }), delta(payload.model, {}, "stop")]);
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

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
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: projDir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "ignore", "pipe"],
});
server.stderr?.on("data", (d) => process.stderr.write("[srv] " + d.toString()));

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

const waitForPort = async (port, timeout = 20000) => {
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
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "snapshot") this.state = message.state;
		});
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	seen(type, predicate = () => true) {
		return this.received.filter((m) => m.type === type && predicate(m));
	}
	async waitForType(type, predicate = () => true, timeout = 40000) {
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
	async waitForState(predicate, timeout = 60000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error("timeout waiting for state");
	}
}

let ws;
try {
	await waitForPort(PORT);
	const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((r, j) => {
		socket.once("open", r);
		socket.once("error", j);
	});
	ws = socket;
	const client = new Client(socket);
	client.send({ type: "hello", clientId: CLIENT_ID, locale: "en" });
	await client.waitForType("ready");
	await client.waitForType("snapshot");
	client.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
	await client.waitForState((s) => s.model?.id === MODEL_ID);

	client.send({ type: "prompt", text: "SPAWN_NOW" });
	const twoSubRounds = await (async () => {
		const deadline = Date.now() + 60000;
		while (Date.now() < deadline) {
			const lines = existsSync(REQ_LOG) ? readFileSync(REQ_LOG, "utf8").split("\n").filter(Boolean) : [];
			if (lines.filter((l) => l.startsWith("SUB ")).length >= 2) return lines;
			await sleep(100);
		}
		return null;
	})();
	const reqLines = twoSubRounds ?? [];
	console.log("  provider 请求:\n" + (reqLines.map((l) => "    " + l).join("\n") || "    (无)"));
	check("子代理跑了至少两轮 provider 请求（context hook 抛了至少两次）", reqLines.length >= 2, `${reqLines.length} 轮`);
	await sleep(1500);

	const probeNotices = client.seen("notice", (m) =>
		/persistent Pi session directory/.test((m.text ?? "") + (m.textEn ?? "")),
	);
	console.log(
		"  探针 notice:\n" +
			(probeNotices.length ? probeNotices.map((m) => `    [${m.level}] ${m.text}`).join("\n") : "    (无)"),
	);

	check("探针错误只推给浏览器一次（不是每轮一次）", probeNotices.length === 1, `${probeNotices.length} 条`);
	check(
		"notice 带「子代理 <conversationId>」归属前缀",
		probeNotices.length === 1 && /^子代理 \S+：扩展报错：/.test(probeNotices[0]?.text ?? ""),
		probeNotices[0]?.text ?? "",
	);
	check(
		"主对话（持久会话）不产生该错误——notice 不会以主对话口径出现",
		probeNotices.every((m) => !/^扩展报错：/.test(m.text ?? "")),
	);
	check("notice 级别是 error", probeNotices.length === 1 && probeNotices[0].level === "error");
} catch (error) {
	console.error("✗ 异常:", error instanceof Error ? error.message : error);
	failures++;
} finally {
	try {
		ws?.close();
	} catch {}
	server.kill();
	mock.close();
	await sleep(300);
	freePort(PORT);
	freePort(MOCK_PORT);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
