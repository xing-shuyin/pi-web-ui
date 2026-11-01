import { mkdir, readFile, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DeviceConversation, DeviceDelivery, DeviceIntegration, DeviceReview } from "../protocol.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
	projectConversationState,
	reconcileConversationState,
	type ConversationTaskState,
	type ConversationEvent,
} from "./task-state.js";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "interrupted";
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
export type HubConversation = Omit<
	DeviceConversation,
	"status" | "latestDelivery" | "latestReview" | "deliveryCount" | "reviewCount"
> & {
	taskState?: ConversationTaskState;
	events?: ConversationEvent[];
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
}
export interface Room {
	id: string;
	accountId: string;
	name: string;
	botIds: string[];
	primaryBotId?: string;
	canvasBinding?: { deviceId: string; graphId: string; cwd: string; title: string };
	createdAt: number;
}
export interface RoomMessage {
	id: string;
	roomId: string;
	accountId: string;
	text: string;
	sender: { type: "human" | "bot"; id: string; name: string; sourceDeviceId?: string };
	createdAt: number;
	taskIds: string[];
	targetBotIds?: string[];
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
	receipts: { accountId: string; roomId: string; key: string; fingerprint: string; messageId: string }[];
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

/** A single process owns a data directory. Transactions publish only after atomic replacement. */
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
	private constructor(dataDir: string, state: HubState) {
		this.path = join(dataDir, "device-hub.json");
		this.state = state;
	}
	static async open(dataDir: string): Promise<DeviceHubStore> {
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
			state = {
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
		// Legacy state is a baseline, not evidence that historical transitions were observed.
		for (const conversation of state.conversations) {
			conversation.taskState = projectConversationState(state, conversation);
			conversation.events ??= [];
		}
		const store = new DeviceHubStore(dataDir, state);
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
	/** Kept as a method so I/O failures can be injected without replacing transaction semantics. */
	async persist(state: HubState): Promise<void> {
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		try {
			const file = await open(temporary, "wx", 0o600);
			try {
				await file.writeFile(JSON.stringify(state));
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
