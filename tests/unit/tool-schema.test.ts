import { describe, expect, it } from "vitest";
import { hasSchemaRows, schemaRows, typeLabel } from "../../web/src/tool-schema.js";

describe("typeLabel", () => {
	it("基础类型原样返回", () => {
		expect(typeLabel({ type: "string" })).toBe("string");
		expect(typeLabel({ type: "number" })).toBe("number");
		expect(typeLabel({ type: "boolean" })).toBe("boolean");
		expect(typeLabel({ type: "integer" })).toBe("integer");
	});

	it("enum 不改类型标签（候选值走 hint，避免类型列被撑爆）", () => {
		expect(typeLabel({ type: "string", enum: ["a", "b"] })).toBe("string");
	});

	it("数组展开 items；缺 items 记 array<any>", () => {
		expect(typeLabel({ type: "array", items: { type: "string" } })).toBe("array<string>");
		expect(typeLabel({ type: "array" })).toBe("array<any>");
		expect(typeLabel({ type: "array", items: { type: "array", items: { type: "number" } } })).toBe(
			"array<array<number>>",
		);
	});

	it("$ref 只标注不解析", () => {
		expect(typeLabel({ $ref: "#/$defs/Foo" })).toBe("ref");
	});

	it("anyOf / oneOf / allOf 拼联合标签：去重、超过 4 个截断", () => {
		expect(typeLabel({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe("string | number");
		expect(typeLabel({ oneOf: [{ type: "string" }, { type: "string" }] })).toBe("string");
		expect(
			typeLabel({
				anyOf: [{ type: "a" }, { type: "b" }, { type: "c" }, { type: "d" }, { type: "e" }, { type: "f" }],
			}),
		).toBe("a | b | c | d | …");
	});

	it("没有 type 时的兜底：properties → object、additionalProperties → record<T>、其余 any", () => {
		expect(typeLabel({ properties: { a: { type: "string" } } })).toBe("object");
		expect(typeLabel({ additionalProperties: { type: "number" } })).toBe("record<number>");
		expect(typeLabel({ title: "随便写点啥" })).toBe("any");
	});

	it("脏输入（null / undefined / 字符串 / 数组 / 数字）一律 any，不抛错", () => {
		for (const bad of [null, undefined, "string", 42, [], true]) {
			expect(typeLabel(bad)).toBe("any");
		}
	});

	it("自引用 schema 不会无限递归（depth 封顶）", () => {
		const self: Record<string, unknown> = { type: "array" };
		self.items = self;
		const label = typeLabel(self);
		expect(label.startsWith("array<")).toBe(true);
		expect(label).toContain("any");
	});
});

describe("schemaRows", () => {
	it("非对象 / 缺 properties / properties 不是对象 → 空数组", () => {
		expect(schemaRows(null)).toEqual([]);
		expect(schemaRows("nope")).toEqual([]);
		expect(schemaRows({ type: "string" })).toEqual([]);
		expect(schemaRows({ properties: "nope" })).toEqual([]);
		expect(schemaRows({ properties: [] })).toEqual([]);
	});

	it("一行 = 参数名 / 类型 / 必填 / 说明，且保持声明顺序", () => {
		const rows = schemaRows({
			type: "object",
			properties: {
				path: { type: "string", description: "要读的文件" },
				limit: { type: "number" },
				recursive: { type: "boolean" },
			},
			required: ["path", "limit"],
		});
		expect(rows.map((r) => r.name)).toEqual(["path", "limit", "recursive"]);
		expect(rows[0]).toMatchObject({ name: "path", type: "string", required: true, depth: 0 });
		expect(rows[0]?.description).toBe("要读的文件");
		expect(rows[1]?.required).toBe(true);
		expect(rows[2]?.required).toBe(false);
		expect(rows[2]?.description).toBeUndefined();
	});

	it("嵌套对象递归展开：名字带父前缀、depth 递增、required 各自独立", () => {
		const rows = schemaRows({
			type: "object",
			properties: {
				opts: {
					type: "object",
					description: "选项",
					properties: { deep: { type: "string" } },
					required: ["deep"],
				},
			},
			required: ["opts"],
		});
		expect(rows.map((r) => [r.name, r.depth, r.required])).toEqual([
			["opts", 0, true],
			["opts.deep", 1, true],
		]);
	});

	it("数组里的对象不展开（位置语义表达不了），只标 array<object>", () => {
		const rows = schemaRows({
			type: "object",
			properties: { files: { type: "array", items: { type: "object", properties: { a: { type: "string" } } } } },
		});
		expect(rows.map((r) => r.name)).toEqual(["files"]);
		expect(rows[0]?.type).toBe("array<object>");
	});

	it("maxDepth 封顶：到层就不展开（默认 3 层）", () => {
		const nested = {
			type: "object",
			properties: {
				l1: {
					type: "object",
					properties: {
						l2: { type: "object", properties: { l3: { type: "object", properties: { l4: { type: "string" } } } } },
					},
				},
			},
		};
		expect(schemaRows(nested).map((r) => r.name)).toEqual(["l1", "l1.l2", "l1.l2.l3"]);
		expect(schemaRows(nested, { maxDepth: 1 }).map((r) => r.name)).toEqual(["l1"]);
	});

	it("maxRows 封顶：脏 schema 不该把弹窗撑爆", () => {
		const props: Record<string, unknown> = {};
		for (let i = 0; i < 50; i++) props[`p${i}`] = { type: "string" };
		expect(schemaRows({ type: "object", properties: props }, { maxRows: 5 })).toHaveLength(5);
		expect(schemaRows({ type: "object", properties: props })).toHaveLength(50);
	});

	it("hint：enum 候选 / default / const（最多 6 个 enum，多了省略）", () => {
		const rows = schemaRows({
			type: "object",
			properties: {
				mode: { type: "string", enum: ["a", "b"] },
				n: { type: "number", default: 3 },
				fixed: { const: "x" },
				many: { type: "string", enum: ["1", "2", "3", "4", "5", "6", "7"] },
			},
		});
		expect(rows[0]?.hint).toBe("enum: a | b");
		expect(rows[1]?.hint).toBe("default: 3");
		expect(rows[2]?.hint).toBe('const: "x"');
		expect(rows[3]?.hint).toBe("enum: 1 | 2 | 3 | 4 | 5 | 6 | …");
	});

	it("脏数据不抛错：属性值是 null / 字符串 / 非字符串 required 项", () => {
		const rows = schemaRows({
			type: "object",
			properties: { bad: null, alsoBad: "nope", ok: { type: "string" } },
			required: ["ok", 42, null],
		});
		expect(rows.map((r) => [r.name, r.type, r.required])).toEqual([
			["bad", "any", false],
			["alsoBad", "any", false],
			["ok", "string", true],
		]);
	});
});

describe("hasSchemaRows", () => {
	it("有可展示的属性行 → true；否则 false", () => {
		expect(hasSchemaRows({ type: "object", properties: { a: { type: "string" } } })).toBe(true);
		expect(hasSchemaRows({ type: "object", properties: {} })).toBe(false);
		expect(hasSchemaRows(null)).toBe(false);
		expect(hasSchemaRows({ type: "string" })).toBe(false);
	});
});
