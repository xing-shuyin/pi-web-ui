import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MAX_PKG_BYTES = 512 * 1024;

function readScripts(pkgPath: string): Record<string, string> | undefined {
	try {
		if (!existsSync(pkgPath) || statSync(pkgPath).size > MAX_PKG_BYTES) return undefined;
		const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as unknown as {
			scripts?: unknown;
		};
		if (!raw || typeof raw !== "object" || !raw.scripts || typeof raw.scripts !== "object") return undefined;
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(raw.scripts as Record<string, unknown>)) {
			if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 500);
			if (Object.keys(out).length >= 60) break;
		}
		return Object.keys(out).length > 0 ? out : undefined;
	} catch {
		return undefined;
	}
}

/** 从 cwd 就近向上找 package.json（含 scripts 的那一层），找不到返回 cwd 本身 + 空表。 */
export function resolveProjectScripts(cwd: string): { cwd: string; scripts: Record<string, string> } {
	const start = resolve(cwd || process.cwd());
	let cur: string | undefined = start;
	while (cur) {
		const scripts = readScripts(join(cur, "package.json"));
		if (scripts) return { cwd: cur, scripts };
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return { cwd: start, scripts: {} };
}
