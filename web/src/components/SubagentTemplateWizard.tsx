import { useEffect, useState } from "react";
import { FiCheck, FiChevronDown, FiSearch, FiUsers, FiX } from "react-icons/fi";
import { useI18n, useT } from "../i18n";
import { isZhLocale } from "../pick-locale.js";
import { THINKING_VALUES } from "../thinking-levels";
import type { UiExtensionInfo, UiSkillInfo, UiSubagentTemplate, UiVisionBridgeModel } from "../types";
import { HintTip } from "./HintTip";

export interface SubagentTemplateWizardProps {
	draft: UiSubagentTemplate;
	isNew: boolean;
	skills: UiSkillInfo[];
	extensions: UiExtensionInfo[];
	models: UiVisionBridgeModel[];
	onChange: (draft: UiSubagentTemplate) => void;
	onClose: () => void;
	onSave: (draft: UiSubagentTemplate) => void;
}

const STEP_COUNT = 4;
const stepMeta = (step: number) => {
	switch (step) {
		case 0:
			return { title: "tplStepIdentity", sub: "tplStepIdentitySub" };
		case 1:
			return { title: "tplStepBehavior", sub: "tplStepBehaviorSub" };
		case 2:
			return { title: "tplStepCapability", sub: "tplStepCapabilitySub" };
		default:
			return { title: "tplStepReview", sub: "tplStepReviewSub" };
	}
};

export function SubagentTemplateWizard({
	draft,
	isNew,
	skills,
	extensions,
	models,
	onChange,
	onClose,
	onSave,
}: SubagentTemplateWizardProps) {
	const { locale } = useI18n();
	const t = useT();
	const tt = (key: string) => t(key as Parameters<typeof t>[0]);
	const [step, setStep] = useState(0);
	const [query, setQuery] = useState("");
	const [enIntroOpen, setEnIntroOpen] = useState(Boolean(draft.descriptionEn));
	const [enPromptOpen, setEnPromptOpen] = useState(Boolean(draft.systemPromptEn));

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const nameMissing = !draft.name.trim();
	// 第 1 步的「模板名」是唯一必填校验：没填时不能跨过第 1 步。
	const canGoStep = (target: number) => target <= step || target === 0 || !nameMissing;

	const q = query.trim().toLowerCase();
	const skillList = skills.filter((s) => !q || s.name.toLowerCase().includes(q));
	const extList = extensions.filter((x) => !q || x.name.toLowerCase().includes(q));
	const skillLimited = draft.enabledSkills.length > 0;
	const extLimited = draft.enabledExtensions.length > 0;
	const modelLabel = models.find((m) => `${m.provider}/${m.id}` === draft.model)?.label ?? draft.model;
	const modeText = draft.promptMode === "replace" ? t("promptModeReplace") : t("promptModeAppend");
	const introText = draft.description.trim() || t("tplEnEmpty");
	const thinkingText = draft.thinkingLevel ? tt(`thinking.${draft.thinkingLevel}`) : t("tplThinkingFollowMain");

	const spawnCode = (() => {
		const parts: string[] = [];
		if (draft.name.trim()) parts.push(`template="${draft.name.trim()}"`);
		if (draft.model) parts.push(`model="${draft.model}"`);
		if (draft.thinkingLevel) parts.push(`thinking="${draft.thinkingLevel}"`);
		return `subagent_spawn(${parts.join(", ")})`;
	})();

	const patch = (partial: Partial<UiSubagentTemplate>) => onChange({ ...draft, ...partial });
	const toggleIn = (list: string[], value: string, on: boolean) =>
		on ? [...list, value] : list.filter((v) => v !== value);

	return (
		<div className="modal-backdrop tpl-modal-backdrop" onClick={onClose}>
			<div className="modal tpl-modal" onClick={(e) => e.stopPropagation()}>
				<button type="button" className="modal-close" aria-label={t("close")} onClick={onClose}>
					<FiX />
				</button>
				<div className="modal-head">
					<FiUsers className="modal-head-icon" />
					<h2>{isNew ? t("subagentTemplateNew") : `${t("subagentTemplateEdit")} · ${draft.name}`}</h2>
				</div>
				<div className="modal-body">
					<div className="tpl-wiz">
						<aside className="tpl-rail">
							{Array.from({ length: STEP_COUNT }, (_, i) => {
								const meta = stepMeta(i);
								const locked = i > step && !canGoStep(i);
								return (
									<button
										key={i}
										type="button"
										className={`tpl-rail-step${i === step ? " on" : ""}${i < step ? " done" : ""}${locked ? " locked" : ""}`}
										onClick={() => canGoStep(i) && setStep(i)}
									>
										<span className="tpl-rail-num">{`0${i + 1}`}</span>
										<span className="tpl-rail-txt">
											<b>{t(meta.title as Parameters<typeof t>[0])}</b>
											<i>{t(meta.sub as Parameters<typeof t>[0])}</i>
										</span>
										<FiCheck className="tpl-rail-check" />
									</button>
								);
							})}
						</aside>
						<div className="tpl-body">
							{step === 0 && (
								<div className="tpl-panel">
									<p className="tpl-panel-note">{t("tplIdentityHint")}</p>
									<input
										className="set-input"
										placeholder={t("tplNamePlaceholder")}
										value={draft.name}
										onChange={(e) => patch({ name: e.target.value })}
									/>
									{nameMissing && <p className="tpl-required-err">{t("tplNameRequired")}</p>}
									<input
										className="set-input"
										placeholder={t("tplDescriptionPlaceholder")}
										value={draft.description}
										onChange={(e) => patch({ description: e.target.value })}
									/>
									<div className="tpl-collap">
										<button
											type="button"
											className="tpl-collap-head"
											aria-expanded={enIntroOpen}
											onClick={() => setEnIntroOpen((v) => !v)}
										>
											<FiChevronDown className="tpl-chev" />
											{t("tplAdvanced")}
											<span className="tpl-collap-sub">
												{t("tplEnIntro")} · {draft.descriptionEn ? t("tplEnFilled") : t("tplEnEmpty")}
											</span>
										</button>
										{enIntroOpen && (
											<div className="tpl-collap-body">
												<input
													className="set-input"
													placeholder={t("tplDescriptionEnPlaceholder")}
													value={draft.descriptionEn ?? ""}
													onChange={(e) => patch({ descriptionEn: e.target.value })}
												/>
											</div>
										)}
									</div>
								</div>
							)}

							{step === 1 && (
								<div className="tpl-panel">
									<div className="set-mode-row">
										<label className="set-field-label">{t("tplPromptModeLabel")}</label>
										<select
											className="set-select"
											value={draft.promptMode}
											onChange={(e) => patch({ promptMode: e.target.value as "append" | "replace" })}
										>
											<option value="replace">{t("promptModeReplace")}</option>
											<option value="append">{t("promptModeAppend")}</option>
										</select>
									</div>
									<div className="set-mode-row">
										<label className="set-field-label">{t("tplModelLabel")}</label>
										<select
											className="set-select"
											value={draft.model ?? ""}
											onChange={(e) => patch({ model: e.target.value })}
										>
											<option value="">{t("subagentFollowMain")}</option>
											{models.map((m) => (
												<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
													{m.label}
												</option>
											))}
										</select>
									</div>
									<div className="set-mode-row">
										<label className="set-field-label">
											{t("tplThinkingLabel")} <HintTip text={t("tplThinkingHint")} />
										</label>
										<select
											className="set-select"
											value={draft.thinkingLevel ?? ""}
											onChange={(e) => patch({ thinkingLevel: e.target.value })}
										>
											<option value="">{t("tplThinkingFollowMain")}</option>
											{THINKING_VALUES.map((v) => (
												<option key={v} value={v}>
													{tt(`thinking.${v}`)}
												</option>
											))}
										</select>
									</div>
									<textarea
										className="set-prompt-input"
										rows={5}
										placeholder={`${t("tplSystemPromptLabel")}${isZhLocale(locale) ? "：" : ": "}${t("tplSystemPromptPlaceholder")}`}
										value={draft.systemPrompt}
										onChange={(e) => patch({ systemPrompt: e.target.value })}
									/>
									<div className="tpl-collap">
										<button
											type="button"
											className="tpl-collap-head"
											aria-expanded={enPromptOpen}
											onClick={() => setEnPromptOpen((v) => !v)}
										>
											<FiChevronDown className="tpl-chev" />
											{t("tplAdvanced")}
											<span className="tpl-collap-sub">
												{t("tplEnPrompt")} · {draft.systemPromptEn ? t("tplEnFilled") : t("tplEnEmpty")}
											</span>
										</button>
										{enPromptOpen && (
											<div className="tpl-collap-body">
												<textarea
													className="set-prompt-input"
													rows={4}
													placeholder={`${t("tplSystemPromptLabel")}: ${t("tplSystemPromptEnPlaceholder")}`}
													value={draft.systemPromptEn ?? ""}
													onChange={(e) => patch({ systemPromptEn: e.target.value })}
												/>
											</div>
										)}
									</div>
								</div>
							)}

							{step === 2 && (
								<div className="tpl-panel">
									<div className="tpl-search">
										<FiSearch className="tpl-search-icon" />
										<input
											className="set-input"
											placeholder={t("tplSearchWhitelist")}
											value={query}
											onChange={(e) => setQuery(e.target.value)}
										/>
									</div>
									<div className="tpl-pick-block">
										<div className="tpl-pick-head">
											<span>
												{t("tplSkillsLabel")} · {draft.enabledSkills.length}
											</span>
											<span className={`tpl-wstatus${skillLimited ? "" : " follow"}`}>
												{skillLimited ? t("tplLimited", { n: draft.enabledSkills.length }) : t("tplFollowSession")}
											</span>
										</div>
										<p className="set-hint">{t("tplWhitelistHint")}</p>
										{skills.length === 0 ? (
											<p className="set-hint">{t("noSkills")}</p>
										) : skillList.length === 0 ? (
											<p className="tpl-nohit">{t("tplNoMatch")}</p>
										) : (
											<div className="tpl-pick">
												{skillList.map((s) => (
													<label
														key={s.name}
														className={`tpl-chip${draft.enabledSkills.includes(s.name) ? " on" : ""}`}
													>
														<input
															type="checkbox"
															checked={draft.enabledSkills.includes(s.name)}
															onChange={(e) =>
																patch({ enabledSkills: toggleIn(draft.enabledSkills, s.name, e.target.checked) })
															}
														/>
														{s.name}
													</label>
												))}
											</div>
										)}
									</div>
									<div className="tpl-pick-block">
										<div className="tpl-pick-head">
											<span>
												{t("tplExtensionsLabel")} · {draft.enabledExtensions.length}
											</span>
											<span className={`tpl-wstatus${extLimited ? "" : " follow"}`}>
												{extLimited ? t("tplLimited", { n: draft.enabledExtensions.length }) : t("tplFollowSession")}
											</span>
										</div>
										<p className="set-hint">{t("tplWhitelistHint")}</p>
										{extensions.length === 0 ? (
											<p className="set-hint">{t("noExtensions")}</p>
										) : extList.length === 0 ? (
											<p className="tpl-nohit">{t("tplNoMatch")}</p>
										) : (
											<div className="tpl-pick">
												{extList.map((x) => (
													<label
														key={x.id}
														className={`tpl-chip${draft.enabledExtensions.includes(x.id) ? " on" : ""}`}
													>
														<input
															type="checkbox"
															checked={draft.enabledExtensions.includes(x.id)}
															onChange={(e) =>
																patch({ enabledExtensions: toggleIn(draft.enabledExtensions, x.id, e.target.checked) })
															}
														/>
														{x.name}
													</label>
												))}
											</div>
										)}
									</div>
								</div>
							)}

							{step === 3 && (
								<div className="tpl-panel">
									<div className="tpl-card">
										<div className="tpl-sum">
											<div className="tpl-sum-row">
												<span className="tpl-sum-k">{t("tplSumName")}</span>
												<span className="tpl-sum-v mono">{draft.name.trim()}</span>
											</div>
											<div className="tpl-sum-row">
												<span className="tpl-sum-k">{t("tplSumIntro")}</span>
												<span className="tpl-sum-v">{introText}</span>
											</div>
											<div className="tpl-sum-row">
												<span className="tpl-sum-k">{t("tplSumMode")}</span>
												<span className="tpl-sum-v">{modeText}</span>
											</div>
											<div className="tpl-sum-row">
												<span className="tpl-sum-k">{t("tplSumModel")}</span>
												<span className="tpl-sum-v">{draft.model ? modelLabel : t("subagentFollowMain")}</span>
											</div>
											<div className="tpl-sum-row">
												<span className="tpl-sum-k">{t("tplSumThinking")}</span>
												<span className="tpl-sum-v">{thinkingText}</span>
											</div>
											<div className="tpl-sum-row">
												<span className="tpl-sum-k">{t("tplSumSkills")}</span>
												<span className="tpl-sum-v">
													{draft.enabledSkills.length > 0 ? draft.enabledSkills.join(" · ") : t("tplFollowSession")}
												</span>
											</div>
											<div className="tpl-sum-row">
												<span className="tpl-sum-k">{t("tplSumExtensions")}</span>
												<span className="tpl-sum-v">
													{draft.enabledExtensions.length > 0
														? draft.enabledExtensions.join(" · ")
														: t("tplFollowSession")}
												</span>
											</div>
										</div>
										<span className={`tpl-state${draft.enabled ? " on" : ""}`}>
											{draft.enabled ? t("tplStateOn") : t("tplStateOff")}
										</span>
									</div>
									<div className="tpl-card">
										<p className="tpl-card-title">{t("tplSpawnTitle")}</p>
										<pre className="tpl-spawn">
											<span className="tpl-spawn-kw">subagent_spawn</span>(
											{draft.name.trim() && (
												<>
													<span className="tpl-spawn-k">template</span>=<b>"{draft.name.trim()}"</b>
												</>
											)}
											{draft.model && (
												<>
													, <span className="tpl-spawn-k">model</span>=<b>"{draft.model}"</b>
												</>
											)}
											{draft.thinkingLevel && (
												<>
													, <span className="tpl-spawn-k">thinking</span>=<b>"{draft.thinkingLevel}"</b>
												</>
											)}
											)
										</pre>
										<p className="tpl-card-sub">{t("tplSpawnNote")}</p>
									</div>
								</div>
							)}
						</div>
					</div>
				</div>
				<div className="modal-actions">
					<button type="button" className="dd-refresh" onClick={onClose}>
						{t("tplCancel")}
					</button>
					{step > 0 && (
						<button type="button" className="set-save-btn" onClick={() => setStep(step - 1)}>
							{t("previous")}
						</button>
					)}
					{step < 3 ? (
						<button
							type="button"
							className="set-save-btn"
							disabled={step === 0 && nameMissing}
							onClick={() => setStep(step + 1)}
						>
							{t("next")}
						</button>
					) : (
						<button
							type="button"
							className="set-save-btn"
							disabled={nameMissing}
							onClick={() => onSave({ ...draft, name: draft.name.trim() })}
						>
							{t("tplSave")}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
