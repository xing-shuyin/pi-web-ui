/**
 * 打开历史会话的 SessionManager：异步读盘 + 分时片解析（C2）。
 *
 * SDK 的 `SessionManager.open` 用同步 readSync 读完整个转录并逐行 JSON.parse，大转录（数十 MB）
 * 会把事件循环卡住数百毫秒——期间所有客户端的 WebSocket（流式输出、心跳、其他人的操作）一起停摆。
 * 这里改为 fs.promises 异步读取，逐行解析时每 ~8ms 让出一次事件循环，再把解析好的条目交给 SDK
 * （与 `SessionManager.open` 在超大头部时走的 preloadedFileEntries 是同一条构造路径）。
 *
 * 总 CPU 不变，变化的是「不再独占主线程」。
 *
 * SDK 的构造函数在类型上是 private：这里按其运行时签名
 * `(cwd, sessionDir, sessionFile, persist, newSessionOptions, preloadedFileEntries)` 调用，
 * 并在构造后核验结果（会话文件、会话 id、条目数）；任何一步不符或抛错都回退到
 * `SessionManager.open`，因此 SDK 将来改了签名也只会退回原行为，不会打开错的会话。
 * `PI_WEB_ASYNC_SESSION_OPEN=0` 可强制使用原路径。
 *
 * 与 SDK `loadEntriesFromFile` 的语义对齐：空行 / 坏行跳过；首条必须是带字符串 id 的 session
 * 头（否则交给 SDK 原路径处理报错 / 空文件语义）；文件末尾缺换行时补一个 "\n"。
 */
import { promises as fsPromises } from "node:fs";
import { dirname, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const SLICE_MS = 8;

export interface ParsedJsonl {
	entries: Record<string, unknown>[];
	/** 最后一个换行之后的残余文本（非空 = 文件末尾缺换行）。 */
	tail: string;
}

/** 逐行解析 JSONL，每 sliceMs 让出一次事件循环。规则同 SDK parseSessionEntryLine。 */
export async function parseJsonlSliced(raw: string, sliceMs = SLICE_MS): Promise<ParsedJsonl> {
	const entries: Record<string, unknown>[] = [];
	let start = 0;
	let sliceStart = performance.now();
	const take = (line: string) => {
		if (!line.trim()) return;
		try {
			const v = JSON.parse(line) as unknown;
			if (v) entries.push(v as Record<string, unknown>); // SDK：`if (entry) entries.push(entry)`
		} catch {
			// Skip malformed lines（与 SDK 一致）
		}
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
	if (process.env.PI_WEB_ASYNC_SESSION_OPEN === "0") return SessionManager.open(resolvedPath);
	let raw: string;
	try {
		raw = await fsPromises.readFile(resolvedPath, "utf8");
	} catch {
		return SessionManager.open(resolvedPath);
	}
	const { entries, tail } = await parseJsonlSliced(raw);
	const header = entries[0];
	if (!header || header.type !== "session" || typeof header.id !== "string") {
		// 空文件 / 非 pi 会话：交给 SDK 原路径（初始化空文件或抛出明确错误）
		return SessionManager.open(resolvedPath);
	}
	try {
		// SDK loadEntriesFromFile：头部合法且文件末尾缺换行时先补一个（在构造前，构造可能因版本迁移重写文件）
		if (tail) await fsPromises.appendFile(resolvedPath, "\n");
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
