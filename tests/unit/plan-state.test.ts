import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanManager } from "../../server/plan-manager.js";
import type { PlanStep } from "../../server/protocol.js";
import { makePlanUpdateTool } from "../../server/agent-service.js";
import { readPlanFromSession } from "../../server/permission-preset.js";

describe("结构化任务计划状态机与看板管理 (PlanManager / Plan Mode)", () => {
	it("初始状态为空", () => {
		const pm = new PlanManager();
		expect(pm.getPlan("conv-1")).toBeNull();
		expect(pm.describePlan("conv-1")).toBe("No active plan.");
	});

	it("设置和规范化计划步骤", () => {
		const pm = new PlanManager();
		const steps: PlanStep[] = [
			{ id: "1", title: "需求调研与设计", status: "done", description: "完成 API 设计" },
			{ id: "2", title: "编写核心模块代码", status: "in_progress" },
			{ id: "3", title: "运行单元测试", status: "pending" },
		];

		const plan = pm.setPlan("conv-1", steps);
		expect(plan).toBeTruthy();
		expect(plan.steps.length).toBe(3);
		expect(plan.activeStepId).toBe("2");
		expect(plan.steps[0].status).toBe("done");
		expect(plan.steps[1].status).toBe("in_progress");
		expect(plan.steps[2].status).toBe("pending");
	});

	it("增量更新步骤状态并自动推进 activeStepId", () => {
		const pm = new PlanManager();
		pm.setPlan("conv-1", [
			{ id: "step-1", title: "步骤一", status: "in_progress" },
			{ id: "step-2", title: "步骤二", status: "pending" },
		]);

		const updated = pm.updateStep("conv-1", "step-1", { status: "done" });
		expect(updated).toBeTruthy();
		expect(updated?.steps[0].status).toBe("done");
		expect(updated?.activeStepId).toBe("step-2");

		const updated2 = pm.updateStep("conv-1", "step-2", { status: "in_progress" });
		expect(updated2?.activeStepId).toBe("step-2");
	});

	it("updateStep 剥掉 patch 里的 id，title/description 与 setPlan 同口径截断", () => {
		const pm = new PlanManager();
		pm.setPlan("conv-1", [{ id: "step-1", title: "原标题", status: "in_progress", description: "原描述" }]);

		const patched = pm.updateStep("conv-1", "step-1", {
			id: "hijacked",
			title: "新标题",
			status: "in_progress",
		});
		expect(patched?.steps[0].id).toBe("step-1");
		expect(patched?.activeStepId).toBe("step-1");
		expect(patched?.steps[0].title).toBe("新标题");

		const long = pm.updateStep("conv-1", "step-1", {
			title: "T".repeat(500),
			description: "D".repeat(2000),
		});
		expect(long?.steps[0].title.length).toBe(200);
		expect(long?.steps[0].description?.length).toBe(1000);

		expect(pm.updateStep("conv-1", "step-1", { status: "pending" })?.steps[0].description).toBeDefined();
		expect(pm.updateStep("conv-1", "step-1", { description: "" })?.steps[0].description).toBeUndefined();
	});

	it("格式化计划文本供模型上下文使用", () => {
		const pm = new PlanManager();
		pm.setPlan("conv-1", [
			{ id: "1", title: "第一步", status: "done" },
			{ id: "2", title: "第二步", status: "in_progress", description: "正在进行中..." },
		]);

		const text = pm.describePlan("conv-1");
		expect(text).toContain("Plan Progress: 1/2 completed");
		expect(text).toContain("[x] 1. 第一步");
		expect(text).toContain("[>] 2. 第二步 (current)");
		expect(text).toContain("正在进行中...");
	});

	it("清空计划", () => {
		const pm = new PlanManager();
		pm.setPlan("conv-1", [{ id: "1", title: "第一步", status: "pending" }]);
		expect(pm.getPlan("conv-1")).not.toBeNull();

		pm.clearPlan("conv-1");
		expect(pm.getPlan("conv-1")).toBeNull();
	});

	it("plan_update 工具携带决策就绪型提示词规范并支持受影响清单", async () => {
		const pm = new PlanManager();
		const messages: unknown[] = [];
		const tool = makePlanUpdateTool(
			pm,
			() => "conv-1",
			(msg) => messages.push(msg),
			() => {},
		);

		expect(tool.promptSnippet).toBeTruthy();
		const guidelines = (tool.promptGuidelines as string[]).join("\n");
		expect(guidelines).toContain("decision-ready steps");
		expect(guidelines).toContain("File Touch List");
		expect(guidelines).toContain("rollback");

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const ctx = {} as any;
		await tool.execute(
			"call-1",
			{
				steps: [
					{
						id: "step-1",
						title: "定位问题代码",
						status: "done",
						description: "Discovery: 确认了配置解析中的异常分支",
					},
					{
						id: "step-2",
						title: "修复并添加测试",
						status: "in_progress",
						description: "Files touched: server/agent-service.ts; Rollback: git checkout server/agent-service.ts",
					},
				],
			},
			undefined,
			undefined,
			ctx,
		);

		const plan = pm.getPlan("conv-1");
		expect(plan).toBeTruthy();
		expect(plan?.steps.length).toBe(2);
		expect(plan?.steps[1].description).toContain("Files touched");
		expect(plan?.steps[1].description).toContain("Rollback");
		expect(messages.length).toBeGreaterThan(0);
	});

	it("deleteStep 增量删除步骤并正确推进 activeStepId (issue #444)", () => {
		const pm = new PlanManager();
		pm.setPlan("conv-1", [
			{ id: "step-1", title: "步骤1", status: "done" },
			{ id: "step-2", title: "步骤2", status: "in_progress" },
			{ id: "step-3", title: "步骤3", status: "pending" },
		]);

		const next = pm.deleteStep("conv-1", "step-2");
		expect(next?.steps.map((s) => s.id)).toEqual(["step-1", "step-3"]);
		expect(next?.activeStepId).toBe("step-3");

		const untouched = pm.deleteStep("conv-1", "step-not-found");
		expect(untouched?.steps.length).toBe(2);
	});

	it("addStep 增量插入步骤并截断过长字符 (issue #444)", () => {
		const pm = new PlanManager();
		pm.setPlan("conv-1", [
			{ id: "step-1", title: "步骤1", status: "done" },
			{ id: "step-2", title: "步骤2", status: "pending" },
		]);

		const after1 = pm.addStep("conv-1", { id: "step-1.5", title: "步骤1.5", status: "pending" }, "step-1");
		expect(after1?.steps.map((s) => s.id)).toEqual(["step-1", "step-1.5", "step-2"]);

		const atEnd = pm.addStep("conv-1", { id: "step-3", title: "步骤3", status: "pending" });
		expect(atEnd?.steps.map((s) => s.id)).toEqual(["step-1", "step-1.5", "step-2", "step-3"]);
	});

	it("支持基于 plans.json 文件持久化并在新实例中恢复", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-plan-test-"));
		const filePath = join(tmpDir, "plans.json");

		const pm1 = new PlanManager(filePath);
		pm1.setPlan(
			"c1",
			[
				{ id: "1", title: "步骤一", status: "done" },
				{ id: "2", title: "步骤二", status: "in_progress" },
			],
			"2",
			"session-uuid-1",
		);

		const pm2 = new PlanManager(filePath);
		expect(pm2.getPlan("session-uuid-1")).toBeTruthy();
		expect(pm2.getPlan("session-uuid-1")?.steps.length).toBe(2);

		const restored = pm2.bindSession("c2", "session-uuid-1");
		expect(restored).toBeTruthy();
		expect(pm2.getPlan("c2")).toBeTruthy();
		expect(pm2.getPlan("c2")?.activeStepId).toBe("2");
	});

	it("防新会话串台：新实例重启时绝不加载临时 conversationId，全新会话不继承上一个会话的任务", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-plan-test-"));
		const filePath = join(tmpDir, "plans.json");

		const pm1 = new PlanManager(filePath);
		pm1.setPlan(
			"c2",
			[
				{ id: "1", title: "探索与分析代码", status: "done" },
				{ id: "2", title: "提交 PR 并处理 Issue", status: "done" },
			],
			null,
			"session-prev-c2",
		);

		const pm2 = new PlanManager(filePath);
		expect(pm2.getPlan("c2")).toBeNull();

		const bound = pm2.bindSession("c2", "session-fresh-c2");
		expect(bound).toBeNull();
		expect(pm2.getPlan("c2")).toBeNull();
	});

	it("清洗历史脏数据：自动过滤 plans.json 中的 c1/c2 等临时 ID 并在下次保存时清除", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-plan-test-"));
		const filePath = join(tmpDir, "plans.json");

		const dirtyData = {
			c1: { steps: [{ id: "1", title: "旧 c1 任务", status: "done" }], activeStepId: null, updatedAt: 1 },
			c2: { steps: [{ id: "1", title: "旧 c2 任务", status: "done" }], activeStepId: null, updatedAt: 2 },
			"valid-session-uuid": {
				steps: [{ id: "1", title: "有效真实会话任务", status: "pending" }],
				activeStepId: null,
				updatedAt: 3,
			},
		};
		writeFileSync(filePath, JSON.stringify(dirtyData), "utf8");

		const pm = new PlanManager(filePath);
		expect(pm.getPlan("c1")).toBeNull();
		expect(pm.getPlan("c2")).toBeNull();
		expect(pm.getPlan("valid-session-uuid")).toBeTruthy();

		pm.setPlan("c3", [{ id: "1", title: "新任务", status: "pending" }], null, "valid-session-uuid-2");

		const saved = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
		expect(saved["c1"]).toBeUndefined();
		expect(saved["c2"]).toBeUndefined();
		expect(saved["c3"]).toBeUndefined();
		expect(saved["valid-session-uuid"]).toBeTruthy();
		expect(saved["valid-session-uuid-2"]).toBeTruthy();
	});

	it("unbindConversation 正确清理运行时 conversationId 映射", () => {
		const pm = new PlanManager();
		pm.setPlan("c1", [{ id: "1", title: "步骤1", status: "pending" }]);
		expect(pm.getPlan("c1")).toBeTruthy();

		pm.unbindConversation("c1");
		expect(pm.getPlan("c1")).toBeNull();
	});

	it("setPlan 传入空数组步骤时自动从持久化文件中清除对应 sessionId 条目", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-plan-test-"));
		const filePath = join(tmpDir, "plans.json");

		const pm = new PlanManager(filePath);
		pm.setPlan("c1", [{ id: "1", title: "步骤1", status: "pending" }], null, "session-to-clear");
		expect(pm.getPlan("session-to-clear")?.steps.length).toBe(1);

		pm.setPlan("c1", [], null, "session-to-clear");
		expect(pm.getPlan("c1")?.steps.length).toBe(0);

		const saved = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
		expect(saved["session-to-clear"]).toBeUndefined();
	});

	it("readPlanFromSession 能从 sessionManager 的 customType plan/update 恢复", () => {
		const fakeSm = {
			getEntries: () => [
				{ type: "message", role: "user" },
				{
					type: "custom",
					customType: "plan/update",
					data: {
						plan: {
							steps: [{ id: "1", title: "历史步骤", status: "done" }],
							activeStepId: null,
							updatedAt: 123456,
						},
					},
				},
			],
		};
		const plan = readPlanFromSession(fakeSm);
		expect(plan).toBeTruthy();
		expect(plan?.steps[0].title).toBe("历史步骤");
	});
});
