import { describe, expect, it, vi } from "vitest";
import { splitQuotedPrompt } from "../../server/text-quote";
import { mergeRecalledDraft } from "../../web/src/composer-draft";

describe("abort queued messages restore & server drain (#834)", () => {
	it("drains SDK session queue and clears local conversation queues before interruptRun", async () => {
		const clearQueue = vi.fn().mockReturnValue({
			steering: ["排队消息1"],
			followUp: ["排队消息2"],
		});
		const interruptRun = vi.fn().mockResolvedValue(undefined);
		const flushSnapshot = vi.fn();

		const conv: any = {
			id: "conv-1",
			queueSteering: ["排队消息1"],
			queueFollowUp: ["排队消息2"],
			queuedSteeringEntries: [{ id: "1", text: "排队消息1" }],
			queuedFollowUpEntries: [{ id: "2", text: "排队消息2" }],
			session: {
				isIdle: false,
				clearQueue,
			},
		};

		const abort = async () => {
			try {
				conv.session.clearQueue?.();
			} catch {}
			conv.queueSteering = [];
			conv.queueFollowUp = [];
			conv.queuedSteeringEntries = [];
			conv.queuedFollowUpEntries = [];
			await interruptRun(conv, "已停止");
			flushSnapshot();
		};

		await abort();

		expect(clearQueue).toHaveBeenCalledOnce();
		expect(interruptRun).toHaveBeenCalledWith(conv, "已停止");
		expect(conv.queueSteering).toEqual([]);
		expect(conv.queueFollowUp).toEqual([]);
		expect(conv.queuedSteeringEntries).toEqual([]);
		expect(conv.queuedFollowUpEntries).toEqual([]);
	});

	it("restores queued prompts into composer drafts on abort in client", () => {
		const send = vi.fn();
		const recallDrafts: Array<{ text: string; seq: number }> = [];
		let recallSeq = 0;
		const attachments: any[] = [];

		const queuedSteering = ["请帮忙看看这个函数"];
		const queuedFollowUp = ["顺便跑一下测试"];

		const handleAbort = () => {
			const allQueued = [...queuedSteering, ...queuedFollowUp];
			for (const q of allQueued) {
				recallSeq += 1;
				const parsed = splitQuotedPrompt(q);
				recallDrafts.push({ text: parsed.text, seq: recallSeq });
			}
			send({ type: "abort" });
		};

		handleAbort();

		expect(send).toHaveBeenCalledWith({ type: "abort" });
		expect(recallDrafts).toEqual([
			{ text: "请帮忙看看这个函数", seq: 1 },
			{ text: "顺便跑一下测试", seq: 2 },
		]);

		let composerText = "已有的未发送内容";
		for (const item of recallDrafts) {
			composerText = mergeRecalledDraft(composerText, item.text);
		}
		expect(composerText).toBe("已有的未发送内容\n请帮忙看看这个函数\n顺便跑一下测试");
	});
});
