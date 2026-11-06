import { createServer } from "node:http";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { freePort, portUp } from "./lib/port-utils.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PORT = 8938;
const CLIENT_ID = "ephemeral-test-client";

let failures = 0;
function check(name, ok, extra = "") {
	console.log((ok ? "✓ " : "✗ ") + name + (extra ? " — " + extra : ""));
	if (!ok) failures++;
}

let mockResponses = [];
const mockServer = createServer((req, res) => {
	if (req.method === "GET") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ data: [] }));
		return;
	}
	let raw = "";
	req.on("data", (c) => (raw += c));
	req.on("end", () => {
		const replyText = mockResponses.shift() ?? "Mock answer.";
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		for (const word of replyText.split(" ")) {
			res.write(
				"data: " +
					JSON.stringify({
						id: "chatcmpl-mock",
						object: "chat.completion.chunk",
						created: Math.floor(Date.now() / 1000),
						model: "mock-model",
						choices: [{ index: 0, delta: { content: word + " " }, finish_reason: null }],
					}) +
					"\n\n",
			);
		}
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
	});
});
await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
const MOCK_PORT = mockServer.address().port;

const baseDir = mkdtempSync(join(tmpdir(), "pi-ephemeral-test-"));
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

const sessionsDir = join(agentDir, "sessions");
const countSessionFiles = () => {
	if (!existsSync(sessionsDir)) return 0;
	let n = 0;
	for (const d of readdirSync(sessionsDir)) {
		const p = join(sessionsDir, d);
		try {
			n += readdirSync(p).filter((f) => f.endsWith(".jsonl")).length;
		} catch {}
	}
	return n;
};

const server = spawn("node", [join(REPO_ROOT, "dist/server/index.js")], {
	cwd: workDir,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_CWD: workDir,
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

for (let i = 0; i < 60 && !(await portUp(PORT)); i++) await sleep(250);

const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
let seq = 0;
const send = (msg) => ws.send(JSON.stringify({ ...msg, seq: ++seq }));

let snapshot = null;
let conversations = [];
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
	} else if (m.type === "conversations") conversations = m.conversations;
	else if (m.type === "notice") notices.push(m.text);
});

const waitFor = async (pred, what, timeout = 15000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		if (pred()) return true;
		await sleep(100);
	}
	console.error(`TIMEOUT waiting for ${what}`);
	return false;
};

const msgText = (m) => (m?.content ?? []).map((b) => (typeof b?.text === "string" ? b.text : "")).join("");
const hasReply = (needle) =>
	(snapshot?.messages ?? []).some((m) => m.role === "assistant" && msgText(m).includes(needle));

await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "hello", clientId: CLIENT_ID }));
await waitFor(() => snapshot !== null, "initial snapshot");
send({ type: "set_model", modelId: "mock/mock-model" });
await sleep(500);

try {
	const beforeFiles = countSessionFiles();
	const startupConvId = snapshot.conversationId;
	send({ type: "new_chat", ephemeral: true });
	await waitFor(() => snapshot?.conversationId && snapshot.conversationId !== startupConvId, "ephemeral conversation");
	const ephId = snapshot.conversationId;
	check("new_chat{ephemeral} 建出新对话", Boolean(ephId) && ephId !== startupConvId, `${startupConvId} → ${ephId}`);
	check(
		"快照带上 isEphemeral 标记（空白时就该有，提示条据此渲染）",
		snapshot.isEphemeral === true,
		String(snapshot.isEphemeral),
	);

	mockResponses.push("Hello from ephemeral.");
	send({ type: "prompt", text: "hi" });
	await waitFor(() => hasReply("ephemeral"), "assistant reply");
	check("临时对话能正常跑一轮（mock 模型有回复）", hasReply("ephemeral"));

	await sleep(600);
	check(
		"临时对话不产生 .jsonl 会话文件",
		countSessionFiles() === beforeFiles,
		`${beforeFiles} → ${countSessionFiles()}`,
	);

	await waitFor(() => conversations.some((c) => c.id === ephId), "ephemeral in running list");
	const ephRow = conversations.find((c) => c.id === ephId);
	check("临时对话出现在「运行的对话」并带 isEphemeral 标记", ephRow?.isEphemeral === true, JSON.stringify(ephRow));
	check("临时对话行没有 sessionFile", !ephRow?.sessionFile, String(ephRow?.sessionFile));

	await waitFor(() => snapshot?.isStreaming === false, "ephemeral idle");
	for (let i = 0; i < 2; i++) {
		send({ type: "new_chat" });
		await waitFor(() => snapshot?.conversationId !== ephId, "switch away from ephemeral");
		check(
			`切走后临时对话仍在运行列表（第 ${i + 1} 次）`,
			conversations.some((c) => c.id === ephId && c.isEphemeral),
		);
		send({ type: "switch_conversation", id: ephId });
		await waitFor(() => snapshot?.conversationId === ephId && hasReply("ephemeral"), "ephemeral restored");
		check(`切回后临时对话内容仍在（第 ${i + 1} 次）`, hasReply("ephemeral"));
	}
	check("切换保留不会偷偷落盘", countSessionFiles() === beforeFiles);

	send({ type: "persist_conversation", id: ephId });
	await waitFor(() => {
		const row = conversations.find((c) => c.id === ephId);
		return Boolean(row && !row.isEphemeral && row.sessionFile);
	}, "ephemeral promoted");
	const promoted = conversations.find((c) => c.id === ephId);
	check("转正后 isEphemeral 标记消失", promoted?.isEphemeral !== true, JSON.stringify(promoted));
	check(
		"转正后快照 isEphemeral 翻成 false（增量合并不残留）",
		snapshot.isEphemeral === false,
		String(snapshot.isEphemeral),
	);
	check("转正后拿到 sessionFile", Boolean(promoted?.sessionFile), String(promoted?.sessionFile));
	check(
		"转正后 .jsonl 真的落盘",
		Boolean(promoted?.sessionFile) && existsSync(promoted.sessionFile),
		String(promoted?.sessionFile),
	);
	check("转正后会话 id 不变（对话内容原地保留）", promoted?.id === ephId);
	check(
		"转正有明确提示",
		notices.some((n) => n.includes("正式对话") || n.includes("历史")),
		notices.join(" | "),
	);

	const beforeNormal = countSessionFiles();
	send({ type: "new_chat" });
	await waitFor(() => snapshot?.conversationId !== ephId, "normal new chat");
	const normalId = snapshot.conversationId;
	check("普通 new_chat 建出另一个对话", Boolean(normalId) && normalId !== ephId, `${ephId} → ${normalId}`);
	mockResponses.push("Normal reply.");
	send({ type: "prompt", text: "hi" });
	await waitFor(() => hasReply("Normal"), "normal assistant reply");
	await waitFor(() => countSessionFiles() > beforeNormal, "normal session file", 8000);
	check(
		"普通新对话会落盘（对照组，证明临时对话的不落盘断言有意义）",
		countSessionFiles() > beforeNormal,
		`${beforeNormal} → ${countSessionFiles()}`,
	);
	check("普通新对话不带 isEphemeral 标记", conversations.find((c) => c.id === normalId)?.isEphemeral !== true);
} catch (e) {
	console.error("TEST ERROR", e);
	failures++;
} finally {
	await cleanup();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
