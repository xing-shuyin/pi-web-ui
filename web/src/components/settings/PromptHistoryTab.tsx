import { useEffect, useState } from "react";
import { FiArchive, FiClock, FiTrash2 } from "react-icons/fi";
import { useT } from "../../i18n";
import { clearPromptHistory, loadPromptHistorySettings, savePromptHistorySettings } from "../../prompt-history";
import { HintTip } from "../HintTip";
import { FieldRow } from "./FieldRow";
import { ToggleRow } from "./ToggleRow";

/** 设置页「输入历史」Tab：管理本地历史条数、字符上限与清空确认。 */
export function PromptHistoryTab({ phCount, onRefreshCount }: { phCount: number; onRefreshCount: () => void }) {
	const t = useT();
	const [phSettings, setPhSettings] = useState(() => loadPromptHistorySettings());
	const [phClearConfirm, setPhClearConfirm] = useState(false);

	useEffect(() => {
		if (!phClearConfirm) return;
		const id = window.setTimeout(() => setPhClearConfirm(false), 3000);
		return () => window.clearTimeout(id);
	}, [phClearConfirm]);

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiClock className="set-section-icon" />
				{t("settingsPromptHistory")}
				<HintTip text={t("settingsPromptHistoryDesc")} />
				<span className="set-count">{t("promptHistoryCount", { n: String(phCount) })}</span>
			</div>
			{phCount === 0 ? (
				<p className="set-empty">{t("promptHistoryEmpty")}</p>
			) : (
				<p className="set-hint">{t("promptHistoryCount", { n: String(phCount) })}</p>
			)}
			<FieldRow label={t("promptHistoryMax")} tip={t("promptHistoryMaxHint")} htmlFor="ph-max">
				<input
					id="ph-max"
					className="set-input"
					type="number"
					min={1}
					max={500}
					step={1}
					value={String(phSettings.maxEntries)}
					onChange={(e) => {
						const v = Math.floor(Number(e.target.value) || 0);
						setPhSettings({ ...phSettings, maxEntries: v });
					}}
					onBlur={() => {
						const norm = { ...phSettings };
						if (!Number.isFinite(norm.maxEntries) || norm.maxEntries < 1) norm.maxEntries = 1;
						if (norm.maxEntries > 500) norm.maxEntries = 500;
						norm.maxEntries = Math.floor(norm.maxEntries);
						setPhSettings(norm);
						savePromptHistorySettings(norm);
						onRefreshCount();
					}}
				/>
			</FieldRow>
			<ToggleRow
				title={t("promptHistoryCharLimit")}
				tip={t("promptHistoryCharLimitHint")}
				enabled={phSettings.charLimitEnabled}
				onToggle={() => {
					const next = { ...phSettings, charLimitEnabled: !phSettings.charLimitEnabled };
					setPhSettings(next);
					savePromptHistorySettings(next);
					onRefreshCount();
				}}
			/>
			{phSettings.charLimitEnabled && (
				<FieldRow label={t("promptHistoryCharLimit")} htmlFor="ph-char-limit">
					<input
						id="ph-char-limit"
						className="set-input"
						type="number"
						min={100}
						max={20000}
						step={100}
						placeholder={t("promptHistoryCharLimitPlaceholder")}
						value={String(phSettings.charLimit)}
						onChange={(e) => {
							const v = Math.floor(Number(e.target.value) || 0);
							setPhSettings({ ...phSettings, charLimit: v });
						}}
						onBlur={() => {
							let v = Math.floor(Number(phSettings.charLimit) || 0);
							if (!Number.isFinite(v) || v < 100) v = 100;
							if (v > 20000) v = 20000;
							const norm = { ...phSettings, charLimit: v };
							setPhSettings(norm);
							savePromptHistorySettings(norm);
							onRefreshCount();
						}}
					/>
				</FieldRow>
			)}
			<div className="set-field" style={{ marginTop: 12 }}>
				<button
					type="button"
					className={`set-uninstall${phClearConfirm ? " confirm" : ""}`}
					disabled={phCount === 0}
					title={phCount === 0 ? t("promptHistoryEmpty") : t("promptHistoryClear")}
					onClick={() => {
						if (!phClearConfirm) {
							setPhClearConfirm(true);
							return;
						}
						clearPromptHistory();
						setPhClearConfirm(false);
						onRefreshCount();
					}}
				>
					<FiTrash2 /> {phClearConfirm ? t("promptHistoryClearConfirm") : t("promptHistoryClear")}
				</button>
				{phCount > 0 && (
					<span className="set-hint" style={{ marginLeft: 8 }}>
						{t("promptHistoryCount", { n: String(phCount) })}
					</span>
				)}
			</div>
			<p className="set-hint">
				<FiArchive style={{ verticalAlign: "-2px", marginRight: 4 }} />
				{t("settingsPromptHistoryDesc")}
			</p>
		</div>
	);
}
