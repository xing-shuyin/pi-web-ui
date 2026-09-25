import { describe, expect, it, vi } from "vitest";
import { analyzeSolSavings, formatPlanSummary, solSavingsPlugin } from "../../plugins/sol-savings/index.mjs";

describe("SoL-Pi Savings 插件与底栏统计", () => {
	it("正确分析 Observation Pack 大工具输出打包并计算节省 Token", () => {
		const mockMessages = [
			{
				role: "user",
				content: [{ type: "text", text: "请帮我分析日志" }],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "正在读取..." }],
			},
			{
				role: "tool_result",
				content: [
					{
						type: "text",
						text: [
							"[large tool result replaced after its first 2 provider requests]",
							"id: obs_test_123",
							"tool: bash",
							"original_bytes: 51200",
							"original_lines: 400",
							"estimated_tokens: 12000",
							"retrieve: call obs_recall with ...",
						].join("\n"),
					},
				],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "已收到截断结果，继续处理" }],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "任务完成" }],
			},
		];

		const stats = analyzeSolSavings(mockMessages);
		expect(stats.packedCount).toBe(1);
		expect(stats.totalOriginalBytes).toBe(51200);
		expect((stats.toolBreakdown as Record<string, number>).bash).toBe(1);
		// 每次请求节省 (12000 - 80) = 11920，后续有 2 轮 assistant，共节省 11920 * 2 = 23840
		expect(stats.totalSavedTokens).toBe(23840);
	});

	it("正确解析并格式化 SoL-Pi Plan 进度", () => {
		const plan = [
			{ id: "1", goal: "分析现有架构", status: "completed" },
			{ id: "2", goal: "实现底栏状态插件", status: "in_progress" },
			{ id: "3", goal: "测试与验证", status: "pending" },
		];

		const summary = formatPlanSummary(plan);
		expect(summary).not.toBeNull();
		expect(summary?.progress).toBe("1/3");
		expect(summary?.marker).toBe("◐");
		expect(summary?.goal).toBe("实现底栏状态插件");
		expect(summary?.badge).toBe("1/3 ◐");
	});

	it("插件生命周期与 host.ui.update 协同正常", () => {
		const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
		const mockHost = {
			getActiveConversation: vi.fn().mockReturnValue({
				messages: [
					{
						role: "tool_result",
						content: [
							{
								type: "text",
								text: [
									"[large tool result replaced after its first 2 provider requests]",
									"id: obs_456",
									"tool: read",
									"original_bytes: 10000",
									"original_lines: 100",
									"estimated_tokens: 2500",
								].join("\n"),
							},
						],
					},
					{
						role: "assistant",
						content: [{ type: "text", text: "好的" }],
					},
				],
			}),
			ui: {
				update: vi.fn((id, patch) => {
					updates.push({ id, patch });
				}),
			},
			onAttach: vi.fn(),
			onRunEvent: vi.fn(),
			onMessage: vi.fn(),
			notify: vi.fn(),
			route: vi.fn(),
		};

		solSavingsPlugin(mockHost);

		expect(updates.length).toBeGreaterThan(0);
		const lastUpdate = updates[updates.length - 1];
		expect(lastUpdate.id).toBe("sol-savings-badge");
		expect(lastUpdate.patch.badge).toBe("省 2.4k");
		expect(lastUpdate.patch.hint).toContain("SoL-Pi");
		expect(mockHost.route).toHaveBeenCalledWith("POST", "/trigger-details", expect.any(Function));
		expect(mockHost.route).toHaveBeenCalledWith("GET", "/details", expect.any(Function));
	});

	it('在包含转义或引号时仍能干净解析工具名称（避免 bash", 等脏字符）', () => {
		const mockMessages = [
			{
				role: "tool_result",
				content: [
					{
						type: "text",
						text: [
							"[large tool result replaced after its first 2 provider requests]",
							'id: "obs_clean_1",',
							'tool: "bash",',
							'original_bytes: "20480",',
							'estimated_tokens: "6000"',
						].join("\n"),
					},
				],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "完成" }],
			},
		];

		const stats = analyzeSolSavings(mockMessages);
		expect(stats.packedCount).toBe(1);
		expect((stats.toolBreakdown as Record<string, number>).bash).toBe(1);
		expect(Object.keys(stats.toolBreakdown)).toEqual(["bash"]);
	});
});
