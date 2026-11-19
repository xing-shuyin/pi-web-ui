/**
 * 启动期把 node / npm 目录补进 `process.env.PATH`（单点，只做一次）。
 *
 * 为什么需要：Node 装在版本管理器下（fnm / nvm-windows / Volta / Scoop）时，node 目录不由系统
 * PATH 提供，只由交互式 shell 的 profile 注入（`eval "$(fnm env --use-on-cd)"`）。server 进程
 * 继承的是桌面壳 / 服务管理器 / 快捷方式给的 PATH，里面没有它 —— `bash -c "npm run build"`
 * 不读 profile，于是直接 `npm: command not found`（退出码 127）：顶栏「后台任务」面板里
 * package.json 脚本的一键启动会「全部闪退」，而集成终端（`bash -i` 会读 `.bashrc`）却一切正常。
 *
 * 与 `native-cli-discovery.ts` 的分工：那边负责「找到某个 CLI 的绝对路径」（不读 shell、不改环境）；
 * 这边只复用它的候选目录清单（`installDirectories`），把真正带 node/npm 的目录补进 PATH，让所有
 * 子进程（job runner、bash 工具、PTY 终端、插件 spawn）与用户的交互式 shell 看到同一套 node。
 * 只收「目录里真有 node/npm」的候选，避免 scoop shims 之类的杂目录整体挤到 PATH 前面。
 */
import { statSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { installDirectories, type NativeCliDiscoveryOptions } from "./native-cli-discovery.js";
import { DEFAULT_CAPTURE_TIMEOUT_MS, captureShellPath, mergeShellPath } from "./shell-env.js";

export type NodePathOptions = NativeCliDiscoveryOptions;

const WINDOWS_BINS = ["node.exe", "npm.cmd", "npm.exe", "npm.bat"];
const POSIX_BINS = ["node", "npm"];

function nodeBins(windows: boolean): string[] {
	return windows ? WINDOWS_BINS : POSIX_BINS;
}

/** 目录里有没有 node / npm —— 有才算「node 安装目录」，否则只是路径检测的候选。 */
export function hasNodeRuntime(directory: string, platform: NodeJS.Platform = process.platform): boolean {
	for (const name of nodeBins(platform === "win32")) {
		try {
			if (statSync(join(directory, name)).isFile()) return true;
		} catch {}
	}
	return false;
}

/** PATH 条目归一：去引号、去尾部分隔符、Windows 忽略大小写（`C:\Node` 与 `c:\node` 同一条）。 */
function normalizeEntry(entry: string, windows: boolean): string {
	const unquoted = entry.trim().replace(/^"(.*)"$/, "$1");
	const trimmed = unquoted.replace(/[\\/]+$/, "") || unquoted;
	return windows ? trimmed.toLowerCase() : trimmed;
}

/** PATH 分隔符跟着「被模拟的平台」走（宿主 delimiter 在跨平台调用时会串味）。 */
function pathDelimiter(windows: boolean): string {
	return (windows ? win32 : posix).delimiter;
}

function pathKey(env: NodeJS.ProcessEnv, windows: boolean): string {
	if (!windows) return "PATH";
	return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

/** 候选目录里真正带 node/npm 且尚未在 PATH 上的那些，按候选顺序（= 版本管理器优先级）。 */
export function resolveNodeDirs(options: NodePathOptions = {}): string[] {
	const platform = options.platform ?? process.platform;
	const windows = platform === "win32";
	const env = options.env ?? process.env;
	const delimiter = pathDelimiter(windows);
	const present = new Set(
		(env[pathKey(env, windows)] ?? "")
			.split(delimiter)
			.filter(Boolean)
			.map((entry) => normalizeEntry(entry, windows)),
	);
	const seen = new Set<string>();
	const found: string[] = [];
	for (const directory of installDirectories(options)) {
		if (!directory) continue;
		const key = normalizeEntry(directory, windows);
		if (!key || present.has(key) || seen.has(key)) continue;
		seen.add(key);
		if (hasNodeRuntime(directory, platform)) found.push(directory);
	}
	return found;
}

/**
 * 把 node 目录前插到 `env` 的 PATH（前插而不是追加：版本管理器给的必须是默认那套 node）。
 * 返回实际新增的目录，调用方可据此决定打不打一行日志。
 */
export function augmentNodePath(options: NodePathOptions = {}): string[] {
	const windows = (options.platform ?? process.platform) === "win32";
	const env = options.env ?? process.env;
	const added = resolveNodeDirs({ ...options, env });
	if (added.length === 0) return [];
	const delimiter = pathDelimiter(windows);
	const key = pathKey(env, windows);
	const current = env[key] ?? "";
	env[key] = [...added, ...(current ? [current] : [])].join(delimiter);
	return added;
}

function binOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
	const windows = platform === "win32";
	const delimiter = pathDelimiter(windows);
	const names = windows ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
	for (const entry of (env[pathKey(env, windows)] ?? "").split(delimiter)) {
		const directory = entry.trim().replace(/^"(.*)"$/, "$1");
		if (!directory) continue;
		for (const file of names) {
			try {
				if (statSync(join(directory, file)).isFile()) return true;
			} catch {}
		}
	}
	return false;
}

export interface ShellPathResult {
	/** `skipped`：已有 npm/node 或开关关掉；`failed`：捕获超时 / 形状不符。 */
	reason: "merged" | "skipped" | "failed";
	/** PATH 里实际新增了几个条目。 */
	added: number;
	ms: number;
	/** 本次实际使用的硬超时（`PI_WEB_PATH_CAPTURE_TIMEOUT_MS` 归一后），排查「启动慢」时看它。 */
	timeoutMs: number;
}

const CAPTURE_TIMEOUT_MIN_MS = 200;
const CAPTURE_TIMEOUT_MAX_MS = 10_000;

/**
 * `PI_WEB_PATH_CAPTURE_TIMEOUT_MS` 的归一：显式入参（测试）> 环境变量 > 默认 1500ms，
 * 一律夹到 200ms～10s（再低不可能完成一次 shell 启动，再高就是把启动卡住了）。
 * 非数字 / 非正数不是错误，静默回落默认值——启动路径上没必要为了一个错字拒绝服务。
 */
export function resolveCaptureTimeoutMs(env: NodeJS.ProcessEnv = process.env, explicit?: number): number {
	const clamp = (value: number) =>
		Math.min(CAPTURE_TIMEOUT_MAX_MS, Math.max(CAPTURE_TIMEOUT_MIN_MS, Math.round(value)));
	if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) return clamp(explicit);
	const raw = (env.PI_WEB_PATH_CAPTURE_TIMEOUT_MS ?? "").trim();
	if (!raw) return DEFAULT_CAPTURE_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CAPTURE_TIMEOUT_MS;
	return clamp(parsed);
}

/**
 * 机制层：PATH 上找不到 node/npm 时才抓一次用户**交互式登录 shell** 的环境（见 `shell-env.ts` 的
 * 坑：`-lc` 读不到 `.bashrc` 里的 `fnm env`）。抓到了就把 shell 的 PATH 合进进程环境 —— 从此
 * server 与用户的交互终端看到同一套 node，不再靠我们枚举版本管理器目录。
 *
 * 只在「确实缺 npm」时触发：正常机器零成本；`PI_WEB_PATH_CAPTURE=off` 直接关掉；
 * `PI_WEB_PATH_CAPTURE_TIMEOUT_MS` 调硬超时（profile 慢的机器能单独放宽，不必整层关）。
 */
export async function augmentNodePathFromShell(
	options: NodePathOptions & { timeoutMs?: number } = {},
): Promise<ShellPathResult> {
	const startedAt = Date.now();
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const timeoutMs = resolveCaptureTimeoutMs(env, options.timeoutMs);
	const switchValue = (env.PI_WEB_PATH_CAPTURE ?? "").trim().toLowerCase();
	if (["off", "0", "false", "no"].includes(switchValue)) return { reason: "skipped", added: 0, ms: 0, timeoutMs };
	if (binOnPath("npm", env, platform)) return { reason: "skipped", added: 0, ms: 0, timeoutMs };
	const captured = await captureShellPath({ platform, env, timeoutMs });
	if (!captured) return { reason: "failed", added: 0, ms: Date.now() - startedAt, timeoutMs };
	const key = pathKey(env, platform === "win32");
	const delimiter = pathDelimiter(platform === "win32");
	const before = new Set(
		(env[key] ?? "")
			.split(delimiter)
			.filter(Boolean)
			.map((entry) => normalizeEntry(entry, platform === "win32")),
	);
	const merged = mergeShellPath(captured, env[key] ?? "", platform);
	const added = merged
		.split(delimiter)
		.filter((entry) => !before.has(normalizeEntry(entry, platform === "win32"))).length;
	env[key] = merged;
	return { reason: "merged", added, ms: Date.now() - startedAt, timeoutMs };
}
