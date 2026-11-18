#!/usr/bin/env node
// 生成 bin/lib/ 下的镜像件（单一实现来自 server/*.ts；CLI 侧是纯 .mjs，不能 import TS）。
// 依赖 dist/，所以必须在 build:server 之后跑 —— `npm run build:server` 末尾已串上本脚本。
// 清单在 scripts/lib/bin-mirrors.mjs，守卫在 tests/unit/bin-mirror.test.ts。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIRRORS } from "./lib/bin-mirrors.mjs";
import { renderBinMirror } from "./lib/bin-mirror.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let failed = 0;
for (const spec of MIRRORS) {
	const distEntry = join(root, spec.distPath);
	if (!existsSync(distEntry)) {
		console.error(`[gen-bin-mirrors] 缺少 ${spec.distPath}：先跑 npm run build:server`);
		failed++;
		continue;
	}
	const target = join(root, spec.targetPath);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, await renderBinMirror(readFileSync(distEntry, "utf8"), spec));
	console.log(`[gen-bin-mirrors] ${spec.targetPath} ← ${spec.distPath}`);
}
if (failed > 0) process.exit(1);
