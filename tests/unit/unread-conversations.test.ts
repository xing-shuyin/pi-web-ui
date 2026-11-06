import { describe, it, expect, beforeEach } from "vitest";
import {
	markConversationUnread,
	markConversationsUnread,
	clearConversationUnread,
	clearAllUnread,
	isConversationUnread,
	unreadStore,
} from "../../web/src/unread-conversations";

describe("unread-conversations store", () => {
	beforeEach(() => {
		clearAllUnread();
	});

	it("marks conversation as unread and checks by id, sessionId, sessionFile, or path", () => {
		markConversationUnread({
			id: "c-123",
			sessionId: "sid-456",
			sessionFile: "/path/to/session.jsonl",
		});

		expect(isConversationUnread({ id: "c-123" })).toBe(true);
		expect(isConversationUnread({ sessionId: "sid-456" })).toBe(true);
		expect(isConversationUnread({ sessionFile: "/path/to/session.jsonl" })).toBe(true);
		expect(isConversationUnread({ id: "other" })).toBe(false);

		expect(isConversationUnread({ id: "C-123" })).toBe(true);
		expect(isConversationUnread({ sessionId: "SID-456" })).toBe(true);
	});

	it("clearing by id clears all associated keys", () => {
		markConversationUnread({
			id: "c-1",
			sessionId: "sid-1",
			sessionFile: "/sessions/s1.jsonl",
		});

		expect(isConversationUnread({ id: "c-1" })).toBe(true);
		expect(isConversationUnread({ sessionId: "sid-1" })).toBe(true);

		clearConversationUnread("c-1");

		expect(isConversationUnread({ id: "c-1" })).toBe(false);
		expect(isConversationUnread({ sessionId: "sid-1" })).toBe(false);
		expect(isConversationUnread({ sessionFile: "/sessions/s1.jsonl" })).toBe(false);
	});

	it("clearing by sessionId or file also clears primary id", () => {
		markConversationUnread({
			id: "c-2",
			sessionId: "sid-2",
			sessionFile: "/sessions/s2.jsonl",
		});

		expect(isConversationUnread({ id: "c-2" })).toBe(true);

		clearConversationUnread("sid-2");

		expect(isConversationUnread({ id: "c-2" })).toBe(false);
		expect(isConversationUnread({ sessionId: "sid-2" })).toBe(false);
	});

	it("batches marking multiple conversations", () => {
		markConversationsUnread([
			{ id: "c-a", sessionId: "sid-a" },
			{ id: "c-b", sessionId: "sid-b" },
		]);

		expect(isConversationUnread({ id: "c-a" })).toBe(true);
		expect(isConversationUnread({ id: "c-b" })).toBe(true);

		clearConversationUnread("c-a");
		expect(isConversationUnread({ id: "c-a" })).toBe(false);
		expect(isConversationUnread({ id: "c-b" })).toBe(true);

		clearAllUnread();
		expect(isConversationUnread({ id: "c-b" })).toBe(false);
	});
});
