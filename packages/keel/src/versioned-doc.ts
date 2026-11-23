/**
 * 版本化 JSON 文档的单源（v1）。
 *
 * 事故形态（issues #982）：五个存储各自写了「读盘 → 校验版本 → 写盘」，版本不认识时把结果折成
 * 「空库」，下一次保存再把空库写回去 —— 用户数据被永久覆盖。同仓还有两种相反的自救写法
 * （`client-state` 改名放生后继续写、`#986` 拷贝备份后永久拒写），第三个存储随手挑一套即可。
 *
 * 根因不是那五个文件写错了，而是「读−校验−写」没有归属者：判据只活在文档里，没有任何代码位置
 * 承载它。本模块承载它，并且让违规在结构上不可能：
 *
 * - 判据四态（`docs/root-cause-boundaries.md`「损坏、不可读和不存在是不同结果」的完整版）：
 *   `absent` 文件不存在 → 建库；`ready` 认识 → 可写；
 *   `foreign` 文件完好但版本/形状不认识 → **原地保留、只读、拒写**（降级跑一次再升回去，数据必须还在原路径）；
 *   `damaged` 读不出 / 解析不了 → 能备份就**改名放生**一次再建库，不能备份就拒写。
 * - handle 同时拥有读和写，调用方拿不到裸 `writeJsonAtomicSync`：写前必先判态，忘记判态是编译期做不到的事。
 * - 挡住的文档统一进 `storageIntegrity`，由 `/api/health` 投影（只给文件名，不给路径）。不许只有一行 console。
 *
 * 追加型日志（`device-center/partition-log.ts`）与会话转录（`session-open.ts`）不是单文档，但遵守同一条
 * 判据：认不出的一律不重写、不追加，并登记到同一个 integrity 视图。
 */
import { existsSync, renameSync } from "node:fs";
import { basename } from "node:path";
import { readFileSyncRetry, writeJsonAtomic } from "./atomic-file.js";

/** 存储判据四态。`absent` / `ready` 可写，`foreign` / `damaged` 拒写。 */
export type DocState = "absent" | "ready" | "foreign" | "damaged";

const REPORT_LIMIT = 32;

export interface StorageIssue {
	/** 绝对路径：只给日志用，`/api/health` 投影只给 `basename`。 */
	file: string;
	label: string;
	state: "foreign" | "damaged";
	reason: string;
	foundVersion?: unknown;
	at: number;
}

const issues = new Map<string, StorageIssue>();
let rejectedWrites = 0;

function rememberIssue(issue: StorageIssue): void {
	const previous = issues.get(issue.file);
	if (previous && previous.state === issue.state && previous.reason === issue.reason) return;
	issues.delete(issue.file);
	issues.set(issue.file, issue);
	while (issues.size > REPORT_LIMIT) {
		const oldest = issues.keys().next();
		if (oldest.done) break;
		issues.delete(oldest.value);
	}
	console.error(`[storage] ${issue.label} ${issue.file}：${issue.reason}`);
}

/**
 * 给不是「单文档」的存储用（追加型日志、会话转录）：同一套判据、同一个 integrity 视图。
 * 重复登记同一个文件不会重复刷日志。
 */
export function noteStorageIssue(input: Omit<StorageIssue, "at">): void {
	rememberIssue({ ...input, at: Date.now() });
}

export function forgetStorageIssue(file: string): void {
	issues.delete(file);
}

/** 供 `/api/health` 与诊断使用：只暴露文件名与原因，不暴露数据目录路径（该端点是免鉴权的）。 */
export function storageIntegritySnapshot(): {
	blocked: Array<{
		file: string;
		label: string;
		state: "foreign" | "damaged";
		reason: string;
		foundVersion?: unknown;
		at: number;
	}>;
	rejectedWrites: number;
} {
	return {
		blocked: [...issues.values()].map((issue) => ({
			file: basename(issue.file),
			label: issue.label,
			state: issue.state,
			reason: issue.reason,
			...(issue.foundVersion === undefined ? {} : { foundVersion: issue.foundVersion }),
			at: issue.at,
		})),
		rejectedWrites,
	};
}

/** 只给测试用。 */
export function resetStorageIntegrityForTests(): void {
	issues.clear();
	rejectedWrites = 0;
}

/** 写被拒：调用方必须让它走到自己的失败出口（HTTP / WS 回执 / 明确的用户提示），不许吞成「保存成功」。 */
export class StorageBlockedError extends Error {
	readonly code = "STORAGE_BLOCKED";
	readonly state: DocState;
	readonly reason: string;
	constructor(file: string, state: DocState, reason: string) {
		super(`${basename(file)} 无法使用（${reason}），本次运行拒绝写入以免覆盖原文件`);
		this.name = "StorageBlockedError";
		this.state = state;
		this.reason = reason;
	}
}

export interface VersionedDocOptions<T> {
	file: string;
	/** 日志前缀，例如 `remote-ssh`。 */
	label: string;
	/** 接受的版本号，第一个是写盘用的主版本。 */
	versions: readonly number[];
	/** 版本键名，默认 `version`。 */
	versionKey?: string;
	/** 形状校验 + 规范化；返回 `null` 表示「版本对得上但形状不认识」（按 foreign 处理，不覆盖）。 */
	parse(value: Record<string, unknown>): T | null;
	/** 生成写盘对象（含版本键）。 */
	serialize(value: T): Record<string, unknown>;
	/** 读不出时给调用方的空值。 */
	empty(): T;
	/** 解析失败时是否改名放生（默认 true，沿用 `.corrupt-<ts>` 约定）。 */
	quarantineDamaged?: boolean;
}

export interface VersionedDoc<T> {
	readonly file: string;
	readonly label: string;
	/** 最近一次判态。 */
	readonly state: DocState;
	/** 读一次盘并判态。每次都重新读：不缓存值，调用方不会拿到跨调用的陈旧快照。 */
	read(): T;
	/** 读一次盘；`foreign` / `damaged` 抛 `StorageBlockedError`，否则返回当前值。 */
	assertWritable(): T;
	/** 最近一次判定的原因（可写时为空串）。 */
	readonly blockedReason: string;
	/** 先判态再写；`foreign` / `damaged` 抛 `StorageBlockedError`。落盘非阻塞，须 await 才算持久化。 */
	write(value: T): Promise<void>;
}

function quarantine(file: string): string | null {
	const target = `${file}.corrupt-${Date.now()}`;
	try {
		renameSync(file, target);
		return target;
	} catch {
		return null;
	}
}

export function openVersionedDoc<T>(options: VersionedDocOptions<T>): VersionedDoc<T> {
	const versionKey = options.versionKey ?? "version";
	const primaryVersion = options.versions[0] ?? 1;
	let state: DocState = "absent";
	let blockedReason = "";

	const block = (next: "foreign" | "damaged", reason: string, foundVersion?: unknown): void => {
		state = next;
		blockedReason = reason;
		rememberIssue({ file: options.file, label: options.label, state: next, reason, foundVersion, at: Date.now() });
	};

	/**
	 * 解析不了 = damaged：能改名留存就放生一次（沿用 client-state 的 `.corrupt-<ts>` 约定）后按空库继续；
	 * 连改名都失败就拒写 —— 没有备份资格的「重建」等于删除。
	 */
	const resetOrBlock = (reason: string): void => {
		const moved = options.quarantineDamaged === false ? null : quarantine(options.file);
		if (!moved) {
			block("damaged", reason);
			return;
		}
		console.error(`[storage] ${options.label} ${options.file} ${reason}，已改名留存到 ${moved}，本次按空库启动`);
		state = "absent";
		forgetStorageIssue(options.file);
	};

	const inspect = (): T => {
		if (!existsSync(options.file)) {
			state = "absent";
			forgetStorageIssue(options.file);
			return options.empty();
		}
		let raw: string;
		try {
			raw = readFileSyncRetry(options.file);
		} catch (error) {
			// existsSync 与 read 之间文件可能被删掉（另一个进程/用户清理）：那仍然是不存在，不是损坏。
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				state = "absent";
				forgetStorageIssue(options.file);
				return options.empty();
			}
			block("damaged", `读取失败：${String((error as Error)?.message ?? error)}`);
			return options.empty();
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			resetOrBlock("不是合法 JSON");
			return options.empty();
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			resetOrBlock("顶层不是对象");
			return options.empty();
		}
		const document = parsed as Record<string, unknown>;
		const found = document[versionKey];
		if (typeof found !== "number" || !options.versions.includes(found)) {
			block(
				"foreign",
				`版本不认识（读到 ${String(found)}，支持 ${options.versions.join(" / ")}）；原文件保持原样，本次只读`,
				found,
			);
			return options.empty();
		}
		const value = options.parse(document);
		if (value === null) {
			block("foreign", `版本 ${found} 对得上但形状不认识；原文件保持原样，本次只读`, found);
			return options.empty();
		}
		state = "ready";
		forgetStorageIssue(options.file);
		return value;
	};

	return {
		file: options.file,
		label: options.label,
		get state() {
			return state;
		},
		get blockedReason() {
			return blockedReason;
		},
		read: inspect,
		assertWritable(): T {
			const value = inspect();
			if (state === "foreign" || state === "damaged") throw new StorageBlockedError(options.file, state, blockedReason);
			return value;
		},
		async write(value: T): Promise<void> {
			// 写前重判，不信任上次读的结论（另一个进程可能刚把文件换成更新版本）。
			inspect();
			if (state === "foreign" || state === "damaged") {
				rejectedWrites += 1;
				throw new StorageBlockedError(options.file, state, blockedReason);
			}
			await writeJsonAtomic(options.file, { ...options.serialize(value), [versionKey]: primaryVersion });
			state = "ready";
			forgetStorageIssue(options.file);
		},
	};
}
