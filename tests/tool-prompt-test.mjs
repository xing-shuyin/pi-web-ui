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
const PORT = Number(process.argv[2] || 8926);
const MOCK_PORT = PORT + 1;
const BASE = mkdtempSync(join(tmpdir(), "pi-toolprompt-"));
const WS_DIR = join(BASE, "work");
const DATA_DIR = join(BASE, "data");
const AGENT_DIR = join(BASE, "agent");
mkdirSync(WS_DIR, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });

const CUSTOM_DESC = "CUSTOM-BASH-DESC-zzz: run a shell command for the regression test";
const CUSTOM_SNIPPET = "custom-bash-snippet-zzz";
const CUSTOM_GUIDELINE = "custom-bash-guideline-zzz";

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

const payloads = [];
const mock = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	try {
		payloads.push(JSON.parse(body));
	} catch {}
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const chunk = (content, finish) =>
		res.write(
			`data: ${JSON.stringify({
				id: "tool-prompt-mock",
				object: "chat.completion.chunk",
				created: Date.now(),
				model: "tool-prompt-mock",
				choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish ?? null }],
			})}\n\n`,
		);
	chunk("ok");
	chunk("", "stop");
	res.write("data: [DONE]\n\n");
	res.end();
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

writeFileSync(join(AGENT_DIR, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "tool-prompt-test" } }));
writeFileSync(
	join(AGENT_DIR, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "tool-prompt-test",
				models: [
					{ id: "tool-prompt-mock", name: "Tool Prompt Mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 },
				],
			},
		},
	}),
);

try {
	ensureBuild(REPO_ROOT, "tool-prompt-test");
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
for (let i = 0; i < 80 && !(await portUp(PORT)); i++) await sleep(250);
if (!(await portUp(PORT))) {
	console.error(`server did not start (exitCode=${server.exitCode})\n${serverErr.trim() || "(no stderr)"}`);
	process.exit(1);
}

class Client {
	constructor(ws) {
		this.ws = ws;
		this.prompts = new Map();
		this.infos = new Map();
		this.settings = null;
		this.state = null;
		ws.on("message", (data) => {
			let m;
			try {
				m = JSON.parse(data.toString());
			} catch {
				return;
			}
			if (m.type === "tool_prompt") this.prompts.set(m.name, m);
			if (m.type === "tool_info") this.infos.set(m.name, m);
			if (m.type === "settings_state") this.settings = m.settings;
			if (m.type === "snapshot") this.state = m.state;
			if (m.type === "snapshot_delta" && this.state && this.state.rev === m.baseRev) {
				this.state = { ...this.state, ...m.state };
			}
		});
	}
	send(m) {
		this.ws.send(JSON.stringify(m));
	}
	async waitForState(predicate, timeout = 20000) {
		const t0 = Date.now();
		while (Date.now() - t0 < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error("timeout waiting for state");
	}
	async waitFor(predicate, timeout = 8000) {
		const t0 = Date.now();
		while (Date.now() - t0 < timeout) {
			if (predicate()) return true;
			await sleep(50);
		}
		return false;
	}
}

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((resolve, reject) => {
	ws.once("open", resolve);
	ws.once("error", reject);
});
const client = new Client(ws);
client.send({ type: "hello", clientId: randomUUID() });
await client.waitForState((s) => Boolean(s.conversationId));

async function askPrompt(name) {
	client.prompts.delete(name);
	client.send({ type: "get_tool_prompt", name });
	await client.waitFor(() => client.prompts.has(name));
	return client.prompts.get(name);
}
async function askInfo(name) {
	client.infos.delete(name);
	client.send({ type: "get_tool_info", name });
	await client.waitFor(() => client.infos.has(name));
	return client.infos.get(name);
}
async function setOverride(patch) {
	client.settings = null;
	client.send({ type: "set_settings", toolPromptOverrides: patch });
	await client.waitFor(() => client.settings !== null);
	return client.settings;
}

const before = await askPrompt("bash");
check("bash 取到默认（found: true）", before?.found === true, JSON.stringify(before && { found: before.found }));
check(
	"带回出厂默认描述",
	typeof before?.defaultDescription === "string" && before.defaultDescription.trim().length > 20,
	`len=${before?.defaultDescription?.length ?? 0}`,
);
check("未覆盖时无 override 字段", before?.override === undefined, JSON.stringify(before?.override));

await setOverride({
	bash: { description: CUSTOM_DESC, promptSnippet: CUSTOM_SNIPPET, promptGuidelines: [CUSTOM_GUIDELINE] },
});
const after = await askPrompt("bash");
check("覆盖回读到 get_tool_prompt", after?.override?.description === CUSTOM_DESC, JSON.stringify(after?.override));

const info = await askInfo("bash");
check(
	"get_tool_info 回**生效描述**（覆盖优先）",
	info?.description === CUSTOM_DESC,
	`desc=${info?.description?.slice(0, 40)}`,
);
check("get_tool_info 回生效 snippet", info?.promptSnippet === CUSTOM_SNIPPET, info?.promptSnippet);
check(
	"get_tool_info 回生效 guidelines",
	Array.isArray(info?.promptGuidelines) && info.promptGuidelines.includes(CUSTOM_GUIDELINE),
	JSON.stringify(info?.promptGuidelines),
);
check(
	"toolsSchema（设置页预览）用覆盖文案",
	typeof client.settings?.toolsSchema === "string" && client.settings.toolsSchema.includes(CUSTOM_DESC),
	`toolsSchema len=${client.settings?.toolsSchema?.length ?? 0}`,
);
check(
	"effectiveSystemPrompt 含覆盖的 snippet / guideline",
	typeof client.settings?.effectiveSystemPrompt === "string" &&
		client.settings.effectiveSystemPrompt.includes(CUSTOM_SNIPPET) &&
		client.settings.effectiveSystemPrompt.includes(CUSTOM_GUIDELINE),
	`prompt len=${client.settings?.effectiveSystemPrompt?.length ?? 0}`,
);

client.send({ type: "set_model", modelId: "main/tool-prompt-mock" });
await client.waitForState((s) => s.model?.id === "tool-prompt-mock");
payloads.length = 0;
client.send({ type: "prompt", text: "ping" });
await client.waitFor(() => payloads.some((p) => Array.isArray(p.tools)), 20000);
const req = payloads.find((p) => Array.isArray(p.tools) && p.tools.some((t) => t.function?.name === "bash"));
check("模型请求里带上了 bash 工具", Boolean(req), `payloads=${payloads.length}`);
const bashTool = req?.tools?.find((t) => t.function?.name === "bash");
check(
	"模型看到的 bash description = 覆盖文案",
	typeof bashTool?.function?.description === "string" && bashTool.function.description.split("\n")[0] === CUSTOM_DESC,
	`desc=${bashTool?.function?.description?.slice(0, 80)}`,
);
const sys = req?.messages?.find((m) => m.role === "system");
const sysText = typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? "");
check(
	"系统提示词含覆盖的 snippet / guideline",
	sysText.includes(CUSTOM_SNIPPET) && sysText.includes(CUSTOM_GUIDELINE),
	`system len=${sysText.length}`,
);

await setOverride({ bash: {} });
const cleared = await askPrompt("bash");
check("清空后无 override", cleared?.override === undefined, JSON.stringify(cleared?.override));
const clearedInfo = await askInfo("bash");
check(
	"清空后 get_tool_info 复原出厂默认",
	clearedInfo?.description === before?.defaultDescription,
	`desc=${clearedInfo?.description?.slice(0, 40)}`,
);
check(
	"清空后 toolsSchema 回到默认（不再含自定义文案）",
	typeof client.settings?.toolsSchema === "string" && !client.settings.toolsSchema.includes(CUSTOM_DESC),
);

check("服务进程仍然存活", server.exitCode === null, `exitCode=${server.exitCode}`);

ws.close();
server.kill("SIGKILL");
mock.close();
rmSync(BASE, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
