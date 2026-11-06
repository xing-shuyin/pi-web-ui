import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";

const repoRoot = realpathSync(new URL("../", import.meta.url));
ensureBuild(repoRoot, "takeover-test");

const PORT = Number(process.argv[2] || 8987);
const MOCK_PORT = PORT + 1;
freePort(PORT);
freePort(MOCK_PORT);
const base = mkdtempSync(join(tmpdir(), "pi-web-takeover-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const MODEL_ID = "takeover-mock";
const QUESTIONS = [
	{
		id: "scope",
		header: "范围",
		question: "要做到什么程度？",
		options: [{ label: "最小可用" }, { label: "完整实现" }],
	},
	{
		id: "note",
		header: "补充",
		question: "还有什么要交代的？",
	},
];

const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
};
const delta = (model, d, finish = null) => ({
	id: "takeover-mock",
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
	const toolMsgs = messages.filter((m) => m.role === "tool");
	const askCall = (payload, callId) => [
		delta(payload.model, {
			tool_calls: [
				{
					index: 0,
					id: callId,
					type: "function",
					function: { name: "ask_user_question", arguments: JSON.stringify({ questions: QUESTIONS }) },
				},
			],
		}),
		delta(payload.model, {}, "tool_calls"),
	];
	const pageCall = (payload) => [
		delta(payload.model, {
			tool_calls: [
				{
					index: 0,
					id: "call_page_1",
					type: "function",
					function: { name: "browser_page", arguments: JSON.stringify({ op: "read", what: "title" }) },
				},
			],
		}),
		delta(payload.model, {}, "tool_calls"),
	];
	if (toolMsgs.length === 0) {
		if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
			sse(res, [delta(payload.model, { content: "ok" }), delta(payload.model, {}, "stop")]);
			return;
		}
		sse(res, askCall(payload, "call_ask_1"));
		return;
	}
	if (toolMsgs.length === 1) {
		sse(res, askCall(payload, "call_ask_2"));
		return;
	}
	if (toolMsgs.length === 2) {
		sse(res, pageCall(payload));
		return;
	}
	sse(res, [
		delta(payload.model, {
			content: `ANSWERED:${toolMsgs.map((m) => String(m.content ?? "")).join(" | ")}`,
		}),
		delta(payload.model, {}, "stop"),
	]);
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

const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: repoRoot,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_TOOL_LAZY_LOADING: "0",
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_TOKEN: "",
	},
	stdio: "ignore",
	windowsHide: true,
});

const waitForPort = async (port, timeout = 20000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/health`);
			if (response.ok) return;
		} catch {}
		await sleep(100);
	}
	throw new Error(`server did not start on ${port}`);
};

class Client {
	constructor(ws, name) {
		this.ws = ws;
		this.name = name;
		this.received = [];
		this.state = null;
		this.messages = [];
		this.conversations = [];
		this.elsewhere = [];
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
				this.elsewhere = message.elsewhere ?? [];
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
		throw new Error(
			`[${this.name}] timeout waiting for ${type}; conversation=${this.state?.conversationId}; pendingQuestion=${this.state?.pendingQuestion?.id}; notices=${JSON.stringify(this.notices())}`,
		);
	}
	async waitForState(predicate, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error(`[${this.name}] timeout waiting for state`);
	}
	notices() {
		return this.received.filter((m) => m.type === "notice");
	}
}

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

let clientA;
let clientB;
const waitRow = async (c, pred, what, timeout = 15000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const row = c.conversations.find(pred);
		if (row) return row;
		await sleep(100);
	}
	throw new Error(`[${c.name}] timeout waiting for row: ${what}`);
};
try {
	await waitForPort(PORT);

	const openClient = async (clientId, withModel = true) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		await new Promise((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		const c = new Client(ws, clientId);
		c.send({ type: "hello", clientId, locale: "zh" });
		await c.waitForType("ready");
		c.send({ type: "get_state" });
		await c.waitForState((s) => Boolean(s.conversationId));
		if (withModel) {
			c.send({ type: "set_settings", disabledAgentTools: [] });
			c.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
			await c.waitForState((s) => s.model?.id === MODEL_ID);
		}
		return c;
	};

	clientA = await openClient("takeover-A");
	clientA.send({ type: "prompt", text: "先问我几个问题" });
	const queueA = await clientA.waitForType(
		"question_queue",
		(m) => m.questions.some((q) => q.owner === "takeover-A" && q.audience === "user"),
		40000,
	);
	const pendingA = queueA.questions.find((q) => q.owner === "takeover-A" && q.audience === "user");
	check("A 问卷挂起", pendingA.questions?.length === 2, `id=${pendingA.id}`);
	await clientA.waitForState((s) => s.isStreaming === true, 15000);
	const convA = clientA.state.conversationId;
	const rowAq = await waitRow(clientA, (c) => c.id === convA && c.hasQuestion === true, "A row hasQuestion");
	check("运行列表标出等问卷（A 页自有行）", !!rowAq);

	clientB = await openClient("takeover-B", false);
	let row = null;
	{
		const started = Date.now();
		while (Date.now() - started < 15000) {
			row = clientB.elsewhere.find((w) => w.isStreaming);
			if (row?.owner && row?.convId) break;
			row = null;
			await sleep(100);
		}
	}
	check("B 的 elsewhere 行带 owner/convId", !!row, JSON.stringify(row ?? clientB.elsewhere));
	check("elsewhere 行标出等答复问卷", row?.hasQuestion === true, `hasQuestion=${row?.hasQuestion}`);
	check("elsewhere 指回 A 的对话", row?.convId === convA, `convId=${row?.convId} owner=${row?.owner}`);

	clientB.send({ type: "take_over_conversation", owner: row.owner, id: row.convId });
	const queueB = await clientB.waitForType(
		"question_queue",
		(m) => m.questions.some((q) => q.id === pendingA.id && q.owner === "takeover-B"),
		20000,
	);
	const pendingB = queueB.questions.find((q) => q.id === pendingA.id);
	check("问卷队列保留原请求并更新持有方 B", pendingB.questions?.[0]?.id === "scope", `id=${pendingB.id}`);
	{
		const started = Date.now();
		let cleared = false;
		while (Date.now() - started < 15000) {
			if (clientA.state?.pendingQuestion == null) {
				cleared = true;
				break;
			}
			await sleep(100);
		}
		check("A 页的问卷已搬走（不再挂起）", cleared);
	}
	await clientB.waitForState((s) => s.pendingQuestion?.id === pendingB.id, 15000);
	check("B 快照 pendingQuestion 就位（切过去了）", true);
	const rowB = await waitRow(
		clientB,
		(c) => !c.isSubagent && c.messageCount > 0 && c.hasQuestion === true,
		"B row hasQuestion",
	);
	check("B 运行列表里有搬过来的对话", !!rowB, `conv=${rowB?.id} streaming=${rowB?.isStreaming}`);
	check("过户把等问卷状态一起带过来", rowB?.hasQuestion === true);
	check("搬过来的 run 还在跑", rowB?.isStreaming === true);
	check("B 落在搬过来的对话上", clientB.state.conversationId === rowB?.id, clientB.state.conversationId);
	check("B 的 elsewhere 已清空", clientB.elsewhere.length === 0, JSON.stringify(clientB.elsewhere));
	check(
		"B 收到过户成功通知",
		clientB.notices().some((m) => (m.text ?? "").includes("过户到当前页面")),
	);
	{
		const started = Date.now();
		let gone = false;
		while (Date.now() - started < 15000) {
			if (!clientA.conversations.some((c) => c.id === convA)) {
				gone = true;
				break;
			}
			await sleep(100);
		}
		check("A 页该对话已消失", gone);
	}
	const movedQueueA = await clientA.waitForType(
		"question_queue",
		(m) => m.questions.some((q) => q.id === pendingA.id && q.owner === "takeover-B"),
		15000,
	);
	check("A 项目队列同步问卷的新持有方", movedQueueA.questions.filter((q) => q.id === pendingA.id).length === 1);
	check(
		"A 收到去向通知",
		clientA.notices().some((m) => (m.text ?? "").includes("过户到另一处")),
	);
	check("A 的会话没被搬空（active 自动修好）", !!clientA.state?.conversationId, clientA.state?.conversationId);

	clientB.send({
		type: "question_answer",
		id: pendingB.id,
		answers: [
			{ id: "scope", selected: ["完整实现"] },
			{ id: "note", selected: [], custom: "别动图标" },
		],
	});
	const queueB2 = await clientB.waitForType(
		"question_queue",
		(m) => m.questions.some((q) => q.id !== pendingB.id && q.owner === "takeover-B" && q.audience === "user"),
		30000,
	);
	const pendingB2 = queueB2.questions.find(
		(q) => q.id !== pendingB.id && q.owner === "takeover-B" && q.audience === "user",
	);
	check("过户后新问卷送达持有方 B", pendingB2.questions?.length === 2, `id=${pendingB2.id}`);
	await clientB.waitForState((s) => s.pendingQuestion?.id === pendingB2.id, 15000);
	check("过户后新问卷进 B 的快照（刷新/重连可恢复）", true);
	{
		await clientA.waitForType("question_queue", (m) =>
			m.questions.some((q) => q.id === pendingB2.id && q.owner === "takeover-B"),
		);
		check("新问卷没有挂到源页 A 当前对话", clientA.state?.pendingQuestion == null);
	}
	clientB.send({
		type: "question_answer",
		id: pendingB2.id,
		answers: [{ id: "scope", selected: ["完整实现"] }],
	});

	const pageReq = await clientB.waitForType("page_request", () => true, 30000);
	check("过户后 page_request 送达持有方 B", typeof pageReq.id === "string", `id=${pageReq.id} op=${pageReq.op}`);
	{
		await sleep(1500);
		const stray = clientA.received.find((m) => m.type === "page_request");
		check("page_request 没有误发给过户前的设备 A", !stray, stray ? `id=${stray.id}` : "无");
	}
	clientB.send({ type: "page_response", id: pageReq.id, ok: true, result: { title: "Mock page" } });

	{
		const started = Date.now();
		let echoed = "";
		while (Date.now() - started < 30000) {
			const texts = (clientB.messages ?? [])
				.filter((m) => m.role === "assistant")
				.flatMap((m) => m.content ?? [])
				.map((b) => b.text ?? "")
				.join("\n");
			if (texts.includes("ANSWERED:") && texts.includes("完整实现")) {
				echoed = texts;
				break;
			}
			await sleep(100);
		}
		check("B 答卷后模型收到答案并继续", echoed.includes("别动图标"), echoed.slice(-200));
	}
	{
		const started = Date.now();
		let cleared = false;
		while (Date.now() - started < 30000) {
			const r = clientB.conversations.find((c) => c.id === clientB.state?.conversationId);
			if (r && !r.hasQuestion) {
				cleared = true;
				break;
			}
			await sleep(100);
		}
		check("回答后等问卷角标消失", cleared);
	}

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
} catch (err) {
	failures++;
	console.error("💥", err.message ?? err);
} finally {
	clientA?.ws.close();
	clientB?.ws.close();
	server.kill();
	mock.close();
	await sleep(500);
	await freePort(PORT);
	await freePort(MOCK_PORT);
	process.exit(failures === 0 ? 0 : 1);
}
