/**
 * CanvasToolbar.tsx — 画布协作工作室顶部浮动控制栏。
 *
 * 功能区：工程管理 | 通用节点库 + 战队模板 | 调度控制 | 视口缩放
 */
import { useMemo, useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { useFloatingPanel } from "../../use-floating-panel";
import type { CanvasCustomCard, CanvasGraph, CanvasGraphSummary, CanvasNodeRole } from "../../types";
import { getSquadTemplates } from "./CanvasTemplates";
import { getRoleGroups, getRoleMetas, isRoleImplemented } from "./CanvasTypes";
import {
	FiPlus,
	FiPlay,
	FiSquare,
	FiRotateCcw,
	FiZoomIn,
	FiZoomOut,
	FiMaximize2,
	FiUsers,
	FiFolder,
	FiSave,
	FiTrash2,
	FiEdit3,
	FiFilePlus,
	FiTarget,
} from "react-icons/fi";

export interface CanvasToolbarProps {
	graph: CanvasGraph;
	graphList: CanvasGraphSummary[];
	onSelectGraph: (id: string) => void;
	onSave: () => void;
	onAddNode: (role?: CanvasNodeRole) => void;
	customCards?: CanvasCustomCard[];
	onPlaceCard?: (card: CanvasCustomCard) => void;
	onDeleteCard?: (id: string) => void;
	onApplyTemplate: (templateGraph: CanvasGraph) => void;
	onRunAll: () => void;
	onStopAll: () => void;
	onResetStatus: () => void;
	onCreateGraph: (name: string) => void;
	onDeleteGraph: (id: string) => void;
	onRenameGraph: (name: string) => void;
	onFitView: () => void;
	onUndo: () => void;
	onRedo: () => void;
	canUndo?: boolean;
	canRedo?: boolean;
	onDuplicate: () => void;
	onAutoLayout: () => void;
	zoom: number;
	onZoomChange: (newZoom: number) => void;
	onResetViewport: () => void;
	hasUnsavedChanges?: boolean;
}

export function CanvasToolbar({
	graph,
	graphList,
	onSelectGraph,
	onSave,
	onAddNode,
	customCards = [],
	onPlaceCard,
	onDeleteCard,
	onApplyTemplate,
	onRunAll,
	onStopAll,
	onResetStatus,
	onCreateGraph,
	onDeleteGraph,
	onRenameGraph,
	onFitView,
	onUndo,
	onRedo,
	canUndo,
	canRedo,
	onDuplicate,
	onAutoLayout,
	zoom,
	onZoomChange,
	onResetViewport,
	hasUnsavedChanges,
}: CanvasToolbarProps) {
	const t = useT();
	const ROLE_METAS = useMemo(() => getRoleMetas(t), [t]);
	const NODE_GROUPS = useMemo(() => getRoleGroups(t), [t]);
	const SQUAD_TEMPLATES = useMemo(() => getSquadTemplates(t), [t]);
	const [showSquadMenu, setShowSquadMenu] = useState(false);
	const [showGraphMenu, setShowGraphMenu] = useState(false);
	const [showNodeMenu, setShowNodeMenu] = useState(false);
	const [renamingGraph, setRenamingGraph] = useState(false);
	const [renameValue, setRenameValue] = useState("");
	const [creatingGraph, setCreatingGraph] = useState(false);
	const [createValue, setCreateValue] = useState("");

	const squadMenuRef = useRef<HTMLDivElement>(null);
	const graphMenuRef = useRef<HTMLDivElement>(null);
	const nodeMenuRef = useRef<HTMLDivElement>(null);
	const renameInputRef = useRef<HTMLInputElement>(null);
	const createInputRef = useRef<HTMLInputElement>(null);

	const graphPanel = useFloatingPanel({
		open: showGraphMenu,
		anchor: graphMenuRef,
		align: "left",
		onClose: () => setShowGraphMenu(false),
	});
	const nodePanel = useFloatingPanel({
		open: showNodeMenu,
		anchor: nodeMenuRef,
		align: "left",
		onClose: () => setShowNodeMenu(false),
	});
	const squadPanel = useFloatingPanel({
		open: showSquadMenu,
		anchor: squadMenuRef,
		align: "left",
		onClose: () => setShowSquadMenu(false),
	});
	useEffect(() => {
		if (renamingGraph && renameInputRef.current) {
			renameInputRef.current.focus();
			renameInputRef.current.select();
		}
	}, [renamingGraph]);

	useEffect(() => {
		if (creatingGraph && createInputRef.current) {
			createInputRef.current.focus();
		}
	}, [creatingGraph]);

	const handleRenameSubmit = () => {
		const trimmed = renameValue.trim();
		if (trimmed && trimmed !== graph.name) {
			onRenameGraph(trimmed);
		}
		setRenamingGraph(false);
	};

	const handleCreateSubmit = () => {
		const trimmed = createValue.trim();
		if (trimmed) {
			onCreateGraph(trimmed);
		}
		setCreatingGraph(false);
		setCreateValue("");
	};

	const handleDeleteCurrentGraph = () => {
		if (graphList.length <= 1) return; // 至少保留一个工程
		const confirmed = window.confirm(t("canvas.toolbar.deleteProjectConfirm", { name: graph.name }));
		if (confirmed) {
			onDeleteGraph(graph.id);
		}
	};

	return (
		<div className="canvas-toolbar">
			<div className="canvas-toolbar-group">
				<FiFolder className="canvas-toolbar-icon" />

				{renamingGraph ? (
					<input
						ref={renameInputRef}
						className="canvas-toolbar-rename-input"
						value={renameValue}
						onChange={(e) => setRenameValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") handleRenameSubmit();
							else if (e.key === "Escape") setRenamingGraph(false);
						}}
						onBlur={handleRenameSubmit}
						placeholder={t("canvas.toolbar.projectName")}
					/>
				) : (
					<select
						className="canvas-toolbar-select"
						value={graph.id}
						onChange={(e) => onSelectGraph(e.target.value)}
						title={t("canvas.toolbar.switchProject")}
					>
						{graphList.map((g) => (
							<option key={g.id} value={g.id}>
								{t("canvas.toolbar.projectOption", { name: g.name, count: g.nodeCount })}
							</option>
						))}
					</select>
				)}

				<div className="canvas-dropdown-wrap" ref={graphMenuRef}>
					<button
						type="button"
						className="canvas-toolbar-btn"
						onClick={() => setShowGraphMenu(!showGraphMenu)}
						title={t("canvas.toolbar.projectMenu")}
					>
						▾
					</button>
					{showGraphMenu &&
						createPortal(
							<div
								ref={graphPanel.panelRef}
								style={graphPanel.style}
								className="canvas-dropdown-menu"
								onPointerDown={(e) => e.stopPropagation()}
								onMouseDown={(e) => e.stopPropagation()}
								onWheel={(e) => e.stopPropagation()}
							>
								{creatingGraph ? (
									<div className="canvas-dropdown-item canvas-inline-create" onPointerDown={(e) => e.stopPropagation()}>
										<input
											ref={createInputRef}
											className="canvas-inline-input"
											value={createValue}
											onChange={(e) => setCreateValue(e.target.value)}
											onKeyDown={(e) => {
												if (e.key === "Enter") {
													handleCreateSubmit();
													setShowGraphMenu(false);
												} else if (e.key === "Escape") {
													setCreatingGraph(false);
												}
											}}
											placeholder={t("canvas.toolbar.newProjectPlaceholder")}
											onClick={(e) => e.stopPropagation()}
										/>
										<button
											type="button"
											className="canvas-inline-confirm"
											onClick={(e) => {
												e.stopPropagation();
												handleCreateSubmit();
												setShowGraphMenu(false);
											}}
										>
											✓
										</button>
									</div>
								) : (
									<button type="button" className="canvas-dropdown-item" onClick={() => setCreatingGraph(true)}>
										<b>
											<FiFilePlus style={{ verticalAlign: "middle" }} />
											{t("canvas.toolbar.newProject")}
										</b>
										<small>{t("canvas.toolbar.newProjectHint")}</small>
									</button>
								)}
								<button
									type="button"
									className="canvas-dropdown-item"
									onClick={() => {
										setRenameValue(graph.name);
										setRenamingGraph(true);
										setShowGraphMenu(false);
									}}
								>
									<b>
										<FiEdit3 style={{ verticalAlign: "middle" }} />
										{t("canvas.toolbar.renameProject")}
									</b>
									<small>{t("canvas.toolbar.renameProjectHint", { name: graph.name })}</small>
								</button>
								<button
									type="button"
									className="canvas-dropdown-item canvas-dropdown-item-danger"
									onClick={() => {
										handleDeleteCurrentGraph();
										setShowGraphMenu(false);
									}}
									disabled={graphList.length <= 1}
									title={graphList.length <= 1 ? t("canvas.toolbar.keepOneProject") : ""}
								>
									<b>
										<FiTrash2 style={{ verticalAlign: "middle" }} />
										{t("canvas.toolbar.deleteProject")}
									</b>
									<small>
										{graphList.length <= 1
											? t("canvas.toolbar.cannotDeleteLastProject")
											: t("canvas.toolbar.deleteProjectHint", { name: graph.name })}
									</small>
								</button>
							</div>,
							document.body,
						)}
				</div>

				<button
					type="button"
					className={`canvas-toolbar-btn ${hasUnsavedChanges ? "canvas-unsaved" : ""}`}
					onClick={onSave}
					title={hasUnsavedChanges ? t("canvas.toolbar.unsavedHint") : t("canvas.toolbar.saveHint")}
				>
					<FiSave />
				</button>
			</div>

			<div className="canvas-toolbar-divider" />

			<div className="canvas-toolbar-group">
				<button
					type="button"
					className="canvas-toolbar-btn primary"
					onClick={() => onAddNode("coder")}
					title={t("canvas.toolbar.quickAddHint")}
				>
					<FiPlus /> {t("canvas.toolbar.addTeammate")}
				</button>

				<div className="canvas-dropdown-wrap" ref={nodeMenuRef}>
					<button
						type="button"
						className="canvas-toolbar-btn"
						onClick={() => setShowNodeMenu(!showNodeMenu)}
						title={t("canvas.toolbar.availableNodesUnimplementedRolesAreHidden")}
					>
						{t("canvas.toolbar.nodeLibrary")} ▾
					</button>

					{showNodeMenu &&
						createPortal(
							<div
								ref={nodePanel.panelRef}
								style={nodePanel.style}
								className="canvas-dropdown-menu canvas-node-palette"
								onPointerDown={(e) => e.stopPropagation()}
								onMouseDown={(e) => e.stopPropagation()}
								onWheel={(e) => e.stopPropagation()}
							>
								{customCards.length > 0 && (
									<div className="canvas-palette-group">
										<div className="canvas-palette-group-title">
											{t("canvas.toolbar.customCardsCount", { count: customCards.length })}
										</div>
										{customCards.map((c) => (
											<div
												key={c.id}
												className="canvas-dropdown-item"
												style={{ display: "flex", alignItems: "center", gap: 6 }}
											>
												<button
													type="button"
													style={{ flex: 1, textAlign: "left", background: "none", border: "none", cursor: "pointer" }}
													onClick={() => {
														onPlaceCard?.(c);
														setShowNodeMenu(false);
													}}
													title={
														(ROLE_METAS[c.role]?.label ?? c.role) +
														(c.instruction ? ": " + c.instruction.slice(0, 80) : "")
													}
												>
													<b>🧩 {c.title}</b>
													<small>{ROLE_METAS[c.role]?.label ?? c.role}</small>
												</button>
												<button
													type="button"
													className="canvas-toolbar-btn"
													onClick={() => onDeleteCard?.(c.id)}
													title={t("canvas.toolbar.deleteCard", { name: c.title })}
												>
													×
												</button>
											</div>
										))}
									</div>
								)}
								{NODE_GROUPS.map((g) => (
									<div key={g.id} className="canvas-palette-group">
										<div className="canvas-palette-group-title">{g.label}</div>
										{(Object.values(ROLE_METAS) as (typeof ROLE_METAS)[keyof typeof ROLE_METAS][])
											.filter((m) => m.group === g.id && isRoleImplemented(m.role))
											.map((m) => (
												<button
													key={m.role}
													type="button"
													className="canvas-dropdown-item"
													onClick={() => {
														onAddNode(m.role);
														setShowNodeMenu(false);
													}}
													title={m.blurb}
												>
													<b>
														<span style={{ marginRight: 6 }}>{m.icon}</span>
														{m.label}
													</b>
													<small>{m.blurb}</small>
												</button>
											))}
									</div>
								))}
							</div>,
							document.body,
						)}
				</div>

				<div className="canvas-dropdown-wrap" ref={squadMenuRef}>
					<button
						type="button"
						className="canvas-toolbar-btn"
						onClick={() => setShowSquadMenu(!showSquadMenu)}
						title={t("canvas.toolbar.loadASequentialWorkflowReviewTasksAndAcceptance")}
					>
						<FiUsers /> {t("canvas.toolbar.sequentialTemplates")} ▾
					</button>

					{showSquadMenu &&
						createPortal(
							<div
								ref={squadPanel.panelRef}
								style={squadPanel.style}
								className="canvas-dropdown-menu"
								onPointerDown={(e) => e.stopPropagation()}
								onMouseDown={(e) => e.stopPropagation()}
								onWheel={(e) => e.stopPropagation()}
							>
								{SQUAD_TEMPLATES.map((tmpl) => (
									<button
										key={tmpl.id}
										type="button"
										className="canvas-dropdown-item"
										onClick={() => {
											onApplyTemplate(tmpl.createGraph());
											setShowSquadMenu(false);
										}}
									>
										<b>{tmpl.title}</b>
										<small>{tmpl.desc}</small>
									</button>
								))}
							</div>,
							document.body,
						)}
				</div>
			</div>

			<div className="canvas-toolbar-divider" />

			<div className="canvas-toolbar-group">
				{graph.status === "running" ? (
					<button
						type="button"
						className="canvas-toolbar-btn stop"
						onClick={onStopAll}
						title={t("canvas.toolbar.stopAll")}
					>
						<FiSquare /> {t("canvas.toolbar.stopAll")}
					</button>
				) : (
					<button
						type="button"
						className="canvas-toolbar-btn run"
						disabled={graph.nodes.some((n) => !isRoleImplemented(n.role))}
						onClick={onRunAll}
						title={t("canvas.toolbar.startSquad")}
					>
						<FiPlay /> {t("canvas.toolbar.runWorkflow")}
					</button>
				)}

				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={onResetStatus}
					title={t("canvas.toolbar.resetHint")}
				>
					<FiRotateCcw />
					{t("canvas.toolbar.reset")}
				</button>
			</div>

			<div className="canvas-toolbar-divider" />

			<div className="canvas-toolbar-group">
				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={onUndo}
					disabled={canUndo === false}
					title={t("canvas.toolbar.undo")}
				>
					↩
				</button>
				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={onRedo}
					disabled={canRedo === false}
					title={t("canvas.toolbar.redo")}
				>
					↪
				</button>
				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={onDuplicate}
					title={t("canvas.toolbar.duplicateNode")}
				>
					⧉
				</button>
				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={onAutoLayout}
					title={t("canvas.toolbar.autoLayout")}
				>
					⛶
				</button>
			</div>

			<div className="canvas-toolbar-divider" />

			<div className="canvas-toolbar-group">
				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={() => onZoomChange(Math.max(zoom - 0.15, 0.25))}
					title={t("canvas.toolbar.zoomOut")}
				>
					<FiZoomOut />
				</button>
				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={onResetViewport}
					title={t("canvas.toolbar.resetZoom")}
				>
					<FiMaximize2 /> {Math.round(zoom * 100)}%
				</button>
				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={() => onZoomChange(Math.min(zoom + 0.15, 2.0))}
					title={t("canvas.toolbar.zoomIn")}
				>
					<FiZoomIn />
				</button>
				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={onFitView}
					title={t("canvas.toolbar.fitAllNodes")}
				>
					<FiTarget />
				</button>
			</div>
		</div>
	);
}
