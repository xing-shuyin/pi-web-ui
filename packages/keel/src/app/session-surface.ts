import type { ClientId, ConversationId, SessionFile } from "../contracts/ids.js";
import { CoreEngineNotReadyError } from "../contracts/core-engine-errors.js";
import type { WorkspacePort } from "../contracts/files.js";
import type { SandboxPort } from "../contracts/sandbox.js";
import type { SettingsStorePort } from "../contracts/settings-store.js";
import type { WorkspaceHostPort } from "../contracts/workspace.js";
import type { Conversation, ConversationKind, ConversationRegistry } from "../kernel/conversation/index.js";
import { createSessionEntityHandlers, type SessionEntityHandlers } from "../domains/sessions/entity.js";
import { createSessionPins, type SessionPinsHandlers } from "../domains/sessions/pins.js";
import { rebindSession, type RebindFrames } from "../domains/sessions/rebind.js";
import { createWorkspaceSwitcher } from "../domains/sessions/workspace.js";
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
	/** 允许打开哪些转录（缺省 fail-closed）。 */
	isAllowedPath?(path: string): boolean;
	notice(level: "info" | "warning" | "error", text: string, textEn: string): void;
	progress?(kind: "cwd" | "session", target: string, phase: "done" | "error", text: string, textEn: string): void;
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
	/** 沙盒 7 个。 */
	sandbox(): SandboxHandlers;
}

/**
 * 会话实体重绑面的装配：老树把这段（约 200 行）绑在 `ClientSession` 上，这里单独一处，
 * 让 `ClientRuntime` 只留「谁来调用」，不再跟着长。
 *
 * 四个入口（换目录 / 切会话 / 沙盒迁移 / 换工作树）共用 `rebindSession` 一份原语。
 */
export function createSessionSurface(options: SessionSurfaceOptions): SessionSurface {
	const registry = options.registry;
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
				refreshSessionsFor: (cwd) => (options.isClosed() ? undefined : options.frames.refreshSessionsFor?.(cwd)),
			})),

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
