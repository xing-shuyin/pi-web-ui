const BLOCKED_TOOLS = new Set([
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

const TERMINAL_WRITE_TOOLS = new Set(["terminal_input", "terminal_key"]);

import {
	isReadOnlyConversationAction,
	CONVERSATION_TOOL_NAMES,
	isConversationTool,
} from "./conversation-tool-names.js";

export const SESSION_DISPATCH_TOOLS = new Set<string>(["delegate_task", "schedule", "communicate"]);

const BYPASS_TOOLS = SESSION_DISPATCH_TOOLS;

export const PLAN_MODE_BLOCKED_TOOL_NAMES = new Set<string>([
	...BLOCKED_TOOLS,
	...BYPASS_TOOLS,
	...TERMINAL_WRITE_TOOLS,
	...CONVERSATION_TOOL_NAMES,
]);

const BASH_TOOLS = new Set(["bash", "bash_execute", "run_command", "shell", "terminal_exec"]);

const UNSUPPORTED_SHELL = /[$`\\<>\x00-\x08\x0b-\x1f\x7f]/;

function splitShellSegments(cmd: string): string[] {
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
		if (/[(){}~#*?[\]]/.test(ch)) return [""];
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
		if (ch === "&") return [""];
		cur += ch;
	}
	if (quote) return [""];
	out.push(cur);
	return out.map((s) => s.trim());
}

interface ReadOnlyOptions {
	short?: string;
	flags?: string[];
	values?: string[];
	shortValues?: string;
	numeric?: boolean;
}
function readOnlyArgs(args: string[], spec: ReadOnlyOptions): boolean {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--") return true;
		if (!arg.startsWith("-") || arg === "-") continue;
		if (spec.flags?.includes(arg)) continue;
		const eq = arg.indexOf("=");
		if (arg.startsWith("--")) {
			const option = eq < 0 ? arg : arg.slice(0, eq);
			if (!spec.values?.includes(option)) return false;
			if (eq < 0 && (args[++i] === undefined || args[i]!.startsWith("-"))) return false;
			continue;
		}
		if (spec.numeric && /^-\d+$/.test(arg)) continue;
		for (let j = 1; j < arg.length; j++) {
			const flag = arg[j]!;
			if (spec.shortValues?.includes(flag)) {
				if (j === arg.length - 1 && (args[++i] === undefined || args[i]!.startsWith("-"))) return false;
				break;
			}
			if (!spec.short?.includes(flag)) return false;
		}
	}
	return true;
}

const READ_ONLY_OPTIONS: Record<string, ReadOnlyOptions> = {
	ls: { short: "aAlhRtdrS1Fipn", flags: ["--all", "--almost-all", "--human-readable"] },
	pwd: { short: "LP" },
	cat: { short: "nbsETAv" },
	head: { short: "qv", shortValues: "nc", numeric: true },
	tail: { short: "qv", shortValues: "nc", numeric: true },
	wc: { short: "clmwL", flags: ["--bytes", "--lines", "--words", "--chars"] },
	stat: { short: "Lf", shortValues: "c", values: ["--format"] },
	du: { short: "ahskm", values: ["--max-depth"] },
	df: { short: "hkiPT" },
	realpath: { short: "emqs" },
	readlink: { short: "femqns" },
	basename: { short: "a", shortValues: "s" },
	dirname: {},
	uname: { short: "asnrvmpio" },
	whoami: {},
	printenv: {},
	md5sum: { short: "bct", flags: ["--check"] },
	sha256sum: { short: "bct", flags: ["--check"] },
	grep: {
		short: "EFGPivwnrlLchsoqRH",
		shortValues: "efABCm",
		numeric: true,
		flags: ["--line-number", "--recursive", "--ignore-case", "--fixed-strings"],
	},
	rg: {
		short: "nNliwsvqocUFHL",
		shortValues: "egtfmABC",
		flags: [
			"--files",
			"--hidden",
			"--no-ignore",
			"--no-heading",
			"--heading",
			"--line-number",
			"--count",
			"--fixed-strings",
			"--ignore-case",
			"--files-with-matches",
			"--files-without-match",
			"--stats",
			"--json",
		],
		values: [
			"--glob",
			"--type",
			"--max-count",
			"--max-depth",
			"--context",
			"--before-context",
			"--after-context",
			"--regexp",
			"--file",
		],
	},
	fd: {
		short: "HILais0",
		shortValues: "etEd",
		flags: ["--hidden", "--no-ignore", "--absolute-path", "--full-path"],
		values: ["--extension", "--type", "--exclude", "--max-depth"],
	},
	cut: { short: "sn", shortValues: "bcfd", values: ["--bytes", "--characters", "--fields", "--delimiter"] },
};

const GIT_OPTIONS: Record<string, ReadOnlyOptions> = {
	status: {
		short: "sbz",
		flags: [
			"--short",
			"--branch",
			"--porcelain",
			"--porcelain=v1",
			"--porcelain=v2",
			"--untracked-files=no",
			"--untracked-files=all",
		],
	},
	diff: {
		short: "pwb",
		shortValues: "U",
		flags: [
			"--stat",
			"--numstat",
			"--shortstat",
			"--name-only",
			"--name-status",
			"--cached",
			"--staged",
			"--check",
			"--no-ext-diff",
			"--no-textconv",
			"--no-color",
			"--color=never",
			"--no-renames",
		],
	},
	log: {
		short: "p",
		shortValues: "n",
		numeric: true,
		flags: [
			"--oneline",
			"--stat",
			"--name-only",
			"--name-status",
			"--all",
			"--graph",
			"--decorate",
			"--no-decorate",
			"--no-color",
			"--no-show-signature",
		],
		values: ["--max-count", "--since", "--until", "--author", "--grep", "--format", "--pretty"],
	},
	show: {
		short: "ps",
		flags: ["--stat", "--name-only", "--name-status", "--oneline", "--no-ext-diff", "--no-textconv", "--no-color"],
		values: ["--format", "--pretty"],
	},
	blame: { short: "w", shortValues: "L", flags: ["--line-porcelain", "--porcelain"] },
	"rev-parse": {
		flags: [
			"--show-toplevel",
			"--show-prefix",
			"--git-dir",
			"--short",
			"--verify",
			"--abbrev-ref",
			"--is-inside-work-tree",
		],
	},
	"rev-list": { shortValues: "n", numeric: true, flags: ["--count", "--all"], values: ["--max-count"] },
	"ls-files": { short: "zcmot", flags: ["--cached", "--modified", "--others", "--exclude-standard", "--stage"] },
	"ls-tree": { short: "rdtz", flags: ["--name-only", "--name-status", "--full-tree"] },
	describe: { flags: ["--tags", "--always", "--long", "--dirty"] },
	"cat-file": { short: "ptse" },
	grep: READ_ONLY_OPTIONS.grep!,
};

function segmentIsReadOnly(segment: string): boolean {
	const words: string[] = [];
	let word = "";
	let quote = "";
	let started = false;
	for (const ch of segment) {
		if (quote) {
			if (ch === quote) quote = "";
			else word += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			started = true;
		} else if (/\s/.test(ch)) {
			if (started) words.push(word);
			word = "";
			started = false;
		} else {
			word += ch;
			started = true;
		}
	}
	if (quote) return false;
	if (started) words.push(word);
	const [name, ...args] = words;
	if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) return false;
	if (["node", "npm", "python", "python3"].includes(name)) {
		const versionFlag = name === "python" || name === "python3" ? "-V" : "-v";
		return args.length === 1 && ["--version", versionFlag, "--help", "-h"].includes(args[0]!);
	}
	if (name === "git") {
		if (args[0] === "--no-pager") args.shift();
		const sub = args.shift() ?? "";
		return Object.hasOwn(GIT_OPTIONS, sub) && readOnlyArgs(args, GIT_OPTIONS[sub]!);
	}
	if (name === "jq") {
		if (args[0] === "-r" || args[0] === "-c") args.shift();
		return (
			args.length > 0 &&
			/^\.(?:[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*|\[\d*\])*)?$/.test(args[0]!) &&
			args.slice(1).every((a) => !a.startsWith("-"))
		);
	}
	if (name === "find") {
		let i = 0;
		while (i < args.length && !args[i]!.startsWith("-")) i++;
		while (i < args.length) {
			const arg = args[i++]!;
			if (["-print", "-print0", "-a", "-o"].includes(arg)) continue;
			if (!["-name", "-iname", "-path", "-type", "-maxdepth", "-mindepth", "-newer", "-mtime", "-size"].includes(arg))
				return false;
			if (args[i] === undefined || args[i++]!.startsWith("-")) return false;
		}
		return true;
	}
	return Object.hasOwn(READ_ONLY_OPTIONS, name) && readOnlyArgs(args, READ_ONLY_OPTIONS[name]!);
}

export function bashCommandIsReadOnly(cmd: string): boolean {
	const text = (cmd ?? "").trim();
	if (!bashCommandHasSupportedSyntax(text)) return false;
	return splitShellSegments(text).every(segmentIsReadOnly);
}

export function bashCommandHasSupportedSyntax(cmd: string): boolean {
	const text = (cmd ?? "").trim();
	if (!text || UNSUPPORTED_SHELL.test(text)) return false;
	const segments = splitShellSegments(text);
	return segments.length > 0 && segments.every((segment) => segment.length > 0);
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

export function restrictTerminalToolToReadOnly<T extends { parameters: unknown }>(tool: T): T {
	const parameters = tool.parameters as Record<string, any>;
	return {
		...tool,
		parameters: {
			...parameters,
			properties: {
				...parameters.properties,
				action: { type: "string", enum: ["list", "read", "wait"] },
			},
		},
	};
}

const terminalSchemas = new WeakMap<object, unknown>();
export function syncTerminalReadOnlySchema(session: { _toolRegistry?: Map<string, any> }, readOnly: boolean): void {
	const tool = session._toolRegistry?.get("terminal");
	if (!tool) return;
	if (!terminalSchemas.has(tool)) terminalSchemas.set(tool, tool.parameters);
	const parameters = terminalSchemas.get(tool);
	tool.parameters = readOnly ? restrictTerminalToolToReadOnly({ parameters }).parameters : parameters;
}

export function readOnlyToolCallAllowed(name: string, params: unknown): boolean {
	const p = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
	if (name === "terminal") return ["list", "read", "wait"].includes(String(p.action ?? ""));
	if (
		[
			"read",
			"grep",
			"find",
			"ls",
			"obs_recall",
			"present_files",
			"conversation_read",
			"terminal_read",
			"terminal_list",
			"terminal_wait",
			"load_tools",
			"tool_search",
			"compact_context",
			"ask_user_question",
			"browser_search",
		].includes(name)
	)
		return true;
	const action = typeof p.action === "string" ? p.action : "";
	if (name === "skill") return !action || ["read", "list", "report"].includes(action);
	if (name === "scm") return !action || ["status", "diff", "log", "history", "branches", "show"].includes(action);
	if (isConversationTool(name)) return isReadOnlyConversationAction(action);
	if (name === "claim_files") return !action || action === "list";
	if (name === "notes") return p.op === "list";
	if (name === "remote_term") return action === "list";
	if (name === "canvas") return ["list", "get", "get_log", "card_list"].includes(action);
	if (name === "worktree") return action === "list";
	if (name === "lsp")
		return [
			"definition",
			"references",
			"hover",
			"diagnostics",
			"documentSymbol",
			"workspaceSymbol",
			"read_symbol",
			"cascade",
		].includes(action);
	if (name === "browser_page") return ["pages", "read", "shot"].includes(String(p.op));
	return false;
}

export interface PlanModeDenial {
	reason: string;
	reasonEn: string;
	kind: "write-tool" | "bash" | "bypass-tool";
}

export function planModeDenial(toolName: string, params: unknown): PlanModeDenial | undefined {
	const name = (toolName ?? "").trim();
	if (isConversationTool(name)) {
		const action =
			typeof params === "object" && params !== null ? (params as Record<string, unknown>).action : undefined;
		const act = typeof action === "string" ? action.trim().toLowerCase() : "";
		if (!isReadOnlyConversationAction(act)) {
			return {
				kind: "bypass-tool",
				reason: `计划模式：不能调用 subagent(action="${act || "spawn"}")（它会在别的会话里执行，绕过本会话的只读约束）。请在本对话内用只读工具完成调研。`,
				reasonEn: `Plan mode: subagent(action="${act || "spawn"}") is unavailable (it runs outside this conversation and would bypass the read-only constraint). Research with read-only tools here.`,
			};
		}
	}
	if (TERMINAL_WRITE_TOOLS.has(name)) {
		return {
			kind: "write-tool",
			reason: `计划模式：不能调用 ${name}（终端输入/按键会绕过只读命令白名单，见 #436）。调研请用 bash 跑只读命令；观察已有终端用 terminal_read/terminal_list/terminal_wait。`,
			reasonEn: `Plan mode: ${name} is unavailable (terminal input/keys would bypass the read-only command allowlist). Run read-only commands via bash; observe existing terminals with terminal_read/terminal_list/terminal_wait.`,
		};
	}
	if (BYPASS_TOOLS.has(name)) {
		return {
			kind: "bypass-tool",
			reason: `计划模式：不能调用 ${name}（它会在别的会话里执行，绕过本会话的只读约束）。请在本对话内用只读工具完成调研。`,
			reasonEn: `Plan mode: ${name} is unavailable (it runs outside this conversation and would bypass the read-only constraint). Research with read-only tools here.`,
		};
	}
	if (BASH_TOOLS.has(name)) {
		const cmd = commandOf(params);
		if (cmd.trim() === "") {
			return {
				kind: "bash",
				reason: "计划模式：终端命令不可用。请用 read/grep/只读 git 完成调研。",
				reasonEn: "Plan mode: shell commands are unavailable. Use read/grep and read-only git instead.",
			};
		}
		if (bashCommandIsReadOnly(cmd)) return undefined;
		return {
			kind: "bash",
			reason: `计划模式：只允许只读命令，命令被拒：\`${cmd.slice(0, 200)}\`。请改用 read/grep/git status|diff|log 等只读手段；需要做的改动写进计划，等用户确认后实施。`,
			reasonEn: `Plan mode: only read-only commands are allowed; rejected: \`${cmd.slice(0, 200)}\`. Use read/grep or read-only git (status/diff/log). Put proposed changes in the plan and wait for the user's go-ahead.`,
		};
	}
	if (BLOCKED_TOOLS.has(name) || (name !== "plan_update" && !readOnlyToolCallAllowed(name, params))) {
		return {
			kind: "write-tool",
			reason: `计划模式：只规划不实施，${name} 被拒。请把这一步写进计划（plan_update 步骤 + 计划正文），等用户确认后在新一轮里实施。`,
			reasonEn: `Plan mode: planning only, no implementation — ${name} was rejected. Record it as a plan step (plan_update) and wait for the user to approve before implementing.`,
		};
	}
	return undefined;
}

export const PLAN_MODE_SYSTEM_PROMPT = [
	"# Plan mode (planning only — do NOT implement)",
	"The user turned on plan mode for this conversation. Your job in this mode is to produce a concrete, executable plan — never to make the changes.",
	"## Hard rules",
	"- Read-only research only: read, grep/rg, ls, and read-only bash (git status/diff/log/show, cat, wc, head, tail, jq). Anything that writes is blocked by the server and the rejection comes back as a tool error.",
	"- Do not create, edit, move or delete files, do not run installs, builds, tests that write artifacts, and do not spawn subagents or start goal mode (those run outside this conversation).",
	"## Output shape (this is the part that matters most)",
	'- NEVER write the implementation. No full file bodies, no complete functions, no "here is the finished code", no working version of anything — it cannot be applied from this conversation and it wastes the user\'s tokens.',
	"- Describe the work instead: which files to create or change, the structure (modules / functions / state), the key decisions and their reasons, the risks and unknowns, how it is verified, and the first concrete step.",
	"- Code is allowed only as short illustrative snippets (about 20 lines each, at most two per plan) for genuinely tricky parts — a non-obvious algorithm or an API signature. No file dumps.",
	"- Keep the whole plan short: a screen or two. Depth beats length; if a decision is still open, list it as a question instead of exploring it in prose.",
	"## Plan board",
	'- For work with 3+ steps or real unknowns, call plan_update early with decision-ready steps (all status "pending") and refine it as you learn more.',
	'- For a small, unambiguous, greenfield request (e.g. "write a single-page snake game", "add a settings toggle", "rename this helper"), skip plan_update entirely and answer with the short plan: files to touch, structure, acceptance checks, first step.',
	"## Finishing",
	"- End with the plan and stop. Ask the user to confirm; implementation happens in the next turn after they turn plan mode off (or press the plan board's start-implementing action).",
	"- If the request is too ambiguous to plan, ask 1-3 targeted questions instead of guessing.",
].join("\n");

export function buildPlanModePrompt(mode: "append" | "replace", custom: string): string {
	const text = custom?.trim() ?? "";
	if (mode === "replace" && text) return text;
	if (text) return `${PLAN_MODE_SYSTEM_PROMPT}\n\n${text}`;
	return PLAN_MODE_SYSTEM_PROMPT;
}

export function planModeNoticeText(enabled: boolean): { text: string; textEn: string } {
	return enabled
		? {
				text: "📋 计划模式：只调研与出计划，不实施（写操作会被服务端拒绝）",
				textEn: "📋 Plan mode on: research and plan only — writes are blocked by the server",
			}
		: {
				text: "计划模式已关闭：恢复正常对话",
				textEn: "Plan mode off: back to normal",
			};
}
