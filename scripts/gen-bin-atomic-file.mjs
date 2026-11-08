#!/usr/bin/env node
// 生成 bin/lib/atomic-file.mjs（单一实现来自 server/atomic-file.ts，避免 worker 侧另写一套退避逻辑）。
// 依赖 dist/server/atomic-file.js，所以必须在 build:server 之后跑。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderBinAtomicFile } from "./lib/atomic-file-generator.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distEntry = join(root, "dist/server/atomic-file.js");
if (!existsSync(distEntry)) {
	console.error("[gen-atomic] 缺少 dist/server/atomic-file.js：先跑 npm run build:server");
	process.exit(1);
}
const atomic = await import(pathToFileURL(distEntry).href);
const target = join(root, "bin/lib/atomic-file.mjs");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, await renderBinAtomicFile(atomic));
console.log(`[gen-atomic] bin/lib/atomic-file.mjs ← ${distEntry}`);
