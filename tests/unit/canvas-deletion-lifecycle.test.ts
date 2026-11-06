import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanvasOrchestrator } from "../../server/canvas/canvas-orchestrator.js";
import * as workspace from "../../server/canvas/canvas-workspace.js";
import { handleCanvasMessage } from "../../server/canvas/canvas-dispatch.js";
import { makeCanvasTool, setCanvasRuntime } from "../../server/canvas/canvas-agent-tool.js";
import {
	createDefaultCanvasGraph,
	loadCanvasGraph,
	saveCanvasGraph,
	saveCanvasRuntimeState,
} from "../../server/canvas/canvas-store.js";
import type { ServerMessage } from "../../server/protocol.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("canvas deletion lifecycle", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "canvas-delete-"));
	});
	afterEach(() => {
		vi.restoreAllMocks();
		setCanvasRuntime(null);
		rmSync(dir, { recursive: true, force: true });
	});

	it("duplicate run_node with a freshly loaded graph preserves downstream dispatch", async () => {
		const entered = deferred();
		const release = deferred();
		const graph = createDefaultCanvasGraph("duplicate");
		graph.nodes = graph.nodes.slice(0, 2).map((node) => ({ ...node, role: "end", cwd: dir, useWorktree: false }));
		graph.edges = [{ id: "edge", sourceNodeId: graph.nodes[0].id, targetNodeId: graph.nodes[1].id, type: "handoff" }];
		saveCanvasGraph(dir, graph);
		const runtime = new CanvasOrchestrator(dir, dir);
		const originalPrepare = workspace.prepareCanvasWorkspace;
		vi.spyOn(workspace, "prepareCanvasWorkspace").mockImplementationOnce(async (options) => {
			entered.resolve();
			await release.promise;
			return originalPrepare(options);
		});
		const starts: string[] = [];
		runtime.setBroadcaster((event) => {
			if (event.type === "canvas_node_event" && event.event === "started") starts.push(event.nodeId);
		});
		const first = runtime.runNode(graph, graph.nodes[0].id);
		await entered.promise;
		await expect(runtime.runNode(loadCanvasGraph(dir, graph.id), graph.nodes[0].id)).rejects.toThrow("already running");
		expect((runtime as any).runningGraphs.get(graph.id)).toBe(graph);
		release.resolve();
		await first;
		expect(starts).toEqual(graph.nodes.map((node) => node.id));
		while ((runtime as any).activeExecutions.size) await new Promise((resolve) => setTimeout(resolve, 5));
	});

	it("runtime updates cannot create missing graphs", () => {
		const graph = createDefaultCanvasGraph("missing");
		saveCanvasRuntimeState(dir, graph);
		expect(existsSync(join(dir, "canvas", "missing.json"))).toBe(false);
	});

	it.each(["ws", "tool"] as const)(
		"%s deletion fences late real prompt completion and downstream dispatch",
		async (entry) => {
			const entered = deferred();
			const release = deferred();
			const abort = vi.fn(async () => {});
			const prompt = vi.fn(async () => {
				entered.resolve();
				await release.promise;
			});
			const detach = vi.fn();
			const graph = createDefaultCanvasGraph("late");
			graph.nodes = graph.nodes
				.slice(0, 2)
				.map((node) => ({ ...node, role: "coder", engine: "pi", cwd: dir, useWorktree: false }));
			graph.edges = [{ id: "edge", sourceNodeId: graph.nodes[0].id, targetNodeId: graph.nodes[1].id, type: "handoff" }];
			graph.executionMode = "real";
			saveCanvasGraph(dir, graph);
			const runtime = new CanvasOrchestrator(dir, dir, () => ({
				attach: async () => ({ cwd: dir, prompt, abort, switchModelOrThrow: async () => {} }),
				detach,
			}));
			const events: ServerMessage[] = [];
			runtime.setBroadcaster((event) => events.push(event));
			const running = runtime.runNode(graph, graph.nodes[0].id);
			await entered.promise;
			if (entry === "ws") handleCanvasMessage({ type: "canvas_delete", id: graph.id }, dir, runtime, () => {});
			else {
				setCanvasRuntime(runtime);
				await makeCanvasTool({ dataDir: dir, lang: () => "en" }).execute(
					"delete",
					{ action: "delete_graph", graphId: graph.id },
					undefined,
					undefined,
					{} as any,
				);
			}
			const eventCount = events.length;
			release.resolve();
			await running;
			expect(abort).toHaveBeenCalledOnce();
			expect(detach).toHaveBeenCalledOnce();
			expect(prompt).toHaveBeenCalledOnce();
			expect(events).toHaveLength(eventCount);
			expect(existsSync(join(dir, "canvas", "late.json"))).toBe(false);
			expect((runtime as any).runningGraphs.size).toBe(0);
			expect((runtime as any).activeExecutions.size).toBe(0);
		},
	);

	it.each([false, true])(
		"single-node completion preserves edges and fences synchronous delete/recreate (%s)",
		async (recreate) => {
			const graph = createDefaultCanvasGraph("reentrant");
			graph.nodes = graph.nodes.slice(0, 2).map((node) => ({ ...node, role: "end", cwd: dir, useWorktree: false }));
			graph.edges = [{ id: "edge", sourceNodeId: graph.nodes[0].id, targetNodeId: graph.nodes[1].id, type: "handoff" }];
			saveCanvasGraph(dir, graph);
			const runtime = new CanvasOrchestrator(dir, dir);
			const starts: string[] = [];
			runtime.setBroadcaster((event) => {
				if (event.type !== "canvas_node_event") return;
				if (event.event === "started") starts.push(event.nodeId);
				if (recreate && event.event === "done" && event.nodeId === graph.nodes[0].id) {
					runtime.deleteGraph(graph.id);
					saveCanvasGraph(dir, graph);
					(runtime as any).runningGraphs.set(graph.id, graph);
				}
			});
			await runtime.runNode(graph, graph.nodes[0].id);
			expect(starts).toEqual(recreate ? [graph.nodes[0].id] : graph.nodes.map((node) => node.id));
			while ((runtime as any).activeExecutions.size) await new Promise((resolve) => setTimeout(resolve, 5));
		},
	);

	it("late attach after deletion never prompts or binds the cancelled session", async () => {
		const entered = deferred();
		const release = deferred();
		const prompt = vi.fn();
		const detach = vi.fn();
		const graph = createDefaultCanvasGraph("attach");
		graph.nodes = [{ ...graph.nodes[0], role: "coder", engine: "pi", cwd: dir, useWorktree: false }];
		graph.executionMode = "real";
		saveCanvasGraph(dir, graph);
		const runtime = new CanvasOrchestrator(dir, dir, () => ({
			attach: async () => {
				entered.resolve();
				await release.promise;
				return { cwd: dir, prompt };
			},
			detach,
		}));
		const running = runtime.runNode(graph, graph.nodes[0].id);
		await entered.promise;
		runtime.deleteGraph(graph.id);
		release.resolve();
		await running;
		expect(prompt).not.toHaveBeenCalled();
		expect(detach).toHaveBeenCalledOnce();
		expect(existsSync(join(dir, "canvas", "attach.json"))).toBe(false);
	});

	it("a cancelled completion cannot remove a restarted node execution", async () => {
		const firstEntered = deferred();
		const firstRelease = deferred();
		const secondEntered = deferred();
		const secondRelease = deferred();
		let attempt = 0;
		const graph = createDefaultCanvasGraph("restart");
		graph.nodes = [{ ...graph.nodes[0], role: "coder", engine: "pi", cwd: dir, useWorktree: false }];
		graph.executionMode = "real";
		saveCanvasGraph(dir, graph);
		const runtime = new CanvasOrchestrator(dir, dir, () => ({
			attach: async () => {
				const index = attempt++;
				return {
					cwd: dir,
					abort: async () => {},
					switchModelOrThrow: async () => {},
					prompt: async () => {
						(index === 0 ? firstEntered : secondEntered).resolve();
						await (index === 0 ? firstRelease : secondRelease).promise;
					},
				};
			},
			detach: () => {},
		}));
		const first = runtime.runNode(graph, graph.nodes[0].id);
		await firstEntered.promise;
		runtime.stopNode(graph.id, graph.nodes[0].id);
		const second = runtime.runNode(graph, graph.nodes[0].id);
		const execution = (runtime as any).activeExecutions.get(`${graph.id}:${graph.nodes[0].id}`);
		firstRelease.resolve();
		await first;
		await secondEntered.promise;
		expect((runtime as any).activeExecutions.get(`${graph.id}:${graph.nodes[0].id}`)).toBe(execution);
		runtime.deleteGraph(graph.id);
		secondRelease.resolve();
		await second;
	});
});
