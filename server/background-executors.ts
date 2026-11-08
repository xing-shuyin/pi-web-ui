/**
 * 后台执行者注册表（Background Executor Registry）
 *
 * 解决的问题：宿主里有四类「无客户端连接也应该活着」的执行者 —— 内置定时任务、常驻插件
 * （QQ/微信/Telegram 等渠道的长连接）、Canvas worker、device-task executor。在此之前
 * 它们各有一套启动时机：定时任务在 `listen` 前直接 `start()`，插件却只能寄生在第一个
 * WebSocket attach 上（`server/index.ts` 的 `ensureLoaded` 调用点），于是「没人打开网页 =
 * QQ 机器人没上线」。
 *
 * 契约：每个执行者声明 `kind: "boot"` 表示进程起来就该跑；`kind: "on-demand"` 只登记不启动。
 * 注册表负责 **启动顺序、失败隔离（一个坏执行者不拖垮其它/不阻断 listen）、健康快照、
 * 按策略的退避重启**。新增后台执行者只需 `register()`，不会再犯「忘记在启动时拉起」的错误。
 *
 * 红线相关：
 * - 探针间隔 60s（远小于 6h 的 `armDelay` 分片门槛），定时器一律 `unref()`。
 * - 重启策略默认 `never`：无人值守时宁可「如实报告 unhealthy」也不要反复拉起抖动的外部连接。
 */
import { randomUUID } from "node:crypto";
export type BackgroundExecutorKind = "boot" | "on-demand";
export type BackgroundExecutorRestartPolicy = "never" | "on-failure";
export type BackgroundExecutorState = "pending" | "running" | "failed" | "stopped";

export interface BackgroundExecutorHealth {
	ok: boolean;
	/** 一行可读状态，进 /api/health 与日志。 */
	detail?: string;
	/** 关键指标（渠道在线数、上次成功投递时间等），原样透出。 */
	stats?: Record<string, unknown>;
}

export interface BackgroundExecutor {
	/** 唯一 id，形如 `plugins:always-on`、`scheduler`。 */
	readonly id: string;
	readonly kind: BackgroundExecutorKind;
	/** 缺省 never：只在快照里报告，不自动重启。 */
	readonly restart?: BackgroundExecutorRestartPolicy;
	/** 失败时抛错即可 —— 注册表会捕获、记入快照，不影响其它执行者。 */
	start(): Promise<void> | void;
	stop?(): Promise<void> | void;
	/** 抛错等价于 `{ ok: false }`，不会中断探针。 */
	health?(): BackgroundExecutorHealth;
}

export interface BackgroundExecutorSnapshot {
	id: string;
	kind: BackgroundExecutorKind;
	state: BackgroundExecutorState;
	startedAt?: number;
	lastError?: string;
	restarts: number;
	health?: BackgroundExecutorHealth;
	healthCheckedAt?: number;
}

export interface BackgroundExecutorRegistryOptions {
	now?: () => number;
	log?: (level: "info" | "warning" | "error", message: string) => void;
	/** 同一执行者两次自动重启之间的最小间隔。 */
	restartCooldownMs?: number;
	/** 单个执行者自动重启次数上限；超过后只报告不再拉。 */
	maxRestarts?: number;
}

interface Entry {
	executor: BackgroundExecutor;
	state: BackgroundExecutorState;
	runId: string;
	startedAt?: number;
	lastError?: string;
	restarts: number;
	health?: BackgroundExecutorHealth;
	healthCheckedAt?: number;
}

const DEFAULT_PROBE_MS = 60_000;
const DEFAULT_RESTART_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_MAX_RESTARTS = 3;

export class BackgroundExecutorRegistry {
	private readonly entries = new Map<string, Entry>();
	private readonly now: () => number;
	private readonly log: NonNullable<BackgroundExecutorRegistryOptions["log"]>;
	private readonly restartCooldownMs: number;
	private readonly maxRestarts: number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private booted = false;

	constructor(opts: BackgroundExecutorRegistryOptions = {}) {
		this.now = opts.now ?? Date.now;
		this.log = opts.log ?? (() => {});
		this.restartCooldownMs = opts.restartCooldownMs ?? DEFAULT_RESTART_COOLDOWN_MS;
		this.maxRestarts = opts.maxRestarts ?? DEFAULT_MAX_RESTARTS;
	}

	register(executor: BackgroundExecutor): void {
		if (!executor.id) throw new Error("background executor requires an id");
		if (this.entries.has(executor.id)) {
			throw new Error(`duplicate background executor id: ${executor.id}`);
		}
		this.entries.set(executor.id, {
			executor,
			state: "pending",
			runId: "",
			restarts: 0,
		});
	}

	/** 是否已跑过 boot 阶段（幂等 guard，供 main 流程断言）。 */
	isBooted(): boolean {
		return this.booted;
	}

	/**
	 * 启动所有 `kind: "boot"` 执行者。**永不抛错** —— 调用方可以安全地在 `listen` 回调里 `void` 它。
	 * 返回本次失败的执行者 id，便于日志/单测断言。
	 */
	async startAll(): Promise<{ started: string[]; failed: string[] }> {
		if (this.booted) return { started: [], failed: [] };
		this.booted = true;
		const started: string[] = [];
		const failed: string[] = [];
		for (const entry of this.entries.values()) {
			if (entry.executor.kind !== "boot") continue;
			const ok = await this.runStart(entry, "boot");
			if (ok) started.push(entry.executor.id);
			else failed.push(entry.executor.id);
		}
		if (failed.length > 0) {
			this.log("warning", `background executors failed to start: ${failed.join(", ")}`);
		}
		return { started, failed };
	}

	/** 逐个刷新健康快照，并按 `restart: "on-failure"` + 冷却/上限执行重启。永不抛错。 */
	async probe(): Promise<void> {
		const at = this.now();
		for (const entry of this.entries.values()) {
			if (entry.state === "stopped") continue;
			const health = this.readHealth(entry);
			entry.health = health;
			entry.healthCheckedAt = at;
			if (entry.executor.restart !== "on-failure") continue;
			const unhealthy = health ? !health.ok : entry.state === "failed";
			if (!unhealthy) continue;
			if (entry.restarts >= this.maxRestarts) continue;
			// 冷却以「上次成功启动的时间」为基准：刚拉起的执行者不因首次探针抖动被立刻重启。
			const since = entry.startedAt ?? at;
			if (at - since < this.restartCooldownMs) continue;
			entry.restarts += 1;
			this.log("warning", `background executor "${entry.executor.id}" unhealthy, restarting`);
			await this.runStart(entry, "restart");
		}
	}

	/** 启动周期性探针（默认 60s，`unref` 不阻止进程退出）。重复调用无副作用。 */
	startProbing(intervalMs = DEFAULT_PROBE_MS): void {
		if (this.timer) return;
		const ms = Math.max(1_000, Math.min(intervalMs, 60 * 60_000));
		this.timer = setInterval(() => void this.probe().catch(() => {}), ms);
		this.timer.unref?.();
	}

	stopProbing(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	async stopAll(): Promise<void> {
		this.stopProbing();
		for (const entry of this.entries.values()) {
			if (entry.state === "pending") continue;
			entry.state = "stopped";
			const stop = entry.executor.stop;
			if (!stop) continue;
			try {
				await stop.call(entry.executor);
			} catch (err) {
				this.log("warning", `background executor "${entry.executor.id}" stop failed: ${errText(err)}`);
			}
		}
	}

	/**
	 * 实时刷新所有执行者的 health（不触发重启策略）。
	 * `/api/health` 必须用这个而不是 `snapshot()` —— 快照里的是上一次探针的值，
	 * 运维看到「积压 N 条 / 死信 M 条」时想要的显然是现在。
	 */
	refreshHealth(): void {
		const at = this.now();
		for (const entry of this.entries.values()) {
			if (!entry.executor.health) continue;
			entry.health = this.readHealth(entry);
			entry.healthCheckedAt = at;
		}
	}

	/** 刷新后取快照（`/api/health` 专用）。 */
	snapshotLive(): BackgroundExecutorSnapshot[] {
		this.refreshHealth();
		return this.snapshot();
	}

	snapshot(): BackgroundExecutorSnapshot[] {
		const out: BackgroundExecutorSnapshot[] = [];
		for (const entry of this.entries.values()) {
			out.push({
				id: entry.executor.id,
				kind: entry.executor.kind,
				state: entry.state,
				...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
				...(entry.lastError ? { lastError: entry.lastError } : {}),
				restarts: entry.restarts,
				...(entry.health ? { health: entry.health } : {}),
				...(entry.healthCheckedAt !== undefined ? { healthCheckedAt: entry.healthCheckedAt } : {}),
			});
		}
		return out;
	}

	/** `/api/health` 用的紧凑视图：只有不 healthy 的才算问题。 */
	unhealthy(): { id: string; state: BackgroundExecutorState; detail: string }[] {
		const out: { id: string; state: BackgroundExecutorState; detail: string }[] = [];
		for (const entry of this.entries.values()) {
			if (entry.executor.kind !== "boot") continue;
			if (entry.state === "pending") {
				out.push({ id: entry.executor.id, state: entry.state, detail: "not started yet" });
				continue;
			}
			if (entry.state === "failed") {
				out.push({ id: entry.executor.id, state: entry.state, detail: entry.lastError ?? "start failed" });
				continue;
			}
			if (entry.health && !entry.health.ok) {
				out.push({ id: entry.executor.id, state: entry.state, detail: entry.health.detail ?? "unhealthy" });
			}
		}
		return out;
	}

	private readHealth(entry: Entry): BackgroundExecutorHealth | undefined {
		const fn = entry.executor.health;
		if (!fn) return undefined;
		try {
			const h = fn.call(entry.executor);
			if (!h || typeof h !== "object") return { ok: true };
			return h;
		} catch (err) {
			return { ok: false, detail: `health() threw: ${errText(err)}` };
		}
	}

	/** 单次启动；失败只记录，不抛。 */
	private async runStart(entry: Entry, reason: "boot" | "restart"): Promise<boolean> {
		const id = entry.executor.id;
		entry.runId = randomUUID();
		const runId = entry.runId;
		entry.state = "running";
		entry.startedAt = this.now();
		entry.lastError = undefined;
		entry.health = undefined;
		entry.healthCheckedAt = undefined;
		try {
			await entry.executor.start();
			// start() 期间被 stop/dispose 抢占：不要把它标成健康。
			if (entry.runId !== runId) return false;
			if (reason === "restart") this.log("info", `background executor "${id}" restarted`);
			return true;
		} catch (err) {
			if (entry.runId !== runId) return false;
			entry.state = "failed";
			entry.lastError = errText(err);
			this.log("error", `background executor "${id}" ${reason} failed: ${entry.lastError}`);
			return false;
		}
	}
}

function errText(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
