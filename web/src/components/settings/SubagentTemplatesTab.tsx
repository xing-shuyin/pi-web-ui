import { useState } from "react";
import { FiPlus, FiTrash2, FiUsers } from "react-icons/fi";
import { appSend } from "../../app-globals";
import { isZhLocale, useI18n, useT } from "../../i18n";
import { useEscapeKey } from "../../shortcut-stack";
import type { UiSettingsState, UiSubagentTemplate } from "../../types";
import { HintTip } from "../HintTip";
import { SubagentTemplateWizard } from "../SubagentTemplateWizard";
import { FieldRow } from "./FieldRow";

type SubagentSettingsSlice = Pick<
	UiSettingsState,
	| "subagentTemplates"
	| "subagentDefaultModel"
	| "subagentModels"
	| "subagentMaxDepth"
	| "subagentAutoWakeMaxTurns"
	| "subagentDefaultTemplates"
	| "skills"
	| "extensions"
>;

/** 设置页「子代理模板」Tab：管理子代理默认参数与模板向导。 */
export function SubagentTemplatesTab({
	settings,
	engine,
	onPatch,
}: {
	settings: SubagentSettingsSlice;
	engine: string;
	onPatch: (
		patch: Partial<Pick<UiSettingsState, "subagentDefaultModel" | "subagentMaxDepth" | "subagentAutoWakeMaxTurns">>,
	) => void;
}) {
	const t = useT();
	const { locale } = useI18n();
	const tt = (k: string) => t(k as Parameters<typeof t>[0]);

	const [tplDraft, setTplDraft] = useState<UiSubagentTemplate | null>(null);
	const [tplIsNew, setTplIsNew] = useState(false);
	const [confirmTplDelete, setConfirmTplDelete] = useState<string | null>(null);

	useEscapeKey(() => setTplDraft(null), Boolean(tplDraft));

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiUsers className="set-section-icon" />
				{t("settingsSubagentTemplates")}
				<HintTip text={t("settingsSubagentTemplatesDesc")} />
				<span className="set-count">{settings.subagentTemplates.length}</span>
				<button
					type="button"
					className="set-save-btn"
					title={t("subagentTemplateNew")}
					onClick={() => {
						setTplDraft({
							name: "",
							description: "",
							promptMode: "replace",
							systemPrompt: "",
							enabledSkills: [],
							enabledExtensions: [],
							model: "",
							thinkingLevel: "",
							enabled: true,
							// 新建模板显式定为常规：不让名字里的 explore / review 把用户新写的模板悄悄锁成只读
							securityMode: "normal" as const,
						});
						setTplIsNew(true);
					}}
				>
					<FiPlus /> {t("subagentTemplateNew")}
				</button>
			</div>

			<FieldRow label={t("subagentDefaultModelLabel")} tip={t("subagentDefaultModelHint")}>
				<select
					className="set-select"
					value={settings.subagentDefaultModel ?? ""}
					onChange={(e) => onPatch({ subagentDefaultModel: e.target.value || null })}
				>
					<option value="">{t("subagentFollowMain")}</option>
					{settings.subagentModels.map((m) => (
						<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
							{m.label}
						</option>
					))}
				</select>
			</FieldRow>
			{settings.subagentModels.length === 0 && <p className="set-hint">{t("subagentNoModels")}</p>}
			{engine === "pi" && (
				<>
					<FieldRow label={t("subagentMaxDepth")} tip={t("subagentMaxDepthDesc")}>
						<select
							className="set-select"
							value={settings.subagentMaxDepth ?? 0}
							onChange={(e) => onPatch({ subagentMaxDepth: Number(e.target.value) })}
						>
							<option value={0}>{t("subagentMaxDepthUnlimited")}</option>
							{[...new Set([1, 2, 3, 4, 5, settings.subagentMaxDepth ?? 0])]
								.filter((n) => n > 0)
								.map((n) => (
									<option key={n} value={n}>
										{n}
									</option>
								))}
						</select>
					</FieldRow>
					<FieldRow label={t("subagentAutoWakeMaxTurns")} tip={t("subagentAutoWakeMaxTurnsDesc")}>
						<select
							className="set-select"
							value={settings.subagentAutoWakeMaxTurns ?? 5}
							onChange={(e) => onPatch({ subagentAutoWakeMaxTurns: Number(e.target.value) })}
						>
							<option value={0}>{t("subagentAutoWakeMaxTurnsUnlimited")}</option>
							{[...new Set([1, 2, 3, 5, 8, 10, 15, 20, settings.subagentAutoWakeMaxTurns ?? 5])]
								.filter((n) => n > 0)
								.sort((a, b) => a - b)
								.map((n) => (
									<option key={n} value={n}>
										{n}
									</option>
								))}
						</select>
					</FieldRow>
				</>
			)}

			{tplDraft && (
				<SubagentTemplateWizard
					draft={tplDraft}
					isNew={tplIsNew}
					skills={settings.skills}
					extensions={settings.extensions}
					models={settings.subagentModels}
					onChange={setTplDraft}
					onClose={() => setTplDraft(null)}
					onSave={(d) => {
						appSend({ type: "save_subagent_template", template: d });
						setTplDraft(null);
					}}
				/>
			)}

			{settings.subagentTemplates.length === 0 ? (
				<p className="set-empty">{t("noSubagentTemplates")}</p>
			) : (
				<div className="set-list set-list-flat">
					{settings.subagentTemplates.map((tp) => (
						<div className="set-row" key={tp.name}>
							<div className="set-row-info">
								<div className="set-row-name">
									{tp.name}
									{settings.subagentDefaultTemplates.includes(tp.name) && (
										<span className="tpl-badge default">{t("tplDefaultBadge")}</span>
									)}
									{!tp.enabled && <span className="tpl-badge">{t("subagentTemplateClosed")}</span>}
									{tp.securityMode === "readonly" && (
										<span className="tpl-badge secure">{t("tplSecurityBadgeReadonly")}</span>
									)}
									{tp.securityMode === "verify" && (
										<span className="tpl-badge secure">{t("tplSecurityBadgeVerify")}</span>
									)}
								</div>
								<div className="set-row-desc">
									{(!isZhLocale(locale) && tp.descriptionEn ? tp.descriptionEn : tp.description) ||
										`${tp.promptMode === "replace" ? t("promptModeReplace") : t("promptModeAppend")}`}
									{tp.model ? ` · ${t("tplModelLabel")} ${tp.model}` : ` · ${t("subagentFollowMain")}`}
									{tp.thinkingLevel ? ` · ${t("tplThinkingLabel")} ${tt(`thinking.${tp.thinkingLevel}`)}` : ""}
									{tp.enabledSkills.length > 0 && ` · ${t("tplSkillsLabel")} ${tp.enabledSkills.length}`}
									{tp.enabledExtensions.length > 0 && ` · ${t("tplExtensionsLabel")} ${tp.enabledExtensions.length}`}
									{!tp.description &&
										tp.enabledSkills.length === 0 &&
										tp.enabledExtensions.length === 0 &&
										` · ${t("tplInherit")}`}
								</div>
							</div>
							<div className="set-row-actions">
								<button
									type="button"
									className={`set-switch${tp.enabled ? " on" : ""}`}
									role="switch"
									aria-checked={tp.enabled}
									title={`${tp.enabled ? t("subagentTemplateDisable") : t("subagentTemplateEnable")} · ${t(
										"subagentTemplateOffHint",
									)}`}
									onClick={() => appSend({ type: "save_subagent_template", template: { ...tp, enabled: !tp.enabled } })}
								>
									<span className="set-switch-knob" />
								</button>
								<button
									type="button"
									className="set-uninstall"
									title={t("subagentTemplateEdit")}
									onClick={() => {
										setTplDraft({ ...tp });
										setTplIsNew(false);
									}}
								>
									{t("subagentTemplateEdit")}
								</button>
								{confirmTplDelete === tp.name ? (
									<button
										type="button"
										className="set-uninstall confirm"
										title={t("uninstallConfirmHint")}
										onClick={() => {
											appSend({ type: "delete_subagent_template", name: tp.name });
											setConfirmTplDelete(null);
										}}
									>
										{t("uninstallConfirm")}
									</button>
								) : (
									<button
										type="button"
										className="set-icon-btn danger"
										title={t("tplDelete")}
										onClick={() => setConfirmTplDelete(tp.name)}
									>
										<FiTrash2 />
									</button>
								)}
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
