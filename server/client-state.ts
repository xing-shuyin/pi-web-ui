import { readFileSync } from "node:fs";
import { normalizeNativeCliInheritModel, type NativeCliInheritModel } from "./engine-catalog.js";
import { normalizeUploadMaxMb } from "./payload-limits.js";
import * as fsPromises from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";
import { normalizeAutoCompactionInstructions, normalizeSoftCapByModel, normalizeSoftCapTokens } from "./soft-cap.js";
import { deriveLegacy, legacyToDisabled, normalizeDisabledAgentTools } from "./tool-manager.js";
import { normalizeToolPromptOverrides, type ToolPromptOverrideMap } from "./tool-prompt-overrides.js";
import { UI_SLOTS } from "./plugin-ui-slots.js";
import { DEFAULT_PROMPT_DISABLED } from "./prompt-composer.js";
import type { EngineId, QueueMode, ThinkingLevel, UiAlign, UiLayoutPrefs, UiSlotId } from "./protocol.js";
import { mergeQuickAskSettings, normalizeQuickAskSettings, type QuickAskSettings } from "./quick-ask-settings.js";

export type PromptMode = "append" | "replace";

export function normalizeQueueMode(value: unknown): QueueMode {
	return value === "one-at-a-time" ? value : "all";
}

export function normalizePromptDisabled(
	stored?: { promptDisabled?: string[]; _promptPluginDevConfigured?: boolean } | null,
): string[] {
	if (!stored || stored.promptDisabled === undefined) {
		return [...DEFAULT_PROMPT_DISABLED];
	}
	const list = [...stored.promptDisabled];
	if (!stored._promptPluginDevConfigured && !list.includes("plugin_dev")) {
		list.push("plugin_dev");
	}
	return list;
}

export const DEFAULT_RETRY_MAX_ATTEMPTS = 6;

export const DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS = (() => {
	const v = Number(process.env.PI_WEB_TOOL_TIMEOUT_MS);
	return Number.isFinite(v) && v >= 0 ? v : 20 * 60_000;
})();

export const DEFAULT_KEEP_RECENT_MESSAGES = 15;
export const KEEP_RECENT_MESSAGES_MIN = 5;
export const KEEP_RECENT_MESSAGES_MAX = 100;

export function normalizeKeepRecentMessages(v: unknown): number {
	if (v === null || v === undefined || v === "") return DEFAULT_KEEP_RECENT_MESSAGES;
	const n = Math.floor(Number(v));
	if (!Number.isFinite(n)) return DEFAULT_KEEP_RECENT_MESSAGES;
	if (n < KEEP_RECENT_MESSAGES_MIN) return KEEP_RECENT_MESSAGES_MIN;
	if (n > KEEP_RECENT_MESSAGES_MAX) return KEEP_RECENT_MESSAGES_MAX;
	return n;
}

export function normalizeToolWatchdogTimeoutMs(v: unknown): number {
	if (v === null || v === undefined || v === "") return DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS;
	const n = Math.floor(Number(v));
	if (!Number.isFinite(n) || n < 0) return DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS;
	return n;
}

export const BG_CLEANUP_MINUTES = [0, 15, 30, 60, 120] as const;

export function normalizeBgCleanupMinutes(v: unknown): number {
	const n = Math.floor(Number(v));
	if (!Number.isFinite(n) || n <= 0) return 0;
	let best = 0;
	for (const step of BG_CLEANUP_MINUTES) if (step <= n && step > best) best = step;
	return best;
}

export const TOOL_WATCHDOG_EXPLICIT_GRACE_MS = 5_000;

export function effectiveToolWatchdogMs(baseMs: number, toolName?: string, args?: unknown): number {
	if (!Number.isFinite(baseMs) || baseMs <= 0) return 0;
	let ms = baseMs;
	if (toolName === "bash" && args && typeof args === "object") {
		const raw = (args as { timeout?: unknown }).timeout;
		const sec = typeof raw === "number" ? raw : Number(raw);
		if (Number.isFinite(sec) && sec > 0) ms = Math.max(ms, sec * 1000 + TOOL_WATCHDOG_EXPLICIT_GRACE_MS);
	}
	return ms;
}

export function normalizeDisabledPluginTools(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	for (const x of v) {
		if (typeof x !== "string") continue;
		const name = x.trim();
		if (!name || name.length > 128 || out.includes(name)) continue;
		out.push(name);
		if (out.length >= 256) break;
	}
	return out;
}

export function normalizeRetryMaxAttempts(v: unknown): number {
	const n = Math.floor(Number(v));
	if (!Number.isFinite(n)) return DEFAULT_RETRY_MAX_ATTEMPTS;
	return Math.min(100, Math.max(0, n));
}

export function defaultSubagentAutoWakeMaxTurns(): number {
	const raw = process.env.PI_WEB_SUBAGENT_AUTO_WAKE_MAX_TURNS;
	if (raw !== undefined && raw.trim() !== "") {
		const v = Number(raw);
		if (Number.isFinite(v) && v >= 0) {
			return Math.floor(v);
		}
	}
	return 5;
}

export function normalizeSubagentAutoWakeMaxTurns(v: unknown): number {
	if (v === null || v === undefined || v === "") return defaultSubagentAutoWakeMaxTurns();
	const n = Math.floor(Number(v));
	if (!Number.isFinite(n) || n < 0) return defaultSubagentAutoWakeMaxTurns();
	return n;
}

export function normalizeUiLayout(v: unknown): UiLayoutPrefs {
	if (!v || typeof v !== "object" || Array.isArray(v)) return {};
	const o = v as Record<string, unknown>;
	const arr = (x: unknown, max: number): string[] | undefined => {
		if (!Array.isArray(x)) return undefined;
		const out = [
			...new Set(x.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 96)),
		].slice(0, max);
		return out.length ? out : undefined;
	};
	const dict = (x: unknown, max: number): Record<string, string> | undefined => {
		if (!x || typeof x !== "object" || Array.isArray(x)) return undefined;
		const out: Record<string, string> = {};
		for (const [k, val] of Object.entries(x as Record<string, unknown>).slice(0, max)) {
			if (k.length > 0 && k.length <= 96 && typeof val === "string" && val.length > 0 && val.length <= 120) {
				out[k] = val;
			}
		}
		return Object.keys(out).length ? out : undefined;
	};
	const BRAND_NEW = "host:brand";
	const isBrandOld = (id: string): boolean => id === "host:brand-logo" || id === "host:brand-name";
	const mapBrandList = (list: string[] | undefined): string[] | undefined => {
		if (!list) return undefined;
		const out: string[] = [];
		for (const id of list) {
			const mapped = isBrandOld(id) ? BRAND_NEW : id;
			if (!out.includes(mapped)) out.push(mapped);
		}
		return out.length ? out : undefined;
	};
	const foldBrandDict = (
		src: Record<string, string> | undefined,
		logoFirst: boolean,
	): Record<string, string> | undefined => {
		if (!src) return undefined;
		const out: Record<string, string> = {};
		for (const [k, val] of Object.entries(src)) {
			if (isBrandOld(k)) continue;
			out[k] = val;
		}
		if (out[BRAND_NEW] === undefined) {
			const picked = logoFirst
				? (src["host:brand-logo"] ?? src["host:brand-name"])
				: (src["host:brand-name"] ?? src["host:brand-logo"]);
			if (picked !== undefined) out[BRAND_NEW] = picked;
		}
		return Object.keys(out).length ? out : undefined;
	};
	const hidden = mapBrandList(arr(o.hidden, 200));
	const shown = mapBrandList(arr(o.shown, 200));
	const order = mapBrandList(arr(o.order, 200));
	const groups = foldBrandDict(dict(o.groups, 200), true);
	const labels = foldBrandDict(dict(o.labels, 200), false);
	let align: Record<string, UiAlign> | undefined;
	if (o.align && typeof o.align === "object" && !Array.isArray(o.align)) {
		align = {};
		for (const [k, val] of Object.entries(o.align as Record<string, unknown>).slice(0, 200)) {
			if (k.length > 0 && k.length <= 96 && (val === "start" || val === "center" || val === "end")) {
				align[k] = val;
			}
		}
		if (Object.keys(align).length === 0) align = undefined;
	}
	if (align && ("host:brand-logo" in align || "host:brand-name" in align)) {
		const out: Record<string, UiAlign> = {};
		for (const [k, val] of Object.entries(align)) {
			if (k === "host:brand-logo" || k === "host:brand-name") continue;
			out[k] = val;
		}
		if (out[BRAND_NEW] === undefined) {
			const picked = align["host:brand-logo"] ?? align["host:brand-name"];
			if (picked !== undefined) out[BRAND_NEW] = picked;
		}
		align = Object.keys(out).length ? out : undefined;
	}
	const topbarText = typeof o.topbarText === "boolean" ? (o.topbarText as boolean) : undefined;
	const sideDockFloat = typeof o.sideDockFloat === "boolean" ? (o.sideDockFloat as boolean) : undefined;
	let slots: Record<string, UiSlotId> | undefined;
	if (o.slots && typeof o.slots === "object" && !Array.isArray(o.slots)) {
		slots = {};
		for (const [k, val] of Object.entries(o.slots as Record<string, unknown>).slice(0, 200)) {
			if (k.length > 0 && k.length <= 96 && typeof val === "string" && UI_SLOTS.has(val)) {
				slots[k] = val as UiSlotId;
			}
		}
		if (Object.keys(slots).length === 0) slots = undefined;
	}
	if (slots && ("host:brand-logo" in slots || "host:brand-name" in slots)) {
		const out: Record<string, UiSlotId> = {};
		for (const [k, val] of Object.entries(slots)) {
			if (k === "host:brand-logo" || k === "host:brand-name") continue;
			out[k] = val;
		}
		if (out[BRAND_NEW] === undefined) {
			const picked = slots["host:brand-logo"] ?? slots["host:brand-name"];
			if (picked !== undefined) out[BRAND_NEW] = picked;
		}
		slots = Object.keys(out).length ? out : undefined;
	}
	return {
		...(hidden ? { hidden } : {}),
		...(shown ? { shown } : {}),
		...(order ? { order } : {}),
		...(groups ? { groups } : {}),
		...(align ? { align } : {}),
		...(labels ? { labels } : {}),
		...(topbarText !== undefined ? { topbarText } : {}),
		...(sideDockFloat !== undefined ? { sideDockFloat } : {}),
		...(slots ? { slots } : {}),
	};
}

export function normalizeSkillList(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export const DEFAULT_SKILLS_CATALOG_MAX_DESC = 250;
export const DEFAULT_SKILLS_CATALOG_BUDGET = 20000;
export const DEFAULT_SKILLS_MAX_FILE_BYTES = 8192;
export const DEFAULT_SKILLS_FULL_TEXT_MAX_BYTES = 32768;
export const MAX_SKILLS_MAX_FILE_BYTES = 1024 * 1024;
export const MAX_SKILLS_FULL_TEXT_MAX_BYTES = 4 * 1024 * 1024;

export function normalizeSkillsMaxFileBytes(v: unknown): number {
	if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
		return Math.min(Math.floor(v), MAX_SKILLS_MAX_FILE_BYTES);
	}
	return DEFAULT_SKILLS_MAX_FILE_BYTES;
}

export function normalizeSkillsFullTextMaxBytes(v: unknown): number {
	if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
		return Math.min(Math.floor(v), MAX_SKILLS_FULL_TEXT_MAX_BYTES);
	}
	return DEFAULT_SKILLS_FULL_TEXT_MAX_BYTES;
}

export function normalizeSkillsCatalogMaxDesc(v: unknown): number {
	if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
		return Math.floor(v);
	}
	return DEFAULT_SKILLS_CATALOG_MAX_DESC;
}

export function normalizeSkillsCatalogBudget(v: unknown): number {
	if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
		return Math.floor(v);
	}
	return DEFAULT_SKILLS_CATALOG_BUDGET;
}

export const DEFAULT_TOOL_LAZY_LOADING = (() => {
	const v = (process.env.PI_WEB_TOOL_LAZY_LOADING ?? "").trim().toLowerCase();
	return v === "1" || v === "true" || v === "on" || v === "yes";
})();

export const DEFAULT_CODEMODE_MODE: "on" | "only" = "on";
export const DEFAULT_CODEMODE_INLINE_BUDGET = 3000;

export function normalizeCodemodeMode(v: unknown): "on" | "only" {
	return v === "only" ? "only" : "on";
}

export function normalizeCodemodeInlineBudget(v: unknown): number {
	if (typeof v === "number" && Number.isFinite(v) && v > 0) {
		return Math.floor(v);
	}
	return DEFAULT_CODEMODE_INLINE_BUDGET;
}

export interface ClientSettings {
	promptMode: PromptMode;
	customSystemPrompt: string;
	promptTemplate: string;
	promptOverrides: Record<string, string>;
	promptDisabled: string[];
	_promptPluginDevConfigured?: boolean;
	toolPromptOverrides: ToolPromptOverrideMap;
	disabledSkills: string[];
	disabledExtensions: string[];
	nativeCliInheritModel: NativeCliInheritModel;
	terminalToolsEnabled: boolean;
	terminalBash: boolean;
	terminalBashIdleMs: number;
	terminalBashMaxForegroundMs: number;
	toolWatchdogTimeoutMs: number;
	readDirEnabled: boolean;
	bgAutoCleanupMin: number;
	toolLazyLoading: boolean;
	codemodeMode: "on" | "only";
	codemodeInlineBudget: number;
	disabledAgentTools: string[];
	disabledPluginTools?: string[];
	editSoftEnabled: boolean;
	questionnaireEnabled: boolean;
	questionPresentation?: "queue" | "all" | "manual";
	toolApprovalPresentation?: "queue" | "all" | "manual";
	questionTimeoutSeconds?: number;
	toolApprovalEnabled: boolean;
	parallelReminderEnabled: boolean;
	goalModeEnabled: boolean;
	chatUploadMaxMb?: number;
	workspaceUploadMaxMb?: number;
	folderUploadMaxMb?: number;
	visionBridgeEnabled: boolean;
	visionBridgeModel: string | null;
	visionBridgePromptMode: PromptMode;
	visionBridgePrompt: string;
	scmCommitMsgPromptMode: PromptMode;
	scmCommitMsgPrompt: string;
	quickAskEnabled: boolean;
	quickAskModel: string | null;
	quickAskThinking: ThinkingLevel;
	quickAskSystemPrompt: string;
	quickAskExplainPrompt: string;
	quickAskTranslateEnabled: QuickAskSettings["quickAskTranslateEnabled"];
	quickAskTranslateTarget: QuickAskSettings["quickAskTranslateTarget"];
	quickAskTranslateStyle: QuickAskSettings["quickAskTranslateStyle"];
	quickAskTranslatePrompt: QuickAskSettings["quickAskTranslatePrompt"];
	quickAskShowOriginal: QuickAskSettings["quickAskShowOriginal"];
	quickAskReferenceMenus: QuickAskSettings["quickAskReferenceMenus"];
	quickAskConversationScope: QuickAskSettings["quickAskConversationScope"];
	quickAskFolderScope: QuickAskSettings["quickAskFolderScope"];
	planModePromptMode: PromptMode;
	planModePrompt: string;
	reviewPrompt: string;
	reviewDisabledSkills: string[];
	disabledPlugins?: string[];
	uiLayout?: UiLayoutPrefs;
	thinkingWrap: boolean;
	devNoCache?: boolean;
	autoReload?: boolean;
	toolsWrap: boolean;
	toolImagesEnabled: boolean;
	keepRecentMessages: number;
	reversePagination?: boolean;
	showForkedParentSessions?: boolean;
	retainFinishedConversations?: boolean;
	openRecentSessionOnProjectSwitch?: boolean;
	skillsFullText: string[];
	skillsCatalogMaxDesc: number;
	skillsCatalogShowLocation: boolean;
	skillsCatalogBudget: number;
	skillsMaxFileBytes: number;
	skillsFullTextMaxBytes: number;
	subagentDefaultModel?: string | null;
	subagentMaxDepth?: number;
	subagentAutoWakeMaxTurns?: number;
	steeringMode: QueueMode;
	followUpMode: QueueMode;
	retryMaxAttempts: number;
	softCapTokens: number;
	softCapByModel: Record<string, number>;
	autoCompactionInstructions?: string;
	quickPhrases: string[];
	quickPhrasesEnabled: boolean;
	minimalNewChat: boolean;
	preserveDraftAcrossConversations: boolean;
	defaultAgentPreset?: string;
	defaultPermissionPreset?: string;
}

export interface SettingsPreset extends Partial<ClientSettings> {
	name: string;
	plugins?: import("./protocol.js").UiPresetPluginDependency[];
}

export function settingsPresetToUi(p: SettingsPreset): import("./protocol.js").UiSettingsPreset {
	return {
		name: p.name,
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

export interface MarkerSettings {
	markersEnabled: boolean;
	disabledMarkers: string[];
}

export interface ClientState {
	lastCwd?: string;
	projects: { path: string; lastUsed: number }[];
	goalPrefs?: {
		reviewModel: string | null;
		maxRounds: number;
		locked: boolean;
		execModel?: string | null;
	};
	settings?: ClientSettings;
	presets?: SettingsPreset[];
	interrupted?: { title: string; cwd: string; at: number; sessionFile?: string }[];
	removedProjects?: string[];
	workspaceRoots?: Record<string, string[]>;
	projectProviderKeys?: Record<string, Record<string, string>>;
	projectModels?: Record<string, string>;
	engineProjectModels?: Record<string, Record<string, string>>;
	defaultModel?: string;
	defaultModels?: Record<string, string>;
	defaultProviderKeys?: Record<string, string>;
	markers?: MarkerSettings;
	pinnedSessions?: Record<string, string[]>;
	sessionTitles?: Record<string, Record<string, string>>;
	locale?: string;
	engine?: EngineId;
	defaultEngine?: EngineId;
	lastActive?: number;
}

export function normalizePathKey(p: string): string {
	if (p.startsWith("ssh://")) {
		return p;
	}
	try {
		if (process.platform === "win32") {
			return resolve(p).toLowerCase();
		}
		if (/^[a-zA-Z]:[\\/]/.test(p)) {
			const drive = p.slice(0, 2).toLowerCase();
			const rest = p.slice(2).replace(/\\/g, "/").replace(/\/+/g, "/");
			return (drive + rest).toLowerCase();
		}
		return resolve(p);
	} catch {
		return process.platform === "win32" ? p.toLowerCase() : p;
	}
}

export const CLIENT_STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const MAX_TRACKED_CLIENTS = 50;
export const RECENT_PROJECTS_MAX = 100;

export const CLIENT_STATE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface SharedSettingsChange {
	readonly version: number;
	readonly clientId: string;
	readonly before: ClientSettings;
	readonly settings: ClientSettings;
}

function freezeSettings<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freezeSettings(child);
		Object.freeze(value);
	}
	return value;
}

export class ClientStateStore {
	private cache: Record<string, ClientState> | null = null;
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
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, ClientState>;
			this.cache = parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			this.cache = {};
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

	private save(): void {
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

	remember(clientId: string, cwd: string): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		this.touchClient(all, clientId);
		state.lastCwd = cwd;
		const now = Date.now();
		const targetKey = normalizePathKey(cwd);
		state.projects = [
			{ path: cwd, lastUsed: now },
			...state.projects.filter((p) => normalizePathKey(p.path) !== targetKey),
		].slice(0, RECENT_PROJECTS_MAX);
		// Also persist in global settings so new tabs and sessions inherit it immediately
		const globalState = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		globalState.projects = [
			{ path: cwd, lastUsed: now },
			...(globalState.projects ?? []).filter((p) => normalizePathKey(p.path) !== targetKey),
		].slice(0, RECENT_PROJECTS_MAX);
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
	async getRecentProjects(clientId: string): Promise<{ path: string; lastUsed: number }[]> {
		const all = this.load();
		const removedKeys = new Set(this.getRemovedProjects(clientId).map(normalizePathKey));
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
		return candidates.filter((_, i) => {
			const probe = probes[i];
			return probe?.status === "fulfilled" && probe.value;
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

	/** Record discovered projects into global settings cache (without clobbering tombstones). */
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
			if (removedKeys.has(key)) continue;
			const existing = map.get(key);
			if (!existing) {
				map.set(key, p);
				changed = true;
			} else if (p.lastUsed > existing.lastUsed) {
				existing.lastUsed = p.lastUsed;
				changed = true;
			}
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
			promptOverrides = { ...stored?.promptOverrides };
		} else if (stored && typeof stored.customSystemPrompt === "string" && stored.customSystemPrompt.trim()) {
			promptOverrides = {
				[stored.promptMode === "replace" ? "soul" : "append"]: stored.customSystemPrompt,
			};
		}
		return {
			promptMode: stored?.promptMode === "replace" ? "replace" : "append",
			customSystemPrompt: stored?.customSystemPrompt ?? "",
			promptTemplate,
			promptOverrides,
			promptDisabled: normalizePromptDisabled(stored),
			_promptPluginDevConfigured: stored?._promptPluginDevConfigured,
			toolPromptOverrides: normalizeToolPromptOverrides(stored?.toolPromptOverrides),
			disabledSkills: stored?.disabledSkills ?? [],
			disabledExtensions: stored?.disabledExtensions ?? [],
			disabledAgentTools: legacyToDisabled(stored ?? {}),
			disabledPluginTools: normalizeDisabledPluginTools(stored?.disabledPluginTools),
			nativeCliInheritModel: normalizeNativeCliInheritModel(stored?.nativeCliInheritModel),
			terminalToolsEnabled:
				stored?.disabledAgentTools !== undefined
					? deriveLegacy(legacyToDisabled(stored)).terminalToolsEnabled
					: (stored?.terminalToolsEnabled ?? false),
			terminalBash: stored?.terminalBash ?? false,
			terminalBashIdleMs: stored?.terminalBashIdleMs ?? 15_000,
			terminalBashMaxForegroundMs: stored?.terminalBashMaxForegroundMs ?? 60_000,
			toolWatchdogTimeoutMs: normalizeToolWatchdogTimeoutMs(stored?.toolWatchdogTimeoutMs),
			readDirEnabled: stored?.readDirEnabled ?? true,
			bgAutoCleanupMin: normalizeBgCleanupMinutes(stored?.bgAutoCleanupMin),
			toolLazyLoading: stored?.toolLazyLoading ?? DEFAULT_TOOL_LAZY_LOADING,
			codemodeMode: normalizeCodemodeMode(stored?.codemodeMode),
			codemodeInlineBudget: normalizeCodemodeInlineBudget(stored?.codemodeInlineBudget),
			toolApprovalEnabled: stored?.toolApprovalEnabled ?? true,
			editSoftEnabled:
				stored?.disabledAgentTools !== undefined
					? deriveLegacy(legacyToDisabled(stored)).editSoftEnabled
					: (stored?.editSoftEnabled ?? false),
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
			toolsWrap: stored?.toolsWrap ?? true,
			toolImagesEnabled: stored?.toolImagesEnabled ?? true,
			keepRecentMessages: normalizeKeepRecentMessages(stored?.keepRecentMessages),
			reversePagination: stored?.reversePagination ?? false,
			showForkedParentSessions: stored?.showForkedParentSessions ?? false,
			retainFinishedConversations: stored?.retainFinishedConversations ?? false,
			openRecentSessionOnProjectSwitch: stored?.openRecentSessionOnProjectSwitch ?? true,
			skillsFullText: normalizeSkillList(stored?.skillsFullText),
			skillsCatalogMaxDesc: normalizeSkillsCatalogMaxDesc(stored?.skillsCatalogMaxDesc),
			skillsCatalogShowLocation: Boolean(stored?.skillsCatalogShowLocation ?? false),
			skillsCatalogBudget: normalizeSkillsCatalogBudget(stored?.skillsCatalogBudget),
			skillsMaxFileBytes: normalizeSkillsMaxFileBytes(stored?.skillsMaxFileBytes),
			skillsFullTextMaxBytes: normalizeSkillsFullTextMaxBytes(stored?.skillsFullTextMaxBytes),
			chatUploadMaxMb: normalizeUploadMaxMb(stored?.chatUploadMaxMb, 20),
			workspaceUploadMaxMb: normalizeUploadMaxMb(stored?.workspaceUploadMaxMb, 100),
			folderUploadMaxMb: normalizeUploadMaxMb(stored?.folderUploadMaxMb, 32),
			visionBridgeEnabled: stored?.visionBridgeEnabled ?? true,
			visionBridgeModel: stored?.visionBridgeModel ?? null,
			visionBridgePromptMode: stored?.visionBridgePromptMode === "replace" ? "replace" : "append",
			visionBridgePrompt: stored?.visionBridgePrompt ?? "",
			scmCommitMsgPromptMode: stored?.scmCommitMsgPromptMode === "replace" ? "replace" : "append",
			scmCommitMsgPrompt: stored?.scmCommitMsgPrompt ?? "",
			...normalizeQuickAskSettings(stored ?? {}),
			planModePromptMode: stored?.planModePromptMode === "replace" ? "replace" : "append",
			planModePrompt: stored?.planModePrompt ?? "",
			subagentDefaultModel: stored?.subagentDefaultModel ?? null,
			subagentMaxDepth: stored?.subagentMaxDepth ?? 0,
			subagentAutoWakeMaxTurns: normalizeSubagentAutoWakeMaxTurns(stored?.subagentAutoWakeMaxTurns),
			steeringMode: normalizeQueueMode(stored?.steeringMode),
			followUpMode: normalizeQueueMode(stored?.followUpMode),
			retryMaxAttempts: normalizeRetryMaxAttempts(stored?.retryMaxAttempts),
			softCapTokens: normalizeSoftCapTokens(stored?.softCapTokens),
			softCapByModel: normalizeSoftCapByModel(stored?.softCapByModel),
			autoCompactionInstructions: normalizeAutoCompactionInstructions(stored?.autoCompactionInstructions),
			quickPhrases: stored?.quickPhrases ?? [],
			quickPhrasesEnabled: stored?.quickPhrasesEnabled ?? true,
			minimalNewChat: stored?.minimalNewChat ?? false,
			preserveDraftAcrossConversations: stored?.preserveDraftAcrossConversations ?? false,
			reviewPrompt: stored?.reviewPrompt ?? "",
			reviewDisabledSkills: stored?.reviewDisabledSkills ?? [],
			disabledPlugins: stored?.disabledPlugins ?? [],
			uiLayout: normalizeUiLayout(stored?.uiLayout),
			defaultAgentPreset:
				typeof stored?.defaultAgentPreset === "string" && stored.defaultAgentPreset
					? stored.defaultAgentPreset
					: "standard",
			defaultPermissionPreset:
				typeof stored?.defaultPermissionPreset === "string" && stored.defaultPermissionPreset
					? stored.defaultPermissionPreset
					: "workspace-write-never",
		};
	}

	/** Persist the settings-panel state (partial merge) — global shared config. */
	saveSettings(_clientId: string, settings: Partial<ClientSettings>): ClientSettings {
		const before = this.getSettingsSnapshot(_clientId);
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		const cur = state.settings ?? ({} as ClientSettings);
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
			editSoftEnabled: settings.editSoftEnabled ?? cur.editSoftEnabled ?? false,
			questionnaireEnabled: settings.questionnaireEnabled ?? cur.questionnaireEnabled ?? true,
			questionPresentation: settings.questionPresentation ?? cur.questionPresentation ?? "queue",
			toolApprovalPresentation: settings.toolApprovalPresentation ?? cur.toolApprovalPresentation ?? "all",
			questionTimeoutSeconds: settings.questionTimeoutSeconds ?? cur.questionTimeoutSeconds ?? 240,
			goalModeEnabled: settings.goalModeEnabled ?? cur.goalModeEnabled ?? true,
			parallelReminderEnabled: settings.parallelReminderEnabled ?? cur.parallelReminderEnabled ?? true,
			thinkingWrap: settings.thinkingWrap ?? cur.thinkingWrap ?? false,
			devNoCache: settings.devNoCache ?? cur.devNoCache,
			autoReload: settings.autoReload ?? cur.autoReload,
			toolsWrap: settings.toolsWrap ?? cur.toolsWrap ?? true,
			toolImagesEnabled: settings.toolImagesEnabled ?? cur.toolImagesEnabled ?? true,
			keepRecentMessages: normalizeKeepRecentMessages(
				settings.keepRecentMessages ?? cur.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES,
			),
			reversePagination: settings.reversePagination ?? cur.reversePagination ?? false,
			showForkedParentSessions: settings.showForkedParentSessions ?? cur.showForkedParentSessions ?? false,
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
			planModePromptMode: settings.planModePromptMode ?? cur.planModePromptMode ?? "append",
			planModePrompt: settings.planModePrompt ?? cur.planModePrompt ?? "",
			reviewPrompt: settings.reviewPrompt ?? cur.reviewPrompt ?? "",
			reviewDisabledSkills: settings.reviewDisabledSkills ?? cur.reviewDisabledSkills ?? [],
			disabledPlugins: settings.disabledPlugins ?? cur.disabledPlugins ?? [],
			uiLayout: normalizeUiLayout(settings.uiLayout ?? cur.uiLayout),
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
			markersEnabled: s?.markersEnabled ?? true,
			disabledMarkers: s?.disabledMarkers ?? [],
		};
	}

	saveMarkerSettings(_clientId: string, settings: Partial<MarkerSettings>): void {
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		const cur = state.markers ?? { markersEnabled: true, disabledMarkers: [] };
		state.markers = {
			markersEnabled: settings.markersEnabled ?? cur.markersEnabled ?? true,
			disabledMarkers: settings.disabledMarkers ?? cur.disabledMarkers ?? [],
		};
		this.save();
	}

	getClientEngine(clientId: string): EngineId | undefined {
		const eng = this.load()[clientId]?.engine;
		return eng === "dsh" || eng === "pi" || eng === "codex" || eng === "claude" || eng === "durable" ? eng : undefined;
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
		return eng === "dsh" || eng === "pi" || eng === "codex" || eng === "claude" || eng === "durable" ? eng : undefined;
	}

	saveDefaultEngine(engine: EngineId): void {
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		state.defaultEngine = engine;
		this.save();
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
