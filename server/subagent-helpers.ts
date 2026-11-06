import type { SubagentSnapshot, SubagentState } from "./subagents.js";
import type { RoleWaitOutcome } from "./goal-service.js";
import type { Conversation } from "./agent-service.js";
import { SUBAGENT_PROMPT_SNAPSHOT_CAP } from "./agent-formatters.js";
import { conversationIdentity, parentConversationIdentity, conversationParent } from "./conversation-identity.js";

export function isSubagentActive(conv: Conversation): boolean {
	if (!conv.isSubagent) return false;
	if (conv.promptInFlight || conv.subagentTaskPending?.()) return true;
	try {
		return Boolean(conv.session.isStreaming);
	} catch {
		return false;
	}
}

export function countActiveSubagents(convs: Iterable<Conversation>, spawningCount = 0): number {
	let count = Math.max(0, Math.floor(spawningCount));
	for (const c of convs) {
		if (isSubagentActive(c)) count++;
	}
	return count;
}

export function subagentRunOutcome(conv: Conversation): { error?: string; canceled?: boolean } {
	if (conv.subagentTaskStopped) return { canceled: true };
	if (conv.retryState) return {};
	try {
		const msgs = conv.session.agent.state.messages;
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i];
			if ((m as { role?: unknown }).role !== "assistant") continue;
			const err = (m as { errorMessage?: unknown }).errorMessage;
			if (typeof err === "string" && err.trim()) {
				return { error: err.trim() };
			}
			const stop = (m as { stopReason?: unknown }).stopReason;
			if (stop === "aborted" || stop === "cancelled") {
				return { canceled: true };
			}
			break;
		}
	} catch {}
	return {};
}

export function roleOutcomeOf(conv: Conversation): RoleWaitOutcome {
	const { error, canceled } = subagentRunOutcome(conv);
	if (error) return "error";
	if (canceled) return "canceled";
	return "done";
}

export function toSubagentSnapshot(conv: Conversation): SubagentSnapshot {
	let sessionStreaming = false;
	try {
		sessionStreaming = Boolean(conv.session.isStreaming);
	} catch {
		sessionStreaming = false;
	}
	const streaming = Boolean(sessionStreaming || conv.promptInFlight);
	const { error, canceled } = subagentRunOutcome(conv);
	const state: SubagentState = streaming ? "running" : canceled ? "canceled" : "done";
	let messageCount = 0;
	try {
		messageCount = conv.session.getSessionStats().totalMessages;
	} catch {}
	let thinkingLevel: string | undefined;
	try {
		thinkingLevel = conv.session.thinkingLevel ?? conv.subagentThinking;
	} catch {
		thinkingLevel = conv.subagentThinking;
	}
	const fullPrompt = conv.subagentPrompt ?? "";
	const sm = (conv.session as unknown as { sessionManager?: { isPersisted?: () => boolean } }).sessionManager;
	const isPersisted = !conv.isSubagent || (typeof sm?.isPersisted === "function" && sm.isPersisted());
	const m = conv.session.model;
	const modelKey = m ? `${m.provider}/${m.id}` : (conv.subagentTemplate?.model ?? undefined);
	return {
		convId: conv.id,
		executionId: conversationIdentity(conv),
		parentExecutionId: parentConversationIdentity(conv),
		type: conv.subagentType ?? "general",
		title: conv.title,
		prompt:
			fullPrompt.length > SUBAGENT_PROMPT_SNAPSHOT_CAP
				? `${fullPrompt.slice(0, SUBAGENT_PROMPT_SNAPSHOT_CAP)}\n… [truncated]`
				: fullPrompt,
		state,
		streaming,
		taskPending: conv.subagentTaskPending?.() ?? false,
		error,
		canceled,
		messageCount,
		model: modelKey,
		thinkingLevel,
		output: conv.session.getLastAssistantText() ?? "",
		parentId: (conversationParent(conv) as Conversation | undefined)?.id,
		persisted: isPersisted,
		handoffTo: conv.peerHandoffTo ? [...conv.peerHandoffTo] : undefined,
		handoffFrom: conv.peerHandoffFrom ? [...conv.peerHandoffFrom] : undefined,
		worktree: conv.subagentWorktree
			? {
					path: conv.subagentWorktree.worktreePath,
					branch: conv.subagentWorktree.branch,
					cleanedUp: Boolean(conv.subagentWorktree.cleanedUp),
					isDirty: conv.subagentWorktree.isDirty,
					uncommittedCount: conv.subagentWorktree.uncommittedCount,
					aheadCount: conv.subagentWorktree.aheadCount,
					error: conv.subagentWorktree.error,
				}
			: undefined,
	};
}

export function listSubagentSnapshots(
	convs: Iterable<Conversation>,
	scope?: "all" | "subagent" | "persistent",
): SubagentSnapshot[] {
	return [...convs]
		.filter((c) => {
			const isPersisted = !c.isSubagent;
			if (scope === "subagent") return c.isSubagent;
			if (scope === "persistent") return isPersisted;
			return c.isSubagent || Boolean(c.parentId) || Boolean(c.subagentPrompt);
		})
		.sort((a, b) => a.createdAt - b.createdAt)
		.map((c) => toSubagentSnapshot(c));
}
