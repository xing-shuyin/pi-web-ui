import { createHash } from "node:crypto";
import type { DevicePublishIntent, DevicePublishIntentFacts, DevicePublicationResult } from "../protocol.js";
import { canonicalizeJson } from "./work-contract.js";
import { artifactRefsMatch } from "./delivery-subject.js";
import { computeVerificationPlanDigest, hasVerifiedIntegration } from "./integration-verification.js";

export const MAX_PUBLISH_INTENT_BYTES = 384 * 1024;

export function buildPublishCommit(intent: DevicePublishIntent): { raw: Buffer; candidateSha: string } {
	if (intent.version !== 1 || (intent.objectFormat !== "sha1" && intent.objectFormat !== "sha256"))
		invalid("commit builder version or format");
	const length = intent.objectFormat === "sha1" ? 40 : 64;
	for (const value of [intent.expectedOld, intent.preparedTree, intent.materializedCommit]) hash(value, length);
	hash(intent.digest, 64);
	bounded(intent.id, 1024);
	bounded(intent.integrationId, 1024);
	time(intent.createdAt);
	const timestamp = Math.floor(intent.createdAt / 1000);
	const raw = Buffer.from(
		`tree ${intent.preparedTree}\nparent ${intent.expectedOld}\nparent ${intent.materializedCommit}\nauthor Pi Publication <publication@pi.invalid> ${timestamp} +0000\ncommitter Pi Publication <publication@pi.invalid> ${timestamp} +0000\n\nPublish integration ${intent.integrationId}\n\nIntent: ${intent.id}\nIntent-Digest: ${intent.digest}\n`,
		"utf8",
	);
	const candidateSha = createHash(intent.objectFormat)
		.update(Buffer.from(`commit ${raw.length}\0`, "utf8"))
		.update(raw)
		.digest("hex");
	return { raw, candidateSha };
}

export function sealPublishIntent(facts: DevicePublishIntentFacts): DevicePublishIntent {
	const copy = structuredClone(facts);
	const digest = createHash("sha256").update(canonicalizeJson(copy)).digest("hex");
	const intent = { ...copy, digest, candidateSha: "" };
	intent.candidateSha = buildPublishCommit(intent).candidateSha;
	return validatePublishIntent(intent);
}

export function validatePublishIntent(value: unknown): DevicePublishIntent {
	return validateIntent(value);
}

export function assertPublishIntentScope(
	intent: DevicePublishIntent,
	scope: {
		accountId: string;
		roomId?: string;
		conversationId?: string;
		integrationId?: string;
		targetDeviceId?: string;
		targetBotId?: string;
		targetBotRevision?: number;
		repositoryId?: string;
	},
): void {
	for (const [key, expected] of Object.entries(scope)) {
		if (expected !== undefined && intent[key as keyof DevicePublishIntent] !== expected)
			throw new Error(`Publication intent ${key} mismatch`);
	}
}

export function validatePublicationResult(value: unknown, intent: DevicePublishIntent): DevicePublicationResult {
	return validateResult(value, intent);
}

function invalid(message: string): never {
	throw new Error(`Invalid publication ${message}`);
}
function object(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
		invalid(name);
	return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
	if (
		required.some((k) => value[k] === undefined) ||
		Object.keys(value).some((k) => !required.includes(k) && !optional.includes(k))
	)
		invalid("fields");
}
function bounded(value: unknown, max = 256): asserts value is string {
	if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value))
		invalid("text");
}
function time(value: unknown): void {
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 8_640_000_000_000_000)
		invalid("timestamp");
}
function hash(value: unknown, length: number): void {
	if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`).test(value)) invalid("hash");
}
function validateIntent(value: unknown): DevicePublishIntent {
	const obj = object(value, "intent");
	if (Buffer.byteLength(JSON.stringify(obj), "utf8") > MAX_PUBLISH_INTENT_BYTES)
		throw Object.assign(new Error("Publication aggregate proof exceeds transport budget (384 KiB)"), { status: 413 });
	const required = [
		"version",
		"id",
		"accountId",
		"roomId",
		"conversationId",
		"integrationId",
		"targetDeviceId",
		"targetBotId",
		"targetBotRevision",
		"actor",
		"repositoryId",
		"objectFormat",
		"targetRef",
		"expectedOld",
		"preparedTree",
		"materializedCommit",
		"createdAt",
		"delivery",
		"review",
		"verificationPlan",
		"verification",
		"digest",
		"candidateSha",
	];
	keys(obj, required);
	if (obj.version !== 1 || (obj.objectFormat !== "sha1" && obj.objectFormat !== "sha256"))
		invalid("version or object format");
	for (const key of [
		"id",
		"accountId",
		"roomId",
		"conversationId",
		"integrationId",
		"targetDeviceId",
		"targetBotId",
		"repositoryId",
	])
		bounded(obj[key], 1024);
	if (!Number.isSafeInteger(obj.targetBotRevision) || (obj.targetBotRevision as number) < 0) invalid("Bot revision");
	time(obj.createdAt);
	bounded(obj.targetRef);
	if (
		!obj.targetRef.startsWith("refs/heads/") ||
		obj.targetRef.length <= 11 ||
		/[\s~^:?*[\\\]]/.test(obj.targetRef) ||
		obj.targetRef.includes("..") ||
		obj.targetRef.includes("@{") ||
		obj.targetRef.includes("//") ||
		obj.targetRef.split("/").some((p) => !p || p.startsWith(".") || p.endsWith(".") || p.endsWith(".lock"))
	)
		invalid("branch ref");
	const length = obj.objectFormat === "sha1" ? 40 : 64;
	for (const key of ["expectedOld", "preparedTree", "materializedCommit", "candidateSha"]) hash(obj[key], length);
	hash(obj.digest, 64);
	const actor = object(obj.actor, "actor");
	keys(actor, ["accountId"], ["botId", "botRevision", "botDeviceId", "taskId"]);
	if (actor.accountId !== obj.accountId) invalid("actor account");
	if (actor.botId !== undefined) {
		bounded(actor.botId);
		bounded(actor.taskId);
		bounded(actor.botDeviceId);
		if (!Number.isSafeInteger(actor.botRevision) || (actor.botRevision as number) < 0) invalid("actor revision");
	} else if (actor.taskId !== undefined || actor.botRevision !== undefined || actor.botDeviceId !== undefined)
		invalid("actor audit");
	const delivery = object(obj.delivery, "delivery");
	keys(delivery, ["id"], ["commit", "artifactRef"]);
	bounded(delivery.id);
	if (delivery.commit !== undefined) hash(delivery.commit, length);
	const review = object(obj.review, "review");
	keys(
		review,
		["id", "accountId", "roomId", "conversationId", "deliveryId", "reviewer", "verdict", "summary", "createdAt"],
		["commit", "artifactDigest", "integrationId", "verificationDigest", "criteriaResults", "artifactRef"],
	);
	bounded(review.id);
	if (
		review.accountId !== obj.accountId ||
		review.roomId !== obj.roomId ||
		review.conversationId !== obj.conversationId ||
		review.deliveryId !== delivery.id ||
		review.verdict !== "accepted" ||
		typeof review.summary !== "string" ||
		review.summary.length > 32768
	)
		invalid("accepted review scope");
	time(review.createdAt);
	const reviewer = object(review.reviewer, "reviewer");
	keys(reviewer, ["type", "id"]);
	if (reviewer.type !== "human" && reviewer.type !== "bot") invalid("reviewer");
	bounded(reviewer.id);
	if (delivery.artifactRef !== undefined) {
		if (obj.objectFormat !== "sha1") invalid("SHA-256 artifact baseline unsupported");
		const artifact = object(delivery.artifactRef, "artifactRef");
		const reviewArtifact = object(review.artifactRef, "review artifactRef");
		keys(reviewArtifact, [
			"artifactTaskId",
			"attemptId",
			"artifactId",
			"artifactDigest",
			"contractId",
			"contractRevision",
			"contractDigest",
			"manifestDigest",
			"baselineCommit",
			"repositoryId",
			"inputTree",
			"outputTree",
		]);
		if (review.commit !== undefined) invalid("artifact review commit");
		keys(artifact, [
			"artifactTaskId",
			"attemptId",
			"artifactId",
			"artifactDigest",
			"contractId",
			"contractRevision",
			"contractDigest",
			"manifestDigest",
			"baselineCommit",
			"repositoryId",
			"inputTree",
			"outputTree",
		]);
		for (const key of ["artifactTaskId", "attemptId", "artifactId", "contractId", "repositoryId"])
			bounded(artifact[key], 1024);
		for (const key of ["artifactDigest", "contractDigest", "manifestDigest"]) hash(artifact[key], 64);
		for (const key of ["baselineCommit", "inputTree", "outputTree"]) hash(artifact[key], 40);
		if (
			!Number.isSafeInteger(artifact.contractRevision) ||
			(artifact.contractRevision as number) < 1 ||
			artifact.repositoryId !== obj.repositoryId ||
			artifact.baselineCommit !== obj.expectedOld ||
			artifact.outputTree !== obj.preparedTree ||
			!artifactRefsMatch(delivery.artifactRef as any, review.artifactRef as any) ||
			review.artifactDigest !== artifact.artifactDigest ||
			review.integrationId !== obj.integrationId
		)
			invalid("artifact review");
		const criteria = review.criteriaResults;
		if (
			!Array.isArray(criteria) ||
			criteria.length > 64 ||
			criteria.some((v, index) => {
				const criterion = object(v, "review criterion");
				keys(criterion, ["criterionIndex", "verdict", "evidence"]);
				return (
					!Number.isSafeInteger(criterion.criterionIndex) ||
					(criterion.criterionIndex as number) < 0 ||
					(criterion.criterionIndex as number) > 63 ||
					criterion.verdict !== "met" ||
					typeof criterion.evidence !== "string" ||
					!criterion.evidence.trim() ||
					criterion.evidence.length > 2000 ||
					criteria.slice(0, index).some((p: any) => p.criterionIndex === criterion.criterionIndex)
				);
			})
		)
			invalid("review criteria");
	} else if (
		!delivery.commit ||
		review.commit !== delivery.commit ||
		review.artifactRef !== undefined ||
		review.artifactDigest !== undefined ||
		review.integrationId !== undefined ||
		review.verificationDigest !== undefined ||
		review.criteriaResults !== undefined
	)
		invalid("legacy review subject");
	const plan = object(obj.verificationPlan, "verification plan");
	keys(plan, ["commands", "digest", "authorizedByAccountId", "authorizedAt"]);
	if (
		!Array.isArray(plan.commands) ||
		plan.commands.length < 1 ||
		plan.commands.length > 8 ||
		plan.commands.some(
			(c) => typeof c !== "string" || !c.trim() || c.length > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(c),
		) ||
		plan.digest !== computeVerificationPlanDigest(plan.commands as string[]) ||
		plan.authorizedByAccountId !== obj.accountId
	)
		invalid("verification plan");
	time(plan.authorizedAt);
	const verification = object(obj.verification, "verification");
	keys(
		verification,
		["planDigest", "materializedCommit", "treeBefore", "treeAfter", "results", "digest", "verifiedAt"],
		["artifactDigest"],
	);
	time(verification.verifiedAt);
	hash(verification.digest, 64);
	if (!Array.isArray(verification.results)) invalid("verification results");
	for (const item of verification.results)
		keys(object(item, "verification result"), ["command", "status", "exitCode", "outputDigest", "outputPreview"]);
	if (delivery.artifactRef && review.verificationDigest !== verification.digest) invalid("review verification");
	const intent = obj as unknown as DevicePublishIntent;
	const integration = {
		id: intent.integrationId,
		accountId: intent.accountId,
		roomId: intent.roomId,
		conversationId: intent.conversationId,
		deliveryId: intent.delivery.id,
		commit: intent.delivery.commit,
		artifactRef: intent.delivery.artifactRef,
		targetBotId: intent.targetBotId,
		targetBotRevision: intent.targetBotRevision,
		targetDeviceId: intent.targetDeviceId,
		expectedTargetSha: intent.expectedOld,
		preparedTree: intent.preparedTree,
		materializedCommit: intent.materializedCommit,
		objectFormat: intent.objectFormat,
		verificationPlan: intent.verificationPlan,
		verification: intent.verification,
	};
	if (
		![intent.targetRef, intent.targetRef.slice(11)].some((targetBranch) =>
			hasVerifiedIntegration({ ...integration, targetBranch } as any),
		)
	)
		invalid("verification proof");
	const { digest, candidateSha, ...facts } = intent;
	if (
		digest !== createHash("sha256").update(canonicalizeJson(facts)).digest("hex") ||
		candidateSha !== buildPublishCommit(intent).candidateSha
	)
		invalid("intent digest or candidate");
	return structuredClone(intent);
}
function validateResult(value: unknown, intent: DevicePublishIntent): DevicePublicationResult {
	const obj = object(value, "result");
	keys(obj, ["status"], ["publishReceipt", "publishObservation", "publishStop", "cleanupPending", "newCommitSha"]);
	if (obj.cleanupPending !== undefined && typeof obj.cleanupPending !== "boolean") invalid("cleanup status");
	if (obj.newCommitSha !== undefined && obj.newCommitSha !== intent.candidateSha) invalid("result candidate");
	if (!["applied", "pending", "cancelled"].includes(obj.status as string)) invalid("result status");
	for (const key of ["publishReceipt", "publishObservation", "publishStop"]) {
		if (obj[key] === undefined) continue;
		const evidence = object(obj[key], key);
		if (
			evidence.intentId !== intent.id ||
			evidence.intentDigest !== intent.digest ||
			evidence.candidateSha !== intent.candidateSha
		)
			invalid("evidence identity");
		if (key === "publishReceipt") {
			keys(evidence, ["intentId", "intentDigest", "candidateSha", "outcome", "proof", "observedAt"], ["targetSha"]);
			time(evidence.observedAt);
			if (
				evidence.outcome !== "applied" ||
				!["cas_exit", "target_exact", "target_descendant"].includes(evidence.proof as string) ||
				(evidence.proof === "target_exact" && evidence.targetSha !== intent.candidateSha) ||
				(evidence.proof === "target_descendant" && !evidence.targetSha)
			)
				invalid("receipt proof");
		} else if (key === "publishObservation") {
			keys(
				evidence,
				["intentId", "intentDigest", "candidateSha", "observedAt", "target", "phase", "retryable"],
				["targetSha", "error"],
			);
			time(evidence.observedAt);
			if (
				!["candidate", "descendant", "expected_old", "other", "missing", "unknown"].includes(
					evidence.target as string,
				) ||
				!["absent", "prepared", "cas_started", "cas_rejected", "applied", "closed", "unknown"].includes(
					evidence.phase as string,
				) ||
				typeof evidence.retryable !== "boolean" ||
				(evidence.retryable &&
					(!["prepared", "cas_rejected"].includes(evidence.phase as string) || evidence.target !== "expected_old"))
			)
				invalid("observation");
			if (
				(evidence.target === "candidate" && evidence.targetSha !== intent.candidateSha) ||
				(["descendant", "other"].includes(evidence.target as string) && !evidence.targetSha) ||
				(evidence.target === "expected_old" && evidence.targetSha !== intent.expectedOld) ||
				(evidence.error !== undefined && (typeof evidence.error !== "string" || evidence.error.length > 2048))
			)
				invalid("target observation");
		} else {
			keys(
				evidence,
				["intentId", "intentDigest", "candidateSha", "closed", "stopConfirmed", "pastEffect", "fencedAt"],
				["stoppedAt"],
			);
			time(evidence.fencedAt);
			if (
				typeof evidence.closed !== "boolean" ||
				typeof evidence.stopConfirmed !== "boolean" ||
				!["applied", "not_applied", "unknown"].includes(evidence.pastEffect as string)
			)
				invalid("stop");
			if (evidence.stopConfirmed) time(evidence.stoppedAt);
			else if (evidence.stoppedAt !== undefined || evidence.pastEffect === "not_applied") invalid("unconfirmed stop");
		}
		if (evidence.targetSha !== undefined) hash(evidence.targetSha, intent.objectFormat === "sha1" ? 40 : 64);
	}
	const observation = obj.publishObservation as Record<string, unknown> | undefined;
	const stoppedWithoutEffect =
		(obj.publishStop as any)?.closed &&
		(obj.publishStop as any)?.stopConfirmed &&
		(obj.publishStop as any)?.pastEffect === "not_applied";
	if (
		observation &&
		((["candidate", "descendant"].includes(observation.target as string) &&
			!obj.publishReceipt &&
			!stoppedWithoutEffect) ||
			(observation.phase === "applied" && !obj.publishReceipt) ||
			(observation.phase === "closed" && !obj.publishStop))
	)
		invalid("observation proof");
	if (obj.status === "applied" && !obj.publishReceipt) invalid("missing applied receipt");
	if (obj.publishReceipt && obj.status !== "applied") invalid("applied receipt status");
	if (
		obj.status === "cancelled" &&
		(!(obj.publishStop as any)?.closed ||
			!(obj.publishStop as any)?.stopConfirmed ||
			(obj.publishStop as any)?.pastEffect !== "not_applied" ||
			obj.publishReceipt)
	)
		invalid("unproven cancellation");
	if ((obj.publishStop as any)?.pastEffect === "applied" && !obj.publishReceipt) invalid("stop without applied proof");
	if ((obj.publishObservation as any)?.retryable && (obj.publishReceipt || (obj.publishStop as any)?.closed))
		invalid("retry of closed publication");
	if (obj.publishReceipt && (obj.publishStop as any)?.pastEffect === "not_applied") invalid("contradictory receipt");
	return structuredClone({
		status: obj.status,
		...(obj.publishReceipt ? { publishReceipt: obj.publishReceipt } : {}),
		...(obj.publishObservation ? { publishObservation: obj.publishObservation } : {}),
		...(obj.publishStop ? { publishStop: obj.publishStop } : {}),
		...(obj.cleanupPending !== undefined ? { cleanupPending: obj.cleanupPending } : {}),
	}) as DevicePublicationResult;
}
