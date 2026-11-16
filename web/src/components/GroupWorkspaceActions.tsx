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
import { useT } from "../i18n";

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
	const t = useT();

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

	const handleStartPlan = async () => {
		if (!activeTaskId || !planState || startingPlan || !onStartPlanExecution) return;
		const check = prepareStartPlanExecution(planState);
		if (!check.ok) {
			setErrorNotice(check.reason ?? t("groupWorkspace.planNotReady"));
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

	const handleLaunchCanvas = async () => {
		if (!canvasRef || launchingCanvas || !onLaunchCanvas) return;
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

	const handleApplyPreset = async () => {
		if (!botSnapshot || applyingPreset || !onApplyPresetSnapshot) return;

		const isLocked = !isSnapshotApplicableToTask(taskSnapshotRevision, botSnapshot.revision);
		if (isLocked) {
			setErrorNotice(t("groupWorkspace.lockedCannotApply"));
			return;
		}

		setErrorNotice(null);
		setApplyingPreset(true);
		try {
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

			{planState && (
				<div className="group-workspace-card plan-card">
					<div className="card-header">
						<FiCheckCircle className="card-icon" />
						<span className="card-title">{t("groupWorkspace.planTitle")}</span>
						<span className={`plan-badge status-${planState.state}`}>
							{planState.state === "draft" && t("groupWorkspace.planDraft")}
							{planState.state === "ready" && t("groupWorkspace.planReady")}
							{planState.state === "approved" && t("groupWorkspace.planApproved")}
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
								<span>{startingPlan ? t("groupWorkspace.startingPlan") : t("groupWorkspace.startPlan")}</span>
							</button>
						</div>
					)}
				</div>
			)}

			{canvasRef && (
				<div className="group-workspace-card canvas-card">
					<div className="card-header">
						<FiLayout className="card-icon" />
						<span className="card-title">{t("groupWorkspace.canvasTitle")}</span>
						<span className="canvas-badge">{canvasRef.title || canvasRef.graphId}</span>
					</div>
					<p className="card-note">{t("groupWorkspace.canvasManualNote")}</p>
					{onLaunchCanvas && (
						<div className="card-actions">
							<button
								type="button"
								className="btn launch-canvas-btn"
								onClick={handleLaunchCanvas}
								disabled={launchingCanvas}
							>
								<FiPlay className="btn-icon" />
								<span>{launchingCanvas ? t("groupWorkspace.launchingCanvas") : t("groupWorkspace.launchCanvas")}</span>
							</button>
						</div>
					)}
				</div>
			)}

			{botSnapshot && (
				<div className="group-workspace-card bot-preset-card">
					<div className="card-header">
						<FiSliders className="card-icon" />
						<span className="card-title">{t("groupWorkspace.botPresetTitle")}</span>
						<span className="bot-badge">{botSnapshot.name}</span>
					</div>
					<div className="bot-snapshot-meta">
						<span className="snapshot-rev">
							<FiShield className="rev-icon" />
							{t("groupWorkspace.lockedSnapshot", { rev: botSnapshot.revision })}
						</span>
						<span className="snapshot-tools">
							{t("groupWorkspace.toolsCount", { count: botSnapshot.toolWhitelist.length })}
						</span>
					</div>
					<p className="card-note-faint">{t("groupWorkspace.isolatedNote")}</p>
					{onApplyPresetSnapshot && (
						<div className="card-actions">
							<button
								type="button"
								className="btn secondary apply-preset-btn"
								onClick={handleApplyPreset}
								disabled={applyingPreset || !isSnapshotApplicableToTask(taskSnapshotRevision, botSnapshot.revision)}
								title={
									!isSnapshotApplicableToTask(taskSnapshotRevision, botSnapshot.revision)
										? t("groupWorkspace.lockedCannotApply")
										: undefined
								}
							>
								<FiRefreshCw className="btn-icon" />
								<span>{applyingPreset ? t("groupWorkspace.applyingPreset") : t("groupWorkspace.applyPreset")}</span>
							</button>
						</div>
					)}
				</div>
			)}

			{uiSlotEntries && uiSlotEntries.length > 0 && (
				<div className="group-workspace-card group-slots-card">
					<div className="card-header">
						<span className="card-title">{t("groupWorkspace.extensionsTitle")}</span>
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
