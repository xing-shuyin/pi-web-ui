import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isSubagentTerminal,
	makeSubagentTool,
	withSubagentOwner,
	type SubagentSnapshot,
	type SubagentToolHost,
} from "../../server/subagents.js";
import { testSettleWaiter } from "../helpers/subagent-settle.js";

function setup() {
	const snapshot = {
		convId: "child",
		parentId: "parent",
		type: "general",
		title: "Child",
		prompt: "Task",
		state: "done",
		streaming: false,
		taskPending: true,
		output: "Interim",
		messageCount: 1,
	} as SubagentSnapshot;
	const host: SubagentToolHost = {
		spawnSubagent: vi.fn(async () => "child"),
		getSubagent: () => snapshot,
		listSubagents: () => [snapshot],
		steerSubagent: vi.fn(async () => {}),
		stopSubagent: vi.fn(async () => {}),
		handoffSubagent: vi.fn(async () => {}),
		waitForSubagentSettle: testSettleWaiter(),
		listTemplates: () => [],
		isTemplateUsable: () => false,
		completeSubagent: vi.fn(() => ({ ok: true })),
		markSubagentsConsumed: vi.fn(),
		finalizeSubagentWorktree: vi.fn(async () => {}),
	};
	let selfId = "parent";
	const tool = makeSubagentTool(
		host,
		() => "en",
		() => selfId,
	);
	const call = (params: unknown, signal?: AbortSignal) =>
		tool.execute!("call", params as never, signal, undefined, { cwd: "." } as any);
	return {
		host,
		snapshot,
		call,
		setSelf: (id: string) => {
			selfId = id;
		},
	};
}

afterEach(() => vi.useRealTimers());

describe("conversation completion", () => {
	it("preserves completion registration through the owner wrapper", () => {
		const { host } = setup();
		const bound = withSubagentOwner(host, "original-owner", () => "remapped-owner");
		bound.completeSubagent!("remapped-child", "Done");
		expect(host.completeSubagent).toHaveBeenCalledWith("remapped-child", "Done");
	});

	it("registers intent using the current self identity and accepts message alias", async () => {
		const { host, call, setSelf } = setup();
		setSelf("remapped-child");
		const result = await call({ action: "complete", message: " Done " });
		expect(host.completeSubagent).toHaveBeenCalledWith("remapped-child", "Done", {});
		expect(result.details).toMatchObject({ status: "completion_requested" });
		expect(host.markSubagentsConsumed).not.toHaveBeenCalled();
	});

	it("rejects blank summaries, canceled requests and host rejections", async () => {
		const { host, call } = setup();
		await expect(call({ action: "complete", summary: " " })).rejects.toThrow("nonempty");
		const controller = new AbortController();
		controller.abort();
		await expect(call({ action: "complete", summary: "Done" }, controller.signal)).rejects.toThrow();
		expect(host.completeSubagent).not.toHaveBeenCalled();
		vi.mocked(host.completeSubagent!).mockReturnValue({ ok: false, error: "Not a task" });
		await expect(call({ action: "complete", summary: "Done" })).rejects.toThrow("Not a task");
	});

	it("does not consume or clean up an idle task waiting on dependencies", async () => {
		vi.useFakeTimers();
		const { host, snapshot, call } = setup();
		expect(isSubagentTerminal(snapshot)).toBe(false);
		await call({ action: "get_result", runId: "child" });
		const wait = call({ action: "wait_all", runIds: ["child"], timeoutSeconds: 1 });
		await vi.advanceTimersByTimeAsync(1000);
		await wait;
		expect(host.markSubagentsConsumed).not.toHaveBeenCalled();
		expect(host.finalizeSubagentWorktree).not.toHaveBeenCalled();
		snapshot.taskPending = false;
		await call({ action: "wait_all", runIds: ["child"] });
		expect(host.markSubagentsConsumed).toHaveBeenCalledWith(["child"]);
	});

	it.each([true, false, "manual"] as const)("passes spawn notification mode %s through unchanged", async (mode) => {
		const { host, call } = setup();
		const result = await call({ action: "spawn", prompt: "Task", notifyOnDone: mode });
		expect(vi.mocked(host.spawnSubagent).mock.calls[0][8]).toBe(mode);
		expect(result.details).toMatchObject({ notifyOnDone: mode });
	});

	it("recognizes idle failures even with stale pending state", () => {
		const { snapshot } = setup();
		expect(isSubagentTerminal({ ...snapshot, error: "failed" })).toBe(true);
		expect(isSubagentTerminal({ ...snapshot, canceled: true })).toBe(true);
		expect(isSubagentTerminal({ ...snapshot, streaming: true, error: "failed" })).toBe(false);
	});
});
