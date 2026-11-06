import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const PORT = Number(process.argv[2] || 8940);
const MOCK_PORT = PORT + 2;
freePort(PORT);
freePort(MOCK_PORT);

const base = mkdtempSync(join(tmpdir(), "pi-web-gwiz-"));
const projDir = join(base, "proj");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const dir of [projDir, dataDir, agentDir]) mkdirSync(dir, { recursive: true });

const MODEL_ID = "mock-model";
const CLIENT_ID = "goal-wizard-switch-client";
const DRAFT = "写一个打开即用的文件去重小工具，支持目录递归与撤销";
let wizStep = 0;

const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
};
const delta = (model, d, finish = null) => ({
	id: "goal-wiz-mock",
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
	const hasGoalAsk = (payload.tools ?? []).some((t) => t?.function?.name === "goal_ask");

	if (hasGoalAsk) {
		wizStep += 1;
		const asked = messages.some((m) => m.role === "tool");
		if (!asked) {
			sse(res, [
				delta(payload.model, {
					tool_calls: [
						{
							index: 0,
							id: `call_ask_${wizStep}`,
							type: "function",
							function: {
								name: "goal_ask",
								arguments: JSON.stringify({
									question: `第 ${wizStep} 轮：要支持撤销吗？`,
									options: ["要", "不要"],
								}),
							},
						},
					],
				}),
				delta(payload.model, {}, "tool_calls"),
			]);
			return;
		}
		sse(res, [delta(payload.model, { content: `GOAL: 提炼后的目标 ${wizStep}` }), delta(payload.model, {}, "stop")]);
		return;
	}
	sse(res, [delta(payload.model, { content: "OK" }), delta(payload.model, {}, "stop")]);
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
		this.goal = null;
		this.goalHistory = [];
		this.conversations = [];
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
			if (message.type === "goal_status") {
				this.goalHistory.push(message.status);
				this.goal = message.status;
			} else if (message.type === "conversations") {
				this.conversations = message.conversations ?? [];
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
	async waitForState(predicate, timeout = 60000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error("timeout waiting for state");
	}
	static msgText(m) {
		const c = m?.content ?? m?.text ?? "";
		if (typeof c === "string") return c;
		if (Array.isArray(c)) return c.map((p) => p?.text ?? "").join("");
		return String(c);
	}
	wizardCards() {
		const msgs = this.state?.messages ?? [];
		return msgs.filter((m) => m.role === "custom" && m.customType === "goal-wizard");
	}
	goalNotices() {
		return this.seen("notice", (m) => /调研|Survey|目标/.test((m.text ?? "") + (m.textEn ?? "")));
	}
	async waitForNotice(re, timeout = 60000) {
		try {
			const m = await this.waitForType("notice", (n) => re.test((n.text ?? "") + (n.textEn ?? "")), timeout);
			return m;
		} catch {
			return null;
		}
	}
}

async function currentConvId(client, timeout = 15000) {
	client.received.length = 0;
	client.send({ type: "get_state" });
	const snap = await client.waitForType("snapshot", () => true, timeout);
	return snap?.state?.conversationId;
}

async function runWizardRound(client, draft, { switchToId }) {
	client.send({ type: "start_goal_wizard", text: draft, maxRounds: 3 });
	const dialog = await client.waitForType("dialog", (d) => d.kind === "select", 60000);
	const wizardConvId = await currentConvId(client);
	if (switchToId) {
		client.send({ type: "switch_conversation", id: switchToId });
		await sleep(600);
		const away = await currentConvId(client, 8000);
		check("切走生效（活动会话已不是发起调研的那个）", away !== wizardConvId, `${wizardConvId} -> ${away}`);
	}
	client.send({ type: "dialog_response", id: dialog.id, value: "要" });
	return wizardConvId;
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
	client.send({ type: "hello", clientId: CLIENT_ID, locale: "zh" });
	await client.waitForType("ready");
	await client.waitForType("snapshot");
	client.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
	await client.waitForState((s) => s.model?.id === MODEL_ID, 20000);

	wizStep = 0;
	client.received.length = 0;
	await runWizardRound(client, DRAFT, {});
	const done1 = await client.waitForNotice(/调研完成|Survey done/, 60000);
	check("不切会话：调研正常收敛并设目标", !!done1, done1?.text ?? "(无完成通知)");
	check(
		"不切会话时 notice 是「调研完成，目标已设为…」（无「已丢弃」字样）",
		!!done1 && /^🎯 调研完成/.test(done1.text ?? "") && !/已丢弃/.test(done1.text ?? ""),
		done1?.text ?? "",
	);
	const lastWithGoal = [...client.goalHistory].reverse().find((g) => g?.goal);
	check("目标落在发起对话上（goal_status 有目标）", !!lastWithGoal?.goal, lastWithGoal?.goal ?? "(无)");

	await client.waitForState(
		(s) => (s.messages ?? []).some((m) => m.role === "custom" && /原始目标草案/.test(Client.msgText(m))),
		30000,
	);

	const cards = client.wizardCards().map((c) => ({ ...c, text: Client.msgText(c) }));
	console.log("  goal-wizard 卡片:\n" + (cards.map((c) => `    ${c.text.slice(0, 60)}`).join("\n") || "    (无)"));
	const draftCard = cards.find((c) => /原始目标草案/.test(c.text));
	check("第一张 goal-wizard 卡片是「原始目标草案」", !!draftCard);
	check("草案卡片含完整 draft 原文", !!draftCard && draftCard.text.includes(DRAFT));
	const firstIsDraft = cards.length > 0 && /原始目标草案/.test(cards[0].text);
	check("草案卡片排在第 1 题之前（流程有起点）", firstIsDraft, cards[0] ? cards[0].text.slice(0, 40) : "");

	wizStep = 0;
	client.received.length = 0;
	client.send({ type: "new_chat" });
	await sleep(600);
	const firstConv = client.conversations.find((c) => !c.isSubagent && c.messageCount > 0);
	console.log("  切走目标会话:", firstConv ? `${firstConv.id}` : "(无)");
	const wizardConvId = await runWizardRound(client, "切会话也要保住调研结果：支持递归去重", {
		switchToId: firstConv?.id,
	});
	const doneNotice = await client.waitForNotice(/目标调研完成|Survey done/, 60000);
	const discard = client.goalNotices().find((n) => /已丢弃/.test(n.text ?? ""));
	check("切会话后调研结果不再被丢弃", !!doneNotice && !discard, doneNotice?.text ?? "(无完成通知)");
	check(
		"完成通知点名是哪个会话（用户知道自己该切回哪儿）",
		!!doneNotice && /^🎯 会话「/.test(doneNotice.text ?? ""),
		doneNotice?.text ?? "",
	);
	check("拿到了发起调研的对话 id", typeof wizardConvId === "string" && wizardConvId.length > 0, String(wizardConvId));
	if (wizardConvId) {
		client.received.length = 0;
		client.send({ type: "switch_conversation", id: wizardConvId });
		const back = await client.waitForType("goal_status", (g) => !!g.status?.goal, 20000).catch(() => null);
		check("切回后 goal_status 带回已设定的目标（成果没丢）", !!back?.status?.goal, back?.status?.goal ?? "(未取到)");
		check(
			"目标的 conversationId 就是发起调研的会话",
			back?.status?.conversationId === wizardConvId,
			`${back?.status?.conversationId} vs ${wizardConvId}`,
		);
		console.log("  切回后的目标:", back?.status?.goal ?? "(未取到)");
	}
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
