import { describe, expect, it, vi } from "vitest";
import { createBotQueueDispatcher } from "../../server/device-center/hub-task-queue.js";
import type { DeviceHubStore, HubState, HubTask } from "../../server/device-center/store.js";

/**
 * Hub 侧派发仲裁（与设备侧 DeviceTaskScheduler 分层，见 docs/device-collaboration.md）。
 * 这里用假 store 验证：只唤醒本闸门停放的任务、按优先级选下一个、Bot 忙时不派、定时器可释放。
 */

function task(id: string, botId: string, overrides: Partial<HubTask> = {}): HubTask {
	return {
		id,
		botId,
		attemptId: `attempt-${id}`,
		roomId: "room-1",
		accountId: "acc",
		deviceId: "device-1",
		text: "",
		status: "queued",
		createdAt: 1,
		updatedAt: 1,
		botRevision: 1,
		blockReason: "bot_busy",
		queuePriority: 1,
		origin: "human",
		...overrides,
	};
}

function fixture(tasks: HubTask[]) {
	let state = {
		tasks: structuredClone(tasks),
		rooms: [],
		bots: [],
		messages: [],
	} as unknown as HubState;
	const store = {
		snapshot: () => structuredClone(state),
		transact: async (update: (draft: HubState) => unknown) => {
			const draft = structuredClone(state);
			const result = update(draft);
			state = draft;
			return result;
		},
	} as unknown as DeviceHubStore;
	const delivered: string[] = [];
	const dispatcher = createBotQueueDispatcher({
		store,
		deliveredTasks: new Set<string>(),
		deliverTask: async (next) => {
			delivered.push(next.id);
		},
		taskContext: () => undefined,
	});
	return { dispatcher, delivered, store };
}

describe("Hub task queue dispatcher", () => {
	it("only wakes tasks parked by this gate", async () => {
		const { dispatcher, delivered } = fixture([
			task("parked", "bot", { blockReason: "bot_busy", queuePriority: 1 }),
			task("dependency", "bot", { blockReason: "dependency", queuePriority: 0 }),
			task("locked", "bot", { blockReason: "resource_locked", queuePriority: 0 }),
		]);
		await dispatcher.drain();
		expect(delivered).toEqual(["parked"]);
	});

	it("dispatches the highest priority first, FIFO within a priority", async () => {
		const { dispatcher, delivered } = fixture([
			task("auto", "bot", { queuePriority: 2, createdAt: 1 }),
			task("group", "bot", { queuePriority: 1, createdAt: 2 }),
			task("direct", "bot", { queuePriority: 0, createdAt: 3 }),
		]);
		await dispatcher.drain();
		expect(delivered).toEqual(["direct"]);
	});

	it("does not dispatch while the Bot still owns an active task", async () => {
		const { dispatcher, delivered } = fixture([
			task("running", "bot", { status: "running", blockReason: undefined }),
			task("next", "bot", { blockReason: "bot_busy" }),
		]);
		await dispatcher.drain();
		expect(delivered).toEqual([]);
	});

	it("writes an explainable queue reason when parking a task", async () => {
		const parked = task("queued", "bot");
		const { dispatcher, store } = fixture([parked]);
		await dispatcher.queueBehindBusyBot(parked, task("running", "bot", { status: "running" }));
		const saved = store.snapshot().tasks.find((entry) => entry.id === "queued");
		expect(saved).toMatchObject({ blockReason: "bot_busy", status: "queued" });
		expect(saved?.queuedReason).toContain("running");
		expect(saved?.blockReasonDetail).toContain("running");
	});

	it("dispose cancels a scheduled drain", async () => {
		vi.useFakeTimers();
		try {
			const { dispatcher, delivered } = fixture([task("queued", "bot")]);
			dispatcher.scheduleDrain();
			dispatcher.dispose();
			await vi.runAllTimersAsync();
			expect(delivered).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});
});
