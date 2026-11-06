export function getMessage(key: string, substitutions?: string | string[], fallback?: string): string {
	try {
		if (typeof chrome !== "undefined" && chrome?.i18n?.getMessage) {
			const msg = chrome.i18n.getMessage(key, substitutions);
			if (msg) return msg;
		}
	} catch {}
	if (fallback !== undefined) {
		if (substitutions) {
			const arr = Array.isArray(substitutions) ? substitutions : [substitutions];
			return fallback.replace(/\$(\d+)/g, (_, n) => arr[Number(n) - 1] ?? "");
		}
		return fallback;
	}
	return "";
}
