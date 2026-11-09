import { build } from "vite";
import { build as esbuild } from "esbuild";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { copyFileSync, existsSync } from "node:fs";

const root = fileURLToPath(new URL("../browser/renderer/", import.meta.url));
await build({
	configFile: false,
	root,
	base: "./",
	build: {
		outDir: resolve(root, "../../dist/browser/renderer"),
		emptyOutDir: true,
		sourcemap: false,
		rollupOptions: {
			input: Object.fromEntries(
				["shell", "panel", "newtab", "office", "workspace"].map((name) => [name, resolve(root, `${name}.html`)]),
			),
		},
	},
});

const filesToCopy = ["dock.js"];
for (const file of filesToCopy) {
	const src = resolve(root, file);
	const dest = resolve(root, "../../dist/browser/renderer", file);
	if (existsSync(src)) copyFileSync(src, dest);
}

// 桌面 preload 现在 import 了 electron-chrome-extensions（扩展动作列表）。沙箱渲染器里的 preload
// 没有模块解析能力，所以 preload 必须打成单文件（tsc 已经先输出过一份，这里覆盖它）。
await esbuild({
	entryPoints: [fileURLToPath(new URL("../desktop/preload.cts", import.meta.url))],
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node22",
	external: ["electron"],
	outfile: fileURLToPath(new URL("../dist/desktop/preload.cjs", import.meta.url)),
	logLevel: "warning",
});
