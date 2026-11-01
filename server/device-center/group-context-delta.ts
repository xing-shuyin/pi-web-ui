import type { GroupHistoryMessage, GroupTaskContext } from "./group-context.js";

export type PlannedGroupTaskContext = GroupTaskContext & {
	delivery: {
		mode: "snapshot" | "delta";
		previousThroughMessageId?: string | null;
		/** The prior anchor is unavailable; this snapshot is only the currently retained window. */
		gap?: true;
	};
};

// Serialize explicitly so object insertion order cannot change equality. Array order is significant.
function chunkKey(message: GroupHistoryMessage): string {
	return JSON.stringify([
		message.id,
		message.textStart,
		message.textEnd,
		message.fullTextLength,
		message.text,
		message.sender.type,
		message.sender.id,
		message.sender.name,
		message.createdAt,
		message.targetBotIds,
	]);
}

/**
 * Previous must aggregate ONLY exact chunks still present in the active model context, with
 * the newest delivered throughMessageId. A persisted transcript or last planned snapshot
 * cannot establish that evidence, especially after compaction. Omit previous when uncertain.
 * This filters history only: callers must always retain the complete current task text.
 * A snapshot remains bounded by current.truncated/retentionLimit; it never claims full history.
 */
export function planGroupContext(current: GroupTaskContext, previous?: GroupTaskContext): PlannedGroupTaskContext {
	if (!previous || previous.roomId !== current.roomId) {
		return { ...current, delivery: { mode: "snapshot" } };
	}
	const previousThroughMessageId = previous.throughMessageId;
	if (previousThroughMessageId !== null && !current.messages.some((row) => row.id === previousThroughMessageId)) {
		return { ...current, delivery: { mode: "snapshot", previousThroughMessageId, gap: true } };
	}
	const present = new Set(previous.messages.map(chunkKey));
	return {
		...current,
		messages: current.messages.filter((row) => !present.has(chunkKey(row))),
		delivery: { mode: "delta", previousThroughMessageId },
	};
}
