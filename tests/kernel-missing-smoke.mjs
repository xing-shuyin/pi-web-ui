#!/usr/bin/env node
/**
 * 纯壳包「没有内核」的实跑冒烟（Electron + Playwright）。
 *
 * 为什么要有：纯壳包（`desktop/electron-builder.shell.yml`）的卖点是"安装包只装壳"，
 * 于是**首次启动必然没有内核**。这条路径只有在真壳里跑过才算数：
 * 必须出现安装入口，而不是白屏/崩在 spawn 上（历史上这里会去 spawn 一个不存在的入口）。
 *
 * 手法：把 npm 的全局前缀指到一个空临时目录（`NPM_CONFIG_PREFIX`），
 * `resolveGlobalKernelEntry()` 就找不到全局包，权威链落到 null —— 与"用户刚装完壳、还没装内核"完全同构。
 *
 * 断言（真进程 / 真 DOM）：
 *   1. 壳能启动、能开窗口，没有 pageerror
 *   2. `state.kernelMissing` 存在，且 `nodeOk: true`（本机有 node）
 *   3. 启动覆盖层显示「还没有可用的内核」+「安装内核」按钮可见（`<不点>`：会真的联网装包）
 *   4. 控制台/主进程不出现 spawn ENOENT（说明我们确实在 spawn 之前就拦住了）
 *
 * 用法：
 *   npm run build:desktop && node tests/kernel-missing-smoke.mjs
 *   PI_SHELL_SMOKE_EXE=release-shell/win-unpacked/pi-web-ui-desktop.exe node tests/kernel-missing-smoke.mjs
 *
 * 端口一律 ≥8900；profile / 临时目录一律 mkdtemp；结束清理（Windows 杀进程树，禁 pkill -f）。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const mainEntry = join(repo, "dist", "desktop", "main.js");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const packagedExe = process.env.PI_SHELL_SMOKE_EXE?.trim();
/** 直接对**包内容**（app.asar）跑：真实反映安装版里的文件集合，又不依赖本机跑不起来的打包 exe。 */
const asarPath = process.env.PI_SHELL_SMOKE_ASAR?.trim();

function launchOptions(profile) {
	if (packagedExe) {
		if (!existsSync(packagedExe)) throw new Error(`找不到纯壳包 exe：${packagedExe}`);
		return { executablePath: packagedExe, args: [`--user-data-dir=${profile}`], timeout: 40_000 };
	}
	return {
		executablePath: createRequire(import.meta.url)("electron"),
		args: [asarPath ?? mainEntry, `--user-data-dir=${profile}`],
		timeout: 40_000,
	};
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

async function main() {
	if (asarPath && !existsSync(asarPath)) throw new Error(`找不到 asar：${asarPath}`);
	if (!packagedExe && !asarPath && !existsSync(mainEntry))
		throw new Error("缺少 dist/desktop/main.js：先跑 npm run build:desktop");

	const temporary = await mkdtemp(join(tmpdir(), "pi-shell-missing-"));
	const profile = join(temporary, "profile");
	const emptyPrefix = join(temporary, "empty-prefix");
	const failures = [];
	let application = null;
	const check = (name, ok, detail = "") => {
		if (ok) console.log(`✅ ${name}`);
		else {
			console.log(`❌ ${name}${detail ? `\n   ${detail}` : ""}`);
			failures.push(name);
		}
	};

	try {
		// 全局前缀指到空目录 → 权威链必然落到 null（= 用户刚装完壳、还没装内核）
		const env = {
			...process.env,
			NPM_CONFIG_PREFIX: emptyPrefix,
			PI_WEB_DATA_DIR: join(temporary, "data"),
			PI_WEB_CWD: temporary,
		};
		// 非打包模式下 main.ts 会直接跑 dev 入口；给一个空运行时根目录，
		// 让它走“打包态同一套”的权威链（dev 也能验“没有内核”这条路）。
		if (!packagedExe) env.PI_DESKTOP_RUNTIME_ROOT = join(temporary, "empty-runtime");
		delete env.ELECTRON_RUN_AS_NODE;
		delete env.PI_KERNEL_SMOKE_EXE;

		application = await _electron.launch({ ...launchOptions(profile), env });
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
		assert.ok(shell, "找不到 shell.html：壳没起来");
		const pageErrors = [];
		shell.on("pageerror", (error) => pageErrors.push(error.message));
		await shell.waitForFunction(() => !!window.piBrowserShell, { timeout: 20_000 });

		const call = (action, args) =>
			shell.evaluate(({ action, args }) => window.piBrowserShell.call(action, args), { action, args });

		// 1) 内核缺失状态必须被主进程算出来
		let state = null;
		for (let attempt = 0; attempt < 60; attempt++) {
			state = await call("state");
			if (state?.kernelMissing) break;
			await sleep(250);
		}
		check(
			"主进程把 kernelMissing 推给渲染层",
			Boolean(state?.kernelMissing),
			JSON.stringify(state?.kernelMissing ?? null),
		);
		check("nodeOk=true（本机 node ≥22，缺的只是内核）", state?.kernelMissing?.nodeOk === true);
		check("agentError 说清了下一步", Boolean(state?.agentError), String(state?.agentError ?? ""));

		// 2) 覆盖层：标题 + 安装内核按钮（不点，会真的联网装包）
		const bootText = await shell.textContent(".pb-boot-text");
		check("覆盖层标题是「还没有可用的内核」", (bootText ?? "").includes("还没有可用的内核"), String(bootText));
		const actionsVisible = await shell.isVisible(".pb-boot-actions");
		check("安装入口整组可见", actionsVisible);
		const kernelBtnVisible = await shell.isVisible(".pb-boot-actions button:not([hidden])");
		check("至少有一个可点的修复按钮", kernelBtnVisible);

		// 3) 没有 pageerror
		check("无 pageerror", pageErrors.length === 0, pageErrors.join("\n"));

		// 4) 主进程日志里不能出现 spawn ENOENT（说明在 spawn 之前就拦住了）
		const logs = await application
			.evaluate(
				async ({ app }) => {
					const logsPath = app?.getPath?.("logs");
					const fs = await import("node:fs");
					try {
						const tail = fs.readdirSync(logsPath).filter((f) => f.endsWith(".log"));
						return tail
							.map((f) => fs.readFileSync(`${logsPath}/${f}`, "utf8"))
							.join("\n")
							.slice(-20_000);
					} catch {
						return "";
					}
				},
				{ app: await application.evaluate(() => null) },
			)
			.catch(() => "");
		const spawnedMissing = /ENOENT/.test(String(logs));
		check("没有 spawn 不存在的入口（无 ENOENT）", !spawnedMissing);
	} finally {
		if (application) await application.close().catch(() => {});
		let pid;
		try {
			pid = application?.process?.()?.pid;
		} catch {}
		await killTree(pid);
		await rm(temporary, { recursive: true, force: true }).catch(() => {});
	}

	if (failures.length) {
		console.log(`\n✖ ${failures.length} 项未通过：${failures.join(" / ")}`);
		process.exit(1);
	}
	console.log("\n✅ 纯壳包「没有内核」路径全部通过");
}

await main();
