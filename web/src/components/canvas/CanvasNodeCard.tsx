import { useState, useMemo, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { CanvasEngineId, CanvasNode, ModelInfo, ProjectSummary } from "../../types";
import type { ThinkingValue } from "../../thinking-levels";
import {
	getEngineMetas,
	getRoleMetas,
	getRoleIoHelp,
	getStatusMetas,
	PORT_Y_OFFSET,
	roleNeedsInstruction,
	outPortsForRole,
	getInPortDefs,
	visibleRoleFields,
	roleCapabilityNotice,
	isRoleImplemented,
} from "./CanvasTypes";
import type { RoleField } from "./CanvasTypes";
import type { ReactNode } from "react";
import { useT } from "../../i18n";
import { formatCanvasMessage } from "./canvas-i18n";
import { ModelThinking } from "../ModelThinking";
import { UniversalPathPicker } from "../UniversalPathPicker";
import { FiPlay, FiSquare, FiSliders, FiTrash2, FiGitBranch, FiCpu } from "react-icons/fi";

export interface CanvasNodeCardProps {
	zoom?: number;
	node: CanvasNode;
	isSelected: boolean;
	hasIncoming?: boolean;
	hasOutgoing?: boolean;
	models: ModelInfo[];
	defaultModel?: string | null;
	installedSkills?: { name: string; description: string }[];
	projects: ProjectSummary[];
	workspaceRoots?: string[];
	pathCompletions?: { name: string; path: string; type: "dir" | "file" }[];
	baseCwd?: string;
	onMakeDir?: (path: string) => void;
	onSelect: (nodeId: string) => void;
	onUpdate: (nodeId: string, patch: Partial<CanvasNode>) => void;
	onDelete: (nodeId: string) => void;
	onRun: (nodeId: string) => void;
	onStop: (nodeId: string) => void;
	onOpenDrawer: (nodeId: string) => void;
	onStartConnect: (nodeId: string, outX: number, outY: number, sourcePort?: string) => void;
	onEndConnect: (nodeId: string, targetPort?: string) => void;
	onDragStart?: () => void;
	onPortPositions?: (nodeId: string, positions: Record<string, number>) => void;
	activePorts?: { in: string[]; out: string[] };
	incomingPreview?: string;
}

export function CanvasNodeCard({
	node,
	zoom = 1,
	isSelected,
	hasIncoming,
	hasOutgoing,
	models,
	defaultModel,
	installedSkills = [],
	projects,
	workspaceRoots = [],
	pathCompletions = [],
	baseCwd,
	onMakeDir,
	onSelect,
	onUpdate,
	onDelete,
	onRun,
	onStop,
	onOpenDrawer,
	onStartConnect,
	onEndConnect,
	onPortPositions,
	activePorts,
	incomingPreview,
	onDragStart,
}: CanvasNodeCardProps) {
	const t = useT();
	const ENGINE_METAS = useMemo(() => getEngineMetas(t), [t]);
	const ROLE_METAS = useMemo(() => getRoleMetas(t), [t]);
	const ROLE_IO_HELP = useMemo(() => getRoleIoHelp(t), [t]);
	const IN_PORT_DEFS = useMemo(() => getInPortDefs(t), [t]);
	const STATUS_METAS = useMemo(() => getStatusMetas(t), [t]);
	const [isDragging, setIsDragging] = useState(false);
	const [dragStart, setDragStart] = useState({ x: 0, y: 0, nodeX: 0, nodeY: 0 });
	const hasMovedRef = useRef(false);

	const engineMeta = ENGINE_METAS[node.engine] || ENGINE_METAS.pi;
	const roleMeta = ROLE_METAS[node.role] || ROLE_METAS.coder;
	const ioHelp = ROLE_IO_HELP[node.role] ?? ROLE_IO_HELP.custom;
	const statusColor = STATUS_METAS[node.status] || STATUS_METAS.idle;
	const actionText = formatCanvasMessage(node.currentActionMessage, node.currentAction, t);
	const errorText = formatCanvasMessage(node.errorMessage, node.error, t);

	const selectedModelObj = useMemo(() => {
		const raw = node.model;
		const canonical = (m: { provider: string; id: string }) =>
			m.id.startsWith(`${m.provider}/`) ? m.id : `${m.provider}/${m.id}`;
		const normRaw = (() => {
			const s = (raw ?? "").trim();
			const i = s.indexOf("/");
			if (i <= 0) return s;
			const p = s.slice(0, i);
			let rest = s.slice(i + 1);
			while (rest.startsWith(`${p}/`)) rest = rest.slice(p.length + 1);
			return `${p}/${rest}`;
		})();
		const found = models.find((m) => canonical(m) === normRaw || m.id === normRaw);
		if (found) return found;
		if (defaultModel) {
			const def = models.find((m) => `${m.provider}/${m.id}` === defaultModel || m.id === defaultModel);
			if (def) return def;
		}
		if (models.length > 0) return models[0];
		const parts = raw.split("/");
		return {
			id: raw,
			name: parts.length > 1 ? parts.slice(1).join("/") : raw,
			provider: parts.length > 1 ? parts[0] : "custom",
		} as ModelInfo;
	}, [node.model, models, defaultModel]);

	const cardRef = useRef<HTMLDivElement>(null);
	const branchOutPorts = useMemo(() => outPortsForRole(node.role, t).filter((d) => d.key !== "result"), [node.role, t]);
	/** 纯代码节点（触发器 / 逻辑控制 / 格式转换等）不走 LLM：隐藏引擎模型目录，只露专属配置 */
	const isAgent = roleNeedsInstruction(node.role);
	const inPortTip = (key: string) => {
		const def = IN_PORT_DEFS.find((d) => d.key === key);
		return t("canvas.node.inputPort", { name: def?.label ?? key, description: def?.desc ?? "" });
	};
	const outPortTip = (key: string) => {
		const def = outPortsForRole(node.role, t).find((d) => d.key === key);
		return t("canvas.node.outputPort", { name: def?.label ?? key, description: def?.desc ?? "" });
	};

	const setCfg = (patch: Record<string, string | number | boolean>) =>
		onUpdate(node.id, { config: { ...node.config, ...patch } });
	const roleCfg = (node.config ?? {}) as Record<string, string | number | boolean | undefined>;
	const renderRoleField = (f: RoleField, withPort = false) => {
		if (f.kind === "hint") {
			return (
				<span key={f.key} className="canvas-muted-note">
					{f.label}
				</span>
			);
		}
		const strVal = String(roleCfg[f.key] ?? f.default ?? "");
		let control: ReactNode = null;
		if (f.kind === "textarea") {
			control = (
				<textarea
					className="canvas-instruction-input"
					rows={f.rows ?? 3}
					value={strVal}
					onChange={(e) => setCfg({ [f.key]: e.target.value })}
					placeholder={f.placeholder}
				/>
			);
		} else if (f.kind === "number") {
			control = (
				<input
					type="number"
					min={f.min}
					max={f.max}
					className="canvas-input"
					style={{ width: "100%" }}
					value={Number(roleCfg[f.key] ?? f.default ?? 0)}
					onChange={(e) => {
						const raw = Number(e.target.value);
						const v = Number.isFinite(raw) ? raw : Number(f.default ?? 0);
						const lo = f.min ?? Number.NEGATIVE_INFINITY;
						const hi = f.max ?? Number.POSITIVE_INFINITY;
						setCfg({ [f.key]: Math.max(lo, Math.min(hi, v)) });
					}}
				/>
			);
		} else if (f.kind === "select") {
			if (f.key === "skillName") {
				control = (
					<select
						className="canvas-select"
						style={{ width: "100%" }}
						value={strVal}
						onChange={(e) => setCfg({ [f.key]: e.target.value })}
					>
						{installedSkills && installedSkills.length > 0 ? (
							installedSkills.map((s) => (
								<option key={s.name} value={s.name} title={s.description}>
									📦 {s.name}
								</option>
							))
						) : (
							<option value="" disabled>
								{t("canvas.skills.noneDetectedShort")}
							</option>
						)}
						{strVal && !installedSkills?.some((s) => s.name === strVal) && <option value={strVal}>📦 {strVal}</option>}
					</select>
				);
			} else {
				control = (
					<select
						className="canvas-select"
						style={{ width: "100%" }}
						value={strVal}
						onChange={(e) => setCfg({ [f.key]: e.target.value })}
					>
						{(f.options ?? []).map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>
				);
			}
		} else {
			control = (
				<textarea
					className="canvas-instruction-input"
					rows={3}
					value={strVal}
					onChange={(e) => setCfg({ [f.key]: e.target.value })}
					placeholder={f.placeholder}
				/>
			);
		}
		return (
			<div key={f.key} className="canvas-node-field-col">
				<span className="canvas-field-label">
					{withPort && (
						<div
							className={"canvas-row-port in" + (activePorts?.in.includes("config") ? " connected" : "")}
							data-cport="config"
							data-canvas-node-id={node.id}
							data-canvas-port="config"
							data-canvas-port-direction="in"
							title={inPortTip("config")}
							onPointerUp={(e) => handleInUp(e, "config")}
						>
							<span className="canvas-row-port-dot" />
						</div>
					)}
					{f.label}
				</span>
				{control}
				{f.hint && <span className="canvas-muted-note">{f.hint}</span>}
			</div>
		);
	};
	const renderUtilityFields = () => {
		const fields = visibleRoleFields(node.role, roleCfg, t);
		if (fields.length === 0) return <span className="canvas-muted-note">{roleMeta.blurb}</span>;
		return <>{fields.map((f, i) => renderRoleField(f, i === 0))}</>;
	};
	const renderAgentExtras = () => {
		const fields = visibleRoleFields(node.role, roleCfg, t);
		if (fields.length === 0) return null;
		return (
			<div className="canvas-node-field-col">
				<span className="canvas-field-label">{t("canvas.node.roleParameters")}</span>
				{fields.map((f) => renderRoleField(f))}
			</div>
		);
	};
	const portCenterY = (el: HTMLElement): number => {
		const card = cardRef.current;
		if (!card) return PORT_Y_OFFSET;
		let y = el.offsetHeight / 2;
		let cur: HTMLElement | null = el;
		while (cur && cur !== card) {
			y += cur.offsetTop;
			cur = cur.offsetParent as HTMLElement | null;
		}
		return Math.round(y);
	};

	useLayoutEffect(() => {
		if (!onPortPositions || !cardRef.current) return;
		const map: Record<string, number> = {};
		cardRef.current.querySelectorAll<HTMLElement>("[data-cport]").forEach((el) => {
			const k = el.getAttribute("data-cport");
			if (k) map[k] = portCenterY(el);
		});
		onPortPositions(node.id, map);
	});

	const handleOutDown = (e: ReactPointerEvent<HTMLElement>, portKey: string) => {
		e.stopPropagation();
		e.preventDefault();
		onStartConnect(node.id, node.x + (node.width || 300), node.y + portCenterY(e.currentTarget), portKey);
	};
	const handleInUp = (e: ReactPointerEvent<HTMLElement>, portKey: string) => {
		e.stopPropagation();
		onEndConnect(node.id, portKey);
	};

	const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.button !== 0 || (e.target as HTMLElement).closest("input, button, select, textarea, a")) return;
		e.stopPropagation();
		onSelect(node.id);
		setIsDragging(true);
		hasMovedRef.current = false;
		setDragStart({
			x: e.clientX,
			y: e.clientY,
			nodeX: node.x,
			nodeY: node.y,
		});
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	};

	const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (!isDragging) return;
		const dx = e.clientX - dragStart.x;
		const dy = e.clientY - dragStart.y;
		if (!hasMovedRef.current && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
			hasMovedRef.current = true;
			onDragStart?.();
		}
		if (hasMovedRef.current) {
			onUpdate(node.id, {
				x: Math.round(dragStart.nodeX + dx / (Number.isFinite(zoom) && zoom > 0 ? zoom : 1)),
				y: Math.round(dragStart.nodeY + dy / (Number.isFinite(zoom) && zoom > 0 ? zoom : 1)),
			});
		}
	};

	const handlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (isDragging) {
			setIsDragging(false);
			try {
				(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
			} catch {}
		}
	};

	return (
		<div
			ref={cardRef}
			data-canvas-node-id={node.id}
			className={`canvas-node-card ${isSelected ? "selected" : ""} ${node.status === "running" ? "running" : ""}`}
			style={{
				transform: `translate3d(${node.x}px, ${node.y}px, 0)`,
				width: `${node.width || 300}px`,
			}}
			onPointerDown={(e) => {
				e.stopPropagation();
				onSelect(node.id);
			}}
			onClick={(e) => {
				e.stopPropagation();
				onSelect(node.id);
			}}
			onDoubleClick={(e) => {
				e.stopPropagation();
				onOpenDrawer(node.id);
			}}
		>
			<div
				className="canvas-node-header"
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onPointerCancel={handlePointerUp}
				onLostPointerCapture={() => setIsDragging(false)}
			>
				<div className="canvas-node-title-group">
					<span className="canvas-role-icon">{roleMeta.icon}</span>
					<input
						type="text"
						className="canvas-node-title-input"
						value={node.title}
						onChange={(e) => onUpdate(node.id, { title: e.target.value })}
						onClick={(e) => e.stopPropagation()}
						title={t("canvas.node.renameHint")}
					/>
				</div>

				<div
					className="canvas-engine-badge"
					style={{
						color: engineMeta.color,
						backgroundColor: engineMeta.bgColor,
						borderColor: engineMeta.color,
					}}
					title={engineMeta.desc}
				>
					{engineMeta.badge}
				</div>

				{node.role === "pstack" && (
					<div
						className="canvas-engine-badge"
						style={{
							color: "var(--amber, #f97316)",
							backgroundColor: "color-mix(in srgb, var(--amber, #f97316) 15%, transparent)",
							borderColor: "var(--amber, #f97316)",
							maxWidth: "120px",
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
						}}
						title={t("canvas.node.pstackSkill", { name: String(node.config?.skill || "poteto-mode") })}
					>
						🥔 {String(node.config?.skill || "poteto-mode")}
					</div>
				)}
				{node.role === "skill" && node.config?.skillName && (
					<div
						className="canvas-engine-badge"
						style={{
							color: "var(--accent, #a855f7)",
							backgroundColor: "color-mix(in srgb, var(--accent, #a855f7) 15%, transparent)",
							borderColor: "var(--accent, #a855f7)",
							maxWidth: "120px",
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
						}}
						title={t("canvas.node.skillPersona", { name: String(node.config?.skillName) })}
					>
						✨ {String(node.config?.skillName)}
					</div>
				)}
			</div>

			<div className="canvas-node-body">
				{roleCapabilityNotice(node.role, t) && (
					<p
						className="canvas-muted-note"
						role="alert"
						style={{
							color: "var(--amber-text)",
							fontWeight: 600,
							border: "1px solid var(--amber)",
							padding: 8,
							borderRadius: 6,
						}}
					>
						{!isRoleImplemented(node.role) && (
							<strong>
								{t("canvas.nodeCard.notImplementedRunDisabled")}
								<br />
							</strong>
						)}
						{roleCapabilityNotice(node.role, t)}
					</p>
				)}
				<div className="canvas-node-field-row">
					<span className="canvas-field-label">
						{t("canvas.node.type")}
						<span
							title={t("canvas.node.ioHelp", { input: ioHelp.input, output: ioHelp.output, usage: ioHelp.usage })}
							style={{
								display: "inline-flex",
								alignItems: "center",
								justifyContent: "center",
								width: 14,
								height: 14,
								borderRadius: "50%",
								border: "1px solid var(--border)",
								color: "var(--text-faint)",
								fontSize: 10,
								cursor: "help",
								flex: "none",
							}}
						>
							?
						</span>
					</span>
					<select
						className="canvas-select canvas-role-select"
						value={node.role}
						onChange={(e) => onUpdate(node.id, { role: e.target.value as typeof node.role })}
						title={roleMeta.blurb}
					>
						{Object.values(ROLE_METAS)
							.filter((m) => isRoleImplemented(m.role) || m.role === node.role)
							.map((m) => (
								<option key={m.role} value={m.role}>
									{m.icon} {m.label}
								</option>
							))}
					</select>
				</div>

				<div className="canvas-node-field-row">
					<span className="canvas-field-label">
						<div
							className={`canvas-port port-in ${hasIncoming || activePorts?.in.length ? "connected" : ""}`}
							style={{
								borderColor: hasIncoming ? "var(--accent)" : "var(--border)",
							}}
							title={t("canvas.node.mainInputHint")}
							data-cport="contract"
							data-canvas-node-id={node.id}
							data-canvas-port="contract"
							data-canvas-port-direction="in"
							onPointerUp={(e) => handleInUp(e, "contract")}
						>
							<span className="canvas-port-dot" />
						</div>
						{t("canvas.node.input")}
					</span>
					<span className="canvas-muted-note">
						{hasIncoming || (activePorts?.in.length ?? 0) > 0
							? t("canvas.node.upstreamConnected")
							: t("canvas.node.disconnected")}
					</span>
				</div>

				{roleNeedsInstruction(node.role) ? (
					<div className="canvas-node-field-col">
						<span className="canvas-field-label">
							<div
								className={"canvas-row-port in" + (activePorts?.in.includes("instruction") ? " connected" : "")}
								data-cport="instruction"
								data-canvas-node-id={node.id}
								data-canvas-port="instruction"
								data-canvas-port-direction="in"
								title={inPortTip("instruction")}
								onPointerUp={(e) => handleInUp(e, "instruction")}
							>
								<span className="canvas-row-port-dot" />
							</div>
							{t("canvas.node.instructionLabel")}
						</span>
						<textarea
							className="canvas-instruction-input"
							rows={3}
							value={node.instruction || ""}
							onChange={(e) => onUpdate(node.id, { instruction: e.target.value })}
							placeholder={t("canvas.node.instructionPlaceholder")}
							title={t("canvas.node.instructionHint")}
						/>
					</div>
				) : null}
				{roleNeedsInstruction(node.role) && (
					<div className="canvas-node-field-col">
						<span className="canvas-field-label">
							<div
								className={"canvas-row-port in" + (activePorts?.in.includes("system") ? " connected" : "")}
								data-cport="system"
								data-canvas-node-id={node.id}
								data-canvas-port="system"
								data-canvas-port-direction="in"
								title={inPortTip("system")}
								onPointerUp={(e) => handleInUp(e, "system")}
							>
								<span className="canvas-row-port-dot" />
							</div>
							{t("canvas.node.persona")}
						</span>
						<textarea
							className="canvas-instruction-input"
							rows={3}
							value={node.systemPromptOverride || ""}
							onChange={(e) => onUpdate(node.id, { systemPromptOverride: e.target.value })}
							placeholder={t("canvas.node.personaPlaceholder")}
							title={t("canvas.node.personaHint")}
						/>
					</div>
				)}
				{!isAgent && renderUtilityFields()}
				{isAgent && renderAgentExtras()}
				{isAgent && (
					<>
						<div className="canvas-node-field-row">
							<span className="canvas-field-label">
								<FiCpu />
								{t("canvas.node.engine")}
							</span>
							<select
								className="canvas-select"
								value={node.engine}
								onChange={(e) => onUpdate(node.id, { engine: e.target.value as CanvasEngineId })}
							>
								<option value="pi">{t("canvas.engine.pi")}</option>
								<option value="dsh">{t("canvas.engine.dsh")}</option>
								<option value="claude">Claude Code</option>
								<option value="codex">Codex</option>
								<option value="durable">{t("canvas.engine.durable")}</option>
							</select>
						</div>

						<div className="canvas-node-field-col">
							<span className="canvas-field-label">{t("canvas.node.modelAndThinking")}</span>
							<ModelThinking
								state={{
									model: selectedModelObj,
									thinkingLevel: (node.thinkingLevel as ThinkingValue) || "off",
									availableThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
								}}
								models={models}
								direction="down"
								onSelectModel={(m) =>
									onUpdate(node.id, {
										model: m.id.startsWith(`${m.provider}/`) ? m.id : `${m.provider}/${m.id}`,
									})
								}
								onSelectThinking={(lvl) => onUpdate(node.id, { thinkingLevel: lvl })}
							/>
						</div>

						<div className="canvas-node-field-col">
							<span className="canvas-field-label">{t("canvas.node.workspace")}</span>
							<UniversalPathPicker
								cwd={node.cwd}
								onSelectCwd={(c) => onUpdate(node.id, { cwd: c })}
								projects={projects}
								workspaceRoots={workspaceRoots}
								pathCompletions={pathCompletions}
								baseCwd={baseCwd}
								mode="project"
								onCreateProject={
									onMakeDir
										? (p) => {
												onMakeDir(p);
												onUpdate(node.id, { cwd: p });
											}
										: undefined
								}
							/>
						</div>

						{(() => {
							const isRemote = (node.cwd ?? "").trim().startsWith("ssh://");
							return (
								<label
									className={`canvas-checkbox-row ${isRemote ? "disabled" : ""}`}
									title={isRemote ? t("canvas.node.remoteWorktreeHint") : t("canvas.node.worktreeHint")}
								>
									<input
										type="checkbox"
										checked={!isRemote && node.useWorktree}
										disabled={isRemote}
										onChange={(e) => onUpdate(node.id, { useWorktree: e.target.checked })}
									/>
									<span className="canvas-checkbox-label">
										<FiGitBranch />
										{t("canvas.node.enableWorktree")}
										{isRemote && (
											<small style={{ opacity: 0.65, marginLeft: 4 }}>{t("canvas.node.remoteIsolationExempt")}</small>
										)}
									</span>
								</label>
							);
						})()}
					</>
				)}

				{branchOutPorts.length > 0 && (
					<div className="canvas-node-branch-group">
						{branchOutPorts.map((bd) => (
							<div key={bd.key} className="canvas-branch-row" title={outPortTip(bd.key)}>
								<span className="canvas-branch-label">
									{bd.key === "true" ? "✓ " : bd.key === "false" ? "✗ " : bd.key === "approve" ? "✓ " : "↺ "}
									{bd.label}
								</span>
								<div
									className={"canvas-row-port out" + (activePorts?.out.includes(bd.key) ? " connected" : "")}
									data-cport={bd.key}
									data-canvas-node-id={node.id}
									data-canvas-port={bd.key}
									data-canvas-port-direction="out"
									onPointerDown={(e) => handleOutDown(e, bd.key)}
								>
									<span className="canvas-row-port-dot" />
								</div>
							</div>
						))}
					</div>
				)}
				{(node.role === "end" || node.role === "merge") && (
					<div className="canvas-node-field-col" title={incomingPreview || t("canvas.node.noUpstreamInput")}>
						<span className="canvas-field-label">{t("canvas.node.receivedOutput")}</span>
						<span className="canvas-muted-note canvas-output-preview">
							{incomingPreview
								? incomingPreview.slice(0, 120) + (incomingPreview.length > 120 ? "…" : "")
								: t("canvas.node.noUpstreamInput")}
						</span>
					</div>
				)}
				<div
					className="canvas-node-field-col"
					title={
						node.status === "error" && node.error
							? t("canvas.node.executionError", { name: errorText })
							: node.lastOutputSummary
								? node.lastOutputSummary
								: t("canvas.node.outputPreview", { name: (ROLE_IO_HELP[node.role] ?? ROLE_IO_HELP.custom).output })
					}
				>
					<span className="canvas-field-label">
						<div
							className={`canvas-port port-out ${hasOutgoing || activePorts?.out.length ? "connected" : ""}`}
							style={{
								borderColor: engineMeta.color,
							}}
							title={t("canvas.node.mainOutputHint")}
							data-cport="result"
							data-canvas-node-id={node.id}
							data-canvas-port="result"
							data-canvas-port-direction="out"
							onPointerDown={(e) => handleOutDown(e, "result")}
						>
							<span
								className="canvas-port-dot"
								style={{
									backgroundColor: engineMeta.color,
								}}
							/>
						</div>
						{t("canvas.node.outputContent")}
					</span>
					{node.status === "error" && node.error ? (
						<span className="canvas-muted-note canvas-output-preview canvas-output-error">
							{t("canvas.node.executionError", { name: errorText }).slice(0, 120)}
						</span>
					) : (
						<span className="canvas-muted-note canvas-output-preview">
							{node.lastOutputSummary
								? node.lastOutputSummary.slice(0, 120) + (node.lastOutputSummary.length > 120 ? "…" : "")
								: !isRoleImplemented(node.role)
									? t("canvas.nodeCard.notImplementedNoExecutionOutput")
									: t("canvas.node.outputPreview", { name: (ROLE_IO_HELP[node.role] ?? ROLE_IO_HELP.custom).output })}
						</span>
					)}
				</div>
				<div
					className="canvas-node-status-bar"
					style={{
						backgroundColor: statusColor.bg,
						color: statusColor.text,
					}}
				>
					<span className="canvas-status-dot" style={{ backgroundColor: statusColor.dot }} />
					<span className="canvas-status-text">{actionText || statusColor.label}</span>
				</div>
			</div>

			<div className="canvas-node-footer">
				{node.status === "running" ? (
					<button
						type="button"
						className="canvas-btn stop"
						title={t("canvas.node.stopHint")}
						onClick={(e) => {
							e.stopPropagation();
							onStop(node.id);
						}}
					>
						<FiSquare />
						{t("canvas.node.stop")}
					</button>
				) : (
					<button
						type="button"
						className="canvas-btn run"
						disabled={!isRoleImplemented(node.role)}
						title={t("canvas.node.startHint")}
						onClick={(e) => {
							e.stopPropagation();
							onRun(node.id);
						}}
					>
						<FiPlay />
						{t("canvas.node.start")}
					</button>
				)}

				<button
					type="button"
					className="canvas-btn"
					title={t("canvas.node.openDrawerHint")}
					onClick={(e) => {
						e.stopPropagation();
						onOpenDrawer(node.id);
					}}
				>
					<FiSliders />
					{t("canvas.node.reviewOrInterject")}
				</button>

				<button
					type="button"
					className="canvas-btn del"
					title={t("canvas.node.deleteHint")}
					onClick={(e) => {
						e.stopPropagation();
						onDelete(node.id);
					}}
				>
					<FiTrash2 />
				</button>
			</div>
		</div>
	);
}
