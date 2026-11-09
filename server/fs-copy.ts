import { cpSync, lstatSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/**
 * 复制目录树的单源原语。
 *
 * 为什么必须集中一处：判据只在**相对路径**上生效才有意义。npm -g 安装时源目录自身就在
 * `.../node_modules/pi-web-ui/plugins/<id>` 里，用绝对路径去匹配 `node_modules` 会把整棵树
 * （连根带叶）全部过滤掉，得到一份空副本还以为成功（issue #856）。
 */

/** 默认永不复制的内容：版本库元数据与可重装的依赖树 */
export const SKIP_VCS_AND_DEPS: readonly string[] = [".git", "node_modules"];

export function toPosixPath(rel: string): string {
	return sep === "/" ? rel : rel.split(sep).join("/");
}

/** 相对路径里出现被跳过名字的任意一段即跳过；源根（`""`）永远放行 */
export function isSkippedPath(rel: string, skip: readonly string[]): boolean {
	if (!rel) return false;
	return rel.split(/[\\/]/).some((part) => skip.includes(part));
}

export function copyTree(
	src: string,
	dst: string,
	opts: { skip?: readonly string[]; missingOnly?: boolean } = {},
): void {
	const skip = opts.skip ?? SKIP_VCS_AND_DEPS;
	cpSync(src, dst, {
		recursive: true,
		// 判据用相对路径：源根路径本身可能含 node_modules（全局安装布局）
		filter: (from, to) => {
			if (isSkippedPath(relative(src, from), skip)) return false;
			// 只补缺：目录必须放行（否则整棵子树都进不来），已存在的文件一律不覆盖
			if (!opts.missingOnly) return true;
			try {
				return lstatSync(from).isDirectory() || !statExists(to);
			} catch {
				return true;
			}
		},
	});
}

function statExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/** 列出目录树里的普通文件（posix 相对路径，已排序），跳过 `skip` 命中的目录 */
export function listTreeFiles(root: string, opts: { skip?: readonly string[] } = {}): string[] {
	const skip = opts.skip ?? SKIP_VCS_AND_DEPS;
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (skip.includes(entry.name)) continue;
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) walk(abs);
			else if (entry.isFile()) out.push(toPosixPath(relative(root, abs)));
		}
	};
	walk(root);
	return out.sort();
}

/** 删除 `stale` 列出的文件（只接受 root 内的相对路径），并顺手清理空出来的目录 */
export function pruneTreeFiles(root: string, stale: readonly string[]): void {
	for (const rel of stale) {
		if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) continue;
		const abs = join(root, rel);
		try {
			rmSync(abs, { force: true });
		} catch {
			continue;
		}
		let dir = dirname(abs);
		while (dir !== root && dir.startsWith(root)) {
			try {
				if (readdirSync(dir).length) break;
				rmdirSync(dir);
			} catch {
				break;
			}
			dir = dirname(dir);
		}
	}
}
