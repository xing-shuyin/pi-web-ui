import type { ClientMessage, NativeCliConfig, ServerMessage } from "./types";

const pending = new Map<string, (id: string | null) => void>();
let sequence = 0;

export function resolveNewChatResult(message: Extract<ServerMessage, { type: "new_chat_result" }>): void {
	pending.get(message.requestId)?.(message.ok && message.conversationId ? message.conversationId : null);
}

function requestChat(
	send: (message: ClientMessage) => boolean,
	message: (requestId: string) => ClientMessage,
	timeoutMs: number,
): Promise<string | null> {
	const requestId = `host-new-chat-${Date.now()}-${++sequence}`;
	return new Promise((resolve) => {
		const finish = (id: string | null) => {
			clearTimeout(timer);
			pending.delete(requestId);
			resolve(id);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		pending.set(requestId, finish);
		try {
			if (!send(message(requestId))) finish(null);
		} catch {
			finish(null);
		}
	});
}

export function requestNewChat(send: (message: ClientMessage) => boolean, timeoutMs = 8000): Promise<string | null> {
	return requestChat(send, (requestId) => ({ type: "new_chat", requestId }), timeoutMs);
}

export function requestNativeCliChat(
	send: (message: ClientMessage) => boolean,
	config: NativeCliConfig,
	cwd?: string,
	timeoutMs = cwd?.trim().startsWith("ssh://") ? 120_000 : 30_000,
): Promise<string | null> {
	return requestChat(send, (requestId) => ({ type: "new_cli_chat", config, cwd, requestId }), timeoutMs);
}
