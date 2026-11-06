import { describe, expect, it, beforeEach } from "vitest";
import {
	GoalService,
	stripGoalDraftPrefix,
	buildWizardConversationContext,
	type GoalConversation,
	type GoalHost,
} from "../../server/goal-service.js";
import type { ServerMessage } from "../../server/protocol.js";

const sent: ServerMessage[] = [];

const bootHost: GoalHost = {
	clientId: "c",
	agentDir: "/tmp/agent",
	stateStore: {
		getGoalPrefs: () => null,
		saveGoalPrefs: () => {},
	} as unknown as GoalHost["stateStore"],
	webUi: null as unknown as GoalHost["webUi"],
	emit: (msg) => void sent.push(msg),
	flushSnapshot: () => {},
	isDisposed: () => false,
	quiesceBlocked: () => false,
	activeConvId: () => "conv-a",
	activeConv: () => ({}) as GoalConversation,
	getConv: () => undefined,
	cwd: () => "/tmp/proj",
	gitDiff: async () => "",
	goalModeEnabled: () => true,
	spawnRoleAgent: async () => "sa-exec",
	waitRoleAgent: async () => "done",
	sendRoleAgent: async () => true,
	readRoleAgent: () => ({ text: "" }),
	hasConv: () => true,
};
const bootSvc = new GoalService(bootHost);

function makeConv(id: string, title: string): GoalConversation {
	return {
		id,
		title,
		cwd: "/tmp/proj",
		session: {
			isStreaming: false,
			sendUserMessage: async () => {},
			sendCustomMessage: async () => {},
		} as unknown as GoalConversation["session"],
		wizardRunning: false,
		goalGeneration: 0,
		goal: bootSvc.makeGoalStatus(),
	};
}

function makeService(): { svc: GoalService; convs: Map<string, GoalConversation> } {
	const convs = new Map<string, GoalConversation>([
		["conv-a", makeConv("conv-a", "会话 A")],
		["conv-b", makeConv("conv-b", "会话 B")],
	]);
	const host: GoalHost = {
		clientId: "c",
		agentDir: "/tmp/agent",
		stateStore: {
			getGoalPrefs: () => null,
			saveGoalPrefs: () => {},
		} as unknown as GoalHost["stateStore"],
		webUi: null as unknown as GoalHost["webUi"],
		emit: (msg) => void sent.push(msg),
		flushSnapshot: () => {},
		isDisposed: () => false,
		quiesceBlocked: () => false,
		activeConvId: () => "conv-a",
		activeConv: () => convs.get("conv-a")!,
		getConv: (id) => convs.get(id),
		cwd: () => "/tmp/proj",
		gitDiff: async () => "",
		goalModeEnabled: () => true,
		spawnRoleAgent: async () => "sa-exec",
		waitRoleAgent: async () => "done",
		sendRoleAgent: async () => true,
		readRoleAgent: () => ({ text: "" }),
		hasConv: () => true,
	};
	return { svc: new GoalService(host), convs };
}

const notices = () => sent.filter((m) => m.type === "notice") as { text: string; level: string }[];

beforeEach(() => {
	sent.length = 0;
});

describe("setGoal 落点（issue #292）", () => {
	it("默认仍落在活动对话上（行为不变）", async () => {
		const { svc, convs } = makeService();
		await svc.setGoal("写测试");
		expect(convs.get("conv-a")!.goal.goal).toBe("写测试");
		expect(convs.get("conv-a")!.goal.conversationId).toBe("conv-a");
		expect(convs.get("conv-b")!.goal.goal).toBeNull();
	});

	it("targetConvId 指定落点：切走也能把调研结果写回发起对话", async () => {
		const { svc, convs } = makeService();
		await svc.setGoal("提炼后的目标", { targetConvId: "conv-b", autoStart: false });
		expect(convs.get("conv-b")!.goal.goal).toBe("提炼后的目标");
		expect(convs.get("conv-b")!.goal.conversationId).toBe("conv-b");
		expect(convs.get("conv-a")!.goal.goal).toBeNull();
	});

	it("targetConvId 指向已关闭的对话：响亮拒绝，不落到别处", async () => {
		const { svc, convs } = makeService();
		await svc.setGoal("提炼后的目标", { targetConvId: "conv-gone", autoStart: false });
		const warn = notices().find((n) => n.level === "warning");
		expect(warn?.text).toContain("已关闭");
		expect(convs.get("conv-a")!.goal.goal).toBeNull();
		expect(convs.get("conv-b")!.goal.goal).toBeNull();
	});

	it("空文本仍是清除（targetConvId 不改变清除语义的调用方）", async () => {
		const { svc, convs } = makeService();
		await svc.setGoal("先设一个", { autoStart: false });
		await svc.setGoal("");
		expect(convs.get("conv-a")!.goal.goal).toBeNull();
	});

	it("stripGoalDraftPrefix 自动剥离复制重发时带入的单层/多层中英文草案卡片前缀", () => {
		expect(stripGoalDraftPrefix("🎯 Initial goal draft: 写报告")).toBe("写报告");
		expect(stripGoalDraftPrefix("🎯 原始目标草案：写报告")).toBe("写报告");
		expect(stripGoalDraftPrefix("🎯 Initial goal draft: 🎯 Initial goal draft: 写报告")).toBe("写报告");
		expect(stripGoalDraftPrefix("🎯 原始目标草案：🎯 Initial goal draft: 写报告")).toBe("写报告");
		expect(stripGoalDraftPrefix("普通需求文本")).toBe("普通需求文本");
	});

	it("buildWizardConversationContext 能从主会话消息中提取摘要与近期轮次（含工具调用摘要）", () => {
		const messages = [
			{ role: "system", content: "You are an assistant." },
			{ role: "compactionSummary", summary: "历史摘要：完成了模型A与模型B的前序评测" },
			{ role: "user", content: [{ type: "text", text: "请生成七方全景对比报告" }] },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", name: "edit", arguments: { path: "scripts/build_report.py" } },
					{ type: "text", text: "已生成对比报告，正在核对指标" },
				],
			},
		];
		const ctx = buildWizardConversationContext(messages);
		expect(ctx).toContain("Previous Context Summary");
		expect(ctx).toContain("模型A与模型B的前序评测");
		expect(ctx).toContain("Recent Conversation Turns");
		expect(ctx).toContain("请生成七方全景对比报告");
		expect(ctx).toContain("[tool:edit scripts/build_report.py]");
	});

	it("buildWizardConversationContext 在空消息或异常结构时安全返回空字符串", () => {
		expect(buildWizardConversationContext([])).toBe("");
		expect(buildWizardConversationContext(null as unknown as unknown[])).toBe("");
		expect(buildWizardConversationContext([{}])).toBe("");
	});
});
