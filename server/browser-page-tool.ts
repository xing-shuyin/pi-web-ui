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
		'Next: try op:"pages" in AI Browser to find an open tab. In a regular browser, enable and pair page-picker and allow the target page in the extension.',
		'下一步：在 AI Browser 中用 op:"pages" 查找已打开的标签页；使用普通浏览器时，请启用并配对 page-picker，再在扩展中授权目标页面。',
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
		description: [
			"Read or act on a page in the user's AI Browser tabs or a regular browser through page-picker (the server only forwards).",
			"Only the parameters below exist — an op option that is not a field here (e.g. type's submit) is unavailable.",
			"ops: status | pages | read (what? selector? all?) | click (selector? index?) | type (selector text) | scroll (selector?) | goto (url) | wait (selector? text? timeoutMs?) | eval (code, disabled by default) | shot (maxEdge?) | snapshot (AI Browser)",
		].join("\n"),
		promptSnippet: "operate a page in AI Browser or through the page-picker extension",
		promptGuidelines: [
			"Only use browser_page when the user asked you to read or act on a page in their browser; " +
				"never click or type on their pages on your own initiative",
			'Start with op:"pages"; use tabId as target in AI Browser or an allowed page-picker origin. ' +
				"If unavailable, explain which browser capability or extension setting is needed instead of retrying.",
		],
		parameters: Type.Object({
			op: Type.String({
				description: "Action to perform in the native browser or page-picker.",
			}),
			target: Type.Optional(
				Type.String({
					description:
						"Target page origin (e.g. https://example.com) or native tabId from pages. Use tabId to distinguish tabs sharing an origin.",
				}),
			),
			what: Type.Optional(
				Type.String({ description: 'For op:read — "text" | "html" | "title" | "url" | "query" (default: text).' }),
			),
			selector: Type.Optional(
				Type.String({ description: "CSS selector, for op:read / click / type / scroll / wait." }),
			),
			text: Type.Optional(
				Type.String({ description: "For op:type — the text to enter; for op:wait — the text to wait for." }),
			),
			url: Type.Optional(Type.String({ description: "For op:goto — the absolute URL to navigate to." })),
			code: Type.Optional(
				Type.String({
					description:
						"For op:eval — JS to run in the page (native browser or extension setting, disabled by default).",
				}),
			),
			all: Type.Optional(
				Type.Boolean({ description: "For op:read — return every match instead of only the first one." }),
			),
			index: Type.Optional(Type.Number({ description: "For op:click — which match to click (default: 0)." })),
			maxEdge: Type.Optional(
				Type.Number({
					description: "For op:shot — max px of the longer side (320-1568, default 1280).",
				}),
			),
			timeoutMs: Type.Optional(
				Type.Number({
					description: "How long the server waits for the browser (1000-120000 ms, default 30000).",
				}),
			),
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
