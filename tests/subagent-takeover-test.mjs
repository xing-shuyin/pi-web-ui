import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";

const repoRoot = realpathSync(new URL("../", import.meta.url));
ensureBuild(repoRoot, "subagent-takeover-test");

const PORT = Number(process.argv[2] || 8997);
const MOCK_PORT = PORT + 1;
freePort(PORT);
freePort(MOCK_PORT);
const base = mkdtempSync(join(tmpdir(), "pi-web-subtake-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const dir of [workdir, dataDir, agentDir]) mkdirSync(dir, { recursive: true });

const MODEL_ID = "subtake-mock";
const EVENT_LOG = join(base, "events.log");
const WAIT_LOG = join(base, "waits.log");
const ev = (e) => appendFileSync(EVENT_LOG, `${Date.now()}\t${e}\n`);
const wl = (e) => appendFileSync(WAIT_LOG, `${Date.now()}\t${e}\n`);
const readLines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);

const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
};
const delta = (model, d, finish = null) => ({
	id: "subtake-mock",
	object: "chat.completion.chunk",
	created: Date.now(),
	model,
	choices: [{ index: 0, delta: d, finish_reason: finish }],
});
const streamed = (res, payload, prefix, count, stepMs, endEvent) => {
	ev(endEvent ? `${endEvent}_START` : "CHILD_START");
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const chunks = [];
	for (let i = 1; i <= count; i++) chunks.push(delta(payload.model, { content: `${prefix}${i} ` }));
	let i = 0;
	const timer = setInterval(() => {
		if (i < chunks.length) {
			res.write(`data: ${JSON.stringify(chunks[i++])}\n\n`);
		} else {
			clearInterval(timer);
			res.write(`data: ${JSON.stringify(delta(payload.model, {}, "stop"))}\n\n`);
			res.write("data: [DONE]\n\n");
			res.end();
			ev(endEvent ? `${endEvent}_END` : "CHILD_END");
		}
	}, stepMs);
};

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
	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	const lastUserText = (() => {
		const c = lastUser?.content;
		if (typeof c === "string") return c;
		if (Array.isArray(c)) return c.map((p) => (p && typeof p.text === "string" ? p.text : "")).join(" ");
		return String(c ?? "");
	})();
	const isB = lastUserText.includes("B_START");
	const isChild1 = lastUserText.startsWith("CHILD_SLOW");
	const isChild2 = lastUserText.startsWith("CHILD_FAST");
	const isMain = !isB && !isChild1 && !isChild2;
	if (isB) {
		sse(res, [delta(payload.model, { content: "B_OK" }), delta(payload.model, {}, "stop")]);
		return;
	}
	if (isChild1) {
		streamed(res, payload, "S", 18, 350, "CHILD1");
		return;
	}
	if (isChild2) {
		streamed(res, payload, "F", 4, 250, "CHILD2");
		return;
	}
	if (toolMsgs.length > 0) {
		const content = String(toolMsgs[toolMsgs.length - 1].content ?? "");
		if (/收口|collected/.test(content)) wl(content.replace(/\s+/g, " ").slice(0, 400));
	}

	const subcall = (action, args = {}) => [
		delta(payload.model, {
			tool_calls: [
				{
					index: 0,
					id: `call_${toolMsgs.length}_${action}`,
					type: "function",
					function: { name: "subagent", arguments: JSON.stringify({ action, ...args }) },
				},
			],
		}),
		delta(payload.model, {}, "tool_calls"),
	];
	if (toolMsgs.length === 0) {
		sse(res, subcall("spawn", { prompt: "CHILD_SLOW", type: "probe" }));
		return;
	}
	if (toolMsgs.length === 1) {
		sse(res, subcall("wait_all"));
		return;
	}
	if (toolMsgs.length === 2) {
		sse(res, subcall("spawn", { prompt: "CHILD_FAST", type: "probe" }));
		return;
	}
	if (toolMsgs.length === 3) {
		sse(res, subcall("wait_all"));
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
	stdio: ["ignore", "pipe", "pipe"],
});
server.stdout?.on("data", (d) => process.stdout.write("[srv] " + d.toString()));
server.stderr?.on("data", (d) => process.stderr.write("[srv-err] " + d.toString()));
server.on("exit", (code, signal) => console.error(`[srv] exited code=${code} signal=${signal}`));

const waitForPort = async (port, timeout = 120000) => {
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
				this.messages = [...this.messages, ...(message.appended ?? [])];
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
		throw new Error(`[${this.name}] timeout waiting for ${type}`);
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
const waitRow = async (c, pred, what, timeout = 20000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const row = c.conversations.find(pred);
		if (row) return row;
		await sleep(100);
	}
	throw new Error(`[${c.name}] timeout waiting for row: ${what}; rows=${JSON.stringify(c.conversations)}`);
};
const waitLines = async (f, pred, what, timeout = 60000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const lines = readLines(f);
		if (pred(lines)) return lines;
		await sleep(120);
	}
	throw new Error(`timeout waiting for ${what}`);
};
const tsOf = (lines, event) => {
	const line = lines.find((l) => l.includes(`\t${event}`));
	return line ? Number(line.split("\t")[0]) : undefined;
};

try {
	await waitForPort(PORT);

	const openClient = async (clientId, withModel = true) => {
		let ws = null;
		for (let attempt = 0; attempt < 10 && !ws; attempt++) {
			ws = await new Promise((resolve) => {
				const s = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
				s.once("open", () => resolve(s));
				s.once("error", () => {
					s.close();
					resolve(null);
				});
			});
			if (!ws) await sleep(500);
		}
		if (!ws) throw new Error(`[${clientId}] ws connect failed on ${PORT}`);
		const c = new Client(ws, clientId);
		c.send({ type: "hello", clientId, locale: "zh" });
		await c.waitForType("ready");
		c.send({ type: "get_state" });
		await c.waitForState((s) => Boolean(s.conversationId));
		if (withModel) {
			c.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
			await c.waitForState((s) => s.model?.id === MODEL_ID);
		}
		return c;
	};

	clientB = await openClient("subtake-B", true);
	clientB.send({ type: "prompt", text: "B_START" });
	check(
		"B 先有自己的对话（撞号前提）",
		Boolean(await waitRow(clientB, (c) => !c.isSubagent && c.messageCount > 0, "B own conv")),
	);

	clientA = await openClient("subtake-A", true);
	clientA.send({ type: "prompt", text: "SPAWN_AND_WAIT" });
	const mainA = (await waitRow(clientA, (c) => !c.isSubagent && c.title.includes("SPAWN"), "A main")).id;

	await waitLines(EVENT_LOG, (ls) => ls.some((l) => l.includes("CHILD1_START")), "CHILD1 start", 40000);
	check(
		"A 能看到自己 spawn 的子代理（过户前就在左栏）",
		Boolean(await waitRow(clientA, (c) => c.isSubagent && c.title.includes("CHILD_SLOW"), "A child1")),
	);
	await sleep(1200);

	clientB.send({ type: "take_over_conversation", owner: "subtake-A", id: mainA });

	const movedOnB = await waitRow(
		clientB,
		(c) => !c.isSubagent && c.title.includes("SPAWN") && c.messageCount > 0,
		"moved main on B",
	);
	check("过户后主对话在 B（撞号改名，id !== c1）", movedOnB && movedOnB.id !== "c1", `id=${movedOnB?.id}`);
	check(
		"搬走的子代理随主对话一起在 B（还在跑）",
		Boolean(await waitRow(clientB, (c) => c.isSubagent && c.title.includes("CHILD_SLOW"), "child1 on B")),
	);
	check("过户时子代理仍在运行（没被中止，只是搬走）", !readLines(EVENT_LOG).some((l) => l.includes("CHILD1_END")));

	await waitLines(WAIT_LOG, (ls) => ls.length >= 2, "two wait_all results", 90000);
	await waitLines(
		EVENT_LOG,
		(ls) => ls.some((l) => l.includes("CHILD1_END")) && ls.some((l) => l.includes("CHILD2_END")),
		"both children ended",
		90000,
	);
	await sleep(1000);

	const waitLines_now = readLines(WAIT_LOG);
	const r1 = waitLines_now[0];
	const r2 = waitLines_now[1];
	const NAMES_SUBAGENT = /(?:exec|sa|conv)-[0-9a-z]+/i;
	const c1EndTs = tsOf(readLines(EVENT_LOG), "CHILD1_END");
	const r1Ts = r1 ? Number(r1.split("\t")[0]) : 0;

	check(
		"wait_all#1 不把搬走的子代理误判成已移出（无『已移出/不存在』且含子代理 id）",
		Boolean(r1 && NAMES_SUBAGENT.test(r1) && !/已移出|不存在/.test(r1) && /收口|collected/.test(r1)),
		r1 ? r1.slice(0, 200) : "(no r1)",
	);
	check(
		"wait_all#1 等到子代理真的结束才返回（时序：结果晚于 CHILD_SLOW 结束）",
		Number.isFinite(c1EndTs) && r1Ts >= c1EndTs - 1600,
		`r1Ts=${r1Ts} c1EndTs=${c1EndTs}`,
	);
	check(
		"过户后的无参 wait_all#2 跨会话看到新子代理并收口（不是『没有需要等待』）",
		Boolean(r2 && NAMES_SUBAGENT.test(r2) && !/没有需要等待|已移出|不存在/.test(r2) && /收口|collected/.test(r2)),
		r2 ? r2.slice(0, 200) : "(no r2)",
	);

	check(
		"过户后新 spawn 的子代理归持有方（B 左栏可见）",
		Boolean(await waitRow(clientB, (c) => c.isSubagent && c.title.includes("CHILD_FAST"), "child2 on B")),
	);
	check(
		"源页 A 看不到过户后 spawn 的新子代理",
		!clientA.conversations.some((c) => c.isSubagent && c.title.includes("CHILD_FAST")),
		JSON.stringify(clientA.conversations.map((c) => c.title)),
	);
	check(
		"跑完的子代理在 B 侧呈现收口态",
		Boolean(
			await waitRow(
				clientB,
				(c) => c.isSubagent && c.title.includes("CHILD_SLOW") && !c.isStreaming,
				"child1 done on B",
			),
		),
	);
	check(
		"A 已无被搬走的对话（源会话修好 active）",
		!clientA.conversations.some((c) => c.title.includes("SPAWN")),
		JSON.stringify(clientA.conversations.map((c) => `#${c.id}:${c.title}`)),
	);
} catch (error) {
	console.error("✗ 异常:", error instanceof Error ? error.message : error);
	failures++;
} finally {
	try {
		clientA?.ws.close();
		clientB?.ws.close();
	} catch {}
	server.kill();
	mock.close();
	await sleep(300);
	freePort(PORT);
	freePort(MOCK_PORT);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
