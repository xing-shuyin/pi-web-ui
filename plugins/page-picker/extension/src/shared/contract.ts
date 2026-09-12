/// <reference lib="dom" />
/**
 * 网页元素拾取的数据契约（扩展各模块之间、以及扩展 → pi-webUi 之间的唯一定义）。
 *
 * 设计纪律：
 * - 这份对象是**唯一事实源**：采集器只负责填它，渲染器（to-prompt.ts）只负责读它，
 *   投递层（background）只负责把它送出去。任何一环都不要自己拼 Markdown。
 * - 所有字段除了几个必需项外都是可选的：适配器认不出来就留空，绝不因为拿不到
 *   组件行号或样式就整个拾取失败（降级是常态，见 docs）。
 * - 体积是硬约束：这个对象最终会变成对话上下文，所以「详细度档位」在采集层
 *   就生效（compact / standard / full），而不是渲染时再删。
 */

/** 详细度档位：控制采集多少东西（默认 standard）。 */
export type DetailLevel = "compact" | "standard" | "full";

export const DETAIL_LEVELS: DetailLevel[] = ["compact", "standard", "full"];

export function isDetailLevel(v: unknown): v is DetailLevel {
	return typeof v === "string" && (DETAIL_LEVELS as string[]).includes(v);
}

/** 源码定位：理想情况下告诉 AI「改哪个文件的哪一行」。 */
export interface SourceRef {
	/** 线索来源（说明可信度：react/vue 的行号比 css 的规则命中更硬）。 */
	kind: "react" | "vue" | "css" | "unknown";
	/** 源文件路径（dev server 的路径，如 /src/components/Card.tsx）。 */
	file?: string;
	line?: number;
	column?: number;
	/** 组件名（react/vue）。 */
	component?: string;
	/** 组件调用链，从被选组件往上（react）：["Card", "SettingsPage"]。 */
	chain?: string[];
}

/** 命中的 CSS 规则（哪条规则命中了这个元素、来自哪个文件的哪一行）。 */
export interface MatchedRule {
	file?: string;
	/** 源文件行号（Vite dev 下可从 <style data-vite-dev-id> 反推，见 capture/styles.ts）。 */
	line?: number;
	selector: string;
	/** 该规则里**真正生效且值得看**的声明，如 "display:flex;gap:8px"。 */
	declarations?: string;
}

export interface ElementRect {
	/** 相对视口的 CSS 像素。 */
	x: number;
	y: number;
	w: number;
	h: number;
	/** 占视口宽/高的百分比 —— 百分比比裸 px 有用（AI 不知道你的屏多宽）。 */
	vwPct: number;
	vhPct: number;
}

export interface ElementSnapshot {
	tag: string;
	id?: string;
	classes: string[];
	/** 首选定位串（短且唯一）。 */
	selector: string;
	/** 完整 XPath（selector 失效或需要精确定位时用）。 */
	xpath?: string;
	/** 人类可读的 DOM 路径（body > div#root > main > section.card）。 */
	domPath?: string;
	/** 开标签的摘要，如 <section class="card card--active">。 */
	tagSummary?: string;
	/** innerText（已按档位截断）。 */
	text?: string;
	/** 结构骨架（子节点折叠成 …）。 */
	htmlSkeleton?: string;
	rect: ElementRect;
	/** 计算样式子集（只放与默认值/继承值不同的，见 capture/styles.ts）。 */
	styles?: Record<string, string>;
	matchedRules?: MatchedRule[];
	source?: SourceRef;
}

export interface PickedElement {
	snapshot: ElementSnapshot;
	/** 用户为这个元素写的一句话（价值极高，原样带给 AI）。 */
	note?: string;
	/**
	 * 元素截图，`data:image/png;base64,…`。
	 * **不进 Markdown 正文**（base64 混在文本里毫无用处还撑爆上下文），
	 * 投递时转成对话附件（走 attachments.imageData 这条已有通路）。
	 */
	shot?: string;
}

export interface PageContext {
	url: string;
	title: string;
	viewport: { w: number; h: number; dpr: number };
	/** 疑似框架（"react" / "vue" / "unknown"），让 AI 知道该按哪套约定找代码。 */
	framework?: string;
	colorScheme?: "light" | "dark";
}

/** 一次拾取的完整载荷（可能含多个元素）。 */
export interface PickPayload {
	/** 幂等 id（每次拾取一个）—— 投递失败重试时不重复注入。 */
	id: string;
	pickedAt: string;
	page: PageContext;
	elements: PickedElement[];
	/** 用户在浮条上写的整体说明（对所有元素生效）。 */
	note?: string;
	detail: DetailLevel;
}

/** 生成拾取 id（时间戳 + 随机后缀，够用且可读）。 */
export function makePickId(now: number = Date.now(), rand: () => number = Math.random): string {
	return `pick-${now.toString(36)}-${Math.floor(rand() * 1e6)
		.toString(36)
		.padStart(4, "0")}`;
}
