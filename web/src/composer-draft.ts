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

/** 待发附件（结构上与 App 的 PendingAttachment / ChatInput 的 attachments prop 一致）。 */
export interface DraftAttachment {
	path: string;
	name: string;
	mode: "inline" | "reference" | "lines";
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
	if (a.key) return `key:${a.key}`;
	if (!a.path) return null;
	return `${a.path}|${a.mode}|${a.lines ? `${a.lines.start}-${a.lines.end}` : ""}`;
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
