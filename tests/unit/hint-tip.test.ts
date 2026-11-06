// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { HintTip, TipButton } from "../../web/src/components/HintTip.js";

let root: Root | null = null;

afterEach(() => {
	vi.unstubAllGlobals();
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

function stubSyncRaf() {
	vi.stubGlobal("requestAnimationFrame", ((cb: FrameRequestCallback) => {
		cb(0);
		return 0;
	}) as typeof requestAnimationFrame);
	vi.stubGlobal("cancelAnimationFrame", () => {});
}

function openTip(text = "很长很长的说明文本") {
	stubSyncRaf();
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(createElement(HintTip, { text }));
	});
	const anchor = container.querySelector(".set-tip") as HTMLElement;
	act(() => {
		anchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
	});
	expect(document.querySelector(".set-tip-bubble")).toBeTruthy();
	return anchor;
}

const bubble = () => document.querySelector(".set-tip-bubble");

describe("HintTip 滚动跟随", () => {
	it("滚动/缩放不收起气泡", () => {
		openTip();
		act(() => {
			window.dispatchEvent(new Event("scroll"));
		});
		expect(bubble()).toBeTruthy();
		act(() => {
			window.dispatchEvent(new Event("resize"));
		});
		expect(bubble()).toBeTruthy();
	});

	it("锚点滚出视口才收起", () => {
		const anchor = openTip();
		anchor.getBoundingClientRect = () =>
			({
				left: 0,
				top: 900,
				right: 20,
				bottom: 920,
				width: 20,
				height: 20,
				x: 0,
				y: 900,
				toJSON() {},
			}) as DOMRect;
		act(() => {
			window.dispatchEvent(new Event("scroll"));
		});
		expect(bubble()).toBeNull();
	});

	it("鼠标离开仍收起（旧行为不变）", () => {
		const anchor = openTip();
		act(() => {
			anchor.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
		});
		expect(bubble()).toBeNull();
	});

	it("TipButton 悬停立即弹出名称气泡，离开即收起", () => {
		stubSyncRaf();
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() => {
			root!.render(createElement(TipButton, { tip: "此电脑", className: "crumb" }, "icon"));
		});
		const btn = container.querySelector("button.crumb") as HTMLElement;
		expect(btn).toBeTruthy();
		expect(btn.getAttribute("aria-label")).toBe("此电脑");
		expect(btn.getAttribute("title")).toBeNull();
		act(() => {
			btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
		});
		expect(bubble()?.textContent).toBe("此电脑");
		act(() => {
			btn.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
		});
		expect(bubble()).toBeNull();
	});
});
