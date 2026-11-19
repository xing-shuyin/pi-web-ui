#!/usr/bin/env node
/**
 * ensure-latest-engine — 打包前把自带 pi 引擎跟到线上最新（issue：lock 钉死旧版）。
 *
 * 背景：`@earendil-works/pi-coding-agent` 线上已到 1.5.x，但 package-lock 常年钉在
 * 1.1.0，`npm ci` 永远装回旧版 —— 打包带出去的自带副本一直是旧引擎。桌面安装包的
 * node_modules 不可写、也没有更新入口，所以构建机必须在 build 之前先把自带副本升上去；
 * 运行时 resolve-global-sdk 又会优先采用机器上更新的全局副本，两条路合起来才闭环。
 *
 * 约定：
 * - 只允许改 package.json / package-lock.json / node_modules，不碰其他文件
 *   （`npm update <pkg>` 只动这三处；脚本自身不写任何别的文件）。
 * - 默认永远 exit 0（失败/离线只警告不断构建），让 package.json 里直接串行即可，
 *   不依赖 shell 的 `||` 语义（cmd / PowerShell 行为不一致）。
 * - `--check-only`：落后时 exit 1（给 CI 用）；`--allow-outdated`：直接跳过。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "@earendil-works/pi-coding-agent";
// 构建机高负载时 registry 响应会变慢：30 秒超时 + 1 次重试，避免把本可升的版本漏过去。
const VIEW_TIMEOUT_MS = 30_000;
// Windows 上 npm 是 .cmd 包装器：CreateProcess 起不了批处理，必须走 shell（见 agent-service 的 installPiAgent，同例 windowsShell）。
const USE_SHELL = process.platform === "win32";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
	const out = { checkOnly: false, allowOutdated: false };
	for (const arg of argv) {
		if (arg === "--check-only") out.checkOnly = true;
		else if (arg === "--allow-outdated") out.allowOutdated = true;
	}
	return out;
}

/** 与 server/sdk-origin.ts compareVersions 同语义的数字分段比较。 */
export function compareVersions(a, b) {
	const pa = String(a ?? "").split(".");
	const pb = String(b ?? "").split(".");
	for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
		const na = Number.parseInt(pa[i] ?? "0", 10) || 0;
		const nb = Number.parseInt(pb[i] ?? "0", 10) || 0;
		if (na !== nb) return na < nb ? -1 : 1;
	}
	return 0;
}

function readInstalledVersion() {
	try {
		const pj = join(repoRoot, "node_modules", PKG, "package.json");
		if (!existsSync(pj)) return null;
		const info = JSON.parse(readFileSync(pj, "utf8"));
		return typeof info?.version === "string" && info.version ? info.version : null;
	} catch {
		return null;
	}
}

/** 命令全部是内部静态串（包名常量 + 固定子命令），没有外部输入，不存在 shell 注入面。 */
function quoteArg(arg) {
	if (!/^[\w@./+=:,~-]+$/.test(arg)) return `"${arg.replace(/"/g, '""')}"`;
	return arg;
}

function run(argv, timeoutMs) {
	const display = argv.map(quoteArg).join(" ");
	return new Promise((resolvePromise) => {
		let child;
		try {
			// win32 走 shell 起 .cmd 包装器；posix 直接 exec。单字符串形式避免 DEP0190 告警。
			child = USE_SHELL
				? spawn(display, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: true })
				: spawn(argv[0], argv.slice(1), {
						cwd: repoRoot,
						stdio: ["ignore", "pipe", "pipe"],
						windowsHide: true,
					});
		} catch (err) {
			resolvePromise({ code: null, stdout: "", stderr: String(err), timedOut: false });
			return;
		}
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill();
			} catch {}
		}, timeoutMs);
		timer.unref?.();
		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.once("error", () => {
			clearTimeout(timer);
			resolvePromise({ code: null, stdout, stderr, timedOut });
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ code, stdout, stderr, timedOut });
		});
	});
}

async function queryLatest() {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const res = await run(["npm", "view", `${PKG}@latest`, "version", "--fetch-retries=1"], VIEW_TIMEOUT_MS);
		if (!res.timedOut && res.code === 0) {
			const version = String(res.stdout ?? "")
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean)
				.pop();
			if (version && /^\d+\.\d+\.\d+/.test(version)) return version;
		}
	}
	return null;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.allowOutdated) {
		console.warn("[ensure-latest-engine] --allow-outdated: skip engine freshness check.");
		return 0;
	}
	const installed = readInstalledVersion();
	const latest = await queryLatest();
	if (!latest) {
		console.warn("[ensure-latest-engine] cannot reach npm registry (offline/timeout); keep bundled engine as-is.");
		return 0;
	}
	if (installed && compareVersions(installed, latest) >= 0) {
		console.log(`[ensure-latest-engine] bundled ${PKG} v${installed} is up to date (>= v${latest}).`);
		return 0;
	}
	if (args.checkOnly) {
		console.warn(`[ensure-latest-engine] bundled ${PKG} v${installed ?? "(missing)"} lags behind latest v${latest}.`);
		return 1;
	}
	console.log(
		`[ensure-latest-engine] updating bundled ${PKG} v${installed ?? "(missing)"} → v${latest} ` +
			`via \`npm update ${PKG}\` (package.json range covers it; only package.json/lock/node_modules change)…`,
	);
	const res = await run(["npm", "update", PKG], 300_000);
	if (res.code !== 0) {
		console.warn(
			`[ensure-latest-engine] \`npm update ${PKG}\` failed (code ${res.code ?? "timeout"}); ` +
				"keep going with the existing bundled copy.",
		);
		return 0;
	}
	const after = readInstalledVersion();
	console.log(`[ensure-latest-engine] done; bundled ${PKG} is now v${after ?? "unknown"}.`);
	return 0;
}

const code = await main();
process.exit(code);
