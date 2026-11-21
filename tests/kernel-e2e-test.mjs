#!/usr/bin/env node
/**
 * 内核单实例 / 数据目录锁的端到端验收（真实进程、真实 HTTP，不用 mock）。
 *
 * 覆盖 docs/architecture-kernel.md §3 §6：
 *   1. /api/health 带 kernel 块，且不含 pid / 路径（免鉴权端点的信息面）
 *   2. 同数据目录起第二个内核 → 退出码 1 且给出三条出路
 *   3. PI_WEB_ALLOW_MULTI_INSTANCE=1 → 能起，且 lock 报 disabled
 *   4. 持有者被强杀（残留 kernel.lock）→ 下一个内核陈旧接管，正常启动
 *
 * 用法：node scripts/build-server.mjs && node tests/kernel-e2e-test.mjs
 * 端口一律 ≥8900，数据目录一律 mkdtemp，禁止 pkill -f（Windows 用 taskkill /T /F）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const serverEntry = join(root, "dist", "server", "index.js");
const timers = [];
const children = new Set();

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

/** 起一个内核进程，返回 { child, port, url, log() }。 */
async function startKernel({ dataDir, cwd, port, env = {} }) {
	const child = spawn(process.execPath, [serverEntry, "--port", String(port), "--data-dir", dataDir, "--cwd", cwd], {
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	children.add(child);
	let out = "";
	let err = "";
	child.stdout.on("data", (c) => {
		out = (out + c.toString("utf8")).slice(-8000);
	});
	child.stderr.on("data", (c) => {
		err = (err + c.toString("utf8")).slice(-8000);
	});
	const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code ?? -1)));
	return { child, port, url: `http://127.0.0.1:${port}`, exited, log: () => `${out}\n${err}` };
}

async function waitHealth(url, timeoutMs = 25_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
			if (response.ok) return await response.json();
		} catch {}
		await sleep(250);
	}
	throw new Error(`等待 ${url}/api/health 超时`);
}

function sleep(ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timers.push(timer);
	});
}

/** 杀进程树：Windows 必须 /T /F，否则端口/句柄不放；其它平台先 TERM 再 KILL。 */
async function killKernel(handle) {
	if (!handle || handle.child.exitCode !== null) return;
	const p = handle.child;
	if (process.platform === "win32") {
		await new Promise((resolve) => {
			const k = spawn("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
			k.once("exit", resolve);
			k.once("error", resolve);
		});
		return;
	}
	p.kill("SIGTERM");
	const code = await Promise.race([handle.exited, sleep(4000).then(() => "timeout")]);
	if (code === "timeout") p.kill("SIGKILL");
}

const failures = [];
function check(name, ok, detail = "") {
	if (ok) {
		console.log(`✅ ${name}`);
		return;
	}
	console.log(`❌ ${name}${detail ? `\n   ${detail.replace(/\n/g, "\n   ")}` : ""}`);
	failures.push(name);
}

async function main() {
	if (!existsSync(serverEntry)) {
		console.error(`缺少 ${serverEntry}：先跑 node scripts/build-server.mjs`);
		process.exit(1);
	}
	const dataDir = mkdtempSync(join(tmpdir(), "pi-kernel-e2e-data-"));
	const cwd = mkdtempSync(join(tmpdir(), "pi-kernel-e2e-cwd-"));
	let first = null;
	let second = null;
	let third = null;
	try {
		const port1 = await freePort();
		first = await startKernel({ dataDir, cwd, port: port1 });
		const health = await waitHealth(first.url);

		// 1. kernel 块 + 信息面
		const kernel = health?.kernel ?? {};
		check("/api/health 带 kernel 块", health?.ok === true && typeof kernel === "object");
		check("kernel.lock === held", kernel.lock === "held", JSON.stringify(kernel));
		check("kernel.mode 是 service|standalone", kernel.mode === "service" || kernel.mode === "standalone");
		check(
			"kernel 不含 pid / 数据目录 / node 路径",
			!("pid" in kernel) && !("dataDir" in kernel) && !("nodePath" in kernel),
			JSON.stringify(kernel),
		);

		// 2. 第二个内核被拒
		const port2 = await freePort();
		second = await startKernel({ dataDir, cwd, port: port2 });
		const code2 = await Promise.race([second.exited, sleep(30_000).then(() => "timeout")]);
		check("第二个内核退出码为 1", code2 === 1, `实际：${code2}\n${second.log()}`);
		check(
			"拒绝信息含持有者与三条出路",
			/PI_WEB_ALLOW_MULTI_INSTANCE/.test(second.log()) &&
				/--data-dir/.test(second.log()) &&
				/pid \d+/.test(second.log()),
			second.log(),
		);

		// 3. 逃逸开关
		const port3 = await freePort();
		third = await startKernel({
			dataDir,
			cwd,
			port: port3,
			env: { PI_WEB_ALLOW_MULTI_INSTANCE: "1" },
		});
		const health3 = await waitHealth(third.url);
		check(
			"PI_WEB_ALLOW_MULTI_INSTANCE=1 能起且 lock=disabled",
			health3?.kernel?.lock === "disabled",
			JSON.stringify(health3?.kernel),
		);
		await killKernel(third);
		third = null;

		// 4. 强杀持有者后残留锁 → 陈旧接管
		await killKernel(first);
		first = null;
		check("残留 kernel.lock 未被优雅清理（模拟崩溃）", existsSync(join(dataDir, "kernel.lock")));
		const stale = JSON.parse(readFileSync(join(dataDir, "kernel.lock"), "utf8"));
		check("残留锁记录了旧 pid", typeof stale.pid === "number");
		const port4 = await freePort();
		const fourth = await startKernel({ dataDir, cwd, port: port4 });
		try {
			const health4 = await waitHealth(fourth.url);
			check("陈旧锁被接管，新内核正常启动", health4?.kernel?.lock === "held", JSON.stringify(health4?.kernel));
		} finally {
			await killKernel(fourth);
		}
	} finally {
		for (const handle of [first, second, third]) if (handle) await killKernel(handle);
		for (const timer of timers) clearTimeout(timer);
		try {
			rmSync(dataDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		} catch {}
	}
	if (failures.length) {
		console.error(`\n❌ ${failures.length} 项失败：${failures.join(" / ")}`);
		process.exit(1);
	}
	console.log("\n✅ 内核单实例端到端验收全部通过");
}

main().catch((error) => {
	console.error("❌ e2e 崩溃：", error);
	for (const handle of children) void killKernel({ child: handle, exited: Promise.resolve(0) });
	process.exit(1);
});
