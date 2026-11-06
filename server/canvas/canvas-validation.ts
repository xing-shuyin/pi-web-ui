import { CanvasRuntimeError, isCanvasMessage } from "./canvas-runtime-messages.js";
import type { CanvasGraph } from "../protocol.js";
import { isSafeGraphId } from "./canvas-store.js";

const roles = new Set([
	"architect",
	"coder",
	"reviewer",
	"tester",
	"devops",
	"custom",
	"trigger",
	"planner",
	"researcher",
	"writer",
	"analyst",
	"condition",
	"ai_judge",
	"loop",
	"human",
	"knowledge",
	"tool",
	"code",
	"api",
	"merge",
	"memory",
	"evaluator",
	"end",
	"subflow",
	"cron",
	"webhook",
	"transform",
	"pstack",
	"skill",
]);
const engines = new Set(["pi", "dsh", "codex", "claude", "durable"]);
const edges = new Set([
	"handoff",
	"review",
	"parallel",
	"condition_true",
	"condition_false",
	"loop_back",
	"approve",
	"reject",
]);
const states = new Set([
	"idle",
	"queued",
	"running",
	"waiting_approval",
	"done",
	"error",
	"paused",
	"skipped",
	"cancelled",
]);

export function assertCanvasGraph(value: unknown): asserts value is CanvasGraph {
	if (!value || typeof value !== "object") throw new CanvasRuntimeError("Invalid canvas graph", "error.invalidGraph");
	const g = value as CanvasGraph;
	if (!isSafeGraphId(g.id) || typeof g.name !== "string" || g.name.length > 300)
		throw new CanvasRuntimeError("Invalid canvas id or name", "error.invalidGraphIdentity");
	if (!Array.isArray(g.nodes) || !Array.isArray(g.edges) || g.nodes.length > 200 || g.edges.length > 1000)
		throw new CanvasRuntimeError("Canvas supports up to 200 nodes and 1000 edges", "error.graphSize");
	if (!g.viewport || ![g.viewport.x, g.viewport.y, g.viewport.zoom].every(Number.isFinite) || g.viewport.zoom <= 0)
		throw new CanvasRuntimeError("Invalid canvas viewport", "error.invalidViewport");
	const ids = new Set<string>();
	for (const n of g.nodes) {
		if (!n || !isSafeGraphId(n.id) || ids.has(n.id))
			throw new CanvasRuntimeError("Invalid or duplicate canvas node id", "error.duplicateNodeId");
		ids.add(n.id);
		if (typeof n.title !== "string" || !roles.has(n.role) || !engines.has(n.engine) || !states.has(n.status))
			throw new CanvasRuntimeError(`Invalid node ${n.id}`, "error.invalidNode", { id: n.id });
		if (
			typeof n.cwd !== "string" ||
			typeof n.model !== "string" ||
			typeof n.useWorktree !== "boolean" ||
			![n.x, n.y].every(Number.isFinite)
		)
			throw new CanvasRuntimeError(`Invalid node configuration: ${n.id}`, "error.invalidNodeConfig", { id: n.id });
		if (
			n.config &&
			(typeof n.config !== "object" ||
				Array.isArray(n.config) ||
				Object.values(n.config).some((v) => v !== undefined && !["string", "number", "boolean"].includes(typeof v)))
		)
			throw new CanvasRuntimeError(`Invalid node parameters: ${n.id}`, "error.invalidNodeParams", { id: n.id });
		for (const key of ["instruction", "systemPromptOverride"] as const)
			if (n[key] !== undefined && typeof n[key] !== "string")
				throw new CanvasRuntimeError(`Invalid node instruction: ${n.id}`, "error.invalidNodeInstruction", { id: n.id });
		for (const key of ["currentActionMessage", "errorMessage"] as const)
			if (n[key] !== undefined && !isCanvasMessage(n[key]))
				throw new CanvasRuntimeError(`Invalid node message metadata: ${n.id}`, "error.invalidNodeParams", { id: n.id });
	}
	const edgeIds = new Set<string>();
	const connections = new Set<string>();
	const forward = new Map(g.nodes.map((node) => [node.id, [] as string[]]));
	const indegree = new Map(g.nodes.map((node) => [node.id, 0]));
	for (const e of g.edges) {
		if (
			!e ||
			!isSafeGraphId(e.id) ||
			edgeIds.has(e.id) ||
			!ids.has(e.sourceNodeId) ||
			!ids.has(e.targetNodeId) ||
			e.sourceNodeId === e.targetNodeId ||
			!edges.has(e.type)
		)
			throw new CanvasRuntimeError("Invalid or duplicate canvas edge", "error.invalidEdge");
		edgeIds.add(e.id);
		const connection = JSON.stringify([
			e.sourceNodeId,
			e.targetNodeId,
			e.type,
			e.sourcePort ?? "result",
			e.targetPort ?? "contract",
		]);
		if (connections.has(connection))
			throw new CanvasRuntimeError("Duplicate canvas connection", "error.duplicateConnection");
		connections.add(connection);
		if (!["reject", "review", "loop_back"].includes(e.type)) {
			forward.get(e.sourceNodeId)!.push(e.targetNodeId);
			indegree.set(e.targetNodeId, indegree.get(e.targetNodeId)! + 1);
		}
		if (
			e.maxLoopRetries !== undefined &&
			(!Number.isInteger(e.maxLoopRetries) || e.maxLoopRetries < 0 || e.maxLoopRetries > 20)
		)
			throw new CanvasRuntimeError("Loop retry limit must be between 0 and 20", "error.loopLimit");
	}
	const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
	let visited = 0;
	for (let index = 0; index < queue.length; index++) {
		visited++;
		for (const next of forward.get(queue[index])!) {
			indegree.set(next, indegree.get(next)! - 1);
			if (indegree.get(next) === 0) queue.push(next);
		}
	}
	if (visited !== g.nodes.length)
		throw new CanvasRuntimeError(
			"Canvas forward edges contain a cycle; use an explicit bounded reject/review edge",
			"error.forwardCycle",
		);
}
