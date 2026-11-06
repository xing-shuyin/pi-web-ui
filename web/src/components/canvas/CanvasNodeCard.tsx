/**
 * CanvasNodeCard.tsx — 智能体画布单个节点组件（数字员工 Teammate 卡片）。
 */
import { useState, useMemo, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { CanvasEngineId, CanvasNode, ModelInfo, ProjectSummary } from "../../types";
import type { ThinkingValue } from "../../thinking-levels";
import {
	ENGINE_METAS,
	ROLE_METAS,
	ROLE_IO_HELP,
	STATUS_COLORS,
	PORT_Y_OFFSET,
	roleNeedsInstruction,
	outPortsForRole,
	IN_PORT_DEFS,
	visibleRoleFields,
	roleCapabilityNotice,
	isRoleImplemented,
} from "./CanvasTypes";
import type { RoleField } from "./CanvasTypes";
import type { ReactNode } from "react";
import { useCanvasT } from "./canvas-i18n";
import { ModelThinking } from "../ModelThinking";
import { UniversalPathPicker } from "../UniversalPathPicker";
import { FiPlay, FiSquare, FiSliders, FiTrash2, FiGitBranch, FiCpu } from "react-icons/fi";

export interface CanvasNodeCardProps {
	/** Screen-to-canvas scale used by header dragging. */
	zoom?: number;
	node: CanvasNode;
	isSelected: boolean;
	hasIncoming?: boolean;
	hasOutgoing?: boolean;
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
	onSelect: (nodeId: string) => void;
	onUpdate: (nodeId: string, patch: Partial<CanvasNode>) => void;
	onDelete: (nodeId: string) => void;
	onRun: (nodeId: string) => void;
	onStop: (nodeId: string) => void;
	onOpenDrawer: (nodeId: string) => void;
	onStartConnect: (nodeId: string, outX: number, outY: number, sourcePort?: string) => void;
	onEndConnect: (nodeId: string, targetPort?: string) => void;
	/** 拖拽卡片前通知父级保存快照（支持拖动撤销） */
	onDragStart?: () => void;
	/** 上报卡片内各字段端子的纵向中心（相对卡片顶部，画布坐标 px），供连线层按实测位置绘制 */
	onPortPositions?: (nodeId: string, positions: Record<string, number>) => void;
	/** 已连线的端子（高亮用）：{ in: [targetPort...], out: [sourcePort...] } */
	activePorts?: { in: string[]; out: string[] };
	/** 上游连线已沉淀的交付摘要（结束/汇聚节点用来展示收到的输出） */
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
	const t = useCanvasT();
	const [isDragging, setIsDragging] = useState(false);
	const [dragStart, setDragStart] = useState({ x: 0, y: 0, nodeX: 0, nodeY: 0 });
	const hasMovedRef = useRef(false);

	const engineMeta = ENGINE_METAS[node.engine] || ENGINE_METAS.pi;
	const roleMeta = ROLE_METAS[node.role] || ROLE_METAS.coder;
	const statusColor = STATUS_COLORS[node.status] || STATUS_COLORS.idle;

	// 解析出与 ModelThinking 兼容的当前模型对象：绝不杜撰，不存在时回退到全局默认/列表第一个
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
	const branchOutPorts = useMemo(() => outPortsForRole(node.role).filter((d) => d.key !== "result"), [node.role]);
	/** 纯代码节点（触发器 / 逻辑控制 / 格式转换等）不走 LLM：隐藏引擎模型目录，只露专属配置 */
	const isAgent = roleNeedsInstruction(node.role);
	const inPortTip = (key: string) => {
		const def = IN_PORT_DEFS.find((d) => d.key === key);
		return (
			t("输入端子 · ", "Input port · ") + (def ? t(def.labelZh, def.labelEn) + " — " + t(def.desc, def.descEn) : key)
		);
	};
	const outPortTip = (key: string) => {
		const def = outPortsForRole(node.role).find((d) => d.key === key);
		return (
			t("输出端子 · ", "Output port · ") + (def ? t(def.labelZh, def.labelEn) + " — " + t(def.desc, def.descEn) : key)
		);
	};

	const setCfg = (patch: Record<string, string | number | boolean>) =>
		onUpdate(node.id, { config: { ...node.config, ...patch } });
	const roleCfg = (node.config ?? {}) as Record<string, string | number | boolean | undefined>;
	/** 单个专属字段（卡片样式，全宽内联，免碰 styles.css） */
	const renderRoleField = (f: RoleField, withPort = false) => {
		if (f.kind === "hint") {
			return (
				<span key={f.key} className="canvas-muted-note">
					{f.labelZh}
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
								（暂未检测到已安装技能）
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
								{o.labelZh}
							</option>
						))}
					</select>
				);
			}
		} else {
			// 文本一律用 AI 指令同款多行框（3 行），不再用又短又矮的单行框
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
					{f.labelZh}
				</span>
				{control}
				{f.hint && <span className="canvas-muted-note">{f.hint}</span>}
			</div>
		);
	};
	/** 纯代码节点专属区：字段直接平铺（与 AI 指令同款输入框，不再套虚线外框），config 端子挂首个 label */
	const renderUtilityFields = () => {
		const fields = visibleRoleFields(node.role, roleCfg);
		if (fields.length === 0) return <span className="canvas-muted-note">{t(roleMeta.blurb, roleMeta.blurbEn)}</span>;
		return <>{fields.map((f, i) => renderRoleField(f, i === 0))}</>;
	};
	/** Agent 节点专属参数（调度器拼入提示词，所见即所得） */
	const renderAgentExtras = () => {
		const fields = visibleRoleFields(node.role, roleCfg);
		if (fields.length === 0) return null;
		return (
			<div className="canvas-node-field-col">
				<span className="canvas-field-label">角色专属参数</span>
				{fields.map((f) => renderRoleField(f))}
			</div>
		);
	};
	/** 端子纵向中心（相对卡片顶部，画布坐标）：经 offsetTop 链实测，不受视口缩放影响 */
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

	// 每次渲染后实测各字段端子位置并上报（父组件做浅比较去重，避免循环渲染）
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

	// 处理按住卡头拖拽节点位置
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
			} catch {
				// 忽略释放异常
			}
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
			{/* 节点头部：拖拽把手 + 角色 + 引擎徽标 */}
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
						title="点击修改队友名称"
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
						title={`Pstack Skill: ${String(node.config?.skill || "poteto-mode")}`}
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
						title={`Skill 灵魂: ${String(node.config?.skillName)}`}
					>
						✨ {String(node.config?.skillName)}
					</div>
				)}
			</div>

			{/* 节点配置面板：引擎、模型、目录 */}
			<div className="canvas-node-body">
				{roleCapabilityNotice(node.role) && (
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
								{t("未实现 · 禁止运行", "Not implemented · Run disabled")}
								<br />
							</strong>
						)}
						{roleCapabilityNotice(node.role, t("zh", "en") === "en")}
					</p>
				)}
				{/* 通用节点类型（对标 LangGraph/n8n 前沿范式） */}
				<div className="canvas-node-field-row">
					<span className="canvas-field-label">
						节点类型
						<span
							title={`输入：${(ROLE_IO_HELP[node.role] ?? ROLE_IO_HELP.custom).input}\n输出：${(ROLE_IO_HELP[node.role] ?? ROLE_IO_HELP.custom).output}\n用法：${(ROLE_IO_HELP[node.role] ?? ROLE_IO_HELP.custom).usage}`}
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
						title={t(roleMeta.blurb, roleMeta.blurbEn)}
					>
						{Object.values(ROLE_METAS)
							.filter((m) => isRoleImplemented(m.role) || m.role === node.role)
							.map((m) => (
								<option key={m.role} value={m.role}>
									{m.icon} {t(m.labelZh, m.labelEn)}
								</option>
							))}
					</select>
				</div>

				{/* 输入来源：单行展示（左 label 右状态），圆点锚在 label 行内 */}
				<div className="canvas-node-field-row">
					<span className="canvas-field-label">
						<div
							className={`canvas-port port-in ${hasIncoming || activePorts?.in.length ? "connected" : ""}`}
							style={{
								borderColor: hasIncoming ? "var(--accent)" : "var(--border)",
							}}
							title="输入端子 · 任务契约（主输入）：拖入连线，上游交付产物将作为任务契约注入本节点"
							data-cport="contract"
							data-canvas-node-id={node.id}
							data-canvas-port="contract"
							data-canvas-port-direction="in"
							onPointerUp={(e) => handleInUp(e, "contract")}
						>
							<span className="canvas-port-dot" />
						</div>
						输入(input)
					</span>
					<span className="canvas-muted-note">
						{hasIncoming || (activePorts?.in.length ?? 0) > 0 ? "已连接上游" : "未连接"}
					</span>
				</div>

				{/* AI 指令（可输入）：圆点锚在 label 行内，与文字对齐 */}
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
							AI 指令 (可输入·随图保存)
						</span>
						<textarea
							className="canvas-instruction-input"
							rows={3}
							value={node.instruction || ""}
							onChange={(e) => onUpdate(node.id, { instruction: e.target.value })}
							placeholder="留空=直接使用输入；或例：按输入完成开发 {{input}}…"
							title={"留空或只写 {{input}} = 直接使用上游输入；也可用 {{上游摘要}} / {{upstream}} 变量"}
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
							角色规约
						</span>
						<textarea
							className="canvas-instruction-input"
							rows={3}
							value={node.systemPromptOverride || ""}
							onChange={(e) => onUpdate(node.id, { systemPromptOverride: e.target.value })}
							placeholder="该节点的基座人设，可多行输入…"
							title="基座人设（System Prompt），可直接输入；详情在抽屉中编辑"
						/>
					</div>
				)}
				{!isAgent && renderUtilityFields()}
				{isAgent && renderAgentExtras()}
				{isAgent && (
					<>
						<div className="canvas-node-field-row">
							<span className="canvas-field-label">
								<FiCpu /> 引擎底座
							</span>
							<select
								className="canvas-select"
								value={node.engine}
								onChange={(e) => onUpdate(node.id, { engine: e.target.value as CanvasEngineId })}
							>
								<option value="pi">Pi 原生</option>
								<option value="dsh">DSH 极速</option>
								<option value="claude">Claude Code</option>
								<option value="codex">Codex</option>
								<option value="durable">Durable 自愈</option>
							</select>
						</div>

						{/* 模型与思考强度胶囊（直接复用主对话通用 ModelThinking 组件） */}
						<div className="canvas-node-field-col">
							<span className="canvas-field-label">模型与思考强度</span>
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

						{/* 工作目录选择与本地浏览（直接复用通用 UniversalPathPicker 组件） */}
						<div className="canvas-node-field-col">
							<span className="canvas-field-label">工作区目录</span>
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

						{/* Git Worktree 物理隔离开关 */}
						{(() => {
							const isRemote = (node.cwd ?? "").trim().startsWith("ssh://");
							return (
								<label
									className={`canvas-checkbox-row ${isRemote ? "disabled" : ""}`}
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
										<FiGitBranch /> 启用独立 Git Worktree 物理隔离
										{isRemote && <small style={{ opacity: 0.65, marginLeft: 4 }}>(远程环境免隔离)</small>}
									</span>
								</label>
							);
						})()}
					</>
				)}

				{/* 分支输出端子：条件成立/不成立、批准/驳回，各绑定独立连线 */}
				{branchOutPorts.length > 0 && (
					<div className="canvas-node-branch-group">
						{branchOutPorts.map((bd) => (
							<div key={bd.key} className="canvas-branch-row" title={outPortTip(bd.key)}>
								<span className="canvas-branch-label">
									{bd.key === "true" ? "✓ " : bd.key === "false" ? "✗ " : bd.key === "approve" ? "✓ " : "↺ "}
									{t(bd.labelZh, bd.labelEn)}
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
				{/* 结束/汇聚节点：把上游连线沉淀的交付摘要直接展示出来 */}
				{(node.role === "end" || node.role === "merge") && (
					<div className="canvas-node-field-col" title={incomingPreview || "暂无上游输入"}>
						<span className="canvas-field-label">收到的输出</span>
						<span className="canvas-muted-note canvas-output-preview">
							{incomingPreview
								? incomingPreview.slice(0, 120) + (incomingPreview.length > 120 ? "…" : "")
								: "暂无上游输入"}
						</span>
					</div>
				)}
				{/* 输出内容提示：期望输出 + 实际产物预览（悬停看全文） */}
				<div
					className="canvas-node-field-col"
					title={
						node.status === "error" && node.error
							? `执行出错：${node.error}`
							: node.lastOutputSummary
								? node.lastOutputSummary
								: `该节点将输出：${(ROLE_IO_HELP[node.role] ?? ROLE_IO_HELP.custom).output}`
					}
				>
					<span className="canvas-field-label">
						<div
							className={`canvas-port port-out ${hasOutgoing || activePorts?.out.length ? "connected" : ""}`}
							style={{
								borderColor: engineMeta.color,
							}}
							title="输出端子 · 交付产物（主输出）：按住拖拽连线至目标节点的某个输入端子"
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
						输出内容
					</span>
					{/* 出错时优先显示本轮真实报错，不挂上一次遗留的「交付完成」 */}
					{node.status === "error" && node.error ? (
						<span className="canvas-muted-note canvas-output-preview canvas-output-error">
							{`执行出错：${node.error}`.slice(0, 120)}
						</span>
					) : (
						<span className="canvas-muted-note canvas-output-preview">
							{node.lastOutputSummary
								? node.lastOutputSummary.slice(0, 120) + (node.lastOutputSummary.length > 120 ? "…" : "")
								: !isRoleImplemented(node.role)
									? t("未实现 · 无执行产物", "Not implemented · No execution output")
									: `将输出：${(ROLE_IO_HELP[node.role] ?? ROLE_IO_HELP.custom).output}`}
						</span>
					)}
				</div>
				{/* 实时状态灯与动态简报 */}
				<div
					className="canvas-node-status-bar"
					style={{
						backgroundColor: statusColor.bg,
						color: statusColor.text,
					}}
				>
					<span className="canvas-status-dot" style={{ backgroundColor: statusColor.dot }} />
					<span className="canvas-status-text">
						{node.currentAction ||
							(node.status === "idle"
								? "待命中"
								: node.status === "running"
									? "执行中"
									: node.status === "waiting_approval"
										? "待人工审批"
										: node.status === "done"
											? t("任务交付完成", "Completed")
											: node.status === "skipped"
												? t("已跳过", "Skipped")
												: node.status === "cancelled"
													? t("已取消", "Cancelled")
													: node.status === "queued"
														? t("排队中", "Queued")
														: node.status === "paused"
															? t("已暂停", "Paused")
															: t("执行出错", "Failed"))}
					</span>
				</div>
			</div>

			{/* 节点底部控制条 */}
			<div className="canvas-node-footer">
				{node.status === "running" ? (
					<button
						type="button"
						className="canvas-btn stop"
						title="中止执行"
						onClick={(e) => {
							e.stopPropagation();
							onStop(node.id);
						}}
					>
						<FiSquare /> 停止
					</button>
				) : (
					<button
						type="button"
						className="canvas-btn run"
						disabled={!isRoleImplemented(node.role)}
						title="启动该节点"
						onClick={(e) => {
							e.stopPropagation();
							onRun(node.id);
						}}
					>
						<FiPlay /> 启动
					</button>
				)}

				<button
					type="button"
					className="canvas-btn"
					title="打开审查与深控抽屉"
					onClick={(e) => {
						e.stopPropagation();
						onOpenDrawer(node.id);
					}}
				>
					<FiSliders /> 审查/插话
				</button>

				<button
					type="button"
					className="canvas-btn del"
					title="删除此节点"
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
