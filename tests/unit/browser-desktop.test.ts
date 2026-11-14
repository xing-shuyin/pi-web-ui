import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
	browserLayout,
	initialBrowserMode,
	isBrowserAssetUrl,
	isCustomCredentialAction,
	isTrustedAgentUrl,
	normalizeAgentUrl,
	panelLayerBounds,
	panelLayerDefaultSize,
	PANEL_LAYER_MARGIN,
	PANEL_LAYER_MIN_HEIGHT,
	PANEL_LAYER_MIN_WIDTH,
	PANEL_LAYER_TOP,
	MIN_SPLIT_RATIO,
	MAX_SPLIT_RATIO,
	ACTION_POPUP_BLUR_GRACE_MS,
} from "../../desktop/browser-policy.js";
import { getDesktopWindowBridge, isDesktopShell } from "../../web/src/desktop.js";

describe("desktop browser composition", () => {
	it("动作弹窗的失焦宽限要盖住「开弹窗 → 收面板」这一轮，又不能长到让点外面关不掉", () => {
		expect(ACTION_POPUP_BLUR_GRACE_MS).toBeGreaterThanOrEqual(150);
		expect(ACTION_POPUP_BLUR_GRACE_MS).toBeLessThanOrEqual(600);
	});
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
		expect(isBrowserAssetUrl(pathToFileURL(resolve(dir, "panel.html")).href, dir)).toBe(true);
		expect(isBrowserAssetUrl(pathToFileURL(resolve(dir, "arbitrary.html")).href, dir)).toBe(false);
		expect(isBrowserAssetUrl(pathToFileURL(resolve(dir, "child", "newtab.html")).href, dir)).toBe(false);
		expect(isBrowserAssetUrl("https://example.test/newtab.html", dir)).toBe(false);
	});
	it("blocks credential bridge actions on custom newtab pages", () => {
		for (const action of [
			"passwords.list",
			"passwords.reveal",
			"passwords.upsert",
			"totp.list",
			"totp.code",
			"totp.export",
		]) {
			expect(isCustomCredentialAction(action)).toBe(true);
		}
		for (const action of ["tabs.create", "navigate", "settings.get", "bookmarks.list", "design.status", "state"]) {
			expect(isCustomCredentialAction(action)).toBe(false);
		}
		expect(isCustomCredentialAction("")).toBe(false);
		expect(isCustomCredentialAction(undefined)).toBe(false);
	});
	it("keeps the panel layer inside the window, under the toolbar and clear of the edges", () => {
		const area = { width: 1200, height: 800 };
		// 面板自己报多大就摆多大，右边缘距窗口 14px、顶边落在工具栏下沿
		expect(panelLayerBounds(area, { width: 360, height: 240 })).toEqual({
			x: 1200 - 14 - 360,
			y: PANEL_LAYER_TOP,
			width: 360,
			height: 240,
		});
		// 报得比窗口还大：夹进可用区域，底部与右边都不越界
		const huge = panelLayerBounds(area, { width: 4000, height: 4000 });
		expect(huge.width).toBe(1200 - 28);
		expect(huge.height).toBe(800 - PANEL_LAYER_TOP - 14);
		expect(huge.x + huge.width + 14).toBe(1200);
		expect(huge.y + huge.height + 14).toBe(800);
		// 量不出来（0 / NaN）时退回最小尺寸，不能变成看不见的一条线
		const broken = panelLayerBounds(area, { width: 0, height: Number.NaN });
		expect(broken).toEqual({
			x: 1200 - 14 - PANEL_LAYER_MIN_WIDTH,
			y: PANEL_LAYER_TOP,
			width: PANEL_LAYER_MIN_WIDTH,
			height: PANEL_LAYER_MIN_HEIGHT,
		});
		// 小窗口也不能把面板挤到负坐标
		const tiny = panelLayerBounds({ width: 200, height: 120 }, { width: 360, height: 320 });
		expect(tiny.x).toBe(PANEL_LAYER_MARGIN);
		expect(tiny.width).toBe(PANEL_LAYER_MIN_WIDTH);
		expect(tiny.height).toBe(PANEL_LAYER_MIN_HEIGHT);
	});
	it("puts the extension panel on its own small layer and everything else on a dialog-sized one", () => {
		expect(panelLayerDefaultSize("extensions")).toEqual({ width: 360, height: 320 });
		expect(panelLayerDefaultSize("settings")).toEqual({ width: 650, height: 620 });
		expect(panelLayerDefaultSize("bogus")).toEqual(panelLayerDefaultSize("bookmarks"));
	});
	it("keeps native capabilities on the embedded Agent while avoiding duplicate window controls", () => {
		const windowControls = {} as any;
		const embedded = { piDesktop: { isDesktop: true, embedded: true, window: windowControls } };
		expect(isDesktopShell(embedded)).toBe(true);
		expect(getDesktopWindowBridge(embedded)).toBeNull();
		expect(getDesktopWindowBridge({ piDesktop: { isDesktop: true, window: windowControls } })).toBe(windowControls);
	});
});
