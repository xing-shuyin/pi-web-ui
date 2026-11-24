import type { Conversation } from "../kernel/conversation/index.js";
import { openTurnSession, type OpenedSession } from "../adapters/sdk/index.js";

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
	onOpened?(conversation: Conversation, opened: OpenedSession): void;
	onClosed?(conversationId: string): void;
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

	constructor(options: SessionRegistryOptions) {
		this.options = options;
	}

	has(conversationId: string): boolean {
		return this.byConversation.has(conversationId);
	}

	get(conversationId: string): OpenedSession | undefined {
		return this.byConversation.get(conversationId);
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
	}

	openCount(): number {
		return this.byConversation.size;
	}
}
