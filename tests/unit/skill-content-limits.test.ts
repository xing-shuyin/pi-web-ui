import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fillSkillContents } from "../../server/skill-content-filler.js";
import {
	DEFAULT_SKILLS_FULL_TEXT_MAX_BYTES,
	DEFAULT_SKILLS_MAX_FILE_BYTES,
	MAX_SKILLS_FULL_TEXT_MAX_BYTES,
	MAX_SKILLS_MAX_FILE_BYTES,
	normalizeSkillsFullTextMaxBytes,
	normalizeSkillsMaxFileBytes,
} from "../../server/client-state.js";

const dir = mkdtempSync(join(tmpdir(), "skill-limits-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function skillFile(name: string, body: string): { name: string; description: string; filePath: string } {
	const path = join(dir, `${name}.md`);
	writeFileSync(path, body, "utf8");
	return { name, description: name, filePath: path };
}

const ascii = (n: number) => "a".repeat(n);

describe("normalize limits", () => {
	it("默认值与历史硬编码一致", () => {
		expect(DEFAULT_SKILLS_MAX_FILE_BYTES).toBe(8192);
		expect(DEFAULT_SKILLS_FULL_TEXT_MAX_BYTES).toBe(32768);
		expect(normalizeSkillsMaxFileBytes(undefined)).toBe(8192);
		expect(normalizeSkillsFullTextMaxBytes(undefined)).toBe(32768);
	});
	it("非负整数，非法值回退默认，超界截到硬上限", () => {
		expect(normalizeSkillsMaxFileBytes(16384)).toBe(16384);
		expect(normalizeSkillsMaxFileBytes(0)).toBe(0);
		expect(normalizeSkillsMaxFileBytes(-1)).toBe(8192);
		expect(normalizeSkillsMaxFileBytes(Number.NaN)).toBe(8192);
		expect(normalizeSkillsMaxFileBytes("big")).toBe(8192);
		expect(normalizeSkillsMaxFileBytes(1234.9)).toBe(1234);
		expect(normalizeSkillsMaxFileBytes(MAX_SKILLS_MAX_FILE_BYTES * 4)).toBe(MAX_SKILLS_MAX_FILE_BYTES);
		expect(normalizeSkillsFullTextMaxBytes(MAX_SKILLS_FULL_TEXT_MAX_BYTES * 4)).toBe(MAX_SKILLS_FULL_TEXT_MAX_BYTES);
	});
});

describe("fillSkillContents limits", () => {
	it("缺省行为不变：超 8KB 的技能回落名录", () => {
		const big = skillFile("big", ascii(9000));
		const small = skillFile("small", "# Small\n");
		const out = fillSkillContents([big, small], ["big", "small"]);
		expect(out[0].content).toBeUndefined();
		expect(out[1].content).toBe("# Small");
	});

	it("调大单文件上限后，大技能也能注入全文", () => {
		const big = skillFile("big2", ascii(9000));
		const out = fillSkillContents([big], ["big2"], { maxFileBytes: 16384 });
		expect(out[0].content).toHaveLength(9000);
	});

	it("总量预算生效：后来的技能拿不到正文", () => {
		const a = skillFile("a", ascii(600));
		const b = skillFile("b", ascii(600));
		const out = fillSkillContents([a, b], ["a", "b"], { maxTotalBytes: 700 });
		expect(out[0].content).toHaveLength(600);
		expect(out[1].content).toHaveLength(100);
	});

	it("预算按 UTF-8 字节计（中文不再被低估 3 倍）", () => {
		const cjk = "技".repeat(300);
		const a = skillFile("cjk-a", cjk);
		const b = skillFile("cjk-b", cjk);
		const out = fillSkillContents([a, b], ["cjk-a", "cjk-b"], { maxTotalBytes: 900, maxFileBytes: 4096 });
		expect(Buffer.byteLength(out[0].content ?? "", "utf8")).toBe(900);
		expect(out[1].content).toBeUndefined();
	});

	it("按预算截断多字节字符时不塞进 U+FFFD", () => {
		const a = skillFile("cjk-cut", "汉".repeat(50));
		const out = fillSkillContents([a], ["cjk-cut"], { maxTotalBytes: 100 });
		const content = out[0].content ?? "";
		expect(content).not.toContain("\uFFFD");
		expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(100);
		expect(content.length).toBeGreaterThan(0);
	});

	it("0 = 显式不设限（单文件与总量都放开）", () => {
		const big = skillFile("big3", ascii(20000));
		const out = fillSkillContents([big], ["big3"], { maxFileBytes: 0, maxTotalBytes: 0 });
		expect(out[0].content).toHaveLength(20000);
	});

	it("名单为空时零开销、原样返回", () => {
		const a = skillFile("none", "# x\n");
		const out = fillSkillContents([a], []);
		expect(out).toEqual([a]);
	});
});
