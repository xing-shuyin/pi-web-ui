/// <reference lib="dom" />
/**
 * 文本小工具（纯函数）：所有进上下文的内容都要过这里，避免把整页 innerText 塞进去。
 */

/** 折叠连续空白（换行也压成单个空格）—— 元素文本大多是多行缩进的源码，不折叠等于送噪音。 */
export function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** 截断到 max 字符，超出加省略号（max 已经超了就不加，免得输出变长）。 */
export function truncate(text: string, max: number): string {
	if (max <= 0) return "";
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Markdown 行内代码：用反引号包住，内部反引号转义（文件路径/选择器都走它）。 */
export function code(value: string): string {
	const flat = collapse(value);
	const ticks = "`".repeat(Math.max(1, longestTickRun(flat) + 1));
	const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
	return `${ticks}${pad}${flat}${pad}${ticks}`;
}

function longestTickRun(text: string): number {
	let best = 0;
	let run = 0;
	for (const ch of text) {
		run = ch === "`" ? run + 1 : 0;
		if (run > best) best = run;
	}
	return best;
}
