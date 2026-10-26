import { describe, expect, it } from "vitest";
import {
	classifyQuestionAddedScroll,
	classifyScroll,
	shouldEscapeOnScroll,
	shouldPreloadEarlier,
	shouldScrollToBottomOnStreamChange,
} from "../../web/src/components/scroll-classify.js";

/**
 * MUTATION-PROOF PIN for the scroll layout-shift discriminator (5cd680b).
 *
 * The synthetic E2E harness self-recovers (the lazy-window sweep re-clears
 * escapedRef), so reverting the dSh<0 branch still shows 9/9 green there.
 * These unit tests do NOT self-recover: if you simulate the pre-fix behavior
 * by deleting/commenting the `if (dSh < 0)` branch in classifyScroll
 * (web/src/components/scroll-classify.ts) — i.e. always treating a moderate
 * negative dSt as user intent (flipEscape = true) — the tests marked
 * [MUTATION-KILL] below MUST fail.
 *
 * Mutation check procedure:
 *   1. Comment out `if (dSh < 0) { ... return ...; }` in classifyScroll.
 *   2. npx vitest run tests/unit/scroll-classify.test.ts  → expect RED.
 *   3. Restore the branch.
 *   4. npx vitest run tests/unit/scroll-classify.test.ts  → expect GREEN.
 */
const base = {
	escaped: false,
	graceActive: false,
	stuck: true,
};

function run(over: Partial<Parameters<typeof classifyScroll>[0]>) {
	return classifyScroll({ ...base, ...over } as Parameters<typeof classifyScroll>[0]);
}

describe("classifyScroll — layout-shift discriminator decision table", () => {
	it("[MUTATION-KILL] dSt in (-500,-4), dSh < 0, escaped=false, stuck → NO flipEscape, reassert=true (layout collapse while stuck: follow the bottom)", () => {
		const d = run({ dSt: -120, dSh: -300 });
		expect(d.flipEscape).toBe(false);
		expect(d.reassert).toBe(true);
	});

	it("[MUTATION-KILL] dSt in (-500,-4), dSh < 0, escaped=true → stays escaped (collapsed while reading: no drag, no reassert)", () => {
		const d = run({ dSt: -120, dSh: -300, escaped: true });
		expect(d.flipEscape).toBe(false);
		expect(d.reassert).toBe(false);
	});

	it("[MUTATION-KILL] dSt in (-500,-4), dSh >= 0 (true user wheel-up) → flipEscape=true", () => {
		const d = run({ dSt: -120, dSh: 0 });
		expect(d.flipEscape).toBe(true);
		expect(d.reassert).toBe(false);

		const growing = run({ dSt: -120, dSh: 50 });
		expect(growing.flipEscape).toBe(true);
	});

	it("dSt < -500 (large jump = native clamp after layout collapse) → escape preserved: no flip, no reassert", () => {
		const collapse = run({ dSt: -800, dSh: -600 });
		expect(collapse.flipEscape).toBe(false);
		expect(collapse.reassert).toBe(false);

		const largeUser = run({ dSt: -800, dSh: 0 });
		expect(largeUser.flipEscape).toBe(false); // existing behavior for that band
	});

	it("dSt >= -4 → no-op", () => {
		for (const dSt of [0, 5, -4]) {
			const d = run({ dSt, dSh: 0 });
			expect(d.flipEscape).toBe(false);
			expect(d.reassert).toBe(false);
		}
	});

	it("graceActive=true + negative dSt → no flip, no reassert (programmatic jumps are never user intent)", () => {
		const d = run({ dSt: -120, dSh: -300, graceActive: true });
		expect(d.flipEscape).toBe(false);
		expect(d.reassert).toBe(false);
	});

	it("not stuck → no reassert even on layout collapse", () => {
		const d = run({ dSt: -120, dSh: -300, stuck: false });
		expect(d.reassert).toBe(false);
		expect(d.flipEscape).toBe(false);
	});
});

describe("shouldEscapeOnScroll — 用户物理手势门禁与布局突变重吸底", () => {
	it("用户真实向上滚轮/手势（hasUserUpwardIntent=true）且 flipEscape=true → 准许逃逸，不吸底", () => {
		const res = shouldEscapeOnScroll({
			decisionFlipEscape: true,
			hasUserUpwardIntent: true,
			stuck: true,
			escaped: false,
		});
		expect(res.shouldEscape).toBe(true);
		expect(res.shouldReassert).toBe(false);
	});

	it("长输出工具/正文流式排版导致负向抖动但无用户手势（hasUserUpwardIntent=false）且处于吸底态 → 拒绝逃逸，强制重新吸底", () => {
		const res = shouldEscapeOnScroll({
			decisionFlipEscape: true,
			hasUserUpwardIntent: false,
			stuck: true,
			escaped: false,
		});
		expect(res.shouldEscape).toBe(false);
		expect(res.shouldReassert).toBe(true);
	});

	it("用户已处于逃逸状态（escaped=true）时发生布局突变 → 不逃逸，也不强行拉回底部（不打扰用户看历史）", () => {
		const res = shouldEscapeOnScroll({
			decisionFlipEscape: true,
			hasUserUpwardIntent: false,
			stuck: false,
			escaped: true,
		});
		expect(res.shouldEscape).toBe(false);
		expect(res.shouldReassert).toBe(false);
	});

	it("decisionFlipEscape=false → 既不逃逸也不再吸底", () => {
		const res = shouldEscapeOnScroll({
			decisionFlipEscape: false,
			hasUserUpwardIntent: false,
			stuck: true,
			escaped: false,
		});
		expect(res.shouldEscape).toBe(false);
		expect(res.shouldReassert).toBe(false);
	});
});

describe("shouldScrollToBottomOnStreamChange — 流式启闭对吸底与逃逸保护的决策", () => {
	it("流式从未启动到启动（wasStreaming=false, isStreaming=true），用户未逃逸 → 允许吸底跟随", () => {
		expect(
			shouldScrollToBottomOnStreamChange({
				wasStreaming: false,
				isStreaming: true,
				escaped: false,
				hasJumpTarget: false,
			}),
		).toBe(true);
	});

	it("[核心防护] 流式从停止到启动（例如工具调用完毕下一轮，或刷新后流式连接），用户已逃逸向上翻阅 → 坚决拒绝吸底，保护阅读视口", () => {
		expect(
			shouldScrollToBottomOnStreamChange({
				wasStreaming: false,
				isStreaming: true,
				escaped: true,
				hasJumpTarget: false,
			}),
		).toBe(false);
	});

	it("流式持续中（wasStreaming=true, isStreaming=true） → 不触发额外的 scrollToBottom", () => {
		expect(
			shouldScrollToBottomOnStreamChange({
				wasStreaming: true,
				isStreaming: true,
				escaped: false,
				hasJumpTarget: false,
			}),
		).toBe(false);
	});

	it("存在跳转目标（hasJumpTarget=true） → 任何情况下都不因流式启闭强行吸底", () => {
		expect(
			shouldScrollToBottomOnStreamChange({
				wasStreaming: false,
				isStreaming: true,
				escaped: false,
				hasJumpTarget: true,
			}),
		).toBe(false);
	});
});

describe("classifyQuestionAddedScroll — 提问到达与首次载入吸底决策", () => {
	it("切换会话（convChanged=true） → 无条件吸底对齐", () => {
		const res = classifyQuestionAddedScroll({
			convChanged: true,
			lastQuestionId: "q-1",
			prevLastQuestionId: "q-0",
			escaped: true,
			hasJumpTarget: false,
		});
		expect(res.shouldScroll).toBe(true);
		expect(res.reason).toBe("conv_changed");
	});

	it("用户在当前会话发送新提问且视口未逃逸 → 恢复吸底跟随", () => {
		const res = classifyQuestionAddedScroll({
			convChanged: false,
			lastQuestionId: "q-2",
			prevLastQuestionId: "q-1",
			escaped: false,
			nearBottom: true,
			hasJumpTarget: false,
		});
		expect(res.shouldScroll).toBe(true);
		expect(res.reason).toBe("question_added");
	});

	it("[核心防护] 会话完整数据后置加载到位导致提问ID变更，用户已在部分消息阶段向上滚动逃逸 → 坚决不拉回底部", () => {
		const res = classifyQuestionAddedScroll({
			convChanged: false,
			lastQuestionId: "q-2",
			prevLastQuestionId: "q-1",
			escaped: true,
			nearBottom: false,
			hasJumpTarget: false,
		});
		expect(res.shouldScroll).toBe(false);
		expect(res.reason).toBe("question_added");
	});

	it("[核心防护] 页面刷新后首批提问后置到达（prevLastQuestionId === null），用户已向上逃逸 → 坚决不拉回底部", () => {
		const res = classifyQuestionAddedScroll({
			convChanged: false,
			lastQuestionId: "q-1",
			prevLastQuestionId: null,
			escaped: true,
			hasJumpTarget: false,
		});
		expect(res.shouldScroll).toBe(false);
		expect(res.reason).toBe("initial_load");
	});

	it("页面刷新后首批提问后置到达（prevLastQuestionId === null），用户未逃逸 → 正常对齐底部", () => {
		const res = classifyQuestionAddedScroll({
			convChanged: false,
			lastQuestionId: "q-1",
			prevLastQuestionId: null,
			escaped: false,
			hasJumpTarget: false,
		});
		expect(res.shouldScroll).toBe(true);
		expect(res.reason).toBe("initial_load");
	});

	it("提问未变动（lastQuestionId === prevLastQuestionId） → 不触发吸底", () => {
		const res = classifyQuestionAddedScroll({
			convChanged: false,
			lastQuestionId: "q-1",
			prevLastQuestionId: "q-1",
			escaped: false,
			hasJumpTarget: false,
		});
		expect(res.shouldScroll).toBe(false);
		expect(res.reason).toBe("none");
	});
});

describe("shouldPreloadEarlier — 动态水位线预加载决策", () => {
	const defaultParams = {
		scrollTop: 1000,
		scrollHeight: 4000,
		clientHeight: 800,
		hasEarlier: true,
		isMovingUp: true,
	};

	it("用户向上滚动，视口离开底部进入倒数第二页（scrollTop <= 2屏/50%水位线）且有更早历史 → 提前触发后台拉取", () => {
		// threshold = max(800 * 2 = 1600, 4000 * 0.5 = 2000, 800) = 2000px
		// scrollTop 1000 <= 2000, 且 isMovingUp = true
		expect(shouldPreloadEarlier(defaultParams)).toBe(true);
	});

	it("用户仍在底部第一页区域（scrollTop 远大于预警水位线） → 不提前触发翻页", () => {
		// scrollTop 3000 > threshold 2000
		expect(shouldPreloadEarlier({ ...defaultParams, scrollTop: 3000 })).toBe(false);
	});

	it("已经没有更早历史（hasEarlier=false） → 绝不触发翻页", () => {
		expect(shouldPreloadEarlier({ ...defaultParams, hasEarlier: false })).toBe(false);
	});

	it("用户静止不动未向上操作（isMovingUp=false） → 不无端触发翻页（避免停驻阅读时过度请求）", () => {
		expect(shouldPreloadEarlier({ ...defaultParams, isMovingUp: false })).toBe(false);
	});
});
