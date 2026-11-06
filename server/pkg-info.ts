import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cachedPkgRoot: string | null = null;
let cachedAppVersion: string | null = null;

export function getPkgRoot(fromUrl: string = import.meta.url): string {
	if (process.env.PI_WEB_PKG_ROOT && existsSync(join(process.env.PI_WEB_PKG_ROOT, "package.json"))) {
		return process.env.PI_WEB_PKG_ROOT;
	}
	if (cachedPkgRoot) return cachedPkgRoot;

	let dir = dirname(fileURLToPath(fromUrl));
	for (let i = 0; i < 5; i++) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
				if (pkg.name === "pi-web-ui") {
					cachedPkgRoot = dir;
					return dir;
				}
			} catch {}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	dir = dirname(fileURLToPath(fromUrl));
	const candidates = [resolve(dir, ".."), resolve(dir, "..", ".."), resolve(dir, "..", "..", "..")];
	for (const c of candidates) {
		if (existsSync(join(c, "package.json"))) {
			cachedPkgRoot = c;
			return c;
		}
	}

	cachedPkgRoot = candidates[0] ?? dir;
	return cachedPkgRoot;
}

export function getAppVersion(fromUrl: string = import.meta.url): string {
	if (cachedAppVersion !== null) return cachedAppVersion;
	try {
		const root = getPkgRoot(fromUrl);
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
		cachedAppVersion = pkg.version ?? "";
	} catch {
		cachedAppVersion = "";
	}
	return cachedAppVersion;
}
