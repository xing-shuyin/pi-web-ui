import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "./protocol.js";
import { BROWSER_PAGE_TOOL_NAME } from "./tool-manager.js";

const PAGE_CALL_DEFAULT_TIMEOUT_MS = 30_000;
const PAGE_CALL_MIN_TIMEOUT_MS = 1_000;
const PAGE_CALL_MAX_TIMEOUT_MS = 120_000;

export type PageCallResult = { ok: true; result?: unknown } | { ok: false; error: string };

export type PageCallRequest = Omit<Extract<ServerMessage, { type: "page_request" }>, "id" | "type">;

export function normalizePageCallTimeoutMs(v: unknown): number {
	const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : PAGE_CALL_DEFAULT_TIMEOUT_MS;
	return Math.min(PAGE_CALL_MAX_TIMEOUT_MS, Math.max(PAGE_CALL_MIN_TIMEOUT_MS, n));
}

const BROWSER_PAGE_ARG_KEYS = ["what", "selector", "text", "url", "code", "all", "index", "maxEdge"] as const;

/** `op` 的枚举：schema 里显式列出，运行时仍接受任意非空字符串（旧客户端兼容）。 */
export const BROWSER_PAGE_OPS = [
	"status",
	"pages",
	"read",
	"click",
	"type",
	"scroll",
	"goto",
	"wait",
	"eval",
	"shot",
	"snapshot",
] as const;

type BrowserPageOp = (typeof BROWSER_PAGE_OPS)[number];

export const BROWSER_PAGE_WHAT = ["text", "html", "title", "url", "query"] as const;

type BrowserPageWhat = (typeof BROWSER_PAGE_WHAT)[number];

/** 每 op 的签名是参数文档的唯一归属地，字段本身不再写说明。 */
export const BROWSER_PAGE_OP_SIGNATURE =
	"status | pages | read(target?,what?,selector?,all?) | click(selector,index?) | type(selector,text) | " +
	"scroll(selector?) | goto(url) | wait(selector?,text?,timeoutMs?) | eval(code) | shot(maxEdge?) | snapshot";

export function collectBrowserPageArgs(params: Record<string, unknown>): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	for (const k of BROWSER_PAGE_ARG_KEYS) {
		if (params[k] !== undefined) args[k] = params[k];
	}
	return args;
}

export function formatPageCallResult(result: unknown): string {
	if (typeof result === "string") return result.length > 0 ? result : "(empty)";
	if (result === undefined || result === null) return "(no result)";
	try {
		return JSON.stringify(result, null, 2) ?? String(result);
	} catch {
		return String(result);
	}
}

export function formatBrowserPageError(op: string, error: string): string {
	return [
		`browser_page "${op}" failed: ${error}`,
		`browser_page "${op}" 失败：${error}`,
		'Next: op:"pages" lists the open tabs and marks the one the user has open with active:true. In a regular browser, enable and pair page-picker and allow the target page in the extension.',
		'下一步：op:"pages" 会列出已打开的标签页，并用 active:true 标出用户当前打开的那个；使用普通浏览器时，请启用并配对 page-picker，再在扩展中授权目标页面。',
	].join("\n");
}

export function makeBrowserPageTool(
	clientSession: {
		pageCall: (req: PageCallRequest, sig: { aborted?: boolean }, conversationId?: string) => Promise<PageCallResult>;
		canSeeImages?: () => boolean;
		transcribeToolImage?: (
			image: { data: string; mimeType: string },
			signal?: AbortSignal,
		) => Promise<{ text?: string; reason?: string }>;
	},
	ownerId?: string,
): ToolDefinition {
	return {
		name: BROWSER_PAGE_TOOL_NAME,
		label: "Browser page",
		description: "Read or act on AI Browser tabs or page-picker.",
		promptSnippet: "operate a page in AI Browser or through the page-picker extension",
		promptGuidelines: [
			"Only use browser_page when the user asked you to read or act on a page in their browser; " +
				"never click or type on their pages on your own initiative",
			'Start with op:"pages"; the page marked active:true is the one the user is viewing now. When the user says "this page", pass that page\'s tabId (AI Browser) or origin (page-picker) as target.',
			"Multiple tabs may be open: always pass an explicit target rather than assuming one, " +
				"and name the missing browser setting instead of retrying when the tool is unavailable.",
		],
		parameters: Type.Object({
			op: Type.Unsafe<BrowserPageOp>({
				type: "string",
				enum: [...BROWSER_PAGE_OPS],
				description: BROWSER_PAGE_OP_SIGNATURE,
			}),
			target: Type.Optional(Type.String({ description: "Origin URL or native tabId" })),
			what: Type.Optional(Type.Unsafe<BrowserPageWhat>({ type: "string", enum: [...BROWSER_PAGE_WHAT] })),
			selector: Type.Optional(Type.String()),
			text: Type.Optional(Type.String()),
			url: Type.Optional(Type.String()),
			code: Type.Optional(Type.String()),
			all: Type.Optional(Type.Boolean()),
			index: Type.Optional(Type.Number()),
			maxEdge: Type.Optional(Type.Number()),
			timeoutMs: Type.Optional(Type.Number()),
		}),
		execute: async (_id: string, params: unknown, signal: AbortSignal | undefined): Promise<unknown> => {
			const p = (params ?? {}) as Record<string, unknown>;
			const op = typeof p.op === "string" ? p.op.trim() : "";
			if (!op) {
				throw new Error(
					'browser_page requires a non-empty `op` (e.g. "pages", "read", "click").\nbrowser_page 需要非空的 op（如 pages/read/click）。',
				);
			}
			const resolved = await clientSession.pageCall(
				{
					op,
					args: collectBrowserPageArgs(p),
					target: typeof p.target === "string" && p.target.length > 0 ? p.target : undefined,
					timeoutMs: normalizePageCallTimeoutMs(p.timeoutMs),
				},
				{
					aborted: signal?.aborted,
				},
				ownerId,
			);
			if (!resolved.ok) {
				throw new Error(formatBrowserPageError(op, resolved.error));
			}
			const shot = extractShotImage(resolved.result);
			if (!shot) {
				return {
					content: [{ type: "text", text: formatPageCallResult(resolved.result) }],
					details: { op, args: collectBrowserPageArgs(p), target: p.target, result: resolved.result },
				} as never;
			}
			const where = `${p.target ?? "the page"}${shot.selector ? ` (element ${shot.selector})` : ""}`;
			const caption = [
				`Screenshot of ${where} — ${shot.width ?? "?"}×${shot.height ?? "?"} px.`,
				`页面截图：${where} — ${shot.width ?? "?"}×${shot.height ?? "?"} px。`,
			].join("\n");
			const details = {
				op,
				args: collectBrowserPageArgs(p),
				target: p.target,
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
			const bridged = await clientSession.transcribeToolImage?.(shot, signal);
			const note = bridged?.text
				? `\n\n<vision-bridge>\n${bridged.text}\n</vision-bridge>`
				: [
						`\n\n（当前模型看不到图片：${bridged?.reason ?? "视觉桥不可用"} —— 可让用户改用支持识图的模型，或在模型配置里加一个支持图片的模型）`,
						`(The current model cannot see images: ${bridged?.reason ?? "vision bridge unavailable"})`,
					].join("\n");
			return {
				content: [{ type: "text", text: caption + note }],
				details,
			} as never;
		},
	} as unknown as ToolDefinition;
}

export function extractShotImage(
	result: unknown,
): { data: string; mimeType: string; width?: number; height?: number; selector?: string } | undefined {
	if (!result || typeof result !== "object") return undefined;
	const image = (result as { image?: unknown }).image;
	if (!image || typeof image !== "object") return undefined;
	const src = image as { dataUrl?: unknown; mimeType?: unknown; width?: unknown; height?: unknown };
	if (typeof src.dataUrl !== "string") return undefined;
	const match = /^data:([^;,]+);base64,(.+)$/s.exec(src.dataUrl);
	if (!match) return undefined;
	const selector = (result as { selector?: unknown }).selector;
	return {
		data: match[2],
		mimeType: typeof src.mimeType === "string" && src.mimeType ? src.mimeType : match[1],
		...(typeof src.width === "number" ? { width: src.width } : {}),
		...(typeof src.height === "number" ? { height: src.height } : {}),
		...(typeof selector === "string" && selector ? { selector } : {}),
	};
}
