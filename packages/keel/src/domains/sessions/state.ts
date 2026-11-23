import type { ClientId } from "../../contracts/ids.js";
import type { Conversation } from "../../kernel/conversation/index.js";
import type { ConversationRegistry } from "../../kernel/conversation/index.js";
import type { TransportPort } from "../../contracts/ports.js";
import { ComposerDraftsStore } from "../../composer-drafts.js";

export interface ConversationStateOptions {
	clientId: ClientId;
	registry: ConversationRegistry<Conversation>;
	transport: TransportPort;
	/** 草稿落盘（`composer-drafts` 叶子在 keel 里）：缺省按 dataDir 建一份，构造不读盘。 */
	drafts: ComposerDraftsStore;
	/** 出快照 / 推会话帧。 */
	flushSnapshot(): void;
	pushSessions?(): void;
}

export interface ConversationStateHandlers {
	removeQueued(kind: "steer" | "followUp", text: string, index?: number, id?: string): Promise<void>;
	saveDraft(sessionId: string, text: string, ts: number): Promise<void>;
	dismissFinishedSubagents(parentId?: string): Promise<void>;
}

/**
 * 会话状态面的 4 个 handler。
 *
 * 老实现里这些方法都带「目标对话已换代就作废」的守卫：切走的对话不能拿旧引用改队列/草稿。
 * 内核把这条收敛成「按 id 现查注册表」，只要对话还在就改，不在了就发 warning（不静默成功）。
 */
export function createConversationStateHandlers(options: ConversationStateOptions): ConversationStateHandlers {
	const notice = (level: "info" | "warning" | "error", text: string, textEn: string): void => {
		if (options.transport.isClosed()) return;
		options.transport.send({ type: "notice", level, text, textEn });
	};
	const activeOr = (id?: string): Conversation | undefined =>
		id ? options.registry.get(id) : options.registry.activeConv();

	return {
		async removeQueued(kind, text, index, id): Promise<void> {
			const conv = id ? options.registry.get(id) : options.registry.activeConv();
			if (!conv) throw new Error("Queue conversation is no longer available");
			conv.queues.remove(kind, { id, text, index });
			options.flushSnapshot();
		},

		async saveDraft(sessionId, text, ts): Promise<void> {
			if (!sessionId) return;
			try {
				await options.drafts.save(sessionId, text, ts);
			} catch {
				// 老实现同口径：草稿存不下不打断输入，但要明说（否则用户以为存住了）。
				notice(
					"error",
					"草稿保存失败，请保留输入内容并检查磁盘空间和文件权限。",
					"Draft could not be saved. Keep your input and check disk space and file permissions.",
				);
			}
		},

		async dismissFinishedSubagents(parentId?: string): Promise<void> {
			const root = parentId?.trim() ? parentId.trim() : undefined;
			if (root && !options.registry.has(root)) {
				notice("warning", "该对话不存在或已关闭", "This conversation does not exist or is already closed");
				return;
			}
			for (const conv of [...options.registry.list()]) {
				if (conv.meta.kind !== "subagent") continue;
				if (root && conv.meta.parentId !== root) continue;
				if (conv.phase !== "idle") continue;
				conv.retire();
				conv.finishRetire();
				options.registry.remove(conv.id);
			}
			options.pushSessions?.();
			options.flushSnapshot();
		},
	};
}
