import type { ClockPort } from "../contracts/ports.js";
import type { TurnEvents } from "../contracts/session.js";
import type { Conversation, ConversationRegistry } from "../kernel/conversation/index.js";
import { normalizePathKey } from "../projects-schema.js";
import { TurnRunner } from "../domains/turns/index.js";

export interface ClientTurnLifecycleOptions {
	clock: ClockPort;
	registry: ConversationRegistry<Conversation>;
	events?: TurnEvents;
	isDisposed(): boolean;
	refreshSessions(cwd: string): Promise<void>;
}

/** 回合生命周期与历史列表补推：运行列表交给历史行时，历史列表必须同步跟上。 */
export class ClientTurnLifecycle {
	readonly runner: TurnRunner;
	private readonly requestedSessionProjects = new Set<string>();
	private readonly sessionPushTimers = new Map<string, () => void>();

	constructor(private readonly options: ClientTurnLifecycleOptions) {
		this.runner = new TurnRunner({
			clock: options.clock,
			events: {
				...options.events,
				onStreamingChanged: (conversationId, streaming, at) => {
					// streaming 归位是回合收尾边界：先启动所属项目的历史刷新，再让宿主把运行行交给历史行。
					if (!streaming) {
						const conv = options.registry.get(conversationId);
						if (conv) this.scheduleSessionsPush(conv.meta.cwd);
					}
					options.events?.onStreamingChanged?.(conversationId, streaming, at);
				},
			},
		});
	}

	/** 某个项目的历史列表已被客户端请求过（连接期首推也算），之后回合收尾才自动补推。 */
	noteSessionsRequested(cwd: string): void {
		if (cwd) this.requestedSessionProjects.add(normalizePathKey(cwd));
	}

	/**
	 * 回合写盘后补推会话自己的项目：首轮立即推，600ms 内的后续轮次合并成一次尾部推送。
	 * 只推客户端已经请求过的项目；推迟首轮会造成「跑完先消失、点一下项目才回来」的空窗。
	 */
	private scheduleSessionsPush(cwd: string): void {
		if (this.options.isDisposed() || !cwd) return;
		const key = normalizePathKey(cwd);
		if (!this.requestedSessionProjects.has(key)) return;
		const pending = this.sessionPushTimers.get(key);
		if (pending) pending();
		else this.pushSessionsAfterTurn(cwd);
		const cancel = this.options.clock.after(600, () => {
			this.sessionPushTimers.delete(key);
			if (!this.options.isDisposed() && this.requestedSessionProjects.has(key)) this.pushSessionsAfterTurn(cwd);
		});
		this.sessionPushTimers.set(key, cancel);
	}

	private pushSessionsAfterTurn(cwd: string): void {
		if (this.options.isDisposed()) return;
		void this.options.refreshSessions(cwd).catch(() => {});
	}

	dispose(): void {
		for (const cancel of this.sessionPushTimers.values()) cancel();
		this.sessionPushTimers.clear();
		this.requestedSessionProjects.clear();
	}
}
