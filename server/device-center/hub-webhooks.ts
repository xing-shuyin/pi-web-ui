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
		} catch {
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

	try {
		const res = await fetch(url, {
			method: "POST",
			headers,
			body: payloadStr,
			signal: AbortSignal.timeout(5000),
		});
		return { success: res.ok, status: res.status };
	} catch (err: any) {
		return { success: false, error: err?.message ?? "Request failed" };
	}
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
