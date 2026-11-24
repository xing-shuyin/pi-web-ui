/**
 * 计划模式 / 审查者模式的**运行态**：写工具门禁与快照读的都是这一份。
 *
 * 真值不在内核也不在内存里 —— 重启后能恢复的那份在会话转录（`plan/mode` / `delegate/mode` 条目，
 * 写读都在宿主 `chat-mode-entries.ts`）。这里只是「本条对话现在是不是这个模式」的进程内投影：
 * 模式开关无论谁来拨（用户开关 / 会话打开时的 `restore()`），都必须走 `setMode()` 这一个点，
 * 否则就会出现「快照说计划模式开着、写工具照样执行」的假开关。
 */
export type ChatModeKind = "plan" | "delegate";

interface ModeRecord {
	plan: boolean;
	delegate: boolean;
	delegateConvId?: string | null;
}

const OFF: ModeRecord = { plan: false, delegate: false, delegateConvId: null };

export class ChatModeState {
	private readonly byConversation = new Map<string, ModeRecord>();

	modeOf(kind: ChatModeKind, conversationId?: string): boolean {
		if (!conversationId) return false;
		return this.byConversation.get(conversationId)?.[kind] === true;
	}

	planModeOf(conversationId?: string): boolean {
		return this.modeOf("plan", conversationId);
	}

	delegateModeOf(conversationId?: string): boolean {
		return this.modeOf("delegate", conversationId);
	}

	delegateConvIdOf(conversationId?: string): string | null {
		if (!conversationId) return null;
		return this.byConversation.get(conversationId)?.delegateConvId ?? null;
	}

	setDelegateConvId(conversationId: string, delegateConvId: string | null): void {
		const current = this.byConversation.get(conversationId) ?? OFF;
		this.byConversation.set(conversationId, { ...current, delegateConvId });
	}

	/** 唯一切换点：门禁的 thunk 与出帧的投影都读这里，写完就是全局生效。 */
	setMode(kind: ChatModeKind, enabled: boolean, conversationId?: string): void {
		if (!conversationId) return;
		const current = this.byConversation.get(conversationId) ?? OFF;
		this.byConversation.set(conversationId, {
			...current,
			[kind]: enabled,
			...(kind === "delegate" && !enabled ? { delegateConvId: null } : {}),
		});
	}
}
