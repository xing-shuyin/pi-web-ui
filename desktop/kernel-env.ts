/**
 * 内核运行环境的探测（细则见 `docs/architecture-kernel.md` §9）。
 *
 * 只回答"要让它关掉客户端也继续跑，还缺什么"：
 * - 本机 node 在哪、什么版本（决定能不能用全局 npm 包当内核）
 * - 系统服务装没装（没装 → 面板给"安装为系统服务"；装了但没跑 → 提示去启动）
 * - 缺 node 时该跑哪条命令（不替用户下载，先给确定可行的官方向导）
 *
 * 纯函数 + 可注入 `exists`/`env`，不 spawn、不读注册表，方便单测。
 * 服务配置路径与 `bin/pi-web-ui.mjs` 的 `serviceLabel` / `winServiceDir` / `systemdUnitPath`
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
		command: "npm i -g pi-web-ui@latest",
		url: "https://www.npmjs.com/package/pi-web-ui",
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

/** 全局包根：`<prefix>/node_modules/pi-web-ui`。Windows 上 prefix 常带反斜杠，统一成 `/` 拼接。 */
export function globalKernelRoot(prefix: string): string {
	return [prefix.replace(/[/\\]+$/, ""), "node_modules", "pi-web-ui"].join(sep);
}

/** 服务配置的落点（与 CLI 一致；只读判断"装没装"）。 */
export function serviceArtifactPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
	if (platform === "win32") {
		const appData = env.APPDATA?.trim() || join(home, "AppData", "Roaming");
		return join(appData, "pi-web-ui", "pi-web-ui.ps1");
	}
	if (platform === "darwin") return join(home, "Library", "LaunchAgents", "com.xingshuyin.pi-web-ui.plist");
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
	// Linux 的单元文件在 /etc 下，普通用户看不到 → 不能说"没装"，只能说"不知道"。
	return input.platform === "linux" ? "unknown" : "absent";
}

/** 从 PATH 里找 node：全局包内核要用**系统 node**跑（Electron 的 node ABI 不一定兼容原生模块）。 */
export function findNodeInPath(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | null {
	const names = process.platform === "win32" ? ["node.exe"] : ["node"];
	const pathValue = env.PATH ?? env.Path ?? "";
	for (const dir of pathValue.split(process.platform === "win32" ? ";" : ":")) {
		if (!dir.trim()) continue;
		for (const name of names) {
			const candidate = join(dir.trim(), name);
			if (exists(candidate)) return candidate;
		}
	}
	return null;
}
