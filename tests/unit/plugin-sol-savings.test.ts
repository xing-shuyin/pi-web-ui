import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	analyzeSolSavings,
	formatPlanSummary,
	getSavingsFromLedger,
	resolveSessionId,
	saveSolPiConfig,
	writeSolPiConfig,
} from "../../plugins/sol-savings/index.mjs";
import { normalizeSolPlanToPlanSteps } from "../../server/agent-service.js";
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

		let lastUpdate = updates[updates.length - 1];
		expect(lastUpdate.patch.badge).toBe("省 23.8k");

		activeConv = {
			id: "conv-2",
			title: "日常问答",
			messages: [
				{ role: "user", content: [{ type: "text", text: "帮我看一下天气" }] },
				{ role: "assistant", content: [{ type: "text", text: "今天天气晴朗" }] },
			],
		};
		onConvChangedCb?.();

		lastUpdate = updates[updates.length - 1];
		expect(lastUpdate.patch.badge).toBe("省 0");
		expect(lastUpdate.patch.hint).toContain("已节省 0 tokens");

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

		lastUpdate = updates[updates.length - 1];
		expect(lastUpdate.patch.badge).toBe("省 23.8k");
	});

	it("正确从 SoL-Pi 物理账本 ledger.jsonl 读取权威截断数据", () => {
		const tempDir = join(tmpdir(), `sol-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const convId = "conv-sol-ledger-123";
		const ledgerDir = join(tempDir, "sessions", "test-project", "sol-pi", convId, "observation-pack");
		mkdirSync(ledgerDir, { recursive: true });

		const ledgerContent = [
			JSON.stringify({
				timestamp: "2026-09-28T07:00:13.221Z",
				event: "placeholder",
				id: "obs_001",
				request: 5,
				sendNumber: 3,
				tool: "read",
				originalBytes: 16000,
				originalLines: 100,
				originalTokens: 2500,
				removedTokens: 2300,
			}),
			JSON.stringify({
				timestamp: "2026-09-28T07:01:13.221Z",
				event: "placeholder",
				id: "obs_002",
				request: 6,
				sendNumber: 2,
				tool: "grep",
				originalBytes: 8000,
				originalLines: 50,
				originalTokens: 1200,
				removedTokens: 1100,
			}),
			"{ bad json",
			JSON.stringify({ event: "archive", id: "obs_003" }),
		].join("\n");

		writeFileSync(join(ledgerDir, "ledger.jsonl"), ledgerContent, "utf8");

		try {
			const ledgerStats = getSavingsFromLedger(convId, tempDir);
			expect(ledgerStats).not.toBeNull();
			expect(ledgerStats?.totalSavedTokens).toBe(3400);
			expect(ledgerStats?.totalOriginalBytes).toBe(24000);
			expect(ledgerStats?.packedCount).toBe(2);
			expect((ledgerStats?.toolBreakdown as Record<string, number>).read).toBe(1);
			expect((ledgerStats?.toolBreakdown as Record<string, number>).grep).toBe(1);

			const mockMessagesWithPlan = [
				{
					role: "assistant",
					content: [
						{
							type: "text",
							text: JSON.stringify({
								state: "sol-pi-online-context-state-v1",
								plan: [
									{ id: "1", goal: "提取物理账本", status: "completed" },
									{ id: "2", goal: "计算节省总数", status: "in_progress" },
								],
							}),
						},
					],
				},
			];

			const combinedStats = analyzeSolSavings(mockMessagesWithPlan, convId, tempDir);
			expect(combinedStats.totalSavedTokens).toBe(3400);
			expect(combinedStats.plan).toHaveLength(2);
			expect(combinedStats.plan?.[0].goal).toBe("提取物理账本");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("在未找到物理账本或非法会话 ID 时优雅回退至消息正则分析", () => {
		const mockMessages = [
			{
				role: "tool_result",
				content: [
					{
						type: "text",
						text: [
							"[large tool result replaced after its first 2 provider requests]",
							"id: obs_fallback",
							"tool: eval",
							"original_bytes: 4000",
							"original_lines: 30",
							"estimated_tokens: 800",
						].join("\n"),
					},
				],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "回退成功" }],
			},
		];

		const fallbackStats = analyzeSolSavings(mockMessages, "non-existent-conv-id");
		expect(fallbackStats.packedCount).toBe(1);
		expect(fallbackStats.totalOriginalBytes).toBe(4000);
		expect(fallbackStats.totalSavedTokens).toBe(720);
		expect((fallbackStats.toolBreakdown as Record<string, number>).eval).toBe(1);
	});

	it("当 conversationId 为内部序号（如 c1/c2）时，通过 resolveSessionId 从消息时间戳逆向命中物理会话账本", () => {
		const tempDir = join(tmpdir(), `sol-reverse-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const projDir = join(tempDir, "sessions", "test-project");
		const targetSid = "01a0-reverse-uuid-test";
		const ledgerDir = join(projDir, "sol-pi", targetSid, "observation-pack");
		mkdirSync(ledgerDir, { recursive: true });

		const msgTsMs = Date.now() - 60 * 60 * 1000;
		const msgTsIso = new Date(msgTsMs).toISOString();

		const sessionFileName = `${msgTsIso.replace(/[:.]/g, "-")}_${targetSid}.jsonl`;
		const sessionFileContent = [
			JSON.stringify({ type: "session", id: targetSid }),
			JSON.stringify({
				type: "message",
				id: "msg_1",
				timestamp: msgTsIso,
				message: { role: "user", content: "测试会话" },
			}),
		].join("\n");
		writeFileSync(join(projDir, sessionFileName), sessionFileContent, "utf8");

		const ledgerContent = JSON.stringify({
			timestamp: "2026-09-28T12:05:00.000Z",
			event: "placeholder",
			id: "obs_rev_1",
			tool: "read",
			originalBytes: 12000,
			originalTokens: 3000,
			removedTokens: 2900,
		});
		writeFileSync(join(ledgerDir, "ledger.jsonl"), ledgerContent, "utf8");

		try {
			const mockConvMessages = [
				{
					id: `u-${msgTsMs}-1`,
					role: "user",
					content: [{ type: "text", text: "测试会话" }],
				},
			];

			const stats = analyzeSolSavings(mockConvMessages, "c12", tempDir);
			expect(stats.totalSavedTokens).toBe(2900);
			expect(stats.packedCount).toBe(1);
			expect((stats.toolBreakdown as Record<string, number>).read).toBe(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("resolveSessionId 扫描记忆化：负结果不重扫，证据翻倍后才重扫", () => {
		const tempDir = join(tmpdir(), `sol-memo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const projDir = join(tempDir, "sessions", "test-project");
		const targetSid = "01a0-memo-uuid-test";
		const ledgerDir = join(projDir, "sol-pi", targetSid, "observation-pack");
		mkdirSync(ledgerDir, { recursive: true });

		const msgTsMs = Date.now() - 60 * 60 * 1000;
		const msgTsIso = new Date(msgTsMs).toISOString();
		const msgs1 = [{ id: `u-${msgTsMs}-1`, role: "user", content: [{ type: "text", text: "探测" }] }];

		try {
			expect(resolveSessionId("c-memo", msgs1, tempDir)).toBeNull();

			writeFileSync(
				join(projDir, `${msgTsIso.replace(/[:.]/g, "-")}_${targetSid}.jsonl`),
				JSON.stringify({ type: "message", timestamp: msgTsIso, message: { role: "user", content: "探测" } }),
				"utf8",
			);
			writeFileSync(join(ledgerDir, "ledger.jsonl"), JSON.stringify({ event: "archive" }), "utf8");

			expect(resolveSessionId("c-memo", msgs1, tempDir)).toBeNull();

			const msgs2 = [...msgs1, { id: `u-${msgTsMs + 1000}-2`, role: "assistant", content: [] }];
			expect(resolveSessionId("c-memo", msgs2, tempDir)).toBe(targetSid);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("运行事件拖尾合并刷新：500ms 窗口至多一次，轮次/运行边界立即刷新", async () => {
		const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
		let onRunCb: ((ev: { type: string }) => void) | undefined;
		const mockHost = {
			getActiveConversation: vi.fn().mockReturnValue({
				id: "conv-debounce",
				messages: [
					{ role: "user", content: [{ type: "text", text: "hi" }] },
					{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				],
			}),
			ui: {
				update: vi.fn((id, patch) => {
					updates.push({ id, patch });
				}),
			},
			onAttach: vi.fn(),
			onConversationChanged: vi.fn(),
			onRunEvent: vi.fn((cb) => {
				onRunCb = cb;
			}),
			onMessage: vi.fn(),
			notify: vi.fn(),
		};

		solSavingsPlugin(mockHost);
		const baseline = updates.length;

		for (let i = 0; i < 5; i++) onRunCb?.({ type: "tool_end" });
		expect(updates.length).toBe(baseline);

		await new Promise((r) => setTimeout(r, 600));
		expect(updates.length).toBe(baseline + 1);

		onRunCb?.({ type: "run_end" });
		expect(updates.length).toBe(baseline + 2);
	});

	it("saveSolPiConfig 支持保存自定义特性开关并持久化", () => {
		const tempDir = join(tmpdir(), `sol-test-cfg-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		const origPiDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tempDir;

		try {
			writeSolPiConfig();

			const updated = saveSolPiConfig({
				observationPack: true,
				onlineContextCompact: false,
				actionFusion: true,
				cacheWriteReadRatio: 16,
				evidencePreservingReducerProvider: "openai",
				evidencePreservingReducerModel: "gpt-4o-mini",
			});

			expect(updated.observationPack).toBe(true);
			expect(updated.onlineContextCompact).toBe(false);
			expect(updated.actionFusion).toBe(true);
			expect(updated.cacheWriteReadRatio).toBe(16);
			expect(updated.evidencePreservingReducerProvider).toBe("openai");
			expect(updated.evidencePreservingReducerModel).toBe("gpt-4o-mini");
		} finally {
			if (origPiDir) process.env.PI_CODING_AGENT_DIR = origPiDir;
			else delete process.env.PI_CODING_AGENT_DIR;
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("normalizeSolPlanToPlanSteps 能够正确将 SoL-Pi 的 update_plan 步骤转换为 WebUI 的任务看板计划", () => {
		const solSteps = [
			{ id: "1", goal: "分析代码结构与冲突", status: "completed" },
			{ id: "2", goal: "桥接 update_plan 工具调用", status: "in_progress" },
			{ id: "3", goal: "开发底栏可视化管理面板", status: "pending" },
		];

		const result = normalizeSolPlanToPlanSteps(solSteps);
		expect(result.steps).toHaveLength(3);
		expect(result.steps[0]).toEqual({
			id: "1",
			title: "分析代码结构与冲突",
			status: "done",
		});
		expect(result.steps[1]).toEqual({
			id: "2",
			title: "桥接 update_plan 工具调用",
			status: "in_progress",
		});
		expect(result.steps[2]).toEqual({
			id: "3",
			title: "开发底栏可视化管理面板",
			status: "pending",
		});
		expect(result.activeStepId).toBe("2");
	});
});
