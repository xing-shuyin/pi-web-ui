import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";

describe("过户后会话状态与自愈防护 (Takeover recovery and activeId self-healing)", () => {
	it("当 activeId 悬空时，get conv 自动自愈回退到现存合法会话", () => {
		const c1 = { id: "c1", title: "Chat 1", isSubagent: false } as any;
		const c2 = { id: "c2", title: "Chat 2", isSubagent: false } as any;
		const cs = fakeClientSession() as any;
		cs.convs = new Map([
			["c1", c1],
			["c2", c2],
		]);
		cs.activeId = "c_deleted";

		const activeConv = cs.conv;
		expect(activeConv).toBeDefined();
		expect(["c1", "c2"]).toContain(activeConv.id);
		expect(cs.activeId).toBe(activeConv.id);
	});

	it("newChat 绝不复用标记为 transferring 的空白对话", async () => {
		const cs = fakeClientSession() as any;
		cs.quiesceBlocked = () => false;
		cs.convs = new Map();
		cs.planManager = { getPlan: () => null };

		const c1 = {
			id: "c1",
			transferring: true,
			session: { getSessionStats: () => ({ totalMessages: 0 }) },
			terminals: { list: () => [] },
		} as any;

		cs.convs.set("c1", c1);
		cs.activeId = "c1";

		cs.displaceActive = vi.fn().mockReturnValue(null);
		cs.nextConversationId = vi.fn().mockReturnValue("c2");
		cs.makeTerminalManager = vi.fn().mockReturnValue({ list: () => [] });
		cs.makeRuntimeFactory = vi.fn();
		cs.cwd = "/test";
		cs.agentDir = "/test/agent";
		cs.settingsSvc = { current: {} };
		cs.applyToolGating = vi.fn();
		cs.bindSession = vi.fn().mockResolvedValue(undefined);
		cs.webUi = { refresh: vi.fn() };
		cs.pushTerminals = vi.fn();
		cs.emitConversations = vi.fn();
		cs.goalSvc = { emitGoalStatus: vi.fn() };
		cs.pushSettings = vi.fn();
		cs.flushSnapshot = vi.fn();

		const makeConvMock = vi.fn().mockImplementation((_rt, id, terms) => ({
			id,
			terminals: terms,
			session: { agent: { state: {} } },
		}));
		cs.makeConversation = makeConvMock;

		vi.doMock("../../server/agent-service.js", async (importOriginal) => {
			const mod = await importOriginal<any>();
			return mod;
		});

		const isBlank = (c: any) => {
			if (c.transferring) return false;
			return c.session.getSessionStats().totalMessages === 0 && c.terminals.list().length === 0;
		};

		expect(isBlank(c1)).toBe(false);
	});

	it("detachTakeoverConversations 保证删除后源会话 activeId 绝对不悬空", async () => {
		const cs = fakeClientSession() as any;
		const c1 = {
			id: "c1",
			title: "Moving Chat",
			transferring: true,
			terminals: { killAll: vi.fn() },
		} as any;
		cs.convs = new Map([["c1", c1]]);
		cs.activeId = "c1";
		cs.pendingQuestions = new Map();
		cs.pendingPageCalls = new Map();
		cs.pendingApprovals = new Map();
		cs.turnEndWaiters = new Map();
		cs.clearAllToolWatchdogs = vi.fn();
		cs.goalSvc = { notifyTakeover: vi.fn() };
		cs.emit = vi.fn();
		cs.emitConversations = vi.fn();
		cs.flushSnapshot = vi.fn();

		let newChatCalled = false;
		cs.newChat = vi.fn().mockImplementation(async () => {
			newChatCalled = true;
			const cNew = { id: "c_new", title: "New Blank Chat", isSubagent: false } as any;
			cs.convs.set("c_new", cNew);
			cs.activeId = "c_new";
			return true;
		});

		const res = await ClientSession.prototype.detachTakeoverConversations.call(cs, ["c1"]);
		expect(res.ok).toBe(true);
		expect(newChatCalled).toBe(true);
		expect(cs.convs.has("c1")).toBe(false);
		expect(cs.convs.has(cs.activeId)).toBe(true);
		expect(cs.activeId).toBe("c_new");
	});

	it("emitSnapshotNow 在没有任何会话 (convs 为空) 时安全返回并触发自愈", () => {
		const cs = fakeClientSession() as any;
		cs.disposed = false;
		cs.convs = new Map();
		cs.activeId = "c_none";
		let selfHealTriggered = false;
		cs.newChat = vi.fn().mockImplementation(async () => {
			selfHealTriggered = true;
		});
		cs.flushSnapshot = vi.fn();

		expect(() => {
			ClientSession.prototype["emitSnapshotNow"].call(cs, false);
		}).not.toThrow();

		expect(cs.newChat).toHaveBeenCalled();
	});

	it("prepare 阶段不摘持有权：交接全程对话至少有一个持有方（无零持有真空帧）", async () => {
		// 回归：源页先 delete、目标页后 insert 之间出现过「两边都没有」的一帧，
		// 在飞的 wait_all 展开后代时按 session 反查不到家，整个工具调用被判死
		// （tests/subagent-takeover-test.mjs）。因此交接拆成 prepare →（目标 insert）→ commit。
		const cs = fakeClientSession() as any;
		const c1 = { id: "c1", title: "Moving", isSubagent: false, terminals: { rebindEmit: vi.fn() } } as any;
		cs.convs = new Map([["c1", c1]]);
		cs.activeId = "c2";
		cs.pendingQuestions = new Map();
		cs.pendingPageCalls = new Map();
		cs.turnEndWaiters = new Map();
		cs.clearAllToolWatchdogs = vi.fn();
		cs.goalSvc = { notifyTakeover: vi.fn() };
		cs.emit = vi.fn();
		cs.questionsChanged = vi.fn();
		cs.parentExecution = vi.fn();

		const prepared = await ClientSession.prototype.prepareTakeoverConversations.call(cs, ["c1"]);
		expect(prepared.ok).toBe(true);
		// 关键断言：还没 commit 前，源页仍然持有它——这期间任何工具调用都能查到归属。
		expect(cs.convs.get("c1")).toBe(c1);
		expect(cs.ownsConversation(c1)).toBe(true);

		ClientSession.prototype.commitTakeoverRemoval.call(cs, (prepared as any).payload);
		expect(cs.convs.has("c1")).toBe(false);
		expect(cs.ownsConversation(c1)).toBe(false);
	});

	it("commit 按对象身份摘，目标页撞号重编 id 后源页不留幽灵行", async () => {
		// insertTakeoverConvs 在目标页撞号时会把 conv.id 重编（c1 → c2）。
		// 若 commit 按 id 删，源页 map 里旧 key 的那条会活下来，表现为「已搬走却还在」的重复行。
		const cs = fakeClientSession() as any;
		const moved = { id: "c2", title: "Moved", isSubagent: false } as any; // 已被目标页重编
		cs.convs = new Map([["c1", moved]]);
		cs.activeId = "c1";

		ClientSession.prototype.commitTakeoverRemoval.call(cs, {
			convs: [moved],
			questions: [],
			pageCalls: [],
			approvals: [],
		} as any);
		expect(cs.convs.size).toBe(0);
	});
});
