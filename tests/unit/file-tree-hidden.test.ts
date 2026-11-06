import { describe, expect, it } from "vitest";
import { isHiddenEntryName, visibleTreeEntries } from "../../web/src/file-tree-hidden.js";

describe("file tree hidden entries (web/src/file-tree-hidden.ts)", () => {
	it("以 . 开头即隐藏；`..` 与普通名字不算", () => {
		expect(isHiddenEntryName(".bashrc")).toBe(true);
		expect(isHiddenEntryName(".git")).toBe(true);
		expect(isHiddenEntryName(".pi-web")).toBe(true);
		expect(isHiddenEntryName("README.md")).toBe(false);
		expect(isHiddenEntryName("src")).toBe(false);
		expect(isHiddenEntryName("..")).toBe(false);
		expect(isHiddenEntryName("")).toBe(false);
	});

	it("visibleTreeEntries 按开关过滤，顺序不变、不动入参", () => {
		const entries = [{ name: ".env" }, { name: "src" }, { name: ".git" }, { name: "a.md" }];

		expect(visibleTreeEntries(entries, false).map((e) => e.name)).toEqual(["src", "a.md"]);
		expect(visibleTreeEntries(entries, true).map((e) => e.name)).toEqual([".env", "src", ".git", "a.md"]);
		expect(entries.map((e) => e.name)).toEqual([".env", "src", ".git", "a.md"]);
	});

	it("显示时返回原数组引用（不额外分配）", () => {
		const entries = [{ name: "src" }];
		expect(visibleTreeEntries(entries, true)).toBe(entries);
	});
});
