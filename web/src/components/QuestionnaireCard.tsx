import { memo, useMemo } from "react";
import type { QuestionAnswer, UiQuestion, UiQuestionOption } from "../types";
import { useT } from "../i18n";
import { Markdown } from "./Markdown";
import { FiCheck, FiCornerDownRight, FiMessageSquare, FiX } from "react-icons/fi";

export interface QuestionnaireCardProps {
	questions: UiQuestion[];
	details?: unknown;
	output?: string;
	isError?: boolean;
	waiting?: boolean;
}

/** 从工具结果 details 或文本输出中安全提取 answers 列表 */
function extractAnswers(details: unknown, output?: string): Map<string, QuestionAnswer> {
	const map = new Map<string, QuestionAnswer>();
	const rawAnswers = (details as { answers?: unknown })?.answers;
	if (Array.isArray(rawAnswers)) {
		for (const a of rawAnswers) {
			if (a && typeof a.id === "string") {
				map.set(a.id, {
					id: a.id,
					selected: Array.isArray(a.selected) ? a.selected : [],
					custom: typeof a.custom === "string" ? a.custom : undefined,
				});
			}
		}
		if (map.size > 0) return map;
	}

	// 降级：从 output 文本按行提取
	// 格式：`${q.header ?? q.id}: ${label}${custom ? ` (wrote: ${custom})` : ""}`
	if (output && !output.includes("User cancelled")) {
		const lines = output.split("\n").filter((l) => l.trim());
		for (const line of lines) {
			const colon = line.indexOf(":");
			if (colon === -1) continue;
			const key = line.slice(0, colon).trim();
			const val = line.slice(colon + 1).trim();
			let selected: string[] = [];
			let custom: string | undefined;

			const wroteMatch = /\s*\(wrote:\s*(.*?)\)$/i.exec(val);
			let selPart = val;
			if (wroteMatch) {
				custom = wroteMatch[1];
				selPart = val.slice(0, wroteMatch.index).trim();
			}

			if (selPart && selPart !== "(no selection)") {
				selected = selPart
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
			}

			map.set(key, { id: key, selected, custom });
		}
	}

	return map;
}

/** 从取消错误信息中提取附言说明 */
function extractRejectReason(output?: string): string | undefined {
	if (!output) return undefined;
	const m = /(?:User note \/ 附言|附言)[：:]\s*([^\n\r]+)/.exec(output);
	return m ? m[1].trim() : undefined;
}

export const QuestionnaireCard = memo(function QuestionnaireCard({
	questions,
	details,
	output,
	isError = false,
	waiting = false,
}: QuestionnaireCardProps) {
	const t = useT();
	const answersMap = useMemo(() => extractAnswers(details, output), [details, output]);
	const rejectReason = useMemo(() => (isError ? extractRejectReason(output) : undefined), [isError, output]);

	return (
		<div className="qcard-wrap">
			{isError && (
				<div className="qcard-status qcard-status-cancelled">
					<span className="qcard-status-icon">
						<FiX />
					</span>
					<span className="qcard-status-text">{t("questionCardCancelled")}</span>
					{rejectReason && (
						<div className="qcard-reject-reason">
							<FiCornerDownRight className="qcard-note-icon" />
							<span>
								<strong>{t("questionCardRejectReason")}:</strong> {rejectReason}
							</span>
						</div>
					)}
				</div>
			)}

			{waiting && !isError && (
				<div className="qcard-status qcard-status-waiting">
					<span className="cursor" />
					<span className="qcard-status-text">{t("questionCardWaiting")}</span>
				</div>
			)}

			<div className="qcard-items">
				{questions.map((q, idx) => {
					const ans = answersMap.get(q.id) ?? answersMap.get(q.header ?? "");
					const selectedSet = new Set(ans?.selected ?? []);
					const hasAnswer = ans !== undefined;
					const options: UiQuestionOption[] = q.options ?? [];

					return (
						<div className="qcard-item" key={q.id}>
							<div className="qcard-header">
								<span className="qcard-idx">{idx + 1}</span>
								<span className="qcard-title">{q.header ?? `${t("modelQuestion")} ${idx + 1}`}</span>
							</div>

							<div className="qcard-question">
								<Markdown text={q.question} rawHtml />
							</div>

							{q.detail && (
								<div className="qcard-detail">
									<Markdown text={q.detail} rawHtml />
								</div>
							)}

							{options.length > 0 && (
								<div className="qcard-options">
									{options.map((opt, optIdx) => {
										const isSelected = selectedSet.has(opt.label);
										const isRecommended = opt.recommended ?? (optIdx === 0 && options.length > 1);

										return (
											<div
												className={`qcard-option${isSelected ? " selected" : ""}${
													hasAnswer && !isSelected ? " dimmed" : ""
												}`}
												key={opt.label}
											>
												<span className="qcard-opt-mark">
													{q.multiSelect ? (
														isSelected ? (
															<FiCheck className="qcard-check-icon" />
														) : (
															"☐"
														)
													) : isSelected ? (
														"●"
													) : (
														"○"
													)}
												</span>
												<div className="qcard-opt-content">
													<div className="qcard-opt-label">
														<Markdown text={opt.label} rawHtml />
														{isRecommended && <span className="question-recommended-badge">{t("recommended")}</span>}
													</div>
													{opt.description && (
														<div className="qcard-opt-desc">
															<Markdown text={opt.description} rawHtml />
														</div>
													)}
												</div>
											</div>
										);
									})}
								</div>
							)}

							{hasAnswer && selectedSet.size === 0 && !ans.custom && (
								<div className="qcard-empty-sel">{t("questionCardNoSelection")}</div>
							)}

							{ans?.custom && (
								<div className="qcard-custom-note">
									<FiMessageSquare className="qcard-note-icon" />
									<span className="qcard-custom-label">{t("questionCardUserCustom")}:</span>
									<span className="qcard-custom-text">{ans.custom}</span>
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
});
