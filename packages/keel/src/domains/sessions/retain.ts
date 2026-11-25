import { DEFAULT_CONV_TITLE } from "../../agent-formatters.js";
import type { Conversation, ConversationRegistry } from "../../kernel/conversation/index.js";

/**
 * 换活动对话时「刚被换下来的旧对话该不该继续留在运行列表里」的全部事实。
 *
 * 判据是**搬迁**不是重写：`server/agent-service.ts` 的 `displaceActive` / `isRetainedOnDisplace`
 * 与 `server/wait-subscription-scan.ts` 的 `shouldRetainActive` 逐条对应到下面的字段。
 * 每一支都只会「多留一会儿」，所以**缺失的事实一律按 false / 0 处理**（老口径：
 * `hasRunningBackgroundTask ?? false`）——未知不能让本该保留的对话被拆掉，也不能凭空保留一条空对话。
 */
export interface DisplaceRetainFacts {
	/** 子代理对话（老 `conv.isSubagent`）：一直是保留的（子行挂在父行下面）。 */
	isSubagent?: boolean;
	/** 原生 CLI 对话（老 `conv.nativeCli`）：一直是保留的。 */
	nativeCli?: boolean;
	/** 它还有活着的子对话（老 `hasLiveSubagentChild`）：父对话拆了子行就成孤儿。 */
	hasLiveChildConversation?: boolean;
	/** 临时对话或设置项「保留已结束的对话」（老 `retainFinished` 的左半边）。 */
	keepsFinished?: boolean;
	/** 会话真的开始过（老 `isConversationStarted`，`retainFinished` 的右半边）。 */
	started?: boolean;
	/** 用户钉住了它（老 `conv.pinned`）。 */
	pinned?: boolean;
	/** 目标评审正在跑（老 `conv.goal.reviewing`）。 */
	reviewing?: boolean;
	/** 问卷向导正在跑（老 `conv.wizardRunning`）。 */
	wizardRunning?: boolean;
	/** 有消息已受理、还没交给会话（老 `conv.promptInFlight`）。 */
	promptInFlight?: boolean;
	/** 这一轮正在生成（老 `conv.session.isStreaming`）。 */
	streaming?: boolean;
	/** 正在压缩（老 `conv.session.isCompacting || !!conv.compaction`）。 */
	compacting?: boolean;
	/** 还开着会阻塞的终端（老 `conv.terminals.countBlockingLive()`）。 */
	openTerminals?: number;
	/** 已列入运行列表（老 `conv.listed`）。 */
	listed?: boolean;
	/** 本次激活期间被喂过消息（老 `conv.promptedSinceActive`）。 */
	promptedSinceActive?: boolean;
	/** 还有活着的子代理运行（宿主扫描；内核没有这份账）。 */
	hasActiveSubagentRun?: boolean;
	/** 还有等着唤醒的订阅（宿主扫描；内核没有这份账）。 */
	hasPendingWake?: boolean;
	/** 还有在跑的后台任务（宿主扫描；内核没有这份账）。 */
	hasRunningBackgroundTask?: boolean;
}

/**
 * 换活动对话前的保留判定（老 `displaceActive` → `isRetainedOnDisplace` → `shouldRetainActive`）。
 *
 * 为真 = **不退役**旧对话：它继续留在注册表里、会话不释放、运行列表继续占一行。
 * 为假 = 按重绑原语义退役（退役 → 摘出注册表 → 释放会话）。
 */
export function shouldRetainOnDisplace(facts: DisplaceRetainFacts): boolean {
	// 老 `displaceActive` 的硬分支：子代理 / 原生 CLI 对话本来就不换掉。
	if (facts.isSubagent === true || facts.nativeCli === true) return true;
	// 老 `isRetainedOnDisplace`：有活着的子对话不能拆父对话。
	if (facts.hasLiveChildConversation === true) return true;
	// 老 `retainFinished`：「保留已结束的对话」/ 临时对话，且会话真的开始过。
	if (facts.keepsFinished === true && facts.started === true) return true;
	// 以下逐条对应老 `shouldRetainActive`，顺序与老实现一致（读起来能一行一行对回去）。
	if (facts.pinned === true) return true;
	if (facts.reviewing === true || facts.wizardRunning === true) return true;
	if (facts.promptInFlight === true) return true;
	if (facts.streaming === true || facts.compacting === true) return true;
	if ((facts.openTerminals ?? 0) > 0) return true;
	if (facts.hasActiveSubagentRun === true) return true;
	if (facts.hasPendingWake === true) return true;
	if (facts.hasRunningBackgroundTask === true) return true;
	// 老口径：用户明确打开过、并且在其中说过话的对话，切走也留着。
	if (facts.listed === true && facts.promptedSinceActive === true) return true;
	return false;
}

/**
 * 内核看不到的那几项从哪来。全部**只提供证据、不否决内核已认的事实**（返回 `undefined` = 不知道），
 * 因为老判据里每一支都是「多留一会儿」：装配层少给一项的后果只能是「少保留」，
 * 绝不能是「内核认得的证据被 false 覆盖掉」。
 */
export interface RetainEnv {
	/** 宿主认得的那份 CLI 账（`nativeCliOf`）：内核只认得 `kind: "cli"`。 */
	nativeCli?(conversation: Conversation): boolean | undefined;
	/** 「会话真的开始过」的额外证据（已列入运行列表 / 转录里有消息 / fork 出来的）。 */
	started?(conversation: Conversation): boolean | undefined;
	/** 设置项 `retainFinishedConversations`（临时对话由内核自己认）。 */
	keepsFinished?(): boolean | undefined;
	/** 运行列表内存态（老 `conv.pinned`）。 */
	pinned?(conversation: Conversation): boolean | undefined;
	/** 运行列表内存态（老 `conv.listed`）。 */
	listed?(conversation: Conversation): boolean | undefined;
	/** 本次激活期间被喂过消息（老 `conv.promptedSinceActive`）：内核没有这个状态位。 */
	promptedSinceActive?(conversation: Conversation): boolean | undefined;
	/** 目标评审（老 `conv.goal.reviewing`）：目标运行在宿主。 */
	reviewing?(conversation: Conversation): boolean | undefined;
	/** 问卷向导（老 `conv.wizardRunning`）：问卷在宿主。 */
	wizardRunning?(conversation: Conversation): boolean | undefined;
	/** 投递意图在飞（老 `conv.promptInFlight`）：入站投递门在宿主。 */
	promptInFlight?(conversation: Conversation): boolean | undefined;
	/** 压缩进行中（老 `conv.session.isCompacting || conv.compaction`）：压缩在宿主。 */
	compacting?(conversation: Conversation): boolean | undefined;
	/** 阻塞中的终端数（老 `terminals.countBlockingLive()`）：终端是叶子域。 */
	openTerminals?(conversation: Conversation): number | undefined;
	/** 活着的子代理运行（宿主扫描 `hasActiveSubagentRun`）。 */
	hasActiveSubagentRun?(conversation: Conversation): boolean | undefined;
	/** 等唤醒的订阅（宿主扫描 `hasPendingWaitSubscription`）。 */
	hasPendingWake?(conversation: Conversation): boolean | undefined;
	/** 在跑的后台任务（宿主扫描 `hasRunningBackgroundTask`）。 */
	hasRunningBackgroundTask?(conversation: Conversation): boolean | undefined;
	/** 会话正在生成（老 `conv.session.isStreaming`）：缺省用内核相位 `running` 回答。 */
	streaming?(conversation: Conversation): boolean | undefined;
}

/**
 * 一个对话 → 判据事实。内核自己算得出的（子代理 / CLI / 活着的子对话 / 相位）不向宿主问；
 * 其余只有宿主知道，缺项就是「不知道」（判据按 false 处理，注释见 `shouldRetainOnDisplace`）。
 */
export function retainFactsOf(
	registry: ConversationRegistry<Conversation>,
	conversation: Conversation,
	env: RetainEnv = {},
): DisplaceRetainFacts {
	const liveChild = registry
		.list()
		.some((other) => other.meta.parentId === conversation.id && other.phase !== "retired");
	return {
		isSubagent: conversation.meta.kind === "subagent",
		nativeCli: conversation.meta.kind === "cli" || env.nativeCli?.(conversation) === true,
		hasLiveChildConversation: liveChild,
		keepsFinished: conversation.ephemeral || env.keepsFinished?.() === true,
		started: conversation.meta.title !== DEFAULT_CONV_TITLE || env.started?.(conversation) === true,
		pinned: env.pinned?.(conversation) === true,
		listed: env.listed?.(conversation) === true,
		promptedSinceActive: env.promptedSinceActive?.(conversation) === true,
		reviewing: env.reviewing?.(conversation) === true,
		wizardRunning: env.wizardRunning?.(conversation) === true,
		promptInFlight: env.promptInFlight?.(conversation) === true,
		// 相位是内核自己的事实：`running` 就是这一轮正在跑（老 `conv.session.isStreaming` 的内核对照）。
		streaming: conversation.phase === "running" || env.streaming?.(conversation) === true,
		compacting: env.compacting?.(conversation) === true,
		openTerminals: env.openTerminals?.(conversation) ?? 0,
		hasActiveSubagentRun: env.hasActiveSubagentRun?.(conversation) === true,
		hasPendingWake: env.hasPendingWake?.(conversation) === true,
		hasRunningBackgroundTask: env.hasRunningBackgroundTask?.(conversation) === true,
	};
}

/**
 * 装配口：`rebindSession` / `createWorkspaceSwitcher` / 切会话共用同一个判定实例
 * （判据单源在这里，别在装配层另写一套 `if`）。
 */
export function createRetainOnDisplace(
	registry: ConversationRegistry<Conversation>,
	env: RetainEnv = {},
): (conversation: Conversation) => boolean {
	return (conversation) => shouldRetainOnDisplace(retainFactsOf(registry, conversation, env));
}
