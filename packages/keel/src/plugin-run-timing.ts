import type { PluginRunEvent } from "./contracts/plugin.js";

export interface PluginTurnIdentity {
	conversationId: string;
	clientId?: string;
	sessionId?: string;
}

/**
 * 一次模型请求的首包计时器。
 *
 * turn_start -> 首个 assistant 增量 -> turn_end 是各引擎统一的插件语义；
 * 首包只记一次，结束/清理后迟到增量不会借到下一轮。
 */
export class PluginTurnTimer {
	private startedAt: number | null = null;
	private active = false;

	constructor(
		private readonly emit: (event: PluginRunEvent) => void,
		private readonly identity: PluginTurnIdentity,
	) {}

	get isActive(): boolean {
		return this.active;
	}

	setSessionId(sessionId?: string): void {
		this.identity.sessionId = sessionId;
	}

	start(at = Date.now()): void {
		this.active = true;
		this.startedAt = at;
		this.emit({ ...this.identity, type: "turn_start", at });
	}

	first(at = Date.now()): void {
		if (!this.active || this.startedAt === null) return;
		const startedAt = this.startedAt;
		this.startedAt = null;
		this.emit({
			...this.identity,
			type: "turn_first_token",
			at,
			durationMs: Math.max(1, at - startedAt),
		});
	}

	end(at = Date.now()): void {
		if (!this.active) return;
		this.active = false;
		this.startedAt = null;
		this.emit({ ...this.identity, type: "turn_end", at });
	}

	clear(): void {
		this.active = false;
		this.startedAt = null;
	}
}
