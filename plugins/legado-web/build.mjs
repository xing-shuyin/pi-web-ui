/**
 * legado-web 插件构建脚本：
 *   1) 内嵌前端（app/）→ client/app/（vite）
 *   2) 规则引擎（app/src/core/engine-entry.ts）→ server/engine.mjs（esbuild，platform=node）
 *
 *   node plugins/legado-web/build.mjs          # 缺 node_modules 时自动 npm install
 *   node plugins/legado-web/build.mjs --install # 强制先 npm install
 *
 * 产物都是纯静态/单文件，由宿主静态服务或插件直接 import，无需额外注册。
 * 装好的插件目录里通常已经带了构建产物，只有改了 app/src 才需要重跑本脚本
 * （改完 `pi-web-ui install <插件目录> --force` 覆盖安装）。
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const pluginRoot = dirname(fileURLToPath(import.meta.url));
const appDir = join(pluginRoot, "app");
const outIndex = join(pluginRoot, "client", "app", "index.html");
const engineOut = join(pluginRoot, "server", "engine.mjs");

function run(cmd, args, cwd) {
	const res = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
	if (res.status !== 0) {
		console.error(`✖ 命令失败（${res.status}）：${cmd} ${args.join(" ")}`);
		process.exit(res.status ?? 1);
	}
}

const forceInstall = process.argv.includes("--install");
const nodeModules = join(appDir, "node_modules");

if (forceInstall || !existsSync(nodeModules)) {
	console.log(`· npm install（${appDir}）`);
	run("npm", ["install", "--no-audit", "--no-fund"], appDir);
} else {
	console.log("· 已存在 app/node_modules，跳过 npm install（需要时加 --install）");
}

// 直接调 vite 的入口脚本：Windows 下 spawn('npx.cmd') 会 EINVAL，node 直调最稳
const viteBin = join(nodeModules, "vite", "bin", "vite.js");
if (!existsSync(viteBin)) {
	console.error(`✖ 找不到 vite（${viteBin}）——先跑 node build.mjs --install`);
	process.exit(1);
}
console.log("· vite build → client/app/");
run(process.execPath, [viteBin, "build"], appDir);

if (!existsSync(outIndex)) {
	console.error(`✖ 构建完成但没找到产物：${outIndex}`);
	process.exit(1);
}
console.log(`✔ legado-web 前端已构建：${outIndex}`);

// ---- 2) 规则引擎 → server/engine.mjs --------------------------------------
// 给 AI 修规则的诊断接口用：在 Node 里跑「搜索/详情/目录/正文」链路（见 engine-entry.ts）。
// 用 esbuild 的 JS API（不走 shell，避免 Windows 下 banner 引号被吃掉）。
const esbuildMain = join(nodeModules, "esbuild", "lib", "main.js");
if (!existsSync(esbuildMain)) {
	console.error(`✖ 找不到 esbuild（${esbuildMain}）——先跑 node build.mjs --install`);
	process.exit(1);
}
console.log("· esbuild → server/engine.mjs");
const esbuild = await import(pathToFileURL(esbuildMain).href);
await esbuild.build({
	entryPoints: [join(appDir, "src", "core", "engine-entry.ts")],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	logLevel: "warning",
	outfile: engineOut,
	// 依赖里有 CJS（cheerio → encoding-sniffer → iconv-lite）会 require('buffer')，
	// ESM 输出需要自己提供 require
	banner: {
		js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
	},
});
if (!existsSync(engineOut)) {
	console.error(`✖ 引擎构建产物缺失：${engineOut}`);
	process.exit(1);
}
console.log(`✔ legado-web 规则引擎已构建：${engineOut}`);
console.log("  插件目录直接装：pi-web-ui install <本插件目录> --force");
