/// <reference lib="dom" />

import type { DetailLevel, ElementRect, ElementSnapshot, PageContext, PickSection } from "../shared/contract.js";
import { htmlSkeleton } from "../shared/html-skeleton.js";
import { buildDomPath, buildSelector, buildXPath, tagSummary } from "../shared/selector.js";
import { collectSource } from "./adapters/index.js";
import { collectMatchedRules, collectStyles } from "./styles.js";

export interface SnapshotOptions {
	detail: DetailLevel;
	sections?: PickSection[];
	maxText?: number;
}

function wants(sections: PickSection[] | undefined, section: PickSection): boolean {
	return sections === undefined || sections.includes(section);
}

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

export function elementText(el: Element, maxText = 600): string {
	const el2 = el as HTMLElement;
	const raw = typeof el2.innerText === "string" && el2.innerText !== "" ? el2.innerText : (el.textContent ?? "");
	return raw.length > maxText ? raw.slice(0, maxText) : raw;
}

export function snapshotElement(el: Element, opts: SnapshotOptions): ElementSnapshot {
	const detail = opts.detail;
	const sections = opts.sections;
	const full = detail === "full";
	const snapshot: ElementSnapshot = {
		tag: el.tagName.toLowerCase(),
		id: el.getAttribute("id") ?? undefined,
		classes: [...el.classList],
		selector: buildSelector(el, { maxDepth: full ? 8 : 6, maxClasses: full ? 4 : 3 }),
		tagSummary: tagSummary(el, { maxAttrs: full ? 3 : 2 }),
		rect: elementRect(el),
	};
	if (wants(sections, "locator")) {
		snapshot.xpath = buildXPath(el);
		snapshot.domPath = buildDomPath(el, { maxDepth: 5 });
	}
	if (wants(sections, "text")) {
		snapshot.text = elementText(el, opts.maxText ?? (full ? 600 : 400));
	}
	if (wants(sections, "skeleton")) {
		snapshot.htmlSkeleton = htmlSkeleton(el, {
			maxDepth: full ? 3 : 2,
			maxText: 60,
			maxLength: full ? 800 : 400,
		});
	}
	if (wants(sections, "rules") || wants(sections, "source")) {
		const rules = collectMatchedRules(el);
		if (rules.length > 0) snapshot.matchedRules = rules;
	}
	if (wants(sections, "styles")) {
		const styles = collectStyles(el, { full });
		if (Object.keys(styles).length > 0) snapshot.styles = styles;
	}
	if (wants(sections, "source")) {
		const source = collectSource(el, snapshot.matchedRules);
		if (source) snapshot.source = source;
	}
	return snapshot;
}

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

export function instanceKeys(el: Element | object): string[] {
	try {
		return Object.keys(el as object);
	} catch {
		return [];
	}
}
