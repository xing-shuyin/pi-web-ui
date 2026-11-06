import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const PORT = Number(process.argv[2] || 8936);
const MOCK_PORT = PORT + 2;
freePort(PORT);
freePort(MOCK_PORT);

const base = mkdtempSync(join(tmpdir(), "pi-web-subui-"));
const projDir = join(base, "proj");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
const extDir = join(agentDir, "extensions");
const LOG = join(base, "probe.log");
for (const dir of [projDir, dataDir, agentDir, extDir]) mkdirSync(dir, { recursive: true });

const MODEL_ID = "mock-model";
const CLIENT_ID = "subagent-ui-context-client";
const DIALOG_RACE_MS = 300;

writeFileSync(
	join(extDir, "ui-probe.ts"),
	`
import { appendFileSync } from "node:fs";

const LOG = process.env.UI_PROBE_LOG;
const note = (line: string) => {
	if (LOG) appendFileSync(LOG, line + "\\n");
};
const race = (p: Promise<unknown>) =>
	Promise.race([
		p.then((v) => String(v)),
		new Promise<string>((r) => setTimeout(() => r("TIMEOUT"), ${DIALOG_RACE_MS})),
	]);

export default function (pi: any) {
	pi.on("session_start", async (_event: any, ctx: any) => {
		try {
			// SDK 最近新增 / 老 mock 缺失的那批方法：调用即回归点。
			ctx.ui.setWorkingVisible(false);
			ctx.ui.setToolsExpanded(true);
			ctx.ui.setWorkingMessage("probe");
			ctx.ui.setWorkingIndicator({ frames: [] });
			ctx.ui.setHiddenThinkingLabel("probe");
			ctx.ui.setTitle("probe");
			ctx.ui.setHeader(undefined);
			ctx.ui.setFooter(undefined);
			ctx.ui.onTerminalInput(() => {});
			ctx.ui.setStatus("probe", "on");
			ctx.ui.notify("probe ok", "info");
			ctx.ui.getAllThemes();
			ctx.ui.getTheme("x");
			ctx.ui.setTheme("x");
			ctx.ui.pasteToEditor("x");
			ctx.ui.setEditorText("x");
			ctx.ui.getEditorText();
			ctx.ui.setEditorComponent(undefined);
			ctx.ui.getEditorComponent();
			ctx.ui.addAutocompleteProvider(() => []);
			ctx.ui.setWidget("probe-widget", ["probe"]);
			const confirm = await race(ctx.ui.confirm("probe", "detail"));
			note("OK " + ctx.mode + " confirm=" + confirm + " " + ctx.cwd);
		} catch (e: any) {
			note("ERR " + (e && e.message ? e.message : String(e)));
			throw e;
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
	id: "subagent-ui-mock",
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

	if (flat.includes("SAY_OK")) {
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
							arguments: JSON.stringify({ action: "spawn", prompt: "SAY_OK", type: "probe" }),
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
		UI_PROBE_LOG: LOG,
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
	async waitForState(predicate, timeout = 40000) {
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
	await new Promise((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	ws = socket;
	const client = new Client(socket);
	client.send({ type: "hello", clientId: CLIENT_ID, locale: "en" });
	await client.waitForType("ready");
	await client.waitForType("snapshot");
	client.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
	await client.waitForState((s) => s.model?.id === MODEL_ID);

	client.send({ type: "prompt", text: "SPAWN_NOW" });
	const finished = await client
		.waitForState((s) => JSON.stringify(s.messages ?? []).includes("SUBAGENT_SMOKE_OK"), 60000)
		.catch(() => null);
	check("子代理跑完并产出文本（SUBAGENT_SMOKE_OK）", !!finished);

	await sleep(2000);

	const lines = (existsSync(LOG) ? readFileSync(LOG, "utf8") : "").split("\n").filter(Boolean);
	const okLines = lines.filter((l) => l.startsWith("OK "));
	const errLines = lines.filter((l) => l.startsWith("ERR "));
	console.log("  probe log:\n" + (lines.length ? lines.map((l) => "    " + l).join("\n") : "    (空)"));

	check(`主对话 + 子代理的扩展 session_start 都调通新 UI API`, okLines.length >= 2, `${okLines.length} 条 OK`);
	check("没有 UI API 调用失败（旧 mock 在这里 TypeError）", errLines.length === 0, errLines.join(" | ") || "无 ERR");
	check(
		"子代理的弹窗立即按取消返回（没有挂在无人应答的 Promise 上）",
		okLines.some((l) => l.includes("confirm=null")),
		okLines.filter((l) => l.includes("confirm=")).join(" | "),
	);
	check(
		"挂浏览器的上下文照常等待用户回答（只有子代理被 headless 化）",
		okLines.some((l) => l.includes("confirm=TIMEOUT")),
	);
	const typeErrors = client.seen("notice", (m) =>
		/is not a function|TypeError/.test((m.text ?? "") + (m.textEn ?? "")),
	);
	check(
		"没有向浏览器推 TypeError error notice",
		typeErrors.length === 0,
		typeErrors.map((m) => m.text).join(" | ") || "无",
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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
