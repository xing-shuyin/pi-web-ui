import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { ClientId } from "../../contracts/ids.js";
import type {
	ChatModePort,
	GoalPrefs,
	GoalPrefsPatch,
	GoalRunPort,
	GoalRunPortFactory,
	GoalStartOptions,
	GoalWizardOptions,
} from "../../contracts/goals.js";
import type { SettingsStorePort } from "../../contracts/settings-store.js";
import type { GoalStatus, PlanState, PlanStep, ServerMessage } from "../../protocol.js";
import type { PlanStore } from "./plan-store.js";

/** 缺省偏好（老实现 `GoalService.prefs` 初值）：`locked` 缺省就是锁住，`maxRounds: 0` = 不限。 */
export const DEFAULT_GOAL_PREFS: GoalPrefs = { reviewModel: null, maxRounds: 0, locked: true, execModel: null };

/** 轮数上限口径（老实现同款）：`>=1` 取整并封顶 50，其余一律当「不限」。 */
export function clampGoalRounds(value: number): number {
	const rounded = Math.round(value);
	return rounded >= 1 ? Math.min(rounded, 50) : 0;
}

/** 协议补丁 → 落盘偏好：`undefined` = 不改，空串 = 回到「用默认模型」。 */
export function mergeGoalPrefs(current: GoalPrefs, patch: GoalPrefsPatch): GoalPrefs {
	return {
		reviewModel: patch.reviewModel === undefined ? current.reviewModel : patch.reviewModel || null,
		maxRounds: typeof patch.maxRounds === "number" ? clampGoalRounds(patch.maxRounds) : current.maxRounds,
		locked: patch.locked === undefined ? current.locked : patch.locked,
		execModel: patch.execModel === undefined ? (current.execModel ?? null) : patch.execModel || null,
	};
}

/** 只有偏好、没有目标在跑时的 `goal_status`（老实现 `makeGoalStatus()` 逐字同形）。 */
export function goalStatusOfPrefs(prefs: GoalPrefs): GoalStatus {
	return {
		conversationId: null,
		goal: null,
		reviewModel: prefs.reviewModel,
		maxRounds: prefs.maxRounds,
		locked: prefs.locked,
		execModel: prefs.execModel ?? null,
		phase: "idle",
		reviewing: false,
		round: 0,
		status: "",
		verdict: "pending",
		wizard: { active: false, draft: "", model: null, step: 0, maxSteps: 6, status: "" },
	};
}

export interface GoalHandlersOptions {
	/** 计划状态的真值（`plans.json` 投影）；缺省 = 计划能力未接。 */
	plans?: () => PlanStore | undefined;
	/** 目标偏好的真值（`client-state.json`）；缺省 = 偏好未接。 */
	prefs?: () => SettingsStorePort | undefined;
	clientId: ClientId;
	/** 当前对话：`plan_update` / `plan_step_*` 不带 `conversationId` 时用它。 */
	activeConversationId(): string | undefined;
	/** 会话 id（`plans.json` 的键）；拿不到就只存内存。 */
	sessionIdOf?(conversationId: string): string | undefined;
	emit(msg: ServerMessage): void;
	flushSnapshot(): void;
	/** 计划交接：开新对话并把交接提示词喂进去（只走内核唯一喂轮出口）。 */
	openConversation?(): string | undefined;
	feed?(promptText: string): Promise<void>;
	/** 目标运行端口工厂；缺省 = 本引擎不支持目标运行。 */
	goalRun?: GoalRunPortFactory;
	chatMode?: () => ChatModePort | undefined;
}

/** 目标 / 计划 / 委派的 11 个 handler：签名与 `DispatchSession` 的同名成员一致。 */
export interface GoalHandlers {
	setGoal(goal: string, opts?: GoalStartOptions): Promise<void>;
	clearGoal(conversationId?: string): Promise<void>;
	startGoalWizard(text: string, opts?: GoalWizardOptions): Promise<void>;
	setGoalPrefs(opts?: GoalPrefsPatch): Promise<void>;
	updatePlan(steps: PlanStep[], activeStepId?: string | null, conversationId?: string): void;
	updatePlanStep(stepId: string, patch: Partial<PlanStep>, conversationId?: string): void;
	deletePlanStep(stepId: string, conversationId?: string): void;
	addPlanStep(step: PlanStep, afterStepId?: string, conversationId?: string): void;
	planCleanHandoff(steps: PlanStep[], promptText: string): Promise<void>;
	setPlanMode(enabled: boolean, conversationId?: string): Promise<void>;
	setDelegateMode(enabled: boolean, conversationId?: string): Promise<void>;
}

/**
 * 谁持久化 / 谁喂轮 / 发哪几帧，逐条写在这里，别再靠猜：
 *
 * - **计划**：落盘 `plans.json`（`PlanStore`，键是会话 id；对话 id 只是进程内别名）→
 *   发 `plan_updated` → 刷一次快照。真值本来在会话转录的 `plan/update` 事件里，
 *   那条路要 SDK 会话句柄（`adapters/sdk` 另一轨），本批只保证「帧 + 缓存」这条链闭合。
 * - **目标偏好**：落盘 `client-state.json`（`SettingsStorePort.saveGoalPrefs`，唯一写者
 *   `ClientStateStore`）→ 发 `goal_status` → 刷快照。目标模式开关关着就照老口径拒绝写入。
 * - **计划交接**：开新对话 → 计划落到新对话 → 喂交接提示词（`feed`，唯一喂轮出口）。
 * - **目标运行 / 模式开关**：宿主能力（要开执行/审查对话、要写会话转录的模式条目），
 *   端口未注入就同步抛——不降级成「设了目标但不跑」。
 */
export function createGoalHandlers(options: GoalHandlersOptions): GoalHandlers {
	const planStore = (): PlanStore => {
		const store = options.plans?.();
		if (!store) throw new CoreEngineNotReadyError("plans");
		return store;
	};
	const prefsStore = (): SettingsStorePort => {
		const store = options.prefs?.();
		if (!store) throw new CoreEngineNotReadyError("goalPrefs");
		return store;
	};
	/** 端口只建一次（宿主可能持有轮次状态）；hooks 是内核反向回传的写口（今天只有计划面板）。 */
	let runPort: GoalRunPort | undefined;
	const enableRun = (what: string): GoalRunPort => {
		const factory = options.goalRun;
		if (!factory) throw new CoreEngineNotReadyError(what);
		runPort ??= factory({
			// 调研产出的步骤落到与 `plan_update` 同一条链（`plans.json` + 帧 + 快照）。
			setPlan: (conversationId, steps) => {
				const plans = options.plans?.();
				if (!plans) return;
				publishPlan(
					conversationId,
					plans.setPlan(conversationId, steps, undefined, options.sessionIdOf?.(conversationId)),
				);
			},
		});
		if (!runPort) throw new CoreEngineNotReadyError(what);
		return runPort;
	};
	const enableMode = (what: string): ChatModePort => {
		const port = options.chatMode?.();
		if (!port) throw new CoreEngineNotReadyError(what);
		return port;
	};
	const conversationOf = (conversationId?: string): string => {
		const id = conversationId ?? options.activeConversationId();
		if (!id) throw new CoreEngineNotReadyError("goals.conversation");
		return id;
	};
	/** 计划变了就发帧再刷快照：面板与快照两条都要跟上，缺一条就是「本地看着改了、刷新又回去」。 */
	const publishPlan = (conversationId: string, plan: PlanState | null): void => {
		options.emit({ type: "plan_updated", conversationId, plan });
		options.flushSnapshot();
	};
	/**
	 * 步骤级写的公共段：锁定对话 → 拿到会话 id → 写 → 发帧。
	 * 步骤已不存在（并发删/换了对话）时回落到当前计划：绝不把「空计划」发出去把面板清空。
	 */
	const stepWrite = (
		conversationId: string | undefined,
		write: (store: PlanStore, id: string, sessionId?: string) => PlanState | null,
	): void => {
		const id = conversationOf(conversationId);
		const plans = planStore();
		const sessionId = options.sessionIdOf?.(id);
		publishPlan(id, write(plans, id, sessionId) ?? plans.getPlan(id, sessionId));
	};
	const applyPrefs = (patch: GoalPrefsPatch): void => {
		const store = prefsStore();
		const settings = store.getSettingsSnapshot(options.clientId);
		if (settings.goalModeEnabled === false) {
			options.emit({
				type: "notice",
				level: "warning",
				text: "目标模式已关闭：请先在设置「目标审查」中启用目标模式。",
				textEn: "Goal mode is off: enable it under Settings → Goal review first.",
			});
			options.flushSnapshot();
			return;
		}
		const current = store.getGoalPrefs(options.clientId) ?? DEFAULT_GOAL_PREFS;
		const next = mergeGoalPrefs({ ...DEFAULT_GOAL_PREFS, ...current }, patch);
		store.saveGoalPrefs(options.clientId, next);
		options.emit({ type: "goal_status", status: goalStatusOfPrefs(next) });
		options.flushSnapshot();
	};

	return {
		// 目标运行归宿主：端口不在就同步抛（`async` 会变成 rejected promise，调用方看不到「未接」）。
		setGoal: (goal: string, opts?: GoalStartOptions) => enableRun("goals.setGoal").setGoal(goal, opts),
		clearGoal: (conversationId?: string) => enableRun("goals.clearGoal").clearGoal(conversationId),
		startGoalWizard: (text: string, opts?: GoalWizardOptions) =>
			enableRun("goals.startGoalWizard").startGoalWizard(text, opts),

		// 偏好是内核自己就能存的（`client-state.json`）：这条链闭合，失败也会同步抛回调用方。
		setGoalPrefs(opts?: GoalPrefsPatch) {
			applyPrefs(opts ?? {});
			return Promise.resolve();
		},

		updatePlan(steps: PlanStep[], activeStepId?: string | null, conversationId?: string) {
			const id = conversationOf(conversationId);
			publishPlan(id, planStore().setPlan(id, steps, activeStepId, options.sessionIdOf?.(id)));
		},
		updatePlanStep(stepId: string, patch: Partial<PlanStep>, conversationId?: string) {
			stepWrite(conversationId, (plans, id, sessionId) => plans.updateStep(id, stepId, patch, sessionId));
		},
		deletePlanStep(stepId: string, conversationId?: string) {
			stepWrite(conversationId, (plans, id, sessionId) => plans.deleteStep(id, stepId, sessionId));
		},
		addPlanStep(step: PlanStep, afterStepId?: string, conversationId?: string) {
			stepWrite(conversationId, (plans, id, sessionId) => plans.addStep(id, step, afterStepId, sessionId));
		},

		/**
		 * 交接 = 新对话接盘：先落计划再喂提示词（顺序反了会让第一轮看不到计划）。
		 * 端口解析在第同步段做（未接就同步抛），喂轮那条 promise 原样上抛。
		 */
		planCleanHandoff(steps: PlanStep[], promptText: string) {
			const plans = planStore();
			const open = options.openConversation;
			const feed = options.feed;
			if (!open) throw new CoreEngineNotReadyError("planCleanHandoff.openConversation");
			if (!feed) throw new CoreEngineNotReadyError("planCleanHandoff.feed");
			const targetId = open();
			if (!targetId) throw new CoreEngineNotReadyError("planCleanHandoff.openConversation");
			const plan = plans.setPlan(targetId, steps, undefined, options.sessionIdOf?.(targetId));
			publishPlan(targetId, plan);
			return feed(promptText);
		},

		setPlanMode: (enabled: boolean, conversationId?: string) =>
			enableMode("planMode.set").setPlanMode(enabled, conversationId),
		setDelegateMode: (enabled: boolean, conversationId?: string) =>
			enableMode("delegateMode.set").setDelegateMode(enabled, conversationId),
	};
}
