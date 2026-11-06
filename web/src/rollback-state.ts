import { useSyncExternalStore } from "react";
import { appSend } from "./app-globals";

interface RollbackRequest {
	messageId: string;
	conversationId?: string;
}

let currentRequest: RollbackRequest | null = null;
const listeners = new Set<() => void>();

function emitChange(): void {
	for (const l of listeners) l();
}

export function openRollbackDialog(req: RollbackRequest): void {
	currentRequest = req;
	emitChange();
}

export function closeRollbackDialog(): void {
	currentRequest = null;
	emitChange();
}

export function confirmRollback(restoreWorkspace: boolean): void {
	if (!currentRequest) return;
	appSend({
		type: "rollback_session",
		messageId: currentRequest.messageId,
		conversationId: currentRequest.conversationId,
		restoreWorkspace,
	});
	currentRequest = null;
	emitChange();
}

export function useRollbackState(): RollbackRequest | null {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => currentRequest,
	);
}
