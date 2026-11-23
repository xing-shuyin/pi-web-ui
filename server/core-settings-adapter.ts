import { isTraditionalLocale, resolveServerLang, type ServerLang } from "../packages/keel/src/i18n.js";
import type { SettingsFramePort } from "../packages/keel/src/contracts/settings.js";
import type { ClientStateStore } from "./client-state.js";
import type { MarkerService } from "./marker-service.js";
import type { SettingsService } from "./settings-service.js";

export interface CoreSettingsAdapterOptions {
	service: SettingsService;
	stateStore: ClientStateStore;
	clientId: string;
	/** 标记开关（`disabledMarkers`）的落点；缺省 = 该键暂不支持（内核侧会发一次 warning）。 */
	markers?: MarkerService;
	/** 当前语言：由宿主持有（`SettingsService` 只管读，写口在引擎里）。 */
	lang: { get(): ServerLang; set(next: ServerLang): void };
}

/**
 * 宿主侧组合适配器：把现成的 `SettingsService`（设置帧 / 预设 / 审批规则 / 模板）与
 * `MarkerService`（标记开关）、语言落盘拼成内核要的 `SettingsFramePort`。
 *
 * 不重写任何语义：16 个设置面方法逐个直通 `SettingsService`；只有三件它没有的能力在这里补：
 * 标记开关、`applyRuntime`（`extensions_reload`）、`setLocale`（语言落盘 + 必要时重应用）。
 */
export function createCoreSettingsAdapter(options: CoreSettingsAdapterOptions): SettingsFramePort {
	const { service, stateStore, clientId } = options;
	return {
		push: () => service.push(),
		refreshResources: () => service.refreshResources(),
		set: (partial) => service.set(partial as Parameters<SettingsService["set"]>[0]),

		savePreset: (name, groups) => service.savePreset(name, groups),
		applyPreset: (name) => service.applyPreset(name),
		deletePreset: (name) => service.deletePreset(name),
		exportPreset: (msg) => service.exportPreset(msg),
		importPreset: (msg) => service.importPreset(msg),
		importPresetFromUrl: (msg) => service.importPresetFromUrl(msg),
		pushPresetCatalog: (msg) => service.pushPresetCatalog(msg),
		sharePreset: (msg) => service.sharePreset(msg),

		saveApprovalRule: (rule) => service.saveApprovalRule(rule),
		saveApprovalRules: (rules) => service.saveApprovalRules(rules),
		deleteApprovalRule: (id) => service.deleteApprovalRule(id),
		resetBuiltinApprovalRule: (id) => service.resetBuiltinApprovalRule(id),

		saveTemplate: (template) => service.saveTemplate(template),
		deleteTemplate: (name) => service.deleteTemplate(name),

		applyRuntime: () => service.applyRuntime(),
		setDisabledMarkers: options.markers ? (names) => options.markers?.setDisabledMarkers(names) : undefined,
		async setLocale(locale: string): Promise<void> {
			const code = locale.trim().slice(0, 16);
			if (!code) return;
			const prev = options.lang.get();
			const wasTraditional = isTraditionalLocale(options.lang.get());
			stateStore.saveLocale(clientId, code);
			const next = resolveServerLang(code);
			options.lang.set(next);
			// 语言族没变（同语种）：只需重发设置帧；换了语言族才要重应用运行时设置。
			if (next === prev) {
				if (isTraditionalLocale(code) !== wasTraditional) service.push();
				return;
			}
			await service.applyRuntime();
		},
	};
}
