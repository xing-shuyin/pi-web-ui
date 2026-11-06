#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const typesSrc = readFileSync(join(root, "web/src/types.ts"), "utf8");
const protocolSrc = readFileSync(join(root, "server/protocol.ts"), "utf8");

let failed = false;

if (!/export\s+type\s+\*\s+from\s+"\.\.\/\.\.\/server\/protocol"/.test(typesSrc)) {
	console.error(
		"✗ web/src/types.ts 不再是 re-export shim —— 协议必须以 server/protocol.ts 为唯一事实源，不要退回手工镜像。",
	);
	failed = true;
} else {
	console.log("✓ types.ts 是 protocol.ts 的 type-only re-export shim");
}

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

{
	let usable = true;
	const diffQuiet = (range, file) => {
		try {
			execFileSync("git", ["diff", "--quiet", range, "--", file], { cwd: root, stdio: "pipe" });
			return false;
		} catch (err) {
			if (err?.status === 1) return true;
			usable = false;
			return false;
		}
	};
	let tag = null;
	try {
		tag = execFileSync("git", ["describe", "--tags", "--abbrev=0"], { cwd: root, encoding: "utf8" }).trim();
	} catch {
		usable = false;
	}
	if (!usable || !tag) {
		console.log("· 跳过协议版本 git 启发式（无可用 tag 或浅检出环境）");
	} else {
		const protocolChanged = diffQuiet(tag, "server/protocol.ts");
		const versionChanged =
			diffQuiet(tag, "server/protocol-version.ts") || diffQuiet(tag, "web/src/protocol-version.ts");
		if (!usable) {
			console.log("· 跳过协议版本 git 启发式（git 判定不可用）");
		} else if (protocolChanged && !versionChanged) {
			console.error(
				`✗ protocol.ts 自 ${tag} 起有改动但 PROTOCOL_VERSION 未 bump——新增/变更 wire 字段必须同步 bump server/web 两份 PROTOCOL_VERSION。`,
			);
			failed = true;
		} else {
			console.log(
				`✓ 协议版本纪律（相对 ${tag}）：${protocolChanged ? "协议有改动且已 bump" : "协议相对上一 tag 无改动"}`,
			);
		}
	}
}

if (failed) process.exit(1);
