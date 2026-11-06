import { Fragment, memo, useEffect, useState, type ReactNode } from "react";
import { FiTarget, FiLock, FiUnlock, FiX, FiChevronUp, FiArrowUpRight, FiSquare } from "react-icons/fi";
import type { GoalStatus, ModelInfo } from "../types";
import { isZhLocale, useT, useI18n } from "../i18n";
import { appSend, useIsDsh, useEngineCapabilities } from "../app-globals";
import { Dropdown, DropdownItem } from "./Dropdown";
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

	const [text, setText] = useState("");
	const [reviewModel, setReviewModel] = useState<string>(goal.reviewModel ?? "");
	const [maxRounds, setMaxRounds] = useState(goal.maxRounds);
	const [locked, setLocked] = useState(goal.locked);
	const [execModel, setExecModel] = useState<string>(goal.execModel ?? "");
	const [modelOpen, setModelOpen] = useState(false);
	const [execModelOpen, setExecModelOpen] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [reqLoading, setReqLoading] = useState(false);
	const [collapsed, setCollapsed] = useState(true);

	useEffect(() => {
		setReviewModel(goal.reviewModel ?? "");
		setMaxRounds(goal.maxRounds || 0);
		setLocked(goal.locked);
		setExecModel(goal.execModel ?? "");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [goal.goal, goal.reviewModel, goal.maxRounds, goal.locked, goal.execModel]);

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
		if (!reviewModel) return t("goalBarUseMainModel");
		return models.find((m) => m.id === reviewModel)?.name ?? reviewModel;
	};
	const execModelName = (): string => {
		if (!execModel) return t("goalBarUseMainModel");
		return models.find((m) => m.id === execModel)?.name ?? execModel;
	};

	const set = () => {
		const trimmed = text.trim();
		if (!trimmed) return;
		appSend({
			type: "set_goal",
			goal: trimmed,
			...(reviewModel ? { reviewModel } : {}),
			maxRounds,
			locked,
			...(execModel ? { execModel } : {}),
		});
		setText("");
		setCollapsed(false);
	};

	const runPlan = () => {
		const trimmed = text.trim();
		appSend({ type: "set_plan_mode", enabled: true });
		if (!trimmed) return;
		appSend({ type: "prompt", text: trimmed });
		setText("");
	};

	const startWizard = () => {
		const trimmed = text.trim();
		if (!trimmed) return;
		appSend({
			type: "start_goal_wizard",
			text: trimmed,
			...(reviewModel ? { wizardModel: reviewModel } : {}),
			maxRounds,
			locked,
		});
		setText("");
		setCollapsed(false);
	};

	const GOAL_DEFAULT_ORDER = [
		"host:goal-pill",
		"host:goal-set",
		"host:goal-wizard",
		"host:goal-plan",
		"host:goal-lock",
		"host:goal-collapse",
		"host:goal-model",
		"host:goal-execmodel",
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
			<button
				type="button"
				className="goalbar-hint"
				title={t("goalBarPlaceholder")}
				onClick={() => setCollapsed(false)}
			>
				<FiTarget /> <span>{goalLabel("host:goal-pill", t("goalBarTitle"))}</span>
			</button>
		),
		"host:goal-set": (
			<button type="button" className="goalbar-btn" disabled={!text.trim()} onClick={set}>
				{goalLabel("host:goal-set", t("goalBarSet"))}
			</button>
		),
		"host:goal-wizard": (
			<button
				type="button"
				className="goalbar-btn action wizard"
				disabled={!text.trim()}
				title={t("goalWizardTip")}
				onClick={startWizard}
			>
				{goalLabel("host:goal-wizard", t("goalWizardBtn"))}
			</button>
		),
		"host:goal-plan": !capabilities.planMode ? null : (
			<button
				type="button"
				className="goalbar-btn action plan"
				disabled={!text.trim()}
				title={t("planActionTip")}
				onClick={runPlan}
			>
				{goalLabel("host:goal-plan", t("planActionBtn"))}
			</button>
		),
		"host:goal-lock": (
			<button
				type="button"
				className="goalbar-icon-btn"
				title={locked ? t("goalBarLocked") : t("goalBarUnlocked")}
				onClick={() =>
					setLocked((v) => {
						appSend({ type: "set_goal_prefs", locked: !v });
						return !v;
					})
				}
			>
				{locked ? <FiLock /> : <FiUnlock />}
			</button>
		),
		"host:goal-collapse": (
			<button type="button" className="goalbar-icon-btn" title={t("goalBarClear")} onClick={() => setCollapsed(true)}>
				<FiChevronUp />
			</button>
		),
		"host:goal-model": isDsh ? (
			<p className="goalbar-dsh-note">{t("dshNoReviewModel")}</p>
		) : (
			<Dropdown
				trigger={
					<span className="goalbar-opt" title={`${t("goalBarReviewModel")}: ${reviewModelName()}`}>
						<span className="goalbar-opt-label">{`${goalLabel("host:goal-model", t("goalBarReviewModel"))}:`}</span>
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
				<span>{goalLabel("host:goal-rounds", t("goalBarMaxRounds"))}</span>
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
			</label>
		),
		"host:goal-execmodel": isDsh ? null : (
			<Dropdown
				trigger={
					<span
						className="goalbar-opt"
						title={`${t("goalBarExecModel")}: ${execModelName()} · ${t("goalBarExecModelTip")}`}
					>
						<span className="goalbar-opt-label">{`${goalLabel("host:goal-execmodel", t("goalBarExecModel"))}:`}</span>
						<b>{execModelName()}</b>
					</span>
				}
				open={execModelOpen}
				onOpenChange={setExecModelOpen}
				direction="up"
			>
				<UniversalModelPicker
					models={models}
					modelsLoading={modelsLoading}
					currentModelId={execModel || null}
					active={execModelOpen}
					onEnsureModels={() => {
						if (models.length === 0 && !modelsLoading && !reqLoading) {
							setReqLoading(true);
							appSend({ type: "list_models" });
						}
					}}
					loading={reqLoading}
					onRefresh={() => appSend({ type: "list_models" })}
					onPickModel={(m) => {
						setExecModel(m.id);
						setExecModelOpen(false);
						appSend({ type: "set_goal_prefs", execModel: m.id });
					}}
					isRowActive={(m) => matchesModelId(m, execModel)}
					extraTopRow={
						<DropdownItem
							active={execModel === ""}
							onClick={() => {
								setExecModel("");
								setExecModelOpen(false);
								appSend({ type: "set_goal_prefs", execModel: "" });
							}}
						>
							{t("goalBarUseMainModel")}
						</DropdownItem>
					}
				/>
			</Dropdown>
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
										if (goal.goal) setText(goal.goal);
										appSend({ type: "clear_goal" });
										setCollapsed(false);
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
				<span className="goalbar-icon">
					<FiTarget />
				</span>
				<input
					className="goalbar-input"
					autoFocus
					value={text}
					placeholder={t("goalBarPlaceholder")}
					title={t("goalBarPlaceholder")}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") set();
					}}
				/>
				{renderMergedToolbar(
					goalZone(["host:goal-set", "host:goal-wizard", "host:goal-plan", "host:goal-lock", "host:goal-collapse"]),
					goalHostNodes,
					onUiAction,
				)}
			</div>
			<div className="goalbar-opts">
				{goalZone(["host:goal-model", "host:goal-execmodel", "host:goal-rounds"])
					.filter((e) => e.source === "host")
					.map((e) => (
						<Fragment key={e.id}>{goalHostNodes[e.id]}</Fragment>
					))}

				{goal.history && goal.history.length > 0 && (
					<Dropdown
						trigger={
							<span className="goalbar-opt" title={t("goalHistory")}>
								<span className="goalbar-opt-label">{`${t("goalHistory")}:`}</span>
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
									setText(h.goal);
									setHistoryOpen(false);
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
				<span className="goalbar-lock-hint">{locked ? t("goalBarLocked") : t("goalBarUnlocked")}</span>
				{staleBackend && <span className="goalbar-stale">{t("goalBarStaleBackend")}</span>}
			</div>
		</div>
	);
});
