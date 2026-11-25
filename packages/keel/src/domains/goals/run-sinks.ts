import type { ConversationId } from "../../contracts/ids.js";
import type { TurnCapableSession } from "../../contracts/session.js";
import type { PlanStep, ServerMessage } from "../../protocol.js";
import { Conversation } from "../../kernel/conversation/index.js";

/**
 * 目标运行（`GoalRunPort`）与内核之间的窄面：宿主跑目标回路时只准用这几件事。
 *
 * 为什么这些类型/组装落在域里而不是 `app/core-engine.ts`：那里是 600 行硬门禁的装配层，
 * 而这里只是「注册表 + 轮次 + 会话」的窄投影，与 `GoalRunPort` 相邻更近；装配处只交对象。
 */

/** 会话持有者的窄面（app 层 `SessionRegistry` 结构上满足）：开会话 / 取会话 / 关会话。 */
export interface GoalRunSessionHost {
	ensure(conversation: Conversation): Promise<{ session: TurnCapableSession } | undefined>;
	get(conversationId: string): { session: TurnCapableSession } | undefined;
	close(conversationId: string): void;
}

/** 轮次执行的窄面（`TurnRunner` 结构上满足）：喂一轮；收尾由端口自己的 `onTurnSettled` 接。 */
export interface GoalRunTurnHost {
	start(conversation: Conversation, session: TurnCapableSession, text: string): Promise<unknown>;
}

/**
 * 内核运行时的窄面（`app/ClientRuntime` 结构上满足它）：装配处只交对象，域不反向依赖 app。
 * 出帧走 `publisher.request()`（目标帧与快照刷新同一个闸门）。
 */
export interface GoalRunRuntimeHost {
	readonly clientId: string;
	readonly registry: GoalRunConversationHost;
	readonly turns: GoalRunTurnHost;
	readonly publisher: { request(): void };
	readonly cwd: string;
	activeConversationId(): string | undefined;
	/**
	 * 推一帧 `conversations`（运行列表出口）：开 / 拆目标子对话后左栏要立刻看到，
	 * 不靠「刚好有一轮在跑 / 刚好收尾」碰运气出帧。缺省 = 不出帧（宿主自己负责）。
	 */
	pushConversations?(): void;
}

/** 对话登记的最小面：**只加不激活**（子对话必须与主对话并存），拆的时候连会话一起收。 */
export interface GoalRunConversationHost {
	add(conversation: Conversation): unknown;
	get(conversationId: string): Conversation | undefined;
	remove(conversationId: string): unknown;
	nextSeq(): number;
	activeId(): ConversationId | "";
}

export interface GoalRunSinks {
	clientId: string;
	/** 一帧发给本客户端（`goal_status` / `notice`）。 */
	emit(msg: ServerMessage): void;
	flushSnapshot(): void;
	/** 连接已关：迟到的一轮不许再改动任何状态。 */
	isDisposed(): boolean;
	getLang(): string;
	/** 目标归属的对话（设目标 / 调研的锚点）。 */
	activeConversationId(): string | undefined;
	/** 目标 cwd（材料 staging 的基准、执行对话默认落点）。 */
	cwd(): string;
	/** 开一条**不激活**的子对话（执行 / 审查 / 调研）。 */
	openChild(input: { parentId: string; title: string; cwd: string }): { id: string; cwd: string };
	/** 拆子对话：关会话 + 退役 + 出注册表（清目标时不留子会话）。 */
	closeChild(conversationId: string): void;
	/** 子对话是否还能接活（被用户移出 / 已退役 = 目标受阻，不往死对话派活）。 */
	hasChild(conversationId: string): boolean;
	/** 对话当前 cwd（换过工作区就跟着变；材料跨 cwd 时按它 stage）。 */
	conversationCwd(conversationId: string): string | undefined;
	/** 喂一轮（唯一喂轮出口在运行时内部）；resolve = 这一轮收尾。 */
	runTurn(conversationId: string, text: string): Promise<void>;
	/** 中断在飞的一轮（停目标）。 */
	abortTurn(conversationId: string): Promise<void>;
	/** 最后一段助手文本（审查判定的输入）。 */
	lastAssistantText(conversationId: string): string;
	/** 给子会话换模型；解析不到 = false（宿主据此报「模型不可用」，不静默降级）。 */
	setModel(conversationId: string, provider: string, modelId: string): Promise<boolean>;
	/** 调研产出的计划写口（域回传，落 `plans.json` + 发 `plan_updated`）；缺省 = 不写面板。 */
	setPlan?(conversationId: string, steps: PlanStep[]): void;
}

export interface GoalRunSinksInput {
	runtime: GoalRunRuntimeHost;
	sessions: GoalRunSessionHost;
	/** 模型目录解析（内核的 `resolveModel`）：目标偏好里的 `provider/id` 由宿主解析后写入。 */
	resolveModel(provider: string, modelId: string): Promise<unknown>;
	emit(msg: ServerMessage): void;
	isDisposed(): boolean;
	getLang(): string;
	setPlan?(conversationId: string, steps: PlanStep[]): void;
}

/**
 * 把内核的几件现成东西装成 `GoalRunSinks`：这里只做投影，不做策略
 * （轮次怎么排、什么时候停全在宿主适配器里）。
 */
export function createGoalRunSinks(input: GoalRunSinksInput): GoalRunSinks {
	const { clientId, registry, turns, publisher } = input.runtime;
	const { sessions } = input;
	const sinks: GoalRunSinks = {
		clientId,
		emit: input.emit,
		flushSnapshot: () => publisher.request(),
		isDisposed: input.isDisposed,
		getLang: input.getLang,
		activeConversationId: () => input.runtime.activeConversationId(),
		cwd: () => input.runtime.cwd,
		openChild: (child) => {
			// 只注册不激活：目标执行者 / 审查者 / 调研组与主对话并存，不抢当前对话。
			// kind 是 `user` 而不是 `subagent`：老实现给执行体开的是**落盘对话**（`persist: true`，
			// 左栏无「子代理」微标、可按普通对话切进去），轻量子代理那套（限额 / 连带关闭 / 微标）不适用于目标。
			const conversation = new Conversation({
				id: `g-${registry.nextSeq()}`,
				clientId,
				kind: "user",
				createdAt: Date.now(),
				title: child.title,
				parentId: child.parentId,
				cwd: child.cwd,
			});
			registry.add(conversation);
			input.runtime.pushConversations?.();
			return { id: conversation.id, cwd: conversation.meta.cwd };
		},
		closeChild: (conversationId) => {
			sessions.close(conversationId);
			const conversation = registry.get(conversationId);
			if (!conversation) return;
			if (conversation.acceptsTurns) conversation.retire();
			conversation.finishRetire();
			registry.remove(conversationId);
			// 出注册表不等于左栏退行：不推这一帧，客户端会一直挂着已经拆掉的执行对话。
			input.runtime.pushConversations?.();
		},
		hasChild: (conversationId) => registry.get(conversationId)?.acceptsTurns ?? false,
		conversationCwd: (conversationId) => registry.get(conversationId)?.meta.cwd,
		runTurn: async (conversationId, text) => {
			const conversation = registry.get(conversationId);
			if (!conversation) throw new Error(`goal conversation ${conversationId} is gone`);
			const opened = await sessions.ensure(conversation);
			if (!opened) throw new Error(`goal conversation ${conversationId} has no session`);
			await turns.start(conversation, opened.session, text);
		},
		abortTurn: async (conversationId) => {
			await sessions.get(conversationId)?.session.abort?.();
		},
		lastAssistantText: (conversationId) => sessions.get(conversationId)?.session.getLastAssistantText?.() ?? "",
		setModel: async (conversationId, provider, modelId) => {
			// 先解析模型（解析不到 = 明确失败），再开（或复用）会话把它写进去：目标子对话的会话是懒开的。
			const model = await input.resolveModel(provider, modelId);
			if (!model) return false;
			const conversation = registry.get(conversationId);
			if (!conversation) return false;
			const opened = await sessions.ensure(conversation);
			if (!opened?.session.setModel) return false;
			await opened.session.setModel(model);
			return true;
		},
	};
	if (input.setPlan) sinks.setPlan = input.setPlan;
	return sinks;
}
