import { describe, expect, it } from "vitest";
import type { SnapshotConversationView, SnapshotEnvView } from "../../packages/keel/src/contracts/snapshot-view.js";
import { buildSnapshotState } from "../../packages/keel/src/domains/snapshots/index.js";
import { Conversation, type ConversationInit } from "../../packages/keel/src/kernel/conversation/index.js";
import type { UiApprovalCategory } from "../../packages/keel/src/protocol.js";

const SHELL: UiApprovalCategory = { id: "shell", label: "命令行", labelEn: "Shell" };
const WRITE: UiApprovalCategory = { id: "write", label: "写文件", labelEn: "Write" };

const ENV: SnapshotEnvView = {
	clientId: "c1",
	cwd: "/work",
	settingsVersion: 1,
	piConfigured: true,
	piAgentInstalled: true,
};

function conversation(id: string, overrides: Partial<ConversationInit> = {}): Conversation {
	return new Conversation({ id, clientId: "c1", cwd: "/work", kind: "user", createdAt: 1, ...overrides });
}

/** 主会话的 `viewOf` 会把聚合的 `approvalPolicyView()` 贴进视图；这里照抄那一步拼帧。 */
function viewOf(conv: Conversation): SnapshotConversationView {
	const approvalPolicy = conv.approvalPolicyView();
	return {
		conversationId: conv.id,
		sessionId: conv.id,
		messages: [],
		streamingMessage: null,
		isStreaming: false,
		model: null,
		thinkingLevel: "off",
		availableThinkingLevels: [],
		tools: [],
		steering: [],
		followUp: [],
		...(approvalPolicy ? { approvalPolicy } : {}),
	};
}

describe("审批策略归聚合根（Conversation）", () => {
	it("部分写入：allowAll 与 categories 各自合并，未给定的那一半不动", () => {
		const conv = conversation("conv-1");
		conv.approvalPolicy = { allowAll: false, categories: new Map([[SHELL.id, SHELL]]) };
		expect([...(conv.approvalPolicy?.categories.keys() ?? [])]).toEqual(["shell"]);

		conv.setApprovalPolicy({ allowAll: true });
		expect(conv.approvalPolicy?.allowAll).toBe(true);
		expect([...(conv.approvalPolicy?.categories.keys() ?? [])]).toEqual(["shell"]);

		conv.setApprovalPolicy({ categories: [] });
		expect(conv.approvalPolicy?.allowAll).toBe(true);
		expect(conv.approvalPolicy?.categories.size).toBe(0);
	});

	it("全量写入：读回来就是写入的策略（类别详情跟着走）", () => {
		const conv = conversation("conv-2");
		conv.approvalPolicy = {
			allowAll: true,
			categories: new Map([
				[SHELL.id, SHELL],
				[WRITE.id, WRITE],
			]),
		};
		conv.setApprovalPolicy({ allowAll: true, categories: ["shell", "write"] });

		const policy = conv.approvalPolicy;
		expect(policy?.allowAll).toBe(true);
		expect([...(policy?.categories.values() ?? [])]).toEqual([SHELL, WRITE]);
		expect(conv.approvalPolicyView()).toEqual({
			conversationId: "conv-2",
			allowAll: true,
			categories: [SHELL, WRITE],
		});
	});

	it("清空：空策略归一成 undefined（不占字段、投影也返回 undefined）", () => {
		const conv = conversation("conv-3");
		conv.approvalPolicy = { allowAll: false, categories: new Map([[SHELL.id, SHELL]]) };
		expect(conv.approvalPolicyView()?.categories).toEqual([SHELL]);

		conv.setApprovalPolicy({ allowAll: false, categories: [] });
		expect(conv.approvalPolicy).toBeUndefined();
		expect(conv.approvalPolicyView()).toBeUndefined();

		conv.setApprovalPolicy({ allowAll: true });
		expect(conv.approvalPolicy?.allowAll).toBe(true);
		conv.approvalPolicy = undefined;
		expect(conv.approvalPolicy).toBeUndefined();
		expect(conv.approvalPolicyView()).toBeUndefined();
	});

	it("两个对话互不影响（单所有者，不是全局字段）", () => {
		const a = conversation("conv-a");
		const b = conversation("conv-b");
		a.setApprovalPolicy({ allowAll: true, categories: [] });
		a.approvalPolicy?.categories.set(SHELL.id, SHELL);
		a.setApprovalPolicy({ categories: ["shell"] });

		expect(a.approvalPolicy?.allowAll).toBe(true);
		expect(b.approvalPolicy).toBeUndefined();
		expect(b.approvalPolicyView()).toBeUndefined();

		b.setApprovalPolicy({ allowAll: false, categories: [] });
		b.approvalPolicy = { allowAll: false, categories: new Map([[WRITE.id, WRITE]]) };
		expect(b.approvalPolicyView()?.categories).toEqual([WRITE]);
		expect(a.approvalPolicyView()?.categories).toEqual([SHELL]);
		expect(a.approvalPolicy?.allowAll).toBe(true);
	});
});

describe("审批策略快照投影", () => {
	it("有策略时投影成协议形状（设置帧的 approvalPolicy 就取它）", () => {
		const conv = conversation("conv-proj");
		conv.approvalPolicy = { allowAll: false, categories: new Map([[SHELL.id, SHELL]]) };

		expect(conv.approvalPolicyView()).toEqual({ conversationId: "conv-proj", allowAll: false, categories: [SHELL] });
	});

	it("快照帧不携带 approvalPolicy（协议 UiState 没这个键，它只属于 settings_state）", () => {
		const conv = conversation("conv-proj");
		conv.approvalPolicy = { allowAll: true, categories: new Map([[SHELL.id, SHELL]]) };
		const state = buildSnapshotState(7, ENV, viewOf(conv));
		expect("approvalPolicy" in state).toBe(false);
		expect(JSON.stringify(state)).not.toContain("approvalPolicy");

		const empty = buildSnapshotState(1, ENV, null);
		expect("approvalPolicy" in empty).toBe(false);
		expect(empty.conversationId).toBe("");
	});
});
