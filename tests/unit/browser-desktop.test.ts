import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
	browserLayout,
	initialBrowserMode,
	isBrowserAssetUrl,
	isTrustedAgentUrl,
	normalizeAgentUrl,
	MIN_SPLIT_RATIO,
	MAX_SPLIT_RATIO,
} from "../../desktop/browser-policy.js";
import { getDesktopWindowBridge, isDesktopShell } from "../../web/src/desktop.js";

describe("desktop browser composition", () => {
	it("starts in Agent mode unless the saved startup mode says otherwise", () => {
		expect(initialBrowserMode({ defaultMode: "agent" })).toBe("agent");
		expect(initialBrowserMode({ defaultMode: "browser" })).toBe("browser");
		expect(initialBrowserMode({ defaultMode: "split" })).toBe("split");
		expect(initialBrowserMode(undefined)).toBe("agent");
		expect(initialBrowserMode({})).toBe("agent");
		expect(initialBrowserMode({ defaultMode: "bogus" })).toBe("agent");
	});
	it("keeps the browser and Agent in the same usable viewport when switching modes", () => {
		const browser = browserLayout(1200, 800, "browser", 0.5);
		const agent = browserLayout(1200, 800, "agent", 0.5);
		expect(browser.browser).toEqual({ x: 0, y: 40, width: 1200, height: 760 });
		expect(agent.agent).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
		expect(browser.showBrowser).toBe(true);
		expect(browser.showAgent).toBe(false);
		expect(agent.showBrowser).toBe(false);
		expect(agent.showAgent).toBe(true);
	});
	it("divides the available area without overlap and clamps invalid ratios", () => {
		const split = browserLayout(1201, 800, "split", 0.4);
		expect(split.agent.width + split.browser.width).toBe(1201);
		expect(split.browser.x).toBe(split.agent.width);
		expect(split.agent.height).toBe(800);
		expect(split.browser.height).toBe(760);
		expect(browserLayout(1200, 20, "split", Infinity).agent.height).toBe(20);
		expect(browserLayout(1200, 20, "split", Infinity).browser.height).toBe(0);
		expect(browserLayout(1200, 800, "split", 10).agent.width).toBe(1200 * MAX_SPLIT_RATIO);
		expect(browserLayout(1200, 800, "split", -1).agent.width).toBe(1200 * MIN_SPLIT_RATIO);
		expect(browserLayout(1200, 800, "split", 0.05).agent.width).toBe(1200 * MIN_SPLIT_RATIO);
		expect(browserLayout(1200, 800, "split", 0.05).browser.x).toBe(1200 * MIN_SPLIT_RATIO);
		expect(browserLayout(1200, 800, "split", 0.05).browser.width).toBe(1200 - 1200 * MIN_SPLIT_RATIO);
	});
	it("trusts exactly the configured HTTP origin and rejects prefix lookalikes", () => {
		expect(isTrustedAgentUrl("https://agent.example/app/device/one/", "https://agent.example/app/")).toBe(true);
		expect(isTrustedAgentUrl("https://agent.example/another-app/", "https://agent.example/app/")).toBe(false);
		expect(isTrustedAgentUrl("https://agent.example/application/", "https://agent.example/app/")).toBe(false);
		expect(isTrustedAgentUrl("https://agent.example.evil.test/", "https://agent.example/")).toBe(false);
		expect(isTrustedAgentUrl("http://agent.example/", "https://agent.example/")).toBe(false);
		expect(isTrustedAgentUrl("file:///tmp/agent.html", "file:///tmp/agent.html")).toBe(false);
		expect(() => normalizeAgentUrl("javascript:alert(1)")).toThrow();
		expect(() => normalizeAgentUrl("https://user:secret@example.test/")).toThrow();
	});
	it("only gives internal privilege to exact bundled entry points", () => {
		const dir = resolve("browser-fixture");
		const url = pathToFileURL(resolve(dir, "office.html"));
		url.searchParams.set("path", "example.txt");
		expect(isBrowserAssetUrl(url.href, dir)).toBe(true);
		expect(isBrowserAssetUrl(pathToFileURL(resolve(dir, "arbitrary.html")).href, dir)).toBe(false);
		expect(isBrowserAssetUrl(pathToFileURL(resolve(dir, "child", "newtab.html")).href, dir)).toBe(false);
		expect(isBrowserAssetUrl("https://example.test/newtab.html", dir)).toBe(false);
	});
	it("keeps native capabilities on the embedded Agent while avoiding duplicate window controls", () => {
		const windowControls = {} as any;
		const embedded = { piDesktop: { isDesktop: true, embedded: true, window: windowControls } };
		expect(isDesktopShell(embedded)).toBe(true);
		expect(getDesktopWindowBridge(embedded)).toBeNull();
		expect(getDesktopWindowBridge({ piDesktop: { isDesktop: true, window: windowControls } })).toBe(windowControls);
	});
});
