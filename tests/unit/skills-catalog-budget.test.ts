import { describe, it, expect } from "vitest";
import { buildSkillsText, type PromptComposerInputs } from "../../server/prompt-composer.js";
import {
	normalizeSkillsCatalogMaxDesc,
	normalizeSkillsCatalogBudget,
	DEFAULT_SKILLS_CATALOG_MAX_DESC,
	DEFAULT_SKILLS_CATALOG_BUDGET,
} from "../../server/client-state.js";
import { shouldRenderMainCompose } from "../../server/prompt-assembler.js";

describe("Skills Catalog 归一化与预算控制纯函数", () => {
	it("normalizeSkillsCatalogMaxDesc：非法值回退默认，0 代表不限制", () => {
		expect(normalizeSkillsCatalogMaxDesc(undefined)).toBe(DEFAULT_SKILLS_CATALOG_MAX_DESC);
		expect(normalizeSkillsCatalogMaxDesc(null)).toBe(DEFAULT_SKILLS_CATALOG_MAX_DESC);
		expect(normalizeSkillsCatalogMaxDesc("abc")).toBe(DEFAULT_SKILLS_CATALOG_MAX_DESC);
		expect(normalizeSkillsCatalogMaxDesc(-10)).toBe(DEFAULT_SKILLS_CATALOG_MAX_DESC);
		expect(normalizeSkillsCatalogMaxDesc(0)).toBe(0);
		expect(normalizeSkillsCatalogMaxDesc(120.8)).toBe(120);
	});

	it("normalizeSkillsCatalogBudget：非法值回退默认，0 代表不设限", () => {
		expect(normalizeSkillsCatalogBudget(undefined)).toBe(DEFAULT_SKILLS_CATALOG_BUDGET);
		expect(normalizeSkillsCatalogBudget(-1)).toBe(DEFAULT_SKILLS_CATALOG_BUDGET);
		expect(normalizeSkillsCatalogBudget(0)).toBe(0);
		expect(normalizeSkillsCatalogBudget(15000)).toBe(15000);
	});
});

describe("buildSkillsText 极简格式与优化表现", () => {
	const sampleSkills: PromptComposerInputs["skills"] = [
		{
			name: "git-commit",
			description: "Format git commits\nwith conventional standard.",
			filePath: "/workspace/skills/git-commit.md",
		},
		{
			name: "code-review",
			description: "Review code thoroughly for bugs, performance and architecture.",
			filePath: "/workspace/skills/code-review.md",
		},
	];

	it("默认输出为极简单行 Markdown 格式，去除了多层 XML 标签且不包含 location", () => {
		const out = buildSkillsText(sampleSkills, "en");
		expect(out).toContain("<available_skills>");
		expect(out).toContain("- git-commit: Format git commits with conventional standard.");
		expect(out).toContain("- code-review: Review code thoroughly for bugs, performance and architecture.");
		expect(out).not.toContain("<skill>");
		expect(out).not.toContain("<name>");
		expect(out).not.toContain("/workspace/skills/");
	});

	it("开启 showLocation 时在末尾以括号附加路径", () => {
		const out = buildSkillsText(sampleSkills, "en", false, { showLocation: true });
		expect(out).toContain(
			"- git-commit: Format git commits with conventional standard. (location: /workspace/skills/git-commit.md)",
		);
	});

	it("maxDesc 超限截断追加 ...；设为 0 时不截断", () => {
		const out = buildSkillsText(sampleSkills, "en", false, { maxDesc: 20 });
		expect(out).toContain("- git-commit: Format git commit...");

		const noLimit = buildSkillsText(sampleSkills, "en", false, { maxDesc: 0 });
		expect(noLimit).toContain("- git-commit: Format git commits with conventional standard.");
	});

	it("预算超限时自动降级为紧凑模式（names-only）", () => {
		const out = buildSkillsText(sampleSkills, "en", false, { budget: 150 });
		expect(out).toContain("- code-review");
		expect(out).toContain("- git-commit");
		expect(out).not.toContain("Format git commits");
		expect(out).toContain("compact name index enabled");
	});
});

describe("shouldRenderMainCompose 技能接管判定", () => {
	it("在拥有可用技能时触发自定义组装，确保精简名录生效", () => {
		expect(
			shouldRenderMainCompose({
				disabledToolCount: 0,
				hasSkills: true,
			}),
		).toBe(true);

		expect(
			shouldRenderMainCompose({
				disabledToolCount: 0,
				hasSkills: false,
			}),
		).toBe(false);
	});
});
