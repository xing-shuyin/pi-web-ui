/**
 * 单测分层：哪些文件属于「重型集成」，默认 `npm test` 不跑。
 *
 * 判据只有一条：实测耗时 ≥60s（本机 Windows 12C/24T、maxWorkers=4 的稳态基线）。
 * 这些文件的成本不在断言，而在真跑 git 子进程 / 真起 Hub HTTP / 真执行验证命令，
 * 单条用例 15–35s 是常态，且在同一 worker 池里会把彼此拉长 2–3×（实测 8 worker 下有
 * 用例从 30s 膨胀到 83s 并撞超时）。所以它们单独成池、单独命令，串行跑反而更稳。
 *
 * 新增重文件时：只改这里 + 跑 `tests/unit/test-suite-partition.test.ts` 确认全覆盖。
 */

import os from "node:os";

/** 重型集成测试：真 git / 真子进程 / 真 Hub。（路径相对仓库根） */
export const HEAVY_SUITE = [
	"tests/unit/device-hub-artifact-integration.test.ts",
	"tests/unit/device-local-integration.test.ts",
	"tests/unit/device-hub-integration.test.ts",
	"tests/unit/task-workspace.test.ts",
	"tests/unit/canvas-workspace.test.ts",
	"tests/unit/device-center-runtime-code-artifact.test.ts",
];

/** 重型池的硬性上限：这些用例靠子进程与 fsync 吃饭，再抬并发只会互相拖累（实测 8 worker 即破预算）。 */
export const HEAVY_MAX_WORKERS = 4;

/** 重型单条的预算：单跑最慢 52s，满载实测 2–2.5× 膨胀，故 90s（与 task-workspace 的重用例对齐）。 */
export const HEAVY_TIMEOUT_MS = 90_000;

/** 默认池（除重型之外的全部单位单测）在 `npm test` 里应保持秒级反馈。
 *
 * 实测扫描（1023 文件 / 12383 条，Windows 12C/24T）：4 → 280s、8 → 186s、12 → 172s 但出现 1 条假红
 * （`canvas-scheduler` 内部的 `vi.waitFor({timeout: 15_000})` 被 12 路争抢拖过预算）。取 8：再高只能
 * 换 14s 壁钟，代价是开始撞各种写死的内部等待预算。 */
export const FAST_MAX_WORKERS = workerBudget();

/**
 * fork 数上限：8 是本机 12C/24T 的实测最优，但 GitHub 的 ubuntu-latest 只有 4 vCPU，
 * 8 个 fork 抢 4 个核时并行系数只有 1.66×（单测墙钟 392s / 用例累计 628s）。
 * 所以按实际核数收口：4 核 runner 用 4，开发机仍然用 8。
 */
function workerBudget() {
	const cores = (() => {
		try {
			return os.availableParallelism?.() ?? os.cpus().length;
		} catch {
			return 8;
		}
	})();
	return Math.max(2, Math.min(8, cores));
}
