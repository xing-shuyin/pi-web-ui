import { SUBAGENT_TOOL_NAMES } from "./tool-manager.js";

export const CONVERSATION_TOOL_NAMES = SUBAGENT_TOOL_NAMES;

export const READ_ONLY_CONVERSATION_ACTIONS = ["get_result", "list", "templates", "read", "files", "status"] as const;

export function isReadOnlyConversationAction(action: unknown): boolean {
	return (
		typeof action === "string" &&
		(READ_ONLY_CONVERSATION_ACTIONS as readonly string[]).includes(action.trim().toLowerCase())
	);
}

export function isConversationTool(name: string): boolean {
	return (CONVERSATION_TOOL_NAMES as readonly string[]).includes(name);
}

export function conversationToolAllowed(allowed: ReadonlySet<string>, name: string): boolean {
	return allowed.has(name) || (isConversationTool(name) && CONVERSATION_TOOL_NAMES.some((alias) => allowed.has(alias)));
}
