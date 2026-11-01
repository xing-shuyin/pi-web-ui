import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { messageDeletionTargets } from "../../server/message-deletion.js";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";

function fixture(manager = SessionManager.inMemory()) {
	const user = manager.appendMessage({ role: "user", content: "question", timestamp: 1 });
	const assistant = manager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "call1", name: "read", arguments: {} }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		stopReason: "toolUse",
		timestamp: 2,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	const result = manager.appendMessage({
		role: "toolResult",
		toolCallId: "call1",
		toolName: "read",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 3,
	});
	manager.appendMessage({ role: "user", content: "later question", timestamp: 4 });
	return { manager, user, assistant, result };
}

describe("message deletion", () => {
	it("removes assistant tool calls and their results while retaining later messages after reopening", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-delete-"));
		try {
			const { manager, assistant, result } = fixture(SessionManager.create(dir, dir));
			const targets = messageDeletionTargets(manager.buildContextEntries(), assistant);
			expect(targets).toEqual([assistant, result]);
			for (const id of targets) manager.appendContextEdit(id, null);
			const reopened = SessionManager.open(manager.getSessionFile()!);
			expect(reopened.buildSessionContext().messages.map((message) => message.role)).toEqual(["user", "user"]);
			expect(() => messageDeletionTargets(reopened.buildContextEntries(), assistant)).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("deletes only the selected user and its leading attachment asides", () => {
		const manager = SessionManager.inMemory();
		const attachment = manager.appendCustomMessageEntry("file", "attachment", true);
		const { user } = fixture(manager);
		expect(messageDeletionTargets(manager.buildContextEntries(), user)).toEqual([user, attachment]);
	});

	it("publishes persisted deletion and clears user ID counters", async () => {
		const { manager, user } = fixture();
		const target = {
			session: {
				sessionManager: manager,
				isStreaming: false,
				agent: { state: { messages: manager.buildSessionContext().messages } },
			},
			uiMessageCache: new Map([["old", {}]]),
			userSeqByTs: new Map([[1, 3]]),
			lastMessagesSig: "old",
			lastMessagesArray: [{}],
		};
		const cs = fakeClientSession() as any;
		Object.defineProperty(cs, "conv", { value: target });
		cs.quiesceBlocked = () => false;
		cs.resolveMessageEntry = () => manager.getEntry(user);
		cs.invalidateSessionInfos = vi.fn();
		cs.scheduleSessionsRefresh = vi.fn();
		cs.flushSnapshot = vi.fn();
		cs.emit = vi.fn();
		await cs.deleteMessage("selected");
		expect(cs.emit).not.toHaveBeenCalled();
		expect(target.session.agent.state.messages.map((message) => message.role)).toEqual([
			"assistant",
			"toolResult",
			"user",
		]);
		expect(target.userSeqByTs.size).toBe(0);
		expect(target.uiMessageCache.size).toBe(0);
		expect(cs.flushSnapshot).toHaveBeenCalled();
	});

	it("rejects inactive branch entries", () => {
		const { manager, assistant, user } = fixture();
		manager.branch(user);
		expect(() => messageDeletionTargets(manager.buildContextEntries(), assistant)).toThrow();
	});

	it("rejects deletion during generation and does not fall back from an unknown conversation", async () => {
		const cs = fakeClientSession() as any;
		cs.quiesceBlocked = () => false;
		cs.emit = vi.fn();
		cs.flushSnapshot = vi.fn();
		cs.convs = new Map();
		Object.defineProperty(cs, "conv", { value: { session: { isStreaming: true } } });
		cs.resolveMessageEntry = vi.fn();
		await cs.deleteMessage("id");
		await cs.deleteMessage("id", "missing");
		expect(cs.resolveMessageEntry).not.toHaveBeenCalled();
		expect(cs.emit).toHaveBeenCalledTimes(2);
	});
});
