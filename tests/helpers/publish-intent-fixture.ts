import type { DeviceGitObjectFormat, DeviceIntegration, DevicePublishIntent } from "../../server/protocol.js";
import {
	computeVerificationDigest,
	computeVerificationPlanDigest,
} from "../../server/device-center/integration-verification.js";
import { sealPublishIntent } from "../../server/device-center/publish-intent.js";

/** Complete real protocol evidence, with synthetic Git IDs for tests that do not execute Git. */
export function publicationFixture(
	format: DeviceGitObjectFormat = "sha1",
	id = "integration",
): { integration: DeviceIntegration; intent: DevicePublishIntent } {
	const length = format === "sha1" ? 40 : 64;
	const integration: DeviceIntegration = {
		id,
		accountId: "account",
		roomId: "room",
		conversationId: "conversation",
		deliveryId: "delivery",
		commit: "b".repeat(length),
		targetBotId: "bot",
		targetBotRevision: 1,
		targetDeviceId: "device",
		repositoryId: "repo:test",
		objectFormat: format,
		targetBranch: "main",
		expectedTargetSha: "a".repeat(length),
		preparedTree: "c".repeat(length),
		materializedCommit: "b".repeat(length),
		status: "verified",
		validationCommands: [],
		createdAt: 1700000000000,
		updatedAt: 1700000000000,
		verificationPlan: {
			commands: ["node --version"],
			digest: computeVerificationPlanDigest(["node --version"]),
			authorizedByAccountId: "account",
			authorizedAt: 1700000000000,
		},
	};
	const facts = {
		planDigest: integration.verificationPlan!.digest,
		materializedCommit: integration.materializedCommit!,
		treeBefore: integration.preparedTree!,
		treeAfter: integration.preparedTree!,
		results: [
			{
				command: "node --version",
				status: "passed" as const,
				exitCode: 0,
				outputDigest: "d".repeat(64),
				outputPreview: "v25.9.0",
			},
		],
	};
	integration.verification = {
		...facts,
		digest: computeVerificationDigest(integration, facts),
		verifiedAt: 1700000000001,
	};
	const intent = sealPublishIntent({
		version: 1,
		id: `intent-${id}`,
		accountId: integration.accountId,
		roomId: integration.roomId,
		conversationId: integration.conversationId,
		integrationId: id,
		targetDeviceId: "device",
		targetBotId: "bot",
		targetBotRevision: 1,
		actor: { accountId: "account" },
		repositoryId: integration.repositoryId!,
		objectFormat: format,
		targetRef: "refs/heads/main",
		expectedOld: integration.expectedTargetSha,
		preparedTree: integration.preparedTree!,
		materializedCommit: integration.materializedCommit!,
		createdAt: 1700000000123,
		delivery: { id: "delivery", commit: integration.commit },
		review: {
			id: "review",
			accountId: "account",
			roomId: "room",
			conversationId: "conversation",
			deliveryId: "delivery",
			commit: integration.commit,
			verdict: "accepted",
			summary: "Reviewed",
			reviewer: { type: "human", id: "account" },
			createdAt: 1700000000002,
		},
		verificationPlan: integration.verificationPlan!,
		verification: integration.verification,
	});
	return { integration, intent };
}
