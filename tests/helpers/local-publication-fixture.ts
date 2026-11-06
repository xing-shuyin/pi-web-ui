import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { DeviceIntegration, DeviceIntegrationVerificationFacts } from "../../server/protocol.js";
import { computeCanonicalRepositoryId } from "../../server/workspace-handle.js";
import { publicationFixture } from "./publish-intent-fixture.js";
import { sealPublishIntent } from "../../server/device-center/publish-intent.js";
import { computeVerificationDigest } from "../../server/device-center/integration-verification.js";
const exec = promisify(execFile);
export async function nativeGit(cwd: string, ...args: string[]) {
	return (
		await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
			cwd,
			timeout: 15_000,
			windowsHide: true,
			env: {
				...process.env,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
			},
		})
	).stdout.trim();
}
export function intentForIntegration(integration: DeviceIntegration, facts: DeviceIntegrationVerificationFacts) {
	const { digest: _digest, candidateSha: _candidateSha, ...template } = publicationFixture().intent;
	const verification = { ...facts, digest: computeVerificationDigest(integration, facts), verifiedAt: Date.now() };
	return sealPublishIntent({
		...template,
		id: "intent-" + integration.id,
		accountId: integration.accountId,
		roomId: integration.roomId,
		conversationId: integration.conversationId,
		integrationId: integration.id,
		targetDeviceId: integration.targetDeviceId!,
		targetBotId: integration.targetBotId,
		targetBotRevision: integration.targetBotRevision,
		actor: { accountId: integration.accountId },
		repositoryId: integration.repositoryId!,
		objectFormat: integration.objectFormat!,
		targetRef: "refs/heads/" + integration.targetBranch,
		expectedOld: integration.expectedTargetSha,
		preparedTree: integration.preparedTree!,
		materializedCommit: integration.materializedCommit!,
		createdAt: Date.now(),
		delivery: {
			id: integration.deliveryId,
			...(integration.commit ? { commit: integration.commit } : {}),
			...(integration.artifactRef ? { artifactRef: integration.artifactRef } : {}),
		},
		review: {
			id: "review-" + integration.id,
			accountId: integration.accountId,
			roomId: integration.roomId,
			conversationId: integration.conversationId,
			deliveryId: integration.deliveryId,
			...(integration.commit ? { commit: integration.commit } : {}),
			...(integration.artifactRef
				? {
						artifactRef: integration.artifactRef,
						artifactDigest: integration.artifactRef.artifactDigest,
						integrationId: integration.id,
						verificationDigest: verification.digest,
						criteriaResults: [],
					}
				: {}),
			verdict: "accepted",
			summary: "Reviewed",
			reviewer: { type: "human", id: integration.accountId },
			createdAt: Date.now(),
		},
		verificationPlan: integration.verificationPlan!,
		verification,
	});
}
export async function localPublicationFixture() {
	const dir = await mkdtemp(join(tmpdir(), "local-publication-"));
	const cwd = join(dir, "repo");
	await mkdir(cwd);
	await nativeGit(cwd, "init");
	await nativeGit(cwd, "config", "user.name", "Fixture");
	await nativeGit(cwd, "config", "user.email", "fixture@example.invalid");
	await writeFile(join(cwd, "file.txt"), "base\n");
	await nativeGit(cwd, "add", ".");
	await nativeGit(cwd, "commit", "-m", "base");
	const expectedOld = await nativeGit(cwd, "rev-parse", "HEAD");
	await nativeGit(cwd, "branch", "target");
	await writeFile(join(cwd, "file.txt"), "candidate\n");
	await nativeGit(cwd, "add", ".");
	await nativeGit(cwd, "commit", "-m", "output");
	const materializedCommit = await nativeGit(cwd, "rev-parse", "HEAD"),
		preparedTree = await nativeGit(cwd, "rev-parse", "HEAD^{tree}");
	const repoRoot = await realpath(cwd),
		commonDir = await realpath(join(cwd, ".git")),
		dataDir = join(dir, "data");
	await mkdir(dataDir);
	const repositoryId = await computeCanonicalRepositoryId(repoRoot);
	const integration: DeviceIntegration = {
		...publicationFixture().integration,
		id: randomUUID(),
		targetBranch: "target",
		expectedTargetSha: expectedOld,
		materializedCommit,
		commit: materializedCommit,
		preparedTree,
		repositoryId,
	};
	const facts: DeviceIntegrationVerificationFacts = {
		planDigest: integration.verificationPlan!.digest,
		materializedCommit,
		treeBefore: preparedTree,
		treeAfter: preparedTree,
		results: [
			{ command: "node --version", status: "passed", exitCode: 0, outputDigest: "e".repeat(64), outputPreview: "v25" },
		],
	};
	const intent = intentForIntegration(integration, facts);
	const repository = { repoRoot, commonDir, repositoryId, objectFormat: "sha1" as const };
	return {
		dir,
		dataDir,
		repoRoot,
		repository,
		intent,
		integration,
		facts,
		params: {
			dataDir,
			publishIntent: intent,
			repository,
			mode: "first" as const,
			verify: async (_signal: AbortSignal) => {},
		},
	};
}
