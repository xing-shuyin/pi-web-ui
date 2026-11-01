import { randomUUID } from "node:crypto";
import type { DeviceDelivery, DeviceDeliveryCheck, DeviceReview } from "../protocol.js";
import { hashSecret, type Bot, type HubState } from "./store.js";

function fail(status: number, message: string): never {
	throw Object.assign(new Error(message), { status });
}
function text(value: unknown, max: number, name: string): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > max ||
		/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
	)
		fail(400, `Invalid ${name}`);
	return value;
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !keys.includes(key))
	)
		fail(400, "Invalid fields");
	return value as Record<string, unknown>;
}
function sha(value: unknown): string {
	const result = text(value, 64, "commit");
	if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(result)) fail(400, "Full commit SHA required");
	return result.toLowerCase();
}
function repository(value: unknown): string {
	const result = text(value, 2048, "repository");
	if (/[\r\n\t]/.test(result)) fail(400, "Invalid repository");
	if (result.includes("://")) {
		let url: URL;
		try {
			url = new URL(result);
		} catch {
			return fail(400, "Invalid repository URL");
		}
		if (
			!["https:", "http:", "ssh:", "git:"].includes(url.protocol) ||
			url.password ||
			(url.username && (url.protocol !== "ssh:" || url.username !== "git")) ||
			url.search ||
			url.hash
		)
			fail(400, "Repository URL credentials or query are not allowed");
	}
	return result;
}
export interface DeliveryActor {
	accountId: string;
	bot?: Bot;
}
function binding(
	state: HubState,
	roomId: string,
	conversationId: string,
	actor: DeliveryActor,
	body: Record<string, unknown>,
) {
	const room = state.rooms.find((r) => r.id === roomId && r.accountId === actor.accountId);
	const conversation = state.conversations.find(
		(c) => c.id === conversationId && c.roomId === roomId && c.accountId === actor.accountId,
	);
	if (!room || !conversation) fail(404, "Conversation missing");
	if (actor.bot) {
		const bot = state.bots.find(
			(b) =>
				b.id === actor.bot!.id &&
				b.accountId === actor.accountId &&
				b.enabled &&
				b.deviceId === actor.bot!.deviceId &&
				b.revision === actor.bot!.revision,
		);
		if (
			!bot ||
			!room.botIds.includes(bot.id) ||
			!state.devices.some((d) => d.id === bot.deviceId && d.accountId === actor.accountId)
		)
			fail(403, "Bot is not a room member");
		const parent = state.tasks.find(
			(t) =>
				t.id === body.parentTaskId &&
				t.accountId === actor.accountId &&
				t.roomId === roomId &&
				t.botId === bot.id &&
				t.deviceId === bot.deviceId &&
				t.botRevision === bot.revision,
		);
		const source = state.conversations.find(
			(c) =>
				c.id === parent?.conversationId &&
				c.accountId === actor.accountId &&
				c.roomId === roomId &&
				c.botId === bot.id &&
				c.deviceId === bot.deviceId &&
				c.botRevision === bot.revision &&
				c.latestTaskId === parent?.id &&
				!c.closed,
		);
		if (!parent || !source || body.sourceBotId !== bot.id) fail(403, "Current bound Bot task required");
	}
	return conversation;
}
function append<T extends DeviceDelivery | DeviceReview>(
	state: HubState,
	kind: "delivery" | "review",
	conversationId: string,
	key: string,
	actor: DeliveryActor,
	payload: object,
	create: () => T,
): T {
	const fingerprint = hashSecret(
		JSON.stringify({
			actor: actor.bot ? { type: "bot", id: actor.bot.id } : { type: "human", id: actor.accountId },
			payload,
		}),
	);
	const prior = state.deliveryReceipts.find(
		(r) => r.conversationId === conversationId && r.kind === kind && r.key === key,
	);
	const records = kind === "delivery" ? state.deliveries : state.reviews;
	if (prior) {
		if (prior.fingerprint !== fingerprint) fail(409, "Idempotency key reused");
		const record = records.find((r) => r.id === prior.recordId);
		if (!record) fail(409, "Idempotency record missing");
		return record as T;
	}
	if (
		actor.bot &&
		!state.tasks.some(
			(t) =>
				t.id === (payload as { taskId?: string }).taskId &&
				t.botId === actor.bot!.id &&
				t.accountId === actor.accountId &&
				t.status === "running" &&
				!t.cancelRequested,
		)
	)
		fail(409, "New records require a running Bot task");
	const record = create();
	const history = [...state.deliveries, ...state.reviews].filter((r) => r.conversationId === conversationId);
	if (
		history.length >= 200 ||
		Buffer.byteLength(JSON.stringify([...history, record])) > 256 * 1024 ||
		state.deliveries.length + state.reviews.length >= 20000
	)
		fail(409, "Delivery history capacity reached");
	(records as (DeviceDelivery | DeviceReview)[]).push(record);
	state.deliveryReceipts.push({ conversationId, kind, key, fingerprint, recordId: record.id });
	return record;
}
export function addDelivery(
	state: HubState,
	roomId: string,
	conversationId: string,
	actor: DeliveryActor,
	input: unknown,
): DeviceDelivery {
	const body = object(input, [
		"sourceBotId",
		"parentTaskId",
		"idempotencyKey",
		"repository",
		"baseCommit",
		"commit",
		"branch",
		"summary",
		"checks",
		"limitations",
	]);
	if (!actor.bot) fail(403, "Bot delivery required");
	const conversation = binding(state, roomId, conversationId, actor, body);
	if (conversation.botId !== actor.bot.id || conversation.latestTaskId !== body.parentTaskId || conversation.closed)
		fail(403, "Only the current development Bot task may deliver");
	const key = text(body.idempotencyKey, 128, "idempotencyKey");
	if (!Array.isArray(body.checks) || body.checks.length > 32) fail(400, "Invalid checks");
	const checks: DeviceDeliveryCheck[] = body.checks.map((value) => {
		const check = object(value, ["command", "status", "result", "exitCode"]);
		if (!["passed", "failed", "not_run"].includes(check.status as string)) fail(400, "Invalid check status");
		if (
			check.exitCode !== undefined &&
			(!Number.isSafeInteger(check.exitCode) || Math.abs(check.exitCode as number) > 2147483647)
		)
			fail(400, "Invalid exit code");
		if (
			check.exitCode !== undefined &&
			((check.status === "passed" && check.exitCode !== 0) ||
				(check.status === "failed" && check.exitCode === 0) ||
				check.status === "not_run")
		)
			fail(400, "Check status and exit code disagree");
		return {
			command: text(check.command, 2048, "check command"),
			status: check.status as DeviceDeliveryCheck["status"],
			...(check.result === undefined ? {} : { result: text(check.result, 4096, "check result") }),
			...(check.exitCode === undefined ? {} : { exitCode: check.exitCode as number }),
			source: "bot_reported",
		};
	});
	const limits = body.limitations ?? [];
	if (!Array.isArray(limits) || limits.length > 32) fail(400, "Invalid limitations");
	const payload = {
		taskId: text(body.parentTaskId, 128, "parentTaskId"),
		repository: repository(body.repository),
		baseCommit: sha(body.baseCommit),
		commit: sha(body.commit),
		...(body.branch === undefined ? {} : { branch: text(body.branch, 256, "branch") }),
		summary: text(body.summary, 8192, "summary"),
		checks,
		limitations: limits.map((s) => text(s, 2048, "limitation")),
	};
	if (Buffer.byteLength(JSON.stringify(payload)) > 24 * 1024) fail(413, "Delivery budget exceeded");
	return append(state, "delivery", conversationId, key, actor, payload, () => ({
		...payload,
		id: randomUUID(),
		accountId: actor.accountId,
		roomId,
		conversationId,
		botId: actor.bot!.id,
		createdAt: Date.now(),
	}));
}
export function addReview(
	state: HubState,
	roomId: string,
	conversationId: string,
	actor: DeliveryActor,
	input: unknown,
): DeviceReview {
	const body = object(input, [
		"sourceBotId",
		"parentTaskId",
		"idempotencyKey",
		"deliveryId",
		"commit",
		"verdict",
		"summary",
	]);
	binding(state, roomId, conversationId, actor, body);
	if (!actor.bot && (body.sourceBotId !== undefined || body.parentTaskId !== undefined))
		fail(400, "Human review cannot claim Bot identity");
	const key = text(body.idempotencyKey, 128, "idempotencyKey");
	const deliveryId = text(body.deliveryId, 128, "deliveryId");
	const commit = sha(body.commit);
	if (!["accepted", "changes_requested"].includes(body.verdict as string)) fail(400, "Invalid verdict");
	const payload = {
		deliveryId,
		commit,
		verdict: body.verdict as DeviceReview["verdict"],
		summary: text(body.summary, 8192, "summary"),
		...(actor.bot ? { taskId: text(body.parentTaskId, 128, "parentTaskId") } : {}),
	};
	const delivery = state.deliveries.find(
		(d) =>
			d.id === deliveryId &&
			d.conversationId === conversationId &&
			d.roomId === roomId &&
			d.accountId === actor.accountId,
	);
	if (!delivery || delivery.commit !== commit) fail(400, "Delivery and commit must match");
	if (actor.bot?.id === delivery.botId) fail(403, "Self review is forbidden");
	return append(state, "review", conversationId, key, actor, payload, () => {
		if (state.deliveries.filter((d) => d.conversationId === conversationId).at(-1)?.id !== deliveryId)
			fail(409, "Only the latest delivery may be reviewed");
		return {
			id: randomUUID(),
			accountId: actor.accountId,
			roomId,
			conversationId,
			deliveryId,
			commit,
			verdict: payload.verdict,
			summary: payload.summary,
			reviewer: actor.bot ? { type: "bot", id: actor.bot.id } : { type: "human", id: actor.accountId },
			createdAt: Date.now(),
		};
	});
}
export function deliveryHistory(state: HubState, conversationId: string) {
	return {
		deliveries: state.deliveries.filter((d) => d.conversationId === conversationId),
		reviews: state.reviews.filter((r) => r.conversationId === conversationId),
	};
}
export function deliverySummary(state: HubState, conversationId: string, compact = false) {
	const { deliveries, reviews } = deliveryHistory(state, conversationId);
	let latestDelivery = deliveries.at(-1);
	let deliverySummaryTruncated = false;
	if (compact && latestDelivery) {
		const original = latestDelivery;
		latestDelivery = {
			...original,
			summary: original.summary.slice(0, 512),
			checks: original.checks.map(({ result: _result, command, ...check }) => ({
				...check,
				command: command.slice(0, 256),
			})),
			limitations: original.limitations.slice(0, 3).map((s) => s.slice(0, 256)),
		};
		deliverySummaryTruncated = JSON.stringify(original) !== JSON.stringify(latestDelivery);
	}
	return {
		deliverySummaryTruncated,
		latestDelivery,
		latestReview: (() => {
			const review = reviews.filter((r) => r.deliveryId === latestDelivery?.id).at(-1);
			return compact && review ? { ...review, summary: review.summary.slice(0, 512) } : review;
		})(),
		deliveryCount: deliveries.length,
		reviewCount: reviews.length,
	};
}

export function getAcceptedDeliveryForIntegration(
	state: HubState,
	conversationId: string,
	deliveryId: string,
): { delivery: DeviceDelivery; review: DeviceReview } {
	const deliveries = state.deliveries.filter((d) => d.conversationId === conversationId);
	const latest = deliveries.at(-1);
	if (!latest || latest.id !== deliveryId) {
		fail(400, "Only the latest delivery can be integrated");
	}
	const reviews = state.reviews.filter((r) => r.deliveryId === deliveryId);
	const latestReview = reviews.at(-1);
	if (!latestReview || latestReview.verdict !== "accepted" || latestReview.commit !== latest.commit) {
		fail(400, "Delivery has no accepted review for its commit");
	}
	return { delivery: latest, review: latestReview };
}
