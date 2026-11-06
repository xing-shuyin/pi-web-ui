// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { useClickOutside } from "../../web/src/use-click-outside.js";

let root: Root | null = null;

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("useClickOutside", () => {
	it("点击目标外部触发回调，点击目标内部不触发", () => {
		const onClickOutside = vi.fn();

		function TestComponent() {
			const targetRef = useRef<HTMLDivElement>(null);
			useClickOutside(targetRef, onClickOutside);

			return createElement(
				"div",
				null,
				createElement("div", { ref: targetRef, className: "target" }, "Target Content"),
				createElement("div", { className: "outside" }, "Outside Content"),
			);
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent));
		});

		const targetEl = container.querySelector(".target")!;
		const outsideEl = container.querySelector(".outside")!;

		act(() => {
			targetEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		});
		expect(onClickOutside).not.toHaveBeenCalled();

		act(() => {
			outsideEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		});
		expect(onClickOutside).toHaveBeenCalledTimes(1);
	});

	it("点击 ignore 列表中的元素不触发外部点击", () => {
		const onClickOutside = vi.fn();

		function TestComponent() {
			const targetRef = useRef<HTMLDivElement>(null);
			const triggerRef = useRef<HTMLButtonElement>(null);
			useClickOutside(targetRef, onClickOutside, { ignore: triggerRef });

			return createElement(
				"div",
				null,
				createElement("button", { ref: triggerRef, className: "trigger" }, "Trigger"),
				createElement("div", { ref: targetRef, className: "target" }, "Target Content"),
			);
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent));
		});

		const triggerEl = container.querySelector(".trigger")!;

		act(() => {
			triggerEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		});
		expect(onClickOutside).not.toHaveBeenCalled();
	});

	it("移动端 touchstart 事件正常触发外部点击", () => {
		const onClickOutside = vi.fn();

		function TestComponent() {
			const targetRef = useRef<HTMLDivElement>(null);
			useClickOutside(targetRef, onClickOutside);

			return createElement("div", { ref: targetRef, className: "target" });
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent));
		});

		act(() => {
			document.body.dispatchEvent(new TouchEvent("touchstart", { bubbles: true }));
		});
		expect(onClickOutside).toHaveBeenCalledTimes(1);
	});
});
