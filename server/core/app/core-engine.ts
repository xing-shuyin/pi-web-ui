import { VERSION } from "@earendil-works/pi-coding-agent";
import type { DispatchSession, EngineService } from "../../engine-service.js";
import type { ServerMessage, UiServiceInfo } from "../../protocol.js";
import { toServiceInfo, launchOrigin } from "../../launch-origin.js";
import { CoreEngineNotReadyError } from "../contracts/core-engine-errors.js";

export { CoreEngineNotReadyError };

/**
 * 新树的对外门面：只持有 EngineService 的生命周期与状态，业务能力随 W1~W6 逐域接入。
 * 这里禁止出现业务分支——门面里每多一个 `if`，编排就又回到了上帝对象。
 */
export class CoreEngine implements EngineService {
	onQuit?: () => boolean;
	private socketCount = 0;
	private quiescedSince: number | undefined;

	constructor(private readonly cwd: string) {}

	async attach(_clientId: string, _send: (msg: ServerMessage) => void): Promise<DispatchSession> {
		throw new CoreEngineNotReadyError("attach");
	}

	detach(_clientId: string, _send: (msg: ServerMessage) => void): void {}

	get(_clientId: string): DispatchSession | undefined {
		return undefined;
	}

	async disposeAll(): Promise<void> {
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
			version: VERSION,
			cwd: this.cwd,
			...this.quiesceInfo(),
			connectedClients: this.socketCount,
			activeConversations: this.activeConversations(),
			pendingMessages: this.pendingMessages(),
			service: toServiceInfo(launchOrigin()),
		};
	}

	activeConversations(): number {
		return 0;
	}

	pendingMessages(): number {
		return 0;
	}

	applyPluginAgentTools(): void {}

	applyPluginCommandCatalog(): void {}

	refreshBackgroundServers(): void {}

	async setLocale(_clientId: string, _locale: string): Promise<void> {}
}
