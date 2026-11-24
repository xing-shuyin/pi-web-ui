import { describe, expect, it } from "vitest";
import type { GoalPrefs } from "../../packages/keel/src/contracts/goals.js";
import type { GoalRunSinks } from "../../packages/keel/src/domains/goals/index.js";
import { createCoreGoalRunPort, type GoalRunPrefsStore } from "../../server/core-goal-run-adapter.js";
import type { GoalStatus, ServerMessage } from "../../packages/keel/src/protocol.js";

interface OpenedChild {
	id: string;
	parentId: string;
	title: string;
	cwd: string;
}

interface Harness {
	port: ReturnType<typeof createCoreGoalRunPort>;
	sinks: GoalRunSinks;
	opened: OpenedChild[];
	closed: string[];
	aborted: string[];
	turns: { id: string; text: string }[];
	sent: ServerMessage[];
	/** 让某个子对话的「最后一段助手文本」= 审查判定 / 调研产出（真实现读的是会话末段）。 */
	setText(id: string, text: string): void;
	childOf(role: "exec" | "review" | "wizard"): string;
	notices(): string[];
	statuses(): GoalStatus[];
}

function makeHarness(opts?: {
	prefs?: GoalPrefs;
	setPlan?: (id: string, steps: unknown[]) => void;
	modelsOk?: boolean;
}): Harness {
	const opened: OpenedChild[] = [];
	const closed: string[] = [];
	const aborted: string[] = [];
	const turns: { id: string; text: string }[] = [];
	const sent: ServerMessage[] = [];
	const texts = new Map<string, string>();
	let seq = 0;
	const stateStore: GoalRunPrefsStore = {
		getGoalPrefs: () => opts?.prefs ?? null,
		saveGoalPrefs: () => {},
		getSettingsSnapshot: () => ({ goalModeEnabled: true }),
	};
	const sinks: GoalRunSinks = {
		clientId: "c1",
		emit: (msg) => void sent.push(msg),
		flushSnapshot: () => {},
		isDisposed: () => false,
		getLang: () => "zh",
		activeConversationId: () => "parent",
		cwd: () => "/work",
		openChild: (child) => {
			const id = `g-${++seq}`;
			opened.push({ id, ...child });
			return { id, cwd: child.cwd };
		},
		closeChild: (id) => void closed.push(id),
		hasChild: (id) => opened.some((child) => child.id === id) && !closed.includes(id),
		conversationCwd: (id) => opened.find((child) => child.id === id)?.cwd ?? (id === "parent" ? "/work" : undefined),
		runTurn: async (id, text) => void turns.push({ id, text }),
		abortTurn: async (id) => void aborted.push(id),
		lastAssistantText: (id) => texts.get(id) ?? "",
		setModel: async () => opts?.modelsOk ?? true,
		...(opts?.setPlan ? { setPlan: opts.setPlan as GoalRunSinks["setPlan"] } : {}),
	};
	const port = createCoreGoalRunPort({
		sinks,
		stateStore,
		gitDiff: async () => `diff-${turns.length}`,
		isGitRepo: async () => true,
	});
	return {
		port,
		sinks,
		opened,
		closed,
		aborted,
		turns,
		sent,
		setText: (id, text) => texts.set(id, text),
		childOf: (role) => {
			const child = opened.find((item) =>
				role === "exec"
					? item.title.startsWith("[目标执行]") && !item.title.endsWith("（审查）")
					: role === "review"
						? item.title.endsWith("（审查）")
						: item.title === "[目标调研]",
			);
			if (!child) throw new Error(`no ${role} conversation`);
			return child.id;
		},
		notices: () => sent.filter((msg) => msg.type === "notice").map((msg) => (msg as { text: string }).text),
		statuses: () =>
			sent.filter((msg) => msg.type === "goal_status").map((msg) => (msg as { status: GoalStatus }).status),
	};
}

/** 异步续跑（收尾钩子里是 async 的）：给微任务/定时器都让够时间。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("目标运行宿主适配器（GoalRunPort 的真实现）", () => {
	it("设目标即建执行 / 审查两条子对话（不换会话就并存），首轮喂的是执行者 prompt", async () => {
		const h = makeHarness();
		await h.port.setGoal("把 README 补全", { maxRounds: 3, locked: true });
		expect(h.opened.map((child) => child.parentId)).toEqual(["parent", "parent"]);
		expect(h.opened[0].title).toContain("[目标执行]");
		expect(h.opened[1].title).toContain("审查");
		// cwd 跟主对话（材料 staging 的基准），两条子对话都没被激活过（sinks 里没有 activate 这一步）。
		expect(h.opened.every((child) => child.cwd === "/work")).toBe(true);
		expect(h.turns).toHaveLength(1);
		expect(h.turns[0].id).toBe(h.childOf("exec"));
		expect(h.turns[0].text).toContain("【目标 · 第 1/3 轮】");
		expect(h.statuses().at(-1)).toMatchObject({ phase: "executing", round: 1, goal: "把 README 补全" });
	});

	it("逐轮由 onTurnSettled 驱动：执行收尾 → 派审查 → verdict=pass 收尾并清目标", async () => {
		const h = makeHarness();
		await h.port.setGoal("把 README 补全", { maxRounds: 3, locked: true });
		const execId = h.childOf("exec");
		h.setText(execId, "改完了，跑了 npm test 全绿");
		h.port.onTurnSettled?.(execId, "done");
		await flush();
		expect(h.turns).toHaveLength(2);
		expect(h.turns[1].id).toBe(h.childOf("review"));
		expect(h.turns[1].text).toContain("严格、独立的验收者");
		const reviewId = h.childOf("review");
		h.setText(reviewId, '```json\n{"verdict":"pass","feedback":"README 齐了"}\n```');
		h.port.onTurnSettled?.(reviewId, "done");
		await flush();
		expect(h.statuses().at(-1)).toMatchObject({ verdict: "pass", goal: null });
		expect(h.notices()).toContain("✅ 目标已通过审查");
		// 收尾后子对话全部拆掉（不留子会话）。
		expect(h.closed.sort()).toEqual([execId, reviewId].sort());
	});

	it("verdict=fail 带着意见续跑下一轮；轮数用尽就如实收尾", async () => {
		const h = makeHarness();
		await h.port.setGoal("补测试", { maxRounds: 1, locked: true });
		const execId = h.childOf("exec");
		h.setText(execId, "加了两个用例");
		h.port.onTurnSettled?.(execId, "done");
		await flush();
		h.setText(h.childOf("review"), '{"verdict":"fail","feedback":"还缺 e2e 用例"}');
		h.port.onTurnSettled?.(h.childOf("review"), "done");
		await flush();
		// maxRounds=1：这一轮失败即用尽，不再派第二轮。
		expect(h.turns).toHaveLength(2);
		expect(h.statuses().at(-1)).toMatchObject({ verdict: "fail", phase: "blocked" });
		expect(h.notices().join("\n")).toContain("目标未通过审查（已达最大轮数）");
	});

	it("clearGoal 真停：中断在飞回合、拆掉子对话，迟到的收尾不再派活", async () => {
		const h = makeHarness();
		await h.port.setGoal("补文档", { maxRounds: 5, locked: true });
		const execId = h.childOf("exec");
		const reviewId = h.childOf("review");
		const turnsBefore = h.turns.length;
		await h.port.clearGoal("parent");
		expect(h.aborted.sort()).toEqual([execId, reviewId].sort());
		expect(h.closed.sort()).toEqual([execId, reviewId].sort());
		expect(h.statuses().at(-1)).toMatchObject({ phase: "idle", goal: null, verdict: "pending" });
		// 代次已经变了：迟到的执行收尾既不加轮次也不派审查。
		h.port.onTurnSettled?.(execId, "done");
		await flush();
		expect(h.turns).toHaveLength(turnsBefore);
	});

	it("调研入口真通：问卷 prompt 用标准 ask_user_question，产出目标后落计划并开跑", async () => {
		const plans: { id: string; steps: unknown[] }[] = [];
		const h = makeHarness({ setPlan: (id, steps) => void plans.push({ id, steps }) });
		await h.port.startGoalWizard("随便做点东西");
		const wizardId = h.childOf("wizard");
		expect(h.turns).toHaveLength(1);
		expect(h.turns[0].id).toBe(wizardId);
		expect(h.turns[0].text).toContain("ask_user_question");
		expect(h.statuses().at(-1)).toMatchObject({ goal: "随便做点东西" });
		h.setText(wizardId, "GOAL: 把登录页补上可访问性\nSTEPS:\n1. 加 aria 标签 | 键盘可达\n2. 补 e2e | 跑通");
		h.port.onTurnSettled?.(wizardId, "done");
		await flush();
		expect(plans).toHaveLength(1);
		expect(plans[0].id).toBe("parent");
		expect(plans[0].steps).toHaveLength(2);
		expect(h.closed).toContain(wizardId);
		expect(h.statuses().at(-1)).toMatchObject({ goal: "把登录页补上可访问性", phase: "executing" });
		expect(h.turns.at(-1)?.id).toBe(h.childOf("exec"));
	});

	it("调研没产出可解析目标：报可读提示并收掉调研对话（不留半死状态）", async () => {
		const h = makeHarness();
		await h.port.startGoalWizard("看不懂的需求");
		const wizardId = h.childOf("wizard");
		h.setText(wizardId, "");
		h.port.onTurnSettled?.(wizardId, "done");
		await flush();
		expect(h.notices().join("\n")).toContain("调研未产出有效目标");
		expect(h.closed).toContain(wizardId);
		expect(h.statuses().at(-1)).toMatchObject({ goal: null });
	});

	it("缺口报得清：目标指定模型不可用 / 计划写口未接 都发可读 notice（不静默降级）", async () => {
		const h = makeHarness({ modelsOk: false });
		await h.port.setGoal("写点东西", { maxRounds: 1, locked: true, reviewModel: "nope/missing" });
		expect(h.notices().join("\n")).toContain("目标指定的模型不可用（nope/missing）");
		await h.port.clearGoal("parent");
		await h.port.startGoalWizard("再来一次");
		const wizardId = h.childOf("wizard");
		h.setText(wizardId, "GOAL: 收尾\nSTEPS:\n1. 写 | 完成");
		h.port.onTurnSettled?.(wizardId, "done");
		await flush();
		expect(h.notices().join("\n")).toContain("计划步骤未写入计划面板");
	});

	it("没有活动对话就同步抛可读错（不当成「设了目标但不跑」）", async () => {
		const h = makeHarness();
		const silent: GoalRunSinks = { ...h.sinks, activeConversationId: () => undefined };
		const port = createCoreGoalRunPort({
			sinks: silent,
			stateStore: {
				getGoalPrefs: () => null,
				saveGoalPrefs: () => {},
				getSettingsSnapshot: () => ({ goalModeEnabled: true }),
			},
		});
		expect(() => port.setGoal("做点什么")).toThrow(/goals\.setGoal\.conversation/);
		expect(() => port.startGoalWizard("调研一下")).toThrow(/goals\.startGoalWizard\.conversation/);
	});
});
