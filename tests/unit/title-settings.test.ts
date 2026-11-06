import { describe, expect, it } from "vitest";
import { DEFAULT_TITLE_SETTINGS, normalizeTitleSettings, projectNameFromCwd } from "../../web/src/title-settings.js";

describe("normalizeTitleSettings", () => {
	it("非对象回退默认（默认开启）", () => {
		expect(normalizeTitleSettings(null)).toEqual(DEFAULT_TITLE_SETTINGS);
		expect(normalizeTitleSettings(undefined)).toEqual(DEFAULT_TITLE_SETTINGS);
		expect(normalizeTitleSettings("yes")).toEqual(DEFAULT_TITLE_SETTINGS);
		expect(normalizeTitleSettings(1)).toEqual(DEFAULT_TITLE_SETTINGS);
	});

	it("保留合法的布尔值", () => {
		expect(normalizeTitleSettings({ projectName: true })).toEqual({ projectName: true });
		expect(normalizeTitleSettings({ projectName: false })).toEqual({ projectName: false });
	});

	it("字段类型错误/缺失回退默认", () => {
		expect(normalizeTitleSettings({ projectName: "yes" })).toEqual(DEFAULT_TITLE_SETTINGS);
		expect(normalizeTitleSettings({})).toEqual(DEFAULT_TITLE_SETTINGS);
		expect(normalizeTitleSettings({ other: true })).toEqual(DEFAULT_TITLE_SETTINGS);
	});
});

describe("projectNameFromCwd", () => {
	it("取末级目录名", () => {
		expect(projectNameFromCwd("/Users/me/code/pi-web-ui")).toBe("pi-web-ui");
		expect(projectNameFromCwd("C:\\work\\pi-web-ui")).toBe("pi-web-ui");
	});

	it("容忍尾随分隔符", () => {
		expect(projectNameFromCwd("/Users/me/code/pi-web-ui/")).toBe("pi-web-ui");
		expect(projectNameFromCwd("C:\\work\\pi-web-ui\\\\")).toBe("pi-web-ui");
	});

	it("空串 / 根目录返回空", () => {
		expect(projectNameFromCwd("")).toBe("");
		expect(projectNameFromCwd("/")).toBe("");
	});
});
