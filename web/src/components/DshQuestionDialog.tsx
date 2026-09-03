import { useEffect, useState } from "react";
import type { ClientMessage } from "../types";
import { useT } from "../i18n";

interface DshQuestionDialogProps {
	question: {
		id: string;
		/** 服务端超时时间戳（epoch ms）——显示倒计时，归零自动取消。 */
		deadline?: number;
		questions: {
			id: string;
			question: string;
			detail?: string;
			header?: string;
			options?: { label: string; description?: string }[];
			multiSelect?: boolean;
		}[];
	};
	send: (msg: ClientMessage) => boolean;
}

/**
 * DSH 引擎的模型提问对话框（ask_user_question 工具 → question_pending 通知）。
 * 每道题：选项单选/多选 + 自由文本补充；提交 → question_answer，✗/Esc → 取消。
 * 复用 .dialog-inline 样式（非模态，对话保持可见）。
 */
export function DshQuestionDialog({ question, send }: DshQuestionDialogProps) {
	const t = useT();
	const [selections, setSelections] = useState<Record<string, string[]>>({});
	const [customs, setCustoms] = useState<Record<string, string>>({});
	// P0-6：倒计时（秒），归零自动取消提问（服务端同样超时 reject）。
	const [remainSec, setRemainSec] = useState<number>(() =>
		question.deadline ? Math.max(0, Math.ceil((question.deadline - Date.now()) / 1000)) : -1,
	);

	useEffect(() => {
		// 每个新提问重置本地状态。
		setSelections({});
		setCustoms({});
		setRemainSec(question.deadline ? Math.max(0, Math.ceil((question.deadline - Date.now()) / 1000)) : -1);
	}, [question.id, question.deadline]);

	useEffect(() => {
		if (!question.deadline) return;
		const id = setInterval(() => {
			setRemainSec((s) => {
				const next = Math.max(0, Math.ceil((question.deadline! - Date.now()) / 1000));
				if (next <= 0 && s > 0) {
					// 归零 → 自动取消（服务端超时 reject 模型提问，对话继续）。
					send({ type: "question_answer", id: question.id, answers: [], cancelled: true });
				}
				return next;
			});
		}, 1000);
		return () => clearInterval(id);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [question.id, question.deadline]);

	const respond = (cancelled: boolean) => {
		if (cancelled) {
			send({ type: "question_answer", id: question.id, answers: [], cancelled: true });
			return;
		}
		const answers = question.questions.map((q) => {
			const selected = selections[q.id] ?? [];
			const custom = (customs[q.id] ?? "").trim();
			return { id: q.id, selected, ...(custom ? { custom } : {}) };
		});
		send({ type: "question_answer", id: question.id, answers });
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") respond(true);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [question.id]);

	const toggleOption = (qid: string, label: string, multi: boolean) => {
		setSelections((prev) => {
			const cur = prev[qid] ?? [];
			if (!multi) return { ...prev, [qid]: [label] };
			return {
				...prev,
				[qid]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
			};
		});
	};

	const allAnswered = question.questions.every(
		(q) => (selections[q.id]?.length ?? 0) > 0 || (customs[q.id] ?? "").trim() !== "",
	);

	return (
		<div className="dialog-inline" data-dialog-kind="select">
			<div className="dialog-head">
				<span className="dialog-badge">{t("modelQuestion")}</span>
				{remainSec >= 0 && (
					<span className="question-timer">
						{remainSec > 0 ? t("questionTimeout", { s: remainSec }) : t("questionTimeoutExpired")}
					</span>
				)}
				<button type="button" className="dialog-dismiss" title={t("cancel")} onClick={() => respond(true)}>
					✕
				</button>
			</div>
			{question.questions.map((q, qi) => (
				<div className="set-section" key={q.id}>
					<div className="set-section-title">{q.header ?? `${t("modelQuestion")} ${qi + 1}`}</div>
					<p className="set-row-desc">{q.question}</p>
					{q.detail && <p className="set-hint">{q.detail}</p>}
					{(q.options?.length ?? 0) > 0 && (
						<div className="set-list">
							{q.options!.map((o) => {
								const active = (selections[q.id] ?? []).includes(o.label);
								return (
									<button
										type="button"
										key={o.label}
										className={`set-row question-option${active ? " active" : ""}`}
										onClick={() => toggleOption(q.id, o.label, !!q.multiSelect)}
									>
										<span className="set-row-name">
											{q.multiSelect ? (active ? "☑ " : "☐ ") : active ? "● " : "○ "}
											{o.label}
										</span>
										{o.description && <span className="set-row-desc">{o.description}</span>}
									</button>
								);
							})}
						</div>
					)}
					<input
						className="set-prompt-input question-custom"
						placeholder={t("modelQuestionCustom")}
						value={customs[q.id] ?? ""}
						onChange={(e) => setCustoms((prev) => ({ ...prev, [q.id]: e.target.value }))}
					/>
				</div>
			))}
			<div className="dialog-actions">
				<button type="button" className="dialog-submit" disabled={!allAnswered} onClick={() => respond(false)}>
					{t("modelQuestionSubmit")}
				</button>
				<button type="button" className="dialog-dismiss-inline" onClick={() => respond(true)}>
					{t("cancel")}
				</button>
			</div>
		</div>
	);
}
