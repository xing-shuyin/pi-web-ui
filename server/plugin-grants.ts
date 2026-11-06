import { readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";

const ID_RE = /^[A-Za-z0-9_-]+$/;

export interface PluginGrantsFile {
	grants: Record<string, string[]>;
}

function stripTrailingSep(p: string): string {
	let out = p;
	for (;;) {
		if (out.length <= 1) return out;
		const last = out[out.length - 1];
		if (last !== "/" && last !== "\\") return out;
		const trimmed = out.slice(0, -1);
		if (/^[A-Za-z]:$/.test(trimmed)) return out;
		out = trimmed;
	}
}

function pathKey(p: string): string {
	const s = stripTrailingSep(p);
	return process.platform === "win32" ? s.toLowerCase() : s;
}

export function normalizeGrantPath(p: string): string | null {
	if (typeof p !== "string") return null;
	const raw = p.trim();
	if (!raw || raw.includes("\0")) return null;
	if (!isAbsolute(raw)) return null;
	let abs: string;
	try {
		abs = resolve(raw);
	} catch {
		return null;
	}
	if (!isAbsolute(abs)) return null;
	return stripTrailingSep(abs);
}

function isSameOrInside(targetKey: string, ancestorKey: string): boolean {
	if (targetKey === ancestorKey) return true;
	const prefix = ancestorKey.endsWith(sep) ? ancestorKey : ancestorKey + sep;
	return targetKey.startsWith(prefix);
}

function atomicWriteJson(filePath: string, data: unknown): void {
	writeJsonAtomicSync(filePath, data);
}

function readGrantsFile(filePath: string): Record<string, string[]> {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(filePath, "utf8"));
	} catch {
		return {};
	}
	const grants = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as PluginGrantsFile).grants : undefined;
	if (!grants || typeof grants !== "object" || Array.isArray(grants)) return {};
	const out: Record<string, string[]> = {};
	for (const [id, paths] of Object.entries(grants as Record<string, unknown>)) {
		if (!ID_RE.test(id) || !Array.isArray(paths)) continue;
		const seen = new Set<string>();
		const list: string[] = [];
		for (const p of paths) {
			if (typeof p !== "string") continue;
			const norm = normalizeGrantPath(p);
			if (!norm) continue;
			const key = pathKey(norm);
			if (seen.has(key)) continue;
			seen.add(key);
			list.push(norm);
		}
		if (list.length > 0) out[id] = list;
	}
	return out;
}

export class PluginGrantsStore {
	private cache: Record<string, string[]> | null = null;

	constructor(private dataDir: string) {}

	get filePath(): string {
		return resolve(this.dataDir, "plugin-grants.json");
	}

	private load(): Record<string, string[]> {
		if (!this.cache) this.cache = readGrantsFile(this.filePath);
		return this.cache;
	}

	private save(): void {
		try {
			atomicWriteJson(this.filePath, { grants: this.load() } satisfies PluginGrantsFile);
		} catch {}
	}

	list(): { pluginId: string; paths: string[] }[] {
		const all = this.load();
		return Object.keys(all)
			.sort()
			.map((pluginId) => ({ pluginId, paths: [...all[pluginId]!] }));
	}

	get(pluginId: string): string[] {
		if (!ID_RE.test(pluginId)) return [];
		return [...(this.load()[pluginId] ?? [])];
	}

	has(pluginId: string, dir: string): boolean {
		if (!ID_RE.test(pluginId)) return false;
		const target = normalizeGrantPath(dir);
		if (!target) return false;
		const list = this.load()[pluginId];
		if (!list || list.length === 0) return false;
		const targetKey = pathKey(target);
		for (const granted of list) {
			if (isSameOrInside(targetKey, pathKey(granted))) return true;
		}
		return false;
	}

	grant(pluginId: string, dir: string): boolean {
		if (!ID_RE.test(pluginId)) return false;
		const norm = normalizeGrantPath(dir);
		if (!norm) return false;
		const all = this.load();
		const list = all[pluginId] ?? [];
		const key = pathKey(norm);
		if (list.some((p) => pathKey(p) === key)) return false;
		all[pluginId] = [...list, norm];
		this.save();
		return true;
	}

	revoke(pluginId?: string, dir?: string): number {
		const all = this.load();
		if (pluginId === undefined) {
			if (dir !== undefined) return 0;
			let total = 0;
			for (const list of Object.values(all)) total += list.length;
			if (total === 0) return 0;
			for (const id of Object.keys(all)) delete all[id];
			this.save();
			return total;
		}
		if (!ID_RE.test(pluginId)) return 0;
		const list = all[pluginId];
		if (!list || list.length === 0) return 0;
		if (dir === undefined) {
			delete all[pluginId];
			this.save();
			return list.length;
		}
		const norm = normalizeGrantPath(dir);
		if (!norm) return 0;
		const key = pathKey(norm);
		const next = list.filter((p) => pathKey(p) !== key);
		const removed = list.length - next.length;
		if (removed === 0) return 0;
		if (next.length > 0) all[pluginId] = next;
		else delete all[pluginId];
		this.save();
		return removed;
	}

	reload(): void {
		this.cache = null;
	}
}
