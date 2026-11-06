import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	findSkill,
	formatSkillCatalog,
	makeSkillTool,
	renderSkillContent,
	suggestSkills,
	type SkillCatalogEntry,
} from "../../server/skill-tool.js";

const SKILLS: SkillCatalogEntry[] = [
	{ name: "code-review", description: "Review code changes", filePath: "/skills/code-review/SKILL.md" },
	{ name: "commit", description: "Make git commits", filePath: "/skills/commit/SKILL.md" },
];

function textOf(res: unknown): string {
	const r = res as { content: { type: string; text: string }[] };
	return r.content.map((b) => b.text).join("\n");
}

describe("findSkill", () => {
	it("精确名命中", () => {
		expect(findSkill(SKILLS, "commit")?.filePath).toBe("/skills/commit/SKILL.md");
	});
	it("大小写敏感 + 空白容忍", () => {
		expect(findSkill(SKILLS, "Commit")).toBeUndefined();
		expect(findSkill(SKILLS, "  commit  ")?.name).toBe("commit");
		expect(findSkill(SKILLS, "")).toBeUndefined();
	});
});

describe("suggestSkills", () => {
	it("子串纠错", () => {
		expect(suggestSkills(SKILLS, "cod").map((s) => s.name)).toEqual(["code-review"]);
		expect(suggestSkills(SKILLS, "COMMIT").map((s) => s.name)).toEqual(["commit"]);
	});
	it("空 query 全匹配", () => {
		expect(suggestSkills(SKILLS, "")).toHaveLength(2);
	});
});

describe("formatSkillCatalog", () => {
	it("名录行含名与描述", () => {
		const t = formatSkillCatalog(SKILLS, "zh");
		expect(t).toContain("code-review — Review code changes");
		expect(t).toContain("可用技能（2）");
	});
	it("空目录给空句", () => {
		expect(formatSkillCatalog([], "en")).toContain("No skills");
	});
});

describe("renderSkillContent", () => {
	it("与 SDK /skill:name 展开格式一致（前端按卡片渲染）", () => {
		expect(renderSkillContent("commit", "/s/SKILL.md", "正文")).toBe(
			'<skill name="commit" location="/s/SKILL.md">\n正文\n</skill>',
		);
	});
});

describe("makeSkillTool execute", () => {
	const dir = mkdtempSync(join(tmpdir(), "skill-tool-test-"));
	const fp = join(dir, "SKILL.md");
	writeFileSync(fp, "# Commit\n\nDo commits well.\n", "utf8");
	const host = {
		listSkills: (): SkillCatalogEntry[] => [{ name: "commit", description: "Make git commits", filePath: fp }],
	};
	const tool = makeSkillTool(host, () => "zh");
	const exec = tool.execute as unknown as (_id: string, p: { name?: string }) => Promise<unknown>;

	it("无名返名录", async () => {
		expect(textOf(await exec("x", {}))).toContain("commit — Make git commits");
	});
	it("命中读正文并包块", async () => {
		const t = textOf(await exec("x", { name: "commit" }));
		expect(t).toContain('<skill name="commit"');
		expect(t).toContain("Do commits well.");
	});
	it("错名给纠错", async () => {
		expect(textOf(await exec("x", { name: "comit" }))).toContain("没有名为 comit 的技能");
	});
	it("host 抛错回空目录不断链", async () => {
		const bad = makeSkillTool(
			{
				listSkills: () => {
					throw new Error("boom");
				},
			},
			() => "en",
		);
		const e = bad.execute as unknown as (_id: string, p: object) => Promise<unknown>;
		expect(textOf(await e("x", {}))).toContain("No skills");
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("makeSkillTool 单文件上限跟随设置 (#819)", () => {
	const dir = mkdtempSync(join(tmpdir(), "skill-tool-cap-"));
	const fp = join(dir, "SKILL.md");
	writeFileSync(fp, `# Big\n\n${"x".repeat(20 * 1024)}\n`, "utf8");
	const entry: SkillCatalogEntry = { name: "big", description: "Big skill", filePath: fp };
	const textOf = (res: unknown): string =>
		(res as { content: { type: string; text: string }[] }).content.map((b) => b.text).join("\n");

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("默认仍是 8KB 上限（老行为不变）", async () => {
		const tool = makeSkillTool({ listSkills: () => [entry] }, () => "en");
		const out = textOf(await (tool.execute as any)("x", { name: "big" }));
		expect(out).toContain("over the 8KB cap");
	});

	it("host 提供较大上限时读得到全文", async () => {
		const tool = makeSkillTool({ listSkills: () => [entry], maxFileBytes: () => 32 * 1024 }, () => "en");
		const out = textOf(await (tool.execute as any)("x", { name: "big" }));
		expect(out).toContain('<skill name="big"');
		expect(out.length).toBeGreaterThan(20 * 1024);
	});

	it("0 = 不设单文件上限", async () => {
		const tool = makeSkillTool({ listSkills: () => [entry], maxFileBytes: () => 0 }, () => "en");
		const out = textOf(await (tool.execute as any)("x", { name: "big" }));
		expect(out).toContain('<skill name="big"');
	});
});
