import { describe, expect, it } from "vitest";
import { diffStreamingCues, type StreamingCueConversation } from "../../web/src/streaming-cues.js";

describe("diffStreamingCues", () => {
	it("keeps queued parent continuations in one run and notifies once after draining", () => {
		let previous = new Map([["parent", true]]);
		for (const streaming of [false, true, false, true]) {
			const result = diffStreamingCues(previous, "parent", streaming, [], "parent", true);
			expect(result.finishedConvs).toEqual([]);
			expect(result.startCue).toBe(false);
			previous = result.nextMap;
		}
		const done = diffStreamingCues(previous, "parent", false, [], "parent", false);
		expect(done.finishedConvs.map((c) => c.id)).toEqual(["parent"]);
		expect(diffStreamingCues(done.nextMap, "parent", false, [], "parent").finishedConvs).toEqual([]);
	});

	it("waits for queued work in background conversations without blocking other completions", () => {
		const previous = new Map([
			["parent", true],
			["other", true],
		]);
		const pending = diffStreamingCues(previous, "other", false, [
			{ id: "parent", isStreaming: false, completionPending: true },
			{ id: "other", isStreaming: false },
		]);
		expect(pending.finishedConvs.map((c) => c.id)).toEqual(["other"]);
		const done = diffStreamingCues(pending.nextMap, "other", false, [
			{ id: "parent", isStreaming: false, completionPending: false },
			{ id: "other", isStreaming: false },
		]);
		expect(done.finishedConvs.map((c) => c.id)).toEqual(["parent"]);
	});

	it("uses the active snapshot when its conversation list still reports pending work", () => {
		const done = diffStreamingCues(
			new Map([["parent", true]]),
			"parent",
			false,
			[{ id: "parent", completionPending: true }],
			"parent",
			false,
		);
		expect(done.finishedConvs.map((c) => c.id)).toEqual(["parent"]);
	});

	it("does not play a start cue when work is queued before streaming begins", () => {
		const queued = diffStreamingCues(new Map([["parent", false]]), "parent", false, [], "parent", true);
		expect(queued.startCue).toBe(false);
		expect(queued.finishedConvs).toEqual([]);
	});
	it("preserves subagent identity when regular and subagent turns finish together", () => {
		const result = diffStreamingCues(
			new Map([
				["main", true],
				["child", true],
			]),
			"child",
			false,
			[
				{ id: "main", isStreaming: false },
				{ id: "child", isStreaming: false, isSubagent: true },
			],
		);
		expect(result.finishedConvs).toEqual([
			{ id: "main", title: undefined, isActive: false, isSubagent: false },
			{ id: "child", title: undefined, isActive: true, isSubagent: true },
		]);
	});
	it("首次观察（prevMap === null）不触发任何 cue，仅填充初始状态", () => {
		const convs: StreamingCueConversation[] = [
			{ id: "c1", title: "对话1", isStreaming: false },
			{ id: "c2", title: "对话2", isStreaming: true },
		];
		const res = diffStreamingCues(null, "c1", false, convs);
		expect(res.startCue).toBe(false);
		expect(res.finishedConvs).toEqual([]);
		expect(res.nextMap.get("c1")).toBe(false);
		expect(res.nextMap.get("c2")).toBe(true);
	});

	it("前台活动会话从 false 跃迁到 true → 触发 startCue", () => {
		const prev = new Map([
			["c1", false],
			["c2", false],
		]);
		const convs: StreamingCueConversation[] = [
			{ id: "c1", title: "对话1", isStreaming: true },
			{ id: "c2", title: "对话2", isStreaming: false },
		];
		const res = diffStreamingCues(prev, "c1", true, convs);
		expect(res.startCue).toBe(true);
		expect(res.finishedConvs).toEqual([]);
		expect(res.nextMap.get("c1")).toBe(true);
	});

	it("前台活动会话持续流式输出中 → 不触发任何 cue", () => {
		const prev = new Map([
			["c1", true],
			["c2", false],
		]);
		const convs: StreamingCueConversation[] = [
			{ id: "c1", title: "对话1", isStreaming: true },
			{ id: "c2", title: "对话2", isStreaming: false },
		];
		const res = diffStreamingCues(prev, "c1", true, convs);
		expect(res.startCue).toBe(false);
		expect(res.finishedConvs).toEqual([]);
	});

	it("前台活动会话从 true 跃迁到 false → 触发 finishedConvs 且 isActive 为 true", () => {
		const prev = new Map([
			["c1", true],
			["c2", false],
		]);
		const convs: StreamingCueConversation[] = [
			{ id: "c1", title: "对话1", isStreaming: false },
			{ id: "c2", title: "对话2", isStreaming: false },
		];
		const res = diffStreamingCues(prev, "c1", false, convs);
		expect(res.startCue).toBe(false);
		expect(res.finishedConvs).toEqual([
			{
				id: "c1",
				title: "对话1",
				isActive: true,
				isSubagent: false,
			},
		]);
	});

	it("【核心回归】从正在运行的会话切换到已结束的会话 → 绝对不触发 done，也不触发 start", () => {
		const prev = new Map([
			["c1", true],
			["c2", false],
		]);
		const convs: StreamingCueConversation[] = [
			{ id: "c1", title: "会话1", isStreaming: true },
			{ id: "c2", title: "会话2", isStreaming: false },
		];
		const res = diffStreamingCues(prev, "c2", false, convs);
		expect(res.startCue).toBe(false);
		expect(res.finishedConvs).toEqual([]);
		expect(res.nextMap.get("c1")).toBe(true);
		expect(res.nextMap.get("c2")).toBe(false);
	});

	it("【核心回归】后台会话完成 → 及时触发后台 finishedCue，不因未在看该会话而被漏掉或延迟", () => {
		const prev = new Map([
			["c1", true],
			["c2", false],
		]);
		const convs: StreamingCueConversation[] = [
			{ id: "c1", title: "后台任务会话", isStreaming: false },
			{ id: "c2", title: "当前会话", isStreaming: false },
		];
		const res = diffStreamingCues(prev, "c2", false, convs);
		expect(res.startCue).toBe(false);
		expect(res.finishedConvs).toEqual([
			{
				id: "c1",
				title: "后台任务会话",
				isActive: false,
				isSubagent: false,
			},
		]);
	});

	it("从空闲会话切换到正在后台运行的会话 → 不误响 startCue，也不误响 done", () => {
		const prev = new Map([
			["c1", true],
			["c2", false],
		]);
		const convs: StreamingCueConversation[] = [
			{ id: "c1", title: "后台任务", isStreaming: true },
			{ id: "c2", title: "当前会话", isStreaming: false },
		];
		const res = diffStreamingCues(prev, "c1", true, convs);
		expect(res.startCue).toBe(false);
		expect(res.finishedConvs).toEqual([]);
	});

	it("会话被关闭/移出列表（从 conversations 消失）→ 不误报运行完成", () => {
		const prev = new Map([
			["c1", true],
			["c2", false],
		]);
		const convs: StreamingCueConversation[] = [{ id: "c2", title: "会话2", isStreaming: false }];
		const res = diffStreamingCues(prev, "c2", false, convs);
		expect(res.finishedConvs).toEqual([]);
	});

	it("多个后台会话同时结束 → finishedConvs 包含所有结束的会话", () => {
		const prev = new Map([
			["c1", true],
			["c2", true],
			["c3", false],
		]);
		const convs: StreamingCueConversation[] = [
			{ id: "c1", title: "任务1", isStreaming: false },
			{ id: "c2", title: "任务2", isStreaming: false },
			{ id: "c3", title: "主会话", isStreaming: false },
		];
		const res = diffStreamingCues(prev, "c3", false, convs);
		expect(res.finishedConvs).toHaveLength(2);
		expect(res.finishedConvs.map((f) => f.id)).toEqual(["c1", "c2"]);
	});

	it("【核心回归】切换首拍 + conversations 列表滞后 → 绝不误响 startCue", () => {
		const prev = new Map([
			["c1", false],
			["c2", false],
		]);
		const convs: StreamingCueConversation[] = [
			{ id: "c1", title: "刚开流的后台会话", isStreaming: false },
			{ id: "c2", title: "原会话", isStreaming: false },
		];
		const res = diffStreamingCues(prev, "c1", true, convs, "c2");
		expect(res.startCue).toBe(false);
		expect(res.finishedConvs).toEqual([]);
	});

	it("切换首拍之后（activeId 未再变）正常恢复边沿判定 → startCue 触发", () => {
		const prev = new Map([
			["c1", false],
			["c2", false],
		]);
		const convs: StreamingCueConversation[] = [
			{ id: "c1", title: "当前会话", isStreaming: false },
			{ id: "c2", title: "其他", isStreaming: false },
		];
		const res = diffStreamingCues(prev, "c1", true, convs, "c1");
		expect(res.startCue).toBe(true);
	});

	it("prevActiveId 未传（旧调用方）→ 保持原边沿判定行为", () => {
		const prev = new Map([
			["c1", false],
			["c2", false],
		]);
		const convs: StreamingCueConversation[] = [{ id: "c1", title: "会话1", isStreaming: false }];
		const res = diffStreamingCues(prev, "c1", true, convs);
		expect(res.startCue).toBe(true);
	});
});
