/**
 * dsh 引擎工具桥测试（真 key 门控）——插件 registerAgentTool 工具经
 * tools/sync 注册进运行时，模型真实调用桥接工具，插件 execute 在服务端跑，
 * 结果经 tools/call-result 回传模型并出现在对话里。
 *
 * 需要一个在临时 dataDir 里种一个注册 test_echo 工具的最小插件。
 * 无 key / 无运行时树时打印 SKIP 并退出 0。
 *
 * 用法：node tests/dsh-tools-test.mjs   （先 npm run build）
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
const PORT = 8940;
const CLIENT_ID = "dsh-tools-test";
const MARKER = "DSH_MARKER_13579";

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

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

// ---- 种一个注册 test_echo 工具的最小插件 ----
const dataDir = mkdtempSync(join(tmpdir(), "dsh-tools-"));
const plugDir = join(dataDir, "plugins", "glue-tool");
mkdirSync(plugDir, { recursive: true });
writeFileSync(
	join(plugDir, "manifest.json"),
	JSON.stringify({ name: "glue", version: "0.0.1", description: "test tools bridge", permissions: ["tools"] }),
);
writeFileSync(
	join(plugDir, "index.mjs"),
	`export default {
		activate(host) {
			return host.registerAgentTool({
				name: "test_echo",
				label: "测试回显",
				description: "把传入的 message 原样回显（前缀 ECHO:）。测试工具桥用。",
				parameters: {
					type: "object",
					properties: { message: { type: "string", description: "要回显的消息" } },
					required: ["message"],
				},
				execute: (callId, args) => "ECHO:" + (args && args.message !== undefined ? String(args.message) : ""),
			});
		},
	};`,
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

/** 从消息里提取全部文本（snapshot.state.messages / snapshot_delta.appended）。 */
function allTexts(msg) {
	const out = [];
	const walk = (arr) => {
		if (!Array.isArray(arr)) return;
		for (const m of arr) {
			if (!m || typeof m !== "object") continue;
			if (Array.isArray(m.content)) {
				for (const c of m.content) {
					if (c && typeof c.text === "string") out.push(c.text);
				}
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

	// 等运行时启动 + 工具桥 sync 完成（onStarted → syncPluginTools）。
	await sleep(4000);

	// 让模型调用桥接工具并把结果原样回传。
	c.send({
		type: "prompt",
		text: `请调用 test_echo 工具，参数 message = ${MARKER}。工具跑完后，把工具返回的完整内容原样告诉我（不要加任何解释）。`,
	});

	const t0 = Date.now();
	const seen = { toolResultEcho: false, markerInConversation: false };
	const markerSeen = {};
	while (Date.now() - t0 < 120_000) {
		// 逐个消费队列里的 snapshot/snapshot_delta，检查是否出现桥接工具结果。
		const msg = await c.wait((m) => m.type === "snapshot" || m.type === "snapshot_delta", 1000).catch(() => null);
		if (!msg) continue;
		const text = allTexts(msg);
		if (text.includes("ECHO:")) seen.toolResultEcho = true;
		if (text.includes(MARKER)) {
			seen.markerInConversation = true;
			markerSeen.text = text;
		}
		if (seen.toolResultEcho && seen.markerInConversation) break;
	}

	check("桥接工具结果 (ECHO:) 出现在对话里", seen.toolResultEcho, markerSeen.text?.slice(0, 200));
	check("模型回复包含回显 marker", seen.markerInConversation, markerSeen.text?.slice(0, 200));

	c.close();
	server.kill();
	// 给服务端一点时间优雅退出（避免清理残留）。
	await sleep(300);
	console.log(`\n===== dsh-tools ${failures === 0 ? "PASS" : `FAIL (${failures})`} =====`);
	process.exit(failures ? 1 : 0);
}

main().catch((err) => {
	console.error("✗ dsh-tools crashed:", err.message);
	try {
		server.kill();
	} catch {
		/* ignore */
	}
	process.exit(1);
});
