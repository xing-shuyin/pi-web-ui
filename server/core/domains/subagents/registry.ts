import { MAX_SUBAGENTS } from "../../../agent-formatters.js";

export type SubagentSettleState = "done" | "failed" | "stopped";

export interface SubagentRecord {
	id: string;
	parentId: string;
	title: string;
	type: string;
	state: "running" | SubagentSettleState;
	startedAt: number;
	settledAt?: number;
	error?: string;
}

export type SubagentTimerHandle = ReturnType<typeof setTimeout>;
export type SubagentSetTimer = (callback: () => void, ms: number) => SubagentTimerHandle;
export type SubagentClearTimer = (handle: SubagentTimerHandle) => void;

export interface SubagentRegistryOptions {
	now(): number;
	/** 并发闸上限：0 表示不设限（缺省沿用老树同口径的 `MAX_SUBAGENTS`）。 */
	fanoutMax?: number;
	/** 层级上限：`parentId` 已到该层就拒派，0 表示不设限（缺省）。主对话没登记，算 0 层。 */
	depthMax?: number;
	setTimer?: SubagentSetTimer;
	clearTimer?: SubagentClearTimer;
}

export type SubagentLimitReason = "fanout_limit" | "depth_limit";

export class SubagentRegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubagentRegistryError";
	}
}

/** `observed` 是触发时的观测值：fanout 看在跑数量，depth 看父对话层级。 */
export class SubagentLimitError extends Error {
	readonly reason: SubagentLimitReason;
	readonly limit: number;
	readonly observed: number;

	constructor(reason: SubagentLimitReason, limit: number, observed: number) {
		super(`subagent ${reason}: limit ${limit}, observed ${observed}`);
		this.name = "SubagentLimitError";
		this.reason = reason;
		this.limit = limit;
		this.observed = observed;
	}
}

export interface SettleWaitOptions {
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface SettleWaitResult {
	reason: "settled" | "timeout" | "aborted";
	id?: string;
}

interface SettleWaiter {
	ids: Set<string>;
	finish(result: SettleWaitResult): void;
}

const defaultSetTimer: SubagentSetTimer = (callback, ms) => setTimeout(callback, ms);
const defaultClearTimer: SubagentClearTimer = (handle) => clearTimeout(handle);

/** 缺省计时器是 Node 的 `Timeout`，注入的假计时器（测试）不一定带 `unref`。 */
function unrefTimer(handle: SubagentTimerHandle): void {
	const unref = (handle as { unref?: () => void }).unref;
	if (typeof unref === "function") unref.call(handle);
}

function limitOf(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.floor(value));
}

function copyOf(record: SubagentRecord): SubagentRecord {
	return { ...record };
}

/**
 * 子代理账本：谁是子代理、跟谁、什么状态、什么时候起止，只由这里持有。
 * 结算等待是「边沿」语义（任意一个变化就回），由等待方自己重新判定是否真收口。
 */
export class SubagentRegistry {
	private readonly records = new Map<string, SubagentRecord>();
	private readonly waiters = new Set<SettleWaiter>();
	private readonly now: () => number;
	private readonly fanoutMax: number;
	private readonly depthMax: number;
	private readonly setTimer: SubagentSetTimer;
	private readonly clearTimer: SubagentClearTimer;

	constructor(options: SubagentRegistryOptions) {
		this.now = options.now;
		this.fanoutMax = limitOf(options.fanoutMax, MAX_SUBAGENTS);
		this.depthMax = limitOf(options.depthMax, 0);
		this.setTimer = options.setTimer ?? defaultSetTimer;
		this.clearTimer = options.clearTimer ?? defaultClearTimer;
	}

	/** 重复 id 抛 `SubagentRegistryError`：账本不覆盖已有记录。 */
	register(input: { id: string; parentId: string; title: string; type: string }): SubagentRecord {
		if (this.records.has(input.id)) throw new SubagentRegistryError(`subagent ${input.id} already registered`);
		const record: SubagentRecord = {
			id: input.id,
			parentId: input.parentId,
			title: input.title,
			type: input.type,
			state: "running",
			startedAt: this.now(),
		};
		this.records.set(record.id, record);
		return copyOf(record);
	}

	/**
	 * 子代理结算：幂等，重复结算不改状态与时间。
	 * 返回是否「这次调用有账可结」：已结算仍是 true（幂等），未知 id 才是 false。
	 */
	settle(id: string, outcome: { state: SubagentSettleState; error?: string }): boolean {
		const record = this.records.get(id);
		if (!record) return false;
		if (record.settledAt !== undefined) return true;
		record.state = outcome.state;
		record.settledAt = this.now();
		if (outcome.error !== undefined) record.error = outcome.error;
		// 先取快照：`finish` 会把自己从 `this.waiters` 里摘掉。
		const waiters = [...this.waiters];
		for (const waiter of waiters) {
			if (waiter.ids.has(id)) waiter.finish({ reason: "settled", id });
		}
		return true;
	}

	get(id: string): SubagentRecord | undefined {
		const record = this.records.get(id);
		return record ? copyOf(record) : undefined;
	}

	/** `startedAt` 升序；同刻按登记顺序（稳定排序）。`scope.parentId` 只看直系。 */
	list(scope: { parentId?: string } = {}): SubagentRecord[] {
		const parentId = scope.parentId;
		return [...this.records.values()]
			.filter((record) => parentId === undefined || record.parentId === parentId)
			.sort((a, b) => a.startedAt - b.startedAt)
			.map(copyOf);
	}

	childrenOf(parentId: string): SubagentRecord[] {
		return this.list({ parentId });
	}

	/** 并发闸：在跑数量满 `fanoutMax`、或父对话已到 `depthMax` 层就拒（抛 `SubagentLimitError`）。 */
	assertCanSpawn(parentId: string): void {
		const running = this.runningCount();
		if (this.fanoutMax > 0 && running >= this.fanoutMax) {
			throw new SubagentLimitError("fanout_limit", this.fanoutMax, running);
		}
		if (this.depthMax > 0) {
			const depth = this.depthUnder(parentId);
			if (depth >= this.depthMax) throw new SubagentLimitError("depth_limit", this.depthMax, depth);
		}
	}

	/**
	 * 等 `ids` 里任意一个发生状态变化：已有终态立刻回，`settle` 一发生就回。
	 * 四条出口（已终态 / 状态变化 / 超时 / abort）都会清掉定时器与 abort 监听。
	 */
	waitForSettle(ids: readonly string[], opts: SettleWaitOptions): Promise<SettleWaitResult> {
		const unique = [...new Set(ids)].filter((id) => typeof id === "string" && id.length > 0);
		const settled = unique.find((id) => this.records.get(id)?.settledAt !== undefined);
		if (settled !== undefined) return Promise.resolve({ reason: "settled", id: settled });
		if (opts.signal?.aborted) return Promise.resolve({ reason: "aborted" });
		const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(0, Math.floor(opts.timeoutMs)) : 0;
		if (timeoutMs === 0) return Promise.resolve({ reason: "timeout" });

		return new Promise<SettleWaitResult>((resolve) => {
			let done = false;
			let timer: SubagentTimerHandle | undefined;
			const finish = (result: SettleWaitResult): void => {
				if (done) return;
				done = true;
				this.waiters.delete(waiter);
				if (timer !== undefined) {
					this.clearTimer(timer);
					timer = undefined;
				}
				opts.signal?.removeEventListener("abort", onAbort);
				resolve(result);
			};
			const onAbort = (): void => finish({ reason: "aborted" });
			const waiter: SettleWaiter = { ids: new Set(unique), finish };
			this.waiters.add(waiter);
			timer = this.setTimer(() => finish({ reason: "timeout" }), timeoutMs);
			unrefTimer(timer);
			opts.signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	runningCount(): number {
		let count = 0;
		for (const record of this.records.values()) if (record.settledAt === undefined) count++;
		return count;
	}

	/**
	 * 父对话层级：只数登记过的祖先（主对话这类没登记的父算 0 层），有环就截断。
	 * 于是 `depthMax: 1` = 主对话派出去的子代理不能再派（与设置项口径一致）。
	 */
	private depthUnder(parentId: string): number {
		let depth = 0;
		const seen = new Set<string>();
		for (let record = this.records.get(parentId); record && !seen.has(record.id);) {
			seen.add(record.id);
			depth++;
			record = this.records.get(record.parentId);
		}
		return depth;
	}
}
