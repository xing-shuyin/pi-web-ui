import { CanvasRuntimeError } from "./canvas-runtime-messages.js";
import type { CanvasEdge, CanvasGraph, CanvasNode } from "../protocol.js";

export class CanvasExecutionQueue {
	private active = 0;
	private waiters: Array<() => void> = [];
	constructor(private readonly limit: number) {}
	async acquire(signal: AbortSignal): Promise<() => void> {
		signal.throwIfAborted();
		if (this.active >= this.limit) {
			await new Promise<void>((resolve, reject) => {
				const wake = () => {
					signal.removeEventListener("abort", abort);
					resolve();
				};
				const abort = () => {
					this.waiters = this.waiters.filter((w) => w !== wake);
					reject(signal.reason);
				};
				signal.addEventListener("abort", abort, { once: true });
				this.waiters.push(wake);
			});
		} else this.active++;
		if (signal.aborted) {
			this.release();
			signal.throwIfAborted();
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.release();
		};
	}
	private release(): void {
		const next = this.waiters.shift();
		if (next) next();
		else this.active--;
	}
}

export function isCanvasBackedge(edge: CanvasEdge): boolean {
	return edge.type === "review" || edge.type === "reject" || edge.type === "loop_back" || edge.sourcePort === "reject";
}

export function canvasCondition(node: CanvasNode, graph: CanvasGraph): boolean {
	if (node.role === "ai_judge" || node.config?.aiJudge === true) {
		if (node.aiVerdict === undefined)
			throw new CanvasRuntimeError("AI judge returned no explicit decision", "error.judgeNoDecision");
		return node.aiVerdict;
	}
	const input =
		graph.edges
			.filter((e) => e.targetNodeId === node.id && e.active !== false)
			.map((e) => e.lastHandoffSummary ?? "")
			.join("\n") ||
		node.lastOutputSummary ||
		"";
	const tokens = String(node.config?.condition ?? "")
		.split(/[\s,，、/()]+/)
		.filter(Boolean);
	return tokens.length === 0 || tokens.some((token) => input.includes(token));
}

export function canvasReadiness(graph: CanvasGraph, node: CanvasNode): "ready" | "skip" | "wait" {
	const incoming = graph.edges.filter((e) => e.targetNodeId === node.id && !isCanvasBackedge(e));
	if (!incoming.length) return "ready";
	if (incoming.some((e) => e.active === undefined)) return "wait";
	return incoming.some((e) => e.active === true) ? "ready" : "skip";
}

export function validateCanvasTopology(graph: CanvasGraph): void {
	const ids = new Set(graph.nodes.map((n) => n.id));
	if (ids.size !== graph.nodes.length) throw new CanvasRuntimeError("Duplicate canvas node id", "error.duplicateNode");
	for (const edge of graph.edges)
		if (!ids.has(edge.sourceNodeId) || !ids.has(edge.targetNodeId))
			throw new CanvasRuntimeError("Canvas edge references a missing node", "error.missingEdgeNode");
	const visiting = new Set<string>(),
		visited = new Set<string>();
	const visit = (id: string) => {
		if (visiting.has(id))
			throw new CanvasRuntimeError("Canvas forward cycle requires an explicit rework edge", "error.reworkCycle");
		if (visited.has(id)) return;
		visiting.add(id);
		for (const edge of graph.edges) if (edge.sourceNodeId === id && !isCanvasBackedge(edge)) visit(edge.targetNodeId);
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of ids) visit(id);
}
