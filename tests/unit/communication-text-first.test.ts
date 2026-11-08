import { describe, expect, it, vi } from "vitest";
import {
	ConversationCommunication,
	answersFromMessage,
	questionsFromMessage,
	type CommunicationHost,
} from "../../server/conversation-communication.js";

const root = { id: "root", cwd: "/project" };
const child = { id: "child", cwd: "/project", parentId: "root" };

const host = () =>
	({
		resolveTarget: (_sender: string, to: string) => (to === "parent" || to === "root" ? root : child),
		authorize: vi.fn(),
		deliver: vi.fn(() => "queued" as const),
		askUser: vi.fn(),
	}) satisfies CommunicationHost;

describe("text-first communication compatibility", () => {
	it("wraps a plain consult message into one structured question", () => {
		expect(questionsFromMessage("Which branch?")).toEqual([{ id: "q1", question: "Which branch?" }]);
		expect(questionsFromMessage("   ")).toBeUndefined();
		expect(questionsFromMessage(undefined)).toBeUndefined();
	});

	it("wraps a plain reply message into a custom answer for every pending question", () => {
		const questions = [
			{ id: "q1", question: "Which branch?" },
			{ id: "q2", question: "Squash?" },
		];
		expect(answersFromMessage("main, squashed", questions)).toEqual([
			{ id: "q1", selected: [], custom: "main, squashed" },
			{ id: "q2", selected: [], custom: "main, squashed" },
		]);
		expect(answersFromMessage("", questions)).toBeUndefined();
	});

	it("request+reply round-trips on message alone and still exposes questions to the UI", async () => {
		const comm = new ConversationCommunication();
		const h = host();
		const pending = comm.communicate(h, child, "request", { to: "parent", message: "Which branch?" });
		const [envelope] = comm.inbox(root);
		expect(envelope.questions).toEqual([{ id: "q1", question: "Which branch?" }]);
		expect(envelope.message).toBe("Which branch?");
		const reply = await comm.communicate(h, root, "reply", { requestId: envelope.requestId, message: "main" });
		expect(reply).toEqual({ requestId: envelope.requestId, status: "replied" });
		await expect(pending).resolves.toEqual({
			requestId: envelope.requestId,
			result: [{ id: "q1", selected: [], custom: "main" }],
		});
	});

	it("rejects a request that carries neither message nor legacy questions", async () => {
		const comm = new ConversationCommunication();
		await expect(comm.communicate(host(), child, "request", { to: "parent" })).rejects.toThrow(
			"A nonempty message is required",
		);
	});

	it("keeps legacy structured questions and answers working", async () => {
		const comm = new ConversationCommunication();
		const h = host();
		const questions = [{ id: "choice", question: "Proceed?", options: [{ label: "yes" }, { label: "no" }] }];
		const pending = comm.communicate(h, child, "request", { to: "parent", questions });
		const [envelope] = comm.inbox(root);
		expect(envelope.questions).toEqual(questions);
		await comm.communicate(h, root, "reply", {
			requestId: envelope.requestId,
			answers: [{ id: "choice", selected: ["yes"] }],
		});
		await expect(pending).resolves.toEqual({
			requestId: envelope.requestId,
			result: [{ id: "choice", selected: ["yes"] }],
		});
	});
});
