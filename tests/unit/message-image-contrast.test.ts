/**
 * 长图导出对比度：半透明 / color-mix 必须拍成不透明 rgb，
 * 绝不能把 color-mix 字符串交给 canvas fillStyle（会变成黑底）。
 */
import { describe, expect, it } from "vitest";
import {
	EXPORT_CHROME_SELECTOR,
	flattenOnto,
	formatRgb,
	isLightColor,
	opaqueCss,
	parseCssColor,
	relativeLuminance,
} from "../../web/src/message-image.js";

describe("parseCssColor", () => {
	it("parses hex / rgb / rgba / modern rgb", () => {
		expect(parseCssColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
		expect(parseCssColor("#fffdf6")).toEqual({ r: 255, g: 253, b: 246, a: 1 });
		expect(parseCssColor("rgb(255, 253, 246)")).toEqual({ r: 255, g: 253, b: 246, a: 1 });
		expect(parseCssColor("rgba(139, 92, 246, 0.14)")).toEqual({ r: 139, g: 92, b: 246, a: 0.14 });
		expect(parseCssColor("rgb(139 92 246 / 14%)")).toEqual({ r: 139, g: 92, b: 246, a: 0.14 });
		expect(parseCssColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
	});

	it("rejects color-mix and CSS variables (must not reach canvas fillStyle)", () => {
		expect(parseCssColor("color-mix(in srgb, var(--bg-elev) 62%, transparent)")).toBeNull();
		expect(parseCssColor("var(--card-bg)")).toBeNull();
		expect(parseCssColor("oklch(0.9 0.02 80)")).toBeNull();
	});
});

describe("flattenOnto / opaqueCss", () => {
	it("浅色纸上的淡紫气泡拍扁后仍是浅色（不是叠到黑底上的深紫）", () => {
		const paper = { r: 255, g: 253, b: 246, a: 1 };
		const bubble = { r: 139, g: 92, b: 246, a: 0.14 };
		const flat = flattenOnto(bubble, paper);
		expect(isLightColor(flat)).toBe(true);
		expect(relativeLuminance(flat)).toBeGreaterThan(0.7);
		// 叠到黑底才会变暗——那是 bug 形态，这里断言我们没有那么做
		const onBlack = flattenOnto(bubble, { r: 0, g: 0, b: 0, a: 1 });
		expect(relativeLuminance(onBlack)).toBeLessThan(relativeLuminance(flat));
	});

	it("opaqueCss 永不返回 color-mix，解析失败则回落实底", () => {
		const out = opaqueCss("color-mix(in srgb, red 50%, transparent)", "rgb(255, 255, 255)");
		expect(out).toBe("rgb(255, 255, 255)");
		expect(out.startsWith("rgb(")).toBe(true);
		expect(opaqueCss("rgba(139, 92, 246, 0.14)", "#fffdf6")).toMatch(/^rgb\(/);
		expect(parseCssColor(opaqueCss("rgba(139, 92, 246, 0.14)", "#fffdf6"))?.a).toBe(1);
	});

	it("全透明颜色回落 backdrop，不把画布涂黑", () => {
		expect(opaqueCss("transparent", "#fffdf6")).toBe(formatRgb({ r: 255, g: 253, b: 246, a: 1 }));
		expect(opaqueCss("rgba(0, 0, 0, 0)", "rgb(255, 255, 255)")).toBe("rgb(255, 255, 255)");
	});
});

describe("export chrome selector", () => {
	it("covers the live-UI chrome that must not appear in the PNG", () => {
		for (const cls of [
			".msg-actions",
			".msg-text-copy",
			".chead-copy",
			".stream-cursor",
			".msg-editor",
			".msg-export-check",
			".toolcall-kill",
		]) {
			expect(EXPORT_CHROME_SELECTOR).toContain(cls);
		}
	});
});
