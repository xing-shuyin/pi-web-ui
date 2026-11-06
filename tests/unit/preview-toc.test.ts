import { describe, expect, it } from "vitest";
import { assignHeadingIds, shouldShowToc, slugifyHeading } from "../../web/src/preview-toc.js";

describe("preview-toc（预览面板标题导航的纯函数）", () => {
	it("slugifyHeading：中文原样、空白转连字符、符号压掉、空白标题回落 section", () => {
		expect(slugifyHeading("中文小节：成本与峰谷")).toBe("中文小节-成本与峰谷");
		expect(slugifyHeading("Hello World!")).toBe("Hello-World");
		expect(slugifyHeading("  a   b  ")).toBe("a-b");
		expect(slugifyHeading("///")).toBe("section");
		expect(slugifyHeading("")).toBe("section");
		expect(slugifyHeading("中".repeat(120)).length).toBe(80);
	});

	it("assignHeadingIds：按顺序去重（-2/-3）并保留层级", () => {
		const heads = assignHeadingIds([
			{ level: 1, label: "标题一" },
			{ level: 2, label: "重复" },
			{ level: 3, label: "重复" },
			{ level: 2, label: "重复" },
		]);
		expect(heads.map((h) => h.id)).toEqual(["标题一", "重复", "重复-2", "重复-3"]);
		expect(heads.map((h) => h.level)).toEqual([1, 2, 3, 2]);
	});

	it("assignHeadingIds：压缩空白；只有图片/行内标签的标题回落成「未命名章节」", () => {
		const heads = assignHeadingIds([
			{ level: 2, label: "  很   多   空格  " },
			{ level: 2, label: "" },
			{ level: 2, label: "   " },
		]);
		expect(heads[0].label).toBe("很 多 空格");
		expect(heads[1].label).toBe("未命名章节");
		expect(heads[1].id).toBe("未命名章节");
		expect(heads[2].id).toBe("未命名章节-2");
	});

	it("shouldShowToc：标题不足 2 个不配目录", () => {
		expect(shouldShowToc([])).toBe(false);
		expect(shouldShowToc([{ level: 1, id: "a", label: "A" }])).toBe(false);
		expect(
			shouldShowToc([
				{ level: 1, id: "a", label: "A" },
				{ level: 2, id: "b", label: "B" },
			]),
		).toBe(true);
	});
});
