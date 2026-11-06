import { describe, expect, it } from "vitest";
import {
	DEFAULT_WALLPAPER_SETTINGS,
	cssEscapeUrl,
	normalizeWallpaperSettings,
	sanitizeWallpaperUrl,
} from "../../web/src/wallpaper.js";

describe("sanitizeWallpaperUrl", () => {
	it("放行 http(s) / blob / data:image / 站内相对路径", () => {
		expect(sanitizeWallpaperUrl("https://example.com/a.png")).toBe("https://example.com/a.png");
		expect(sanitizeWallpaperUrl("http://127.0.0.1:8787/uploads/x.jpg")).toBe("http://127.0.0.1:8787/uploads/x.jpg");
		expect(sanitizeWallpaperUrl("blob:https://x/uuid")).toBe("blob:https://x/uuid");
		expect(sanitizeWallpaperUrl("data:image/png;base64,iVBOR")).toBe("data:image/png;base64,iVBOR");
		expect(sanitizeWallpaperUrl("/uploads/x.jpg")).toBe("/uploads/x.jpg");
	});

	it("拦截伪协议与危险地址", () => {
		expect(sanitizeWallpaperUrl("javascript:alert(1)")).toBe("");
		expect(sanitizeWallpaperUrl("data:text/html,<h1>x</h1>")).toBe("");
		expect(sanitizeWallpaperUrl("vbscript:msgbox(1)")).toBe("");
		expect(sanitizeWallpaperUrl("//evil.com/x.png")).toBe("");
		expect(sanitizeWallpaperUrl("")).toBe("");
		expect(sanitizeWallpaperUrl(null)).toBe("");
		expect(sanitizeWallpaperUrl(123)).toBe("");
	});

	it("首尾空白容忍、超长拒绝", () => {
		expect(sanitizeWallpaperUrl("  https://example.com/a.png  ")).toBe("https://example.com/a.png");
		expect(sanitizeWallpaperUrl(`https://example.com/${"a".repeat(3000)}`)).toBe("");
	});
});

describe("normalizeWallpaperSettings", () => {
	it("非对象回退默认", () => {
		expect(normalizeWallpaperSettings(null)).toEqual(DEFAULT_WALLPAPER_SETTINGS);
		expect(normalizeWallpaperSettings(undefined)).toEqual(DEFAULT_WALLPAPER_SETTINGS);
		expect(normalizeWallpaperSettings("x")).toEqual(DEFAULT_WALLPAPER_SETTINGS);
	});

	it("合法值保留（dim/blur 取整 + 钳制）", () => {
		expect(normalizeWallpaperSettings({ url: "https://e.com/a.png", dim: 50, blur: 4 })).toEqual({
			url: "https://e.com/a.png",
			dim: 50,
			blur: 4,
		});
		expect(normalizeWallpaperSettings({ url: "", dim: 99, blur: -3 })).toEqual({ url: "", dim: 95, blur: 0 });
		expect(normalizeWallpaperSettings({ url: "", dim: 12.6, blur: 2.4 })).toEqual({ url: "", dim: 13, blur: 2 });
	});

	it("坏地址按空处理、坏数字回退默认", () => {
		expect(normalizeWallpaperSettings({ url: "javascript:alert(1)", dim: 10, blur: 0 })).toEqual({
			url: "",
			dim: 10,
			blur: 0,
		});
		expect(normalizeWallpaperSettings({ url: "", dim: "high", blur: NaN })).toEqual({
			...DEFAULT_WALLPAPER_SETTINGS,
		});
		expect(normalizeWallpaperSettings({})).toEqual(DEFAULT_WALLPAPER_SETTINGS);
	});
});

describe("sanitizeWallpaperUrl 长度上限", () => {
	it("http(s) 超长拒绝，data:image 放宽到 MB 级", () => {
		expect(sanitizeWallpaperUrl(`https://example.com/${"a".repeat(3000)}`)).toBe("");
		const big = `data:image/jpeg;base64,${"a".repeat(100000)}`;
		expect(sanitizeWallpaperUrl(big)).toBe(big);
		const huge = `data:image/jpeg;base64,${"a".repeat(3000000)}`;
		expect(sanitizeWallpaperUrl(huge)).toBe("");
	});
	it("data: 非图片类型不放行", () => {
		expect(sanitizeWallpaperUrl("data:text/html,<h1>x</h1>")).toBe("");
	});
});

describe("cssEscapeUrl", () => {
	it("转义引号/反斜杠/换行", () => {
		expect(cssEscapeUrl('a"b\\c')).toBe('a\\"b\\\\c');
		expect(cssEscapeUrl("a\nb\rc")).toBe("abc");
		expect(cssEscapeUrl("https://e.com/a.png")).toBe("https://e.com/a.png");
	});
});
