import type { DetailLevel, ElementSnapshot, PickPayload, PickSection, PickedElement } from "./contract.js";
import { sectionsForDepth } from "./contract.js";
import { collapse, code, truncate } from "./text.js";
import { getMessage } from "./i18n.js";

function sectionsOf(payload: PickPayload): Set<PickSection> {
	const list = payload.sections ?? sectionsForDepth(payload.detail ?? "standard");
	return new Set(list);
}

const FRAMEWORK_LABEL: Record<string, string> = {
	react: "React",
	vue: "Vue",
	svelte: "Svelte",
	angular: "Angular",
	unknown: "",
};

export interface ToPromptOptions {
	maxElements?: number;
	maxText?: number;
}

export function toPrompt(payload: PickPayload, opts: ToPromptOptions = {}): string {
	const elements = (payload.elements ?? []).filter((e) => e?.snapshot);
	if (elements.length === 0) return "";
	const level: DetailLevel = payload.detail ?? "standard";
	const sections = sectionsOf(payload);
	const max = Math.max(1, opts.maxElements ?? 8);
	const shown = elements.slice(0, max);

	const lines: string[] = [];
	lines.push(
		`### ${getMessage("pickresult_title", [String(elements.length)], `网页元素拾取（${elements.length} 个元素）`)}`,
	);
	lines.push("");
	if (sections.has("page")) lines.push(...renderPage(payload));
	if (payload.note?.trim())
		lines.push(`- ${getMessage("pickresult_note", undefined, "整体说明：")}${collapse(payload.note)}`);
	lines.push("");
	shown.forEach((el, i) => {
		lines.push(...renderElement(el, level, i + 1, sections, opts));
	});
	if (elements.length > shown.length) {
		lines.push(
			getMessage(
				"pickresult_more",
				[String(elements.length - shown.length)],
				`（另有 ${elements.length - shown.length} 个已拾取元素未展开）`,
			),
		);
	}
	return lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd();
}

function renderPage(payload: PickPayload): string[] {
	const page = payload.page;
	const out: string[] = [];
	const title = page?.title?.trim();
	out.push(
		`- ${getMessage("pickresult_page", undefined, "页面：")}${code(page?.url ?? "")}${title ? ` — ${collapse(title)}` : ""}`,
	);
	const vp = page?.viewport;
	if (vp) {
		const scheme =
			page.colorScheme === "dark"
				? getMessage("pickresult_dark", undefined, "，深色")
				: page.colorScheme === "light"
					? getMessage("pickresult_light", undefined, "，浅色")
					: "";
		out.push(
			`- ${getMessage("pickresult_viewport", undefined, "视口：")}${round(vp.w)}×${round(vp.h)} @${vp.dpr}x${scheme}`,
		);
	}
	const fw = page?.framework ? FRAMEWORK_LABEL[page.framework] : "";
	if (fw) out.push(`- ${getMessage("pickresult_framework", undefined, "疑似框架：")}${fw}`);
	return out;
}

function renderElement(
	el: PickedElement,
	level: DetailLevel,
	index: number,
	sections: Set<PickSection>,
	opts: ToPromptOptions,
): string[] {
	const snap = el.snapshot;
	const maxText = Math.max(0, opts.maxText ?? (level === "compact" ? 160 : 400));
	const out: string[] = [];
	out.push(
		`#### ${getMessage("pickresult_element", [String(index)], `元素 ${index} ·`)} ${code(snap.tagSummary || `<${snap.tag}>`)}`,
	);
	out.push("");
	if (sections.has("selector")) {
		out.push(`- ${getMessage("pickresult_selector", undefined, "选择器：")}${code(snap.selector)}`);
		const source = sections.has("source") ? renderSource(snap) : "";
		if (source) out.push(`- ${getMessage("pickresult_source", undefined, "源码：")}${source}`);
		out.push(`- ${getMessage("pickresult_size", undefined, "尺寸：")}${renderRect(snap)}`);
	} else if (sections.has("source")) {
		const source = renderSource(snap);
		if (source) out.push(`- ${getMessage("pickresult_source", undefined, "源码：")}${source}`);
	}
	const text = sections.has("text") && snap.text ? collapse(snap.text) : "";
	if (text) out.push(`- ${getMessage("pickresult_text", undefined, "文本：")}${code(truncate(text, maxText))}`);
	if (el.shot) out.push(`- ${getMessage("pickresult_shot", undefined, "截图：见本轮附图")}`);
	if (sections.has("locator")) {
		if (snap.xpath) out.push(`- ${getMessage("pickresult_xpath", undefined, "XPath：")}${code(snap.xpath)}`);
		if (snap.domPath) out.push(`- ${getMessage("pickresult_dom", undefined, "DOM：")}${code(snap.domPath)}`);
	}
	if (el.note?.trim()) out.push(`- ${getMessage("pickresult_note_item", undefined, "备注：")}${collapse(el.note)}`);

	const rules = sections.has("rules") ? renderRules(snap) : [];
	if (rules.length > 0) {
		out.push("", getMessage("prompt_matchedCss", undefined, "命中的 CSS："), "", "```css", ...rules, "```");
	}
	const styles = sections.has("styles") ? renderStyles(snap) : "";
	if (styles)
		out.push("", `${getMessage("pickresult_styles", undefined, "计算样式（仅与默认/继承值不同的）：")}${styles}`);
	const skeleton = sections.has("skeleton") ? snap.htmlSkeleton?.trim() : "";
	if (skeleton)
		out.push("", getMessage("pickresult_skeleton", undefined, "HTML 骨架："), "", "```html", skeleton, "```");

	out.push("");
	return out;
}

function renderSource(snap: ElementSnapshot): string {
	const src = snap.source;
	if (!src) return "";
	const parts: string[] = [];
	const file = src.file?.trim();
	if (file) {
		const at = src.line ? `:${src.line}${src.column ? `:${src.column}` : ""}` : "";
		parts.push(code(`${file}${at}`));
	}
	const who: string[] = [];
	if (src.component) who.push(code(src.component));
	for (const up of src.chain ?? []) {
		if (up && up !== src.component) who.push(code(up));
	}
	if (who.length > 0) parts.push(`（${who.join(" ← ")}）`);
	if (src.kind === "css") parts.push(getMessage("pickresult_cssHit", undefined, "（样式命中位置）"));
	if (parts.length === 0) return "";
	return parts.join(" ");
}

function renderRect(snap: ElementSnapshot): string {
	const r = snap.rect;
	const px = `${round(r.w)}×${round(r.h)} px`;
	const pct = r.vwPct || r.vhPct ? `（视口 ${round(r.vwPct, 1)}% × ${round(r.vhPct, 1)}%）` : "";
	return `${px}${pct}`;
}

function renderRules(snap: ElementSnapshot): string[] {
	const rules = snap.matchedRules ?? [];
	const out: string[] = [];
	for (const rule of rules) {
		if (!rule?.selector) continue;
		const where = rule.file ? `/* ${rule.file}${rule.line ? `:${rule.line}` : ""} */` : "";
		if (where) out.push(where);
		const decls = rule.declarations ? ` { ${rule.declarations} }` : " { … }";
		out.push(`${collapse(rule.selector)}${decls}`);
	}
	return out;
}

function renderStyles(snap: ElementSnapshot): string {
	const styles = snap.styles;
	if (!styles) return "";
	const entries = Object.entries(styles).filter(([, v]) => v !== "" && v != null);
	if (entries.length === 0) return "";
	return code(entries.map(([k, v]) => `${k}: ${v}`).join("; "));
}

function round(n: number, digits = 0): number {
	if (!Number.isFinite(n)) return 0;
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}
