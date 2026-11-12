import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	extractShotImage,
	formatPageCallResult,
	normalizePageCallTimeoutMs,
	type PageCallRequest,
	type PageCallResult,
} from "./browser-page-tool.js";
import { BROWSER_DESIGN_TOOL_NAME } from "./tool-manager.js";
/**
 * `kind` 的取值。单源在 `browser/contracts.ts`（渲染层与主进程共用），但 server 的 tsconfig rootDir
 * 不包含 `browser/`，所以这里就地登记一份，由 `tests/unit/browser-design-tool.test.ts` 钉住两边一致。
 */
export const BROWSER_DESIGN_TOOL_KINDS = ["newtab", "theme"] as const;

/** 工具侧的五个动作：与 `design.*` 页面调用一一对应。 */
export const BROWSER_DESIGN_TOOL_ACTIONS = ["status", "get", "save", "reset", "preview"] as const;

export const BROWSER_DESIGN_ACTION_SIGNATURE = "status | get(kind?) | save(kind,content) | reset(kind) | preview(kind)";

/** `get` 回给模型的正文字数上限：再长就让模型自己 `read` 那个文件，别把上下文撑爆。 */
const MAX_INLINE_CONTENT = 24_000;

const DESIGN_ARG_KEYS = ["kind", "content"] as const;

export function collectBrowserDesignArgs(params: Record<string, unknown>): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	for (const key of DESIGN_ARG_KEYS) {
		if (params[key] !== undefined) args[key] = params[key];
	}
	return args;
}

export function formatBrowserDesignError(action: string, error: string): string {
	return [
		`browser_design "${action}" failed: ${error}`,
		`browser_design "${action}" 失败：${error}`,
		'Next: this tool needs the desktop AI Browser (the browser window itself, not a page-picker tab). Run action:"status" to check both files; action:"get" shows the current source before you rewrite it.',
		'下一步：这个工具需要桌面版 AI Browser（浏览器窗口本体，不是 page-picker 标签页）。先用 action:"status" 看两份文件的状态，再用 action:"get" 取当前源码，然后整份重写。',
	].join("\n");
}

/** `get` 把「状态 + 正文」摆开说：正文太长就截断并指向磁盘路径。 */
export function formatBrowserDesignResult(action: string, result: unknown): string {
	if (action !== "get") return formatPageCallResult(result);
	const document = result as { status?: unknown; content?: unknown; starter?: unknown };
	const content = typeof document.content === "string" ? document.content : "";
	const truncated = content.length > MAX_INLINE_CONTENT;
	const body = truncated
		? `${content.slice(0, MAX_INLINE_CONTENT)}\n…(truncated; ${content.length} chars total — read status.path for the rest)`
		: content;
	return [
		JSON.stringify(document.status ?? null, null, 2),
		document.starter === true ? "(starter template: nothing is saved yet)" : "",
		body,
	]
		.filter((part) => part !== "")
		.join("\n\n");
}

export function makeBrowserDesignTool(
	clientSession: {
		pageCall: (req: PageCallRequest, sig: { aborted?: boolean }, conversationId?: string) => Promise<PageCallResult>;
		canSeeImages?: () => boolean;
	},
	ownerId?: string,
): ToolDefinition {
	return {
		name: BROWSER_DESIGN_TOOL_NAME,
		label: "Browser design",
		description:
			"Rewrite the AI Browser's own new tab page (self-contained HTML) or its theme override CSS, then preview it.",
		promptSnippet: "design the browser's new tab page and theme",
		promptGuidelines: [
			"Use browser_design only when the user asks to change how the AI Browser looks (new tab page or theme); it needs the desktop window, not page-picker tabs",
			'Start with action:"get": action:"save" replaces the whole file, so send the full body, and an empty body restores the default',
			"Custom new tab HTML runs with built-in page privileges: never paste remote script tags or untrusted markup",
			'After saving, run action:"preview" for a screenshot; it opens the new tab tab and switches to browser mode',
		],
		parameters: Type.Object({
			action: Type.Unsafe<(typeof BROWSER_DESIGN_TOOL_ACTIONS)[number]>({
				type: "string",
				enum: [...BROWSER_DESIGN_TOOL_ACTIONS],
				description: BROWSER_DESIGN_ACTION_SIGNATURE,
			}),
			kind: Type.Optional(
				Type.Unsafe<(typeof BROWSER_DESIGN_TOOL_KINDS)[number]>({
					type: "string",
					enum: [...BROWSER_DESIGN_TOOL_KINDS],
				}),
			),
			content: Type.Optional(Type.String()),
		}),
		execute: async (_id: string, params: unknown, signal: AbortSignal | undefined): Promise<unknown> => {
			const p = (params ?? {}) as Record<string, unknown>;
			const action = typeof p.action === "string" ? p.action.trim() : "";
			if (!(BROWSER_DESIGN_TOOL_ACTIONS as readonly string[]).includes(action)) {
				throw new Error(
					`browser_design requires action: ${BROWSER_DESIGN_ACTION_SIGNATURE}.\n` +
						`browser_design 需要 action：${BROWSER_DESIGN_ACTION_SIGNATURE}。`,
				);
			}
			if (action !== "status" && action !== "get" && typeof p.kind !== "string") {
				throw new Error(
					`browser_design "${action}" needs kind: newtab or theme.\nbrowser_design "${action}" 需要 kind：newtab 或 theme。`,
				);
			}
			if (action === "save" && typeof p.content !== "string") {
				throw new Error(
					'browser_design "save" needs the full file body in content.\nbrowser_design "save" 需要把完整文件正文放进 content。',
				);
			}
			const resolved = await clientSession.pageCall(
				{
					op: `design.${action}`,
					args: collectBrowserDesignArgs(p),
					// 预览要等页面加载完再截图，给它宽一点的余量
					timeoutMs: normalizePageCallTimeoutMs(action === "preview" ? 60000 : undefined),
				},
				{ aborted: signal?.aborted },
				ownerId,
			);
			if (!resolved.ok) throw new Error(formatBrowserDesignError(action, resolved.error));
			const shot = extractShotImage(resolved.result);
			if (action !== "preview" || !shot) {
				return {
					content: [{ type: "text", text: formatBrowserDesignResult(action, resolved.result) }],
					details: { action, args: collectBrowserDesignArgs(p), result: resolved.result },
				} as never;
			}
			const where = whatOf(resolved.result);
			const caption = [`Preview of ${where}.`, `预览截图：${where}。`].join("\n");
			const details = {
				action,
				args: collectBrowserDesignArgs(p),
				result: { ...(resolved.result as Record<string, unknown>), image: "[image]" },
			};
			if (clientSession.canSeeImages?.() === true) {
				return {
					content: [
						{ type: "text", text: caption },
						{ type: "image", data: shot.data, mimeType: shot.mimeType },
					],
					details,
				} as never;
			}
			return {
				content: [{ type: "text", text: `${caption}\nRendered at ${shot.width ?? "?"}×${shot.height ?? "?"} px.` }],
				details,
			} as never;
		},
	} as unknown as ToolDefinition;
}

function whatOf(result: unknown): string {
	const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
	const kind = typeof record.kind === "string" ? record.kind : "newtab";
	const url = typeof record.url === "string" ? record.url : "";
	return url ? `${kind === "theme" ? "the themed new tab page" : "the new tab page"} (${url})` : "the new tab page";
}
