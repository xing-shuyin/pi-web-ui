import { findMostRecentSessionFileFast } from "../session-parser.js";

export interface LeadingSessionInput {
	/** 本连接的会话目录根（`ClientRuntime.historyRoot()`）。 */
	root: string | undefined;
	/** 当前工作区。 */
	cwd: string;
	/** 已经被本连接开着的转录（重连二次调用时不再续）。 */
	openFiles: () => readonly (string | undefined)[];
	/** 跨客户端归属查询：有人开着 / 在跑 = 不能续（同一转录两个写者会互相覆写）。 */
	findSessionOwner?: (file: string) => { connected?: boolean; isStreaming: boolean } | undefined;
}

/**
 * 连接期那条活动对话该续哪份转录（老 `SessionManager.continueRecent(sessionBaseDir)`）。
 *
 * 三道闸，与换项目恢复（`domains/sessions/workspace.ts` 的 `resumeTarget`）同一口径：
 * 算得出会话目录 → 扫得最近一份 → 那份没被别人开着。任何一步不成立就返回 `undefined`
 * = 落空白对话（老实现的 `blank` / `idleHeld` 支）。
 */
export async function resolveLeadingSessionFile(input: LeadingSessionInput): Promise<string | undefined> {
	if (!input.root) return undefined;
	let recent: string | undefined;
	try {
		recent = await findMostRecentSessionFileFast(input.root, input.cwd);
	} catch {
		return undefined;
	}
	if (!recent) return undefined;
	if (input.openFiles().includes(recent)) return undefined;
	try {
		const owner = input.findSessionOwner?.(recent);
		if (owner && (owner.connected === true || owner.isStreaming)) return undefined;
	} catch {
		// 归属查不到 = 不敢假设安全：宁可开空白对话，也不拿两份写者去覆写同一份转录。
	}
	return recent;
}
