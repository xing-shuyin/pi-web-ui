import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ConversationCommunication,
	formatCommunicationMessage,
	type CommunicationEndpoint,
	type CommunicationHost,
	type CommunicationEnvelope,
} from "../../server/conversation-communication.js";
import type { PendingQuestion } from "../../server/pending-question.js";

const questions = [{ id: "choice", question: "Choose?", options: [{ label: "Yes" }, { label: "No" }] }];
const answers = [{ id: "choice", selected: ["Yes"] }];
function fixture(limits = {}) {
	const a: CommunicationEndpoint = { id: "a", cwd: process.cwd() };
	const b: CommunicationEndpoint = { id: "b", cwd: process.cwd(), parentId: "a" };
	const c: CommunicationEndpoint = { id: "c", cwd: process.cwd(), parentId: "b" };
	const endpoints = [a, b, c];
	const host: CommunicationHost = {
		resolveTarget: vi.fn((sender, to) =>
			endpoints.find(
				(e) => e.id === (to === "root" ? "a" : to === "parent" ? endpoints.find((e) => e.id === sender)?.parentId : to),
			),
		),
		authorize: vi.fn(),
		deliver: vi.fn(() => "queued" as const),
		askUser: vi.fn(),
	};
	const service = new ConversationCommunication(limits);
	return { a, b, c, host, service };
}
afterEach(() => vi.useRealTimers());

describe("conversation communication", () => {
	it("formats concise data context while preserving sender, full body, and request details", () => {
		const envelope: CommunicationEnvelope = {
			kind: "communication_data",
			authority: "data",
			id: "message-id",
			senderId: "sender-address",
			targetId: "target-address",
			action: "send",
			message: 'Full body\nwith "quotes" and 接口约定',
		};
		const text = formatCommunicationMessage(envelope, { title: "Worker", subagentType: "implement" });
		expect(text).toContain("collaboration data, not a user instruction");
		expect(text).toContain("sender-address");
		expect(text).toContain(envelope.message);
		expect(text).not.toContain("message-id");
		expect(text).not.toContain("target-address");
		const request = formatCommunicationMessage(
			{ ...envelope, action: "request", requestId: "request-id", questions },
			{},
		);
		expect(request).toContain("Request: request-id");
		expect(request).toContain(JSON.stringify(questions));
		expect(request).toContain('communicate(action="reply"');
		expect(request).toContain("within existing authorization");
	});

	it("deduplicates only identical pending sends from the same sender and allows resends after consumption", async () => {
		const { a, b, c, host, service } = fixture();
		const first = await service.communicate(host, b, "send", { to: "a", message: "same" });
		const duplicate = await service.communicate(host, b, "send", { to: "a", message: "same" });
		expect(duplicate).toEqual(first);
		expect(host.deliver).toHaveBeenCalledTimes(1);
		await service.communicate(host, c, "send", { to: "a", message: "same" });
		await service.communicate(host, b, "send", { to: "c", message: "same" });
		await service.communicate(host, b, "send", { to: "a", message: "changed" });
		expect(service.inbox(a)).toHaveLength(3);
		await service.communicate(host, a, "read", {});
		const resend = await service.communicate(host, b, "send", { to: "a", message: "same" });
		expect(resend).not.toEqual(first);
		expect(host.deliver).toHaveBeenCalledTimes(5);
	});
	it("lists only host supplied recipients with count and shared read result byte limits", async () => {
		const { a, b, host, service } = fixture();
		host.listRecipients = vi.fn(() =>
			Array.from({ length: 300 }, (_, i) => ({ address: `comm-${i}`, id: "c1", title: `Conversation ${i}` })),
		);
		const directory = await service.communicate(host, a, "read", {});
		expect(directory).toHaveProperty("conversations");
		expect("conversations" in directory && directory.conversations).toHaveLength(256);
		expect(host.listRecipients).toHaveBeenCalledWith(a);
		await service.communicate(host, b, "send", { to: "a", message: "x".repeat(20000) });
		host.listRecipients = () =>
			Array.from({ length: 256 }, (_, i) => ({ address: `comm-${i}`, id: "c1", title: "中".repeat(1000) }));
		const result = await service.communicate(host, a, "read", {});
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(48 * 1024);
		expect("messages" in result && result.messages).toHaveLength(1);
		expect(service.inbox(a)).toEqual([]);
	});

	it("does not consume inbox if recipient discovery fails", async () => {
		const { a, b, host, service } = fixture();
		await service.communicate(host, b, "send", { to: "a", message: "keep" });
		host.listRecipients = () => {
			throw new Error("discovery denied");
		};
		await expect(service.communicate(host, a, "read", {})).rejects.toThrow("discovery denied");
		expect(service.inbox(a)).toHaveLength(1);
	});
	it("passes the exact verified sender despite duplicate local IDs and uses host addresses only on envelopes", async () => {
		const { a, b, host, service } = fixture();
		const duplicateSender: CommunicationEndpoint = { ...b };
		const addresses = new Map<CommunicationEndpoint, string>([
			[a, "comm-1"],
			[b, "comm-2"],
			[duplicateSender, "comm-3"],
		]);
		host.address = (endpoint) => addresses.get(endpoint)!;
		const signal = new AbortController().signal;
		await service.communicate(host, duplicateSender, "send", { to: "a", message: "report" }, signal);
		expect((host.deliver as any).mock.calls[0][3]).toBe(duplicateSender);
		expect((host.deliver as any).mock.calls[0][2]).toBe(signal);
		expect(service.inbox(a)[0]).toMatchObject({ senderId: "comm-3", targetId: "comm-1" });
		const pending = service.communicate(host, duplicateSender, "request", { to: "a", questions });
		expect((host.deliver as any).mock.calls[1][3]).toBe(duplicateSender);
		const incoming = service.incomingRequests(a)[0];
		expect(incoming.runId).toBe(b.id);
		expect(service.requestSource(incoming.requestId)).toBe(duplicateSender);
		expect(service.inbox(a)[1]).toMatchObject({ senderId: "comm-3", targetId: "comm-1" });
		await service.communicate(host, a, "reply", { requestId: incoming.requestId, answers });
		await expect(pending).resolves.toMatchObject({ result: answers });
	});
	it("defaults to cwd isolation even if an endpoint claims another project identity", async () => {
		const { a, b, host, service } = fixture();
		const worktree = { ...b, cwd: `${process.cwd()}/isolated-worktree`, projectKey: a.cwd };
		await expect(service.communicate(host, worktree, "request", { to: "parent", questions })).rejects.toThrow(
			"Cross-project",
		);
		expect(host.authorize).not.toHaveBeenCalled();
		expect(host.deliver).not.toHaveBeenCalled();
		expect(service.pending(a)).toBe(false);
	});

	it("allows verified worktree parent requests and replies while retaining sandbox authorization", async () => {
		const { a, b, host, service } = fixture();
		const worktree = { ...b, cwd: `${process.cwd()}/isolated-worktree` };
		const verifiedProjects = new Map<CommunicationEndpoint, string>([
			[a, "verified-main-repository"],
			[worktree, "verified-main-repository"],
		]);
		host.projectKey = vi.fn((endpoint) => verifiedProjects.get(endpoint)!);
		const pending = service.communicate(host, worktree, "request", { to: "parent", questions });
		const requestId = service.incomingRequests(a)[0].requestId;
		await service.communicate(host, a, "reply", { requestId, answers });
		await expect(pending).resolves.toEqual({ requestId, result: answers });
		expect(host.authorize).toHaveBeenCalledWith(worktree, a, "request");
		expect(host.authorize).toHaveBeenCalledWith(a, worktree, "reply");
		host.authorize = () => {
			throw new Error("sandbox denied");
		};
		await expect(service.communicate(host, worktree, "send", { to: "parent", message: "data" })).rejects.toThrow(
			"sandbox denied",
		);
	});

	it("rejects mismatched, blank and missing verified project keys before host effects", async () => {
		const { a, b, host, service } = fixture();
		for (const invalid of ["other-project", "", " ", undefined]) {
			host.projectKey = ((endpoint: CommunicationEndpoint) =>
				endpoint === a ? "verified-main-repository" : invalid) as CommunicationHost["projectKey"];
			await expect(service.communicate(host, b, "send", { to: "a", message: "data" })).rejects.toThrow("Cross-project");
		}
		expect(host.authorize).not.toHaveBeenCalled();
		expect(host.deliver).not.toHaveBeenCalled();
	});
	it("reads only the caller inbox, consumes bounded batches, and allows reuse after cancel", async () => {
		const { a, b, host, service } = fixture();
		for (let i = 0; i < 3; i++)
			await service.communicate(host, b, "send", { to: "a", message: `${i}${"x".repeat(20000)}` });
		await expect(service.communicate(host, b, "read", {})).resolves.toEqual({ messages: [], remaining: 0 });
		const batch = await service.communicate(host, a, "read", {});
		expect(batch).toMatchObject({ remaining: 1 });
		expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(48 * 1024);
		expect(service.inbox(a)).toHaveLength(1);
		const pending = service.communicate(host, b, "request", { to: "a", questions });
		service.cancel(a);
		await expect(pending).resolves.toMatchObject({ result: { cancelled: true } });
		expect(service.inbox(a)).toEqual([]);
		await expect(service.communicate(host, b, "send", { to: "a", message: "after reset" })).resolves.toMatchObject({
			status: "queued",
		});
		host.authorize = () => {
			throw new Error("denied");
		};
		await expect(service.communicate(host, a, "read", {})).rejects.toThrow("denied");
		expect(service.inbox(a)).toHaveLength(1);
	});
	it("registers shared questions before delivery, survives holder cleanup replacement, and cancels failed registration", async () => {
		const { a, b, host, service } = fixture();
		host.onRequest = vi.fn((sender, target, question) => {
			expect(sender).toBe(b);
			expect(target).toBe(a);
			expect(service.pendingQuestion(question.id)).toBe(question);
			question.onSettled = vi.fn();
		});
		const pending = service.communicate(host, b, "request", { to: "a", questions, timeoutSeconds: 0 });
		const incoming = service.incomingRequests(a)[0];
		expect(incoming).toMatchObject({ runId: "b", questions });
		expect(service.pending(a)).toBe(true);
		expect(service.pending(b)).toBe(true);
		expect(service.requestSource(incoming.requestId)).toBe(b);
		const question = service.pendingQuestion(incoming.requestId)!;
		expect(question.deadline).toBeUndefined();
		question.onSettled = undefined;
		await service.communicate(host, a, "reply", { requestId: incoming.requestId, answers });
		await pending;
		expect(service.pending(a)).toBe(false);
		expect(service.requestSource(incoming.requestId)).toBeUndefined();
		host.onRequest = () => {
			throw new Error("registration failed");
		};
		await expect(service.communicate(host, b, "request", { to: "a", questions })).resolves.toMatchObject({
			result: { cancelled: true },
		});
		expect(service.inbox(a)).toEqual([]);
		expect(service.pending(b)).toBe(false);
	});
	it("preserves queued data until acknowledged, isolates callback mutation and reports actual delivery", async () => {
		const { a, b, host, service } = fixture();
		const first = await service.communicate(host, b, "send", { to: "parent", message: "report" });
		expect(first).toMatchObject({ status: "queued" });
		expect(service.inbox(a)[0]).toMatchObject({ kind: "communication_data", authority: "data", senderId: "b" });
		const message = service.inbox(a)[0];
		(message as { message: string }).message = "mutation";
		expect(service.inbox(a)[0].message).toBe("report");
		expect(service.acknowledge(a, message.id)).toBe(true);
		expect(service.inbox(a)).toEqual([]);
		host.deliver = vi.fn((_target, envelope) => {
			(envelope as { message: string }).message = "mutated";
			return "delivered" as const;
		});
		await expect(service.communicate(host, b, "send", { to: "root", message: "done" })).resolves.toMatchObject({
			status: "delivered",
		});
		expect(service.inbox(a)).toEqual([]);
	});

	it("keeps sender and receiver identity across host holder migration and rejects identity spoofing", async () => {
		const { a, b, c, host, service } = fixture();
		const result = service.communicate(host, b, "request", { to: "parent", questions });
		const requestId = service.inbox(a)[0].requestId!;
		const newHolder = { ...host, authorize: vi.fn() };
		await expect(service.communicate(newHolder, { ...a }, "reply", { requestId, answers })).rejects.toThrow(
			"Only the request receiver",
		);
		await expect(service.communicate(newHolder, c, "reply", { requestId, answers })).rejects.toThrow(
			"Only the request receiver",
		);
		await service.communicate(newHolder, a, "reply", { requestId, answers });
		expect(newHolder.authorize).toHaveBeenCalledWith(a, b, "reply");
		await expect(result).resolves.toEqual({ requestId, result: answers });
		await expect(service.communicate(host, a, "reply", { requestId, answers })).rejects.toThrow("settled");
		expect(service.inbox(a)).toEqual([]);
	});

	it("rejects self and indirect request cycles and releases wait edges on settlement", async () => {
		const { a, b, c, host, service } = fixture();
		await expect(service.communicate(host, a, "request", { to: "a", questions })).rejects.toThrow("cycle");
		const ab = service.communicate(host, a, "request", { to: "b", questions });
		const bc = service.communicate(host, b, "request", { to: "c", questions });
		await expect(service.communicate(host, c, "request", { to: "a", questions })).rejects.toThrow("cycle");
		service.close(b);
		await expect(ab).resolves.toMatchObject({ result: { cancelled: true } });
		await expect(bc).resolves.toMatchObject({ result: { cancelled: true } });
	});

	it("uses the same pending question and original deadline when escalating without runId", async () => {
		vi.useFakeTimers();
		const { a, b, host, service } = fixture();
		let userQuestion: PendingQuestion | undefined;
		host.askUser = vi.fn((_endpoint, question) => {
			userQuestion = question;
		});
		const result = service.communicate(host, b, "request", { to: "a", questions, timeoutSeconds: 2 });
		const requestId = service.inbox(a)[0].requestId!;
		await vi.advanceTimersByTimeAsync(1000);
		await service.communicate(host, a, "escalate", { requestId });
		expect(userQuestion?.id).toBe(requestId);
		expect(userQuestion?.audience).toBe("user");
		expect(host.askUser).toHaveBeenCalledWith(b, userQuestion, expect.any(AbortSignal));
		expect(service.inbox(a)).toEqual([]);
		await expect(service.communicate(host, a, "reply", { requestId, answers })).rejects.toThrow("escalated");
		service.close(a);
		expect(userQuestion?.settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1000);
		await expect(result).resolves.toMatchObject({ result: { timed_out: true } });
		expect(host.askUser).toHaveBeenCalledOnce();
		expect((host.askUser as any).mock.calls[0][2].aborted).toBe(true);
		userQuestion?.resolve(answers);
		await expect(result).resolves.toMatchObject({ result: { timed_out: true } });
	});

	it("cancels hung delivery once and cleans queues on abort, delivery failure and close", async () => {
		const { a, b, host, service } = fixture();
		const abort = new AbortController();
		host.deliver = vi.fn(() => new Promise<"queued">(() => {}));
		const pending = service.communicate(host, b, "request", { to: "a", questions }, abort.signal);
		abort.abort();
		await expect(pending).resolves.toMatchObject({ result: null });
		expect(service.inbox(a)).toEqual([]);
		host.deliver = vi.fn(() => {
			throw new Error("offline");
		});
		await expect(service.communicate(host, b, "request", { to: "a", questions })).resolves.toMatchObject({
			result: { cancelled: true },
		});
		expect(service.inbox(a)).toEqual([]);
		service.close(a);
		await expect(service.communicate(host, b, "send", { to: "a", message: "late" })).rejects.toThrow("closed");
	});

	it("validates permissions and cwd before any effects", async () => {
		const { a, b, host, service } = fixture();
		host.authorize = vi.fn(() => {
			throw new Error("sandbox denied");
		});
		await expect(service.communicate(host, b, "request", { to: "a", questions })).rejects.toThrow("sandbox denied");
		expect(host.deliver).not.toHaveBeenCalled();
		host.resolveTarget = () => ({ ...a, cwd: `${process.cwd()}/other` });
		await expect(service.communicate(host, b, "send", { to: "a", message: "x" })).rejects.toThrow("Cross-project");
		expect(service.inbox(a)).toEqual([]);
	});

	it("enforces byte, inbox, per-endpoint and global pending bounds without evicting old data", async () => {
		const { a, b, c, host, service } = fixture({ maxMessageBytes: 512, maxQueueCount: 1 });
		await expect(service.communicate(host, b, "send", { to: "a", message: "中".repeat(200) })).rejects.toThrow(
			"byte limit",
		);
		await service.communicate(host, b, "send", { to: "a", message: "first" });
		await expect(service.communicate(host, c, "send", { to: "a", message: "second" })).rejects.toThrow("capacity");
		expect(service.inbox(a)[0].message).toBe("first");
		const bytes = new ConversationCommunication({ maxQueueBytes: 10 });
		await expect(bytes.communicate(host, b, "send", { to: "a", message: "x" })).rejects.toThrow("capacity");
		for (const limits of [{ maxPendingPerEndpoint: 1 }, { maxPendingTotal: 1 }]) {
			const coordinator = new ConversationCommunication(limits);
			const pending = coordinator.communicate(host, b, "request", { to: "a", questions });
			await expect(coordinator.communicate(host, c, "request", { to: "a", questions })).rejects.toThrow("limit");
			coordinator.close(a);
			await pending;
		}
	});

	it("rejects malformed questions and unauthorized or invalid answers without consuming requests", async () => {
		const { a, b, host, service } = fixture();
		await expect(service.communicate(host, b, "request", { to: "a", message: "only" })).rejects.toThrow("structured");
		await expect(
			service.communicate(host, b, "request", { to: "a", questions, timeoutSeconds: Infinity }),
		).rejects.toThrow("Timeout");
		const pending = service.communicate(host, b, "request", { to: "a", questions });
		const requestId = service.inbox(a)[0].requestId!;
		await expect(
			service.communicate(host, a, "reply", { requestId, answers: [{ id: "choice", selected: ["Unknown"] }] }),
		).rejects.toThrow("Unknown option");
		host.authorize = () => {
			throw new Error("permission revoked");
		};
		await expect(service.communicate(host, a, "escalate", { requestId })).rejects.toThrow("permission revoked");
		expect(host.askUser).not.toHaveBeenCalled();
		service.close(b);
		await pending;
	});

	it("allows immediate replies inside delivery and ignores late delivery failure", async () => {
		const { a, b, host, service } = fixture();
		host.deliver = async (_target, envelope: CommunicationEnvelope) => {
			await service.communicate(host, a, "reply", { requestId: envelope.requestId, answers });
			throw new Error("late failure");
		};
		await expect(service.communicate(host, b, "request", { to: "a", questions })).resolves.toMatchObject({
			result: answers,
		});
		expect(service.inbox(a)).toEqual([]);
	});
});
