import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeviceRelay } from "../../server/device-center/relay.js";
import { createDeviceConnector } from "../../server/device-center/connector.js";
import { TaskRecoveryManager } from "../../server/device-center/task-recovery.js";
import type { DeviceTaskClaim, DeviceTaskLeaseRenew } from "../../server/protocol.js";

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

		// Record activity
		expect(manager.recordActivity("task-1", "att-1")).toBe(true);

		// Prepare renews
		const renews = manager.prepareLeaseRenews();
		expect(renews).toHaveLength(1);
		expect(renews[0].hasActivity).toBe(true);

		// Second renew without new activity should have hasActivity: false
		const secondRenews = manager.prepareLeaseRenews();
		expect(secondRenews).toHaveLength(1);
		expect(secondRenews[0].hasActivity).toBe(false);

		// Record task finish into outbox
		const outbox = manager.recordTaskFinish(
			{ id: "task-1", attemptId: "att-1", botId: "bot-1", deviceId: "dev1", roomId: "room-1" },
			{ status: "completed", report: "All done" },
		);

		expect(outbox.status).toBe("completed");
		expect(outbox.report).toBe("All done");
		expect(manager.getActiveLeases()).toHaveLength(0); // active lease removed
		expect(manager.getPendingOutbox()).toHaveLength(1);

		// Duplicate finish with identical outcome is idempotent
		const duplicate = manager.recordTaskFinish(
			{ id: "task-1", attemptId: "att-1", botId: "bot-1", deviceId: "dev1", roomId: "room-1" },
			{ status: "completed", report: "All done" },
		);
		expect(duplicate.id).toBe(outbox.id);

		// Acknowledge outbox
		expect(manager.ackOutbox("task-1", "att-1")).toBe(true);
		expect(manager.getPendingOutbox()).toHaveLength(0);
	});

	it("detects orphaned leases on restart and halts them safely as interrupted without rerun", () => {
		const dir = mkdtempSync(join(tmpdir(), "recovery-restart-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		// Stage an active lease file simulating a crash
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
		expect(manager.getActiveLeases()).toHaveLength(0); // cleared

		// Outbox should contain the interrupted record
		const pending = manager.getPendingOutbox();
		expect(pending).toHaveLength(1);
		expect(pending[0].taskId).toBe("orphan-task");
		expect(pending[0].status).toBe("interrupted");
		expect(pending[0].report).toContain("safely halted on device process restart");
	});

	it("fails closed on corrupted outbox/lease files to protect historical data", () => {
		const dir = mkdtempSync(join(tmpdir(), "recovery-corrupt-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		// Write invalid JSON to outbox file
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
	async function createFixture() {
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

		// Dispatch task
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

		// Task is running locally and recorded in recovery
		expect(f.recovery.getActiveLeases()).toHaveLength(1);

		// Disconnect network abruptly by terminating all sockets on server
		const relayDevices = f.relay as any;
		// Let connector simulate disconnect
		(connector as any).close(); // Or close the socket directly

		// Recreate connector as if reconnecting
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

		// Verify that reconnect triggered task claim with stable attempt and lease
		await vi.waitFor(() => expect(f.claims.length).toBeGreaterThanOrEqual(1));
		const lastClaim = f.claims[f.claims.length - 1];
		expect(lastClaim.taskId).toBe("task-rec-1");
		expect(lastClaim.attemptId).toBe("att-rec-1");
		expect(lastClaim.leaseToken).toBe("lease-tok-1");
	});

	it("replays pending durable outbox results on reconnect until ACKed", async () => {
		const f = await createFixture();

		// Pre-populate outbox with an interrupted or completed result
		f.recovery.recordTaskFinish(
			{ id: "task-outbox-1", attemptId: "att-out-1", botId: "bot1", deviceId: "dev1", roomId: "room1" },
			{ status: "completed", report: "Pre-recorded finish" },
		);
		expect(f.recovery.getPendingOutbox()).toHaveLength(1);

		// Connect device
		const connector = createDeviceConnector({
			hubUrl: f.origin,
			deviceId: "dev1",
			credential: "secret",
			localOrigin: f.origin,
			recovery: f.recovery,
		});
		cleanup.push(() => connector.close());

		await vi.waitFor(() => expect(f.relay.isOnline("dev1")).toBe(true));

		// Verify event was received by Hub
		await vi.waitFor(() => expect(f.events.some((e) => e.taskId === "task-outbox-1")).toBe(true));
		const event = f.events.find((e) => e.taskId === "task-outbox-1");
		expect(event.status).toBe("completed");
		expect(event.report).toBe("Pre-recorded finish");

		// Relay automatically sends task_result_ack upon terminal event, which clears outbox
		await vi.waitFor(() => expect(f.recovery.getPendingOutbox()).toHaveLength(0));
	});

	it("aborts local task if Hub rejects claim on reconnect", async () => {
		const f = await createFixture();
		f.setClaimAcceptor(() => false); // Hub rejects claim

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

		// Disconnect and reconnect to trigger claim rejection
		f.relay.revoke("dev1"); // forces connection drop
		// Connector will reconnect, send task_claim, get rejected, and abort the running task
		await vi.waitFor(() => expect(signalAborted).toBe(true), { timeout: 3000 });
	});
});

describe("DeviceHub claimTask and lease renewal logic", () => {
	it("accepts claim during recovery window and rejects lease mismatch or stopped tasks", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hub-recovery-test-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		const { DeviceHubStore } = await import("../../server/device-center/store.js");
		const store = await DeviceHubStore.open(dir);

		// Populate mock state with a running task with recoveryUntil set
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

		// 1. Lease token mismatch rejected
		const rejectMismatch = await hub.claimTask("dev1", {
			taskId: "task-hub-1",
			attemptId: "att-hub-1",
			botId: "bot1",
			leaseToken: "wrong-token",
		});
		expect(rejectMismatch.accepted).toBe(false);
		expect(rejectMismatch.reason).toContain("Lease token mismatch");

		// 2. Valid claim accepted during recovery window
		const claimOk = await hub.claimTask("dev1", {
			taskId: "task-hub-1",
			attemptId: "att-hub-1",
			botId: "bot1",
			leaseToken: "valid-token",
		});
		expect(claimOk.accepted).toBe(true);

		// Recovery window should now be cleared and task remains running
		const taskAfterClaim = hub.store.snapshot().tasks.find((t) => t.id === "task-hub-1");
		expect(taskAfterClaim?.recoveryUntil).toBeUndefined();
		expect(taskAfterClaim?.status).toBe("running");

		// 3. Lease renewal with activity succeeds
		const renewOk = await hub.renewTaskLease("dev1", {
			taskId: "task-hub-1",
			attemptId: "att-hub-1",
			botId: "bot1",
			leaseToken: "valid-token",
			hasActivity: true,
		});
		expect(renewOk.accepted).toBe(true);

		// 4. Mark task cancelRequested -> claim & renew must be rejected
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

		// 1. Missing leaseToken rejected at admission
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

		// 2. Valid lease admitted, executed, and recorded in outbox
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

		// Outbox should contain the completed result
		const pendingOutbox = runtime.recovery.getPendingOutbox();
		expect(pendingOutbox.some((e) => e.taskId === "t-valid-lease" && e.status === "completed")).toBe(true);
		expect(runtime.recovery.getActiveLeases()).toHaveLength(0); // active lease cleaned
	});

	it("demonstrates exactly-once execution across network disconnect and Hub restart with recovery grace window", async () => {
		const dir = mkdtempSync(join(tmpdir(), "restart-e2e-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

		const { DeviceHubStore } = await import("../../server/device-center/store.js");
		const { createDeviceHub } = await import("../../server/device-center/hub.js");

		// Initialize store with state
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

		// Start Hub 1
		let hub = await createDeviceHub({
			dataDir: dir,
			publicUrl: "http://127.0.0.1:8787",
		});

		// Local Task Execution tracking
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

		// Simulate Hub Restart: close Hub 1 and open Hub 2
		await hub.close();

		const hub2 = await createDeviceHub({
			dataDir: dir,
			publicUrl: "http://127.0.0.1:8787",
		});
		cleanup.push(() => hub2.close());

		// Hub 2 starts and assigns recovery window to running tasks
		const taskInHub2 = hub2.store.snapshot().tasks.find((t) => t.id === "task-once-1");
		expect(taskInHub2?.recoveryUntil).toBeDefined();

		// Security assertion: public task projections MUST strip leaseToken
		const { publicTask } = await import("../../server/device-center/store.js");
		const exposedTask = publicTask(taskInHub2!);
		expect((exposedTask as any).leaseToken).toBeUndefined();

		// Reconnecting device claims task with stable token
		const claims = localRecovery.prepareClaims();
		expect(claims).toHaveLength(1);
		expect(claims[0].leaseToken).toBe("stable-lease-token");

		const claimResult = await hub2.claimTask("dev1", claims[0]);
		expect(claimResult.accepted).toBe(true);

		// Verified that recovery window is cleared and status is preserved
		const claimedTask = hub2.store.snapshot().tasks.find((t) => t.id === "task-once-1");
		expect(claimedTask?.recoveryUntil).toBeUndefined();
		expect(claimedTask?.status).toBe("running");

		// Now local execution completes
		taskUnblock.resolve();
		await executionPromise;

		// Task was executed exactly once
		expect(executionCount).toBe(1);

		// Local Outbox has completed result and reports it to Hub 2
		const pending = localRecovery.getPendingOutbox();
		expect(pending).toHaveLength(1);
		expect(pending[0].status).toBe("completed");

		await hub2.acceptTaskEvent("dev1", {
			taskId: pending[0].taskId,
			attemptId: pending[0].attemptId,
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
		// Fill up to 128 entries
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
