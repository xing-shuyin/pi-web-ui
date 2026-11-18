import {
	closeSync,
	constants,
	copyFileSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { copyFile, link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export interface AtomicWriteOptions {
	mode?: number;
	fsync?: boolean;
}

/**
 * Windows 上杀毒 / 搜索索引器会在文件刚写完的几毫秒里短暂持有句柄，此时 rename（MoveFileEx 覆盖）报
 * EPERM / EACCES / EBUSY。这类错误是瞬时的，重试即可；其余错误（EIO / ENOSPC / EXDEV …）重试无用。
 * 退避必须真等，连续空转的「立刻重试三次」在毫秒级占用面前等于没重试。
 */
export const TRANSIENT_FS_CODES = ["EPERM", "EACCES", "EBUSY"] as const;

/** 每次失败后等多久再试；数组长度即最大重试次数。总等待 ≈ 630ms，覆盖杀毒扫描窗口。 */
export const ATOMIC_RETRY_DELAY_MS = [20, 60, 150, 400] as const;

export function isTransientFsCode(code: string | undefined | null): boolean {
	return typeof code === "string" && (TRANSIENT_FS_CODES as readonly string[]).includes(code);
}

/**
 * 「这个文件系统压根不支持硬链接」的错误码——独占发布据此决定是否降级为排他复制：
 * - EPERM / EACCES：Android/Termux 的 /data、FAT32/exFAT 外置存储、部分容器 overlay 拒绝 link(2)，但允许写；
 * - ENOTSUP / EOPNOTSUPP / ENOSYS：SMB/CIFS、部分 FUSE 与网络 fs 直接回「不支持该操作」；
 * - EXDEV：跨设备硬链接不被允许；
 * - EMLINK：链接数上限（部分 BSD/网络 fs 对每个文件只允许一个链接）。
 *
 * 和上面的 TRANSIENT_FS_CODES 语义完全不同，别合并：那组是「等一会就好」（rename 撞杀毒占用，重试有效、绝不降级），
 * 这组是「换个实现就好」（重试无效、降级有效）。合并会同时踩两个坑：把瞬时占用误判成不支持，或把「不支持」
 * 变成无限重试。EPERM/EACCES 同时出现在两组里是事实使然——同一个码在不同原语上含义不同。
 */
export const LINK_UNSUPPORTED_CODES = [
	"EPERM",
	"EACCES",
	"ENOTSUP",
	"EOPNOTSUPP",
	"ENOSYS",
	"EXDEV",
	"EMLINK",
] as const;

export function isLinkUnsupportedCode(code: string | undefined | null): boolean {
	return typeof code === "string" && (LINK_UNSUPPORTED_CODES as readonly string[]).includes(code);
}

/** 发布实际走的方式：`link` 零拷贝，`copy` 是硬链接不可用时的降级路径（日志与测试据此断言）。 */
export type ExclusivePublishMode = "link" | "copy";

/**
 * 独占发布：把 `temp` 的内容落到 `dest`；`dest` 已存在则抛 EEXIST，绝不覆盖。
 *
 * 为什么不用 rename：rename 会静默覆盖已存在目标，独占语义当场消失；link(2) 自带 EEXIST 且零拷贝，是首选。
 * 不支持硬链接的文件系统（见 LINK_UNSUPPORTED_CODES）上 link 整链断裂，降级为 copyFile + COPYFILE_EXCL——
 * 同样是「已存在则 EEXIST」的排他创建，只是多一次数据拷贝。其余错误（ENOENT/ENOSPC/EIO …）原样抛出，
 * 不让降级掩盖真实故障。
 *
 * 成功后不删 `temp`（与裸 link 一致），清理仍归调用方现有的 finally。
 */
export function publishFileExclusiveSync(temp: string, dest: string): ExclusivePublishMode {
	try {
		linkSync(temp, dest);
		return "link";
	} catch (error) {
		if (!isLinkUnsupportedCode((error as NodeJS.ErrnoException).code)) throw error;
	}
	copyFileSync(temp, dest, constants.COPYFILE_EXCL);
	return "copy";
}

/** 与 `publishFileExclusiveSync` 同一契约的异步版（四个本地调用点里三个是 async）。 */
export async function publishFileExclusive(temp: string, dest: string): Promise<ExclusivePublishMode> {
	try {
		await link(temp, dest);
		return "link";
	} catch (error) {
		if (!isLinkUnsupportedCode((error as NodeJS.ErrnoException).code)) throw error;
	}
	await copyFile(temp, dest, constants.COPYFILE_EXCL);
	return "copy";
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeAtomicSync(
	file: string,
	data: string | NodeJS.ArrayBufferView,
	options: AtomicWriteOptions = {},
): void {
	const dir = dirname(file);
	mkdirSync(dir, { recursive: true });
	const suffix = `${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
	const tmp = `${file}.${suffix}`;
	try {
		if (options.mode !== undefined || options.fsync) {
			let mode = options.mode;
			if (mode !== undefined) {
				try {
					mode = statSync(file).mode & 0o777;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			const fd = openSync(tmp, "wx", mode);
			try {
				writeFileSync(fd, data);
				if (options.fsync) fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		} else {
			writeFileSync(tmp, data);
		}
		for (let attempt = 0; ; attempt++) {
			try {
				renameSync(tmp, file);
				break;
			} catch (error) {
				const attemptDelay = ATOMIC_RETRY_DELAY_MS[attempt];
				if (attemptDelay === undefined || !isTransientFsCode((error as NodeJS.ErrnoException).code)) throw error;
				sleepSync(attemptDelay);
			}
		}
	} finally {
		try {
			rmSync(tmp, { force: true });
		} catch {}
	}
}

/** Same contract as `writeAtomicSync`, for async callers (rename retries await, they do not block the loop). */
export async function writeAtomic(
	file: string,
	data: string | NodeJS.ArrayBufferView,
	options: AtomicWriteOptions = {},
): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
	try {
		const handle = await open(tmp, "wx", options.mode ?? 0o666);
		try {
			await handle.writeFile(data);
			if (options.fsync) await handle.sync();
		} finally {
			await handle.close();
		}
		for (let attempt = 0; ; attempt++) {
			try {
				await rename(tmp, file);
				break;
			} catch (error) {
				const attemptDelay = ATOMIC_RETRY_DELAY_MS[attempt];
				if (attemptDelay === undefined || !isTransientFsCode((error as NodeJS.ErrnoException).code)) throw error;
				await delay(attemptDelay);
			}
		}
	} finally {
		await rm(tmp, { force: true }).catch(() => {});
	}
}

/**
 * 读侧同样会被瞬时占用咬到（写方正在 rename，读方 handleExisting 失败）。ENOENT 是正常结果，交回调用方。
 */
export function readFileSyncRetry(file: string, encoding: BufferEncoding = "utf8"): string {
	for (let attempt = 0; ; attempt++) {
		try {
			return readFileSync(file, encoding);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			const attemptDelay = ATOMIC_RETRY_DELAY_MS[attempt];
			if (code === "ENOENT" || attemptDelay === undefined || !isTransientFsCode(code)) throw error;
			sleepSync(attemptDelay);
		}
	}
}

export async function readFileRetry(file: string, encoding: BufferEncoding = "utf8"): Promise<string> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await readFile(file, encoding);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			const attemptDelay = ATOMIC_RETRY_DELAY_MS[attempt];
			if (code === "ENOENT" || attemptDelay === undefined || !isTransientFsCode(code)) throw error;
			await delay(attemptDelay);
		}
	}
}

/**
 * 注入式原子写：`fs` 由调用方给，函数自包含，可 `toString()` 后在无 server 依赖的进程里跑
 * （见 `portableAtomicWriteSyncSource`）。非 Node 宿主不必带 `fsync`。
 */
export function writeAtomicPortableSync(
	fs: Pick<
		typeof import("node:fs"),
		"openSync" | "writeFileSync" | "fsyncSync" | "closeSync" | "renameSync" | "rmSync" | "mkdirSync"
	>,
	file: string,
	data: string,
	nonce: string,
	mode = 0o600,
	fsync = false,
): void {
	if (!nonce || nonce.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(nonce)) throw new Error("Invalid atomic-write nonce");
	const sleep = (ms: number) => {
		try {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
		} catch {}
	};
	const retryDelays = [20, 60, 150, 400];
	const transient = ["EPERM", "EACCES", "EBUSY"];
	const sep = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
	if (sep > 0) fs.mkdirSync(file.slice(0, sep), { recursive: true });
	const temporary = `${file}.${nonce}.tmp`;
	try {
		const descriptor = fs.openSync(temporary, "wx", mode);
		try {
			fs.writeFileSync(descriptor, data, "utf8");
			if (fsync) fs.fsyncSync(descriptor);
		} finally {
			fs.closeSync(descriptor);
		}
		for (let attempt = 0; ; attempt++) {
			try {
				fs.renameSync(temporary, file);
				break;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				const attemptDelay = retryDelays[attempt];
				if (attemptDelay === undefined || !transient.includes(code ?? "")) throw error;
				sleep(attemptDelay);
			}
		}
	} finally {
		try {
			fs.rmSync(temporary, { force: true });
		} catch {}
	}
}

/** 注入式容错读：与 `readFileSyncRetry` 同一套退避，可 `toString()` 后独立运行。 */
export function readFileSyncRetryPortableSync(
	fs: Pick<typeof import("node:fs"), "readFileSync">,
	file: string,
	encoding: BufferEncoding = "utf8",
): string {
	const sleep = (ms: number) => {
		try {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
		} catch {}
	};
	const retryDelays = [20, 60, 150, 400];
	const transient = ["EPERM", "EACCES", "EBUSY"];
	for (let attempt = 0; ; attempt++) {
		try {
			return fs.readFileSync(file, encoding) as string;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			const attemptDelay = retryDelays[attempt];
			if (code === "ENOENT" || attemptDelay === undefined || !transient.includes(code ?? "")) throw error;
			sleep(attemptDelay);
		}
	}
}

export function portableAtomicWriteSyncSource(): string {
	return `const writeAtomicPortable = (${writeAtomicPortableSync.toString()});`;
}

export function portableAtomicReadSyncSource(): string {
	return `const readFileSyncRetryPortable = (${readFileSyncRetryPortableSync.toString()});`;
}

export function writeJsonAtomicSync(file: string, data: unknown, indent: number | string = 2): void {
	const text = JSON.stringify(data, null, indent) + "\n";
	writeAtomicSync(file, text);
}
