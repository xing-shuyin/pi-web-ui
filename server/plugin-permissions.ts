import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";

export type PermissionFamily = "net" | "llm";

export interface PermissionGrant {
	pluginId: string;
	family: PermissionFamily;
	hosts?: string[];
	models?: string[];
	reason?: string;
	grantedAt: number;
}

interface PermissionFile {
	v: number;
	grants: PermissionGrant[];
}

export function permissionHostMatches(hostname: string, entry: string): boolean {
	const h = String(hostname ?? "").toLowerCase();
	const e = String(entry ?? "")
		.toLowerCase()
		.trim();
	if (!h || !e) return false;
	return h === e || h.endsWith(`.${e}`);
}

function normalizeHosts(hosts: unknown): string[] | undefined {
	if (!Array.isArray(hosts)) return undefined;
	const out = [
		...new Set(
			hosts.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().toLowerCase()),
		),
	];
	return out.length > 0 ? out.slice(0, 32) : undefined;
}

function normalizeModels(models: unknown): string[] | undefined {
	if (!Array.isArray(models)) return undefined;
	const out = [
		...new Set(models.filter((x): x is string => typeof x === "string" && x.includes("/")).map((x) => x.trim())),
	];
	return out.length > 0 ? out.slice(0, 32) : undefined;
}

export class PluginPermissionStore {
	private sessionGrants: PermissionGrant[] = [];

	constructor(private readonly dataDir: string) {}

	private file(): string {
		return join(this.dataDir, "plugin-permissions.json");
	}

	private read(): PermissionFile {
		try {
			const parsed = JSON.parse(readFileSync(this.file(), "utf8")) as PermissionFile;
			if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.grants)) return { v: 1, grants: [] };
			return { v: 1, grants: parsed.grants };
		} catch {
			return { v: 1, grants: [] };
		}
	}

	private write(grants: PermissionGrant[]): void {
		try {
			writeJsonAtomicSync(this.file(), { v: 1, grants });
		} catch (err) {
			console.error(`[plugin-permissions] persist failed (${this.file()}):`, err);
		}
	}

	private static validId(id: string): boolean {
		return /^[A-Za-z0-9_-]+$/.test(id);
	}

	has(pluginId: string, family: PermissionFamily, scope?: { host?: string; model?: string }): boolean {
		if (!PluginPermissionStore.validId(pluginId)) return false;
		const all = [...this.read().grants, ...this.sessionGrants];
		return all.some((g) => {
			if (g.pluginId !== pluginId || g.family !== family) return false;
			if (family === "net") {
				const host = String(scope?.host ?? "").toLowerCase();
				if (!host || !g.hosts) return false;
				return g.hosts.some((entry) => permissionHostMatches(host, entry));
			}
			if (family === "llm" && scope?.model) {
				if (!g.models || g.models.length === 0) return true;
				return g.models.includes(scope.model);
			}
			return true;
		});
	}

	grant(
		pluginId: string,
		family: PermissionFamily,
		opts?: { hosts?: unknown; models?: unknown; reason?: string; remember?: boolean },
	): void {
		if (!PluginPermissionStore.validId(pluginId)) throw new Error(`非法插件 id：${pluginId}`);
		if (family !== "net" && family !== "llm") throw new Error(`不支持的能力族：${String(family)}`);
		const grant: PermissionGrant = {
			pluginId,
			family,
			...(family === "net" && normalizeHosts(opts?.hosts) ? { hosts: normalizeHosts(opts?.hosts) } : {}),
			...(family === "llm" && normalizeModels(opts?.models) ? { models: normalizeModels(opts?.models) } : {}),
			...(typeof opts?.reason === "string" && opts.reason.trim() ? { reason: opts.reason.trim().slice(0, 200) } : {}),
			grantedAt: Date.now(),
		};
		if (opts?.remember === true) {
			const grants = this.read().grants.filter(
				(g) => !(g.pluginId === pluginId && g.family === family && sameScope(g, grant)),
			);
			grants.push(grant);
			this.write(grants);
		} else {
			this.sessionGrants = this.sessionGrants.filter(
				(g) => !(g.pluginId === pluginId && g.family === family && sameScope(g, grant)),
			);
			this.sessionGrants.push(grant);
		}
	}

	revoke(pluginId?: string, family?: PermissionFamily, scope?: { host?: string; model?: string }): number {
		let removed = 0;
		const drop = (g: PermissionGrant): boolean => {
			if (pluginId && g.pluginId !== pluginId) return false;
			if (family && g.family !== family) return false;
			if (scope?.host && !(g.hosts ?? []).some((entry) => permissionHostMatches(scope.host!, entry))) return false;
			if (scope?.model && g.models && g.models.length > 0 && !g.models.includes(scope.model)) return false;
			return true;
		};
		const disk = this.read().grants;
		const kept = disk.filter((g) => !drop(g));
		if (kept.length !== disk.length) {
			removed += disk.length - kept.length;
			this.write(kept);
		}
		const before = this.sessionGrants.length;
		this.sessionGrants = this.sessionGrants.filter((g) => !drop(g));
		removed += before - this.sessionGrants.length;
		return removed;
	}

	modelAllowed(pluginId: string, model?: string): boolean {
		if (!PluginPermissionStore.validId(pluginId)) return false;
		const scoped = [...this.read().grants, ...this.sessionGrants].filter(
			(g) => g.pluginId === pluginId && g.family === "llm",
		);
		if (scoped.length === 0) return true;
		if (!model) return true;
		return scoped.some((g) => !g.models || g.models.length === 0 || g.models.includes(model));
	}

	list(): Array<PermissionGrant & { session?: boolean }> {
		return [
			...this.read().grants.map((g) => ({ ...g })),
			...this.sessionGrants.map((g) => ({ ...g, session: true as const })),
		];
	}
}

function sameScope(a: PermissionGrant, b: PermissionGrant): boolean {
	const ah = [...(a.hosts ?? [])].sort().join(",");
	const bh = [...(b.hosts ?? [])].sort().join(",");
	const am = [...(a.models ?? [])].sort().join(",");
	const bm = [...(b.models ?? [])].sort().join(",");
	return ah === bh && am === bm;
}
