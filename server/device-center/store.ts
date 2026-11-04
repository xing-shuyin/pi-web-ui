import { mkdir, readFile, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { PartitionedAppendLog } from "./partition-log.js";
import type { DeviceConversation, DeviceDelivery, DeviceIntegration, DeviceReview } from "../protocol.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
	projectConversationState,
	reconcileConversationState,
	type ConversationTaskState,
	type ConversationEvent,
} from "./task-state.js";

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
	/** Public tool names only; authorization remains enforced by the device lease. */
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
	/** Why the conversation can no longer continue; surfaced instead of a late 409 on the next turn. */
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
	parentTaskId?: string;
	rootTaskId?: string;
	dispatchDepth?: number;
	dispatchCount?: number;
	handoff?: Handoff;
	report?: string;
	leaseToken?: string;
	leaseGeneration?: number;
	lastHeartbeatAt?: number;
	recoveryUntil?: number;
	planOnly?: boolean;
	plan?: import("./group-plan-guard.js").GroupTaskPlanRecord;
	resourceLocks?: string[];
	blockReason?: import("../protocol.js").DeviceTaskBlockReason;
	blockReasonDetail?: string;
	attenuatedTools?: string[];
	dependsOnTaskId?: string;
}
export interface GroupBlackboard {
	version: number; // 严格自增版本号（从 1 开始）
	updatedAt: number;
	updatedBy: { type: "human" | "bot"; id: string; name: string };
	title?: string;
	content: string; // Markdown 格式结构化共识，最大 32KB
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
	// Incoming exclusive
	token?: string;
	allowBotTrigger?: boolean;
	// Outgoing exclusive
	url?: string;
	secret?: string;
	events?: GroupWebhookEventType[];
	relayViaHub?: boolean;
}

export interface Room {
	id: string;
	accountId: string;
	name: string;
	botIds: string[];
	primaryBotId?: string;
	canvasBinding?: { deviceId: string; graphId: string; cwd: string; title: string };
	blackboard?: GroupBlackboard;
	webhooks?: GroupWebhook[];
	hubRelayBaseUrl?: string;
	createdAt: number;
}
export interface RoomMessage {
	id: string;
	roomId: string;
	accountId: string;
	text: string;
	sender: { type: "human" | "bot" | "webhook"; id: string; name: string; sourceDeviceId?: string };
	createdAt: number;
	taskIds: string[];
	targetBotIds?: string[];
	/** Stable anchor to the message this one answers; survives retention only while both are retained. */
	replyToMessageId?: string;
	conversationId?: string;
	conversationIds?: string[];
}
export interface HubState {
	version: 2;
	conversations: HubConversation[];
	conversationMessages: ConversationMessage[];
	deliveries: DeviceDelivery[];
	reviews: DeviceReview[];
	deliveryReceipts: DeliveryReceipt[];
	integrations: DeviceIntegration[];
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
		/** Optional for state written before receipts were decoupled from message retention. */
		createdAt?: number;
	}[];
}
export const taskPending = (task: HubTask) =>
	!isTerminal(task.status) || !!(task.cancelRequested && !task.stopConfirmed);
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

/** Rows kept per room when replaying append logs; mirrors the group retention the Hub enforces. */
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
			// Load-time retention must never drop work that is still queued, running or awaiting a stop.
			protect: (task) => taskPending(task),
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
		conversations: [],
		conversationMessages: [],
		deliveries: [],
		reviews: [],
		deliveryReceipts: [],
		integrations: [],
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

/** Tasks/messages are partitioned by room; conversations may reference a room row that no longer exists. */
function roomPartitionsOf(state: HubState): Set<string> {
	return new Set([
		...state.rooms.map((room) => room.id),
		...state.conversations.map((conversation) => conversation.roomId),
	]);
}

/** Merge log rows with rows still inlined by an older Hub; inline rows win (they are the older baseline). */
function mergeRows<T extends { id: string }>(stored: readonly T[], inline: readonly T[]): T[] {
	if (!inline.length) return [...stored];
	if (!stored.length) return [...inline];
	const merged = new Map<string, T>();
	for (const row of inline) merged.set(row.id, row);
	for (const row of stored) if (!merged.has(row.id)) merged.set(row.id, row);
	return [...merged.values()];
}

async function loadHubFiles(
	dataDir: string,
	options: { sweep?: boolean } = {},
): Promise<{ state: HubState; logs: HubLogs; legacy: boolean }> {
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	let state: HubState;
	try {
		state = JSON.parse(await readFile(join(dataDir, "device-hub.json"), "utf8"));
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
	}
	state.conversations ??= [];
	state.conversationMessages ??= [];
	state.deliveries ??= [];
	state.reviews ??= [];
	state.deliveryReceipts ??= [];
	state.integrations ??= [];
	if (
		![
			state.conversations,
			state.conversationMessages,
			state.deliveries,
			state.reviews,
			state.deliveryReceipts,
			state.integrations,
		].every(Array.isArray)
	)
		throw new Error("Invalid conversation store");
	const logs = createHubLogs(dataDir);
	const roomPartitions = roomPartitionsOf(state);
	const conversations = new Set(state.conversations.map((conversation) => conversation.id));
	// Logs are the authority; inline rows only exist in files written before the split (or by an older Hub).
	const storedMessages = await logs.messages.load(roomPartitions, options);
	const storedTasks = await logs.tasks.load(roomPartitions, options);
	const storedConversationMessages = await logs.conversationMessages.load(conversations, options);
	const legacy = state.messages.length > 0 || state.tasks.length > 0 || state.conversationMessages.length > 0;
	state.messages = mergeRows(storedMessages, state.messages);
	state.tasks = mergeRows(storedTasks, state.tasks);
	state.conversationMessages = mergeRows(storedConversationMessages, state.conversationMessages);
	// Legacy state is a baseline, not evidence that historical transitions were observed.
	for (const conversation of state.conversations) {
		conversation.taskState = projectConversationState(state, conversation);
		conversation.events ??= [];
	}
	return { state, logs, legacy };
}

/** Read the durable state without open() side effects (no interrupt marking); used by tests and tooling. */
export async function readPersistedHub(dataDir: string): Promise<HubState> {
	// Read-only: never sweep orphan files or repair tails from an inspection path.
	return (await loadHubFiles(dataDir, { sweep: false })).state;
}

/** A single process owns a data directory. Transactions publish only after the index replacement. */
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
	readonly logDir: string;
	private constructor(dataDir: string, state: HubState, logs: HubLogs) {
		this.path = join(dataDir, "device-hub.json");
		this.logDir = join(dataDir, "hub-log");
		this.state = state;
		this.logs = logs;
	}
	static async open(dataDir: string): Promise<DeviceHubStore> {
		const { state, logs, legacy } = await loadHubFiles(dataDir);
		const store = new DeviceHubStore(dataDir, state, logs);
		// Move collections that older Hubs kept inline into their append logs. Logs are written first so
		// an interrupted migration can be retried from the still-inline index without losing rows.
		if (legacy) await store.migrateInlineCollections();
		if (state.tasks.some((task) => !isTerminal(task.status))) {
			const now = Date.now();
			const recoveryGraceMs = 60_000;
			await store.transact((draft) => {
				for (const task of draft.tasks)
					if (!isTerminal(task.status)) {
						task.status = "interrupted";
						task.report = "Hub restarted before execution was confirmed; submit a new turn to retry.";
						task.updatedAt = now;
						if (task.leaseToken) {
							// Retain recovery grace window for active leases to claim on reconnect!
							task.recoveryUntil = now + recoveryGraceMs;
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
			const draft = structuredClone(this.state);
			const result = update(draft);
			if (result && (typeof result === "object" || typeof result === "function") && "then" in result) {
				// Transactions only reserve/commit state. External work runs between transactions.
				// Drain a rejected accidental async callback without publishing its detached draft.
				void Promise.resolve(result).catch(() => {});
				throw new Error("Hub transactions require a synchronous update");
			}
			if (typeof reconcileConversationState === "function") {
				reconcileConversationState(this.state, draft);
			}
			await this.persist(draft);
			this.state = draft;
			for (const listener of this.listeners) {
				try {
					listener();
				} catch {
					/* notification cannot roll back a committed transaction */
				}
			}
			return structuredClone(result);
		});
		this.tail = operation.catch(() => {});
		return operation;
	}
	/**
	 * Kept as a method so I/O failures can be injected without replacing transaction semantics.
	 * The index is replaced first, then the append logs: a log row always describes durable index state.
	 */
	async persist(state: HubState): Promise<void> {
		await this.persistIndex(state);
		await this.commitLogs(state);
	}
	private async commitLogs(state: HubState): Promise<void> {
		const rooms = roomPartitionsOf(state);
		const conversations = new Set(state.conversations.map((conversation) => conversation.id));
		await this.logs.messages.commit(state.messages, rooms);
		await this.logs.tasks.commit(state.tasks, rooms);
		await this.logs.conversationMessages.commit(state.conversationMessages, conversations);
	}
	/** One-time upgrade from Hubs that inlined messages/tasks/transcripts in the index file. */
	private async migrateInlineCollections(): Promise<void> {
		await this.commitLogs(this.state);
		await this.persistIndex(this.state);
	}
	private async persistIndex(state: HubState): Promise<void> {
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		const index: HubState = { ...state, messages: [], tasks: [], conversationMessages: [] };
		try {
			const file = await open(temporary, "wx", 0o600);
			try {
				await file.writeFile(JSON.stringify(index));
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, this.path);
		} finally {
			await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
	}
	async close(): Promise<void> {
		await this.tail;
	}
}
