/// <reference lib="dom" />

/**
 * 内置浏览器「标签页 / 选中文字 → 输入框」的正文整理（纯函数，单测直接跑）。
 *
 * 外壳（AI Browser 窗口）的右键菜单只给标题、地址与（可选的）选段；这里把它压成
 * 模型能直接读的引用块，插进当前对话的输入框：
 *
 * ```
 * 页面引用：标题 — https://…
 * 选中内容：
 * > 第一行
 * > 第二行
 * ```
 *
 * 页面内容不跟着走：Agent 有自己的浏览器工具，拿着地址自己读。
 */

import { en, interpolate, isZhLocale, zh } from "./i18n";

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

export interface BrowserReferenceInput {
	title?: string;
	url?: string;
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

/** 选段压成 markdown 引用行：去行尾空白、去尾部空行、超长按行边界截断并标注。 */
export function formatQuotedSelection(text: string, maxChars = BROWSER_QUOTE_MAX_CHARS): string {
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
	return body
		.split("\n")
		.map((line) => (line ? `> ${line}` : ">"))
		.join("\n");
}

/** 第一行的页面标识：`页面引用：标题 — 地址`（没有标题就只留地址）。 */
export function formatBrowserTabReference(input: BrowserReferenceInput): string {
	const url = usableUrl(String(input.url ?? "").trim());
	if (!url) return "";
	const title = cleanTitle(String(input.title ?? ""), url);
	return tr("browserRefPage", { target: title ? `${title} — ${url}` : url });
}

/**
 * 插进输入框的完整引用块：标签页标识 + （有选段时）引用后的选段，末尾留一个空行，
 * 光标落到之后继续写。地址不可用（内部页）时返回空串，调用方据此不插任何东西。
 */
export function browserReferenceInsertion(input: BrowserReferenceInput): string {
	const header = formatBrowserTabReference(input);
	if (!header) return "";
	const quote = formatQuotedSelection(input.text ?? "");
	return quote ? `${header}\n${tr("browserRefSelection")}\n${quote}\n\n` : `${header}\n`;
}
