import { describe, expect, it, vi } from "vitest";
import { handleInteractiveResponseMessage } from "../../server/dispatch-domain-handlers.js";
import type { DispatchSession } from "../../server/index.js";

describe("shared conversation interactive responses", () => {
	it("routes a global questionnaire answer to its original owner", () => {
		const localAnswer = vi.fn();
		const resolveSharedQuestion = vi.fn(() => true);
		const answers = [{ id: "scope", selected: ["TUI"] }];
		expect(
			handleInteractiveResponseMessage(
				{ type: "question_answer", id: "question-shared", answers },
				{ answerQuestion: localAnswer } as unknown as DispatchSession,
				{ resolveSharedQuestion },
				"browser",
				vi.fn(),
			),
		).toBe(true);
		expect(resolveSharedQuestion).toHaveBeenCalledWith("browser", "question-shared", answers, undefined, undefined);
		expect(localAnswer).not.toHaveBeenCalled();
	});

	it("preserves approval decisions, edited parameters, reasons and scope", () => {
		const localResolve = vi.fn();
		const resolveSharedToolApproval = vi.fn(() => true);
		handleInteractiveResponseMessage(
			{
				type: "tool_approval_response",
				id: "approval-shared",
				decision: "approve",
				editedParams: { command: "pwd" },
				reason: "reviewed",
				scope: "once",
			},
			{ resolveToolApproval: localResolve } as unknown as DispatchSession,
			{ resolveSharedToolApproval },
			"browser",
			vi.fn(),
		);
		expect(resolveSharedToolApproval).toHaveBeenCalledWith(
			"browser",
			"approval-shared",
			"approve",
			{ command: "pwd" },
			"reviewed",
			"once",
		);
		expect(localResolve).not.toHaveBeenCalled();
	});

	it("keeps ordinary local questionnaire handling when no shared request matches", () => {
		const localAnswer = vi.fn();
		const answers = [{ id: "scope", selected: [] }];
		handleInteractiveResponseMessage(
			{ type: "question_answer", id: "local-question", answers, cancelled: true },
			{ answerQuestion: localAnswer } as unknown as DispatchSession,
			{ resolveSharedQuestion: () => false },
			"browser",
			vi.fn(),
		);
		expect(localAnswer).toHaveBeenCalledWith("local-question", answers, true, undefined);
	});
});
