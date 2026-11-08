import "./tests/lib/hide-windows.mjs";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			"@pi-web-ui/plugin-sdk/client": join(root, "plugin-sdk", "client.mjs"),
		},
	},
	test: {
		include: ["tests/unit/**/*.test.ts"],
		environment: "node",
		// 子进程池：用例卡死时 worker 能被回收，不连坐整轮（vitest 5 已移除 poolOptions，只能写 pool）
		pool: "forks",
		maxWorkers: 4,
		setupFiles: ["tests/unit/setup-chrome-i18n.ts"],
		silent: true,
		onConsoleLog: () => false,
		// 防挂死软上限：默认 5s 在 CI 慢机/并行压满时会误杀本仓最慢的那批集成用例（实测 30s 仍会偶发红，60s 稳）；
		// 真正兜硬底的是 CI job 的 timeout-minutes 与 scripts/safe-exec.mjs 的硬超时，这里只管「不要无限等」。
		testTimeout: 60_000,
		hookTimeout: 60_000,
		teardownTimeout: 30_000,
	},
});
