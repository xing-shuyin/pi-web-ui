import { Fragment, memo, useEffect, useState, type ReactNode } from "react";
import { FiTarget, FiLock, FiUnlock, FiX, FiChevronUp, FiArrowUpRight, FiSquare } from "react-icons/fi";
import type { GoalStatus, ModelInfo } from "../types";
import { isZhLocale, useT, useI18n } from "../i18n";
import { appSend, useIsDsh } from "../app-globals";
import { Dropdown, DropdownItem } from "./Dropdown";
import type { UiSlotEntry } from "../ui-slots";
import { renderMergedToolbar } from "../slot-toolbar";

/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in, so the shallow-compared memo() below skips
 *  the goal bar entirely during streaming. */
interface Props {
	goal: GoalStatus;
	models: ModelInfo[];
	modelsLoading: boolean;
	activeConversationId: string;
	/** `goalbar.actions` 槽位的最终条目（全量，含 hidden；宿主 chrome + 插件按槽位顺序合并渲染）。
	 *  不传 = 未接线，回落默认顺序（与旧硬编码一致）。 */
	uiGoalbarActions?: UiSlotEntry[];
	/** 点击一条目标条动作：交回 App 分发给贡献它的插件（与顶栏 onUiAction 同通道）。 */
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
	// DSH：不接目标模式 2.0 的执行对话（隐藏执行模型下拉；轮次上限仍然有效）。
	// engine 走全局（web/src/app-globals.ts），不再从 App 一路传下来。
	const isDsh = useIsDsh();
	// Goals belong to the conversation that created them. The server keeps the
	// status around while switching chats so returning to the owner restores the
	// goal, but never show another conversation's goal as active.
	const goalBelongsToActiveConversation = !goal.conversationId || goal.conversationId === activeConversationId;
	const active = goal.goal !== null && goalBelongsToActiveConversation;
	// 目标模式 2.0：委托执行者的对话 id（有它才能「一键打开执行对话」）。
	const execRole = goalBelongsToActiveConversation ? goal.roles?.executor : undefined;
	const execRoleConvId = execRole?.convId;
	// 执行者实时动态（轮次边界刷新）：跑什么工具 / 自述头；中英按 locale 二选一。
	const execActivity = execRole?.activity
		? !isZhLocale(locale) && execRole.activityEn
			? execRole.activityEn
			: execRole.activity
		: execRole?.streaming
			? "…"
			: undefined;
	// 轮次标签：有限预算显示 N/M，不限显示 N·不限（单次模式只显示 N）。
	const roundBudget = goal.locked && goal.maxRounds > 0 ? goal.maxRounds : 0;
	const roundLabel =
		roundBudget > 0
			? isZhLocale(locale)
				? // 走 i18n 词条：简中「第 N/M 轮」、繁中「第 N/M 輪」
					t("goalBarRound", { n: `${goal.round}/${roundBudget}` })
				: `Round ${goal.round}/${roundBudget}`
			: `${t("goalBarRound", { n: goal.round })}${goal.locked ? ` · ${t("goalBarUnlimitedShort")}` : ""}`;
	// 本目标累计用量（执行者 + 审查者，轮次边界累计）。
	const usageTotal = (goal.usage?.inputTokens ?? 0) + (goal.usage?.outputTokens ?? 0);
	const fmtTok = (n: number): string =>
		n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
	// 目标模式 2.0 加固：pi 引擎的新后端在**任何** goal_status 里都带 execModel
	// （makeGoalStatus 一定赋值）；旧后端（进程没重启）把未知字段丢掉，于是这里是
	// undefined。不静默：「新界面 + 旧后端」这种混合态必须当场说出来。
	const staleBackend = !isDsh && goal.execModel === undefined;

	// Draft fields (only meaningful while editing a new goal).
	const [text, setText] = useState("");
	const [reviewModel, setReviewModel] = useState<string>(goal.reviewModel ?? "");
	const [maxRounds, setMaxRounds] = useState(goal.maxRounds);
	const [locked, setLocked] = useState(goal.locked);
	// 目标模式 2.0：执行者模型（空 = 跟随主对话）。
	const [execModel, setExecModel] = useState<string>(goal.execModel ?? "");
	const [modelOpen, setModelOpen] = useState(false);
	const [execModelOpen, setExecModelOpen] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
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
		setExecModel(goal.execModel ?? "");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [goal.goal, goal.reviewModel, goal.maxRounds, goal.locked, goal.execModel]);

	// Lazily fetch the model list when the review-model dropdown opens.
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

	/** 「计划」= 一次性动作，不是开关：开服务端只规划闸门 + 把目标输入直接发出去。
	 *  闸门本身是会话级且热生效（服务端 `set_plan_mode` 重建提示词 + 挂工具硬闸门），
	 *  两条消息同一条 WS 按序到达 → 本轮就在闸门内跑。输入为空则只开闸门。 */
	const runPlan = () => {
		const trimmed = text.trim();
		appSend({ type: "set_plan_mode", enabled: true });
		if (!trimmed) return;
		appSend({ type: "prompt", text: trimmed });
		setText("");
	};

	/** Start the collaborative wizard: AI asks questions to refine the draft
	 *  into a goal, then auto-sets it. Reuses the reviewer-model picker as the
	 *  optional wizard model. */
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

	// A wizard running (scoping questions in flight) — show its progress.
	// ---- 槽位合并：宿主 chrome 按 id 分区（编辑行/选项行/活跃行/pill），插件条目跟随同行；
	// 未接线时用默认顺序（与旧硬编码一致），hidden 由上层过滤（App 传全量）。 ----
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
	/** 取某行要画的条目：该行宿主 id + 全部插件条目（插件跟随每行，与旧版 renderSlotToolbar 四处都画一致），按槽位顺序。 */
	const goalZone = (ids: string[]): UiSlotEntry[] => {
		const set = new Set(ids);
		return allGoalEntries.filter((e) => set.has(e.id) || e.source !== "host");
	};
	/** 布局页改名 / 插件 arrange 指定过文案（`labelExplicit`）→ 用那一条，否则内置 i18n 文案。 */
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
		// 计划：与提炼/发送同列的一次性动作按钮（无常亮态、无 aria-pressed ——
		// 开关语义已删；「退出计划」的唯一出口是计划看板里的「开始实施」）。
		"host:goal-plan": isDsh ? null : (
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
					// 标签与值拆成两层：窄屏并排两个下拉时，标签钉死不缩、值省略号收着
					// （整块挤成一个空盒子 = 模型选谁完全看不见）。title 给全名。
					<span className="goalbar-opt" title={`${t("goalBarReviewModel")}: ${reviewModelName()}`}>
						<span className="goalbar-opt-label">{`${goalLabel("host:goal-model", t("goalBarReviewModel"))}:`}</span>
						<b>{reviewModelName()}</b>
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
						appSend({ type: "set_goal_prefs", reviewModel: "" });
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
							appSend({ type: "set_goal_prefs", reviewModel: m.id });
						}}
					>
						<span className="dd-model-cell">
							<span className="dd-model-name">{m.name}</span>
							<span className="dd-model-meta">
								<span className="dd-model-provider">{m.provider}</span>
								<span className="dd-model-id">{m.id.split("/").slice(1).join("/")}</span>
							</span>
						</span>
					</DropdownItem>
				))}
				<button type="button" className="dd-refresh" onClick={() => appSend({ type: "list_models" })}>
					{t("refreshModels")}
				</button>
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
		// 执行者模型（空 = 跟随主对话）。
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
				<div className="dd-header">{t("goalBarExecModel")}</div>
				{(reqLoading || modelsLoading) && <div className="dd-loading">{t("loading")}</div>}
				{models.length === 0 && !reqLoading && !modelsLoading && <div className="dd-loading">{t("noModels")}</div>}
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
				{models.map((m) => (
					<DropdownItem
						key={m.id}
						active={execModel === m.id}
						onClick={() => {
							setExecModel(m.id);
							setExecModelOpen(false);
							appSend({ type: "set_goal_prefs", execModel: m.id });
						}}
					>
						<span className="dd-model-cell">
							<span className="dd-model-name">{m.name}</span>
							<span className="dd-model-meta">
								<span className="dd-model-provider">{m.provider}</span>
								<span className="dd-model-id">{m.id.split("/").slice(1).join("/")}</span>
							</span>
						</span>
					</DropdownItem>
				))}
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
							// 目标模式 2.0：委托执行下把「执行对话」一键打开（左栏同样可点）。
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

	// Inactive, collapsed — a single compact pill floating in the CENTER of the
	// chat column (not a full-width panel). A discreet 🎯 chip; click to open the editor.
	if (collapsed) {
		// pill 藏掉且无插件条目时整条不占位（布局页「恢复」可找回）。
		const pillBar = renderMergedToolbar(goalZone(["host:goal-pill"]), goalHostNodes, onUiAction);
		if (!pillBar) return null;
		// 折叠态**刻意不带 `.goalbar` 类**：那一套是「整条面板」的皮（边框/底色/
		// 圆角/内边距），主题还会用 `.goalbar { border-top: … !important }` 画一条
		// 通栏细线 —— 收起时它就是一条横跨整列的带子，正好横在最后一条消息上把它
		// 切断（用户实报「折叠时一整行遮挡底部消息」）。折叠态只是消息区与输入框
		// 之间的一枚小药丸：自带一个 flex 行、整行水平居中、不多占高度。
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
									// 一键重设 = 把历史目标填回输入框（不直接发送，确认/改完再按发送）。
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
