import type { CanvasEdge, CanvasNode } from "../../types";
export type NodeHeights = ReadonlyMap<string, number> | Record<string, number>;
function nodeHeight(n: CanvasNode, heights?: NodeHeights): number {
	const h =
		heights &&
		("get" in heights && typeof heights.get === "function"
			? heights.get(n.id)
			: (heights as Record<string, number>)[n.id]);
	return typeof h === "number" && Number.isFinite(h) && h > 0 ? h : n.height && n.height > 0 ? n.height : 460;
}
export function computeCanvasBounds(nodes: CanvasNode[], heights?: NodeHeights) {
	if (!nodes.length) return { x: 0, y: 0, width: 1, height: 1 };
	const x = Math.min(...nodes.map((n) => n.x)),
		y = Math.min(...nodes.map((n) => n.y));
	return {
		x,
		y,
		width: Math.max(1, ...nodes.map((n) => n.x + (n.width ?? 300) - x)),
		height: Math.max(1, ...nodes.map((n) => n.y + nodeHeight(n, heights) - y)),
	};
}
export function computeMinimap(nodes: CanvasNode[], width = 160, height = 100, heights?: NodeHeights) {
	const bounds = computeCanvasBounds(nodes, heights);
	const padding = 8;
	const scale = Math.max(
		0,
		Math.min(Math.max(1, width - padding * 2) / bounds.width, Math.max(1, height - padding * 2) / bounds.height),
	);
	const offsetX = (width - bounds.width * scale) / 2 - bounds.x * scale,
		offsetY = (height - bounds.height * scale) / 2 - bounds.y * scale;
	return {
		bounds,
		scale,
		offsetX,
		offsetY,
		nodes: nodes.map((n) => ({
			id: n.id,
			x: n.x * scale + offsetX,
			y: n.y * scale + offsetY,
			width: (n.width ?? 300) * scale,
			height: nodeHeight(n, heights) * scale,
		})),
	};
}
export function fitCanvasViewport(
	nodes: CanvasNode[],
	width: number,
	height: number,
	heights?: NodeHeights,
	padding = 40,
) {
	const b = computeCanvasBounds(nodes, heights);
	const zoom = Math.min(
		2,
		Math.max(0.05, Math.min(Math.max(1, width - 2 * padding) / b.width, Math.max(1, height - 2 * padding) / b.height)),
	);
	return { x: (width - b.width * zoom) / 2 - b.x * zoom, y: (height - b.height * zoom) / 2 - b.y * zoom, zoom };
}
export function autoLayout(nodes: CanvasNode[], edges: CanvasEdge[], heights?: NodeHeights): CanvasNode[] {
	const ids = new Set(nodes.map((n) => n.id));
	const indeg = new Map(nodes.map((n) => [n.id, 0]));
	const adj = new Map<string, string[]>();
	for (const e of edges) {
		if (!ids.has(e.sourceNodeId) || !ids.has(e.targetNodeId)) continue;
		indeg.set(e.targetNodeId, indeg.get(e.targetNodeId)! + 1);
		adj.set(e.sourceNodeId, [...(adj.get(e.sourceNodeId) ?? []), e.targetNodeId]);
	}
	const layers = new Map(nodes.map((n) => [n.id, 0]));
	const queue = nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id);
	const visited = new Set<string>();
	for (let i = 0; i < queue.length; i++) {
		const id = queue[i];
		visited.add(id);
		for (const next of adj.get(id) ?? []) {
			layers.set(next, Math.max(layers.get(next)!, layers.get(id)! + 1));
			indeg.set(next, indeg.get(next)! - 1);
			if (!indeg.get(next)) queue.push(next);
		}
	}
	let fallback = Math.max(0, ...layers.values()) + 1;
	for (const n of nodes) if (!visited.has(n.id)) layers.set(n.id, fallback++);
	const groups = new Map<number, CanvasNode[]>();
	for (const n of nodes) {
		const l = layers.get(n.id)!;
		groups.set(l, [...(groups.get(l) ?? []), n]);
	}
	const pos = new Map<string, { x: number; y: number }>();
	let x = 80;
	for (const [, group] of [...groups].sort((a, b) => a[0] - b[0])) {
		let y = 80;
		for (const n of group) {
			pos.set(n.id, { x, y });
			y += nodeHeight(n, heights) + 40;
		}
		x += Math.max(...group.map((n) => n.width ?? 300)) + 60;
	}
	return nodes.map((n) => ({ ...n, ...pos.get(n.id) }));
}

export interface GraphSnap {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
}

export class HistoryStack {
	private past: GraphSnap[] = [];
	private future: GraphSnap[] = [];
	constructor(private limit = 50) {}
	push(s: GraphSnap) {
		const top = this.past[this.past.length - 1];
		if (top && this.isEqual(top, s)) return;
		this.past.push(structuredClone(s));
		if (this.past.length > this.limit) this.past.shift();
		this.future = [];
	}
	private isEqual(a: GraphSnap, b: GraphSnap): boolean {
		if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false;
		return JSON.stringify(a) === JSON.stringify(b);
	}
	undo(cur: GraphSnap): GraphSnap | null {
		const prev = this.past.pop();
		if (!prev) return null;
		this.future.push(structuredClone(cur));
		return prev;
	}
	redo(cur: GraphSnap): GraphSnap | null {
		const nxt = this.future.pop();
		if (!nxt) return null;
		this.past.push(structuredClone(cur));
		return nxt;
	}
	get canUndo() {
		return this.past.length > 0;
	}
	get canRedo() {
		return this.future.length > 0;
	}
	clear() {
		this.past = [];
		this.future = [];
	}
}
