import { describe, expect, it } from "vitest";
import { conversationRowKind, withConversationRow } from "../../server/conversation-rows.js";
import type { ConversationSummary } from "../../server/protocol.js";

/**
 * 左栏行归属单源守卫。
 *
 * 侧栏同时收到 `conversations` 与 `sessions` 两个通道，同一批会话常都在里面。
 * 由哪边出行必须由引擎裁定（`ConversationSummary.rowKind`），客户端不再按字段猜；
 * 猜错 = 同一条会话渲染两行（见 left-panel-universal-dedupe.test.ts 的反向用例）。
 */

describe("conversationRowKind", () => {
	it("运行中 / 等回答 / 排队中的对话自占一行", () => {
		expect(conversationRowKind({ isStreaming: true, hasHistoryRow: true })).toBe("open");
		expect(conversationRowKind({ completionPending: true, hasHistoryRow: true })).toBe("open");
		expect(conversationRowKind({ hasQuestion: true, hasHistoryRow: true })).toBe("open");
	});

	it("子代理与子代理父节点自占一行（要画树）", () => {
		expect(conversationRowKind({ isSubagent: true, hasHistoryRow: true })).toBe("open");
		expect(conversationRowKind({ parentId: "p1", hasHistoryRow: true })).toBe("open");
		expect(conversationRowKind({ forceOpen: true, hasHistoryRow: true })).toBe("open");
	});

	it("固定 / 临时 / 原生 CLI 自占一行", () => {
		expect(conversationRowKind({ pinned: true, hasHistoryRow: true })).toBe("open");
		expect(conversationRowKind({ isEphemeral: true, hasHistoryRow: true })).toBe("open");
		expect(conversationRowKind({ nativeCli: { config: { preset: "claude" } }, hasHistoryRow: true })).toBe("open");
	});

	it("已落盘的静态对话交给历史行", () => {
		expect(conversationRowKind({ hasHistoryRow: true })).toBe("history");
	});

	it("未落盘（没有历史行可代表）的对话必须自己出行，否则会凭空消失", () => {
		expect(conversationRowKind({ hasHistoryRow: false })).toBe("open");
		expect(conversationRowKind({})).toBe("open");
	});
});

describe("withConversationRow", () => {
	it("不覆写引擎已经给出的行归属", () => {
		const summary = { id: "c1", title: "t", cwd: "/w", messageCount: 1, isStreaming: false, isSubagent: false };
		const explicit = withConversationRow({ ...summary, rowKind: "history" } as ConversationSummary, {
			isStreaming: true,
		});
		expect(explicit.rowKind).toBe("history");
		const derived = withConversationRow(summary as ConversationSummary, { isStreaming: true });
		expect(derived.rowKind).toBe("open");
	});
});
