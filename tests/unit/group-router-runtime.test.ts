import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createGroupRouterRuntime,
	type GroupRouterContext,
	type GroupRouterModelRuntime,
} from "../../server/device-center/group-router-runtime.js";
import type { RouterJob } from "../../server/device-center/group-router.js";

function fixture() {
	const job: RouterJob = {
		id: "job",
		accountId: "account",
		roomId: "room",
		eventKey: "event",
		trigger: { type: "human_message", messageId: "message" },
		fingerprint: "fingerprint",
		status: "running",
		config: {
			enabled: true,
			deviceId: "device",
			model: "custom/provider/model",
			thinkingLevel: "high",
			tools: ["reply", "dispatch", "work_items"],
		},
		configRevision: 1,
		attempts: 1,
		appliedActionCount: 0,
		createdAt: 0,
		updatedAt: 0,
	};
	const context: GroupRouterContext = {
		room: { id: "room", name: "Group" },
		history: [{ text: "untrusted group history" }],
		members: [{ id: "bot", name: "Executor", enabled: true }],
		workItems: [{ id: "work", revision: 3, status: "open" }],
		trigger: job.trigger,
	};
	const model = { id: "provider/model", provider: "custom", api: "openai-completions" };
	const completeSimple = vi.fn().mockResolvedValue(response());
	const getModel = vi.fn().mockReturnValue(model);
	const runtime = { getModel, completeSimple } as any as GroupRouterModelRuntime;
	const getModelRuntime = vi.fn().mockResolvedValue(runtime);
	const router = createGroupRouterRuntime({ getModelRuntime });
	const run = (signal = new AbortController().signal) => router.runGroupRouter({ job, context, signal });
	return { job, context, model, completeSimple, getModel, getModelRuntime, router, run };
}
function response(
	calls: Array<[string, Record<string, unknown>]> = [],
	stopReason = calls.length ? "toolUse" : "stop",
): any {
	return {
		role: "assistant",
		stopReason,
		content: calls.map(([name, args], i) => ({ type: "toolCall", name, arguments: args, id: `call-${i}` })),
	};
}
afterEach(() => vi.useRealTimers());

describe("independent group router runtime", () => {
	it("uses the host registered model, explicit thinking, and only its configured tool schemas", async () => {
		const f = fixture();
		f.job.config.tools = ["reply"];
		f.completeSimple.mockResolvedValueOnce(response([["reply", { text: "Coordinating work" }]]));
		expect(await f.run()).toEqual([{ type: "reply", text: "Coordinating work" }]);
		expect(f.getModel).toHaveBeenCalledWith("custom", "provider/model");
		const [model, context, options] = f.completeSimple.mock.calls[0];
		expect(model).toBe(f.model);
		expect(options.reasoning).toBe("high");
		expect(options.signal).toBeInstanceOf(AbortSignal);
		expect(context.tools.map((tool: any) => tool.name)).toEqual(["reply"]);
		expect(context.messages).toHaveLength(1);
		expect(context.messages[0].content).toContain("untrusted group history");
		expect(context.messages[0].content).not.toContain("leaseToken");
		const messages = f.completeSimple.mock.calls[1][1].messages;
		expect(messages.map((message: any) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(messages[2]).toMatchObject({ toolCallId: "call-0", toolName: "reply", isError: false });
		expect(messages[2].content[0].text).toContain('"staged":true');
	});
	it("collects dispatch and revision-bound work item updates without executing Bot work", async () => {
		const f = fixture();
		f.completeSimple.mockResolvedValueOnce(
			response([
				["dispatch", { botId: "bot", text: "Inspect the failure", workItemId: "work", executionMode: "code" }],
				["work_items", { workItemId: "work", revision: 3, status: "running", summary: "Assigned to executor" }],
			]),
		);
		expect(await f.run()).toEqual([
			{ type: "dispatch", botId: "bot", text: "Inspect the failure", workItemId: "work", executionMode: "code" },
			{ type: "work_item_update", workItemId: "work", revision: 3, status: "running", summary: "Assigned to executor" },
		]);
	});
	it("tracks ordered work item revisions in a private copy and returns nextRevision to the model", async () => {
		const f = fixture();
		f.completeSimple.mockResolvedValueOnce(
			response([
				["work_items", { workItemId: "work", revision: 3, status: "running" }],
				["work_items", { workItemId: "work", revision: 4, status: "running" }],
			]),
		);
		expect(await f.run()).toEqual([
			{ type: "work_item_update", workItemId: "work", revision: 3, status: "running" },
			{ type: "work_item_update", workItemId: "work", revision: 4, status: "running" },
		]);
		const results = f.completeSimple.mock.calls[1][1].messages.filter((message: any) => message.role === "toolResult");
		expect(results.map((result: any) => JSON.parse(result.content[0].text).nextRevision)).toEqual([4, 5]);
		expect(f.context.workItems[0]).toEqual({ id: "work", revision: 3, status: "open" });
	});
	it.each(["", "active", "/model", "provider/", " provider/model"])(
		"rejects unselected or malformed model %j before initializing auth",
		async (model) => {
			const f = fixture();
			f.job.config.model = model;
			await expect(f.run()).rejects.toThrow("explicit provider/model");
			expect(f.getModelRuntime).not.toHaveBeenCalled();
		},
	);
	it("does not borrow a default, Bot, or active model when a configured model is unknown", async () => {
		const f = fixture();
		f.getModel.mockReturnValue(undefined);
		await expect(f.run()).rejects.toThrow("model not found");
		expect(f.completeSimple).not.toHaveBeenCalled();
	});
	it("supports off thinking and rejects unknown thinking values", async () => {
		const f = fixture();
		f.job.config.thinkingLevel = "off";
		await f.run();
		expect(f.completeSimple.mock.calls[0][2]).not.toHaveProperty("reasoning");
		f.job.config.thinkingLevel = "invented";
		await expect(f.run()).rejects.toThrow("thinking level");
	});
	it.each([
		["bash", { command: "whoami" }, "disabled"],
		["dispatch", { botId: "outsider", text: "Do work" }, "group member"],
		["dispatch", { botId: "bot", text: "Do work", workItemId: "other" }, "not in router context"],
		["work_items", { workItemId: "work", revision: 2, status: "running" }, "revision conflict"],
		["reply", { text: "hello", command: "exec" }, "arguments"],
		["reply", { text: "   " }, "arguments"],
	] as const)("rejects invalid or unauthorized %s calls", async (name, args, error) => {
		const f = fixture();
		f.completeSimple.mockResolvedValueOnce(response([[name, args]]));
		await expect(f.run()).rejects.toThrow(error);
	});
	it("rejects disabled member Bots and tools even when a provider calls them", async () => {
		const f = fixture();
		f.context.members[0].enabled = false;
		f.completeSimple.mockResolvedValueOnce(response([["dispatch", { botId: "bot", text: "Do work" }]]));
		await expect(f.run()).rejects.toThrow("group member");
		f.job.config.tools = ["reply"];
		f.completeSimple.mockResolvedValueOnce(
			response([["work_items", { workItemId: "work", revision: 3, status: "running" }]]),
		);
		await expect(f.run()).rejects.toThrow("disabled");
	});
	it.each(["error", "aborted", "length", "deferred"])("discards a plan on provider %s", async (reason) => {
		const f = fixture();
		f.completeSimple
			.mockResolvedValueOnce(response([["reply", { text: "Partial plan" }]]))
			.mockResolvedValueOnce(response([], reason));
		await expect(f.run()).rejects.toThrow("completion failed");
	});
	it("bounds action count, action bytes, context bytes, and tool rounds", async () => {
		const f = fixture();
		f.completeSimple.mockResolvedValueOnce(response(Array.from({ length: 17 }, () => ["reply", { text: "hello" }])));
		await expect(f.run()).rejects.toThrow("16 actions");
		f.completeSimple.mockResolvedValueOnce(
			response(Array.from({ length: 5 }, () => ["reply", { text: "x".repeat(16_384) }])),
		);
		await expect(f.run()).rejects.toThrow("64KB");
		f.context.history = "x".repeat(262_145);
		await expect(f.run()).rejects.toThrow("256KB");
		f.context.history = [];
		f.completeSimple.mockResolvedValue(response([["reply", { text: "continue" }]]));
		await expect(f.run()).rejects.toThrow("round limit");
	});
	it("keeps concurrent transcripts isolated and snapshots config/context before host initialization", async () => {
		const f = fixture();
		let resolveRuntime!: (runtime: GroupRouterModelRuntime) => void;
		f.getModelRuntime.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveRuntime = resolve;
				}),
		);
		const first = f.run();
		f.context.history = [{ text: "second task only" }];
		f.job.config.model = "another/model";
		await f.run();
		resolveRuntime({ getModel: f.getModel, completeSimple: f.completeSimple } as any);
		await first;
		expect(f.getModel.mock.calls).toEqual([
			["another", "model"],
			["custom", "provider/model"],
		]);
		expect(f.completeSimple.mock.calls[0][1].messages).toHaveLength(1);
		expect(f.completeSimple.mock.calls[1][1].messages).toHaveLength(1);
		expect(f.completeSimple.mock.calls[1][1].messages[0].content).not.toContain("second task only");
	});
	it("rejects wrong-room context before model initialization", async () => {
		const f = fixture();
		f.context.room.id = "other";
		await expect(f.run()).rejects.toThrow("does not match");
		expect(f.getModelRuntime).not.toHaveBeenCalled();
	});
	it("returns a copy of an already frozen plan without contacting the model", async () => {
		const f = fixture();
		f.job.actions = [{ type: "reply", text: "Durable plan" }];
		const actions = await f.run();
		expect(actions).toEqual(f.job.actions);
		expect(actions).not.toBe(f.job.actions);
		expect(f.getModelRuntime).not.toHaveBeenCalled();
	});
	it("cancels a provider that ignores the signal and never publishes partial actions", async () => {
		const f = fixture();
		let late!: (value: any) => void;
		f.completeSimple.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					late = resolve;
				}),
		);
		const controller = new AbortController();
		const result = f.run(controller.signal);
		await Promise.resolve();
		controller.abort(new Error("closed"));
		await expect(result).rejects.toThrow("closed");
		late(response([["reply", { text: "Too late" }]]));
		await Promise.resolve();
		expect(f.completeSimple).toHaveBeenCalledOnce();
	});
	it("times out an unresponsive host without opening a second runtime", async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.getModelRuntime.mockImplementation(() => new Promise(() => {}));
		const runtime = createGroupRouterRuntime({ getModelRuntime: f.getModelRuntime, timeoutMs: 20 });
		const result = runtime.runGroupRouter({ job: f.job, context: f.context, signal: new AbortController().signal });
		const rejected = expect(result).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(20);
		await rejected;
		expect(f.getModelRuntime.mock.calls[0][0].aborted).toBe(true);
		expect(f.completeSimple).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
