/**
 * dsh 引擎用户提问桥测试（真 key 门控）——模型 ask_user_question →
 * question_pending 通知 → 前端 question_answer 回答 → 模型收到答案继续。
 *
 * 需要真实的 DeepSeek API key。无 key 时打印 SKIP 并退出 0。
 *
 * 用法：node tests/dsh-question-test.mjs   （先 npm run build）
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";
import { portUp } from "./lib/port-utils.mjs";
import { setTimeout as sleep } from "node:timers/promises";

const REPO = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8935;
const CLIENT_ID = "dsh-question-test";

// 真 key 门控。
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

const server = spawn("node", ["dist/server/index.js"], {
	cwd: REPO,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: mkdtempSync(join(tmpdir(), "dsh-question-")),
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

async function main() {
	const c = await connect(CLIENT_ID);
	c.send({ type: "hello", clientId: CLIENT_ID, protocolVersion: 1 });
	await c.wait((m) => m.type === "ready");
	await c.wait((m) => m.type === "goal_status");
	console.log("attached");
	await sleep(2500);

	// prompt 引导模型提问（答案无歧义，模型大概率走提问）。
	c.send({
		type: "prompt",
		text: "请用 ask_user_question 工具问我一个简单问题：'你最喜欢哪种颜色？'（选项红/蓝/绿），然后根据我的回答用一句话回应。",
	});

	// --- 1. 等 question_pending ---
	const pending = await c.wait((m) => m.type === "question_pending", 90_000).catch(() => null);
	check(
		"模型 ask_user_question → question_pending",
		!!pending && pending.questions.length > 0,
		JSON.stringify(pending?.questions ?? []).slice(0, 200),
	);
	if (!pending) {
		c.close();
		server.kill();
		console.log("\n===== dsh-question FAIL =====");
		process.exit(1);
	}

	// --- 2. question_answer 回答 ---
	c.send({
		type: "question_answer",
		id: pending.id,
		answers: pending.questions.map((q) => ({
			id: q.id,
			selected: q.options?.length ? [q.options[0].label] : [],
			...(q.options?.length ? {} : { custom: "深蓝色" }),
		})),
	});
	check("question_answer 已发送", true);

	// --- 3. 模型收到答案继续（assistantMessageEvent text_delta，逐字推送） ---
	const t0 = Date.now();
	let repliedText = "";
	while (Date.now() - t0 < 90_000 && repliedText.length < 4) {
		const msg = await c
			.wait(
				(m) =>
					m.type === "message_delta" &&
					m.assistantMessageEvent?.type === "text_delta" &&
					typeof m.assistantMessageEvent.delta === "string" &&
					m.assistantMessageEvent.delta.length > 0,
				3000,
			)
			.catch(() => null);
		if (msg) repliedText += msg.assistantMessageEvent.delta;
	}
	check("模型收到答案后继续回复（text_delta）", repliedText.length >= 4, JSON.stringify(repliedText.slice(0, 60)));

	c.close();
	server.kill();
	console.log(`\n===== dsh-question ${failures === 0 ? "PASS" : `FAIL (${failures})`} =====`);
	process.exit(failures ? 1 : 0);
}

main().catch((err) => {
	console.error("✗ dsh-question crashed:", err.message);
	server.kill();
	process.exit(1);
});
