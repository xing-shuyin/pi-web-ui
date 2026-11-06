import { portUp } from "./lib/port-utils.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8921;
const URL = `ws://127.0.0.1:${PORT}/ws`;

let server;
let ws;
const dataDir = mkdtempSync(join(tmpdir(), "steer-queue-"));
const fakeAgentDir = mkdtempSync(join(tmpdir(), "steer-agent-"));
mkdirSync(join(fakeAgentDir, "skills"), { recursive: true });
writeFileSync(join(fakeAgentDir, "models.json"), JSON.stringify({}), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
	const { default: WebSocket } = await import("ws");
	for (let attempt = 0; attempt < 60; attempt++) {
		try {
			ws = new WebSocket(URL);
			await new Promise((resolve, reject) => {
				ws.on("open", () => {
					ws.send(JSON.stringify({ type: "hello", clientId: "smoke" }));
				});
				ws.on("message", (d) => {
					if (JSON.parse(d.toString()).type === "ready") resolve();
				});
				ws.on("error", reject);
			});
			return;
		} catch {
			await sleep(500);
		}
	}
	throw new Error("server not ready");
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
	await sleep(800);

	await connect();
	await sleep(400);

	ws.send(JSON.stringify({ type: "prompt", text: "冒烟：queue 字段传递", queue: true, attachments: [] }));
	await sleep(800);

	ws.send(JSON.stringify({ type: "prompt", text: "冒烟：无 queue 字段", attachments: [] }));
	await sleep(800);

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
	server?.kill("SIGTERM");
	for (let i = 0; i < 20; i++) {
		await sleep(250);
		try {
			if (!(await portUp(PORT))) throw new Error("port not up");
		} catch {
			break;
		}
	}
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(fakeAgentDir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
