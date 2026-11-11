import { useSyncExternalStore } from "react";

export interface ConversationOrderTarget {
	id?: string;
	sessionId?: string | null;
	sessionFile?: string | null;
	path?: string;
	parentId?: string;
	modified?: number;
}

interface Position {
	key: number;
	modified: number;
	promoted: number;
	sessionId?: string;
	parent?: Position;
}

const normalize = (value: string) => value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** 顺序持久化的存储后端：浏览器用 localStorage，测试注入内存实现，传 null 关闭持久化。 */
export interface ConversationOrderStorage {
	read(): string | null;
	write(data: string): void;
}

export const ORDER_STORAGE_KEY = "pi-web-ui:conversation-order";

/** 持久化里每个字段的来历：ids 是该位置的别名（session:/file:/conversation:），
 * key 是稳定的次级排序键，promoted/modified 与内存里的 Position 同源。 */
interface PersistedScope {
	nextKey: number;
	bottom: number;
	initialized: boolean;
	entries: [string[], number, number, number][];
}

interface PersistedOrder {
	version: 1;
	scopes: Record<string, PersistedScope>;
}

/** 最多保留多少个项目/引擎作用域、每个作用域多少条：刷新后用得着的远比这少。 */
const ORDER_MAX_SCOPES = 24;
const ORDER_MAX_ENTRIES = 400;
const ORDER_SAVE_DEBOUNCE_MS = 250;

export const conversationOrderScope = (engine = "pi", cwd: string) => JSON.stringify([engine, normalize(cwd)]);

export class ConversationOrder {
	private positions = new Map<string, Position>();
	private initialized = new Set<string>();
	private bottom = new Map<string, number>();
	private nextKey = 0;
	private version = 0;
	private listeners = new Set<() => void>();
	private submittedEvents = new Set<string>();
	private storage: ConversationOrderStorage | null;
	/** 已经尝试过从持久化恢复的作用域（每页只恢复一次）。 */
	private restoredScopes = new Set<string>();
	/** 出现过的作用域，按出现顺序：序列化时按它分组，超出上限时丢最早的。 */
	private knownScopes = new Set<string>();
	private saveTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(storage: ConversationOrderStorage | null = null) {
		this.storage = storage;
	}

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getSnapshot = () => this.version;

	private aliases(scope: string, target: ConversationOrderTarget): string[] {
		return [
			target.sessionId ? `session:${normalize(target.sessionId)}` : "",
			target.sessionFile || target.path ? `file:${normalize(target.sessionFile || target.path!)}` : "",
			target.id ? `conversation:${target.id}` : "",
		]
			.filter(Boolean)
			.map((key) => `${scope}:${key}`);
	}

	/**
	 * 从持久化里恢复这个作用域的排序依据（每个作用域只做一次，且必须发生在
	 * 首次 remember 之前）：没有它，刷新后排序依据从零开始，按服务端最新的
	 * modified/lastUsed 重排，用户刚建的项目和会话就整体位移了。
	 */
	private restoreScope(scope: string) {
		this.knownScopes.add(scope);
		if (this.restoredScopes.has(scope)) return;
		this.restoredScopes.add(scope);
		if (!this.storage) return;
		let data: PersistedOrder | null = null;
		try {
			const raw = this.storage.read();
			data = raw ? (JSON.parse(raw) as PersistedOrder) : null;
		} catch {
			return;
		}
		const saved = data?.scopes?.[scope];
		if (!saved || !Array.isArray(saved.entries)) return;
		const byKey = new Map<number, Position>();
		for (const entry of saved.entries) {
			if (!Array.isArray(entry) || entry.length < 4) continue;
			const [ids, promoted, modified, key] = entry;
			if (!Array.isArray(ids) || ids.length === 0 || !Number.isFinite(key)) continue;
			let position = byKey.get(key);
			if (!position) {
				position = { key, modified: Number.isFinite(modified) ? modified : 0, promoted: 0 };
				byKey.set(key, position);
			}
			if (Number.isFinite(promoted)) position.promoted = Math.max(position.promoted, promoted);
			for (const id of ids) this.positions.set(`${scope}:${id}`, position);
		}
		if (byKey.size === 0) return;
		if (Number.isFinite(saved.bottom)) this.bottom.set(scope, saved.bottom);
		if (saved.initialized) this.initialized.add(scope);
		if (Number.isFinite(saved.nextKey)) this.nextKey = Math.max(this.nextKey, saved.nextKey);
		for (const key of byKey.keys()) this.nextKey = Math.max(this.nextKey, key + 1);
	}

	/** 合并写入：频繁的流式更新只安排一次落盘。 */
	private scheduleSave() {
		if (!this.storage || this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			this.flushSave();
		}, ORDER_SAVE_DEBOUNCE_MS);
		(this.saveTimer as unknown as { unref?: () => void }).unref?.();
	}

	private flushSave(): void {
		if (!this.storage) return;
		const scopes: Record<string, PersistedScope> = {};
		const ordered = [...this.knownScopes].slice(-ORDER_MAX_SCOPES);
		for (const scope of ordered) {
			const prefix = `${scope}:`;
			const grouped = new Map<Position, string[]>();
			for (const [key, position] of this.positions) {
				if (!key.startsWith(prefix)) continue;
				const ids = grouped.get(position);
				if (ids) ids.push(key.slice(prefix.length));
				else grouped.set(position, [key.slice(prefix.length)]);
			}
			if (grouped.size === 0) continue;
			const entries = [...grouped.entries()]
				.sort((a, b) => a[0].key - b[0].key)
				.slice(0, ORDER_MAX_ENTRIES)
				.map(
					([position, ids]) =>
						[ids.sort(), position.promoted, position.modified, position.key] as PersistedScope["entries"][number],
				);
			scopes[scope] = {
				nextKey: this.nextKey,
				bottom: this.bottom.get(scope) ?? 0,
				initialized: this.initialized.has(scope),
				entries,
			};
		}
		try {
			this.storage.write(JSON.stringify({ version: 1, scopes } satisfies PersistedOrder));
		} catch {}
	}

	private remember(scope: string, target: ConversationOrderTarget): Position {
		this.restoreScope(scope);
		const aliases = this.aliases(scope, target);
		const candidates = aliases.flatMap((key) => this.positions.get(key) ?? []);
		const sessionId = target.sessionId
			? normalize(target.sessionId)
			: candidates.find((entry) => entry.sessionId)?.sessionId;
		const known = [
			...new Set(candidates.filter((entry) => !sessionId || !entry.sessionId || entry.sessionId === sessionId)),
		].sort((a, b) => a.key - b.key);
		const modified = this.initialized.has(scope) ? (this.bottom.get(scope) ?? 0) - 1 : (target.modified ?? Date.now());
		const position: Position = known[0] ?? { key: this.nextKey++, modified, promoted: 0 };
		if (sessionId) position.sessionId = sessionId;
		if (!this.initialized.has(scope) && target.modified != null) position.modified = target.modified;
		this.bottom.set(scope, Math.min(this.bottom.get(scope) ?? position.modified, position.modified));
		for (const duplicate of known.slice(1)) {
			position.promoted = Math.max(position.promoted, duplicate.promoted);
			for (const [key, entry] of this.positions) {
				if (entry === duplicate) this.positions.set(key, position);
				if (entry.parent === duplicate) entry.parent = position;
			}
		}
		for (const key of aliases) this.positions.set(key, position);
		if (target.parentId) {
			position.parent = this.positions.get(`${scope}:conversation:${target.parentId}`);
		} else if (target.id) {
			delete position.parent;
		}
		this.promoteAncestors(position);
		this.scheduleSave();
		return position;
	}

	private promoteAncestors(position: Position) {
		const visited = new Set<Position>();
		for (let parent = position.parent; parent && !visited.has(parent); parent = parent.parent) {
			visited.add(parent);
			parent.promoted = Math.max(parent.promoted, position.promoted);
		}
	}

	observe(scope: string, targets: readonly ConversationOrderTarget[], complete = true) {
		for (const target of targets) this.remember(scope, target);
		if (complete && targets.length > 0) this.initialized.add(scope);
	}

	sort<T>(scope: string, items: readonly T[], targetOf: (item: T) => ConversationOrderTarget, initialize = true): T[] {
		const entries = items.map((item) => ({ item, target: targetOf(item) }));
		this.observe(
			scope,
			entries.map((entry) => entry.target),
			initialize,
		);
		const ranked = entries.map(({ item, target }) => ({ item, position: this.remember(scope, target) }));
		ranked.sort(
			(a, b) =>
				b.position.promoted - a.position.promoted ||
				b.position.modified - a.position.modified ||
				a.position.key - b.position.key,
		);
		return ranked.map(({ item }) => item);
	}

	key(scope: string, target: ConversationOrderTarget): number {
		return this.remember(scope, target).key;
	}

	promote(scope: string, target: ConversationOrderTarget, eventId?: string) {
		const position = this.remember(scope, target);
		if (eventId) {
			const key = JSON.stringify([scope, target.sessionId || target.id, eventId]);
			if (this.submittedEvents.has(key)) return;
			this.submittedEvents.add(key);
			if (this.submittedEvents.size > 512) this.submittedEvents.delete(this.submittedEvents.values().next().value!);
		}
		position.promoted = ++this.version;
		this.promoteAncestors(position);
		this.scheduleSave();
		for (const listener of this.listeners) listener();
	}

	clear() {
		this.positions.clear();
		this.initialized.clear();
		this.bottom.clear();
		this.submittedEvents.clear();
		this.knownScopes.clear();
		this.restoredScopes.clear();
		this.nextKey = 0;
		this.version++;
		// 清空也要落盘：否则刷新后旧顺序又回来了（引擎/项目切换与测试清理都走这里）。
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		this.flushSave();
		for (const listener of this.listeners) listener();
	}
}

/**
 * 浏览器里的 localStorage 后端。读写都延迟到调用时，测试替换 localStorage
 * 也能生效；没有 localStorage 的环境（node 单测）返回 null ＝ 不持久化。
 */
const browserOrderStorage: ConversationOrderStorage | null =
	typeof localStorage === "undefined"
		? null
		: {
				read: () => localStorage.getItem(ORDER_STORAGE_KEY),
				write: (data: string) => localStorage.setItem(ORDER_STORAGE_KEY, data),
			};

export const conversationOrder = new ConversationOrder(browserOrderStorage);

export function recordUserPrompt(
	state: { engine?: string; cwd: string; conversationId: string; sessionId?: string; sessionFile?: string },
	conversations: readonly (ConversationOrderTarget & { cwd: string })[],
	eventId?: string,
) {
	const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
	const active = byId.get(state.conversationId);
	const target = {
		...active,
		id: state.conversationId,
		sessionId: state.sessionId || active?.sessionId,
		sessionFile: state.sessionFile || active?.sessionFile,
	};
	const ancestry: ConversationOrderTarget[] = [target];
	const visited = new Set([target.id]);
	let root = active;
	while (root?.parentId && !visited.has(root.parentId)) {
		const parent = byId.get(root.parentId);
		if (!parent) break;
		visited.add(root.parentId);
		ancestry.push(parent);
		root = parent;
	}
	const scope = conversationOrderScope(state.engine, root?.cwd ?? state.cwd);
	conversationOrder.observe(scope, ancestry, false);
	conversationOrder.promote(scope, target, eventId);
}

export function useConversationOrderVersion(): number {
	return useSyncExternalStore(conversationOrder.subscribe, conversationOrder.getSnapshot);
}
