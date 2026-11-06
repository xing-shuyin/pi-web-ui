import {
	type GroupTaskPlan,
	type GroupCanvasRef,
	type BotPresetSnapshot,
	GroupNotificationTracker,
	createStableNotificationKey,
	validatePlanReadyForApproval,
} from "./group-capabilities";

export interface SearchableGroupRoom {
	id: string;
	name: string;
	botIds: string[];
	primaryBotId?: string;
}

export interface SearchableGroupTask {
	id: string;
	roomId: string;
	title: string;
	status: "running" | "completed" | "failed";
	planOnly?: boolean;
	plan?: GroupTaskPlan;
	canvasRef?: GroupCanvasRef;
	createdAt?: number;
}

export interface GroupSearchResult {
	roomId: string;
	roomName: string;
	matchedBy: "room_name" | "bot_id" | "task_title" | "task_id";
	matchedTask?: SearchableGroupTask;
}

export interface GroupViewState {
	searchQuery: string;
	selectedRoomId?: string;
	selectedTaskId?: string;
	planModeDraft: boolean;
	canvasRefDraft?: GroupCanvasRef;
	botPresets: Record<string, BotPresetSnapshot>;
	activePlans: Record<string, GroupTaskPlan>;
	pendingInteractions: Array<{ key: string; roomId: string; taskId: string; requestId: string; prompt: string }>;
	dismissedNotificationKeys: Set<string>;
}

export function searchGroupRoomsAndTasks(
	query: string,
	rooms: SearchableGroupRoom[],
	tasks: SearchableGroupTask[] = [],
): GroupSearchResult[] {
	const trimmed = (query || "").trim().toLowerCase();
	if (!trimmed) {
		return rooms.map((r) => ({
			roomId: r.id,
			roomName: r.name,
			matchedBy: "room_name",
		}));
	}

	const results: GroupSearchResult[] = [];
	const seenRooms = new Set<string>();

	for (const room of rooms) {
		if (room.name.toLowerCase().includes(trimmed)) {
			results.push({
				roomId: room.id,
				roomName: room.name,
				matchedBy: "room_name",
			});
			seenRooms.add(room.id);
		}
	}

	for (const task of tasks) {
		const matchedTitle = task.title.toLowerCase().includes(trimmed);
		const matchedId = task.id.toLowerCase().includes(trimmed);
		if (matchedTitle || matchedId) {
			const room = rooms.find((r) => r.id === task.roomId);
			const roomName = room ? room.name : task.roomId;
			results.push({
				roomId: task.roomId,
				roomName,
				matchedBy: matchedTitle ? "task_title" : "task_id",
				matchedTask: task,
			});
			seenRooms.add(task.roomId);
		}
	}

	for (const room of rooms) {
		if (seenRooms.has(room.id)) continue;
		const botMatch = room.botIds.some((botId) => botId.toLowerCase().includes(trimmed));
		if (botMatch) {
			results.push({
				roomId: room.id,
				roomName: room.name,
				matchedBy: "bot_id",
			});
			seenRooms.add(room.id);
		}
	}

	return results;
}

export function createInitialGroupViewState(): GroupViewState {
	return {
		searchQuery: "",
		planModeDraft: false,
		botPresets: {},
		activePlans: {},
		pendingInteractions: [],
		dismissedNotificationKeys: new Set(),
	};
}

export class GroupNotificationManager {
	private readonly tracker = new GroupNotificationTracker(1000);
	private readonly activeInteractions = new Map<string, { roomId: string; taskId: string; requestId: string }>();

	onInteractionReceived(roomId: string, taskId: string, requestId: string): boolean {
		const isFirst = this.tracker.checkAndRecord("interaction", roomId, taskId, requestId);
		const key = createStableNotificationKey("interaction", roomId, taskId, requestId);
		if (isFirst) {
			this.activeInteractions.set(key, { roomId, taskId, requestId });
		}
		return isFirst;
	}

	onInteractionResolved(roomId: string, taskId: string, requestId: string): void {
		const key = createStableNotificationKey("interaction", roomId, taskId, requestId);
		this.activeInteractions.delete(key);
	}

	onTaskCompleted(roomId: string, taskId: string): boolean {
		return this.tracker.checkAndRecord("completed", roomId, taskId);
	}

	onTaskFailed(roomId: string, taskId: string, reason?: string): boolean {
		return this.tracker.checkAndRecord("failed", roomId, taskId, reason);
	}

	getPendingInteractionsCount(roomId?: string): number {
		if (!roomId) {
			return this.activeInteractions.size;
		}
		let count = 0;
		for (const item of this.activeInteractions.values()) {
			if (item.roomId === roomId) count++;
		}
		return count;
	}

	clear(): void {
		this.tracker.clear();
		this.activeInteractions.clear();
	}
}

export function prepareStartPlanExecution(plan: GroupTaskPlan): { ok: boolean; reason?: string } {
	return validatePlanReadyForApproval(plan);
}
