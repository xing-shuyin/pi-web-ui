import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeClientSession } from "../helpers/fake-session.js";

const CWD = resolve("lru-test-project");

function client(): any {
	const cs = Object.assign(fakeClientSession(), {
		activeId: "A",
		convs: new Map<string, any>(),
		creatingConversations: new Map<string, number>(),
		settingsSvc: { current: {} },
		emit: vi.fn(),
		emitConversations: vi.fn(),
		parentExecution: vi.fn(() => undefined),
		allSubagentSessions: () => [],
	});
	cs.removeConversation = vi.fn((id: string) => {
		if (id !== cs.activeId) cs.convs.delete(id);
	});
	return cs;
}

function conv(id: string, opts: Record<string, unknown> = {}): any {
	return {
		id,
		cwd: CWD,
		title: id,
		lastActiveAt: 0,
		viewOnly: true,
		session: { isStreaming: false, isCompacting: false, sessionFile: undefined },
		terminals: { countBlockingLive: () => 0 },
		goal: { reviewing: false },
		wizardRunning: false,
		...opts,
	};
}

function add(cs: any, ...convs: any[]) {
	for (const c of convs) cs.convs.set(c.id, c);
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("recycleFinishedSubagents（issue #944 根因 3）", () => {
	function recycleClient() {
		const cs: any = client();
		cs.conversationsWithChildren = () => new Set();
		cs.deliveryModeOf = () => "idle";
		cs.subagentTaskPending = () => false;
		return cs;
	}

	function subagent(id: string, opts: Record<string, unknown> = {}): any {
		return conv(id, {
			isSubagent: true,
			lastActiveAt: 0,
			lastSdkEventAt: 0,
			notifyOnDone: true,
			subagentDoneNotified: true,
			...opts,
		});
	}

	it("回收空闲够久且结果已交付的子代理，保留活着的 / 等结果的 / 钉住的 / 刚结束的", () => {
		const cs = recycleClient();
		const now = 60 * 60_000;
		add(
			cs,
			conv("A"),
			subagent("done-long-ago"),
			subagent("still-streaming", { session: { isStreaming: true, isCompacting: false } }),
			subagent("awaiting-delivery", { subagentDoneNotified: false, subagentConsumedByParent: false }),
			subagent("pinned", { pinned: true }),
			subagent("just-finished", { lastActiveAt: now - 60_000, lastSdkEventAt: now - 60_000 }),
		);

		expect(cs.recycleFinishedSubagents(now)).toBe(1);
		expect(cs.removeConversation.mock.calls.map((c: unknown[]) => c[0])).toEqual(["done-long-ago"]);
		expect(cs.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "notice", level: "info" }));
	});

	it("空闲时长不够的一个也不回收", () => {
		const cs = recycleClient();
		const now = 60_000;
		add(cs, conv("A"), subagent("fresh", { lastActiveAt: now - 1000, lastSdkEventAt: now - 1000 }));
		expect(cs.recycleFinishedSubagents(now)).toBe(0);
		expect(cs.removeConversation).not.toHaveBeenCalled();
	});

	it("有存活子代的父级不被回收（反向索引一次算出）", () => {
		const cs = recycleClient();
		const now = 60 * 60_000;
		const parent = subagent("parent");
		add(cs, conv("A"), parent);
		cs.conversationsWithChildren = () => new Set([parent]);
		expect(cs.recycleFinishedSubagents(now)).toBe(0);
		expect(cs.removeConversation).not.toHaveBeenCalled();
	});
});

describe("makeRoomForConversation", () => {
	it("默认上限有限：超过默认值后自动收起空闲对话，而不是无限常驻（issue #944）", () => {
		vi.stubEnv("PI_WEB_MAX_OPEN_CONVERSATIONS", undefined);
		const cs = client();
		add(cs, conv("A"), ...Array.from({ length: 16 }, (_, i) => conv(`history-${i}`, { lastActiveAt: i + 1 })));
		const predict = vi.fn(() => false);

		expect(cs.makeRoomForConversation(CWD, 1, predict)).toBe(true);
		// 默认 12 个名额：17 个对话 + 新建 1 个 = 18，超 6 个，收起 6 个最旧的（剩 11 + 新建 = 12）。
		expect(cs.convs.size).toBe(11);
		expect(cs.removeConversation.mock.calls.map((c: unknown[]) => c[0])).toEqual([
			"history-0",
			"history-1",
			"history-2",
			"history-3",
			"history-4",
			"history-5",
		]);
		expect(cs.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "notice", level: "info" }));
	});

	it("钉住的对话不占自动名额，也不会被收起", () => {
		vi.stubEnv("PI_WEB_MAX_OPEN_CONVERSATIONS", "2");
		const cs = client();
		add(
			cs,
			conv("A"),
			conv("pinned-1", { pinned: true, lastActiveAt: 1 }),
			conv("pinned-2", { pinned: true, lastActiveAt: 2 }),
			conv("pinned-3", { pinned: true, lastActiveAt: 3 }),
		);
		expect(cs.makeRoomForConversation(CWD, 1)).toBe(true);
		expect(cs.removeConversation).not.toHaveBeenCalled();
	});

	it("按 lastActiveAt 从旧到新收起空闲对话，跳过钉住 / 流式 / 当前", () => {
		vi.stubEnv("PI_WEB_MAX_OPEN_CONVERSATIONS", "4");
		const cs = client();
		add(
			cs,
			conv("A", { lastActiveAt: 1, viewOnly: true }),
			conv("pinned", { lastActiveAt: 2, pinned: true }),
			conv("streaming", { lastActiveAt: 3, session: { isStreaming: true, isCompacting: false } }),
			// issue #944：跟你在里面说过话的对话不再永久常驻，空闲了同样可进 LRU（转录在磁盘、历史行保留）。
			conv("chatted", { lastActiveAt: 4, viewOnly: false }),
			conv("old", { lastActiveAt: 5 }),
			conv("newer", { lastActiveAt: 6 }),
			conv("newest", { lastActiveAt: 7 }),
		);
		expect(cs.makeRoomForConversation(CWD, 1)).toBe(true);
		expect(cs.removeConversation.mock.calls.map((c: unknown[]) => c[0])).toEqual(["chatted", "old", "newer"]);
	});

	it("只收起够用的数量，并发出一条提示", () => {
		vi.stubEnv("PI_WEB_MAX_OPEN_CONVERSATIONS", "3");
		const cs = client();
		add(
			cs,
			conv("A", { viewOnly: false, lastActiveAt: 9 }),
			conv("v1", { lastActiveAt: 2 }),
			conv("v2", { lastActiveAt: 1 }),
		);
		expect(cs.makeRoomForConversation(CWD, 1)).toBe(true);
		expect(cs.removeConversation.mock.calls.map((c: unknown[]) => c[0])).toEqual(["v2"]);
		expect(cs.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "notice", level: "info" }));
		expect(cs.emitConversations).toHaveBeenCalledTimes(1);
	});

	it("未超额：不评估当前对话释放预测，也不收起任何对话", () => {
		vi.stubEnv("PI_WEB_MAX_OPEN_CONVERSATIONS", "8");
		const cs = client();
		add(cs, conv("A"), conv("v1"));
		const predict = vi.fn(() => true);
		expect(cs.makeRoomForConversation(CWD, 1, predict)).toBe(true);
		expect(predict).not.toHaveBeenCalled();
		expect(cs.removeConversation).not.toHaveBeenCalled();
	});

	it("当前对话将被切走释放时计入一个名额（无需收起别的对话）", () => {
		vi.stubEnv("PI_WEB_MAX_OPEN_CONVERSATIONS", "2");
		const cs = client();
		add(cs, conv("A", { viewOnly: false }), conv("v1"));
		expect(cs.makeRoomForConversation(CWD, 1, () => true)).toBe(true);
		expect(cs.removeConversation).not.toHaveBeenCalled();
	});

	it("其他项目、子代理、临时对话不占本项目名额，也不会被收起", () => {
		vi.stubEnv("PI_WEB_MAX_OPEN_CONVERSATIONS", "2");
		const cs = client();
		add(
			cs,
			conv("A", { viewOnly: false }),
			conv("elsewhere", { cwd: resolve("other-project"), lastActiveAt: 0 }),
			conv("sub", { isSubagent: true }),
			conv("tmp", { isEphemeral: true }),
		);
		expect(cs.makeRoomForConversation(CWD, 1)).toBe(true);
		expect(cs.removeConversation).not.toHaveBeenCalled();
	});

	it("有存活子代理、终端在用、投递中的对话不收起", () => {
		vi.stubEnv("PI_WEB_MAX_OPEN_CONVERSATIONS", "1");
		const cs = client();
		const parent = conv("parent", { lastActiveAt: 1 });
		const child = conv("child", { isSubagent: true });
		add(
			cs,
			conv("A", { viewOnly: false }),
			parent,
			child,
			conv("term", { lastActiveAt: 2, terminals: { countBlockingLive: () => 1 } }),
			conv("inflight", { lastActiveAt: 3, promptInFlight: true }),
		);
		cs.parentExecution = vi.fn((c: any) => (c === child ? { conv: parent } : undefined));
		expect(cs.makeRoomForConversation(CWD, 1)).toBe(false);
		expect(cs.removeConversation).not.toHaveBeenCalled();
	});
});
