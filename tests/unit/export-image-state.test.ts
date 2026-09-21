import { afterEach, describe, expect, it } from "vitest";
import {
	closeExportImage,
	getExportImage,
	openExportImage,
	resetExportImage,
	setExportImageIncludes,
	setExportMessageCatalog,
	sortIdsByCatalog,
	toggleExportImageSelect,
	type ExportableMsg,
} from "../../web/src/export-image-state.js";
import { pickExportPixelRatio } from "../../web/src/message-image.js";

function msg(id: string, role: "user" | "assistant", text: string): ExportableMsg {
	return { id, role, content: [{ type: "text", text }] };
}

const sample: ExportableMsg[] = [
	msg("u1", "user", "hello"),
	msg("a1", "assistant", "hi"),
	msg("u2", "user", "next"),
	msg("a2", "assistant", "ok"),
	msg("u3", "user", "again"),
	msg("a3", "assistant", "done"),
];

afterEach(() => {
	resetExportImage();
});

describe("sortIdsByCatalog", () => {
	it("always returns conversation order (old → new), not click order", () => {
		expect(sortIdsByCatalog(["a3", "u1", "a2"], sample)).toEqual(["u1", "a2", "a3"]);
	});
});

describe("openExportImage", () => {
	it("只勾当前这条，不自动带上提问", () => {
		setExportMessageCatalog(sample);
		openExportImage("a2");
		const st = getExportImage();
		expect(st.open).toBe(true);
		expect(st.triggerId).toBe("a2");
		expect(st.selectedIds).toEqual(["a2"]);
		expect(st.includeTools).toBe(false);
		expect(st.includeThinking).toBe(false);
	});

	it("include 开关默认关，打开后可改，关闭面板复位", () => {
		setExportMessageCatalog(sample);
		openExportImage("a2");
		setExportImageIncludes({ includeTools: true, includeThinking: true });
		expect(getExportImage().includeTools).toBe(true);
		expect(getExportImage().includeThinking).toBe(true);
		closeExportImage();
		openExportImage("a2");
		expect(getExportImage().includeTools).toBe(false);
		expect(getExportImage().includeThinking).toBe(false);
	});

	it("后勾更早的消息会插到时间线前面，而不是追加到图底", () => {
		setExportMessageCatalog(sample);
		openExportImage("a3");
		toggleExportImageSelect("u1");
		openExportImage("a2");
		expect(getExportImage().selectedIds).toEqual(["u1", "a2", "a3"]);
	});
});

describe("toggleExportImageSelect", () => {
	it("普通点击切换选中，加入时按时间线插入", () => {
		setExportMessageCatalog(sample);
		openExportImage("a3");
		toggleExportImageSelect("u2");
		expect(getExportImage().selectedIds).toEqual(["u2", "a3"]);
		toggleExportImageSelect("u2");
		expect(getExportImage().selectedIds).toEqual(["a3"]);
	});
});

describe("closeExportImage", () => {
	it("clears selection", () => {
		setExportMessageCatalog(sample);
		openExportImage("a2");
		closeExportImage();
		expect(getExportImage().open).toBe(false);
		expect(getExportImage().selectedIds).toEqual([]);
	});
});

describe("pickExportPixelRatio", () => {
	it("short cards stay 2x; huge cards drop to 1x then 0", () => {
		expect(pickExportPixelRatio(800, 640)).toBe(2);
		expect(pickExportPixelRatio(9000, 800)).toBe(1);
		expect(pickExportPixelRatio(20000, 800)).toBe(0);
	});
});
