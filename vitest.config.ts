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
		// 纯函数单测：毫秒级、零 token、零端口 —— CI 必跑。
		// 端到端脚本（tests/*-test.mjs）不在这里：它们自起 server，用
		// `npm run test:smoke` / 单独 node 运行。
		include: ["tests/unit/**/*.test.ts"],
		environment: "node",
		// 浏览器、文件扫描与子进程用例共享 runner 资源，限制并发避免启动/计时互相挤占。
		maxWorkers: 4,
		setupFiles: ["tests/unit/setup-chrome-i18n.ts"],
		silent: true,
		onConsoleLog: () => false,
	},
});
