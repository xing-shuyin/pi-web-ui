import { describe, expect, it } from "vitest";
import { appendQuickAskQuestion, explainSelectionPrompt } from "../../web/src/quick-ask.js";

describe("quick ask explanation template", () => {
	it("inserts the selected text literally without treating dollar sequences as replacements", () => {
		const selection = "price=$&; {{input}}; $` $'";
		expect(explainSelectionPrompt(undefined, selection)).toBe(`解释下: ${selection}`);
		expect(explainSelectionPrompt("Explain {{input}} / {{input}}", selection)).toBe(
			`Explain ${selection} / ${selection}`,
		);
	});

	it("restores the default for a blank template", () => {
		expect(explainSelectionPrompt("   ", "text")).toBe("解释下: text");
	});
});

describe("quick ask follow-ups after an interrupted turn", () => {
	it("keeps completed turns and replaces the unanswered question without mutating existing history", () => {
		const messages = [
			{ role: "user" as const, content: "first question" },
			{ role: "assistant" as const, content: "first answer" },
			{ role: "user" as const, content: "cancelled question" },
		];
		const next = appendQuickAskQuestion(messages, "revised question");
		expect(next).toEqual([...messages.slice(0, -1), { role: "user", content: "revised question" }]);
		expect(messages.at(-1)?.content).toBe("cancelled question");
	});

	it("adds follow-up questions after completed answers", () => {
		const messages = [{ role: "assistant" as const, content: "answer" }];
		expect(appendQuickAskQuestion(messages, "follow-up")).toEqual([
			...messages,
			{ role: "user", content: "follow-up" },
		]);
	});
});
