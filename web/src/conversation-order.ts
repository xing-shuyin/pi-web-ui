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

export const conversationOrderScope = (engine = "pi", cwd: string) => JSON.stringify([engine, normalize(cwd)]);

export class ConversationOrder {
	private positions = new Map<string, Position>();
	private initialized = new Set<string>();
	private bottom = new Map<string, number>();
	private nextKey = 0;
	private version = 0;
	private listeners = new Set<() => void>();
	private submittedEvents = new Set<string>();

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

	private remember(scope: string, target: ConversationOrderTarget): Position {
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
		for (const listener of this.listeners) listener();
	}

	clear() {
		this.positions.clear();
		this.initialized.clear();
		this.bottom.clear();
		this.submittedEvents.clear();
		this.nextKey = 0;
		this.version++;
		for (const listener of this.listeners) listener();
	}
}

export const conversationOrder = new ConversationOrder();

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
