import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
	FiActivity,
	FiCheck,
	FiClock,
	FiEdit3,
	FiFileText,
	FiLayers,
	FiMessageSquare,
	FiPlay,
	FiPlus,
	FiSliders,
	FiTrash2,
	FiX,
} from "react-icons/fi";
import type { CanvasGraphSummary, SchedulerTaskInput, SchedulerTaskView, UiVisionBridgeModel } from "../types";
import { searchCanvasMentions } from "../canvas-mentions";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { THINKING_VALUES } from "../thinking-levels";
import { useEscapeKey } from "../shortcut-stack";
import { HintTip } from "./HintTip";

interface SchedulerPanelProps {
	tasks: SchedulerTaskView[];
	cwd: string;
	models: UiVisionBridgeModel[];
}

const CRON_PRESETS: { value: string; key: string }[] = [
	{ value: "0 9 * * *", key: "schedulerPresetDaily" },
	{ value: "0 * * * *", key: "schedulerPresetHourly" },
	{ value: "*/30 * * * *", key: "schedulerPresetHalfHour" },
	{ value: "0 9 * * 1-5", key: "schedulerPresetWorkday" },
	{ value: "0 9 * * 1", key: "schedulerPresetMonday" },
];

const PROMPT_TEMPLATES = [
	{
		key: "health",
		label: "🔍 依赖与健康巡检",
		prompt:
			"请对当前项目进行健康与安全性巡检：\n1. 检查 package.json 依赖是否有可升级项或高危安全漏洞；\n2. 检查是否有未解决的构建告警；\n3. 输出一份简洁的健康总结并给出升级建议。",
	},
	{
		key: "test",
		label: "🧪 测试套件与排查",
		prompt:
			"执行测试套件与异常排查：\n1. 运行当前项目的自动化测试套件；\n2. 若有失败用例，读取相关代码并定位根因；\n3. 生成测试失败报告并提出修复补丁建议。",
	},
	{
		key: "git",
		label: "🌿 Git 分支与状态审计",
		prompt:
			"日常 Git 仓库状态审计：\n1. 检查是否存在未提交的代码修改或冲突标记；\n2. 查看近 3 天本地分支与远程 main 的差异；\n3. 提示需要清理的废弃分支或待合代码。",
	},
	{
		key: "clean",
		label: "🧹 缓存与日志清理",
		prompt:
			"维护与清理任务：\n1. 检查 dist、.cache、临时日志等目录大小；\n2. 清理过期的构建缓存与临时文件；\n3. 报告清理后节省的磁盘空间。",
	},
];

function explainSchedule(draft: Draft, tr: ReturnType<typeof useT>): { summary: string; nextPreview: string } {
	if (draft.kind === "interval") {
		const min = Math.max(1, Math.floor(Number(draft.intervalMinutes) || 0));
		return {
			summary: `${tr("schedulerKindInterval")} · 每隔 ${min} 分钟执行一次`,
			nextPreview: `约 ${min} 分钟后`,
		};
	}
	const spec = draft.cron.trim();
	const hit = CRON_PRESETS.find((p) => p.value === spec);
	if (hit) {
		const label = tr(hit.key as Parameters<typeof tr>[0]);
		if (spec === "0 9 * * 1-5") {
			return { summary: `${label}（周一至周五 09:00 执行）`, nextPreview: "下个工作日 09:00" };
		}
		if (spec === "0 9 * * 1") {
			return { summary: `${label}（每周一 09:00 执行）`, nextPreview: "下周一 09:00" };
		}
		if (spec === "0 9 * * *") {
			return { summary: `${label}（每天 09:00 执行）`, nextPreview: "明天 09:00" };
		}
		if (spec === "0 * * * *") {
			return { summary: `${label}（整点执行）`, nextPreview: "下个整点" };
		}
		if (spec === "*/30 * * * *") {
			return { summary: `${label}（每 30 分钟执行）`, nextPreview: "约 30 分钟后" };
		}
		return { summary: label, nextPreview: "按设定周期自动触发" };
	}
	if (!spec) {
		return { summary: "尚未填写 Cron 表达式", nextPreview: "—" };
	}
	return {
		summary: `Cron 规则: ${spec}`,
		nextPreview: "按 Cron 规则自动触发",
	};
}

interface Draft {
	target: "conversation" | "canvas";
	graphId: string;
	id: string;
	name: string;
	description: string;
	cwd: string;
	kind: "cron" | "interval";
	cron: string;
	preset: string;
	intervalMinutes: string;
	prompt: string;
	model: string;
	thinkingLevel: string;
	catchUp: boolean;
}

export function blankDraft(cwd: string): Draft {
	return {
		target: "conversation",
		graphId: "",
		id: "",
		name: "",
		description: "",
		cwd,
		kind: "cron",
		cron: "0 9 * * *",
		preset: "0 9 * * *",
		intervalMinutes: "60",
		prompt: "",
		model: "",
		thinkingLevel: "",
		catchUp: false,
	};
}

export function draftFromTask(t: SchedulerTaskView): Draft {
	const presetHit = t.kind === "cron" && CRON_PRESETS.some((p) => p.value === t.spec);
	return {
		target: t.target ?? (t.graphId ? "canvas" : "conversation"),
		graphId: t.graphId ?? "",
		id: t.id,
		name: t.name,
		description: t.description,
		cwd: t.cwd,
		kind: t.kind,
		cron: t.kind === "cron" ? t.spec : "0 9 * * *",
		preset: presetHit ? t.spec : "custom",
		intervalMinutes: t.kind === "interval" ? String(Math.max(1, Math.round(Number(t.spec) / 60000))) : "60",
		prompt: t.prompt,
		model: t.model,
		thinkingLevel: t.thinkingLevel,
		catchUp: t.catchUp === "once",
	};
}

export function canSaveDraft(draft: Draft, graphs: CanvasGraphSummary[], loading: boolean): boolean {
	return Boolean(
		draft.name.trim() &&
		draft.cwd.trim() &&
		(draft.target === "canvas" ? !loading && graphs.some((graph) => graph.id === draft.graphId) : draft.prompt.trim()),
	);
}

export function taskInputFromDraft(draft: Draft): SchedulerTaskInput {
	return {
		...(draft.id ? { id: draft.id } : {}),
		target: draft.target,
		...(draft.target === "canvas" ? { graphId: draft.graphId } : {}),
		name: draft.name.trim(),
		description: draft.description.trim(),
		cwd: draft.cwd.trim(),
		kind: draft.kind,
		spec:
			draft.kind === "cron"
				? draft.cron.trim()
				: String(Math.max(1, Math.floor(Number(draft.intervalMinutes) || 0)) * 60000),
		prompt: draft.prompt.trim(),
		...(draft.target === "conversation" && draft.model.trim() ? { model: draft.model.trim() } : {}),
		...(draft.target === "conversation" && draft.thinkingLevel.trim()
			? { thinkingLevel: draft.thinkingLevel.trim() }
			: {}),
		catchUp: draft.catchUp ? "once" : "skip",
	};
}

function specSummary(t: SchedulerTaskView, tr: ReturnType<typeof useT>): string {
	if (t.kind === "interval") {
		const min = Math.round(Number(t.spec) / 60000);
		if (min < 60) return `${tr("schedulerKindInterval")} · ${min} min`;
		if (min % 60 === 0) return `${tr("schedulerKindInterval")} · ${min / 60} h`;
		return `${tr("schedulerKindInterval")} · ${min} min`;
	}
	const hit = CRON_PRESETS.find((p) => p.value === t.spec);
	if (hit) return tr(hit.key as Parameters<typeof tr>[0]);
	return t.spec;
}

function formatTime(ts: number | null): string {
	if (!ts) return "";
	try {
		return new Date(ts).toLocaleString();
	} catch {
		return String(ts);
	}
}

export function SchedulerPanel({ tasks, cwd, models }: SchedulerPanelProps) {
	const t = useT();
	const [draft, setDraft] = useState<Draft | null>(null);
	const [isNew, setIsNew] = useState(false);
	const [graphs, setGraphs] = useState<CanvasGraphSummary[]>([]);
	const [graphsLoading, setGraphsLoading] = useState(false);
	const draftTarget = draft?.target;
	useEffect(() => {
		if (draftTarget !== "canvas") return;
		let active = true;
		setGraphs([]);
		setGraphsLoading(true);
		void searchCanvasMentions(() => appSend({ type: "canvas_list" })).then((items) => {
			if (!active) return;
			setGraphs(items);
			setGraphsLoading(false);
		});
		return () => {
			active = false;
		};
	}, [draftTarget, cwd]);
	const [openHistory, setOpenHistory] = useState<Set<string>>(new Set());

	useEscapeKey(() => setDraft(null), Boolean(draft));

	useEffect(() => {
		appSend({ type: "schedule_list" });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const toggleHistory = (id: string) =>
		setOpenHistory((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	const save = () => {
		if (!draft || !canSaveDraft(draft, graphs, graphsLoading)) return;
		appSend({ type: "schedule_save", task: taskInputFromDraft(draft) });
		setDraft(null);
	};

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiClock className="set-section-icon" />
				{t("settingsScheduler")}
				<HintTip text={t("schedulerDesc")} />
				<span className="set-count">{tasks.length}</span>
				<button
					type="button"
					className="set-save-btn"
					title={t("schedulerNew")}
					onClick={() => {
						setDraft(blankDraft(cwd));
						setIsNew(true);
					}}
				>
					<FiPlus /> {t("schedulerNew")}
				</button>
			</div>

			{tasks.length === 0 ? (
				<p className="set-hint">{t("schedulerEmpty")}</p>
			) : (
				<ul className="scheduler-list">
					{tasks.map((task) => (
						<li key={task.id} className={`scheduler-item ${task.enabled ? "" : "off"}`}>
							<div className="scheduler-line1">
								<span className="scheduler-name" title={task.description || task.name}>
									{task.running ? `${t("schedulerRunning")} ` : ""}
									{task.name}
								</span>
								<span className={`scheduler-badge ${task.enabled ? "on" : ""}`}>
									{task.enabled ? t("schedulerEnabled") : t("schedulerDisabled")}
								</span>
								<button
									type="button"
									className={`set-switch ${task.enabled ? "on" : ""}`}
									title={task.enabled ? t("schedulerDisable") : t("schedulerEnable")}
									onClick={() => appSend({ type: "schedule_toggle", id: task.id, enabled: !task.enabled })}
								>
									<span className="set-switch-knob" />
								</button>
							</div>
							<div className="scheduler-line2">
								{(task.target ?? (task.graphId ? "canvas" : "conversation")) === "canvas" && (
									<span>
										{t("schedulerTargetCanvas")} · {task.graphId}
									</span>
								)}
								<span title={task.cwd}>{task.cwd}</span>
								<span>·</span>
								<span title={task.kind === "cron" ? task.spec : `${task.spec} ms`}>{specSummary(task, t)}</span>
							</div>
							<div className="scheduler-line2">
								<span>
									{t("schedulerNextFire")}: {task.nextFire ? formatTime(task.nextFire) : "—"}
								</span>
								<span>·</span>
								<span>
									{t("schedulerLastRun")}:{" "}
									{task.lastRun ? (
										<>
											{formatTime(task.lastRun.at)} ·{" "}
											<span className={task.lastRun.ok ? "scheduler-ok" : "scheduler-fail"}>
												{task.lastRun.ok ? t("schedulerRunOk") : t("schedulerRunFail")}
											</span>
											{task.lastRun.manual ? ` · ${t("schedulerManualBadge")}` : ""}
											{task.lastRun.error ? ` · ${task.lastRun.error}` : ""}
										</>
									) : (
										t("schedulerNeverRun")
									)}
								</span>
								{task.history.length > 1 && (
									<button type="button" className="scheduler-link" onClick={() => toggleHistory(task.id)}>
										{t("schedulerHistory")} ({task.history.length})
									</button>
								)}
							</div>
							{openHistory.has(task.id) && task.history.length > 0 && (
								<ul className="scheduler-history">
									{task.history.map((h, i) => (
										<li key={`${h.at}-${i}`}>
											{formatTime(h.at)} ·{" "}
											<span className={h.ok ? "scheduler-ok" : "scheduler-fail"}>
												{h.ok ? t("schedulerRunOk") : t("schedulerRunFail")}
											</span>
											{` · ${(h.durationMs / 1000).toFixed(0)}s`}
											{h.manual ? ` · ${t("schedulerManualBadge")}` : ""}
											{h.error ? ` · ${h.error}` : ""}
										</li>
									))}
								</ul>
							)}
							<div className="scheduler-actions">
								<button
									type="button"
									className="btn"
									disabled={task.running}
									title={t("schedulerRunNow")}
									onClick={() => appSend({ type: "schedule_run", id: task.id })}
								>
									<FiPlay /> {t("schedulerRunNow")}
								</button>
								<button
									type="button"
									className="btn"
									title={t("schedulerEdit")}
									onClick={() => {
										setDraft(draftFromTask(task));
										setIsNew(false);
									}}
								>
									<FiEdit3 /> {t("schedulerEdit")}
								</button>
								<button
									type="button"
									className="btn"
									title={t("schedulerDelete")}
									onClick={() => {
										if (window.confirm(t("schedulerConfirmDelete", { name: task.name })))
											appSend({ type: "schedule_delete", id: task.id });
									}}
								>
									<FiTrash2 /> {t("schedulerDelete")}
								</button>
							</div>
						</li>
					))}
				</ul>
			)}

			{draft &&
				typeof document !== "undefined" &&
				createPortal(
					<div className="modal-backdrop scheduler-modal-backdrop" onClick={() => setDraft(null)}>
						<div className="modal scheduler-modal" onClick={(e) => e.stopPropagation()}>
							<div className="modal-head">
								<div className="scheduler-head-icon">
									<FiClock />
								</div>
								<div className="scheduler-head-titles">
									<h2>{isNew ? t("schedulerNew") : `${t("schedulerEdit")} · ${draft.name || ""}`}</h2>
								</div>
								<button
									type="button"
									className="modal-close scheduler-modal-close"
									aria-label={t("close")}
									onClick={() => setDraft(null)}
								>
									<FiX />
								</button>
							</div>
							<div className="modal-body">
								<div className="scheduler-card">
									<div className="scheduler-card-head">
										<span className="scheduler-card-title">
											<FiFileText /> 任务身份与执行目标
										</span>
									</div>
									<div className="scheduler-grid-2">
										<div className="scheduler-field">
											<label className="scheduler-field-label">任务名称</label>
											<input
												className="set-input"
												placeholder={t("schedulerNamePlaceholder")}
												value={draft.name}
												onChange={(e) => setDraft({ ...draft, name: e.target.value })}
											/>
										</div>
										<div className="scheduler-field">
											<label className="scheduler-field-label">任务说明（可选）</label>
											<input
												className="set-input"
												placeholder={t("schedulerDescPlaceholder")}
												value={draft.description}
												onChange={(e) => setDraft({ ...draft, description: e.target.value })}
											/>
										</div>
									</div>

									<div className="scheduler-grid-2">
										<div className="scheduler-field">
											<label className="scheduler-field-label">
												{t(draft.target === "canvas" ? "schedulerRunBaseLabel" : "schedulerCwdLabel")}
											</label>
											<div className="scheduler-cwd-row">
												<input
													className="set-input"
													placeholder={t("schedulerCwdPlaceholder")}
													value={draft.cwd}
													onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
												/>
												<button type="button" className="btn sm" onClick={() => setDraft({ ...draft, cwd })}>
													{t("schedulerUseCurrentCwd")}
												</button>
											</div>
										</div>
										<div className="scheduler-field">
											<label className="scheduler-field-label">{t("schedulerTargetLabel")}</label>
											<div className="scheduler-seg-group">
												<button
													type="button"
													className={`scheduler-seg-btn ${draft.target === "conversation" ? "active" : ""}`}
													onClick={() => setDraft({ ...draft, target: "conversation" })}
												>
													<FiMessageSquare /> {t("schedulerTargetConversation")}
												</button>
												<button
													type="button"
													className={`scheduler-seg-btn ${draft.target === "canvas" ? "active" : ""}`}
													onClick={() => setDraft({ ...draft, target: "canvas" })}
												>
													<FiLayers /> {t("schedulerTargetCanvas")}
												</button>
											</div>
										</div>
									</div>

									{draft.target === "canvas" && (
										<div className="scheduler-field" style={{ marginTop: 2 }}>
											<label className="scheduler-field-label">{t("schedulerGraphLabel")}</label>
											<select
												className="set-select"
												aria-label={t("schedulerGraphLabel")}
												value={draft.graphId}
												disabled={graphsLoading}
												onChange={(e) => setDraft({ ...draft, graphId: e.target.value })}
											>
												<option value="">{t("schedulerGraphPlaceholder")}</option>
												{draft.graphId && !graphs.some((graph) => graph.id === draft.graphId) && (
													<option value={draft.graphId}>
														{draft.graphId} · {t("schedulerGraphUnavailable")}
													</option>
												)}
												{graphs.map((graph) => (
													<option key={graph.id} value={graph.id}>
														{graph.name} · {graph.id}
													</option>
												))}
											</select>
											{!graphsLoading && (!draft.graphId || !graphs.some((graph) => graph.id === draft.graphId)) && (
												<p className="set-hint">{t("schedulerGraphHint")}</p>
											)}
										</div>
									)}
								</div>

								<div className="scheduler-card">
									<div className="scheduler-card-head">
										<span className="scheduler-card-title">
											<FiClock /> {t("schedulerKindLabel")} 与时间预演
										</span>
										<span className="scheduler-spec-badge">
											{draft.kind === "cron" ? draft.cron : `${draft.intervalMinutes || 1} min`}
										</span>
									</div>

									<div className="scheduler-field">
										<label className="scheduler-field-label">常用频次快捷设定</label>
										<div className="scheduler-pills">
											{CRON_PRESETS.map((p) => {
												const active = draft.kind === "cron" && draft.preset === p.value;
												return (
													<button
														key={p.value}
														type="button"
														className={`scheduler-pill-btn ${active ? "active" : ""}`}
														onClick={() =>
															setDraft({
																...draft,
																kind: "cron",
																preset: p.value,
																cron: p.value,
															})
														}
													>
														{t(p.key as Parameters<typeof t>[0])}
													</button>
												);
											})}
											<button
												type="button"
												className={`scheduler-pill-btn ${draft.kind === "cron" && draft.preset === "custom" ? "active" : ""}`}
												onClick={() =>
													setDraft({
														...draft,
														kind: "cron",
														preset: "custom",
													})
												}
											>
												{t("schedulerPresetCustom")}
											</button>
											<button
												type="button"
												className={`scheduler-pill-btn ${draft.kind === "interval" ? "active" : ""}`}
												onClick={() =>
													setDraft({
														...draft,
														kind: "interval",
													})
												}
											>
												{t("schedulerKindInterval")}
											</button>
										</div>
									</div>

									{draft.kind === "cron" && draft.preset === "custom" && (
										<div className="scheduler-sub-row">
											<div className="scheduler-field" style={{ flex: 1 }}>
												<label className="scheduler-field-label">{t("schedulerKindCron")} (分 时 日 月 周)</label>
												<input
													className="set-input"
													placeholder={t("schedulerCronPlaceholder")}
													value={draft.cron}
													onChange={(e) => setDraft({ ...draft, cron: e.target.value })}
												/>
											</div>
										</div>
									)}
									{draft.kind === "interval" && (
										<div className="scheduler-sub-row">
											<div className="scheduler-field" style={{ flex: 1 }}>
												<label className="scheduler-field-label">{t("schedulerIntervalMinutes")}</label>
												<input
													className="set-input"
													type="number"
													min={1}
													placeholder={t("schedulerIntervalMinutes")}
													value={draft.intervalMinutes}
													onChange={(e) => setDraft({ ...draft, intervalMinutes: e.target.value })}
												/>
											</div>
										</div>
									)}

									{(() => {
										const exp = explainSchedule(draft, t);
										return (
											<div className="scheduler-preview-banner">
												<div className="scheduler-preview-left">
													<span className="scheduler-live-dot" />
													<span className="scheduler-preview-text">{exp.summary}</span>
												</div>
												<div className="scheduler-preview-right">
													<span className="scheduler-preview-tag">
														{t("schedulerNextFire")}: {exp.nextPreview}
													</span>
												</div>
											</div>
										);
									})()}
								</div>

								<div className="scheduler-card">
									<div className="scheduler-card-head">
										<span className="scheduler-card-title">
											<FiActivity /> {draft.target === "canvas" ? "附加输入（Prompt）" : "给 Agent 的具体任务指令"}
										</span>
										<span className="scheduler-card-hint">
											{draft.prompt.length > 0 ? `${draft.prompt.length} 字` : "支持多步骤与 Markdown"}
										</span>
									</div>

									{draft.target === "conversation" && (
										<div className="scheduler-tpl-bar">
											<span className="scheduler-tpl-label">快捷填入巡检模板：</span>
											<div className="scheduler-tpl-chips">
												{PROMPT_TEMPLATES.map((tpl) => (
													<button
														key={tpl.key}
														type="button"
														className="scheduler-tpl-chip"
														onClick={() => setDraft({ ...draft, prompt: tpl.prompt })}
													>
														{tpl.label}
													</button>
												))}
											</div>
										</div>
									)}

									<textarea
										className="set-input scheduler-prompt-area"
										rows={6}
										placeholder={t(
											draft.target === "canvas" ? "schedulerCanvasPromptPlaceholder" : "schedulerPromptPlaceholder",
										)}
										value={draft.prompt}
										onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
									/>
								</div>

								<div className="scheduler-card">
									<div className="scheduler-card-head">
										<span className="scheduler-card-title">
											<FiSliders /> 运行模型与容灾策略
										</span>
									</div>

									<div className="scheduler-grid-2">
										{draft.target === "conversation" ? (
											<>
												<div className="scheduler-field">
													<label className="scheduler-field-label">{t("schedulerModelLabel")}</label>
													<select
														className="set-select"
														value={draft.model}
														onChange={(e) => setDraft({ ...draft, model: e.target.value })}
													>
														<option value="">{t("subagentFollowMain")}</option>
														{models.map((m) => (
															<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
																{m.label}
															</option>
														))}
													</select>
												</div>
												<div className="scheduler-field">
													<label className="scheduler-field-label">
														{t("schedulerThinkingLabel")} <HintTip text={t("tplThinkingHint")} />
													</label>
													<select
														className="set-select"
														value={draft.thinkingLevel}
														onChange={(e) => setDraft({ ...draft, thinkingLevel: e.target.value })}
													>
														<option value="">{t("tplThinkingFollowMain")}</option>
														{THINKING_VALUES.map((v) => (
															<option key={v} value={v}>
																{t(`thinking.${v}`)}
															</option>
														))}
													</select>
												</div>
											</>
										) : (
											<div className="scheduler-field" style={{ gridColumn: "span 2" }}>
												<span className="set-hint">画布工作流将使用画布各节点自身绑定的模型与执行逻辑运行。</span>
											</div>
										)}
									</div>

									<div
										className={`scheduler-switch-row ${draft.catchUp ? "on" : ""}`}
										onClick={() => setDraft({ ...draft, catchUp: !draft.catchUp })}
									>
										<div className="scheduler-switch-info">
											<span className="scheduler-switch-title">
												{t("schedulerCatchUp")} <HintTip text={t("schedulerCatchUpHint")} />
											</span>
											<span className="scheduler-switch-desc">{t("schedulerCatchUpHint")}</span>
										</div>
										<span className="scheduler-switch-knob-track">
											<span className="scheduler-switch-knob-thumb" />
										</span>
									</div>
								</div>
							</div>

							<div className="scheduler-foot">
								<div className="scheduler-foot-tip">
									<span>💡 定时任务在后台自动静默执行，可在列表中查看执行记录与产出。</span>
								</div>
								<div className="scheduler-foot-btns">
									<button type="button" className="btn" onClick={() => setDraft(null)}>
										{t("schedulerCancelEdit")}
									</button>
									<button
										type="button"
										className="btn primary"
										disabled={!canSaveDraft(draft, graphs, graphsLoading)}
										onClick={save}
									>
										<FiCheck /> {t("schedulerSave")}
									</button>
								</div>
							</div>
						</div>
					</div>,
					document.body,
				)}
		</div>
	);
}
