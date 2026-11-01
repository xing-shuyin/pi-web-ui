/**
 * web/src/group-view-state.ts
 *
 * 群视图与主会话生态状态管理：
 * 1. 群聊与群任务搜索（按群名、Bot、任务标题、任务ID精确匹配）与切换导航
 * 2. 群计划模式草稿与任务绑定
 * 3. 画布显式引用绑定与状态管理
 * 4. Bot 预设快照版本锁定与在途防护
 * 5. 待答/完成通知的稳定去重队列与未读徽标计算（带容量与持久去重）
 */

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
	activePlans: Record<string, GroupTaskPlan>; // taskId -> GroupTaskPlan
	pendingInteractions: Array<{ key: string; roomId: string; taskId: string; requestId: string; prompt: string }>;
	dismissedNotificationKeys: Set<string>;
}

/**
 * 搜索群与任务，支持按群名称、Bot、任务标题、任务 ID 精确/模糊匹配
 * 注：仅针对群名、Bot 及任务标题/ID 进行结构化搜索，不伪称消息正文全文检索
 */
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

	// 1. 群名匹配
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

	// 2. 任务标题与任务 ID 匹配
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

	// 3. Bot ID 匹配
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

/**
 * 创建初始群视图状态
 */
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

/**
 * 管理群通知与未读统计的去重处理器
 */
export class GroupNotificationManager {
	private readonly tracker = new GroupNotificationTracker(1000);
	private readonly activeInteractions = new Map<string, { roomId: string; taskId: string; requestId: string }>();

	/**
	 * 处理新收到的交互请求（待答）
	 * 返回 true 表示该请求为首次通知（未去重拦截）
	 */
	onInteractionReceived(roomId: string, taskId: string, requestId: string): boolean {
		const isFirst = this.tracker.checkAndRecord("interaction", roomId, taskId, requestId);
		const key = createStableNotificationKey("interaction", roomId, taskId, requestId);
		if (isFirst) {
			this.activeInteractions.set(key, { roomId, taskId, requestId });
		}
		return isFirst;
	}

	/**
	 * 交互完成或已答复，从待答池中移除
	 */
	onInteractionResolved(roomId: string, taskId: string, requestId: string): void {
		const key = createStableNotificationKey("interaction", roomId, taskId, requestId);
		this.activeInteractions.delete(key);
	}

	/**
	 * 任务终态完成通知（带去重）
	 */
	onTaskCompleted(roomId: string, taskId: string): boolean {
		return this.tracker.checkAndRecord("completed", roomId, taskId);
	}

	/**
	 * 任务失败通知（带去重）
	 */
	onTaskFailed(roomId: string, taskId: string, reason?: string): boolean {
		return this.tracker.checkAndRecord("failed", roomId, taskId, reason);
	}

	/**
	 * 获取当前群未解决的待答交互数
	 */
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

/**
 * 前端请求开始执行计划前的预校验
 */
export function prepareStartPlanExecution(plan: GroupTaskPlan): { ok: boolean; reason?: string } {
	return validatePlanReadyForApproval(plan);
}
