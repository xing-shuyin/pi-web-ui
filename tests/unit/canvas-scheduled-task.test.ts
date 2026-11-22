import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDefaultCanvasGraph,
	loadCanvasGraph,
	saveCanvasGraph,
	saveCanvasRuntimeState,
	deleteCanvasGraph,
} from "../../server/canvas/canvas-store.js";
import {
	executeScheduledCanvas,
	loadScheduledCanvas,
	validateScheduledCanvas,
} from "../../server/canvas/canvas-scheduled-task.js";
import { SchedulerStore, normalizeSchedulerInput } from "../../server/scheduler-tasks.js";
import { CanvasOrchestrator } from "../../server/canvas/canvas-orchestrator.js";

/** 真实定时器（fake timers 不推进真实 I/O）：等异步落盘真正完成。 */
const realSetTimeout = globalThis.setTimeout;
async function flushDisk(check: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => realSetTimeout(resolve, 1));
}

let dir: string;
beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "scheduled-canvas-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const task = () =>
	normalizeSchedulerInput({
		target: "canvas",
		graphId: "flow",
		name: "Daily flow",
		kind: "interval",
		spec: 60000,
		prompt: "requirements",
		cwd: dir,
	});
async function saveFlow() {
	const graph = createDefaultCanvasGraph("flow");
	graph.nodes = [graph.nodes[0]];
	graph.nodes[0].role = "transform";
	graph.nodes[0].config = { mode: "template", template: "processed {{input}}" };
	graph.edges = [];
	await saveCanvasGraph(dir, graph);
	return graph;
}

describe("scheduled canvas executor", () => {
	it("fires a due timer through the store and persists canvas run history", async () => {
		await saveFlow();
		vi.useFakeTimers();
		const orchestrator = new CanvasOrchestrator(dir, dir, () => {
			throw new Error("must not call a model");
		});
		const store = new SchedulerStore(dir, {
			executor: (scheduled) => executeScheduledCanvas(dir, orchestrator, scheduled),
			validateTask: (scheduled) => validateScheduledCanvas(dir, scheduled),
		});
		try {
			const scheduled = await store.upsert(task());
			store.start();
			await vi.advanceTimersByTimeAsync(60001);
			await flushDisk(() => !store.list().find((entry) => entry.id === scheduled.id)?.running);
			const result = store.list().find((entry) => entry.id === scheduled.id);
			expect(result?.lastRun).toMatchObject({ ok: true, graphId: "flow" });
			expect(result?.lastRun?.runId).toBeTruthy();
			expect(result?.lastRun?.manual).toBeUndefined();
		} finally {
			store.stop();
			vi.useRealTimers();
		}
	});
	it("runs a persisted deterministic workflow without model calls and records its run identity", async () => {
		await saveFlow();
		const orchestrator = new CanvasOrchestrator(dir, dir, () => {
			throw new Error("must not call a model");
		});
		const result = await executeScheduledCanvas(dir, orchestrator, task());
		expect(result).toMatchObject({ ok: true, graphId: "flow" });
		expect(result.runId).toBeTruthy();
		expect(loadCanvasGraph(dir, "flow").status).toBe("completed");
	});
	it("validates references without recreating deleted default graphs or accepting path traversal", async () => {
		expect(() => loadScheduledCanvas(dir, "default")).toThrow("not found");
		expect(() => loadScheduledCanvas(dir, "../flow")).toThrow("Invalid");
		expect(() => validateScheduledCanvas(dir, task())).toThrow("not found");
	});
	it("reports approval pauses and forwards the saved prompt and project root", async () => {
		await saveFlow();
		const runAll = vi.fn(async (graph) => {
			graph.run = { id: "approval-run", graphRev: graph.rev ?? 0, startedAt: 1, scope: "all" };
			graph.status = "waiting_approval";
			await saveCanvasRuntimeState(dir, graph);
		});
		const result = await executeScheduledCanvas(dir, { runAll }, task());
		// 第 4 个参数是 run 级材料（材料规格契约 §3）；本用例没配材料 → undefined
		expect(runAll).toHaveBeenCalledWith(expect.objectContaining({ id: "flow" }), "requirements", dir, undefined);
		expect(result).toMatchObject({
			ok: false,
			graphId: "flow",
			runId: "approval-run",
			error: "Canvas run waiting_approval",
		});
	});
	it("records deletion during execution as failure rather than resurrecting the graph", async () => {
		await saveFlow();
		const result = await executeScheduledCanvas(
			dir,
			{
				runAll: async (graph) => {
					graph.run = { id: "deleted-run", graphRev: 0, startedAt: 1, scope: "all" };
					deleteCanvasGraph(dir, graph.id);
				},
			},
			task(),
		);
		expect(result).toMatchObject({ ok: false, graphId: "flow", runId: "deleted-run" });
		expect(result.error).toContain("not found");
	});
	it("propagates the orchestrator overlap refusal without claiming an existing run", async () => {
		await saveFlow();
		const result = await executeScheduledCanvas(
			dir,
			{
				runAll: async () => {
					throw new Error("Canvas graph already running");
				},
			},
			task(),
		);
		expect(result).toMatchObject({ ok: false, error: "Canvas graph already running" });
		expect(result.runId).toBeUndefined();
	});
});
