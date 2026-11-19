/**
 * 交互式登录 shell 的 PATH 捕获 —— 「GUI 启动拿不到版本管理器 node」的机制层解法。
 *
 * 为什么不是继续枚举安装目录（`installDirectories`）：fnm / nvm / asdf / mise / volta / scoop 的存储
 * 布局无穷，补一个漏一个（同类产品 ekko-studio 连补两次目录仍未解决机制问题）。业界已经收敛的做法
 * 是**问用户自己的 shell**：VS Code `getResolvedShellEnv()`（`src/vs/platform/shell/node/shellEnv.ts`，
 * spawn `['-i','-l','-c']` + uuid marker 提取 + 超时 + promise 级缓存，Windows 跳过）、Zed
 * `util::shell_env::capture`、ekko-studio PR #3698（把 `-lc` 改成 `-ilc`，并 memoize 避免一次请求
 * 起十几个 shell）。
 *
 * 两个必须踩准的坑：
 *   - **`-i` 不能省**：`-lc` 只读 `.zprofile`/`.bash_profile`，读不到 `.zshrc`/`.bashrc`，而
 *     `eval "$(fnm env --use-on-cd)"` 恰恰写在后者里（本机 `~/.bashrc` 就是）。
 *   - **Windows 要另走**：Shell 是 PowerShell（`-Command` 会加载 `$PROFILE`，本机实测能拿到
 *     `fnm_multishells\…`）；失败再回落到 bash `-ilc`。注册表 `HKCU\Environment\Path` 兜底不够
 *     （里面只有版本管理器的二进制目录，没有 node）。
 *
 * 输出不可信 + 可能很慢：一律 marker 定位（只认最后一段，profile 里的 echo/告警都在前面）、去 ANSI、
 * 校验形状，硬超时后放弃。抓不到就安静回落 —— 目录探测（`node-path.ts`）仍在那里兜底。
 */
import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
import { runProcess } from "./run-process.js";

const DEFAULT_TIMEOUT_MS = 1500;
const MAX_PATH_CHARS = 64 * 1024;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** 捕获默认硬超时（`PI_WEB_PATH_CAPTURE_TIMEOUT_MS` 未设时）；`node-path.ts` 做范围归一，那边是单源。 */
export const DEFAULT_CAPTURE_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

export interface ShellEnvOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

interface CaptureSpec {
	command: string;
	args: string[];
}

function newMarker(): string {
	return randomUUID().replace(/-/g, "").slice(0, 12);
}

/** 捕获用的命令行：一律 marker 包住 `$PATH`，profile 里的任何 echo/告警都排在 marker 之外。 */
export function captureCommands(marker: string, options: ShellEnvOptions = {}): CaptureSpec[] {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	if (platform === "win32") {
		// 两种 PowerShell 的 `$PROFILE` 是不同文件（`Documents\PowerShell` vs `Documents\WindowsPowerShell`），
		// 被初始化写在哪一份完全看用户，所以两份都试；`-Command`（非 -NoProfile）才会加载 profile。
		// `-NonInteractive` 只禁提示，不影响 profile 加载，能防住执行策略之类的交互卡住。
		const expression = `'${marker}' + $env:PATH + '${marker}'`;
		const specs: CaptureSpec[] = [
			{ command: "pwsh", args: ["-NoLogo", "-NonInteractive", "-Command", expression] },
			{ command: "powershell", args: ["-NoLogo", "-NonInteractive", "-Command", expression] },
		];
		if (env.PI_WEB_SHELL)
			specs.push({ command: env.PI_WEB_SHELL, args: ["-ilc", `printf '${marker}%s${marker}' "$PATH"`] });
		return specs;
	}
	const shell = env.SHELL || "/bin/bash";
	return [{ command: shell, args: ["-ilc", `printf '${marker}%s${marker}' "$PATH"`] }];
}

/**
 * 从 shell 输出里取 PATH：只认**最后一段** marker 包围的内容（profile 里的 banner 全在前面），
 * 去 ANSI，校验形状（长度、含分隔符、无换行）。形状不符一律 null，绝不把可疑串塞进 PATH。
 */
export function parseCapturedPath(stdout: string, marker: string, platform: NodeJS.Platform): string | null {
	const cleaned = String(stdout ?? "").replace(ANSI, "");
	const marks: number[] = [];
	for (let at = cleaned.indexOf(marker); at >= 0; at = cleaned.indexOf(marker, at + marker.length)) marks.push(at);
	if (marks.length < 2) return null;
	const start = marks[marks.length - 2] + marker.length;
	const value = cleaned.slice(start, marks[marks.length - 1]).trim();
	if (!value || value.length > MAX_PATH_CHARS || /[\r\n]/.test(value)) return null;
	const separator = platform === "win32" ? /[;]/ : /:/;
	if (!separator.test(value)) return null;
	return value;
}

/** PATH 条目是不是绝对路径：相对条目（`.`、`node_modules/.bin`）是 cwd 相关的，绝不能焊进全局 env。 */
export function isAbsolutePathEntry(entry: string, platform: NodeJS.Platform): boolean {
	if (!entry) return false;
	if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(entry) || entry.startsWith("\\\\") || entry.startsWith("//");
	return entry.startsWith("/") || entry.startsWith("~");
}

/**
 * 捕获结果与当前 PATH 合并：shell 的条目在前（它就是用户真实顺序），当前独有的条目补在后面。
 * 只对**捕获侧**做绝对路径过滤 —— 当前 PATH 里既有的相对条目是调用方自己的事，不动它。
 */
export function mergeShellPath(
	captured: string,
	current: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const windows = platform === "win32";
	// 分隔符跟着「被模拟的平台」走：用宿主 delimiter 在跨平台调用（含单测）时会把整串当成一条。
	const delimiter = (windows ? win32 : posix).delimiter;
	const key = (entry: string) => (windows ? entry.replace(/[\\/]+$/, "").toLowerCase() : entry.replace(/\/+$/, ""));
	const seen = new Set<string>();
	const out: string[] = [];
	const push = (entry: string, requireAbsolute: boolean) => {
		const trimmed = entry.trim();
		if (!trimmed) return;
		if (requireAbsolute && !isAbsolutePathEntry(trimmed, platform)) return;
		const normalized = key(trimmed);
		if (seen.has(normalized)) return;
		seen.add(normalized);
		out.push(trimmed);
	};
	for (const entry of captured.split(delimiter)) push(entry, true);
	for (const entry of String(current ?? "").split(delimiter)) push(entry, false);
	return out.join(delimiter);
}

/**
 * 跑一次登录 shell 抓 PATH。走单源 `runProcess`（超时杀整棵树、stdin 接地），
 * 只取 stdout：`bash -ilc` 在没有 TTY 时会往 stderr 打 "no job control" 之类的噪声。
 */
async function runCapture(spec: CaptureSpec, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<string | null> {
	const result = await runProcess({
		cmd: spec.command,
		args: spec.args,
		// 原实现用 `spawn(..., { env })` 整体替换环境，这里等价地换基底。
		inheritEnv: env,
		keepColor: true,
		timeoutMs: Math.max(200, timeoutMs),
		maxBytes: MAX_PATH_CHARS * 2,
	});
	if (result.spawnError || result.timedOut || result.aborted) return null;
	return result.stdout;
}

/** 抓一次交互式登录 shell 的 PATH 原始串（失败 / 超时 / 形状不符都返回 null）。 */
export async function captureShellPath(options: ShellEnvOptions = {}): Promise<string | null> {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const marker = newMarker();
	const specs = captureCommands(marker, { platform, env });
	// 总预算严格服从调用方给的值：按截止时间顺序分配，绝不因为「多试几个 shell」而超时。
	const deadline = Date.now() + Math.max(200, timeoutMs);
	for (const spec of specs) {
		const remaining = deadline - Date.now();
		if (remaining < 150) break;
		const stdout = await runCapture(spec, remaining, env);
		if (stdout === null) continue;
		const parsed = parseCapturedPath(stdout, marker, platform);
		if (parsed) return parsed;
	}
	return null;
}
