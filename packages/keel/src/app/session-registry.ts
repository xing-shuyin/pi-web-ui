import type { Conversation } from "../kernel/conversation/index.js";
import { openTurnSession, type OpenedSession } from "../adapters/sdk/index.js";
import type { PromptRenderHost } from "../contracts/prompt-render.js";

export interface SessionRegistryOptions {
	agentDir: string;
	/** 开会话时注册哪些工具；由装载域算出，注册表不做默认值。 */
	toolsFor?(conversation: Conversation): readonly string[] | undefined;
	/** 开会话时注册哪些自定义工具；由 app 层按对话装配。 */
	customToolsFor?(conversation: Conversation): readonly unknown[] | undefined;
	/** Bot 私聊转录的存放目录（单源在宿主侧：`<agentDir>/bot-sessions/<botId>`）。 */
	botSessionDir?(botId: string): string | undefined;
	/** 会话打开时绑定 Bot 身份与转录锚点（停用/降级/孤儿拦截/重绑锚点）。 */
	bindBotSession?(conversation: Conversation, opened: OpenedSession): Promise<void>;
	prepare?(conversation: Conversation): Promise<void>;
	/**
	 * 这条对话开会话时要绑的扩展 UI 上下文（`UiBridgePort.uiContextFor` 的结果）：缺省 = 不绑扩展。
	 * `conv.meta.kind === "subagent"` 传 `undefined`（headless：dialog 立刻 `null`，不等浏览器）。
	 */
	uiContextOf?(conversation: Conversation): unknown;
	onOpened?(conversation: Conversation, opened: OpenedSession): void;
	onClosed?(conversationId: string): void;
	/** 注册表把所有会话都关掉之后（客户端断开）：长生命周期的订阅在这里收口。 */
	onCloseAll?(): void;
	/** 门控重放（计划/审查者模式拨开关之后）：活动集的写口在 app 层，注册表只负责转发。 */
	replayToolGating?(conversationId?: string): void;
}

export class SessionUnavailableError extends Error {
	readonly code = "session_unavailable";

	constructor(conversationId: string, reason: string) {
		super(`conversation ${conversationId} cannot open a session: ${reason}`);
		this.name = "SessionUnavailableError";
	}
}

/**
 * 按对话持有的 SDK 会话：建/开一个、换掉旧的、退役时释放。
 * 相位闸在这里复述一次（fail-closed 先于开会话）：退役中的对话不会因为调用顺序而被重新拉起来。
 */
export class SessionRegistry {
	private readonly byConversation = new Map<string, OpenedSession>();
	private readonly options: SessionRegistryOptions;
	/** 提示词覆写端口（宿主渲染正文）：缺省 = 内核不改提示词。 */
	private promptRender: PromptRenderHost | undefined;

	constructor(options: SessionRegistryOptions) {
		this.options = options;
	}

	/**
	 * 挂上提示词覆写通道（宿主面装配时接一次，之后开的会话都带）：只存引用，不开会话、不改任何默认值。
	 * 已经开着的会话不回溯：扩展在 `createAgentSessionServices` 那一刻定下，改它就等于重建会话。
	 */
	attachPromptRender(host: PromptRenderHost | undefined): void {
		this.promptRender = host;
	}

	has(conversationId: string): boolean {
		return this.byConversation.has(conversationId);
	}

	get(conversationId: string): OpenedSession | undefined {
		return this.byConversation.get(conversationId);
	}

	/** 模式开关拨完之后的门控重放（会话没开就什么也不做：开会话时 `onOpened` 会重放一次）。 */
	replayToolGating(conversationId?: string): void {
		this.options.replayToolGating?.(conversationId);
	}

	transferFrom(other: SessionRegistry, sourceId: string, targetId: string): OpenedSession | undefined {
		const opened = other.byConversation.get(sourceId);
		if (!opened) return undefined;
		// 目标这边已经有会话了 = 这次搬迁没真正发生（或已经搬过）：**不覆盖**。
		// 覆盖会把一份活着的、正在跑的会话换成空壳（过户回滚时在跑的那一轮就此蒸发）。
		if (this.byConversation.has(targetId)) return undefined;
		other.byConversation.delete(sourceId);
		this.byConversation.set(targetId, opened);
		return opened;
	}

	async ensure(conv: Conversation, options?: { cwd?: string }): Promise<OpenedSession> {
		const existing = this.byConversation.get(conv.id);
		if (existing) return existing;
		if (!conv.acceptsTurns) throw new SessionUnavailableError(conv.id, `phase ${conv.phase}`);
		await this.options.prepare?.(conv);
		const opened = await openTurnSession({
			// 远程工作区的 SDK 会话目录与 cwd 分离（`cwd` 是 URI，会话落本地镜像目录）。
			cwd: options?.cwd ?? conv.meta.cwd,
			agentDir: this.options.agentDir,
			sessionDir:
				conv.meta.kind === "bot" && conv.meta.botId ? this.options.botSessionDir?.(conv.meta.botId) : undefined,
			sessionFile: conv.meta.sessionFile,
			// 临时对话：会话开在内存里，不产生 `.jsonl`（转正后才由 `persist_conversation` 落盘）。
			...(conv.ephemeral ? { ephemeral: true } : {}),
			tools: this.options.toolsFor?.(conv),
			customTools: this.options.customToolsFor?.(conv),
			...(this.options.uiContextOf ? { uiContext: this.options.uiContextOf(conv) } : {}),
			// 模板子代理（`kind: "subagent"`）的提示词完全由 loader 的模板槽位决定，组合模板不接进去
			// （老实现 `pi-webui-persona` 钩子里的 `if (apply) return undefined` 同一语义）。
			...(this.promptRender && conv.meta.kind !== "subagent"
				? {
						promptRender: {
							...this.promptRender,
							conversationId: conv.id,
							botId: () => conv.meta.botId,
						},
					}
				: {}),
		});
		if (opened.sessionFile && opened.sessionFile !== conv.meta.sessionFile) conv.setSessionFile(opened.sessionFile);
		try {
			if (this.options.bindBotSession) await this.options.bindBotSession(conv, opened);
		} catch (error) {
			opened.dispose();
			throw error;
		}
		this.byConversation.set(conv.id, opened);
		this.options.onOpened?.(conv, opened);
		return opened;
	}

	close(conversationId: string): void {
		const opened = this.byConversation.get(conversationId);
		if (!opened) return;
		this.byConversation.delete(conversationId);
		try {
			opened.dispose();
		} finally {
			this.options.onClosed?.(conversationId);
		}
	}

	closeAll(): void {
		for (const id of this.byConversation.keys()) this.close(id);
		this.options.onCloseAll?.();
	}

	openCount(): number {
		return this.byConversation.size;
	}
}
