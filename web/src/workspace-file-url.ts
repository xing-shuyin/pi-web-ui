import { defaultUrlTransform } from "react-markdown";
import { appUrl } from "./base-url";
import { withToken } from "./auth-token";
import { getClientId } from "./use-chat";

export function isLoopbackAccess(
	host: string = typeof window !== "undefined" ? window.location.hostname : "",
): boolean {
	if (!host) return false;
	const h = host.toLowerCase().trim();
	if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "[::1]") return true;
	if (h.startsWith("127.")) return true;
	return false;
}

export function isExternalOrProtocolLink(target: string): boolean {
	if (!target) return true;
	const t = target.trim();
	if (!t || t.startsWith("#") || t.startsWith("?") || t.startsWith("//") || t.startsWith("pi-file://")) return true;
	if (/^[a-z]:[\\/]/i.test(t) || /^file:\/\//i.test(t)) return false;
	return /^[a-z][a-z\d+.-]*:/i.test(t);
}

export function markdownFileUrlTransform(url: string, key: string): string {
	if ((key === "href" || key === "src") && /^(?:[a-z]:[\\/]|file:\/\/|pi-file:\/\/)/i.test(url)) {
		return url;
	}
	return defaultUrlTransform(url);
}

export function normalizeTargetFilePath(raw: string, currentCwd?: string): string {
	let p = raw.trim();
	p = p.replace(/^file:\/\/(?:localhost(?=\/))?/i, "");
	try {
		p = decodeURIComponent(p);
	} catch {}
	p = p.replace(/\\/g, "/").replace(/^\/([a-z]:\/)/i, "$1");
	p = p.replace(/:\d+(?::\d+)?$/, "");

	if (currentCwd) {
		const normCwd = currentCwd.replace(/\\/g, "/").replace(/\/+$/, "");
		const windows = /^[a-z]:\//i.test(normCwd);
		if ((windows ? p.toLowerCase() : p).startsWith((windows ? normCwd.toLowerCase() : normCwd) + "/")) {
			p = p.slice(normCwd.length + 1);
		}
	}

	return p;
}

export function isHtmlDocumentPath(filePath: string): boolean {
	const lower = filePath.split("?")[0]?.split("#")[0]?.toLowerCase() ?? "";
	return lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".xhtml");
}

export function resolveWorkspaceFileUrl(filePath: string, currentCwd?: string): string {
	const clean = normalizeTargetFilePath(filePath, currentCwd);
	const cid = getClientId();

	if (isHtmlDocumentPath(clean)) {
		const isAbs = /^[A-Za-z]:\//.test(clean) || clean.startsWith("/");
		const segs = clean
			.split("/")
			.map((s) => encodeURIComponent(s))
			.join("/");
		const base = isAbs ? `/api/preview/__abs__/${segs}` : `/api/preview/${segs}`;
		return withToken(appUrl(`${base}?clientId=${encodeURIComponent(cid)}&allowJs=1`));
	}

	const qs = new URLSearchParams({
		clientId: cid,
		path: clean,
	});
	return withToken(appUrl(`/api/file?${qs}`));
}
