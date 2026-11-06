import { existsSync, readFileSync } from "node:fs";
import { isBuiltinModule } from "./builtin-modules.js";
import { writeJsonAtomicSync } from "./atomic-file.js";
import type { UiPluginCatalogEntry } from "./protocol.js";
import { normalizeIconSvg } from "./icon-svg.js";
import { pick, type ServerLang } from "./i18n.js";

const ID_RE = /^[A-Za-z0-9_-]+$/;

function isValidSource(source: string): boolean {
	if (!source || source.length > 300) return false;
	if (source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source)) return false;
	if (/^https?:\/\//.test(source)) return true;
	const spec = source.split("#")[0]!.replace(/\/+$/, "");
	const segs = spec.split("/").filter(Boolean);
	if (segs.length < 2) return false;
	for (const s of segs) if (s === "." || s === "..") return false;
	return true;
}

export { isValidSource };

export function deriveCatalogId(raw: string | undefined, source: string): string {
	if (raw && ID_RE.test(raw)) return raw;
	const spec = source.split("#")[0]!.replace(/\/+$/, "");
	const segs = spec.split("/").filter(Boolean);
	const last = segs.length >= 2 ? segs[segs.length - 1]! : (segs[0] ?? "plugin");
	const cleaned = last.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
	return cleaned || "plugin";
}

function readJsonSafe<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function atomicWrite(path: string, data: unknown): void {
	writeJsonAtomicSync(path, data);
}

function toEntry(
	raw: Record<string, unknown>,
	originOrBuiltin: "builtin" | "community" | "custom" | boolean,
): UiPluginCatalogEntry | null {
	const origin: "builtin" | "community" | "custom" =
		typeof originOrBuiltin === "boolean" ? (originOrBuiltin ? "builtin" : "custom") : originOrBuiltin;
	const builtin = origin === "builtin";
	const source = typeof raw.source === "string" ? raw.source.trim() : "";
	if (!isValidSource(source)) return null;
	const id = deriveCatalogId(typeof raw.id === "string" ? raw.id.trim() : undefined, source);
	if (!ID_RE.test(id) || isBuiltinModule(id.toLowerCase())) return null;
	const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
	const nameEn = typeof raw.nameEn === "string" && raw.nameEn.trim() ? raw.nameEn.trim() : undefined;
	const description =
		typeof raw.description === "string" && raw.description.trim() ? raw.description.trim() : undefined;
	const descriptionEn =
		typeof raw.descriptionEn === "string" && raw.descriptionEn.trim() ? raw.descriptionEn.trim() : undefined;
	const icon = typeof raw.icon === "string" && raw.icon.trim() ? raw.icon.trim() : undefined;
	const iconSvg = normalizeIconSvg(raw.iconSvg);
	const homepage = typeof raw.homepage === "string" && raw.homepage.trim() ? raw.homepage.trim() : undefined;
	return {
		id,
		name,
		source,
		builtin,
		origin,
		...(nameEn ? { nameEn } : {}),
		...(description ? { description } : {}),
		...(descriptionEn ? { descriptionEn } : {}),
		...(icon ? { icon } : {}),
		...(iconSvg ? { iconSvg } : {}),
		...(homepage ? { homepage } : {}),
	};
}

export function readCatalog(builtinPath: string, customPath: string, communityPath?: string): UiPluginCatalogEntry[] {
	const out: UiPluginCatalogEntry[] = [];
	const seenBuiltin = new Set<string>();
	const seen = new Set<string>();

	if (existsSync(builtinPath)) {
		const raw = readJsonSafe<unknown>(builtinPath, []);
		if (Array.isArray(raw)) {
			for (const it of raw) {
				const e = it && typeof it === "object" ? toEntry(it as Record<string, unknown>, "builtin") : null;
				if (e && !seen.has(e.id)) {
					seenBuiltin.add(e.id);
					seen.add(e.id);
					out.push(e);
				}
			}
		}
	}

	if (communityPath && existsSync(communityPath)) {
		const rawCommunity = readJsonSafe<unknown>(communityPath, []);
		const list = Array.isArray(rawCommunity)
			? rawCommunity
			: rawCommunity &&
				  typeof rawCommunity === "object" &&
				  Array.isArray((rawCommunity as { entries?: unknown[] }).entries)
				? (rawCommunity as { entries: unknown[] }).entries
				: [];
		for (const it of list) {
			const e = it && typeof it === "object" ? toEntry(it as Record<string, unknown>, "community") : null;
			if (!e) continue;
			if (seenBuiltin.has(e.id)) continue;
			const idx = out.findIndex((x) => x.id === e.id);
			if (idx >= 0) {
				out[idx] = e;
			} else {
				out.push(e);
			}
			seen.add(e.id);
		}
	}

	const rawCustom = readJsonSafe<{ entries?: unknown }>(customPath, {});
	const list =
		rawCustom && typeof rawCustom === "object" && Array.isArray((rawCustom as { entries?: unknown[] }).entries)
			? (rawCustom as { entries: unknown[] }).entries
			: [];
	for (const it of list) {
		const e = it && typeof it === "object" ? toEntry(it as Record<string, unknown>, "custom") : null;
		if (!e) continue;
		const idx = out.findIndex((x) => x.id === e.id);
		if (idx >= 0) {
			out[idx] = { ...e, builtin: false, origin: "custom", overridesBuiltin: seenBuiltin.has(e.id) };
		} else {
			out.push(e);
		}
		seen.add(e.id);
	}
	return out;
}

export interface CatalogAddInput {
	source: string;
	id?: string;
	name?: string;
	description?: string;
	icon?: string;
	iconSvg?: string;
}

export function addCustomEntry(
	customPath: string,
	input: CatalogAddInput,
	lang?: () => ServerLang,
): UiPluginCatalogEntry {
	const l = lang?.() ?? "en";
	const source = String(input?.source ?? "").trim();
	if (!isValidSource(source)) {
		throw new Error(
			pick(
				l,
				"来源需为 owner/repo 或 owner/repo/子目录（不支持本地路径）",
				"Source must be owner/repo or owner/repo/subdir (local paths are not supported)",
				"plugincatalog.source.invalid",
			),
		);
	}
	const id = deriveCatalogId(typeof input?.id === "string" ? input.id.trim() : undefined, source);
	if (!ID_RE.test(id))
		throw new Error(
			pick(
				l,
				`非法 id "${id}"（仅限字母数字-_）`,
				`Invalid id "${id}" (letters/digits/-/_ only)`,
				"plugincatalog.id.invalid",
				{ id },
			),
		);
	if (isBuiltinModule(id.toLowerCase()))
		throw new Error(
			pick(
				l,
				`内置模块 "${id}" 由宿主管理，不能添加为插件`,
				`Built-in module "${id}" is managed by the host and cannot be added as a plugin`,
			),
		);
	const raw = readJsonSafe<{ entries?: unknown[] }>(customPath, {});
	const entries = Array.isArray(raw.entries) ? (raw.entries as unknown[]) : [];
	const next = entries.filter((x) => !(x && typeof x === "object" && (x as Record<string, unknown>).id === id));
	next.push({
		id,
		source,
		...(typeof input?.name === "string" && input.name.trim() ? { name: input.name.trim() } : {}),
		...(typeof input?.description === "string" && input.description.trim()
			? { description: input.description.trim() }
			: {}),
		...(typeof input?.icon === "string" && input.icon.trim() ? { icon: input.icon.trim() } : {}),
		...(normalizeIconSvg(input?.iconSvg) ? { iconSvg: normalizeIconSvg(input?.iconSvg) } : {}),
	});
	atomicWrite(customPath, { entries: next });
	return toEntry(next[next.length - 1] as Record<string, unknown>, false)!;
}

export function removeCustomEntry(customPath: string, id: string): boolean {
	if (!ID_RE.test(id)) return false;
	const raw = readJsonSafe<{ entries?: unknown[] }>(customPath, {});
	if (!Array.isArray(raw.entries)) return false;
	const next = raw.entries.filter((x) => !(x && typeof x === "object" && (x as Record<string, unknown>).id === id));
	if (next.length === raw.entries.length) return false;
	atomicWrite(customPath, { entries: next });
	return true;
}

export interface CatalogSyncPayload {
	entries: UiPluginCatalogEntry[];
	skipped: number;
}

export function normalizeSyncPayload(raw: unknown, lang?: () => ServerLang): CatalogSyncPayload | { error: string } {
	const l = lang?.() ?? "en";
	const list = Array.isArray(raw)
		? raw
		: raw && typeof raw === "object" && Array.isArray((raw as { entries?: unknown }).entries)
			? (raw as { entries: unknown[] }).entries
			: null;
	if (!list)
		return {
			error: pick(
				l,
				'目录 JSON 需为数组，或 {"entries": [...]} 形状',
				'Catalog JSON must be an array or the {"entries": [...]} shape',
				"plugincatalog.sync.shape",
			),
		};
	const entries: UiPluginCatalogEntry[] = [];
	let skipped = 0;
	for (const it of list) {
		const e = it && typeof it === "object" ? toEntry(it as Record<string, unknown>, false) : null;
		if (e) entries.push(e);
		else skipped += 1;
	}
	return { entries, skipped };
}

export function writeCustomCatalog(customPath: string, incoming: UiPluginCatalogEntry[], replace: boolean): number {
	const byId = new Map<string, UiPluginCatalogEntry>();
	if (!replace) {
		const raw = readJsonSafe<{ entries?: unknown[] }>(customPath, {});
		const existing = Array.isArray(raw.entries) ? raw.entries : [];
		for (const it of existing) {
			const e = it && typeof it === "object" ? toEntry(it as Record<string, unknown>, false) : null;
			if (e) byId.set(e.id, e);
		}
	}
	for (const e of incoming) {
		if (!isBuiltinModule(e.id.toLowerCase())) byId.set(e.id, e);
	}
	const entries = [...byId.values()].map((e) => ({
		id: e.id,
		source: e.source,
		name: e.name,
		...(e.nameEn ? { nameEn: e.nameEn } : {}),
		...(e.description ? { description: e.description } : {}),
		...(e.descriptionEn ? { descriptionEn: e.descriptionEn } : {}),
		...(e.icon ? { icon: e.icon } : {}),
		...(e.iconSvg ? { iconSvg: e.iconSvg } : {}),
		...(e.homepage ? { homepage: e.homepage } : {}),
	}));
	atomicWrite(customPath, { entries });
	return entries.length;
}

export function writeCommunityCatalog(communityPath: string, incoming: UiPluginCatalogEntry[]): number {
	const entries = incoming
		.filter((e) => !isBuiltinModule(e.id.toLowerCase()))
		.map((e) => ({
			id: e.id,
			source: e.source,
			name: e.name,
			...(e.nameEn ? { nameEn: e.nameEn } : {}),
			...(e.description ? { description: e.description } : {}),
			...(e.descriptionEn ? { descriptionEn: e.descriptionEn } : {}),
			...(e.icon ? { icon: e.icon } : {}),
			...(e.iconSvg ? { iconSvg: e.iconSvg } : {}),
			...(e.homepage ? { homepage: e.homepage } : {}),
		}));
	atomicWrite(communityPath, { entries });
	return entries.length;
}
