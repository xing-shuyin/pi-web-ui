/// <reference lib="dom" />
/**
 * 元素 → 契约快照（DOM 相关，薄封装）。
 *
 * 这一层只做「读 DOM」，不含任何定位/裁剪/渲染决策 —— 那些都在 shared/ 的纯函数里
 * （能单测）。这里唯一的规则是**按档位决定采多少**：compact 连骨架都不生成，
 * 因为生成骨架本身不便宜，而渲染时又会丢掉它。
 */

import type { DetailLevel, ElementRect, ElementSnapshot, PageContext } from "../shared/contract.js";
import { htmlSkeleton } from "../shared/html-skeleton.js";
import { buildDomPath, buildSelector, buildXPath, tagSummary } from "../shared/selector.js";
import { collectSource } from "./adapters/index.js";
import { collectMatchedRules, collectStyles } from "./styles.js";

export interface SnapshotOptions {
	detail: DetailLevel;
	/** innerText 截断上限（骨架另有自己的上限）。 */
	maxText?: number;
}

/** 相对视口的矩形 + 占视口比例（比例比裸 px 有用：AI 不知道你的屏多宽）。 */
export function elementRect(el: Element, view: Window = window): ElementRect {
	const r = el.getBoundingClientRect();
	const vw = view.innerWidth || 1;
	const vh = view.innerHeight || 1;
	return {
		x: r.left,
		y: r.top,
		w: r.width,
		h: r.height,
		vwPct: (r.width / vw) * 100,
		vhPct: (r.height / vh) * 100,
	};
}

/** 元素文本：优先 innerText（尊重可见性/换行），拿不到就回退 textContent。 */
export function elementText(el: Element, maxText = 600): string {
	const el2 = el as HTMLElement;
	const raw = typeof el2.innerText === "string" && el2.innerText !== "" ? el2.innerText : (el.textContent ?? "");
	return raw.length > maxText ? raw.slice(0, maxText) : raw;
}

/** 组装一个元素的快照（按档位决定采集深度）。 */
export function snapshotElement(el: Element, opts: SnapshotOptions): ElementSnapshot {
	const detail = opts.detail;
	const full = detail === "full";
	const snapshot: ElementSnapshot = {
		tag: el.tagName.toLowerCase(),
		id: el.getAttribute("id") ?? undefined,
		classes: [...el.classList],
		selector: buildSelector(el, { maxDepth: full ? 8 : 6, maxClasses: full ? 4 : 3 }),
		tagSummary: tagSummary(el, { maxAttrs: full ? 3 : 2 }),
		rect: elementRect(el),
	};
	if (full) {
		snapshot.xpath = buildXPath(el);
		snapshot.domPath = buildDomPath(el, { maxDepth: 5 });
	}
	if (detail !== "compact") {
		snapshot.text = elementText(el, opts.maxText ?? (full ? 600 : 400));
		snapshot.htmlSkeleton = htmlSkeleton(el, {
			maxDepth: full ? 3 : 2,
			maxText: 60,
			maxLength: full ? 800 : 400,
		});
		const rules = collectMatchedRules(el);
		if (rules.length > 0) snapshot.matchedRules = rules;
		const styles = collectStyles(el, { full });
		if (Object.keys(styles).length > 0) snapshot.styles = styles;
	}
	// 源码定位（React fiber / Vue 实例 / CSS 命中）：认不出来就留空，绝不因此失败
	const source = collectSource(el, snapshot.matchedRules);
	if (source) snapshot.source = source;
	return snapshot;
}

/** 页面上下文（URL/title/视口/深浅色/疑似框架）。 */
export function pageContext(doc: Document = document, view: Window = window): PageContext {
	const root = doc.documentElement;
	const scheme = root?.classList.contains("dark") || root?.dataset?.theme === "dark" ? "dark" : undefined;
	return {
		url: doc.location?.href ?? "",
		title: doc.title ?? "",
		viewport: {
			w: view.innerWidth || 0,
			h: view.innerHeight || 0,
			dpr: view.devicePixelRatio || 1,
		},
		framework: detectFramework(view),
		colorScheme: scheme ?? (view.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
	};
}

/** 疑似框架探测（只看全局线索，不深挖；探测不出来就是 unknown）。 */
export function detectFramework(view: Window = window): string {
	const w = view as unknown as Record<string, unknown>;
	const probe = view.document?.createElement("div");
	if (
		probe &&
		instanceKeys(probe).some((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"))
	) {
		return "react";
	}
	if (probe && instanceKeys(probe).some((k) => k.startsWith("__vue"))) return "vue";
	if (w.__VUE__ || w.__VUE_DEVTOOLS_GLOBAL_HOOK__) return "vue";
	if (w.__REACT_DEVTOOLS_GLOBAL_HOOK__) return "react";
	return "unknown";
}

/** 元素上挂着的框架实例键（React/Vue 都用随机后缀的键名，只能认前缀）。 */
export function instanceKeys(el: Element | object): string[] {
	try {
		return Object.keys(el as object);
	} catch {
		return [];
	}
}
