import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function harness() {
	const directory = mkdtempSync(join(tmpdir(), "rename-conversation-"));
	directories.push(directory);
	const manager = SessionManager.create(directory, directory);
	const session = Object.assign(Object.create(AgentSession.prototype), {
		sessionManager: manager,
		_emit: vi.fn(),
		_extensionRunner: { emit: vi.fn(async () => {}) },
	}) as AgentSession;
	const conversation = { title: "Untitled", session };
	const context = {
		convs: new Map([["conversation", conversation]]),
		emitConversations: vi.fn(),
		invalidateSessionInfos: vi.fn(),
		refreshSessions: vi.fn(async () => {}),
		emit: vi.fn(),
	};
	return {
		manager,
		conversation,
		context,
		rename: (name: string) => ClientSession.prototype.renameConversation.call(context as any, "conversation", name),
	};
}

function appendUser(manager: SessionManager, text: string) {
	return manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
}

describe("ClientSession.renameConversation persistence", () => {
	it("keeps a name set before the first message when the transcript is created and reopened", async () => {
		const { manager, conversation, context, rename } = harness();
		const file = manager.getSessionFile()!;
		expect(existsSync(file)).toBe(false);

		await rename("  Named before first message  ");
		expect(conversation.title).toBe("Named before first message");
		expect(context.emit).not.toHaveBeenCalled();
		expect(context.emitConversations).toHaveBeenCalledOnce();
		expect(context.invalidateSessionInfos).toHaveBeenCalledOnce();
		expect(context.refreshSessions).toHaveBeenCalledOnce();
		expect(existsSync(file)).toBe(false);

		appendUser(manager, "First message must not replace the custom name");
		expect(existsSync(file)).toBe(true);
		const reopened = SessionManager.open(file);
		expect(reopened.getSessionName()).toBe("Named before first message");
		expect(manager.getSessionName()).toBe("Named before first message");
		expect(reopened.getBranch().filter((entry) => entry.type === "message")).toHaveLength(1);
	});

	it("keeps a live rename on the branch after later messages and a fork from the later leaf", async () => {
		const { manager, conversation, context, rename } = harness();
		appendUser(manager, "Existing message");
		const file = manager.getSessionFile()!;
		expect(existsSync(file)).toBe(true);

		await rename("Name retained by fork");
		expect(conversation.title).toBe("Name retained by fork");
		expect(context.emit).not.toHaveBeenCalled();
		expect(SessionManager.open(file).getSessionName()).toBe("Name retained by fork");

		const laterLeaf = appendUser(manager, "Message after renaming");
		const branchedFile = manager.createBranchedSession(laterLeaf)!;
		expect(branchedFile).not.toBe(file);
		const reopenedFork = SessionManager.open(branchedFile);
		expect(reopenedFork.getSessionName()).toBe("Name retained by fork");
		expect(reopenedFork.getBranch().filter((entry) => entry.type === "message")).toHaveLength(2);
		expect(reopenedFork.getLeafId()).toBe(laterLeaf);
		expect(SessionManager.open(file).getSessionName()).toBe("Name retained by fork");
	});
});
