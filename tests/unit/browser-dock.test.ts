import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCK_SCRIPT, getDockScript } from "../../browser/runtime/dock.js";

const DOCK_JS = readFileSync(new URL("../../browser/renderer/dock.js", import.meta.url), "utf8");
const MANAGER_TS = readFileSync(new URL("../../browser/runtime/manager.ts", import.meta.url), "utf8");
const BUILD_MJS = readFileSync(new URL("../../scripts/build-browser.mjs", import.meta.url), "utf8");

describe("浏览器悬浮 Dock（刷新圆钮）", () => {
	it("注入源码只有 renderer/dock.js 一份，并且打包时会进 dist", () => {
		// 旧实现留了一份会跑偏的内联复制品，两边各修一遍还常常只修一边；现在单源
		expect(getDockScript()).toContain("__AIB_DOCK__");
		expect(DOCK_SCRIPT).toContain("__AIB_DOCK__");
		expect(DOCK_SCRIPT).toBe(DOCK_JS);
		expect(BUILD_MJS).toContain('"dock.js"');
		expect(MANAGER_TS).toContain("if (DOCK_SCRIPT &&");
	});

	it("整段 UI 只用 createElement 建：站点开了 Trusted Types 也建得出按钮", () => {
		// 旧实现 createPolicy() 失败 → setMarkup() 什么都没建出来 → 整颗钮「看不见」
		expect(DOCK_JS).not.toMatch(/\.innerHTML\s*=/);
		expect(DOCK_JS).not.toMatch(/createPolicy\(/);
		expect(DOCK_JS).toContain("createElementNS");
		// 样式走构造式样式表（不吃页面 CSP style-src），拿不到才退回 <style>
		expect(DOCK_JS).toContain("adoptedStyleSheets");
	});

	it("宿主挂在 top layer：站点 z-index / transform / overflow 都压不住", () => {
		expect(DOCK_JS).toContain('setAttribute("popover", "manual")');
		expect(DOCK_JS).toContain("showPopover()");
		expect(DOCK_JS).toContain("hidePopover()");
		// popover 属性必须能被摘掉：UA 的 [popover]:not(:popover-open){display:none} 会反把钮藏掉
		expect(DOCK_JS).toContain('removeAttribute("popover")');
	});

	it("全屏 / 被站点摘掉 / 被改了 inline 样式之后都会自己回来", () => {
		expect(DOCK_JS).toContain("fullscreenchange");
		expect(DOCK_JS).toContain("raiseTopLayer()");
		expect(DOCK_JS).toContain("MutationObserver");
		expect(DOCK_JS).toContain("if (!host.isConnected || host.parentNode !== parent) parent.appendChild(host)");
		expect(DOCK_JS).toContain("assertHostStyles()");
		expect(DOCK_JS).toContain("setInterval(watch");
		// 重复注入（dom-ready + did-finish-load）不会建出第二个 Dock
		expect(DOCK_JS).toContain("existingDock.ready");
		expect(DOCK_JS).toContain("remount");
	});

	it("不往内部页注入，且仍然只在单击（非拖动）时刷新", () => {
		expect(DOCK_JS).toContain('location.pathname.includes("shell.html")');
		expect(DOCK_JS).toContain('location.pathname.includes("newtab.html")');
		expect(DOCK_JS).toContain("location.reload()");
		expect(DOCK_JS).toContain("if (hasMoved)");
	});
});
