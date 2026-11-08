import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface PortablePaths {
	isPortable: boolean;
	portableRoot: string;
	dataRoot: string;
	electronDataDir: string;
	webDataDir: string;
	agentDir: string;
	workspaceDir: string;
	gitDir: string | null;
	nodeDir: string | null;
	npmGlobalDir: string;
	npmCacheDir: string;
	gitConfigGlobal: string;
	userHome: string;
}

export interface ElectronAppPathSetter {
	setPath(name: string, path: string): void;
}

/**
 * 便携模式把 HOME/USERPROFILE 重定向到 data/home，但系统对话框（Electron 选目录 / 选文件、
 * 系统浏览器的「加载已解压的扩展程序」等）默认落在「桌面」「下载」等标准子目录。
 * 这些子目录不存在时，Windows 会弹出「位置不可用」错误而不是回退到可用目录，
 * 因此必须把标准外壳目录一并建出来，并把 Electron 的已知目录指向它们。
 */
const HOME_SHELL_DIRS = ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos"] as const;

const ELECTRON_HOME_PATHS: ReadonlyArray<readonly [string, string]> = [
	["home", ""],
	["desktop", "Desktop"],
	["documents", "Documents"],
	["downloads", "Downloads"],
	["pictures", "Pictures"],
	["music", "Music"],
	["videos", "Videos"],
];

export function hasPortableMarkers(dir: string): boolean {
	return (
		existsSync(join(dir, "Portable.flag")) ||
		existsSync(join(dir, "portable.flag")) ||
		existsSync(join(dir, "data")) ||
		existsSync(join(dir, "runtime", "git")) ||
		existsSync(join(dir, "runtime", "node"))
	);
}

export function detectPortableRoot(execPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
	if (env.PI_PORTABLE_ROOT?.trim()) {
		return resolve(env.PI_PORTABLE_ROOT.trim());
	}
	if (env.PORTABLE_EXECUTABLE_DIR?.trim()) {
		return resolve(env.PORTABLE_EXECUTABLE_DIR.trim());
	}

	const exeDir = dirname(resolve(execPath));
	const parentDir = dirname(exeDir);
	const exeParentBase = basename(exeDir).toLowerCase();

	if (env.PI_PORTABLE === "1" || env.PI_PORTABLE === "true") {
		if (["app", "win-unpacked", "bin"].includes(exeParentBase)) {
			return parentDir;
		}
		return exeDir;
	}

	if (["app", "win-unpacked", "bin"].includes(exeParentBase) && hasPortableMarkers(parentDir)) {
		return parentDir;
	}

	if (hasPortableMarkers(exeDir)) {
		return exeDir;
	}

	return null;
}

export function findPortableGit(portableRoot: string, exeDir: string): string | null {
	const candidates = [
		join(portableRoot, "runtime", "git"),
		join(portableRoot, "git"),
		join(exeDir, "runtime", "git"),
		join(exeDir, "git"),
	];

	for (const cand of candidates) {
		if (existsSync(join(cand, "cmd", "git.exe")) || existsSync(join(cand, "bin", "git.exe"))) {
			return cand;
		}
	}
	return null;
}

export function findPortableNode(portableRoot: string, exeDir: string): string | null {
	const candidates = [
		join(portableRoot, "runtime", "node"),
		join(portableRoot, "node"),
		join(exeDir, "runtime", "node"),
		join(exeDir, "node"),
	];

	for (const cand of candidates) {
		if (existsSync(join(cand, "node.exe")) || existsSync(join(cand, "bin", "node"))) {
			return cand;
		}
	}
	return null;
}

export function resolvePortablePaths(execPath: string, env: NodeJS.ProcessEnv = process.env): PortablePaths | null {
	const portableRoot = detectPortableRoot(execPath, env);
	if (!portableRoot) return null;

	const exeDir = dirname(resolve(execPath));
	const dataRoot = env.PI_PORTABLE_DATA_DIR?.trim()
		? resolve(env.PI_PORTABLE_DATA_DIR.trim())
		: join(portableRoot, "data");
	const electronDataDir = join(dataRoot, "electron");
	const webDataDir = env.PI_WEB_DATA_DIR?.trim() ? resolve(env.PI_WEB_DATA_DIR.trim()) : join(dataRoot, "web");
	const agentDir = env.PI_CODING_AGENT_DIR?.trim() ? resolve(env.PI_CODING_AGENT_DIR.trim()) : join(dataRoot, "agent");
	const workspaceDir = env.PI_WEB_CWD?.trim() ? resolve(env.PI_WEB_CWD.trim()) : join(dataRoot, "workspace");
	const gitDir = findPortableGit(portableRoot, exeDir);
	const nodeDir = findPortableNode(portableRoot, exeDir);
	const npmGlobalDir = env.NPM_CONFIG_PREFIX?.trim()
		? resolve(env.NPM_CONFIG_PREFIX.trim())
		: join(dataRoot, "npm-global");
	const npmCacheDir = env.NPM_CONFIG_CACHE?.trim() ? resolve(env.NPM_CONFIG_CACHE.trim()) : join(dataRoot, "npm-cache");
	const gitConfigGlobal = env.GIT_CONFIG_GLOBAL?.trim()
		? resolve(env.GIT_CONFIG_GLOBAL.trim())
		: join(dataRoot, "git", ".gitconfig");
	const userHome = env.PI_PORTABLE_HOME?.trim()
		? resolve(env.PI_PORTABLE_HOME.trim())
		: env.HOME?.trim() && env.HOME !== process.env.USERPROFILE
			? env.HOME
			: join(dataRoot, "home");

	return {
		isPortable: true,
		portableRoot,
		dataRoot,
		electronDataDir,
		webDataDir,
		agentDir,
		workspaceDir,
		gitDir,
		nodeDir,
		npmGlobalDir,
		npmCacheDir,
		gitConfigGlobal,
		userHome,
	};
}

export function applyPortableEnvironment(
	paths: PortablePaths,
	env: NodeJS.ProcessEnv = process.env,
	app?: ElectronAppPathSetter,
): void {
	for (const dir of [
		paths.dataRoot,
		paths.electronDataDir,
		join(paths.electronDataDir, "session"),
		paths.webDataDir,
		paths.agentDir,
		paths.workspaceDir,
		paths.npmGlobalDir,
		paths.npmCacheDir,
		dirname(paths.gitConfigGlobal),
		paths.userHome,
		...HOME_SHELL_DIRS.map((name) => join(paths.userHome, name)),
	]) {
		try {
			mkdirSync(dir, { recursive: true });
		} catch {}
	}

	if (app) {
		try {
			app.setPath("userData", paths.electronDataDir);
			app.setPath("sessionData", join(paths.electronDataDir, "session"));
			for (const [name, sub] of ELECTRON_HOME_PATHS) {
				app.setPath(name, sub ? join(paths.userHome, sub) : paths.userHome);
			}
		} catch (err) {
			console.warn(`[desktop] [portable] 重定向 Electron 目录异常：${(err as Error).message}`);
		}
	}

	env.PI_PORTABLE = "1";
	env.PI_PORTABLE_ROOT = paths.portableRoot;
	env.PI_WEB_DATA_DIR = paths.webDataDir;
	env.PI_CODING_AGENT_DIR = paths.agentDir;
	env.PI_WEB_CWD = paths.workspaceDir;
	env.GIT_CONFIG_GLOBAL = paths.gitConfigGlobal;
	env.HOME = paths.userHome;
	env.USERPROFILE = paths.userHome;

	if (paths.gitDir) {
		const gitCmd = join(paths.gitDir, "cmd");
		const gitUsrBin = join(paths.gitDir, "usr", "bin");
		const gitMingw = join(paths.gitDir, "mingw64", "bin");
		const gitMingw32 = join(paths.gitDir, "mingw32", "bin");

		const partsToAdd: string[] = [];
		if (existsSync(gitCmd)) partsToAdd.push(gitCmd);
		if (existsSync(gitUsrBin)) partsToAdd.push(gitUsrBin);
		if (existsSync(gitMingw)) partsToAdd.push(gitMingw);
		else if (existsSync(gitMingw32)) partsToAdd.push(gitMingw32);

		if (partsToAdd.length > 0) {
			const pathSep = process.platform === "win32" ? ";" : ":";
			const currentPath = env.PATH || "";
			env.PATH = `${partsToAdd.join(pathSep)}${currentPath ? `${pathSep}${currentPath}` : ""}`;
		}

		const libexec64 = join(paths.gitDir, "mingw64", "libexec", "git-core");
		const libexec32 = join(paths.gitDir, "mingw32", "libexec", "git-core");
		if (existsSync(libexec64)) {
			env.GIT_EXEC_PATH = libexec64;
		} else if (existsSync(libexec32)) {
			env.GIT_EXEC_PATH = libexec32;
		}

		const bashCandidates = [join(paths.gitDir, "bin", "bash.exe"), join(paths.gitDir, "usr", "bin", "bash.exe")];
		for (const cand of bashCandidates) {
			if (existsSync(cand)) {
				env.SHELL = cand;
				env.PI_WEB_SHELL = cand;
				break;
			}
		}
	}

	if (paths.nodeDir) {
		env.NPM_CONFIG_PREFIX = paths.npmGlobalDir;
		env.NPM_CONFIG_CACHE = paths.npmCacheDir;

		const partsToAdd: string[] = [];
		partsToAdd.push(paths.npmGlobalDir);
		partsToAdd.push(paths.nodeDir);
		const nodeBin = join(paths.nodeDir, "bin");
		if (existsSync(nodeBin)) {
			partsToAdd.push(nodeBin);
		}

		const pathSep = process.platform === "win32" ? ";" : ":";
		const currentPath = env.PATH || "";
		env.PATH = `${partsToAdd.join(pathSep)}${currentPath ? `${pathSep}${currentPath}` : ""}`;
	}
}

export function setupPortableMode(app?: ElectronAppPathSetter): PortablePaths | null {
	const paths = resolvePortablePaths(process.execPath, process.env);
	if (!paths) return null;

	applyPortableEnvironment(paths, process.env, app);
	console.log(
		`[desktop] [portable] 便携模式已激活：根目录=${paths.portableRoot}，数据=${paths.dataRoot}${
			paths.gitDir ? `，内置Git=${paths.gitDir}` : "（未检测到内置PortableGit）"
		}${paths.nodeDir ? `，内置Node=${paths.nodeDir}` : "（未检测到内置PortableNode）"}`,
	);
	return paths;
}
