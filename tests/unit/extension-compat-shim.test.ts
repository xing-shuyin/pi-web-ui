import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPAT_SCRIPT } from "../../browser/runtime/extension-compat.js";

/**
 * shim 是写进扩展目录的一段脚本，跑在扩展自己的上下文里。这里用一个假 `chrome` 执行它，
 * 验证「补的缺口」真的按 Chrome 语义工作（而不是只断言字符串里出现了某个名字）。
 */
type FakeChrome = Record<string, any>;

const runShim = (chrome: FakeChrome): FakeChrome => {
	const scope = globalThis as FakeChrome;
	const previousChrome = scope.chrome;
	scope.chrome = chrome;
	try {
		new Function(COMPAT_SCRIPT)();
	} finally {
		scope.chrome = previousChrome;
	}
	return chrome;
};

afterEach(() => {
	vi.restoreAllMocks();
});

const fakeChrome = (): FakeChrome => ({
	windows: {
		// 真实实现（electron-chrome-extensions 的 preload）既支持回调，也返回 Promise
		getAll: (info: unknown, callback?: (wins: unknown[]) => void) => {
			const wins = [{ id: 7 }, { id: 8 }];
			if (typeof info === "function") (info as (wins: unknown[]) => void)(wins);
			else callback?.(wins);
			return Promise.resolve(wins);
		},
	},
	tabs: {
		query: (query: unknown, callback?: (tabs: unknown[]) => void) => {
			const tabs = [
				{ id: 1, windowId: 7 },
				{ id: 2, windowId: 8 },
				{ id: 3, windowId: 7 },
			];
			if (typeof query === "function") (query as (tabs: unknown[]) => void)(tabs);
			else callback?.(tabs);
			return Promise.resolve(tabs);
		},
	},
	storage: { local: { get: () => {}, set: () => {}, onChanged: { addListener: () => {} } } },
});

describe("compat shim: windows.getAll({ populate })", () => {
	it("fills each window's tabs from the real chrome.tabs.query", async () => {
		const chrome = runShim(fakeChrome());
		const result = await new Promise<any[]>((resolve) => {
			chrome.windows.getAll({ populate: true }, (wins: any[]) => resolve(wins));
		});
		expect(result.map((win) => win.tabs.map((tab: any) => tab.id))).toEqual([[1, 3], [2]]);
	});

	it("keeps the promise form and leaves windows untouched without populate", async () => {
		const chrome = runShim(fakeChrome());
		const plain = await chrome.windows.getAll({});
		expect(plain.map((win: any) => win.tabs)).toEqual([undefined, undefined]);
		const populated = await chrome.windows.getAll({ populate: true });
		expect(populated[1].tabs).toEqual([{ id: 2, windowId: 8 }]);
	});
});

describe("compat shim: remaining gaps", () => {
	it("routes storage.sync to storage.local", () => {
		const chrome = fakeChrome();
		const read = vi.fn();
		chrome.storage.local.get = read;
		runShim(chrome);
		chrome.storage.sync.get("compatKey");
		expect(read).toHaveBeenCalledWith("compatKey");
	});

	it("warns once and calls back undefined instead of faking success", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const chrome = runShim(fakeChrome());
		const values: unknown[] = [];
		chrome.tabs.captureVisibleTab({}, (value: unknown) => values.push(value));
		chrome.tabs.captureVisibleTab({}, (value: unknown) => values.push(value));
		expect(values).toEqual(["", ""]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("chrome.tabs.captureVisibleTab");
	});

	it("uses the host bridge for captureVisibleTab when it is available", async () => {
		const scope = globalThis as FakeChrome;
		const captureVisibleTab = vi.fn(async () => "data:image/png;base64,AAAA");
		scope.__piExtensionBridge = { captureVisibleTab };
		try {
			const chrome = runShim(fakeChrome());
			const value = await new Promise((resolve) => chrome.tabs.captureVisibleTab({ format: "png" }, resolve));
			expect(value).toBe("data:image/png;base64,AAAA");
			expect(captureVisibleTab).toHaveBeenCalledWith({ format: "png" });
		} finally {
			delete scope.__piExtensionBridge;
		}
	});
});
