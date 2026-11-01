import { describe, expect, it, vi, afterEach } from "vitest";
import { extractSubagentConclusion, formatSubagentsCompletionNotice } from "../../server/subagent-notify.js";
import { ClientSession, type Conversation } from "../../server/agent-service.js";
import { defaultSubagentAutoWakeMaxTurns, normalizeSubagentAutoWakeMaxTurns } from "../../server/client-state.js";

function makeMockConv(opts: {
	id: string;
	title?: string;
	type?: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	output?: string;
	error?: string;
	canceled?: boolean;
}): Conversation {
	const messages: any[] = [];
	if (opts.error) {
		messages.push({ role: "assistant", errorMessage: opts.error });
	} else if (opts.canceled) {
		messages.push({ role: "assistant", stopReason: "aborted" });
	} else if (opts.output !== undefined) {
		messages.push({ role: "assistant", stopReason: "end_turn" });
	}

	return {
		id: opts.id,
		title: opts.title ?? "测试任务",
		subagentType: opts.type ?? "explore",
		isSubagent: true,
		session: {
			model: opts.model ?? { provider: "anthropic", id: "claude-3-7-sonnet" },
			thinkingLevel: opts.thinkingLevel ?? "high",
			getLastAssistantText: () => opts.output ?? "",
			getSessionStats: () => ({ totalMessages: messages.length }),
			agent: {
				state: {
					messages,
				},
			},
		} as any,
	} as Conversation;
}

describe("subagent-notify (Issue #713)", () => {
	describe("extractSubagentConclusion", () => {
		it("空文本时返回可读占位符", () => {
			expect(extractSubagentConclusion("", "zh")).toBe("（无输出结果）");
			expect(extractSubagentConclusion("   ", "en")).toBe("(no output produced)");
		});

		it("不超过 20 行时完整返回", () => {
			const lines = Array.from({ length: 15 }, (_, i) => `Line ${i + 1}`).join("\n");
			expect(extractSubagentConclusion(lines)).toBe(lines);
		});

		it("超过 20 行时保留前 3 行与后 15 行，中间折叠", () => {
			const lines = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join("\n");
			const outZh = extractSubagentConclusion(lines, "zh");
			expect(outZh).toContain("Line 1\nLine 2\nLine 3");
			expect(outZh).toContain("Line 30");
			expect(outZh).toContain("Line 16");
			expect(outZh).toContain("… [中间省略 12 行过程日志");

			const outEn = extractSubagentConclusion(lines, "en");
			expect(outEn).toContain("12 lines omitted");
		});
	});

	describe("formatSubagentsCompletionNotice", () => {
		it("空列表返回空串", () => {
			expect(formatSubagentsCompletionNotice([])).toBe("");
		});

		it("uses explicit manual summaries only on successful completion", () => {
			const conv = makeMockConv({ id: "manual", output: "Final assistant body" });
			conv.subagentTask = { mode: "manual", completionRequested: true, generation: 0, summary: "Task deliverable" };
			expect(formatSubagentsCompletionNotice([conv])).toContain("Task deliverable");
			expect(formatSubagentsCompletionNotice([conv])).not.toContain("Final assistant body");
			conv.subagentTask.summary = " ";
			expect(formatSubagentsCompletionNotice([conv])).toContain("Final assistant body");
			conv.subagentTask.summary = "Stale success";
			conv.subagentTask.mode = true;
			expect(formatSubagentsCompletionNotice([conv])).toContain("Final assistant body");
		});

		it.each([{ error: "Failed after complete" }, { canceled: true }])(
			"preserves failure output after completion intent: %j",
			(outcome) => {
				const conv = makeMockConv({ id: "manual-failed", output: "Failure details", ...outcome });
				conv.subagentTask = { mode: "manual", completionRequested: true, generation: 0, summary: "Stale success" };
				const notice = formatSubagentsCompletionNotice([conv]);
				expect(notice).toContain("Failure details");
				expect(notice).not.toContain("Stale success");
			},
		);

		it("正常完成单子代理生成结构化汇报（中文）", () => {
			const conv = makeMockConv({
				id: "sa-12345678-abcd",
				title: "排查数据库死锁",
				type: "investigate",
				output: "已发现事务未提交导致死锁，建议在 finally 中统一释放连接。",
			});

			const text = formatSubagentsCompletionNotice([conv], "zh");
			expect(text).toContain("[子代理执行完成通知] 共有 1 个子代理已完成：");
			expect(text).toContain("- **sa-12345**（investigate · anthropic/claude-3-7-sonnet:high）— ✅ 正常完成");
			expect(text).toContain("目标: 排查数据库死锁");
			expect(text).toContain("已发现事务未提交导致死锁");
			expect(text).toContain('subagent(action="get_result", runId="<id>")');
		});

		it("报错子代理显示运行失败标签（英文）", () => {
			const conv = makeMockConv({
				id: "sa-err-1234",
				title: "构建前端",
				error: "Out of memory",
			});

			const text = formatSubagentsCompletionNotice([conv], "en");
			expect(text).toContain("[Subagent Completion Notice] 1 subagent(s) completed:");
			expect(text).toContain("❌ Failed (Out of memory)");
		});

		it("中止子代理显示已中止标签", () => {
			const conv = makeMockConv({
				id: "sa-aborted-1234",
				canceled: true,
			});

			const text = formatSubagentsCompletionNotice([conv], "zh");
			expect(text).toContain("⚠️ 已中止");
		});

		it("多个子代理合成聚合通知", () => {
			const c1 = makeMockConv({ id: "sa-1111", title: "任务1", output: "完成1" });
			const c2 = makeMockConv({ id: "sa-2222", title: "任务2", output: "完成2" });

			const text = formatSubagentsCompletionNotice([c1, c2], "zh");
			expect(text).toContain("共有 2 个子代理已完成：");
			expect(text).toContain("sa-1111");
			expect(text).toContain("sa-2222");
		});

		it("带有父对话回落标记时显示兜底提示", () => {
			const conv = makeMockConv({ id: "sa-1111", output: "完成" });
			const text = formatSubagentsCompletionNotice([conv], "zh", "parent-orig-9999");
			expect(text).toContain("原父对话 parent-o 已不在，转至当前活跃对话继续");
		});
	});

	describe("ClientSession subagent completion batching & debounce", () => {
		it("400ms 内多个子代理结束合并为一条通知唤醒父对话", async () => {
			const sendUserMessage = vi.fn().mockResolvedValue(undefined);
			const parentConv: any = {
				id: "parent-c1",
				cwd: "/test",
				session: {
					sendUserMessage,
					isStreaming: false,
					isCompacting: false,
				},
				autonomousTurnsWithoutUser: 0,
			};

			const cs: any = {
				refreshCompletionState: (ClientSession.prototype as any).refreshCompletionState,
				deliverSubagentCompletionNotice: (ClientSession.prototype as any).deliverSubagentCompletionNotice,
				emitConversations: vi.fn(),
				cwd: "/test",
				getLang: () => "zh",
				subagentOwnerOf: () => cs,
				convs: new Map([["parent-c1", parentConv]]),
				pendingSubagentNotices: new Map(),
				deliveringSubagentNotices: new Map(),
				flushSnapshot: vi.fn(),
				emit: vi.fn(),
				scheduleSubagentCompletionNotice: (ClientSession.prototype as any).scheduleSubagentCompletionNotice,
				flushSubagentCompletionNotice: (ClientSession.prototype as any).flushSubagentCompletionNotice,
			};

			const sa1: any = {
				id: "sa-11111111",
				parentId: "parent-c1",
				title: "任务1",
				subagentType: "explore",
				session: {
					model: { provider: "mock", id: "m1" },
					thinkingLevel: "low",
					getLastAssistantText: () => "结论1",
					agent: { state: { messages: [{ role: "assistant", stopReason: "end_turn" }] } },
				},
			};
			const sa2: any = {
				id: "sa-22222222",
				parentId: "parent-c1",
				title: "任务2",
				subagentType: "implement",
				session: {
					model: { provider: "mock", id: "m1" },
					thinkingLevel: "high",
					getLastAssistantText: () => "结论2",
					agent: { state: { messages: [{ role: "assistant", stopReason: "end_turn" }] } },
				},
			};

			cs.scheduleSubagentCompletionNotice(sa1);
			cs.scheduleSubagentCompletionNotice(sa2);

			expect(sendUserMessage).not.toHaveBeenCalled();

			await new Promise((r) => setTimeout(r, 450));

			expect(sendUserMessage).toHaveBeenCalledTimes(1);
			const deliveredText = sendUserMessage.mock.calls[0][0];
			expect(deliveredText).toContain("共有 2 个子代理已完成：");
			expect(deliveredText).toContain("sa-11111");
			expect(deliveredText).toContain("sa-22222");
			expect(sa1.subagentDoneNotified).toBe(true);
			expect(sa2.subagentDoneNotified).toBe(true);
		});

		it("已消费或已通知的子代理跳过通知", async () => {
			const sendUserMessage = vi.fn().mockResolvedValue(undefined);
			const parentConv: any = {
				id: "parent-c1",
				cwd: "/test",
				session: {
					sendUserMessage,
					isStreaming: false,
				},
			};

			const cs: any = {
				refreshCompletionState: (ClientSession.prototype as any).refreshCompletionState,
				deliverSubagentCompletionNotice: (ClientSession.prototype as any).deliverSubagentCompletionNotice,
				emitConversations: vi.fn(),
				cwd: "/test",
				getLang: () => "zh",
				subagentOwnerOf: () => cs,
				convs: new Map([["parent-c1", parentConv]]),
				pendingSubagentNotices: new Map(),
				deliveringSubagentNotices: new Map(),
				flushSnapshot: vi.fn(),
				emit: vi.fn(),
				scheduleSubagentCompletionNotice: (ClientSession.prototype as any).scheduleSubagentCompletionNotice,
				flushSubagentCompletionNotice: (ClientSession.prototype as any).flushSubagentCompletionNotice,
			};

			const sa1: any = {
				id: "sa-1",
				parentId: "parent-c1",
				subagentConsumedByParent: true,
			};
			cs.scheduleSubagentCompletionNotice(sa1);

			await new Promise((r) => setTimeout(r, 450));
			expect(sendUserMessage).not.toHaveBeenCalled();
		});

		it("父对话在流式输出中使用 { deliverAs: 'steer' } 投递", async () => {
			const sendUserMessage = vi.fn().mockResolvedValue(undefined);
			const parentConv: any = {
				id: "parent-c1",
				cwd: "/test",
				session: {
					sendUserMessage,
					isStreaming: true,
				},
			};

			const cs: any = {
				refreshCompletionState: (ClientSession.prototype as any).refreshCompletionState,
				deliverSubagentCompletionNotice: (ClientSession.prototype as any).deliverSubagentCompletionNotice,
				emitConversations: vi.fn(),
				cwd: "/test",
				getLang: () => "zh",
				subagentOwnerOf: () => cs,
				convs: new Map([["parent-c1", parentConv]]),
				pendingSubagentNotices: new Map(),
				deliveringSubagentNotices: new Map(),
				flushSnapshot: vi.fn(),
				emit: vi.fn(),
				scheduleSubagentCompletionNotice: (ClientSession.prototype as any).scheduleSubagentCompletionNotice,
				flushSubagentCompletionNotice: (ClientSession.prototype as any).flushSubagentCompletionNotice,
			};

			const sa: any = {
				id: "sa-steer",
				parentId: "parent-c1",
				session: {
					model: { provider: "mock", id: "m1" },
					getLastAssistantText: () => "ok",
					agent: { state: { messages: [] } },
				},
			};
			cs.scheduleSubagentCompletionNotice(sa);

			await new Promise((r) => setTimeout(r, 450));
			expect(sendUserMessage).toHaveBeenCalledWith(expect.any(String), { deliverAs: "steer" });
		});
	});

	describe("Issue #726 subagent auto-wake circuit breaker & notification buffering", () => {
		const origEnv = process.env.PI_WEB_SUBAGENT_AUTO_WAKE_MAX_TURNS;

		afterEach(() => {
			if (origEnv !== undefined) {
				process.env.PI_WEB_SUBAGENT_AUTO_WAKE_MAX_TURNS = origEnv;
			} else {
				delete process.env.PI_WEB_SUBAGENT_AUTO_WAKE_MAX_TURNS;
			}
		});

		it("defaultSubagentAutoWakeMaxTurns 默认 5 并支持环境变量覆盖与归一化", () => {
			delete process.env.PI_WEB_SUBAGENT_AUTO_WAKE_MAX_TURNS;
			expect(defaultSubagentAutoWakeMaxTurns()).toBe(5);

			process.env.PI_WEB_SUBAGENT_AUTO_WAKE_MAX_TURNS = "10";
			expect(defaultSubagentAutoWakeMaxTurns()).toBe(10);

			process.env.PI_WEB_SUBAGENT_AUTO_WAKE_MAX_TURNS = "0";
			expect(defaultSubagentAutoWakeMaxTurns()).toBe(0);

			expect(normalizeSubagentAutoWakeMaxTurns(undefined)).toBe(0); // reads env=0
			expect(normalizeSubagentAutoWakeMaxTurns(8)).toBe(8);
			expect(normalizeSubagentAutoWakeMaxTurns("15")).toBe(15);
			expect(normalizeSubagentAutoWakeMaxTurns(-5)).toBe(0); // invalid falls back to default
		});

		it("自主唤醒达到配置的轮数上限时挂起唤醒，且通知不丢（放入 suspendedSubagents）", async () => {
			const sendUserMessage = vi.fn().mockResolvedValue(undefined);
			const parentConv: any = {
				id: "parent-c1",
				cwd: "/test",
				session: {
					sendUserMessage,
					isStreaming: false,
					isCompacting: false,
				},
				autonomousTurnsWithoutUser: 2,
			};

			const emit = vi.fn();
			const cs: any = {
				refreshCompletionState: (ClientSession.prototype as any).refreshCompletionState,
				deliverSubagentCompletionNotice: (ClientSession.prototype as any).deliverSubagentCompletionNotice,
				emitConversations: vi.fn(),
				cwd: "/test",
				getLang: () => "zh",
				subagentOwnerOf: () => cs,
				convs: new Map([["parent-c1", parentConv]]),
				pendingSubagentNotices: new Map(),
				deliveringSubagentNotices: new Map(),
				settingsSvc: {
					current: {
						subagentAutoWakeMaxTurns: 2, // 上限配置为 2
					},
				},
				flushSnapshot: vi.fn(),
				emit,
				scheduleSubagentCompletionNotice: (ClientSession.prototype as any).scheduleSubagentCompletionNotice,
				flushSubagentCompletionNotice: (ClientSession.prototype as any).flushSubagentCompletionNotice,
				checkSubagentWakeCircuitBreaker: (ClientSession.prototype as any).checkSubagentWakeCircuitBreaker,
			};

			const sa1 = makeMockConv({ id: "sa-breaker-1", output: "产出1" });
			(sa1 as any).parentId = "parent-c1";

			cs.scheduleSubagentCompletionNotice(sa1);
			await new Promise((r) => setTimeout(r, 450));

			// 达到上限，未向父对话发送消息
			expect(sendUserMessage).not.toHaveBeenCalled();
			// 未标记为已通知，防止通知永久丢失
			expect((sa1 as any).subagentDoneNotified).toBeUndefined();
			// 挂起通知已暂存至 parentConv.suspendedSubagents
			expect(parentConv.suspendedSubagents).toBeDefined();
			expect(parentConv.suspendedSubagents.has(sa1)).toBe(true);

			// 发送了 warning notice 提示用户
			expect(emit).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "notice",
					level: "warning",
					text: expect.stringContaining("已暂停自动唤醒（1 个完成通知已暂存）"),
				}),
			);

			// 随后又有一个子代理完成，同样进入暂存池
			const sa2 = makeMockConv({ id: "sa-breaker-2", output: "产出2" });
			(sa2 as any).parentId = "parent-c1";

			cs.scheduleSubagentCompletionNotice(sa2);
			await new Promise((r) => setTimeout(r, 450));

			expect(sendUserMessage).not.toHaveBeenCalled();
			expect((sa2 as any).subagentDoneNotified).toBeUndefined();
			expect(parentConv.suspendedSubagents.size).toBe(2);
			expect(parentConv.suspendedSubagents.has(sa2)).toBe(true);
			expect(emit).toHaveBeenLastCalledWith(
				expect.objectContaining({
					type: "notice",
					level: "warning",
					text: expect.stringContaining("已暂停自动唤醒（2 个完成通知已暂存）"),
				}),
			);
		});

		it("配置为 0（不限制）时，即使连续超过 5 轮仍可正常自动推进", async () => {
			const sendUserMessage = vi.fn().mockResolvedValue(undefined);
			const parentConv: any = {
				id: "parent-c1",
				cwd: "/test",
				session: {
					sendUserMessage,
					isStreaming: false,
					isCompacting: false,
				},
				autonomousTurnsWithoutUser: 8, // 已超过 5
				consecutiveIdleWakeTurns: 0,
				recentWakeSubagentIds: ["sa-old-1", "sa-old-2"],
			};

			const cs: any = {
				refreshCompletionState: (ClientSession.prototype as any).refreshCompletionState,
				deliverSubagentCompletionNotice: (ClientSession.prototype as any).deliverSubagentCompletionNotice,
				emitConversations: vi.fn(),
				cwd: "/test",
				getLang: () => "zh",
				subagentOwnerOf: () => cs,
				convs: new Map([["parent-c1", parentConv]]),
				pendingSubagentNotices: new Map(),
				deliveringSubagentNotices: new Map(),
				settingsSvc: {
					current: {
						subagentAutoWakeMaxTurns: 0, // 0 = 不限制
					},
				},
				flushSnapshot: vi.fn(),
				emit: vi.fn(),
				scheduleSubagentCompletionNotice: (ClientSession.prototype as any).scheduleSubagentCompletionNotice,
				flushSubagentCompletionNotice: (ClientSession.prototype as any).flushSubagentCompletionNotice,
				checkSubagentWakeCircuitBreaker: (ClientSession.prototype as any).checkSubagentWakeCircuitBreaker,
			};

			const sa = makeMockConv({ id: "sa-progressing-9", output: "第9步完成" });
			(sa as any).parentId = "parent-c1";

			cs.scheduleSubagentCompletionNotice(sa);
			await new Promise((r) => setTimeout(r, 450));

			expect(sendUserMessage).toHaveBeenCalledTimes(1);
			expect(parentConv.autonomousTurnsWithoutUser).toBe(9);
			expect((sa as any).subagentDoneNotified).toBe(true);
		});

		it("智能熔断：连续空转（consecutiveIdleWakeTurns >= 2）即使未达总轮数上限也挂起", async () => {
			const sendUserMessage = vi.fn().mockResolvedValue(undefined);
			const parentConv: any = {
				id: "parent-c1",
				cwd: "/test",
				session: {
					sendUserMessage,
					isStreaming: false,
					isCompacting: false,
				},
				autonomousTurnsWithoutUser: 2, // 未达 5
				consecutiveIdleWakeTurns: 2, // 连续 2 轮空转（未调用任何工具）
			};

			const emit = vi.fn();
			const cs: any = {
				refreshCompletionState: (ClientSession.prototype as any).refreshCompletionState,
				deliverSubagentCompletionNotice: (ClientSession.prototype as any).deliverSubagentCompletionNotice,
				emitConversations: vi.fn(),
				cwd: "/test",
				getLang: () => "zh",
				subagentOwnerOf: () => cs,
				convs: new Map([["parent-c1", parentConv]]),
				pendingSubagentNotices: new Map(),
				deliveringSubagentNotices: new Map(),
				settingsSvc: {
					current: {
						subagentAutoWakeMaxTurns: 5,
					},
				},
				flushSnapshot: vi.fn(),
				emit,
				scheduleSubagentCompletionNotice: (ClientSession.prototype as any).scheduleSubagentCompletionNotice,
				flushSubagentCompletionNotice: (ClientSession.prototype as any).flushSubagentCompletionNotice,
				checkSubagentWakeCircuitBreaker: (ClientSession.prototype as any).checkSubagentWakeCircuitBreaker,
			};

			const sa = makeMockConv({ id: "sa-idle-check", output: "结果" });
			(sa as any).parentId = "parent-c1";

			cs.scheduleSubagentCompletionNotice(sa);
			await new Promise((r) => setTimeout(r, 450));

			expect(sendUserMessage).not.toHaveBeenCalled();
			expect(parentConv.suspendedSubagents.has(sa)).toBe(true);
			expect(emit).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "notice",
					level: "warning",
					text: expect.stringContaining("连续 2 轮未执行任何操作（处于空转/等待状态）"),
				}),
			);
		});

		it("智能熔断：单一子代理反复震荡死锁（连续 4 次唤醒完全来自同一个子代理）及时挂起", async () => {
			const sendUserMessage = vi.fn().mockResolvedValue(undefined);
			const parentConv: any = {
				id: "parent-c1",
				cwd: "/test",
				session: {
					sendUserMessage,
					isStreaming: false,
					isCompacting: false,
				},
				autonomousTurnsWithoutUser: 3, // 未达 5
				consecutiveIdleWakeTurns: 0,
				recentWakeSubagentIds: ["sa-loop-1", "sa-loop-1", "sa-loop-1", "sa-loop-1"], // 连续 4 次同一个
			};

			const emit = vi.fn();
			const cs: any = {
				refreshCompletionState: (ClientSession.prototype as any).refreshCompletionState,
				deliverSubagentCompletionNotice: (ClientSession.prototype as any).deliverSubagentCompletionNotice,
				emitConversations: vi.fn(),
				cwd: "/test",
				getLang: () => "zh",
				subagentOwnerOf: () => cs,
				convs: new Map([["parent-c1", parentConv]]),
				pendingSubagentNotices: new Map(),
				deliveringSubagentNotices: new Map(),
				settingsSvc: {
					current: {
						subagentAutoWakeMaxTurns: 5,
					},
				},
				flushSnapshot: vi.fn(),
				emit,
				scheduleSubagentCompletionNotice: (ClientSession.prototype as any).scheduleSubagentCompletionNotice,
				flushSubagentCompletionNotice: (ClientSession.prototype as any).flushSubagentCompletionNotice,
				checkSubagentWakeCircuitBreaker: (ClientSession.prototype as any).checkSubagentWakeCircuitBreaker,
			};

			const sa = makeMockConv({ id: "sa-loop-1", output: "又报错了" });
			(sa as any).parentId = "parent-c1";

			cs.scheduleSubagentCompletionNotice(sa);
			await new Promise((r) => setTimeout(r, 450));

			expect(sendUserMessage).not.toHaveBeenCalled();
			expect(parentConv.suspendedSubagents.has(sa)).toBe(true);
			expect(emit).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "notice",
					level: "warning",
					text: expect.stringContaining("连续反复唤醒父对话达到 4 次，可能陷入修改死循环"),
				}),
			);
		});

		it("用户下一次 prompt 交互时，自动提取暂存的通知并合并注入，重置自主轮次", async () => {
			const sa1 = makeMockConv({ id: "sa-buf-1111", output: "摸底完成" });
			const sa2 = makeMockConv({ id: "sa-buf-2222", output: "单元测试通过" });

			let deliveredText = "";
			const sessionMock: any = {
				prompt: vi.fn().mockImplementation((text: string) => {
					deliveredText = text;
					return Promise.resolve();
				}),
				isStreaming: false,
				agent: { state: { messages: [] } },
				getSessionStats: () => ({ totalMessages: 1 }),
			};

			const conv: any = {
				id: "parent-c1",
				cwd: "/test",
				session: sessionMock,
				autonomousTurnsWithoutUser: 5,
				consecutiveIdleWakeTurns: 2,
				recentWakeSubagentIds: ["sa-buf-1111"],
				suspendedSubagents: new Set([sa1, sa2]),
			};

			const cs: any = {
				conv,
				session: sessionMock,
				cwd: "/test",
				clientId: "test-client",
				getLang: () => "zh",
				markerSvc: { clearActions: vi.fn() },
				dispatchToDelegate: vi.fn().mockResolvedValue(false),
				dispatchToGoalExecutor: vi.fn().mockResolvedValue(false),
				quiesceBlocked: () => false,
				parseSlash: () => null,
				slash: { exec: vi.fn().mockResolvedValue(false) },
				settingsSvc: {
					current: {
						parallelReminderEnabled: false,
						defaultAgentPreset: "standard",
					},
				},
				convs: new Map([["parent-c1", conv]]),
				activeId: "parent-c1",
				flushSnapshot: vi.fn(),
				emit: vi.fn(),
				emitConversations: vi.fn(),
				startWorkspaceSnapshot: vi.fn(),
				activeSessionFileResolved: () => undefined,
				triggerSoftCapCompactionIfExceeded: vi.fn().mockResolvedValue(false),
				drafts: { clear: vi.fn() },
				drainSuspendedSubagents: (ClientSession.prototype as any).drainSuspendedSubagents,
				prompt: (ClientSession.prototype as any).prompt,
				assertSubagentWorktreeAdmission: vi.fn(),
			};

			// 用户发送新指令
			await cs.prompt("好的，开始提交代码");
			expect(cs.emit.mock.calls).toEqual([]);

			// 挂起的通知被提取，状态重置
			expect(conv.autonomousTurnsWithoutUser).toBe(0);
			expect(conv.consecutiveIdleWakeTurns).toBe(0);
			expect(conv.recentWakeSubagentIds).toEqual([]);
			expect(conv.suspendedSubagents.size).toBe(0);
			expect((sa1 as any).subagentDoneNotified).toBe(true);
			expect((sa2 as any).subagentDoneNotified).toBe(true);

			// 投递文本中同时包含了暂存子代理的摘要以及用户的新指令
			expect(deliveredText).toContain("[在自动唤醒挂起期间已完成的子代理通知]：");
			expect(deliveredText).toContain("sa-buf-1");
			expect(deliveredText).toContain("摸底完成");
			expect(deliveredText).toContain("sa-buf-2");
			expect(deliveredText).toContain("单元测试通过");
			expect(deliveredText).toContain("[用户最新指令]：");
			expect(deliveredText).toContain("好的，开始提交代码");
		});

		it("用户发送空白 prompt 时，直接以暂存的子代理通知作为提示词投递继续", async () => {
			const sa1 = makeMockConv({ id: "sa-buf-3333", output: "构建成功" });

			let deliveredText = "";
			const sessionMock: any = {
				prompt: vi.fn().mockImplementation((text: string) => {
					deliveredText = text;
					return Promise.resolve();
				}),
				isStreaming: false,
				agent: { state: { messages: [] } },
				getSessionStats: () => ({ totalMessages: 1 }),
			};

			const conv: any = {
				id: "parent-c1",
				cwd: "/test",
				session: sessionMock,
				autonomousTurnsWithoutUser: 5,
				consecutiveIdleWakeTurns: 0,
				suspendedSubagents: new Set([sa1]),
			};

			const cs: any = {
				conv,
				session: sessionMock,
				cwd: "/test",
				clientId: "test-client",
				getLang: () => "zh",
				markerSvc: { clearActions: vi.fn() },
				dispatchToDelegate: vi.fn().mockResolvedValue(false),
				dispatchToGoalExecutor: vi.fn().mockResolvedValue(false),
				quiesceBlocked: () => false,
				parseSlash: () => null,
				slash: { exec: vi.fn().mockResolvedValue(false) },
				settingsSvc: {
					current: {
						parallelReminderEnabled: false,
						defaultAgentPreset: "standard",
					},
				},
				convs: new Map([["parent-c1", conv]]),
				activeId: "parent-c1",
				flushSnapshot: vi.fn(),
				emit: vi.fn(),
				emitConversations: vi.fn(),
				startWorkspaceSnapshot: vi.fn(),
				activeSessionFileResolved: () => undefined,
				triggerSoftCapCompactionIfExceeded: vi.fn().mockResolvedValue(false),
				drafts: { clear: vi.fn() },
				drainSuspendedSubagents: (ClientSession.prototype as any).drainSuspendedSubagents,
				prompt: (ClientSession.prototype as any).prompt,
				assertSubagentWorktreeAdmission: vi.fn(),
			};

			await cs.prompt("");

			expect(conv.autonomousTurnsWithoutUser).toBe(0);
			expect(conv.suspendedSubagents.size).toBe(0);
			expect((sa1 as any).subagentDoneNotified).toBe(true);
			// 没有用户输入时，直接投递子代理通知本身
			expect(deliveredText).toContain("[子代理执行完成通知]");
			expect(deliveredText).toContain("sa-buf-3");
			expect(deliveredText).toContain("构建成功");
		});

		it("人类在 UI 批准危险操作（resolveToolApproval）时重置自主轮次与空转计数", () => {
			const conv: any = {
				id: "parent-c1",
				autonomousTurnsWithoutUser: 4,
				consecutiveIdleWakeTurns: 2,
				recentWakeSubagentIds: ["sa-1"],
			};

			let recordedDecision: any;
			const cs: any = {
				convs: new Map([["parent-c1", conv]]),
				pendingApprovals: new Map([
					[
						"app-1",
						{
							conversationId: "parent-c1",
							toolName: "bash",
							params: { command: "rm -rf tmp" },
							resolve: vi.fn(),
						},
					],
				]),
				auditLogger: {
					record: (entry: any) => {
						recordedDecision = entry;
					},
				},
				emit: vi.fn(),
				flushSnapshot: vi.fn(),
				resolveToolApproval: (ClientSession.prototype as any).resolveToolApproval,
			};

			const ok = cs.resolveToolApproval("app-1", "approve");
			expect(ok).toBe(true);
			// 人类审批重置了计数
			expect(conv.autonomousTurnsWithoutUser).toBe(0);
			expect(conv.consecutiveIdleWakeTurns).toBe(0);
			expect(conv.recentWakeSubagentIds).toEqual([]);
			expect(recordedDecision?.decision).toBe("approved");
		});

		it("父对话通过 get_result / wait_all 消费子代理时，从挂起池中移除该子代理", () => {
			const sa1 = makeMockConv({ id: "sa-consumed-1", output: "报告" });
			const sa2 = makeMockConv({ id: "sa-consumed-2", output: "代码" });

			const conv: any = {
				id: "parent-c1",
				suspendedSubagents: new Set([sa1, sa2]),
			};

			const cs: any = {
				convs: new Map([
					["parent-c1", conv],
					["sa-consumed-1", sa1],
					["sa-consumed-2", sa2],
				]),
				subagentOwnerOf: () => cs,
				subagentCurrentId: (id: string) => id,
			};

			// 模拟 markSubagentsConsumed 逻辑
			for (const id of ["sa-consumed-1"]) {
				const owner = cs.subagentOwnerOf(id);
				const target = owner.convs.get(id);
				if (target) {
					target.subagentConsumedByParent = true;
					for (const parent of owner.convs.values()) {
						parent.suspendedSubagents?.delete(target);
					}
				}
			}

			expect((sa1 as any).subagentConsumedByParent).toBe(true);
			expect(conv.suspendedSubagents.has(sa1)).toBe(false);
			expect(conv.suspendedSubagents.has(sa2)).toBe(true);
		});
	});
});
