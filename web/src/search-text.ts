/**
 * 会话内搜索 —— 纯函数索引与命中计数（无 React 依赖，可单测）。
 *
 * 每条消息折叠成一段可搜索文本（text / thinking / toolCall 名称+参数 /
 * bash 命令+输出），命中按「消息 × 出现次数」展开为扁平 hit 列表。
 *
 * > 注：SearchBar 已改用「DOM 渲染文本即事实源」的收集方式（序列化文本
 * > 与渲染文本不一致会导致 occurrence 指错区间），本文件当前无前端调用方，
 * > 保留其纯函数与单测供参考 / 复用。
 */

/**
 * 结构化类型镜像（同 message-delta.ts / skill-block.ts 模式）：
 * 本文件被 tsconfig.tests.json（NodeNext 解析）单测，同时被 Vite 打包，
 * 必须零依赖 —— 不能 import ./types（其内部无扩展名引用 protocol.ts）。
 */
interface SearchTextBlock {
	type: string;
	text?: unknown;
	thinking?: unknown;
	name?: unknown;
	argumentsText?: unknown;
	command?: unknown;
	output?: unknown;
}

export interface SearchMessage {
	id: string;
	role: string;
	content: SearchTextBlock[];
	errorMessage?: string;
}

/** Extract the searchable text of one message. */
export function messageSearchText(m: SearchMessage): string {
	// toolResult 单独渲染为空（内容由 toolCall 卡片展示）——跳转目标不存在。
	if (m.role === "toolResult") return "";
	const parts: string[] = [];
	for (const b of m.content) {
		collectBlock(b, parts);
	}
	if (m.errorMessage) parts.push(m.errorMessage);
	return parts.join("\n");
}

function collectBlock(b: SearchTextBlock, out: string[]) {
	if (typeof b.text === "string") {
		out.push(b.text);
		return;
	}
	switch (b.type) {
		case "thinking":
			if (typeof b.thinking === "string") out.push(b.thinking);
			break;
		case "toolCall": {
			if (typeof b.name === "string") out.push(b.name);
			if (typeof b.argumentsText === "string") out.push(b.argumentsText);
			break;
		}
		case "bash":
			if (typeof b.command === "string") out.push(b.command);
			if (typeof b.output === "string") out.push(b.output);
			break;
	}
}

/** Case-insensitive occurrence count of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
	const n = needle.trim().toLowerCase();
	if (!n) return 0;
	const h = haystack.toLowerCase();
	let count = 0;
	let i = h.indexOf(n);
	while (i !== -1) {
		count++;
		i = h.indexOf(n, i + n.length);
	}
	return count;
}

export interface SearchHit {
	/** Owning message id — jump target ([data-msg-id]). */
	messageId: string;
	/** Occurrence ordinal within that message (0-based). */
	occurrence: number;
}

/**
 * Flatten all hits across messages into a navigation list:
 * one entry per occurrence, in conversation order.
 */
export function buildSearchHits(messages: readonly SearchMessage[], query: string): SearchHit[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const hits: SearchHit[] = [];
	for (const m of messages) {
		const text = messageSearchText(m);
		if (!text) continue;
		const c = countOccurrences(text, q);
		for (let i = 0; i < c; i++) hits.push({ messageId: m.id, occurrence: i });
	}
	return hits;
}
