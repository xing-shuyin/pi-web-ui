// issue #291 回归（零 token）：elsewhere（「另一处」）列表的生命周期缺陷。
//
// 1) 断连残骸不入列表：客户端 A 用随机 clientId attach 并发一次 prompt（产生对话），
//    断开 socket 后，另一个客户端 B 的 elsewhere 里不应再有 A 的行（修复前会永久留着）。
//    含正向对照：A 在线时 B 必须能看到那一行（证明测试真的在读这张列表）。
// 2) 删除定时任务回收伪客户端：建一个任务并 schedule_run 一次（产生 `scheduler:<id>`
//    伪客户端 + 一条对话）→ B 的 elsewhere 有该行；schedule_delete 后该行应消失。
// 3) 断线但仍在跑的会话必须留住 elsewhere 行：客户端 C 用慢速 mock 起一支长跑 run，
//    流式中断开 socket。该对话在别的标签页打不开（#145 守卫只认 isStreaming、不看对方
//    在不在线），而「另一处」行是它唯一的收场入口（过户 / 抢答问卷）⇒ 断连残骸可以藏
//    空闲行，但绝不能藏正在跑的行（#291 的过滤漏掉的正是这一半）。
//
// 断言口：conversations 消息里的 elsewhere 数组（owner 字段标识持有方）。
// Usage: npm run build && node tests/elsewhere-lifecycle-test.mjs [port]
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.argv[2] || 8981);
const MOCK_PORT = PORT + 1;
freePort(PORT);
freePort(MOCK_PORT);

const base = mkdtempSync(join(tmpdir(), "pi-web-elsewhere-lifecycle-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const MODEL_ID = "elsewhere-lifecycle-mock";
const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
};
const delta = (model, d, finish = null) => ({
	id: MODEL_ID,
	object: "chat.completion.chunk",
	created: Date.now(),
	model,
	choices: [{ index: 0, delta: d, finish_reason: finish }],
});
// mock：直接回文本并结束（run 结束后对话仍被持有方留着 = 空闲 elsewhere 行）。
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
	if (String(body).includes("慢速流式")) {
		// 长跑分支（按提问文本区分）：分块间隔 800ms、总时长 ~24s，留出「流式中断线」的窗口。
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		res.write(`data: ${JSON.stringify(delta(payload.model, { content: "SLOW-0 " }))}\n\n`);
		for (let i = 1; i <= 30; i++) {
			await sleep(800);
			if (res.destroyed || res.writableEnded) return;
			res.write(`data: ${JSON.stringify(delta(payload.model, { content: `SLOW-${i} ` }))}\n\n`);
		}
		res.write("data: [DONE]\n\n");
		res.end();
		return;
	}
	sse(res, [delta(payload.model, { content: "ELSEWHERE-OK" }), delta(payload.model, {}, "stop")]);
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify(
		{
			providers: {
				mock: {
					name: "Mock",
					api: "openai-completions",
					baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
					apiKey: "sk-mock",
					models: [{ id: MODEL_ID, name: "Mock" }],
				},
			},
		},
		null,
		2,
	),
);

const server = spawn(process.execPath, [join(realpathSync("."), "dist", "server", "index.js")], {
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_HOST: "127.0.0.1",
		PI_WEB_CWD: workdir,
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		// 显式清空：测试必须与 ambient shell 的 PI_WEB_TOKEN 无关。
		PI_WEB_TOKEN: "",
		PI_WEB_PLUGIN_CATALOG_URL: "",
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});

let serverOut = "";
server.stdout.on("data", (d) => (serverOut += String(d)));
server.stderr.on("data", (d) => (serverOut += String(d)));

const cleanup = () => {
	try {
		clientB?.ws.close();
		clientC?.ws.close();
	} catch {
		/* ignore */
	}
	try {
		server.kill();
	} catch {
		/* ignore */
	}
	try {
		mock.close();
	} catch {
		/* ignore */
	}
};

class Client {
	constructor(ws, name) {
		this.ws = ws;
		this.name = name;
		this.received = [];
		this.state = null;
		this.conversations = [];
		this.elsewhere = [];
		this.convSeq = 0;
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "snapshot") this.state = message.state;
			else if (message.type === "conversations") {
				this.conversations = message.conversations ?? [];
				this.elsewhere = message.elsewhere ?? [];
				this.convSeq += 1;
			}
		});
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	async waitForType(type, predicate = () => true, timeout = 30000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const m = this.received[i];
				if (m.type !== type || !predicate(m)) continue;
				this.received.splice(i, 1);
				return m;
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
}

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

/** 等 elsewhere 出现/消失某 owner 的行（conversations 推送驱动）。 */
const waitElsewhere = async (c, pred, what, timeout = 15000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const row = c.elsewhere.find(pred);
		if (row) return row;
		await sleep(100);
	}
	throw new Error(`[${c.name}] timeout waiting for elsewhere row: ${what}`);
};
const waitElsewhereGone = async (c, pred, what, timeout = 15000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		if (!c.elsewhere.some(pred)) return true;
		await sleep(100);
	}
	return false;
};
/** 等 elsewhere 出现某行；超时回 null（不抛 —— 让断言如实报红，后面的场景照跑）。 */
const elsewhereRowOrNull = async (c, pred, timeout = 12000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const row = c.elsewhere.find(pred);
		if (row) return row;
		await sleep(100);
	}
	return null;
};

/** 等该客户端自己的 conversations 里出现流式对话（快照的 state.isStreaming 在真的流式中也可能为 false，不能拿它判定）。 */
const waitConvStreaming = async (c, timeout = 30000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		if (c.conversations.some((x) => x.isStreaming)) return true;
		await sleep(100);
	}
	return false;
};

/** 等该客户端收到新的一帧 conversations（seq 前进）—— 确认服务端已经处理了某个状态变化。 */
const waitConversationsAfter = async (c, seq, timeout = 15000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		if (c.convSeq > seq) return true;
		await sleep(100);
	}
	return false;
};

let clientA;
let clientB;
let clientC;
try {
	// 等健康检查
	for (let i = 0; i < 160; i++) {
		try {
			const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
			if (r.ok) break;
		} catch {
			/* not up yet */
		}
		await sleep(250);
		if (i === 159) throw new Error("server did not come up");
	}

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
		await c.waitForState((s) => Boolean(s), 20000);
		if (withModel) {
			c.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
			await c.waitForState((s) => s.model?.id === MODEL_ID);
		}
		return c;
	};

	// B：先上线的观察者（有 sink → 其他客户端的对话在它这里是 elsewhere 行）。
	clientB = await openClient("observer-b");

	// --- 场景 1：断连残骸不入 elsewhere ---
	const deadId = "probe-dead-1790000000000";
	clientA = await openClient(deadId);
	clientA.send({ type: "prompt", text: "残骸测试：只回复 OK" });
	await clientA.waitForState((s) => s.isStreaming === true, 20000).catch(() => {});
	// 正向对照：A 在线时，B 必须能看到 A 的行。
	const liveRow = await waitElsewhere(clientB, (w) => w.owner === deadId, "A live row");
	check("A 在线时 B 能看到其 elsewhere 行（正向对照）", !!liveRow, `owner=${liveRow.owner}`);
	check("普通客户端 elsewhere 条目 pseudo 为 false/undefined（#426）", !liveRow.pseudo);
	await clientA.waitForState((s) => s.isStreaming === false, 30000).catch(() => {});

	// 断开 A（不 detach 回收 → 模拟「关浏览器留下的残骸」）。
	clientA.ws.close();
	const gone = await waitElsewhereGone(clientB, (w) => w.owner === deadId, "A row gone");
	check(
		"A 断连后其行从 B 的 elsewhere 消失（#291 修复点）",
		gone,
		`elsewhere=${JSON.stringify(clientB.elsewhere.map((w) => w.owner))}`,
	);

	// --- 场景 3：断线但仍在跑的会话必须留住 elsewhere 行（唯一收场入口）---
	// #145 的守卫只按 isStreaming 拒绝打开/发送/删除，不看对方在不在线；#291 的过滤
	// （sinkCount===0 整条客户端跳过）把这支孤儿连行一起藏掉 ⇒ 用户看不到、开不了、删不掉。
	const orphanId = "probe-orphan-1790000000001";
	clientC = await openClient(orphanId);
	clientC.send({ type: "prompt", text: "慢速流式：断线后仍在跑" });
	const slowStarted = await waitConvStreaming(clientC, 30000);
	check(
		"C 的长跑 run 已起跑（正向对照；mock 按提问文本走慢速流）",
		slowStarted,
		`convs=${JSON.stringify(clientC.conversations.map((x) => ({ id: x.id, isStreaming: x.isStreaming })))}`,
	);
	const liveSlowRow = await elsewhereRowOrNull(clientB, (w) => w.owner === orphanId);
	check("C 在线时 B 能看到其 elsewhere 行（正向对照）", !!liveSlowRow, `owner=${liveSlowRow?.owner ?? "-"}`);

	// 流式中断开 C：run 继续跑（这就是「断线孤儿」—— 持有者不在线，但它还在写转录）。
	// 断线后先等一帧「服务端已处理该断连」的重推（detach 摘掉最后一个 sink 时会 poke）——
	// 否则读到的是断连前那一帧（行还在），断言会假绿。
	const seqBeforeClose = clientB.convSeq;
	clientC.ws.close();
	const refreshed = await waitConversationsAfter(clientB, seqBeforeClose, 15000);
	const orphanRow = clientB.elsewhere.find((w) => w.owner === orphanId) ?? null;
	check(
		"断线但仍在跑的会话仍留在 elsewhere（否则守卫拒绝打开时用户无路可走）",
		!!orphanRow,
		`refreshed=${refreshed} elsewhere=${JSON.stringify(clientB.elsewhere.map((w) => ({ owner: w.owner, isStreaming: w.isStreaming })))}`,
	);
	if (orphanRow) {
		check("断线孤儿行仍标记 isStreaming:true", orphanRow.isStreaming === true);
		check(
			"断线孤儿行带过户目标 owner/convId",
			Boolean(orphanRow.owner && orphanRow.convId),
			`convId=${orphanRow.convId}`,
		);
		// 出路：对断线孤儿执行过户（搬 runtime 本体，单 writer 不变）。
		clientB.send({ type: "take_over_conversation", owner: orphanRow.owner, id: orphanRow.convId });
		const takeoverNotice = await clientB.waitForType(
			"notice",
			(m) => m.text?.includes("已将") || m.text?.includes("过户失败"),
			20000,
		);
		check("可对断线孤儿执行过户（收场出路真的可用）", takeoverNotice.text.includes("已将"), takeoverNotice.text);
		const movedStreaming = await waitConvStreaming(clientB, 15000);
		check(
			"过户后 B 侧就能看到这条运行中的对话（出路真能收尾）",
			movedStreaming,
			`convs=${JSON.stringify(clientB.conversations.map((x) => ({ id: x.id, isStreaming: x.isStreaming })))}`,
		);
	} else {
		check("可对断线孤儿执行过户（行被藏掉 ⇒ 无从发起）", false);
	}

	// --- 场景 2：删除定时任务回收伪客户端 ---
	const taskId = "task-lifecycle-291";
	clientB.send({
		type: "schedule_save",
		task: {
			id: taskId,
			name: "生命周期测试",
			kind: "cron",
			spec: "0 0 1 1 *",
			prompt: "hi",
			cwd: workdir,
			enabled: false,
			catchUp: "skip",
		},
	});
	await clientB.waitForType("scheduler_tasks", (m) => (m.tasks ?? []).some((t) => t.id === taskId), 15000);

	clientB.send({ type: "schedule_run", id: taskId });
	// 正向对照：伪客户端跑起来后应出现在 elsewhere。
	const schedRow = await waitElsewhere(clientB, (w) => w.owner === `scheduler:${taskId}`, "scheduler row", 30000);
	check("定时任务伪客户端出现在 elsewhere（正向对照）", !!schedRow, `owner=${schedRow.owner}`);
	check("定时任务伪客户端 elsewhere 条目标记为 pseudo（#426）", schedRow.pseudo === true);

	// #426：尝试请求过户伪客户端会话，应被拒并提示引导去处
	clientB.send({ type: "take_over_conversation", owner: schedRow.owner, id: schedRow.convId });
	const rejectNotice = await clientB.waitForType(
		"notice",
		(m) => m.text?.includes("定时任务/插件会话不支持过户"),
		10000,
	);
	check("请求过户伪客户端时被拒并给出后台任务引导（#426）", rejectNotice.text.includes("后台任务面板"));

	// 删除任务 → 伪客户端应被回收。
	clientB.send({ type: "schedule_delete", id: taskId });
	const schedGone = await waitElsewhereGone(
		clientB,
		(w) => w.owner === `scheduler:${taskId}`,
		"scheduler row gone",
		20000,
	);
	check(
		"删除定时任务后伪客户端从 elsewhere 消失（#291 修复点）",
		schedGone,
		`elsewhere=${JSON.stringify(clientB.elsewhere.map((w) => w.owner))}`,
	);
} catch (err) {
	console.error(`\nFAIL: ${err.message}`);
	console.error("--- server output ---\n" + serverOut.slice(-4000));
	cleanup();
	process.exit(1);
}

cleanup();
if (failures > 0) {
	console.error("--- server output ---\n" + serverOut.slice(-3000));
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nPASS: elsewhere 生命周期（#291）");
process.exit(0);
