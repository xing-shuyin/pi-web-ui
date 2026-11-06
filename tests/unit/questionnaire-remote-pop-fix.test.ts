import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleInteractiveResponseMessage } from "../../server/dispatch-domain-handlers.js";
import {
	sendQuestionAnswer,
	confirmQuestionAnswer,
	hasUnconfirmedAnswer,
	resetUnconfirmedAnswers,
	unconfirmedAnswerCount,
} from "../../web/src/question-answer-relay.js";
import { resolvePendingQuestion } from "../../web/src/pending-question.js";

describe("远程项目/重连场景下的问卷防无限弹出回归测试", () => {
	beforeEach(() => {
		resetUnconfirmedAnswers();
	});

	describe("服务端 handleInteractiveResponseMessage 优先由持有会话直接 resolve", () => {
		it("即使携带了旧 owner，若当前 cs 持有该问卷，直接优先由 cs.resolveQuestion 消费", () => {
			const resolveQuestionMock = vi.fn().mockReturnValue(true);
			const answerElsewhereMock = vi.fn().mockResolvedValue(undefined);
			const cs = {
				cwd: "/remote/ws",
				resolveQuestion: resolveQuestionMock,
			} as any;
			const service = {
				answerElsewhereQuestion: answerElsewhereMock,
			};
			const send = vi.fn();

			const handled = handleInteractiveResponseMessage(
				{
					type: "question_answer",
					id: "q-uuid-1",
					answers: [{ id: "q1", selected: ["opt1"] }],
					owner: "old-orphan-client-id",
				},
				cs,
				service,
				"new-client-id",
				send,
			);

			expect(handled).toBe(true);
			expect(resolveQuestionMock).toHaveBeenCalledWith(
				"q-uuid-1",
				[{ id: "q1", selected: ["opt1"] }],
				undefined,
				undefined,
			);
			expect(answerElsewhereMock).not.toHaveBeenCalled();
		});

		it("若当前 cs 未持有该问卷且携带 owner，正常交由 service.answerElsewhereQuestion 转发", () => {
			const resolveQuestionMock = vi.fn().mockReturnValue(false);
			const answerElsewhereMock = vi.fn().mockResolvedValue(undefined);
			const cs = {
				cwd: "/remote/ws",
				resolveQuestion: resolveQuestionMock,
			} as any;
			const service = {
				answerElsewhereQuestion: answerElsewhereMock,
			};
			const send = vi.fn();

			const handled = handleInteractiveResponseMessage(
				{
					type: "question_answer",
					id: "q-uuid-2",
					answers: [{ id: "q1", selected: ["opt2"] }],
					owner: "other-client-id",
				},
				cs,
				service,
				"current-client-id",
				send,
			);

			expect(handled).toBe(true);
			expect(resolveQuestionMock).toHaveBeenCalled();
			expect(answerElsewhereMock).toHaveBeenCalledWith(
				"current-client-id",
				"other-client-id",
				"q-uuid-2",
				[{ id: "q1", selected: ["opt2"] }],
				undefined,
				undefined,
			);
		});

		it("若当前 cs 未持有但全局注册中心存在该 UUID，resolveGlobalQuestion 直接成功消费", () => {
			const resolveGlobalQuestionMock = vi.fn().mockReturnValue(true);
			const answerElsewhereMock = vi.fn();
			const cs = {
				cwd: "/remote/ws",
				resolveQuestion: vi.fn().mockReturnValue(false),
			} as any;
			const service = {
				resolveGlobalQuestion: resolveGlobalQuestionMock,
				answerElsewhereQuestion: answerElsewhereMock,
			};
			const send = vi.fn();

			const handled = handleInteractiveResponseMessage(
				{
					type: "question_answer",
					id: "q-uuid-global-3",
					answers: [{ id: "q1", selected: ["opt3"] }],
				},
				cs,
				service,
				"client-id",
				send,
			);

			expect(handled).toBe(true);
			expect(resolveGlobalQuestionMock).toHaveBeenCalledWith(
				"q-uuid-global-3",
				[{ id: "q1", selected: ["opt3"] }],
				undefined,
				undefined,
			);
			expect(answerElsewhereMock).not.toHaveBeenCalled();
		});
	});

	describe("前端 question-answer-relay 模糊匹配与防复活", () => {
		it("服务端回包省略 owner 时，confirmQuestionAnswer 能通过 id 兜底清除已登记条目", () => {
			sendQuestionAnswer({
				type: "question_answer",
				id: "q-test-1",
				answers: [{ id: "step1", selected: ["yes"] }],
				owner: "owner-mac-client",
			});
			expect(unconfirmedAnswerCount()).toBe(1);
			expect(hasUnconfirmedAnswer("q-test-1", "owner-mac-client")).toBe(true);
			expect(hasUnconfirmedAnswer("q-test-1")).toBe(true);

			confirmQuestionAnswer("q-test-1");
			expect(unconfirmedAnswerCount()).toBe(0);
			expect(hasUnconfirmedAnswer("q-test-1")).toBe(false);
			expect(hasUnconfirmedAnswer("q-test-1", "owner-mac-client")).toBe(false);
		});

		it("快照未带 owner 检查 pendingDelivery 时，能正确识别已登记条目防止复活", () => {
			sendQuestionAnswer({
				type: "question_answer",
				id: "q-snapshot-race",
				answers: [{ id: "step1", selected: ["yes"] }],
				owner: "owner-device",
			});

			const decision = resolvePendingQuestion({
				current: null,
				source: "live",
				snapshot: {
					id: "q-snapshot-race",
					questions: [{ id: "step1", question: "Continue?" }],
				},
				answered: new Set(),
				pendingDelivery: hasUnconfirmedAnswer,
				activeConversationId: "conv-1",
			});

			expect(decision.changed).toBe(false);
			expect(decision.question).toBeNull();
		});

		it("若当前面板正在展示已回答或待投递的问卷，快照到达时铁律守卫立即收起当前面板为 null", () => {
			const decision = resolvePendingQuestion({
				current: {
					id: "q-already-answered",
					questions: [{ id: "step1", question: "Continue?" }],
				},
				source: "live",
				snapshot: {
					id: "q-already-answered",
					questions: [{ id: "step1", question: "Continue?" }],
				},
				answered: new Set(["q-already-answered"]),
				activeConversationId: "conv-1",
			});

			expect(decision.changed).toBe(true);
			expect(decision.question).toBeNull();
		});
	});
});
