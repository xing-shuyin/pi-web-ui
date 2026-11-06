#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import WebSocket from "ws";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform === "win32") {
	console.log(
		"SKIP shutdown-test — win32 下跨进程 SIGINT 到不了服务进程的 handler（直接按信号死亡），不断言退出码；ubuntu CI 正常跑",
	);
	process.exit(0);
}
const PORT = Number(process.argv[2] || 8983);
const base = mkdtempSync(join(tmpdir(), "pi-web-shutdown-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const NODE = realpathSync(process.execPath);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, cond, extra = "") {
	if (cond) {
		console.log(`  ok - ${name}`);
	} else {
		failed++;
		console.error(`  FAIL - ${name} ${extra}`);
	}
}

const server = spawn(NODE, [join(repoRoot, "dist", "server", "index.js")], {
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
server.stdout.on("data", () => {});
server.stderr.on("data", () => {});
const serverExited = new Promise((resolve) => {
	server.on("exit", (code, signal) => resolve({ code, signal }));
});

try {
	let up = false;
	for (let i = 0; i < 60; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
			if (res.ok) {
				up = true;
				break;
			}
		} catch {}
		await sleep(300);
	}
	check("server booted", up);
	if (!up) throw new Error("server did not become ready");

	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});
	ws.send(JSON.stringify({ type: "hello", clientId: "shutdown-probe", locale: "zh-CN" }));
	ws.on("error", () => {});
	await sleep(800);

	const stuck = connect(PORT, "127.0.0.1");
	stuck.on("error", () => {});
	await new Promise((resolve) => stuck.on("connect", resolve));
	stuck.write(
		`POST /api/health HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\n` +
			`Content-Length: 8192\r\nConnection: keep-alive\r\n\r\nPARTIAL-BODY`,
	);

	const t0 = Date.now();
	server.kill("SIGINT");
	const outcome = await Promise.race([serverExited, sleep(20000).then(() => null)]);
	const elapsed = Date.now() - t0;
	if (outcome === null) {
		check("SIGINT → process exits by itself within 20s", false, "(no exit; SIGKILLing)");
		try {
			server.kill("SIGKILL");
		} catch {}
		await serverExited;
	} else {
		check("SIGINT → process exits by itself within 20s", true, `(${(elapsed / 1000).toFixed(1)}s)`);
		check("exit code is 0 (clean shutdown, watchdog not fired)", outcome.code === 0, JSON.stringify(outcome));
	}
	ws.terminate();
	stuck.destroy();
	console.log(`\n${failed === 0 ? "PASS" : "FAIL"} shutdown-test`);
} catch (err) {
	failed++;
	console.error("test crashed:", err);
	try {
		server.kill("SIGKILL");
	} catch {}
	await serverExited;
} finally {
	process.exit(failed === 0 ? 0 : 1);
}
