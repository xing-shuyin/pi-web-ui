import type { PageScript, ScriptRunReport } from "../runtime/scripts.js";

/**
 * `script.*` 操作面：Agent 脚本注入的线协议实现。
 *
 * 放在 automation 里而不是塞进 `runPageOperation`：页面脚本在**主进程侧**注入
 * （webContents.insertCSS / executeJavaScript / CDP），不像 read/click 那样在页面里跑一段函数。
 */
export interface BrowserScriptHost {
	listPageScripts(): PageScript[];
	findPageScript(id?: string, name?: string): PageScript | undefined;
	savePageScript(input: unknown, options?: { createdBy?: "agent" | "user" }): PageScript;
	/** tabId 或 origin → origin；用来给省略 matches 的新脚本一个保守默认值 */
	resolveScriptOrigin?(target?: string): string | undefined;
	removePageScript(id: string): boolean;
	setPageScriptEnabled(id: string, enabled: boolean): boolean;
	runPageScript(ref: string, tabId?: string): Promise<ScriptRunReport>;
	pageScriptStatus(tabId?: string): Record<string, unknown>;
}

export const SCRIPT_OPS = ["list", "status", "create", "update", "remove", "enable", "disable", "run"] as const;

export type ScriptOp = (typeof SCRIPT_OPS)[number];

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function requireRef(args: Record<string, unknown>): string {
	const ref = str(args.id) || str(args.name);
	if (!ref) throw new Error("This script operation needs `id` or `name` (get one from script.list)");
	return ref;
}

/** 只保留脚本字段，其它键（op/action 之类）一律不落盘。 */
function scriptPayload(args: Record<string, unknown>): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	for (const key of [
		"id",
		"name",
		"matches",
		"code",
		"css",
		"runAt",
		"world",
		"spa",
		"enabled",
		"persist",
		"persistent",
	] as const) {
		if (args[key] !== undefined) payload[key] = args[key];
	}
	// `persist` 是给模型用的口语字段，落盘字段叫 persistent
	if (typeof args.persist === "boolean") payload.persistent = args.persist;
	return payload;
}

function tabTarget(args: Record<string, unknown>, target?: string): string | undefined {
	return str(args.tabId) || (target && target.trim() ? target.trim() : undefined);
}

export async function runScriptOperation(
	host: BrowserScriptHost,
	op: string,
	args: Record<string, unknown>,
	target?: string,
): Promise<unknown> {
	switch (op) {
		case "list":
			return { scripts: host.listPageScripts() };
		case "status":
			return host.pageScriptStatus(tabTarget(args, target));
		case "create":
		case "update": {
			const payload = scriptPayload(args);
			if (op === "update" && !str(payload.id) && !str(payload.name)) requireRef(args);
			const existing = host.findPageScript(str(payload.id) || undefined, str(payload.name) || undefined);
			// 新建时省略 matches：默认只作用于当前/指定标签的站点，而不是全站（显式传 [] 或 "*" 才放开）
			if (!existing && payload.matches === undefined) {
				const origin = host.resolveScriptOrigin?.(tabTarget(args, target));
				if (origin) payload.matches = [origin];
			}
			const script = host.savePageScript(payload, { createdBy: "agent" });
			return {
				script,
				note: script.persistent
					? "Saved permanently; it runs automatically on matching pages from now on."
					: "Saved for this browser session only; it disappears when the app restarts.",
			};
		}
		case "remove": {
			const ref = requireRef(args);
			const script = host.findPageScript(ref, ref);
			if (!script) throw new Error(`Unknown page script: ${ref}`);
			return { removed: host.removePageScript(script.id), id: script.id, name: script.name };
		}
		case "enable":
		case "disable": {
			const ref = requireRef(args);
			const script = host.findPageScript(ref, ref);
			if (!script) throw new Error(`Unknown page script: ${ref}`);
			return { id: script.id, enabled: host.setPageScriptEnabled(script.id, op === "enable") };
		}
		case "run": {
			const ref = requireRef(args);
			return host.runPageScript(ref, tabTarget(args, target));
		}
		default:
			throw new Error(`Unsupported script operation: ${op} (expected ${SCRIPT_OPS.join(" | ")})`);
	}
}
