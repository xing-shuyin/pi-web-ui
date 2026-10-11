/**
 * bash-tool — bash 工具的原生可中断版本与动态终端分流版本。
 *
 * - makeKillableBashTool: 包装 SDK 原生进程版 bash，带 AbortController 集合与 head/tail 后处理。
 * - makeAdaptiveBashTool: 根据用户设置在进程版与可见终端版之间动态分流执行。
 *
 * 从 agent-service.ts 抽出为独立模块。
 */
import {
	createBashToolDefinition,
	createLocalBashOperations,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ServerLang } from "./i18n.js";
import { applyHeadTail } from "./terminals.js";
import { BASH_DESCRIPTION, BASH_PARAMETERS, BASH_PROMPT_GUIDELINES, BASH_PROMPT_SNIPPET } from "./tool-prompts.js";
import {
	getGlobalRemoteSshService,
	isRemoteWorkspaceUri,
	restoreWorkspaceUriFromSessionDir,
} from "./remote-ssh-service.js";

/**
 * Killable bash tool: wraps the SDK bash tool (native process spawn, NO terminal).
 * Used when the「默认 bash 覆盖」setting is OFF. Registers its own AbortController
 * into a client-level set (kills) so abortBash() kills only these commands while the
 * agent run and the conversation continue. Exposes persist (ignored — native has no
 * terminal) plus head/tail (post-processed on the returned output) so the parameter
 * schema stays consistent with the terminal-backed tool.
 */
export function makeKillableBashTool(
	cwd: string,
	kills: Set<AbortController>,
	/** per-call 返回文本的服务端语言（默认英文）；工具 definition 为纯英文。 */
	lang: () => ServerLang = () => "en",
): ToolDefinition {
	const base = createLocalBashOperations();
	const tool = createBashToolDefinition(cwd, {
		operations: {
			exec: async (command, c, opts) => {
				const ac = new AbortController();
				kills.add(ac);
				try {
					const signals = [opts.signal, ac.signal].filter((s): s is AbortSignal => s !== undefined);
					const combinedSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
					const effCwd = restoreWorkspaceUriFromSessionDir(c || cwd);
					if (isRemoteWorkspaceUri(effCwd)) {
						const sshSvc = getGlobalRemoteSshService();
						if (!sshSvc) {
							throw new Error("Remote SSH service is not initialized");
						}
						const timeoutMs =
							opts.timeout !== undefined && Number.isFinite(opts.timeout) && opts.timeout > 0
								? opts.timeout * 1000
								: undefined;
						const res = await sshSvc.execInWorkspace(effCwd, command, {
							signal: combinedSignal,
							timeoutMs,
							onData: opts.onData,
						});
						return { exitCode: res.exitCode };
					}
					return await base.exec(command, c, {
						...opts,
						signal: combinedSignal,
					});
				} finally {
					kills.delete(ac);
				}
			},
		},
	});
	// Keep the SDK definition so execute receives the current session context.
	return {
		name: tool.name,
		label: tool.label,
		description: BASH_DESCRIPTION,
		promptSnippet: BASH_PROMPT_SNIPPET,
		promptGuidelines: BASH_PROMPT_GUIDELINES,
		parameters: BASH_PARAMETERS,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const result = (await tool.execute(
				toolCallId,
				params as { command: string; timeout?: number },
				signal,
				onUpdate,
				ctx,
			)) as { content?: Array<{ type: string; text?: string }> };
			// head/tail 后处理（native 无终端，直接截返回行即可）。
			const p = params as { head?: number; tail?: number };
			if ((p?.head || p?.tail) && result?.content?.[0]?.text != null) {
				result.content![0].text = applyHeadTail(result.content![0].text!, p.head, p.tail, lang());
			}
			return result as never;
		},
	} as ToolDefinition;
}

/**
 * 动态分流 bash：按「默认 bash 覆盖」设置（terminalBash）在调用时决定走哪套——
 * 关 = 原生 SDK bash（纯进程、不开终端）；开 = 终端接管 bash（persist 决定一次性/
 * 持久）。开关因此即时生效（customTools 固定于 runtime 创建，不能在创建时二选一）。
 *
 * 提示词不在此覆盖：两条路径共用 server/tool-prompts.ts 的那一份（单源），
 * 覆盖 description 正是当年终端版文案被写死却不生效的成因。
 */
export function makeAdaptiveBashTool(
	killable: ToolDefinition,
	terminalBacked: ToolDefinition,
	useTerminal: () => boolean,
): ToolDefinition {
	return {
		...killable,
		execute: (id, params, signal, onUpdate, ctx) => {
			const p = params as { persist?: boolean };
			// Windows 下 ConPTY 架构限制（MSYS2 全局控制台上限 128，且高频创建销毁容易句柄耗尽/卡顿）：
			// 一次性命令（persist !== true）走原生 spawn（基于 pipe，无需分配控制台，速度快 60 倍且免死锁，issue #269）；
			// 只有明确需要持久交互（persist === true）才进可见终端 ai-bash。
			const shouldUseTerminal = useTerminal() && (process.platform !== "win32" || p?.persist === true);
			return (shouldUseTerminal ? terminalBacked : killable).execute(id, params as never, signal, onUpdate, ctx);
		},
	};
}
