import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface NativeCliDiscoveryOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	homeDir?: string;
	nodeExecutable?: string;
	autoDetect?: boolean;
}

function versions(directory: string): string[] {
	try {
		return readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.map((entry) => entry.name)
			.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
	} catch {
		return [];
	}
}

function* installDirectories(options: NativeCliDiscoveryOptions): Generator<string> {
	const windows = (options.platform ?? process.platform) === "win32";
	const path = windows ? win32 : posix;
	const env = options.env ?? process.env;
	const get = (name: string) =>
		windows ? Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] : env[name];
	const home = options.homeDir ?? (windows ? get("USERPROFILE") || get("HOME") : get("HOME")) ?? homedir();
	const localData = get("LOCALAPPDATA");
	const roamingData = get("APPDATA");
	const xdgData = get("XDG_DATA_HOME") || path.join(home, ".local", "share");
	const prefix = get("npm_config_prefix") || get("NPM_CONFIG_PREFIX") || get("PREFIX");
	const candidates = [
		path.join(home, ".local", "bin"),
		path.join(home, "bin"),
		path.join(home, ".claude", "local"),
		path.dirname(options.nodeExecutable ?? process.execPath),
		prefix && (windows ? prefix : path.join(prefix, "bin")),
		roamingData && path.join(roamingData, "npm"),
		get("PNPM_HOME"),
		get("NVM_BIN"),
		get("NVM_SYMLINK"),
		get("FNM_MULTISHELL_PATH"),
		path.join(get("VOLTA_HOME") || path.join(home, ".volta"), "bin"),
		path.join(get("BUN_INSTALL") || path.join(home, ".bun"), "bin"),
		path.join(home, ".npm-global", "bin"),
		path.join(home, ".config", "yarn", "global", "node_modules", ".bin"),
		path.join(home, ".yarn", "bin"),
		path.join(home, ".pnpm-global", "bin"),
		path.join(home, "Library", "pnpm"),
		path.join(xdgData, "fnm", "current", "bin"),
		path.join(home, ".cargo", "bin"),
		windows ? path.join(home, "scoop", "shims") : path.join(home, ".local", "share", "pnpm"),
		windows && localData && path.join(localData, "pnpm"),
		windows && path.join(localData || path.join(home, "AppData", "Local"), "agy", "bin"),
		...(!windows ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/snap/bin"] : []),
	];
	for (const directory of candidates) if (directory) yield directory;

	const fnmRoots = new Set(
		[
			get("FNM_DIR"),
			roamingData && path.join(roamingData, "fnm"),
			localData && path.join(localData, "fnm"),
			path.join(xdgData, "fnm"),
			path.join(home, ".fnm"),
		].filter((directory): directory is string => !!directory),
	);
	for (const fnm of fnmRoots) {
		const store = path.join(fnm, "node-versions");
		for (const version of versions(store)) {
			const installation = path.join(store, version, "installation");
			yield windows ? installation : path.join(installation, "bin");
		}
	}
	const nvm = windows ? get("NVM_HOME") : path.join(get("NVM_DIR") || path.join(home, ".nvm"), "versions", "node");
	if (nvm)
		for (const version of versions(nvm)) yield windows ? path.join(nvm, version) : path.join(nvm, version, "bin");
}

export function findNativeCliExecutable(
	executable: string,
	options: NativeCliDiscoveryOptions = {},
): string | undefined {
	const windows = (options.platform ?? process.platform) === "win32";
	const path = windows ? win32 : posix;
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const pathValue = windows ? Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] : env.PATH;
	const hasPath = path.isAbsolute(executable) || (windows ? /[\\/]/ : /\//).test(executable);
	const extensions = windows && !path.extname(executable) ? [".exe", ".com", ".cmd", ".bat"] : [""];
	const checked = new Set<string>();
	const check = (base: string) => {
		for (const extension of extensions) {
			const candidate = base + extension;
			const key = windows ? candidate.toLowerCase() : candidate;
			if (checked.has(key)) continue;
			checked.add(key);
			try {
				if (!statSync(candidate).isFile()) continue;
				if (!windows) accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {}
		}
		return undefined;
	};
	if (hasPath) return check(path.resolve(cwd, executable));
	for (const entry of (pathValue ?? "").split(windows ? ";" : ":").filter(Boolean)) {
		const directory = windows ? entry.replace(/^"(.*)"$/, "$1") : entry;
		const found = check(path.resolve(cwd, directory, executable));
		if (found) return found;
	}
	if (options.autoDetect) {
		for (const directory of installDirectories(options)) {
			const found = check(path.resolve(cwd, directory, executable));
			if (found) return found;
		}
	}
	return undefined;
}
