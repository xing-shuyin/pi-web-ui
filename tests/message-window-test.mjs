import { portUp, freePort } from "./lib/port-utils.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = Number(process.argv[2] || 8991);
const BASE = mkdtempSync(join(tmpdir(), "pi-msgwin-"));
const WORK = join(BASE, "work");
const DATA_DIR = join(BASE, "data");
const AGENT_DIR = join(BASE, "agent");
for (const d of [WORK, DATA_DIR, AGENT_DIR]) mkdirSync(d, { recursive: true });

const WINDOW = 10;
const TOTAL = 40;

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

function seedLongSession() {
	const dir = join(AGENT_DIR, "sessions");
	mkdirSync(dir, { recursive: true });
	const id = "message-window-seed";
	const file = join(dir, `2026-08-04T00-00-00-000Z_${id}.jsonl`);
	const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-08-04T00:00:00.000Z", cwd: WORK })];
	let parentId = null;
	for (let i = 0; i < TOTAL; i++) {
		const entryId = `m${i + 1}`;
		const role = i % 2 === 0 ? "user" : "assistant";
		lines.push(
			JSON.stringify({
				type: "message",
				id: entryId,
				parentId,
				timestamp: `2026-08-04T00:00:${String(1 + i).padStart(2, "0")}.000Z`,
				message: {
					role,
					content: [{ type: "text", text: `${role} message ${i + 1}` }],
					...(role === "assistant" ? { stopReason: "stop" } : {}),
					timestamp: 1722700800000 + (i + 1) * 1000,
				},
			}),
		);
		parentId = entryId;
	}
	writeFileSync(file, lines.join("\n") + "\n");
	return file;
}

const seedFile = seedLongSession();
writeFileSync(join(AGENT_DIR, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(AGENT_DIR, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				name: "Mock",
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:9/v1",
				apiKey: "sk-mock",
				models: [{ id: "msgwin-mock", name: "Mock" }],
			},
		},
	}),
);

await ensureBuild(REPO_ROOT, "message-window-test");
try {
	await freePort(PORT);
} catch {}

const server = spawn("node", ["dist/server/index.js"], {
	cwd: REPO_ROOT,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: WORK,
		PI_WEB_DATA_DIR: DATA_DIR,
		PI_CODING_AGENT_DIR: AGENT_DIR,
		PI_WEB_SDK: "bundled",
		PI_WEB_PLUGIN_CATALOG_URL: "",
		PI_WEB_HISTORY_WINDOW: String(WINDOW),
	},
	stdio: ["ignore", "ignore", "pipe"],
});
let serverErr = "";
server.stderr.on("data", (d) => (serverErr += d.toString()));
let started = false;
for (let i = 0; i < 120 && !started; i++) {
	started = await portUp(PORT);
	if (!started) await sleep(250);
}
if (!started) {
	console.error(`server did not start (exitCode=${server.exitCode})\n${serverErr.trim() || "(no stderr)"}`);
	rmSync(BASE, { recursive: true, force: true });
	process.exit(1);
}

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
let state = null;
let settings = null;
const earlierPages = [];
ws.on("message", (d) => {
	let m;
	try {
		m = JSON.parse(d.toString());
	} catch {
		return;
	}
	if (m.type === "snapshot") state = m.state;
	if (m.type === "snapshot_delta" && state && state.rev === m.baseRev) {
		state = { ...state, ...m.state, messages: [...state.messages, ...m.appended] };
	}
	if (m.type === "earlier_messages") earlierPages.push(m);
	if (m.type === "settings_state" || m.type === "settings") settings = m.settings;
});
await new Promise((r) => ws.once("open", r));
ws.send(JSON.stringify({ type: "hello", clientId: randomUUID() }));
for (let i = 0; i < 100 && !state?.conversationId; i++) await sleep(100);

ws.send(JSON.stringify({ type: "switch_session", path: seedFile }));
for (let i = 0; i < 100 && state?.sessionFile !== seedFile; i++) await sleep(100);
check("已打开种子会话", state?.sessionFile === seedFile, `sessionFile=${state?.sessionFile}`);
check(
	"首份快照只下发尾部窗口",
	state?.messages?.length === WINDOW,
	`msgs=${state?.messages?.length} start=${state?.historyStart} total=${state?.historyTotal}`,
);
check("回填窗口起点", state?.historyStart === TOTAL - WINDOW, `historyStart=${state?.historyStart}`);
check("回填全量总数", state?.historyTotal === TOTAL, `historyTotal=${state?.historyTotal}`);
check(
	"窗口内容是最新的一段",
	state?.messages?.at(-1)?.content?.[0]?.text === `assistant message ${TOTAL}`,
	state?.messages?.at(-1)?.content?.[0]?.text,
);

ws.send(JSON.stringify({ type: "load_earlier_messages", count: WINDOW }));
for (let i = 0; i < 100 && earlierPages.length === 0; i++) await sleep(50);
let page = earlierPages[0];
check("收到更早一页", Boolean(page), `pages=${earlierPages.length}`);
check("页大小 = 请求条数", page?.messages?.length === WINDOW, `n=${page?.messages?.length}`);
check(
	"页与当前窗口无缝相接",
	page?.historyStart + page?.messages?.length === TOTAL - WINDOW,
	`start=${page?.historyStart}`,
);
check(
	"页内容是紧邻窗口更早的一段",
	page?.messages?.at(-1)?.content?.[0]?.text === `assistant message ${TOTAL - WINDOW}`,
	page?.messages?.at(-1)?.content?.[0]?.text,
);

state = { ...state, messages: [...(page?.messages ?? []), ...state.messages], historyStart: page?.historyStart };

ws.send(JSON.stringify({ type: "get_state" }));
const startBefore = state.historyStart;
for (let i = 0; i < 100 && state?.historyStart !== 0 && state?.messages?.length !== TOTAL - startBefore; i++)
	await sleep(50);
check(
	"全量重发保持窗口起点（已加载的历史不丢）",
	state?.historyStart === startBefore && state?.messages?.length === TOTAL - startBefore,
	`start=${state?.historyStart} msgs=${state?.messages?.length}`,
);

ws.send(JSON.stringify({ type: "load_earlier_messages", all: true }));
for (let i = 0; i < 100 && earlierPages.length < 2; i++) await sleep(50);
page = earlierPages[1];
check(
	"all 拉到最早",
	page?.historyStart === 0 && page?.messages?.length === TOTAL - WINDOW - WINDOW,
	`start=${page?.historyStart} n=${page?.messages?.length}`,
);
const pagesBefore = earlierPages.length;
ws.send(JSON.stringify({ type: "load_earlier_messages", all: true }));
for (let i = 0; i < 100 && earlierPages.length === pagesBefore; i++) await sleep(50);
page = earlierPages[2];
check(
	"已到最早时回空页（客户端据此收起加载态）",
	page && page.messages.length === 0 && page.historyStart === 0,
	`n=${page?.messages?.length}`,
);

const beforeNew = state?.conversationId;
ws.send(JSON.stringify({ type: "new_chat" }));
for (let i = 0; i < 100 && state?.conversationId === beforeNew; i++) await sleep(50);
check(
	"新对话：窗口起点为 0，不裁剪",
	state?.historyStart === 0 && state?.messages?.length === 0,
	`start=${state?.historyStart} msgs=${state?.messages?.length}`,
);

ws.send(JSON.stringify({ type: "set_settings", reversePagination: true }));
for (let i = 0; i < 100 && settings?.reversePagination !== true; i++) await sleep(50);
check("set_settings 能打开向上分页加载", settings?.reversePagination === true, `value=${settings?.reversePagination}`);
ws.send(JSON.stringify({ type: "set_settings", reversePagination: false }));
for (let i = 0; i < 100 && settings?.reversePagination !== false; i++) await sleep(50);
check("set_settings 能关回去", settings?.reversePagination === false, `value=${settings?.reversePagination}`);

const pagesLenBefore7 = earlierPages.length;
ws.send(JSON.stringify({ type: "switch_session", path: seedFile }));
for (let i = 0; i < 100 && (state?.conversationId === beforeNew || state?.messages?.length !== TOTAL); i++)
	await sleep(50);
check("切回会话保留已展开的历史窗口", state?.historyStart === 0 && state?.messages?.length === TOTAL);
const seedConvId = state?.conversationId;
const firstMsgId = state?.messages?.[30 - state.historyStart]?.id;
ws.send(
	JSON.stringify({
		type: "load_earlier_messages",
		conversationId: seedConvId,
		historyGeneration: state.historyGeneration,
		beforeId: firstMsgId,
		before: 30,
		count: 5,
	}),
);
for (let i = 0; i < 100 && earlierPages.length === pagesLenBefore7; i++) await sleep(50);
const page7 = earlierPages.at(-1);
check(
	"自描述 beforeId 定位翻页成功",
	page7?.conversationId === seedConvId && page7?.historyStart === 25 && page7?.messages?.length === 5,
	`conv=${page7?.conversationId} start=${page7?.historyStart} n=${page7?.messages?.length}`,
);
check(
	"beforeId 翻页末尾条目紧邻 beforeId 消息",
	page7?.messages?.at(-1)?.content?.[0]?.text === "assistant message 30",
	page7?.messages?.at(-1)?.content?.[0]?.text,
);

const pagesBeforeInvalid = earlierPages.length;
ws.send(
	JSON.stringify({
		type: "load_earlier_messages",
		conversationId: seedConvId,
		historyGeneration: state.historyGeneration,
		beforeId: "missing-anchor",
		before: 30,
		count: 5,
	}),
);
for (let i = 0; i < 100 && earlierPages.length === pagesBeforeInvalid; i++) await sleep(50);
const invalidPage = earlierPages.at(-1);
check(
	"无效锚点要求重新同步",
	earlierPages.length > pagesBeforeInvalid &&
		invalidPage?.resyncRequired === true &&
		invalidPage?.messages?.length === 0,
);
check("无效锚点保留已展开窗口", invalidPage?.historyStart === 0);

try {
	ws.close();
} catch {}
server.kill();
await sleep(300);
try {
	server.kill("SIGKILL");
} catch {}
rmSync(BASE, { recursive: true, force: true });

console.log(failures === 0 ? "\nmessage-window: all checks passed" : `\nmessage-window: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
