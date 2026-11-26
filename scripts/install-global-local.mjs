#!/usr/bin/env node
/**
 * 本地同步最新引擎 → 构建 → 打包为归一化 tarball → 全局安装 → 重启全局服务。
 *
 * 用法：
 *   npm run install:global                # 同步引擎 → 构建 → 打包 → npm install -g → keel server restart
 *   npm run install:global -- --no-build  # 跳过同步与构建，直接用现有产物打包并全局安装
 *   npm run install:global -- --no-restart # 安装后不自动重启全局服务
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmCall, runCollect } from "./lib/npm-cli.mjs";
import { PackageError, packAndNormalize } from "./lib/npm-pack.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const skipBuild = args.includes("--no-build");
const skipRestart = args.includes("--no-restart");

const tempDir = mkdtempSync(join(tmpdir(), "keel-global-pack-"));
const totalSteps = (skipBuild ? 0 : 2) + 2 + (skipRestart ? 0 : 1);
let step = 0;
const nextStep = (label) => console.log(`${++step}/${totalSteps} ${label}`);

try {
	if (!skipBuild) {
		nextStep("同步最新 pi 引擎依赖 (scripts/ensure-latest-engine.mjs)...");
		await runCollect(
			{
				command: process.execPath,
				argv: [join(repoRoot, "scripts/ensure-latest-engine.mjs")],
				shell: false,
				cwd: repoRoot,
			},
			{ echo: true },
		);

		nextStep("构建服务端与前端产物 (npm run build)...");
		const build = await runCollect(npmCall(["run", "build"], { cwd: repoRoot }), { echo: true });
		if (build.code !== 0) {
			throw new PackageError("构建失败，已中止全局安装");
		}
	}

	nextStep("打包并归一化 tarball...");
	const packed = await packAndNormalize({ root: repoRoot, destination: tempDir });
	if (packed.inspection.problems.length) {
		throw new PackageError(`打出的 tarball 存在问题：\n${packed.inspection.problems.join("\n")}`);
	}
	console.log(`✓ 已打包 ${packed.filename}（${(packed.size / 1024 / 1024).toFixed(1)} MB）`);

	nextStep("安装更新本地全局包 (npm install -g)...");
	const install = await runCollect(npmCall(["install", "-g", packed.file], { cwd: repoRoot }), { echo: true });
	if (install.code !== 0) {
		throw new PackageError("npm install -g 失败");
	}
	console.log("✓ 本地全局包已更新");

	if (!skipRestart) {
		nextStep("重启全局服务 (keel server restart)...");
		const restart = await runCollect(
			{
				command: process.platform === "win32" ? "keel server restart" : "keel",
				argv: process.platform === "win32" ? [] : ["server", "restart"],
				shell: process.platform === "win32",
				cwd: repoRoot,
			},
			{ echo: true },
		);
		if (restart.code !== 0) {
			console.warn("⚠ 全局服务重启未成功（若尚未安装系统服务，可先忽略或手动运行 keel server install）");
		} else {
			console.log("✓ 全局服务已重启");
		}
	}
} catch (error) {
	console.error(`✗ ${error instanceof PackageError ? error.message : String(error)}`);
	process.exitCode = 1;
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
