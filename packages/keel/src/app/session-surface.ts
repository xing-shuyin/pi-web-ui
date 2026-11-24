import type { ClientId, ConversationId, SessionFile } from "../contracts/ids.js";
import { CoreEngineNotReadyError } from "../contracts/core-engine-errors.js";
import type { ForkEvidencePort } from "../contracts/fork.js";
import type { TransportPort } from "../contracts/ports.js";
import type { MessageEditSession } from "../contracts/turns.js";
import type { WorkspacePort } from "../contracts/files.js";
import type { SandboxPort } from "../contracts/sandbox.js";
import type { SettingsStorePort } from "../contracts/settings-store.js";
import type { WorkspaceHostPort } from "../contracts/workspace.js";
import type { Conversation, ConversationKind, ConversationRegistry } from "../kernel/conversation/index.js";
import { createSessionEditor, type EditSessionHost } from "../adapters/sdk/session-edits.js";
import { createBranchFile } from "../adapters/sdk/session-opener.js";
import {
	pushConversations as pushConversationsFrame,
	type ConversationFrameFact,
	type ConversationsFrameInput,
} from "../domains/history/frame.js";
import {
	ConversationPinIndex,
	createSessionEntityHandlers,
	createSessionForks,
	createSessionPins,
	createSessionRollbacks,
	mergePinState,
	type SessionEntityHandlers,
	type SessionForkHandlers,
	type SessionPinsHandlers,
	type SessionRollbackHandlers,
} from "../domains/sessions/index.js";
import { rebindSession, type RebindFrames } from "../domains/sessions/rebind.js";
import { createWorkspaceSwitcher } from "../domains/sessions/workspace.js";
import { findTurnBaseEntryId, resolveEntry, undeletedContextEntries } from "../domains/turns/entries.js";
import { createSandboxHandlers, type SandboxHandlers } from "../domains/sandbox/index.js";
import type { SessionRegistry } from "./session-registry.js";

/** 重绑需要「开一份 / 释放一份」会话；缺省 = 会话实体未接（handler 同步抛）。 */
export interface SessionSurfaceSessions {
	ensure(conversation: Conversation, options?: { cwd?: string }): Promise<unknown>;
	close(conversationId: ConversationId): void;
	sessionIdOf?(conversationId: ConversationId): string | undefined;
}

export interface SessionSurfaceOptions {
	clientId: ClientId;
	registry: ConversationRegistry<Conversation>;
	/** 会话实体（SDK）；缺省 = 重绑/切会话/沙盒迁移全部视为未接。 */
	sessions?: SessionRegistry;
	/** 设置存储（额外根持久化 + 钉住）；缺省 = 这两项未接。 */
	store?: () => SettingsStorePort | undefined;
	/** 宿主工作区面（目标解析 + 收尾）；缺省 = 只认本地路径。 */
	workspaceHost?: () => WorkspaceHostPort | undefined;
	/** 沙盒面；缺省 = 该能力未接。 */
	sandbox?: () => SandboxPort | undefined;
	/** 出帧通道（`conversations` 帧要真发出去）；缺省 = 只算内存态、不出帧。 */
	transport?: () => TransportPort | undefined;
	/** 外置证据搬运（宿主 `context-evidence`）；缺省 = 派生时只搬转录本体。 */
	evidence?: () => ForkEvidencePort | undefined;
	/** 当前工作区与额外根（换工作区会就地改它们）。 */
	cwd(): string;
	roots(): readonly string[];
	setWorkspace(cwd: string, roots: readonly string[]): void;
	createConversation(
		init: Partial<{
			cwd: string;
			sessionFile: SessionFile;
			kind: ConversationKind;
			parentId: ConversationId;
			title: string;
		}>,
	): Conversation;
	/** 全量刷一帧 + 会话/项目帧。 */
	frames: RebindFrames & { refreshSessionsFor?(cwd: string): Promise<void> };
	/** 活动对话换了：出帧基线与增量缓存要跟着换。 */
	onActivated(conversationId: ConversationId): void;
	/** 打开转录后把「历史根」告给帧层。 */
	noteSessionFile?(file: string | undefined): void;
	/** CLI 对话的实时投影（配置 / 终端 id / 状态）：`conversations` 帧用它把运行中的 CLI 行画对。 */
	nativeCliOf?(conversationId: ConversationId): import("../protocol.js").NativeCliConversation | undefined;
	/** 允许打开哪些转录（缺省 fail-closed）。 */
	isAllowedPath?(path: string): boolean;
	notice(level: "info" | "warning" | "error", text: string, textEn: string): void;
	progress?(kind: "cwd" | "session", target: string, phase: "done" | "error", text: string, textEn: string): void;
	/** 换完工作区后重列文件树（文件域的实现自己发 `files` 帧）；缺省 = 不重列。 */
	refreshFiles?(): void | Promise<void>;
	/** 客户端通道是否已关（关了就只算账不出帧）。 */
	isClosed(): boolean;
}

export interface SessionSurface {
	/** 工作区绑定面的内核实现（沙盒 / 工作树 / 建目录共用这一份）。 */
	workspace(): WorkspacePort;
	/** `switchSession`。 */
	entity(): SessionEntityHandlers;
	/** `pinSession` / `setConversationPinned`。 */
	pins(): SessionPinsHandlers;
	/** `forkSession`：在指定消息处分叉出新会话并切过去。 */
	forks(): SessionForkHandlers;
	/** `rollbackSession`：叶指针改到某条条目 + 重载（不换会话）。 */
	rollbacks(): SessionRollbackHandlers;
	/** `conversations` 帧（钉住 / listed 的内存态就在这里出）。 */
	conversations(): SessionConversations;
	/** 沙盒 7 个。 */
	sandbox(): SandboxHandlers;
}

export interface SessionConversations {
	/** 推一帧 `conversations`：钉住变了、激活变了、轮次结算了都要推。 */
	push(): void;
}

/**
 * 会话实体重绑面的装配：老树把这段（约 200 行）绑在 `ClientSession` 上，这里单独一处，
 * 让 `ClientRuntime` 只留「谁来调用」，不再跟着长。
 *
 * 四个入口（换目录 / 切会话 / 沙盒迁移 / 换工作树）共用 `rebindSession` 一份原语；
 * `forkSession` / `rollbackSession` 也挂在这里（两者都要条目树，入口只能在这层接）。
 */
export function createSessionSurface(options: SessionSurfaceOptions): SessionSurface {
	const registry = options.registry;
	/** 运行列表内存态：钉住面与 `conversations` 帧共用同一份（不能两处各记一套）。 */
	const pinIndex = new ConversationPinIndex();
	/** 已开会话 → 条目树窄面；会话没接时不了（handler 同步抛，不拿半死句柄）。 */
	const editorOf = (conversationId: ConversationId): MessageEditSession | undefined => {
		const opened = options.sessions?.get(conversationId);
		return opened ? createSessionEditor(opened.session as unknown as EditSessionHost) : undefined;
	};
	const entryIdOf = (editor: MessageEditSession, messageId: string): string | undefined =>
		resolveEntry(undeletedContextEntries(editor.contextEntries()), editor.uiIds(), messageId)?.id;
	const baseEntryIdOf = (editor: MessageEditSession, entryId: string): string | null =>
		findTurnBaseEntryId((id) => editor.entry(id), entryId);

	const facts = (list: readonly Conversation[]): ConversationFrameFact[] =>
		list.map((conv) => {
			const opened = options.sessions?.get(conv.id);
			const session = opened?.session;
			const thinkingLevel = typeof session?.thinkingLevel === "string" ? session.thinkingLevel : undefined;
			// CLI 账与状态在宿主那边：非 CLI 对话这里恒为 `undefined`（不编相位）。
			const nativeCli = options.nativeCliOf?.(conv.id);
			return {
				id: conv.id,
				title: conv.meta.title,
				cwd: conv.meta.cwd,
				kind: conv.meta.kind,
				messageCount: Array.isArray(session?.messages) ? session.messages.length : 0,
				isStreaming: session?.isStreaming === true || conv.phase === "running",
				updatedAt: conv.meta.lastActiveAt,
				hasHistoryRow: conv.meta.sessionFile !== undefined,
				...(conv.ephemeral ? { isEphemeral: true } : {}),
				...(nativeCli ? { nativeCli } : {}),
				...(conv.meta.parentId ? { parentId: conv.meta.parentId } : {}),
				...(opened?.sessionId ? { sessionId: opened.sessionId } : {}),
				...(conv.meta.sessionFile ? { sessionFile: conv.meta.sessionFile } : {}),
				...(conv.meta.botId ? { botId: conv.meta.botId } : {}),
				...(conv.meta.botName ? { botName: conv.meta.botName } : {}),
				...(thinkingLevel ? { thinkingLevel } : {}),
			};
		});

	/** 内存态 + 磁盘钉子合流（合流规则只在 `mergePinState` 一处）。 */
	const stateOf = (conversationId: string): ReturnType<typeof mergePinState> => {
		const conv = registry.get(conversationId);
		const store = options.store?.();
		const file = conv?.meta.sessionFile;
		const stored = store && conv && file ? store.isSessionPinned(conv.meta.cwd, file) : false;
		return mergePinState(pinIndex.stateOf(conversationId), stored);
	};

	const conversationFrame = (): ConversationsFrameInput => {
		const list = registry.list();
		// 退役 / 被换掉的对话不再占内存态（只保留磁盘钉子，重开时自动恢复）。
		pinIndex.retain(new Set(list.map((conv) => conv.id)));
		return { conversations: facts(list), activeId: registry.activeId(), stateOf };
	};

	const pushConversations = (): void => {
		const transport = options.transport?.();
		// 通道没接 = 只算内存态（钉住仍然成立），不把「没有出口」当成已经发出去了。
		if (!transport || options.isClosed()) return;
		pushConversationsFrame({ ...conversationFrame(), transport });
	};
	const sessionsOf = (): SessionSurfaceSessions => {
		const sessions = options.sessions;
		if (!sessions) throw new CoreEngineNotReadyError("sessions");
		return {
			ensure: (conversation, init) => sessions.ensure(conversation, init),
			close: (id) => sessions.close(id),
			sessionIdOf: (id) => sessions.get(id)?.sessionId,
		};
	};
	const rebindCtx = () => ({
		registry,
		sessions: sessionsOf(),
		frames: options.frames,
		createConversation: (init: { cwd: string; sessionFile?: SessionFile }) => options.createConversation(init),
		onActivated: options.onActivated,
		notice: options.notice,
	});
	const rebind = async (request: Parameters<typeof rebindSession>[1]) => {
		const result = await rebindSession(rebindCtx(), request);
		// 切转录 = 换工作区（老口径：`switchSession` 之后 `cwd` / 额外根跟着转录 header 走）。
		const store = options.store?.();
		options.setWorkspace(request.cwd, store ? store.getWorkspaceRoots(options.clientId, request.cwd) : options.roots());
		return result;
	};

	let workspace: WorkspacePort | undefined;
	let entity: SessionEntityHandlers | undefined;
	let pins: SessionPinsHandlers | undefined;
	let forks: SessionForkHandlers | undefined;
	let rollbacks: SessionRollbackHandlers | undefined;
	let sandbox: SandboxHandlers | undefined;

	const switcher = (): WorkspacePort => {
		if (workspace) return workspace;
		const store = options.store?.();
		// 额外根无处落盘 / 会话实体没接：整个面视为未接（handler 同步抛，而不是异步 reject）。
		if (!store || !options.sessions) throw new CoreEngineNotReadyError("workspace");
		const host = options.workspaceHost?.();
		workspace = createWorkspaceSwitcher({
			registry,
			sessions: sessionsOf(),
			frames: options.frames,
			createConversation: (init) => options.createConversation(init),
			onActivated: options.onActivated,
			cwd: options.cwd,
			roots: options.roots,
			setWorkspace: options.setWorkspace,
			store: {
				getRoots: (cwd) => store.getWorkspaceRoots(options.clientId, cwd),
				saveRoots: (cwd, roots) => {
					store.saveWorkspaceRoots(options.clientId, cwd, [...(roots ?? [])]);
					return store.getWorkspaceRoots(options.clientId, cwd);
				},
			},
			...(host ? { host } : {}),
			notice: options.notice,
			...(options.progress ? { progress: options.progress } : {}),
			...(options.refreshFiles ? { refreshFiles: options.refreshFiles } : {}),
		});
		return workspace;
	};

	return {
		workspace: () => switcher(),

		entity: () =>
			(entity ??= createSessionEntityHandlers({
				registry,
				rebind,
				frames: options.frames,
				cwd: () => registry.activeConv()?.meta.cwd ?? options.cwd(),
				...(options.isAllowedPath ? { isAllowedPath: options.isAllowedPath } : {}),
				openSessionIdOf: (conversationId) => options.sessions?.get(conversationId)?.sessionId,
				...(options.noteSessionFile ? { noteSessionFile: options.noteSessionFile } : {}),
				notice: options.notice,
				...(options.progress ? { progress: options.progress } : {}),
			})),

		pins: () =>
			(pins ??= createSessionPins({
				registry,
				store: options.store,
				frames: options.frames,
				cwd: options.cwd,
				notice: options.notice,
				pins: pinIndex,
				pushConversations,
				refreshSessionsFor: (cwd) => (options.isClosed() ? undefined : options.frames.refreshSessionsFor?.(cwd)),
			})),

		forks: () =>
			(forks ??= createSessionForks({
				registry,
				rebind,
				...(options.sessions ? { editorOf } : {}),
				entryIdOf,
				baseEntryIdOf,
				// SDK 窄口：派生必须用新开的 manager（否则会把活动会话迁到新文件）。
				createBranchFile,
				...(options.evidence ? { evidence: options.evidence } : {}),
				markListed: (id) => pinIndex.markListed(id),
				flushSnapshot: () => options.frames.flush(false),
				notice: options.notice,
			})),

		rollbacks: () =>
			(rollbacks ??= createSessionRollbacks({
				registry,
				...(options.sessions ? { editorOf } : {}),
				entryIdOf,
				// 重载后：快照与运行列表帧都过期了（消息条数变了）。
				afterReload: pushConversations,
				flushSnapshot: () => options.frames.flush(false),
				notice: options.notice,
			})),

		conversations: () => ({ push: pushConversations }),

		sandbox: () =>
			(sandbox ??= createSandboxHandlers({
				sandbox: options.sandbox,
				workspace: () => switcher(),
				owners: () => ({
					facts: () => registry.list().map((conv) => ({ conversationId: conv.id, cwd: conv.meta.cwd })),
					activeId: () => registry.activeId() || undefined,
					move: async (conversationId, to) => {
						if (!registry.has(conversationId)) return;
						// 迁移 = 把那条对话换成活动对话再走一次工作区重绑（同一份原语，不另写一套）。
						registry.activate(conversationId);
						await switcher().setCwd(to);
					},
				}),
				cwd: () => registry.activeConv()?.meta.cwd ?? options.cwd(),
			})),
	};
}
