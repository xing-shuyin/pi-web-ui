import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshClientSession } from "../../server/dsh/dsh-agent-service.js";
import { ClientStateStore } from "../../server/client-state.js";
import type { PluginRunEvent } from "../../server/plugins.js";

const roots: string[] = [];
const sessions: DshClientSession[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("DSH 插件运行事件桥", () => {
	it("直播帧与持久化回合都产出首包事件，结束后不重复计数", async () => {
		const root = mkdtempSync(join(tmpdir(), "dsh-plugin-events-"));
		roots.push(root);
		const dataDir = join(root, "data");
		const agentDir = join(root, "agent");
		mkdirSync(dataDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const stateStore = new ClientStateStore(join(dataDir, "client-state.json"));
		const session: any = DshClientSession.create("dsh-plugin-events", root, stateStore, dataDir, agentDir);
		sessions.push(session);
		const events: PluginRunEvent[] = [];
		session.onRunEvent = (event: PluginRunEvent) => events.push(event);
		const conv = (session as any).conv;
		conv.isStreaming = true;
		conv.turnTiming = { startedAt: 1000 };

		session.handleAssistantStream({
			sessionId: conv.sessionId,
			frame: { type: "start", time: 1000, turn: 0 },
		});
		session.handleAssistantStream({
			sessionId: conv.sessionId,
			frame: { type: "chunk", time: 1400, turn: 0, chunk: { type: "reasoning-delta", index: 0, text: "think" } },
		});
		session.handleAssistantStream({
			sessionId: conv.sessionId,
			frame: { type: "chunk", time: 1500, turn: 0, chunk: { type: "text-delta", index: 1, text: "answer" } },
		});
		session.handleSessionEvent({
			sessionId: conv.sessionId,
			event: { type: "turn/end", seq: 1, time: 2000, data: { reason: { kind: "completed" } } },
		});

		expect(events.filter((event) => event.type === "turn_first_token")).toEqual([
			expect.objectContaining({ conversationId: conv.id, at: 1400, durationMs: 400 }),
		]);

		conv.liveChunks = false;
		session.handleSessionEvent({
			sessionId: conv.sessionId,
			event: {
				type: "assistant/chunk",
				seq: 2,
				time: 2700,
				data: { turn: 1, chunk: { type: "text-delta", index: 0, text: "next" } },
			},
		});
		session.handleSessionEvent({
			sessionId: conv.sessionId,
			event: { type: "turn/end", seq: 3, time: 3000, data: { reason: { kind: "completed" } } },
		});

		expect(events.filter((event) => event.type === "turn_first_token")).toHaveLength(2);
		expect(events.filter((event) => event.type === "turn_start")).toHaveLength(2);
		expect(events.filter((event) => event.type === "turn_end")).toHaveLength(2);
	});
});
