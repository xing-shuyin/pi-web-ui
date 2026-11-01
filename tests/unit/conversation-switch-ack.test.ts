import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";

describe("returning from a shared view to the active local conversation", () => {
	it("sends a full local snapshot and completes the transition without displacing the conversation", async () => {
		const flushSnapshot = vi.fn();
		const emit = vi.fn();
		const displaceActive = vi.fn();
		const client = Object.assign(fakeClientSession(), {
			activeId: "local-conversation",
			flushSnapshot,
			emit,
			displaceActive,
		});

		await client.switchConversation("local-conversation");

		// The browser may still hold a remote conversation/revision, so a delta
		// cannot restore it. Force a full snapshot before acknowledging completion.
		expect(flushSnapshot).toHaveBeenCalledExactlyOnceWith(true);
		expect(emit).toHaveBeenCalledExactlyOnceWith({
			type: "transition_progress",
			kind: "conversation",
			target: "local-conversation",
			phase: "done",
			progress: 100,
			text: "对话切换完成",
			textEn: "Conversation switched",
		});
		expect(flushSnapshot.mock.invocationCallOrder[0]).toBeLessThan(emit.mock.invocationCallOrder[0]);
		expect(displaceActive).not.toHaveBeenCalled();
	});
});
