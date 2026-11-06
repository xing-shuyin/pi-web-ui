/// <reference lib="dom" />

import type { SourceRef } from "../../shared/contract.js";

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

function sourceFromProps(node: FiberLike): FiberLike["_debugSource"] {
	const source = node.memoizedProps?.__source;
	if (!source || typeof source !== "object") return undefined;
	return source as FiberLike["_debugSource"];
}

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

export function toSourcePath(fileName: string): string {
	let out = fileName.trim();
	out = out.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
	out = out.replace(/[?#].*$/, "");
	return out || fileName.trim();
}
