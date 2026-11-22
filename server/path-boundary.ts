/**
 * 路径边界单源（issue #972 / #973）：「目标是否落在授权根内」这个跨模块不变量只在这里判定。
 *
 * 历史上有 5 份各自为政的实现（`approval-rules.isPathInsideRoot`、`tool-guards.isInsideWorkspaceRoots`、
 * `plugins.isInsideWorkspace` / `assertRealInsideGrant`、`plugin-facilities.assertRealInsideRoot`、
 * `plugin-project.isInsideRoot` / `realPathOfNearest`），全是词法比较（`resolve` + `relative`）。词法比较有两类洞：
 *
 * 1. **链接穿透**：工作区里已存在的 junction / symlink 指向区外时（Windows 上 `node_modules/<pkg>`、
 *    `C:\Users\All Users` 都是链接），词法上仍「在区内」—— 默认 `workspace-write-never` 档会静默放行；
 * 2. **`..` 语义**：先 `resolve` 折叠 `..` 会把 `link/../x`（OS 语义：先跟随 link 到区外，再上跳到区外父级）
 *    算成 `cwd/x`；真实写入落在区外。
 *
 * 因此这里按 OS 解析顺序**逐段跟随链接**，目标不存在时用「最近存在祖先的 realpath + 剩余段」，
 * 任何调用点都不要再自己写 `relative(...).startsWith("..")`。
 */
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, parse, posix, sep } from "node:path";

/**
 * 把（可能相对的）raw 拼成绝对路径，但**不**折叠 `..`：折叠会改变 OS 解析顺序（见模块注释第 2 条）。
 * 空串按 `base`（OS 语义：空路径 = base 本身）。
 */
function absoluteWithoutCollapse(raw: string, base: string): string {
	const value = toPlatformSeparators(String(raw ?? ""));
	const baseValue = toPlatformSeparators(base);
	if (value === "") return baseValue;
	if (isAbsolute(value)) return value;
	const trimmedBase = baseValue.length > 1 && baseValue.endsWith(sep) ? baseValue.slice(0, -1) : baseValue;
	return trimmedBase.endsWith(sep) ? `${trimmedBase}${value}` : `${trimmedBase}${sep}${value}`;
}

/** Windows 上 `/` 与 `\` 等价：逐段 `dirname` 要求统一成平台分隔符，否则 `..` 退不上去。 */
function toPlatformSeparators(p: string): string {
	return sep === "\\" ? p.replace(/\//g, "\\") : p;
}

function tryRealpath(p: string): string | null {
	try {
		return realpathSync.native(p);
	} catch {
		try {
			return realpathSync(p);
		} catch {
			return null;
		}
	}
}

function joinChild(parent: string, name: string): string {
	return /[\\/]$/.test(parent) ? `${parent}${name}` : `${parent}${sep}${name}`;
}

/**
 * 目标（含不存在路径）的真实路径：
 * 逐段按 OS 顺序解析，每段尽量换成 realpath；某段起不存在时，其后各段按字面拼在「最近存在祖先的 realpath」后面。
 * 相对路径按 `process.cwd()` 拼（调用方要给绝对路径时请自己先拼；本地工具路径请配合 `isInsideRoots` 的 `base`）。
 */
export function realPathOrNearest(raw: string): string {
	const abs = absoluteWithoutCollapse(String(raw ?? ""), process.cwd());
	const parsed = parse(abs);
	const root = parsed.root || `${parse(process.cwd()).root}`;
	// 认不出根（盘符相对路径等畸形输入）就原样返回：调用方按「不在任何根内」处理，不猜。
	if (!abs.startsWith(root)) return abs;
	let current = root;
	let resolvable = true;
	for (const segment of abs.slice(root.length).split(/[\\/]+/)) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			current = dirname(current);
			continue;
		}
		const next = joinChild(current, segment);
		if (resolvable) {
			const real = tryRealpath(next);
			if (real !== null) {
				current = real;
				continue;
			}
			resolvable = false;
		}
		current = next;
	}
	return current;
}

/** 比较键：分隔符归一 + 去尾斜杠 + Windows 大小写折叠（Windows 路径不分大小写）。 */
function comparablePath(p: string): string {
	const slashed = p.replace(/[\\/]+/g, "/");
	const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
	return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/**
 * 目标真实路径是否落在任一授权根内（**参数次序：target 在前**）。
 * 两侧都过 `realPathOrNearest`：根本身是链接时按 realpath 比较。
 * `target` 相对时按 `base` 拼成绝对路径（不折叠 `..`）。
 */
export function isInsideRoots(target: string, roots: readonly string[], base: string = process.cwd()): boolean {
	const targetKey = comparablePath(realPathOrNearest(absoluteWithoutCollapse(String(target ?? ""), base)));
	for (const root of roots) {
		if (typeof root !== "string" || root.trim() === "") continue;
		const rootKey = comparablePath(realPathOrNearest(absoluteWithoutCollapse(root, base)));
		if (rootKey === "") continue;
		if (targetKey === rootKey) return true;
		if (targetKey.startsWith(rootKey.endsWith("/") ? rootKey : `${rootKey}/`)) return true;
	}
	return false;
}

/** 越界即抛错（`label` 用来让失败信息可读：越界的是哪类目标）。 */
export function assertInsideRoots(target: string, roots: readonly string[], label?: string): void {
	if (isInsideRoots(target, roots)) return;
	throw new Error(`路径越界（真实路径不在授权根内${label ? `：${label}` : ""}）：${target}`);
}

/**
 * 词法比较版：**只给远程虚拟路径用**（`resolveRemoteWorkspacePath` 那类 POSIX 字符串路径 ——
 * 路径属于远端主机，本地没有文件系统可 realpath）。本地路径**禁用**：本地一律走 `isInsideRoots`。
 */
export function isInsideRootsLexical(target: string, roots: readonly string[], base = "/"): boolean {
	const normalize = (raw: string): string => {
		const cleaned = String(raw ?? "")
			.replace(/\\/g, "/")
			.trim();
		const rootBase = posix.normalize(String(base ?? "/").replace(/\\/g, "/") || "/").replace(/\/+$/, "") || "/";
		const abs =
			cleaned === "" || cleaned === "."
				? rootBase
				: cleaned.startsWith("/")
					? posix.normalize(cleaned)
					: posix.resolve(rootBase, cleaned);
		return abs.length > 1 ? abs.replace(/\/+$/, "") : abs;
	};
	const targetKey = normalize(target);
	for (const root of roots) {
		if (typeof root !== "string" || root.trim() === "") continue;
		const rootKey = normalize(root);
		if (targetKey === rootKey) return true;
		if (targetKey.startsWith(rootKey.endsWith("/") ? rootKey : `${rootKey}/`)) return true;
	}
	return false;
}
