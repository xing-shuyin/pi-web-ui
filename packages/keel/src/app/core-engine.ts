import type { DispatchSession, EngineService } from "../engine-service.js";
import type { ElsewhereRunning, ServerMessage } from "../protocol.js";
import { toServiceInfo, launchOrigin } from "../launch-origin.js";
import type { ModelAdminPort } from "../contracts/model-admin.js";
import type { SettingsStorePort } from "../contracts/settings-store.js";
import { QuiesceRejectedError } from "../contracts/quiesce.js";
import type { PluginAgentToolFilter } from "../adapters/tools/plugin-agent-tools.js";
import { PluginToolsBinder } from "./plugin-tools-binder.js";
import { createProjectSource } from "../adapters/state/index.js";
import {
	chatFromPlugin,
	mcpProjectCwds,
	notifyPluginModelChange,
	pickPluginClient,
	readConversationForPlugins,
	refreshMcpProject,
} from "./plugin-engine-hooks.js";
import type {
	PluginChatRequest,
	PluginConversationQuery,
	PluginConversationSnapshot,
	PluginRunEvent,
	PluginToolEvent,
} from "../contracts/plugin.js";
import type { AskUserWaiter } from "../domains/interactions/index.js";
import { DEFAULT_PI_CAPABILITIES } from "../engine-capabilities.js";
import type { AgentEngineCapabilities } from "../protocol.js";
import type { MobileNotificationEvent } from "../mobile-notification-events.js";
import { SubagentRegistry } from "../domains/subagents/registry.js";
import { ClientRuntime } from "./client-runtime.js";
import type { Conversation } from "../kernel/conversation/index.js";
import { CoreEngineNotReadyError } from "../contracts/core-engine-errors.js";
import { resolvePiEngineAttach } from "./engine-mode.js";
import { executeDismissConversation } from "./engine-dismiss.js";
import { resolveServerLang, type ServerLang } from "../i18n.js";
import { saveInterruptedRuns } from "./interrupted-runs.js";
import { activeConversationsOf, pendingMessagesOf, serviceStatusOf } from "./engine-status.js";
import { initializeConnection } from "./connection-init.js";
import {
	applyPluginAgentTools,
	applyPluginCommandCatalog,
	pluginToolFilter,
	refreshBackgroundServers,
	type PluginRefreshHost,
} from "./plugin-refresh.js";
import {
	findSessionOwner,
	checkParallelWork,
	chatFromScheduler,
	releaseSchedulerClient,
} from "./engine-coordination.js";
import {
	armOfflineRowExpiry,
	checkHeldSessionNotice,
	clearOfflineRows,
	handleClientDetach,
	listExternalRunning,
	offlineRowsTtlMs,
} from "./engine-elsewhere.js";
import { findAdoptableOrphan } from "./engine-orphans.js";
import {
	executeTakeOverConversation,
	peekElsewhereQuestion,
	navigateQuestion,
	answerElsewhereQuestion,
	resolveGlobalQuestion,
} from "./engine-takeover.js";
import { isOrphanAdoptionExcludedClientId } from "../client-id-utils.js";
import { assembleClient } from "./client-assembly.js";

export { CoreEngineNotReadyError };
import type { CoreEngineOptions } from "./core-engine-options.js";
export type * from "./core-engine-options.js";

/** 一条连接的帧出口（老实现的 `SinkDeliver`）：只认「往哪条 socket 发」。 */
export type FrameSender = (msg: ServerMessage) => void;

/**
 * 新树的对外门面：只持有 EngineService 的生命周期与按客户端的运行时。
 * 这里禁止出现业务分支——门面里每多一个 `if`，编排就又回到了上帝对象。
 */
export class CoreEngine implements EngineService {
	onQuit?: () => boolean;
	onToolEvent?: ((ev: PluginToolEvent) => void) | undefined;
	onRunEvent?: ((ev: PluginRunEvent) => void) | undefined;
	onConversationChanged?: (() => void) | undefined;
	onClientModelChanged?: ((snap: PluginConversationSnapshot) => void) | undefined;
	onClientCwdChanged?: ((cwd: string, roots: string[]) => void) | undefined;
	private readonly pluginModelKeys = new Map<string, string>();
	/** 手机通知回调：组合根 `wireEngineHooks` 在引擎建好后装上（内核只转发事件，不自己投递）。 */
	onNotificationEvent?: (event: MobileNotificationEvent) => void | Promise<void>;
	/**
	 * 组合根 `wireEngineHooks` 装上的插件级钩子：装了就调、没装就没有。类型直接引用 `EngineService`
	 * 的声明（重写一遍就会长成第二套契约）；显式声明是因为 `implements` 不会把 interface 的可选成员
	 * 带进类类型，不写这几行 `this.toolGuard` 就编译不过（赋值在构造之后，与 `onQuit` 同手法）。
	 */
	toolGuard?: EngineService["toolGuard"];
	pluginToolsProvider?: EngineService["pluginToolsProvider"];
	pluginCommandsProvider?: EngineService["pluginCommandsProvider"];
	pluginBgTasksProvider?: EngineService["pluginBgTasksProvider"];
	pluginStopBgTask?: EngineService["pluginStopBgTask"];
	private readonly runtimes = new Map<string, ClientRuntime>();
	private readonly offlineSince = new Map<string, number>();
	private readonly offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly takeoverFlights = new Map<string, Promise<void>>();
	private readonly askWaiters = new Map<string, AskUserWaiter>();
	private readonly subagentsRegistry = new SubagentRegistry({ now: () => Date.now() });
	/** 语言是「每客户端」的（`client-state` 里按 clientId 存 locale），不是进程级。 */
	private readonly langs = new Map<string, ServerLang>();
	private socketCount = 0;
	private quiescedSince: number | undefined;

	private readonly stateStore: SettingsStorePort;
	private readonly projectSource: ReturnType<typeof createProjectSource>;
	/** 进程级模型/供应商管理面：一次引擎一份（老实现也是进程级），所有客户端共用。 */
	private modelAdmin: ModelAdminPort | undefined;
	/** 每个客户端的帧出口（进程级广播用，如模型/供应商面）：**只放最新的那一个**，重连就换掉。会话帧不走这里，
	 * 走 `deliverTo()` 扇出到该 clientId 此刻活着的**每个** socket（老 `emit()` 扇出到 `sinks` 的口径）。 */
	private readonly senders = new Map<string, FrameSender>();
	/** 每个客户端此刻还活着的 socket（老实现 `sinks` 账）：最后一个走了才拆运行时。 */
	private readonly sockets = new Map<string, Set<FrameSender>>();
	/** 连接期初始态的重推口（老 `attachSink()` 那一次整包推）：重连时原样再跑一次。 */
	private readonly connectFrames = new Map<string, () => void>();
	/** 插件工具与会话的绑定账（开会话时装什么 / 目录变了怎么跟上）：一份账在本进程内，与 runtime 同寿命。 */
	private readonly pluginTools = new PluginToolsBinder(() => this.options.pluginToolSync?.());

	constructor(
		private readonly cwd: string,
		private readonly options: CoreEngineOptions,
	) {
		this.stateStore = options.stateStore;
		this.projectSource = createProjectSource({
			store: options.stateStore,
			...(options.agentDir ? { agentDir: options.agentDir } : {}),
		});
	}

	/** 模型管理面由宿主建（结构性适配器），内核只按窄面调用；没装配就当能力未接。 */ private modelAdminPort():
		ModelAdminPort | undefined {
		if (!this.options.modelAdmin) return undefined;
		this.modelAdmin ??= this.options.modelAdmin({
			emit: (msg) => {
				for (const send of this.senders.values()) send(msg);
			},
			flushSnapshot: () => {
				for (const runtime of this.runtimes.values()) runtime.handlers().flushSnapshot();
			},
			isDisposed: () => this.runtimes.size === 0,
			pushModels: async () => {
				for (const runtime of this.runtimes.values()) runtime.handlers().listModels();
			},
		});
		return this.modelAdmin;
	}

	async attach(clientId: string, send: FrameSender): Promise<DispatchSession> {
		if (!(this.options.attach ?? resolvePiEngineAttach())) throw new CoreEngineNotReadyError("attach");
		this.clearOffline(clientId);
		const existing = this.runtimes.get(clientId);
		if (existing) {
			// 同 clientId 重连（刷新 / 重开标签页）：把新 socket 记成最新出口，并把连接期初始态重推一遍——
			// 新连接没有任何基线（老 `attachSink()` 也是每挂一个 sink 就整包推）。
			// 同一 clientId 此刻还活着的旧 socket 同样收到这批：那是老 `emit()` 的扇出口径（镜像，不是被换掉的连接）。
			this.bindSender(clientId, send);
			this.connectFrames.get(clientId)?.();
			existing.publisher.flush({ forceFull: true });
			this.notifyExternalRunning(clientId);
			return existing.handlers();
		}
		const orphan = isOrphanAdoptionExcludedClientId(clientId)
			? null
			: findAdoptableOrphan(this.runtimes, this.sockets, clientId);
		if (orphan) {
			this.runtimes.delete(orphan.oldId);
			this.clearOffline(orphan.oldId);
			const orphanWaiter = this.askWaiters.get(orphan.oldId);
			if (orphanWaiter) {
				this.askWaiters.delete(orphan.oldId);
				this.askWaiters.set(clientId, orphanWaiter);
			}
			this.runtimes.set(clientId, orphan.runtime);
			orphan.runtime.updateClientId(clientId);
			this.bindSender(clientId, send);
			const connectFn = this.connectFrames.get(orphan.oldId);
			if (connectFn) {
				this.connectFrames.delete(orphan.oldId);
				this.connectFrames.set(clientId, connectFn);
			}
			send({
				type: "notice",
				level: "info",
				text: "已恢复你关闭浏览器前的工作会话（连同未完成的后台任务）。",
				textEn: "Restored your session from before you closed the browser (including unfinished background tasks).",
			});
			this.connectFrames.get(clientId)?.();
			orphan.runtime.publisher.flush({ forceFull: true });
			this.notifyExternalRunning();
			return orphan.runtime.handlers();
		}
		// 排空期只拒**新建**（老实现同一处：`agent-service-daemon.ts` 的 `if (this.quiesced) throw`）；
		// 已持有运行时的客户端照常重连——排空要能观察存量，不该把正在看的页面锁在外面。
		if (this.isQuiesced()) throw new QuiesceRejectedError("新连接被拒绝，请等服务器恢复后重试");
		this.bindSender(clientId, send);
		const heldNotice = await checkHeldSessionNotice(
			this.runtimes,
			this.sockets,
			this.options.agentDir ?? this.cwd,
			this.cwd,
			clientId,
		);
		const { runtime, faces, sessions, deliver } = assembleClient({
			clientId,
			cwd: this.cwd,
			options: this.options,
			stateStore: this.stateStore,
			projectSource: this.projectSource,
			pluginTools: this.pluginTools,
			deliverTo: (cid, msg) => this.deliverTo(cid, msg),
			runtimes: this.runtimes,
			sockets: this.sockets,
			askWaiters: this.askWaiters,
			modelAdminPort: () => this.modelAdminPort(),
			langOf: (cid) => this.langOf(cid),
			setLang: (cid, next) => this.langs.set(cid, next),
			listExternalRunning: (cid) => this.listExternalRunning(cid),
			notifyExternalRunning: (cid) => this.notifyExternalRunning(cid),
			toolGuard: this.toolGuard,
			...(this.options.retainEvidence
				? { retainEvidence: (cid, conv) => this.options.retainEvidence!(cid, conv) }
				: {}),
			pluginToolFilter: (cid, conv) => this.pluginToolFilter(cid, conv),
			onToolEvent: this.onToolEvent,
			onRunEvent: this.onRunEvent,
			onClientCwdChanged: this.onClientCwdChanged,
			onTurnSettledOffline: (cid, rt) => {
				armOfflineRowExpiry(cid, rt, this.offlineSince, this.offlineTimers, () => this.notifyExternalRunning());
				this.notifyExternalRunning();
			},
			onConversationChanged: this.onConversationChanged,
			onNotificationEvent: this.onNotificationEvent,
			pluginCommandsProvider: this.pluginCommandsProvider,
			pluginBgTasksProvider: this.pluginBgTasksProvider,
			pluginStopBgTask: this.pluginStopBgTask,
			notifyPluginModelChange: (cid, convId) => this.notifyPluginModelChange(cid, convId),
			subagentsRegistry: this.subagentsRegistry,
			findSessionOwner: (target, excludeClientId) => this.findSessionOwner(target, excludeClientId),
			// 别处开着、没在跑：把那条对话过户到本客户端再打开（跨客户端单一写者，issue #567）。
			takeOverElsewhere: (targetClientId, owner) =>
				this.takeOverConversation(targetClientId, owner.clientId, owner.conversationId),
			checkParallelWork: (clientId, conv) => this.checkParallelWork(clientId, conv),
		});
		this.runtimes.set(clientId, runtime);
		// A + K + B：连接期建首条空白对话、挂 quiesce 门、推初始态帧（重连时同一份重推）。
		this.connectFrames.set(
			clientId,
			await initializeConnection({
				runtime,
				faces,
				sessions,
				modelAdmin: this.modelAdmin,
				stateStore: this.stateStore,
				clientId,
				emit: deliver,
				isQuiesced: () => this.isQuiesced(),
			}),
		);
		// 收尾这一帧是「新 socket 手上没有基线」的兜底：连接期已经推过（`listProviderKeys()` 这种只读帧
		// 会顺带 flush）就走闸门去重，不再强制全量——否则同一份内容冷开就是两帧（issue #965 的出帧预算）。
		// 重连分支（同一个运行时、新 socket）才需要强制：那份基线属于**上一个** socket。
		runtime.publisher.flush();
		if (heldNotice) deliver(heldNotice);
		this.notifyExternalRunning(clientId);
		this.onClientCwdChanged?.(runtime.cwd, [...runtime.roots]);
		this.onConversationChanged?.();
		return runtime.handlers();
	}

	deliverTo(clientId: string, msg: ServerMessage): void {
		const sockets = this.sockets.get(clientId);
		if (sockets) {
			for (const send of sockets) send(msg);
		}
	}

	/** 记一个活着的帧出口：最新的记进 `senders`（进程级广播用），全部留账（拆连接要看还有没有活 socket）。 */
	private bindSender(clientId: string, send: FrameSender): void {
		const sockets = this.sockets.get(clientId);
		if (sockets) sockets.add(send);
		else this.sockets.set(clientId, new Set([send]));
		this.senders.set(clientId, send);
	}

	detach(clientId: string, send: FrameSender): void {
		const sockets = this.sockets.get(clientId);
		if (sockets?.delete(send) && sockets.size > 0) {
			// 还有别的 socket 活着：只把出口让给剩下的那个，运行时不动（老 `detachSink()` 也只收自己那份 sink）。
			if (this.senders.get(clientId) === send) this.senders.set(clientId, [...sockets].at(-1)!);
			return;
		}
		this.sockets.delete(clientId);
		this.senders.delete(clientId);
		const runtime = this.runtimes.get(clientId);
		if (!runtime) {
			this.connectFrames.delete(clientId);
			return;
		}
		const shouldDispose = handleClientDetach(clientId, runtime, this.offlineSince, this.offlineTimers, () => {
			this.notifyExternalRunning(clientId);
		});
		if (shouldDispose) {
			this.runtimes.delete(clientId);
			// 重推初始态的口子跟着**运行时**走：运行时拆了才丢。留宽限期时不能丢——
			// 刷新页面就是「detach → 同 clientId 重连」，重连分支只调这个闭包；丢了它，
			// 新 socket 只能收到一帧快照，`settings_state` / `dsh_presets` / `default_model` 全缺。
			this.connectFrames.delete(clientId);
			this.askWaiters.delete(clientId);
			this.clearOffline(clientId);
			runtime.dispose();
		}
		this.notifyExternalRunning(clientId);
	}

	get(clientId: string): DispatchSession | undefined {
		return this.runtimes.get(clientId)?.handlers();
	}

	async disposeAll(): Promise<void> {
		// 先记账再拆：老实现同口径（`disposeAll()` 里第一件事就是 `recordInterruptedRuns()`），
		// 否则正在跑的对话在拆的时候还「跑着」，记录却已经写不进了。
		this.recordInterruptedRuns();
		for (const timer of this.offlineTimers.values()) clearTimeout(timer);
		this.offlineTimers.clear();
		this.offlineSince.clear();
		this.askWaiters.clear();
		for (const runtime of this.runtimes.values()) runtime.dispose();
		this.runtimes.clear();
		this.senders.clear();
		this.sockets.clear();
		this.connectFrames.clear();
		this.projectSource.close();
		this.socketCount = 0;
		this.quiescedSince = undefined;
	}

	/** 中断记账：把「此刻还在跑」的对话写进 `client-state.json` 的 `interrupted`（口径见 `interrupted-runs.ts`）。 */
	recordInterruptedRuns(): void {
		saveInterruptedRuns(this.stateStore, this.runtimes);
	}

	noteSocketOpen(): void {
		this.socketCount += 1;
	}
	noteSocketClose(): void {
		this.socketCount = Math.max(0, this.socketCount - 1);
	}
	isQuiesced(): boolean {
		return this.quiescedSince !== undefined;
	}
	quiesce(): void {
		this.quiescedSince ??= Date.now();
	}
	unquiesce(): void {
		this.quiescedSince = undefined;
	}
	quiesceInfo(): { quiesced: boolean; quiescedSince?: number } {
		const at = this.quiescedSince;
		return at === undefined ? { quiesced: false } : { quiesced: true, quiescedSince: at };
	}

	serviceStatus(): ReturnType<EngineService["serviceStatus"]> {
		return serviceStatusOf({
			version: this.options.version,
			cwd: this.cwd,
			quiesce: this.quiesceInfo(),
			connectedClients: this.socketCount,
			runtimes: this.runtimes,
			service: toServiceInfo(launchOrigin()),
		});
	}

	activeConversations(): number {
		return activeConversationsOf(this.runtimes);
	}
	pendingMessages(): number {
		return pendingMessagesOf(this.runtimes);
	}

	/** 插件刷新要的窄面（运行态 / 账 / 钩子）：`plugin-refresh.ts` 只认这几个字段。 */
	private get pluginHost(): PluginRefreshHost {
		return {
			runtimes: this.runtimes,
			pluginTools: this.pluginTools,
			...(this.pluginToolsProvider ? { pluginToolsProvider: this.pluginToolsProvider } : {}),
			stateStore: this.stateStore,
		};
	}

	/** 插件目录变了：把新一批同步进**已开的**会话（细目见 `plugin-refresh.ts`）。 */
	applyPluginAgentTools(): void {
		applyPluginAgentTools(this.pluginHost);
	}
	applyPluginCommandCatalog(): void {
		applyPluginCommandCatalog(this.pluginHost);
	}
	refreshBackgroundServers(): void {
		refreshBackgroundServers(this.pluginHost);
	}
	private pluginToolFilter(clientId: string, conv: Conversation): PluginAgentToolFilter {
		return pluginToolFilter(this.pluginHost, clientId, conv);
	}

	/**
	 * 换语言：整件事归这一条连接的设置面（老 `ClientSession.setLocale()`）——落盘 locale，
	 * 同语种只重发一帧 `settings_state`，换语族才重应用。门面只递 code，不另写一份分支。
	 */
	async setLocale(clientId: string, locale: string): Promise<void> {
		const code = locale.trim().slice(0, 16);
		if (!code) return;
		await this.runtimes.get(clientId)?.handlers().setLocale(code);
	}

	/** 当前语言：优先本次会话里刚设的，否则从 `client-state` 的 locale 推导（与老实现同口径）。 */
	private langOf(clientId: string): ServerLang {
		return this.langs.get(clientId) ?? resolveServerLang(this.stateStore.get(clientId).locale);
	}

	readConversationForPlugins(opts?: PluginConversationQuery): PluginConversationSnapshot | null {
		return readConversationForPlugins(this.runtimes, opts);
	}
	pluginClient(): DispatchSession | undefined {
		return pickPluginClient(this.runtimes);
	}
	chatFromPlugin(pluginId: string, req: PluginChatRequest) {
		return chatFromPlugin(
			{ runtimes: this.runtimes, attach: (id, send) => this.attach(id, send), isQuiesced: () => this.isQuiesced() },
			pluginId,
			req,
		);
	}
	private notifyPluginModelChange(clientId: string, conversationId: string): void {
		notifyPluginModelChange(this, this.pluginModelKeys, this.runtimes, clientId, conversationId);
	}
	mcpProjectCwds(): string[] {
		return mcpProjectCwds(this.runtimes);
	}
	refreshMcpProject(cwd: string): void {
		refreshMcpProject(this.runtimes, cwd);
	}
	private get elsewhereDeps() {
		return {
			runtimes: this.runtimes,
			sockets: this.sockets,
			offlineSince: this.offlineSince,
			hasQuestionOf: (cid: string, convId: string) =>
				Boolean(this.askWaiters.get(cid)?.pendingForSnapshot(convId).length),
		};
	}
	private get takeoverDeps() {
		return {
			runtimes: this.runtimes,
			takeoverFlights: this.takeoverFlights,
			notifyExternalRunning: (changed?: string) => this.notifyExternalRunning(changed),
			sendNotice: (id: string, notice: ServerMessage) => this.runtimes.get(id)?.options.transport.send(notice),
			askWaiters: this.askWaiters,
			subagentsRegistry: this.subagentsRegistry,
		};
	}
	listExternalRunning(excludeClientId: string): ElsewhereRunning[] {
		return listExternalRunning(this.elsewhereDeps, excludeClientId, offlineRowsTtlMs());
	}
	private notifyExternalRunning(excludeClientId?: string): void {
		for (const [id, r] of this.runtimes) {
			if (id !== excludeClientId) {
				try {
					r.pushConversations();
				} catch {}
			}
		}
	}
	private clearOffline(clientId: string): void {
		clearOfflineRows(clientId, this.offlineSince, this.offlineTimers);
	}
	async takeOverConversation(targetId: string, ownerId: string, convId: string): Promise<void> {
		await executeTakeOverConversation(this.takeoverDeps, targetId, ownerId, convId);
	}
	async dismissConversation(
		clientId: string,
		msg: { id: string; withFinishedSubagents?: boolean; force?: boolean; owner?: string },
	): Promise<boolean> {
		return executeDismissConversation(
			{
				runtimes: this.runtimes,
				sockets: this.sockets,
				deliverTo: (id, payload) => this.deliverTo(id, payload),
				cleanupOfflineRuntime: (ownerId, ownerRuntime) => {
					this.runtimes.delete(ownerId);
					this.connectFrames.delete(ownerId);
					this.askWaiters.delete(ownerId);
					this.clearOffline(ownerId);
					ownerRuntime.dispose();
				},
				notifyExternalRunning: (ownerId) => this.notifyExternalRunning(ownerId),
			},
			clientId,
			msg,
		);
	}
	async peekElsewhereQuestion(targetId: string, ownerId: string, convId: string): Promise<void> {
		peekElsewhereQuestion(this.takeoverDeps, targetId, ownerId, convId);
	}
	async navigateQuestion(targetId: string, id: string): Promise<void> {
		await navigateQuestion(this.takeoverDeps, targetId, id);
	}
	async answerElsewhereQuestion(
		targetId: string,
		ownerId: string,
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
		cancelReason?: string,
	): Promise<void> {
		answerElsewhereQuestion(this.takeoverDeps, targetId, ownerId, id, answers, cancelled, cancelReason);
	}
	resolveGlobalQuestion(
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
		cancelReason?: string,
	): boolean {
		return resolveGlobalQuestion(this.askWaiters, id, answers, cancelled, cancelReason);
	}
	getCapabilities(): AgentEngineCapabilities {
		return DEFAULT_PI_CAPABILITIES;
	}

	findSessionOwner(sessionFile: string, excludeClientId?: string) {
		return findSessionOwner(this.runtimes, this.sockets, sessionFile, excludeClientId);
	}

	private checkParallelWork(clientId: string, conv: Conversation | undefined): void {
		checkParallelWork(
			{
				runtimes: this.runtimes,
				sockets: this.sockets,
				deliverTo: (cid, msg) => this.deliverTo(cid, msg),
			},
			clientId,
			conv,
		);
	}

	chatFromScheduler(task: {
		id: string;
		name?: string;
		cwd: string;
		prompt: string;
		model?: string;
		thinkingLevel?: string;
	}) {
		return chatFromScheduler(
			{
				isQuiesced: () => this.isQuiesced(),
				attach: (cid, send) => this.attach(cid, send),
				runtimes: this.runtimes,
			},
			task,
		);
	}

	releaseSchedulerClient(taskId: string): void {
		releaseSchedulerClient(
			{
				runtimes: this.runtimes,
				clearOffline: (cid) => this.clearOffline(cid),
				notifyExternalRunning: () => this.notifyExternalRunning(),
			},
			taskId,
		);
	}
}
