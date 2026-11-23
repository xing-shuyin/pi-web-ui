import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 搬家目标：老叶子最终住在这里（老位置只留 re-export shim）。 */
export const KEEL_SRC = join(root, "packages", "keel", "src");

/**
 * 红线守卫的源码扫描根。keel 目录还不存在时只扫老树 —— 守卫不能因为「目标目录没建」而红，
 * 也不能因为「模块搬走了」而静默失守。
 */
const roots: string[] = [join(root, "server"), KEEL_SRC];
export const SCAN_ROOTS: string[] = roots.filter((dir) => existsSync(dir));

export function walkTypeScript(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walkTypeScript(path, out);
		else if (entry.name.endsWith(".ts")) out.push(path);
	}
	return out;
}

const SHIM_PREFIXES = ["export *", "export type *", "export {"];

/** shim = 去掉空行与注释后，每条代码行都是 re-export（且不超过 5 行）；其余一律当真实现扫。 */
export function isShim(source: string): boolean {
	const lines = source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length === 0 || lines.length > 5) return false;
	return lines.every((line) => SHIM_PREFIXES.some((prefix) => line.startsWith(prefix)));
}

/** 模块真实现的绝对路径：优先 keel 里的非 shim 版本，否则老树；两边都没有就抛错（fail-closed）。 */
export function sourceOf(moduleBase: string): string {
	const keel = join(KEEL_SRC, `${moduleBase}.ts`);
	if (existsSync(keel) && !isShim(readFileSync(keel, "utf8"))) return keel;
	const legacy = join(root, "server", `${moduleBase}.ts`);
	if (existsSync(legacy)) return legacy;
	throw new Error(`找不到 ${moduleBase}.ts 的真实现：packages/keel/src 与 server 都没有`);
}

export function codeFiles(): string[] {
	return SCAN_ROOTS.flatMap((dir) => walkTypeScript(dir));
}
