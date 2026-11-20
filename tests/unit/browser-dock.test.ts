import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCK_SCRIPT, getDockScript } from "../../browser/runtime/dock.js";

const DOCK_JS = readFileSync(new URL("../../browser/renderer/dock.js", import.meta.url), "utf8");
const DOWNLOADS_JS = readFileSync(new URL("../../browser/renderer/downloads.js", import.meta.url), "utf8");
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
		// 判据是 file:// 协议 + 内部页文件名：只看 pathname 会把 github.com 上的同名路径当内部页
		expect(DOCK_JS).toContain(
			'location.protocol === "file:" && /(?:^|\\/)(?:shell|newtab)\\.html$/i.test(location.pathname)',
		);
		expect(DOCK_JS).toContain("location.reload()");
		expect(DOCK_JS).toContain("if (hasMoved)");
	});

	it("刷新钮不透明，位置恢复按当前视口夹一遍（否则窄窗口里整颗钮落到屏幕外）", () => {
		expect(DOCK_JS).not.toContain("opacity: 0.35");
		expect(DOCK_JS).not.toMatch(/\.dock-container:hover\s*\{\s*opacity/);
		// 拖动与恢复走同一个夹取函数，窗口变小后（分栏 / 还原）重新夹
		expect(DOCK_JS).toContain("function clampPosition(");
		expect(DOCK_JS).toContain('window.addEventListener("resize"');
		const mousemove = DOCK_JS.slice(DOCK_JS.indexOf('window.addEventListener("mousemove"'));
		expect(mousemove).toContain("place(initialRight - dx, initialBottom - dy)");
	});

	it("看不见就自己救回来：连可见性一起查，不只是「在 DOM 里」", () => {
		expect(DOCK_JS).toContain("function onScreen()");
		expect(DOCK_JS).toContain("host.getBoundingClientRect()");
		const watch = DOCK_JS.slice(DOCK_JS.indexOf("function watch()"));
		expect(watch).toContain("if (onScreen()) return");
	});

	it("一列钮一样大、悬停不放大，展开方向跟着视口边缘翻转", () => {
		// 主钮 / 菜单钮 / 插槽里的下载钮同一个尺寸：一列圆钮看着得是一条线
		const rule = (selector: string) => {
			const start = DOCK_JS.indexOf(`${selector} {`);
			const end = DOCK_JS.indexOf("}", start);
			return start >= 0 && end > start ? DOCK_JS.slice(start, end) : "";
		};
		const widthOf = (selector: string) => Number((/width:\s*(\d+)px/.exec(rule(selector)) || [])[1]);
		expect(widthOf(".dock-main-btn")).toBe(32);
		expect(widthOf(".dock-sub-btn")).toBe(widthOf(".dock-main-btn"));
		expect(DOWNLOADS_JS).toContain("width: 32px;");
		// 悬停只换底色：圆钮不许“弹一下”，呼吸态也不许改尺寸
		expect(rule(".dock-sub-btn:hover")).not.toContain("transform");
		expect(rule(".dock-main-btn:hover")).not.toContain("transform");
		expect(DOCK_JS).not.toContain("transform: scale(1.12)");
		// 主钮贴顶边就整列翻转（主钮在上、菜单往下长），装不下就压上限并可滚——不给边缘切钮
		expect(DOCK_JS).toContain(".dock-container.dock-flip");
		expect(DOCK_JS).toContain("flex-direction: column-reverse");
		expect(DOCK_JS).toContain("var(--dock-menu-max, 230px)");
		expect(DOCK_JS).toContain('dock.classList.toggle("dock-flip", flip)');
	});
});
