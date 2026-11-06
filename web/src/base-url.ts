import { getMobileRuntime, isMobileServerUrl } from "./mobile-runtime";
import { withToken } from "./auth-token";

let cachedBase: string | null = null;

/** Capability root, including when the page is a nested resource or index.html. */
export function relayBase(pathname: string): string | null {
	return (
		pathname.match(/^\/device\/[^/]+\/__relay\/[^/]+\//)?.[0] ??
		pathname.match(/^\/(?:[A-Za-z0-9_-]+\/)*device-lan\/[^/]+\/__relay\/[^/]+\//)?.[0] ??
		null
	);
}

export function resolveBase(pathname?: string): string {
	if (pathname === undefined) {
		// The actual capability URL takes precedence over inherited/re-written base metadata.
		const location = (globalThis as unknown as { location?: { pathname?: string } }).location;
		const capability = location?.pathname && relayBase(location.pathname);
		if (capability) return capability;
		const doc = (
			globalThis as unknown as {
				document?: { baseURI?: string };
			}
		).document;
		if (doc && typeof doc.baseURI === "string" && doc.baseURI) {
			try {
				pathname = new URL(doc.baseURI).pathname;
			} catch {}
		}
		if (pathname === undefined) {
			const viteBase = (
				import.meta as unknown as {
					env?: { BASE_URL?: string };
				}
			).env?.BASE_URL;
			return viteBase || "/";
		}
	}
	const capability = relayBase(pathname);
	if (capability) return capability;
	if (!pathname || pathname === "/") return "/";
	let p = pathname.replace(/index\.html$/i, "");
	if (!p.endsWith("/")) p += "/";
	return p;
}

export function appBase(): string {
	if (cachedBase === null) cachedBase = resolveBase();
	return cachedBase;
}

export function withAppBase(path: string, base: string): string {
	return base === "/" ? path : base + path.replace(/^\/+/, "");
}

export function appUrl(path: string): string {
	const mobile = getMobileRuntime();
	return mobile ? new URL(path.replace(/^\/+/, ""), `${mobile.serverUrl}/`).href : withAppBase(path, appBase());
}

export function appResourceUrl(path: string): string {
	const url = appUrl(path);
	return getMobileRuntime() ? withToken(url) : url;
}

/** Native service resources need CORS mode so the browser sends the capability-bound Origin. */
export function appResourceCrossOrigin(url?: string): "anonymous" | undefined {
	return url && isMobileServerUrl(url) ? "anonymous" : undefined;
}

export function appWsUrl(path = "/ws"): string {
	const location = (globalThis as unknown as { location?: { href?: string; protocol: string; host: string } }).location;
	const url = new URL(appUrl(path), location?.href ?? (location && `${location.protocol}//${location.host}/`));
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.href;
}
