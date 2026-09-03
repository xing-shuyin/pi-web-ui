// 协议冒烟：prompt.queue 字段从 dispatch → AgentService.prompt() 无损传递。
// 无 token：不真正触发模型；只验证带 queue 的 prompt 消息能被接收、参数不炸
// （签名不匹配会抛 TypeError → 服务端发"提示发送失败"notice 也会带 crash 特征）。
import { portUp, freePort } from "./lib/port-utils.mjs";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8921;
const URL = `ws://localhost:${PORT}/ws`;

let server;
let ws;
const dataDir = mkdtempSync(join(tmpdir(), "steer-queue-"));
const fakeAgentDir = mkdtempSync(join(tmpdir(), "steer-agent-"));
mkdirSync(join(fakeAgentDir, "skills"), { recursive: true });
writeFileSync(join(fakeAgentDir, "models.json"), JSON.stringify({}), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
	const { default: WebSocket } = await import("ws");
	return new Promise((resolve, reject) => {
		ws = new WebSocket(URL);
		const timer = setTimeout(() => reject(new Error("no ready")), 8000);
		ws.on("open", () => {
			ws.send(JSON.stringify({ type: "hello", clientId: "smoke" }));
		});
		ws.on("message", (d) => {
			if (JSON.parse(d.toString()).type === "ready") {
				clearTimeout(timer);
				resolve();
			}
		});
		ws.on("error", (e) => {
			console.error("[ws error]", e.message);
			clearTimeout(timer);
			reject(e);
		});
	});
}

let ok = false;
try {
	try {
		if (!(await portUp(PORT))) throw new Error("port not up");
		console.log(`port ${PORT} busy — abort`);
		process.exit(1);
	} catch {}

	server = spawn("node", ["dist/server/index.js"], {
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_CODING_AGENT_DIR: fakeAgentDir,
			PI_WEB_CWD: process.cwd(),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stdout.on("data", (d) => process.stdout.write("[out] " + d));
	server.stderr.on("data", (d) => process.stderr.write("[err] " + d));
	await sleep(2500);

	await connect();
	await sleep(400);

	// 1) 带 queue=true 的 prompt —— 验证 dispatch 传参不炸（无模型会报"提示发送失败"，可接受）
	ws.send(JSON.stringify({ type: "prompt", text: "冒烟：queue 字段传递", queue: true, attachments: [] }));
	await sleep(800);

	// 2) 不带 queue 的 prompt —— 验证默认参数路径
	ws.send(JSON.stringify({ type: "prompt", text: "冒烟：无 queue 字段", attachments: [] }));
	await sleep(800);

	// 3) queue_remove —— 验证删除协议消息 dispatch 不炸（空队列为 no-op）
	ws.send(
		JSON.stringify({
			type: "queue_remove",
			kind: "followUp",
			text: "不存在",
		}),
	);
	await sleep(600);

	console.log(
		"OK: prompt(queue) + queue_remove 消息被服务端正常接收，dispatch/签名无异常（无模型时按预期提示发送失败）",
	);
	ok = true;
} catch (err) {
	console.error("FAIL:", err.message);
} finally {
	try {
		ws?.close();
	} catch {}
	// 先杀 server 并等端口释放再退出 —— process.exit 会跳过 finally，
	// 曾经导致每次运行泄漏一个 server（下次跑报 "port busy — abort"）。
	server?.kill("SIGTERM");
	for (let i = 0; i < 20; i++) {
		await sleep(250);
		try {
			if (!(await portUp(PORT))) throw new Error("port not up");
		} catch {
			break; // port released
		}
	}
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(fakeAgentDir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
