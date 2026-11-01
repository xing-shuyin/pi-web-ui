import { executionRoot, executionRootsOverlap } from "./execution-workspace.js";
import { DeviceTaskError } from "./task-error.js";
import {
	type DeviceExecutionSettings,
	DEFAULT_EXECUTION_SETTINGS,
	validateExecutionSettings,
} from "./execution-settings.js";

export type TaskBlockReason =
	"none" | "max_concurrency_reached" | "bot_busy" | "workspace_conflict" | "workspace_blocked" | "room_fairness_yield";

export type BlockedTaskReason = "unconfirmed_stop" | "workspace_blocked";

export interface ScheduledTaskInfo {
	taskId: string;
	attemptId: string;
	roomId: string;
	botId: string;
	botRevision?: string;
	root: string;
	queuedAt: number;
}

export interface ActiveTaskItem {
	taskId: string;
	attemptId: string;
	roomId: string;
	botId: string;
	botRevision?: string;
	root: string;
	startedAt: number;
	blocked?: unknown;
	controller?: AbortController;
}

export interface QueuedTaskItem extends ScheduledTaskInfo {
	skipCount: number;
	start: () => void;
	reject: (error: unknown) => void;
	cancel: () => void;
	signal?: AbortSignal;
}

export interface WaitingTaskSnapshot {
	taskId: string;
	attemptId: string;
	roomId: string;
	botId: string;
	queuedAt: number;
	queuePosition: number;
	blockReason: TaskBlockReason;
	blockReasonDetail: string;
	cancelable: boolean;
}

export interface RunningTaskSnapshot {
	taskId: string;
	attemptId: string;
	roomId: string;
	botId: string;
	startedAt: number;
}

export interface BlockedTaskSnapshot {
	taskId: string;
	attemptId: string;
	roomId: string;
	botId: string;
	reason: BlockedTaskReason;
}

export interface TaskSchedulerSnapshot {
	settings: DeviceExecutionSettings;
	activeCount: number;
	waitingCount: number;
	blockedCount: number;
	running: RunningTaskSnapshot[];
	waiting: WaitingTaskSnapshot[];
	blocked: BlockedTaskSnapshot[];
}

export interface TaskSchedulerOptions {
	initialSettings?: unknown;
	starvationThresholdMs?: number; // 默认 8000ms
	maxSkipsBeforeStarvation?: number; // 默认 3 次跳过
}

export class DeviceTaskScheduler {
	public static readonly MAX_ROOM_HISTORY = 256;

	private settings: DeviceExecutionSettings;
	private readonly starvationThresholdMs: number;
	private readonly maxSkipsBeforeStarvation: number;

	private readonly queue: QueuedTaskItem[] = [];
	private readonly active = new Set<ActiveTaskItem>();
	private readonly roomDispatchHistory = new Map<string, { lastDispatchedAt: number; count: number }>();

	constructor(options?: TaskSchedulerOptions) {
		const validated = validateExecutionSettings(options?.initialSettings);
		this.settings = validated.valid ? { ...validated.value } : { ...DEFAULT_EXECUTION_SETTINGS };
		this.starvationThresholdMs = options?.starvationThresholdMs ?? 8000;
		this.maxSkipsBeforeStarvation = options?.maxSkipsBeforeStarvation ?? 3;
	}

	public getSettings(): DeviceExecutionSettings {
		return { ...this.settings };
	}

	public updateSettings(next: unknown): DeviceExecutionSettings {
		const validation = validateExecutionSettings(next);
		if (!validation.valid) {
			throw new Error(validation.error);
		}
		this.settings = { ...validation.value };
		this.drain();
		return { ...this.settings };
	}

	public getActiveCount(): number {
		return this.active.size;
	}

	public getWaitingCount(): number {
		return this.queue.length;
	}

	public getBlockedCount(): number {
		return [...this.active].filter((a) => !!a.blocked).length;
	}

	public isWorkspaceBlocked(botId: string, root: string): boolean {
		const targetRoot = executionRoot(root);
		for (const owner of this.active) {
			if (owner.blocked && this.checkConflict({ botId, root: targetRoot }, owner)) {
				return true;
			}
		}
		return false;
	}

	private checkConflict(a: { botId: string; root: string }, b: { botId: string; root: string }): boolean {
		return a.botId === b.botId || executionRootsOverlap(a.root, b.root);
	}

	private recordRoomDispatch(roomId: string): void {
		let history = this.roomDispatchHistory.get(roomId);
		if (!history) {
			// Bounded LRU eviction
			if (this.roomDispatchHistory.size >= DeviceTaskScheduler.MAX_ROOM_HISTORY) {
				let oldestKey: string | undefined;
				let oldestTime = Infinity;
				for (const [k, v] of this.roomDispatchHistory) {
					if (v.lastDispatchedAt < oldestTime) {
						oldestTime = v.lastDispatchedAt;
						oldestKey = k;
					}
				}
				if (oldestKey) this.roomDispatchHistory.delete(oldestKey);
			}
			history = { lastDispatchedAt: 0, count: 0 };
		}
		history.lastDispatchedAt = Date.now();
		history.count++;
		this.roomDispatchHistory.set(roomId, history);
	}

	public clearRoomHistory(roomId: string): void {
		this.roomDispatchHistory.delete(roomId);
	}

	public enqueue(
		task: {
			id: string;
			attemptId: string;
			roomId: string;
			botId: string;
			botRevision?: string;
			root: string;
		},
		callbacks: {
			start: () => void;
			reject: (error: unknown) => void;
			cancel: () => void;
		},
		signal?: AbortSignal,
	): QueuedTaskItem | null {
		const canonicalRoot = executionRoot(task.root);
		const candidate = { botId: task.botId, root: canonicalRoot };

		// Check if active items have unconfirmed stop blocks
		const blockedBlocker = [...this.active].find((owner) => owner.blocked && this.checkConflict(candidate, owner));
		if (blockedBlocker) {
			throw new DeviceTaskError("Task stop unconfirmed; workspace blocked until service restart");
		}

		// If queue is empty, slots available, and no conflict with active tasks,
		// task can start immediately even if maxWaitingTasks is 0.
		const canStartImmediately =
			this.queue.length === 0 &&
			this.active.size < this.settings.maxActiveTasks &&
			![...this.active].some((owner) => this.checkConflict(candidate, owner));

		if (canStartImmediately) {
			try {
				callbacks.start();
				this.recordRoomDispatch(task.roomId);
			} catch (error) {
				callbacks.reject(error);
			}
			return null;
		}

		// Needs to queue, check queue capacity
		if (this.queue.length >= this.settings.maxWaitingTasks) {
			throw new DeviceTaskError("Local task queue full");
		}

		const item: QueuedTaskItem = {
			taskId: task.id,
			attemptId: task.attemptId,
			roomId: task.roomId,
			botId: task.botId,
			botRevision: task.botRevision,
			root: canonicalRoot,
			queuedAt: Date.now(),
			skipCount: 0,
			signal,
			start: callbacks.start,
			reject: callbacks.reject,
			cancel: callbacks.cancel,
		};

		this.queue.push(item);
		this.drain();
		return item;
	}

	public removeWaiting(item: QueuedTaskItem): boolean {
		const index = this.queue.indexOf(item);
		if (index >= 0) {
			this.queue.splice(index, 1);
			this.drain();
			return true;
		}
		return false;
	}

	public cancelTask(taskId: string, attemptId?: string): boolean {
		// 1. Check waiting queue
		const waitingIndex = this.queue.findIndex((q) => q.taskId === taskId && (!attemptId || q.attemptId === attemptId));
		if (waitingIndex >= 0) {
			const [item] = this.queue.splice(waitingIndex, 1);
			item.cancel();
			this.drain();
			return true;
		}

		// 2. Check active running tasks
		const activeItem = [...this.active].find((a) => a.taskId === taskId && (!attemptId || a.attemptId === attemptId));
		if (activeItem && activeItem.controller && !activeItem.controller.signal.aborted) {
			activeItem.controller.abort(new DeviceTaskError("Task cancelled by user"));
			return true;
		}

		return false;
	}

	public registerActive(
		task: {
			id: string;
			attemptId: string;
			roomId: string;
			botId: string;
			botRevision?: string;
			root: string;
		},
		controller: AbortController,
	): ActiveTaskItem {
		const canonicalRoot = executionRoot(task.root);

		// Guard against duplicate task ID
		const duplicate = [...this.active].find((item) => item.taskId === task.id);
		if (duplicate) {
			throw new DeviceTaskError("Task is already running");
		}

		const candidate = { botId: task.botId, root: canonicalRoot };

		// Guard against capacity breach
		if (this.active.size >= this.settings.maxActiveTasks) {
			throw new DeviceTaskError("Active task capacity exceeded");
		}

		// Guard against active conflict
		const conflict = [...this.active].find((item) => this.checkConflict(candidate, item));
		if (conflict) {
			throw new DeviceTaskError(
				conflict.blocked
					? "Task stop unconfirmed; workspace blocked until service restart"
					: "Active task workspace or bot conflict",
			);
		}

		const item: ActiveTaskItem = {
			taskId: task.id,
			attemptId: task.attemptId,
			roomId: task.roomId,
			botId: task.botId,
			botRevision: task.botRevision,
			root: canonicalRoot,
			startedAt: Date.now(),
			controller,
		};
		this.active.add(item);
		return item;
	}

	public markBlocked(taskId: string, attemptId: string, error: unknown): void {
		for (const item of this.active) {
			if (item.taskId === taskId && item.attemptId === attemptId) {
				item.blocked = error;
			}
		}
	}

	public releaseActive(item: ActiveTaskItem): void {
		this.active.delete(item);
		this.drain();
	}

	public drain(): void {
		if (this.queue.length === 0) return;

		const now = Date.now();

		// Reject tasks blocked by unconfirmed stops
		const toReject: { entry: QueuedTaskItem; error: DeviceTaskError }[] = [];
		for (let i = this.queue.length - 1; i >= 0; i--) {
			const entry = this.queue[i]!;
			const blocker = [...this.active].find((owner) => owner.blocked && this.checkConflict(entry, owner));
			if (blocker) {
				this.queue.splice(i, 1);
				toReject.push({
					entry,
					error: new DeviceTaskError("Task stop unconfirmed; workspace blocked until service restart"),
				});
			}
		}
		for (const { entry, error } of toReject) {
			entry.reject(error);
		}

		if (this.queue.length === 0) return;

		let availableSlots = this.settings.maxActiveTasks - this.active.size;
		if (availableSlots <= 0) return;

		// Identify schedulable candidates
		// A candidate can physically start if:
		// 1. No active task conflicts with it.
		// 2. No earlier queued task conflicts with it (strict FIFO for the same bot/workspace).
		const schedulable: { entry: QueuedTaskItem; isStarved: boolean }[] = [];

		for (let i = 0; i < this.queue.length; i++) {
			const entry = this.queue[i]!;
			const hasActiveConflict = [...this.active].some((owner) => this.checkConflict(entry, owner));
			if (hasActiveConflict) continue;

			const hasPriorQueueConflict = this.queue.slice(0, i).some((prior) => this.checkConflict(entry, prior));
			if (hasPriorQueueConflict) continue;

			const isStarved =
				now - entry.queuedAt >= this.starvationThresholdMs || entry.skipCount >= this.maxSkipsBeforeStarvation;

			schedulable.push({ entry, isStarved });
		}

		if (schedulable.length === 0) return;

		// Sort schedulable candidates:
		// 1. Starved tasks come first (anti-starvation guarantee, oldest starved first).
		// 2. For non-starved tasks: Room fair share (fewer active tasks in room first, then room last dispatched).
		// 3. FIFO within same priority.
		schedulable.sort((a, b) => {
			if (a.isStarved && !b.isStarved) return -1;
			if (!a.isStarved && b.isStarved) return 1;
			if (a.isStarved && b.isStarved) {
				return a.entry.queuedAt - b.entry.queuedAt;
			}

			// Room active task count
			const activeA = [...this.active].filter((item) => item.roomId === a.entry.roomId).length;
			const activeB = [...this.active].filter((item) => item.roomId === b.entry.roomId).length;
			if (activeA !== activeB) return activeA - activeB;

			// Room dispatch history
			const histA = this.roomDispatchHistory.get(a.entry.roomId);
			const histB = this.roomDispatchHistory.get(b.entry.roomId);
			const countA = histA?.count ?? 0;
			const countB = histB?.count ?? 0;
			if (countA !== countB) return countA - countB;

			const lastA = histA?.lastDispatchedAt ?? 0;
			const lastB = histB?.lastDispatchedAt ?? 0;
			if (lastA !== lastB) return lastA - lastB;

			return a.entry.queuedAt - b.entry.queuedAt;
		});

		// Select up to availableSlots
		const toDispatch: QueuedTaskItem[] = [];
		for (const cand of schedulable) {
			if (availableSlots <= 0) break;
			// Ensure candidates chosen in this batch do not conflict with each other
			const conflictsWithSelected = toDispatch.some((selected) => this.checkConflict(cand.entry, selected));
			if (conflictsWithSelected) continue;

			toDispatch.push(cand.entry);
			availableSlots--;
		}

		// Update skip counts for schedulable candidates that were passed over
		for (const cand of schedulable) {
			if (!toDispatch.includes(cand.entry)) {
				cand.entry.skipCount++;
			}
		}

		// Dispatch selected entries with try/catch error isolation
		for (const entry of toDispatch) {
			const index = this.queue.indexOf(entry);
			if (index >= 0) {
				this.queue.splice(index, 1);
			}

			try {
				entry.start();
				this.recordRoomDispatch(entry.roomId);
			} catch (error) {
				entry.reject(error);
				this.drain();
			}
		}
	}

	public analyzeBlockReason(
		entry: QueuedTaskItem,
		queueIndex: number,
	): {
		reason: TaskBlockReason;
		detail: string;
	} {
		// Check workspace blocked by unconfirmed stop
		const blockedBlocker = [...this.active].find((owner) => owner.blocked && this.checkConflict(entry, owner));
		if (blockedBlocker) {
			return {
				reason: "workspace_blocked",
				detail: "Workspace is locked due to an unconfirmed task stop",
			};
		}

		// Check bot busy in active
		const botActive = [...this.active].find((owner) => owner.botId === entry.botId);
		if (botActive) {
			return {
				reason: "bot_busy",
				detail: "Target bot is currently running another task",
			};
		}

		// Check workspace conflict in active
		const workspaceActive = [...this.active].find((owner) => executionRootsOverlap(entry.root, owner.root));
		if (workspaceActive) {
			return {
				reason: "workspace_conflict",
				detail: "Workspace is currently in use by an active task",
			};
		}

		// Check prior queue item conflicts (FIFO constraint)
		const priorBotQueue = this.queue.slice(0, queueIndex).find((prior) => prior.botId === entry.botId);
		if (priorBotQueue) {
			return {
				reason: "bot_busy",
				detail: "Target bot has an earlier queued task waiting",
			};
		}

		const priorWorkspaceQueue = this.queue
			.slice(0, queueIndex)
			.find((prior) => executionRootsOverlap(entry.root, prior.root));
		if (priorWorkspaceQueue) {
			return {
				reason: "workspace_conflict",
				detail: "Workspace has an earlier queued task waiting",
			};
		}

		// Check concurrency limit
		if (this.active.size >= this.settings.maxActiveTasks) {
			return {
				reason: "max_concurrency_reached",
				detail: "Device concurrent task limit reached",
			};
		}

		// Otherwise waiting for room fairness round
		return {
			reason: "room_fairness_yield",
			detail: "Waiting for fair scheduling turn across rooms",
		};
	}

	public getSnapshot(): TaskSchedulerSnapshot {
		const running: RunningTaskSnapshot[] = [];
		const blocked: BlockedTaskSnapshot[] = [];

		for (const item of this.active) {
			if (item.blocked) {
				const reason: BlockedTaskReason =
					item.blocked && (item.blocked as any).stopUnconfirmed ? "unconfirmed_stop" : "workspace_blocked";
				blocked.push({
					taskId: item.taskId,
					attemptId: item.attemptId,
					roomId: item.roomId,
					botId: item.botId,
					reason,
				});
			} else {
				running.push({
					taskId: item.taskId,
					attemptId: item.attemptId,
					roomId: item.roomId,
					botId: item.botId,
					startedAt: item.startedAt,
				});
			}
		}

		const waiting: WaitingTaskSnapshot[] = this.queue.map((item, index) => {
			const { reason, detail } = this.analyzeBlockReason(item, index);
			return {
				taskId: item.taskId,
				attemptId: item.attemptId,
				roomId: item.roomId,
				botId: item.botId,
				queuedAt: item.queuedAt,
				queuePosition: index + 1,
				blockReason: reason,
				blockReasonDetail: detail,
				cancelable: true,
			};
		});

		return {
			settings: this.getSettings(),
			activeCount: this.active.size,
			waitingCount: this.queue.length,
			blockedCount: blocked.length,
			running,
			waiting,
			blocked,
		};
	}
}
