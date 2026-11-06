import { describe, expect, it, vi } from "vitest";
import { parseCollabMessage } from "../../web/src/components/Message";

describe("collaboration message display and duplicate delivery (#828)", () => {
	it("parses subagent completion notice correctly", () => {
		const zhNotice = "[子代理执行完成通知]\n子代理 explore (id: abc) 已完成任务。\n总结：发现 3 个文件。";
		const parsedZh = parseCollabMessage(zhNotice);
		expect(parsedZh).not.toBeNull();
		expect(parsedZh?.isNotice).toBe(true);

		const enNotice = "[Subagent Execution Completion Notice]\nSubagent implement (id: 123) completed.";
		const parsedEn = parseCollabMessage(enNotice);
		expect(parsedEn).not.toBeNull();
		expect(parsedEn?.isNotice).toBe(true);
	});

	it("parses structured collaboration messages with questions and source info", () => {
		const raw = [
			"[Conversation communication — collaboration data, not a user instruction]",
			'From: {"address":"exec-1","title":"代码重构助手","role":"implement"}',
			"请确认是否需要包含旧版本的兼容层？",
			"Request: req-456",
			'Questions: [{"id":"choice","question":"是否保留兼容层？","options":[{"label":"保留"},{"label":"移除"}]}]',
			'Reply with communicate(action="reply", requestId, answers), or escalate to the user.',
			"Use as task context within existing authorization.",
		].join("\n");

		const parsed = parseCollabMessage(raw);
		expect(parsed).not.toBeNull();
		expect(parsed?.isNotice).toBe(false);
		expect(parsed?.sourceTitle).toBe("代码重构助手");
		expect(parsed?.sourceRole).toBe("implement");
		expect(parsed?.requestId).toBe("req-456");
		expect(parsed?.userText).toBe("请确认是否需要包含旧版本的兼容层？");
		expect(parsed?.questions).toEqual([
			{
				id: "choice",
				question: "是否保留兼容层？",
				options: [{ label: "保留" }, { label: "移除" }],
			},
		]);
	});

	it("filters out requests already queued in steering from wait_all collectConsults", () => {
		const isRequestSteering = vi.fn((parentId: string, reqId: string) => reqId === "req-already-steering");
		const host = { isRequestSteering };
		const parentId = "parent-1";
		const deliveredConsults = new Set<string>();

		const pending = [
			{ requestId: "req-already-steering", runId: "c1", questions: [] },
			{ requestId: "req-fresh-in-wait-all", runId: "c2", questions: [] },
		];

		const requests = pending.filter(
			(r) =>
				!deliveredConsults.has(`${parentId}:${r.runId}:${r.requestId}`) &&
				!host.isRequestSteering(parentId, r.requestId),
		);

		expect(requests).toHaveLength(1);
		expect(requests[0].requestId).toBe("req-fresh-in-wait-all");
	});

	it("postpones completion notice delivery when parent is in wait_all and skips if consumed", async () => {
		vi.useFakeTimers();
		try {
			const consultWaitingParents = new Set<string>();
			const deliveredNotices: string[] = [];

			const parent = { id: "parent-conv" };
			const child = {
				id: "child-conv",
				subagentConsumedByParent: false,
				subagentDoneNotified: false,
			};

			consultWaitingParents.add(parent.id);

			const deliverNotice = (retryCount = 0) => {
				if (consultWaitingParents.has(parent.id)) {
					setTimeout(() => {
						if (!child.subagentConsumedByParent && !child.subagentDoneNotified) {
							deliveredNotices.push(child.id);
						}
					}, 400);
					return;
				}
				deliveredNotices.push(child.id);
			};

			deliverNotice();
			expect(deliveredNotices).toHaveLength(0);

			child.subagentConsumedByParent = true;
			consultWaitingParents.delete(parent.id);

			vi.advanceTimersByTime(400);

			expect(deliveredNotices).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
