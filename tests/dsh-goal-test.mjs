/**
 * dsh 引擎目标全链路测试（真 key 门控）——DSH 原生 goal 域经 WS 协议：
 *   set_goal → goal_status（进行中）→ round-driver 自动续轮 → 模型自判定
 *   complete → goal_status（✅ 已达成）→ clear_goal → 清空。
 *
 * 需要真实的 DeepSeek API key（<agentDir>/auth.json 的 deepseek.key 或
 * DEEPSEEK_API_KEY 环境变量）。无 key 时打印 SKIP 并退出 0（CI 不误报）。
 *
 * 用法：node tests/dsh-goal-test.mjs   （先 npm run build）
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { portUp } from "./lib/port-utils.mjs";
import { setTimeout as sleep } from "node:timers/promises";

const REPO = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8933;
const CLIENT_ID = "dsh-goal-test";

// 真 key 门控：auth.json 或环境变量。
let key = process.env.DEEPSEEK_API_KEY;
if (!key) {
	try {
		const authPath = join(homedir(), ".pi", "agent", "auth.json");
		if (existsSync(authPath)) {
			const auth = JSON.parse((await import("node:fs")).readFileSync(authPath, "utf8"));
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
// 运行时树检测：无树 → SKIP。
let rtAvailable = false;
try {
	const { resolveRuntimeBase } = await import(
		(await import("node:url")).pathToFileURL(join(REPO, "server", "dsh", "runtime", "runtime-root.mjs")).href
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

const server = spawn("node", ["dist/server/index.js"], {
	cwd: REPO,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: mkdtempSync(join(tmpdir(), "dsh-goal-")),
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
							// 超时：从 waiters 移除自己，避免 stale pred 静默消费后续新消息。
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

async function main() {
	const c = await connect(CLIENT_ID);
	c.send({ type: "hello", clientId: CLIENT_ID, protocolVersion: 1 });
	await c.wait((m) => m.type === "ready");
	await c.wait((m) => m.type === "goal_status");
	console.log("attached");

	// 等运行时就绪（boot ~1s），再设目标。
	await sleep(2500);

	// --- 1. set_goal → goal_status 流转（active → reviewing） ---
	const t0 = Date.now();
	c.send({
		type: "set_goal",
		goal: "用一句话回答 2+2 等于几，然后调用 update_goal complete 结束这个目标。",
		maxRounds: 3,
		locked: true,
	});
	let activeSeen = false;
	let passSeen = false;
	let deadline = Date.now() + 120_000;
	while (Date.now() < deadline && !passSeen) {
		const msg = await c.wait((m) => m.type === "goal_status" && m.status, 3000).catch(() => null);
		if (!msg) continue;
		const s = msg.status;
		if (s.goal?.includes("2+2") && s.reviewing) activeSeen = true;
		if (s.verdict === "pass") passSeen = true;
	}
	check("set_goal → goal_status 进行中", activeSeen);
	check("round-driver 自动续轮 → 模型完成 → verdict=pass", passSeen, `耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

	// --- 2. clear_goal → 清空 ---
	c.send({ type: "clear_goal" });
	let cleared = false;
	deadline = Date.now() + 10_000;
	while (Date.now() < deadline && !cleared) {
		const msg = await c.wait((m) => m.type === "goal_status", 3000).catch(() => null);
		if (msg && !msg.status.goal && msg.status.verdict === "pending") cleared = true;
	}
	check("clear_goal → goal_status 清空", cleared);

	c.close();
	server.kill();
	console.log(`\n===== dsh-goal ${failures === 0 ? "PASS" : `FAIL (${failures})`} =====`);
	process.exit(failures ? 1 : 0);
}

main().catch((err) => {
	console.error("✗ dsh-goal crashed:", err.message);
	server.kill();
	process.exit(1);
});
