import { bashCommandIsReadOnly, readOnlyToolCallAllowed, SESSION_DISPATCH_TOOLS } from "./plan-mode.js";
import { isReadOnlyConversationAction, CONVERSATION_TOOL_NAMES } from "./conversation-tool-names.js";

export const DELEGATE_MODE_BLOCKED_TOOL_NAMES: readonly string[] = [
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
	"truncate",
	"rename",
	"git",
	"eval",
	"codemode",
	"mcp_manage",
	"device_collab",
	"sandbox",
	"format",
	"prettier",
	"lint_fix",
	"autofix",
	...CONVERSATION_TOOL_NAMES,
	...SESSION_DISPATCH_TOOLS,
];

const BLOCKED_TOOLS = new Set(DELEGATE_MODE_BLOCKED_TOOL_NAMES);

const DISPATCH_TOOLS = new Set([...SESSION_DISPATCH_TOOLS, ...CONVERSATION_TOOL_NAMES]);

const BASH_TOOLS = new Set(["bash", "shell", "sh", "zsh", "terminal_bash", "run_command", "exec"]);

function commandOf(params: unknown): string {
	if (!params || typeof params !== "object") return "";
	const p = params as Record<string, unknown>;
	for (const key of ["command", "cmd", "script", "input"]) {
		const v = p[key];
		if (typeof v === "string" && v.trim() !== "") return v;
	}
	return "";
}

export interface DelegationDenial {
	reason: string;
	reasonEn: string;
	kind: "write-tool" | "bash" | "dispatch-tool";
}

export function delegationDenial(toolName: string, params: unknown): DelegationDenial | undefined {
	const name = (toolName ?? "").trim();
	if (!name) return undefined;
	if (CONVERSATION_TOOL_NAMES.some((alias) => alias === name) && isReadOnlyConversationAction((params as any)?.action))
		return undefined;
	if (DISPATCH_TOOLS.has(name)) {
		return {
			kind: "dispatch-tool",
			reason: `审查者模式：不能调用 ${name} —— 派活由服务端统一做（一个常驻执行对话）。请只描述需求、审阅结果或提问。`,
			reasonEn: `Reviewer mode: ${name} is unavailable — dispatching is done by the server (one persistent executor conversation). Describe the work, review the result, or ask questions.`,
		};
	}
	if (name === "terminal") {
		if (readOnlyToolCallAllowed(name, params)) return undefined;
		return {
			kind: "write-tool",
			reason: "只读审查仅允许 terminal 的 list/read/wait。",
			reasonEn: "Read-only review permits only terminal list/read/wait actions.",
		};
	}
	if (BASH_TOOLS.has(name)) {
		const cmd = commandOf(params);
		if (cmd.trim() === "") {
			return {
				kind: "bash",
				reason: "审查者模式：终端不可用 —— 施工由执行对话做。请用 read/grep/只读 git 看结果。",
				reasonEn:
					"Reviewer mode: the terminal is unavailable — the executor conversation does the work. Inspect with read/grep/read-only git.",
			};
		}
		if (bashCommandIsReadOnly(cmd)) return undefined;
		return {
			kind: "bash",
			reason: `审查者模式：只允许只读命令，命令被拒：\`${cmd.slice(0, 200)}\`。施工请交给执行对话；你要做的是看结果、判断是否达标。`,
			reasonEn: `Reviewer mode: only read-only commands are allowed; rejected: \`${cmd.slice(0, 200)}\`. The executor conversation makes the changes — your job is to inspect the result and judge whether it meets the goal.`,
		};
	}
	if (BLOCKED_TOOLS.has(name)) {
		return {
			kind: "write-tool",
			reason: `审查者模式：本对话不施工，${name} 被拒。需求已由服务端转给执行对话；请改为审阅它交回来的结果（读 diff/测试输出）并提出下一轮要求。`,
			reasonEn: `Reviewer mode: this conversation does not make changes — ${name} was rejected. The request was forwarded to the executor conversation; review its result (read the diff, test output) and state what the next round should do.`,
		};
	}
	return undefined;
}

export const DELEGATION_SYSTEM_PROMPT = [
	"# Reviewer mode (you review; a server-side executor does the work)",
	"Reviewer mode is on for this conversation. The server forwards every user request to ONE persistent executor conversation, and that conversation is the only one allowed to change anything.",
	"Hard rules:",
	"- Never try to change files, run write commands, or dispatch other agents: those tools are blocked by the server and the rejection comes back as a tool error. Do not retry them.",
	"- Your job per turn: state what you expect the executor to deliver (constraints, acceptance criteria, files/paths in scope), then when a result comes back, verify it — read the diff, run read-only commands, check the tests it claims to have run — and either accept it or state precise follow-up requirements for the next round.",
	"- Keep your own messages short and decision-oriented. The executor keeps the working context; you are the reviewer, not the worker.",
	"- If plan mode is also on, plan mode wins: no dispatch happens and you produce the plan yourself.",
].join("\n");

export function delegateNoticeText(enabled: boolean): { text: string; textEn: string } {
	return enabled
		? {
				text: "🔎 审查者模式：本对话只审阅，你的每条请求已由服务端转给常驻执行对话执行",
				textEn:
					"🔎 Reviewer mode on: this conversation only reviews; the server forwards your requests to a persistent executor conversation",
			}
		: {
				text: "审查者模式已关闭：恢复正常对话（本对话可以直接施工）",
				textEn: "Reviewer mode off: back to a normal conversation (this one can make changes again)",
			};
}
