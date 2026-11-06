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
		maxWorkers: 4,
		setupFiles: ["tests/unit/setup-chrome-i18n.ts"],
		silent: true,
		onConsoleLog: () => false,
	},
});
