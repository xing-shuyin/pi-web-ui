import type { MessageKey } from "./i18n/catalog";

/**
 * Default quick phrases, in display order. The text lives in the i18n catalog, so a plain module
 * only exports keys; callers translate them with the current UI language (`quickPhraseDefaults`).
 */
export const QUICK_PHRASE_DEFAULT_KEYS = [
	"quickPhrase.continue",
	"quickPhrase.publish",
	"quickPhrase.uploadGitHub",
	"quickPhrase.handlePr",
	"quickPhrase.handleIssue",
	"quickPhrase.betterWay",
	"quickPhrase.closeIssue",
] as const satisfies readonly MessageKey[];

/** Resolve the default quick phrases for the current language. */
export function quickPhraseDefaults(t: (key: MessageKey) => string): string[] {
	return QUICK_PHRASE_DEFAULT_KEYS.map((key) => t(key));
}
