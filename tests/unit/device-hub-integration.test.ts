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
	listIntegrations,
} from "../../server/device-center/hub-integration.js";
import {
	devicePrepareIntegration,
	deviceVerifyIntegration,
	deviceConfirmIntegration,
	deviceCancelIntegration,
} from "../../server/device-center/device-integration.js";
import type { DeviceDelivery, DeviceReview } from "../../server/protocol.js";

const exec = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await exec("git", args, { cwd, windowsHide: true });
	return stdout.trim();
}

describe("device-hub-integration", () => {
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

		// 初始化目标真实 Git 仓库
		await runGit(repoDir, ["init"]);
		await runGit(repoDir, ["branch", "-M", "main"]);
		await runGit(repoDir, ["config", "user.name", "Test Runner"]);
		await runGit(repoDir, ["config", "user.email", "test@runner.local"]);
		await runGit(repoDir, ["config", "commit.gpgSign", "false"]);
		await runGit(repoDir, ["config", "core.autocrlf", "false"]);

		// 创建初始提交
		await writeFile(join(repoDir, "file.txt"), "Initial content\n", "utf8");
		await runGit(repoDir, ["add", "file.txt"]);
		await runGit(repoDir, ["commit", "-m", "Initial commit"]);
		baseCommit = await runGit(repoDir, ["rev-parse", "HEAD"]);

		// 创建开发分支并提交改动
		await runGit(repoDir, ["checkout", "-b", "feature"]);
		await writeFile(join(repoDir, "file.txt"), "Initial content\nAdded line by bot\n", "utf8");
		await writeFile(join(repoDir, "test.js"), "console.log('CHECK_OK');\n", "utf8");
		await runGit(repoDir, ["add", "file.txt", "test.js"]);
		await runGit(repoDir, ["commit", "-m", "Feature commit by bot"]);
		devCommit = await runGit(repoDir, ["rev-parse", "HEAD"]);

		// 保持在 detached HEAD 或非 main 分支，保证目标分支 main 未被检出
		await runGit(repoDir, ["checkout", "--detach", baseCommit]);

		// 初始化 Store
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

	// 模拟设备 Command RPC Driver
	function createTestDriver() {
		return {
			callDeviceCommand: async (devId: string, action: string, payload: any, options?: { signal?: AbortSignal }) => {
				if (devId !== deviceId) throw new Error("Device offline");
				if (action === "integration_prepare") {
					return await devicePrepareIntegration(
						{
							integrationId: payload.integrationId,
							targetBotId: payload.targetBotId,
							targetBotRevision: payload.targetBotRevision ?? 1,
							repoRoot: repoDir,
							dataDir,
							targetBranch: payload.targetBranch,
							commit: payload.commit,
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
							commands: payload.commands,
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
							commit: payload.commit,
							expectedTargetSha: payload.expectedTargetSha,
						},
						options,
					);
				}
				if (action === "integration_cancel") {
					return await deviceCancelIntegration(
						{
							integrationId: payload.integrationId,
							targetBotId: payload.targetBotId,
							targetBotRevision: payload.targetBotRevision ?? 1,
							repoRoot: repoDir,
							dataDir,
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

		// 1. Prepare
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

		// 2. Verify: 显式指定验证命令
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

		// 3. Confirm (Apply): 明确确认后写入目标分支
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

		// 验证目标分支 HEAD 被原子更新
		const newHead = await runGit(repoDir, ["rev-parse", "refs/heads/main"]);
		expect(newHead).toBe(applied.newCommitSha);

		// 验证目标分支内容已更新
		const content = await runGit(repoDir, ["show", "refs/heads/main:file.txt"]);
		expect(content).toContain("Added line by bot");

		// 验证会话历史记录
		const list = listIntegrations(store.snapshot(), conversationId);
		expect(list).toHaveLength(1);
		expect(list[0].status).toBe("applied");
	});

	it("detects real Git merge conflicts and extracts conflict preview", async () => {
		const driver = createTestDriver();
		const actor = { accountId };

		// 切到 main 分支修改同一文件制造冲突并提交
		await runGit(repoDir, ["checkout", "main"]);
		await writeFile(join(repoDir, "file.txt"), "Initial content\nConflicting line on main\n", "utf8");
		await runGit(repoDir, ["add", "file.txt"]);
		await runGit(repoDir, ["commit", "-m", "Conflicting commit on main"]);
		const conflictingTargetSha = await runGit(repoDir, ["rev-parse", "HEAD"]);
		// 切离 main 分支，保证 main 未被检出
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

		// 将验收改为 changes_requested
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

		// 在 prepare 之后，外部并发推进 main 分支
		await writeFile(join(repoDir, "other.txt"), "concurrent change\n", "utf8");
		await runGit(repoDir, ["add", "other.txt"]);
		await runGit(repoDir, ["commit", "-m", "Concurrent advance on main"]);
		const advancedCommit = await runGit(repoDir, ["rev-parse", "HEAD"]);
		await runGit(repoDir, ["branch", "-f", "main", advancedCommit]);

		// 尝试 Apply，CAS 应严格拒绝
		await expect(
			hubConfirmIntegration(store, roomId, conversationId, prep.id, actor, { expectedTargetSha: baseCommit }, driver),
		).rejects.toMatchObject({ code: "INTEGRATION_TARGET_MOVED", status: 409 });

		const updated = store.snapshot().integrations.find((it) => it.id === prep.id);
		expect(updated?.status).toBe("failed");
	});

	it("rejects prepare when target repository has uncommitted dirty changes", async () => {
		const driver = createTestDriver();
		const actor = { accountId };

		// 制造未提交的脏文件
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

		// 再次确认状态已持久化
		const record = store.snapshot().integrations.find((it) => it.id === prep.id);
		expect(record?.status).toBe("cancelled");
	});

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

		await hubConfirmIntegration(
			store,
			roomId,
			conversationId,
			prep.id,
			actor,
			{ expectedTargetSha: baseCommit },
			driver,
		);

		// 已经被 applied 了，此时调用 cancel 应被拒绝或保持 applied
		await expect(hubCancelIntegration(store, roomId, conversationId, prep.id, actor, driver)).rejects.toThrow(
			/Already applied integration cannot be cancelled/i,
		);

		const record = store.snapshot().integrations.find((it) => it.id === prep.id);
		expect(record?.status).toBe("applied");
	}, 30000);

	it("rejects integration when device driver is offline (no Hub local fallback)", async () => {
		const actor = { accountId };

		// 没有传 driver
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

		// 以 '-' 开头的分支名
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

		// 路径穿越分支名
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

		// 恶意验证命令：在隔离工作树内篡改代码
		await hubVerifyIntegration(
			store,
			roomId,
			conversationId,
			prep.id,
			actor,
			{ commands: ["node -e \"require('fs').writeFileSync('file.txt', 'HACKED')\""] },
			driver,
		);

		// Confirm 阶段应由 write-tree 检查出与 preparedTreeSha 不一致并拒绝！
		await expect(
			hubConfirmIntegration(store, roomId, conversationId, prep.id, actor, { expectedTargetSha: baseCommit }, driver),
		).rejects.toThrow(/Worktree content modified by validation commands/i);
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

		// 模拟并发更新导致 opId 不匹配
		const interceptedDriver = {
			callDeviceCommand: async (devId: string, action: string, payload: any) => {
				// 模拟外部并发修改了 store 中的 currentOpId
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
		).rejects.toThrow(/Verification generation mismatch/i);
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

		// 人类切回了 main 分支，此时目标分支被检出
		await runGit(repoDir, ["checkout", "main"]);
		await writeFile(join(repoDir, "file.txt"), "Human uncommitted critical work\n", "utf8");

		// 尝试 Apply：严格拒绝，绝不使用 hard reset 抹掉人类的文件，且要求切离分支
		await expect(
			hubConfirmIntegration(store, roomId, conversationId, prep.id, actor, { expectedTargetSha: baseCommit }, driver),
		).rejects.toThrow(/uncommitted changes|dirty state|checked out/i);

		// 人类文件必须毫发无损地保留在磁盘上！
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
		const verifyPromise = deviceVerifyIntegration(
			{
				integrationId: prep.id,
				targetBotId: botId,
				targetBotRevision: 1,
				repoRoot: repoDir,
				dataDir,
				commands: ["node -e \"setTimeout(() => console.log('FINISHED'), 10000)\""],
			},
			{ signal: abortCtrl.signal },
		);

		// 100ms 后触发取消
		setTimeout(() => abortCtrl.abort(), 100);

		await expect(verifyPromise).rejects.toThrow(/cancelled/i);
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

		// 检查磁盘上已生成持久化注册表
		const persistedFile = join(dataDir, "integration-sessions.json");
		expect(existsSync(persistedFile)).toBe(true);
		const content = JSON.parse(await readFile(persistedFile, "utf8"));
		expect(content).toHaveLength(1);
		expect(content[0].integrationId).toBe(prep.id);

		// 模拟孤儿工作树清理
		const { recoverOrphanWorktrees } = await import("../../server/device-center/device-integration.js");
		const res = await recoverOrphanWorktrees(dataDir, () => repoDir);
		expect(res.recoveredCount).toBeGreaterThanOrEqual(1);

		// 恢复清理后注册表应被清空
		const afterContent = JSON.parse(await readFile(persistedFile, "utf8"));
		expect(afterContent).toHaveLength(0);
	});

	it("supports clean idempotent retry of the same record after switching away from checked-out branch", async () => {
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

		// 人类切到了 main 分支
		await runGit(repoDir, ["checkout", "main"]);

		// 首次 Apply：前置拦截 checked out 409，此时绝不执行 commit
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

		// 人类切离 main 分支（切到 detached HEAD）
		await runGit(repoDir, ["checkout", "--detach", baseCommit]);

		// 同一 record 再次重试 Apply：前置条件满足，此时顺畅完成 commit 与 CAS update-ref！
		const retried = await hubConfirmIntegration(
			store,
			roomId,
			conversationId,
			prep.id,
			actor,
			{ expectedTargetSha: baseCommit },
			driver,
		);

		expect(retried.status).toBe("applied");
		expect(retried.newCommitSha).toBeDefined();

		// 验证目标分支内容真实更新
		const content = await runGit(repoDir, ["show", "refs/heads/main:file.txt"]);
		expect(content).toContain("Added line by bot");
	});
});
