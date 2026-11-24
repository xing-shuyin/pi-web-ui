import { rm } from "node:fs/promises";
import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { ForkEvidencePort } from "../../contracts/fork.js";
import type { ConversationId, SessionFile } from "../../contracts/ids.js";
import type { MessageEditSession } from "../../contracts/turns.js";
import type { Conversation, ConversationRegistry } from "../../kernel/conversation/index.js";
import type { RebindRequest, RebindResult } from "./rebind.js";

export interface SessionForkOptions {
	registry: ConversationRegistry<Conversation>;
	/** 按对话取编辑窄面（条目树）；缺省 = 会话实体未接，handler 同步抛。 */
	editorOf?(conversationId: ConversationId): MessageEditSession | undefined;
	/** 前端消息 id → 条目 id（消息解析单源在 `domains/turns/entries`，本域只认结果）。 */
	entryIdOf?(editor: MessageEditSession, messageId: string): string | undefined;
	/** `position: "before"` 的分叉基准（该轮起点之前的条目）；`null` = 没有可截的基准。 */
	baseEntryIdOf?(editor: MessageEditSession, entryId: string): string | null;
	/** 派生新转录（`adapters/sdk/session-opener` 的 `createBranchFile`）；缺省 = SDK 窄口未接，同步抛。 */
	createBranchFile?(input: { sessionFile: SessionFile; leafId: string }): Promise<SessionFile>;
	/** 外置证据搬运（宿主 `context-evidence`）；缺省 = 只派生转录本体。 */
	evidence?(): ForkEvidencePort | undefined;
	/** 重绑原语（切到新会话）；缺省 = 未接，同步抛。 */
	rebind?(request: RebindRequest): Promise<RebindResult>;
	/** 新对话进运行列表（老树 `newConv.listed` 由 spawn/激活保证）；缺省 = 不记账。 */
	markListed?(conversationId: ConversationId): void;
	flushSnapshot(): void;
	notice(level: "info" | "warning" | "error", text: string, textEn: string): void;
}

export interface SessionForkHandlers {
	forkSession(messageId: string, position?: "before" | "at", conversationId?: string): Promise<void>;
}

/**
 * 在指定消息处派生一个新会话（老实现 `ClientSession.forkSession`）。
 *
 * 等价物是「从现有转录派生一份新文件 + 重绑到它」，两点是硬约束：
 *
 * 1. **原对话的转录一个字节都不动**：派生走新开的 manager（见 `createBranchFile`），新文件是新 session id，
 *    头部 `parentSession` 指向原文件，因此不存在「两个对话写同一份转录」；
 * 2. **失败真回滚**：派生出来的文件与证据目录全部删掉，重绑原语自己会把候选对话撤掉，活动指针回到原处。
 *
 * 与老实现的差异（都不改磁盘语义，只影响界面）：老树 `forkFrom`（内存里的分叉角标）需要内核对话聚合里
 * 有对应字段，本引擎没有；分叉关系只留在转录头部的 `parentSession`。老树还有 `maxOpenConversations`
 * 上限与「把旧对话留在运行列表」两条策略，重绑原语口径是「同一时刻只开一份」。
 */
export function createSessionForks(options: SessionForkOptions): SessionForkHandlers {
	const notice = options.notice;
	const flush = (): void => options.flushSnapshot();

	/** 端口「取不到就同步抛」：handler 不写成 `async`，否则同步抛会变成 rejected promise。 */
	const required = <T>(value: T | undefined, what: string): T => {
		if (!value) throw new CoreEngineNotReadyError(what);
		return value;
	};

	async function discard(branchFile: SessionFile): Promise<void> {
		await rm(branchFile, { force: true }).catch(() => {});
		const evidence = options.evidence?.();
		await Promise.resolve(evidence?.remove?.(branchFile)).catch(() => {});
	}

	async function runFork(
		editor: MessageEditSession,
		conv: Conversation,
		messageId: string,
		position: "before" | "at",
		createBranchFile: NonNullable<SessionForkOptions["createBranchFile"]>,
		rebind: NonNullable<SessionForkOptions["rebind"]>,
	): Promise<void> {
		let entryId: string | undefined;
		try {
			entryId = required(options.entryIdOf, "forkSession.entryIdOf")(editor, messageId);
		} catch (error) {
			notice("error", `派生分支会话失败：${(error as Error).message}`, `Failed to fork: ${(error as Error).message}`);
			flush();
			return;
		}
		if (!entryId) {
			notice(
				"error",
				"找不到指定的消息节点（可能已被压缩或不在当前分支）",
				"Message node to fork from not found (may have been compacted or is on another branch)",
			);
			flush();
			return;
		}
		// 位置 → 条目 id：`at` 就是这条消息本身；`before` 截到这一轮之前（基准为空 = 没有可分叉的内容）。
		const leafId =
			position === "at" ? entryId : required(options.baseEntryIdOf, "forkSession.baseEntryIdOf")(editor, entryId);
		if (!leafId) {
			notice(
				"error",
				"这条消息之前没有可分叉的内容（分叉会得到空会话）",
				"Nothing to fork before this message (the fork would be empty)",
			);
			flush();
			return;
		}
		// 跨 await 只认稳定值：重绑会退役旧对话，之后一律不再读它的meta。
		const sourceFile = conv.meta.sessionFile ?? editor.sessionFile;
		const cwd = conv.meta.cwd;
		if (!sourceFile) {
			notice(
				"error",
				"该对话还没有会话文件，先发一条消息再派生分支",
				"This conversation has no transcript yet — send a message before forking",
			);
			flush();
			return;
		}

		let branchFile: SessionFile | undefined;
		try {
			branchFile = await createBranchFile({ sessionFile: sourceFile, leafId });
			const evidence = options.evidence?.();
			if (evidence) await evidence.copy(sourceFile, branchFile);
			const result = await rebind({ cwd, sessionFile: branchFile });
			options.markListed?.(result.conversation.id);
			notice(
				"info",
				"🌱 已派生新分支会话并自动切换（原对话保持不变）",
				"🌱 Forked new branch session and switched to it (original preserved)",
			);
		} catch (error) {
			if (branchFile) await discard(branchFile);
			notice(
				"error",
				`派生分支会话失败：${(error as Error).message}`,
				`Failed to fork branch session: ${(error as Error).message}`,
			);
		} finally {
			flush();
		}
	}

	return {
		forkSession(messageId: string, position: "before" | "at" = "before", conversationId?: string): Promise<void> {
			const editorOf = required(options.editorOf, "forkSession");
			const createBranchFile = required(options.createBranchFile, "forkSession");
			const rebind = required(options.rebind, "forkSession");
			const conv = conversationId ? options.registry.get(conversationId) : options.registry.activeConv();
			if (!conv) {
				notice("error", "派生分支会话失败：对话已不在运行中", "Failed to fork: the conversation is no longer running");
				flush();
				return Promise.resolve();
			}
			const editor = editorOf(conv.id);
			if (!editor) {
				notice(
					"error",
					"找不到指定的消息节点（可能已被压缩或不在当前分支）",
					"Message node to fork from not found (may have been compacted or is on another branch)",
				);
				flush();
				return Promise.resolve();
			}
			return runFork(editor, conv, messageId, position, createBranchFile, rebind);
		},
	};
}
