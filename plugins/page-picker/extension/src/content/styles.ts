/// <reference lib="dom" />

import type { MatchedRule } from "../shared/contract.js";
import { collapse } from "../shared/text.js";

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
				if (parent && parent.getPropertyValue(prop) === value) continue;
			} else if (probeStyle && probeStyle.getPropertyValue(prop) === value) {
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
			continue;
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
			continue;
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

function sourceFileOf(owner: HTMLElement | null): string | undefined {
	if (!owner) return undefined;
	const devId =
		owner.getAttribute?.("data-vite-dev-id") ?? (owner as HTMLElement & { dataset?: DOMStringMap }).dataset?.viteDevId;
	if (devId) return devId;
	const href = owner.getAttribute?.("href");
	return href || undefined;
}

function lineOf(source: string, selector: string): { line?: number } {
	if (!source) return {};
	const at = source.indexOf(selector);
	if (at < 0) return {};
	let line = 1;
	for (let i = 0; i < at; i++) if (source.charCodeAt(i) === 10) line++;
	return { line };
}
