import type { TurnCapableSession } from "./session.js";

/**
 * 会话条目在当前分支上的最小形状（`buildContextEntries()` 的产出）。
 * 只声明本域用到的字段：SDK 的 `SessionEntry` 不许漏进 contracts。
 */
export interface TurnEntry {
	id: string;
	type: string;
	parentId?: string | null;
	message?: TurnEntryMessage;
	customType?: string;
	display?: boolean;
	/** 只在 `type === "context_edit"` 上有意义：被编辑的条目 / 替换内容（`null` = 从上下文里摘掉）。 */
	targetId?: string;
	replacement?: unknown;
}

/** 条目里的消息：够判定角色 / 工具调用 / 预览即可，不搬 SDK 的 `Message` 联合。 */
export interface TurnEntryMessage {
	role?: string;
	content?: unknown;
	toolCallId?: string;
	timestamp?: number;
	customType?: string;
}

/** `retryLast` 只看最后一条 assistant 的失败痕迹（含被投影隐去的失败尝试）。 */
export interface TurnAgentMessage {
	role?: string;
	errorMessage?: string;
	stopReason?: string;
}

export interface TurnCustomMessage {
	customType: string;
	content: unknown;
	display: boolean;
	details?: unknown;
}

/**
 * 消息编辑窄面：`TurnCapableSession` 去掉生命周期（本域不拥有会话）+ 条目级编辑能力。
 * 真身由 `adapters/sdk/session-edits.ts` 包住 SDK 的 `SessionManager` 与会话动作；
 * 编排（截断基准、删除目标、重试判定）全在 `domains/turns/`，这里只有能力。
 */
export interface MessageEditSession extends Omit<TurnCapableSession, "dispose" | "messages"> {
	readonly sessionFile?: string;
	readonly isStreaming?: boolean;
	readonly thinkingLevel?: string;
	abort?(): Promise<void> | void;
	clearQueue?(): void;
	setThinkingLevel?(level: string, options?: { persist?: boolean }): void;
	/** `abort()` 已经等过一次幂等；这里给调用方一个显式的收尾点。 */
	waitForIdle?(): Promise<void>;
	/** 自动重试是否在跑：`retryLast` 的第二个闸（老实现 `conv.retryState`）。 */
	isRetrying?(): boolean;
	/**
	 * 当前会话的稳定身份（适配器交同一份会话对象即可）。跨 await 复核用的就是这个：
	 * 窄面对象可以每次新建，但换了会话就必须换一个新值。
	 */
	sessionToken(): unknown;
	/** agent 侧消息（含失败尝试）：`retryLast` 只认最后一条 assistant。 */
	agentMessages(): readonly TurnAgentMessage[];
	/** 当前分支（压缩感知）的条目；已删除的条目仍在，由 `undeletedContextEntries()` 过滤。 */
	contextEntries(): readonly TurnEntry[];
	/** 根 → 叶的完整路径（丢弃分支时要看「基准之后还有哪些 toolCall」）。 */
	branchEntries(): readonly TurnEntry[];
	entry(id: string): TurnEntry | undefined;
	leafId(): string | null;
	/** 条目 id → 出帧投影里那条消息的 id（与 `adapters/sdk/view.ts` 的编号同源）。 */
	uiIds(): ReadonlyMap<string, string>;
	/** 让这条消息从模型上下文里消失；真正的「怎么删」由适配器决定（SDK 是 `appendContextEdit(id, null)`）。 */
	hideEntry(targetId: string): void;
	branch(fromId: string): void;
	resetLeaf(): void;
	appendCustomEntry(customType: string, data?: unknown): void;
	/** 用条目重建 agent 的上下文消息（截断/删除之后必须重算，老实现手写 `agent.state.messages = …`）。 */
	rebuildMessages(): void;
	reload(): Promise<void>;
	/** 回滚：把会话指回原文件（= 从盘上重读，丢掉内存里的编辑）。 */
	restoreSessionFile(sessionFile: string | undefined): void;
	sendCustomMessage(message: TurnCustomMessage, options?: { triggerTurn?: boolean }): Promise<void>;
}
