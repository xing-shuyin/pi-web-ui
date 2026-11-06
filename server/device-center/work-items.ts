import { createHash } from "node:crypto";
import type { HubState, Room } from "./store.js";

export type WorkItemStatus = "open" | "running" | "waiting" | "blocked" | "completed" | "cancelled";
export type WorkItemMode = "observe" | "auto";
export interface WorkItemSource {
	provider: string;
	channelId: string;
	threadId: string;
}
export interface WorkItemAuthor {
	id: string;
	name?: string;
}
export interface WorkItemTrust {
	connectorId: string;
	verified: boolean;
}
export interface WorkItemAuthorization {
	mode: WorkItemMode;
	authorizedBy: string;
	origin?: "policy" | "manual";
}
export interface WorkItem {
	id: string;
	accountId: string;
	roomId: string;
	source: WorkItemSource;
	title: string;
	text: string;
	author: WorkItemAuthor;
	sourceTrust: WorkItemTrust;
	authorization: WorkItemAuthorization;
	authorizedEventId?: string;
	status: WorkItemStatus;
	summary?: string;
	revision: number;
	taskIds: string[];
	createdAt: number;
	updatedAt: number;
}
export interface WorkItemEvent {
	id: string;
	eventId: string;
	kind?: string;
	accountId: string;
	roomId: string;
	workItemId: string;
	source: WorkItemSource;
	author: WorkItemAuthor;
	sourceTrust: WorkItemTrust;
	authorization: WorkItemAuthorization;
	text: string;
	fingerprint: string;
	createdAt: number;
}
export interface WorkItemOutbox {
	id: string;
	accountId: string;
	roomId: string;
	workItemId: string;
	source: WorkItemSource;
	key: string;
	text: string;
	fingerprint: string;
	status: "queued" | "running" | "completed";
	attempts: number;
	nextAttemptAt: number;
	leaseToken?: string;
	deviceId?: string;
	leaseExpiresAt?: number;
	error?: string;
	externalId?: string;
	createdAt: number;
	updatedAt: number;
}
export function domainError(message: string, status = 400): never {
	throw Object.assign(new Error(message), { status });
}
export function boundedText(value: unknown, name: string, max = 32768): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) domainError(`Invalid ${name}`);
	return value;
}
export function domainRoom(state: HubState, accountId: string, roomId: string): Room {
	const room = state.rooms.find((r) => r.id === roomId && r.accountId === accountId);
	if (!room) domainError("Room not found", 404);
	return room;
}
export function domainFingerprint(value: unknown): string {
	const canonical = (v: unknown): string => {
		if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
		if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
		return `{${Object.keys(v)
			.filter((k) => (v as Record<string, unknown>)[k] !== undefined)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	};
	return createHash("sha256").update(canonical(value)).digest("hex");
}
export function domainNow(now: number): void {
	if (!Number.isSafeInteger(now) || now < 0) domainError("Invalid timestamp");
}
export function domainLease(ms = 60000): number {
	if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 600000) domainError("Invalid lease duration");
	return ms;
}
export function assertWorkItemStatus(status: unknown): asserts status is WorkItemStatus {
	if (!["open", "running", "waiting", "blocked", "completed", "cancelled"].includes(status as string))
		domainError("Invalid work item status");
}
function normalizeSource(source: WorkItemSource): WorkItemSource {
	return {
		provider: boundedText(source?.provider, "provider", 128),
		channelId: boundedText(source?.channelId, "channelId", 512),
		threadId: boundedText(source?.threadId, "threadId", 512),
	};
}
function normalizeAuthor(author: WorkItemAuthor): WorkItemAuthor {
	return {
		id: boundedText(author?.id, "author id", 512),
		...(author?.name !== undefined ? { name: boundedText(author.name, "author name", 512) } : {}),
	};
}
function normalizeTrust(trust: WorkItemTrust): WorkItemTrust {
	if (typeof trust?.verified !== "boolean") domainError("Invalid source trust");
	return { connectorId: boundedText(trust.connectorId, "connector id", 256), verified: trust.verified };
}
function normalizeAuthorization(auth: WorkItemAuthorization, trust: WorkItemTrust): WorkItemAuthorization {
	if (auth?.mode !== "observe" && auth?.mode !== "auto") domainError("Invalid authorization mode");
	if (auth.mode === "auto" && !trust.verified) domainError("Unverified source cannot authorize auto execution", 403);
	if (auth.origin !== undefined && auth.origin !== "policy" && auth.origin !== "manual")
		domainError("Invalid authorization origin");
	return {
		mode: auth.mode,
		authorizedBy: boundedText(auth.authorizedBy, "authorization principal", 512),
		origin: auth.origin ?? "policy",
	};
}
export interface CreateWorkItemInput {
	accountId: string;
	roomId: string;
	source: WorkItemSource;
	title: string;
	text: string;
	author: WorkItemAuthor;
	sourceTrust: WorkItemTrust;
	authorization: WorkItemAuthorization;
}
export function createWorkItem(state: HubState, input: CreateWorkItemInput, now: number): WorkItem {
	domainRoom(state, input.accountId, input.roomId);
	domainNow(now);
	const source = normalizeSource(input.source),
		author = normalizeAuthor(input.author),
		sourceTrust = normalizeTrust(input.sourceTrust);
	const authorization = normalizeAuthorization(input.authorization, sourceTrust);
	const id = `wi_${domainFingerprint([input.accountId, input.roomId, source])}`;
	const title = boundedText(input.title, "title", 512),
		text = boundedText(input.text, "text");
	const existing = state.workItems.find((w) => w.id === id);
	if (existing) return existing;
	const item: WorkItem = {
		id,
		accountId: input.accountId,
		roomId: input.roomId,
		source,
		title,
		text,
		author,
		sourceTrust,
		authorization,
		status: "open",
		revision: 1,
		taskIds: [],
		createdAt: now,
		updatedAt: now,
	};
	state.workItems.push(item);
	return item;
}
export interface IngestWorkItemEventInput extends CreateWorkItemInput {
	eventId: string;
	kind?: string;
}
export function ingestWorkItemEvent(
	state: HubState,
	input: IngestWorkItemEventInput,
	now: number,
): { workItem: WorkItem; event: WorkItemEvent; duplicate: boolean } {
	domainRoom(state, input.accountId, input.roomId);
	domainNow(now);
	const source = normalizeSource(input.source),
		author = normalizeAuthor(input.author),
		sourceTrust = normalizeTrust(input.sourceTrust);
	const authorization = normalizeAuthorization({ ...input.authorization, origin: "policy" }, sourceTrust),
		text = boundedText(input.text, "text"),
		title = boundedText(input.title, "title", 512);
	const eventId = boundedText(input.eventId, "eventId", 512);
	const kind = input.kind === undefined ? undefined : boundedText(input.kind, "event kind", 256);
	const id = `wie_${domainFingerprint([input.accountId, source.provider, source.channelId, eventId])}`;
	const fingerprint = domainFingerprint({
		roomId: input.roomId,
		source,
		author,
		sourceTrust,
		authorization,
		text,
		title,
		kind,
	});
	const previous = state.workItemEvents.find((e) => e.id === id);
	if (previous) {
		if (previous.fingerprint !== fingerprint) domainError("Event payload fingerprint conflict", 409);
		const workItem = state.workItems.find((w) => w.id === previous.workItemId);
		if (!workItem) domainError("Event work item missing", 409);
		return { workItem, event: previous, duplicate: true };
	}
	const workItem = createWorkItem(state, { ...input, source, author, sourceTrust, authorization }, now);
	if (state.workItemEvents.some((e) => e.workItemId === workItem.id)) {
		workItem.updatedAt = now;
	}
	const event: WorkItemEvent = {
		id,
		eventId,
		...(kind !== undefined ? { kind } : {}),
		accountId: input.accountId,
		roomId: input.roomId,
		workItemId: workItem.id,
		source,
		author,
		sourceTrust,
		authorization,
		text,
		fingerprint,
		createdAt: now,
	};
	state.workItemEvents.push(event);
	return { workItem, event, duplicate: false };
}
export function getWorkItem(state: HubState, accountId: string, roomId: string, workItemId: string): WorkItem {
	domainRoom(state, accountId, roomId);
	const item = state.workItems.find((w) => w.id === workItemId && w.accountId === accountId && w.roomId === roomId);
	if (!item) domainError("Work item not found", 404);
	return item;
}
export function linkWorkItemTasks(
	state: HubState,
	input: { accountId: string; roomId: string; workItemId: string; taskIds: string[] },
	now: number,
): WorkItem {
	domainNow(now);
	const item = getWorkItem(state, input.accountId, input.roomId, input.workItemId);
	if (!Array.isArray(input.taskIds) || input.taskIds.length > 100) domainError("Invalid taskIds");
	for (const id of input.taskIds) {
		boundedText(id, "task id", 512);
		if (
			!state.tasks.some((task) => task.id === id && task.accountId === input.accountId && task.roomId === input.roomId)
		)
			domainError("Task not found", 404);
		if (state.workItems.some((other) => other.id !== item.id && other.taskIds.includes(id)))
			domainError("Task already belongs to another work item", 409);
	}
	const taskIds = [...new Set([...item.taskIds, ...input.taskIds])];
	if (taskIds.length > 1000) domainError("Too many work item tasks", 409);
	if (taskIds.length !== item.taskIds.length) {
		item.taskIds = taskIds;
		item.updatedAt = now;
	}
	return item;
}
export function updateWorkItem(
	state: HubState,
	input: {
		accountId: string;
		roomId: string;
		workItemId: string;
		revision: number;
		status?: WorkItemStatus;
		summary?: string;
		taskIds?: string[];
	},
	now: number,
): WorkItem {
	domainNow(now);
	const item = getWorkItem(state, input.accountId, input.roomId, input.workItemId);
	if (input.revision !== item.revision) domainError("Work item revision conflict", 409);
	if (input.status !== undefined) assertWorkItemStatus(input.status);
	if (input.summary !== undefined) boundedText(input.summary, "summary", 8192);
	if (input.taskIds !== undefined) linkWorkItemTasks(state, { ...input, taskIds: input.taskIds }, now);
	const changed = input.status !== undefined || input.summary !== undefined;
	if (input.status !== undefined) item.status = input.status;
	if (input.summary !== undefined) item.summary = input.summary;
	if (changed) {
		item.revision++;
		item.updatedAt = now;
	}
	return item;
}
export function authorizeWorkItem(
	state: HubState,
	input: {
		accountId: string;
		roomId: string;
		workItemId: string;
		revision: number;
		authorization: WorkItemAuthorization;
	},
	now: number,
): WorkItem {
	domainNow(now);
	const item = getWorkItem(state, input.accountId, input.roomId, input.workItemId);
	if (input.revision !== item.revision) domainError("Work item revision conflict", 409);
	const authorization = normalizeAuthorization(
		{ ...input.authorization, origin: input.authorization.origin ?? "manual" },
		item.sourceTrust,
	);
	item.authorization = authorization;
	delete item.authorizedEventId;
	if (authorization.mode === "auto" && authorization.origin === "manual") {
		const latest = state.workItemEvents.findLast(
			(event) => event.workItemId === item.id && event.accountId === item.accountId && event.roomId === item.roomId,
		);
		if (latest) item.authorizedEventId = latest.id;
	}
	item.revision++;
	item.updatedAt = now;
	return item;
}
export function queueWorkItemOutbox(
	state: HubState,
	input: { accountId: string; roomId: string; workItemId: string; key: string; text: string },
	now: number,
): WorkItemOutbox {
	domainNow(now);
	const item = getWorkItem(state, input.accountId, input.roomId, input.workItemId);
	const key = boundedText(input.key, "outbox key", 512),
		text = boundedText(input.text, "outbox text");
	const id = `wio_${domainFingerprint([item.id, key])}`,
		fingerprint = domainFingerprint({ source: item.source, text });
	const existing = state.workItemOutbox.find((o) => o.id === id);
	if (existing) {
		if (existing.fingerprint !== fingerprint) domainError("Outbox fingerprint conflict", 409);
		return existing;
	}
	const outbox: WorkItemOutbox = {
		id,
		accountId: item.accountId,
		roomId: item.roomId,
		workItemId: item.id,
		source: structuredClone(item.source),
		key,
		text,
		fingerprint,
		status: "queued",
		attempts: 0,
		nextAttemptAt: now,
		createdAt: now,
		updatedAt: now,
	};
	state.workItemOutbox.push(outbox);
	return outbox;
}
export function claimWorkItemOutbox(
	state: HubState,
	input: {
		accountId: string;
		roomId: string;
		deviceId: string;
		leaseToken: string;
		leaseMs?: number;
		provider?: string;
	},
	now: number,
): WorkItemOutbox | undefined {
	domainRoom(state, input.accountId, input.roomId);
	domainNow(now);
	if (!state.devices.some((d) => d.id === input.deviceId && d.accountId === input.accountId))
		domainError("Device not found", 404);
	const token = boundedText(input.leaseToken, "lease token", 256),
		leaseMs = domainLease(input.leaseMs);
	if (input.provider !== undefined) boundedText(input.provider, "provider", 128);
	const row = state.workItemOutbox.find(
		(o) =>
			o.accountId === input.accountId &&
			o.roomId === input.roomId &&
			(input.provider === undefined || o.source.provider === input.provider) &&
			state.workItems.some(
				(item) =>
					item.id === o.workItemId &&
					item.accountId === o.accountId &&
					item.roomId === o.roomId &&
					item.authorization.mode === "auto" &&
					item.sourceTrust.verified &&
					!["blocked", "cancelled"].includes(item.status) &&
					domainFingerprint(item.source) === domainFingerprint(o.source),
			) &&
			o.status !== "completed" &&
			o.nextAttemptAt <= now &&
			(o.status === "queued" || (o.leaseExpiresAt ?? 0) <= now),
	);
	if (!row) return undefined;
	if (row.leaseToken === token) domainError("Lease token must be fresh", 409);
	row.status = "running";
	row.deviceId = input.deviceId;
	row.leaseToken = token;
	row.leaseExpiresAt = now + leaseMs;
	row.attempts++;
	row.updatedAt = now;
	return row;
}
function heldOutbox(
	state: HubState,
	input: { accountId: string; outboxId: string; deviceId: string; leaseToken: string },
	now: number,
): WorkItemOutbox {
	domainNow(now);
	const row = state.workItemOutbox.find((o) => o.id === input.outboxId && o.accountId === input.accountId);
	if (!row) domainError("Outbox not found", 404);
	domainRoom(state, input.accountId, row.roomId);
	if (
		row.status !== "running" ||
		row.deviceId !== input.deviceId ||
		row.leaseToken !== input.leaseToken ||
		(row.leaseExpiresAt ?? 0) <= now ||
		!state.devices.some((d) => d.id === input.deviceId && d.accountId === input.accountId)
	)
		domainError("Stale outbox lease", 409);
	return row;
}
export function ackWorkItemOutbox(
	state: HubState,
	input: { accountId: string; outboxId: string; deviceId: string; leaseToken: string; externalId?: string },
	now: number,
): WorkItemOutbox {
	const row = heldOutbox(state, input, now);
	if (input.externalId !== undefined) boundedText(input.externalId, "external id", 512);
	row.status = "completed";
	row.externalId = input.externalId;
	row.updatedAt = now;
	delete row.error;
	return row;
}
export function retryWorkItemOutbox(
	state: HubState,
	input: { accountId: string; outboxId: string; deviceId: string; leaseToken: string; error: string; retryAt: number },
	now: number,
): WorkItemOutbox {
	const row = heldOutbox(state, input, now);
	boundedText(input.error, "outbox error", 8192);
	domainNow(input.retryAt);
	if (input.retryAt < now) domainError("Retry must not precede current time");
	row.status = "queued";
	row.error = input.error;
	row.nextAttemptAt = input.retryAt;
	row.updatedAt = now;
	delete row.leaseExpiresAt;
	return row;
}
