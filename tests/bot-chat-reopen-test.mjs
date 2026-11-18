/**
 * 私聊「改完 Bot 打不开了」的真实回归测试（真服务 + 真 SDK + 假模型）。
 *
 * 现场：`webui/bot-chat` 转录里记的 Bot revision 是建会话时的值；用户后来在设备中心
 * 改了这个 Bot（revision 1 → 2），重启后点左栏的智能体 → 服务端按新配置重建能力，
 * 却被 `device-bot-execution` 锚点的 revision 断言判成「不是同一个执行者」，
 * 于是抛 `Bot execution transcript ownership does not match the active capability`，
 * 这条私聊就**永远**打不开了。
 *
 * 这里跑真链路，不允许出现那条错：
 * 1. 建 Bot → `open_bot_chat` 新建私聊 → 真跑一轮 prompt（转录落盘）；
 * 2. 改 Bot（revision +1）→ 重启服务 → 再 `open_bot_chat`：必须重开**同一份**转录；
 * 3. 重开之后锚点要跟到新 revision（否则每次打开都撞同一条）；
 * 4. `fresh: true` 才另起一条，旧转录留在磁盘；
 * 5. Bot 停用后入口给的是可读提示，不是崩溃。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { ensureBuild } from "./lib/ensure-build.mjs";

const PORT = Number(process.argv[2] || 8912);
const MOCK_PORT = PORT + 1;
const PROVIDER = "bot-chat-fixture";
const MODEL = "bot-chat-fixture-model";
const base = mkdtempSync(join(tmpdir(), "pi-web-bot-chat-reopen-"));
const project = join(base, "project");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const dir of [project, dataDir, agentDir]) mkdirSync(dir, { recursive: true });
writeFileSync(join(project, "README.md"), "# bot chat reopen\n");

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};
const OWNERSHIP_ERROR = /Bot execution transcript ownership does not match the active capability/;

/* ---------- 假模型：确定性 SSE ---------- */
let modelCalls = 0;
const mock = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	const payload = JSON.parse(body || "{}");
	modelCalls++;
	const marker = `BOT_CHAT_FIXTURE_REPLY_${modelCalls}`;
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const chunk = (delta, finish = null) => ({
		id: "bot-chat-fixture",
		object: "chat.completion.chunk",
		created: Date.now(),
		model: payload.model,
		choices: [{ index: 0, delta, finish_reason: finish }],
	});
	res.write(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`);
	res.write(`data: ${JSON.stringify(chunk({ content: marker }))}\n\n`);
	res.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
	res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			[PROVIDER]: {
				baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
				api: "openai-completions",
				apiKey: "bot-chat-fixture-key",
				models: [
					{
						id: MODEL,
						name: "Bot chat fixture",
						reasoning: false,
						input: ["text"],
						contextWindow: 128000,
						maxTokens: 4096,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	}),
);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL }));

const repoRoot = realpathSync(new URL("../", import.meta.url));
try {
	ensureBuild(repoRoot, "bot-chat-reopen");
} catch (err) {
	console.error(String(err?.message ?? err));
	process.exit(1);
}

/* ---------- 真服务进程（可重启） ---------- */
let server;
let logs = "";
function startServer() {
	logs = "";
	server = spawn(process.execPath, [join(repoRoot, "dist/server/index.js")], {
		cwd: repoRoot,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_CWD: project,
			PI_WEB_DATA_DIR: dataDir,
			PI_CODING_AGENT_DIR: agentDir,
			PI_WEB_SDK: "bundled",
			PI_WEB_PASSWORD: "",
			PI_WEB_PLUGIN_CATALOG_URL: "off",
			PI_WEB_PRESET_CATALOG_URL: "off",
			PI_WEB_TOOL_LAZY_LOADING: "0",
			PI_WEB_QUIET: "1",
		},
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	for (const pipe of [server.stdout, server.stderr])
		pipe.on("data", (chunk) => {
			logs = (logs + chunk).slice(-16000);
		});
}
async function stopServer() {
	if (!server || server.exitCode !== null) return;
	const exited = new Promise((resolve) => server.once("exit", resolve));
	server.kill();
	await Promise.race([exited, sleep(6000)]);
	if (server.exitCode === null) server.kill("SIGKILL");
	await sleep(200);
}
async function waitForServer(timeout = 30000) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			const response = await fetch(`http://127.0.0.1:${PORT}/health`);
			if (response.ok) return;
		} catch {}
		if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}: ${logs}`);
		await sleep(100);
	}
	throw new Error(`server did not start on ${PORT}: ${logs}`);
}

const origin = `http://127.0.0.1:${PORT}`;
async function api(path, body, expected = 200) {
	const response = await fetch(origin + path, {
		method: body === undefined ? "GET" : "POST",
		headers: { Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const raw = await response.text();
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error(`${path}: HTTP ${response.status}: ${raw.slice(0, 300)}`);
	}
	assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`);
	return value;
}

/* ---------- WS 客户端 ---------- */
class Client {
	constructor(ws) {
		this.ws = ws;
		this.state = null;
		this.conversations = [];
		this.notices = [];
		this.packets = [];
		ws.on("message", (data) => {
			const packet = JSON.parse(data.toString());
			this.packets.push(packet);
			if (packet.type === "snapshot") {
				this.state = packet.state;
				this.conversations = packet.state.conversations ?? this.conversations;
			} else if (
				packet.type === "snapshot_delta" &&
				this.state &&
				packet.conversationId === this.state.conversationId
			) {
				this.state = {
					...this.state,
					...packet.state,
					messages: [...(this.state.messages ?? []), ...(packet.appended ?? [])],
				};
				if (packet.state?.conversations) this.conversations = packet.state.conversations;
			} else if (packet.type === "conversations") this.conversations = packet.conversations;
			else if (packet.type === "notice") this.notices.push(packet);
		});
	}
	send(packet) {
		this.ws.send(JSON.stringify(packet));
	}
	async waitFor(predicate, label, timeout = 30000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			const value = predicate();
			if (value) return value;
			await sleep(50);
		}
		throw new Error(
			`timeout waiting for ${label}; active=${JSON.stringify(this.state?.conversationId)}; ` +
				`conversations=${JSON.stringify(this.conversations.map((c) => [c.id, c.botId ?? null]))}; ` +
				`notices=${JSON.stringify(this.notices.map((notice) => notice.textEn ?? notice.text))}`,
		);
	}
	conversation(id) {
		return this.conversations.find((conversation) => conversation.id === id);
	}
	botConversations(botId) {
		return this.conversations.filter((conversation) => conversation.botId === botId);
	}
	/** 当前对话是否绑着这个 Bot（快照上的 `bot` 字段是 UI 头部/左栏的唯一来源）。 */
	boundTo(botId) {
		return this.state?.bot?.id === botId;
	}
	async connect(clientId) {
		this.send({ type: "hello", clientId });
		await this.waitFor(() => this.state && this.state.conversationId, "hello snapshot");
		return this;
	}
	async prompt(text) {
		const before = this.state.messages?.length ?? 0;
		this.send({ type: "prompt", text });
		const assistant = await this.waitFor(() => {
			const messages = this.state?.messages ?? [];
			return messages.length > before && messages.some((message) => message.role === "assistant");
		}, `assistant reply to ${text}`);
		const messages = this.state.messages;
		return messages[messages.length - 1];
	}
}

/** UI 消息的正文（快照里是 content block 数组）。 */
function messageText(message) {
	const blocks = message?.content;
	if (typeof blocks === "string") return blocks;
	return (blocks ?? []).map((block) => (typeof block === "string" ? block : (block?.text ?? ""))).join("\n");
}

async function openClient() {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	return new Client(ws).connect(`bot-chat-reopen-${randomUUID()}`);
}

function botSessionsDir(botId) {
	return join(agentDir, "bot-sessions", botId);
}
function transcriptFiles(botId) {
	const dir = botSessionsDir(botId);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(dir, name));
}
function lastAnchorRevision(file) {
	const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
	for (let index = lines.length - 1; index >= 0; index--) {
		const entry = JSON.parse(lines[index]);
		if (entry.type === "custom" && entry.customType === "device-bot-execution") return entry.data?.revision ?? null;
	}
	return undefined;
}

const botInput = {
	name: "爱山东",
	description: "私聊重开回归",
	systemPrompt: "你是爱山东。",
	cwd: project,
	model: { provider: PROVIDER, modelId: MODEL },
	tools: ["read", "grep"],
	skills: [],
	mcpServers: [],
	enabled: true,
};

let client;
try {
	startServer();
	await waitForServer();

	/* ---------- 1. 建 Bot + 建私聊 + 真跑一轮 ---------- */
	let bot = (await api("/api/device-center/local-bots", botInput)).bot;
	check("Bot 建立（revision 1）", bot?.revision === 1, `revision=${bot?.revision}`);

	client = await openClient();
	const before = client.state.conversationId;
	client.send({ type: "open_bot_chat", botId: bot.id });
	const firstState = await client.waitFor(
		() =>
			client.state?.conversationId !== before && client.boundTo(bot.id) && client.state?.sessionFile && client.state,
		"new bot chat conversation",
	);
	const firstConv = { id: firstState.conversationId };
	check(
		"open_bot_chat 建出一条绑定 Bot 的私聊",
		firstState.bot?.name === bot.name,
		`bot=${JSON.stringify(firstState.bot)}`,
	);
	const firstFile = firstState.sessionFile;
	check("私聊转录落在 bot-sessions/<botId>/", firstFile.startsWith(botSessionsDir(bot.id)), firstFile);

	const reply = await client.prompt("第一轮：记住暗号 ALPHA-1");
	check(
		"真 SDK 跑通一轮（假模型回执落盘）",
		/BOT_CHAT_FIXTURE_REPLY_\d+/.test(messageText(reply)),
		messageText(reply).slice(0, 60) || JSON.stringify(reply).slice(0, 120),
	);
	await client.waitFor(() => transcriptFiles(bot.id).includes(firstFile), "transcript on disk");
	check(
		"左栏能按 botId 认出这条私聊",
		client.botConversations(bot.id).length === 1,
		`rows=${client.botConversations(bot.id).length}`,
	);
	check(
		"转录锚点记住建会话时的 revision",
		lastAnchorRevision(firstFile) === 1,
		`anchor=${lastAnchorRevision(firstFile)}`,
	);
	check(
		"私聊入口没有报错",
		client.notices.filter((notice) => notice.level === "error").length === 0,
		JSON.stringify(client.notices),
	);

	/* ---------- 2. 改 Bot（revision 1 → 2）后重启，再点智能体 ---------- */
	bot = (await api("/api/device-center/local-bots", { ...bot, systemPrompt: "你是爱山东。改过配置。" })).bot;
	check("Bot 配置被改过（revision 2）", bot.revision === 2, `revision=${bot.revision}`);
	client.ws.close();
	await stopServer();
	startServer();
	await waitForServer();

	client = await openClient();
	const stale = client.state.conversationId;
	client.send({ type: "open_bot_chat", botId: bot.id });
	// 这一步在修复前会以「切换会话失败：Bot execution transcript ownership ...」告终，
	// 于是永远等不到会话被换掉——超时即是复现。
	let reopenedState;
	try {
		reopenedState = await client.waitFor(
			() =>
				client.state?.conversationId !== stale &&
				client.state?.sessionFile &&
				client.state.bot?.id === bot.id &&
				client.state,
			"reopened bot chat conversation",
			45000,
		);
	} catch (err) {
		reopenedState = undefined;
		console.error("  重开失败详情:", err.message);
	}
	const reopened = { id: reopenedState?.conversationId };
	const reopenErrors = client.notices.filter((notice) => notice.level === "error");
	check(
		"改过 Bot 后私聊还能打开（不再出现 transcript ownership 报错）",
		reopenErrors.every((notice) => !OWNERSHIP_ERROR.test(`${notice.text} ${notice.textEn}`)),
		JSON.stringify(reopenErrors.map((notice) => notice.textEn ?? notice.text)),
	);
	check("重开的是一条绑定该 Bot 的会话", Boolean(reopenedState), `active=${client.state?.conversationId}`);
	check("重开的是同一份转录", reopenedState?.sessionFile === firstFile, `${reopenedState?.sessionFile}`);
	check(
		"历史消息还在（ALPHA-1）",
		JSON.stringify(reopenedState?.messages ?? []).includes("ALPHA-1"),
		`messages=${(reopenedState?.messages ?? []).length}`,
	);
	check(
		"重开后锚点跟到新 revision（下次打开不再撞）",
		lastAnchorRevision(firstFile) === 2,
		`anchor=${lastAnchorRevision(firstFile)}`,
	);
	const second = await client.prompt("第二轮：暗号 ALPHA-2");
	check(
		"重开后能继续聊（同一份转录继续写）",
		/BOT_CHAT_FIXTURE_REPLY_\d+/.test(messageText(second)) && transcriptFiles(bot.id).length === 1,
		`files=${transcriptFiles(bot.id).length}`,
	);
	check("重开全程没有服务端异常", !/Unhandled Promise Rejection|Bot execution capability has been revoked/.test(logs));
	// 重开的会话必须认得自己的 Bot 身份，否则再点一次又会去磁盘找一份 → 每点一次就新开一条。
	const activeBeforeRepeat = client.state?.conversationId;
	client.send({ type: "open_bot_chat", botId: bot.id });
	await sleep(1500);
	check(
		"再点一次智能体还是回到这条（幂等）",
		client.state?.conversationId === activeBeforeRepeat && transcriptFiles(bot.id).length === 1,
		`active=${client.state?.conversationId} files=${transcriptFiles(bot.id).length}`,
	);

	/* ---------- 3. fresh: true 才是另起一条 ---------- */
	const beforeFresh = transcriptFiles(bot.id).length;
	const beforeFreshConv = client.state?.conversationId;
	client.send({ type: "open_bot_chat", botId: bot.id, fresh: true });
	const freshState = await client.waitFor(
		() =>
			client.state?.conversationId !== beforeFreshConv &&
			client.state?.sessionFile &&
			client.state.bot?.id === bot.id &&
			client.state,
		"fresh bot chat conversation",
	);
	check("fresh: true 另起一条会话", freshState.sessionFile !== firstFile, freshState.sessionFile);
	await client.prompt("第三轮：暗号 BETA-1");
	check("旧转录不删", existsSync(firstFile), firstFile);
	check(
		"旧转录仍在目录里（新旧并存）",
		transcriptFiles(bot.id).length > beforeFresh && transcriptFiles(bot.id).includes(firstFile),
		`files=${transcriptFiles(bot.id).length}`,
	);

	/* ---------- 4. 停用 Bot：入口给可读提示，不抛内部错 ---------- */
	await api("/api/device-center/local-bots", { ...bot, enabled: false });
	const disabledConv = client.state?.conversationId;
	const noticesBefore = client.notices.length;
	client.send({ type: "open_bot_chat", botId: bot.id });
	const disabledNotice = await client.waitFor(
		() => client.notices.slice(noticesBefore).find((notice) => notice.level === "error"),
		"disabled bot notice",
		15000,
	);
	check(
		"停用后的提示是「已不可用」而不是内部断言",
		/不可用/.test(`${disabledNotice.text}`) && !OWNERSHIP_ERROR.test(`${disabledNotice.textEn}`),
		disabledNotice.textEn ?? disabledNotice.text,
	);
	check(
		"停用后不会偷偷新建会话",
		client.state?.conversationId === disabledConv,
		`active=${client.state?.conversationId}`,
	);
	check("全流程无 transcript ownership 报错", !OWNERSHIP_ERROR.test(JSON.stringify(client.packets)));

	/* ---------- 5. Bot 被停用后，旧私聊转录仍要能打开看（只读） ---------- */
	const secondBot = (await api("/api/device-center/local-bots", { ...botInput, name: "会用停用的" })).bot;
	client.send({ type: "open_bot_chat", botId: secondBot.id });
	const secondState = await client.waitFor(
		() => client.state?.bot?.id === secondBot.id && client.state?.sessionFile && client.state,
		"second bot chat",
	);
	const secondFile = secondState.sessionFile;
	client.send({ type: "prompt", text: "第二个 Bot：ALPHA-2" });
	await client.waitFor(
		() => (client.state.messages ?? []).some((message) => message.role === "assistant"),
		"second bot assistant reply",
	);
	await api("/api/device-center/local-bots", { ...secondBot, enabled: false });
	client.ws.close();
	await stopServer();
	startServer();
	await waitForServer();
	client = await openClient();
	const beforeDegrade = client.notices.length;
	client.send({ type: "switch_session", path: secondFile });
	const degraded = await client.waitFor(
		() => client.state?.sessionFile === secondFile && client.state,
		"degraded read-only bot chat",
		45000,
	);
	check(
		"Bot 停用后旧私聊历史还能打开（不报 ownership / cannot be resumed）",
		!OWNERSHIP_ERROR.test(JSON.stringify(client.packets)) &&
			client.notices.every((notice) => !/cannot be resumed as ordinary sessions/.test(notice.textEn ?? "")),
		degraded.conversationId,
	);
	const degradeNotice = client.notices
		.slice(beforeDegrade)
		.find((notice) => notice.level === "warning" && /read-only|只能查看历史/.test(`${notice.textEn} ${notice.text}`));
	check("降级成只读时会说明原因", Boolean(degradeNotice), degradeNotice?.textEn ?? "(无提示)");
	const beforePrompt = client.notices.length;
	client.send({ type: "prompt", text: "只读还能聊吗" });
	const refused = await client.waitFor(
		() =>
			client.notices
				.slice(beforePrompt)
				.find((notice) => notice.level === "error" && /inspection-only/i.test(`${notice.textEn} ${notice.text}`)),
		"read-only prompt refusal",
		15000,
	);
	check("只读会话不能被当成普通会话继续 talk", Boolean(refused), refused.textEn ?? refused.text);

	/* ---------- 6. 非私聊的执行转录（没身份锚点）不许当普通会话重开 ---------- */
	// 把上面那份私聊转录复制一份、剔掉 `webui/bot-chat`：剩下的 `device-bot-execution` 是「按某个 Bot
	// 的旧快照授权跑过的执行」，没了身份就不该被当成用户普通会话打开（否则等于拿用户自己的权限续跑）。
	const orphanFile = join(botSessionsDir(secondBot.id), "orphan-execution.jsonl");
	writeFileSync(
		orphanFile,
		readFileSync(secondFile, "utf8")
			.split("\n")
			.filter((line) => line && JSON.parse(line).customType !== "webui/bot-chat")
			.join("\n") + "\n",
	);
	const beforeOrphan = client.notices.length;
	client.send({ type: "switch_session", path: orphanFile });
	const orphanRefused = await client.waitFor(
		() =>
			client.notices
				.slice(beforeOrphan)
				.find(
					(notice) => notice.level === "error" && /cannot be resumed as ordinary sessions/.test(`${notice.textEn}`),
				),
		"orphan execution transcript refusal",
		30000,
	);
	check("无 Bot 身份的执行转录照样拒绝重开（安全边界没被放宽）", Boolean(orphanRefused), orphanRefused.textEn);
	check("被拒绝后不会切到那份转录", client.state?.sessionFile !== orphanFile, `${client.state?.sessionFile}`);

	/* ---------- 7. 没配模型的 Bot：重启后重开私聊不能卡在「没有默认模型」 ---------- */
	// 现场：Bot 没选模型，客户端也没设「默认模型」，只在工作区里选过模型。
	// 重开转录走 `switchSession`，运行时工厂若只传 `undefined` 就会抛
	// "Bot requires an explicit local default model"，私聊刷新后永远打不开。
	client.ws.close();
	client = await openClient();
	client.send({ type: "new_chat" });
	await client.waitFor(
		() => client.state?.cwd === project && !client.state?.bot,
		"plain conversation for project model",
	);
	client.send({ type: "set_model", modelId: `${PROVIDER}/${MODEL}` });
	await client.waitFor(() => client.state?.model?.id === MODEL, "project model pinned", 15000);

	const modelessInput = { ...botInput, name: "没配模型的" };
	delete modelessInput.model;
	const modeless = (await api("/api/device-center/local-bots", modelessInput)).bot;
	check("Bot 可以不配模型", modeless?.model === undefined, JSON.stringify(modeless?.model));

	const beforeModeless = client.state?.conversationId;
	client.send({ type: "open_bot_chat", botId: modeless.id });
	const modelessOpened = await client.waitFor(
		() =>
			client.state?.conversationId !== beforeModeless &&
			client.state?.bot?.id === modeless.id &&
			client.state?.sessionFile &&
			client.state,
		"model-less bot chat opened",
		45000,
	);
	const modelessFile = modelessOpened.sessionFile;
	check("没配模型的 Bot 用工作区模型开私聊", modelessOpened.model?.id === MODEL, JSON.stringify(modelessOpened.model));
	await client.prompt("记一个暗号 GAMMA-1");
	await client.waitFor(() => transcriptFiles(modeless.id).includes(modelessFile), "model-less transcript on disk");

	client.ws.close();
	await stopServer();
	startServer();
	await waitForServer();
	client = await openClient();
	const noticesBeforeReopen = client.notices.length;
	client.send({ type: "open_bot_chat", botId: modeless.id });
	let reopenedModeless;
	try {
		reopenedModeless = await client.waitFor(
			() => client.state?.sessionFile === modelessFile && client.state?.bot?.id === modeless.id && client.state,
			"model-less bot chat reopened after restart",
			45000,
		);
	} catch (err) {
		reopenedModeless = undefined;
		console.error("  无模型 Bot 重开失败详情:", err.message);
	}
	const reopenModelessErrors = client.notices.slice(noticesBeforeReopen).filter((notice) => notice.level === "error");
	check(
		"重启后重开私聊不再报「没有默认模型」",
		Boolean(reopenedModeless) &&
			reopenModelessErrors.every((notice) => !/explicit local default model/.test(`${notice.text} ${notice.textEn}`)),
		JSON.stringify(reopenModelessErrors.map((notice) => notice.textEn ?? notice.text)),
	);
	check("重开后还是同一份转录", reopenedModeless?.sessionFile === modelessFile, `${reopenedModeless?.sessionFile}`);
	check(
		"重开后历史还在（GAMMA-1）",
		JSON.stringify(reopenedModeless?.messages ?? []).includes("GAMMA-1"),
		`messages=${(reopenedModeless?.messages ?? []).length}`,
	);

	client.ws.close();
	console.log(`\n模型请求 ${modelCalls} 次；结果：${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
} catch (err) {
	failures++;
	console.error("✗ 测试自身失败:", err?.message ?? err);
	if (logs) console.error(logs.slice(-4000));
} finally {
	try {
		client?.ws?.close();
	} catch {}
	await stopServer();
	try {
		mock.close();
	} catch {}
	process.exit(failures === 0 ? 0 : 1);
}
