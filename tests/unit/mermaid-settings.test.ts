/**
 * Mermaid 渲染开关设置规整单测（见 web/src/mermaid-settings.ts）。
 * 仅测纯函数 normalizeMermaidSettings —— localStorage 存取在 node 环境不可用，
 * load/save 都有 try/catch 兜底，不在单测范围内。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_MERMAID_SETTINGS, normalizeMermaidSettings } from "../../web/src/mermaid-settings.js";

describe("normalizeMermaidSettings", () => {
	it("非对象回退默认（默认开启）", () => {
		expect(normalizeMermaidSettings(null)).toEqual(DEFAULT_MERMAID_SETTINGS);
		expect(normalizeMermaidSettings(undefined)).toEqual(DEFAULT_MERMAID_SETTINGS);
		expect(normalizeMermaidSettings("yes")).toEqual(DEFAULT_MERMAID_SETTINGS);
		expect(normalizeMermaidSettings(1)).toEqual(DEFAULT_MERMAID_SETTINGS);
	});

	it("保留合法的布尔值", () => {
		expect(normalizeMermaidSettings({ enabled: true })).toEqual({ enabled: true });
		expect(normalizeMermaidSettings({ enabled: false })).toEqual({ enabled: false });
	});

	it("字段类型错误/缺失回退默认", () => {
		expect(normalizeMermaidSettings({ enabled: "yes" })).toEqual(DEFAULT_MERMAID_SETTINGS);
		expect(normalizeMermaidSettings({ enabled: 1 })).toEqual(DEFAULT_MERMAID_SETTINGS);
		expect(normalizeMermaidSettings({})).toEqual(DEFAULT_MERMAID_SETTINGS);
		expect(normalizeMermaidSettings({ other: false })).toEqual(DEFAULT_MERMAID_SETTINGS);
	});
});
