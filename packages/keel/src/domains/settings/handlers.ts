import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type {
	PresetCatalogMessage,
	PresetExportMessage,
	PresetImportMessage,
	PresetImportUrlMessage,
	PresetShareMessage,
	SettingsFramePort,
	SettingsPatchInput,
} from "../../contracts/settings.js";
import type { TransportPort } from "../../contracts/ports.js";
import type { UiApprovalRule, UiSubagentTemplate } from "../../protocol.js";

export interface SettingsHandlersOptions {
	/** 缺省 = 未接：每个 handler 调到时同步抛 `CoreEngineNotReadyError`。thunk 是防循环装配。 */
	settings?: () => SettingsFramePort | undefined;
	transport: TransportPort;
	/** 出快照（标记变更后老实现会刷一次）。缺省不发。 */
	flushSnapshot?(): void;
	/** 「关闭审批」时把待审批一次性放行；缺省 = 没有审批队列可结算。 */
	releasePendingApprovals?(reason: string): number;
}

/** 设置 / 预设 / 审批规则库的 16 个 handler：全部转发给宿主 `SettingsService` 面。 */
export interface SettingsHandlers {
	setSettings(partial: SettingsPatchInput): Promise<void>;
	refreshSettings(): void;
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
	saveSubagentTemplate(template: UiSubagentTemplate): Promise<void>;
	deleteSubagentTemplate(name: string): Promise<void>;
	reloadExtensions(): Promise<void>;
	setLocale(locale: string): Promise<void>;
}

/**
 * 设置补丁的真实语义在宿主 `SettingsService.set()`（归一化 + 落盘 + 出帧），这里只补三件
 * 内核才知道的事：标记开关走另一条通道、关掉审批要放行待审批、标记变更后要刷快照。
 */
export function createSettingsHandlers(options: SettingsHandlersOptions): SettingsHandlers {
	const notice = (level: "info" | "warning" | "error", text: string, textEn: string): void => {
		if (options.transport.isClosed()) return;
		options.transport.send({ type: "notice", level, text, textEn });
	};
	const port = (what: string): SettingsFramePort => {
		const settings = options.settings?.();
		if (!settings) throw new CoreEngineNotReadyError(what);
		return settings;
	};
	let warnedMarkers = false;

	/** `setSettings` 的真体：三件内核才知道的事（标记另一条通道 / 关审批要放行 / 标记变更刷快照）。 */
	const applySettings = async (settings: SettingsFramePort, partial: SettingsPatchInput): Promise<void> => {
		const { disabledMarkers, ...rest } = partial;
		let markerChanged = false;
		if (disabledMarkers !== undefined) {
			if (settings.setDisabledMarkers) {
				settings.setDisabledMarkers(disabledMarkers);
				markerChanged = true;
			} else if (!warnedMarkers) {
				// 不静默丢键：标记开关归宿主 MarkerService（P4 才进内核），这里明说一次。
				warnedMarkers = true;
				notice(
					"warning",
					"标记开关在当前引擎暂不支持，其余设置已保存",
					"Marker toggles are not supported by this engine yet; other settings were saved",
				);
			}
		}
		// 落盘 + 归一化 + 出帧都由宿主一处完成（老实现同样不在这里补帧）。
		await settings.set(rest as Record<string, unknown>);
		if (rest.toolApprovalEnabled === false) {
			options.releasePendingApprovals?.("审批已全局关闭 / Tool approval was disabled globally");
		}
		if (markerChanged) {
			settings.push();
			options.flushSnapshot?.();
		}
	};

	return {
		// 不用 `async` 包：端口缺失的抛错必须是**同步**的（与注册表口径一致，不能变成 rejected promise）。
		setSettings(partial: SettingsPatchInput): Promise<void> {
			const settings = port("setSettings");
			return applySettings(settings, partial ?? {});
		},

		refreshSettings(): void {
			port("refreshSettings").refreshResources();
		},

		savePreset: (name, groups) => port("savePreset").savePreset(name, groups),
		applyPreset: (name) => port("applyPreset").applyPreset(name),
		deletePreset: (name) => port("deletePreset").deletePreset(name),
		exportPreset: (msg) => port("exportPreset").exportPreset(msg),
		importPreset: (msg) => port("importPreset").importPreset(msg),
		importPresetFromUrl: (msg) => port("importPresetFromUrl").importPresetFromUrl(msg),
		pushPresetCatalog: (msg) => port("pushPresetCatalog").pushPresetCatalog(msg),
		sharePreset: (msg) => port("sharePreset").sharePreset(msg),

		saveApprovalRule: (rule) => port("saveApprovalRule").saveApprovalRule(rule),
		saveApprovalRules: (rules) => port("saveApprovalRules").saveApprovalRules(rules),
		deleteApprovalRule: (id) => port("deleteApprovalRule").deleteApprovalRule(id),
		resetBuiltinApprovalRule: (id) => port("resetBuiltinApprovalRule").resetBuiltinApprovalRule(id),

		saveSubagentTemplate: (template) => port("saveSubagentTemplate").saveTemplate(template),
		deleteSubagentTemplate: (name) => port("deleteSubagentTemplate").deleteTemplate(name),

		// 失败不漏：`applyRuntime` 自己会发「已应用 / 应用失败」两种 notice（`settings-service.ts:1301`）。
		async reloadExtensions(): Promise<void> {
			const settings = port("reloadExtensions");
			if (!settings.applyRuntime) throw new CoreEngineNotReadyError("reloadExtensions.applyRuntime");
			await settings.applyRuntime();
		},

		async setLocale(locale: string): Promise<void> {
			const settings = port("setLocale");
			if (!settings.setLocale) throw new CoreEngineNotReadyError("setLocale");
			await settings.setLocale(locale);
		},
	};
}
