import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	isFilePreviewOpen,
	isFilePreviewReady,
	openFilePreview,
	registerFilePreviewHost,
	resetFilePreviewHost,
} from "../../web/src/file-preview-bridge.js";

beforeEach(() => {
	resetFilePreviewHost();
});

describe("file-preview-bridge", () => {
	it("没有宿主时不受理", () => {
		expect(isFilePreviewReady()).toBe(false);
		expect(openFilePreview({ path: "a.png", name: "a.png" })).toBe(false);
	});

	it("注册后把文件转给宿主", () => {
		const open = vi.fn();
		registerFilePreviewHost({ open });
		expect(isFilePreviewReady()).toBe(true);
		expect(openFilePreview({ path: "docs/a.png", name: "a.png" })).toBe(true);
		expect(open).toHaveBeenCalledWith({ path: "docs/a.png", name: "a.png" });
	});

	it("path 为空时不转（脏数据不当成一次打开）", () => {
		const open = vi.fn();
		registerFilePreviewHost({ open });
		expect(openFilePreview({ path: "", name: "x" })).toBe(false);
		expect(open).not.toHaveBeenCalled();
	});

	it("注销后不再受理", () => {
		const open = vi.fn();
		registerFilePreviewHost({ open });
		registerFilePreviewHost(null);
		expect(openFilePreview({ path: "a.png", name: "a.png" })).toBe(false);
	});

	it("isOpen 透传宿主状态；宿主没给 checker 时为 false", () => {
		registerFilePreviewHost({ open: vi.fn(), isOpen: () => true });
		expect(isFilePreviewOpen()).toBe(true);
		registerFilePreviewHost({ open: vi.fn() });
		expect(isFilePreviewOpen()).toBe(false);
	});

	it("后注册的覆盖先前的（重复挂载不留旧 sink）", () => {
		const first = vi.fn();
		const second = vi.fn();
		registerFilePreviewHost({ open: first });
		registerFilePreviewHost({ open: second });
		openFilePreview({ path: "a.png", name: "a.png" });
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
	});
});
