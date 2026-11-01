import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";

describe("plugin run stable session identity", () => {
	it("identifies a browser continuation without a channel run token and survives transfer", () => {
		const holder = fakeClientSession() as any;
		holder.clientId = "plugin:wechat-ilink:peer";
		holder.onRunEvent = vi.fn();
		const conv = { id: "c1", session: { sessionId: "sdk-wechat-session" } };
		holder.emitRun(conv, { type: "run_start", task: "hello from the browser" });
		expect(holder.onRunEvent).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: "run_start",
				conversationId: "c1",
				clientId: "plugin:wechat-ilink:peer",
				sessionId: "sdk-wechat-session",
			}),
		);
		expect(holder.onRunEvent.mock.calls[0][0]).not.toHaveProperty("runId");
		holder.clientId = "browser-owner";
		conv.id = "c4";
		holder.emitRun(conv, { type: "run_end" });
		expect(holder.onRunEvent).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: "run_end",
				conversationId: "c4",
				clientId: "browser-owner",
				sessionId: "sdk-wechat-session",
			}),
		);
	});
});
