/**
 * 扩展构建：esbuild 打包三个入口到 `dist/`。
 *
 * 为什么需要构建（而插件系统那边是裸 ESM）：MV3 的 **content script 不支持 import**
 * （它不是 module），必须打成一个自包含文件；background 走 service worker 可以带
 * `type: "module"`，但一并打包省得关心路径解析。
 *
 * 用法：node plugins/page-picker/extension/build.mjs   （或 npm run build:extension）
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outdir = join(here, "dist");
mkdirSync(outdir, { recursive: true });

const common = {
	bundle: true,
	target: "chrome116",
	sourcemap: false,
	logLevel: "info",
	legalComments: "none",
};

await build({
	...common,
	entryPoints: [join(here, "src/background.ts")],
	format: "esm",
	outfile: join(outdir, "background.js"),
});

await build({
	...common,
	entryPoints: [join(here, "src/content/picker.ts")],
	format: "iife",
	outfile: join(outdir, "picker.js"),
});

await build({
	...common,
	entryPoints: [join(here, "src/options.ts")],
	format: "esm",
	outfile: join(outdir, "options.js"),
});

console.log("✓ page-picker extension → plugins/page-picker/extension/dist/");
