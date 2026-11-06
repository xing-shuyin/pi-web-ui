import { registerHooks } from "node:module";

export const SENTINEL = "// pi-web-ui #810: fork-free executable lookup v1";
export const PREAMBLE_START = "/* pi-web-ui #810: fork-free executable lookup v1 (preamble) */";
export const PREAMBLE_END = "/* pi-web-ui #810: fork-free executable lookup v1 (/preamble) */";

export type ExecutableLookupTarget = "shell" | "tools-manager";
export type PatchStatus = "patched" | "already" | "unsupported";

const TARGETS: Record<ExecutableLookupTarget, string> = {
	shell: "/@earendil-works/pi-coding-agent/dist/utils/shell.js",
	"tools-manager": "/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js",
};

export const PREAMBLE = `${PREAMBLE_START}
import {
    accessSync as __piWebExecAccess,
    constants as __piWebExecConstants,
    statSync as __piWebExecStat,
} from "node:fs";
import { delimiter as __piWebExecDelimiter, join as __piWebExecJoin } from "node:path";
function __piWebExecProgram(candidate) {
    let stats = null;
    try {
        stats = __piWebExecStat(candidate);
    } catch {
        stats = null;
    }
    if (stats === null) {
        // An entry stat() cannot follow. On Windows these are app-execution aliases
        // (0-byte reparse points; nodejs/node#36790) — runnable, so accept them.
        if (process.platform !== "win32") return false;
        try {
            __piWebExecAccess(candidate, __piWebExecConstants.F_OK);
            return true;
        } catch {
            return false;
        }
    }
    // Directories are executable on POSIX but never runnable as a command; a symlink
    // that points at a program resolves to one here.
    if (!stats.isFile()) return false;
    if (process.platform === "win32") return true;
    try {
        __piWebExecAccess(candidate, __piWebExecConstants.X_OK);
        return true;
    } catch {
        return false;
    }
}
${PREAMBLE_END}`;

const SHELL_LOOKUP_OLD = `    // Unix: Use 'which' and trust its output (handles Termux and special filesystems)
    try {
        const result = spawnSync("which", [executable], { encoding: "utf-8", timeout: 5000 });
        if (result.status === 0 && result.stdout) {
            const firstMatch = result.stdout.trim().split(/\\r?\\n/)[0];
            if (firstMatch) {
                return firstMatch;
            }
        }
    }
    catch {
        // Ignore errors
    }`;

const TOOLS_LOOKUP_OLD = `function commandExists(cmd) {
    try {
        const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
        // Check for ENOENT error (command not found)
        return result.error === undefined || result.error === null;
    }
    catch {
        return false;
    }
}`;

const SHELL_LOOKUP_NEW = `    // Unix: resolve from PATH directly — a forked \`which\` can stall before exec on
    // Android/Termux, which hung the first tool call instead of failing fast.
    try {
        for (const directory of (process.env.PATH ?? "").split(__piWebExecDelimiter)) {
            if (!directory) continue;
            const candidate = __piWebExecJoin(directory, executable);
            if (__piWebExecProgram(candidate)) {
                return candidate;
            }
        }
    }
    catch {
        // Ignore errors
    }`;

const TOOLS_LOOKUP_NEW = `function commandExists(cmd) {
    // Android/Termux: resolve from PATH instead of forking \`cmd --version\` — the fork can
    // stall before exec, so the probe hung instead of answering.
    try {
        // A name given as a path is resolved as that path, not searched for on PATH.
        if (cmd.includes("/") || cmd.includes("\\\\")) return __piWebExecProgram(cmd);
        const win = process.platform === "win32";
        // CreateProcess itself only appends \`.exe\` (a .cmd/.bat needs a shell, which we must
        // not spawn here); claiming those would be the same false positive this patch removes.
        const extensions = win ? [".exe", ""] : [""];
        return (process.env.PATH ?? "")
            .split(win ? ";" : __piWebExecDelimiter)
            .some((directory) => !!directory && extensions.some((ext) => __piWebExecProgram(__piWebExecJoin(directory, cmd + ext))));
    }
    catch {
        return false;
    }
}`;

export function executableLookupTarget(url: string): ExecutableLookupTarget | null {
	const normalized = url.replaceAll("\\\\", "/");
	for (const [target, suffix] of Object.entries(TARGETS) as [ExecutableLookupTarget, string][]) {
		if (normalized.endsWith(suffix)) return target;
	}
	return null;
}

const ANCHORS: Record<ExecutableLookupTarget, string> = {
	shell: "function findExecutableOnPath",
	"tools-manager": "function commandExists",
};

const FORKING_CALL = /\b(?:spawnSync|execSync|execFileSync)\s*\(/;

const REGEX_PREFIX_CHARS = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_PREFIX_WORDS = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"case",
	"do",
	"else",
	"yield",
	"await",
]);

function isRegexStart(source: string, i: number): boolean {
	let j = i - 1;
	while (j >= 0 && /\s/.test(source[j])) j--;
	if (j < 0) return true;
	if (REGEX_PREFIX_CHARS.has(source[j])) return true;
	if (!/[A-Za-z0-9_$]/.test(source[j])) return false;
	let k = j;
	while (k >= 0 && /[A-Za-z0-9_$]/.test(source[k])) k--;
	return REGEX_PREFIX_WORDS.has(source.slice(k + 1, j + 1));
}

function skipRegex(source: string, i: number): number | null {
	let inClass = false;
	for (let j = i + 1; j < source.length; j++) {
		const char = source[j];
		if (char === "\\") {
			j++;
			continue;
		}
		if (char === "\n") return null;
		if (inClass) {
			if (char === "]") inClass = false;
			continue;
		}
		if (char === "[") inClass = true;
		else if (char === "/") return j;
	}
	return null;
}

function skipNonCode(source: string, i: number): number | null {
	const char = source[i];
	if (char === "/" && source[i + 1] === "/") {
		const end = source.indexOf("\n", i);
		return end < 0 ? source.length : end;
	}
	if (char === "/" && source[i + 1] === "*") {
		const end = source.indexOf("*/", i + 2);
		return end < 0 ? null : end + 1;
	}
	if (char === "/" && isRegexStart(source, i)) return skipRegex(source, i);
	if (char === '"' || char === "'" || char === "`") {
		for (let j = i + 1; j < source.length; j++) {
			if (source[j] === "\\") j++;
			else if (source[j] === char) return j;
		}
		return null;
	}
	return null;
}

export function functionBody(source: string, anchor: string): string | null {
	const start = source.indexOf(anchor);
	if (start < 0) return null;
	const open = source.indexOf("{", start);
	if (open < 0) return null;
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		const skip = skipNonCode(source, i);
		if (skip !== null) {
			i = skip;
			continue;
		}
		const char = source[i];
		if (char === "{") depth++;
		else if (char === "}") {
			if (depth === 1) {
				if (isStatementEnd(source, i + 1)) return source.slice(open, i + 1);
			} else depth--;
		}
	}
	return null;
}

function bracedBlockEnd(source: string, open: number): number | null {
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		const skip = skipNonCode(source, i);
		if (skip !== null) {
			i = skip;
			continue;
		}
		if (source[i] === "{") depth++;
		else if (source[i] === "}" && --depth === 0) return i;
	}
	return null;
}

export function posixPortion(body: string): string {
	const guard = body.search(/if \(process\.platform === "win32"\)\s*\{/);
	if (guard < 0) return body;
	const open = body.indexOf("{", guard);
	const close = bracedBlockEnd(body, open);
	if (close === null) return body;
	return body.slice(0, guard) + body.slice(close + 1).replace(/^\s*return null;\s*/, "");
}

function isStatementEnd(source: string, at: number): boolean {
	return /^[ \t]*;?[ \t]*(?:\r?\n|$)/.test(source.slice(at, at + 8));
}

function isForkFreeLookup(source: string, anchor: string): boolean {
	const body = functionBody(source, anchor);
	if (body === null) return false;
	const posix = posixPortion(body);
	return !FORKING_CALL.test(posix) && posix.includes("process.env.PATH");
}

export function patchExecutableLookupSource(
	source: string,
	target: ExecutableLookupTarget,
): { code: string; status: PatchStatus } {
	if (source.includes(SENTINEL)) return { code: source, status: "already" };
	const old = target === "shell" ? SHELL_LOOKUP_OLD : TOOLS_LOOKUP_OLD;
	const replacement = target === "shell" ? SHELL_LOOKUP_NEW : TOOLS_LOOKUP_NEW;
	if (source.split(old).length !== 2) {
		return { code: source, status: isForkFreeLookup(source, ANCHORS[target]) ? "already" : "unsupported" };
	}
	return { code: `${PREAMBLE}\n${source.replace(old, replacement)}\n${SENTINEL}\n`, status: "patched" };
}

const LOG_PREFIX = "[executable-lookup]";

const OPT_OUT = new Set(["off", "0", "false", "no"]);
const OPT_IN = new Set(["on", "1", "true", "yes"]);

export function shouldPatchExecutableLookup(
	platform: string = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const flag = (env.PI_WEB_EXEC_LOOKUP ?? "").trim().toLowerCase();
	if (OPT_OUT.has(flag)) return false;
	if (OPT_IN.has(flag)) return true;
	return platform === "android" || Boolean(env.TERMUX_VERSION);
}

export function describeLookupResult(
	target: ExecutableLookupTarget,
	status: PatchStatus,
	url: string,
): { level: "log" | "warn"; message: string } {
	if (status === "unsupported")
		return {
			level: "warn",
			message:
				`${LOG_PREFIX} ${target}: NOT patched — unrecognized SDK source, falling back to the child-process lookup, ` +
				`which can hang on Android/Termux (${url})`,
		};
	return { level: "log", message: `${LOG_PREFIX} ${target}: ${status === "patched" ? "patched" : "already patched"}` };
}

function report(target: ExecutableLookupTarget, status: PatchStatus, url: string): void {
	const { level, message } = describeLookupResult(target, status, url);
	if (level === "warn") console.warn(message);
	else console.log(message);
}

export function isPatchableFormat(format: string | null | undefined): boolean {
	return format === "module" || format === "module-typescript";
}

export function registerExecutableLookupPatch(
	platform: string = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (!shouldPatchExecutableLookup(platform, env)) return;
	const forced = OPT_IN.has((env.PI_WEB_EXEC_LOOKUP ?? "").trim().toLowerCase());
	console.log(
		`${LOG_PREFIX} enabled (${forced ? "PI_WEB_EXEC_LOOKUP" : platform === "android" ? "android" : "termux"}) — ` +
			"resolving SDK host executables from PATH; PI_WEB_EXEC_LOOKUP=off disables",
	);
	registerHooks({
		load(url, context, nextLoad) {
			const target = executableLookupTarget(url);
			if (!target) return nextLoad(url, context);
			const loaded = nextLoad(url, context);
			if (loaded.source == null) return loaded;
			if (!isPatchableFormat(loaded.format)) {
				console.warn(
					`${LOG_PREFIX} ${target}: NOT patched — loaded as ${loaded.format ?? "an unknown format"}, ` +
						`the patch only rewrites ES modules (${url})`,
				);
				return loaded;
			}
			const source = typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
			const result = patchExecutableLookupSource(source, target);
			report(target, result.status, url);
			return result.status === "patched" ? { ...loaded, source: result.code } : loaded;
		},
	});
}
