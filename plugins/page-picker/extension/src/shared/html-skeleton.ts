/// <reference lib="dom" />
/**
 * HTML 骨架提取（纯函数，可在 jsdom 里单测）。
 *
 * 为什么不是 outerHTML：一个真实卡片的 outerHTML 动辄几千字符，而 AI 需要的是
 * **结构**（几层、什么标签、什么 class），不是全部子内容。所以：
 * - 到 maxDepth 层就把子节点折成 `…`；
 * - 文本节点折叠空白 + 截断；
 * - 最后整体截断到 maxLength，兜住极端情况。
 */

import { collapse, truncate } from "./text.js";

const VOID_TAGS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

export interface SkeletonOptions {
	/** 从根元素算起展开几层（默认 2）。 */
	maxDepth?: number;
	/** 单个文本节点最多几个字符（默认 60）。 */
	maxText?: number;
	/** 骨架总长上限（默认 400）。 */
	maxLength?: number;
	/** class 最多带几个（默认 4）。 */
	maxClasses?: number;
}

function attrsOf(el: Element, maxClasses: number): string {
	const parts: string[] = [];
	const id = el.getAttribute("id");
	if (id) parts.push(`id="${id}"`);
	const classes = [...el.classList];
	if (classes.length > 0) {
		const shown = classes.slice(0, maxClasses).join(" ");
		parts.push(`class="${shown}${classes.length > maxClasses ? " …" : ""}"`);
	}
	return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/** 把一个元素子树渲染成骨架字符串。 */
export function htmlSkeleton(root: Element, opts: SkeletonOptions = {}): string {
	const maxDepth = Math.max(0, opts.maxDepth ?? 2);
	const maxText = Math.max(0, opts.maxText ?? 60);
	const maxLength = Math.max(16, opts.maxLength ?? 400);
	const maxClasses = Math.max(0, opts.maxClasses ?? 4);

	let out = "";
	const emit = (el: Element, depth: number): void => {
		const tag = el.tagName.toLowerCase();
		out += `<${tag}${attrsOf(el, maxClasses)}>`;
		if (VOID_TAGS.has(tag)) return;
		if (depth >= maxDepth) {
			// 还有子节点 → 用 … 表示「这里还有内容但省略了」
			if (el.childNodes.length > 0) out += "…";
			out += `</${tag}>`;
			return;
		}
		for (const child of el.childNodes) {
			if (child.nodeType === 3) {
				const text = collapse(child.textContent ?? "");
				if (text) out += truncate(text, maxText);
			} else if (child.nodeType === 1) {
				emit(child as Element, depth + 1);
			}
		}
		out += `</${tag}>`;
	};
	emit(root, 0);
	return truncate(out, maxLength);
}
