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
import { SQUAD_TEMPLATES } from "./CanvasTemplates";
import { ROLE_METAS, ROLE_FIELDS, isRoleImplemented } from "./CanvasTypes";
import { CanvasClient } from "./canvas-client";
import { canvasText } from "./canvas-i18n";
import { useLocale } from "../../i18n";
import { appSend } from "../../app-globals";
import { FiPlus, FiUsers } from "react-icons/fi";

interface CanvasStudioProps {
	send?: (msg: ClientMessage) => void;
	lastMessage?: ServerMessage | null;
	models?: ModelInfo[];
	/** 全局默认模型（"provider/model-id" 格式），新节点与模板套用的首选模型 */
	defaultModel?: string | null;
	installedSkills?: { name: string; description: string }[];
	projects?: ProjectSummary[];
	workspaceRoots?: string[];
	pathCompletions?: { name: string; path: string; type: "dir" | "file" }[];
	currentCwd?: string;
	/** 是否为当前可见视图：切回画布时触发列表+当前工程刷新，免手动刷新 */
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
	const locale = useLocale();
	const clientRef = useRef<CanvasClient | null>(null);
	const requestTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

	// 画布工程全量状态
	const [graph, setGraph] = useState<CanvasGraph>(() => ({
		id: CanvasClient.readLastGraphId(),
		name: "加载中…",
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
	/** 当前工程 id 镜像：canvas_node_event 按 graphId 过滤，跨工程事件直接丢弃（#706） */
	const graphIdRef = useRef(graph.id);
	graphIdRef.current = graph.id;
	const [graphList, setGraphList] = useState<CanvasGraphSummary[]>([]);
	/** 自定义卡片（AI/用户沉淀，工具栏一键落图） */
	const [customCards, setCustomCards] = useState<CanvasCustomCard[]>([]);
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [drawerNodeId, setDrawerNodeId] = useState<string | null>(null);
	const [showTimeline, setShowTimeline] = useState(false);
	const [smartPending, setSmartPending] = useState(false);
	const [, setSmartDag] = useState<null>(null);
	/** 节点对话流复用：entries=协同事件（steer/handoff/review/tool/error)，messages=与主对话同构的 UiMessage[] */
	const [nodeLogEntries, setNodeLogEntries] = useState<Record<string, CanvasNodeLogEntry[]>>({});
	const [nodeMessages, setNodeMessages] = useState<Record<string, UiMessage[]>>({});

	// 视口平移与缩放 (Pan & Zoom)
	const [viewport, setViewport] = useState({ x: 60, y: 60, zoom: 1 });
	const [isPanning, setIsPanning] = useState(false);
	const [panStart, setPanStart] = useState({ x: 0, y: 0, vpX: 0, vpY: 0 });

	// 正在拉取的临时连线状态
	const [connectingSource, setConnectingSource] = useState<{
		nodeId: string;
		x: number;
		y: number;
		sourcePort?: string;
	} | null>(null);
	/** 各节点字段端子实测纵坐标（相对各自卡片顶部，画布 px）：card 经 onPortPositions 上报，浅比较去重 */
	const [portPositions, setPortPositions] = useState<Record<string, Record<string, number>>>({});
	const handlePortPositions = useCallback((nodeId: string, positions: Record<string, number>) => {
		setPortPositions((prev) => {
			const old = prev[nodeId];
			if (old && JSON.stringify(old) === JSON.stringify(positions)) return prev;
			return { ...prev, [nodeId]: positions };
		});
	}, []);
	const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

	// 未保存更改追踪
	const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
	const draftState = useRef(new CanvasDraftState(typeof localStorage === "undefined" ? undefined : localStorage));
	if (!draftState.current.baseline) draftState.current.loaded(graph);
	const afterSaveRef = useRef<{ graphId: string; action: () => void } | null>(null);
	const [saveNotice, setSaveNotice] = useState("");
	const [draftConflict, setDraftConflict] = useState<CanvasGraph | null>(null);
	const viewportRef = useRef(viewport);
	viewportRef.current = viewport;
	const incomingRef = useRef<(msg: ServerMessage) => void>(() => {});
	const smartTextRef = useRef("");
	/** 未保存标记镜像：远端推送（AI 改图广播）时有本地编辑则不覆盖，防丢用户改动 */
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

	// P0：撤销/重做栈（只记录结构性变更）
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

	// 统一发送消息：优先走画布专用连接（回包就在这条连接上订阅，#switch-race）。
	// 主 WS 只做工程 id 同步追踪，保证重连恢复当前工程（#704）。
	const sendMessage = useCallback(
		(msg: ClientMessage): boolean => {
			if (msg.type === "canvas_load" && !msg.requestId) msg = draftState.current.beginLoad(msg.id, randomUuid());
			if ((msg.type === "canvas_save" || msg.type === "canvas_load") && msg.requestId) {
				const requestId = msg.requestId;
				requestTimers.current.set(
					requestId,
					setTimeout(() => {
						requestTimers.current.delete(requestId);
						if (draftState.current.fail(requestId, "服务器确认超时")) {
							afterSaveRef.current = null;
							setSaveNotice("服务器确认超时，草稿已保留。请重试保存或重新选择工程。");
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
		[propSend],
	);

	// 初始化专用连接并订阅消息
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
			setSaveNotice("画布连接已断开，保存结果未知；草稿已保留，重连后将核对服务器版本。");
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

	/** 切回画布视图时刷新：拉工程列表 + 重载当前工程（AI 在别处改过也能看见） */
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
				setSaveNotice("运行失败：" + msg.message);
				return;
			}
			const pendingLoad = draftState.current.pendingLoad;
			if (
				msg.code === "not_found" &&
				pendingLoad &&
				pendingLoad.requestId === msg.requestId &&
				pendingLoad.graphId !== "default"
			) {
				draftState.current.fail(msg.requestId, msg.message);
				clientRef.current?.setCurrentGraphId("default");
				setSaveNotice("上次工程已不存在，正在加载默认工程。原工程草稿仍保留。");
				sendMessage(draftState.current.beginLoad("default", randomUuid()));
				return;
			}
			if (draftState.current.fail(msg.requestId, msg.message)) {
				afterSaveRef.current = null;
				if (msg.code === "rev_conflict" && msg.graph?.id === graphIdRef.current) setDraftConflict(msg.graph);
				setSaveNotice("操作失败：" + msg.message + "。草稿已保留，请导出备份并核对远端版本。");
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
				setSaveNotice(dirty ? "已保存上一版本；仍有新编辑待保存。" : "保存成功");
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
					? "保存结果核对存在差异，本地草稿已保留。请明确选择本地或远端版本。"
					: reconciled === "saved"
						? recovered
							? "重连核对：上一版本已保存，后续编辑仍保留在草稿。"
							: "重连核对：保存成功。"
						: recovered
							? "已恢复本地未保存草稿，请检查后保存。"
							: "",
			);
			setViewport(next.viewport);
		} else if (msg.type === "canvas_node_event") {
			// 跨工程事件隔离：只处理当前画布工程的节点事件，非同工程直接丢弃（#706）
			if (msg.graphId !== graphIdRef.current) return;
			const { nodeId, currentAction, summary, error } = msg;
			setGraph((prev) => {
				const nextNodes = prev.nodes.map((n) => {
					if (n.id !== nodeId) return n;
					return {
						...n,
						currentAction: currentAction ?? n.currentAction,
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
	// 也响应 props 传入的消息
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
	// 自动保存（30 秒无操作后）
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

	// 处理画布缩放 (以鼠标光标所在点为中心平滑缩放)
	const handleWheel = useCallback((e: React.WheelEvent) => {
		// 1. 如果事件目标不在画布容器的实际 DOM 树内（例如通过 Portal 渲染在 document.body 的目录选择器或模型菜单），坚决不拦截滚轮、不缩放画布
		if (!canvasRef.current || !canvasRef.current.contains(e.target as Node)) {
			return;
		}

		// 2. 如果事件发生在控件、卡片、抽屉面板、工具栏、下拉列表等内部，不缩放画布，保留组件自身默认滚动
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

	// 处理空白区域拖拽平移 (Pan)
	const handleCanvasPointerDown = (e: React.PointerEvent) => {
		if (e.button !== 0 && e.button !== 1) return; // 允许左键或中键拖拽画布

		// 1. 如果事件目标不在画布容器的实际 DOM 树内（例如通过 Portal 渲染在 document.body 的弹窗、下拉菜单），坚决不处理、绝不捕获指针
		if (!canvasRef.current || !canvasRef.current.contains(e.target as Node)) {
			return;
		}

		// 2. 如果点击发生在节点卡片、工具栏、抽屉、端口、弹窗或各类交互控件上，坚决不触发画布平移
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

		// 点击空白区域取消节点选中
		setSelectedNodeId(null);

		setIsPanning(true);
		setPanStart({ x: e.clientX, y: e.clientY, vpX: viewport.x, vpY: viewport.y });
		canvasRef.current.setPointerCapture(e.pointerId);
	};

	const handleCanvasPointerMove = (e: React.PointerEvent) => {
		// 更新连线跟随鼠标位置
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
		// 结束连线操作
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
			} catch {
				// 忽略释放异常
			}
		}
	};

	// 连线操作：端子级（字段级）连线，起点带 sourcePort，终点带 targetPort
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
			// 避免重复连线（同一对端子只连一次；不同端子可并存多条边）
			const exists = graph.edges.some(
				(e) =>
					e.sourceNodeId === connectingSource.nodeId &&
					e.targetNodeId === targetNodeId &&
					(e.sourcePort || "result") === sourcePort &&
					(e.targetPort || "contract") === targetPort,
			);
			if (!exists) {
				// 端子优先定边类型：true/false/approve/reject 端子直接映射；否则按源角色兜底
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

	/** Only new Pi nodes may inherit the selected default. Explicit values, including engine default "", remain unchanged. */
	const resolveNodeModel = useCallback((requested?: string): string => requested ?? defaultModel ?? "", [defaultModel]);

	// 新增节点：支持从通用节点库按角色创建，优先使用全局默认模型。
	// AI 指令（instruction）与角色预设一并落盘，可输入可复用。
	const handleAddNode = useCallback(
		(role: CanvasNodeRole = "coder") => {
			const meta = ROLE_METAS[role];
			const needsLlm = meta ? meta.needsLlm : true;
			const nid = "n_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
			const newNode: CanvasNode = {
				id: nid,
				title: meta
					? canvasText(locale, meta.labelZh, meta.labelEn)
					: canvasText(locale, "队友 ", "Teammate ") + (graph.nodes.length + 1),
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
		[graph, viewport, resolveNodeModel, currentCwd, pushHistory],
	);

	// 自定义卡片落图：标题/角色/指令/人设/模型/行为参数原样展开为普通节点
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

	// 自定义卡片删除（服务端删 + 广播回 state）
	const handleDeleteCard = useCallback(
		(id: string) => {
			sendMessage({ type: "canvas_card_delete", id });
		},
		[sendMessage],
	);

	// 模板和导入工程保留显式模型及空字符串引擎默认值。
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
				setSaveNotice("请等待当前保存或加载确认后再应用模板。");
				return;
			}
			setGraph(remapped);
			graphRef.current = remapped;
			setViewport(remapped.viewport);
			sendMessage(draftState.current.beginSave(remapped, randomUuid()));
		},
		[graph, pushHistory, resolveNodeModel, sendMessage],
	);

	// 每个节点已占用的端子（供卡片端子高亮）：in=被连入的 targetPort，out=被连出的 sourcePort
	const activePortsByNode = useMemo(() => {
		const map = new Map<string, { in: string[]; out: string[] }>();
		for (const n of graph.nodes) map.set(n.id, { in: [], out: [] });
		for (const e of graph.edges) {
			map.get(e.targetNodeId)?.in.push(e.targetPort || "contract");
			map.get(e.sourceNodeId)?.out.push(e.sourcePort || "result");
		}
		return map;
	}, [graph.nodes, graph.edges]);

	// 每个节点的上游交付摘要（结束/汇聚卡片用来展示收到的输出）
	const incomingPreviewByNode = useMemo(() => {
		const map = new Map<string, string>();
		for (const e of graph.edges) {
			if (!e.lastHandoffSummary) continue;
			const prev = map.get(e.targetNodeId);
			map.set(e.targetNodeId, prev ? `${prev}\n${e.lastHandoffSummary}` : e.lastHandoffSummary);
		}
		return map;
	}, [graph.edges]);

	// 更新单条连线（抽屉中重指定端子 / 类型）
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

	// P2：导出 PNG / JSON / 导入 JSON
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
					const g = parseGraphImport(String(reader.result));
					handleApplyTemplate(g);
				} catch (e) {
					setSaveNotice(`导入失败：${e instanceof Error ? e.message : String(e)}`);
				}
			};
			reader.readAsText(f);
		};
		input.click();
	}, [handleApplyTemplate]);

	// 复制/粘贴选中节点
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
			title: src.title + " 副本",
			status: "idle",
		};
		setGraph((p) => ({ ...p, nodes: [...p.nodes, copy], updatedAt: Date.now() }));
		setSelectedNodeId(nid);
	}, [graph, selectedNodeId, pushHistory]);
	// 一键自动布局
	const handleAutoLayout = useCallback(() => {
		pushHistory(graph);
		setGraph((p) => ({ ...p, nodes: autoLayout(p.nodes, p.edges, nodeHeights), updatedAt: Date.now() }));
	}, [graph, pushHistory, nodeHeights]);

	// 删除节点
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

	// 删除连线
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

	// 更新节点属性（本地乐观更新）
	const handleUpdateNode = useCallback((nodeId: string, patch: Partial<CanvasNode>) => {
		setGraph((prev) => ({
			...prev,
			nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)),
		}));
	}, []);

	// 节点卡片拖拽开始前记录快照（支持拖动位置撤回）
	const handleNodeDragStart = useCallback(() => {
		pushHistory(graph);
	}, [graph, pushHistory]);

	// 保存工程
	const handleSave = useCallback(() => {
		if (draftState.current.unknownSaves.has(graphRef.current.id)) {
			setSaveNotice("保存结果未知，请等待重连核对服务器版本。");
			return;
		}
		if (draftConflict) {
			setSaveNotice("请先处理草稿版本冲突。");
			return;
		}
		if (draftState.current.pendingSave) return;
		const fullGraph: CanvasGraph = { ...graphRef.current, viewport: viewportRef.current };
		const request = draftState.current.beginSave(fullGraph, randomUuid());
		setSaveNotice("正在保存，等待服务器确认…");
		if (!sendMessage(request)) {
			draftState.current.fail(request.requestId, "连接不可用");
			setSaveNotice("保存失败：连接不可用。草稿已保留。");
		}
	}, [graph, viewport, sendMessage, draftConflict]);

	// 创建新画布工程
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
				setSaveNotice("请等待当前保存或加载确认后再新建。");
				return;
			}
			setGraph(newGraph);
			graphRef.current = newGraph;
			setViewport(newGraph.viewport);
			sendMessage(draftState.current.beginSave(newGraph, randomUuid()));
		},
		[sendMessage],
	);

	// 删除画布工程
	const handleDeleteGraph = useCallback(
		(id: string) => {
			sendMessage({ type: "canvas_delete", id });
			// 服务端会返回更新后的列表；如果删除的是当前工程，切换到列表中第一个
			if (id === graph.id) {
				const remaining = graphList.filter((g) => g.id !== id);
				if (remaining.length > 0) {
					sendMessage({ type: "canvas_load", id: remaining[0].id });
				}
			}
		},
		[sendMessage, graph.id, graphList],
	);

	// 重命名画布工程
	const handleRenameGraph = useCallback(
		(name: string) => {
			const renamedGraph = { ...graph, name, updatedAt: Date.now() };
			setGraph(renamedGraph);
			if (!draftState.current.pendingSave) sendMessage(draftState.current.beginSave(renamedGraph, randomUuid()));
		},
		[graph, sendMessage],
	);

	// Fit-to-View：自动缩放和平移以适配所有节点
	const handleFitView = useCallback(() => {
		const rect = canvasRef.current?.getBoundingClientRect();
		if (rect) setViewport(fitCanvasViewport(graph.nodes, rect.width, rect.height, nodeHeights));
	}, [graph.nodes, nodeHeights]);

	// 启动单节点：直接用卡片内已填的 AI 指令 / 启动载荷启动（无弹窗）
	const handleRunNodeDirect = useCallback(
		(nodeId: string) => {
			// 服务端 canvas_run_node 读的是**磁盘上的图**（loadCanvasGraph），而模型/指令/cwd
			// 的修改只在本地乐观状态 + 30s 后自动保存 —— 不先刷盘就会用旧模型跑
			// （典型现象：换成 Gemini 后仍报 opencode-go 的错）。
			if (!isRoleImplemented(graph.nodes.find((n) => n.id === nodeId)?.role ?? "subflow")) {
				setSaveNotice("该节点尚未实现，不能运行。");
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
		[graph, sendMessage, handleSave],
	);

	// 停止单节点
	const handleStopNode = useCallback(
		(nodeId: string) => {
			afterSaveRef.current = null;
			sendMessage({ type: "canvas_stop_node", graphId: graph.id, nodeId });
		},
		[graph.id, sendMessage],
	);

	// 全图启动
	const handleRunAll = useCallback(() => {
		if (graph.nodes.some((n) => !isRoleImplemented(n.role))) {
			setSaveNotice("包含尚未实现的节点，不能运行全图。");
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
	}, [graph, sendMessage, handleSave]);

	// 全图停止
	const handleStopAll = useCallback(() => {
		afterSaveRef.current = null;
		sendMessage({ type: "canvas_stop_all", graphId: graph.id });
	}, [graph.id, sendMessage]);

	// 重置全图状态
	const handleResetStatus = useCallback(() => {
		sendMessage({ type: "canvas_reset_status", graphId: graph.id });
	}, [graph.id, sendMessage]);

	// 实时插话 (Steer)
	const handleSteer = useCallback(
		(nodeId: string, message: string) => {
			sendMessage({ type: "canvas_steer_node", graphId: graph.id, nodeId, message });
		},
		[graph.id, sendMessage],
	);

	// 审查门禁裁决（#707）：真协议动作 + 乐观本地回显，服务端回执 graph_state 校准
	const handleReviewNode = useCallback(
		(nodeId: string, decision: "approve" | "reject", comment?: string) => {
			setGraph((prev) => ({
				...prev,
				nodes: prev.nodes.map((n) =>
					n.id === nodeId
						? {
								...n,
								status: decision === "approve" ? ("done" as const) : ("waiting_approval" as const),
								currentAction:
									comment && comment.trim()
										? decision === "approve"
											? `人工审查批准合流：${comment.trim().slice(0, 500)}`
											: `人工驳回：${comment.trim().slice(0, 500)}`
										: decision === "approve"
											? "人工审查批准合流"
											: "人工驳回：需补充完善测试与注释",
							}
						: n,
				),
			}));
			sendMessage({ type: "canvas_review_node", graphId: graph.id, nodeId, decision, comment });
		},
		[graph.id, sendMessage],
	);

	// 打开抽屉即拉取该节点的对话流 + 协同事件（复用当前对话流，调用/错误/协同清晰可见）
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

	// 全局键盘快捷键
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (!active || e.repeat || (e.target instanceof HTMLElement && e.target.isContentEditable)) return;
			// 如果焦点在输入框里，不劫持快捷键
			const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
			if (tag === "input" || tag === "textarea" || tag === "select") return;

			// Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y → 撤销/重做
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
			// Ctrl+D → 复制选中节点
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
				e.preventDefault();
				handleDuplicateNode();
				return;
			}
			// Ctrl+S / Cmd+S → 保存
			if ((e.ctrlKey || e.metaKey) && e.key === "s") {
				e.preventDefault();
				handleSave();
				return;
			}

			// Ctrl+0 → Fit to View
			if ((e.ctrlKey || e.metaKey) && e.key === "0") {
				e.preventDefault();
				handleFitView();
				return;
			}

			// Delete / Backspace → 删除选中节点
			if ((e.key === "Delete" || e.key === "Backspace") && selectedNodeId) {
				e.preventDefault();
				handleDeleteNode(selectedNodeId);
				return;
			}

			// Escape → 取消连线拉取 / 关闭抽屉 / 取消选中
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

	// 获取抽屉对应的当前节点对象
	const drawerNode = graph.nodes.find((n) => n.id === drawerNodeId) || null;

	// 缓存已有输入/输出连线的节点集合，供端口高亮展示
	const incomingSet = useMemo(() => new Set(graph.edges.map((e) => e.targetNodeId)), [graph.edges]);
	const outgoingSet = useMemo(() => new Set(graph.edges.map((e) => e.sourceNodeId)), [graph.edges]);

	// 切换工程：先冻结自动保存避免旧图回写弹回 (#switch-race)
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
			{/* 浮动顶栏控制条 */}
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

			{/* 可缩放平移的画布主容器 */}
			<div
				ref={exportRef}
				className="canvas-transform-container"
				style={{
					transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom})`,
					transformOrigin: "0 0",
				}}
			>
				{/* 底层 SVG 连线图层 */}
				<CanvasSvgEdges
					nodes={graph.nodes}
					edges={graph.edges}
					connectingSource={connectingSource}
					mousePos={mousePos}
					portPositions={portPositions}
					onDeleteEdge={handleDeleteEdge}
					onUpdateEdge={handleUpdateEdge}
				/>

				{/* 顶层 HTML 节点组件图层 */}
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

			{/* 空画布引导状态 */}
			{/* 左下统一底座：AI 生成 + 导入导出 */}
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
						<span>本地草稿与远端版本冲突。保留本地将用当前远端 revision 保存，覆盖远端的结构编辑。</span>
						<button
							className="canvas-btn"
							onClick={() => {
								setGraph((prev) => ({ ...prev, rev: draftConflict.rev }));
								setDraftConflict(null);
								setSaveNotice("已选择保留本地草稿，请检查后保存。");
							}}
						>
							保留本地草稿
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
								setSaveNotice("已采用远端版本。");
							}}
						>
							采用远端版本
						</button>
					</div>
				)}
				{smartPending && (
					<div className="canvas-smart-banner" role="dialog" aria-label="智能建图">
						<span>
							需求将放入主聊天草稿，由你检查并发送；AI 用 canvas 工具新建画布，不运行工作流。需求：
							{smartTextRef.current}
						</span>
						<button
							className="canvas-btn primary"
							onClick={() => {
								const text =
									"请使用 canvas 工具新建工作流画布，先检查可用角色，保留端口与配置；完成后说明节点和连线供我核对。不要运行或覆盖已有图。工作目录：" +
									currentCwd +
									"\n需求：" +
									smartTextRef.current;
								if (composeToComposer({ text })) {
									setSmartPending(false);
									setSaveNotice("已放入主聊天草稿，请切回聊天检查并发送。尚未请求 AI 建图。");
									focusComposer();
								} else setSaveNotice("主聊天输入框尚未就绪，需求已保留；请打开聊天后重试。");
							}}
						>
							放入主聊天草稿
						</button>
						<button
							className="canvas-btn"
							onClick={() => {
								setSmartPending(false);
								setSaveNotice("已取消，未提交建图请求。");
							}}
						>
							取消
						</button>
					</div>
				)}
				<div className="canvas-export-bar">
					<button type="button" className="canvas-dock-btn" onClick={handleExportPNG} title="导出当前画布为 PNG">
						PNG
					</button>
					<button type="button" className="canvas-dock-btn" onClick={handleExportJSON} title="导出为 JSON 备份">
						JSON
					</button>
					<button type="button" className="canvas-dock-btn" onClick={handleImportJSON} title="从 JSON 导入">
						导入
					</button>
				</div>
			</div>
			{graph.nodes.length === 0 && (
				<div className="canvas-empty-state">
					<div className="canvas-empty-icon">🎨</div>
					<h3 className="canvas-empty-title">画布是空的</h3>
					<p className="canvas-empty-desc">添加数字员工或加载一个战队模板来开始协作</p>
					<div className="canvas-empty-actions">
						<button type="button" className="canvas-btn primary" onClick={() => handleAddNode("coder")}>
							<FiPlus /> 添加第一个队友
						</button>
						<button
							type="button"
							className="canvas-btn"
							onClick={() => handleApplyTemplate(SQUAD_TEMPLATES[0].createGraph())}
						>
							<FiUsers /> 快速加载模板
						</button>
					</div>
					<div className="canvas-empty-shortcuts">
						<span>
							<kbd>Ctrl+S</kbd> 保存
						</span>
						<span>
							<kbd>Ctrl+0</kbd> 适配视图
						</span>
						<span>
							<kbd>Delete</kbd> 删除选中
						</span>
						<span>
							<kbd>Esc</kbd> 取消选择
						</span>
					</div>
				</div>
			)}

			{graph.nodes.length > 0 && (
				<button
					type="button"
					className="canvas-timeline-toggle"
					onClick={() => setShowTimeline((v) => !v)}
					title="执行时间线 / 失败重试"
				>
					{showTimeline ? "⏱ 收起" : "⏱ 时间线"}
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
					aria-label="画布小地图"
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
			{/* 单个数字员工审查与深控抽屉（仅选中节点时挂载） */}
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
