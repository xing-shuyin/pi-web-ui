import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { conversationIdentity } from "../../server/conversation-identity.js";
import { fakeClientSession } from "../helpers/fake-session.js";

function host() {
	const client: any = fakeClientSession();
	Object.assign(client, {
		convs: new Map(),
		pendingSubagentNotices: new Map(),
		deliveringSubagentNotices: new Map(),
		emitConversations: vi.fn(),
		flushSnapshot: vi.fn(),
	});
	return client;
}

describe("completion notification lifecycle", () => {
	it("waits for queued prompts, prompt startup and notices owned by another client", () => {
		const client = host();
		const other = host();
		client.allSubagentSessions = () => [other];
		const conv: any = { id: "parent", queueSteering: [], queueFollowUp: [] };
		expect(client.completionPending(conv)).toBe(false);
		for (const field of ["queueSteering", "queueFollowUp"]) {
			conv[field] = ["queued"];
			expect(client.completionPending(conv)).toBe(true);
			conv[field] = [];
		}
		conv.promptInFlight = true;
		expect(client.completionPending(conv)).toBe(true);
		conv.promptInFlight = false;
		other.pendingSubagentNotices.set(conversationIdentity(conv), {});
		expect(client.completionPending(conv)).toBe(true);
		other.pendingSubagentNotices.clear();
		other.deliveringSubagentNotices.set(conversationIdentity(conv), 1);
		expect(client.completionPending(conv)).toBe(true);
		other.deliveringSubagentNotices.clear();
		expect(client.completionPending(conv)).toBe(false);
	});

	it.each([false, true])(
		"keeps pending state throughout asynchronous delivery and clears after settlement (reject=%s)",
		async (reject) => {
			const client = host();
			const conv = { id: "parent" };
			client.convs.set(conv.id, conv);
			client.activeId = conv.id;
			client.pendingSubagentNotices.set(conv.id, {});
			let finish!: () => void;
			client.deliverSubagentCompletionNotice = vi.fn(async () => {
				client.pendingSubagentNotices.delete(conv.id);
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				if (reject) throw new Error("delivery failed");
			});
			const delivery = client.flushSubagentCompletionNotice(conv.id);
			expect(client.completionPending(conv)).toBe(true);
			finish();
			if (reject) await expect(delivery).rejects.toThrow("delivery failed");
			else await delivery;
			expect(client.completionPending(conv)).toBe(false);
			expect(client.emitConversations).toHaveBeenCalledOnce();
			expect(client.flushSnapshot).toHaveBeenCalledOnce();
		},
	);

	it("refreshes the current holder after a parent is taken over", () => {
		const source = host();
		const target = host();
		target.activeId = "parent";
		const parent = { id: "parent" };
		target.convs.set(parent.id, parent);
		source.allSubagentSessions = () => [target];
		source.refreshCompletionState(conversationIdentity(parent));
		expect(target.emitConversations).toHaveBeenCalledOnce();
		expect(target.flushSnapshot).toHaveBeenCalledOnce();
		expect(source.emitConversations).not.toHaveBeenCalled();
	});
});
