import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UniversalSession } from "../../server/universal/universal-session.js";
import { UniversalSessionStore } from "../../server/universal/session-store.js";
import { MockAgentDriver } from "../../server/universal/drivers/mock-driver.js";
import type { ServerMessage } from "../../server/protocol.js";

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
