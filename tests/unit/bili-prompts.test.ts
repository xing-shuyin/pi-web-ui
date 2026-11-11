// @ts-ignore Plugin modules are JavaScript runtime imports.
import {
	ANALYZE_PROMPT_CONTRACT,
	ANALYZE_PROMPT_DEFAULT,
	ANALYZE_PROMPT_SAFETY,
	DM_PROMPT_DEFAULT,
	DM_PROMPT_SAFETY,
	composeAnalyzeSystem,
	composeDmSystem,
	describePrompts,
} from "../../plugins/bili-scroll/lib/prompts.mjs";
import { describe, expect, it } from "vitest";

describe("bili-scroll 提示词单源", () => {
	it("默认研读提示词非空，且带上三档评判口径", () => {
		expect(ANALYZE_PROMPT_DEFAULT.length).toBeGreaterThan(50);
		for (const tier of ["值得看", "可以看", "不值当"]) expect(ANALYZE_PROMPT_DEFAULT).toContain(tier);
		expect(DM_PROMPT_DEFAULT.length).toBeGreaterThan(50);
	});

	it("输出契约包含巡检解析依赖的四个字段", () => {
		for (const key of ['"tier"', '"whyWorth"', '"insights"', '"comment"']) {
			expect(ANALYZE_PROMPT_CONTRACT).toContain(key);
		}
	});

	it("不传改写时用默认文本，并固定追加契约与安全条款", () => {
		const system = composeAnalyzeSystem({ effortGuide: "【思考强度：中等】认真通读字幕。" });
		expect(system.startsWith(ANALYZE_PROMPT_DEFAULT)).toBe(true);
		expect(system).toContain("【思考强度：中等】");
		expect(system).toContain(ANALYZE_PROMPT_CONTRACT);
		expect(system).toContain(ANALYZE_PROMPT_SAFETY);
		expect(system.indexOf(ANALYZE_PROMPT_CONTRACT)).toBeLessThan(system.indexOf(ANALYZE_PROMPT_SAFETY));
	});

	it("改写替换默认文本，但契约与安全条款仍由代码追加（改不掉）", () => {
		const system = composeAnalyzeSystem({ override: "你是毒舌架构师，只认代码和实操。", persona: "偏好工程实践" });
		expect(system.startsWith("你是毒舌架构师，只认代码和实操。")).toBe(true);
		expect(system).not.toContain(ANALYZE_PROMPT_DEFAULT);
		expect(system).toContain("使用者人设与准则：\n偏好工程实践");
		expect(system).toContain(ANALYZE_PROMPT_CONTRACT);
		expect(system).toContain(ANALYZE_PROMPT_SAFETY);
	});

	it("私信提示词同样支持改写且安全条款固定", () => {
		expect(composeDmSystem("")).toContain(DM_PROMPT_DEFAULT);
		const custom = composeDmSystem("只回一句人话。");
		expect(custom.startsWith("只回一句人话。")).toBe(true);
		expect(custom).toContain(DM_PROMPT_SAFETY);
	});

	it("纯空白改写视同默认，describePrompts 给出默认/改写/生效/固定四份", () => {
		const cfg = { analyzePrompt: "   ", dmPrompt: "自定义" };
		const info = describePrompts(cfg);
		expect(info.analyze.override).toBe("");
		expect(info.analyze.effective).toBe(ANALYZE_PROMPT_DEFAULT);
		expect(info.dm.override).toBe("自定义");
		expect(info.dm.effective).toBe("自定义");
		expect(info.analyze.fixed).toContain(ANALYZE_PROMPT_SAFETY);
		expect(info.dm.fixed).toBe(DM_PROMPT_SAFETY);
	});
});
