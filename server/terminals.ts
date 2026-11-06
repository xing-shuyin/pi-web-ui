import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import "./patch-node-pty.js";
import { spawn, type IPty } from "node-pty";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CommandDef, NativeCliConfig, ServerMessage, TerminalInfo } from "./protocol.js";
import {
	MAX_NATIVE_CLI_PASTE,
	resolveNativeCliLaunch,
	sanitizeNativeCliPaste,
	validateNativeCliConfig,
} from "./native-cli.js";
import type { NativeCliModelConnection } from "./native-cli-model.js";
import type { NativeCliRuntimeHooks, PreparedNativeCliSession } from "./native-cli-runtime.js";
import {
	attachPersistentRemoteNativeCli,
	openPersistentRemoteNativeCli,
	probePersistentRemoteNativeCli,
} from "./remote-cli-persistence.js";
import { resolveRemoteNativeCliLaunch } from "./remote-native-cli.js";
import { BASH_DESCRIPTION, BASH_PARAMETERS, BASH_PROMPT_GUIDELINES, BASH_PROMPT_SNIPPET } from "./tool-prompts.js";
import { pick, type ServerLang } from "./i18n.js";
import { armDelay } from "./plugin-schedule.js";
import {
	getGlobalRemoteSshService,
	isRemoteWorkspaceUri,
	parseRemoteWorkspaceUri,
	resolveWorkspaceSessionDir,
} from "./remote-ssh-service.js";

export interface CommandsFile {
	commands: CommandDef[];
}

export function commandsFilePath(workspaceRoot: string): string {
	if (isRemoteWorkspaceUri(workspaceRoot)) {
		const dataDir = process.env.PI_WEB_DATA_DIR || join(homedir(), ".pi-web");
		return join(resolveWorkspaceSessionDir(dataDir, workspaceRoot), ".pi", "commands.json");
	}
	return join(workspaceRoot, ".pi", "commands.json");
}

export function expandPwd(input: string, pwd: string): string {
	let out = input.replace(/\$\{pwd\}/g, pwd);
	if (out === "~") return homedir();
	if (out.startsWith("~/")) out = join(homedir(), out.slice(2));
	return out;
}

export function resolveCommandCwd(cwd: string | undefined, pwd: string): string {
	if (!cwd || cwd.trim() === "" || cwd.trim() === "${pwd}") return pwd;
	if (isRemoteWorkspaceUri(pwd)) return pwd;
	const expanded = expandPwd(cwd.trim(), pwd);
	return isAbsolute(expanded) ? expanded : resolve(pwd, expanded);
}

export async function loadCommands(
	workspaceRoot: string,
): Promise<{ commands: CommandDef[]; path: string; warning?: string; warningEn?: string }> {
	const path = commandsFilePath(workspaceRoot);
	const { commands, warning, warningEn } = await readCommandsFile(path);
	return { commands, path, warning, warningEn };
}

async function readCommandsFile(
	path: string,
): Promise<{ commands: CommandDef[]; warning?: string; warningEn?: string }> {
	if (!existsSync(path)) return { commands: [] };
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		return {
			commands: [],
			warning: `读取命令文件失败：${(err as Error).message}`,
			warningEn: `Failed to read commands file: ${(err as Error).message}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			commands: [],
			warning: `命令文件不是有效 JSON：${path}`,
			warningEn: `Commands file is not valid JSON: ${path}`,
		};
	}
	if (Array.isArray(parsed)) {
		return {
			commands: parsed
				.filter(
					(c): c is CommandDef =>
						typeof c === "object" &&
						c !== null &&
						typeof (c as CommandDef).name === "string" &&
						typeof (c as CommandDef).command === "string",
				)
				.map((c) => ({ name: c.name, command: c.command, cwd: c.cwd })),
		};
	}
	const obj = parsed as { commands?: unknown };
	if (obj && Array.isArray(obj.commands)) {
		return {
			commands: obj.commands
				.filter(
					(c): c is CommandDef =>
						typeof c === "object" &&
						c !== null &&
						typeof (c as CommandDef).name === "string" &&
						typeof (c as CommandDef).command === "string",
				)
				.map((c) => ({ name: c.name, command: c.command, cwd: c.cwd })),
		};
	}
	return { commands: [], warning: `命令文件格式不正确：${path}`, warningEn: `Commands file has a bad format: ${path}` };
}

export async function saveCommandsFile(
	workspaceRoot: string,
	commands: CommandDef[],
): Promise<{ path: string; error?: string; errorEn?: string }> {
	const path = commandsFilePath(workspaceRoot);
	try {
		await mkdir(join(workspaceRoot, ".pi"), { recursive: true });
		const payload: CommandsFile = { commands };
		await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
		return { path };
	} catch (err) {
		return {
			path,
			error: `保存命令文件失败：${(err as Error).message}`,
			errorEn: `Failed to save commands file: ${(err as Error).message}`,
		};
	}
}

interface TermEntry {
	id: string;
	pty: IPty;
	title: string;
	cwd: string;
	cols: number;
	rows: number;
	exited: boolean;
	exitCode: number | null;
	command?: CommandDef;
	nativeCli?: NativeCliConfig;
	nativeCliLifetime?: AbortController;
	nativeCliRun?: NativeCliRun;
	nativeCliCleanups?: Set<() => Promise<void>>;
	output: string;
	outputOffset: number;
	waiters: Set<() => void>;
	pendingOut: string;
	flushTimer: ReturnType<typeof setTimeout> | null;
	agentTouched: boolean;
	lastActivityAt: number;
	idleTimer: ReturnType<typeof setTimeout> | null;
	watches: { re: RegExp; buf: string; cb: (m: RegExpMatchArray | null) => void }[];
	sentinelPending?: boolean;
	sentinelNonce?: string;
	retired?: boolean;
	agentBash: boolean;
	used: boolean;
	locale?: string;
	agentPendingLine: string;
}

interface NativeCliRun {
	controller: AbortController;
	session?: PreparedNativeCliSession;
	stopWatch?: () => void;
	persistent?: Awaited<ReturnType<typeof openPersistentRemoteNativeCli>>;
	probeTimer?: ReturnType<typeof setTimeout>;
	stopping?: boolean;
	activityReportedAt?: number;
	processId?: string;
}

const isWindows = process.platform === "win32";
const MAX_TERMINALS = 16;
const OUTPUT_FLUSH_MS = 16;
const MAX_TERMINAL_HISTORY = 32;
const MAX_OUTPUT = 200_000;
const MAX_INPUT = 64 * 1024;
const MAX_ID = 80;

export function terminalIdleNotifyMs(): number {
	const raw = Number(process.env.PI_WEB_TERMINAL_IDLE_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : 15_000;
}

export function terminalIdleNotifyLines(): number {
	const raw = Number(process.env.PI_WEB_TERMINAL_IDLE_LINES);
	const n = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 10;
	return Math.max(1, Math.min(n, 500));
}

const SENTINEL_NONCE_SRC = "[0-9a-f]{12}";
const BASH_SENTINEL_RE = new RegExp(`\\[pi-exit-${SENTINEL_NONCE_SRC}:(\\d+)\\]`, "g");
export function newSentinelNonce(): string {
	return randomBytes(6).toString("hex");
}
function sentinelReFor(nonce: string): RegExp {
	return new RegExp(`\\[pi-exit-${nonce}:(\\d+)\\]`, "g");
}

const BASH_COLLECT_MAX = 2 * 1024 * 1024;

export function buildTerminalBashLine(
	command: string,
	tailFile?: { file: string; lines: number },
	nonce: string = newSentinelNonce(),
): string {
	const trimmed = command.replace(/\s+$/, "");
	const tailPart = tailFile
		? `; tail -n ${Math.max(1, Math.floor(tailFile.lines))} -- '${tailFile.file.replace(/'/g, `'\\''`)}'`
		: "";
	// eslint-disable-next-line no-useless-escape -- \$? must reach the shell literally
	const sentinel = `__pi_rc=$?${tailPart}; printf '\\n[pi-exit-${nonce}:%s]\\n' "$__pi_rc"`;

	if (sentinelUnsafeReason(trimmed)) return trimmed;
	const body = `eval $'${trimmed
		.replace(/\\/g, "\\\\")
		.replace(/'/g, "\\'")
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n")
		.replace(/\t/g, "\\t")}'`;
	return `${body}; ${sentinel}`;
}

export function sentinelUnsafeReason(
	command: string,
): "trailing_backslash" | "unclosed_quote" | "unclosed_group" | "unclosed_heredoc" | "unclosed_block" | null {
	const trimmed = command.replace(/\s+$/, "");
	if (trimmed.includes("\n")) return null;
	let quote: "'" | '"' | "`" | null = null;
	let ansiC = false;
	let escaped = false;
	let depth = 0;
	const parenStack: Array<"group" | "arith"> = [];
	let ifDepth = 0;
	let loopDepth = 0;
	let caseDepth = 0;
	let heredoc = false;
	let inDoubleBracket = false;
	let word = "";
	let wordCmdPos = false;
	let cmdPos = true;
	const flushWord = (): void => {
		if (!word) return;
		if (word === "[[") inDoubleBracket = true;
		else if (word === "]]") inDoubleBracket = false;
		else if (!inDoubleBracket && parenStack[parenStack.length - 1] !== "arith") {
			if (wordCmdPos) {
				if (word === "if") ifDepth++;
				else if (word === "fi") ifDepth = Math.max(0, ifDepth - 1);
				else if (word === "for" || word === "while" || word === "until" || word === "select") loopDepth++;
				else if (word === "done") loopDepth = Math.max(0, loopDepth - 1);
				else if (word === "case") caseDepth++;
				else if (word === "esac") caseDepth = Math.max(0, caseDepth - 1);
				else if (word === "then" || word === "else" || word === "elif" || word === "do") cmdPos = true;
			}
		}
		word = "";
	};
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\" && (quote !== "'" || ansiC)) {
				escaped = true;
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "#" && (i === 0 || /\s/.test(trimmed[i - 1]))) break;
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (/[A-Za-z0-9_#]/.test(ch)) {
			if (!word) {
				wordCmdPos = cmdPos;
				cmdPos = false;
			}
			word += ch;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			flushWord();
			quote = ch;
			ansiC = ch === "'" && i > 0 && trimmed[i - 1] === "$";
			continue;
		}
		if (ch === "<" && trimmed[i + 1] === "<") {
			flushWord();
			cmdPos = false;
			if (trimmed[i + 2] === "<") {
				i += 2;
			} else if (parenStack[parenStack.length - 1] !== "arith" && !inDoubleBracket) {
				heredoc = true;
				break;
			} else {
				i += 1;
			}
			continue;
		}
		if (ch === "(") {
			flushWord();
			cmdPos = true;
			if (trimmed[i + 1] === "(") {
				parenStack.push("arith");
				i += 1;
			} else {
				parenStack.push("group");
			}
			continue;
		}
		if (ch === ")") {
			flushWord();
			const top = parenStack[parenStack.length - 1];
			if (top === "arith" && trimmed[i + 1] === ")") {
				parenStack.pop();
				i += 1;
			} else if (top === "group") {
				parenStack.pop();
			}
			cmdPos = true;
			continue;
		}
		if (ch === "[" && trimmed[i + 1] === "[") {
			flushWord();
			inDoubleBracket = true;
			i += 1;
			continue;
		}
		if (ch === "]" && trimmed[i + 1] === "]" && inDoubleBracket) {
			flushWord();
			inDoubleBracket = false;
			i += 1;
			continue;
		}
		if (ch === "{") {
			flushWord();
			depth++;
			cmdPos = true;
			continue;
		}
		if (ch === "}") {
			flushWord();
			depth = Math.max(0, depth - 1);
			cmdPos = true;
			continue;
		}
		flushWord();
		if (ch === ";" || ch === "|" || ch === "&" || ch === "!") cmdPos = true;
		else if (ch !== "$" && !/\s/.test(ch)) cmdPos = false;
	}
	flushWord();
	if (quote !== null) return "unclosed_quote";
	if (escaped) return "trailing_backslash";
	if (heredoc) return "unclosed_heredoc";
	if (ifDepth > 0 || loopDepth > 0 || caseDepth > 0) return "unclosed_block";
	if (depth > 0) return "unclosed_group";
	if (parenStack.length > 0) return "unclosed_group";
	return null;
}

export function splitTopLevelPipes(cmd: string): string[] {
	return scanTopLevel(cmd).parts;
}

function scanTopLevel(cmd: string): { parts: string[]; openGroups: number } {
	const parts: string[] = [];
	let cur = "";
	let quote: "'" | '"' | "`" | null = null;
	let ansiC = false;
	let depth = 0;
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		if (quote) {
			cur += ch;
			if (ch === "\\" && quote !== "`" && (quote !== "'" || ansiC) && i + 1 < cmd.length) cur += cmd[++i];
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === "#" && (i === 0 || /\s/.test(cmd[i - 1]))) {
			cur += cmd.slice(i);
			break;
		}
		if (ch === "\\" && i + 1 < cmd.length) {
			cur += ch + cmd[++i];
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			ansiC = ch === "'" && i > 0 && cmd[i - 1] === "$";
			cur += ch;
			continue;
		}
		if (ch === "(" || ch === "{") depth++;
		else if ((ch === ")" || ch === "}") && depth > 0) depth--;
		if (ch === "|" && cmd[i + 1] === "|") {
			cur += "||";
			i++;
			continue;
		}
		if (ch === "|" && depth === 0) {
			parts.push(cur.trimEnd());
			cur = "";
			continue;
		}
		cur += ch;
	}
	parts.push(cur.trimEnd());
	return { parts, openGroups: depth };
}

type LimiterKind = "tail" | "less" | "more" | "cat";

function parseTailLines(rest: string): number | null {
	const m = rest.match(/--lines(?:=|\s+)(\d+)|-n\s*(\d+)|(?:^|\s)-(\d+)/);
	if (!m) return null;
	return Number(m[1] ?? m[2] ?? m[3]);
}

export function detectTrailingLimiter(
	command: string,
): { base: string; kind: LimiterKind; lines: number | null; segment: string } | null {
	if (/\$\(|`/.test(command)) return null;
	const { parts, openGroups } = scanTopLevel(command);
	if (parts.length < 2 || openGroups > 0) return null;
	const last = parts[parts.length - 1].trim();
	const m = last.match(/^(tail|less|more|cat)\b(.*)$/i);
	if (!m) return null;
	const kind = m[1].toLowerCase() as LimiterKind;
	const rest = m[2].trim();
	if (kind === "tail") {
		if (/(?:^|\s)(?:-f|--follow(?:=|\b))/.test(rest)) return null;
		const lines = parseTailLines(rest) ?? 10;
		return {
			base: parts
				.slice(0, -1)
				.map((s) => s.trim())
				.join(" | "),
			kind,
			lines,
			segment: last,
		};
	}
	return {
		base: parts
			.slice(0, -1)
			.map((s) => s.trim())
			.join(" | "),
		kind,
		lines: null,
		segment: last,
	};
}

export function detectStdoutRedirect(command: string): { file: string } | null {
	const all = [...command.matchAll(/(?:^|[\s;&|])(>>|>)\s*([^\s;|&]+)/g)];
	for (let i = all.length - 1; i >= 0; i--) {
		const file = all[i][2];
		if (/^(?:&[0-9]+|[0-9]+)$/.test(file) || file === "/dev/null" || /["'`]/.test(file)) return null;
		return { file };
	}
	return null;
}

export interface TerminalQuery {
	head?: number;
	tail?: number;
	search?: string;
	context?: number;
}

export function queryTerminalOutput(
	output: string,
	q: TerminalQuery,
	running = false,
	exitCode: number | null = null,
): { text: string; running: boolean; exitCode: number | null; matches?: { line: number; text: string }[] } {
	const lines = stripAnsi(output)
		.replace(/\r(?!\n)/g, "")
		.split("\n")
		.filter((l) => {
			const t = l.trim();
			return (
				!/^\[pi-exit:\d+\]$/.test(t) &&
				!/^\[pi-term-exit:-?\d+\]$/.test(t) &&
				!t.startsWith("[进程已退出") &&
				!t.startsWith("[Process exited") &&
				!/^\[.*(已退出|exited)/.test(t)
			);
		});
	while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
	const numbered = (arr: string[], start: number): string => arr.map((l, i) => `${start + i + 1}: ${l}`).join("\n");
	if (q.search) {
		const ctx = Math.max(0, q.context ?? 3);
		const needle = q.search.toLowerCase();
		const matches: { line: number; text: string }[] = [];
		const out: string[] = [];
		let i = 0;
		while (i < lines.length) {
			if (lines[i].toLowerCase().includes(needle)) {
				matches.push({ line: i + 1, text: lines[i] });
				const s = Math.max(0, i - ctx);
				const e = Math.min(lines.length - 1, i + ctx);
				out.push(`── 匹配行 ${i + 1} ──`);
				for (let j = s; j <= e; j++) out.push(`${j + 1}: ${lines[j]}`);
				out.push("");
				i = e + 1;
			} else {
				i++;
			}
		}
		return {
			text: out.join("\n").trim() || "（无匹配）",
			running,
			exitCode,
			matches: matches.length ? matches : undefined,
		};
	}
	if (q.head !== undefined && q.head >= 0) {
		const arr = lines.slice(0, q.head);
		return { text: numbered(arr, 0), running, exitCode };
	}
	if (q.tail !== undefined && q.tail >= 0) {
		const n = Math.max(1, q.tail);
		const arr = lines.slice(-n);
		return { text: numbered(arr, lines.length - arr.length), running, exitCode };
	}
	return { text: numbered(lines, 0), running, exitCode };
}

export function stripAnsi(s: string): string {
	return s
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[@-_]/g, "")
		.replace(/\r(?!\n)/g, "");
}

function truncateMiddle(text: string, max = 30_000): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.3);
	const tail = max - head;
	return `${text.slice(0, head)}\n…（中间省略 ${text.length - max} 字符）…\n${text.slice(-tail)}`;
}

function bashArgs(shell: string): string[] {
	return /[\\/]bash(\.exe)?$/i.test(shell) ? ["-i"] : [];
}

function resolveShell(): { shell: string; args: string[] } {
	if (isWindows) {
		const explicit = process.env.PI_WEB_SHELL;
		if (explicit) return { shell: explicit, args: bashArgs(explicit) };
		const she = process.env.SHELL;
		if (she && existsSync(she)) return { shell: she, args: bashArgs(she) };
		const pf = process.env.ProgramFiles;
		const pf86 = process.env["ProgramFiles(x86)"];
		for (const cand of [
			pf ? join(pf, "Git", "bin", "bash.exe") : "",
			pf86 ? join(pf86, "Git", "bin", "bash.exe") : "",
		]) {
			if (cand && existsSync(cand)) return { shell: cand, args: ["-i"] };
		}
		const busybox = join(homedir(), ".pi-web", "bin", "bash.exe");
		if (existsSync(busybox)) return { shell: busybox, args: ["-i"] };
		return { shell: process.env.COMSPEC || "powershell.exe", args: [] };
	}
	return { shell: process.env.SHELL || "bash", args: ["-i"] };
}

function resolveBashShell(): { shell: string; args: string[] } {
	if (isWindows) {
		const explicit = process.env.PI_WEB_SHELL;
		if (explicit && existsSync(explicit)) return { shell: explicit, args: ["-i"] };
		const she = process.env.SHELL;
		if (she && existsSync(she) && she.toLowerCase().includes("bash")) return { shell: she, args: ["-i"] };
		const pf = process.env.ProgramFiles;
		const pf86 = process.env["ProgramFiles(x86)"];
		for (const cand of [
			pf ? join(pf, "Git", "bin", "bash.exe") : "",
			pf86 ? join(pf86, "Git", "bin", "bash.exe") : "",
		]) {
			if (cand && existsSync(cand)) return { shell: cand, args: ["-i"] };
		}
		const busybox = join(homedir(), ".pi-web", "bin", "bash.exe");
		if (existsSync(busybox)) return { shell: busybox, args: ["-i"] };
	}
	const she = process.env.SHELL;
	if (she && (she.endsWith("bash") || she.endsWith("bash.exe")) && existsSync(she)) {
		return { shell: she, args: ["-i"] };
	}
	return { shell: "bash", args: ["-i"] };
}

function shellEnv(): Record<string, string> {
	const env: Record<string, string> = {
		...process.env,
		TERM: "xterm-256color",
	};
	if (!env.LANG && !env.LC_ALL) env.LANG = "en_US.UTF-8";
	return env;
}

const originalWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
	if (args[0] === "Unexpected ConoutWorkerMessage") return;
	originalWarn(...args);
};

const require = createRequire(import.meta.url);

function spawnHelperPaths(): string[] {
	try {
		const pkgDir = dirname(dirname(require.resolve("node-pty")));
		const out: string[] = [];
		const built = join(pkgDir, "build", "Release", "spawn-helper");
		if (existsSync(built)) out.push(built);
		const prebuildsDir = join(pkgDir, "prebuilds");
		if (existsSync(prebuildsDir)) {
			for (const entry of readdirSync(prebuildsDir)) {
				const p = join(prebuildsDir, entry, "spawn-helper");
				if (existsSync(p)) out.push(p);
			}
		}
		return out;
	} catch {
		return [];
	}
}

function repairSpawnHelperPermissions(): void {
	if (isWindows) return;
	for (const p of spawnHelperPaths()) {
		try {
			if ((statSync(p).mode & 0o111) === 0) chmodSync(p, 0o755);
		} catch {}
	}
}
repairSpawnHelperPermissions();

function brokenSpawnHelper(): string {
	if (isWindows) return "";
	for (const p of spawnHelperPaths()) {
		try {
			if ((statSync(p).mode & 0o111) === 0) return p;
		} catch {}
	}
	return "";
}

const TCC_HINT =
	[
		"\x1b[33m[提示] 本终端由后台服务（launchd）启动，macOS 隐私权限（相机/麦克风/屏幕录制等）对此类进程不可用。\x1b[0m",
		"\x1b[90m  · 需要隐私权限的命令会被系统静默拒绝：不弹授权窗，系统设置里也无法勾选，表现多为卡死或无输出。",
		"  · 这类任务请在你自己已授权的前台终端里运行。",
		"  · 本终端内可运行不需要隐私权限的命令（如文件处理、网络请求、远程设备流）。",
		"  · 若改在前台终端里运行 pi-web-ui，本提示即不再出现。\x1b[0m",
	].join("\r\n") + "\r\n";

function launchdSpawnedOnMac(): boolean {
	return process.platform === "darwin" && process.ppid === 1;
}

export type TerminalKeyEncoding = { data: string } | { error: string };

export function encodeTerminalKey(
	key: string,
	modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
): TerminalKeyEncoding {
	const named: Record<string, string> = {
		Enter: "\r",
		Return: "\r",
		Tab: "\t",
		Backspace: "\x7f",
		Escape: "\x1b",
		Up: "\x1b[A",
		ArrowUp: "\x1b[A",
		Down: "\x1b[B",
		ArrowDown: "\x1b[B",
		Left: "\x1b[D",
		ArrowLeft: "\x1b[D",
		Right: "\x1b[C",
		ArrowRight: "\x1b[C",
		Home: "\x1b[H",
		End: "\x1b[F",
		Delete: "\x1b[3~",
		Insert: "\x1b[2~",
		PageUp: "\x1b[5~",
		PageDown: "\x1b[6~",
		F1: "\x1bOP",
		F2: "\x1bOQ",
		F3: "\x1bOR",
		F4: "\x1bOS",
	};
	let data = named[key] ?? (key.length === 1 ? key : "");
	if (!data) return { error: `不支持的终端按键：${key}` };
	const modifier = 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
	const arrow = /^\x1b\[([A-DHF])$/.exec(data);
	const functionKey = /^\x1bO([P-S])$/.exec(data);
	const namedCode: Record<string, number> = {
		Enter: 13,
		Return: 13,
		Tab: 9,
		Backspace: 127,
		Escape: 27,
		Insert: 2,
		Delete: 3,
		Home: 1,
		End: 4,
		PageUp: 5,
		PageDown: 6,
	};
	if (arrow && modifier !== 1) {
		data = `\x1b[1;${modifier}${arrow[1]}`;
	} else if (functionKey && modifier !== 1) {
		data = `\x1b[1;${modifier}${functionKey[1]}`;
	} else if (namedCode[key] !== undefined && modifier !== 1) {
		data = `\x1b[${namedCode[key]};${modifier}u`;
	} else {
		if (modifiers.ctrl) {
			if (key.length !== 1) return { error: `Ctrl 组合键无效：${key}` };
			const code = key.toUpperCase().charCodeAt(0);
			if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
			else return { error: `Ctrl 组合键无效：${key}` };
		} else if (modifiers.shift && key.length === 1) {
			data = key.toUpperCase();
		}
		if (modifiers.alt) data = "\x1b" + data;
	}
	return { data };
}

export interface TerminalLineStreamParseResult {
	completedLines: string[];
	remainingPending: string;
}

export function parseTerminalLineStream(previousPending: string, inputChunk: string): TerminalLineStreamParseResult {
	const completedLines: string[] = [];
	let current = previousPending;
	let i = 0;
	while (i < inputChunk.length) {
		const ch = inputChunk[i];
		if (ch === "\r" || ch === "\n") {
			completedLines.push(current);
			current = "";
			if (ch === "\r" && i + 1 < inputChunk.length && inputChunk[i + 1] === "\n") {
				i++;
			}
		} else if (ch === "\x03" || ch === "\x15") {
			current = "";
		} else if (ch === "\x7f" || ch === "\x08") {
			if (current.length > 0) {
				current = current.slice(0, -1);
			}
		} else {
			current += ch;
		}
		i++;
	}
	return {
		completedLines,
		remainingPending: current,
	};
}

export const TERMINAL_QUERY_RESPONSE_RE =
	/^(?:\x1b\[(?:\??|>|<)?\d*(?:;\d+)*(?:\$?y|[cRnIOt])|\x1b\]\d+;[^\x07\x1b]*(?:\x07|\x1b\\))+$/;

export function isTerminalQueryResponse(data: string): boolean {
	return TERMINAL_QUERY_RESPONSE_RE.test(data);
}

export class TerminalManager {
	private terms = new Map<string, TermEntry>();
	private history = new Map<string, TermEntry>();
	private pendingNativeCli = new Map<string, { controller: AbortController; task: Promise<TerminalInfo | null> }>();
	private nativeCliRuns = new Map<string, NativeCliRun>();
	private nativeCliStops = new Map<string, Promise<void>>();
	nativeCliRuntime?: NativeCliRuntimeHooks;
	private seq = 0;
	private tccHintShown = false;

	onAgentIdle: ((terminalId: string, idleMs: number, title: string, lastLines: string) => void) | null = null;

	getAgentPendingLine(id: string): string {
		return this.terms.get(id)?.agentPendingLine ?? "";
	}

	setAgentPendingLine(id: string, line: string): void {
		const entry = this.terms.get(id);
		if (entry) entry.agentPendingLine = line;
	}

	clearAgentPendingLine(id: string): void {
		const entry = this.terms.get(id);
		if (entry) entry.agentPendingLine = "";
	}

	private emit: (msg: ServerMessage) => void;

	constructor(
		emit: (msg: ServerMessage) => void,
		private readonly rootSource: string | (() => string),
		private readonly lang?: () => ServerLang,
		readonly ownerKind: "client" | "conversation" = "conversation",
		private readonly resolveNativeCliModel?: (config: NativeCliConfig) => Promise<NativeCliModelConnection | undefined>,
	) {
		this.emit = this.ownedEmit(emit);
	}

	private get workspaceRoot(): string {
		return typeof this.rootSource === "function" ? this.rootSource() : this.rootSource;
	}

	private ownedEmit(emit: (msg: ServerMessage) => void): (msg: ServerMessage) => void {
		return (msg) => {
			if (msg.type === "terminal_output" || msg.type === "terminal_exit") {
				emit({ ...msg, ownerKind: this.ownerKind });
			} else emit(msg);
		};
	}

	rebindEmit(emit: (msg: ServerMessage) => void): void {
		this.emit = this.ownedEmit(emit);
	}

	attach(id: string, cols: number, rows: number): boolean {
		const entry = this.find(id);
		if (!entry) return false;
		this.resize(id, cols, rows);
		this.flushPending(entry);
		this.emit({ type: "terminal_output", terminalId: id, data: entry.output, reset: true });
		return true;
	}

	async createNativeCli(...args: Parameters<TerminalManager["create"]>): Promise<TerminalInfo | null> {
		const [id, cwd, cols, rows, fallbackCwd, title, opts] = args;
		const remote = isRemoteWorkspaceUri(cwd || fallbackCwd) || isRemoteWorkspaceUri(this.workspaceRoot);
		const needsAuth =
			opts?.nativeCli?.model &&
			this.resolveNativeCliModel &&
			(opts.nativeCli.preset === "claude" || opts.nativeCli.preset === "codex");
		if (!opts?.nativeCli || (!remote && !needsAuth && !this.nativeCliRuntime)) return this.create(...args);
		if (this.nativeCliStops.has(id)) {
			this.emit({ type: "notice", level: "warning", text: "CLI is stopping; reconnect after the stop completes" });
			return null;
		}
		if (this.terms.has(id)) return this.info(this.terms.get(id)!);
		const existing = this.pendingNativeCli.get(id);
		if (existing) return existing.task;
		const valid = this.validateId(id);
		if (valid) {
			this.fail(id, valid.text, valid.textEn);
			return null;
		}
		if (!this.ensureSpawnAllowed(id)) return null;
		const root = this.workspaceRoot;
		const pending = { controller: new AbortController(), task: Promise.resolve<TerminalInfo | null>(null) };
		this.pendingNativeCli.set(id, pending);
		const startupTimer = remote
			? setTimeout(() => {
					if (this.pendingNativeCli.get(id) !== pending) return;
					pending.controller.abort();
					this.nativeCliRuntime?.onStatus(id, {
						phase: "error",
						error: "Remote CLI startup timed out",
						updatedAt: Date.now(),
					});
				}, 90_000)
			: void 0;
		startupTimer?.unref?.();
		this.nativeCliRuntime?.onStatus(id, { phase: "starting", updatedAt: Date.now() });
		pending.task = (async () => {
			let prepared: PreparedNativeCliSession | undefined;
			let run: NativeCliRun | undefined;
			let adopted = false;
			try {
				const config = validateNativeCliConfig(opts.nativeCli);
				if (config.keepAlive && !remote) throw new Error("CLI keep-alive requires an SSH workspace");
				const safeCwd = this.safeCwd(cwd || fallbackCwd);
				if (!safeCwd) throw new Error("Terminal cwd must be inside the current workspace");
				const remoteService = remote ? getGlobalRemoteSshService() : null;
				const persistentRef = config.keepAlive ? this.nativeCliRuntime?.reference?.(id) : void 0;
				let observeOnly = false;
				if (config.keepAlive) {
					if (!remoteService || !persistentRef)
						throw new Error("Persistent CLI requires a saved session binding and SSH service");
					observeOnly = (await probePersistentRemoteNativeCli(remoteService, safeCwd, persistentRef.key)).alive;
				}
				const connection = needsAuth && !observeOnly ? await this.resolveNativeCliModel!(config) : undefined;
				if (
					this.pendingNativeCli.get(id) !== pending ||
					root !== this.workspaceRoot ||
					pending.controller.signal.aborted
				)
					return null;
				if (this.nativeCliRuntime)
					prepared = await this.nativeCliRuntime.prepare(
						id,
						config,
						safeCwd,
						pending.controller.signal,
						(event) => {
							if (
								(!pending.controller.signal.aborted && this.pendingNativeCli.get(id) === pending) ||
								(run && this.nativeCliRuns.get(id) === run && !run.stopping)
							)
								this.nativeCliRuntime?.onEvent(id, event);
						},
						observeOnly,
					);
				if (
					this.pendingNativeCli.get(id) !== pending ||
					root !== this.workspaceRoot ||
					pending.controller.signal.aborted
				)
					return null;
				run = { controller: pending.controller, session: prepared };
				const launchConfig = prepared?.config ?? config;
				const previousEntry = this.find(id);
				const previousRun = this.nativeCliRuns.get(id);
				if (!remote) {
					args[6] = {
						...opts,
						nativeCliConnection: connection,
						nativeCliLaunchConfig: launchConfig,
						nativeCliEnv: prepared?.env,
						nativeCliRun: run,
					};
					const terminal = this.create(...args);
					if (!terminal) return null;
					this.adoptNativeCliRun(id, run, previousRun);
					adopted = true;
					return terminal;
				}
				const service = remoteService;
				if (!service) throw new Error("SSH service is unavailable");
				let pty: IPty;
				if (observeOnly) {
					run.persistent = await attachPersistentRemoteNativeCli(service, safeCwd, {
						key: persistentRef!.key,
						cols,
						rows,
						signal: pending.controller.signal,
					});
					pty = run.persistent.pty;
				} else {
					const launch = await resolveRemoteNativeCliLaunch(
						service,
						launchConfig,
						safeCwd,
						connection,
						pending.controller.signal,
					);
					if (prepared?.env) launch.env = { ...launch.env, ...prepared.env };
					if (
						this.pendingNativeCli.get(id) !== pending ||
						root !== this.workspaceRoot ||
						pending.controller.signal.aborted
					)
						return null;
					if (config.keepAlive) {
						run.persistent = await openPersistentRemoteNativeCli(service, safeCwd, launch, {
							key: persistentRef!.key,
							cols,
							rows,
							signal: pending.controller.signal,
						});
						pty = run.persistent.pty;
					} else
						pty = await service.createCommandPty(safeCwd, launch, cols, rows, { signal: pending.controller.signal });
				}
				if (
					this.pendingNativeCli.get(id) !== pending ||
					root !== this.workspaceRoot ||
					pending.controller.signal.aborted ||
					!this.ensureSpawnAllowed(id)
				) {
					pty.kill();
					return null;
				}
				this.registerPty(
					id,
					pty,
					safeCwd,
					cols,
					rows,
					title || "CLI " + ++this.seq,
					void 0,
					false,
					opts.locale,
					config,
					run,
				);
				const attached = this.terms.get(id);
				if (attached && previousEntry) {
					if (run.persistent && !run.persistent.created) attached.nativeCliCleanups = previousEntry.nativeCliCleanups;
					else this.cleanupNativeCli(previousEntry);
				}
				this.history.delete(id);
				this.adoptNativeCliRun(id, run, previousRun);
				adopted = true;
				this.emitList();
				const entry = this.find(id);
				return entry ? this.info(entry) : null;
			} catch (err) {
				if (this.pendingNativeCli.get(id) === pending && !pending.controller.signal.aborted) {
					const message = `Failed to start CLI: ${(err as Error).message}`;
					this.nativeCliRuntime?.onStatus(id, { phase: "error", error: (err as Error).message, updatedAt: Date.now() });
					this.fail(id, message, message);
					this.emitList();
				}
				return null;
			} finally {
				if (startupTimer) clearTimeout(startupTimer);
				if (!adopted) {
					if (run?.persistent?.created) await run.persistent.terminate().catch(() => {});
					await prepared?.dispose().catch(() => {});
				}
				if (this.pendingNativeCli.get(id) === pending) this.pendingNativeCli.delete(id);
			}
		})();
		return pending.task;
	}

	private adoptNativeCliRun(id: string, run: NativeCliRun, previous?: NativeCliRun): void {
		if (previous && previous !== run) this.releaseNativeCliRun(id, previous);
		this.nativeCliRuns.set(id, run);
		run.processId = this.nativeCliRuntime?.onProcess?.(id, run.persistent?.created ?? true) ?? randomUUID();
		try {
			run.stopWatch = run.session?.start();
		} catch {
			this.nativeCliRuntime?.onStatus(id, { nativeEvents: false });
		}
		this.nativeCliRuntime?.onStatus(id, {
			phase: this.terms.has(id) ? "running" : run.persistent ? "disconnected" : "exited",
			updatedAt: Date.now(),
			error: void 0,
			persistent: Boolean(run.persistent),
			nativeEvents: run.session?.capabilities.events === "process" ? false : void 0,
			resumable: Boolean(run.session?.ref.nativeId && run.session.capabilities.resume !== "none"),
			...(run.session?.ref.nativeId ? { sessionId: run.session.ref.nativeId } : {}),
		});
		if (run.persistent) this.armNativeCliProbe(id, run);
	}

	private releaseNativeCliRun(id: string, run: NativeCliRun): void {
		if (run.probeTimer) clearTimeout(run.probeTimer);
		run.stopWatch?.();
		run.controller.abort();
		if (this.nativeCliRuns.get(id) === run) this.nativeCliRuns.delete(id);
		void run.session?.dispose().catch(() => {});
	}

	private armNativeCliProbe(id: string, run: NativeCliRun): void {
		if (this.nativeCliRuns.get(id) !== run || !run.persistent || run.stopping || run.probeTimer) return;
		run.probeTimer = setTimeout(async () => {
			run.probeTimer = void 0;
			try {
				const state = await run.persistent!.probe();
				if (this.nativeCliRuns.get(id) !== run || run.stopping) return;
				if (!state.alive) {
					await run.session?.flush?.().catch(() => {});
					if (this.nativeCliRuns.get(id) !== run || run.stopping) return;
					const entry = this.find(id);
					if (entry) {
						entry.retired = true;
						this.flushPending(entry);
						this.terms.delete(id);
						entry.exited = true;
						entry.exitCode = state.exitCode ?? null;
						this.history.set(id, entry);
						this.cleanupNativeCli(entry);
						try {
							entry.pty.kill();
						} catch {}
					}
					this.reportNativeCliProcessExit(id, run, state.exitCode);
					this.releaseNativeCliRun(id, run);
					this.nativeCliRuntime?.onStatus(id, {
						phase: "exited",
						exitCode: state.exitCode ?? null,
						updatedAt: Date.now(),
					});
					this.emit({ type: "terminal_exit", terminalId: id, exitCode: state.exitCode ?? null });
					this.emitList();
					return;
				}
			} catch {}
			this.armNativeCliProbe(id, run);
		}, 3000);
		run.probeTimer.unref?.();
	}

	private reportNativeCliProcessExit(id: string, run: NativeCliRun, exitCode?: number): void {
		if (exitCode !== undefined && exitCode !== 0 && !run.stopping && run.session?.capabilities.events === "process") {
			this.nativeCliRuntime?.onEvent(id, {
				type: "error",
				code: "process_exit",
				message: `CLI exited with code ${exitCode}`,
				eventId: `process:${run.processId}:exit:${exitCode}`,
			});
		}
	}

	private reportNativeCliActivity(id: string, entry: TermEntry): void {
		const run = entry.nativeCliRun;
		const now = Date.now();
		if (run && now - (run.activityReportedAt ?? 0) >= 2000) {
			run.activityReportedAt = now;
			this.nativeCliRuntime?.onStatus(id, { lastActivityAt: now });
		}
	}

	detachNativeCli(id: string): void {
		const entry = this.terms.get(id);
		const run = this.nativeCliRuns.get(id);
		if (!run?.persistent) throw new Error("This CLI does not have remote keep-alive enabled");
		if (!entry) return;
		entry.retired = true;
		entry.nativeCliLifetime?.abort();
		this.disarmIdleWatch(entry);
		this.flushPending(entry);
		this.terms.delete(id);
		entry.exited = true;
		entry.exitCode = null;
		this.history.set(id, entry);
		try {
			entry.pty.kill();
		} catch {}
		this.nativeCliRuntime?.onStatus(id, { phase: "disconnected", persistent: true, updatedAt: Date.now() });
		this.emit({ type: "terminal_exit", terminalId: id, exitCode: null });
		this.emitList();
	}

	hasPersistentNativeCli(id: string): boolean {
		return Boolean(this.nativeCliRuns.get(id)?.persistent);
	}

	async stopNativeCli(id: string): Promise<void> {
		const current = this.nativeCliStops.get(id);
		if (current) return current;
		const task = this.performNativeCliStop(id);
		this.nativeCliStops.set(id, task);
		try {
			await task;
		} finally {
			if (this.nativeCliStops.get(id) === task) this.nativeCliStops.delete(id);
		}
	}

	private async performNativeCliStop(id: string): Promise<void> {
		const pending = this.pendingNativeCli.get(id);
		pending?.controller.abort();
		if (pending) await pending.task;
		const run = this.nativeCliRuns.get(id);
		const entry = this.find(id);
		if (run) run.stopping = true;
		entry?.nativeCliLifetime?.abort();
		try {
			await run?.persistent?.terminate();
		} catch (error) {
			if (run) run.stopping = false;
			if (entry && !entry.retired) entry.nativeCliLifetime = new AbortController();
			if (run?.persistent) this.armNativeCliProbe(id, run);
			throw error;
		}
		if ((run && this.nativeCliRuns.get(id) !== run) || (entry && this.find(id) !== entry)) {
			if (entry) this.cleanupNativeCli(entry);
			if (run) this.releaseNativeCliRun(id, run);
			return;
		}
		if (entry) {
			this.retireTaskEntry(entry);
			this.terms.delete(id);
			entry.exited = true;
			entry.exitCode = null;
			this.history.set(id, entry);
			this.cleanupNativeCli(entry);
		}
		if (run) this.releaseNativeCliRun(id, run);
		this.nativeCliRuntime?.onStatus(id, { phase: "exited", exitCode: null, updatedAt: Date.now() });
		this.emit({ type: "terminal_exit", terminalId: id, exitCode: null });
		this.emitList();
	}

	create(
		id: string,
		cwd: string,
		cols: number,
		rows: number,
		fallbackCwd: string,
		title?: string,
		opts?: {
			forceBash?: boolean;
			agentBash?: boolean;
			locale?: string;
			nativeCli?: NativeCliConfig;
			nativeCliConnection?: NativeCliModelConnection;
			nativeCliLaunchConfig?: NativeCliConfig;
			nativeCliEnv?: NodeJS.ProcessEnv;
			nativeCliRun?: NativeCliRun;
		},
	): TerminalInfo | null {
		const failed = (): null => {
			if (opts?.nativeCli !== undefined) this.emitList();
			return null;
		};
		const valid = this.validateId(id);
		if (valid) {
			this.fail(id, valid.text, valid.textEn);
			return failed();
		}
		let nativeCli: NativeCliConfig | undefined;
		try {
			if (opts?.nativeCli !== undefined) nativeCli = validateNativeCliConfig(opts.nativeCli);
		} catch (err) {
			const message = (err as Error).message;
			this.fail(id, message, message);
			return failed();
		}
		if (this.terms.has(id)) return this.info(this.terms.get(id)!);
		const priorAgentBash = opts?.agentBash ?? this.history.get(id)?.agentBash ?? false;
		if (!this.ensureSpawnAllowed(id, priorAgentBash)) return failed();
		const safeCwd = this.safeCwd(cwd || fallbackCwd);
		if (!safeCwd) {
			this.fail(
				id,
				pick(
					this.lang?.() ?? "en",
					"终端工作目录必须位于当前工作区内",
					"Terminal cwd must be inside the current workspace",
					"terminals.cwd.outside.workspace",
				),
				"Terminal cwd must be inside the current workspace",
			);
			return failed();
		}
		if (
			this.spawnShell(
				id,
				safeCwd,
				cols,
				rows,
				title || `终端 ${++this.seq}`,
				undefined,
				opts?.forceBash,
				priorAgentBash,
				opts?.locale,
				nativeCli,
				opts?.nativeCliConnection,
				opts?.nativeCliLaunchConfig,
				opts?.nativeCliEnv,
				opts?.nativeCliRun,
			)
		) {
			this.history.delete(id);
			this.maybeEmitTccHint(id);
			this.emitList();
			return this.info(this.terms.get(id)!);
		}
		return failed();
	}

	private maybeEmitTccHint(id: string): void {
		if (this.tccHintShown || !launchdSpawnedOnMac()) return;
		this.tccHintShown = true;
		this.writeOut(id, TCC_HINT);
	}

	runCommand(id: string, def: CommandDef, cols: number, rows: number, pwd: string, locale?: string): void {
		const invalidId = this.validateId(id);
		if (invalidId) {
			this.fail(id, invalidId.text, invalidId.textEn);
			return;
		}
		const existing = this.terms.get(id);
		if (!existing && !this.ensureSpawnAllowed(id)) return;
		const rawDir = resolveCommandCwd(def.cwd, pwd);
		const dir = this.safeCwd(rawDir);
		const command = expandPwd(def.command.trim(), pwd);
		const title = def.name || command || `终端 ${++this.seq}`;
		if (!dir) {
			this.fail(
				id,
				pick(
					this.lang?.() ?? "en",
					"终端工作目录必须位于当前工作区内",
					"Terminal cwd must be inside the current workspace",
					"terminals.cwd.outside.workspace",
				),
				"Terminal cwd must be inside the current workspace",
			);
			return;
		}

		if (existing) {
			if (!existing.exited) {
				this.retireTaskEntry(existing);
			}
			cols = existing.cols || cols;
			rows = existing.rows || rows;
			this.terms.delete(id);
		}
		this.history.delete(id);

		const keepLocale = locale ?? existing?.locale;
		const ok = this.spawnShell(id, dir, cols, rows, title, def, undefined, false, keepLocale);
		if (!ok) return;
		this.emitList();
		const banner = "\x1b[2J\x1b[3J\x1b[H" + `\x1b[90m> ${command}\x1b[0m  \x1b[90m(${dir})\x1b[0m\r\n`;
		const fresh = this.terms.get(id);
		if (fresh) this.appendOutput(fresh, banner);
		this.writeOut(id, banner);
		this.maybeEmitTccHint(id);
		if (command) this.writeWhenReady(id, command + "\r");
	}

	private writeWhenReady(id: string, text: string, timeoutMs = 1500): void {
		const entry = this.terms.get(id);
		if (!entry || entry.exited) return;
		let sent = false;
		let disp: { dispose(): void } | undefined;
		const send = () => {
			if (sent) return;
			sent = true;
			clearTimeout(timer);
			try {
				disp?.dispose();
			} catch {}
			const live = this.terms.get(id);
			if (!live || live !== entry || live.exited) return;
			this.input(id, text);
		};
		const timer = setTimeout(send, timeoutMs);
		timer.unref?.();
		try {
			disp = entry.pty.onData(() => send());
		} catch {}
	}

	private spawnShell(
		id: string,
		cwd: string,
		cols: number,
		rows: number,
		title: string,
		command?: CommandDef,
		forceBash?: boolean,
		agentBash = false,
		locale?: string,
		nativeCli?: NativeCliConfig,
		nativeCliConnection?: NativeCliModelConnection,
		nativeCliLaunchConfig?: NativeCliConfig,
		nativeCliEnv?: NodeJS.ProcessEnv,
		nativeCliRun?: NativeCliRun,
	): boolean {
		let abs = cwd;
		let shell: string;
		let args: string[];
		const targetUri =
			cwd && cwd.startsWith("ssh://")
				? cwd
				: this.workspaceRoot && this.workspaceRoot.startsWith("ssh://")
					? this.workspaceRoot
					: null;

		if (nativeCli && targetUri) {
			this.fail(id, "远程 CLI 需要异步启动", "Remote CLI requires asynchronous startup");
			return false;
		}
		if (targetUri) {
			const match = /^ssh:\/\/([^@]+)@([^:]+):(\d+)(\/.*)$/.exec(targetUri);
			if (match) {
				const username = match[1];
				const host = match[2];
				const port = match[3];
				const remotePath = match[4];
				abs = homedir();
				shell = process.platform === "win32" ? "ssh.exe" : "ssh";
				args = ["-t", "-p", port, `${username}@${host}`, `cd "${remotePath}" && exec bash -l || exec sh`];
			} else {
				if (!abs) abs = homedir();
				else if (!isAbsolute(abs)) abs = resolve(abs);
				const s = forceBash ? resolveBashShell() : resolveShell();
				shell = s.shell;
				args = s.args;
			}
		} else {
			if (!abs) abs = homedir();
			else if (!isAbsolute(abs)) abs = resolve(abs);
			try {
				if (!existsSync(abs) || !statSync(abs).isDirectory()) {
					this.fail(id, `目录不存在或不是目录：${abs}`, `Directory does not exist or is not a directory: ${abs}`);
					return false;
				}
			} catch {
				this.fail(id, `无法访问终端目录：${abs}`, `Cannot access terminal directory: ${abs}`);
				return false;
			}
			const s = forceBash ? resolveBashShell() : resolveShell();
			shell = s.shell;
			args = s.args;
		}

		// (e.g. a global npm install replaced the helper while this server runs).
		repairSpawnHelperPermissions();
		let pty: IPty;
		let env = { ...shellEnv(), ...nativeCliEnv } as Record<string, string>;
		try {
			if (nativeCli) {
				const launch = resolveNativeCliLaunch(nativeCliLaunchConfig ?? nativeCli, {
					cwd: abs,
					env,
					modelConnection: nativeCliConnection,
				});
				if (launch.env) env = launch.env as Record<string, string>;
				shell = launch.file;
				args = launch.args;
			}
			const sshSvc = targetUri ? getGlobalRemoteSshService() : null;
			if (targetUri && sshSvc) {
				pty = sshSvc.createVirtualPty(targetUri, cols, rows);
			} else {
				pty = spawn(shell, args, {
					name: "xterm-256color",
					cols: Math.max(2, Math.floor(cols) || 80),
					rows: Math.max(2, Math.floor(rows) || 24),
					cwd: abs,
					env,
					useConptyDll: process.platform === "win32",
				});
			}
		} catch (err) {
			const helper = brokenSpawnHelper();
			this.fail(
				id,
				helper
					? `启动终端失败：${(err as Error).message}（node-pty 的 spawn-helper 缺少执行权限，请运行：chmod +x "${helper}"）`
					: `启动终端失败：${(err as Error).message}`,
				helper
					? `Failed to start terminal: ${(err as Error).message} (node-pty spawn-helper is not executable, run: chmod +x "${helper}")`
					: `Failed to start terminal: ${(err as Error).message}`,
			);
			return false;
		}
		this.registerPty(id, pty, abs, cols, rows, title, command, agentBash, locale, nativeCli, nativeCliRun);
		return true;
	}

	private registerPty(
		id: string,
		pty: IPty,
		cwd: string,
		cols: number,
		rows: number,
		title: string,
		command?: CommandDef,
		agentBash = false,
		locale?: string,
		nativeCli?: NativeCliConfig,
		nativeCliRun?: NativeCliRun,
	): void {
		const entry: TermEntry = {
			id,
			pty,
			title,
			cwd,
			cols: Math.max(2, Math.floor(cols) || 80),
			rows: Math.max(2, Math.floor(rows) || 24),
			exited: false,
			exitCode: null,
			command,
			nativeCli,
			nativeCliLifetime: nativeCli ? new AbortController() : undefined,
			nativeCliRun,
			output: "",
			outputOffset: 0,
			waiters: new Set(),
			pendingOut: "",
			flushTimer: null,
			agentTouched: false,
			lastActivityAt: Date.now(),
			idleTimer: null,
			watches: [],
			agentBash,
			used: agentBash || command !== undefined || nativeCli !== undefined,
			locale,
			agentPendingLine: "",
		};
		this.terms.set(id, entry);
		pty.onData((data) => {
			if (this.terms.get(id) !== entry || entry.retired) return;
			this.appendOutput(entry, data);
			if (entry.nativeCli) this.reportNativeCliActivity(id, entry);
			this.queueOut(entry, data);
		});
		pty.onExit(({ exitCode }) => {
			if (this.terms.get(id) !== entry || entry.retired) return;
			if (entry.nativeCliRun?.persistent) this.detachNativeCli(id);
			else this.exit(id, exitCode);
		});
	}

	noteAgentActivity(id: string): void {
		const entry = this.terms.get(id);
		if (!entry || entry.exited) return;
		entry.agentTouched = true;
		entry.used = true;
		entry.lastActivityAt = Date.now();
		this.armIdleWatch(entry);
	}

	private armIdleWatch(entry: TermEntry): void {
		if (entry.idleTimer) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = null;
		}
		const idleMs = terminalIdleNotifyMs();
		if (!entry.agentTouched || idleMs <= 0) return;
		const delay = Math.max(0, idleMs - (Date.now() - entry.lastActivityAt));
		entry.idleTimer = setTimeout(() => {
			entry.idleTimer = null;
			if (this.terms.get(entry.id) !== entry || entry.exited) return;
			entry.agentTouched = false;
			const lastLines = queryTerminalOutput(entry.output, { tail: terminalIdleNotifyLines() })?.text ?? "";
			this.onAgentIdle?.(entry.id, Date.now() - entry.lastActivityAt, entry.title, lastLines);
		}, delay);
		entry.idleTimer.unref?.();
	}

	private writeOut(id: string, data: string): void {
		this.emit({ type: "terminal_output", terminalId: id, data });
	}

	private queueOut(entry: TermEntry, data: string): void {
		entry.pendingOut += data;
		if (entry.flushTimer) return;
		entry.flushTimer = setTimeout(() => {
			entry.flushTimer = null;
			this.flushPending(entry);
		}, OUTPUT_FLUSH_MS);
	}

	private flushPending(entry: TermEntry): void {
		if (entry.flushTimer) {
			clearTimeout(entry.flushTimer);
			entry.flushTimer = null;
		}
		if (!entry.pendingOut) return;
		const pending = entry.pendingOut;
		entry.pendingOut = "";
		this.emit({ type: "terminal_output", terminalId: entry.id, data: pending });
	}

	private appendOutput(entry: TermEntry, data: string): void {
		entry.output += data;
		if (entry.output.length > MAX_OUTPUT) {
			const drop = entry.output.length - MAX_OUTPUT;
			entry.output = entry.output.slice(drop);
			entry.outputOffset += drop;
		}
		for (const wake of entry.waiters) wake();
		entry.waiters.clear();
		entry.lastActivityAt = Date.now();
		if (entry.idleTimer) this.armIdleWatch(entry);
		if (entry.watches.length > 0) {
			type Watch = (typeof entry.watches)[number];
			const remaining: Watch[] = [];
			const hits: { w: Watch; m: RegExpMatchArray }[] = [];
			for (const w of entry.watches) {
				w.buf += data;
				w.re.lastIndex = 0;
				const m = w.re.exec(w.buf);
				if (w.buf.length > 64_000) w.buf = w.buf.slice(-32_000);
				if (m) hits.push({ w, m });
				else remaining.push(w);
			}
			entry.watches = remaining;
			for (const { w, m } of hits) w.cb(m);
		}
	}

	private validateId(id: string): { text: string; textEn: string } | null {
		if (!id || id.length > MAX_ID || !/^[A-Za-z0-9._:-]+$/.test(id)) {
			return {
				text: "终端名称无效：只能使用字母、数字、.-、_ 或 :（最长 80 字符）",
				textEn: "Invalid terminal name: use letters, digits, .-_ or : (max 80 chars)",
			};
		}
		return null;
	}

	private ensureSpawnAllowed(id: string, agentBash = false): boolean {
		if (this.terms.has(id)) return true;
		if (agentBash) return true;
		const pendingUser = [...this.pendingNativeCli.keys()].filter((key) => key !== id && !this.terms.has(key)).length;
		const liveUser = [...this.terms.values()].filter((t) => !t.agentBash).length + pendingUser;
		if (liveUser >= MAX_TERMINALS) {
			this.fail(id, `终端数量已达上限（${MAX_TERMINALS}）`, `Terminal limit reached (${MAX_TERMINALS})`);
			return false;
		}
		return true;
	}

	private safeCwd(raw: string): string | null {
		if (isRemoteWorkspaceUri(this.workspaceRoot)) {
			const root = parseRemoteWorkspaceUri(this.workspaceRoot);
			if (!root) return null;
			if (isRemoteWorkspaceUri(raw)) {
				const cand = parseRemoteWorkspaceUri(raw);
				if (!cand) return null;
				if (cand.username !== root.username || cand.host !== root.host || cand.port !== root.port) return null;
				const candidatePath = posix.normalize(cand.remotePath);
				const rootPath = posix.normalize(root.remotePath).replace(/\/+$/, "") || "/";
				if (candidatePath !== rootPath && !candidatePath.startsWith(rootPath === "/" ? "/" : `${rootPath}/`))
					return null;
				return `ssh://${cand.username}@${cand.host}:${cand.port}${candidatePath}`;
			}
			const rel = String(raw).replace(/\\/g, "/").replace(/^\/+/, "");
			const joined = posix.normalize(`${root.remotePath}/${rel}`).replace(/\/+$/, "") || "/";
			const prefix = root.remotePath === "/" ? "/" : `${root.remotePath}/`;
			if (joined !== root.remotePath && !joined.startsWith(prefix)) return null;
			return `ssh://${root.username}@${root.host}:${root.port}${joined}`;
		}
		try {
			const root = realpathSync(resolve(this.workspaceRoot));
			const candidate = realpathSync(isAbsolute(raw) ? resolve(raw) : resolve(root, raw));
			const rel = relative(root, candidate);
			if (rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel))) {
				return candidate;
			}
		} catch {}
		return null;
	}

	private info(entry: TermEntry): TerminalInfo {
		return {
			id: entry.id,
			title: entry.title,
			cwd: entry.cwd,
			cols: entry.cols,
			rows: entry.rows,
			running: !entry.exited,
			exitCode: entry.exitCode,
			command: entry.command,
			nativeCli: entry.nativeCli ? validateNativeCliConfig(entry.nativeCli) : undefined,
			agentBash: entry.agentBash,
			ownerKind: this.ownerKind,
		};
	}

	has(id: string): boolean {
		return this.terms.has(id) || this.history.has(id) || this.pendingNativeCli.has(id);
	}

	private find(id: string): TermEntry | undefined {
		return this.terms.get(id) ?? this.history.get(id);
	}

	list(): TerminalInfo[] {
		return [...this.terms.values(), ...this.history.values()].map((entry) => this.info(entry));
	}

	countLive(): number {
		let n = 0;
		for (const entry of this.terms.values()) if (!entry.exited) n++;
		return n;
	}

	countBlockingLive(): number {
		let n = 0;
		for (const entry of this.terms.values()) if (!entry.exited && entry.used) n++;
		return n;
	}

	countUserBlockingLive(): number {
		let n = 0;
		for (const entry of this.terms.values()) {
			if (!entry.exited && entry.used && !entry.agentBash && !(this.ownerKind === "conversation" && entry.nativeCli))
				n++;
		}
		return n;
	}

	private emitList(): void {
		this.emit({ type: "terminal_list", terminals: this.list() });
	}

	replay(): { terminalId: string; data: string }[] {
		for (const entry of this.terms.values()) this.flushPending(entry);
		return [...this.terms.values(), ...this.history.values()]
			.filter((entry) => entry.output.length > 0)
			.map((entry) => ({ terminalId: entry.id, data: entry.output }));
	}

	read(
		id: string,
		cursor = 0,
		maxBytes = 20_000,
	): { data: string; cursor: number; running: boolean; exitCode: number | null; commandPending: boolean } | null {
		const entry = this.find(id);
		if (!entry) return null;
		const start = Math.max(entry.outputOffset, Math.min(cursor, entry.outputOffset + entry.output.length));
		const end = Math.min(start + Math.max(1, Math.floor(maxBytes) || 20_000), entry.outputOffset + entry.output.length);
		return {
			data: entry.output.slice(start - entry.outputOffset, end - entry.outputOffset),
			cursor: end,
			running: !entry.exited,
			exitCode: entry.exitCode,
			commandPending: entry.sentinelPending === true,
		};
	}

	async waitForOutput(id: string, cursor: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
		const current = this.read(id, cursor, 1);
		if (!current || current.cursor > cursor || !current.running) return;
		await new Promise<void>((resolvePromise) => {
			const entry = this.find(id);
			if (!entry) return resolvePromise();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const done = () => {
				if (timer) clearTimeout(timer);
				entry.waiters.delete(done);
				signal?.removeEventListener("abort", done);
				resolvePromise();
			};
			entry.waiters.add(done);
			timer = setTimeout(done, Math.max(0, Math.min(timeoutMs, 120_000)));
			signal?.addEventListener("abort", done, { once: true });
		});
	}

	captureNativeCliPasteTarget(id: string):
		| {
				cwd: string;
				signal: AbortSignal;
				paste: (data: string) => boolean;
				retainCleanup: (cleanup: () => Promise<void>, paths?: readonly string[]) => boolean;
		  }
		| undefined {
		const entry = this.terms.get(id);
		if (!entry?.nativeCli || entry.exited || entry.retired || entry.nativeCliRun?.stopping) return undefined;
		const lifetime = entry.nativeCliLifetime!;
		return {
			cwd: entry.cwd,
			signal: lifetime.signal,
			paste: (data) =>
				!lifetime.signal.aborted &&
				this.terms.get(id) === entry &&
				!entry.exited &&
				!entry.retired &&
				!entry.nativeCliRun?.stopping &&
				this.pasteNativeCli(id, data),
			retainCleanup: (cleanup, paths) => {
				if (
					lifetime.signal.aborted ||
					this.terms.get(id) !== entry ||
					entry.exited ||
					entry.retired ||
					entry.nativeCliRun?.stopping
				)
					return false;
				if (paths?.length) this.nativeCliRuntime?.onRetainFiles?.(id, paths);
				(entry.nativeCliCleanups ??= new Set()).add(cleanup);
				return true;
			},
		};
	}

	getNativeCliTerminal(id: string): TerminalInfo | undefined {
		const entry = this.terms.get(id);
		return entry && !entry.exited && !entry.nativeCliRun?.stopping && entry.nativeCli ? this.info(entry) : undefined;
	}

	pasteNativeCli(id: string, data: string): boolean {
		if (!this.getNativeCliTerminal(id) || typeof data !== "string") return false;
		const text = sanitizeNativeCliPaste(data);
		if (!text.trim() || text.length > MAX_NATIVE_CLI_PASTE || Buffer.byteLength(text, "utf8") > MAX_NATIVE_CLI_PASTE)
			return false;
		return this.inputChecked(id, `\x1b[200~${text}\x1b[201~`) === null;
	}

	inputChecked(id: string, data: string): string | null {
		if (data.length > MAX_INPUT) return `输入过长（上限 ${MAX_INPUT} 字符） Input too long (max ${MAX_INPUT} chars)`;
		const entry = this.terms.get(id);
		if (!entry || entry.exited)
			return pick(
				this.lang?.() ?? "en",
				"终端不存在或进程已退出",
				"Terminal not found or its process has exited",
				"terminals.not.found.exited",
			);
		if (entry.nativeCliRun?.stopping) return "CLI is stopping";
		if (entry.nativeCli && !isTerminalQueryResponse(data)) this.reportNativeCliActivity(id, entry);
		entry.lastActivityAt = Date.now();
		if (entry.idleTimer) this.armIdleWatch(entry);
		entry.pty.write(data);
		if (data.length > 0 && !isTerminalQueryResponse(data)) {
			entry.used = true;
		}
		return null;
	}

	key(id: string, key: string, modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}): string | null {
		const encoded = encodeTerminalKey(key, modifiers);
		if ("error" in encoded) return encoded.error;
		return this.inputChecked(id, encoded.data);
	}

	private disarmIdleWatch(entry: TermEntry): void {
		if (entry.idleTimer) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = null;
		}
		entry.agentTouched = false;
	}

	suspendIdleWatch(id: string): void {
		const entry = this.terms.get(id);
		if (!entry || !entry.idleTimer) return;
		clearTimeout(entry.idleTimer);
		entry.idleTimer = null;
	}

	endCursor(id: string): number | null {
		const entry = this.find(id);
		if (!entry) return null;
		return entry.outputOffset + entry.output.length;
	}

	async waitForCompletion(
		id: string,
		timeoutMs: number,
		signal?: AbortSignal,
		afterCursor = 0,
	): Promise<{ finished: boolean; exitCode: number | null }> {
		const entry = this.find(id);
		if (!entry) return { finished: false, exitCode: null };
		return new Promise((resolve) => {
			const relStart = Math.max(0, afterCursor - entry.outputOffset);
			const segment = entry.output.slice(relStart);
			const completionRe = entry.sentinelNonce ? sentinelReFor(entry.sentinelNonce) : BASH_SENTINEL_RE;
			const scan = new RegExp(completionRe.source, completionRe.flags);
			const existing = scan.exec(segment);
			if (existing) {
				resolve({ finished: true, exitCode: Number(existing[1]) });
				return;
			}
			if (entry.exited || entry.retired) {
				resolve({ finished: true, exitCode: entry.exitCode });
				return;
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			let settled = false;
			let unwatch: () => void = () => {};
			const onAbort = () => done({ finished: false, exitCode: null });
			const done = (r: { finished: boolean; exitCode: number | null }) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				unwatch();
				resolve(r);
			};
			unwatch = this.watchOutput(id, completionRe, (m) => {
				done({ finished: true, exitCode: m ? Number(m[1]) : entry.exitCode });
			});
			if (settled) return;
			timer = setTimeout(() => done({ finished: false, exitCode: null }), Math.max(1, Math.min(timeoutMs, 600_000)));
			timer.unref?.();
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
		});
	}

	setSentinelPending(id: string, pending: boolean, nonce?: string): void {
		const entry = this.find(id);
		if (!entry || (!pending && nonce !== undefined && entry.sentinelNonce !== nonce)) return;
		entry.sentinelPending = pending;
		if (pending) entry.sentinelNonce = nonce;
	}

	bashTaskState(id: string): { exited: boolean; exitCode: number | null } {
		const entry = this.find(id);
		return { exited: !entry || entry.exited || entry.retired === true, exitCode: entry?.exitCode ?? null };
	}

	isSentinelPending(id: string): boolean {
		return this.find(id)?.sentinelPending === true;
	}

	watchOutput(id: string, re: RegExp, cb: (m: RegExpMatchArray | null) => void): () => void {
		const entry = this.find(id);
		if (!entry || entry.exited || entry.retired) {
			cb(null);
			return () => {};
		}
		const own = new RegExp(re.source, re.flags);
		const watch = { re: own, buf: "", cb };
		entry.watches.push(watch);
		return () => {
			entry.watches = entry.watches.filter((w) => w !== watch);
		};
	}

	private fail(id: string, text: string, textEn?: string): void {
		this.emit({ type: "notice", level: "error", text, textEn });
		this.emit({
			type: "terminal_output",
			terminalId: id,
			data: `\x1b[91m${text}\x1b[0m\r\n`,
		});
		this.emit({ type: "terminal_exit", terminalId: id, exitCode: null });
	}

	private exit(id: string, exitCode: number): void {
		const entry = this.terms.get(id);
		if (!entry || entry.exited) return;
		this.disarmIdleWatch(entry);
		this.flushPending(entry);
		const marker = `\r\n[pi-term-exit:${exitCode}]\r\n`;
		this.appendOutput(entry, marker);
		this.emit({ type: "terminal_output", terminalId: id, data: marker });
		entry.exited = true;
		entry.exitCode = exitCode;
		this.cleanupNativeCli(entry);
		const pendingWatches = entry.watches;
		entry.watches = [];
		for (const w of pendingWatches) w.cb(null);
		this.terms.delete(id);
		this.killNative(entry);
		while (this.history.size >= MAX_TERMINAL_HISTORY) {
			const oldest = this.history.keys().next().value;
			if (typeof oldest !== "string") break;
			const oldEntry = this.history.get(oldest);
			if (oldEntry) this.killNative(oldEntry);
			this.history.delete(oldest);
		}
		this.history.set(id, entry);
		this.nativeCliRuntime?.onStatus(id, { phase: "exited", exitCode, updatedAt: Date.now() });
		const run = entry.nativeCliRun;
		if (run)
			void (async () => {
				await run.session?.flush?.().catch(() => {});
				if (this.nativeCliRuns.get(id) === run) this.reportNativeCliProcessExit(id, run, exitCode);
				this.releaseNativeCliRun(id, run);
			})();
		this.emit({ type: "terminal_exit", terminalId: id, exitCode });
		this.emitList();
	}

	input(id: string, data: string): void {
		if (data.includes("\r") || data.includes("\n") || data.includes("\x03")) {
			this.clearAgentPendingLine(id);
		}
		void this.inputChecked(id, data);
	}

	resize(id: string, cols: number, rows: number): void {
		const entry = this.terms.get(id);
		if (!entry || entry.exited) return;
		try {
			entry.pty.resize(Math.max(2, Math.floor(cols) || 80), Math.max(2, Math.floor(rows) || 24));
			entry.cols = Math.max(2, Math.floor(cols) || 80);
			entry.rows = Math.max(2, Math.floor(rows) || 24);
		} catch {}
	}

	private cleanupNativeCli(entry: TermEntry): void {
		entry.nativeCliLifetime?.abort();
		const cleanups = [...(entry.nativeCliCleanups ?? [])];
		entry.nativeCliCleanups?.clear();
		void Promise.allSettled(cleanups.map((cleanup) => Promise.resolve().then(cleanup)));
	}

	private retireTaskEntry(entry: TermEntry, shutdown = false): void {
		if (entry.retired) return;
		entry.retired = true;
		if (entry.nativeCliRun) {
			entry.nativeCliRun.stopping = true;
			if (!entry.nativeCliRun.persistent) this.releaseNativeCliRun(entry.id, entry.nativeCliRun);
		}
		this.cleanupNativeCli(entry);
		this.disarmIdleWatch(entry);
		this.flushPending(entry);
		this.killNative(entry, shutdown);
		entry.sentinelPending = false;
		const watches = entry.watches;
		entry.watches = [];
		for (const wake of entry.waiters) wake();
		entry.waiters.clear();
		for (const watch of watches) watch.cb(null);
	}

	kill(id: string): void {
		this.pendingNativeCli.get(id)?.controller.abort();
		const run = this.nativeCliRuns.get(id);
		if (run?.persistent) {
			void this.stopNativeCli(id)
				.then(() => this.kill(id))
				.catch((error) => {
					this.emit({ type: "notice", level: "error", text: `Failed to stop remote CLI: ${(error as Error).message}` });
				});
			return;
		}
		const entry = this.terms.get(id);
		if (entry) {
			this.retireTaskEntry(entry);
			this.terms.delete(id);
			this.emit({ type: "terminal_exit", terminalId: id, exitCode: null });
			this.emitList();
			return;
		}
		const histEntry = this.history.get(id);
		if (histEntry) {
			this.killNative(histEntry);
			this.history.delete(id);
			this.emitList();
			return;
		}
	}

	rename(id: string, title: string): void {
		const trimmed = (title ?? "").trim();
		if (!trimmed) return;
		const entry = this.find(id);
		if (!entry) return;
		entry.title = trimmed;
		this.emitList();
	}

	private killNative(entry: TermEntry, shutdown = false): void {
		if (isRemoteWorkspaceUri(entry.cwd)) {
			try {
				entry.pty.kill();
			} catch {}
			return;
		}
		if (process.platform === "win32") {
			if (entry.exited) {
				if (!shutdown) {
					try {
						entry.pty.kill();
					} catch {}
				}
				return;
			}
			try {
				entry.pty.write("\x03exit\r");
			} catch {}
			if (shutdown) return;
			const t = setTimeout(() => {
				if (entry.exited) return;
				try {
					entry.pty.kill();
				} catch {}
			}, 300);
			t.unref?.();
			return;
		}
		try {
			entry.pty.kill();
		} catch {}
	}

	killAll(opts?: { shutdown?: boolean }): void {
		for (const pending of this.pendingNativeCli.values()) pending.controller.abort();
		const shutdown = opts?.shutdown === true;
		for (const entry of new Set([...this.terms.values(), ...this.history.values()])) {
			const run = this.nativeCliRuns.get(entry.id);
			if (run?.persistent) {
				if (shutdown) this.releaseNativeCliRun(entry.id, run);
				else
					void this.stopNativeCli(entry.id)
						.catch((error) => {
							this.emit({
								type: "notice",
								level: "error",
								text: "Remote CLI stop could not be confirmed: " + (error as Error).message,
							});
						})
						.finally(() => this.releaseNativeCliRun(entry.id, run));
				entry.retired = true;
				entry.nativeCliLifetime?.abort();
				this.disarmIdleWatch(entry);
				this.flushPending(entry);
				this.killNative(entry, shutdown);
			} else {
				this.retireTaskEntry(entry, shutdown);
				if (run) this.releaseNativeCliRun(entry.id, run);
			}
		}
		this.terms.clear();
		this.history.clear();
		this.emitList();
	}
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function lastSentinel(collected: string, nonce: string): RegExpMatchArray | null {
	const tail = collected.length > 8000 ? collected.slice(-8000) : collected;
	return [...tail.matchAll(sentinelReFor(nonce))].pop() ?? null;
}

export function cleanBashOutput(raw: string, nonce: string, command = "", injectedLine?: string): string {
	const fmt = `[pi-exit-${nonce}:%s]`;
	const rawLines = stripAnsi(raw).replace(/\r\n/g, "\n").split("\n");
	if (command) {
		const injected = injectedLine ?? buildTerminalBashLine(command, undefined, nonce);
		for (let i = 0; i < rawLines.length; i++) {
			const start = rawLines[i].indexOf("eval $'");
			if (start < 0) continue;
			let matched = 0;
			let end = i;
			for (; end < rawLines.length; end++) {
				let fragment = end === i ? rawLines[end].slice(start) : rawLines[end];
				if (!injected.startsWith(fragment, matched)) fragment = fragment.trimEnd();
				if (!fragment || !injected.startsWith(fragment, matched)) break;
				matched += fragment.length;
				if (matched === injected.length) {
					rawLines.splice(i, end - i + 1, rawLines[i].slice(0, start) + injected);
					break;
				}
			}
		}
	}
	const echoAt = rawLines.findIndex((line) => line.includes(fmt));
	const preceding = echoAt > 0 ? rawLines[echoAt - 1].trim() : "";
	const echoedPrompt = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+ /.test(preceding) ? preceding : "";
	let lines = rawLines.filter(
		(line, index) =>
			!line.includes(fmt) && !/^\s*\[pi-term-exit:-?\d+\]\s*$/.test(line) && !(echoedPrompt && index === echoAt - 1),
	);
	const anchor = (command.split("\n")[0] ?? "").trim().slice(0, 80);
	let promptLine = echoedPrompt;
	const fallbackPromptDetect = (): void => {
		const idx = lines.findIndex((line) => line.trim() !== "");
		if (idx < 0) return;
		const first = lines[idx].trim();
		if (
			/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+[^\n]*[$#] /.test(first) ||
			/^\[[A-Za-z0-9._-]+@[A-Za-z0-9._-]+[^\]]*\][$#] /.test(first)
		) {
			promptLine = first;
			lines = lines.slice(idx + 1);
			return;
		}
		if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+ /.test(first) && /^[$#] /.test(lines[idx + 1]?.trim() ?? "")) {
			promptLine = first;
			lines = lines.slice(idx + 2);
		}
	};
	if (anchor) {
		const echoIdx = lines.findIndex((line) => line.includes(anchor));
		if (echoIdx >= 0) {
			for (let i = echoIdx - 1; i >= 0 && !promptLine; i--) {
				const t = lines[i].trim();
				if (t && t !== "$") promptLine = t;
			}
			const firstLine = (command.split("\n")[0] ?? "").trim();
			const echoLine = lines[echoIdx].trimEnd();
			const anchorAt = echoLine.indexOf(anchor);
			let pos = anchorAt >= 0 ? Math.min(echoLine.length - anchorAt, firstLine.length) : anchor.length;
			let idx = echoIdx + 1;
			while (pos < firstLine.length && idx < lines.length) {
				const chunk = lines[idx].trim();
				if (!chunk || firstLine.slice(pos, pos + chunk.length) !== chunk) break;
				pos += chunk.length;
				idx++;
			}
			lines = lines.slice(idx);
		} else {
			fallbackPromptDetect();
		}
	} else {
		fallbackPromptDetect();
	}
	const text = lines.join("\n");
	const re = sentinelReFor(nonce);
	let last: RegExpExecArray | null = null;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		last = m;
	}
	const kept = (last ? text.slice(0, last.index) : text).split("\n").map((line) => line.trimEnd());
	const promptHead = promptLine.match(/^\S+@\S+/)?.[0] ?? "";
	const isResidue = (line: string): boolean => {
		const t = line.trim();
		if (t === "" || t === "$") return true;
		if (promptLine !== "" && t === promptLine) return true;
		return promptHead !== "" && t.startsWith(`${promptHead} `);
	};
	while (kept.length > 0 && isResidue(kept[kept.length - 1])) kept.pop();
	return truncateMiddle(kept.join("\n").trim());
}

let oneShotBashSeq = 0;

const MAX_HEAD_TAIL_LINES = 5000;

export function applyHeadTail(text: string, head?: number, tail?: number, lang: ServerLang = "en"): string {
	const headN = head && head > 0 ? Math.min(Math.floor(head), MAX_HEAD_TAIL_LINES) : 0;
	const tailN = tail && tail > 0 ? Math.min(Math.floor(tail), MAX_HEAD_TAIL_LINES) : 0;
	let data = text.split("\n");
	let headNote: string | null = null;
	let tailNote: string | null = null;
	if (headN && data.length > headN) {
		const n = data.length - headN;
		headNote = pick(lang, `…（后 ${n} 行已省略）`, `…[${n} lines omitted below]…`, "terminals.headtail.omitted.below", {
			n,
		});
		data = data.slice(0, headN);
	}
	if (tailN && data.length > tailN) {
		const n = data.length - tailN;
		tailNote = pick(lang, `…（前 ${n} 行已省略）`, `…[${n} lines omitted above]…`, "terminals.headtail.omitted.above", {
			n,
		});
		data = data.slice(-tailN);
	}
	const parts: string[] = [];
	if (tailNote) parts.push(tailNote);
	parts.push(...data);
	if (headNote) parts.push(headNote);
	return parts.join("\n");
}

export function makeTerminalBashTool(
	terminals: TerminalManager,
	opts: {
		cwd: string;
		defaultPersist: () => boolean;
		idleMs: () => number;
		maxForegroundMs?: () => number;
		kills: Set<AbortController>;
		notifyBackgroundDone: (info: { terminalId: string; command: string; exitCode: number | null }) => void;
		lang?: () => ServerLang;
	},
): ToolDefinition {
	const PERSIST_ID = "ai-bash";

	return defineTool({
		name: "bash",
		label: "Run bash command",
		description: BASH_DESCRIPTION,
		promptSnippet: BASH_PROMPT_SNIPPET,
		promptGuidelines: BASH_PROMPT_GUIDELINES,
		parameters: BASH_PARAMETERS,
		execute: async (_id, p, signal) => {
			const lang: ServerLang = opts.lang?.() ?? "en";
			if (signal?.aborted) throw new Error("Command aborted");
			const incomplete = sentinelUnsafeReason(detectTrailingLimiter(p.command)?.base ?? p.command);
			if (incomplete) {
				const reasonZh =
					incomplete === "trailing_backslash"
						? "以续行符 \\ 结尾"
						: incomplete === "unclosed_quote"
							? "存在未闭合引号"
							: incomplete === "unclosed_heredoc"
								? "存在未闭合的 heredoc（<<）"
								: incomplete === "unclosed_block"
									? "存在未闭合的 if/for/case 块"
									: "存在未闭合的 { } / ( ) 组";
				const reasonEn =
					incomplete === "trailing_backslash"
						? "ends with a line-continuation backslash"
						: incomplete === "unclosed_quote"
							? "has an unclosed quote"
							: incomplete === "unclosed_heredoc"
								? "has an unclosed heredoc (<<)"
								: incomplete === "unclosed_block"
									? "has an unclosed if/for/case block"
									: "has an unclosed { } / ( ) group";
				throw new Error(
					pick(
						lang,
						`命令语法不完整（${reasonZh}），未执行。终端接管 bash 无法为它注入退出码哨兵，残句还会让 shell 停在续行提示符、零执行。请补全引号 / 续行符 / 括号后重试。`,
						`Command is syntactically incomplete (${reasonEn}); nothing was executed. The terminal bash path cannot inject an exit-code sentinel here, and the leftover fragment would leave the shell waiting at a continuation prompt. Complete the quote / continuation / bracket and retry.`,
						"terminals.bash.incomplete",
						{ reason: reasonEn, reasonEn, reasonZh },
					),
				);
			}
			const persist = p.persist ?? opts.defaultPersist();
			const termId = persist ? PERSIST_ID : `ai-bash-${++oneShotBashSeq}`;
			const title = persist ? "AI bash" : `AI bash ${oneShotBashSeq}`;
			if (terminals.isSentinelPending?.(termId)) {
				throw new Error(
					`Terminal ${termId} is busy. Use terminal({action:'wait', terminalId:'${termId}'}) or action:'read', 'input', 'key' for the current task.`,
				);
			}
			if (
				terminals.create(termId, opts.cwd, 120, 40, opts.cwd, title, {
					forceBash: true,
					agentBash: true,
				}) === null
			) {
				throw new Error(
					pick(
						lang,
						`无法打开 AI bash 终端（${termId}）`,
						`Failed to open the AI bash terminal (${termId})`,
						"terminals.bash.open.failed",
						{ termId },
					),
				);
			}
			terminals.suspendIdleWatch(termId);
			const start = terminals.endCursor(termId)!;
			const ac = new AbortController();
			opts.kills.add(ac);
			const closeOneShot = (): void => {
				if (!persist) void terminals.inputChecked(termId, "exit\r");
			};
			const idleMs = Math.max(0, opts.idleMs());
			const maxForegroundMs = Math.max(0, opts.maxForegroundMs?.() ?? 0);
			const startTime = Date.now();
			const deadline = p.timeout && p.timeout > 0 ? Date.now() + p.timeout * 1000 : null;
			const limiter = detectTrailingLimiter(p.command);
			const stripped = limiter !== null;
			const effectiveTail: number | undefined =
				p.tail ?? (limiter?.kind === "tail" ? (limiter.lines ?? undefined) : undefined);
			const runCommand = stripped ? limiter!.base : p.command;
			const redirect = stripped && limiter!.kind === "tail" ? detectStdoutRedirect(runCommand) : null;
			const tailFile = redirect ? { file: redirect.file, lines: limiter!.lines ?? 10 } : undefined;
			const limiterSegment = limiter?.segment ?? "";
			const limiterTailLines = limiter?.lines ?? 10;
			const limiterTailZh = limiter?.kind === "tail" ? `本次返回末尾 ${limiterTailLines} 行。` : "本次返回全部输出。";
			const limiterTailEn =
				limiter?.kind === "tail"
					? `Returning the last ${limiterTailLines} lines this time.`
					: "Returning the full output this time.";
			const limiterNote = stripped
				? pick(
						lang,
						`\n[注：检测到你带了「${limiterSegment}」这类限输出/过滤管道——已在终端里直跑底层命令（实时可见 + 真实退出码），只按参数返回片段。${limiterTailZh} 后续直接用 bash(command, tail=N) 参数限输出。]`,
						`\n[Note: detected a trailing output-limiting pipe "${limiterSegment}" — ran the underlying command directly in the terminal (live output + real exit code) and trimmed only the returned slice. ${limiterTailEn} Next time use the bash(command, tail=N) parameter to limit output.]`,
						"terminals.bash.limiter.note",
						{ limiterSegment, limiterTailZh, limiterTailEn },
					)
				: "";
			const nonce = newSentinelNonce();
			const injectedLine = buildTerminalBashLine(runCommand, tailFile, nonce);
			const cleanCollected = (raw: string) => cleanBashOutput(raw, nonce, runCommand, injectedLine);
			let finished = false;
			let background = false;
			let exitCode: number | null = null;
			let failure: Error | undefined;
			let unwatch = () => {};
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const finish = (code: number | null) => {
				if (finished) return;
				finished = true;
				exitCode = code;
				if (timeout) clearTimeout(timeout);
				unwatch();
				signal?.removeEventListener("abort", onSignalAbort);
				ac.signal.removeEventListener("abort", onAbort);
				opts.kills.delete(ac);
				terminals.setSentinelPending(termId, false, nonce);
				if (background) opts.notifyBackgroundDone({ terminalId: termId, command: runCommand, exitCode: code });
				if (!failure && code !== null && !terminals.bashTaskState?.(termId).exited) closeOneShot();
			};
			const cancel = (error: Error) => {
				if (finished) return;
				failure = error;
				try {
					terminals.kill?.(termId);
				} finally {
					finish(null);
				}
			};
			const onAbort = () => cancel(new Error("Command aborted"));
			const onSignalAbort = () => ac.abort();
			terminals.setSentinelPending(termId, true, nonce);
			unwatch =
				terminals.watchOutput?.(termId, sentinelReFor(nonce), (m) => {
					finish(m ? Number(m[1]) : terminals.bashTaskState(termId).exitCode);
				}) ?? (() => {});
			if (!finished) {
				ac.signal.addEventListener("abort", onAbort, { once: true });
				signal?.addEventListener("abort", onSignalAbort, { once: true });
			}
			if (!finished && deadline !== null) {
				const checkDeadline = () => {
					if (finished) return;
					if (Date.now() >= deadline) cancel(new Error(`Command timed out after ${p.timeout}s`));
					else {
						timeout = setTimeout(checkDeadline, armDelay(deadline, Date.now()));
						timeout.unref?.();
					}
				};
				checkDeadline();
			}
			try {
				let collected = "";
				let cursor = start;
				let lastDataAt = Date.now();
				if (signal?.aborted) onSignalAbort();
				if (failure) throw failure;
				if (!finished) {
					const inputErr = terminals.inputChecked(termId, injectedLine + "\r");
					if (inputErr) throw new Error(inputErr);
				}
				for (;;) {
					if (failure) throw failure;
					await sleep(60);
					const read = terminals.read(termId, cursor);
					if (read?.data) {
						collected += read.data;
						cursor = read.cursor;
						lastDataAt = Date.now();
						if (collected.length > BASH_COLLECT_MAX) {
							collected = collected.slice(collected.length - BASH_COLLECT_MAX / 2);
						}
					}
					const marker = lastSentinel(collected, nonce);
					if (!finished && marker) finish(Number(marker[1]));
					if (failure) throw failure;
					if (finished) {
						if (exitCode === null) throw new Error("Terminal closed before command completion (exit code unknown)");
						const text = applyHeadTail(cleanCollected(collected), p.head, effectiveTail, lang);
						return {
							content: [
								{
									type: "text",
									text: `${text}${text ? "\n" : ""}${limiterNote}[exit:${exitCode}]`,
								},
							],
							details: { exitCode, output: text },
						};
					}

					if (persist && idleMs > 0 && Date.now() - lastDataAt >= idleMs) {
						background = true;
						return backgroundResult(
							terminals,
							opts,
							runCommand,
							applyHeadTail(cleanCollected(collected), p.head, effectiveTail, lang),
							Math.round((Date.now() - lastDataAt) / 1000),
							lang,
							nonce,
							termId,
							persist,
							"idle",
						);
					}
					if (maxForegroundMs > 0 && Date.now() - startTime >= maxForegroundMs) {
						background = true;
						return backgroundResult(
							terminals,
							opts,
							runCommand,
							applyHeadTail(cleanCollected(collected), p.head, effectiveTail, lang),
							Math.round((Date.now() - startTime) / 1000),
							lang,
							nonce,
							termId,
							persist,
							"elapsed",
						);
					}
				}
			} catch (error) {
				cancel(error instanceof Error ? error : new Error(String(error)));
				throw error;
			} finally {
				if (!background && !finished) finish(null);
			}
		},
	});
}

function backgroundResult(
	terminals: TerminalManager,
	opts: Parameters<typeof makeTerminalBashTool>[1],
	command: string,
	partialText: string,
	durationSeconds: number,
	lang: ServerLang,
	nonce: string,
	termId: string = "ai-bash",
	persist: boolean = true,
	reason: "idle" | "elapsed" = "idle",
): { content: { type: "text"; text: string }[]; details: unknown } {
	const partial = truncateMiddle(partialText, 6000);
	const partialZh = partial || "（暂无输出）";
	const partialEn = partial || "(no output yet)";

	let descZh = "";
	let descEn = "";

	if (reason === "elapsed") {
		descZh =
			`命令仍在终端 ${termId} 中运行（前台执行已达 ${durationSeconds} 秒上限，自动转入后台）。` +
			`本次调用不阻塞——命令继续在后台执行，结束时你会收到自动通知。\n` +
			`已有输出：\n${partialZh}\n`;
		descEn =
			`Command still running in terminal ${termId} (foreground execution reached ${durationSeconds}s limit, moved to background). ` +
			`This call does not block — the command keeps running in the background and you will be notified automatically when it finishes.\n` +
			`Partial output:\n${partialEn}\n`;
	} else {
		descZh =
			`命令仍在持久终端 ${termId} 中运行（已连续 ${durationSeconds} 秒无输出，未结束）。` +
			`本次调用不阻塞——命令继续在后台执行，结束时你会收到自动通知。\n` +
			`已有输出：\n${partialZh}\n`;
		descEn =
			`Command still running in the persistent terminal ${termId} (no output for ${durationSeconds}s, not finished). ` +
			`This call does not block — the command keeps running in the background and you will be notified automatically when it finishes.\n` +
			`Partial output:\n${partialEn}\n`;
	}

	if (persist) {
		descZh += `要重新阻塞等它结束就用 terminal(action='wait', terminalId='${termId}')（无需反复轮询）；需要交互用 terminal(action='input'/'key', terminalId='${termId}')（Ctrl+C 可终止）。`;
		descEn += `To block until it finishes, use terminal(action='wait', terminalId='${termId}') (no polling needed); use terminal(action='input'/'key', terminalId='${termId}') to interact (Ctrl+C aborts).`;
	} else {
		descZh += `命令完成后该终端将自动退出并发送通知；如需查看输出可用 terminal(action='read', terminalId='${termId}')。`;
		descEn += `When completed, this terminal will exit automatically and notify; to inspect output, use terminal(action='read', terminalId='${termId}').`;
	}

	if (reason === "elapsed") {
		return {
			content: [
				{
					type: "text",
					text: pick(lang, descZh, descEn, "terminals.bash.background.elapsed", {
						durationSeconds,
						partialZh,
						partialEn,
						termId,
					}),
				},
			],
			details: { running: true, terminalId: termId, persist, durationSeconds, reason },
		};
	}

	return {
		content: [
			{
				type: "text",
				text: pick(lang, descZh, descEn, "terminals.bash.background.running", {
					silentSeconds: durationSeconds,
					durationSeconds,
					partialZh,
					partialEn,
					termId,
				}),
			},
		],
		details: { running: true, terminalId: termId, persist, durationSeconds, reason },
	};
}

export { TERMINAL_TOOL_NAMES } from "./tool-manager.js";

export const TERMINAL_TOOLS_GUIDANCE = `Use terminal(action) for interactive programs, REPLs, TUIs, persistent servers, or work in the visible terminal panel. Prefer bash for ordinary commands. Use create/list to select a terminal, input/key to drive it, and close when finished. read supports incremental cursors, output waiting, head/tail, and literal search. wait blocks for a tracked bash command's exit marker; commands submitted through input/key have no such marker, so observe them with read(waitMs). bash({persist:true}) uses terminalId='ai-bash' and may wait before returning. read/wait are read-only; other actions are write operations. When a liveness reminder arrives, read the terminal, answer its prompt, or close it.`;

export interface TerminalSafetyCheckResult {
	blocked?: boolean;
	reason?: string;
	reasonEn?: string;
	userDenied?: boolean;
	editedCommand?: string;
}

export interface PersistentTerminalToolsOptions {
	checkSafety?: (
		cmd: string,
		ctx: {
			terminalId: string;
			toolCallId: string;
			toolName: "terminal";
			action: "input" | "key";
		},
	) => Promise<TerminalSafetyCheckResult> | TerminalSafetyCheckResult;
}

export function makePersistentTerminalTools(
	terminals: TerminalManager,
	cwd: string,
	lang?: () => ServerLang,
	options?: PersistentTerminalToolsOptions,
): ToolDefinition[] {
	const getLang: () => ServerLang = lang ?? (() => "en");
	const result = (
		text: string,
		details: unknown = {},
	): {
		content: { type: "text"; text: string }[];
		details: unknown;
	} => ({ content: [{ type: "text", text }], details });
	const failIf = (error: string | null): void => {
		if (error) throw new Error(error);
	};

	const fallbackPending = new Map<string, string>();
	const getPending = (id: string): string => {
		if (typeof terminals.getAgentPendingLine === "function") {
			return terminals.getAgentPendingLine(id);
		}
		return fallbackPending.get(id) ?? "";
	};
	const setPending = (id: string, line: string): void => {
		if (typeof terminals.setAgentPendingLine === "function") {
			terminals.setAgentPendingLine(id, line);
		} else {
			fallbackPending.set(id, line);
		}
	};
	const clearPending = (id: string): void => {
		if (typeof terminals.clearAgentPendingLine === "function") {
			terminals.clearAgentPendingLine(id);
		} else {
			fallbackPending.delete(id);
		}
	};

	return [
		defineTool({
			name: "terminal",
			label: "Terminal",
			description:
				"Manage persistent interactive PTYs. Actions: create/list/close/input/key/read/wait. terminalId is required except for list; input requires data and key requires key. read returns incremental output and cursor, with optional waiting and head/tail/search filters. wait blocks for a tracked bash command's completion marker or timeout; input/key commands have no completion marker. read/wait are read-only; all other actions are write operations.",
			promptSnippet: "drive interactive programs or inspect persistent terminal output",
			promptGuidelines: [
				"Prefer bash for ordinary commands. Use read(waitMs) for output from input/key; use wait only for tracked bash commands. Retain the returned cursor for incremental reads.",
			],
			parameters: Type.Object({
				action: Type.Union([
					Type.Literal("create"),
					Type.Literal("list"),
					Type.Literal("close"),
					Type.Literal("input"),
					Type.Literal("key"),
					Type.Literal("read"),
					Type.Literal("wait"),
				]),
				terminalId: Type.Optional(Type.String({ minLength: 1, description: "Required except for list" })),
				cwd: Type.Optional(Type.String({ description: "Workspace-relative directory for create" })),
				cols: Type.Optional(Type.Integer({ minimum: 2, maximum: 500 })),
				rows: Type.Optional(Type.Integer({ minimum: 2, maximum: 200 })),
				data: Type.Optional(Type.String({ description: "Required for input; include newline to submit" })),
				key: Type.Optional(Type.String({ description: "Required for key, e.g. Enter or c" })),
				modifiers: Type.Optional(
					Type.Object({
						ctrl: Type.Optional(Type.Boolean()),
						alt: Type.Optional(Type.Boolean()),
						shift: Type.Optional(Type.Boolean()),
					}),
				),
				cursor: Type.Optional(
					Type.Integer({ minimum: 0, description: "Absolute output offset; pass returned cursor on next read" }),
				),
				maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
				waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 120000 })),
				maxWaitMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 600000 })),
				head: Type.Optional(Type.Integer({ minimum: 1, description: "Read: first N matching lines" })),
				tail: Type.Optional(
					Type.Integer({ minimum: 1, description: "Read: last N matching lines; exclusive with head" }),
				),
				search: Type.Optional(
					Type.String({ description: "Read: literal, case-sensitive line filter after stripping ANSI" }),
				),
			}),
			execute: async (_id, args, signal) => {
				signal?.throwIfAborted();
				if (!["create", "list", "close", "input", "key", "read", "wait"].includes(args.action))
					throw new Error("Unknown terminal action");
				if (args.action !== "list" && (typeof args.terminalId !== "string" || !args.terminalId.trim()))
					throw new Error("terminalId is required for " + args.action);
				if (args.action === "input" && typeof args.data !== "string") throw new Error("data is required for input");
				if (args.action === "key" && (typeof args.key !== "string" || !args.key))
					throw new Error("key is required for key");
				if (args.action === "read" && args.head !== undefined && args.tail !== undefined)
					throw new Error("head and tail are mutually exclusive");
				const p = { ...args, terminalId: args.terminalId ?? "", data: args.data ?? "", key: args.key ?? "" };
				switch (p.action) {
					case "create": {
						const lang = getLang();
						const safeCols = Math.max(2, Math.min(500, Math.floor(p.cols ?? 120)));
						const safeRows = Math.max(2, Math.min(200, Math.floor(p.rows ?? 40)));
						const info = terminals.create(p.terminalId, p.cwd ?? cwd, safeCols, safeRows, cwd, p.terminalId);
						const infoJson = JSON.stringify(info);
						if (!info)
							throw new Error(
								pick(
									lang,
									`创建终端失败：${p.terminalId}`,
									`Failed to create terminal: ${p.terminalId}`,
									"terminals.create.failed",
									{ "p.terminalId": p.terminalId },
								),
							);
						terminals.noteAgentActivity(p.terminalId);
						return result(
							pick(lang, `终端已创建：${infoJson}`, `Terminal created: ${infoJson}`, "terminals.create.done", {
								infoJson,
							}),
							info,
						);
					}
					case "list": {
						const list = terminals.list();
						return result(JSON.stringify(list), list);
					}
					case "close": {
						const lang = getLang();
						if (!terminals.has(p.terminalId))
							throw new Error(
								pick(
									lang,
									`终端不存在：${p.terminalId}`,
									`Terminal not found: ${p.terminalId}`,
									"terminals.close.not.found",
									{ "p.terminalId": p.terminalId },
								),
							);
						terminals.kill(p.terminalId);
						return result(
							pick(lang, `终端已关闭：${p.terminalId}`, `Terminal closed: ${p.terminalId}`, "terminals.close.done", {
								"p.terminalId": p.terminalId,
							}),
						);
					}
					case "input": {
						const lang = getLang();
						const prevPending = getPending(p.terminalId);
						const parsed = parseTerminalLineStream(prevPending, p.data);

						if (options?.checkSafety && parsed.completedLines.length > 0) {
							for (const line of parsed.completedLines) {
								const cleanCmd = stripAnsi(line).trim();
								if (!cleanCmd) continue;
								const safety = await options.checkSafety(cleanCmd, {
									terminalId: p.terminalId,
									toolCallId: _id,
									toolName: "terminal",
									action: "input",
								});
								signal?.throwIfAborted();
								if (safety.blocked) {
									if (prevPending) {
										try {
											terminals.inputChecked(p.terminalId, "\x03");
										} catch {}
									}
									clearPending(p.terminalId);
									const reason = pick(lang, safety.reason ?? "", safety.reasonEn ?? safety.reason ?? "");
									const reasonSuffix = reason ? (lang === "zh" ? ` 原因：${reason}` : ` Reason: ${reason}`) : "";
									throw new Error(
										safety.userDenied
											? pick(
													lang,
													`【操作被用户拒绝】${reasonSuffix}`,
													`[Operation denied by user]${reasonSuffix}`,
													"terminals.operation.denied",
													{ reasonSuffix },
												)
											: pick(
													lang,
													`【终端输入命令被安全规则阻断】${reasonSuffix}`,
													`[Terminal command blocked by safety rule]${reasonSuffix}`,
													"terminals.command.blocked",
													{ reasonSuffix },
												),
									);
								}
								if (safety.editedCommand !== undefined) {
									if (prevPending) {
										try {
											terminals.inputChecked(p.terminalId, "\x03");
										} catch {}
									}
									clearPending(p.terminalId);
									failIf(terminals.inputChecked(p.terminalId, safety.editedCommand + "\r"));
									terminals.noteAgentActivity(p.terminalId);
									return result(
										pick(
											lang,
											`已发送改写后的命令到 ${p.terminalId}：${safety.editedCommand}`,
											`Sent edited command to ${p.terminalId}: ${safety.editedCommand}`,
											"terminals.input.edited_sent",
											{ command: safety.editedCommand, "p.terminalId": p.terminalId },
										),
									);
								}
							}
						}

						failIf(terminals.inputChecked(p.terminalId, p.data));
						setPending(p.terminalId, parsed.remainingPending);
						terminals.noteAgentActivity(p.terminalId);
						return result(
							pick(
								lang,
								`已发送 ${p.data.length} 个字符到 ${p.terminalId}`,
								`Sent ${p.data.length} chars to ${p.terminalId}`,
								"terminals.input.sent",
								{ "p.data.length": p.data.length, "p.terminalId": p.terminalId },
							),
						);
					}
					case "key": {
						const lang = getLang();
						const encoded = encodeTerminalKey(p.key, p.modifiers);
						if ("error" in encoded) throw new Error(encoded.error);

						const isEnter = encoded.data.includes("\r") || encoded.data.includes("\n");
						if (isEnter) {
							const pending = getPending(p.terminalId);
							const cleanCmd = stripAnsi(pending).trim();
							if (options?.checkSafety && cleanCmd) {
								const safety = await options.checkSafety(cleanCmd, {
									terminalId: p.terminalId,
									toolCallId: _id,
									toolName: "terminal",
									action: "key",
								});
								signal?.throwIfAborted();
								if (safety.blocked) {
									try {
										terminals.inputChecked(p.terminalId, "\x03");
									} catch {}
									clearPending(p.terminalId);
									const reason = pick(lang, safety.reason ?? "", safety.reasonEn ?? safety.reason ?? "");
									const reasonSuffix = reason ? (lang === "zh" ? ` 原因：${reason}` : ` Reason: ${reason}`) : "";
									throw new Error(
										safety.userDenied
											? pick(
													lang,
													`【操作被用户拒绝】${reasonSuffix}`,
													`[Operation denied by user]${reasonSuffix}`,
													"terminals.operation.denied",
													{ reasonSuffix },
												)
											: pick(
													lang,
													`【终端输入命令被安全规则阻断】${reasonSuffix}`,
													`[Terminal command blocked by safety rule]${reasonSuffix}`,
													"terminals.command.blocked",
													{ reasonSuffix },
												),
									);
								}
								if (safety.editedCommand !== undefined) {
									try {
										terminals.inputChecked(p.terminalId, "\x03");
									} catch {}
									clearPending(p.terminalId);
									failIf(terminals.inputChecked(p.terminalId, safety.editedCommand + "\r"));
									terminals.noteAgentActivity(p.terminalId);
									return result(
										pick(
											lang,
											`已发送改写后的命令到 ${p.terminalId}：${safety.editedCommand}`,
											`Sent edited command to ${p.terminalId}: ${safety.editedCommand}`,
											"terminals.key.edited_sent",
											{ command: safety.editedCommand, "p.terminalId": p.terminalId },
										),
									);
								}
							}
							failIf(terminals.inputChecked(p.terminalId, encoded.data));
							clearPending(p.terminalId);
							terminals.noteAgentActivity(p.terminalId);
							return result(
								pick(
									lang,
									`已发送按键 ${p.key} 到 ${p.terminalId}`,
									`Sent key ${p.key} to ${p.terminalId}`,
									"terminals.key.sent",
									{ "p.key": p.key, "p.terminalId": p.terminalId },
								),
							);
						}

						const prev = getPending(p.terminalId);
						const parsed = parseTerminalLineStream(prev, encoded.data);
						failIf(terminals.inputChecked(p.terminalId, encoded.data));
						setPending(p.terminalId, parsed.remainingPending);
						terminals.noteAgentActivity(p.terminalId);
						return result(
							pick(
								lang,
								`已发送按键 ${p.key} 到 ${p.terminalId}`,
								`Sent key ${p.key} to ${p.terminalId}`,
								"terminals.key.sent",
								{ "p.key": p.key, "p.terminalId": p.terminalId },
							),
						);
					}
					case "read": {
						const lang = getLang();
						const cursor = Math.max(0, Math.floor(p.cursor ?? 0));
						const waitMs = p.waitMs !== undefined ? Math.max(0, Math.min(120_000, Math.floor(p.waitMs))) : undefined;
						const maxBytes = Math.max(1, Math.min(100_000, Math.floor(p.maxBytes ?? 20000)));
						if (waitMs) await terminals.waitForOutput(p.terminalId, cursor, waitMs, signal);
						const read = terminals.read(p.terminalId, cursor, maxBytes);
						if (!read)
							throw new Error(
								pick(
									lang,
									`终端不存在：${p.terminalId}`,
									`Terminal not found: ${p.terminalId}`,
									"terminals.read.not.found",
									{ "p.terminalId": p.terminalId },
								),
							);
						if (p.head !== undefined || p.tail !== undefined || p.search !== undefined) {
							let lines = stripAnsi(read.data).split("\n");
							if (lines.at(-1) === "") lines.pop();
							if (p.search !== undefined) lines = lines.filter((line) => line.includes(p.search!));
							if (p.head !== undefined) lines = lines.slice(0, p.head);
							if (p.tail !== undefined) lines = lines.slice(-p.tail);
							const filtered = { ...read, data: lines.join("\n") };
							return result(JSON.stringify(filtered), filtered);
						}
						return result(JSON.stringify(read), read);
					}
					case "wait": {
						const lang = getLang();
						if (!terminals.has(p.terminalId)) {
							throw new Error(
								pick(
									lang,
									`终端不存在：${p.terminalId}（可能已被关闭或会话重置，请先 terminal(action='create')）`,
									`Terminal not found: ${p.terminalId} (it may have been closed or the session was reset — run terminal(action='create') first)`,
									"terminals.wait.not.found",
									{ "p.terminalId": p.terminalId },
								),
							);
						}
						if (p.cursor === undefined && !terminals.isSentinelPending(p.terminalId)) {
							const why = pick(
								lang,
								`终端 ${p.terminalId} 当前没有正在等待完成的 bash 工具命令（shell 空闲，或该命令是通过 terminal(action='input') 发出的、没有完成标记）。terminal(action='wait') 不适用；要观察输出请用 terminal(action='read', terminalId="${p.terminalId}", waitMs=…)。`,
								`Terminal ${p.terminalId} has no pending bash-tool command to wait for (the shell is idle, or the command was sent via terminal(action='input') and has no completion marker). terminal(action='wait') does not apply; use terminal(action='read', terminalId="${p.terminalId}", waitMs=…) to observe output.`,
								"terminals.wait.no.pending",
								{ "p.terminalId": p.terminalId },
							);
							return result(JSON.stringify({ applicable: false, reason: why }), { applicable: false });
						}
						const cursor = p.cursor ?? terminals.endCursor(p.terminalId) ?? 0;
						const maxWait = Math.max(100, Math.min(600_000, Math.floor(p.maxWaitMs ?? 300_000)));
						const wait = await terminals.waitForCompletion(p.terminalId, maxWait, signal, cursor);
						const read = terminals.read(p.terminalId, cursor, 20_000);
						const outputTail = read?.data ? stripAnsi(read.data).slice(-4000) : "";
						return result(JSON.stringify({ ...wait, outputTail }), {
							...wait,
							outputTail,
						});
					}
				}
				throw new Error("Unknown terminal action");
			},
		}),
	];
}
