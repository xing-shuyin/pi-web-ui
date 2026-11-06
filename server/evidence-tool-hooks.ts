import { join } from "node:path";

type ToolContext = {
	toolCall: { name: string; arguments?: unknown };
	args: unknown;
	signal?: AbortSignal;
};
type BeforeToolCall = (this: unknown, context: ToolContext, parentId?: string) => unknown;
type HookSession = {
	_beforeToolCall: BeforeToolCall;
	sessionManager: { getSessionFile(): string | undefined };
};

const installed = new WeakMap<object, BeforeToolCall>();
const PREFIX = "context-evidence:";

export function installEvidenceToolHooks(session: unknown): boolean {
	if (!session || typeof session !== "object") return false;
	const target = session as HookSession;
	const original = target._beforeToolCall;
	if (typeof original !== "function" || original.length !== 2) return false;
	if (installed.get(target) === original) return true;
	if (typeof target.sessionManager?.getSessionFile !== "function") return false;

	const wrapper: BeforeToolCall = function (context, parentId) {
		if (context.toolCall.name === "read" && context.args && typeof context.args === "object") {
			const args = context.args as Record<string, unknown>;
			const values = [args.path, args.file_path];
			const references = values.filter(
				(value): value is string => typeof value === "string" && value.startsWith(PREFIX),
			);
			if (references.length) {
				context.signal?.throwIfAborted();
				const reference = references[0];
				const match = /^context-evidence:([a-f0-9]{64})$/.exec(reference);
				const isIndex = reference === `${PREFIX}index`;
				if (
					(!isIndex && (!match || reference.length !== PREFIX.length + 64)) ||
					values.some((value) => value !== undefined && value !== reference)
				) {
					throw new Error("Invalid or conflicting evidence reference");
				}
				const sessionFile = target.sessionManager.getSessionFile();
				if (!sessionFile) throw new Error("Evidence requires a persisted session");
				if (args === context.toolCall.arguments) {
					throw new Error("Evidence arguments must not alias tool call history");
				}
				context.signal?.throwIfAborted();
				const directory = `${sessionFile}.evidence`;
				const path = isIndex ? directory : join(directory, `${match![1]}.txt`);
				args.path = path;
				args.file_path = path;
			}
		}
		return original.call(this, context, parentId);
	};
	target._beforeToolCall = wrapper;
	installed.set(target, wrapper);
	return true;
}
