/**
 * 子代理派发预算单源（按「运行树」累计）。
 *
 * 并发上限（`PI_WEB_MAX_SUBAGENTS`）只压住同一时刻在跑的个数，深度上限
 * （`subagentMaxDepth`）只压住层级；两者都挡不住「扇出 → 收口 → 再扇出」累计烧钱。
 * 这里按运行树根（最顶层父对话）记累计派发次数：只增不减，失败的那次退还。
 *
 * 默认 64，`PI_WEB_SUBAGENT_MAX_SPAWNS_PER_RUN=0` 关闭该预算。
 */
export const DEFAULT_MAX_SPAWNS_PER_RUN = 64;

/** 记账表上限：超出后丢弃最早建账的树，避免长跑进程无限增长。 */
export const SPAWN_BUDGET_TRACKED_TREES = 512;

export function spawnBudgetLimitFromEnv(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number(env.PI_WEB_SUBAGENT_MAX_SPAWNS_PER_RUN);
	if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MAX_SPAWNS_PER_RUN;
	return Math.floor(raw);
}

export type SpawnBudgetReservation = { ok: true; count: number } | { ok: false; count: number; limit: number };

export class SubagentSpawnBudget {
	private readonly counts = new Map<string, number>();

	constructor(private readonly limit: number = spawnBudgetLimitFromEnv()) {}

	get max(): number {
		return this.limit;
	}

	/** 预留一次派发名额。同步执行，所以批量派发之间不会被并发穿透。 */
	reserve(rootId: string): SpawnBudgetReservation {
		const key = rootId || "session";
		const used = this.counts.get(key) ?? 0;
		if (this.limit > 0 && used >= this.limit) {
			return { ok: false, count: used, limit: this.limit };
		}
		this.counts.set(key, used + 1);
		this.trim();
		return { ok: true, count: used + 1 };
	}

	/** 派发最终失败时退还名额（成功启动的子代理不退还）。 */
	refund(rootId: string): void {
		const key = rootId || "session";
		const used = this.counts.get(key) ?? 0;
		if (used <= 0) return;
		if (used === 1) this.counts.delete(key);
		else this.counts.set(key, used - 1);
	}

	/** 运行树根关闭：整棵树的记账可以作废（新工作重新计数）。 */
	forget(rootId: string): void {
		this.counts.delete(rootId || "session");
	}

	countOf(rootId: string): number {
		return this.counts.get(rootId || "session") ?? 0;
	}

	get size(): number {
		return this.counts.size;
	}

	private trim(): void {
		while (this.counts.size > SPAWN_BUDGET_TRACKED_TREES) {
			const oldest = this.counts.keys().next().value;
			if (oldest === undefined) return;
			this.counts.delete(oldest);
		}
	}
}
