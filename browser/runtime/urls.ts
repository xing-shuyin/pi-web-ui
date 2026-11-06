import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const INTERNAL_PAGES = ["newtab", "search", "office", "workspace"] as const;

export function isInternalUrl(value: string, assetsDir: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol !== "file:" || url.host || url.username || url.password) return false;
		const filename = fileURLToPath(url);
		return INTERNAL_PAGES.some((page) => filename === path.resolve(assetsDir, `${page}.html`));
	} catch {
		return false;
	}
}

export function normalizeBrowserUrl(value: string, assetsDir: string): string {
	const input = value.trim();
	if (!input) return pathToFileURL(path.resolve(assetsDir, "newtab.html")).href;
	for (const page of INTERNAL_PAGES) {
		if (input === page || input === `${page}:` || input === `browser:${page}`) {
			return pathToFileURL(path.resolve(assetsDir, `${page === "search" ? "newtab" : page}.html`)).href;
		}
	}
	if (/[\u0000-\u0020\u007f]/.test(input) || input.includes("\\")) throw new Error("Invalid browser URL");
	const hostWithPort = /^[a-z\d.-]+:\d+(?:[/?#]|$)/i.test(input);
	const candidate = !hostWithPort && /^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`;
	const url = new URL(candidate);
	if (url.protocol === "file:" && isInternalUrl(url.href, assetsDir)) return url.href;
	if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
		throw new Error("Only HTTP(S) and internal browser pages are allowed");
	}
	return url.href;
}

export function isWebUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
	} catch {
		return false;
	}
}
