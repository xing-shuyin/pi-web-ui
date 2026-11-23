import type { QueueMode } from "./protocol.js";

export function normalizeQueueMode(value: unknown): QueueMode {
	return value === "one-at-a-time" ? value : "all";
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

/**
 * 延迟加载总闸的出厂默认：**开**（2026-11 产品决定，按当前维护者的工具配置定稿）。
 * 部署级可用环境变量 `PI_WEB_TOOL_LAZY_LOADING` 覆盖（1/true/on/yes → 开，0/false/off/no → 关），
 * 只作默认值：用户已存盘的设置优先。名单为空时开与不开等价（没有任何工具可加载）。
 */
export const DEFAULT_TOOL_LAZY_LOADING = (() => {
	const v = (process.env.PI_WEB_TOOL_LAZY_LOADING ?? "").trim().toLowerCase();
	if (!v) return true;
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
