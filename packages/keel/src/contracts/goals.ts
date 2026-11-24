import type { ClientMessage } from "../protocol.js";
import type { PlanStep } from "../protocol.js";
import type { ClientState } from "../projects-schema.js";

/**
 * 目标审查偏好：`client-state.json` 的 `goalPrefs` 逐字段同形（`SettingsStorePort.getGoalPrefs`）。
 * `null` = 用当前默认模型；`maxRounds: 0` = 不设轮数上限。唯一写者是宿主 `ClientStateStore`。
 */
export type GoalPrefs = NonNullable<ClientState["goalPrefs"]>;

/** 协议即契约：`set_goal` / `start_goal_wizard` / `set_goal_prefs` 的可选参数直接取协议形状，不另抄一份。 */
type Wire<T extends ClientMessage["type"]> = Omit<Extract<ClientMessage, { type: T }>, "type">;

export type GoalStartOptions = Omit<Wire<"set_goal">, "goal">;
export type GoalWizardOptions = Omit<Wire<"start_goal_wizard">, "text">;
export type GoalPrefsPatch = Wire<"set_goal_prefs">;

/**
 * 目标运行：执行对话 / 审查对话的派发、材料 staging、逐轮评估与续跑。
 *
 * 全在宿主（老树 `server/goal-service.ts`）：它要开子代理会话、调审查模型、按轮比对 diff，
 * 这些能力的持有者只有宿主。内核只做「偏好落盘 + 帧」，运行面按这个窄面注入；
 * 未注入 = 本引擎不支持目标运行（handler 同步抛 `CoreEngineNotReadyError`），
 * 绝不降级成「设了目标但不跑」——那比直接报错更坏。
 */
export interface GoalRunPort {
	setGoal(goal: string, opts?: GoalStartOptions): Promise<void>;
	clearGoal(conversationId?: string): Promise<void>;
	startGoalWizard(text: string, opts?: GoalWizardOptions): Promise<void>;
	/**
	 * 每轮收尾通知（可选）：内核在 `TurnRunner.onTurnSettled` 里转发，宿主的逐轮评估/续跑就挂在这里
	 * （禁自建 setTimeout 轮询）。不实现 = 内核不驱动它，宿主自己负责收尾。
	 */
	onTurnSettled?(conversationId: string, outcome: "done" | "failed" | "aborted"): void;
}

/**
 * 目标运行的反向口（可选）：宿主跑出来的副作用要落回内核的域时用，今天只有一个。
 *
 * - `setPlan`：调研问卷推出的计划步骤要进 `plans.json` 并发 `plan_updated`。计划存储的装配归
 *   app 层（`app/goal-handlers.ts` 的 `PlanStore`），宿主拿不到，也不许自己再建一份，
 *   所以由域把写口回传给端口工厂。不接 = 该项不生效（面板不自动填），不静默造假。
 */
export interface GoalRunHooks {
	setPlan?(conversationId: string, steps: PlanStep[]): void;
}

/**
 * 目标运行端口的工厂：域在第一次用目标运行能力时才建（未注入 = 本引擎不支持，handler 同步抛）。
 * `hooks` 是内核反向回传的写口（见 `GoalRunHooks`），宿主可以不理也不用。
 */
export type GoalRunPortFactory = (hooks?: GoalRunHooks) => GoalRunPort | undefined;

/**
 * 计划模式 / 审查者模式的开关：真值有三处——会话转录里的模式条目（重启后恢复）、
 * 内置写工具的门禁（`withPlanModeGate` / `withDelegationGate`）、提示词重载。
 * 三处都要 SDK 会话句柄，所以按窄面归宿主；未注入 = 本引擎还不支持这两个模式。
 */
export interface ChatModePort {
	setPlanMode(enabled: boolean, conversationId?: string): Promise<void>;
	setDelegateMode(enabled: boolean, conversationId?: string): Promise<void>;
	/**
	 * 会话（重新）打开后，把转录里的模式条目读回运行态——重启 / 换转录之后仍然生效。
	 * 缺省 = 不恢复（快照会显示关闭，写工具不拦）。
	 */
	restore?(conversationId?: string): void;
}
