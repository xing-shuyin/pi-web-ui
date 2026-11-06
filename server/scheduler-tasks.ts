import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nextCronFire, parseCronSpec } from "./plugin-schedule.js";
import { writeJsonAtomicSync } from "./atomic-file.js";

export type SchedulerKind = "cron" | "interval";
export type SchedulerCatchUp = "skip" | "once";

export interface SchedulerTaskOrigin {
	sessionFile: string;
	toolCallId: string;
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
	target?: "conversation" | "canvas";
	graphId?: string;
	id: string;
	name: string;
	description: string;
	cwd: string;
	kind: SchedulerKind;
	spec: string;
	prompt: string;
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
	at: number;
	ok: boolean;
	durationMs: number;
	conversationId?: string;
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
			...(rec.target === "canvas" || rec.target === "conversation" ? { target: rec.target } : {}),
			...(typeof rec.graphId === "string" && rec.graphId ? { graphId: rec.graphId.slice(0, 64) } : {}),
			...(typeof rec.runId === "string" && rec.runId ? { runId: rec.runId.slice(0, 128) } : {}),
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

	constructor(
		private readonly dataDir: string,
		private readonly opts: {
			executor?: SchedulerExecutor;
			validateTask?: (task: SchedulerTask) => void;
			onChange?: () => void;
			notify?: (level: "info" | "warning" | "error", text: string, textEn?: string) => void;
			onTaskRemoved?: (taskId: string) => void;
		} = {},
	) {}

	setExecutor(executor: SchedulerExecutor): void {
		this.opts.executor = executor;
	}

	start(): void {
		this.load();
		if (this.started) return;
		this.started = true;
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
						oneShot: r.oneShot as boolean,
					});
					task.createdAt = typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : Date.now();
					task.updatedAt =
						typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : task.createdAt;
					next.set(id, {
						...task,
						...(validOrigin(r.origin) ? { origin: { ...r.origin } } : {}),
						...(typeof r.startedAt === "number" && Number.isFinite(r.startedAt) ? { startedAt: r.startedAt } : {}),
						history: sanitizeHistory(r.history),
					});
				} catch {}
			}
			this.tasks = next;
		} catch {
			this.tasks = new Map();
		}
	}

	private save(next: Map<string, StoredTask>): void {
		const tasks: Record<string, StoredTask> = Object.fromEntries(next);
		writeJsonAtomicSync(schedulerFile(this.dataDir), { v: 1, tasks });
		this.tasks = next;
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

	upsert(input: SchedulerTaskInput, origin?: SchedulerTaskOrigin): SchedulerTask {
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
		this.save(new Map(this.tasks).set(task.id, { ...task, history }));
		this.nextFire.set(task.id, computeNextFire(task, Date.now()) ?? Date.now() + TICK_MS);
		this.changed();
		return task;
	}

	cancelUnstartedFromCalls(sessionFile: string, toolCallIds: ReadonlySet<string>, commit?: () => void): number {
		const next = new Map(this.tasks);
		const removed: string[] = [];
		for (const [id, task] of next) {
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
			next.delete(id);
			removed.push(id);
		}
		const previous = this.tasks;
		if (removed.length) this.save(next);
		try {
			commit?.();
		} catch (err) {
			if (removed.length) {
				try {
					this.save(previous);
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

	remove(id: string): boolean {
		const ok = this.tasks.has(id);
		if (ok) {
			const next = new Map(this.tasks);
			next.delete(id);
			this.save(next);
			this.nextFire.delete(id);
			this.changed();
			try {
				this.opts.onTaskRemoved?.(id);
			} catch {}
		}
		return ok;
	}

	setEnabled(id: string, enabled: boolean): SchedulerTask | null {
		const prev = this.tasks.get(id);
		if (!prev) return null;
		const t = { ...prev, enabled, updatedAt: Date.now() };
		this.save(new Map(this.tasks).set(id, t));
		this.nextFire.set(id, computeNextFire(t, Date.now()) ?? Date.now() + TICK_MS);
		this.changed();
		return { ...t };
	}

	rebind(id: string, binding: { conversationId?: string; sessionFile?: string }): boolean {
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
		this.save(new Map(this.tasks).set(id, t));
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
		if (task.origin && task.startedAt === undefined) {
			try {
				this.save(new Map(this.tasks).set(id, { ...task, startedAt: Date.now() }));
			} catch (err) {
				this.reportFailure(err);
				return { ok: false, error: `Failed to persist scheduled-task start: ${String(err)}` };
			}
		}
		this.running.add(id);
		const startedAt = Date.now();
		const scheduleBase = triggerAt !== undefined ? Math.max(triggerAt, startedAt) : startedAt;
		if (!task.oneShot && !manual) {
			this.nextFire.set(id, computeNextFire(task, scheduleBase) ?? scheduleBase + TICK_MS);
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
			this.recordRun(id, {
				at: Date.now(),
				ok: result.ok,
				durationMs,
				target: task.target ?? "conversation",
				...(task.graphId ? { graphId: task.graphId } : {}),
				...(result.runId ? { runId: result.runId } : {}),
				...(result.conversationId ? { conversationId: result.conversationId } : {}),
				...(result.error ? { error: result.error.slice(0, 500) } : {}),
				...(manual ? { manual } : {}),
			});
			if (task.oneShot) this.remove(id);
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

	private recordRun(id: string, run: SchedulerRunRecord): void {
		const t = this.tasks.get(id);
		if (!t) return;
		const next = { ...t, history: [run, ...sanitizeHistory(t.history)].slice(0, SCHEDULER_HISTORY_MAX) };
		this.save(new Map(this.tasks).set(id, next));
	}
}
