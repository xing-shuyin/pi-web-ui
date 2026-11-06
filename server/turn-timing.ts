import type { UiState } from "./protocol.js";

type TimedConversation = { turnTiming?: UiState["turnTiming"] };

export function startTurnTiming(conv: TimedConversation, now = Date.now()): void {
	if (!conv.turnTiming || conv.turnTiming.finishedAt !== undefined) {
		conv.turnTiming = { startedAt: now };
	}
}

export function finishTurnTiming(conv: TimedConversation, now = Date.now()): void {
	if (conv.turnTiming && conv.turnTiming.finishedAt === undefined) {
		conv.turnTiming = { ...conv.turnTiming, finishedAt: Math.max(now, conv.turnTiming.startedAt) };
	}
}
