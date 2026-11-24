import type { ConversationId } from "../../contracts/ids.js";
import type { ClockPort } from "../../contracts/ports.js";
import type { TurnCapableSession, TurnEvents, TurnOutcome, TurnStartOptions } from "../../contracts/session.js";
import type { Conversation } from "../../kernel/conversation/index.js";
import { feedSteer, feedTurn } from "./feed.js";

export class TurnRejectedError extends Error {
	readonly code = "turn_rejected" as const;

	constructor(conversationId: ConversationId, reason: string) {
		super(`conversation ${conversationId} rejected the turn: ${reason}`);
		this.name = "TurnRejectedError";
	}
}

export interface TurnRunnerDeps {
	clock: ClockPort;
	events?: TurnEvents;
}

type SettledOutcome = "done" | "failed";

/**
 * 回合执行口：相位（kernel 聚合）与喂轮（`feed.ts`）之间唯一的接缝。
 * 只负责相位、streaming 与事件；会话退役与否由喂轮出口判定，其错误（`SessionRetiredError`，
 * 按 name/code 识别）必须原样上抛，让调用方按 code 决定留队重投还是如实报错。
 */
export class TurnRunner {
	private readonly streaming = new Set<string>();
	private readonly idleWaiters = new Map<string, Array<() => void>>();

	constructor(private readonly deps: TurnRunnerDeps) {}

	isStreaming(conversationId: string): boolean {
		return this.streaming.has(conversationId);
	}

	/**
	 * 等这个对话正在跑的这一轮真的收尾（相位回到 idle）。`abort()` 之后 SDK 已经是 idle，
	 * 但回合的结算在喂轮 promise 的 `finally` 里：编辑重问要等它落地，否则会撞上「相位还在跑」。
	 */
	whenIdle(conversationId: string): Promise<void> {
		if (!this.streaming.has(conversationId)) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const waiters = this.idleWaiters.get(conversationId) ?? [];
			waiters.push(resolve);
			this.idleWaiters.set(conversationId, waiters);
		});
	}

	async start(
		conv: Conversation,
		session: TurnCapableSession,
		text: string,
		opts?: TurnStartOptions,
	): Promise<TurnOutcome> {
		this.assertAcceptsTurns(conv);
		if (opts?.deliverAs) {
			if (conv.phase !== "running") {
				throw new TurnRejectedError(conv.id, `${opts.deliverAs} needs a running turn, phase is ${conv.phase}`);
			}
			await feedTurn(session, text, opts.deliverAs);
			return "done";
		}
		if (conv.phase !== "idle") throw new TurnRejectedError(conv.id, `a turn is already running in phase ${conv.phase}`);

		const at = this.deps.clock.now();
		conv.beginTurn(at);
		this.setStreaming(conv.id, true, at);
		let outcome: SettledOutcome = "failed";
		try {
			await feedTurn(session, text);
			outcome = "done";
			return "done";
		} finally {
			// feed 的错误（含 SessionRetiredError）原样上抛；这里只回收相位与 streaming，不改写错误。
			this.settle(conv, outcome);
		}
	}

	async steer(conv: Conversation, session: TurnCapableSession, text: string): Promise<void> {
		this.assertAcceptsTurns(conv);
		if (conv.phase !== "running") {
			throw new TurnRejectedError(conv.id, `steer needs a running turn, phase is ${conv.phase}`);
		}
		await feedSteer(session, text);
	}

	private settle(conv: Conversation, outcome: SettledOutcome): void {
		const at = this.deps.clock.now();
		// 相位可能已被退役路径带走（running → retiring）：跳过 endTurn，别让它掩盖原始错误。
		if (conv.phase === "running") conv.endTurn(at);
		this.setStreaming(conv.id, false, at);
		this.deps.events?.onTurnSettled?.(conv.id, outcome, at);
	}

	private setStreaming(conversationId: ConversationId, streaming: boolean, at: number): void {
		if (streaming) this.streaming.add(conversationId);
		else {
			this.streaming.delete(conversationId);
			const waiters = this.idleWaiters.get(conversationId);
			if (waiters) {
				this.idleWaiters.delete(conversationId);
				for (const resolve of waiters) resolve();
			}
		}
		this.deps.events?.onStreamingChanged?.(conversationId, streaming, at);
	}

	private assertAcceptsTurns(conv: Conversation): void {
		if (!conv.acceptsTurns) throw new TurnRejectedError(conv.id, `phase ${conv.phase} no longer accepts turns`);
	}
}
