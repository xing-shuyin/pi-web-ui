/**
 * dsh 引擎 MCP 工具桥测试（真 key 门控）——<dataDir>/mcp.json 声明一个 stdio MCP
 * 服务器 → McpBridge 发现其工具 → 经 pluginToolsProvider 桥进 DSH（#15 的 tools
 * bridge）→ 模型真实调用 MCP 工具 → McpClient.call 转发给 MCP 服务器 → 结果回传模型。
 *
 * 需要一个最小 fake MCP 服务器（NDJSON JSON-RPC over stdio）。无 key / 无运行时树
 * / 无 node 时打印 SKIP 并退出 0。
 *
 * 用法：node tests/dsh-mcp-test.mjs   （先 npm run build）
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";
import { portUp } from "./lib/port-utils.mjs";
import { setTimeout as sleep } from "node:timers/promises";

const REPO = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8942;
const CLIENT_ID = "dsh-mcp-test";
const MARKER = "MCP_MARKER_8642";

// 真 key 门控。
let key = process.env.DEEPSEEK_API_KEY;
if (!key) {
	try {
		const authPath = join(homedir(), ".pi", "agent", "auth.json");
		if (existsSync(authPath)) {
			const auth = JSON.parse(readFileSync(authPath, "utf8"));
			const ds = auth.deepseek;
			key = typeof ds === "string" ? ds : ds?.key;
		}
	} catch {
		/* ignore */
	}
}
if (!key) {
	console.log("⏭ SKIP：无 DeepSeek API key（需 ~/.pi/agent/auth.json 的 deepseek.key 或 DEEPSEEK_API_KEY）");
	process.exit(0);
}
let rtAvailable = false;
try {
	const { resolveRuntimeBase } = await import(
		pathToFileURL(join(REPO, "server", "dsh", "runtime", "runtime-root.mjs")).href
	);
	rtAvailable = !!(await resolveRuntimeBase());
} catch {
	rtAvailable = false;
}
if (!rtAvailable) {
	console.log("⏭ SKIP：未找到 dsh 运行时树（需 npm i -g @deepseek-ai/dsh@0.1.1-rc.2 或 PI_WEB_DSH_RUNTIME）");
	process.exit(0);
}
// MCP 服务器用 node 跑（fake mcp server 用 node 内置 stdio）。
if (process.execPath === "") {
	console.log("⏭ SKIP：无 node");
	process.exit(0);
}

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

// ---- 种 fake MCP 服务器 + mcp.json ----
const dataDir = mkdtempSync(join(tmpdir(), "dsh-mcp-"));
const mcpServerPath = join(dataDir, "mcp-server.mjs");
writeFileSync(
	mcpServerPath,
	`// Fake stdio MCP server (NDJSON JSON-RPC).\n` +
		`let buf = "";\n` +
		`process.stdin.setEncoding("utf8");\n` +
		`const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");\n` +
		`process.stdin.on("data", (d) => {\n` +
		`  buf += d; let i;\n` +
		`  while ((i = buf.indexOf("\\n")) !== -1) {\n` +
		`    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);\n` +
		`    if (!line) continue;\n` +
		`    let m; try { m = JSON.parse(line); } catch { continue; }\n` +
		`    if (m.method === "initialize") {\n` +
		`      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });\n` +
		`    } else if (m.method === "tools/list") {\n` +
		`      send({ jsonrpc: "2.0", id: m.id, result: { tools: [ { name: "mcp_echo", description: "Echo text via MCP.", inputSchema: { type: "object", properties: { text: { type: "string", description: "text to echo" } }, required: ["text"] } } ] } });\n` +
		`    } else if (m.method === "tools/call") {\n` +
		`      const args = (m.params && m.params.arguments) || {};\n` +
		`      send({ jsonrpc: "2.0", id: m.id, result: { content: [ { type: "text", text: "MCP_ECHO:" + (args.text || "") } ] } });\n` +
		`    } else if (m.id !== undefined) {\n` +
		`      send({ jsonrpc: "2.0", id: m.id, result: {} });\n` +
		`    }\n` +
		`  }\n` +
		`});\n`,
);
writeFileSync(
	join(dataDir, "mcp.json"),
	JSON.stringify({ servers: { fake: { command: process.execPath, args: [mcpServerPath], cwd: REPO } } }),
);

const server = spawn("node", ["dist/server/index.js"], {
	cwd: REPO,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: REPO,
		PI_WEB_ENGINE: "dsh",
		DEEPSEEK_API_KEY: key,
	},
	stdio: ["ignore", "ignore", "pipe"],
});
server.stderr?.on("data", (d) => process.stderr.write("[srv] " + d.toString()));

for (let i = 0; i < 60; i++) {
	await sleep(250);
	try {
		if (await portUp(PORT)) break;
	} catch {
		/* retry */
	}
	if (i === 59) {
		console.error("✗ server 未在 15s 内启动");
		server.kill();
		process.exit(1);
	}
}
console.log("server up (engine=dsh, real key)");

function connect(clientId) {
	return new Promise((resolveConnect, reject) => {
		const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
		const inbox = [];
		const waiters = [];
		ws.on("message", (d) => {
			let msg;
			try {
				msg = JSON.parse(d.toString());
			} catch {
				return;
			}
			const idx = waiters.findIndex((w) => w.pred(msg));
			if (idx >= 0) {
				const [w] = waiters.splice(idx, 1);
				w.resolve(msg);
			} else {
				inbox.push(msg);
			}
		});
		ws.on("open", () =>
			resolveConnect({
				ws,
				send: (m) => ws.send(JSON.stringify(m)),
				wait: (pred, timeout = 30000) =>
					new Promise((res, rej) => {
						const i = inbox.findIndex(pred);
						if (i >= 0) {
							res(inbox.splice(i, 1)[0]);
							return;
						}
						const entry = { pred, resolve: null };
						const t = setTimeout(() => {
							const k = waiters.indexOf(entry);
							if (k >= 0) waiters.splice(k, 1);
							rej(new Error("timeout waiting for message"));
						}, timeout);
						entry.resolve = (m) => {
							clearTimeout(t);
							res(m);
						};
						waiters.push(entry);
					}),
				close: () => ws.close(),
			}),
		);
		ws.on("error", reject);
	});
}

function allTexts(msg) {
	const out = [];
	const walk = (arr) => {
		if (!Array.isArray(arr)) return;
		for (const m of arr) {
			if (!m || typeof m !== "object") continue;
			if (Array.isArray(m.content)) {
				for (const c of m.content) if (c && typeof c.text === "string") out.push(c.text);
			}
		}
	};
	if (msg.type === "snapshot") walk(msg.state?.messages);
	if (msg.type === "snapshot_delta") walk(msg.appended);
	return out.join("\n");
}

async function main() {
	const c = await connect(CLIENT_ID);
	c.send({ type: "hello", clientId: CLIENT_ID, protocolVersion: 1 });
	await c.wait((m) => m.type === "ready");
	console.log("attached");

	// 等 DSH 运行时启动 + 工具桥 sync，以及 McpBridge 发现 MCP 工具后 applyPluginAgentTools 重同步。
	await sleep(6000);

	c.send({
		type: "prompt",
		text: `请调用 mcp_echo 工具，参数 text = ${MARKER}。工具跑完后，把工具返回的完整内容原样告诉我（不要加任何解释）。`,
	});

	const t0 = Date.now();
	const seen = { mcpEcho: false, markerInConversation: false };
	const snippet = {};
	while (Date.now() - t0 < 120_000) {
		const msg = await c.wait((m) => m.type === "snapshot" || m.type === "snapshot_delta", 1000).catch(() => null);
		if (!msg) continue;
		const text = allTexts(msg);
		if (text.includes("MCP_ECHO:")) seen.mcpEcho = true;
		if (text.includes(MARKER)) {
			seen.markerInConversation = true;
			snippet.text = text;
		}
		if (seen.mcpEcho && seen.markerInConversation) break;
	}

	check("MCP 工具结果 (MCP_ECHO:) 出现在对话里", seen.mcpEcho, snippet.text?.slice(0, 200));
	check("模型回复包含回显 marker", seen.markerInConversation, snippet.text?.slice(0, 200));

	c.close();
	server.kill();
	await sleep(300);
	console.log(`\n===== dsh-mcp ${failures === 0 ? "PASS" : `FAIL (${failures})`} =====`);
	process.exit(failures ? 1 : 0);
}

main().catch((err) => {
	console.error("✗ dsh-mcp crashed:", err.message);
	try {
		server.kill();
	} catch {
		/* ignore */
	}
	process.exit(1);
});
