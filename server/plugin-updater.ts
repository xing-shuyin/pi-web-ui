import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { pick, type ServerLang } from "./i18n.js";
import { parseInstallSpec, manifestCandidateUrls } from "./plugin-install-spec.js";

const PLUGIN_ID_RE = /^[A-Za-z0-9_-]+$/;
export const BACKUP_KEEP = 3;

const here = dirname(fileURLToPath(import.meta.url));

export function resolveDefaultPkgRoot(): string | undefined {
	if (process.env.PI_WEB_PKG_ROOT && existsSync(process.env.PI_WEB_PKG_ROOT)) {
		return process.env.PI_WEB_PKG_ROOT;
	}
	const candidates = [resolve(here, ".."), resolve(here, "..", ".."), resolve(here, "..", "..", "..")];
	for (const c of candidates) {
		if (existsSync(join(c, "package.json"))) return c;
	}
	return undefined;
}

export type Exec = (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export const execGit: Exec = (cmd, args) =>
	new Promise((resolve) => {
		execFile(cmd, args, { timeout: 15_000, encoding: "utf8" }, (err, stdout, stderr) => {
			if (err) resolve({ ok: false, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
			else resolve({ ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});

export function ensureBackup(dataDir: string, id: string, opts?: { source?: string }): string | null {
	if (!PLUGIN_ID_RE.test(id)) return null;
	const target = join(dataDir, "plugins", id);
	if (!existsSync(target)) return null;
	const ts = stamp();
	const dest = join(dataDir, "plugin-backups", `${id}-${ts}`);
	try {
		mkdirSync(dirnameOf(dest)!, { recursive: true });
		cpSync(target, dest, {
			recursive: true,
			filter: (s) => !/(^|[\\/])(\.git|node_modules|whisper-cache)([\\/]|$)/.test(s),
		});
		writeFileSync(join(dest, ".pi-backup.json"), JSON.stringify({ id, ts, source: opts?.source }, null, 2) + "\n");
		pruneBackups(dataDir, id);
		return ts;
	} catch (err) {
		try {
			rmSync(dest, { recursive: true, force: true });
		} catch {}
		console.warn(`[plugin-updater] 备份 ${id} 失败：`, err instanceof Error ? err.message : err);
		return null;
	}
}

export function listBackups(dataDir: string, id: string): string[] {
	if (!PLUGIN_ID_RE.test(id)) return [];
	const dir = join(dataDir, "plugin-backups");
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const re = new RegExp(`^${id.replace(/[^A-Za-z0-9_-]/g, "")}-(\\d{8}-\\d{9})$`);
	return names
		.filter((n) => re.test(n) && existsSync(join(dir, n, ".pi-backup.json")))
		.sort()
		.reverse();
}

export function restoreBackup(dataDir: string, id: string): string | null {
	const backups = listBackups(dataDir, id);
	if (backups.length === 0) return null;
	const src = join(dataDir, "plugin-backups", backups[0]);
	const target = join(dataDir, "plugins", id);
	try {
		if (existsSync(target)) {
			const keepDirs = new Set(["node_modules", "whisper-cache"]);
			for (const entry of readdirSync(target)) {
				if (keepDirs.has(entry)) continue;
				rmSync(join(target, entry), { recursive: true, force: true });
			}
		}
		mkdirSync(target, { recursive: true });
		cpSync(src, target, { recursive: true });
		rmSync(src, { recursive: true, force: true });
		return backups[0];
	} catch (err) {
		console.warn(`[plugin-updater] 回滚 ${id} 失败：`, err instanceof Error ? err.message : err);
		return null;
	}
}

export function pruneBackups(dataDir: string, id: string, keep = BACKUP_KEEP): void {
	const backups = listBackups(dataDir, id);
	for (const b of backups.slice(keep)) {
		try {
			rmSync(join(dataDir, "plugin-backups", b), { recursive: true, force: true });
		} catch {}
	}
}

export async function resolveRemoteSha(spec: string, exec: Exec = execGit): Promise<string | null> {
	const clean = String(spec ?? "").trim();
	if (!clean) return null;
	let remote: string | null = null;
	if (existsSync(clean)) {
		remote = clean;
	} else if (/^file:\/\//i.test(clean)) {
		remote = clean.slice("file://".length);
	} else {
		let s = clean.replace(/^git@([^:]+):/, "");
		const m = s.match(/^https?:\/\/(?:www\.)?github\.com\/(.+?)(?:\.git)?\/?$/i);
		if (m) [, s] = m;
		s = s.split("#")[0];
		const segs = s.split("/").filter(Boolean);
		if (segs.length < 2) return null;
		const repo = segs[0] + "/" + segs[1].replace(/\.git$/, "");
		remote = `https://github.com/${repo}.git`;
	}
	if (!remote) return null;
	const res = await exec("git", ["ls-remote", remote, "HEAD"]);
	if (!res.ok) return null;
	const sha = res.stdout.match(/^([0-9a-f]{40,64})\s+HEAD/m)?.[1] ?? null;
	return sha ? sha.slice(0, 12) : null;
}

export interface PluginUpdateInfo {
	id: string;
	name?: string;
	version?: string;
	latestVersion?: string | null;
	source: string;
	localSha: string | null;
	remoteSha: string | null;
	updatable: boolean;
	builtin?: boolean;
	error?: string;
}

export type PluginManifestFetcher = (
	url: string,
	init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;

export interface CheckPluginUpdatesOptions {
	builtinCatalogPath?: string;
	pkgRoot?: string;
	fetcher?: PluginManifestFetcher;
}

export function compareVersions(a: string, b: string): number {
	const clean = (s: string) =>
		String(s ?? "")
			.trim()
			.replace(/^[vV]/, "")
			.split("+")[0]
			.trim();

	const cleanA = clean(a);
	const cleanB = clean(b);
	if (cleanA === cleanB) return 0;
	if (!cleanA && !cleanB) return 0;
	if (!cleanA) return -1;
	if (!cleanB) return 1;

	const dashA = cleanA.indexOf("-");
	const mainAStr = dashA >= 0 ? cleanA.slice(0, dashA) : cleanA;
	const preA = dashA >= 0 ? cleanA.slice(dashA + 1) : null;

	const dashB = cleanB.indexOf("-");
	const mainBStr = dashB >= 0 ? cleanB.slice(0, dashB) : cleanB;
	const preB = dashB >= 0 ? cleanB.slice(dashB + 1) : null;

	const segsA = mainAStr.split(".").map((n) => parseInt(n, 10) || 0);
	const segsB = mainBStr.split(".").map((n) => parseInt(n, 10) || 0);
	const maxLen = Math.max(segsA.length, segsB.length);

	for (let i = 0; i < maxLen; i++) {
		const x = segsA[i] ?? 0;
		const y = segsB[i] ?? 0;
		if (x !== y) return x - y;
	}

	if (preA === null && preB !== null) return 1;
	if (preA !== null && preB === null) return -1;
	if (preA !== null && preB !== null) {
		const partsA = preA.split(".");
		const partsB = preB.split(".");
		const maxPreLen = Math.max(partsA.length, partsB.length);
		for (let i = 0; i < maxPreLen; i++) {
			const pa = partsA[i];
			const pb = partsB[i];
			if (pa === undefined) return -1;
			if (pb === undefined) return 1;
			if (pa === pb) continue;
			const isNumA = /^\d+$/.test(pa);
			const isNumB = /^\d+$/.test(pb);
			if (isNumA && isNumB) {
				const diff = parseInt(pa, 10) - parseInt(pb, 10);
				if (diff !== 0) return diff;
			} else if (isNumA && !isNumB) {
				return -1;
			} else if (!isNumA && isNumB) {
				return 1;
			} else {
				return pa.localeCompare(pb);
			}
		}
	}

	return 0;
}

export function isBuiltinPlugin(id: string, source?: string, builtinCatalogPath?: string): boolean {
	if (source && /xing-shuyin\/pi-web-ui\/plugins\//i.test(source)) return true;
	const catPath =
		builtinCatalogPath ??
		(() => {
			const pkgRoot = resolveDefaultPkgRoot();
			return pkgRoot ? join(pkgRoot, "plugins", "catalog.json") : undefined;
		})();
	if (catPath && existsSync(catPath)) {
		try {
			const raw = JSON.parse(readFileSync(catPath, "utf8")) as unknown[];
			if (Array.isArray(raw)) {
				return raw.some((e) => (e as { id?: string })?.id === id);
			}
		} catch {}
	}
	return false;
}

async function fetchRemoteVersion(source: string, fetcher?: PluginManifestFetcher): Promise<string | null> {
	const spec = parseInstallSpec(source);
	if (spec.kind === "path" && spec.normalized) {
		const manifestFile = join(spec.normalized, "manifest.json");
		if (existsSync(manifestFile)) {
			try {
				const data = JSON.parse(readFileSync(manifestFile, "utf8")) as { version?: unknown };
				if (typeof data?.version === "string" && data.version.trim()) {
					return data.version.trim();
				}
			} catch {}
		}
	}
	const urls = manifestCandidateUrls(spec);
	if (urls.length === 0) return null;
	const fetchImpl = fetcher ?? (typeof fetch === "function" ? (fetch as unknown as PluginManifestFetcher) : null);
	if (!fetchImpl) return null;
	for (const url of urls) {
		try {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), 6000);
			const res = await fetchImpl(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
			if (!res.ok) continue;
			const data = (await res.json()) as { version?: unknown };
			if (typeof data?.version === "string" && data.version.trim()) {
				return data.version.trim();
			}
		} catch {}
	}
	return null;
}

export async function checkPluginUpdates(
	dataDir: string,
	exec: Exec = execGit,
	lang?: () => ServerLang,
	opts?: CheckPluginUpdatesOptions,
): Promise<PluginUpdateInfo[]> {
	const l = lang?.() ?? "en";
	const effectivePkgRoot = opts?.pkgRoot ?? resolveDefaultPkgRoot();
	const effectiveCatalogPath =
		opts?.builtinCatalogPath ?? (effectivePkgRoot ? join(effectivePkgRoot, "plugins", "catalog.json") : undefined);

	const pluginsDir = join(dataDir, "plugins");
	let names: string[] = [];
	try {
		names = readdirSync(pluginsDir).sort();
	} catch {
		return [];
	}
	const out: PluginUpdateInfo[] = [];
	for (const n of names) {
		if (!PLUGIN_ID_RE.test(n)) continue;
		const dir = join(pluginsDir, n);
		try {
			const sourceJson = readFileSync(join(dir, ".pi-source.json"), "utf8");
			const { source } = JSON.parse(sourceJson) as { source?: string };
			if (!source) continue;
			let localSha: string | null = null;
			try {
				localSha = readFileSync(join(dir, ".pi-git-sha"), "utf8").trim() || null;
			} catch {
				localSha = null;
			}
			let name: string | undefined;
			let version: string | undefined;
			try {
				const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
					name?: string;
					version?: string;
				};
				name = m.name;
				if (typeof m.version === "string" && m.version.trim()) {
					version = m.version.trim();
				}
			} catch {}

			const parsedSpec = parseInstallSpec(source);
			const isSubpath = Boolean(parsedSpec.subpath);
			const builtin = isBuiltinPlugin(n, source, effectiveCatalogPath);
			let latestVersion: string | null = null;

			if (effectivePkgRoot) {
				const localPkgManifest = join(effectivePkgRoot, "plugins", n, "manifest.json");
				if (existsSync(localPkgManifest)) {
					try {
						const rawPkg = JSON.parse(readFileSync(localPkgManifest, "utf8")) as { version?: string };
						if (typeof rawPkg?.version === "string" && rawPkg.version.trim()) {
							latestVersion = rawPkg.version.trim();
						}
					} catch {}
				}
			}

			try {
				const remoteVer = await fetchRemoteVersion(source, opts?.fetcher);
				if (remoteVer) {
					if (!latestVersion || compareVersions(remoteVer, latestVersion) > 0) {
						latestVersion = remoteVer;
					}
				}
			} catch {}

			let remoteSha: string | null = null;
			let error: string | undefined;
			try {
				remoteSha = await resolveRemoteSha(source, exec);
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
				remoteSha = null;
			}

			let updatable = false;
			if (latestVersion && version) {
				updatable = compareVersions(latestVersion, version) > 0;
			} else if (latestVersion && !version) {
				updatable = true;
			} else if (!isSubpath && remoteSha) {
				updatable = !localSha || localSha !== remoteSha;
			}

			if (!updatable && !latestVersion && !remoteSha && !error) {
				error = pick(
					l,
					"无法检查（非 git 源或 git 不可用）",
					"Cannot check (non-git source or git unavailable)",
					"pluginupdate.cannot.check",
				);
			} else if (!updatable && isSubpath && !latestVersion && !error) {
				error = pick(
					l,
					"无法检查（未能获取远端插件清单）",
					"Cannot check (failed to fetch remote plugin manifest)",
					"pluginupdate.subpath.manifest.failed",
				);
			}

			out.push({
				id: n,
				name,
				version,
				latestVersion,
				source,
				localSha,
				remoteSha,
				updatable,
				builtin,
				error,
			});
		} catch {
			continue;
		}
	}
	return out;
}

function stamp(): string {
	const d = new Date();
	const p = (x: number, n = 2) => String(x).padStart(n, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

function dirnameOf(p: string): string | null {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i >= 0 ? p.slice(0, i) : null;
}
