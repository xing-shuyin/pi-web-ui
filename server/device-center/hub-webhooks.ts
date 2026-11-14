import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import type { DeviceHubStore, GroupWebhook, GroupWebhookEventType } from "./store.js";

export const ALLOWED_WEBHOOK_EVENTS: readonly GroupWebhookEventType[] = [
	"message",
	"task_completed",
	"task_failed",
	"delivery",
];

export function createWebhookToken(): string {
	return randomBytes(24).toString("hex");
}

// 出站 webhook 不允许指向云厂商的元数据 / 链路本地地址：这类地址没有任何合法 webhook 用例，
// 却是 SSRF 的头号目标（窃取实例凭据/节点身份）。判定前先把宿主名归一化：
// 去掉 IPv6 方括号与结尾的点（`metadata.google.internal.` 与不带点等价）、
// 把 IPv4-mapped IPv6（`[::ffff:169.254.169.254]`）折回点分 IPv4。
const METADATA_HOSTS = new Set(["100.100.100.200", "0.0.0.0", "::"]);
// AWS IMDS / GCP metadata 的 IPv6 端点（以及它们所在的 /64）。
const METADATA_V6_HOSTS = new Set(["fd00:ec2::254", "fd20:ce::254"]);
const METADATA_V6_PREFIXES = ["fd00:ec2:", "fd20:ce:"];

function normalizeWebhookHost(hostname: string): string {
	const host = hostname
		.replace(/^\[|\]$/g, "")
		.toLowerCase()
		.replace(/\.+$/, "");
	const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
	if (!mapped) return host;
	const high = Number.parseInt(mapped[1]!, 16);
	const low = Number.parseInt(mapped[2]!, 16);
	return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isMetadataHost(host: string): boolean {
	if (METADATA_HOSTS.has(host)) return true;
	if (host === "metadata.google.internal" || host.endsWith(".metadata.google.internal")) return true;
	if (METADATA_V6_HOSTS.has(host) || METADATA_V6_PREFIXES.some((prefix) => host.startsWith(prefix))) return true;
	// 169.254.0.0/16 是链路本地：云元数据 169.254.169.254 与 ECS 任务凭据 169.254.170.2 都在里面，
	// 可路由环境下没有合法 webhook 用途。
	return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host);
}

function assertNotMetadataTarget(parsed: URL): void {
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Webhook target must be an http(s) URL (${parsed.protocol})`);
	}
	const host = normalizeWebhookHost(parsed.hostname);
	if (isMetadataHost(host)) throw new Error(`Webhook target must not point at a metadata endpoint (${host})`);
}

export function validateWebhookInput(
	input: unknown,
	isUpdate = false,
): {
	name?: string;
	type?: "incoming" | "outgoing";
	enabled?: boolean;
	allowBotTrigger?: boolean;
	url?: string;
	secret?: string;
	events?: GroupWebhookEventType[];
	relayViaHub?: boolean;
} {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new Error("Invalid webhook configuration");
	}
	const data = input as Record<string, unknown>;

	const result: ReturnType<typeof validateWebhookInput> = {};

	if (!isUpdate || data.name !== undefined) {
		if (typeof data.name !== "string" || !data.name.trim() || data.name.length > 80) {
			throw new Error("Webhook name must be 1-80 characters");
		}
		result.name = data.name.trim();
	}

	if (!isUpdate || data.type !== undefined) {
		if (data.type !== "incoming" && data.type !== "outgoing") {
			throw new Error("Webhook type must be 'incoming' or 'outgoing'");
		}
		result.type = data.type;
	}

	if (data.enabled !== undefined) {
		if (typeof data.enabled !== "boolean") {
			throw new Error("Enabled must be a boolean");
		}
		result.enabled = data.enabled;
	} else if (!isUpdate) {
		result.enabled = true;
	}

	if (data.allowBotTrigger !== undefined) {
		if (typeof data.allowBotTrigger !== "boolean") {
			throw new Error("allowBotTrigger must be a boolean");
		}
		result.allowBotTrigger = data.allowBotTrigger;
	} else if (!isUpdate) {
		result.allowBotTrigger = true;
	}

	if (data.url !== undefined) {
		if (typeof data.url !== "string" || !data.url.trim()) {
			throw new Error("Target URL is required for outgoing webhook");
		}
		try {
			const parsed = new URL(data.url);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				throw new Error();
			}
			result.url = parsed.href;
			// 元数据端点拒绝要抛出自己的原因：包进上面的 catch 会变成
			// 「must be a valid http or https URL」——URL 本身是合法的，运维会看不明白。
			assertNotMetadataTarget(parsed);
		} catch (err) {
			if (err instanceof Error && err.message.includes("metadata")) throw err;
			throw new Error("Target URL must be a valid http or https URL");
		}
	} else if (!isUpdate && result.type === "outgoing") {
		throw new Error("Target URL is required for outgoing webhook");
	}

	if (data.secret !== undefined && data.secret !== null) {
		if (typeof data.secret !== "string" || data.secret.length > 256) {
			throw new Error("Secret must be a string up to 256 characters");
		}
		result.secret = data.secret.trim() || undefined;
	}

	if (data.events !== undefined) {
		if (!Array.isArray(data.events) || data.events.some((ev) => !ALLOWED_WEBHOOK_EVENTS.includes(ev))) {
			throw new Error("Invalid webhook events");
		}
		result.events = [...new Set(data.events as GroupWebhookEventType[])];
	} else if (!isUpdate) {
		result.events = [...ALLOWED_WEBHOOK_EVENTS];
	}

	if (data.relayViaHub !== undefined) {
		if (typeof data.relayViaHub !== "boolean") {
			throw new Error("relayViaHub must be a boolean");
		}
		result.relayViaHub = data.relayViaHub;
	} else if (!isUpdate) {
		result.relayViaHub = true;
	}

	return result;
}

export function isIncomingWebhookRequest(req: Request): boolean {
	return req.method === "POST" && /^\/api\/rooms\/[^/]+\/webhooks\/incoming\/[^/]+$/.test(req.path);
}

export function secureCompareTokens(given: string, expected: string): boolean {
	const a = Buffer.from(given, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

export function dispatchGroupWebhook(
	store: DeviceHubStore,
	roomId: string,
	event: GroupWebhookEventType,
	data: unknown,
): void {
	try {
		const state = store.snapshot();
		const room = state.rooms.find((r) => r.id === roomId);
		if (!room || !room.webhooks || !room.webhooks.length) return;

		const matching = room.webhooks.filter((w) => {
			if (w.type !== "outgoing" || w.enabled === false || !w.url) return false;
			const subscribed = w.events ?? ALLOWED_WEBHOOK_EVENTS;
			return subscribed.includes(event);
		});

		if (!matching.length) return;

		const payloadStr = JSON.stringify({
			event,
			roomId,
			roomName: room.name,
			timestamp: Date.now(),
			data,
		});

		for (const webhook of matching) {
			if (webhook.relayViaHub !== false) {
				void postWebhook(webhook.url!, webhook.secret, event, payloadStr);
			}
		}
	} catch {}
}

const MAX_WEBHOOK_REDIRECTS = 3;

async function postWebhook(
	url: string,
	secret: string | undefined,
	event: string,
	payloadStr: string,
): Promise<{ success: boolean; status?: number; error?: string }> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"User-Agent": "pi-web-ui-webhook/1.0",
		"X-Pi-Event": event,
		"X-Pi-Delivery": randomUUID(),
	};
	if (secret) {
		const hmac = createHmac("sha256", secret).update(payloadStr).digest("hex");
		headers["X-Pi-Signature"] = `sha256=${hmac}`;
	}

	// fetch 默认自动跟随重定向：公网目标 302 跳内网/元数据端点即可绕过一切 URL 校验。
	// 改为手动跟随，且只跟 307/308（保持 POST 语义），每一跳都重新过元数据校验；
	// 301/302/303 原样上报，由调用方（连通性测试/健康检查）看到真实状态。
	let target = url;
	for (let hop = 0; hop <= MAX_WEBHOOK_REDIRECTS; hop++) {
		let parsed: URL;
		try {
			parsed = new URL(target);
			assertNotMetadataTarget(parsed);
		} catch (err: any) {
			return { success: false, error: err?.message ?? "Invalid webhook target URL" };
		}
		let res: Response;
		try {
			res = await fetch(parsed.href, {
				method: "POST",
				headers,
				body: payloadStr,
				signal: AbortSignal.timeout(5000),
				redirect: "manual",
			});
		} catch (err: any) {
			return { success: false, error: err?.message ?? "Request failed" };
		}
		if ((res.status === 307 || res.status === 308) && res.headers.get("location")) {
			try {
				target = new URL(res.headers.get("location")!, parsed).href;
			} catch {
				return { success: false, status: res.status, error: "Webhook redirect location is invalid" };
			}
			continue;
		}
		return { success: res.ok, status: res.status };
	}
	return { success: false, error: "Webhook redirected too many times" };
}

export async function testOutgoingWebhook(webhook: {
	url: string;
	secret?: string;
}): Promise<{ success: boolean; status?: number; error?: string }> {
	const payloadStr = JSON.stringify({
		event: "ping",
		timestamp: Date.now(),
		data: {
			message: "Webhook connectivity test from pi-web-ui",
		},
	});
	return await postWebhook(webhook.url, webhook.secret, "ping", payloadStr);
}
