import { useEffect, useId, useRef, useState } from "react";
import { FiMessageSquare, FiRotateCcw } from "react-icons/fi";
import { useT } from "../i18n";
import { THINKING_VALUES } from "../thinking-levels";
import type { UiSettingsState } from "../types";
import { appUrl } from "../base-url";

export type QuickAskPatch = Partial<
	Pick<
		UiSettingsState,
		"quickAskModel" | "quickAskThinking" | "quickAskSystemPrompt" | "quickAskExplainPrompt" | "quickAskEnabled"
	>
>;

const DEFAULT_EXPLAIN_PROMPT = "解释下: {{input}}";

export function QuickAskSettings({
	settings,
	onChange,
}: {
	settings: UiSettingsState;
	onChange: (patch: QuickAskPatch) => void;
}) {
	const t = useT();
	const id = useId();
	const systemPrompt = settings.quickAskSystemPrompt ?? "";
	const explainPrompt = settings.quickAskExplainPrompt ?? DEFAULT_EXPLAIN_PROMPT;
	const [systemDraft, setSystemDraft] = useState(systemPrompt);
	const [explainDraft, setExplainDraft] = useState(explainPrompt);
	const systemFocused = useRef(false);
	const explainFocused = useRef(false);
	const pendingDrafts = useRef<QuickAskPatch>({});
	const saveRef = useRef(onChange);
	useEffect(() => {
		saveRef.current = onChange;
	}, [onChange]);
	useEffect(
		() => () => {
			const patch = pendingDrafts.current;
			pendingDrafts.current = {};
			if (Object.keys(patch).length) saveRef.current(patch);
		},
		[],
	);
	useEffect(() => {
		if (!systemFocused.current) setSystemDraft(systemPrompt);
	}, [systemPrompt]);
	useEffect(() => {
		if (!explainFocused.current) setExplainDraft(explainPrompt);
	}, [explainPrompt]);
	const model = settings.quickAskModel ?? "";
	const [availableModels, setAvailableModels] = useState<UiSettingsState["subagentModels"] | null>(null);
	const [catalogError, setCatalogError] = useState("");
	const models = availableModels ?? settings.subagentModels;
	useEffect(() => {
		const controller = new AbortController();
		void (async () => {
			try {
				const response = await fetch(appUrl("/api/quick-ask/models"), { signal: controller.signal });
				const result = (await response.json()) as { models?: UiSettingsState["subagentModels"]; error?: string };
				if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
				if (!Array.isArray(result.models)) throw new Error("Invalid model catalog");
				if (!controller.signal.aborted) setAvailableModels(result.models);
			} catch (error) {
				if (!controller.signal.aborted) setCatalogError(error instanceof Error ? error.message : String(error));
			}
		})();
		return () => controller.abort();
	}, []);

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiMessageSquare className="set-section-icon" />
				{t("quickAskSettingsTitle")}
			</div>
			<p className="set-hint">{t("quickAskSettingsDesc")}</p>
			<label className="set-toggle" htmlFor={`${id}-enabled`}>
				<input
					id={`${id}-enabled`}
					type="checkbox"
					checked={settings.quickAskEnabled ?? true}
					aria-describedby={`${id}-enabled-hint`}
					onChange={(e) => onChange({ quickAskEnabled: e.target.checked })}
				/>
				<span>{t("quickAskEnabled")}</span>
			</label>
			<p className="set-hint" id={`${id}-enabled-hint`}>
				{t("quickAskEnabledHint")}
			</p>
			<div className="set-row set-field-row">
				<label className="set-row-name" htmlFor={`${id}-model`}>
					{t("quickAskModel")}
				</label>
				<select
					id={`${id}-model`}
					className="set-select"
					value={model}
					onChange={(e) => onChange({ quickAskModel: e.target.value || null })}
				>
					<option value="">{t("quickAskFollowModel")}</option>
					{model && !models.some((m) => `${m.provider}/${m.id}` === model) && <option value={model}>{model}</option>}
					{models.map((m) => (
						<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
							{m.label}
						</option>
					))}
				</select>
			</div>
			{catalogError && (
				<p className="set-hint" role="alert">
					{t("quickAskError")}: {catalogError}
				</p>
			)}
			<div className="set-row set-field-row">
				<label className="set-row-name" htmlFor={`${id}-thinking`}>
					{t("quickAskThinking")}
				</label>
				<select
					id={`${id}-thinking`}
					className="set-select"
					value={settings.quickAskThinking ?? "off"}
					onChange={(e) => onChange({ quickAskThinking: e.target.value as UiSettingsState["quickAskThinking"] })}
				>
					{THINKING_VALUES.map((value) => (
						<option key={value} value={value}>
							{t(`thinking.${value}`)}
						</option>
					))}
				</select>
			</div>
			<label className="set-field-label" htmlFor={`${id}-system`}>
				{t("quickAskSystemPrompt")}
			</label>
			<textarea
				id={`${id}-system`}
				className="set-prompt-input"
				rows={4}
				value={systemDraft}
				aria-describedby={`${id}-system-hint`}
				onFocus={() => {
					systemFocused.current = true;
				}}
				onChange={(e) => {
					pendingDrafts.current.quickAskSystemPrompt = e.target.value;
					setSystemDraft(e.target.value);
				}}
				onBlur={() => {
					systemFocused.current = false;
					delete pendingDrafts.current.quickAskSystemPrompt;
					if (systemDraft !== systemPrompt) onChange({ quickAskSystemPrompt: systemDraft });
				}}
			/>
			<p className="set-hint" id={`${id}-system-hint`}>
				{t("quickAskSystemPromptHint")}
			</p>
			<label className="set-field-label" htmlFor={`${id}-explain`}>
				{t("quickAskExplainPrompt")}
			</label>
			<textarea
				id={`${id}-explain`}
				className="set-prompt-input"
				rows={4}
				value={explainDraft}
				placeholder={DEFAULT_EXPLAIN_PROMPT}
				aria-describedby={`${id}-explain-hint`}
				onFocus={() => {
					explainFocused.current = true;
				}}
				onChange={(e) => {
					pendingDrafts.current.quickAskExplainPrompt = e.target.value.trim() ? e.target.value : DEFAULT_EXPLAIN_PROMPT;
					setExplainDraft(e.target.value);
				}}
				onBlur={() => {
					explainFocused.current = false;
					delete pendingDrafts.current.quickAskExplainPrompt;
					const next = explainDraft.trim() ? explainDraft : DEFAULT_EXPLAIN_PROMPT;
					setExplainDraft(next);
					if (next !== explainPrompt) onChange({ quickAskExplainPrompt: next });
				}}
			/>
			<p className="set-hint" id={`${id}-explain-hint`}>
				{t("quickAskExplainPromptHint", { defaultPrompt: DEFAULT_EXPLAIN_PROMPT })}
			</p>
			<button
				type="button"
				className="set-save-btn"
				disabled={explainDraft === DEFAULT_EXPLAIN_PROMPT && explainPrompt === DEFAULT_EXPLAIN_PROMPT}
				onClick={() => {
					delete pendingDrafts.current.quickAskExplainPrompt;
					setExplainDraft(DEFAULT_EXPLAIN_PROMPT);
					onChange({ quickAskExplainPrompt: DEFAULT_EXPLAIN_PROMPT });
				}}
			>
				<FiRotateCcw /> {t("quickAskResetExplainPrompt")}
			</button>
		</div>
	);
}
