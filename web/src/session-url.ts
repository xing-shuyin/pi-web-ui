/**
 * 会话与消息的 URL 深链纯逻辑（issue #587）：
 *
 * 地址栏使用 URL fragment（`#s=<sessionId>&m=<messageId>`）：
 * - fragment 永不发往服务端，天然不触碰 `PI_WEB_TOKEN` 鉴权中间件与服务端日志；
 * - 切换 / 新建会话时同步更新地址栏 hash；
 * - 首载 / `hashchange` / `popstate` 时解析 `#s=<sessionId>&m=<messageId>`，切到目标会话并滚动定位消息；
 * - 复制深链时自动剥离地址栏可能残留的 `?token=`。
 */

export interface SessionUrlTarget {
	sessionId: string;
	messageId?: string;
}

/**
 * 解析 `location.hash`（如 `"#s=01961f3a-...&m=a-1712345678901-1"`）。
 * 无有效 `s=` 参数时返回 `null`。
 */
export function parseSessionHash(hash: string | null | undefined): SessionUrlTarget | null {
	if (!hash) return null;
	const raw = hash.startsWith("#") ? hash.slice(1) : hash;
	if (!raw.trim()) return null;
	const params = new URLSearchParams(raw);
	const sessionId = params.get("s")?.trim() ?? "";
	if (!sessionId) return null;
	const messageId = params.get("m")?.trim() || undefined;
	return messageId ? { sessionId, messageId } : { sessionId };
}

/**
 * 将目标会话（及可选消息 id）格式化为 `#s=...` fragment（空目标返回 `""`）。
 */
export function formatSessionHash(target: SessionUrlTarget | null | undefined): string {
	const sessionId = target?.sessionId?.trim() ?? "";
	if (!sessionId) return "";
	const messageId = target?.messageId?.trim() ?? "";
	const base = `#s=${encodeURIComponent(sessionId)}`;
	return messageId ? `${base}&m=${encodeURIComponent(messageId)}` : base;
}

/**
 * 基于当前页面地址生成可分享的会话/消息深链（自动剥离 `?token=` 查询参数）。
 */
export function buildSessionDeepLink(currentHref: string, target: SessionUrlTarget): string {
	const hash = formatSessionHash(target);
	try {
		const u = new URL(currentHref);
		u.searchParams.delete("token");
		u.hash = hash;
		return u.toString();
	} catch {
		const base = currentHref.split("#")[0] ?? currentHref;
		return `${base}${hash}`;
	}
}

/**
 * 从会话转录文件路径中提取稳定的 `sessionId`：
 * - pi 引擎：`<timestamp>_<sessionId>.jsonl` 或 `<sessionId>.jsonl`
 * - DSH 引擎：`.../<sessionId>/session.jsonl`
 */
export function extractSessionIdFromPath(sessionPath: string | null | undefined): string | null {
	if (!sessionPath) return null;
	const norm = sessionPath.replace(/\\/g, "/").replace(/\/+$/, "");
	if (!norm) return null;
	const parts = norm.split("/");
	const base = parts[parts.length - 1] ?? "";
	if (!base) return null;
	if (base === "session.jsonl") {
		const parent = parts[parts.length - 2]?.trim() ?? "";
		return parent || null;
	}
	const stem = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
	if (!stem) return null;
	const underscoreIdx = stem.lastIndexOf("_");
	const candidate = underscoreIdx >= 0 ? stem.slice(underscoreIdx + 1).trim() : stem.trim();
	return candidate || null;
}

/**
 * 在已载入会话的 `UiMessage[]` 中解析 `&m=<messageId>` 对应的消息 id：
 * 1. 优先精确匹配 `m.id === targetMsgId`；
 * 2. 若会话从磁盘重载后 `seq` 序号发生变化（如 `a-<timestamp>-<seq>`），
 *    回退按 `<rolePrefix>-<timestamp>-` 前缀匹配同时间戳消息；
 * 3. 找不到时返回 `null`（停留在会话末尾）。
 */
export function resolveMessageIdForJump(
	messages: ReadonlyArray<{ id: string }>,
	targetMsgId: string | null | undefined,
): string | null {
	const want = targetMsgId?.trim() ?? "";
	if (!want || messages.length === 0) return null;
	const exact = messages.find((m) => m.id === want);
	if (exact) return exact.id;
	const prefixMatch = /^([a-z]+-\d+)-\d+$/.exec(want);
	if (prefixMatch) {
		const prefix = `${prefixMatch[1]}-`;
		const byPrefix = messages.find((m) => m.id.startsWith(prefix));
		if (byPrefix) return byPrefix.id;
	}
	return null;
}
