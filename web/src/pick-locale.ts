export const KNOWN_LOCALES = [
	"zh",
	"en",
	"de",
	"es",
	"fr",
	"it",
	"ja",
	"ko",
	"pt",
	"ru",
	"zh-Hant",
	"zh-HK",
	"zh-TW",
] as const;

export function isZhLocale(code: string | null | undefined): boolean {
	const c = normalizeTag(code);
	return c === "zh" || c.startsWith("zh-");
}

function matchTraditionalChinese(tag: string, known: readonly string[]): string | null {
	const parts = tag.split("-");
	if (parts[0] !== "zh" || parts.includes("hans")) return null;

	const hasTw = parts.includes("tw");
	const hasHk = parts.includes("hk") || parts.includes("mo");
	const hasHant = parts.includes("hant");

	if (!hasTw && !hasHk && !hasHant) return null;

	let candidates: string[];
	if (hasTw) {
		candidates = ["zh-tw", "zh-hant", "zh-hk"];
	} else if (hasHk) {
		candidates = ["zh-hk", "zh-hant", "zh-tw"];
	} else {
		candidates = ["zh-hant", "zh-tw", "zh-hk"];
	}

	for (const candidate of candidates) {
		const hit = findKnown(candidate, known);
		if (hit) return hit;
	}
	return null;
}

function normalizeTag(raw: unknown): string {
	return String(raw ?? "")
		.trim()
		.toLowerCase()
		.replace(/_/g, "-");
}

function findKnown(code: string, known: readonly string[]): string | null {
	return known.find((k) => k.toLowerCase() === code) ?? null;
}

function matchTag(tag: string, known: readonly string[]): string | null {
	if (!tag) return null;
	return findKnown(tag, known) ?? matchTraditionalChinese(tag, known) ?? findKnown(tag.split("-")[0] ?? "", known);
}

export function pickLocale(
	saved: string | null | undefined,
	languages: readonly string[] | null | undefined,
	fallback: string | null | undefined,
	known: readonly string[] = KNOWN_LOCALES,
): string {
	const chosen = (saved ?? "").trim();
	if (chosen) return chosen;

	for (const raw of languages ?? []) {
		const hit = matchTag(normalizeTag(raw), known);
		if (hit) return hit;
	}

	return matchTag(normalizeTag(fallback), known) ?? "en";
}
