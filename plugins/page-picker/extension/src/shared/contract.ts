/// <reference lib="dom" />
import { getMessage } from "./i18n.js";

export type DetailLevel = "compact" | "standard" | "full";

export const DETAIL_LEVELS: DetailLevel[] = ["compact", "standard", "full"];

export function isDetailLevel(v: unknown): v is DetailLevel {
	return typeof v === "string" && (DETAIL_LEVELS as readonly string[]).includes(v);
}

export const PICK_SECTIONS = ["page", "selector", "locator", "source", "text", "rules", "styles", "skeleton"] as const;

export type PickSection = (typeof PICK_SECTIONS)[number];

export function isPickSection(v: unknown): v is PickSection {
	return typeof v === "string" && (PICK_SECTIONS as readonly string[]).includes(v);
}

export const SECTION_INFO: Record<PickSection, { label: string; hint: string }> = {
	page: {
		get label() {
			return getMessage("section_page_label", undefined, "页面上下文");
		},
		get hint() {
			return getMessage("section_page_hint", undefined, "URL / 标题 / 视口 / 疑似框架");
		},
	},
	selector: {
		get label() {
			return getMessage("section_selector_label", undefined, "定位信息");
		},
		get hint() {
			return getMessage("section_selector_hint", undefined, "选择器 + 标签名 + 尺寸（改代码时几乎总要）");
		},
	},
	locator: {
		get label() {
			return getMessage("section_locator_label", undefined, "XPath 与 DOM 路径");
		},
		get hint() {
			return getMessage("section_locator_hint", undefined, "选择器不唯一/失效时的兜底定位");
		},
	},
	source: {
		get label() {
			return getMessage("section_source_label", undefined, "源码位置");
		},
		get hint() {
			return getMessage("section_source_hint", undefined, "React/Vue 文件:行号 + 组件调用链 —— 「一次改对」的关键");
		},
	},
	text: {
		get label() {
			return getMessage("section_text_label", undefined, "文本内容");
		},
		get hint() {
			return getMessage("section_text_hint", undefined, "元素里的文字（过长会截断）");
		},
	},
	rules: {
		get label() {
			return getMessage("section_rules_label", undefined, "命中的 CSS 规则");
		},
		get hint() {
			return getMessage("section_rules_hint", undefined, "哪条规则命中了它、来自哪个文件的哪一行");
		},
	},
	styles: {
		get label() {
			return getMessage("section_styles_label", undefined, "计算样式");
		},
		get hint() {
			return getMessage("section_styles_hint", undefined, "只报与默认值/继承值不同的项（通常 3~5 行）");
		},
	},
	skeleton: {
		get label() {
			return getMessage("section_skeleton_label", undefined, "HTML 骨架");
		},
		get hint() {
			return getMessage("section_skeleton_hint", undefined, "结构（子节点折叠成 …），比整段 outerHTML 省得多");
		},
	},
};

export interface SectionPreset {
	id: string;
	label: string;
	short: string;
	hint: string;
	depth: DetailLevel;
	sections: PickSection[];
}

export const SECTION_PRESETS: SectionPreset[] = [
	{
		id: "lean",
		get label() {
			return getMessage("preset_lean_label", undefined, "精简（最省上下文）");
		},
		get short() {
			return getMessage("preset_lean_short", undefined, "精简");
		},
		get hint() {
			return getMessage("preset_lean_hint", undefined, "只留定位 + 源码位置 + 短文本：大约三五行/元素");
		},
		depth: "compact",
		sections: ["page", "selector", "source", "text"],
	},
	{
		id: "standard",
		get label() {
			return getMessage("preset_standard_label", undefined, "标准（推荐）");
		},
		get short() {
			return getMessage("preset_standard_short", undefined, "标准");
		},
		get hint() {
			return getMessage("preset_standard_hint", undefined, "再加命中的 CSS、计算样式差异与 HTML 骨架");
		},
		depth: "standard",
		sections: ["page", "selector", "source", "text", "rules", "styles", "skeleton"],
	},
	{
		id: "full",
		get label() {
			return getMessage("preset_full_label", undefined, "完整");
		},
		get short() {
			return getMessage("preset_full_short", undefined, "完整");
		},
		get hint() {
			return getMessage("preset_full_hint", undefined, "全要，并采得更深（选择器/骨架更深、文本更长）");
		},
		depth: "full",
		sections: [...PICK_SECTIONS],
	},
	{
		id: "source",
		get label() {
			return getMessage("preset_source_label", undefined, "只要能改对地方");
		},
		get short() {
			return getMessage("preset_source_short", undefined, "改对地方");
		},
		get hint() {
			return getMessage("preset_source_hint", undefined, "选择器 + 源码位置（React/Vue 文件:行号），不报样式");
		},
		depth: "standard",
		sections: ["selector", "source"],
	},
	{
		id: "styles",
		get label() {
			return getMessage("preset_styles_label", undefined, "只排查样式");
		},
		get short() {
			return getMessage("preset_styles_short", undefined, "样式");
		},
		get hint() {
			return getMessage("preset_styles_hint", undefined, "选择器 + 命中的 CSS + 计算样式差异（间距/颜色/布局问题）");
		},
		depth: "standard",
		sections: ["selector", "rules", "styles"],
	},
	{
		id: "text",
		get label() {
			return getMessage("preset_text_label", undefined, "只看文案/结构");
		},
		get short() {
			return getMessage("preset_text_short", undefined, "文案");
		},
		get hint() {
			return getMessage("preset_text_hint", undefined, "选择器 + 文本 + HTML 骨架，不报源码与样式");
		},
		depth: "compact",
		sections: ["selector", "text", "skeleton"],
	},
];

export function sectionsForDepth(depth: DetailLevel): PickSection[] {
	const id = depth === "compact" ? "lean" : depth === "full" ? "full" : "standard";
	const preset = SECTION_PRESETS.find((p) => p.id === id);
	return preset ? [...preset.sections] : [...SECTION_PRESETS[1].sections];
}

export function normalizeSections(raw: unknown): PickSection[] {
	const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
	const out: PickSection[] = [];
	for (const item of list) {
		const v = typeof item === "string" ? item.trim() : item;
		if (isPickSection(v) && !out.includes(v)) out.push(v);
	}
	return out.length > 0 ? out : sectionsForDepth("standard");
}

export function presetForSections(sections: PickSection[]): SectionPreset | undefined {
	const key = [...sections].sort().join(",");
	return SECTION_PRESETS.find((p) => [...p.sections].sort().join(",") === key);
}

export const DETAIL_LABELS: Record<DetailLevel, string> = {
	get compact() {
		return getMessage("detail_compact", undefined, "精简");
	},
	get standard() {
		return getMessage("detail_standard", undefined, "标准");
	},
	get full() {
		return getMessage("detail_full", undefined, "完整");
	},
};

export function presetShortLabel(sections: PickSection[]): string {
	return presetForSections(sections)?.short ?? getMessage("preset_custom", undefined, "自定义");
}

export function applySectionToggle(sections: PickSection[], key: PickSection, on: boolean): PickSection[] {
	const set = new Set(sections);
	if (on) set.add(key);
	else set.delete(key);
	return PICK_SECTIONS.filter((k) => set.has(k));
}

export function presetHotkeyIndex(e: {
	key?: string;
	code?: string;
	altKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
}): number {
	if (!e.altKey || e.ctrlKey || e.metaKey) return 0;
	const byCode = /^Digit([1-9])$/.exec(e.code ?? "");
	const digit = byCode ? Number(byCode[1]) : /^[1-9]$/.test(e.key ?? "") ? Number(e.key) : 0;
	return digit >= 1 && digit <= SECTION_PRESETS.length ? digit : 0;
}

export function describeSections(sections: PickSection[]): string {
	const names = sections.map((k) => SECTION_INFO[k].label).join(" / ");
	const matched = presetForSections(sections);
	const namesPart =
		names.length > 0 ? names : getMessage("describeSections_empty", undefined, "（都没勾 —— 将回落标准组合）");
	const presetPart = matched
		? getMessage("describeSections_presetPart", [matched.label], `，预设：${matched.label}`)
		: getMessage("describeSections_custom", undefined, "，自定义");
	return getMessage(
		"describeSections_template",
		[namesPart, String(sections.length), presetPart],
		`当前发送：${namesPart}（共 ${sections.length} 项${presetPart}）`,
	);
}

export interface SourceRef {
	kind: "react" | "vue" | "css" | "unknown";
	file?: string;
	line?: number;
	column?: number;
	component?: string;
	chain?: string[];
}

export interface MatchedRule {
	file?: string;
	line?: number;
	selector: string;
	declarations?: string;
}

export interface ElementRect {
	x: number;
	y: number;
	w: number;
	h: number;
	vwPct: number;
	vhPct: number;
}

export interface ElementSnapshot {
	tag: string;
	id?: string;
	classes: string[];
	selector: string;
	xpath?: string;
	domPath?: string;
	tagSummary?: string;
	text?: string;
	htmlSkeleton?: string;
	rect: ElementRect;
	styles?: Record<string, string>;
	matchedRules?: MatchedRule[];
	source?: SourceRef;
}

export interface PickedElement {
	snapshot: ElementSnapshot;
	note?: string;
	shot?: string;
}

export interface PageContext {
	url: string;
	title: string;
	viewport: { w: number; h: number; dpr: number };
	framework?: string;
	colorScheme?: "light" | "dark";
}

export interface PickPayload {
	id: string;
	pickedAt: string;
	page: PageContext;
	elements: PickedElement[];
	note?: string;
	detail: DetailLevel;
	sections?: PickSection[];
}

export function makePickId(now: number = Date.now(), rand: () => number = Math.random): string {
	return `pick-${now.toString(36)}-${Math.floor(rand() * 1e6)
		.toString(36)
		.padStart(4, "0")}`;
}
