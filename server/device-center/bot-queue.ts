import type { HubTask } from "./store.js";

/**
 * 每 Bot 串行队列（纯排序逻辑，单源）。
 *
 * 一个 Bot 在同一时刻只能执行一个任务（设备侧执行器与 lease 都这么假设）。过去的做法是
 * 直接拒绝："目标设备正在执行另一个群任务"——但那等于把并发冲突丢给用户重试。
 * 这里把并发改造成**排队**：
 *
 *   0 = 人私聊（direct room）：用户正盯着，优先
 *   1 = 群内人消息（默认）
 *   2 = 路由 / Webhook / 定时等非人工触发：可等
 *
 * 同优先级按创建时间 FIFO，id 作为最终稳定序，保证多端看到同一个顺序。
 */

export const BOT_QUEUE_PRIORITIES = [0, 1, 2] as const;

/**
 * 「同一 Bot 不能并发」的共享判定单源。
 * Hub 派发层（hub-task-queue.ts）与设备执行层（task-scheduler.ts / runtime.ts）都复用它，
 * 避免两层各写一遍 `a.botId === b.botId` 之后语义漂移。
 */
export function sameBotConflict(a: { botId: string }, b: { botId: string }): boolean {
	return a.botId === b.botId;
}

/** 单个 Bot 的排队上限：超过后新的派活直接拒绝（429），而不是让它无限堆积。 */
export const BOT_QUEUE_MAX_PENDING = 12;

/** ETA 采样窗口与兜底：最近 20 条已完成任务的中位数，夹在 5s ~ 10min，默认 30s。 */
const ETA_SAMPLE = 20;
const ETA_FLOOR_MS = 5_000;
const ETA_CEIL_MS = 10 * 60_000;
const ETA_DEFAULT_MS = 30_000;

/**
 * 用该 Bot 最近完成任务的耗时中位数估计单个任务要多久。
 * 中位数比平均值抗离群值（一次 10 分钟的构建不该毁掉接下来所有估计）。
 */
export function estimateBotTaskMs(tasks: readonly HubTask[], botId: string): number {
	const durations = tasks
		.filter(
			(task) =>
				task.botId === botId &&
				task.status === "completed" &&
				typeof task.updatedAt === "number" &&
				task.updatedAt > task.createdAt,
		)
		.map((task) => task.updatedAt - task.createdAt)
		.sort((a, b) => a - b)
		.slice(-ETA_SAMPLE);
	if (!durations.length) return ETA_DEFAULT_MS;
	const median = durations[Math.floor(durations.length / 2)];
	return Math.min(ETA_CEIL_MS, Math.max(ETA_FLOOR_MS, median));
}

/** 排队还需多久（第 position+1 位要等 position+1 个任务）。 */
export function estimateQueueWaitMs(tasks: readonly HubTask[], botId: string, position: number): number {
	return estimateBotTaskMs(tasks, botId) * (Math.max(0, position) + 1);
}

export function formatEta(ms: number): string {
	const seconds = Math.max(1, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	return `${minutes}min`;
}
export type BotQueuePriority = (typeof BOT_QUEUE_PRIORITIES)[number];

/** 排队任务的优先级：直聊 0、非人工触发 2、其余 1。 */
export function botQueuePriority(task: Pick<HubTask, "queuePriority" | "origin">): BotQueuePriority {
	const priority = task.queuePriority;
	if (priority === 0 || priority === 1 || priority === 2) return priority;
	return task.origin === "router" || task.origin === "webhook" || task.origin === "schedule" ? 2 : 1;
}

/** 已经占住这个 Bot 的任务（执行中 / 等待人工 / 持租约 / 已下发但未终态）。 */
export function activeTaskForBot(
	tasks: readonly HubTask[],
	botId: string,
	dispatched: ReadonlySet<string>,
	exceptTaskId?: string,
): HubTask | undefined {
	return tasks.find(
		(task) =>
			task.botId === botId &&
			task.id !== exceptTaskId &&
			task.status !== "completed" &&
			task.status !== "failed" &&
			task.status !== "interrupted" &&
			(task.status === "running" || task.status === "waiting" || Boolean(task.leaseToken) || dispatched.has(task.id)),
	);
}

/** 被本闸门显式停放（而不是天生要等其他条件）的任务：只有这些才会被自动唤醒。 */
function parkedForBot(task: HubTask): boolean {
	return task.status === "queued" && task.blockReason === "bot_busy";
}

function queueOrder(a: HubTask, b: HubTask): number {
	return (
		botQueuePriority(a) - botQueuePriority(b) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);
}

function eligible(task: HubTask, dispatched: ReadonlySet<string>): boolean {
	return (
		!task.cancelRequested && !task.stopConfirmed && !task.leaseToken && !task.recoveryUntil && !dispatched.has(task.id)
	);
}

/**
 * 可下发的排队任务：只有本闸门停放过的（`blockReason: "bot_busy"`）才回到这里，
 * 避免把"依赖未满足 / 资源锁 / 面板人工重试"的任务顺手派掉——那些有自己的唤醒路径。
 */
export function rankBotQueue(tasks: readonly HubTask[], dispatched: ReadonlySet<string>, botId?: string): HubTask[] {
	return tasks
		.filter((task) => parkedForBot(task) && eligible(task, dispatched) && (!botId || task.botId === botId))
		.sort(queueOrder);
}

/** 排队位置（0 = 下一个执行），用于给用户解释"还要等几个"。 */
export function queuePositionOf(
	tasks: readonly HubTask[],
	dispatched: ReadonlySet<string>,
	task: Pick<HubTask, "id" | "botId">,
): number {
	// 排队位置在"写状态之前"计算，所以把目标任务自己也算进候选。
	const queue = tasks
		.filter(
			(entry) =>
				entry.botId === task.botId && eligible(entry, dispatched) && (parkedForBot(entry) || entry.id === task.id),
		)
		.sort(queueOrder);
	const index = queue.findIndex((entry) => entry.id === task.id);
	return index < 0 ? 0 : index;
}

/** 排队原因文案：同时给出"前面还有几个"和"为什么"，两端都能直接展示。 */
export function queuedReasonText(position: number, runningTaskId: string | undefined, etaMs?: number): string {
	const ahead = position + 1;
	const running = runningTaskId ? runningTaskId.slice(0, 8) : "—";
	const eta = etaMs === undefined ? "" : `，约 ${formatEta(etaMs)}`;
	const etaEn = etaMs === undefined ? "" : `, ~${formatEta(etaMs)}`;
	return ahead <= 1
		? `Bot 正在执行上一个任务（${running}${eta}）/ Bot is finishing the previous task${etaEn}`
		: `前面还有 ${ahead} 个任务（当前 ${running}${eta}）/ queued behind ${ahead} task(s)${etaEn}`;
}

/** 从任务自身推导优先级（创建时写死，避免唤醒顺序随实现变化）。 */
export function queuePriorityForCreation(input: {
	direct: boolean;
	origin?: "human" | "router" | "webhook" | "schedule" | "work_item";
}): BotQueuePriority {
	if (input.direct) return 0;
	if (input.origin && input.origin !== "human" && input.origin !== "work_item") return 2;
	return 1;
}
