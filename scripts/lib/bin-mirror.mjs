// 「bin 侧镜像件」的渲染单源。
//
// 背景：`bin/**` 是纯 .mjs，不能 import TS；但里面确实要用 server 侧已单源的实现
// （Windows 不弹控制台开关、shell 引号）。仓库既有做法是「构建期把编译产物搬到 bin/lib/ + 守卫比对」
// （见 bin/lib/atomic-file.mjs）。这里把那段渲染逻辑收成一份，供多个镜像件复用。
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const BIN_LIB_DIR = join(REPO_ROOT, "bin/lib");

/** @typedef {{ distPath: string, targetPath: string, source: string, guard: string }} BinMirrorSpec */

/** @param {BinMirrorSpec} spec */
function headerFor(spec) {
	return [
		"// AUTO-GENERATED FILE — 不要手改。",
		`// 来源：${spec.source}（npm run build:server 编译产物整份搬运）`,
		"// 重新生成：npm run gen:bin-mirrors（npm run build:server 末尾也会跑）",
		`// 守卫：${spec.guard} 与 ${spec.distPath} 逐字节比对，漂移即红。`,
		"",
	].join("\n");
}

/**
 * 把 tsc 的编译产物渲染成 bin/lib 下的 .mjs：补生成头 + 按仓库 prettier 配置格式化
 * （否则 `npm run format:check` 会因为 tsc 的 4 空格缩进把生成件判红）。
 * @param {string} distSource
 * @param {BinMirrorSpec} spec
 * @returns {Promise<string>}
 */
export async function renderBinMirror(distSource, spec) {
	const body = String(distSource ?? "").replace(/\r\n/g, "\n");
	if (!body.trim()) throw new Error(`renderBinMirror: 空的编译产物（${spec.distPath}）`);
	const raw = `${headerFor(spec)}${body.startsWith("\n") ? body.slice(1) : body}`;
	const config = (await prettier.resolveConfig(join(REPO_ROOT, spec.targetPath))) ?? {};
	return await prettier.format(raw, { ...config, filepath: join(REPO_ROOT, spec.targetPath) });
}
