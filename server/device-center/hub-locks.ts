import { readFileSync } from "node:fs";
import { writeJsonAtomicSync } from "../atomic-file.js";
import { type RoomActiveLock, type RoomLockInfo, type RoomLockWaiter } from "../protocol.js";

export const RESOURCE_LOCK_KEY_PATTERN = /^[a-zA-Z0-9_.:/-]+$/;
export const MAX_RESOURCE_LOCKS_PER_TASK = 10;
export const MAX_RESOURCE_LOCK_KEY_LENGTH = 256;
export const DEFAULT_RESOURCE_LOCK_TTL_MS = 10 * 60 * 1000;

export function isValidLockKey(key: unknown): boolean {
	if (typeof key !== "string") return false;
	const trimmed = key.trim();
	if (trimmed.length < 1 || trimmed.length > MAX_RESOURCE_LOCK_KEY_LENGTH) return false;
	if (trimmed !== key) return false;
	return RESOURCE_LOCK_KEY_PATTERN.test(key);
}

export function validateResourceLocks(locks: unknown, maxLocks = MAX_RESOURCE_LOCKS_PER_TASK): string[] {
	if (locks === undefined || locks === null) return [];
	if (!Array.isArray(locks)) {
		throw new Error("resourceLocks must be an array of strings");
	}
	if (locks.length > maxLocks) {
		throw new Error(`resourceLocks cannot exceed ${maxLocks} items`);
	}
	const result: string[] = [];
	const seen = new Set<string>();
	for (const item of locks) {
		if (typeof item !== "string" || !isValidLockKey(item)) {
			throw new Error(
				`Invalid resource lock key: "${typeof item === "string" ? item : String(item)}". Lock key must be 1-256 characters matching ^[a-zA-Z0-9_.:/-]+$`,
			);
		}
		if (!seen.has(item)) {
			seen.add(item);
			result.push(item);
		}
	}
	return result;
}

export interface AcquireLocksOptions {
	roomId: string;
	taskId: string;
	botId: string;
	deviceId?: string;
	resourceLocks: string[];
	ttlMs?: number;
	now?: number;
}

export interface AcquireLocksResult {
	success: boolean;
	conflictingLocks: string[];
	holderTaskIds: string[];
}

interface RoomLockState {
	activeLocks: Map<string, RoomActiveLock>;
	taskLocks: Map<string, Set<string>>;
	waitingQueue: RoomLockWaiter[];
}

export interface HubLockManagerOptions {
	defaultTtlMs?: number;
	autoCleanupIntervalMs?: number;
	persistPath?: string;
}

export class HubLockManager {
	private readonly rooms = new Map<string, RoomLockState>();
	private readonly defaultTtlMs: number;
	private readonly persistPath?: string;
	private timer?: NodeJS.Timeout;

	constructor(options: HubLockManagerOptions = {}) {
		this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_RESOURCE_LOCK_TTL_MS;
		this.persistPath = options.persistPath;
		if (this.persistPath) {
			this.loadFromDisk();
		}
		if (options.autoCleanupIntervalMs && options.autoCleanupIntervalMs > 0) {
			this.timer = setInterval(() => {
				this.cleanupExpiredLocks();
			}, options.autoCleanupIntervalMs);
			if (typeof this.timer.unref === "function") {
				this.timer.unref();
			}
		}
	}

	private loadFromDisk(): void {
		if (!this.persistPath) return;
		try {
			const raw = readFileSync(this.persistPath, "utf8");
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && parsed.rooms) {
				const now = Date.now();
				for (const [roomId, serialized] of Object.entries(parsed.rooms) as [string, any][]) {
					const roomState: RoomLockState = {
						activeLocks: new Map(),
						taskLocks: new Map(),
						waitingQueue: Array.isArray(serialized.waitingQueue) ? serialized.waitingQueue : [],
					};
					if (Array.isArray(serialized.activeLocks)) {
						for (const lock of serialized.activeLocks) {
							if (lock && lock.lockKey && lock.expiresAt > now) {
								roomState.activeLocks.set(lock.lockKey, lock);
								let taskHeld = roomState.taskLocks.get(lock.taskId);
								if (!taskHeld) {
									taskHeld = new Set<string>();
									roomState.taskLocks.set(lock.taskId, taskHeld);
								}
								taskHeld.add(lock.lockKey);
							}
						}
					}
					this.rooms.set(roomId, roomState);
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			}
		}
	}

	private saveToDisk(): void {
		if (!this.persistPath) return;
		try {
			const serializedRooms: Record<string, { activeLocks: RoomActiveLock[]; waitingQueue: RoomLockWaiter[] }> = {};
			for (const [roomId, state] of this.rooms.entries()) {
				if (state.activeLocks.size > 0 || state.waitingQueue.length > 0) {
					serializedRooms[roomId] = {
						activeLocks: Array.from(state.activeLocks.values()),
						waitingQueue: [...state.waitingQueue],
					};
				}
			}
			writeJsonAtomicSync(this.persistPath, { version: 1, updatedAt: Date.now(), rooms: serializedRooms });
		} catch {}
	}

	private getOrCreateRoom(roomId: string): RoomLockState {
		let state = this.rooms.get(roomId);
		if (!state) {
			state = {
				activeLocks: new Map(),
				taskLocks: new Map(),
				waitingQueue: [],
			};
			this.rooms.set(roomId, state);
		}
		return state;
	}

	acquireLocks(options: AcquireLocksOptions): AcquireLocksResult {
		const now = options.now ?? Date.now();
		const ttlMs = options.ttlMs ?? this.defaultTtlMs;
		const locks = validateResourceLocks(options.resourceLocks);
		if (locks.length === 0) {
			return { success: true, conflictingLocks: [], holderTaskIds: [] };
		}

		this.cleanupExpiredLocks(options.roomId, now);
		const roomState = this.getOrCreateRoom(options.roomId);

		const conflictingLocks: string[] = [];
		const holderTaskIds = new Set<string>();

		for (const key of locks) {
			const held = roomState.activeLocks.get(key);
			if (held && held.expiresAt > now && held.taskId !== options.taskId) {
				conflictingLocks.push(key);
				holderTaskIds.add(held.taskId);
			}
		}

		if (conflictingLocks.length > 0) {
			const existingIndex = roomState.waitingQueue.findIndex((w) => w.taskId === options.taskId);
			if (existingIndex >= 0) {
				roomState.waitingQueue[existingIndex].lockKeys = locks;
				roomState.waitingQueue[existingIndex].botId = options.botId;
			} else {
				roomState.waitingQueue.push({
					taskId: options.taskId,
					roomId: options.roomId,
					botId: options.botId,
					lockKeys: locks,
					queuedAt: now,
				});
			}
			this.saveToDisk();
			return {
				success: false,
				conflictingLocks,
				holderTaskIds: Array.from(holderTaskIds),
			};
		}

		const waiterIndex = roomState.waitingQueue.findIndex((w) => w.taskId === options.taskId);
		if (waiterIndex >= 0) {
			roomState.waitingQueue.splice(waiterIndex, 1);
		}

		let taskHeld = roomState.taskLocks.get(options.taskId);
		if (!taskHeld) {
			taskHeld = new Set<string>();
			roomState.taskLocks.set(options.taskId, taskHeld);
		}

		for (const key of locks) {
			const activeLock: RoomActiveLock = {
				lockKey: key,
				roomId: options.roomId,
				taskId: options.taskId,
				botId: options.botId,
				...(options.deviceId ? { deviceId: options.deviceId } : {}),
				acquiredAt: now,
				expiresAt: now + ttlMs,
			};
			roomState.activeLocks.set(key, activeLock);
			taskHeld.add(key);
		}

		this.saveToDisk();
		return { success: true, conflictingLocks: [], holderTaskIds: [] };
	}

	releaseLocks(roomId: string, taskId: string, now = Date.now()): string[] {
		const roomState = this.rooms.get(roomId);
		if (!roomState) return [];

		const heldKeys = roomState.taskLocks.get(taskId);
		if (heldKeys) {
			for (const key of heldKeys) {
				const current = roomState.activeLocks.get(key);
				if (current?.taskId === taskId) {
					roomState.activeLocks.delete(key);
				}
			}
			roomState.taskLocks.delete(taskId);
		}

		const waiterIndex = roomState.waitingQueue.findIndex((w) => w.taskId === taskId);
		if (waiterIndex >= 0) {
			roomState.waitingQueue.splice(waiterIndex, 1);
		}

		const promoted = this.promoteWaitingTasks(roomId, now);
		this.saveToDisk();
		return promoted;
	}

	removeWaiter(roomId: string, taskId: string): boolean {
		const roomState = this.rooms.get(roomId);
		if (!roomState) return false;
		const index = roomState.waitingQueue.findIndex((w) => w.taskId === taskId);
		if (index >= 0) {
			roomState.waitingQueue.splice(index, 1);
			return true;
		}
		return false;
	}

	cleanupExpiredLocks(roomId?: string, now = Date.now()): string[] {
		const promotedAll: string[] = [];
		const roomIds = roomId ? [roomId] : Array.from(this.rooms.keys());

		for (const rId of roomIds) {
			const roomState = this.rooms.get(rId);
			if (!roomState) continue;

			let expiredAny = false;
			for (const [key, lock] of Array.from(roomState.activeLocks.entries())) {
				if (lock.expiresAt <= now) {
					roomState.activeLocks.delete(key);
					const taskHeld = roomState.taskLocks.get(lock.taskId);
					if (taskHeld) {
						taskHeld.delete(key);
						if (taskHeld.size === 0) {
							roomState.taskLocks.delete(lock.taskId);
						}
					}
					expiredAny = true;
				}
			}

			if (expiredAny) {
				const promoted = this.promoteWaitingTasks(rId, now);
				promotedAll.push(...promoted);
			}
		}

		return promotedAll;
	}

	private promoteWaitingTasks(roomId: string, now = Date.now()): string[] {
		const roomState = this.rooms.get(roomId);
		if (!roomState || roomState.waitingQueue.length === 0) return [];

		const promoted: string[] = [];
		const remainingWaiters: RoomLockWaiter[] = [];

		for (const waiter of roomState.waitingQueue) {
			let canAcquire = true;
			for (const key of waiter.lockKeys) {
				const held = roomState.activeLocks.get(key);
				if (held && held.expiresAt > now && held.taskId !== waiter.taskId) {
					canAcquire = false;
					break;
				}
			}

			if (canAcquire) {
				let taskHeld = roomState.taskLocks.get(waiter.taskId);
				if (!taskHeld) {
					taskHeld = new Set<string>();
					roomState.taskLocks.set(waiter.taskId, taskHeld);
				}
				for (const key of waiter.lockKeys) {
					const activeLock: RoomActiveLock = {
						lockKey: key,
						roomId,
						taskId: waiter.taskId,
						botId: waiter.botId,
						acquiredAt: now,
						expiresAt: now + this.defaultTtlMs,
					};
					roomState.activeLocks.set(key, activeLock);
					taskHeld.add(key);
				}
				promoted.push(waiter.taskId);
			} else {
				remainingWaiters.push(waiter);
			}
		}

		roomState.waitingQueue = remainingWaiters;
		return promoted;
	}

	clearRoom(roomId: string): void {
		this.rooms.delete(roomId);
		this.saveToDisk();
	}

	getRoomLockInfo(roomId: string, now = Date.now()): RoomLockInfo {
		this.cleanupExpiredLocks(roomId, now);
		const roomState = this.rooms.get(roomId);
		return {
			roomId,
			activeLocks: roomState ? Array.from(roomState.activeLocks.values()) : [],
			waitingQueue: roomState ? [...roomState.waitingQueue] : [],
		};
	}

	close(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.rooms.clear();
	}
}

export function createHubLockManager(options?: HubLockManagerOptions): HubLockManager {
	return new HubLockManager(options);
}
