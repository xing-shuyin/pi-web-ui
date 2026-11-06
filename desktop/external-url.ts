export function hubBrowserOrigin(raw: unknown): string | null {
	if (typeof raw !== "string" || raw.length > 2048 || /[\u0000-\u0020\u007f]/.test(raw)) return null;
	try {
		const url = new URL(raw);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
		return url.origin;
	} catch {
		return null;
	}
}

export const ALLOWED_EXTERNAL_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:", "tel:"]);

export function isAllowedExternalUrl(raw: string): boolean {
	const s = raw.trim();
	if (!s) return false;
	try {
		return ALLOWED_EXTERNAL_SCHEMES.has(new URL(s).protocol);
	} catch {
		return false;
	}
}
