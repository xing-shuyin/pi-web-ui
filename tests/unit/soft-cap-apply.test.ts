import { describe, expect, it, vi } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { ClientSession } from "../../server/agent-service.js";
import { DEFAULT_COMPACTION_RESERVE_TOKENS } from "../../server/soft-cap.js";
import { fakeClientSession } from "../helpers/fake-session.js";

/** 不起 server：伪造 settingsSvc + convs，直接调原型方法验逻辑。 */
function serviceWith(settings: { softCapTokens: number; softCapByModel: Record<string, number> }, sessions: unknown[]) {
	const svc = fakeClientSession() as {
		settingsSvc: { current: typeof settings };
		convs: Map<string, unknown>;
	};
	svc.settingsSvc = { current: settings };
	svc.convs = new Map(sessions.map((s, i) => [`c${i}`, { session: s }]));
	return svc;
}

/** 可变窗口 + 可选 isSubagent 标记（issue #773：子代理会话一视同仁）。 */
function fakeSession(
	model: { provider: string; id: string } | null,
	window: number,
	opts: { keepRecent?: number; isSubagent?: boolean } = {},
) {
	const applyOverrides = vi.fn();
	const state = { window };
	return {
		model,
		isSubagent: opts.isSubagent,
		getSessionStats: () => ({ contextUsage: { tokens: 1000, contextWindow: state.window, percent: 1 } }),
		settingsManager: {
			applyOverrides,
			getCompactionKeepRecentTokens: () => opts.keepRecent ?? 20000,
		},
		_captured: applyOverrides,
		_setWindow: (w: number) => {
			state.window = w;
		},
	};
}

describe("applyCompactionOverrides", () => {
	const apply = (svc: unknown) =>
		(ClientSession.prototype as unknown as Record<string, (this: unknown) => void>).applyCompactionOverrides.call(svc);

	it("软上限关闭 → 保持 SDK 默认 reserveTokens（16384，物理朱底）", () => {
		const s1 = fakeSession({ provider: "xai", id: "grok-4" }, 500000);
		const s2 = fakeSession({ provider: "openai", id: "gpt-4o" }, 128000);
		const svc = serviceWith({ softCapTokens: 0, softCapByModel: {} }, [s1, s2]);
		apply(svc);
		expect(s1._captured).toHaveBeenCalledWith({
			compaction: { reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS },
		});
		expect(s2._captured).toHaveBeenCalledWith({
			compaction: { reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS },
		});
	});

	it("软上限开启 → 逐会话按自己的窗口算 cw - cap（回合内层，issue #773）", () => {
		// 500K 窗口 + 190K 上限 → 310K；128K 窗口压不下来 → 回落默认。
		const big = fakeSession({ provider: "xai", id: "grok-4" }, 500000);
		const small = fakeSession({ provider: "openai", id: "gpt-4o" }, 128000);
		const svc = serviceWith({ softCapTokens: 190000, softCapByModel: {} }, [big, small]);
		apply(svc);
		expect(big._captured).toHaveBeenCalledWith({ compaction: { reserveTokens: 310000 } });
		expect(small._captured).toHaveBeenCalledWith({
			compaction: { reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS },
		});
	});

	it("1M 窗口 + 256K 软上限 → reserve 744K（主会话与子代理一视同仁）", () => {
		const main = fakeSession({ provider: "anthropic", id: "claude" }, 1_000_000);
		const sub = fakeSession({ provider: "anthropic", id: "claude" }, 1_000_000, { isSubagent: true });
		const svc = serviceWith({ softCapTokens: 256000, softCapByModel: {} }, [main, sub]);
		apply(svc);
		expect(main._captured).toHaveBeenCalledWith({ compaction: { reserveTokens: 744_000 } });
		expect(sub._captured).toHaveBeenCalledWith({ compaction: { reserveTokens: 744_000 } });
	});

	it("按模型覆盖用会话自己的 modelKey（不串成其他会话的模型）", () => {
		const grok = fakeSession({ provider: "xai", id: "grok-4" }, 500000);
		const claude = fakeSession({ provider: "anthropic", id: "claude" }, 500000);
		const svc = serviceWith({ softCapTokens: 400000, softCapByModel: { "xai/grok-4": 100000 } }, [grok, claude]);
		apply(svc);
		expect(grok._captured).toHaveBeenCalledWith({ compaction: { reserveTokens: 400000 } });
		expect(claude._captured).toHaveBeenCalledWith({ compaction: { reserveTokens: 100000 } });
	});

	it("换模型后重算、不留上一模型的残值（issue #716 的担心）", () => {
		const s = fakeSession({ provider: "xai", id: "grok-4" }, 1_000_000);
		const svc = serviceWith({ softCapTokens: 256000, softCapByModel: {} }, [s]);
		apply(svc);
		expect(s._captured).toHaveBeenLastCalledWith({ compaction: { reserveTokens: 744_000 } });
		// 换到 200K 窗口的模型：新 cap 220000 可压（reserve 200000-220000 < 0 → 不可压）
		s._setWindow(200000);
		apply(svc);
		expect(s._captured).toHaveBeenLastCalledWith({
			compaction: { reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS },
		});
	});

	it("cap 比 keepRecent 还小 → 不注射（否则每个工具间隙都重压一次）", () => {
		const s = fakeSession({ provider: "anthropic", id: "claude" }, 1_000_000, { keepRecent: 20000 });
		const svc = serviceWith({ softCapTokens: 15000, softCapByModel: {} }, [s]);
		apply(svc);
		expect(s._captured).toHaveBeenCalledWith({
			compaction: { reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS },
		});
	});

	it("未就绪会话抛错不连累其他会话", () => {
		const bad = {
			model: { provider: "a", id: "b" },
			settingsManager: {
				applyOverrides: () => {
					throw new Error("gone");
				},
			},
		};
		const good = fakeSession({ provider: "a", id: "b" }, 200000);
		const svc = serviceWith({ softCapTokens: 100000, softCapByModel: {} }, [bad, good]);
		expect(() => apply(svc)).not.toThrow();
		expect(good._captured).toHaveBeenCalledWith({ compaction: { reserveTokens: 100000 } });
	});

	it("注入后 SDK 真实读到 cw - cap（SettingsManager 解析口径）", () => {
		const sm = SettingsManager.inMemory();
		const s = fakeSession({ provider: "anthropic", id: "claude" }, 1_000_000);
		(s as unknown as { settingsManager: unknown }).settingsManager = sm;
		const svc = serviceWith({ softCapTokens: 256000, softCapByModel: {} }, [s]);
		apply(svc);
		const model = { provider: "anthropic", id: "claude", contextWindow: 1_000_000 } as never;
		expect(sm.getCompactionSettings(model).reserveTokens).toBe(744_000);
	});
});

describe("activeSoftCap", () => {
	it("合法返回 cap，非法/关闭返回 null", () => {
		const cap = (
			settings: { softCapTokens: number; softCapByModel: Record<string, number> },
			model: unknown,
			window: number,
		) =>
			ClientSession.prototype.activeSoftCap.call(
				{
					settingsSvc: { current: settings },
					session: { model },
				},
				window,
			);
		expect(cap({ softCapTokens: 190000, softCapByModel: {} }, { provider: "xai", id: "grok-4" }, 500000)).toBe(190000);
		expect(cap({ softCapTokens: 0, softCapByModel: {} }, { provider: "xai", id: "grok-4" }, 500000)).toBeNull();
		// cap 太接近或超过物理上限（保留少于 SOFT_CAP_MIN_HEADROOM）
		expect(cap({ softCapTokens: 199500, softCapByModel: {} }, { provider: "a", id: "b" }, 200000)).toBeNull();
		expect(cap({ softCapTokens: 300000, softCapByModel: {} }, { provider: "a", id: "b" }, 128000)).toBeNull();
	});

	it("可显式传入会话：按模型覆盖用传入会话的模型，不串成活动会话（issue #773）", () => {
		const svc = {
			settingsSvc: {
				current: { softCapTokens: 300000, softCapByModel: { "xai/grok-4": 120000 } },
			},
			session: { model: { provider: "anthropic", id: "claude" } },
		};
		const call = (session?: unknown) =>
			(
				ClientSession.prototype as unknown as Record<string, (w: number, s?: unknown) => number | null>
			).activeSoftCap.call(svc, 500000, session);
		// 不传 → 用活动会话（claude 没有覆盖 → 全局 300000）
		expect(call()).toBe(300000);
		// 传子代理会话 → 命中 xai/grok-4 的按模型覆盖
		expect(call({ model: { provider: "xai", id: "grok-4" } })).toBe(120000);
	});
});

describe("triggerSoftCapCompactionIfExceeded", () => {
	const trigger = (
		ClientSession.prototype as unknown as Record<string, (this: unknown, conv: unknown) => Promise<boolean>>
	).triggerSoftCapCompactionIfExceeded;

	function makeContext(tokens: number, window: number, softCap: number, isStreaming = false) {
		const compact = vi.fn().mockResolvedValue(undefined);
		const conv = {
			session: {
				model: { provider: "xai", id: "grok-4" },
				isStreaming,
				compact,
				getSessionStats: () => ({
					contextUsage: { tokens, contextWindow: window, percent: (tokens / window) * 100 },
				}),
			},
			lastCompactionTokens: null,
			lastTurnBaseTokens: 1000,
		};
		const svc = {
			settingsSvc: {
				current: {
					softCapTokens: softCap,
					softCapByModel: {},
				},
			},
			currentBaseTokens: () => 1000,
			isBlankConversation: () => false,
			hasSettledAssistantUsage: () => true,
			estimateNonSystemTokens: () => 0,
			activeSoftCap: ClientSession.prototype.activeSoftCap,
			getEffectiveContextTokens: (ClientSession.prototype as unknown as Record<string, (c: unknown) => number>)
				.getEffectiveContextTokens,
			emit: vi.fn(),
		};
		return { conv, svc, compact };
	}

	it("当前 tokens 超过软上限时主动调用 session.compact()", async () => {
		const { conv, svc, compact } = makeContext(310000, 1000000, 300000);
		const result = await trigger.call(svc, conv);
		expect(result).toBe(true);
		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("当前 tokens 未超过软上限时不触发压缩", async () => {
		const { conv, svc, compact } = makeContext(250000, 1000000, 300000);
		const result = await trigger.call(svc, conv);
		expect(result).toBe(false);
		expect(compact).not.toHaveBeenCalled();
	});

	it("正在流式输出中（isStreaming = true）不主动打断", async () => {
		const { conv, svc, compact } = makeContext(350000, 1000000, 300000, true);
		const result = await trigger.call(svc, conv);
		expect(result).toBe(false);
		expect(compact).not.toHaveBeenCalled();
	});

	it("SDK 报 Already compacted 或 Nothing to compact 时静默处理，不外抛异常", async () => {
		const { conv, svc, compact } = makeContext(350000, 1000000, 300000);
		compact.mockRejectedValue(new Error("Already compacted"));
		const result = await trigger.call(svc, conv);
		expect(result).toBe(false);
	});
});
