import { describe, expect, it } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";

/** 构造用于测试 buildLightState 的假 ClientSession 上下文 */
function createFakeSessionContext(conv: any, baseTokensVal = 10000) {
	const svc = fakeClientSession() as any;
	svc.convs = new Map([[conv.id, conv]]);
	svc.activeId = conv.id;
	svc.settingsSvc = { current: { softCapTokens: 0, softCapByModel: {} } };
	svc.roots = [];
	svc.cwd = "/workspace";
	svc.clientId = "test-client";
	svc.currentBaseTokens = () => baseTokensVal;
	svc.activeSoftCap = () => null;
	svc.sessionStats = () => conv.session.getSessionStats();
	svc.isBlankConversation = (c: any) =>
		c.session.agent.state.messages.length === 0 &&
		c.queueSteering.length === 0 &&
		c.queueFollowUp.length === 0 &&
		!c.session.isStreaming;
	svc.pendingSubagentNotices = new Map();
	svc.deliveringSubagentNotices = new Set();
	svc.pendingQuestions = new Map();
	svc.pendingApprovals = new Map();
	svc.pendingQuestionForSnapshot = () => null;
	svc.pendingApprovalForSnapshot = () => null;
	svc.markerSvc = { getActionSuggestions: () => null };
	svc.planManager = { getPlan: () => null };
	svc.subagentHandoffs = [];
	svc.getLang = () => "zh";
	svc.version = 0;
	svc.isPiConfigured = () => true;
	svc.isPiCliInstalled = () => true;
	svc.draftForSnapshot = () => undefined;
	return svc;
}

describe("首轮上下文用量与 Base 开销平滑过渡", () => {
	it("空白会话真实反映 Base 开销（10k）", () => {
		const conv = {
			id: "c1",
			queueSteering: [],
			queueFollowUp: [],
			session: {
				isStreaming: false,
				agent: {
					state: {
						model: { id: "m1", name: "m1", provider: "p1", contextWindow: 200000 },
						messages: [],
						tools: [],
						streamingMessage: null,
						thinkingLevel: "off",
					},
				},
				getSessionStats: () => ({
					totalMessages: 0,
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					cost: 0,
					contextUsage: { tokens: 0, contextWindow: 200000, percent: 0 },
				}),
				getAvailableThinkingLevels: () => [],
			},
		};

		const svc = createFakeSessionContext(conv, 10000);
		const light = (ClientSession.prototype as any).buildLightState.call(svc, 1);
		expect(light.stats.contextUsage.tokens).toBe(10000);
	});

	it("首轮发出 prompt 且 AI 尚未回复时，叠加非系统消息开销，不重复叠加 SDK 系统提示词（杜绝 17k）", () => {
		// 模拟 SDK 在收到 prompt('你好') 时的内部状态：
		// 1) messages 头部插入带有所有 sections 的 system 消息（按字符数估算约 7000 tokens）
		// 2) 插入 user 消息('你好'，约 1 个 token)
		// 3) SDK 的 contextUsage.tokens 汇报 7001 (已包含了粗估的 system 消息)
		const conv = {
			id: "c1",
			queueSteering: [],
			queueFollowUp: [],
			session: {
				isStreaming: true,
				agent: {
					state: {
						model: { id: "m1", name: "m1", provider: "p1", contextWindow: 200000 },
						messages: [
							{ role: "system", content: "long system prompt".repeat(1500) },
							{ role: "user", content: [{ type: "text", text: "你好" }] },
						],
						tools: [],
						streamingMessage: null,
						thinkingLevel: "off",
					},
				},
				getSessionStats: () => ({
					totalMessages: 1,
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					cost: 0,
					// SDK 此时给出的粗估值包含了 system 消息 (~7001)
					contextUsage: { tokens: 7001, contextWindow: 200000, percent: 3.5 },
				}),
				getAvailableThinkingLevels: () => [],
			},
		};

		const svc = createFakeSessionContext(conv, 10000);
		const light = (ClientSession.prototype as any).buildLightState.call(svc, 1);
		// 期望：精准 Base (10000) + 非系统消息 (你好，1 token) = 10001
		// 绝对不能是 10000 + 7001 = 17001！
		expect(light.stats.contextUsage.tokens).toBeLessThan(10010);
		expect(light.stats.contextUsage.tokens).toBeGreaterThanOrEqual(10000);
	});

	it("首轮生成途中中止（Abort）无有效 usage 时，平滑保持在 Base 开销附近，不跳变为 SDK 粗估值", () => {
		// 模拟被中断后 SDK 记录了 stopReason: 'aborted' 的 assistant 消息，usage 全为 0
		const conv = {
			id: "c1",
			queueSteering: [],
			queueFollowUp: [],
			session: {
				isStreaming: false,
				agent: {
					state: {
						model: { id: "m1", name: "m1", provider: "p1", contextWindow: 200000 },
						messages: [
							{ role: "system", content: "long system prompt".repeat(1500) },
							{ role: "user", content: [{ type: "text", text: "你好" }] },
							{
								role: "assistant",
								stopReason: "aborted",
								content: [],
								usage: { input: 0, output: 0, totalTokens: 0 },
							},
						],
						tools: [],
						streamingMessage: null,
						thinkingLevel: "off",
					},
				},
				getSessionStats: () => ({
					totalMessages: 2,
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					cost: 0,
					contextUsage: { tokens: 7001, contextWindow: 200000, percent: 3.5 },
				}),
				getAvailableThinkingLevels: () => [],
			},
		};

		const svc = createFakeSessionContext(conv, 10000);
		const light = (ClientSession.prototype as any).buildLightState.call(svc, 1);
		expect(light.stats.contextUsage.tokens).toBeLessThan(10010);
		expect(light.stats.contextUsage.tokens).toBeGreaterThanOrEqual(10000);
	});

	it("大模型回复定稿后（包含真实有效 usage），正确切换至权威 usage 并支持预设差额补偿", () => {
		const conv = {
			id: "c1",
			lastTurnBaseTokens: 10000, // 定稿时记录了当时的 Base
			queueSteering: [],
			queueFollowUp: [],
			session: {
				isStreaming: false,
				agent: {
					state: {
						model: { id: "m1", name: "m1", provider: "p1", contextWindow: 200000 },
						messages: [
							{ role: "system", content: "system" },
							{ role: "user", content: "你好" },
							{
								role: "assistant",
								stopReason: "end_turn",
								content: [{ type: "text", text: "你好！" }],
								usage: { input: 9800, output: 200, totalTokens: 10000 },
							},
						],
						tools: [],
						streamingMessage: null,
						thinkingLevel: "off",
					},
				},
				getSessionStats: () => ({
					totalMessages: 2,
					tokens: { input: 9800, output: 200, cacheRead: 0, cacheWrite: 0, total: 10000 },
					cost: 0.01,
					contextUsage: { tokens: 10000, contextWindow: 200000, percent: 5 },
				}),
				getAvailableThinkingLevels: () => [],
			},
		};

		const svc = createFakeSessionContext(conv, 10000);
		const light = (ClientSession.prototype as any).buildLightState.call(svc, 1);
		expect(light.stats.contextUsage.tokens).toBe(10000);

		// 如果中途切换预设，导致 Base 减少 3000 (变为 7000)
		svc.currentBaseTokens = () => 7000;
		const lightSwitched = (ClientSession.prototype as any).buildLightState.call(svc, 2);
		// 10000 + (7000 - 10000) = 7000
		expect(lightSwitched.stats.contextUsage.tokens).toBe(7000);
	});
});
