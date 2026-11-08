import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSubagentTools, type SubagentToolHost, type SubagentSnapshot } from "../../server/subagents.js";

const questions = [{ id: "decision", question: "Which approach?" }];
const answers = [{ id: "decision", selected: [], custom: "Use A" }];

function setup() {
	const children: SubagentSnapshot[] = [
		{
			convId: "child",
			parentId: "parent",
			state: "running",
			streaming: true,
			type: "general",
			title: "Child",
			messageCount: 0,
			output: "",
		} as SubagentSnapshot,
	];
	let pending = [{ runId: "child", requestId: "request-1", questions }];
	let selfId = "parent";
	const host: SubagentToolHost = {
		spawnSubagent: vi.fn(async () => "child"),
		getSubagent: vi.fn((id) => children.find((c) => c.convId === id)),
		listSubagents: vi.fn(() => children),
		steerSubagent: vi.fn(async () => {}),
		stopSubagent: vi.fn(async () => {}),
		handoffSubagent: vi.fn(async () => {}),
		listTemplates: () => [],
		isTemplateUsable: () => false,
		markSubagentsConsumed: vi.fn(),
		consultParent: vi.fn(async () => ({ answers })),
		answerConsult: vi.fn(() => ({ ok: true })),
		escalateConsult: vi.fn(() => ({ ok: true })),
		getPendingConsults: vi.fn(() => pending),
		setConsultWaiting: vi.fn(),
	};
	const tools = makeSubagentTools(
		host,
		() => "en",
		() => selfId,
	);
	const call = (params: unknown, signal?: AbortSignal) =>
		tools[0].execute!("test", params as never, signal, undefined, {} as any);
	return {
		host,
		children,
		call,
		setPending: (value: typeof pending) => {
			pending = value;
		},
		setSelf: (value: string) => {
			selfId = value;
		},
	};
}

afterEach(() => vi.useRealTimers());

describe("parent consult tools", () => {
	it("awaits parent answers and forwards identity, questions and cancellation", async () => {
		const { host, call, setSelf } = setup();
		setSelf("child");
		let resolve!: (value: unknown) => void;
		vi.mocked(host.consultParent!).mockImplementation(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		const controller = new AbortController();
		const result = call({ action: "consult", questions }, controller.signal);
		expect(host.consultParent).toHaveBeenCalledWith("child", questions, controller.signal);
		resolve({ answers });
		expect((await result).details).toEqual({ answers });
	});

	it("preserves timeout status and warns against choosing for the parent", async () => {
		const { host, call } = setup();
		vi.mocked(host.consultParent!).mockResolvedValue({ status: "timed_out", timed_out: true });
		const result = await call({ action: "consult", questions });
		expect(result.details).toEqual({ status: "timed_out", timed_out: true });
		expect(result.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("do not choose") })]),
		);
	});

	it("routes answer and escalation only through the dedicated host APIs", async () => {
		const { host, call, setSelf } = setup();
		await call({ action: "answer", runId: "child", requestId: "request-1", answers });
		expect(host.answerConsult).toHaveBeenCalledWith("parent", "child", "request-1", answers);
		setSelf("new-parent");
		await call({ action: "escalate", runId: "child", requestId: "request-1" });
		expect(host.escalateConsult).toHaveBeenCalledWith("new-parent", "child", "request-1");
		expect(host.steerSubagent).not.toHaveBeenCalled();
	});

	it("propagates stale request and ownership rejection without reporting success", async () => {
		const { host, call } = setup();
		vi.mocked(host.answerConsult!).mockImplementation(() => {
			throw new Error("Wrong parent or stale request");
		});
		await expect(call({ action: "answer", runId: "child", requestId: "old", answers })).rejects.toThrow(
			"Wrong parent or stale request",
		);
	});

	it("surfaces structured host errors for both answer and escalation", async () => {
		const { host, call } = setup();
		vi.mocked(host.answerConsult!).mockReturnValue({ ok: false, error: "Stale request" });
		vi.mocked(host.escalateConsult!).mockReturnValue({ ok: false, error: "Wrong parent" });
		await expect(call({ action: "answer", runId: "child", requestId: "r", answers })).rejects.toThrow("Stale request");
		await expect(call({ action: "escalate", runId: "child", requestId: "r" })).rejects.toThrow("Wrong parent");
	});

	it("rejects invalid arguments, unsupported hosts and pre-cancelled calls", async () => {
		const { host, call } = setup();
		await expect(call({ action: "consult", questions: [] })).rejects.toThrow("1-3");
		await expect(call({ action: "consult", questions: [questions[0], questions[0]] })).rejects.toThrow("unique");
		await expect(call({ action: "answer", runId: "child", requestId: "r", answers: [] })).rejects.toThrow("structured");
		await expect(call({ action: "escalate", runId: "child" })).rejects.toThrow("requestId");
		const controller = new AbortController();
		controller.abort();
		await expect(call({ action: "consult", questions }, controller.signal)).rejects.toThrow();
		expect(host.consultParent).not.toHaveBeenCalled();
		host.consultParent = undefined;
		await expect(call({ action: "consult", questions })).rejects.toThrow("unavailable");
	});

	it("accepts message-only consult and answer (text-first schema)", async () => {
		const { host, call, setSelf } = setup();
		setSelf("child");
		await call({ action: "consult", message: "Which approach?" });
		expect(host.consultParent).toHaveBeenCalledWith("child", [{ id: "q1", question: "Which approach?" }], undefined);
		setSelf("parent");
		await call({ action: "answer", runId: "child", requestId: "request-1", message: "Use A" });
		expect(host.answerConsult).toHaveBeenCalledWith("parent", "child", "request-1", undefined, "Use A");
	});

	it("still rejects answer and consult without text or legacy structure", async () => {
		const { call } = setup();
		await expect(call({ action: "answer", runId: "child", requestId: "r" })).rejects.toThrow("nonempty message");
		await expect(call({ action: "consult", message: "   " })).rejects.toThrow("nonempty message");
	});

	it("does not deliver answers after cancellation while the host was pending", async () => {
		const { host, call } = setup();
		const controller = new AbortController();
		vi.mocked(host.consultParent!).mockImplementation(async () => {
			controller.abort();
			return { answers };
		});
		await expect(call({ action: "consult", questions }, controller.signal)).rejects.toThrow();
	});
});

describe("wait_all consult interruption", () => {
	it("registers before polling and clears waiting on early return", async () => {
		const { host, call } = setup();
		vi.mocked(host.getPendingConsults!).mockImplementation(() => {
			expect(host.setConsultWaiting).toHaveBeenLastCalledWith("parent", true);
			return [{ runId: "child", requestId: "r", questions }];
		});
		await call({ action: "wait_all" });
		expect(vi.mocked(host.setConsultWaiting!).mock.calls).toEqual([
			["parent", true],
			["parent", false],
		]);
	});

	it("clears waiting when polling throws", async () => {
		const { host, call } = setup();
		vi.mocked(host.getPendingConsults!).mockImplementation(() => {
			throw new Error("Polling failed");
		});
		await expect(call({ action: "wait_all" })).rejects.toThrow("Polling failed");
		expect(host.setConsultWaiting).toHaveBeenLastCalledWith("parent", false);
	});

	it("uses the current parent identity after takeover for polling and cleanup", async () => {
		vi.useFakeTimers();
		const { host, call, setPending, setSelf } = setup();
		setPending([]);
		const result = call({ action: "wait_all" });
		setSelf("remapped-parent");
		setPending([{ runId: "child", requestId: "r", questions }]);
		await vi.advanceTimersByTimeAsync(250);
		expect((await result).details).toMatchObject({ status: "needs_input" });
		expect(host.getPendingConsults).toHaveBeenLastCalledWith("remapped-parent");
		expect(host.setConsultWaiting).toHaveBeenLastCalledWith("remapped-parent", false);
	});

	it("clears waiting after cancellation and timeout", async () => {
		vi.useFakeTimers();
		const { host, call, setPending } = setup();
		setPending([]);
		const controller = new AbortController();
		const cancelled = call({ action: "wait_all" }, controller.signal);
		controller.abort();
		await vi.advanceTimersByTimeAsync(250);
		await cancelled;
		expect(host.setConsultWaiting).toHaveBeenLastCalledWith("parent", false);
		const timedOut = call({ action: "wait_all", timeoutSeconds: 1 });
		expect(host.setConsultWaiting).toHaveBeenLastCalledWith("parent", true);
		await vi.advanceTimersByTimeAsync(1250);
		await timedOut;
		expect(host.setConsultWaiting).toHaveBeenLastCalledWith("parent", false);
	});

	it("does not register an empty wait and supports hosts without tracking", async () => {
		const { host, call, children } = setup();
		children.length = 0;
		await call({ action: "wait_all" });
		expect(host.setConsultWaiting).not.toHaveBeenCalled();
		host.setConsultWaiting = undefined;
		await call({ action: "wait_all", runIds: ["child"] });
	});
	it("returns actionable requests immediately without consuming running children", async () => {
		const { host, call } = setup();
		const result = await call({ action: "wait_all" });
		expect(result.details).toEqual({
			status: "needs_input",
			requests: [{ runId: "child", requestId: "request-1", questions }],
		});
		expect(host.getPendingConsults).toHaveBeenCalledWith("parent");
		expect(host.markSubagentsConsumed).not.toHaveBeenCalled();
	});

	it("does not spin on an already delivered request, but returns new requests", async () => {
		vi.useFakeTimers();
		const { call, setPending } = setup();
		const first = await call({ action: "wait_all" });
		expect(first.details).toMatchObject({ status: "needs_input", requests: [{ requestId: "request-1" }] });
		let settled = false;
		const second = call({ action: "wait_all", timeoutSeconds: 1 }).then((r) => {
			settled = true;
			return r;
		});
		await vi.advanceTimersByTimeAsync(500);
		expect(settled).toBe(false);
		setPending([{ runId: "child", requestId: "request-2", questions }]);
		await vi.advanceTimersByTimeAsync(250);
		expect((await second).details).toMatchObject({ status: "needs_input", requests: [{ requestId: "request-2" }] });
	});

	it("detects consults appearing after waiting begins", async () => {
		vi.useFakeTimers();
		const { call, setPending } = setup();
		setPending([]);
		const result = call({ action: "wait_all" });
		await vi.advanceTimersByTimeAsync(250);
		setPending([{ runId: "child", requestId: "new", questions }]);
		await vi.advanceTimersByTimeAsync(250);
		expect((await result).details).toMatchObject({ status: "needs_input" });
	});

	it("ignores escalated user questions absent from the host list", async () => {
		vi.useFakeTimers();
		const { call, setPending } = setup();
		setPending([]);
		const result = call({ action: "wait_all", timeoutSeconds: 1 });
		await vi.advanceTimersByTimeAsync(1250);
		expect((await result).details).not.toMatchObject({ status: "needs_input" });
	});

	it("delivers a sibling's consult while explicitly waiting for another child", async () => {
		vi.useFakeTimers();
		const { host, call, setPending, children } = setup();
		children.push({ ...children[0], convId: "sibling" });
		setPending([]);
		const waiting = call({ action: "wait_all", runIds: ["child"] });
		expect(host.setConsultWaiting).toHaveBeenLastCalledWith("parent", true);
		setPending([{ runId: "sibling", requestId: "sibling-request", questions }]);
		await vi.advanceTimersByTimeAsync(250);
		expect((await waiting).details).toEqual({
			status: "needs_input",
			requests: [{ runId: "sibling", requestId: "sibling-request", questions }],
		});
		expect(host.setConsultWaiting).toHaveBeenLastCalledWith("parent", false);
		expect(host.markSubagentsConsumed).not.toHaveBeenCalled();
		const again = call({ action: "wait_all", runIds: ["child"], timeoutSeconds: 1 });
		await vi.advanceTimersByTimeAsync(1250);
		expect((await again).details).not.toMatchObject({ status: "needs_input" });
	});

	it("delivers pending consults even when the wait set is empty without repeated delivery", async () => {
		const { host, call, children } = setup();
		children.length = 0;
		expect((await call({ action: "wait_all" })).details).toMatchObject({
			status: "needs_input",
			requests: [{ runId: "child" }],
		});
		expect((await call({ action: "wait_all" })).details).not.toMatchObject({ status: "needs_input" });
		expect(host.getPendingConsults).toHaveBeenCalledWith("parent");
		expect(host.setConsultWaiting).not.toHaveBeenCalled();
	});

	it("times out normally when an already delivered request remains unresolved", async () => {
		vi.useFakeTimers();
		const { call } = setup();
		await call({ action: "wait_all" });
		const result = call({ action: "wait_all", timeoutSeconds: 1 });
		await vi.advanceTimersByTimeAsync(1250);
		expect((await result).content).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("Wait timed out") })]),
		);
	});

	it("continues to collect terminal results after a consult was handled", async () => {
		vi.useFakeTimers();
		const { host, call, setPending, children } = setup();
		await call({ action: "wait_all" });
		const result = call({ action: "wait_all" });
		setPending([]);
		children[0].streaming = false;
		children[0].state = "done";
		children[0].output = "Completed";
		await vi.advanceTimersByTimeAsync(250);
		expect((await result).content).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("Completed") })]),
		);
		expect(host.markSubagentsConsumed).toHaveBeenCalledWith(["child"]);
	});
});
