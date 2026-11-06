import { createHash } from "node:crypto";
import type {
	DeviceIntegration,
	DeviceIntegrationVerificationFacts,
	DeviceIntegrationVerificationPlan,
} from "../protocol.js";
import { canonicalizeJson } from "./work-contract.js";

function fail(message: string): never {
	throw Object.assign(new Error(message), { status: 502 });
}
const digest = (value: unknown) => createHash("sha256").update(canonicalizeJson(value)).digest("hex");
export const computeVerificationPlanDigest = (commands: string[]): string => digest({ commands });
export function freezeVerificationPlan(commands: unknown, accountId: string): DeviceIntegrationVerificationPlan {
	if (
		!Array.isArray(commands) ||
		commands.length < 1 ||
		commands.length > 8 ||
		commands.some(
			(c) => typeof c !== "string" || !c.trim() || c.length > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(c),
		)
	)
		throw Object.assign(new Error("Expected 1..8 bounded verification commands"), { status: 400 });
	return {
		commands: [...commands],
		digest: computeVerificationPlanDigest(commands),
		authorizedByAccountId: accountId,
		authorizedAt: Date.now(),
	};
}
function hex(value: unknown, length: number, name: string): string {
	if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`).test(value)) fail(`Invalid ${name}`);
	return value;
}
export function validateVerificationFacts(
	raw: unknown,
	integration: DeviceIntegration,
): { status: "verified" | "failed"; facts: DeviceIntegrationVerificationFacts } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Invalid verification facts");
	const obj = raw as Record<string, unknown>;
	const plan = integration.verificationPlan;
	if (
		!plan ||
		plan.authorizedByAccountId !== integration.accountId ||
		plan.digest !== computeVerificationPlanDigest(plan.commands)
	)
		fail("Missing authorized verification plan");
	if (obj.status !== "verified" && obj.status !== "failed") fail("Invalid verification status");
	if (
		obj.planDigest !== plan.digest ||
		obj.artifactDigest !== integration.artifactRef?.artifactDigest ||
		obj.materializedCommit !== integration.materializedCommit
	)
		fail("Verification subject mismatch");
	const objectLength = integration.objectFormat === "sha256" && !integration.artifactRef ? 64 : 40;
	const treeBefore = hex(obj.treeBefore, objectLength, "treeBefore");
	const treeAfter = hex(obj.treeAfter, objectLength, "treeAfter");
	if (treeBefore !== integration.preparedTree || treeAfter !== integration.preparedTree)
		fail("Verification changed prepared tree");
	if (!Array.isArray(obj.results) || obj.results.length !== plan.commands.length || obj.results.length === 0)
		fail("Missing complete command evidence");
	const results = obj.results.map((rawItem, index) => {
		if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) fail("Invalid command evidence");
		const item = rawItem as Record<string, unknown>;
		if (
			item.command !== plan.commands[index] ||
			!Number.isSafeInteger(item.exitCode) ||
			Math.abs(item.exitCode as number) > 2147483647 ||
			(item.status !== "passed" && item.status !== "failed") ||
			(item.status === "passed") !== (item.exitCode === 0)
		)
			fail("Command evidence disagrees with plan or exit code");
		if (typeof item.outputPreview !== "string" || item.outputPreview.length > 16384) fail("Invalid output preview");
		return {
			command: item.command as string,
			status: item.status as "passed" | "failed",
			exitCode: item.exitCode as number,
			outputDigest: hex(item.outputDigest, 64, "outputDigest"),
			outputPreview: item.outputPreview,
		};
	});
	if ((obj.status === "verified") !== results.every((r) => r.status === "passed"))
		fail("Verification status disagrees with command evidence");
	return {
		status: obj.status,
		facts: {
			planDigest: plan.digest,
			...(integration.artifactRef ? { artifactDigest: integration.artifactRef.artifactDigest } : {}),
			materializedCommit: integration.materializedCommit!,
			treeBefore,
			treeAfter,
			results,
		},
	};
}
export function computeVerificationDigest(
	integration: DeviceIntegration,
	facts: DeviceIntegrationVerificationFacts,
): string {
	return digest({
		integrationId: integration.id,
		accountId: integration.accountId,
		roomId: integration.roomId,
		conversationId: integration.conversationId,
		deliveryId: integration.deliveryId,
		commit: integration.commit ?? null,
		artifactRef: integration.artifactRef ?? null,
		targetBotId: integration.targetBotId,
		targetBotRevision: integration.targetBotRevision,
		targetDeviceId: integration.targetDeviceId ?? null,
		targetBranch: integration.targetBranch,
		expectedTargetSha: integration.expectedTargetSha,
		preparedTree: integration.preparedTree,
		verificationPlan: integration.verificationPlan,
		facts,
	});
}
export function hasVerifiedIntegration(integration: DeviceIntegration): boolean {
	try {
		if (!integration.verification) return false;
		const { facts, status } = validateVerificationFacts(
			{ status: "verified", ...integration.verification },
			integration,
		);
		return status === "verified" && integration.verification.digest === computeVerificationDigest(integration, facts);
	} catch {
		return false;
	}
}
