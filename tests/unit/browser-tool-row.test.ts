import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 外壳第二行工具栏（刷新/下载/书签/历史/设置…）与它背后的页面级动作。
 *
 * 这些动作以前挂在注入页面的悬浮球上（`dock.js`，已下线）：它跟着站点漂、会被站点层级压住。
 * 现在入口固定在外壳里，页面侧只保留「页面里跑一小段脚本」这条窄路，这里把三处接线钉住。
 */
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const SHELL_TS = read("browser/renderer/shell.ts");
const HOST_TS = read("desktop/browser-host.ts");
const MANAGER_TS = read("browser/runtime/manager.ts");
const PRELOAD_CTS = read("desktop/preload.cts");
const POLICY_TS = read("desktop/browser-policy.ts");

describe("外壳第二行工具栏", () => {
	it("标签页行与工具栏行是两行，页面视图从两行之下开始", () => {
		expect(POLICY_TS).toContain("BROWSER_TAB_ROW_HEIGHT = 40");
		expect(POLICY_TS).toContain("BROWSER_TOOL_ROW_HEIGHT = 40");
		expect(POLICY_TS).toContain("BROWSER_TAB_ROW_HEIGHT + BROWSER_TOOL_ROW_HEIGHT");
		expect(SHELL_TS).toContain("pb-tool-row");
	});

	it("刷新/下载/书签/历史/设置都在工具栏里，不靠悬浮球", () => {
		expect(SHELL_TS).toContain("browserAction(\"reload\")");
		expect(SHELL_TS).toContain("showShellPanel(\"downloads\")");
		expect(SHELL_TS).toContain("showShellPanel(\"bookmarks\")");
		expect(SHELL_TS).toContain("showShellPanel(\"history\")");
		expect(SHELL_TS).toContain("showShellPanel(\"settings\")");
		// 悬浮球彻底下线：不再有注入脚本、不再有 smartDock 分支
		expect(MANAGER_TS).not.toContain("DOCK_SCRIPT");
		expect(MANAGER_TS).not.toContain("__AIB_DOCK__");
	});

	it("翻译与复制 Markdown 走「活动标签页里跑脚本」，剪贴板由主进程写", () => {
		expect(SHELL_TS).toContain("page.translate");
		expect(SHELL_TS).toContain("page.markdown");
		expect(HOST_TS).toContain("case \"page.translate\"");
		expect(HOST_TS).toContain("case \"page.markdown\"");
		expect(HOST_TS).toContain("clipboard.writeText(markdown)");
		// 翻译脚本仍然只对 http(s) 网站注入（外壳按钮调用的就是它）
		expect(MANAGER_TS).toContain("TRANSLATE_SCRIPT");
		expect(read("browser/renderer/translate.js")).toContain("togglePage");
	});
});

describe("标签页右键 → 引用到输入框", () => {
	it("外壳发 tabs.menu（原生菜单，DOM 浮层会被原生视图盖住）", () => {
		expect(SHELL_TS).toContain("\"tabs.menu\"");
		expect(HOST_TS).toContain("case \"tabs.menu\"");
		expect(HOST_TS).toContain("引用到输入框");
	});

	it("页面选中文字也能引用，且带着它所在的标签页", () => {
		// 页面右键菜单（不是外壳）：选中非空时才加这一项
		expect(HOST_TS).toContain("quoteSelectionToAgent");
		expect(HOST_TS).toContain("引用到输入框 / Quote to input");
	});

	it("跨视图只走主进程：host 发、preload 收、Agent 页面插到光标处", () => {
		expect(HOST_TS).toContain("\"pi-desktop:browser-reference\"");
		expect(PRELOAD_CTS).toContain("pi-desktop:browser-reference");
		expect(PRELOAD_CTS).toContain("onBrowserReference");
		const app = read("web/src/App.tsx");
		expect(app).toContain("getDesktopBrowserReferenceBridge");
		expect(app).toContain("browserReferenceInsertion");
	});
});

describe("Edge 式一键翻译（页面脚本 + 桥）", () => {
	const TRANSLATE_JS = read("browser/renderer/translate.js");
	const PRELOAD_BROWSER_CTS = read("browser/preload.cts");
	const SETTINGS_KEY = "translateAutoPrompt";

	it("一键触发：外壳按钮 → page.translate → 页面 togglePage（不阻塞等结果）", () => {
		expect(SHELL_TS).toContain("page.translate");
		expect(HOST_TS).toContain("PAGE_TRANSLATE_SCRIPT");
		expect(TRANSLATE_JS).toContain("togglePage");
		// 页面里必须是异步开工：主进程这一侧只拿一句开头语
		expect(HOST_TS).toContain("void api.togglePage()");
	});

	it("异步铺满：大段少次、多路并发、边翻边填", () => {
		expect(TRANSLATE_JS).toContain("BATCH_CHARS = 5000");
		expect(TRANSLATE_JS).toContain("MAX_BATCH_NODES");
		expect(TRANSLATE_JS).toContain("BATCH_CONCURRENCY = 4");
		// 取消/显示原文之后，在途的批量不许再写回页面
		expect(TRANSLATE_JS).toContain("runToken");
		// 后加载内容跟翻：已翻过的节点不会重复翻
		expect(TRANSLATE_JS).toContain("MutationObserver");
		expect(TRANSLATE_JS).toContain("collectFreshNodes");
	});

	it("页面里有 Edge 式状态胶囊，且自动询问走只读 config 桥", () => {
		expect(TRANSLATE_JS).toContain("pi-translate-pill-host");
		expect(TRANSLATE_JS).toContain("attachShadow");
		expect(TRANSLATE_JS).toContain("maybeOfferTranslation");
		expect(PRELOAD_BROWSER_CTS).toContain("pi-browser:translate-config");
		expect(HOST_TS).toContain("pi-browser:translate-config");
		expect(read("browser/storage/index.ts")).toContain(SETTINGS_KEY);
		expect(read("browser/renderer/panels.ts")).toContain(SETTINGS_KEY);
	});
});
