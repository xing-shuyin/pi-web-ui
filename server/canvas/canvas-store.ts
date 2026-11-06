/**
 * canvas-store.ts — 画布协作工程持久化与模板管理器。
 *
 * 画布工程存放在 <dataDir>/canvas/<graphId>.json 中。
 * 提供画布的增删改查、列表摘要、以及内置开箱即用模板。
 */
import { CanvasRuntimeError, canvasRuntimeMessage } from "./canvas-runtime-messages.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicSync } from "../atomic-file.js";
import type { CanvasGraph, CanvasGraphSummary } from "../protocol.js";

export function createDefaultCanvasGraph(id = "default"): CanvasGraph {
	const now = Date.now();
	return {
		id,
		name: "Develop · Test · Human acceptance",
		viewport: { x: 50, y: 50, zoom: 1 },
		status: "idle",
		createdAt: now,
		updatedAt: now,
		nodes: [
			{
				id: "node_architect",
				title: "Requirements and acceptance criteria",
				role: "trigger",
				x: 80,
				y: 180,
				width: 300,
				engine: "pi",
				model: "",
				cwd: ".",
				useWorktree: false,
				config: { payload: "Enter the task objective, scope, and acceptance criteria before running the workflow." },
				instruction: "Pass the task objective and acceptance criteria to the next node.",
				status: "idle",
			},
			{
				id: "node_fe",
				title: "Implementation engineer",
				role: "coder",
				x: 480,
				y: 60,
				width: 300,
				engine: "pi",
				model: "",
				cwd: ".",
				useWorktree: false,
				systemPromptOverride:
					"Make the smallest necessary changes to satisfy the task and acceptance criteria. Check existing conventions and report files, verification commands, and results.",
				instruction:
					"Complete the upstream task {{upstream}} and deliver a verifiable implementation with complete evidence.",
				status: "idle",
			},
			{
				id: "node_be",
				title: "Testing and code review",
				role: "tester",
				x: 880,
				y: 180,
				width: 300,
				engine: "pi",
				model: "",
				cwd: ".",
				useWorktree: false,
				systemPromptOverride:
					"Review the implementation and run relevant checks. Record passing, failing, and unverified items explicitly. Never fabricate test results.",
				instruction:
					"Verify upstream deliverables {{upstream}} and provide commands, results, and remaining risks for human acceptance.",
				status: "idle",
			},
			{
				id: "node_qa",
				title: "Human acceptance",
				role: "human",
				x: 1280,
				y: 180,
				width: 300,
				engine: "pi",
				model: "",
				cwd: ".",
				useWorktree: false,
				instruction:
					"Check the implementation and test evidence. Approve completion or adjust the workflow and run it again.",
				status: "idle",
			},
		],
		edges: [
			{
				id: "edge_arch_to_fe",
				sourceNodeId: "node_architect",
				targetNodeId: "node_fe",
				type: "handoff",
				label: "Task and acceptance criteria",
			},
			{
				id: "edge_fe_to_be",
				sourceNodeId: "node_fe",
				targetNodeId: "node_be",
				type: "handoff",
				label: "Implementation and verification evidence",
			},
			{
				id: "edge_be_to_qa",
				sourceNodeId: "node_be",
				targetNodeId: "node_qa",
				type: "handoff",
				label: "Check results and deliverables for acceptance",
			},
		],
	};
}

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isSafeGraphId(id: unknown): id is string {
	return typeof id === "string" && SAFE_ID_RE.test(id);
}

function assertSafeGraphId(id: string): void {
	if (!isSafeGraphId(id))
		throw new CanvasRuntimeError(`Invalid canvas graph id: ${JSON.stringify(id)}`, "error.invalidGraphId", {
			id: JSON.stringify(id),
		});
}

function ensureCanvasDir(dataDir: string): string {
	const dir = join(dataDir, "canvas");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

export function listCanvasGraphs(dataDir: string): CanvasGraphSummary[] {
	const dir = ensureCanvasDir(dataDir);
	const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	if (files.length === 0) {
		const def = createDefaultCanvasGraph();
		saveCanvasGraph(dataDir, def);
		return [
			{
				id: def.id,
				name: def.name,
				nodeCount: def.nodes.length,
				edgeCount: def.edges.length,
				updatedAt: def.updatedAt,
			},
		];
	}

	const list: CanvasGraphSummary[] = [];
	for (const f of files) {
		try {
			const full = join(dir, f);
			const content = JSON.parse(readFileSync(full, "utf8")) as CanvasGraph;
			if (content && content.id) {
				list.push({
					id: content.id,
					name: content.name || content.id,
					nodeCount: content.nodes?.length ?? 0,
					edgeCount: content.edges?.length ?? 0,
					updatedAt: content.updatedAt ?? Date.now(),
				});
			}
		} catch {}
	}
	return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadCanvasGraph(dataDir: string, id: string): CanvasGraph {
	assertSafeGraphId(id);
	const dir = ensureCanvasDir(dataDir);
	const path = join(dir, `${id}.json`);
	if (!existsSync(path)) {
		if (id === "default") {
			const def = createDefaultCanvasGraph(id);
			saveCanvasGraph(dataDir, def);
			return def;
		}
		throw new CanvasRuntimeError(`Canvas graph not found: ${id}`, "error.graphNotFound", { id });
	}
	return JSON.parse(readFileSync(path, "utf8")) as CanvasGraph;
}

export function saveCanvasGraph(
	dataDir: string,
	graph: CanvasGraph,
	opts?: { expectedRev?: number },
): { conflict: boolean; graph: CanvasGraph } {
	assertSafeGraphId(graph.id);
	const dir = ensureCanvasDir(dataDir);
	const path = join(dir, `${graph.id}.json`);
	let diskRev = 0;
	let disk: CanvasGraph | undefined;
	if (existsSync(path)) {
		try {
			disk = JSON.parse(readFileSync(path, "utf8")) as CanvasGraph;
			diskRev = disk.rev ?? 0;
		} catch {
			diskRev = 0;
		}
	}
	if (opts?.expectedRev !== undefined && opts.expectedRev !== diskRev) {
		return { conflict: true, graph: disk ?? graph };
	}
	if (disk) {
		graph.status = disk.status;
		graph.run = disk.run;
		const existingNodes = new Map(disk.nodes.map((node) => [node.id, node]));
		for (const node of graph.nodes) {
			const prior = existingNodes.get(node.id);
			if (!prior) continue;
			for (const field of RUNTIME_FIELDS) (node as unknown as Record<string, unknown>)[field] = prior[field];
		}
		const existingEdges = new Map(disk.edges.map((edge) => [edge.id, edge]));
		for (const edge of graph.edges) {
			const prior = existingEdges.get(edge.id);
			if (!prior) continue;
			for (const field of ["lastHandoffSummary", "currentLoopCount", "runId", "active"] as const)
				(edge as unknown as Record<string, unknown>)[field] = prior[field];
		}
	}
	graph.rev = diskRev + 1;
	graph.updatedAt = Date.now();
	writeJsonAtomicSync(path, graph);
	return { conflict: false, graph };
}

const RUNTIME_FIELDS = [
	"status",
	"currentAction",
	"currentActionMessage",
	"errorMessage",
	"lastOutputSummary",
	"error",
	"aiVerdict",
	"runId",
	"attempt",
	"artifact",
	"actualEngine",
	"actualModel",
] as const;

export function saveCanvasRuntimeState(dataDir: string, runtime: CanvasGraph): void {
	assertSafeGraphId(runtime.id);
	const dir = ensureCanvasDir(dataDir);
	const path = join(dir, `${runtime.id}.json`);
	if (!existsSync(path)) return;
	let disk: CanvasGraph;
	try {
		disk = JSON.parse(readFileSync(path, "utf8")) as CanvasGraph;
	} catch {
		return;
	}
	const rt = new Map(runtime.nodes.map((n) => [n.id, n]));
	for (const n of disk.nodes) {
		const r = rt.get(n.id);
		if (!r) continue;
		for (const f of RUNTIME_FIELDS)
			(n as unknown as Record<string, unknown>)[f] = (r as unknown as Record<string, unknown>)[f];
	}
	const runtimeEdges = new Map(runtime.edges.map((e) => [e.id, e]));
	for (const edge of disk.edges) {
		const source = runtimeEdges.get(edge.id);
		if (!source) continue;
		for (const key of ["lastHandoffSummary", "currentLoopCount", "runId", "active"] as const) {
			(edge as unknown as Record<string, unknown>)[key] = source[key];
		}
	}
	disk.status = runtime.status;
	disk.run = runtime.run;
	disk.updatedAt = Date.now();
	writeJsonAtomicSync(path, disk);
	runtime.rev = disk.rev;
}

export function markInterruptedCanvasRuns(dataDir: string): void {
	const dir = ensureCanvasDir(dataDir);
	for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
		const path = join(dir, file);
		try {
			const graph = JSON.parse(readFileSync(path, "utf8")) as CanvasGraph;
			const interrupted =
				graph.status === "running" ||
				graph.nodes?.some((node) => node.status === "running" || node.status === "queued");
			if (!interrupted) continue;
			graph.status = "paused";
			if (graph.run) {
				graph.run.error = "Server restarted; the previous run was interrupted. Restart the run to continue.";
				graph.run.finishedAt = Date.now();
			}
			for (const node of graph.nodes)
				if (node.status === "running" || node.status === "queued") {
					node.status = "paused";
					node.currentAction = "Server restarted; run interrupted";
					node.currentActionMessage = canvasRuntimeMessage("action.interrupted");
				}
			writeJsonAtomicSync(path, graph);
		} catch (error) {
			console.error(`[canvas] Could not recover ${file}:`, error);
		}
	}
}

export function deleteCanvasGraph(dataDir: string, id: string): boolean {
	assertSafeGraphId(id);
	const dir = ensureCanvasDir(dataDir);
	const path = join(dir, `${id}.json`);
	if (existsSync(path)) {
		unlinkSync(path);
		return true;
	}
	return false;
}
