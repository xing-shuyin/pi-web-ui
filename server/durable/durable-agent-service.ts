import { existsSync } from "node:fs";
import type { EngineService, DispatchSession } from "../index.js";
import type { ServerMessage, UiServiceInfo } from "../protocol.js";
import type { ClientStateStore } from "../client-state.js";
import type { PluginCommandDef } from "../plugins.js";
import { UniversalSessionStore } from "../universal/session-store.js";
import { UniversalSession } from "../universal/universal-session.js";
import { DurableAgentDriver } from "./durable-driver.js";
import { getAppVersion } from "../pkg-info.js";

export class DurableAgentService implements EngineService {
	private readonly cwd: string;
	private readonly dataDir: string;
	private readonly store: UniversalSessionStore;
	private readonly stateStore?: ClientStateStore;
	private readonly sessions = new Map<string, UniversalSession>();
	private readonly agentDir?: string;

	private quiesced = false;
	private quiescedSince?: number;
	private socketCount = 0;

	pluginCommandsProvider?: () => PluginCommandDef[];
	onQuit?: () => boolean;

	constructor(opts: { cwd: string; dataDir: string; agentDir?: string; stateStore?: ClientStateStore }) {
		this.cwd = opts.cwd;
		this.dataDir = opts.dataDir;
		this.agentDir = opts.agentDir;
		this.store = new UniversalSessionStore(opts.dataDir, "durable");
		this.stateStore = opts.stateStore;
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

	detach(clientId: string, send: (msg: ServerMessage) => void): void {
		const session = this.sessions.get(clientId);
		if (session) {
			session.detachSink(send);
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
