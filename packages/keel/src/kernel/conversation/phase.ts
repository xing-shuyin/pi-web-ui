import type { ConversationPhase } from "./types.js";

const TRANSITIONS: Readonly<Record<ConversationPhase, readonly ConversationPhase[]>> = Object.freeze({
	idle: Object.freeze(["running", "retiring"] as const),
	running: Object.freeze(["idle", "retiring"] as const),
	retiring: Object.freeze(["retired"] as const),
	retired: Object.freeze([] as const),
});

export function canTransition(from: ConversationPhase, to: ConversationPhase): boolean {
	return TRANSITIONS[from].includes(to);
}

/** 退役是单向闸：一旦进入 `retiring`，本条对话不再接新回合（红线：退役会话 fail-closed）。 */
export function acceptsTurns(phase: ConversationPhase): boolean {
	return phase === "idle" || phase === "running";
}

export function isTerminal(phase: ConversationPhase): boolean {
	return phase === "retired";
}

export class ConversationPhaseError extends Error {
	constructor(
		readonly from: ConversationPhase,
		readonly to: ConversationPhase,
	) {
		super(`conversation phase ${from} → ${to} is not allowed`);
		this.name = "ConversationPhaseError";
	}
}

export function transition(from: ConversationPhase, to: ConversationPhase): ConversationPhase {
	if (from === to) return from;
	if (!canTransition(from, to)) throw new ConversationPhaseError(from, to);
	return to;
}
