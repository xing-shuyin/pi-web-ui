import { useEffect, useId, useRef, useState } from "react";
import { FiChevronDown, FiMessageSquare, FiRotateCcw } from "react-icons/fi";
import { useT } from "../i18n";
import { THINKING_VALUES } from "../thinking-levels";
import type { UiSettingsState } from "../types";
import { appUrl } from "../base-url";

export type QuickAskPatch = Partial<
	Pick<
		UiSettingsState,
		| "quickAskModel"
		| "quickAskThinking"
		| "quickAskSystemPrompt"
		| "quickAskExplainPrompt"
		| "quickAskEnabled"
		| "quickAskTranslateEnabled"
		| "quickAskTranslateTarget"
		| "quickAskTranslateStyle"
		| "quickAskTranslatePrompt"
		| "quickAskShowOriginal"
		| "quickAskReferenceMenus"
		| "quickAskConversationScope"
		| "quickAskFolderScope"
	>
>;

const DEFAULT_EXPLAIN_PROMPT = "解释下: {{input}}";
const DEFAULT_TRANSLATE_PROMPT = "将以下文字翻译成{{targetLanguage}}，只输出译文，保留代码与专有名词。\n{{input}}";
const TARGET_LANGUAGES = [
	["zh-CN", "简体中文"],
	["zh-TW", "繁體中文"],
	["en", "English"],
	["ja", "日本語"],
	["ko", "한국어"],
	["de", "Deutsch"],
	["fr", "Français"],
	["es", "Español"],
	["ru", "Русский"],
	["pt", "Português"],
	["it", "Italiano"],
	["tr", "Türkçe"],
] as const;
const PROMPTS = [
	{
		field: "quickAskSystemPrompt",
		id: "system",
		label: "quickAskSystemPrompt",
		hint: "quickAskSystemPromptHint",
		reset: "quickAskResetSystemPrompt",
		fallback: "",
	},
	{
		field: "quickAskExplainPrompt",
		id: "explain",
		label: "quickAskExplainPrompt",
		hint: "quickAskExplainPromptHint",
		reset: "quickAskResetExplainPrompt",
		fallback: DEFAULT_EXPLAIN_PROMPT,
	},
	{
		field: "quickAskTranslatePrompt",
		id: "translate",
		label: "quickAskTranslatePrompt",
		hint: "quickAskTranslatePromptHint",
		reset: "quickAskResetTranslatePrompt",
		fallback: DEFAULT_TRANSLATE_PROMPT,
	},
] as const;
type PromptField = (typeof PROMPTS)[number]["field"];

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
	const translatePrompt = settings.quickAskTranslatePrompt ?? DEFAULT_TRANSLATE_PROMPT;
	const [drafts, setDrafts] = useState<Record<PromptField, string>>({
		quickAskSystemPrompt: systemPrompt,
		quickAskExplainPrompt: explainPrompt,
		quickAskTranslatePrompt: translatePrompt,
	});
	const [editing, setEditing] = useState<PromptField | null>(null);
	const [scopeExpanded, setScopeExpanded] = useState(false);
	const focused = useRef<PromptField | null>(null);
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
		const saved = {
			quickAskSystemPrompt: systemPrompt,
			quickAskExplainPrompt: explainPrompt,
			quickAskTranslatePrompt: translatePrompt,
		};
		setDrafts((current) => {
			const next = { ...current };
			for (const { field } of PROMPTS) {
				if (focused.current !== field && pendingDrafts.current[field] === undefined) next[field] = saved[field];
			}
			return next;
		});
	}, [systemPrompt, explainPrompt, translatePrompt]);
	function savePrompt(field: PromptField) {
		const value = pendingDrafts.current[field];
		if (value === undefined) return;
		delete pendingDrafts.current[field];
		setDrafts((current) => ({ ...current, [field]: value }));
		if (value !== (settings[field] ?? PROMPTS.find((prompt) => prompt.field === field)!.fallback)) {
			onChange({ [field]: value });
		}
	}
	function toggleEditor(field: PromptField) {
		if (editing) savePrompt(editing);
		focused.current = null;
		setEditing(editing === field ? null : field);
	}
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
		<div className="set-section quick-ask-settings-panel">
			<div className="set-section-title">
				<FiMessageSquare className="set-section-icon" />
				{t("quickAskSettingsTitle")}
			</div>
			<p className="quick-ask-settings-intro">{t("quickAskSettingsDesc")}</p>
			<section className="quick-ask-settings-group" aria-labelledby={id + "-basics"}>
				<h3 className="quick-ask-settings-heading" id={id + "-basics"}>
					{t("quickAskBasics")}
				</h3>
				<label className="quick-ask-settings-toggle" htmlFor={id + "-enabled"}>
					<span className="quick-ask-settings-copy">
						<span>{t("quickAskEnabled")}</span>
						<span className="quick-ask-settings-hint" id={id + "-enabled-hint"}>
							{t("quickAskEnabledHint")}
						</span>
					</span>
					<input
						id={id + "-enabled"}
						aria-label={t("quickAskEnabled")}
						type="checkbox"
						checked={settings.quickAskEnabled ?? true}
						aria-describedby={id + "-enabled-hint"}
						onChange={(e) => onChange({ quickAskEnabled: e.target.checked })}
					/>
				</label>
				<div className="quick-ask-settings-pair">
					<label className="quick-ask-settings-field" htmlFor={id + "-model"}>
						<span>{t("quickAskModel")}</span>
						<select
							id={id + "-model"}
							aria-label={t("quickAskModel")}
							className="quick-ask-settings-select"
							value={model}
							onChange={(e) => onChange({ quickAskModel: e.target.value || null })}
						>
							<option value="">{t("quickAskFollowModel")}</option>
							{model && !models.some((m) => m.provider + "/" + m.id === model) && (
								<option value={model}>{model}</option>
							)}
							{models.map((m) => (
								<option key={m.provider + "/" + m.id} value={m.provider + "/" + m.id}>
									{m.label}
								</option>
							))}
						</select>
					</label>
					<label className="quick-ask-settings-field" htmlFor={id + "-thinking"}>
						<span>{t("quickAskThinking")}</span>
						<select
							id={id + "-thinking"}
							aria-label={t("quickAskThinking")}
							className="quick-ask-settings-select"
							value={settings.quickAskThinking ?? "off"}
							onChange={(e) => onChange({ quickAskThinking: e.target.value as UiSettingsState["quickAskThinking"] })}
						>
							{THINKING_VALUES.map((value) => (
								<option key={value} value={value}>
									{t(`thinking.${value}`)}
								</option>
							))}
						</select>
					</label>
				</div>
				{catalogError && (
					<p className="quick-ask-settings-hint" role="alert">
						{t("quickAskError")}: {catalogError}
					</p>
				)}
			</section>
			<section className="quick-ask-settings-group" aria-labelledby={id + "-translation"}>
				<h3 className="quick-ask-settings-heading" id={id + "-translation"}>
					{t("quickAskSelectionTranslation")}
				</h3>
				<label className="quick-ask-settings-toggle" htmlFor={id + "-translate-enabled"}>
					<span className="quick-ask-settings-copy">
						<span>{t("quickAskTranslateEnabled")}</span>
						<span className="quick-ask-settings-hint" id={id + "-translate-enabled-hint"}>
							{t("quickAskTranslateEnabledHint")}
						</span>
					</span>
					<input
						id={id + "-translate-enabled"}
						aria-label={t("quickAskTranslateEnabled")}
						type="checkbox"
						checked={settings.quickAskTranslateEnabled ?? true}
						aria-describedby={id + "-translate-enabled-hint"}
						onChange={(e) => onChange({ quickAskTranslateEnabled: e.target.checked })}
					/>
				</label>
				<div className="quick-ask-settings-pair">
					<label className="quick-ask-settings-field" htmlFor={id + "-target"}>
						<span>{t("quickAskTargetLanguage")}</span>
						<select
							id={id + "-target"}
							aria-label={t("quickAskTargetLanguage")}
							className="quick-ask-settings-select"
							value={settings.quickAskTranslateTarget ?? "auto"}
							onChange={(e) =>
								onChange({ quickAskTranslateTarget: e.target.value as UiSettingsState["quickAskTranslateTarget"] })
							}
						>
							<option value="auto">{t("quickAskTargetAuto")}</option>
							{TARGET_LANGUAGES.map(([value, label]) => (
								<option key={value} value={value}>
									{label}
								</option>
							))}
						</select>
					</label>
					<label className="quick-ask-settings-field" htmlFor={id + "-style"}>
						<span>{t("quickAskTranslateStyle")}</span>
						<select
							id={id + "-style"}
							aria-label={t("quickAskTranslateStyle")}
							className="quick-ask-settings-select"
							value={settings.quickAskTranslateStyle ?? "natural"}
							onChange={(e) =>
								onChange({ quickAskTranslateStyle: e.target.value as UiSettingsState["quickAskTranslateStyle"] })
							}
						>
							<option value="natural">{t("quickAskStyleNatural")}</option>
							<option value="literal">{t("quickAskStyleLiteral")}</option>
							<option value="technical">{t("quickAskStyleTechnical")}</option>
						</select>
					</label>
				</div>
				<label className="quick-ask-settings-toggle" htmlFor={id + "-original"}>
					<span>{t("quickAskShowOriginal")}</span>
					<input
						id={id + "-original"}
						aria-label={t("quickAskShowOriginal")}
						type="checkbox"
						checked={settings.quickAskShowOriginal ?? false}
						onChange={(e) => onChange({ quickAskShowOriginal: e.target.checked })}
					/>
				</label>
			</section>
			<section className="quick-ask-settings-group" aria-labelledby={id + "-references"}>
				<h3 className="quick-ask-settings-heading" id={id + "-references"}>
					{t("quickAskAttach")}
				</h3>
				<label className="quick-ask-settings-toggle" htmlFor={id + "-reference-menus"}>
					<span className="quick-ask-settings-copy">
						<span>{t("quickAskReferenceMenus")}</span>
						<span className="quick-ask-settings-hint" id={id + "-reference-menus-hint"}>
							{t("quickAskReferenceMenusHint")}
						</span>
					</span>
					<input
						id={id + "-reference-menus"}
						aria-label={t("quickAskReferenceMenus")}
						type="checkbox"
						checked={settings.quickAskReferenceMenus ?? true}
						aria-describedby={id + "-reference-menus-hint"}
						onChange={(e) => onChange({ quickAskReferenceMenus: e.target.checked })}
					/>
				</label>
				<button
					type="button"
					className="quick-ask-settings-disclosure"
					aria-expanded={scopeExpanded}
					aria-controls={id + "-scope"}
					onClick={() => setScopeExpanded(!scopeExpanded)}
				>
					<span>{t("quickAskReferenceScope")}</span>
					<span className="quick-ask-settings-disclosure-value">
						{t(
							settings.quickAskConversationScope === "full" ? "quickAskConversationFull" : "quickAskConversationRecent",
						)}{" "}
						· {t(settings.quickAskFolderScope === "content" ? "quickAskFolderContent" : "quickAskFolderListing")}
					</span>
					<FiChevronDown aria-hidden="true" />
				</button>
				{scopeExpanded && (
					<div className="quick-ask-settings-scope" id={id + "-scope"}>
						<div className="quick-ask-settings-pair">
							<label className="quick-ask-settings-field" htmlFor={id + "-conversation-scope"}>
								<span>{t("quickAskConversationScope")}</span>
								<select
									id={id + "-conversation-scope"}
									aria-label={t("quickAskConversationScope")}
									className="quick-ask-settings-select"
									value={settings.quickAskConversationScope ?? "recent"}
									onChange={(e) =>
										onChange({
											quickAskConversationScope: e.target.value as UiSettingsState["quickAskConversationScope"],
										})
									}
								>
									<option value="recent">{t("quickAskConversationRecent")}</option>
									<option value="full">{t("quickAskConversationFull")}</option>
								</select>
							</label>
							<label className="quick-ask-settings-field" htmlFor={id + "-folder-scope"}>
								<span>{t("quickAskFolderScope")}</span>
								<select
									id={id + "-folder-scope"}
									aria-label={t("quickAskFolderScope")}
									className="quick-ask-settings-select"
									value={settings.quickAskFolderScope ?? "listing"}
									onChange={(e) =>
										onChange({ quickAskFolderScope: e.target.value as UiSettingsState["quickAskFolderScope"] })
									}
								>
									<option value="listing">{t("quickAskFolderListing")}</option>
									<option value="content">{t("quickAskFolderContent")}</option>
								</select>
							</label>
						</div>
						<p className="quick-ask-settings-hint">{t("quickAskReferenceScopeHint")}</p>
					</div>
				)}
			</section>
			<section className="quick-ask-settings-group" aria-labelledby={id + "-prompts"}>
				<h3 className="quick-ask-settings-heading" id={id + "-prompts"}>
					{t("quickAskPrompts")}
				</h3>
				{PROMPTS.map(({ field, id: suffix, label, hint, reset, fallback }) => (
					<div className="quick-ask-settings-prompt" key={field}>
						<button
							type="button"
							className="quick-ask-settings-disclosure"
							aria-expanded={editing === field}
							aria-controls={id + "-" + suffix + "-editor"}
							onClick={() => toggleEditor(field)}
						>
							<span>{t(label)}</span>
							<span className="quick-ask-settings-preview">{drafts[field].trim() || t("quickAskPromptEmpty")}</span>
							<FiChevronDown aria-hidden="true" />
						</button>
						{editing === field && (
							<div className="quick-ask-settings-editor" id={id + "-" + suffix + "-editor"}>
								<textarea
									id={id + "-" + suffix}
									className="quick-ask-settings-textarea"
									rows={4}
									value={drafts[field]}
									placeholder={fallback}
									aria-label={t(label)}
									aria-describedby={id + "-" + suffix + "-hint"}
									onFocus={() => {
										focused.current = field;
									}}
									onChange={(e) => {
										const value = e.target.value;
										pendingDrafts.current[field] = field === "quickAskSystemPrompt" || value.trim() ? value : fallback;
										setDrafts((current) => ({ ...current, [field]: value }));
									}}
									onBlur={() => {
										focused.current = null;
										savePrompt(field);
									}}
								/>
								<div className="quick-ask-settings-editor-footer">
									<p className="quick-ask-settings-hint" id={id + "-" + suffix + "-hint"}>
										{t(hint, { defaultPrompt: fallback })}
									</p>
									<button
										type="button"
										className="quick-ask-settings-reset"
										disabled={drafts[field] === fallback && (settings[field] ?? fallback) === fallback}
										onClick={() => {
											delete pendingDrafts.current[field];
											setDrafts((current) => ({ ...current, [field]: fallback }));
											onChange({ [field]: fallback });
										}}
									>
										<FiRotateCcw aria-hidden="true" />
										{t(reset)}
									</button>
								</div>
							</div>
						)}
					</div>
				))}
			</section>
		</div>
	);
}
