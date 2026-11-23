import { describe, expect, it } from "vitest";
import {
	InteractionInbox,
	shouldAutoApprove,
	type InteractionKind,
	type InteractionOutcomes,
} from "../../server/core/domains/interactions/index.js";
import type { ApprovalRule } from "../../server/approval-rules.js";

interface SettledCall {
	kind: InteractionKind;
	id: string;
	result: unknown;
}

function makeInbox() {
	const settled: SettledCall[] = [];
	const inbox = new InteractionInbox((kind, id, result) => {
		settled.push({ kind, id, result: result as unknown });
	});
	return { inbox, settled };
}

const CANCEL_OUTCOMES: InteractionOutcomes = {
	approval: { decision: "deny", reason: "会话已关闭" },
	question: null,
	page: { ok: false, error: "会话已关闭" },
	phone: { ok: false, error: "会话已关闭" },
};

function registerAll(inbox: InteractionInbox, conversationId = "c1"): void {
	inbox.register({ kind: "approval", id: "appr-1", conversationId, createdAt: 10 });
	inbox.register({ kind: "question", id: "q-1", conversationId, createdAt: 11 });
	inbox.register({ kind: "page", id: "page-1", conversationId, createdAt: 12 });
	inbox.register({ kind: "phone", id: "ph-1", conversationId, createdAt: 13 });
}

function allowRule(over: Partial<ApprovalRule> = {}): ApprovalRule {
	return {
		id: "rule-git-status",
		enabled: true,
		tools: ["bash"],
		field: "command",
		match: "prefix",
		value: "git status",
		action: "allow",
		label: "git status",
		...over,
	};
}

describe("interactions/inbox · 四类登记", () => {
	it("四类各占一格：size 只数自己那类，total 数全部，createdAt 用传入值", () => {
		const { inbox } = makeInbox();
		registerAll(inbox);

		expect(inbox.size("approval")).toBe(1);
		expect(inbox.size("question")).toBe(1);
		expect(inbox.size("page")).toBe(1);
		expect(inbox.size("phone")).toBe(1);
		expect(inbox.total()).toBe(4);
		expect(inbox.size("approval") + inbox.size("question") + inbox.size("page") + inbox.size("phone")).toBe(
			inbox.total(),
		);
		expect(inbox.get("q-1")?.createdAt).toBe(11);
	});

	it("同一个 id 只接受一次登记：重复登记被拒且不动原记录（含跨 kind）", () => {
		const { inbox } = makeInbox();
		expect(
			inbox.register({ kind: "approval", id: "appr-1", conversationId: "c1", createdAt: 10, payload: "first" }),
		).toBe(true);
		expect(
			inbox.register({ kind: "approval", id: "appr-1", conversationId: "c2", createdAt: 20, payload: "second" }),
		).toBe(false);
		expect(inbox.register({ kind: "question", id: "appr-1", conversationId: "c1", createdAt: 30 })).toBe(false);

		expect(inbox.size("approval")).toBe(1);
		expect(inbox.size("question")).toBe(0);
		expect(inbox.get("appr-1")?.conversationId).toBe("c1");
		expect(inbox.get("appr-1")?.payload).toBe("first");
	});

	it("list 按登记顺序给出某一类，且返回值是副本（改它不影响内部状态）", () => {
		const { inbox } = makeInbox();
		inbox.register({ kind: "question", id: "q-2", conversationId: "c1", createdAt: 20 });
		inbox.register({ kind: "question", id: "q-1", conversationId: "c1", createdAt: 10 });
		inbox.register({ kind: "approval", id: "appr-1", conversationId: "c1", createdAt: 30 });

		const listed = inbox.list("question");
		expect(listed.map((entry) => entry.id)).toEqual(["q-2", "q-1"]);

		listed.pop();
		expect(inbox.list("question").map((entry) => entry.id)).toEqual(["q-2", "q-1"]);
	});
});

describe("interactions/inbox · 一次性结算", () => {
	it("结算触发一次回调并把条目摘掉", () => {
		const { inbox, settled } = makeInbox();
		inbox.register({ kind: "approval", id: "appr-1", conversationId: "c1", createdAt: 10 });

		expect(inbox.settle("approval", "appr-1", { decision: "approve" })).toBe(true);
		expect(settled).toEqual([{ kind: "approval", id: "appr-1", result: { decision: "approve" } }]);
		expect(inbox.has("appr-1")).toBe(false);
		expect(inbox.size("approval")).toBe(0);
		expect(inbox.total()).toBe(0);
	});

	it("重复结算返回 false 且不重复触发回调", () => {
		const { inbox, settled } = makeInbox();
		inbox.register({ kind: "question", id: "q-1", conversationId: "c1", createdAt: 10 });

		expect(inbox.settle("question", "q-1", [{ id: "a", selected: ["x"] }])).toBe(true);
		expect(inbox.settle("question", "q-1", [{ id: "a", selected: ["y"] }])).toBe(false);
		expect(inbox.settle("question", "q-1", null)).toBe(false);
		expect(settled).toHaveLength(1);
		expect(settled[0]?.result).toEqual([{ id: "a", selected: ["x"] }]);
	});

	it("kind 不匹配不误删：登记为审批的 id 用问卷结算返回 false，记录仍在", () => {
		const { inbox, settled } = makeInbox();
		inbox.register({ kind: "approval", id: "appr-1", conversationId: "c1", createdAt: 10 });

		expect(inbox.settle("question", "appr-1", null)).toBe(false);
		expect(inbox.has("appr-1")).toBe(true);
		expect(inbox.size("approval")).toBe(1);
		expect(settled).toEqual([]);
		expect(inbox.settle("approval", "appr-1", { decision: "deny" })).toBe(true);
	});

	it("未知 id 结算返回 false，不触发回调", () => {
		const { inbox, settled } = makeInbox();
		expect(inbox.settle("phone", "ph-missing", { ok: true, result: 1 })).toBe(false);
		expect(settled).toEqual([]);
	});

	it("回调抛错时状态已一致：错误上抛，条目已摘除，再结算返回 false", () => {
		let calls = 0;
		const inbox = new InteractionInbox(() => {
			calls++;
			throw new Error("sink 坏了");
		});
		inbox.register({ kind: "page", id: "page-1", conversationId: "c1", createdAt: 10 });

		expect(() => inbox.settle("page", "page-1", { ok: false, error: "超时" })).toThrow("sink 坏了");
		expect(calls).toBe(1);
		expect(inbox.settle("page", "page-1", { ok: false, error: "超时" })).toBe(false);
		expect(calls).toBe(1);
		expect(inbox.total()).toBe(0);
	});
});

describe("interactions/inbox · 按会话取消", () => {
	it("只结算该对话的条目，其它对话原封不动", () => {
		const { inbox, settled } = makeInbox();
		registerAll(inbox, "c1");
		inbox.register({ kind: "approval", id: "appr-2", conversationId: "c2", createdAt: 20 });
		inbox.register({ kind: "question", id: "q-2", conversationId: "c2", createdAt: 21 });

		expect(inbox.cancelConversation("c1", CANCEL_OUTCOMES)).toBe(4);
		expect(settled.map((call) => call.id)).toEqual(["appr-1", "q-1", "page-1", "ph-1"]);
		expect(settled[0]?.result).toEqual({ decision: "deny", reason: "会话已关闭" });
		expect(settled[1]?.result).toBeNull();
		expect(settled[2]?.result).toEqual({ ok: false, error: "会话已关闭" });
		expect(settled[3]?.kind).toBe("phone");

		expect(inbox.size("approval")).toBe(1);
		expect(inbox.size("question")).toBe(1);
		expect(inbox.list("approval")[0]?.conversationId).toBe("c2");
		expect(inbox.total()).toBe(2);
	});

	it("对没有挂起项的对话取消是空操作", () => {
		const { inbox, settled } = makeInbox();
		registerAll(inbox, "c1");
		expect(inbox.cancelConversation("c-other", CANCEL_OUTCOMES)).toBe(0);
		expect(settled).toEqual([]);
		expect(inbox.total()).toBe(4);
	});

	it("cancelAll 清空四类并各结算一次", () => {
		const { inbox, settled } = makeInbox();
		registerAll(inbox, "c1");
		inbox.register({ kind: "phone", id: "ph-2", conversationId: "c2", createdAt: 14 });

		expect(inbox.cancelAll(CANCEL_OUTCOMES)).toBe(5);
		expect(settled).toHaveLength(5);
		expect(inbox.total()).toBe(0);
		expect(inbox.settle("phone", "ph-2", { ok: true })).toBe(false);
	});
});

describe("interactions/inbox · drain", () => {
	it("drain 只摘除某一类，不触发结算回调，其它类保留", () => {
		const { inbox, settled } = makeInbox();
		registerAll(inbox, "c1");

		const drained = inbox.drain("page");
		expect(drained.map((entry) => entry.id)).toEqual(["page-1"]);
		expect(inbox.size("page")).toBe(0);
		expect(settled).toEqual([]);
		expect(inbox.total()).toBe(3);
		expect(inbox.size("approval")).toBe(1);
		expect(inbox.settle("page", "page-1", { ok: true })).toBe(false);
	});

	it("drain 之后同一个 id 可以重新登记", () => {
		const { inbox } = makeInbox();
		inbox.register({ kind: "phone", id: "ph-1", conversationId: "c1", createdAt: 10 });
		inbox.drain("phone");

		expect(inbox.register({ kind: "phone", id: "ph-1", conversationId: "c2", createdAt: 20 })).toBe(true);
		expect(inbox.get("ph-1")?.conversationId).toBe("c2");
	});
});

describe("interactions/policy · shouldAutoApprove", () => {
	it("allow 规则命中则自动放行", () => {
		expect(shouldAutoApprove({ rule: allowRule(), toolName: "bash", args: { command: "git status --short" } })).toBe(
			true,
		);
		expect(
			shouldAutoApprove({
				rule: allowRule({ id: "rule-docs", tools: ["write"], field: "path", match: "glob", value: "**/*.md" }),
				toolName: "write",
				args: { path: "docs/plan.md" },
			}),
		).toBe(true);
	});

	it("命令不匹配 / 工具不匹配则不自动放行", () => {
		expect(shouldAutoApprove({ rule: allowRule(), toolName: "bash", args: { command: "rm -rf /" } })).toBe(false);
		expect(shouldAutoApprove({ rule: allowRule(), toolName: "read", args: { command: "git status" } })).toBe(false);
	});

	it("deny / ask / 停用的规则一律不放行", () => {
		expect(
			shouldAutoApprove({ rule: allowRule({ action: "deny" }), toolName: "bash", args: { command: "git status" } }),
		).toBe(false);
		expect(
			shouldAutoApprove({ rule: allowRule({ action: "ask" }), toolName: "bash", args: { command: "git status" } }),
		).toBe(false);
		expect(
			shouldAutoApprove({ rule: allowRule({ enabled: false }), toolName: "bash", args: { command: "git status" } }),
		).toBe(false);
	});

	it("类目门槛：给了 category 就必须与规则类目一致（含 categoryId 缺省时用规则 id）", () => {
		const scoped = allowRule({ categoryId: "cat-git" });
		expect(shouldAutoApprove({ rule: scoped, toolName: "bash", args: { command: "git status" } })).toBe(true);
		expect(
			shouldAutoApprove({ rule: scoped, toolName: "bash", args: { command: "git status" }, category: "cat-git" }),
		).toBe(true);
		expect(
			shouldAutoApprove({ rule: scoped, toolName: "bash", args: { command: "git status" }, category: "cat-other" }),
		).toBe(false);

		const unscoped = allowRule();
		expect(
			shouldAutoApprove({
				rule: unscoped,
				toolName: "bash",
				args: { command: "git status" },
				category: unscoped.id,
			}),
		).toBe(true);
		expect(
			shouldAutoApprove({ rule: unscoped, toolName: "bash", args: { command: "git status" }, category: "cat-other" }),
		).toBe(false);
	});

	it("工作区外规则按 cwd / workspaceRoots 判定（匹配口径来自 approval-rules）", () => {
		const outside = allowRule({ id: "rule-outside", field: "path", match: "outside_workspace", value: "" });
		expect(shouldAutoApprove({ rule: outside, toolName: "bash", args: { path: "/work/a.txt" }, cwd: "/work" })).toBe(
			false,
		);
		expect(
			shouldAutoApprove({
				rule: outside,
				toolName: "bash",
				args: { path: "/etc/passwd" },
				cwd: "/work",
				workspaceRoots: ["/work/repo"],
			}),
		).toBe(true);
	});
});
