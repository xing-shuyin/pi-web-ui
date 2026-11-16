import type { DeviceTaskEventFrame, DeviceTaskProgress, DeviceTaskToolLifecycleFrame } from "../protocol.js";
import type { DeviceTaskCallbacks, DeviceExecutorTask } from "./executor.js";
import type { HubTaskEvent } from "./hub.js";
import { reportUploadMetadata } from "./report-metadata.js";
import { uploadTaskReport } from "./report-upload.js";
import { projectTaskActivity } from "./task-progress.js";
import { deviceTaskFailure } from "./task-error.js";
import type { TaskReportOutbox } from "./task-report-outbox.js";
import type { TaskRecoveryManager } from "./task-recovery.js";

/**
 * 本机设备（Bot 就跑在这个进程里）的任务直调。
 *
 * 为什么单独一条通道：走 `relay` 意味着任务要绕一圈 —— Hub → WS → connector → 本地调度 →
 * 执行器，而这一圈里几乎每一步都是"静默丢"（`sendFrame` 时 socket 不在 OPEN、`emit` 的
 * `runningTasks` 不匹配、调度位被占…），用户看到的就是"派发出去了、一直转圈、不报错"。
 * 同一个进程内的设备不需要网络可靠性，直调把这一层整个拿掉：收到的任务立刻交给运行时，
 * 进度/产物/终态直接写回 Hub（不经过帧、不依赖连接状态），租约由本桥自己续。
 *
 * 契约与 `connector.ts` 的 `frame.type === "task"` 分支一一对应（认领 → 进度 → 工具生命周期 →
 * 交互 → 计划确认 → 终态与报告 + 租约续期），改动其中一处必须同时对照另一处；远程设备仍走 WS。
 *
 * 只接管"任务"这一类动作：桌面/文件/终端等命令仍由 connector 的 WS 通道负责（那些确实需要
 * 设备连接），所以本机设备也保留 connector —— 但任务生命周期不再依赖它。
 */
export interface LocalTaskHub {
	acceptTaskEvent(deviceId: string, event: HubTaskEvent): Promise<unknown>;
	acceptTaskProgress(deviceId: string, event: DeviceTaskProgress): unknown;
	acceptTaskToolLifecycle(deviceId: string, frame: DeviceTaskToolLifecycleFrame): Promise<void>;
	acceptInteractions(deviceId: string, event: unknown): void;
	acceptTaskPlanReady(deviceId: string, frame: unknown): Promise<boolean>;
	renewTaskLease(deviceId: string, renew: import("../protocol.js").DeviceTaskLeaseRenew): Promise<unknown>;
}

export interface LocalTaskRuntime {
	onTask(
		task: DeviceExecutorTask & { roomId: string },
		signal?: AbortSignal,
		callbacks?: DeviceTaskCallbacks,
	): Promise<string>;
	recovery?: Pick<TaskRecoveryManager, "recordActivity">;
	reportOutbox?: TaskReportOutbox;
	cancelScheduledTask(taskId: string, attemptId?: string): boolean;
	steerTask(taskId: string, text: string, attemptId?: string): boolean | Promise<boolean>;
	answerTaskInteraction(taskId: string, attemptId: string, answer: unknown): boolean;
}

/**
 * 嵌入方（测试、第三方宿主）可能只提供调度视图那几个方法：
 * 缺直调所需的能力时宁可继续走 relay，也不要挂一个假执行器上去。
 */
export function isLocalTaskRuntime(value: unknown): value is LocalTaskRuntime {
	const runtime = value as Partial<LocalTaskRuntime> | undefined;
	return (
		!!runtime &&
		typeof runtime.onTask === "function" &&
		typeof runtime.cancelScheduledTask === "function" &&
		typeof runtime.steerTask === "function" &&
		typeof runtime.answerTaskInteraction === "function"
	);
}

export interface LocalTaskBridgeOptions {
	deviceId: string;
	/** 报告上传（`uploadTaskReport`）所需的 Hub 地址与设备凭据：本机 Hub 也是走 loopback HTTP。 */
	hubUrl: string;
	credential: string;
	hub: LocalTaskHub;
	runtime: LocalTaskRuntime;
	/** 进度帧最小间隔，与 connector 的节流保持一致。 */
	progressIntervalMs?: number;
	/** 租约续期间隔，与 connector 心跳（15s）保持一致。 */
	renewIntervalMs?: number;
}

export interface LocalTaskBridge {
	deviceId: string;
	/** 与 relay 的 `onTask` 同签名：`true` = 已接手，`false` = 拒绝投递（Hub 会记失败）。 */
	onTask(deviceId: string, task: DeviceExecutorTask & { roomId: string }): Promise<boolean>;
	cancelTask(deviceId: string, taskId: string, attemptId: string): Promise<{ stopped: boolean }>;
	steerTask(deviceId: string, taskId: string, attemptId: string, text: string): Promise<{ steered: boolean }>;
	answerInteraction(deviceId: string, answer: import("../protocol.js").DeviceTaskInteractionAnswer): Promise<boolean>;
	/** 该 deviceId 是否由本桥接手。 */
	owns(deviceId: string): boolean;
	/** 在飞任务数（诊断 / 测试用）。 */
	inFlight(): number;
	/** Hub 关闭时收尾：停掉租约心跳，不再续期。 */
	close(): void;
}

const DEFAULT_PROGRESS_INTERVAL_MS = 250;
const DEFAULT_RENEW_INTERVAL_MS = 15_000;

type Lease = {
	taskId: string;
	attemptId: string;
	botId: string;
	leaseToken: string;
	leaseGeneration: number;
	/** 上次续期后是否出现过新活动（与 connector 的 `hasActivity` 同语义）。 */
	dirty: boolean;
	activitySequence: number;
};

export function createLocalTaskBridge(options: LocalTaskBridgeOptions): LocalTaskBridge {
	const { hub, runtime, deviceId } = options;
	const progressIntervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
	const renewIntervalMs = options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
	const owns = (target: string) => target === deviceId;
	const leases = new Map<string, Lease>();
	let renewTimer: NodeJS.Timeout | undefined;

	const leaseKey = (taskId: string, attemptId: string) => `${taskId}:${attemptId}`;

	/**
	 * 租约续期：本机任务不依赖 connector 的 WS 心跳——WS 掉了、或者任务还在本地调度排队
	 * （已接手但尚未真正开跑），本桥仍然证明"设备还活着"。否则 Hub 的"派发后没起来"看门狗
	 * 会把排队中的任务误判成没起来，30 分钟无心跳也会误杀正在跑的任务。
	 */
	function startRenewTimer() {
		if (renewTimer) return;
		renewTimer = setInterval(() => {
			for (const lease of leases.values()) {
				const hasActivity = lease.dirty;
				if (hasActivity) {
					lease.dirty = false;
					lease.activitySequence++;
				}
				void Promise.resolve(
					hub.renewTaskLease(deviceId, {
						taskId: lease.taskId,
						attemptId: lease.attemptId,
						botId: lease.botId,
						leaseToken: lease.leaseToken,
						leaseGeneration: lease.leaseGeneration,
						activitySequence: lease.activitySequence,
						hasActivity,
					}),
				).catch(() => undefined);
			}
		}, renewIntervalMs);
		renewTimer.unref?.();
	}

	function markActivity(task: DeviceExecutorTask & { roomId: string }) {
		runtime.recovery?.recordActivity?.(task.id, task.attemptId);
		const lease = leases.get(leaseKey(task.id, task.attemptId));
		if (lease) lease.dirty = true;
	}

	async function settle(
		task: DeviceExecutorTask & { roomId: string },
		status: "completed" | "failed",
		report: string | undefined,
	): Promise<void> {
		leases.delete(leaseKey(task.id, task.attemptId));
		const entry = runtime.reportOutbox?.get(task) ?? runtime.reportOutbox?.markMissing(task);
		if (entry) await uploadReport(entry).catch(() => undefined);
		const metadata = entry ? reportUploadMetadata(entry) : undefined;
		const event: HubTaskEvent = {
			type: "task_event",
			taskId: task.id,
			botId: task.botId,
			attemptId: task.attemptId,
			leaseToken: task.leaseToken,
			leaseGeneration: task.leaseGeneration,
			status,
			...(report ? { report } : {}),
			...(metadata ? { reportMetadata: metadata } : {}),
		} as HubTaskEvent;
		await Promise.resolve(hub.acceptTaskEvent(deviceId, event)).catch((error: unknown) => {
			console.warn(
				`[LocalTaskBridge] 终态写回失败 task=${task.id} status=${status}:`,
				error instanceof Error ? error.message : error,
			);
		});
	}

	function uploadReport(entry: NonNullable<ReturnType<NonNullable<TaskReportOutbox["get"]>>>): Promise<void> {
		const outbox = runtime.reportOutbox;
		if (!outbox || !entry.uploadPending || entry.rejected) return Promise.resolve();
		return Promise.resolve()
			.then(async () => {
				const text = outbox.read(entry);
				await uploadTaskReport({
					hubUrl: options.hubUrl,
					deviceId,
					credential: options.credential,
					entry,
					text,
				});
				outbox.accepted(entry);
			})
			.catch((error: unknown) => {
				outbox.failed(entry, error);
				console.warn(
					`[LocalTaskBridge] 报告上传未完成 task=${entry.id}，报告仍留在 outbox：`,
					error instanceof Error ? error.message : error,
				);
			});
	}

	return {
		deviceId,
		owns,
		inFlight: () => leases.size,
		close() {
			if (renewTimer) clearInterval(renewTimer);
			renewTimer = undefined;
			leases.clear();
		},
		async onTask(target, task) {
			if (!owns(target)) return false;
			const key = leaseKey(task.id, task.attemptId);
			// 已在飞：重复投递是幂等 no-op。返回 false 会被 Hub 当成"拒绝投递"直接把任务判失败。
			if (leases.has(key)) return true;
			// 认领帧：与 connector 收到任务即 `emit("running")` 等价。Hub 用它区分
			// "设备拿到了" 与 "真的开始执行了"（后者靠租约续期）。
			try {
				await Promise.resolve(
					hub.acceptTaskEvent(deviceId, {
						type: "task_event",
						taskId: task.id,
						botId: task.botId,
						attemptId: task.attemptId,
						leaseToken: task.leaseToken,
						leaseGeneration: task.leaseGeneration,
						status: "running",
					} as HubTaskEvent),
				);
			} catch (error) {
				console.warn(`[LocalTaskBridge] 认领被拒绝 task=${task.id}:`, error instanceof Error ? error.message : error);
				return false;
			}

			leases.set(key, {
				taskId: task.id,
				attemptId: task.attemptId,
				botId: task.botId,
				leaseToken: String(task.leaseToken ?? ""),
				leaseGeneration: task.leaseGeneration ?? 1,
				dirty: true,
				activitySequence: 0,
			});
			startRenewTimer();

			let sequence = 0;
			let lastProgress = 0;
			const onProgress = (value: Parameters<NonNullable<DeviceTaskCallbacks["onProgress"]>>[0]) => {
				markActivity(task);
				const activity = projectTaskActivity(value);
				if (!activity) return;
				const now = Date.now();
				if (now - lastProgress < progressIntervalMs) return;
				lastProgress = now;
				hub.acceptTaskProgress(deviceId, {
					type: "task_progress",
					taskId: task.id,
					botId: task.botId,
					attemptId: task.attemptId,
					sequence: ++sequence,
					...activity,
				} as DeviceTaskProgress);
			};

			let started: Promise<string>;
			try {
				started = runtime.onTask(task, undefined, {
					onStarted() {},
					onActivity: () => markActivity(task),
					onProgress,
					onPlanReady(taskId, plan) {
						if (taskId !== task.id) return Promise.resolve(false);
						markActivity(task);
						return Promise.resolve(
							hub.acceptTaskPlanReady(deviceId, {
								type: "task_plan_ready",
								taskId,
								botId: task.botId,
								attemptId: task.attemptId,
								plan,
							}),
						).catch(() => false);
					},
					onFullReport(taskId, attemptId, fullReport) {
						if (taskId !== task.id || attemptId !== task.attemptId) throw new Error("Report task binding mismatch");
						if (!runtime.reportOutbox?.get(task)) runtime.reportOutbox?.capture(task, fullReport);
					},
					onToolLifecycle(lifecycle) {
						markActivity(task);
						void Promise.resolve(
							hub.acceptTaskToolLifecycle(deviceId, {
								type: "task_tool_lifecycle",
								taskId: task.id,
								botId: task.botId,
								attemptId: task.attemptId,
								...lifecycle,
							} as DeviceTaskToolLifecycleFrame),
						).catch(() => undefined);
						onProgress({
							phase: "tool",
							toolName: lifecycle.toolName,
							text: lifecycle.outputSnippet || lifecycle.summary || `[Tool ${lifecycle.toolName} ${lifecycle.phase}]`,
						});
					},
					onInteractions(items) {
						markActivity(task);
						hub.acceptInteractions(deviceId, {
							type: "task_interactions",
							taskId: task.id,
							attemptId: task.attemptId,
							botId: task.botId,
							items,
						});
					},
				});
			} catch (error) {
				// 运行时同步抛错（例如准入校验失败）也要落成终态，别让 Hub 只看到"投递失败"。
				void settle(task, "failed", deviceTaskFailure(error));
				return true;
			}
			void started
				.then(
					(result) => settle(task, "completed", typeof result === "string" ? result : undefined),
					(error) => settle(task, "failed", deviceTaskFailure(error)),
				)
				.catch((error: unknown) => {
					console.warn(
						`[LocalTaskBridge] 终态写回异常 task=${task.id}:`,
						error instanceof Error ? error.message : error,
					);
				});
			return true;
		},
		async cancelTask(target, taskId, attemptId) {
			if (!owns(target)) return { stopped: false };
			try {
				return { stopped: runtime.cancelScheduledTask(taskId, attemptId) === true };
			} catch {
				return { stopped: false };
			}
		},
		async steerTask(target, taskId, attemptId, text) {
			if (!owns(target)) return { steered: false };
			try {
				return { steered: (await runtime.steerTask(taskId, text, attemptId)) === true };
			} catch {
				return { steered: false };
			}
		},
		async answerInteraction(target, answer) {
			if (!owns(target)) return false;
			try {
				return runtime.answerTaskInteraction(answer.taskId, answer.attemptId, answer) === true;
			} catch {
				return false;
			}
		},
	};
}

/** `DeviceTaskEventFrame` 的类型标签在直调里不需要（不经过帧），但 Hub 侧契约仍要求带上。 */
export type LocalTaskEventFrame = Omit<DeviceTaskEventFrame, "type">;
