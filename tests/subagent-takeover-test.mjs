// subagent-takeover — 过户 + 子代理工具族回归（B20，零 token）。
//
// 场景（用户实机 2026-10-13 报告，两条症状是同一根因）：
//   A 的主题对话 wait_all 等子代理时，B（另一个浏览器/客户端）过户该对话 ——
//   过去 subagent 工具的 host 是建 runtime 时闭包的 ClientSession，过户把对话
//   （含子代理后代）整体搬去 B 的会话，搬不动闭包 ⇒ 源会话里再也查不到子代理：
//     · wait_all 把「查不到」当「已移出=终态」，首轮轮询即 break，误报全部收口
//       （子代理其实还在跑）；
//     · get_result/steer/stop/list 全部 not found；
//     · 过户后再 spawn 的新子代理注册进源会话 ⇒ 目标页左栏「不见/错位」。
//
// 本测试（mock 模型按消息内容编排，零 token）：
//   1. B 先开一条自己的对话（撞 c1，逼出 insert 的名改路径）；
//   2. A 的对话经 mock 依次：spawn 慢流子代理 CHILD_SLOW（占住 wait_all）→
//      无参 wait_all（阻塞中）→ 此时 B 过户 A 的主对话；
//   3. 断言 wait_all#1 不提前返回、不含「已移出/不存在」、等到 CHILD_SLOW 真结束；
//   4. 过户后主对话继续（仍在同一 SDK 会话）：再 spawn CHILD_FAST → 无参 wait_all#2
//      —— 必须能跨会话看到新子代理并收口（而不是「没有需要等待的子代理」）；
//   5. CHILD_FAST 必须注册到持有方 B 的会话（B 左栏可见、A 看不到）；
//   6. 撞号改名：B 已有 c1，搬入的主对话改名（id !== c1），子代理 parentId 随之
//      改写，wait_all 的自省 id 也要按改名后解析（findConversationHome 现查）。
//
// Usage: npm run build && node tests/subagent-takeover-test.mjs [port]

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
const EVENT_LOG = join(base, "events.log"); // 假模型的时序事件（子代理起止）
const WAIT_LOG = join(base, "waits.log"); // 假模型经工具结果看到的 wait_all 文本
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
/** 慢速/快速流：子代理在跑期间把「根本没被 abort、只是被搬走」演出来。 */
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
			// 补一个 stop finish：否则 SDK 视流被截断会重试同一请求，子代理永远「跑不完」。
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
	// 会话身份按「最后一条 user 消息」判定（主对话的工具结果文本会回显子代理
	// 的 prompt/标题，按全文 includes 会把主对话的下一次请求误判成子代理请求）。
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
	// B 的普通对话：快速打住（给 B 一枚自己的 c1，与 A 撞号）。
	if (isB) {
		sse(res, [delta(payload.model, { content: "B_OK" }), delta(payload.model, {}, "stop")]);
		return;
	}
	// 子代理 CHILD_SLOW：慢流 ≈7s（占住主对话的 wait_all 直到过户完成之后才结束）。
	if (isChild1) {
		streamed(res, payload, "S", 18, 350, "CHILD1");
		return;
	}
	// 子代理 CHILD_FAST：快流 ≈1s。
	if (isChild2) {
		streamed(res, payload, "F", 4, 250, "CHILD2");
		return;
	}
	// 主对话（isMain）：把 wait_all 的工具结果落到日志（断言素材），再按已执行工具数编排。
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
		// 工具延迟加载默认开，这里按部署默认关掉它（subagent 工具必须活跃）。
		PI_WEB_TOOL_LAZY_LOADING: "0",
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
		// 显式清空：测试必须与 ambient shell 的 PI_WEB_TOKEN 无关。
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
		} catch {
			/* starting */
		}
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
		// http 的 /api/health 就绪后 ws 端点可能还差一拍（启动尾序），重试连接。
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

	// B 先开一条自己的对话（首对话撞号 c1，逼出 insert 改名 + 别名解析路径）。
	clientB = await openClient("subtake-B", true);
	clientB.send({ type: "prompt", text: "B_START" });
	check(
		"B 先有自己的对话（撞号前提）",
		Boolean(await waitRow(clientB, (c) => !c.isSubagent && c.messageCount > 0, "B own conv")),
	);

	// A 的主对话跑「spawn 慢流子代理 → wait_all」。
	clientA = await openClient("subtake-A", true);
	clientA.send({ type: "prompt", text: "SPAWN_AND_WAIT" });
	const mainA = (await waitRow(clientA, (c) => !c.isSubagent && c.title.includes("SPAWN"), "A main")).id;

	// 子代理 1 开跑（慢流），主对话的 wait_all 已阻塞在它上面。
	await waitLines(EVENT_LOG, (ls) => ls.some((l) => l.includes("CHILD1_START")), "CHILD1 start", 40000);
	check(
		"A 能看到自己 spawn 的子代理（过户前就在左栏）",
		Boolean(await waitRow(clientA, (c) => c.isSubagent && c.title.includes("CHILD_SLOW"), "A child1")),
	);
	await sleep(1200); // 让 wait_all 工具真的挂起

	// B 过户 A 的主对话（此时 A 里 wait_all 正在等 CHILD_SLOW）。
	clientB.send({ type: "take_over_conversation", owner: "subtake-A", id: mainA });

	// 过户落地：主对话出现在 B 侧并改名（B 已有 c1 ⇒ 撞号 → c2）。
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
	// CHILD_SLOW 还没结束（过户耗时 ≪ 慢流总时长）⇒ 子代理确实「没被 abort」。
	check("过户时子代理仍在运行（没被中止，只是搬走）", !readLines(EVENT_LOG).some((l) => l.includes("CHILD1_END")));

	// 等到全部流程走完：两次 wait_all 结果都已落入日志，两个子代理都结束。
	await waitLines(WAIT_LOG, (ls) => ls.length >= 2, "two wait_all results", 90000);
	await waitLines(
		EVENT_LOG,
		(ls) => ls.some((l) => l.includes("CHILD1_END")) && ls.some((l) => l.includes("CHILD2_END")),
		"both children ended",
		90000,
	);
	await sleep(1000); // 让 conversations 推送落定

	const waitLines_now = readLines(WAIT_LOG);
	const r1 = waitLines_now[0];
	const r2 = waitLines_now[1];
	// wait_all 回执指名子代理用的是 **runtime 身份**（`exec-<uuid>`，见
	// server/conversation-identity.ts）；`sa-…` / `conv-…` 是显示 id，只在 UI 侧。
	// 断言只要求「指名了某个子代理」——锁死前缀会被一次身份格式调整打红（历史如此）。
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

	// 过户后再 spawn 的子代理：注册到持有方 B（B 左栏可见），A 看不到。
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
	} catch {
		/* ignore */
	}
	server.kill();
	mock.close();
	await sleep(300);
	freePort(PORT);
	freePort(MOCK_PORT);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
