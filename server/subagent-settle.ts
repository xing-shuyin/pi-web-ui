/**
 * 子代理结算唤醒单源。
 *
 * 等待方（`conversation(action="wait_all")`）只订阅「这些运行里任意一个发生了可观察变化」，
 * 运行态在真实事件上 `notify`：回合结束、被停止、被移出、问卷/请示变化、通知投递状态变化。
 * 于是等待不再靠 250ms 轮询，也不需要每次醒来都重新投影全部快照。
 *
 * 语义刻意做成「一次唤醒」而不是「等全部结算」：等待方要在子代理中途提问（consult）时立刻
 * 回到模型，只能由等待循环自己重新判定是否真的收口。所以这里只提供边沿，不提供终态。
 */
export type SettleWakeReason = "changed" | "timeout" | "aborted";

export interface SettleWaitOptions {
	/** 本次等待的上限。到点返回 `timeout`，由等待方决定是继续等还是收口。 */
	timeoutMs: number;
	signal?: AbortSignal;
}

interface SettleWaiter {
	fire(reason: SettleWakeReason): void;
}

export class SubagentSettleRegistry {
	private readonly perId = new Map<string, Set<SettleWaiter>>();
	private readonly global = new Set<SettleWaiter>();

	/** 当前挂起的等待数（测试与诊断用）。 */
	get waiting(): number {
		return this.global.size;
	}

	/** 某个运行发生变化：只唤醒订阅了它的等待方。 */
	notify(id: string): void {
		if (!id) return;
		const set = this.perId.get(id);
		if (!set || set.size === 0) return;
		for (const waiter of [...set]) waiter.fire("changed");
	}

	/** 粗粒度变化（问卷队列、通知投递状态）：唤醒全部等待方，让它们各自重新判定。 */
	notifyAll(): void {
		for (const waiter of [...this.global]) waiter.fire("changed");
	}

	/** 关闭时把挂起的等待收干净，避免等待方卡到超时。 */
	shutdown(): void {
		for (const waiter of [...this.global]) waiter.fire("aborted");
		this.perId.clear();
		this.global.clear();
	}

	waitFor(ids: Iterable<string>, opts: SettleWaitOptions): Promise<SettleWakeReason> {
		const unique = [...new Set(ids)].filter((id): id is string => typeof id === "string" && id.length > 0);
		const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(0, Math.floor(opts.timeoutMs)) : 0;
		if (opts.signal?.aborted) return Promise.resolve("aborted");
		if (timeoutMs === 0) return Promise.resolve("timeout");

		return new Promise<SettleWakeReason>((resolve) => {
			let done = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (reason: SettleWakeReason): void => {
				if (done) return;
				done = true;
				if (timer) clearTimeout(timer);
				this.global.delete(waiter);
				for (const id of unique) {
					const set = this.perId.get(id);
					if (!set) continue;
					set.delete(waiter);
					if (set.size === 0) this.perId.delete(id);
				}
				opts.signal?.removeEventListener("abort", onAbort);
				resolve(reason);
			};
			const onAbort = (): void => finish("aborted");
			const waiter: SettleWaiter = { fire: (reason) => finish(reason) };
			timer = setTimeout(() => finish("timeout"), timeoutMs);
			timer.unref?.();
			this.global.add(waiter);
			for (const id of unique) {
				const set = this.perId.get(id) ?? new Set<SettleWaiter>();
				set.add(waiter);
				this.perId.set(id, set);
			}
			opts.signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
}
