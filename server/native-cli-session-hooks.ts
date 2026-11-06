import { createHash } from "node:crypto";
import { portableAtomicWriteSyncSource } from "./atomic-file.js";

/** Lifecycle data is deliberately independent of prompt/tool/result payloads. */
export type NativeCliSessionEvent =
	| { type: "session"; eventId: string; nativeId: string; cursor?: string }
	| { type: "submitted"; eventId: string }
	| { type: "working" | "question" | "approval"; eventId: string }
	| { type: "done"; eventId: string; aborted?: boolean }
	| { type: "error"; eventId: string; code: string; message: string };

export type NativeCliHookEvent = {
	type: "session" | "submitted" | "working" | "done" | "question" | "approval" | "error";
	eventId: string;
	nativeId?: string;
	aborted?: boolean;
};

export const NATIVE_CLI_EVENT_LIMIT = 128;
export const NATIVE_CLI_EVENT_BYTES = 2048;
const EVENT_TYPES = new Set(["session", "submitted", "working", "done", "question", "approval", "error"]);

/** Parse only our reporter's small whitelist, never CLI output or transcript content. */
export function parseNativeCliHookEvent(text: string): NativeCliHookEvent | undefined {
	if (Buffer.byteLength(text) > NATIVE_CLI_EVENT_BYTES) return undefined;
	try {
		const value = JSON.parse(text);
		if (!value || !EVENT_TYPES.has(value.type) || typeof value.eventId !== "string") return undefined;
		if (!/^[a-zA-Z0-9_.:-]{1,200}$/.test(value.eventId)) return undefined;
		const nativeId = value.nativeId;
		if (
			nativeId !== undefined &&
			(typeof nativeId !== "string" || nativeId.length > 1024 || /[\x00-\x1f\x7f]/.test(nativeId))
		)
			return undefined;
		return {
			type: value.type,
			eventId: value.eventId,
			...(nativeId ? { nativeId } : {}),
			...(value.type === "done" && value.aborted === true ? { aborted: true } : {}),
		};
	} catch {
		return undefined;
	}
}

export function nativeCliEventId(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function quoteNativeCliShell(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * POSIX reporter for Claude/Codex. No Node/Python dependency on the remote host.
 * Read a bounded prefix of stdin in memory; never persist the hook payload.
 * Atomic, private, bounded event files survive server disconnects and tmux reattach.
 */
export function nativeCliPosixReporter(directory: string): string {
	return `#!/bin/sh
umask 077
dir=${quoteNativeCliShell(directory)}
[ -d "$dir/events" ] || exit 0
kind=$1
payload=$(dd bs=4096 count=64 2>/dev/null)
# Drain the remaining pipe without retaining it, so upstream hook writers do not get EPIPE.
cat >/dev/null
extract() {
 printf '%s' "$payload" | awk -v wanted="$1" '
 BEGIN { depth=0; quoted=0; escaped=0; token=""; previous=""; key="" }
 {
  for (i=1; i<=length($0); i++) {
   c=substr($0,i,1)
   if (quoted) {
    if (escaped) { escaped=0; invalid=1; continue }
    if (c=="\\\\") { escaped=1; continue }
    if (c=="\\\"") {
     quoted=0
     if (depth==1 && !invalid) {
      if (role=="key") key=token
      else if (role=="value" && key==wanted) { print token; exit }
     }
     previous="string"; continue
    }
    if (depth==1) token=token c
    continue
   }
   if (c=="\\\"") { quoted=1; token=""; invalid=0; role=(depth==1 && (previous=="{" || previous==",") ? "key" : (depth==1 && previous==":" ? "value" : "other")); continue }
   if (c=="{" || c=="[") depth++
   if (c=="}" || c=="]") depth--
   if (c !~ /[[:space:]]/) previous=c
  }
 }'
}
native=$(extract session_id)
case "$native" in *[!a-fA-F0-9-]*) native= ;; esac
case "$native" in ????????-????-????-????-????????????) ;; *) native= ;; esac
case "$kind" in
 submitted) [ "$(extract hook_event_name)" = UserPromptSubmit ] || exit 0 ;;
 notification)
  notification=$(extract notification_type)
  case "$notification" in permission_prompt) kind=approval ;; elicitation_dialog) kind=question ;; *) exit 0 ;; esac ;;
 session|working|done|question|approval|error) ;;
 *) exit 0 ;;
esac
stamp=$(date +%s%N 2>/dev/null | tr -cd '0-9')
[ -n "$stamp" ] || stamp=0
id="$stamp-$$-$kind"
if [ "$kind" = session ] && [ -n "$native" ]; then
 printf '%s' "$native" > "$dir/.native-id.$$" && mv -f "$dir/.native-id.$$" "$dir/native-id"
fi
file="$dir/events/$id.json"
tmp="$file.tmp"
printf '{"eventId":"%s","type":"%s","nativeId":"%s"}\\n' "$id" "$kind" "$native" > "$tmp" || exit 0
chmod 600 "$tmp" 2>/dev/null
mv -f "$tmp" "$file" 2>/dev/null
set -- "$dir"/events/*.json
while [ "$#" -gt ${NATIVE_CLI_EVENT_LIMIT} ]; do rm -f "$1"; shift; done
exit 0
`;
}

/** Uses Pi's public extension API and final-settlement/UI events, not screen text. */
export function nativeCliPiExtension(directory: string): string {
	return `import { mkdirSync, readdirSync, unlinkSync, existsSync, chmodSync } from "node:fs";
import * as atomicFs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const directory = ${JSON.stringify(directory)};
${portableAtomicWriteSyncSource()}
export default function(pi) {
 let failed = false;
 const report = (type, ctx, aborted) => {
  try {
   const events = join(directory, "events");
   mkdirSync(events, { recursive: true, mode: 0o700 });
   const eventId = String(Date.now()).padEnd(19, "0") + "-" + randomUUID();
   const nativeId = ctx.sessionManager.getSessionFile();
   const record = { eventId, type, ...(nativeId && existsSync(nativeId) ? { nativeId } : {}), ...(type === "done" && aborted === true ? { aborted: true } : {}) };
   if (record.nativeId) {
    chmodSync(record.nativeId, 0o600);
    const binding = join(directory, "native-id");
    writeAtomicPortable(atomicFs, binding, record.nativeId, randomUUID(), 0o600);
   }
   const file = join(events, eventId + ".json");
   writeAtomicPortable(atomicFs, file, JSON.stringify(record), randomUUID(), 0o600);
   const names = readdirSync(events).filter(name => /^[a-zA-Z0-9_.-]+\\.json$/.test(name)).sort();
   for (const name of names.slice(0, Math.max(0, names.length - ${NATIVE_CLI_EVENT_LIMIT}))) { try { unlinkSync(join(events, name)); } catch {} }
  } catch { /* A reporter must never interrupt the CLI. */ }
 };
 pi.on("session_start", (_event, ctx) => report("session", ctx));
 pi.on("input", (event, ctx) => { if (event.source === "interactive") report("submitted", ctx); });
 pi.on("agent_start", (_event, ctx) => { failed = false; report("working", ctx); });
 pi.on("agent_settled", (event, ctx) => report(!event.aborted && failed ? "error" : "done", ctx, event.aborted));
 pi.on("message_end", (event) => { if (event.message?.role === "assistant") failed = event.message.stopReason === "error"; });
 pi.on("ui_prompt_start", (event, ctx) => report(event.kind === "confirm" ? "approval" : "question", ctx));
 pi.on("ui_prompt_end", (_event, ctx) => report(ctx.isIdle() ? "done" : "working", ctx));
}
`;
}

export function nativeCliCodexHookConflicts(text: string): Set<string> {
	const events = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop", "PreToolUse", "PostToolUse"];
	const identifiers = new Set<string>();
	// Ambiguous mentions may suppress an adapter hook; preserving user hooks takes priority.
	for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z_][A-Za-z0-9_-]*/g)) {
		let identifier = match[0];
		if (identifier.startsWith("'")) {
			if (/[\r\n]/.test(identifier)) return new Set(events);
			identifier = identifier.slice(1, -1);
		} else if (identifier.startsWith('"')) {
			try {
				identifier = JSON.parse(
					identifier.replace(/\\U([0-9a-fA-F]{8})/g, (_escape, hex) => String.fromCodePoint(Number.parseInt(hex, 16))),
				);
			} catch {
				// Unrecognized quoted syntax cannot safely authorize overriding configuration.
				return new Set(events);
			}
		}
		if (identifier === "hooks" || events.includes(identifier)) identifiers.add(identifier);
	}
	if (!identifiers.has("hooks")) return new Set();
	const result = new Set(events.filter((event) => identifiers.has(event)));
	return result.size ? result : new Set(events);
}
