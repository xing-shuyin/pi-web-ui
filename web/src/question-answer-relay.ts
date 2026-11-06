import type { ClientMessage } from "../../server/protocol.js";
import { appSend } from "./app-globals";

function keyOf(id: string, owner?: string): string {
	return owner ? `${owner}\u0000${id}` : id;
}

const unconfirmed = new Map<string, ClientMessage>();

export function sendQuestionAnswer(msg: ClientMessage & { type: "question_answer" }): boolean {
	const key = keyOf(msg.id, msg.owner);
	unconfirmed.delete(key);
	unconfirmed.set(key, msg);
	if (unconfirmed.size > 64) {
		const oldest = unconfirmed.keys().next().value;
		if (oldest !== undefined) unconfirmed.delete(oldest);
	}
	return appSend(msg);
}

export function confirmQuestionAnswer(id: string, owner?: string): void {
	if (owner) {
		unconfirmed.delete(keyOf(id, owner));
		return;
	}
	unconfirmed.delete(id);
	for (const key of unconfirmed.keys()) {
		if (key.endsWith(`\u0000${id}`)) {
			unconfirmed.delete(key);
		}
	}
}

export function hasUnconfirmedAnswer(id: string, owner?: string): boolean {
	if (unconfirmed.has(keyOf(id, owner))) return true;
	if (!owner) {
		for (const key of unconfirmed.keys()) {
			if (key === id || key.endsWith(`\u0000${id}`)) return true;
		}
	}
	return false;
}

export function resendUnconfirmedAnswers(): void {
	const pending = Array.from(unconfirmed.values());
	for (const msg of pending) {
		if (!appSend(msg)) return;
	}
}

export function resetUnconfirmedAnswers(): void {
	unconfirmed.clear();
}

export function unconfirmedAnswerCount(): number {
	return unconfirmed.size;
}
