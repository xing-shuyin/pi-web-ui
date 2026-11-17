/**
 * 运行时加载路径（P0，只读）：双层模型里"壳 + 运行时"的下半截，见 docs/architecture-desktop-runtime.md。
 *
 * 这里只回答一个问题：**这次启动该跑哪份 `dist/server/index.js`**。
 * 所有写盘动作（下载、解包、切换指针、失败计数）都在 P2，本模块一行不写，
 * 这样"最坏情况下退回安装包内自带运行时"这条兜底路径不依赖任何可写状态。
 *
 * 判定顺序（与文档 §七 一致）：
 *   1. `current.json` 缺失/坏 → 包内自带
 *   2. `consecutiveFailures >= 2` → 隔离 current，改用 `lastGoodVersion`；不可用则包内
 *   3. 目录缺 / 入口缺 / 协议不符 → 退 `lastGoodVersion`，再不行才包内
 *
 * 任何一项不满足都不进入"能启动但行为诡异"的状态：宁可跑旧的一体包，也不跑来路不明的目录。
 * 不 import electron，纯 fs + 纯函数，可直接单测（tests/unit/desktop-runtime-store.test.ts）。
 */

import { existsSync, createReadStream, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import * as tar from "tar";
import { checkArchiveEntryPath, checkArchiveEntryType } from "./runtime-manifest.js";

/** 指针文件自身的结构版本，与运行时版本号无关。 */
export const RUNTIME_POINTER_SCHEMA_VERSION = 1;

/** `<userData>/runtime`。 */
export const RUNTIME_DIRNAME = "runtime";

export const RUNTIME_POINTER_FILENAME = "current.json";

/** 运行时根目录下，服务端入口的相对路径。 */
export const RUNTIME_ENTRY_PARTS = ["dist", "server", "index.js"] as const;

/** 版本号只允许这些字符：拦住 `..`、绝对路径、Windows 设备名等一切路径穿越。 */
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

export type RuntimeFallbackReason =
	/** 没有 current.json：从没装过运行时，正常情况。 */
	| "no-pointer"
	/** current.json 存在但读不动/不是合法指针（手改坏了、写一半断电）。 */
	| "bad-pointer"
	/** 指针指向的目录不在（用户手删、GC 误删）。 */
	| "missing-dir"
	/** 目录在但 `dist/server/index.js` 不在：半成品运行时，绝不能跑。 */
	| "missing-entry"
	/** 运行时与壳的协议版本不一致：需要先更新壳，见文档 §六。 */
	| "protocol-mismatch"
	/** 连续失败已隔离，且 lastGood 也不可用。 */
	| "quarantine-unusable";

export interface RuntimePointer {
	schemaVersion: number;
	version: string;
	nativesVersion: string | null;
	/** 运行时声明的协议版本；壳只接受与自带运行时相等的值。 */
	protocol: number | null;
	lastGoodVersion: string | null;
	consecutiveFailures: number;
	installedAt: string | null;
}

export interface ResolvedRuntime {
	/** runtime = 跑 userData 里的那份；bundled = 跑安装包内自带的那份。 */
	source: "runtime" | "bundled";
	/** 被选中那份的根目录（runtime 时是 `<runtimeRoot>/<version>`）。 */
	root: string;
	/** 服务端入口绝对路径，直接交给 spawn。 */
	entry: string;
	version: string | null;
	protocol: number | null;
	/** source=bundled 时说明为什么没用运行时；source=runtime 且靠 lastGood 顶上时为 null。 */
	reason: RuntimeFallbackReason | null;
}

export interface ResolveRuntimeOptions {
	/** 运行时集合的根，通常是 `<userData>/runtime`；测试可指到临时目录。 */
	runtimeRootDir: string;
	/** 安装包内自带运行时的根（打包后是 `app.getAppPath()`）。 */
	bundledRoot: string;
	/** 壳自带运行时的协议版本；null = 读不到，此时不做协议闸门（宁放行，不误杀）。 */
	bundledProtocol?: number | null;
	/** 便于单测注入；默认走真实 fs。 */
	exists?: (path: string) => boolean;
	readFile?: (path: string) => string;
}

export function runtimePointerPath(runtimeRootDir: string): string {
	return join(runtimeRootDir, RUNTIME_POINTER_FILENAME);
}

export function runtimeVersionDir(runtimeRootDir: string, version: string): string {
	return join(runtimeRootDir, version);
}

export function runtimeEntryPath(root: string): string {
	return join(root, ...RUNTIME_ENTRY_PARTS);
}

/** 版本号是否可安全拼进路径：唯一一处判断，别在调用侧另写正则。 */
export function isSafeRuntimeVersion(value: unknown): value is string {
	return typeof value === "string" && SAFE_VERSION.test(value);
}

/**
 * 解析 current.json 的结构。**不抛**：任何不合规都返回 null，由调用方回落包内。
 * 字段缺失按默认值补，只对"能导致跑错东西"的字段严格（version / lastGoodVersion / schemaVersion）。
 */
export function parseRuntimePointer(raw: unknown): RuntimePointer | null {
	if (typeof raw !== "object" || raw === null) return null;
	const value = raw as Record<string, unknown>;
	if (value.schemaVersion !== RUNTIME_POINTER_SCHEMA_VERSION) return null;
	if (!isSafeRuntimeVersion(value.version)) return null;
	const lastGoodVersion = isSafeRuntimeVersion(value.lastGoodVersion) ? value.lastGoodVersion : null;
	if (value.lastGoodVersion !== undefined && value.lastGoodVersion !== null && lastGoodVersion === null) return null;
	const protocol =
		typeof value.protocol === "number" && Number.isInteger(value.protocol) && value.protocol > 0
			? value.protocol
			: null;
	const consecutiveFailures =
		typeof value.consecutiveFailures === "number" &&
		Number.isInteger(value.consecutiveFailures) &&
		value.consecutiveFailures > 0
			? value.consecutiveFailures
			: 0;
	return {
		schemaVersion: RUNTIME_POINTER_SCHEMA_VERSION,
		version: value.version,
		nativesVersion: isSafeRuntimeVersion(value.nativesVersion) ? value.nativesVersion : null,
		protocol,
		lastGoodVersion,
		consecutiveFailures,
		installedAt: typeof value.installedAt === "string" ? value.installedAt : null,
	};
}

/** 读 + 解析；区分"没有文件"（no-pointer）与"文件坏了"（bad-pointer），两者日志含义不同。 */
function readPointer(
	path: string,
	readFile: (p: string) => string,
): { pointer: RuntimePointer | null; reason: "no-pointer" | "bad-pointer" | null } {
	let text: string;
	try {
		text = readFile(path);
	} catch {
		return { pointer: null, reason: "no-pointer" };
	}
	try {
		const pointer = parseRuntimePointer(JSON.parse(text));
		return pointer ? { pointer, reason: null } : { pointer: null, reason: "bad-pointer" };
	} catch {
		return { pointer: null, reason: "bad-pointer" };
	}
}

/**
 * 直接读某份运行时自己的 `dist/server/protocol-version.js`。
 * 指针里只有 current 的 protocol，lastGood 没有——而"退一步"同样要过闸门，
 * 所以这里按源码形态抽一行常量（该文件由 tsc 从单行源文件生成，形态稳定）。
 * 注意：这里**不 import** —— 尚未校验的运行时目录不执行代码，只文本解析。
 */
export function readRuntimeProtocolVersion(root: string, readFile: (p: string) => string): number | null {
	let text: string;
	try {
		text = readFile(join(root, "dist", "server", "protocol-version.js"));
	} catch {
		return null;
	}
	const match = /PROTOCOL_VERSION\s*=\s*(\d+)/.exec(text);
	if (!match?.[1]) return null;
	const value = Number(match[1]);
	return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * 候选版本按优先级排：正常用 current；已隔离先用 lastGood。
 * 注意 lastGood 只是"退一步"，不是无限回溯——文档 §四 只保留两份。
 */
function candidatesFor(pointer: RuntimePointer): string[] {
	const list: string[] = [];
	const push = (version: string | null) => {
		if (!version || list.includes(version)) return;
		list.push(version);
	};
	if (pointer.consecutiveFailures >= 2) {
		push(pointer.lastGoodVersion);
	} else {
		push(pointer.version);
		push(pointer.lastGoodVersion);
	}
	return list;
}

/**
 * 决定这次跑哪份服务端。纯读取，幂等，无副作用。
 */
export function resolveRuntime(options: ResolveRuntimeOptions): ResolvedRuntime {
	const { runtimeRootDir, bundledRoot } = options;
	const bundled: ResolvedRuntime = {
		source: "bundled",
		root: bundledRoot,
		entry: runtimeEntryPath(bundledRoot),
		version: null,
		protocol: options.bundledProtocol ?? null,
		reason: null,
	};
	const exists = options.exists ?? existsSync;
	const readFile = options.readFile ?? ((p: string) => readFileSync(p, "utf8"));
	const { pointer, reason } = readPointer(runtimePointerPath(runtimeRootDir), readFile);
	if (!pointer) return { ...bundled, reason: reason ?? "no-pointer" };

	const quarantined = pointer.consecutiveFailures >= 2;
	let failure: RuntimeFallbackReason = quarantined ? "quarantine-unusable" : "missing-dir";
	for (const version of candidatesFor(pointer)) {
		const root = runtimeVersionDir(runtimeRootDir, version);
		if (!exists(root)) {
			failure = quarantined && version === pointer.lastGoodVersion ? "quarantine-unusable" : "missing-dir";
			continue;
		}
		if (!exists(runtimeEntryPath(root))) {
			failure = "missing-entry";
			continue;
		}
		// 协议必须与壳自带运行时一致：不一致时"能起来但前后端对不上"比跑旧一体包危险得多。
		// 指针声明的是 current 的协议；lastGood 只能现读它自己的那份。
		const protocol =
			(version === pointer.version ? pointer.protocol : null) ?? readRuntimeProtocolVersion(root, readFile);
		if (options.bundledProtocol != null && protocol != null && protocol !== options.bundledProtocol) {
			failure = "protocol-mismatch";
			continue;
		}
		return {
			source: "runtime",
			root,
			entry: runtimeEntryPath(root),
			version,
			protocol,
			reason: null,
		};
	}
	return { ...bundled, reason: failure };
}

/** 一行日志：实机验证和用户报障都靠它分辨"到底跑了哪份"。 */
export function describeResolvedRuntime(resolved: ResolvedRuntime): string {
	const version = resolved.version ?? "-";
	const reason = resolved.reason ? ` reason=${resolved.reason}` : "";
	return `source=${resolved.source} version=${version}${reason} entry=${resolved.entry}`;
}

/**
 * 壳自带运行时的协议版本：从 `<app>/dist/server/protocol-version.js` 动态读，
 * 不在编译期耦合 `server/protocol-version.ts`（壳和运行时本来就走不同发布节奏）。
 * 读不到就返回 null —— 让闸门放行，而不是把所有运行时都判死。
 *
 * 带 mtime 查询串：同一个进程内运行时被重装到同一路径时，不能拿旧模块缓存冒充新版本。
 */
export async function readBundledProtocolVersion(distServerDir: string): Promise<number | null> {
	const file = join(distServerDir, "protocol-version.js");
	let stamp: number;
	try {
		stamp = statSync(file).mtimeMs;
	} catch {
		return null;
	}
	try {
		const mod = (await import(`${pathToFileURL(file).href}?v=${stamp}`)) as { PROTOCOL_VERSION?: unknown };
		const value = mod.PROTOCOL_VERSION;
		return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
	} catch {
		return null;
	}
}

export type ExtractResult = { ok: true; files: number } | { ok: false; code: "corrupt" | "busy"; reason: string };

async function sha256File(path: string): Promise<string> {
	return await new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		createReadStream(path)
			.on("error", reject)
			.on("data", (chunk) => hash.update(chunk))
			.on("end", () => resolve(hash.digest("hex")));
	});
}

/**
 * 解包运行时归档（`.tar.zst`）：先比大小、再比摘要，逐条过白名单后落盘。
 *
 * 安全约定（文档 §十.3）：
 * - 目标必须是**新建的空目录**；解包失败整目录删掉，不留半成品；
 * - 路径穿越/绝对路径/链接/设备文件一律整包拒绝，不做"跳过坏条目"。
 */
export async function extractRuntimeArchive(options: {
	archivePath: string;
	targetDir: string;
	expected?: { size: number; sha256: string };
}): Promise<ExtractResult> {
	const { archivePath, targetDir, expected } = options;
	let size: number;
	try {
		size = statSync(archivePath).size;
	} catch {
		return { ok: false, code: "corrupt", reason: `归档不存在：${archivePath}` };
	}
	if (expected) {
		if (size !== expected.size)
			return { ok: false, code: "corrupt", reason: `归档大小 ${size} ≠ 清单 ${expected.size}` };
		const digest = await sha256File(archivePath);
		if (digest !== expected.sha256) return { ok: false, code: "corrupt", reason: "归档 sha256 与清单不一致" };
	}
	if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
		return { ok: false, code: "busy", reason: `目标目录已存在且非空：${targetDir}` };
	}
	mkdirSync(targetDir, { recursive: true });
	let files = 0;
	// 不抛：tar 的 filter 里 throw 会把管线挂住。这里只拒绝该条目并记账，
	// 管线跑完再整包判死（目标目录本来就是新建的，删掉不留半成品）。
	const violations: string[] = [];
	try {
		await pipeline(
			createReadStream(archivePath),
			createZstdDecompress(),
			tar.x({
				cwd: targetDir,
				filter: (entryPath, entry) => {
					const pathVerdict = checkArchiveEntryPath(entryPath);
					if (!pathVerdict.ok) {
						violations.push(pathVerdict.reason);
						return false;
					}
					const entryType = (entry as { type?: string }).type;
					const typeVerdict = checkArchiveEntryType(entryType, entryPath);
					if (!typeVerdict.ok) {
						violations.push(typeVerdict.reason);
						return false;
					}
					if (entryType === "File") files += 1;
					return true;
				},
			}),
		);
	} catch (error) {
		rmSync(targetDir, { recursive: true, force: true });
		return { ok: false, code: "corrupt", reason: (error as Error).message };
	}
	if (violations.length > 0) {
		rmSync(targetDir, { recursive: true, force: true });
		return { ok: false, code: "corrupt", reason: `归档条目不合规（${violations.length} 条）：${violations[0]}` };
	}
	return { ok: true, files };
}

/** 读指针（P2 切换/回滚用）；坏文件当作"没有"，与启动判定保持同一口径。 */
export function readRuntimePointer(
	runtimeRootDir: string,
	readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): RuntimePointer | null {
	return readPointer(runtimePointerPath(runtimeRootDir), readFile).pointer;
}

/**
 * 原子写指针：先写 `<root>/current.json.tmp`，再 rename 盖过去。
 * Windows 上杀软/索引器会短暂占住文件，rename 按退避重试（文档 §八「杀软/文件占用」）。
 */
export async function writeRuntimePointerAtomic(
	runtimeRootDir: string,
	pointer: RuntimePointer,
	options: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
	const fsPromises = await import("node:fs/promises");
	const target = runtimePointerPath(runtimeRootDir);
	const temp = `${target}.tmp`;
	await fsPromises.mkdir(runtimeRootDir, { recursive: true });
	await fsPromises.writeFile(temp, `${JSON.stringify(pointer, null, "\t")}\n`, "utf8");
	const attempts = Math.max(1, options.attempts ?? 6);
	const delayMs = Math.max(0, options.delayMs ?? 120);
	for (let attempt = 1; ; attempt += 1) {
		try {
			await fsPromises.rename(temp, target);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
			if (!retryable || attempt >= attempts) {
				await fsPromises.rm(temp, { force: true });
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
		}
	}
}

/** 切换成功后的新指针：`lastGood` 记住刚被替换掉的那版，失败计数归零。 */
export function buildSwitchedPointer(
	previous: RuntimePointer | null,
	next: { version: string; protocol: number | null; nativesVersion?: string | null },
	now: string = new Date().toISOString(),
): RuntimePointer {
	const lastGood =
		previous && previous.version !== next.version && isSafeRuntimeVersion(previous.version)
			? previous.version
			: (previous?.lastGoodVersion ?? null);
	return {
		schemaVersion: RUNTIME_POINTER_SCHEMA_VERSION,
		version: next.version,
		nativesVersion: next.nativesVersion ?? previous?.nativesVersion ?? null,
		protocol: next.protocol ?? previous?.protocol ?? null,
		lastGoodVersion: lastGood === next.version ? null : lastGood,
		consecutiveFailures: 0,
		installedAt: now,
	};
}

/** 回滚指针：把 current 写回 lastGood，并把 lastGood 清空（再退一次就该回包内了）。 */
export function buildRollbackPointer(
	pointer: RuntimePointer,
	now: string = new Date().toISOString(),
): RuntimePointer | null {
	if (!pointer.lastGoodVersion || !isSafeRuntimeVersion(pointer.lastGoodVersion)) return null;
	return {
		schemaVersion: RUNTIME_POINTER_SCHEMA_VERSION,
		version: pointer.lastGoodVersion,
		nativesVersion: pointer.nativesVersion,
		protocol: pointer.protocol,
		lastGoodVersion: null,
		consecutiveFailures: 0,
		installedAt: now,
	};
}

/** 启动失败计数（崩溃循环保护）：`consecutiveFailures ≥ 2` 后 P0 会直接跳过 current。 */
export function buildFailurePointer(pointer: RuntimePointer): RuntimePointer {
	return { ...pointer, consecutiveFailures: Math.max(0, pointer.consecutiveFailures) + 1 };
}
