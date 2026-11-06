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

export function makeKillableBashTool(
	cwd: string,
	kills: Set<AbortController>,
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
			const p = params as { head?: number; tail?: number };
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
			const p = params as { persist?: boolean };
			const shouldUseTerminal = useTerminal() && (process.platform !== "win32" || p?.persist === true);
			return (shouldUseTerminal ? terminalBacked : killable).execute(id, params as never, signal, onUpdate, ctx);
		},
	};
}
