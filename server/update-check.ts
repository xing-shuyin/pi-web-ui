/**
 * All-source update check: pi-web-ui itself, the installed pi core
 * (@earendil-works/pi-coding-agent — probed via `pi --version`, with a
 * vendored-copy fallback), the DIRECT pi extensions declared in
 * <agentDir>/npm/package.json (fallback: raw node_modules walk), plus the
 * git-source extensions declared in global/project settings.json (issue #178).
 * Pure logic lives here so it can be unit-tested with an injected fetcher
 * (and an injected pi-core probe); ClientSession only wires it to the wire
 * protocol.
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { pick, type ServerLang } from "./i18n.js";
import { sdkCopies, type SdkCopy } from "./sdk-origin.js";

const PI_CORE_PACKAGE = "@earendil-works/pi-coding-agent";

/** npm 官方源；用户在 <agentDir>/npm/.npmrc 里配了镜像/私有源时会被覆盖（issue #151）。 */
export const NPM_DEFAULT_REGISTRY = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 8_000;
/** Parallel registry lookups per batch. */
const CONCURRENCY = 5;

/** Simple numeric semver compare: >0 means a newer than b. */
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

/**
 * Parse `pi --version` stdout into a version string, or null. Two-stage:
 * prefer a line that is exactly the version (optional leading "v", optional
 * prerelease/build suffix) so a stdout preamble like "Update available:
 * 0.85.0" cannot forge it; otherwise fall back to the first loose
 * semver-looking token. The exact-line match keeps the FULL version incl.
 * prerelease (0.85.0-beta.1 stays 0.85.0-beta.1).
 */
export function parsePiVersionOutput(stdout: string): string | null {
	const exact = stdout.match(/^\s*v?(\d+\.\d+\.\d+(?:[-+][\w.]+)*)\s*$/m)?.[1];
	if (exact) return exact;
	return stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

export type UpdateItemKind = "webui" | "pi-core" | "package" | "git-extension" | "plugin";

export interface UpdateItem {
	name: string;
	kind: UpdateItemKind;
	current: string;
	latest: string | null;
	latestPublishedAt?: string | null;
	upToDate: boolean;
	error?: string;
	/** git-extension only: `host/path` shorthand (prepend `git:` for the `pi update` command). */
	source?: string;
	/** plugin only: directory/install id, matches pluginId. */
	pluginId?: string;
	/** plugin only: whether this is a shipped built-in plugin. */
	builtin?: boolean;
}

export interface LocalPackage {
	name: string;
	version: string;
	kind: UpdateItemKind;
	/** Pre-flagged target (issue #533): an i18n key the caller cannot localize
	 *  yet, resolved by checkAll into the item's `error`. Currently set only for
	 *  a pi-core whose installed version could not be read. */
	error?: string;
	/** git-extension only: `host/path` shorthand (prepend `git:` for the `pi update` command). */
	source?: string;
	/** git-extension only: clone dir (<agentDir>/git/… or <projectCwd>/.pi/git/…). */
	installDir?: string;
	/** git-extension only: configured ref (`@…` suffix), if any. */
	ref?: string | null;
}

/**
 * Enumerate installed pi packages for the "check all updates" list, matching
 * what the TUI shows: the DIRECT dependencies declared in
 * <agentDir>/npm/package.json, with each installed version resolved from
 * node_modules/<name>/package.json (not the manifest range). Transitive deps
 * are not listed.
 *
 * Fallback: when the manifest is missing/unreadable or declares no
 * dependencies, fall back to the historical raw node_modules walk.
 */
export function listInstalledPackages(agentDir: string): LocalPackage[] {
	const direct = readManifestDeps(agentDir);
	if (direct) return direct;
	return walkNodeModules(agentDir);
}

/** Direct deps from the npm manifest with installed versions, or null. */
function readManifestDeps(agentDir: string): LocalPackage[] | null {
	let manifest: { dependencies?: Record<string, string> } | null;
	try {
		manifest = JSON.parse(readFileSync(join(agentDir, "npm", "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
		} | null;
		// Literal `null` parses fine but explodes on property access — treat as
		// unreadable (fallback to the raw walk), per the documented contract.
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
		// Broken/uninstalled entries are skipped (the registry never sees them).
		if (item) out.push(item);
	}
	// Deterministic order (manifest key order is arbitrary).
	return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Legacy fallback: raw walk of <agentDir>/npm/node_modules — top-level plain
 * names plus one level inside @scope dirs. Skips .bin, dotfiles and anything
 * without a readable package.json.
 */
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
	// Deterministic order (readdir order is FS-dependent).
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

// -- git-source extensions (issue #178) --------------------------------------
// The panel historically enumerated only npm direct deps, so `git:` entries in
// settings.json never appeared. pi core updates both (`updateConfiguredSources`
// buckets npmCandidates/gitCandidates), keyed by normalized `git:host/path`.

const execFileAsync = promisify(execFile);
/** Matches pi core NETWORK_TIMEOUT_MS so slow forges degrade the same way. */
const GIT_TIMEOUT_MS = 10_000;

export interface GitExtensionSource {
	host: string;
	/** Normalized owner/repo (no .git suffix, no ref). */
	path: string;
	/** Configured ref (`@…` suffix), if any. Pinned refs are still checked:
	 * core treats them as checkout targets to reconcile (package-manager
	 * `updateConfiguredSources` comment), so a moved ref shows as an update. */
	ref: string | null;
	/** `host/path` — prepend `git:` for the `pi update` argument (issue #178 step 6). */
	shorthand: string;
	/** `git:host/path` — global/project dedupe key (mirrors core identity). */
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

/** Split `rest` (the part after the host) on the first `@` into path + ref. */
function splitGitRef(rest: string): { path: string; ref: string | null } {
	const at = rest.indexOf("@");
	if (at < 0) return { path: rest, ref: null };
	return { path: rest.slice(0, at), ref: rest.slice(at + 1) || null };
}

/**
 * Parse a settings `packages` entry into a git source, or null when it is not
 * one. Accepts the same shapes pi core does (`parseGitUrl`): `git:`-prefixed
 * shorthand/URLs plus bare explicit protocol URLs. `npm:`/local entries yield
 * null — they are handled by the npm enumeration, not here.
 */
export function parseGitExtensionSource(entry: string): GitExtensionSource | null {
	const trimmed = entry.trim();
	if (!trimmed || trimmed.startsWith("npm:")) return null;
	const url = trimmed.startsWith("git:") ? trimmed.slice(4).trim() : trimmed;
	if (!url) return null;
	// scp-like: git@host:owner/repo[.git][@ref]
	const scp = url.match(/^git@([^:]+):(.+)$/);
	if (scp) {
		const { path, ref } = splitGitRef(scp[2]!);
		return normalizeGitRepo(scp[1]!, path, ref);
	}
	// Explicit protocol URLs (bare or git:-prefixed).
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
	// Shorthand only with an explicit git: prefix (bare `a/b` is a local path).
	if (!trimmed.startsWith("git:")) return null;
	const slash = url.indexOf("/");
	if (slash < 0) return null;
	const host = url.slice(0, slash);
	if (!host.includes(".") && host !== "localhost") return null;
	const { path, ref } = splitGitRef(url.slice(slash + 1));
	return normalizeGitRepo(host, path, ref);
}

/**
 * Total switch for the git-source check (issue #178 step 8). `0/false/no/off`
 * disables it (large-monorepo escape hatch); unset or anything else enables.
 */
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
		// Name and version fall back independently: a clone with a version but
		// no usable name still reports its version (name falls back to the
		// source shorthand at the call site), and vice versa.
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

/** Display form for git rows: `<version> (<short sha>)`, sha-only when the
 * clone has no readable package.json version (issue #178 step 5). */
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

export type GitCheckFn = (installDir: string) => Promise<GitCheckResult>;

/**
 * Compare a clone's HEAD against its remote (lightweight: `ls-remote` fetches
 * refs only, no objects). Upstream branch wins when configured, else origin
 * HEAD — the same order pi core `getRemoteGitHead` uses.
 */
export async function defaultCheckGitExtension(installDir: string): Promise<GitCheckResult> {
	const localSha = await runGit(["rev-parse", "HEAD"], installDir);
	if (!/^[0-9a-f]{40}$/i.test(localSha)) throw new Error(`Bad local HEAD: ${localSha.slice(0, 20)}`);
	let remoteSha: string | null = null;
	try {
		const upstream = await runGit(["rev-parse", "--abbrev-ref", "@{upstream}"], installDir);
		const branch = upstream.match(/^origin\/(.+)$/)?.[1];
		if (branch) {
			const out = await runGit(["ls-remote", "origin", `refs/heads/${branch}`], installDir);
			remoteSha = out.match(/^([0-9a-f]{40})\s+/m)?.[1] ?? null;
		}
	} catch {
		/* no usable upstream — fall through to origin HEAD */
	}
	if (!remoteSha) {
		const out = await runGit(["ls-remote", "origin", "HEAD"], installDir);
		remoteSha = out.match(/^([0-9a-f]{40})\s+HEAD$/m)?.[1] ?? null;
	}
	if (!remoteSha) throw new Error("Failed to determine remote HEAD");
	return { localSha, remoteSha };
}

/** How long a pi probe result stays hot (mirrors ClientSession.piCliProbe). */
const PI_PROBE_TTL_MS = 10_000;

let piCoreProbe: { at: number; version: string | null } | null = null;

/** Read a pi-core package.json's version, or null when absent, not ours, or
 *  unreadable. Shared by all resolution strategies below. */
function readPiCoreVersionAt(pkgPath: string): string | null {
	if (!existsSync(pkgPath)) return null;
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
		if (pkg.name === PI_CORE_PACKAGE && pkg.version) return pkg.version;
	} catch {
		/* unreadable package.json */
	}
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

/**
 * POSIX: `pi` is a symlink into <prefix>/node_modules/<pkg>/dist/bundle/cli.js
 * — realpath it and walk up (≤8 levels) until a package.json names our
 * package. Functionally unchanged from the original probe.
 */
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
	} catch {
		/* ignore */
	}
	return null;
}

/**
 * Attempt to resolve the installed @earendil-works/pi-coding-agent package version
 * from a candidate `pi` executable/script path.
 */
function versionFromCandidate(bin: string): string | null {
	// 1. Sibling layout: <binDir>/node_modules/<pkg>/package.json
	const sib = versionFromSiblingNodeModules(bin);
	if (sib) return sib;

	// 2. .bin layout: if bin is inside a `.bin` folder, check sibling of `.bin` (which is node_modules)
	const dir = dirname(bin);
	const parent = dirname(dir);
	if (dir.endsWith(".bin") || dir.endsWith(".bin\\") || dir.endsWith(".bin/")) {
		const parentNm = readPiCoreVersionAt(join(parent, ...PI_CORE_PACKAGE.split("/"), "package.json"));
		if (parentNm) return parentNm;
	}

	// 3. Wrapper script content inspection (Windows .cmd / .ps1 or shell wrapper)
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
	} catch {
		/* ignore */
	}

	// 4. POSIX symlink walk
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
 * Read the pi core version from disk: resolve the `pi` bin on PATH (traversing all
 * matches until a valid version is found), then falling back to standard global
 * prefix directories.
 */
export function readPiCoreVersionFromDisk(env: NodeJS.ProcessEnv = process.env): string | null {
	const rawPath = env.PATH ?? "";
	const dirs = rawPath.split(delimiter).filter(Boolean);
	const isWin = process.platform === "win32";
	const names = isWin ? ["pi.cmd", "pi.exe", "pi.ps1", "pi"] : ["pi"];

	for (const dir of dirs) {
		for (const name of names) {
			const candidate = join(dir, name);
			if (!existsSync(candidate)) continue;
			const version = versionFromCandidate(candidate);
			if (version) return version;
		}
	}

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
		if (v1) return v1;
		const v2 = readPiCoreVersionAt(join(p, "lib", "node_modules", ...PI_CORE_PACKAGE.split("/"), "package.json"));
		if (v2) return v2;
	}

	return null;
}

/**
 * Default pi core probe: run the globally installed `pi --version`, memoized
 * machine-wide for PI_PROBE_TTL_MS so repeated collectTargets calls never
 * re-probe. Reads the version from disk (pi bin → realpath → package.json)
 * instead of spawning `pi --version`. FORK-FREE by design — see the note on
 * defaultProbePiCore.
 */
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

/**
 * Fallback when the CLI probe yields nothing: the version of the vendored pi
 * core copy in <agentDir>/npm/node_modules, or null if that is absent too.
 */
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

/**
 * 宿主 SDK 及其 peer/内部包（@earendil-works/* / @mariozechner/*）：
 * 属于宿主引擎随核心一同分发或由别名提供的 SDK 内部构件，非用户安装的独立扩展组件；
 * 既不应在组件列表重复展示，也不能被 `pi update npm:<name>` 更新（会报 No matching package found，issue #393）。
 */
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
	opts?: { projectCwd?: string },
): LocalPackage[] {
	const targets: LocalPackage[] = [{ name: "pi-web-ui", version: webuiVersion, kind: "webui" }];
	const coreVersion = probePiCore() ?? readVendoredPiCore(agentDir);
	// issue #533: keep the pi-core row even when the version is undetectable
	// (e.g. unreadable global install) instead of silently dropping it — an
	// honest "could not detect" row beats a missing one. checkAll resolves the
	// key into the item's localized `error`.
	targets.push({
		name: PI_CORE_PACKAGE,
		version: coreVersion ?? "unknown",
		kind: "pi-core",
		...(coreVersion ? {} : { error: "pluginupdate.piCore.unknown" }),
	});
	targets.push(...listInstalledPackages(agentDir).filter((pkg) => !isHostProvidedPackage(pkg.name)));
	targets.push(...listGitExtensions(agentDir, opts?.projectCwd));
	return targets;
}

export type Fetcher = (
	url: string,
	init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Default fetcher (real network). Tests inject a fake. */
export const defaultFetcher: Fetcher = (url, init) => fetch(url, init) as unknown as ReturnType<Fetcher>;

/**
 * 解析 .npmrc 文本里的全局 registry（`registry=<url>`，后出现的覆盖先出现的）。
 * 找不到返回 null（调用方回落 NPM_DEFAULT_REGISTRY）。引号与行尾 `/` 会被清理。
 */
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

/**
 * 从 .npmrc 文本里找出与 registry 同源的认证头（`//host/path:_authToken=` 优先，
 * 其次 `//host/path:_auth=`）。私有源检查更新时没有它会直接 401（issue #151）。
 */
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
		// key 形如 //registry.example.com/:_authToken —— 取 // 与 : 之间的 host 比对
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
	/** Authorization 头（私有源 .npmrc 里配了 token 时才有）。 */
	authHeader: string | null;
}

/**
 * 读取 <agentDir>/npm/.npmrc（`pi update --extensions` 经 npm 自动遵守的同一份），
 * 解析出检查更新该用的 registry + 认证头。文件不存在/不可读/无 registry 行时
 * 回落官方源（issue #151：镜像/私有源用户不再被卡在官方源上）。
 */
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

/**
 * Look up one package's latest version + publish time in the npm registry.
 * registry/authHeader 默认官方源；镜像/私有源用户经 resolveNpmRegistry 传入
 * <agentDir>/npm/.npmrc 的配置（issue #151）。
 */
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

/**
 * Check every target: npm kinds against the registry, git-extension kinds
 * against their clone's remote (`ls-remote`, refs only). One failed lookup
 * degrades to an error item (upToDate: false) without failing the rest.
 * Results keep the input order. Bounded concurrency (CONCURRENCY) keeps
 * registry/remote load polite. The git checker is injectable for tests.
 */
export async function checkAll(
	targets: LocalPackage[],
	fetcher: Fetcher = defaultFetcher,
	/** 单项查询失败时的 error 文案语言（默认英文）。 */
	lang?: () => ServerLang,
	/** 镜像/私有源配置（默认官方源；调用方经 resolveNpmRegistry 传入 .npmrc，issue #151）。 */
	registryConfig?: NpmRegistryConfig,
	/** git 源远端比较（默认真 git；单测注入 fake，issue #178）。 */
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
				// Pre-flagged target (issue #533, e.g. undetectable pi-core
				// version): `error` carries an i18n key resolved here so
				// collectTargets stays language-free. No registry lookup.
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
					const { localSha, remoteSha } = await gitCheck(t.installDir);
					const upToDate = localSha.trim() === remoteSha.trim();
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

/** Display order for the Component Updates panel: pi-web-ui and pi-core
 *  pinned at the top regardless of state, then out-of-date packages, then
 *  up-to-date ones, errors last. Stable within each bucket (Array.sort is
 *  stable) so registry order survives ties. */
export function sortUpdateItems(items: UpdateItem[]): UpdateItem[] {
	const kindRank = (k: UpdateItemKind): number => (k === "webui" ? 0 : k === "pi-core" ? 1 : k === "plugin" ? 2 : 3);
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
