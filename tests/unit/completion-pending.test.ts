import { describe, expect, it, vi } from "vitest";
import { ConversationDelivery } from "../../server/conversation-delivery.js";
import { conversationIdentity } from "../../server/conversation-identity.js";
import { fakeClientSession } from "../helpers/fake-session.js";

function host() {
	const client: any = fakeClientSession();
	Object.assign(client, {
		convs: new Map(),
		subagentNoticeTimers: new Map(),
		subagentTaskPending: () => false,
		emit: vi.fn(),
		getLang: () => "zh",
		emitConversations: vi.fn(),
		flushSnapshot: vi.fn(),
	});
	return client;
}

describe("completion notification lifecycle", () => {
	it("waits for queued prompts, prompt startup and notices owned by another client", () => {
		const client = host();
		const other = host();
		client.allSubagentSessions = () => [other];
		const conv: any = { id: "parent", queueSteering: [], queueFollowUp: [] };
		expect(client.completionPending(conv)).toBe(false);
		for (const field of ["queueSteering", "queueFollowUp"]) {
			conv[field] = ["queued"];
			expect(client.completionPending(conv)).toBe(true);
			conv[field] = [];
		}
		conv.promptInFlight = true;
		expect(client.completionPending(conv)).toBe(true);
		conv.promptInFlight = false;
		// 待发通知挂在对话本身上：谁触发都能看到，不再靠跨 owner 反查 execution key。
		conv.delivery = new ConversationDelivery();
		conv.delivery.park({ tag: "subagent-notice", kind: "subagent-notice", createdAt: 1 });
		expect(client.completionPending(conv)).toBe(true);
		conv.delivery = undefined;
		// 去抖窗口（400ms）里也要显示「待处理」，否则左栏会闪一下。
		other.subagentNoticeTimers.set(conversationIdentity(conv), { timer: null as any, subagents: new Set() });
		expect(client.completionPending(conv)).toBe(true);
		other.subagentNoticeTimers.clear();
		expect(client.completionPending(conv)).toBe(false);
	});

	it.each([false, true])(
		"keeps pending state throughout asynchronous delivery and clears after settlement (reject=%s)",
		async (reject) => {
			const client = host();
			const conv: any = {
				id: "parent",
				autonomousTurnsWithoutUser: 0,
				delivery: new ConversationDelivery(),
				session: { isStreaming: false, isCompacting: false, sendUserMessage: vi.fn(), steer: vi.fn() },
			};
			client.convs.set(conv.id, conv);
			client.activeId = conv.id;
			const child: any = {
				id: "sa-1",
				parentId: conv.id,
				isSubagent: true,
				title: "子任务",
				subagentRunGeneration: 0,
				session: {
					isStreaming: false,
					getLastAssistantText: () => "结论",
					getSessionStats: () => ({ totalMessages: 1 }),
					model: { provider: "mock", id: "m1" },
					agent: { state: { messages: [{ role: "assistant", stopReason: "end_turn" }] } },
				},
			};
			let finish!: () => void;
			const hold = new Promise<void>((resolve) => {
				finish = resolve;
			});
			conv.session.sendUserMessage = vi.fn(async () => {
				await hold;
				if (reject) throw new Error("delivery failed");
			});
			client.parkSubagentNotice(conv, [child]);
			// 投递卡在途：状态必须仍然算「待处理」，不能提前清。
			expect(client.completionPending(conv)).toBe(true);

			finish();
			for (let i = 0; i < 20; i++) await Promise.resolve();
			expect({
				pending: client.completionPending(conv),
				sent: conv.session.sendUserMessage.mock.calls.length,
				// 失败路径必须留一句人话（而不是静默丢），成功路径不该有 warning。
				warnings: client.emit.mock.calls.filter((c: any) => c[0]?.level === "warning").length,
			}).toEqual({ pending: false, sent: 1, warnings: reject ? 1 : 0 });
			// 失败不写「已通知」：下一轮 settle 会重投；成功后才是提交点。
			expect(child.subagentDoneNotified).toBe(reject ? undefined : true);
			expect(client.emitConversations).toHaveBeenCalled();
			expect(client.flushSnapshot).toHaveBeenCalled();
		},
	);

	it("refreshes the current holder after a parent is taken over", () => {
		const source = host();
		const target = host();
		target.activeId = "parent";
		const parent = { id: "parent" };
		target.convs.set(parent.id, parent);
		source.allSubagentSessions = () => [target];
		source.refreshCompletionState(conversationIdentity(parent));
		expect(target.emitConversations).toHaveBeenCalledOnce();
		expect(target.flushSnapshot).toHaveBeenCalledOnce();
		expect(source.emitConversations).not.toHaveBeenCalled();
	});
});
