import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeEditToolDefinition, prepareEditArguments } from "../../server/edit-tool.js";

const dirs: string[] = [];
function directory(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-edit-tool-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function call(
	tool: ReturnType<typeof makeEditToolDefinition>,
	cwd: string,
	params: Record<string, unknown>,
): Promise<{ isError?: boolean; content?: unknown; details?: unknown }> {
	try {
		const result = await tool.execute("call", params as never, undefined, undefined, { cwd } as never);
		return result as { isError?: boolean; content?: unknown; details?: unknown };
	} catch (error) {
		return { isError: true, content: [{ type: "text", text: (error as Error).message }] } as never;
	}
}

describe("edit 工具（soft 已并入同一个参数）", () => {
	it("注册名仍是 edit，参数多一个 soft，提示词只有一份", () => {
		const tool = makeEditToolDefinition(process.cwd());
		expect(tool.name).toBe("edit");
		const schema = tool.parameters as { properties: Record<string, unknown> };
		expect(Object.keys(schema.properties).sort()).toEqual(["edits", "path", "soft"]);
		expect(tool.description).not.toMatch(/[\u4e00-\u9fff]/);
		// soft 的语义归它自己的参数说明与 guideline，description 只管一句话。
		expect(String((schema.properties.soft as { description?: string }).description)).toContain("indentation");
		expect(tool.description).not.toContain("soft");
		expect(tool.promptSnippet?.length).toBeLessThanOrEqual(80);
		expect(tool.promptGuidelines?.some((g) => g.includes("soft=true"))).toBe(true);
	});

	it("不给 soft 时走内置精确替换：每行缩进不一致就报错且不改文件", async () => {
		const dir = directory();
		const file = join(dir, "a.ts");
		writeFileSync(file, "    if (a) {\n      b();\n    }\n", "utf8");
		const tool = makeEditToolDefinition(dir);
		const res = await call(tool, dir, {
			path: "a.ts",
			edits: [{ oldText: "if (a) {\n  b();\n}", newText: "if (a) {\n  bb();\n}" }],
		});
		expect(res.isError).toBe(true);
		expect(readFileSync(file, "utf8")).toBe("    if (a) {\n      b();\n    }\n");
	});

	it("给 soft: true 时忽略每行行首缩进，整块按 newText 写入", async () => {
		const dir = directory();
		const file = join(dir, "a.ts");
		writeFileSync(file, "    if (a) {\n      b();\n    }\n", "utf8");
		const tool = makeEditToolDefinition(dir);
		const res = await call(tool, dir, {
			path: "a.ts",
			edits: [{ oldText: "if (a) {\n  b();\n}", newText: "if (a) {\n  bb();\n}" }],
			soft: true,
		});
		expect(res.isError).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe("if (a) {\n  bb();\n}\n");
		expect(JSON.stringify(res.details)).toContain("bb();");
	});

	it("soft: true 仍优先精确匹配（不破坏原有缩进）", async () => {
		const dir = directory();
		const file = join(dir, "a.ts");
		writeFileSync(file, "key: 'a',\n", "utf8");
		const tool = makeEditToolDefinition(dir);
		await call(tool, dir, { path: "a.ts", edits: [{ oldText: "'a'", newText: "'b'" }], soft: true });
		expect(readFileSync(file, "utf8")).toBe("key: 'b',\n");
	});

	it("soft: true 要求整行对齐：跨行片段会被拒绝而不是写坏文件", async () => {
		const dir = directory();
		const file = join(dir, "a.ts");
		writeFileSync(file, "foo(a);\nb();\n", "utf8");
		const tool = makeEditToolDefinition(dir);
		const res = await call(tool, dir, { path: "a.ts", edits: [{ oldText: "a);\nb(", newText: "z();" }], soft: true });
		expect(res.isError).toBe(true);
		expect(readFileSync(file, "utf8")).toBe("foo(a);\nb();\n");
	});

	it("兼容模型给出的旧参数形状（edits 为 JSON 字符串 / 单个对象 / 扁平 oldText+newText）", () => {
		const asString = prepareEditArguments({ path: "a.ts", edits: JSON.stringify([{ oldText: "a", newText: "b" }]) });
		expect(asString.edits).toEqual([{ oldText: "a", newText: "b" }]);
		const single = prepareEditArguments({ path: "a.ts", edits: { oldText: "a", newText: "b" } });
		expect(single.edits).toEqual([{ oldText: "a", newText: "b" }]);
		const flat = prepareEditArguments({ path: "a.ts", oldText: "a", newText: "b" });
		expect(flat.edits).toEqual([{ oldText: "a", newText: "b" }]);
		expect((flat as unknown as Record<string, unknown>).oldText).toBeUndefined();
	});
});
