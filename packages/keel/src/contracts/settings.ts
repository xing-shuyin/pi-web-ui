import type { ClientMessage, ThinkingLevel, UiApprovalRule, UiLayoutPrefs, UiSubagentTemplate } from "../protocol.js";

/** 提示词装配模式：协议里没有命名类型，只能就地取那两个字面量。 */
type PromptMode = "append" | "replace";

/** 预设导入导出走的就是协议里的原消息，内核不改形状（端口实现直接吃这一条）。 */
export type PresetExportMessage = Extract<ClientMessage, { type: "preset_export" }>;
export type PresetImportMessage = Extract<ClientMessage, { type: "preset_import" }>;
export type PresetImportUrlMessage = Extract<ClientMessage, { type: "preset_import_url" }>;
export type PresetCatalogMessage = Extract<ClientMessage, { type: "preset_catalog" }>;
export type PresetShareMessage = Extract<ClientMessage, { type: "preset_share" }>;

/** `setSettings` 的可写键：协议面允许的字段（与 `ClientSettings` 的交集由宿主归一）。 */
export interface SettingsPatchInput {
	promptMode?: PromptMode;
	customSystemPrompt?: string;
	promptTemplate?: string;
	promptOverrides?: Record<string, string>;
	disabledSkills?: string[];
	disabledExtensions?: string[];
	disabledPlugins?: string[];
	disabledMarkers?: string[];
	uiLayout?: UiLayoutPrefs;
	terminalToolsEnabled?: boolean;
	terminalBash?: boolean;
	terminalBashIdleMs?: number;
	terminalBashMaxForegroundMs?: number;
	thinkingWrap?: boolean;
	toolsWrap?: boolean;
	toolImagesEnabled?: boolean;
	keepRecentMessages?: number;
	showForkedParentSessions?: boolean;
	visionBridgeEnabled?: boolean;
	visionBridgeModel?: string | null;
	visionBridgePromptMode?: PromptMode;
	visionBridgePrompt?: string;
	scmCommitMsgPromptMode?: PromptMode;
	scmCommitMsgPrompt?: string;
	quickAskEnabled?: boolean;
	quickAskModel?: string | null;
	quickAskThinking?: ThinkingLevel;
	botDraftModel?: string | null;
	botDraftThinking?: ThinkingLevel;
	quickAskSystemPrompt?: string;
	quickAskExplainPrompt?: string;
	reviewPrompt?: string;
	reviewDisabledSkills?: string[];
	[key: string]: unknown;
}

/**
 * 设置帧 + 预设 + 审批规则库的宿主面。
 *
 * 实现就是宿主现成的 `SettingsService`（`server/settings-service.ts`，1347 行，含 settings_state 帧、
 * 预设 CRUD/导入导出/分享、审批规则库、子代理模板）；内核不重写它，只按这个窄面调用。
 * 宿主侧组合适配器：`server/core-settings-adapter.ts`（再把标记开关接上）。
 */
export interface SettingsFramePort {
	/** 重算并下发一帧 `settings_state`。 */
	push(): void;
	/** 刷新资源发现（技能 / 扩展 / 插件）后由实现自己决定是否出帧。 */
	refreshResources(): void;
	/** 落盘 + 应用补丁（归一化在宿主，内核只按位转发）。 */
	set(partial: Record<string, unknown>): Promise<void>;

	savePreset(name: string, groups?: readonly string[]): Promise<void>;
	applyPreset(name: string): Promise<void>;
	deletePreset(name: string): Promise<void>;
	exportPreset(msg: PresetExportMessage): Promise<void>;
	importPreset(msg: PresetImportMessage): Promise<void>;
	importPresetFromUrl(msg: PresetImportUrlMessage): Promise<void>;
	pushPresetCatalog(msg: PresetCatalogMessage): Promise<void>;
	sharePreset(msg: PresetShareMessage): Promise<void>;

	saveApprovalRule(rule: UiApprovalRule): Promise<void>;
	saveApprovalRules(rules: UiApprovalRule[]): Promise<void>;
	deleteApprovalRule(id: string): Promise<void>;
	resetBuiltinApprovalRule(id: string): Promise<void>;

	saveTemplate(template: UiSubagentTemplate): Promise<void>;
	deleteTemplate(name: string): Promise<void>;
	/**
	 * 子代理模板（生效值，与设置帧 `subagentTemplates` 同一份投影）：
	 * `conversation` 工具的模板清单、`template` 参数合法性、派发时的档位都读它。
	 */
	subagentTemplates(): readonly UiSubagentTemplate[];

	/** 标记开关归宿主的 `MarkerService`（P4 才进内核）；缺省 = 该能力未接。 */
	setDisabledMarkers?(names: string[]): void;
	/** 重应用运行时设置（`extensions_reload` 用）；缺省 = 该能力未接。 */
	applyRuntime?(): Promise<void>;
	/** 切语言（落盘 + 必要时重应用）；缺省 = 该能力未接。 */
	setLocale?(locale: string): Promise<void>;
}
