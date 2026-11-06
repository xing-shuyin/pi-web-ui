import { Type } from "typebox";

export const BASH_DESCRIPTION =
	"Run a shell command and return its full output plus exit code. " +
	"When the terminal-backed bash is active (setting: default bash override) it runs in a visible terminal: " +
	"persist=true keeps the 'ai-bash' terminal alive (cd/venv/ssh retained across calls), persist=false is one-shot; " +
	"otherwise it runs natively (process spawn, no terminal) and persist has no effect. " +
	"Never pipe through head/tail/more/less — use the head/tail params (pipes hide live progress).";

export const BASH_PROMPT_SNIPPET = "run shell commands";

export const BASH_PROMPT_GUIDELINES = [
	"For interactive commands (REPLs, y/n prompts) set persist=true and drive them with terminal(action='input'/'key')",
	"Use the dedicated worktree tool instead of running 'git worktree' in bash to prevent unsynchronized workspace state",
];

export const BASH_PARAMETERS = Type.Object({
	command: Type.String({ description: "The shell command to run" }),
	timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds" })),
	persist: Type.Optional(
		Type.Boolean({
			description:
				"Ignored in native mode. With the terminal-backed bash: true = persistent 'ai-bash' terminal " +
				"(shell state retained across calls), false = one-shot terminal.",
		}),
	),
	head: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 5000,
			description: "Only return the FIRST N lines of output (like `| head -N`).",
		}),
	),
	tail: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 5000,
			description: "Only return the LAST N lines of output (like `| tail -N`).",
		}),
	),
});
