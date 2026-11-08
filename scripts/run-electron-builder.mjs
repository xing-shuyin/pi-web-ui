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
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { withElectronMirror } from "./lib/electron-mirror.mjs";

const require = createRequire(import.meta.url);
const pkgPath = require.resolve("electron-builder/package.json");
const pkg = require(pkgPath);
const binEntry = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["electron-builder"];
if (!binEntry) {
	console.error("✖ 未找到 electron-builder 的 bin 入口，请检查依赖是否已安装");
	process.exit(1);
}

const cliPath = join(dirname(pkgPath), binEntry);
const child = spawn(process.execPath, [cliPath, ...process.argv.slice(2)], {
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
