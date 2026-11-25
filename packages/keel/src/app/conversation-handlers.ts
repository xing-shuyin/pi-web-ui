import type { ConversationId } from "../contracts/ids.js";
import type { TransportPort } from "../contracts/ports.js";
import type { SnapshotConversationView } from "../contracts/snapshot-view.js";
import type { Conversation, ConversationRegistry } from "../kernel/conversation/index.js";
import { dismissConversation, renameConversation } from "../domains/sessions/index.js";
import { resolveProjectScripts } from "../project-scripts.js";

export interface ConversationDispatchOptions {
	registry: ConversationRegistry<Conversation>;
	transport: TransportPort;
	/** 当前工作区（对话没有 cwd 时的兜底）。 */
	cwd(): string;
	/** 对话可见面（取消息用）。 */
	viewOf?(conversation: Conversation): SnapshotConversationView | undefined;
	/** 出快照（切对话 / 计数变化后）。 */
	requestSnapshot(): void;
	onActivated?(id: string): void;
	now(): number;
	isAllowedPath?(path: string): boolean;
	closeSession?(conversationId: string): void;
	terminalManagerFor?(conversationId: string | undefined): unknown;
	/** 中止当前对话的那一轮（会话句柄的持有者是 runtime，这里只转调）。 */
	abortActive?(): Promise<void>;
}

/** 按对话派发的那一组 handler：切对话 / 终端归属 / 项目脚本 / 计数 / 消息 / 改名 / 关闭 / 中止。 */
export interface ConversationDispatchHandlers {
	switchConversation(id: string): Promise<void>;
	getTerminalManager(conversationId?: string): unknown;
	getTerminalCwd(conversationId?: string): string;
	findTerminalManager(terminalId: string, conversationId?: string): unknown;
	listProjectScripts(cwd?: string): void;
	activeConversations(): number;
	pendingMessages(): number;
	getMessagesOfConversation(convId: string): unknown[] | undefined;
	renameConversation(id: string, name: string): Promise<void>;
	dismissConversation(id: string, withFinishedSubagents?: boolean): Promise<void>;
	abort(): Promise<void>;
}

/** 会话实体还没接上时的空视图：协议字段齐全，消息为空。 */
export function emptyView(conv: Conversation): SnapshotConversationView {
	return {
		conversationId: conv.id,
		sessionId: conv.meta.sessionFile ?? conv.id,
		...(conv.meta.sessionFile ? { sessionFile: conv.meta.sessionFile } : {}),
		messages: [],
		streamingMessage: null,
		isStreaming: conv.phase === "running",
		model: null,
		thinkingLevel: "off",
		availableThinkingLevels: [],
		bot: conv.meta.botId ? { id: conv.meta.botId, name: conv.meta.botName ?? conv.meta.botId } : null,
		tools: [],
		steering: conv.queues.texts("steer"),
		followUp: conv.queues.texts("followUp"),
	};
}

/**
 * 对话级派发的 11 个 handler。离开 `ClientRuntime` 是因为它们只依赖「注册表 + 帧出口 + 叶子」，
 * 与重绑 / 会话实体无关；放一起也让 runtime 保持可读。
 */
export function createConversationDispatchHandlers(options: ConversationDispatchOptions): ConversationDispatchHandlers {
	const notice = (level: "info" | "warning" | "error", text: string, textEn: string): void => {
		if (options.transport.isClosed()) return;
		options.transport.send({ type: "notice", level, text, textEn });
	};
	return {
		// 切对话：只改注册表的活动指针（会话实体归 registry，不在这里重开）。
		async switchConversation(id: string): Promise<void> {
			if (!options.registry.has(id)) {
				notice("warning", "该对话不存在或已关闭", "This conversation does not exist or is already closed");
				return;
			}
			options.registry.activate(id);
			options.onActivated?.(id);
			options.requestSnapshot();
		},

		getTerminalManager: (conversationId?: string) =>
			options.terminalManagerFor?.(conversationId ?? options.registry.activeId()),

		// 终端的持有者是叶子（每对话一份）：这里只回答「谁的 cwd」「哪个 id 落在谁手里」。
		getTerminalCwd: (conversationId?: string) => {
			const conv = conversationId ? options.registry.get(conversationId) : options.registry.activeConv();
			return conv?.meta.cwd ?? options.cwd();
		},

		findTerminalManager: (terminalId: string, conversationId?: string) => {
			const manager = options.terminalManagerFor?.(conversationId ?? options.registry.activeId());
			// 没有「客户端级」终端管理器（那是老树的 userTerminals）：找不到就如实返回 undefined。
			return manager && (manager as { has?: (id: string) => boolean }).has?.(terminalId) ? manager : undefined;
		},

		listProjectScripts(cwd?: string): void {
			const base = (typeof cwd === "string" && cwd.trim()) || options.registry.activeConv()?.meta.cwd || options.cwd();
			try {
				const found = resolveProjectScripts(base);
				options.transport.send({ type: "project_scripts", cwd: found.cwd, scripts: found.scripts });
			} catch (error) {
				options.transport.send({
					type: "project_scripts",
					cwd: base,
					scripts: {},
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},

		// 计数口径与老实现逐字一致：只说「在跑几条」「还排着几条」。
		activeConversations: () => options.registry.list().filter((conv) => conv.phase === "running").length,
		pendingMessages: () => options.registry.list().reduce((n, conv) => n + conv.queues.total(), 0),

		getMessagesOfConversation: (convId: string) => {
			const conv = options.registry.get(convId);
			if (!conv) return undefined;
			const view = options.viewOf?.(conv) ?? emptyView(conv);
			return [...view.messages];
		},

		async renameConversation(id: string, name: string): Promise<void> {
			renameConversation({ registry: options.registry, conversationId: id, title: name, now: options.now() });
		},

		async dismissConversation(id: string, withFinishedSubagents?: boolean): Promise<void> {
			await dismissConversation({
				registry: options.registry,
				conversationId: id as ConversationId,
				withFinishedSubagents,
				now: () => options.now(),
				...(options.isAllowedPath ? { isAllowedPath: options.isAllowedPath } : {}),
				closeSession: (convId) => options.closeSession?.(convId),
			});
		},

		async abort(): Promise<void> {
			await options.abortActive?.();
		},
	};
}
