/**
 * question-answer-relay.ts 单测：问卷答案的「登记 + 重投」。
 *
 * 回归的 bug：QuestionDialog 用 appSend 发 question_answer，连接未开时 appSend 返回
 * false 而对话框不看返回值 → 答案丢失，服务端仍挂起提问，重连快照把问卷重新弹出，
 * 用户再答再丢，表现为「按正确的点选还是会弹出来」。
 *
 * 这里锁定三条语义：
 *  1. 送出与否都登记（断开时由下次 ready 重投，用户不必重答）；
 *  2. question_retracted 才算确认，确认后才移除；
 *  3. 有待投答案的问卷不再从快照恢复成弹窗。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAppSend, type AppSend } from "../../web/src/app-globals.js";
import {
	confirmQuestionAnswer,
	hasUnconfirmedAnswer,
	resendUnconfirmedAnswers,
	resetUnconfirmedAnswers,
	sendQuestionAnswer,
	unconfirmedAnswerCount,
} from "../../web/src/question-answer-relay.js";

type AnswerMsg = Parameters<typeof sendQuestionAnswer>[0];

const answer = (id: string, owner?: string): AnswerMsg =>
	({
		type: "question_answer",
		id,
		answers: [{ id: "a", selected: ["A"] }],
		...(owner ? { owner } : {}),
	}) as AnswerMsg;

describe("question-answer-relay", () => {
	let online: boolean;
	let delivered: AnswerMsg[];

	beforeEach(() => {
		online = true;
		delivered = [];
		resetUnconfirmedAnswers();
		const send: AppSend = (msg) => {
			if (!online) return false;
			delivered.push(msg as AnswerMsg);
			return true;
		};
		setAppSend(send);
	});

	afterEach(() => {
		setAppSend(null);
		resetUnconfirmedAnswers();
	});

	it("连接正常：送出并登记，等待确认", () => {
		expect(sendQuestionAnswer(answer("q-1"))).toBe(true);
		expect(delivered).toHaveLength(1);
		expect(hasUnconfirmedAnswer("q-1")).toBe(true);
	});

	it("连接断开：返回 false 但仍登记，重连后自动补发（不丢答案）", () => {
		online = false;
		expect(sendQuestionAnswer(answer("q-1"))).toBe(false);
		expect(delivered).toHaveLength(0);
		// 关键：答案没丢，仍待投递
		expect(hasUnconfirmedAnswer("q-1")).toBe(true);

		online = true;
		resendUnconfirmedAnswers();
		expect(delivered.map((m) => m.id)).toEqual(["q-1"]);
	});

	it("重投是幂等的：服务端已 settle 的答案重复投递无副作用（仍待确认，直到 retracted）", () => {
		sendQuestionAnswer(answer("q-1"));
		resendUnconfirmedAnswers();
		resendUnconfirmedAnswers();
		expect(delivered).toHaveLength(3);
		expect(hasUnconfirmedAnswer("q-1")).toBe(true);
	});

	it("收到 question_retracted 才算确认，确认后才移除", () => {
		sendQuestionAnswer(answer("q-1"));
		confirmQuestionAnswer("q-1");
		expect(hasUnconfirmedAnswer("q-1")).toBe(false);
		// 已确认的不再重投，避免每轮重连都发一遍
		resendUnconfirmedAnswers();
		expect(delivered).toHaveLength(1);
	});

	it("owner 作用域隔离：跨页问卷与本地问卷同号也不互相覆盖", () => {
		sendQuestionAnswer(answer("q-1"));
		sendQuestionAnswer(answer("q-1", "owner-A"));
		expect(unconfirmedAnswerCount()).toBe(2);
		confirmQuestionAnswer("q-1", "owner-A");
		expect(hasUnconfirmedAnswer("q-1")).toBe(true);
		expect(hasUnconfirmedAnswer("q-1", "owner-A")).toBe(false);
	});

	it("重复提交同一张问卷只保留最后一次答案", () => {
		sendQuestionAnswer(answer("q-1"));
		sendQuestionAnswer(answer("q-1"));
		expect(unconfirmedAnswerCount()).toBe(1);
	});

	it("重连时连接又断：全部保留到下次 ready", () => {
		online = false;
		sendQuestionAnswer(answer("q-1"));
		sendQuestionAnswer(answer("q-2"));
		resendUnconfirmedAnswers();
		expect(delivered).toHaveLength(0);
		expect(hasUnconfirmedAnswer("q-1")).toBe(true);
		expect(hasUnconfirmedAnswer("q-2")).toBe(true);
	});
});
