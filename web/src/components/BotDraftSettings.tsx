import { useEffect, useId, useRef, useState } from "react";
import { FiCpu, FiRotateCcw } from "react-icons/fi";
import { useT } from "../i18n";
import type { UiSettingsState } from "../types";

/**
 * 设置 →「智能体」：`让 AI 起草` 在正式普通对话中发起时的提示词模板自定义。
 *
 * 复用当前会话的模型、思考强度与全部可用工具，不再单独指定模型；
 * 空串表示使用服务端下发的默认模板（`botDraftDefaultPrompt`）。
 */
export type BotDraftPatch = Partial<Pick<UiSettingsState, "botDraftPrompt">>;

export function BotDraftSettings({
	settings,
	onChange,
}: {
	settings: UiSettingsState;
	onChange: (patch: BotDraftPatch) => void;
}) {
	const t = useT();
	const id = useId();
	const saved = settings.botDraftPrompt ?? "";
	const defaultPrompt = settings.botDraftDefaultPrompt ?? "";
	const [draft, setDraft] = useState(saved);
	const focused = useRef(false);

	useEffect(() => {
		if (!focused.current) setDraft(saved);
	}, [saved]);

	const commit = (value: string) => {
		if (value !== saved) onChange({ botDraftPrompt: value });
	};

	const isDefault = !draft.trim() && !saved.trim();

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiCpu className="set-section-icon" />
				{t("settingsBotsTitle")}
			</div>
			<p className="set-hint">{t("botDraftSettingsDesc")}</p>
			<label className="set-row-name" htmlFor={id + "-prompt"}>
				{t("botDraftPrompt")}
			</label>
			<textarea
				id={id + "-prompt"}
				className="set-prompt-input"
				rows={6}
				value={draft}
				placeholder={defaultPrompt || t("botDraftPromptPlaceholder")}
				aria-describedby={id + "-prompt-hint"}
				onFocus={() => {
					focused.current = true;
				}}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => {
					focused.current = false;
					commit(draft);
				}}
			/>
			<div className="quick-ask-settings-editor-footer">
				<p className="set-hint" id={id + "-prompt-hint"}>
					{t("botDraftPromptHint")}
				</p>
				<button
					type="button"
					className="quick-ask-settings-reset"
					disabled={isDefault}
					onClick={() => {
						setDraft("");
						if (saved !== "") onChange({ botDraftPrompt: "" });
					}}
				>
					<FiRotateCcw aria-hidden="true" />
					{t("botDraftPromptReset")}
				</button>
			</div>
		</div>
	);
}
