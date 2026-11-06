import { useState, useEffect, useMemo, useRef } from "react";
import { useCopyFeedback } from "../../use-copy-feedback";
import type { CanvasNode, CanvasEdge, CanvasNodeLogEntry, ModelInfo, ProjectSummary, UiMessage } from "../../types";
import type { ThinkingValue } from "../../thinking-levels";
import type { RoleField } from "./CanvasTypes";
import type { ReactNode } from "react";
import {
	getEngineMetas,
	getRoleMetas,
	getStatusMetas,
	getInPortDefs,
	outPortsForRole,
	inPortLabel,
	outPortLabel,
	visibleRoleFields,
	roleCapabilityNotice,
	isRoleImplemented,
} from "./CanvasTypes";
import { useT, useLocale } from "../../i18n";
import { formatCanvasMessage, getEdgeTypeLabels } from "./canvas-i18n";
import { ModelThinking } from "../ModelThinking";
import { UniversalPathPicker } from "../UniversalPathPicker";
import {
	FiX,
	FiSend,
	FiPlay,
	FiSquare,
	FiGitBranch,
	FiCheckCircle,
	FiAlertCircle,
	FiTrash2,
	FiMessageSquare,
	FiActivity,
	FiMaximize2,
	FiMinimize2,
	FiCopy,
	FiCheck,
	FiFileText,
	FiSliders,
} from "react-icons/fi";
import { Message } from "../Message";
import { getPstackSkillsMap } from "./pstack-skills-data";

export type CanvasDrawerTab = "console" | "prompts" | "contracts" | "env";

export interface CanvasNodeDrawerProps {
	node: CanvasNode | null;
	edges: CanvasEdge[];
	allNodes: CanvasNode[];
	models: ModelInfo[];
	defaultModel?: string | null;
	installedSkills?: { name: string; description: string }[];
	projects: ProjectSummary[];
	workspaceRoots?: string[];
	pathCompletions?: { name: string; path: string; type: "dir" | "file" }[];
	baseCwd?: string;
	onMakeDir?: (path: string) => void;
	onClose: () => void;
	onUpdate: (nodeId: string, patch: Partial<CanvasNode>) => void;
	onRun: (nodeId: string) => void;
	onStop: (nodeId: string) => void;
	onSteer: (nodeId: string, message: string) => void;
	onReview?: (nodeId: string, decision: "approve" | "reject", comment?: string) => void;
	logEntries?: CanvasNodeLogEntry[];
	logMessages?: UiMessage[];
	onClearLog?: (nodeId: string) => void;
	onUpdateEdge?: (edgeId: string, patch: Partial<CanvasEdge>) => void;
}

export function CanvasNodeDrawer({
	node,
	edges,
	allNodes,
	models,
	defaultModel,
	installedSkills = [],
	projects,
	workspaceRoots = [],
	pathCompletions = [],
	baseCwd,
	onMakeDir,
	onClose,
	onUpdate,
	onRun,
	onStop,
	onSteer,
	onReview,
	logEntries = [],
	logMessages = [],
	onClearLog,
	onUpdateEdge,
}: CanvasNodeDrawerProps) {
	const t = useT();
	const locale = useLocale();
	const edgeTypeLabels = getEdgeTypeLabels(t);
	const ENGINE_METAS = useMemo(() => getEngineMetas(t), [t]);
	const ROLE_METAS = useMemo(() => getRoleMetas(t), [t]);
	const IN_PORT_DEFS = useMemo(() => getInPortDefs(t), [t]);
	const PSTACK_SKILLS_MAP = useMemo(() => getPstackSkillsMap(t), [t]);
	const STATUS_METAS = useMemo(() => getStatusMetas(t), [t]);
	const [steerInput, setSteerInput] = useState("");
	const [logTab, setLogTab] = useState<"chat" | "events">("chat");
	const [showSkillDoc, setShowSkillDoc] = useState(false);
	const [isMaximized, setIsMaximized] = useState(false);
	const { copied: copiedSummary, copy: copySummary } = useCopyFeedback({ duration: 2000 });
	const logScrollRef = useRef<HTMLDivElement | null>(null);

	const initialTab: CanvasDrawerTab = useMemo(() => {
		if (node?.status === "waiting_approval") return "contracts";
		if (
			node?.status === "running" ||
			(logMessages && logMessages.length > 0) ||
			(logEntries && logEntries.length > 0)
		) {
			return "console";
		}
		return "prompts";
	}, [node?.id]);

	const [activeTab, setActiveTab] = useState<CanvasDrawerTab>(initialTab);

	useEffect(() => {
		if (!node) return;
		if (node.status === "waiting_approval") {
			setActiveTab("contracts");
		} else if (node.status === "running") {
			setActiveTab("console");
		}
	}, [node?.id, node?.status]);

	useEffect(() => {
		if (!node) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				if (isMaximized) {
					setIsMaximized(false);
				} else {
					onClose();
				}
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [node, onClose, isMaximized]);

	const emptyMap: ReadonlyMap<string, never> = new Map<string, never>();
	const emptyToolStatuses: ReadonlyMap<string, any> = new Map();
	const drawerCfg = ((node?.config ?? {}) as Record<string, string | number | boolean | undefined>) || {};

	const renderDrawerField = (f: RoleField) => {
		const strVal = String(drawerCfg[f.key] ?? f.default ?? "");
		const setF = (v: string | number | boolean) => onUpdate(node!.id, { config: { ...node!.config, [f.key]: v } });
		let control: ReactNode = null;
		if (f.key === "skillName") {
			control = (
				<select className="canvas-drawer-input" value={strVal} onChange={(e) => setF(e.target.value)}>
					{installedSkills && installedSkills.length > 0 ? (
						installedSkills.map((s) => (
							<option key={s.name} value={s.name} title={s.description}>
								📦 {s.name}
								{s.description ? ` — ${s.description}` : ""}
							</option>
						))
					) : (
						<option value="" disabled>
							{t("canvas.skills.noneDetected")}
						</option>
					)}
					{strVal && !installedSkills?.some((s) => s.name === strVal) && <option value={strVal}>📦 {strVal}</option>}
				</select>
			);
		} else if (f.kind === "textarea") {
			control = (
				<textarea
					className="canvas-drawer-textarea"
					rows={f.rows ?? 3}
					value={strVal}
					onChange={(e) => setF(e.target.value)}
					placeholder={f.placeholder}
				/>
			);
		} else if (f.kind === "number") {
			control = (
				<input
					type="number"
					min={f.min}
					max={f.max}
					className="canvas-drawer-input"
					value={Number(drawerCfg[f.key] ?? f.default ?? 0)}
					onChange={(e) => {
						const raw = Number(e.target.value);
						const v = Number.isFinite(raw) ? raw : Number(f.default ?? 0);
						setF(Math.max(f.min ?? Number.NEGATIVE_INFINITY, Math.min(f.max ?? Number.POSITIVE_INFINITY, v)));
					}}
				/>
			);
		} else if (f.kind === "select") {
			control = (
				<select className="canvas-drawer-input" value={strVal} onChange={(e) => setF(e.target.value)}>
					{(f.options ?? []).map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
			);
		} else if (f.kind === "boolean") {
			control = (
				<input
					type="checkbox"
					checked={drawerCfg[f.key] === true || (drawerCfg[f.key] === undefined && f.default === true)}
					onChange={(e) => setF(e.target.checked)}
				/>
			);
		} else if (f.kind !== "hint") {
			control = (
				<input
					type="text"
					className="canvas-drawer-input"
					value={strVal}
					onChange={(e) => setF(e.target.value)}
					placeholder={f.placeholder}
				/>
			);
		}
		return (
			<label key={f.key} className="canvas-config-row">
				<span>{f.label}</span>
				{control}
				{f.hint && <span className="canvas-muted-note">{f.hint}</span>}
			</label>
		);
	};

	const logKindLabel = (e: CanvasNodeLogEntry) =>
		e.kind === "tool"
			? "🔧 " + (e.toolName || t("canvas.drawer.eventTool"))
			: e.kind === "error"
				? "❌ " + t("canvas.drawer.eventError")
				: e.kind === "steer"
					? "💬 " + t("canvas.drawer.eventSteer")
					: e.kind === "handoff"
						? "🔗 " + t("canvas.drawer.eventHandoff")
						: e.kind === "review"
							? "🔍 " + t("canvas.drawer.eventReview")
							: e.kind === "prompt"
								? "📝 " + t("canvas.drawer.eventPrompt")
								: e.kind === "done"
									? "✅ " + t("canvas.drawer.eventDone")
									: "ℹ️ " + t("canvas.drawer.eventSystem");

	useEffect(() => {
		logScrollRef.current?.scrollTo({ top: logScrollRef.current.scrollHeight });
	}, [logMessages.length, logEntries.length, logTab]);

	const selectedModelObj = useMemo(() => {
		if (!node) return null;
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
	}, [node, models, defaultModel]);

	if (!node) return null;

	const engineMeta = ENGINE_METAS[node.engine] || ENGINE_METAS.pi;
	const roleMeta = ROLE_METAS[node.role] || ROLE_METAS.coder;

	const incomingEdges = edges.filter((e) => e.targetNodeId === node.id);
	const outgoingEdges = edges.filter((e) => e.sourceNodeId === node.id);
	const nodeMap = new Map(allNodes.map((n) => [n.id, n]));

	const handleSendSteer = () => {
		if (!steerInput.trim()) return;
		onSteer(node.id, steerInput.trim());
		setSteerInput("");
	};

	return (
		<div
			className={`canvas-drawer-overlay ${isMaximized ? "is-maximized" : ""}`}
			onPointerDown={(e) => {
				if (e.target === e.currentTarget) {
					e.stopPropagation();
				}
			}}
			onClick={(e) => {
				if (e.target === e.currentTarget) {
					e.stopPropagation();
					onClose();
				}
			}}
		>
			<div
				className={`canvas-drawer-panel ${isMaximized ? "is-maximized" : ""}`}
				onPointerDown={(e) => e.stopPropagation()}
				onMouseDown={(e) => e.stopPropagation()}
				onWheel={(e) => e.stopPropagation()}
				onClick={(e) => e.stopPropagation()}
			>
				<div
					className="canvas-drawer-header"
					onDoubleClick={(e) => {
						const target = e.target as HTMLElement;
						if (target.closest("button, input, select, textarea, a")) return;
						setIsMaximized((v) => !v);
					}}
				>
					<div className="canvas-drawer-title-group">
						<span className="canvas-drawer-role-icon">{roleMeta.icon}</span>
						<div>
							<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
								<h3 className="canvas-drawer-title">{node.title}</h3>
								<span className={`status-badge status-${node.status}`} style={{ fontSize: 11, padding: "1px 6px" }}>
									{STATUS_METAS[node.status]?.label ?? node.status}
								</span>
							</div>
							<div className="canvas-drawer-subtitle">
								<span
									className="canvas-engine-chip"
									style={{
										color: engineMeta.color,
										borderColor: engineMeta.color,
										backgroundColor: engineMeta.bgColor,
									}}
								>
									{engineMeta.name}
								</span>
								<span className="canvas-model-chip">{node.model}</span>
							</div>
						</div>
					</div>

					<div className="canvas-drawer-actions">
						<button
							type="button"
							className="canvas-drawer-action-btn"
							onClick={() => setIsMaximized((v) => !v)}
							title={isMaximized ? t("canvas.nodeDrawer.restoreWindowEsc") : t("canvas.nodeDrawer.fullscreenView")}
							aria-label={isMaximized ? t("canvas.nodeDrawer.restoreWindowEsc") : t("canvas.nodeDrawer.fullscreenView")}
						>
							{isMaximized ? <FiMinimize2 /> : <FiMaximize2 />}
						</button>
						<button
							type="button"
							className="canvas-drawer-action-btn canvas-drawer-close"
							onClick={onClose}
							title={t("canvas.nodeDrawer.closeEsc")}
							aria-label={t("canvas.common.close")}
						>
							<FiX />
						</button>
					</div>
				</div>

				<div className="canvas-drawer-tabs-bar">
					<button
						type="button"
						className={`canvas-drawer-tab ${activeTab === "console" ? "active" : ""}`}
						onClick={() => setActiveTab("console")}
					>
						<FiActivity />
						<span>{t("canvas.nodeDrawer.liveConsoleStream")}</span>
						{node.status === "running" ? (
							<span className="canvas-tab-badge pulse">{t("canvas.nodeDrawer.running")}</span>
						) : logMessages.length > 0 || logEntries.length > 0 ? (
							<span className="canvas-tab-badge">
								{logMessages.length ? `${logMessages.length}` : `${logEntries.length}`}
							</span>
						) : null}
					</button>

					<button
						type="button"
						className={`canvas-drawer-tab ${activeTab === "prompts" ? "active" : ""}`}
						onClick={() => setActiveTab("prompts")}
					>
						<FiFileText />
						<span>{t("canvas.nodeDrawer.promptsInstructions")}</span>
					</button>

					<button
						type="button"
						className={`canvas-drawer-tab ${activeTab === "contracts" ? "active" : ""}`}
						onClick={() => setActiveTab("contracts")}
					>
						<FiCheckCircle />
						<span>{t("canvas.nodeDrawer.contractsReview")}</span>
						{node.status === "waiting_approval" ? (
							<span className="canvas-tab-badge warning">{t("canvas.nodeDrawer.needsReview")}</span>
						) : incomingEdges.length > 0 || outgoingEdges.length > 0 ? (
							<span className="canvas-tab-badge">{incomingEdges.length + outgoingEdges.length}</span>
						) : null}
					</button>

					<button
						type="button"
						className={`canvas-drawer-tab ${activeTab === "env" ? "active" : ""}`}
						onClick={() => setActiveTab("env")}
					>
						<FiSliders />
						<span>{t("canvas.nodeDrawer.sandboxEnvironment")}</span>
					</button>
				</div>

				<div className="canvas-drawer-body">
					{activeTab === "console" && (
						<div className="canvas-tab-panel canvas-tab-panel-console">
							<div className="canvas-log-section">
								<div className="canvas-log-header">
									<div className="canvas-log-tabs">
										<button
											type="button"
											className={"canvas-log-tab " + (logTab === "chat" ? "active" : "")}
											onClick={() => setLogTab("chat")}
											title={t("canvas.drawer.conversationHint")}
										>
											<FiMessageSquare />
											{t("canvas.drawer.conversation")}
											{logMessages.length ? "(" + logMessages.length + ")" : ""}
										</button>
										<button
											type="button"
											className={"canvas-log-tab " + (logTab === "events" ? "active" : "")}
											onClick={() => setLogTab("events")}
											title={t("canvas.drawer.eventsHint")}
										>
											<FiActivity />
											{t("canvas.drawer.events")}
											{logEntries.length ? "(" + logEntries.length + ")" : ""}
										</button>
										{(logEntries.length > 0 || logMessages.length > 0) && onClearLog && (
											<button
												type="button"
												className="canvas-log-clear"
												onClick={() => onClearLog(node.id)}
												title={t("canvas.drawer.clearTranscript")}
											>
												<FiTrash2 /> {t("canvas.nodeDrawer.clear")}
											</button>
										)}
									</div>
									<div className="canvas-console-status-note">
										{node.status === "running" ? (
											<span style={{ color: "var(--accent)", display: "flex", alignItems: "center", gap: 6 }}>
												<span className="canvas-pulse-dot" /> {t("canvas.nodeDrawer.agentIsRunning")}
											</span>
										) : (
											<span style={{ color: "var(--text-faint)" }}>
												{t("canvas.nodeDrawer.readyStreamUpdatesLive")}
											</span>
										)}
									</div>
								</div>
								<div className="canvas-log-body" ref={logScrollRef}>
									{logTab === "chat" ? (
										logMessages.length === 0 ? (
											<div className="canvas-log-empty">
												<FiMessageSquare style={{ fontSize: 32, opacity: 0.3 }} />
												<p>{t("canvas.nodeDrawer.noMessagesYetAfterRunningChatFlowAnd")}</p>
											</div>
										) : (
											logMessages.slice(-100).map((m) => (
												<div key={m.id} className="canvas-log-msg">
													<Message
														message={m}
														readOnly
														toolResults={emptyMap as ReadonlyMap<string, UiMessage>}
														liveOutputs={emptyMap as ReadonlyMap<string, { toolName: string; text: string }>}
														toolStatuses={emptyToolStatuses as ReadonlyMap<string, never>}
														streaming={false}
														isLast={false}
													/>
												</div>
											))
										)
									) : logEntries.length === 0 ? (
										<div className="canvas-log-empty">
											<FiActivity style={{ fontSize: 32, opacity: 0.3 }} />
											<p>{t("canvas.nodeDrawer.noEventsYetToolCallsErrorsSteerAnd")}</p>
										</div>
									) : (
										logEntries.slice(-200).map((e) => (
											<div key={e.id} className={"canvas-log-entry kind-" + e.kind}>
												<span className="canvas-log-kind">{logKindLabel(e)}</span>
												<span className="canvas-log-time">{new Date(e.ts).toLocaleTimeString(locale)}</span>
												<div className="canvas-log-text">{formatCanvasMessage(e.message, e.text, t)}</div>
											</div>
										))
									)}
								</div>
							</div>

							<div className="canvas-steer-section">
								<div className="canvas-steer-bar">
									<input
										type="text"
										className="canvas-steer-input"
										placeholder={t("canvas.nodeDrawer.inputSteerInstructionToAdjustAgentBehavior")}
										value={steerInput}
										onChange={(e) => setSteerInput(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") handleSendSteer();
										}}
									/>
									<button
										type="button"
										className="canvas-steer-btn"
										onClick={handleSendSteer}
										title={t("canvas.drawer.sendInterjection")}
									>
										<FiSend /> {t("canvas.nodeDrawer.steer")}
									</button>
								</div>
							</div>
						</div>
					)}

					{activeTab === "prompts" && (
						<div className="canvas-tab-panel canvas-tab-panel-prompts">
							{roleCapabilityNotice(node.role, t) && (
								<p
									className="canvas-muted-note"
									role="alert"
									style={{
										color: "var(--amber-text)",
										fontWeight: 600,
										border: "1px solid var(--amber)",
										padding: "8px 12px",
										borderRadius: 6,
										margin: 0,
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

							<div className="canvas-prompts-grid">
								<div className="canvas-prompt-card">
									<div className="canvas-prompt-card-header">
										<h4 className="canvas-section-title">🎭 {t("canvas.nodeDrawer.systemPrompt")}</h4>
										<small style={{ color: "var(--text-faint)" }}>{t("canvas.nodeDrawer.definesIdentity")}</small>
									</div>
									<textarea
										className="canvas-drawer-textarea canvas-prompt-textarea"
										value={node.systemPromptOverride || ""}
										onChange={(e) => onUpdate(node.id, { systemPromptOverride: e.target.value })}
										placeholder={t("canvas.nodeDrawer.enterSystemPromptIdentityForThisDigitalWorker")}
									/>
									<p className="canvas-tip">{t("canvas.nodeDrawer.identityDefinesWhoItIsInstructionDefinesWhat")}</p>
								</div>

								<div className="canvas-prompt-card">
									<div className="canvas-prompt-card-header">
										<h4 className="canvas-section-title">🎯 {t("canvas.nodeDrawer.aIInstructionSavedWithGraph")}</h4>
										<small style={{ color: "var(--text-faint)" }}>{t("canvas.nodeDrawer.definesTask")}</small>
									</div>
									<div className="canvas-variable-chips">
										<span style={{ fontSize: 11, color: "var(--text-faint)" }}>
											{t("canvas.nodeDrawer.insertVariable")}
										</span>
										<button
											type="button"
											className="canvas-var-chip"
											onClick={() => {
												const cur = node.instruction || "";
												onUpdate(node.id, { instruction: cur ? `${cur} {{input}}` : "{{input}}" });
											}}
											title={t("canvas.drawer.insertInputHint")}
										>
											+ &#123;&#123;input&#125;&#125;
										</button>
										<button
											type="button"
											className="canvas-var-chip"
											onClick={() => {
												const cur = node.instruction || "";
												onUpdate(node.id, { instruction: cur ? `${cur} {{upstream}}` : "{{upstream}}" });
											}}
											title={t("canvas.drawer.insertSummaryHint")}
										>
											+ &#123;&#123;upstream&#125;&#125;
										</button>
										<button
											type="button"
											className="canvas-var-chip"
											onClick={() => {
												const cur = node.instruction || "";
												onUpdate(node.id, { instruction: cur ? `${cur} {{upstream}}` : "{{upstream}}" });
											}}
											title={t("canvas.drawer.insertUpstreamHint")}
										>
											+ &#123;&#123;upstream&#125;&#125;
										</button>
									</div>
									<textarea
										className="canvas-drawer-textarea canvas-prompt-textarea canvas-instruction-textarea"
										value={node.instruction || ""}
										onChange={(e) => onUpdate(node.id, { instruction: e.target.value })}
										placeholder={t("canvas.nodeDrawer.emptyUseUpstreamInputDirectlyOrEG")}
									/>
									<p className="canvas-tip">
										{t("canvas.nodeDrawer.variablesSupportedInputUpstreamEmptyDirectPassThrough")}
									</p>
								</div>
							</div>

							{/* 通用工作流控制参数：条件 / 循环 / 审批 / 工具 / API 等 */}
							{visibleRoleFields(node.role, drawerCfg, t).length > 0 && (
								<div className="canvas-drawer-section" style={{ marginTop: 8 }}>
									<h4 className="canvas-section-title">⚙️ {t("canvas.nodeDrawer.nodeControlParameters")}</h4>
									<div className="canvas-role-fields-grid">
										{visibleRoleFields(node.role, drawerCfg, t).map((f) => renderDrawerField(f))}
									</div>
								</div>
							)}
						</div>
					)}

					{activeTab === "contracts" && (
						<div className="canvas-tab-panel canvas-tab-panel-contracts">
							<div className="canvas-review-gate-card">
								<div className="canvas-summary-header">
									<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
										<h4 className="canvas-section-title" style={{ fontSize: 14 }}>
											🔍 {t("canvas.nodeDrawer.reviewGateDeliverable")}
										</h4>
										<span className={`status-badge status-${node.status}`}>
											{STATUS_METAS[node.status]?.label ?? node.status}
										</span>
									</div>
									{node.lastOutputSummary && (
										<button
											type="button"
											className="canvas-btn small"
											onClick={() => {
												void copySummary(node.lastOutputSummary || "");
											}}
											title={t("canvas.drawer.copySummaryHint")}
										>
											{copiedSummary ? <FiCheck style={{ color: "var(--green)" }} /> : <FiCopy />}
											{copiedSummary ? t("canvas.nodeDrawer.copied") : t("canvas.nodeDrawer.copySummary")}
										</button>
									)}
								</div>

								{node.status === "error" && node.error ? (
									<div className="canvas-summary-error-box">
										<p className="canvas-summary-text canvas-summary-error">
											❌ {t("canvas.nodeDrawer.executionFailed")}
											{formatCanvasMessage(node.errorMessage, node.error, t)}
										</p>
										<div className="canvas-review-actions">
											<button type="button" className="canvas-btn green" onClick={() => onRun(node.id)}>
												<FiPlay /> {t("canvas.nodeDrawer.rerunNode")}
											</button>
										</div>
									</div>
								) : node.lastOutputSummary ? (
									<div>
										{node.status === "running" ? (
											<div
												style={{
													marginBottom: 10,
													padding: "8px 12px",
													borderRadius: 6,
													fontSize: 12,
													backgroundColor: "color-mix(in srgb, var(--amber, #f59e0b) 12%, transparent)",
													color: "var(--amber-text, #f59e0b)",
													border: "1px solid color-mix(in srgb, var(--amber, #f59e0b) 30%, transparent)",
												}}
											>
												⚠️ {t("canvas.nodeDrawer.nodeIsExecutingANewTaskAboveIs")}
											</div>
										) : null}
										<div className="canvas-summary-text">{node.lastOutputSummary}</div>
										<div className="canvas-review-actions">
											<button
												type="button"
												className="canvas-btn green"
												disabled={node.status === "running"}
												style={node.status === "running" ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
												onClick={() => {
													if (node.status === "running") return;
													if (onReview) onReview(node.id, "approve");
													else
														onUpdate(node.id, {
															status: "done",
															currentAction: "Human review approved the merge",
															currentActionMessage: { key: "canvas.runtime.action.reviewApproved" },
														});
												}}
											>
												<FiCheckCircle /> {t("canvas.nodeDrawer.approveMerge")}
											</button>
											<button
												type="button"
												className="canvas-btn orange"
												disabled={node.status === "running"}
												style={node.status === "running" ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
												onClick={() => {
													if (node.status === "running") return;
													if (onReview) onReview(node.id, "reject");
													else
														onUpdate(node.id, {
															status: "waiting_approval",
															currentAction: "Human review rejected: add tests and comments",
															currentActionMessage: { key: "canvas.runtime.action.reviewRejected" },
														});
												}}
											>
												<FiAlertCircle /> {t("canvas.nodeDrawer.rejectRevise")}
											</button>
										</div>
									</div>
								) : (
									<div className="canvas-empty-contract-hint">
										<p className="canvas-text-muted">
											{t("canvas.nodeDrawer.noDeliverablesYetWaitingForNodeCompletion")}
										</p>
									</div>
								)}
							</div>

							<div className="canvas-contracts-grid">
								<div className="canvas-contract-col">
									<h4 className="canvas-section-title">
										📥 {t("canvas.nodeDrawer.incomingContracts")}
										<span className="canvas-section-badge">{incomingEdges.length}</span>
									</h4>
									{incomingEdges.length === 0 ? (
										<div className="canvas-empty-contract-card">
											<span>{t("canvas.nodeDrawer.rootNodeWithoutIncomingContracts")}</span>
										</div>
									) : (
										<div className="canvas-contract-list">
											{incomingEdges.map((edge) => {
												const sourceNode = nodeMap.get(edge.sourceNodeId);
												return (
													<div key={edge.id} className="canvas-contract-card">
														<div className="canvas-contract-header">
															<span>
																{t("canvas.nodeDrawer.source")}
																<b>{sourceNode?.title || edge.sourceNodeId}</b>
															</span>
															<span className="canvas-contract-type">{edgeTypeLabels[edge.type]}</span>
														</div>
														<div className="canvas-contract-ports">
															<span className="canvas-port-tag">
																{outPortLabel(edge.sourcePort, t)} → {inPortLabel(edge.targetPort, t)}
															</span>
															<label>
																{t("canvas.nodeDrawer.port")}
																<select
																	className="canvas-select"
																	value={edge.targetPort || "contract"}
																	onChange={(e) => onUpdateEdge?.(edge.id, { targetPort: e.target.value })}
																>
																	{IN_PORT_DEFS.map((d) => (
																		<option key={d.key} value={d.key}>
																			{d.label} — {d.desc}
																		</option>
																	))}
																</select>
															</label>
														</div>
														<div className="canvas-contract-content">
															{edge.lastHandoffSummary || t("canvas.nodeDrawer.waitingForUpstreamHandoff")}
														</div>
													</div>
												);
											})}
										</div>
									)}
								</div>

								<div className="canvas-contract-col">
									<h4 className="canvas-section-title">
										📤 {t("canvas.nodeDrawer.outgoingHandoffs")}
										<span className="canvas-section-badge">{outgoingEdges.length}</span>
									</h4>
									{outgoingEdges.length === 0 ? (
										<div className="canvas-empty-contract-card">
											<span>{t("canvas.nodeDrawer.noOutgoingEdgesConnectedYet")}</span>
										</div>
									) : (
										<div className="canvas-contract-list">
											{outgoingEdges.map((edge) => {
												const targetNode = nodeMap.get(edge.targetNodeId);
												return (
													<div key={edge.id} className="canvas-contract-card">
														<div className="canvas-contract-header">
															<span>
																{t("canvas.nodeDrawer.target")}
																<b>{targetNode?.title || edge.targetNodeId}</b>
															</span>
															<span className="canvas-contract-type">{edgeTypeLabels[edge.type]}</span>
														</div>
														<div className="canvas-contract-ports">
															<label>
																{t("canvas.nodeDrawer.outPort")}
																<select
																	className="canvas-select"
																	value={edge.sourcePort || "contract"}
																	onChange={(e) => {
																		const v = e.target.value;
																		onUpdateEdge?.(edge.id, {
																			sourcePort: v,
																			type:
																				v === "true"
																					? "condition_true"
																					: v === "false"
																						? "condition_false"
																						: v === "approve"
																							? "approve"
																							: v === "reject"
																								? "reject"
																								: edge.type,
																		});
																	}}
																>
																	{outPortsForRole(node.role, t).map((d) => (
																		<option key={d.key} value={d.key}>
																			{d.label} — {d.desc}
																		</option>
																	))}
																</select>
															</label>
														</div>
													</div>
												);
											})}
										</div>
									)}
								</div>
							</div>
						</div>
					)}

					{activeTab === "env" && (
						<div className="canvas-tab-panel canvas-tab-panel-env">
							<div className="canvas-env-section-card">
								<h4 className="canvas-section-title">🧠 {t("canvas.nodeDrawer.modelThinkingBudget")}</h4>
								<p className="canvas-tip" style={{ marginBottom: 10 }}>
									{t("canvas.nodeDrawer.bindASpecificLLMModelAndThinkingLevel")}
								</p>
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

							<div className="canvas-env-section-card">
								<h4 className="canvas-section-title">📂 {t("canvas.nodeDrawer.workspaceSandboxIsolation")}</h4>
								<p className="canvas-tip" style={{ marginBottom: 10 }}>
									{t("canvas.nodeDrawer.baseWorkingDirectoryForBashAndFileOperations")}
								</p>
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
								{(() => {
									const isRemote = (node.cwd ?? "").trim().startsWith("ssh://");
									return (
										<label
											className={`canvas-checkbox-row ${isRemote ? "disabled" : ""}`}
											style={{ marginTop: "12px" }}
											title={isRemote ? t("canvas.node.remoteWorktreeHint") : t("canvas.node.worktreeHint")}
										>
											<input
												type="checkbox"
												checked={!isRemote && node.useWorktree}
												disabled={isRemote}
												onChange={(e) => onUpdate(node.id, { useWorktree: e.target.checked })}
											/>
											<span className="canvas-checkbox-label">
												<FiGitBranch /> {t("canvas.drawer.worktreePath", { name: `.worktrees/canvas-${node.id}` })}
												{isRemote && (
													<small style={{ opacity: 0.65, marginLeft: 4 }}>
														{t("canvas.node.remoteIsolationExempt")}
													</small>
												)}
											</span>
										</label>
									);
								})()}
							</div>

							{node.role === "pstack" &&
								(() => {
									const curSkillKey = String(drawerCfg.skill || "poteto-mode");
									const skillItem = PSTACK_SKILLS_MAP[curSkillKey] || PSTACK_SKILLS_MAP["poteto-mode"];
									if (!skillItem) return null;
									return (
										<div className="canvas-env-section-card">
											<div
												style={{
													display: "flex",
													alignItems: "center",
													justifyContent: "space-between",
													marginBottom: "8px",
												}}
											>
												<h4 className="canvas-section-title" style={{ margin: 0 }}>
													{t("canvas.drawer.pstackGuidelines", { name: skillItem.name })}
												</h4>
												<button
													type="button"
													className="canvas-btn small"
													onClick={() => setShowSkillDoc(!showSkillDoc)}
												>
													{showSkillDoc ? t("canvas.common.collapse") : t("canvas.common.expandDetails")}
												</button>
											</div>
											<p style={{ fontSize: "12px", color: "var(--text-faint)", margin: 0 }}>{skillItem.description}</p>
											{showSkillDoc && (
												<pre
													style={{
														maxHeight: "240px",
														overflowY: "auto",
														background: "var(--bg)",
														padding: "10px",
														borderRadius: "6px",
														fontSize: "12px",
														whiteSpace: "pre-wrap",
														wordBreak: "break-word",
														border: "1px solid var(--border)",
														marginTop: "8px",
													}}
												>
													{skillItem.content}
												</pre>
											)}
										</div>
									);
								})()}

							{node.role === "skill" &&
								(() => {
									const curSkill = String(drawerCfg.skillName || "");
									return (
										<div className="canvas-env-section-card">
											<h4 className="canvas-section-title" style={{ marginTop: 0, marginBottom: "8px" }}>
												{t("canvas.drawer.skillPersona")}
											</h4>
											<p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 10px 0" }}>
												{t("canvas.drawer.selectSkillHint")}
											</p>
											<div
												style={{
													display: "flex",
													flexWrap: "wrap",
													gap: "6px",
													maxHeight: "140px",
													overflowY: "auto",
												}}
											>
												{installedSkills && installedSkills.length > 0 ? (
													installedSkills.map((s: { name: string; description: string }) => (
														<button
															key={s.name}
															type="button"
															className={`btn small ${curSkill === s.name ? "primary" : ""}`}
															onClick={() => onUpdate(node.id, { config: { ...node.config, skillName: s.name } })}
															title={s.description}
														>
															📦 {s.name}
														</button>
													))
												) : (
													<span style={{ fontSize: "12px", color: "var(--text-faint)" }}>
														{t("canvas.skills.noneInstalled")}
													</span>
												)}
											</div>
										</div>
									);
								})()}
						</div>
					)}
				</div>

				<div className="canvas-drawer-footer">
					<div className="canvas-drawer-footer-info">
						<span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
							📁 {node.cwd || "."} {node.useWorktree ? t("canvas.node.worktreeSummary") : ""}
						</span>
					</div>
					<div className="canvas-drawer-footer-actions">
						{node.status === "running" ? (
							<button type="button" className="canvas-btn stop" onClick={() => onStop(node.id)}>
								<FiSquare /> {t("canvas.nodeDrawer.stopTask")}
							</button>
						) : (
							<button
								type="button"
								className="canvas-btn run"
								disabled={!isRoleImplemented(node.role)}
								onClick={() => onRun(node.id)}
							>
								<FiPlay /> {t("canvas.nodeDrawer.runNode")}
							</button>
						)}
						<button type="button" className="canvas-btn" onClick={onClose}>
							{t("canvas.nodeDrawer.close")}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
