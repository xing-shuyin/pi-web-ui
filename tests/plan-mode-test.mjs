import { createServer } from "node:http";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { freePort, portUp } from "./lib/port-utils.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PORT = 8941;
const CLIENT_ID = "plan-mode-test-client";

let failures = 0;
function check(name, ok, extra = "") {
	console.log((ok ? "✓ " : "✗ ") + name + (extra ? " — " + extra : ""));
	if (!ok) failures++;
}

let script = [];
const delta = (model, d, finish = null) => ({
	id: "chatcmpl-mock",
	object: "chat.completion.chunk",
	created: Math.floor(Date.now() / 1000),
	model,
	choices: [{ index: 0, delta: d, finish_reason: finish }],
});
const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const c of chunks) res.write("data: " + JSON.stringify(c) + "\n\n");
	res.write(
		"data: " +
			JSON.stringify({
				id: "chatcmpl-mock",
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: "mock-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
			}) +
			"\n\n",
	);
	res.write("data: [DONE]\n\n");
	res.end();
};
const toolCall = (model, name, args) =>
	delta(model, {
		tool_calls: [
			{ index: 0, id: "call_" + name, type: "function", function: { name, arguments: JSON.stringify(args) } },
		],
	});

const mockServer = createServer((req, res) => {
	if (req.method === "GET") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ data: [] }));
		return;
	}
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const payload = JSON.parse(body || "{}");
		const messages = Array.isArray(payload.messages) ? payload.messages : [];
		const model = payload.model ?? "mock-model";
		const lastUser = messages.map((m) => m.role).lastIndexOf("user");
		const tail = messages.slice(lastUser + 1);
		if (tail.some((m) => m.role === "tool")) {
			const toolMsg = [...tail].reverse().find((m) => m.role === "tool");
			sse(res, [delta(model, { content: "SEEN:" + String(toolMsg.content ?? "") }), delta(model, {}, "stop")]);
			return;
		}
		if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
			sse(res, [delta(model, { content: "ok" }), delta(model, {}, "stop")]);
			return;
		}
		const step = script.shift();
		if (!step) {
			sse(res, [delta(model, { content: "done" }), delta(model, {}, "stop")]);
			return;
		}
		sse(res, [toolCall(model, step.name, step.args), delta(model, {}, "tool_calls")]);
	});
});
await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
const MOCK_PORT = mockServer.address().port;

const baseDir = mkdtempSync(join(tmpdir(), "pi-plan-mode-test-"));
const workDir = join(baseDir, "work");
const dataDir = join(baseDir, "data");
const agentDir = join(baseDir, "agent");
mkdirSync(workDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "dummy" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:" + MOCK_PORT + "/v1",
				apiKey: "dummy",
				models: [{ id: "mock-model", name: "Mock Model" }],
			},
		},
	}),
);
writeFileSync(join(workDir, "hello.txt"), "hello\n");

const server = spawn("node", [join(REPO_ROOT, "dist/server/index.js")], {
	cwd: workDir,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_CWD: workDir,
		PI_WEB_PLUGIN_CATALOG_URL: "",
	},
	stdio: "ignore",
});

const cleanup = async () => {
	try {
		server.kill();
	} catch {}
	mockServer.close();
	await freePort(PORT);
};

for (let i = 0; i < 80 && !(await portUp(PORT)); i++) await sleep(250);

const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
let seq = 0;
const send = (msg) => ws.send(JSON.stringify({ ...msg, seq: ++seq }));

let snapshot = null;
const notices = [];

ws.on("message", (d) => {
	let m;
	try {
		m = JSON.parse(d.toString());
	} catch {
		return;
	}
	if (m.type === "snapshot") snapshot = m.state;
	else if (m.type === "snapshot_delta") {
		if (snapshot && snapshot.rev === m.baseRev) {
			snapshot = { ...snapshot, ...m.state, messages: [...(snapshot.messages ?? []), ...m.appended] };
		}
	} else if (m.type === "notice") notices.push(m.text);
	else if (m.type === "tool_result") toolResults.push(m);
});

const waitFor = async (pred, what, timeout = 20000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		if (pred()) return true;
		await sleep(100);
	}
	console.error(`TIMEOUT waiting for ${what}`);
	return false;
};
const msgText = (m) => (m?.content ?? []).map((b) => (typeof b?.text === "string" ? b.text : "")).join("");
const lastReply = () => [...(snapshot?.messages ?? [])].reverse().find((m) => m.role === "assistant");
let mark = 0;
const promptAndWait = async (text, what) => {
	mark = (snapshot?.messages ?? []).length;
	send({ type: "prompt", text });
	const ok = await waitFor(
		() => (snapshot?.messages ?? []).length > mark + 1 && msgText(lastReply() ?? {}).includes("SEEN:"),
		what,
	);
	return ok ? msgText(lastReply()) : "";
};

await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "hello", clientId: CLIENT_ID }));
await waitFor(() => snapshot !== null, "initial snapshot");
send({ type: "set_model", modelId: "mock/mock-model" });
await sleep(500);

try {
	send({ type: "set_plan_mode", enabled: true });
	await waitFor(() => snapshot?.planMode === true, "planMode=true in snapshot");
	check("set_plan_mode{true} → 快照 planMode=true", snapshot?.planMode === true);
	check(
		"开启时有 notice 提示",
		notices.some((n) => n.includes("计划模式")),
	);
	check(
		"计划模式下写工具从活跃集动态剔除",
		Array.isArray(snapshot?.tools) && !snapshot.tools.includes("write") && !snapshot.tools.includes("edit"),
	);

	script = [{ name: "write", args: { path: "nope.txt", content: "x" } }];
	const writeReply = await promptAndWait("写个文件", "write 被拒后模型回包");
	check("write 在计划模式被拒", /计划模式|Plan mode|not found/.test(writeReply), writeReply.slice(0, 140));

	script = [{ name: "bash", args: { command: "rm -rf /tmp/nope" } }];
	const bashWriteReply = await promptAndWait("删点东西", "bash 写命令回包");
	check("bash 写命令被拒", /只允许只读命令|read-only commands/.test(bashWriteReply), bashWriteReply.slice(0, 140));

	script = [{ name: "bash", args: { command: "git status" } }];
	const readonlyReply = await promptAndWait("看看状态", "bash 只读命令回包");
	check(
		"bash 只读命令放行（无拒绝文案）",
		!/只允许只读命令|read-only commands|Plan mode/.test(readonlyReply),
		readonlyReply.slice(0, 140),
	);

	send({ type: "set_plan_mode", enabled: false });
	await waitFor(() => snapshot?.planMode === false, "planMode=false in snapshot");
	check("set_plan_mode{false} → 快照 planMode=false", snapshot?.planMode === false);

	script = [{ name: "write", args: { path: "made-by-test.txt", content: "ok" } }];
	const afterOff = await promptAndWait("现在写吧", "write 放行后模型回包");
	check("关闭后 write 不再被计划模式拒", !/计划模式|Plan mode/.test(afterOff), afterOff.slice(0, 140));
	await waitFor(() => existsSync(join(workDir, "made-by-test.txt")), "文件真的落盘");

	const sessionsRoot = join(agentDir, "sessions");
	let sawEntry = false;
	const walk = (dir) => {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else if (name.endsWith(".jsonl") && readFileSync(p, "utf8").includes('"plan/mode"')) sawEntry = true;
		}
	};
	walk(sessionsRoot);
	check("计划模式写入会话转录（可回放恢复）", sawEntry);
} catch (e) {
	console.error("TEST ERROR:", e);
	failures++;
}

await cleanup();
console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
