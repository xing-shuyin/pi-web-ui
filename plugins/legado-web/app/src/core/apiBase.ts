function envOf(name: string): string {
	const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
	return String(env[name] ?? "").trim();
}

function baseFromLocation(): string {
	if (typeof location === "undefined") return "";
	const m = /^(.*)\/plugins\/([^/]+)\/client\//.exec(location.pathname);
	if (m) return `${m[1]}/plugins-api/${m[2]}`;
	return "";
}

export function apiBase(): string {
	const explicit = envOf("VITE_API_BASE") || envOf("VITE_PROXY_URL");
	if (explicit) return explicit.replace(/\/$/, "");
	return baseFromLocation();
}
