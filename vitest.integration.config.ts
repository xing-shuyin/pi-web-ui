import "./tests/lib/hide-windows.mjs";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HEAVY_MAX_WORKERS, HEAVY_SUITE, HEAVY_TIMEOUT_MS } from "./tests/lib/suite-partition.mjs";

const root = dirname(fileURLToPath(import.meta.url));

/**
 * 重型集成池：真跑 git 子进程 / 真起 Hub HTTP / 真执行验证命令的那批文件。
 *
 * 与 `vitest.config.ts` 分开的理由不是洁癖，是实测：它们在同一池里会互相把彼此拉长 2–3×
 * （单条 17s 的用例 4 worker 满载变 31s，8 worker 变 83s 直接撞预算），所以并发要卡在 4，
 * 预算要给到 90s。默认 `npm test` 不跑它们（秒级反馈），`npm run test:integration` 单独跑。
 */
export default defineConfig({
	resolve: {
		alias: {
			"@pi-web-ui/plugin-sdk/client": join(root, "plugin-sdk", "client.mjs"),
		},
	},
	test: {
		include: HEAVY_SUITE,
		environment: "node",
		pool: "forks",
		maxWorkers: HEAVY_MAX_WORKERS,
		setupFiles: ["tests/unit/setup-chrome-i18n.ts"],
		silent: true,
		onConsoleLog: () => false,
		reporters: ["default", "./tests/lib/test-timing-reporter.mjs"],
		testTimeout: HEAVY_TIMEOUT_MS,
		hookTimeout: HEAVY_TIMEOUT_MS,
		teardownTimeout: 30_000,
	},
});
