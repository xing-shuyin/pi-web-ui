#!/usr/bin/env node
/**
 * electron-builder 包装器：带上 Electron / electron-builder 二进制镜像环境变量再拉起 CLI。
 *
 * 用途：本地与便携版打包都要从 npmmirror 拉 Electron zip（含 `SHASUMS256.txt` 校验）和
 * NSIS/winCodeSign 等二进制；此前靠仓库根 `.npmrc` 的自定义键借 npm 透传环境变量，
 * npm 11 会为此告警、npm 12 起失效（详见 `scripts/lib/electron-mirror.mjs`）。
 * 现在只有真正发起下载的这一层设置环境变量，`npm run` / `npm install` 不再碰自定义配置。
 *
 * 用法：`node scripts/run-electron-builder.mjs <electron-builder 参数>`，参数原样透传。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withElectronMirror } from "./lib/electron-mirror.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 解析本次 electron-builder 的输出目录（优先读取 CLI 参数与配置文件中的 `directories.output`，默认 `<repo>/release`）。
 * @param {string[]} args
 * @param {string} [cwd]
 */
export function resolveElectronBuilderOutputDir(args, cwd = repoRoot) {
	let cliOutput = null;
	let configFile = null;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--config.directories.output=")) {
			cliOutput = arg.slice("--config.directories.output=".length);
		} else if (arg === "-c" || arg === "--config") {
			configFile = args[i + 1] ?? null;
			i++;
		} else if (arg.startsWith("--config=")) {
			configFile = arg.slice("--config=".length);
		}
	}
	if (cliOutput) {
		return resolve(cwd, cliOutput);
	}
	if (configFile) {
		const configPath = resolve(cwd, configFile);
		if (existsSync(configPath)) {
			try {
				const raw = readFileSync(configPath, "utf8");
				const match = raw.match(
					/^directories:\s*(?:\r?\n[ \t]+[^\r\n]*)*?\r?\n[ \t]+output:[ \t]*["']?([^"'\r\n#]+)["']?/m,
				);
				if (match?.[1]?.trim()) {
					return resolve(cwd, match[1].trim());
				}
			} catch {
				// 配置读取失败时回退到默认 release 目录
			}
		}
	}
	return resolve(cwd, "release");
}

/**
 * Windows 下若输出目录继承了 Low Mandatory Level，NSIS 生成的临时桩程序在执行提取卸载器时会因
 * 强制完整性控制报错 3221225794 (0xC0000142)；打包前自动将输出目录及已有产物提升为 Medium 完整性。
 * @param {string} outputDir
 */
function ensureMediumIntegrityOnWindows(outputDir) {
	if (process.platform !== "win32") return;
	try {
		mkdirSync(outputDir, { recursive: true });
		const probe = spawnSync("icacls", [outputDir], { encoding: "utf8", windowsHide: true });
		const stdout = probe.stdout ?? "";
		if (!/Low Mandatory Level|S-1-16-4096/i.test(stdout)) return;
		console.log(`ℹ 检测到输出目录为 Low 完整性，正在提升为 Medium 完整性: ${outputDir}`);
		const res = spawnSync("icacls", [outputDir, "/setintegritylevel", "(OI)(CI)M", "/T", "/C", "/Q"], {
			encoding: "utf8",
			windowsHide: true,
		});
		if (res.status !== 0) {
			console.warn(`⚠ 自动提升输出目录完整性失败 (exit=${res.status}): ${(res.stderr || res.stdout || "").trim()}`);
		}
	} catch (err) {
		console.warn(`⚠ 检查/提升输出目录完整性时出错: ${err instanceof Error ? err.message : String(err)}`);
	}
}

const builderArgs = process.argv.slice(2);
ensureMediumIntegrityOnWindows(resolveElectronBuilderOutputDir(builderArgs));

const require = createRequire(import.meta.url);
const pkgPath = require.resolve("electron-builder/package.json");
const pkg = require(pkgPath);
const binEntry = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["electron-builder"];
if (!binEntry) {
	console.error("✖ 未找到 electron-builder 的 bin 入口，请检查依赖是否已安装");
	process.exit(1);
}

const cliPath = join(dirname(pkgPath), binEntry);
const child = spawn(process.execPath, [cliPath, ...builderArgs], {
	stdio: "inherit",
	env: withElectronMirror(),
});

child.on("error", (err) => {
	console.error(`✖ 启动 electron-builder 失败: ${err.message}`);
	process.exit(1);
});
child.on("exit", (code, signal) => {
	if (signal) {
		console.error(`✖ electron-builder 被信号终止: ${signal}`);
		process.exit(1);
	}
	process.exit(code ?? 1);
});
