import { describe, expect, it } from "vitest";
import {
	DEFAULT_FAVICON_COLOR,
	DEFAULT_FAVICON_SETTINGS,
	PRESET_FAVICON_COLORS,
	generateFaviconSvg,
	hashStringToColor,
	isLightColor,
	normalizeFaviconSettings,
	resolveFaviconColor,
	resolveInstanceName,
	sanitizeHexColor,
} from "../../web/src/favicon-settings.js";

describe("favicon-settings", () => {
	describe("sanitizeHexColor", () => {
		it("规范化 6 位 hex", () => {
			expect(sanitizeHexColor("#10b981")).toBe("#10b981");
			expect(sanitizeHexColor("3b82f6")).toBe("#3b82f6");
			expect(sanitizeHexColor("  #FFFFFF  ")).toBe("#ffffff");
		});

		it("扩展 3 位简写 hex", () => {
			expect(sanitizeHexColor("#fff")).toBe("#ffffff");
			expect(sanitizeHexColor("f00")).toBe("#ff0000");
		});

		it("非法 hex 返回 null", () => {
			expect(sanitizeHexColor("")).toBeNull();
			expect(sanitizeHexColor("not-a-color")).toBeNull();
			expect(sanitizeHexColor("#12345")).toBeNull();
			expect(sanitizeHexColor(undefined)).toBeNull();
		});
	});

	describe("normalizeFaviconSettings", () => {
		it("非对象回退默认配置", () => {
			expect(normalizeFaviconSettings(null)).toEqual(DEFAULT_FAVICON_SETTINGS);
			expect(normalizeFaviconSettings(undefined)).toEqual(DEFAULT_FAVICON_SETTINGS);
			expect(normalizeFaviconSettings("color")).toEqual(DEFAULT_FAVICON_SETTINGS);
			expect(normalizeFaviconSettings(123)).toEqual(DEFAULT_FAVICON_SETTINGS);
		});

		it("规整有效字段并去除首尾空白", () => {
			expect(
				normalizeFaviconSettings({
					color: " blue ",
					customHex: " #10b981 ",
					instanceName: " Dev-Server ",
				}),
			).toEqual({
				color: "blue",
				customHex: "#10b981",
				instanceName: "Dev-Server",
			});
		});

		it("字段缺失时填补默认值", () => {
			expect(normalizeFaviconSettings({})).toEqual(DEFAULT_FAVICON_SETTINGS);
		});
	});

	describe("hashStringToColor", () => {
		it("空串返回默认颜色", () => {
			expect(hashStringToColor("")).toBe(DEFAULT_FAVICON_COLOR);
		});

		it("相同输入产生一致的输出", () => {
			const c1 = hashStringToColor("192.168.1.10:8787");
			const c2 = hashStringToColor("192.168.1.10:8787");
			expect(c1).toBe(c2);
		});

		it("不同主机名可能分散命中调色板", () => {
			const colors = new Set([
				hashStringToColor("host-alpha"),
				hashStringToColor("host-beta"),
				hashStringToColor("host-gamma"),
				hashStringToColor("10.0.0.1"),
				hashStringToColor("10.0.0.2"),
				hashStringToColor("devbox.local"),
			]);
			expect(colors.size).toBeGreaterThan(1);
		});
	});

	describe("isLightColor", () => {
		it("深色背景识别", () => {
			expect(isLightColor("#000000")).toBe(false);
			expect(isLightColor("#8b5cf6")).toBe(false);
			expect(isLightColor("#1e1e2e")).toBe(false);
			expect(isLightColor("#10b981")).toBe(false);
		});

		it("浅色高亮背景识别", () => {
			expect(isLightColor("#ffffff")).toBe(true);
			expect(isLightColor("#ffff00")).toBe(true);
			expect(isLightColor("#fef08a")).toBe(true);
		});
	});

	describe("generateFaviconSvg", () => {
		it("包含背景矩形与正确的 fill 属性", () => {
			const svg = generateFaviconSvg("#3b82f6");
			expect(svg).toContain('<rect width="64" height="64" rx="14" fill="#3b82f6"/>');
			expect(svg).toContain('fill="#ffffff"');
		});

		it("浅色背景下文字自动转深色保持对比度", () => {
			const svg = generateFaviconSvg("#ffffff");
			expect(svg).toContain('fill="#1e1e2e"');
		});
	});

	describe("resolveFaviconColor", () => {
		it("默认态返回默认紫色", () => {
			expect(resolveFaviconColor({ color: "default" })).toBe(DEFAULT_FAVICON_COLOR);
		});

		it("auto 模式下根据主机名解析", () => {
			const color = resolveFaviconColor({ color: "auto" }, "my-server.lan");
			expect(PRESET_FAVICON_COLORS.some((p) => p.hex === color)).toBe(true);
		});

		it("选择预设颜色 id 时返回对应 hex", () => {
			expect(resolveFaviconColor({ color: "emerald" })).toBe("#10b981");
			expect(resolveFaviconColor({ color: "rose" })).toBe("#ef4444");
		});

		it("custom 模式下使用合法的 customHex", () => {
			expect(
				resolveFaviconColor({
					color: "custom",
					customHex: "#ff00aa",
				}),
			).toBe("#ff00aa");
		});

		it("default 态若有服务端环境变量则使用服务端配置", () => {
			expect(resolveFaviconColor({ color: "default" }, "localhost", "blue")).toBe("#3b82f6");
			expect(resolveFaviconColor({ color: "default" }, "localhost", "#abcdef")).toBe("#abcdef");
		});

		it("用户显式指定了预设颜色时优先于服务端配置", () => {
			expect(resolveFaviconColor({ color: "emerald" }, "localhost", "blue")).toBe("#10b981");
		});
	});

	describe("resolveInstanceName", () => {
		it("优先使用用户本地配置的实例名", () => {
			expect(resolveInstanceName({ color: "default", instanceName: "My-Box" }, "Server-Default")).toBe("My-Box");
		});

		it("用户未配置时回退服务端配置", () => {
			expect(resolveInstanceName({ color: "default" }, "Server-Env")).toBe("Server-Env");
		});

		it("均未配置返回空串", () => {
			expect(resolveInstanceName({ color: "default" })).toBe("");
		});
	});
});
