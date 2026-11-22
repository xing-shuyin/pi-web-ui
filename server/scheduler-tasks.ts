import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nextCronFire, parseCronSpec } from "./plugin-schedule.js";
import { createSerializedJsonWriter, type SerializedJsonWriter } from "./serialized-json-writer.js";
import { MATERIAL_LIMITS } from "./material.js";

export type SchedulerKind = "cron" | "interval";
export type SchedulerCatchUp = "skip" | "once";

export interface SchedulerTaskOrigin {
	sessionFile: string;
	toolCallId: string;
}

/**
 * 一次触发的 identity（issues #976）：
 *
 * `runId` 在**触发那一刻**分配，与 `startedAt` 同一次 `save` 落盘；终态记录后同一次 `save` 清掉。
 * 所以重启后只要看到 `occurrence` 还在，就能确定地说「这次触发没有终态记录」，
 * 而不是靠猜（旧实现只留一个 `startedAt`，既分不清「没跑」也分不清「跑完了没记」）。
 *
 * 不改变 `startedAt` 语义：它仍是「这个 task 曾经开始过」，`cancelUnstartedFromCalls` 依赖它。
 */
export interface SchedulerOccurrence {
	runId: string;
	/** 这次触发本来该跑的时刻（cron / interval 的槽位时间）；手动触发时为触发时间。 */
	scheduledFor: number;
}

export interface SchedulerTaskInput {
	target?: "conversation" | "canvas";
	graphId?: string;
	id?: string;
	name?: string;
	description?: string;
	cwd?: string;
	kind?: SchedulerKind;
	spec?: string | number;
	prompt?: string;
	/** 材料指针（路径字符串，相对 `cwd` 解释）；见 docs/proposals/material-spec-contract.md */
	materials?: string[];
	enabled?: boolean;
	model?: string;
	thinkingLevel?: string;
	catchUp?: SchedulerCatchUp;
	conversationId?: string;
	sessionFile?: string;
	oneShot?: boolean;
}

export interface SchedulerTask {
	origin?: SchedulerTaskOrigin;
	startedAt?: number;
	/** 非空 = 触发过但没有终态记录（重启后据此报「结果未知」）。 */
	occurrence?: SchedulerOccurrence;
	target?: "conversation" | "canvas";
	graphId?: string;
	id: string;
	name: string;
	description: string;
	cwd: string;
	kind: SchedulerKind;
	spec: string;
	prompt: string;
	/**
	 * 材料指针：规格里只存**路径字符串**（契约 R1）。
	 * 存在性 / 去重 / 清单 / 跨 cwd 搬迁全部由执行前的 `material.ts` 负责，这里只保存形状。
	 */
	materials?: string[];
	enabled: boolean;
	model: string;
	thinkingLevel: string;
	catchUp: SchedulerCatchUp;
	conversationId: string;
	sessionFile: string;
	oneShot: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface SchedulerRunRecord {
	target?: "conversation" | "canvas";
	graphId?: string;
	runId?: string;
	/** 这次运行的槽位时间（occurrence 对账用） */
	scheduledFor?: number;
	at: number;
	ok: boolean;
	durationMs: number;
	conversationId?: string;
	/** 本次运行报告的会话文件：持有方没了也能打开历史对话 */
	sessionFile?: string;
	error?: string;
	manual?: boolean;
}

export interface SchedulerTaskView extends SchedulerTask {
	nextFire: number | null;
	lastRun: SchedulerRunRecord | null;
	history: SchedulerRunRecord[];
	running: boolean;
}

export interface SchedulerExecutorResult {
	target?: "conversation" | "canvas";
	graphId?: string;
	runId?: string;
	ok: boolean;
	conversationId?: string;
	sessionFile?: string;
	/**
	 * 只用于**补录持久地址**（老任务第一次真正投回原对话时）。
	 * 只有「成功投回原对话」的回执才允许填，转后台执行的路径一律留空：
	 * 否则失败→转后台会把它当成新地址写回任务绑定（#959 的错就是这样传开的）。
	 */
	backfill?: { conversationId?: string; sessionFile?: string };
	error?: string;
}

export type SchedulerExecutor = (task: SchedulerTask) => Promise<SchedulerExecutorResult>;

export const SCHEDULER_FILE = "scheduler-tasks.json";
export const SCHEDULER_MIN_INTERVAL_MS = 60_000;
export const SCHEDULER_MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
export const SCHEDULER_HISTORY_MAX = 20;
const TICK_MS = 10_000;

export const SCHEDULER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function schedulerFile(dataDir: string): string {
	return join(dataDir, SCHEDULER_FILE);
}

function randomTaskId(): string {
	const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
	let s = "";
	for (let i = 0; i < 6; i++) s += abc[Math.floor(Math.random() * abc.length)];
	return `task-${s}`;
}

function randomOccurrenceId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SchedulerValidationError extends Error {
	constructor(
		public readonly code: string,
		public readonly messageZh: string,
		public readonly messageEn: string,
	) {
		super(messageZh);
		this.name = "SchedulerValidationError";
	}
}

/**
 * 规格里的材料指针只做**形状**校验（契约 R1/R8）：字符串数组、去空、≤ `MATERIAL_LIMITS.maxItems`。
 * 这里**不 stat、不解析、不拼清单文案**——存在性 / 去重 / 清单都在执行前的 `normalizeMaterials()`。
 */
function sanitizeMaterials(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const ref = item.trim();
		if (!ref) continue;
		out.push(ref);
		if (out.length >= MATERIAL_LIMITS.maxItems) break;
	}
	return out;
}

export function normalizeSchedulerInput(input: SchedulerTaskInput, now = Date.now()): SchedulerTask {
	const idRaw = String(input.id ?? "").trim();
	const id = idRaw || randomTaskId();
	if (!SCHEDULER_ID_RE.test(id)) {
		throw new SchedulerValidationError(
			"invalid_id",
			"任务 id 非法（只收字母/数字/下划线/连字符，≤64 字）",
			"Invalid task id (letters/numbers/underscores/hyphens only, <= 64 chars)",
		);
	}
	const name = String(input.name ?? "")
		.trim()
		.slice(0, 80);
	if (!name) {
		throw new SchedulerValidationError("empty_name", "任务名称不能为空", "Task name cannot be empty");
	}
	const description = String(input.description ?? "")
		.trim()
		.slice(0, 500);
	const cwd = String(input.cwd ?? "").trim();
	if (!cwd) {
		throw new SchedulerValidationError(
			"empty_cwd",
			"执行目标项目（cwd）不能为空",
			"Target project directory (cwd) cannot be empty",
		);
	}
	const kind: SchedulerKind = input.kind === "interval" ? "interval" : "cron";
	let spec: string;
	if (kind === "cron") {
		spec = String(input.spec ?? "")
			.trim()
			.replace(/\s+/g, " ");
		if (!parseCronSpec(spec)) {
			throw new SchedulerValidationError(
				"invalid_cron",
				"cron 表达式非法（要 5 字段：分 时 日 月 周，如 0 9 * * *）",
				"Invalid cron expression (requires 5 fields: min hour day month weekday, e.g. 0 9 * * *)",
			);
		}
	} else {
		const ms = Math.floor(Number(input.spec));
		if (!Number.isFinite(ms) || ms <= 0) {
			throw new SchedulerValidationError("invalid_interval", "间隔毫秒数非法", "Invalid interval milliseconds");
		}
		if (ms < SCHEDULER_MIN_INTERVAL_MS) {
			throw new SchedulerValidationError(
				"interval_too_short",
				`间隔太短（最短 ${SCHEDULER_MIN_INTERVAL_MS / 1000}s，防 token 烧穿）`,
				`Interval too short (minimum ${SCHEDULER_MIN_INTERVAL_MS / 1000}s)`,
			);
		}
		if (ms > SCHEDULER_MAX_INTERVAL_MS) {
			throw new SchedulerValidationError(
				"interval_too_long",
				"间隔太长（最长 30 天）",
				"Interval too long (maximum 30 days)",
			);
		}
		spec = String(ms);
	}
	if (input.target !== undefined && input.target !== "conversation" && input.target !== "canvas") {
		throw new SchedulerValidationError("invalid_target", "任务目标非法", "Invalid task target");
	}
	const graphId = String(input.graphId ?? "").trim();
	const target = input.target ?? (graphId ? "canvas" : "conversation");
	if (target === "canvas" && (!/^[A-Za-z0-9._-]{1,64}$/.test(graphId) || graphId === "." || graphId === "..")) {
		throw new SchedulerValidationError(
			"invalid_graph_id",
			"画布工程 id 非法或为空",
			"Invalid or missing canvas graph id",
		);
	}
	const prompt = String(input.prompt ?? "").trim();
	if (!prompt && target === "conversation") {
		throw new SchedulerValidationError(
			"empty_prompt",
			"触发指令（prompt）不能为空",
			"Trigger instruction (prompt) cannot be empty",
		);
	}
	if (prompt.length > 8000) {
		throw new SchedulerValidationError(
			"prompt_too_long",
			"触发指令超长（>8000 字），请裁剪后重试",
			"Trigger instruction too long (>8000 characters), please shorten and retry",
		);
	}
	const model = target === "canvas" ? "" : String(input.model ?? "").trim();
	if (model && !model.includes("/")) {
		throw new SchedulerValidationError(
			"invalid_model",
			"模型格式非法（应为 provider/id）",
			"Invalid model format (expected provider/id)",
		);
	}
	const thinkingLevel = target === "canvas" ? "" : String(input.thinkingLevel ?? "").trim();
	const catchUp: SchedulerCatchUp = input.catchUp === "once" ? "once" : "skip";
	const conversationId = String(input.conversationId ?? "")
		.trim()
		.slice(0, 128);
	const sessionFile = String(input.sessionFile ?? "")
		.trim()
		.slice(0, 1024);
	const materials = sanitizeMaterials(input.materials);
	return {
		id,
		target,
		...(target === "canvas" ? { graphId } : {}),
		name,
		description,
		cwd,
		kind,
		spec,
		prompt,
		...(materials.length ? { materials } : {}),
		enabled: input.enabled !== false,
		model,
		thinkingLevel,
		catchUp,
		conversationId: target === "canvas" ? "" : conversationId,
		sessionFile: target === "canvas" ? "" : sessionFile,
		oneShot: input.oneShot === true,
		createdAt: now,
		updatedAt: now,
	};
}

export function computeNextFire(task: Pick<SchedulerTask, "kind" | "spec">, fromMs: number): number | null {
	try {
		if (task.kind === "cron") {
			const parts = parseCronSpec(task.spec);
			if (!parts) return null;
			return nextCronFire(parts, fromMs);
		}
		const ms = Math.floor(Number(task.spec));
		if (!Number.isFinite(ms) || ms <= 0) return null;
		return Math.floor(Number(fromMs)) + ms;
	} catch {
		return null;
	}
}

export function describeIntervalMs(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `每 ${s} 秒`;
	if (s < 3600) {
		const m = Math.floor(s / 60);
		return s % 60 === 0 ? `每 ${m} 分钟` : `每 ${m} 分 ${s % 60} 秒`;
	}
	if (s < 86400) {
		const h = Math.floor(s / 3600);
		return s % 3600 === 0 ? `每 ${h} 小时` : `每 ${h} 小时 ${Math.floor((s % 3600) / 60)} 分`;
	}
	const d = Math.floor(s / 86400);
	return `每 ${d} 天`;
}

function validOrigin(value: unknown): value is SchedulerTaskOrigin {
	if (!value || typeof value !== "object") return false;
	const origin = value as SchedulerTaskOrigin;
	return (
		typeof origin.sessionFile === "string" &&
		origin.sessionFile.length > 0 &&
		origin.sessionFile.length <= 4096 &&
		typeof origin.toolCallId === "string" &&
		origin.toolCallId.length > 0 &&
		origin.toolCallId.length <= 1024
	);
}

function validOccurrence(value: unknown): value is SchedulerOccurrence {
	if (!value || typeof value !== "object") return false;
	const occ = value as SchedulerOccurrence;
	return (
		typeof occ.runId === "string" &&
		occ.runId.length > 0 &&
		occ.runId.length <= 128 &&
		typeof occ.scheduledFor === "number" &&
		Number.isFinite(occ.scheduledFor)
	);
}

interface StoredTask extends SchedulerTask {
	history?: SchedulerRunRecord[];
}

function sanitizeHistory(v: unknown): SchedulerRunRecord[] {
	if (!Array.isArray(v)) return [];
	const out: SchedulerRunRecord[] = [];
	for (const r of v) {
		if (!r || typeof r !== "object") continue;
		const rec = r as Record<string, unknown>;
		if (typeof rec.at !== "number" || !Number.isFinite(rec.at)) continue;
		out.push({
			at: rec.at,
			ok: rec.ok === true,
			durationMs: typeof rec.durationMs === "number" && Number.isFinite(rec.durationMs) ? rec.durationMs : 0,
			...(typeof rec.conversationId === "string" && rec.conversationId ? { conversationId: rec.conversationId } : {}),
			...(typeof rec.sessionFile === "string" && rec.sessionFile
				? { sessionFile: rec.sessionFile.slice(0, 4096) }
				: {}),
			...(rec.target === "canvas" || rec.target === "conversation" ? { target: rec.target } : {}),
			...(typeof rec.graphId === "string" && rec.graphId ? { graphId: rec.graphId.slice(0, 64) } : {}),
			...(typeof rec.runId === "string" && rec.runId ? { runId: rec.runId.slice(0, 128) } : {}),
			...(typeof rec.scheduledFor === "number" && Number.isFinite(rec.scheduledFor)
				? { scheduledFor: rec.scheduledFor }
				: {}),
			...(typeof rec.error === "string" && rec.error ? { error: rec.error.slice(0, 500) } : {}),
			...(rec.manual === true ? { manual: true as const } : {}),
		});
	}
	return out.sort((a, b) => b.at - a.at).slice(0, SCHEDULER_HISTORY_MAX);
}

export function sameSessionFile(a: string, b: string): boolean {
	const x = String(a ?? "").trim();
	const y = String(b ?? "").trim();
	if (!x || !y) return false;
	const norm = (s: string): string => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	return norm(x) === norm(y);
}

export class SchedulerStore {
	private tasks = new Map<string, StoredTask>();
	private nextFire = new Map<string, number>();
	private running = new Set<string>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private started = false;

	/**
	 * 落盘队列：调度任务是真相（重启后要照原样恢复），所以 mutator 必须等到落盘再返回——
	 * 否则「新建一个 SchedulerStore 读同一个文件」会读到旧任务。同一个队列也让读侧的
	 * 重启对账（在同步的 start() 里执行）不会逆序覆盖后面的写入。
	 */
	private writer: SerializedJsonWriter;
	/** 变更与落盘的串行链（见 commit）。 */
	private chain: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly dataDir: string,
		private readonly opts: {
			executor?: SchedulerExecutor;
			validateTask?: (task: SchedulerTask) => void;
			onChange?: () => void;
			notify?: (level: "info" | "warning" | "error", text: string, textEn?: string) => void;
			onTaskRemoved?: (taskId: string) => void;
		} = {},
	) {
		this.writer = createSerializedJsonWriter(schedulerFile(this.dataDir), { label: "scheduler-tasks" });
	}

	setExecutor(executor: SchedulerExecutor): void {
		this.opts.executor = executor;
	}

	start(): void {
		this.load();
		if (this.started) return;
		this.started = true;
		this.reconcileInterruptedRuns();
		const now = Date.now();
		for (const task of this.tasks.values()) {
			if (!task.enabled) continue;
			const lastAt = task.history?.[0]?.at ?? task.updatedAt;
			const next = computeNextFire(task, Math.max(lastAt, task.updatedAt));
			if (next === null) continue;
			if (next <= now && task.catchUp === "once" && lastAt < now) {
				this.nextFire.set(task.id, now + 5000);
				void this.fire(task.id, false).catch((err) => this.reportFailure(err));
			} else if (next <= now) {
				this.nextFire.set(task.id, computeNextFire(task, now) ?? now + TICK_MS);
			} else {
				this.nextFire.set(task.id, next);
			}
		}
		this.timer = setInterval(() => void this.tick().catch((err) => this.reportFailure(err)), TICK_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.started = false;
	}

	load(): void {
		try {
			const parsed = JSON.parse(readFileSync(schedulerFile(this.dataDir), "utf8")) as {
				v?: unknown;
				tasks?: unknown;
			};
			if (!parsed || typeof parsed !== "object" || !parsed.tasks || typeof parsed.tasks !== "object") {
				this.tasks = new Map();
				return;
			}
			const next = new Map<string, StoredTask>();
			for (const [id, raw] of Object.entries(parsed.tasks as Record<string, unknown>)) {
				if (!raw || typeof raw !== "object") continue;
				const r = raw as Record<string, unknown>;
				try {
					const task = normalizeSchedulerInput({
						id,
						target: r.target as SchedulerTaskInput["target"],
						graphId: r.graphId as string,
						name: r.name as string,
						description: r.description as string,
						cwd: r.cwd as string,
						kind: r.kind as SchedulerKind,
						spec: r.spec as string,
						prompt: r.prompt as string,
						enabled: r.enabled as boolean,
						model: r.model as string,
						thinkingLevel: r.thinkingLevel as string,
						catchUp: r.catchUp as SchedulerCatchUp,
						conversationId: r.conversationId as string,
						sessionFile: (r as { sessionFile?: unknown }).sessionFile as string,
						materials: (r as { materials?: unknown }).materials as string[],
						oneShot: r.oneShot as boolean,
					});
					task.createdAt = typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : Date.now();
					task.updatedAt =
						typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : task.createdAt;
					next.set(id, {
						...task,
						...(validOrigin(r.origin) ? { origin: { ...r.origin } } : {}),
						...(typeof r.startedAt === "number" && Number.isFinite(r.startedAt) ? { startedAt: r.startedAt } : {}),
						...(validOccurrence(r.occurrence) ? { occurrence: { ...r.occurrence } } : {}),
						history: sanitizeHistory(r.history),
					});
				} catch {}
			}
			this.tasks = next;
		} catch {
			this.tasks = new Map();
		}
	}

	private snapshot(next: Map<string, StoredTask>) {
		const tasks: Record<string, StoredTask> = Object.fromEntries(next);
		return { v: 1, tasks };
	}

	/**
	 * 真值提交：把这次变更应用到**最新状态**上，串行落盘，写完才切换内存投影。
	 *
	 * 为什么不是「先算好整张表再写」：落盘是异步的，两个变更之间出现了 await 窗口；
	 * 各自拿着旧快照去写就会互相覆盖（同步写时代这个窗口不存在，所以以前随便写都对）。
	 * 传入变更函数、在队列里才读最新状态，才是把 old 语义完整带过来。
	 * 落盘失败则不提交（内存保持原样，调用方各自兜底）。
	 */
	private commit(apply: (tasks: Map<string, StoredTask>) => void): Promise<void> {
		const run = async () => {
			const next = new Map(this.tasks);
			apply(next);
			await this.persist(this.snapshot(next));
			this.tasks = next;
		};
		const chained = this.chain.then(run, run);
		this.chain = chained.catch(() => {});
		return chained;
	}

	/** 同步读侧（start() 的重启对账）触发的清理：排队提交，不阻塞启动。 */
	private queueCommit(apply: (tasks: Map<string, StoredTask>) => void): void {
		void this.commit(apply).catch((err) => this.reportFailure(err));
	}

	/**
	 * 同一文件的写入共有一条队列（顺序不变量只住在这里）。
	 * 队列的链一经拒绝就永久拒绝（见 `serialized-json-writer`），所以失败后换一条新链：
	 * 否则一次磁盘抖动会让调度任务从此再也写不下去。
	 */
	private async persist(snapshot: ReturnType<SchedulerStore["snapshot"]>): Promise<void> {
		try {
			await this.writer.writeNow(snapshot);
		} catch (error) {
			this.writer = createSerializedJsonWriter(schedulerFile(this.dataDir), { label: "scheduler-tasks" });
			throw error;
		}
	}

	private reportFailure(err: unknown): void {
		console.error("[scheduler] execution failed:", err);
	}

	private notify(...args: Parameters<NonNullable<typeof this.opts.notify>>): void {
		try {
			this.opts.notify?.(...args);
		} catch (err) {
			this.reportFailure(err);
		}
	}

	private changed(): void {
		try {
			this.opts.onChange?.();
		} catch {}
	}

	list(): SchedulerTaskView[] {
		const now = Date.now();
		return [...this.tasks.values()]
			.map((t) => {
				const history = sanitizeHistory(t.history);
				return {
					id: t.id,
					target: t.target ?? "conversation",
					...(t.graphId ? { graphId: t.graphId } : {}),
					name: t.name,
					description: t.description,
					cwd: t.cwd,
					kind: t.kind,
					spec: t.spec,
					prompt: t.prompt,
					...(t.materials?.length ? { materials: [...t.materials] } : {}),
					enabled: t.enabled,
					model: t.model,
					thinkingLevel: t.thinkingLevel,
					catchUp: t.catchUp,
					conversationId: t.conversationId,
					sessionFile: t.sessionFile ?? "",
					oneShot: t.oneShot,
					...(t.origin ? { origin: { ...t.origin } } : {}),
					...(t.startedAt !== undefined ? { startedAt: t.startedAt } : {}),
					createdAt: t.createdAt,
					updatedAt: t.updatedAt,
					nextFire: !t.enabled ? null : (this.nextFire.get(t.id) ?? computeNextFire(t, Math.max(now, t.updatedAt))),
					lastRun: history[0] ?? null,
					history,
					running: this.running.has(t.id),
				} satisfies SchedulerTaskView;
			})
			.sort((a, b) => a.name.localeCompare(b.name, "zh"));
	}

	async upsert(input: SchedulerTaskInput, origin?: SchedulerTaskOrigin): Promise<SchedulerTask> {
		if (origin !== undefined && !validOrigin(origin)) throw new Error("Invalid scheduled-task creation origin");
		const prev = this.tasks.get(String(input.id ?? "").trim());
		const task = normalizeSchedulerInput({
			...input,
			...(prev && input.target === undefined && input.graphId === undefined
				? { target: prev.target, graphId: prev.graphId }
				: {}),
		});
		if (origin) task.origin = { ...origin };
		if (prev) {
			task.origin = prev.origin;
			task.startedAt = prev.startedAt;
			task.createdAt = prev.createdAt;
			task.updatedAt = Date.now();
			// 面板编辑不会重发 materials（它是 AI 侧输入）：省略 = 保持原值；显式 [] = 清空。
			if (input.materials === undefined && prev.materials?.length) task.materials = [...prev.materials];
			if (
				task.target !== "canvas" &&
				prev.target !== "canvas" &&
				input.conversationId === undefined &&
				input.sessionFile === undefined
			) {
				task.conversationId = prev.conversationId;
				task.sessionFile = prev.sessionFile ?? "";
			}
		}
		this.opts.validateTask?.(task);
		const history = prev?.history ? sanitizeHistory(prev.history) : [];
		await this.commit((tasks) => tasks.set(task.id, { ...task, history }));
		this.nextFire.set(task.id, computeNextFire(task, Date.now()) ?? Date.now() + TICK_MS);
		this.changed();
		return task;
	}

	async cancelUnstartedFromCalls(
		sessionFile: string,
		toolCallIds: ReadonlySet<string>,
		commit?: () => void,
	): Promise<number> {
		const removed: string[] = [];
		for (const [id, task] of this.tasks) {
			if (
				!task.origin ||
				!(process.platform === "win32"
					? sameSessionFile(task.origin.sessionFile, sessionFile)
					: task.origin.sessionFile === sessionFile) ||
				!toolCallIds.has(task.origin.toolCallId) ||
				this.running.has(id) ||
				task.startedAt !== undefined ||
				task.history?.length
			)
				continue;
			removed.push(id);
		}
		const previous = this.tasks;
		if (removed.length)
			await this.commit((tasks) => {
				for (const id of removed) tasks.delete(id);
			});
		try {
			commit?.();
		} catch (err) {
			if (removed.length) {
				try {
					await this.commit((tasks) => {
						for (const id of removed) {
							const before = previous.get(id);
							if (before) tasks.set(id, before);
						}
					});
				} catch (restoreError) {
					throw new Error(
						`Transcript update failed (${String(err)}); scheduled tasks could not be restored (${String(restoreError)}). Inspect the scheduler before retrying.`,
					);
				}
			}
			throw err;
		}
		if (!removed.length) return 0;
		for (const id of removed) {
			this.nextFire.delete(id);
			try {
				this.opts.onTaskRemoved?.(id);
			} catch (err) {
				this.reportFailure(err);
			}
		}
		this.changed();
		return removed.length;
	}

	async remove(id: string): Promise<boolean> {
		const ok = this.tasks.has(id);
		if (ok) {
			await this.commit((tasks) => tasks.delete(id));
			this.nextFire.delete(id);
			this.changed();
			try {
				this.opts.onTaskRemoved?.(id);
			} catch {}
		}
		return ok;
	}

	async setEnabled(id: string, enabled: boolean): Promise<SchedulerTask | null> {
		const prev = this.tasks.get(id);
		if (!prev) return null;
		const t = { ...prev, enabled, updatedAt: Date.now() };
		await this.commit((tasks) => tasks.set(id, t));
		this.nextFire.set(id, computeNextFire(t, Date.now()) ?? Date.now() + TICK_MS);
		this.changed();
		return { ...t };
	}

	async rebind(id: string, binding: { conversationId?: string; sessionFile?: string }): Promise<boolean> {
		const prev = this.tasks.get(id);
		if (!prev || prev.target === "canvas") return false;
		const t = { ...prev };
		let dirty = false;
		if (binding.conversationId !== undefined) {
			const v = String(binding.conversationId ?? "")
				.trim()
				.slice(0, 128);
			if (v !== t.conversationId) {
				t.conversationId = v;
				dirty = true;
			}
		}
		if (binding.sessionFile !== undefined) {
			const v = String(binding.sessionFile ?? "")
				.trim()
				.slice(0, 1024);
			if (v !== (t.sessionFile ?? "")) {
				t.sessionFile = v;
				dirty = true;
			}
		}
		if (!dirty) return false;
		t.updatedAt = Date.now();
		await this.commit((tasks) => tasks.set(id, t));
		this.changed();
		return true;
	}

	async tick(now = Date.now()): Promise<void> {
		for (const task of this.tasks.values()) {
			if (!task.enabled) continue;
			let next = this.nextFire.get(task.id);
			if (next === undefined) {
				next = computeNextFire(task, Math.max(now, task.updatedAt)) ?? now + TICK_MS;
				this.nextFire.set(task.id, next);
			}
			if (this.running.has(task.id)) {
				if (next <= now) {
					const nextSlot = computeNextFire(task, now) ?? now + TICK_MS;
					this.nextFire.set(task.id, nextSlot);
					this.changed();
					this.notify(
						"info",
						`定时任务「${task.name}」上一轮仍在执行中，本次定时触发已顺延至下个周期（${new Date(nextSlot).toLocaleTimeString()}）。`,
						`Scheduled task "${task.name}" is still running from previous turn; postponed to next interval (${new Date(nextSlot).toLocaleTimeString()}).`,
					);
				}
				continue;
			}
			if (next <= now) {
				void this.fire(task.id, false, now).catch((err) => this.reportFailure(err));
			}
		}
	}

	async runNow(id: string): Promise<SchedulerExecutorResult> {
		const task = this.tasks.get(id);
		if (!task) return { ok: false, error: "任务不存在" };
		if (this.running.has(id)) return { ok: false, error: "任务正在执行中" };
		return this.fire(id, true);
	}

	private async fire(id: string, manual: boolean, triggerAt?: number): Promise<SchedulerExecutorResult> {
		const task = this.tasks.get(id);
		if (!task) return { ok: false, error: "任务不存在" };
		const executor = this.opts.executor;
		const startedAt = Date.now();
		// occurrence 与 startedAt 必须同一次 save 落盘：分开写就会出现「记了开始、没记 identity」的窗口。
		const occurrence: SchedulerOccurrence = {
			runId: `run-${randomOccurrenceId()}`,
			scheduledFor: triggerAt !== undefined ? Math.max(0, triggerAt) : startedAt,
		};
		const scheduleBase = triggerAt !== undefined ? Math.max(triggerAt, startedAt) : startedAt;
		// 运行位与下次触发时间必须在第一个 await 之前落到内存：落盘是异步的，否则同一个 tick 里的
		// 第二次触发会穿过重入检查，面板也会在那几毫秒里显示成「没在跑」。落盘失败时逐个回滚，
		// 保持「写失败 = 没开始」这条旧语义。
		const prevNextFire = this.nextFire.get(id);
		this.running.add(id);
		if (!task.oneShot && !manual) {
			this.nextFire.set(id, computeNextFire(task, scheduleBase) ?? scheduleBase + TICK_MS);
		}
		try {
			await this.commit((tasks) =>
				tasks.set(id, {
					...(tasks.get(id) ?? task),
					occurrence,
					...(task.origin && task.startedAt === undefined ? { startedAt } : {}),
				}),
			);
		} catch (err) {
			// 落盘失败 = 这次触发**没有留下运行记录**：不执行（否则会产生没有任何痕迹的副作用，
			// 重启对账也无从判断结果），回滚「已开始」投影并如实告警，下一次槽位再试。
			this.running.delete(id);
			// 保留已推进的下次触发时间：失败一次不该在同一槽位反复重试。
			if (prevNextFire === undefined) this.nextFire.delete(id);
			this.reportFailure(err);
			const persistError = `Failed to persist scheduled-task start: ${String(err)}`;
			this.notify(
				"warning",
				`定时任务「${task.name}」${manual ? "手动" : "定时"}触发失败：${persistError}`,
				`Scheduled task "${task.name}" ${manual ? "manual" : "automatic"} run failed: ${persistError}`,
			);
			return { ok: false, error: persistError };
		}
		this.changed();
		let result: SchedulerExecutorResult;
		try {
			result = executor
				? await executor({ ...task })
				: { ok: false, error: "调度器执行器未接入（当前引擎不支持定时任务）" };
		} catch (err) {
			result = { ok: false, error: String(err instanceof Error ? err.message : err) };
		}
		const durationMs = Date.now() - startedAt;
		try {
			await this.recordRun(id, {
				at: Date.now(),
				ok: result.ok,
				durationMs,
				target: task.target ?? "conversation",
				...(task.graphId ? { graphId: task.graphId } : {}),
				// 执行器没给 runId 时用触发分配的 identity：历史与账本才对得上同一次运行。
				runId: result.runId ?? occurrence.runId,
				scheduledFor: occurrence.scheduledFor,
				...(result.conversationId ? { conversationId: result.conversationId } : {}),
				...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
				...(result.error ? { error: result.error.slice(0, 500) } : {}),
				...(manual ? { manual } : {}),
			});
			if (task.oneShot) await this.remove(id);
		} catch (err) {
			result = {
				ok: false,
				error: `Failed to persist scheduled-task run: ${String(err instanceof Error ? err.message : err)}`,
			};
			this.reportFailure(err);
		} finally {
			const cur = this.tasks.get(id);
			if (cur && task.oneShot) {
				this.tasks.set(id, { ...cur, enabled: false });
				this.nextFire.delete(id);
			} else if (cur && cur.enabled && !manual) {
				if (cur.kind === "interval") {
					this.nextFire.set(id, computeNextFire(cur, Date.now()) ?? Date.now() + TICK_MS);
				} else {
					const currentNext = this.nextFire.get(id);
					if (currentNext === undefined || currentNext <= Date.now()) {
						this.nextFire.set(id, computeNextFire(cur, Date.now()) ?? Date.now() + TICK_MS);
					}
				}
			}
			this.running.delete(id);
			this.changed();
		}
		const label = `⏰ ${task.name}`;
		if (result.ok) {
			this.notify(
				"info",
				`定时任务「${task.name}」${manual ? "手动" : "定时"}触发完成（${(durationMs / 1000).toFixed(0)}s）——${label}`,
				`Scheduled task "${task.name}" ${manual ? "manually" : "automatically"} finished (${Math.round(durationMs / 1000)}s) — ${label}`,
			);
		} else {
			this.notify(
				"warning",
				`定时任务「${task.name}」${manual ? "手动" : "定时"}触发失败：${result.error ?? "未知错误"}`,
				`Scheduled task "${task.name}" ${manual ? "manual" : "automatic"} run failed: ${result.error ?? "unknown error"}`,
			);
		}
		return result;
	}

	private async recordRun(id: string, run: SchedulerRunRecord): Promise<void> {
		if (!this.tasks.has(id)) return;
		// 终态与「清 occurrence」必须同一次提交：中间崩溃会留下「有终态但仍有待对账记录」的假象。
		// 在提交时才读当前行：执行器等着的这段时间里面板可能的编辑不能被这条运行记录盖掉。
		await this.commit((tasks) => {
			const t = tasks.get(id);
			if (!t) return;
			const { occurrence: _settled, ...rest } = t;
			tasks.set(id, { ...rest, history: [run, ...sanitizeHistory(t.history)].slice(0, SCHEDULER_HISTORY_MAX) });
		});
	}

	/**
	 * 重启对账（issues #976）：上一次进程留下了 `occurrence` 却没有终态记录 = 这次触发的结果未知。
	 * 不静默重投（会真的再跑一遍、可能重复推送/重复写数据），只如实告知并提示手动 `runNow`。
	 */
	private reconcileInterruptedRuns(): void {
		const pending = [...this.tasks.values()].filter((task) => task.occurrence);
		if (pending.length === 0) return;
		for (const task of pending) {
			const { occurrence: lost } = task;
			const when = new Date(lost?.scheduledFor ?? Date.now()).toLocaleString();
			this.notify(
				"warning",
				`定时任务「${task.name}」上次触发（${when}，runId=${lost?.runId ?? "?"}）没有留下结果记录：结果未知。本次不会自动重投，需要的话请手动「立即运行」。`,
				`Scheduled task "${task.name}" was fired at ${when} (runId=${lost?.runId ?? "?"}) but never recorded a result: outcome unknown. It will not be re-fired automatically — use "Run now" if you need it.`,
			);
		}
		// start() 是同步启动钩子：这里只排队提交（同一条队列，不会逆序覆盖后面的写入）。
		this.queueCommit((tasks) => {
			for (const task of pending) {
				const cur = tasks.get(task.id);
				if (!cur) continue;
				const { occurrence: _lost, ...rest } = cur;
				tasks.set(task.id, rest);
			}
		});
		this.changed();
	}
}
