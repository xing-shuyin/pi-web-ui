import { describe, expect, it, vi } from "vitest";
import { openGroupEventStream, acceptTaskProgress, taskProgressMatches } from "../../web/src/group-event-stream";

describe("group event stream", () => {
	it("syncs on reconnect, parses only public progress, suppresses late events after hide/dispose", () => {
		const listeners = new Map<string, (event: any) => void>();
		const source: any = { close: vi.fn(), addEventListener: (name: string, fn: any) => listeners.set(name, fn) };
		let visible = true;
		const callbacks = { alive: () => visible, sync: vi.fn(), connected: vi.fn(), progress: vi.fn() };
		const dispose = openGroupEventStream("/events", callbacks, () => source);
		source.onopen();
		source.onerror();
		source.onopen();
		listeners.get("invalidate")!({});
		expect(callbacks.sync).toHaveBeenCalledTimes(4);
		expect(callbacks.connected.mock.calls).toEqual([[true], [false], [true]]);
		const value = {
			taskId: "t",
			botId: "b",
			attemptId: "a",
			sequence: 1,
			phase: "tool",
			toolName: "read",
			text: "Reading",
			params: { secret: "hidden" },
		};
		listeners.get("progress")!({ data: JSON.stringify(value) });
		expect(callbacks.progress).toHaveBeenCalledTimes(1);
		expect(callbacks.progress.mock.calls[0][0]).not.toHaveProperty("params");
		listeners.get("progress")!({ data: JSON.stringify({ ...value, text: "文".repeat(1000) }) });
		expect(callbacks.progress).toHaveBeenCalledTimes(1);
		visible = false;
		source.onopen();
		listeners.get("invalidate")!({});
		expect(callbacks.sync).toHaveBeenCalledTimes(4);
		dispose();
		visible = true;
		source.onopen();
		source.onerror();
		listeners.get("progress")!({ data: JSON.stringify(value) });
		expect(source.close).toHaveBeenCalledTimes(1);
		expect(callbacks.sync).toHaveBeenCalledTimes(4);
		expect(callbacks.progress).toHaveBeenCalledTimes(1);
	});
	it("requires authoritative attempt identity and increasing sequence", () => {
		const progress = { taskId: "t", botId: "b", attemptId: "new", sequence: 2, phase: "model" as const };
		const task = { id: "t", botId: "b", attemptId: "new", status: "running" };
		expect(taskProgressMatches(task, progress)).toBe(true);
		for (const change of [{ attemptId: "old" }, { status: "completed" }, { botId: "other" }, { attemptId: undefined }])
			expect(taskProgressMatches({ ...task, ...change }, progress)).toBe(false);
		expect(acceptTaskProgress(progress, { ...progress, sequence: 1 })).toBe(false);
		expect(acceptTaskProgress(progress, progress)).toBe(false);
		expect(acceptTaskProgress(progress, { ...progress, sequence: 3 })).toBe(true);
	});
});
