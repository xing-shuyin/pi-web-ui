import { describe, expect, it } from "vitest";
import {
	CanvasDraftState,
	graphFingerprint,
	graphRuntimeStatus,
	mergeGraphRuntime,
	nodeLogKey,
	parseGraphImport,
} from "../../web/src/components/canvas/canvas-state";
import type { CanvasGraph } from "../../server/protocol";
import { en, type Translate } from "../../web/src/i18n";
const translate: Translate = (key) => en[key];
const graph = (): CanvasGraph => ({
	id: "g",
	name: "Graph",
	rev: 3,
	createdAt: 1,
	updatedAt: 1,
	status: "idle",
	executionMode: "real",
	viewport: { x: 0, y: 0, zoom: 1 },
	nodes: [
		{
			id: "a",
			title: "A",
			role: "coder",
			engine: "pi",
			model: "model",
			cwd: ".",
			useWorktree: false,
			x: -100,
			y: 20,
			status: "idle",
		},
	],
	edges: [],
});
function setup() {
	const map = new Map<string, string>();
	return new CanvasDraftState({
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => {
			map.set(k, v);
		},
		removeItem: (k) => {
			map.delete(k);
		},
	});
}
describe("canvas studio draft state", () => {
	it("late ACK and error cannot clear a newer save after reconnect", () => {
		const state = setup(),
			g = graph();
		state.loaded(g);
		const old = { ...g, name: "old submission" };
		state.beginSave(old, "old");
		state.disconnected();
		expect(state.pendingSave).toBeNull();
		const remote = { ...old, rev: 4 };
		expect(state.reconcileSave(remote, old)).toBe("saved");
		state.loaded(remote);
		const latest = { ...remote, name: "new submission" };
		state.beginSave(latest, "new");
		expect(state.acceptSave(remote, "old")).toBe(false);
		expect(state.fail("old", "late error")).toBe(false);
		expect(state.pendingSave?.requestId).toBe("new");
		expect(state.dirty(latest)).toBe(true);
		expect(state.acceptSave({ ...latest, rev: 5 }, "new")).toBe(true);
		expect(state.dirty(latest)).toBe(false);
	});
	it.each([true, false])("reconciles lost ACK without leaving pending locked (committed=%s)", (committed) => {
		const state = setup(),
			g = graph();
		state.loaded(g);
		g.name = "submitted";
		state.beginSave(g, "lost");
		state.beginLoad(g.id, "old-load");
		state.disconnected();
		expect(state.pendingSave).toBeNull();
		expect(state.pendingLoad).toBeNull();
		expect(state.acceptSave(g, "lost")).toBe(false);
		const remote = { ...g, rev: 4, ...(!committed ? { name: "remote" } : {}) };
		expect(state.reconcileSave(remote, g)).toBe(committed ? "saved" : "conflict");
		expect(state.unknownSaves.size).toBe(0);
		expect(state.dirty(g)).toBe(!committed);
		if (!committed) expect(state.draft(g.id)?.name).toBe("submitted");
	});
	it("read-back preserves edits made after the lost submission and advances their base revision", () => {
		const state = setup(),
			g = graph();
		state.loaded(g);
		g.name = "submitted";
		state.beginSave(g, "lost");
		state.disconnected();
		const local = { ...g, name: "later" };
		const remote = { ...g, rev: 4 };
		expect(state.reconcileSave(remote, local)).toBe("saved");
		expect(state.dirty(local)).toBe(true);
		expect(state.draft(g.id)?.rev).toBe(4);
		expect(state.draft(g.id)?.name).toBe("later");
	});
	it("fingerprints ignore serialization key order", () => {
		const g = graph();
		expect(
			graphFingerprint({
				...g,
				name: g.name,
				nodes: g.nodes.map((n) => Object.fromEntries(Object.entries(n).reverse()) as any),
			}),
		).toBe(graphFingerprint(g));
	});
	it("only matching save ACK clears the submitted version; later edits survive", () => {
		const state = setup(),
			g = graph();
		state.loaded(g);
		g.name = "edited";
		const req = state.beginSave(g, "s1");
		expect(req.baseRev).toBe(3);
		expect(state.dirty(g)).toBe(true);
		expect(state.acceptSave(g, "old")).toBe(false);
		const newer = { ...g, name: "newer" };
		expect(state.acceptSave({ ...g, rev: 4 }, "s1")).toBe(true);
		expect(state.dirty(g)).toBe(false);
		expect(state.dirty(newer)).toBe(true);
	});
	it("conflict followed by state with same requestId cannot clear draft", () => {
		const state = setup(),
			g = graph();
		state.loaded(g);
		g.name = "draft";
		state.beginSave(g, "s");
		expect(state.fail("s", "conflict")).toBe(true);
		expect(state.acceptSave({ ...g, rev: 4 }, "s")).toBe(false);
		expect(state.dirty(g)).toBe(true);
		expect(state.draft(g.id)?.name).toBe("draft");
	});
	it("matches load graph and request identity, never unrelated broadcasts", () => {
		const state = setup(),
			g = graph();
		state.beginLoad("g", "l1");
		expect(state.acceptsLoad(g)).toBe(false);
		expect(state.acceptsLoad(g, "old")).toBe(false);
		expect(state.acceptsLoad({ ...g, id: "other" }, "l1")).toBe(false);
		expect(state.acceptsLoad(g, "l1")).toBe(true);
	});
	it("retains draft revision for conflict detection after switching", () => {
		const state = setup(),
			g = graph();
		state.retain(g);
		expect(state.draft("g")?.rev).toBe(3);
		state.loaded({ ...g, rev: 9 });
		expect(state.draft("g")?.rev).toBe(3);
	});
	it("runtime streams and run metadata never dirty authored state", () => {
		const g = graph(),
			remote = structuredClone(g);
		remote.rev = 8;
		remote.status = "waiting_approval";
		remote.run = { id: "run", graphRev: 3, startedAt: 3, scope: "all" };
		remote.nodes[0] = {
			...remote.nodes[0],
			status: "waiting_approval",
			runId: "run",
			error: "error",
			artifact: { runId: "run", attempt: 1, summary: "output", createdAt: 2 },
		};
		expect(graphFingerprint(g)).toBe(graphFingerprint(remote));
		const local = { ...g, name: "local edit" };
		const merged = mergeGraphRuntime(local, remote);
		expect(merged.name).toBe("local edit");
		expect(merged.nodes[0].artifact?.summary).toBe("output");
		expect(merged.status).toBe("waiting_approval");
	});
	it("isolates same node ID in different graphs", () => {
		expect(nodeLogKey("g1", "n")).not.toBe(nodeLogKey("g2", "n"));
	});
	it("derives terminal and approval graph states", () => {
		const n = graph().nodes[0];
		expect(graphRuntimeStatus([{ ...n, status: "waiting_approval" }])).toBe("waiting_approval");
		expect(graphRuntimeStatus([{ ...n, status: "skipped" }])).toBe("completed");
		expect(graphRuntimeStatus([{ ...n, status: "cancelled" }])).toBe("blocked");
	});
	it("reports local storage failures instead of discarding edits", () => {
		const state = new CanvasDraftState(
			{
				getItem: () => null,
				setItem: () => {
					throw Error("quota");
				},
				removeItem: () => {},
			},
			translate,
		);
		expect(state.retain(graph())).toBe(false);
		expect(state.error).toBe(en["canvas.draft.storageFailed"]);
	});
});
describe("canvas JSON import", () => {
	it("round trips 200 node user graphs without the AI proposal limit", () => {
		const g = graph();
		g.nodes = Array.from({ length: 200 }, (_, i) => ({ ...g.nodes[0], id: `n${i}` }));
		expect(parseGraphImport(JSON.stringify(g)).nodes).toHaveLength(200);
		g.nodes.push({ ...g.nodes[0], id: "overflow" });
		expect(() => parseGraphImport(JSON.stringify(g))).toThrow();
	});
	it("preserves supported unimplemented and loop roles in user imports", () => {
		const g = graph();
		g.nodes[0].role = "subflow";
		g.edges = [{ id: "loop", sourceNodeId: "a", targetNodeId: "a", type: "loop_back", maxLoopRetries: 2 }];
		expect(parseGraphImport(JSON.stringify(g)).edges[0].type).toBe("loop_back");
	});
	it.each(["id", "status", "run", "artifact"])("rejects invalid runtime or identity %s", (kind) => {
		const g = graph();
		if (kind === "id") g.id = "../escape";
		if (kind === "status") (g as any).status = "invented";
		if (kind === "run") (g as any).run = { id: "r" };
		if (kind === "artifact") (g.nodes[0] as any).artifact = { files: [1] };
		expect(() => parseGraphImport(JSON.stringify(g))).toThrow();
	});
	it("retains standalone nodes without inventing edges and resets execution", () => {
		const g = graph();
		g.nodes[0].status = "done";
		g.nodes[0].artifact = { runId: "r", attempt: 1, summary: "stale", createdAt: 1 };
		const result = parseGraphImport(JSON.stringify(g));
		expect(result.id).not.toBe(g.id);
		expect(result.edges).toEqual([]);
		expect(result.nodes[0].status).toBe("idle");
		expect(result.nodes[0].artifact).toBeUndefined();
	});
	it.each(["duplicate", "dangling", "position", "role", "unknown", "viewport"])(
		"rejects invalid %s without repairing silently",
		(kind) => {
			const g = graph();
			if (kind === "duplicate") g.nodes.push({ ...g.nodes[0] });
			if (kind === "dangling") g.edges.push({ id: "e", sourceNodeId: "a", targetNodeId: "missing", type: "handoff" });
			if (kind === "position") g.nodes[0].x = Infinity;
			if (kind === "role") (g.nodes[0] as any).role = "invented";
			if (kind === "unknown") (g as any).injected = true;
			if (kind === "viewport") g.viewport.zoom = 0;
			expect(() => parseGraphImport(JSON.stringify(g))).toThrow();
		},
	);
});
