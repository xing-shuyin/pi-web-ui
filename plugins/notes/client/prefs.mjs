const KEY = "notes:prefs";

const DEFAULTS = {
	toast: true,
	desktop: true,
	sound: false,
	autoOpen: true,
	lang: "auto",
};

let cache = null;
const listeners = new Set();

function read() {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
		return { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
	} catch {
		return { ...DEFAULTS };
	}
}

export function loadPrefs() {
	if (!cache) cache = read();
	return cache;
}

export function savePrefs(patch) {
	const next = { ...loadPrefs(), ...(patch && typeof patch === "object" ? patch : {}) };
	cache = next;
	try {
		localStorage.setItem(KEY, JSON.stringify(next));
	} catch {}
	for (const fn of [...listeners]) {
		try {
			fn(next);
		} catch (err) {
			console.error("[notes] prefs listener failed:", err);
		}
	}
	return next;
}

export function onPrefs(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
