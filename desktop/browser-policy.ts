import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserMode } from "../browser/contracts.js";

export const BROWSER_TOOLBAR_HEIGHT = 40;
export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;

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
		return ["shell.html", "newtab.html", "office.html", "workspace.html", "search.html"].some(
			(name) => path === resolve(assetsDir, name),
		);
	} catch {
		return false;
	}
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
