import type { ConversationId, SessionFile } from "../../contracts/ids.js";
import type { Conversation, ConversationKind, ConversationRegistry } from "../../kernel/conversation/index.js";

/** 会话实体（SDK 会话）的窄面：重绑只需要「按对话开一份」「按对话释放」。 */
export interface RebindSessions {
	ensure(conversation: Conversation, options?: { cwd?: string }): Promise<unknown>;
	close(conversationId: ConversationId): void;
}

/** 重绑成功后的三个帧出口：客户端手上的会话/项目/快照统统过期。 */
export interface RebindFrames {
	/** 全量刷一帧（换会话后增量没有意义：基线跟着对话走）。 */
	flush(forceFull?: boolean): void;
	pushSessions?(): void | Promise<void>;
	pushProjects?(): void | Promise<void>;
	/** 活动对话换了：`conversations` 帧（运行列表 / 当前对话）必须同步刷，别让客户端等下一条命令。 */
	pushConversations?(): void;
}

export type RebindNotice = (level: "info" | "warning" | "error", text: string, textEn: string) => void;

export interface RebindContext {
	registry: ConversationRegistry<Conversation>;
	sessions: RebindSessions;
	frames: RebindFrames;
	/** 只注册不激活（激活发生在重绑成功之后）；由 app 层提供以复用对话构造。 */
	createConversation(init: RebindConversationInit): Conversation;
	/** 活动指针换了：出帧基线与增量缓存要跟着换（app 层接 `SnapshotPublisher.switchConversation`）。 */
	onActivated?(conversationId: ConversationId): void;
	notice?: RebindNotice;
	/**
	 * 换掉旧对话之前的保留判定（老 `ClientSession.displaceActive` → `isRetainedOnDisplace`）：
	 * 为真则**不退役**旧对话——它继续留在注册表里、会话不释放、运行列表继续占一行，
	 * 只有活动指针交给新对话。判据单源在 `domains/sessions/retain.ts`（`createRetainOnDisplace`）。
	 * 缺省 = 一律退役（重绑的原语义）。
	 */
	shouldRetainPrevious?(conversation: Conversation): boolean;
	/**
	 * 被保留的旧对话要记进运行列表（老 `displaceActive` 里的 `conv.listed = true`）：
	 * 少了这一笔，它这一轮跑完就再也不会出现在运行列表里（`inRunningList` 只认 listed / 在跑 / 钉住）。
	 * 缺省 = 只保留、不列入。
	 */
	markListed?(conversationId: ConversationId): void;
	/**
	 * 消息已受理、这一轮还没真正开始（老 `conv.promptInFlight`）：运行时在 `feedTurn` 的 `ensure` 窗口里记住它。
	 * 保留的对话正处于这个窗口时，腾位会说明一声（老 `displaceActive` 的 info notice）。
	 */
	inFlight?(conversation: Conversation): boolean;
	/** 同上，另一头：老 `conv.promptedSinceActive = true`（保留判据的一半）。 */
	markPrompted?(conversationId: ConversationId): void;
}

export interface RebindConversationInit {
	cwd: string;
	sessionFile?: SessionFile;
	kind?: ConversationKind;
	parentId?: ConversationId;
	title?: string;
}

export interface RebindRequest {
	/** 目标工作目录（绝对路径；远程工作区是 URI）。 */
	cwd: string;
	/** SDK 会话实际落在哪个目录（远程工作区与会话目录分离）；缺省 = `cwd`。 */
	sessionCwd?: string;
	/** 接着写哪份转录；缺省 = 在目标 cwd 下新建会话。 */
	sessionFile?: SessionFile;
	/** 新对话的元数据；缺省 = 普通用户对话。 */
	meta?: { kind?: ConversationKind; parentId?: ConversationId; title?: string };
	/** 打开会话前的一次性准备（派生文件 / 转录分支）；抛错即视作本次重绑失败。 */
	prepare?(conversation: Conversation): Promise<void>;
}

export interface RebindResult {
	conversation: Conversation;
	/**
	 * 换下来的旧对话（已退役、已摘出注册表、会话已释放）。
	 * **被保留的旧对话不在这里**（老 `displaceActive` 返回 null）：它还在注册表里、还在跑。
	 */
	displaced?: Conversation;
}

/** 退役是单向闸：已经是终态的不再动（否则相位转换会抛）。 */
function retire(conversation: Conversation): void {
	if (conversation.phase === "retired") return;
	if (conversation.phase !== "retiring") conversation.retire();
	conversation.finishRetire();
}

/**
 * 腾位只需要这几样：注册表、会话释放口、保留判据、列入运行列表、
 * 以及「为什么留着」那句话（老 `displaceActive` 的 info notice）。
 */
export type DisplaceContext = Pick<
	RebindContext,
	"registry" | "sessions" | "shouldRetainPrevious" | "markListed" | "markPrompted" | "notice" | "inFlight"
>;

/**
 * 换活动对话前的「腾位」（老 `displaceActive`）：按判据决定**保留**还是**退役**。
 *
 * 返回是否保留了旧对话（老口径：返回 null = 保留）。两个入口共用这一份：
 * `rebindSession`（换目录 / 切转录 / 换工作树）与切到已经开着的对话
 * （`domains/sessions/entity.ts` 的 `switchSession` 复用路径）——老实现两条路都走 `displaceActive`。
 */
export function displacePrevious(ctx: DisplaceContext, conversation: Conversation): boolean {
	if (ctx.shouldRetainPrevious?.(conversation) === true) {
		// 保留 = 会话一个字节都不动 + 继续占运行列表一行（老 `conv.listed = true`）。
		ctx.markListed?.(conversation.id);
		// 老 `displaceActive` 在同一处还解释了一句：消息刚受理、还没开始流式，所以先不换。
		// 没有这句，用户会觉得「点了切对话却没切」——它不改变任何状态。
		if (ctx.inFlight?.(conversation) === true && conversation.phase !== "running") {
			const title = conversation.meta.title;
			ctx.notice?.(
				"info",
				`「${title}」的消息正在投递，已为你保留该对话`,
				`"${title}" is still sending your message — kept in the running list`,
			);
		}
		return true;
	}
	retire(conversation);
	ctx.registry.remove(conversation.id);
	ctx.sessions.close(conversation.id);
	return false;
}

/**
 * 会话实体重绑的唯一原语：**先建后拆**。
 *
 * 老树每次重绑都是同一套四步（释放旧会话 → 在新 cwd 建会话 → 重算快照/推帧 → 失败回滚），
 * 四个入口（`setCwd` / `switchSession` / `forkSession` / 换工作树）都在重复它。这里只写一遍：
 *
 * 1. 新对话先注册成**候选**（不激活、不出帧），旧对话与旧会话一个字节都不动；
 * 2. 候选会话真的开起来（这一步会读盘/建 SDK 运行时，是最可能失败的地方）；
 * 3. 成功才腾位：旧对话按 `shouldRetainPrevious` 决定保留还是退役（退役 = 退役 → 摘出注册表 → 释放会话），
 *    然后激活候选、全量重帧；
 * 4. 任何一步失败：候选会话释放、候选对话摘出注册表、活动指针回到原处，**旧会话仍然可用**，
 *    错误原样抛出（wire 层按自己的口径发 error notice）。
 *
 * 跨 `await` 只认稳定 id：活动指针在函数入口就取值，失败回滚时按 id 复位，绝不重读 `activeConv()`。
 */
export async function rebindSession(ctx: RebindContext, request: RebindRequest): Promise<RebindResult> {
	const previousId = ctx.registry.activeId();
	const previous = previousId ? ctx.registry.get(previousId) : undefined;
	const candidate = ctx.createConversation({
		cwd: request.cwd,
		...(request.sessionFile ? { sessionFile: request.sessionFile } : {}),
		...(request.meta?.kind ? { kind: request.meta.kind } : {}),
		...(request.meta?.parentId ? { parentId: request.meta.parentId } : {}),
		...(request.meta?.title ? { title: request.meta.title } : {}),
	});
	try {
		await request.prepare?.(candidate);
		await ctx.sessions.ensure(candidate, request.sessionCwd ? { cwd: request.sessionCwd } : undefined);
	} catch (error) {
		// 真回滚：候选是唯一被碰过的东西，全部撤掉；旧对话/旧会话从没被拆过，因此仍然可用。
		ctx.sessions.close(candidate.id);
		retire(candidate);
		ctx.registry.remove(candidate.id);
		if (previousId) ctx.registry.activate(previousId);
		ctx.frames.flush(true);
		throw error;
	}

	// 腾位：老实现在这里问 `isRetainedOnDisplace`，保留的对话不退役、只把活动指针让出去。
	const replaced = previous !== undefined && previous.id !== candidate.id;
	const retained = replaced && previous !== undefined ? displacePrevious(ctx, previous) : false;
	ctx.registry.activate(candidate.id);
	ctx.onActivated?.(candidate.id);
	ctx.frames.flush(true);
	ctx.frames.pushConversations?.();
	void ctx.frames.pushSessions?.();
	void ctx.frames.pushProjects?.();
	// 保留的旧对话不算被换下来（老 `displaceActive` 返回 null），调用方据此决定要不要报「旧对话已结束」。
	return { conversation: candidate, ...(replaced && !retained ? { displaced: previous } : {}) };
}
