import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BaseAgentDriver } from "../../server/universal/driver-base.js";
import type { AgentCapabilities, AgentEventSink } from "../../server/universal/driver-base.js";
import { UniversalSession } from "../../server/universal/universal-session.js";
import { UniversalSessionStore } from "../../server/universal/session-store.js";
import type { ServerMessage } from "../../server/protocol.js";

class FakeDriver extends BaseAgentDriver {
	constructor(cwd: string) {
		super(cwd);
	}
	readonly id = "claude-code";
	readonly name = "Fake Claude";
	readonly capabilities: AgentCapabilities = {
		supportsTreeFork: false,
		supportsHistoryEdit: false,
		supportsToolPromptOverride: false,
		supportsModelSwitch: true,
		supportsThinkingLevels: true,
		supportsAskUser: false,
	};
	async createSession(): Promise<string> {
		return "fake-session";
	}
	async resumeSession(_sessionId: string): Promise<void> {}
	async sendPrompt(_prompt: string, _attachments: undefined, sink: AgentEventSink): Promise<void> {
		sink.onTurnComplete({});
	}
	async abort(): Promise<void> {}
	dispose(): void {}
}

let cwd = "";
let dataDir = "";

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "subagent-record-cwd-"));
	dataDir = mkdtempSync(join(tmpdir(), "subagent-record-data-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	rmSync(dataDir, { recursive: true, force: true });
});

function makeSession(sent: ServerMessage[]) {
	return new UniversalSession({
		clientId: "test-client",
		cwd,
		dataDir,
		send: (msg: ServerMessage) => sent.push(msg),
		store: new UniversalSessionStore(dataDir, "claude"),
		driver: new FakeDriver(cwd),
		lang: "zh",
	});
}

describe("/subagent dispatch", () => {
	it("records the dispatch instruction in the parent conversation", async () => {
		const sent: ServerMessage[] = [];
		const session = makeSession(sent);
		const instruction = "/subagent 统计 /tmp 下有多少 txt 文件";

		await session.prompt(instruction);
		await new Promise((resolve) => setTimeout(resolve, 200));

		const conv = new UniversalSessionStore(dataDir, "claude").loadConversation(cwd, session.activeConversationId());
		const userTexts = (conv?.messages ?? [])
			.filter((m) => m.role === "user")
			.map((m) => {
				const first = m.content?.[0];
				return first && "text" in first ? String(first.text ?? "") : "";
			});
		expect(userTexts.some((t) => t.includes("/subagent 统计"))).toBe(true);
	});

	it("does not record anything when the subagent prompt is empty", async () => {
		const sent: ServerMessage[] = [];
		const session = makeSession(sent);

		await session.prompt("/subagent");
		await new Promise((resolve) => setTimeout(resolve, 100));

		const conv = new UniversalSessionStore(dataDir, "claude").loadConversation(cwd, session.activeConversationId());
		expect((conv?.messages ?? []).filter((m) => m.role === "user")).toHaveLength(0);
	});
});
