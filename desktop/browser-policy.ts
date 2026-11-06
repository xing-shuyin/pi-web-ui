import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserMode } from "../browser/contracts.js";

export const BROWSER_TOOLBAR_HEIGHT = 88;

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
	const y = fullscreen ? 0 : BROWSER_TOOLBAR_HEIGHT;
	const area = { x: 0, y, width: Math.max(0, Math.floor(width)), height: Math.max(0, Math.floor(height) - y) };
	const split = Number.isFinite(ratio) ? Math.max(0.2, Math.min(0.8, ratio)) : 0.5;
	const left = Math.floor(area.width * split);
	return {
		browser: mode === "split" ? { ...area, x: left, width: area.width - left } : area,
		agent: mode === "split" ? { ...area, width: left } : area,
		showBrowser: mode !== "agent",
		showAgent: mode !== "browser",
	};
}
