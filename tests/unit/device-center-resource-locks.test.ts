import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createDeviceHub } from "../../server/device-center/hub.js";
import { HubLockManager, isValidLockKey, validateResourceLocks } from "../../server/device-center/hub-locks.js";
import {
	makeDeviceCollabTool,
	setDeviceCollabService,
	type DeviceCollabInput,
} from "../../server/device-center/collab-tool.js";
import type { RoomLockInfo } from "../../server/protocol.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(publicUrl = "https://hub.test") {
	const dataDir = await mkdtemp(join(tmpdir(), "device-hub-locks-test-"));
	cleanups.push(async () => {
		for (let i = 0; i < 5; i++) {
			try {
				await rm(dataDir, { recursive: true, force: true });
				break;
			} catch (e: any) {
				if (e?.code !== "EBUSY" && e?.code !== "EPERM") throw e;
				await new Promise((r) => setTimeout(r, 60));
			}
		}
	});

	const deliveredTasks: any[] = [];
	const onTask = vi.fn(async (_deviceId: string, task: any) => {
		deliveredTasks.push(task);
		return true;
	});

	const hub = await createDeviceHub({
		dataDir,
		publicUrl,
		onTask,
	});

	await new Promise<void>((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => hub.close());
	const address = hub.server.address() as { port: number };

	async function request(
		path: string,
		body?: unknown,
		cookie = "",
		extra: Record<string, string> = {},
		method?: string,
	) {
		const response = await new Promise<{ status: number; body: any; cookie: string }>((resolve, reject) => {
			const outgoing = httpRequest(
				`http://127.0.0.1:${address.port}${path}`,
				{
					method: method ?? (body === undefined ? "GET" : "POST"),
					headers: {
						Host: new URL(publicUrl).host,
						Origin: publicUrl,
						"Content-Type": "application/json",
						Cookie: cookie,
						...extra,
					},
				},
				(incoming) => {
					let data = "";
					incoming.setEncoding("utf8");
					incoming.on("data", (chunk) => {
						data += chunk;
					});
					incoming.on("end", () => {
						try {
							resolve({
								status: incoming.statusCode!,
								body: data ? JSON.parse(data) : undefined,
								cookie: incoming.headers["set-cookie"]?.[0]?.split(";")[0] ?? "",
							});
						} catch (error) {
							reject(error);
						}
					});
				},
			);
			outgoing.on("error", reject);
			outgoing.end(body === undefined ? undefined : JSON.stringify(body));
		});
		return response;
	}

	async function register(username = "alice") {
		const result = await request("/api/auth/register", { username, password: "a-test-password" });
		expect(result.status).toBe(201);
		return result.cookie;
	}

	async function pair(cookie: string, name = "Windows") {
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
		return { ...result.body, botId } as {
			deviceId: string;
			botId: string;
			credential: string;
		};
	}

	return {
		hub,
		request,
		register,
		pair,
		onTask,
		deliveredTasks,
	};
}

describe("Global Resource Locks", () => {
	describe("Spec and Validation", () => {
		it("validates lock keys correctly", () => {
			expect(isValidLockKey("git:owner/repo:branch")).toBe(true);
			expect(isValidLockKey("fs:/path/to/dir")).toBe(true);
			expect(isValidLockKey("db_shared-1.0")).toBe(true);

			expect(isValidLockKey("")).toBe(false);
			expect(isValidLockKey("   ")).toBe(false);
			expect(isValidLockKey("key with space")).toBe(false);
			expect(isValidLockKey("key@invalid!")).toBe(false);
			expect(isValidLockKey("a".repeat(257))).toBe(false);
		});

		it("validates and normalizes resourceLocks array", () => {
			expect(validateResourceLocks(undefined)).toEqual([]);
			expect(validateResourceLocks(null)).toEqual([]);
			expect(validateResourceLocks([])).toEqual([]);

			expect(validateResourceLocks(["lock:1", "lock:1", "lock:2"])).toEqual(["lock:1", "lock:2"]);

			const eleven = Array.from({ length: 11 }, (_, i) => `lock:${i}`);
			expect(() => validateResourceLocks(eleven)).toThrow(/cannot exceed 10 items/);

			expect(() => validateResourceLocks(["valid", "invalid key"])).toThrow(/Invalid resource lock key/);
			expect(() => validateResourceLocks("not-an-array" as any)).toThrow(/must be an array/);
		});
	});

	describe("HubLockManager unit tests", () => {
		it("manages acquire, conflict, and release FIFO correctly", () => {
			const manager = new HubLockManager({ defaultTtlMs: 60000 });

			const r1 = manager.acquireLocks({
				roomId: "room1",
				taskId: "task1",
				botId: "bot1",
				resourceLocks: ["git:repo:main"],
			});
			expect(r1.success).toBe(true);

			const r2 = manager.acquireLocks({
				roomId: "room1",
				taskId: "task2",
				botId: "bot2",
				resourceLocks: ["git:repo:main"],
			});
			expect(r2.success).toBe(false);
			expect(r2.conflictingLocks).toEqual(["git:repo:main"]);
			expect(r2.holderTaskIds).toEqual(["task1"]);

			const info = manager.getRoomLockInfo("room1");
			expect(info.activeLocks).toHaveLength(1);
			expect(info.activeLocks[0].taskId).toBe("task1");
			expect(info.waitingQueue).toHaveLength(1);
			expect(info.waitingQueue[0].taskId).toBe("task2");

			const promoted = manager.releaseLocks("room1", "task1");
			expect(promoted).toEqual(["task2"]);

			const infoAfter = manager.getRoomLockInfo("room1");
			expect(infoAfter.activeLocks).toHaveLength(1);
			expect(infoAfter.activeLocks[0].taskId).toBe("task2");
			expect(infoAfter.waitingQueue).toHaveLength(0);
		});

		it("auto expires locks after TTL", () => {
			const manager = new HubLockManager({ defaultTtlMs: 1000 });
			const now = Date.now();

			manager.acquireLocks({
				roomId: "room1",
				taskId: "task1",
				botId: "bot1",
				resourceLocks: ["shared:lock"],
				now,
			});

			manager.acquireLocks({
				roomId: "room1",
				taskId: "task2",
				botId: "bot2",
				resourceLocks: ["shared:lock"],
				now,
			});

			const promoted = manager.cleanupExpiredLocks("room1", now + 1500);
			expect(promoted).toEqual(["task2"]);

			const info = manager.getRoomLockInfo("room1", now + 1500);
			expect(info.activeLocks).toHaveLength(1);
			expect(info.activeLocks[0].taskId).toBe("task2");
			expect(info.waitingQueue).toHaveLength(0);
		});

		it("renewLocks extends TTL for running task; expired lock with alive holder is renewed not promoted", () => {
			const manager = new HubLockManager({ defaultTtlMs: 1000 });
			const now = Date.now();
			manager.acquireLocks({ roomId: "room1", taskId: "task1", botId: "bot1", resourceLocks: ["repo:main"], now });
			manager.acquireLocks({ roomId: "room1", taskId: "task2", botId: "bot2", resourceLocks: ["repo:main"], now });
			// 心跳续期：task1 在 900ms 时续一次，锁到期点延到 1900ms
			expect(manager.renewLocks("room1", "task1", now + 900)).toEqual(["repo:main"]);
			// 1500ms 时 task1 的锁尚未到期（1900），task2 仍需等待，不晋升
			expect(manager.cleanupExpiredLocks("room1", now + 1500)).toEqual([]);
			expect(manager.getRoomLockInfo("room1", now + 1500).activeLocks[0]?.taskId).toBe("task1");
			// 2000ms 时锁到期，但持锁任务仍存活 → 续期而非摘锁晋升
			expect(manager.cleanupExpiredLocks("room1", now + 2000, (id) => id === "task1")).toEqual([]);
			const info = manager.getRoomLockInfo("room1", now + 2000);
			expect(info.activeLocks).toHaveLength(1);
			expect(info.activeLocks[0]?.taskId).toBe("task1");
			expect(info.waitingQueue).toHaveLength(1);
			// 持锁任务已死 → 正常摘锁并晋升等待者
			expect(manager.cleanupExpiredLocks("room1", now + 3500, () => false)).toEqual(["task2"]);
		});
	});

	describe("Hub HTTP and Task Scheduling Integration", () => {
		it("intercepts invalid resourceLocks safely with 400", async () => {
			const f = await fixture();
			const cookie = await f.register();
			const dev = await f.pair(cookie, "Device-A");

			const roomRes = await f.request("/api/rooms", { name: "Test Room", botIds: [dev.botId] }, cookie);
			expect(roomRes.status).toBe(201);
			const roomId = roomRes.body.room.id;

			const res1 = await f.request(
				`/api/rooms/${roomId}/messages`,
				{
					text: "hello",
					targetBotIds: [dev.botId],
					resourceLocks: ["bad lock key with spaces"],
				},
				cookie,
			);
			expect(res1.status).toBe(400);

			const res2 = await f.request(
				`/api/rooms/${roomId}/messages`,
				{
					text: "hello",
					targetBotIds: [dev.botId],
					resourceLocks: Array.from({ length: 11 }, (_, i) => `lock:${i}`),
				},
				cookie,
			);
			expect(res2.status).toBe(400);
		});

		it("blocks second cross-device task on conflict and wakes it when first completes", async () => {
			const f = await fixture();
			const cookie = await f.register();

			const devA = await f.pair(cookie, "Device-A");

			const devB = await f.pair(cookie, "Device-B");

			const roomRes = await f.request("/api/rooms", { name: "Collab Room", botIds: [devA.botId, devB.botId] }, cookie);
			expect(roomRes.status).toBe(201);
			const roomId = roomRes.body.room.id;

			const lockKey = "git:org/repo:feature";

			const task1Res = await f.request(
				`/api/rooms/${roomId}/messages`,
				{
					text: "Task 1 for Bot A",
					targetBotIds: [devA.botId],
					resourceLocks: [lockKey],
				},
				cookie,
			);
			expect(task1Res.status).toBe(200);
			const task1 = task1Res.body.tasks[0];
			expect(task1.status).toBe("queued");
			expect(f.onTask).toHaveBeenCalledTimes(1);
			expect(f.deliveredTasks[0].id).toBe(task1.id);

			const task2Res = await f.request(
				`/api/rooms/${roomId}/messages`,
				{
					text: "Task 2 for Bot B",
					targetBotIds: [devB.botId],
					resourceLocks: [lockKey],
				},
				cookie,
			);
			expect(task2Res.status).toBe(200);
			const task2 = task2Res.body.tasks[0];
			expect(task2.status).toBe("waiting");
			expect(task2.blockReason).toBe("resource_locked");
			expect(f.onTask).toHaveBeenCalledTimes(1);

			const locksRes = await f.request(`/api/rooms/${roomId}/locks`, undefined, cookie);
			expect(locksRes.status).toBe(200);
			const lockInfo: RoomLockInfo = locksRes.body;
			expect(lockInfo.activeLocks).toHaveLength(1);
			expect(lockInfo.activeLocks[0].lockKey).toBe(lockKey);
			expect(lockInfo.activeLocks[0].taskId).toBe(task1.id);
			expect(lockInfo.waitingQueue).toHaveLength(1);
			expect(lockInfo.waitingQueue[0].taskId).toBe(task2.id);

			const task1Lease = f.hub.store.snapshot().tasks.find((task) => task.id === task1.id)!;
			await f.hub.acceptTaskEvent(devA.deviceId, {
				leaseToken: task1Lease.leaseToken,
				leaseGeneration: task1Lease.leaseGeneration,
				taskId: task1.id,
				attemptId: task1.attemptId,
				botId: devA.botId,
				status: "running",
			});
			await f.hub.acceptTaskEvent(devA.deviceId, {
				leaseToken: task1Lease.leaseToken,
				leaseGeneration: task1Lease.leaseGeneration,
				taskId: task1.id,
				attemptId: task1.attemptId,
				botId: devA.botId,
				status: "completed",
				report: "Task 1 finished successfully",
			});

			expect(f.onTask).toHaveBeenCalledTimes(2);
			expect(f.deliveredTasks[1].id).toBe(task2.id);

			const locksResAfter = await f.request(`/api/rooms/${roomId}/locks`, undefined, cookie);
			expect(locksResAfter.status).toBe(200);
			expect(locksResAfter.body.activeLocks).toHaveLength(1);
			expect(locksResAfter.body.activeLocks[0].taskId).toBe(task2.id);
			expect(locksResAfter.body.waitingQueue).toHaveLength(0);

			const task2Lease = f.hub.store.snapshot().tasks.find((task) => task.id === task2.id)!;
			await f.hub.acceptTaskEvent(devB.deviceId, {
				leaseToken: task2Lease.leaseToken,
				leaseGeneration: task2Lease.leaseGeneration,
				taskId: task2.id,
				attemptId: task2.attemptId,
				botId: devB.botId,
				status: "running",
			});
			await f.hub.acceptTaskEvent(devB.deviceId, {
				leaseToken: task2Lease.leaseToken,
				leaseGeneration: task2Lease.leaseGeneration,
				taskId: task2.id,
				attemptId: task2.attemptId,
				botId: devB.botId,
				status: "completed",
				report: "Task 2 finished successfully",
			});

			const locksResFinal = await f.request(`/api/rooms/${roomId}/locks`, undefined, cookie);
			expect(locksResFinal.body.activeLocks).toHaveLength(0);
			expect(locksResFinal.body.waitingQueue).toHaveLength(0);
		});

		it("wakes waiting task when first task fails", async () => {
			const f = await fixture();
			const cookie = await f.register();

			const devA = await f.pair(cookie, "Device-A");
			const devB = await f.pair(cookie, "Device-B");

			const roomRes = await f.request("/api/rooms", { name: "Room", botIds: [devA.botId, devB.botId] }, cookie);
			expect(roomRes.status).toBe(201);
			const roomId = roomRes.body.room.id;

			const lockKey = "fs:/shared/workspace";

			const t1Res = await f.request(
				`/api/rooms/${roomId}/messages`,
				{ text: "t1", targetBotIds: [devA.botId], resourceLocks: [lockKey] },
				cookie,
			);
			const task1 = t1Res.body.tasks[0];

			const t2Res = await f.request(
				`/api/rooms/${roomId}/messages`,
				{ text: "t2", targetBotIds: [devB.botId], resourceLocks: [lockKey] },
				cookie,
			);
			const task2 = t2Res.body.tasks[0];
			expect(task2.status).toBe("waiting");

			const task1Lease = f.hub.store.snapshot().tasks.find((task) => task.id === task1.id)!;
			await f.hub.acceptTaskEvent(devA.deviceId, {
				leaseToken: task1Lease.leaseToken,
				leaseGeneration: task1Lease.leaseGeneration,
				taskId: task1.id,
				attemptId: task1.attemptId,
				botId: devA.botId,
				status: "running",
			});
			await f.hub.acceptTaskEvent(devA.deviceId, {
				leaseToken: task1Lease.leaseToken,
				leaseGeneration: task1Lease.leaseGeneration,
				taskId: task1.id,
				attemptId: task1.attemptId,
				botId: devA.botId,
				status: "failed",
				report: "Failed due to compile error",
			});

			expect(f.onTask).toHaveBeenCalledTimes(2);
			expect(f.deliveredTasks[1].id).toBe(task2.id);

			const lockInfo = (await f.request(`/api/rooms/${roomId}/locks`, undefined, cookie)).body;
			expect(lockInfo.activeLocks[0].taskId).toBe(task2.id);
		});

		it("safely releases locks on conversation stop and room clear", async () => {
			const f = await fixture();
			f.hub.setRelay({ cancelTask: async () => ({ stopped: true }) });
			const cookie = await f.register();

			const devA = await f.pair(cookie, "Device-A");

			const roomRes = await f.request("/api/rooms", { name: "Room", botIds: [devA.botId] }, cookie);
			expect(roomRes.status).toBe(201);
			const roomId = roomRes.body.room.id;

			const convRes = await f.request(
				`/api/rooms/${roomId}/conversations`,
				{
					text: "Initial message",
					targetBotId: devA.botId,
					resourceLocks: ["git:repo:branch"],
				},
				cookie,
			);
			expect(convRes.status).toBe(200);
			const convId = convRes.body.conversation.id;

			let locksRes = await f.request(`/api/rooms/${roomId}/locks`, undefined, cookie);
			expect(locksRes.body.activeLocks).toHaveLength(1);

			const stopRes = await f.request(`/api/rooms/${roomId}/conversations/${convId}/stop`, {}, cookie);
			expect(stopRes.status).toBe(200);

			locksRes = await f.request(`/api/rooms/${roomId}/locks`, undefined, cookie);
			expect(locksRes.body.activeLocks).toHaveLength(0);

			const clearRes = await f.request(`/api/rooms/${roomId}/clear`, {}, cookie);
			expect(clearRes.status).toBe(200);

			locksRes = await f.request(`/api/rooms/${roomId}/locks`, undefined, cookie);
			expect(locksRes.body.activeLocks).toHaveLength(0);
			expect(locksRes.body.waitingQueue).toHaveLength(0);
		});
	});

	describe("device_collab tool resourceLocks parameter", () => {
		const context = (cwd = "/project", sessionId = "session-a") =>
			({ cwd, sessionManager: { getSessionId: () => sessionId } }) as any;
		const invoke = (input: unknown) =>
			makeDeviceCollabTool().execute("call", input as DeviceCollabInput, undefined, undefined, context());

		it("supports resourceLocks in send_task and conversation_send", async () => {
			const execute = vi.fn().mockResolvedValue({ id: "task-1" });
			setDeviceCollabService({ execute });

			await invoke({
				action: "send_task",
				roomId: "room-1",
				sourceBotId: "bot-1",
				targetBotId: "bot-2",
				prompt: "Do work",
				parentTaskId: "parent-1",
				resourceLocks: ["git:repo:branch", "fs:/path"],
			});
			expect(execute).toHaveBeenCalledTimes(1);
			expect(execute.mock.calls[0][1].resourceLocks).toEqual(["git:repo:branch", "fs:/path"]);

			await invoke({
				action: "conversation_send",
				roomId: "room-1",
				sourceBotId: "bot-1",
				conversationId: "conv-1",
				message: "Update",
				parentTaskId: "parent-1",
				resourceLocks: ["git:repo:branch"],
			});
			expect(execute).toHaveBeenCalledTimes(2);
			expect(execute.mock.calls[1][1].resourceLocks).toEqual(["git:repo:branch"]);
		});

		it("rejects resourceLocks on unsupported actions or invalid values", async () => {
			const execute = vi.fn().mockResolvedValue({});
			setDeviceCollabService({ execute });

			await expect(
				invoke({
					action: "list_bots",
					roomId: "room-1",
					sourceBotId: "bot-1",
					resourceLocks: ["git:repo:branch"],
				} as any),
			).rejects.toThrow(/Unsupported device_collab argument/);

			await expect(
				invoke({
					action: "send_task",
					roomId: "room-1",
					sourceBotId: "bot-1",
					targetBotId: "bot-2",
					prompt: "Do work",
					parentTaskId: "parent-1",
					resourceLocks: ["invalid lock key with space"],
				}),
			).rejects.toThrow(/Invalid resource lock key/);
		});
	});
});
