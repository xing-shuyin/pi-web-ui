// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_TERMINAL_DOCK_PREFS,
	matchTerminalShortcut,
	normalizeTerminalDockPrefs,
	readTerminalDockPrefs,
	saveTerminalDockPrefs,
} from "../../web/src/terminal-dock";

afterEach(() => {
	localStorage.clear();
	saveTerminalDockPrefs(DEFAULT_TERMINAL_DOCK_PREFS);
});

describe("终端停靠偏好", () => {
	it("损坏数据回退默认值", () => {
		expect(normalizeTerminalDockPrefs(null)).toEqual(DEFAULT_TERMINAL_DOCK_PREFS);
		expect(normalizeTerminalDockPrefs({ side: "middle", sizes: { bottom: -1 } })).toEqual(
			DEFAULT_TERMINAL_DOCK_PREFS,
		);
	});

	it("迁移旧底部高度并夹取三种停靠尺寸", () => {
		localStorage.setItem("pi-web-ui:term-drawer-h", "412");
		expect(
			normalizeTerminalDockPrefs({
				side: "right",
				open: true,
				collapsed: true,
				sizes: { bottom: 10, left: 300, right: 99_999 },
				activeTab: "plugin:notes",
			}),
		).toEqual({
			version: 1,
			side: "right",
			open: true,
			collapsed: true,
			sizes: { bottom: 412, left: 300, right: 1200 },
			activeTab: "plugin:notes",
		});
	});

	it("保存后读回同一份规范化快照", () => {
		saveTerminalDockPrefs({ side: "left", sizes: { left: 480 } });
		expect(readTerminalDockPrefs()).toMatchObject({
			side: "left",
			sizes: { bottom: DEFAULT_TERMINAL_DOCK_PREFS.sizes.bottom, left: 480 },
		});
	});
});

describe("终端快捷键匹配", () => {
	const base = { key: "", ctrlKey: true };

	it("识别面板开关、新建与标签切换", () => {
		expect(matchTerminalShortcut({ ...base, key: "j" })).toBe("toggle");
		expect(matchTerminalShortcut({ ...base, key: "~", code: "Backquote" })).toBe("toggle");
		expect(matchTerminalShortcut({ ...base, key: "~", code: "Backquote", shiftKey: true })).toBe("new");
		expect(matchTerminalShortcut({ ...base, key: "PageUp" })).toBe("previous");
		expect(matchTerminalShortcut({ ...base, key: "PageDown" })).toBe("next");
		expect(matchTerminalShortcut({ ...base, key: "w" })).toBe("close");
	});

	it("避开组合输入、重复按键和额外修饰键", () => {
		expect(matchTerminalShortcut({ ...base, key: "j", isComposing: true })).toBeNull();
		expect(matchTerminalShortcut({ ...base, key: "j", repeat: true })).toBeNull();
		expect(matchTerminalShortcut({ ...base, key: "j", altKey: true })).toBeNull();
		expect(matchTerminalShortcut({ ...base, key: "j", shiftKey: true })).toBeNull();
		expect(matchTerminalShortcut({ key: "j", ctrlKey: false, metaKey: false })).toBeNull();
	});
});
