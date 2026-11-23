import { createBashToolDefinition, createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withToolGuard, type AskApprovalFn } from "../../../tool-guards.js";
import type { ServerLang } from "../../../i18n.js";

export interface GuardedToolOptions {
	cwd: string;
	getLang: () => ServerLang;
	askApproval: AskApprovalFn;
	getRoots?: () => string[];
	conversationId?: () => string | undefined;
}

/**
 * 内置 `bash` / `edit` 在 SDK 里是直接执行、没有审批钩子的（审批只能长在工具定义里）。
 * 这里用 SDK 自己的定义工厂重建同名工具，再过 `withToolGuard` 的审批闸，
 * 由 `customTools` 覆盖内置同名项（SDK 的 definitionRegistry 是 `set(name, …)`，自定义后写覆盖内置）。
 */
export function createGuardedBuiltinTools(options: GuardedToolOptions): ToolDefinition[] {
	const bash = createBashToolDefinition(options.cwd);
	const edit = createEditToolDefinition(options.cwd);
	const common = {
		guard: undefined,
		conversationId: options.conversationId,
		getLang: options.getLang,
		cwd: options.cwd,
		getRoots: options.getRoots,
		askApproval: options.askApproval,
	};
	// 只包 bash：`withToolGuard` 的 `GuardedToolName` 目前只收 bash/read（审批规则库也是按它建的），
	// edit/write 的审批要先把那个类型与规则库一起扩，属于下一波。
	void edit;
	return [withToolGuard(bash as ToolDefinition, { ...common, toolName: "bash" })];
}

export const GUARDED_BUILTIN_NAMES = ["bash"] as const;
