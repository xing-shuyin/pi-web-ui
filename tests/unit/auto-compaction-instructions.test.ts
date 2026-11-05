import { describe, expect, it } from "vitest";
import { normalizeAutoCompactionInstructions } from "../../server/soft-cap.js";
import { PRESET_FIELD_GROUPS, PRESET_FIELD_META } from "../../server/preset-fields.js";

describe("normalizeAutoCompactionInstructions", () => {
	it("非字符串输入归一化为空串（不传指令，保持 SDK 默认摘要）", () => {
		expect(normalizeAutoCompactionInstructions(undefined)).toBe("");
		expect(normalizeAutoCompactionInstructions(null)).toBe("");
		expect(normalizeAutoCompactionInstructions(123)).toBe("");
		expect(normalizeAutoCompactionInstructions({ a: 1 })).toBe("");
		expect(normalizeAutoCompactionInstructions(["x"])).toBe("");
	});

	it("字符串原样返回，并截断到 2000 字符上限", () => {
		expect(normalizeAutoCompactionInstructions("")).toBe("");
		expect(normalizeAutoCompactionInstructions("[[custom-compact:v3:local]]")).toBe("[[custom-compact:v3:local]]");
		const long = "x".repeat(5000);
		expect(normalizeAutoCompactionInstructions(long)).toHaveLength(2000);
	});
});

describe("自动压缩指令可随预设分享", () => {
	it("白名单（按字段白名单净化预设时不会被丢掉）", () => {
		const all = Object.values(PRESET_FIELD_GROUPS).flat() as string[];
		expect(all).toContain("autoCompactionInstructions");
	});

	it("字段元数据齐全（预设编辑/分享 UI 需要中英标签）", () => {
		const meta = (PRESET_FIELD_META as Record<string, { labelZh?: string; labelEn?: string }>)[
			"autoCompactionInstructions"
		];
		expect(meta?.labelZh).toBeTruthy();
		expect(meta?.labelEn).toBeTruthy();
	});
});
