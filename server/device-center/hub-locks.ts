import { readFileSync } from "node:fs";
import { type RoomActiveLock, type RoomLockInfo, type RoomLockWaiter } from "../protocol.js";
import { createSerializedJsonWriter, type SerializedJsonWriter } from "../serialized-json-writer.js";

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
	/** 运行中任务判定：清理过期锁时跳过仍存活的持锁任务（防长任务被静默摘锁）。 */
	isAlive?: (taskId: string) => boolean;
}

export class HubLockManager {
	private readonly rooms = new Map<string, RoomLockState>();
	private readonly defaultTtlMs: number;
	private readonly persistPath?: string;
	private readonly isAlive?: (taskId: string) => boolean;
	private readonly writer?: SerializedJsonWriter;
	private timer?: NodeJS.Timeout;

	constructor(options: HubLockManagerOptions = {}) {
		this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_RESOURCE_LOCK_TTL_MS;
		this.persistPath = options.persistPath;
		this.isAlive = options.isAlive;
		// 房间锁是重启后要还原的真值：走串行落盘器（同一文件有序、不阻塞事件循环），每个改锁方法 await 落盘后才改内存。
		this.writer = options.persistPath
			? createSerializedJsonWriter(options.persistPath, { label: "room-locks.json" })
			: undefined;
		if (this.persistPath) {
			this.loadFromDisk();
		}
		if (options.autoCleanupIntervalMs && options.autoCleanupIntervalMs > 0) {
			this.timer = setInterval(() => {
				void this.cleanupExpiredLocks().catch((error: unknown) => {
					console.error("[device-center] 房间锁过期清理落盘失败：", error);
				});
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

	/**
	 * 落盘快照。`overrides` 里的房间用「草稿」替换当前内存：先写草稿、写成功后再把草稿换成内存，
	 * 这样即使落盘失败也不会留下一条只在内存里的锁（重启后就不见了）。
	 * 空草稿（无活跃锁且无等待者）不出现在快照里，等于从文件里剔除该房间。
	 */
	private serializeRooms(overrides?: Map<string, RoomLockState>) {
		const serializedRooms: Record<string, { activeLocks: RoomActiveLock[]; waitingQueue: RoomLockWaiter[] }> = {};
		const push = (roomId: string, state: RoomLockState) => {
			if (state.activeLocks.size === 0 && state.waitingQueue.length === 0) return;
			serializedRooms[roomId] = {
				activeLocks: Array.from(state.activeLocks.values()),
				waitingQueue: [...state.waitingQueue],
			};
		};
		for (const [roomId, state] of this.rooms.entries()) {
			if (overrides?.has(roomId)) continue;
			push(roomId, state);
		}
		for (const [roomId, state] of overrides ?? []) push(roomId, state);
		return serializedRooms;
	}

	/** 落盘成功才返回；失败原样抛出（锁状态不能“看起来拿到了”）。 */
	private async persist(overrides?: Map<string, RoomLockState>): Promise<void> {
		if (!this.writer) return;
		await this.writer.writeNow({ version: 1, updatedAt: Date.now(), rooms: this.serializeRooms(overrides) });
	}

	private cloneRoomState(state?: RoomLockState): RoomLockState {
		return {
			activeLocks: new Map(Array.from(state?.activeLocks ?? [], ([key, lock]) => [key, { ...lock }])),
			taskLocks: new Map(Array.from(state?.taskLocks ?? [], ([taskId, keys]) => [taskId, new Set(keys)])),
			waitingQueue: (state?.waitingQueue ?? []).map((waiter) => ({ ...waiter, lockKeys: [...waiter.lockKeys] })),
		};
	}

	async acquireLocks(options: AcquireLocksOptions): Promise<AcquireLocksResult> {
		const now = options.now ?? Date.now();
		const ttlMs = options.ttlMs ?? this.defaultTtlMs;
		const locks = validateResourceLocks(options.resourceLocks);
		if (locks.length === 0) {
			return { success: true, conflictingLocks: [], holderTaskIds: [] };
		}

		await this.cleanupExpiredLocks(options.roomId, now);
		const roomState = this.cloneRoomState(this.rooms.get(options.roomId));

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
			await this.persist(new Map([[options.roomId, roomState]]));
			this.rooms.set(options.roomId, roomState);
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

		await this.persist(new Map([[options.roomId, roomState]]));
		this.rooms.set(options.roomId, roomState);
		return { success: true, conflictingLocks: [], holderTaskIds: [] };
	}

	async releaseLocks(roomId: string, taskId: string, now = Date.now()): Promise<string[]> {
		const stored = this.rooms.get(roomId);
		if (!stored) return [];
		const roomState = this.cloneRoomState(stored);

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

		const promoted = this.promoteWaitingTasks(roomState, roomId, now);
		await this.persist(new Map([[roomId, roomState]]));
		this.rooms.set(roomId, roomState);
		return promoted;
	}

	/** 心跳续期：运行中任务的锁到期前延长，避免长任务被静默摘锁。 */
	async renewLocks(roomId: string, taskId: string, now = Date.now(), ttlMs?: number): Promise<string[]> {
		const stored = this.rooms.get(roomId);
		if (!stored) return [];
		const held = stored.taskLocks.get(taskId);
		if (!held || held.size === 0) return [];
		const roomState = this.cloneRoomState(stored);
		const ttl = ttlMs ?? this.defaultTtlMs;
		const renewed: string[] = [];
		for (const key of held) {
			const current = roomState.activeLocks.get(key);
			if (current?.taskId === taskId) {
				current.expiresAt = now + ttl;
				renewed.push(key);
			}
		}
		if (renewed.length > 0) {
			await this.persist(new Map([[roomId, roomState]]));
			this.rooms.set(roomId, roomState);
		}
		return renewed;
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

	async cleanupExpiredLocks(
		roomId?: string,
		now = Date.now(),
		isAlive?: (taskId: string) => boolean,
	): Promise<string[]> {
		const alive = isAlive ?? this.isAlive;
		const promotedAll: string[] = [];
		const roomIds = roomId ? [roomId] : Array.from(this.rooms.keys());
		const drafts = new Map<string, RoomLockState>();

		for (const rId of roomIds) {
			const stored = this.rooms.get(rId);
			if (!stored) continue;
			const roomState = this.cloneRoomState(stored);

			let expiredAny = false;
			let renewedAny = false;
			for (const [key, lock] of Array.from(roomState.activeLocks.entries())) {
				if (lock.expiresAt <= now) {
					// 持锁任务仍存活（running 且心跳/租约有效）时续期而非摘锁，互斥不中断。
					if (alive?.(lock.taskId)) {
						lock.expiresAt = now + this.defaultTtlMs;
						renewedAny = true;
						continue;
					}
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
				const promoted = this.promoteWaitingTasks(roomState, rId, now);
				promotedAll.push(...promoted);
				drafts.set(rId, roomState);
			} else if (renewedAny) {
				drafts.set(rId, roomState);
			}
		}

		if (drafts.size > 0) {
			await this.persist(drafts);
			for (const [rId, roomState] of drafts) this.rooms.set(rId, roomState);
		}

		return promotedAll;
	}

	private promoteWaitingTasks(roomState: RoomLockState, roomId: string, now = Date.now()): string[] {
		if (roomState.waitingQueue.length === 0) return [];

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

	async clearRoom(roomId: string): Promise<void> {
		// 空草稿 = 从落盘快照里剔除该房间，写成功后内存才跟着删。
		await this.persist(new Map([[roomId, this.cloneRoomState()]]));
		this.rooms.delete(roomId);
	}

	async getRoomLockInfo(roomId: string, now = Date.now()): Promise<RoomLockInfo> {
		await this.cleanupExpiredLocks(roomId, now);
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
