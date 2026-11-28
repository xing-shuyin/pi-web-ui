import { useState } from "react";
import { FiGlobe, FiPlus, FiShare2, FiSliders, FiTrash2, FiUpload } from "react-icons/fi";
import { appSend } from "../../app-globals";
import { useT } from "../../i18n";
import type { UiSettingsPreset } from "../../types";
import type { PresetShareTab } from "../PresetShareModal";

/** 设置页「预设（Pi）」Tab。 */
export function PresetsTab({
	presets,
	onSharePreset,
}: {
	presets: UiSettingsPreset[];
	onSharePreset: (target: { name: string; tab: PresetShareTab }) => void;
}) {
	const t = useT();
	const [presetName, setPresetName] = useState("");
	const visiblePresets = presets.filter((p) => p.scope !== "prompt");

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiSliders className="set-section-icon" />
				{t("settingsPresets")}
				<span className="set-count">{visiblePresets.length}</span>
			</div>
			<div className="set-preset-share-actions">
				<button
					type="button"
					className="set-preset-share-btn primary"
					title={t("presetShareShareBtn")}
					onClick={() =>
						onSharePreset({
							name: visiblePresets[0]?.name ?? "",
							tab: "export",
						})
					}
				>
					<FiShare2 />
					{t("presetShareShareBtn")}
				</button>
				<button
					type="button"
					className="set-preset-share-btn"
					title={t("presetShareImportBtn")}
					onClick={() => onSharePreset({ name: "", tab: "import" })}
				>
					<FiUpload />
					{t("presetShareImportBtn")}
				</button>
				<button
					type="button"
					className="set-preset-share-btn"
					title={t("presetShareBrowseBtn")}
					onClick={() => onSharePreset({ name: "", tab: "browse" })}
				>
					<FiGlobe />
					{t("presetShareBrowseBtn")}
				</button>
			</div>
			<div className="set-preset-save">
				<input
					className="set-input"
					placeholder={t("presetNamePlaceholder")}
					value={presetName}
					onChange={(e) => setPresetName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && presetName.trim()) {
							appSend({ type: "save_preset", name: presetName.trim() });
							setPresetName("");
						}
					}}
				/>
				<button
					type="button"
					className="set-save-btn"
					disabled={!presetName.trim()}
					onClick={() => {
						appSend({ type: "save_preset", name: presetName.trim() });
						setPresetName("");
					}}
				>
					<FiPlus /> {t("saveAsPreset")}
				</button>
			</div>
			{visiblePresets.length === 0 ? (
				<p className="set-empty">{t("noPresets")}</p>
			) : (
				<div className="set-list">
					{visiblePresets.map((p) => (
						<div className="set-row" key={p.name}>
							<div className="set-row-info">
								<div className="set-row-name">{p.name}</div>
								<div className="set-row-desc">
									{p.promptMode === "replace" ? t("promptModeReplace") : t("promptModeAppend")}
									{p.disabledSkills.length > 0 && ` · ${t("settingsSkills")} ${p.disabledSkills.length}`}
									{p.disabledExtensions.length > 0 && ` · ${t("settingsExtensions")} ${p.disabledExtensions.length}`}
								</div>
							</div>
							<div className="set-row-actions">
								<button
									type="button"
									className="set-icon-btn"
									title={t("presetShare")}
									onClick={() => onSharePreset({ name: p.name, tab: "export" })}
								>
									<FiShare2 />
								</button>
								<button
									type="button"
									className="set-uninstall"
									onClick={() => appSend({ type: "apply_preset", name: p.name })}
								>
									{t("applyPreset")}
								</button>
								<button
									type="button"
									className="set-icon-btn danger"
									title={t("deletePreset")}
									onClick={() => appSend({ type: "delete_preset", name: p.name })}
								>
									<FiTrash2 />
								</button>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
