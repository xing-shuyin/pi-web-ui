#!/usr/bin/env node
/**
 * pi-web-ui DSH runtime launcher (DshEngine的运行时子进程).
 *
 * 组合 = 全局/本地 dsh 运行时树里的 dsh-base bundle patch + 本文件同目录的
 * override patch（挂 stdio JSON-RPC 服务插件 + pin 会话持久化/人设/沙箱）。
 * 与官方 dsh CLI 的 profile 机制无关 —— 直接以 boot() 组合静态入口，绕开
 * $DSH_HOME/profiles 初始化。
 *
 * 运行时树解析顺序（实现见 runtime-root.mjs，支持 flat / dsh 嵌套两种布局）：
 *   1. $PI_WEB_DSH_RUNTIME — 显式指定 node_modules 根（含 @deepseek-ai/dsh-base）
 *   2. 本包 node_modules — 若 pi-web-ui 完整安装了 dsh 依赖树
 *   3. execPath 邻近 node_modules — fnm / 独立 node 的稳定布局
 *   4. `npm root -g` — 全局 dsh 安装（`npm i -g @deepseek-ai/dsh`）
 *
 * JSON-RPC 服务插件（dsh-sdk-jsonrpc-server）按项目依赖解析：override patch
 * 里的 name 由 $PI_WEB_DSH_JSONRPC_ENTRY 用 !!js 求值成绝对路径（指向项目
 * node_modules），其 peer 依赖从项目树自洽解析 —— cordis loader 的裸包解析
 * 只有单一 base，所以混树只能走绝对路径挂载。
 *
 * 协议：newline-delimited JSON-RPC 2.0 于 stdio（stdout 只承载协议帧）。
 */
import { dirname, join, resolve } from "node:path";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveRuntimeBase } from "./runtime-root.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN_NAME = "pi-web-ui-dsh";

const runtimeBase = await resolveRuntimeBase();
if (!runtimeBase) {
	console.error(
		`[${BIN_NAME}] 找不到 DSH 运行时树（含 @deepseek-ai/dsh-base 的 node_modules）。` +
			"请先执行 npm i -g @deepseek-ai/dsh（或设置 PI_WEB_DSH_RUNTIME 指向其 node_modules）。",
	);
	process.exit(1);
}

const runConfig = process.env.DSH_CORDIS_CONFIG ?? join(HERE, "cordis.yml");
const baseBundlePatch = join(runtimeBase, "@deepseek-ai", "dsh-base", "cordis.patch.yml");
const overridePatch = join(HERE, "override.patch.yml");

// 用户 patch 层：<dataDir>/dsh-patches/*.yml（按文件名序，在 override 之后）。
// 引擎（DshClientSession）负责在重启运行时前创建目录；launcher 只负责加载。
const userPatchDir = process.env.PI_WEB_DSH_DATA_DIR
	? join(process.env.PI_WEB_DSH_DATA_DIR, "dsh-patches")
	: (process.env.PI_WEB_DSH_PATCH_DIR ?? null);
const userPatchFiles = [];
if (userPatchDir) {
	try {
		for (const name of readdirSync(userPatchDir)) {
			if (/^[^.]/u.test(name) && /\.ya?ml$/iu.test(name)) {
				userPatchFiles.push(join(userPatchDir, name));
			}
		}
	} catch {
		// 目录不存在/不可读 = 无用户 patch，静默跳过。
	}
}
userPatchFiles.sort((a, b) => a.localeCompare(b));

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

const { boot, installFailLoud, loadOverlayPatches } = await import(
	pathToFileURL(join(runtimeBase, "@deepseek-ai", "dsh-app-boot", "lib", "index.js")).href
);

// cordis loader 只对 entry 的 config 做 !!js 插值，name 字段不支持。
// sdk-jsonrpc 走本地扩展插件 goal-rpc.mjs（官方 server 类 + goal RPC 方法）；
// 官方入口（base 类）通过 env PI_WEB_DSH_JSONRPC_ENTRY 传给 wrapper。
const jsonrpcWrapper = join(HERE, "goal-rpc.mjs");
const _jsonrpcEntry = process.env.PI_WEB_DSH_JSONRPC_ENTRY
	? resolve(process.env.PI_WEB_DSH_JSONRPC_ENTRY)
	: join(
			resolve(HERE, "..", "..", "..", ".."),
			"node_modules",
			"@deepseek-ai",
			"dsh-sdk-jsonrpc-server",
			"lib",
			"index.js",
		);

const overrideList = loadOverlayPatches(BIN_NAME, overridePatch);
// cordis loader 只对 entry 的 config 做 !!js 插值，name 字段不支持——
// 插件绝对路径在这里用 JS 写回（sdk-jsonrpc → 本地 goal-rpc wrapper；
// 用户 patch 若用 id 覆盖 sdk-jsonrpc 或 insert 同名 entry 也拿到 wrapper）。
const fixJsonrpcName = (patch) => {
	if (patch.id === "sdk-jsonrpc") {
		patch.name = jsonrpcWrapper;
	}
	for (const entry of patch.insert ?? []) {
		if (entry.id === "sdk-jsonrpc") entry.name = jsonrpcWrapper;
	}
};
for (const patch of overrideList) fixJsonrpcName(patch);
const userPatchLists = userPatchFiles.map((file) => {
	try {
		return loadOverlayPatches(BIN_NAME, file);
	} catch (err) {
		process.stderr.write(`[${BIN_NAME}] 跳过用户 patch ${file}: ${err?.message ?? String(err)}\n`);
		return [];
	}
});
for (const list of userPatchLists) for (const patch of list) fixJsonrpcName(patch);
// patches 参数必须是扁平列表（boot → mountRootInclude → Include.applyPatches →
// applyEntryPatches 逐个消费；数组嵌套会被当无 id 的 patch 跳过）。
const patches = [
	...loadOverlayPatches(BIN_NAME, baseBundlePatch),
	...overrideList,
	// 用户 patch：同样按文件展开为扁平 patch entry 列表（一个文件可含多 entry）。
	...userPatchLists.flat(),
];

let ctx;
try {
	ctx = await boot(
		BIN_NAME,
		runConfig,
		patches,
		undefined,
		// 裸包名（dsh-base 组合行）锚定到运行时树；jsonrpc 行走绝对路径。
		pathToFileURL(runtimeBase + "/").href,
	);
} catch (err) {
	const seen = new Set();
	const walk = (e, depth) => {
		if (!e || seen.has(e)) return;
		seen.add(e);
		const msg = e?.message ?? String(e);
		const indent = "    " + "  ".repeat(Math.min(depth, 6));
		process.stderr.write(`${indent}${msg}\n`);
		const kids = e?.aggregateErrors ?? e?.errors ?? (e?.cause ? [e.cause] : []);
		for (const k of kids) walk(k, depth + 1);
	};
	process.stderr.write(`[${BIN_NAME}] boot 失败: ${err?.message ?? String(err)}\n   runtime base: ${runtimeBase}\n`);
	walk(err, 0);
	process.exit(1);
}

let releasing = false;
const release = () => {
	if (releasing) return;
	releasing = true;
	void (async () => {
		try {
			await ctx.fiber.dispose();
		} catch (err) {
			console.error(`[${BIN_NAME}] teardown 错误: ${err?.message ?? String(err)}`);
		}
		process.exit(0);
	})();
	return true;
};
installFailLoud(BIN_NAME, process, release);

// stdin EOF = 客户端消失 → 有序释放后退出。
process.stdin.resume();
process.stdin.on("end", release);
process.stdin.on("close", release);
process.on("SIGTERM", release);
process.on("SIGINT", () => process.exit(130));
