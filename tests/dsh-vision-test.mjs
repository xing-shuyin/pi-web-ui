/**
 * dsh 引擎视觉桥测试（真 key 门控）——base64 图片附件（imageData）→
 * attachment/save → 真 image 块 → vision-exp 模型看图回复。
 *
 * 需要真实 DeepSeek API key + 模型目录含 deepseek-v4-flash-vision-exp。
 * 无 key 时打印 SKIP 并退出 0。
 *
 * 用法：node tests/dsh-vision-test.mjs   （先 npm run build）
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";
import { portUp } from "./lib/port-utils.mjs";
import { setTimeout as sleep } from "node:timers/promises";

const REPO = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8937;
const CLIENT_ID = "dsh-vision-test";

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

const IMG = join(REPO, "assets", "shot1.png");
if (!existsSync(IMG)) {
	console.log(`⏭ SKIP：缺少测试图片 ${IMG}`);
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
		PI_WEB_DATA_DIR: mkdtempSync(join(tmpdir(), "dsh-vision-")),
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

	// 切到 vision 模型（模型目录动态化后无需本地表白名单）。
	await sleep(2500);
	c.send({ type: "set_model", modelId: "deepseek-v4-flash-vision-exp" });
	await sleep(8000); // 换模型 = 重启运行时，等 vision 模型 boot 完成

	// 图片 base64 附件 → prompt。
	const png = readFileSync(IMG);
	const imageData = png.toString("base64");
	c.send({
		type: "prompt",
		text: "这张截图里显示的是什么应用或界面？用一句话回答，并说出你看到的任何文字。",
		attachments: [
			{
				path: "",
				name: "shot1.png",
				kind: "inline",
				imageData,
			},
		],
	});

	// 等模型回复（逐字 text_delta 累计）。
	const t0 = Date.now();
	let repliedText = "";
	while (Date.now() - t0 < 120_000 && repliedText.length < 8) {
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
	check("vision-exp 模型看图回复（text_delta）", repliedText.length >= 8, JSON.stringify(repliedText.slice(0, 100)));

	c.close();
	server.kill();
	console.log(`\n===== dsh-vision ${failures === 0 ? "PASS" : `FAIL (${failures})`} =====`);
	process.exit(failures ? 1 : 0);
}

main().catch((err) => {
	console.error("✗ dsh-vision crashed:", err.message);
	server.kill();
	process.exit(1);
});
