import { CoreEngineNotReadyError } from "../packages/keel/src/contracts/core-engine-errors.js";
import type {
	GoalPrefs,
	GoalRunPort,
	GoalStartOptions,
	GoalWizardOptions,
} from "../packages/keel/src/contracts/goals.js";
import { DEFAULT_GOAL_PREFS, goalStatusOfPrefs } from "../packages/keel/src/domains/goals/index.js";
import type { GoalRunSinks } from "../packages/keel/src/domains/goals/index.js";
import { resolveServerLang, type ServerLang } from "../packages/keel/src/i18n.js";
import { parseModelSpec } from "./attachments.js";
import {
	GOAL_EXEC_FAILED_ROUNDS_LIMIT,
	extractErrorSnippetFromSession,
	goalGitDiff,
	goalIsGitRepo,
	parseReviewerVerdict,
	parseWizardOutput,
	recordGoalHistory,
	sampleGoalRound,
	stripGoalDraftPrefix,
} from "./goal-run-rounds.js";
import {
	createGoalRun,
	expectedPhaseOf,
	goalRunStatusOf,
	type GoalChild,
	type GoalFinish,
	type GoalRole,
	type GoalRun,
	type TurnOutcome,
} from "./goal-run-state.js";
import {
	applyGoalMaterialBlobs,
	createGoalMaterialReporter,
	goalMaterialOverflowText,
	planGoalRoundMaterials,
} from "./goal-run-materials.js";
import {
	goalExecutorPrompt,
	goalFailureText,
	goalReviewerFeedback,
	goalReviewerPrompt,
	goalRoleTitle,
	goalScopePrompt,
	goalVerdictRetryPrompt,
} from "./goal-run-prompts.js";

/**
 * 目标运行的宿主实现（内核 `GoalRunPort`）：执行对话 + 审查对话 + 逐轮评估 + 调研问卷。
 *
 * 三层都在这里落地，没有中间态：
 * 1. **建会话**：执行 / 审查 / 调研各开一条**不激活**的子对话（与主对话并存），cwd 跟主对话；
 *    每轮材料按「目标 cwd → 执行侧 cwd」归一 / stage（`goal-run-materials.ts`）。
 * 2. **逐轮**：唯一驱动是内核的 `onTurnSettled`（`TurnRunner` 的收尾钩子）：执行轮收尾 → 采样 →
 *    派审查轮 → 解析 verdict → pass 收尾 / fail 续跑。**没有自建定时器循环**。
 * 3. **停 / 清**：`clearGoal` 停当前运行 → 中断在飞回合 → 拆掉全部子对话（关会话 + 退役 + 出注册表）
 *    → 发空目标帧；之后迟到的收尾按「代次 + 子对话 id」丢弃。
 *
 * 判定口径 / prompt / 材料流程 / 状态形状全部复用老实现抽出来的叶子（`goal-run-*.ts`）与
 * `domains/goals` 的 `goalStatusOfPrefs`，这里只编排，不另写一套。
 */

/** 目标偏好与目标模式开关的唯一读者（宿主 `ClientStateStore`，即 `client-state.json`）。 */
export interface GoalRunPrefsStore {
	getGoalPrefs(clientId: string): GoalPrefs | null | undefined;
	saveGoalPrefs(clientId: string, prefs: GoalPrefs): void;
	getSettingsSnapshot?(clientId: string): { goalModeEnabled?: boolean };
}

export interface CoreGoalRunDeps {
	sinks: GoalRunSinks;
	stateStore: GoalRunPrefsStore;
	/** 一轮的指纹读数；缺省用共享叶子（`diff HEAD` + `status --porcelain`）。 */
	gitDiff?(cwd: string): Promise<string>;
	isGitRepo?(cwd: string): Promise<boolean>;
}

/**
 * 建一个绑定到某客户端的 `GoalRunPort`：一次连接一份（子对话与运行态都在这里，断开即丢）。
 * 端口只在目标能力第一次被调用时创建（见 `domains/goals/handlers.ts` 的 `enableRun`）。
 */
export function createCoreGoalRunPort(deps: CoreGoalRunDeps): GoalRunPort {
	const { sinks } = deps;
	const runs = new Map<string, GoalRun>();
	const children = new Map<string, GoalChild>();
	const reportMaterials = createGoalMaterialReporter((msg) => sinks.emit(msg));
	const lang = (): ServerLang => resolveServerLang(sinks.getLang());
	const prefs = (): GoalPrefs => ({ ...DEFAULT_GOAL_PREFS, ...deps.stateStore.getGoalPrefs(sinks.clientId) });
	const goalModeOn = (): boolean => deps.stateStore.getSettingsSnapshot?.(sinks.clientId).goalModeEnabled !== false;
	const notice = (level: "info" | "warning", text: string, textEn: string): void => {
		if (sinks.isDisposed()) return;
		sinks.emit({ type: "notice", level, text, textEn });
	};

	/** 这条运行还活着吗：连接没断、没被停、注册表里还是它（不是被替换掉的旧一代）。 */
	const alive = (run: GoalRun): boolean => !sinks.isDisposed() && !run.stopped && runs.get(run.parentId) === run;

	/** 目标帧：在跑就发运行态，没在跑就只发偏好（老实现 `emitGoalStatus()` / `makeGoalStatus()` 两条）。 */
	const publish = (run?: GoalRun): void => {
		if (sinks.isDisposed()) return;
		sinks.emit({ type: "goal_status", status: run ? goalRunStatusOf(run) : goalStatusOfPrefs(prefs()) });
		sinks.flushSnapshot();
	};

	const conversationCwd = (conversationId: string): string => sinks.conversationCwd(conversationId) ?? sinks.cwd();

	/** 开一条子对话并登记角色（**不激活**：与主对话并存）。 */
	const openChild = (run: GoalRun, role: GoalRole, title: string): string => {
		const child = sinks.openChild({ parentId: run.parentId, title, cwd: run.cwd });
		children.set(child.id, { parentId: run.parentId, role, generation: run.generation });
		return child.id;
	};

	const childOf = (run: GoalRun, role: GoalRole): string | undefined =>
		role === "exec" ? run.execId : role === "review" ? run.reviewId : run.wizardId;

	const closeChild = (run: GoalRun, role: GoalRole): void => {
		const id = childOf(run, role);
		if (!id) return;
		children.delete(id);
		if (role === "exec") run.execId = undefined;
		else if (role === "review") run.reviewId = undefined;
		else run.wizardId = undefined;
		sinks.closeChild(id);
	};

	const closeAll = (run: GoalRun): void => {
		for (const role of ["exec", "review", "wizard"] as const) closeChild(run, role);
	};

	/** 停一条运行：代次 +1 → 中断在飞回合 → 拆子对话。之后它的任何收尾都会被 `alive()` 丢掉。 */
	const stopRun = async (run: GoalRun): Promise<void> => {
		run.stopped = true;
		run.generation += 1;
		run.phase = "idle";
		const inflight = [run.execId, run.reviewId, run.wizardId].filter((id): id is string => !!id);
		for (const id of inflight) await sinks.abortTurn(id).catch(() => {});
		closeAll(run);
	};

	/** 目标偏好里的 `provider/id`：解析不到就明说「继续用对话默认模型」，不假装按它跑。 */
	const applyModel = async (run: GoalRun, conversationId: string, spec: string | null | undefined): Promise<void> => {
		const parsed = parseModelSpec(spec);
		if (!parsed) return;
		const ok = await sinks.setModel(conversationId, parsed.provider, parsed.id).catch(() => false);
		if (ok || !alive(run)) return;
		notice(
			"warning",
			`目标指定的模型不可用（${parsed.spec}），本轮继续用对话默认模型。`,
			`The model configured for this goal (${parsed.spec}) is unavailable; this round runs with the conversation default.`,
		);
	};

	/** 一轮的材料清单：目标 cwd → 执行侧 cwd（不同才 stage），执行者与审查者共用同一份。 */
	const materialsOf = async (run: GoalRun, targetCwd: string): Promise<string> => {
		const plan = await planGoalRoundMaterials({ refs: run.materials, goalCwd: run.cwd, execCwd: targetCwd });
		reportMaterials(run.parentId, plan.notice);
		return plan.block;
	};

	/** 派一轮：只发起不等收尾（收尾由 `onTurnSettled` 驱动，失败回落成一次「失败的收尾」）。 */
	const dispatch = (run: GoalRun, role: GoalRole, conversationId: string, text: string): void => {
		const generation = run.generation;
		void sinks
			.runTurn(conversationId, text)
			.catch(() => {
				if (runs.get(run.parentId) === run && run.generation === generation) settleTurn(conversationId, role, "failed");
			})
			.catch(() => {});
	};

	const startExecRound = async (run: GoalRun): Promise<void> => {
		if (!alive(run)) return;
		const round = run.round + 1;
		if (round > run.budget) return finish(run, "exhausted", run.feedback);
		run.round = round;
		run.phase = "executing";
		run.verdict = "pending";
		const rounds = Number.isFinite(run.budget) ? `第 ${round}/${run.budget} 轮` : `第 ${round} 轮（不限）`;
		const roundsEn = Number.isFinite(run.budget) ? `round ${round}/${run.budget}` : `round ${round} (unlimited)`;
		run.status = `执行中（${rounds}）…`;
		run.statusEn = `Executing (${roundsEn})…`;
		publish(run);
		const execId = run.execId ?? (run.execId = openChild(run, "exec", goalRoleTitle(lang(), run.goal)));
		const materialsBlock = await materialsOf(run, conversationCwd(execId));
		if (!alive(run)) return;
		if (!sinks.hasChild(execId)) return finish(run, "blocked", goalFailureText(lang(), "exec-gone"));
		dispatch(
			run,
			"exec",
			execId,
			goalExecutorPrompt(lang(), {
				goalText: run.goal,
				round,
				budget: run.budget,
				feedback: run.feedback,
				materialsBlock,
			}),
		);
	};

	/** 派审查轮：`retry` = 上一轮没给出约定的 JSON（只回 JSON 的收紧 prompt）。 */
	const startReviewRound = async (
		run: GoalRun,
		execOutput: string,
		materialsBlock: string,
		retry: boolean,
	): Promise<void> => {
		if (!alive(run)) return;
		run.phase = "reviewing";
		run.reviewAttempts += 1;
		run.status = `审查中（第 ${run.round} 轮）…`;
		run.statusEn = `Reviewing (round ${run.round})…`;
		publish(run);
		const reviewId =
			run.reviewId ?? (run.reviewId = openChild(run, "review", `${goalRoleTitle(lang(), run.goal)}（审查）`));
		if (!sinks.hasChild(reviewId)) return finish(run, "blocked", goalFailureText(lang(), "review-gone"));
		const text = retry
			? goalVerdictRetryPrompt(lang())
			: goalReviewerPrompt(lang(), {
					goalText: run.goal,
					round: run.round,
					budget: run.budget,
					execOutput,
					materialsBlock,
				});
		dispatch(run, "review", reviewId, text);
	};

	/** 执行轮收尾：采样（指纹 / 错误片段 / 停滞）→ 派审查，或按失败口径续跑 / 收尾。 */
	const afterExec = async (run: GoalRun, outcome: TurnOutcome): Promise<void> => {
		const execId = run.execId;
		const output = execId ? sinks.lastAssistantText(execId) : "";
		const diff = deps.gitDiff ?? goalGitDiff;
		const repoOf = deps.isGitRepo ?? goalIsGitRepo;
		let diffFingerprint = "";
		try {
			diffFingerprint = await diff(run.cwd);
		} catch {
			diffFingerprint = "";
		}
		let repoAvailable = true;
		try {
			repoAvailable = await repoOf(run.cwd);
		} catch {
			repoAvailable = true;
		}
		const errorSnippet = extractErrorSnippetFromSession(undefined, output);
		sampleGoalRound(run.counters, { errorSnippet, diffFingerprint, repoAvailable });
		if (!alive(run)) return;
		if (outcome !== "done") {
			run.counters.failedRounds = (run.counters.failedRounds ?? 0) + 1;
			const repeat = run.counters.failedRounds >= GOAL_EXEC_FAILED_ROUNDS_LIMIT;
			const kind = outcome === "aborted" ? "canceled" : repeat ? "error-repeat" : "error";
			run.feedback = goalFailureText(lang(), kind, errorSnippet ?? "");
			if (repeat || outcome === "aborted") return finish(run, "blocked", run.feedback);
			return startExecRound(run);
		}
		run.counters.failedRounds = 0;
		if ((run.counters.sameErrorRounds ?? 0) >= 2 || (run.counters.stagnantRounds ?? 0) >= 2) {
			return finish(run, "blocked", "");
		}
		const materialsBlock = await materialsOf(run, execId ? conversationCwd(execId) : run.cwd);
		if (!alive(run)) return;
		await startReviewRound(run, output, materialsBlock, false);
	};

	/** 审查轮收尾：verdict 解析（一次重试）→ pass 收尾 / fail 续跑 / 轮尽收尾。 */
	const afterReview = async (run: GoalRun, outcome: TurnOutcome): Promise<void> => {
		if (outcome !== "done") {
			return finish(run, "blocked", goalFailureText(lang(), outcome === "aborted" ? "canceled" : "review-gone"));
		}
		const verdict = parseReviewerVerdict(run.reviewId ? sinks.lastAssistantText(run.reviewId) : "");
		if (!verdict) {
			if (run.reviewAttempts < 2) return startReviewRound(run, "", "", true);
			return finish(run, "blocked", goalFailureText(lang(), "review-invalid"));
		}
		run.reviewAttempts = 0;
		run.feedback = goalReviewerFeedback(lang(), verdict.verdict, verdict.feedback, run.feedback);
		if (verdict.verdict === "pass") return finish(run, "pass", run.feedback);
		if (run.round >= run.budget) return finish(run, "exhausted", run.feedback);
		await startExecRound(run);
	};

	/** 调研轮收尾：解析 `GOAL:` / `STEPS:` → 提交目标（步骤进计划面板）→ 开跑。 */
	const afterWizard = async (run: GoalRun, outcome: TurnOutcome): Promise<void> => {
		const text = run.wizardId ? sinks.lastAssistantText(run.wizardId) : "";
		const parsed = parseWizardOutput(text);
		if (outcome !== "done" || !parsed.goal.trim()) {
			notice(
				"warning",
				`调研未产出有效目标，请重试（原始目标草案已保留：${run.draft ?? ""}）`,
				`The survey produced no usable goal — retry (the initial draft is kept: ${run.draft ?? ""})`,
			);
			closeChild(run, "wizard");
			run.phase = "idle";
			runs.delete(run.parentId);
			publish();
			return;
		}
		if (parsed.steps.length > 0) {
			if (sinks.setPlan) sinks.setPlan(run.parentId, parsed.steps);
			else {
				// 缺口不静默：计划写口没接就说清楚（步骤不会凭空出现在面板里）。
				notice(
					"warning",
					"调研产出的计划步骤未写入计划面板（本引擎未接计划写口），只用于后续提示词。",
					"The plan steps from the survey were not written to the plan board (this engine has no plan writer); they are only used in prompts.",
				);
			}
		}
		const committed = {
			goal: parsed.goal.trim(),
			materials: run.materials,
			reviewModel: run.reviewModel,
			execModel: run.execModel,
			maxRounds: run.maxRounds,
			locked: run.locked,
		};
		closeChild(run, "wizard");
		run.phase = "idle";
		runs.delete(run.parentId);
		await commitGoal(run.parentId, committed.goal, {
			reviewModel: committed.reviewModel ?? undefined,
			maxRounds: committed.maxRounds,
			locked: committed.locked,
			execModel: committed.execModel ?? undefined,
			materials: committed.materials,
		});
		notice(
			"info",
			`🎯 调研完成，目标已设为：${committed.goal.slice(0, 80)}${committed.goal.length > 80 ? "…" : ""}`,
			`🎯 Survey done, goal set: ${committed.goal.slice(0, 80)}${committed.goal.length > 80 ? "…" : ""}`,
		);
	};

	/** 收尾：写历史、拆子对话、发帧（pass 清目标字段；受阻 / 轮尽保留目标文本待重设）。 */
	const finish = (run: GoalRun, kind: GoalFinish, feedback: string): void => {
		if (!alive(run)) return;
		run.history = recordGoalHistory(run.history, {
			goal: run.goal.slice(0, 200),
			verdict: kind === "pass" ? "pass" : kind === "exhausted" ? "fail" : "blocked",
			rounds: run.round,
			feedback: feedback.trim().replace(/\s+/g, " ").slice(0, 200),
		});
		run.feedback = feedback;
		run.reviewAttempts = 0;
		closeAll(run);
		if (kind === "pass") {
			run.phase = "pass";
			run.verdict = "pass";
			run.status = "✅ 已通过目标审查";
			run.statusEn = "✅ Goal review passed";
			runs.delete(run.parentId);
			publish(run);
			notice("info", "✅ 目标已通过审查", "✅ Goal passed review");
			return;
		}
		run.phase = "blocked";
		if (kind === "exhausted") {
			run.verdict = "fail";
			run.status = `已达最大轮数（${run.maxRounds}），目标仍未通过`;
			run.statusEn = `Max rounds reached (${run.maxRounds}), goal still failing`;
			notice("warning", "目标未通过审查（已达最大轮数）", "Goal failed review (max rounds reached)");
		} else {
			run.verdict = "blocked";
			run.status = "⚠️ 目标受阻（委托执行已暂停）";
			run.statusEn = "⚠️ Goal blocked (delegated execution paused)";
			notice(
				"warning",
				"⚠️ 目标执行受阻：委托执行已暂停（可在目标条重新设定目标继续）",
				"⚠️ Goal blocked: delegated execution paused (set the goal again to continue)",
			);
		}
		publish(run);
	};

	/**
	 * 收尾通知的唯一入口（内核 `onTurnSettled` → `port.onTurnSettled` → 这里）。
	 * 先同步「认领」阶段再进入异步处理：同一轮重复收敛（收尾 + 派发失败回落）不会跑两遍。
	 */
	function settleTurn(conversationId: string, role: GoalRole, outcome: TurnOutcome): void {
		const owner = children.get(conversationId);
		if (!owner || owner.role !== role) return;
		const run = runs.get(owner.parentId);
		if (!run || !alive(run) || run.generation !== owner.generation || run.phase !== expectedPhaseOf(role)) return;
		run.phase = role === "exec" ? "reviewing" : role === "review" ? "executing" : "idle";
		const work =
			role === "exec"
				? afterExec(run, outcome)
				: role === "review"
					? afterReview(run, outcome)
					: afterWizard(run, outcome);
		// 回路内部异常不许静默卡在中间态：按受阻收尾并把原因写进 feedback / notice。
		void work.catch((error: unknown) => {
			const reason = error instanceof Error ? error.message : String(error);
			finish(run, "blocked", `目标回路内部错误：${reason}`);
		});
	}

	/** 设目标（`setGoal` 与调研收尾共用）：停旧运行 → 落偏好 → 建子对话 → 开跑。 */
	async function commitGoal(
		parentId: string,
		goalText: string,
		opts?: GoalStartOptions,
		autoStart = true,
	): Promise<void> {
		const previous = runs.get(parentId);
		if (previous) await stopRun(previous);
		const base = prefs();
		const merged: GoalPrefs = {
			reviewModel: opts?.reviewModel === undefined ? base.reviewModel : opts.reviewModel || null,
			maxRounds: typeof opts?.maxRounds === "number" ? opts.maxRounds : base.maxRounds,
			locked: opts?.locked === undefined ? base.locked : opts.locked,
			execModel: opts?.execModel === undefined ? (base.execModel ?? null) : opts.execModel || null,
		};
		deps.stateStore.saveGoalPrefs(sinks.clientId, merged);
		const blobs = await applyGoalMaterialBlobs(opts?.materials, opts?.materialBlobs);
		if (blobs.dropped.length > 0) {
			const overflow = goalMaterialOverflowText(blobs.dropped);
			notice("warning", overflow.text, overflow.textEn);
		}
		const run = createGoalRun({
			parentId,
			cwd: conversationCwd(parentId),
			goal: goalText,
			generation: (previous?.generation ?? 0) + 1,
			phase: "idle",
			prefs: merged,
			materials: blobs.refs,
			history: previous?.history,
			status: "目标已设，等待生成…",
			statusEn: "Goal set, waiting to generate…",
		});
		runs.set(parentId, run);
		const execId = openChild(run, "exec", goalRoleTitle(lang(), goalText));
		const reviewId = openChild(run, "review", `${goalRoleTitle(lang(), goalText)}（审查）`);
		run.execId = execId;
		run.reviewId = reviewId;
		publish(run);
		notice(
			"info",
			`🎯 已设目标：${goalText.slice(0, 80)}${goalText.length > 80 ? "…" : ""}`,
			`🎯 Goal set: ${goalText.slice(0, 80)}${goalText.length > 80 ? "…" : ""}`,
		);
		if (merged.execModel) await applyModel(run, execId, merged.execModel);
		if (merged.reviewModel) await applyModel(run, reviewId, merged.reviewModel);
		if (!autoStart || !alive(run)) return;
		await startExecRound(run);
	}

	/** 调研：开子对话 → 问卷 prompt（标准 `ask_user_question` 工具）→ 收尾即提交目标。 */
	async function startWizard(parentId: string, draft: string, opts?: GoalWizardOptions): Promise<void> {
		const previous = runs.get(parentId);
		if (previous) await stopRun(previous);
		const base = prefs();
		const blobs = await applyGoalMaterialBlobs(opts?.materials, opts?.materialBlobs);
		const run = createGoalRun({
			parentId,
			cwd: conversationCwd(parentId),
			goal: draft,
			generation: (previous?.generation ?? 0) + 1,
			phase: "wizard",
			prefs: {
				reviewModel: opts?.wizardModel ?? base.reviewModel,
				maxRounds: typeof opts?.maxRounds === "number" ? opts.maxRounds : base.maxRounds,
				locked: opts?.locked === undefined ? true : opts.locked,
				execModel: base.execModel ?? null,
			},
			materials: blobs.refs,
			draft,
			history: previous?.history,
			status: "目标调研中…",
			statusEn: "Scoping the goal…",
		});
		runs.set(parentId, run);
		const wizardId = (run.wizardId = openChild(run, "wizard", "[目标调研]"));
		publish(run);
		if (run.reviewModel) await applyModel(run, wizardId, run.reviewModel);
		if (!alive(run)) return;
		dispatch(run, "wizard", wizardId, goalScopePrompt({ draft, askTool: "ask_user_question" }));
	}

	const activeParent = (what: string): string => {
		const id = sinks.activeConversationId();
		if (!id) throw new CoreEngineNotReadyError(`${what}.conversation`);
		return id;
	};

	const port: GoalRunPort = {
		setGoal(goal: string, opts?: GoalStartOptions): Promise<void> {
			if (sinks.isDisposed()) return Promise.resolve();
			const text = (goal ?? "").trim();
			// 空目标 = 清目标（老实现第一条分支）：没有活动对话时什么都不用做。
			if (!text) {
				const parentId = sinks.activeConversationId();
				return parentId ? port.clearGoal(parentId) : Promise.resolve();
			}
			if (!goalModeOn()) {
				// 老口径：目标模式关着就明说拒绝设目标（不当成「设了但不跑」）。
				notice(
					"warning",
					"目标模式已关闭：请先在设置「目标审查」中启用目标模式。",
					"Goal mode is off: enable it under Settings → Goal review first.",
				);
				return Promise.resolve();
			}
			return commitGoal(activeParent("goals.setGoal"), text, opts);
		},

		clearGoal(conversationId?: string): Promise<void> {
			const parentId = conversationId ?? sinks.activeConversationId();
			if (!parentId) return Promise.resolve();
			const run = runs.get(parentId);
			if (!run) {
				publish();
				return Promise.resolve();
			}
			runs.delete(parentId);
			return stopRun(run).then(() => publish());
		},

		startGoalWizard(text: string, opts?: GoalWizardOptions): Promise<void> {
			if (sinks.isDisposed()) return Promise.resolve();
			if (!goalModeOn()) {
				notice(
					"warning",
					"目标模式已关闭：请先在设置「目标审查」中启用目标模式。",
					"Goal mode is off: enable it under Settings → Goal review first.",
				);
				return Promise.resolve();
			}
			const draft = stripGoalDraftPrefix(text);
			if (!draft) return Promise.resolve();
			const parentId = activeParent("goals.startGoalWizard");
			const running = runs.get(parentId);
			const busy =
				running && (running.phase === "wizard" || running.phase === "executing" || running.phase === "reviewing");
			if (running && busy) {
				const surveying = running.phase === "wizard";
				notice(
					"warning",
					surveying ? "已有目标调研进行中，请等它完成…" : "已有目标在跑，请先停止再发起调研…",
					surveying
						? "A goal survey is already running — wait for it to finish…"
						: "A goal is already running — stop it before starting a survey…",
				);
				return Promise.resolve();
			}
			return startWizard(parentId, draft, opts);
		},

		onTurnSettled(conversationId: string, outcome: TurnOutcome): void {
			const owner = children.get(conversationId);
			if (owner) settleTurn(conversationId, owner.role, outcome);
		},
	};
	return port;
}
