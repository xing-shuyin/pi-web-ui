#!/usr/bin/env node
/**
 * check-protocol-sync.mjs — 校验 wire 协议单源机制仍然成立。
 *
 * web/src/types.ts 已不再手工镜像 server/protocol.ts，而是
 * `export type * from "../../server/protocol"` 全量再导出（唯一事实源），
 * 协议改动只改 protocol.ts 一处，双端永远同步。
 *
 * 本脚本守护两个不变量：
 *   1. types.ts 确实是 shim（有人退回手工镜像时立刻发现）；
 *   2. protocol.ts 保持纯类型导出（出现 export const/function/class 等
 *      运行时代码会破坏「类型擦除、不共享运行时」的前提）。
 *
 * 用法：node scripts/check-protocol-sync.mjs（typecheck / CI 里自动跑）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const typesSrc = readFileSync(join(root, "web/src/types.ts"), "utf8");
const protocolSrc = readFileSync(join(root, "server/protocol.ts"), "utf8");

let failed = false;

// 1. shim 存在
if (!/export\s+type\s+\*\s+from\s+"\.\.\/\.\.\/server\/protocol"/.test(typesSrc)) {
	console.error(
		"✗ web/src/types.ts 不再是 re-export shim —— 协议必须以 server/protocol.ts 为唯一事实源，不要退回手工镜像。",
	);
	failed = true;
} else {
	console.log("✓ types.ts 是 protocol.ts 的 type-only re-export shim");
}

// 2. protocol.ts 无运行时代码导出
const runtimeExports = [
	...protocolSrc.matchAll(/^export\s+(?!type\b|interface\b)(?:declare\s+)?(const|let|var|function|class|enum)\b/gm),
].map((m) => m[1]);
if (runtimeExports.length > 0) {
	console.error(
		`✗ server/protocol.ts 出现运行时代码导出（${[...new Set(runtimeExports)].join(", ")}）——该文件必须保持纯类型，前端要经 type-only re-export 引用它。`,
	);
	failed = true;
} else {
	console.log("✓ protocol.ts 保持纯类型导出（无运行时代码）");
}

// 3. 双端协议版本号一致
const serverVerSrc = readFileSync(join(root, "server/protocol-version.ts"), "utf8");
const webVerSrc = readFileSync(join(root, "web/src/protocol-version.ts"), "utf8");
const mServer = serverVerSrc.match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
const mWeb = webVerSrc.match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
if (!mServer || !mWeb || mServer[1] !== mWeb[1]) {
	console.error(
		`✗ 协议版本号不一致：server=${mServer?.[1] ?? "?"} web=${mWeb?.[1] ?? "?"} —— 改协议时必须同步 bump 两份 PROTOCOL_VERSION。`,
	);
	failed = true;
} else {
	console.log(`✓ 双端 PROTOCOL_VERSION 一致 (v${mServer[1]})`);
}

if (failed) process.exit(1);
