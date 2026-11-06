import type { CanvasGraph } from "../../types";
import type { Translate } from "../../i18n";
import { getRoleMetas, getInPortDefs, outPortsForRole } from "./CanvasTypes";
import { isCanvasMessage } from "../../../../server/canvas/canvas-runtime-messages.js";

/** Only authored fields participate in dirty tracking; execution streams never save themselves. */
export function graphFingerprint(graph: CanvasGraph): string {
	const { rev: _rev, updatedAt: _updated, status: _status, run: _run, ...rest } = graph;
	const authored = {
		...rest,
		nodes: graph.nodes.map(
			({
				status: _s,
				activeConvId: _c,
				currentAction: _a,
				currentActionMessage: _actionMessage,
				errorMessage: _errorMessage,
				lastOutputSummary: _o,
				aiVerdict: _v,
				error: _e,
				runId: _r,
				attempt: _t,
				artifact: _f,
				actualEngine: _ae,
				actualModel: _am,
				...node
			}) => node,
		),
		edges: graph.edges.map(({ currentLoopCount: _c, lastHandoffSummary: _s, runId: _r, active: _a, ...edge }) => edge),
	};
	// Server serialization may reorder keys; read-back equality is semantic.
	const canonical = (value: unknown): unknown =>
		Array.isArray(value)
			? value.map(canonical)
			: value && typeof value === "object"
				? Object.fromEntries(
						Object.entries(value)
							.filter(([, v]) => v !== undefined)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([k, v]) => [k, canonical(v)]),
					)
				: value;
	return JSON.stringify(canonical(authored));
}
export function mergeGraphRuntime(local: CanvasGraph, remote: CanvasGraph): CanvasGraph {
	const nodeFields = [
		"status",
		"activeConvId",
		"currentAction",
		"currentActionMessage",
		"errorMessage",
		"lastOutputSummary",
		"aiVerdict",
		"error",
		"runId",
		"attempt",
		"artifact",
		"actualEngine",
		"actualModel",
	] as const;
	const edgeFields = ["currentLoopCount", "lastHandoffSummary", "runId", "active"] as const;
	return {
		...local,
		status: remote.status,
		run: remote.run,
		nodes: local.nodes.map((node) => {
			const other = remote.nodes.find((n) => n.id === node.id);
			if (!other) return node;
			return { ...node, ...Object.fromEntries(nodeFields.map((key) => [key, other[key]])) };
		}),
		edges: local.edges.map((edge) => {
			const other = remote.edges.find((e) => e.id === edge.id);
			if (!other) return edge;
			return { ...edge, ...Object.fromEntries(edgeFields.map((key) => [key, other[key]])) };
		}),
	};
}
export const nodeLogKey = (graphId: string, nodeId: string) => JSON.stringify([graphId, nodeId]);
export function graphRuntimeStatus(nodes: CanvasGraph["nodes"]): CanvasGraph["status"] {
	if (nodes.some((n) => n.status === "running" || n.status === "queued")) return "running";
	if (nodes.some((n) => n.status === "waiting_approval")) return "waiting_approval";
	if (nodes.some((n) => n.status === "error")) return "error";
	if (nodes.some((n) => n.status === "paused")) return "paused";
	if (nodes.length && nodes.every((n) => ["done", "skipped", "cancelled"].includes(n.status)))
		return nodes.some((n) => n.status === "cancelled") ? "blocked" : "completed";
	return "idle";
}

export class CanvasDraftState {
	baseline = "";
	pendingSave: { requestId: string; graphId: string; fingerprint: string } | null = null;
	pendingLoad: { requestId: string; graphId: string } | null = null;
	readonly unknownSaves = new Map<string, string>();
	/** A closed socket cannot deliver the old ACK. Keep its submission for read-back reconciliation. */
	disconnected() {
		if (this.pendingSave) this.unknownSaves.set(this.pendingSave.graphId, this.pendingSave.fingerprint);
		this.pendingSave = null;
		this.pendingLoad = null;
	}
	reconcileSave(remote: CanvasGraph, local: CanvasGraph): "saved" | "conflict" | null {
		const submitted = this.unknownSaves.get(remote.id);
		if (!submitted || local.id !== remote.id) return null;
		this.unknownSaves.delete(remote.id);
		if (graphFingerprint(remote) !== submitted) return "conflict";
		this.baseline = submitted;
		this.retain({ ...local, rev: remote.rev });
		if (!this.dirty(local)) this.clearDraft(local.id);
		return "saved";
	}
	error = "";
	constructor(
		private readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">,
		private t: Translate = (key) => key,
	) {}
	setTranslate(t: Translate) {
		this.t = t;
	}
	dirty(graph: CanvasGraph) {
		return this.baseline !== graphFingerprint(graph);
	}
	retain(graph: CanvasGraph): boolean {
		try {
			this.storage?.setItem(`pi-web-ui.canvas.draft.${graph.id}`, JSON.stringify(graph));
			return true;
		} catch {
			this.error = this.t("canvas.draft.storageFailed");
			return false;
		}
	}
	draft(id: string): CanvasGraph | null {
		try {
			const raw = this.storage?.getItem(`pi-web-ui.canvas.draft.${id}`);
			return raw ? parseGraphImport(raw, false, this.t) : null;
		} catch {
			return null;
		}
	}
	beginSave(graph: CanvasGraph, requestId: string) {
		this.pendingSave = { requestId, graphId: graph.id, fingerprint: graphFingerprint(graph) };
		this.error = "";
		this.retain(graph);
		return { type: "canvas_save" as const, graph, baseRev: graph.rev ?? 0, requestId };
	}
	acceptSave(graph: CanvasGraph, requestId?: string): boolean {
		const pending = this.pendingSave;
		if (!pending || pending.requestId !== requestId || graph.id !== pending.graphId) return false;
		this.baseline = pending.fingerprint;
		this.pendingSave = null;
		this.error = "";
		return true;
	}
	fail(requestId: string | undefined, message: string): boolean {
		if (!requestId || (requestId !== this.pendingSave?.requestId && requestId !== this.pendingLoad?.requestId))
			return false;
		if (requestId === this.pendingSave?.requestId) this.pendingSave = null;
		if (requestId === this.pendingLoad?.requestId) this.pendingLoad = null;
		this.error = message;
		return true;
	}
	beginLoad(graphId: string, requestId: string) {
		this.pendingLoad = { graphId, requestId };
		return { type: "canvas_load" as const, id: graphId, requestId };
	}
	acceptsLoad(graph: CanvasGraph, requestId?: string): boolean {
		return !!this.pendingLoad && this.pendingLoad.graphId === graph.id && this.pendingLoad.requestId === requestId;
	}
	loaded(graph: CanvasGraph) {
		this.pendingLoad = null;
		this.baseline = graphFingerprint(graph);
		this.error = "";
	}
	clearDraft(id: string) {
		try {
			this.storage?.removeItem(`pi-web-ui.canvas.draft.${id}`);
		} catch {
			/* stale draft remains recoverable */
		}
	}
}

/** Validate before replacing anything. Reject dangling edges, duplicate IDs and unsupported DAGs. */
export function parseGraphImport(raw: string, reset = true, t: Translate = (key) => key): CanvasGraph {
	const ROLE_METAS = getRoleMetas(t);
	const IN_PORT_DEFS = getInPortDefs(t);
	if (raw.length > 2_000_000) throw new Error(t("canvas.import.jsonTooLarge"));
	let g: CanvasGraph;
	try {
		g = JSON.parse(raw) as CanvasGraph;
	} catch {
		throw new Error(t("canvas.import.invalidJson"));
	}
	if (
		!g ||
		typeof g !== "object" ||
		!Array.isArray(g.nodes) ||
		!Array.isArray(g.edges) ||
		typeof g.name !== "string" ||
		!g.name.trim() ||
		typeof g.id !== "string" ||
		!/^[A-Za-z0-9._-]{1,64}$/.test(g.id) ||
		!Number.isFinite(g.createdAt) ||
		!Number.isFinite(g.updatedAt)
	)
		throw new Error(t("canvas.import.incompleteGraph"));
	const ids = new Map<string, number>();
	const allowed = (value: object, fields: string[]) => {
		if (Object.keys(value).some((k) => !fields.includes(k))) throw new Error(t("canvas.import.unknownField"));
	};
	allowed(g, [
		"id",
		"name",
		"viewport",
		"nodes",
		"edges",
		"status",
		"run",
		"executionMode",
		"createdAt",
		"updatedAt",
		"rev",
	]);
	if (g.nodes.length > 200 || g.edges.length > 1000 || (g.rev !== undefined && (!Number.isInteger(g.rev) || g.rev < 0)))
		throw new Error(t("canvas.import.invalidSizeOrVersion"));
	if (
		!["idle", "running", "paused", "completed", "error", "blocked", "waiting_approval"].includes(g.status) ||
		(g.executionMode !== undefined && !["real", "simulate"].includes(g.executionMode))
	)
		throw new Error(t("canvas.import.invalidGraphStatus"));
	if (
		g.run !== undefined &&
		(!g.run ||
			typeof g.run.id !== "string" ||
			!Number.isInteger(g.run.graphRev) ||
			!Number.isFinite(g.run.startedAt) ||
			!["all", "node"].includes(g.run.scope) ||
			(g.run.finishedAt !== undefined && !Number.isFinite(g.run.finishedAt)))
	)
		throw new Error(t("canvas.import.invalidRun"));
	allowed(g.viewport ?? {}, ["x", "y", "zoom"]);
	for (const [i, n] of g.nodes.entries()) {
		if (
			!n ||
			typeof n.id !== "string" ||
			!/^[A-Za-z0-9._-]{1,128}$/.test(n.id) ||
			ids.has(n.id) ||
			!Number.isFinite(n.x) ||
			!Number.isFinite(n.y) ||
			(n.width !== undefined && (!Number.isFinite(n.width) || n.width <= 0)) ||
			(n.height !== undefined && (!Number.isFinite(n.height) || n.height <= 0)) ||
			!["pi", "dsh", "codex", "claude", "durable"].includes(n.engine) ||
			typeof n.model !== "string" ||
			typeof n.cwd !== "string" ||
			typeof n.useWorktree !== "boolean"
		)
			throw new Error(t("canvas.import.invalidNodeGeometry"));
		allowed(n, [
			"id",
			"title",
			"role",
			"x",
			"y",
			"width",
			"height",
			"engine",
			"model",
			"thinkingLevel",
			"cwd",
			"useWorktree",
			"systemPromptOverride",
			"instruction",
			"config",
			"status",
			"activeConvId",
			"currentAction",
			"currentActionMessage",
			"errorMessage",
			"lastOutputSummary",
			"aiVerdict",
			"error",
			"runId",
			"attempt",
			"artifact",
			"actualEngine",
			"actualModel",
		]);
		for (const key of ["thinkingLevel", "systemPromptOverride", "instruction"] as const)
			if (n[key] !== undefined && typeof n[key] !== "string") throw new Error(t("canvas.import.invalidNodeText"));
		if (
			!["idle", "queued", "running", "waiting_approval", "done", "error", "paused", "skipped", "cancelled"].includes(
				n.status,
			)
		)
			throw new Error(t("canvas.import.invalidNodeStatus"));
		if (
			n.artifact !== undefined &&
			(!n.artifact ||
				typeof n.artifact.runId !== "string" ||
				!Number.isInteger(n.artifact.attempt) ||
				typeof n.artifact.summary !== "string" ||
				!Number.isFinite(n.artifact.createdAt))
		)
			throw new Error(t("canvas.import.invalidArtifact"));
		if (
			n.artifact?.files !== undefined &&
			(!Array.isArray(n.artifact.files) || n.artifact.files.some((f) => typeof f !== "string"))
		)
			throw new Error(t("canvas.import.invalidArtifactFile"));
		for (const key of ["activeConvId", "currentAction", "lastOutputSummary", "error", "runId", "actualModel"] as const)
			if (n[key] !== undefined && typeof n[key] !== "string") throw new Error(t("canvas.import.invalidRuntimeText"));
		for (const key of ["currentActionMessage", "errorMessage"] as const)
			if (n[key] !== undefined && !isCanvasMessage(n[key])) throw new Error(t("canvas.import.invalidRuntimeText"));
		if (!Object.hasOwn(ROLE_METAS, n.role) || typeof n.title !== "string" || !n.title.trim() || n.title.length > 200)
			throw new Error(t("canvas.import.invalidRoleOrTitle"));
		if (
			n.config !== undefined &&
			(!n.config ||
				Array.isArray(n.config) ||
				typeof n.config !== "object" ||
				Object.entries(n.config).some(
					([key, value]) =>
						["__proto__", "constructor", "prototype"].includes(key) ||
						!["string", "number", "boolean"].includes(typeof value) ||
						(typeof value === "number" && !Number.isFinite(value)),
				))
		)
			throw new Error(t("canvas.import.invalidConfig"));
		ids.set(n.id, i);
	}
	const edges = new Set<string>();
	for (const e of g.edges) {
		if (
			!e ||
			typeof e.id !== "string" ||
			!/^[A-Za-z0-9._-]{1,128}$/.test(e.id) ||
			edges.has(e.id) ||
			!ids.has(e.sourceNodeId) ||
			!ids.has(e.targetNodeId)
		)
			throw new Error(t("canvas.import.invalidEdgeEndpoints"));
		allowed(e, [
			"id",
			"sourceNodeId",
			"targetNodeId",
			"type",
			"sourcePort",
			"targetPort",
			"label",
			"maxLoopRetries",
			"currentLoopCount",
			"lastHandoffSummary",
			"runId",
			"active",
		]);
		if (e.maxLoopRetries !== undefined && (!Number.isInteger(e.maxLoopRetries) || e.maxLoopRetries < 0))
			throw new Error(t("canvas.import.invalidRetryConfig"));
		if (
			![
				"handoff",
				"review",
				"parallel",
				"condition_true",
				"condition_false",
				"loop_back",
				"approve",
				"reject",
			].includes(e.type)
		)
			throw new Error(t("canvas.import.invalidEdgeType"));
		const source = g.nodes[ids.get(e.sourceNodeId)!];
		if (
			(e.sourcePort !== undefined && !outPortsForRole(source.role).some((p) => p.key === e.sourcePort)) ||
			(e.targetPort !== undefined && !IN_PORT_DEFS.some((p) => p.key === e.targetPort))
		)
			throw new Error(t("canvas.import.invalidPort"));
		if (e.label !== undefined && typeof e.label !== "string") throw new Error(t("canvas.import.invalidEdgeText"));
		const implied: Record<string, string> = {
			true: "condition_true",
			false: "condition_false",
			approve: "approve",
			reject: "reject",
		};
		if (e.sourcePort && implied[e.sourcePort] && implied[e.sourcePort] !== e.type)
			throw new Error(t("canvas.import.portTypeMismatch"));
		edges.add(e.id);
	}

	if (
		!g.viewport ||
		!Number.isFinite(g.viewport.x) ||
		!Number.isFinite(g.viewport.y) ||
		!Number.isFinite(g.viewport.zoom) ||
		g.viewport.zoom <= 0 ||
		g.viewport.zoom > 4
	)
		throw new Error(t("canvas.import.invalidViewport"));
	if (!reset) return g;
	return {
		...g,
		id: `graph_${crypto.randomUUID()}`,
		rev: 0,
		run: undefined,
		status: "idle",
		executionMode: "real",
		nodes: g.nodes.map((n) => ({
			...n,
			status: "idle",
			activeConvId: undefined,
			currentAction: undefined,
			currentActionMessage: undefined,
			errorMessage: undefined,
			lastOutputSummary: undefined,
			error: undefined,
			runId: undefined,
			artifact: undefined,
			attempt: undefined,
			actualEngine: undefined,
			actualModel: undefined,
			aiVerdict: undefined,
		})),
		edges: g.edges.map((e) => ({
			...e,
			runId: undefined,
			active: undefined,
			currentLoopCount: undefined,
			lastHandoffSummary: undefined,
		})),
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}
