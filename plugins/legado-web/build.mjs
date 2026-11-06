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
