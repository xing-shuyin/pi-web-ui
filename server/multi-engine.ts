import { isNativeCliEngineId } from "./engine-catalog.js";
import type { DispatchSession, EngineService } from "./engine-service.js";
import type {
	ClientMessage,
	ConversationSummary,
	ElsewhereRunning,
	EngineId,
	ProjectSummary,
	ServerMessage,
	SessionSummary,
} from "./protocol.js";

const CLI_OVERLAY_FRAME_TYPES = new Set<ServerMessage["type"]>([
	"snapshot",
	"snapshot_delta",
	"earlier_messages",
	"tool_delta",
	"message_delta",
	"terminal_output",
	"terminal_list",
	"terminal_exit",
	"native_cli_event",
	"native_cli_prompt_submitted",
	"terminal_cli_paste_result",
	"new_chat_result",
]);

function normalizePathKey(p: string | undefined): string {
	if (!p) return "";
	return p.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

interface AttachedEngine {
	engine: EngineId;
	service: EngineService;
	cs?: DispatchSession;
	readyPromise: Promise<DispatchSession>;
	sink: (msg: ServerMessage) => void;
}

interface StoredConversations {
	conversations: ConversationSummary[];
	activeId: string;
	elsewhere?: ElsewhereRunning[];
}

interface StoredSessions {
	engine: EngineId;
	cwdKey: string;
	cwd?: string;
	sessions: SessionSummary[];
	hasMore?: boolean;
}

export interface MultiEngineBrokerOptions {
	clientId: string;
	initialEngine: EngineId;
	allEngines: readonly EngineId[];
	ensureEngine: (engine: EngineId) => EngineService;
	probeEngine: (engine: EngineId, force?: boolean) => Promise<{ installed: boolean; packageName?: string }>;
	send: (msg: ServerMessage) => boolean | void;
	sendShared: (msg: ServerMessage) => void;
	buildReady: (engine: EngineId) => ServerMessage;
	onEngineChanged: (engine: EngineId) => void;
	onAfterActiveAttach?: (engine: EngineId, cs: DispatchSession) => void;
}

/**
 * 连接级多引擎聚合路由器：
 * - 让所有已安装引擎的运行中对话与历史会话合并展示在同一个列表中（各自标注 `engine`）；
 * - 只有当前活动引擎输出主聊天区帧（`snapshot` / `models` / `settings` 等）；
 * - 新建、切换、删除对话/历史时自动路由到对应引擎，无需用户手动切全局引擎。
 */
export class MultiEngineBroker {
	private activeEngine: EngineId;
	private cliOverlayActive = false;
	private disposed = false;
	private switchSeq = 0;
	private bgMountPromise: Promise<void> | null = null;
	private readonly attached = new Map<EngineId, AttachedEngine>();
	private readonly conversationsByEngine = new Map<EngineId, StoredConversations>();
	private readonly projectsByEngine = new Map<EngineId, ProjectSummary[]>();
	private readonly sessionsByKey = new Map<string, StoredSessions>();
	private readonly convEngineMap = new Map<string, EngineId>();
	private readonly sessionEngineMap = new Map<string, EngineId>();
	private readonly needsFullSnapshot = new Set<EngineId>();
	private readonly nativeCliConvIds = new Set<string>();
	private readonly nativeCliSessionKeys = new Set<string>();
	private readonly requestedProjectPaths = new Set<string>();

	constructor(private readonly options: MultiEngineBrokerOptions) {
		this.activeEngine = options.initialEngine;
	}

	getActiveEngine(): EngineId {
		return this.activeEngine;
	}

	getActiveSession(): DispatchSession | undefined {
		const engine = this.cliOverlayActive ? "pi" : this.activeEngine;
		return this.attached.get(engine)?.cs;
	}

	async attachInitial(): Promise<DispatchSession> {
		const cs = await this.ensureAttached(this.activeEngine);
		this.bgMountPromise = this.mountBackgroundEngines();
		return cs;
	}

	/** 安装新引擎后即时挂载到当前连接，无需重启服务。 */
	async refreshInstalledEngines(): Promise<void> {
		const p = this.mountBackgroundEngines();
		this.bgMountPromise = p;
		await p;
	}

	private async mountBackgroundEngines(): Promise<void> {
		// 让出宏任务，避免与首屏渲染和初始活动引擎争夺 CPU/IO
		await new Promise<void>((r) => setTimeout(r, 0));
		if (this.disposed) return;
		const activeCwd = this.getActiveSession()?.cwd;
		const others = this.options.allEngines.filter((e) => e !== this.activeEngine);
		const mountOne = async (engine: EngineId): Promise<void> => {
			if (this.disposed || this.attached.has(engine)) return;
			try {
				if (engine !== "pi") {
					const probe = await this.options.probeEngine(engine);
					if (!probe.installed) return;
				}
				if (this.disposed || this.attached.has(engine)) return;
				const cs = await this.ensureAttached(engine);
				if (this.disposed) return;
				void cs.pushProjects();
				void cs.refreshSessions();
				const seenCwdKeys = new Set<string>();
				const csCwdKey = normalizePathKey(cs.cwd);
				if (csCwdKey) seenCwdKeys.add(csCwdKey);
				const pushCwdOnce = (cwd: string | undefined) => {
					const key = normalizePathKey(cwd);
					if (!key || seenCwdKeys.has(key)) return;
					seenCwdKeys.add(key);
					void cs.pushSessionsForCwd?.(cwd!);
				};
				pushCwdOnce(activeCwd);
				for (const reqPath of this.requestedProjectPaths) {
					pushCwdOnce(reqPath);
				}
			} catch {}
		};
		const BG_CONCURRENCY = 2;
		for (let i = 0; i < others.length; i += BG_CONCURRENCY) {
			if (this.disposed) return;
			await Promise.all(others.slice(i, i + BG_CONCURRENCY).map(mountOne));
		}
	}

	ensureAttached(engine: EngineId): Promise<DispatchSession> {
		const existing = this.attached.get(engine);
		if (existing) return existing.readyPromise;
		const service = this.options.ensureEngine(engine);
		const sink = (msg: ServerMessage) => this.handleEngineFrame(engine, msg);
		const entry: AttachedEngine = {
			engine,
			service,
			sink,
			readyPromise: service.attach(this.options.clientId, sink, this.options.sendShared).then((cs) => {
				if (this.disposed) {
					try {
						service.detach(this.options.clientId, sink);
					} catch {}
					return cs;
				}
				entry.cs = cs;
				return cs;
			}),
		};
		this.attached.set(engine, entry);
		return entry.readyPromise;
	}

	private handleEngineFrame(engine: EngineId, msg: ServerMessage): void {
		if (this.disposed) return;
		if (msg.type === "conversations") {
			const tagged: ConversationSummary[] = msg.conversations.map((c) => ({ ...c, engine }));
			this.conversationsByEngine.set(engine, {
				conversations: tagged,
				activeId: msg.activeId,
				...(msg.elsewhere ? { elsewhere: msg.elsewhere } : {}),
			});
			for (const [id, owner] of this.convEngineMap.entries()) {
				if (owner === engine) this.convEngineMap.delete(id);
			}
			for (const c of tagged) {
				this.convEngineMap.set(c.id, engine);
			}
			if (engine === "pi") {
				this.nativeCliConvIds.clear();
				for (const c of tagged) {
					if (c.nativeCli) this.nativeCliConvIds.add(c.id);
				}
			}
			this.emitMergedConversations();
			return;
		}
		if (msg.type === "projects") {
			this.projectsByEngine.set(engine, msg.projects);
			this.emitMergedProjects();
			return;
		}
		if (msg.type === "sessions") {
			const activeCs = this.getActiveSession();
			const rawCwd = msg.cwd ?? this.attached.get(engine)?.cs?.cwd ?? activeCs?.cwd;
			const cwdKey = normalizePathKey(rawCwd);
			const tagged: SessionSummary[] = msg.sessions.map((s) => ({ ...s, engine }));
			const key = `${engine}:${cwdKey}`;
			this.sessionsByKey.set(key, {
				engine,
				cwdKey,
				...(rawCwd ? { cwd: rawCwd } : {}),
				sessions: tagged,
				...(msg.hasMore ? { hasMore: true } : {}),
			});
			for (const s of tagged) {
				const pathKey = normalizePathKey(s.path);
				if (pathKey) this.sessionEngineMap.set(pathKey, engine);
				if (s.sessionId) this.sessionEngineMap.set(s.sessionId, engine);
				if (engine === "pi") {
					if (s.nativeCli) {
						if (pathKey) this.nativeCliSessionKeys.add(pathKey);
						if (s.sessionId) this.nativeCliSessionKeys.add(s.sessionId);
					} else {
						if (pathKey) this.nativeCliSessionKeys.delete(pathKey);
						if (s.sessionId) this.nativeCliSessionKeys.delete(s.sessionId);
					}
				}
			}
			this.emitMergedSessions(cwdKey, rawCwd);
			return;
		}
		if (this.cliOverlayActive && CLI_OVERLAY_FRAME_TYPES.has(msg.type)) {
			if (engine === "pi") this.options.send(msg);
			return;
		}
		if (engine === this.activeEngine) {
			if (msg.type === "snapshot") {
				this.needsFullSnapshot.delete(engine);
			} else if (msg.type === "snapshot_delta" && this.needsFullSnapshot.has(engine)) {
				this.needsFullSnapshot.delete(engine);
				const cs = this.attached.get(engine)?.cs;
				if (cs?.flushSnapshot) {
					cs.flushSnapshot(true);
					return;
				}
			}
			this.options.send(msg);
		} else if (msg.type === "notice" && msg.level === "error") {
			this.options.send(msg);
		}
	}

	private emitMergedConversations(): void {
		const merged: ConversationSummary[] = [];
		const elsewhere: ElsewhereRunning[] = [];
		for (const engine of this.options.allEngines) {
			const stored = this.conversationsByEngine.get(engine);
			if (!stored) continue;
			merged.push(...stored.conversations);
			if (stored.elsewhere) elsewhere.push(...stored.elsewhere);
		}
		const activeId = this.cliOverlayActive
			? (this.conversationsByEngine.get("pi")?.activeId ?? "")
			: (this.conversationsByEngine.get(this.activeEngine)?.activeId ?? "");
		merged.sort((a, b) => {
			if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
			return (b.modified ?? 0) - (a.modified ?? 0);
		});
		this.options.send({
			type: "conversations",
			conversations: merged,
			activeId,
			...(elsewhere.length > 0 ? { elsewhere } : {}),
		});
	}

	private emitMergedProjects(): void {
		const byPath = new Map<string, ProjectSummary>();
		for (const list of this.projectsByEngine.values()) {
			for (const p of list) {
				const key = normalizePathKey(p.path);
				if (!key) continue;
				const prev = byPath.get(key);
				if (!prev) {
					byPath.set(key, p);
				} else {
					byPath.set(key, {
						path: prev.path || p.path,
						lastUsed: Math.max(prev.lastUsed ?? 0, p.lastUsed ?? 0),
						...(prev.name || p.name ? { name: prev.name ?? p.name } : {}),
						...(prev.sandbox || p.sandbox ? { sandbox: prev.sandbox ?? p.sandbox } : {}),
					});
				}
			}
		}
		const merged = Array.from(byPath.values()).sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
		this.options.send({ type: "projects", projects: merged });
	}

	private emitMergedSessions(cwdKey: string, cwd?: string): void {
		const merged: SessionSummary[] = [];
		let hasMore = false;
		let resolvedCwd = cwd;
		for (const entry of this.sessionsByKey.values()) {
			if (entry.cwdKey !== cwdKey) continue;
			if (!resolvedCwd && entry.cwd) resolvedCwd = entry.cwd;
			if (entry.hasMore) hasMore = true;
			merged.push(...entry.sessions);
		}
		merged.sort((a, b) => {
			if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
			return (b.modified ?? 0) - (a.modified ?? 0);
		});
		this.options.send({
			type: "sessions",
			sessions: merged,
			...(resolvedCwd ? { cwd: resolvedCwd } : {}),
			...(hasMore ? { hasMore: true } : {}),
		});
	}

	async switchActiveEngine(targetEngine: EngineId, opts?: { skipSnapshot?: boolean }): Promise<DispatchSession | null> {
		if (this.disposed) return null;
		const wasCliOverlay = this.cliOverlayActive;
		this.cliOverlayActive = false;
		if (targetEngine === this.activeEngine) {
			const cs = await this.ensureAttached(targetEngine);
			if (wasCliOverlay) {
				this.needsFullSnapshot.add(targetEngine);
				if (!opts?.skipSnapshot) {
					this.options.onAfterActiveAttach?.(targetEngine, cs);
				}
				this.emitMergedConversations();
			}
			return cs;
		}
		if (targetEngine !== "pi" && !this.attached.has(targetEngine)) {
			let probe = await this.options.probeEngine(targetEngine, false);
			if (!probe.installed) {
				probe = await this.options.probeEngine(targetEngine, true);
			}
			if (!probe.installed) {
				this.options.send({
					type: "notice",
					level: "warning",
					text: `引擎 ${targetEngine.toUpperCase()} 尚未安装（${probe.packageName ?? targetEngine}），请先安装后再使用`,
					textEn: `Engine ${targetEngine.toUpperCase()} (${probe.packageName ?? targetEngine}) is not installed; please install it first`,
				});
				return null;
			}
		}
		const seq = ++this.switchSeq;
		this.activeEngine = targetEngine;
		this.needsFullSnapshot.add(targetEngine);
		this.options.onEngineChanged(targetEngine);
		const cs = await this.ensureAttached(targetEngine);
		if (this.disposed || seq !== this.switchSeq) return null;
		this.options.send(this.options.buildReady(targetEngine));
		if (!opts?.skipSnapshot) {
			this.options.onAfterActiveAttach?.(targetEngine, cs);
		} else {
			cs.pushSettings?.();
			void cs.listModels?.();
		}
		this.emitMergedConversations();
		return cs;
	}

	resolveSessionEngine(path: string, sessionId?: string, explicit?: unknown): EngineId | undefined {
		if (isNativeCliEngineId(explicit)) return explicit;
		const byPath = this.sessionEngineMap.get(normalizePathKey(path));
		if (byPath) return byPath;
		if (sessionId) return this.sessionEngineMap.get(sessionId);
		return undefined;
	}

	resolveConversationEngine(id: string, explicit?: unknown): EngineId | undefined {
		if (isNativeCliEngineId(explicit)) return explicit;
		return this.convEngineMap.get(id);
	}

	/**
	 * 拦截并路由与跨引擎相关联的客户端消息：
	 * - 返回 `handled: true` 表示已在此完成全部处理；
	 * - 返回 `handled: false, targetCs` 表示需要继续走标准的 `dispatchClientMessage(msg, targetCs)`。
	 */
	async routeMessage(
		msg: ClientMessage,
	): Promise<{ handled: boolean; targetCs?: DispatchSession; targetService?: EngineService }> {
		if (this.disposed) return { handled: true };
		const withService = (engine: EngineId, cs: DispatchSession) => ({
			handled: false,
			targetCs: cs,
			targetService: this.attached.get(engine)?.service,
		});
		if (msg.type === "new_chat") {
			this.cliOverlayActive = false;
			const targetEngine = isNativeCliEngineId(msg.engine) ? msg.engine : this.activeEngine;
			const cs = await this.switchActiveEngine(targetEngine, { skipSnapshot: true });
			return cs ? withService(targetEngine, cs) : { handled: true };
		}
		if (msg.type === "new_cli_chat") {
			this.cliOverlayActive = true;
			const cs = await this.ensureAttached("pi");
			this.emitMergedConversations();
			return withService("pi", cs);
		}
		if (msg.type === "switch_conversation") {
			if (this.nativeCliConvIds.has(msg.id)) {
				this.cliOverlayActive = true;
				const cs = await this.ensureAttached("pi");
				this.emitMergedConversations();
				return withService("pi", cs);
			}
			const wasCliOverlay = this.cliOverlayActive;
			this.cliOverlayActive = false;
			const targetEngine = this.resolveConversationEngine(msg.id, msg.engine);
			if (targetEngine && targetEngine !== this.activeEngine) {
				const cs = await this.switchActiveEngine(targetEngine, { skipSnapshot: true });
				return cs ? withService(targetEngine, cs) : { handled: true };
			}
			const cs = await this.ensureAttached(this.activeEngine);
			if (wasCliOverlay) this.emitMergedConversations();
			return withService(this.activeEngine, cs);
		}
		if (msg.type === "switch_session") {
			const pathKey = normalizePathKey(msg.path);
			const isCliSession =
				(pathKey && this.nativeCliSessionKeys.has(pathKey)) ||
				Boolean(msg.sessionId && this.nativeCliSessionKeys.has(msg.sessionId));
			if (isCliSession) {
				this.cliOverlayActive = true;
				const cs = await this.ensureAttached("pi");
				this.emitMergedConversations();
				return withService("pi", cs);
			}
			const wasCliOverlay = this.cliOverlayActive;
			this.cliOverlayActive = false;
			const targetEngine = this.resolveSessionEngine(msg.path, msg.sessionId, msg.engine);
			if (targetEngine && targetEngine !== this.activeEngine) {
				const cs = await this.switchActiveEngine(targetEngine, { skipSnapshot: true });
				return cs ? withService(targetEngine, cs) : { handled: true };
			}
			const cs = await this.ensureAttached(this.activeEngine);
			if (wasCliOverlay) this.emitMergedConversations();
			return withService(this.activeEngine, cs);
		}
		if (msg.type === "dismiss_conversation" || msg.type === "rename_conversation" || msg.type === "pin_conversation") {
			const owner = this.convEngineMap.get(msg.id);
			if (owner && owner !== this.activeEngine) {
				const cs = await this.ensureAttached(owner);
				return withService(owner, cs);
			}
		}
		if (msg.type === "delete_session" || msg.type === "rename_session" || msg.type === "pin_session") {
			const owner = this.sessionEngineMap.get(normalizePathKey(msg.path));
			if (owner && owner !== this.activeEngine) {
				const cs = await this.ensureAttached(owner);
				return withService(owner, cs);
			}
		}
		if (msg.type === "list_sessions") {
			if (msg.path) this.requestedProjectPaths.add(msg.path);
			if (this.bgMountPromise) await this.bgMountPromise.catch(() => {});
			const activeCs = await this.ensureAttached(this.activeEngine);
			const targets = Array.from(this.attached.values())
				.map((a) => a.cs)
				.filter((c): c is DispatchSession => Boolean(c));
			await Promise.all(
				targets.map(async (cs) => {
					if (typeof msg.limit === "number") cs.setSessionListLimit?.(msg.path ?? cs.cwd, msg.limit);
					if (msg.path && normalizePathKey(msg.path) !== normalizePathKey(cs.cwd)) {
						await cs.pushSessionsForCwd?.(msg.path);
					} else {
						await cs.refreshSessions();
					}
				}),
			);
			if (targets.length === 0) await activeCs.refreshSessions();
			return { handled: true };
		}
		if (msg.type === "set_cwd") {
			const activeCs = await this.ensureAttached(this.activeEngine);
			return { handled: false, targetCs: activeCs };
		}
		if (msg.type === "remove_project") {
			const activeCs = await this.ensureAttached(this.activeEngine);
			for (const entry of this.attached.values()) {
				if (entry.engine !== this.activeEngine && entry.cs) {
					void entry.cs.removeProject(msg.path).catch(() => {});
				}
			}
			return { handled: false, targetCs: activeCs };
		}
		if (msg.type === "rename_project") {
			const activeCs = await this.ensureAttached(this.activeEngine);
			return { handled: false, targetCs: activeCs };
		}
		return { handled: false, targetCs: await this.ensureAttached(this.activeEngine) };
	}

	dispose(): void {
		this.disposed = true;
		for (const entry of this.attached.values()) {
			try {
				entry.service.detach(this.options.clientId, entry.sink);
			} catch {}
		}
		this.attached.clear();
		this.conversationsByEngine.clear();
		this.projectsByEngine.clear();
		this.sessionsByKey.clear();
		this.convEngineMap.clear();
		this.sessionEngineMap.clear();
		this.requestedProjectPaths.clear();
	}
}
