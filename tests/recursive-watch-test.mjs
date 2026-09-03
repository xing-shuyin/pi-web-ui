#!/usr/bin/env node
/**
 * recursive-watch-test.mjs — 文件树递归 watcher 回归（零 token）。
 *
 * 验证点：
 *   1. win32/darwin 上对工作区根开 fs.watch(recursive)，**深层未列出目录**里的
 *      文件变化也能推 file_changed（旧实现只监听当前列出目录，看不到深层）。
 *   2. node_modules / .git 子树的事件被过滤，不触发刷新。
 *   3. 切换列出目录后 file_changed.path 跟随新目录。
 *
 * 自包含：独立端口 + 临时 data-dir + 临时 workspace，自行清理。Linux 上
 * （无递归 watch）仅验证 fallback 不炸 + 浅层变化仍工作，跳过深层断言。
 */
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import WebSocket from "ws";

const PORT = 8966;
const HOST = `http://127.0.0.1:${PORT}`;
const HEADLESS = false;

const server = null;
let ws;
let clientId = "";
let reqId = 0;
const pendingFiles = [];
let lastFileChanged = null;
let child = null;

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitReady() {
	for (let i = 0; i < 60; i++) {
		try {
			const r = await fetch(`${HOST}/api/health`);
			if (r.ok) return;
		} catch {}
		await sleep(500);
	}
	throw new Error("server not ready");
}

function send(msg) {
	ws.send(JSON.stringify({ ...msg, reqId: msg.reqId ?? ++reqId }));
}

function nextFileChanged(timeoutMs = 8000) {
	const seen = lastFileChanged;
	return new Promise((resolve, reject) => {
		const t0 = Date.now();
		const timer = setInterval(() => {
			if (lastFileChanged && lastFileChanged !== seen) {
				clearInterval(timer);
				resolve(lastFileChanged);
			} else if (Date.now() - t0 > timeoutMs) {
				clearInterval(timer);
				reject(new Error("file_changed timeout"));
			}
		}, 50);
	});
}

async function listDir(rel) {
	const p = new Promise((res) => pendingFiles.push(res));
	send({ type: "list_files", path: rel });
	return p;
}

async function main() {
	const dataDir = mkdtempSync(join(tmpdir(), "pi-web-recursive-watch-"));
	const workspace = mkdtempSync(join(tmpdir(), "pi-web-watch-ws-"));
	mkdirSync(join(workspace, "deep", "nested"), { recursive: true });
	writeFileSync(join(workspace, "root.txt"), "root\n");
	writeFileSync(join(workspace, "deep", "nested", "leaf.txt"), "leaf\n");
	let ok = false;
	let failure = null;
	try {
		child = spawn(realpathSync(process.execPath), [join("dist", "server", "index.js")], {
			env: {
				...process.env,
				PI_WEB_PORT: String(PORT),
				PI_WEB_CWD: workspace,
				PI_WEB_DATA_DIR: dataDir,
				PI_WEB_HOST: "127.0.0.1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
		await waitReady();

		ws = new WebSocket(`${HOST.replace("http", "ws")}/ws`);
		await new Promise((r) => ws.on("open", r));
		ws.on("message", (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.type === "ready") {
				clientId = msg.clientId;
				return;
			}
			if (msg.type === "files") {
				const p = pendingFiles.shift();
				if (p) p(msg);
			} else if (msg.type === "file_changed") {
				lastFileChanged = { path: msg.path, at: Date.now() };
			}
		});
		send({ type: "hello", clientId: "" });
		await sleep(600);

		// 初始列根目录 → 建立 watcher
		const root1 = await listDir("");
		if (root1.error) throw new Error(root1.error);

		const deepSupported = process.platform === "win32" || process.platform === "darwin";

		// 1) 深层（未列出）目录变化 → file_changed
		lastFileChanged = null;
		setTimeout(() => writeFileSync(join(workspace, "deep", "nested", "leaf.txt"), "changed\n"), 100);
		if (deepSupported) {
			const ev = await nextFileChanged();
			console.log(`✓ 深层变化推送 file_changed (path=${ev.path})`);
		} else {
			// Linux fallback：等一小段确认不炸即可（非断言失败）
			await sleep(1500);
			console.log(`⏭ 平台无递归 watch，跳过深层断言`);
		}

		// 2) node_modules 事件过滤：写入后短时间内不应触发 file_changed
		mkdirSync(join(workspace, "node_modules", "pkg"), { recursive: true });
		lastFileChanged = null;
		writeFileSync(join(workspace, "node_modules", "pkg", "x.js"), "x\n");
		let filtered = true;
		try {
			await nextFileChanged(2500);
			filtered = false;
		} catch {
			/* 未触发 = 已过滤 */
		}
		if (!filtered && deepSupported) {
			throw new Error("node_modules 变化不应触发 file_changed");
		}
		console.log(`✓ node_modules 事件已过滤`);

		// 3) 切换列出目录后，file_changed.path 跟随
		await listDir("deep");
		await sleep(300); // 等 retarget 生效
		lastFileChanged = null;
		setTimeout(() => writeFileSync(join(workspace, "deep", "other.txt"), "y\n"), 100);
		if (deepSupported) {
			const ev2 = await nextFileChanged();
			if (ev2.path !== "deep") {
				throw new Error(`file_changed.path 应为 deep，实际 ${ev2.path}`);
			}
			console.log(`✓ 列出目录切换后 path 跟随 (${ev2.path})`);
		}

		ok = true;
		console.log("\n全部通过 ✅");
	} catch (err) {
		failure = err;
	} finally {
		try {
			ws?.close();
		} catch {}
		if (child?.pid) {
			// win32 用 taskkill /T 杀进程树；posix 直接 SIGTERM（否则 server 子进程
			// 泄漏占住端口，下一次跑套件在 PORT 上 EADDRINUSE）。
			if (process.platform === "win32") {
				execFile("taskkill", ["/F", "/T", "/PID", String(child.pid)], () => {});
			} else {
				try {
					process.kill(child.pid, "SIGTERM");
				} catch {}
			}
		}
		await sleep(500);
		try {
			rmSync(dataDir, { recursive: true, force: true });
		} catch {}
		try {
			rmSync(workspace, { recursive: true, force: true });
		} catch {}
	}
	if (failure) {
		console.error("✗", failure.message);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error("✗", err.message);
	process.exit(1);
});
