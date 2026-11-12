import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UniversalSession } from "../../server/universal/universal-session.js";
import { UniversalSessionStore } from "../../server/universal/session-store.js";
import { MockAgentDriver } from "../../server/universal/drivers/mock-driver.js";
import type { ServerMessage } from "../../server/protocol.js";
import { handleSessionLifecycleMessage } from "../../server/dispatch-domain-handlers.js";
import type { DispatchSession } from "../../server/index.js";

describe("universal engine session list identity", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-univ-list-"));
	});
	afterEach(() => {
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
		} catch {}
	});

	it.each(["claude", "codex"])(
		"answers other-project history requests without switching the active %s conversation",
		async (engine) => {
			const cwd = join(dir, "current");
			const archive = join(dir, "archive");
			mkdirSync(cwd);
			mkdirSync(archive);
			const store = new UniversalSessionStore(join(dir, "data"), engine);
			for (let i = 0; i < 25; i++)
				store.saveConversation(archive, {
					id: `archived-${i}`,
					title: `Archived ${i}`,
					createdAt: i,
					updatedAt: i,
					messages: [],
				});
			const sent: ServerMessage[] = [];
			const session = new UniversalSession({
				clientId: "history",
				cwd,
				dataDir: join(dir, "data"),
				agentDir: join(dir, "agent"),
				engine,
				send: (m) => sent.push(m),
				store,
				driver: new MockAgentDriver(cwd),
			});
			try {
				await session.prompt("current conversation");
				sent.length = 0;
				handleSessionLifecycleMessage(
					{ type: "list_sessions", path: archive, limit: 20 },
					session as unknown as DispatchSession,
				);
				const first = sent.find((m): m is Extract<ServerMessage, { type: "sessions" }> => m.type === "sessions")!;
				expect(first.cwd).toBe(archive);
				expect(first.sessions).toHaveLength(20);
				expect(first.hasMore).toBe(true);
				expect(first.sessions.every((row) => row.cwd === archive && row.sessionId?.startsWith("archived-"))).toBe(true);
				expect(sent.some((m) => m.type === "conversations")).toBe(false);
				expect(session.cwd).toBe(cwd);
				sent.length = 0;
				handleSessionLifecycleMessage(
					{ type: "list_sessions", path: archive, limit: 40 },
					session as unknown as DispatchSession,
				);
				expect(sent).toContainEqual(
					expect.objectContaining({ type: "sessions", cwd: archive, hasMore: false, sessions: expect.any(Array) }),
				);
				await session.pushSessionsForCwd(join(dir, "empty"));
				expect(sent).toContainEqual(
					expect.objectContaining({ type: "sessions", cwd: join(dir, "empty"), sessions: [] }),
				);
			} finally {
				session.dispose();
			}
		},
	);

	it("tags open conversations with their history id and history rows with their project", async () => {
		const cwd = join(dir, "ws");
		mkdirSync(cwd);
		const sent: ServerMessage[] = [];
		const session = new UniversalSession({
			clientId: "list-client",
			cwd,
			agentDir: join(dir, "agent"),
			send: (m) => sent.push(m),
			store: new UniversalSessionStore(join(dir, "data")),
			driver: new MockAgentDriver(cwd),
		});
		await session.prompt("你好");
		sent.length = 0;
		await session.refreshSessions();

		const convs = sent.find((m): m is Extract<ServerMessage, { type: "conversations" }> => m.type === "conversations");
		const sessions = sent.find((m): m is Extract<ServerMessage, { type: "sessions" }> => m.type === "sessions");
		expect(convs && sessions).toBeTruthy();
		expect(sessions!.cwd).toBe(cwd);
		const row = sessions!.sessions[0];
		expect(row.cwd).toBe(cwd);
		const open = convs!.conversations.find((c) => c.id === row.sessionId);
		expect(open?.sessionId).toBe(row.sessionId);
		session.dispose();
	});
});
