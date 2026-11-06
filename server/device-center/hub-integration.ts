import { randomUUID } from "node:crypto";
import type { DeviceDelivery, DeviceIntegration, DeviceReview, DeviceIntegrationResumeRequest } from "../protocol.js";
import { sealPublishIntent, validatePublishIntent, validatePublicationResult } from "./publish-intent.js";
import { getAcceptedDeliveryForIntegration } from "./hub-deliveries.js";
import {
	assertDeliveryAuthority,
	assertNoApplyingIntegration,
	hasOpenPublication,
	isLegacyPublicationUnknown,
} from "./delivery-authority.js";
import { artifactRefsMatch, deliveryReviewMatches } from "./delivery-subject.js";
import {
	computeVerificationDigest,
	freezeVerificationPlan,
	hasVerifiedIntegration,
	validateVerificationFacts,
} from "./integration-verification.js";
import { canonicalizeJson } from "./work-contract.js";
import type { Bot, DeviceHubStore, HubState } from "./store.js";

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
	return value.trim();
}
function sha(value: unknown): string {
	const result = text(value, 64, "commit");
	if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(result)) fail(502, "Full commit SHA required");
	return result;
}
function safeBranch(value: unknown): string {
	const result = text(value, 256, "branch");
	if (
		result.startsWith("-") ||
		/[\s~^:?*[\\\]]/.test(result) ||
		result.includes("..") ||
		result.startsWith("/") ||
		result.endsWith("/") ||
		result.endsWith(".lock")
	)
		fail(400, "Invalid branch name");
	return result;
}
function sanitizePublicError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error))
		.replace(/\/\/[^@\s]+@/g, "//***@")
		.split("\n")[0]
		.trim()
		.slice(0, 300);
}
function wrapRpcError(error: unknown): Error {
	const err = error instanceof Error ? error : new Error(String(error));
	if (!(err as any).status)
		Object.assign(err, {
			status: /checked out|moved from|uncommitted|dirty|custom|mismatch|offline|cannot|rejected|conflict/i.test(
				err.message,
			)
				? 409
				: 502,
		});
	return err;
}
export interface IntegrationActor {
	accountId: string;
	bot?: Bot;
	originalBot?: { id: string; deviceId: string; accountId: string };
}
export interface HubIntegrationDriver {
	callDeviceCommand: (
		deviceId: string,
		action: string,
		payload: unknown,
		options?: { signal?: AbortSignal },
	) => Promise<unknown>;
}
export type HubStoreLike = Pick<DeviceHubStore, "transact" | "snapshot">;

function actorTask(state: HubState, roomId: string, actor: IntegrationActor): string | undefined {
	const room = state.rooms.find((r) => r.id === roomId && r.accountId === actor.accountId);
	if (!room) fail(404, "Room missing");
	if (actor.originalBot) fail(403, "Historical actor is read-only");
	if (!actor.bot) return undefined;
	const bot = state.bots.find(
		(b) =>
			b.id === actor.bot!.id &&
			b.accountId === actor.accountId &&
			b.enabled &&
			b.revision === actor.bot!.revision &&
			b.deviceId === actor.bot!.deviceId,
	);
	if (
		!bot ||
		!room.botIds.includes(bot.id) ||
		!state.devices.some((d) => d.id === bot.deviceId && d.accountId === actor.accountId)
	)
		fail(403, "Actor Bot membership or revision changed");
	const task = state.tasks.find(
		(t) =>
			t.accountId === actor.accountId &&
			t.roomId === roomId &&
			t.botId === bot.id &&
			t.deviceId === bot.deviceId &&
			t.botRevision === bot.revision &&
			t.status === "running" &&
			!t.cancelRequested &&
			state.conversations.some(
				(c) =>
					c.id === t.conversationId &&
					c.latestTaskId === t.id &&
					!c.closed &&
					c.botId === bot.id &&
					c.botRevision === bot.revision &&
					c.deviceId === bot.deviceId,
			),
	);
	if (!task) fail(403, "Current running Bot task required");
	return task.id;
}
function recordFor(
	state: HubState,
	roomId: string,
	conversationId: string,
	id: string,
	actor: IntegrationActor,
): DeviceIntegration {
	const record = state.integrations.find(
		(i) => i.id === id && i.accountId === actor.accountId && i.roomId === roomId && i.conversationId === conversationId,
	);
	if (!record) fail(404, "Integration task not found");
	return record;
}
function latestDelivery(
	state: HubState,
	roomId: string,
	conversationId: string,
	accountId: string,
	deliveryId: string,
): DeviceDelivery {
	if (
		!state.conversations.some(
			(c) => c.id === conversationId && c.roomId === roomId && c.accountId === accountId && !c.closed,
		)
	)
		fail(404, "Conversation missing or closed");
	const delivery = state.deliveries
		.filter((d) => d.accountId === accountId && d.roomId === roomId && d.conversationId === conversationId)
		.at(-1);
	if (!delivery || delivery.id !== deliveryId) fail(409, "Only the latest delivery can be integrated");
	assertDeliveryAuthority(state, delivery);
	return delivery;
}
function targetBot(state: HubState, record: DeviceIntegration, allowLegacyCancellation = false): Bot {
	const room = state.rooms.find((r) => r.id === record.roomId && r.accountId === record.accountId);
	const bot = state.bots.find(
		(b) =>
			b.id === record.targetBotId &&
			b.accountId === record.accountId &&
			b.enabled &&
			b.revision === record.targetBotRevision &&
			(b.deviceId === record.targetDeviceId || (allowLegacyCancellation && record.targetDeviceId === undefined)),
	);
	if (
		!bot ||
		!room?.botIds.includes(bot.id) ||
		!state.devices.some((d) => d.id === bot.deviceId && d.accountId === record.accountId)
	)
		fail(409, "Target Bot membership, revision or device changed");
	return bot;
}
function authority(
	state: HubState,
	record: DeviceIntegration,
	accepted = false,
): { delivery: DeviceDelivery; review?: DeviceReview; bot: Bot } {
	const delivery = latestDelivery(state, record.roomId, record.conversationId, record.accountId, record.deliveryId);
	if (
		delivery.artifactRef
			? !artifactRefsMatch(delivery.artifactRef, record.artifactRef)
			: !!record.artifactRef || !delivery.commit || delivery.commit !== record.commit
	)
		fail(409, "Delivery subject changed");
	let review: DeviceReview | undefined;
	if (accepted || !delivery.artifactRef) {
		review = getAcceptedDeliveryForIntegration(state, record.conversationId, delivery.id).review;
		if (delivery.artifactRef) {
			const task = assertDeliveryAuthority(state, delivery)!;
			const criteria = task.contract!.acceptanceCriteria ?? [];
			if (
				!deliveryReviewMatches(delivery, review) ||
				review.integrationId !== record.id ||
				review.verificationDigest !== record.verification?.digest ||
				!review.criteriaResults ||
				review.criteriaResults.length !== criteria.length ||
				new Set(review.criteriaResults.map((c) => c.criterionIndex)).size !== criteria.length ||
				review.criteriaResults.some(
					(c) =>
						c.verdict !== "met" ||
						!Number.isInteger(c.criterionIndex) ||
						c.criterionIndex < 0 ||
						c.criterionIndex >= criteria.length ||
						!c.evidence.trim(),
				)
			)
				fail(409, "Artifact accepted review must match verification and every sealed criterion");
		}
		if (record.reviewId && record.reviewId !== review.id) fail(409, "Accepted review invalidated");
	}
	return { delivery, review, bot: targetBot(state, record) };
}
function cancellationDevice(state: HubState, record: DeviceIntegration, actor: IntegrationActor): string {
	if (!actor.bot && record.targetDeviceId) {
		if (!state.devices.some((d) => d.id === record.targetDeviceId && d.accountId === actor.accountId))
			fail(409, "Cleanup device is no longer owned by this account");
		return record.targetDeviceId;
	}
	return targetBot(state, record, true).deviceId;
}
function stableSubject(record: DeviceIntegration): string {
	return canonicalizeJson({
		id: record.id,
		accountId: record.accountId,
		roomId: record.roomId,
		conversationId: record.conversationId,
		deliveryId: record.deliveryId,
		commit: record.commit ?? null,
		artifactRef: record.artifactRef ?? null,
		reviewId: record.reviewId ?? null,
		targetBotId: record.targetBotId,
		targetBotRevision: record.targetBotRevision,
		targetDeviceId: record.targetDeviceId ?? null,
		targetBranch: record.targetBranch,
		expectedTargetSha: record.expectedTargetSha,
		materializedCommit: record.materializedCommit ?? null,
		preparedTree: record.preparedTree ?? null,
		verificationPlan: record.verificationPlan ?? null,
		verification: record.verification ?? null,
		verificationMayBeRunning: record.verificationMayBeRunning ?? false,
	});
}
function recheck(
	state: HubState,
	before: DeviceIntegration,
	roomId: string,
	conversationId: string,
	actor: IntegrationActor,
	taskId: string | undefined,
	status: DeviceIntegration["status"],
	accepted = false,
): DeviceIntegration {
	const record = recordFor(state, roomId, conversationId, before.id, actor);
	if (
		record.status !== status ||
		record.currentOpId !== before.currentOpId ||
		stableSubject(record) !== stableSubject(before)
	)
		fail(409, "Integration operation generation or subject changed");
	if (actorTask(state, roomId, actor) !== taskId) fail(403, "Integration actor task changed");
	authority(state, record, accepted);
	return record;
}
async function failed(
	store: HubStoreLike,
	before: DeviceIntegration,
	status: DeviceIntegration["status"],
	error: unknown,
): Promise<never> {
	await store.transact((draft) => {
		const record = draft.integrations.find((i) => i.id === before.id);
		if (record?.publishReceipt) return;
		if (record?.publishIntent && before.publishIntent?.digest === record.publishIntent.digest) {
			record.error = `Publication outcome unknown: ${sanitizePublicError(error)}`.slice(0, 300);
			record.updatedAt = Date.now();
			return;
		}
		if (record?.status === status && record.currentOpId === before.currentOpId) {
			record.status = "failed";
			record.error = sanitizePublicError(error);
			if ((error as { stopUnconfirmed?: boolean } | undefined)?.stopUnconfirmed) {
				record.cleanupPending = true;
				record.verificationMayBeRunning = true;
			}
			if (status === "applying") {
				record.cleanupPending = true;
				record.error = `Apply failed; check target outcome: ${record.error}`.slice(0, 300);
			}
			record.updatedAt = Date.now();
		}
	});
	throw wrapRpcError(error);
}
function driverRequired(driver?: HubIntegrationDriver): HubIntegrationDriver {
	if (!driver?.callDeviceCommand)
		fail(409, "Target device offline or command unavailable; Hub local execution is forbidden");
	return driver;
}

export async function hubPrepareIntegration(
	store: HubStoreLike,
	roomId: string,
	conversationId: string,
	actor: IntegrationActor,
	input: Record<string, unknown>,
	driver?: HubIntegrationDriver,
): Promise<DeviceIntegration> {
	const rpc = driverRequired(driver);
	const deliveryId = text(input.deliveryId, 128, "deliveryId");
	const targetBotId = text(input.targetBotId, 128, "targetBotId");
	const targetBranch = safeBranch(input.targetBranch ?? "main");
	const { before, taskId, artifact } = await store.transact((draft) => {
		const taskId = actorTask(draft, roomId, actor);
		assertNoApplyingIntegration(draft, actor.accountId, roomId, conversationId);
		const delivery = latestDelivery(draft, roomId, conversationId, actor.accountId, deliveryId);
		const review = delivery.artifactRef
			? undefined
			: getAcceptedDeliveryForIntegration(draft, conversationId, deliveryId).review;
		const bot = draft.bots.find((b) => b.id === targetBotId && b.accountId === actor.accountId && b.enabled);
		if (!bot) fail(404, "Target Bot not found or disabled");
		const record: DeviceIntegration = {
			id: randomUUID(),
			accountId: actor.accountId,
			roomId,
			conversationId,
			deliveryId,
			commit: delivery.commit,
			reviewId: review?.id,
			artifactRef: delivery.artifactRef,
			targetBotId,
			targetBotRevision: bot.revision,
			targetDeviceId: bot.deviceId,
			targetBranch,
			expectedTargetSha: "",
			status: "preparing",
			currentOpId: randomUUID(),
			validationCommands: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		targetBot(draft, record);
		draft.integrations.push(record);
		return { before: structuredClone(record), taskId, artifact: assertDeliveryAuthority(draft, delivery)?.artifact };
	});
	try {
		const raw = await rpc.callDeviceCommand(before.targetDeviceId!, "integration_prepare", {
			integrationId: before.id,
			accountId: before.accountId,
			conversationId,
			targetDeviceId: before.targetDeviceId,
			roomId,
			targetBotId,
			targetBotRevision: before.targetBotRevision,
			targetBranch,
			commit: before.commit,
			artifactRef: before.artifactRef,
			artifact,
		});
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(502, "Invalid device prepare response");
		const obj = raw as Record<string, unknown>;
		if (obj.status !== "prepared" && obj.status !== "conflict") fail(502, "Invalid integration status from device");
		if (obj.objectFormat !== "sha1" && obj.objectFormat !== "sha256") fail(502, "Missing repository object format");
		if (before.artifactRef && obj.objectFormat !== "sha1") fail(409, "SHA-256 artifact baselines are unsupported");
		const repositoryId = text(obj.repositoryId, 1024, "repositoryId");
		if (before.artifactRef && repositoryId !== before.artifactRef.repositoryId)
			fail(502, "Repository identity mismatch");
		const expectedTargetSha = sha(obj.expectedTargetSha);
		if (expectedTargetSha.length !== (obj.objectFormat === "sha1" ? 40 : 64)) fail(502, "Object format mismatch");
		if (before.artifactRef && expectedTargetSha !== before.artifactRef.baselineCommit)
			fail(409, "Artifact target must equal sealed baseline commit");
		const materializedCommit = obj.status === "prepared" ? sha(obj.materializedCommit) : undefined;
		const preparedTree = obj.status === "prepared" ? sha(obj.preparedTree) : undefined;
		if ([materializedCommit, preparedTree].some((value) => value && value.length !== expectedTargetSha.length))
			fail(502, "Prepared object format mismatch");
		if (before.artifactRef && obj.status === "prepared" && preparedTree !== before.artifactRef.outputTree)
			fail(502, "Prepared artifact tree mismatch");
		if (obj.conflicts !== undefined && (!Array.isArray(obj.conflicts) || obj.conflicts.length > 256))
			fail(502, "Invalid conflicts");
		const conflicts = (obj.conflicts as unknown[] | undefined)?.map((c) => text(c, 1024, "conflict"));
		const diff = obj.diff === undefined || obj.diff === "" ? undefined : text(obj.diff, 64 * 1024, "diff");
		return await store.transact((draft) => {
			const record = recheck(draft, before, roomId, conversationId, actor, taskId, "preparing");
			Object.assign(record, {
				status: obj.status,
				expectedTargetSha,
				materializedCommit,
				preparedTree,
				objectFormat: obj.objectFormat,
				repositoryId,
				conflicts,
				diff,
				updatedAt: Date.now(),
			});
			return structuredClone(record);
		});
	} catch (error) {
		return failed(store, before, "preparing", error);
	}
}

export async function hubVerifyIntegration(
	store: HubStoreLike,
	roomId: string,
	conversationId: string,
	integrationId: string,
	actor: IntegrationActor,
	input: Record<string, unknown>,
	driver?: HubIntegrationDriver,
): Promise<DeviceIntegration> {
	const rpc = driverRequired(driver);
	const { before, taskId } = await store.transact((draft) => {
		const taskId = actorTask(draft, roomId, actor);
		const record = recordFor(draft, roomId, conversationId, integrationId, actor);
		if (record.publishIntent || isLegacyPublicationUnknown(record))
			fail(409, "Publication outcome is unresolved; manual recovery or read-only reconcile required");
		if (record.verification)
			fail(409, "Successful verification is immutable; prepare a new integration to verify again");
		if (record.status !== "prepared" && record.status !== "failed")
			fail(409, `Cannot verify integration in status '${record.status}'`);
		authority(draft, record);
		if (!record.preparedTree || !record.materializedCommit)
			fail(409, "Missing prepared tree and materialized commit proof");
		if (actor.bot) {
			if (!record.verificationPlan || record.verificationPlan.authorizedByAccountId !== actor.accountId)
				fail(403, "Only the account owner may authorize verification commands");
			if (
				input.commands !== undefined &&
				canonicalizeJson(input.commands) !== canonicalizeJson(record.verificationPlan.commands)
			)
				fail(403, "Bot cannot change owner-authorized verification commands");
		} else if (record.verificationPlan) {
			if (
				input.commands !== undefined &&
				canonicalizeJson(input.commands) !== canonicalizeJson(record.verificationPlan.commands)
			)
				fail(409, "Verification plan is frozen; prepare a new integration to change commands");
		} else record.verificationPlan = freezeVerificationPlan(input.commands, actor.accountId);
		record.status = "verifying";
		record.verificationMayBeRunning = true;
		record.currentOpId = randomUUID();
		record.error = undefined;
		record.updatedAt = Date.now();
		return { before: structuredClone(record), taskId };
	});
	try {
		const raw = await rpc.callDeviceCommand(before.targetDeviceId!, "integration_verify", {
			integrationId,
			roomId,
			targetBotId: before.targetBotId,
			targetBotRevision: before.targetBotRevision,
			verificationPlan: before.verificationPlan,
			artifactRef: before.artifactRef,
			materializedCommit: before.materializedCommit,
			preparedTree: before.preparedTree,
			expectedTargetSha: before.expectedTargetSha,
		});
		const { status, facts } = validateVerificationFacts(raw, before);
		return await store.transact((draft) => {
			const record = recheck(draft, before, roomId, conversationId, actor, taskId, "verifying");
			record.status = status;
			record.verificationMayBeRunning = false;
			record.validationCommands = facts.results.map((r) => ({
				command: r.command,
				status: r.status,
				exitCode: r.exitCode,
				output: r.outputPreview,
			}));
			if (status === "verified")
				record.verification = { ...facts, digest: computeVerificationDigest(record, facts), verifiedAt: Date.now() };
			record.updatedAt = Date.now();
			return structuredClone(record);
		});
	} catch (error) {
		return failed(store, before, "verifying", error);
	}
}

export async function hubConfirmIntegration(
	store: HubStoreLike,
	roomId: string,
	conversationId: string,
	integrationId: string,
	actor: IntegrationActor,
	input: Record<string, unknown>,
	driver?: HubIntegrationDriver,
): Promise<DeviceIntegration> {
	const { before, dispatch } = await store.transact((draft) => {
		const record = recordFor(draft, roomId, conversationId, integrationId, actor);
		if (actor.originalBot) fail(403, "Historical actor is read-only");
		if (record.publishIntent || record.status === "applied")
			return { before: structuredClone(record), dispatch: false };
		driverRequired(driver);
		const taskId = actorTask(draft, roomId, actor);
		if (record.status !== "verified" || !hasVerifiedIntegration(record))
			fail(409, "Apply requires successful real verification proof");
		const { delivery, review } = authority(draft, record, true);
		const expected = text(input.expectedTargetSha ?? record.expectedTargetSha, 64, "expectedTargetSha");
		if (expected !== record.expectedTargetSha) fail(409, "Expected target SHA mismatch");
		if (!record.repositoryId || !record.objectFormat)
			fail(409, "Prepare must capture repository identity and object format");
		const createdAt = Date.now();
		record.publishIntent = sealPublishIntent({
			version: 1,
			id: randomUUID(),
			accountId: record.accountId,
			roomId,
			conversationId,
			integrationId,
			targetDeviceId: record.targetDeviceId!,
			targetBotId: record.targetBotId,
			targetBotRevision: record.targetBotRevision,
			actor: {
				accountId: actor.accountId,
				...(actor.bot
					? { botId: actor.bot.id, botRevision: actor.bot.revision, botDeviceId: actor.bot.deviceId, taskId }
					: {}),
			},
			repositoryId: record.repositoryId,
			objectFormat: record.objectFormat,
			targetRef: record.targetBranch.startsWith("refs/heads/")
				? record.targetBranch
				: `refs/heads/${record.targetBranch}`,
			expectedOld: record.expectedTargetSha,
			preparedTree: record.preparedTree!,
			materializedCommit: record.materializedCommit!,
			createdAt,
			delivery: {
				id: delivery.id,
				...(delivery.commit ? { commit: delivery.commit } : {}),
				...(delivery.artifactRef ? { artifactRef: structuredClone(delivery.artifactRef) } : {}),
			},
			review: structuredClone(review!),
			verificationPlan: structuredClone(record.verificationPlan!),
			verification: structuredClone(record.verification!),
		});
		record.reviewId = review!.id;
		record.status = "applying";
		record.currentOpId = randomUUID();
		record.updatedAt = createdAt;
		return { before: structuredClone(record), dispatch: true };
	});
	if (!dispatch) return before;
	return dispatchPublication(store, before, driverRequired(driver), "first");
}

export async function hubCancelIntegration(
	store: HubStoreLike,
	roomId: string,
	conversationId: string,
	integrationId: string,
	actor: IntegrationActor,
	driver?: HubIntegrationDriver,
): Promise<DeviceIntegration> {
	const existing = recordFor(store.snapshot(), roomId, conversationId, integrationId, actor);
	if (existing.publishIntent) {
		if (actor.originalBot) fail(403, "Historical actor is read-only");
		if (actor.bot) actorTask(store.snapshot(), roomId, actor);
		if (existing.publishReceipt && !hasOpenPublication(existing)) return existing;
		const rpc = driverRequired(driver);
		const before = await store.transact((draft) => {
			const record = recordFor(draft, roomId, conversationId, integrationId, actor);
			if (record.publishIntent?.digest !== existing.publishIntent!.digest) fail(409, "Publication intent changed");
			if (!record.publishReceipt && hasOpenPublication(record)) record.status = "cancelling";
			if (record.publishObservation) record.publishObservation.retryable = false;
			return structuredClone(record);
		});
		if (!hasOpenPublication(before)) return before;
		try {
			const raw = await rpc.callDeviceCommand(before.publishIntent!.targetDeviceId, "integration_cancel", {
				...publicationPayload(before),
				ownerCleanup: !actor.bot,
			});
			return await mergePublicationResult(store, before, raw);
		} catch (error) {
			return failed(store, before, "cancelling", error);
		}
	}
	const { before, taskId, priorStatus } = await store.transact((draft) => {
		const record = recordFor(draft, roomId, conversationId, integrationId, actor);
		if (record.status === "applied") fail(409, "Already applied integration cannot be cancelled");
		if (isLegacyPublicationUnknown(record))
			fail(409, "Legacy publication outcome unknown; manual investigation required");
		const taskId = actor.bot ? actorTask(draft, roomId, actor) : undefined;
		driverRequired(driver);
		const priorStatus = record.status;
		if (["verifying", "failed", "verified"].includes(record.status) && !hasVerifiedIntegration(record))
			record.verificationMayBeRunning = true;
		const deviceId = cancellationDevice(draft, record, actor);
		record.targetDeviceId ??= deviceId;
		if (record.status !== "cancelled") {
			record.status = "cancelling";
			record.currentOpId = randomUUID();
			record.updatedAt = Date.now();
		}
		return { before: structuredClone(record), taskId, priorStatus };
	});
	if (before.status === "cancelled") return before;
	try {
		const raw = await driverRequired(driver).callDeviceCommand(before.targetDeviceId!, "integration_cancel", {
			integrationId,
			roomId,
			targetBotId: before.targetBotId,
			targetBotRevision: before.targetBotRevision,
			priorStatus,
			verificationMayBeRunning: before.verificationMayBeRunning === true,
			ownerCleanup: !actor.bot,
		});
		if (!raw || typeof raw !== "object" || (raw as any).status !== "cancelled")
			fail(502, "Device has not confirmed integration stop and cleanup");
		return await store.transact((draft) => {
			const record = recordFor(draft, roomId, conversationId, integrationId, actor);
			if (
				record.status !== "cancelling" ||
				record.currentOpId !== before.currentOpId ||
				stableSubject(record) !== stableSubject(before)
			)
				fail(409, "Cancellation generation changed");
			if (actor.bot && actorTask(draft, roomId, actor) !== taskId) fail(403, "Integration actor task changed");
			if (cancellationDevice(draft, record, actor) !== before.targetDeviceId) fail(409, "Cleanup device changed");
			record.status = "cancelled";
			record.verificationMayBeRunning = false;
			record.cleanupPending = false;
			record.updatedAt = Date.now();
			return structuredClone(record);
		});
	} catch (error) {
		return failed(store, before, "cancelling", error);
	}
}
function publicationPayload(record: DeviceIntegration) {
	const intent = validatePublishIntent(record.publishIntent);
	return {
		integrationId: intent.integrationId,
		accountId: intent.accountId,
		roomId: intent.roomId,
		conversationId: intent.conversationId,
		targetBotId: intent.targetBotId,
		targetBotRevision: intent.targetBotRevision,
		publishIntent: intent,
	};
}

async function mergePublicationResult(
	store: HubStoreLike,
	before: DeviceIntegration,
	raw: unknown,
): Promise<DeviceIntegration> {
	const intent = validatePublishIntent(before.publishIntent);
	const result = validatePublicationResult(raw, intent);
	return store.transact((draft) => {
		const record = draft.integrations.find(
			(i) =>
				i.id === intent.integrationId &&
				i.accountId === intent.accountId &&
				i.roomId === intent.roomId &&
				i.conversationId === intent.conversationId,
		);
		if (!record || record.publishIntent?.digest !== intent.digest || record.publishIntent.id !== intent.id)
			fail(409, "Publication intent changed");
		validatePublishIntent(record.publishIntent);
		if (result.publishReceipt && !record.publishReceipt) record.publishReceipt = result.publishReceipt;
		if (
			result.publishObservation &&
			(!record.publishObservation || result.publishObservation.observedAt >= record.publishObservation.observedAt)
		)
			record.publishObservation = result.publishObservation;
		if (result.publishStop) {
			const previous = record.publishStop;
			if (!previous) record.publishStop = result.publishStop;
			else if (!previous.stopConfirmed && result.publishStop.stopConfirmed)
				record.publishStop = {
					...result.publishStop,
					closed: previous.closed || result.publishStop.closed,
					fencedAt: Math.min(previous.fencedAt, result.publishStop.fencedAt),
				};
			else if (!previous.closed && result.publishStop.closed)
				record.publishStop = {
					...previous,
					closed: true,
					fencedAt: Math.min(previous.fencedAt, result.publishStop.fencedAt),
				};
		}
		if (record.publishReceipt) {
			record.status = "applied";
			record.newCommitSha = intent.candidateSha;
			if (record.publishStop) record.publishStop.pastEffect = "applied";
			if (record.publishObservation) record.publishObservation.retryable = false;
			record.error = undefined;
		} else if (record.publishStop?.closed && record.publishStop.stopConfirmed) {
			record.status = record.publishStop.pastEffect === "not_applied" ? "cancelled" : "cancelling";
			if (record.publishObservation) record.publishObservation.retryable = false;
			record.error =
				record.publishStop.pastEffect === "unknown"
					? "Publication closed for future writes; historical outcome remains unknown"
					: undefined;
		} else {
			record.status = record.status === "cancelling" ? "cancelling" : "applying";
			if (record.status === "cancelling" && record.publishObservation) record.publishObservation.retryable = false;
			record.error = result.publishObservation?.error;
		}
		if (result.cleanupPending !== undefined) record.cleanupPending = result.cleanupPending;
		record.updatedAt = Date.now();
		return structuredClone(record);
	});
}

async function dispatchPublication(
	store: HubStoreLike,
	before: DeviceIntegration,
	driver: HubIntegrationDriver,
	mode: "first" | "resume",
): Promise<DeviceIntegration> {
	try {
		const raw = await driver.callDeviceCommand(before.publishIntent!.targetDeviceId, "integration_confirm", {
			...publicationPayload(before),
			mode,
			deliveryId: before.deliveryId,
			commit: before.commit,
			expectedTargetSha: before.expectedTargetSha,
			artifactRef: before.artifactRef,
			materializedCommit: before.materializedCommit,
			verificationDigest: before.verification!.digest,
		});
		return await mergePublicationResult(store, before, raw);
	} catch (error) {
		return failed(store, before, "applying", error);
	}
}

function historicalActor(record: DeviceIntegration, actor: IntegrationActor): void {
	const bot = actor.originalBot ?? actor.bot;
	if (!bot) return;
	const intent = record.publishIntent;
	if (
		!intent ||
		bot.accountId !== intent.accountId ||
		!(
			(bot.id === intent.targetBotId && bot.deviceId === intent.targetDeviceId) ||
			(bot.id === intent.actor.botId && bot.deviceId === intent.actor.botDeviceId)
		)
	)
		fail(403, "Historical publication actor scope mismatch");
}

export async function hubReconcileIntegration(
	store: HubStoreLike,
	roomId: string,
	conversationId: string,
	actor: IntegrationActor,
	id: string,
	driver?: HubIntegrationDriver,
): Promise<DeviceIntegration> {
	const before = recordFor(store.snapshot(), roomId, conversationId, id, actor);
	historicalActor(before, actor);
	if (!before.publishIntent) return structuredClone(before);
	try {
		const raw = await driverRequired(driver).callDeviceCommand(
			before.publishIntent.targetDeviceId,
			"integration_publication_status",
			publicationPayload(before),
		);
		return await mergePublicationResult(store, before, raw);
	} catch (error) {
		return failed(store, before, before.status, error);
	}
}

export async function hubResumeIntegration(
	store: HubStoreLike,
	roomId: string,
	conversationId: string,
	actor: IntegrationActor,
	id: string,
	input: DeviceIntegrationResumeRequest,
	driver?: HubIntegrationDriver,
): Promise<DeviceIntegration> {
	if (actor.bot || actor.originalBot) fail(403, "Only the human account owner may resume publication");
	const before = await store.transact((draft) => {
		actorTask(draft, roomId, actor);
		const record = recordFor(draft, roomId, conversationId, id, actor);
		const intent = validatePublishIntent(record.publishIntent);
		if (
			!input ||
			input.intentId !== intent.id ||
			input.intentDigest !== intent.digest ||
			input.candidateSha !== intent.candidateSha
		)
			fail(409, "Resume must bind exact publication intent");
		if (record.publishReceipt) return structuredClone(record);
		if (record.publishStop?.closed) fail(409, "Publication is closed for future writes");
		if (record.status === "cancelling") fail(409, "Publication cancellation is in progress");
		if (
			!record.publishObservation?.retryable ||
			!["prepared", "cas_rejected"].includes(record.publishObservation.phase)
		)
			fail(409, "Publication is not proven safe to resume; reconcile first");
		validatePublicationResult({ status: "pending", publishObservation: record.publishObservation }, intent);
		const { review } = authority(draft, record, true);
		if (
			review?.id !== intent.review.id ||
			!hasVerifiedIntegration(record) ||
			record.verification?.digest !== intent.verification.digest ||
			record.repositoryId !== intent.repositoryId ||
			record.objectFormat !== intent.objectFormat ||
			record.expectedTargetSha !== intent.expectedOld ||
			record.preparedTree !== intent.preparedTree ||
			record.materializedCommit !== intent.materializedCommit ||
			record.targetDeviceId !== intent.targetDeviceId ||
			record.targetBotId !== intent.targetBotId ||
			record.targetBotRevision !== intent.targetBotRevision ||
			(record.targetBranch.startsWith("refs/heads/") ? record.targetBranch : `refs/heads/${record.targetBranch}`) !==
				intent.targetRef
		)
			fail(409, "Current publication authority or verification changed");
		driverRequired(driver);
		record.status = "applying";
		record.currentOpId = randomUUID();
		record.publishObservation.retryable = false;
		record.updatedAt = Date.now();
		return structuredClone(record);
	});
	if (before.publishReceipt) return before;
	return dispatchPublication(store, before, driverRequired(driver), "resume");
}

const pendingRecovery = new WeakMap<HubStoreLike, Map<string, Promise<DeviceIntegration>>>();
const recoveryBatches = new WeakMap<HubStoreLike, Promise<DeviceIntegration[]>>();
const recoveryCursors = new WeakMap<HubStoreLike, Map<string, number>>();
export async function reconcilePendingIntegrations(
	store: HubStoreLike,
	driver: HubIntegrationDriver,
	options: { limit?: number; deviceId?: string } = {},
): Promise<DeviceIntegration[]> {
	const active = recoveryBatches.get(store);
	if (active) return active;
	const batch = runPendingRecovery(store, driver, options);
	recoveryBatches.set(store, batch);
	try {
		return await batch;
	} finally {
		if (recoveryBatches.get(store) === batch) recoveryBatches.delete(store);
	}
}

async function runPendingRecovery(
	store: HubStoreLike,
	driver: HubIntegrationDriver,
	options: { limit?: number; deviceId?: string },
): Promise<DeviceIntegration[]> {
	const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(64, Math.floor(options.limit!))) : 16;
	const all = store
		.snapshot()
		.integrations.filter(
			(i) => hasOpenPublication(i) && (!options.deviceId || i.publishIntent!.targetDeviceId === options.deviceId),
		);
	let cursors = recoveryCursors.get(store);
	if (!cursors) {
		cursors = new Map();
		recoveryCursors.set(store, cursors);
	}
	const scope = options.deviceId ?? "";
	const start = (cursors.get(scope) ?? 0) % Math.max(1, all.length);
	const pending = [...all.slice(start), ...all.slice(0, start)].slice(0, limit);
	cursors.set(scope, (start + pending.length) % Math.max(1, all.length));
	let running = pendingRecovery.get(store);
	if (!running) {
		running = new Map();
		pendingRecovery.set(store, running);
	}
	const results: DeviceIntegration[] = [];
	let cursor = 0;
	await Promise.all(
		Array.from({ length: Math.min(4, pending.length) }, async () => {
			while (cursor < pending.length) {
				const record = pending[cursor++];
				const key = record.publishIntent!.id;
				let operation = running!.get(key);
				if (!operation) {
					operation = hubReconcileIntegration(
						store,
						record.roomId,
						record.conversationId,
						{ accountId: record.accountId },
						record.id,
						driver,
					);
					running!.set(key, operation);
				}
				try {
					results.push(await operation);
				} catch {
				} finally {
					if (running!.get(key) === operation) running!.delete(key);
				}
			}
		}),
	);
	return results;
}

export function listIntegrations(state: HubState, conversationId: string): DeviceIntegration[] {
	return state.integrations.filter((i) => i.conversationId === conversationId);
}
