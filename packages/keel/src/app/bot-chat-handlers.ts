import type { BotChatPort } from "../contracts/bots.js";
import type { Conversation, ConversationRegistry } from "../kernel/conversation/index.js";
import type { DispatchSession } from "../engine-service.js";
import { createBotChatHandlers, type BotChatDispatch, type BotChatHandlers } from "../domains/bots/index.js";
import type { SessionSurface } from "./session-surface.js";

export type { BotChatHandlers };

/** 运行时里与私聊入口有关的那几件现成东西：私聊域不认识 `ClientRuntime`，只认这张窄面。 */
export interface BotChatRuntime {
	/** 宿主能力只在选项里（`bots` 是 thunk：装配期端口还没建好）。 */
	readonly options: { readonly bots?: () => BotChatPort | undefined };
	/** 本客户端的对话注册表：会话身份 / 工作目录 / 活跃指针的唯一来源。 */
	readonly registry: ConversationRegistry<Conversation>;
	/** 当前工作区（先切到 Bot 的目录再建会话，判据必须现取）。 */
	readonly cwd: string;
	/** 分发表：建会话 / 切对话 / notice / 出帧全走它（不另写一条建会话的路）。 */
	handlers(): DispatchSession;
	/** 工作区绑定与会话实体重绑（换目录 / 打开最近一份转录，和沙盒 / 工作树共用一份原语）。 */
	surface(): SessionSurface;
	/** 设置帧（装配前还没有出口：此时不发）。 */
	pushSettings(): void;
}

/**
 * Bot 私聊面的装配：把运行时现成的几件事（注册表、分发表、工作区/重绑原语）接到私聊域上。
 *
 * 这里不写业务：默认回到同一个私聊、`fresh` 新开、Bot 不可用的提示全在 `domains/bots/`；
 * Bot 注册表与转录锚点在宿主端口后面（`server/core-bot-adapter.ts`）。
 */
export function createBotChatHandlersFor(runtime: BotChatRuntime): BotChatHandlers {
	/** 私聊编排放到调用时取分发表：`handlers()` 自己就会 `spread` 本组 handler（现在取会成环）。 */
	const dispatch = (): BotChatDispatch => {
		const session = runtime.handlers();
		return {
			emitNotice: (level, text, textEn) => session.emitNotice(level, text, textEn),
			setCwd: (path) => runtime.surface().workspace().setCwd(path),
			switchConversation: (id) => session.switchConversation(id),
			switchSession: (path) => runtime.surface().entity().switchSession(path),
			newChat: (preset, ephemeral, onReady, independent, botId) =>
				session.newChat(preset, ephemeral, onReady, independent, botId),
			flushSnapshot: (forceFull) => session.flushSnapshot(forceFull),
			pushSettings: () => runtime.pushSettings(),
		};
	};
	return createBotChatHandlers({
		registry: runtime.registry,
		dispatch,
		bots: () => runtime.options.bots?.(),
		cwd: () => runtime.cwd,
	});
}
