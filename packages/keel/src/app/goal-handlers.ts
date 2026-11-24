import { join } from "node:path";
import type { ClientId } from "../contracts/ids.js";
import type { ChatModePort, GoalRunPort } from "../contracts/goals.js";
import type { TransportPort } from "../contracts/ports.js";
import type { SettingsStorePort } from "../contracts/settings-store.js";
import type { Conversation, ConversationRegistry } from "../kernel/conversation/index.js";
import { PlanStore, createGoalHandlers, type GoalHandlers } from "../domains/goals/index.js";
import type { SessionRegistry } from "./session-registry.js";

/** 装配只用得到运行时选项里的这四件（其余与目标/计划无关）：帧出口、会话、设置存储、客户端身份。 */
export interface GoalRuntimeOptions {
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
	/** 目标运行 / 模式开关：宿主能力，装配处注入前一律按「未接」处理。 */
	goalRun?: () => GoalRunPort | undefined;
	chatMode?: () => ChatModePort | undefined;
}

export type { GoalHandlers };

/**
 * 目标 / 计划 / 委派的装配：把运行时的三个现成来源（设置存储 → `plans.json` 与 `goalPrefs`、
 * 会话注册表 → 会话 id、对话注册表 → 当前对话）接到域上。这里是唯一知道「计划缓存放哪」的地方。
 */
export function createGoalHandlersFor(bindings: GoalHandlerBindings): GoalHandlers {
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
		...(bindings.goalRun ? { goalRun: bindings.goalRun } : {}),
		...(bindings.chatMode ? { chatMode: bindings.chatMode } : {}),
	});
}
