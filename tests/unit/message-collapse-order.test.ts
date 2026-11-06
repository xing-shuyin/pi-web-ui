// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { Message } from "../../web/src/components/Message.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { UiMessage } from "../../web/src/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web", "src", "styles.css"), "utf8");

let root: Root | null = null;

function mount(message: UiMessage, onCollapse?: (id: string) => void) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(Message, {
					message,
					toolResults: new Map(),
					liveOutputs: new Map(),
					toolStatuses: new Map(),
					streaming: false,
					isLast: false,
					onCollapse,
				} as unknown as Parameters<typeof Message>[0]),
			),
		);
	});
	return container;
}

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

const baseMessage = {
	id: "a-1-1",
	role: "assistant",
	content: [{ type: "text", text: "hello" }],
	timestamp: 1758120000000,
	model: "test-model",
} as unknown as UiMessage;

describe("w23 message collapse order", () => {
	it("collapse button is the first child of .msg-meta, before the role span", () => {
		const container = mount(baseMessage, () => {});
		const meta = container.querySelector(".msg-meta")!;
		expect(meta).not.toBeNull();
		expect(meta.firstElementChild?.tagName).toBe("BUTTON");
		expect(meta.firstElementChild?.classList.contains("msg-collapse-btn")).toBe(true);
		const order = Array.from(meta.children).map((el) =>
			el.classList.contains("msg-collapse-btn") ? "button" : el.className.split(" ")[0],
		);
		expect(order[0]).toBe("button");
		expect(order).toContain("msg-role");
		expect(order.indexOf("button")).toBeLessThan(order.indexOf("msg-role"));
	});

	it("no collapse button without onCollapse; role span stays first", () => {
		const container = mount(baseMessage);
		const meta = container.querySelector(".msg-meta")!;
		expect(meta.querySelector("button.msg-collapse-btn")).toBeNull();
		expect(meta.firstElementChild?.classList.contains("msg-role")).toBe(true);
	});

	it("collapse button fires onCollapse with the message id", () => {
		const onCollapse = vi.fn();
		const container = mount(baseMessage, onCollapse);
		const btn = container.querySelector<HTMLButtonElement>("button.msg-collapse-btn")!;
		act(() => {
			btn.click();
		});
		expect(onCollapse).toHaveBeenCalledWith(baseMessage.id);
	});

	it("no CSS pushes the collapse button right (margin-left auto / float / absolute)", () => {
		const btnBlock = CSS.match(/\.msg-collapse-btn\s*\{[^}]*\}/s)?.[0] ?? "";
		expect(btnBlock).not.toMatch(/margin-left\s*:\s*auto/);
		expect(btnBlock).not.toMatch(/float\s*:/);
		expect(btnBlock).not.toMatch(/position\s*:\s*(absolute|fixed)/);
	});

	it("time keeps margin-left auto so it stays right", () => {
		const timeBlock = CSS.match(/\.msg-time\s*\{[^}]*\}/s)?.[0] ?? "";
		expect(timeBlock).toMatch(/margin-left\s*:\s*auto/);
	});
});
