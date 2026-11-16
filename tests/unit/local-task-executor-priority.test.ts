import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceHubStore, hashSecret, type HubState, type HubTask } from "../../server/device-center/store.js";
import { createDeviceHub } from "../../server/device-center/hub.js";
import type { LocalTaskExecutor } from "../../server/device-center/hub.js";

/**
 * Hub 的投递优先级：本机设备的任务必须走直调，不再经 relay（WS）。
 * 这条守卫防止有人把 `deliverTask` 的 `localFor(...)` 分支改回去——那样本机私聊又会
 * 退化回"派发成功、执行端静默不动"的老路。
 */

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

function task(fields: Partial<HubTask> = {}): HubTask {
	return {
		id: "task-1",
		attemptId: "attempt-1",
		roomId: "room",
		accountId: "account",
		deviceId: "device",
		botId: "bot",
		botRevision: 1,
		text: "hi",
		status: "queued",
		createdAt: 1,
		updatedAt: 1,
		...fields,
	};
}

function state(tasks: HubTask[], rooms?: HubState["rooms"]): HubState {
	return {
		accounts: [{ id: "account", username: "owner", passwordHash: "hash", createdAt: 1 }],
		devices: [
			{
				id: "device",
				accountId: "account",
				name: "device",
				credentialHash: hashSecret("credential"),
				uiCredentialHash: hashSecret("ui-credential"),
				createdAt: 1,
			},
		],
		bots: [
			{
				id: "bot",
				accountId: "account",
				deviceId: "device",
				name: "bot",
				description: "",
				enabled: true,
				revision: 1,
				createdAt: 1,
				updatedAt: 1,
			},
		],
		rooms: rooms ?? [{ id: "room", accountId: "account", name: "room", botIds: ["bot"], createdAt: 1 }],
		tasks,
		messages: [],
		conversations: [],
		conversationMessages: [],
		receipts: [],
	} as unknown as HubState;
}

async function hubWith(
	tasks: HubTask[],
	relayOnTask = vi.fn(async () => true),
	build: (tasks: HubTask[]) => HubState = state,
) {
	const dir = await mkdtemp(join(tmpdir(), "local-executor-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const store = await DeviceHubStore.open(dir);
	await store.transact((draft) => Object.assign(draft, build(tasks)));
	await store.close();
	const hub = await createDeviceHub({ dataDir: dir, publicUrl: "http://127.0.0.1:8997" });
	hub.setRelay({ onTask: relayOnTask });
	cleanup.push(() => hub.close());
	return { hub, relayOnTask };
}

describe("本机设备直调优先于 relay", () => {
	it("投递走 localExecutor，跑完后由它把终态写回 Hub", async () => {
		const { hub, relayOnTask } = await hubWith([task()]);
		const delivered: string[] = [];
		const local: LocalTaskExecutor = {
			deviceId: "device",
			async onTask(deviceId, wire) {
				expect(deviceId).toBe("device");
				delivered.push(wire.id);
				// 与 local-task-bridge 一致：认领 → 执行 → 终态。
				await hub.acceptTaskEvent("device", {
					taskId: wire.id,
					attemptId: wire.attemptId,
					botId: wire.botId,
					status: "running",
					leaseToken: wire.leaseToken,
					leaseGeneration: wire.leaseGeneration,
				} as never);
				await hub.acceptTaskEvent("device", {
					taskId: wire.id,
					attemptId: wire.attemptId,
					botId: wire.botId,
					status: "completed",
					report: "直调完成",
					leaseToken: wire.leaseToken,
					leaseGeneration: wire.leaseGeneration,
				} as never);
				return true;
			},
			async cancelTask() {
				return { stopped: true };
			},
		};
		hub.setLocalTaskExecutor(local);
		await hub.resumeQueuedTasks();
		await vi.waitFor(() => expect(hub.store.snapshot().tasks[0]?.status).toBe("completed"));
		expect(delivered).toEqual(["task-1"]);
		expect(relayOnTask).not.toHaveBeenCalled();
		expect(hub.store.snapshot().tasks[0]?.report).toBe("直调完成");
	});

	it("群聊扇出同样走直调：两个 Bot 的任务都经本机执行器，relay 一次都不碰", async () => {
		const rooms = [{ id: "room", accountId: "account", name: "group", botIds: ["bot", "bot-2"], createdAt: 1 }];
		const build = (tasks: HubTask[]) => {
			const base = state(tasks, rooms);
			base.bots.push({
				id: "bot-2",
				accountId: "account",
				deviceId: "device",
				name: "bot-2",
				description: "",
				enabled: true,
				revision: 1,
				createdAt: 1,
				updatedAt: 1,
			});
			// 群内消息：两个 Bot 各一条任务（Hub 会按 Bot 串行派发）
			for (const botId of ["bot", "bot-2"]) {
				(base as unknown as { tasks: HubTask[] }).tasks.push(
					task({
						id: `task-${botId}`,
						attemptId: `attempt-${botId}`,
						botId,
						status: "queued",
						queuePriority: 1,
						origin: "human",
					}),
				);
			}
			return base;
		};
		const { hub, relayOnTask } = await hubWith(
			[],
			vi.fn(async () => true),
			build,
		);
		const delivered: string[] = [];
		hub.setLocalTaskExecutor({
			deviceId: "device",
			async onTask(_deviceId, wire) {
				delivered.push(wire.botId);
				await hub.acceptTaskEvent("device", {
					taskId: wire.id,
					attemptId: wire.attemptId,
					botId: wire.botId,
					status: "running",
					leaseToken: wire.leaseToken,
					leaseGeneration: wire.leaseGeneration,
				} as never);
				await hub.acceptTaskEvent("device", {
					taskId: wire.id,
					attemptId: wire.attemptId,
					botId: wire.botId,
					status: "completed",
					report: `${wire.botId} 完成`,
					leaseToken: wire.leaseToken,
					leaseGeneration: wire.leaseGeneration,
				} as never);
				return true;
			},
		});
		await hub.resumeQueuedTasks();
		await vi.waitFor(() =>
			expect(hub.store.snapshot().tasks.every((entry) => entry.status === "completed")).toBe(true),
		);
		expect(delivered.sort()).toEqual(["bot", "bot-2"]);
		expect(relayOnTask).not.toHaveBeenCalled();
	});

	it("本机执行器只认自己的设备，别的设备继续走 relay", async () => {
		const other = task({ id: "task-2", attemptId: "attempt-2", deviceId: "device-2" });
		const local = { deviceId: "device", onTask: vi.fn(async () => true) } satisfies LocalTaskExecutor;
		const { hub, relayOnTask } = await hubWith([other]);
		hub.setLocalTaskExecutor(local);
		await hub.resumeQueuedTasks();
		expect(local.onTask).not.toHaveBeenCalled();
		// 设备不存在于 state 里 → 投递会被拒绝并落成失败终态（relay 仍被优先之外的路径尝试过）。
		await vi.waitFor(() => expect(relayOnTask).toHaveBeenCalled());
	});
});
