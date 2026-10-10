import { describe, expect, it, beforeEach } from "vitest";
import {
	clearQuestionDraft,
	loadQuestionDraft,
	saveQuestionDraft,
	type QuestionDraft,
} from "../../web/src/question-draft";

describe("question-draft", () => {
	beforeEach(() => {
		clearQuestionDraft("q-test-1");
		clearQuestionDraft("q-test-2");
	});

	it("保存并成功读取多题选项和输入草稿", () => {
		const draft: Omit<QuestionDraft, "updatedAt"> = {
			selections: { q1: ["Option A", "Option B"], q2: ["Option 1"] },
			customs: { q1: "用户补充说明", q2: "" },
			step: 1,
		};

		saveQuestionDraft("q-test-1", draft);
		const loaded = loadQuestionDraft("q-test-1");

		expect(loaded).not.toBeNull();
		expect(loaded?.selections).toEqual({ q1: ["Option A", "Option B"], q2: ["Option 1"] });
		expect(loaded?.customs).toEqual({ q1: "用户补充说明", q2: "" });
		expect(loaded?.step).toBe(1);
	});

	it("不同 questionId 之间草稿相互隔离", () => {
		saveQuestionDraft("q-test-1", {
			selections: { q1: ["A"] },
			customs: {},
			step: 0,
		});

		saveQuestionDraft("q-test-2", {
			selections: { q2: ["B"] },
			customs: { q2: "Note" },
			step: 1,
		});

		const d1 = loadQuestionDraft("q-test-1");
		const d2 = loadQuestionDraft("q-test-2");

		expect(d1?.selections).toEqual({ q1: ["A"] });
		expect(d2?.selections).toEqual({ q2: ["B"] });
	});

	it("空草稿且无进度时不落盘并自动清除", () => {
		saveQuestionDraft("q-test-1", {
			selections: { q1: [] },
			customs: { q1: "   " },
			step: 0,
		});

		expect(loadQuestionDraft("q-test-1")).toBeNull();
	});

	it("clearQuestionDraft 彻底清除指定草稿", () => {
		saveQuestionDraft("q-test-1", {
			selections: { q1: ["A"] },
			customs: {},
			step: 0,
		});

		expect(loadQuestionDraft("q-test-1")).not.toBeNull();
		clearQuestionDraft("q-test-1");
		expect(loadQuestionDraft("q-test-1")).toBeNull();
	});
});
