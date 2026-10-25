// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { Dialog } from "../../web/src/components/Dialog.js";
import { setAppSend } from "../../web/src/app-globals.js";
import { LanguageProvider } from "../../web/src/i18n.js";

let root: Root | null = null;
let currentContainer: HTMLDivElement | null = null;

function mount(dialog: Parameters<typeof Dialog>[0]["dialog"]) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	currentContainer = container;
	root = createRoot(container);
	const sent: unknown[] = [];
	setAppSend((msg) => {
		sent.push(msg);
		return true;
	});
	act(() => {
		root!.render(createElement(LanguageProvider, null, createElement(Dialog, { dialog })));
	});
	return { container, sent };
}

afterEach(() => {
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	if (currentContainer) {
		currentContainer.remove();
		currentContainer = null;
	}
});

describe("Dialog component (issue #747)", () => {
	it("renders long multiline title in body prompt while keeping head title compact", () => {
		const longCommand = Array.from(
			{ length: 20 },
			(_, i) => `printf 'DISPLAY ONLY line ${i + 1} long-path-segment/'`,
		).join("\n");
		const fullTitle = `⚠️ Dangerous command:\n\n  ${longCommand}\n\nAllow?`;

		const { container, sent } = mount({
			id: 1,
			kind: "select",
			title: fullTitle,
			args: [["Yes", "No"]],
		});

		// 1. 顶栏标题只取首行，且带有完整悬停 title 属性
		const headTitle = container.querySelector(".dialog-head .dialog-title");
		expect(headTitle).not.toBeNull();
		expect(headTitle?.textContent).toBe("⚠️ Dangerous command:");
		expect(headTitle?.getAttribute("title")).toBe(fullTitle);

		// 2. 正文区必须完整包含全部 20 行命令提示
		const prompt = container.querySelector(".dialog-prompt");
		expect(prompt).not.toBeNull();
		expect(prompt?.textContent).toContain("DISPLAY ONLY line 1");
		expect(prompt?.textContent).toContain("DISPLAY ONLY line 20");
		expect(prompt?.textContent).toContain("Allow?");

		// 3. 选项位于正文之后，包含 Yes 与 No
		const options = container.querySelectorAll(".dialog-option");
		expect(options).toHaveLength(2);
		expect(options[0].textContent).toContain("Yes");
		expect(options[1].textContent).toContain("No");

		// 4. 不再展示 .dialog-custom-row，杜绝审批说明被误报为用户拒绝
		expect(container.querySelector(".dialog-custom-row")).toBeNull();

		// 5. 点击选项正常提交
		act(() => {
			(options[0] as HTMLButtonElement).click();
		});
		expect(sent).toEqual([{ type: "dialog_response", id: 1, value: "Yes" }]);
	});

	it("dismiss button sends null response", () => {
		const { container, sent } = mount({
			id: 2,
			kind: "select",
			title: "Simple select",
			args: [["A", "B"]],
		});

		const dismissBtn = container.querySelector(".dialog-dismiss") as HTMLButtonElement;
		expect(dismissBtn).not.toBeNull();
		act(() => {
			dismissBtn.click();
		});
		expect(sent).toEqual([{ type: "dialog_response", id: 2, value: null }]);
	});

	it("keyboard arrow keys navigate options and Enter submits selection", () => {
		const { container, sent } = mount({
			id: 3,
			kind: "select",
			title: "Branch",
			args: [["main", "dev", "test"]],
		});

		const options = container.querySelectorAll(".dialog-option");
		expect(options[0].classList.contains("sel")).toBe(true);

		// 按下箭头切到 dev
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
		});
		expect(options[1].classList.contains("sel")).toBe(true);

		// 按回车确认选中 dev
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		});
		expect(sent).toEqual([{ type: "dialog_response", id: 3, value: "dev" }]);
	});

	it("confirm dialog renders message and handles OK / Cancel", () => {
		const { container, sent } = mount({
			id: 4,
			kind: "confirm",
			title: "Delete file",
			args: ["Are you sure you want to delete this file?"],
		});

		const headTitle = container.querySelector(".dialog-head .dialog-title");
		expect(headTitle?.textContent).toBe("Delete file");

		const body = container.querySelector(".dialog-body");
		expect(body?.textContent).toContain("Are you sure you want to delete this file?");

		const buttons = container.querySelectorAll(".dialog-actions .btn");
		expect(buttons).toHaveLength(2);

		// 取消
		act(() => {
			(buttons[0] as HTMLButtonElement).click();
		});
		expect(sent).toEqual([{ type: "dialog_response", id: 4, value: false }]);

		// 确定
		act(() => {
			(buttons[1] as HTMLButtonElement).click();
		});
		expect(sent[1]).toEqual({ type: "dialog_response", id: 4, value: true });
	});
});
