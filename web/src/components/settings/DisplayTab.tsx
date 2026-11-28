import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { FiMessageSquare, FiPlus, FiUpload, FiX } from "react-icons/fi";
import {
	saveChatWidthSettings,
	saveHideModelRowSettings,
	saveHideQuestionNavSettings,
	useHideModelRow,
	useHideQuestionNav,
	useWideChat,
} from "../../chat-width-settings";
import { saveSendKeyPref, useEffectiveSendKey, type SendKey } from "../../composer-keys";
import {
	DEFAULT_FAVICON_COLOR,
	PRESET_FAVICON_COLORS,
	sanitizeHexColor,
	saveFaviconSettings,
	useFaviconSettings,
} from "../../favicon-settings";
import { useT } from "../../i18n";
import { savePresentAutoOpen, usePresentAutoOpen } from "../../present-settings";
import { saveProjectClickSwitch, useProjectClickSwitch } from "../../project-click-settings";
import { saveProjectOrderManual, useProjectOrderManual } from "../../project-order-settings";
import { saveQuietModeSettings, useQuietMode } from "../../quiet-mode";
import type { ThemeInfo } from "../../theme";
import { saveTitleSettings, useProjectTitle } from "../../title-settings";
import { formatTokenDraft, parseTokenInput } from "../../token-input";
import type { UiSettingsState } from "../../types";
import { fileToWallpaperUrl, sanitizeWallpaperUrl, saveWallpaperSettings, useWallpaperSettings } from "../../wallpaper";
import { AuthSessionSection } from "../AuthSessionSection";
import { CommunityThemesSection } from "../CommunityThemesSection";
import { HintTip } from "../HintTip";
import { FieldRow } from "./FieldRow";
import { ToggleRow } from "./ToggleRow";

type DisplaySettingsSlice = Pick<
	UiSettingsState,
	| "questionPresentation"
	| "toolApprovalPresentation"
	| "questionTimeoutSeconds"
	| "chatUploadMaxMb"
	| "workspaceUploadMaxMb"
	| "folderUploadMaxMb"
	| "softCapTokens"
	| "softCapByModel"
	| "retryMaxAttempts"
	| "steeringMode"
	| "followUpMode"
	| "thinkingWrap"
	| "toolsWrap"
	| "toolImagesEnabled"
	| "keepRecentMessages"
	| "reversePagination"
	| "showForkedParentSessions"
	| "retainFinishedConversations"
	| "openRecentSessionOnProjectSwitch"
	| "minimalNewChat"
	| "preserveDraftAcrossConversations"
	| "parallelReminderEnabled"
	| "devNoCache"
	| "autoReload"
>;

/** 设置页「显示与体验」Tab：问答队列、认证会话、上下文预算、界面偏好、壁纸与社区主题。 */
export function DisplayTab({
	settings,
	onPatch,
	themes,
	currentTheme,
	onThemeChange,
	onReloadThemes,
}: {
	settings: DisplaySettingsSlice;
	onPatch: (patch: Partial<DisplaySettingsSlice>) => void;
	themes?: ThemeInfo[];
	currentTheme?: string | null;
	onThemeChange?: (id: string | null) => void;
	onReloadThemes?: () => void;
}) {
	const t = useT();
	const wideChat = useWideChat();
	const quietMode = useQuietMode();
	const hideModelRow = useHideModelRow();
	const hideQuestionNav = useHideQuestionNav();
	const effectiveSendKey = useEffectiveSendKey();
	const presentAutoOpen = usePresentAutoOpen();
	const projectClickSwitch = useProjectClickSwitch();
	const projectOrderManual = useProjectOrderManual();
	const projectTitle = useProjectTitle();
	const faviconSettings = useFaviconSettings();
	const wallpaper = useWallpaperSettings();

	const [wallpaperDraft, setWallpaperDraft] = useState(wallpaper.url);
	const wallpaperFocus = useRef(false);
	const wallpaperFileRef = useRef<HTMLInputElement>(null);
	const [wallpaperUploading, setWallpaperUploading] = useState(false);
	const [wallpaperUploadError, setWallpaperUploadError] = useState(false);
	useEffect(() => {
		if (!wallpaperFocus.current) setWallpaperDraft(wallpaper.url.startsWith("data:") ? "" : wallpaper.url);
	}, [wallpaper.url]);

	const onPickWallpaperFile = async (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (!file) return;
		setWallpaperUploading(true);
		setWallpaperUploadError(false);
		try {
			const url = await fileToWallpaperUrl(file);
			const clean = url ? sanitizeWallpaperUrl(url) : "";
			if (!clean) {
				setWallpaperUploadError(true);
				return;
			}
			setWallpaperDraft("");
			saveWallpaperSettings({ ...wallpaper, url: clean });
		} finally {
			setWallpaperUploading(false);
		}
	};

	const [retryDraft, setRetryDraft] = useState<string>(String(settings.retryMaxAttempts ?? 6));
	useEffect(() => {
		setRetryDraft(String(settings.retryMaxAttempts ?? 6));
	}, [settings.retryMaxAttempts]);

	const [keepRecentDraft, setKeepRecentDraft] = useState<string>(String(settings.keepRecentMessages ?? 15));
	useEffect(() => {
		setKeepRecentDraft(String(settings.keepRecentMessages ?? 15));
	}, [settings.keepRecentMessages]);

	const [softCapDraft, setSoftCapDraft] = useState<string>(
		settings.softCapTokens && settings.softCapTokens > 0 ? formatTokenDraft(settings.softCapTokens) : "",
	);
	useEffect(() => {
		setSoftCapDraft(
			settings.softCapTokens && settings.softCapTokens > 0 ? formatTokenDraft(settings.softCapTokens) : "",
		);
	}, [settings.softCapTokens]);
	const [newCapModel, setNewCapModel] = useState<string>("");
	const [newCapTokens, setNewCapTokens] = useState<string>("");

	return (
		<>
			<div className="set-section">
				<div className="set-section-title">{t("questionQueueTitle")}</div>
				<FieldRow label={t("questionPresentation")} tip={t("questionPresentationDesc")}>
					<select
						className="set-input"
						value={settings.questionPresentation ?? "queue"}
						onChange={(e) => onPatch({ questionPresentation: e.target.value as "queue" | "all" | "manual" })}
					>
						<option value="queue">{t("questionPresentationQueue")}</option>
						<option value="all">{t("questionPresentationAll")}</option>
						<option value="manual">{t("questionPresentationManual")}</option>
					</select>
				</FieldRow>
				<FieldRow label={t("toolApprovalPresentation")} tip={t("toolApprovalPresentationDesc")}>
					<select
						className="set-input"
						value={settings.toolApprovalPresentation ?? "all"}
						onChange={(e) => onPatch({ toolApprovalPresentation: e.target.value as "queue" | "all" | "manual" })}
					>
						<option value="queue">{t("questionPresentationQueue")}</option>
						<option value="all">{t("toolApprovalPresentationAll")}</option>
						<option value="manual">{t("questionPresentationManual")}</option>
					</select>
				</FieldRow>
				<FieldRow label={t("questionTimeoutSeconds")} tip={t("questionTimeoutSecondsDesc")}>
					<input
						className="set-input"
						type="number"
						min={0}
						max={86400}
						step={1}
						value={settings.questionTimeoutSeconds ?? 240}
						onChange={(e) => {
							const value = Number(e.target.value);
							if (Number.isSafeInteger(value) && value >= 0 && value <= 86400)
								onPatch({ questionTimeoutSeconds: value });
						}}
					/>
				</FieldRow>
			</div>

			<AuthSessionSection />

			<div className="set-section">
				<div className="set-section-title">
					<FiMessageSquare className="set-section-icon" />
					{t("settingsMessageDisplay")}
				</div>
				{(
					[
						["chatUploadMaxMb", 20],
						["workspaceUploadMaxMb", 100],
						["folderUploadMaxMb", 32],
					] as const
				).map(([key, fallback]) => (
					<FieldRow key={key} label={t(key)} tip={t("uploadMaxMbHint")} htmlFor={key}>
						<input
							id={key}
							className="set-input"
							type="number"
							min={1}
							max={100}
							step={1}
							value={settings[key] ?? fallback}
							onChange={(e) => {
								const n = e.target.valueAsNumber;
								if (Number.isInteger(n) && n >= 1 && n <= 100) onPatch({ [key]: n });
							}}
						/>
					</FieldRow>
				))}
				<FieldRow label={t("softCapTokens")} tip={t("softCapHint")} htmlFor="soft-cap-max">
					<input
						id="soft-cap-max"
						className="set-input"
						type="text"
						placeholder={t("softCapOff")}
						value={softCapDraft}
						onChange={(e) => setSoftCapDraft(e.target.value)}
						onBlur={() => {
							const n = parseTokenInput(softCapDraft);
							setSoftCapDraft(formatTokenDraft(n));
							if (n !== (settings.softCapTokens ?? 0)) {
								onPatch({ softCapTokens: n });
							}
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") (e.target as HTMLInputElement).blur();
						}}
					/>
				</FieldRow>
				<div className="set-section-title">
					{t("softCapByModel")}
					<HintTip text={t("softCapByModelHint")} />
				</div>
				<div className="set-preset-save">
					<input
						className="set-input"
						placeholder={t("softCapModelId")}
						value={newCapModel}
						maxLength={200}
						onChange={(e) => setNewCapModel(e.target.value)}
					/>
					<input
						className="set-input"
						type="text"
						placeholder={t("softCapTokens")}
						value={newCapTokens}
						onChange={(e) => setNewCapTokens(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && newCapModel.trim() && parseTokenInput(newCapTokens) > 0) {
								const n = parseTokenInput(newCapTokens);
								onPatch({
									softCapByModel: {
										...settings.softCapByModel,
										[newCapModel.trim()]: n,
									},
								});
								setNewCapModel("");
								setNewCapTokens("");
							}
						}}
					/>
					<button
						type="button"
						className="set-save-btn"
						disabled={!newCapModel.trim() || parseTokenInput(newCapTokens) <= 0}
						onClick={() => {
							const id = newCapModel.trim();
							const n = parseTokenInput(newCapTokens);
							if (!id || n <= 0) return;
							onPatch({ softCapByModel: { ...settings.softCapByModel, [id]: n } });
							setNewCapModel("");
							setNewCapTokens("");
						}}
					>
						<FiPlus /> {t("softCapAdd")}
					</button>
				</div>
				<div className="set-list">
					{Object.entries(settings.softCapByModel).map(([model, cap]) => (
						<div className="set-row" key={model}>
							<span className="set-row-name">{model}</span>
							<input
								className="set-input"
								type="text"
								defaultValue={formatTokenDraft(cap)}
								key={`${model}:${cap}`}
								onBlur={(e) => {
									const n = parseTokenInput(e.target.value);
									e.target.value = formatTokenDraft(n);
									const next = { ...settings.softCapByModel };
									if (n > 0) next[model] = n;
									else delete next[model];
									onPatch({ softCapByModel: next });
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter") (e.target as HTMLInputElement).blur();
								}}
							/>
							<button
								type="button"
								className="chip"
								title={t("softCapRemove")}
								onClick={() => {
									const next = { ...settings.softCapByModel };
									delete next[model];
									onPatch({ softCapByModel: next });
								}}
							>
								<FiX /> {t("softCapRemove")}
							</button>
						</div>
					))}
				</div>
				<FieldRow label={t("modelRetryAttempts")} tip={t("modelRetryHint")} htmlFor="model-retry-max">
					<input
						id="model-retry-max"
						className="set-input"
						type="number"
						min={0}
						max={100}
						step={1}
						value={retryDraft}
						onChange={(e) => setRetryDraft(e.target.value)}
						onBlur={() => {
							const n = Math.min(100, Math.max(0, Math.floor(Number(retryDraft) || 0)));
							setRetryDraft(String(n));
							if (n !== settings.retryMaxAttempts) {
								onPatch({ retryMaxAttempts: n });
							}
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") (e.target as HTMLInputElement).blur();
						}}
					/>
				</FieldRow>
				<ToggleRow
					title={t("steeringDeliverAll")}
					tip={t("steeringDeliverAllDesc")}
					enabled={settings.steeringMode !== "one-at-a-time"}
					onToggle={() =>
						onPatch({
							steeringMode: settings.steeringMode === "one-at-a-time" ? "all" : "one-at-a-time",
						})
					}
				/>
				<ToggleRow
					title={t("followUpDeliverAll")}
					tip={t("followUpDeliverAllDesc")}
					enabled={settings.followUpMode !== "one-at-a-time"}
					onToggle={() =>
						onPatch({
							followUpMode: settings.followUpMode === "one-at-a-time" ? "all" : "one-at-a-time",
						})
					}
				/>
				<ToggleRow
					title={t("thinkingWrap")}
					tip={t("thinkingWrapDesc")}
					enabled={settings.thinkingWrap ?? true}
					onToggle={() => onPatch({ thinkingWrap: !(settings.thinkingWrap ?? true) })}
				/>
				<ToggleRow
					title={t("toolsWrap")}
					tip={t("toolsWrapDesc")}
					enabled={settings.toolsWrap ?? true}
					onToggle={() => onPatch({ toolsWrap: !(settings.toolsWrap ?? true) })}
				/>
				<ToggleRow
					title={t("toolImages")}
					tip={t("toolImagesDesc")}
					enabled={settings.toolImagesEnabled ?? true}
					onToggle={() => onPatch({ toolImagesEnabled: !(settings.toolImagesEnabled ?? true) })}
				/>
				<FieldRow label={t("keepRecent")} tip={t("keepRecentDesc")} htmlFor="keep-recent">
					<input
						id="keep-recent"
						className="set-input"
						type="number"
						min={5}
						max={100}
						step={1}
						value={keepRecentDraft}
						onChange={(e) => setKeepRecentDraft(e.target.value)}
						onBlur={() => {
							const n = Math.min(100, Math.max(5, Math.floor(Number(keepRecentDraft) || 15)));
							setKeepRecentDraft(String(n));
							if (n !== settings.keepRecentMessages) {
								onPatch({ keepRecentMessages: n });
							}
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") (e.target as HTMLInputElement).blur();
						}}
					/>
				</FieldRow>
				<ToggleRow
					title={t("reversePagination")}
					tip={t("reversePaginationDesc")}
					enabled={settings.reversePagination ?? false}
					onToggle={() => onPatch({ reversePagination: !(settings.reversePagination ?? false) })}
				/>
				<ToggleRow
					title={t("showForkedParents")}
					tip={t("showForkedParentsDesc")}
					enabled={settings.showForkedParentSessions ?? false}
					onToggle={() => onPatch({ showForkedParentSessions: !(settings.showForkedParentSessions ?? false) })}
				/>
				<ToggleRow
					title={t("retainFinishedConversations")}
					tip={t("retainFinishedConversationsDesc")}
					enabled={settings.retainFinishedConversations ?? false}
					onToggle={() =>
						onPatch({
							retainFinishedConversations: !(settings.retainFinishedConversations ?? false),
						})
					}
				/>
				<ToggleRow
					title={t("openRecentSessionOnProjectSwitch")}
					tip={t("openRecentSessionOnProjectSwitchDesc")}
					enabled={settings.openRecentSessionOnProjectSwitch ?? true}
					onToggle={() =>
						onPatch({
							openRecentSessionOnProjectSwitch: !(settings.openRecentSessionOnProjectSwitch ?? true),
						})
					}
				/>
				<ToggleRow
					title={t("projectClickSwitch")}
					tip={t("projectClickSwitchDesc")}
					enabled={projectClickSwitch}
					onToggle={() => saveProjectClickSwitch(!projectClickSwitch)}
				/>{" "}
				<ToggleRow
					title={t("projectOrderManual")}
					tip={t("projectOrderManualDesc")}
					enabled={projectOrderManual}
					onToggle={() => saveProjectOrderManual(!projectOrderManual)}
				/>{" "}
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
				<FieldRow label={t("sendKeyMode")} tip={t("sendKeyModeDesc")} htmlFor="send-key-mode">
					<select
						id="send-key-mode"
						className="set-select"
						value={effectiveSendKey}
						onChange={(e) => saveSendKeyPref(e.target.value as SendKey)}
					>
						<option value="enter">{t("sendKeyEnter")}</option>
						<option value="mod-enter">{t("sendKeyModEnter")}</option>
					</select>
				</FieldRow>
				<ToggleRow
					title={t("presentAutoOpen")}
					tip={t("presentAutoOpenDesc")}
					enabled={presentAutoOpen}
					onToggle={() => savePresentAutoOpen(!presentAutoOpen)}
				/>
				<ToggleRow
					title={t("parallelReminderEnabled")}
					tip={`${t("parallelReminderEnabledDesc")}\n${t("parallelReminderOffHint")}`}
					enabled={settings.parallelReminderEnabled ?? true}
					onToggle={() => onPatch({ parallelReminderEnabled: !(settings.parallelReminderEnabled ?? true) })}
				/>
				<ToggleRow
					title={t("devNoCache")}
					tip={t("devNoCacheDesc")}
					enabled={settings.devNoCache ?? true}
					onToggle={() => onPatch({ devNoCache: !(settings.devNoCache ?? true) })}
				/>
				<ToggleRow
					title={t("autoReload")}
					tip={t("autoReloadDesc")}
					enabled={settings.autoReload ?? true}
					onToggle={() => onPatch({ autoReload: !(settings.autoReload ?? true) })}
				/>
				<hr className="set-sep" />
				<ToggleRow
					title={t("wideChat")}
					tip={t("wideChatDesc")}
					enabled={wideChat}
					onToggle={() => saveChatWidthSettings({ wide: !wideChat })}
				/>
				<ToggleRow
					title={t("hideModelRow")}
					tip={t("hideModelRowDesc")}
					enabled={hideModelRow}
					onToggle={() => saveHideModelRowSettings({ hide: !hideModelRow })}
				/>
				<ToggleRow
					title={t("hideQuestionNav")}
					tip={t("hideQuestionNavDesc")}
					enabled={hideQuestionNav}
					onToggle={() => saveHideQuestionNavSettings({ hide: !hideQuestionNav })}
				/>
				<ToggleRow
					title={t("quietMode")}
					tip={t("quietModeDesc")}
					enabled={quietMode.enabled}
					onToggle={() => saveQuietModeSettings({ ...quietMode, enabled: !quietMode.enabled })}
				/>
				{quietMode.enabled && (
					<FieldRow label={t("quietModeStyle")} htmlFor="quiet-style">
						<select
							id="quiet-style"
							className="set-select"
							value={quietMode.style}
							onChange={(e) =>
								saveQuietModeSettings({ ...quietMode, style: e.target.value === "zero" ? "zero" : "fold" })
							}
						>
							<option value="fold">{t("quietStyleFold")}</option>
							<option value="zero">{t("quietStyleZero")}</option>
						</select>
					</FieldRow>
				)}
				<ToggleRow
					title={t("projectTitle")}
					tip={t("projectTitleDesc")}
					enabled={projectTitle}
					onToggle={() => saveTitleSettings({ projectName: !projectTitle })}
				/>
				<hr className="set-sep" />
				<div className="set-row">
					<div className="set-row-info">
						<div className="set-row-name">
							{t("instanceName")}
							<HintTip text={t("instanceNameDesc")} />
						</div>
						<div style={{ marginTop: "6px" }}>
							<input
								className="set-input"
								style={{ maxWidth: "260px" }}
								placeholder={t("instanceNamePh")}
								value={faviconSettings.instanceName ?? ""}
								maxLength={50}
								spellCheck={false}
								onChange={(e) => saveFaviconSettings({ ...faviconSettings, instanceName: e.target.value })}
							/>
						</div>
					</div>
				</div>
				<div className="set-row">
					<div className="set-row-info">
						<div className="set-row-name">
							{t("faviconColor")}
							<HintTip text={t("faviconColorDesc")} />
						</div>
						<div className="favicon-picker-row">
							<button
								type="button"
								className={`favicon-swatch ${faviconSettings.color === "default" ? "active" : ""}`}
								title={t("themeDefault")}
								onClick={() => saveFaviconSettings({ ...faviconSettings, color: "default" })}
							>
								<span className="favicon-dot" style={{ background: DEFAULT_FAVICON_COLOR }} />
								<span className="favicon-label">{t("themeDefault")}</span>
							</button>
							<button
								type="button"
								className={`favicon-swatch ${faviconSettings.color === "auto" ? "active" : ""}`}
								title={t("faviconColorAuto")}
								onClick={() => saveFaviconSettings({ ...faviconSettings, color: "auto" })}
							>
								<span className="favicon-dot favicon-dot-auto" />
								<span className="favicon-label">{t("faviconColorAuto")}</span>
							</button>
							{PRESET_FAVICON_COLORS.filter((p) => p.id !== "violet").map((preset) => (
								<button
									key={preset.id}
									type="button"
									className={`favicon-swatch ${faviconSettings.color === preset.id ? "active" : ""}`}
									title={preset.hex}
									onClick={() => saveFaviconSettings({ ...faviconSettings, color: preset.id })}
								>
									<span className="favicon-dot" style={{ background: preset.hex }} />
								</button>
							))}
							<div className="favicon-custom-wrap">
								<input
									type="color"
									className="favicon-color-input"
									value={sanitizeHexColor(faviconSettings.customHex) || "#3b82f6"}
									title={t("customColor")}
									onChange={(e) =>
										saveFaviconSettings({
											...faviconSettings,
											color: "custom",
											customHex: e.target.value,
										})
									}
								/>
							</div>
						</div>
					</div>
				</div>
				<hr className="set-sep" />
				<div className="set-row">
					<div className="set-row-info">
						<div className="set-row-name">
							{t("wallpaperTitle")}
							<HintTip text={t("wallpaperDesc")} />
						</div>
						<div className="wallpaper-url-row">
							<input
								className="set-input wallpaper-url"
								placeholder={t("wallpaperUrlPh")}
								value={wallpaperDraft}
								maxLength={2000}
								spellCheck={false}
								onFocus={() => {
									wallpaperFocus.current = true;
								}}
								onChange={(e) => setWallpaperDraft(e.target.value)}
								onBlur={() => {
									wallpaperFocus.current = false;
									if (!wallpaperDraft.trim() && wallpaper.url.startsWith("data:")) {
										setWallpaperDraft("");
										return;
									}
									const url = sanitizeWallpaperUrl(wallpaperDraft);
									setWallpaperDraft(url);
									if (url !== wallpaper.url) saveWallpaperSettings({ ...wallpaper, url });
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter") (e.target as HTMLInputElement).blur();
									else if (e.key === "Escape") {
										setWallpaperDraft(wallpaper.url.startsWith("data:") ? "" : wallpaper.url);
										(e.target as HTMLInputElement).blur();
									}
								}}
							/>
							<button
								type="button"
								className="set-save-btn"
								disabled={wallpaperUploading}
								onClick={() => wallpaperFileRef.current?.click()}
							>
								<FiUpload /> {t("wallpaperUpload")}
							</button>
							<input ref={wallpaperFileRef} type="file" accept="image/*" hidden onChange={onPickWallpaperFile} />
						</div>
						{wallpaperUploadError && <p className="set-hint">{t("wallpaperUploadFailed")}</p>}
						<div className="wallpaper-sliders">
							<label className="wallpaper-slider">
								<span>{t("wallpaperDim")}</span>
								<input
									type="range"
									min={0}
									max={95}
									step={1}
									value={wallpaper.dim}
									onChange={(e) => saveWallpaperSettings({ ...wallpaper, dim: Number(e.target.value) })}
								/>
								<output>{wallpaper.dim}%</output>
							</label>
							<label className="wallpaper-slider">
								<span>{t("wallpaperBlur")}</span>
								<input
									type="range"
									min={0}
									max={24}
									step={1}
									value={wallpaper.blur}
									onChange={(e) => saveWallpaperSettings({ ...wallpaper, blur: Number(e.target.value) })}
								/>
								<output>{wallpaper.blur}px</output>
							</label>
						</div>
					</div>
					{wallpaper.url && (
						<div className="wallpaper-current">
							<img className="wallpaper-preview" src={wallpaper.url} alt="" />
							<button
								type="button"
								className="wallpaper-clear"
								onClick={() => {
									setWallpaperDraft("");
									saveWallpaperSettings({ ...wallpaper, url: "" });
								}}
							>
								{t("wallpaperClear")}
							</button>
						</div>
					)}
				</div>
				{onThemeChange && onReloadThemes && (
					<>
						<hr className="set-sep" />
						<CommunityThemesSection
							themes={themes ?? []}
							currentTheme={currentTheme ?? null}
							onThemeChange={onThemeChange}
							onReloadThemes={onReloadThemes}
						/>
					</>
				)}
			</div>
		</>
	);
}
