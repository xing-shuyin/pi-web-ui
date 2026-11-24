import type { ClockPort } from "../../contracts/ports.js";
import type { UiBridgeCallResult } from "../../contracts/ui-bridge.js";

export interface PendingCallTableOptions {
	/** id 前缀：`p-`（页面）/ `ph-`（手机）。两套表各一份，前端按前缀分流。 */
	prefix: string;
	/** 定时器端口（内核不直接摸 `setTimeout`：测试要用可控时钟）。 */
	clock: ClockPort;
	/** 超时文案：各自说清「谁没回」（浏览器 / 手机）。 */
	timeoutError(timeoutMs: number): string;
}

export interface PendingCallInput {
	/** 已归一化过的超时（钳制在 `timeout.ts` 里做）。 */
	timeoutMs: number;
	/** 发起这条调用的对话：会话停止 / 关闭时按它定点结算。 */
	conversationId?: string;
	resolve(result: UiBridgeCallResult): void;
}

interface PendingCall {
	conversationId?: string;
	timeoutMs: number;
	/** 期限（`clock.now() + timeoutMs`）：只用来回答「谁快到期了」，结算仍靠定时器。 */
	deadline: number;
	resolve(result: UiBridgeCallResult): void;
	cancelTimer(): void;
}

/**
 * 「服务端发起 → 浏览器/手机执行 → 回包兑现 Promise」的挂起表（页面 / 手机两套各一份）。
 *
 * **不漏 Promise 的三道闸**（缺一条就会有一个工具永久挂着，那一轮永远不结束）：
 * 1. `arm()` 起手就上定时器：到点由表自己兑现成 `timeoutError`，并删表、停表；
 * 2. `settle()` 是唯一兑现口：**先删表 → 停定时器 → 再 resolve**（顺序反了就会重复兑现或漏清定时器）；
 * 3. 连接断开 / 运行时 dispose → `settleAll()`，会话停止 / 关闭 → `settleForConversation()`，
 *    两条都把表清空（老实现 `cancelPendingPageCalls` / `settlePendingsForConv` 同一口径）。
 *
 * 每条 id 只会 settle 一次：`Map.delete` 的返回值就是那道闸，晚到的回包是空操作。
 */
export class PendingCallTable {
	private seq = 0;
	private readonly entries = new Map<string, PendingCall>();

	constructor(private readonly options: PendingCallTableOptions) {}

	/** 挂起一条并返回 id（id 由内核发，前端回包只带它）。 */
	arm(input: PendingCallInput): string {
		const id = `${this.options.prefix}${++this.seq}`;
		const cancelTimer = this.options.clock.after(input.timeoutMs, () => {
			this.settle(id, { ok: false, error: this.options.timeoutError(input.timeoutMs) });
		});
		this.entries.set(id, {
			...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
			timeoutMs: input.timeoutMs,
			deadline: this.options.clock.now() + input.timeoutMs,
			resolve: input.resolve,
			cancelTimer,
		});
		return id;
	}

	/** 兑现一次（只有第一次有效）：返回 false = 没有这条 / 已经结算过。 */
	settle(id: string, result: UiBridgeCallResult): boolean {
		const entry = this.entries.get(id);
		if (!entry) return false;
		this.entries.delete(id);
		entry.cancelTimer();
		try {
			entry.resolve(result);
		} catch {
			// 兑现端自己抛错不该打断结算（也不该把 settleAll 扫到一半停住）。
		}
		return true;
	}

	/** 某条对话的全部挂起（会话被重置 / 停止 / 关闭时：不让工具抱着一个永不兑现的 Promise）。 */
	settleForConversation(conversationId: string, error: string): number {
		let settled = 0;
		for (const [id, entry] of this.entries) {
			if (entry.conversationId !== conversationId) continue;
			if (this.settle(id, { ok: false, error })) settled += 1;
		}
		return settled;
	}

	/** 全清（连接断开 / 运行时 dispose）。 */
	settleAll(error: string): number {
		let settled = 0;
		for (const id of this.ids()) {
			if (this.settle(id, { ok: false, error })) settled += 1;
		}
		return settled;
	}

	/** 这条 id 属于哪条对话（回包时的**归属**判定读它，不读活跃对话）。 */
	conversationOf(id: string): string | undefined {
		return this.entries.get(id)?.conversationId;
	}

	timeoutOf(id: string): number | undefined {
		return this.entries.get(id)?.timeoutMs;
	}

	deadlineOf(id: string): number | undefined {
		return this.entries.get(id)?.deadline;
	}

	has(id: string): boolean {
		return this.entries.has(id);
	}

	size(): number {
		return this.entries.size;
	}

	ids(): readonly string[] {
		return [...this.entries.keys()];
	}
}
