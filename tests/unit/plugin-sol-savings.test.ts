import { describe, expect, it, vi } from "vitest";
import { analyzeSolSavings, formatPlanSummary } from "../../plugins/sol-savings/index.mjs";
import solSavingsPlugin from "../../plugins/sol-savings/index.mjs";

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
		};

		solSavingsPlugin(mockHost);

		expect(updates.length).toBeGreaterThan(0);
		const lastUpdate = updates[updates.length - 1];
		expect(lastUpdate.id).toBe("sol-savings-badge");
		expect(lastUpdate.patch.badge).toBe("省 2.4k");
		expect(lastUpdate.patch.hint).toContain("SoL-Pi");
	});

	it("防范并清洗序列化占位符中的引号与逗号脏字符", () => {
		const mockMessages = [
			{
				role: "user",
				content: [{ type: "text", text: "测试" }],
			},
			{
				role: "tool_result",
				content: [
					{
						type: "text",
						text: [
							"[large tool result replaced after its first 2 provider requests]",
							'id: "obs_test_escaped",',
							'tool: "bash",',
							'original_bytes: "2048",',
							'estimated_tokens: "500",',
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
		expect((stats.toolBreakdown as Record<string, number>).bash).toBe(1);
		expect(stats.totalOriginalBytes).toBe(2048);
	});

	it("无节省或未触发打包时，底栏常驻显示极简 '省 0' 且文案明确当前会话", () => {
		const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
		const mockHost = {
			getActiveConversation: vi.fn().mockReturnValue({
				messages: [
					{ role: "user", content: [{ type: "text", text: "你好" }] },
					{ role: "assistant", content: [{ type: "text", text: "你好！有什么我可以帮你的？" }] },
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
		};

		solSavingsPlugin(mockHost);

		expect(updates.length).toBeGreaterThan(0);
		const lastUpdate = updates[updates.length - 1];
		expect(lastUpdate.id).toBe("sol-savings-badge");
		expect(lastUpdate.patch.badge).toBe("省 0");
		expect(lastUpdate.patch.hint).toContain("当前会话");
		expect(lastUpdate.patch.hint).toContain("已节省 0 tokens");
	});

	it("多会话切换严格按当前会话隔离，不跨会话累加或污染", () => {
		const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
		let activeConv = {
			id: "conv-1",
			title: "大任务分析",
			messages: [
				{
					role: "tool_result",
					content: [
						{
							type: "text",
							text: [
								"[large tool result replaced after its first 2 provider requests]",
								"id: obs_conv1",
								"tool: bash",
								"original_bytes: 51200",
								"original_lines: 400",
								"estimated_tokens: 12000",
							].join("\n"),
						},
					],
				},
				{ role: "assistant", content: [{ type: "text", text: "处理完毕" }] },
				{ role: "assistant", content: [{ type: "text", text: "再次确认" }] },
			],
		};

		let onConvChangedCb: (() => void) | undefined;
		const mockHost = {
			getActiveConversation: vi.fn(() => activeConv),
			ui: {
				update: vi.fn((id, patch) => {
					updates.push({ id, patch });
				}),
			},
			onAttach: vi.fn(),
			onConversationChanged: vi.fn((cb) => {
				onConvChangedCb = cb;
			}),
			onRunEvent: vi.fn(),
			onMessage: vi.fn(),
			notify: vi.fn(),
		};

		solSavingsPlugin(mockHost);

		// 会话 1：有大输出截断，产生节省
		let lastUpdate = updates[updates.length - 1];
		expect(lastUpdate.patch.badge).toBe("省 23.8k");

		// 切换至新开启的会话 2（干净会话，尚未触发截断）
		activeConv = {
			id: "conv-2",
			title: "日常问答",
			messages: [
				{ role: "user", content: [{ type: "text", text: "帮我看一下天气" }] },
				{ role: "assistant", content: [{ type: "text", text: "今天天气晴朗" }] },
			],
		};
		onConvChangedCb?.();

		// 会话 2：必须独立显示 "省 0"，绝对不能继承会话 1 的 23.8k
		lastUpdate = updates[updates.length - 1];
		expect(lastUpdate.patch.badge).toBe("省 0");
		expect(lastUpdate.patch.hint).toContain("已节省 0 tokens");

		// 再切回会话 1
		activeConv = {
			id: "conv-1",
			title: "大任务分析",
			messages: [
				{
					role: "tool_result",
					content: [
						{
							type: "text",
							text: [
								"[large tool result replaced after its first 2 provider requests]",
								"id: obs_conv1",
								"tool: bash",
								"original_bytes: 51200",
								"original_lines: 400",
								"estimated_tokens: 12000",
							].join("\n"),
						},
					],
				},
				{ role: "assistant", content: [{ type: "text", text: "处理完毕" }] },
				{ role: "assistant", content: [{ type: "text", text: "再次确认" }] },
			],
		};
		onConvChangedCb?.();

		// 恢复会话 1 的数据
		lastUpdate = updates[updates.length - 1];
		expect(lastUpdate.patch.badge).toBe("省 23.8k");
	});
});
