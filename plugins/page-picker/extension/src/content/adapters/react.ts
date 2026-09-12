/// <reference lib="dom" />
/**
 * React 源码定位：从 fiber 的 `_debugSource` 挖出「组件文件:行号」。
 *
 * 为什么值得单独写：这是「AI 一次改对」和「AI 满仓库 grep」的分界线。开发模式下
 * （Vite + @vitejs/plugin-react 的 jsxDev，或 webpack 的 jsx-dev-runtime）每个元素上
 * 都挂着 fiber，往上找第一个带 `_debugSource` 的就能拿到 JSX 出处。
 *
 * 已知差异（都做了兜底，认不出来就返回 undefined，绝不抛）：
 * - 键名带随机后缀（`__reactFiber$abc123`）→ 只能按前缀认；
 * - React 17/18 会把 `__source` 挂到 props 上，React 19 移除了 → 两条路都试；
 * - 生产构建没有这些信息 → 直接放弃（`kind` 都不会返回）。
 */

import type { SourceRef } from "../../shared/contract.js";

/** fiber 上的字段（只声明我们用到的部分）。 */
interface FiberLike {
	_debugSource?: { fileName?: string; lineNumber?: number; columnNumber?: number };
	_debugOwner?: FiberLike | null;
	memoizedProps?: Record<string, unknown> | null;
	elementType?: unknown;
	type?: unknown;
	return?: FiberLike | null;
}

const FIBER_PREFIXES = ["__reactFiber$", "__reactInternalInstance$"];

export function reactSource(el: Element): SourceRef | undefined {
	const fiber = findFiber(el);
	if (!fiber) return undefined;
	let node: FiberLike | null = fiber;
	let hops = 0;
	while (node && hops < 30) {
		const src = node._debugSource ?? sourceFromProps(node);
		if (src?.fileName) {
			return {
				kind: "react",
				file: toSourcePath(src.fileName),
				...(src.lineNumber ? { line: src.lineNumber } : {}),
				...(src.columnNumber ? { column: src.columnNumber } : {}),
				...(componentName(node) ? { component: componentName(node) } : {}),
				...(chainOf(fiber) ? { chain: chainOf(fiber) } : {}),
			};
		}
		node = node.return ?? null;
		hops++;
	}
	return undefined;
}

function findFiber(el: Element): FiberLike | undefined {
	for (const key of Object.keys(el)) {
		if (FIBER_PREFIXES.some((p) => key.startsWith(p))) {
			const fiber = (el as unknown as Record<string, unknown>)[key];
			if (fiber && typeof fiber === "object") return fiber as FiberLike;
		}
	}
	return undefined;
}

/** React 17/18 把 `__source` 放在 memoizedProps 上（React 19 已移除）。 */
function sourceFromProps(node: FiberLike): FiberLike["_debugSource"] {
	const source = node.memoizedProps?.__source;
	if (!source || typeof source !== "object") return undefined;
	return source as FiberLike["_debugSource"];
}

/** 组件名：优先显式 displayName，其次函数名；匿名组件返回空。 */
function componentName(node: FiberLike): string {
	for (const candidate of [node.elementType, node.type]) {
		const name = nameOf(candidate);
		if (name) return name;
	}
	return "";
}

function nameOf(value: unknown): string {
	if (typeof value === "function") {
		const fn = value as { displayName?: string; name?: string };
		return fn.displayName || fn.name || "";
	}
	if (value && typeof value === "object") {
		const obj = value as { displayName?: string; render?: { displayName?: string; name?: string } };
		return obj.displayName || obj.render?.displayName || obj.render?.name || "";
	}
	return "";
}

/** 组件调用链：从被选组件往上取若干层名字（组件被复用时这比行号还重要）。 */
function chainOf(fiber: FiberLike | undefined): string[] | undefined {
	if (!fiber) return undefined;
	const names: string[] = [];
	let node: FiberLike | null = fiber;
	let hops = 0;
	while (node && hops < 60 && names.length < 5) {
		const name = componentName(node);
		if (name && !names.includes(name)) names.push(name);
		node = node.return ?? null;
		hops++;
	}
	return names.length > 1 ? names : undefined;
}

/** Vite dev 的 fileName 是完整 URL（带 ?t= 缓存参数）→ 收敛成 dev server 路径。 */
export function toSourcePath(fileName: string): string {
	let out = fileName.trim();
	out = out.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ""); // 去 origin
	out = out.replace(/[?#].*$/, ""); // 去 query/hash
	return out || fileName.trim();
}
