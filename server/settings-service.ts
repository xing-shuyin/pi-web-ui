import { existsSync, readFileSync } from "node:fs";
import { normalizeNativeCliInheritModel, type NativeCliInheritModel } from "./engine-catalog.js";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { mergeQuickAskSettings, normalizeQuickAskSettings, type QuickAskSettings } from "./quick-ask-settings.js";
import type {
	ClientMessage,
	QueueMode,
	ServerMessage,
	UiApprovalPolicyState,
	UiApprovalRule,
	UiExtensionInfo,
	UiLayoutPrefs,
	UiSettingsState,
	UiSkillInfo,
	UiToolPromptOverride,
	UiVisionBridgeModel,
} from "./protocol.js";
import {
	extensionKey,
	isInternalExtension,
	normalizeBgCleanupMinutes,
	normalizeDisabledPluginTools,
	normalizeRetryMaxAttempts,
	normalizeKeepRecentMessages,
	normalizeSkillList,
	normalizeSkillsCatalogBudget,
	normalizeSkillsCatalogMaxDesc,
	normalizeSkillsFullTextMaxBytes,
	normalizeSkillsMaxFileBytes,
	normalizeToolWatchdogTimeoutMs,
	normalizeUiLayout,
	defaultSubagentAutoWakeMaxTurns,
	normalizeSubagentAutoWakeMaxTurns,
	settingsPresetToUi,
	type ClientStateStore,
	type SharedSettingsChange,
	type ClientSettings,
	type PromptMode,
} from "./client-state.js";
import { normalizeAutoCompactionInstructions, normalizeSoftCapByModel, normalizeSoftCapTokens } from "./soft-cap.js";
import { findVisionModels, SYSTEM_PROMPT } from "./vision-bridge.js";
import { COMMITMSG_SYSTEM_PROMPT } from "./scm-commitmsg.js";
import { PLAN_MODE_SYSTEM_PROMPT } from "./plan-mode.js";
import { DEFAULT_TEMPLATES, localizeTemplate, type SubagentTemplatesStore } from "./subagent-templates.js";
import { discoverDiskSkills, isSkillStillOnDisk, type DiscoveredSkill } from "./skill-discovery.js";
import type { ApprovalRulesStore } from "./approval-rules.js";
import { deriveLegacy, foldLegacyIntoDisabled, normalizeDisabledAgentTools } from "./tool-manager.js";
import { normalizeToolPromptOverrides } from "./tool-prompt-overrides.js";
import { resolveServerLang, type ServerLang } from "./i18n.js";
import {
	exportPresetVia,
	importPresetFromUrlVia,
	importPresetVia,
	packageVersion,
	pushPresetCatalogVia,
	sharePresetVia,
	type PresetSharePort,
} from "./preset-share.js";

export interface MarkerStateForSettings {
	markersEnabled: boolean;
	disabledMarkers: string[];
	markers: import("./protocol.js").UiMarkerInfo[];
}

export interface SettingsRuntimeTarget {
	isStreaming: () => boolean;
	reloadSession: () => Promise<void>;
}

export interface SettingsHost {
	clientId: string;
	stateStore: ClientStateStore;
	emit: (msg: ServerMessage) => void;
	flushSnapshot: () => void;
	isDisposed: () => boolean;
	getSession: () => AgentSession;
	cwd: () => string;
	agentDir: () => string;
	filterDiskSkills?: (skills: DiscoveredSkill[]) => DiscoveredSkill[];
	isStreaming: () => boolean;
	reloadSession: () => Promise<void>;
	applyRetryOverrides: () => void;
	applyQueueModes?: () => void;
	applyCompactionOverrides: () => void;
	applyCodemodeOverrides?: () => void;
	applySessionOverrides?: () => void;
	applyToolGating: () => void;
	promptSnapshot: () => { full: string; texts: Record<string, string>; toolsSchema: string };
	getMarkerState?: () => MarkerStateForSettings;
	getApprovalPolicy?: () => UiApprovalPolicyState;
	onGoalModeDisabled?: () => void;
	onSessionsFilterChanged?: () => void;
	getMcpServers?: () => {
		servers: import("./protocol.js").UiMcpServer[];
		globalPath: string;
		projectPath: string;
	};
	getLocale?: () => string | undefined;
}

export class SettingsService {
	private settings: ClientSettings;
	private presets: SettingsPreset[];
	private knownSkills = new Map<string, UiSkillInfo>();
	private knownExtensions = new Map<string, UiExtensionInfo>();
	private pendingReload = false;
	private readonly pendingRuntimeReloads = new Set<SettingsRuntimeTarget>();
	private unsubscribeSettings?: () => void;
	private sharedVersion = 0;
	private sharedQueue = Promise.resolve();
	private committingSettings = false;
	private disposed = false;

	constructor(
		private readonly host: SettingsHost,
		private readonly templates: SubagentTemplatesStore,
		private readonly approvalRules?: ApprovalRulesStore,
	) {
		this.settings = host.stateStore.getSettings(host.clientId);
		this.presets = host.stateStore.getPresets(host.clientId);
	}

	get current(): ClientSettings {
		return (
			this.host.stateStore.getSettingsSnapshot?.(this.host.clientId) ??
			this.host.stateStore.getSettings(this.host.clientId)
		);
	}

	subscribeSharedSettings(): void {
		if (this.unsubscribeSettings || this.disposed) return;
		this.sharedVersion = this.host.stateStore.getSettingsVersion();
		this.unsubscribeSettings = this.host.stateStore.subscribeSettings((change) => {
			if (this.committingSettings) {
				this.sharedVersion = Math.max(this.sharedVersion, change.version);
				return;
			}
			return this.receiveSharedSettings(change);
		});
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribeSettings?.();
		this.unsubscribeSettings = undefined;
		this.pendingReload = false;
		this.pendingRuntimeReloads.clear();
	}

	receiveSharedSettings(change: SharedSettingsChange): Promise<void> {
		if (this.disposed || this.host.isDisposed() || change.version <= this.sharedVersion) return this.sharedQueue;
		this.sharedVersion = change.version;
		this.sharedQueue = this.sharedQueue
			.then(async () => {
				if (this.disposed || this.host.isDisposed()) return;
				await this.applySharedSettings(change.before, change.settings);
			})
			.catch((error) => {
				if (this.disposed || this.host.isDisposed()) return;
				console.error("[settings] shared settings apply failed:", error);
				this.host.emit({
					type: "notice",
					level: "error",
					text: "共享设置已保存，但当前会话应用失败，请重试或重新加载会话。",
					textEn: "Shared settings were saved, but could not be applied to this session. Retry or reload the session.",
				});
			});
		return this.sharedQueue;
	}

	private async applySharedSettings(before: ClientSettings, after: ClientSettings): Promise<void> {
		const changed = (...keys: (keyof ClientSettings)[]) =>
			keys.some((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
		if (changed("retryMaxAttempts")) this.host.applyRetryOverrides();
		if (changed("steeringMode", "followUpMode")) this.host.applyQueueModes?.();
		if (changed("softCapTokens", "softCapByModel")) this.host.applyCompactionOverrides();
		if (changed("codemodeMode", "codemodeInlineBudget")) this.host.applyCodemodeOverrides?.();
		if (
			changed(
				"disabledAgentTools",
				"disabledPluginTools",
				"disabledPlugins",
				"toolPromptOverrides",
				"toolLazyLoading",
				"terminalToolsEnabled",
				"editSoftEnabled",
				"questionnaireEnabled",
			)
		)
			this.host.applyToolGating();
		if (before.goalModeEnabled !== false && after.goalModeEnabled === false) this.host.onGoalModeDisabled?.();
		if (changed("showForkedParentSessions")) this.host.onSessionsFilterChanged?.();
		this.push();
		this.host.flushSnapshot();
		if (
			changed(
				"promptMode",
				"customSystemPrompt",
				"promptTemplate",
				"promptOverrides",
				"promptDisabled",
				"disabledSkills",
				"disabledExtensions",
			)
		)
			await this.applyRuntime();
	}

	private commitSettings(patch: Partial<ClientSettings>): void {
		this.committingSettings = true;
		try {
			this.host.stateStore.saveSettings(this.host.clientId, patch);
			this.settings = this.host.stateStore.getSettings(this.host.clientId);
		} catch (error) {
			this.settings = this.host.stateStore.getSettings(this.host.clientId);
			this.host.emit({
				type: "notice",
				level: "error",
				text: "设置保存失败，修改未生效。请检查磁盘空间和文件权限后重试。",
				textEn: "Settings were not saved or applied. Check disk space and file permissions, then retry.",
			});
			throw error;
		} finally {
			this.committingSettings = false;
		}
	}

	defaultDevNoCache(): boolean {
		const env = process.env.PI_WEB_DEV_CACHE;
		if (env !== undefined) return env !== "0";
		let dir = dirname(fileURLToPath(import.meta.url));
		for (let i = 0; i < 4; i++) {
			if (existsSync(join(dir, ".git"))) return true;
			dir = dirname(dir);
		}
		return false;
	}

	hasPendingReload(runtimeTarget?: SettingsRuntimeTarget): boolean {
		return runtimeTarget ? this.pendingRuntimeReloads.has(runtimeTarget) : this.pendingReload;
	}

	setPendingReload(v: boolean, runtimeTarget?: SettingsRuntimeTarget): void {
		if (runtimeTarget) {
			if (v) this.pendingRuntimeReloads.add(runtimeTarget);
			else this.pendingRuntimeReloads.delete(runtimeTarget);
		} else this.pendingReload = v;
	}

	consumePendingReload(runtimeTarget?: SettingsRuntimeTarget): boolean {
		const v = this.hasPendingReload(runtimeTarget);
		this.setPendingReload(false, runtimeTarget);
		return v;
	}

	private skillStillOnDisk(name: string): boolean {
		return isSkillStillOnDisk(name, {
			cwd: this.host.cwd(),
			agentDir: this.host.agentDir(),
		});
	}

	private extensionStillOnDisk(id: string): boolean {
		if (!id) return false;
		if (isInternalExtension({ path: id })) return false;
		if (id.startsWith("npm:")) {
			const pkg = id.slice(4);
			if (!pkg) return false;
			const cwd = this.host.cwd();
			const agentDir = this.host.agentDir();
			for (const npmRoot of [join(agentDir, "npm", "node_modules"), join(cwd, ".pi", "npm", "node_modules")]) {
				try {
					if (existsSync(join(npmRoot, pkg))) return true;
				} catch {}
			}
			return this.packageStillListed(pkg);
		}
		try {
			return existsSync(id);
		} catch {
			return false;
		}
	}
	private packageStillListed(pkg: string): boolean {
		const wanted = `npm:${pkg}`;
		for (const file of [join(this.host.agentDir(), "settings.json"), join(this.host.cwd(), ".pi", "settings.json")]) {
			try {
				const parsed = JSON.parse(readFileSync(file, "utf8")) as { packages?: unknown };
				if (!Array.isArray(parsed?.packages)) continue;
				for (const entry of parsed.packages) {
					if (typeof entry !== "string") continue;
					if (entry === wanted || entry === pkg) return true;
				}
			} catch {}
		}
		return false;
	}
	refreshResources(): void {
		if (this.disposed || this.host.isDisposed()) return;
		this.resetResourceCatalog();
		this.settings = this.host.stateStore.getSettings(this.host.clientId);
		this.presets = this.host.stateStore.getPresets(this.host.clientId);
		const disabledSkills = new Set(this.settings.disabledSkills);
		let loadedSkillNames: Set<string> | null = null;
		let loadedExtNames: Set<string> | null = null;
		try {
			const loadedSkills = this.host.getSession().resourceLoader.getSkills().skills;
			const allLoadedExts = this.host.getSession().resourceLoader.getExtensions().extensions;
			const loadedExts = allLoadedExts.filter((e) => !isInternalExtension(e));
			loadedSkillNames = new Set(loadedSkills.map((s) => s.name));
			loadedExtNames = new Set(loadedExts.map((e) => extensionKey(e)));

			const discoveredSkills = discoverDiskSkills({
				cwd: this.host.cwd(),
				agentDir: this.host.agentDir(),
			});
			const diskSkills = this.host.filterDiskSkills?.(discoveredSkills) ?? discoveredSkills;

			const keepSkills = new Set<string>([...loadedSkills.map((s) => s.name), ...diskSkills.map((s) => s.name)]);
			const keepExts = new Set<string>([
				...loadedExts.map((e) => extensionKey(e)),
				...this.settings.disabledExtensions.filter(
					(id) => !isInternalExtension({ path: id }) && this.extensionStillOnDisk(id),
				),
			]);
			// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
			for (const name of [...this.knownSkills.keys()]) {
				if (!keepSkills.has(name)) this.knownSkills.delete(name);
			}
			// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
			for (const id of [...this.knownExtensions.keys()]) {
				if (!keepExts.has(id) || isInternalExtension({ path: id })) this.knownExtensions.delete(id);
			}
			for (const s of loadedSkills) {
				this.knownSkills.set(s.name, {
					name: s.name,
					description: s.description,
					enabled: true,
				});
			}
			for (const ds of diskSkills) {
				if (!this.knownSkills.has(ds.name)) {
					this.knownSkills.set(ds.name, {
						name: ds.name,
						description: ds.description,
						enabled: !disabledSkills.has(ds.name),
					});
				} else if (!this.knownSkills.get(ds.name)!.description && ds.description) {
					this.knownSkills.get(ds.name)!.description = ds.description;
				}
			}
			for (const e of loadedExts) {
				const id = extensionKey(e);
				const p = e.sourceInfo?.path ?? e.path;
				this.knownExtensions.set(id, {
					id,
					name: e.sourceInfo?.origin === "package" && e.sourceInfo.source ? e.sourceInfo.source : basename(p),
					path: p,
					enabled: true,
				});
			}
		} catch {}
		if (loadedSkillNames !== null) {
			const stale = [
				...new Set([
					...this.settings.disabledSkills,
					...this.settings.reviewDisabledSkills,
					...normalizeSkillList(this.settings.skillsFullText),
				]),
			].filter((name) => !this.knownSkills.has(name) && !this.skillStillOnDisk(name));
			if (stale.length > 0) {
				this.settings.disabledSkills = this.settings.disabledSkills.filter((n) => !stale.includes(n));
				this.settings.reviewDisabledSkills = this.settings.reviewDisabledSkills.filter((n) => !stale.includes(n));
				this.settings.skillsFullText = normalizeSkillList(this.settings.skillsFullText).filter(
					(n) => !stale.includes(n),
				);
				this.commitSettings({
					disabledSkills: this.settings.disabledSkills,
					reviewDisabledSkills: this.settings.reviewDisabledSkills,
					skillsFullText: this.settings.skillsFullText,
				});
			}
		}
		if (loadedExtNames !== null) {
			const staleExts = this.settings.disabledExtensions.filter(
				(id) => isInternalExtension({ path: id }) || (!loadedExtNames.has(id) && !this.extensionStillOnDisk(id)),
			);
			if (staleExts.length > 0) {
				this.settings.disabledExtensions = this.settings.disabledExtensions.filter((n) => !staleExts.includes(n));
				this.commitSettings({
					disabledExtensions: this.settings.disabledExtensions,
				});
			}
		}
		for (const name of this.settings.disabledSkills) {
			if (this.knownSkills.has(name)) continue;
			if (!this.skillStillOnDisk(name)) continue;
			this.knownSkills.set(name, { name, description: "", enabled: false });
		}
		for (const id of this.settings.disabledExtensions) {
			if (isInternalExtension({ path: id })) continue;
			if (!this.knownExtensions.has(id)) {
				if (!this.extensionStillOnDisk(id)) continue;
				this.knownExtensions.set(id, {
					id,
					name: id.startsWith("npm:") ? id : basename(id),
					path: "",
					enabled: false,
				});
			}
		}
		this.push();
	}

	private catalogCwd: string | undefined;

	private resetResourceCatalog(): void {
		const cwd = this.host.cwd();
		if (cwd === this.catalogCwd) return;
		this.catalogCwd = cwd;
		this.knownSkills.clear();
		this.knownExtensions.clear();
	}

	push(): void {
		if (this.disposed || this.host.isDisposed()) return;
		this.resetResourceCatalog();
		this.settings = this.host.stateStore.getSettings(this.host.clientId);
		this.presets = this.host.stateStore.getPresets(this.host.clientId);
		const disabledSkills = new Set(this.settings.disabledSkills);
		const reviewDisabledSkills = new Set(this.settings.reviewDisabledSkills);
		const disabledExts = new Set(this.settings.disabledExtensions);
		try {
			const loader = this.host.getSession().resourceLoader;
			for (const skill of loader.getSkills().skills) {
				this.knownSkills.set(skill.name, { name: skill.name, description: skill.description, enabled: true });
			}
			for (const extension of loader.getExtensions().extensions) {
				if (isInternalExtension(extension)) continue;
				const id = extensionKey(extension);
				const path = extension.sourceInfo?.path ?? extension.path;
				this.knownExtensions.set(id, {
					id,
					name:
						extension.sourceInfo?.origin === "package" && extension.sourceInfo.source
							? extension.sourceInfo.source
							: basename(path),
					path,
					enabled: true,
				});
			}
		} catch {}
		const skills = [...this.knownSkills.values()]
			.map((s) => ({ ...s, enabled: !disabledSkills.has(s.name) }))
			.sort((a, b) => a.name.localeCompare(b.name));
		const reviewSkills = [...this.knownSkills.values()]
			.map((s) => ({ ...s, enabled: !reviewDisabledSkills.has(s.name) }))
			.sort((a, b) => a.name.localeCompare(b.name));
		const extensions = [...this.knownExtensions.values()]
			.filter((e) => !isInternalExtension({ path: e.id }) && !isInternalExtension({ path: e.path }))
			.map((e) => ({ ...e, enabled: !disabledExts.has(e.id) }))
			.sort((a, b) => a.name.localeCompare(b.name));
		const legacyTools = deriveLegacy(this.settings.disabledAgentTools ?? []);
		const promptSnap = this.host.promptSnapshot();
		const mcp = this.host.getMcpServers?.() ?? {
			servers: [],
			globalPath: "",
			projectPath: "",
		};
		this.host.emit({
			type: "settings_state",
			settings: {
				promptMode: this.settings.promptMode,
				customSystemPrompt: this.settings.customSystemPrompt,
				promptTemplate: this.settings.promptTemplate ?? "",
				promptOverrides: { ...this.settings.promptOverrides },
				promptDisabled: [...(this.settings.promptDisabled ?? [])],
				toolPromptOverrides: { ...this.settings.toolPromptOverrides },
				disabledAgentTools: [...normalizeDisabledAgentTools(this.settings.disabledAgentTools)],
				disabledPluginTools: [...normalizeDisabledPluginTools(this.settings.disabledPluginTools)],
				nativeCliInheritModel: { ...this.settings.nativeCliInheritModel },
				terminalToolsEnabled: legacyTools.terminalToolsEnabled,
				terminalBash: this.settings.terminalBash,
				terminalBashIdleMs: this.settings.terminalBashIdleMs,
				terminalBashMaxForegroundMs: this.settings.terminalBashMaxForegroundMs,
				toolWatchdogTimeoutMs: this.settings.toolWatchdogTimeoutMs,
				readDirEnabled: this.settings.readDirEnabled !== false,
				bgAutoCleanupMin: normalizeBgCleanupMinutes(this.settings.bgAutoCleanupMin),
				toolLazyLoading: this.settings.toolLazyLoading === true,
				codemodeMode: this.settings.codemodeMode ?? "on",
				codemodeInlineBudget: this.settings.codemodeInlineBudget ?? 3000,
				toolApprovalEnabled: this.settings.toolApprovalEnabled !== false,
				approvalPolicy: this.host.getApprovalPolicy?.() ?? { allowAll: false, categories: [] },
				approvalRules: this.approvalRules?.list() ?? [],
				editSoftEnabled: legacyTools.editSoftEnabled,
				questionnaireEnabled: legacyTools.questionnaireEnabled,
				parallelReminderEnabled: this.settings.parallelReminderEnabled ?? true,
				goalModeEnabled: this.settings.goalModeEnabled,
				devNoCache: this.settings.devNoCache ?? this.defaultDevNoCache(),
				autoReload: this.settings.autoReload ?? this.defaultDevNoCache(),
				thinkingWrap: this.settings.thinkingWrap,
				toolsWrap: this.settings.toolsWrap,
				toolImagesEnabled: this.settings.toolImagesEnabled ?? true,
				keepRecentMessages: normalizeKeepRecentMessages(this.settings.keepRecentMessages),
				reversePagination: this.settings.reversePagination ?? false,
				showForkedParentSessions: this.settings.showForkedParentSessions ?? false,
				retainFinishedConversations: this.settings.retainFinishedConversations ?? false,
				openRecentSessionOnProjectSwitch: this.settings.openRecentSessionOnProjectSwitch ?? true,
				chatUploadMaxMb: this.settings.chatUploadMaxMb ?? 20,
				workspaceUploadMaxMb: this.settings.workspaceUploadMaxMb ?? 100,
				folderUploadMaxMb: this.settings.folderUploadMaxMb ?? 32,
				visionBridgeEnabled: this.settings.visionBridgeEnabled,
				visionBridgeModel: this.settings.visionBridgeModel,
				visionBridgePromptMode: this.settings.visionBridgePromptMode,
				visionBridgePrompt: this.settings.visionBridgePrompt,
				scmCommitMsgPromptMode: this.settings.scmCommitMsgPromptMode,
				scmCommitMsgPrompt: this.settings.scmCommitMsgPrompt,
				...normalizeQuickAskSettings(this.settings),
				planModePromptMode: this.settings.planModePromptMode,
				planModePrompt: this.settings.planModePrompt,
				reviewPrompt: this.settings.reviewPrompt,
				reviewDisabledSkills: [...this.settings.reviewDisabledSkills],
				disabledPlugins: [...(this.settings.disabledPlugins ?? [])],
				uiLayout: normalizeUiLayout(this.settings.uiLayout),
				skillsFullText: [...normalizeSkillList(this.settings.skillsFullText)],
				skillsCatalogMaxDesc: this.settings.skillsCatalogMaxDesc,
				skillsCatalogShowLocation: this.settings.skillsCatalogShowLocation,
				skillsCatalogBudget: this.settings.skillsCatalogBudget,
				skillsMaxFileBytes: this.settings.skillsMaxFileBytes,
				skillsFullTextMaxBytes: this.settings.skillsFullTextMaxBytes,
				effectiveSystemPrompt: promptSnap.full,
				promptSourceDefaults: promptSnap.texts,
				toolsSchema: promptSnap.toolsSchema,
				visionBridgeDefaultPrompt: SYSTEM_PROMPT,
				scmCommitMsgDefaultPrompt: COMMITMSG_SYSTEM_PROMPT,
				planModeDefaultPrompt: PLAN_MODE_SYSTEM_PROMPT,
				visionModels: this.collectVisionModels(),
				disabledSkills: [...this.settings.disabledSkills],
				disabledExtensions: [...this.settings.disabledExtensions],
				skills,
				reviewSkills,
				extensions,
				presets: this.presets.map(settingsPresetToUi),
				...(this.host.getMarkerState
					? this.host.getMarkerState()
					: {
							markersEnabled: true,
							disabledMarkers: [] as string[],
							markers: [] as import("./protocol.js").UiMarkerInfo[],
						}),
				subagentTemplates: this.templates.list().map((t) => localizeTemplate(t, this.host.getLocale?.())),
				subagentDefaultTemplates: DEFAULT_TEMPLATES.map((t) => t.name),
				subagentDefaultModel: this.settings.subagentDefaultModel ?? null,
				subagentMaxDepth: this.settings.subagentMaxDepth ?? 0,
				questionPresentation: this.settings.questionPresentation ?? "queue",
				toolApprovalPresentation: this.settings.toolApprovalPresentation ?? "all",
				questionTimeoutSeconds: this.settings.questionTimeoutSeconds ?? 240,
				subagentAutoWakeMaxTurns: this.settings.subagentAutoWakeMaxTurns ?? defaultSubagentAutoWakeMaxTurns(),
				steeringMode: this.settings.steeringMode,
				followUpMode: this.settings.followUpMode,
				retryMaxAttempts: this.settings.retryMaxAttempts,
				softCapTokens: this.settings.softCapTokens,
				softCapByModel: { ...this.settings.softCapByModel },
				autoCompactionInstructions: this.settings.autoCompactionInstructions ?? "",
				subagentModels: this.collectSubagentModels(),
				quickPhrases: [...this.settings.quickPhrases],
				quickPhrasesEnabled: this.settings.quickPhrasesEnabled,
				minimalNewChat: this.settings.minimalNewChat,
				preserveDraftAcrossConversations: this.settings.preserveDraftAcrossConversations ?? false,
				quickPhrasesSeeded: this.host.stateStore.getQuickPhrasesSeeded(),
				mcpServers: mcp.servers,
				mcpGlobalConfigPath: mcp.globalPath,
				mcpProjectConfigPath: mcp.projectPath,
			} satisfies UiSettingsState,
		});
	}

	private collectVisionModels(): UiVisionBridgeModel[] {
		try {
			return findVisionModels(this.host.getSession().modelRuntime).map((m) => ({
				provider: m.provider,
				id: m.id,
				label: m.label,
			}));
		} catch {
			return [];
		}
	}

	private collectSubagentModels(): UiVisionBridgeModel[] {
		try {
			const runtime = this.host.getSession().modelRuntime;
			const out: UiVisionBridgeModel[] = [];
			for (const p of runtime.getProviders()) {
				if (!runtime.hasConfiguredAuth(p.id)) continue;
				for (const m of runtime.getModels(p.id)) {
					out.push({
						provider: p.id,
						id: m.id,
						label: `${m.name ?? m.id} (${p.id})`,
					});
				}
			}
			return out.sort((a, b) =>
				a.provider === b.provider ? a.label.localeCompare(b.label) : a.provider.localeCompare(b.provider),
			);
		} catch {
			return [];
		}
	}

	async set(partial: {
		promptMode?: PromptMode;
		customSystemPrompt?: string;
		promptTemplate?: string;
		promptOverrides?: Record<string, string>;
		toolPromptOverrides?: Record<string, UiToolPromptOverride>;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		disabledAgentTools?: string[];
		disabledPluginTools?: string[];
		nativeCliInheritModel?: NativeCliInheritModel;
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		terminalBashMaxForegroundMs?: number;
		toolWatchdogTimeoutMs?: number;
		readDirEnabled?: boolean;
		bgAutoCleanupMin?: number;
		toolLazyLoading?: boolean;
		codemodeMode?: "on" | "only";
		codemodeInlineBudget?: number;
		toolApprovalEnabled?: boolean;
		editSoftEnabled?: boolean;
		questionnaireEnabled?: boolean;
		questionPresentation?: "queue" | "all" | "manual";
		toolApprovalPresentation?: "queue" | "all" | "manual";
		questionTimeoutSeconds?: number;
		parallelReminderEnabled?: boolean;
		goalModeEnabled?: boolean;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		toolImagesEnabled?: boolean;
		keepRecentMessages?: number;
		reversePagination?: boolean;
		showForkedParentSessions?: boolean;
		retainFinishedConversations?: boolean;
		openRecentSessionOnProjectSwitch?: boolean;
		devNoCache?: boolean;
		autoReload?: boolean;
		skillsFullText?: string[];
		skillsCatalogMaxDesc?: number;
		skillsCatalogShowLocation?: boolean;
		skillsCatalogBudget?: number;
		skillsMaxFileBytes?: number;
		skillsFullTextMaxBytes?: number;
		chatUploadMaxMb?: number;
		workspaceUploadMaxMb?: number;
		folderUploadMaxMb?: number;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: PromptMode;
		visionBridgePrompt?: string;
		scmCommitMsgPromptMode?: PromptMode;
		scmCommitMsgPrompt?: string;
		quickAskEnabled?: QuickAskSettings["quickAskEnabled"];
		quickAskModel?: QuickAskSettings["quickAskModel"];
		quickAskThinking?: QuickAskSettings["quickAskThinking"];
		quickAskSystemPrompt?: QuickAskSettings["quickAskSystemPrompt"];
		quickAskExplainPrompt?: QuickAskSettings["quickAskExplainPrompt"];
		quickAskTranslateEnabled?: QuickAskSettings["quickAskTranslateEnabled"];
		quickAskTranslateTarget?: QuickAskSettings["quickAskTranslateTarget"];
		quickAskTranslateStyle?: QuickAskSettings["quickAskTranslateStyle"];
		quickAskTranslatePrompt?: QuickAskSettings["quickAskTranslatePrompt"];
		quickAskShowOriginal?: QuickAskSettings["quickAskShowOriginal"];
		quickAskReferenceMenus?: QuickAskSettings["quickAskReferenceMenus"];
		quickAskConversationScope?: QuickAskSettings["quickAskConversationScope"];
		quickAskFolderScope?: QuickAskSettings["quickAskFolderScope"];
		planModePromptMode?: PromptMode;
		planModePrompt?: string;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
		promptDisabled?: string[];
		disabledPlugins?: string[];
		uiLayout?: UiLayoutPrefs;
		subagentDefaultModel?: string | null;
		subagentMaxDepth?: number;
		subagentAutoWakeMaxTurns?: number;
		steeringMode?: QueueMode;
		followUpMode?: QueueMode;
		retryMaxAttempts?: number;
		softCapTokens?: number;
		softCapByModel?: Record<string, number>;
		autoCompactionInstructions?: string;
		markersEnabled?: boolean;
		disabledMarkers?: string[];
		quickPhrases?: string[];
		quickPhrasesEnabled?: boolean;
		minimalNewChat?: boolean;
		preserveDraftAcrossConversations?: boolean;
	}): Promise<void> {
		const before = this.host.stateStore.getSettings(this.host.clientId);
		const next = structuredClone(before);
		const needsReload =
			partial.promptMode !== undefined ||
			partial.customSystemPrompt !== undefined ||
			partial.promptTemplate !== undefined ||
			partial.promptOverrides !== undefined ||
			partial.promptDisabled !== undefined ||
			partial.disabledSkills !== undefined ||
			partial.disabledExtensions !== undefined;
		const toolGatingChanged =
			partial.disabledAgentTools !== undefined ||
			partial.disabledPluginTools !== undefined ||
			partial.disabledPlugins !== undefined ||
			partial.terminalToolsEnabled !== undefined ||
			partial.editSoftEnabled !== undefined ||
			partial.questionnaireEnabled !== undefined ||
			partial.toolPromptOverrides !== undefined ||
			partial.toolLazyLoading !== undefined;
		if (partial.promptMode !== undefined) next.promptMode = partial.promptMode;
		if (partial.customSystemPrompt !== undefined) {
			next.customSystemPrompt = partial.customSystemPrompt;
		}
		if (partial.promptTemplate !== undefined) {
			next.promptTemplate = partial.promptTemplate;
		}
		if (partial.promptOverrides !== undefined) {
			const overrides = { ...next.promptOverrides };
			for (const [k, v] of Object.entries(partial.promptOverrides)) {
				if (v && v.trim()) overrides[k] = v;
				else delete overrides[k];
			}
			next.promptOverrides = overrides;
		}
		if (partial.promptDisabled !== undefined) next.promptDisabled = [...partial.promptDisabled];
		if (partial.toolPromptOverrides !== undefined) {
			const overrides = { ...next.toolPromptOverrides };
			const normalized = normalizeToolPromptOverrides(partial.toolPromptOverrides);
			for (const key of Object.keys(partial.toolPromptOverrides)) {
				if (normalized[key]) overrides[key] = normalized[key];
				else delete overrides[key];
			}
			next.toolPromptOverrides = normalizeToolPromptOverrides(overrides);
		}
		if (partial.disabledSkills !== undefined) {
			next.disabledSkills = partial.disabledSkills;
		}
		if (partial.disabledExtensions !== undefined) {
			next.disabledExtensions = partial.disabledExtensions;
		}
		if (partial.disabledPlugins !== undefined) {
			next.disabledPlugins = partial.disabledPlugins;
		}
		if (partial.uiLayout !== undefined) {
			next.uiLayout = normalizeUiLayout(partial.uiLayout);
		}
		if (partial.disabledAgentTools !== undefined) {
			next.disabledAgentTools = normalizeDisabledAgentTools(partial.disabledAgentTools);
		}
		if (partial.disabledPluginTools !== undefined) {
			next.disabledPluginTools = normalizeDisabledPluginTools(partial.disabledPluginTools);
		}
		if (
			partial.terminalToolsEnabled !== undefined ||
			partial.editSoftEnabled !== undefined ||
			partial.questionnaireEnabled !== undefined
		) {
			next.disabledAgentTools = foldLegacyIntoDisabled(next.disabledAgentTools ?? [], {
				terminalToolsEnabled: partial.terminalToolsEnabled,
				editSoftEnabled: partial.editSoftEnabled,
				questionnaireEnabled: partial.questionnaireEnabled,
			});
		}
		{
			const legacy = deriveLegacy(next.disabledAgentTools ?? []);
			next.terminalToolsEnabled = legacy.terminalToolsEnabled;
			next.editSoftEnabled = legacy.editSoftEnabled;
			next.questionnaireEnabled = legacy.questionnaireEnabled;
		}
		if (partial.nativeCliInheritModel !== undefined) {
			next.nativeCliInheritModel = {
				...before.nativeCliInheritModel,
				...normalizeNativeCliInheritModel(partial.nativeCliInheritModel),
			};
		}
		if (partial.terminalBash !== undefined) {
			next.terminalBash = partial.terminalBash;
		}
		if (partial.terminalBashIdleMs !== undefined) {
			next.terminalBashIdleMs = Math.max(0, Math.floor(partial.terminalBashIdleMs) || 0);
		}
		if (partial.terminalBashMaxForegroundMs !== undefined) {
			next.terminalBashMaxForegroundMs = Math.max(0, Math.floor(partial.terminalBashMaxForegroundMs) || 0);
		}
		if (partial.toolWatchdogTimeoutMs !== undefined) {
			next.toolWatchdogTimeoutMs = normalizeToolWatchdogTimeoutMs(partial.toolWatchdogTimeoutMs);
		}
		if (partial.readDirEnabled !== undefined) {
			next.readDirEnabled = partial.readDirEnabled;
		}
		if (partial.bgAutoCleanupMin !== undefined) {
			next.bgAutoCleanupMin = normalizeBgCleanupMinutes(partial.bgAutoCleanupMin);
		}
		if (partial.toolLazyLoading !== undefined) {
			next.toolLazyLoading = partial.toolLazyLoading === true;
		}
		let codemodeChanged = false;
		if (partial.codemodeMode !== undefined && partial.codemodeMode !== next.codemodeMode) {
			next.codemodeMode = partial.codemodeMode;
			codemodeChanged = true;
		}
		if (partial.codemodeInlineBudget !== undefined && partial.codemodeInlineBudget !== next.codemodeInlineBudget) {
			next.codemodeInlineBudget = partial.codemodeInlineBudget;
			codemodeChanged = true;
		}
		if (partial.toolApprovalEnabled !== undefined) {
			next.toolApprovalEnabled = partial.toolApprovalEnabled;
		}
		if (partial.goalModeEnabled !== undefined) {
			next.goalModeEnabled = partial.goalModeEnabled;
		}
		if (partial.parallelReminderEnabled !== undefined) {
			next.parallelReminderEnabled = partial.parallelReminderEnabled;
		}
		if (partial.devNoCache !== undefined) {
			next.devNoCache = partial.devNoCache;
		}
		if (partial.autoReload !== undefined) {
			next.autoReload = partial.autoReload;
		}
		if (partial.thinkingWrap !== undefined) {
			next.thinkingWrap = partial.thinkingWrap;
		}
		if (partial.toolsWrap !== undefined) {
			next.toolsWrap = partial.toolsWrap;
		}
		if (partial.toolImagesEnabled !== undefined) {
			next.toolImagesEnabled = partial.toolImagesEnabled;
		}
		if (partial.keepRecentMessages !== undefined) {
			next.keepRecentMessages = normalizeKeepRecentMessages(partial.keepRecentMessages);
		}
		if (partial.reversePagination !== undefined) {
			next.reversePagination = Boolean(partial.reversePagination);
		}
		if (partial.retainFinishedConversations !== undefined) {
			next.retainFinishedConversations = Boolean(partial.retainFinishedConversations);
		}
		if (partial.openRecentSessionOnProjectSwitch !== undefined) {
			next.openRecentSessionOnProjectSwitch = Boolean(partial.openRecentSessionOnProjectSwitch);
		}
		let sessionsFilterChanged = false;
		if (partial.showForkedParentSessions !== undefined) {
			const nextVal = Boolean(partial.showForkedParentSessions);
			if (nextVal !== (next.showForkedParentSessions ?? false)) {
				sessionsFilterChanged = true;
			}
			next.showForkedParentSessions = nextVal;
		}
		if (partial.skillsFullText !== undefined) {
			next.skillsFullText = normalizeSkillList(partial.skillsFullText);
		}
		if (partial.skillsCatalogMaxDesc !== undefined) {
			next.skillsCatalogMaxDesc = normalizeSkillsCatalogMaxDesc(partial.skillsCatalogMaxDesc);
		}
		if (partial.skillsCatalogShowLocation !== undefined) {
			next.skillsCatalogShowLocation = Boolean(partial.skillsCatalogShowLocation);
		}
		if (partial.skillsCatalogBudget !== undefined) {
			next.skillsCatalogBudget = normalizeSkillsCatalogBudget(partial.skillsCatalogBudget);
		}
		if (partial.skillsMaxFileBytes !== undefined) {
			next.skillsMaxFileBytes = normalizeSkillsMaxFileBytes(partial.skillsMaxFileBytes);
		}
		if (partial.skillsFullTextMaxBytes !== undefined) {
			next.skillsFullTextMaxBytes = normalizeSkillsFullTextMaxBytes(partial.skillsFullTextMaxBytes);
		}
		for (const key of ["chatUploadMaxMb", "workspaceUploadMaxMb", "folderUploadMaxMb"] as const) {
			if (partial[key] !== undefined) next[key] = partial[key];
		}
		if (partial.visionBridgeEnabled !== undefined) {
			next.visionBridgeEnabled = partial.visionBridgeEnabled;
		}
		if (partial.visionBridgeModel !== undefined) {
			next.visionBridgeModel = partial.visionBridgeModel ?? null;
		}
		if (partial.visionBridgePromptMode !== undefined) {
			next.visionBridgePromptMode = partial.visionBridgePromptMode;
		}
		if (partial.visionBridgePrompt !== undefined) {
			next.visionBridgePrompt = partial.visionBridgePrompt;
		}
		if (partial.scmCommitMsgPromptMode !== undefined) {
			next.scmCommitMsgPromptMode = partial.scmCommitMsgPromptMode;
		}
		if (partial.scmCommitMsgPrompt !== undefined) {
			next.scmCommitMsgPrompt = partial.scmCommitMsgPrompt;
		}
		Object.assign(next, mergeQuickAskSettings(this.settings, partial));
		if (partial.planModePromptMode !== undefined) {
			next.planModePromptMode = partial.planModePromptMode;
		}
		if (partial.planModePrompt !== undefined) {
			next.planModePrompt = partial.planModePrompt;
		}
		if (partial.reviewPrompt !== undefined) {
			next.reviewPrompt = partial.reviewPrompt;
		}
		if (partial.reviewDisabledSkills !== undefined) {
			next.reviewDisabledSkills = partial.reviewDisabledSkills;
		}
		if (partial.subagentDefaultModel !== undefined) {
			const m = partial.subagentDefaultModel?.trim() ?? "";
			next.subagentDefaultModel = m ? m : null;
		}
		if (partial.questionPresentation !== undefined) {
			if (!["queue", "all", "manual"].includes(partial.questionPresentation))
				throw new Error("Invalid questionnaire presentation");
			next.questionPresentation = partial.questionPresentation;
		}
		if (partial.toolApprovalPresentation !== undefined) {
			if (!["queue", "all", "manual"].includes(partial.toolApprovalPresentation))
				throw new Error("Invalid tool approval presentation");
			next.toolApprovalPresentation = partial.toolApprovalPresentation;
		}
		if (partial.questionTimeoutSeconds !== undefined) {
			const seconds = partial.questionTimeoutSeconds;
			if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 86400)
				throw new Error("Question timeout must be 0–86400 seconds");
			next.questionTimeoutSeconds = seconds;
		}
		if (partial.subagentMaxDepth !== undefined) {
			const n = Math.floor(Number(partial.subagentMaxDepth));
			next.subagentMaxDepth = Number.isFinite(n) && n > 0 ? n : 0;
		}
		if (partial.subagentAutoWakeMaxTurns !== undefined) {
			next.subagentAutoWakeMaxTurns = normalizeSubagentAutoWakeMaxTurns(partial.subagentAutoWakeMaxTurns);
		}
		for (const key of ["steeringMode", "followUpMode"] as const) {
			const mode = partial[key];
			if (mode === undefined) continue;
			if (mode !== "all" && mode !== "one-at-a-time") throw new Error(`Invalid ${key}`);
			next[key] = mode;
		}
		if (partial.retryMaxAttempts !== undefined) {
			next.retryMaxAttempts = normalizeRetryMaxAttempts(partial.retryMaxAttempts);
		}
		if (partial.autoCompactionInstructions !== undefined) {
			next.autoCompactionInstructions = normalizeAutoCompactionInstructions(partial.autoCompactionInstructions);
		}
		if (partial.softCapTokens !== undefined || partial.softCapByModel !== undefined) {
			if (partial.softCapTokens !== undefined) next.softCapTokens = normalizeSoftCapTokens(partial.softCapTokens);
			if (partial.softCapByModel !== undefined) next.softCapByModel = normalizeSoftCapByModel(partial.softCapByModel);
		}
		if (partial.quickPhrases !== undefined) {
			const seen = new Set<string>();
			next.quickPhrases = (Array.isArray(partial.quickPhrases) ? partial.quickPhrases : [])
				.map((p) => String(p).trim().slice(0, 200))
				.filter((p) => p && !seen.has(p) && (seen.add(p), true))
				.slice(0, 30);
		}
		if (partial.quickPhrasesEnabled !== undefined) {
			next.quickPhrasesEnabled = partial.quickPhrasesEnabled;
		}
		if (partial.minimalNewChat !== undefined) {
			next.minimalNewChat = partial.minimalNewChat;
		}
		if (partial.preserveDraftAcrossConversations !== undefined) {
			next.preserveDraftAcrossConversations = Boolean(partial.preserveDraftAcrossConversations);
		}
		const patch: Partial<ClientSettings> = {};
		for (const key of Object.keys(partial) as (keyof ClientSettings)[]) {
			if (key in next && partial[key as keyof typeof partial] !== undefined) {
				Object.assign(patch, { [key]: next[key] });
			}
		}
		if (
			partial.disabledAgentTools !== undefined ||
			partial.terminalToolsEnabled !== undefined ||
			partial.editSoftEnabled !== undefined ||
			partial.questionnaireEnabled !== undefined
		) {
			patch.disabledAgentTools = next.disabledAgentTools;
			Object.assign(patch, deriveLegacy(next.disabledAgentTools ?? []));
		}
		this.commitSettings(patch);
		if (codemodeChanged) this.host.applyCodemodeOverrides?.();
		if (before.goalModeEnabled !== false && next.goalModeEnabled === false) this.host.onGoalModeDisabled?.();
		if (partial.retryMaxAttempts !== undefined) this.host.applyRetryOverrides();
		if (before.steeringMode !== next.steeringMode || before.followUpMode !== next.followUpMode)
			this.host.applyQueueModes?.();
		if (partial.softCapTokens !== undefined || partial.softCapByModel !== undefined)
			this.host.applyCompactionOverrides();
		if (toolGatingChanged) this.host.applyToolGating();
		this.push();
		if (sessionsFilterChanged) this.host.onSessionsFilterChanged?.();
		this.host.flushSnapshot();
		if (needsReload) await this.applyRuntime();
	}

	async savePreset(name: string): Promise<void> {
		const n = name.trim();
		if (!n) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: "预设名称不能为空",
				textEn: "Preset name cannot be empty",
			});
			return;
		}
		this.presets = this.host.stateStore.getPresets(this.host.clientId);
		const preset = this.snapshotPreset(n);
		const existing = this.presets.findIndex((p) => p.name === n);
		if (existing >= 0) this.presets[existing] = preset;
		else this.presets.push(preset);
		this.host.stateStore.savePresets(this.host.clientId, this.presets);
		this.push();
	}

	private snapshotPreset(name: string): SettingsPreset {
		const s = structuredClone(this.current) as ClientSettings;
		return { ...s, name };
	}

	async applyPreset(name: string, runtimeTarget?: SettingsRuntimeTarget): Promise<void> {
		this.settings = this.current;
		this.presets = this.host.stateStore.getPresets(this.host.clientId);
		const p = this.presets.find((x) => x.name === name);
		if (!p) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `预设不存在：${name}`,
				textEn: `Preset does not exist: ${name}`,
			});
			return;
		}
		const hasToolSettings = ["disabledAgentTools", "terminalToolsEnabled", "editSoftEnabled"].some((key) =>
			Object.prototype.hasOwnProperty.call(p, key),
		);
		const presetDisabled = normalizeDisabledAgentTools(
			(p as { disabledAgentTools?: unknown }).disabledAgentTools ??
				foldLegacyIntoDisabled(this.settings.disabledAgentTools ?? [], {
					terminalToolsEnabled: p.terminalToolsEnabled,
					editSoftEnabled: p.editSoftEnabled,
				}),
		);
		const presetLegacy = deriveLegacy(presetDisabled);
		const patch: Record<string, unknown> = { ...(p as unknown as Record<string, unknown>) };
		delete patch.name;
		delete patch.plugins;
		for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
		const prevShowForked = this.settings.showForkedParentSessions ?? false;
		this.commitSettings({
			...patch,
			...(hasToolSettings
				? {
						disabledAgentTools: presetDisabled,
						terminalToolsEnabled: presetLegacy.terminalToolsEnabled,
						editSoftEnabled: presetLegacy.editSoftEnabled,
					}
				: {}),
		});
		if (this.host.applySessionOverrides) {
			this.host.applySessionOverrides();
		} else {
			this.host.applyRetryOverrides();
			this.host.applyQueueModes?.();
			this.host.applyCompactionOverrides();
			this.host.applyCodemodeOverrides?.();
			this.host.applyToolGating();
		}
		this.push();
		if ((this.settings.showForkedParentSessions ?? false) !== prevShowForked) {
			this.host.onSessionsFilterChanged?.();
		}
		await this.applyRuntime(true, runtimeTarget);
	}

	async deletePreset(name: string): Promise<void> {
		this.presets = this.host.stateStore.getPresets(this.host.clientId).filter((p) => p.name !== name);
		this.host.stateStore.savePresets(this.host.clientId, this.presets);
		this.push();
	}

	private get lang(): ServerLang {
		return resolveServerLang(this.host.stateStore.get(this.host.clientId).locale);
	}

	private sharePort(): PresetSharePort {
		return {
			lang: () => this.lang,
			appVersion: () => packageVersion(),
			presets: () => this.host.stateStore.getPresets(this.host.clientId),
			currentSettings: () => {
				const { name: _drop, ...rest } = this.snapshotPreset("") as SettingsPreset & Record<string, unknown>;
				return { ...rest };
			},
			upsertPreset: (preset) => {
				this.presets = this.host.stateStore.getPresets(this.host.clientId);
				const i = this.presets.findIndex((p) => p.name === preset.name);
				if (i >= 0) this.presets[i] = preset;
				else this.presets.push(preset);
				this.host.stateStore.savePresets(this.host.clientId, this.presets);
			},
			applyPreset: (name) => this.applyPreset(name),
			isApplyPending: () => this.hasPendingReload(),
			pushSettings: () => this.push(),
			emit: (msg) => this.host.emit(msg),
		};
	}

	async exportPreset(msg: Extract<ClientMessage, { type: "preset_export" }>): Promise<void> {
		exportPresetVia(this.sharePort(), msg);
	}

	async importPreset(msg: Extract<ClientMessage, { type: "preset_import" }>): Promise<void> {
		await importPresetVia(this.sharePort(), msg);
	}

	async importPresetFromUrl(msg: Extract<ClientMessage, { type: "preset_import_url" }>): Promise<void> {
		await importPresetFromUrlVia(this.sharePort(), msg);
	}

	async sharePreset(msg: Extract<ClientMessage, { type: "preset_share" }>): Promise<void> {
		await sharePresetVia(this.sharePort(), msg);
	}

	async pushPresetCatalog(msg: Extract<ClientMessage, { type: "preset_catalog" }>): Promise<void> {
		await pushPresetCatalogVia(this.sharePort(), msg);
	}

	async saveTemplate(template: Parameters<SubagentTemplatesStore["upsert"]>[0]): Promise<void> {
		const err = this.templates.upsert(template);
		if (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `子代理模板保存失败：${err}`,
				textEn: `Failed to save subagent template: ${err}`,
			});
			return;
		}
		this.push();
		const n = (template as { name?: string })?.name?.trim() ?? "";
		this.host.emit({
			type: "notice",
			level: "info",
			text: `子代理模板已保存：${n}`,
			textEn: `Subagent template saved: ${n}`,
		});
	}

	async deleteTemplate(name: string): Promise<void> {
		this.templates.remove(name);
		this.push();
		this.host.emit({
			type: "notice",
			level: "info",
			text: `子代理模板已删除：${name}`,
			textEn: `Subagent template deleted: ${name}`,
		});
	}

	async saveApprovalRule(rule: UiApprovalRule): Promise<void> {
		if (!this.approvalRules) return;
		const err = this.approvalRules.upsert(rule);
		if (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `审批规则保存失败：${err}`,
				textEn: `Failed to save approval rule: ${err}`,
			});
			return;
		}
		this.push();
		this.host.emit({
			type: "notice",
			level: "info",
			text: `审批规则已保存：${rule.label}`,
			textEn: `Approval rule saved: ${rule.labelEn || rule.label}`,
		});
	}

	async saveApprovalRules(rules: UiApprovalRule[]): Promise<void> {
		if (!this.approvalRules) return;
		const err = this.approvalRules.saveAll(rules);
		if (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `审批规则列表保存失败：${err}`,
				textEn: `Failed to save approval rules: ${err}`,
			});
			return;
		}
		this.push();
		this.host.emit({
			type: "notice",
			level: "info",
			text: "审批规则列表已更新",
			textEn: "Approval rules updated",
		});
	}

	async deleteApprovalRule(id: string): Promise<void> {
		if (!this.approvalRules) return;
		const ok = this.approvalRules.remove(id);
		if (!ok) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: "审批规则删除失败（内置规则不可删除）",
				textEn: "Failed to delete approval rule (built-in rules cannot be deleted)",
			});
			return;
		}
		this.push();
		this.host.emit({
			type: "notice",
			level: "info",
			text: "审批规则已删除",
			textEn: "Approval rule deleted",
		});
	}

	async resetBuiltinApprovalRule(id: string): Promise<void> {
		if (!this.approvalRules) return;
		const ok = this.approvalRules.resetBuiltin(id);
		if (!ok) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: "恢复默认失败：未找到对应内置规则",
				textEn: "Failed to reset: built-in rule not found",
			});
			return;
		}
		this.push();
		this.host.emit({
			type: "notice",
			level: "info",
			text: "内置规则已恢复默认",
			textEn: "Built-in rule reset to default",
		});
	}

	async applyRuntime(throwOnError = false, runtimeTarget?: SettingsRuntimeTarget): Promise<void> {
		if (this.disposed || this.host.isDisposed()) return;
		if ((runtimeTarget ?? this.host).isStreaming()) {
			this.setPendingReload(true, runtimeTarget);
			this.host.emit({
				type: "notice",
				level: "info",
				text: "当前回复进行中，设置将在回复结束后自动应用",
				textEn: "A reply is in progress; settings will apply when it finishes",
			});
			return;
		}
		await this.applyReload(throwOnError, runtimeTarget);
	}

	private async applyReload(throwOnError = false, runtimeTarget?: SettingsRuntimeTarget): Promise<void> {
		if (this.disposed || this.host.isDisposed()) return;
		if ((runtimeTarget ?? this.host).isStreaming()) {
			this.setPendingReload(true, runtimeTarget);
			this.host.emit({
				type: "notice",
				level: "info",
				text: "当前回复进行中，设置将在回复结束后自动应用",
				textEn: "A reply is in progress; settings will apply when it finishes",
			});
			return;
		}
		try {
			await (runtimeTarget ?? this.host).reloadSession();
			if (this.disposed || this.host.isDisposed()) return;
			this.refreshResources();
			this.host.flushSnapshot();
			this.host.emit({ type: "notice", level: "info", text: "设置已应用", textEn: "Settings applied" });
		} catch (err) {
			console.error(`[settings] apply reload failed (client ${this.host.clientId}):`, err);
			this.host.emit({
				type: "notice",
				level: "error",
				text: `设置应用失败：${(err as Error).message}`,
				textEn: `Failed to apply settings: ${(err as Error).message}`,
			});
			if (throwOnError) throw err;
		}
	}
}

type SettingsPreset = ReturnType<ClientStateStore["getPresets"]>[number];
