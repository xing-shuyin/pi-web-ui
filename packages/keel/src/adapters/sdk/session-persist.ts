import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * `SessionManager` 里没有公开的「换成某个转录并让后续写入跟过去」：`setSessionFile()` 在目标文件
 * **不存在**时会 `newSession()`（条目树被换成一条新头），`persist` / `sessionDir` 只有私有字段。
 * 老实现的 `persistConversation` 也是这么做的（`as unknown as {…}` 逐字相同）。
 * 这份窄面就是那几项私有读写的**唯一落点**：其它层只认下面两个函数，不再各写一次强转。
 */
interface SessionManagerInternals {
	isPersisted?(): boolean;
	getSessionId?(): string;
	getSessionDir?(): string;
	setSessionFile?(file: string): void;
	/** 私有：整份文件条目（含头）；`persist = false` 的内存会话靠它把已有条目搬到新文件。 */
	fileEntries?: unknown[];
	/** 私有：`true` 才会真的 append 到 `sessionFile`。 */
	persist?: boolean;
	/** 私有：`true` = 首条 append 不再重写整份文件。 */
	flushed?: boolean;
	sessionDir?: string;
}

function managerOf(session: unknown): SessionManagerInternals | undefined {
	if (!session || typeof session !== "object") return undefined;
	const manager = (session as { sessionManager?: unknown }).sessionManager;
	return manager && typeof manager === "object" ? (manager as SessionManagerInternals) : undefined;
}

/**
 * 这条会话是否已落盘（`SessionManager.isPersisted()` 的窄面）。
 * 拿不到 manager（会话没开 / 不是 SDK 会话）= 视为未落盘，与老实现 `sm?.isPersisted?.()` 同口径。
 */
export function isPersistedSession(session: unknown): boolean {
	return managerOf(session)?.isPersisted?.() === true;
}

export interface PersistSessionFileInput {
	/** 宿主那个 SDK 会话（`opened.session`）；只读它的 `sessionManager`。 */
	session: unknown;
	/** 会话目录的**工作区基准**（`resolveWorkspaceSessionDir(dataDir, cwd)`）：远程工作区也走同一份。 */
	sessionBaseDir: string;
	/** 转录头里的 cwd（对话的工作目录，不是会话目录）。 */
	cwd: string;
}

/**
 * 把一条内存会话写成正式转录，并让它的 manager 之后往这份文件 append（老实现 `persistConversation`
 * 的落盘段，逐字搬入）。返回新转录路径。
 *
 * 顺序是硬约束：**先写文件、再 `setSessionFile()`** —— 目标文件不存在时 SDK 会把条目树重置成一条新头，
 * 等于把这条对话的历史丢掉。写完 `setSessionFile()` 会读回刚写的条目（`flushed = true`），
 * 因此后续 append 是增量写，不是整份重写。
 */
export async function persistSessionFile(input: PersistSessionFileInput): Promise<string> {
	const manager = managerOf(input.session);
	if (!manager) throw new Error("这个会话没有 SDK sessionManager，无法落盘（fail-closed）");
	const sessionDir = SessionManager.create(input.sessionBaseDir).getSessionDir();
	if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

	const timestamp = new Date().toISOString();
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	const sessionId = manager.getSessionId?.() || randomUUID();
	const sessionFile = join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);

	const entries = Array.isArray(manager.fileEntries) ? manager.fileEntries : [];
	const hasHeader = entries.some((entry) => (entry as { type?: unknown } | undefined)?.type === "session");
	const header = { type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp, cwd: input.cwd };
	const lines = (hasHeader ? entries : [header, ...entries]).map((entry) => JSON.stringify(entry));
	await writeFile(sessionFile, `${lines.join("\n")}\n`, "utf8");

	manager.setSessionFile?.(sessionFile);
	manager.sessionDir = sessionDir;
	manager.persist = true;
	manager.flushed = true;
	return sessionFile;
}
