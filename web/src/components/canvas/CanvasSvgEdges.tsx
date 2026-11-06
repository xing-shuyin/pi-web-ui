import { useT } from "../../i18n";
import { getEdgeTypeLabels } from "./canvas-i18n";
/**
 * CanvasSvgEdges.tsx — 画布 SVG 贝塞尔曲线连线层。
 *
 * 采用现代化动态流动发光粒子 (Particle Flow) 取代笨重三角箭头，
 * 支持流动光斑、双层发光光轨、中继胶囊与拉线预览。
 */
import { useMemo, useState, useRef, useEffect } from "react";
import type { CanvasEdge, CanvasNode } from "../../types";
import { PORT_Y_OFFSET, inPortLabel, outPortLabel } from "./CanvasTypes";

interface CanvasSvgEdgesProps {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	connectingSource: { nodeId: string; x: number; y: number; sourcePort?: string } | null;
	mousePos: { x: number; y: number } | null;
	portPositions?: Record<string, Record<string, number>>;
	onDeleteEdge: (edgeId: string) => void;
	onUpdateEdge?: (edgeId: string, patch: Partial<CanvasEdge>) => void;
}

export function CanvasSvgEdges({
	nodes,
	edges,
	connectingSource,
	mousePos,
	portPositions,
	onDeleteEdge,
	onUpdateEdge,
}: CanvasSvgEdgesProps) {
	const t = useT();
	const edgeTypeLabels = getEdgeTypeLabels(t);
	const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
	const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null);
	const [editValue, setEditValue] = useState<string>("");
	const editInputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		editInputRef.current?.focus();
		editInputRef.current?.select();
	}, [editingEdgeId]);
	const [hoverEdgeId, setHoverEdgeId] = useState<string | null>(null);
	const beginEdit = (edge: CanvasEdge) => {
		setEditingEdgeId(edge.id);
		setEditValue(edge.label || "");
	};
	const commitEdit = (edge: CanvasEdge) => {
		const v = editValue.trim().slice(0, 80);
		if (v !== (edge.label || "")) onUpdateEdge?.(edge.id, { label: v });
		setEditingEdgeId(null);
	};

	return (
		<svg className="canvas-svg-layer">
			{edges.map((edge) => {
				const source = nodeMap.get(edge.sourceNodeId);
				const target = nodeMap.get(edge.targetNodeId);
				if (!source || !target) return null;

				const sourceX = source.x + (source.width ?? 300);
				const sourceY = source.y + (portPositions?.[source.id]?.[edge.sourcePort || "result"] ?? PORT_Y_OFFSET);
				const targetX = target.x;
				const targetY = target.y + (portPositions?.[target.id]?.[edge.targetPort || "contract"] ?? PORT_Y_OFFSET);

				const dx = Math.max(Math.abs(targetX - sourceX) * 0.45, 50);
				const d = `M ${sourceX} ${sourceY} C ${sourceX + dx} ${sourceY}, ${targetX - dx} ${targetY}, ${targetX} ${targetY}`;
				const midX = (sourceX + targetX) / 2;
				const midY = (sourceY + targetY) / 2;
				const hasEdgeLabel = !!(edge.label && edge.label.trim());
				const isEditingEdge = editingEdgeId === edge.id;
				const isHoverEdge = hoverEdgeId === edge.id;
				const capsuleW = isEditingEdge || hasEdgeLabel ? 140 : 30;

				const edgeKind = edge.type || "handoff";
				const isReview = edgeKind === "review" || edgeKind === "reject" || edgeKind === "loop_back";
				const isParallel = edgeKind === "parallel";
				const isCondTrue = edgeKind === "condition_true" || edgeKind === "approve";
				const isCondFalse = edgeKind === "condition_false";
				const strokeColor = isReview
					? "var(--amber, #f97316)"
					: isParallel
						? "var(--info-blue, #38bdf8)"
						: isCondTrue
							? "var(--green, #22c55e)"
							: isCondFalse
								? "var(--red, #ef4444)"
								: "var(--accent, #a855f7)";

				const isSourceRunning = source.status === "running";

				return (
					<g
						key={edge.id}
						className="canvas-edge-group"
						onMouseEnter={() => setHoverEdgeId(edge.id)}
						onMouseLeave={() => setHoverEdgeId((cur) => (cur === edge.id ? null : cur))}
						onDoubleClick={(e) => {
							if ((e.target as HTMLElement).closest("button,input")) return;
							beginEdit(edge);
						}}
					>
						<path d={d} fill="none" stroke="transparent" strokeWidth="20" className="canvas-edge-hitbox">
							<title>{t("canvas.edges.editHint")}</title>
						</path>

						{isSourceRunning && (
							<path
								d={d}
								fill="none"
								stroke={strokeColor}
								strokeWidth="6"
								strokeLinecap="round"
								className="canvas-edge-glow"
							/>
						)}

						<path
							d={d}
							fill="none"
							stroke={strokeColor}
							strokeWidth="2"
							strokeLinecap="round"
							className="canvas-edge-track"
						/>

						<path
							d={d}
							fill="none"
							stroke={isSourceRunning ? "var(--accent-contrast, #fff)" : strokeColor}
							strokeWidth={isSourceRunning ? "3" : "2.5"}
							strokeLinecap="round"
							className={`canvas-edge-particles ${isSourceRunning ? "active" : "ambient"} ${isReview ? "review" : ""}`}
						/>

						{(hasEdgeLabel || isHoverEdge || isEditingEdge) && (
							<foreignObject
								x={midX - capsuleW / 2}
								y={midY - 14}
								width={capsuleW}
								height={28}
								className="canvas-edge-label-container"
							>
								<div
									className="canvas-edge-badge"
									style={hasEdgeLabel || isEditingEdge ? undefined : { justifyContent: "center", padding: "2px 4px" }}
									title={edge.label && edge.label.trim() ? undefined : t("canvas.edges.editDeleteHint")}
									onDoubleClick={(e) => {
										if ((e.target as HTMLElement).closest("button,input")) return;
										e.stopPropagation();
										beginEdit(edge);
									}}
								>
									{editingEdgeId === edge.id ? (
										<input
											ref={editInputRef}
											className="canvas-inline-input"
											style={{ width: 110, fontSize: 11 }}
											value={editValue}
											onChange={(e) => setEditValue(e.target.value)}
											onKeyDown={(e) => {
												e.stopPropagation();
												if (e.key === "Enter") commitEdit(edge);
												else if (e.key === "Escape") setEditingEdgeId(null);
											}}
											onBlur={() => commitEdit(edge)}
											onClick={(e) => e.stopPropagation()}
											onPointerDown={(e) => e.stopPropagation()}
											onDoubleClick={(e) => e.stopPropagation()}
											placeholder={t("canvas.edges.notePlaceholder")}
										/>
									) : edge.label && edge.label.trim() ? (
										<span
											className="canvas-edge-text"
											title={
												(edge.label ? edge.label + " ｜ " : "") +
												outPortLabel(edge.sourcePort, t) +
												" → " +
												inPortLabel(edge.targetPort, t) +
												" (" +
												edgeTypeLabels[edge.type] +
												")"
											}
											onDoubleClick={(e) => {
												e.stopPropagation();
												beginEdit(edge);
											}}
										>
											{edge.label}
										</span>
									) : null}
									{isHoverEdge && !isEditingEdge && (
										<button
											type="button"
											className="canvas-edge-del"
											title={t("canvas.edges.delete")}
											onClick={(e) => {
												e.stopPropagation();
												onDeleteEdge(edge.id);
											}}
										>
											×
										</button>
									)}
								</div>
							</foreignObject>
						)}
					</g>
				);
			})}

			{connectingSource && mousePos && (
				<path
					d={`M ${connectingSource.x} ${connectingSource.y} C ${connectingSource.x + 60} ${connectingSource.y}, ${mousePos.x - 60} ${mousePos.y}, ${mousePos.x} ${mousePos.y}`}
					fill="none"
					stroke="var(--accent, #a855f7)"
					strokeWidth="2"
					strokeDasharray="4 4"
					className="canvas-connecting-line"
				/>
			)}
		</svg>
	);
}
