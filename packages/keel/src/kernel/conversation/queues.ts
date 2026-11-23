import { createQueuedEntry, removeQueuedEntry, type QueuedMessageEntry } from "../../../../../server/queue-utils.js";

export type QueueKind = "steer" | "followUp";

export interface QueueEntryOptions {
	id?: string;
	images?: QueuedMessageEntry["images"];
	attachments?: QueuedMessageEntry["attachments"];
	createdAt?: number;
}

/**
 * 一个对话的两条排队（steer / followUp）。增删规则单源在 `queue-utils.ts`，
 * 这里只负责「按 kind 分开持有」与出队顺序，避免第二条实现漂移。
 */
export class ConversationQueues {
	private readonly lists: Record<QueueKind, QueuedMessageEntry[]> = { steer: [], followUp: [] };

	enqueue(kind: QueueKind, text: string, opts?: QueueEntryOptions): QueuedMessageEntry {
		const entry = createQueuedEntry(text, opts);
		this.lists[kind] = [...this.lists[kind], entry];
		return entry;
	}

	remove(kind: QueueKind, query: { id?: string; text?: string; index?: number }): QueuedMessageEntry | undefined {
		const before = this.lists[kind];
		const after = removeQueuedEntry(before, query);
		if (after.length === before.length) return undefined;
		this.lists[kind] = after;
		return before.find((entry) => !after.includes(entry));
	}

	/** 出队用于投递：先取队列再交给调用方，队列立刻变空（返回副本）。 */
	take(kind: QueueKind): QueuedMessageEntry[] {
		const taken = this.lists[kind];
		this.lists[kind] = [];
		return taken;
	}

	clear(kind?: QueueKind): void {
		if (kind) {
			this.lists[kind] = [];
			return;
		}
		this.lists.steer = [];
		this.lists.followUp = [];
	}

	entries(kind: QueueKind): readonly QueuedMessageEntry[] {
		return this.lists[kind];
	}

	texts(kind: QueueKind): string[] {
		return this.lists[kind].map((entry) => entry.text);
	}

	size(kind: QueueKind): number {
		return this.lists[kind].length;
	}

	total(): number {
		return this.lists.steer.length + this.lists.followUp.length;
	}
}
