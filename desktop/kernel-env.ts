/**
 * 内核运行环境的探测（细则见 `docs/architecture-kernel.md` §9）。
 *
 * 只回答"要让它关掉客户端也继续跑，还缺什么"：
 * - 本机 node 在哪、什么版本（决定能不能用全局 npm 包当内核）
 * - 系统服务装没装（没装 → 面板给"安装为系统服务"；装了但没跑 → 提示去启动）
 * - 缺 node 时该跑哪条命令（不替用户下载，先给确定可行的官方向导）
 *
 * 纯函数 + 可注入 `exists`/`env`，不 spawn、不读注册表，方便单测。
 * 服务配置路径与 `bin/keel.mjs` 的 `serviceLabel` / `winServiceDir` / `systemdUnitPath`
 * 必须保持一致（那边是 CLI 的单源；这里只做只读推导，改了要同步）。
 */
import { join, sep } from "node:path";

export type ServiceInstallState = "installed" | "absent" | "unknown";

export interface NodeRuntimeInfo {
	ok: boolean;
	path: string;
	version: string;
}

/** 本机 node 是否可用；`ok:false` 说明得先装 node（面板据此给安装指引）。 */
export function describeNodeRuntime(input: { execPath: string; nodeVersion: string }): NodeRuntimeInfo {
	const version = input.nodeVersion.trim().replace(/^v/i, "");
	const major = Number(version.split(".")[0] ?? "0");
	return { ok: Number.isFinite(major) && major >= 22, path: input.execPath, version };
}

export interface CommandGuide {
	kind: "winget" | "brew" | "apt" | "manual" | "npm";
	command: string;
	url: string;
	/** 需要用户自己在终端执行（GUI 里没有 TTY，sudo/交互提示会直接失败）。 */
	needsTerminal: boolean;
}

/** 装 node 的官方向导：只给确定可行的那条，不猜镜像。 */
export function nodeInstallGuide(platform: NodeJS.Platform): CommandGuide {
	if (platform === "win32")
		return {
			kind: "winget",
			command: "winget install --id OpenJS.NodeJS.LTS -e",
			url: "https://nodejs.org/zh-cn/download",
			needsTerminal: true,
		};
	if (platform === "darwin")
		return {
			kind: "brew",
			command: "brew install node@22",
			url: "https://nodejs.org/zh-cn/download",
			needsTerminal: true,
		};
	return {
		kind: "apt",
		command: "sudo apt install -y nodejs npm",
		url: "https://nodejs.org/zh-cn/download",
		needsTerminal: true,
	};
}

/** 装/升级内核本体（全局 npm 包）的命令。 */
export function npmGlobalInstallGuide(): CommandGuide {
	return {
		kind: "npm",
		command: "npm i -g keel-agent@latest",
		url: "https://www.npmjs.com/package/keel-agent",
		needsTerminal: true,
	};
}

/** `npm prefix -g` 的输出可能带 CRLF/空白/警告行，取最后一个像路径的行。 */
export function parseNpmPrefix(stdout: string): string | null {
	const lines = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const candidate = lines[lines.length - 1];
	return candidate ?? null;
}

/** 全局包根：Windows 为 `<prefix>/node_modules/keel-agent`，POSIX（macOS/Linux）为 `<prefix>/lib/node_modules/keel-agent`。 */
export function globalKernelRoot(prefix: string, platform: NodeJS.Platform = process.platform): string {
	const clean = prefix.replace(/[/\\]+$/, "");
	return platform === "win32"
		? [clean, "node_modules", "keel-agent"].join(sep)
		: [clean, "lib", "node_modules", "keel-agent"].join(sep);
}

/** 服务配置的落点（与 CLI 一致；只读判断"装没装"）。 */
export function serviceArtifactPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
	if (platform === "win32") {
		const appData = env.APPDATA?.trim() || join(home, "AppData", "Roaming");
		return join(appData, "pi-web-ui", "pi-web-ui.ps1");
	}
	if (platform === "darwin") return join(home, "Library", "LaunchAgents", "com.xingshuyin.keel.plist");
	// systemd 系统单元要 root 才读得到；普通用户查不到就是 unknown，不是 absent。
	return "/etc/systemd/system/pi-web-ui.service";
}

export function readServiceInstallState(input: {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	home: string;
	exists: (path: string) => boolean;
}): ServiceInstallState {
	const path = serviceArtifactPath(input.platform, input.env, input.home);
	if (input.exists(path)) return "installed";
	if (
		input.platform === "darwin" &&
		input.exists(join(input.home, "Library", "LaunchAgents", "com.xingshuyin.pi-web-ui.plist"))
	) {
		return "installed";
	}
	// Linux 的单元文件在 /etc 下，普通用户看不到 → 不能说"没装"，只能说"不知道"。
	return input.platform === "linux" ? "unknown" : "absent";
}

/**
 * 给子进程补上 node 所在目录（PATH 前置）。
 *
 * 为什么必须补：壳从资源管理器/UAC 提权启动时，PATH 里没有版本管理器（fnm/nvm/volta）的注入项。
 * 我们能用**绝对路径**找到 node，但 `npm i -g pi-web-ui` 的生命周期脚本是
 * `cmd /d /s /c node install.js` —— 它靠 PATH 找 node，找不到就报
 * 「'node' 不是内部或外部命令」，整次安装失败（实测 2026-11-21，ssh2 的 install.js 就是这样炸的）。
 *
 * 只改 PATH：其余环境原样保留（代理、npm_config_* 等都是用户已配好的）。
 * Windows 的环境变量名大小写不敏感，但 Node 里 `PATH` 与 `Path` 会共存成两个键，
 * 子进程取到的可能是没改过的那个 —— 所以先把所有大小写变体删掉再写 `PATH`。
 */
export function envWithNodeOnPath(
	env: NodeJS.ProcessEnv,
	nodePath: string,
	platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
	const next: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (platform === "win32" && key.toLowerCase() === "path") continue;
		next[key] = value;
	}
	const dir = nodePath.slice(0, Math.max(nodePath.lastIndexOf("/"), nodePath.lastIndexOf("\\")));
	const prepended = dir ? `${dir}${platform === "win32" ? ";" : ":"}${env.PATH ?? env.Path ?? ""}` : (env.PATH ?? "");
	next.PATH = prepended.replace(/;+$/, "");
	return next;
}
