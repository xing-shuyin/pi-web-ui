import { describe, expect, it } from "vitest";
import { applySoftEdits, oldTextCores } from "../../server/edit-soft-tool.js";

function run(content: string, edits: { oldText: string; newText: string }[], path = "a.js") {
	return applySoftEdits(content, edits, path);
}

describe("edit_soft applySoftEdits", () => {
	it("精确子串匹配保留周围空白", () => {
		const { newContent } = run("  const x = 1;  \n", [{ oldText: "const x = 1;  ", newText: "const y = 2;  " }]);
		expect(newContent).toBe("  const y = 2;  \n");
	});

	it("宽松单行：行首缩进差异（tab vs 空格）也能命中，整行按 newText 原样写入", () => {
		const { newContent } = run("\tconst x = 1;\n  foo();\n", [{ oldText: "  const x = 1;", newText: "const y = 9;" }]);
		expect(newContent).toBe("const y = 9;\n  foo();\n");
	});

	it("宽松多行块：忽略每行缩进，newText 原样写入", () => {
		const { newContent } = run("    if (a) {\n      b();\n    }\n", [
			{ oldText: "if (a) {\n  b();\n}", newText: "if (a) {\n  bb();\n}" },
		]);
		expect(newContent).toBe("if (a) {\n  bb();\n}\n");
	});

	it("制表符 vs 空格也能命中", () => {
		const { newContent } = run("\t\tfoo();\n", [{ oldText: "  foo();", newText: "bar();" }]);
		expect(newContent).toBe("bar();\n");
	});

	it("找不到时抛出带路径的错误", () => {
		expect(() => run("const x = 1;\n", [{ oldText: "const z = 9;", newText: "z" }])).toThrow(/Could not find the text/);
	});

	it("空 oldText 报错", () => {
		expect(() => run("a;\n", [{ oldText: "", newText: "x" }])).toThrow(/must not be empty/);
	});

	it("多个匹配报错（不唯一）", () => {
		expect(() => run("a;\nb;\na;\n", [{ oldText: "a;", newText: "c;" }])).toThrow(/unique/i);
	});

	it("重叠 edits 报错", () => {
		expect(() =>
			run("const a = 1;\n", [
				{ oldText: "const a = 1;", newText: "x" },
				{ oldText: "a = 1;", newText: "y" },
			]),
		).toThrow(/overlap/);
	});

	it("多 edit 逆序应用，左侧偏移稳定", () => {
		const { newContent } = run("const a = 1;\nconst b = 2;\n", [
			{ oldText: "const a = 1;", newText: "const a = 9;" },
			{ oldText: "const b = 2;", newText: "const b = 8;" },
		]);
		expect(newContent).toBe("const a = 9;\nconst b = 8;\n");
	});

	it("回归：edits 降序给出（后面的区域在前）也不串位", () => {
		const file = "const A = 1; // aaaaaaaaaa\nconst B = 2; // bbbbbb\nconst C = 3; // cccc\n";
		const eA = { oldText: "const A = 1; // aaaaaaaaaa", newText: "const A = 1; // A_EXTENDED_LONG" };
		const eB = { oldText: "const B = 2; // bbbbbb", newText: "const B = 2;" };
		const eC = { oldText: "const C = 3; // cccc", newText: "const C = 3; // Ccccccccccccccccccccc" };
		const expected = "const A = 1; // A_EXTENDED_LONG\nconst B = 2;\nconst C = 3; // Ccccccccccccccccccccc\n";
		for (const order of [
			[eA, eB, eC],
			[eC, eB, eA],
			[eB, eC, eA],
			[eA, eC, eB],
			[eC, eA, eB],
			[eB, eA, eC],
		]) {
			expect(run(file, order).newContent).toBe(expected);
		}
	});

	it("回归：以 } 结尾的多行块降序给出也不串位", () => {
		const file = "if (a) {\n  b();\n}\nmid();\nif (c) {\n  d();\n}\n";
		const { newContent } = run(file, [
			{ oldText: "if (c) {\n  d();\n}", newText: "if (c) {\n  dd();\n}" },
			{ oldText: "if (a) {\n  b();\n}", newText: "if (a) {\n  bb();\n  bb2();\n}" },
		]);
		expect(newContent).toBe("if (a) {\n  bb();\n  bb2();\n}\nmid();\nif (c) {\n  dd();\n}\n");
	});
});

describe("edit_soft 非法片段防御", () => {
	it("跨行未对齐片段被拒绝（不再静默写坏）", () => {
		expect(() => run("foo(a);\nfoo(b);\n", [{ oldText: "a);\nfoo(", newText: "z();" }])).toThrow(/line boundaries/);
		expect(() => run("foo(a);\nb();\n", [{ oldText: "a);\nb();", newText: "z();" }])).toThrow(/line boundaries/);
		expect(() => run("foo(a);\nb();\n", [{ oldText: "foo(a);\nb(", newText: "z();" }])).toThrow(/line boundaries/);
	});

	it("整行对齐的多行块仍正常", () => {
		const { newContent } = run("foo(a);\nb();\n", [{ oldText: "foo(a);\nb();", newText: "foo(z);\nbb();" }]);
		expect(newContent).toBe("foo(z);\nbb();\n");
	});

	it("单行片段仍允许（不影响行结构）", () => {
		const { newContent } = run("if (x) { b(); }\n", [{ oldText: "b();", newText: "c();" }]);
		expect(newContent).toBe("if (x) { c(); }\n");
	});
});

describe("edit_soft oldTextCores", () => {
	it("去掉尾部空行并逐行 trim", () => {
		expect(oldTextCores("  if (a) {\n    b();\n}")).toEqual(["if (a) {", "b();", "}"]);
		expect(oldTextCores("  x = 1;\n")).toEqual(["x = 1;"]);
	});
});
