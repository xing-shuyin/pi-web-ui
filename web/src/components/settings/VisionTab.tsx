import { useEffect, useRef, useState } from "react";
import { FiEye } from "react-icons/fi";
import { useT } from "../../i18n";
import type { UiSettingsState } from "../../types";
import { FieldRow } from "./FieldRow";
import { PromptOverrideEditor } from "./PromptOverrideEditor";
import { ToggleRow } from "./ToggleRow";

type VisionSettingsSlice = Pick<
	UiSettingsState,
	| "visionBridgeEnabled"
	| "visionBridgeModel"
	| "visionModels"
	| "visionBridgePromptMode"
	| "visionBridgePrompt"
	| "visionBridgeDefaultPrompt"
>;

/** 设置页「视觉桥接」Tab。 */
export function VisionTab({
	settings,
	onPatch,
}: {
	settings: VisionSettingsSlice;
	onPatch: (
		patch: Partial<
			Pick<
				UiSettingsState,
				"visionBridgeEnabled" | "visionBridgeModel" | "visionBridgePromptMode" | "visionBridgePrompt"
			>
		>,
	) => void;
}) {
	const t = useT();
	const [vbPromptMode, setVbPromptMode] = useState<"append" | "replace">(settings.visionBridgePromptMode);
	const [vbPromptDraft, setVbPromptDraft] = useState(
		settings.visionBridgePromptMode === "append" || settings.visionBridgePrompt
			? settings.visionBridgePrompt
			: settings.visionBridgeDefaultPrompt,
	);
	const vbPromptFocus = useRef(false);

	useEffect(() => {
		setVbPromptMode(settings.visionBridgePromptMode);
		if (vbPromptFocus.current) return;
		setVbPromptDraft(
			settings.visionBridgePromptMode === "append" || settings.visionBridgePrompt
				? settings.visionBridgePrompt
				: settings.visionBridgeDefaultPrompt,
		);
	}, [settings.visionBridgePromptMode, settings.visionBridgePrompt, settings.visionBridgeDefaultPrompt]);

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiEye className="set-section-icon" />
				{t("settingsVisionBridge")}
			</div>
			<ToggleRow
				title={t("visionBridgeEnabled")}
				tip={`${t("settingsVisionBridgeDesc")}\n${t("visionBridgeOffHint")}`}
				enabled={settings.visionBridgeEnabled}
				onToggle={() => onPatch({ visionBridgeEnabled: !settings.visionBridgeEnabled })}
			/>
			{settings.visionBridgeEnabled && (
				<FieldRow label={t("visionBridgeModel")}>
					<select
						className="set-select"
						value={settings.visionBridgeModel ?? ""}
						onChange={(e) => onPatch({ visionBridgeModel: e.target.value || null })}
					>
						<option value="">{t("visionBridgeAuto")}</option>
						{settings.visionModels.map((m) => (
							<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
								{m.label}
							</option>
						))}
					</select>
				</FieldRow>
			)}
			{settings.visionBridgeEnabled && (
				<PromptOverrideEditor
					mode={vbPromptMode}
					onModeChange={setVbPromptMode}
					draft={vbPromptDraft}
					onDraftChange={setVbPromptDraft}
					defaultPrompt={settings.visionBridgeDefaultPrompt}
					placeholder={t("visionBridgePromptPlaceholder")}
					rows={4}
					onCommit={(mode, text) => {
						onPatch({
							visionBridgePromptMode: mode,
							visionBridgePrompt: text,
						});
					}}
					hint={
						settings.visionModels.length === 0
							? t("visionBridgeNoModels")
							: t("visionBridgeCurrent", {
									model: settings.visionBridgeModel ?? t("visionBridgeAuto"),
								})
					}
					focusRef={vbPromptFocus}
				/>
			)}
		</div>
	);
}
