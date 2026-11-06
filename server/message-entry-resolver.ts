import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { findEntryByUiId, type UiIdEntryLike, type AgentMessage } from "./serialize.js";

export function resolveUserMessageEntryId(
	contextEntries: Iterable<{ type?: string; message?: unknown; id: string }>,
	messageId: string,
): string | null {
	const m = /^u-(\d+)(?:-(\d+))?$/.exec(messageId);
	if (!m) return null;
	const ts = Number(m[1]);
	const seq = m[2] ? Number(m[2]) : 1;
	let count = 0;

	for (const entry of contextEntries) {
		if (entry.type !== "message") continue;
		const msg = (entry as unknown as { message?: AgentMessage }).message;
		if (!msg || msg.role !== "user" || msg.timestamp !== ts) continue;
		count += 1;
		if (count === seq) return entry.id;
	}
	return null;
}

export function resolveConversationMessageEntry(
	contextEntries: SessionEntry[],
	messageId: string,
	seqOf: (m: AgentMessage) => number,
	fallbackGetEntry?: (id: string) => SessionEntry | null | undefined,
): SessionEntry | null {
	const found = findEntryByUiId(contextEntries as (UiIdEntryLike & SessionEntry)[], messageId, seqOf);
	return found ?? fallbackGetEntry?.(messageId) ?? null;
}
