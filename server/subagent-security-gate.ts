import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { pick, type ServerLang } from "./i18n.js";
import { bashCommandHasSupportedSyntax, bashCommandIsReadOnly, readOnlyToolCallAllowed } from "./plan-mode.js";
import { goalReviewBashAllowed } from "./goal-review-gate.js";
import {
	isReadOnlyConversationAction,
	conversationToolAllowed,
	isConversationTool,
} from "./conversation-tool-names.js";

export type SubagentSecurityMode = "normal" | "readonly" | "verify";

export interface SubagentSpawnExtra {
	allowedTools?: string[];
	securityMode?: SubagentSecurityMode;
}

const READONLY_ROLE_KEYWORDS = ["explore", "scout", "research", "oracle", "librarian", "reader"];

const VERIFY_ROLE_KEYWORDS = ["review", "audit", "verify", "inspector"];

export function resolveSecurityMode(
	nameOrType?: string,
	template?: { securityMode?: SubagentSecurityMode; name?: string },
): SubagentSecurityMode {
	if (template?.securityMode && template.securityMode !== "normal") {
		return template.securityMode;
	}
	const candidate = `${template?.name ?? ""} ${nameOrType ?? ""}`.trim().toLowerCase();
	if (!candidate) return "normal";
	for (const kw of VERIFY_ROLE_KEYWORDS) {
		if (candidate.includes(kw)) return "verify";
	}
	for (const kw of READONLY_ROLE_KEYWORDS) {
		if (candidate.includes(kw)) return "readonly";
	}
	return "normal";
}

const TOOL_NAME_ALIASES: Record<string, string> = {
	terminal: "terminal",
	shell: "bash",
	sh: "bash",
	cmd: "bash",
	exec: "bash",
	cli: "bash",
	grep: "grep",
	find: "find",
	read: "read",
	view: "read",
	cat: "read",
};

export function parseRequiredTools(
	raw: unknown,
	availableTools?: readonly string[] | Set<string>,
): {
	allowedTools?: string[];
	unrecognized?: string[];
	requestedReadOnly?: boolean;
} {
	if (typeof raw !== "string" || !raw.trim()) {
		return {};
	}

	const text = raw.trim();
	const lower = text.toLowerCase();
	const requestedReadOnly = lower.includes("read-only") || lower.includes("readonly") || lower.includes("reader");

	const matches = text.match(/[A-Za-z0-9_-]+/g) || [];
	const availableSet = availableTools instanceof Set ? availableTools : availableTools ? new Set(availableTools) : null;

	const seen = new Set<string>();
	const allowedTools: string[] = [];
	const unrecognized: string[] = [];

	for (const item of matches) {
		const token = item.trim().toLowerCase();
		if (
			[
				"and",
				"or",
				"with",
				"only",
				"tools",
				"tool",
				"the",
				"for",
				"read-only",
				"readonly",
				"reader",
				"none",
				"all",
			].includes(token)
		) {
			continue;
		}
		const mapped = TOOL_NAME_ALIASES[token] ?? token;
		if (seen.has(mapped)) continue;
		seen.add(mapped);

		if (availableSet) {
			if (
				availableSet.has(mapped) ||
				(mapped.startsWith("terminal_") &&
					availableSet.has("terminal") &&
					["create", "list", "close", "input", "key", "read", "wait"].includes(mapped.slice(9)))
			) {
				allowedTools.push(mapped);
			} else {
				unrecognized.push(token);
			}
		} else {
			allowedTools.push(mapped);
		}
	}

	return {
		allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
		unrecognized: unrecognized.length > 0 ? unrecognized : undefined,
		requestedReadOnly,
	};
}

export const SUBAGENT_WRITE_TOOL_NAMES = new Set<string>([
	"write",
	"create",
	"create_file",
	"write_file",
	"edit",
	"edit_file",
	"edit_soft",
	"apply_patch",
	"patch",
	"patch_tool",
	"str_replace",
	"str_replace_editor",
	"multi_edit",
	"notebook_edit",
	"mv",
	"move",
	"cp",
	"copy",
	"mkdir",
	"rm",
	"rmdir",
	"delete",
	"delete_file",
	"touch",
	"chmod",
	"chown",
	"codemode",
	"powershell",
]);

export const SUBAGENT_TERMINAL_INPUT_TOOLS = new Set<string>([
	"terminal_input",
	"terminal_key",
	"terminal_create",
	"terminal_close",
]);

export const SUBAGENT_DISPATCH_TOOLS = new Set<string>(["delegate_task"]);

const BASH_TOOL_NAMES = new Set(["bash", "bash_execute", "run_command", "shell", "terminal_exec"]);

function commandOf(params: unknown): string {
	if (!params || typeof params !== "object") return "";
	const p = params as Record<string, unknown>;
	for (const key of ["command", "cmd", "script", "input"]) {
		const v = p[key];
		if (typeof v === "string" && v.trim() !== "") return v;
	}
	return "";
}

export interface SubagentSecurityDenial {
	kind: "write-tool" | "terminal-input" | "dispatch-tool" | "bash-write" | "not-allowed-tool";
	reason: string;
	reasonEn: string;
}

export function subagentAllowedToolCall(allowed: ReadonlySet<string>, name: string, params: unknown): boolean {
	if (conversationToolAllowed(allowed, name)) return true;
	if (name !== "terminal" || !params || typeof params !== "object") return false;
	const action = (params as Record<string, unknown>).action;
	return (
		typeof action === "string" &&
		["create", "list", "close", "input", "key", "read", "wait"].includes(action) &&
		allowed.has(`terminal_${action}`)
	);
}

export function subagentAllowedToolVisible(allowed: ReadonlySet<string>, name: string): boolean {
	return (
		conversationToolAllowed(allowed, name) ||
		(name === "terminal" &&
			["create", "list", "close", "input", "key", "read", "wait"].some((action) => allowed.has(`terminal_${action}`)))
	);
}

export function subagentSecurityDenial(
	mode: SubagentSecurityMode,
	toolName: string,
	params: unknown,
	allowedTools?: Set<string>,
): SubagentSecurityDenial | undefined {
	const name = (toolName ?? "").trim();

	if (allowedTools && allowedTools.size > 0 && !subagentAllowedToolCall(allowedTools, name, params)) {
		return {
			kind: "not-allowed-tool",
			reason: `受限子代理：工具 "${name}" 不在本次任务允许的工具白名单内（仅限：${[...allowedTools].join(", ")}）。`,
			reasonEn: `Restricted subagent: tool "${name}" is not in the allowed tool whitelist for this task (only: ${[...allowedTools].join(", ")}).`,
		};
	}

	if (mode === "normal") {
		return undefined;
	}

	if (SUBAGENT_DISPATCH_TOOLS.has(name)) {
		return {
			kind: "dispatch-tool",
			reason: `受限子代理（${mode}）：禁止调用派发工具 "${name}"。请在当前会话内独立完成分析与核实并返回结论。`,
			reasonEn: `Restricted subagent (${mode}): dispatch tool "${name}" is blocked. Complete inspection and return findings within this session.`,
		};
	}
	if (name === "communicate") {
		const action = params && typeof params === "object" ? (params as Record<string, unknown>).action : undefined;
		if (typeof action !== "string" || !["read", "send", "request", "reply", "escalate"].includes(action)) {
			return {
				kind: "dispatch-tool",
				reason: "受限子代理：未知通信操作。",
				reasonEn: "Restricted subagent: unknown communication action.",
			};
		}
		return undefined;
	}
	if (isConversationTool(name)) {
		const action =
			typeof params === "object" && params !== null ? (params as Record<string, unknown>).action : undefined;
		const act = typeof action === "string" ? action.trim().toLowerCase() : "";
		if (act === "complete") return undefined;
		if (!isReadOnlyConversationAction(act)) {
			return {
				kind: "dispatch-tool",
				reason: `受限子代理（${mode}）：禁止调用 subagent(action="${act || "spawn"}") 派生或操控其他子代理。`,
				reasonEn: `Restricted subagent (${mode}): subagent(action="${act || "spawn"}") is blocked in restricted mode.`,
			};
		}
	}

	if (SUBAGENT_WRITE_TOOL_NAMES.has(name)) {
		return {
			kind: "write-tool",
			reason: `受限子代理（${mode}）：当前属于只读/审查模式，禁止调用写工具 "${name}"。请使用 read/grep/只读命令进行核实。`,
			reasonEn: `Restricted subagent (${mode}): write tool "${name}" is blocked in read/verify mode. Use read/grep/read-only commands to inspect.`,
		};
	}

	if (SUBAGENT_TERMINAL_INPUT_TOOLS.has(name)) {
		return {
			kind: "terminal-input",
			reason: `受限子代理（${mode}）：禁止使用交互式终端输入工具 "${name}"。请使用一次性 bash 只读命令。`,
			reasonEn: `Restricted subagent (${mode}): interactive terminal tool "${name}" is blocked. Use one-shot read-only bash commands instead.`,
		};
	}

	if (BASH_TOOL_NAMES.has(name)) {
		const cmd = commandOf(params);
		if (!cmd.trim()) {
			return {
				kind: "bash-write",
				reason: `受限子代理（${mode}）：不接受无命令的 bash 调用。`,
				reasonEn: `Restricted subagent (${mode}): empty bash calls are rejected.`,
			};
		}

		if (mode === "readonly") {
			if (!bashCommandIsReadOnly(cmd)) {
				return {
					kind: "bash-write",
					reason: `只读侦察子代理（readonly）：命令被阻断（仅允许纯只读命令，如 ls/cat/grep/git diff/git log 等）：\`${cmd.slice(0, 160)}\`。`,
					reasonEn: `Read-only subagent (readonly): command blocked (only pure read-only commands allowed, e.g. ls/cat/grep/git diff/git log): \`${cmd.slice(0, 160)}\`.`,
				};
			}
		} else if (mode === "verify") {
			if (!bashCommandHasSupportedSyntax(cmd) || !goalReviewBashAllowed(cmd)) {
				return {
					kind: "bash-write",
					reason: `审查验证子代理（verify）：命令被阻断（仅允许只读命令与测试套件，禁止重定向写或破坏性操作）：\`${cmd.slice(0, 160)}\`。`,
					reasonEn: `Verification subagent (verify): command blocked (only read-only and test runner commands allowed, no redirect writes or destructive ops): \`${cmd.slice(0, 160)}\`.`,
				};
			}
		}
		return undefined;
	}

	if (!readOnlyToolCallAllowed(name, params)) {
		return {
			kind: "not-allowed-tool",
			reason: `受限子代理（${mode}）：工具 "${name}" 的本次调用未声明为只读，已拒绝。请使用 read/grep 或结构化查询。`,
			reasonEn: `Restricted subagent (${mode}): tool "${name}" is not an explicitly supported read-only call. Use read/grep or structured queries.`,
		};
	}
	return undefined;
}

export function withSubagentSecurityGate(
	def: ToolDefinition,
	getSecurityInfo: () => { mode?: SubagentSecurityMode; allowedTools?: Set<string> },
	getLang: () => ServerLang,
): ToolDefinition {
	return {
		...def,
		execute: (async (...args: unknown[]) => {
			const info = getSecurityInfo();
			const mode = info.mode ?? "normal";
			const allowedTools = info.allowedTools;

			if (mode !== "normal" || (allowedTools && allowedTools.size > 0)) {
				const params = args[1];
				const denied = subagentSecurityDenial(mode, def.name, params, allowedTools);
				if (denied) {
					return {
						content: [{ type: "text", text: pick(getLang(), denied.reason, denied.reasonEn) }],
						details: { guardDenied: true, subagentSecurityDenied: true, kind: denied.kind },
						isError: true,
					} as never;
				}
			}

			return (def.execute as (...a: unknown[]) => unknown)(...args);
		}) as ToolDefinition["execute"],
	};
}
