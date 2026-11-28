import { useState } from "react";
import { FiEdit3, FiPlus, FiSend, FiTrash2 } from "react-icons/fi";
import { useT } from "../../i18n";
import { quickPhraseDefaults } from "../../quick-phrases";
import type { UiSettingsState } from "../../types";
import { HintTip } from "../HintTip";
import { ToggleRow } from "./ToggleRow";

type QuickSettingsSlice = Pick<
	UiSettingsState,
	"quickPhrases" | "quickPhrasesEnabled" | "minimalNewChat" | "preserveDraftAcrossConversations"
>;

/** 设置页「快捷短语与对话入口」Tab。 */
export function QuickTab({
	settings,
	onPatch,
}: {
	settings: QuickSettingsSlice;
	onPatch: (patch: Partial<QuickSettingsSlice>) => void;
}) {
	const t = useT();
	const [quickNew, setQuickNew] = useState("");
	const [quickEdit, setQuickEdit] = useState<{ index: number; value: string } | null>(null);

	const commitQuickEdit = () => {
		if (!quickEdit) return;
		const v = quickEdit.value.trim();
		const i = quickEdit.index;
		setQuickEdit(null);
		if (!v || v === settings.quickPhrases[i]) return;
		const next = [...settings.quickPhrases];
		next[i] = v;
		onPatch({ quickPhrases: next });
	};

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiSend className="set-section-icon" />
				{t("quickPhrases")}
				<HintTip text={t("quickPhrasesDesc")} />
				<span className="set-count">{settings.quickPhrases.length}</span>
			</div>
			<ToggleRow
				title={t("quickPhrasesEnabled")}
				tip={t("quickPhrasesDesc")}
				enabled={settings.quickPhrasesEnabled}
				onToggle={() => onPatch({ quickPhrasesEnabled: !settings.quickPhrasesEnabled })}
			/>
			<ToggleRow
				title={t("minimalNewChat")}
				tip={t("minimalNewChatDesc")}
				enabled={settings.minimalNewChat ?? false}
				onToggle={() => onPatch({ minimalNewChat: !(settings.minimalNewChat ?? false) })}
			/>
			<ToggleRow
				title={t("preserveDraftAcrossConversations")}
				tip={t("preserveDraftAcrossConversationsDesc")}
				enabled={settings.preserveDraftAcrossConversations ?? false}
				onToggle={() =>
					onPatch({
						preserveDraftAcrossConversations: !(settings.preserveDraftAcrossConversations ?? false),
					})
				}
			/>
			{!settings.quickPhrasesEnabled && <p className="set-hint">{t("quickPhrasesOffHint")}</p>}
			<div className="set-preset-save">
				<input
					className="set-input"
					placeholder={t("quickPhrasesPlaceholder")}
					value={quickNew}
					maxLength={200}
					onChange={(e) => setQuickNew(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && quickNew.trim()) {
							onPatch({ quickPhrases: [...settings.quickPhrases, quickNew.trim()] });
							setQuickNew("");
						}
					}}
				/>
				<button
					type="button"
					className="set-save-btn"
					disabled={!quickNew.trim()}
					onClick={() => {
						onPatch({ quickPhrases: [...settings.quickPhrases, quickNew.trim()] });
						setQuickNew("");
					}}
				>
					<FiPlus /> {t("quickPhrasesAdd")}
				</button>
			</div>
			{settings.quickPhrases.length === 0 ? (
				<p className="set-empty">{t("quickPhrasesEmpty")}</p>
			) : (
				<div className="set-list">
					{settings.quickPhrases.map((p, i) => (
						<div className="set-row" key={`${i}:${p}`}>
							{quickEdit?.index === i ? (
								<div className="set-row-info">
									<input
										className="set-input"
										autoFocus
										value={quickEdit.value}
										maxLength={200}
										placeholder={t("quickPhrasesEditPh")}
										onChange={(e) => setQuickEdit({ index: i, value: e.target.value })}
										onKeyDown={(e) => {
											if (e.key === "Enter") commitQuickEdit();
											else if (e.key === "Escape") setQuickEdit(null);
										}}
										onBlur={commitQuickEdit}
									/>
								</div>
							) : (
								<>
									<div className="set-row-info">
										<div className="set-row-name" title={p}>
											{p}
										</div>
									</div>
									<div className="set-row-actions">
										<button
											type="button"
											className="set-icon-btn"
											title={t("quickPhrasesEdit")}
											onClick={() => setQuickEdit({ index: i, value: p })}
										>
											<FiEdit3 />
										</button>
										<button
											type="button"
											className="set-icon-btn"
											title={t("quickPhrasesMoveUp")}
											disabled={i === 0}
											onClick={() => {
												const next = [...settings.quickPhrases];
												[next[i - 1], next[i]] = [next[i], next[i - 1]];
												onPatch({ quickPhrases: next });
											}}
										>
											↑
										</button>
										<button
											type="button"
											className="set-icon-btn"
											title={t("quickPhrasesMoveDown")}
											disabled={i === settings.quickPhrases.length - 1}
											onClick={() => {
												const next = [...settings.quickPhrases];
												[next[i], next[i + 1]] = [next[i + 1], next[i]];
												onPatch({ quickPhrases: next });
											}}
										>
											↓
										</button>
										<button
											type="button"
											className="set-icon-btn danger"
											title={t("quickPhrasesDelete")}
											onClick={() => onPatch({ quickPhrases: settings.quickPhrases.filter((_, j) => j !== i) })}
										>
											<FiTrash2 />
										</button>
									</div>
								</>
							)}
						</div>
					))}
				</div>
			)}
			<div className="compose-toolbar">
				<button
					type="button"
					className="dd-refresh"
					onClick={() => {
						setQuickEdit(null);
						onPatch({ quickPhrases: quickPhraseDefaults(t) });
					}}
				>
					{t("quickPhrasesReset")}
				</button>
			</div>
		</div>
	);
}
