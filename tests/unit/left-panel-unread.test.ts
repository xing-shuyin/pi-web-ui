import { describe, it, expect, beforeEach } from "vitest";
import {
	markConversationUnread,
	markConversationsUnread,
	clearConversationUnread,
	clearAllUnread,
	isConversationUnread,
	unreadStore,
} from "../../web/src/unread-conversations";

describe("LeftPanel unread & running states logic", () => {
	beforeEach(() => {
		clearAllUnread();
	});

	it("correctly identifies unread and running conversation status", () => {
		// 模拟后台对话 c-1 结束运行，标记为 unread
		markConversationUnread({
			id: "c-1",
			sessionId: "sid-1",
			sessionFile: "e:/project/sessions/s1.jsonl",
		});

		expect(isConversationUnread({ id: "c-1" })).toBe(true);
		expect(isConversationUnread({ sessionId: "sid-1" })).toBe(true);
		expect(isConversationUnread({ sessionFile: "e:/project/sessions/s1.jsonl" })).toBe(true);

		// 点击或切换到该对话后，未读状态消除
		clearConversationUnread("c-1");
		expect(isConversationUnread({ id: "c-1" })).toBe(false);
		expect(isConversationUnread({ sessionId: "sid-1" })).toBe(false);
	});

	it("computes project-level running and unread counts accurately", () => {
		// 模拟项目会话
		const pRunningRaw = [
			{ id: "c-active", isStreaming: true, completionPending: false },
			{ id: "c-pending", isStreaming: false, completionPending: true },
			{ id: "c-finished-unread", isStreaming: false, completionPending: false, sessionId: "sid-unread-1" },
			{ id: "c-idle", isStreaming: false, completionPending: false, sessionId: "sid-idle" },
		];

		const idleSessions = [
			{ path: "e:/proj/history1.jsonl", sessionId: "sid-h1" },
			{ path: "e:/proj/history2.jsonl", sessionId: "sid-h2" },
		];

		// 将 c-finished-unread 和 history2 标为未读
		markConversationsUnread([
			{ id: "c-finished-unread", sessionId: "sid-unread-1" },
			{ id: "h-2", sessionId: "sid-h2", path: "e:/proj/history2.jsonl" },
		]);

		const unreadKeys = unreadStore.getSnapshot();

		const checkUnread = (keys: { id?: string; sessionId?: string; sessionFile?: string; path?: string }) => {
			if (keys.id && unreadKeys.has(keys.id)) return true;
			if (keys.sessionId && unreadKeys.has(keys.sessionId)) return true;
			if (keys.sessionFile && unreadKeys.has(keys.sessionFile)) return true;
			if (keys.path && unreadKeys.has(keys.path)) return true;
			return false;
		};

		// 统计运行中
		const actuallyRunningCount = pRunningRaw.filter((c) => c.isStreaming || c.completionPending).length;
		expect(actuallyRunningCount).toBe(2);

		// 统计已完成未查看
		const unreadRunningCount = pRunningRaw.filter(
			(c) => !c.isStreaming && !c.completionPending && checkUnread({ id: c.id, sessionId: c.sessionId }),
		).length;
		const unreadHistoryCount = idleSessions.filter((s) => checkUnread({ sessionId: s.sessionId, path: s.path })).length;
		const unreadCount = unreadRunningCount + unreadHistoryCount;

		expect(unreadRunningCount).toBe(1);
		expect(unreadHistoryCount).toBe(1);
		expect(unreadCount).toBe(2);

		// 项目头样式标志
		const hasRunning = actuallyRunningCount > 0;
		const hasUnread = unreadCount > 0;
		expect(hasRunning).toBe(true);
		expect(hasUnread).toBe(true);
	});
});
