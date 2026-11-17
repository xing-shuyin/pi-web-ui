import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { SubagentSettleRegistry } from "../../server/subagent-settle.js";
import { ConversationDelivery, runningCompaction } from "../../server/conversation-delivery.js";

/**
 * issues/929 的回归：压缩期间完成通知与 steer 都不能丢。
 * 这些用例刻意只驱动真实实现（投递门 + 意图队列 + drain），
 * 不复制一份逻辑——否则下一次改门就会和测试一起漂移。
 */
function fakeSession(opts: { convs: Record<string, any>; lang?: "zh" | "en" }) {
	const proto = ClientSession.prototype as any;
	const cs: any = {
		disposed: false,
		cwd: "/test",
		convs: new Map(Object.entries(opts.convs)),
		subagentNoticeTimers: new Map(),
		deliverySeq: 0,
		subagentSettle: new SubagentSettleRegistry(),
		emit: vi.fn(),
		emitConversations: vi.fn(),
		flushSnapshot: vi.fn(),
		getLang: () => opts.lang ?? "zh",
		subagentOwnerOf: () => cs,
		subagentCurrentId: (id: string) => id,
		parentExecutionKey: (c: any) => c.parentId,
		parentExecution: (c: any) => {
			const parent = cs.convs.get(c.parentId);
			return parent ? { session: cs, convId: c.parentId, conv: parent } : undefined;
		},
		subagentTaskPending: () => false,
		syncSubagentLedger: () => {},
		assertSubagentWorktreeAdmission: () => {},
		deliveryModeOf: proto.deliveryModeOf,
		deliveryQueue: proto.deliveryQueue,
		deliveryHost: proto.deliveryHost,
		drainDeliveries: proto.drainDeliveries,
		deliverIntent: proto.deliverIntent,
		deliverSubagentNotice: proto.deliverSubagentNotice,
		commitIntent: proto.commitIntent,
		dropIntent: proto.dropIntent,
		reportDroppedIntent: proto.reportDroppedIntent,
		submitText: proto.submitText,
		parkSubagentNotice: proto.parkSubagentNotice,
		flushSubagentNoticeTimer: proto.flushSubagentNoticeTimer,
		scheduleSubagentCompletionNotice: proto.scheduleSubagentCompletionNotice,
		detachSubagentNotice: proto.detachSubagentNotice,
		subagentNoticeStillWanted: proto.subagentNoticeStillWanted,
		refreshCompletionState: proto.refreshCompletionState,
		checkSubagentWakeCircuitBreaker: proto.checkSubagentWakeCircuitBreaker,
		steerSubagentRound: proto.steerSubagentRound,
		startSubagentRound: proto.startSubagentRound,
		parkSteer: proto.parkSteer,
		deliverFromOutside: proto.deliverFromOutside,
		// 交互式 prompt() 走同一道门（压缩期间文本排队）
		conv: undefined,
		pendingBotChat: new Map(),
		botOf: proto.botOf,
		prompt: proto.prompt,
		parkGatedPrompt: proto.parkGatedPrompt,
		resolveExecution: (id: string) => {
			const conv = cs.convs.get(id);
			return conv ? { session: cs, convId: id, conv } : undefined;
		},
	};
	return cs;
}

function parentConv(overrides: Record<string, unknown> = {}) {
	const sendUserMessage = vi.fn().mockResolvedValue(undefined);
	const steer = vi.fn().mockResolvedValue(undefined);
	const conv: any = {
		id: "parent-1",
		cwd: "/test",
		title: "父对话",
		autonomousTurnsWithoutUser: 0,
		session: {
			isStreaming: false,
			isCompacting: false,
			sendUserMessage,
			steer,
			model: { provider: "mock", id: "m1" },
			agent: { state: { messages: [] } },
			getLastAssistantText: () => "父对话输出",
		},
		...overrides,
	};
	return { conv, sendUserMessage, steer };
}

function childConv(id: string, parentId: string, output = "子代理结论") {
	const conv: any = {
		id,
		parentId,
		cwd: "/test",
		title: id,
		isSubagent: true,
		subagentType: "explore",
		subagentRunGeneration: 0,
		session: {
			isStreaming: false,
			isCompacting: false,
			sendUserMessage: vi.fn().mockResolvedValue(undefined),
			steer: vi.fn().mockResolvedValue(undefined),
			model: { provider: "mock", id: "m1" },
			thinkingLevel: "low",
			getLastAssistantText: () => output,
			getSessionStats: () => ({ totalMessages: 1 }),
			agent: { state: { messages: [{ role: "assistant", stopReason: "end_turn" }] } },
		},
	};
	return conv;
}

/** 等微任务链（drain 里的 await）跑完。 */
async function settle(): Promise<void> {
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("issues/929 · 父对话压缩期间的子代理完成通知", () => {
	it("压缩中只入队不投递，也不预扣熔断额度", async () => {
		const { conv: parent, sendUserMessage } = parentConv({ compaction: runningCompaction("manual", 1) });
		const child = childConv("sa-1", parent.id);
		const cs = fakeSession({ convs: { [parent.id]: parent } });
		parent.delivery = new ConversationDelivery();

		cs.parkSubagentNotice(parent, [child]);
		await settle();

		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(child.subagentDoneNotified).toBeUndefined();
		expect(parent.autonomousTurnsWithoutUser).toBe(0);
		expect(parent.delivery.hasKind("subagent-notice")).toBe(true);
	});

	it("压缩结束后（compaction_end 开闸）自动补投一次，并在此刻才记「已通知」", async () => {
		const { conv: parent, sendUserMessage } = parentConv({ compaction: runningCompaction("manual", 1) });
		const child = childConv("sa-1", parent.id);
		const cs = fakeSession({ convs: { [parent.id]: parent } });
		parent.delivery = new ConversationDelivery();

		cs.parkSubagentNotice(parent, [child]);
		await settle();
		expect(child.subagentDoneNotified).toBeUndefined();

		// compaction_end 里做的事：清门 + 排空
		parent.compaction = null;
		await parent.delivery.drain(cs.deliveryHost(parent));
		await settle();

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(String(sendUserMessage.mock.calls[0][0])).toContain("sa-1");
		expect(child.subagentDoneNotified).toBe(true);
		expect(parent.autonomousTurnsWithoutUser).toBe(1);
		expect(parent.delivery.size).toBe(0);
	});

	it("压缩失败/取消同样开闸（错误路径不吞通知）", async () => {
		const { conv: parent, sendUserMessage } = parentConv({ compaction: runningCompaction("manual", 1) });
		const child = childConv("sa-1", parent.id);
		const cs = fakeSession({ convs: { [parent.id]: parent } });
		parent.delivery = new ConversationDelivery();

		cs.parkSubagentNotice(parent, [child]);
		await settle();

		// SDK 在 emit compaction_end 之前就清了自己的标志：这里模拟失败路径。
		parent.compaction = null;
		await parent.delivery.drain(cs.deliveryHost(parent));
		await settle();
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(child.subagentDoneNotified).toBe(true);
	});

	it("SDK 侧仍拒绝提交时留在队列里，不谎报已通知", async () => {
		const { conv: parent } = parentConv();
		const child = childConv("sa-1", parent.id);
		const cs = fakeSession({ convs: { [parent.id]: parent } });
		parent.delivery = new ConversationDelivery();
		parent.session.sendUserMessage = vi
			.fn()
			.mockRejectedValue(
				new Error("Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry."),
			);

		cs.parkSubagentNotice(parent, [child]);
		await settle();

		expect(child.subagentDoneNotified).toBeUndefined();
		expect(parent.delivery.hasKind("subagent-notice")).toBe(true);
	});

	it("同一批多个子代理只发一条通知", async () => {
		const { conv: parent, sendUserMessage } = parentConv({ compaction: runningCompaction("manual", 1) });
		const a = childConv("sa-a", parent.id);
		const b = childConv("sa-b", parent.id);
		const cs = fakeSession({ convs: { [parent.id]: parent } });
		parent.delivery = new ConversationDelivery();

		cs.parkSubagentNotice(parent, [a]);
		cs.parkSubagentNotice(parent, [b]);
		parent.compaction = null;
		await parent.delivery.drain(cs.deliveryHost(parent));
		await settle();

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(String(sendUserMessage.mock.calls[0][0])).toContain("共有 2 个子代理已完成");
		expect(a.subagentDoneNotified).toBe(true);
		expect(b.subagentDoneNotified).toBe(true);
	});

	it("对话已移出：遗留通知如实丢弃并提示，不静默", async () => {
		const { conv: parent } = parentConv({ compaction: runningCompaction("manual", 1) });
		const child = childConv("sa-1", parent.id);
		const cs = fakeSession({ convs: { [parent.id]: parent } });
		parent.delivery = new ConversationDelivery();

		cs.parkSubagentNotice(parent, [child]);
		await settle();

		parent.deliveryClosed = true;
		await parent.delivery.drain(cs.deliveryHost(parent));
		expect(cs.emit).toHaveBeenCalledWith(
			expect.objectContaining({ type: "notice", text: expect.stringContaining("原父对话已关闭") }),
		);
		expect(child.subagentDoneNotified).toBe(true);
	});
});

describe("issues/929 · 子代理压缩期间收到的 steer", () => {
	it("压缩中回执 queued 且不碰 SDK 的 steering 队列", async () => {
		const { conv: parent } = parentConv();
		const child = childConv("sa-1", parent.id);
		child.compaction = runningCompaction("manual", 1);
		const cs = fakeSession({ convs: { [child.id]: child, [parent.id]: parent } });

		const receipt = await cs.steerSubagentRound(child, "改一下 A");

		expect(receipt).toEqual({ state: "queued" });
		expect(child.session.steer).not.toHaveBeenCalled();
		expect(child.session.sendUserMessage).not.toHaveBeenCalled();
		expect(child.delivery?.hasKind("steer")).toBe(true);
	});

	it("压缩结束（门开）后开新一轮：消息真的被送进这个对话", async () => {
		const { conv: parent } = parentConv();
		const child = childConv("sa-1", parent.id);
		child.compaction = runningCompaction("manual", 1);
		const cs = fakeSession({ convs: { [child.id]: child, [parent.id]: parent } });

		await cs.steerSubagentRound(child, "改一下 A");
		child.compaction = null;
		await child.delivery.drain(cs.deliveryHost(child));
		await settle();

		expect(child.session.sendUserMessage).toHaveBeenCalledWith("改一下 A");
		expect(child.subagentRunGeneration).toBe(1);
		expect(child.promptInFlight).toBe(false);
	});

	it("多轮 steer 按到达顺序开轮（FIFO，不合并丢失）", async () => {
		const { conv: parent } = parentConv();
		const child = childConv("sa-1", parent.id);
		child.compaction = runningCompaction("manual", 1);
		const cs = fakeSession({ convs: { [child.id]: child, [parent.id]: parent } });

		await cs.steerSubagentRound(child, "第一条");
		await cs.steerSubagentRound(child, "第二条");
		child.compaction = null;
		await child.delivery.drain(cs.deliveryHost(child));
		await settle();

		const texts = child.session.sendUserMessage.mock.calls.map((call: unknown[]) => call[0]);
		expect(texts).toEqual(["第一条", "第二条"]);
	});

	it("活着的一轮仍然走 steer（不被排队拖到下一轮）", async () => {
		const { conv: parent } = parentConv();
		const child = childConv("sa-1", parent.id);
		child.session.isStreaming = true;
		const cs = fakeSession({ convs: { [child.id]: child, [parent.id]: parent } });

		const receipt = await cs.steerSubagentRound(child, "插队改");

		expect(receipt).toEqual({ state: "delivered" });
		expect(child.session.sendUserMessage).toHaveBeenCalledWith("插队改", { deliverAs: "steer" });
		expect(child.delivery).toBeUndefined();
	});
});

describe("issues/929 · 其它入站投递点同一条门", () => {
	it("插件/角色消息在门关时排队，门开后开一轮", async () => {
		const { conv: target, sendUserMessage } = parentConv({ compaction: runningCompaction("manual", 1) });
		const cs = fakeSession({ convs: { [target.id]: target } });

		expect(await cs.deliverFromOutside(target, "定时任务：检查构建")).toBe("queued");
		expect(sendUserMessage).not.toHaveBeenCalled();

		target.compaction = null;
		await target.delivery.drain(cs.deliveryHost(target));
		await settle();
		expect(sendUserMessage).toHaveBeenCalledWith("定时任务：检查构建");
	});

	it("对话已关闭时外部投递直接失败，不入队", async () => {
		const { conv: target } = parentConv();
		target.deliveryClosed = true;
		const cs = fakeSession({ convs: { [target.id]: target } });

		expect(await cs.deliverFromOutside(target, "hello")).toBe("closed");
		expect(target.delivery).toBeUndefined();
	});
});

describe("issues/929 · 压缩期间用户自己发的文本改成排队（不再让用户重发）", () => {
	function gatedPrompt(overrides: Record<string, unknown> = {}) {
		const { conv: parent, sendUserMessage } = parentConv({
			compaction: runningCompaction("manual", 1),
			...overrides,
		});
		const cs = fakeSession({ convs: { [parent.id]: parent } });
		cs.conv = parent;
		return { parent, sendUserMessage, cs };
	}

	it("压缩中只入队：不提交、也不预支「用户开口了」的会话状态", async () => {
		const { parent, sendUserMessage, cs } = gatedPrompt({
			autonomousTurnsWithoutUser: 3,
			wakeReason: "subagent_completion",
		});

		await cs.prompt("构建失败了我先说一句");

		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(parent.delivery.size).toBe(1);
		expect(parent.delivery.pending[0]).toMatchObject({
			kind: "user-prompt",
			text: "构建失败了我先说一句",
		});
		// 状态延到「真正投出去」的提交点：压缩期间不能当成用户已经开过口。
		expect(parent.autonomousTurnsWithoutUser).toBe(3);
		expect(parent.wakeReason).toBe("subagent_completion");
		expect(cs.flushSnapshot).not.toHaveBeenCalled();
	});

	it("给客户端一条 prompt_queued 回执（乐观回显据此不再按 TTL 消失）", async () => {
		const { parent, cs } = gatedPrompt();

		await cs.prompt("  压缩完接着修 signup  \n");

		expect(cs.emit).toHaveBeenCalledWith({
			type: "prompt_queued",
			conversationId: parent.id,
			text: "压缩完接着修 signup",
		});
		expect(cs.emit).toHaveBeenCalledWith(
			expect.objectContaining({ type: "notice", level: "info", text: expect.stringContaining("已排队") }),
		);
	});

	it("压缩结束（门开）后 drain 只开一轮、正文一致，并在这一刻落「用户开口了」", async () => {
		const { parent, sendUserMessage, cs } = gatedPrompt({
			autonomousTurnsWithoutUser: 3,
			wakeReason: "subagent_completion",
		});

		await cs.prompt("  压缩完接着修 signup  \n");
		await settle();
		expect(sendUserMessage).not.toHaveBeenCalled();

		// compaction_end 里做的事：清门 + 排空
		parent.compaction = null;
		await parent.delivery.drain(cs.deliveryHost(parent));
		await settle();

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(sendUserMessage.mock.calls[0]).toEqual(["压缩完接着修 signup"]);
		expect(parent.delivery.size).toBe(0);
		expect(parent.autonomousTurnsWithoutUser).toBe(0);
		expect(parent.wakeReason).toBe("user");
	});

	it("同一份文本重复发送只排一条，drain 后只发一次", async () => {
		const { parent, sendUserMessage, cs } = gatedPrompt();

		await cs.prompt("继续");
		await cs.prompt("继续");
		await cs.prompt("  继续  ");
		expect(parent.delivery.size).toBe(1);

		parent.compaction = null;
		await parent.delivery.drain(cs.deliveryHost(parent));
		await settle();

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(sendUserMessage).toHaveBeenCalledWith("继续");
	});

	it("带附件仍明确拒绝（附件链路不能在排空时重放），且提示里点名附件", async () => {
		const { parent, sendUserMessage, cs } = gatedPrompt();

		await cs.prompt("看这张图", [{ name: "shot.png", path: "shot.png", mode: "file" }] as any);

		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(parent.delivery).toBeUndefined();
		expect(cs.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "notice",
				level: "warning",
				text: expect.stringContaining("带附件"),
			}),
		);
	});

	it("斜杠命令与派活路由不排队（必须在当次会话状态下当场执行）", async () => {
		const slash = gatedPrompt();
		await slash.cs.prompt("/model gpt");
		expect(slash.parent.delivery).toBeUndefined();
		expect(slash.sendUserMessage).not.toHaveBeenCalled();
		expect(slash.cs.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "notice", level: "warning" }));

		const delegated = gatedPrompt({ delegateMode: true });
		await delegated.cs.prompt("这条要派给执行对话");
		expect(delegated.parent.delivery).toBeUndefined();
		expect(delegated.sendUserMessage).not.toHaveBeenCalled();
	});

	it("排队期间对话被关掉：消息如实报「没送到」，不静默消失", async () => {
		const { parent, cs } = gatedPrompt();

		await cs.prompt("别丢了这条");
		parent.deliveryClosed = true;
		await parent.delivery.drain(cs.deliveryHost(parent));

		expect(cs.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "notice",
				level: "warning",
				text: expect.stringContaining("排队中的消息未能送出"),
			}),
		);
	});
});
