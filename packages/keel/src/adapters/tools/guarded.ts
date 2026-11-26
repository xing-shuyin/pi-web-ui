import {
	createBashToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withToolGuard, makeLateToolGuard, type AskApprovalFn, type ToolGuardHook } from "../../tool-guards.js";
import type { ApprovalRule } from "../../approval-rules.js";
import type { ServerLang } from "../../i18n.js";
import type { RemoteSdkOperationsFactory } from "../../contracts/remote-ops.js";
import type { BackgroundPort, BashAbortRegistry } from "../../contracts/background.js";

const BASH_TOOL_PARAMETERS = Type.Object({
	command: Type.String(),
	timeout: Type.Optional(Type.Number()),
	persist: Type.Optional(Type.Boolean()),
	background: Type.Optional(Type.Boolean()),
	waitMs: Type.Optional(Type.Integer()),
	notificationTimeoutSec: Type.Optional(Type.Integer()),
	head: Type.Optional(Type.Integer()),
	tail: Type.Optional(Type.Integer()),
});

export interface GuardedToolOptions {
	cwd: string;
	getLang: () => ServerLang;
	askApproval: AskApprovalFn;
	getRoots?: () => string[];
	getRules?: () => ApprovalRule[] | undefined;
	isApprovalEnabled?: () => boolean;
	conversationId?: () => string | undefined;
	/** 对话级 bash 中止表（内核 `BashKills`）：缺省 = 没有可中止的句柄（`abortBash` 恒报没在跑）。 */
	bashKills?: BashAbortRegistry;
	/** 后台任务面（用于 `background: true` 与 `waitMs` 超时自动转后台）。 */
	background?: () => BackgroundPort | undefined;
	/**
	 * 插件 pre/post 守卫的来源（= 引擎钩子 `svc.toolGuard`，组合根在引擎建好后装上，所以要 getter 而不是值）。
	 * 缺省 / 返回 `undefined` = **没有守卫**（不是错误）：工具照旧执行，只是插件看不到这一次调用。
	 * 钩子抛错也不阻断执行（`withToolGuard` 内部 catch 成 allow）——插件坏掉不能把用户的操作卡死。
	 */
	guard?: () => ToolGuardHook | undefined;
}

/**
 * 对话级 bash 中止：SDK 内置 bash 的 `execute` 第三参就是 `AbortSignal`（abort 时 SDK 自己
 * `killProcessTree`），所以内核只需要「执行开始登记 / 结束注销」这一层，`abortBash` 就有真句柄可拉。
 *
 * 合成 signal 用的是 `AbortSignal.any([上游, 句柄])`：会话中止 / 用户 ESC 与「停掉这条命令」两路都要
 * 真杀掉进程树，任一方向到达都算数。注销放在 `finally`：成功、失败、被中止三条路都不会漏表。
 * 登记只覆盖**真正开始执行之后**这一段（审批等待不算「正在跑的命令」），所以这层包在审批闸里面。
 */
export function withBashAbortHandle(
	def: ToolDefinition,
	options: { kills: BashAbortRegistry; conversationId?: () => string | undefined },
): ToolDefinition {
	const run = def.execute as (...args: unknown[]) => unknown;
	return {
		...def,
		execute: (async (...args: unknown[]) => {
			const handle = options.kills.register(options.conversationId?.());
			if (!handle) return run(...args);
			const upstream = args[2];
			const signal = upstream instanceof AbortSignal ? AbortSignal.any([upstream, handle.signal]) : handle.signal;
			try {
				return await run(args[0], args[1], signal, args[3], args[4]);
			} finally {
				handle.release();
			}
		}) as ToolDefinition["execute"],
	};
}

/**
 * 内置 `bash` / `edit` 在 SDK 里是直接执行、没有审批钩子的（审批只能长在工具定义里）。
 * 这里用 SDK 自己的定义工厂重建同名工具，再过 `withToolGuard` 的审批闸，
 * 由 `customTools` 覆盖内置同名项（SDK 的 definitionRegistry 是 `set(name, …)`，自定义后写覆盖内置）。
 */
/**
 * 远程工作区的 SSH/SFTP 操作由宿主注入：非远程 cwd 或没注入时，三个工具都走本地实现
 * （老树同口径）。内核不认识 SSH，也不该认识。
 */
export function createGuardedBuiltinTools(
	options: GuardedToolOptions & { remoteOpsOf?: RemoteSdkOperationsFactory },
): ToolDefinition[] {
	// 远程工作区要用 SSH/SFTP 的文件操作（宿主注入）；非远程或没注入就走本地实现（老树同口径）。
	const remoteOps = options.remoteOpsOf?.(options.cwd);
	const baseBash = createBashToolDefinition(options.cwd);
	const bash: ToolDefinition = {
		...(baseBash as ToolDefinition),
		parameters: BASH_TOOL_PARAMETERS,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const raw = (params ?? {}) as {
				command?: string;
				timeout?: number;
				background?: boolean;
				waitMs?: number;
				notificationTimeoutSec?: number;
			};
			const bg = options.background?.();
			const command = String(raw.command ?? "").trim();
			const timeoutSec =
				typeof raw.timeout === "number" && Number.isFinite(raw.timeout) && raw.timeout > 0
					? Math.floor(raw.timeout)
					: 0;
			const notificationTimeoutSec =
				typeof raw.notificationTimeoutSec === "number" &&
				Number.isFinite(raw.notificationTimeoutSec) &&
				raw.notificationTimeoutSec > 0
					? Math.floor(raw.notificationTimeoutSec)
					: 0;

			if (raw.background === true) {
				if (!bg?.startJob) throw new Error("background=true is unavailable on this server");
				if (!command) throw new Error("background=true requires a non-empty command");
				if (remoteOps) throw new Error("background=true is not supported on remote SSH workspaces");
				const job = await bg.startJob({
					command,
					cwd: options.cwd,
					label: command,
					timeoutSec,
					notificationTimeoutSec,
					...(options.conversationId?.() ? { origin: options.conversationId() } : {}),
				});
				const text = [
					`Started in the background: job ${job.id}, pid ${job.pid}.`,
					`Log file: ${job.logPath}`,
					`Use bg_task(action="status"/"kill", jobId="${job.id}") to inspect or stop. You will be notified automatically when it exits.`,
					job.head ? `Captured output:\n${job.head}` : "(no output yet)",
				].join("\n");
				return {
					content: [{ type: "text", text }],
					details: { background: true, jobId: job.id, pid: job.pid, logPath: job.logPath },
				} as never;
			}

			if (
				typeof raw.waitMs === "number" &&
				Number.isFinite(raw.waitMs) &&
				raw.waitMs > 0 &&
				bg?.runJobWithWait &&
				!remoteOps
			) {
				if (!command) throw new Error("command must be non-empty");
				const res = await bg.runJobWithWait({
					command,
					cwd: options.cwd,
					label: command,
					timeoutSec,
					notificationTimeoutSec,
					waitMs: Math.floor(raw.waitMs),
					...(signal ? { signal } : {}),
					...(options.conversationId?.() ? { origin: options.conversationId() } : {}),
				});
				if (res.completed) {
					const exit = res.job.exitCode;
					const body = res.output.trim() || "(no output)";
					if (exit !== null && exit !== 0) {
						throw new Error(`Command exited with code ${exit}\n${body}`);
					}
					return {
						content: [{ type: "text", text: body }],
						details: { exitCode: exit ?? 0, jobId: res.job.id },
					} as never;
				}
				const text = [
					`Command exceeded waitMs=${Math.floor(raw.waitMs)} and moved to background: job ${res.job.id}, pid ${res.job.pid}.`,
					`Log file: ${res.job.logPath}`,
					`Use bg_task(action="status"/"kill", jobId="${res.job.id}") to inspect or stop. You will be notified automatically when it exits.`,
					res.output.trim() ? `Captured output:\n${res.output.trim()}` : "(no output yet)",
				].join("\n");
				return {
					content: [{ type: "text", text }],
					details: { background: true, promoted: true, jobId: res.job.id, pid: res.job.pid, logPath: res.job.logPath },
				} as never;
			}

			return await baseBash.execute(toolCallId, params as never, signal, onUpdate, ctx);
		},
	};
	const write = createWriteToolDefinition(
		options.cwd,
		remoteOps ? { operations: remoteOps.write as never } : undefined,
	);
	const edit = createEditToolDefinition(options.cwd, remoteOps ? { operations: remoteOps.edit as never } : undefined);
	// 插件守卫只在宿主装了 `toolGuard` 时才包一层：没装 = 连包装都不加（不为「空守卫」付一层 await）。
	const guard = options.guard ? makeLateToolGuard(options.guard) : undefined;
	const common = {
		guard,
		conversationId: options.conversationId,
		getLang: options.getLang,
		cwd: options.cwd,
		getRoots: options.getRoots,
		getRules: options.getRules,
		isApprovalEnabled: options.isApprovalEnabled,
		askApproval: options.askApproval,
	};
	// 写盘类工具默认规则库已经覆盖（`approval-default-rules.ts` 的 `tools: ["write","edit","patch"]`），
	// 这里只是把它们的执行接到同一个审批闸上。bash 里面再套一层中止句柄登记（审批等完才开始算「在跑」）。
	const killableBash = options.bashKills
		? withBashAbortHandle(bash as ToolDefinition, {
				kills: options.bashKills,
				...(options.conversationId ? { conversationId: options.conversationId } : {}),
			})
		: (bash as ToolDefinition);
	return [
		withToolGuard(killableBash, { ...common, toolName: "bash" }),
		withToolGuard(write as ToolDefinition, { ...common, toolName: "write" }),
		withToolGuard(edit as ToolDefinition, { ...common, toolName: "edit" }),
	];
}

export const GUARDED_BUILTIN_NAMES = ["bash", "write", "edit"] as const;
