import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDefaultCanvasGraph,
	saveCanvasGraph,
	loadCanvasGraph,
	saveCanvasRuntimeState,
	markInterruptedCanvasRuns,
} from "../../server/canvas/canvas-store.js";
import { handleCanvasMessage } from "../../server/canvas/canvas-dispatch.js";
import { assertCanvasGraph } from "../../server/canvas/canvas-validation.js";
import type { ServerMessage } from "../../server/protocol.js";
const dirs: string[] = [];
const temp = () => {
	const d = mkdtempSync(join(tmpdir(), "canvas-persistence-"));
	dirs.push(d);
	return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
describe("Canvas persistence and acknowledged saves", () => {
	it("rejects a stale topology without losing authoritative execution state", async () => {
		const dir = temp();
		const graph = createDefaultCanvasGraph("race");
		await saveCanvasGraph(dir, graph);
		const first = loadCanvasGraph(dir, graph.id);
		const stale = structuredClone(first);
		graph.status = "running";
		graph.nodes[0].status = "running";
		graph.nodes[0].error = "previous error";
		graph.run = { id: "run-1", graphRev: graph.rev!, startedAt: 1, scope: "all" };
		graph.edges[0].lastHandoffSummary = "complete contract";
		graph.edges[0].currentLoopCount = 2;
		await saveCanvasRuntimeState(dir, graph);
		first.name = "renamed";
		expect((await saveCanvasGraph(dir, first, { expectedRev: first.rev })).conflict).toBe(false);
		const saved = loadCanvasGraph(dir, graph.id);
		expect(saved.nodes[0].status).toBe("running");
		expect(saved.run?.id).toBe("run-1");
		expect(saved.edges[0].lastHandoffSummary).toBe("complete contract");
		expect(saved.edges[0].currentLoopCount).toBe(2);
		expect((await saveCanvasGraph(dir, stale, { expectedRev: stale.rev })).conflict).toBe(true);
		expect(loadCanvasGraph(dir, graph.id).name).toBe("renamed");
	});
	it("acknowledges only accepted versions and identifies load responses", async () => {
		const dir = temp();
		const graph = createDefaultCanvasGraph("ack");
		await saveCanvasGraph(dir, graph);
		const messages: ServerMessage[] = [];
		const send = (m: ServerMessage) => messages.push(m);
		handleCanvasMessage({ type: "canvas_load", id: graph.id, requestId: "load-1" }, dir, {} as any, send);
		expect(messages[0]).toMatchObject({ type: "canvas_graph_state", requestId: "load-1" });
		handleCanvasMessage(
			{ type: "canvas_save", graph: structuredClone(graph), baseRev: 0, requestId: "stale-1" },
			dir,
			{} as any,
			send,
		);
		// 保存落盘已异步（#966）：等这一笔的回应落地再断言
		await vi.waitFor(() => expect(messages.some((m) => "requestId" in m && m.requestId === "stale-1")).toBe(true));
		expect(messages).toContainEqual(
			expect.objectContaining({ type: "canvas_error", code: "rev_conflict", requestId: "stale-1" }),
		);
		messages.length = 0;
		handleCanvasMessage({ type: "canvas_save", graph, baseRev: graph.rev, requestId: "save-1" }, dir, {} as any, send);
		await vi.waitFor(() => expect(messages.some((m) => "requestId" in m && m.requestId === "save-1")).toBe(true));
		expect(messages[0]).toMatchObject({ type: "canvas_graph_state", requestId: "save-1", graph: { rev: 2 } });
	});
	it("recovers interrupted tasks once without erasing review gates", async () => {
		const dir = temp();
		const graph = createDefaultCanvasGraph("recover");
		graph.status = "running";
		graph.nodes[0].status = "running";
		graph.nodes[1].status = "waiting_approval";
		graph.run = { id: "run", graphRev: 1, startedAt: 1, scope: "all" };
		await saveCanvasGraph(dir, graph);
		await markInterruptedCanvasRuns(dir);
		const loaded = loadCanvasGraph(dir, graph.id);
		expect(loaded.status).toBe("paused");
		expect(loaded.nodes[0].status).toBe("paused");
		expect(loaded.nodes[1].status).toBe("waiting_approval");
		expect(loaded.run?.error).toContain("interrupted");
	});
	it("rejects malformed graph nodes before persistence", () => {
		const graph = createDefaultCanvasGraph("invalid");
		graph.nodes.push({ ...graph.nodes[0] });
		expect(() => assertCanvasGraph(graph)).toThrow("duplicate");
		graph.nodes.pop();
		(graph.nodes[0] as any).title = {};
		expect(() => assertCanvasGraph(graph)).toThrow("Invalid node");
	});
});
