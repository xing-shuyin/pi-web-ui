import { describe, expect, it } from "vitest";
import {
	createOptimisticQueueTracker,
	formatOptimisticQueuedPrompt,
	OPTIMISTIC_ECHO_TTL_MS,
	reconcileOptimisticPromptEchoes,
	reconcileOptimisticQueue,
	recordOptimisticPromptEcho,
	recordOptimisticQueueAdd,
	recordOptimisticQueueRemove,
	rollbackUnconfirmedOptimisticAdds,
} from "../../web/src/optimistic-queue";
import { formatStreamingPrompt, splitQuotedPrompt } from "../../server/text-quote";
import type { UiState } from "../../web/src/types";

function makeBaseState(overrides?: Partial<UiState>): UiState {
	return {
		clientId: "c1",
		cwd: "/repo",
		workspaceRoots: [],
		homeDir: "/home/user",
		desktopDir: "/home/user/Desktop",
		sessionId: "s1",
		sessionFile: "/repo/s1.jsonl",
		conversationId: "conv-1",
		isEphemeral: false,
		sandbox: null,
		worktree: null,
		rev: 1,
		streamingMessage: null,
		isStreaming: true,
		model: { id: "m1", name: "Model 1", provider: "p1", vision: true },
		thinkingLevel: "medium",
		availableThinkingLevels: ["low", "medium", "high"],
		queue: { steering: [], followUp: [] },
		errorMessage: undefined,
		retry: null,
		compaction: null,
		pendingQuestion: null,
		actionSuggestions: null,
		pendingApproval: null,
		plan: null,
		planMode: false,
		delegateMode: false,
		delegateConvId: null,
		agentPreset: { id: "standard", name: "全功能", locked: true },
		permission: "workspace-write-never",
		tools: [],
		version: 1,
		piConfigured: true,
		piAgentInstalled: true,
		stats: {
			totalMessages: 1,
			tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
			cost: 0,
			contextUsage: { tokens: 15, contextWindow: 128000, percent: 0.01 },
		},
		messages: [
			{
				id: "u-1",
				role: "user",
				content: [{ type: "text", text: "初始问题" }],
				timestamp: 1000,
			},
		],
		...overrides,
	};
}

describe("前端排队与插队消息乐观更新与快照对账 (optimistic-queue)", () => {
	it("流式期间按 Enter（steer）与点排队（followUp）立即在本地生成乐观排队气泡", () => {
		const tracker0 = createOptimisticQueueTracker();
		const state0 = makeBaseState();

		const step1 = recordOptimisticQueueAdd(tracker0, state0, {
			text: "先停一下，优先修这个 bug",
			queue: false,
			engine: "pi",
			now: 1000,
		});
		expect(step1.state?.queue.steering).toEqual(["先停一下，优先修这个 bug"]);
		expect(step1.state?.queue.followUp).toEqual([]);
		expect(step1.tracker.adds).toHaveLength(1);

		const step2 = recordOptimisticQueueAdd(step1.tracker, step1.state, {
			text: "跑完后再帮我补一下单测",
			queue: true,
			engine: "pi",
			now: 1010,
		});
		expect(step2.state?.queue.steering).toEqual(["先停一下，优先修这个 bug"]);
		expect(step2.state?.queue.followUp).toEqual(["跑完后再帮我补一下单测"]);
		expect(step2.tracker.adds).toHaveLength(2);
	});

	it("在途旧快照（早于服务端入队处理）到达时不冲掉乐观气泡，服务端确认后无缝交接且不重复", () => {
		const tracker0 = createOptimisticQueueTracker();
		const state0 = makeBaseState();

		const added = recordOptimisticQueueAdd(tracker0, state0, {
			text: "插队消息 A",
			queue: false,
			now: 1000,
		});
		expect(added.state?.queue.steering).toEqual(["插队消息 A"]);

		const staleServerSnapshot = makeBaseState({
			rev: 2,
			queue: { steering: [], followUp: [] },
		});
		const afterStale = reconcileOptimisticQueue(added.tracker, staleServerSnapshot, 1020);
		expect(afterStale.state.queue.steering).toEqual(["插队消息 A"]);
		expect(afterStale.tracker.adds).toHaveLength(1);

		const confirmedServerSnapshot = makeBaseState({
			rev: 3,
			queue: { steering: ["插队消息 A"], followUp: [] },
		});
		const afterConfirmed = reconcileOptimisticQueue(afterStale.tracker, confirmedServerSnapshot, 1050);
		expect(afterConfirmed.state.queue.steering).toEqual(["插队消息 A"]);
		expect(afterConfirmed.tracker.adds).toHaveLength(0);
	});

	it("支持连续发送两条完全相同的排队/插队文字（如连续两次发“继续”），逐条核销不吞不重", () => {
		const tracker0 = createOptimisticQueueTracker();
		const stateWithOne = makeBaseState({
			queue: { steering: ["继续"], followUp: [] },
		});

		const addedSecond = recordOptimisticQueueAdd(tracker0, stateWithOne, {
			text: "继续",
			queue: false,
			now: 2000,
		});
		expect(addedSecond.state?.queue.steering).toEqual(["继续", "继续"]);
		expect(addedSecond.tracker.adds[0]?.baselineQueueMatches).toBe(1);

		const staleSnap = makeBaseState({
			rev: 2,
			queue: { steering: ["继续"], followUp: [] },
		});
		const rec1 = reconcileOptimisticQueue(addedSecond.tracker, staleSnap, 2010);
		expect(rec1.state.queue.steering).toEqual(["继续", "继续"]);
		expect(rec1.tracker.adds).toHaveLength(1);

		const confirmedSnap = makeBaseState({
			rev: 3,
			queue: { steering: ["继续", "继续"], followUp: [] },
		});
		const rec2 = reconcileOptimisticQueue(rec1.tracker, confirmedSnap, 2030);
		expect(rec2.state.queue.steering).toEqual(["继续", "继续"]);
		expect(rec2.tracker.adds).toHaveLength(0);
	});

	it("带引用与图片/文件附件的流式提问在乐观阶段即可解析展示，且兼容服务端视觉桥重写", () => {
		const formatted = formatOptimisticQueuedPrompt("请看图和引用", [
			{
				path: "",
				mode: "quote",
				quote: { text: "const x = 1;", messageId: "m1", role: "assistant" },
			},
			{
				path: "src/index.ts",
				mode: "lines",
				lines: { start: 10, end: 20 },
			},
			{
				path: "",
				imageData: "data:image/png;base64,AAA",
				name: "shot.png",
			},
		]);

		const parsed = splitQuotedPrompt(formatted);
		expect(parsed.text).toBe("请看图和引用");
		expect(parsed.quotes).toHaveLength(1);
		expect(parsed.attachments).toEqual([
			{ type: "image", name: "shot.png" },
			{ type: "file", name: "index.ts", path: "src/index.ts", lines: { start: 10, end: 20 } },
		]);

		const tracker0 = createOptimisticQueueTracker();
		const state0 = makeBaseState();
		const added = recordOptimisticQueueAdd(tracker0, state0, {
			text: "请看图和引用",
			attachments: [
				{
					path: "",
					mode: "quote",
					quote: { text: "const x = 1;", messageId: "m1", role: "assistant" },
				},
				{
					path: "",
					imageData: "data:image/png;base64,AAA",
					name: "shot.png",
				},
			],
			queue: false,
			now: 3000,
		});

		const serverFormattedWithVisionBridge = formatStreamingPrompt(
			"请看图和引用",
			["<vision-bridge>\n这是一张报错截图\n</vision-bridge>"],
			[{ text: "const x = 1;", messageId: "m1", role: "assistant" }],
			["shot.png"],
		);
		const serverSnap = makeBaseState({
			rev: 2,
			queue: { steering: [serverFormattedWithVisionBridge], followUp: [] },
		});
		const reconciled = reconcileOptimisticQueue(added.tracker, serverSnap, 3500);
		expect(reconciled.state.queue.steering).toEqual([serverFormattedWithVisionBridge]);
		expect(reconciled.tracker.adds).toHaveLength(0);
	});

	it("点击 ✕ 或 ↩（queue_remove）立即移除气泡，且抵消在途旧快照的闪回", () => {
		const tracker0 = createOptimisticQueueTracker();
		const state0 = makeBaseState({
			queue: { steering: [], followUp: ["待撤回消息"] },
		});

		const removed = recordOptimisticQueueRemove(tracker0, state0, {
			kind: "followUp",
			text: "待撤回消息",
			index: 0,
			now: 4000,
		});
		expect(removed.state?.queue.followUp).toEqual([]);
		expect(removed.tracker.removes).toHaveLength(1);

		const staleSnap = makeBaseState({
			rev: 2,
			queue: { steering: [], followUp: ["待撤回消息"] },
		});
		const afterStale = reconcileOptimisticQueue(removed.tracker, staleSnap, 4050);
		expect(afterStale.state.queue.followUp).toEqual([]);
		expect(afterStale.tracker.removes).toHaveLength(1);

		const confirmedSnap = makeBaseState({
			rev: 3,
			queue: { steering: [], followUp: [] },
		});
		const afterConfirmed = reconcileOptimisticQueue(afterStale.tracker, confirmedSnap, 4100);
		expect(afterConfirmed.state.queue.followUp).toEqual([]);
		expect(afterConfirmed.tracker.removes).toHaveLength(0);
	});

	it("服务端返回 error / warning 通知时立即回滚未落账的乐观气泡", () => {
		const tracker0 = createOptimisticQueueTracker();
		const state0 = makeBaseState();
		const added = recordOptimisticQueueAdd(tracker0, state0, {
			text: "将被拒绝的消息",
			queue: false,
			now: 5000,
		});
		expect(added.state?.queue.steering).toEqual(["将被拒绝的消息"]);

		const rolled = rollbackUnconfirmedOptimisticAdds(added.tracker, added.state);
		expect(rolled.state?.queue.steering).toEqual([]);
		expect(rolled.tracker.adds).toHaveLength(0);
	});

	it("非流式态、斜杠命令、审查者模式（delegateMode）与目标审查回合 steer 不产生错误乐观入队", () => {
		const tracker0 = createOptimisticQueueTracker();

		const idleState = makeBaseState({ isStreaming: false });
		expect(recordOptimisticQueueAdd(tracker0, idleState, { text: "普通消息" }).tracker.adds).toHaveLength(0);

		const streamingState = makeBaseState({ isStreaming: true });
		expect(recordOptimisticQueueAdd(tracker0, streamingState, { text: "/compact" }).tracker.adds).toHaveLength(0);

		const delegateState = makeBaseState({ isStreaming: true, delegateMode: true });
		expect(recordOptimisticQueueAdd(tracker0, delegateState, { text: "转交执行会话" }).tracker.adds).toHaveLength(0);

		expect(
			recordOptimisticQueueAdd(tracker0, streamingState, {
				text: "审查中插话",
				queue: false,
				goalReviewing: true,
			}).tracker.adds,
		).toHaveLength(0);
	});

	it("空闲态发送立即本地回显用户气泡，快照落账后无缝消解不重复", () => {
		const tracker0 = createOptimisticQueueTracker();
		const idleState = makeBaseState({ isStreaming: false, rev: 1 });

		const sent = recordOptimisticPromptEcho(tracker0, idleState, { text: "你好", now: 1000 });
		expect(sent.state).not.toBeNull();
		expect(sent.state!.messages).toHaveLength(2);
		const echo = sent.state!.messages[1];
		expect(echo.id.startsWith("echo-")).toBe(true);
		expect(echo.role).toBe("user");
		expect(echo.content).toEqual([{ type: "text", text: "你好" }]);
		expect(sent.tracker.echoes).toHaveLength(1);
		expect(sent.tracker.echoes[0].baselineUserMsgMatches).toBe(0);

		const staleSnap = makeBaseState({ isStreaming: false, rev: 1 });
		const afterStale = reconcileOptimisticPromptEchoes(sent.tracker, staleSnap, 1100);
		expect(afterStale.state.messages).toHaveLength(2);
		expect(afterStale.tracker.echoes).toHaveLength(1);

		const landedSnap = makeBaseState({
			isStreaming: false,
			rev: 2,
			messages: [
				{ id: "u-1", role: "user", content: [{ type: "text", text: "初始问题" }], timestamp: 1000 },
				{ id: "u-2", role: "user", content: [{ type: "text", text: "你好" }], timestamp: 1100 },
			],
		});
		const afterLanded = reconcileOptimisticPromptEchoes(sent.tracker, landedSnap, 1200);
		expect(afterLanded.state.messages.map((m) => m.id)).toEqual(["u-1", "u-2"]);
		expect(afterLanded.tracker.echoes).toHaveLength(0);

		const sent2 = recordOptimisticPromptEcho(createOptimisticQueueTracker(), makeBaseState({ isStreaming: false }), {
			text: "会被拒绝的消息",
			now: 2000,
		});
		const rolled = rollbackUnconfirmedOptimisticAdds(sent2.tracker, sent2.state);
		expect(rolled.state?.messages).toHaveLength(1);
		expect(rolled.tracker.echoes).toHaveLength(0);

		const sent3 = recordOptimisticPromptEcho(createOptimisticQueueTracker(), makeBaseState({ isStreaming: false }), {
			text: "落账慢的消息",
			now: 3000,
		});
		const expired = reconcileOptimisticPromptEchoes(sent3.tracker, sent3.state!, 3000 + OPTIMISTIC_ECHO_TTL_MS + 1);
		expect(expired.state.messages).toHaveLength(1);
		expect(expired.tracker.echoes).toHaveLength(0);
	});

	it("跨会话回显按 TTL 过期：切走再回来不再幽灵展示（issue #705）", () => {
		const tracker0 = createOptimisticQueueTracker();
		const convA = makeBaseState({ isStreaming: false, conversationId: "conv-A" });
		const sent = recordOptimisticPromptEcho(tracker0, convA, { text: "A 的待确认消息", now: 1000 });
		expect(sent.tracker.echoes).toHaveLength(1);
		const convB = makeBaseState({ isStreaming: false, conversationId: "conv-B" });
		const onB = reconcileOptimisticPromptEchoes(sent.tracker, convB, 1100);
		expect(onB.state.messages.some((m) => m.id.startsWith("echo-"))).toBe(false);
		expect(onB.tracker.echoes).toHaveLength(1);
		const backA = makeBaseState({ isStreaming: false, conversationId: "conv-A" });
		const expired = reconcileOptimisticPromptEchoes(onB.tracker, backA, 1000 + OPTIMISTIC_ECHO_TTL_MS + 1);
		expect(expired.state.messages.some((m) => m.id.startsWith("echo-"))).toBe(false);
		expect(expired.tracker.echoes).toHaveLength(0);
	});

	it("基线计数防误消解：先前已有同文本消息时，回显气泡等待新落账的那一条", () => {
		const stateWithDup = makeBaseState({
			isStreaming: false,
			messages: [{ id: "u-1", role: "user", content: [{ type: "text", text: "你好" }], timestamp: 900 }],
		});
		const sent = recordOptimisticPromptEcho(createOptimisticQueueTracker(), stateWithDup, { text: "你好", now: 1000 });
		expect(sent.tracker.echoes[0].baselineUserMsgMatches).toBe(1);

		const staleSnap = makeBaseState({
			isStreaming: false,
			messages: [{ id: "u-1", role: "user", content: [{ type: "text", text: "你好" }], timestamp: 900 }],
		});
		const afterStale = reconcileOptimisticPromptEchoes(sent.tracker, staleSnap, 1100);
		expect(afterStale.tracker.echoes).toHaveLength(1);

		const landedSnap = makeBaseState({
			isStreaming: false,
			messages: [
				{ id: "u-1", role: "user", content: [{ type: "text", text: "你好" }], timestamp: 900 },
				{ id: "u-2", role: "user", content: [{ type: "text", text: "你好" }], timestamp: 1100 },
			],
		});
		const afterLanded = reconcileOptimisticPromptEchoes(sent.tracker, landedSnap, 1200);
		expect(afterLanded.state.messages.map((m) => m.id)).toEqual(["u-1", "u-2"]);
		expect(afterLanded.tracker.echoes).toHaveLength(0);
	});

	it("流式启动的快照会剥离残留回显气泡（防幽灵消息）", () => {
		const tracker0 = createOptimisticQueueTracker();
		const idleState = makeBaseState({ isStreaming: false });
		const sent = recordOptimisticPromptEcho(tracker0, idleState, { text: "触发流式的消息", now: 1000 });
		expect(sent.state!.messages).toHaveLength(2);

		const streamingSnap = makeBaseState({
			isStreaming: true,
			rev: 5,
			messages: [{ id: "u-1", role: "user", content: [{ type: "text", text: "初始问题" }], timestamp: 1000 }],
		});
		const after = reconcileOptimisticPromptEchoes(sent.tracker, streamingSnap, 1100);
		expect(after.state.messages.map((m) => m.id)).toEqual(["u-1"]);
		expect(after.tracker.echoes).toHaveLength(0);
	});
});
