import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDeviceHub } from "../../server/device-center/hub.js";
import { createHubLockManager } from "../../server/device-center/hub-locks.js";
import {
	validateExecutionSettings,
	EXECUTION_SETTINGS_LIMITS,
	type DeviceExecutionSettings,
} from "../../server/device-center/execution-settings.js";

describe("Device Group Architecture Redesign - Proposal B", () => {
	let dataDir: string;
	const cleanups: (() => Promise<unknown>)[] = [];

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "group-redesign-b-"));
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) {
			await cleanup().catch(() => {});
		}
		await rm(dataDir, { recursive: true, force: true }).catch(() => {});
	});

	async function fixture(settingsOverride?: Partial<DeviceExecutionSettings>) {
		const publicHost = "hub.test";
		const publicUrl = `https://${publicHost}`;
		let currentSettings = {
			...EXECUTION_SETTINGS_LIMITS,
			maxActiveTasks: 8,
			maxWaitingTasks: 128,
			groupRetentionLimit: 5000,
			groupContextBytes: 131072,
			blackboardMaxBytes: 262144,
			resourceLockDefaultTtlMs: 1800000,
			...settingsOverride,
		} as DeviceExecutionSettings;

		const onTask = vi.fn().mockResolvedValue(true);
		const hub = await createDeviceHub({
			publicUrl,
			dataDir,
			allowRegistration: true,
			onTask,
			getSettings: () => currentSettings,
		});
		await new Promise<void>((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
		cleanups.push(() => hub.close());
		const address = (hub.server.address() as any).port;
		const base = `http://127.0.0.1:${address}`;

		const request = async (
			path: string,
			body?: unknown,
			cookie?: string,
			headers: Record<string, string> = {},
			method?: string,
		) => {
			return new Promise<{ status: number; body: any; cookie: string }>((resolve, reject) => {
				const req = httpRequest(
					`http://127.0.0.1:${address}${path}`,
					{
						method: method ?? (body === undefined ? "GET" : "POST"),
						headers: {
							Host: publicHost,
							Origin: publicUrl,
							...(cookie ? { Cookie: cookie } : {}),
							...(body === undefined ? {} : { "Content-Type": "application/json" }),
							...headers,
						},
					},
					(incoming) => {
						let data = "";
						incoming.setEncoding("utf8");
						incoming.on("data", (chunk) => {
							data += chunk;
						});
						incoming.on("end", () => {
							const resCookie = incoming.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
							try {
								resolve({ status: incoming.statusCode!, body: data ? JSON.parse(data) : {}, cookie: resCookie });
							} catch {
								resolve({ status: incoming.statusCode!, body: data, cookie: resCookie });
							}
						});
					},
				);
				req.on("error", reject);
				if (body !== undefined) req.write(JSON.stringify(body));
				req.end();
			});
		};

		const register = async (username = "tester") => {
			const res = await request("/api/auth/register", { username, password: "password123" });
			expect(res.status).toBe(201);
			return res.cookie;
		};

		const pair = async (cookie: string, name = "Device") => {
			const start = await request("/api/pair/start", { name });
			expect((await request("/api/pair/approve", { code: start.body.code }, cookie)).status).toBe(200);
			const result = await request("/api/pair/poll", { pollToken: start.body.pollToken });
			expect(result.status).toBe(200);
			const botId = `bot-${result.body.deviceId}`;
			expect(
				(
					await request(
						"/api/agent/bots",
						{ bots: [{ id: botId, name, description: "test Bot", enabled: true, revision: 1 }] },
						"",
						{ Authorization: `Bearer ${result.body.credential}`, "X-Device-Id": result.body.deviceId },
						"PUT",
					)
				).status,
			).toBe(200);
			return { deviceId: result.body.deviceId, botId, credential: result.body.credential };
		};

		return {
			base,
			hub,
			request,
			register,
			pair,
			setSettings: (s: Partial<DeviceExecutionSettings>) => {
				currentSettings = { ...currentSettings, ...s };
			},
		};
	}

	it("validates that all limits are raised and configurable up to extreme ceilings", () => {
		const highScaleSettings = {
			maxActiveTasks: 64,
			maxWaitingTasks: 1024,
			starvationThresholdMs: 60000,
			maxSkipsBeforeStarvation: 20,
			maxDispatchDepth: 64,
			maxDispatchBudget: 256,
			allowBotMentions: true,
			groupContextBytes: 2097152,
			groupRetentionLimit: 20000,
			fileSyncMaxBytes: 10737418240,
			fileSyncMaxFiles: 10000,
			fileSyncStagedBytes: 53687091200,
			resourceLockDefaultTtlMs: 86400000,
			blackboardMaxBytes: 4194304,
			taskReportExcerptBytes: 524288,
			maxResourceLocksPerTask: 256,
			botMentionBudgetPerTurn: 10,
		};
		const res = validateExecutionSettings(highScaleSettings);
		expect(res.valid).toBe(true);
		if (res.valid) {
			expect(res.value.groupContextBytes).toBe(2097152);
			expect(res.value.groupRetentionLimit).toBe(20000);
			expect(res.value.fileSyncMaxBytes).toBe(10737418240);
			expect(res.value.blackboardMaxBytes).toBe(4194304);
		}
	});

	it("Hub dynamically obeys raised group retention limit from settings instead of hardcoded 500", async () => {
		const f = await fixture({ groupRetentionLimit: 1200 });
		const cookie = await f.register("retainer");
		const dev = await f.pair(cookie, "Worker");

		const roomRes = await f.request("/api/rooms", { name: "Scale Room", botIds: [dev.botId] }, cookie);
		expect(roomRes.status).toBe(201);
		const roomId = roomRes.body.room.id;

		await f.hub.store.transact((draft) => {
			for (let i = 0; i < 800; i++) {
				draft.messages.push({
					id: `msg-${i}`,
					roomId,
					accountId: draft.rooms[0].accountId,
					text: `Message ${i}`,
					sender: { type: "human", id: "u1", name: "User" },
					createdAt: 1000 + i,
					taskIds: [],
				});
			}
		});

		const sendRes = await f.request(`/api/rooms/${roomId}/messages`, { text: "Trigger trim" }, cookie);
		expect(sendRes.status).toBe(200);

		const snapshot = f.hub.store.snapshot();
		const roomMessages = snapshot.messages.filter((m) => m.roomId === roomId);
		expect(roomMessages.length).toBe(801);
	});

	it("persists resource locks to disk and restores active locks across Hub restarts", () => {
		const lockFile = join(dataDir, "persisted-hub-locks.json");
		const manager1 = createHubLockManager({
			persistPath: lockFile,
			defaultTtlMs: 60000,
		});

		const res1 = manager1.acquireLocks({
			roomId: "room-persist-1",
			taskId: "task-001",
			botId: "bot-alpha",
			resourceLocks: ["git:repo:main", "workspace:packages/core"],
		});
		expect(res1.success).toBe(true);

		const resConflict = manager1.acquireLocks({
			roomId: "room-persist-1",
			taskId: "task-002",
			botId: "bot-beta",
			resourceLocks: ["git:repo:main"],
		});
		expect(resConflict.success).toBe(false);
		expect(resConflict.conflictingLocks).toEqual(["git:repo:main"]);

		const manager2 = createHubLockManager({
			persistPath: lockFile,
			defaultTtlMs: 60000,
		});

		const info = manager2.getRoomLockInfo("room-persist-1");
		expect(info.activeLocks.map((l) => l.lockKey).sort()).toEqual(["git:repo:main", "workspace:packages/core"]);
		expect(info.activeLocks.find((l) => l.lockKey === "git:repo:main")?.taskId).toBe("task-001");
		expect(info.waitingQueue.length).toBe(1);
		expect(info.waitingQueue[0].taskId).toBe("task-002");

		const promoted = manager2.releaseLocks("room-persist-1", "task-001");
		expect(promoted).toEqual(["task-002"]);

		manager1.close();
		manager2.close();
	});

	it("supports pipeline workflow dependency: task B waits for task A and wakes upon completion", async () => {
		const f = await fixture();
		const cookie = await f.register("pipeliner");
		const dev1 = await f.pair(cookie, "WorkerA");
		const dev2 = await f.pair(cookie, "WorkerB");

		const roomRes = await f.request("/api/rooms", { name: "Pipeline Room", botIds: [dev1.botId, dev2.botId] }, cookie);
		expect(roomRes.status).toBe(201);
		const roomId = roomRes.body.room.id;

		const taskARes = await f.request(
			`/api/rooms/${roomId}/messages`,
			{ text: "Step 1: Write Spec", targetBotIds: [dev1.botId] },
			cookie,
		);
		expect(taskARes.status).toBe(200);
		const taskA = taskARes.body.tasks[0];
		expect(taskA.status).toBe("queued");

		const taskBRes = await f.request(
			`/api/rooms/${roomId}/messages`,
			{ text: "Step 2: Implement Code", targetBotIds: [dev2.botId], dependsOnTaskId: taskA.id },
			cookie,
		);
		expect(taskBRes.status).toBe(200);
		const taskB = taskBRes.body.tasks[0];
		expect(taskB.status).toBe("waiting");
		expect(taskB.blockReason).toBe("dependency_waiting");
		expect(taskB.dependsOnTaskId).toBe(taskA.id);

		const taskALease = f.hub.store.snapshot().tasks.find((task) => task.id === taskA.id)!;
		await f.hub.acceptTaskEvent(dev1.deviceId, {
			botId: dev1.botId,
			leaseToken: taskALease.leaseToken,
			leaseGeneration: taskALease.leaseGeneration,
			taskId: taskA.id,
			attemptId: taskA.attemptId,
			status: "running",
		});
		await f.hub.acceptTaskEvent(dev1.deviceId, {
			botId: dev1.botId,
			leaseToken: taskALease.leaseToken,
			leaseGeneration: taskALease.leaseGeneration,
			taskId: taskA.id,
			attemptId: taskA.attemptId,
			status: "completed",
			report: "API Spec contract: export function calculateScore(): number",
		});

		const snapshot = f.hub.store.snapshot();
		const updatedTaskB = snapshot.tasks.find((t) => t.id === taskB.id)!;
		expect(updatedTaskB.status).toBe("queued");
		expect(updatedTaskB.blockReason).toBeUndefined();
		expect(updatedTaskB.text).toContain("API Spec contract: export function calculateScore");
		expect(updatedTaskB.text).toContain("Step 2: Implement Code");
	});

	it("supports in-flight steering on running tasks and rejects on terminal tasks", async () => {
		const f = await fixture();
		const cookie = await f.register("steerer");
		const dev = await f.pair(cookie, "Coder");

		const roomRes = await f.request("/api/rooms", { name: "Steering Room", botIds: [dev.botId] }, cookie);
		expect(roomRes.status).toBe(201);
		const roomId = roomRes.body.room.id;

		const dispatchRes = await f.request(
			`/api/rooms/${roomId}/messages`,
			{ text: "Long build task", targetBotIds: [dev.botId] },
			cookie,
		);
		expect(dispatchRes.status).toBe(200);
		const task = dispatchRes.body.tasks[0];

		const steerQueued = await f.request(`/api/rooms/${roomId}/tasks/${task.id}/steer`, { text: "Early steer" }, cookie);
		expect(steerQueued.status).toBe(409);

		const taskLease = f.hub.store.snapshot().tasks.find((entry) => entry.id === task.id)!;
		await f.hub.acceptTaskEvent(dev.deviceId, {
			botId: dev.botId,
			leaseToken: taskLease.leaseToken,
			leaseGeneration: taskLease.leaseGeneration,
			taskId: task.id,
			attemptId: task.attemptId,
			status: "running",
		});

		const unavailable = await f.request(
			`/api/rooms/${roomId}/tasks/${task.id}/steer`,
			{ text: "No executor available" },
			cookie,
		);
		expect(unavailable.status).toBe(200);
		expect(unavailable.body.steered).toBe(false);
		const steerTask = vi.fn().mockResolvedValue({ steered: true });
		f.hub.setRelay({ steerTask });

		const steerRunning = await f.request(
			`/api/rooms/${roomId}/tasks/${task.id}/steer`,
			{ text: "Dynamic correction: skip slow tests" },
			cookie,
		);
		expect(steerRunning.status).toBe(200);
		expect(steerRunning.body.steered).toBe(true);
		expect(steerTask).toHaveBeenCalledWith(
			dev.deviceId,
			task.id,
			task.attemptId,
			expect.stringContaining("skip slow tests"),
		);

		await f.hub.acceptTaskEvent(dev.deviceId, {
			botId: dev.botId,
			taskId: task.id,
			attemptId: task.attemptId,
			leaseToken: taskLease.leaseToken,
			leaseGeneration: taskLease.leaseGeneration,
			status: "completed",
			report: "Build completed",
		});
		const afterCompletion = await f.request(
			`/api/rooms/${roomId}/tasks/${task.id}/steer`,
			{ text: "Late steer" },
			cookie,
		);
		expect(afterCompletion.status).toBe(409);
		expect(steerTask).toHaveBeenCalledTimes(1);

		const snapshot = f.hub.store.snapshot();
		const steerMessage = snapshot.messages.find((m) => m.text.includes("Dynamic correction: skip slow tests"));
		expect(steerMessage).toBeDefined();
		expect(steerMessage?.text).toContain("飞行中即时转向");
	});
});
