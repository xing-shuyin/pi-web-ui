import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { PHONE_TOOL_NAME } from "./tool-manager.js";

const PHONE_CALL_DEFAULT_TIMEOUT_MS = 20_000;
const PHONE_CALL_MIN_TIMEOUT_MS = 1_000;
const PHONE_CALL_MAX_TIMEOUT_MS = 60_000;

export type PhoneCallResult = { ok: true; result?: unknown } | { ok: false; error: string };

/** `op` 的枚举：schema 显式列出，运行时仍接受任意非空字符串（旧客户端兼容）。 */
export const PHONE_OPS = [
	"status",
	"dump",
	"tap",
	"long_press",
	"swipe",
	"input",
	"key",
	"launch",
	"screenshot",
] as const;

type PhoneOp = (typeof PHONE_OPS)[number];

export const PHONE_KEYS = ["back", "home", "recents", "notifications", "quickSettings"] as const;

/** 只读档：读屏与控件树，不会改变手机状态。 */
export const PHONE_READ_OPS = ["status", "dump", "screenshot"] as const;

/** 操控档：会改变手机状态（点击/滑动/输入/按键/启动应用）。逐操作审批 UI 落地前，启用即授权整机操控。 */
export const PHONE_CONTROL_OPS = ["tap", "long_press", "swipe", "input", "key", "launch"] as const;

type PhoneKey = (typeof PHONE_KEYS)[number];

/** 每 op 的签名是参数文档的唯一归属地，字段本身不再写说明。 */
export const PHONE_OP_SIGNATURE =
	"status | dump(maxNodes?,maxDepth?) | tap(x,y) | long_press(x,y,durationMs?) | " +
	"swipe(x1,y1,x2,y2,durationMs?) | input(text) | key(back|home|recents|notifications|quickSettings) | " +
	"launch(packageName) | screenshot(maxWidth?)";

const PHONE_ARG_KEYS = [
	"x",
	"y",
	"x1",
	"y1",
	"x2",
	"y2",
	"durationMs",
	"text",
	"packageName",
	"maxWidth",
	"maxNodes",
	"maxDepth",
] as const;

export function collectPhoneArgs(params: Record<string, unknown>): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	for (const key of PHONE_ARG_KEYS) {
		if (params[key] !== undefined) args[key] = params[key];
	}
	return args;
}

export function normalizePhoneCallTimeoutMs(value: unknown): number {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : PHONE_CALL_DEFAULT_TIMEOUT_MS;
	return Math.min(PHONE_CALL_MAX_TIMEOUT_MS, Math.max(PHONE_CALL_MIN_TIMEOUT_MS, n));
}

export function formatPhoneCallResult(result: unknown): string {
	if (typeof result === "string") return result.length > 0 ? result : "(empty)";
	if (result === undefined || result === null) return "(no result)";
	try {
		return JSON.stringify(result, null, 2) ?? String(result);
	} catch {
		return String(result);
	}
}

export function formatPhoneError(op: string, error: string): string {
	return [
		`phone "${op}" failed: ${error}`,
		`phone "${op}" 失败：${error}`,
		'Next: op:"status" tells you whether the phone has the accessibility service on. If it is off, ask the user to enable it in system settings instead of retrying.',
		'下一步：op:"status" 能看出手机有没有开启无障碍服务；没开就请用户在系统设置里开启，不要反复重试。',
	].join("\n");
}

/** 客户端回来的截图统一成长这样（宿主桥把 base64 拼成 dataUrl）。 */
export function extractPhoneShot(
	result: unknown,
): { data: string; mimeType: string; width?: number; height?: number } | undefined {
	if (!result || typeof result !== "object") return undefined;
	const image = (result as { image?: unknown }).image;
	if (!image || typeof image !== "object") return undefined;
	const src = image as { dataUrl?: unknown; width?: unknown; height?: unknown };
	if (typeof src.dataUrl !== "string") return undefined;
	const match = /^data:([^;,]+);base64,(.+)$/s.exec(src.dataUrl);
	if (!match) return undefined;
	return {
		data: match[2],
		mimeType: match[1],
		width: typeof src.width === "number" ? src.width : undefined,
		height: typeof src.height === "number" ? src.height : undefined,
	};
}

export function makePhoneTool(
	clientSession: {
		phoneCall: (
			req: { op: string; args?: Record<string, unknown>; timeoutMs: number },
			sig: { aborted?: boolean },
			conversationId?: string,
		) => Promise<PhoneCallResult>;
		canSeeImages?: () => boolean;
		transcribeToolImage?: (
			image: { data: string; mimeType: string },
			signal?: AbortSignal,
		) => Promise<{ text?: string; reason?: string }>;
	},
	ownerId?: string,
): ToolDefinition {
	return {
		name: PHONE_TOOL_NAME,
		label: "Phone",
		description:
			"Read the phone screen and drive it through the accessibility service. Enabling this tool grants full control of the phone (tap / swipe / type / keys / launch / screenshots); per-op approval UI is pending, enable only for trusted sessions.",
		promptSnippet: "read and drive this Android phone: UI tree, tap, swipe, type, keys, shots",
		promptGuidelines: [
			"Use phone only when the user asked you to operate their phone; never tap, type or navigate their apps on your own initiative",
			'Start with op:"dump" and act on the returned nodes: bounds are screen pixels already, so tap the centre of a node instead of guessing coordinates. Take a screenshot when the tree is not enough.',
			"Typing text goes to the focused input only. If the user must enter a password, payment or system setting, stop and ask them to do it themselves.",
			"Control ops (tap / swipe / input / key / launch) have no per-op approval yet: confirm with the user in chat before the first control action, and prefer read ops (status / dump / screenshot) when control is not needed.",
			"After each action, dump again to confirm the screen changed instead of firing several actions blindly.",
		],
		parameters: Type.Object({
			op: Type.Unsafe<PhoneOp>({
				type: "string",
				enum: [...PHONE_OPS],
				description: PHONE_OP_SIGNATURE,
			}),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			x1: Type.Optional(Type.Number()),
			y1: Type.Optional(Type.Number()),
			x2: Type.Optional(Type.Number()),
			y2: Type.Optional(Type.Number()),
			durationMs: Type.Optional(Type.Number()),
			text: Type.Optional(Type.String()),
			packageName: Type.Optional(Type.String()),
			maxWidth: Type.Optional(Type.Number()),
			maxNodes: Type.Optional(Type.Number()),
			maxDepth: Type.Optional(Type.Number()),
			key: Type.Optional(Type.Unsafe<PhoneKey>({ type: "string", enum: [...PHONE_KEYS] })),
			timeoutMs: Type.Optional(Type.Number()),
		}),
		execute: async (_id: string, params: unknown, signal: AbortSignal | undefined): Promise<unknown> => {
			const p = (params ?? {}) as Record<string, unknown>;
			const op = typeof p.op === "string" ? p.op.trim() : "";
			if (!op) {
				throw new Error('phone requires a non-empty `op` (e.g. "dump", "tap").\nphone 需要非空的 op（如 dump/tap）。');
			}
			const args = collectPhoneArgs(p);
			// key 是枚举，但放在 args 里过桥，保持一个入口。
			if (typeof p.key === "string" && p.key.length > 0) args.name = p.key;
			const resolved = await clientSession.phoneCall(
				{ op, args, timeoutMs: normalizePhoneCallTimeoutMs(p.timeoutMs) },
				{ aborted: signal?.aborted },
				ownerId,
			);
			if (!resolved.ok) throw new Error(formatPhoneError(op, resolved.error));
			const shot = extractPhoneShot(resolved.result);
			const details = {
				op,
				args,
				result: shot ? { ...(resolved.result as object), image: "[image]" } : resolved.result,
			};
			if (!shot) {
				return { content: [{ type: "text", text: formatPhoneCallResult(resolved.result) }], details } as never;
			}
			const caption = [
				`Phone screenshot — ${shot.width ?? "?"}×${shot.height ?? "?"} px.`,
				`手机截图 — ${shot.width ?? "?"}×${shot.height ?? "?"} px。`,
			].join("\n");
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
						`\n\n（当前模型看不到图片：${bridged?.reason ?? "视觉桥不可用"} —— 可改用 op:"dump" 走控件树，或换支持识图的模型）`,
						`(The current model cannot see images: ${bridged?.reason ?? "vision bridge unavailable"} — use op:"dump" instead)`,
					].join("\n");
			return { content: [{ type: "text", text: caption + note }], details } as never;
		},
	} as unknown as ToolDefinition;
}
