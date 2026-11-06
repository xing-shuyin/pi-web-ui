import type { DeviceWorkContract } from "../protocol.js";
import { assertValidWorkContract } from "./work-contract.js";
import type { HubState, Room } from "./store.js";
import {
	assertWorkItemStatus,
	boundedText,
	domainError,
	domainFingerprint,
	domainLease,
	domainNow,
	domainRoom,
	getWorkItem,
	type WorkItemStatus,
} from "./work-items.js";

export const ROUTER_TOOL_NAMES = ["reply", "dispatch", "work_items"] as const;
export type RouterToolName = (typeof ROUTER_TOOL_NAMES)[number];
export interface GroupRouterConfig {
	enabled: boolean;
	deviceId: string;
	model: string;
	thinkingLevel: string;
	tools: RouterToolName[];
}
export type RouterAction =
	| { type: "reply"; text: string }
	| {
			type: "dispatch";
			botId: string;
			text: string;
			workItemId?: string;
			executionMode?: "chat" | "code";
			contract?: DeviceWorkContract;
	  }
	| { type: "work_item_update"; workItemId: string; status: WorkItemStatus; summary?: string; revision: number };
export type RouterTrigger =
	| { type: "human_message"; messageId: string }
	| { type: "webhook_message"; messageId: string }
	| { type: "work_item"; workItemId: string; eventId: string }
	| { type: "task_result"; taskId: string };
export interface RouterJob {
	id: string;
	accountId: string;
	roomId: string;
	eventKey: string;
	trigger: RouterTrigger;
	text?: string;
	fingerprint: string;
	status: "queued" | "running" | "completed" | "failed";
	config: GroupRouterConfig;
	configRevision: number;
	deviceId?: string;
	leaseToken?: string;
	leaseExpiresAt?: number;
	attempts: number;
	actions?: RouterAction[];
	actionsInputFingerprint?: string;
	appliedActionCount: number;
	error?: string;
	createdAt: number;
	updatedAt: number;
}
export function validateGroupRouterConfig(value: unknown): GroupRouterConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) domainError("Invalid router config");
	const c = value as GroupRouterConfig;
	if (typeof c.enabled !== "boolean") domainError("Invalid router enabled");
	const deviceId = boundedText(c.deviceId, "router deviceId", 256),
		model = boundedText(c.model, "router model", 512),
		thinkingLevel = boundedText(c.thinkingLevel, "router thinkingLevel", 64);
	if (!/^[^/\s]+\/[^\s]+$/.test(model)) domainError("Router model must be provider/id");
	if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinkingLevel))
		domainError("Invalid router thinkingLevel");
	if (
		!Array.isArray(c.tools) ||
		c.tools.length > 3 ||
		new Set(c.tools).size !== c.tools.length ||
		c.tools.some((t) => !ROUTER_TOOL_NAMES.includes(t))
	)
		domainError("Invalid router tools");
	return { enabled: c.enabled, deviceId, model, thinkingLevel, tools: [...c.tools].sort() };
}
export function updateGroupRouterConfig(
	state: HubState,
	input: { accountId: string; roomId: string; config: GroupRouterConfig; revision?: number },
	now: number,
): Room {
	domainNow(now);
	const room = domainRoom(state, input.accountId, input.roomId),
		config = validateGroupRouterConfig(input.config);
	if (input.revision !== undefined && input.revision !== (room.routerRevision ?? 0))
		domainError("Router config revision conflict", 409);
	if (!state.devices.some((d) => d.id === config.deviceId && d.accountId === input.accountId))
		domainError("Router device not found", 404);
	room.router = config;
	room.routerRevision = (room.routerRevision ?? 0) + 1;
	return room;
}
function configMatches(room: Room, job: RouterJob): boolean {
	return (
		room.router?.enabled === true &&
		(room.routerRevision ?? 0) === job.configRevision &&
		domainFingerprint(validateGroupRouterConfig(room.router)) === domainFingerprint(job.config)
	);
}
function validateTrigger(state: HubState, accountId: string, roomId: string, trigger: RouterTrigger): boolean {
	if (trigger?.type === "webhook_message") {
		const message = state.messages.find(
			(m) => m.id === trigger.messageId && m.accountId === accountId && m.roomId === roomId,
		);
		if (!message) domainError("Router message not found", 404);
		return (
			message.sender.type === "webhook" &&
			!message.routerJobId &&
			(domainRoom(state, accountId, roomId).webhooks ?? []).some(
				(hook) =>
					hook.id === message.sender.id &&
					hook.type === "incoming" &&
					hook.enabled !== false &&
					hook.allowBotTrigger !== false,
			)
		);
	}
	if (trigger?.type === "human_message") {
		const message = state.messages.find(
			(m) => m.id === trigger.messageId && m.accountId === accountId && m.roomId === roomId,
		);
		if (!message) domainError("Router message not found", 404);
		return message.sender.type === "human" && !message.routerJobId;
	}
	if (trigger?.type === "work_item") {
		const item = getWorkItem(state, accountId, roomId, trigger.workItemId);
		return (
			routerExecutionAuthorized(state, { accountId, roomId, trigger }) &&
			!["blocked", "cancelled", "completed"].includes(item.status)
		);
	}
	if (trigger?.type === "task_result") {
		const task = state.tasks.find((t) => t.id === trigger.taskId && t.accountId === accountId && t.roomId === roomId);
		if (!task) domainError("Router task not found", 404);
		if (!["completed", "failed", "interrupted"].includes(task.status)) domainError("Task result is not settled", 409);
		return routerExecutionAuthorized(state, { accountId, roomId, trigger });
	}
	domainError("Invalid router trigger");
}
export function queueRouterJob(
	state: HubState,
	input: { accountId: string; roomId: string; eventKey: string; trigger: RouterTrigger; text?: string },
	now: number,
): RouterJob | undefined {
	domainNow(now);
	const room = domainRoom(state, input.accountId, input.roomId),
		eventKey = boundedText(input.eventKey, "router eventKey", 1024);
	if (input.text !== undefined) boundedText(input.text, "router text");
	const fingerprint = domainFingerprint({ trigger: input.trigger, text: input.text });
	const id = `rj_${domainFingerprint([input.accountId, input.roomId, eventKey])}`;
	const existing = state.routerJobs.find((j) => j.id === id);
	if (existing) {
		if (existing.fingerprint !== fingerprint) domainError("Router event fingerprint conflict", 409);
		return validateTrigger(state, input.accountId, input.roomId, input.trigger) ? existing : undefined;
	}
	if (!validateTrigger(state, input.accountId, input.roomId, input.trigger)) return undefined;
	const sameTrigger = state.routerJobs.find(
		(j) =>
			j.roomId === input.roomId &&
			j.accountId === input.accountId &&
			domainFingerprint(j.trigger) === domainFingerprint(input.trigger),
	);
	if (sameTrigger) {
		if (sameTrigger.fingerprint !== fingerprint) domainError("Router trigger fingerprint conflict", 409);
		return sameTrigger;
	}
	if (!room.router?.enabled) return undefined;
	const config = validateGroupRouterConfig(room.router);
	if (!state.devices.some((d) => d.id === config.deviceId && d.accountId === input.accountId))
		domainError("Router device not found", 404);
	const job: RouterJob = {
		id,
		accountId: input.accountId,
		roomId: input.roomId,
		eventKey,
		trigger: structuredClone(input.trigger),
		text: input.text,
		fingerprint,
		status: "queued",
		config,
		configRevision: room.routerRevision ?? 0,
		attempts: 0,
		appliedActionCount: 0,
		createdAt: now,
		updatedAt: now,
	};
	state.routerJobs.push(job);
	return job;
}
export function claimRouterJob(
	state: HubState,
	input: { accountId: string; roomId: string; deviceId: string; leaseToken: string; leaseMs?: number },
	now: number,
): RouterJob | undefined {
	domainNow(now);
	const room = domainRoom(state, input.accountId, input.roomId),
		token = boundedText(input.leaseToken, "router lease token", 256),
		leaseMs = domainLease(input.leaseMs);
	if (!state.devices.some((d) => d.id === input.deviceId && d.accountId === input.accountId))
		domainError("Router device not found", 404);
	const jobs = state.routerJobs.filter((j) => j.accountId === input.accountId && j.roomId === input.roomId);
	if (jobs.some((j) => j.status === "running" && (j.leaseExpiresAt ?? 0) > now)) return undefined;
	for (const job of jobs) {
		if (job.status !== "queued" && job.status !== "running") continue;
		if (!configMatches(room, job)) {
			job.status = "failed";
			job.error = "Router configuration changed";
			job.updatedAt = now;
			continue;
		}
		if (job.config.deviceId !== input.deviceId) return undefined;
		if (job.leaseToken === token) domainError("Lease token must be fresh", 409);
		job.status = "running";
		job.deviceId = input.deviceId;
		job.leaseToken = token;
		job.leaseExpiresAt = now + leaseMs;
		job.attempts++;
		job.updatedAt = now;
		return job;
	}
	return undefined;
}
export interface RouterLeaseInput {
	accountId: string;
	jobId: string;
	deviceId: string;
	leaseToken: string;
}
function heldJob(state: HubState, input: RouterLeaseInput, now: number): RouterJob {
	domainNow(now);
	const job = state.routerJobs.find((j) => j.id === input.jobId && j.accountId === input.accountId);
	if (!job) domainError("Router job not found", 404);
	const room = domainRoom(state, input.accountId, job.roomId);
	if (
		job.status !== "running" ||
		job.deviceId !== input.deviceId ||
		job.leaseToken !== input.leaseToken ||
		(job.leaseExpiresAt ?? 0) <= now ||
		!configMatches(room, job) ||
		!state.devices.some((d) => d.id === input.deviceId && d.accountId === input.accountId)
	)
		domainError("Stale router lease or config", 409);
	return job;
}
export function renewRouterJobLease(
	state: HubState,
	input: RouterLeaseInput & { leaseMs?: number },
	now: number,
): RouterJob {
	const job = heldJob(state, input, now);
	job.leaseExpiresAt = now + domainLease(input.leaseMs);
	job.updatedAt = now;
	return job;
}
function routerOriginWorkItem(state: HubState, job: Pick<RouterJob, "accountId" | "roomId" | "trigger">) {
	if (job.trigger.type === "work_item") return getWorkItem(state, job.accountId, job.roomId, job.trigger.workItemId);
	if (job.trigger.type !== "task_result") return undefined;
	const taskId = job.trigger.taskId;
	if (!state.tasks.some((t) => t.id === taskId && t.accountId === job.accountId && t.roomId === job.roomId))
		domainError("Router task not found", 404);
	const linked = state.workItems.filter((w) => w.taskIds.includes(taskId));
	if (linked.length > 1) domainError("Ambiguous task work item origin", 409);
	return linked[0] ? getWorkItem(state, job.accountId, job.roomId, linked[0].id) : undefined;
}
function routerExecutionAuthorized(state: HubState, job: Pick<RouterJob, "accountId" | "roomId" | "trigger">): boolean {
	const item = routerOriginWorkItem(state, job);
	if (!item) return true;
	if (item.authorization.mode !== "auto" || !item.sourceTrust.verified) return false;
	if (job.trigger.type !== "work_item") return true;
	const eventId = job.trigger.eventId;
	const event = state.workItemEvents.find(
		(e) =>
			(e.id === eventId || e.eventId === eventId) &&
			e.workItemId === item.id &&
			e.accountId === job.accountId &&
			e.roomId === job.roomId,
	);
	if (!event) domainError("Router work item event not found", 404);
	return (
		(event.authorization.mode === "auto" && event.sourceTrust.verified) ||
		(item.authorization.origin === "manual" && item.authorizedEventId === event.id)
	);
}
function assertRouterExecutionAuthorized(state: HubState, job: RouterJob): void {
	if (!routerExecutionAuthorized(state, job)) domainError("Work item event does not authorize execution", 403);
}
export function validateRouterActions(state: HubState, job: RouterJob, actions: unknown): RouterAction[] {
	if (!Array.isArray(actions) || actions.length > 16) domainError("Invalid router actions (maximum 16)");
	const room = domainRoom(state, job.accountId, job.roomId);
	assertRouterExecutionAuthorized(state, job);
	if (job.trigger.type === "webhook_message" && !validateTrigger(state, job.accountId, job.roomId, job.trigger))
		domainError("Webhook no longer authorizes router execution", 403);
	const origin = routerOriginWorkItem(state, job);
	const actionWorkItem = (workItemId: string) => {
		if (origin && origin.id !== workItemId) domainError("Action work item differs from source", 403);
		const item = getWorkItem(state, job.accountId, job.roomId, workItemId);
		if (item.authorization.mode !== "auto" || !item.sourceTrust.verified)
			domainError("Work item does not authorize execution", 403);
		return item;
	};
	const normalized = actions.map((raw: unknown): RouterAction => {
		if (!raw || typeof raw !== "object") domainError("Invalid router action");
		const a = raw as RouterAction;
		if (a.type === "reply") {
			if (!job.config.tools.includes("reply")) domainError("Router reply tool disabled", 403);
			return { type: a.type, text: boundedText(a.text, "reply text", 16384) };
		}
		if (a.type === "dispatch") {
			if (!job.config.tools.includes("dispatch")) domainError("Router dispatch tool disabled", 403);
			if (
				!room.botIds.includes(a.botId) ||
				!state.bots.some((b) => b.id === a.botId && b.accountId === job.accountId && b.enabled)
			)
				domainError("Dispatch bot is not an enabled room member", 403);
			boundedText(a.text, "dispatch text");
			const workItemId = a.workItemId ?? origin?.id;
			if (workItemId !== undefined) {
				const item = actionWorkItem(workItemId);
				if (["blocked", "cancelled", "completed"].includes(item.status))
					domainError("Work item does not authorize execution", 403);
			}
			if (a.executionMode !== undefined && a.executionMode !== "chat" && a.executionMode !== "code")
				domainError("Invalid dispatch execution mode");
			if (a.contract !== undefined) assertValidWorkContract(a.contract);
			return {
				type: a.type,
				botId: a.botId,
				text: a.text,
				...(workItemId !== undefined ? { workItemId } : {}),
				...(a.executionMode !== undefined ? { executionMode: a.executionMode } : {}),
				...(a.contract !== undefined ? { contract: structuredClone(a.contract) } : {}),
			};
		}
		if (a.type === "work_item_update") {
			if (!job.config.tools.includes("work_items")) domainError("Router work_items tool disabled", 403);
			actionWorkItem(a.workItemId);
			assertWorkItemStatus(a.status);
			if (!Number.isSafeInteger(a.revision) || a.revision < 1) domainError("Invalid work item revision");
			if (a.summary !== undefined) boundedText(a.summary, "work item summary", 8192);
			return {
				type: a.type,
				workItemId: a.workItemId,
				status: a.status,
				revision: a.revision,
				...(a.summary !== undefined ? { summary: a.summary } : {}),
			};
		}
		domainError("Unknown router action");
	});
	if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > 65536) domainError("Router actions exceed 64KB");
	return normalized;
}
export function prepareRouterActions(
	state: HubState,
	input: RouterLeaseInput & { actions: RouterAction[] },
	now: number,
): RouterJob {
	const job = heldJob(state, input, now);
	const fingerprint = domainFingerprint(input.actions);
	if (job.actions !== undefined) {
		if (job.actionsInputFingerprint !== fingerprint && domainFingerprint(job.actions) !== fingerprint)
			domainError("Router actions already frozen", 409);
		assertRouterExecutionAuthorized(state, job);
		return job;
	}
	job.actions = validateRouterActions(state, job, input.actions);
	job.actionsInputFingerprint = fingerprint;
	job.updatedAt = now;
	return job;
}
export function nextRouterAction(
	state: HubState,
	input: RouterLeaseInput,
	now: number,
): { action: RouterAction; index: number; key: string } | undefined {
	const job = heldJob(state, input, now);
	if (!job.actions) domainError("Router actions not prepared", 409);
	const index = job.appliedActionCount;
	const action = job.actions[index];
	if (!action) return undefined;
	const [validated] = validateRouterActions(state, job, [action]);
	if (
		validated.type === "work_item_update" &&
		validated.revision !== getWorkItem(state, job.accountId, job.roomId, validated.workItemId).revision
	)
		domainError("Work item revision conflict", 409);
	return { action: validated, index, key: routerActionKey(job, index) };
}
export function routerActionKey(job: Pick<RouterJob, "id">, index: number): string {
	if (!Number.isSafeInteger(index) || index < 0 || index >= 16) domainError("Invalid action index");
	return `${job.id}:${index}`;
}
export function markRouterActionApplied(
	state: HubState,
	input: RouterLeaseInput & { index: number },
	now: number,
): RouterJob {
	const job = heldJob(state, input, now);
	if (!Number.isSafeInteger(input.index) || input.index < 0 || !job.actions || input.index >= job.actions.length)
		domainError("Invalid prepared action index", 409);
	if (input.index < job.appliedActionCount) return job;
	if (input.index !== job.appliedActionCount) domainError("Router action order conflict", 409);
	job.appliedActionCount++;
	job.updatedAt = now;
	return job;
}
export function completeRouterJob(
	state: HubState,
	input: RouterLeaseInput & { actions?: RouterAction[] },
	now: number,
): RouterJob {
	const job = heldJob(state, input, now);
	if (input.actions !== undefined) prepareRouterActions(state, { ...input, actions: input.actions }, now);
	if (!job.actions || job.appliedActionCount !== job.actions.length)
		domainError("Router actions remain unapplied", 409);
	job.status = "completed";
	job.updatedAt = now;
	return job;
}
export function retryRouterJob(
	state: HubState,
	input: { accountId: string; roomId: string; jobId: string },
	now: number,
): RouterJob {
	domainNow(now);
	const room = domainRoom(state, input.accountId, input.roomId);
	const job = state.routerJobs.find(
		(j) => j.id === input.jobId && j.accountId === input.accountId && j.roomId === input.roomId,
	);
	if (!job) domainError("Router job not found", 404);
	if (job.status !== "failed") domainError("Only failed router jobs can be retried", 409);
	if (!configMatches(room, job)) domainError("Router configuration changed; start a new router job", 409);
	job.status = "queued";
	job.updatedAt = now;
	delete job.leaseToken;
	delete job.leaseExpiresAt;
	delete job.deviceId;
	delete job.error;
	return job;
}
export function failRouterJob(state: HubState, input: RouterLeaseInput & { error: string }, now: number): RouterJob {
	const job = heldJob(state, input, now);
	boundedText(input.error, "router error", 8192);
	job.status = "failed";
	job.error = input.error;
	job.updatedAt = now;
	return job;
}
