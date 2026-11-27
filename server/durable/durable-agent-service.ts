import { existsSync } from "node:fs";
import type { EngineService, DispatchSession } from "../engine-service.js";
import type { ServerMessage, UiServiceInfo } from "../protocol.js";
import type { ClientStateStore } from "../client-state.js";
import type {
	PluginCommandDef,
	PluginConversationQuery,
	PluginConversationSnapshot,
	PluginRunEvent,
} from "../plugins.js";
import { UniversalSessionStore } from "../universal/session-store.js";
import { UniversalSession } from "../universal/universal-session.js";
import { DurableAgentDriver } from "./durable-driver.js";
import { getAppVersion } from "../pkg-info.js";
import type { BackgroundTaskService } from "../background-task-service.js";

export class DurableAgentService implements EngineService {
	private readonly cwd: string;
	private readonly dataDir: string;
	private readonly store: UniversalSessionStore;
	private readonly stateStore?: ClientStateStore;
	private readonly sessions = new Map<string, UniversalSession>();
	private readonly agentDir?: string;
	private readonly backgroundTasks?: BackgroundTaskService;
	private readonly internalMcpUrl?: () => string | null;

	private quiesced = false;
	private quiescedSince?: number;
	private socketCount = 0;

	pluginCommandsProvider?: () => PluginCommandDef[];
	pluginToolsProvider?: (cwd?: string) => unknown[];
	onQuit?: () => boolean;
	onRunEvent?: (event: PluginRunEvent) => void;
	onConversationChanged?: () => void;

	constructor(opts: {
		cwd: string;
		dataDir: string;
		agentDir?: string;
		stateStore?: ClientStateStore;
		backgroundTasks?: BackgroundTaskService;
		internalMcpUrl?: () => string | null;
	}) {
		this.cwd = opts.cwd;
		this.dataDir = opts.dataDir;
		this.agentDir = opts.agentDir;
		this.store = new UniversalSessionStore(opts.dataDir, "durable");
		this.stateStore = opts.stateStore;
		this.backgroundTasks = opts.backgroundTasks;
		this.internalMcpUrl = opts.internalMcpUrl;
	}

	async attach(clientId: string, send: (msg: ServerMessage) => void): Promise<DispatchSession> {
		let session = this.sessions.get(clientId);
		if (!session) {
			let effectiveCwd = this.cwd;
			const saved = this.stateStore?.get(clientId);
			if (saved?.lastCwd && saved.lastCwd !== this.cwd) {
				try {
					if (existsSync(saved.lastCwd)) {
						effectiveCwd = saved.lastCwd;
					}
				} catch {}
			}
			if (typeof this.stateStore?.remember === "function") {
				this.stateStore.remember(clientId, effectiveCwd, { promote: false, clearTombstone: false });
			}

			const driver = new DurableAgentDriver(effectiveCwd, { dataDir: this.dataDir, agentDir: this.agentDir });
			session = new UniversalSession({
				clientId,
				cwd: effectiveCwd,
				dataDir: this.dataDir,
				agentDir: this.agentDir,
				send,
				store: this.store,
				stateStore: this.stateStore,
				driver,
				driverFactory: (cwd) => new DurableAgentDriver(cwd, { dataDir: this.dataDir, agentDir: this.agentDir }),
				engine: "durable",
				backgroundTasks: this.backgroundTasks,
				internalMcpUrl: this.internalMcpUrl,
				pluginCommandsProvider: () => this.pluginCommandsProvider?.() ?? [],
				pluginToolsProvider: (cwd) => this.pluginToolsProvider?.(cwd) ?? [],
				onQuit: () => this.onQuit?.() ?? false,
				onRunEvent: (event) => this.onRunEvent?.(event),
				onConversationChanged: () => this.onConversationChanged?.(),
			});
			this.sessions.set(clientId, session);
			session.attachSink(send);
		} else {
			session.attachSink(send);
		}
		return session;
	}

	detach(clientId: string, send: (msg: ServerMessage) => void): void {
		const session = this.sessions.get(clientId);
		if (session) {
			session.detachSink(send);
		}
	}

	get(clientId: string): DispatchSession | undefined {
		return this.sessions.get(clientId);
	}

	readConversationForPlugins(opts?: PluginConversationQuery): PluginConversationSnapshot | null {
		const targetId = opts?.clientId;
		if (targetId) return this.sessions.get(targetId)?.readConversationForPlugins({ clientId: targetId }) ?? null;
		let latest: PluginConversationSnapshot | null = null;
		for (const session of this.sessions.values()) {
			const snap = session.readConversationForPlugins();
			if (snap && !snap.isSubagent && (!latest || snap.at > latest.at)) latest = snap;
		}
		return latest;
	}

	async disposeAll(): Promise<void> {
		for (const session of this.sessions.values()) {
			session.dispose();
		}
		this.sessions.clear();
	}

	recordInterruptedRuns(): void {}

	noteSocketOpen(): void {
		this.socketCount++;
	}

	noteSocketClose(): void {
		this.socketCount = Math.max(0, this.socketCount - 1);
	}

	isQuiesced(): boolean {
		return this.quiesced;
	}

	quiesce(): void {
		this.quiesced = true;
		this.quiescedSince = Date.now();
	}

	unquiesce(): void {
		this.quiesced = false;
		this.quiescedSince = undefined;
	}

	quiesceInfo(): { quiesced: boolean; quiescedSince?: number } {
		return { quiesced: this.quiesced, quiescedSince: this.quiescedSince };
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
			version: getAppVersion(),
			cwd: this.cwd,
			quiesced: this.quiesced,
			quiescedSince: this.quiescedSince,
			connectedClients: this.socketCount,
			activeConversations: this.activeConversations(),
			pendingMessages: this.pendingMessages(),
			service: null,
		};
	}

	activeConversations(): number {
		let count = 0;
		for (const session of this.sessions.values()) {
			if (session.isStreaming) count++;
		}
		return count;
	}

	pendingMessages(): number {
		return 0;
	}

	applyPluginAgentTools(): void {}

	applyPluginCommandCatalog(): void {}

	applyPluginMarkers(): void {}

	refreshBackgroundServers(): void {
		for (const session of this.sessions.values()) {
			session.listBgServers();
		}
	}

	async setLocale(clientId: string, locale: string): Promise<void> {
		const session = this.sessions.get(clientId);
		if (session) {
			await session.setLocale(locale);
		}
	}
}
