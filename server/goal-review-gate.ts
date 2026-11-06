import { bashCommandIsReadOnly, readOnlyToolCallAllowed, SESSION_DISPATCH_TOOLS } from "./plan-mode.js";
import { isReadOnlyConversationAction, isConversationTool } from "./conversation-tool-names.js";

const WRITE_TOOLS = new Set([
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
	"sandbox",
	"format",
	"prettier",
	"lint_fix",
	"autofix",
]);

const DISPATCH_TOOLS = SESSION_DISPATCH_TOOLS;

const BASH_TOOLS = new Set(["bash", "shell", "sh", "zsh", "terminal_bash", "run_command", "exec"]);

function splitReviewSegments(cmd: string): string[] {
	if (/[`$]\(/.test(cmd)) return [cmd];
	const out: string[] = [];
	let cur = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i]!;
		if (quote) {
			cur += ch;
			if (ch === quote && cmd[i - 1] !== "\\") quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			cur += ch;
			continue;
		}
		if (ch === ";" || ch === "\n") {
			out.push(cur);
			cur = "";
			continue;
		}
		if ((ch === "&" || ch === "|") && cmd[i + 1] === (ch === "&" ? "&" : "|")) {
			out.push(cur);
			cur = "";
			i++;
			continue;
		}
		if (ch === "|") {
			out.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	out.push(cur);
	return out.map((s) => s.trim()).filter((s) => s !== "");
}

function isTestRunnerChunk(chunk: string): boolean {
	if (/[><`]/.test(chunk)) return false;
	const tokens = chunk.split(/\s+/).filter(Boolean);
	const first = tokens[0] ?? "";
	const name = first.slice(first.lastIndexOf("/") + 1);
	const args = tokens.slice(1);
	switch (name) {
		case "npm":
		case "yarn":
		case "pnpm":
		case "bun":
			return args[0] === "test" || (args[0] === "run" && (args[1] ?? "").startsWith("test"));
		case "npx":
			return args[0] === "vitest" || args[0] === "jest" || args[0] === "mocha";
		case "pytest":
			return true;
		case "python":
		case "python3":
			return args[0] === "-m" && (args[1] === "pytest" || args[1] === "unittest");
		case "node":
			return args[0] === "--test";
		case "go":
		case "cargo":
			return args[0] === "test";
		case "make":
			return (args[0] ?? "").startsWith("test") || args[0] === "check";
		default:
			return false;
	}
}

export function goalReviewBashAllowed(cmd: string): boolean {
	const text = (cmd ?? "").trim();
	if (!text) return false;
	const chunks = splitReviewSegments(text);
	if (chunks.length === 0) return false;
	return chunks.every((c) => isTestRunnerChunk(c) || bashCommandIsReadOnly(c));
}

function commandOf(params: unknown): string {
	if (!params || typeof params !== "object") return "";
	const p = params as Record<string, unknown>;
	for (const key of ["command", "cmd", "script", "input"]) {
		const v = p[key];
		if (typeof v === "string" && v.trim() !== "") return v;
	}
	return "";
}

export function shouldDeferPromptForReview(opts: {
	queue: boolean;
	text: string;
	hasAttachments: boolean;
	awaitingVerdict: boolean;
}): boolean {
	if (opts.queue || !opts.awaitingVerdict || opts.hasAttachments) return false;
	if (opts.text.trim().startsWith("/")) return false;
	return true;
}

export interface GoalReviewDenial {
	reason: string;
	reasonEn: string;
	kind: "write-tool" | "bash" | "dispatch-tool" | "ask-user";
}

export function goalReviewDenial(toolName: string, params: unknown): GoalReviewDenial | undefined {
	const name = (toolName ?? "").trim();
	if (!name) return undefined;
	if (name === "ask_user_question") {
		return {
			kind: "ask-user",
			reason:
				"目标审查回合：不能向用户提问（本回合由服务端自动驱动，弹窗无人应答）。请只做本轮审查、只回 verdict JSON。",
			reasonEn:
				"Goal review round: do not ask the user anything (this round is server-driven; dialogs go unanswered). Just review this round and reply with only the verdict JSON.",
		};
	}
	if (isConversationTool(name)) {
		const action =
			typeof params === "object" && params !== null ? (params as Record<string, unknown>).action : undefined;
		const act = typeof action === "string" ? action.trim().toLowerCase() : "";
		if (isReadOnlyConversationAction(act)) {
			return undefined;
		}
		return {
			kind: "dispatch-tool",
			reason: `目标审查回合：不能调用 subagent(action="${act || "spawn"}") —— 轮次由服务端控制。请只做本轮审查、只回 verdict JSON。`,
			reasonEn: `Goal review round: subagent(action="${act || "spawn"}") is unavailable — the server owns the rounds. Just review this round and reply with only the verdict JSON.`,
		};
	}
	if (DISPATCH_TOOLS.has(name)) {
		return {
			kind: "dispatch-tool",
			reason: `目标审查回合：不能调用 ${name} —— 轮次由服务端控制。请只做本轮审查、只回 verdict JSON。`,
			reasonEn: `Goal review round: ${name} is unavailable — the server owns the rounds. Just review this round and reply with only the verdict JSON.`,
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
				reason: "目标审查回合：终端只用于只读核实（跑测试 / 看 diff），不接受无命令调用。请用 read / grep / 只读 git。",
				reasonEn:
					"Goal review round: the terminal is for read-only verification only (run tests / inspect the diff); calls without a command are rejected. Use read / grep / read-only git.",
			};
		}
		if (goalReviewBashAllowed(cmd)) return undefined;
		return {
			kind: "bash",
			reason: `目标审查回合：只允许只读命令，命令被拒：\`${cmd.slice(0, 200)}\`。要改工作区请在 verdict 里判 fail 并写具体待改项，让执行对话下一轮做。`,
			reasonEn: `Goal review round: only read-only commands are allowed; rejected: \`${cmd.slice(0, 200)}\`. To change the workspace, verdict fail with concrete items and let the executor do it next round.`,
		};
	}
	if (WRITE_TOOLS.has(name)) {
		return {
			kind: "write-tool",
			reason: `目标审查回合：只读核实，${name} 被拒。工作区的改动由执行对话做；你的职责是看实际状态、只回 verdict JSON。`,
			reasonEn: `Goal review round: read-only verification — ${name} was rejected. The executor conversation makes the changes; your job is to inspect the actual state and reply with only the verdict JSON.`,
		};
	}
	return undefined;
}
