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
	/** 换下来的旧对话（已退役、已摘出注册表、会话已释放）。 */
	displaced?: Conversation;
}

/** 退役是单向闸：已经是终态的不再动（否则相位转换会抛）。 */
function retire(conversation: Conversation): void {
	if (conversation.phase === "retired") return;
	if (conversation.phase !== "retiring") conversation.retire();
	conversation.finishRetire();
}

/**
 * 会话实体重绑的唯一原语：**先建后拆**。
 *
 * 老树每次重绑都是同一套四步（释放旧会话 → 在新 cwd 建会话 → 重算快照/推帧 → 失败回滚），
 * 四个入口（`setCwd` / `switchSession` / `forkSession` / 换工作树）都在重复它。这里只写一遍：
 *
 * 1. 新对话先注册成**候选**（不激活、不出帧），旧对话与旧会话一个字节都不动；
 * 2. 候选会话真的开起来（这一步会读盘/建 SDK 运行时，是最可能失败的地方）；
 * 3. 成功才拆旧的：退役 → 摘出注册表 → 释放会话，然后激活候选、全量重帧；
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

	if (previous && previous.id !== candidate.id) {
		retire(previous);
		ctx.registry.remove(previous.id);
		ctx.sessions.close(previous.id);
	}
	ctx.registry.activate(candidate.id);
	ctx.onActivated?.(candidate.id);
	ctx.frames.flush(true);
	void ctx.frames.pushSessions?.();
	void ctx.frames.pushProjects?.();
	return { conversation: candidate, ...(previous && previous.id !== candidate.id ? { displaced: previous } : {}) };
}
