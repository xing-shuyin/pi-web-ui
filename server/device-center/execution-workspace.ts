import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function executionRoot(path: string): string {
	let root = resolve(path);
	try {
		root = realpathSync.native(root);
	} catch {}
	return process.platform === "win32" ? root.toLowerCase() : root;
}

export function executionRootsOverlap(left: string, right: string): boolean {
	const contains = (a: string, b: string) => {
		const path = relative(a, b);
		return !path || (!isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"));
	};
	return contains(left, right) || contains(right, left);
}
