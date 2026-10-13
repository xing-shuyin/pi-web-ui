/**
 * 工具延迟加载（load_tools）端到端回归 —— 零 token（本地 mock LLM，openai-completions SSE）。
 *
 * 验证三件事，且第三件是硬约束（缓存不能被我们打坏）：
 *   1. 默认只有核心工具（bash/read/edit/write）+ load_tools 常驻；
 *      其余工具在系统提示词里**只有名字 + 一行摘要**（目录），没有 schema。
 *   2. 模型调 load_tools(["patch"]) 之后，patch 出现在下一次请求的 tools 里
 *      （参数 schema 到位），并能在同一对话后续轮次继续用。
 *   3. **系统提示词逐字节不变**：加载前后两次请求的 system 文本必须完全一致
 *      （它一变，供应商的前缀缓存就整段失效）；tools 数组只允许**追加**——
 *      第二次的 tools 必须以第一次的 tools 为前缀（顺序/内容都不许动）。
 *
 * 端口 8975，临时 data-dir / 工作区 / agent 目录，结束自行清理。
 */
import { createServer } from "node:http";
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
const PORT = Number(process.argv[2] || 8987);
const MOCK_PORT = PORT + 1;
const BASE = mkdtempSync(join(tmpdir(), "pi-lazy-tools-"));
const WS_DIR = join(BASE, "work");
const DATA_DIR = join(BASE, "data");
const AGENT_DIR = join(BASE, "agent");
for (const d of [WS_DIR, DATA_DIR, AGENT_DIR]) mkdirSync(d, { recursive: true });

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

// ── mock LLM：第 1 轮回 load_tools 工具调用，之后回纯文本 ──────────────────
const requests = [];
const delta = (model, d, finish = null) => ({
	id: "chatcmpl-lazy",
	object: "chat.completion.chunk",
	created: Math.floor(Date.now() / 1000),
	model,
	choices: [{ index: 0, delta: d, finish_reason: finish }],
});
const toolCall = (model, name, args) =>
	delta(model, {
		tool_calls: [
			{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
		],
	});
const mock = createServer((req, res) => {
	if (req.method === "GET") {
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [] }));
		return;
	}
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		let payload = {};
		try {
			payload = JSON.parse(body || "{}");
		} catch {
			/* ignore */
		}
		requests.push(payload);
		const messages = Array.isArray(payload.messages) ? payload.messages : [];
		const lastUser = messages.map((m) => m.role).lastIndexOf("user");
		const tail = messages.slice(lastUser + 1);
		const alreadyCalled = tail.some((m) => m.role === "tool");
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const chunks = alreadyCalled
			? [delta(payload.model ?? "mock-model", { content: "done" })]
			: [toolCall(payload.model ?? "mock-model", "load_tools", { tools: ["patch", "read"] })];
		for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
		res.write(
			`data: ${JSON.stringify({
				...delta(payload.model ?? "mock-model", {}),
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
			})}\n\n`,
		);
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

writeFileSync(join(AGENT_DIR, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "lazy-tools-test" } }));
writeFileSync(
	join(AGENT_DIR, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "lazy-tools-test",
				models: [
					{ id: "lazy-tools-mock", name: "Lazy Tools Mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 },
				],
			},
		},
	}),
);

try {
	ensureBuild(REPO_ROOT, "lazy-tools-test");
} catch (err) {
	console.error(String(err?.message ?? err));
	process.exit(1);
}
try {
	await freePort(PORT);
} catch {}
await sleep(300);
const server = spawn("node", ["dist/server/index.js"], {
	cwd: REPO_ROOT,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: WS_DIR,
		PI_WEB_DATA_DIR: DATA_DIR,
		PI_CODING_AGENT_DIR: AGENT_DIR,
		PI_WEB_SDK: "bundled",
		PI_WEB_PLUGIN_CATALOG_URL: "",
	},
	stdio: ["ignore", "ignore", "pipe"],
});
let serverErr = "";
server.stderr.on("data", (d) => (serverErr += d.toString()));
for (let i = 0; i < 100 && !(await portUp(PORT)); i++) await sleep(250);
if (!(await portUp(PORT))) {
	console.error(`server did not start (exitCode=${server.exitCode})\n${serverErr.trim() || "(no stderr)"}`);
	process.exit(1);
}

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
let state = null;
let settings = null;
ws.on("message", (d) => {
	let m;
	try {
		m = JSON.parse(d.toString());
	} catch {
		return;
	}
	if (m.type === "snapshot") state = m.state;
	if (m.type === "snapshot_delta" && state && state.rev === m.baseRev) state = { ...state, ...m.state };
	if (m.type === "settings_state") settings = m.settings;
});
await new Promise((r) => ws.once("open", r));
ws.send(JSON.stringify({ type: "hello", clientId: randomUUID() }));
for (let i = 0; i < 100 && !state?.conversationId; i++) await sleep(100);
check("会话已就绪", Boolean(state?.conversationId), `conv=${state?.conversationId}`);

/** 等一次模型请求（按索引）。 */
async function waitRequest(index, timeout = 30000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout && requests.length <= index) await sleep(100);
	return requests[index];
}
const toolNames = (req) => (req?.tools ?? []).map((t) => t.function?.name).filter(Boolean);
const systemText = (req) => {
	const sys = (req?.messages ?? []).find((m) => m.role === "system" || m.role === "developer");
	return typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? "");
};

ws.send(JSON.stringify({ type: "set_model", modelId: "main/lazy-tools-mock" }));
for (let i = 0; i < 100 && state?.model?.id !== "lazy-tools-mock"; i++) await sleep(100);
check("已切到 mock 模型", state?.model?.id === "lazy-tools-mock", `model=${state?.model?.id}`);

// 延迟加载默认开：模型列表里应该只有目录（名字 + 摘要），没有完整 schema。
ws.send(JSON.stringify({ type: "prompt", text: "load the patch tool" }));
const first = await waitRequest(0);
check("已发出第一次模型请求", Boolean(first), `requests=${requests.length}`);
const firstTools = toolNames(first);
check(
	"默认只常驻核心工具 + load_tools",
	["bash", "read", "edit", "write", "load_tools"].every((n) => firstTools.includes(n)),
	firstTools.join(","),
);
check(
	"未加载的工具（patch/lsp）不在 tools 里",
	!firstTools.includes("patch") && !firstTools.includes("lsp"),
	firstTools.join(","),
);
const firstSystem = systemText(first);
check(
	"系统提示词里列了目录工具（名称 + 一行摘要）",
	firstSystem.includes("- patch:") && firstSystem.includes("- lsp:"),
	`system len=${firstSystem.length}`,
);
check("系统提示词带「先 load_tools」的说明", /load_tools/.test(firstSystem));

// 等 load_tools 执行完 → 第二次请求
const second = await waitRequest(1);
check("load_tools 执行后又发了一次请求", Boolean(second), `requests=${requests.length}`);
const toolResult = (second?.messages ?? []).find((m) => m.role === "tool");
const toolContent =
	typeof toolResult?.content === "string" ? toolResult.content : JSON.stringify(toolResult?.content ?? "");
check(
	"load_tools 拒绝对核心常驻工具 read 的加载请求（提示无需加载）",
	/read: (always available|常驻)/.test(toolContent),
	`toolContent=${toolContent}`,
);
const secondTools = toolNames(second);
check("patch 已被加载进 tools", secondTools.includes("patch"), secondTools.join(","));

// 缓存硬约束：system 逐字节不变；tools 以前一次的为前缀（纯追加）。
const secondSystem = systemText(second);
check(
	"加载前后系统提示词逐字节相同（不破坏前缀缓存）",
	secondSystem === firstSystem,
	`before=${firstSystem.length} after=${secondSystem.length}`,
);
const prefixOk = firstTools.length <= secondTools.length && firstTools.every((n, i) => secondTools[i] === n);
check(
	"tools 数组只追加（第一次的序列是第二次的前缀）",
	prefixOk,
	`before=[${firstTools.join(",")}] after=[${secondTools.join(",")}]`,
);
check("加载后目录里 patch 的描述仍在提示词里（列表不随加载变化）", secondSystem.includes("- patch:"));

// 设置快照里的生效提示词也保持稳定（设置页预览口径）。
const promptBefore = settings?.effectiveSystemPrompt ?? "";
ws.send(JSON.stringify({ type: "get_settings" }));
await sleep(800);
check(
	"settings_state.effectiveSystemPrompt 不随加载变化",
	(settings?.effectiveSystemPrompt ?? "") === promptBefore,
	`len=${(settings?.effectiveSystemPrompt ?? "").length}`,
);

check("服务进程仍然存活", server.exitCode === null, `exitCode=${server.exitCode}`);

ws.close();
server.kill("SIGKILL");
mock.close();
rmSync(BASE, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
