import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceArtifact, DeviceDeliveryArtifactRef } from "../../server/protocol.js";
import {
	deviceCancelIntegration,
	deviceConfirmIntegration,
	devicePrepareIntegration,
	deviceVerifyIntegration,
	loadPersistentSessions,
	savePersistentSessions,
} from "../../server/device-center/device-integration.js";
import { canonicalizeJson, computeArtifactDigest } from "../../server/device-center/work-contract.js";
import { computeCanonicalRepositoryId } from "../../server/workspace-handle.js";
import * as verifier from "../../server/device-center/local-verification.js";

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function git(cwd: string, ...args: string[]) {
	return (
		await exec("git", ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "-c", "commit.gpgsign=false", ...args], {
			cwd,
			windowsHide: true,
		})
	).stdout.trim();
}
function plan(commands = ["node -e \"process.stdout.write('verified')\""]) {
	return {
		commands,
		digest: createHash("sha256").update(canonicalizeJson({ commands })).digest("hex"),
		authorizedByAccountId: "owner",
		authorizedAt: Date.now(),
	};
}
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "device-local-integration-"));
	dirs.push(dir);
	const repoRoot = join(dir, "repo");
	const dataDir = join(dir, "data");
	await mkdir(repoRoot);
	await mkdir(dataDir);
	await git(repoRoot, "init");
	await git(repoRoot, "config", "user.name", "Test");
	await git(repoRoot, "config", "user.email", "test@local");
	await writeFile(join(repoRoot, ".gitattributes"), "*.txt text\n");
	await writeFile(join(repoRoot, ".gitignore"), "ignored-output.bin\n");
	await writeFile(join(repoRoot, "code.txt"), "baseline\n");
	await git(repoRoot, "add", ".");
	await git(repoRoot, "commit", "-m", "baseline");
	const baselineCommit = await git(repoRoot, "rev-parse", "HEAD");
	await git(repoRoot, "branch", "target");
	const repositoryId = await computeCanonicalRepositoryId(repoRoot);
	await writeFile(join(repoRoot, "code.txt"), "baseline\nprevious artifact\n");
	await git(repoRoot, "add", ".");
	await git(repoRoot, "commit", "-m", "input");
	const inputTree = await git(repoRoot, "rev-parse", "HEAD^{tree}");
	await writeFile(join(repoRoot, "code.txt"), "baseline\nprevious artifact\ncurrent artifact\n");
	await writeFile(join(repoRoot, "ignored-output.bin"), Buffer.from([0, 255, 10, 128]));
	await git(repoRoot, "add", "-f", "ignored-output.bin");
	await git(repoRoot, "add", ".");
	await git(repoRoot, "commit", "-m", "output");
	const outputCommit = await git(repoRoot, "rev-parse", "HEAD");
	const outputTree = await git(repoRoot, "rev-parse", "HEAD^{tree}");
	const patch = (
		await exec("git", ["-c", "core.autocrlf=false", "diff", "--binary", baselineCommit, "HEAD"], {
			cwd: repoRoot,
			encoding: "buffer",
		})
	).stdout;
	await git(repoRoot, "checkout", "--detach", baselineCommit);
	const artifact: DeviceArtifact = {
		id: randomUUID(),
		digest: "",
		producer: {
			deviceId: "device",
			botId: "producer",
			taskId: "task",
			attemptId: "attempt",
			contractDigest: "c".repeat(64),
			manifestDigest: "d".repeat(64),
		},
		baseline: { repositoryId, commit: baselineCommit },
		inputTree,
		outputTree,
		patchBase64: patch.toString("base64"),
		patchSha256: createHash("sha256").update(patch).digest("hex"),
		createdAt: Date.now(),
	};
	artifact.digest = computeArtifactDigest(artifact);
	const artifactRef: DeviceDeliveryArtifactRef = {
		artifactTaskId: "task",
		attemptId: "attempt",
		artifactId: artifact.id,
		artifactDigest: artifact.digest,
		contractId: "contract",
		contractRevision: 1,
		contractDigest: artifact.producer.contractDigest!,
		manifestDigest: artifact.producer.manifestDigest!,
		baselineCommit,
		repositoryId,
		inputTree,
		outputTree,
	};
	const identity = { integrationId: randomUUID(), targetBotId: "target-bot", targetBotRevision: 1, repoRoot, dataDir };
	const prepare = () => devicePrepareIntegration({ ...identity, targetBranch: "target", artifactRef, artifact });
	const verification = (prepared: Awaited<ReturnType<typeof prepare>>, commands?: string[]) => ({
		...identity,
		artifactRef,
		materializedCommit: prepared.materializedCommit!,
		preparedTree: prepared.preparedTree!,
		expectedTargetSha: prepared.expectedTargetSha,
		verificationPlan: plan(commands),
	});
	const confirm = (prepared: Awaited<ReturnType<typeof prepare>>) => ({
		...identity,
		deliveryId: "delivery",
		materializedCommit: prepared.materializedCommit,
		expectedTargetSha: prepared.expectedTargetSha,
	});
	return {
		identity,
		repoRoot,
		dataDir,
		artifact,
		artifactRef,
		baselineCommit,
		outputCommit,
		outputTree,
		prepare,
		verification,
		confirm,
	};
}

// These integration cases execute many real Git processes plus the native Windows supervisor.
// Product cancellation/aggregate limits remain separately injected and asserted below.
describe("device local artifact integration", { timeout: 30_000 }, () => {
	let f: Awaited<ReturnType<typeof fixture>>;
	let prepared: Awaited<ReturnType<typeof devicePrepareIntegration>>;
	beforeEach(async () => {
		f = await fixture();
		prepared = await f.prepare();
	});
	it("rebuilds cumulative baseline patch into a retained real commit", async () => {
		expect(prepared.status).toBe("prepared");
		expect(prepared.preparedTree).toBe(f.outputTree);
		expect(prepared.materializedCommit).not.toBe(f.outputTree);
		expect(await git(f.repoRoot, "cat-file", "-t", prepared.materializedCommit!)).toBe("commit");
		expect(await git(f.repoRoot, "rev-parse", `${prepared.materializedCommit}^`)).toBe(f.baselineCommit);
		const session = (await loadPersistentSessions(f.dataDir)).get(f.identity.integrationId)!;
		expect(await git(f.repoRoot, "rev-parse", session.retainedRef!)).toBe(prepared.materializedCommit);
		expect(await readFile(join(session.worktreePath, "code.txt"), "utf8")).toContain(
			"previous artifact\ncurrent artifact",
		);
		await expect(deviceConfirmIntegration(f.confirm(prepared))).rejects.toThrow("Owner-authorized");
	});
	it("runs the full artifact materialization, real verification and CAS apply path", async () => {
		const fresh = { ...f.identity, integrationId: randomUUID() };
		const result = await devicePrepareIntegration({
			...fresh,
			targetBranch: "target",
			artifact: f.artifact,
			artifactRef: f.artifactRef,
		});
		const verified = await deviceVerifyIntegration({ ...f.verification(result), integrationId: fresh.integrationId });
		expect(verified.status).toBe("verified");
		const applied = await deviceConfirmIntegration({ ...f.confirm(result), integrationId: fresh.integrationId });
		expect(await git(f.repoRoot, "rev-parse", "target")).toBe(applied.newCommitSha);
		expect(await git(f.repoRoot, "rev-parse", `${applied.newCommitSha}^{tree}`)).toBe(f.outputTree);
		expect(await git(f.repoRoot, "rev-parse", `${applied.newCommitSha}^2`)).toBe(result.materializedCommit);
	}, 30_000);
	it("verifies real commands with complete facts and immutable success", async () => {
		const verified = await deviceVerifyIntegration(f.verification(prepared));
		expect(verified).toMatchObject({
			status: "verified",
			artifactDigest: f.artifact.digest,
			materializedCommit: prepared.materializedCommit,
			treeBefore: f.outputTree,
			treeAfter: f.outputTree,
			results: [
				{
					command: plan().commands[0],
					status: "passed",
					exitCode: 0,
					outputDigest: createHash("sha256").update("verified").digest("hex"),
					outputPreview: "verified",
				},
			],
		});
		await expect(deviceVerifyIntegration(f.verification(prepared))).rejects.toThrow("immutable");
	});
	it("rejects canonical repository, output tree and baseline target mismatches", async () => {
		const badRepo = { ...f.artifact, baseline: { ...f.artifact.baseline!, repositoryId: "local" } };
		badRepo.digest = computeArtifactDigest(badRepo);
		await expect(
			devicePrepareIntegration({
				...f.identity,
				integrationId: randomUUID(),
				targetBranch: "target",
				artifact: badRepo,
				artifactRef: { ...f.artifactRef, repositoryId: "local", artifactDigest: badRepo.digest },
			}),
		).rejects.toThrow("Canonical repository");
		const badTree = { ...f.artifact, outputTree: f.artifact.inputTree };
		badTree.digest = computeArtifactDigest(badTree);
		await expect(
			devicePrepareIntegration({
				...f.identity,
				integrationId: randomUUID(),
				targetBranch: "target",
				artifact: badTree,
				artifactRef: { ...f.artifactRef, outputTree: badTree.outputTree!, artifactDigest: badTree.digest },
			}),
		).rejects.toThrow("does not produce");
		await git(f.repoRoot, "update-ref", "refs/heads/target", f.outputCommit);
		await expect(
			devicePrepareIntegration({
				...f.identity,
				integrationId: randomUUID(),
				targetBranch: "target",
				artifact: f.artifact,
				artifactRef: f.artifactRef,
			}),
		).rejects.toThrow("HEAD must equal baseline");
	});
	it("rejects a Bot directory below the repository root for artifact and legacy paths", async () => {
		const repoRoot = join(f.repoRoot, "subdir");
		await mkdir(repoRoot);
		await expect(
			devicePrepareIntegration({
				...f.identity,
				integrationId: randomUUID(),
				repoRoot,
				targetBranch: "target",
				artifact: f.artifact,
				artifactRef: f.artifactRef,
			}),
		).rejects.toThrow("canonical repository root");
		await expect(
			devicePrepareIntegration({
				...f.identity,
				integrationId: randomUUID(),
				repoRoot,
				targetBranch: "target",
				commit: f.outputCommit,
			}),
		).rejects.toThrow("canonical repository root");
	});
	it("rejects hidden index flags and hashes raw bytes that Git text attributes normalize away", async () => {
		const session = (await loadPersistentSessions(f.dataDir)).get(f.identity.integrationId)!;
		await git(session.worktreePath, "update-index", "--assume-unchanged", "code.txt");
		await writeFile(join(session.worktreePath, "code.txt"), "hidden change\n");
		expect(await git(session.worktreePath, "diff", "--name-only")).toBe("");
		await expect(deviceVerifyIntegration(f.verification(prepared))).rejects.toThrow("hidden assume-unchanged");
		await git(session.worktreePath, "update-index", "--no-assume-unchanged", "code.txt");
		await git(session.worktreePath, "restore", "--worktree", "code.txt");
		await git(session.worktreePath, "update-index", "--skip-worktree", "code.txt");
		await expect(deviceVerifyIntegration(f.verification(prepared))).rejects.toThrow("skip-worktree");
		await git(session.worktreePath, "update-index", "--no-skip-worktree", "code.txt");
		const bytes = await readFile(join(session.worktreePath, "code.txt"), "utf8");
		await writeFile(join(session.worktreePath, "code.txt"), bytes.replace(/\n/g, "\r\n"));
		expect(await git(session.worktreePath, "diff", "--name-only")).toBe("");
		expect(await git(session.worktreePath, "write-tree")).toBe(prepared.preparedTree);
		await expect(deviceVerifyIntegration(f.verification(prepared))).rejects.toThrow("raw working tree byte mismatch");
	});
	it("rejects forged plans and dirty trees before executing commands", async () => {
		const params = f.verification(prepared);
		await expect(
			deviceVerifyIntegration({
				...params,
				verificationPlan: { ...params.verificationPlan, commands: ['node -e "process.exit(0)"'] },
			}),
		).rejects.toThrow("Owner-authorized");
		const session = (await loadPersistentSessions(f.dataDir)).get(f.identity.integrationId)!;
		await writeFile(join(session.worktreePath, "code.txt"), "dirty\n");
		await expect(deviceVerifyIntegration(params)).rejects.toThrow("dirty or changed");
	});
	it("rejects command tree mutations and preserves dirty workspaces during cancellation", async () => {
		const session = (await loadPersistentSessions(f.dataDir)).get(f.identity.integrationId)!;
		await expect(
			deviceVerifyIntegration(
				f.verification(prepared, ["node -e \"require('fs').writeFileSync('code.txt','changed')\""]),
			),
		).rejects.toThrow("dirty or changed");
		await expect(deviceCancelIntegration(f.identity)).rejects.toThrow("dirty or changed");
		expect(existsSync(session.worktreePath)).toBe(true);
		expect((await loadPersistentSessions(f.dataDir)).get(f.identity.integrationId)?.localVerification).toBeUndefined();
	});
	it("serializes operations and signals cancellation immediately before waiting for stop", async () => {
		const session = (await loadPersistentSessions(f.dataDir)).get(f.identity.integrationId)!;
		const verification = deviceVerifyIntegration(
			f.verification(prepared, [
				"node -e \"require('fs').writeFileSync('started','1');setTimeout(()=>{require('fs').unlinkSync('started')},10000)\"",
			]),
		);
		const rejected = expect(verification).rejects.toThrow("cancelled");
		await vi.waitFor(() => expect(existsSync(join(session.worktreePath, "started"))).toBe(true), { timeout: 10_000 });
		await expect(deviceVerifyIntegration(f.verification(prepared))).rejects.toThrow("already active");
		await expect(deviceConfirmIntegration(f.confirm(prepared))).rejects.toThrow("already active");
		await expect(deviceCancelIntegration({ ...f.identity, targetBotId: "other" })).rejects.toThrow("identity mismatch");
		await expect(deviceCancelIntegration(f.identity)).rejects.toThrow("dirty or changed");
		await rejected;
		expect(existsSync(session.worktreePath)).toBe(true);
	});
	it("retains its operation and worktree durably when process stop cannot be confirmed", async () => {
		const failure = new verifier.VerificationStopUnconfirmedError();
		vi.spyOn(verifier, "runVerificationCommand").mockRejectedValueOnce(failure);
		await expect(deviceVerifyIntegration(f.verification(prepared))).rejects.toBe(failure);
		const session = (await loadPersistentSessions(f.dataDir)).get(f.identity.integrationId)!;
		expect(session.stopUnconfirmed).toBe(true);
		expect(session.localVerification).toBeUndefined();
		expect(existsSync(session.worktreePath)).toBe(true);
		await expect(deviceCancelIntegration(f.identity)).rejects.toBe(failure);
		await expect(deviceVerifyIntegration(f.verification(prepared))).rejects.toThrow("already active");
		expect(existsSync(session.worktreePath)).toBe(true);
	});
	it("preserves workspaces on restart when verification was in flight at process death", async () => {
		const sessions = await loadPersistentSessions(f.dataDir);
		const session = sessions.get(f.identity.integrationId)!;
		session.verificationInFlight = true;
		await savePersistentSessions(f.dataDir, sessions);
		vi.resetModules();
		const restarted = await import("../../server/device-center/device-integration.js");
		await expect(restarted.deviceVerifyIntegration(f.verification(prepared))).rejects.toThrow("stop unconfirmed");
		await expect(restarted.deviceConfirmIntegration(f.confirm(prepared))).rejects.toThrow();
		await expect(restarted.deviceCancelIntegration(f.identity)).rejects.toThrow("stop unconfirmed");
		expect(await restarted.recoverOrphanWorktrees(f.dataDir)).toEqual({ recoveredCount: 0, pendingCount: 1 });
		expect(existsSync(session.worktreePath)).toBe(true);
	});
	it("bounds aggregate execution time using a short injected deadline", async () => {
		await expect(
			deviceVerifyIntegration(
				f.verification(prepared, ['node -e "setTimeout(()=>{},10000)"', 'node -e "process.exit(0)"']),
				{ commandTimeoutMs: 500, totalTimeoutMs: 150 },
			),
		).rejects.toThrow("aggregate deadline");
		const session = (await loadPersistentSessions(f.dataDir)).get(f.identity.integrationId)!;
		expect(session.localVerification).toBeUndefined();
		expect(session.verificationStopConfirmed).toBe(true);
		expect(session.verificationInFlight).toBeUndefined();
		await expect(
			deviceCancelIntegration({ ...f.identity, priorStatus: "failed", verificationMayBeRunning: true }),
		).resolves.toEqual({ status: "cancelled" });
	});
	describe("after real verification", () => {
		beforeEach(async () => {
			await deviceVerifyIntegration(f.verification(prepared));
		});
		it("applies through CAS with the materialized commit as second parent", async () => {
			const applied = await deviceConfirmIntegration(f.confirm(prepared));
			expect(await git(f.repoRoot, "rev-parse", "target")).toBe(applied.newCommitSha);
			expect(await git(f.repoRoot, "rev-parse", `${applied.newCommitSha}^2`)).toBe(prepared.materializedCommit);
			expect(await git(f.repoRoot, "rev-parse", `${applied.newCommitSha}^{tree}`)).toBe(f.outputTree);
		});
		it("rechecks the worktree and target even with a prior successful receipt", async () => {
			await git(f.repoRoot, "update-ref", "refs/heads/target", f.outputCommit);
			await expect(deviceConfirmIntegration(f.confirm(prepared))).rejects.toThrow();
			await git(f.repoRoot, "update-ref", "refs/heads/target", f.baselineCommit);
			const session = (await loadPersistentSessions(f.dataDir)).get(f.identity.integrationId)!;
			await writeFile(join(session.worktreePath, "untracked"), "changed");
			await expect(deviceConfirmIntegration(f.confirm(prepared))).rejects.toThrow("dirty or changed");
		});
	});
});

describe("legacy local verification lifecycle", { timeout: 30_000 }, () => {
	let f: Awaited<ReturnType<typeof fixture>>;
	let prepared: Awaited<ReturnType<typeof devicePrepareIntegration>>;
	beforeEach(async () => {
		f = await fixture();
		prepared = await devicePrepareIntegration({ ...f.identity, targetBranch: "target", commit: f.outputCommit });
	});
	it("verifies a commit delivery that force-tracks a newly ignored binary file", async () => {
		const params = { ...f.verification(prepared), artifactRef: undefined };
		const verified = await deviceVerifyIntegration(params);
		expect(verified.status).toBe("verified");
		expect(verified.treeBefore).toBe(f.outputTree);
		expect(verified.treeAfter).toBe(f.outputTree);
		const session = (await loadPersistentSessions(f.dataDir)).get(f.identity.integrationId)!;
		expect(await readFile(join(session.worktreePath, "ignored-output.bin"))).toEqual(Buffer.from([0, 255, 10, 128]));
	}, 30_000);
	it("requires a real successful receipt instead of status flags", async () => {
		const confirmation = {
			...f.identity,
			deliveryId: "legacy",
			commit: f.outputCommit,
			expectedTargetSha: f.baselineCommit,
		};
		await expect(deviceConfirmIntegration(confirmation)).rejects.toThrow("Owner-authorized");
		const params = { ...f.verification(prepared), artifactRef: undefined };
		await expect(
			deviceVerifyIntegration({ ...params, verificationPlan: plan(['node -e "process.exit(3)"']) }),
		).resolves.toMatchObject({ status: "failed" });
		await expect(deviceConfirmIntegration(confirmation)).rejects.toThrow("Owner-authorized");
	});
	it.each(["failed", "verified", "verifying"])(
		"preserves an old %s job whose absent marker is no proof of stop",
		async (priorStatus) => {
			const sessions = await loadPersistentSessions(f.dataDir);
			const session = sessions.get(f.identity.integrationId)!;
			delete session.gitDir;
			delete session.commonDir;
			delete session.verificationStopConfirmed;
			await savePersistentSessions(f.dataDir, sessions);
			vi.resetModules();
			const restarted = await import("../../server/device-center/device-integration.js");
			expect(await restarted.recoverOrphanWorktrees(f.dataDir)).toEqual({ recoveredCount: 0, pendingCount: 1 });
			await expect(
				restarted.deviceCancelIntegration({
					...f.identity,
					priorStatus,
					verificationMayBeRunning: priorStatus === "verifying",
				}),
			).rejects.toThrow("stop unconfirmed");
			expect(existsSync(session.worktreePath)).toBe(true);
			expect((await loadPersistentSessions(f.dataDir)).get(f.identity.integrationId)?.stopUnconfirmed).toBe(true);
		},
	);
	it("safely cancels a stopped old prepared session after checking its real tree", async () => {
		const sessions = await loadPersistentSessions(f.dataDir);
		const session = sessions.get(f.identity.integrationId)!;
		delete session.gitDir;
		delete session.commonDir;
		delete session.verificationStopConfirmed;
		await savePersistentSessions(f.dataDir, sessions);
		vi.resetModules();
		const restarted = await import("../../server/device-center/device-integration.js");
		await expect(restarted.deviceCancelIntegration({ ...f.identity, priorStatus: "prepared" })).resolves.toEqual({
			status: "cancelled",
		});
		expect(existsSync(session.worktreePath)).toBe(false);
	});
	it("clears a missing old prepared worktree receipt before admitting new work on its root", async () => {
		vi.resetModules();
		const { createLocalBotRegistry } = await import("../../server/device-center/bots.js");
		const { createDeviceRuntime } = await import("../../server/device-center/runtime.js");
		const bots = await createLocalBotRegistry(join(f.dataDir, "bots-config"));
		const bot = await bots.upsert({
			name: "target",
			description: "",
			systemPrompt: "",
			cwd: f.repoRoot,
			tools: ["read"],
			skills: [],
			mcpServers: [],
			enabled: true,
		});
		const sessions = await loadPersistentSessions(f.dataDir);
		const session = sessions.get(f.identity.integrationId)!;
		session.targetBotId = bot.id;
		session.targetBotRevision = bot.revision;
		delete session.verificationStopConfirmed;
		delete session.gitDir;
		delete session.commonDir;
		await savePersistentSessions(f.dataDir, sessions);
		await rm(session.worktreePath, { recursive: true, force: true });
		const run = vi.fn(async () => "admitted");
		const runtime = createDeviceRuntime({
			config: { hubUrl: "http://127.0.0.1:8999", deviceId: "device", credential: "secret", allowExecution: true },
			localOrigin: "http://127.0.0.1:8989",
			dataDir: f.dataDir,
			bots,
			executorFactory: () => ({ run, close() {} }),
		});
		try {
			const task = {
				id: "blocked",
				attemptId: "attempt",
				roomId: "room",
				botId: bot.id,
				botRevision: bot.revision,
				deviceId: "device",
				text: "test",
				leaseToken: "lease",
				leaseGeneration: 1,
			};
			await expect(runtime.onTask(task)).rejects.toThrow();
			expect(run).not.toHaveBeenCalled();
			await expect(
				runtime.onCommand(
					"integration_cancel",
					{
						integrationId: f.identity.integrationId,
						targetBotId: bot.id,
						targetBotRevision: bot.revision,
						priorStatus: "prepared",
						ownerCleanup: true,
					},
					new AbortController().signal,
				),
			).resolves.toEqual({ status: "cancelled" });
			expect((await loadPersistentSessions(f.dataDir)).has(f.identity.integrationId)).toBe(false);
			await expect(runtime.onTask({ ...task, id: "admitted", attemptId: "next" })).resolves.toBe("admitted");
		} finally {
			await runtime.close();
		}
	});
	it("does not let an old finally delete a successor operation", async () => {
		await deviceCancelIntegration(f.identity);
		const successor = await devicePrepareIntegration({ ...f.identity, targetBranch: "target", commit: f.outputCommit });
		expect(successor.status).toBe("prepared");
	});
});
