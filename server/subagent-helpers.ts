import type { SubagentSnapshot, SubagentState } from "./subagents.js";
import type { RoleWaitOutcome } from "./goal-service.js";
import type { Conversation } from "./agent-service.js";
import { SUBAGENT_PROMPT_SNAPSHOT_CAP } from "./agent-formatters.js";
import { conversationIdentity, parentConversationIdentity, conversationParent } from "./conversation-identity.js";
import { classifyModelError, type ModelErrorInfo } from "./model-error.js";

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

/**
 * 子代理的账本状态（issues #981 / #964）：一个 run 到底算不算结束，只由这里回答。
 *
 * 旧代码在 `turn_end` 处一律写 `running`，于是一本账永远停在 running；`completion_requested` 也写 running，
 * 把「已经交卷」改回「还在跑」。这里把判据固定成：取消 > 失败 > 真在跑 > done。
 * 「真在跑」= 有提示词在飞 / 还在流式 / 还有未收尾的任务（含待投递的完成请求）。
 */
export function subagentLedgerStateOf(
	conv: Conversation,
	opts: { taskPending?: boolean } = {},
): "running" | LedgerState {
	const { error, canceled } = subagentRunOutcome(conv);
	if (canceled) return "canceled";
	if (error) return "failed";
	const pending = opts.taskPending ?? conv.subagentTaskPending?.() ?? false;
	if (pending || conv.promptInFlight) return "running";
	try {
		if (conv.session.isStreaming) return "running";
	} catch {
		// 会话不可读（退役窗口）：当作未结束，宁可写 running 也不谎报 done。
		return "running";
	}
	return "done";
}

type LedgerState = "done" | "blocked" | "failed" | "canceled" | "interrupted" | "dismissed";

/** 完成通知的三态（issues #981 / #964）。 */
export type SubagentNoticeVerdict = "deliver" | "defer" | "invalidate";

/**
 * 完成通知到底该不该发：旧实现只有「该 / 不该」两态，于是「这一轮刚要结束、又开了一轮」的
 * 短暂窗口被当成「永远不该发」，通知静默消失。
 *
 * - `invalidate`：这一批真作废了（run 换代 / 已被父取走 / 已通知）→ 丢弃并告知用户；
 * - `defer`：现在不能发、但之后仍该发（还在流式 / 提示词在飞 / 还有未收尾的完成请求）
 *   → 留在原队列，靠既有排空点重试；
 * - `deliver`：发。
 */
export function subagentNoticeVerdict(
	conv: Conversation,
	generation: number,
	taskPending: boolean,
): SubagentNoticeVerdict {
	if ((conv.subagentRunGeneration ?? 0) !== generation) return "invalidate";
	if (conv.subagentConsumedByParent || conv.subagentDoneNotified) return "invalidate";
	if (taskPending || conv.promptInFlight) return "defer";
	try {
		if (conv.session.isStreaming) return "defer";
	} catch {
		// 会话不可读（退役窗口）：不是作废，等下一轮再说。
		return "defer";
	}
	return "deliver";
}

/** 子代理结论：`error` 是原文（会话文件、左栏悬停提示、账本都保留原文）。 */
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

/**
 * 子代理失败的分类投影（issue #978）：通知与 verdict 只消费这份，不各自拼文案。
 * 判据只有 `server/model-error.ts` 一处；`error` 本身仍是原文，线协议形状不变。
 */
export function subagentErrorInfo(conv: Conversation): ModelErrorInfo | undefined {
	const { error } = subagentRunOutcome(conv);
	return error ? classifyModelError(error) : undefined;
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
	let usage: SubagentSnapshot["usage"];
	try {
		const tokens = conv.session.getSessionStats()?.tokens;
		if (tokens && Number.isFinite(tokens.input) && Number.isFinite(tokens.output)) {
			usage = { input: tokens.input, output: tokens.output, total: tokens.input + tokens.output };
		}
	} catch {
		usage = undefined;
	}
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
		evidence: conv.subagentEvidence,
		usage,
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
