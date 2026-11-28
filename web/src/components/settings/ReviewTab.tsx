import { useEffect, useRef, useState } from "react";
import { FiZap } from "react-icons/fi";
import { appSend } from "../../app-globals";
import { useT } from "../../i18n";
import type { UiSettingsState, UiSkillInfo } from "../../types";
import { HintTip } from "../HintTip";
import { ToggleRow } from "./ToggleRow";

type ReviewSettingsSlice = Pick<UiSettingsState, "goalModeEnabled" | "reviewPrompt" | "reviewSkills">;

/** 设置页「审查与目标模式」Tab。 */
export function ReviewTab({
	settings,
	delegateMode,
	isDsh,
	onPatch,
	onToggleReviewSkill,
}: {
	settings: ReviewSettingsSlice;
	delegateMode: boolean;
	isDsh: boolean;
	onPatch: (patch: Partial<Pick<UiSettingsState, "goalModeEnabled" | "reviewPrompt">>) => void;
	onToggleReviewSkill: (skill: UiSkillInfo) => void;
}) {
	const t = useT();
	const [reviewPromptDraft, setReviewPromptDraft] = useState(settings.reviewPrompt);
	const reviewPromptFocus = useRef(false);

	useEffect(() => {
		if (!reviewPromptFocus.current) setReviewPromptDraft(settings.reviewPrompt);
	}, [settings.reviewPrompt]);

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiZap className="set-section-icon" />
				{t("settingsReview")}
				<HintTip text={t("settingsReviewDesc")} />
				<span className="set-count">{settings.reviewSkills.length}</span>
			</div>
			<ToggleRow
				title={t("goalModeEnabled")}
				tip={`${t("goalModeEnabledDesc")}\n${t("goalModeOffHint")}`}
				enabled={settings.goalModeEnabled}
				onToggle={() => onPatch({ goalModeEnabled: !settings.goalModeEnabled })}
			/>
			<ToggleRow
				title={t("delegateMode")}
				tip={`${t("delegateModeDesc")}\n${t("delegateModeOffHint")}`}
				enabled={delegateMode}
				onToggle={() => appSend({ type: "set_delegate_mode", enabled: !delegateMode })}
			/>
			<textarea
				className="set-prompt-input"
				rows={5}
				placeholder={t("reviewPromptPlaceholder")}
				value={reviewPromptDraft}
				onFocus={() => (reviewPromptFocus.current = true)}
				onBlur={() => {
					reviewPromptFocus.current = false;
					onPatch({ reviewPrompt: reviewPromptDraft });
				}}
				onChange={(e) => setReviewPromptDraft(e.target.value)}
			/>
			<div className="set-field-label">
				{t("settingsReviewSkills")}
				{isDsh && (
					<>
						{" "}
						<HintTip text={t("dshReviewPromptNote")} />
					</>
				)}
			</div>
			{settings.reviewSkills.length === 0 ? (
				<p className="set-empty">{t("noSkills")}</p>
			) : (
				<div className="set-list">
					{settings.reviewSkills.map((s) => (
						<ToggleRow
							key={`review-${s.name}`}
							title={s.name}
							subtitle={s.description}
							enabled={s.enabled}
							onToggle={() => onToggleReviewSkill(s)}
						/>
					))}
				</div>
			)}
		</div>
	);
}
