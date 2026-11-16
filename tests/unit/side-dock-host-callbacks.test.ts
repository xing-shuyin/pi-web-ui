// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { SideDock } from "../../web/src/components/SideDock.js";
import type { BarHostProps } from "../../web/src/components/BarItem.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { UiSlotEntry } from "../../web/src/ui-slots.js";
import type { ChatState } from "../../web/src/use-chat.js";

const APP_TSX = fs.readFileSync(path.join(__dirname, "../../web/src/App.tsx"), "utf8");
const DOCK_TSX = fs.readFileSync(path.join(__dirname, "../../web/src/components/SideDock.tsx"), "utf8");

const chatStub = {
	status: "open",
	ready: true,
	engine: "pi",
	state: { cwd: "/workspace/my-project", isStreaming: false, stats: null, queue: { steering: [], followUp: [] } },
	bgServers: [],
	statuses: [],
	terminals: [],
	update: null,
	updatesAll: [],
} as unknown as ChatState;

function entry(id: string): UiSlotEntry {
	return {
		id,
		slot: "sidebar.left",
		source: "host",
		label: id,
		kind: "action",
		order: 0,
		align: "start",
		hidden: false,
		userOverrides: [],
		arrangedBy: [],
	};
}

function renderDock(items: UiSlotEntry[], barProps: BarHostProps) {
	localStorage.setItem("pi-web-ui:lang", "zh");
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(createElement(LanguageProvider, null, createElement(SideDock, { side: "left", items, barProps })));
	});
	return { container, root };
}

/**
 * 停靠栏宿主回调回归守卫。
 *
 * 背景：宿主按钮通过布局编辑被挪到 `sidebar.left` / `sidebar.right` 后由 `SideDock` 渲染。
 * 旧版 `SideDock` 把 `BarItem` 的 props 逐个手抄，漏了 `onOpenSandboxModal` /
 * `onOpenProjectPicker` —— 按钮画得出来、点了却毫无反应（静默空操作）。
 * 现在改成整份 `BarHostProps` 透传，这里把「不再手抄 + 关键入口真的能点」锁死。
 */
describe("侧栏停靠栏的宿主回调", () => {
	it("BarItem 由整份 barProps 撑起，不再逐个手抄宿主回调", () => {
		expect(DOCK_TSX).toContain("{...barProps}");
		for (const cb of ["onOpenSandboxModal", "onOpenProjectPicker", "termOpen", "gitOpen"]) {
			expect(DOCK_TSX).not.toContain(`${cb}=`);
		}
	});

	it("App 给两侧停靠栏喂同一份 barProps，且里面带齐沙箱 / 打开项目 / 终端高亮", () => {
		expect(APP_TSX).toContain("<SideDock");
		expect(APP_TSX.match(/barProps=\{sidebarBarProps\}/g)?.length).toBe(2);
		const start = APP_TSX.indexOf("const sidebarBarProps: BarHostProps");
		expect(start).toBeGreaterThan(-1);
		const body = APP_TSX.slice(start, APP_TSX.indexOf("\n\t};", start));
		for (const key of [
			"onOpenSandboxModal",
			"onOpenProjectPicker",
			"isProjectPickerOpen",
			"termOpen",
			"gitOpen",
			"onViewChange",
			"onOpenSettings",
		]) {
			expect(body).toContain(key);
		}
	});

	it("项目选择器在 App 里只挂一个实例（顶栏 chip / 停靠栏 / cwd chip 共用）", () => {
		expect(APP_TSX.match(/<ProjectPickerHost/g)?.length).toBe(1);
		// 对话框与 set_cwd / make_dir 载荷只写在宿主组件里，不能再在顶栏 / 停靠栏各自弹一个
		const host = fs.readFileSync(path.join(__dirname, "../../web/src/components/ProjectPickerHost.tsx"), "utf8");
		expect(host).toContain('type: "set_cwd"');
		expect(host).toContain("setAsCwd: true");
		expect(APP_TSX).not.toContain("<ProjectPicker\n");
	});

	it("挪到侧栏的「沙箱」按钮点得动（onOpenSandboxModal）", () => {
		const onOpenSandboxModal = vi.fn();
		const { container, root } = renderDock([entry("host:new-sandbox")], {
			chat: chatStub,
			onOpenSandboxModal,
		});
		try {
			act(() => container.querySelector<HTMLButtonElement>("button")!.click());
			expect(onOpenSandboxModal).toHaveBeenCalledTimes(1);
		} finally {
			act(() => root.unmount());
			container.remove();
		}
	});

	it("挪到侧栏的「打开项目」按钮点得动（onOpenProjectPicker）", () => {
		const onOpenProjectPicker = vi.fn();
		const { container, root } = renderDock([entry("host:open-project")], {
			chat: chatStub,
			onOpenProjectPicker,
		});
		try {
			act(() => container.querySelector<HTMLButtonElement>("button")!.click());
			expect(onOpenProjectPicker).toHaveBeenCalledTimes(1);
		} finally {
			act(() => root.unmount());
			container.remove();
		}
	});
});
