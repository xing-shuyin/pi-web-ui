import { memo, useEffect, useState } from "react";
import { FiTarget, FiLock, FiUnlock, FiX, FiChevronUp } from "react-icons/fi";
import type { GoalStatus, ModelInfo } from "../types";
import { useT, useI18n } from "../i18n";
import { Dropdown, DropdownItem } from "./Dropdown";

/** Messages this component sends. */
export type GoalBarMsg =
	| { type: "set_goal"; goal: string; reviewModel?: string; maxRounds: number; locked: boolean }
	| { type: "clear_goal" }
	| { type: "start_goal_wizard"; text: string; wizardModel?: string; maxRounds?: number; locked?: boolean }
	| {
			type: "set_goal_prefs";
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
	  }
	| { type: "list_models" };

/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in, so the shallow-compared memo() below skips
 *  the goal bar entirely during streaming. */
interface Props {
	goal: GoalStatus;
	models: ModelInfo[];
	modelsLoading: boolean;
	activeConversationId: string;
	/** 引擎 id（"pi" | "dsh"）—— DSH 无独立审查模型，隐藏 reviewModel 下拉。 */
	engine?: string;
	send: (msg: GoalBarMsg) => boolean;
}

export const GoalBar = memo(function GoalBar({
	goal,
	models,
	modelsLoading,
	activeConversationId,
	engine,
	send,
}: Props) {
	const t = useT();
	const { locale } = useI18n();
	const goalDetail = locale === "en" && goal.statusEn ? goal.statusEn : goal.status || "";
	const wizardDetail = locale === "en" && goal.wizard?.statusEn ? goal.wizard.statusEn : goal.wizard?.status || "";
	// DSH：无独立审查模型 —— 隐藏 reviewModel 下拉（轮次上限仍然有效）。
	const isDsh = engine === "dsh";
	// Goals belong to the conversation that created them. The server keeps the
	// status around while switching chats so returning to the owner restores the
	// goal, but never show another conversation's goal as active.
	const goalBelongsToActiveConversation = !goal.conversationId || goal.conversationId === activeConversationId;
	const active = goal.goal !== null && goalBelongsToActiveConversation;

	// Draft fields (only meaningful while editing a new goal).
	const [text, setText] = useState("");
	const [reviewModel, setReviewModel] = useState<string>(goal.reviewModel ?? "");
	const [maxRounds, setMaxRounds] = useState(goal.maxRounds);
	const [locked, setLocked] = useState(goal.locked);
	const [modelOpen, setModelOpen] = useState(false);
	const [reqLoading, setReqLoading] = useState(false);
	// Collapsed by default: idle shows only a compact pill so the bar never
	// occupies vertical space until the user actually wants to set a goal.
	const [collapsed, setCollapsed] = useState(true);

	// Keep the editor's preference pickers in sync with the server's remembered
	// prefs (maxRounds 0 = unlimited). When the goal is inactive, adopt whatever
	// the server currently holds — so a reload restores the last-used model /
	// rounds / lock, and clearing a goal reverts to those remembered defaults.
	// `goal` (goaled status) holds the persisted prefs; upstream signals drive
	// this via `goal.goal !== null` transitions and the prefs fields changing.
	useEffect(() => {
		setReviewModel(goal.reviewModel ?? "");
		setMaxRounds(goal.maxRounds || 0);
		setLocked(goal.locked);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [goal.goal, goal.reviewModel, goal.maxRounds, goal.locked]);

	// Lazily fetch the model list when the review-model dropdown opens.
	useEffect(() => {
		if (modelOpen && models.length === 0 && !reqLoading && !modelsLoading) {
			setReqLoading(true);
			send({ type: "list_models" });
		}
	}, [modelOpen, models.length, reqLoading, modelsLoading, send]);
	useEffect(() => {
		if (models.length > 0) setReqLoading(false);
	}, [models.length]);

	const reviewModelName = (): string => {
		if (!reviewModel) return t("goalBarUseMainModel");
		return models.find((m) => m.id === reviewModel)?.name ?? reviewModel;
	};

	const set = () => {
		const trimmed = text.trim();
		if (!trimmed) return;
		send({
			type: "set_goal",
			goal: trimmed,
			...(reviewModel ? { reviewModel } : {}),
			maxRounds,
			locked,
		});
		setText("");
		setCollapsed(false);
	};

	/** Start the collaborative wizard: AI asks questions to refine the draft
	 *  into a goal, then auto-sets it. Reuses the reviewer-model picker as the
	 *  optional wizard model. */
	const startWizard = () => {
		const trimmed = text.trim();
		if (!trimmed) return;
		send({
			type: "start_goal_wizard",
			text: trimmed,
			...(reviewModel ? { wizardModel: reviewModel } : {}),
			maxRounds,
			locked,
		});
		setText("");
		setCollapsed(false);
	};

	// A wizard running (scoping questions in flight) — show its progress.
	const wizardActive = (goal.wizard?.active ?? false) && goalBelongsToActiveConversation;

	if (wizardActive) {
		return (
			<div className={`goalbar goalbar-active ${wizardActive ? "wizard" : ""}`}>
				<div className="goalbar-active-row">
					<span className="goalbar-icon">
						<span className="goalbar-spin">🔍</span>
					</span>
					<span className="goalbar-text" title={goal.wizard?.draft ?? ""}>
						{t("goalWizardRunning")}: {goal.wizard?.draft}
					</span>
					<span className="goalbar-chip reviewing">
						{t("goalBarRound", { n: (goal.wizard?.step ?? 0) + 1 })} / {goal.wizard?.maxSteps ?? 6}
					</span>
					<span className="goalbar-detail">{wizardDetail || t("goalBarReviewing")}</span>
					<button
						type="button"
						className="goalbar-x"
						title={t("goalBarClear")}
						onClick={() => {
							send({ type: "clear_goal" });
							setCollapsed(true);
						}}
					>
						<FiX />
					</button>
				</div>
			</div>
		);
	}

	if (active) {
		return (
			<div className={`goalbar goalbar-active ${goal.reviewing ? "reviewing" : ""}`}>
				<div className="goalbar-active-row">
					<span className="goalbar-icon">{goal.reviewing ? <span className="goalbar-spin">◌</span> : "🎯"}</span>
					<span className="goalbar-text" title={goal.goal ?? ""}>
						{goal.goal}
					</span>
					{goal.reviewing ? (
						<span className="goalbar-chip reviewing">
							{t("goalBarReviewing")} {t("goalBarRound", { n: goal.round })}
						</span>
					) : (
						<span
							className={`goalbar-chip ${goal.verdict === "pass" ? "pass" : goal.verdict === "fail" ? "fail" : ""}`}
						>
							{goal.verdict === "pass"
								? t("goalBarPassed")
								: goal.verdict === "fail"
									? t("goalBarFailed")
									: `${t("goalBarRound", { n: goal.round || 1 })} · ${goal.locked ? t("goalBarLocked") : t("goalBarUnlocked")}`}
						</span>
					)}
					<span className="goalbar-detail">{goalDetail}</span>
					<button
						type="button"
						className="goalbar-x"
						title={t("goalBarClear")}
						disabled={goal.reviewing}
						onClick={() => {
							send({ type: "clear_goal" });
							setCollapsed(true);
						}}
					>
						<FiX />
					</button>
				</div>
			</div>
		);
	}

	// Inactive, collapsed — a single compact pill aligned LEFT (not a centered
	// full-width strip). A discreet 🎯 chip; click to open the editor.
	if (collapsed) {
		return (
			<div className="goalbar goalbar-collapsed">
				<button
					type="button"
					className="goalbar-hint"
					title={t("goalBarPlaceholder")}
					onClick={() => setCollapsed(false)}
				>
					<FiTarget /> <span>{t("goalBarTitle")}</span>
				</button>
			</div>
		);
	}

	return (
		<div className="goalbar">
			<div className="goalbar-row">
				<span className="goalbar-icon">
					<FiTarget />
				</span>
				<input
					className="goalbar-input"
					value={text}
					placeholder={t("goalBarPlaceholder")}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") set();
					}}
				/>
				<button type="button" className="goalbar-btn" disabled={!text.trim()} onClick={set}>
					{t("goalBarSet")}
				</button>
				<button
					type="button"
					className="goalbar-btn wizard"
					disabled={!text.trim()}
					title={t("goalWizardTip")}
					onClick={startWizard}
				>
					🔍 {t("goalWizardBtn")}
				</button>
				<button
					type="button"
					className="goalbar-icon-btn"
					title={locked ? t("goalBarLocked") : t("goalBarUnlocked")}
					onClick={() =>
						setLocked((v) => {
							send({ type: "set_goal_prefs", locked: !v });
							return !v;
						})
					}
				>
					{locked ? <FiLock /> : <FiUnlock />}
				</button>
				<button type="button" className="goalbar-icon-btn" title={t("goalBarClear")} onClick={() => setCollapsed(true)}>
					<FiChevronUp />
				</button>
			</div>
			<div className="goalbar-opts">
				{isDsh ? (
					<p className="goalbar-dsh-note">{t("dshNoReviewModel")}</p>
				) : (
					<Dropdown
						trigger={
							<span className="goalbar-opt">
								{t("goalBarReviewModel")}: <b>{reviewModelName()}</b>
							</span>
						}
						open={modelOpen}
						onOpenChange={setModelOpen}
						direction="up"
					>
						<div className="dd-header">{t("goalBarReviewModel")}</div>
						{(reqLoading || modelsLoading) && <div className="dd-loading">{t("loading")}</div>}
						{models.length === 0 && !reqLoading && !modelsLoading && <div className="dd-loading">{t("noModels")}</div>}
						<DropdownItem
							active={reviewModel === ""}
							onClick={() => {
								setReviewModel("");
								setModelOpen(false);
								send({ type: "set_goal_prefs", reviewModel: "" });
							}}
						>
							{t("goalBarUseMainModel")}
						</DropdownItem>
						{models.map((m) => (
							<DropdownItem
								key={m.id}
								active={reviewModel === m.id}
								onClick={() => {
									setReviewModel(m.id);
									setModelOpen(false);
									send({ type: "set_goal_prefs", reviewModel: m.id });
								}}
							>
								<span className="dd-model-cell">
									<span className="dd-model-name">{m.name}</span>
									<span className="dd-model-meta">
										<span className="dd-model-provider">{m.provider}</span>
									</span>
								</span>
							</DropdownItem>
						))}
						<button type="button" className="dd-refresh" onClick={() => send({ type: "list_models" })}>
							{t("refreshModels")}
						</button>
					</Dropdown>
				)}

				<label className="goalbar-round" title={t("goalBarMaxRoundsTip")}>
					<span>{t("goalBarMaxRounds")}</span>
					<input
						type="number"
						min={0}
						step={1}
						value={maxRounds}
						placeholder={t("goalBarUnlimitedShort")}
						onChange={(e) => {
							const v = parseInt(e.target.value, 10);
							if (Number.isNaN(v) || v < 0) {
								setMaxRounds(0);
								return;
							}
							setMaxRounds(v);
						}}
						onBlur={() => send({ type: "set_goal_prefs", maxRounds: maxRounds })}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								send({ type: "set_goal_prefs", maxRounds: maxRounds });
								(e.target as HTMLInputElement).blur();
							}
						}}
					/>
				</label>

				<span className="goalbar-lock-hint">{locked ? t("goalBarLocked") : t("goalBarUnlocked")}</span>
			</div>
		</div>
	);
});
