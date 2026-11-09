import "./tests/lib/hide-windows.mjs";
import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FAST_MAX_WORKERS, HEAVY_SUITE } from "./tests/lib/suite-partition.mjs";

const root = dirname(fileURLToPath(import.meta.url));
// 默认池 = 全部单测 − 重型集成（清单与判据见 tests/lib/suite-partition.mjs）。
// `PI_TEST_ALL=1 npx vitest run` 一次跑完全部（CI 里的完整门禁走 npm run test:all）。
const runEverything = process.env.PI_TEST_ALL === "1";

export default defineConfig({
	resolve: {
		alias: {
			"@pi-web-ui/plugin-sdk/client": join(root, "plugin-sdk", "client.mjs"),
		},
	},
	test: {
		include: ["tests/unit/**/*.test.ts"],
		exclude: [...configDefaults.exclude, ...(runEverything ? [] : HEAVY_SUITE)],
		environment: "node",
		// 子进程池：用例卡死时 worker 能被回收，不连坐整轮（vitest 5 已移除 poolOptions，只能写 pool）
		pool: "forks",
		maxWorkers: FAST_MAX_WORKERS,
		setupFiles: ["tests/unit/setup-chrome-i18n.ts"],
		silent: true,
		onConsoleLog: () => false,
		// 逐条用例打印「结束时刻 + 耗时」+ 收尾慢榜：silent 吞掉了默认的 per-file 行，
		// 没有这个 reporter 就完全看不出慢在哪（PI_TEST_TIMING=slow|off 可收敛输出）。
		reporters: ["default", "./tests/lib/test-timing-reporter.mjs"],
		// 防挂死软上限：默认 5s 在 CI 慢机/并行压满时会误杀本仓最慢的那批集成用例（实测 30s 仍会偶发红，60s 稳）；
		// 真正兜硬底的是 CI job 的 timeout-minutes 与 scripts/safe-exec.mjs 的硬超时，这里只管「不要无限等」。
		testTimeout: 60_000,
		hookTimeout: 60_000,
		teardownTimeout: 30_000,
	},
});
