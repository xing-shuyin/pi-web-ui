import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FiAlertTriangle, FiCheck, FiCheckCircle, FiEdit3, FiLayers, FiX } from "react-icons/fi";
import { appSend } from "../app-globals";
import { isZhLocale, useI18n, useT } from "../i18n";
import { renderHighlightedCommand } from "../bash-danger";
import { questionWaitTime } from "../question-queue";
import type { UiToolApproval } from "../types";
import { PendingQueue } from "./PendingQueue";

interface ToolApprovalDialogProps {
	approval: UiToolApproval | null;
}

export function ToolApprovalDialog({
	approvals,
	activeConversationId,
	mode = "all",
}: {
	approvals: UiToolApproval[];
	activeConversationId?: string | null;
	mode?: "queue" | "all" | "manual";
}) {
	const t = useT();
	return (
		<PendingQueue
			items={approvals}
			itemKey={(item) => `${item.owner ?? "local"}:${item.id}`}
			title={t("toolApprovalTitle")}
			summary={(item) => (
				<>
					{item.conversationTitle && <strong>{item.conversationTitle} · </strong>}
					{item.toolName}
				</>
			)}
			createdAt={(item) => item.createdAt ?? 0}
			canAutoOpen={(item) =>
				mode !== "manual" &&
				(item.global || mode === "all" || item.conversationId === activeConversationId || !item.conversationId)
			}
			onNavigate={(item) => {
				if (item.conversationId)
					appSend(
						item.global && item.owner
							? { type: "open_shared_conversation", owner: item.owner, id: item.conversationId }
							: { type: "switch_conversation", id: item.conversationId },
					);
			}}
			canNavigate={(item) => !!item.conversationId}
		>
			{(approval, onDefer) => (
				<ApprovalDialog key={`${approval.owner ?? "local"}:${approval.id}`} approval={approval} onDefer={onDefer} />
			)}
		</PendingQueue>
	);
}

function ApprovalDialog({ approval, onDefer }: ToolApprovalDialogProps & { onDefer: () => void }) {
	const t = useT();
	const { locale } = useI18n();

	const [paramsText, setParamsText] = useState("");
	const [parseError, setParseError] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now);

	useEffect(() => {
		if (!approval?.createdAt) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [approval?.id, approval?.createdAt]);

	useEffect(() => {
		if (approval) {
			const p = approval.params;
			if (p !== null && p !== undefined && typeof p === "object") {
				setParamsText(JSON.stringify(p, null, 2));
			} else if (p === null || p === undefined) {
				setParamsText("{}");
			} else {
				setParamsText(String(p));
			}
			setParseError(null);
		}
	}, [approval?.id]);

	if (!approval) return null;

	const handleApprove = (scope?: "once" | "category" | "all") => {
		appSend({
			type: "tool_approval_response",
			id: approval.id,
			...(approval.owner ? { owner: approval.owner } : {}),
			...(approval.global ? { global: true } : {}),
			decision: "approve",
			...(scope && scope !== "once" ? { scope } : {}),
		});
	};

	const handleDeny = () => {
		appSend({
			type: "tool_approval_response",
			id: approval.id,
			...(approval.owner ? { owner: approval.owner } : {}),
			...(approval.global ? { global: true } : {}),
			decision: "deny",
			reason: "Operation rejected by user",
		});
	};

	const handleEditAndRun = () => {
		try {
			const p = approval.params;
			let edited: unknown;
			if (p !== null && p !== undefined && typeof p === "object") {
				edited = JSON.parse(paramsText);
			} else if (p === null || p === undefined) {
				edited = JSON.parse(paramsText);
			} else {
				edited = paramsText;
			}
			setParseError(null);
			appSend({
				type: "tool_approval_response",
				id: approval.id,
				...(approval.owner ? { owner: approval.owner } : {}),
				...(approval.global ? { global: true } : {}),
				decision: "edit",
				editedParams: edited,
			});
		} catch (err) {
			setParseError(
				isZhLocale(locale) ? `JSON 格式错误：${(err as Error).message}` : `JSON parse error: ${(err as Error).message}`,
			);
		}
	};

	return createPortal(
		<div className="modal-backdrop">
			<div
				className="tool-info-modal approval-modal"
				role="dialog"
				aria-modal="true"
				aria-label={t("toolApprovalTitle")}
				style={{ maxWidth: 640, borderTop: "4px solid var(--amber, #f59e0b)" }}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="tool-info-head">
					<span className="tool-info-title" style={{ color: "var(--amber, #f59e0b)" }}>
						<FiAlertTriangle />
						{t("toolApprovalTitle")}
					</span>
					<code className="tool-info-name" style={{ fontWeight: 700 }}>
						{approval.toolName}
					</code>
					{approval.parentTool === "codemode" && (
						<span
							className="tool-info-label"
							style={{
								backgroundColor: "rgba(245, 158, 11, 0.15)",
								color: "var(--amber, #f59e0b)",
								border: "1px solid rgba(245, 158, 11, 0.35)",
								fontWeight: 600,
							}}
						>
							⚡ {t("codemodeNestedApprovalBadge")}
						</span>
					)}
					{approval.conversationTitle && <span className="tool-info-label">{approval.conversationTitle}</span>}
					{approval.createdAt && questionWaitTime(approval.createdAt, now) && (
						<span className="question-queue-wait" style={{ marginLeft: "auto" }}>
							⏱ {questionWaitTime(approval.createdAt, now)}
						</span>
					)}
					<button type="button" className="btn" onClick={onDefer}>
						{t("pendingQueueDefer")}
					</button>
					<button type="button" className="btn" title={t("toolApprovalDeny")} onClick={handleDeny}>
						<FiX />
					</button>
				</div>

				<div className="tool-info-body" style={{ padding: "16px 20px" }}>
					{approval.parentTool === "codemode" && (
						<div
							style={{
								padding: "8px 12px",
								borderRadius: 6,
								backgroundColor: "rgba(99, 102, 241, 0.12)",
								border: "1px solid rgba(99, 102, 241, 0.25)",
								marginBottom: 12,
								color: "var(--text, #e2e8f0)",
								fontSize: 12.5,
								display: "flex",
								alignItems: "center",
								gap: 6,
							}}
						>
							<span style={{ fontSize: 14 }}>⚡</span>
							<span>{t("codemodeNestedApprovalDesc")}</span>
						</div>
					)}

					{(approval.reason || approval.reasonEn) && (
						<div
							style={{
								padding: "10px 14px",
								borderRadius: 6,
								backgroundColor: "rgba(245, 158, 11, 0.12)",
								border: "1px solid rgba(245, 158, 11, 0.3)",
								marginBottom: 16,
								color: "var(--amber, #f59e0b)",
								fontSize: 13,
								lineHeight: 1.5,
								fontWeight: 500,
							}}
						>
							<div style={{ fontWeight: 600, marginBottom: 2 }}>{t("toolApprovalRiskAlert")}:</div>
							<div>
								{isZhLocale(locale) ? approval.reason || approval.reasonEn : approval.reasonEn || approval.reason}
							</div>
							{approval.category && (
								<div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
									{t("toolApprovalCategory")}：
									{isZhLocale(locale) ? approval.category.label : approval.category.labelEn}
								</div>
							)}
							{approval.hits && approval.hits.length > 0 && (
								<div className="approval-hits-panel">
									<div className="approval-hits-title">
										{t("toolApprovalHitsTitle")} ({approval.hits.length})
									</div>
									<div className="approval-hits-list">
										{approval.hits.map((hit, idx) => (
											<div key={idx} className="approval-hit-item">
												<div className="approval-hit-header">
													<span className="approval-hit-badge">
														{isZhLocale(locale) ? hit.label : hit.labelEn || hit.label}
													</span>
													<span className="approval-hit-field">{hit.field}</span>
													<span className="approval-hit-pos">
														{t("approvalHitPos", { index: hit.index + 1, length: hit.length })}
													</span>
												</div>
												<div className="approval-hit-text">
													<mark className="approval-danger-hit">{hit.text}</mark>
												</div>
											</div>
										))}
									</div>
								</div>
							)}
						</div>
					)}

					{approval.toolName === "bash" && typeof (approval.params as any)?.command === "string" && (
						<div className="approval-cmd-preview">
							<div className="approval-cmd-preview-label">{t("approvalCommandPreview")}:</div>
							<div className="approval-cmd-preview-box">
								<span className="bashblock-prompt">$</span>
								<code>{renderHighlightedCommand((approval.params as any).command, approval.hits)}</code>
							</div>
						</div>
					)}

					<div style={{ marginBottom: 16 }}>
						<div
							style={{
								display: "flex",
								justifyContent: "space-between",
								alignItems: "center",
								marginBottom: 6,
							}}
						>
							<span style={{ fontSize: 13, fontWeight: 600, color: "var(--text, #e2e8f0)" }}>
								{t("toolApprovalParams")}
							</span>
							<span style={{ fontSize: 11, color: "var(--text-dim, #9aa1b4)" }}>
								{t("toolApprovalEditPlaceholder")}
							</span>
						</div>
						<textarea
							rows={8}
							value={paramsText}
							onChange={(e) => {
								setParamsText(e.target.value);
								if (parseError) setParseError(null);
							}}
							style={{
								width: "100%",
								fontFamily: "var(--mono, monospace)",
								fontSize: 12,
								lineHeight: 1.5,
								padding: 10,
								borderRadius: 6,
								backgroundColor: "var(--bg-elev, #111827)",
								color: "var(--text, #f8fafc)",
								border: parseError
									? "1px solid var(--red, #ef4444)"
									: "1px solid var(--border-subtle, rgba(255,255,255,0.1))",
								boxSizing: "border-box",
								resize: "vertical",
							}}
						/>
						{parseError && <div style={{ color: "var(--red, #ef4444)", fontSize: 12, marginTop: 4 }}>{parseError}</div>}
					</div>

					<div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 10 }}>
						{approval.category && (
							<button
								type="button"
								className="btn"
								title={t("toolApprovalAllowCategoryHint")}
								onClick={() => handleApprove("category")}
							>
								<FiLayers />
								{t("toolApprovalAllowCategory")}
							</button>
						)}
						<button
							type="button"
							className="btn"
							title={t("toolApprovalAllowConversationHint")}
							onClick={() => handleApprove("all")}
						>
							<FiCheckCircle />
							{t("toolApprovalAllowConversation")}
						</button>
						<button type="button" className="btn" style={{ color: "var(--red, #ef4444)" }} onClick={handleDeny}>
							<FiX />
							{t("toolApprovalDeny")}
						</button>
						<button type="button" className="btn" onClick={() => handleApprove()} style={{ fontWeight: 500 }}>
							<FiCheck />
							{t("toolApprovalApprove")}
						</button>
						<button
							type="button"
							className="btn btn-primary"
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 6,
								backgroundColor: "var(--amber, #f59e0b)",
								borderColor: "var(--amber, #f59e0b)",
								color: "#000",
								fontWeight: 600,
							}}
							onClick={handleEditAndRun}
						>
							<FiEdit3 />
							{t("toolApprovalEditAndRun")}
						</button>
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}
