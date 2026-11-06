// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushEscapeHandler, resetEscapeStack } from "../../web/src/shortcut-stack.js";

describe("shortcut-stack (Escape key dispatcher)", () => {
	beforeEach(() => {
		resetEscapeStack();
	});

	afterEach(() => {
		resetEscapeStack();
	});

	it("后入栈的 handler 优先响应（LIFO 栈顺序）", () => {
		const order: string[] = [];

		const unreg1 = pushEscapeHandler(() => {
			order.push("first");
		});
		const unreg2 = pushEscapeHandler(() => {
			order.push("second");
		});

		const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
		document.dispatchEvent(event);

		expect(order).toEqual(["second"]);

		unreg2();
		unreg1();
	});

	it("栈顶显式返回 false 时放行给更下层 handler", () => {
		const order: string[] = [];

		const unreg1 = pushEscapeHandler(() => {
			order.push("first");
			return true;
		});
		const unreg2 = pushEscapeHandler(() => {
			order.push("second (skipped)");
			return false;
		});

		const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
		document.dispatchEvent(event);

		expect(order).toEqual(["second (skipped)", "first"]);

		unreg2();
		unreg1();
	});

	it("注销栈顶 handler 后，原本的下层 handler 成为新的栈顶", () => {
		const order: string[] = [];

		const unreg1 = pushEscapeHandler(() => {
			order.push("bottom");
		});
		const unreg2 = pushEscapeHandler(() => {
			order.push("top");
		});

		unreg2();

		const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
		document.dispatchEvent(event);

		expect(order).toEqual(["bottom"]);

		unreg1();
	});

	it("非 Escape 按键被忽略，不触发任何 handler", () => {
		const fn = vi.fn();
		const unreg = pushEscapeHandler(fn);

		const event = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
		document.dispatchEvent(event);

		expect(fn).not.toHaveBeenCalled();

		unreg();
	});
});
