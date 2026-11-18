export const SDK_VERSION = "0.4.0";

export function defineView(view) {
	if (!view || typeof view !== "object") throw new Error("[sdk] defineView 需要一个对象");
	if (typeof view.mount !== "function") throw new Error("[sdk] 视图缺 mount(el, ctx) 方法");
	if (view.cleanup !== undefined && typeof view.cleanup !== "function") {
		throw new Error("[sdk] cleanup 必须是函数");
	}
	return view;
}

export function defineRenderer(renderers) {
	if (!renderers || typeof renderers !== "object") throw new Error("[sdk] defineRenderer 需要 { lang: fn } 对象");
	for (const [lang, fn] of Object.entries(renderers)) {
		if (typeof fn !== "function") throw new Error(`[sdk] renderer "${lang}" 不是函数`);
	}
	return { renderers };
}

export function actionHandler(map) {
	if (!map || typeof map !== "object") throw new Error("[sdk] actionHandler 需要 { action: fn } 对象");
	return (itemId, value) => {
		const fn = map[itemId];
		if (typeof fn === "function") return fn(value);
	};
}

export function onUiAction(action, handler) {
	try {
		const bridge = globalThis.window?.__piWebUiHost;
		if (bridge && typeof bridge.onUiAction === "function") return bridge.onUiAction(action, handler);
	} catch {}
	return () => {};
}

export function getSetting(host, key, fallback) {
	try {
		const v = host?.getSettings?.()?.[key];
		return v === undefined ? fallback : v;
	} catch {
		return fallback;
	}
}

export function selectOptions(list) {
	return (Array.isArray(list) ? list : [])
		.map((x) => (typeof x === "string" ? { value: x, label: x } : x))
		.filter((x) => x && typeof x.value === "string" && x.value)
		.slice(0, 32);
}

export * from "./client-utils.mjs";

/** 浏览器里与 web app 同步的界面语言存储键（web/src/i18n.tsx 使用同一个键）。 */
const UI_LOCALE_KEY = "pi-web-ui:lang";

function normalizeLocaleTag(raw) {
	return String(raw ?? "")
		.trim()
		.toLowerCase()
		.replace(/_/g, "-");
}

/** 当前界面语言：用户显式选择 → <html lang> → navigator.languages。 */
function readActiveLocale() {
	try {
		if (typeof localStorage !== "undefined") {
			const stored = localStorage.getItem(UI_LOCALE_KEY);
			if (stored) return stored;
		}
	} catch {}
	try {
		if (typeof document !== "undefined" && document?.documentElement?.lang) return document.documentElement.lang;
	} catch {}
	try {
		if (typeof navigator !== "undefined") {
			const list = navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
			for (const tag of list) if (tag) return tag;
		}
	} catch {}
	return "";
}

function resolvePluginLocale(dicts, candidates) {
	const keys = Object.keys(dicts ?? {});
	const find = (tag) => {
		const norm = normalizeLocaleTag(tag);
		if (!norm) return null;
		const exact = keys.find((key) => normalizeLocaleTag(key) === norm);
		if (exact) return exact;
		const base = norm.split("-")[0];
		return keys.find((key) => normalizeLocaleTag(key) === base) ?? null;
	};
	for (const candidate of candidates) {
		if (!candidate) continue;
		const hit = find(candidate);
		if (hit) return hit;
	}
	if (keys.includes("en")) return "en";
	return keys[0] ?? "";
}

/**
 * 插件本地化契约：插件只提供词典，语言解析 / 回退 / 插值由 SDK 统一实现。
 * 回退链：当前语言 → 主语言（zh-TW → zh）→ en → key 本身。插值只做一遍，
 * 参数值里的 `{y}` 或 `$&` 不会被二次解析。
 */
export function createPluginI18n(dicts, options = {}) {
	const dict = dicts && typeof dicts === "object" ? dicts : {};
	const available = Object.keys(dict);
	// An explicitly passed locale is authoritative: if the caller asked for a language the
	// dictionary does not have, the answer is English — not whatever language the host page
	// happens to be in. Only an omitted locale consults the page/browser language, and an
	// empty string counts as "asked for nothing" (which also lands on English).
	const requested = typeof options.locale === "string" ? options.locale : readActiveLocale();
	const locale = resolvePluginLocale(dict, [requested]);
	const baseLocale = locale.split("-")[0] ?? "";
	const interpolate = (text, params) =>
		String(text).replace(/\{(\w+)\}/g, (match, name) =>
			params && typeof params === "object" && name in params ? String(params[name]) : match,
		);
	const t = (key, params) => {
		const raw =
			dict[locale]?.[key] ?? dict[baseLocale]?.[key] ?? dict.en?.[key] ?? (typeof key === "string" ? key : "");
		return params && typeof params === "object" ? interpolate(raw, params) : raw;
	};
	return { locale, available, t };
}
