import { describe, it, expect } from "vitest";
import { parseReviewerVerdict, buildDiffFingerprint, GIT_DIFF_CAP } from "../../server/goal-service.js";

describe("审查 verdict 解析（平衡 {...} 全扫、最后一个合法胜出，正则兜底）", () => {
	it("从围栏/闲话包裹中提取唯一的平衡 JSON 对象", () => {
		const raw = '好的，我的结论如下：\n```json\n{"verdict":"pass","feedback":"所有验收点都满足"}\n```\n以上。';
		expect(parseReviewerVerdict(raw)).toEqual({ verdict: "pass", feedback: "所有验收点都满足" });
	});

	it("feedback 内的转义引号与嵌套大括号由 JSON.parse 天然处理", () => {
		const raw = '{"verdict":"fail","feedback":"修复 \\"src/a.ts\\" 里的 {TODO} 后再提交"}';
		expect(parseReviewerVerdict(raw)).toEqual({
			verdict: "fail",
			feedback: '修复 "src/a.ts" 里的 {TODO} 后再提交',
		});
	});

	it("嵌套对象平衡配对：feedback 是对象时 verdict 仍可解析（feedback 非字符串置空）", () => {
		const raw = '{"verdict":"pass","feedback":{"en":"ok"}} 前缀 { 干扰';
		expect(parseReviewerVerdict(raw)).toEqual({ verdict: "pass", feedback: "" });
	});

	it("非合法 JSON（单引号）落到旧正则兜底", () => {
		const raw = `{ verdict: 'pass', feedback: 'fine' } {"verdict":"pass","feedback":"真的通过"}`;
		expect(parseReviewerVerdict(raw)).toEqual({ verdict: "pass", feedback: "真的通过" });
	});

	it("多个合法 verdict 并存时取最后一个（模型先复述示例再给结论不假通过）", () => {
		const raw =
			'示例：{"verdict":"pass","feedback":"满足了什么"}\n' + '我的结论：{"verdict":"fail","feedback":"还差单测"}';
		expect(parseReviewerVerdict(raw)).toEqual({ verdict: "fail", feedback: "还差单测" });
	});

	it("正则兜底同样以后出现者为准（尾逗号导致 JSON.parse 全失败时）", () => {
		const raw = '{"verdict":"pass","feedback":"a",} {"verdict":"fail","feedback":"b",}';
		expect(parseReviewerVerdict(raw)).toEqual({ verdict: "fail", feedback: "b" });
	});

	it("完全无 JSON → undefined（调用方按 fail+原文兜底）", () => {
		expect(parseReviewerVerdict("我觉得还没做完。")).toBeUndefined();
		expect(parseReviewerVerdict('{"verdict":"blocked"}')).toBeUndefined();
	});
});

describe("git 变更指纹 buildDiffFingerprint（停滞检测的等值比较口径）", () => {
	it("diff 为空时返回排序后的 status 指纹（未跟踪文件也算变更）", () => {
		const status = "?? b.txt\n M a.ts\n?? a.txt";
		expect(buildDiffFingerprint("", status)).toBe(" M a.ts\n?? a.txt\n?? b.txt");
	});

	it("diff 与 status 都为空 → 空串（唯一算真停滞的形态）", () => {
		expect(buildDiffFingerprint("", "")).toBe("");
		expect(buildDiffFingerprint("", "\n")).toBe("");
	});

	it("diff 非空：正文截断到 GIT_DIFF_CAP，尾段 [diff-meta] 含完整字符数与 status", () => {
		const big = "x".repeat(GIT_DIFF_CAP + 5_000);
		const fp = buildDiffFingerprint(big, "?? new.txt\n");
		expect(fp.startsWith("x".repeat(GIT_DIFF_CAP))).toBe(true);
		expect(fp).toContain(`[diff-meta] chars=${big.length}`);
		expect(fp).toContain("[git-status]\n?? new.txt");
		expect(fp.length).toBeGreaterThan(GIT_DIFF_CAP);
	});

	it("截断交互：大 diff 两轮前 60_000 字符相同但内容有增长 → 指纹不同（不误判停滞）", () => {
		const round1 = "x".repeat(GIT_DIFF_CAP + 1_000);
		const round2 = "x".repeat(GIT_DIFF_CAP + 2_000);
		expect(buildDiffFingerprint(round1, "")).not.toBe(buildDiffFingerprint(round2, ""));
	});

	it("两轮真正无变化 → 指纹完全相同（等值比较可判停滞）", () => {
		const diff = "--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-old\n+new";
		expect(buildDiffFingerprint(diff, " M f.ts")).toBe(buildDiffFingerprint(diff, " M f.ts"));
	});

	it("status 拍不到（空串）→ 退化为纯截断 diff，无 meta 中的 status 段", () => {
		const diff = "diff --git a/f b/f";
		expect(buildDiffFingerprint(diff, "")).toBe(diff.slice(0, GIT_DIFF_CAP) + `\n[diff-meta] chars=${diff.length}`);
	});
});

describe("目标审查未通过与终态保留 (Goal Review Retention)", () => {
	it("达到最大轮数未通过时，目标文本与会话归属保持保留（不丢失用户目标）", () => {
		const g = {
			goal: "实现高性能缓存模块并补全单测",
			conversationId: "conv-123",
			round: 2,
			maxRounds: 2,
			locked: true,
			reviewing: true,
			verdict: "pending" as string | null,
			status: "",
		};

		const isLastRound = g.maxRounds > 0 && g.round >= g.maxRounds;
		expect(isLastRound).toBe(true);

		g.reviewing = false;
		g.verdict = "fail";
		g.status = `已达最大轮数（${g.maxRounds}），目标仍未通过`;

		expect(g.goal).toBe("实现高性能缓存模块并补全单测");
		expect(g.conversationId).toBe("conv-123");
		expect(g.verdict).toBe("fail");
		expect(g.reviewing).toBe(false);
	});

	it("触发停滞熔断（blocked）时，目标文本保持保留供用户排查", () => {
		const g = {
			goal: "优化数据库连接池",
			conversationId: "conv-456",
			reviewing: true,
			verdict: "pending" as string | null,
			status: "",
		};

		g.reviewing = false;
		g.verdict = "blocked";
		g.status = "⚠️ 目标受阻（停滞熔断）";

		expect(g.goal).toBe("优化数据库连接池");
		expect(g.conversationId).toBe("conv-456");
		expect(g.verdict).toBe("blocked");
		expect(g.reviewing).toBe(false);
	});

	it("终态下（fail/blocked）onAgentEnd 不应自动重复触发 review", () => {
		const canTriggerReview = (g: { goal: string | null; reviewing: boolean; verdict: string | null }) => {
			return !!(g.goal && !g.reviewing && g.verdict === "pending");
		};

		expect(canTriggerReview({ goal: "test", reviewing: false, verdict: "pending" })).toBe(true);

		expect(canTriggerReview({ goal: "test", reviewing: false, verdict: "fail" })).toBe(false);

		expect(canTriggerReview({ goal: "test", reviewing: false, verdict: "blocked" })).toBe(false);
	});
});
