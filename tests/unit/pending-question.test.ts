/**
 * pending-question.ts 单测：快照恢复待答问卷面板的去留判定。
 *
 * 重点覆盖三类边界（都会表现为「对话框乱弹/乱消」）：
 *  - 在途旧快照把用户刚答过的问卷重新弹出来；
 *  - 切到其他会话时未收起前一会话的面板；
 *  - 一张回答之前生成的旧快照把同一会话刚由即时通道弹出的面板闪掉。
 */
import { describe, expect, it } from "vitest";
import { resolvePendingQuestion } from "../../web/src/pending-question.js";

const q = (id: string) => ({ id, questions: [{ id: "a", question: "?" }] });
const none = new Set<string>();

describe("resolvePendingQuestion", () => {
	it("快照有待答问卷 + 面板为空 → 恢复（来源标记 snapshot）", () => {
		const d = resolvePendingQuestion({ current: null, source: "live", snapshot: q("q-1"), answered: none });
		expect(d.changed).toBe(true);
		expect(d.question?.id).toBe("q-1");
		expect(d.source).toBe("snapshot");
	});

	it("已经在展示同一张 → 不动（60ms 一次的快照不该反复重渲）", () => {
		const d = resolvePendingQuestion({
			current: q("q-1"),
			source: "snapshot",
			snapshot: q("q-1"),
			answered: none,
		});
		expect(d.changed).toBe(false);
		expect(d.question?.id).toBe("q-1");
	});

	it("快照换成另一张问卷 → 换成新的那张", () => {
		const d = resolvePendingQuestion({
			current: q("q-1"),
			source: "live",
			snapshot: q("q-2"),
			answered: none,
		});
		expect(d.changed).toBe(true);
		expect(d.question?.id).toBe("q-2");
	});

	it("已答过的问卷即使在途快照还带着 → 不重新弹出", () => {
		const d = resolvePendingQuestion({
			current: null,
			source: "live",
			snapshot: q("q-1"),
			answered: new Set(["q-1"]),
		});
		expect(d.changed).toBe(false);
		expect(d.question).toBeNull();
	});

	it("live 面板不受「快照没有问卷」影响（避免在途旧快照把刚弹出的面板闪掉）", () => {
		const d = resolvePendingQuestion({
			current: q("q-1"),
			source: "live",
			snapshot: null,
			answered: none,
		});
		expect(d.changed).toBe(false);
		expect(d.question?.id).toBe("q-1");
	});

	it("snapshot 恢复出来的面板可被快照收起（另一标签页答完/切换对话/超时取消）", () => {
		const d = resolvePendingQuestion({
			current: q("q-1"),
			source: "snapshot",
			snapshot: null,
			answered: none,
		});
		expect(d.changed).toBe(true);
		expect(d.question).toBeNull();
		// 收起后来源回到 live：下次同一会话即时通道弹出的面板仍受规则 3 保护。
		expect(d.source).toBe("live");
	});

	it("快照缺字段（旧服务端 / undefined）等价于没有问卷", () => {
		const d = resolvePendingQuestion({
			current: q("q-1"),
			source: "snapshot",
			snapshot: undefined,
			answered: none,
		});
		expect(d).toEqual({ changed: true, question: null, source: "live" });
	});

	it("没面板 + 没问卷 → 不动", () => {
		const d = resolvePendingQuestion({ current: null, source: "live", snapshot: null, answered: none });
		expect(d).toEqual({ changed: false, question: null, source: "live" });
	});

	it("deadline 原样透传（DSH 引擎的倒计时靠它）", () => {
		const d = resolvePendingQuestion({
			current: null,
			source: "live",
			snapshot: { id: "q-9", questions: [], deadline: 12345 },
			answered: none,
		});
		expect(d.question?.deadline).toBe(12345);
	});

	it("切到其他会话时，无论 live 还是 snapshot 来源的面板都立即收起", () => {
		const dLive = resolvePendingQuestion({
			current: { ...q("q-1"), conversationId: "conv-1" },
			source: "live",
			snapshot: null,
			answered: none,
			activeConversationId: "conv-2",
		});
		expect(dLive.changed).toBe(true);
		expect(dLive.question).toBeNull();

		const dSnap = resolvePendingQuestion({
			current: { ...q("q-1"), conversationId: "conv-1" },
			source: "snapshot",
			snapshot: null,
			answered: none,
			activeConversationId: "conv-2",
		});
		expect(dSnap.changed).toBe(true);
		expect(dSnap.question).toBeNull();
	});

	it("同一会话内在途旧快照不闪掉 live 来源面板", () => {
		const d = resolvePendingQuestion({
			current: { ...q("q-1"), conversationId: "conv-1" },
			source: "live",
			snapshot: null,
			answered: none,
			activeConversationId: "conv-1",
		});
		expect(d.changed).toBe(false);
		expect(d.question?.id).toBe("q-1");
	});

	it("切回原会话后由快照恢复面板", () => {
		const d = resolvePendingQuestion({
			current: null,
			source: "live",
			snapshot: { ...q("q-1"), conversationId: "conv-1" },
			answered: none,
			activeConversationId: "conv-1",
		});
		expect(d.changed).toBe(true);
		expect(d.question?.id).toBe("q-1");
		expect(d.source).toBe("snapshot");
	});

	it("未指定会话的全局问卷切换会话时不收起", () => {
		const d = resolvePendingQuestion({
			current: q("q-1"),
			source: "live",
			snapshot: null,
			answered: none,
			activeConversationId: "conv-2",
		});
		expect(d.changed).toBe(false);
		expect(d.question?.id).toBe("q-1");
	});

	it("切到同样有待答问卷的会话时直接替换面板（规则 1 优先于规则 2）", () => {
		const d = resolvePendingQuestion({
			current: { ...q("q-1"), conversationId: "conv-1" },
			source: "live",
			snapshot: { ...q("q-2"), conversationId: "conv-2" },
			answered: none,
			activeConversationId: "conv-2",
		});
		expect(d.changed).toBe(true);
		expect(d.question?.id).toBe("q-2");
		expect(d.source).toBe("snapshot");
	});

	it("异会话在途快照的待答问卷绝不恢复到当前会话（防串台）", () => {
		// 当前在 conv-2，收到了 conv-1 晚到的快照
		const d = resolvePendingQuestion({
			current: null,
			source: "live",
			snapshot: { ...q("q-1"), conversationId: "conv-1" },
			answered: none,
			activeConversationId: "conv-2",
		});
		expect(d.changed).toBe(false);
		expect(d.question).toBeNull();
	});

	it("当前面板属于 conv-1，切到 conv-2 且收到 conv-1 的在途快照时仍立即收起面板", () => {
		const d = resolvePendingQuestion({
			current: { ...q("q-1"), conversationId: "conv-1" },
			source: "snapshot",
			snapshot: { ...q("q-1"), conversationId: "conv-1" },
			answered: none,
			activeConversationId: "conv-2",
		});
		expect(d.changed).toBe(true);
		expect(d.question).toBeNull();
	});
});
