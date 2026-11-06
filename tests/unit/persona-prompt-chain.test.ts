import { describe, expect, it } from "vitest";
import { splitAgentStartPrompt } from "../../server/agent-service.js";

function fakeEvent(forced?: string) {
	const systemPromptOptions: { forceSystemPrompt?: string } = {};
	if (forced !== undefined) systemPromptOptions.forceSystemPrompt = forced;
	return {
		systemPromptOptions,
		get systemPrompt(): string {
			return systemPromptOptions.forceSystemPrompt ?? "BASE PROMPT\n\nAvailable tools:\nread";
		},
	};
}

describe("splitAgentStartPrompt", () => {
	const base = "BASE PROMPT\n\nAvailable tools:\nread";

	it("没有扩展动过提示词时零开销地返回当前文本", () => {
		const event = fakeEvent();
		expect(splitAgentStartPrompt(event)).toEqual({ pre: "", core: base, post: "" });
		expect("forceSystemPrompt" in event.systemPromptOptions).toBe(false);
	});

	it("摘出扩展的前置注入，并把 forceSystemPrompt 原样还原", () => {
		const forced = `<invoked_skill>x</invoked_skill>\n${base}`;
		const event = fakeEvent(forced);
		expect(splitAgentStartPrompt(event)).toEqual({
			pre: "<invoked_skill>x</invoked_skill>\n",
			core: base,
			post: "",
		});
		expect(event.systemPromptOptions.forceSystemPrompt).toBe(forced);
		expect(event.systemPrompt).toBe(forced);
	});

	it("摘出前置 + 后置注入", () => {
		const event = fakeEvent(`A\n${base}\nB`);
		expect(splitAgentStartPrompt(event)).toEqual({ pre: "A\n", core: base, post: "\nB" });
	});

	it("扩展整体换掉提示词时不硬拆，退回当前文本", () => {
		const event = fakeEvent("something else entirely");
		expect(splitAgentStartPrompt(event)).toEqual({ pre: "", core: "something else entirely", post: "" });
		expect(event.systemPromptOptions.forceSystemPrompt).toBe("something else entirely");
	});
});
