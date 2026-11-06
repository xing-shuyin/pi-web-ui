/**
 * CanvasNodeDrawer.tsx — 数字员工审查门禁与深度控制台弹窗 (Review Gate & Workspace Console)。
 * 方案 1: 工作台场景选项卡 (Workspace Tabs) 架构，彻底消除视域拥挤，每个场景独享 100% 宽幅空间。
 */
import { useState, useEffect, useMemo, useRef } from "react";
import { useCopyFeedback } from "../../use-copy-feedback";
import type { CanvasNode, CanvasEdge, CanvasNodeLogEntry, ModelInfo, ProjectSummary, UiMessage } from "../../types";
import type { ThinkingValue } from "../../thinking-levels";
import type { RoleField } from "./CanvasTypes";
import type { ReactNode } from "react";
import {
	ENGINE_METAS,
	ROLE_METAS,
	IN_PORT_DEFS,
	outPortsForRole,
	inPortLabel,
	outPortLabel,
	visibleRoleFields,
	roleCapabilityNotice,
	isRoleImplemented,
} from "./CanvasTypes";
import { useCanvasT } from "./canvas-i18n";
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
import { PSTACK_SKILLS_MAP } from "./pstack-skills-data";

export type CanvasDrawerTab = "console" | "prompts" | "contracts" | "env";

export interface CanvasNodeDrawerProps {
	node: CanvasNode | null;
	edges: CanvasEdge[];
	allNodes: CanvasNode[];
	models: ModelInfo[];
	/** 全局默认模型（"provider/model-id"），列表中找不到节点模型时的显示回退 */
	defaultModel?: string | null;
	installedSkills?: { name: string; description: string }[];
	projects: ProjectSummary[];
	workspaceRoots?: string[];
	pathCompletions?: { name: string; path: string; type: "dir" | "file" }[];
	/** cwd 为 "." 时弹窗初始目录的回退（画布 currentCwd） */
	baseCwd?: string;
	/** 经画布通道下发 make_dir（缺省由通用选择器内置回退经主通道创建） */
	onMakeDir?: (path: string) => void;
	onClose: () => void;
	onUpdate: (nodeId: string, patch: Partial<CanvasNode>) => void;
	onRun: (nodeId: string) => void;
	onStop: (nodeId: string) => void;
	onSteer: (nodeId: string, message: string) => void;
	onReview?: (nodeId: string, decision: "approve" | "reject", comment?: string) => void;
	/** 复用的对话流：entries=协同事件，messages=与主对话同构 UiMessage[] */
	logEntries?: CanvasNodeLogEntry[];
	logMessages?: UiMessage[];
	onClearLog?: (nodeId: string) => void;
	/** 重指定连线端子/类型（Studio handleUpdateEdge） */
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
	const t = useCanvasT();
	const [steerInput, setSteerInput] = useState("");
	const [logTab, setLogTab] = useState<"chat" | "events">("chat");
	const [showSkillDoc, setShowSkillDoc] = useState(false);
	const [isMaximized, setIsMaximized] = useState(false);
	const { copied: copiedSummary, copy: copySummary } = useCopyFeedback({ duration: 2000 });
	const logScrollRef = useRef<HTMLDivElement | null>(null);

	// 根据当前节点状态智能感知默认激活的场景选项卡
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

	// 节点状态变更时（例如转入待审批或运行），智能自动跳转到对应关键 Tab
	useEffect(() => {
		if (!node) return;
		if (node.status === "waiting_approval") {
			setActiveTab("contracts");
		} else if (node.status === "running") {
			setActiveTab("console");
		}
	}, [node?.id, node?.status]);

	// 支持按 Escape 键退出全屏或关闭弹窗
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

	/** 专属参数单字段（抽屉样式）：全走 ROLE_FIELDS 总表，与卡片同构 */
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
							（暂未检测到已安装技能，可在系统设置中添加）
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
							{o.labelZh}
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
				<span>{f.labelZh}</span>
				{control}
				{f.hint && <span className="canvas-muted-note">{f.hint}</span>}
			</label>
		);
	};

	const logKindLabel = (e: CanvasNodeLogEntry) =>
		e.kind === "tool"
			? "🔧 " + (e.toolName || "tool")
			: e.kind === "error"
				? "❌ error"
				: e.kind === "steer"
					? "💬 steer"
					: e.kind === "handoff"
						? "🔗 handoff"
						: e.kind === "review"
							? "🔍 review"
							: e.kind === "prompt"
								? "📝 prompt"
								: e.kind === "done"
									? "✅ done"
									: "ℹ️ system";

	useEffect(() => {
		logScrollRef.current?.scrollTo({ top: logScrollRef.current.scrollHeight });
	}, [logMessages.length, logEntries.length, logTab]);

	// 解析出与 ModelThinking 兼容的当前模型对象：绝不杜撰，不存在时回退到全局默认/列表第一个
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

	// 查询输入连线（上游契约）
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
				{/* 弹窗头部：支持双击切换全屏 */}
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
									{node.status.toUpperCase()}
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
							title={isMaximized ? t("还原窗口 (Esc)", "Restore window (Esc)") : t("全屏查看", "Fullscreen view")}
							aria-label={isMaximized ? "Restore window" : "Fullscreen view"}
						>
							{isMaximized ? <FiMinimize2 /> : <FiMaximize2 />}
						</button>
						<button
							type="button"
							className="canvas-drawer-action-btn canvas-drawer-close"
							onClick={onClose}
							title={t("关闭 (Esc)", "Close (Esc)")}
							aria-label="Close"
						>
							<FiX />
						</button>
					</div>
				</div>

				{/* 场景选项卡导航栏 (Workspace Tabs) */}
				<div className="canvas-drawer-tabs-bar">
					<button
						type="button"
						className={`canvas-drawer-tab ${activeTab === "console" ? "active" : ""}`}
						onClick={() => setActiveTab("console")}
					>
						<FiActivity />
						<span>{t("实时运行与实录", "Live Console & Stream")}</span>
						{node.status === "running" ? (
							<span className="canvas-tab-badge pulse">{t("执行中", "Running")}</span>
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
						<span>{t("AI 任务指令与人设", "Prompts & Instructions")}</span>
					</button>

					<button
						type="button"
						className={`canvas-drawer-tab ${activeTab === "contracts" ? "active" : ""}`}
						onClick={() => setActiveTab("contracts")}
					>
						<FiCheckCircle />
						<span>{t("契约与审查门禁", "Contracts & Review")}</span>
						{node.status === "waiting_approval" ? (
							<span className="canvas-tab-badge warning">{t("待审批", "Needs Review")}</span>
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
						<span>{t("沙箱与物理环境", "Sandbox & Environment")}</span>
					</button>
				</div>

				{/* 弹窗内容区：四大场景选项卡各自独占 100% 宽幅视域 */}
				<div className="canvas-drawer-body">
					{/* Tab 1: 实时运行与控制台 (Live Console) */}
					{activeTab === "console" && (
						<div className="canvas-tab-panel canvas-tab-panel-console">
							<div className="canvas-log-section">
								<div className="canvas-log-header">
									<div className="canvas-log-tabs">
										<button
											type="button"
											className={"canvas-log-tab " + (logTab === "chat" ? "active" : "")}
											onClick={() => setLogTab("chat")}
											title="复用主对话流的消息"
										>
											<FiMessageSquare /> 对话 {logMessages.length ? "(" + logMessages.length + ")" : ""}
										</button>
										<button
											type="button"
											className={"canvas-log-tab " + (logTab === "events" ? "active" : "")}
											onClick={() => setLogTab("events")}
											title="调用/错误/协同事件"
										>
											<FiActivity /> 事件 {logEntries.length ? "(" + logEntries.length + ")" : ""}
										</button>
										{(logEntries.length > 0 || logMessages.length > 0) && onClearLog && (
											<button
												type="button"
												className="canvas-log-clear"
												onClick={() => onClearLog(node.id)}
												title="清空对话实录"
											>
												<FiTrash2 /> {t("清空实录", "Clear")}
											</button>
										)}
									</div>
									<div className="canvas-console-status-note">
										{node.status === "running" ? (
											<span style={{ color: "var(--accent)", display: "flex", alignItems: "center", gap: 6 }}>
												<span className="canvas-pulse-dot" /> {t("正在执行任务中...", "Agent is running...")}
											</span>
										) : (
											<span style={{ color: "var(--text-faint)" }}>
												{t("已就绪 · 工具调用与交互均实时呈现", "Ready · Stream updates live")}
											</span>
										)}
									</div>
								</div>
								<div className="canvas-log-body" ref={logScrollRef}>
									{logTab === "chat" ? (
										logMessages.length === 0 ? (
											<div className="canvas-log-empty">
												<FiMessageSquare style={{ fontSize: 32, opacity: 0.3 }} />
												<p>
													{t(
														"暂无对话消息：启动节点后，这里复用主对话流实时显示每一轮调用、终端输出与回复。",
														"No messages yet: after running, chat flow and bash outputs will stream live here.",
													)}
												</p>
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
											<p>
												{t(
													"暂无协同事件：工具调用、报错、插话与交接都会记在这里。",
													"No events yet: tool calls, errors, steer and handoffs will be recorded here.",
												)}
											</p>
										</div>
									) : (
										logEntries.slice(-200).map((e) => (
											<div key={e.id} className={"canvas-log-entry kind-" + e.kind}>
												<span className="canvas-log-kind">{logKindLabel(e)}</span>
												<span className="canvas-log-time">{new Date(e.ts).toLocaleTimeString()}</span>
												<div className="canvas-log-text">{e.text}</div>
											</div>
										))
									)}
								</div>
							</div>

							{/* 实时插话纠偏控制栏 */}
							<div className="canvas-steer-section">
								<div className="canvas-steer-bar">
									<input
										type="text"
										className="canvas-steer-input"
										placeholder={t(
											"输入实时纠偏意见 (如: 别修改 styles.css，只在组件内局部改动)...",
											"Input steer instruction to adjust agent behavior...",
										)}
										value={steerInput}
										onChange={(e) => setSteerInput(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") handleSendSteer();
										}}
									/>
									<button type="button" className="canvas-steer-btn" onClick={handleSendSteer} title="发送插话">
										<FiSend /> {t("发送插话", "Steer")}
									</button>
								</div>
							</div>
						</div>
					)}

					{/* Tab 2: AI 任务指令与人设 (Prompts & Instructions) */}
					{activeTab === "prompts" && (
						<div className="canvas-tab-panel canvas-tab-panel-prompts">
							{roleCapabilityNotice(node.role) && (
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
											{t("未实现 · 禁止运行", "Not implemented · Run disabled")}
											<br />
										</strong>
									)}
									{roleCapabilityNotice(node.role, t("zh", "en") === "en")}
								</p>
							)}

							<div className="canvas-prompts-grid">
								{/* 左卡片：角色人设 System Prompt */}
								<div className="canvas-prompt-card">
									<div className="canvas-prompt-card-header">
										<h4 className="canvas-section-title">
											🎭 {t("角色指令规约 (System Prompt 基座人设)", "System Prompt")}
										</h4>
										<small style={{ color: "var(--text-faint)" }}>{t("决定“是谁”", "Defines identity")}</small>
									</div>
									<textarea
										className="canvas-drawer-textarea canvas-prompt-textarea"
										value={node.systemPromptOverride || ""}
										onChange={(e) => onUpdate(node.id, { systemPromptOverride: e.target.value })}
										placeholder={t(
											"输入该数字员工的专属职责人设（基座），与「任务指令」配合使用…",
											"Enter system prompt identity for this digital worker...",
										)}
									/>
									<p className="canvas-tip">
										{t(
											"基座人设×任务指令双轨制：人设决定“是谁”，任务指令决定“做什么”。启动优先级：本次手动输入 > 节点 AI 指令 > 角色规约。",
											"Identity defines who it is; instruction defines what to do.",
										)}
									</p>
								</div>

								{/* 右卡片：AI 任务指令 Instruction */}
								<div className="canvas-prompt-card">
									<div className="canvas-prompt-card-header">
										<h4 className="canvas-section-title">
											🎯 {t("AI 任务指令 (可输入·随图保存)", "AI Instruction (Saved with graph)")}
										</h4>
										<small style={{ color: "var(--text-faint)" }}>{t("决定“做什么”", "Defines task")}</small>
									</div>
									<div className="canvas-variable-chips">
										<span style={{ fontSize: 11, color: "var(--text-faint)" }}>
											{t("快捷变量插入：", "Insert variable:")}
										</span>
										<button
											type="button"
											className="canvas-var-chip"
											onClick={() => {
												const cur = node.instruction || "";
												onUpdate(node.id, { instruction: cur ? `${cur} {{input}}` : "{{input}}" });
											}}
											title="引用上游所有输入合流内容"
										>
											+ &#123;&#123;input&#125;&#125;
										</button>
										<button
											type="button"
											className="canvas-var-chip"
											onClick={() => {
												const cur = node.instruction || "";
												onUpdate(node.id, { instruction: cur ? `${cur} {{上游摘要}}` : "{{上游摘要}}" });
											}}
											title="引用上游交付物摘要"
										>
											+ &#123;&#123;上游摘要&#125;&#125;
										</button>
										<button
											type="button"
											className="canvas-var-chip"
											onClick={() => {
												const cur = node.instruction || "";
												onUpdate(node.id, { instruction: cur ? `${cur} {{upstream}}` : "{{upstream}}" });
											}}
											title="英文 alias 引用上游输入"
										>
											+ &#123;&#123;upstream&#125;&#125;
										</button>
									</div>
									<textarea
										className="canvas-drawer-textarea canvas-prompt-textarea canvas-instruction-textarea"
										value={node.instruction || ""}
										onChange={(e) => onUpdate(node.id, { instruction: e.target.value })}
										placeholder={t(
											"留空=直接使用输入；或例：按照 PRD 完成登录页 {{input}}…",
											"Empty = use upstream input directly; or e.g. Implement login page based on {{input}}...",
										)}
									/>
									<p className="canvas-tip">
										{t(
											"支持变量：{{input}} / {{上游摘要}} / {{upstream}} 引用上游输入；留空 = 直接使用输入。",
											"Variables supported: {{input}}, {{upstream}}; empty = direct pass-through.",
										)}
									</p>
								</div>
							</div>

							{/* 通用工作流控制参数：条件 / 循环 / 审批 / 工具 / API 等 */}
							{visibleRoleFields(node.role, drawerCfg).length > 0 && (
								<div className="canvas-drawer-section" style={{ marginTop: 8 }}>
									<h4 className="canvas-section-title">⚙️ {t("节点专属控制参数", "Node Control Parameters")}</h4>
									<div className="canvas-role-fields-grid">
										{visibleRoleFields(node.role, drawerCfg).map((f) => renderDrawerField(f))}
									</div>
								</div>
							)}
						</div>
					)}

					{/* Tab 3: 上下游契约与审查门禁 (Contracts & Review) */}
					{activeTab === "contracts" && (
						<div className="canvas-tab-panel canvas-tab-panel-contracts">
							{/* 任务交付物与审查门禁 (Review Gate) */}
							<div className="canvas-review-gate-card">
								<div className="canvas-summary-header">
									<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
										<h4 className="canvas-section-title" style={{ fontSize: 14 }}>
											🔍 {t("任务交付物与审查门禁 (Review Gate)", "Review Gate & Deliverable")}
										</h4>
										<span className={`status-badge status-${node.status}`}>{node.status.toUpperCase()}</span>
									</div>
									{node.lastOutputSummary && (
										<button
											type="button"
											className="canvas-btn small"
											onClick={() => {
												void copySummary(node.lastOutputSummary || "");
											}}
											title="复制交付物摘要文本"
										>
											{copiedSummary ? <FiCheck style={{ color: "var(--green)" }} /> : <FiCopy />}
											{copiedSummary ? t("已复制", "Copied") : t("复制摘要", "Copy Summary")}
										</button>
									)}
								</div>

								{node.status === "error" && node.error ? (
									<div className="canvas-summary-error-box">
										<p className="canvas-summary-text canvas-summary-error">
											❌ {t("执行失败：", "Execution failed: ")}
											{node.error}
										</p>
										<div className="canvas-review-actions">
											<button type="button" className="canvas-btn green" onClick={() => onRun(node.id)}>
												<FiPlay /> {t("重跑本节点", "Rerun Node")}
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
												⚠️{" "}
												{t(
													"节点正在执行新任务中，以下为上一轮产出摘要。执行完成前不可裁决。",
													"Node is executing a new task. Above is previous summary. Cannot review until done.",
												)}
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
													else onUpdate(node.id, { status: "done", currentAction: "人工审查批准合流" });
												}}
											>
												<FiCheckCircle /> {t("审查通过并批准合流", "Approve & Merge")}
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
															currentAction: "人工驳回：需补充完善测试与注释",
														});
												}}
											>
												<FiAlertCircle /> {t("驳回修改", "Reject & Revise")}
											</button>
										</div>
									</div>
								) : (
									<div className="canvas-empty-contract-hint">
										<p className="canvas-text-muted">
											{t("暂无交付物产出，等待节点执行完成。", "No deliverables yet. Waiting for node completion.")}
										</p>
									</div>
								)}
							</div>

							{/* 双列展示上游输入契约与下游去向交接 */}
							<div className="canvas-contracts-grid">
								{/* 上游前置契约 */}
								<div className="canvas-contract-col">
									<h4 className="canvas-section-title">
										📥 {t("上游前置契约 (Incoming Contracts)", "Incoming Contracts")}
										<span className="canvas-section-badge">{incomingEdges.length}</span>
									</h4>
									{incomingEdges.length === 0 ? (
										<div className="canvas-empty-contract-card">
											<span>{t("本节点作为工作流源头，暂无上游连线输入", "Root node without incoming contracts")}</span>
										</div>
									) : (
										<div className="canvas-contract-list">
											{incomingEdges.map((edge) => {
												const sourceNode = nodeMap.get(edge.sourceNodeId);
												return (
													<div key={edge.id} className="canvas-contract-card">
														<div className="canvas-contract-header">
															<span>
																{t("来源：", "Source: ")}
																<b>{sourceNode?.title || edge.sourceNodeId}</b>
															</span>
															<span className="canvas-contract-type">{edge.type}</span>
														</div>
														<div className="canvas-contract-ports">
															<span className="canvas-port-tag">
																{t(outPortLabel(edge.sourcePort, "zh"), outPortLabel(edge.sourcePort, "en"))} →{" "}
																{t(inPortLabel(edge.targetPort, "zh"), inPortLabel(edge.targetPort, "en"))}
															</span>
															<label>
																{t("接入端子：", "Port: ")}
																<select
																	className="canvas-select"
																	value={edge.targetPort || "contract"}
																	onChange={(e) => onUpdateEdge?.(edge.id, { targetPort: e.target.value })}
																>
																	{IN_PORT_DEFS.map((d) => (
																		<option key={d.key} value={d.key}>
																			{t(d.labelZh, d.labelEn)} — {t(d.desc, d.descEn)}
																		</option>
																	))}
																</select>
															</label>
														</div>
														<div className="canvas-contract-content">
															{edge.lastHandoffSummary ||
																t("（等待上游完成交付后自动注入）", "(Waiting for upstream handoff)")}
														</div>
													</div>
												);
											})}
										</div>
									)}
								</div>

								{/* 下游交接 */}
								<div className="canvas-contract-col">
									<h4 className="canvas-section-title">
										📤 {t("下游交接 (Outgoing Handoffs)", "Outgoing Handoffs")}
										<span className="canvas-section-badge">{outgoingEdges.length}</span>
									</h4>
									{outgoingEdges.length === 0 ? (
										<div className="canvas-empty-contract-card">
											<span>{t("本节点暂无连向后续员工的下游交接连线", "No outgoing edges connected yet")}</span>
										</div>
									) : (
										<div className="canvas-contract-list">
											{outgoingEdges.map((edge) => {
												const targetNode = nodeMap.get(edge.targetNodeId);
												return (
													<div key={edge.id} className="canvas-contract-card">
														<div className="canvas-contract-header">
															<span>
																{t("去向：", "Target: ")}
																<b>{targetNode?.title || edge.targetNodeId}</b>
															</span>
															<span className="canvas-contract-type">{edge.type}</span>
														</div>
														<div className="canvas-contract-ports">
															<label>
																{t("连线输出端子：", "Out Port: ")}
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
																	{outPortsForRole(node.role).map((d) => (
																		<option key={d.key} value={d.key}>
																			{t(d.labelZh, d.labelEn)} — {t(d.desc, d.descEn)}
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

					{/* Tab 4: 沙箱与物理环境 (Sandbox & Environment) */}
					{activeTab === "env" && (
						<div className="canvas-tab-panel canvas-tab-panel-env">
							{/* 模型与思考强度配置（通用 ModelThinking 控件） */}
							<div className="canvas-env-section-card">
								<h4 className="canvas-section-title">
									🧠 {t("模型选择与思考强度 (Model & Thinking)", "Model & Thinking Budget")}
								</h4>
								<p className="canvas-tip" style={{ marginBottom: 10 }}>
									{t(
										"为该数字员工绑定专门的执行大模型。支持独立设置思考深度与上下文预算。",
										"Bind a specific LLM model and thinking level for this worker.",
									)}
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

							{/* 环境与物理目录（通用 UniversalPathPicker 控件） */}
							<div className="canvas-env-section-card">
								<h4 className="canvas-section-title">
									📂 {t("工作区沙箱环境与物理隔离", "Workspace Sandbox & Isolation")}
								</h4>
								<p className="canvas-tip" style={{ marginBottom: 10 }}>
									{t(
										"数字员工执行工具（bash、文件读写、git 操作）时的基准物理路径。",
										"Base working directory for bash and file operations.",
									)}
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
											title={
												isRemote
													? "远程 SSH 工作区项目直接在目标远端执行，不走本地 Git Worktree"
													: "为该数字员工拉取独立的 Git Worktree 沙箱，避免文件并发冲突"
											}
										>
											<input
												type="checkbox"
												checked={!isRemote && node.useWorktree}
												disabled={isRemote}
												onChange={(e) => onUpdate(node.id, { useWorktree: e.target.checked })}
											/>
											<span className="canvas-checkbox-label">
												<FiGitBranch /> 启用独立 Git Worktree 物理隔离 (.worktrees/canvas-{node.id})
												{isRemote && <small style={{ opacity: 0.65, marginLeft: 4 }}>(远程环境免隔离)</small>}
											</span>
										</label>
									);
								})()}
							</div>

							{/* Pstack 专项规约与工作依据详情 */}
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
													{t("📖 Pstack 专项规约与工作依据: ", "📖 Pstack skill & playbook: ")}
													{t(skillItem.nameZh, skillItem.nameEn)}
												</h4>
												<button
													type="button"
													className="canvas-btn small"
													onClick={() => setShowSkillDoc(!showSkillDoc)}
												>
													{showSkillDoc ? t("收起", "Collapse") : t("展开详情", "Show details")}
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

							{/* Skill 角色：已安装与公开技能灵魂选择 */}
							{node.role === "skill" &&
								(() => {
									const curSkill = String(drawerCfg.skillName || "");
									return (
										<div className="canvas-env-section-card">
											<h4 className="canvas-section-title" style={{ marginTop: 0, marginBottom: "8px" }}>
												✨ 注入已安装技能作为智能体灵魂
											</h4>
											<p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 10px 0" }}>
												点击下列已安装的技能，快速注入为该节点的执行灵魂：
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
														暂未检测到已安装技能，可在系统设置中添加。
													</span>
												)}
											</div>
										</div>
									);
								})()}
						</div>
					)}
				</div>

				{/* 弹窗底部控制 */}
				<div className="canvas-drawer-footer">
					<div className="canvas-drawer-footer-info">
						<span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
							📁 {node.cwd || "."} {node.useWorktree ? "· 独立 Worktree 沙箱" : ""}
						</span>
					</div>
					<div className="canvas-drawer-footer-actions">
						{node.status === "running" ? (
							<button type="button" className="canvas-btn stop" onClick={() => onStop(node.id)}>
								<FiSquare /> {t("停止当前任务", "Stop Task")}
							</button>
						) : (
							<button
								type="button"
								className="canvas-btn run"
								disabled={!isRoleImplemented(node.role)}
								onClick={() => onRun(node.id)}
							>
								<FiPlay /> {t("启动该节点", "Run Node")}
							</button>
						)}
						<button type="button" className="canvas-btn" onClick={onClose}>
							{t("关闭", "Close")}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
