import { resolve } from "node:path";
import type { EngineId } from "./protocol.js";
import type { ClientSettings, SettingsPreset } from "./settings-schema.js";

/** 一次扫盘最多记多少个最近项目（老实现 `ensureProjectsCache` 的上限）。 */
export const RECENT_PROJECTS_MAX = 100;

export interface MarkerSettings {
	/** 已关闭的标记名。全局状态由此派生：任意一个标记开着 = 全局启用，全部关闭 = 全局关闭。 */
	disabledMarkers: string[];
}

/** 出厂默认关闭的内联标记（单源：客户端状态默认值、MarkerService 均取此处）。 */
export const DEFAULT_DISABLED_MARKERS: readonly string[] = ["notify", "action", "suggest"];

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
	projectNames?: Record<string, string>;
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
			// 尾部斜杠也要归一：win32 走 resolve() 已经去掉了，这条非 win32 分支是自己拼的，
			// 留着会让 "e:/work/p" 与 "E:\\work\\p\\" 被当成两个目录（cwd 比对 / 缓存键 / 去重全分叉）。
			const rest = p.slice(2).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "");
			return (drive + rest).toLowerCase();
		}
		return resolve(p);
	} catch {
		return process.platform === "win32" ? p.toLowerCase() : p;
	}
}
