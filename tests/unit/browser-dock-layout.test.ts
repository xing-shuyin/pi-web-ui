// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 悬浮 Dock 的摆位（真跑一遍脚本，不是读源码猜）：
 * 一列钮一个尺寸，展开方向跟着视口边缘走——主钮贴顶边时整列翻转、菜单往下长，
 * 任何情况下都不让展开的圆钮被视口边缘切掉。
 */
const REPO = path.resolve(__dirname, "../..");
const DOCK_JS = readFileSync(path.join(REPO, "browser/renderer/dock.js"), "utf8");

type AnyWindow = Window & { __AIB_DOCK__?: { ready: boolean; slot(id: string): HTMLElement | null } };
const w = window as AnyWindow;

// jsdom 默认视口 1024×768
const VIEW_H = 768;
const MAIN = 32; // 与 .dock-main-btn 同尺寸（jsdom 量不到真实高度，脚本按统一尺寸兜底）

function boot(saved?: { right: number; bottom: number }) {
	window.localStorage.clear();
	if (saved) window.localStorage.setItem("__aib_dock_pos", JSON.stringify(saved));
	// 上一个用例的 Dock 还挂着看门狗，可能把自己挂回 body：先清干净再建新的
	document.querySelectorAll("#ai-browser-dock-host").forEach((el) => el.remove());
	new Function(DOCK_JS)();
	const hosts = document.querySelectorAll("#ai-browser-dock-host");
	const host = hosts[hosts.length - 1] as HTMLElement | undefined;
	if (!host?.shadowRoot) throw new Error("dock host missing");
	const dock = host.shadowRoot.querySelector(".dock-container") as HTMLElement;
	if (!dock) throw new Error("dock container missing");
	return dock;
}

beforeEach(() => {
	document.body.replaceChildren();
	delete w.__AIB_DOCK__;
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("悬浮 Dock 摆位", () => {
	it("默认在右下角往上长：锚 bottom，不翻转", () => {
		const dock = boot();
		expect(dock.classList.contains("dock-flip")).toBe(false);
		expect(dock.style.bottom).toBe("28px");
		expect(dock.style.top).toBe("auto");
	});

	it("主钮贴在视口顶边就翻转：主钮留在原处，菜单往下长", () => {
		// bottom 700 → 主钮顶边 = 768 - 700 - 32 = 36，上方只有 24px，装不下一整列
		const dock = boot({ right: 28, bottom: 700 });
		expect(dock.classList.contains("dock-flip")).toBe(true);
		expect(dock.style.bottom).toBe("auto");
		expect(dock.style.top).toBe(`${VIEW_H - 700 - MAIN}px`);
	});

	it("拖动时翻转跟着位置走，落盘存的仍是逻辑锚点", () => {
		const dock = boot();
		const main = dock.querySelector(".dock-main-btn") as HTMLElement;
		main.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 100, clientY: 700 }));
		window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 100, clientY: 60 }));
		window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

		const saved = JSON.parse(window.localStorage.getItem("__aib_dock_pos") || "{}");
		expect(saved.right).toBe(28);
		expect(saved.bottom).toBe(28 + 640);
		expect(dock.classList.contains("dock-flip")).toBe(true);
		expect(dock.style.top).toBe(`${VIEW_H - saved.bottom - MAIN}px`);
	});

	it("窗口矮到两边都放不下时压小展开上限并可滚，不把钮切掉", () => {
		vi.spyOn(window, "innerHeight", "get").mockReturnValue(150);
		const dock = boot({ right: 28, bottom: 28 });
		// 150 高的视口：主钮顶边 90，上方 78、下方 16 都装不下一整列 → 压上限 + 允许滚动
		expect(dock.style.getPropertyValue("--dock-menu-max")).toMatch(/^\d+px$/);
		const menu = dock.querySelector(".dock-expanded-menu") as HTMLElement;
		expect(menu.style.overflowY).toBe("auto");
	});
});
