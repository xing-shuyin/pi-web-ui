import { describe, expect, it } from "vitest";
import { PluginTurnTimer } from "../../packages/keel/src/plugin-run-timing.js";
import type { PluginRunEvent } from "../../packages/keel/src/contracts/plugin.js";

describe("PluginTurnTimer", () => {
	it("emits one first-token sample per model request and clears on end", () => {
		const events: PluginRunEvent[] = [];
		const timer = new PluginTurnTimer((event) => events.push(event), {
			conversationId: "conv-1",
			clientId: "client-1",
			sessionId: "session-1",
		});

		timer.start(1000);
		timer.first(1400);
		timer.first(1500);
		timer.end(2000);
		timer.first(2100);

		expect(events).toEqual([
			{ conversationId: "conv-1", clientId: "client-1", sessionId: "session-1", type: "turn_start", at: 1000 },
			{
				conversationId: "conv-1",
				clientId: "client-1",
				sessionId: "session-1",
				type: "turn_first_token",
				at: 1400,
				durationMs: 400,
			},
			{ conversationId: "conv-1", clientId: "client-1", sessionId: "session-1", type: "turn_end", at: 2000 },
		]);
	});

	it("clamps same-tick samples and supports a clean next request", () => {
		const events: PluginRunEvent[] = [];
		const timer = new PluginTurnTimer((event) => events.push(event), { conversationId: "conv-1" });
		timer.start(1000);
		timer.first(1000);
		timer.end(1100);
		timer.start(1200);
		timer.first(1250);
		timer.clear();

		expect(events.filter((event) => event.type === "turn_first_token").map((event) => event.durationMs)).toEqual([
			1, 50,
		]);
		expect(timer.isActive).toBe(false);
	});
});
