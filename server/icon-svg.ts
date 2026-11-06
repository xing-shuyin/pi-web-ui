export const MAX_ICON_SVG_LENGTH = 8192;

export function normalizeIconSvg(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const s = raw.trim();
	if (!s || s.length > MAX_ICON_SVG_LENGTH) return undefined;
	const body = s.startsWith("<?xml") ? s.slice(s.indexOf("?>") + 2).trimStart() : s;
	if (!/^<svg[\s>]/.test(body)) return undefined;
	if (!/<\/svg\s*>\s*$/.test(body)) return undefined;
	if (/<script[\s>]/i.test(body)) return undefined;
	if (/\son\w+\s*=/i.test(body)) return undefined;
	if (/javascript\s*:/i.test(body)) return undefined;
	return s;
}
