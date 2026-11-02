/**
 * Settings service — 从 agent-service.ts 抽出（系统提示词 / 技能插件开关 /
 * 目标审查提示词 / 预设 / 视觉桥偏好）。设置持久化在 client-state.json 全局共享。
 *
 * 经 SettingsHost 回调与 ClientSession 解耦：本模块只管「设置状态 + 面板推送 +
 * 预设存取 + 何时需要 reload」，真正动 runtime 的 session.reload() 走宿主回调
 * （reloadSession 里还会刷新斜杠命令目录）。
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
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
import { normalizeSoftCapByModel, normalizeSoftCapTokens } from "./soft-cap.js";
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

/** ClientSession 提供给本服务的宿主能力（窄接口，便于独立测试）。 */
export interface MarkerStateForSettings {
	markersEnabled: boolean;
	disabledMarkers: string[];
	markers: import("./protocol.js").UiMarkerInfo[];
}

/** Reuse one port per conversation; callbacks must capture its runtime, not active. */
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
	/** 当前活动对话的 session（未就绪时调用方自行 try/catch）。 */
	getSession: () => AgentSession;
	/** 会话工作区（磁盘校验“已删除的 skill”用）。 */
	cwd: () => string;
	/** pi 配置目录（<agentDir>/skills 是技能来源之一）。 */
	agentDir: () => string;
	/** Apply the execution owner's capability scope to disk discovery as well as loaded skills. */
	filterDiskSkills?: (skills: DiscoveredSkill[]) => DiscoveredSkill[];
	isStreaming: () => boolean;
	/** session.reload() + 刷新斜杠命令目录。 */
	reloadSession: () => Promise<void>;
	/** 把设置面板的出错重试次数即时注入各会话（无需 reload；reload 后由
	 *  调用方重放，见 agent-service applyRetryOverrides）。 */
	applyRetryOverrides: () => void;
	/** Replay current steering/follow-up queue modes on every live session. */
	applyQueueModes?: () => void;
	/** 把压缩软上限逐会话重算成 compaction reserveTokens 覆盖（各用自己当前模型
	 *  与生效软上限，不累加、不残留；无需 reload；reload/建会话/换模型后由调用方
	 *  重放，见 agent-service applyCompactionOverrides，issue #229/#773）。 */
	applyCompactionOverrides: () => void;
	/** 把 codemode 运行模式与内联预算即时注入各会话的 SettingsManager（无需 reload）。 */
	applyCodemodeOverrides?: () => void;
	/** 统一收口重放配置覆盖与工具门控（包含 retry/compaction/codemode 与 toolGating）。 */
	applySessionOverrides?: () => void;
	/** 把统一工具开关即时应用到活动会话的 ActiveSet（无需 reload；
	 *  reload/创建后由调用方重放，见 agent-service applyToolGating）。 */
	applyToolGating: () => void;
	/** 当前会话提示词快照（设置面板预览用；会话未就绪时 full="" 且 texts={}）。
	 *  full = 实际生效的完整系统提示词（组合模式 = 模板 + 各来源自动/覆盖内容渲染结果）；
	 *  texts = 各来源 token 当前的默认（自动）内容（未覆盖时 {{token}} 展开值）；
	 *  toolsSchema = 发给模型的 function-calling 工具定义（name/description/parameters）只读文本。 */
	promptSnapshot: () => { full: string; texts: Record<string, string>; toolsSchema: string };
	/** 可选：内置标记状态（设置面板展示用）。 */
	getMarkerState?: () => MarkerStateForSettings;
	/** 可选：当前对话的审批放行策略（「本对话全部允许 / 允许同类」的撤销区用；
	 *  纯内存态，见 server/tool-approval.ts 的 ApprovalPolicy）。 */
	getApprovalPolicy?: () => UiApprovalPolicyState;
	/** 可选：目标模式总开关 on→off 时调 —— 停掉在飞的目标/调研（否则循环照跑照派）。 */
	onGoalModeDisabled?: () => void;
	/** 可选：历史对话列表过滤偏好（如 showForkedParentSessions）变化时立即重推历史列表。 */
	onSessionsFilterChanged?: () => void;
	/** 可选：查询 MCP 服务器列表与配置文件路径（设置面板展示）。 */
	getMcpServers?: () => {
		servers: import("./protocol.js").UiMcpServer[];
		globalPath: string;
		projectPath: string;
	};
	/** 可选：该客户端上报的原始 UI locale（"zh-TW" 等，未折叠）。内置子代理模板据此在
	 *  设置面板显示繁中视图（见 localizeTemplate）；缺省 = 不做视图转换。 */
	getLocale?: () => string | undefined;
}

export class SettingsService {
	private settings: ClientSettings;
	private presets: SettingsPreset[];
	private knownSkills = new Map<string, UiSkillInfo>();
	private knownExtensions = new Map<string, UiExtensionInfo>();
	/** 流式中改了需要 reload 的设置 → agent_end 后延迟应用（防拆毁运行中 run）。 */
	private pendingReload = false;
	private readonly pendingRuntimeReloads = new Set<SettingsRuntimeTarget>();
	private unsubscribeSettings?: () => void;
	private sharedVersion = 0;
	private sharedQueue = Promise.resolve();
	private committingSettings = false;
	private disposed = false;

	constructor(
		private readonly host: SettingsHost,
		/** 全局子代理模板库（所有客户端共享；模板改动无需 reload runtime）。 */
		private readonly templates: SubagentTemplatesStore,
		/** 全局审批规则库（所有客户端共享；修改实时生效无需 reload runtime）。 */
		private readonly approvalRules?: ApprovalRulesStore,
	) {
		this.settings = host.stateStore.getSettings(host.clientId);
		this.presets = host.stateStore.getPresets(host.clientId);
	}

	/** Immutable snapshot: repeated hot-path reads share the same detached object. */
	get current(): ClientSettings {
		return (
			this.host.stateStore.getSettingsSnapshot?.(this.host.clientId) ??
			this.host.stateStore.getSettings(this.host.clientId)
		);
	}

	/** Call once after the host has assigned settingsSvc and finished initialization. */
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

	/** Apply a durable commit without saving it again. Serialize reloads; ignore stale deliveries. */
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

	/** Effective dev-no-cache: explicit setting wins, else source-tree default
	 *  (ON from source, OFF for installs) — same rule as the index.html route.
	 *  PI_WEB_DEV_CACHE=0/1 overrides either way. */
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

	/** 判断某个 skill 名是否仍存在于磁盘任何来源（各类 Agent 项目区 / 全局 / 祖先 / npm 包等）。
	 *  被禁用且文件已删除的名字不应再出现在设置面板，也不应留在持久化记录里。 */
	private skillStillOnDisk(name: string): boolean {
		return isSkillStillOnDisk(name, {
			cwd: this.host.cwd(),
			agentDir: this.host.agentDir(),
		});
	}

	/** 判断某个扩展 id 是否仍存在（loader 之外的兜底，供禁用残留清理用）：
	 *  npm: 包 → 任一 npm 根还有目录，或还列在任一 settings.json packages 里
	 *  （只删了 node_modules 但配置还在 = 保守保留，等下次 loader 同步）；
	 *  路径型 → 文件/目录任一存在。空串一律不存在。 */
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
	/** 包名是否还列在全局/项目 settings.json 的 packages 里（文件缺失/坏 JSON 当没列）。 */
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
	/** Discover disk resources and prune stale preferences only on explicit refresh. Never reloads. */
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

			// 实时全源磁盘扫描：动态发现外部新安装/更新的各类 Agent 全局与本地技能
			const discoveredSkills = discoverDiskSkills({
				cwd: this.host.cwd(),
				agentDir: this.host.agentDir(),
			});
			const diskSkills = this.host.filterDiskSkills?.(discoveredSkills) ?? discoveredSkills;

			// Rebuild membership from loaded and discovered resources so deleted
			// disabled entries cannot keep themselves alive through the cache.
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
		} catch {
			// Session not ready yet — keep whatever we already know.
		}
		// 清理“源文件已删除”的禁用残留记录：磁盘上已不存在的技能名从
		// disabledSkills / reviewDisabledSkills 持久化记录中移除——否则每次
		// 推送都会把已删除的 skill 以灰条形式永恒地补回面板（“关闭过的
		// skill 被一直记录”）。session 未就绪时保守跳过。
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
		// Disabled entries that still exist on disk are re-added (with the
		// last-known description) so they can be re-enabled; entries whose
		// source file was deleted are dropped instead of being resurrected.
		// disabledExtensions 同理：已卸载（loader 里没有、磁盘/配置里也没有）的扩展
		// 从禁用记录里剔除并持久化 —— 否则卸载过的扩展以“已禁用”灰条永生（issue #192）。
		// loadedExtNames 非 null 即 session 就绪；取不到（catch 分支）时保守跳过。
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
		// （上面的 stale 清理已把卸载项移出禁用记录；这里再按磁盘挡一次，
		// session 未就绪跳过清理时也不复活幽灵。）
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

	/** Publish persisted preferences and the current in-memory resource catalog. No discovery, writes or reloads. */
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
		} catch {
			// Session initialization may still be in progress.
		}
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
		// 统一工具开关是单源（disabledAgentTools），遗留三开关推送时推导，保证面板一致。
		const legacyTools = deriveLegacy(this.settings.disabledAgentTools ?? []);
		// 当前会话提示词快照：完整生效文本 + 各来源默认（自动）内容（只读预览）。
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
				// The composed system prompt actually in effect (read-only view).
				effectiveSystemPrompt: promptSnap.full,
				// 每个来源未覆盖时的默认（自动）内容（「各来源」行预览用）。
				promptSourceDefaults: promptSnap.texts,
				// 发给模型的工具 schema（name/description/parameters）—— 只读预览。
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

	/** Vision-capable configured models, for the settings-panel picker. */
	private collectVisionModels(): UiVisionBridgeModel[] {
		try {
			return findVisionModels(this.host.getSession().modelRuntime).map((m) => ({
				provider: m.provider,
				id: m.id,
				label: m.label,
			}));
		} catch {
			// Session not ready yet — the picker stays empty until next push.
			return [];
		}
	}

	/** 已配置鉴权的全部模型（子代理模型选择器用；跟随视觉桥的收集方式但不限视觉）。 */
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
			// 稳定排序：provider 名 → 模型名。
			return out.sort((a, b) =>
				a.provider === b.provider ? a.label.localeCompare(b.label) : a.provider.localeCompare(b.provider),
			);
		} catch {
			// Session not ready yet — the picker stays empty until next push.
			return [];
		}
	}

	/** Persist + apply a partial settings update (compose template / per-source
	 *  overrides, skill/extension toggles). */
	async set(partial: {
		promptMode?: PromptMode;
		customSystemPrompt?: string;
		promptTemplate?: string;
		promptOverrides?: Record<string, string>;
		/** 逐工具文案覆盖（工具名 → description/promptSnippet/promptGuidelines；
		 *  空字段/空对象 = 清除该项覆盖；只合并给出的键）。 */
		toolPromptOverrides?: Record<string, UiToolPromptOverride>;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		/** 统一工具禁用名单（单源；遗留三开关与之双向同步）。 */
		disabledAgentTools?: string[];
		/** 插件 AI 工具禁用名单（live 生效，无需 reload）。 */
		disabledPluginTools?: string[];
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		terminalBashMaxForegroundMs?: number;
		toolWatchdogTimeoutMs?: number;
		/** read 工具读目录开关（默认开；见 server/read-tool.ts）。运行时无需重载，
		 *  覆盖定义每次调用实时读取。 */
		readDirEnabled?: boolean;
		/** 「后台任务」自动清理阈值（分钟；0 = 关，默认关）。 */
		bgAutoCleanupMin?: number;
		/** 工具延迟加载开关（默认开）：只影响新会话与之后的门控重放。 */
		toolLazyLoading?: boolean;
		/** codemode 执行模式："on"（常规模式，默认）| "only"（严格代码模式）。 */
		codemodeMode?: "on" | "only";
		/** codemode 系统提示词中内联工具声明的预算 Token（默认 3000）。 */
		codemodeInlineBudget?: number;
		/** 工具执行审批总开关（默认开；纯运行开关，每次审批实时读取，无需 reload）。 */
		toolApprovalEnabled?: boolean;
		editSoftEnabled?: boolean;
		questionnaireEnabled?: boolean;
		questionPresentation?: "queue" | "all" | "manual";
		toolApprovalPresentation?: "queue" | "all" | "manual";
		questionTimeoutSeconds?: number;
		/** 同项目并行提醒开关（默认开；纯运行开关，下一轮即生效，无需 reload）。 */
		parallelReminderEnabled?: boolean;
		goalModeEnabled?: boolean;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		toolImagesEnabled?: boolean;
		/** 消息列表尾部常驻渲染的消息条数（默认 15 = 与原硬编码一致；纯 UI 偏好）。 */
		keepRecentMessages?: number;
		/** 向上分页加载（反向分页）：默认只挂载最近消息、滚动/点击加载更早。纯 UI 偏好。 */
		reversePagination?: boolean;
		/** 历史对话列表中是否显示已被 fork 派生的父会话（默认 false = 仅显示链尾最新分支）。 */
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
		planModePromptMode?: PromptMode;
		planModePrompt?: string;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
		promptDisabled?: string[];
		disabledPlugins?: string[];
		/** 宿主 UI 布局偏好（插件 UI 贡献 + 内置条目的隐藏/排序/分组；纯 UI，per-client）。 */
		uiLayout?: UiLayoutPrefs;
		subagentDefaultModel?: string | null;
		/** 子代理最大嵌套层数（0 = 不限制；派生时实时读取，只影响之后新派生的子代理，无需 reload）。 */
		subagentMaxDepth?: number;
		/** 子代理连续自动唤醒上限轮数（0 = 不限制，默认 5；实时生效，无需 reload）。 */
		subagentAutoWakeMaxTurns?: number;
		steeringMode?: QueueMode;
		followUpMode?: QueueMode;
		retryMaxAttempts?: number;
		softCapTokens?: number;
		softCapByModel?: Record<string, number>;
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
		// 统一工具开关 live 生效（ActiveSet 加减，无需 reload），见末尾 applyToolGating。
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
			// 只合并给出的 key；空串 = 清除该来源覆盖。
			const overrides = { ...next.promptOverrides };
			for (const [k, v] of Object.entries(partial.promptOverrides)) {
				if (v && v.trim()) overrides[k] = v;
				else delete overrides[k];
			}
			next.promptOverrides = overrides;
		}
		if (partial.promptDisabled !== undefined) next.promptDisabled = [...partial.promptDisabled];
		if (partial.toolPromptOverrides !== undefined) {
			// 逐工具合并：给出的键整体替换（归一化后为空 = 清除该工具覆盖）。
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
		// 插件开关是纯 UI 隐藏（不进 needsReload——运行时无需重载）。
		if (partial.disabledPlugins !== undefined) {
			next.disabledPlugins = partial.disabledPlugins;
		}
		// UI 布局偏好只是渲染层的事（顶栏/底栏/右键菜单由前端拼），同样不需 reload。
		if (partial.uiLayout !== undefined) {
			next.uiLayout = normalizeUiLayout(partial.uiLayout);
		}
		// 统一工具开关：新字段优先；只给遗留单开关时折回新字段。两边写完再由
		// deriveLegacy 回填遗留别名，保证内存/推送/落盘三处一致。
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
		// read 读目录开关：覆盖定义每次调用实时读取，改动即时生效，无需 reload。
		if (partial.readDirEnabled !== undefined) {
			next.readDirEnabled = partial.readDirEnabled;
		}
		// 「后台任务」自动清理阈值（分钟；0 = 关）：bg-servers 的定时器每轮实时读，即时生效。
		if (partial.bgAutoCleanupMin !== undefined) {
			next.bgAutoCleanupMin = normalizeBgCleanupMinutes(partial.bgAutoCleanupMin);
		}
		// 工具延迟加载开关（默认关，设置页可开）：门控每次实时读取，改动经 applyToolGating 重放生效
		// （见 toolGatingChanged）——**只影响新会话与之后的门控重放**，已有对话的已加载
		// 集合不会被反向清空（不想让在跑的对话凭空丢掉工具）。
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
		// 工具执行审批总开关：审批入口每次实时读取（askApproval 顶部门禁），无需 reload。
		if (partial.toolApprovalEnabled !== undefined) {
			next.toolApprovalEnabled = partial.toolApprovalEnabled;
		}
		// 目标模式总开关：运行时无需重载（goal bar / 服务端入口实时读取）。
		// on→off 时立即停掉在飞的目标/调研 —— 不停的话循环照跑照派，开关名存实亡。
		if (partial.goalModeEnabled !== undefined) {
			next.goalModeEnabled = partial.goalModeEnabled;
		}
		// 同项目并行提醒开关：同上，发送入口逐轮实时读取，无需 reload。
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
		// 向上分页加载：前端 MessageList 实时读它（纯渲染策略），无需 reload runtime。
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
		// 编排模式 / skill 全文注入：before_agent_start 逐 run 实时读取（agent-service
		// composeInputs + 指导块追加），开关下一轮即生效，无需 reload runtime。
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
			// 空串归一为 null（跟随主对话）；其余剥空白后存格式 provider/id。
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
			// 出错重试次数：持久化 + 即时注入各会话（SDK 在每次退避前都重读
			// getRetrySettings，无需 reload runtime；见宿主 applyRetryOverrides）。
			next.retryMaxAttempts = normalizeRetryMaxAttempts(partial.retryMaxAttempts);
		}
		if (partial.softCapTokens !== undefined || partial.softCapByModel !== undefined) {
			// 压缩软上限：持久化 + 即时重算各会话的 compaction reserveTokens
			// 覆盖（SDK 每次自动压缩检查前都重读 getCompactionSettings，无需
			// reload；见宿主 applyCompactionOverrides，issue #229）。
			if (partial.softCapTokens !== undefined) next.softCapTokens = normalizeSoftCapTokens(partial.softCapTokens);
			if (partial.softCapByModel !== undefined) next.softCapByModel = normalizeSoftCapByModel(partial.softCapByModel);
			// 底栏标记线读快照的 contextUsage.softCap——推一次快照让在线页即时看到。
		}
		if (partial.quickPhrases !== undefined) {
			// 归一化：去空白/空项/重名，单条 ≤200 字，最多 30 条。纯 UI 偏好，不 reload。
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
		// 统一工具开关 live 生效（ActiveSet 加减；失败静默，下次创建/reload 重放）。
		// 必须在 this.push() 前生效，保证 promptSnapshot 收集到的是最新的活跃工具集与完整提示词！
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

	/** 保存当前设置为命名预设（同名覆盖）。 */
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

	/** 把当前设置快照成一条预设（名字由调用方给定）。
	 *  **全量**：`ClientSettings` 的每个字段都进预设（字段清单/分组见 `server/preset-fields.ts`），
	 *  导出/分享/导入共用同一张白名单；深层对象做一份拷贝，避免与当前设置共享引用。 */
	private snapshotPreset(name: string): SettingsPreset {
		const s = structuredClone(this.current) as ClientSettings;
		return { ...s, name };
	}

	/** Replace the current settings with the named preset and apply it. */
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
		// 统一工具开关：新预设直接用它；旧预设（只有遗留两开关）按当前禁用名单折算。
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
		// 全量预设 = 当前设置叠加预设里**实际存在**的字段（缺字段保持当前值）。
		// 旧预设（19 字段）、以及导入时只勾了一部分的预设，都靠这个 merge 落地。
		const patch: Record<string, unknown> = { ...(p as unknown as Record<string, unknown>) };
		delete patch.name;
		delete patch.plugins;
		for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
		const prevShowForked = this.settings.showForkedParentSessions ?? false;
		this.commitSettings({
			...patch,
			// 部分预设未携带工具字段时，保持当前设置；遗留别名仍统一派生。
			...(hasToolSettings
				? {
						disabledAgentTools: presetDisabled,
						terminalToolsEnabled: presetLegacy.terminalToolsEnabled,
						editSoftEnabled: presetLegacy.editSoftEnabled,
					}
				: {}),
		});
		// 统一收口重放配置覆盖与工具门控（包含 retry/compaction/codemode 与 toolGating）
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

	/** Remove a named preset. */
	async deletePreset(name: string): Promise<void> {
		this.presets = this.host.stateStore.getPresets(this.host.clientId).filter((p) => p.name !== name);
		this.host.stateStore.savePresets(this.host.clientId, this.presets);
		this.push();
	}

	/* ---------------------------------------------------------------- */
	/* 预设分享：导出 / 导入 / 分享 / 社区目录（server/preset-share.ts）  */
	/* ---------------------------------------------------------------- */

	/** 当前客户端语言（服务端文案用；与 agent-service 同源）。 */
	private get lang(): ServerLang {
		return resolveServerLang(this.host.stateStore.get(this.host.clientId).locale);
	}

	/** 分享编排（server/preset-share.ts）需要的最小能力集合。 */
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

	/** 导出预设（name 命名的预设）或当前设置（source=current）为 JSON 文本。 */
	async exportPreset(msg: Extract<ClientMessage, { type: "preset_export" }>): Promise<void> {
		exportPresetVia(this.sharePort(), msg);
	}

	/** 解析导入的预设 JSON：dryRun = 只回预览（不落盘）；apply = 导入后立即应用。 */
	async importPreset(msg: Extract<ClientMessage, { type: "preset_import" }>): Promise<void> {
		await importPresetVia(this.sharePort(), msg);
	}

	/** 按网址导入（服务端抓取：避开浏览器 CORS；内网地址已拦截）。 */
	async importPresetFromUrl(msg: Extract<ClientMessage, { type: "preset_import_url" }>): Promise<void> {
		await importPresetFromUrlVia(this.sharePort(), msg);
	}

	/** 一键分享到社区共享仓库（gh issue create；gh 不可用时回落预填网页）。 */
	async sharePreset(msg: Extract<ClientMessage, { type: "preset_share" }>): Promise<void> {
		await sharePresetVia(this.sharePort(), msg);
	}

	/** 拉社区共享目录（5 分钟缓存；失败保留上一次成功的列表）。 */
	async pushPresetCatalog(msg: Extract<ClientMessage, { type: "preset_catalog" }>): Promise<void> {
		await pushPresetCatalogVia(this.sharePort(), msg);
	}

	/** Upsert 一个子代理模板（全局共享）。模板只影响未来派生的子代理，
	 *  不需要 reload runtime —— 直接推送新设置状态即可。 */
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

	/** 删除一个子代理模板。 */
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

	/** Upsert 一条审批规则（全局共享）。 */
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

	/** 批量更新审批规则列表（重排或批量保存，全局共享）。 */
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

	/** 删除一条自定义审批规则。 */
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

	/** 恢复某条内置审批规则到系统默认设定。 */
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

	/**
	 * Make settings changes effective in the running runtime. The resource-loader
	 * overrides read this.settings at call time, so a reload re-applies them.
	 * Reloading mid-stream would tear down the in-flight run — defer instead.
	 */
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

	/** session.reload() + refresh the slash-command catalog + push state. */
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
