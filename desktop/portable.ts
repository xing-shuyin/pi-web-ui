/**
 * pi-web-ui desktop 便携模式（Portable Mode）支持模块。
 *
 * 核心目标：
 * 1. 动态自适应路径（免疫 U 盘盘符浮动与任意迁移）；
 * 2. 数据 100% 隔离自包含（Electron 状态、WebUI 状态、Agent 认证及历史、便携 Git 配置都在 U 盘中，不污染宿主机）；
 * 3. 自动发现与挂载 PortableGit（内置 bash.exe / git.exe / ssh.exe，无宿主环境依赖）。
 */
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
	gitConfigGlobal: string;
	userHome: string;
}

export interface ElectronAppPathSetter {
	setPath(name: string, path: string): void;
}

/**
 * 判断指定目录下是否存在便携模式特征标记。
 * 支持：Portable.flag、portable.flag、data/ 目录、runtime/git 目录。
 */
export function hasPortableMarkers(dir: string): boolean {
	return (
		existsSync(join(dir, "Portable.flag")) ||
		existsSync(join(dir, "portable.flag")) ||
		existsSync(join(dir, "data")) ||
		existsSync(join(dir, "runtime", "git"))
	);
}

/**
 * 探测便携根目录（U 盘或便携包根目录）。
 */
export function detectPortableRoot(execPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
	// 1. 显式环境变量覆盖（支持外部启动器或 CI）
	if (env.PI_PORTABLE_ROOT?.trim()) {
		return resolve(env.PI_PORTABLE_ROOT.trim());
	}
	if (env.PORTABLE_EXECUTABLE_DIR?.trim()) {
		return resolve(env.PORTABLE_EXECUTABLE_DIR.trim());
	}

	const exeDir = dirname(resolve(execPath));
	const parentDir = dirname(exeDir);
	const exeParentBase = basename(exeDir).toLowerCase();

	// 2. 如果环境变量声明了便携模式
	if (env.PI_PORTABLE === "1" || env.PI_PORTABLE === "true") {
		// 若可执行文件在子目录中（如 app/ 或 win-unpacked/），优先以父级为根
		if (["app", "win-unpacked", "bin"].includes(exeParentBase)) {
			return parentDir;
		}
		return exeDir;
	}

	// 3. 文件系统特征探测：优先检查外层父目录（针对 portableRoot/app/xxx.exe 布局）
	if (["app", "win-unpacked", "bin"].includes(exeParentBase) && hasPortableMarkers(parentDir)) {
		return parentDir;
	}

	// 4. 检查与 exe 同级目录（针对 portableRoot/xxx.exe 扁平布局）
	if (hasPortableMarkers(exeDir)) {
		return exeDir;
	}

	return null;
}

/**
 * 自动寻找内置的 PortableGit 目录。
 */
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

/**
 * 解析便携模式下的全部关键路径。
 */
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
		gitConfigGlobal,
		userHome,
	};
}

/**
 * 将便携环境应用到当前进程、环境变量与 Electron App（若提供）。
 */
export function applyPortableEnvironment(
	paths: PortablePaths,
	env: NodeJS.ProcessEnv = process.env,
	app?: ElectronAppPathSetter,
): void {
	// 1. 确保便携数据文件夹结构存在
	for (const dir of [
		paths.dataRoot,
		paths.electronDataDir,
		join(paths.electronDataDir, "session"),
		paths.webDataDir,
		paths.agentDir,
		paths.workspaceDir,
		dirname(paths.gitConfigGlobal),
		paths.userHome,
	]) {
		try {
			mkdirSync(dir, { recursive: true });
		} catch {
			/* 允许已存在 */
		}
	}

	// 2. 重定向 Electron 自身状态（必须在 app.whenReady() 之前调用）
	if (app) {
		try {
			app.setPath("userData", paths.electronDataDir);
			app.setPath("sessionData", join(paths.electronDataDir, "session"));
		} catch (err) {
			console.warn(`[desktop] [portable] 重定向 Electron userData 异常：${(err as Error).message}`);
		}
	}

	// 3. 环境变量注入（为子进程与当前进程提供一致的单源）
	env.PI_PORTABLE = "1";
	env.PI_PORTABLE_ROOT = paths.portableRoot;
	env.PI_WEB_DATA_DIR = paths.webDataDir;
	env.PI_CODING_AGENT_DIR = paths.agentDir;
	env.PI_WEB_CWD = paths.workspaceDir;
	env.GIT_CONFIG_GLOBAL = paths.gitConfigGlobal;
	env.HOME = paths.userHome;
	env.USERPROFILE = paths.userHome;

	// 4. 挂载 PortableGit（若发现）
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

		// 指定 git-core 路径
		const libexec64 = join(paths.gitDir, "mingw64", "libexec", "git-core");
		const libexec32 = join(paths.gitDir, "mingw32", "libexec", "git-core");
		if (existsSync(libexec64)) {
			env.GIT_EXEC_PATH = libexec64;
		} else if (existsSync(libexec32)) {
			env.GIT_EXEC_PATH = libexec32;
		}

		// 定位 bash.exe 并注入终端首选 shell
		const bashCandidates = [join(paths.gitDir, "bin", "bash.exe"), join(paths.gitDir, "usr", "bin", "bash.exe")];
		for (const cand of bashCandidates) {
			if (existsSync(cand)) {
				env.SHELL = cand;
				env.PI_WEB_SHELL = cand;
				break;
			}
		}
	}
}

/**
 * 主进程便携模式一键初始化。
 */
export function setupPortableMode(app?: ElectronAppPathSetter): PortablePaths | null {
	const paths = resolvePortablePaths(process.execPath, process.env);
	if (!paths) return null;

	applyPortableEnvironment(paths, process.env, app);
	console.log(
		`[desktop] [portable] 便携模式已激活：根目录=${paths.portableRoot}，数据=${paths.dataRoot}${
			paths.gitDir ? `，内置Git=${paths.gitDir}` : "（未检测到内置PortableGit）"
		}`,
	);
	return paths;
}
