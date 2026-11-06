import type { UiMessage } from "./protocol.js";
import { findEntryByUiId, serializeMessage, type AgentMessage, type UiIdEntryLike } from "./serialize.js";

export interface SessionEntryLike extends UiIdEntryLike {
	id: string;
	parentId: string | null;
	type: string;
	timestamp?: string;
	summary?: string;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	message?: AgentMessage;
	content?: unknown;
	display?: boolean;
}

export interface SessionManagerLike {
	getEntries?: () => SessionEntryLike[];
	getBranch?: (id?: string) => SessionEntryLike[];
	getEntry?: (id: string) => SessionEntryLike | undefined;
	buildContextEntries?: () => SessionEntryLike[];
}

export function walkAncestors(targetId: string, allEntries: SessionEntryLike[]): SessionEntryLike[] {
	const byId = new Map<string, SessionEntryLike>();
	for (const e of allEntries) byId.set(e.id, e);
	const path: SessionEntryLike[] = [];
	let curId: string | null = targetId;
	const visited = new Set<string>();
	while (curId && byId.has(curId) && !visited.has(curId)) {
		visited.add(curId);
		const entry: SessionEntryLike = byId.get(curId)!;
		path.push(entry);
		curId = entry.parentId;
	}
	return path.reverse();
}

export function sliceCompactedEntries(
	targetCompaction: SessionEntryLike,
	branch: SessionEntryLike[],
): SessionEntryLike[] {
	const targetIdx = branch.findIndex((e) => e.id === targetCompaction.id);
	if (targetIdx === -1) return [];

	let keptIdx = targetIdx;
	const firstKeptId = targetCompaction.firstKeptEntryId;
	if (firstKeptId && firstKeptId !== targetCompaction.id) {
		const found = branch.findIndex((e) => e.id === firstKeptId);
		if (found >= 0 && found <= targetIdx) {
			keptIdx = found;
		}
	}

	let startIdx = 0;
	for (let i = targetIdx - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			const prevComp = branch[i];
			const prevFirstKeptId = prevComp.firstKeptEntryId;
			if (prevFirstKeptId && prevFirstKeptId !== prevComp.id) {
				const prevKeptIdx = branch.findIndex((e) => e.id === prevFirstKeptId);
				if (prevKeptIdx >= 0 && prevKeptIdx < targetIdx) {
					startIdx = prevKeptIdx;
					break;
				}
			}
			startIdx = i + 1;
			break;
		}
	}

	if (startIdx >= keptIdx) return [];
	return branch.slice(startIdx, keptIdx);
}

export function serializeCompactedEntries(
	entries: SessionEntryLike[],
	seqOf?: (m: AgentMessage) => number,
): UiMessage[] {
	const result: UiMessage[] = [];
	let seq = 1;

	for (const entry of entries) {
		if (entry.type === "message" && entry.message) {
			if (entry.message.role === "system") continue;
			const s = seqOf ? seqOf(entry.message) : seq++;
			const ui = serializeMessage(entry.message, s);
			if (ui) result.push(ui);
		} else if (entry.type === "custom_message" && entry.display !== false) {
			const m = {
				role: "custom",
				content: entry.content,
				timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : 0,
			} as AgentMessage;
			const s = seqOf ? seqOf(m) : seq++;
			const ui = serializeMessage(m, s);
			if (ui) result.push(ui);
		}
	}

	return result;
}

export function getCompactedMessages(
	sessionManager: SessionManagerLike,
	compactionMessageId: string,
	seqOf?: (m: AgentMessage) => number,
): { messages: UiMessage[]; error?: string } {
	try {
		const contextEntries = sessionManager.buildContextEntries?.() ?? [];
		const allEntries = sessionManager.getEntries?.() ?? contextEntries;

		const defaultSeqOf = () => 1;
		let targetCompaction = findEntryByUiId(
			contextEntries,
			compactionMessageId,
			seqOf ?? defaultSeqOf,
		) as SessionEntryLike | null;

		if (!targetCompaction) {
			targetCompaction = findEntryByUiId(
				allEntries,
				compactionMessageId,
				seqOf ?? defaultSeqOf,
			) as SessionEntryLike | null;
		}

		if (!targetCompaction || targetCompaction.type !== "compaction") {
			targetCompaction =
				(sessionManager.getEntry?.(compactionMessageId) as SessionEntryLike | undefined) ??
				allEntries.find((e) => e.id === compactionMessageId && e.type === "compaction") ??
				null;
		}

		if (!targetCompaction || targetCompaction.type !== "compaction") {
			return { messages: [], error: "compactedHistoryNotFound" };
		}

		let branch: SessionEntryLike[] = [];
		if (typeof sessionManager.getBranch === "function") {
			try {
				branch = sessionManager.getBranch(targetCompaction.id) ?? [];
			} catch {
				branch = [];
			}
		}
		if (branch.length === 0) {
			branch = walkAncestors(targetCompaction.id, allEntries);
		}

		const foldedEntries = sliceCompactedEntries(targetCompaction, branch);
		const messages = serializeCompactedEntries(foldedEntries, seqOf);

		return { messages };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { messages: [], error: msg };
	}
}
