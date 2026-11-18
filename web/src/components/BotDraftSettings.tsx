import { useId } from "react";
import { FiCpu } from "react-icons/fi";
import { useT } from "../i18n";
import type { UiSettingsState } from "../types";

/**
 * 设置 →「智能体」：`让 AI 起草` 这次一次性调用用哪个模型、开多深的思考。
 *
 * 为什么单独给这两个字段（而不是只跟默认模型）：
 * 起草要模型吐**结构化 JSON**，对模型的要求跟聊天不同；套餐里能聊的模型不一定能稳定吐 JSON，
 * 而这类失败在界面上只表现为“起草失败”（服务端 `bot-drafts` 的 `DRAFT_*` 码）。
 * 人需要一个显式的挑模型/降思考的入口，而不是被迫改「整个应用的默认模型」。
 *
 * 单源：字段与校验在 `server/bot-draft-settings.ts`，服务端起草器每次现取。
 */
export type BotDraftPatch = Partial<Pick<UiSettingsState, "botDraftModel" | "botDraftThinking">>;

/** 与协议 `ThinkingLevel` 一致（不含 `max`）：服务端 `BOT_DRAFT_THINKING_LEVELS` 同一组。 */
const THINKING_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function BotDraftSettings({
	settings,
	onChange,
}: {
	settings: UiSettingsState;
	onChange: (patch: BotDraftPatch) => void;
}) {
	const t = useT();
	const id = useId();
	const model = settings.botDraftModel ?? "";
	const models = settings.subagentModels ?? [];
	// 已保存但当前列表里没有（换过 provider / 模型下线）：仍显示原文，别让选择器悄悄跳回“跟随默认”。
	const stale = model && !models.some((item) => `${item.provider}/${item.id}` === model);

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiCpu className="set-section-icon" />
				{t("settingsBotsTitle")}
			</div>
			<p className="set-hint">{t("botDraftSettingsDesc")}</p>
			<div className="set-row set-field-row">
				<label className="set-row-name" htmlFor={id + "-model"} title={t("botDraftModelHint")}>
					{t("botDraftModel")}
				</label>
				<select
					id={id + "-model"}
					className="set-select"
					value={model}
					aria-describedby={id + "-model-hint"}
					onChange={(event) => onChange({ botDraftModel: event.target.value || null })}
				>
					<option value="">{t("botDraftFollowDefault")}</option>
					{stale && <option value={model}>{model}</option>}
					{models.map((item) => (
						<option key={`${item.provider}/${item.id}`} value={`${item.provider}/${item.id}`}>
							{item.label}
						</option>
					))}
				</select>
			</div>
			<p className="set-hint" id={id + "-model-hint"}>
				{t("botDraftModelHint")}
			</p>
			{models.length === 0 && <p className="set-hint">{t("botDraftNoModels")}</p>}
			<div className="set-row set-field-row">
				<label className="set-row-name" htmlFor={id + "-thinking"} title={t("botDraftThinkingHint")}>
					{t("botDraftThinking")}
				</label>
				<select
					id={id + "-thinking"}
					className="set-select"
					value={settings.botDraftThinking ?? "off"}
					aria-describedby={id + "-thinking-hint"}
					onChange={(event) => onChange({ botDraftThinking: event.target.value as BotDraftPatch["botDraftThinking"] })}
				>
					{THINKING_VALUES.map((value) => (
						<option key={value} value={value}>
							{t(`thinking.${value}`)}
						</option>
					))}
				</select>
			</div>
			<p className="set-hint" id={id + "-thinking-hint"}>
				{t("botDraftThinkingHint")}
			</p>
		</div>
	);
}
