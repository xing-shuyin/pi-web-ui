/**
 * canvas-agent-tool —— 对话 AI 直接编辑画布流水线的单 action 工具。
 *
 * 动作：list（工程摘要）/ get（整图 JSON）/ create_graph（新建工程）/ delete_graph（删除工程）/
 * add_node / update_node / delete_node / add_edge / delete_edge / apply_dag（整图节点边替换，角色白名单+环检测）。
 * 运行与调试通过注入的 CanvasOrchestrator；编辑走版本检查与严格校验，成功后广播。
 * 运行失败广播明确错误，状态与证据由调度器统一持久化。
 */
import { canvasErrorMessage } from "./canvas-runtime-messages.js";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { pick, type ServerLang } from "../i18n.js";
import { CANVAS_TOOL_NAME } from "../tool-manager.js";
import { deleteCanvasGraph, listCanvasGraphs, loadCanvasGraph, saveCanvasGraph } from "./canvas-store.js";
import { addCustomCard, deleteCustomCard, listCustomCards, updateCustomCard } from "./canvas-cards.js";
import type { CanvasEdge, CanvasGraph, CanvasNode, CanvasNodeRole, ServerMessage } from "../protocol.js";
import { assertCanvasGraph } from "./canvas-validation.js";

export interface CanvasToolHost {
	dataDir: string;
	lang?: () => ServerLang;
	getCwd?: () => string;
}

function defaultNodeCwd(host: CanvasToolHost, p: Record<string, unknown>): string {
	const explicit = typeof p.cwd === "string" ? p.cwd.trim().slice(0, 256) : "";
	if (explicit) return explicit;
	try {
		const cur = host.getCwd?.()?.trim();
		if (cur) return cur;
	} catch {}
	return ".";
}

interface CanvasRuntime {
	runAll(graph: CanvasGraph, initialPrompt?: string, runBase?: string): Promise<void>;
	runNode(graph: CanvasGraph, nodeId: string, prompt?: string, runBase?: string): Promise<void>;
	stopNode(graphId: string, nodeId: string): void;
	stopAll(graphId: string): void;
	deleteGraph(graphId: string): boolean;
	steerNode(graphId: string, nodeId: string, message: string): void | Promise<void>;
	reviewNode(graphId: string, nodeId: string, decision: "approve" | "reject", comment?: string): unknown;
	getNodeLog(graphId: string, nodeId: string): unknown;
	getNodeMessages(graphId: string, nodeId: string): unknown;
	resetStatus(graph: CanvasGraph): void;
}

let canvasRuntime: CanvasRuntime | null = null;

export function setCanvasRuntime(rt: CanvasRuntime | null): void {
	canvasRuntime = rt;
}

let canvasBroadcaster: ((msg: ServerMessage) => void) | null = null;

export function setCanvasBroadcaster(fn: ((msg: ServerMessage) => void) | null): void {
	canvasBroadcaster = fn;
}

function pushCards(dataDir: string): void {
	try {
		canvasBroadcaster?.({ type: "canvas_cards_state", cards: listCustomCards(dataDir) });
	} catch {}
}

function saveAndPush(dataDir: string, graph: CanvasGraph): void {
	assertCanvasGraph(graph);
	const result = saveCanvasGraph(dataDir, graph, { expectedRev: graph.rev ?? 0 });
	if (result.conflict) throw new Error("Canvas changed; get the latest graph before editing again");
	try {
		canvasBroadcaster?.({ type: "canvas_graph_state", graph });
	} catch {}
}

const VALID_ROLES = new Set([
	"trigger",
	"cron",
	"webhook",
	"transform",
	"architect",
	"planner",
	"coder",
	"researcher",
	"writer",
	"analyst",
	"reviewer",
	"tester",
	"devops",
	"evaluator",
	"custom",
	"condition",
	"ai_judge",
	"loop",
	"human",
	"merge",
	"subflow",
	"tool",
	"knowledge",
	"code",
	"api",
	"memory",
	"end",
	"pstack",
	"skill",
]);

const canvasSchema = Type.Object({
	action: Type.Union([
		Type.Literal("list"),
		Type.Literal("get"),
		Type.Literal("create_graph"),
		Type.Literal("delete_graph"),
		Type.Literal("run_all"),
		Type.Literal("run_node"),
		Type.Literal("stop_node"),
		Type.Literal("stop_all"),
		Type.Literal("steer_node"),
		Type.Literal("review_node"),
		Type.Literal("get_log"),
		Type.Literal("reset_status"),
		Type.Literal("layout_graph"),
		Type.Literal("card_list"),
		Type.Literal("card_add"),
		Type.Literal("card_update"),
		Type.Literal("card_delete"),
		Type.Literal("card_place"),
		Type.Literal("add_node"),
		Type.Literal("update_node"),
		Type.Literal("delete_node"),
		Type.Literal("add_edge"),
		Type.Literal("delete_edge"),
		Type.Literal("apply_dag"),
	]),
	graphId: Type.Optional(Type.String({ description: "Target canvas graph id (list omits it)" })),
	title: Type.Optional(Type.String()),
	role: Type.Optional(Type.String()),
	instruction: Type.Optional(Type.String()),
	nodeId: Type.Optional(Type.String()),
	cardId: Type.Optional(Type.String({ description: "Custom card id (card_list shows them)" })),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for a new node (absolute path pins a project; omit = current project)",
		}),
	),
	message: Type.Optional(Type.String()),
	prompt: Type.Optional(Type.String()),
	decision: Type.Optional(Type.String()),
	comment: Type.Optional(Type.String()),
	patch: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	sourceNodeId: Type.Optional(Type.String()),
	targetNodeId: Type.Optional(Type.String()),
	edgeId: Type.Optional(Type.String()),
	nodes: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
	edges: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
});

function hasCycle(n: number, edges: { from: number; to: number }[]): boolean {
	const adj: number[][] = Array.from({ length: n }, () => []);
	edges.forEach((e) => adj[e.from]?.push(e.to));
	const color = new Array(n).fill(0);
	const dfs = (u: number): boolean => {
		color[u] = 1;
		for (const v of adj[u] ?? []) {
			if (color[v] === 1) return true;
			if (color[v] === 0 && dfs(v)) return true;
		}
		color[u] = 2;
		return false;
	};
	for (let i = 0; i < n; i++) if (color[i] === 0 && dfs(i)) return true;
	return false;
}

export function makeCanvasTool(host: CanvasToolHost, lang?: () => ServerLang): ToolDefinition {
	const getLang: () => ServerLang = lang ?? host.lang ?? (() => "en");
	const text = (t: string, details: unknown = {}) => {
		const encoded = JSON.stringify(details);
		const oversized = Buffer.byteLength(encoded, "utf8") > 60_000;
		return {
			content: [{ type: "text" as const, text: oversized ? `${t}\n${encoded}` : t }],
			details: oversized
				? { truncated: true, note: "Full graph is included in text; details exceeded the UI budget" }
				: details,
		};
	};
	return defineTool({
		name: CANVAS_TOOL_NAME,
		label: "Canvas pipeline",
		description:
			"Read and edit canvas workflow graphs: list/get/create/delete graphs, add/update/delete nodes and edges, replace the DAG, layout/rearrange nodes on a tidy grid, run all or one node, stop, steer a running node, approve/reject review gates, read node logs, reset status, manage reusable custom cards. Use it when the user asks to create, change, run, or debug a pipeline.",
		promptSnippet: "Inspect, edit, run, or debug canvas workflows and canvas references.",
		promptGuidelines: [
			"Get the referenced graph before editing or running it; a canvas reference alone does not request execution",
			"Running nodes costs tokens/time: prefer run_node for single-node debug, run_all only when the user asks",
			"After steering or review, use get_log to confirm the node state before summarizing",
			"New nodes default their cwd to the user's current project (getCwd); pass an absolute cwd only to pin another project",
			"After apply_dag or structural edits, summarize nodes and edges for the user to confirm on canvas",
			"Never invent role names: only use roles already present in the graph or the known role set",
			"Save repeating teammates as custom cards (card_add) and reuse them via card_place",
		],
		parameters: canvasSchema,
		execute: async (_id, params, _signal, _onUpdate, _ctx) => {
			const p = (params ?? {}) as Record<string, unknown>;
			const action = p.action as string;
			const dataDir = host.dataDir;
			try {
				if (action === "list") {
					const graphs = listCanvasGraphs(dataDir);
					return text(
						pick(
							getLang(),
							`画布工程 ${graphs.length} 个：${graphs.map((g) => `${g.name}(${g.id}, ${g.nodeCount}节点/${g.edgeCount}边)`).join("；")}`,
							`Canvas graphs (${graphs.length}): ${graphs.map((g) => `${g.name} (${g.id}, ${g.nodeCount} nodes/${g.edgeCount} edges)`).join("; ")}`,
							"canvas.listed",
							{
								count: graphs.length,
								graphs: graphs.map((g) => `${g.name} (${g.id}, ${g.nodeCount} nodes/${g.edgeCount} edges)`).join("; "),
							},
						),
						{ graphs },
					);
				}
				const cardId = typeof p.cardId === "string" ? p.cardId : "";
				const cardInput = {
					title: p.title,
					role: p.role,
					instruction: p.instruction,
					systemPrompt: (p.patch as Record<string, unknown> | undefined)?.systemPrompt,
					model: (p.patch as Record<string, unknown> | undefined)?.model,
					engine: (p.patch as Record<string, unknown> | undefined)?.engine,
					config: (p.patch as Record<string, unknown> | undefined)?.config,
				};
				const isCardRole = (r: string): boolean => VALID_ROLES.has(r);
				if (action === "card_list") {
					const cards = listCustomCards(dataDir);
					return text(
						pick(
							getLang(),
							`自定义卡片 ${cards.length} 张：${cards.map((c) => `${c.title}(${c.id}, ${c.role})`).join("；") || "（空）"}`,
							`Custom cards (${cards.length}): ${cards.map((c) => `${c.title} (${c.id}, ${c.role})`).join("; ") || "(empty)"}`,
							"canvas.cards.listed",
							{
								count: cards.length,
								cards: cards.map((c) => `${c.title} (${c.id}, ${c.role})`).join("; ") || "(empty)",
							},
						),
						{ cards },
					);
				}
				if (action === "card_add") {
					const card = addCustomCard(dataDir, cardInput, isCardRole);
					pushCards(dataDir);
					return text(
						pick(
							getLang(),
							`已保存自定义卡片 ${card.title}(${card.id})，已同步到画布工具栏。`,
							`Saved custom card ${card.title} (${card.id}); toolbar updated.`,
							"canvas.card.added",
							{ "card.title": card.title, "card.id": card.id },
						),
						{ card },
					);
				}
				if (action === "card_update") {
					if (!cardId)
						return text(
							pick(
								getLang(),
								"缺少 cardId，先 card_list 查看。",
								"Missing cardId; call card_list first.",
								"canvas.card.missing",
								{},
							),
							{ ok: false },
						);
					const card = updateCustomCard(dataDir, cardId, cardInput, isCardRole);
					pushCards(dataDir);
					return text(
						pick(getLang(), `已更新卡片 ${card.title}。`, `Updated card ${card.title}.`, "canvas.card.updated", {
							"card.title": card.title,
						}),
						{ card },
					);
				}
				if (action === "card_delete") {
					if (!cardId)
						return text(
							pick(
								getLang(),
								"缺少 cardId，先 card_list 查看。",
								"Missing cardId; call card_list first.",
								"canvas.card.missing",
								{},
							),
							{ ok: false },
						);
					const ok = deleteCustomCard(dataDir, cardId);
					if (ok) pushCards(dataDir);
					return text(
						pick(
							getLang(),
							ok ? `已删除卡片 ${cardId}。` : `卡片不存在：${cardId}。`,
							ok ? `Deleted card ${cardId}.` : `Card not found: ${cardId}.`,
							"canvas.card.deleted",
							{ cardId },
						),
						{ ok },
					);
				}
				const graphId = typeof p.graphId === "string" ? p.graphId : "";
				if (action === "create_graph") {
					const name = (typeof p.title === "string" && p.title.slice(0, 48)) || "新工程";
					const now = Date.now();
					const safeBase = name.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 32) || "graph";
					const id = `graph_${now}_${safeBase}`.slice(0, 64);
					const graph: CanvasGraph = {
						id,
						name,
						viewport: { x: 50, y: 50, zoom: 1 },
						status: "idle",
						createdAt: now,
						updatedAt: now,
						nodes: [
							{
								id: `n_${now}_trigger`,
								title: "触发器",
								role: "trigger",
								x: 80,
								y: 180,
								width: 300,
								engine: "pi",
								model: "pi/default",
								cwd: ".",
								useWorktree: false,
								status: "idle",
								...(typeof p.instruction === "string" && p.instruction ? { instruction: p.instruction } : {}),
							},
							{
								id: `n_${now}_end`,
								title: "结束输出",
								role: "end",
								x: 480,
								y: 180,
								width: 300,
								engine: "pi",
								model: "pi/default",
								cwd: ".",
								useWorktree: false,
								status: "idle",
							},
						],
						edges: [
							{
								id: `e_${now}_0`,
								sourceNodeId: `n_${now}_trigger`,
								targetNodeId: `n_${now}_end`,
								type: "handoff",
							},
						],
					};
					saveAndPush(dataDir, graph);
					return text(
						pick(
							getLang(),
							`已新建工程 ${name}(${id})，含触发器→结束初始链。`,
							`Created graph ${name} (${id}) with trigger->end starter chain.`,
							"canvas.graph.created",
							{ name, id },
						),
						{ graph },
					);
				}
				if (action === "delete_graph") {
					if (!graphId)
						return text(
							pick(
								getLang(),
								"缺少 graphId，先用 action=list 查看工程。",
								"Missing graphId; call action=list first.",
								"canvas.missing.id",
								{},
							),
							{ ok: false },
						);
					if (graphId === "default")
						return text(
							pick(getLang(), "默认工程不可删。", "The default graph cannot be deleted.", "canvas.graph.protected", {}),
							{ ok: false },
						);
					const ok = canvasRuntime ? canvasRuntime.deleteGraph(graphId) : deleteCanvasGraph(dataDir, graphId);
					if (ok) {
						try {
							canvasBroadcaster?.({ type: "canvas_list_result", graphs: listCanvasGraphs(dataDir) });
						} catch {}
					}
					return text(
						pick(
							getLang(),
							ok ? `已删除工程 ${graphId}。` : `工程不存在：${graphId}。`,
							ok ? `Deleted graph ${graphId}.` : `Graph not found: ${graphId}.`,
							"canvas.graph.deleted",
							{ graphId },
						),
						{ ok },
					);
				}
				if (!graphId)
					return text(
						pick(
							getLang(),
							"缺少 graphId，先用 action=list 查看工程。",
							"Missing graphId; call action=list first.",
							"canvas.missing.id",
							{},
						),
						{ ok: false },
					);
				if (action === "get") {
					const g = loadCanvasGraph(dataDir, graphId);
					const summary = `图 ${g.name}：${g.nodes.map((n) => `${n.title}[${n.role}](${n.id})`).join("、")}；边 ${g.edges.map((e) => `${e.sourceNodeId}->${e.targetNodeId}`).join("、") || "无"}`;
					return text(summary, { graph: g });
				}
				const graph = loadCanvasGraph(dataDir, graphId);
				if (action === "card_place") {
					if (!cardId)
						return text(
							pick(
								getLang(),
								"缺少 cardId，先 card_list 查看。",
								"Missing cardId; call card_list first.",
								"canvas.card.missing",
								{},
							),
							{ ok: false },
						);
					const card = listCustomCards(dataDir).find((c) => c.id === cardId);
					if (!card)
						return text(
							pick(getLang(), `卡片不存在：${cardId}。`, `Card not found: ${cardId}.`, "canvas.card.not_found", {
								cardId,
							}),
							{ ok: false },
						);
					const role = VALID_ROLES.has(card.role) ? card.role : "coder";
					const node: CanvasNode = {
						id: `n_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
						title: card.title,
						role,
						x: 80 + (graph.nodes.length % 3) * 380,
						y: 80 + Math.floor(graph.nodes.length / 3) * 260,
						width: 300,
						engine: (["pi", "dsh", "codex", "claude", "durable"] as const).includes(card.engine as never)
							? (card.engine as CanvasNode["engine"])
							: "pi",
						model: card.model || graph.nodes[0]?.model || "pi/default",
						cwd: defaultNodeCwd(host, p),
						useWorktree: false,
						status: "idle",
						...(card.instruction ? { instruction: card.instruction } : {}),
						...(card.systemPrompt ? { systemPromptOverride: card.systemPrompt } : {}),
						...(card.config ? { config: { ...card.config } } : {}),
					};
					graph.nodes.push(node);
					const src = typeof p.sourceNodeId === "string" ? p.sourceNodeId : "";
					if (src && graph.nodes.some((x) => x.id === src)) {
						graph.edges.push({
							id: `e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
							sourceNodeId: src,
							targetNodeId: node.id,
							type: "handoff",
						});
					}
					saveAndPush(dataDir, graph);
					return text(
						pick(
							getLang(),
							`已落卡片 ${card.title} → 节点 ${node.id}，画布实时可见。`,
							`Placed card ${card.title} as node ${node.id}.`,
							"canvas.card.placed",
							{ "card.title": card.title, "node.id": node.id },
						),
						{ node },
					);
				}
				if (action === "add_node") {
					const role = typeof p.role === "string" && VALID_ROLES.has(p.role) ? (p.role as CanvasNodeRole) : "coder";
					const node: CanvasNode = {
						id: `n_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
						title: (typeof p.title === "string" && p.title.slice(0, 24)) || "新节点",
						role,
						x: 80 + (graph.nodes.length % 3) * 380,
						y: 80 + Math.floor(graph.nodes.length / 3) * 260,
						width: 300,
						engine: "pi",
						model: graph.nodes[0]?.model ?? "pi/default",
						cwd: defaultNodeCwd(host, p),
						useWorktree: false,
						status: "idle",
						...(typeof p.instruction === "string" && p.instruction ? { instruction: p.instruction } : {}),
					};
					graph.nodes.push(node);
					saveAndPush(dataDir, graph);
					return text(
						pick(
							getLang(),
							`已加节点 ${node.title}(${node.id})，画布刷新可见。`,
							`Added node ${node.title} (${node.id}).`,
							"canvas.node.added",
							{ "node.title": node.title, "node.id": node.id },
						),
						{ node },
					);
				}
				if (action === "update_node") {
					const nodeId = p.nodeId as string;
					const n = graph.nodes.find((x) => x.id === nodeId);
					if (!n)
						return text(
							pick(getLang(), `节点不存在：${nodeId}`, `Node not found: ${nodeId}`, "canvas.node.missing", { nodeId }),
							{ ok: false },
						);
					const patch = (p.patch ?? {}) as Record<string, unknown>;
					for (const [k, v] of Object.entries(patch)) {
						if (
							![
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
							].includes(k)
						)
							continue;
						if (k === "role" && typeof v === "string" && !VALID_ROLES.has(v)) continue;
						(n as unknown as Record<string, unknown>)[k] = v;
					}
					saveAndPush(dataDir, graph);
					return text(
						pick(getLang(), `已更新节点 ${n.title}。`, `Updated node ${n.title}.`, "canvas.node.updated", {
							"n.title": n.title,
						}),
						{ node: n },
					);
				}
				if (action === "delete_node") {
					const nodeId = p.nodeId as string;
					graph.nodes = graph.nodes.filter((x) => x.id !== nodeId);
					graph.edges = graph.edges.filter((e) => e.sourceNodeId !== nodeId && e.targetNodeId !== nodeId);
					saveAndPush(dataDir, graph);
					return text(
						pick(
							getLang(),
							`已删节点 ${nodeId}（连带边）。`,
							`Deleted node ${nodeId} with its edges.`,
							"canvas.node.deleted",
							{ nodeId },
						),
						{ ok: true },
					);
				}
				if (action === "add_edge") {
					const s = p.sourceNodeId as string;
					const t = p.targetNodeId as string;
					if (s === t) {
						return text(
							pick(
								getLang(),
								"不能连接自环边（源与目标相同）。",
								"Self-loop edges are not allowed (source equals target).",
								"canvas.edge.self",
								{},
							),
							{ ok: false },
						);
					}
					if (!graph.nodes.some((x) => x.id === s) || !graph.nodes.some((x) => x.id === t)) {
						return text(
							pick(
								getLang(),
								"边的端点节点不存在，先 get 确认 id。",
								"Edge endpoint not found; get the graph first.",
								"canvas.edge.missing",
								{},
							),
							{ ok: false },
						);
					}
					if (graph.edges.some((e) => e.sourceNodeId === s && e.targetNodeId === t)) {
						return text(
							pick(
								getLang(),
								`两节点间已存在连接（${s} → ${t}）。`,
								`Edge already exists between ${s} and ${t}.`,
								"canvas.edge.duplicate",
								{ s, t },
							),
							{ ok: false },
						);
					}
					const edge: CanvasEdge = {
						id: `e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
						sourceNodeId: s,
						targetNodeId: t,
						type: "handoff",
					};
					graph.edges.push(edge);
					saveAndPush(dataDir, graph);
					return text(
						pick(getLang(), `已连边 ${s} → ${t}。`, `Connected ${s} -> ${t}.`, "canvas.edge.added", { s, t }),
						{
							edge,
						},
					);
				}
				if (action === "delete_edge") {
					const edgeId = p.edgeId as string;
					graph.edges = graph.edges.filter((e) => e.id !== edgeId);
					saveAndPush(dataDir, graph);
					return text(
						pick(getLang(), `已删边 ${edgeId}。`, `Deleted edge ${edgeId}.`, "canvas.edge.deleted", { edgeId }),
						{
							ok: true,
						},
					);
				}
				if (action === "apply_dag") {
					const rawNodes = (p.nodes ?? []) as Record<string, unknown>[];
					const rawEdges = (p.edges ?? []) as Record<string, unknown>[];
					if (rawNodes.length === 0 || rawNodes.length > 20)
						return text(pick(getLang(), "nodes 非法（需 1-20 个）。", "nodes must be 1-20.", "canvas.dag.bad", {}), {
							ok: false,
						});
					for (const n of rawNodes) {
						if (typeof n.title !== "string" || typeof n.role !== "string" || !VALID_ROLES.has(n.role)) {
							return text(
								pick(
									getLang(),
									`非法节点 role：${String(n.role)}`,
									`Invalid node role: ${String(n.role)}`,
									"canvas.dag.role",
									{ "String(n.role)": String(n.role) },
								),
								{ ok: false },
							);
						}
					}
					const idx = rawNodes.map((_, i) => i);
					const normEdges = rawEdges.map((e): Record<string, unknown> & { from: number; to: number } => ({
						...e,
						from: Number(e.from ?? e.source),
						to: Number(e.to ?? e.target),
					}));
					for (const e of normEdges) {
						if (!idx.includes(e.from) || !idx.includes(e.to) || e.from === e.to) {
							return text(pick(getLang(), "边下标非法。", "Invalid edge indices.", "canvas.dag.edge", {}), {
								ok: false,
							});
						}
					}
					if (hasCycle(rawNodes.length, normEdges))
						return text(pick(getLang(), "DAG 含环，拒绝落图。", "DAG has a cycle; rejected.", "canvas.dag.cycle", {}), {
							ok: false,
						});
					const now = Date.now();
					const nodes: CanvasNode[] = rawNodes.map((n, i) => ({
						id: `n_${now}_${i}`,
						cwd: defaultNodeCwd(host, n as Record<string, unknown>),
						title: String(n.title).slice(0, 24),
						role: n.role as CanvasNodeRole,
						x: 80 + i * 120,
						y: 80 + (i % 3) * 260,
						width: 300,
						engine: "pi",
						model: graph.nodes[0]?.model ?? "pi/default",
						useWorktree: false,
						status: "idle",
						...(typeof n.instruction === "string" && n.instruction ? { instruction: n.instruction } : {}),
						...(n.config && typeof n.config === "object" ? { config: n.config as CanvasNode["config"] } : {}),
					}));
					const edges: CanvasEdge[] = normEdges.map((e, i) => ({
						id: `e_${now}_${i}`,
						sourceNodeId: nodes[e.from].id,
						targetNodeId: nodes[e.to].id,
						type: (e.type ?? "handoff") as CanvasEdge["type"],
						...(typeof e.sourcePort === "string" ? { sourcePort: e.sourcePort } : {}),
						...(typeof e.targetPort === "string" ? { targetPort: e.targetPort } : {}),
						...(typeof e.label === "string" ? { label: e.label } : {}),
					}));
					const next: CanvasGraph = { ...graph, nodes, edges, updatedAt: now };
					saveAndPush(dataDir, next);
					return text(
						pick(
							getLang(),
							`已替换整图：${nodes.length} 节点 / ${edges.length} 边。`,
							`Replaced graph: ${nodes.length} nodes / ${edges.length} edges.`,
							"canvas.dag.applied",
							{ "nodes.length": nodes.length, "edges.length": edges.length },
						),
						{ graph: next },
					);
				}
				const needRuntime = new Set([
					"run_all",
					"run_node",
					"stop_node",
					"stop_all",
					"steer_node",
					"review_node",
					"get_log",
					"reset_status",
					"layout_graph",
				]);
				if (needRuntime.has(action)) {
					if (!canvasRuntime)
						return text(
							pick(
								getLang(),
								"运行态未就绪（服务刚启动/未注入），请稍后重试或在 Canvas Studio 里操作。",
								"Canvas runtime not ready; retry later or use Canvas Studio.",
								"canvas.runtime.missing",
								{},
							),
							{ ok: false },
						);
					const nodeId = typeof p.nodeId === "string" ? p.nodeId : "";
					if (action === "run_all") {
						void canvasRuntime
							.runAll(graph, typeof p.prompt === "string" ? p.prompt : undefined, host.getCwd?.())
							.catch((error) => {
								canvasBroadcaster?.({
									type: "canvas_error",
									code: "execution_error",
									graphId,
									message: (error as Error).message,
									messageI18n: canvasErrorMessage(error),
								});
							});
						return text(
							pick(
								getLang(),
								`已启动整图运行：${graph.name}，进度在 Canvas Studio 看直播。`,
								`Started run-all for ${graph.name}; watch progress in Canvas Studio.`,
								"canvas.run.started",
								{ "graph.name": graph.name },
							),
							{ ok: true, graphId },
						);
					}
					if (action === "run_node") {
						if (!nodeId)
							return text(pick(getLang(), "缺少 nodeId。", "Missing nodeId.", "canvas.node.id_missing", {}), {
								ok: false,
							});
						void canvasRuntime
							.runNode(graph, nodeId, typeof p.prompt === "string" ? p.prompt : undefined, host.getCwd?.())
							.catch((error) => {
								canvasBroadcaster?.({
									type: "canvas_error",
									code: "execution_error",
									graphId,
									message: (error as Error).message,
									messageI18n: canvasErrorMessage(error),
								});
							});
						return text(
							pick(
								getLang(),
								`已启动节点 ${nodeId}，日志可用 get_log 查看。`,
								`Started node ${nodeId}; use get_log to inspect.`,
								"canvas.node.started",
								{ nodeId },
							),
							{ ok: true, graphId, nodeId },
						);
					}
					if (action === "stop_node") {
						canvasRuntime.stopNode(graphId, nodeId);
						return text(
							pick(getLang(), `已停止节点 ${nodeId}。`, `Stopped node ${nodeId}.`, "canvas.node.stopped", { nodeId }),
							{ ok: true },
						);
					}
					if (action === "stop_all") {
						canvasRuntime.stopAll(graphId);
						return text(pick(getLang(), "已停止整图运行。", "Stopped all runs.", "canvas.run.stopped", {}), {
							ok: true,
						});
					}
					if (action === "steer_node") {
						const message = typeof p.message === "string" ? p.message : "";
						if (!nodeId || !message)
							return text(
								pick(
									getLang(),
									"steer 需要 nodeId + message。",
									"steer needs nodeId + message.",
									"canvas.steer.bad",
									{},
								),
								{ ok: false },
							);
						await canvasRuntime.steerNode(graphId, nodeId, message);
						return text(
							pick(getLang(), `已向节点 ${nodeId} 追问/转向。`, `Steered node ${nodeId}.`, "canvas.steered", {
								nodeId,
							}),
							{ ok: true },
						);
					}
					if (action === "review_node") {
						const decision = p.decision === "reject" ? "reject" : "approve";
						canvasRuntime.reviewNode(graphId, nodeId, decision, typeof p.comment === "string" ? p.comment : undefined);
						return text(
							pick(
								getLang(),
								`已${decision === "approve" ? "批准" : "驳回"}节点 ${nodeId}。`,
								`${decision === "approve" ? "Approved" : "Rejected"} node ${nodeId}.`,
								"canvas.reviewed",
								{
									nodeId,
									decision,
									verdict: decision === "approve" ? "Approved" : "Rejected",
								},
							),
							{ ok: true },
						);
					}
					if (action === "get_log") {
						const entries = canvasRuntime.getNodeLog(graphId, nodeId) as { text?: string }[];
						const tail = entries.slice(-30).map((e) => String(e?.text ?? e).slice(0, 500));
						return text(
							pick(
								getLang(),
								`节点 ${nodeId} 日志 ${entries.length} 条（尾部 ${tail.length}）：\n${tail.join("\n") || "（空）"}`,
								`Node ${nodeId} logs (${entries.length}, last ${tail.length}):\n${tail.join("\n") || "(empty)"}`,
								"canvas.log",
								{
									nodeId,
									count: entries.length,
									shown: tail.length,
									logs: tail.join("\n") || "(empty)",
								},
							),
							{ entries: tail, count: entries.length },
						);
					}
					if (action === "layout_graph") {
						const byId = new Map(graph.nodes.map((n) => [n.id, n]));
						const indeg = new Map(graph.nodes.map((n) => [n.id, 0]));
						for (const e of graph.edges) {
							if (byId.has(e.sourceNodeId) && byId.has(e.targetNodeId)) {
								indeg.set(e.targetNodeId, (indeg.get(e.targetNodeId) ?? 0) + 1);
							}
						}
						const depth = new Map<string, number>();
						const queue: string[] = [];
						for (const [id, d] of indeg)
							if (d === 0) {
								depth.set(id, 0);
								queue.push(id);
							}
						if (queue.length === 0 && graph.nodes[0]) {
							depth.set(graph.nodes[0].id, 0);
							queue.push(graph.nodes[0].id);
						}
						const succ = new Map<string, string[]>();
						for (const e of graph.edges) {
							if (!succ.has(e.sourceNodeId)) succ.set(e.sourceNodeId, []);
							succ.get(e.sourceNodeId)!.push(e.targetNodeId);
						}
						while (queue.length > 0) {
							const cur = queue.shift() as string;
							for (const nx of succ.get(cur) ?? []) {
								const nd = (depth.get(cur) ?? 0) + 1;
								if (nd > (depth.get(nx) ?? -1)) depth.set(nx, nd);
								const left = (indeg.get(nx) ?? 1) - 1;
								indeg.set(nx, left);
								if (left <= 0 && !queue.includes(nx)) queue.push(nx);
							}
						}
						let tail = depth.size > 0 ? Math.max(...depth.values()) : 0;
						for (const n of graph.nodes) {
							if (!depth.has(n.id)) {
								tail += 1;
								depth.set(n.id, tail);
							}
						}
						const layers = new Map<number, CanvasNode[]>();
						for (const n of graph.nodes) {
							const d = depth.get(n.id) ?? 0;
							if (!layers.has(d)) layers.set(d, []);
							layers.get(d)!.push(n);
						}
						for (const [, arr] of layers) {
							arr.forEach((n: CanvasNode, i: number) => {
								n.x = 80 + (depth.get(n.id) ?? 0) * 380;
								n.y = 80 + i * 260;
							});
						}
						saveAndPush(dataDir, graph);
						return text(
							pick(
								getLang(),
								`已重排 ${graph.nodes.length} 个节点（按连线分层，卡片不再叠）。`,
								`Rearranged ${graph.nodes.length} nodes into layers; no more overlap.`,
								"canvas.layout.done",
								{ "graph.nodes.length": graph.nodes.length },
							),
							{ ok: true },
						);
					}
					if (action === "reset_status") {
						canvasRuntime.resetStatus(graph);
						return text(pick(getLang(), "已重置整图状态。", "Reset graph status.", "canvas.reset", {}), { ok: true });
					}
				}
				return text(pick(getLang(), `未知动作：${action}`, `Unknown action: ${action}`, "canvas.unknown", { action }), {
					ok: false,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return text(
					pick(getLang(), `画布操作失败：${msg}`, `Canvas op failed: ${msg}`, "canvas.failed", { msg, error: msg }),
					{ ok: false },
				);
			}
		},
	});
}
