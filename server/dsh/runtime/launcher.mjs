#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveRuntimeBaseWithDetails, getExpectedDshVersion, getDshFamily } from "./runtime-root.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN_NAME = "pi-web-ui-dsh";

const expectedVersion = getExpectedDshVersion();
const expectedFamily = getDshFamily(expectedVersion);

const { base: runtimeBase, scannedPaths, compatibility } = await resolveRuntimeBaseWithDetails();
if (!runtimeBase) {
	const pathList = scannedPaths
		.slice(0, 15)
		.map((s) => `  - ${s.path} (${s.exists ? s.reason || "已存在但非有效运行时树" : "不存在"})`)
		.join("\n");
	const more = scannedPaths.length > 15 ? `\n  ... 另有 ${scannedPaths.length - 15} 处候选` : "";
	process.stderr.write(
		`[${BIN_NAME}] 找不到 DSH 运行时树（含 @deepseek-ai/dsh-base 的 node_modules）。\n` +
			`请先执行 npm i -g @deepseek-ai/dsh@${expectedVersion}（或设置 PI_WEB_DSH_RUNTIME 指向其 node_modules 目录）。\n\n` +
			`已探测的候选路径：\n${pathList}${more}\n\n` +
			`详见文档 docs/dsh-engine.md。\n`,
	);
	process.exit(1);
}

process.env.PI_WEB_DSH_RUNTIME_BASE = runtimeBase;

if (!compatibility?.compatible) {
	const strictVer = process.env.PI_WEB_DSH_STRICT_VERSION === "1" || process.env.PI_WEB_DSH_STRICT_VERSION === "true";
	const verMsg =
		`[${BIN_NAME}] 注意：检测到 DSH 运行时版本（${compatibility?.runtimeVersion ?? "未知"}）与期望版本（${expectedVersion}，版本族 ${expectedFamily}）不同。\n` +
		`  - 运行时树位置：${runtimeBase}\n` +
		`  - 默认以可用运行时树为准并尝试向前兼容启动。如需强制版本一致，可设置 PI_WEB_DSH_STRICT_VERSION=1。\n`;

	if (strictVer) {
		process.stderr.write(
			`[${BIN_NAME}] DSH 运行时版本族不匹配（已开启 PI_WEB_DSH_STRICT_VERSION 严格模式）：\n` +
				`  - 检测到运行时版本：${compatibility?.runtimeVersion ?? "未知"}（位于 ${runtimeBase}）\n` +
				`  - pi-web-ui 期望版本族：${expectedFamily}（当前依赖 @deepseek-ai/dsh@${expectedVersion}）\n\n` +
				`推荐解决方案：\n` +
				`  1. 全局安装匹配版本的运行时：\n` +
				`     npm i -g @deepseek-ai/dsh@${expectedVersion}\n` +
				`  2. 或通过独立前缀安装并配置环境变量（推荐，不影响全局 CLI）：\n` +
				`     npm i -g @deepseek-ai/dsh@${expectedVersion} --prefix ~/.pi-web/dsh-runtime-${expectedFamily}\n` +
				`     并在启动 pi-web-ui 时设置环境变量：\n` +
				`     PI_WEB_DSH_RUNTIME=~/.pi-web/dsh-runtime-${expectedFamily}/lib/node_modules\n\n` +
				`详见文档 docs/dsh-engine.md。\n`,
		);
		process.exit(1);
	} else {
		process.stderr.write(verMsg);
	}
}

const runConfig = process.env.DSH_CORDIS_CONFIG ?? join(HERE, "cordis.yml");
const baseBundlePatch = join(runtimeBase, "@deepseek-ai", "dsh-base", "cordis.patch.yml");
const overridePatch = join(HERE, "override.patch.yml");

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
	} catch {}
}
userPatchFiles.sort((a, b) => a.localeCompare(b));

const presetPlanePatch = process.env.PI_WEB_DSH_PRESET_PATCH ?? null;

const { boot, installFailLoud, loadOverlayPatches } = await import(
	pathToFileURL(join(runtimeBase, "@deepseek-ai", "dsh-app-boot", "lib", "index.js")).href
);

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
let presetPlaneLists = [];
if (presetPlanePatch) {
	try {
		presetPlaneLists = loadOverlayPatches(BIN_NAME, presetPlanePatch);
	} catch (err) {
		process.stderr.write(`[${BIN_NAME}] 跳过 preset-plane patch ${presetPlanePatch}: ${err?.message ?? String(err)}\n`);
		presetPlaneLists = [];
	}
}
for (const patch of presetPlaneLists) fixJsonrpcName(patch);
const patches = [
	...loadOverlayPatches(BIN_NAME, baseBundlePatch),
	...overrideList,
	...presetPlaneLists,
	...userPatchLists.flat(),
];

let ctx;
try {
	ctx = await boot(BIN_NAME, runConfig, patches, undefined, pathToFileURL(runtimeBase + "/").href);
} catch (err) {
	const seen = new Set();
	let isTypertFailure = false;
	const walk = (e, depth) => {
		if (!e || seen.has(e)) return;
		seen.add(e);
		const msg = e?.message ?? String(e);
		if (
			msg.includes("typert contributor") ||
			msg.includes("codec has no create() factory") ||
			msg.includes("typert-loader")
		) {
			isTypertFailure = true;
		}
		const indent = "    " + "  ".repeat(Math.min(depth, 6));
		process.stderr.write(`${indent}${msg}\n`);
		const kids = e?.aggregateErrors ?? e?.errors ?? (e?.cause ? [e.cause] : []);
		for (const k of kids) walk(k, depth + 1);
	};
	process.stderr.write(`[${BIN_NAME}] boot 失败: ${err?.message ?? String(err)}\n   runtime base: ${runtimeBase}\n`);
	walk(err, 0);
	if (isTypertFailure || !compatibility?.compatible) {
		process.stderr.write(
			`\n[${BIN_NAME}] 诊断：检测到启动失败。当前运行时版本为 ${compatibility?.runtimeVersion ?? "未知"}（期望版本族 ${expectedFamily}）。\n` +
				`若因跨版本破坏性变更引起，请执行 npm i -g @deepseek-ai/dsh@${expectedVersion} 重新安装匹配版本的运行时。\n\n`,
		);
	}
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

process.stdin.resume();
process.stdin.on("end", release);
process.stdin.on("close", release);
process.on("SIGTERM", release);
process.on("SIGINT", () => process.exit(130));
