import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { ConversationId } from "../../contracts/ids.js";
import type { Conversation, ConversationRegistry } from "../../kernel/conversation/index.js";

/** SDK 落盘窄面（`adapters/sdk/session-persist` 的 `isPersistedSession` / `persistSessionFile`）。 */
export interface SessionPersistPort {
	isPersisted(session: unknown): boolean;
	persist(input: { session: unknown; sessionBaseDir: string; cwd: string }): Promise<string>;
}

export interface PersistConversationOptions {
	registry: ConversationRegistry<Conversation>;
	/** 该对话的 SDK 会话（没开会话 = `undefined`）。 */
	sessionOf(conversationId: ConversationId): unknown;
	/** 会话目录基准（远程工作区要镜像到本地）：内核只调它，不认识 dataDir。 */
	sessionBaseDirOf(conv: Conversation): string;
	/** 缺省 = SDK 窄口未接，handler 调用时同步抛。 */
	sessionPersist?: SessionPersistPort;
	/** 新转录落盘后：运行列表帧 + 项目帧 + 快照（老实现 `emitConversations` / `pushProjects` / `flushSnapshot`）。 */
	pushConversations?(): void;
	pushProjects?(): Promise<void> | void;
	flushSnapshot(): void;
	notice(level: "info" | "warning" | "error", text: string, textEn: string): void;
}

export interface PersistConversationHandlers {
	persistConversation(id: string): Promise<void>;
}

/**
 * `persist_conversation` 的编排（老实现 `ClientSession.persistConversation`）：
 * 判存在 → 判是否已落盘 → 走 SDK 窄口写新转录 → 让对话聚合根改指向它 → 出帧 → 回执。
 *
 * 与老实现的差异（都只影响「内核没有对应概念」的那几支，不改磁盘语义）：
 * - 老实现会顺手 `conv.isSubagent = false`（把子代理固化成普通对话）。内核的对话种类是聚合根只读字段，
 *   历史列表由转录文件扫描决定（不看这个标志），所以这里不翻转它；
 * - 老实现会删 `agentDir/ephemeral-sessions/<id>`；内核的临时对话开在内存里（`SessionManager.inMemory`），
 *   本来就没有这份目录可删；转正时同一份 `persist()` 会把内存条目写成正式转录，并把标记翻掉；
 * - 会话没开着时老实现仍会写一个只有头的空文件（历史里凭空多一条空会话）。这里改成 fail-closed：
 *   发 warning 回执，什么都不写。
 */
export function createPersistConversationHandlers(options: PersistConversationOptions): PersistConversationHandlers {
	return {
		persistConversation(id: string): Promise<void> {
			// 端口解析先于一切读、且在 `async` 之外：未注入就是同步抛（不是 rejected promise）。
			const persist = options.sessionPersist;
			if (!persist) throw new CoreEngineNotReadyError("persistConversation");
			return run(id, persist, options);
		},
	};
}

async function run(id: string, persist: SessionPersistPort, options: PersistConversationOptions): Promise<void> {
	const conv = options.registry.get(id);
	if (!conv) {
		options.notice("warning", "该对话不存在或已关闭", "This conversation does not exist or is already closed");
		return;
	}
	const session = options.sessionOf(id);
	if (session && persist.isPersisted(session)) {
		options.notice(
			"info",
			`对话「${conv.meta.title}」已是持久化对话，无需固化`,
			`Conversation "${conv.meta.title}" is already persistent`,
		);
		return;
	}
	if (!session) {
		options.notice(
			"warning",
			`对话「${conv.meta.title}」的会话尚未打开，无法固化`,
			`Conversation "${conv.meta.title}" has no open session yet`,
		);
		return;
	}
	let sessionFile: string;
	try {
		sessionFile = await persist.persist({
			session,
			sessionBaseDir: options.sessionBaseDirOf(conv),
			cwd: conv.meta.cwd,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		options.notice("error", `固化对话失败：${message}`, `Failed to persist the conversation: ${message}`);
		return;
	}
	// 改指向新转录：`bindSessionFile` 同时写聚合根与「转录 → 对话」索引（`bySessionFile` 是它唯一的维护者）。
	options.registry.bindSessionFile(conv.id, sessionFile);
	// 临时对话转正：标记一翻，快照 `isEphemeral` 与运行列表行同时跟上（唯一翻转点在聚合根）。
	conv.markPersisted();
	options.pushConversations?.();
	await options.pushProjects?.();
	options.flushSnapshot();
	options.notice(
		"info",
		`已将对话「${conv.meta.title}」保存为正式对话，并存入历史记录`,
		`Saved conversation "${conv.meta.title}" to history`,
	);
}
