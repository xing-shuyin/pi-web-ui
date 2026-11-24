import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { ConversationId } from "../../contracts/ids.js";
import type { MessageEditSession } from "../../contracts/turns.js";
import type { Conversation, ConversationRegistry } from "../../kernel/conversation/index.js";

export interface SessionRollbackOptions {
	registry: ConversationRegistry<Conversation>;
	/** 按对话取编辑窄面（条目树）；缺省 = 会话实体未接，handler 同步抛。 */
	editorOf?(conversationId: ConversationId): MessageEditSession | undefined;
	/** 前端消息 id → 条目 id（消息解析单源在 `domains/turns/entries`，本域只认结果）。 */
	entryIdOf?(editor: MessageEditSession, messageId: string): string | undefined;
	/** 重载后的宿主收尾（老实现 `applySessionOverrides` + 让会话列表失效）。 */
	afterReload?(conversationId: ConversationId): void;
	flushSnapshot(): void;
	notice(level: "info" | "warning" | "error", text: string, textEn: string): void;
}

export interface SessionRollbackHandlers {
	rollbackSession(messageId: string, conversationId?: string): Promise<void>;
}

/** 叶指针复位：只动内存游标（转录 append-only，回滚不写盘）。失败就当没救回来，不掩盖原始错误。 */
function restoreLeaf(editor: MessageEditSession, leafId: string | null): void {
	try {
		if (leafId) editor.branch(leafId);
		else editor.resetLeaf();
	} catch {}
	try {
		editor.rebuildMessages();
	} catch {}
}

/**
 * 回滚到指定消息（老实现 `ClientSession.rollbackSession`）。
 *
 * 等价物是「叶指针改到某条条目 + 重载」，**不换会话**：`branch()` 只改内存游标，转录是 append-only 的，
 * 所以关掉重开做不到回滚（重开等于回到文件里的原分支）。因此必须走同一份会话的
 * `branch → rebuildMessages → reload`。
 *
 * 失败回滚到原位：进函数时把叶指针与 `sessionToken()` 抓成稳定值，跨 `await` 只认它们；
 * `reload()` 失败时按抓下来的叶指针复位（对话已被换掉/关掉时不碰新会话，免得把别人的游标改掉）。
 *
 * 与老实现的差异：老树 `restoreWorkspace`（回滚时把工作区物理文件还原到检查点）依赖宿主的
 * `workspaceSnapshots` 存储，本引擎没有这份状态，故不接该参数；分支点的思考档也回填不了
 * （老实现读 `buildSessionContext().thinkingLevel`，窄面没这个出口），由 `afterReload` 的宿主收尾重放。
 */
export function createSessionRollbacks(options: SessionRollbackOptions): SessionRollbackHandlers {
	const notice = options.notice;
	const flush = (): void => options.flushSnapshot();

	async function runRollback(
		conv: Conversation,
		editor: MessageEditSession,
		messageId: string,
		entryIdOf: (editor: MessageEditSession, messageId: string) => string | undefined,
		editorOf: (conversationId: ConversationId) => MessageEditSession | undefined,
	): Promise<void> {
		const entryId = entryIdOf(editor, messageId);
		if (!entryId) {
			notice(
				"error",
				"找不到指定的回滚检查点（可能已被压缩或不存在）",
				"Rollback checkpoint not found (may have been compacted or not exist)",
			);
			flush();
			return;
		}
		// 跨 await 只认稳定 id：叶指针在改任何东西之前抓住；会话身份用 `sessionToken()` 复核。
		const previousLeaf = editor.leafId();
		const token = editor.sessionToken();
		const stillCurrent = (): boolean =>
			options.registry.get(conv.id) === conv && editorOf(conv.id)?.sessionToken() === token;
		try {
			if (editor.isStreaming) await editor.abort?.();
			if (!stillCurrent()) return;
			// 排队中的意图先清掉：否则截断后的第一条 append 可能来自旧分支的续投。
			editor.clearQueue?.();
			conv.queues.clear();
			try {
				editor.branch(entryId);
				editor.rebuildMessages();
				await editor.reload();
			} catch (error) {
				if (stillCurrent()) restoreLeaf(editor, previousLeaf);
				throw error;
			}
			if (!stillCurrent()) return;
			options.afterReload?.(conv.id);
			notice(
				"info",
				"已回滚至选定消息，后续内容已丢弃，可直接继续对话。",
				"Rolled back to selected message; subsequent content discarded, ready to continue.",
			);
		} catch (error) {
			notice("error", `回滚失败：${(error as Error).message}`, `Rollback failed: ${(error as Error).message}`);
		} finally {
			flush();
		}
	}

	return {
		rollbackSession(messageId: string, conversationId?: string): Promise<void> {
			const editorOf = options.editorOf;
			if (!editorOf) throw new CoreEngineNotReadyError("rollbackSession");
			const entryIdOf = options.entryIdOf;
			if (!entryIdOf) throw new CoreEngineNotReadyError("rollbackSession.entryIdOf");
			const conv = conversationId ? options.registry.get(conversationId) : options.registry.activeConv();
			if (!conv) {
				notice("error", "回滚失败：对话已不在运行中", "Rollback failed: the conversation is no longer running");
				flush();
				return Promise.resolve();
			}
			const editor = editorOf(conv.id);
			if (!editor) {
				notice(
					"error",
					"找不到指定的回滚检查点（可能已被压缩或不存在）",
					"Rollback checkpoint not found (may have been compacted or not exist)",
				);
				flush();
				return Promise.resolve();
			}
			return runRollback(conv, editor, messageId, entryIdOf, editorOf);
		},
	};
}
