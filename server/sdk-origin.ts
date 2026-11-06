import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, delimiter, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "@earendil-works/pi-coding-agent";

export interface SdkCopy {
	path: string;
	version: string;
}

function addCopy(pjPath: string, out: SdkCopy[], requireName = false): void {
	if (!existsSync(pjPath)) return;
	const norm = pjPath.replace(/\\/g, "/");
	if (out.some((c) => c.path.replace(/\\/g, "/") === norm)) return;
	try {
		const raw = readFileSync(pjPath, "utf8");
		const info = JSON.parse(raw);
		if (requireName && info?.name !== PKG) return;
		if (typeof info?.version === "string" && info.version) {
			out.push({ path: pjPath, version: info.version });
		}
	} catch {}
}

function scanPathForPi(out: SdkCopy[], env: NodeJS.ProcessEnv = process.env): void {
	const rawPath = env.PATH || "";
	if (!rawPath) return;
	const dirs = rawPath.split(delimiter).filter(Boolean);
	const isWin = process.platform === "win32";
	const names = isWin ? ["pi.cmd", "pi.exe", "pi.ps1", "pi"] : ["pi"];

	for (const dir of dirs) {
		for (const name of names) {
			const candidate = join(dir, name);
			if (!existsSync(candidate)) continue;

			try {
				const real = realpathSync(candidate);
				let cur = dirname(real);
				for (let i = 0; i < 5; i++) {
					const pj = join(cur, "package.json");
					addCopy(pj, out, true);
					const parent = dirname(cur);
					if (parent === cur) break;
					cur = parent;
				}
			} catch {}

			addCopy(join(dir, "node_modules", PKG, "package.json"), out);
			addCopy(join(dir, "..", "lib", "node_modules", PKG, "package.json"), out);
			addCopy(join(dir, "..", "node_modules", PKG, "package.json"), out);

			try {
				const head = readFileSync(candidate, "utf8").slice(0, 4096);
				const m = head.match(/[^\r\n"']*@earendil-works[/\\]pi-coding-agent[^\r\n"']*/);
				if (m) {
					let matchedPath = m[0].trim().replace(/%~?dp0%?[/\\]/gi, "");
					let targetDir = isAbsolute(matchedPath) ? matchedPath : join(dir, matchedPath);
					for (let i = 0; i < 5; i++) {
						const pj = join(targetDir, "package.json");
						addCopy(pj, out, true);
						const parent = dirname(targetDir);
						if (parent === targetDir) break;
						targetDir = parent;
					}
				}
			} catch {}
		}
	}
}

function scanGlobalPrefixes(out: SdkCopy[], env: NodeJS.ProcessEnv = process.env): void {
	const home = env.HOME || env.USERPROFILE || "";

	const prefix = env.NPM_CONFIG_PREFIX || env.npm_config_prefix || env.PREFIX;
	if (prefix) {
		addCopy(join(prefix, "lib", "node_modules", PKG, "package.json"), out);
		addCopy(join(prefix, "node_modules", PKG, "package.json"), out);
	}

	if (home) {
		addCopy(join(home, ".npm-global", "lib", "node_modules", PKG, "package.json"), out);
		addCopy(join(home, ".npm-global", "node_modules", PKG, "package.json"), out);
	}
	if (env.APPDATA) {
		addCopy(join(env.APPDATA, "npm", "node_modules", PKG, "package.json"), out);
	}

	if (process.platform !== "win32") {
		addCopy(join("/usr", "local", "lib", "node_modules", PKG, "package.json"), out);
		addCopy(join("/usr", "lib", "node_modules", PKG, "package.json"), out);
	}

	if (env.PNPM_HOME) {
		addCopy(join(env.PNPM_HOME, "node_modules", PKG, "package.json"), out);
		addCopy(join(env.PNPM_HOME, "global", "node_modules", PKG, "package.json"), out);
	}
	if (home) {
		addCopy(join(home, ".local", "share", "pnpm", "global", "node_modules", PKG, "package.json"), out);
	}
	if (env.LOCALAPPDATA) {
		addCopy(join(env.LOCALAPPDATA, "pnpm", "global", "node_modules", PKG, "package.json"), out);
	}
}

export interface SdkCopiesOptions {
	includeGlobal?: boolean;
	env?: NodeJS.ProcessEnv;
}

export function sdkCopies(fromFile: string = import.meta.url, options: SdkCopiesOptions = {}): SdkCopy[] {
	const env = options.env ?? process.env;
	const includeGlobal = options.includeGlobal ?? (options.env ? true : !process.env.VITEST);
	const out: SdkCopy[] = [];
	let dir = dirname(fromFile.startsWith("file:") ? fileURLToPath(fromFile) : fromFile);
	for (;;) {
		const pj = join(dir, "node_modules", PKG, "package.json");
		addCopy(pj, out);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	if (env.PI_WEB_SDK_DIR) {
		addCopy(join(env.PI_WEB_SDK_DIR, "package.json"), out);
	}

	const home = env.HOME || env.USERPROFILE;
	if (home) {
		addCopy(join(home, ".local", "share", "pi-node", "current", "lib", "node_modules", PKG, "package.json"), out);
	}

	if (includeGlobal) {
		scanPathForPi(out, env);

		scanGlobalPrefixes(out, env);
	}

	return out;
}

export function compareVersions(a: string, b: string): number {
	const pa = a.split(".");
	const pb = b.split(".");
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const na = Number.parseInt(pa[i] ?? "0", 10) || 0;
		const nb = Number.parseInt(pb[i] ?? "0", 10) || 0;
		if (na !== nb) return na < nb ? -1 : 1;
	}
	return 0;
}

export function isBundledInUse(copies: SdkCopy[], effectiveVersion: string, bundledCopy?: SdkCopy | null): boolean {
	if (bundledCopy !== undefined) {
		return bundledCopy !== null && effectiveVersion === bundledCopy.version;
	}
	return copies.length === 0 || effectiveVersion === copies[0]!.version;
}

export function sdkOriginNote(copies: SdkCopy[], effectiveVersion: string): string | null {
	const shadowed = copies.slice(1);
	const newer = shadowed.filter((c) => compareVersions(c.version, effectiveVersion) > 0);
	if (newer.length === 0) return null;
	return (
		`a newer pi SDK is installed on this machine (${newer.map((c) => `v${c.version}`).join(", ")}) ` +
		`but this process runs v${effectiveVersion} — restart to follow it (default), ` +
		`or set PI_WEB_SDK=bundled to pin the bundled copy.`
	);
}
