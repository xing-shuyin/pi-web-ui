import { useT } from "../../i18n";
import { formatCanvasMessage } from "./canvas-i18n";
/**
 * CanvasStudio.tsx — 智能体画布工作室 (Canvas Studio) 主视窗。
 *
 * 融合 Multica 数字员工理念、四大异构引擎与 Git Worktree 物理目录隔离。
 */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { toPng } from "html-to-image";
import type {
	CanvasCustomCard,
	CanvasEdge,
	CanvasNodeRole,
	CanvasGraph,
	CanvasGraphSummary,
	CanvasNode,
	CanvasNodeLogEntry,
	ClientMessage,
	ServerMessage,
	ModelInfo,
	ProjectSummary,
	UiMessage,
} from "../../types";
import { CanvasSvgEdges } from "./CanvasSvgEdges";
import { CanvasDraftState, graphRuntimeStatus, mergeGraphRuntime, nodeLogKey, parseGraphImport } from "./canvas-state";
import { composeToComposer, focusComposer } from "../../composer-bridge";
import { randomUuid } from "../../uuid";
import { CanvasAiBar } from "./CanvasAiBar";
import { CanvasTimeline } from "./CanvasTimeline";
import { autoLayout, HistoryStack, computeMinimap, fitCanvasViewport } from "./canvas-p0";
import { CanvasNodeCard } from "./CanvasNodeCard";
import { CanvasNodeDrawer } from "./CanvasNodeDrawer";
import { CanvasToolbar } from "./CanvasToolbar";
import { getSquadTemplates } from "./CanvasTemplates";
import { getRoleMetas, getRoleFields, isRoleImplemented } from "./CanvasTypes";
import { CanvasClient } from "./canvas-client";
import { appSend } from "../../app-globals";
import { FiPlus, FiUsers } from "react-icons/fi";

interface CanvasStudioProps {
	send?: (msg: ClientMessage) => void;
	lastMessage?: ServerMessage | null;
	models?: ModelInfo[];
	defaultModel?: string | null;
	installedSkills?: { name: string; description: string }[];
	projects?: ProjectSummary[];
	workspaceRoots?: string[];
	pathCompletions?: { name: string; path: string; type: "dir" | "file" }[];
	currentCwd?: string;
	active?: boolean;
}

export function CanvasStudio({
	send: propSend,
	lastMessage: propLastMessage,
	models = [],
	defaultModel = null,
	installedSkills = [],
	projects = [],
	workspaceRoots = [],
	pathCompletions = [],
	currentCwd = ".",
	active = true,
}: CanvasStudioProps) {
	const t = useT();
	const ROLE_METAS = useMemo(() => getRoleMetas(t), [t]);
	const ROLE_FIELDS = useMemo(() => getRoleFields(t), [t]);
	const SQUAD_TEMPLATES = useMemo(() => getSquadTemplates(t), [t]);
	const clientRef = useRef<CanvasClient | null>(null);
	const requestTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

	const [graph, setGraph] = useState<CanvasGraph>(() => ({
		id: CanvasClient.readLastGraphId(),
		name: t("canvas.studio.loading"),
		nodes: [],
		edges: [],
		viewport: { x: 60, y: 60, zoom: 1 },
		status: "idle",
		executionMode: "real",
		createdAt: 0,
		updatedAt: 0,
	}));
	const initialLoadComplete = useRef(false);
	const graphRef = useRef(graph);
	graphRef.current = graph;
	const graphIdRef = useRef(graph.id);
	graphIdRef.current = graph.id;
	const [graphList, setGraphList] = useState<CanvasGraphSummary[]>([]);
	const [customCards, setCustomCards] = useState<CanvasCustomCard[]>([]);
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [drawerNodeId, setDrawerNodeId] = useState<string | null>(null);
	const [showTimeline, setShowTimeline] = useState(false);
	const [smartPending, setSmartPending] = useState(false);
	const [, setSmartDag] = useState<null>(null);
	const [nodeLogEntries, setNodeLogEntries] = useState<Record<string, CanvasNodeLogEntry[]>>({});
	const [nodeMessages, setNodeMessages] = useState<Record<string, UiMessage[]>>({});

	const [viewport, setViewport] = useState({ x: 60, y: 60, zoom: 1 });
	const [isPanning, setIsPanning] = useState(false);
	const [panStart, setPanStart] = useState({ x: 0, y: 0, vpX: 0, vpY: 0 });

	const [connectingSource, setConnectingSource] = useState<{
		nodeId: string;
		x: number;
		y: number;
		sourcePort?: string;
	} | null>(null);
	const [portPositions, setPortPositions] = useState<Record<string, Record<string, number>>>({});
	const handlePortPositions = useCallback((nodeId: string, positions: Record<string, number>) => {
		setPortPositions((prev) => {
			const old = prev[nodeId];
			if (old && JSON.stringify(old) === JSON.stringify(positions)) return prev;
			return { ...prev, [nodeId]: positions };
		});
	}, []);
	const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

	const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
	const draftState = useRef(new CanvasDraftState(typeof localStorage === "undefined" ? undefined : localStorage));
	draftState.current.setTranslate(t);
	if (!draftState.current.baseline) draftState.current.loaded(graph);
	const afterSaveRef = useRef<{ graphId: string; action: () => void } | null>(null);
	const [saveNotice, setSaveNotice] = useState("");
	const [draftConflict, setDraftConflict] = useState<CanvasGraph | null>(null);
	const viewportRef = useRef(viewport);
	viewportRef.current = viewport;
	const incomingRef = useRef<(msg: ServerMessage) => void>(() => {});
	const smartTextRef = useRef("");
	const unsavedRef = useRef(false);
	useEffect(() => {
		unsavedRef.current = hasUnsavedChanges;
	}, [hasUnsavedChanges]);

	const canvasRef = useRef<HTMLDivElement>(null);
	const [nodeHeights, setNodeHeights] = useState<Record<string, number>>({});
	const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 });
	useEffect(() => {
		const root = canvasRef.current;
		if (!root || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			setCanvasSize({ width: root.clientWidth, height: root.clientHeight });
			const heights: Record<string, number> = {};
			root.querySelectorAll<HTMLElement>(".canvas-node-card").forEach((el) => {
				if (el.dataset.canvasNodeId)
					heights[el.dataset.canvasNodeId] = el.getBoundingClientRect().height / viewportRef.current.zoom;
			});
			setNodeHeights((prev) => (JSON.stringify(prev) === JSON.stringify(heights) ? prev : heights));
		});
		observer.observe(root);
		root.querySelectorAll(".canvas-node-card").forEach((el) => observer.observe(el));
		return () => observer.disconnect();
	}, [graph.id, graph.nodes.length]);
	const minimap = useMemo(() => computeMinimap(graph.nodes, 160, 100, nodeHeights), [graph.nodes, nodeHeights]);

	const historyRef = useRef(new HistoryStack(50));
	const [, setHistoryVersion] = useState(0);
	const pushHistory = useCallback((g: CanvasGraph) => {
		historyRef.current.push({ nodes: g.nodes, edges: g.edges });
		setHistoryVersion((v) => v + 1);
	}, []);
	const handleUndo = useCallback(() => {
		const prev = historyRef.current.undo({ nodes: graph.nodes, edges: graph.edges });
		if (prev) {
			setGraph((p) => ({ ...p, nodes: prev.nodes, edges: prev.edges, updatedAt: Date.now() }));
			setSelectedNodeId((cur) => (cur && !prev.nodes.some((n) => n.id === cur) ? null : cur));
			setDrawerNodeId((cur) => (cur && !prev.nodes.some((n) => n.id === cur) ? null : cur));
			setHistoryVersion((v) => v + 1);
		}
	}, [graph.nodes, graph.edges]);
	const handleRedo = useCallback(() => {
		const nxt = historyRef.current.redo({ nodes: graph.nodes, edges: graph.edges });
		if (nxt) {
			setGraph((p) => ({ ...p, nodes: nxt.nodes, edges: nxt.edges, updatedAt: Date.now() }));
			setSelectedNodeId((cur) => (cur && !nxt.nodes.some((n) => n.id === cur) ? null : cur));
			setDrawerNodeId((cur) => (cur && !nxt.nodes.some((n) => n.id === cur) ? null : cur));
			setHistoryVersion((v) => v + 1);
		}
	}, [graph.nodes, graph.edges]);

	const sendMessage = useCallback(
		(msg: ClientMessage): boolean => {
			if (msg.type === "canvas_load" && !msg.requestId) msg = draftState.current.beginLoad(msg.id, randomUuid());
			if ((msg.type === "canvas_save" || msg.type === "canvas_load") && msg.requestId) {
				const requestId = msg.requestId;
				requestTimers.current.set(
					requestId,
					setTimeout(() => {
						requestTimers.current.delete(requestId);
						if (draftState.current.fail(requestId, t("canvas.studio.confirmationTimeout"))) {
							afterSaveRef.current = null;
							setSaveNotice(t("canvas.studio.confirmationTimeoutHint"));
						}
					}, 15000),
				);
			}
			if (clientRef.current?.send(msg)) {
				return true;
			}
			if (propSend) {
				propSend(msg);
				return true;
			}
			return appSend(msg);
		},
		[propSend, t],
	);

	useEffect(() => {
		const client = new CanvasClient();
		clientRef.current = client;
		const unsubscribe = client.subscribe((msg) => incomingRef.current(msg));
		const unsubscribeConnection = client.subscribeConnection((connected) => {
			if (connected) return;
			draftState.current.retain({ ...graphRef.current, viewport: viewportRef.current });
			draftState.current.disconnected();
			client.setCurrentGraphId(graphRef.current.id);
			afterSaveRef.current = null;
			for (const timer of requestTimers.current.values()) clearTimeout(timer);
			requestTimers.current.clear();
			setSaveNotice(t("canvas.studio.disconnectedHint"));
		});
		client.onLoadRequest = (request) => {
			draftState.current.pendingLoad = { graphId: request.id, requestId: request.requestId! };
		};
		client.connect();

		return () => {
			unsubscribe();
			unsubscribeConnection();
			for (const timer of requestTimers.current.values()) clearTimeout(timer);
			requestTimers.current.clear();
			client.dispose();
			clientRef.current = null;
		};
	}, []);

	const prevActiveRef = useRef(active);
	useEffect(() => {
		const was = prevActiveRef.current;
		prevActiveRef.current = active;
		if (active && !was) {
			sendMessage({ type: "canvas_list" });
			sendMessage({ type: "canvas_cards" });
			if (
				initialLoadComplete.current &&
				!draftState.current.pendingLoad &&
				!draftState.current.dirty({ ...graphRef.current, viewport: viewportRef.current })
			)
				sendMessage({ type: "canvas_load", id: graphIdRef.current });
		}
	}, [active, sendMessage]);

	const handleIncomingServerMessage = (msg: ServerMessage) => {
		if ((msg.type === "canvas_graph_state" || msg.type === "canvas_error") && msg.requestId) {
			const timer = requestTimers.current.get(msg.requestId);
			if (timer) clearTimeout(timer);
			requestTimers.current.delete(msg.requestId);
		}
		if (msg.type === "canvas_list_result") {
			setGraphList(msg.graphs);
		} else if (msg.type === "canvas_cards_state") {
			setCustomCards(msg.cards ?? []);
		} else if (msg.type === "canvas_error") {
			if (!msg.requestId && msg.code === "execution_error" && msg.graphId === graphIdRef.current) {
				setSaveNotice(t("canvas.studio.runFailed", { name: formatCanvasMessage(msg.messageI18n, msg.message, t) }));
				return;
			}
			const pendingLoad = draftState.current.pendingLoad;
			if (
				msg.code === "not_found" &&
				pendingLoad &&
				pendingLoad.requestId === msg.requestId &&
				pendingLoad.graphId !== "default"
			) {
				draftState.current.fail(msg.requestId, formatCanvasMessage(msg.messageI18n, msg.message, t));
				clientRef.current?.setCurrentGraphId("default");
				setSaveNotice(t("canvas.studio.missingProject"));
				sendMessage(draftState.current.beginLoad("default", randomUuid()));
				return;
			}
			if (draftState.current.fail(msg.requestId, formatCanvasMessage(msg.messageI18n, msg.message, t))) {
				afterSaveRef.current = null;
				if (msg.code === "rev_conflict" && msg.graph?.id === graphIdRef.current) setDraftConflict(msg.graph);
				setSaveNotice(
					t("canvas.studio.operationFailed", { name: formatCanvasMessage(msg.messageI18n, msg.message, t) }),
				);
			}
		} else if (msg.type === "canvas_graph_state") {
			const state = draftState.current;
			const priorBaseline = state.baseline;
			if (state.acceptSave(msg.graph, msg.requestId)) {
				const current = { ...graphRef.current, viewport: viewportRef.current };
				if (current.id !== msg.graph.id) {
					state.baseline = priorBaseline;
					return;
				}
				clientRef.current?.setCurrentGraphId(msg.graph.id);
				setGraph((prev) => ({ ...mergeGraphRuntime(prev, msg.graph), rev: msg.graph.rev }));
				const dirty = state.dirty(current);
				unsavedRef.current = dirty;
				setHasUnsavedChanges(dirty);
				if (dirty) state.retain({ ...current, rev: msg.graph.rev });
				if (!dirty) {
					state.clearDraft(current.id);
					const queued = afterSaveRef.current;
					afterSaveRef.current = null;
					if (queued?.graphId === current.id) queued.action();
				}
				setSaveNotice(dirty ? t("canvas.studio.previousVersionSaved") : t("canvas.studio.saved"));
				return;
			}
			const loading = state.acceptsLoad(msg.graph, msg.requestId);
			if (msg.requestId && !loading) return;
			if (!loading && (msg.graph.id !== graphIdRef.current || state.pendingLoad)) return;
			if (!loading && state.dirty({ ...graphRef.current, viewport: viewportRef.current })) {
				setGraph((prev) => mergeGraphRuntime(prev, msg.graph));
				return;
			}
			if (msg.graph.id !== graphIdRef.current) {
				historyRef.current.clear();
				setHistoryVersion((v) => v + 1);
			}
			if (loading) initialLoadComplete.current = true;
			const normalized = { ...msg.graph, executionMode: "real" as const };
			const local =
				normalized.id === graphRef.current.id
					? { ...graphRef.current, viewport: viewportRef.current }
					: state.draft(normalized.id);
			const reconciled = loading && local ? state.reconcileSave(normalized, local) : null;
			state.loaded(normalized);
			const recovered = loading ? state.draft(normalized.id) : null;
			const next = recovered ? mergeGraphRuntime(recovered, normalized) : normalized;
			clientRef.current?.setCurrentGraphId(next.id);
			setGraph(next);
			graphRef.current = next;
			graphIdRef.current = next.id;
			if (loading) {
				setSelectedNodeId(null);
				setDrawerNodeId(null);
				setConnectingSource(null);
				setPortPositions({});
			}
			unsavedRef.current = state.dirty(next);
			setHasUnsavedChanges(unsavedRef.current);
			const conflict =
				reconciled === "conflict" ||
				(reconciled !== "saved" && recovered && (recovered.rev ?? 0) !== (normalized.rev ?? 0));
			setDraftConflict(conflict ? normalized : null);
			setSaveNotice(
				conflict
					? t("canvas.studio.reconnectedConflict")
					: reconciled === "saved"
						? recovered
							? t("canvas.studio.reconnectedPreviousSaved")
							: t("canvas.studio.reconnectedSaved")
						: recovered
							? t("canvas.studio.draftRestored")
							: "",
			);
			setViewport(next.viewport);
		} else if (msg.type === "canvas_node_event") {
			if (msg.graphId !== graphIdRef.current) return;
			const { nodeId, currentAction, summary, error } = msg;
			setGraph((prev) => {
				const nextNodes = prev.nodes.map((n) => {
					if (n.id !== nodeId) return n;
					return {
						...n,
						currentAction: currentAction ?? n.currentAction,
						currentActionMessage: currentAction !== undefined ? msg.currentActionMessage : n.currentActionMessage,
						errorMessage: error !== undefined ? msg.errorMessage : n.errorMessage,
						lastOutputSummary: summary ?? n.lastOutputSummary,
						error: error ?? n.error,
						status:
							msg.event === "started" || msg.event === "action"
								? "running"
								: msg.event === "done"
									? "done"
									: msg.event === "error"
										? "error"
										: msg.event === "paused"
											? "paused"
											: n.status,
					};
				});
				return { ...prev, nodes: nextNodes, status: graphRuntimeStatus(nextNodes) };
			});
		} else if (msg.type === "canvas_node_log") {
			if (msg.graphId !== graphIdRef.current) return;
			setNodeLogEntries((prev) => ({
				...prev,
				[nodeLogKey(msg.graphId, msg.nodeId)]: [...(prev[nodeLogKey(msg.graphId, msg.nodeId)] ?? []), msg.entry].slice(
					-300,
				),
			}));
		} else if (msg.type === "canvas_node_log_state") {
			if (msg.graphId !== graphIdRef.current) return;
			setNodeLogEntries((prev) => ({ ...prev, [nodeLogKey(msg.graphId, msg.nodeId)]: msg.entries ?? [] }));
			setNodeMessages((prev) => ({ ...prev, [nodeLogKey(msg.graphId, msg.nodeId)]: msg.messages ?? [] }));
		} else if (msg.type === "canvas_node_messages") {
			if (msg.graphId !== graphIdRef.current) return;
			const incoming = [...(msg.messages ?? []), ...(msg.appended ?? [])];
			if (incoming.length === 0) return;
			setNodeMessages((prev) => {
				const seen = new Set((prev[nodeLogKey(msg.graphId, msg.nodeId)] ?? []).map((m) => m.id));
				const merged = [...(prev[nodeLogKey(msg.graphId, msg.nodeId)] ?? [])];
				for (const m of incoming) {
					if (!m || seen.has(m.id)) continue;
					seen.add(m.id);
					merged.push(m);
				}
				return { ...prev, [nodeLogKey(msg.graphId, msg.nodeId)]: merged.slice(-200) };
			});
		}
	};

	incomingRef.current = handleIncomingServerMessage;
	useEffect(() => {
		if (propLastMessage) {
			handleIncomingServerMessage(propLastMessage);
		}
	}, [propLastMessage]);

	const handleSmartGenerate = useCallback((text: string) => {
		smartTextRef.current = text;
		setSmartPending(true);
		setSmartDag(null);
	}, []);
	useEffect(() => {
		const current = { ...graph, viewport };
		const dirty = draftState.current.dirty(current);
		unsavedRef.current = dirty;
		setHasUnsavedChanges(dirty);
		if (dirty && !draftState.current.retain(current)) setSaveNotice(draftState.current.error);
	}, [graph, viewport]);
	useEffect(() => {
		if (
			!hasUnsavedChanges ||
			draftConflict ||
			draftState.current.unknownSaves.has(graph.id) ||
			draftState.current.pendingSave ||
			draftState.current.pendingLoad
		)
			return;
		const timer = setTimeout(() => {
			handleSave();
		}, 30000);
		return () => clearTimeout(timer);
	}, [hasUnsavedChanges, graph, draftConflict]);

	const handleWheel = useCallback((e: React.WheelEvent) => {
		if (!canvasRef.current || !canvasRef.current.contains(e.target as Node)) {
			return;
		}

		const target = e.target as HTMLElement;
		if (
			target.closest(".canvas-node-card") ||
			target.closest(".canvas-toolbar") ||
			target.closest(".canvas-drawer-panel") ||
			target.closest(".canvas-drawer-overlay") ||
			target.closest(".universal-path-menu") ||
			target.closest(".cwd-picker") ||
			target.closest(".dd-menu") ||
			target.closest("button, input, select, textarea, [role='dialog'], [role='menu']")
		) {
			return;
		}

		e.preventDefault();
		const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
		setViewport((prev) => {
			const newZoom = Math.min(Math.max(prev.zoom * zoomFactor, 0.25), 2.0);
			if (!canvasRef.current) return { ...prev, zoom: newZoom };

			const rect = canvasRef.current.getBoundingClientRect();
			const mouseX = e.clientX - rect.left;
			const mouseY = e.clientY - rect.top;

			const newX = mouseX - (mouseX - prev.x) * (newZoom / prev.zoom);
			const newY = mouseY - (mouseY - prev.y) * (newZoom / prev.zoom);

			return { x: Math.round(newX), y: Math.round(newY), zoom: Number(newZoom.toFixed(3)) };
		});
	}, []);

	const handleCanvasPointerDown = (e: React.PointerEvent) => {
		if (e.button !== 0 && e.button !== 1) return;

		if (!canvasRef.current || !canvasRef.current.contains(e.target as Node)) {
			return;
		}

		const target = e.target as HTMLElement;
		if (
			target.closest(".canvas-node-card") ||
			target.closest(".canvas-toolbar") ||
			target.closest(".canvas-drawer-overlay") ||
			target.closest(".canvas-drawer-panel") ||
			target.closest(".canvas-port") ||
			target.closest(".canvas-edge-label-container") ||
			target.closest(".canvas-edge-badge") ||
			target.closest(".universal-path-menu") ||
			target.closest(".cwd-picker") ||
			target.closest(".status-cwd-backdrop") ||
			target.closest(".dd-menu") ||
			target.closest(".canvas-empty-state") ||
			target.closest("button, input, select, textarea, a, [role='dialog'], [role='menu']")
		) {
			return;
		}

		setSelectedNodeId(null);

		setIsPanning(true);
		setPanStart({ x: e.clientX, y: e.clientY, vpX: viewport.x, vpY: viewport.y });
		canvasRef.current.setPointerCapture(e.pointerId);
	};

	const handleCanvasPointerMove = (e: React.PointerEvent) => {
		if (connectingSource && canvasRef.current) {
			const rect = canvasRef.current.getBoundingClientRect();
			const canvasX = (e.clientX - rect.left - viewport.x) / viewport.zoom;
			const canvasY = (e.clientY - rect.top - viewport.y) / viewport.zoom;
			setMousePos({ x: canvasX, y: canvasY });
		}
		if (!isPanning) return;
		const dx = e.clientX - panStart.x;
		const dy = e.clientY - panStart.y;
		setViewport((prev) => ({ ...prev, x: panStart.vpX + dx, y: panStart.vpY + dy }));
	};

	const handleCanvasPointerUp = (e: React.PointerEvent) => {
		if (connectingSource) {
			const port = document
				.elementFromPoint(e.clientX, e.clientY)
				?.closest<HTMLElement>("[data-canvas-port-direction='in']");
			if (port?.dataset.canvasNodeId && canvasRef.current?.contains(port))
				handleEndConnect(port.dataset.canvasNodeId, port.dataset.canvasPort);
			setConnectingSource(null);
			setMousePos(null);
		}
		if (isPanning) {
			setIsPanning(false);
			try {
				canvasRef.current?.releasePointerCapture(e.pointerId);
			} catch {}
		}
	};

	const handleStartConnect = useCallback((nodeId: string, outX: number, outY: number, sourcePort = "result") => {
		setConnectingSource({ nodeId, x: outX, y: outY, sourcePort });
	}, []);

	const handleEndConnect = useCallback(
		(targetNodeId: string, targetPort = "contract") => {
			if (!connectingSource || connectingSource.nodeId === targetNodeId) {
				setConnectingSource(null);
				setMousePos(null);
				return;
			}
			const sourcePort = connectingSource.sourcePort || "result";
			const exists = graph.edges.some(
				(e) =>
					e.sourceNodeId === connectingSource.nodeId &&
					e.targetNodeId === targetNodeId &&
					(e.sourcePort || "result") === sourcePort &&
					(e.targetPort || "contract") === targetPort,
			);
			if (!exists) {
				const byPort: Record<string, CanvasEdge["type"]> = {
					true: "condition_true",
					false: "condition_false",
					approve: "approve",
					reject: "reject",
				};
				const srcRole = graph.nodes.find((n) => n.id === connectingSource.nodeId)?.role;
				const defaultType: CanvasEdge["type"] =
					byPort[sourcePort] ??
					(srcRole === "condition" ? "condition_true" : srcRole === "human" ? "approve" : "handoff");
				const newEdge: CanvasEdge = {
					id: `e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
					sourceNodeId: connectingSource.nodeId,
					targetNodeId,
					type: defaultType,
					sourcePort,
					targetPort,
				};
				pushHistory(graph);
				setGraph((prev) => ({ ...prev, edges: [...prev.edges, newEdge], updatedAt: Date.now() }));
			}
			setConnectingSource(null);
			setMousePos(null);
		},
		[connectingSource, graph, pushHistory],
	);

	const resolveNodeModel = useCallback((requested?: string): string => requested ?? defaultModel ?? "", [defaultModel]);

	const handleAddNode = useCallback(
		(role: CanvasNodeRole = "coder") => {
			const meta = ROLE_METAS[role];
			const needsLlm = meta ? meta.needsLlm : true;
			const nid = "n_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
			const newNode: CanvasNode = {
				id: nid,
				title: meta ? meta.label : t("canvas.defaults.teammate", { count: graph.nodes.length + 1 }),
				role: role,
				x: Math.round(-viewport.x / viewport.zoom + 300 + Math.random() * 100),
				y: Math.round(-viewport.y / viewport.zoom + 200 + Math.random() * 100),
				width: 300,
				engine: "pi",
				model: resolveNodeModel(),
				cwd: currentCwd || ".",
				useWorktree: false,
				status: "idle",
			};
			if (needsLlm && meta && meta.defaultInstruction) newNode.instruction = meta.defaultInstruction;
			const roleDefaults: Record<string, string | number | boolean> = {};
			for (const f of ROLE_FIELDS[role] ?? []) {
				if (f.default !== undefined) roleDefaults[f.key] = f.default;
			}
			if (Object.keys(roleDefaults).length > 0) newNode.config = { ...roleDefaults, ...newNode.config };
			pushHistory(graph);
			setGraph((prev) => ({ ...prev, nodes: [...prev.nodes, newNode], updatedAt: Date.now() }));
			setSelectedNodeId(newNode.id);
		},
		[graph, viewport, resolveNodeModel, currentCwd, pushHistory, t],
	);

	const handlePlaceCard = useCallback(
		(card: CanvasCustomCard) => {
			const nid = "n_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
			const newNode: CanvasNode = {
				id: nid,
				title: card.title,
				role: card.role,
				x: Math.round(-viewport.x / viewport.zoom + 300 + Math.random() * 100),
				y: Math.round(-viewport.y / viewport.zoom + 200 + Math.random() * 100),
				width: 300,
				engine: card.engine ?? "pi",
				model: card.model ?? (card.engine && card.engine !== "pi" ? "" : resolveNodeModel()),
				cwd: currentCwd || ".",
				useWorktree: false,
				status: "idle",
				...(card.instruction ? { instruction: card.instruction } : {}),
				...(card.systemPrompt ? { systemPromptOverride: card.systemPrompt } : {}),
				...(card.config ? { config: { ...card.config } } : {}),
			};
			pushHistory(graph);
			setGraph((prev) => ({ ...prev, nodes: [...prev.nodes, newNode], updatedAt: Date.now() }));
			setSelectedNodeId(newNode.id);
		},
		[graph, viewport, resolveNodeModel, currentCwd, pushHistory],
	);

	const handleDeleteCard = useCallback(
		(id: string) => {
			sendMessage({ type: "canvas_card_delete", id });
		},
		[sendMessage],
	);

	const handleApplyTemplate = useCallback(
		(tmpl: CanvasGraph) => {
			pushHistory(graph);
			const remapped: CanvasGraph = {
				...tmpl,
				nodes: tmpl.nodes.map((n) => ({ ...n, model: resolveNodeModel(n.model) })),
			};
			const current = { ...graphRef.current, viewport: viewportRef.current };
			if (draftState.current.dirty(current) && !draftState.current.retain(current)) {
				setSaveNotice(draftState.current.error);
				return;
			}
			if (draftState.current.pendingSave || draftState.current.pendingLoad) {
				setSaveNotice(t("canvas.studio.waitBeforeTemplate"));
				return;
			}
			setGraph(remapped);
			graphRef.current = remapped;
			setViewport(remapped.viewport);
			sendMessage(draftState.current.beginSave(remapped, randomUuid()));
		},
		[graph, pushHistory, resolveNodeModel, sendMessage, t],
	);

	const activePortsByNode = useMemo(() => {
		const map = new Map<string, { in: string[]; out: string[] }>();
		for (const n of graph.nodes) map.set(n.id, { in: [], out: [] });
		for (const e of graph.edges) {
			map.get(e.targetNodeId)?.in.push(e.targetPort || "contract");
			map.get(e.sourceNodeId)?.out.push(e.sourcePort || "result");
		}
		return map;
	}, [graph.nodes, graph.edges]);

	const incomingPreviewByNode = useMemo(() => {
		const map = new Map<string, string>();
		for (const e of graph.edges) {
			if (!e.lastHandoffSummary) continue;
			const prev = map.get(e.targetNodeId);
			map.set(e.targetNodeId, prev ? `${prev}\n${e.lastHandoffSummary}` : e.lastHandoffSummary);
		}
		return map;
	}, [graph.edges]);

	const handleUpdateEdge = useCallback(
		(edgeId: string, patch: Partial<CanvasEdge>) => {
			pushHistory(graph);
			setGraph((prev) => ({
				...prev,
				edges: prev.edges.map((e) => (e.id === edgeId ? { ...e, ...patch } : e)),
				updatedAt: Date.now(),
			}));
		},
		[graph, pushHistory],
	);

	const exportRef = useRef<HTMLDivElement>(null);
	const handleExportJSON = useCallback(() => {
		const blob = new Blob([JSON.stringify(graph, null, 2)], { type: "application/json" });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `${graph.name || "canvas"}.canvas.json`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 5000);
	}, [graph]);
	const handleExportPNG = useCallback(async () => {
		if (!exportRef.current) return;
		try {
			const url = await toPng(exportRef.current, { pixelRatio: 2, cacheBust: true });
			const a = document.createElement("a");
			a.href = url;
			a.download = `${graph.name || "canvas"}.png`;
			a.click();
		} catch (e) {
			console.error("export png failed", e);
		}
	}, [graph.name]);
	const handleImportJSON = useCallback(() => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".json,application/json";
		input.onchange = () => {
			const f = input.files?.[0];
			if (!f) return;
			const reader = new FileReader();
			reader.onload = () => {
				try {
					const g = parseGraphImport(String(reader.result), true, t);
					handleApplyTemplate(g);
				} catch (e) {
					setSaveNotice(t("canvas.studio.importFailed", { name: e instanceof Error ? e.message : String(e) }));
				}
			};
			reader.readAsText(f);
		};
		input.click();
	}, [handleApplyTemplate, t]);

	const handleDuplicateNode = useCallback(() => {
		if (!selectedNodeId) return;
		const src = graph.nodes.find((n) => n.id === selectedNodeId);
		if (!src) return;
		pushHistory(graph);
		const nid = "n_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
		const copy: CanvasNode = {
			...structuredClone(src),
			id: nid,
			x: src.x + 40,
			y: src.y + 40,
			title: t("canvas.defaults.copyName", { name: src.title }),
			status: "idle",
		};
		setGraph((p) => ({ ...p, nodes: [...p.nodes, copy], updatedAt: Date.now() }));
		setSelectedNodeId(nid);
	}, [graph, selectedNodeId, pushHistory, t]);
	// 一键自动布局
	const handleAutoLayout = useCallback(() => {
		pushHistory(graph);
		setGraph((p) => ({ ...p, nodes: autoLayout(p.nodes, p.edges, nodeHeights), updatedAt: Date.now() }));
	}, [graph, pushHistory, nodeHeights]);

	const handleDeleteNode = useCallback(
		(nodeId: string) => {
			if (connectingSource?.nodeId === nodeId) {
				setConnectingSource(null);
				setMousePos(null);
			}
			const targetNode = graph.nodes.find((n) => n.id === nodeId);
			if (targetNode?.status === "running") {
				sendMessage({ type: "canvas_stop_node", graphId: graph.id, nodeId });
			}
			pushHistory(graph);
			setGraph((prev) => ({
				...prev,
				nodes: prev.nodes.filter((n) => n.id !== nodeId),
				edges: prev.edges.filter((e) => e.sourceNodeId !== nodeId && e.targetNodeId !== nodeId),
				updatedAt: Date.now(),
			}));
			setSelectedNodeId((prev) => (prev === nodeId ? null : prev));
			setDrawerNodeId((prev) => (prev === nodeId ? null : prev));
		},
		[graph, pushHistory, connectingSource, sendMessage],
	);

	const handleDeleteEdge = useCallback(
		(edgeId: string) => {
			pushHistory(graph);
			setGraph((prev) => ({
				...prev,
				edges: prev.edges.filter((e) => e.id !== edgeId),
				updatedAt: Date.now(),
			}));
		},
		[graph, pushHistory],
	);

	const handleUpdateNode = useCallback((nodeId: string, patch: Partial<CanvasNode>) => {
		setGraph((prev) => ({
			...prev,
			nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)),
		}));
	}, []);

	const handleNodeDragStart = useCallback(() => {
		pushHistory(graph);
	}, [graph, pushHistory]);

	const handleSave = useCallback(() => {
		if (draftState.current.unknownSaves.has(graphRef.current.id)) {
			setSaveNotice(t("canvas.studio.unknownSaveResult"));
			return;
		}
		if (draftConflict) {
			setSaveNotice(t("canvas.studio.resolveDraftConflict"));
			return;
		}
		if (draftState.current.pendingSave) return;
		const fullGraph: CanvasGraph = { ...graphRef.current, viewport: viewportRef.current };
		const request = draftState.current.beginSave(fullGraph, randomUuid());
		setSaveNotice(t("canvas.studio.saving"));
		if (!sendMessage(request)) {
			draftState.current.fail(request.requestId, t("canvas.studio.connectionUnavailable"));
			setSaveNotice(t("canvas.studio.saveDisconnected"));
		}
	}, [graph, viewport, sendMessage, draftConflict, t]);

	const handleCreateGraph = useCallback(
		(name: string) => {
			const newGraph: CanvasGraph = {
				id: `graph_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
				name,
				viewport: { x: 60, y: 60, zoom: 1 },
				nodes: [],
				edges: [],
				status: "idle",
				executionMode: "real",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			const current = { ...graphRef.current, viewport: viewportRef.current };
			if (draftState.current.dirty(current) && !draftState.current.retain(current)) {
				setSaveNotice(draftState.current.error);
				return;
			}
			if (draftState.current.pendingSave || draftState.current.pendingLoad) {
				setSaveNotice(t("canvas.studio.waitBeforeCreate"));
				return;
			}
			setGraph(newGraph);
			graphRef.current = newGraph;
			setViewport(newGraph.viewport);
			sendMessage(draftState.current.beginSave(newGraph, randomUuid()));
		},
		[sendMessage, t],
	);

	const handleDeleteGraph = useCallback(
		(id: string) => {
			sendMessage({ type: "canvas_delete", id });
			if (id === graph.id) {
				const remaining = graphList.filter((g) => g.id !== id);
				if (remaining.length > 0) {
					sendMessage({ type: "canvas_load", id: remaining[0].id });
				}
			}
		},
		[sendMessage, graph.id, graphList],
	);

	const handleRenameGraph = useCallback(
		(name: string) => {
			const renamedGraph = { ...graph, name, updatedAt: Date.now() };
			setGraph(renamedGraph);
			if (!draftState.current.pendingSave) sendMessage(draftState.current.beginSave(renamedGraph, randomUuid()));
		},
		[graph, sendMessage],
	);

	const handleFitView = useCallback(() => {
		const rect = canvasRef.current?.getBoundingClientRect();
		if (rect) setViewport(fitCanvasViewport(graph.nodes, rect.width, rect.height, nodeHeights));
	}, [graph.nodes, nodeHeights]);

	const handleRunNodeDirect = useCallback(
		(nodeId: string) => {
			if (!isRoleImplemented(graph.nodes.find((n) => n.id === nodeId)?.role ?? "subflow")) {
				setSaveNotice(t("canvas.studio.nodeUnavailable"));
				return;
			}
			const action = () => sendMessage({ type: "canvas_run_node", graphId: graph.id, nodeId });
			if (
				draftState.current.dirty({ ...graphRef.current, viewport: viewportRef.current }) ||
				draftState.current.pendingSave
			) {
				afterSaveRef.current = { graphId: graph.id, action };
				handleSave();
			} else action();
		},
		[graph, sendMessage, handleSave, t],
	);

	const handleStopNode = useCallback(
		(nodeId: string) => {
			afterSaveRef.current = null;
			sendMessage({ type: "canvas_stop_node", graphId: graph.id, nodeId });
		},
		[graph.id, sendMessage],
	);

	const handleRunAll = useCallback(() => {
		if (graph.nodes.some((n) => !isRoleImplemented(n.role))) {
			setSaveNotice(t("canvas.studio.graphUnavailable"));
			return;
		}
		const action = () => sendMessage({ type: "canvas_run_all", graphId: graph.id });
		if (
			draftState.current.dirty({ ...graphRef.current, viewport: viewportRef.current }) ||
			draftState.current.pendingSave
		) {
			afterSaveRef.current = { graphId: graph.id, action };
			handleSave();
		} else action();
	}, [graph, sendMessage, handleSave, t]);

	const handleStopAll = useCallback(() => {
		afterSaveRef.current = null;
		sendMessage({ type: "canvas_stop_all", graphId: graph.id });
	}, [graph.id, sendMessage]);

	const handleResetStatus = useCallback(() => {
		sendMessage({ type: "canvas_reset_status", graphId: graph.id });
	}, [graph.id, sendMessage]);

	const handleSteer = useCallback(
		(nodeId: string, message: string) => {
			sendMessage({ type: "canvas_steer_node", graphId: graph.id, nodeId, message });
		},
		[graph.id, sendMessage],
	);

	const handleReviewNode = useCallback(
		(nodeId: string, decision: "approve" | "reject", comment?: string) => {
			setGraph((prev) => ({
				...prev,
				nodes: prev.nodes.map((n) =>
					n.id === nodeId
						? {
								...n,
								status: decision === "approve" ? ("done" as const) : ("waiting_approval" as const),
								currentActionMessage: comment?.trim()
									? {
											key:
												decision === "approve"
													? "canvas.runtime.action.reviewApprovedComment"
													: "canvas.runtime.action.reviewRejectedComment",
											vars: { comment: comment.trim().slice(0, 500) },
										}
									: {
											key:
												decision === "approve"
													? "canvas.runtime.action.reviewApproved"
													: "canvas.runtime.action.reviewRejected",
										},
								currentAction:
									comment && comment.trim()
										? decision === "approve"
											? `Human review approved the merge: ${comment.trim().slice(0, 500)}`
											: `Human review rejected: ${comment.trim().slice(0, 500)}`
										: decision === "approve"
											? "Human review approved the merge"
											: "Human review rejected: add tests and comments",
							}
						: n,
				),
			}));
			sendMessage({ type: "canvas_review_node", graphId: graph.id, nodeId, decision, comment });
		},
		[graph.id, sendMessage],
	);

	useEffect(() => {
		if (drawerNodeId && graph.id) {
			sendMessage({ type: "canvas_get_log", graphId: graph.id, nodeId: drawerNodeId });
		}
	}, [drawerNodeId, graph.id, sendMessage]);

	const handleClearNodeLog = useCallback(
		(nodeId: string) => {
			setNodeLogEntries((prev) => ({ ...prev, [nodeLogKey(graph.id, nodeId)]: [] }));
			setNodeMessages((prev) => ({ ...prev, [nodeLogKey(graph.id, nodeId)]: [] }));
			sendMessage({ type: "canvas_clear_log", graphId: graph.id, nodeId });
		},
		[graph.id, sendMessage],
	);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (!active || e.repeat || (e.target instanceof HTMLElement && e.target.isContentEditable)) return;
			const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
			if (tag === "input" || tag === "textarea" || tag === "select") return;

			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
				e.preventDefault();
				if (e.shiftKey) handleRedo();
				else handleUndo();
				return;
			}
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
				e.preventDefault();
				handleRedo();
				return;
			}
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
				e.preventDefault();
				handleDuplicateNode();
				return;
			}
			if ((e.ctrlKey || e.metaKey) && e.key === "s") {
				e.preventDefault();
				handleSave();
				return;
			}

			if ((e.ctrlKey || e.metaKey) && e.key === "0") {
				e.preventDefault();
				handleFitView();
				return;
			}

			if ((e.key === "Delete" || e.key === "Backspace") && selectedNodeId) {
				e.preventDefault();
				handleDeleteNode(selectedNodeId);
				return;
			}

			if (e.key === "Escape") {
				if (connectingSource) {
					setConnectingSource(null);
					setMousePos(null);
					return;
				}
				if (drawerNodeId) {
					setDrawerNodeId(null);
					return;
				}
				if (selectedNodeId) {
					setSelectedNodeId(null);
				}
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [
		active,
		connectingSource,
		selectedNodeId,
		drawerNodeId,
		handleSave,
		handleFitView,
		handleDeleteNode,
		handleUndo,
		handleRedo,
		handleDuplicateNode,
	]);

	const drawerNode = graph.nodes.find((n) => n.id === drawerNodeId) || null;

	const incomingSet = useMemo(() => new Set(graph.edges.map((e) => e.targetNodeId)), [graph.edges]);
	const outgoingSet = useMemo(() => new Set(graph.edges.map((e) => e.sourceNodeId)), [graph.edges]);

	const handleSelectGraph = useCallback(
		(id: string) => {
			if (id === graphIdRef.current && !draftState.current.pendingLoad) return;
			afterSaveRef.current = null;
			const current = { ...graphRef.current, viewport: viewportRef.current };
			if (draftState.current.dirty(current)) {
				if (!draftState.current.retain(current)) {
					setSaveNotice(draftState.current.error);
					return;
				}
				if (!draftConflict && !draftState.current.pendingSave)
					sendMessage(draftState.current.beginSave(current, randomUuid()));
			}
			sendMessage({ type: "canvas_load", id });
		},
		[sendMessage, draftConflict],
	);

	return (
		<div
			className="canvas-studio-root"
			ref={canvasRef}
			onWheel={handleWheel}
			onPointerDownCapture={(e) => {
				if ((e.target as HTMLElement).closest("[data-canvas-port-direction='out']"))
					canvasRef.current?.setPointerCapture(e.pointerId);
			}}
			onPointerDown={handleCanvasPointerDown}
			onPointerMove={handleCanvasPointerMove}
			onPointerUp={handleCanvasPointerUp}
			onPointerCancel={() => {
				setConnectingSource(null);
				setMousePos(null);
				setIsPanning(false);
			}}
			onLostPointerCapture={() => {
				setConnectingSource(null);
				setMousePos(null);
				setIsPanning(false);
			}}
		>
			<CanvasToolbar
				graph={graph}
				graphList={graphList}
				onSelectGraph={handleSelectGraph}
				onSave={handleSave}
				onAddNode={handleAddNode}
				customCards={customCards}
				onPlaceCard={handlePlaceCard}
				onDeleteCard={handleDeleteCard}
				onApplyTemplate={handleApplyTemplate}
				onRunAll={handleRunAll}
				onStopAll={handleStopAll}
				onResetStatus={handleResetStatus}
				onCreateGraph={handleCreateGraph}
				onDeleteGraph={handleDeleteGraph}
				onRenameGraph={handleRenameGraph}
				onFitView={handleFitView}
				onUndo={handleUndo}
				onRedo={handleRedo}
				canUndo={historyRef.current.canUndo}
				canRedo={historyRef.current.canRedo}
				onDuplicate={handleDuplicateNode}
				onAutoLayout={handleAutoLayout}
				zoom={viewport.zoom}
				onZoomChange={(newZoom) => setViewport((prev) => ({ ...prev, zoom: newZoom }))}
				onResetViewport={() => setViewport({ x: 60, y: 60, zoom: 1 })}
				hasUnsavedChanges={hasUnsavedChanges}
			/>

			<div
				ref={exportRef}
				className="canvas-transform-container"
				style={{
					transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom})`,
					transformOrigin: "0 0",
				}}
			>
				<CanvasSvgEdges
					nodes={graph.nodes}
					edges={graph.edges}
					connectingSource={connectingSource}
					mousePos={mousePos}
					portPositions={portPositions}
					onDeleteEdge={handleDeleteEdge}
					onUpdateEdge={handleUpdateEdge}
				/>

				<div className="canvas-nodes-layer">
					{graph.nodes.map((node) => (
						<CanvasNodeCard
							key={node.id}
							node={node}
							zoom={viewport.zoom}
							isSelected={node.id === selectedNodeId}
							hasIncoming={incomingSet.has(node.id)}
							hasOutgoing={outgoingSet.has(node.id)}
							models={models}
							defaultModel={defaultModel}
							installedSkills={installedSkills}
							projects={projects}
							workspaceRoots={workspaceRoots}
							pathCompletions={pathCompletions}
							baseCwd={currentCwd}
							onDragStart={handleNodeDragStart}
							onMakeDir={(p) => sendMessage({ type: "make_dir", path: p })}
							onSelect={setSelectedNodeId}
							onUpdate={handleUpdateNode}
							onDelete={handleDeleteNode}
							onRun={handleRunNodeDirect}
							onStop={handleStopNode}
							onOpenDrawer={setDrawerNodeId}
							onStartConnect={handleStartConnect}
							onEndConnect={handleEndConnect}
							onPortPositions={handlePortPositions}
							activePorts={activePortsByNode.get(node.id)}
							incomingPreview={incomingPreviewByNode.get(node.id)}
						/>
					))}
				</div>
			</div>

			<div className="canvas-dock">
				<CanvasAiBar
					onApply={handleApplyTemplate}
					onSmartGenerate={handleSmartGenerate}
					smartPending={smartPending}
					defaultModel={resolveNodeModel()}
					defaultCwd={currentCwd || "."}
				/>
				{saveNotice && <div role="status">{saveNotice}</div>}
				{draftConflict && (
					<div className="canvas-smart-banner" role="alert">
						<span>{t("canvas.studio.draftConflictHint")}</span>
						<button
							className="canvas-btn"
							onClick={() => {
								setGraph((prev) => ({ ...prev, rev: draftConflict.rev }));
								setDraftConflict(null);
								setSaveNotice(t("canvas.studio.localDraftSelected"));
							}}
						>
							{t("canvas.studio.keepLocalDraft")}
						</button>
						<button
							className="canvas-btn"
							onClick={() => {
								const remote = draftConflict;
								draftState.current.clearDraft(remote.id);
								draftState.current.loaded(remote);
								setGraph(remote);
								setViewport(remote.viewport);
								setDraftConflict(null);
								setSaveNotice(t("canvas.studio.remoteVersionSelected"));
							}}
						>
							{t("canvas.studio.useRemoteVersion")}
						</button>
					</div>
				)}
				{smartPending && (
					<div className="canvas-smart-banner" role="dialog" aria-label={t("canvas.studio.smartBuildTitle")}>
						<span>
							{t("canvas.studio.smartBuildHint")}
							{smartTextRef.current}
						</span>
						<button
							className="canvas-btn primary"
							onClick={() => {
								const text =
									"Use the canvas tool to create a workflow canvas. Check available roles first and preserve ports and configuration. Describe the nodes and connections for review. Do not run it or overwrite existing graphs. Working directory: " +
									currentCwd +
									"\nRequest: " +
									smartTextRef.current;
								if (composeToComposer({ text })) {
									setSmartPending(false);
									setSaveNotice(t("canvas.studio.chatDraftReady"));
									focusComposer();
								} else setSaveNotice(t("canvas.studio.chatNotReady"));
							}}
						>
							{t("canvas.studio.putInChatDraft")}
						</button>
						<button
							className="canvas-btn"
							onClick={() => {
								setSmartPending(false);
								setSaveNotice(t("canvas.studio.smartBuildCancelled"));
							}}
						>
							{t("canvas.common.cancel")}
						</button>
					</div>
				)}
				<div className="canvas-export-bar">
					<button
						type="button"
						className="canvas-dock-btn"
						onClick={handleExportPNG}
						title={t("canvas.studio.exportPng")}
					>
						PNG
					</button>
					<button
						type="button"
						className="canvas-dock-btn"
						onClick={handleExportJSON}
						title={t("canvas.studio.exportJson")}
					>
						JSON
					</button>
					<button
						type="button"
						className="canvas-dock-btn"
						onClick={handleImportJSON}
						title={t("canvas.studio.importJson")}
					>
						{t("canvas.studio.import")}
					</button>
				</div>
			</div>
			{graph.nodes.length === 0 && (
				<div className="canvas-empty-state">
					<div className="canvas-empty-icon">🎨</div>
					<h3 className="canvas-empty-title">{t("canvas.studio.emptyTitle")}</h3>
					<p className="canvas-empty-desc">{t("canvas.studio.emptyHint")}</p>
					<div className="canvas-empty-actions">
						<button type="button" className="canvas-btn primary" onClick={() => handleAddNode("coder")}>
							<FiPlus />
							{t("canvas.studio.addFirstTeammate")}
						</button>
						<button
							type="button"
							className="canvas-btn"
							onClick={() => handleApplyTemplate(SQUAD_TEMPLATES[0].createGraph())}
						>
							<FiUsers />
							{t("canvas.studio.loadTemplate")}
						</button>
					</div>
					<div className="canvas-empty-shortcuts">
						<span>
							<kbd>Ctrl+S</kbd>
							{t("canvas.shortcuts.save")}
						</span>
						<span>
							<kbd>Ctrl+0</kbd>
							{t("canvas.shortcuts.fitView")}
						</span>
						<span>
							<kbd>Delete</kbd>
							{t("canvas.shortcuts.deleteSelected")}
						</span>
						<span>
							<kbd>Esc</kbd>
							{t("canvas.shortcuts.clearSelection")}
						</span>
					</div>
				</div>
			)}

			{graph.nodes.length > 0 && (
				<button
					type="button"
					className="canvas-timeline-toggle"
					onClick={() => setShowTimeline((v) => !v)}
					title={t("canvas.studio.timelineHint")}
				>
					{showTimeline ? t("canvas.studio.collapseTimeline") : t("canvas.studio.timeline")}
				</button>
			)}
			{showTimeline && (
				<CanvasTimeline
					nodes={graph.nodes}
					edges={graph.edges}
					logs={Object.fromEntries(graph.nodes.map((n) => [n.id, nodeLogEntries[nodeLogKey(graph.id, n.id)] ?? []]))}
					onRunNode={handleRunNodeDirect}
					onLocate={(id) => {
						setSelectedNodeId(id);
						setDrawerNodeId(id);
					}}
				/>
			)}

			{graph.nodes.length > 0 && (
				<svg
					className="canvas-minimap"
					width={160}
					height={100}
					viewBox="0 0 160 100"
					role="img"
					aria-label={t("canvas.studio.minimap")}
					style={{ cursor: "crosshair" }}
					onPointerDown={(e) => {
						e.stopPropagation();
						const r = e.currentTarget.getBoundingClientRect();
						const x = (((e.clientX - r.left) * 160) / r.width - minimap.offsetX) / minimap.scale;
						const y = (((e.clientY - r.top) * 100) / r.height - minimap.offsetY) / minimap.scale;
						setViewport((v) => ({ ...v, x: canvasSize.width / 2 - x * v.zoom, y: canvasSize.height / 2 - y * v.zoom }));
					}}
				>
					{minimap.nodes.map((n) => (
						<rect
							key={n.id}
							x={n.x}
							y={n.y}
							width={n.width}
							height={n.height}
							fill={n.id === selectedNodeId ? "var(--accent)" : "var(--text-faint)"}
						/>
					))}
					<rect
						x={minimap.offsetX - (viewport.x / viewport.zoom) * minimap.scale}
						y={minimap.offsetY - (viewport.y / viewport.zoom) * minimap.scale}
						width={(canvasSize.width / viewport.zoom) * minimap.scale}
						height={(canvasSize.height / viewport.zoom) * minimap.scale}
						fill="none"
						stroke="var(--accent)"
						strokeWidth={1}
					/>
				</svg>
			)}
			{drawerNode && (
				<CanvasNodeDrawer
					node={drawerNode}
					edges={graph.edges}
					allNodes={graph.nodes}
					models={models}
					defaultModel={defaultModel}
					projects={projects}
					installedSkills={installedSkills}
					workspaceRoots={workspaceRoots}
					pathCompletions={pathCompletions}
					baseCwd={currentCwd}
					onMakeDir={(p) => sendMessage({ type: "make_dir", path: p })}
					logEntries={drawerNode ? (nodeLogEntries[nodeLogKey(graph.id, drawerNode.id)] ?? []) : []}
					logMessages={drawerNode ? (nodeMessages[nodeLogKey(graph.id, drawerNode.id)] ?? []) : []}
					onClearLog={handleClearNodeLog}
					onUpdateEdge={handleUpdateEdge}
					onClose={() => setDrawerNodeId(null)}
					onUpdate={handleUpdateNode}
					onRun={handleRunNodeDirect}
					onStop={handleStopNode}
					onSteer={handleSteer}
					onReview={handleReviewNode}
				/>
			)}
		</div>
	);
}
