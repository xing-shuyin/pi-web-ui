/// <reference lib="dom" />

import { useSyncExternalStore } from "react";
import { appSend } from "./app-globals";
import type { ServerMessage, UiMessage } from "./types";

type CompactedMessagesPayload = Extract<ServerMessage, { type: "compacted_messages_result" }>;

type CompactedHistoryStatus = "idle" | "loading" | "ready" | "error";

interface CompactedHistoryState {
	status: CompactedHistoryStatus;
	messages: UiMessage[];
	error?: string;
}

const IDLE_STATE: CompactedHistoryState = Object.freeze({
	status: "idle",
	messages: [],
});

const cache = new Map<string, CompactedHistoryState>();
const listeners = new Set<() => void>();

const MAX_COMPACTED_CACHE = 16;

function pruneCache(): void {
	while (cache.size > MAX_COMPACTED_CACHE) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

function notify(): void {
	for (const l of listeners) l();
}

export function fetchCompactedHistory(compactionMessageId: string, conversationId?: string): void {
	const id = (compactionMessageId ?? "").trim();
	if (!id) return;

	const existing = cache.get(id);
	if (existing && (existing.status === "loading" || existing.status === "ready")) {
		return;
	}

	cache.set(id, {
		status: "loading",
		messages: existing?.messages ?? [],
	});
	pruneCache();
	notify();

	appSend({
		type: "get_compacted_messages",
		compactionMessageId: id,
		conversationId,
	});
}

export function receiveCompactedMessages(payload: CompactedMessagesPayload): void {
	const id = payload.compactionMessageId;
	if (!id) return;

	if (payload.error) {
		cache.set(id, {
			status: "error",
			messages: [],
			error: payload.error,
		});
	} else {
		cache.set(id, {
			status: "ready",
			messages: payload.messages ?? [],
		});
	}
	pruneCache();
	notify();
}

function getCompactedHistoryState(compactionMessageId: string): CompactedHistoryState {
	const hit = cache.get(compactionMessageId);
	if (!hit) return IDLE_STATE;
	cache.delete(compactionMessageId);
	cache.set(compactionMessageId, hit);
	return hit;
}

function subscribeCompactedHistory(cb: () => void): () => void {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

export function useCompactedHistory(compactionMessageId: string): CompactedHistoryState {
	return useSyncExternalStore(
		subscribeCompactedHistory,
		() => getCompactedHistoryState(compactionMessageId),
		() => IDLE_STATE,
	);
}
