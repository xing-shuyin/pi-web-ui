import { existsSync } from "node:fs";
import type { EngineService, DispatchSession } from "../index.js";
import type { ServerMessage, UiServiceInfo, AgentEngineCapabilities } from "../protocol.js";
import type { ClientStateStore } from "../client-state.js";
import type { PluginCommandDef } from "../plugins.js";
import { UniversalSessionStore } from "./session-store.js";
import { UniversalSession } from "./universal-session.js";
import type { BaseAgentDriver } from "./driver-base.js";
import { MockAgentDriver } from "./drivers/mock-driver.js";
import { DEFAULT_UNIVERSAL_CAPABILITIES } from "../engine-capabilities.js";
import { getAppVersion } from "../pkg-info.js";

export type DriverFactory = (cwd: string) => BaseAgentDriver;

export class UniversalAgentService implements EngineService {
	private readonly cwd: string;
	private readonly dataDir: string;
	private readonly store: UniversalSessionStore;
	private readonly stateStore?: ClientStateStore;
	private readonly driverFactory: DriverFactory;
	private readonly sessions = new Map<string, UniversalSession>();
	private readonly agentDir?: string;
	private readonly engine: string;

	private quiesced = false;
	private quiescedSince?: number;
	private socketCount = 0;

	pluginCommandsProvider?: () => PluginCommandDef[];
	onQuit?: () => boolean;

	constructor(opts: {
		cwd: string;
		dataDir: string;
		agentDir?: string;
		stateStore?: ClientStateStore;
		driverFactory?: DriverFactory;
		engine?: string;
	}) {
		this.cwd = opts.cwd;
		this.dataDir = opts.dataDir;
		this.agentDir = opts.agentDir;
		this.engine = opts.engine ?? "claude";
		this.store = new UniversalSessionStore(opts.dataDir, this.engine);
		this.stateStore = opts.stateStore;
		this.driverFactory = opts.driverFactory ?? ((cwd: string) => new MockAgentDriver(cwd));
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
				this.stateStore.remember(clientId, effectiveCwd);
			}

			const driver = this.driverFactory(effectiveCwd);
			session = new UniversalSession({
				clientId,
				cwd: effectiveCwd,
				dataDir: this.dataDir,
				agentDir: this.agentDir,
				send,
				store: this.store,
				stateStore: this.stateStore,
				driver,
				driverFactory: this.driverFactory,
				engine: this.engine,
				pluginCommandsProvider: () => this.pluginCommandsProvider?.() ?? [],
				onQuit: () => this.onQuit?.() ?? false,
			});
			this.sessions.set(clientId, session);
			session.attachSink(send);
		} else {
			session.attachSink(send);
		}
		return session;
	}

	detach(clientId: string, send?: (msg: ServerMessage) => void): void {
		const session = this.sessions.get(clientId);
		if (session) {
			if (send) {
				session.detachSink(send);
			} else {
				session.dispose();
				this.sessions.delete(clientId);
			}
		}
	}

	get(clientId: string): DispatchSession | undefined {
		return this.sessions.get(clientId);
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
		for (const s of this.sessions.values()) {
			count += s.activeConversations();
		}
		return count;
	}

	pendingMessages(): number {
		return 0;
	}

	applyPluginAgentTools(): void {}

	applyPluginCommandCatalog(): void {}

	applyPluginMarkers(): void {
		for (const session of this.sessions.values()) {
			session.pushSettings();
		}
	}

	refreshBackgroundServers(): void {}

	async setLocale(clientId: string, locale: string): Promise<void> {
		const session = this.sessions.get(clientId);
		if (session) {
			await session.setLocale(locale);
		}
	}

	getCapabilities(): AgentEngineCapabilities {
		const first = this.sessions.values().next().value;
		return first ? first.getCapabilities() : DEFAULT_UNIVERSAL_CAPABILITIES;
	}
}
