// One-shot JSON-RPC probe for the pi-web-ui DSH runtime (mixed-tree layout):
// dsh-base rows resolve from the GLOBAL runtime tree; the jsonrpc plugin
// mounts by absolute path into the PROJECT node_modules.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveRuntimeBase } from "./runtime/runtime-root.mjs";

const HERE = resolve(import.meta.dirname ?? ".");
const KEY = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8")).deepseek.key;
const JSONRPC_ENTRY = resolve(
	HERE,
	"..",
	"..",
	"node_modules",
	"@deepseek-ai",
	"dsh-sdk-jsonrpc-server",
	"lib",
	"index.js",
);

// 1) 验证运行时树解析（launcher 内部逻辑的镜像 —— 直接复用共享模块）
const rtBase = await resolveRuntimeBase();
console.log("runtime base ->", rtBase);
if (!rtBase) {
	console.error("!! 运行时树解析失败 —— launcher 将无法启动");
	process.exit(1);
}
const { existsSync } = await import("node:fs");
console.log("has dsh-base bundle:", existsSync(join(rtBase, "@deepseek-ai", "dsh-base", "cordis.patch.yml")));
console.log("has dsh-app-boot:", existsSync(join(rtBase, "@deepseek-ai", "dsh-app-boot", "lib", "index.js")));
console.log("jsonrpc entry exists:", existsSync(JSONRPC_ENTRY));

// 2) 启动 launcher 子进程
const proc = spawn(process.execPath, [join(HERE, "runtime", "launcher.mjs")], {
	cwd: HERE,
	env: {
		...process.env,
		DEEPSEEK_API_KEY: KEY,
		PI_WEB_DSH_JSONRPC_ENTRY: JSONRPC_ENTRY,
		DSH_SESSION_ROOT: join(HERE, "..", "..", ".tmp-sessions"),
		DSH_CWD: HERE,
	},
	stdio: ["pipe", "pipe", "pipe"],
});
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (d) => process.stderr.write("[rt] " + d));

// 子进程提前退出 → 立刻炸掉所有未决请求，不演 120s 死等。
proc.on("exit", (code, signal) => {
	for (const [, p] of pending) {
		p.reject(new Error(`launcher exited early (code=${code} signal=${signal})`));
	}
	pending.clear();
});

let buf = "";
let nextId = 1;
const pending = new Map();
const events = [];
const send = (method, params, timeoutMs = 120_000) =>
	new Promise((resolve2, reject) => {
		const id = nextId++;
		const t = setTimeout(() => {
			pending.delete(id);
			reject(new Error(method + " timeout"));
		}, timeoutMs);
		pending.set(id, {
			resolve: (v) => {
				clearTimeout(t);
				resolve2(v);
			},
			reject: (e) => {
				clearTimeout(t);
				reject(e);
			},
		});
		proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
	});
proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (chunk) => {
	buf += chunk;
	let i;
	while ((i = buf.indexOf("\n")) !== -1) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			continue;
		}
		if (msg.id !== undefined && msg.id !== null) {
			const p = pending.get(msg.id);
			if (!p) continue;
			pending.delete(msg.id);
			if (msg.error) {
				p.reject(new Error(JSON.stringify(msg.error)));
			} else {
				p.resolve(msg.result);
			}
		} else if (msg.method) {
			events.push({ method: msg.method, params: msg.params });
		}
	}
});

try {
	await new Promise((r) => setTimeout(r, 5000));
	console.log("== initialize ==");
	const init = await send("initialize", {
		cwd: HERE,
		provider: "deepseek-official",
		model: "deepseek-v4-flash",
		maxTokens: 128,
	});
	console.log("  ok:", JSON.stringify(init).slice(0, 160));
	const rec = await send("session/prompt", {
		sessionId: "probe-mixed",
		contentBlocks: [
			{
				type: "text",
				text: "Reply with exactly the four words: mixed tree works. No tools.",
			},
		],
	});
	console.log("== prompt ==", JSON.stringify(rec).slice(0, 120));
	await new Promise((r) => setTimeout(r, 45000));
	const kinds = {};
	for (const e of events) {
		const t = e.params?.event?.type ?? e.method;
		kinds[t] = (kinds[t] ?? 0) + 1;
	}
	console.log("== event kinds ==", JSON.stringify(kinds));
	const text = events
		.filter((e) => e.params?.event?.type === "assistant/chunk")
		.map((c) => {
			const d = c.params.event.data?.chunk;
			return d?.type === "text-delta" ? d.text : "";
		})
		.join("");
	console.log("assembled text:", JSON.stringify(text.slice(0, 160)));
	await send("shutdown", {}, 5000).catch(() => {});
	console.log("== shutdown ok ==");
} catch (err) {
	console.error("PROBE FAILED:", err.message);
}
setTimeout(() => process.exit(0), 1500);
