import {
	createBashToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withToolGuard, type AskApprovalFn } from "../../../../../server/tool-guards.js";
import type { ServerLang } from "../../../../../server/i18n.js";

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
	const write = createWriteToolDefinition(options.cwd);
	const edit = createEditToolDefinition(options.cwd);
	const common = {
		guard: undefined,
		conversationId: options.conversationId,
		getLang: options.getLang,
		cwd: options.cwd,
		getRoots: options.getRoots,
		askApproval: options.askApproval,
	};
	// 写盘类工具默认规则库已经覆盖（`approval-default-rules.ts` 的 `tools: ["write","edit","patch"]`），
	// 这里只是把它们的执行接到同一个审批闸上。
	return [
		withToolGuard(bash as ToolDefinition, { ...common, toolName: "bash" }),
		withToolGuard(write as ToolDefinition, { ...common, toolName: "write" }),
		withToolGuard(edit as ToolDefinition, { ...common, toolName: "edit" }),
	];
}

export const GUARDED_BUILTIN_NAMES = ["bash", "write", "edit"] as const;
