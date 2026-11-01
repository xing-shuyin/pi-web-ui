import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { DeviceHubStore } from "../../server/device-center/store.js";
import { createDeviceHub } from "../../server/device-center/hub.js";
import { request as httpRequest } from "node:http";
import { hubConfirmIntegration, hubCancelIntegration } from "../../server/device-center/hub-integration.js";
import {
	verifyNoExternalDrivers,
	verifyGitAttributesSafe,
	devicePrepareIntegration,
	deviceConfirmIntegration,
	deviceCancelIntegration,
	inspectLocalTarget,
} from "../../server/device-center/device-integration.js";
import {
	loadExecutionSettings,
	saveExecutionSettings,
	validateExecutionSettings,
	DeviceExecutionSettingsError,
} from "../../server/device-center/execution-settings.js";
import { DeviceTaskScheduler } from "../../server/device-center/task-scheduler.js";
import { createDeviceRuntime } from "../../server/device-center/runtime.js";

const exec = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await exec("git", args, { cwd, windowsHide: true });
	return stdout.trim();
}

describe("device-collaboration-boundaries", () => {
	let testDir: string;
	let dataDir: string;
	let repoDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "pi-collab-bound-test-"));
		dataDir = join(testDir, "hub-data");
		repoDir = join(testDir, "target-repo");
		await mkdir(dataDir, { recursive: true });
		await mkdir(repoDir, { recursive: true });

		// 初始化目标真实 Git 仓库
		await runGit(repoDir, ["init"]);
		await runGit(repoDir, ["branch", "-M", "main"]);
		await runGit(repoDir, ["config", "user.name", "Boundary Test Runner"]);
		await runGit(repoDir, ["config", "user.email", "boundary@test.local"]);
		await runGit(repoDir, ["config", "commit.gpgSign", "false"]);

		// 创建初始提交
		await writeFile(join(repoDir, "base.txt"), "Base content\n", "utf8");
		await runGit(repoDir, ["add", "base.txt"]);
		await runGit(repoDir, ["commit", "-m", "Initial base commit"]);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true }).catch(() => {});
	});

	describe("Git driver safety: custom merge/filter/diff drivers forbidden", () => {
		it("rejects integration if repository config defines custom merge driver", async () => {
			const canaryFile = join(testDir, "merge-canary.txt");
			await runGit(repoDir, ["config", "merge.evil.driver", `echo evil > "${canaryFile}"`]);

			await expect(verifyNoExternalDrivers(repoDir, dataDir)).rejects.toMatchObject({
				code: "INTEGRATION_CUSTOM_DRIVER",
				status: 422,
			});
			// Canary 检查：确保驱动绝未被执行
			expect(existsSync(canaryFile)).toBe(false);
		});

		it("rejects integration if repository config defines custom filter clean/smudge driver", async () => {
			const canaryFile = join(testDir, "filter-canary.txt");
			await runGit(repoDir, ["config", "filter.custom_filter.clean", `echo evil > "${canaryFile}"`]);

			await expect(verifyNoExternalDrivers(repoDir, dataDir)).rejects.toMatchObject({
				code: "INTEGRATION_CUSTOM_DRIVER",
				status: 422,
			});
			// Canary 检查：确保 filter 绝未被触发
			expect(existsSync(canaryFile)).toBe(false);
		});

		it("rejects integration if .gitattributes defines custom filter driver", async () => {
			await writeFile(join(repoDir, ".gitattributes"), "* filter=untrusted_script\n", "utf8");

			await expect(verifyGitAttributesSafe(repoDir, dataDir)).rejects.toMatchObject({
				code: "INTEGRATION_CUSTOM_DRIVER",
				status: 422,
			});
		});

		it("passes safety check when repository and attributes contain standard drivers only", async () => {
			await writeFile(join(repoDir, ".gitattributes"), "*.txt text eol=lf\n*.bin binary\n", "utf8");

			await expect(verifyNoExternalDrivers(repoDir, dataDir)).resolves.toBeUndefined();
			await expect(verifyGitAttributesSafe(repoDir, dataDir)).resolves.toBeUndefined();
		});
	});

	describe("Target CAS and dirty-state guards in integration pipeline", () => {
		let baseCommit: string;

		beforeEach(async () => {
			baseCommit = await runGit(repoDir, ["rev-parse", "HEAD"]);
		});

		it("inspectLocalTarget rejects if target repository has uncommitted dirty changes", async () => {
			const clean = await inspectLocalTarget(repoDir, dataDir, "main");
			expect(clean.isDirty).toBe(false);
			expect(clean.headSha).toBe(baseCommit);

			// 在目标仓库中制造未跟踪脏文件
			await writeFile(join(repoDir, "dirty.txt"), "uncommitted dirty content\n", "utf8");

			const dirty = await inspectLocalTarget(repoDir, dataDir, "main");
			expect(dirty.isDirty).toBe(true);
		});

		it("inspectLocalTarget detects target branch HEAD movement for CAS guard", async () => {
			const before = await inspectLocalTarget(repoDir, dataDir, "main");
			expect(before.headSha).toBe(baseCommit);

			// 并发在 main 上推进一步提交
			await writeFile(join(repoDir, "concurrent.txt"), "Concurrent commit\n", "utf8");
			await runGit(repoDir, ["add", "concurrent.txt"]);
			await runGit(repoDir, ["commit", "-m", "Concurrent head advance"]);

			const after = await inspectLocalTarget(repoDir, dataDir, "main");
			expect(after.headSha).not.toBe(baseCommit);
			expect(after.headSha).toMatch(/^[a-f0-9]{40,64}$/i);
		});
	});

	describe("Hub integration state machine: applied status cannot be cancelled", () => {
		it("rejects hubCancelIntegration with 409 when integration is already applied", async () => {
			const store = await DeviceHubStore.open(dataDir);
			await store.transact((draft) => {
				draft.accounts.push({ id: "acc-1", username: "u1", createdAt: Date.now(), passwordHash: "h" } as any);
				draft.devices.push({
					id: "dev-1",
					accountId: "acc-1",
					name: "Dev",
					credentialHash: "ch",
					createdAt: Date.now(),
				});
				draft.bots.push({
					id: "bot-1",
					deviceId: "dev-1",
					accountId: "acc-1",
					name: "B1",
					description: "desc",
					enabled: true,
					revision: 1,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					cwd: repoDir,
				} as any);
				draft.rooms.push({ id: "room-1", accountId: "acc-1", name: "Room", botIds: ["bot-1"], createdAt: Date.now() });
				draft.integrations.push({
					id: "int-applied-1",
					accountId: "acc-1",
					roomId: "room-1",
					conversationId: "conv-1",
					deliveryId: "del-1",
					commit: "c1",
					reviewId: "rev-1",
					targetBotId: "bot-1",
					targetBotRevision: 1,
					targetBranch: "main",
					expectedTargetSha: "sha1",
					status: "applied",
					validationCommands: [],
					createdAt: Date.now(),
					updatedAt: Date.now(),
					newCommitSha: "sha2",
				});
			});

			await expect(
				hubCancelIntegration(store, "room-1", "conv-1", "int-applied-1", { accountId: "acc-1" }),
			).rejects.toThrow(/Already applied integration cannot be cancelled/);

			const finalRecord = store.snapshot().integrations.find((it) => it.id === "int-applied-1");
			expect(finalRecord?.status).toBe("applied");
			await store.close();
		});
	});

	describe("Execution settings: persist-then-apply boundary", () => {
		it("strictly validates settings schema and rejects unknown keys or out-of-range bounds", () => {
			expect(validateExecutionSettings({ maxActiveTasks: 4, maxWaitingTasks: 32 }).valid).toBe(true);

			// 未知 key 拒绝
			const unknownKey = validateExecutionSettings({ maxActiveTasks: 4, maxWaitingTasks: 32, rogue: true });
			expect(unknownKey.valid).toBe(false);

			// 超界拒绝
			const tooLarge = validateExecutionSettings({ maxActiveTasks: 999, maxWaitingTasks: 32 });
			expect(tooLarge.valid).toBe(false);

			// 非整数拒绝
			const floatVal = validateExecutionSettings({ maxActiveTasks: 3.5, maxWaitingTasks: 32 });
			expect(floatVal.valid).toBe(false);
		});

		it("saveExecutionSettings writes atomically and loadExecutionSettings restores cleanly", () => {
			const saved = saveExecutionSettings(dataDir, { maxActiveTasks: 8, maxWaitingTasks: 64 });
			expect(saved).toEqual({ maxActiveTasks: 8, maxWaitingTasks: 64 });

			const loaded = loadExecutionSettings(dataDir);
			expect(loaded).toEqual({ maxActiveTasks: 8, maxWaitingTasks: 64 });

			const onDisk = JSON.parse(readFileSync(join(dataDir, "execution-settings.json"), "utf8"));
			expect(onDisk).toEqual({ maxActiveTasks: 8, maxWaitingTasks: 64 });
		});

		it("runtime.updateExecutionSettings persists to disk before applying to scheduler", () => {
			const mockBots = new Map<string, any>([["bot-1", { id: "bot-1", cwd: repoDir, enabled: true, revision: 1 }]]);
			const runtime = createDeviceRuntime({
				config: {
					deviceId: "dev-local-1",
					hubUrl: "http://127.0.0.1:8787",
					credential: "cred",
					allowExecution: true,
				},
				dataDir,
				localOrigin: "http://127.0.0.1:8788",
				bots: {
					get: (id: string) => mockBots.get(id),
					list: () => Array.from(mockBots.values()),
				} as any,
			});

			// 合法更新
			const updated = runtime.updateExecutionSettings({ maxActiveTasks: 6, maxWaitingTasks: 20 });
			expect(updated).toEqual({ maxActiveTasks: 6, maxWaitingTasks: 20 });
			expect(runtime.getSchedulerSnapshot().settings).toEqual({ maxActiveTasks: 6, maxWaitingTasks: 20 });

			// 检查磁盘也已同步
			expect(loadExecutionSettings(dataDir)).toEqual({ maxActiveTasks: 6, maxWaitingTasks: 20 });

			// 传入非法配置必须被抛错拦截，且内存和磁盘维持原样
			expect(() => runtime.updateExecutionSettings({ maxActiveTasks: 9999, maxWaitingTasks: 20 })).toThrow(
				DeviceExecutionSettingsError,
			);
			expect(runtime.getSchedulerSnapshot().settings).toEqual({ maxActiveTasks: 6, maxWaitingTasks: 20 });
			expect(loadExecutionSettings(dataDir)).toEqual({ maxActiveTasks: 6, maxWaitingTasks: 20 });
		});
	});

	describe("Scheduler and Runtime cancel attempt precision", () => {
		it("scheduler.cancelTask with specific attemptId only cancels matching attempt", () => {
			const scheduler = new DeviceTaskScheduler({
				initialSettings: { maxActiveTasks: 1, maxWaitingTasks: 16 },
			});

			// 先占满 active 槽位，使后续任务必然进入 waiting 队列
			scheduler.registerActive(
				{
					id: "task-blocking-slot",
					attemptId: "att-block",
					roomId: "room-1",
					botId: "bot-block",
					root: join(testDir, "block-root"),
				},
				new AbortController(),
			);

			let cancelledCount = 0;
			const task1 = {
				id: "task-attempt-precision",
				attemptId: "attempt-1",
				roomId: "room-1",
				botId: "bot-1",
				root: repoDir,
			};

			const queuedItem = scheduler.enqueue(task1, {
				start: () => {},
				reject: () => {},
				cancel: () => {
					cancelledCount++;
				},
			});
			expect(queuedItem).not.toBeNull();
			expect(scheduler.getWaitingCount()).toBe(1);

			// 取消不存在的不匹配 attemptId -> 应返回 false 且队列不被误杀
			const missCancel = scheduler.cancelTask(task1.id, "attempt-999");
			expect(missCancel).toBe(false);
			expect(scheduler.getWaitingCount()).toBe(1);
			expect(cancelledCount).toBe(0);

			// 取消完全匹配的 attemptId -> 应返回 true 且任务出队
			const hitCancel = scheduler.cancelTask(task1.id, "attempt-1");
			expect(hitCancel).toBe(true);
			expect(scheduler.getWaitingCount()).toBe(0);
			expect(cancelledCount).toBe(1);
		});

		it("active running task cancel with mismatched attemptId does not abort active controller", () => {
			const scheduler = new DeviceTaskScheduler({
				initialSettings: { maxActiveTasks: 4, maxWaitingTasks: 16 },
			});
			const controller = new AbortController();

			scheduler.registerActive(
				{
					id: "task-running-precision",
					attemptId: "attempt-active-1",
					roomId: "room-1",
					botId: "bot-1",
					root: repoDir,
				},
				controller,
			);
			expect(scheduler.getActiveCount()).toBe(1);

			// 尝试用错误 attempt 取消运行中的任务
			const missCancel = scheduler.cancelTask("task-running-precision", "attempt-active-2");
			expect(missCancel).toBe(false);
			expect(controller.signal.aborted).toBe(false);

			// 正确匹配 attemptId 取消
			const hitCancel = scheduler.cancelTask("task-running-precision", "attempt-active-1");
			expect(hitCancel).toBe(true);
			expect(controller.signal.aborted).toBe(true);
		});
	});

	describe("Public response leaseToken leak defense (HTTP Task APIs)", () => {
		it("ensures public HTTP APIs never leak leaseToken in room tasks or task details JSON", async () => {
			const hubDataDir = join(testDir, "public-leak-hub-data");
			await mkdir(hubDataDir, { recursive: true });

			const publicUrl = "https://hub.test";
			const hub = await createDeviceHub({
				dataDir: hubDataDir,
				publicUrl,
				onTask: () => {},
				onRevoke: () => {},
			});
			await new Promise<void>((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
			const address = hub.server.address() as { port: number };

			try {
				// Helper 发送请求
				const sendReq = (path: string, method = "GET", body?: any, cookie = "") =>
					new Promise<{ status: number; rawText: string; body: any; cookie: string }>((resolve, reject) => {
						const req = httpRequest(
							`http://127.0.0.1:${address.port}${path}`,
							{
								method,
								headers: {
									Host: new URL(publicUrl).host,
									Origin: publicUrl,
									"Content-Type": "application/json",
									...(cookie ? { Cookie: cookie } : {}),
								},
							},
							(res) => {
								let data = "";
								res.setEncoding("utf8");
								res.on("data", (chunk) => {
									data += chunk;
								});
								res.on("end", () => {
									try {
										resolve({
											status: res.statusCode!,
											rawText: data,
											body: data ? JSON.parse(data) : undefined,
											cookie: res.headers["set-cookie"]?.[0]?.split(";")[0] ?? "",
										});
									} catch (err) {
										reject(err);
									}
								});
							},
						);
						req.on("error", reject);
						req.end(body ? JSON.stringify(body) : undefined);
					});

				// 1. 注册获取 session cookie
				const reg = await sendReq("/api/auth/register", "POST", {
					username: "tokenguard",
					password: "safe-password-123",
				});
				expect(reg.status).toBe(201);
				const cookie = reg.cookie;
				const userAccount = hub.store.snapshot().accounts.find((a) => a.username === "tokenguard")!;

				// 2. 在 store 中直接准备 room 和带有机密 leaseToken 的任务
				const secretToken = "super-secret-lease-token-must-not-leak-99999";
				const roomId = "room-leak-audit-1";
				const taskId = "task-with-secret-lease";
				const botId = "bot-leak-audit-1";

				await hub.store.transact((draft) => {
					draft.rooms.push({
						id: roomId,
						accountId: userAccount.id,
						name: "Audit Room",
						botIds: [botId],
						createdAt: Date.now(),
					});
					draft.bots.push({
						id: botId,
						deviceId: "dev-leak-1",
						accountId: userAccount.id,
						name: "AuditBot",
						description: "desc",
						enabled: true,
						revision: 1,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					} as any);
					draft.tasks.push({
						id: taskId,
						rootTaskId: taskId,
						dispatchDepth: 0,
						roomId,
						accountId: userAccount.id,
						deviceId: "dev-leak-1",
						botId,
						botRevision: 1,
						text: "Sensitive task execution",
						status: "running",
						attemptId: "att-1",
						createdAt: Date.now(),
						updatedAt: Date.now(),
						leaseToken: secretToken,
					});
				});

				// 3. 验证 GET /api/rooms/:id 返回的 tasks 数组绝不包含 leaseToken
				const roomRes = await sendReq(`/api/rooms/${roomId}`, "GET", undefined, cookie);
				expect(roomRes.status).toBe(200);
				// 文本级断言：绝对不能在原始响应字符串中出现 secretToken
				expect(roomRes.rawText.includes(secretToken)).toBe(false);
				const foundTaskInRoom = roomRes.body.tasks.find((t: any) => t.id === taskId);
				expect(foundTaskInRoom).toBeDefined();
				expect(foundTaskInRoom.leaseToken).toBeUndefined();

				// 4. 验证 GET /api/rooms/:id/tasks/:taskId 单任务详情也绝不包含 leaseToken
				const taskDetailsRes = await sendReq(`/api/rooms/${roomId}/tasks/${taskId}`, "GET", undefined, cookie);
				expect(taskDetailsRes.status).toBe(200);
				expect(taskDetailsRes.rawText.includes(secretToken)).toBe(false);
				expect(taskDetailsRes.body.task.leaseToken).toBeUndefined();
			} finally {
				await hub.close();
			}
		});
	});

	describe("Human workspace data loss defense: no destructive reset --hard", () => {
		it("preserves human uncommitted work in target repository and forbids destructive wipe", async () => {
			const humanWorkPath = join(repoDir, "human-draft.txt");
			const humanWorkContent = "Critical human unsaved code\n";
			await writeFile(humanWorkPath, humanWorkContent, "utf8");

			// 验证 inspectLocalTarget 能立刻捕获到人类未提交改动，在第一道防线就拒绝集成，绝不给后续破坏性 reset 机会
			const targetCheck = await inspectLocalTarget(repoDir, dataDir, "main");
			expect(targetCheck.isDirty).toBe(true);

			// 验证人类改动文件完好无损，绝未被修改或丢失
			expect(existsSync(humanWorkPath)).toBe(true);
			expect(readFileSync(humanWorkPath, "utf8")).toBe(humanWorkContent);
		});
	});

	describe("CAS applied boundary and cleanup fault isolation", () => {
		it("rejects confirm when target branch is currently checked out in the main worktree", async () => {
			// 当前 repoDir HEAD 停留在 main 分支
			// 创建并提交真正的 feature 分支
			await runGit(repoDir, ["checkout", "-b", "dev-feature-branch"]);
			await writeFile(join(repoDir, "feature-code.txt"), "feature logic\n", "utf8");
			await runGit(repoDir, ["add", "feature-code.txt"]);
			await runGit(repoDir, ["commit", "-m", "feature commit"]);
			const devCommit = await runGit(repoDir, ["rev-parse", "HEAD"]);

			// 切回 main 分支
			await runGit(repoDir, ["checkout", "main"]);
			const baseSha = await runGit(repoDir, ["rev-parse", "HEAD"]);

			const currentBranch = await runGit(repoDir, ["symbolic-ref", "--short", "HEAD"]);
			expect(currentBranch).toBe("main");

			const integrationId = "int-checkedout-test";

			// 准备工作树
			await devicePrepareIntegration({
				integrationId,
				targetBotId: "bot-1",
				targetBotRevision: 1,
				repoRoot: repoDir,
				dataDir,
				targetBranch: "main",
				commit: devCommit,
			});

			try {
				// 尝试对已检出的 main 分支进行 confirm，必须直接被安全拦截，提示切换分支
				await expect(
					deviceConfirmIntegration({
						integrationId,
						targetBotId: "bot-1",
						targetBotRevision: 1,
						repoRoot: repoDir,
						dataDir,
						deliveryId: "del-test",
						commit: devCommit,
						expectedTargetSha: baseSha,
					}),
				).rejects.toMatchObject({ code: "INTEGRATION_TARGET_CHECKED_OUT", status: 409 });
			} finally {
				await deviceCancelIntegration({
					integrationId,
					targetBotId: "bot-1",
					targetBotRevision: 1,
					repoRoot: repoDir,
					dataDir,
				}).catch(() => {});
			}
		});
	});
});
