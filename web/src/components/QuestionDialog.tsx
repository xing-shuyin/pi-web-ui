import { useEffect, useRef, useState, useCallback } from "react";
import {
	FiArrowLeft,
	FiArrowRight,
	FiCheck,
	FiChevronDown,
	FiChevronUp,
	FiCornerDownLeft,
	FiHelpCircle,
} from "react-icons/fi";
import { useT } from "../i18n";
import { sendQuestionAnswer } from "../question-answer-relay";
import { useEscapeKey } from "../shortcut-stack";
import { useImeCompositionGuard } from "../use-ime-composition-guard";
import { hoverCapable } from "../tip-position";
import { HoverDetail } from "./HoverDetail";
import { Markdown } from "./Markdown";
import { loadQuestionDraft, saveQuestionDraft, clearQuestionDraft } from "../question-draft";
import { questionWaitTime } from "../question-queue";

interface QuestionItem {
	id: string;
	question: string;
	detail?: string;
	header?: string;
	options?: { label: string; description?: string; preview?: string; recommended?: boolean }[];
	multiSelect?: boolean;
	dependsOn?: {
		questionId: string;
		value?: string | string[];
	};
	optionsMap?: Record<string, { label: string; description?: string; preview?: string; recommended?: boolean }[]>;
}

interface QuestionDialogProps {
	question: {
		id: string;
		global?: boolean;
		deadline?: number;
		conversationId?: string;
		conversationTitle?: string;
		questions: QuestionItem[];
		createdAt?: number;
	};
	owner?: string;
	conversationTitle?: string;
	/** 跨项目的问卷标上项目名，对话标题同名时不至于认错项目。 */
	project?: string;
	onDefer?: () => void;
	onNavigate?: () => void;
}

export function QuestionDialog({
	question,
	owner,
	conversationTitle,
	project,
	onDefer,
	onNavigate,
}: QuestionDialogProps) {
	const t = useT();
	const draftId = question.global ? JSON.stringify([owner, question.id]) : question.id;
	const convTitle = question.conversationTitle || conversationTitle;
	const [selections, setSelections] = useState<Record<string, string[]>>(() => {
		const draft = loadQuestionDraft(draftId);
		return draft?.selections ?? {};
	});
	const [customs, setCustoms] = useState<Record<string, string>>(() => {
		const draft = loadQuestionDraft(draftId);
		return draft?.customs ?? {};
	});
	const [collapsed, setCollapsed] = useState(false);
	const [autoSubmitLast, setAutoSubmitLast] = useState(() => {
		try {
			return localStorage.getItem("pi-web:question-auto-submit-last") === "1";
		} catch {
			return false;
		}
	});
	const imeGuard = useImeCompositionGuard();
	const [step, setStep] = useState<number>(() => {
		const draft = loadQuestionDraft(draftId);
		return draft?.step ?? 0;
	});
	const [remainSec, setRemainSec] = useState<number>(() =>
		question.deadline ? Math.max(0, Math.ceil((question.deadline - Date.now()) / 1000)) : -1,
	);
	const [now, setNow] = useState(Date.now);
	const submittedRef = useRef(false);
	const otherInputRef = useRef<HTMLInputElement>(null);
	const [queuedNotice, setQueuedNotice] = useState(false);

	useEffect(() => {
		submittedRef.current = false;
		const draft = loadQuestionDraft(draftId);
		if (draft) {
			setSelections(draft.selections);
			setCustoms(draft.customs);
			setStep(draft.step);
		} else {
			setSelections({});
			setCustoms({});
			setStep(0);
		}
		setCollapsed(false);
		const remain = question.deadline ? Math.max(0, Math.ceil((question.deadline - Date.now()) / 1000)) : -1;
		setRemainSec(remain);
		setNow(Date.now());
	}, [question.id, question.deadline, question.createdAt, owner]);

	useEffect(() => {
		if (submittedRef.current) return;
		saveQuestionDraft(draftId, { selections, customs, step });
	}, [question.id, selections, customs, step]);

	useEffect(() => {
		if (!question.deadline && !question.createdAt) return;
		setNow(Date.now());
		const id = setInterval(() => {
			const currentNow = Date.now();
			setNow(currentNow);
			if (question.deadline) {
				setRemainSec(Math.max(0, Math.ceil((question.deadline - currentNow) / 1000)));
			}
		}, 1000);
		return () => clearInterval(id);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [question.id, question.deadline, question.createdAt]);

	const cancel = useCallback(
		(reason?: string) => {
			submittedRef.current = true;
			clearQuestionDraft(draftId);
			sendQuestionAnswer({
				type: "question_answer",
				id: question.id,
				answers: [],
				cancelled: true,
				...(question.global ? { global: true } : {}),
				...(reason?.trim() ? { cancelReason: reason.trim() } : {}),
				...(owner ? { owner } : {}),
			});
		},
		[question.id, owner],
	);

	useEscapeKey(() => {
		if (onDefer) onDefer();
		else cancel();
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

	useEffect(() => {
		if (question.questions.length === 0 || total > 0) return;
		const id = setTimeout(() => {
			sendQuestionAnswer({
				type: "question_answer",
				id: question.id,
				answers: [],
				cancelled: true,
				...(question.global ? { global: true } : {}),
				...(owner ? { owner } : {}),
			});
		}, 1500);
		return () => clearTimeout(id);
	}, [question.id, question.questions.length, total, owner]);
	const currentStep = Math.min(step, Math.max(0, total - 1));
	const q = visibleQuestions[currentStep];
	if (!q) {
		return (
			<div className="dialog-inline" data-dialog-kind="select">
				<div className="dialog-head">
					<span className="dialog-badge">{t("modelQuestion")}</span>
					{project && <span className="question-conv-title">{project}</span>}
					{convTitle && (
						<span className="question-conv-title" title={convTitle}>
							{convTitle}
						</span>
					)}
					<button
						type="button"
						className="dialog-dismiss"
						title={t(onDefer ? "questionQueueDefer" : "cancel")}
						onClick={() => (onDefer ? onDefer() : cancel())}
					>
						✕
					</button>
				</div>
				<div className="set-section">
					<div className="set-hint">{t("questionNoneAvailable")}</div>
				</div>
			</div>
		);
	}

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

	const submitSelections = (sel: Record<string, string[]>, customOverride?: Record<string, string>) => {
		const activeCustoms = customOverride ?? customs;
		submittedRef.current = true;
		clearQuestionDraft(draftId);
		const answers = question.questions
			.filter((qq) => isQuestionVisible(qq, sel))
			.map((qq) => {
				const selected = sel[qq.id] ?? [];
				const custom = (activeCustoms[qq.id] ?? "").trim();
				return { id: qq.id, selected, ...(custom ? { custom } : {}) };
			});
		const delivered = sendQuestionAnswer({
			type: "question_answer",
			id: question.id,
			answers,
			...(question.global ? { global: true } : {}),
			...(owner ? { owner } : {}),
		});
		if (!delivered) setQueuedNotice(true);
	};

	const onSkip = () => {
		const nextSel = { ...selections, [q.id]: [] };
		const nextCustoms = { ...customs, [q.id]: "" };
		setSelections(nextSel);
		setCustoms(nextCustoms);
		if (currentStep < total - 1) setStep(currentStep + 1);
		else submitSelections(nextSel, nextCustoms);
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

	const onOptionClick = (qid: string, label: string, multi: boolean) => {
		if (multi) {
			toggleOption(qid, label);
			return;
		}
		const deselecting = (selections[qid] ?? []).includes(label);
		const sel = { ...selections, [qid]: deselecting ? [] : [label] };
		setSelections(sel);
		if (deselecting) return;
		const nextVisible = question.questions.filter((qq) => isQuestionVisible(qq, sel));
		const nextIndex = nextVisible.findIndex((qq) => qq.id === qid) + 1;
		if (nextIndex < nextVisible.length) {
			setStep(nextIndex);
		} else if (autoSubmitLast) {
			submitSelections(sel);
		}
	};

	const onNext = () => {
		if (currentStep >= total - 1) submitSelections(selections);
		else setStep(currentStep + 1);
	};

	const answered = (qid: string) => {
		const qq = question.questions.find((x) => x.id === qid);
		if (effectiveOptions.length === 0 && (qq?.options?.length ?? 0) === 0) return true;
		return (selections[qid]?.length ?? 0) > 0 || (customs[qid] ?? "").trim() !== "";
	};

	const previews = effectiveOptions
		.filter((o) => (selections[q.id] ?? []).includes(o.label) && o.preview)
		.map((o) => o.preview as string);

	const questionPreview = (q.header || q.question).replace(/\s+/g, " ").trim();

	const currentCustom = (customs[q.id] ?? "").trim();
	const allCustoms = Object.values(customs)
		.map((c) => c?.trim())
		.filter(Boolean)
		.join(";\n");
	const hasRejectNote = currentCustom.length > 0 || allCustoms.length > 0;
	const rejectReason = currentCustom || allCustoms;

	useEffect(() => {
		if (collapsed) return;
		const onKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement | null;
			const isEditing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
			if (isEditing || imeGuard.isImeKey(e)) return;
			if (e.key === "Enter" && target?.closest?.("button, select, label")) return;

			if (e.key >= "1" && e.key <= "9") {
				const idx = parseInt(e.key, 10) - 1;
				if (idx < effectiveOptions.length) {
					e.preventDefault();
					onOptionClick(q.id, effectiveOptions[idx].label, !!q.multiSelect);
					return;
				}
				if (idx === effectiveOptions.length) {
					e.preventDefault();
					otherInputRef.current?.focus();
					return;
				}
			}

			if (e.key === "ArrowLeft" && currentStep > 0) {
				e.preventDefault();
				setStep(currentStep - 1);
				return;
			}
			if (e.key === "ArrowRight" && currentStep < total - 1 && answered(q.id)) {
				e.preventDefault();
				setStep(currentStep + 1);
				return;
			}

			if (e.key === "Enter" && answered(q.id)) {
				e.preventDefault();
				onNext();
			}
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [collapsed, effectiveOptions, q.id, q.multiSelect, currentStep, total, answered, onNext, onOptionClick]);

	const waitLabel = questionWaitTime(question.createdAt ?? 0, now);
	const hasMeta = Boolean(project || convTitle || queuedNotice || remainSec >= 0 || waitLabel);
	const otherKeyNum = effectiveOptions.length < 9 ? effectiveOptions.length + 1 : undefined;

	return (
		<div className={`dialog-inline${collapsed ? " collapsed" : ""}`} data-dialog-kind="select">
			<div className="dialog-head question-dialog-head" onClick={collapsed ? () => setCollapsed(false) : undefined}>
				<div className="question-head-main">
					<span className="question-head-icon" aria-hidden="true">
						<FiHelpCircle />
						<span className="question-head-dot" />
					</span>
					{collapsed ? (
						<span className="question-collapsed-preview" title={questionPreview}>
							{questionPreview}
						</span>
					) : (
						<div className="question-head">
							<Markdown text={q.question} rawHtml />
						</div>
					)}
					<div className="dialog-head-actions">
						{total > 1 && !collapsed && (
							<div className="question-stepper">
								<button
									type="button"
									className="question-step-arrow dialog-prev"
									disabled={currentStep === 0}
									title={t("previous")}
									onClick={(e) => {
										e.stopPropagation();
										setStep(currentStep - 1);
									}}
								>
									<FiArrowLeft />
								</button>
								<span className="question-progress">{`${currentStep + 1} / ${total}`}</span>
								<button
									type="button"
									className="question-step-arrow"
									disabled={currentStep >= total - 1}
									title={t("next")}
									onClick={(e) => {
										e.stopPropagation();
										setStep(currentStep + 1);
									}}
								>
									<FiArrowRight />
								</button>
							</div>
						)}
						{onNavigate && (
							<button
								type="button"
								className="btn"
								onClick={(e) => {
									e.stopPropagation();
									onNavigate();
								}}
							>
								{t("questionQueueNavigate")}
							</button>
						)}
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
							title={
								onDefer ? t("questionQueueDefer") : hasRejectNote ? t("modelQuestionRejectWithNoteTip") : t("cancel")
							}
							onClick={(e) => {
								e.stopPropagation();
								if (onDefer) onDefer();
								else cancel(hasRejectNote ? rejectReason : undefined);
							}}
						>
							✕
						</button>
					</div>
				</div>
				{!collapsed && hasMeta && (
					<div className="question-meta-row">
						{project && <span className="question-conv-title">{project}</span>}
						{convTitle && (
							<span className="question-conv-title" title={convTitle}>
								{convTitle}
							</span>
						)}
						{queuedNotice && (
							<span className="question-timer" title="connection lost">
								{t("questionQueuedOffline")}
							</span>
						)}
						{remainSec >= 0 ? (
							<span className="question-timer">
								{remainSec > 0 ? t("questionTimeout", { s: remainSec }) : t("questionTimeoutExpired")}
							</span>
						) : waitLabel ? (
							<span className="question-timer question-queue-wait">⏱ {waitLabel}</span>
						) : null}
					</div>
				)}
			</div>
			{!collapsed && (
				<>
					<div className="set-section" key={q.id}>
						{q.detail && (
							<div className="set-hint">
								<Markdown text={q.detail} rawHtml />
							</div>
						)}
						<div className="set-list">
							{effectiveOptions.map((o, optIdx) => {
								const active = (selections[q.id] ?? []).includes(o.label);
								const isRecommended = o.recommended ?? (optIdx === 0 && effectiveOptions.length > 1);
								const keyNum = optIdx < 9 ? optIdx + 1 : undefined;
								return (
									<QuestionOption
										key={o.label}
										label={o.label}
										description={o.description}
										multiSelect={!!q.multiSelect}
										active={active}
										keyNumber={keyNum}
										recommended={isRecommended}
										onPick={() => onOptionClick(q.id, o.label, !!q.multiSelect)}
									/>
								);
							})}
							<div className={`question-other-row${currentCustom ? " active" : ""}`}>
								<span
									className="question-key-badge"
									title={otherKeyNum ? t("keyShortcutTip", { key: otherKeyNum }) : undefined}
								>
									{otherKeyNum ?? "✎"}
								</span>
								<input
									ref={otherInputRef}
									className="question-custom question-other-input"
									placeholder={effectiveOptions.length > 0 ? t("modelQuestionOther") : t("modelQuestionCustom")}
									value={customs[q.id] ?? ""}
									onChange={(e) => setCustoms((prev) => ({ ...prev, [q.id]: e.target.value }))}
									onCompositionEnd={imeGuard.onCompositionEnd}
									onKeyDown={(e) => {
										if (imeGuard.isImeKey(e.nativeEvent)) return;
										if (e.key === "Enter") {
											e.preventDefault();
											if (answered(q.id)) onNext();
										}
									}}
								/>
								<div className="question-other-actions">
									<button type="button" className="question-skip" onClick={onSkip}>
										{t("skip")}
									</button>
									<button type="button" className="dialog-submit" disabled={!answered(q.id)} onClick={onNext}>
										<span>{currentStep === total - 1 ? t("modelQuestionSubmitShort") : t("next")}</span>
										<FiCornerDownLeft className="question-submit-enter" aria-hidden="true" />
									</button>
								</div>
							</div>
						</div>
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
					</div>
					<div className="dialog-nav question-sub-bar">
						<button
							type="button"
							className={`dialog-dismiss-inline${hasRejectNote ? " reject-note" : ""}`}
							onClick={() => cancel(hasRejectNote ? rejectReason : undefined)}
							title={hasRejectNote ? t("modelQuestionRejectWithNoteTip") : t("cancel")}
						>
							{hasRejectNote ? t("modelQuestionRejectWithNote") : t("cancel")}
						</button>
						<label className="question-auto-submit">
							<input
								type="checkbox"
								checked={autoSubmitLast}
								onChange={(e) => {
									const enabled = e.target.checked;
									setAutoSubmitLast(enabled);
									try {
										localStorage.setItem("pi-web:question-auto-submit-last", enabled ? "1" : "0");
									} catch {}
								}}
							/>
							<span>{t("questionAutoSubmitLast")}</span>
							{autoSubmitLast && currentStep === total - 1 && !q.multiSelect && effectiveOptions.length > 0 && (
								<span className="question-auto-submit-hint">{t("questionPickSubmits")}</span>
							)}
						</label>
					</div>
				</>
			)}
		</div>
	);
}

function QuestionOption({
	label,
	description,
	multiSelect,
	active,
	keyNumber,
	recommended,
	onPick,
}: {
	label: string;
	description?: string;
	multiSelect: boolean;
	active: boolean;
	keyNumber?: number;
	recommended?: boolean;
	onPick: () => void;
}) {
	const rowRef = useRef<HTMLButtonElement>(null);
	const t = useT();
	return (
		<button type="button" ref={rowRef} className={`set-row question-option${active ? " active" : ""}`} onClick={onPick}>
			{keyNumber !== undefined && (
				<span className="question-key-badge" title={t("keyShortcutTip", { key: keyNumber })}>
					{keyNumber}
				</span>
			)}
			<div className="question-option-body">
				<div className="set-row-name">
					<Markdown text={label} rawHtml />
					{recommended && <span className="question-recommended-badge">{t("recommended")}</span>}
				</div>
				{description && (
					<>
						<div className="set-row-desc">
							<Markdown text={description} rawHtml />
						</div>
						<HoverDetail anchorRef={rowRef} enabled={hoverCapable()} className="question-desc-tip">
							<Markdown text={description} rawHtml />
						</HoverDetail>
					</>
				)}
			</div>
			{multiSelect && (
				<span className={`question-select-mark${active ? " active" : ""}`} aria-hidden="true">
					{active ? <FiCheck /> : null}
				</span>
			)}
		</button>
	);
}
