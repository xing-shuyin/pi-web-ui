import { randomUUID } from "node:crypto";
import type { DeviceDelivery, DeviceDeliveryCheck, DeviceReview } from "../protocol.js";
import { hashSecret, type Bot, type HubState } from "./store.js";
import { assertDeliveryAuthority, assertNoApplyingIntegration, deriveArtifactSubject } from "./delivery-authority.js";
import { artifactRefsMatch, deliveryReviewMatches } from "./delivery-subject.js";
import { hasVerifiedIntegration } from "./integration-verification.js";

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
	assertNoApplyingIntegration(
		state,
		actor.accountId,
		state.conversations.find((c) => c.id === conversationId)!.roomId,
		conversationId,
	);
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
		"artifactTaskId",
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
	let subject: Pick<DeviceDelivery, "repository" | "baseCommit" | "commit" | "artifactRef" | "acceptanceCriteria">;
	if (body.artifactTaskId !== undefined) {
		if (body.repository !== undefined || body.baseCommit !== undefined || body.commit !== undefined)
			fail(400, "Artifact delivery derives repository and baseline; commit is not an artifact tree");
		const artifactTaskId = text(body.artifactTaskId, 128, "artifactTaskId");
		const task = state.tasks.find(
			(t) =>
				t.id === artifactTaskId &&
				t.accountId === actor.accountId &&
				t.roomId === roomId &&
				t.conversationId === conversationId &&
				t.botId === actor.bot!.id &&
				t.deviceId === actor.bot!.deviceId &&
				t.botRevision === actor.bot!.revision,
		);
		if (!task) fail(409, "Artifact task must belong to the same author, device, revision and conversation");
		const artifactRef = deriveArtifactSubject(state, task);
		subject = {
			artifactRef,
			repository: artifactRef.repositoryId,
			baseCommit: artifactRef.baselineCommit,
			acceptanceCriteria: [...(task.contract!.acceptanceCriteria ?? [])],
		};
	} else
		subject = { repository: repository(body.repository), baseCommit: sha(body.baseCommit), commit: sha(body.commit) };
	const payload = {
		taskId: text(body.parentTaskId, 128, "parentTaskId"),
		...subject,
		...(body.branch === undefined ? {} : { branch: text(body.branch, 256, "branch") }),
		summary: text(body.summary, 8192, "summary"),
		checks,
		limitations: limits.map((s) => text(s, 2048, "limitation")),
	};
	const { acceptanceCriteria: _criteria, artifactRef: _artifactRef, ...requestPayload } = payload;
	if (Buffer.byteLength(JSON.stringify(requestPayload)) > 24 * 1024) fail(413, "Delivery budget exceeded");
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
		"artifactDigest",
		"integrationId",
		"verificationDigest",
		"criteriaResults",
		"verdict",
		"summary",
	]);
	binding(state, roomId, conversationId, actor, body);
	if (!actor.bot && (body.sourceBotId !== undefined || body.parentTaskId !== undefined))
		fail(400, "Human review cannot claim Bot identity");
	const key = text(body.idempotencyKey, 128, "idempotencyKey");
	const deliveryId = text(body.deliveryId, 128, "deliveryId");
	if (!["accepted", "changes_requested"].includes(body.verdict as string)) fail(400, "Invalid verdict");
	const delivery = state.deliveries.find(
		(d) =>
			d.id === deliveryId &&
			d.conversationId === conversationId &&
			d.roomId === roomId &&
			d.accountId === actor.accountId,
	);
	if (!delivery) fail(400, "Delivery missing");
	const task = assertDeliveryAuthority(state, delivery);
	let subject: Pick<
		DeviceReview,
		"commit" | "artifactDigest" | "artifactRef" | "integrationId" | "verificationDigest" | "criteriaResults"
	>;
	if (delivery.artifactRef) {
		if (body.commit !== undefined || body.artifactDigest !== delivery.artifactRef.artifactDigest)
			fail(400, "Review artifact digest must match delivery");
		let criteriaResults: DeviceReview["criteriaResults"];
		if (body.criteriaResults !== undefined) {
			if (!Array.isArray(body.criteriaResults) || body.criteriaResults.length > 64)
				fail(400, "Invalid criteria results");
			criteriaResults = body.criteriaResults.map((value) => {
				const item = object(value, ["criterionIndex", "verdict", "evidence"]);
				if (
					!Number.isSafeInteger(item.criterionIndex) ||
					(item.criterionIndex as number) < 0 ||
					(item.criterionIndex as number) >= (task!.contract!.acceptanceCriteria ?? []).length ||
					!["met", "not_met"].includes(item.verdict as string)
				)
					fail(400, "Invalid criterion result");
				return {
					criterionIndex: item.criterionIndex as number,
					verdict: item.verdict as "met" | "not_met",
					evidence: text(item.evidence, 2000, "criterion evidence"),
				};
			});
			if (new Set(criteriaResults.map((c) => c.criterionIndex)).size !== criteriaResults.length)
				fail(400, "Duplicate criterion result");
		}
		const integrationId = body.integrationId === undefined ? undefined : text(body.integrationId, 128, "integrationId");
		const verificationDigest =
			body.verificationDigest === undefined ? undefined : text(body.verificationDigest, 64, "verificationDigest");
		if (body.verdict === "accepted") {
			const integration = state.integrations.find(
				(i) =>
					i.id === integrationId &&
					i.accountId === actor.accountId &&
					i.roomId === roomId &&
					i.conversationId === conversationId &&
					i.deliveryId === deliveryId,
			);
			const target =
				integration &&
				state.bots.find(
					(b) =>
						b.id === integration.targetBotId &&
						b.accountId === actor.accountId &&
						b.deviceId === integration.targetDeviceId &&
						b.revision === integration.targetBotRevision &&
						b.enabled,
				);
			if (
				!integration ||
				!target ||
				!state.rooms.some((r) => r.id === roomId && r.accountId === actor.accountId && r.botIds.includes(target.id)) ||
				!state.devices.some((d) => d.id === target.deviceId && d.accountId === actor.accountId) ||
				!["verified", "applying", "applied"].includes(integration.status) ||
				!hasVerifiedIntegration(integration) ||
				!artifactRefsMatch(delivery.artifactRef, integration.artifactRef) ||
				integration.verification!.digest !== verificationDigest
			)
				fail(409, "Accepted artifact review requires matching successful verification");
			if (
				!criteriaResults ||
				criteriaResults.length !== (task!.contract!.acceptanceCriteria ?? []).length ||
				criteriaResults.some((c) => c.verdict !== "met")
			)
				fail(400, "Accepted review must cover every sealed criterion");
		}
		subject = {
			artifactRef: delivery.artifactRef,
			artifactDigest: delivery.artifactRef.artifactDigest,
			integrationId,
			verificationDigest,
			criteriaResults,
		};
	} else {
		if (
			body.artifactDigest !== undefined ||
			body.integrationId !== undefined ||
			body.verificationDigest !== undefined ||
			body.criteriaResults !== undefined
		)
			fail(400, "Legacy review requires commit only");
		const commit = sha(body.commit);
		if (delivery.commit !== commit) fail(400, "Delivery and commit must match");
		subject = { commit };
	}
	const payload = {
		deliveryId,
		...subject,
		verdict: body.verdict as DeviceReview["verdict"],
		summary: text(body.summary, 8192, "summary"),
		...(actor.bot ? { taskId: text(body.parentTaskId, 128, "parentTaskId") } : {}),
	};
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
			...subject,
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
	assertDeliveryAuthority(state, latest);
	if (!latestReview || latestReview.verdict !== "accepted" || !deliveryReviewMatches(latest, latestReview)) {
		fail(400, "Delivery has no accepted review for its subject");
	}
	return { delivery: latest, review: latestReview };
}
