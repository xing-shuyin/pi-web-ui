/**
 * git 调用单源。在这之前仓库里有 5 份几乎一样的 `runGit`（`scm` / `worktree-service` /
 * `workspace-snapshot` / `update-check` / `plugin-project`）、6 份各自定义的 `GIT_TIMEOUT_MS`
 * （5s / 10s / 15s×3 / 30s / 5min）、4 份手写的 git 环境（`GIT_TERMINAL_PROMPT=0` +
 * `GCM_INTERACTIVE=never`）—— 每一份都得记得「别让 git 弹凭据提示 / 别让 quotepath 转义中文路径 /
 * 超时要杀整棵树」，漏一条就是线上事故。
 *
 * 这里只放**本地执行**；远程 SSH 工作区（`scm.ts` 的 `isRemoteWorkspaceUri` 分支）由调用方保留自己的
 * 派发，把本地分支委托给 `runGit` 即可。
 */
import { firstLine, runProcess, type RunProcessResult } from "./run-process.js";

/** 普通 git 命令（status/diff/log）够用的默认值；慢命令（clone/fetch）调用方自己传更大的值。 */
export const GIT_DEFAULT_TIMEOUT_MS = 15_000;
export const GIT_DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/** git 的固定硬化参数：不做终端提示、不让凭据管理器弹窗、不让 hooks/fsmonitor 参与。 */
export function gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", ...extra };
}

/** 清掉继承来的全部 `GIT_*`（临时索引 / 沙盒隔离场景必须这么做，否则会串到调用方的仓库状态）。 */
export function stripGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const out = { ...env };
	for (const key of Object.keys(out)) if (/^GIT_/i.test(key)) delete out[key];
	return out;
}

export interface RunGitOptions {
	cwd: string;
	/** 覆盖默认超时（默认 `GIT_DEFAULT_TIMEOUT_MS`）。 */
	timeoutMs?: number;
	/** stdout / stderr 各自保留上限，默认 16MB（diff 之类的输出会很大）。 */
	maxBytes?: number;
	signal?: AbortSignal;
	/** 写入 stdin（`git apply` / `git hash-object --stdin` 之类）后立即关闭。 */
	input?: string | Buffer;
	onLine?: (line: string) => void;
	onStderrLine?: (line: string) => void;
	/** 追加的环境变量（默认叠加在 `gitEnv()` 之上）。 */
	env?: NodeJS.ProcessEnv;
	/** true：基底换成 `stripGitEnv()`（清掉所有继承的 GIT_*），再叠加 `env`。 */
	cleanEnv?: boolean;
	/** 追加的 `-c` 覆盖，例如 workspace-handle 的 hooksPath / gpgsign 硬化。 */
	config?: readonly string[];
	/** 插在子命令之前的全局选项，例如 `--no-optional-locks`。 */
	globalArgs?: readonly string[];
	/** false 时不注入 `-c core.quotepath=false`（默认注入，中文路径不会被转义）。 */
	quotepath?: boolean;
	/** false 时保留输出原样（默认 true：两端 trim，和 `git rev-parse` 的用法一致）。 */
	trim?: boolean;
	/** 输出超过 `maxBytes` 就杀树并标 `overflowed`（默认截尾）；发布协议用它防恶意仓库撑爆内存。 */
	overflow?: "truncate" | "kill";
	/** 超时/取消杀树后的等待宽限；超过就返回 `unstopped: true`（发布协议据此判「停止未确认」）。 */
	stopTimeoutMs?: number;
	/** spawn 成功后回调 pid（发布协议按操作键登记活子进程）。 */
	onSpawn?: (pid: number) => void;
}

export interface RunGitResult extends RunProcessResult {
	/** `code === 0` 的便捷位。 */
	ok: boolean;
}

export async function runGit(args: readonly string[], opts: RunGitOptions): Promise<RunGitResult> {
	const config = [
		...(opts.quotepath === false ? [] : ["-c", "core.quotepath=false"]),
		...(opts.config ?? []).flatMap((entry) => ["-c", entry]),
	];
	const result = await runProcess({
		cmd: "git",
		args: [...(opts.globalArgs ?? []), ...config, ...args],
		cwd: opts.cwd,
		env: opts.cleanEnv ? { ...opts.env } : gitEnv(opts.env),
		...(opts.cleanEnv ? { inheritEnv: stripGitEnv() } : {}),
		timeoutMs: opts.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS,
		maxBytes: opts.maxBytes ?? GIT_DEFAULT_MAX_BYTES,
		...(opts.signal ? { signal: opts.signal } : {}),
		...(opts.input === undefined ? {} : { input: opts.input }),
		...(opts.onLine ? { onLine: opts.onLine } : {}),
		...(opts.onStderrLine ? { onStderrLine: opts.onStderrLine } : {}),
		...(opts.overflow ? { overflow: opts.overflow } : {}),
		...(opts.stopTimeoutMs ? { stopTimeoutMs: opts.stopTimeoutMs } : {}),
		...(opts.onSpawn ? { onSpawn: opts.onSpawn } : {}),
	});
	const stdout = opts.trim === false ? result.stdout : result.stdout.trim();
	const stderr = opts.trim === false ? result.stderr : result.stderr.trim();
	return { ...result, stdout, stderr, ok: result.code === 0 };
}

/**
 * 失败即抛：错误摘要取 stderr 首行（没有就 stdout 首行，再没有就退出码），
 * 消息风格与旧 `runGit` 副本保持一致（`<detail> || "git command failed"`）。
 */
export function gitFailureMessage(result: RunGitResult, fallback = "git command failed"): string {
	if (result.spawnError) return result.spawnError;
	if (result.timedOut) return `git 命令超时（> ${GIT_DEFAULT_TIMEOUT_MS / 1000}s）`;
	if (result.aborted) return "git 命令已取消";
	return firstLine(result.stderr) || firstLine(result.stdout) || `${fallback}（退出码 ${result.code ?? "?"}）`;
}

/** 成功返回 stdout（已 trim），失败抛 `gitFailureMessage`。 */
export async function runGitText(args: readonly string[], opts: RunGitOptions, fallback?: string): Promise<string> {
	const result = await runGit(args, opts);
	if (!result.ok) throw new Error(gitFailureMessage(result, fallback));
	return result.stdout;
}
