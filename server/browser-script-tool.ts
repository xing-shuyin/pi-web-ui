import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	formatPageCallResult,
	normalizePageCallTimeoutMs,
	type PageCallRequest,
	type PageCallResult,
} from "./browser-page-tool.js";
import { BROWSER_SCRIPT_TOOL_NAME } from "./tool-manager.js";

/** 脚本动作：临时（会话内）/ 永久（落盘）共用同一套记录，`persist` 决定生命周期。 */
export const BROWSER_SCRIPT_ACTIONS = [
	"list",
	"status",
	"create",
	"update",
	"remove",
	"enable",
	"disable",
	"run",
] as const;

export type BrowserScriptAction = (typeof BROWSER_SCRIPT_ACTIONS)[number];

export const BROWSER_SCRIPT_RUN_AT = ["dom-ready", "document-start"] as const;
export const BROWSER_SCRIPT_WORLD = ["main", "isolated"] as const;

const SCRIPT_ARG_KEYS = [
	"id",
	"name",
	"matches",
	"code",
	"css",
	"runAt",
	"world",
	"spa",
	"persist",
	"enabled",
	"tabId",
] as const;

const ACTION_SIGNATURE =
	"list | status(target?) | create(name,code,css?,matches?,runAt?,world?,spa?,persist?) | " +
	"update(id|name,...) | remove(id|name) | enable(id|name) | disable(id|name) | run(id|name,target?)";

export const BROWSER_SCRIPT_ARG_HINT =
	"matches: host globs (example.com, *.example.com), full-URL globs, re:<regex>, or * for every page";

export function collectBrowserScriptArgs(params: Record<string, unknown>): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	for (const key of SCRIPT_ARG_KEYS) {
		if (params[key] !== undefined) args[key] = params[key];
	}
	return args;
}

export function formatBrowserScriptError(action: string, error: string): string {
	return [
		`browser_script "${action}" failed: ${error}`,
		`browser_script "${action}" 失败：${error}`,
		'Next: run action:"list" to see existing scripts and their ids; page scripts only apply to http(s) tabs in the AI Browser.',
		'下一步：先用 action:"list" 查看已有脚本与 id；页面脚本只作用于 AI 浏览器里的 http(s) 标签页。',
	].join("\n");
}

function asArray(value: unknown): string[] | undefined {
	if (typeof value === "string") return value.trim() ? [value.trim()] : [];
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return undefined;
}

export function makeBrowserScriptTool(
	clientSession: {
		pageCall: (req: PageCallRequest, sig: { aborted?: boolean }, conversationId?: string) => Promise<PageCallResult>;
	},
	ownerId?: string,
): ToolDefinition {
	return {
		name: BROWSER_SCRIPT_TOOL_NAME,
		label: "Browser page script",
		description:
			"Inject JavaScript or CSS into an AI Browser tab, temporarily or permanently. " +
			"Scripts run on matching pages from now on, so create one only when the user asked for a lasting change. " +
			"When `matches` is omitted, a new script targets only the site of the current tab.",
		promptSnippet: "inject temporary or persistent scripts into AI Browser pages",
		promptGuidelines: [
			"Use browser_script only when the user asked to change how a page behaves or looks; read pages with browser_page.",
			"Pass persist:false (default) for one-off tweaks and persist:true only when the user wants the change to stay.",
			"Scripts run again on every matching page load. Give each one a stable name and update it instead of creating duplicates.",
			"Return a cleanup function from the script body to make removal undo its DOM/CSS changes; verify the effect afterwards.",
		],
		parameters: Type.Object({
			action: Type.Unsafe<BrowserScriptAction>({
				type: "string",
				enum: [...BROWSER_SCRIPT_ACTIONS],
				description: ACTION_SIGNATURE,
			}),
			target: Type.Optional(Type.String({ description: "Origin URL or native tabId" })),
			id: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
			matches: Type.Optional(Type.Array(Type.String(), { description: BROWSER_SCRIPT_ARG_HINT })),
			code: Type.Optional(Type.String()),
			css: Type.Optional(Type.String()),
			runAt: Type.Optional(
				Type.Unsafe<(typeof BROWSER_SCRIPT_RUN_AT)[number]>({ type: "string", enum: [...BROWSER_SCRIPT_RUN_AT] }),
			),
			world: Type.Optional(
				Type.Unsafe<(typeof BROWSER_SCRIPT_WORLD)[number]>({ type: "string", enum: [...BROWSER_SCRIPT_WORLD] }),
			),
			spa: Type.Optional(Type.Boolean()),
			persist: Type.Optional(Type.Boolean()),
			enabled: Type.Optional(Type.Boolean()),
			tabId: Type.Optional(Type.String()),
			timeoutMs: Type.Optional(Type.Number()),
		}),
		execute: async (_id: string, params: unknown, signal: AbortSignal | undefined): Promise<unknown> => {
			const p = (params ?? {}) as Record<string, unknown>;
			const action = typeof p.action === "string" ? p.action.trim() : "";
			if (!action) {
				throw new Error(
					'browser_script requires `action` (e.g. "list", "create", "run").\nbrowser_script 需要 action（如 list/create/run）。',
				);
			}
			if (!(BROWSER_SCRIPT_ACTIONS as readonly string[]).includes(action)) {
				throw new Error(
					`Unsupported browser_script action: ${action} (expected ${BROWSER_SCRIPT_ACTIONS.join(" | ")})`,
				);
			}
			const args = collectBrowserScriptArgs(p);
			const matches = asArray(p.matches);
			if (matches) args.matches = matches;
			else delete args.matches;
			const resolved = await clientSession.pageCall(
				{
					op: `script.${action}`,
					args,
					target: typeof p.target === "string" && p.target.length > 0 ? p.target : undefined,
					timeoutMs: normalizePageCallTimeoutMs(p.timeoutMs),
				},
				{ aborted: signal?.aborted },
				ownerId,
			);
			if (!resolved.ok) throw new Error(formatBrowserScriptError(action, resolved.error));
			return {
				content: [{ type: "text", text: formatPageCallResult(resolved.result) }],
				details: { action, args, target: p.target, result: resolved.result },
			} as never;
		},
	} as unknown as ToolDefinition;
}
