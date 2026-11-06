import type { GroupHistoryMessage, GroupTaskContext } from "./group-context.js";

export type PlannedGroupTaskContext = GroupTaskContext & {
	delivery: {
		mode: "snapshot" | "delta";
		previousThroughMessageId?: string | null;
		gap?: true;
	};
};

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
