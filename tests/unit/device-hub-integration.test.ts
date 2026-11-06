import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { DeviceHubStore } from "../../server/device-center/store.js";
import {
	hubPrepareIntegration,
	hubVerifyIntegration,
	hubConfirmIntegration,
	hubCancelIntegration,
	hubReconcileIntegration,
	hubResumeIntegration,
	listIntegrations,
} from "../../server/device-center/hub-integration.js";
import {
	devicePrepareIntegration,
	deviceVerifyIntegration,
	deviceConfirmIntegration,
	deviceCancelIntegration,
	deviceCancelPublication,
	devicePublicationStatus,
} from "../../server/device-center/device-integration.js";
import type { DeviceDelivery, DeviceReview } from "../../server/protocol.js";
import { freezeVerificationPlan } from "../../server/device-center/integration-verification.js";

const exec = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await exec("git", args, { cwd, windowsHide: true });
	return stdout.trim();
}

describe("device-hub-integration", { timeout: 30000 }, () => {
	let testDir: string;
	let dataDir: string;
	let repoDir: string;
	let store: DeviceHubStore;

	const accountId = "acc-test-1";
	const roomId = "room-test-1";
	const botId = "bot-test-1";
	const deviceId = "dev-test-1";
	const conversationId = "conv-test-1";

	let baseCommit: string;
	let devCommit: string;
	let deliveryId: string;
	let reviewId: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "pi-hub-int-test-"));
		dataDir = join(testDir, "hub-data");
		repoDir = join(testDir, "target-repo");
		await mkdir(dataDir, { recursive: true });
		await mkdir(repoDir, { recursive: true });

		await runGit(repoDir, ["init"]);
		await runGit(repoDir, ["branch", "-M", "main"]);
		await runGit(repoDir, ["config", "user.name", "Test Runner"]);
		await runGit(repoDir, ["config", "user.email", "test@runner.local"]);
		await runGit(repoDir, ["config", "commit.gpgSign", "false"]);
		await runGit(repoDir, ["config", "core.autocrlf", "false"]);

		await writeFile(join(repoDir, "file.txt"), "Initial content\n", "utf8");
		await runGit(repoDir, ["add", "file.txt"]);
		await runGit(repoDir, ["commit", "-m", "Initial commit"]);
		baseCommit = await runGit(repoDir, ["rev-parse", "HEAD"]);

		await runGit(repoDir, ["checkout", "-b", "feature"]);
		await writeFile(join(repoDir, "file.txt"), "Initial content\nAdded line by bot\n", "utf8");
		await writeFile(join(repoDir, "test.js"), "console.log('CHECK_OK');\n", "utf8");
		await runGit(repoDir, ["add", "file.txt", "test.js"]);
		await runGit(repoDir, ["commit", "-m", "Feature commit by bot"]);
		devCommit = await runGit(repoDir, ["rev-parse", "HEAD"]);

		await runGit(repoDir, ["checkout", "--detach", baseCommit]);

		deliveryId = "del-test-1";
		reviewId = "rev-test-1";

		const deliveryRecord: DeviceDelivery = {
			id: deliveryId,
			conversationId,
			accountId,
			roomId,
			botId,
			taskId: "task-1",
			repository: repoDir,
			baseCommit,
			commit: devCommit,
			branch: "feature",
			summary: "Implemented line addition and test script",
			checks: [
				{
					command: "node test.js",
					status: "passed",
					source: "bot_reported",
				},
			],
			limitations: [],
			createdAt: Date.now(),
		};

		const reviewRecord: DeviceReview = {
			id: reviewId,
			conversationId,
			accountId,
			roomId,
			deliveryId,
			commit: devCommit,
			verdict: "accepted",
			summary: "Review accepted by human",
			reviewer: { type: "human", id: accountId },
			createdAt: Date.now(),
		};

		store = await DeviceHubStore.open(dataDir);
		await store.transact((draft) => {
			draft.conversations.push({
				id: conversationId,
				accountId,
				roomId,
				botId,
				deviceId,
				botRevision: 1,
				name: "Dev Chat",
				rootTaskId: "task-root",
				dispatchDepth: 0,
				latestTaskId: "task-1",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			draft.deliveries.push(deliveryRecord);
			draft.reviews.push(reviewRecord);
			draft.accounts.push({ id: accountId, username: "tester", createdAt: Date.now(), passwordHash: "h" } as any);
			draft.devices.push({
				id: deviceId,
				accountId,
				name: "Local Dev",
				credentialHash: "hash-test",
				createdAt: Date.now(),
			});
			draft.bots.push({
				id: botId,
				deviceId,
				accountId,
				name: "DevBot",
				description: "Development Bot",
				enabled: true,
				revision: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				cwd: repoDir,
			} as any);
			draft.rooms.push({ id: roomId, accountId, name: "General Room", botIds: [botId], createdAt: Date.now() });
		});
	});

	afterEach(async () => {
		await store?.close();
		await rm(testDir, { recursive: true, force: true }).catch(() => {});
	});

	function createTestDriver() {
		return {
			callDeviceCommand: async (devId: string, action: string, payload: any, options?: { signal?: AbortSignal }) => {
				if (devId !== deviceId) throw new Error("Device offline");
				if (action === "integration_prepare") {
					return await devicePrepareIntegration(
						{
							accountId: payload.accountId,
							roomId: payload.roomId,
							conversationId: payload.conversationId,
							targetDeviceId: devId,
							integrationId: payload.integrationId,
							targetBotId: payload.targetBotId,
							targetBotRevision: payload.targetBotRevision ?? 1,
							repoRoot: repoDir,
							dataDir,
							targetBranch: payload.targetBranch,
							commit: payload.commit,
							artifactRef: payload.artifactRef,
							artifact: payload.artifact,
						},
						options,
					);
				}
				if (action === "integration_verify") {
					return await deviceVerifyIntegration(
						{
							integrationId: payload.integrationId,
							targetBotId: payload.targetBotId,
							targetBotRevision: payload.targetBotRevision ?? 1,
							repoRoot: repoDir,
							dataDir,
							verificationPlan: payload.verificationPlan,
							artifactRef: payload.artifactRef,
							materializedCommit: payload.materializedCommit,
							preparedTree: payload.preparedTree,
							expectedTargetSha: payload.expectedTargetSha,
						},
						options,
					);
				}
				if (action === "integration_confirm") {
					return await deviceConfirmIntegration(
						{
							integrationId: payload.integrationId,
							targetBotId: payload.targetBotId,
							targetBotRevision: payload.targetBotRevision ?? 1,
							repoRoot: repoDir,
							dataDir,
							deliveryId: payload.deliveryId,
							publishIntent: payload.publishIntent,
							mode: payload.mode,
							commit: payload.commit,
							materializedCommit: payload.materializedCommit,
							expectedTargetSha: payload.expectedTargetSha,
						},
						options,
					);
				}
				if (action === "integration_publication_status")
					return devicePublicationStatus({ dataDir, publishIntent: payload.publishIntent });
				if (action === "integration_cancel") {
					if (payload.publishIntent) return deviceCancelPublication({ dataDir, publishIntent: payload.publishIntent });
					return await deviceCancelIntegration(
						{
							integrationId: payload.integrationId,
							targetBotId: payload.targetBotId,
							targetBotRevision: payload.targetBotRevision ?? 1,
							repoRoot: repoDir,
							dataDir,
							priorStatus: payload.priorStatus,
							verificationMayBeRunning: payload.verificationMayBeRunning,
						},
						options,
					);
				}
				throw new Error(`Unsupported action: ${action}`);
			},
		};
	}

	it("completes full pipeline: prepare -> verify -> confirm (apply) with atomic update-ref", async () => {
		const driver = createTestDriver();
		const actor = { accountId };

		const prep = await hubPrepareIntegration(
			store,
			roomId,
			conversationId,
			actor,
			{ deliveryId, targetBotId: botId, targetBranch: "main" },
			driver,
		);

		expect(prep.status).toBe("prepared");
		expect(prep.expectedTargetSha).toBe(baseCommit);
		expect(prep.diff).toContain("Added line by bot");
		expect(prep.targetBotRevision).toBe(1);

		const verified = await hubVerifyIntegration(
			store,
			roomId,
			conversationId,
			prep.id,
			actor,
			{ commands: ["node test.js"] },
			driver,
		);

		expect(verified.status).toBe("verified");
		expect(verified.validationCommands).toHaveLength(1);
		expect(verified.validationCommands[0].status).toBe("passed");
		expect(verified.validationCommands[0].output).toContain("CHECK_OK");

		const applied = await hubConfirmIntegration(
			store,
			roomId,
			conversationId,
			prep.id,
			actor,
			{ expectedTargetSha: baseCommit },
			driver,
		);

		expect(applied.status).toBe("applied");
		expect(applied.newCommitSha).toBeDefined();

		const newHead = await runGit(repoDir, ["rev-parse", "refs/heads/main"]);
		expect(newHead).toBe(applied.newCommitSha);

		const content = await runGit(repoDir, ["show", "refs/heads/main:file.txt"]);
		expect(content).toContain("Added line by bot");

		const list = listIntegrations(store.snapshot(), conversationId);
		expect(list).toHaveLength(1);
		expect(list[0].status).toBe("applied");
	});

	it("refuses legacy status-only verified records without actual verification evidence", async () => {
		const driver = createTestDriver();
		const prep = await hubPrepareIntegration(
			store,
			roomId,
			conversationId,
			{ accountId },
			{ deliveryId, targetBotId: botId },
			driver,
		);
		await store.transact((s) => {
			s.integrations.find((i) => i.id === prep.id)!.status = "verified";
		});
		await expect(
			hubConfirmIntegration(store, roomId, conversationId, prep.id, { accountId }, {}, driver),
		).rejects.toThrow(/successful real verification proof/);
		expect(await runGit(repoDir, ["rev-parse", "main"])).toBe(baseCommit);
	});

	it("detects real Git merge conflicts and extracts conflict preview", async () => {
		const driver = createTestDriver();
		const actor = { accountId };

		await runGit(repoDir, ["checkout", "main"]);
		await writeFile(join(repoDir, "file.txt"), "Initial content\nConflicting line on main\n", "utf8");
		await runGit(repoDir, ["add", "file.txt"]);
		await runGit(repoDir, ["commit", "-m", "Conflicting commit on main"]);
		const conflictingTargetSha = await runGit(repoDir, ["rev-parse", "HEAD"]);
		await runGit(repoDir, ["checkout", "--detach", conflictingTargetSha]);

		const prep = await hubPrepareIntegration(
			store,
			roomId,
			conversationId,
			actor,
			{ deliveryId, targetBotId: botId, targetBranch: "main" },
			driver,
		);

		expect(prep.status).toBe("conflict");
		expect(prep.conflicts).toContain("file.txt");
		expect(prep.expectedTargetSha).toBe(conflictingTargetSha);
	});

	it("rejects integration when delivery has no accepted review or is invalidated", async () => {
		const driver = createTestDriver();
		const actor = { accountId };

		await store.transact((draft) => {
			draft.reviews[0].verdict = "changes_requested";
		});

		await expect(
			hubPrepareIntegration(
				store,
				roomId,
				conversationId,
				actor,
				{ deliveryId, targetBotId: botId, targetBranch: "main" },
				driver,
			),
		).rejects.toThrow(/accepted review/i);
	});

	it("rejects apply when target branch moved (CAS target SHA mismatch)", async () => {
		const driver = createTestDriver();
		const actor = { accountId };

		const prep = await hubPrepareIntegration(
			store,
			roomId,
			conversationId,
			actor,
			{ deliveryId, targetBotId: botId, targetBranch: "main" },
			driver,
		);

		expect(prep.status).toBe("prepared");

		await hubVerifyIntegration(store, roomId, conversationId, prep.id, actor, { commands: ["node test.js"] }, driver);
		await writeFile(join(repoDir, "other.txt"), "concurrent change\n", "utf8");
		await runGit(repoDir, ["add", "other.txt"]);
		await runGit(repoDir, ["commit", "-m", "Concurrent advance on main"]);
		const advancedCommit = await runGit(repoDir, ["rev-parse", "HEAD"]);
		await runGit(repoDir, ["branch", "-f", "main", advancedCommit]);

		await expect(
			hubConfirmIntegration(store, roomId, conversationId, prep.id, actor, { expectedTargetSha: baseCommit }, driver),
		).rejects.toMatchObject({ code: "INTEGRATION_TARGET_MOVED", status: 409 });

		const updated = store.snapshot().integrations.find((it) => it.id === prep.id);
		expect(updated?.status).toBe("applying");
		expect(updated?.publishIntent).toBeDefined();
		expect(updated?.publishReceipt).toBeUndefined();
		expect(await runGit(repoDir, ["rev-parse", "main"])).toBe(advancedCommit);
	});

	it("rejects prepare when target repository has uncommitted dirty changes", async () => {
		const driver = createTestDriver();
		const actor = { accountId };

		await writeFile(join(repoDir, "dirty.txt"), "dirty untracked\n", "utf8");
		await runGit(repoDir, ["add", "dirty.txt"]);

		await expect(
			hubPrepareIntegration(
				store,
				roomId,
				conversationId,
				actor,
				{ deliveryId, targetBotId: botId, targetBranch: "main" },
				driver,
			),
		).rejects.toThrow(/uncommitted changes/i);
	});

	it("cancels integration safely and cleans up worktree", async () => {
		const driver = createTestDriver();
		const actor = { accountId };

		const prep = await hubPrepareIntegration(
			store,
			roomId,
			conversationId,
			actor,
			{ deliveryId, targetBotId: botId, targetBranch: "main" },
			driver,
		);

		expect(prep.status).toBe("prepared");

		const cancelled = await hubCancelIntegration(store, roomId, conversationId, prep.id, actor, driver);
		expect(cancelled.status).toBe("cancelled");

		const record = store.snapshot().integrations.find((it) => it.id === prep.id);
		expect(record?.status).toBe("cancelled");
	});

	it.each(["prepared", "failed"] as const)(
		"cleans legacy %s with the original device binding and sufficient local stop evidence",
		async (status) => {
			const driver = createTestDriver();
			const prep = await hubPrepareIntegration(
				store,
				roomId,
				conversationId,
				{ accountId },
				{ deliveryId, targetBotId: botId },
				driver,
			);
			await store.transact((s) => {
				const old = s.integrations.find((i) => i.id === prep.id)!;
				delete old.targetDeviceId;
				old.status = status;
			});
			const sessionsPath = join(dataDir, "integration-sessions.json");
			const sessions = JSON.parse(await readFile(sessionsPath, "utf8"));
			const oldSession = sessions.find((session: any) => session.integrationId === prep.id);
			if (status === "prepared") delete oldSession.verificationStopConfirmed;
			else oldSession.verificationStopConfirmed = true;
			delete oldSession.gitDir;
			delete oldSession.commonDir;
			await writeFile(sessionsPath, JSON.stringify(sessions), "utf8");
			const result = await hubCancelIntegration(store, roomId, conversationId, prep.id, { accountId }, driver);
			expect(result.status).toBe("cancelled");
			expect(result.verification).toBeUndefined();
			expect(result.targetDeviceId).toBe(deviceId);
		},
	);

	it("prevents cancel from overwriting an already applied terminal state (race condition defense)", async () => {
		const driver = createTestDriver();
		const actor = { accountId };

		const prep = await hubPrepareIntegration(
			store,
			roomId,
			conversationId,
			actor,
			{ deliveryId, targetBotId: botId, targetBranch: "main" },
			driver,
		);

		await hubVerifyIntegration(store, roomId, conversationId, prep.id, actor, { commands: ["node test.js"] }, driver);
		await hubConfirmIntegration(
			store,
			roomId,
			conversationId,
			prep.id,
			actor,
			{ expectedTargetSha: baseCommit },
			driver,
		);

		await expect(
			hubCancelIntegration(store, roomId, conversationId, prep.id, { accountId: "other-account" }),
		).rejects.toMatchObject({ status: 404 });
		expect((await hubCancelIntegration(store, roomId, conversationId, prep.id, actor)).status).toBe("applied");
		let cancelCalls = 0;
		const retained = await hubCancelIntegration(store, roomId, conversationId, prep.id, actor, {
			callDeviceCommand: async () => {
				cancelCalls++;
				throw new Error("Unexpected cancellation RPC");
			},
		});
		expect(retained.status).toBe("applied");
		expect(retained.publishReceipt).toBeDefined();
		expect(cancelCalls).toBe(0);

		const record = store.snapshot().integrations.find((it) => it.id === prep.id);
		expect(record?.status).toBe("applied");
	}, 30000);

	it("rejects integration when device driver is offline (no Hub local fallback)", async () => {
		const actor = { accountId };

		await expect(
			hubPrepareIntegration(
				store,
				roomId,
				conversationId,
				actor,
				{ deliveryId, targetBotId: botId, targetBranch: "main" },
				undefined,
			),
		).rejects.toThrow(/Target device offline or command unavailable/i);
	});

	it("rejects malicious or invalid branch names", async () => {
		const driver = createTestDriver();
		const actor = { accountId };

		await expect(
			hubPrepareIntegration(
				store,
				roomId,
				conversationId,
				actor,
				{ deliveryId, targetBotId: botId, targetBranch: "-dash-branch" },
				driver,
			),
		).rejects.toThrow(/Invalid branch name/i);

		await expect(
			hubPrepareIntegration(
				store,
				roomId,
				conversationId,
				actor,
				{ deliveryId, targetBotId: botId, targetBranch: "heads/../../escape" },
				driver,
			),
		).rejects.toThrow(/Invalid branch name/i);
	});

	it("rejects confirm when validation commands altered repository contents (preparedTreeSha mismatch)", async () => {
		const driver = createTestDriver();
		const actor = { accountId };

		const prep = await hubPrepareIntegration(
			store,
			roomId,
			conversationId,
			actor,
			{ deliveryId, targetBotId: botId, targetBranch: "main" },
			driver,
		);

		await expect(
			hubVerifyIntegration(
				store,
				roomId,
				conversationId,
				prep.id,
				actor,
				{ commands: ["node -e \"require('fs').writeFileSync('file.txt', 'HACKED')\""] },
				driver,
			),
		).rejects.toThrow(/modified|changed|dirty|tree/i);

		await expect(
			hubConfirmIntegration(store, roomId, conversationId, prep.id, actor, { expectedTargetSha: baseCommit }, driver),
		).rejects.toThrow(/successful real verification proof/i);
	});

	it("rejects commit when operation generation opId collides with concurrent operation", async () => {
		const driver = createTestDriver();
		const actor = { accountId };

		const prep = await hubPrepareIntegration(
			store,
			roomId,
			conversationId,
			actor,
			{ deliveryId, targetBotId: botId, targetBranch: "main" },
			driver,
		);

		const interceptedDriver = {
			callDeviceCommand: async (devId: string, action: string, payload: any) => {
				await store.transact((draft) => {
					const it = draft.integrations.find((r) => r.id === prep.id);
					if (it) it.currentOpId = "concurrent-different-op-id";
				});
				return await driver.callDeviceCommand(devId, action, payload);
			},
		};

		await expect(
			hubVerifyIntegration(
				store,
				roomId,
				conversationId,
				prep.id,
				actor,
				{ commands: ["node test.js"] },
				interceptedDriver,
			),
		).rejects.toThrow(/operation generation or subject changed/i);
	});

	it("refuses to overwrite concurrent human edits on checked-out branch without hard reset", async () => {
		const driver = createTestDriver();
		const actor = { accountId };

		const prep = await hubPrepareIntegration(
			store,
			roomId,
			conversationId,
			actor,
			{ deliveryId, targetBotId: botId, targetBranch: "main" },
			driver,
		);

		await hubVerifyIntegration(store, roomId, conversationId, prep.id, actor, { commands: ["node test.js"] }, driver);
		await runGit(repoDir, ["checkout", "main"]);
		await writeFile(join(repoDir, "file.txt"), "Human uncommitted critical work\n", "utf8");

		await expect(
			hubConfirmIntegration(store, roomId, conversationId, prep.id, actor, { expectedTargetSha: baseCommit }, driver),
		).rejects.toThrow(/uncommitted changes|dirty state|checked out/i);

		const humanContent = await readFile(join(repoDir, "file.txt"), "utf8");
		expect(humanContent).toBe("Human uncommitted critical work\n");
	});

	it("aborts validation command sub-process when cancellation signal is triggered", async () => {
		const driver = createTestDriver();
		const actor = { accountId };

		const prep = await hubPrepareIntegration(
			store,
			roomId,
			conversationId,
			actor,
			{ deliveryId, targetBotId: botId, targetBranch: "main" },
			driver,
		);

		const abortCtrl = new AbortController();
		const started = join(testDir, "verify-started");
		const command = `node -e "require('fs').writeFileSync('${started.replace(/\\/g, "/")}', 'started');setTimeout(() => console.log('FINISHED'), 10000)"`;
		const verifyPromise = deviceVerifyIntegration(
			{
				integrationId: prep.id,
				targetBotId: botId,
				targetBotRevision: 1,
				repoRoot: repoDir,
				dataDir,
				verificationPlan: freezeVerificationPlan([command], accountId),
				materializedCommit: prep.materializedCommit!,
				preparedTree: prep.preparedTree!,
				expectedTargetSha: prep.expectedTargetSha,
			},
			{ signal: abortCtrl.signal },
		);

		const rejected = expect(verifyPromise).rejects.toThrow(/cancelled|aborted/i);
		for (let i = 0; i < 200 && !existsSync(started); i++) await new Promise((resolve) => setTimeout(resolve, 25));
		expect(existsSync(started)).toBe(true);
		abortCtrl.abort();
		await rejected;
	});

	it("persists sessions to disk and cleans up orphan worktrees on recovery", async () => {
		const driver = createTestDriver();
		const actor = { accountId };

		const prep = await hubPrepareIntegration(
			store,
			roomId,
			conversationId,
			actor,
			{ deliveryId, targetBotId: botId, targetBranch: "main" },
			driver,
		);

		const persistedFile = join(dataDir, "integration-sessions.json");
		expect(existsSync(persistedFile)).toBe(true);
		const content = JSON.parse(await readFile(persistedFile, "utf8"));
		expect(content).toHaveLength(1);
		expect(content[0].integrationId).toBe(prep.id);

		const { recoverOrphanWorktrees } = await import("../../server/device-center/device-integration.js");
		const res = await recoverOrphanWorktrees(dataDir, () => repoDir);
		expect(res.recoveredCount).toBeGreaterThanOrEqual(1);

		const afterContent = JSON.parse(await readFile(persistedFile, "utf8"));
		expect(afterContent).toHaveLength(0);
	});

	it("requires explicit owner resume of the same safe intent, preserving successful verification history", async () => {
		const original = createTestDriver();
		let confirms = 0;
		const driver = {
			callDeviceCommand: async (device: string, action: string, payload: unknown) => {
				if (action === "integration_confirm") confirms++;
				return original.callDeviceCommand(device, action, payload);
			},
		};
		const actor = { accountId };

		const prep = await hubPrepareIntegration(
			store,
			roomId,
			conversationId,
			actor,
			{ deliveryId, targetBotId: botId, targetBranch: "main" },
			driver,
		);

		const firstVerified = await hubVerifyIntegration(
			store,
			roomId,
			conversationId,
			prep.id,
			actor,
			{ commands: ["node test.js"] },
			driver,
		);
		await runGit(repoDir, ["checkout", "main"]);

		let firstError: any;
		try {
			await hubConfirmIntegration(
				store,
				roomId,
				conversationId,
				prep.id,
				actor,
				{ expectedTargetSha: baseCommit },
				driver,
			);
		} catch (err) {
			firstError = err;
		}
		expect(firstError?.message).toMatch(/checked out in a worktree/i);
		expect(firstError?.status).toBe(409);
		expect(await runGit(repoDir, ["rev-parse", "refs/heads/main"])).toBe(baseCommit);

		await runGit(repoDir, ["checkout", "--detach", baseCommit]);

		const existing = await hubConfirmIntegration(store, roomId, conversationId, prep.id, actor, {}, driver);
		expect(confirms).toBe(1);
		await expect(
			hubPrepareIntegration(store, roomId, conversationId, actor, { deliveryId, targetBotId: botId }, driver),
		).rejects.toThrow(/freezes/);
		const reconciled = await hubReconcileIntegration(store, roomId, conversationId, actor, prep.id, driver);
		expect(reconciled.publishObservation).toMatchObject({ phase: "prepared", retryable: true, target: "expected_old" });
		const intent = existing.publishIntent!;
		const retried = await hubResumeIntegration(
			store,
			roomId,
			conversationId,
			actor,
			prep.id,
			{ intentId: intent.id, intentDigest: intent.digest, candidateSha: intent.candidateSha },
			driver,
		);
		expect(confirms).toBe(2);
		expect(retried.publishIntent).toEqual(intent);

		expect(retried.status).toBe("applied");
		expect(retried.newCommitSha).toBeDefined();

		const content = await runGit(repoDir, ["show", "refs/heads/main:file.txt"]);
		expect(content).toContain("Added line by bot");
		const history = listIntegrations(store.snapshot(), conversationId);
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			id: prep.id,
			status: "applied",
			newCommitSha: intent.candidateSha,
			verification: { digest: firstVerified.verification!.digest },
			publishReceipt: { candidateSha: intent.candidateSha, proof: "cas_exit" },
		});
	}, 30_000);
});
