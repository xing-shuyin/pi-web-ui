import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FiAlertTriangle, FiCheck, FiCheckCircle, FiEdit3, FiLayers, FiX } from "react-icons/fi";
import { appSend } from "../app-globals";
import { useI18n, useT } from "../i18n";
import { renderHighlightedCommand } from "../bash-danger";
import type { UiToolApproval } from "../types";

interface ToolApprovalDialogProps {
	approval: UiToolApproval | null;
}

/**
 * 人机协同拦截与「改写执行」（Human-in-the-Loop: Edit & Run）审批弹窗。
 *
 * 当工具拦截层（ToolGuard / 权限沙箱）识别到高危操作或关键文件修改时弹出，
 * 用户可选择：
 * 1. 「批准」（Approve）：放行原参数执行；
 * 2. 「拒绝」（Deny）：阻断执行并将拒绝原因返回模型；
 * 3. 「修改并放行」（Edit & Run）：就地修改工具参数后提交执行；
 * 4. 「本对话允许同类」（Allow this kind）：批准 + 记住本对话内该规则档位，后续同类不再问；
 * 5. 「本对话全部允许」（Allow all）：批准 + 本对话内后续全部不再问。
 *
 * 后两个只在内存里（服务重启/新对话即恢复询问），撤销入口在 设置 →「工具」页。
 */
export function ToolApprovalDialog({ approval }: ToolApprovalDialogProps) {
	const t = useT();
	const { locale } = useI18n();

	// 本地编辑的参数文本（JSON 字符串）
	const [paramsText, setParamsText] = useState("");
	const [parseError, setParseError] = useState<string | null>(null);

	useEffect(() => {
		if (approval) {
			// 审查 #8：显示与提交保持同一形态 —— 对象参数 pretty JSON（提交时 parse），
			// 空/缺失参数统一显示 "{}"（提交即 {}），字符串等原始值原样展示（提交时
			// 原样回传），避免 JSON.stringify 给字符串套引号造成「看到的不等于提交的」。
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
	}, [approval]);

	if (!approval) return null;

	const handleApprove = (scope?: "once" | "category" | "all") => {
		appSend({
			type: "tool_approval_response",
			id: approval.id,
			decision: "approve",
			...(scope && scope !== "once" ? { scope } : {}),
		});
	};

	const handleDeny = () => {
		appSend({
			type: "tool_approval_response",
			id: approval.id,
			decision: "deny",
			reason: "Operation rejected by user",
		});
	};

	const handleEditAndRun = () => {
		try {
			// 审查 #8：提交形态与显示形态一一对应。服务端把 editedParams 当 unknown
			// 直接作为 effectiveParams 执行（server/agent-service.ts `res.editedParams ?? params`），
			// 字符串原样回传、空参数提交 {} 均兼容。
			const p = approval.params;
			let edited: unknown;
			if (p !== null && p !== undefined && typeof p === "object") {
				edited = JSON.parse(paramsText);
			} else if (p === null || p === undefined) {
				// 显示为 "{}"（JSON 对象），未改动提交即 {}；用户改动按解析结果提交。
				edited = JSON.parse(paramsText);
			} else {
				edited = paramsText;
			}
			setParseError(null);
			appSend({
				type: "tool_approval_response",
				id: approval.id,
				decision: "edit",
				editedParams: edited,
			});
		} catch (err) {
			setParseError(`JSON 格式错误：${(err as Error).message}`);
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
					<button type="button" className="btn" title={t("toolApprovalDeny")} onClick={handleDeny}>
						<FiX />
					</button>
				</div>

				<div className="tool-info-body" style={{ padding: "16px 20px" }}>
					{/* 嵌套调用来源提示 */}
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

					{/* 风险告警原因 */}
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
							{/* 文案随界面语言定：服务端两种语言都带（reason/reasonEn），中文界面用
							    reason、其它语言用 reasonEn。之前写的是 `reason || reasonEn`，
							    reason 恒存在 → 非中文界面也显示中文风险说明。 */}
							<div>{locale === "zh" ? approval.reason || approval.reasonEn : approval.reasonEn || approval.reason}</div>
							{approval.category && (
								<div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
									{t("toolApprovalCategory")}：{locale === "zh" ? approval.category.label : approval.category.labelEn}
								</div>
							)}
							{/* 命中高危规则清单（issue #566） */}
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
														{locale === "zh" ? hit.label : hit.labelEn || hit.label}
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

					{/* 高危命令即时高亮定位（issue #566，针对 bash 命令在 JSON 转义之外提供直观定位） */}
					{approval.toolName === "bash" && typeof (approval.params as any)?.command === "string" && (
						<div className="approval-cmd-preview">
							<div className="approval-cmd-preview-label">{t("approvalCommandPreview")}:</div>
							<div className="approval-cmd-preview-box">
								<span className="bashblock-prompt">$</span>
								<code>{renderHighlightedCommand((approval.params as any).command, approval.hits)}</code>
							</div>
						</div>
					)}

					{/* 参数就地修改编辑区域 */}
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

					{/* 动作按钮组：本对话允许同类 / 本对话全部允许 / 拒绝 / 批准 / 修改并放行 */}
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
