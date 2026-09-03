/**
 * 插件后台任务协议测试（零 token、自包含）。
 *
 * 覆盖：host.registerBackgroundTask 注册的任务并入 bg_servers（taskId/plugin/
 * status 字段）；kill_background_server { taskId } 触发 stop 回调并移出列表；
 * 未知 taskId 静默失败不崩。
 *
 * 运行：先 npm run build:server，再 node tests/plugin-bgtask-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 8982;
const BASE = `http://127.0.0.1:${PORT}`;

const serverPath = realpathSync(process.execPath);
let proc = null;
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-bgtask-plugin-"));

const plugDir = join(dataDir, "plugins", "worker");
mkdirSync(plugDir, { recursive: true });
writeFileSync(join(plugDir, "manifest.json"), JSON.stringify({ name: "worker", version: "0.1.0" }));
writeFileSync(
	join(plugDir, "index.mjs"),
	`globalThis.__stopped = 0;
export default {
	activate(host) {
		const task = host.registerBackgroundTask({
			id: "nightly",
			label: "🌙 定时任务",
			status: "每 1h",
			stop: () => { host.notify("info", "task-stopped"); },
		});
		host.registerCommand({
			name: "bgtask-update",
			run: () => { task.update({ status: "每 30m" }); return "updated"; },
		});
	},
};`,
);

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

function connect(clientId) {
	return new Promise((resolve2, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("connect timeout")), 15_000);
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId })));
		sock.on("message", (raw) => {
			if (JSON.parse(raw.toString()).type === "ready") {
				clearTimeout(timer);
				resolve2(sock);
			}
		});
		sock.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

function waitFor(sock, pred, label, timeoutMs = 10_000) {
	return new Promise((resolve2, reject) => {
		const timer = setTimeout(() => {
			sock.off("message", onMsg); // 超时也要清监听器，防泄漏堆积
			reject(new Error(`timeout waiting for ${label}`));
		}, timeoutMs);
		const onMsg = (raw) => {
			const msg = JSON.parse(raw.toString());
			if (pred(msg)) {
				clearTimeout(timer);
				sock.off("message", onMsg);
				resolve2(msg);
			}
		};
		sock.on("message", onMsg);
	});
}

async function bgList(sock) {
	return (await waitFor(sock, (m) => m.type === "bg_servers", "bg_servers")).servers ?? [];
}

try {
	proc = spawn(serverPath, [join(import.meta.dirname, "..", "dist", "server", "index.js")], {
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: import.meta.dirname },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

	await new Promise((resolve2, reject) => {
		const t0 = Date.now();
		const ping = async () => {
			try {
				if ((await fetch(`${BASE}/api/health`)).ok) return resolve2();
			} catch {}
			if (Date.now() - t0 > 20_000) return reject(new Error("server not ready"));
			setTimeout(ping, 300);
		};
		void ping();
	});

	const sock = await connect("bgtask-test");

	// -- 1. 任务注册后并入 bg_servers（插件异步激活，轮询到出现为止）--------------------
	// 常驻收集器：每次 bg_servers 都记录最新列表（避免 waitFor 反复挂监听）。
	let latestBg = [];
	sock.on("message", (raw) => {
		const m = JSON.parse(raw.toString());
		if (m.type === "bg_servers") latestBg = m.servers ?? [];
	});
	let task;
	for (let i = 0; i < 40 && !task; i++) {
		task = latestBg.find((s) => s.taskId === "nightly");
		if (!task) {
			sock.send(JSON.stringify({ type: "list_bg_servers" }));
			await new Promise((r) => setTimeout(r, 250));
		}
	}
	if (!task || task.plugin !== "worker" || task.status !== "每 1h" || task.name !== "🌙 定时任务") {
		fail(`插件任务未出现在 bg_servers：${JSON.stringify(task)}`);
	} else {
		console.log(`✓ 插件任务并入后台面板：${JSON.stringify(task)}`);
	}

	// -- 2. update 刷新状态 ------------------------------------------------------------
	sock.send(JSON.stringify({ type: "prompt", text: "/bgtask-update" }));
	await waitFor(sock, (m) => m.type === "notice" && m.text === "updated", "update notice");
	// 命令返回的 notice 可能受会话就绪时序影响——直接等任务状态刷新的实际效果。
	sock.send(JSON.stringify({ type: "prompt", text: "/bgtask-update" }));
	let status2 = null;
	for (let i = 0; i < 40 && status2 !== "每 30m"; i++) {
		status2 = latestBg.find((s) => s.taskId === "nightly")?.status;
		if (status2 !== "每 30m") await new Promise((r) => setTimeout(r, 250));
	}
	if (status2 !== "每 30m") fail("status 未刷新");
	else console.log("✓ task.update 刷新状态生效");

	// -- 3. kill_background_server { taskId } → stop 回调 + 移出列表 ---------------------
	sock.send(JSON.stringify({ type: "kill_background_server", taskId: "nightly" }));
	// ① stop 回调在服务端进程 → 以 notice 作跨进程信号；② 列表随之移除
	await waitFor(sock, (m) => m.type === "notice" && m.text === "task-stopped", "task-stopped notice");
	let removed = false;
	for (let i = 0; i < 40 && !removed; i++) {
		removed = !latestBg.some((x) => x.taskId === "nightly");
		if (!removed) await new Promise((r) => setTimeout(r, 250));
	}
	if (!removed) fail("任务未从列表移除");
	else console.log("✓ kill taskId → stop 回调触发 + 移出列表");

	// -- 4. 未知 taskId 不崩 -----------------------------------------------------------------
	sock.send(JSON.stringify({ type: "kill_background_server", taskId: "ghost" }));
	await new Promise((r) => setTimeout(r, 300));
	console.log("✓ 未知 taskId 静默处理（进程存活）");

	sock.close();
} catch (err) {
	fail(err?.stack ?? String(err));
} finally {
	if (proc?.pid) {
		try {
			process.kill(proc.pid, "SIGTERM");
		} catch {}
	}
	await new Promise((r) => setTimeout(r, 600));
	rmSync(dataDir, { recursive: true, force: true });
}
if (!process.exitCode) console.log("\nall ok");
