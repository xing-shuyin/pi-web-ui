import type { PromptAttachment, QueuedPromptItem } from "./protocol.js";

export function removeFirstOccurrence(list: readonly string[], text: string): string[] {
	const index = list.indexOf(text);
	if (index < 0) return [...list];
	return [...list.slice(0, index), ...list.slice(index + 1)];
}

export function removeQueuedByIndexOrText(list: readonly string[], text: string, index?: number): string[] {
	if (
		typeof index === "number" &&
		Number.isInteger(index) &&
		index >= 0 &&
		index < list.length &&
		list[index] === text
	) {
		return [...list.slice(0, index), ...list.slice(index + 1)];
	}
	return removeFirstOccurrence(list, text);
}

export interface QueuedImagePayload {
	type: "image";
	data: string;
	mimeType: string;
}

export interface QueuedMessageEntry {
	id: string;
	text: string;
	images?: QueuedImagePayload[];
	attachments?: PromptAttachment[];
	createdAt?: number;
}

let queueSeq = 0;
export function generateQueueId(): string {
	return `q-${Date.now().toString(36)}-${(++queueSeq).toString(36)}`;
}

export function createQueuedEntry(
	text: string,
	opts?: {
		id?: string;
		images?: QueuedImagePayload[];
		attachments?: PromptAttachment[];
		createdAt?: number;
	},
): QueuedMessageEntry {
	return {
		id: opts?.id || generateQueueId(),
		text,
		images: opts?.images,
		attachments: opts?.attachments,
		createdAt: opts?.createdAt ?? Date.now(),
	};
}

export function removeQueuedEntry(
	list: readonly QueuedMessageEntry[],
	query: { id?: string; text?: string; index?: number },
): QueuedMessageEntry[] {
	if (query.id) {
		const idx = list.findIndex((e) => e.id === query.id);
		if (idx >= 0) {
			return [...list.slice(0, idx), ...list.slice(idx + 1)];
		}
	}
	if (
		typeof query.index === "number" &&
		Number.isInteger(query.index) &&
		query.index >= 0 &&
		query.index < list.length &&
		(!query.text || list[query.index]?.text === query.text)
	) {
		return [...list.slice(0, query.index), ...list.slice(query.index + 1)];
	}
	if (query.text !== undefined) {
		const idx = list.findIndex((e) => e.text === query.text);
		if (idx >= 0) {
			return [...list.slice(0, idx), ...list.slice(idx + 1)];
		}
	}
	return [...list];
}

export function removeQueuedEntryByIndexOrText(
	list: readonly QueuedMessageEntry[],
	text: string,
	index?: number,
): QueuedMessageEntry[] {
	return removeQueuedEntry(list, { text, index });
}

export function rollbackQueuedEntry(list: readonly QueuedMessageEntry[], text: string): QueuedMessageEntry[] {
	for (let i = list.length - 1; i >= 0; i--) {
		if (list[i]?.text === text) {
			return [...list.slice(0, i), ...list.slice(i + 1)];
		}
	}
	return [...list];
}

export function reconcileQueuedEntries(
	currentEntries: readonly QueuedMessageEntry[],
	newTexts: readonly string[],
): QueuedMessageEntry[] {
	if (!newTexts || newTexts.length === 0) {
		return [];
	}
	if (!currentEntries || currentEntries.length === 0) {
		return newTexts.map((text) => createQueuedEntry(text));
	}

	if (currentEntries.length === newTexts.length) {
		let allMatch = true;
		for (let i = 0; i < newTexts.length; i++) {
			if (currentEntries[i]?.text !== newTexts[i]) {
				allMatch = false;
				break;
			}
		}
		if (allMatch) {
			return [...currentEntries];
		}
	}

	if (currentEntries.length > newTexts.length) {
		const dropCount = currentEntries.length - newTexts.length;
		const headDropped = currentEntries.slice(dropCount);
		let matchesTail = true;
		for (let i = 0; i < newTexts.length; i++) {
			if (headDropped[i]?.text !== newTexts[i]) {
				matchesTail = false;
				break;
			}
		}
		if (matchesTail) {
			return headDropped;
		}
	}

	if (currentEntries.length < newTexts.length) {
		let prefixMatch = true;
		for (let i = 0; i < currentEntries.length; i++) {
			if (currentEntries[i]?.text !== newTexts[i]) {
				prefixMatch = false;
				break;
			}
		}
		if (prefixMatch) {
			const res = [...currentEntries];
			for (let i = currentEntries.length; i < newTexts.length; i++) {
				res.push(createQueuedEntry(newTexts[i]!));
			}
			return res;
		}
	}

	const available = currentEntries.map((e, idx) => ({ ...e, idx, used: false }));
	const result: QueuedMessageEntry[] = new Array(newTexts.length);

	for (let i = newTexts.length - 1; i >= 0; i--) {
		const targetText = newTexts[i]!;
		let foundIdx = -1;
		for (let j = available.length - 1; j >= 0; j--) {
			if (!available[j]!.used && available[j]!.text === targetText) {
				foundIdx = j;
				break;
			}
		}
		if (foundIdx !== -1) {
			available[foundIdx]!.used = true;
			const matched = available[foundIdx]!;
			result[i] = {
				id: matched.id,
				text: targetText,
				images: matched.images,
				attachments: matched.attachments,
				createdAt: matched.createdAt,
			};
		} else {
			result[i] = createQueuedEntry(targetText);
		}
	}

	return result;
}

export function toQueuedPromptItems(entries: readonly QueuedMessageEntry[]): QueuedPromptItem[] {
	return entries.map((e) => ({
		id: e.id,
		text: e.text,
		attachments: e.attachments,
		createdAt: e.createdAt,
	}));
}

export function toQueuedPromptTexts(entries: readonly QueuedMessageEntry[]): string[] {
	return entries.map((e) => e.text);
}
