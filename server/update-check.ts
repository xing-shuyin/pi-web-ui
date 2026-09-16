/**
 * All-source update check: pi-web-ui itself, the installed pi core
 * (@earendil-works/pi-coding-agent — probed via `pi --version`, with a
 * vendored-copy fallback), plus the DIRECT pi extensions declared in
 * <agentDir>/npm/package.json (fallback: raw node_modules walk).
 * Pure logic lives here so it can be unit-tested with an injected fetcher
 * (and an injected pi-core probe); ClientSession only wires it to the wire
 * protocol.
 */
import { readdirSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pick, type ServerLang } from "./i18n.js";

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
 * Cache a zero-arg function's value for ttlMs. Plain value memoization: the
 * pi probe returns null on failure instead of throwing, so errors thread
 * through as ordinary values and there is nothing to rethrow.
 */
export function memoizeWithTtl<T>(fn: () => T, ttlMs: number): () => T {
	let entry: { at: number; value: T } | null = null;
	return () => {
		const now = Date.now();
		if (!entry || now - entry.at >= ttlMs) {
			entry = { at: now, value: fn() };
		}
		return entry.value;
	};
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

export type UpdateItemKind = "webui" | "pi-core" | "package";

export interface UpdateItem {
	name: string;
	kind: UpdateItemKind;
	current: string;
	latest: string | null;
	latestPublishedAt?: string | null;
	upToDate: boolean;
	error?: string;
}

export interface LocalPackage {
	name: string;
	version: string;
	kind: UpdateItemKind;
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

/** How long a pi probe result stays hot (mirrors ClientSession.piCliProbe). */
const PI_PROBE_TTL_MS = 10_000;

let piCoreProbe: { at: number; version: string | null } | null = null;

/** Locate the pi CLI on PATH without spawning anything. */
function piCliOnPath(): string | null {
	const dirs = (process.env.PATH ?? "").split(delimiter);
	for (const dir of dirs) {
		if (!dir) continue;
		const candidate = join(dir, "pi");
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Read the pi core version from disk: resolve the `pi` bin (typically a
 * symlink into <global>/node_modules/<pkg>/dist/bundle/cli.js) and walk up to
 * its package.json. FORK-FREE by design — see the note on defaultProbePiCore.
 */
function readPiCoreVersionFromDisk(): string | null {
	const bin = piCliOnPath();
	if (!bin) return null;
	try {
		let dir = dirname(realpathSync(bin));
		for (let i = 0; i < 8; i++) {
			const pkgPath = join(dir, "package.json");
			if (existsSync(pkgPath)) {
				try {
					const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
					if (pkg.name === PI_CORE_PACKAGE && pkg.version) return pkg.version;
				} catch {
					/* unreadable package.json — keep walking */
				}
			}
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
 * Default pi core probe: run the globally installed `pi --version`, memoized
 * machine-wide for PI_PROBE_TTL_MS so repeated collectTargets calls never
 * re-probe. Reads the version from disk (pi bin → realpath → package.json)
 * instead of spawning `pi --version`. FORK-FREE by design — see the note on
 * defaultProbePiCore.
 */
export function defaultProbePiCore(): string | null {
	const now = Date.now();
	const cached = piCoreProbe;
	if (cached && now - cached.at < PI_PROBE_TTL_MS) return cached.version;
	const version = readPiCoreVersionFromDisk();
	piCoreProbe = { at: now, version };
	return version;
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
 * Build the full local target list: webui + the pi core + installed packages.
 * The pi core version comes from the CLI probe (injectable for tests), falling
 * back to the vendored copy under <agentDir>/npm/node_modules. Packages
 * listing the core directly are filtered out so the pi-core row wins — never
 * two rows for the same package.
 */
export function collectTargets(
	agentDir: string,
	webuiVersion: string,
	probePiCore: () => string | null = defaultProbePiCore,
): LocalPackage[] {
	const targets: LocalPackage[] = [{ name: "pi-web-ui", version: webuiVersion, kind: "webui" }];
	const coreVersion = probePiCore() ?? readVendoredPiCore(agentDir);
	if (coreVersion) {
		targets.push({
			name: PI_CORE_PACKAGE,
			version: coreVersion,
			kind: "pi-core",
		});
	}
	targets.push(...listInstalledPackages(agentDir).filter((pkg) => pkg.name !== PI_CORE_PACKAGE));
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
 * Check every target against the registry. One failed lookup degrades to an
 * error item (upToDate: false) without failing the rest. Results keep the
 * input order. Bounded concurrency (CONCURRENCY) keeps registry load polite.
 */
export async function checkAll(
	targets: LocalPackage[],
	fetcher: Fetcher = defaultFetcher,
	/** 单项 registry 查询失败时的 error 文案语言（默认英文）。 */
	lang?: () => ServerLang,
	/** 镜像/私有源配置（默认官方源；调用方经 resolveNpmRegistry 传入 .npmrc，issue #151）。 */
	registryConfig?: NpmRegistryConfig,
): Promise<UpdateItem[]> {
	const l = lang?.() ?? "en";
	const registry = registryConfig?.registry ?? NPM_DEFAULT_REGISTRY;
	const authHeader = registryConfig?.authHeader ?? null;
	const results: UpdateItem[] = Array.from({ length: targets.length }) as UpdateItem[];
	let cursor = 0;
	async function worker() {
		while (cursor < targets.length) {
			const i = cursor++;
			const t = targets[i]!;
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
				const errMessage = (err as Error).message;
				results[i] = {
					name: t.name,
					kind: t.kind,
					current: t.version,
					latest: null,
					latestPublishedAt: null,
					upToDate: false,
					error: pick(
						l,
						`检查更新失败：${errMessage}`,
						`Failed to check for updates: ${errMessage}`,
						"updatecheck.check.failed",
						{ errMessage },
					),
				};
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
	const kindRank = (k: UpdateItemKind): number => (k === "webui" ? 0 : k === "pi-core" ? 1 : 2);
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
