// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { DirectoryBrowser, MACHINE_ROOT } from "../../web/src/components/DirectoryBrowser.js";
import { Dropdown } from "../../web/src/components/Dropdown.js";
import { en, LanguageProvider } from "../../web/src/i18n.js";
import { setAppGlobals, resetAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import { CanvasStudio } from "../../web/src/components/canvas/CanvasStudio.js";

let root: Root | null = null;

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("Canvas & Picker 事件隔离与关闭防护", () => {
	it("DirectoryBrowser: 点击右上角关闭按钮和遮罩均能正确触发 onClose，且阻止 pointerdown/wheel 冒泡", () => {
		const onClose = vi.fn();
		const onSelectDirectory = vi.fn();
		const parentPointerDown = vi.fn();
		const parentWheel = vi.fn();

		function TestWrapper() {
			return createElement(
				LanguageProvider,
				null,
				createElement(
					"div",
					{
						className: "mock-canvas-root",
						onPointerDown: parentPointerDown,
						onWheel: parentWheel,
					},
					createElement(DirectoryBrowser, {
						currentCwd: "/test/dir",
						pathCompletions: [],
						workspaceRoots: [],
						onClose,
						onSelectDirectory,
					}),
				),
			);
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestWrapper));
		});

		const closeBtn = document.body.querySelector(".cwd-close") as HTMLButtonElement;
		const backdrop = document.body.querySelector(".status-cwd-backdrop") as HTMLDivElement;
		const pickerPanel = document.body.querySelector(".cwd-picker") as HTMLDivElement;

		expect(closeBtn).toBeTruthy();
		expect(backdrop).toBeTruthy();
		expect(pickerPanel).toBeTruthy();

		act(() => {
			closeBtn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
			closeBtn.click();
		});
		expect(parentPointerDown).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledTimes(1);

		act(() => {
			pickerPanel.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 }));
		});
		expect(parentWheel).not.toHaveBeenCalled();

		act(() => {
			backdrop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
			backdrop.click();
		});
		expect(parentPointerDown).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it("Dropdown: 展开时下拉面板阻止 pointerdown 与 wheel 冒泡到 React 祖先组件", () => {
		const parentPointerDown = vi.fn();
		const parentWheel = vi.fn();

		function TestDropdownWrapper() {
			const [open, setOpen] = useState(true);
			return createElement(
				"div",
				{
					className: "mock-canvas-root",
					onPointerDown: parentPointerDown,
					onWheel: parentWheel,
				},
				createElement(Dropdown, {
					trigger: createElement("button", { className: "trigger-btn" }, "Select Model"),
					open,
					onOpenChange: setOpen,
					portal: true,
					children: createElement("div", { className: "custom-menu-item" }, "Claude 3.7 Sonnet"),
				}),
			);
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestDropdownWrapper));
		});

		const menuEl = document.body.querySelector(".dd-menu") as HTMLDivElement;
		expect(menuEl).toBeTruthy();

		act(() => {
			menuEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
		});
		expect(parentPointerDown).not.toHaveBeenCalled();

		act(() => {
			menuEl.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 50 }));
		});
		expect(parentWheel).not.toHaveBeenCalled();
	});

	it("DirectoryBrowser mode=project: 点击'创建并打开'时，若未传 onCreateProject 应自动兜底 make_dir 并回调 onSelectDirectory", () => {
		const sentMessages: any[] = [];
		setAppSend((msg) => {
			sentMessages.push(msg);
			return true;
		});

		const onSelectDirectory = vi.fn();
		const onClose = vi.fn();

		function TestPicker() {
			return createElement(
				LanguageProvider,
				null,
				createElement(DirectoryBrowser, {
					currentCwd: "/workspace/my-app",
					pathCompletions: [],
					workspaceRoots: [],
					mode: "project",
					onClose,
					onSelectDirectory,
				}),
			);
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestPicker));
		});

		const newBtn = document.body.querySelector(".cwd-toolbar .tool-new") as HTMLButtonElement;
		expect(newBtn).toBeTruthy();
		act(() => {
			newBtn.click();
		});

		const input = document.body.querySelector(".cwd-newrow input") as HTMLInputElement;
		expect(input).toBeTruthy();
		act(() => {
			const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
			nativeInputValueSetter?.call(input, "new-child-project");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});

		const createBtn = document.body.querySelector(".cwd-newrow .primary") as HTMLButtonElement;
		expect(createBtn).toBeTruthy();
		act(() => {
			createBtn.click();
		});

		expect(sentMessages).toEqual([
			{
				type: "make_dir",
				path: "/workspace/my-app/new-child-project",
			},
		]);
		expect(onSelectDirectory).toHaveBeenCalledWith("/workspace/my-app/new-child-project");
		expect(onClose).toHaveBeenCalledTimes(1);

		setAppSend(null);
	});

	it("DirectoryBrowser mode=project: 传入 onCreateProject 时优先由其接管创建与打开", () => {
		const onCreateProject = vi.fn();
		const onSelectDirectory = vi.fn();
		const onClose = vi.fn();

		function TestPicker() {
			return createElement(
				LanguageProvider,
				null,
				createElement(DirectoryBrowser, {
					currentCwd: "E:/t",
					pathCompletions: [],
					workspaceRoots: [],
					mode: "project",
					onClose,
					onSelectDirectory,
					onCreateProject,
				}),
			);
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestPicker));
		});

		const newBtn = document.body.querySelector(".cwd-toolbar .tool-new") as HTMLButtonElement;
		act(() => {
			newBtn.click();
		});

		const input = document.body.querySelector(".cwd-newrow input") as HTMLInputElement;
		act(() => {
			const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
			nativeInputValueSetter?.call(input, "c");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});

		const createBtn = document.body.querySelector(".cwd-newrow .primary") as HTMLButtonElement;
		act(() => {
			createBtn.click();
		});

		expect(onCreateProject).toHaveBeenCalledWith("E:/t/c");
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("DirectoryBrowser: 在 MACHINE_ROOT 机器根下新建按钮应为 aria-disabled 且有原因提示", () => {
		function TestPicker() {
			return createElement(
				LanguageProvider,
				null,
				createElement(DirectoryBrowser, {
					currentCwd: MACHINE_ROOT,
					pathCompletions: [],
					workspaceRoots: [],
					mode: "project",
					onClose: vi.fn(),
					onSelectDirectory: vi.fn(),
				}),
			);
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestPicker));
		});

		const newBtn = document.body.querySelector(".cwd-toolbar .tool-new") as HTMLButtonElement;
		expect(newBtn).toBeTruthy();
		expect(newBtn.getAttribute("aria-disabled")).toBe("true");
		act(() => {
			newBtn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
		});
		const bubble = document.body.querySelector(".set-tip-bubble.open");
		expect(bubble).toBeTruthy();
		act(() => {
			newBtn.click();
		});
		expect(document.body.querySelector(".cwd-newrow input")).toBeNull();
	});

	it("CanvasStudio: 节点通过 ProjectPicker '创建并打开' 时应向服务端发送 make_dir 消息", () => {
		const sentMessages: any[] = [];
		const mockSend = vi.fn((msg) => {
			sentMessages.push(msg);
		});

		function TestCanvas() {
			return createElement(
				LanguageProvider,
				null,
				createElement(CanvasStudio, {
					send: mockSend,
					currentCwd: "E:/t",
				}),
			);
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestCanvas));
		});

		const addFirst = Array.from(document.body.querySelectorAll("button")).find((b) =>
			b.textContent?.includes(en["canvas.studio.addFirstTeammate"]),
		);
		expect(addFirst).toBeTruthy();
		act(() => {
			addFirst!.click();
		});
		const browseBtns = document.body.querySelectorAll(".universal-path-browse-btn");
		expect(browseBtns.length).toBeGreaterThan(0);

		act(() => {
			(browseBtns[0] as HTMLButtonElement).click();
		});

		const picker = document.body.querySelector(".project-picker");
		expect(picker).toBeTruthy();

		const newBtn = document.body.querySelector(".cwd-toolbar .tool-new") as HTMLButtonElement;
		expect(newBtn).toBeTruthy();
		act(() => {
			newBtn.click();
		});

		const input = document.body.querySelector(".cwd-newrow input") as HTMLInputElement;
		expect(input).toBeTruthy();
		act(() => {
			const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
			nativeInputValueSetter?.call(input, "c");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});

		const createBtn = document.body.querySelector(".cwd-newrow .primary") as HTMLButtonElement;
		expect(createBtn).toBeTruthy();
		act(() => {
			createBtn.click();
		});

		const makeDirMsg = sentMessages.find((m) => m.type === "make_dir");
		expect(makeDirMsg).toBeTruthy();
		expect(makeDirMsg.path).toBe("E:/t/c");
	});

	it("DirectoryBrowser: 常用跳转行按快照渲染 此电脑/用户/桌面，点击跳转到对应目录", () => {
		setAppGlobals({ homeDir: "C:/Users/test", desktopDir: "C:/Users/test/Desktop" });
		setAppSend(() => true);
		try {
			function TestJumps() {
				return createElement(
					LanguageProvider,
					null,
					createElement(DirectoryBrowser, {
						currentCwd: "C:/Users/test/Documents",
						pathCompletions: [],
						workspaceRoots: [],
						onClose: () => {},
						onSelectDirectory: () => {},
					}),
				);
			}

			const container = document.createElement("div");
			document.body.appendChild(container);
			root = createRoot(container);

			act(() => {
				root!.render(createElement(TestJumps));
			});

			const jumps = document.body.querySelectorAll(".cwd-toolbar .cwd-jump");
			expect(jumps.length).toBe(7);
			expect((jumps[1] as HTMLButtonElement).textContent).toBe("");

			act(() => {
				(jumps[1] as HTMLButtonElement).click();
			});
			const input = document.body.querySelector(".cwd-picker-row .cwd-picker-input") as HTMLInputElement;
			expect(input).toBeTruthy();
			expect(input.value).toBe("C:/Users/test");
			expect((jumps[1] as HTMLButtonElement).classList.contains("active")).toBe(true);

			act(() => {
				(jumps[1] as HTMLButtonElement).dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
			});
			const bubble = document.body.querySelector(".set-tip-bubble.open");
			expect(bubble).toBeTruthy();
			expect(bubble!.textContent).toContain("C:/Users/test");

			const upRow = Array.from(document.body.querySelectorAll(".cwd-list .cwd-item .cwd-name")).find(
				(el) => el.textContent === "..",
			);
			expect(upRow).toBeTruthy();
			act(() => {
				(upRow!.closest(".cwd-item")!.querySelector("button") as HTMLButtonElement).click();
			});
			expect(input.value).toBe("C:/Users");
		} finally {
			resetAppGlobals();
			setAppSend(null);
		}
	});
});
