import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const PORT = Number(process.argv[2] || 8939);
const MOCK_PORT = PORT + 2;
freePort(PORT);
freePort(MOCK_PORT);

const base = mkdtempSync(join(tmpdir(), "pi-web-subthink-"));
const projDir = join(base, "proj");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
const extDir = join(agentDir, "extensions");
const LOG = join(base, "probe.log");
for (const dir of [projDir, dataDir, agentDir, extDir]) mkdirSync(dir, { recursive: true });

const MODEL_ID = "mock-reasoner";
const CLIENT_ID = "subagent-thinking-client";

const TEMPLATE_NAMES = ["thinker", "inheritor", "clamped"];
const TEMPLATES = [
	{
		name: "thinker",
		description: "固定高强度",
		promptMode: "replace",
		systemPrompt: "ROLE_THINKER 你是深度思考的子代理。",
		enabledSkills: [],
		enabledExtensions: [],
		model: "",
		thinkingLevel: "high",
		enabled: true,
	},
	{
		name: "inheritor",
		description: "跟随主对话",
		promptMode: "replace",
		systemPrompt: "ROLE_INHERITOR 你是跟随主对话强度的子代理。",
		enabledSkills: [],
		enabledExtensions: [],
		model: "",
		thinkingLevel: "",
		enabled: true,
	},
	{
		name: "clamped",
		description: "指定超出模型的档位",
		promptMode: "replace",
		systemPrompt: "ROLE_CLAMPED 你是被收敛档位的子代理。",
		enabledSkills: [],
		enabledExtensions: [],
		model: "",
		thinkingLevel: "max",
		enabled: true,
	},
];
writeFileSync(join(dataDir, "subagent-templates.json"), JSON.stringify(TEMPLATES, null, 2) + "\n");

writeFileSync(
	join(extDir, "thinking-probe.ts"),
	`
import { appendFileSync } from "node:fs";

const LOG = process.env.THINK_PROBE_LOG;
const note = (line: string) => {
	if (LOG) appendFileSync(LOG, line + "\\n");
};

export default function (pi: any) {
	pi.on("before_provider_request", (event: any, ctx: any) => {
		try {
			const flat = JSON.stringify(event?.payload ?? "");
			const messages = event?.payload?.messages ?? [];
			const sysText = JSON.stringify(messages.filter((m: any) => m.role !== "user" && m.role !== "assistant"));
			const userText = JSON.stringify(messages.filter((m: any) => m.role === "user"));
			const hasToolResult = messages.some((m: any) => m.role === "tool");
			let role = hasToolResult ? "main-final" : "main";
			for (const name of ["thinker", "inheritor", "clamped"]) {
				const mark = name.toUpperCase();
				if (sysText.includes("ROLE_" + mark) || userText.includes("SPAWN_" + mark)) role = name;
			}
			note("REQ role=" + role + " think=" + ctx.thinkingLevel + " effort=" + (event?.payload?.reasoning_effort ?? "-") + " model=" + (ctx.model?.id ?? "?"));
		} catch (e: any) {
			note("ERR " + (e && e.message ? e.message : String(e)));
		}
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
	id: "subagent-thinking-mock",
	object: "chat.completion.chunk",
	created: Date.now(),
	model,
	choices: [{ index: 0, delta: d, finish_reason: finish }],
});
const spawnCall = (index, template, prompt) => ({
	index,
	id: `call_${template}`,
	type: "function",
	function: {
		name: "conversation",
		arguments: JSON.stringify({ action: "spawn", prompt, type: template, template, notifyOnDone: false }),
	},
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
	const sysText = JSON.stringify(messages.filter((m) => m.role !== "user" && m.role !== "assistant"));
	const userText = JSON.stringify(messages.filter((m) => m.role === "user"));
	const hasToolResult = messages.some((m) => m.role === "tool");

	for (const name of TEMPLATE_NAMES) {
		const mark = name.toUpperCase();
		if (sysText.includes(`ROLE_${mark}`) || userText.includes(`SPAWN_${mark}`)) {
			sse(res, [delta(payload.model, { content: `SUB_${mark}_OK` }), delta(payload.model, {}, "stop")]);
			return;
		}
	}
	if (!hasToolResult) {
		sse(res, [
			delta(payload.model, {
				tool_calls: TEMPLATE_NAMES.map((name, i) => spawnCall(i, name, `SPAWN_${name.toUpperCase()}`)),
			}),
			delta(payload.model, {}, "tool_calls"),
		]);
		return;
	}
	sse(res, [delta(payload.model, { content: "MAIN_DONE" }), delta(payload.model, {}, "stop")]);
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
				models: [
					{
						id: MODEL_ID,
						name: "Mock Reasoner",
						input: ["text"],
						reasoning: true,
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
		PI_WEB_TOOL_LAZY_LOADING: "0",
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: projDir,
		PI_CODING_AGENT_DIR: agentDir,
		THINK_PROBE_LOG: LOG,
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
			else if (message.type === "snapshot_delta" && this.state && this.state.rev === message.baseRev) {
				this.state = {
					...this.state,
					...message.state,
					messages: [...this.state.messages, ...(message.appended ?? [])],
				};
			}
		});
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	seen(type, predicate = () => true) {
		return this.received.filter((m) => m.type === type && predicate(m));
	}
	async waitForState(predicate, timeout = 60000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error("timeout waiting for state");
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
}

let ws;
try {
	await waitForPort(PORT);
	const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	ws = socket;
	const client = new Client(socket);
	client.send({ type: "hello", clientId: CLIENT_ID, locale: "zh" });
	await client.waitForType("ready");
	await client.waitForType("snapshot");
	client.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
	await client.waitForState((s) => s.model?.id === MODEL_ID);

	client.send({ type: "set_thinking", level: "low" });
	await client.waitForState((s) => s.thinkingLevel === "low");

	client.send({ type: "prompt", text: "SPAWN_NOW" });
	const finished = await client
		.waitForState((s) => JSON.stringify(s.messages ?? []).includes("MAIN_DONE"))
		.catch(() => null);
	check("主对话收尾回合完成（3 个子代理都已启动）", !!finished);

	await sleep(1500);

	const lines = (existsSync(LOG) ? readFileSync(LOG, "utf8") : "").split("\n").filter(Boolean);
	console.log("  probe log:\n" + (lines.length ? lines.map((l) => "    " + l).join("\n") : "    (空)"));
	const reqLines = lines.filter((l) => l.startsWith("REQ "));
	check("派发没有意外递归（5 条请求）", reqLines.length === 5, `实际 ${reqLines.length} 条`);
	const thinkingOf = (role) => {
		const hit = reqLines.find((l) => l.includes(`role=${role} `));
		if (!hit) return null;
		const m = /think=([a-z]+)/.exec(hit);
		return m ? m[1] : null;
	};

	check("模板指定 high → 子代理思考强度 high", thinkingOf("thinker") === "high", `实际 ${thinkingOf("thinker")}`);
	check(
		"模板留空 → 跟随主对话当前强度（low，不是 SDK 默认）",
		thinkingOf("inheritor") === "low",
		`实际 ${thinkingOf("inheritor")}`,
	);
	check(
		"模板指定 max 但模型只支持到 high → 收敛成 high（不报错）",
		thinkingOf("clamped") === "high",
		`实际 ${thinkingOf("clamped")}`,
	);
	check("主对话自己的强度没被派发改掉（仍 low）", thinkingOf("main") === "low", `实际 ${thinkingOf("main")}`);
	const clampNotice = client.seen("notice", (m) => /思考强度|thinking level/i.test((m.text ?? "") + (m.textEn ?? "")));
	check(
		"没有「思考强度设置失败」告警（收敛由 SDK 正常完成）",
		clampNotice.length === 0,
		clampNotice.map((m) => m.text).join(" | ") || "无",
	);
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

if (failures > 0) {
	console.error(`\nsubagent-thinking-test: ${failures} 项失败`);
	process.exit(1);
}
console.log("\nsubagent-thinking-test: all ok");
