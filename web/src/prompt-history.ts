const PROMPT_HISTORY_KEY = "pi-web-ui:prompt-history";
export const PROMPT_HISTORY_MAX = 100;
const PROMPT_HISTORY_SETTINGS_KEY = "pi-web-ui:prompt-history-settings";

interface PromptHistorySettings {
	maxEntries: number;
	charLimitEnabled: boolean;
	charLimit: number;
}

const DEFAULT_PROMPT_HISTORY_SETTINGS: PromptHistorySettings = {
	maxEntries: 100,
	charLimitEnabled: false,
	charLimit: 2000,
};

export function normalizePromptHistorySettings(raw: unknown): PromptHistorySettings {
	const def = DEFAULT_PROMPT_HISTORY_SETTINGS;
	if (!raw || typeof raw !== "object") return { ...def };
	const o = raw as Record<string, unknown>;
	let maxEntries = typeof o.maxEntries === "number" ? Math.floor(o.maxEntries) : def.maxEntries;
	if (!Number.isFinite(maxEntries) || maxEntries < 1) maxEntries = 1;
	if (maxEntries > 500) maxEntries = 500;
	let charLimit = typeof o.charLimit === "number" ? Math.floor(o.charLimit) : def.charLimit;
	if (!Number.isFinite(charLimit) || charLimit < 100) charLimit = 100;
	if (charLimit > 20000) charLimit = 20000;
	const charLimitEnabled = typeof o.charLimitEnabled === "boolean" ? o.charLimitEnabled : def.charLimitEnabled;
	return { maxEntries, charLimitEnabled, charLimit };
}

export function loadPromptHistorySettings(): PromptHistorySettings {
	try {
		const raw = localStorage.getItem(PROMPT_HISTORY_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_PROMPT_HISTORY_SETTINGS };
		return normalizePromptHistorySettings(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_PROMPT_HISTORY_SETTINGS };
	}
}

export function savePromptHistorySettings(s: PromptHistorySettings): void {
	const norm = normalizePromptHistorySettings(s);
	try {
		localStorage.setItem(PROMPT_HISTORY_SETTINGS_KEY, JSON.stringify(norm));
	} catch {}
	try {
		let history = loadPromptHistory();
		if (norm.charLimitEnabled) {
			history = history.map((v) => (v.length > norm.charLimit ? v.slice(0, norm.charLimit) : v));
		}
		if (history.length > norm.maxEntries) history = history.slice(history.length - norm.maxEntries);
		persist(history);
	} catch {}
}

export function normalizeHistory(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const v of raw) {
		if (typeof v !== "string") continue;
		const t = v.trim();
		if (!t) continue;
		out.push(t);
	}
	return out;
}

export function appendHistory(history: string[], text: string, max: number = PROMPT_HISTORY_MAX): string[] {
	const t = text.trim();
	if (!t) return history;
	if (history.length > 0 && history[history.length - 1] === t) return history;
	const next = [...history, t];
	if (next.length > max) return next.slice(next.length - max);
	return next;
}

export function loadPromptHistory(): string[] {
	try {
		const raw = localStorage.getItem(PROMPT_HISTORY_KEY);
		if (!raw) return [];
		return normalizeHistory(JSON.parse(raw));
	} catch {
		return [];
	}
}

function persist(history: string[]): void {
	let cur: string[] | null = history;
	while (cur) {
		try {
			localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(cur));
			return;
		} catch (e) {
			const quota = e instanceof DOMException && (e.name === "QuotaExceededError" || e.code === 22);
			if (!quota || cur.length <= 1) {
				return;
			}
			cur = cur.slice(Math.ceil(cur.length / 2));
		}
	}
}

export function pushPromptHistory(text: string): void {
	let t = text.trim();
	if (!t) return;
	const settings = loadPromptHistorySettings();
	if (settings.charLimitEnabled && t.length > settings.charLimit) t = t.slice(0, settings.charLimit);
	const cur = loadPromptHistory();
	const next = appendHistory(cur, t, settings.maxEntries);
	if (next === cur) return;
	persist(next);
}

export function clearPromptHistory(): void {
	try {
		localStorage.removeItem(PROMPT_HISTORY_KEY);
	} catch {}
}
