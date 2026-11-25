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
	type DisplaceRetainFacts,
	createSessionForks,
	createSessionPins,
	createSessionRollbacks,
	mergePinState,
	type SessionEntityHandlers,
	type SessionForkHandlers,
	type SessionPinsHandlers,
	type SessionRollbackHandlers,
} from "../domains/sessions/index.js";
import { displacePrevious, rebindSession, type RebindFrames } from "../domains/sessions/rebind.js";
import { createRetainOnDisplace } from "../domains/sessions/retain.js";
import { createWorkspaceSwitcher } from "../domains/sessions/workspace.js";
import { findMostRecentSessionFileFast } from "../session-parser.js";
import { resolveWorkspaceSessionDir } from "../remote-workspace.js";
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
	/** 跨客户端会话占用查询 */
	/** 跨客户端会话占用查询（带占用者身份：自动过户要用）。 */
	findSessionOwner?: (
		sessionFile: string,
	) => { title: string; isStreaming: boolean; clientId: string; conversationId: string } | undefined;
	/** 别处开着且没在跑 → 过户到本页（老实现 `switchSession` 的 `takeOverConversationElsewhere`）。 */
	takeOverElsewhere?(owner: { clientId: string; conversationId: string }): Promise<void>;
	progress?(kind: "cwd" | "session", target: string, phase: "done" | "error", text: string, textEn: string): void;
	/** 换完工作区后重列文件树（文件域的实现自己发 `files` 帧）；缺省 = 不重列。 */
	refreshFiles?(): void | Promise<void>;
	/** 某对话当前是否有问卷在等待。 */
	hasQuestionOf?(conversationId: ConversationId): boolean;
	/** 外部运行中行（跨客户端 / 离线行）。 */
	elsewhere?(): readonly import("../protocol.js").ElsewhereRunning[];
	/** 客户端通道是否已关（关了就只算账不出帧）。 */
	isClosed(): boolean;
	/**
	 * 换活动对话时「保留还是退役」里宿主才知道的那几项（子代理运行 / 等唤醒订阅 / 在跑的后台任务 /
	 * 终端 / 目标评审 / 问卷 / 投递在飞）。判据仍归 `domains/sessions/retain.ts`，这里只交证据；
	 * 缺项 = 不知道（按 false 处理，老口径同）。
	 */
	retainEvidence?(conversation: Conversation): Partial<DisplaceRetainFacts>;
	/**
	 * 消息已受理、这一轮还没真正开始（老 `conv.promptInFlight` 的内核对应）：
	 * 运行时在 `feedTurn` 的 `ensure` 窗口里记住它。没有这一位，「刚点了发送就切对话」会把那条
	 * 对话退役掉——在飞的消息随之丢失；老实现正是靠 `promptInFlight` 保留它的。
	 */
	turnInFlight?(conversationId: ConversationId): boolean;
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
	/**
	 * 活动对话换了、且它的工作区与当前不同：把工作区跟过去（不重绑会话）。
	 * 对应老 `switchConversation` 的 `applyCwdSideEffects`：根取存储、宿主收尾、项目/会话帧、重列文件。
	 */
	followActiveProject(): void;
}

export interface SessionConversations {
	/** 推一帧 `conversations`：钉住变了、激活变了、轮次结算了都要推。 */
	push(): void;
	/** 标记对话已列入运行列表。 */
	markListed(id: string): void;
	/** 标记「用户真的用过它」（历史打开 / 喂过轮）：老 `promptedSinceActive`，保留判据的一半。 */
	markPrompted(id: string): void;
	/** 已经在运行列表里（老 `conv.listed`）：移出当前对话时挑继任者读这一位。 */
	isListed(id: string): boolean;
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
	/**
	 * 换活动对话时的保留判定（老 `displaceActive` → `isRetainedOnDisplace`）：判据单源在
	 * `domains/sessions/retain.ts`，这里只喂「只有装配层拿得到」的事实。
	 * 故意不传的几项（宿主才有）：`reviewing` / `wizardRunning`（目标/问卷域）、`promptInFlight`
	 * （`server/conversation-delivery.ts`）、`compacting`（宿主 `session.isCompacting`）、
	 * `openTerminals`（终端叶子）、
	 * `hasActiveSubagentRun` / `hasPendingWake` / `hasRunningBackgroundTask`（`wait-subscription-scan`）。
	 * 缺失 = false，与老口径「没在跑就不保留」一致。
	 */
	/** 宿主证据是**逐对话**的：每次判定都现问（缓存住会让「刚跑完」的对话被一直当在跑）。 */
	const evidenceOf = (conv: Conversation): Partial<DisplaceRetainFacts> => {
		try {
			return options.retainEvidence?.(conv) ?? {};
		} catch {
			// 宿主扫描抛错 = 不知道；不能让一次扫盘失败把「保留」判成「退役」。
			return {};
		}
	};
	const shouldRetainPrevious = createRetainOnDisplace(registry, {
		nativeCli: (conv) => options.nativeCliOf?.(conv.id) !== undefined,
		hasActiveSubagentRun: (conv) => evidenceOf(conv).hasActiveSubagentRun,
		hasPendingWake: (conv) => evidenceOf(conv).hasPendingWake,
		hasRunningBackgroundTask: (conv) => evidenceOf(conv).hasRunningBackgroundTask,
		openTerminals: (conv) => evidenceOf(conv).openTerminals,
		reviewing: (conv) => evidenceOf(conv).reviewing,
		wizardRunning: (conv) => evidenceOf(conv).wizardRunning,
		promptInFlight: (conv) => evidenceOf(conv).promptInFlight ?? options.turnInFlight?.(conv.id),
		streaming: (conv) => evidenceOf(conv).streaming,
		started: (conv) =>
			pinIndex.stateOf(conv.id)?.listed === true || (options.sessions?.get(conv.id)?.session.messages?.length ?? 0) > 0,
		keepsFinished: () => options.store?.()?.getSettingsSnapshot(options.clientId).retainFinishedConversations === true,
		pinned: (conv) => pinIndex.isPinned(conv.id),
		listed: (conv) => pinIndex.stateOf(conv.id)?.listed === true,
		// 老判据的最后一条：`listed && promptedSinceActive`。没有这一位，从历史打开的对话在
		// 换对话 / 新建对话时会被退役 —— 切回来只能从盘上重开，已展开的历史窗口就丢了。
		promptedSinceActive: (conv) => pinIndex.stateOf(conv.id)?.prompted === true,
	});
	const markListed = (id: ConversationId): void => pinIndex.markListed(id);
	const markPrompted = (id: ConversationId): void => pinIndex.markPrompted(id);
	/** 腾位时说一句「为什么留着」用：宿主证据优先，拿不到就用内核自己的在飞账。 */
	const inFlightOf = (conv: Conversation): boolean =>
		evidenceOf(conv).promptInFlight ?? options.turnInFlight?.(conv.id) === true;
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
				...(options.hasQuestionOf?.(conv.id) ? { hasQuestion: true } : {}),
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
		const elsewhere = options.elsewhere?.() ?? [];
		return {
			conversations: facts(list),
			activeId: registry.activeId(),
			stateOf,
			...(elsewhere.length > 0 ? { elsewhere } : {}),
		};
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
		shouldRetainPrevious,
		markListed,
		markPrompted,
		notice: options.notice,
		inFlight: inFlightOf,
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
			shouldRetainPrevious,
			markListed,
			markPrompted,
			// 老 `setCwd` 的 `openRecent`（设置项缺省 true）。
			openRecentSession: () => store.getSettingsSnapshot(options.clientId).openRecentSessionOnProjectSwitch === true,
			// 会话目录布局只在装配层拼（与 `app/engine-elsewhere.ts` 同一口径）。
			mostRecentSession: (cwd) => findMostRecentSessionFileFast(resolveWorkspaceSessionDir(store.dataDir, cwd), cwd),
			...(options.findSessionOwner ? { sessionOwner: options.findSessionOwner } : {}),
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
				markListed,
				markPrompted,
				displace: (conversation) =>
					void displacePrevious(
						{
							registry,
							sessions: sessionsOf(),
							shouldRetainPrevious,
							markListed,
							notice: options.notice,
							inFlight: inFlightOf,
						},
						conversation,
					),
				frames: options.frames,
				cwd: () => registry.activeConv()?.meta.cwd ?? options.cwd(),
				...(options.isAllowedPath ? { isAllowedPath: options.isAllowedPath } : {}),
				openSessionIdOf: (conversationId) => options.sessions?.get(conversationId)?.sessionId,
				...(options.noteSessionFile ? { noteSessionFile: options.noteSessionFile } : {}),
				notice: options.notice,
				...(options.findSessionOwner ? { findSessionOwner: options.findSessionOwner } : {}),
				...(options.takeOverElsewhere ? { takeOverElsewhere: options.takeOverElsewhere } : {}),
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

		conversations: () => ({
			push: pushConversations,
			markListed,
			markPrompted,
			isListed: (id: string) => pinIndex.isListed(id),
		}),

		/**
		 * 跨项目切对话只跟工作区，**不**走重绑（目标会话已经开着，重绑会把它拆了）。
		 * 老实现在这里做四件事：`roots` 重取、`onCwdChanged`、项目/会话帧、`listFiles`。
		 * 帧顺序：先切状态再出帧（否则客户端先看到「新对话 + 旧目录」，下一帧又会被合并闸吞掉）。
		 */
		followActiveProject: (): void => {
			const conv = registry.activeConv();
			const next = conv?.meta.cwd;
			if (!next || next === options.cwd()) return;
			const store = options.store?.();
			const roots = store ? store.getWorkspaceRoots(options.clientId, next) : options.roots();
			options.setWorkspace(next, roots);
			// 宿主收尾（插件 cwd / 额外根通知）：失败不影响切换，也不挡住出帧。
			void Promise.resolve(options.workspaceHost?.()?.onChanged?.(next, roots)).catch(() => undefined);
			void options.frames.pushProjects?.();
			void options.frames.refreshSessionsFor?.(next);
			void options.refreshFiles?.();
		},

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
