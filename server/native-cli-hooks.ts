/**
 * Native CLI hook wiring: one event model, one dispatcher, per-engine config.
 *
 * Engines disagree on *how* to learn about lifecycle: Claude/Codex take hook config on the command
 * line, agy only reads a `hooks.json` from a customization root (its `--settings` rejects a `hooks`
 * key outright). They also disagree on payload keys (`conversationId` vs `session_id`) and on the
 * meaning of an empty hook result (agy denies a tool on `{}`). Everything engine-specific lives in
 * the tables below; the dispatcher script is generated from them, so the mapping has one source.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { writeAtomic } from "./atomic-file.js";
import path from "node:path";

/** Superset every engine is measured against; engines emit the subset they support. */
export const NATIVE_CLI_HOOK_TYPES = [
	"session",
	"submitted",
	"working",
	"tool",
	"approval",
	"question",
	"notification",
	"compact",
	"subagent",
	"done",
	"error",
	"end",
] as const;
export type NativeCliHookType = (typeof NATIVE_CLI_HOOK_TYPES)[number];

/**
 * Rule order matters: the first matching rule wins, so the tool-specific subagent rules precede the
 * generic tool rules and the error variants precede plain `Stop`.
 */
export interface NativeCliHookRule {
	/** Engine event name as written in that engine's hook config. */
	event: string;
	type: NativeCliHookType;
	/** Only apply when `toolCall.name` equals this value. */
	tool?: string;
	/** Only apply when `terminationReason` equals this value. */
	termination?: string;
	/** Only apply when `invocationNum` equals this value. */
	invocation?: number;
	/** Only apply when `notification_type`/`notificationType` equals this value. */
	notification?: string;
}

export const NATIVE_CLI_HOOK_RULES: readonly NativeCliHookRule[] = [
	{ event: "SessionStart", type: "session" },
	{ event: "SessionEnd", type: "end" },
	{ event: "UserPromptSubmit", type: "submitted" },
	// agy has no prompt-submit event; PreInvocation 0 is the first model call of a user turn.
	{ event: "PreInvocation", type: "submitted", invocation: 0 },
	{ event: "PreInvocation", type: "working" },
	{ event: "PostInvocation", type: "working" },
	{ event: "Notification", type: "approval", notification: "permission_prompt" },
	{ event: "Notification", type: "question", notification: "elicitation_dialog" },
	{ event: "Notification", type: "notification" },
	{ event: "PermissionRequest", type: "approval" },
	{ event: "PreCompact", type: "compact" },
	{ event: "PostCompact", type: "compact" },
	{ event: "SubagentStart", type: "subagent" },
	{ event: "SubagentStop", type: "subagent" },
	{ event: "PreToolUse", type: "subagent", tool: "invoke_subagent" },
	{ event: "PostToolUse", type: "subagent", tool: "invoke_subagent" },
	{ event: "PreToolUse", type: "tool" },
	{ event: "PostToolUse", type: "tool" },
	{ event: "Stop", type: "error", termination: "ERROR" },
	{ event: "StopFailure", type: "error" },
	// An interrupted turn still ends the turn for the UI.
	{ event: "StopInterrupt", type: "done" },
	{ event: "Stop", type: "done" },
];

/** What each engine can actually report; the dispatcher never invents events outside this set. */
export const NATIVE_CLI_HOOK_CAPABILITIES: Record<string, readonly NativeCliHookType[]> = {
	// agy has no permission event: "approval" is synthesized by the dispatcher when a gated tool
	// turns into PreToolUse decision "ask".
	agy: ["session", "submitted", "working", "tool", "approval", "subagent", "done", "error"],
	claude: [...NATIVE_CLI_HOOK_TYPES],
	codex: ["session", "submitted", "working", "tool", "approval", "compact", "subagent", "done", "error", "end"],
	pi: ["session", "submitted", "working", "question", "approval", "done", "error"],
	dsh: [],
	custom: [],
};

export interface NativeCliHookEngineSpec {
	/** Engine events this engine will have configured, in the order the engine expects them. */
	events: readonly string[];
	/** Flat events take handler arrays directly; grouped events wrap them in a matcher group. */
	grouped: readonly string[];
	/** Tool matcher used for grouped events. */
	matcher: string;
}

export const NATIVE_CLI_HOOK_ENGINES: Record<string, NativeCliHookEngineSpec> = {
	agy: {
		events: ["SessionStart", "PreInvocation", "PreToolUse", "PostToolUse", "PostInvocation", "Stop"],
		grouped: ["PreToolUse", "PostToolUse"],
		matcher: "*",
	},
	claude: {
		events: [
			"SessionStart",
			"UserPromptSubmit",
			"PreToolUse",
			"PostToolUse",
			"Notification",
			"PermissionRequest",
			"PreCompact",
			"SubagentStart",
			"SubagentStop",
			"Stop",
			"StopFailure",
			"SessionEnd",
		],
		// Claude requires the matcher wrapper on every event (only agy accepts flat handler arrays).
		grouped: [
			"SessionStart",
			"UserPromptSubmit",
			"PreToolUse",
			"PostToolUse",
			"Notification",
			"PermissionRequest",
			"PreCompact",
			"SubagentStart",
			"SubagentStop",
			"Stop",
			"StopFailure",
			"SessionEnd",
		],
		matcher: "*",
	},
	codex: {
		// codex-cli 0.170.0 supports these events; the payload is Claude-shaped
		// (hook_event_name / session_id / transcript_path).
		events: [
			"SessionStart",
			"UserPromptSubmit",
			"PreToolUse",
			"PostToolUse",
			"PermissionRequest",
			"PreCompact",
			"PostCompact",
			"SubagentStart",
			"SubagentStop",
			"Stop",
			"StopInterrupt",
			"SessionEnd",
		],
		// Every codex event takes the matcher-wrapped shape.
		grouped: [
			"SessionStart",
			"UserPromptSubmit",
			"PreToolUse",
			"PostToolUse",
			"PermissionRequest",
			"PreCompact",
			"PostCompact",
			"SubagentStart",
			"SubagentStop",
			"Stop",
			"StopInterrupt",
			"SessionEnd",
		],
		matcher: "*",
	},
};

/** Hook name used inside shared config files; user hooks keep their own names and still run. */
export const NATIVE_CLI_HOOK_ENTRY = "pi-web-ui-observer";

/** agy reads hooks from a customization root, not from `--settings`. */
export function agySharedHooksPath(home: string): string {
	return path.join(home, ".gemini", "config", "hooks.json");
}

export interface NativeCliHookHandler {
	type: "command";
	command: string;
	timeout: number;
}

function handler(command: string, timeout = 5): NativeCliHookHandler {
	return { type: "command", command, timeout };
}

/** Event → handlers for one engine, using that engine's flat/grouped shape. */
export function nativeCliHookEvents(
	engine: string,
	command: string,
	timeout = 5,
): Record<string, NativeCliHookHandler[] | Array<{ matcher: string; hooks: NativeCliHookHandler[] }>> {
	const spec = NATIVE_CLI_HOOK_ENGINES[engine];
	if (!spec) throw new Error(`No hook profile for engine: ${engine}`);
	const result: Record<string, unknown> = {};
	for (const event of spec.events) {
		result[event] = spec.grouped.includes(event)
			? [{ matcher: spec.matcher, hooks: [handler(command, timeout)] }]
			: [handler(command, timeout)];
	}
	return result as Record<string, NativeCliHookHandler[]>;
}

/** The named entry agy's shared `hooks.json` gets; merge it in, never replace the file. */
export function agySharedHookEntry(command: string, timeout = 5): Record<string, unknown> {
	return nativeCliHookEvents("agy", command, timeout);
}

export class SharedHookConfigError extends Error {}

/**
 * Merge our named entry into an existing hooks document. Other named hooks are preserved verbatim so
 * a user's own hooks keep working; malformed documents are rejected instead of overwritten.
 */
export function mergeAgySharedHooks(existing: string | null, command: string, timeout = 5): string {
	let document: Record<string, unknown> = {};
	if (existing?.trim()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(existing);
		} catch {
			throw new SharedHookConfigError("Existing hooks.json is not valid JSON");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			throw new SharedHookConfigError("Existing hooks.json is not a JSON object");
		document = parsed as Record<string, unknown>;
	}
	document[NATIVE_CLI_HOOK_ENTRY] = agySharedHookEntry(command, timeout);
	const ordered: Record<string, unknown> = {};
	for (const key of Object.keys(document).sort()) ordered[key] = document[key];
	return JSON.stringify(ordered, null, 2) + "\n";
}

/** Claude/Codex hook objects for command-line injection (`--settings` / `--config`). */
export function claudeHookSettings(command: string, timeout = 5): string {
	return JSON.stringify({ hooks: nativeCliHookEvents("claude", command, timeout) });
}

export function codexHookConfigArgs(command: string, timeout = 5): string[] {
	const args: string[] = [];
	const events = nativeCliHookEvents("codex", command, timeout) as Record<
		string,
		Array<{ matcher?: string; hooks?: NativeCliHookHandler[] }> | NativeCliHookHandler[] | undefined
	>;
	for (const [event, entry] of Object.entries(events)) {
		if (!entry?.length) continue;
		const spec = NATIVE_CLI_HOOK_ENGINES.codex;
		const grouped = spec.grouped.includes(event);
		const toml = grouped
			? (entry as Array<{ matcher: string; hooks: NativeCliHookHandler[] }>)
					.map(
						(group) =>
							`{ matcher = ${JSON.stringify(group.matcher)}, hooks = [{ type = "command", command = ${JSON.stringify(
								group.hooks[0].command,
							)}, timeout = ${group.hooks[0].timeout} }] }`,
					)
					.join(", ")
			: (entry as NativeCliHookHandler[])
					.map((flat) => `{ type = "command", command = ${JSON.stringify(flat.command)}, timeout = ${flat.timeout} }`)
					.join(", ");
		args.push("--config", `hooks.${event}=[${toml}]`);
	}
	return args;
}

/** Per-engine stdout policy. agy treats an empty `{}` from PreToolUse as a denial. */
function outputPolicy(engine: string): { preToolUse: string; other: string } {
	return engine === "agy" ? { preToolUse: '{"decision":"allow"}', other: "{}" } : { preToolUse: "", other: "" };
}

/**
 * The dispatcher every engine points at. It routes by the identity carried in the payload, so one
 * shared config serves every conversation; each session reads only its own directory.
 */
export interface NativeCliHookApprovalPolicy {
	/** "allow" leaves every tool call untouched; "ask" routes matched tools to the CLI prompt. */
	mode: "allow" | "ask";
	/** Exact tool names, or "*" for every tool. Empty means no tool is gated. */
	tools: readonly string[];
}

export const NATIVE_CLI_HOOK_ALLOW_ALL: NativeCliHookApprovalPolicy = { mode: "allow", tools: [] };

export function nativeCliHookDispatcher(options: {
	engine: string;
	spoolDir: string;
	limit?: number;
	approval?: NativeCliHookApprovalPolicy;
}): string {
	const limit = options.limit ?? 128;
	const approval = options.approval ?? NATIVE_CLI_HOOK_ALLOW_ALL;
	const policy = outputPolicy(options.engine);
	return `// Generated by pi-web-ui. Routes ${options.engine} hook payloads into per-conversation spools.
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const SPOOL = ${JSON.stringify(options.spoolDir)};
const KEY_ENV = ${JSON.stringify(NATIVE_CLI_HOOK_KEY_ENV)};
const KEY = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
const RULES = ${JSON.stringify(NATIVE_CLI_HOOK_RULES)};
const CAPABILITIES = ${JSON.stringify(NATIVE_CLI_HOOK_CAPABILITIES[options.engine] ?? [])};
const OUT = ${JSON.stringify(policy)};
const APPROVAL = ${JSON.stringify(approval)};
const APPROVAL_ENV = process.env.PI_WEB_NATIVE_CLI_APPROVAL || "";
if (APPROVAL_ENV) {
 const [mode, list] = APPROVAL_ENV.split(":");
 APPROVAL.mode = mode === "ask" ? "ask" : "allow";
 APPROVAL.tools = (list || "").split(",").map((name) => name.trim()).filter(Boolean);
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,200}$/;
const UUIDISH = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
function read() {
 let data = "";
 let size = 0;
 try {
  process.stdin.setEncoding("utf8");
  return new Promise((resolve) => {
   process.stdin.on("data", (chunk) => { if (size < 65536) { data += String(chunk).slice(0, 65536 - size); size += chunk.length; } });
   process.stdin.on("end", () => resolve(data));
   process.stdin.on("error", () => resolve(data));
  });
 } catch { return Promise.resolve(""); }
}
function pick(payload, keys) { for (const key of keys) { const value = payload[key]; if (typeof value === "string" && value) return value; } return ""; }
function match(rule, event, tool, termination, invocation, notification) {
 if (rule.event !== event) return false;
 if (rule.tool !== undefined && rule.tool !== tool) return false;
 if (rule.termination !== undefined && rule.termination !== termination) return false;
 if (rule.invocation !== undefined && rule.invocation !== invocation) return false;
 if (rule.notification !== undefined && rule.notification !== notification) return false;
 return true;
}
function write(nativeId, type, at, routeKey) {
 if (!CAPABILITIES.includes(type)) return;
 const target = join(SPOOL, routeKey);
 mkdirSync(target, { recursive: true, mode: 0o700 });
 const eventId = String(at).padStart(19, "0") + "-" + process.pid + "-" + type;
 const file = join(target, eventId + ".json");
 const record = JSON.stringify({ eventId, type, nativeId, at: new Date(at).toISOString() });
 // 事件名按「毫秒+pid+类型」唯一，直接用独占创建代替 tmp+rename：少一次 inode 往返，也不会互相覆盖。
 try { writeFileSync(file, record, { flag: "wx", mode: 0o600 }); } catch {}
 const names = readdirSync(target).filter((name) => /^[0-9]{19}-[0-9]+-[a-z]+\\.json$/.test(name)).sort();
 for (const stale of names.slice(0, Math.max(0, names.length - ${limit}))) { try { unlinkSync(join(target, stale)); } catch {} }
}
const raw = await read();
let payload = {};
try { payload = JSON.parse(raw) || {}; } catch { payload = {}; }
const event = pick(payload, ["hookEventName", "hook_event_name"]);
const nativeId = pick(payload, ["conversationId", "conversation_id", "session_id", "sessionId"]);
const tool = payload?.toolCall?.name || payload?.tool_name || "";
const termination = payload?.terminationReason || "";
const invocation = typeof payload?.invocationNum === "number" ? payload.invocationNum : -1;
const notification = pick(payload, ["notification_type", "notificationType"]);
const validId = UUIDISH.test(nativeId) || (ID.test(nativeId) && nativeId.length >= 8 && !nativeId.includes(".."));
// Launch-time routing: the CLI inherits this env var, so concurrent conversations never share a spool.
const routeKey = KEY.test(String(process.env[KEY_ENV] || "")) ? String(process.env[KEY_ENV]) : "";
if (event && validId && routeKey) {
 const rule = RULES.find((candidate) => match(candidate, event, tool, termination, invocation, notification));
 if (rule) { try { write(nativeId, rule.type, Date.now(), routeKey); } catch {} }
}
// Approval synthesis: agy has no permission event, so a gated tool turns into "ask" here and
// becomes an approval state for the UI instead of a silent auto-approval.
let ask = false;
if (event === "PreToolUse" && APPROVAL.mode === "ask" && (APPROVAL.tools.includes("*") || APPROVAL.tools.includes(tool))) {
 ask = true;
 if (validId && routeKey) { try { write(nativeId, "approval", Date.now(), routeKey); } catch {} }
}
const out = ask && OUT.preToolUse
 ? '{"decision":"ask"}'
 : event === "PreToolUse" || event === "PermissionRequest"
  ? OUT.preToolUse
  : OUT.other;
if (out) process.stdout.write(out);
process.exit(0);
`;
}

/** Load/merge/verify the shared agy hooks document; returns the command that is now installed. */
export async function ensureAgySharedHooks(
	home: string,
	command: string,
	options: { timeout?: number } = {},
): Promise<{ path: string; changed: boolean }> {
	const file = agySharedHooksPath(home);
	let existing: string | null = null;
	try {
		existing = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const next = mergeAgySharedHooks(existing, command, options.timeout);
	if (existing !== null && existing === next) return { path: file, changed: false };
	await mkdir(path.dirname(file), { recursive: true });
	await writeAtomic(file, next, { mode: 0o600 });
	return { path: file, changed: true };
}

/** Only our named entry is removed; user hooks stay in place. */
export async function removeAgySharedHooks(home: string): Promise<boolean> {
	const file = agySharedHooksPath(home);
	let existing: string;
	try {
		existing = await readFile(file, "utf8");
	} catch {
		return false;
	}
	let document: Record<string, unknown>;
	try {
		const parsed = JSON.parse(existing);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
		document = parsed as Record<string, unknown>;
	} catch {
		return false;
	}
	if (!Object.hasOwn(document, NATIVE_CLI_HOOK_ENTRY)) return false;
	delete document[NATIVE_CLI_HOOK_ENTRY];
	const next = Object.keys(document).length ? JSON.stringify(document, null, 2) + "\n" : "";
	if (next) await writeFile(file, next, { mode: 0o600 });
	else await rm(file, { force: true });
	return true;
}

/** The CLI inherits this variable, so one shared hook config routes per conversation exactly. */
export const NATIVE_CLI_HOOK_KEY_ENV = "PI_WEB_NATIVE_CLI_KEY";

/** One directory per conversation keeps each session reading only its own events. */
export function nativeCliHookSpoolDir(dataDir: string): string {
	return path.join(dataDir, "native-cli", "hook-spool");
}

/**
 * Codex runs hook commands without a shell: `"node" "script"` is treated as one literal file name
 * and silently never runs (measured on codex-cli 0.170.0). Windows needs the cmd wrapper; agy and
 * claude go through a shell and keep the plain quoted form.
 */
export function nativeCliHookCommand(
	engine: string,
	nodePath: string,
	scriptPath: string,
	platform = process.platform,
): string {
	if (engine !== "codex") return `"${nodePath}" "${scriptPath}"`;
	return platform === "win32" ? `cmd /c ""${nodePath}" "${scriptPath}""` : `${nodePath} ${scriptPath}`;
}
