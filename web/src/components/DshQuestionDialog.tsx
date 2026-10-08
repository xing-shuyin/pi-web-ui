import { useEffect, useRef, useState } from "react";
import { FiChevronDown, FiChevronUp } from "react-icons/fi";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { useEscapeKey } from "../shortcut-stack";
import { useImeCompositionGuard } from "../use-ime-composition-guard";
import { hoverCapable } from "../tip-position";
import { HoverDetail } from "./HoverDetail";
import { Markdown } from "./Markdown";

interface QuestionItem {
	id: string;
	question: string;
	detail?: string;
	header?: string;
	options?: { label: string; description?: string; preview?: string }[];
	multiSelect?: boolean;
	/** 级联依赖（Waterfall）：仅当指定 questionId 选中了特定值（未给 value 则表示只要已作答）时本题才展示；不满足则跳过。 */
	dependsOn?: {
		questionId: string;
		value?: string | string[];
	};
	/** 动态级联选项映射：根据前序依赖题的所选值动态提供候选选项列表。 */
	optionsMap?: Record<string, { label: string; description?: string; preview?: string }[]>;
}

interface DshQuestionDialogProps {
	question: {
		id: string;
		/** 服务端超时时间戳（epoch ms）——显示倒计时，归零自动取消。 */
		deadline?: number;
		conversationId?: string;
		conversationTitle?: string;
		questions: QuestionItem[];
	};
	/** 跨页作答时持有方会话 id：答案转交过去（question_answer 带 owner）。 */
	owner?: string;
	/** 备用对话标题（当 question 中未携带时兜底使用）。 */
	conversationTitle?: string;
}

/**
 * DSH 引擎的模型提问对话框（ask_user_question 工具 → question_pending 通知）。
 * 向导式：每次只显示一道题。
 *  - 单选：点选项即选中并自动进入下一题；最后一题点选项直接提交。
 *  - 多选/自由文本：勾选或输入后用「下一步/提交」推进，「上一步」可回头修改。
 *  - ✗ / Esc / 底部「取消」→ 取消提问；提交与取消都会立即收起本面板
 *    （use-chat 在发出 question_answer 后置空 question）。
 * 选中带 `preview` 的选项时在下方预览其 markdown/HTML 内容。
 * 复用 .dialog-inline 样式（非模态，对话保持可见）。
 *
 * 文本渲染：question/detail/description/preview 统一走 Markdown（rawHtml），
 * 模型可自由写 markdown 或 HTML —— 由模型自选、信任模型。
 */
export function DshQuestionDialog({ question, owner, conversationTitle }: DshQuestionDialogProps) {
	const t = useT();
	const convTitle = question.conversationTitle || conversationTitle;
	const [selections, setSelections] = useState<Record<string, string[]>>({});
	const [customs, setCustoms] = useState<Record<string, string>>({});
	const [collapsed, setCollapsed] = useState(false);
	/** 输入法守卫：macOS 中文输入法下 Enter 是「上屏」而非「提交」（issue #560，与 #248 同源）。 */
	const imeGuard = useImeCompositionGuard();
	/** 向导当前步（question.questions 下标），每次新提问从第一题开始。 */
	const [step, setStep] = useState(0);
	// P0-6：倒计时（秒），归零自动取消提问（服务端同样超时 reject）。
	const [remainSec, setRemainSec] = useState<number>(() =>
		question.deadline ? Math.max(0, Math.ceil((question.deadline - Date.now()) / 1000)) : -1,
	);

	useEffect(() => {
		// 每个新提问重置本地状态。
		setSelections({});
		setCustoms({});
		setStep(0);
		setCollapsed(false);
		const remain = question.deadline ? Math.max(0, Math.ceil((question.deadline - Date.now()) / 1000)) : -1;
		setRemainSec(remain);
		// 审查 #9：挂载时已过期的提问立即取消 —— 下面的定时器分支（s > 0 才发）
		// 永远不会触发，过期提问会一直挂着等用户手点或服务端超时。
		if (question.deadline && remain <= 0) {
			appSend({
				type: "question_answer",
				id: question.id,
				answers: [],
				cancelled: true,
				...(owner ? { owner } : {}),
			});
		}
	}, [question.id, question.deadline, owner]);

	useEffect(() => {
		if (!question.deadline) return;
		const id = setInterval(() => {
			setRemainSec((s) => {
				const next = Math.max(0, Math.ceil((question.deadline! - Date.now()) / 1000));
				if (next <= 0 && s > 0) {
					// 归零 → 自动取消（服务端超时 reject 模型提问，对话继续）。
					appSend({
						type: "question_answer",
						id: question.id,
						answers: [],
						cancelled: true,
						...(owner ? { owner } : {}),
					});
				}
				return next;
			});
		}, 1000);
		return () => clearInterval(id);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [question.id, question.deadline]);

	/** 取消提问：✕ / Esc / 底部「取消」与自动取消共用同一出口。 */
	const cancel = () => {
		appSend({ type: "question_answer", id: question.id, answers: [], cancelled: true, ...(owner ? { owner } : {}) });
	};

	// 审查 #12：Esc 改走 shortcut-stack 分层栈（与 Modal 同一调度）——
	// 多层弹窗叠开时内层优先消费，不再裸 document 监听抢 Esc。
	// 折叠态暂停 Esc 取消，避免用户在折叠查看上下文时误触 Esc 取消提问。
	useEscapeKey(() => {
		cancel();
	}, !collapsed);

	const isQuestionVisible = (qq: QuestionItem, sel: Record<string, string[]>): boolean => {
		if (!qq.dependsOn) return true;
		const depSelected = sel[qq.dependsOn.questionId] ?? [];
		if (qq.dependsOn.value === undefined) return depSelected.length > 0;
		const expected = Array.isArray(qq.dependsOn.value) ? qq.dependsOn.value : [qq.dependsOn.value];
		return depSelected.some((ans) => expected.includes(ans));
	};

	const visibleQuestions = question.questions.filter((qq) => isQuestionVisible(qq, selections));
	const total = visibleQuestions.length;

	// 审查 #10：dependsOn 依赖链全不满足 → 一道可回答的题都没有。短暂展示提示后
	// 自动取消（question_answer cancelled），防止模型干等到服务端超时才恢复对话。
	useEffect(() => {
		if (question.questions.length === 0 || total > 0) return;
		const id = setTimeout(() => {
			appSend({
				type: "question_answer",
				id: question.id,
				answers: [],
				cancelled: true,
				...(owner ? { owner } : {}),
			});
		}, 1500);
		return () => clearTimeout(id);
	}, [question.id, question.questions.length, total, owner]);
	const currentStep = Math.min(step, Math.max(0, total - 1));
	const q = visibleQuestions[currentStep];
	if (!q) {
		// 审查 #10：无可回答的题（dependsOn 全不满足）→ 明确提示并自动取消
		// （见上方 effect），不再整块消失让模型干等。
		return (
			<div className="dialog-inline" data-dialog-kind="select">
				<div className="dialog-head">
					<span className="dialog-badge">{t("modelQuestion")}</span>
					{convTitle && (
						<span className="question-conv-title" title={convTitle}>
							{convTitle}
						</span>
					)}
					<button type="button" className="dialog-dismiss" title={t("cancel")} onClick={cancel}>
						✕
					</button>
				</div>
				<div className="set-section">
					<div className="set-hint">{t("questionNoneAvailable")}</div>
				</div>
			</div>
		);
	}

	/** 当前题目的有效选项：如果定义了 optionsMap，根据前序依赖题所选动态取对应候选 */
	const effectiveOptions = (() => {
		if (!q) return [];
		if (q.optionsMap && q.dependsOn) {
			const depAnswers = selections[q.dependsOn.questionId] ?? [];
			for (const ans of depAnswers) {
				if (q.optionsMap[ans]) return q.optionsMap[ans];
			}
		}
		return q.options ?? [];
	})();

	/** 把（可能刚更新、尚未落 state 的）选中结果连同全部题的答案一并提交。 */
	const submitSelections = (sel: Record<string, string[]>) => {
		const answers = question.questions.map((qq) => {
			const selected = sel[qq.id] ?? [];
			const custom = (customs[qq.id] ?? "").trim();
			return { id: qq.id, selected, ...(custom ? { custom } : {}) };
		});
		appSend({ type: "question_answer", id: question.id, answers, ...(owner ? { owner } : {}) });
	};

	const toggleOption = (qid: string, label: string) => {
		setSelections((prev) => {
			const cur = prev[qid] ?? [];
			return {
				...prev,
				[qid]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
			};
		});
	};

	/** 单选：选中并直接前进；多选：仅切换勾选。 */
	const onOptionClick = (qid: string, label: string, multi: boolean) => {
		if (multi) {
			toggleOption(qid, label);
			return;
		}
		const sel = { ...selections, [qid]: [label] };
		setSelections(sel);
		const nextVisible = question.questions.filter((qq) => isQuestionVisible(qq, sel));
		if (currentStep >= nextVisible.length - 1) {
			submitSelections(sel);
		} else {
			setStep(currentStep + 1);
		}
	};

	/** 「下一步/提交」：供多选、自由文本题推进；最后一题提交。 */
	const onNext = () => {
		if (currentStep >= total - 1) submitSelections(selections);
		else setStep(currentStep + 1);
	};

	/** 当前题是否可提交：
	 *  - 有选项：须已选中至少一项或填了自定义文本；
	 *  - 无选项（纯自由文本/可跳过）：无需任何输入即可提交，空提交 = 跳过。 */
	const answered = (qid: string) => {
		const qq = question.questions.find((x) => x.id === qid);
		if (effectiveOptions.length === 0 && (qq?.options?.length ?? 0) === 0) return true;
		return (selections[qid]?.length ?? 0) > 0 || (customs[qid] ?? "").trim() !== "";
	};

	/** 已选中且带 `preview` 的选项预览（当前题；多选选中多个则逐个叠加）。 */
	const previews = effectiveOptions
		.filter((o) => (selections[q.id] ?? []).includes(o.label) && o.preview)
		.map((o) => o.preview as string);

	const questionPreview = (q.header || q.question).replace(/\s+/g, " ").trim();

	return (
		<div className={`dialog-inline${collapsed ? " collapsed" : ""}`} data-dialog-kind="select">
			<div className="dialog-head" onClick={collapsed ? () => setCollapsed(false) : undefined}>
				<span className="dialog-badge">{t("modelQuestion")}</span>
				{convTitle && (
					<span className="question-conv-title" title={convTitle}>
						{convTitle}
					</span>
				)}
				{total > 1 && <span className="question-progress">{t("questionStep", { cur: currentStep + 1, total })}</span>}
				{remainSec >= 0 && (
					<span className="question-timer">
						{remainSec > 0 ? t("questionTimeout", { s: remainSec }) : t("questionTimeoutExpired")}
					</span>
				)}
				{collapsed && (
					<span className="question-collapsed-preview" title={questionPreview}>
						{questionPreview}
					</span>
				)}
				<div className="dialog-head-actions">
					<button
						type="button"
						className="dialog-toggle-collapse"
						title={collapsed ? t("expandSection") : t("collapseSection")}
						onClick={(e) => {
							e.stopPropagation();
							setCollapsed((c) => !c);
						}}
					>
						{collapsed ? <FiChevronUp /> : <FiChevronDown />}
					</button>
					<button
						type="button"
						className="dialog-dismiss"
						title={t("cancel")}
						onClick={(e) => {
							e.stopPropagation();
							cancel();
						}}
					>
						✕
					</button>
				</div>
			</div>
			{!collapsed && (
				<>
					<div className="set-section" key={q.id}>
						<div className="set-section-title">{q.header ?? `${t("modelQuestion")} ${currentStep + 1}`}</div>
						<div className="question-head">
							<Markdown text={q.question} rawHtml />
						</div>
						{q.detail && (
							<div className="set-hint">
								<Markdown text={q.detail} rawHtml />
							</div>
						)}
						{effectiveOptions.length > 0 && (
							<div className="set-list">
								{effectiveOptions.map((o) => {
									const active = (selections[q.id] ?? []).includes(o.label);
									return (
										<QuestionOption
											key={o.label}
											label={o.label}
											description={o.description}
											mark={q.multiSelect ? (active ? "☑ " : "☐ ") : active ? "● " : "○ "}
											active={active}
											onPick={() => onOptionClick(q.id, o.label, !!q.multiSelect)}
										/>
									);
								})}
							</div>
						)}
						{previews.length > 0 && (
							<div className="question-preview">
								<div className="question-preview-label">{t("optionPreview")}</div>
								{previews.map((p, i) => (
									<div className="question-preview-body" key={i}>
										<Markdown text={p} rawHtml />
									</div>
								))}
							</div>
						)}
						<input
							className="set-prompt-input question-custom"
							placeholder={t("modelQuestionCustom")}
							value={customs[q.id] ?? ""}
							onChange={(e) => setCustoms((prev) => ({ ...prev, [q.id]: e.target.value }))}
							onCompositionEnd={imeGuard.onCompositionEnd}
							onKeyDown={(e) => {
								// 输入法上屏用的回车不是提交：只看 e.key 会把「敲英文 → 回车原样上屏」当成
								// 提交/下一步，答案刚上屏就发给模型且无法撤回（issue #560）。判定与聊天输入框
								// 同源（web/src/ime-guard.ts，issue #248 的 isComposing/229/时间窗三条件）。
								if (imeGuard.isImeKey(e.nativeEvent)) return;
								// 回车提交（最后一题提交、否则进入下一题）；未作答则不触发。
								if (e.key === "Enter") {
									e.preventDefault();
									if (answered(q.id)) onNext();
								}
							}}
						/>
					</div>
					<div className="dialog-nav">
						<button type="button" className="dialog-dismiss-inline" onClick={cancel}>
							{t("cancel")}
						</button>
						<div className="dialog-nav-right">
							<button
								type="button"
								className="dialog-prev"
								disabled={currentStep === 0}
								onClick={() => setStep(currentStep - 1)}
							>
								{t("previous")}
							</button>
							<button type="button" className="dialog-submit" disabled={!answered(q.id)} onClick={onNext}>
								{currentStep === total - 1 ? t("modelQuestionSubmit") : t("next")}
							</button>
						</div>
					</div>
				</>
			)}
		</div>
	);
}

/**
 * 选项行：带 `description` 时，可悬浮环境（桌面）由 HoverDetail 以顶层浮层展示完整描述
 * —— 贴在选项旁但不受 `.dialog-inline` 的 `max-height: 45vh; overflow-y: auto` 裁剪；
 * 触屏/窄屏没有 hover，由 CSS 保持描述内联直接显示。
 */
function QuestionOption({
	label,
	description,
	mark,
	active,
	onPick,
}: {
	label: string;
	description?: string;
	/** 单选/多选的勾选标记（☑ ☐ ● ○）。 */
	mark: string;
	active: boolean;
	onPick: () => void;
}) {
	const rowRef = useRef<HTMLButtonElement>(null);
	return (
		<button type="button" ref={rowRef} className={`set-row question-option${active ? " active" : ""}`} onClick={onPick}>
			<div className="set-row-name">
				<span className="question-mark">{mark}</span>
				<Markdown text={label} rawHtml />
			</div>
			{description && (
				<>
					{/* 无 hover 环境（触屏）内联显示；桌面由 CSS 隐藏，改走下面的浮层。 */}
					<div className="set-row-desc">
						<Markdown text={description} rawHtml />
					</div>
					<HoverDetail anchorRef={rowRef} enabled={hoverCapable()} className="question-desc-tip">
						<Markdown text={description} rawHtml />
					</HoverDetail>
				</>
			)}
		</button>
	);
}
