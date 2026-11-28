import { FiSliders } from "react-icons/fi";
import { appSend } from "../../app-globals";
import { useI18n, useT } from "../../i18n";
import type { DshPermissionOption, UiAgentPreset } from "../../types";
import { DSH_PERMISSION_ORDER, permDescKey, permLabelKey } from "../DshPermissionBar";
import { presetText, sortAgentPresets } from "../DshPresetBar";
import { HintTip } from "../HintTip";

/** 设置页「DSH 预设与权限」Tab。 */
export function DshPresetsTab({
	dshPresets,
	dshPermission,
	showPresetConfig,
	defaultAgentPresetDesc,
	hasUserAgentPreset,
}: {
	dshPresets?: { presets: UiAgentPreset[]; defaultPreset: string } | null;
	dshPermission?: { options: DshPermissionOption[]; defaultPreset: string } | null;
	showPresetConfig: boolean;
	defaultAgentPresetDesc?: string;
	hasUserAgentPreset: boolean;
}) {
	const t = useT();
	const { locale } = useI18n();

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiSliders className="set-section-icon" />
				{t("dshPreset")} & {t("dshPerm")}
				<HintTip text={t("dshDefaultPresetDesc")} />
			</div>
			<p className="set-desc" style={{ marginTop: 4, marginBottom: 12 }}>
				{t("settingsEngineDshDesc")}
			</p>
			{showPresetConfig && (
				<div className="set-preset-config" style={{ marginTop: 8 }}>
					{dshPresets && dshPresets.presets.length > 0 && (
						<>
							<div className="set-mode-row">
								<label className="set-field-label">
									{t("dshDefaultPreset")}
									<HintTip text={t("dshDefaultPresetDesc")} />
								</label>
								<select
									className="set-select"
									value={dshPresets.defaultPreset}
									onChange={(e) => appSend({ type: "dsh_preset_default", preset: e.target.value })}
								>
									{sortAgentPresets(dshPresets.presets).map((p) => (
										<option key={p.id} value={p.id} disabled={!!p.broken}>
											{presetText(p, locale, t).name}
											{p.trust === "user" ? ` · ${t("dshPresetUser")}` : ""}
											{p.broken ? ` · ${t("dshPresetBroken")}` : ""}
										</option>
									))}
								</select>
							</div>
							{defaultAgentPresetDesc && <p className="set-preset-config-desc">{defaultAgentPresetDesc}</p>}
						</>
					)}
					{dshPermission && dshPermission.options.length > 0 && (
						<>
							<div className="set-mode-row" style={{ marginTop: 14 }}>
								<label className="set-field-label">
									{t("dshPermDefault")}
									<HintTip text={t("dshPermDefaultDesc")} />
								</label>
								<select
									className="set-select"
									value={dshPermission.defaultPreset}
									onChange={(e) => appSend({ type: "dsh_permission_default", preset: e.target.value })}
								>
									{DSH_PERMISSION_ORDER.filter((v) => dshPermission.options.some((o) => o.value === v)).map((v) => (
										<option key={v} value={v}>
											{t(permLabelKey(v))}
										</option>
									))}
								</select>
							</div>
							<p className="set-preset-config-desc">{t(permDescKey(dshPermission.defaultPreset))}</p>
						</>
					)}
				</div>
			)}
			{hasUserAgentPreset && <p className="set-hint">{t("dshPresetUserNote")}</p>}
		</div>
	);
}
