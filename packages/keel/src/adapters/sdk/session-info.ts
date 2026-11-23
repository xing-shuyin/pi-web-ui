import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { assertSupportedTranscriptVersion, openSessionManagerAsync } from "../../../../../server/session-open.js";
import { normalizeTitle } from "../../kernel/conversation/index.js";

export interface RenameSessionFileInput {
	sessionFile: string;
	title: string;
}

/**
 * 会话记录必须已经躺在盘上：SDK 的 open 对不存在的路径会当场建一份新会话，
 * 改名绝不能顺手在别处造出转录来（fail-closed）。
 */
async function requireSessionFile(sessionFile: string): Promise<string> {
	const resolvedPath = resolve(sessionFile);
	let isFile = false;
	try {
		isFile = (await stat(resolvedPath)).isFile();
	} catch {
		isFile = false;
	}
	if (!isFile) throw new Error(`会话记录不存在，已拒绝写入会话名：${resolvedPath}`);
	return resolvedPath;
}

/**
 * 把标题落到会话文件（一条 `session_info` 记录，追加而不是重写转录）。
 * 标题归一复用 kernel 的单源；读文件一律走 `server/session-open.ts`，本文件不碰 jsonl 字节。
 */
export async function renameSessionFile(input: RenameSessionFileInput): Promise<{ ok: true; title: string }> {
	const title = normalizeTitle(input.title);
	const sessionFile = await requireSessionFile(input.sessionFile);
	// 顺序是硬约束：版本门禁必须早于打开，看不懂的转录连打开都不许。
	assertSupportedTranscriptVersion(sessionFile);
	const manager = await openSessionManagerAsync(sessionFile);
	manager.appendSessionInfo(title);
	// 落盘后的标题以文件里的记录为准：SDK 自己还会折掉换行。
	return { ok: true, title: manager.getSessionName() ?? title };
}

/** 只读会话名：文件不在、转录打不开、版本不认识都算「没有名字」，一律不抛。 */
export async function readSessionName(sessionFile: string): Promise<string | undefined> {
	try {
		const manager = await openSessionManagerAsync(await requireSessionFile(sessionFile));
		return manager.getSessionName();
	} catch {
		return undefined;
	}
}
