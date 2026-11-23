import type { DispatchSession, EngineService } from "../../../../server/engine-service.js";
import type { ServerMessage, UiServiceInfo } from "../../../../server/protocol.js";
import { toServiceInfo, launchOrigin } from "../../../../server/launch-origin.js";
import { join } from "node:path";
import { join as joinPath, resolve as resolveFsPath } from "node:path";
import type { ClockPort, TransportPort } from "../contracts/ports.js";
import { isInsideRoots } from "../../../../server/path-boundary.js";
import { ClientStateStore } from "../../../../server/client-state.js";
import { createProjectSource } from "../adapters/state/index.js";
import { createSettingsHost } from "../adapters/settings/index.js";
import { createSettingsPusher } from "../domains/settings/index.js";
import { conversationViewFromSession, subscribeSession } from "../adapters/sdk/view.js";
import { pushProjects } from "../domains/projects/index.js";
import { refreshSessions } from "../domains/history/index.js";
import { createModelPusher } from "../domains/models/index.js";
import { createModelRuntimeFactory } from "../adapters/models/index.js";
import { resolveToolLoadout } from "../domains/tools/index.js";
import { InteractionInbox } from "../domains/interactions/index.js";
import { createApprovalWaiter, createAskUserWaiter } from "../domains/interactions/index.js";
import { createAskQuestionTool } from "../adapters/tools/ask-question.js";
import { createGuardedBuiltinTools } from "../adapters/tools/guarded.js";
import { createSubagentRuntime, type SubagentRuntime } from "./subagent-runtime.js";
import { renameSessionFile } from "../adapters/sdk/session-info.js";
import { createTerminalHost } from "../domains/terminals/index.js";
import { DEFAULT_PI_CAPABILITIES } from "../../../../server/engine-capabilities.js";
import type { AgentEngineCapabilities } from "../../../../server/protocol.js";
import { ClientRuntime, type ClientFrames } from "./client-runtime.js";
import { SessionRegistry } from "./session-registry.js";
import { CoreEngineNotReadyError } from "../contracts/core-engine-errors.js";
import { resolvePiEngineAttach } from "./engine-mode.js";

export { CoreEngineNotReadyError };

const systemClock: ClockPort = {
	now: () => Date.now(),
	after: (ms, fn) => {
		const timer = setTimeout(fn, ms);
		return () => clearTimeout(timer);
	},
};

/**
 * 新树的对外门面：只持有 EngineService 的生命周期与按客户端的运行时。
 * 这里禁止出现业务分支——门面里每多一个 `if`，编排就又回到了上帝对象。
 */
export class CoreEngine implements EngineService {
	onQuit?: () => boolean;
	private readonly runtimes = new Map<string, ClientRuntime>();
	private settingsLang: "zh" | "en" | "zh-TW" = "zh";
	private socketCount = 0;
	private quiescedSince: number | undefined;

	private readonly stateStore: ClientStateStore;
	private readonly projectSource: ReturnType<typeof createProjectSource>;

	constructor(
		private readonly cwd: string,
		private readonly options: { version: string; attach?: boolean; dataDir?: string; agentDir?: string },
	) {
		const dataDir = options.dataDir ?? process.cwd();
		this.stateStore = new ClientStateStore(join(dataDir, "client-state.json"));
		this.projectSource = createProjectSource({ file: join(dataDir, "client-state.json") });
	}

	async attach(clientId: string, send: (msg: ServerMessage) => void): Promise<DispatchSession> {
		if (!(this.options.attach ?? resolvePiEngineAttach())) throw new CoreEngineNotReadyError("attach");
		const existing = this.runtimes.get(clientId);
		if (existing) return existing.handlers();
		const transport: TransportPort = { send, isClosed: () => !this.runtimes.has(clientId) };
		const unsubscribers = new Map<string, () => void>();
		const terminalHost = createTerminalHost({
			transport,
			cwdOf: (conversationId) => runtime.registry.get(conversationId)?.meta.cwd ?? this.cwd,
			lang: () => this.settingsLang,
		});
		const inbox = new InteractionInbox(() => {});
		const approvalWaiter = createApprovalWaiter({ inbox, transport });
		const askWaiter = createAskUserWaiter({ inbox, transport });
		const sessions = new SessionRegistry({
			agentDir: this.options.agentDir ?? this.cwd,
			// 工具装载域决定注册哪些工具；注册表只转发，不给默认值。
			toolsFor: () => resolveToolLoadout({ switches: this.stateStore.getSettingsSnapshot(clientId) }).tools,
			// 自定义工具是审批/提问/子代理的唯一入口；一个对话一份闭包（工具里要带会话身份）。
			customToolsFor: (conv) => [
				createAskQuestionTool({ waiter: askWaiter, conversationId: conv.id }),
				// 内置 bash 重建一份带审批闸的同名工具，覆盖 SDK 里那个直接执行的内置实现。
				...(subagents ? [subagents.toolFor(conv.id)] : []),
				...createGuardedBuiltinTools({
					cwd: this.cwd,
					getLang: () => this.settingsLang,
					conversationId: () => conv.id,
					askApproval: (_toolCallId, toolName, params, reason, reasonEn) =>
						approvalWaiter.request({
							conversationId: conv.id,
							toolName,
							params,
							reason: reason ?? reasonEn,
						}),
				}),
			],
			onOpened: (conv, opened) => {
				runtime.noteSessionFile(opened.sessionFile);
				unsubscribers.set(
					conv.id,
					subscribeSession(opened.session, () => runtime.publisher.request()),
				);
			},
			onClosed: (conversationId) => {
				unsubscribers.get(conversationId)?.();
				unsubscribers.delete(conversationId);
			},
		});
		let subagents: SubagentRuntime | undefined;
		const runtime = new ClientRuntime({
			clientId,
			cwd: this.cwd,
			clock: systemClock,
			transport,
			sessions,
			turnEvents: {
				onTurnSettled: (conversationId, outcome) => {
					subagents?.settle(conversationId, outcome === "done" ? "done" : outcome === "aborted" ? "stopped" : "failed");
				},
			},
			// 只会删自己会话目录里的文件：根 = agentDir/sessions（与 SDK 落盘位置一致）。
			persistSessionTitle: async (sessionFile, title) => {
				await renameSessionFile({ sessionFile, title });
			},
			terminalManagerFor: (conversationId) => terminalHost.managerFor(conversationId, this.cwd),
			isAllowedPath: (target) =>
				isInsideRoots(resolveFsPath(target), [joinPath(this.options.agentDir ?? this.cwd, "sessions")]),
			viewOf: (conv) => ({
				...conversationViewFromSession(conv, sessions.get(conv.id)?.session),
				pendingApprovals: approvalWaiter.pendingForSnapshot(conv.id),
			}),
			env: {
				settingsVersion: 0,
				piConfigured: false,
				piAgentInstalled: false,
				capabilities: DEFAULT_PI_CAPABILITIES,
			},
		});
		const pusher = createSettingsPusher({
			host: createSettingsHost({
				clientId,
				stateStore: this.stateStore,
				emit: (msg) => transport.send(msg),
				cwd: this.cwd,
				agentDir: this.options.agentDir ?? this.cwd,
				isDisposed: false,
				isStreaming: runtime.streamingCount() > 0,
				getSession: () => {
					const conv = runtime.registry.activeConv();
					const opened = conv ? sessions.get(conv.id) : undefined;
					if (!opened) throw new CoreEngineNotReadyError("settings session");
					return opened.session;
				},
			}),
			transport,
		});
		const modelPusher = createModelPusher({
			transport,
			agentDir: this.options.agentDir ?? this.cwd,
			runtimeFactory: createModelRuntimeFactory(),
		});
		subagents = createSubagentRuntime({ runtime, sessions, now: () => Date.now() });
		const frames: ClientFrames = {
			pushSettings: () => pusher.push(),
			pushProjects: async () => {
				await pushProjects({ transport, clientId, cwd: this.cwd, source: this.projectSource });
			},
			refreshSessions: async () => {
				const root = runtime.historyRoot();
				if (!root) {
					transport.send({ type: "sessions", sessions: [], cwd: this.cwd });
					return;
				}
				await refreshSessions({ root, cwd: this.cwd, transport, state: runtime.historyState() });
			},
			listModels: () => {
				void modelPusher.push();
			},
		};
		runtime.attachFrames(frames);
		this.runtimes.set(clientId, runtime);
		return runtime.handlers();
	}

	detach(clientId: string, _send: (msg: ServerMessage) => void): void {
		const runtime = this.runtimes.get(clientId);
		if (!runtime) return;
		runtime.dispose();
		this.runtimes.delete(clientId);
	}

	get(clientId: string): DispatchSession | undefined {
		return this.runtimes.get(clientId)?.handlers();
	}

	async disposeAll(): Promise<void> {
		for (const runtime of this.runtimes.values()) runtime.dispose();
		this.runtimes.clear();
		this.projectSource.close();
		this.socketCount = 0;
		this.quiescedSince = undefined;
	}

	recordInterruptedRuns(): void {}

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
		return this.quiescedSince === undefined
			? { quiesced: false }
			: { quiesced: true, quiescedSince: this.quiescedSince };
	}

	serviceStatus(): {
		pid: number;
		version: string;
		cwd: string;
		quiesced: boolean;
		quiescedSince?: number;
		connectedClients: number;
		activeConversations: number;
		pendingMessages: number;
		service: UiServiceInfo | null;
	} {
		return {
			pid: process.pid,
			version: this.options.version,
			cwd: this.cwd,
			...this.quiesceInfo(),
			connectedClients: this.socketCount,
			activeConversations: this.activeConversations(),
			pendingMessages: this.pendingMessages(),
			service: toServiceInfo(launchOrigin()),
		};
	}

	activeConversations(): number {
		let total = 0;
		for (const runtime of this.runtimes.values()) total += runtime.streamingCount();
		return total;
	}

	pendingMessages(): number {
		let total = 0;
		for (const runtime of this.runtimes.values()) total += runtime.pendingCount();
		return total;
	}

	applyPluginAgentTools(): void {}

	applyPluginCommandCatalog(): void {}

	refreshBackgroundServers(): void {}

	async setLocale(_clientId: string, locale: string): Promise<void> {
		this.settingsLang = locale.startsWith("en") ? "en" : locale === "zh-TW" ? "zh-TW" : "zh";
	}

	getCapabilities(): AgentEngineCapabilities {
		return DEFAULT_PI_CAPABILITIES;
	}
}
