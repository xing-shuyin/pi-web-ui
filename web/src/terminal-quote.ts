/// <reference lib="dom" />
import { readTextQuote } from "../../server/text-quote.js";
import type { TextQuote } from "./types";

/**
 * 终端「右键 → 引用到输入框」的正文整理（纯函数，无 xterm 依赖，单测直接跑）。
 *
 * 引用走的是既有的 `mode: "quote"` 附件（与消息里选中文字引用同一条链路），
 * 所以这里只负责把终端里那段文本压成一条合格的 `TextQuote`：
 * 去掉行尾空白、去掉尾部空行、超长按行边界留下末尾（报错基本都在最后几行）。
 */

/** 单条引用上限：整屏选中（Ctrl+A）可能上兆字符，别把输入框和上下文撑爆。 */
export const TERMINAL_QUOTE_MAX_CHARS = 20000;

/**
 * 清洗终端输出。截断方向是**保留末尾**：终端里想引用的多是刚跑完的那段（报错、测试结果），
 * 开头被砍掉的地方不补提示语——正文只该是终端原样输出。
 */
export function terminalQuoteText(raw: string, maxChars: number = TERMINAL_QUOTE_MAX_CHARS): string {
	const lines = String(raw ?? "")
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""));
	while (lines.length > 0 && !lines[lines.length - 1]) lines.pop();
	let text = lines.join("\n");
	if (maxChars > 0 && text.length > maxChars) {
		text = text.slice(text.length - maxChars);
		const firstBreak = text.indexOf("\n");
		if (firstBreak >= 0) text = text.slice(firstBreak + 1);
	}
	return text;
}

/** 当前可视区（视口）的终端文本：`viewportY` 起 `rows` 行，行内尾部空白靠 `line()` 的实现裁掉。 */
export function terminalViewportText(buffer: { rows: number; viewportY: number; line(y: number): string }): string {
	const rows = Number.isFinite(buffer.rows) ? Math.max(0, Math.trunc(buffer.rows)) : 0;
	const start = Number.isFinite(buffer.viewportY) ? Math.max(0, Math.trunc(buffer.viewportY)) : 0;
	const out: string[] = [];
	for (let y = start; y < start + rows; y++) out.push(buffer.line(y) ?? "");
	return out.join("\n");
}

/**
 * 终端文本 → 引用附件里的 `TextQuote`。空内容返回 null，调用方据此不弹菜单 / 不塞空引用。
 *
 * `role` 用 `bashExecution`：终端输出在会话里就是这一类记录，引用卡片会显示成「终端」，
 * 带给模型的那份 JSON 也说明来源不是聊天消息；`messageId` 加 `terminal:` 前缀与真实消息 id 区分开。
 */
export function buildTerminalQuote(input: {
	text: string;
	terminalId: string;
	sessionId?: string;
	maxChars?: number;
}): TextQuote | null {
	const text = terminalQuoteText(input.text, input.maxChars ?? TERMINAL_QUOTE_MAX_CHARS);
	if (!text.trim()) return null;
	return readTextQuote({
		text,
		messageId: `terminal:${input.terminalId}`,
		role: "bashExecution",
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
	});
}
