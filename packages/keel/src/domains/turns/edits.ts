import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { ConversationId } from "../../contracts/ids.js";
import type { ClockPort, TransportPort } from "../../contracts/ports.js";
import type { MessageEditSession } from "../../contracts/turns.js";
import type { Conversation, ConversationRegistry } from "../../kernel/conversation/index.js";
import type { PromptAttachment } from "../../protocol.js";
import {
	discardedScheduleCalls,
	findTurnBaseEntryId,
	isUserMessageEntry,
	lastAssistantFailed,
	messageDeletionTargets,
	resolveEntry,
	undeletedContextEntries,
} from "./entries.js";

/** 重问标记：截断之后先落一条，前端据此知道「后半段是被编辑掉的」。 */
const REASK_ENTRY = "pi-web-ui:reask";

/** 手动重试的引导语（老实现逐字沿用：它是模型看到的那段话，改一个字都可能改行为）。 */
const MANUAL_RETRY_TEXT =
	"（系统：用户点击了「重试」。请基于完整上下文重新发起上一次失败的模型请求，继续完成用户的任务。）";

export type ReaskPort = (conv: Conversation, text: string, attachments?: readonly PromptAttachment[]) => Promise<void>;

export interface TurnsEditDeps {
	registry: ConversationRegistry<Conversation>;
	transport: TransportPort;
	clock: ClockPort;
	/** 按对话取编辑窄面（会话注册表给）；缺省 = 该能力未接，handler 同步抛 `CoreEngineNotReadyError`。 */
	editorOf?: (conversationId: ConversationId) => MessageEditSession | undefined;
	/** 重问：走宿主的完整 prompt 管线（附件解析 / Bot 门禁 / 回合相位），内核不另开一条喂轮路。 */
	reask?: ReaskPort;
	/** abort 之后等这一轮真的收尾（相位回收窗口）；缺省 = 不等（`abort()` 自己已经等过 idle）。 */
	whenIdle?(conversationId: ConversationId): Promise<void>;
	flushSnapshot(): void;
	/** 会话重载后的宿主收尾：重放覆盖项 + 让会话列表失效。 */
	afterReload?(conversationId: ConversationId): void;
	/** 消息删除后的会话列表失效（删除不改写会话文件，只改上下文）。 */
	sessionsChanged?(conversationId: ConversationId): void;
	/** 截断前取消未启动的定时任务：宿主必须先落盘成功，再执行 `commit()`（老实现 #966）。 */
	cancelDiscarded?(input: { sessionFile: string; toolCallIds: ReadonlySet<string>; commit(): void }): Promise<void>;
	/** 恢复编辑前的模型（宿主：换 key + `applySessionModel`）；失败由本域吞掉（老口径）。 */
	restoreModel?(conversationId: ConversationId, model: unknown): Promise<void>;
}

export interface TurnsEditHandlers {
	editMessage(messageId: string, text: string, attachments?: readonly PromptAttachment[]): Promise<void>;
	deleteMessage(messageId: string, conversationId?: string): Promise<void>;
	retryLast(): Promise<void>;
}

/** 有一轮在飞？老实现只判 `session.isStreaming`，新树的相位同样代表「在飞」（含编辑重问的窗口）。 */
function isTurnInFlight(conv: Conversation, editor: MessageEditSession): boolean {
	return conv.phase === "running" || editor.isStreaming === true;
}

/**
 * 消息编辑面：`editMessage`（截断历史 + 重新提问）/ `deleteMessage`（上下文里摘掉消息）/ `retryLast`
 * （补发一次失败请求）。
 *
 * 语义源是 `server/agent-service.ts` 的同名三个方法：文案、闸门顺序、失败时「回滚到哪一步」
 * 全部逐字沿用；条目树的具体能力在 `MessageEditSession` 窄面后面（见 `adapters/sdk/session-edits.ts`）。
 */
export function createTurnsEditHandlers(options: TurnsEditDeps): TurnsEditHandlers {
	const notice = (level: "info" | "warning" | "error", text: string, textEn: string): void => {
		if (!options.transport.isClosed()) options.transport.send({ type: "notice", level, text, textEn });
	};
	const flush = (): void => options.flushSnapshot();

	/** 端口的「取不到就同步抛」：handler 不写成 `async`，否则同步抛会变成 rejected promise。 */
	const editorPort = (what: string): ((id: ConversationId) => MessageEditSession | undefined) => {
		const resolve = options.editorOf;
		if (!resolve) throw new CoreEngineNotReadyError(what);
		return resolve;
	};
	const reaskPort = (what: string): ReaskPort => {
		const reask = options.reask;
		if (!reask) throw new CoreEngineNotReadyError(what);
		return reask;
	};

	const clearQueues = (editor: MessageEditSession, conv: Conversation): void => {
		editor.clearQueue?.();
		conv.queues.clear();
	};

	/** 跨 await 的归属复核：对话换了实体、或会话被重开过，续体就不能再改这份转录。 */
	const current =
		(conv: Conversation, editor: MessageEditSession, resolve: (id: ConversationId) => MessageEditSession | undefined) =>
		() => {
			const token = editor.sessionToken();
			return options.registry.get(conv.id) === conv && resolve(conv.id)?.sessionToken() === token;
		};

	async function commitReask(
		editor: MessageEditSession,
		entryId: string,
		sessionFile: string | undefined,
	): Promise<void> {
		const baseEntryId = findTurnBaseEntryId((id) => editor.entry(id), entryId);
		const previousLeaf = editor.leafId();
		const commit = (): void => {
			try {
				if (baseEntryId) editor.branch(baseEntryId);
				else editor.resetLeaf();
				editor.appendCustomEntry(REASK_ENTRY, { version: 1 });
			} catch (error) {
				// 截断只许成功不许留半截：指回原文件（= 从盘上重读）再把叶指针放回去。
				editor.restoreSessionFile(sessionFile);
				if (previousLeaf) editor.branch(previousLeaf);
				else editor.resetLeaf();
				throw error;
			}
		};
		if (options.cancelDiscarded && sessionFile) {
			const toolCallIds = discardedScheduleCalls(editor.branchEntries(), baseEntryId);
			await options.cancelDiscarded({ sessionFile, toolCallIds, commit });
			return;
		}
		commit();
	}

	/** 截断后把模型与思考档放回去：老实现两处都 fail-soft，这里同口径（失败不改写错误流）。 */
	async function restoreSelection(
		editor: MessageEditSession,
		conv: Conversation,
		model: unknown,
		thinkingLevel: string | null,
	): Promise<void> {
		if (model && options.restoreModel) {
			try {
				await options.restoreModel(conv.id, model);
			} catch {}
		}
		if (thinkingLevel) {
			try {
				editor.setThinkingLevel?.(thinkingLevel);
			} catch {}
		}
	}

	async function runReask(
		resolve: (id: ConversationId) => MessageEditSession | undefined,
		reask: ReaskPort,
		conv: Conversation,
		editor: MessageEditSession,
		messageId: string,
		text: string,
		attachments: readonly PromptAttachment[] | undefined,
	): Promise<void> {
		const visible = undeletedContextEntries(editor.contextEntries());
		const entry = resolveEntry(visible, editor.uiIds(), messageId);
		if (!entry || !isUserMessageEntry(entry)) {
			notice(
				"error",
				"找不到要编辑的消息（可能已被压缩或不在当前分支）",
				"Message to edit not found (may have been compacted or is on another branch)",
			);
			flush();
			return;
		}
		const sessionFile = editor.sessionFile;
		const model = editor.model ?? null;
		const thinkingLevel = editor.thinkingLevel ?? null;
		const stillCurrent = current(conv, editor, resolve);
		try {
			// 老实现的顺序：先记住模型/思考档 → 清队列 → 停生成 → 截断 → 重载 → 恢复选择 → 重问。
			clearQueues(editor, conv);
			if (editor.isStreaming) {
				await editor.abort?.();
				await options.whenIdle?.(conv.id);
			}
			if (!stillCurrent()) return;
			await commitReask(editor, entry.id, sessionFile);
			if (!stillCurrent()) return;
			editor.rebuildMessages();
			await editor.reload();
			if (!stillCurrent()) return;
			options.afterReload?.(conv.id);
			clearQueues(editor, conv);
			await restoreSelection(editor, conv, model, thinkingLevel);
			if (!stillCurrent()) return;
			await reask(conv, text, attachments);
			if (!stillCurrent()) return;
			notice(
				"info",
				"已在当前对话重新提问，后续历史已移除",
				"Re-asked in the same conversation; later history removed",
			);
		} catch (error) {
			// 老实现同口径：截断之后的失败**不回滚**已截断的历史，只如实报错。
			notice(
				"error",
				`编辑重问失败：${(error as Error).message}`,
				`Edit-and-reask failed: ${(error as Error).message}`,
			);
		} finally {
			flush();
		}
	}

	async function runDelete(conv: Conversation, editor: MessageEditSession, messageId: string): Promise<void> {
		const sessionFile = editor.sessionFile;
		try {
			if (editor.isStreaming) throw new Error("Stop generation before deleting a message");
			const visible = undeletedContextEntries(editor.contextEntries());
			const entry = resolveEntry(visible, editor.uiIds(), messageId);
			if (!entry) throw new Error("Message not found");
			const ids = messageDeletionTargets(visible, entry.id);
			try {
				for (const id of ids) editor.hideEntry(id);
			} catch (error) {
				// 逐条 append 的删除没有事务：中途失败只能整份重读文件回滚，再把内存消息重算一遍。
				editor.restoreSessionFile(sessionFile);
				throw error;
			} finally {
				editor.rebuildMessages();
			}
			options.sessionsChanged?.(conv.id);
		} catch (error) {
			notice(
				"error",
				`删除消息失败：${(error as Error).message}`,
				`Failed to delete message: ${(error as Error).message}`,
			);
		}
		flush();
	}

	async function runRetry(conv: Conversation, editor: MessageEditSession): Promise<void> {
		try {
			// 老实现只判 session.isStreaming；新树的相位也代表「有一轮在飞」（含编辑重问的窗口），一并拒。
			if (isTurnInFlight(conv, editor)) {
				notice("info", "对话正在生成中，无需重试", "The conversation is still generating — no need to retry");
				return;
			}
			if (editor.isRetrying?.()) {
				notice("info", "正在自动重试中，稍候即可", "Auto-retry is in progress — please wait");
				return;
			}
			if (!lastAssistantFailed(editor.agentMessages())) {
				notice(
					"info",
					"没有可重试的失败：上一轮没有报错结束",
					"Nothing to retry: the last turn did not end with an error",
				);
				return;
			}
			const at = options.clock.now();
			conv.beginTurn(at);
			try {
				await editor.sendCustomMessage(
					{
						customType: "manual-retry",
						content: [{ type: "text", text: MANUAL_RETRY_TEXT }],
						display: false,
					},
					{ triggerTurn: true },
				);
			} finally {
				// 退役可能已经把相位带走（running → retiring）：只回收还停在 running 的那一份。
				if (conv.phase === "running") conv.endTurn(options.clock.now());
			}
		} catch (error) {
			notice("error", `手动重试失败：${(error as Error).message}`, `Manual retry failed: ${(error as Error).message}`);
		} finally {
			flush();
		}
	}

	return {
		editMessage(messageId, text, attachments): Promise<void> {
			const resolve = editorPort("editMessage");
			const reask = reaskPort("editMessage");
			const trimmed = text.trim();
			const hasAttachments = Boolean(attachments && attachments.length > 0);
			if (!trimmed && !hasAttachments) {
				notice("warning", "编辑内容为空，已取消", "Edited content is empty — cancelled");
				flush();
				return Promise.resolve();
			}
			const conv = options.registry.activeConv();
			if (!conv) {
				notice(
					"error",
					"编辑重问失败：Edit conversation is no longer available",
					"Edit-and-reask failed: Edit conversation is no longer available",
				);
				flush();
				return Promise.resolve();
			}
			const editor = resolve(conv.id);
			if (!editor) {
				notice(
					"error",
					"找不到要编辑的消息（可能已被压缩或不在当前分支）",
					"Message to edit not found (may have been compacted or is on another branch)",
				);
				flush();
				return Promise.resolve();
			}
			return runReask(resolve, reask, conv, editor, messageId, trimmed, attachments);
		},

		deleteMessage(messageId, conversationId): Promise<void> {
			const resolve = editorPort("deleteMessage");
			const conv = conversationId ? options.registry.get(conversationId) : options.registry.activeConv();
			if (!conv) {
				notice(
					"error",
					"删除消息失败：Conversation is no longer available",
					"Failed to delete message: Conversation is no longer available",
				);
				flush();
				return Promise.resolve();
			}
			const editor = resolve(conv.id);
			if (!editor) {
				notice("error", "删除消息失败：Message not found", "Failed to delete message: Message not found");
				flush();
				return Promise.resolve();
			}
			return runDelete(conv, editor, messageId);
		},

		retryLast(): Promise<void> {
			const resolve = editorPort("retryLast");
			const conv = options.registry.activeConv();
			if (!conv) {
				notice(
					"error",
					"手动重试失败：Conversation is no longer available",
					"Manual retry failed: Conversation is no longer available",
				);
				flush();
				return Promise.resolve();
			}
			const editor = resolve(conv.id);
			if (!editor) {
				notice(
					"info",
					"没有可重试的失败：上一轮没有报错结束",
					"Nothing to retry: the last turn did not end with an error",
				);
				flush();
				return Promise.resolve();
			}
			return runRetry(conv, editor);
		},
	};
}
