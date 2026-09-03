/**
 * 折叠消息的搜索索引 —— 纯函数、零依赖（可被 tsconfig.tests.json 单测）。
 *
 * 折叠的旧消息（CollapsedMessage 摘要行）全文不在 DOM 里，Ctrl+F 的「DOM 即
 * 事实源」收集看不到它们。这里有两条路：
 *   a) 搜索期间把旧消息全部展开 —— 重（几百条消息全部渲染）；
 *   b) 用消息数据（UiMessage 仍在内存）做折叠层索引，命中后**只展开那一条**
 *      —— 按需展开，DOM 增量最小。
 * 本文件实现 b 的纯函数部分：
 *   - `foldedSearchText`：把一条消息折叠成可搜索文本。字段与展开后的 DOM
 *     渲染**逐一对齐**（text/thinking 原文、toolCall 名称+参数、bash 命令+
 *     输出），并额外并入该 toolCall 的 toolResult 文本——折叠时 toolResult
 *     消息没有独立行（DOM 里结果本就渲染在宿主 toolCall 卡内），归属到宿主
 *     才能让「搜到 → 展开 → 定位」指到同一个词。
 *   - `collectFoldedHits`：对全部折叠消息扫一遍 query，返回每条消息的命中
 *     次数（SearchBar 据此合并进总命中序列）。
 */
interface FoldedBlock {
	type: string;
	id?: unknown;
	text?: unknown;
	thinking?: unknown;
	name?: unknown;
	argumentsText?: unknown;
	command?: unknown;
	output?: unknown;
}

export interface FoldedMessage {
	id: string;
	role: string;
	content: FoldedBlock[];
}

/** toolCallId → toolResult 消息（镜像 UiMessage 的 text 内容）。 */
export interface FoldedResultMessage {
	content: FoldedBlock[];
}

/** toolResult 消息渲染在宿主 toolCall 卡里的文本。 */
export function foldedResultText(m: FoldedResultMessage): string {
	const parts: string[] = [];
	for (const b of m.content) {
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("\n");
}

/** 一条消息的可搜索折叠文本（顺序 = 内容块顺序，与 DOM 文档序一致）。 */
export function foldedSearchText(m: FoldedMessage, results: ReadonlyMap<string, FoldedResultMessage>): string {
	const parts: string[] = [];
	for (const b of m.content) {
		if (b.type === "text" && typeof b.text === "string") {
			parts.push(b.text);
		} else if (b.type === "thinking" && typeof b.thinking === "string") {
			parts.push(b.thinking);
		} else if (b.type === "toolCall") {
			if (typeof b.name === "string") parts.push(b.name);
			if (typeof b.argumentsText === "string") parts.push(b.argumentsText);
			if (typeof b.id === "string") {
				const r = results.get(b.id);
				if (r) {
					const t = foldedResultText(r);
					if (t) parts.push(t);
				}
			}
		} else if (b.type === "bash") {
			if (typeof b.command === "string") parts.push(b.command);
			if (typeof b.output === "string") parts.push(b.output);
		}
	}
	return parts.join("\n");
}

function countOccurrences(text: string, needle: string): number {
	let n = 0;
	let idx = text.indexOf(needle);
	while (idx !== -1) {
		n++;
		idx = text.indexOf(needle, idx + needle.length);
	}
	return n;
}

/**
 * 折叠消息命中计数：msgId → 命中次数（大小写不敏感）。
 * 只统计 `collapsedIds` 里的消息——已渲染的消息走 DOM 收集，不在这里重复。
 */
export function collectFoldedHits(
	messages: readonly FoldedMessage[],
	collapsedIds: ReadonlySet<string>,
	query: string,
	results: ReadonlyMap<string, FoldedResultMessage>,
): Map<string, number> {
	const out = new Map<string, number>();
	const needle = query.toLowerCase();
	if (!needle) return out;
	for (const m of messages) {
		if (!collapsedIds.has(m.id)) continue;
		const n = countOccurrences(foldedSearchText(m, results).toLowerCase(), needle);
		if (n > 0) out.set(m.id, n);
	}
	return out;
}
