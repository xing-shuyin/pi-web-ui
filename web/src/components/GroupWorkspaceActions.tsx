import React, { useState, useEffect, useRef } from "react";
import {
	FiPlay,
	FiCheckCircle,
	FiClock,
	FiLayout,
	FiSliders,
	FiShield,
	FiAlertTriangle,
	FiRefreshCw,
} from "react-icons/fi";
import type { GroupTaskPlan, GroupCanvasRef, BotPresetSnapshot } from "../group-capabilities";
import { shouldAutoExecuteCanvas, sanitizeBotPreset, isSnapshotApplicableToTask } from "../group-capabilities";
import { prepareStartPlanExecution } from "../group-view-state";
import { isZhLocale, useI18n } from "../i18n";

export interface GroupWorkspaceActionsProps {
	roomId: string;
	activeTaskId?: string;
	taskSnapshotRevision?: number;
	planState?: GroupTaskPlan;
	canvasRef?: GroupCanvasRef;
	botSnapshot?: BotPresetSnapshot;
	onStartPlanExecution?: (taskId: string) => Promise<void> | void;
	onLaunchCanvas?: (graphId: string) => Promise<void> | void;
	onApplyPresetSnapshot?: (botId: string, snapshot: BotPresetSnapshot) => Promise<void> | void;
	uiSlotEntries?: import("../ui-slots").UiSlotEntry[];
	onUiAction?: (entry: import("../ui-slots").UiSlotEntry, value?: string) => void;
	className?: string;
}

const words = {
	zh: {
		planTitle: "群任务计划",
		planDraft: "计划草稿编制中",
		planReady: "计划已就绪（需确认后开始）",
		planApproved: "计划已批准实施",
		startPlan: "开始实施",
		startingPlan: "正在启动…",
		canvasTitle: "关联画布工作流",
		canvasManualNote: "画布已就绪。引用不会自动运行，点击按钮显式启动。",
		launchCanvas: "启动画布",
		launchingCanvas: "正在启动画布…",
		botPresetTitle: "Bot 运行快照",
		lockedSnapshot: "在途任务快照已锁定（v{rev}）",
		toolsCount: "已授权 {count} 个工具",
		isolatedNote: "独立隔离运行，未共享主会话私有配置",
		applyPreset: "应用最新快照",
		applyingPreset: "应用中…",
		lockedCannotApply: "在途任务禁止热改预设",
	},
	en: {
		planTitle: "Group Task Plan",
		planDraft: "Drafting plan",
		planReady: "Plan Ready (Requires confirmation to start)",
		planApproved: "Plan approved & executing",
		startPlan: "Start Execution",
		startingPlan: "Starting…",
		canvasTitle: "Linked Canvas Workflow",
		canvasManualNote: "Canvas attached. Workflow will not run automatically. Click to launch explicitly.",
		launchCanvas: "Launch Canvas",
		launchingCanvas: "Launching canvas…",
		botPresetTitle: "Bot Preset Snapshot",
		lockedSnapshot: "Active task snapshot locked (v{rev})",
		toolsCount: "{count} authorized tools",
		isolatedNote: "Isolated run, main session private config is not leaked",
		applyPreset: "Apply Latest Snapshot",
		applyingPreset: "Applying…",
		lockedCannotApply: "Active tasks cannot hot-reload presets",
	},
};

export function GroupWorkspaceActions({
	roomId,
	activeTaskId,
	taskSnapshotRevision,
	planState,
	canvasRef,
	botSnapshot,
	onStartPlanExecution,
	onLaunchCanvas,
	onApplyPresetSnapshot,
	uiSlotEntries,
	onUiAction,
	className,
}: GroupWorkspaceActionsProps) {
	const { locale } = useI18n();
	const w = words[isZhLocale(locale) ? "zh" : "en"];

	// 房间生命周期跟踪：切房间时丢弃旧回调结果
	const activeRoomIdRef = useRef(roomId);
	useEffect(() => {
		activeRoomIdRef.current = roomId;
		setErrorNotice(null);
		setStartingPlan(false);
		setLaunchingCanvas(false);
		setApplyingPreset(false);
	}, [roomId]);

	const [startingPlan, setStartingPlan] = useState(false);
	const [launchingCanvas, setLaunchingCanvas] = useState(false);
	const [applyingPreset, setApplyingPreset] = useState(false);
	const [errorNotice, setErrorNotice] = useState<string | null>(null);

	// 计划模式硬门禁：必须用户显式点击且处于 ready 状态
	const handleStartPlan = async () => {
		if (!activeTaskId || !planState || startingPlan || !onStartPlanExecution) return;
		const check = prepareStartPlanExecution(planState);
		if (!check.ok) {
			setErrorNotice(check.reason ?? "Plan is not ready for approval");
			return;
		}

		setErrorNotice(null);
		setStartingPlan(true);
		try {
			await onStartPlanExecution(activeTaskId);
		} catch (err) {
			if (activeRoomIdRef.current === roomId) {
				setErrorNotice(err instanceof Error ? err.message : String(err));
			}
		} finally {
			if (activeRoomIdRef.current === roomId) {
				setStartingPlan(false);
			}
		}
	};

	// 画布工作流显式启动：绝不自动运行，必须显式调用
	const handleLaunchCanvas = async () => {
		if (!canvasRef || launchingCanvas || !onLaunchCanvas) return;
		// 权威硬校验：确保绝不自动执行
		if (shouldAutoExecuteCanvas(canvasRef)) return;

		setErrorNotice(null);
		setLaunchingCanvas(true);
		try {
			await onLaunchCanvas(canvasRef.graphId);
		} catch (err) {
			if (activeRoomIdRef.current === roomId) {
				setErrorNotice(err instanceof Error ? err.message : String(err));
			}
		} finally {
			if (activeRoomIdRef.current === roomId) {
				setLaunchingCanvas(false);
			}
		}
	};

	// Bot 预设快照应用：白名单净化与在途任务热改防护
	const handleApplyPreset = async () => {
		if (!botSnapshot || applyingPreset || !onApplyPresetSnapshot) return;

		const isLocked = !isSnapshotApplicableToTask(taskSnapshotRevision, botSnapshot.revision);
		if (isLocked) {
			setErrorNotice(w.lockedCannotApply);
			return;
		}

		setErrorNotice(null);
		setApplyingPreset(true);
		try {
			// 白名单净化，安全隔离主会话私有配置
			const sanitized = sanitizeBotPreset(botSnapshot, botSnapshot.botId, botSnapshot.revision + 1);
			await onApplyPresetSnapshot(botSnapshot.botId, sanitized);
		} catch (err) {
			if (activeRoomIdRef.current === roomId) {
				setErrorNotice(err instanceof Error ? err.message : String(err));
			}
		} finally {
			if (activeRoomIdRef.current === roomId) {
				setApplyingPreset(false);
			}
		}
	};

	const hasContent = Boolean(
		errorNotice || planState || canvasRef || botSnapshot || (uiSlotEntries && uiSlotEntries.length > 0),
	);
	if (!hasContent) return null;

	return (
		<div className={`group-workspace-actions ${className ?? ""}`.trim()}>
			{errorNotice && (
				<div className="group-workspace-error-banner" role="alert">
					<FiAlertTriangle className="error-icon" />
					<span>{errorNotice}</span>
				</div>
			)}

			{/* 1. 计划模式状态与实施硬门禁 */}
			{planState && (
				<div className="group-workspace-card plan-card">
					<div className="card-header">
						<FiCheckCircle className="card-icon" />
						<span className="card-title">{w.planTitle}</span>
						<span className={`plan-badge status-${planState.state}`}>
							{planState.state === "draft" && w.planDraft}
							{planState.state === "ready" && w.planReady}
							{planState.state === "approved" && w.planApproved}
						</span>
					</div>

					{planState.steps && planState.steps.length > 0 && (
						<ul className="plan-steps-list">
							{planState.steps.map((s) => (
								<li key={s.id} className={`step-item status-${s.status ?? "pending"}`}>
									<FiClock className="step-icon" />
									<span className="step-title">{s.title}</span>
								</li>
							))}
						</ul>
					)}

					{planState.state === "ready" && onStartPlanExecution && (
						<div className="card-actions">
							<button
								type="button"
								className="btn primary start-plan-btn"
								onClick={handleStartPlan}
								disabled={startingPlan}
							>
								<FiPlay className="btn-icon" />
								<span>{startingPlan ? w.startingPlan : w.startPlan}</span>
							</button>
						</div>
					)}
				</div>
			)}

			{/* 2. 关联画布：显式启动器，保证不因引用自动跑 */}
			{canvasRef && (
				<div className="group-workspace-card canvas-card">
					<div className="card-header">
						<FiLayout className="card-icon" />
						<span className="card-title">{w.canvasTitle}</span>
						<span className="canvas-badge">{canvasRef.title || canvasRef.graphId}</span>
					</div>
					<p className="card-note">{w.canvasManualNote}</p>
					{onLaunchCanvas && (
						<div className="card-actions">
							<button
								type="button"
								className="btn launch-canvas-btn"
								onClick={handleLaunchCanvas}
								disabled={launchingCanvas}
							>
								<FiPlay className="btn-icon" />
								<span>{launchingCanvas ? w.launchingCanvas : w.launchCanvas}</span>
							</button>
						</div>
					)}
				</div>
			)}

			{/* 3. Bot 预设快照：版本锁定与私有配置隔离展示及安全应用 */}
			{botSnapshot && (
				<div className="group-workspace-card bot-preset-card">
					<div className="card-header">
						<FiSliders className="card-icon" />
						<span className="card-title">{w.botPresetTitle}</span>
						<span className="bot-badge">{botSnapshot.name}</span>
					</div>
					<div className="bot-snapshot-meta">
						<span className="snapshot-rev">
							<FiShield className="rev-icon" />
							{w.lockedSnapshot.replace("{rev}", String(botSnapshot.revision))}
						</span>
						<span className="snapshot-tools">
							{w.toolsCount.replace("{count}", String(botSnapshot.toolWhitelist.length))}
						</span>
					</div>
					<p className="card-note-faint">{w.isolatedNote}</p>
					{onApplyPresetSnapshot && (
						<div className="card-actions">
							<button
								type="button"
								className="btn secondary apply-preset-btn"
								onClick={handleApplyPreset}
								disabled={applyingPreset || !isSnapshotApplicableToTask(taskSnapshotRevision, botSnapshot.revision)}
								title={
									!isSnapshotApplicableToTask(taskSnapshotRevision, botSnapshot.revision)
										? w.lockedCannotApply
										: undefined
								}
							>
								<FiRefreshCw className="btn-icon" />
								<span>{applyingPreset ? w.applyingPreset : w.applyPreset}</span>
							</button>
						</div>
					)}
				</div>
			)}

			{/* 4. 群视图正式 UI 插槽渲染 (device.group.actions) */}
			{uiSlotEntries && uiSlotEntries.length > 0 && (
				<div className="group-workspace-card group-slots-card">
					<div className="card-header">
						<span className="card-title">{isZhLocale(locale) ? "扩展操作" : "Extensions"}</span>
					</div>
					<div className="card-actions group-slots-actions">
						{uiSlotEntries
							.filter((e) => !e.hidden)
							.map((entry) => (
								<button
									key={entry.id}
									type="button"
									className="btn secondary group-slot-btn"
									onClick={() => onUiAction?.(entry)}
									title={entry.label}
								>
									{entry.label}
								</button>
							))}
					</div>
				</div>
			)}
		</div>
	);
}
