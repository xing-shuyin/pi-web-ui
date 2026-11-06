import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function distEntry(repoRoot) {
	return join(repoRoot, "dist", "server", "index.js");
}

export const PREBUILT_ENV = "PI_WEB_SMOKE_PREBUILT";

/**
 * 保证 `dist/` 可用。套件内直接返回（runner 已构建），单跑时自己构建一次。
 * @param {string} repoRoot 仓库根
 * @param {string} [label] 出错信息里的用例名
 */
export function ensureBuild(repoRoot, label = "smoke") {
	const entry = distEntry(repoRoot);
	if (process.env[PREBUILT_ENV] === "1") {
		if (!existsSync(entry)) {
			throw new Error(`[${label}] 套件声明 dist 已就绪，但找不到 ${entry}（检查 run-smoke.mjs 的构建步骤）`);
		}
		return;
	}
	try {
		execSync("npm run build", { cwd: repoRoot, stdio: "ignore" });
	} catch {
		throw new Error(`[${label}] npm run build 失败 —— 先手动跑一次看完整输出`);
	}
}
