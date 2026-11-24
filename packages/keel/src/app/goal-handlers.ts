import { join } from "node:path";
import type { ClientId } from "../contracts/ids.js";
import type { ChatModePort, GoalRunPortFactory } from "../contracts/goals.js";
import type { TransportPort } from "../contracts/ports.js";
import type { SettingsStorePort } from "../contracts/settings-store.js";
import type { Conversation, ConversationRegistry } from "../kernel/conversation/index.js";
import { PlanStore, createGoalHandlers, type GoalHandlers } from "../domains/goals/index.js";
import type { SessionRegistry } from "./session-registry.js";

/**
 * 目标 / 模式开关的宿主端口：`GoalRuntimeOptions` 与 `ClientRuntimeOptions` **共用这一份**。
 * 两端共用接口而不是各自声明，是因为端口少一个成员只会静默降级（handler 抛「能力未接」），不会报错。
 */
export interface GoalHostPorts {
	/** 目标运行端口工厂（执行/审查对话 + 逐轮评估归宿主）；缺省 = 未接，三个 handler 同步抛。 */
	readonly goalRun?: GoalRunPortFactory;
	/** 模式开关的宿主面（转录条目 / 写工具门禁 / 提示词重载）；缺省 = 未接（两个 handler 同步抛）。 */
	readonly chatMode?: () => ChatModePort | undefined;
}

/** 装配只用得到运行时选项里的这几件（其余与目标/计划无关）：帧出口、会话、设置存储、客户端身份。 */
export interface GoalRuntimeOptions extends GoalHostPorts {
	readonly clientId: ClientId;
	readonly transport: TransportPort;
	readonly sessions?: SessionRegistry;
	readonly stateStore?: () => SettingsStorePort | undefined;
}

/** 本客户端要交给目标/计划域的现成东西：都是运行时已经有的，域不自己造。 */
export interface GoalHandlerBindings {
	options: GoalRuntimeOptions;
	registry: ConversationRegistry<Conversation>;
	/** 开新对话（计划交接用）：返回新对话 id。 */
	openConversation(): string;
	/** 喂一轮（app 侧包一层唯一喂轮出口）：交接提示词只能从这里进去。 */
	feed(promptText: string): Promise<void>;
	flushSnapshot(): void;
	/** 模式开关：宿主能力，装配处注入前一律按「未接」处理。 */
	chatMode?: () => ChatModePort | undefined;
}

export type { GoalHandlers };

/**
 * 目标 / 计划 / 委派的装配：把运行时的三个现成来源（设置存储 → `plans.json` 与 `goalPrefs`、
 * 会话注册表 → 会话 id、对话注册表 → 当前对话）接到域上。这里是唯一知道「计划缓存放哪」的地方。
 */
export function createGoalHandlersFor(bindings: GoalHandlerBindings): GoalHandlers {
	// 模式开关：运行时选项里的那一份是生产装配点（`ClientRuntimeOptions.chatMode`）；bindings 上的直给留给单测。
	const chatMode = bindings.chatMode ?? bindings.options.chatMode;
	const plansByDir = new Map<string, PlanStore>();
	const planStore = (): PlanStore | undefined => {
		const dataDir = bindings.options.stateStore?.()?.dataDir;
		if (!dataDir) return undefined;
		const existing = plansByDir.get(dataDir);
		if (existing) return existing;
		const created = new PlanStore({ file: join(dataDir, "plans.json") });
		plansByDir.set(dataDir, created);
		return created;
	};

	return createGoalHandlers({
		plans: planStore,
		prefs: bindings.options.stateStore,
		clientId: bindings.options.clientId,
		activeConversationId: () => bindings.registry.activeId() || undefined,
		sessionIdOf: (conversationId) => bindings.options.sessions?.get(conversationId)?.session.sessionId,
		emit: (msg) => bindings.options.transport.send(msg),
		flushSnapshot: bindings.flushSnapshot,
		openConversation: bindings.openConversation,
		feed: bindings.feed,
		...(bindings.options.goalRun ? { goalRun: bindings.options.goalRun } : {}),
		...(chatMode ? { chatMode } : {}),
	});
}
