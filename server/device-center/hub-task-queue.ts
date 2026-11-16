import type { GroupTaskContext } from "./group-context.js";
import { activeTaskForBot, estimateQueueWaitMs, queuePositionOf, queuedReasonText, rankBotQueue } from "./bot-queue.js";
import type { DeviceHubStore, HubState, HubTask, Room } from "./store.js";

/**
 * Hub 侧的「派发顺序」仲裁，单独成模块以便与设备侧的「执行并发」区分清楚。
 *
 * 两层职责（见 docs/device-collaboration.md「调度分层」）：
 * - 这里决定哪个 queued 任务先下发到设备：每 Bot 一个执行位、优先级 + FIFO、ETA；
 * - 设备侧 `DeviceTaskScheduler` 决定本地哪些任务真的并发跑：槽位、工作区锁、群公平。
 *
 * 只唤醒被本闸门停放过的任务（`blockReason: "bot_busy"`），依赖未满足 / 资源锁 /
 * 人工重试的任务各有自己的唤醒路径，不能被这里顺手派掉。
 */

export interface BotQueueDispatcherOptions {
	store: DeviceHubStore;
	/** 已下发但尚未终态的任务 id，避免重复投递。 */
	deliveredTasks: ReadonlySet<string>;
	deliverTask(task: HubTask, context?: GroupTaskContext): Promise<void>;
	taskContext(room: Room, state: HubState): GroupTaskContext | undefined;
}

export interface BotQueueDispatcher {
	queueBehindBusyBot(task: HubTask, active: HubTask): Promise<void>;
	queueBehindConversationTurn(task: HubTask, aheadTaskId: string): Promise<void>;
	drain(): Promise<void>;
	scheduleDrain(): void;
	dispose(): void;
}

export function createBotQueueDispatcher(options: BotQueueDispatcherOptions): BotQueueDispatcher {
	const { store, deliveredTasks } = options;
	let drainRunning = false;
	let drainAgain = false;
	let drainTimer: NodeJS.Timeout | undefined;

	async function markTaskQueued(
		task: HubTask,
		reason: { blockReason: HubTask["blockReason"]; detail: string; text: string },
	): Promise<void> {
		await store.transact((draft) => {
			const current = draft.tasks.find((entry) => entry.id === task.id && entry.attemptId === task.attemptId);
			if (!current || current.status !== "queued" || current.cancelRequested || current.leaseToken) return;
			current.blockReason = reason.blockReason;
			current.blockReasonDetail = reason.detail;
			current.queuedReason = reason.text;
			current.updatedAt = Date.now();
		});
	}

	async function queueBehindBusyBot(task: HubTask, active: HubTask): Promise<void> {
		const tasks = store.snapshot().tasks;
		const position = queuePositionOf(tasks, deliveredTasks, task);
		await markTaskQueued(task, {
			blockReason: "bot_busy",
			detail: `Bot ${task.botId} is running ${active.id}`,
			text: queuedReasonText(position, active.id, estimateQueueWaitMs(tasks, task.botId, position)),
		});
	}

	async function queueBehindConversationTurn(task: HubTask, aheadTaskId: string): Promise<void> {
		await markTaskQueued(task, {
			blockReason: "dependency",
			detail: `Waiting for the previous turn ${aheadTaskId}`,
			text: "上一条消息还在执行，本轮排队 / queued behind the previous turn in this conversation",
		});
	}

	async function drain(): Promise<void> {
		if (drainRunning) {
			drainAgain = true;
			return;
		}
		drainRunning = true;
		try {
			do {
				drainAgain = false;
				const state = store.snapshot();
				const botIds = new Set(state.tasks.filter((task) => task.status === "queued").map((task) => task.botId));
				for (const botId of botIds) {
					if (activeTaskForBot(state.tasks, botId, deliveredTasks)) continue;
					const next = rankBotQueue(state.tasks, deliveredTasks, botId)[0];
					if (!next) continue;
					const room = state.rooms.find((entry) => entry.id === next.roomId);
					await options.deliverTask(next, room ? options.taskContext(room, state) : undefined);
				}
			} while (drainAgain);
		} finally {
			drainRunning = false;
		}
	}

	function scheduleDrain(): void {
		if (drainTimer) return;
		drainTimer = setTimeout(() => {
			drainTimer = undefined;
			void drain();
		}, 0);
		drainTimer.unref?.();
	}

	function dispose(): void {
		if (drainTimer) clearTimeout(drainTimer);
		drainTimer = undefined;
	}

	return { queueBehindBusyBot, queueBehindConversationTurn, drain, scheduleDrain, dispose };
}
