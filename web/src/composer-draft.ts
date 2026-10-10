/**
 * 输入框草稿的纯逻辑（便于单测）：文本合并 + 待发附件追加。
 *
 * 两个使用方：① 把「撤回的排队/插队消息」放回输入框；② 宿主注入草稿
 * （浏览器元素拾取扩展 / 插件 → 见 composer-bridge.ts）。两边的纪律一致：
 * **绝不覆盖用户正在打的内容**，只填空位或追加。
 */

/**
 * @param current  输入框当前内容
 * @param recalled 被撤回的消息原文（空字符串视为无内容，原样返回 current）
 */
export function mergeRecalledDraft(current: string, recalled: string): string {
	if (!recalled) return current;
	if (!current.trim()) return recalled;
	return `${current.replace(/\s+$/, "")}\n${recalled}`;
}

/**
 * 草稿恢复的纯决策：服务端快照 vs 本地 L1，新的赢；已应用过的
 * （ts <= appliedTs，包括 submit 时打的时间戳水位）一律不恢复。
 *
 * 背景（TODO 9）：submit() 成功后把 appliedTs 打到提交时刻，之前打的
 * 旧草稿（防抖延迟的 `draft_update`、prompt() 处理前的全量快照里带的
 * 旧 draft）ts 都 <= 提交时刻，恢复 effect 因此不再把刚发出去的文本
 * 倒回输入框；提交后新打的字 ts 更大，照常恢复。
 *
 * @param server 全量快照里带的服务端草稿（空文本 / ts<=0 视为无）
 * @param local  本地 L1 草稿（localStorage，调用方读好传入）
 * @param appliedTs 已应用的恢复 ts 水位（迟到的重复快照不再重应用）
 */
export function selectDraftToRestore(
	server: { text: string; ts: number } | null | undefined,
	local: { text: string; ts: number } | null,
	appliedTs: number,
): { text: string; ts: number } | null {
	let best: { text: string; ts: number } | null = null;
	if (server && server.text && server.ts > 0) best = { text: server.text, ts: server.ts };
	if (local && local.text && local.ts > (best?.ts ?? 0)) best = local;
	if (!best || best.ts <= appliedTs) return null;
	return best;
}

/** 待发附件（结构上与 App 的 PendingAttachment / ChatInput 的 attachments prop 一致）。 */
export interface DraftAttachment {
	path: string;
	name: string;
	/**
	 * "page" = a web page granted to the AI (page-picker extension): `path` is
	 * the page origin (also the `browser_page` target) and `name` its title —
	 * it is never treated as a workspace path.
	 * "conversation" = another conversation quoted by the user: `path` is unused,
	 * the reference travels in conversationId (running, incl. subagents) or
	 * sessionPath (history transcript); the AI fetches it via conversation_read.
	 * "reference"/"lines" = 工作区路径引用（文件内容不进 prompt）。
	 * "inline" = 旧版「全文注入」的遗留值（服务端按 reference 处理）。
	 * 粘贴图片/上传文件没有 mode（path 为空）。
	 */
	mode?: "inline" | "reference" | "lines" | "page" | "conversation" | "quote";
	quote?: import("../../server/protocol.js").TextQuote;
	/** mode "conversation" + 引用运行中对话的 id（如 "c3"）。 */
	conversationId?: string;
	/** mode "conversation" + 引用历史会话的转录文件 path。 */
	sessionPath?: string;
	isDir?: boolean;
	lines?: { start: number; end: number };
	/** Raw pasted/dropped/picked image (no workspace path — `path` is ""). */
	imageData?: string;
	mimeType?: string;
	/** Raw uploaded file bytes (no workspace path — `path` is ""). */
	fileData?: string;
	size?: number;
	/** Stable dedupe/removal key for path-less attachments. */
	key?: string;
}

/**
 * 附件的判重身份：与 App 里手动 attach 的口径一致（path + mode + 行区间）。
 * 返回 null = 没有可比身份（既无 key 又无 path 的裸数据，如截图）→ 一律追加，不去重
 * （拿不到身份就宁可按两份算，也不能把用户刚注入的截图悄悄吃掉）。
 */
function attachmentIdentity(a: DraftAttachment): string | null {
	if (a.mode === "quote" && a.quote) {
		return `quote:${JSON.stringify([a.quote.sessionId ?? "", a.quote.messageId, a.quote.role, a.quote.text])}`;
	}
	if (a.key) return `key:${a.key}`;
	if (a.mode === "conversation") {
		if (a.conversationId) return `conv:id:${a.conversationId}`;
		if (a.sessionPath) return `conv:path:${a.sessionPath}`;
		return null;
	}
	if (!a.path) return null;
	return `${a.path}|${a.mode}|${a.lines ? `${a.lines.start}-${a.lines.end}` : ""}`;
}

/**
 * 待发附件的「会话闸门」：会话身份一换，输入框里的待发附件就该跟正文草稿一样归零。
 *
 * 背景：正文草稿按 sessionId 存（ChatInput 切会话即清空、再恢复该会话的草稿），
 * 而待发附件只活在 App 的内存里 —— 不跟着会话清，点「新建对话」后就会出现
 * 「正文（含 @ 引用）已被新会话清掉、输入框上方那排 chips 还挂着上一个对话的文件」
 * 的错位状态（chips 会随下一条消息一起发出去，等于把上个对话的引用带进新对话）。
 *
 * @param prev      上一次记下的会话身份（首次调用传空串）
 * @param sessionId 快照里的当前会话身份（空串 = 未连接 / 会话未就绪的瞬时态）
 * @returns key   下一次比较用的身份；clear 本次是否清空待发附件
 */
export function advanceComposerSession(prev: string, sessionId: string): { key: string; clear: boolean } {
	// 瞬时态（断线重连、会话还没就绪）：不动水位也不清 ——
	// 否则「快照里 sessionId 短暂为空」会被当成切了会话，把用户的待发附件误清。
	if (!sessionId) return { key: prev, clear: false };
	// 首次就绪：没有「上一个会话」可比，不清（挂载时本来也没有待发附件）。
	if (!prev) return { key: sessionId, clear: false };
	return { key: sessionId, clear: prev !== sessionId };
}

/**
 * 往待发附件末尾追加（宿主注入用）：已有的**原样保留**，只追加新的，重复项丢弃。
 *
 * @param current  输入框当前待发附件
 * @param incoming 要追加的附件（空数组原样返回 current）
 */
export function appendDraftAttachments(current: DraftAttachment[], incoming: DraftAttachment[]): DraftAttachment[] {
	if (incoming.length === 0) return current;
	if (current.length === 0) return [...incoming];
	const seen = new Set(current.map(attachmentIdentity).filter((id): id is string => id !== null));
	const out = [...current];
	for (const item of incoming) {
		const id = attachmentIdentity(item);
		if (id !== null) {
			if (seen.has(id)) continue;
			seen.add(id);
		}
		out.push(item);
	}
	return out;
}

/**
 * 当会话切换时，判断是否应将上一个会话尚未发送的打字内容结转到新会话中：
 * 仅当新会话为完全空白的对话（无任何历史消息）且新会话自身没有任何草稿时，才承接上一会话的输入。
 */
export function shouldCarryOverDraft(
	pendingCarry: string | null | undefined,
	targetMessageCount: number,
	hasExistingDraftOnTarget: boolean,
): boolean {
	if (!pendingCarry || !pendingCarry.trim()) return false;
	if (targetMessageCount > 0) return false;
	if (hasExistingDraftOnTarget) return false;
	return true;
}

/** 提示词模板填入非空输入框时的三种用户选择（issue #586）。 */
export type TemplateFillChoice = "cancel" | "append" | "overwrite";

/**
 * 判断点击提示词模板（`pi-web:fill`）时是否需要先弹确认框（issue #586）：
 * - 输入框为空 / 仅空白 → 直接填入，不弹窗；
 * - 待填入文本为空，或与当前内容去首尾空白后完全一致 → 不弹窗；
 * - 输入框已有其他草稿文本 → 弹窗询问（取消 / 追加 / 覆盖）。
 */
export function shouldConfirmTemplateFill(current: string, incoming: string): boolean {
	if (!incoming || !incoming.trim()) return false;
	const cur = current.trim();
	if (!cur) return false;
	if (cur === incoming.trim()) return false;
	return true;
}

/**
 * 按用户在模板填入确认框中的选择计算新的输入框内容（issue #586）：
 * - `"cancel"` → 返回 `null`（保持原样不动）；
 * - `"append"` → 复用 `mergeRecalledDraft(current, incoming)` 以换行追加到末尾；
 * - `"overwrite"` → 用 `incoming` 替换当前内容。
 */
export function applyTemplateFill(current: string, incoming: string, choice: TemplateFillChoice): string | null {
	switch (choice) {
		case "cancel":
			return null;
		case "append":
			return mergeRecalledDraft(current, incoming);
		case "overwrite":
			return incoming;
	}
}
