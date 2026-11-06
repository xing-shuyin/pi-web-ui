import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ConversationOrder,
	conversationOrder,
	conversationOrderScope,
	recordUserPrompt,
} from "../../web/src/conversation-order";

const scope = conversationOrderScope("pi", "/project");
const ids = <T extends { id: string }>(items: T[]) => items.map((item) => item.id);
const identity = <T>(item: T) => item;

afterEach(() => {
	conversationOrder.clear();
	vi.restoreAllMocks();
});

describe("page conversation order", () => {
	it("freezes timestamps and tie order across background snapshots, then reloads current timestamps on a new page", () => {
		const order = new ConversationOrder();
		const initial = [
			{ id: "newer", modified: 200 },
			{ id: "older", modified: 100 },
			{ id: "tie", modified: 100 },
		];
		expect(ids(order.sort(scope, initial, identity))).toEqual(["newer", "older", "tie"]);
		const updated = [{ ...initial[2], modified: 900 }, { ...initial[1], modified: 500 }, initial[0]];
		expect(ids(order.sort(scope, updated, identity))).toEqual(["newer", "older", "tie"]);
		expect(ids(new ConversationOrder().sort(scope, updated, identity))).toEqual(["tie", "older", "newer"]);
	});

	it("only explicit user prompts move a known conversation above every other conversation", () => {
		const order = new ConversationOrder();
		const items = [
			{ id: "latest", modified: 300 },
			{ id: "middle", modified: 200 },
			{ id: "oldest", modified: 100 },
		];
		order.sort(scope, items, identity);
		order.promote(scope, items[2]);
		expect(ids(order.sort(scope, items, identity))).toEqual(["oldest", "latest", "middle"]);
		order.promote(scope, items[1]);
		expect(ids(order.sort(scope, items, identity))).toEqual(["middle", "oldest", "latest"]);
	});

	it("keeps the same position when history becomes active, a session is reopened, or ownership changes", () => {
		const order = new ConversationOrder();
		const recent = { id: "recent", modified: 200 };
		const history = { path: "E:/project/older.jsonl", sessionId: "older-session", modified: 100 };
		order.sort(scope, [recent, history], identity);
		const active = {
			id: "new-owner-id",
			sessionFile: "e:\\PROJECT\\older.jsonl",
			sessionId: "older-session",
			modified: 999,
		};
		expect(ids(order.sort(scope, [active, recent], identity))).toEqual(["recent", "new-owner-id"]);
		order.promote(scope, active);
		expect(order.sort(scope, [recent, history], identity)).toEqual([history, recent]);
	});

	it("does not merge different sessions when a server restart reuses a runtime conversation ID", () => {
		const order = new ConversationOrder();
		const previous = { id: "c1", sessionId: "previous-session", sessionFile: "/project/previous.jsonl", modified: 100 };
		const recent = { id: "c2", sessionId: "recent-session", modified: 200 };
		order.sort(scope, [recent, previous], identity);
		const previousKey = order.key(scope, previous);
		const replacement = {
			id: "c1",
			sessionId: "replacement-session",
			sessionFile: "/project/replacement.jsonl",
			modified: 9000,
		};
		const history = { sessionId: previous.sessionId, path: previous.sessionFile, modified: 8000 };
		const current = [replacement, recent, history];
		const sessions = () => order.sort(scope, current, identity).map((entry) => entry.sessionId);
		expect(sessions()).toEqual(["recent-session", "previous-session", "replacement-session"]);
		expect(order.key(scope, replacement)).not.toBe(previousKey);
		order.promote(scope, replacement);
		expect(sessions()).toEqual(["replacement-session", "recent-session", "previous-session"]);
	});

	it("does not lose a first-message promotion when a new conversation gains its session identity", () => {
		const order = new ConversationOrder();
		const recent = { id: "recent", modified: 200 };
		const pending = { id: "pending", modified: 50 };
		order.sort(scope, [recent, pending], identity);
		order.promote(scope, pending);
		const history = { path: "/project/new.jsonl", sessionId: "new-session", modified: 10 };
		order.sort(scope, [history], identity);
		const saved = { ...pending, sessionFile: history.path, sessionId: history.sessionId };
		order.sort(scope, [saved], identity);
		expect(order.sort(scope, [recent, history], identity)).toEqual([history, recent]);
	});

	it("a new subagent never promotes its parent; directly messaging a nested subagent promotes the complete tree", () => {
		const order = new ConversationOrder();
		const recent = { id: "recent", modified: 200 };
		const parent = { id: "parent", modified: 100 };
		order.sort(scope, [recent, parent], identity);
		const child = { id: "child", parentId: "parent", modified: 400 };
		const grandchild = { id: "grandchild", parentId: "child", modified: 500 };
		order.sort(scope, [grandchild, child, parent, recent], identity);
		expect(ids(order.sort(scope, [parent, recent], identity))).toEqual(["recent", "parent"]);
		order.promote(scope, grandchild);
		expect(ids(order.sort(scope, [parent, recent], identity))).toEqual(["parent", "recent"]);
	});

	it("isolates engines and projects while accepting equivalent Windows paths", () => {
		const order = new ConversationOrder();
		const items = [
			{ id: "recent", modified: 200 },
			{ id: "old", modified: 100 },
		];
		const windowsScope = conversationOrderScope("pi", "E:\\Project\\");
		order.sort(windowsScope, items, identity);
		order.promote(windowsScope, items[1]);
		expect(ids(order.sort(conversationOrderScope("pi", "e:/project"), items, identity))).toEqual(["old", "recent"]);
		for (const other of [conversationOrderScope("dsh", "e:/project"), conversationOrderScope("pi", "/elsewhere")]) {
			expect(ids(order.sort(other, items, identity))).toEqual(["recent", "old"]);
		}
	});

	it("records a direct child prompt in the root project even when the child runs in a worktree", () => {
		const recent = { id: "recent", cwd: "/project", modified: 200 };
		const parent = { id: "parent", cwd: "/project", modified: 100 };
		const child = { id: "child", parentId: "parent", cwd: "/worktree", modified: 300 };
		conversationOrder.sort(scope, [recent, parent, child], identity);
		recordUserPrompt({ engine: "pi", cwd: "/worktree", conversationId: "child" }, [child, parent, recent]);
		expect(ids(conversationOrder.sort(scope, [recent, parent], identity))).toEqual(["parent", "recent"]);
	});

	it("appends a newly discovered conversation until the user sends its first message", () => {
		const order = new ConversationOrder();
		const existing = { id: "existing", modified: 100 };
		order.sort(scope, [existing], identity);
		const newConversation = { id: "new", modified: 900 };
		expect(ids(order.sort(scope, [newConversation, existing], identity))).toEqual(["existing", "new"]);
		order.promote(scope, newConversation);
		expect(ids(order.sort(scope, [existing, newConversation], identity))).toEqual(["new", "existing"]);
	});

	it("uses the first live session response to replace cached timestamps during page initialization", () => {
		const order = new ConversationOrder();
		const cached = [
			{ id: "a", modified: 200 },
			{ id: "b", modified: 100 },
		];
		order.observe(scope, cached, false);
		expect(ids(order.sort(scope, cached, identity, false))).toEqual(["a", "b"]);
		const live = [
			{ id: "b", modified: 500 },
			{ id: "a", modified: 200 },
		];
		order.observe(scope, live);
		expect(ids(order.sort(scope, live, identity, false))).toEqual(["b", "a"]);
		expect(ids(order.sort(scope, [{ id: "a", modified: 900 }, live[0]], identity))).toEqual(["b", "a"]);
	});

	it("does not replay an old CLI submission after a newer conversation has been messaged", () => {
		const order = new ConversationOrder();
		const cli = { id: "cli", sessionId: "cli-session", modified: 100 };
		const chat = { id: "chat", modified: 200 };
		order.sort(scope, [cli, chat], identity);
		order.promote(scope, cli, "official-submit-1");
		order.promote(scope, chat);
		const version = order.getSnapshot();
		order.promote(scope, cli, "official-submit-1");
		expect(order.getSnapshot()).toBe(version);
		expect(ids(order.sort(scope, [cli, chat], identity))).toEqual(["chat", "cli"]);
	});

	it("notifies page subscribers after a user prompt", () => {
		const order = new ConversationOrder();
		const listener = vi.fn();
		const unsubscribe = order.subscribe(listener);
		order.sort(scope, [{ id: "a", modified: 100 }], identity);
		expect(listener).not.toHaveBeenCalled();
		order.promote(scope, { id: "a" });
		expect(listener).toHaveBeenCalledOnce();
		expect(order.getSnapshot()).toBe(1);
		unsubscribe();
		order.promote(scope, { id: "a" });
		expect(listener).toHaveBeenCalledOnce();
	});
});
