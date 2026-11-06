import { useState } from "react";
import {
	FiCheckCircle,
	FiClock,
	FiAlertCircle,
	FiCircle,
	FiChevronDown,
	FiChevronUp,
	FiTrash2,
	FiList,
	FiCopy,
	FiCheck,
	FiEdit2,
	FiX,
	FiPlus,
} from "react-icons/fi";
import { appSend } from "../app-globals";
import { isZhLocale, useLocale, useT } from "../i18n";
import type { PlanState, PlanStep, PlanStepStatus } from "../types";
import { useCopyFeedback } from "../use-copy-feedback";

interface PlanBoardProps {
	plan: PlanState | null | undefined;
}

const NEXT_STATUS: Record<PlanStepStatus, PlanStepStatus> = {
	pending: "in_progress",
	in_progress: "done",
	done: "failed",
	failed: "pending",
};

export function PlanBoard({ plan }: PlanBoardProps) {
	const t = useT();
	const isZh = isZhLocale(useLocale());
	const [expanded, setExpanded] = useState(false);
	const { copied, copy } = useCopyFeedback({ duration: 2000 });
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editTitle, setEditTitle] = useState("");
	const [editDesc, setEditDesc] = useState("");

	if (!plan || !plan.steps || plan.steps.length === 0) {
		return null;
	}

	const steps = plan.steps;
	const doneCount = steps.filter((s) => s.status === "done").length;
	const totalCount = steps.length;
	const percent = Math.round((doneCount / totalCount) * 100);

	const activeStep = steps.find((s) => s.id === plan.activeStepId) ?? steps.find((s) => s.status === "in_progress");

	const handleClearPlan = () => {
		if (window.confirm(isZh ? "确定要清空当前任务计划看板吗？" : "Are you sure you want to clear the plan board?")) {
			appSend({
				type: "plan_update",
				steps: [],
			});
		}
	};

	const handleImplement = () => {
		appSend({ type: "set_plan_mode", enabled: false });
		appSend({ type: "prompt", text: t("planImplementRequest") });
	};

	const handleCleanHandoff = () => {
		const planSummary = steps
			.map((s, i) => `${i + 1}. ${s.title}${s.description ? ` (${s.description})` : ""}`)
			.join("\n");
		appSend({
			type: "plan_clean_handoff",
			steps,
			prompt: `${t("planCleanHandoffPrompt")}\n\n${planSummary}`,
		});
	};

	const handleExportMarkdown = async () => {
		const lines = [
			`# ${t("planBoardTitle")} (${doneCount}/${totalCount})`,
			"",
			...steps.map((s, idx) => {
				const mark =
					s.status === "done" ? "[x]" : s.status === "in_progress" ? "[>]" : s.status === "failed" ? "[!]" : "[ ]";
				let line = `${mark} ${idx + 1}. ${s.title}`;
				if (s.description) line += `\n   ${s.description}`;
				return line;
			}),
		];
		await copy(lines.join("\n"));
	};

	const startEdit = (step: PlanStep) => {
		setEditingId(step.id);
		setEditTitle(step.title);
		setEditDesc(step.description || "");
	};

	const cancelEdit = () => {
		setEditingId(null);
		setEditTitle("");
		setEditDesc("");
	};

	const saveEdit = (stepId: string) => {
		const trimmedTitle = editTitle.trim();
		if (!trimmedTitle) return;
		const patch: Partial<PlanStep> = { title: trimmedTitle };
		if (editDesc.trim()) patch.description = editDesc.trim();
		else patch.description = undefined;
		appSend({ type: "plan_step_update", stepId, patch });
		setEditingId(null);
	};

	const handleDeleteStep = (stepId: string) => {
		appSend({ type: "plan_step_delete", stepId });
	};

	const handleCycleStatus = (stepId: string) => {
		const targetStep = steps.find((s) => s.id === stepId);
		if (!targetStep) return;
		appSend({
			type: "plan_step_update",
			stepId,
			patch: { status: NEXT_STATUS[targetStep.status] },
		});
	};

	const handleAddStep = () => {
		const newId = `step-${Date.now()}`;
		const newStep: PlanStep = {
			id: newId,
			title: t("planBoardAddStep"),
			status: "pending",
		};
		appSend({ type: "plan_step_add", step: newStep });
		startEdit(newStep);
	};

	const getStatusBadge = (status: PlanStepStatus, stepId: string) => {
		const badgeContent = (() => {
			switch (status) {
				case "done":
					return (
						<>
							<FiCheckCircle />
							{t("planBoardCompleted")}
						</>
					);
				case "in_progress":
					return (
						<>
							<FiClock />
							{t("planBoardInProgress")}
						</>
					);
				case "failed":
					return (
						<>
							<FiAlertCircle />
							{t("planBoardFailed")}
						</>
					);
				case "pending":
				default:
					return (
						<>
							<FiCircle />
							{t("planBoardPending")}
						</>
					);
			}
		})();

		const color =
			status === "done"
				? "var(--green, #22c55e)"
				: status === "in_progress"
					? "var(--accent, #38bdf8)"
					: status === "failed"
						? "var(--red, #ef4444)"
						: "var(--text-dim, #9aa1b4)";

		return (
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					handleCycleStatus(stepId);
				}}
				title={
					isZh
						? "点击切换状态 (pending / in_progress / done / failed)"
						: "Click to toggle status (pending / in_progress / done / failed)"
				}
				style={{
					display: "inline-flex",
					alignItems: "center",
					gap: 4,
					color,
					fontSize: 12,
					fontWeight: status === "pending" ? 400 : 600,
					background: "none",
					border: "none",
					cursor: "pointer",
					padding: "2px 4px",
					borderRadius: 4,
				}}
			>
				{badgeContent}
			</button>
		);
	};

	return (
		<div className={`plan-board ${expanded ? "" : "plan-board-collapsed"}`.trim()}>
			<div className="plan-board-head" onClick={() => setExpanded(!expanded)}>
				<div className="plan-board-head-main">
					<FiList className="plan-board-icon" />
					<span className="plan-board-title">{t("planBoardTitle")}</span>
					<span className={`plan-board-count ${percent === 100 ? "plan-board-count-done" : ""}`.trim()}>
						{doneCount}/{totalCount}
					</span>
					{!expanded && activeStep && (
						<span className="plan-board-active" title={activeStep.title}>
							{activeStep.title}
						</span>
					)}
				</div>

				<div className="plan-board-actions">
					<button
						type="button"
						className="plan-board-implement"
						title={t("planImplementTip")}
						onClick={(e) => {
							e.stopPropagation();
							handleImplement();
						}}
					>
						{t("planImplementBtn")}
					</button>

					{expanded && (
						<button
							type="button"
							className="plan-board-clean-handoff"
							title={t("planCleanHandoffTip")}
							onClick={(e) => {
								e.stopPropagation();
								handleCleanHandoff();
							}}
						>
							{t("planCleanHandoffBtn")}
						</button>
					)}

					{expanded && (
						<>
							<button
								type="button"
								className="plan-board-iconbtn"
								title={copied ? t("planBoardExportSuccess") : t("planBoardExportMarkdown")}
								onClick={(e) => {
									e.stopPropagation();
									void handleExportMarkdown();
								}}
							>
								{copied ? <FiCheck style={{ color: "var(--green, #22c55e)" }} /> : <FiCopy />}
							</button>

							<button
								type="button"
								className="plan-board-iconbtn"
								title={t("clear")}
								onClick={(e) => {
									e.stopPropagation();
									handleClearPlan();
								}}
							>
								<FiTrash2 />
							</button>
						</>
					)}

					<button
						type="button"
						className="plan-board-iconbtn"
						title={expanded ? t("collapseSection") : t("expandSection")}
					>
						{expanded ? <FiChevronUp /> : <FiChevronDown />}
					</button>
				</div>

				{expanded && (
					<div className="plan-board-head-divider">
						<div
							className="plan-board-head-divider-fill"
							style={{
								width: `${percent}%`,
								backgroundColor: percent === 100 ? "var(--green, #22c55e)" : "var(--accent, #38bdf8)",
							}}
						/>
					</div>
				)}
			</div>

			{!expanded && (
				<div className="plan-board-progress-line">
					<div
						className="plan-board-progress-line-fill"
						style={{
							width: `${percent}%`,
							backgroundColor: percent === 100 ? "var(--green, #22c55e)" : "var(--accent, #38bdf8)",
						}}
					/>
				</div>
			)}

			{expanded && (
				<div className="plan-board-steps" style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
					{steps.map((step, idx) => {
						const isCurrent = step.id === plan.activeStepId || step.status === "in_progress";
						const isEditing = editingId === step.id;

						if (isEditing) {
							return (
								<div
									key={step.id || idx}
									style={{
										display: "flex",
										flexDirection: "column",
										gap: 6,
										padding: "8px 10px",
										borderRadius: 6,
										backgroundColor: "var(--bg-elev2, rgba(0, 0, 0, 0.2))",
										border: "1px solid var(--accent, #38bdf8)",
									}}
								>
									<input
										type="text"
										value={editTitle}
										onChange={(e) => setEditTitle(e.target.value)}
										placeholder={t("planBoardStepTitlePlaceholder")}
										style={{
											width: "100%",
											padding: "4px 8px",
											borderRadius: 4,
											border: "1px solid var(--border-subtle)",
											background: "var(--bg, #0b0f17)",
											color: "var(--text, #f1f5f9)",
											fontSize: 13,
										}}
										autoFocus
										onKeyDown={(e) => {
											if (e.key === "Enter" && !e.shiftKey) {
												e.preventDefault();
												saveEdit(step.id);
											} else if (e.key === "Escape") {
												cancelEdit();
											}
										}}
									/>
									<textarea
										rows={2}
										value={editDesc}
										onChange={(e) => setEditDesc(e.target.value)}
										placeholder={t("planBoardStepDescPlaceholder")}
										style={{
											width: "100%",
											padding: "4px 8px",
											borderRadius: 4,
											border: "1px solid var(--border-subtle)",
											background: "var(--bg, #0b0f17)",
											color: "var(--text-dim, #9aa1b4)",
											fontSize: 12,
											resize: "vertical",
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
												e.preventDefault();
												saveEdit(step.id);
											} else if (e.key === "Escape") {
												cancelEdit();
											}
										}}
									/>
									<div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 2 }}>
										<button
											type="button"
											className="plan-board-iconbtn"
											onClick={cancelEdit}
											title={t("cancel")}
											style={{ padding: "3px 8px", fontSize: 12 }}
										>
											<FiX /> {t("cancel")}
										</button>
										<button
											type="button"
											className="plan-board-implement"
											onClick={() => saveEdit(step.id)}
											title={t("confirm")}
											style={{ padding: "3px 10px", fontSize: 12 }}
										>
											<FiCheck /> {t("confirm")}
										</button>
									</div>
								</div>
							);
						}

						return (
							<div
								key={step.id || idx}
								style={{
									display: "flex",
									alignItems: "flex-start",
									justifyContent: "space-between",
									flexWrap: "wrap",
									rowGap: 4,
									minWidth: 0,
									padding: "6px 10px",
									borderRadius: 6,
									backgroundColor: isCurrent ? "rgba(56, 189, 248, 0.08)" : "var(--bg-elev2, rgba(0, 0, 0, 0.2))",
									border: isCurrent ? "1px solid rgba(56, 189, 248, 0.25)" : "1px solid transparent",
								}}
							>
								<div style={{ flex: "1 1 180px", minWidth: 0, paddingRight: 10 }}>
									<div style={{ display: "flex", alignItems: "flex-start", gap: 6, minWidth: 0 }}>
										<span
											style={{
												fontSize: 11,
												fontWeight: 700,
												color: isCurrent ? "var(--accent, #38bdf8)" : "var(--text-dim, #9aa1b4)",
												minWidth: 16,
											}}
										>
											{idx + 1}.
										</span>
										<span
											style={{
												fontWeight: isCurrent ? 600 : 500,
												color: step.status === "done" ? "var(--text-dim, #9aa1b4)" : "var(--text, #f1f5f9)",
												textDecoration: step.status === "done" ? "line-through" : "none",
												minWidth: 0,
												overflowWrap: "anywhere",
												wordBreak: "break-word",
											}}
										>
											{step.title}
										</span>
									</div>
									{step.description && (
										<div
											style={{
												fontSize: 12,
												color: "var(--text-dim, #9aa1b4)",
												marginTop: 2,
												paddingLeft: 22,
												lineHeight: 1.4,
												overflowWrap: "anywhere",
												wordBreak: "break-word",
											}}
										>
											{step.description}
										</div>
									)}
								</div>

								<div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0, marginTop: 2 }}>
									{getStatusBadge(step.status, step.id)}
									<button
										type="button"
										className="plan-board-iconbtn"
										title={t("planBoardEditStep")}
										onClick={() => startEdit(step)}
									>
										<FiEdit2 size={12} />
									</button>
									<button
										type="button"
										className="plan-board-iconbtn"
										title={t("planBoardDeleteStep")}
										onClick={() => handleDeleteStep(step.id)}
									>
										<FiTrash2 size={12} />
									</button>
								</div>
							</div>
						);
					})}

					<button type="button" className="plan-board-add-btn" onClick={handleAddStep}>
						<FiPlus /> {t("planBoardAddStep")}
					</button>
				</div>
			)}
		</div>
	);
}
