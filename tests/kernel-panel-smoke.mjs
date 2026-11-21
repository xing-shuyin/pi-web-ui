#!/usr/bin/env node
/**
 * 内核面板的**真实点击**冒烟（Electron + Playwright，本地实跑）。
 *
 * 为什么要有：`kernel-view.ts` 的判定、`kernel.env` 的解析都有单测，但"面板真的渲染出来、
 * 按钮真的能点、点了真的重启了内核"只有把壳拉起来才能证明。
 *
 * 断言（全部对着真进程/真 DOM）：
 *   1. 设置面板里出现「内核（服务进程）」小节 + 状态行含版本号
 *   2. 环境行（异步）最终出现 node 与全局包信息
 *   3. 「安装为系统服务」「重启内核」按钮可见（本机裸内核：可装、可重启）
 *   4. **真点「重启内核」** → 内核 uptime 归零（重启确实发生），面板无 pageerror
 *   5. 安装按钮**不点**：自动化里装系统服务会改机器，留给人工验收
 *
 * 用法：node tests/kernel-panel-smoke.mjs   （需要先 npm run build:server && npm run build:desktop）
 * 端口一律 ≥8900；profile / data-dir 一律临时目录；结束清理（Windows 杀进程树，禁 pkill -f）。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const mainEntry = join(repo, "dist", "desktop", "main.js");
const serverEntry = join(repo, "dist", "server", "index.js");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function freePort() {
	return new Promise((done, fail) => {
		const srv = createServer();
		srv.once("error", fail);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => done(port));
		});
	});
}

async function killTree(pid) {
	if (!pid) return;
	await new Promise((done) => {
		const child =
			process.platform === "win32"
				? spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
				: spawn("kill", ["-TERM", String(pid)], { stdio: "ignore" });
		child.once("exit", done);
		child.once("error", done);
	});
}

async function waitHealth(url, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
			if (response.ok) return await response.json();
		} catch {}
		await sleep(200);
	}
	throw new Error(`等待 ${url}/api/health 超时`);
}

async function main() {
	for (const [label, file] of [
		["dist/desktop/main.js", mainEntry],
		["dist/server/index.js", serverEntry],
	]) {
		if (!existsSync(file)) throw new Error(`缺少 ${label}：先跑 npm run build:server && npm run build:desktop`);
	}

	const temporary = await mkdtemp(join(tmpdir(), "pi-kernel-panel-"));
	const dataDir = join(temporary, "data");
	const cwd = join(temporary, "cwd");
	const profile = join(temporary, "profile");
	const port = await freePort();
	const kernelUrl = `http://127.0.0.1:${port}`;
	let kernel = null;
	let application = null;
	const failures = [];
	const check = (name, ok, detail = "") => {
		if (ok) console.log(`✅ ${name}`);
		else {
			console.log(`❌ ${name}${detail ? `\n   ${detail}` : ""}`);
			failures.push(name);
		}
	};

	try {
		// 1) 先起一个真内核，让壳连它（external 模式最容易断言，且不会干扰壳自己起的 sidecar）
		kernel = spawn(process.execPath, [serverEntry, "--port", String(port), "--data-dir", dataDir, "--cwd", cwd], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let kernelLog = "";
		kernel.stdout?.on("data", (c) => (kernelLog = (kernelLog + c.toString("utf8")).slice(-4000)));
		kernel.stderr?.on("data", (c) => (kernelLog = (kernelLog + c.toString("utf8")).slice(-4000)));
		const health = await waitHealth(kernelUrl);
		assert.equal(health?.kernel?.lock, "held", `内核没抢到锁：${kernelLog}`);

		// 2) 拉起桌面壳（隔离 profile，指向这个内核）
		const env = { ...process.env, PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: cwd };
		delete env.ELECTRON_RUN_AS_NODE;
		application = await _electron.launch({
			executablePath: createRequire(import.meta.url)("electron"),
			args: [mainEntry, `--user-data-dir=${profile}`],
			env,
			timeout: 40_000,
		});
		await application.firstWindow();
		let shell;
		for (let attempt = 0; attempt < 120; attempt++) {
			shell = application
				.context()
				.pages()
				.find((page) => page.url().endsWith("/shell.html"));
			if (shell) break;
			await sleep(100);
		}
		assert.ok(shell, "找不到 shell.html");
		const pageErrors = [];
		shell.on("pageerror", (error) => pageErrors.push(error.message));
		await shell.waitForFunction(() => !!window.piBrowserShell, { timeout: 20_000 });
		const call = (action, args) =>
			shell.evaluate(({ action, args }) => window.piBrowserShell.call(action, args), { action, args });

		await call("agent.connect", { url: kernelUrl });
		// 面板要能读到"连的是谁"：先让它把内核状态算出来
		const connected = await call("kernel.status");
		check("kernel.status 报告连上的内核", connected?.reachable === true, JSON.stringify(connected));

		// 3) 打开设置面板（真浮层）
		const opened = await call("panel", { open: true, panel: "settings" });
		check("panel(settings) 打开成功", opened === true, JSON.stringify(opened));
		let panel;
		for (let attempt = 0; attempt < 120; attempt++) {
			panel = application
				.context()
				.pages()
				.find((page) => page.url().includes("/panel.html"));
			if (panel) break;
			await sleep(100);
		}
		assert.ok(panel, "找不到 panel.html");
		const panelErrors = [];
		panel.on("pageerror", (error) => panelErrors.push(error.message));
		await panel.waitForFunction(() => document.body.textContent.includes("内核（服务进程）"), { timeout: 20_000 });
		check("面板渲染出「内核（服务进程）」小节", true);

		const sectionText = await panel.evaluate(() => {
			const sections = [...document.querySelectorAll("section")];
			const target = sections.find((node) => node.textContent?.includes("内核（服务进程）"));
			return target?.textContent ?? "";
		});
		check("状态行含版本号", /v\d+\.\d+\.\d+/.test(sectionText), sectionText.slice(0, 200));
		check("状态行说明关掉之后的后果", /关掉|随本窗口|托管/.test(sectionText), sectionText.slice(0, 200));

		// 4) 环境行是异步来的（要问 npm registry），等它出现
		let envText = "";
		for (let attempt = 0; attempt < 60; attempt++) {
			envText = await panel.evaluate(() => {
				const sections = [...document.querySelectorAll("section")];
				const target = sections.find((node) => node.textContent?.includes("内核（服务进程）"));
				return [...(target?.querySelectorAll("p") ?? [])].map((p) => p.textContent ?? "").join(" | ");
			});
			if (/node v|未检测到可用 node|服务配置/.test(envText)) break;
			await sleep(250);
		}
		check("环境行出现（node / 全局包 / 服务配置）", /node v|未检测到可用 node/.test(envText), envText.slice(0, 240));

		// 5) 外部裸内核：安装可见（本机可装），重启**必须隐藏**——壳没有任何手段重启别人的进程
		const buttons = await panel.evaluate(() => {
			const sections = [...document.querySelectorAll("section")];
			const target = sections.find((node) => node.textContent?.includes("内核（服务进程）"));
			const all = [...(target?.querySelectorAll("button") ?? [])];
			return all.map((b) => ({ text: b.textContent ?? "", hidden: b.hidden, disabled: b.disabled }));
		});
		const restartButton = buttons.find((b) => b.text.includes("重启内核"));
		const installButton = buttons.find((b) => b.text.includes("安装为系统服务"));
		check(
			"外部裸内核：重启按钮隐藏（点了也重启不了别人的进程）",
			!restartButton || restartButton.hidden,
			JSON.stringify(buttons),
		);
		check(
			"「安装为系统服务」可见（自动化里不点）",
			Boolean(installButton) && !installButton.hidden,
			JSON.stringify(buttons),
		);

		// 6) 外置内核要能说清"重启请到那台机器"（不让用户对着隐藏的按钮发懵）
		const hint = await panel.evaluate(() => {
			const sections = [...document.querySelectorAll("section")];
			const target = sections.find((node) => node.textContent?.includes("内核（服务进程）"));
			return [...(target?.querySelectorAll("p") ?? [])].map((p) => p.textContent ?? "").join(" | ");
		});
		check("提示里给了手动重启的出路", /所在的机器|外部内核/.test(hint), hint.slice(0, 240));

		// ── 场景 A：壳自己拉 sidecar（local），「重启内核」必须真能重启（这是最常见的实际用法）──
		await application.close().catch(() => {});
		application = null;
		const localDataDir = join(temporary, "local-data");
		const localProfile = join(temporary, "local-profile");
		const localEnv = { ...process.env, PI_WEB_DATA_DIR: localDataDir, PI_WEB_CWD: cwd };
		delete localEnv.ELECTRON_RUN_AS_NODE;
		application = await _electron.launch({
			executablePath: createRequire(import.meta.url)("electron"),
			args: [mainEntry, `--user-data-dir=${localProfile}`],
			env: localEnv,
			timeout: 40_000,
		});
		await application.firstWindow();
		let localShell;
		for (let attempt = 0; attempt < 200; attempt++) {
			localShell = application
				.context()
				.pages()
				.find((page) => page.url().endsWith("/shell.html"));
			if (localShell) break;
			await sleep(100);
		}
		assert.ok(localShell, "场景 A：找不到 shell.html");
		const localErrors = [];
		localShell.on("pageerror", (error) => localErrors.push(error.message));
		await localShell.waitForFunction(() => !!window.piBrowserShell, { timeout: 20_000 });
		const localCall = (action, args) =>
			localShell.evaluate(({ action, args }) => window.piBrowserShell.call(action, args), { action, args });

		// 等 sidecar 起来（壳自己 spawn 的那个）
		let localState = null;
		for (let attempt = 0; attempt < 200; attempt++) {
			await sleep(500);
			localState = await localCall("kernel.status").catch(() => null);
			if (localState?.reachable) break;
		}
		check("场景 A：壳拉起本地内核并报告可达", localState?.reachable === true, JSON.stringify(localState));
		check("场景 A：模式是 local（关掉本窗口就停）", localState?.mode === "local", JSON.stringify(localState));

		await localCall("panel", { open: true, panel: "settings" });
		let localPanel;
		for (let attempt = 0; attempt < 200; attempt++) {
			localPanel = application
				.context()
				.pages()
				.find((page) => page.url().includes("/panel.html"));
			if (localPanel) break;
			await sleep(100);
		}
		assert.ok(localPanel, "场景 A：找不到 panel.html");
		await localPanel.waitForFunction(() => document.body.textContent.includes("内核（服务进程）"), { timeout: 20_000 });
		const localButtons = await localPanel.evaluate(() => {
			const sections = [...document.querySelectorAll("section")];
			const target = sections.find((node) => node.textContent?.includes("内核（服务进程）"));
			return [...(target?.querySelectorAll("button") ?? [])].map((b) => ({
				text: b.textContent ?? "",
				hidden: b.hidden,
			}));
		});
		const localRestart = localButtons.find((b) => b.text.includes("重启内核"));
		check(
			"场景 A：「重启内核」可见且可点",
			Boolean(localRestart) && !localRestart.hidden,
			JSON.stringify(localButtons),
		);

		const beforeLocal = await localCall("kernel.status");
		await localPanel.evaluate(() => {
			const sections = [...document.querySelectorAll("section")];
			const target = sections.find((node) => node.textContent?.includes("内核（服务进程）"));
			const button = [...(target?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("重启内核"));
			button?.click();
		});
		let afterLocal = null;
		for (let attempt = 0; attempt < 120; attempt++) {
			await sleep(500);
			afterLocal = await localCall("kernel.status").catch(() => null);
			if (
				afterLocal?.reachable &&
				typeof afterLocal.uptimeMs === "number" &&
				afterLocal.uptimeMs < (beforeLocal?.uptimeMs ?? Infinity)
			)
				break;
		}
		check(
			"场景 A：点击后 uptime 归零（内核真的重启了）",
			Boolean(afterLocal?.reachable) && (afterLocal?.uptimeMs ?? Infinity) < (beforeLocal?.uptimeMs ?? Infinity),
			`before=${JSON.stringify(beforeLocal?.uptimeMs)} after=${JSON.stringify(afterLocal?.uptimeMs)}`,
		);
		check("场景 A：面板无渲染错误", localErrors.length === 0, localErrors.join(" / "));

		check("面板无渲染错误", panelErrors.length === 0, panelErrors.join(" / "));
		check("壳无渲染错误", pageErrors.length === 0, pageErrors.join(" / "));
	} finally {
		if (application) await application.close().catch(() => {});
		if (kernel) await killTree(kernel.pid);
		await sleep(500);
		await rm(temporary, { recursive: true, force: true }).catch(() => {});
	}

	if (failures.length) {
		console.error(`\n❌ ${failures.length} 项失败：${failures.join(" / ")}`);
		process.exit(1);
	}
	console.log("\n✅ 内核面板真实点击冒烟全部通过");
}

main().catch(async (error) => {
	console.error("❌ 面板冒烟崩溃：", error);
	process.exit(1);
});
