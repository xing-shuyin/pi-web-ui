import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MATERIAL_LIMITS,
	MATERIAL_STAGE_DIR,
	describeMaterials,
	normalizeMaterials,
	planMaterialDelivery,
	stageMaterials,
} from "../../server/material.js";

let dir = "";

const write = (rel: string, content = "x") => {
	const abs = join(dir, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content);
	return abs;
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "piweb-material-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("normalizeMaterials", () => {
	it("相对路径按 ctx.cwd 解析，按扩展名推 kind", async () => {
		write("docs/req.md");
		write("shots/a.png");
		const { materials, dropped } = await normalizeMaterials(["docs/req.md", "shots/a.png"], { cwd: dir });
		expect(dropped).toEqual([]);
		expect(materials.map((m) => [m.ref, m.kind])).toEqual([
			["docs/req.md", "file"],
			["shots/a.png", "image"],
		]);
	});

	it("目录识别为 dir", async () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		const { materials } = await normalizeMaterials(["src"], { cwd: dir });
		expect(materials[0]?.kind).toBe("dir");
	});

	it("脏数据不抛错：空串 / 非字符串 / 重复 / 不存在 各记一笔", async () => {
		write("a.md");
		const { materials, dropped } = await normalizeMaterials(["", 42, "a.md", "a.md", "nope.md"], { cwd: dir });
		expect(materials.map((m) => m.ref)).toEqual(["a.md"]);
		expect(dropped.map((d) => d.reason)).toEqual(["empty", "invalid", "duplicate", "missing"]);
	});

	it("超过上限就丢并记账（不静默）", async () => {
		const many = Array.from({ length: MATERIAL_LIMITS.maxItems + 2 }, (_, i) => `f${i}.md`);
		for (const f of many) write(f);
		const { materials, dropped } = await normalizeMaterials(many, { cwd: dir });
		expect(materials).toHaveLength(MATERIAL_LIMITS.maxItems);
		expect(dropped.filter((d) => d.reason === "over-cap")).toHaveLength(2);
	});

	it("URI 原样保留、不做 stat", async () => {
		const { materials, dropped } = await normalizeMaterials(
			["https://example.com/x", "remote-workspace://h/dev/a.ts"],
			{ cwd: dir },
		);
		expect(dropped).toEqual([]);
		expect(materials.map((m) => m.kind)).toEqual(["url", "url"]);
	});

	it("非数组输入一律当空（老规格兼容）", async () => {
		for (const raw of [undefined, null, "a.md", 42]) {
			const { materials } = await normalizeMaterials(raw, { cwd: dir });
			expect(materials).toEqual([]);
		}
	});
});

describe("describeMaterials", () => {
	const ref = (p: string, kind: "file" | "image" = "file") => ({ kind, ref: p, abs: `/w/${p}` });

	it("空 → 空串（不传材料时不增加任何 prompt 字节）", () => {
		expect(describeMaterials([])).toBe("");
	});

	it("≤3 项只出一行（省上下文）", () => {
		expect(describeMaterials([ref("a.md"), ref("b.png", "image")])).toBe("材料：a.md、b.png");
	});

	it(">3 项才升级成清单块，且带「先读」指令", () => {
		const text = describeMaterials([ref("a"), ref("b"), ref("c"), ref("d.png", "image")]);
		expect(text).toContain("【材料（动手前先读，不要凭印象改）】");
		expect(text.split("\n")).toHaveLength(5);
		expect(text).toContain("- image: d.png");
	});
});

describe("planMaterialDelivery", () => {
	const file = { kind: "file" as const, ref: "a.md", abs: "/w/a.md" };
	const image = { kind: "image" as const, ref: "s.png", abs: "/w/s.png" };

	it("有 fs：一切给指针（图片也一样，执行者自己 read）", () => {
		const plan = planMaterialDelivery([file, image], { hasFs: true, vision: true });
		expect(plan.pointers).toEqual([file, image]);
		expect(plan.inline).toEqual([]);
		expect(plan.degraded).toEqual([]);
	});

	it("有 fs + 无视觉：仍是指针（不降级，也不静默丢）", () => {
		const plan = planMaterialDelivery([image], { hasFs: true, vision: false });
		expect(plan.pointers).toEqual([image]);
		expect(plan.degraded).toEqual([]);
	});

	it("无 fs 引擎：全部 inline；无视觉的图片才降级", () => {
		const plan = planMaterialDelivery([file, image], { hasFs: false, vision: false });
		expect(plan.inline).toEqual([file]);
		expect(plan.degraded).toEqual([{ ref: "s.png", reason: "no-vision" }]);
	});
});

describe("stageMaterials", () => {
	it("把跨 cwd 材料复制进 .pi-materials/ 并改写成相对路径", async () => {
		write("docs/req.md");
		const { materials } = await normalizeMaterials(["docs/req.md"], { cwd: dir });
		const target = join(dir, "wt");
		mkdirSync(target, { recursive: true });

		const { staged, failed } = await stageMaterials(materials, target);
		expect(failed).toEqual([]);
		expect(staged[0]?.ref).toBe(`${MATERIAL_STAGE_DIR}/req.md`);
	});

	it("URL 原样保留（不需要复制）", async () => {
		const { materials } = await normalizeMaterials(["https://example.com/a"], { cwd: dir });
		const { staged } = await stageMaterials(materials, join(dir, "wt"));
		expect(staged[0]?.ref).toBe("https://example.com/a");
	});
});
