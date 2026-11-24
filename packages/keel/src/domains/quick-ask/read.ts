import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { ConversationId } from "../../contracts/ids.js";
import type { QuickAskConversationSnapshot, QuickAskConversationSource } from "../../contracts/plugin.js";
import type { QuickAskConversationFacts, QuickAskConversationReadPort } from "../../contracts/quick-ask.js";
import type { Conversation, ConversationRegistry } from "../../kernel/conversation/index.js";
import { normalizePathKey } from "../../projects-schema.js";

export interface QuickAskReadOptions {
	registry: ConversationRegistry<Conversation>;
	/** 已开会话的转录（SDK `messages` 原样）：没开会话 = `undefined`（不拿半死句柄）。 */
	messagesOf(conversationId: ConversationId): readonly { role: string; content?: unknown }[] | undefined;
	/** 原生 CLI 对话的终端（绑定在 native-cli 域）：没有 = 不认 CLI 回放分支。 */
	nativeCliOf?(conversationId: ConversationId): { terminalId: string; preset: string } | undefined;
	/** 宿主窄面（转录摘取 / 终端回放 / 磁盘历史）；缺省 = 未接，调用时同步抛。 */
	port(): QuickAskConversationReadPort | undefined;
}

/** 按 `conversationId` / `sessionFile` 找会话：两处入口共用同一份判据（与会话索引同源）。 */
function conversationOf(
	registry: ConversationRegistry<Conversation>,
	source: QuickAskConversationSource,
): Conversation | undefined {
	if (source.conversationId) return registry.get(source.conversationId);
	if (!source.sessionFile) return undefined;
	const byIndex = registry.bySessionFile(source.sessionFile);
	if (byIndex) return byIndex;
	const key = normalizePathKey(source.sessionFile);
	return registry.list().find((conv) => conv.meta.sessionFile && normalizePathKey(conv.meta.sessionFile) === key);
}

/**
 * 内核解析出的会话事实。CLI 对话的正文只在终端回放里：没有绑定就如实说「读不到」，不拿空转录糊弄。
 */
function factsOf(conv: Conversation, options: QuickAskReadOptions): QuickAskConversationFacts | undefined {
	const liveFile = conv.meta.sessionFile;
	const cli = options.nativeCliOf?.(conv.id);
	if (conv.meta.kind === "cli" && !cli) return undefined;
	return {
		title: conv.meta.title,
		cwd: conv.meta.cwd,
		...(liveFile ? { sessionFile: liveFile } : {}),
		...(() => {
			const messages = options.messagesOf(conv.id);
			return messages ? { messages } : {};
		})(),
		...(cli ? { terminalId: cli.terminalId, preset: cli.preset } : {}),
	};
}

/**
 * 随手问的上下文读取（老实现 `ClientSession.readQuickAskConversation`）。
 *
 * 内核侧只做**解析**：哪条对话、它的转录是什么、是不是原生 CLI 对话、给进来的 `sessionFile` 与它是否
 * 同一份（不同 = 拒绝，老实现同一句判据）。转录摘取（`captureQuickAskConversation`）、终端回放、
 * 磁盘历史读（`readHistorySession`）都在宿主端口后面 —— 那三件只有宿主一份实现，内核不重写。
 *
 * 函数体不是 `async`：端口解析发生在**调用时**，未注入就是同步抛 `CoreEngineNotReadyError`
 * （派发面口径与 `forkSession` 一致，不变成 rejected promise）。
 */
export function readQuickAskConversation(
	source: QuickAskConversationSource,
	signal: AbortSignal,
	options: QuickAskReadOptions,
): Promise<QuickAskConversationSnapshot | undefined> {
	const port = options.port();
	if (!port) throw new CoreEngineNotReadyError("readQuickAskConversation");
	return resolve(source, signal, options, port);
}

async function resolve(
	source: QuickAskConversationSource,
	signal: AbortSignal,
	options: QuickAskReadOptions,
	port: QuickAskConversationReadPort,
): Promise<QuickAskConversationSnapshot | undefined> {
	signal.throwIfAborted();

	const conv = conversationOf(options.registry, source);
	if (conv) {
		const liveFile = conv.meta.sessionFile;
		// 给了 sessionFile 就必须是这条对话现在那一份：换了转录（重绑 / 分叉）之后一律拒绝。
		if (source.sessionFile && (!liveFile || normalizePathKey(liveFile) !== normalizePathKey(source.sessionFile)))
			return undefined;
		const facts = factsOf(conv, options);
		if (!facts) return undefined;
		return port.read({ source, conversation: facts }, signal);
	}
	// 没开着的对话只能按转录文件读磁盘历史；连文件都没给 = 无从下手。
	if (!source.sessionFile) return undefined;
	return port.read({ source }, signal);
}
