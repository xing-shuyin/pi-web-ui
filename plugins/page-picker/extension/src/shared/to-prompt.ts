/**
 * 契约 → Markdown（**纯函数**，是整个扩展最该被单测覆盖的一块）。
 *
 * 为什么要单独一层：采集器只管填数据、投递层只管送数据，**只有这里决定 AI 看到什么**。
 * 纯函数（无 DOM / 无 chrome API）才能把「上下文预算」这类规则用单测钉住。
 *
 * 输出纪律：
 * - 只输出**采集时真的拿到了的东西**（拿不到的行整条不出现，不留 `- 源码：undefined`）；
 * - 体积最小的排前面（选择器/源码/尺寸），体积大的（骨架、规则）能省则省；
 * - 一切路径/选择器走行内代码，长文本走截断。
 */

import type { DetailLevel, ElementSnapshot, PickPayload, PickedElement } from "./contract.js";
import { collapse, code, truncate } from "./text.js";

const LEVEL_ORDER: Record<DetailLevel, number> = { compact: 0, standard: 1, full: 2 };

/** 当前档位是否达到 min（档位只影响「渲染哪些段」，采集时没拿到的数据渲染不出来）。 */
function atLeast(level: DetailLevel, min: DetailLevel): boolean {
	return LEVEL_ORDER[level] >= LEVEL_ORDER[min];
}

const FRAMEWORK_LABEL: Record<string, string> = {
	react: "React",
	vue: "Vue",
	svelte: "Svelte",
	angular: "Angular",
	unknown: "",
};

export interface ToPromptOptions {
	/** 最多完整渲染几个元素（默认 8）—— 超出的只留一行清单，避免一条消息撑爆上下文。 */
	maxElements?: number;
	/** 单个元素的文本最多几个字符（默认 400；compact 档默认 160）。 */
	maxText?: number;
}

/** 把一次拾取渲染成 Markdown；没有可用元素时返回空串（调用方据此拒收）。 */
export function toPrompt(payload: PickPayload, opts: ToPromptOptions = {}): string {
	const elements = (payload.elements ?? []).filter((e) => e?.snapshot);
	if (elements.length === 0) return "";
	const level: DetailLevel = payload.detail ?? "standard";
	const max = Math.max(1, opts.maxElements ?? 8);
	const shown = elements.slice(0, max);

	const lines: string[] = [];
	lines.push(`### 网页元素拾取（${elements.length} 个元素）`);
	lines.push("");
	lines.push(...renderPage(payload));
	if (payload.note?.trim()) lines.push(`- 整体说明：${collapse(payload.note)}`);
	lines.push("");
	shown.forEach((el, i) => {
		lines.push(...renderElement(el, level, i + 1, opts));
	});
	if (elements.length > shown.length) {
		lines.push(`（另有 ${elements.length - shown.length} 个已拾取元素未展开）`);
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
	out.push(`- 页面：${code(page?.url ?? "")}${title ? ` — ${collapse(title)}` : ""}`);
	const vp = page?.viewport;
	if (vp) {
		const scheme = page.colorScheme === "dark" ? "，深色" : page.colorScheme === "light" ? "，浅色" : "";
		out.push(`- 视口：${round(vp.w)}×${round(vp.h)} @${vp.dpr}x${scheme}`);
	}
	const fw = page?.framework ? FRAMEWORK_LABEL[page.framework] : "";
	if (fw) out.push(`- 疑似框架：${fw}`);
	return out;
}

function renderElement(el: PickedElement, level: DetailLevel, index: number, opts: ToPromptOptions): string[] {
	const snap = el.snapshot;
	const maxText = Math.max(0, opts.maxText ?? (level === "compact" ? 160 : 400));
	const out: string[] = [];
	out.push(`#### 元素 ${index} · ${code(snap.tagSummary || `<${snap.tag}>`)}`);
	out.push("");
	out.push(`- 选择器：${code(snap.selector)}`);
	const source = renderSource(snap);
	if (source) out.push(`- 源码：${source}`);
	out.push(`- 尺寸：${renderRect(snap)}`);
	const text = snap.text ? collapse(snap.text) : "";
	if (text) out.push(`- 文本：${code(truncate(text, maxText))}`);
	if (el.shot) out.push("- 截图：见本轮附图");
	if (atLeast(level, "full")) {
		if (snap.xpath) out.push(`- XPath：${code(snap.xpath)}`);
		if (snap.domPath) out.push(`- DOM：${code(snap.domPath)}`);
	}
	if (el.note?.trim()) out.push(`- 备注：${collapse(el.note)}`);

	const rules = atLeast(level, "standard") ? renderRules(snap) : [];
	if (rules.length > 0) {
		out.push("", "命中的 CSS：", "", "```css", ...rules, "```");
	}
	const styles = atLeast(level, "standard") ? renderStyles(snap) : "";
	if (styles) out.push("", `计算样式（仅与默认/继承值不同的）：${styles}`);
	const skeleton = atLeast(level, "standard") ? snap.htmlSkeleton?.trim() : "";
	if (skeleton) out.push("", "HTML 骨架：", "", "```html", skeleton, "```");

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
	if (src.kind === "css") parts.push("（样式命中位置）");
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

/** 数字取整（pct 保留 1 位）—— 小数点后一长串对 AI 没有任何意义。 */
function round(n: number, digits = 0): number {
	if (!Number.isFinite(n)) return 0;
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}
