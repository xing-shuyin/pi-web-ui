import type { CanvasEdge, CanvasGraph, CanvasNode, CanvasNodeRole } from "../../types";
import type { Translate } from "../../i18n";
import { getRoleMetas, getInPortDefs, outPortsForRole, isRoleImplemented } from "./CanvasTypes";
const ROLE_METAS = getRoleMetas((key) => key);
const IN_PORT_DEFS = getInPortDefs((key) => key);

export function extractDagJson(text: string): string | null {
	return text.match(/```canvas-dag\s*([\s\S]*?)```/)?.[1].trim() ?? null;
}
export interface ParsedDag {
	nodes: {
		title: string;
		role: CanvasNodeRole;
		instruction?: string;
		cwd?: string;
		config?: Record<string, string | number | boolean>;
	}[];
	edges: {
		from: number;
		to: number;
		type?: CanvasEdge["type"];
		sourcePort?: string;
		targetPort?: string;
		label?: string;
	}[];
}
const types = new Set([
	"handoff",
	"review",
	"parallel",
	"loop_back",
	"condition_true",
	"condition_false",
	"approve",
	"reject",
]);
function object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[], t: Translate) {
	if (Object.keys(value).some((k) => !allowed.includes(k))) throw new Error(t("canvas.dag.unknownField"));
}
function optionalText(value: unknown, max: number, t: Translate) {
	if (value !== undefined && (typeof value !== "string" || value.length > max))
		throw new Error(t("canvas.dag.invalidText"));
}
/** Validate the complete wire-independent DAG before constructing any graph. */
export function parseDagJson(raw: string, maxNodes = 20, maxEdges = 200, t: Translate = (key) => key): ParsedDag {
	if (
		!Number.isInteger(maxNodes) ||
		maxNodes < 1 ||
		maxNodes > 200 ||
		!Number.isInteger(maxEdges) ||
		maxEdges < 0 ||
		maxEdges > 1000
	)
		throw new Error(t("canvas.dag.invalidLimits"));
	if (raw.length > (maxNodes > 20 ? 2_000_000 : 200_000)) throw new Error(t("canvas.dag.tooLarge"));
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new Error(t("canvas.dag.invalidJson"));
	}
	if (!object(data)) throw new Error(t("canvas.dag.invalidDag"));
	keys(data, ["nodes", "edges"], t);
	if (
		!Array.isArray(data.nodes) ||
		!data.nodes.length ||
		data.nodes.length > maxNodes ||
		!Array.isArray(data.edges) ||
		data.edges.length > maxEdges
	)
		throw new Error(t("canvas.dag.invalidNodesOrEdges"));
	for (const n of data.nodes) {
		if (!object(n)) throw new Error(t("canvas.dag.invalidNode"));
		keys(n, ["title", "role", "instruction", "cwd", "config"], t);
		if (
			typeof n.title !== "string" ||
			!n.title.trim() ||
			n.title.length > 200 ||
			typeof n.role !== "string" ||
			!Object.hasOwn(ROLE_METAS, n.role) ||
			!isRoleImplemented(n.role as CanvasNodeRole)
		)
			throw new Error(t("canvas.dag.invalidRoleOrTitle"));
		optionalText(n.instruction, 32000, t);
		optionalText(n.cwd, 4096, t);
		if (n.config !== undefined) {
			if (!object(n.config) || Object.keys(n.config).length > 20) throw new Error(t("canvas.dag.invalidConfig"));
			for (const [k, v] of Object.entries(n.config))
				if (
					!k ||
					k.length > 100 ||
					["__proto__", "constructor", "prototype"].includes(k) ||
					!(
						typeof v === "boolean" ||
						(typeof v === "number" && Number.isFinite(v)) ||
						(typeof v === "string" && v.length <= 32000)
					)
				)
					throw new Error(t("canvas.dag.invalidConfigValue"));
		}
	}
	const seen = new Set<string>();
	const adj: number[][] = data.nodes.map(() => []);
	for (const e of data.edges) {
		if (!object(e)) throw new Error(t("canvas.dag.invalidEdge"));
		keys(e, ["from", "to", "type", "sourcePort", "targetPort", "label"], t);
		if (
			!Number.isInteger(e.from) ||
			!Number.isInteger(e.to) ||
			(e.from as number) < 0 ||
			(e.to as number) < 0 ||
			(e.from as number) >= data.nodes.length ||
			(e.to as number) >= data.nodes.length ||
			e.from === e.to
		)
			throw new Error(t("canvas.dag.invalidEdgeIndex"));
		if (e.type !== undefined && !types.has(e.type as string)) throw new Error(t("canvas.dag.invalidEdgeType"));
		if (
			(e.type === "condition_true" || e.type === "condition_false") &&
			!["condition", "ai_judge"].includes(data.nodes[e.from as number].role)
		)
			throw new Error(t("canvas.dag.branchRoleRequired"));
		if (
			(e.type === "approve" || e.type === "reject") &&
			!["human", "reviewer", "evaluator"].includes(data.nodes[e.from as number].role)
		)
			throw new Error(t("canvas.dag.reviewRoleRequired"));
		const role = data.nodes[e.from as number].role as CanvasNodeRole;
		if (e.sourcePort !== undefined && !outPortsForRole(role).some((p) => p.key === e.sourcePort))
			throw new Error(t("canvas.dag.invalidSourcePort"));
		if (e.targetPort !== undefined && !IN_PORT_DEFS.some((p) => p.key === e.targetPort))
			throw new Error(t("canvas.dag.invalidTargetPort"));
		const implied: Record<string, string> = {
			true: "condition_true",
			false: "condition_false",
			approve: "approve",
			reject: "reject",
		};
		if (
			e.sourcePort &&
			implied[e.sourcePort as string] &&
			e.type !== undefined &&
			e.type !== implied[e.sourcePort as string]
		)
			throw new Error(t("canvas.dag.portTypeMismatch"));
		optionalText(e.label, 200, t);
		const key = JSON.stringify([e.from, e.to, e.sourcePort ?? "result", e.targetPort ?? "contract"]);
		if (seen.has(key)) throw new Error(t("canvas.dag.duplicateEdge"));
		seen.add(key);
		adj[e.from as number].push(e.to as number);
	}
	const color = Array(data.nodes.length).fill(0);
	function visit(i: number) {
		if (color[i] === 1) throw new Error(t("canvas.dag.cycle"));
		if (color[i] === 2) return;
		color[i] = 1;
		adj[i].forEach(visit);
		color[i] = 2;
	}
	adj.forEach((_, i) => visit(i));
	return data as unknown as ParsedDag;
}
export function dagToGraph(
	parsed: ParsedDag,
	name: string,
	defaultModel: string,
	layout: (nodes: CanvasNode[], edges: CanvasEdge[]) => CanvasNode[],
	defaultCwd = ".",
	t: Translate = (key) => key,
): CanvasGraph {
	parsed = parseDagJson(JSON.stringify(parsed), 20, 200, t);
	const now = Date.now();
	const id = `graph_${now}_${Math.random().toString(36).slice(2, 8)}`;
	const nodes: CanvasNode[] = parsed.nodes.map((n, i) => ({
		...n,
		id: `${id}_n${i}`,
		x: 80,
		y: 80 + i * 100,
		width: 300,
		engine: "pi",
		model: defaultModel,
		cwd: n.cwd || defaultCwd,
		useWorktree: false,
		status: "idle",
	}));
	const implied: Record<string, CanvasEdge["type"]> = {
		true: "condition_true",
		false: "condition_false",
		approve: "approve",
		reject: "reject",
	};
	const edges: CanvasEdge[] = parsed.edges.map((e, i) => ({
		id: `${id}_e${i}`,
		sourceNodeId: nodes[e.from].id,
		targetNodeId: nodes[e.to].id,
		type: e.type ?? implied[e.sourcePort ?? ""] ?? "handoff",
		...(e.sourcePort ? { sourcePort: e.sourcePort } : {}),
		...(e.targetPort ? { targetPort: e.targetPort } : {}),
		...(e.label ? { label: e.label } : {}),
	}));
	return {
		id,
		name: name.trim() || t("canvas.defaults.aiWorkflow"),
		viewport: { x: 60, y: 60, zoom: 1 },
		nodes: layout(nodes, edges),
		edges,
		status: "idle",
		executionMode: "real",
		createdAt: now,
		updatedAt: now,
	};
}
export function buildSmartPrompt(userAsk: string): string {
	return [
		"Generate a workflow as one ```canvas-dag JSON block. No cycles. Use reliable sequential handoffs and explicit human acceptance; shared cwd, no automatic isolation/integration guarantees.",
		`Allowed roles: ${Object.keys(ROLE_METAS)
			.filter((r) => isRoleImplemented(r as CanvasNodeRole))
			.join(", ")}.`,
		'Schema: {"nodes":[{"title":"Step","role":"coder","instruction":"Task","config":{}}],"edges":[{"from":0,"to":1,"type":"handoff","sourcePort":"result","targetPort":"contract"}]}. 1-20 nodes. Config values must be strings, finite numbers or booleans. Omit optional fields when unused. Branch ports true/false require condition_true/condition_false; approve/reject use matching types. Empty edges means disconnected nodes.',
		`Request: ${userAsk}`,
	].join("\n");
}
