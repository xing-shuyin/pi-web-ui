import { describe, expect, it } from "vitest";
import {
	resolveModelReasoningSpec,
	STANDARD_BUDGET_MAP,
	STANDARD_EFFORT_MAP,
} from "../../server/reasoning-registry.js";

describe("reasoning-registry (权威模型推理规格与识别)", () => {
	it("精准识别 Claude 3.7+ 为 Token 预算模式，具备完整档位", () => {
		const spec = resolveModelReasoningSpec("claude-3-7-sonnet-20250219");
		expect(spec).toBeDefined();
		expect(spec?.type).toBe("budget");
		expect(spec?.thinkingLevelMap).toEqual(STANDARD_BUDGET_MAP);
		expect(spec?.thinkingLevelMap.medium).toBe("8192");
		expect(spec?.thinkingLevelMap.xhigh).toBe("32000");
		expect(spec?.thinkingLevelMap.max).toBe("64000");
	});

	it("精准识别 OpenAI o1/o3/o4 系列为 Effort 档位模式", () => {
		const o3 = resolveModelReasoningSpec("o3-mini");
		expect(o3).toBeDefined();
		expect(o3?.type).toBe("effort");
		expect(o3?.thinkingLevelMap.low).toBe("low");
		expect(o3?.thinkingLevelMap.medium).toBe("medium");
		expect(o3?.thinkingLevelMap.high).toBe("high");
		expect(o3?.thinkingLevelMap.off).toBeNull();
	});

	it("精准识别 Gemini 2.0 / 2.5 Flash Thinking 预算模式", () => {
		const gemini = resolveModelReasoningSpec("gemini-2.0-flash-thinking-exp-01-21");
		expect(gemini).toBeDefined();
		expect(gemini?.type).toBe("budget");
		expect(gemini?.thinkingLevelMap.medium).toBe("8192");
	});

	it("精准识别 DeepSeek R1 / QwQ 为 Fixed 固定推理模式，避免假档位调节", () => {
		const r1 = resolveModelReasoningSpec("deepseek-reasoner");
		expect(r1).toBeDefined();
		expect(r1?.type).toBe("fixed");
		expect(r1?.thinkingLevelMap.low).toBeNull();
		expect(r1?.thinkingLevelMap.high).toBeNull();

		const qwq = resolveModelReasoningSpec("qwq-32b-preview");
		expect(qwq).toBeDefined();
		expect(qwq?.type).toBe("fixed");
	});

	it("根据网关自报元数据精准判定，不依赖模型名称", () => {
		const customEffort = resolveModelReasoningSpec("my-private-model", {
			supported_parameters: ["reasoning_effort", "temperature"],
		});
		expect(customEffort?.type).toBe("effort");
		expect(customEffort?.thinkingLevelMap.medium).toBe("medium");

		const customBudget = resolveModelReasoningSpec("another-private-model", {
			supported_parameters: ["max_thinking_tokens"],
		});
		expect(customBudget?.type).toBe("budget");
		expect(customBudget?.thinkingLevelMap.medium).toBe("8192");
	});

	it("对普通非推理模型返回 undefined，彻底杜绝无端猜测", () => {
		expect(resolveModelReasoningSpec("gpt-4o")).toBeUndefined();
		expect(resolveModelReasoningSpec("claude-3-5-sonnet-20241022")).toBeUndefined();
		expect(resolveModelReasoningSpec("llama-3.1-70b-instruct")).toBeUndefined();
	});
});
