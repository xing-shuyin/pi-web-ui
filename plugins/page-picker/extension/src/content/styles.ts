/// <reference lib="dom" />
/**
 * 样式采集：只报「值得看的」属性，以及「哪条 CSS 命中了这个元素（哪个文件哪一行）」。
 *
 * 两个关键设计（否则这块就是纯噪音）：
 *
 * 1. **与默认值对比**，不是全量 dump。浏览器默认值不用手写表 —— 现场造一个同 tag 的
 *    空元素当探针（detached 也能 getComputedStyle），逐属性比；继承类属性（color /
 *    font-*）则与**父元素**比（相同说明就是继承来的，报它没意义）。这样每个元素通常
 *    只剩几行「作者真的动过」的差异。
 *
 * 2. **行号靠 Vite dev 的 `<style data-vite-dev-id>`**：该元素 textContent 与源文件
 *    逐字对应，于是 `textContent.indexOf(rule.selectorText)` 之前有几个换行就是源文件
 *    行号。外部 `<link>` 样式表拿不到偏移（CSSOM 不给），就只给文件不给行号 —— 宁可
 *    少给也不要给假的。
 */

import type { MatchedRule } from "../shared/contract.js";
import { collapse } from "../shared/text.js";

/** 精简档：布局/排版/颜色/边框里最常出问题的那批。 */
const CORE_PROPS = [
	"display",
	"position",
	"flex-direction",
	"justify-content",
	"align-items",
	"gap",
	"margin",
	"padding",
	"font-size",
	"font-weight",
	"line-height",
	"color",
	"background-color",
	"border",
	"border-radius",
	"box-shadow",
	"overflow",
	"opacity",
	"z-index",
	"transform",
	"grid-template-columns",
];

/** 完整档：再加一层细粒度属性。 */
const EXTRA_PROPS = [
	"flex",
	"flex-wrap",
	"align-self",
	"box-sizing",
	"min-width",
	"max-width",
	"min-height",
	"max-height",
	"top",
	"right",
	"bottom",
	"left",
	"text-align",
	"text-transform",
	"letter-spacing",
	"white-space",
	"text-overflow",
	"cursor",
	"visibility",
	"background-image",
	"outline",
	"float",
	"row-gap",
	"column-gap",
];

/** 继承类属性：与父元素相同 = 继承来的，不报。 */
const INHERITED = new Set([
	"color",
	"font-size",
	"font-weight",
	"line-height",
	"text-align",
	"text-transform",
	"letter-spacing",
	"white-space",
	"cursor",
	"visibility",
]);

function probeFor(tag: string, doc: Document): Element {
	const probe = doc.createElement(tag);
	const holder = doc.createElement("div");
	holder.setAttribute("style", "all:initial;position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden");
	holder.appendChild(probe);
	(doc.body ?? doc.documentElement).appendChild(holder);
	return probe;
}

/**
 * 计算样式子集：**只返回与默认/继承值不同的项**（作者真的动过的那些）。
 * width/height 故意不在列表里 —— 契约的 rect（尺寸）已经给了，重复报两遍是纯噪音。
 * @param opts.full 是否带 EXTRA_PROPS（full 档）
 */
export function collectStyles(el: Element, opts: { full?: boolean } = {}): Record<string, string> {
	const doc = el.ownerDocument;
	const view = doc.defaultView;
	if (!view) return {};
	const props = opts.full ? [...CORE_PROPS, ...EXTRA_PROPS] : CORE_PROPS;
	const own = view.getComputedStyle(el);
	const parent = el.parentElement ? view.getComputedStyle(el.parentElement) : null;

	let probeStyle: CSSStyleDeclaration | null = null;
	let probeEl: Element | null = null;
	try {
		probeEl = probeFor(el.tagName.toLowerCase(), doc);
		probeStyle = view.getComputedStyle(probeEl);
	} catch {
		probeStyle = null;
	}

	const out: Record<string, string> = {};
	try {
		for (const prop of props) {
			const value = own.getPropertyValue(prop);
			if (!value) continue;
			if (INHERITED.has(prop)) {
				// 与父级相同 → 继承来的，不是这个元素的问题，不报
				if (parent && parent.getPropertyValue(prop) === value) continue;
			} else if (probeStyle && probeStyle.getPropertyValue(prop) === value) {
				// 与同 tag 空元素的默认值一致 → 没人动过它，不报（这是「只报差异」的全部依据）
				continue;
			}
			out[prop] = collapse(value);
		}
	} finally {
		probeEl?.parentElement?.remove();
	}
	return out;
}

interface RuleHit {
	file?: string;
	line?: number;
	selector: string;
	declarations: string;
	score: number;
}

/**
 * 命中的 CSS 规则（按「真正改了多少我们关心的属性」排序，只留前几条）。
 *
 * @param maxRules 最多返回几条（默认 5）
 */
export function collectMatchedRules(el: Element, maxRules = 5): MatchedRule[] {
	const doc = el.ownerDocument;
	const hits: RuleHit[] = [];
	let sheets: StyleSheetList | CSSStyleSheet[] = [];
	try {
		sheets = doc.styleSheets;
	} catch {
		return [];
	}
	for (const sheet of Array.from(sheets)) {
		let rules: CSSRuleList | null = null;
		try {
			rules = (sheet as CSSStyleSheet).cssRules;
		} catch {
			continue; // 跨域样式表读不到（SecurityError）→ 跳过，不影响其它表
		}
		if (!rules) continue;
		const owner = sheet.ownerNode as HTMLElement | null;
		const file = sourceFileOf(owner);
		const source = owner?.textContent ?? "";
		walkRules(rules, el, doc, file, source, hits);
	}
	hits.sort((a, b) => b.score - a.score);
	return hits
		.filter((h, i, all) => all.findIndex((x) => x.selector === h.selector && x.file === h.file) === i)
		.slice(0, maxRules)
		.map((h) => ({
			...(h.file ? { file: h.file } : {}),
			...(h.line ? { line: h.line } : {}),
			selector: h.selector,
			...(h.declarations ? { declarations: h.declarations } : {}),
		}));
}

function walkRules(
	rules: CSSRuleList,
	el: Element,
	doc: Document,
	file: string | undefined,
	source: string,
	hits: RuleHit[],
): void {
	const view = doc.defaultView;
	for (const rule of Array.from(rules)) {
		const type = rule.constructor?.name ?? "";
		if (type === "CSSMediaRule" || type === "CSSSupportsRule") {
			// 只有当前真的生效的条件块才下钻（max-width 不匹配的那半边对我们没意义）
			const cond = (rule as CSSMediaRule).conditionText ?? "";
			if (type === "CSSMediaRule" && cond && view?.matchMedia && !view.matchMedia(cond).matches) continue;
			const inner = (rule as CSSMediaRule).cssRules;
			if (inner) walkRules(inner, el, doc, file, source, hits);
			continue;
		}
		if (type !== "CSSStyleRule") continue;
		const style = rule as CSSStyleRule;
		const selector = style.selectorText ?? "";
		if (!selector) continue;
		let matched = false;
		try {
			matched = el.matches(selector);
		} catch {
			continue; // 带 ::before 之类伪元素的选择器 → matches 会抛，跳过
		}
		if (!matched) continue;
		const declarations = interestingDeclarations(style);
		if (!declarations.text) continue;
		hits.push({
			...(file ? { file } : {}),
			...(file ? lineOf(source, selector) : {}),
			selector,
			declarations: declarations.text,
			score: declarations.score,
		});
	}
}

/** 规则文本里「我们关心的」声明；全是无关属性（cursor/zoom…）的规则直接丢弃。 */
function interestingDeclarations(rule: CSSStyleRule): { text: string; score: number } {
	const known = new Set([...CORE_PROPS, ...EXTRA_PROPS]);
	const parts: string[] = [];
	let score = 0;
	for (let i = 0; i < rule.style.length; i++) {
		const name = rule.style.item(i);
		const value = rule.style.getPropertyValue(name);
		if (!value) continue;
		if (known.has(name)) score++;
		parts.push(`${name}:${collapse(value)}`);
	}
	return { text: parts.join(";"), score };
}

/** 样式表对应的源文件：Vite dev 的 data-vite-dev-id 最准，否则用 link 的 href。 */
function sourceFileOf(owner: HTMLElement | null): string | undefined {
	if (!owner) return undefined;
	const devId =
		owner.getAttribute?.("data-vite-dev-id") ?? (owner as HTMLElement & { dataset?: DOMStringMap }).dataset?.viteDevId;
	if (devId) return devId;
	const href = owner.getAttribute?.("href");
	return href || undefined;
}

/** 在 `<style>` 的 textContent 里定位规则所在行（拿不到就返回空对象）。 */
function lineOf(source: string, selector: string): { line?: number } {
	if (!source) return {};
	const at = source.indexOf(selector);
	if (at < 0) return {};
	let line = 1;
	for (let i = 0; i < at; i++) if (source.charCodeAt(i) === 10) line++;
	return { line };
}
