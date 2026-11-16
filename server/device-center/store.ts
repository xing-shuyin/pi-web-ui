import { mkdir, readFile, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { PartitionedAppendLog } from "./partition-log.js";
import {
	HubTransactionLog,
	type CollectionDiff,
	type HubIndexState,
	type HubTransactionDiff,
} from "./hub-transaction-log.js";
import type {
	BlackboardSection,
	DeviceConversation,
	DeviceDelivery,
	DeviceIntegration,
	DeviceReview,
} from "../protocol.js";
export type { BlackboardSection } from "../protocol.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { assertDirectRoom, DirectRoomInvariantError, isDirectRoom } from "./direct-rooms.js";
import {
	projectConversationState,
	reconcileConversationState,
	type ConversationTaskState,
	type ConversationEvent,
} from "./task-state.js";

import type { GroupRouterConfig, RouterJob } from "./group-router.js";
import type { WorkItem, WorkItemEvent, WorkItemOutbox } from "./work-items.js";
export type { GroupRouterConfig, RouterJob } from "./group-router.js";
export type { WorkItem, WorkItemEvent, WorkItemOutbox } from "./work-items.js";

export type TaskStatus = "queued" | "waiting" | "running" | "completed" | "failed" | "interrupted";
export interface Handoff {
	repository: string;
	commit: string;
	branch?: string;
	instructions: string;
}
export interface Account {
	id: string;
	username: string;
	passwordHash: string;
	createdAt: number;
}
export interface Device {
	id: string;
	accountId: string;
	name: string;
	remark?: string;
	credentialHash: string;
	uiCredentialHash?: string;
	createdAt: number;
}
export interface Bot {
	tools?: string[];
	id: string;
	deviceId: string;
	accountId: string;
	name: string;
	description: string;
	enabled: boolean;
	revision: number;
	createdAt: number;
	updatedAt: number;
}
export type ConversationClosedReason = "stopped" | "device_revoked";
export type HubConversation = Omit<
	DeviceConversation,
	"status" | "latestDelivery" | "latestReview" | "deliveryCount" | "reviewCount"
> & {
	taskState?: ConversationTaskState;
	events?: ConversationEvent[];
	closedReason?: ConversationClosedReason;
};
export interface DeliveryReceipt {
	conversationId: string;
	kind: "delivery" | "review";
	key: string;
	fingerprint: string;
	recordId: string;
}
export interface ConversationMessage {
	id: string;
	conversationId: string;
	taskId: string;
	kind: "message" | "request" | "reply" | "result";
	text: string;
	sourceBotId?: string;
	requestId?: string;
	idempotencyKey?: string;
	fingerprint?: string;
	createdAt: number;
}
export interface HubTask {
	reportMetadata?: import("../protocol.js").DeviceTaskReportMetadata;
	cancelRequested?: boolean;
	stopConfirmed?: boolean;
	sourceConversationId?: string;
	conversationId?: string;
	resume?: boolean;
	kind?: "message" | "request" | "reply" | "result";
	requestId?: string;
	resultOfTaskId?: string;
	botId: string;
	botRevision: number;
	sourceBotId?: string;
	id: string;
	attemptId: string;
	roomId: string;
	accountId: string;
	deviceId: string;
	text: string;
	status: TaskStatus;
	createdAt: number;
	updatedAt: number;
	/** 队列优先级：0 人私聊 / 1 群内人消息 / 2 路由·Webhook·定时。缺省按 1。 */
	queuePriority?: number;
	/** 触发源（用于优先级与调度审计）；不影响权限。 */
	origin?: "human" | "router" | "webhook" | "schedule" | "work_item";
	parentTaskId?: string;
	rootTaskId?: string;
	dispatchDepth?: number;
	dispatchCount?: number;
	handoff?: Handoff;
	report?: string;
	error?: string;
	leaseToken?: string;
	leaseGeneration?: number;
	lastHeartbeatAt?: number;
	/** 设备侧第一次确认收到任务的时刻（`task_event running`）。只写一次，用于识别"派了但没起来"。 */
	acknowledgedAt?: number;
	/** 设备侧最近一次租约续期（`task_lease_renew`）的时刻：唯一能证明执行端真的在跑的信号。 */
	lastLeaseRenewAt?: number;
	recoveryUntil?: number;
	planOnly?: boolean;
	plan?: import("./group-plan-guard.js").GroupTaskPlanRecord;
	resourceLocks?: string[];
	blockReason?: import("../protocol.js").DeviceTaskBlockReason;
	blockReasonDetail?: string;
	/** 排队说明（如"前面还有 N 个任务"），与 blockReason 一起展示给用户。 */
	queuedReason?: string;
	attenuatedTools?: string[];
	dependsOnTaskId?: string;
	outcomeFingerprint?: string;
	outcomeCanonicalFingerprint?: string;
	terminalAcceptedLeaseGeneration?: number;
	executionMode?: import("../protocol.js").DeviceExecutionMode;
	contract?: import("../protocol.js").DeviceWorkContract;
	contextManifest?: import("../protocol.js").ContextManifest;
	artifact?: import("../protocol.js").DeviceArtifact;
	executionCompleted?: boolean;
	artifactProduced?: boolean;
}
export interface GroupBlackboard {
	version: number;
	updatedAt: number;
	updatedBy: { type: "human" | "bot"; id: string; name: string };
	title?: string;
	content: string;
	sections?: Record<string, BlackboardSection>;
}

export type GroupWebhookEventType = "message" | "task_completed" | "task_failed" | "delivery";

export interface GroupWebhook {
	id: string;
	roomId: string;
	name: string;
	type: "incoming" | "outgoing";
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
	token?: string;
	allowBotTrigger?: boolean;
	url?: string;
	secret?: string;
	events?: GroupWebhookEventType[];
	relayViaHub?: boolean;
}

export interface Room {
	id: string;
	accountId: string;
	/** 缺省 `group`（存量数据零迁移）；`direct` = 与单个 Bot 的私聊容器，见 `direct-rooms.ts`。 */
	kind?: "group" | "direct";
	name: string;
	botIds: string[];
	primaryBotId?: string;
	router?: GroupRouterConfig;
	routerRevision?: number;
	canvasBinding?: { deviceId: string; graphId: string; cwd: string; title: string };
	blackboard?: GroupBlackboard;
	webhooks?: GroupWebhook[];
	hubRelayBaseUrl?: string;
	createdAt: number;
}
export interface RoomMessage {
	routerJobId?: string;
	id: string;
	roomId: string;
	accountId: string;
	text: string;
	sender: { type: "human" | "bot" | "webhook" | "router"; id: string; name: string; sourceDeviceId?: string };
	createdAt: number;
	taskIds: string[];
	targetBotIds?: string[];
	replyToMessageId?: string;
	conversationId?: string;
	conversationIds?: string[];
	/** 从私聊投递到群的消息：保留来源，供 UI 标注"来自与 X 的私聊"。 */
	sharedFrom?: {
		mode: "as_bot" | "as_forward";
		sourceRoomId: string;
		botId: string;
		messageIds: string[];
	};
}
export interface HubState {
	version: 2;
	checkpointSeq?: number;
	conversations: HubConversation[];
	conversationMessages: ConversationMessage[];
	deliveries: DeviceDelivery[];
	reviews: DeviceReview[];
	deliveryReceipts: DeliveryReceipt[];
	integrations: DeviceIntegration[];
	workItems: WorkItem[];
	workItemEvents: WorkItemEvent[];
	routerJobs: RouterJob[];
	workItemOutbox: WorkItemOutbox[];
	accounts: Account[];
	devices: Device[];
	bots: Bot[];
	sessions: { hash: string; accountId: string; expiresAt: number }[];
	rooms: Room[];
	messages: RoomMessage[];
	tasks: HubTask[];
	receipts: {
		accountId: string;
		roomId: string;
		key: string;
		fingerprint: string;
		messageId: string;
		createdAt?: number;
	}[];
}
export const taskPending = (task: HubTask) =>
	!isTerminal(task.status) ||
	!!(task.cancelRequested && !task.stopConfirmed) ||
	(task.recoveryUntil !== undefined && task.recoveryUntil > Date.now());
export const taskHasImmutableEvidence = (task: HubTask) =>
	!!task.contract ||
	!!task.artifact ||
	task.artifactProduced === true ||
	(task.executionMode === "code" && task.executionCompleted === true);
export const isTerminal = (status: TaskStatus) => ["completed", "failed", "interrupted"].includes(status);
export const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");
export function secretMatches(secret: string, hash: string): boolean {
	const actual = Buffer.from(hashSecret(secret), "hex");
	const expected = Buffer.from(hash, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function publicDevice(device: Device) {
	const { credentialHash: _hash, uiCredentialHash: _uiHash, ...visible } = device;
	return visible;
}
export function publicTask<T extends object>(task: T): Omit<T, "leaseToken"> {
	const { leaseToken: _token, ...visible } = task as Record<string, unknown>;
	return visible as Omit<T, "leaseToken">;
}

export const HUB_LOG_RETENTION = 500;

interface HubLogs {
	messages: PartitionedAppendLog<RoomMessage>;
	tasks: PartitionedAppendLog<HubTask>;
	conversationMessages: PartitionedAppendLog<ConversationMessage>;
}

function createHubLogs(dataDir: string): HubLogs {
	const root = join(dataDir, "hub-log");
	return {
		messages: new PartitionedAppendLog<RoomMessage>({
			dir: join(root, "messages"),
			partition: (message) => message.roomId,
			id: (message) => message.id,
			retention: HUB_LOG_RETENTION,
		}),
		tasks: new PartitionedAppendLog<HubTask>({
			dir: join(root, "tasks"),
			partition: (task) => task.roomId,
			id: (task) => task.id,
			retention: HUB_LOG_RETENTION,
			protect: (task) => taskPending(task) || taskHasImmutableEvidence(task),
		}),
		conversationMessages: new PartitionedAppendLog<ConversationMessage>({
			dir: join(root, "conversation-messages"),
			partition: (message) => message.conversationId,
			id: (message) => message.id,
		}),
	};
}

function emptyHubState(): HubState {
	return {
		version: 2,
		checkpointSeq: 0,
		conversations: [],
		conversationMessages: [],
		deliveries: [],
		reviews: [],
		deliveryReceipts: [],
		integrations: [],
		workItems: [],
		workItemEvents: [],
		routerJobs: [],
		workItemOutbox: [],
		accounts: [],
		devices: [],
		bots: [],
		sessions: [],
		rooms: [],
		messages: [],
		tasks: [],
		receipts: [],
	};
}

function roomPartitionsOf(state: Pick<HubState, "rooms" | "conversations">): Set<string> {
	return new Set([
		...state.rooms.map((room) => room.id),
		...state.conversations.map((conversation) => conversation.roomId),
	]);
}

function mergeRows<T extends { id: string }>(stored: readonly T[], inline: readonly T[]): T[] {
	if (!inline.length) return [...stored];
	if (!stored.length) return [...inline];
	const merged = new Map<string, T>();
	for (const row of inline) merged.set(row.id, row);
	for (const row of stored) if (!merged.has(row.id)) merged.set(row.id, row);
	return [...merged.values()];
}

/**
 * 直聊房间不变量的写入断言（单源）。
 * 只检查本事务新增或改动过的房间：存量数据零迁移，历史脏房间不会因为无关事务而把 Hub 卡死；
 * 但一旦某个写入路径动到它，就必须显式拒绝而不是静默退化成群组。
 */
export function assertRoomWriteInvariants(before: readonly Room[], after: readonly Room[]): void {
	const beforeById = new Map(before.map((room) => [room.id, room]));
	for (const room of computeCollectionDiff(before, after).upsert) {
		// 直聊 → 群组（或 kind 被清空）的改写等于静默降级：房间 id 还是那个派生值，
		// 但 router / 黑板 / 多成员这些群能力会突然被放开。只改 kind 就能绕过下面逐字段的校验，
		// 因此必须按「改动方向」单独拒绝，而不能只看改完之后是不是直聊。
		const previous = beforeById.get(room.id);
		if (previous && isDirectRoom(previous) && !isDirectRoom(room))
			throw new DirectRoomInvariantError({
				code: "DIRECT_ROOM_KIND_REWRITE",
				message: "Direct room kind cannot be rewritten into a group room",
			});
		if (isDirectRoom(room)) assertDirectRoom(room);
	}
}

function computeCollectionDiff<T extends { id: string }>(
	oldRows: readonly T[],
	newRows: readonly T[],
): CollectionDiff<T> {
	const oldMap = new Map<string, string>();
	for (const row of oldRows) {
		oldMap.set(row.id, JSON.stringify(row));
	}
	const upsert: T[] = [];
	const newIds = new Set<string>();
	for (const row of newRows) {
		newIds.add(row.id);
		const serialized = JSON.stringify(row);
		if (oldMap.get(row.id) !== serialized) {
			upsert.push(row);
		}
	}
	const deleteIds: string[] = [];
	for (const row of oldRows) {
		if (!newIds.has(row.id)) {
			deleteIds.push(row.id);
		}
	}
	return { upsert, deleteIds };
}

function applyCollectionDiff<T extends { id: string }>(target: T[], diff: CollectionDiff<T>): void {
	const deleteSet = new Set(diff.deleteIds);
	let i = 0;
	while (i < target.length) {
		if (deleteSet.has(target[i].id)) {
			target.splice(i, 1);
		} else {
			i++;
		}
	}
	const indexMap = new Map<string, number>();
	for (let j = 0; j < target.length; j++) {
		indexMap.set(target[j].id, j);
	}
	for (const item of diff.upsert) {
		const existingIndex = indexMap.get(item.id);
		if (existingIndex !== undefined) {
			target[existingIndex] = item;
		} else {
			target.push(item);
			indexMap.set(item.id, target.length - 1);
		}
	}
}

function extractIndexState(state: HubState): HubIndexState {
	const { messages: _m, tasks: _t, conversationMessages: _cm, ...index } = state;
	return index;
}

async function persistIndexTo(indexPath: string, state: HubState, checkpointSeq: number): Promise<void> {
	const temporary = `${indexPath}.${randomUUID()}.tmp`;
	const index: Record<string, unknown> = {
		...state,
		messages: [],
		tasks: [],
		conversationMessages: [],
		checkpointSeq,
	};
	delete index.checkpointSeqRaw;
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(JSON.stringify(index));
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, indexPath);
	} finally {
		await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}

async function loadHubFiles(
	dataDir: string,
	options: { sweep?: boolean; readOnly?: boolean } = {},
): Promise<{ state: HubState; logs: HubLogs; wal: HubTransactionLog; checkpointSeq: number; legacy: boolean }> {
	if (!options.readOnly) {
		await mkdir(dataDir, { recursive: true, mode: 0o700 });
	}
	let state: HubState;
	let checkpointSeq = 0;
	try {
		const rawText = await readFile(join(dataDir, "device-hub.json"), "utf8");
		const rawJson = JSON.parse(rawText) as HubState & { checkpointSeq?: number };
		checkpointSeq = typeof rawJson.checkpointSeq === "number" ? rawJson.checkpointSeq : 0;
		state = rawJson;
		delete (state as { checkpointSeq?: number }).checkpointSeq;
		if (
			state.version !== 2 ||
			![
				state.accounts,
				state.devices,
				state.bots,
				state.sessions,
				state.rooms,
				state.messages,
				state.tasks,
				state.receipts,
			].every(Array.isArray)
		) {
			throw new Error("Invalid device hub store");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		state = emptyHubState();
		delete (state as { checkpointSeq?: number }).checkpointSeq;
	}
	state.conversations ??= [];
	state.conversationMessages ??= [];
	state.deliveries ??= [];
	state.reviews ??= [];
	state.deliveryReceipts ??= [];
	state.integrations ??= [];
	state.workItems ??= [];
	state.workItemEvents ??= [];
	state.routerJobs ??= [];
	state.workItemOutbox ??= [];
	if (
		![
			state.conversations,
			state.conversationMessages,
			state.deliveries,
			state.reviews,
			state.deliveryReceipts,
			state.integrations,
			state.workItems,
			state.workItemEvents,
			state.routerJobs,
			state.workItemOutbox,
		].every(Array.isArray)
	)
		throw new Error("Invalid conversation store");
	const wal = new HubTransactionLog({ walPath: join(dataDir, "hub-wal.jsonl") });
	const { records } = await wal.readTransactions({ readOnly: options.readOnly });
	const unprojectedRecords = records.filter((record) => record.seq > checkpointSeq);
	const logs = createHubLogs(dataDir);
	const roomPartitions = roomPartitionsOf(state);
	const conversations = new Set(state.conversations.map((conversation) => conversation.id));
	for (const record of unprojectedRecords) {
		for (const partition of roomPartitionsOf(record.index)) roomPartitions.add(partition);
		for (const conversation of record.index.conversations) conversations.add(conversation.id);
	}
	const storedMessages = await logs.messages.load(roomPartitions, options);
	const storedTasks = await logs.tasks.load(roomPartitions, options);
	const storedConversationMessages = await logs.conversationMessages.load(conversations, options);
	const legacy = state.messages.length > 0 || state.tasks.length > 0 || state.conversationMessages.length > 0;
	state.messages = mergeRows(storedMessages, state.messages);
	state.tasks = mergeRows(storedTasks, state.tasks);
	state.conversationMessages = mergeRows(storedConversationMessages, state.conversationMessages);

	if (unprojectedRecords.length > 0) {
		for (const record of unprojectedRecords) {
			const { checkpointSeq: _recSeq, ...indexProps } = record.index as Record<string, unknown>;
			Object.assign(state, indexProps);
			applyCollectionDiff(state.messages, record.diff.messages);
			applyCollectionDiff(state.tasks, record.diff.tasks);
			applyCollectionDiff(state.conversationMessages, record.diff.conversationMessages);
			checkpointSeq = record.seq;
		}

		if (!options.readOnly) {
			const recoveryRooms = roomPartitionsOf(state);
			const recoveryConversations = new Set(state.conversations.map((conversation) => conversation.id));
			await logs.messages.commit(state.messages, recoveryRooms);
			await logs.tasks.commit(state.tasks, recoveryRooms);
			await logs.conversationMessages.commit(state.conversationMessages, recoveryConversations);
			await persistIndexTo(join(dataDir, "device-hub.json"), state, checkpointSeq);
			await wal.checkpoint(checkpointSeq);
		}
	}

	for (const conversation of state.conversations) {
		conversation.taskState = projectConversationState(state, conversation);
		conversation.events ??= [];
	}
	return { state, logs, wal, checkpointSeq, legacy };
}

export async function readPersistedHub(dataDir: string): Promise<HubState> {
	return (await loadHubFiles(dataDir, { sweep: false, readOnly: true })).state;
}

export class DeviceHubStore {
	private state: HubState;
	private readonly listeners = new Set<() => void>();
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private tail: Promise<unknown> = Promise.resolve();
	readonly path: string;
	private readonly logs: HubLogs;
	readonly wal: HubTransactionLog;
	readonly logDir: string;
	private lastSeq: number;
	private checkpointSeq: number;
	private projectionFailed = false;
	lastProjectionError?: unknown;

	private constructor(dataDir: string, state: HubState, logs: HubLogs, wal: HubTransactionLog, checkpointSeq: number) {
		this.path = join(dataDir, "device-hub.json");
		this.logDir = join(dataDir, "hub-log");
		this.state = state;
		this.logs = logs;
		this.wal = wal;
		this.checkpointSeq = checkpointSeq;
		this.lastSeq = checkpointSeq;
	}
	static async open(dataDir: string, options: { retainUnleasedQueued?: boolean } = {}): Promise<DeviceHubStore> {
		const { state, logs, wal, checkpointSeq, legacy } = await loadHubFiles(dataDir);
		const store = new DeviceHubStore(dataDir, state, logs, wal, checkpointSeq);
		if (legacy) await store.migrateInlineCollections();
		const now = Date.now();
		const recoveryGraceMs = 60_000;
		const tasksToInterrupt = state.tasks.filter((task) => {
			if (isTerminal(task.status)) return false;
			if (options.retainUnleasedQueued) {
				if (task.status === "running") return true;
				if (task.status === "queued" && (task.leaseToken || task.leaseGeneration !== undefined)) return true;
				return false;
			}
			return true;
		});
		if (tasksToInterrupt.length > 0) {
			await store.transact((draft) => {
				for (const task of draft.tasks) {
					if (isTerminal(task.status)) continue;
					const shouldInterrupt = options.retainUnleasedQueued
						? task.status === "running" ||
							(task.status === "queued" && (task.leaseToken || task.leaseGeneration !== undefined))
						: true;
					if (shouldInterrupt) {
						task.status = "interrupted";
						task.report = "Hub restarted before execution was confirmed; submit a new turn to retry.";
						task.updatedAt = now;
						if (task.leaseToken || task.leaseGeneration !== undefined) {
							task.recoveryUntil = now + recoveryGraceMs;
						}
					}
				}
			});
		}
		return store;
	}
	snapshot(): HubState {
		return structuredClone(this.state);
	}
	getDeviceOwner(id: string): string | undefined {
		return this.state.devices.find((device) => device.id === id)?.accountId;
	}
	getDevice(id: string) {
		const device = this.state.devices.find((item) => item.id === id);
		return device ? publicDevice(device) : undefined;
	}
	async authenticateDevice(id: string, credential: string): Promise<boolean> {
		const device = this.state.devices.find((item) => item.id === id);
		return (
			!!device &&
			typeof credential === "string" &&
			credential.length <= 256 &&
			secretMatches(credential, device.credentialHash)
		);
	}
	async transact<T>(update: (draft: HubState) => T extends PromiseLike<unknown> ? never : T): Promise<T> {
		const operation = this.tail.then(async () => {
			if (this.wal.isPoisoned()) {
				throw new Error("Store is poisoned due to previous WAL rollback failure; operations halted");
			}
			const draft = structuredClone(this.state);
			const result = update(draft);
			if (result && (typeof result === "object" || typeof result === "function") && "then" in result) {
				void Promise.resolve(result).catch(() => {});
				throw new Error("Hub transactions require a synchronous update");
			}
			if (typeof reconcileConversationState === "function") {
				reconcileConversationState(this.state, draft);
			}
			// 直聊不变量的写入单源：只断言本事务新增/改动过的房间，存量数据零迁移。
			// 路由层的散点校验会被绕过（例如设备撤销时连改 botIds），这里兜底让事务整体回滚。
			assertRoomWriteInvariants(this.state.rooms, draft.rooms);
			const detachedResult = structuredClone(result);

			const nextSeq = this.lastSeq + 1;
			const diff: HubTransactionDiff = {
				messages: computeCollectionDiff(this.state.messages, draft.messages),
				tasks: computeCollectionDiff(this.state.tasks, draft.tasks),
				conversationMessages: computeCollectionDiff(this.state.conversationMessages, draft.conversationMessages),
			};

			await this.persist(draft, nextSeq, diff);
			for (const listener of this.listeners) {
				try {
					listener();
				} catch {}
			}
			return detachedResult;
		});
		this.tail = operation.catch(() => {});
		return operation;
	}
	async persist(state: HubState, checkpointSeq: number = this.lastSeq, diff?: HubTransactionDiff): Promise<void> {
		state = structuredClone(state);
		if (diff) diff = structuredClone(diff);

		if (this.projectionFailed) {
			this.logs.messages.invalidateCache();
			this.logs.tasks.invalidateCache();
			this.logs.conversationMessages.invalidateCache();
		}
		if (diff) {
			await this.wal.append(checkpointSeq, extractIndexState(state), diff);
			this.state = state;
			this.lastSeq = checkpointSeq;
		}
		try {
			await this.commitLogs(state);
			await this.persistIndex(state, checkpointSeq);
			await this.wal.checkpoint(checkpointSeq);
			this.checkpointSeq = checkpointSeq;
			this.projectionFailed = false;
			this.lastProjectionError = undefined;
		} catch (projectionError) {
			this.projectionFailed = true;
			this.lastProjectionError = projectionError;
			if (!diff) throw projectionError;
		}
	}
	private async commitLogs(state: HubState): Promise<void> {
		const rooms = roomPartitionsOf(state);
		const conversations = new Set(state.conversations.map((conversation) => conversation.id));
		await this.logs.messages.commit(state.messages, rooms);
		await this.logs.tasks.commit(state.tasks, rooms);
		await this.logs.conversationMessages.commit(state.conversationMessages, conversations);
	}
	private async migrateInlineCollections(): Promise<void> {
		await this.commitLogs(this.state);
		await this.persistIndex(this.state, this.checkpointSeq);
	}
	private async persistIndex(state: HubState, checkpointSeq: number = this.checkpointSeq): Promise<void> {
		await persistIndexTo(this.path, state, checkpointSeq);
	}
	async close(): Promise<void> {
		await this.tail;
	}
}
