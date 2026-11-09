import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserMode } from "../browser/contracts.js";

export const BROWSER_TOOLBAR_HEIGHT = 40;
export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;

/** 面板浮层离窗口右/下边缘的距离，顶边贴着工具栏下沿（与 CSS 里 `.pb-dialog` 的 48px 对齐）。 */
export const PANEL_LAYER_MARGIN = 14;
export const PANEL_LAYER_TOP = BROWSER_TOOLBAR_HEIGHT + 8;
export const PANEL_LAYER_MIN_WIDTH = 240;
export const PANEL_LAYER_MIN_HEIGHT = 120;
/** 面板自己报尺寸前先藏着的兜底时长：量不出来也不能把面板卡成看不见 */
export const PANEL_LAYER_SHOW_DELAY = 350;

/**
 * 窗口启动时该用哪个模式：读设置里的 defaultMode，非法/缺失时落到 agent。
 * 新用户没有 settings.json，因此默认就是 Agent；旧版本写过的 mode 已由 BrowserStorage 迁移。
 */
export function initialBrowserMode(settings: { defaultMode?: unknown } | undefined): BrowserMode {
	const value = settings?.defaultMode;
	return value === "agent" || value === "browser" || value === "split" ? value : "agent";
}

export function normalizeAgentUrl(value: unknown): string {
	if (typeof value !== "string") throw new Error("Invalid Agent URL");
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol) || /^https?:\/\/[^/]*@/i.test(url.href))
		throw new Error("Agent URL must use HTTP or HTTPS without embedded credentials");
	url.hash = "";
	return url.href;
}

export function isTrustedAgentUrl(value: string, agentUrl: string): boolean {
	try {
		const actual = new URL(value);
		const expected = new URL(agentUrl);
		const base = expected.pathname.replace(/\/+$/, "");
		return (
			["http:", "https:"].includes(actual.protocol) &&
			actual.origin === expected.origin &&
			(actual.pathname === base || actual.pathname.startsWith(`${base}/`))
		);
	} catch {
		return false;
	}
}

export function isBrowserAssetUrl(value: string, assetsDir: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol !== "file:") return false;
		const path = resolve(fileURLToPath(url));
		return ["shell.html", "panel.html", "newtab.html", "office.html", "workspace.html", "search.html"].some(
			(name) => path === resolve(assetsDir, name),
		);
	} catch {
		return false;
	}
}

/**
 * 面板浮层视图的默认尺寸：首帧还没量出面板自己要多大时先按这个摆。
 * 扩展面板是贴内容的小浮层，其余面板是接近满高的对话框。
 */
export function panelLayerDefaultSize(panel: string): { width: number; height: number } {
	return panel === "extensions" ? { width: 360, height: 320 } : { width: 650, height: 620 };
}

/**
 * 面板浮层视图的边界：贴窗口右上角、顶边落在工具栏下沿，宽高按面板自己报的尺寸夹进可用区域。
 * 面板是原生视图（盖在页面视图之上，不能按 DOM 的 z-index 悬浮），所以位置和尺寸只能由宿主算，
 * 且必须是整块矩形——这块矩形之外页面照常可见、可点。
 */
export function panelLayerBounds(
	area: { width: number; height: number },
	size: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
	const areaWidth = Math.max(0, Math.floor(area.width));
	const areaHeight = Math.max(0, Math.floor(area.height));
	const maxWidth = Math.max(PANEL_LAYER_MIN_WIDTH, areaWidth - PANEL_LAYER_MARGIN * 2);
	const maxHeight = Math.max(PANEL_LAYER_MIN_HEIGHT, areaHeight - PANEL_LAYER_TOP - PANEL_LAYER_MARGIN);
	const width = clampPanelSize(size?.width, PANEL_LAYER_MIN_WIDTH, maxWidth);
	const height = clampPanelSize(size?.height, PANEL_LAYER_MIN_HEIGHT, maxHeight);
	return {
		x: Math.max(PANEL_LAYER_MARGIN, areaWidth - PANEL_LAYER_MARGIN - width),
		y: PANEL_LAYER_TOP,
		width,
		height,
	};
}

/** 量不出来（NaN / 0 / 负数）时退回最小尺寸：浮层宁可小一点，也不能变成看不见的一条线。 */
function clampPanelSize(value: unknown, min: number, max: number): number {
	const size = Math.round(Number(value));
	if (!Number.isFinite(size) || size <= 0) return Math.min(min, max);
	return Math.min(Math.max(size, min), max);
}

export function browserLayout(width: number, height: number, mode: BrowserMode, ratio: number, fullscreen = false) {
	const clampedWidth = Math.max(0, Math.floor(width));
	const clampedHeight = Math.max(0, Math.floor(height));
	const toolbarHeight = fullscreen ? 0 : BROWSER_TOOLBAR_HEIGHT;
	const browserContentHeight = Math.max(0, clampedHeight - toolbarHeight);
	const split = Number.isFinite(ratio) ? Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, ratio)) : 0.5;
	const left = Math.floor(clampedWidth * split);
	const right = clampedWidth - left;

	if (mode === "agent") {
		return {
			browser: { x: 0, y: toolbarHeight, width: clampedWidth, height: browserContentHeight },
			agent: { x: 0, y: 0, width: clampedWidth, height: clampedHeight },
			showBrowser: false,
			showAgent: true,
		};
	}

	if (mode === "split") {
		return {
			browser: { x: left, y: toolbarHeight, width: right, height: browserContentHeight },
			agent: { x: 0, y: 0, width: left, height: clampedHeight },
			showBrowser: true,
			showAgent: true,
		};
	}

	return {
		browser: { x: 0, y: toolbarHeight, width: clampedWidth, height: browserContentHeight },
		agent: { x: 0, y: 0, width: clampedWidth, height: clampedHeight },
		showBrowser: true,
		showAgent: false,
	};
}
