import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { ChatModePort, GoalRunPort } from "../../packages/keel/src/contracts/goals.js";
import type { ServerMessage } from "../../packages/keel/src/protocol.js";
import {
	PlanStore,
	clampGoalRounds,
	createGoalHandlers,
	mergeGoalPrefs,
	type GoalHandlers,
} from "../../packages/keel/src/domains/goals/index.js";
import { createFakeSettingsStore, type FakeSettingsStore } from "../helpers/fake-settings-store.js";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "keel-goals-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
	handlers: GoalHandlers;
	sent: ServerMessage[];
	store: FakeSettingsStore;
	plans: PlanStore;
	feeds: string[];
}

function harness(
	options: {
		plans?: PlanStore;
		withPrefs?: boolean;
		goalMode?: boolean;
		goalRun?: GoalRunPort;
		chatMode?: ChatModePort;
	} = {},
): Harness {
	const sent: ServerMessage[] = [];
	const store = createFakeSettingsStore();
	// 出厂默认是关的（`DEFAULT_CLIENT_SETTINGS.goalModeEnabled`）：除「模式没开」那条外用例都得先开。
	if (options.goalMode !== false) store.saveSettings("c1", { goalModeEnabled: true });
	const plans = options.plans ?? new PlanStore({ now: () => 1000 });
	const feeds: string[] = [];
	const handlers = createGoalHandlers({
		plans: () => plans,
		...(options.withPrefs === false ? {} : { prefs: () => store }),
		clientId: "c1",
		activeConversationId: () => "conv-1",
		emit: (msg) => void sent.push(msg),
		flushSnapshot: () => {},
		openConversation: () => "conv-2",
		feed: async (text) => void feeds.push(text),
		...(options.goalRun ? { goalRun: () => options.goalRun } : {}),
		...(options.chatMode ? { chatMode: () => options.chatMode } : {}),
	});
	return { handlers, sent, store, plans, feeds };
}

const planFrames = (sent: ServerMessage[]) => sent.filter((m) => m.type === "plan_updated");
const goalFrames = (sent: ServerMessage[]) => sent.filter((m) => m.type === "goal_status");
const notices = (sent: ServerMessage[]) => sent.filter((m) => m.type === "notice");

describe("计划状态的所有者（PlanStore）", () => {
	it("归一化：非法状态回落 pending、标题/描述截断、activeStepId 缺省取第一个在跑的步骤", () => {
		const store = new PlanStore({ now: () => 42 });
		const plan = store.setPlan("conv-1", [
			{ id: "", title: "x".repeat(300), status: "bogus" as never, description: "d".repeat(2000) },
			{ id: "s2", title: "跑起来", status: "in_progress" },
		]);
		expect(plan.steps[0].id).toBe("step-1");
		expect(plan.steps[0].status).toBe("pending");
		expect(plan.steps[0].title.length).toBe(200);
		expect(plan.steps[0].description?.length).toBe(1000);
		expect(plan.activeStepId).toBe("s2");
		expect(plan.updatedAt).toBe(42);
	});

	it("落盘按会话 id 记账：写盘后新实例读得回来（对话 id 不落盘）", async () => {
		const file = join(tempDir(), "plans.json");
		const first = new PlanStore({ file });
		first.setPlan("conv-1", [{ id: "a", title: "第一步", status: "done" }], null, "sess-1");
		first.setPlan("conv-9", [{ id: "b", title: "不落盘", status: "pending" }]);
		await first.flush();

		const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		expect(Object.keys(raw)).toEqual(["sess-1"]);

		const second = new PlanStore({ file });
		expect(second.getPlan("conv-1", "sess-1")?.steps[0].title).toBe("第一步");
		expect(second.getPlan("conv-9")).toBeNull();
	});

	it("步骤操作：在跑 = 接棒焦点，离开焦点 = 往后找第一个未完成；删除/插入保持顺序", () => {
		const store = new PlanStore({ now: () => 1 });
		store.setPlan("conv-1", [
			{ id: "a", title: "A", status: "pending" },
			{ id: "b", title: "B", status: "pending" },
		]);
		expect(store.updateStep("conv-1", "b", { status: "in_progress" })?.activeStepId).toBe("b");
		const afterDone = store.updateStep("conv-1", "b", { status: "done" });
		expect(afterDone?.steps[1].status).toBe("done");
		expect(afterDone?.activeStepId).toBe("a");

		const added = store.addStep("conv-1", { id: "c", title: "C", status: "pending" }, "a");
		expect(added?.steps.map((step) => step.id)).toEqual(["a", "c", "b"]);

		const removed = store.deleteStep("conv-1", "a");
		expect(removed?.steps.map((step) => step.id)).toEqual(["c", "b"]);
		expect(store.updateStep("conv-1", "nope", { status: "done" })).toBeNull();
	});

	it("describePlan 给工具上下文的人读摘要", () => {
		const store = new PlanStore({ now: () => 1 });
		expect(store.describePlan("conv-1")).toBe("No active plan.");
		store.setPlan(
			"conv-1",
			[
				{ id: "a", title: "A", status: "done" },
				{ id: "b", title: "B", status: "in_progress", description: "细节" },
			],
			"b",
		);
		const text = store.describePlan("conv-1");
		expect(text).toContain("Plan Progress: 1/2 completed");
		expect(text).toContain("[x] 1. A");
		expect(text).toContain("[>] 2. B (current)");
		expect(text).toContain("     细节");
	});
});

describe("计划 handler（plan_update / plan_step_*）", () => {
	it("四个写入口都落状态、发 plan_updated、刷快照", () => {
		const h = harness();
		let flushed = 0;
		const handlers = createGoalHandlers({
			plans: () => h.plans,
			prefs: () => h.store,
			clientId: "c1",
			activeConversationId: () => "conv-1",
			emit: (msg) => void h.sent.push(msg),
			flushSnapshot: () => void (flushed += 1),
		});

		handlers.updatePlan([{ id: "a", title: "A", status: "pending" }], null);
		handlers.updatePlanStep("a", { status: "in_progress" });
		handlers.addPlanStep({ id: "b", title: "B", status: "pending" }, "a");
		handlers.deletePlanStep("b");

		const frames = planFrames(h.sent);
		expect(frames).toHaveLength(4);
		expect(frames[0]).toMatchObject({ type: "plan_updated", conversationId: "conv-1" });
		expect(flushed).toBe(4);
		expect(h.plans.getPlan("conv-1")?.steps.map((step) => step.id)).toEqual(["a"]);
	});

	it("显式 conversationId 覆盖当前对话；没有对话也不带 id 就报错（不猜）", () => {
		const h = harness();
		h.handlers.updatePlan([{ id: "a", title: "A", status: "pending" }], null, "conv-9");
		expect(planFrames(h.sent)[0]).toMatchObject({ conversationId: "conv-9" });

		const orphan = createGoalHandlers({
			plans: () => h.plans,
			clientId: "c1",
			activeConversationId: () => undefined,
			emit: () => {},
			flushSnapshot: () => {},
		});
		expect(() => orphan.updatePlan([], null)).toThrow(CoreEngineNotReadyError);
	});

	it("步骤已不存在（并发删 / 换了对话）：回落到当前计划，不把空计划发出去把面板清空", () => {
		const h = harness();
		h.handlers.updatePlan([{ id: "a", title: "A", status: "pending" }], "a");
		h.handlers.updatePlanStep("ghost", { status: "done" });
		const frame = planFrames(h.sent).at(-1);
		expect(frame).toMatchObject({ plan: { steps: [{ id: "a", status: "pending" }] } });
	});

	it("计划交接：开新对话 → 计划落到新对话 → 喂交接提示词", async () => {
		const h = harness();
		await h.handlers.planCleanHandoff([{ id: "a", title: "A", status: "pending" }], "接着做");
		expect(h.feeds).toEqual(["接着做"]);
		expect(h.plans.getPlan("conv-2")?.steps.map((step) => step.id)).toEqual(["a"]);
		expect(planFrames(h.sent).at(-1)).toMatchObject({ conversationId: "conv-2" });
	});

	it("计划面未注入：同步抛（不是 rejected promise）", () => {
		const handlers = createGoalHandlers({
			clientId: "c1",
			activeConversationId: () => "conv-1",
			emit: () => {},
			flushSnapshot: () => {},
		});
		expect(() => handlers.updatePlan([], null)).toThrow(CoreEngineNotReadyError);
		expect(() => handlers.planCleanHandoff([], "x")).toThrow(CoreEngineNotReadyError);
	});
});

describe("目标偏好（set_goal_prefs）", () => {
	it("合并口径：undefined 不改、空串回落默认模型、轮数 1..50 封顶", () => {
		const base = { reviewModel: "m1", maxRounds: 3, locked: true, execModel: null };
		expect(mergeGoalPrefs(base, {})).toEqual(base);
		expect(mergeGoalPrefs(base, { reviewModel: "", maxRounds: 99, locked: false, execModel: "" })).toEqual({
			reviewModel: null,
			maxRounds: 50,
			locked: false,
			execModel: null,
		});
		expect(clampGoalRounds(0)).toBe(0);
		expect(clampGoalRounds(-3)).toBe(0);
		expect(clampGoalRounds(2.4)).toBe(2);
	});

	it("真落盘（client-state）+ 发 goal_status + 刷快照", async () => {
		const h = harness();
		await h.handlers.setGoalPrefs({ reviewModel: "review-x", maxRounds: 7, locked: false, execModel: "exec-y" });

		expect(h.store.getGoalPrefs("c1")).toEqual({
			reviewModel: "review-x",
			maxRounds: 7,
			locked: false,
			execModel: "exec-y",
		});
		const frame = goalFrames(h.sent)[0];
		expect(frame).toMatchObject({
			type: "goal_status",
			status: { reviewModel: "review-x", maxRounds: 7, locked: false, execModel: "exec-y", goal: null },
		});
	});

	it("目标模式没开：只发 warning，不写盘（老口径：设了也不生效）", async () => {
		const h = harness({ goalMode: false });
		await h.handlers.setGoalPrefs({ maxRounds: 5 });
		expect(h.store.getGoalPrefs("c1")).toBeUndefined();
		expect(notices(h.sent)[0]).toMatchObject({ type: "notice", level: "warning" });
		expect(goalFrames(h.sent)).toHaveLength(0);
	});

	it("偏好面未注入：同步抛", () => {
		const h = harness({ withPrefs: false });
		expect(() => h.handlers.setGoalPrefs({ maxRounds: 1 })).toThrow(CoreEngineNotReadyError);
	});
});

describe("宿主能力面（目标运行 / 模式开关）端口未注入即同步抛", () => {
	it("setGoal / clearGoal / startGoalWizard 抛 goals.*", () => {
		const h = harness();
		const calls: [string, () => unknown][] = [
			["goals.setGoal", () => h.handlers.setGoal("做完它", { maxRounds: 2, locked: true })],
			["goals.clearGoal", () => h.handlers.clearGoal()],
			["goals.startGoalWizard", () => h.handlers.startGoalWizard("先调研")],
		];
		for (const [what, call] of calls) {
			expect(call).toThrow(CoreEngineNotReadyError);
			expect(call).toThrow(new RegExp(what));
		}
	});

	it("setPlanMode / setDelegateMode 抛 planMode.* / delegateMode.*", () => {
		const h = harness();
		expect(() => h.handlers.setPlanMode(true)).toThrow(/planMode\.set/);
		expect(() => h.handlers.setDelegateMode(true)).toThrow(/delegateMode\.set/);
	});

	it("端口注入后按位转交（启用/停止都到宿主，内核不留第二套循环）", async () => {
		const calls: unknown[][] = [];
		const goalRun: GoalRunPort = {
			setGoal: async (goal, opts) => void calls.push(["setGoal", goal, opts]),
			clearGoal: async (conversationId) => void calls.push(["clearGoal", conversationId]),
			startGoalWizard: async (text) => void calls.push(["startGoalWizard", text]),
		};
		const chatMode: ChatModePort = {
			setPlanMode: async (enabled, conversationId) => void calls.push(["setPlanMode", enabled, conversationId]),
			setDelegateMode: async (enabled, conversationId) => void calls.push(["setDelegateMode", enabled, conversationId]),
		};
		const h = harness({ goalRun, chatMode });

		await h.handlers.setGoal("做完它", { maxRounds: 2, locked: true });
		await h.handlers.clearGoal("conv-1");
		await h.handlers.startGoalWizard("先调研");
		await h.handlers.setPlanMode(true, "conv-1");
		await h.handlers.setDelegateMode(false);

		expect(calls).toEqual([
			["setGoal", "做完它", { maxRounds: 2, locked: true }],
			["clearGoal", "conv-1"],
			["startGoalWizard", "先调研"],
			["setPlanMode", true, "conv-1"],
			["setDelegateMode", false, undefined],
		]);
	});
});
