import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cachedPkgRoot: string | null = null;
let cachedAppVersion: string | null = null;

/**
 * 解析 pi-web-ui 包的根目录。
 * 兼容：
 * - 源码开发模式：server/ (tsx)
 * - 源码子模块：server/dsh/ (tsx)
 * - 生产构建模式：dist/server/
 * - 生产构建子模块：dist/server/dsh/
 * - 环境变量显式指定：process.env.PI_WEB_PKG_ROOT
 */
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
			} catch {
				/* ignore */
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	// Fallback 策略：尝试向上找任意 package.json
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

/**
 * 获取 pi-web-ui 宿主运行时的真实版本号。
 * 若读取失败则 fallback 为 ""。
 */
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
