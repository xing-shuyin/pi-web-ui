import {
	createBashToolDefinition,
	createLocalBashOperations,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { pick, type ServerLang } from "./i18n.js";
import { applyHeadTail } from "./terminals.js";
import { BASH_DESCRIPTION, BASH_PARAMETERS, BASH_PROMPT_GUIDELINES, BASH_PROMPT_SNIPPET } from "./tool-prompts.js";
import { resolveBackgroundTimeoutSec, withDefaultBashTimeout } from "./bash-timeout.js";
import type { JobRegistry } from "./job-runner.js";
import {
	getGlobalRemoteSshService,
	isRemoteWorkspaceUri,
	restoreWorkspaceUriFromSessionDir,
} from "./remote-ssh-service.js";

export function makeKillableBashTool(
	cwd: string,
	kills: Set<AbortController>,
	lang: () => ServerLang = () => "en",
	jobs?: JobRegistry,
	origin?: () => string | undefined,
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
			const raw = params as { command: string; timeout?: number; background?: boolean };
			// 后台任务走进程内 job registry（不经过 PTY、不阻塞本次调用）。
			if (raw?.background === true) {
				if (!jobs) {
					throw new Error(
						"background=true is unavailable: the in-process job runner is not wired on this server. Run the command in the foreground or start it in the terminal panel.",
					);
				}
				const command = String(raw.command ?? "").trim();
				if (!command) throw new Error("background=true requires a non-empty command");
				const effCwd = restoreWorkspaceUriFromSessionDir(cwd);
				if (isRemoteWorkspaceUri(effCwd)) {
					throw new Error(
						"background=true is not supported on remote SSH workspaces: the job would run on the local machine. Run it in the foreground instead.",
					);
				}
				const timeoutSec = resolveBackgroundTimeoutSec(raw.timeout);
				const job = jobs.start({
					command,
					cwd: effCwd,
					label: command,
					timeoutSec,
					...(origin?.() ? { origin: origin() } : {}),
				});
				const head = await jobs.awaitFirstOutput(job.id);
				const l = lang();
				const timeoutText =
					timeoutSec > 0
						? pick(l, `硬超时 ${timeoutSec}s`, `hard timeout ${timeoutSec}s`, "bash.bgTimeout", { n: timeoutSec })
						: pick(l, "不限时", "no time limit", "bash.bgNoTimeout");
				const text = pick(
					l,
					`已在后台启动：job ${job.id}，pid ${job.pid}（${timeoutText}）。本次调用立即返回，命令继续运行。\n` +
						`日志文件：${job.logPath}（要看后续输出就用 read 读它的尾部）。\n` +
						`停止：顶栏「后台任务」→ 停止，或任何一次 bash 里 kill -TERM ${job.pid}。\n` +
						(head ? `已捕获的输出：\n${head}\n` : "（暂无输出）\n"),
					`Started in the background: job ${job.id}, pid ${job.pid} (${timeoutText}). This call returned immediately; the command keeps running.\n` +
						`Log file: ${job.logPath} (read its tail to follow up).\n` +
						`Stop: top-bar Background tasks → Stop, or kill -TERM ${job.pid} in a later bash call.\n` +
						(head ? `Captured output:\n${head}\n` : "(no output yet)\n"),
					"bash.bgStarted",
					{ id: job.id, pid: job.pid, timeout: timeoutSec },
				);
				return {
					content: [{ type: "text", text }],
					details: {
						background: true,
						jobId: job.id,
						pid: job.pid,
						logPath: job.logPath,
						timeoutSec,
						tail: head.slice(0, 4000),
					},
				} as never;
			}
			// 模型漏传 timeout 时不给"无时限"：默认 120s，由 server/bash-timeout.ts 单源归一。
			const effective = withDefaultBashTimeout(
				params as { command: string; timeout?: number; head?: number; tail?: number },
			);
			const result = (await tool.execute(toolCallId, effective, signal, onUpdate, ctx)) as {
				content?: Array<{ type: string; text?: string }>;
			};
			const p = effective;
			if ((p?.head || p?.tail) && result?.content?.[0]?.text != null) {
				result.content![0].text = applyHeadTail(result.content![0].text!, p.head, p.tail, lang());
			}
			return result as never;
		},
	} as ToolDefinition;
}

export function makeAdaptiveBashTool(
	killable: ToolDefinition,
	terminalBacked: ToolDefinition,
	useTerminal: () => boolean,
): ToolDefinition {
	return {
		...killable,
		execute: (id, params, signal, onUpdate, ctx) => {
			const p = params as { persist?: boolean; background?: boolean };
			// background 永远走 job registry：PTY 后端没有后台契约（scrollback 无日志、分不清退出原因）。
			if (p?.background === true) return killable.execute(id, params as never, signal, onUpdate, ctx);
			const shouldUseTerminal = useTerminal() && (process.platform !== "win32" || p?.persist === true);
			return (shouldUseTerminal ? terminalBacked : killable).execute(id, params as never, signal, onUpdate, ctx);
		},
	};
}
