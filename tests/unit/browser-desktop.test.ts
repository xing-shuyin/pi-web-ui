import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
	browserLayout,
	isBrowserAssetUrl,
	isTrustedAgentUrl,
	normalizeAgentUrl,
} from "../../desktop/browser-policy.js";
import { getDesktopWindowBridge, isDesktopShell } from "../../web/src/desktop.js";

describe("desktop browser composition", () => {
	it("keeps the browser and Agent in the same usable viewport when switching modes", () => {
		const browser = browserLayout(1200, 800, "browser", 0.5);
		const agent = browserLayout(1200, 800, "agent", 0.5);
		expect(browser.browser).toEqual({ x: 0, y: 88, width: 1200, height: 712 });
		expect(agent.agent).toEqual(browser.browser);
		expect(browser.showBrowser).toBe(true);
		expect(browser.showAgent).toBe(false);
		expect(agent.showBrowser).toBe(false);
		expect(agent.showAgent).toBe(true);
	});
	it("divides the available area without overlap and clamps invalid ratios", () => {
		const split = browserLayout(1201, 800, "split", 0.4);
		expect(split.agent.width + split.browser.width).toBe(1201);
		expect(split.browser.x).toBe(split.agent.width);
		expect(split.agent.height).toBe(712);
		expect(browserLayout(1200, 20, "split", Infinity).agent.height).toBe(0);
		expect(browserLayout(1200, 800, "split", 10).agent.width).toBe(960);
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
