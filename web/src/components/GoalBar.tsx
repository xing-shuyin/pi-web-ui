import { Fragment, memo, useEffect, useState, type ReactNode } from "react";
import { FiTarget, FiLock, FiUnlock, FiX, FiChevronUp, FiArrowUpRight, FiSquare, FiClock } from "react-icons/fi";
import type { GoalStatus, ModelInfo } from "../types";
import { isZhLocale, useT, useI18n } from "../i18n";
import { appSend, useIsDsh, useEngineCapabilities } from "../app-globals";
import { composeToComposer, focusComposer } from "../composer-bridge";
import {
	setGoalCompose,
	setGoalPlan,
	setGoalRefine,
	useGoalCompose,
	useGoalPlan,
	useGoalRefine,
} from "../goal-compose";
import { Dropdown, DropdownItem } from "./Dropdown";
import { TipButton } from "./HintTip";
import { UniversalModelPicker, matchesModelId } from "./UniversalModelPicker";
import type { UiSlotEntry } from "../ui-slots";
import { renderMergedToolbar } from "../slot-toolbar";

interface Props {
	goal: GoalStatus;
	models: ModelInfo[];
	modelsLoading: boolean;
	activeConversationId: string;
	uiGoalbarActions?: UiSlotEntry[];
	onUiAction?: (item: UiSlotEntry) => void;
}

export const GoalBar = memo(function GoalBar({
	goal,
	models,
	modelsLoading,
	activeConversationId,
	uiGoalbarActions,
	onUiAction,
}: Props) {
	const t = useT();
	const { locale } = useI18n();
	const goalDetail = !isZhLocale(locale) && goal.statusEn ? goal.statusEn : goal.status || "";
	const wizardDetail = !isZhLocale(locale) && goal.wizard?.statusEn ? goal.wizard.statusEn : goal.wizard?.status || "";
	const isDsh = useIsDsh();
	const capabilities = useEngineCapabilities();
	const goalBelongsToActiveConversation = !goal.conversationId || goal.conversationId === activeConversationId;
	const active = goal.goal !== null && goalBelongsToActiveConversation;
	const execRole = goalBelongsToActiveConversation ? goal.roles?.executor : undefined;
	const execRoleConvId = execRole?.convId;
	const execActivity = execRole?.activity
		? !isZhLocale(locale) && execRole.activityEn
			? execRole.activityEn
			: execRole.activity
		: execRole?.streaming
			? "…"
			: undefined;
	const roundBudget = goal.locked && goal.maxRounds > 0 ? goal.maxRounds : 0;
	const roundLabel =
		roundBudget > 0
			? isZhLocale(locale)
				? t("goalBarRound", { n: `${goal.round}/${roundBudget}` })
				: `Round ${goal.round}/${roundBudget}`
			: `${t("goalBarRound", { n: goal.round })}${goal.locked ? ` · ${t("goalBarUnlimitedShort")}` : ""}`;
	const usageTotal = (goal.usage?.inputTokens ?? 0) + (goal.usage?.outputTokens ?? 0);
	const fmtTok = (n: number): string =>
		n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
	const staleBackend = !isDsh && goal.execModel === undefined;

	const [reviewModel, setReviewModel] = useState<string>(goal.reviewModel ?? "");
	const [maxRounds, setMaxRounds] = useState(goal.maxRounds);
	const [locked, setLocked] = useState(goal.locked);
	const [modelOpen, setModelOpen] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	const goalCompose = useGoalCompose();
	const goalRefine = useGoalRefine();
	const goalPlan = useGoalPlan();
	const [reqLoading, setReqLoading] = useState(false);
	const [collapsed, setCollapsed] = useState(true);

	useEffect(() => {
		setReviewModel(goal.reviewModel ?? "");
		setMaxRounds(goal.maxRounds || 0);
		setLocked(goal.locked);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [goal.goal, goal.reviewModel, goal.maxRounds, goal.locked]);

	useEffect(() => {
		if (modelOpen && models.length === 0 && !reqLoading && !modelsLoading) {
			setReqLoading(true);
			appSend({ type: "list_models" });
		}
	}, [modelOpen, models.length, reqLoading, modelsLoading]);
	useEffect(() => {
		if (models.length > 0) setReqLoading(false);
	}, [models.length]);

	const reviewModelName = (): string => {
		if (!reviewModel) return t("goalBarMainModelShort");
		return models.find((m) => m.id === reviewModel)?.name ?? reviewModel;
	};
	const enterCompose = () => {
		setGoalCompose(true);
		setCollapsed(false);
		focusComposer();
	};

	const GOAL_DEFAULT_ORDER = [
		"host:goal-pill",
		"host:goal-set",
		"host:goal-wizard",
		"host:goal-plan",
		"host:goal-lock",
		"host:goal-collapse",
		"host:goal-model",
		"host:goal-rounds",
		"host:goal-openrole",
		"host:goal-clear",
	];
	const allGoalEntries: UiSlotEntry[] =
		uiGoalbarActions === undefined
			? GOAL_DEFAULT_ORDER.map((id) => ({ id, source: "host" }) as UiSlotEntry)
			: uiGoalbarActions.filter((e) => !e.hidden);
	const goalZone = (ids: string[]): UiSlotEntry[] => {
		const set = new Set(ids);
		return allGoalEntries.filter((e) => set.has(e.id) || e.source !== "host");
	};
	const goalLabel = (id: string, fallback: string): string => {
		const e = allGoalEntries.find((x) => x.id === id);
		return e?.labelExplicit ? e.label : fallback;
	};
	const goalHostNodes: Record<string, ReactNode> = {
		"host:goal-pill": (
			<button type="button" className="goalbar-hint" title={t("goalBarHelp")} onClick={enterCompose}>
				<FiTarget /> <span>{goalLabel("host:goal-pill", t("goalBarTitle"))}</span>
			</button>
		),
		"host:goal-set": (
			<TipButton
				tip={t("goalBarHelp")}
				className={`goalbar-btn mode${goalCompose ? " active" : ""}`}
				aria-pressed={goalCompose}
				onClick={() => {
					if (goalCompose) setGoalCompose(false);
					else enterCompose();
				}}
			>
				{goalLabel("host:goal-set", t("goalComposeEnter"))}
			</TipButton>
		),
		"host:goal-wizard": (
			<TipButton
				tip={t("goalWizardTip")}
				className={`goalbar-btn action wizard${goalRefine ? " active" : ""}`}
				aria-pressed={goalRefine}
				onClick={() => setGoalRefine(!goalRefine)}
			>
				{goalLabel("host:goal-wizard", t("goalWizardBtn"))}
			</TipButton>
		),
		"host:goal-plan": !capabilities.planMode ? null : (
			<TipButton
				tip={t("planActionTip")}
				className={`goalbar-btn action plan${goalPlan ? " active" : ""}`}
				aria-pressed={goalPlan}
				onClick={() => setGoalPlan(!goalPlan)}
			>
				{goalLabel("host:goal-plan", t("planActionBtn"))}
			</TipButton>
		),
		"host:goal-lock": (
			<TipButton
				tip={locked ? t("goalBarLocked") : t("goalBarUnlocked")}
				className={`goalbar-icon-btn${locked ? " on" : ""}`}
				aria-pressed={locked}
				onClick={() =>
					setLocked((v) => {
						appSend({ type: "set_goal_prefs", locked: !v });
						return !v;
					})
				}
			>
				{locked ? <FiLock /> : <FiUnlock />}
			</TipButton>
		),
		"host:goal-collapse": (
			<TipButton
				tip={t("goalBarCollapse")}
				className="goalbar-icon-btn"
				onClick={() => {
					setCollapsed(true);
					// 收起面板 = 不再写目标，否则输入框会一直挂着「输入要达成的目标…」
					setGoalCompose(false);
				}}
			>
				<FiChevronUp />
			</TipButton>
		),
		"host:goal-model": isDsh ? (
			<p className="goalbar-dsh-note">{t("dshNoReviewModel")}</p>
		) : (
			<Dropdown
				trigger={
					<span className="goalbar-opt" title={`${t("goalBarReviewModel")}: ${reviewModelName()}`}>
						<span className="goalbar-opt-label">{goalLabel("host:goal-model", t("goalBarReviewShort"))}</span>
						<b>{reviewModelName()}</b>
					</span>
				}
				open={modelOpen}
				onOpenChange={setModelOpen}
				direction="up"
			>
				<UniversalModelPicker
					models={models}
					modelsLoading={modelsLoading}
					currentModelId={reviewModel || null}
					active={modelOpen}
					onEnsureModels={() => {
						if (models.length === 0 && !modelsLoading && !reqLoading) {
							setReqLoading(true);
							appSend({ type: "list_models" });
						}
					}}
					loading={reqLoading}
					onRefresh={() => appSend({ type: "list_models" })}
					onPickModel={(m) => {
						setReviewModel(m.id);
						setModelOpen(false);
						appSend({ type: "set_goal_prefs", reviewModel: m.id });
					}}
					isRowActive={(m) => matchesModelId(m, reviewModel)}
					extraTopRow={
						<DropdownItem
							active={reviewModel === ""}
							onClick={() => {
								setReviewModel("");
								setModelOpen(false);
								appSend({ type: "set_goal_prefs", reviewModel: "" });
							}}
						>
							{t("goalBarUseMainModel")}
						</DropdownItem>
					}
				/>
			</Dropdown>
		),
		"host:goal-rounds": (
			<label className="goalbar-round" title={t("goalBarMaxRoundsTip")}>
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
					onBlur={() => appSend({ type: "set_goal_prefs", maxRounds: maxRounds })}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							appSend({ type: "set_goal_prefs", maxRounds: maxRounds });
							(e.target as HTMLInputElement).blur();
						}
					}}
				/>
				<span>{goalLabel("host:goal-rounds", t("goalBarRoundsUnit"))}</span>
			</label>
		),
	};
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
					{renderMergedToolbar(
						goalZone(["host:goal-clear"]),
						{
							...goalHostNodes,
							"host:goal-clear": (
								<button
									type="button"
									className="goalbar-x"
									title={t("goalBarClear")}
									onClick={() => {
										appSend({ type: "clear_goal" });
										setCollapsed(true);
									}}
								>
									<FiX />
								</button>
							),
						},
						onUiAction,
					)}
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
							{goal.phase === "executing" ? t("goalBarExecuting") : t("goalBarReviewing")} {roundLabel}
						</span>
					) : (
						<span
							className={`goalbar-chip ${goal.verdict === "pass" ? "pass" : goal.verdict === "fail" ? "fail" : goal.verdict === "blocked" ? "blocked" : ""}`}
						>
							{goal.verdict === "pass"
								? t("goalBarPassed")
								: goal.verdict === "fail"
									? t("goalBarFailed")
									: goal.verdict === "blocked"
										? t("goalBarBlocked")
										: `${t("goalBarRound", { n: goal.round || 1 })} · ${goal.locked ? t("goalBarLocked") : t("goalBarUnlocked")}`}
						</span>
					)}
					<span className="goalbar-detail">{goalDetail}</span>
					{execActivity && (
						<span className="goalbar-detail" title={execRole?.convId}>
							· {execActivity}
						</span>
					)}
					{usageTotal > 0 && (
						<span
							className="goalbar-detail"
							title={`${goal.usage?.inputTokens ?? 0} in / ${goal.usage?.outputTokens ?? 0} out`}
						>
							· {fmtTok(usageTotal)} tokens
						</span>
					)}
					{staleBackend && <span className="goalbar-stale">{t("goalBarStaleBackend")}</span>}
					{renderMergedToolbar(
						goalZone(["host:goal-openrole", "host:goal-clear"]),
						{
							...goalHostNodes,
							"host:goal-openrole": execRoleConvId ? (
								<button
									type="button"
									className="goalbar-icon-btn"
									title={t("goalBarOpenExecTip")}
									onClick={() => appSend({ type: "switch_conversation", id: execRoleConvId })}
								>
									<FiArrowUpRight />
								</button>
							) : null,
							"host:goal-clear": (
								<button
									type="button"
									className={`goalbar-x${goal.reviewing ? " stopping" : ""}`}
									title={goalLabel("host:goal-clear", goal.reviewing ? t("goalBarStop") : t("goalBarClear"))}
									onClick={() => {
										if (goal.goal) composeToComposer({ text: goal.goal });
										appSend({ type: "clear_goal" });
										setGoalCompose(true);
										setCollapsed(false);
										focusComposer();
									}}
								>
									{goal.reviewing ? <FiSquare /> : <FiX />}
								</button>
							),
						},
						onUiAction,
					)}
				</div>
			</div>
		);
	}

	if (collapsed) {
		const pillBar = renderMergedToolbar(goalZone(["host:goal-pill"]), goalHostNodes, onUiAction);
		if (!pillBar) return null;
		return <div className="goalbar-collapsed">{pillBar}</div>;
	}

	return (
		<div className="goalbar">
			<div className="goalbar-row">
				<span className="goalbar-lead">
					<FiTarget />
					<span>{goalLabel("host:goal-pill", t("goalBarTitle"))}</span>
				</span>
				{renderMergedToolbar(
					goalZone(["host:goal-set", "host:goal-wizard", "host:goal-plan", "host:goal-lock", "host:goal-collapse"]),
					goalHostNodes,
					onUiAction,
				)}
				<span className="goalbar-sep" />
				{goalZone(["host:goal-model", "host:goal-rounds"])
					.filter((e) => e.source === "host")
					.map((e) => (
						<Fragment key={e.id}>{goalHostNodes[e.id]}</Fragment>
					))}
				{goal.history && goal.history.length > 0 && (
					<Dropdown
						trigger={
							<span className="goalbar-opt">
								<span className="goalbar-opt-label">{t("goalHistory")}</span>
								<b>{goal.history.length}</b>
							</span>
						}
						open={historyOpen}
						onOpenChange={setHistoryOpen}
						direction="up"
					>
						<div className="dd-header">{t("goalHistory")}</div>
						{goal.history.map((h, i) => (
							<DropdownItem
								key={`${h.finishedAt}-${i}`}
								onClick={() => {
									composeToComposer({ text: h.goal });
									setGoalCompose(true);
									setHistoryOpen(false);
									focusComposer();
								}}
							>
								<span className="dd-model-cell" title={h.goal}>
									<span className="dd-model-name">
										{h.verdict === "pass" ? "✅ " : h.verdict === "fail" ? "❌ " : "⚠️ "}
										{h.goal.length > 42 ? `${h.goal.slice(0, 42)}…` : h.goal}
									</span>
									<span className="dd-model-meta">
										<span className="dd-model-id">
											{t("goalBarRound", { n: h.rounds })} · {new Date(h.finishedAt).toLocaleString()}
										</span>
									</span>
								</span>
							</DropdownItem>
						))}
					</Dropdown>
				)}
				{staleBackend && <span className="goalbar-stale">{t("goalBarStaleBackend")}</span>}
				<TipButton tip={t("goalBarHelp")} className="goalbar-icon-btn" onClick={() => focusComposer()}>
					?
				</TipButton>
			</div>
		</div>
	);
});
