/**
 * subagent-helpers — 子代理运行状态判定、结局计算与快照序列化辅助工具。
 *
 * 负责：
 * - subagentRunOutcome: 根据 assistant 消息的 errorMessage / stopReason 计算运行结局
 * - roleOutcomeOf: 映射为角色轮终态（error / canceled / done）
 * - isSubagentActive / countActiveSubagents: 判定与统计占用并发名额的活跃（非终态）子代理
 * - toSubagentSnapshot: 转换单个对话为轻量子代理快照（SubagentSnapshot）
 * - listSubagentSnapshots: 过滤和排序子代理快照列表
 *
 * 从 agent-service.ts 抽出为独立模块。
 */
import type { SubagentSnapshot, SubagentState } from "./subagents.js";
import type { RoleWaitOutcome } from "./goal-service.js";
import type { Conversation } from "./agent-service.js";
import { SUBAGENT_PROMPT_SNAPSHOT_CAP } from "./agent-formatters.js";

/** 子代理是否处于活跃（流式运行中或首轮投递启动中）状态。
 *  #589：名额与可见性解耦——仅活跃（非终态）子代理占用 MAX_SUBAGENTS 并发名额；
 *  已结束（done / canceled / error）的子代理保留在左栏供用户审阅追溯，不再占名额。 */
export function isSubagentActive(conv: Conversation): boolean {
	if (!conv.isSubagent) return false;
	if (conv.promptInFlight) return true;
	try {
		return Boolean(conv.session.isStreaming);
	} catch {
		return false;
	}
}

/** 统计当前占用并发名额的活跃子代理数（含正在创建 runtime 的在途 spawn，不含已终态子代理，#589）。 */
export function countActiveSubagents(convs: Iterable<Conversation>, spawningCount = 0): number {
	let count = Math.max(0, Math.floor(spawningCount));
	for (const c of convs) {
		if (isSubagentActive(c)) count++;
	}
	return count;
}

/** 子代理最近一次运行的结局：最后一条 assistant 消息的 errorMessage / stopReason。
 *  报错 > 中止 > 正常，三者互斥；无 assistant 消息时返回空。 */
export function subagentRunOutcome(conv: Conversation): { error?: string; canceled?: boolean } {
	// 自动重试等待期结局未定：瞬时 error 不算失败，避免向主对话误报
	// 「子代理运行失败」（耗尽后 auto_retry_end 清旗，真正失败照常通知）。
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
	} catch {
		// session being replaced — treat as no outcome yet
	}
	return {};
}

/** 对话结局 → 角色轮结局（报错 > 中止 > 正常）。 */
export function roleOutcomeOf(conv: Conversation): RoleWaitOutcome {
	const { error, canceled } = subagentRunOutcome(conv);
	if (error) return "error";
	if (canceled) return "canceled";
	return "done";
}

/** 序列化对话为前端可消费的子代理快照 */
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
	} catch {
		// session being replaced — report defaults
	}
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
		type: conv.subagentType ?? "general",
		title: conv.title,
		prompt:
			fullPrompt.length > SUBAGENT_PROMPT_SNAPSHOT_CAP
				? `${fullPrompt.slice(0, SUBAGENT_PROMPT_SNAPSHOT_CAP)}\n… [truncated]`
				: fullPrompt,
		state,
		streaming,
		error,
		canceled,
		messageCount,
		model: modelKey,
		thinkingLevel,
		output: conv.session.getLastAssistantText() ?? "",
		parentId: conv.parentId,
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

/** 列举并排序子代理快照集合 */
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
