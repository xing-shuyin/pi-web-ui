/**
 * pick-locale — which language a first visit speaks.
 *
 * `loadLocale()` used to return "zh" when nothing was stored, so anybody who
 * had never used an instance got Chinese and had to find the language chip to
 * change it. Meanwhile the repository ships eight translations besides the two
 * core ones — de, es, fr, it, ja, ko, pt, ru — and nothing ever picked them on
 * its own.
 *
 * The order here is the one every other web application uses:
 *
 *   1. what this browser chose last time (and an explicit choice is kept even
 *      if this build does not know the code — the pack machinery validates it
 *      later, and dropping it here would silently undo the user's decision);
 *   2. the first of the browser's languages this build can actually speak;
 *   3. the instance's configured default (PI_WEB_LOCALE), for a deployment
 *      that wants to name one;
 *   4. English.
 *
 * It is a pure function so the whole order can be tested without a browser.
 */

/** Locale codes this build can show: the two core ones plus every pack. */
export const KNOWN_LOCALES = ["zh", "en", "de", "es", "fr", "it", "ja", "ko", "pt", "ru", "zh-TW"] as const;

/**
 * True for every Chinese UI locale: core "zh" (Simplified) and packs such as
 * "zh-TW" (Traditional). Use it wherever data only carries a Chinese and an
 * English variant (`text`/`textEn`, `label`/`labelEn`, …): a Traditional
 * Chinese reader is better served by the Chinese one than by English.
 */
export function isZhLocale(code: string | null | undefined): boolean {
	const c = normalizeTag(code);
	return c === "zh" || c.startsWith("zh-");
}

/**
 * Chinese tags the browser sends that should land on Traditional Chinese.
 * Script subtags win over regions ("zh-Hans-HK" is Simplified); Hong Kong and
 * Macau have no pack of their own, so they share the Taiwan one.
 */
function traditionalChinese(tag: string): boolean {
	const parts = tag.split("-");
	if (parts[0] !== "zh" || parts.includes("hans")) return false;
	return parts.includes("hant") || parts.includes("tw") || parts.includes("hk") || parts.includes("mo");
}

/** Normalize a language tag: trimmed, lowercase, `_` → `-`. */
function normalizeTag(raw: unknown): string {
	return String(raw ?? "")
		.trim()
		.toLowerCase()
		.replace(/_/g, "-");
}

/** Case-insensitive lookup that returns the code exactly as `known` spells it. */
function findKnown(code: string, known: readonly string[]): string | null {
	return known.find((k) => k.toLowerCase() === code) ?? null;
}

/**
 * The known locale a tag maps to: the whole tag, then the Traditional Chinese
 * pack for "zh-HK" / "zh-Hant" / "zh-Hant-TW", then the primary subtag.
 */
function matchTag(tag: string, known: readonly string[]): string | null {
	if (!tag) return null;
	return (
		findKnown(tag, known) ??
		(traditionalChinese(tag) ? findKnown("zh-tw", known) : null) ??
		findKnown(tag.split("-")[0] ?? "", known)
	);
}

/**
 * The locale to start with.
 *
 * `saved` is what the previous visit stored, `languages` is
 * `navigator.languages`, `fallback` is the instance default.
 */
export function pickLocale(
	saved: string | null | undefined,
	languages: readonly string[] | null | undefined,
	fallback: string | null | undefined,
	known: readonly string[] = KNOWN_LOCALES,
): string {
	const chosen = (saved ?? "").trim();
	if (chosen) return chosen;

	for (const raw of languages ?? []) {
		// Browsers send tags like "it-IT", "zh-CN", "pt-BR": try the whole tag
		// (Traditional Chinese tags such as "zh-HK" / "zh-Hant" go to "zh-TW"),
		// then its primary subtag, so a regional variant lands on its language.
		const hit = matchTag(normalizeTag(raw), known);
		if (hit) return hit;
	}

	// A default this build cannot speak — a typo in a unit file — must not
	// leave the interface showing raw keys.
	// The server lowercases PI_WEB_LOCALE, so "zh-tw" must still find "zh-TW".
	return matchTag(normalizeTag(fallback), known) ?? "en";
}
