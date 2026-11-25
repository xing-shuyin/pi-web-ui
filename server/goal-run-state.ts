import type { GoalPrefs } from "../packages/keel/src/contracts/goals.js";
import { goalRoundBudget, type GoalRoundCounters } from "./goal-run-rounds.js";
import type { GoalHistoryEntry, GoalStatus } from "./protocol.js";

/**
 * 宿主目标运行态的**唯一形状**：一条运行是什么、子对话是什么角色、状态怎么投影成 `goal_status`。
 *
 * 门面（`core-goal-run-adapter.ts`）只编排阶段流转；这里不碰会话、不发帧，
 * 只保证「运行态 → 协议形状」只有一套映射（老实现里这些字段是散在 `GoalConversation` 上的）。
 */

export type GoalRole = "exec" | "review" | "wizard";
export type GoalPhase = "idle" | "executing" | "reviewing" | "wizard" | "blocked" | "pass";
/** 收尾口径：`blocked` = 受阻（可重设目标继续），`exhausted` = 轮数用尽，`pass` = 通过。 */
export type GoalFinish = "pass" | "blocked" | "exhausted";
export type TurnOutcome = "done" | "failed" | "aborted";

/** 子对话登记：只认「哪条运行、什么角色、哪一代」，迟到的收尾靠它丢弃。 */
export interface GoalChild {
	parentId: string;
	role: GoalRole;
	generation: number;
}

export interface GoalRun {
	parentId: string;
	cwd: string;
	goal: string;
	/** 代次：停 / 重设目标都 +1，迟到的收尾按它丢弃。 */
	generation: number;
	phase: GoalPhase;
	round: number;
	budget: number;
	reviewModel: string | null;
	execModel: string | null;
	locked: boolean;
	maxRounds: number;
	materials?: string[];
	draft?: string;
	execId?: string;
	reviewId?: string;
	wizardId?: string;
	feedback: string;
	reviewAttempts: number;
	counters: GoalRoundCounters;
	history: GoalHistoryEntry[];
	status: string;
	statusEn: string;
	verdict: GoalStatus["verdict"];
	stopped: boolean;
}

/** 调研问卷的步数口径（与 `goalStatusOfPrefs()` 的 idle 形状一致，UI 只画进度点）。 */
export const WIZARD_MAX_STEPS = 6;

/** 角色与阶段的对应关系：只有阶段对得上才算「这一轮真的收尾了」。 */
export function expectedPhaseOf(role: GoalRole): GoalPhase {
	return role === "exec" ? "executing" : role === "review" ? "reviewing" : "wizard";
}

/** 新运行（设目标 / 调研共用）：偏好、预算与代次在一处定死，避免两处各算一份。 */
export function createGoalRun(input: {
	parentId: string;
	cwd: string;
	goal: string;
	generation: number;
	phase: GoalPhase;
	prefs: GoalPrefs;
	materials?: string[];
	draft?: string;
	history?: GoalHistoryEntry[];
	status: string;
	statusEn: string;
}): GoalRun {
	return {
		parentId: input.parentId,
		cwd: input.cwd,
		goal: input.goal,
		generation: input.generation,
		phase: input.phase,
		round: 0,
		budget: input.phase === "wizard" ? 0 : goalRoundBudget(input.prefs),
		reviewModel: input.prefs.reviewModel,
		execModel: input.prefs.execModel ?? null,
		locked: input.prefs.locked,
		maxRounds: input.prefs.maxRounds,
		materials: input.materials,
		draft: input.draft,
		feedback: "",
		reviewAttempts: 0,
		counters: {},
		history: input.history ?? [],
		status: input.status,
		statusEn: input.statusEn,
		verdict: "pending",
		stopped: false,
	};
}

/** 运行态 → `goal_status`（`pass` 时目标字段按老口径清空；`wizard` 段只填问卷面板）。 */
export function goalRunStatusOf(run: GoalRun): GoalStatus {
	return {
		conversationId: run.phase === "pass" ? null : run.parentId,
		goal: run.phase === "pass" ? null : run.goal,
		reviewModel: run.reviewModel,
		maxRounds: run.maxRounds,
		locked: run.locked,
		reviewing: run.phase === "reviewing",
		round: run.round,
		status: run.status,
		statusEn: run.statusEn,
		verdict: run.verdict,
		...(run.feedback ? { feedback: run.feedback } : {}),
		wizard: {
			active: run.phase === "wizard",
			draft: run.draft ?? "",
			model: null,
			step: 0,
			maxSteps: WIZARD_MAX_STEPS,
			status: run.phase === "wizard" ? run.status : "",
			...(run.phase === "wizard" ? { statusEn: run.statusEn } : {}),
		},
		phase: run.phase === "pass" || run.phase === "wizard" ? "idle" : run.phase,
		execModel: run.execModel,
		// 执行对话的存在与在飞状态：左栏「目标条」靠它给出入口与活动描述（老实现 `g.roles.executor` 同形）。
		// 子对话拆了就整个不给：指向已拆对话的 convId 比没有更坏。
		...(run.execId
			? { roles: { executor: { convId: run.execId, spawned: true, streaming: run.phase === "executing" } } }
			: {}),
		...(run.counters.goalUsage
			? { usage: { inputTokens: run.counters.goalUsage.input, outputTokens: run.counters.goalUsage.output } }
			: {}),
		...(run.history.length > 0 ? { history: [...run.history] } : {}),
	};
}
