import { randomUUID } from "node:crypto";
import type { DeviceTaskEventFrame } from "../protocol.js";
import type { HubState, HubTask } from "./store.js";
import { isTerminal } from "./store.js";
import { groupTaskContext, type GroupTaskContext } from "./group-context.js";
import { queueParentResult, trimConversationHistory, trimRoomReceipts } from "./hub-conversations.js";

import type { DeviceExecutionSettings } from "./execution-settings.js";
import { computeOutcomeFingerprint, computeLegacyOutcomeFingerprint } from "./task-outcome.js";

export interface TaskSettlementContext {
	settings: DeviceExecutionSettings;
	getHistoryLimit: () => number;
}
export interface TaskSettlementNotice {
	taskId: string;
	roomId: string;
	conversationId?: string;
	wake?: HubTask;
	context?: GroupTaskContext;
}
export interface TaskSettlementEffects {
	settledWakes: TaskSettlementNotice[];
	readyTaskIds: string[];
	cascadedFailedTaskIds: string[];
}
export interface TaskSettlementResult extends Partial<TaskSettlementEffects> {
	accepted: boolean;
	duplicate: boolean;
	fingerprint?: string;
	task?: HubTask;
	reason?: string;
	statusCode?: number;
}
export const hasTaskLease = (task: HubTask) => !!task.leaseToken || task.leaseGeneration !== undefined;
export const isRecoveringTask = (task: HubTask, now: number) =>
	!task.outcomeFingerprint && typeof task.recoveryUntil === "number" && now <= task.recoveryUntil;

function effects(): TaskSettlementEffects {
	return { settledWakes: [], readyTaskIds: [], cascadedFailedTaskIds: [] };
}

/** Record the outcome and its notifications in the same store transaction, exactly once. */
export function recordTaskOutcome(
	draft: HubState,
	task: HubTask,
	outcome: Pick<DeviceTaskEventFrame, "status" | "report" | "error" | "reportMetadata" | "fingerprint">,
	ctx: TaskSettlementContext,
	now = Date.now(),
): TaskSettlementNotice | undefined {
	if (task.outcomeFingerprint) return;
	task.outcomeFingerprint =
		outcome.fingerprint ??
		computeOutcomeFingerprint(
			task.id,
			task.attemptId,
			outcome.status,
			outcome.report,
			outcome.error,
			outcome.reportMetadata,
		);
	task.outcomeCanonicalFingerprint = computeOutcomeFingerprint(
		task.id,
		task.attemptId,
		outcome.status,
		outcome.report,
		outcome.error,
		outcome.reportMetadata,
	);
	task.terminalAcceptedLeaseGeneration = task.leaseGeneration;
	task.status = outcome.status;
	task.updatedAt = now;
	delete task.recoveryUntil;
	// Fallback display text is deliberately outside the wire outcome fingerprint.
	task.report =
		outcome.report ||
		outcome.error ||
		(outcome.status === "failed"
			? "Task execution failed without a report."
			: "Task execution was interrupted without a report.");
	if (outcome.error) task.error = outcome.error;
	else delete task.error;
	task.reportMetadata = outcome.reportMetadata;
	const bot = draft.bots.find((entry) => entry.id === task.botId && entry.accountId === task.accountId);
	draft.messages.push({
		id: randomUUID(),
		roomId: task.roomId,
		accountId: task.accountId,
		text: task.report,
		sender: { type: "bot", id: task.botId, name: bot?.name ?? task.botId, sourceDeviceId: task.deviceId },
		createdAt: now,
		taskIds: [task.id],
		conversationId: task.conversationId,
	});
	if (task.conversationId)
		draft.conversationMessages.push({
			id: randomUUID(),
			conversationId: task.conversationId,
			taskId: task.id,
			kind: "result",
			text: task.report,
			sourceBotId: task.botId,
			requestId: task.requestId,
			createdAt: now,
		});
	const removed = new Set(
		draft.messages
			.filter((m) => m.roomId === task.roomId)
			.slice(0, -ctx.getHistoryLimit())
			.map((m) => m.id),
	);
	draft.messages = draft.messages.filter((m) => !removed.has(m.id));
	trimRoomReceipts(draft, task.roomId);
	const room = draft.rooms.find((entry) => entry.id === task.roomId);
	const context = room ? groupTaskContext(room, draft.bots, draft.messages, ctx.settings.groupContextBytes) : undefined;
	const wake = queueParentResult(draft, task, ctx.settings);
	trimConversationHistory(draft, task.roomId);
	return { taskId: task.id, roomId: task.roomId, conversationId: task.conversationId, wake, context };
}

/** One dependency rule for creation, completion, delivery checks and crash recovery. */
export function settleTaskDependencies(
	draft: HubState,
	ctx: TaskSettlementContext,
	now = Date.now(),
): TaskSettlementEffects {
	const result = effects();
	// Each pass either promotes or terminates waiting work. Iterate to cover arbitrarily ordered chains.
	let changed: boolean;
	do {
		changed = false;
		for (const task of draft.tasks) {
			if (
				!task.dependsOnTaskId ||
				!["waiting", "queued"].includes(task.status) ||
				hasTaskLease(task) ||
				task.outcomeFingerprint
			)
				continue;
			const pred = draft.tasks.find(
				(p) => p.id === task.dependsOnTaskId && p.roomId === task.roomId && p.accountId === task.accountId,
			);
			if (
				pred &&
				!pred.cancelRequested &&
				!pred.stopConfirmed &&
				(isRecoveringTask(pred, now) || !isTerminal(pred.status))
			) {
				if (task.status === "queued") {
					task.status = "waiting";
					task.blockReason = "dependency_waiting";
					task.blockReasonDetail = `Waiting for dependency task ${pred.id}`;
					task.updatedAt = now;
					changed = true;
				}
				continue;
			}
			if (pred?.status === "completed" && !pred.cancelRequested && !pred.stopConfirmed) {
				if (task.status !== "waiting" || task.blockReason === "resource_locked") continue;
				task.status = "queued";
				delete task.blockReason;
				delete task.blockReasonDetail;
				task.updatedAt = now;
				if (pred.report)
					task.text = `[前序任务输出：\n${pred.report.slice(0, 2000)}${pred.report.length > 2000 ? "..." : ""}\n]\n\n${task.text}`;
				result.readyTaskIds.push(task.id);
			} else {
				const report = `[前序任务未成功] 依赖的前置任务 ${task.dependsOnTaskId} 未成功，后继任务终止。`;
				const notice = recordTaskOutcome(draft, task, { status: "failed", report }, ctx, now);
				delete task.blockReason;
				delete task.blockReasonDetail;
				if (notice) result.settledWakes.push(notice);
				result.cascadedFailedTaskIds.push(task.id);
			}
			changed = true;
		}
	} while (changed);
	return result;
}

/** Validate a device's immutable terminal payload before making any draft changes. */
export function settleTaskTerminalOutcome(
	draft: HubState,
	deviceId: string,
	event: DeviceTaskEventFrame,
	ctx: TaskSettlementContext,
): TaskSettlementResult {
	const reject = (reason: string, statusCode = 409): TaskSettlementResult => ({
		accepted: false,
		duplicate: false,
		reason,
		statusCode,
	});
	const device = draft.devices.find((entry) => entry.id === deviceId);
	const task = draft.tasks.find(
		(entry) =>
			entry.id === event.taskId &&
			entry.deviceId === deviceId &&
			entry.botId === event.botId &&
			entry.accountId === device?.accountId,
	);
	const bot = draft.bots.find(
		(entry) => entry.id === event.botId && entry.deviceId === deviceId && entry.accountId === device?.accountId,
	);
	if (!task || !device || !bot || !draft.rooms.some((room) => room.id === task.roomId && room.botIds.includes(bot.id)))
		return reject("Task missing", 404);
	if (task.attemptId !== event.attemptId) return reject("Attempt mismatch");
	if (task.leaseToken !== event.leaseToken || task.leaseGeneration !== event.leaseGeneration)
		return reject("Lease token or generation mismatch");
	if (!isTerminal(event.status)) return reject("Terminal outcome required", 400);
	if (event.status === "completed" && (task.cancelRequested || task.stopConfirmed))
		return reject("Task stop requested");
	if (event.status === "completed" && !event.report) return reject("Completed task requires agent report", 400);
	const canonical = computeOutcomeFingerprint(
		task.id,
		task.attemptId,
		event.status,
		event.report,
		event.error,
		event.reportMetadata,
	);
	const legacy = computeLegacyOutcomeFingerprint(
		task.id,
		task.attemptId,
		event.status,
		event.report,
		event.error,
		event.reportMetadata,
	);
	if (event.fingerprint !== undefined && event.fingerprint !== canonical && event.fingerprint !== legacy)
		return reject("Outcome fingerprint mismatch");
	const fingerprint = event.fingerprint ?? canonical;
	if (task.recoveryUntil !== undefined && !task.outcomeFingerprint && !isRecoveringTask(task, Date.now()))
		return reject("Recovery window expired");
	if (isTerminal(task.status) && !isRecoveringTask(task, Date.now())) {
		const existing =
			task.outcomeFingerprint ??
			computeOutcomeFingerprint(
				task.id,
				task.attemptId,
				task.status,
				task.report,
				typeof task.error === "string" ? task.error : undefined,
				task.reportMetadata,
			);
		const displayReport =
			event.report ||
			event.error ||
			(event.status === "failed"
				? "Task execution failed without a report."
				: "Task execution was interrupted without a report.");
		const sameContent = task.outcomeCanonicalFingerprint
			? task.outcomeCanonicalFingerprint === canonical
			: (existing === canonical || existing === legacy) &&
				task.report === displayReport &&
				task.error === event.error &&
				JSON.stringify(task.reportMetadata) === JSON.stringify(event.reportMetadata);
		if (!sameContent || task.status !== event.status) return reject("Conflicting duplicate terminal outcome");
		if (!task.outcomeFingerprint) {
			task.outcomeFingerprint = existing;
			task.terminalAcceptedLeaseGeneration = task.leaseGeneration;
		}
		if (!task.outcomeCanonicalFingerprint) task.outcomeCanonicalFingerprint = canonical;
		return { accepted: true, duplicate: true, fingerprint: existing, task };
	}
	if (event.status !== "interrupted" && (!bot.enabled || bot.revision !== task.botRevision))
		return reject("Bot configuration changed");
	if (
		task.status !== "running" &&
		!(task.status === "queued" && hasTaskLease(task)) &&
		!isRecoveringTask(task, Date.now()) &&
		!(task.status === "queued" && event.status === "interrupted")
	)
		return reject("Invalid task transition");
	const notice = recordTaskOutcome(draft, task, { ...event, fingerprint }, ctx);
	const result = settleTaskDependencies(draft, ctx);
	if (notice) result.settledWakes.unshift(notice);
	return { accepted: true, duplicate: false, fingerprint, task, ...result };
}

export function rescanReadyTasksOnRecovery(
	draft: HubState,
	now: number,
	recoveryGraceMs: number,
	ctx: TaskSettlementContext,
): TaskSettlementEffects {
	for (const task of draft.tasks) {
		if (
			(task.status === "running" || (task.status === "queued" && hasTaskLease(task))) &&
			!task.outcomeFingerprint &&
			task.recoveryUntil === undefined
		)
			task.recoveryUntil = now + recoveryGraceMs;
	}
	const result = sweepExpiredRecoveryLeases(draft, now, ctx);
	// A crash may occur after storing a terminal outcome but before its parent continuation is queued.
	for (const task of [...draft.tasks]) {
		if (!isTerminal(task.status) || isRecoveringTask(task, now)) continue;
		const wake = queueParentResult(draft, task, ctx.settings);
		if (wake)
			result.settledWakes.push({ taskId: task.id, roomId: task.roomId, conversationId: task.conversationId, wake });
	}
	return result;
}

export function sweepExpiredRecoveryLeases(
	draft: HubState,
	now: number,
	ctx: TaskSettlementContext,
): TaskSettlementEffects {
	const result = effects();
	for (const task of [...draft.tasks]) {
		if (task.outcomeFingerprint) continue;
		const windowExpired = typeof task.recoveryUntil === "number" && now > task.recoveryUntil;
		const leaseExpired =
			(task.status === "running" || (task.status === "queued" && hasTaskLease(task))) &&
			task.lastHeartbeatAt !== undefined &&
			now - task.lastHeartbeatAt > 30 * 60_000;
		if (!windowExpired && !leaseExpired) continue;
		const notice = recordTaskOutcome(
			draft,
			task,
			{
				status: "interrupted",
				report: windowExpired
					? "Hub restarted; recovery window expired without reconnect claim."
					: "Task lease expired due to prolonged inactivity.",
			},
			ctx,
			now,
		);
		if (notice) result.settledWakes.push(notice);
	}
	const dependencies = settleTaskDependencies(draft, ctx, now);
	result.settledWakes.push(...dependencies.settledWakes);
	result.readyTaskIds.push(...dependencies.readyTaskIds);
	result.cascadedFailedTaskIds.push(...dependencies.cascadedFailedTaskIds);
	return result;
}
