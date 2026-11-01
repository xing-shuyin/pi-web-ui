import { describe, it, expect } from "vitest";
import {
	searchGroupRoomsAndTasks,
	GroupNotificationManager,
	prepareStartPlanExecution,
	type SearchableGroupRoom,
	type SearchableGroupTask,
} from "../../web/src/group-view-state";

describe("group-view-state: searchGroupRoomsAndTasks", () => {
	const rooms: SearchableGroupRoom[] = [
		{ id: "room-backend", name: "Backend Dev", botIds: ["bot-node", "bot-db"] },
		{ id: "room-frontend", name: "UI Team", botIds: ["bot-react"] },
	];

	const tasks: SearchableGroupTask[] = [
		{ id: "task-101", roomId: "room-backend", title: "Migrate Postgres Schema", status: "running" },
		{ id: "task-102", roomId: "room-frontend", title: "Optimize Tailwind Bundle", status: "completed" },
	];

	it("returns all rooms when query is empty", () => {
		const results = searchGroupRoomsAndTasks("", rooms, tasks);
		expect(results).toHaveLength(2);
		expect(results.map((r) => r.roomId)).toEqual(["room-backend", "room-frontend"]);
	});

	it("matches rooms by name", () => {
		const results = searchGroupRoomsAndTasks("UI", rooms, tasks);
		expect(results).toHaveLength(1);
		expect(results[0].roomId).toBe("room-frontend");
		expect(results[0].matchedBy).toBe("room_name");
	});

	it("matches tasks by title and resolves room name", () => {
		const results = searchGroupRoomsAndTasks("Postgres", rooms, tasks);
		expect(results).toHaveLength(1);
		expect(results[0].roomId).toBe("room-backend");
		expect(results[0].roomName).toBe("Backend Dev");
		expect(results[0].matchedBy).toBe("task_title");
		expect(results[0].matchedTask?.id).toBe("task-101");
	});

	it("matches tasks by task ID", () => {
		const results = searchGroupRoomsAndTasks("102", rooms, tasks);
		expect(results).toHaveLength(1);
		expect(results[0].matchedBy).toBe("task_id");
		expect(results[0].matchedTask?.id).toBe("task-102");
	});

	it("matches by bot ID", () => {
		const results = searchGroupRoomsAndTasks("node", rooms, tasks);
		expect(results).toHaveLength(1);
		expect(results[0].roomId).toBe("room-backend");
		expect(results[0].matchedBy).toBe("bot_id");
	});
});

describe("group-view-state: GroupNotificationManager", () => {
	it("tracks active interactions and computes pending count correctly", () => {
		const manager = new GroupNotificationManager();
		expect(manager.getPendingInteractionsCount()).toBe(0);

		// First arrival
		expect(manager.onInteractionReceived("room-1", "task-1", "req-1")).toBe(true);
		expect(manager.getPendingInteractionsCount("room-1")).toBe(1);
		expect(manager.getPendingInteractionsCount("room-2")).toBe(0);

		// Duplicate replay is deduplicated
		expect(manager.onInteractionReceived("room-1", "task-1", "req-1")).toBe(false);
		expect(manager.getPendingInteractionsCount("room-1")).toBe(1);

		// Second interaction in another task
		expect(manager.onInteractionReceived("room-1", "task-2", "req-2")).toBe(true);
		expect(manager.getPendingInteractionsCount("room-1")).toBe(2);

		// Resolving first interaction decrements count
		manager.onInteractionResolved("room-1", "task-1", "req-1");
		expect(manager.getPendingInteractionsCount("room-1")).toBe(1);
	});

	it("deduplicates completed and failed task notifications", () => {
		const manager = new GroupNotificationManager();
		expect(manager.onTaskCompleted("room-1", "task-1")).toBe(true);
		expect(manager.onTaskCompleted("room-1", "task-1")).toBe(false);

		expect(manager.onTaskFailed("room-1", "task-2", "OOM")).toBe(true);
		expect(manager.onTaskFailed("room-1", "task-2", "OOM")).toBe(false);
	});

	it("prepareStartPlanExecution validates ready plan strictly", () => {
		expect(prepareStartPlanExecution({ state: "draft", steps: [{ id: "1", title: "A" }] }).ok).toBe(false);
		expect(prepareStartPlanExecution({ state: "ready", steps: [{ id: "1", title: "A" }] }).ok).toBe(true);
	});
});
