/**
 * Fork-free executable lookup for Android/Termux.
 *
 * Background: on POSIX the SDK resolves host executables with `spawnSync("which", …)`
 * (`dist/utils/shell.js`) and probes availability with `spawnSync(cmd, ["--version"])`
 * (`dist/utils/tools-manager.js`). On Android/Termux forking a child process can stall
 * before it ever execs, so those probes never return and the first tool call hangs the
 * server instead of failing fast. Both are pure lookups, so this patch answers them from
 * PATH — no child process involved.
 *
 * The SDK sources are transformed in memory before compilation, never on disk (same seam
 * as `server/patch-bash-process.ts`). The patch therefore survives every
 * `npm i -g @earendil-works/pi-coding-agent` and applies to whichever copy
 * `resolve-global-sdk.ts` picks. Drop this module once the SDK resolves executables from
 * PATH itself.
 *
 * Two properties matter more than brevity here:
 *
 * 1. The replacement never relies on a binding that happens to exist in the SDK version
 *    at hand — it carries its own imports (`PREAMBLE`). Otherwise a version whose module
 *    header differs (SDK 1.1.0 has no `shellPathExists`) throws a ReferenceError that the
 *    surrounding `catch` swallows, and the hook reports `patched` while shell discovery
 *    silently falls back to `sh`.
 * 2. It keeps the *semantics* of executable lookup: an entry only counts when it is a
 *    real file we may execute — not a directory and not an inert file. Existence alone
 *    made `ensureTool` claim a tool it could not spawn (`ENOENT` right after).
 */
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

/**
 * Self-contained definitions the replacement uses, injected ahead of the SDK source.
 * Aliased names cannot collide with the SDK's own imports, so this works for every
 * module header — including the shapes that predate `shellPathExists`.
 */
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

/** SDK 1.4.0 shape: `which` child process in the POSIX branch of findExecutableOnPath. */
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

/** SDK 1.4.0 shape: `--version` child process probe in commandExists. */
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

/** Which target a loaded module URL belongs to, or null when it is not ours to touch. */
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

/** Any child process a lookup could still be forking through, however it is spelled. */
const FORKING_CALL = /\b(?:spawnSync|execSync|execFileSync)\s*\(/;

/**
 * Body of the function starting at `anchor`, or null when it is not there.
 * Skips comments and string/template contents so braces inside them cannot unbalance it.
 */
export function functionBody(source: string, anchor: string): string | null {
	const start = source.indexOf(anchor);
	if (start < 0) return null;
	const open = source.indexOf("{", start);
	if (open < 0) return null;
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		const char = source[i];
		if (char === "/" && source[i + 1] === "/") {
			const end = source.indexOf("\n", i);
			if (end < 0) break;
			i = end;
			continue;
		}
		if (char === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			if (end < 0) break;
			i = end + 1;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			const quote = char;
			for (i++; i < source.length; i++) {
				if (source[i] === "\\") {
					i++;
					continue;
				}
				if (source[i] === quote) break;
			}
			continue;
		}
		if (char === "{") depth++;
		else if (char === "}") {
			// Only a brace that ends the line can close the function. A `}` inside a regex
			// literal sits mid-statement, and treating it as the end would truncate the body —
			// hiding a child process that comes later and reporting the lookup as fixed.
			if (depth === 1) {
				if (isStatementEnd(source, i + 1)) return source.slice(open, i + 1);
			} else depth--;
		}
	}
	return null;
}

/** Whitespace (and an optional `;`) up to the end of the line — a statement boundary. */
function isStatementEnd(source: string, at: number): boolean {
	return /^[ \t]*;?[ \t]*(?:\r?\n|$)/.test(source.slice(at, at + 8));
}

/**
 * A lookup counts as already fork-free only when that is positively identifiable:
 * the function is still there, it scans `process.env.PATH`, and it forks nothing.
 * Anything else — a reformatted probe, an unknown rewrite — stays `unsupported`, so an
 * unrecognized SDK never gets reported as fixed while the probe is still in the way.
 */
function isForkFreeLookup(source: string, anchor: string): boolean {
	const body = functionBody(source, anchor);
	if (body === null) return false;
	return !FORKING_CALL.test(body) && body.includes("process.env.PATH");
}

export function patchExecutableLookupSource(
	source: string,
	target: ExecutableLookupTarget,
): { code: string; status: PatchStatus } {
	if (source.includes(SENTINEL)) return { code: source, status: "already" };
	const old = target === "shell" ? SHELL_LOOKUP_OLD : TOOLS_LOOKUP_OLD;
	const replacement = target === "shell" ? SHELL_LOOKUP_NEW : TOOLS_LOOKUP_NEW;
	// Exact, single occurrence: a moved or rewritten lookup must fail loudly, never
	// half-apply, because the alternative is a silently hanging server.
	if (source.split(old).length !== 2) {
		return { code: source, status: isForkFreeLookup(source, ANCHORS[target]) ? "already" : "unsupported" };
	}
	return { code: `${PREAMBLE}\n${source.replace(old, replacement)}\n${SENTINEL}\n`, status: "patched" };
}

const LOG_PREFIX = "[executable-lookup]";

const OPT_OUT = new Set(["off", "0", "false", "no"]);
const OPT_IN = new Set(["on", "1", "true", "yes"]);

/** Android/Termux only by default; `PI_WEB_EXEC_LOOKUP=off` opts out, `=on` forces. */
export function shouldPatchExecutableLookup(
	platform: string = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const flag = (env.PI_WEB_EXEC_LOOKUP ?? "").trim().toLowerCase();
	if (OPT_OUT.has(flag)) return false;
	if (OPT_IN.has(flag)) return true;
	return platform === "android" || Boolean(env.TERMUX_VERSION);
}

/** Logged once per target, so every restart states whether the patch is really in place. */
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

/** Only ES modules can take the preamble; everything else keeps the SDK's own lookup. */
export function isPatchableFormat(format: string | null | undefined): boolean {
	return format === "module" || format === "module-typescript";
}

/* SDK sources are transformed in memory before compilation, never on disk. */
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
			// The preamble is an ES module head; injecting it into CommonJS would break the
			// load instead of falling back to the lookup we were trying to improve.
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
