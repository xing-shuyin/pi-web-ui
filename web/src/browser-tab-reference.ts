/// <reference lib="dom" />

/**
 * 内置浏览器「标签页 / 选中文字 → 输入框」的引用整理（纯函数，单测直接跑）。
 *
 * 引用形式与「浏览器面板里的引用 / @页面」完全一致：**页面 chip**（`mode: "page"`），
 * 不往输入框里塞一段 `页面引用：…` 的文字。模型拿到的是地址 + 标题，要内容自己调
 * `browser_page` 去读——页面正文本来就不该由外壳搬进上下文。
 *
 * 页面里选中了文字时，再补一条 `mode: "quote"` 的引用 chip（那段是用户明确圈出来的），
 * 页面 chip 仍跟着走：否则模型不知道这段话出自哪个页面。
 */

import { readTextQuote } from "../../server/text-quote.js";
import { pageCitation } from "./browser-control";
import type { DraftAttachment } from "./composer-draft";
import { en, interpolate, isZhLocale, zh } from "./i18n";
import { randomUuid } from "./uuid";

/**
 * 文案走 i18n 字典（`i18n-hardcoded-guard` 要求）：本模块是纯函数、不拿 hook，
 * 所以按 `document.documentElement.lang`（i18n 自己写的那个）选字典，node 环境下回退中文。
 */
function tr(key: keyof typeof zh, vars?: Record<string, string | number>): string {
	const lang = typeof document !== "undefined" ? document.documentElement.lang : "zh";
	return interpolate((isZhLocale(lang) ? zh : en)[key] ?? zh[key], vars);
}

/** 选段上限与主进程侧（`QUOTE_MAX_CHARS`）同量级：再长就不是「引用」而是「搬正文」了。 */
export const BROWSER_QUOTE_MAX_CHARS = 6000;

/**
 * 引用标签（输入框 chip / 会话里的页面卡片）的标题上限：网页标题经常是整条 PR 标题、
 * 一串 SEO 关键词，原样铺进去会直接撑满一行。留到能认出来为止，剩下的交给模型自己读页面
 * （地址 / tabId 都还在）。
 */
export const BROWSER_REFERENCE_TITLE_MAX_CHARS = 10;

export interface BrowserReferenceInput {
	title?: string;
	url?: string;
	/** 桌面外壳里的原生标签页 id：模型拿它当 `browser_page` 的 target 最准 */
	tabId?: string;
	/** 页面里选中的文字（标签页右键引用时没有） */
	text?: string;
}

/** 只有 http(s) 页面才值得引用：内部页 / about:blank / file:// 直接放弃。 */
function usableUrl(url: string): string {
	return /^https?:\/\//i.test(url) ? url : "";
}

function cleanTitle(title: string, url: string): string {
	const value = title.replace(/\s+/g, " ").trim();
	return value && value !== url ? value : "";
}

/** 标题压成「用作标签」的长度：超长按字符边界截断并加省略号（不把半字 / 段尾标点带进省略号）。 */
export function shortenReferenceTitle(title: string, maxChars = BROWSER_REFERENCE_TITLE_MAX_CHARS): string {
	const value = String(title ?? "").trim();
	if (maxChars <= 0 || value.length <= maxChars) return value;
	const cut = value.slice(0, maxChars).replace(/[\s,;:，。；：、·-]+$/, "");
	return `${cut}…`;
}

/** 选段压成纯文本：去行尾空白、去首尾空行，超长按行边界截断并标注。 */
export function cleanSelectedText(text: string, maxChars = BROWSER_QUOTE_MAX_CHARS): string {
	const lines = String(text ?? "")
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""));
	while (lines.length && !lines[0]) lines.shift();
	while (lines.length && !lines[lines.length - 1]) lines.pop();
	if (!lines.length) return "";
	let body = lines.join("\n");
	if (maxChars > 0 && body.length > maxChars) {
		body = body.slice(0, maxChars);
		const lastBreak = body.lastIndexOf("\n");
		if (lastBreak > 0) body = body.slice(0, lastBreak);
		body = body + tr("browserRefTruncated");
	}
	return body;
}

/**
 * 要插进输入框的引用：页面 chip（+ 选段时的引用 chip）。
 * 地址不可用（内部页）时返回空数组，调用方据此什么都不加。
 */
export function browserReferenceAttachments(input: BrowserReferenceInput): DraftAttachment[] {
	const url = usableUrl(String(input.url ?? "").trim());
	if (!url) return [];
	const title = shortenReferenceTitle(cleanTitle(String(input.title ?? ""), url));
	const page = pageCitation({
		origin: url,
		...(title ? { title } : {}),
		...(input.tabId ? { tabId: input.tabId } : {}),
	});
	const text = cleanSelectedText(input.text ?? "");
	if (!text) return [page];
	const quote = readTextQuote({
		text,
		messageId: `page:${input.tabId || url}`,
		role: "page",
	});
	if (!quote) return [page];
	return [page, { path: "", name: title || shortenReferenceTitle(url), mode: "quote", quote, key: randomUuid() }];
}
