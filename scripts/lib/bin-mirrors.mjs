// 镜像件清单（生成脚本与守卫测试共用同一份，避免两边各写一套路径）。
//
// 每新增一件镜像：这里加一行，生成脚本与 `tests/unit/bin-mirror.test.ts` 自动跟上。
export const MIRRORS = [
	{
		distPath: "dist/server/hide-console-windows.js",
		targetPath: "bin/lib/hide-console-windows.mjs",
		source: "server/hide-console-windows.ts",
		guard: "tests/unit/bin-mirror.test.ts",
	},
	{
		distPath: "dist/server/shell-quote.js",
		targetPath: "bin/lib/shell-quote.mjs",
		source: "server/shell-quote.ts",
		guard: "tests/unit/bin-mirror.test.ts",
	},
];
