import { Type } from "typebox";

export const BASH_DESCRIPTION = "Run shell command. Do not pipe to head/tail/more/less; use head/tail params instead.";

export const BASH_PROMPT_SNIPPET = "run shell commands";

export const BASH_PROMPT_GUIDELINES = [
	"For interactive commands (REPLs, y/n prompts) set persist=true and drive them with terminal(action='input'/'key')",
	"Use the dedicated worktree tool instead of running 'git worktree' in bash to prevent unsynchronized workspace state",
	"timeout defaults to 120s: pass a larger value for long builds instead of retrying a killed command",
];

export const BASH_PARAMETERS = Type.Object({
	command: Type.String(),
	timeout: Type.Optional(Type.Number({ description: "Seconds, default 120" })),
	persist: Type.Optional(
		Type.Boolean({
			description: "Retain shell state (cd/venv/ssh) in ai-bash terminal",
		}),
	),
	head: Type.Optional(Type.Integer()),
	tail: Type.Optional(Type.Integer()),
});

export const EDIT_DESCRIPTION = "Replace unique oldText with newText in a file. Non-overlapping edits only.";

export const EDIT_PROMPT_SNIPPET = "Replace exact text in one file; soft=true ignores indentation drift";

export const EDIT_PROMPT_GUIDELINES = [
	"oldText must match the file exactly; if a call fails with 'Could not find the text', retry the same edits with soft=true (whole-line match, leading indentation ignored)",
	"Merge changes to several locations of one file into a single call's edits[] instead of several calls",
	"Each oldText matches the original file, never earlier edits in the same call; never overlap or nest them",
	"Keep oldText minimal but unique; do not pad it with large unchanged regions",
];

export const EDIT_PARAMETERS = Type.Object({
	path: Type.String(),
	edits: Type.Array(
		Type.Object({
			oldText: Type.String(),
			newText: Type.String(),
		}),
	),
	soft: Type.Optional(
		Type.Boolean({
			description: "Ignore leading whitespace/indentation per line",
		}),
	),
});

// 以下三件写在这里而不是 SDK 里：模型看的是一份紧凑文案，字段本身自解释。
// 字段名必须与 SDK 内置定义一致 —— `tests/unit/tool-schema-slim.test.ts` 会比对，SDK 增删参数时直接红。

export const WRITE_DESCRIPTION = "Write or overwrite file content (auto-creates parent dirs).";

export const WRITE_PARAMETERS = Type.Object({
	path: Type.String(),
	content: Type.String(),
});

export const GREP_DESCRIPTION = "Search file contents by regex or literal (respects .gitignore, max 100 matches/50KB).";

export const GREP_PARAMETERS = Type.Object({
	pattern: Type.String(),
	path: Type.Optional(Type.String()),
	glob: Type.Optional(Type.String()),
	ignoreCase: Type.Optional(Type.Boolean()),
	literal: Type.Optional(Type.Boolean()),
	context: Type.Optional(Type.Number()),
	limit: Type.Optional(Type.Number()),
});

export const LS_DESCRIPTION =
	"List directory entries ('/' suffix for dirs, dotfiles included; truncated to 500 entries/50KB).";

export const LS_PARAMETERS = Type.Object({
	path: Type.Optional(Type.String()),
	limit: Type.Optional(Type.Number()),
});

export const POWERSHELL_DESCRIPTION =
	"Run a PowerShell command. Output is truncated to the last 2000 lines/50KB; full output goes to a temp file.";

export const POWERSHELL_PARAMETERS = Type.Object({
	command: Type.String(),
	timeout: Type.Optional(Type.Number({ description: "Seconds" })),
});

export const FIND_DESCRIPTION = "Find files by glob pattern (respects .gitignore, max 1000 results/50KB).";

export const FIND_PARAMETERS = Type.Object({
	pattern: Type.String(),
	path: Type.Optional(Type.String()),
	limit: Type.Optional(Type.Number()),
});
