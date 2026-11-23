import { promises as fsPromises, closeSync, openSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import { noteStorageIssue } from "./versioned-doc.js";

const SLICE_MS = 8;
/** 首行探针缓冲：会话头只占几十字节，读 256KB 足够覆盖任何异常的超长首行，同时不碰整份转录。 */
const HEADER_PROBE_BYTES = 256 * 1024;

/**
 * 转录版本门禁（issues #982 第 5 条）。
 *
 * 会话文件的版本号写在自己首行，但此前**没有任何读取方**：旧内核会把新格式的记录 append 进看不懂
 * 的转录，首行仍只声明一个数字。跟上 SDK 的当前版本，比它大的就不许打开、不许追加。
 */
export class UnsupportedTranscriptVersionError extends Error {
	readonly code = "TRANSCRIPT_VERSION_UNSUPPORTED";
	readonly version: unknown;
	constructor(file: string, version: unknown) {
		super(
			`该会话记录的格式版本（${String(version)}）比当前内核支持的版本（1..${CURRENT_SESSION_VERSION}）新，已拒绝打开以免写坏原文件。请更新 pi-web-ui 后再打开：${file}`,
		);
		this.name = "UnsupportedTranscriptVersionError";
		this.version = version;
	}
}

/** 已解析的会话头是否是我们能读写的版本；`type: "session"` 以外的首行不归这里管。 */
export function assertSupportedTranscriptHeader(header: unknown, filePath: string): void {
	const record = header as { type?: unknown; version?: unknown } | null | undefined;
	if (!record || record.type !== "session") return;
	// 无版本号 = 老格式，SDK 会自己把它迁到当前版本。
	const version = record.version ?? 1;
	if (typeof version === "number" && Number.isInteger(version) && version >= 1 && version <= CURRENT_SESSION_VERSION)
		return;
	noteStorageIssue({
		file: filePath,
		label: "session-transcript",
		state: "foreign",
		reason: `转录版本不认识（读到 ${String(version)}，支持 1..${CURRENT_SESSION_VERSION}）；已拒绝打开与追加`,
		foundVersion: version,
	});
	throw new UnsupportedTranscriptVersionError(filePath, version);
}

/** 只读首行就判定版本：给直接 `SessionManager.open` 的调用点用，不整份读（#945 的 74MB 会话代价）。 */
export function assertSupportedTranscriptVersion(filePath: string): void {
	let fd: number | null = null;
	try {
		fd = openSync(filePath, "r");
		const buffer = Buffer.alloc(HEADER_PROBE_BYTES);
		const read = readSync(fd, buffer, 0, buffer.length, 0);
		const firstLine = buffer.subarray(0, read).toString("utf8").split("\n", 1)[0] ?? "";
		if (!firstLine.trim()) return;
		let header: unknown;
		try {
			header = JSON.parse(firstLine);
		} catch {
			// 首行不是 JSON：不是我们能判定的东西，交给既有修复路径，不在这里判死。
			return;
		}
		assertSupportedTranscriptHeader(header, filePath);
	} catch (error) {
		if (error instanceof UnsupportedTranscriptVersionError) throw error;
		// 读不出来（不存在 / 占用）：不在这里判死，调用方自己的失败处理更清楚。
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {}
		}
	}
}

export interface ParsedJsonl {
	entries: Record<string, unknown>[];
	tail: string;
}

export async function parseJsonlSliced(raw: string, sliceMs = SLICE_MS): Promise<ParsedJsonl> {
	const entries: Record<string, unknown>[] = [];
	let start = 0;
	let sliceStart = performance.now();
	const take = (line: string) => {
		if (!line.trim()) return;
		try {
			const v = JSON.parse(line) as unknown;
			if (v) entries.push(v as Record<string, unknown>);
		} catch {}
	};
	for (;;) {
		const nl = raw.indexOf("\n", start);
		if (nl === -1) break;
		take(raw.slice(start, nl));
		start = nl + 1;
		if (performance.now() - sliceStart >= sliceMs) {
			await setImmediate();
			sliceStart = performance.now();
		}
	}
	const tail = raw.slice(start);
	take(tail);
	return { entries, tail };
}

type SessionManagerCtor = new (
	cwd: string,
	sessionDir: string,
	sessionFile: string,
	persist: boolean,
	newSessionOptions: undefined,
	preloadedFileEntries: unknown[],
) => SessionManager;

export async function openSessionManagerAsync(path: string): Promise<SessionManager> {
	const resolvedPath = resolve(path);
	assertSupportedTranscriptVersion(resolvedPath);
	if (process.env.PI_WEB_ASYNC_SESSION_OPEN === "0") return SessionManager.open(resolvedPath);
	let raw: string;
	try {
		raw = await fsPromises.readFile(resolvedPath, "utf8");
	} catch {
		return SessionManager.open(resolvedPath);
	}
	const { entries, tail } = await parseJsonlSliced(raw);
	const header = entries[0];
	assertSupportedTranscriptHeader(header, resolvedPath);
	if (!header || header.type !== "session" || typeof header.id !== "string") {
		return SessionManager.open(resolvedPath);
	}
	try {
		if (tail) {
			// 半行补 `\n` 的交错窗口：若半行其实是另一个写入者 append 中途，
			// 此时补 `\n` 会插进它的行中间，把一条本会完整的记录截成两段坏 JSON。
			// 单机单实例概率极低，多宿主/远端盘存在。补写前校验文件自本次读取后未变动；
			// 若已变动则不补，直接回退 SDK 原路径重读新鲜文件（残余 stat→append 间隙极小，接受）。
			let unchanged = false;
			try {
				const st = await fsPromises.stat(resolvedPath);
				unchanged = st.size === Buffer.byteLength(raw);
			} catch {
				unchanged = false;
			}
			if (!unchanged) return SessionManager.open(resolvedPath);
			await fsPromises.appendFile(resolvedPath, "\n");
		}
		const cwd = typeof header.cwd === "string" ? header.cwd : process.cwd();
		const Ctor = SessionManager as unknown as SessionManagerCtor;
		const manager = new Ctor(cwd, dirname(resolvedPath), resolvedPath, true, undefined, entries);
		const file = manager.getSessionFile();
		const ok =
			typeof file === "string" &&
			resolve(file) === resolvedPath &&
			manager.getSessionId() === header.id &&
			manager.getEntries().length === entries.length - 1;
		if (!ok) return SessionManager.open(resolvedPath);
		return manager;
	} catch {
		return SessionManager.open(resolvedPath);
	}
}
