#!/usr/bin/env node
/**
 * 清掉冒烟/集成测试留下的残留进程（默认**只看不动**）。
 *
 *   node scripts/kill-test-servers.mjs            # 列出残留（dry-run）
 *   node scripts/kill-test-servers.mjs --kill     # 真的杀（进程树）
 *
 * 判定只看命令行特征（`dist/server/index.js` / `tests/*-test.mjs` / `tests/run-smoke.mjs`），
 * **不按端口段盲杀**：同一台机器上可能还有别人的 `npm run dev` 或另一份测试在跑。
 */
import { findTestResidue, sweepTestResidue } from "../tests/lib/process-cleanup.mjs";

const kill = process.argv.includes("--kill");
const { found, killed } = sweepTestResidue({ dryRun: !kill });

if (found.length === 0) {
	console.log("✓ 没有测试残留进程");
	process.exit(0);
}

console.log(`${kill ? "清理" : "发现"} ${found.length} 个测试残留进程：`);
for (const item of found) {
	const mark = kill ? (killed.includes(item.pid) ? "✓ killed" : "✗ 失败") : "· dry-run";
	console.log(`  ${mark} pid=${item.pid}  ${item.commandLine.slice(0, 150)}`);
}
if (!kill) console.log("\n加 --kill 才会真的杀（杀的是进程树）。");
process.exit(kill && killed.length !== found.length ? 1 : 0);
