import type { DispatchSession, EngineService } from "../../engine-service.js";
import type { ServerMessage, UiServiceInfo } from "../../protocol.js";
import { toServiceInfo, launchOrigin } from "../../launch-origin.js";
import { join } from "node:path";
import type { ClockPort, TransportPort } from "../contracts/ports.js";
import { ClientStateStore } from "../../client-state.js";
import { createProjectSource } from "../adapters/state/index.js";
import { createSettingsHost } from "../adapters/settings/index.js";
import { createSettingsPusher } from "../domains/settings/index.js";
import { conversationViewFromSession, subscribeSession } from "../adapters/sdk/view.js";
import { pushProjects } from "../domains/projects/index.js";
import { refreshSessions } from "../domains/history/index.js";
import { createModelPusher } from "../domains/models/index.js";
import { createModelRuntimeFactory } from "../adapters/models/index.js";
import { DEFAULT_PI_CAPABILITIES } from "../../engine-capabilities.js";
import type { AgentEngineCapabilities } from "../../protocol.js";
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
		const sessions = new SessionRegistry({
			agentDir: this.options.agentDir ?? this.cwd,
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
		const runtime = new ClientRuntime({
			clientId,
			cwd: this.cwd,
			clock: systemClock,
			transport,
			sessions,
			viewOf: (conv) => conversationViewFromSession(conv, sessions.get(conv.id)?.session),
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

	async setLocale(_clientId: string, _locale: string): Promise<void> {}

	getCapabilities(): AgentEngineCapabilities {
		return DEFAULT_PI_CAPABILITIES;
	}
}
