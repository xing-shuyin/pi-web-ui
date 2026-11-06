import { execFile } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { pick, type ServerLang } from "./i18n.js";
import { sdkCopies, type SdkCopy } from "./sdk-origin.js";

const PI_CORE_PACKAGE = "@earendil-works/pi-coding-agent";

export const NPM_DEFAULT_REGISTRY = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 8_000;
const CONCURRENCY = 5;

export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < 3; i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x !== y) return x - y;
	}
	return 0;
}

export function parsePiVersionOutput(stdout: string): string | null {
	const exact = stdout.match(/^\s*v?(\d+\.\d+\.\d+(?:[-+][\w.]+)*)\s*$/m)?.[1];
	if (exact) return exact;
	return stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

export type UpdateItemKind = "webui" | "pi-core" | "package" | "git-extension" | "plugin" | "engine";

export interface UpdateItem {
	name: string;
	kind: UpdateItemKind;
	current: string;
	latest: string | null;
	latestPublishedAt?: string | null;
	upToDate: boolean;
	error?: string;
	source?: string;
	pluginId?: string;
	builtin?: boolean;
}

export interface LocalPackage {
	name: string;
	version: string;
	kind: UpdateItemKind;
	error?: string;
	source?: string;
	installDir?: string;
	ref?: string | null;
}

export function listInstalledPackages(agentDir: string): LocalPackage[] {
	const direct = readManifestDeps(agentDir);
	if (direct) return direct;
	return walkNodeModules(agentDir);
}

function readManifestDeps(agentDir: string): LocalPackage[] | null {
	let manifest: { dependencies?: Record<string, string> } | null;
	try {
		manifest = JSON.parse(readFileSync(join(agentDir, "npm", "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
		} | null;
		if (!manifest || typeof manifest !== "object") return null;
	} catch {
		return null;
	}
	const deps = manifest.dependencies;
	if (!deps || typeof deps !== "object" || Object.keys(deps).length === 0) {
		return null;
	}
	const root = join(agentDir, "npm", "node_modules");
	const out: LocalPackage[] = [];
	for (const name of Object.keys(deps)) {
		const item = readLocalPackage(join(root, ...name.split("/")));
		if (item) out.push(item);
	}
	return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function walkNodeModules(agentDir: string): LocalPackage[] {
	const root = join(agentDir, "npm", "node_modules");
	const out: LocalPackage[] = [];
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry.startsWith(".") || entry === ".bin") continue;
		if (entry.startsWith("@")) {
			let scoped: string[];
			try {
				scoped = readdirSync(join(root, entry));
			} catch {
				continue;
			}
			for (const name of scoped) {
				if (name.startsWith(".")) continue;
				const item = readLocalPackage(join(root, entry, name));
				if (item) out.push(item);
			}
		} else {
			const item = readLocalPackage(join(root, entry));
			if (item) out.push(item);
		}
	}
	return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function readLocalPackage(dir: string): LocalPackage | null {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
		if (!pkg.name || !pkg.version) return null;
		return { name: pkg.name, version: pkg.version, kind: "package" };
	} catch {
		return null;
	}
}

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;

export interface GitExtensionSource {
	host: string;
	path: string;
	ref: string | null;
	shorthand: string;
	identity: string;
}

function hasUnsafeGitPart(value: string, allowSlash: boolean): boolean {
	if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) return true;
	if (!allowSlash && value.includes("/")) return true;
	if (value.split("/").includes("..")) return true;
	return false;
}

function normalizeGitRepo(host: string, path: string, ref: string | null): GitExtensionSource | null {
	const cleanPath = path.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
	if (!host || !cleanPath || cleanPath.split("/").length < 2) return null;
	if (hasUnsafeGitPart(host, false) || hasUnsafeGitPart(cleanPath, true)) return null;
	if (ref !== null && (ref === "" || ref.includes("\0"))) return null;
	return {
		host,
		path: cleanPath,
		ref,
		shorthand: `${host}/${cleanPath}`,
		identity: `git:${host}/${cleanPath}`,
	};
}

function splitGitRef(rest: string): { path: string; ref: string | null } {
	const at = rest.indexOf("@");
	if (at < 0) return { path: rest, ref: null };
	return { path: rest.slice(0, at), ref: rest.slice(at + 1) || null };
}

export function parseGitExtensionSource(entry: string): GitExtensionSource | null {
	const trimmed = entry.trim();
	if (!trimmed || trimmed.startsWith("npm:")) return null;
	const url = trimmed.startsWith("git:") ? trimmed.slice(4).trim() : trimmed;
	if (!url) return null;
	const scp = url.match(/^git@([^:]+):(.+)$/);
	if (scp) {
		const { path, ref } = splitGitRef(scp[2]!);
		return normalizeGitRepo(scp[1]!, path, ref);
	}
	if (/^(https?|ssh|git):\/\//i.test(url)) {
		let host: string;
		let rest: string;
		try {
			const parsed = new URL(url);
			host = parsed.hostname;
			rest = parsed.pathname.replace(/^\/+/, "");
		} catch {
			return null;
		}
		const { path, ref } = splitGitRef(rest);
		return normalizeGitRepo(host, path, ref);
	}
	if (!trimmed.startsWith("git:")) return null;
	const slash = url.indexOf("/");
	if (slash < 0) return null;
	const host = url.slice(0, slash);
	if (!host.includes(".") && host !== "localhost") return null;
	const { path, ref } = splitGitRef(url.slice(slash + 1));
	return normalizeGitRepo(host, path, ref);
}

export function isGitExtensionCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = (env.PI_WEB_GIT_EXTENSION_CHECK ?? "").trim().toLowerCase();
	return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

type SettingsPackageEntry = string | { source?: unknown };

function readSettingsPackagesFile(file: string): SettingsPackageEntry[] {
	try {
		const data = JSON.parse(readFileSync(file, "utf8")) as { packages?: unknown };
		if (!data || typeof data !== "object" || !Array.isArray(data.packages)) return [];
		return data.packages.filter(
			(p): p is SettingsPackageEntry => typeof p === "string" || (p !== null && typeof p === "object"),
		);
	} catch {
		return [];
	}
}

function readGitCloneNameVersion(installDir: string): { name?: string; version?: string } {
	try {
		const pkg = JSON.parse(readFileSync(join(installDir, "package.json"), "utf8")) as {
			name?: string;
			version?: string;
		};
		return {
			...(typeof pkg.name === "string" && pkg.name ? { name: pkg.name } : {}),
			...(typeof pkg.version === "string" && pkg.version ? { version: pkg.version } : {}),
		};
	} catch {
		return {};
	}
}

/**
 * Enumerate `git:` entries from global (<agentDir>/settings.json) plus project
 * (<projectCwd>/.pi/settings.json) settings — the same two scopes pi core
 * updates. Project wins on identity collision (mirrors core dedupePackages).
 * Entries whose clone is missing are still listed (version `?`): checkAll
 * reports them as per-item errors instead of silently dropping the row.
 */
export function listGitExtensions(
	agentDir: string,
	projectCwd?: string,
	env: NodeJS.ProcessEnv = process.env,
): LocalPackage[] {
	if (!isGitExtensionCheckEnabled(env)) return [];
	const scopes: Array<{ file: string; gitRoot: string }> = [];
	if (projectCwd)
		scopes.push({ file: join(projectCwd, ".pi", "settings.json"), gitRoot: join(projectCwd, ".pi", "git") });
	scopes.push({ file: join(agentDir, "settings.json"), gitRoot: join(agentDir, "git") });
	const seen = new Set<string>();
	const out: LocalPackage[] = [];
	for (const { file, gitRoot } of scopes) {
		for (const pkg of readSettingsPackagesFile(file)) {
			const raw = typeof pkg === "string" ? pkg : typeof pkg.source === "string" ? pkg.source : null;
			if (!raw) continue;
			const parsed = parseGitExtensionSource(raw);
			if (!parsed || seen.has(parsed.identity)) continue;
			seen.add(parsed.identity);
			const installDir = join(gitRoot, parsed.host, ...parsed.path.split("/"));
			const nv = readGitCloneNameVersion(installDir);
			out.push({
				name: nv.name ?? parsed.shorthand,
				version: nv.version ?? "?",
				kind: "git-extension",
				source: parsed.shorthand,
				installDir,
				ref: parsed.ref,
			});
		}
	}
	return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function formatGitVersion(version: string, sha: string): string {
	const short = sha.slice(0, 7);
	return version && version !== "?" ? `${version} (${short})` : short;
}

async function runGit(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		timeout: GIT_TIMEOUT_MS,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	return stdout.trim();
}

export interface GitCheckResult {
	localSha: string;
	remoteSha: string;
}

export type GitCheckFn = (installDir: string, ref?: string | null) => Promise<GitCheckResult>;

export function buildLsRemotePatternsForRef(ref: string): string[] {
	if (ref.startsWith("refs/")) {
		return [ref, `${ref}^{}`];
	}
	return [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`, ref, `${ref}^{}`];
}

export function pickRemoteShaForRef(output: string, ref: string): string | null {
	const map = new Map<string, string>();
	for (const line of output.split(/\r?\n/)) {
		const match = line.trim().match(/^([0-9a-f]{40})\s+(\S+)$/i);
		if (match) {
			map.set(match[2], match[1]);
		}
	}
	if (map.has(`${ref}^{}`)) return map.get(`${ref}^{}`)!;
	if (map.has(ref)) return map.get(ref)!;

	const branchRef = `refs/heads/${ref}`;
	if (map.has(branchRef)) return map.get(branchRef)!;

	const peeledTagRef = `refs/tags/${ref}^{}`;
	if (map.has(peeledTagRef)) return map.get(peeledTagRef)!;
	const tagRef = `refs/tags/${ref}`;
	if (map.has(tagRef)) return map.get(tagRef)!;

	return null;
}

export async function defaultCheckGitExtension(installDir: string, ref?: string | null): Promise<GitCheckResult> {
	const localSha = await runGit(["rev-parse", "HEAD"], installDir);
	if (!/^[0-9a-f]{40}$/i.test(localSha)) throw new Error(`Bad local HEAD: ${localSha.slice(0, 20)}`);

	const targetRef = ref?.trim() || null;
	if (targetRef) {
		let remoteSha: string | null = null;
		let lsRemoteError: unknown = null;
		try {
			const patterns = buildLsRemotePatternsForRef(targetRef);
			const out = await runGit(["ls-remote", "origin", ...patterns], installDir);
			remoteSha = pickRemoteShaForRef(out, targetRef);
		} catch (err) {
			lsRemoteError = err;
		}

		if (!remoteSha && /^[0-9a-f]{7,40}$/i.test(targetRef)) {
			if (localSha.toLowerCase().startsWith(targetRef.toLowerCase())) {
				remoteSha = localSha;
			} else {
				try {
					const parsed = await runGit(["rev-parse", `${targetRef}^{commit}`], installDir);
					if (/^[0-9a-f]{40}$/i.test(parsed)) remoteSha = parsed;
				} catch {}
				if (!remoteSha) remoteSha = targetRef;
			}
		}

		if (!remoteSha) {
			if (lsRemoteError) throw lsRemoteError;
			throw new Error(`Failed to resolve remote ref: ${targetRef}`);
		}
		return { localSha, remoteSha };
	}

	let remoteSha: string | null = null;
	try {
		const upstream = await runGit(["rev-parse", "--abbrev-ref", "@{upstream}"], installDir);
		const branch = upstream.match(/^origin\/(.+)$/)?.[1];
		if (branch) {
			const out = await runGit(["ls-remote", "origin", `refs/heads/${branch}`], installDir);
			remoteSha = out.match(/^([0-9a-f]{40})\s+/m)?.[1] ?? null;
		}
	} catch {}
	if (!remoteSha) {
		const out = await runGit(["ls-remote", "origin", "HEAD"], installDir);
		remoteSha = out.match(/^([0-9a-f]{40})\s+HEAD$/m)?.[1] ?? null;
	}
	if (!remoteSha) throw new Error("Failed to determine remote HEAD");
	return { localSha, remoteSha };
}

const PI_PROBE_TTL_MS = 10_000;

let piCoreProbe: { at: number; version: string | null } | null = null;

function readPiCoreVersionAt(pkgPath: string): string | null {
	if (!existsSync(pkgPath)) return null;
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
		if (pkg.name === PI_CORE_PACKAGE && pkg.version) return pkg.version;
	} catch {}
	return null;
}

/**
 * <binDir>/node_modules/<pkg>/package.json — the concrete layout a global npm
 * install always uses. This is the FIRST candidate because it is the only one
 * that works on Windows: npm's cmd-shim writes a regular `pi` shell script
 * (not a symlink into the package), so the realpath walk below would start
 * from <prefix> itself and never see the package one level down (issue #533).
 */
function versionFromSiblingNodeModules(bin: string): string | null {
	return readPiCoreVersionAt(join(dirname(bin), "node_modules", ...PI_CORE_PACKAGE.split("/"), "package.json"));
}

function versionFromSymlinkWalk(bin: string): string | null {
	try {
		let dir = dirname(realpathSync(bin));
		for (let i = 0; i < 8; i++) {
			const version = readPiCoreVersionAt(join(dir, "package.json"));
			if (version) return version;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {}
	return null;
}

function versionFromCandidate(bin: string): string | null {
	const sib = versionFromSiblingNodeModules(bin);
	if (sib) return sib;

	const dir = dirname(bin);
	const parent = dirname(dir);
	if (dir.endsWith(".bin") || dir.endsWith(".bin\\") || dir.endsWith(".bin/")) {
		const parentNm = readPiCoreVersionAt(join(parent, ...PI_CORE_PACKAGE.split("/"), "package.json"));
		if (parentNm) return parentNm;
	}

	try {
		const head = readFileSync(bin, "utf8").slice(0, 4096);
		const m = head.match(/[^\r\n"']*@earendil-works[/\\]pi-coding-agent[^\r\n"']*/);
		if (m) {
			const matchedPath = m[0].trim().replace(/%~?dp0%?[/\\]/gi, "");
			const targetDir = isAbsolute(matchedPath) ? matchedPath : join(dir, matchedPath);
			let cur = targetDir;
			for (let i = 0; i < 5; i++) {
				const pj = join(cur, "package.json");
				const v = readPiCoreVersionAt(pj);
				if (v) return v;
				const p = dirname(cur);
				if (p === cur) break;
				cur = p;
			}
		}
	} catch {}

	const sym = versionFromSymlinkWalk(bin);
	if (sym) return sym;

	// 5. Global prefix layout: <binDir>/../lib/node_modules/<pkg> or <binDir>/../node_modules/<pkg>
	const libNm = readPiCoreVersionAt(join(parent, "lib", "node_modules", ...PI_CORE_PACKAGE.split("/"), "package.json"));
	if (libNm) return libNm;
	const upNm = readPiCoreVersionAt(join(parent, "node_modules", ...PI_CORE_PACKAGE.split("/"), "package.json"));
	if (upNm) return upNm;

	return null;
}

/**
 * Read the pi core version from disk: resolve the `pi` bin on PATH and check standard
 * global prefix directories, selecting the highest valid version found to avoid
 * local/ancestor node_modules shadowing an updated global installation.
 */
export function readPiCoreVersionFromDisk(env: NodeJS.ProcessEnv = process.env): string | null {
	let bestVersion: string | null = null;
	const updateBest = (v: string | null) => {
		if (!v) return;
		if (!bestVersion || compareVersions(v, bestVersion) > 0) {
			bestVersion = v;
		}
	};

	const rawPath = env.PATH ?? "";
	const dirs = rawPath.split(delimiter).filter(Boolean);
	const isWin = process.platform === "win32";
	const names = isWin ? ["pi.cmd", "pi.exe", "pi.ps1", "pi"] : ["pi"];

	for (const dir of dirs) {
		for (const name of names) {
			const candidate = join(dir, name);
			if (!existsSync(candidate)) continue;
			const version = versionFromCandidate(candidate);
			if (version) {
				updateBest(version);
				break;
			}
		}
	}

	if (bestVersion) return bestVersion;

	// Fallback to global prefix directories (npm global prefix, pnpm, etc.)
	const home = env.HOME || env.USERPROFILE || "";
	const prefix = env.npm_config_prefix || env.PREFIX;
	const prefixDirs: string[] = [];
	if (prefix) prefixDirs.push(prefix);
	if (home) prefixDirs.push(join(home, ".npm-global"));
	if (env.APPDATA) prefixDirs.push(join(env.APPDATA, "npm"));
	if (env.PNPM_HOME) prefixDirs.push(env.PNPM_HOME);
	if (env.LOCALAPPDATA) prefixDirs.push(join(env.LOCALAPPDATA, "pnpm", "global"));

	for (const p of prefixDirs) {
		const v1 = readPiCoreVersionAt(join(p, "node_modules", ...PI_CORE_PACKAGE.split("/"), "package.json"));
		if (v1) updateBest(v1);
		const v2 = readPiCoreVersionAt(join(p, "lib", "node_modules", ...PI_CORE_PACKAGE.split("/"), "package.json"));
		if (v2) updateBest(v2);
	}

	return bestVersion;
}

export function defaultProbePiCore(env: NodeJS.ProcessEnv = process.env): string | null {
	const now = Date.now();
	const cached = piCoreProbe;
	if (cached && now - cached.at < PI_PROBE_TTL_MS) return cached.version;
	const version = readPiCoreVersionFromDisk(env);
	piCoreProbe = { at: now, version };
	return version;
}

/**
 * issue #321 — detect "a newer pi is installed on this machine than the one
 * this process actually loaded". The panel's pi-core row probes the GLOBAL pi
 * CLI (what `npm i -g` updates), but the server loads its own bundled copy
 * (nested beats ancestor in Node resolution, issue #260) — so after upgrading
 * the global pi the panel reads "up to date" while conversations still run the
 * old SDK. That invisible split is exactly what #321 reports; this turns it
 * into data the UI can explain.
 *
 * Two detectors, unioned (newest wins): the CLI probe (standard global
 * install) and the ancestor-chain copies (fallback when the probe finds
 * nothing — different npm prefix, bun, …). Pure — tests inject both.
 * Returns null when nothing newer than `runningVersion` is found.
 */
export function detectPiSdkSplit(
	runningVersion: string,
	probePiCore: () => string | null = defaultProbePiCore,
	copies: SdkCopy[] = sdkCopies(),
): { running: string; installed: string } | null {
	let installed = probePiCore();
	for (const copy of copies) {
		if (
			compareVersions(copy.version, runningVersion) > 0 &&
			(!installed || compareVersions(copy.version, installed) > 0)
		) {
			installed = copy.version;
		}
	}
	if (!installed || compareVersions(installed, runningVersion) <= 0) return null;
	return { running: runningVersion, installed };
}

function readVendoredPiCore(agentDir: string): string | null {
	try {
		const pkg = JSON.parse(
			readFileSync(join(agentDir, "npm", "node_modules", ...PI_CORE_PACKAGE.split("/"), "package.json"), "utf8"),
		) as { name?: string; version?: string };
		if (pkg.name !== PI_CORE_PACKAGE || !pkg.version) return null;
		return pkg.version;
	} catch {
		return null;
	}
}

export function isHostProvidedPackage(name: string): boolean {
	return name === PI_CORE_PACKAGE || name.startsWith("@earendil-works/") || name.startsWith("@mariozechner/");
}

/**
 * Build the full local target list: webui + the pi core + installed packages
 * + git-source extensions (issue #178) from global and project settings.
 * The pi core version comes from the CLI probe (injectable for tests), falling
 * back to the vendored copy under <agentDir>/npm/node_modules. Packages
 * listing the core directly or host-provided SDK peers are filtered out so the
 * pi-core row wins and host peers are not listed as updatable (issue #393).
 */
export function collectTargets(
	agentDir: string,
	webuiVersion: string,
	probePiCore: () => string | null = defaultProbePiCore,
	opts?: { projectCwd?: string; extraTargets?: LocalPackage[] },
): LocalPackage[] {
	const targets: LocalPackage[] = [{ name: "pi-web-ui", version: webuiVersion, kind: "webui" }];
	const coreVersion = probePiCore() ?? readVendoredPiCore(agentDir);
	// (e.g. unreadable global install) instead of silently dropping it — an
	targets.push({
		name: PI_CORE_PACKAGE,
		version: coreVersion ?? "unknown",
		kind: "pi-core",
		...(coreVersion ? {} : { error: "pluginupdate.piCore.unknown" }),
	});
	if (opts?.extraTargets && opts.extraTargets.length > 0) {
		targets.push(...opts.extraTargets);
	}
	targets.push(...listInstalledPackages(agentDir).filter((pkg) => !isHostProvidedPackage(pkg.name)));
	targets.push(...listGitExtensions(agentDir, opts?.projectCwd));
	return targets;
}

export type Fetcher = (
	url: string,
	init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export const defaultFetcher: Fetcher = (url, init) => fetch(url, init) as unknown as ReturnType<Fetcher>;

export function parseNpmrcRegistry(text: string): string | null {
	let registry: string | null = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		const m = line.match(/^registry\s*=\s*(.+?)\s*$/i);
		if (!m) continue;
		let url = m[1]!
			.trim()
			.replace(/^["']|["']$/g, "")
			.trim();
		if (!url) continue;
		url = url.replace(/\/+$/, "");
		if (/^https?:\/\//i.test(url)) registry = url;
	}
	return registry;
}

export function parseNpmrcAuth(text: string, registry: string): string | null {
	let host: string;
	try {
		host = new URL(registry).host.toLowerCase();
	} catch {
		return null;
	}
	let token: string | null = null;
	let basic: string | null = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || line.startsWith(";") || !line.startsWith("//")) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim();
		const value = line
			.slice(eq + 1)
			.trim()
			.replace(/^["']|["']$/g, "")
			.trim();
		if (!value) continue;
		const keyHost = key.slice(2).split("/")[0]!.split(":")[0]!.toLowerCase();
		if (keyHost !== host) continue;
		if (/.:_authToken$/i.test(key)) token = value;
		else if (/.:_auth$/i.test(key)) basic = value;
	}
	if (token) return `Bearer ${token}`;
	if (basic) return `Basic ${basic}`;
	return null;
}

export interface NpmRegistryConfig {
	registry: string;
	authHeader: string | null;
}

export function resolveNpmRegistry(agentDir: string): NpmRegistryConfig {
	try {
		const text = readFileSync(join(agentDir, "npm", ".npmrc"), "utf8");
		const registry = parseNpmrcRegistry(text) ?? NPM_DEFAULT_REGISTRY;
		return { registry, authHeader: parseNpmrcAuth(text, registry) };
	} catch {
		return { registry: NPM_DEFAULT_REGISTRY, authHeader: null };
	}
}

interface RegistryDoc {
	"dist-tags"?: { latest?: string };
	time?: Record<string, string>;
}

export async function fetchLatest(
	fetcher: Fetcher,
	name: string,
	registry: string = NPM_DEFAULT_REGISTRY,
	authHeader: string | null = null,
): Promise<{ latest: string | null; latestPublishedAt: string | null }> {
	const res = await fetcher(`${registry}/${encodeURIComponent(name)}`, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		...(authHeader ? { headers: { authorization: authHeader } } : {}),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = (await res.json()) as RegistryDoc;
	const latest = data["dist-tags"]?.latest ?? null;
	return {
		latest,
		latestPublishedAt: latest && data.time ? (data.time[latest] ?? null) : null,
	};
}

export async function checkAll(
	targets: LocalPackage[],
	fetcher: Fetcher = defaultFetcher,
	lang?: () => ServerLang,
	registryConfig?: NpmRegistryConfig,
	gitCheck: GitCheckFn = defaultCheckGitExtension,
): Promise<UpdateItem[]> {
	const l = lang?.() ?? "en";
	const registry = registryConfig?.registry ?? NPM_DEFAULT_REGISTRY;
	const authHeader = registryConfig?.authHeader ?? null;
	const fail = (t: LocalPackage, errMessage: string): UpdateItem => ({
		name: t.name,
		kind: t.kind,
		current: t.version,
		latest: null,
		latestPublishedAt: null,
		upToDate: false,
		...(t.source ? { source: t.source } : {}),
		error: pick(
			l,
			`检查更新失败：${errMessage}`,
			`Failed to check for updates: ${errMessage}`,
			"updatecheck.check.failed",
			{
				errMessage,
			},
		),
	});
	const results: UpdateItem[] = Array.from({ length: targets.length }) as UpdateItem[];
	let cursor = 0;
	async function worker() {
		while (cursor < targets.length) {
			const i = cursor++;
			const t = targets[i]!;
			if (t.error) {
				results[i] = {
					name: t.name,
					kind: t.kind,
					current: t.version,
					latest: null,
					latestPublishedAt: null,
					upToDate: false,
					...(t.source ? { source: t.source } : {}),
					error: pick(
						l,
						"无法检测已安装的引擎版本（可能未装全局 pi，或安装方式不标准），可手动检查。",
						"Could not detect the installed engine version (no global pi, or a non-standard install); check manually.",
						t.error,
					),
				};
				continue;
			}
			if (t.kind === "git-extension") {
				try {
					if (!t.installDir) throw new Error("missing install dir");
					const { localSha, remoteSha } = await gitCheck(t.installDir, t.ref);
					const upToDate = localSha.trim().toLowerCase() === remoteSha.trim().toLowerCase();
					results[i] = {
						name: t.name,
						kind: t.kind,
						current: formatGitVersion(t.version, localSha),
						latest: formatGitVersion(t.version, remoteSha),
						latestPublishedAt: null,
						upToDate,
						...(t.source ? { source: t.source } : {}),
					};
				} catch (err) {
					results[i] = fail(t, (err as Error).message);
				}
				continue;
			}
			try {
				const { latest, latestPublishedAt } = await fetchLatest(fetcher, t.name, registry, authHeader);
				results[i] = {
					name: t.name,
					kind: t.kind,
					current: t.version,
					latest,
					latestPublishedAt,
					upToDate: latest === null || compareVersions(t.version, latest) >= 0,
				};
			} catch (err) {
				results[i] = fail(t, (err as Error).message);
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
	return results;
}

export function sortUpdateItems(items: UpdateItem[]): UpdateItem[] {
	const kindRank = (k: UpdateItemKind): number =>
		k === "webui" ? 0 : k === "pi-core" ? 1 : k === "engine" ? 2 : k === "plugin" ? 3 : 4;
	return [...items].sort((a, b) => {
		const ka = kindRank(a.kind);
		const kb = kindRank(b.kind);
		if (ka !== kb) return ka - kb;
		const ea = a.error ? 1 : 0;
		const eb = b.error ? 1 : 0;
		if (ea !== eb) return ea - eb;
		const sa = a.upToDate ? 1 : 0;
		const sb = b.upToDate ? 1 : 0;
		if (sa !== sb) return sa - sb;
		return 0;
	});
}
