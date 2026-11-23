import { join } from "node:path";
import type { SettingsFramePort } from "../packages/keel/src/contracts/settings.js";
import type { CoreSettingsSinks } from "../packages/keel/src/app/core-engine.js";
import { ApprovalRulesStore } from "../packages/keel/src/approval-rules.js";
import { SubagentTemplatesStore } from "../packages/keel/src/subagent-templates.js";
import { isTraditionalLocale, resolveServerLang } from "../packages/keel/src/i18n.js";
import type { ClientStateStore } from "./client-state.js";
import type { MarkerService } from "./marker-service.js";
import { SettingsService, type SettingsHost } from "./settings-service.js";

export interface CoreSettingsAdapterOptions extends CoreSettingsSinks {
	/** 设置落盘（`client-state.json` 的唯一写入者）：宿主进程里共用一个实例。 */
	stateStore: ClientStateStore;
	/** 标记开关（`disabledMarkers`）的落点；缺省 = 该键暂不支持（内核侧会发一次 warning）。 */
	markers?: MarkerService;
	/** 子代理模板库；缺省按老树同一路径 `stateStore.dataDir/subagent-templates.json` 构造。 */
	templates?: SubagentTemplatesStore;
	/** 审批规则库；缺省按老树同一路径 `stateStore.dataDir/approval-rules.json` 构造。 */
	approvalRules?: ApprovalRulesStore;
}

/** 会话句柄类型从 `SettingsHost` 推导，避免在这里再描述一遍 SDK 的会话实体。 */
type HostSession = ReturnType<SettingsHost["getSession"]>;

/**
 * 宿主侧组合适配器：构造宿主设置叶子 `SettingsService`（设置帧 / 预设 / 审批规则 / 模板），
 * 与 `MarkerService`（标记开关）、语言落盘一起拼成内核要的 `SettingsFramePort`。
 *
 * 构造也在这里：`SettingsService` 是宿主叶子，内核不认识它（P2 之前这份构造在 keel 里，
 * 现在内核只认 `SettingsFramePort` 窄面）。不重写任何语义：16 个设置面方法逐个直通
 * `SettingsService`；只有三件它没有的能力在这里补：标记开关、`applyRuntime`（`extensions_reload`）、
 * `setLocale`（语言落盘 + 必要时重应用）。
 */
export function createCoreSettingsAdapter(options: CoreSettingsAdapterOptions): SettingsFramePort {
	const { service, stateStore, clientId } = createCoreSettingsService(options);
	return {
		// 通道已关就不再出帧（P2 之前这道闸在 keel 的 pusher 里）。
		push: () => {
			if (options.isClosed()) return;
			service.push();
		},
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

/** 构造宿主设置叶子：模板 / 审批规则库按老树同一路径落在 `stateStore.dataDir` 下。 */
export function createCoreSettingsService(options: CoreSettingsAdapterOptions): {
	service: SettingsService;
	stateStore: ClientStateStore;
	clientId: string;
} {
	const templates =
		options.templates ?? new SubagentTemplatesStore(join(options.stateStore.dataDir, "subagent-templates.json"));
	const approvalRules =
		options.approvalRules ?? new ApprovalRulesStore(join(options.stateStore.dataDir, "approval-rules.json"));
	const service = new SettingsService(createCoreSettingsHost(options), templates, approvalRules);
	return { service, stateStore: options.stateStore, clientId: options.clientId };
}

/**
 * 把 `CoreSettingsSinks` 收窄成「只认注入值」的 `SettingsHost`：设置叶子（`SettingsService`）
 * 不认识新树的会话实体，只拿到这里如实投影出来的成员。apply* / reload* 一律走空实现——
 * 对应域还没接，抛错会让 `push()` 炸。
 */
export function createCoreSettingsHost(options: CoreSettingsAdapterOptions): SettingsHost {
	// 新树对应域未接，待 W5：apply* / reloadSession / promptSnapshot 只回安全空值，绝不抛。
	const notWired = (): void => {};
	return {
		clientId: options.clientId,
		stateStore: options.stateStore,
		emit: options.emit,
		flushSnapshot: () => options.flushSnapshot?.(),
		isDisposed: () => options.isDisposed(),
		getSession: () => options.getSession() as HostSession,
		getApprovalPolicy: () => options.getApprovalPolicy(),
		cwd: () => options.cwd,
		agentDir: () => options.agentDir,
		isStreaming: () => options.isStreaming(),
		reloadSession: async () => {},
		applyRetryOverrides: notWired,
		applyQueueModes: notWired,
		applyCompactionOverrides: notWired,
		applyCodemodeOverrides: notWired,
		applySessionOverrides: notWired,
		applyToolGating: notWired,
		onGoalModeDisabled: notWired,
		onSessionsFilterChanged: notWired,
		promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
		getMcpServers: () => ({ servers: [], globalPath: "", projectPath: "" }),
	};
}
