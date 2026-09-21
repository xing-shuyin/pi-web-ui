/**
 * 整条消息卡片 → PNG → 系统剪贴板（issue #228「复制为图片」）。
 *
 * html-to-image 把 DOM 塞进 SVG foreignObject 再画到 canvas 上。两个坑叠在一起
 * 就会变成用户看到的「浅色主题黑底黑字 / 深紫气泡」：
 *   1. `backgroundColor` 选项若是 `color-mix(...)` / CSS 变量，canvas `fillStyle`
 *      解析失败，整张画布先被涂成黑；
 *   2. 气泡用的 `--accent-soft: rgba(..., 0.14)`、`--card-bg: color-mix(..., transparent)`
 *      仍带 alpha，画到黑画布上就变成深紫/泥灰，浅色主题的深字叠上去完全看不清。
 *
 * 导出前把计算色拍扁成不透明 rgb，画布底用主题实底，再交给 html-to-image。
 */
export interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

const LIGHT_FALLBACK = "#ffffff";
const DARK_FALLBACK = "#1e1e1e";

/** 工具条 / 块级复制键 / 流式光标 / 编辑器 / 导出勾选框是操作层，不进长图。 */
export const EXPORT_CHROME_SELECTOR =
	".msg-actions, .msg-text-copy, .chead-copy, .stream-cursor, .msg-editor, .msg-collapse-btn, .msg-export-check, .toolcall-kill, .toolcall-open";

/** 浏览器 canvas 边长上限（Chrome/Edge 约 16384；超出 toBlob 会黑图或抛错）。 */
export const EXPORT_CANVAS_MAX_PX = 16384;

/** 2x 优先；超限降到 1x；1x 仍超返回 0（调用方应拒复制）。 */
export function pickExportPixelRatio(cssHeight: number, cssWidth = 800, desired = 2): number {
	const maxDim = Math.max(cssHeight, cssWidth, 1);
	if (maxDim * desired <= EXPORT_CANVAS_MAX_PX) return desired;
	if (maxDim <= EXPORT_CANVAS_MAX_PX) return 1;
	return 0;
}

export function parseCssColor(input: string): Rgba | null {
	const s = input.trim().toLowerCase();
	if (!s) return null;
	if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
	if (s.startsWith("#")) {
		const h = s.slice(1);
		if (h.length === 3 || h.length === 4) {
			const r = Number.parseInt(h[0] + h[0], 16);
			const g = Number.parseInt(h[1] + h[1], 16);
			const b = Number.parseInt(h[2] + h[2], 16);
			const a = h.length === 4 ? Number.parseInt(h[3] + h[3], 16) / 255 : 1;
			if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
			return { r, g, b, a };
		}
		if (h.length === 6 || h.length === 8) {
			const r = Number.parseInt(h.slice(0, 2), 16);
			const g = Number.parseInt(h.slice(2, 4), 16);
			const b = Number.parseInt(h.slice(4, 6), 16);
			const a = h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1;
			if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
			return { r, g, b, a };
		}
		return null;
	}
	const fn = s.match(/^rgba?\(\s*([\s\S]+)\)$/);
	if (!fn) return null;
	const body = fn[1].trim();
	let channels: string[];
	let alpha = 1;
	if (body.includes("/")) {
		const [rgbPart, aPart] = body.split("/");
		channels = rgbPart
			.trim()
			.split(/[\s,]+/)
			.filter(Boolean);
		alpha = parseAlpha(aPart.trim());
	} else if (body.includes(",")) {
		const parts = body.split(",").map((p) => p.trim());
		if (parts.length === 4) alpha = parseAlpha(parts.pop()!);
		channels = parts;
	} else {
		channels = body.split(/\s+/).filter(Boolean);
		if (channels.length === 4) alpha = parseAlpha(channels.pop()!);
	}
	if (channels.length !== 3) return null;
	const r = parseRgbChannel(channels[0]);
	const g = parseRgbChannel(channels[1]);
	const b = parseRgbChannel(channels[2]);
	if ([r, g, b, alpha].some((n) => Number.isNaN(n))) return null;
	return { r, g, b, a: alpha };
}

function parseRgbChannel(tok: string): number {
	if (tok.endsWith("%")) return Math.round(clamp(Number.parseFloat(tok), 0, 100) * 2.55);
	return Math.round(clamp(Number.parseFloat(tok), 0, 255));
}

function parseAlpha(tok: string): number {
	if (tok.endsWith("%")) return clamp(Number.parseFloat(tok) / 100, 0, 1);
	return clamp(Number.parseFloat(tok), 0, 1);
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

export function formatRgb(c: Rgba): string {
	const r = clamp(Math.round(c.r), 0, 255);
	const g = clamp(Math.round(c.g), 0, 255);
	const b = clamp(Math.round(c.b), 0, 255);
	if (c.a < 0.996) {
		const a = Math.round(clamp(c.a, 0, 1) * 1000) / 1000;
		return `rgba(${r}, ${g}, ${b}, ${a})`;
	}
	return `rgb(${r}, ${g}, ${b})`;
}

/** Porter-Duff src-over；bg 视为已经不透明。 */
export function flattenOnto(fg: Rgba, bg: Rgba): Rgba {
	const a = clamp(fg.a, 0, 1);
	if (a <= 0) return { r: bg.r, g: bg.g, b: bg.b, a: bg.a };
	if (a >= 1) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
	return {
		r: fg.r * a + bg.r * (1 - a),
		g: fg.g * a + bg.g * (1 - a),
		b: fg.b * a + bg.b * (1 - a),
		a: 1,
	};
}

/** 解析失败或全透明 → 回落 backdrop（已拍扁）。永不返回 color-mix / 变量字符串。 */
export function opaqueCss(color: string, backdrop: string): string {
	const bg = parseCssColor(backdrop) ?? { r: 255, g: 255, b: 255, a: 1 };
	const fg = parseCssColor(color);
	if (!fg || fg.a <= 0.004) return formatRgb({ ...bg, a: 1 });
	return formatRgb(flattenOnto(fg, { ...bg, a: 1 }));
}

export function relativeLuminance(c: Rgba): number {
	const lin = (v: number) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

export function isLightColor(c: Rgba): boolean {
	return relativeLuminance(c) > 0.45;
}

function readComputedBackground(cssBackground: string): string {
	const probe = document.createElement("div");
	probe.style.cssText = `position:fixed;left:-99999px;top:0;width:8px;height:8px;pointer-events:none;background:${cssBackground}`;
	document.body.appendChild(probe);
	const bg = getComputedStyle(probe).backgroundColor;
	probe.remove();
	return bg;
}

function schemeFallback(): string {
	const scheme = getComputedStyle(document.documentElement).colorScheme;
	return scheme.split(/\s+/).includes("light") ? LIGHT_FALLBACK : DARK_FALLBACK;
}

/**
 * 导出画布的不透明底：主题 --card-bg / --msgs-bg 拍到 --bg 上。
 * 浅色半透明卡片不再落到默认黑底。
 */
export function resolveExportBackdrop(el?: HTMLElement | null): string {
	const fallback = schemeFallback();
	let pageBg = fallback;
	try {
		pageBg = opaqueCss(readComputedBackground("var(--bg)"), fallback);
	} catch {
		pageBg = fallback;
	}

	try {
		const cardRaw = readComputedBackground("var(--card-bg, var(--msgs-bg, var(--bg)))");
		const card = opaqueCss(cardRaw, pageBg);
		const parsed = parseCssColor(card);
		if (parsed && relativeLuminance(parsed) + parsed.a > 0) return card;
	} catch {
		/* probe 失败就往下走 DOM */
	}

	let cur: HTMLElement | null = el ?? null;
	while (cur) {
		const bg = getComputedStyle(cur).backgroundColor;
		if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") {
			const flat = opaqueCss(bg, pageBg);
			const parsed = parseCssColor(bg);
			if (parsed && parsed.a > 0.04) return flat;
		}
		cur = cur.parentElement;
	}
	return pageBg;
}

function styled(el: Element): CSSStyleDeclaration | null {
	return el instanceof HTMLElement || el instanceof SVGElement ? el.style : null;
}

function flattenColorValue(value: string, backdrop: string): string | null {
	const parsed = parseCssColor(value);
	if (!parsed) return null;
	if (parsed.a <= 0.004) return "transparent";
	if (parsed.a >= 0.996) return formatRgb({ ...parsed, a: 1 });
	const bg = parseCssColor(backdrop) ?? { r: 255, g: 255, b: 255, a: 1 };
	return formatRgb(flattenOnto(parsed, { ...bg, a: 1 }));
}

/**
 * 把 src 树上的计算色写到 dst（结构相同的 clone）上：半透明背景/文字/描边拍到
 * 最近的不透明祖先上，并关掉 backdrop-filter / mix-blend-mode（SVG 里会变成黑罩）。
 */
export function flattenPaintTree(src: Element, dst: Element, backdrop: string): void {
	const cs = getComputedStyle(src);
	const st = styled(dst);
	let nextBackdrop = backdrop;
	if (st) {
		const bgFlat = flattenColorValue(cs.backgroundColor, backdrop);
		if (bgFlat === "transparent") {
			st.backgroundColor = "transparent";
		} else if (bgFlat) {
			st.backgroundColor = bgFlat;
			nextBackdrop = bgFlat;
		}

		const colorFlat = flattenColorValue(cs.color, nextBackdrop);
		if (colorFlat && colorFlat !== "transparent") st.color = colorFlat;

		const borderKeys = [
			["borderTopColor", "border-top-color"],
			["borderRightColor", "border-right-color"],
			["borderBottomColor", "border-bottom-color"],
			["borderLeftColor", "border-left-color"],
			["outlineColor", "outline-color"],
			["textDecorationColor", "text-decoration-color"],
		] as const;
		for (const [prop] of borderKeys) {
			const flat = flattenColorValue(cs[prop as keyof CSSStyleDeclaration] as string, nextBackdrop);
			if (flat && flat !== "transparent") st[prop] = flat;
		}

		const fillFlat = flattenColorValue(cs.fill, nextBackdrop);
		if (fillFlat && fillFlat !== "transparent" && cs.fill !== "none") st.fill = fillFlat;
		const strokeFlat = flattenColorValue(cs.stroke, nextBackdrop);
		if (strokeFlat && strokeFlat !== "transparent" && cs.stroke !== "none") st.stroke = strokeFlat;

		st.backdropFilter = "none";
		st.setProperty("-webkit-backdrop-filter", "none");
		if (cs.mixBlendMode && cs.mixBlendMode !== "normal") st.mixBlendMode = "normal";
		st.caretColor = "transparent";
	}

	const sKids = Array.from(src.children);
	const dKids = Array.from(dst.children);
	const n = Math.min(sKids.length, dKids.length);
	for (let i = 0; i < n; i++) flattenPaintTree(sKids[i], dKids[i], nextBackdrop);
}

export function stripExportChrome(root: HTMLElement): void {
	root.querySelectorAll(EXPORT_CHROME_SELECTOR).forEach((n) => n.remove());
}

export interface ExportContentFilter {
	includeThinking?: boolean;
	includeTools?: boolean;
}

/** 默认去掉思考块 / 工具卡；打开对应开关才保留。flatten 之后再剥，避免和源 DOM 对不齐。 */
export function applyExportContentFilter(root: HTMLElement, opts: ExportContentFilter = {}): void {
	if (!opts.includeThinking) root.querySelectorAll(".thinking").forEach((n) => n.remove());
	if (!opts.includeTools) root.querySelectorAll(".toolcall").forEach((n) => n.remove());
}

export function snapshotMessageForExport(
	sourceEl: HTMLElement,
	backdrop: string,
	opts: ExportContentFilter = {},
): HTMLElement {
	const clone = sourceEl.cloneNode(true) as HTMLElement;
	flattenPaintTree(sourceEl, clone, backdrop);
	applyExportContentFilter(clone, opts);
	stripExportChrome(clone);
	clone.classList.remove("msg-export-selected");
	clone.style.margin = "0";
	clone.style.paddingLeft = "";
	clone.removeAttribute("id");
	clone.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
	return clone;
}

export async function rasterizeElementToPngBlob(
	el: HTMLElement,
	options: { pixelRatio?: number; backgroundColor?: string } = {},
): Promise<Blob> {
	const { toBlob } = await import("html-to-image");
	const backgroundColor = options.backgroundColor ?? resolveExportBackdrop(el);
	const parsed = parseCssColor(backgroundColor);
	const blob = await toBlob(el, {
		pixelRatio: options.pixelRatio ?? 2,
		backgroundColor,
		cacheBust: false,
		style: {
			colorScheme: parsed && !isLightColor(parsed) ? "dark" : "light",
		},
	});
	if (!blob) throw new Error("toBlob returned null");
	return blob;
}

/** 无弹窗的一键导出（仍走拍扁实底），给不想开预览的调用方。 */
export async function copyMessageCardAsImage(el: HTMLElement): Promise<void> {
	const backdrop = resolveExportBackdrop(el);
	const clone = snapshotMessageForExport(el, backdrop);
	const width = Math.max(360, Math.round(el.getBoundingClientRect().width) || 640);
	const wrap = document.createElement("div");
	wrap.setAttribute("aria-hidden", "true");
	wrap.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;background:${backdrop};color-scheme:${
		isLightColor(parseCssColor(backdrop) ?? { r: 255, g: 255, b: 255, a: 1 }) ? "light" : "dark"
	};`;
	wrap.appendChild(clone);
	document.body.appendChild(wrap);
	try {
		const blob = await rasterizeElementToPngBlob(clone, { backgroundColor: backdrop });
		await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
	} finally {
		wrap.remove();
	}
}
