/**
 * 子代理运行账本（run ledger）：把每次派发的生命周期落到 `<dataDir>/subagent-runs/<runId>/`，
 * 让「工作不会因为重启就消失」——重启后仍能列出、取回证据与结果尾部，并据此续跑。
 *
 * 两层文件，职责不重叠：
 *   · `status.json` —— 机器可读的当前状态（原子替换，最后写者胜）。
 *   · `events.jsonl` —— 追加式生命周期流水（有字节上限，截断后打一条标记就不再写）。
 *
 * 三条硬约束：
 *   1. **不阻塞热路径**：所有写入进每个 run 的串行队列，调用方 fire-and-forget；失败只记 `lastError`，
 *      绝不让账本问题打断派发或回合结束。
 *   2. **有界**：run 目录数（默认 200）、单条 run 的事件字节（256KB）、prompt/输出尾部都有上限。
 *   3. **重启可辨别**：每条记录带本进程 `bootId`；`recover()` 只把「别的 boot 留下的 running」判为
 *      interrupted，绝不猜活着的运行。
 *
 * 续跑语义见 `resumeLedgerRun`：进程内子代理会话不落盘，因此续跑是「带上下文重派」（relaunch），
 * 不是假装接上原转录；落盘的持久化子代理仍在历史里可回看，账本给出 sessionFile。
 */
import { mkdir, readFile, readdir, rm, stat, appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeAtomic } from "./atomic-file.js";
import type { SubagentEvidence, SubagentEvidenceVerdict } from "./subagent-evidence.js";

export type LedgerRunState = "running" | "done" | "blocked" | "failed" | "canceled" | "interrupted" | "dismissed";

export interface LedgerWorktree {
	path: string;
	branch: string;
	cleanedUp?: boolean;
}

export interface LedgerEvidence {
	verdict: SubagentEvidenceVerdict;
	matchedFiles: number;
	files: number;
	matchedCommands: number;
	commands: number;
	none: boolean;
	blocked?: string;
	issues: string[];
	warnings: string[];
}

export interface LedgerEvent {
	ts: number;
	event: string;
	detail?: Record<string, unknown>;
}

export interface LedgerRunRecord {
	runId: string;
	parentRunId?: string;
	parentSessionFile?: string;
	cwd: string;
	type: string;
	title: string;
	template?: string;
	model?: string;
	thinking?: string;
	/** 原始任务（有界），续跑时原样带上。 */
	prompt: string;
	state: LedgerRunState;
	bootId: string;
	createdAt: number;
	updatedAt: number;
	finishedAt?: number;
	sessionFile?: string;
	persisted: boolean;
	worktree?: LedgerWorktree;
	evidence?: LedgerEvidence;
	error?: string;
	/** 最后一次助手输出的尾部（有界），重启后仍能看一眼结论。 */
	outputTail?: string;
	resumedFrom?: string;
	resumedBy?: string;
	eventsTruncated?: boolean;
}

export const LEDGER_DEFAULT_MAX_RUNS = 200;
export const LEDGER_EVENT_BYTES_CAP = 256 * 1024;
export const LEDGER_PROMPT_CAP = 8 * 1024;
export const LEDGER_OUTPUT_CAP = 4 * 1024;
export const LEDGER_EVIDENCE_ITEMS_CAP = 5;

/** 本进程身份：只用于区分「这群 running 是上一次进程留下的」。 */
const BOOT_ID = randomUUID();

export function ledgerBootId(): string {
	return BOOT_ID;
}

export function ledgerMaxRunsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number(env.PI_WEB_SUBAGENT_LEDGER_MAX_RUNS);
	if (!Number.isFinite(raw) || raw < 0) return LEDGER_DEFAULT_MAX_RUNS;
	return Math.floor(raw);
}

export function boundText(value: string | undefined, cap: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (!text) return undefined;
	return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

export function toLedgerEvidence(evidence: SubagentEvidence | undefined): LedgerEvidence | undefined {
	if (!evidence) return undefined;
	return {
		verdict: evidence.verdict,
		matchedFiles: evidence.matchedFiles,
		files: evidence.files.length,
		matchedCommands: evidence.matchedCommands,
		commands: evidence.commands.length,
		none: evidence.none,
		blocked: evidence.blocked,
		issues: evidence.issues.slice(0, LEDGER_EVIDENCE_ITEMS_CAP),
		warnings: evidence.warnings.slice(0, LEDGER_EVIDENCE_ITEMS_CAP),
	};
}

function safeSegment(runId: string): string {
	const cleaned = runId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
	return cleaned.length > 0 ? cleaned : "run";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizeRecord(raw: unknown): LedgerRunRecord | undefined {
	if (!isRecord(raw)) return undefined;
	const runId = typeof raw.runId === "string" ? raw.runId : "";
	if (!runId) return undefined;
	const state = raw.state;
	const states: LedgerRunState[] = ["running", "done", "blocked", "failed", "canceled", "interrupted", "dismissed"];
	return {
		runId,
		parentRunId: typeof raw.parentRunId === "string" ? raw.parentRunId : undefined,
		parentSessionFile: typeof raw.parentSessionFile === "string" ? raw.parentSessionFile : undefined,
		cwd: typeof raw.cwd === "string" ? raw.cwd : "",
		type: typeof raw.type === "string" ? raw.type : "general",
		title: typeof raw.title === "string" ? raw.title : "",
		template: typeof raw.template === "string" ? raw.template : undefined,
		model: typeof raw.model === "string" ? raw.model : undefined,
		thinking: typeof raw.thinking === "string" ? raw.thinking : undefined,
		prompt: typeof raw.prompt === "string" ? raw.prompt : "",
		state:
			typeof state === "string" && (states as string[]).includes(state) ? (state as LedgerRunState) : "interrupted",
		bootId: typeof raw.bootId === "string" ? raw.bootId : "",
		createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
		updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
		finishedAt: typeof raw.finishedAt === "number" ? raw.finishedAt : undefined,
		sessionFile: typeof raw.sessionFile === "string" ? raw.sessionFile : undefined,
		persisted: raw.persisted === true,
		worktree: isRecord(raw.worktree)
			? {
					path: typeof raw.worktree.path === "string" ? raw.worktree.path : "",
					branch: typeof raw.worktree.branch === "string" ? raw.worktree.branch : "",
					cleanedUp: raw.worktree.cleanedUp === true,
				}
			: undefined,
		evidence: isRecord(raw.evidence)
			? {
					verdict: (typeof raw.evidence.verdict === "string"
						? raw.evidence.verdict
						: "unverified") as SubagentEvidenceVerdict,
					matchedFiles: Number(raw.evidence.matchedFiles) || 0,
					files: Number(raw.evidence.files) || 0,
					matchedCommands: Number(raw.evidence.matchedCommands) || 0,
					commands: Number(raw.evidence.commands) || 0,
					none: raw.evidence.none === true,
					blocked: typeof raw.evidence.blocked === "string" ? raw.evidence.blocked : undefined,
					issues: Array.isArray(raw.evidence.issues)
						? raw.evidence.issues.filter((x): x is string => typeof x === "string")
						: [],
					warnings: Array.isArray(raw.evidence.warnings)
						? raw.evidence.warnings.filter((x): x is string => typeof x === "string")
						: [],
				}
			: undefined,
		error: typeof raw.error === "string" ? raw.error : undefined,
		outputTail: typeof raw.outputTail === "string" ? raw.outputTail : undefined,
		resumedFrom: typeof raw.resumedFrom === "string" ? raw.resumedFrom : undefined,
		resumedBy: typeof raw.resumedBy === "string" ? raw.resumedBy : undefined,
		eventsTruncated: raw.eventsTruncated === true,
	};
}

export interface SubagentLedgerOptions {
	maxRuns?: number;
	now?: () => number;
	/** 单 run 事件字节上限（测试与压测可调）。 */
	eventBytesCap?: number;
}

/**
 * 单进程、单 dataDir 一份实例（`getSubagentLedger()` 缓存）。多 ClientSession 共享同一份运行账本。
 */
export class SubagentLedger {
	readonly root: string;
	private readonly maxRuns: number;
	private readonly now: () => number;
	private readonly eventBytesCap: number;
	private readonly records = new Map<string, LedgerRunRecord>();
	private readonly eventBytes = new Map<string, number>();
	private readonly queues = new Map<string, Promise<void>>();
	private readyPromise?: Promise<void>;
	private lastErrorValue?: string;

	constructor(dataDir: string, opts: SubagentLedgerOptions = {}) {
		this.root = join(dataDir, "subagent-runs");
		this.maxRuns = opts.maxRuns ?? ledgerMaxRunsFromEnv();
		this.now = opts.now ?? (() => Date.now());
		this.eventBytesCap = Math.max(0, opts.eventBytesCap ?? LEDGER_EVENT_BYTES_CAP);
	}

	get enabled(): boolean {
		return this.maxRuns > 0;
	}

	lastError(): string | undefined {
		return this.lastErrorValue;
	}

	private runDir(runId: string): string {
		return join(this.root, safeSegment(runId));
	}

	private statusPath(runId: string): string {
		return join(this.runDir(runId), "status.json");
	}

	private eventsPath(runId: string): string {
		return join(this.runDir(runId), "events.jsonl");
	}

	/** 首次读取时把磁盘上的记录装进内存；后续读走内存，写走串行队列。 */
	ready(): Promise<void> {
		if (!this.enabled) return Promise.resolve();
		this.readyPromise ??= this.load();
		return this.readyPromise;
	}

	private async load(): Promise<void> {
		let entries: string[] = [];
		try {
			entries = await readdir(this.root);
		} catch {
			return;
		}
		for (const entry of entries) {
			const dir = join(this.root, entry);
			try {
				const [raw, size] = await Promise.all([readFile(join(dir, "status.json"), "utf8"), this.eventsSize(dir)]);
				const record = normalizeRecord(JSON.parse(raw));
				if (!record) continue;
				this.records.set(record.runId, record);
				this.eventBytes.set(record.runId, size);
			} catch {
				// 半写的目录/损坏的 status：跳过，不影响其它 run。
			}
		}
	}

	private async eventsSize(dir: string): Promise<number> {
		try {
			return (await stat(join(dir, "events.jsonl"))).size;
		} catch {
			return 0;
		}
	}

	private enqueue(runId: string, task: () => Promise<void>): void {
		const prev = this.queues.get(runId) ?? Promise.resolve();
		const next = prev.then(task).catch((error: unknown) => {
			this.lastErrorValue = error instanceof Error ? error.message : String(error);
		});
		this.queues.set(runId, next);
		void next.then(() => {
			if (this.queues.get(runId) === next) this.queues.delete(runId);
		});
	}

	/** 写入/更新一条运行记录（与已有记录字段合并）。 */
	upsert(patch: LedgerRunRecord): void {
		if (!this.enabled || !patch.runId) return;
		const previous = this.records.get(patch.runId);
		const next: LedgerRunRecord = {
			...previous,
			...patch,
			prompt: boundText(patch.prompt || previous?.prompt, LEDGER_PROMPT_CAP) ?? "",
			outputTail: boundText(patch.outputTail ?? previous?.outputTail, LEDGER_OUTPUT_CAP),
			createdAt: previous?.createdAt ?? patch.createdAt ?? this.now(),
			updatedAt: patch.updatedAt ?? this.now(),
			bootId: patch.bootId || previous?.bootId || BOOT_ID,
		};
		this.records.set(next.runId, next);
		this.enqueue(next.runId, async () => {
			await mkdir(this.runDir(next.runId), { recursive: true });
			await writeAtomic(this.statusPath(next.runId), `${JSON.stringify(next, null, 2)}\n`);
		});
		void this.ready().then(() => this.prune());
	}

	/** 追加一条生命周期事件；超过字节上限后只打一条截断标记。 */
	event(runId: string, event: string, detail?: Record<string, unknown>): void {
		if (!this.enabled || !runId) return;
		const record = this.records.get(runId);
		if (record?.eventsTruncated) return;
		const bytes = this.eventBytes.get(runId) ?? 0;
		if (bytes >= this.eventBytesCap) {
			this.records.set(runId, { ...(record as LedgerRunRecord), eventsTruncated: true, runId });
			this.enqueue(runId, async () => {
				await mkdir(this.runDir(runId), { recursive: true });
				await appendFile(this.eventsPath(runId), `${JSON.stringify({ ts: this.now(), event: "events_truncated" })}\n`);
			});
			return;
		}
		const line = `${JSON.stringify({ ts: this.now(), event, ...(detail ? { detail } : {}) })}\n`;
		this.eventBytes.set(runId, bytes + line.length);
		this.enqueue(runId, async () => {
			await mkdir(this.runDir(runId), { recursive: true });
			await appendFile(this.eventsPath(runId), line);
		});
	}

	/** 读某个 run 的最近事件（尾部），给 get_result 的账本回落做生命周期回放。 */
	async events(runId: string, limit = 8): Promise<LedgerEvent[]> {
		if (!this.enabled) return [];
		await this.ready();
		const cap = Math.max(1, Math.min(limit, 50));
		try {
			const raw = await readFile(this.eventsPath(runId), "utf8");
			const lines = raw
				.trim()
				.split("\n")
				.filter((line) => line.length > 0)
				.slice(-cap);
			const out: LedgerEvent[] = [];
			for (const line of lines) {
				try {
					const parsed = JSON.parse(line) as LedgerEvent;
					if (parsed && typeof parsed.event === "string") out.push(parsed);
				} catch {
					// 半写的行直接跳过。
				}
			}
			return out;
		} catch {
			return [];
		}
	}

	read(runId: string): LedgerRunRecord | undefined {
		return this.records.get(runId);
	}

	list(filter: { parentRunId?: string; live?: boolean } = {}): LedgerRunRecord[] {
		if (!this.enabled) return [];
		const out: LedgerRunRecord[] = [];
		for (const record of this.records.values()) {
			if (filter.parentRunId && record.parentRunId !== filter.parentRunId) continue;
			if (filter.live === true && record.state !== "running") continue;
			out.push(record);
		}
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/** 重启对账：别的 boot 留下的 running 一律判 interrupted（本 boot 的活运行不动）。 */
	async recover(): Promise<LedgerRunRecord[]> {
		if (!this.enabled) return [];
		await this.ready();
		const recovered: LedgerRunRecord[] = [];
		for (const record of [...this.records.values()]) {
			if (record.state !== "running" || record.bootId === BOOT_ID) continue;
			const next: LedgerRunRecord = { ...record, state: "interrupted", updatedAt: this.now() };
			this.records.set(next.runId, next);
			recovered.push(next);
			this.event(next.runId, "interrupted", { bootId: record.bootId });
			this.upsert(next);
		}
		await this.flush();
		return recovered;
	}

	/** 标记某个 run 已被续跑（记录新 run 身份，避免重复续跑）。 */
	markResumed(runId: string, newRunId: string): void {
		const record = this.records.get(runId);
		if (!record) return;
		// 还在 running 却没活着的运行（例如上次进程没来得及收口）：续跑即视为中断后重派。
		const state: LedgerRunState = record.state === "running" ? "interrupted" : record.state;
		this.upsert({ ...record, state, resumedBy: newRunId, updatedAt: this.now() });
		this.event(runId, "resumed", { runId: newRunId });
	}

	flush(): Promise<void> {
		return Promise.all([...this.queues.values()]).then(() => undefined);
	}

	/** 只保留最近 maxRuns 个 run 目录（活运行最后才考虑）。 */
	private async prune(): Promise<void> {
		if (this.records.size <= this.maxRuns) return;
		const candidates = [...this.records.values()]
			.filter((record) => record.state !== "running")
			.sort((a, b) => a.updatedAt - b.updatedAt);
		for (const record of candidates) {
			if (this.records.size <= this.maxRuns) return;
			this.records.delete(record.runId);
			this.eventBytes.delete(record.runId);
			// 先等这个 run 的写队列排空，否则排队中的 mkdir 会在 rm 之后把目录又建回来。
			await (this.queues.get(record.runId) ?? Promise.resolve()).catch(() => {});
			try {
				await rm(this.runDir(record.runId), { recursive: true, force: true });
			} catch {
				// 删不掉就下次再删；账本不能因此报错给用户。
			}
		}
	}
}

/**
 * 续跑提示词：子代理会话在进程内，重启后接不上原转录，所以把「原任务 + 已知进度 + 证据 + 工作树」
 * 原样交给新的一次运行，并要求它别重做已完成的部分。
 */
export function buildResumePrompt(record: LedgerRunRecord, extra?: string): string {
	const parts = [
		`[Resume] An earlier run of this task was interrupted (runId=${record.runId}, state=${record.state}).`,
		"Original task:",
		record.prompt || "(the original prompt was not recorded)",
	];
	if (record.outputTail) parts.push("Last output before the interruption (tail):", record.outputTail);
	if (record.evidence) {
		const ev = record.evidence;
		parts.push(
			`Evidence on record: ${ev.verdict} (files ${ev.matchedFiles}/${ev.files}, commands ${ev.matchedCommands}/${ev.commands}).`,
		);
	}
	if (record.worktree && !record.worktree.cleanedUp) {
		parts.push(
			`Worktree kept at ${record.worktree.path} (branch ${record.worktree.branch}); reuse it instead of creating a new one.`,
		);
	}
	if (record.sessionFile) {
		parts.push(`The old transcript is at ${record.sessionFile} — read it if you need the details.`);
	}
	if (extra && extra.trim()) parts.push("Additional instruction from the supervisor:", extra.trim());
	parts.push(
		'Continue from there: do not redo finished work, re-verify what you keep, and finish with conversation(action="complete", summary, evidence).',
	);
	return parts.join("\n");
}

const ledgers = new Map<string, SubagentLedger>();

/** dataDir 级单例：同一进程里所有 ClientSession 共用一份账本。 */
export function getSubagentLedger(dataDir: string, opts?: SubagentLedgerOptions): SubagentLedger {
	const key = dataDir;
	const existing = ledgers.get(key);
	if (existing) return existing;
	const created = new SubagentLedger(dataDir, opts);
	ledgers.set(key, created);
	return created;
}

let disabledLedger: SubagentLedger | undefined;

/** 没有 dataDir 的宿主（测试假体、纯内存引擎）用它：整本账禁用，绝不落盘。 */
export function disabledSubagentLedger(): SubagentLedger {
	return (disabledLedger ??= new SubagentLedger("", { maxRuns: 0 }));
}

/** 测试用：清掉单例缓存，避免跨用例共享账本。 */
export function resetSubagentLedgersForTests(): void {
	ledgers.clear();
}
