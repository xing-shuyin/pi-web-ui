#!/usr/bin/env node
/**
 * 生成 `desktop/protocol-expectation.ts`：壳在构建期锁定"我这份壳对应哪个协议版本"。
 *
 * 为什么必须是生成的文件、而不是 import：
 * 纯壳包（`desktop/electron-builder.shell.yml`）**不带 `dist/server`**，
 * 运行时的 `../server/protocol-version.js` 根本不存在 —— 直接 import 就是安装版崩溃。
 * 所以把数字在构建期烘进壳里，运行时只做纯比较（`desktop/kernel-compat.ts`）。
 *
 * 单源仍是 `server/protocol-version.ts`；生成物与它不一致时单测会红
 * （`tests/unit/desktop-kernel-compat.test.ts` 直接读源文件比对）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "server", "protocol-version.ts"), "utf8");

function readConst(name) {
	const match = source.match(new RegExp(`export const ${name} = (\\d+);`));
	if (!match) {
		console.error(`✖ 读不到 ${name}（server/protocol-version.ts 结构变了？）`);
		process.exit(1);
	}
	return Number(match[1]);
}

const protocol = readConst("PROTOCOL_VERSION");
const minShell = (() => {
	try {
		const identity = readFileSync(join(root, "server", "kernel-identity.ts"), "utf8");
		const match = identity.match(/export const KERNEL_MIN_SHELL = (\d+);/);
		return match ? Number(match[1]) : null;
	} catch {
		return null;
	}
})();

const target = join(root, "desktop", "protocol-expectation.ts");
const body = `/**
 * 生成文件，勿手改 —— \`node scripts/gen-desktop-protocol.mjs\`（\`npm run build:desktop\` 里跑）。
 *
 * 壳在构建期锁定的协议版本：纯壳包不带 \`dist/server\`，运行时无法读源码取版本，
 * 只能在构建时把数字烘进来，运行时交给 \`desktop/kernel-compat.ts\` 纯比较。
 */
export const DESKTOP_EXPECTED_PROTOCOL = ${protocol};
/** 内核声明的兼容下限（与 \`server/kernel-identity.ts\` 的 KERNEL_MIN_SHELL 对表；读不到时为 null）。 */
export const DESKTOP_KERNEL_MIN_SHELL: number | null = ${minShell === null ? "null" : minShell};
`;
writeFileSync(target, body, "utf8");
console.log(
	`[gen-desktop-protocol] protocol=${protocol} minShell=${minShell ?? "?"} → desktop/protocol-expectation.ts`,
);
