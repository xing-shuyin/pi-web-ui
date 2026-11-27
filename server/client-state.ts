import { renameSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { readFileSyncRetry, writeJsonAtomicSync } from "./atomic-file.js";
import { mergeBotDraftSettings, normalizeBotDraftSettings } from "./bot-draft-settings.js";
import { normalizeNativeCliInheritModel } from "./engine-catalog.js";
import { normalizeUploadMaxMb } from "./payload-limits.js";
import { isPromptOnlyPreset } from "./preset-fields.js";
import { BUILTIN_SOUL_TEXTS, DEFAULT_PROMPT_DISABLED, isPromptToken } from "./prompt-composer.js";
import type { EngineId } from "./protocol.js";
import { mergeQuickAskSettings, normalizeQuickAskSettings } from "./quick-ask-settings.js";
import { normalizeAutoCompactionInstructions, normalizeSoftCapByModel, normalizeSoftCapTokens } from "./soft-cap.js";
import {
	deriveLegacy,
	legacyToDisabled,
	normalizeDisabledAgentTools,
	normalizeToolOnDemandList,
} from "./tool-manager.js";
import { normalizeToolPromptOverrides } from "./tool-prompt-overrides.js";
import {
	DEFAULT_CLIENT_SETTINGS,
	type ClientSettings,
	type SettingsPreset,
	type SharedSettingsChange,
} from "../packages/keel/src/settings-schema.js";
import {
	DEFAULT_CODEMODE_INLINE_BUDGET,
	DEFAULT_CODEMODE_MODE,
	DEFAULT_KEEP_RECENT_MESSAGES,
	DEFAULT_RETRY_MAX_ATTEMPTS,
	DEFAULT_TOOL_LAZY_LOADING,
	DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS,
	DEFAULT_SKILLS_CATALOG_BUDGET,
	DEFAULT_SKILLS_CATALOG_MAX_DESC,
	DEFAULT_SKILLS_FULL_TEXT_MAX_BYTES,
	DEFAULT_SKILLS_MAX_FILE_BYTES,
	normalizeBgCleanupMinutes,
	normalizeCodemodeInlineBudget,
	normalizeCodemodeMode,
	normalizeDisabledPluginTools,
	normalizeKeepRecentMessages,
	normalizeQueueMode,
	normalizeRetryMaxAttempts,
	normalizeSkillList,
	normalizeSkillsCatalogBudget,
	normalizeSkillsCatalogMaxDesc,
	normalizeSkillsFullTextMaxBytes,
	normalizeSkillsMaxFileBytes,
	normalizeSubagentAutoWakeMaxTurns,
	normalizeToolWatchdogTimeoutMs,
} from "../packages/keel/src/settings-normalize.js";
import { DEFAULT_UI_LAYOUT, normalizeUiLayout } from "../packages/keel/src/ui-layout.js";
import {
	DEFAULT_DISABLED_MARKERS,
	normalizePathKey,
	RECENT_PROJECTS_MAX,
	type ClientState,
	type MarkerSettings,
} from "../packages/keel/src/projects-schema.js";

/**
 * 设置 schema 的单源在 keel（`settings-schema` / `settings-normalize` / `ui-layout` / `projects-schema`），
 * 老位置只再导出一次，主应用 100+ 处 import 不用动。真正还住在宿主这边的只有**提示词来源的归一**
 * （`normalizePromptDisabled` / `normalizePromptOverrides`，它们依赖 `prompt-composer` 的 token 表）。
 */
export * from "../packages/keel/src/projects-schema.js";
export * from "../packages/keel/src/settings-normalize.js";
export * from "../packages/keel/src/settings-schema.js";
export * from "../packages/keel/src/ui-layout.js";

export function normalizePromptDisabled(
	stored?: { promptDisabled?: string[]; _promptPluginDevConfigured?: boolean } | null,
): string[] {
	if (!stored || stored.promptDisabled === undefined) {
		return [...DEFAULT_PROMPT_DISABLED];
	}
	// 已下线的来源（guidelines / pi_docs 等）从存量名单里剔除，否则面板会一直显示一个不存在的停用项。
	const list = stored.promptDisabled.filter((t) => typeof t === "string" && isPromptToken(t));
	if (!stored._promptPluginDevConfigured && !list.includes("plugin_dev")) {
		list.push("plugin_dev");
	}
	return list;
}

/**
 * 存量覆盖收敛：
 * - 已下线 / 不存在的来源键直接丢掉（否则永远删不掉的死子键）；
 * - soul 文案与内置默认逐字相同 → 丢掉（等于没覆盖，走自动内容才不会在面板里假“已改”）。
 */
export function normalizePromptOverrides(overrides?: Record<string, string> | null): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(overrides ?? {})) {
		if (typeof value !== "string" || !isPromptToken(key)) continue;
		if (key === "soul" && BUILTIN_SOUL_TEXTS.includes(value.trim())) continue;
		out[key] = value;
	}
	return out;
}

export function settingsPresetToUi(p: SettingsPreset): import("./protocol.js").UiSettingsPreset {
	return {
		name: p.name,
		...(isPromptOnlyPreset(p) ? { scope: "prompt" as const } : {}),
		...(p.plugins ? { plugins: p.plugins } : {}),
		promptMode: p.promptMode === "replace" ? "replace" : "append",
		customSystemPrompt: p.customSystemPrompt ?? "",
		promptTemplate: p.promptTemplate ?? "",
		promptOverrides: { ...p.promptOverrides },
		promptDisabled: [...(p.promptDisabled ?? [])],
		disabledSkills: [...(p.disabledSkills ?? [])],
		disabledExtensions: [...(p.disabledExtensions ?? [])],
		reviewPrompt: p.reviewPrompt ?? "",
		reviewDisabledSkills: [...(p.reviewDisabledSkills ?? [])],
	};
}

export function extensionKey(e: {
	sourceInfo?: { origin?: string; source?: string; path?: string };
	path: string;
}): string {
	const src = e.sourceInfo;
	if (src?.origin === "package" && src.source) return src.source;
	return src?.path ?? e.path;
}

export function extensionKeyCandidates(e: {
	sourceInfo?: { origin?: string; source?: string; path?: string };
	path: string;
}): string[] {
	const keys = new Set<string>([extensionKey(e)]);
	const norm = e.path.replace(/\\/g, "/");
	const marker = "/node_modules/";
	const idx = norm.lastIndexOf(marker);
	if (idx !== -1) {
		const segs = norm.slice(idx + marker.length).split("/");
		const name = segs[0]?.startsWith("@") && segs[1] ? `${segs[0]}/${segs[1]}` : segs[0];
		if (name) keys.add(`npm:${name}`);
	}
	return [...keys];
}

export function isInternalExtension(e: { path: string; hidden?: boolean }): boolean {
	return Boolean(e.hidden) || e.path.startsWith("<inline:") || e.path.startsWith("<builtin:");
}

export function isExtensionDisabled(
	e: {
		sourceInfo?: { origin?: string; source?: string; path?: string };
		path: string;
		hidden?: boolean;
	},
	disabled: readonly string[],
): boolean {
	if (isInternalExtension(e)) return false;
	if (disabled.length === 0) return false;
	const keys = extensionKeyCandidates(e);
	return disabled.some((d) => keys.includes(d));
}

export function isExtensionEnabled(
	e: {
		sourceInfo?: { origin?: string; source?: string; path?: string };
		path: string;
		hidden?: boolean;
	},
	enabled: readonly string[],
): boolean {
	if (isInternalExtension(e)) return true;
	if (enabled.length === 0) return true;
	const keys = extensionKeyCandidates(e);
	return enabled.some((d) => keys.includes(d));
}

export const MAX_WORKSPACE_ROOTS = 8;

export function normalizeWorkspaceRoots(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of v) {
		if (typeof raw !== "string") continue;
		const p = raw.trim();
		if (!p || !isAbsolute(p)) continue;
		const abs = resolve(p);
		const key = normalizePathKey(abs);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(abs);
		if (out.length >= MAX_WORKSPACE_ROOTS) break;
	}
	return out;
}

export const CLIENT_STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const MAX_TRACKED_CLIENTS = 50;

export const CLIENT_STATE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function freezeSettings<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freezeSettings(child);
		Object.freeze(value);
	}
	return value;
}

function isStateRecord(value: unknown): value is Record<string, ClientState> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 中断续跑的时效上限：超过这个时长的中断记录不再自动续跑，只提示手动恢复
 * （避免重启后把很久以前的中断重放成新回合）。
 */
export const INTERRUPTED_RESUME_TTL_MS = 12 * 60 * 60 * 1000;

export class ClientStateStore {
	private cache: Record<string, ClientState> | null = null;
	/** 原文件读不出来时置位：读不到 ≠ 没有内容，本次运行一律不写盘，避免把读不到的原文件覆盖成空壳。 */
	private writeBlocked = false;
	private settingsVersion = 0;
	private settingsSnapshot: ClientSettings | undefined;
	private readonly settingsListeners = new Set<(change: SharedSettingsChange) => void | Promise<void>>();

	subscribeSettings(listener: (change: SharedSettingsChange) => void | Promise<void>): () => void {
		this.settingsListeners.add(listener);
		return () => {
			this.settingsListeners.delete(listener);
		};
	}

	getSettingsSnapshot(clientId: string): ClientSettings {
		return (this.settingsSnapshot ??= freezeSettings(this.readSettings(clientId)));
	}

	getSettingsVersion(): number {
		return this.settingsVersion;
	}

	private lastSweepAt = 0;

	constructor(private filePath: string) {}

	private static readonly GLOBAL_SETTINGS_KEY = "__settings__";

	get dataDir(): string {
		return dirname(this.filePath);
	}

	private load(): Record<string, ClientState> {
		if (this.cache) {
			this.sweepStaleClientsIfNeeded();
			return this.cache;
		}
		let raw: string | undefined;
		try {
			// 瞬时占用（Windows 杀毒 / 索引器持句柄）由退避重试消化；ENOENT 原样抛出，那才是真的「从没存过」。
			raw = readFileSyncRetry(this.filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				// 读不出来时既备份不了也拿不到原文：再按空库写盘就是销毁用户设置，只能让本次运行只读。
				this.writeBlocked = true;
				console.error(`[client-state] 读取 ${this.filePath} 失败，本次以空设置启动并停止写盘（原文件保持不动）`, error);
			}
			raw = undefined;
		}
		this.cache = {};
		if (raw !== undefined) {
			try {
				const parsed: unknown = JSON.parse(raw);
				if (isStateRecord(parsed)) {
					this.cache = parsed;
				} else {
					this.preserveUnreadable(raw, new Error(`顶层类型不可用：${Array.isArray(parsed) ? "array" : typeof parsed}`));
				}
			} catch (error) {
				this.preserveUnreadable(raw, error);
			}
		}
		let migrated = false;
		const globalState = (this.cache[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		const globalSet = new Set((globalState.removedProjects ?? []).map(normalizePathKey));
		for (const [id, cState] of Object.entries(this.cache)) {
			if (id !== ClientStateStore.GLOBAL_SETTINGS_KEY && cState.removedProjects?.length) {
				for (const p of cState.removedProjects) {
					const key = normalizePathKey(p);
					if (!globalSet.has(key)) {
						globalSet.add(key);
						(globalState.removedProjects ??= []).push(p);
						migrated = true;
					}
				}
			}
		}
		const projectsByKey = new Map<string, ClientState["projects"][number]>();
		for (const state of Object.values(this.cache)) {
			for (const project of state.projects ?? []) {
				const key = normalizePathKey(project.path);
				if (globalSet.has(key)) continue;
				const existing = projectsByKey.get(key);
				if (!existing || project.lastUsed > existing.lastUsed) projectsByKey.set(key, project);
			}
		}
		const projects = [...projectsByKey.values()].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, RECENT_PROJECTS_MAX);
		const previousProjects = globalState.projects ?? [];
		if (
			projects.length !== previousProjects.length ||
			projects.some((p, i) => p.path !== previousProjects[i].path || p.lastUsed !== previousProjects[i].lastUsed)
		) {
			globalState.projects = projects;
			migrated = true;
		}
		this.lastSweepAt = Date.now();
		const evicted = this.sweepDeadClients();
		if (migrated || evicted > 0) {
			this.save();
		}
		return this.cache;
	}

	private sweepStaleClientsIfNeeded(): void {
		if (Date.now() - this.lastSweepAt < CLIENT_STATE_SWEEP_INTERVAL_MS) return;
		this.lastSweepAt = Date.now();
		if (this.sweepDeadClients() > 0) this.save();
	}

	private sweepDeadClients(): number {
		const all = this.cache;
		if (!all) return 0;
		const now = Date.now();
		const dead = new Set<string>();
		const activity = new Map<string, number>();
		for (const [id, state] of Object.entries(all)) {
			if (id === ClientStateStore.GLOBAL_SETTINGS_KEY) continue;
			let at = state.lastActive ?? 0;
			if (at <= 0) {
				for (const p of state.projects ?? []) if (p.lastUsed > at) at = p.lastUsed;
				for (const i of state.interrupted ?? []) if (i.at > at) at = i.at;
				if (at > 0) state.lastActive = at;
			}
			activity.set(id, at);
			if (at > 0 && now - at > CLIENT_STATE_RETENTION_MS) dead.add(id);
		}
		if (activity.size - dead.size > MAX_TRACKED_CLIENTS) {
			const survivors = [...activity.entries()].filter(([id]) => !dead.has(id)).sort((a, b) => b[1] - a[1]);
			for (const [id] of survivors.slice(MAX_TRACKED_CLIENTS)) dead.add(id);
		}
		for (const id of dead) delete all[id];
		return dead.size;
	}

	private touchClient(all: Record<string, ClientState>, clientId: string): void {
		const state = all[clientId];
		if (state) state.lastActive = Date.now();
	}

	/**
	 * 解析失败/结构不认识时不能直接降级成空库——下一次 save 会把用户全部设置覆盖掉。
	 * 先把原文件改名留存（与 `composer-drafts` / `model-admin` 同一套 `.corrupt-<ts>` 约定：改名而非拷贝，
	 * 免得下一次启动又对同一个坏文件留第二份副本），再做空库启动；写盘不禁用——备份已落盘，可写才不会
	 * 让整个设置面板跟着失效。
	 */
	private preserveUnreadable(raw: string, error: unknown): void {
		if (!raw.trim()) return; // 0 字节 / 全空白：没有内容可救，也不留空副本
		const backup = `${this.filePath}.corrupt-${Date.now()}`;
		try {
			renameSync(this.filePath, backup);
			console.error(`[client-state] ${this.filePath} 无法解析，已改名留存到 ${backup}，本次以空设置启动`, error);
		} catch (backupError) {
			console.error(`[client-state] ${this.filePath} 无法解析且无法留存，下一次保存会覆盖原文件`, backupError);
		}
	}

	private save(): void {
		// 备份已完成（见 preserveUnreadable）才允许继续写；读不到原文件的场景没备份可做，
		// 只能拒绝覆盖并如实报错——不许把“没写盘”装成保存成功。
		if (this.writeBlocked) {
			throw new Error(`配置文件读取失败，本次运行不写盘以避免覆盖：${this.filePath}`);
		}
		try {
			writeJsonAtomicSync(this.filePath, this.cache);
		} catch (error) {
			this.cache = null;
			throw error;
		}
	}

	get(clientId: string): ClientState {
		return this.load()[clientId] ?? { projects: [] };
	}

	/**
	 * 记录一个项目。
	 * - `promote`（默认）= 真实对话活动，把 `lastUsed` 顶到当前时间；项目排序只认这个。
	 * - `promote: false` = 浏览/切换/恢复，只记 `lastCwd`、清 tombstone、缺省登记（`lastUsed: 0`），
	 *   不刷新时间，所以只是点开看看不会把项目顶到最新。
	 * - `clearTombstone`（默认 `true`）= 用户显式打开/发消息时清除删除墓碑；
	 *   连接/重启初始化恢复应传 `false`，若项目已在墓碑中则忽略，避免已删项目重启后复活。
	 */
	remember(clientId: string, cwd: string, opts?: { promote?: boolean; clearTombstone?: boolean }): void {
		const all = this.load();
		const targetKey = normalizePathKey(cwd);
		const clearTombstone = opts?.clearTombstone !== false;
		if (!clearTombstone) {
			const removed = new Set(this.getRemovedProjects(clientId).map(normalizePathKey));
			if (removed.has(targetKey)) return;
		}
		const state = (all[clientId] ??= { projects: [] });
		this.touchClient(all, clientId);
		state.lastCwd = cwd;
		const now = Date.now();
		const promote = opts?.promote !== false;
		// Also persist in global settings so new tabs and sessions inherit it immediately
		const globalState = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		if (promote) {
			state.projects = [
				{ path: cwd, lastUsed: now },
				...state.projects.filter((p) => normalizePathKey(p.path) !== targetKey),
			].slice(0, RECENT_PROJECTS_MAX);
			globalState.projects = [
				{ path: cwd, lastUsed: now },
				...(globalState.projects ?? []).filter((p) => normalizePathKey(p.path) !== targetKey),
			].slice(0, RECENT_PROJECTS_MAX);
		} else {
			// 浏览不算「最近对话」：已登记的不动时间，没登记的补一条 lastUsed: 0 留着位置
			if (!state.projects.some((p) => normalizePathKey(p.path) === targetKey)) {
				state.projects = [{ path: cwd, lastUsed: 0 }, ...state.projects].slice(0, RECENT_PROJECTS_MAX);
			}
			if (!(globalState.projects ?? []).some((p) => normalizePathKey(p.path) === targetKey)) {
				globalState.projects = [{ path: cwd, lastUsed: 0 }, ...(globalState.projects ?? [])].slice(
					0,
					RECENT_PROJECTS_MAX,
				);
			}
		}
		// Opening the workspace again clears its removal tombstone across all clients and global settings.
		for (const cState of Object.values(all)) {
			if (cState.removedProjects?.length) {
				cState.removedProjects = cState.removedProjects.filter((p) => normalizePathKey(p) !== targetKey);
			}
		}
		this.save();
	}

	removeProject(clientId: string, cwd: string): void {
		const all = this.load();
		const targetKey = normalizePathKey(cwd);
		const state = (all[clientId] ??= { projects: [] });
		this.touchClient(all, clientId);
		state.projects = state.projects.filter((p) => normalizePathKey(p.path) !== targetKey);
		if (state.lastCwd && normalizePathKey(state.lastCwd) === targetKey) delete state.lastCwd;
		const removed = (state.removedProjects ?? []).filter((p) => normalizePathKey(p) !== targetKey);
		removed.push(cwd);
		state.removedProjects = removed;

		const globalState = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		const globalRemoved = (globalState.removedProjects ?? []).filter((p) => normalizePathKey(p) !== targetKey);
		globalRemoved.push(cwd);
		globalState.removedProjects = globalRemoved;

		for (const [id, cState] of Object.entries(all)) {
			if (id !== ClientStateStore.GLOBAL_SETTINGS_KEY && cState.projects) {
				cState.projects = cState.projects.filter((p) => normalizePathKey(p.path) !== targetKey);
			}
		}
		this.save();
	}

	getRemovedProjects(clientId: string): string[] {
		const all = this.load();
		const clientRemoved = all[clientId]?.removedProjects ?? [];
		const globalRemoved = all[ClientStateStore.GLOBAL_SETTINGS_KEY]?.removedProjects ?? [];
		if (globalRemoved.length === 0) return clientRemoved;
		if (clientRemoved.length === 0) return globalRemoved;
		const seen = new Set<string>();
		const result: string[] = [];
		for (const p of [...clientRemoved, ...globalRemoved]) {
			const key = normalizePathKey(p);
			if (!seen.has(key)) {
				seen.add(key);
				result.push(p);
			}
		}
		return result;
	}

	/**
	 * Get recent projects merged across the client's own history, global settings,
	 * and other clients in this store, filtering out tombstoned paths and non-existent paths.
	 *
	 * 性能（issue #441）：先按 lastUsed 排序截断到 30 条，再对候选做存活性探测——
	 * 旧实现先对全部合并路径逐个同步 existsSync 再截断，Windows 上已断连的网络
	 * 驱动器单次 existsSync 可阻塞数秒且直接跑在事件循环上，会把整个服务界面
	 * （所有客户端 WS/HTTP）冻结。截断后探测把单次探测次数封顶 30；探测改异步
	 * fsPromises.access（调用链本就是 async），不再阻塞事件循环。代价是前 30 名
	 * 里有失效路径时不再回补更旧的项目（列表可能短于 30），属可接受的取舍。
	 */
	async getRecentProjects(clientId: string): Promise<{ path: string; lastUsed: number; name?: string }[]> {
		const all = this.load();
		const removedKeys = new Set(this.getRemovedProjects(clientId).map(normalizePathKey));
		const projectNames = all[ClientStateStore.GLOBAL_SETTINGS_KEY]?.projectNames;
		const map = new Map<string, { path: string; lastUsed: number }>();

		const merge = (list?: { path: string; lastUsed: number }[]) => {
			if (!list) return;
			for (const p of list) {
				if (!p?.path) continue;
				const key = normalizePathKey(p.path);
				if (removedKeys.has(key)) continue;
				const existing = map.get(key);
				if (!existing || p.lastUsed > existing.lastUsed) {
					map.set(key, { path: p.path, lastUsed: p.lastUsed });
				}
			}
		};

		// Merge client's own projects first, then global settings, then all other clients
		merge(all[clientId]?.projects);
		merge(all[ClientStateStore.GLOBAL_SETTINGS_KEY]?.projects);
		for (const [id, cState] of Object.entries(all)) {
			if (id !== clientId && id !== ClientStateStore.GLOBAL_SETTINGS_KEY) {
				merge(cState.projects);
			}
		}

		const candidates = [...map.values()].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, RECENT_PROJECTS_MAX);
		const probes = await Promise.allSettled(candidates.map((p) => this.pathExists(p.path)));
		return candidates
			.filter((_, i) => {
				const probe = probes[i];
				return probe?.status === "fulfilled" && probe.value;
			})
			.map((p) => {
				const customName = projectNames?.[normalizePathKey(p.path)]?.trim();
				return customName ? { ...p, name: customName } : p;
			});
	}

	protected async pathExists(path: string): Promise<boolean> {
		if (path.startsWith("ssh://")) {
			return true;
		}
		return fsPromises.access(path).then(
			() => true,
			() => false,
		);
	}

	/**
	 * 记录扫盘发现的项目到全局设置（不碰墓碑）。
	 *
	 * 只负责「发现」：没登记过的项目才插入，`lastUsed` 用磁盘 mtime 当初始排序值。
	 * 已登记项目的 `lastUsed` **绝不改写**——它是「最近真实对话」时间，只由 `remember(promote)`
	 * （用户真的发了消息）写。磁盘 mtime 是「会话文件最后写入时间」，流式输出、打开/切换、
	 * 持久化都会刷新它；拿它去顶 `lastUsed` 会让「切到别的项目的对话」把那个项目顶到最上面。
	 */
	mergeDiscoveredProjects(projects: { path: string; lastUsed: number }[]): void {
		if (!projects.length) return;
		const all = this.load();
		const globalState = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		const removedKeys = new Set((globalState.removedProjects ?? []).map(normalizePathKey));
		const map = new Map<string, { path: string; lastUsed: number }>();
		for (const p of globalState.projects ?? []) {
			const key = normalizePathKey(p.path);
			if (!removedKeys.has(key)) map.set(key, p);
		}
		let changed = false;
		for (const p of projects) {
			const key = normalizePathKey(p.path);
			if (removedKeys.has(key) || map.has(key)) continue;
			map.set(key, p);
			changed = true;
		}
		if (changed) {
			globalState.projects = [...map.values()].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 50);
			this.save();
		}
	}

	getGoalPrefs(clientId: string): ClientState["goalPrefs"] {
		const s = this.load()[clientId];
		if (!s?.goalPrefs) return undefined;
		return {
			reviewModel: s.goalPrefs.reviewModel ?? null,
			maxRounds: s.goalPrefs.maxRounds ?? 0,
			locked: s.goalPrefs.locked ?? true,
			execModel: s.goalPrefs.execModel ?? null,
		};
	}

	getWorkspaceRoots(clientId: string, cwd: string): string[] {
		return this.load()[clientId]?.workspaceRoots?.[cwd] ?? [];
	}

	saveWorkspaceRoots(clientId: string, cwd: string, roots: string[]): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		this.touchClient(all, clientId);
		const next = normalizeWorkspaceRoots(roots);
		if (next.length === 0) {
			if (state.workspaceRoots) {
				delete state.workspaceRoots[cwd];
				if (Object.keys(state.workspaceRoots).length === 0) delete state.workspaceRoots;
			}
			this.save();
			return;
		}
		(state.workspaceRoots ??= {})[cwd] = next;
		this.save();
	}

	saveLocale(clientId: string, locale: string): void {
		const code = locale.trim().slice(0, 16);
		if (!code) return;
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		this.touchClient(all, clientId);
		if (state.locale === code) return;
		state.locale = code;
		this.save();
	}

	saveGoalPrefs(clientId: string, prefs: ClientState["goalPrefs"]): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		this.touchClient(all, clientId);
		state.goalPrefs = {
			reviewModel: prefs?.reviewModel ?? null,
			maxRounds: prefs?.maxRounds ?? 0,
			locked: prefs?.locked ?? true,
			execModel: prefs?.execModel ?? null,
		};
		this.save();
	}

	saveInterrupted(clientId: string, list: { title: string; cwd: string; at: number; sessionFile?: string }[]): void {
		if (list.length === 0) return;
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		this.touchClient(all, clientId);
		state.interrupted = list.slice(0, 8);
		this.save();
	}

	/**
	 * 只读中断列表：续跑链路以「成功才 ack」为准，所以取用与删除必须分开
	 * （`takeInterrupted` 是旧的「取完即清」语义，不再用于续跑）。
	 */
	listInterrupted(clientId: string): NonNullable<ClientState["interrupted"]> {
		const list = this.load()[clientId]?.interrupted;
		return list?.length ? structuredClone(list) : [];
	}

	/** 按 `sessionFile` 精确剔除已成功续跑的记录（`""` 代表没有 sessionFile 的那类）。 */
	dropInterrupted(clientId: string, sessionFiles: string[]): void {
		const all = this.load();
		const state = all[clientId];
		if (!state?.interrupted?.length || sessionFiles.length === 0) return;
		const drop = new Set(sessionFiles);
		const kept = state.interrupted.filter((entry) => !drop.has(entry.sessionFile ?? ""));
		if (kept.length === state.interrupted.length) return;
		this.touchClient(all, clientId);
		if (kept.length > 0) state.interrupted = kept;
		else delete state.interrupted;
		this.save();
	}

	takeInterrupted(clientId: string): ClientState["interrupted"] {
		const all = this.load();
		const state = all[clientId];
		const list = state?.interrupted;
		if (list?.length && state) {
			this.touchClient(all, clientId);
			delete state.interrupted;
			this.save();
		}
		return list;
	}

	getSettings(clientId: string): ClientSettings {
		return structuredClone(this.getSettingsSnapshot(clientId));
	}

	private readSettings(_clientId: string): ClientSettings {
		const s = this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY];
		const stored = structuredClone(s?.settings);
		let promptTemplate = "";
		let promptOverrides: Record<string, string> = {};
		if (stored?.promptTemplate !== undefined) {
			promptTemplate = stored.promptTemplate ?? "";
			promptOverrides = normalizePromptOverrides(stored?.promptOverrides);
		} else if (stored && typeof stored.customSystemPrompt === "string" && stored.customSystemPrompt.trim()) {
			promptOverrides = normalizePromptOverrides({
				[stored.promptMode === "replace" ? "soul" : "append"]: stored.customSystemPrompt,
			});
		} else if (!stored) {
			promptOverrides = { ...DEFAULT_CLIENT_SETTINGS.promptOverrides };
		}
		return {
			promptMode: stored?.promptMode === "replace" ? "replace" : "append",
			customSystemPrompt: stored?.customSystemPrompt ?? (stored ? "" : DEFAULT_CLIENT_SETTINGS.customSystemPrompt),
			promptTemplate,
			promptOverrides,
			promptDisabled: normalizePromptDisabled(stored),
			_promptPluginDevConfigured: stored?._promptPluginDevConfigured,
			toolPromptOverrides: normalizeToolPromptOverrides(stored?.toolPromptOverrides),
			disabledSkills: stored?.disabledSkills ?? (stored ? [] : [...DEFAULT_CLIENT_SETTINGS.disabledSkills]),
			disabledExtensions: stored?.disabledExtensions ?? (stored ? [] : [...DEFAULT_CLIENT_SETTINGS.disabledExtensions]),
			disabledAgentTools:
				stored?.disabledAgentTools !== undefined
					? legacyToDisabled(stored)
					: stored
						? legacyToDisabled(stored ?? {})
						: [...DEFAULT_CLIENT_SETTINGS.disabledAgentTools],
			toolOnDemandTools: normalizeToolOnDemandList(
				stored?.toolOnDemandTools ?? (stored ? undefined : DEFAULT_CLIENT_SETTINGS.toolOnDemandTools),
			),
			disabledPluginTools:
				stored?.disabledPluginTools !== undefined
					? normalizeDisabledPluginTools(stored.disabledPluginTools)
					: stored
						? []
						: [...(DEFAULT_CLIENT_SETTINGS.disabledPluginTools ?? [])],
			nativeCliInheritModel: normalizeNativeCliInheritModel(stored?.nativeCliInheritModel),
			terminalToolsEnabled:
				stored?.disabledAgentTools !== undefined
					? deriveLegacy(legacyToDisabled(stored)).terminalToolsEnabled
					: (stored?.terminalToolsEnabled ?? (stored ? false : DEFAULT_CLIENT_SETTINGS.terminalToolsEnabled)),
			terminalBash: stored?.terminalBash ?? (stored ? false : DEFAULT_CLIENT_SETTINGS.terminalBash),
			terminalBashIdleMs: stored?.terminalBashIdleMs ?? (stored ? 15_000 : DEFAULT_CLIENT_SETTINGS.terminalBashIdleMs),
			terminalBashMaxForegroundMs:
				stored?.terminalBashMaxForegroundMs ?? (stored ? 60_000 : DEFAULT_CLIENT_SETTINGS.terminalBashMaxForegroundMs),
			toolWatchdogTimeoutMs: normalizeToolWatchdogTimeoutMs(stored?.toolWatchdogTimeoutMs),
			readDirEnabled: stored?.readDirEnabled ?? true,
			bgAutoCleanupMin: normalizeBgCleanupMinutes(
				stored?.bgAutoCleanupMin ?? (stored ? 0 : DEFAULT_CLIENT_SETTINGS.bgAutoCleanupMin),
			),
			toolLazyLoading: stored?.toolLazyLoading ?? DEFAULT_TOOL_LAZY_LOADING,
			codemodeMode: normalizeCodemodeMode(stored?.codemodeMode),
			codemodeInlineBudget: normalizeCodemodeInlineBudget(stored?.codemodeInlineBudget),
			toolApprovalEnabled: stored?.toolApprovalEnabled ?? (stored ? true : DEFAULT_CLIENT_SETTINGS.toolApprovalEnabled),
			questionnaireEnabled:
				stored?.disabledAgentTools !== undefined
					? deriveLegacy(legacyToDisabled(stored)).questionnaireEnabled
					: (stored?.questionnaireEnabled ?? true),
			questionPresentation:
				stored?.questionPresentation === "all" || stored?.questionPresentation === "manual"
					? stored.questionPresentation
					: "queue",
			toolApprovalPresentation:
				stored?.toolApprovalPresentation === "queue" || stored?.toolApprovalPresentation === "manual"
					? stored.toolApprovalPresentation
					: "all",
			questionTimeoutSeconds:
				Number.isFinite(stored?.questionTimeoutSeconds) && Number(stored?.questionTimeoutSeconds) >= 0
					? Math.floor(Number(stored?.questionTimeoutSeconds))
					: 240,
			goalModeEnabled: stored?.goalModeEnabled ?? true,
			parallelReminderEnabled: stored?.parallelReminderEnabled ?? true,
			thinkingWrap: stored?.thinkingWrap ?? false,
			devNoCache: stored?.devNoCache,
			autoReload: stored?.autoReload,
			internalMcpEnabled: stored?.internalMcpEnabled,
			toolsWrap: stored?.toolsWrap ?? (stored ? true : DEFAULT_CLIENT_SETTINGS.toolsWrap),
			toolImagesEnabled: stored?.toolImagesEnabled ?? true,
			keepRecentMessages: normalizeKeepRecentMessages(stored?.keepRecentMessages),
			reversePagination: stored?.reversePagination ?? false,
			showForkedParentSessions: stored?.showForkedParentSessions ?? true,
			retainFinishedConversations: stored?.retainFinishedConversations ?? false,
			openRecentSessionOnProjectSwitch:
				stored?.openRecentSessionOnProjectSwitch ?? DEFAULT_CLIENT_SETTINGS.openRecentSessionOnProjectSwitch,
			skillsFullText: normalizeSkillList(stored?.skillsFullText),
			skillsCatalogMaxDesc: normalizeSkillsCatalogMaxDesc(stored?.skillsCatalogMaxDesc),
			skillsCatalogShowLocation: Boolean(stored?.skillsCatalogShowLocation ?? false),
			skillsCatalogBudget: normalizeSkillsCatalogBudget(stored?.skillsCatalogBudget),
			skillsMaxFileBytes: normalizeSkillsMaxFileBytes(stored?.skillsMaxFileBytes),
			skillsFullTextMaxBytes: normalizeSkillsFullTextMaxBytes(stored?.skillsFullTextMaxBytes),
			chatUploadMaxMb: normalizeUploadMaxMb(stored?.chatUploadMaxMb, 20),
			workspaceUploadMaxMb: normalizeUploadMaxMb(stored?.workspaceUploadMaxMb, 100),
			folderUploadMaxMb: normalizeUploadMaxMb(stored?.folderUploadMaxMb, 32),
			visionBridgeEnabled: stored?.visionBridgeEnabled ?? (stored ? true : DEFAULT_CLIENT_SETTINGS.visionBridgeEnabled),
			visionBridgeModel: stored?.visionBridgeModel ?? null,
			visionBridgePromptMode: stored?.visionBridgePromptMode === "replace" ? "replace" : "append",
			visionBridgePrompt: stored?.visionBridgePrompt ?? "",
			scmCommitMsgPromptMode: stored?.scmCommitMsgPromptMode === "replace" ? "replace" : "append",
			scmCommitMsgPrompt: stored?.scmCommitMsgPrompt ?? "",
			...normalizeQuickAskSettings(stored ?? {}),
			...normalizeBotDraftSettings(stored ?? {}),
			planModePromptMode: stored?.planModePromptMode === "replace" ? "replace" : "append",
			planModePrompt: stored?.planModePrompt ?? "",
			subagentDefaultModel: stored?.subagentDefaultModel ?? null,
			subagentMaxDepth: stored?.subagentMaxDepth ?? 0,
			subagentAutoWakeMaxTurns: normalizeSubagentAutoWakeMaxTurns(
				stored?.subagentAutoWakeMaxTurns ?? (stored ? undefined : DEFAULT_CLIENT_SETTINGS.subagentAutoWakeMaxTurns),
			),
			steeringMode: normalizeQueueMode(stored?.steeringMode),
			followUpMode: normalizeQueueMode(stored?.followUpMode),
			retryMaxAttempts: normalizeRetryMaxAttempts(stored?.retryMaxAttempts),
			softCapTokens: normalizeSoftCapTokens(stored?.softCapTokens),
			softCapByModel: normalizeSoftCapByModel(stored?.softCapByModel),
			autoCompactionInstructions: normalizeAutoCompactionInstructions(stored?.autoCompactionInstructions),
			quickPhrases: stored?.quickPhrases ?? [...DEFAULT_CLIENT_SETTINGS.quickPhrases],
			quickPhrasesEnabled: stored?.quickPhrasesEnabled ?? true,
			minimalNewChat: stored?.minimalNewChat ?? false,
			preserveDraftAcrossConversations: stored?.preserveDraftAcrossConversations ?? false,
			reviewPrompt: stored?.reviewPrompt ?? "",
			reviewDisabledSkills:
				stored?.reviewDisabledSkills ?? (stored ? [] : [...DEFAULT_CLIENT_SETTINGS.reviewDisabledSkills]),
			disabledPlugins: stored?.disabledPlugins ?? (stored ? [] : [...(DEFAULT_CLIENT_SETTINGS.disabledPlugins ?? [])]),
			uiLayout: stored?.uiLayout ? normalizeUiLayout(stored.uiLayout) : structuredClone(DEFAULT_UI_LAYOUT),
			defaultAgentPreset:
				typeof stored?.defaultAgentPreset === "string" && stored.defaultAgentPreset
					? stored.defaultAgentPreset
					: "standard",
			defaultPermissionPreset:
				typeof stored?.defaultPermissionPreset === "string" && stored.defaultPermissionPreset
					? stored.defaultPermissionPreset
					: stored
						? "workspace-write-never"
						: (DEFAULT_CLIENT_SETTINGS.defaultPermissionPreset ?? "workspace-write-never"),
		};
	}

	/** Persist the settings-panel state (partial merge) — global shared config. */
	saveSettings(_clientId: string, settings: Partial<ClientSettings>): ClientSettings {
		const before = this.getSettingsSnapshot(_clientId);
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		/**
		 * 生效设置打底、磁盘现值覆盖：磁盘上缺的键回退到**当前生效值**（不是 `[]` / `undefined`）。
		 *
		 * `readSettings` 的「老文件不补默认」语义是有意的（`stored ? undefined : DEFAULT`），所以磁盘
		 * 上「没这个键」不等于「显式设成空」：拿裸磁盘 partial 当 `cur` 会把缺失键写成 `[]`——例如
		 * 出厂后第一次 `set_settings` 就把 `toolOnDemandTools` 清空（重量级工具从此常驻）、
		 * 把 `disabledPluginTools` 清空（出厂默认关掉的插件工具全开）。
		 * 磁盘有值时仍以磁盘现值为准（legacy 形状的 `disabledAgentTools` 由这里的覆盖带着走）。
		 */
		const cur = { ...before, ...state.settings } as Partial<ClientSettings> & Record<string, unknown>;
		state.settings = {
			promptMode: settings.promptMode ?? cur.promptMode ?? "append",
			customSystemPrompt: settings.customSystemPrompt ?? cur.customSystemPrompt ?? "",
			promptTemplate: settings.promptTemplate ?? cur.promptTemplate ?? "",
			promptOverrides: { ...(settings.promptOverrides ?? cur.promptOverrides) },
			promptDisabled:
				settings.promptDisabled !== undefined
					? [...settings.promptDisabled]
					: (cur.promptDisabled ?? [...DEFAULT_PROMPT_DISABLED]),
			_promptPluginDevConfigured:
				settings.promptDisabled !== undefined ? true : (cur._promptPluginDevConfigured ?? false),
			toolPromptOverrides: normalizeToolPromptOverrides(settings.toolPromptOverrides ?? cur.toolPromptOverrides),
			disabledSkills: settings.disabledSkills ?? cur.disabledSkills ?? [],
			disabledExtensions: settings.disabledExtensions ?? cur.disabledExtensions ?? [],
			disabledAgentTools: normalizeDisabledAgentTools(settings.disabledAgentTools ?? cur.disabledAgentTools),
			toolOnDemandTools: normalizeToolOnDemandList(settings.toolOnDemandTools ?? cur.toolOnDemandTools),
			disabledPluginTools: normalizeDisabledPluginTools(settings.disabledPluginTools ?? cur.disabledPluginTools),
			nativeCliInheritModel: {
				...normalizeNativeCliInheritModel(cur.nativeCliInheritModel),
				...normalizeNativeCliInheritModel(settings.nativeCliInheritModel),
			},
			terminalToolsEnabled: settings.terminalToolsEnabled ?? cur.terminalToolsEnabled ?? false,
			terminalBash: settings.terminalBash ?? cur.terminalBash ?? false,
			terminalBashIdleMs: settings.terminalBashIdleMs ?? cur.terminalBashIdleMs ?? 15_000,
			terminalBashMaxForegroundMs: settings.terminalBashMaxForegroundMs ?? cur.terminalBashMaxForegroundMs ?? 60_000,
			toolWatchdogTimeoutMs: normalizeToolWatchdogTimeoutMs(
				settings.toolWatchdogTimeoutMs ?? cur.toolWatchdogTimeoutMs ?? DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS,
			),
			readDirEnabled: settings.readDirEnabled ?? cur.readDirEnabled ?? true,
			bgAutoCleanupMin: normalizeBgCleanupMinutes(settings.bgAutoCleanupMin ?? cur.bgAutoCleanupMin),
			toolLazyLoading: settings.toolLazyLoading ?? cur.toolLazyLoading ?? DEFAULT_TOOL_LAZY_LOADING,
			codemodeMode: normalizeCodemodeMode(settings.codemodeMode ?? cur.codemodeMode ?? DEFAULT_CODEMODE_MODE),
			codemodeInlineBudget: normalizeCodemodeInlineBudget(
				settings.codemodeInlineBudget ?? cur.codemodeInlineBudget ?? DEFAULT_CODEMODE_INLINE_BUDGET,
			),
			toolApprovalEnabled: settings.toolApprovalEnabled ?? cur.toolApprovalEnabled ?? true,
			questionnaireEnabled: settings.questionnaireEnabled ?? cur.questionnaireEnabled ?? true,
			questionPresentation: settings.questionPresentation ?? cur.questionPresentation ?? "queue",
			toolApprovalPresentation: settings.toolApprovalPresentation ?? cur.toolApprovalPresentation ?? "all",
			questionTimeoutSeconds: settings.questionTimeoutSeconds ?? cur.questionTimeoutSeconds ?? 240,
			goalModeEnabled: settings.goalModeEnabled ?? cur.goalModeEnabled ?? true,
			parallelReminderEnabled: settings.parallelReminderEnabled ?? cur.parallelReminderEnabled ?? true,
			thinkingWrap: settings.thinkingWrap ?? cur.thinkingWrap ?? false,
			devNoCache: settings.devNoCache ?? cur.devNoCache,
			autoReload: settings.autoReload ?? cur.autoReload,
			internalMcpEnabled: settings.internalMcpEnabled ?? cur.internalMcpEnabled,
			toolsWrap: settings.toolsWrap ?? cur.toolsWrap ?? true,
			toolImagesEnabled: settings.toolImagesEnabled ?? cur.toolImagesEnabled ?? true,
			keepRecentMessages: normalizeKeepRecentMessages(
				settings.keepRecentMessages ?? cur.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES,
			),
			reversePagination: settings.reversePagination ?? cur.reversePagination ?? false,
			showForkedParentSessions: settings.showForkedParentSessions ?? cur.showForkedParentSessions ?? true,
			retainFinishedConversations: settings.retainFinishedConversations ?? cur.retainFinishedConversations ?? false,
			openRecentSessionOnProjectSwitch:
				settings.openRecentSessionOnProjectSwitch ?? cur.openRecentSessionOnProjectSwitch ?? true,
			skillsFullText: normalizeSkillList(settings.skillsFullText ?? cur.skillsFullText),
			skillsCatalogMaxDesc: normalizeSkillsCatalogMaxDesc(
				settings.skillsCatalogMaxDesc ?? cur.skillsCatalogMaxDesc ?? DEFAULT_SKILLS_CATALOG_MAX_DESC,
			),
			skillsCatalogShowLocation:
				settings.skillsCatalogShowLocation !== undefined
					? Boolean(settings.skillsCatalogShowLocation)
					: (cur.skillsCatalogShowLocation ?? false),
			skillsCatalogBudget: normalizeSkillsCatalogBudget(
				settings.skillsCatalogBudget ?? cur.skillsCatalogBudget ?? DEFAULT_SKILLS_CATALOG_BUDGET,
			),
			skillsMaxFileBytes: normalizeSkillsMaxFileBytes(
				settings.skillsMaxFileBytes ?? cur.skillsMaxFileBytes ?? DEFAULT_SKILLS_MAX_FILE_BYTES,
			),
			skillsFullTextMaxBytes: normalizeSkillsFullTextMaxBytes(
				settings.skillsFullTextMaxBytes ?? cur.skillsFullTextMaxBytes ?? DEFAULT_SKILLS_FULL_TEXT_MAX_BYTES,
			),
			chatUploadMaxMb: normalizeUploadMaxMb(settings.chatUploadMaxMb ?? cur.chatUploadMaxMb, 20),
			workspaceUploadMaxMb: normalizeUploadMaxMb(settings.workspaceUploadMaxMb ?? cur.workspaceUploadMaxMb, 100),
			folderUploadMaxMb: normalizeUploadMaxMb(settings.folderUploadMaxMb ?? cur.folderUploadMaxMb, 32),
			visionBridgeEnabled: settings.visionBridgeEnabled ?? cur.visionBridgeEnabled ?? true,
			visionBridgeModel:
				"visionBridgeModel" in settings ? (settings.visionBridgeModel ?? null) : (cur.visionBridgeModel ?? null),
			subagentDefaultModel:
				"subagentDefaultModel" in settings
					? (settings.subagentDefaultModel ?? null)
					: (cur.subagentDefaultModel ?? null),
			subagentMaxDepth: settings.subagentMaxDepth ?? cur.subagentMaxDepth ?? 0,
			subagentAutoWakeMaxTurns: normalizeSubagentAutoWakeMaxTurns(
				settings.subagentAutoWakeMaxTurns ?? cur.subagentAutoWakeMaxTurns,
			),
			steeringMode: normalizeQueueMode(settings.steeringMode ?? cur.steeringMode),
			followUpMode: normalizeQueueMode(settings.followUpMode ?? cur.followUpMode),
			retryMaxAttempts: normalizeRetryMaxAttempts(
				settings.retryMaxAttempts ?? cur.retryMaxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS,
			),
			softCapTokens: normalizeSoftCapTokens(settings.softCapTokens ?? cur.softCapTokens ?? 0),
			softCapByModel: normalizeSoftCapByModel(settings.softCapByModel ?? cur.softCapByModel ?? {}),
			autoCompactionInstructions: normalizeAutoCompactionInstructions(
				settings.autoCompactionInstructions ?? cur.autoCompactionInstructions ?? "",
			),
			visionBridgePromptMode: settings.visionBridgePromptMode ?? cur.visionBridgePromptMode ?? "append",
			visionBridgePrompt: settings.visionBridgePrompt ?? cur.visionBridgePrompt ?? "",
			scmCommitMsgPromptMode: settings.scmCommitMsgPromptMode ?? cur.scmCommitMsgPromptMode ?? "append",
			scmCommitMsgPrompt: settings.scmCommitMsgPrompt ?? cur.scmCommitMsgPrompt ?? "",
			...mergeQuickAskSettings(cur, settings),
			...mergeBotDraftSettings(cur, settings),
			planModePromptMode: settings.planModePromptMode ?? cur.planModePromptMode ?? "append",
			planModePrompt: settings.planModePrompt ?? cur.planModePrompt ?? "",
			reviewPrompt: settings.reviewPrompt ?? cur.reviewPrompt ?? "",
			reviewDisabledSkills: settings.reviewDisabledSkills ?? cur.reviewDisabledSkills ?? [],
			disabledPlugins: settings.disabledPlugins ?? cur.disabledPlugins ?? [],
			uiLayout: normalizeUiLayout(settings.uiLayout ?? cur.uiLayout ?? DEFAULT_UI_LAYOUT),
			quickPhrases: settings.quickPhrases ?? cur.quickPhrases ?? [],
			quickPhrasesEnabled: settings.quickPhrasesEnabled ?? cur.quickPhrasesEnabled ?? true,
			minimalNewChat: settings.minimalNewChat ?? cur.minimalNewChat ?? false,
			preserveDraftAcrossConversations:
				settings.preserveDraftAcrossConversations ?? cur.preserveDraftAcrossConversations ?? false,
			defaultAgentPreset: settings.defaultAgentPreset ?? cur.defaultAgentPreset ?? "standard",
			defaultPermissionPreset:
				settings.defaultPermissionPreset ?? cur.defaultPermissionPreset ?? "workspace-write-never",
		};
		state.settings = structuredClone(state.settings);
		this.save();
		this.settingsSnapshot = undefined;
		const committed = this.getSettingsSnapshot(_clientId);
		const change: SharedSettingsChange = Object.freeze({
			version: ++this.settingsVersion,
			clientId: _clientId,
			before,
			settings: committed,
		});
		// eslint-disable-next-line unicorn/no-useless-spread
		for (const listener of [...this.settingsListeners]) {
			try {
				const result = listener(change);
				if (result)
					void Promise.resolve(result).catch((error) => console.error("[settings] subscriber failed:", error));
			} catch (error) {
				console.error("[settings] subscriber failed:", error);
			}
		}
		return structuredClone(committed);
	}

	/** Named settings presets for a client (empty if never saved) — global shared. */
	getPresets(_clientId: string): SettingsPreset[] {
		return (this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY]?.presets ?? []).map((p) => {
			const preset = { ...p };
			if (Object.hasOwn(p, "reviewPrompt")) preset.reviewPrompt = p.reviewPrompt ?? "";
			if (Object.hasOwn(p, "reviewDisabledSkills")) preset.reviewDisabledSkills = p.reviewDisabledSkills ?? [];
			if (Object.hasOwn(p, "steeringMode")) preset.steeringMode = normalizeQueueMode(p.steeringMode);
			if (Object.hasOwn(p, "followUpMode")) preset.followUpMode = normalizeQueueMode(p.followUpMode);
			if (Object.hasOwn(p, "retryMaxAttempts")) preset.retryMaxAttempts = normalizeRetryMaxAttempts(p.retryMaxAttempts);
			if (Object.hasOwn(p, "softCapTokens")) preset.softCapTokens = normalizeSoftCapTokens(p.softCapTokens);
			if (Object.hasOwn(p, "subagentAutoWakeMaxTurns")) {
				preset.subagentAutoWakeMaxTurns = normalizeSubagentAutoWakeMaxTurns(p.subagentAutoWakeMaxTurns);
			}
			if (Object.hasOwn(p, "softCapByModel")) preset.softCapByModel = normalizeSoftCapByModel(p.softCapByModel);
			if (Object.hasOwn(p, "autoCompactionInstructions"))
				preset.autoCompactionInstructions = normalizeAutoCompactionInstructions(p.autoCompactionInstructions);
			return preset;
		});
	}

	/** Persist the named settings presets — global shared config. */
	savePresets(_clientId: string, presets: SettingsPreset[]): void {
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		state.presets = presets;
		this.save();
	}

	getProjectProviderKeys(clientId: string, cwd: string): Record<string, string> | undefined {
		return this.load()[clientId]?.projectProviderKeys?.[cwd];
	}

	getProjectProviderKey(clientId: string, cwd: string, provider: string): string | undefined {
		const all = this.load();
		const globalHit = all[ClientStateStore.GLOBAL_SETTINGS_KEY]?.projectProviderKeys?.[cwd]?.[provider];
		if (globalHit) return globalHit;
		const direct = all[clientId]?.projectProviderKeys?.[cwd]?.[provider];
		if (direct) return direct;
		for (const [id, state] of Object.entries(all)) {
			if (id === clientId || id === ClientStateStore.GLOBAL_SETTINGS_KEY) continue;
			const hit = state.projectProviderKeys?.[cwd]?.[provider];
			if (hit) return hit;
		}
		return undefined;
	}

	saveProjectProviderKey(clientId: string, cwd: string, provider: string, keyName: string): void {
		const all = this.load();
		const globalState = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		const gMap = (globalState.projectProviderKeys ??= {});
		(gMap[cwd] ??= {})[provider] = keyName;

		const state = (all[clientId] ??= { projects: [] });
		this.touchClient(all, clientId);
		const map = (state.projectProviderKeys ??= {});
		const inner = (map[cwd] ??= {});
		inner[provider] = keyName;
		this.save();
	}

	deleteProjectProviderKey(clientId: string, cwd: string, provider: string): void {
		const all = this.load();
		const gInner = all[ClientStateStore.GLOBAL_SETTINGS_KEY]?.projectProviderKeys?.[cwd];
		if (gInner && provider in gInner) {
			delete gInner[provider];
			if (Object.keys(gInner).length === 0) {
				delete all[ClientStateStore.GLOBAL_SETTINGS_KEY]!.projectProviderKeys![cwd];
			}
		}
		const inner = all[clientId]?.projectProviderKeys?.[cwd];
		if (!inner || !(provider in inner)) return;
		delete inner[provider];
		if (Object.keys(inner).length === 0) {
			delete all[clientId]!.projectProviderKeys![cwd];
		}
		this.save();
	}

	deleteProviderEverywhere(provider: string): number {
		const all = this.load();
		let removed = 0;
		for (const state of Object.values(all)) {
			const map = state.projectProviderKeys;
			if (!map) continue;
			for (const [cwd, inner] of Object.entries(map)) {
				if (inner && provider in inner) {
					delete inner[provider];
					removed++;
					if (Object.keys(inner).length === 0) delete map[cwd];
				}
			}
			if (map && Object.keys(map).length === 0) delete state.projectProviderKeys;
		}
		if (removed > 0) this.save();
		return removed;
	}

	repointDeletedKeyEverywhere(provider: string, deletedKeyName: string, newActive: string | null): number {
		const all = this.load();
		let touched = 0;
		for (const state of Object.values(all)) {
			const map = state.projectProviderKeys;
			if (!map) continue;
			for (const [cwd, inner] of Object.entries(map)) {
				if (inner?.[provider] !== deletedKeyName) continue;
				if (newActive) inner[provider] = newActive;
				else {
					delete inner[provider];
					if (Object.keys(inner).length === 0) delete map[cwd];
				}
				touched++;
			}
			if (map && Object.keys(map).length === 0) delete state.projectProviderKeys;
		}
		if (touched > 0) this.save();
		return touched;
	}

	getProjectModel(clientId: string, cwd: string, engine?: string): string | undefined {
		const all = this.load();
		const eng = engine?.trim();
		if (eng) {
			const globalEngHit = all[ClientStateStore.GLOBAL_SETTINGS_KEY]?.engineProjectModels?.[eng]?.[cwd];
			if (globalEngHit) return globalEngHit;
			const directEng = all[clientId]?.engineProjectModels?.[eng]?.[cwd];
			if (directEng) return directEng;

			const engCandidates: { model: string; lastUsed: number }[] = [];
			for (const [id, state] of Object.entries(all)) {
				if (id === clientId || id === ClientStateStore.GLOBAL_SETTINGS_KEY) continue;
				const m = state.engineProjectModels?.[eng]?.[cwd];
				if (m) {
					const p = state.projects?.find((proj) => proj.path === cwd);
					engCandidates.push({ model: m, lastUsed: p?.lastUsed ?? 0 });
				}
			}
			if (engCandidates.length > 0) {
				engCandidates.sort((a, b) => b.lastUsed - a.lastUsed);
				return engCandidates[0].model;
			}

			if (eng !== "pi") {
				return undefined;
			}
		}

		const globalHit = all[ClientStateStore.GLOBAL_SETTINGS_KEY]?.projectModels?.[cwd];
		if (globalHit) return globalHit;
		const direct = all[clientId]?.projectModels?.[cwd];
		if (direct) return direct;
		const candidates: { model: string; lastUsed: number }[] = [];
		for (const [id, state] of Object.entries(all)) {
			if (id === clientId || id === ClientStateStore.GLOBAL_SETTINGS_KEY) continue;
			const m = state.projectModels?.[cwd];
			if (m) {
				const p = state.projects?.find((proj) => proj.path === cwd);
				candidates.push({ model: m, lastUsed: p?.lastUsed ?? 0 });
			}
		}
		if (candidates.length > 0) {
			candidates.sort((a, b) => b.lastUsed - a.lastUsed);
			return candidates[0].model;
		}
		return undefined;
	}

	saveProjectModel(clientId: string, cwd: string, modelId: string, engine?: string): void {
		const all = this.load();
		const eng = engine?.trim();
		if (eng) {
			const globalState = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
			((globalState.engineProjectModels ??= {})[eng] ??= {})[cwd] = modelId;
			const state = (all[clientId] ??= { projects: [] });
			this.touchClient(all, clientId);
			((state.engineProjectModels ??= {})[eng] ??= {})[cwd] = modelId;
		}
		if (!eng || eng === "pi") {
			const globalState = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
			(globalState.projectModels ??= {})[cwd] = modelId;
			const state = (all[clientId] ??= { projects: [] });
			this.touchClient(all, clientId);
			(state.projectModels ??= {})[cwd] = modelId;
		}
		this.save();
	}

	deleteProjectModel(clientId: string, cwd: string, engine?: string): void {
		const all = this.load();
		const eng = engine?.trim();
		if (eng) {
			const gEng = all[ClientStateStore.GLOBAL_SETTINGS_KEY]?.engineProjectModels?.[eng];
			if (gEng && cwd in gEng) {
				delete gEng[cwd];
			}
			const cEng = all[clientId]?.engineProjectModels?.[eng];
			if (cEng && cwd in cEng) {
				delete cEng[cwd];
			}
		}
		if (!eng || eng === "pi") {
			const gMap = all[ClientStateStore.GLOBAL_SETTINGS_KEY]?.projectModels;
			if (gMap && cwd in gMap) {
				delete gMap[cwd];
				if (Object.keys(gMap).length === 0) delete all[ClientStateStore.GLOBAL_SETTINGS_KEY]!.projectModels;
			}
			const map = all[clientId]?.projectModels;
			if (map && cwd in map) {
				delete map[cwd];
				if (Object.keys(map).length === 0) delete all[clientId]!.projectModels;
			}
		}
		this.save();
	}

	getDefaultModel(engine?: string): string | undefined {
		const eng = engine?.trim();
		const globalSettings = this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY];
		if (eng) {
			const engDef = globalSettings?.defaultModels?.[eng];
			if (engDef) return engDef;
			if (eng !== "pi") return undefined;
		}
		return globalSettings?.defaultModel;
	}

	saveDefaultModel(modelId: string, engine?: string): void {
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		const eng = engine?.trim();
		if (eng) {
			(state.defaultModels ??= {})[eng] = modelId;
		}
		if (!eng || eng === "pi") {
			state.defaultModel = modelId;
		}
		this.save();
	}

	clearDefaultModel(): void {
		const all = this.load();
		const state = all[ClientStateStore.GLOBAL_SETTINGS_KEY];
		if (!state) return;
		delete state.defaultModel;
		delete state.defaultProviderKeys;
		this.save();
	}

	getDefaultProviderKey(provider: string): string | undefined {
		return this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY]?.defaultProviderKeys?.[provider];
	}

	saveDefaultProviderKey(provider: string, keyName: string): void {
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		(state.defaultProviderKeys ??= {})[provider] = keyName;
		this.save();
	}

	getPinnedSessions(cwd: string): string[] {
		const normCwd = normalizePathKey(cwd);
		const map = this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY]?.pinnedSessions;
		return map?.[normCwd] ?? [];
	}

	setSessionPinned(cwd: string, sessionPath: string, pinned: boolean): void {
		const normCwd = normalizePathKey(cwd);
		const normPath = normalizePathKey(sessionPath);
		const absPath = resolve(sessionPath);
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		const map = (state.pinnedSessions ??= {});
		const list = map[normCwd] ?? [];
		const filtered = list.filter((p) => normalizePathKey(p) !== normPath);
		if (pinned) {
			filtered.push(absPath);
			map[normCwd] = filtered;
		} else {
			if (filtered.length > 0) {
				map[normCwd] = filtered;
			} else {
				delete map[normCwd];
			}
		}
		if (Object.keys(map).length === 0) {
			delete state.pinnedSessions;
		}
		this.save();
	}

	isSessionPinned(cwd: string, sessionPath: string): boolean {
		const list = this.getPinnedSessions(cwd);
		const norm = normalizePathKey(sessionPath);
		return list.some((p) => normalizePathKey(p) === norm);
	}

	cleanPinnedSession(sessionPath: string): void {
		const norm = normalizePathKey(sessionPath);
		const all = this.load();
		const map = all[ClientStateStore.GLOBAL_SETTINGS_KEY]?.pinnedSessions;
		if (!map) return;
		let changed = false;
		for (const [cwdKey, list] of Object.entries(map)) {
			const next = list.filter((p) => normalizePathKey(p) !== norm);
			if (next.length !== list.length) {
				changed = true;
				if (next.length > 0) {
					map[cwdKey] = next;
				} else {
					delete map[cwdKey];
				}
			}
		}
		if (changed) {
			if (Object.keys(map).length === 0) {
				delete all[ClientStateStore.GLOBAL_SETTINGS_KEY]!.pinnedSessions;
			}
			this.save();
		}
	}

	repointDeletedKeyInDefault(provider: string, deletedKeyName: string, newActive: string | null): void {
		const all = this.load();
		const map = all[ClientStateStore.GLOBAL_SETTINGS_KEY]?.defaultProviderKeys;
		if (!map || map[provider] !== deletedKeyName) return;
		if (newActive) map[provider] = newActive;
		else {
			delete map[provider];
			if (Object.keys(map).length === 0) delete all[ClientStateStore.GLOBAL_SETTINGS_KEY]!.defaultProviderKeys;
		}
		this.save();
	}

	getQuickPhrasesSeeded(): boolean {
		const meta = this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY] as { quickPhrasesSeeded?: boolean } | undefined;
		return !!meta?.quickPhrasesSeeded;
	}

	markQuickPhrasesSeeded(): void {
		const all = this.load();
		const meta = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] }) as {
			projects: unknown[];
			quickPhrasesSeeded?: boolean;
		};
		if (meta.quickPhrasesSeeded) return;
		meta.quickPhrasesSeeded = true;
		this.save();
	}

	getMarkerSettings(_clientId: string): MarkerSettings {
		const s = this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY]?.markers;
		return {
			disabledMarkers: s?.disabledMarkers ?? [...DEFAULT_DISABLED_MARKERS],
		};
	}

	/**
	 * 【一次性迁移】旧版独立的「启用标记工具（全局）」开关是否被关掉。
	 * `undefined` = 旧数据里没有这个字段。新语义「全关即全局关闭」由 MarkerService 从 disabledMarkers 派生。
	 *  sunset 计划：v0.123 移除该兼容分支（旧数据普及后，与「全关即全局关闭」长期并存会造成语义模糊）。
	 */
	getLegacyMarkersGlobalOff(): boolean | undefined {
		const markers = this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY]?.markers as unknown as
			{ markersEnabled?: unknown } | undefined;
		return typeof markers?.markersEnabled === "boolean" ? !markers.markersEnabled : undefined;
	}

	saveMarkerSettings(_clientId: string, settings: Partial<MarkerSettings>): void {
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		const cur = state.markers ?? { disabledMarkers: [...DEFAULT_DISABLED_MARKERS] };
		// 只落盘 per-marker 黑名单：整块覆盖会顺带清掉旧数据里已下线的 markersEnabled 字段
		state.markers = {
			disabledMarkers: settings.disabledMarkers ?? cur.disabledMarkers ?? [...DEFAULT_DISABLED_MARKERS],
		};
		this.save();
	}

	getClientEngine(clientId: string): EngineId | undefined {
		const eng = this.load()[clientId]?.engine;
		return eng === "dsh" || eng === "pi" || eng === "codex" || eng === "claude" || eng === "agy" || eng === "durable"
			? eng
			: undefined;
	}

	saveClientEngine(clientId: string, engine: EngineId): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		state.engine = engine;
		this.touchClient(all, clientId);
		this.save();
	}

	getDefaultEngine(): EngineId | undefined {
		const eng = this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY]?.defaultEngine;
		return eng === "dsh" || eng === "pi" || eng === "codex" || eng === "claude" || eng === "agy" || eng === "durable"
			? eng
			: undefined;
	}

	saveDefaultEngine(engine: EngineId): void {
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		state.defaultEngine = engine;
		this.save();
	}

	saveProjectName(cwd: string, name: string): void {
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		const key = normalizePathKey(cwd);
		const trimmed = name.trim();
		if (!trimmed) {
			if (state.projectNames && key in state.projectNames) {
				delete state.projectNames[key];
				if (Object.keys(state.projectNames).length === 0) delete state.projectNames;
				this.save();
			}
			return;
		}
		const map = (state.projectNames ??= {});
		if (map[key] === trimmed) return;
		map[key] = trimmed;
		this.save();
	}

	getProjectName(cwd: string): string | undefined {
		const all = this.load();
		const map = all[ClientStateStore.GLOBAL_SETTINGS_KEY]?.projectNames;
		if (!map) return undefined;
		const val = map[normalizePathKey(cwd)]?.trim();
		return val || undefined;
	}

	saveSessionTitle(cwd: string, sessionKey: string, title: string): void {
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		const map = (state.sessionTitles ??= {});
		const normCwd = normalizePathKey(cwd);
		const normKey = normalizePathKey(sessionKey);
		const cwdMap = (map[normCwd] ??= {});
		cwdMap[normKey] = title.trim();
		this.save();
	}

	getSessionTitle(cwd: string, sessionKey: string): string | undefined {
		const all = this.load();
		const map = all[ClientStateStore.GLOBAL_SETTINGS_KEY]?.sessionTitles;
		if (!map) return undefined;
		const normCwd = normalizePathKey(cwd);
		const normKey = normalizePathKey(sessionKey);
		return map[normCwd]?.[normKey] || map[normCwd]?.[sessionKey];
	}

	deleteSessionTitle(cwd: string, sessionKey: string): void {
		const all = this.load();
		const map = all[ClientStateStore.GLOBAL_SETTINGS_KEY]?.sessionTitles;
		if (!map) return;
		const normCwd = normalizePathKey(cwd);
		const normKey = normalizePathKey(sessionKey);
		if (map[normCwd]) {
			delete map[normCwd][normKey];
			delete map[normCwd][sessionKey];
			if (Object.keys(map[normCwd]).length === 0) delete map[normCwd];
			if (Object.keys(map).length === 0) delete all[ClientStateStore.GLOBAL_SETTINGS_KEY]!.sessionTitles;
			this.save();
		}
	}
}
