import { useSyncExternalStore } from "react";

/**
 * 跟踪和管理「已完成但未查看」（completed unread）的会话状态。
 *
 * 核心机制：
 * 1. 独立单例 Store + useSyncExternalStore：保证全局引用稳定，不触发多余重渲染；
 * 2. 状态存储支持 sessionStorage 持久化（键名 "pi.unread_conversations"），页面刷新后不丢失；
 * 3. 产生时机：
 *    - 会话从运行中 (isStreaming / completionPending) 跃迁到结束态 (idle)；
 *    - 且当前会话不是 activeConversationId，或处于 active 状态但窗口失焦 (document.hasFocus() === false)；
 *    - 记录会话 id、sessionId、sessionFile 或 path；
 * 4. 消除时机：
 *    - 用户点击/切换到该会话，且窗口处于聚焦状态；
 *    - 窗口重新获得焦点（若当前会话正是该会话）；
 *    - 会话被关闭、移除或删除；
 *    - 会话重新开始运行（再次进入 running 态）。
 */

export interface UnreadConversationEntry {
	id: string;
	sessionId?: string;
	sessionFile?: string;
	path?: string;
	finishedAt: number;
}

const STORAGE_KEY = "pi.unread_conversations";
const MAX_AGE_MS = 7 * 24 * 3600 * 1000; // 超过 7 天自动清理

function loadPersistedEntries(): UnreadConversationEntry[] {
	if (typeof window === "undefined" || !window.sessionStorage) return [];
	try {
		const raw = window.sessionStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const list = JSON.parse(raw);
		if (!Array.isArray(list)) return [];
		const now = Date.now();
		return list.filter((item) => item && typeof item.id === "string" && now - (item.finishedAt || 0) < MAX_AGE_MS);
	} catch {
		return [];
	}
}

function persistEntries(entries: Iterable<UnreadConversationEntry>): void {
	if (typeof window === "undefined" || !window.sessionStorage) return;
	try {
		const arr = Array.from(entries);
		if (arr.length === 0) {
			window.sessionStorage.removeItem(STORAGE_KEY);
		} else {
			window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
		}
	} catch {}
}

class UnreadStore {
	private entries = new Map<string, UnreadConversationEntry>();
	private keyToPrimaryId = new Map<string, string>();
	private cachedKeySet: ReadonlySet<string> = new Set();
	private listeners = new Set<() => void>();

	constructor() {
		const initial = loadPersistedEntries();
		if (initial.length > 0) {
			for (const entry of initial) {
				this.addEntryInternal(entry);
			}
			this.updateCachedKeySet();
		}
	}

	private normalizeKey(key?: string | null): string | null {
		if (!key) return null;
		const trimmed = key.trim();
		if (!trimmed) return null;
		return trimmed.toLowerCase();
	}

	private addEntryInternal(entry: UnreadConversationEntry): void {
		this.entries.set(entry.id, entry);
		const normId = this.normalizeKey(entry.id);
		if (normId) this.keyToPrimaryId.set(normId, entry.id);

		const normSid = this.normalizeKey(entry.sessionId);
		if (normSid) this.keyToPrimaryId.set(normSid, entry.id);

		const normFile = this.normalizeKey(entry.sessionFile);
		if (normFile) this.keyToPrimaryId.set(normFile, entry.id);

		const normPath = this.normalizeKey(entry.path);
		if (normPath) this.keyToPrimaryId.set(normPath, entry.id);
	}

	private updateCachedKeySet(): void {
		const set = new Set<string>();
		for (const [normKey] of this.keyToPrimaryId.entries()) {
			set.add(normKey);
		}
		// 同时也把原始形态的 key 放入，方便双向比对
		for (const entry of this.entries.values()) {
			if (entry.id) set.add(entry.id);
			if (entry.sessionId) set.add(entry.sessionId);
			if (entry.sessionFile) set.add(entry.sessionFile);
			if (entry.path) set.add(entry.path);
		}
		this.cachedKeySet = set;
	}

	private notify(): void {
		this.updateCachedKeySet();
		persistEntries(this.entries.values());
		for (const l of this.listeners) {
			try {
				l();
			} catch {}
		}
	}

	public subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	public getSnapshot = (): ReadonlySet<string> => {
		return this.cachedKeySet;
	};

	public markUnread(items: Array<{ id: string; sessionId?: string; sessionFile?: string; path?: string }>): void {
		let changed = false;
		const now = Date.now();
		for (const item of items) {
			if (!item.id) continue;
			const existing = this.entries.get(item.id);
			const entry: UnreadConversationEntry = {
				id: item.id,
				sessionId: item.sessionId || existing?.sessionId,
				sessionFile: item.sessionFile || existing?.sessionFile,
				path: item.path || existing?.path,
				finishedAt: now,
			};
			this.addEntryInternal(entry);
			changed = true;
		}
		if (changed) {
			this.notify();
		}
	}

	public clearUnread(idOrKey?: string | null): void {
		if (!idOrKey) return;
		const normKey = this.normalizeKey(idOrKey);
		if (!normKey) return;

		const primaryId = this.keyToPrimaryId.get(normKey) ?? (this.entries.has(idOrKey) ? idOrKey : null);
		if (!primaryId) {
			// 直接尝试在 entries 中按 key 清理
			if (this.entries.delete(idOrKey)) {
				this.rebuildKeyMap();
				this.notify();
			}
			return;
		}

		const entry = this.entries.get(primaryId);
		this.entries.delete(primaryId);

		// 从 keyToPrimaryId 中移除所有关联 key
		if (entry) {
			const kId = this.normalizeKey(entry.id);
			if (kId) this.keyToPrimaryId.delete(kId);
			const kSid = this.normalizeKey(entry.sessionId);
			if (kSid) this.keyToPrimaryId.delete(kSid);
			const kFile = this.normalizeKey(entry.sessionFile);
			if (kFile) this.keyToPrimaryId.delete(kFile);
			const kPath = this.normalizeKey(entry.path);
			if (kPath) this.keyToPrimaryId.delete(kPath);
		}
		this.keyToPrimaryId.delete(normKey);

		this.notify();
	}

	private rebuildKeyMap(): void {
		this.keyToPrimaryId.clear();
		for (const entry of this.entries.values()) {
			this.addEntryInternal(entry);
		}
	}

	public clearAll(): void {
		if (this.entries.size === 0 && this.keyToPrimaryId.size === 0) return;
		this.entries.clear();
		this.keyToPrimaryId.clear();
		this.notify();
	}

	public isUnread(keys: { id?: string; sessionId?: string; sessionFile?: string; path?: string }): boolean {
		if (keys.id && (this.cachedKeySet.has(keys.id) || this.cachedKeySet.has(keys.id.trim().toLowerCase()))) {
			return true;
		}
		if (
			keys.sessionId &&
			(this.cachedKeySet.has(keys.sessionId) || this.cachedKeySet.has(keys.sessionId.trim().toLowerCase()))
		) {
			return true;
		}
		if (
			keys.sessionFile &&
			(this.cachedKeySet.has(keys.sessionFile) || this.cachedKeySet.has(keys.sessionFile.trim().toLowerCase()))
		) {
			return true;
		}
		if (keys.path && (this.cachedKeySet.has(keys.path) || this.cachedKeySet.has(keys.path.trim().toLowerCase()))) {
			return true;
		}
		return false;
	}
}

export const unreadStore = new UnreadStore();

export function markConversationUnread(item: {
	id: string;
	sessionId?: string;
	sessionFile?: string;
	path?: string;
}): void {
	unreadStore.markUnread([item]);
}

export function markConversationsUnread(
	items: Array<{ id: string; sessionId?: string; sessionFile?: string; path?: string }>,
): void {
	unreadStore.markUnread(items);
}

export function clearConversationUnread(idOrKey?: string | null): void {
	unreadStore.clearUnread(idOrKey);
}

export function clearAllUnread(): void {
	unreadStore.clearAll();
}

export function isConversationUnread(keys: {
	id?: string;
	sessionId?: string;
	sessionFile?: string;
	path?: string;
}): boolean {
	return unreadStore.isUnread(keys);
}

/**
 * 订阅所有未读键集合的快照（组件内使用）。
 */
export function useUnreadConversationKeys(): ReadonlySet<string> {
	return useSyncExternalStore(unreadStore.subscribe, unreadStore.getSnapshot, unreadStore.getSnapshot);
}
