import type { UiPresetPluginDependency } from "./protocol.js";

const MAX_PLUGINS = 32;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export function portablePresetPluginSource(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 300) return undefined;
	const source = value.trim();
	if (!source || /[\s\\\x00-\x1f\x7f]/.test(source)) return undefined;
	let spec = source;
	if (source.startsWith("https://")) {
		try {
			const url = new URL(source);
			if (url.hostname !== "github.com" || url.username || url.password || url.port || url.search) return undefined;
			spec = url.pathname.slice(1) + url.hash;
		} catch {
			return undefined;
		}
	}
	const [path, ref, extra] = spec.split("#");
	if (extra !== undefined || !path || (ref !== undefined && !/^[A-Za-z0-9_./-]+$/.test(ref))) return undefined;
	const segments = path.split("/");
	if (segments.length < 2 || segments.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === ".."))
		return undefined;
	if (ref?.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
	return spec;
}

export function normalizePresetPlugins(input: unknown): UiPresetPluginDependency[] {
	if (!Array.isArray(input)) return [];
	const result: UiPresetPluginDependency[] = [];
	const seen = new Set<string>();
	for (const raw of input.slice(0, MAX_PLUGINS)) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const item = raw as Record<string, unknown>;
		if (typeof item.id !== "string" || !ID_RE.test(item.id) || seen.has(item.id)) continue;
		seen.add(item.id);
		const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
		const name = text(item.name, 100);
		const version = text(item.version, 60);
		const source = portablePresetPluginSource(item.source);
		result.push({
			id: item.id,
			...(name ? { name } : {}),
			...(version ? { version } : {}),
			...(source ? { source } : {}),
		});
	}
	return result;
}
