import { useState } from "react";
import { FiChevronDown, FiChevronUp, FiEdit3, FiPlus, FiRefreshCw, FiShield, FiTrash2 } from "react-icons/fi";
import { appSend } from "../../app-globals";
import { isZhLocale, useI18n, useT } from "../../i18n";
import { useEscapeKey } from "../../shortcut-stack";
import type { UiApprovalRule } from "../../types";
import { randomUuid } from "../../uuid";
import { HintTip } from "../HintTip";
import { FieldRow } from "./FieldRow";

/** 设置页「工具审批规则」Tab：独立管理规则草稿、校验、排序与重置。 */
export function ApprovalRulesTab({ approvalRules }: { approvalRules?: UiApprovalRule[] }) {
	const t = useT();
	const { locale } = useI18n();
	const rules = approvalRules ?? [];

	const [ruleDraft, setRuleDraft] = useState<UiApprovalRule | null>(null);
	const [ruleIsNew, setRuleIsNew] = useState(false);
	const [ruleToolsText, setRuleToolsText] = useState("");
	const [ruleError, setRuleError] = useState<string | null>(null);
	const [confirmRuleDelete, setConfirmRuleDelete] = useState<string | null>(null);
	const [confirmRuleReset, setConfirmRuleReset] = useState<string | null>(null);

	useEscapeKey(() => {
		setRuleDraft(null);
		setRuleError(null);
	}, Boolean(ruleDraft));

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiShield className="set-section-icon" />
				{t("settingsApprovalRules")}
				<HintTip text={t("settingsApprovalRulesDesc")} />
				<span className="set-count">{rules.length}</span>
				<button
					type="button"
					className="set-save-btn"
					title={t("approvalRuleNew")}
					onClick={() => {
						setRuleDraft({
							id: `custom.${randomUuid().slice(0, 8)}`,
							enabled: true,
							tools: ["bash"],
							field: "command",
							match: "regex",
							value: "",
							action: "ask",
							label: "",
							labelEn: "",
							reason: "",
							reasonEn: "",
						});
						setRuleToolsText("bash");
						setRuleIsNew(true);
						setRuleError(null);
					}}
				>
					<FiPlus /> {t("approvalRuleNew")}
				</button>
			</div>

			{ruleDraft && (
				<div className="rule-editor">
					<div className="set-section-title" style={{ fontSize: 13, marginBottom: 4 }}>
						{ruleIsNew ? t("approvalRuleNew") : `${t("approvalRuleEdit")} · ${ruleDraft.label}`}
					</div>
					<FieldRow label={t("approvalRuleLabel")}>
						<input
							className="set-input"
							value={ruleDraft.label}
							placeholder={t("approvalRuleLabelPlaceholder")}
							onChange={(e) => setRuleDraft({ ...ruleDraft, label: e.target.value })}
						/>
					</FieldRow>
					<FieldRow label={t("approvalRuleLabelEn")}>
						<input
							className="set-input"
							value={ruleDraft.labelEn ?? ""}
							placeholder="e.g. Block dangerous Docker commands"
							onChange={(e) => setRuleDraft({ ...ruleDraft, labelEn: e.target.value })}
						/>
					</FieldRow>
					<FieldRow label={t("approvalRuleTools")} tip={t("approvalRuleToolsTip")}>
						<input
							className="set-input"
							value={ruleToolsText}
							placeholder={t("approvalRuleToolsPlaceholder")}
							onChange={(e) => {
								setRuleToolsText(e.target.value);
								const arr = e.target.value
									.split(",")
									.map((x) => x.trim().toLowerCase())
									.filter(Boolean);
								setRuleDraft({ ...ruleDraft, tools: arr.length > 0 ? arr : ["*"] });
							}}
						/>
					</FieldRow>
					<div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
						<div style={{ flex: 1, minWidth: 160 }}>
							<FieldRow label={t("approvalRuleField")}>
								<select
									className="set-select"
									value={ruleDraft.field}
									onChange={(e) =>
										setRuleDraft({
											...ruleDraft,
											field: e.target.value as "command" | "path" | "params",
										})
									}
								>
									<option value="command">{t("approvalRuleFieldCommand")}</option>
									<option value="path">{t("approvalRuleFieldPath")}</option>
									<option value="params">{t("approvalRuleFieldParams")}</option>
								</select>
							</FieldRow>
						</div>
						<div style={{ flex: 1, minWidth: 160 }}>
							<FieldRow label={t("approvalRuleMatch")}>
								<select
									className="set-select"
									value={ruleDraft.match}
									onChange={(e) =>
										setRuleDraft({
											...ruleDraft,
											match: e.target.value as "regex" | "glob" | "contains" | "prefix" | "outside_workspace",
										})
									}
								>
									<option value="regex">{t("approvalRuleMatchRegex")}</option>
									<option value="glob">{t("approvalRuleMatchGlob")}</option>
									<option value="contains">{t("approvalRuleMatchContains")}</option>
									<option value="prefix">{t("approvalRuleMatchPrefix")}</option>
									<option value="outside_workspace">{t("approvalRuleMatchOutsideWs")}</option>
								</select>
							</FieldRow>
						</div>
						<div style={{ flex: 1, minWidth: 160 }}>
							<FieldRow label={t("approvalRuleActionLabel")}>
								<select
									className="set-select"
									value={ruleDraft.action}
									onChange={(e) =>
										setRuleDraft({
											...ruleDraft,
											action: e.target.value as "ask" | "deny" | "allow",
										})
									}
								>
									<option value="ask">{t("approvalRuleActionAsk")}</option>
									<option value="deny">{t("approvalRuleActionDeny")}</option>
									<option value="allow">{t("approvalRuleActionAllow")}</option>
								</select>
							</FieldRow>
						</div>
					</div>
					{ruleDraft.match !== "outside_workspace" && (
						<FieldRow label={t("approvalRuleValue")} tip={t("approvalRuleValueTip")}>
							<input
								className="set-input"
								value={ruleDraft.value}
								placeholder={t("approvalRuleValuePlaceholder")}
								onChange={(e) => setRuleDraft({ ...ruleDraft, value: e.target.value })}
							/>
						</FieldRow>
					)}
					<FieldRow label={t("approvalRuleReason")}>
						<input
							className="set-input"
							value={ruleDraft.reason ?? ""}
							placeholder={t("approvalRuleReasonPlaceholder")}
							onChange={(e) => setRuleDraft({ ...ruleDraft, reason: e.target.value })}
						/>
					</FieldRow>
					<FieldRow label={t("approvalRuleReasonEn")}>
						<input
							className="set-input"
							value={ruleDraft.reasonEn ?? ""}
							placeholder="e.g. Detected docker image/container removal"
							onChange={(e) => setRuleDraft({ ...ruleDraft, reasonEn: e.target.value })}
						/>
					</FieldRow>
					<div className="set-row">
						<label className="set-checkbox-label" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
							<input
								type="checkbox"
								checked={ruleDraft.enabled}
								onChange={(e) => setRuleDraft({ ...ruleDraft, enabled: e.target.checked })}
							/>
							{t("approvalRuleEnabled")}
						</label>
					</div>
					{ruleError && <div style={{ color: "var(--red, #ef4444)", fontSize: 12 }}>{ruleError}</div>}
					<div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
						<button
							type="button"
							className="btn"
							onClick={() => {
								setRuleDraft(null);
								setRuleError(null);
							}}
						>
							{t("cancel")}
						</button>
						<button
							type="button"
							className="btn btn-primary"
							onClick={() => {
								if (!ruleDraft.label.trim()) {
									setRuleError(t("approvalRuleLabelRequired"));
									return;
								}
								if (ruleDraft.match === "regex") {
									try {
										new RegExp(ruleDraft.value);
									} catch (err) {
										setRuleError(t("approvalRuleRegexInvalid", { msg: (err as Error).message }));
										return;
									}
								}
								appSend({ type: "save_approval_rule", rule: ruleDraft });
								setRuleDraft(null);
								setRuleError(null);
							}}
						>
							{t("save")}
						</button>
					</div>
				</div>
			)}

			{rules.length === 0 ? (
				<p className="set-hint">{t("approvalRuleEmpty")}</p>
			) : (
				<div className="set-list set-list-flat">
					{rules.map((rule, idx) => {
						const isBuiltin = rule.builtin === true;
						return (
							<div
								className={`set-row${rule.enabled ? "" : " rule-row-disabled"}`}
								key={rule.id}
								style={{ alignItems: "flex-start", padding: "12px 0" }}
							>
								<div className="set-row-info">
									<div
										className="set-row-name"
										style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}
									>
										<span className={`rule-badge ${rule.action}`}>
											{rule.action === "deny"
												? t("approvalRuleActionDeny")
												: rule.action === "allow"
													? t("approvalRuleActionAllow")
													: t("approvalRuleActionAsk")}
										</span>
										<strong style={{ fontSize: 13 }}>
											{isZhLocale(locale) ? rule.label : rule.labelEn || rule.label}
										</strong>
										{isBuiltin && <span className="tpl-badge">{t("approvalRuleBuiltin")}</span>}
										<span className="rule-meta-code">{rule.tools.join(", ")}</span>
									</div>
									<div className="set-hint" style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
										<div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
											<span style={{ opacity: 0.85, fontSize: 11, fontFamily: "var(--mono)" }}>
												[{rule.field} · {rule.match}]
											</span>
											{rule.match !== "outside_workspace" && <code className="rule-pattern-code">{rule.value}</code>}
										</div>
										{(rule.reason || rule.reasonEn) && (
											<div style={{ opacity: 0.75, fontSize: 11 }}>
												{isZhLocale(locale) ? rule.reason : rule.reasonEn || rule.reason}
											</div>
										)}
									</div>
								</div>
								<div className="set-row-actions" style={{ marginLeft: 12, flexShrink: 0 }}>
									<button
										type="button"
										className={`set-switch${rule.enabled ? " on" : ""}`}
										role="switch"
										aria-checked={rule.enabled}
										title={rule.enabled ? t("settingsEnabled") : t("settingsDisabled")}
										onClick={() =>
											appSend({
												type: "save_approval_rule",
												rule: { ...rule, enabled: !rule.enabled },
											})
										}
									>
										<span className="set-switch-knob" />
									</button>
									{!isBuiltin && idx > 0 && (
										<button
											type="button"
											className="set-icon-btn"
											title={t("approvalRuleMoveUp")}
											onClick={() => {
												const list = [...rules];
												const temp = list[idx - 1];
												list[idx - 1] = list[idx];
												list[idx] = temp;
												appSend({ type: "save_approval_rules", rules: list });
											}}
										>
											<FiChevronUp />
										</button>
									)}
									{!isBuiltin && idx < rules.length - 1 && (
										<button
											type="button"
											className="set-icon-btn"
											title={t("approvalRuleMoveDown")}
											onClick={() => {
												const list = [...rules];
												const temp = list[idx + 1];
												list[idx + 1] = list[idx];
												list[idx] = temp;
												appSend({ type: "save_approval_rules", rules: list });
											}}
										>
											<FiChevronDown />
										</button>
									)}
									{isBuiltin &&
										(confirmRuleReset === rule.id ? (
											<button
												type="button"
												className="set-uninstall confirm"
												onClick={() => {
													appSend({ type: "reset_builtin_approval_rule", id: rule.id });
													setConfirmRuleReset(null);
												}}
											>
												{t("uninstallConfirm")}
											</button>
										) : (
											<button
												type="button"
												className="set-icon-btn"
												title={t("approvalRuleReset")}
												onClick={() => setConfirmRuleReset(rule.id)}
											>
												<FiRefreshCw />
											</button>
										))}
									<button
										type="button"
										className="set-icon-btn"
										title={t("approvalRuleEdit")}
										onClick={() => {
											setRuleDraft({ ...rule });
											setRuleToolsText(rule.tools.join(", "));
											setRuleIsNew(false);
											setRuleError(null);
										}}
									>
										<FiEdit3 />
									</button>
									{!isBuiltin &&
										(confirmRuleDelete === rule.id ? (
											<button
												type="button"
												className="set-uninstall confirm"
												onClick={() => {
													appSend({ type: "delete_approval_rule", id: rule.id });
													setConfirmRuleDelete(null);
												}}
											>
												{t("uninstallConfirm")}
											</button>
										) : (
											<button
												type="button"
												className="set-icon-btn danger"
												title={t("approvalRuleDelete")}
												onClick={() => setConfirmRuleDelete(rule.id)}
											>
												<FiTrash2 />
											</button>
										))}
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
