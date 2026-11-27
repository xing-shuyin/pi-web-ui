#!/usr/bin/env node
/**
 * 自动检测当前操作系统与架构 → 构建桌面端 → 打包对应安装包 → 自动打开安装。
 *
 * 用法：
 *   npm run install:desktop              # 构建 → 打包当前平台安装包 → 自动打开安装
 *   npm run install:desktop -- --no-build # 跳过前置构建，直接用现有产物打包并打开安装
 *   npm run install:desktop -- --no-open  # 只打包，不自动打开安装包
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmCall, runCollect } from "./lib/npm-cli.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 根据当前操作系统与 CPU 架构解析 electron-builder 打包目标与产物后缀。
 * @param {NodeJS.Platform} platform
 * @param {string} arch
 */
export function resolveDesktopTarget(platform = process.platform, arch = process.arch) {
	const archFlag = arch === "arm64" ? "--arm64" : arch === "x64" ? "--x64" : null;
	if (platform === "darwin") {
		return {
			platform,
			arch,
			label: `macOS (${arch}) .dmg`,
			ext: ".dmg",
			builderArgs: ["--mac", "dmg", ...(archFlag ? [archFlag] : []), "--publish", "never"],
		};
	}
	if (platform === "win32") {
		return {
			platform,
			arch,
			label: `Windows (${arch}) NSIS .exe`,
			ext: ".exe",
			builderArgs: ["--win", "nsis", ...(archFlag ? [archFlag] : []), "--publish", "never"],
		};
	}
	if (platform === "linux") {
		return {
			platform,
			arch,
			label: `Linux (${arch}) .AppImage`,
			ext: ".AppImage",
			builderArgs: ["--linux", "AppImage", ...(archFlag ? [archFlag] : []), "--publish", "never"],
		};
	}
	throw new Error(`不支持的桌面平台: ${platform}`);
}

/**
 * 在 release 目录中定位本次构建出的当前版本安装包。
 * @param {string} releaseDir
 * @param {{ platform?: NodeJS.Platform, arch?: string, version: string, productName?: string }} options
 */
export function findDesktopInstaller(
	releaseDir,
	{ platform = process.platform, arch = process.arch, version, productName = "keel" },
) {
	if (!existsSync(releaseDir)) return null;
	const target = resolveDesktopTarget(platform, arch);
	const prefix = `${productName}-${version}`;
	const candidates = readdirSync(releaseDir)
		.filter((name) => name.startsWith(prefix) && name.endsWith(target.ext))
		.filter((name) => (platform === "win32" ? name.endsWith("-setup.exe") : true))
		.map((name) => {
			const fullPath = join(releaseDir, name);
			let mtimeMs = 0;
			try {
				const st = statSync(fullPath);
				if (!st.isFile()) return null;
				mtimeMs = st.mtimeMs;
			} catch {
				return null;
			}
			const archMatched =
				name.includes(`-${arch}`) || (platform === "linux" && arch === "x64" && name.includes("-x86_64"));
			return { fullPath, archMatched, mtimeMs };
		})
		.filter(Boolean);

	if (candidates.length === 0) return null;
	candidates.sort((a, b) => Number(b.archMatched) - Number(a.archMatched) || b.mtimeMs - a.mtimeMs);
	return candidates[0].fullPath;
}

/**
 * 构造不同系统下打开安装包的命令描述。
 * @param {string} installerPath
 * @param {NodeJS.Platform} platform
 */
export function buildOpenInstallerCommand(installerPath, platform = process.platform) {
	if (platform === "darwin") {
		return { command: "open", argv: [installerPath], detached: false };
	}
	if (platform === "win32") {
		return { command: "cmd", argv: ["/c", "start", "", installerPath], detached: true };
	}
	if (platform === "linux") {
		return { command: installerPath, argv: [], detached: true, chmodExecutable: true };
	}
	throw new Error(`不支持自动打开安装包的平台: ${platform}`);
}

async function openInstaller(installerPath, platform = process.platform) {
	const spec = buildOpenInstallerCommand(installerPath, platform);
	if (spec.chmodExecutable) {
		chmodSync(installerPath, 0o755);
	}
	if (!spec.detached) {
		const res = await runCollect(
			{ command: spec.command, argv: spec.argv, shell: false, cwd: repoRoot },
			{ echo: true },
		);
		if (res.code !== 0) {
			throw new Error(`打开安装包失败 (exit=${res.code}): ${installerPath}`);
		}
		return;
	}
	await new Promise((resolveDone, rejectDone) => {
		const child = spawn(spec.command, spec.argv, {
			detached: true,
			stdio: "ignore",
			windowsHide: platform === "win32",
		});
		child.once("error", rejectDone);
		child.once("spawn", () => {
			child.unref();
			resolveDone();
		});
	});
}

async function runNodeScript(scriptRelPath, scriptArgs = []) {
	const res = await runCollect(
		{
			command: process.execPath,
			argv: [join(repoRoot, scriptRelPath), ...scriptArgs],
			shell: false,
			cwd: repoRoot,
		},
		{ echo: true },
	);
	if (res.code !== 0) {
		throw new Error(`执行失败: ${scriptRelPath} (exit=${res.code})`);
	}
}

async function main() {
	const args = process.argv.slice(2);
	const skipBuild = args.includes("--no-build");
	const skipOpen = args.includes("--no-open");

	const target = resolveDesktopTarget(process.platform, process.arch);
	const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	const version = String(pkg.version);
	const releaseDir = join(repoRoot, "release");

	const totalSteps = (skipBuild ? 0 : 3) + 1 + (skipOpen ? 0 : 1);
	let step = 0;
	const nextStep = (label) => console.log(`${++step}/${totalSteps} ${label}`);

	console.log(`检测到系统环境: ${target.label} (v${version})`);

	if (!skipBuild) {
		nextStep("构建服务端共享模块 (npm run build:server)...");
		const buildServer = await runCollect(npmCall(["run", "build:server"], { cwd: repoRoot }), { echo: true });
		if (buildServer.code !== 0) {
			throw new Error("build:server 失败，已中止桌面端打包");
		}

		nextStep("同步桌面壳依赖清单 (scripts/gen-shell-deps.mjs)...");
		await runNodeScript("scripts/gen-shell-deps.mjs");

		nextStep("构建桌面外壳与内置浏览器 (npm run build:desktop)...");
		const buildDesktop = await runCollect(npmCall(["run", "build:desktop"], { cwd: repoRoot }), { echo: true });
		if (buildDesktop.code !== 0) {
			throw new Error("build:desktop 失败，已中止桌面端打包");
		}
	}

	nextStep(`打包当前系统安装包 (${target.label})...`);
	await runNodeScript("scripts/run-electron-builder.mjs", [
		"-c",
		"desktop/electron-builder.yml",
		...target.builderArgs,
	]);

	const installerPath = findDesktopInstaller(releaseDir, {
		platform: process.platform,
		arch: process.arch,
		version,
		productName: "keel",
	});
	if (!installerPath) {
		throw new Error(`打包完成但未在 ${releaseDir} 中找到 v${version} 的 ${target.ext} 安装包`);
	}
	const sizeMb = (statSync(installerPath).size / 1024 / 1024).toFixed(1);
	console.log(`✓ 已生成安装包: ${installerPath}（${sizeMb} MB）`);

	if (!skipOpen) {
		nextStep(`打开安装包进行安装 (${installerPath})...`);
		await openInstaller(installerPath, process.platform);
		console.log("✓ 已触发打开安装包");
	}
}

const isEntry = (() => {
	try {
		return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
})();

if (isEntry) {
	main().catch((error) => {
		console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
