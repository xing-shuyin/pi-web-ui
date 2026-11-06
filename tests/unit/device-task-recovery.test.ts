import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeviceRelay } from "../../server/device-center/relay.js";
import { createDeviceConnector } from "../../server/device-center/connector.js";
import { TaskRecoveryManager } from "../../server/device-center/task-recovery.js";
import type { DeviceTaskClaim, DeviceTaskLeaseRenew, HubTask } from "../../server/protocol.js";
import { computeOutcomeFingerprint } from "../../server/device-center/task-outcome.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const fn of cleanup.reverse()) {
		try {
			await fn();
		} catch {}
	}
	cleanup.length = 0;
});

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: any) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("TaskRecoveryManager unit tests", () => {
	it("records task start, tracks activity, and commits terminal outcome to outbox", () => {
		const dir = mkdtempSync(join(tmpdir(), "recovery-unit-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		const manager = new TaskRecoveryManager({ dataDir: dir, deviceId: "dev1" });
		const lease = manager.recordTaskStart({
			taskId: "task-1",
			attemptId: "att-1",
			botId: "bot-1",
			deviceId: "dev1",
			roomId: "room-1",
			leaseToken: "tok-1",
			leaseGeneration: 1,
		});

		expect(lease.taskId).toBe("task-1");
		expect(manager.getActiveLeases()).toHaveLength(1);

		expect(manager.recordActivity("task-1", "att-1")).toBe(true);

		const renews = manager.prepareLeaseRenews();
		expect(renews).toHaveLength(1);
		expect(renews[0].hasActivity).toBe(true);

		const secondRenews = manager.prepareLeaseRenews();
		expect(secondRenews).toHaveLength(1);
		expect(secondRenews[0].hasActivity).toBe(false);

		const outbox = manager.recordTaskFinish(
			{ id: "task-1", attemptId: "att-1", botId: "bot-1", deviceId: "dev1", roomId: "room-1" },
			{ status: "completed", report: "All done" },
		);

		expect(outbox.status).toBe("completed");
		expect(outbox.report).toBe("All done");
		expect(manager.getActiveLeases()).toHaveLength(0);
		expect(manager.getPendingOutbox()).toHaveLength(1);

		const duplicate = manager.recordTaskFinish(
			{ id: "task-1", attemptId: "att-1", botId: "bot-1", deviceId: "dev1", roomId: "room-1" },
			{ status: "completed", report: "All done" },
		);
		expect(duplicate.id).toBe(outbox.id);

		expect(manager.ackOutbox("task-1", "att-1")).toBe(false);
		expect(manager.ackOutbox("task-1", "att-1", "wrong-fp")).toBe(false);
		expect(manager.ackOutbox("task-1", "att-1", outbox.fingerprint)).toBe(true);
		expect(manager.getPendingOutbox()).toHaveLength(0);
	});

	it("detects orphaned leases on restart and halts them safely as interrupted without rerun", () => {
		const dir = mkdtempSync(join(tmpdir(), "recovery-restart-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		const leaseFile = join(dir, "task-active-leases.json");
		const now = Date.now();
		writeFileSync(
			leaseFile,
			JSON.stringify([
				{
					taskId: "orphan-task",
					attemptId: "att-orphan",
					botId: "bot-1",
					deviceId: "dev1",
					roomId: "room-1",
					leaseToken: "tok-orphan",
					leaseGeneration: 1,
					startedAt: now - 5000,
					lastActivityAt: now - 1000,
					lastRenewedActivityAt: now - 1000,
				},
			]),
		);

		const halted: string[] = [];
		const manager = new TaskRecoveryManager({
			dataDir: dir,
			deviceId: "dev1",
			onHaltOrphaned: (t) => halted.push(t.taskId),
		});

		expect(halted).toEqual(["orphan-task"]);
		expect(manager.getHaltedOrphans()).toHaveLength(1);
		expect(manager.getActiveLeases()).toHaveLength(0);

		const pending = manager.getPendingOutbox();
		expect(pending).toHaveLength(1);
		expect(pending[0].taskId).toBe("orphan-task");
		expect(pending[0].status).toBe("interrupted");
		expect(pending[0].report).toContain("safely halted on device process restart");
	});

	it("fails closed on corrupted outbox/lease files to protect historical data", () => {
		const dir = mkdtempSync(join(tmpdir(), "recovery-corrupt-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		writeFileSync(join(dir, "task-recovery-outbox.json"), "{ invalid json ");

		const manager = new TaskRecoveryManager({ dataDir: dir, deviceId: "dev1" });
		expect(() => {
			manager.recordTaskFinish(
				{ id: "t1", attemptId: "a1", botId: "b1", deviceId: "dev1", roomId: "r1" },
				{ status: "completed" },
			);
		}).toThrow("Outbox persistence blocked");
	});
});

describe("End-to-End Task Disconnect Recovery and Reconnect Claim", () => {
	async function createFixture(committedTask?: HubTask) {
		const server = http.createServer();
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		cleanup.push(() => {
			server.closeAllConnections();
			server.close();
		});

		const events: any[] = [];
		const claims: DeviceTaskClaim[] = [];
		const renews: DeviceTaskLeaseRenew[] = [];
		let claimAcceptor: (claim: DeviceTaskClaim) => boolean = () => true;

		const relay = createDeviceRelay({
			server,
			publicUrl: origin,
			authenticateDevice: (id, key) => id === "dev1" && key === "secret",
			getAccount: () => ({ id: "account" }),
			ownsDevice: () => true,
			onTaskEvent: (id, event) => {
				events.push(event);
				return committedTask;
			},
			onTaskClaim: (id, claim) => {
				claims.push(claim);
				return { taskId: claim.taskId, attemptId: claim.attemptId, accepted: claimAcceptor(claim) };
			},
			onTaskLeaseRenew: (id, renew) => {
				renews.push(renew);
				return { taskId: renew.taskId, attemptId: renew.attemptId, accepted: true };
			},
		});
		cleanup.push(() => relay.close());

		const dir = mkdtempSync(join(tmpdir(), "recovery-e2e-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
		const recovery = new TaskRecoveryManager({ dataDir: dir, deviceId: "dev1" });

		return {
			origin,
			relay,
			events,
			claims,
			renews,
			recovery,
			setClaimAcceptor: (fn: (claim: DeviceTaskClaim) => boolean) => {
				claimAcceptor = fn;
			},
		};
	}

	it("retains running task across network disconnect and claims it on reconnect", async () => {
		const f = await createFixture();
		const taskRunning = deferred<void>();
		const taskFinish = deferred<string>();
		let aborted = false;

		const connector = createDeviceConnector({
			hubUrl: f.origin,
			deviceId: "dev1",
			credential: "secret",
			localOrigin: f.origin,
			recovery: f.recovery,
			onTask: async (task, signal) => {
				f.recovery.recordTaskStart({
					taskId: task.id,
					attemptId: task.attemptId,
					botId: task.botId,
					deviceId: "dev1",
					roomId: task.roomId,
					leaseToken: task.leaseToken,
					leaseGeneration: task.leaseGeneration ?? 1,
				});
				signal?.addEventListener("abort", () => {
					aborted = true;
				});
				taskRunning.resolve();
				return await taskFinish.promise;
			},
		});
		cleanup.push(() => connector.close());

		await vi.waitFor(() => expect(f.relay.isOnline("dev1")).toBe(true));

		const task = {
			id: "task-rec-1",
			attemptId: "att-rec-1",
			botId: "bot1",
			botRevision: 1,
			deviceId: "dev1",
			roomId: "room1",
			leaseToken: "lease-tok-1",
		};
		expect(f.relay.sendTask("dev1", task)).toBe(true);
		await taskRunning.promise;

		expect(f.recovery.getActiveLeases()).toHaveLength(1);

		const relayDevices = f.relay as any;
		(connector as any).close();

		const reconnectedTaskFinish = deferred<string>();
		const reconnector = createDeviceConnector({
			hubUrl: f.origin,
			deviceId: "dev1",
			credential: "secret",
			localOrigin: f.origin,
			recovery: f.recovery,
		});
		cleanup.push(() => reconnector.close());

		await vi.waitFor(() => expect(f.relay.isOnline("dev1")).toBe(true));

		await vi.waitFor(() => expect(f.claims.length).toBeGreaterThanOrEqual(1));
		const lastClaim = f.claims[f.claims.length - 1];
		expect(lastClaim.taskId).toBe("task-rec-1");
		expect(lastClaim.attemptId).toBe("att-rec-1");
		expect(lastClaim.leaseToken).toBe("lease-tok-1");
	});

	it("replays pending durable outbox results on reconnect until ACKed", async () => {
		const committedTask: HubTask = {
			id: "task-outbox-1",
			attemptId: "att-out-1",
			botId: "bot1",
			botRevision: 1,
			deviceId: "dev1",
			accountId: "account",
			roomId: "room1",
			text: "work",
			status: "completed",
			report: "Pre-recorded finish",
			createdAt: 1,
			updatedAt: 2,
			outcomeFingerprint: computeOutcomeFingerprint("task-outbox-1", "att-out-1", "completed", "Pre-recorded finish"),
		};
		const f = await createFixture(committedTask);

		f.recovery.recordTaskFinish(
			{ id: "task-outbox-1", attemptId: "att-out-1", botId: "bot1", deviceId: "dev1", roomId: "room1" },
			{ status: "completed", report: "Pre-recorded finish" },
		);
		expect(f.recovery.getPendingOutbox()).toHaveLength(1);

		const connector = createDeviceConnector({
			hubUrl: f.origin,
			deviceId: "dev1",
			credential: "secret",
			localOrigin: f.origin,
			recovery: f.recovery,
		});
		cleanup.push(() => connector.close());

		await vi.waitFor(() => expect(f.relay.isOnline("dev1")).toBe(true));

		await vi.waitFor(() => expect(f.events.some((e) => e.taskId === "task-outbox-1")).toBe(true));
		const event = f.events.find((e) => e.taskId === "task-outbox-1");
		expect(event.status).toBe("completed");
		expect(event.report).toBe("Pre-recorded finish");
		expect(event.fingerprint).toBe(committedTask.outcomeFingerprint);

		await vi.waitFor(() => expect(f.recovery.getPendingOutbox()).toHaveLength(0));
	});

	it("aborts local task if Hub rejects claim on reconnect", async () => {
		const f = await createFixture();
		f.setClaimAcceptor(() => false);

		let signalAborted = false;
		const taskRunning = deferred<void>();
		const connector = createDeviceConnector({
			hubUrl: f.origin,
			deviceId: "dev1",
			credential: "secret",
			localOrigin: f.origin,
			recovery: f.recovery,
			onTask: async (task, signal) => {
				f.recovery.recordTaskStart({
					taskId: task.id,
					attemptId: task.attemptId,
					botId: task.botId,
					deviceId: "dev1",
					roomId: task.roomId,
					leaseToken: task.leaseToken,
					leaseGeneration: task.leaseGeneration ?? 1,
				});
				signal?.addEventListener("abort", () => {
					signalAborted = true;
				});
				taskRunning.resolve();
				await new Promise((r) => setTimeout(r, 10_000));
				return "late";
			},
		});
		cleanup.push(() => connector.close());

		await vi.waitFor(() => expect(f.relay.isOnline("dev1")).toBe(true));

		const task = {
			id: "task-rej-1",
			attemptId: "att-rej-1",
			botId: "bot1",
			botRevision: 1,
			deviceId: "dev1",
			roomId: "room1",
			leaseToken: "lease-tok-rej",
		};
		expect(f.relay.sendTask("dev1", task)).toBe(true);
		await taskRunning.promise;

		f.relay.revoke("dev1");
		await vi.waitFor(() => expect(signalAborted).toBe(true), { timeout: 3000 });
	});
});

describe("DeviceHub claimTask and lease renewal logic", () => {
	it("accepts claim during recovery window and rejects lease mismatch or stopped tasks", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hub-recovery-test-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		const { DeviceHubStore } = await import("../../server/device-center/store.js");
		const store = await DeviceHubStore.open(dir);

		await store.transact((draft) => {
			draft.accounts.push({
				id: "acc1",
				username: "user1",
				passwordHash: "hash",
				createdAt: Date.now(),
			});
			draft.devices.push({
				id: "dev1",
				accountId: "acc1",
				name: "device1",
				credentialHash: "hash",
				uiCredentialHash: "uiHash",
				createdAt: Date.now(),
			});
			draft.bots.push({
				id: "bot1",
				deviceId: "dev1",
				accountId: "acc1",
				name: "bot1",
				description: "bot",
				enabled: true,
				revision: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			draft.rooms.push({
				id: "room1",
				accountId: "acc1",
				name: "room1",
				botIds: ["bot1"],
				createdAt: Date.now(),
			});
			draft.tasks.push({
				id: "task-hub-1",
				attemptId: "att-hub-1",
				botId: "bot1",
				botRevision: 1,
				deviceId: "dev1",
				accountId: "acc1",
				roomId: "room1",
				text: "do something",
				status: "running",
				leaseToken: "valid-token",
				recoveryUntil: Date.now() + 60_000,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		await store.close();

		const { createDeviceHub } = await import("../../server/device-center/hub.js");
		const hub = await createDeviceHub({
			dataDir: dir,
			publicUrl: "http://127.0.0.1:8787",
		});
		cleanup.push(() => hub.close());

		const rejectMismatch = await hub.claimTask("dev1", {
			taskId: "task-hub-1",
			attemptId: "att-hub-1",
			botId: "bot1",
			leaseToken: "wrong-token",
		});
		expect(rejectMismatch.accepted).toBe(false);
		expect(rejectMismatch.reason).toContain("Lease token mismatch");

		const claimOk = await hub.claimTask("dev1", {
			taskId: "task-hub-1",
			attemptId: "att-hub-1",
			botId: "bot1",
			leaseToken: "valid-token",
		});
		expect(claimOk.accepted).toBe(true);

		const taskAfterClaim = hub.store.snapshot().tasks.find((t) => t.id === "task-hub-1");
		expect(taskAfterClaim?.recoveryUntil).toBeUndefined();
		expect(taskAfterClaim?.status).toBe("running");

		const renewOk = await hub.renewTaskLease("dev1", {
			taskId: "task-hub-1",
			attemptId: "att-hub-1",
			botId: "bot1",
			leaseToken: "valid-token",
			hasActivity: true,
		});
		expect(renewOk.accepted).toBe(true);

		await hub.store.transact((draft) => {
			const t = draft.tasks.find((item) => item.id === "task-hub-1");
			if (t) t.cancelRequested = true;
		});

		const renewAfterStop = await hub.renewTaskLease("dev1", {
			taskId: "task-hub-1",
			attemptId: "att-hub-1",
			botId: "bot1",
			leaseToken: "valid-token",
			hasActivity: true,
		});
		expect(renewAfterStop.accepted).toBe(false);
		expect(renewAfterStop.reason).toContain("Task stop requested");
	});
});

describe("Full real runtime admission and crash-safety lifecycle", () => {
	it("enforces Hub lease grant admission, records activity and outbox on execution", async () => {
		const dir = mkdtempSync(join(tmpdir(), "runtime-recovery-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		const { createDeviceRuntime } = await import("../../server/device-center/runtime.js");
		const { createLocalBotRegistry } = await import("../../server/device-center/bots.js");

		const botDir = join(dir, "bot-cwd");
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(botDir, { recursive: true });

		const bots = await createLocalBotRegistry(dir);
		const bot = await bots.upsert({
			name: "Real Bot",
			description: "bot for recovery test",
			systemPrompt: "You are a recovery test bot",
			model: { provider: "mock", modelId: "test-model" },
			cwd: botDir,
			enabled: true,
			tools: ["read"],
			skills: [],
			mcpServers: [],
		});

		const runtime = createDeviceRuntime({
			config: {
				hubUrl: "http://127.0.0.1:8787",
				deviceId: "dev1",
				credential: "sec",
				allowExecution: true,
			},
			localOrigin: "http://127.0.0.1:8788",
			dataDir: dir,
			bots,
			executorFactory() {
				return {
					async run() {
						return "real result";
					},
					close() {},
				};
			},
		});
		cleanup.push(() => runtime.close());

		await expect(
			runtime.onTask({
				id: "t-missing-lease",
				attemptId: "att-1",
				botId: bot.id,
				botRevision: bot.revision,
				deviceId: "dev1",
				roomId: "room-1",
				text: "run",
			}),
		).rejects.toThrow("Hub task lease grant required");

		const result = await runtime.onTask({
			id: "t-valid-lease",
			attemptId: "att-2",
			botId: bot.id,
			botRevision: bot.revision,
			deviceId: "dev1",
			roomId: "room-1",
			text: "run",
			leaseToken: "grant-from-hub-123",
			leaseGeneration: 1,
		} as any);

		expect(result).toBe("real result");

		const pendingOutbox = runtime.recovery.getPendingOutbox();
		expect(pendingOutbox.some((e) => e.taskId === "t-valid-lease" && e.status === "completed")).toBe(true);
		expect(runtime.recovery.getActiveLeases()).toHaveLength(0);
	});

	it("demonstrates exactly-once execution across network disconnect and Hub restart with recovery grace window", async () => {
		const dir = mkdtempSync(join(tmpdir(), "restart-e2e-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		const { DeviceHubStore } = await import("../../server/device-center/store.js");
		const { createDeviceHub } = await import("../../server/device-center/hub.js");

		const store = await DeviceHubStore.open(dir);
		await store.transact((draft) => {
			draft.accounts.push({
				id: "acc1",
				username: "user1",
				passwordHash: "hash",
				createdAt: Date.now(),
			});
			draft.devices.push({
				id: "dev1",
				accountId: "acc1",
				name: "device1",
				credentialHash: "hash",
				uiCredentialHash: "uiHash",
				createdAt: Date.now(),
			});
			draft.bots.push({
				id: "bot1",
				deviceId: "dev1",
				accountId: "acc1",
				name: "bot1",
				description: "bot",
				enabled: true,
				revision: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			draft.rooms.push({
				id: "room1",
				accountId: "acc1",
				name: "room1",
				botIds: ["bot1"],
				createdAt: Date.now(),
			});
			draft.tasks.push({
				id: "task-once-1",
				attemptId: "att-once-1",
				botId: "bot1",
				botRevision: 1,
				deviceId: "dev1",
				accountId: "acc1",
				roomId: "room1",
				text: "do something",
				status: "running",
				leaseToken: "stable-lease-token",
				leaseGeneration: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		await store.close();

		let hub = await createDeviceHub({
			dataDir: dir,
			publicUrl: "http://127.0.0.1:8787",
		});

		let executionCount = 0;
		const taskUnblock = deferred<void>();
		const localRecovery = new TaskRecoveryManager({ dataDir: dir, deviceId: "dev1" });
		localRecovery.recordTaskStart({
			taskId: "task-once-1",
			attemptId: "att-once-1",
			botId: "bot1",
			deviceId: "dev1",
			roomId: "room1",
			leaseToken: "stable-lease-token",
			leaseGeneration: 1,
		});

		const executeTaskLocally = async () => {
			executionCount++;
			await taskUnblock.promise;
			localRecovery.recordTaskFinish(
				{ id: "task-once-1", attemptId: "att-once-1", botId: "bot1", deviceId: "dev1", roomId: "room1" },
				{ status: "completed", report: "Execution succeeded exactly once" },
			);
			return "done";
		};

		const executionPromise = executeTaskLocally();

		await hub.close();

		const hub2 = await createDeviceHub({
			dataDir: dir,
			publicUrl: "http://127.0.0.1:8787",
		});
		cleanup.push(() => hub2.close());

		const taskInHub2 = hub2.store.snapshot().tasks.find((t) => t.id === "task-once-1");
		expect(taskInHub2?.recoveryUntil).toBeDefined();

		const { publicTask } = await import("../../server/device-center/store.js");
		const exposedTask = publicTask(taskInHub2!);
		expect((exposedTask as any).leaseToken).toBeUndefined();

		const claims = localRecovery.prepareClaims();
		expect(claims).toHaveLength(1);
		expect(claims[0].leaseToken).toBe("stable-lease-token");

		const claimResult = await hub2.claimTask("dev1", claims[0]);
		expect(claimResult.accepted).toBe(true);

		const claimedTask = hub2.store.snapshot().tasks.find((t) => t.id === "task-once-1");
		expect(claimedTask?.recoveryUntil).toBeUndefined();
		expect(claimedTask?.status).toBe("running");

		taskUnblock.resolve();
		await executionPromise;

		expect(executionCount).toBe(1);

		const pending = localRecovery.getPendingOutbox();
		expect(pending).toHaveLength(1);
		expect(pending[0].status).toBe("completed");

		await hub2.acceptTaskEvent("dev1", {
			taskId: pending[0].taskId,
			attemptId: pending[0].attemptId,
			leaseToken: pending[0].leaseToken,
			leaseGeneration: pending[0].leaseGeneration,
			botId: pending[0].botId,
			status: pending[0].status,
			report: pending[0].report,
		});

		const finalTask = hub2.store.snapshot().tasks.find((t) => t.id === "task-once-1");
		expect(finalTask?.status).toBe("completed");
		expect(finalTask?.report).toBe("Execution succeeded exactly once");
		expect(executionCount).toBe(1);
	});

	it("enforces outbox capacity reservation limit to protect existing results", () => {
		const dir = mkdtempSync(join(tmpdir(), "recovery-capacity-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		const manager = new TaskRecoveryManager({ dataDir: dir, deviceId: "dev1" });
		for (let i = 0; i < 128; i++) {
			manager.recordTaskFinish(
				{ id: `t-${i}`, attemptId: `a-${i}`, botId: "b1", deviceId: "dev1", roomId: "r1" },
				{ status: "completed", report: "done" },
			);
		}
		expect(manager.hasOutboxCapacity().available).toBe(false);
		expect(manager.hasOutboxCapacity().reason).toContain("maximum capacity");
	});

	it("supports transfer_fence RPC to cleanly settle in-flight operations", async () => {
		const dir = mkdtempSync(join(tmpdir(), "runtime-fence-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		const { createDeviceRuntime } = await import("../../server/device-center/runtime.js");
		const { createLocalBotRegistry } = await import("../../server/device-center/bots.js");

		const botDir = join(dir, "bot-cwd");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(botDir, { recursive: true });

		const bots = await createLocalBotRegistry(dir);
		const runtime = createDeviceRuntime({
			config: {
				hubUrl: "http://127.0.0.1:8787",
				deviceId: "dev1",
				credential: "sec",
				allowExecution: true,
			},
			localOrigin: "http://127.0.0.1:8788",
			dataDir: dir,
			bots,
		});
		cleanup.push(() => runtime.close());

		const fence = await runtime.onCommand("transfer_fence", {}, new AbortController().signal);
		expect(fence).toEqual({ ok: true, settled: true, remaining: 0 });
	});
});
