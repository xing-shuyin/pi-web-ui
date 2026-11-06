import { randomUUID } from "node:crypto";
import type { DeviceTaskEventFrame, DeviceTaskResultRejectReasonCode } from "../protocol.js";
import type { HubState, HubTask } from "./store.js";
import { isTerminal } from "./store.js";
import { groupTaskContext, type GroupTaskContext } from "./group-context.js";
import { queueParentResult, trimConversationHistory, trimRoomReceipts } from "./hub-conversations.js";

import type { DeviceExecutionSettings } from "./execution-settings.js";
import { computeOutcomeFingerprint, computeLegacyOutcomeFingerprint, deepFreeze } from "./task-outcome.js";
import { validateCodeArtifactOutcome, validateDeviceArtifact } from "./work-contract.js";

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
	permanent?: boolean;
	reasonCode?: DeviceTaskResultRejectReasonCode;
}
export const hasTaskLease = (task: HubTask) => !!task.leaseToken || task.leaseGeneration !== undefined;
export const isRecoveringTask = (task: HubTask, now: number) =>
	!task.outcomeFingerprint && typeof task.recoveryUntil === "number" && now <= task.recoveryUntil;

function effects(): TaskSettlementEffects {
	return { settledWakes: [], readyTaskIds: [], cascadedFailedTaskIds: [] };
}

export function recordTaskOutcome(
	draft: HubState,
	task: HubTask,
	outcome: Pick<
		DeviceTaskEventFrame,
		| "status"
		| "report"
		| "error"
		| "reportMetadata"
		| "fingerprint"
		| "artifact"
		| "executionCompleted"
		| "artifactProduced"
	>,
	ctx: TaskSettlementContext,
	now = Date.now(),
): TaskSettlementNotice | undefined {
	if (task.outcomeFingerprint) return;
	if (outcome.artifact !== undefined) {
		task.artifact = deepFreeze(structuredClone(outcome.artifact));
	}
	if (outcome.executionCompleted !== undefined) task.executionCompleted = outcome.executionCompleted;
	if (outcome.artifactProduced !== undefined) task.artifactProduced = outcome.artifactProduced;

	task.outcomeFingerprint =
		outcome.fingerprint ??
		computeOutcomeFingerprint(
			task.id,
			task.attemptId,
			outcome.status,
			outcome.report,
			outcome.error,
			outcome.reportMetadata,
			outcome.artifact?.digest,
			outcome.executionCompleted,
			outcome.artifactProduced,
		);
	task.outcomeCanonicalFingerprint = computeOutcomeFingerprint(
		task.id,
		task.attemptId,
		outcome.status,
		outcome.report,
		outcome.error,
		outcome.reportMetadata,
		outcome.artifact?.digest,
		outcome.executionCompleted,
		outcome.artifactProduced,
	);
	task.terminalAcceptedLeaseGeneration = task.leaseGeneration;
	task.status = outcome.status;
	task.updatedAt = now;
	delete task.recoveryUntil;
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

export function settleTaskDependencies(
	draft: HubState,
	ctx: TaskSettlementContext,
	now = Date.now(),
): TaskSettlementEffects {
	const result = effects();
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
				task.contract?.id &&
				pred.contract?.id &&
				task.contract.id === pred.contract.id &&
				task.contract.revision !== pred.contract.revision
			) {
				const report = `[契约版本冲突] 后继任务与依赖前置任务属于相同契约 (${task.contract.id}) 但版本不同 (后继 rev=${task.contract.revision}, 前置 rev=${pred.contract.revision})，跨版本依赖已终止。`;
				const notice = recordTaskOutcome(draft, task, { status: "failed", report }, ctx, now);
				delete task.blockReason;
				delete task.blockReasonDetail;
				if (notice) result.settledWakes.push(notice);
				result.cascadedFailedTaskIds.push(task.id);
				changed = true;
				continue;
			}

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
	if (!task) {
		if (device && bot && isTerminal(event.status) && !draft.tasks.some((entry) => entry.id === event.taskId))
			return { ...reject("Task attempt no longer exists", 404), permanent: true, reasonCode: "attempt_expired" };
		return reject("Task missing", 404);
	}
	if (!device || !bot || !draft.rooms.some((room) => room.id === task.roomId && room.botIds.includes(bot.id)))
		return reject("Task missing", 404);
	if (task.attemptId !== event.attemptId)
		return { ...reject("Attempt mismatch"), permanent: true, reasonCode: "attempt_expired" };
	if (!isTerminal(event.status)) return reject("Terminal outcome required", 400);
	const legacyLeaseMissing =
		event.leaseToken === undefined &&
		event.leaseGeneration === undefined &&
		event.artifact === undefined &&
		event.executionCompleted === undefined &&
		event.artifactProduced === undefined &&
		event.fingerprint ===
			computeLegacyOutcomeFingerprint(
				task.id,
				task.attemptId,
				event.status,
				event.report,
				event.error,
				event.reportMetadata,
			);
	if (legacyLeaseMissing && (hasTaskLease(task) || isTerminal(task.status))) {
		if (!isTerminal(task.status) || (!task.outcomeFingerprint && task.recoveryUntil !== undefined))
			return {
				...reject("Legacy outcome has no recoverable lease proof; retain evidence for manual recovery"),
				permanent: true,
				reasonCode: "legacy_lease_missing",
			};
		const displayReport =
			event.report ||
			event.error ||
			(event.status === "failed"
				? "Task execution failed without a report."
				: "Task execution was interrupted without a report.");
		if (
			task.status !== event.status ||
			task.report !== displayReport ||
			task.error !== event.error ||
			JSON.stringify(task.reportMetadata) !== JSON.stringify(event.reportMetadata) ||
			task.artifact !== undefined ||
			task.executionCompleted !== undefined ||
			task.artifactProduced !== undefined ||
			task.executionMode === "code" ||
			task.contract?.executionMode === "code"
		)
			return { ...reject("Conflicting duplicate terminal outcome"), permanent: true, reasonCode: "terminal_conflict" };
		return { accepted: true, duplicate: true, fingerprint: event.fingerprint, task };
	}
	if (task.leaseToken !== event.leaseToken || task.leaseGeneration !== event.leaseGeneration)
		return reject("Lease token or generation mismatch");
	if (event.status === "completed" && (task.cancelRequested || task.stopConfirmed) && !task.outcomeFingerprint)
		return reject("Task stop requested");
	if (event.status === "completed" && !event.report) return reject("Completed task requires agent report", 400);

	if (event.executionCompleted !== undefined && typeof event.executionCompleted !== "boolean") {
		return reject("Execution proof 'executionCompleted' must be a boolean when present", 400);
	}
	if (event.artifactProduced !== undefined && typeof event.artifactProduced !== "boolean") {
		return reject("Artifact proof 'artifactProduced' must be a boolean when present", 400);
	}

	if (event.artifact !== undefined) {
		const checked = validateDeviceArtifact(event.artifact);
		if (!checked.valid) return reject(`Artifact validation failed: ${checked.reason}`, 400);
		event = { ...event, artifact: checked.artifact };
	}
	const isCode = task.executionMode === "code" || task.contract?.executionMode === "code";
	if (isCode) {
		const codeRes = validateCodeArtifactOutcome({
			task,
			artifact: event.artifact,
			executionCompleted: event.executionCompleted,
			artifactProduced: event.artifactProduced,
		});
		if (!codeRes.valid) return reject(`Code artifact validation failed: ${codeRes.reason}`);
		if (event.status === "completed" && (event.artifactProduced !== true || !event.artifact)) {
			return reject("Completed code task requires verified artifactProduced proof and artifact", 400);
		}
	}

	const hasProofOrArtifact =
		event.artifact !== undefined || event.executionCompleted !== undefined || event.artifactProduced !== undefined;

	const canonical = computeOutcomeFingerprint(
		task.id,
		task.attemptId,
		event.status,
		event.report,
		event.error,
		event.reportMetadata,
		event.artifact?.digest,
		event.executionCompleted,
		event.artifactProduced,
	);

	if (hasProofOrArtifact) {
		if (event.fingerprint !== undefined && event.fingerprint !== canonical) {
			return reject("Outcome fingerprint mismatch (v46 artifact proof must match canonical digest)");
		}
	} else {
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
	}

	const fingerprint = event.fingerprint ?? canonical;
	if (task.recoveryUntil !== undefined && !task.outcomeFingerprint && !isRecoveringTask(task, Date.now()))
		return reject("Recovery window expired");
	if (isTerminal(task.status) && !isRecoveringTask(task, Date.now())) {
		const taskHasProofOrArtifact =
			task.artifact !== undefined || task.executionCompleted !== undefined || task.artifactProduced !== undefined;
		const existing =
			task.outcomeFingerprint ??
			computeOutcomeFingerprint(
				task.id,
				task.attemptId,
				task.status,
				task.report,
				typeof task.error === "string" ? task.error : undefined,
				task.reportMetadata,
				task.artifact?.digest,
				task.executionCompleted,
				task.artifactProduced,
			);
		const displayReport =
			event.report ||
			event.error ||
			(event.status === "failed"
				? "Task execution failed without a report."
				: "Task execution was interrupted without a report.");
		const artifactMatches = task.artifact?.digest === event.artifact?.digest;
		const proofMatches =
			task.executionCompleted === event.executionCompleted && task.artifactProduced === event.artifactProduced;

		let sameContent = false;
		if (taskHasProofOrArtifact || hasProofOrArtifact) {
			sameContent =
				task.outcomeCanonicalFingerprint === canonical &&
				task.status === event.status &&
				artifactMatches &&
				proofMatches;
		} else {
			const legacy = computeLegacyOutcomeFingerprint(
				task.id,
				task.attemptId,
				event.status,
				event.report,
				event.error,
				event.reportMetadata,
			);
			sameContent = task.outcomeCanonicalFingerprint
				? task.outcomeCanonicalFingerprint === canonical
				: (existing === canonical || existing === legacy) &&
					task.report === displayReport &&
					task.error === event.error &&
					JSON.stringify(task.reportMetadata) === JSON.stringify(event.reportMetadata);
		}
		if (!sameContent || task.status !== event.status)
			return { ...reject("Conflicting duplicate terminal outcome"), permanent: true, reasonCode: "terminal_conflict" };
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
