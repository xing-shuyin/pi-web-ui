import { promises as fs } from "node:fs";
import path from "node:path";

export const CONFIG_DIR = ".pi";
export const BASE_FILE = "sftp.json";
export const LOCAL_FILE = "sftp.local.json";
export const TRASH_DIR = "sftp-trash";

const DELETE_POLICIES = new Set(["none", "remote-only", "both"]);
const COMPARE_MODES = new Set(["mtime+size", "size", "always"]);
const CONFLICT_MODES = new Set(["newer", "local", "remote", "skip"]);
const DIRECTIONS = new Set(["up", "down", "both"]);
const AUTH_METHODS = new Set(["password", "key", "agent", "secret"]);
const SYMLINK_MODES = new Set(["skip", "follow"]);

export const DEFAULT_IGNORE = [
	".git",
	"node_modules",
	".pi",
	".sftp-trash",
	"*.log",
	"*.tmp",
	".vscode/sftp.json",
	"**/.vscode/sftp.json",
];

export function configPaths(cwd) {
	const dir = path.join(cwd, CONFIG_DIR);
	return {
		dir,
		base: path.join(dir, BASE_FILE),
		local: path.join(dir, LOCAL_FILE),
		trash: path.join(dir, TRASH_DIR),
	};
}

export function relLabel(cwd, abs) {
	return path.relative(cwd, abs).split(path.sep).join("/");
}

export function safeRel(rel) {
	const raw = String(rel ?? "")
		.replace(/\\/g, "/")
		.trim();
	const out = [];
	for (const seg of raw.split("/")) {
		if (!seg || seg === ".") continue;
		if (seg === "..") {
			if (!out.length) return null;
			out.pop();
			continue;
		}
		out.push(seg);
	}
	return out.join("/");
}

export function posixJoin(base, rel) {
	const b = String(base ?? "/").replace(/\/+$/, "");
	const r = String(rel ?? "").replace(/^\/+/, "");
	return r ? `${b}/${r}` : b || "/";
}

export function posixDir(p) {
	const s = String(p ?? "");
	const i = s.lastIndexOf("/");
	return i <= 0 ? "/" : s.slice(0, i);
}

function asStringArray(v) {
	if (!Array.isArray(v)) return [];
	return [...new Set(v.map((x) => String(x ?? "").trim()).filter(Boolean))];
}

export function normalizeRemotePath(v) {
	const raw = String(v ?? "").trim();
	const trimmed = raw.replace(/\/+$/, "");
	if (trimmed) return trimmed;
	return raw.startsWith("/") ? "/" : "";
}

function clampInt(v, min, max, fallback) {
	const n = Math.round(Number(v));
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

function isPlainObject(v) {
	return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, over) {
	if (!isPlainObject(base)) return isPlainObject(over) ? { ...over } : over;
	const out = { ...base };
	for (const [k, v] of Object.entries(over ?? {})) {
		out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
	}
	return out;
}

async function readJson(file) {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch (err) {
		if (err?.code === "ENOENT") return null;
		throw new Error(`${path.basename(file)} 不是合法 JSON：${err?.message ?? err}`);
	}
}

export async function writeJsonAtomic(file, value) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	await fs.writeFile(tmp, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
	await fs.rename(tmp, file);
}

export function normalizeConnection(name, raw, defaults = {}, warnings = []) {
	const c = isPlainObject(raw) ? raw : {};
	const warn = (msg) => warnings.push(`${name}: ${msg}`);

	const authRaw = isPlainObject(c.auth) ? c.auth : {};
	const password = String(authRaw.password ?? c.password ?? "");
	const privateKeyPath = String(authRaw.privateKeyPath ?? c.privateKeyPath ?? "").trim();
	const privateKey = String(authRaw.privateKey ?? c.privateKey ?? "");
	const passphrase = String(authRaw.passphrase ?? c.passphrase ?? "");
	const agent = String(authRaw.agent ?? c.agent ?? "").trim();

	let method = String(authRaw.method ?? "").trim();
	if (method && !AUTH_METHODS.has(method)) {
		warn(`auth.method「${method}」不认识，按内容自动判定`);
		method = "";
	}
	if (!method) {
		if (password && String(password).startsWith("${secret:")) method = "secret";
		else method = password ? "password" : agent ? "agent" : "key";
	}
	if (method === "secret" && !password) warn("选了加密机密但没配机密");
	if (method === "password" && !password) warn("选了密码登录但没配密码");

	const useGlobal = String(c.useGlobal ?? "").trim();
	const host = String(c.host ?? "").trim();
	if (!host && !useGlobal) warn("缺 host（主机地址）");

	const remotePath = normalizeRemotePath(c.remotePath ?? c.remoteRoot);
	if (host && !remotePath.startsWith("/")) warn("remotePath 必须是绝对路径（以 / 开头）");
	const allowRootRemote = Boolean(c.allowRootRemote);

	const syncRaw = isPlainObject(c.sync) ? c.sync : {};
	let direction = String(syncRaw.direction ?? defaults.direction ?? "up");
	if (!DIRECTIONS.has(direction)) direction = "up";
	let del = String(syncRaw.delete ?? defaults.delete ?? "none");
	if (!DELETE_POLICIES.has(del)) del = "none";
	let compare = String(syncRaw.compare ?? defaults.compare ?? "mtime+size");
	if (!COMPARE_MODES.has(compare)) compare = "mtime+size";
	let conflict = String(syncRaw.conflict ?? defaults.conflict ?? "newer");
	if (!CONFLICT_MODES.has(conflict)) conflict = "newer";
	if (del !== "none" && remotePath === "/" && !allowRootRemote) {
		warn("远端根是 / 且开了删除——已强制降级为 delete:none（要真删请设 allowRootRemote: true）");
		del = "none";
	}

	const mappings = (Array.isArray(c.mappings) ? c.mappings : [])
		.map((m) => {
			if (!isPlainObject(m)) return null;
			const local = safeRel(m.local ?? "");
			const remote = String(m.remote ?? "").trim();
			if (local === null || local === "" || !remote.startsWith("/")) return null;
			return { local, remote: remote.replace(/\/+$/, "") || "/" };
		})
		.filter(Boolean);

	const roots = mappings.length
		? mappings.map((m) => ({ local: m.local, remote: m.remote }))
		: [{ local: "", remote: remotePath || "/" }];

	const ignore = [...new Set([...(defaults.ignore ?? []), ...asStringArray(c.ignore ?? c.exclude)])];

	return {
		name,
		host,
		port: clampInt(c.port ?? defaults.port ?? 22, 1, 65535, 22),
		username: String(c.username ?? defaults.username ?? "root").trim() || "root",
		remotePath: remotePath || "/",
		allowRootRemote,
		auth: { method, password, passphrase, privateKey, privateKeyPath, agent },
		sync: {
			direction,
			delete: del,
			compare,
			conflict,
			concurrency: clampInt(syncRaw.concurrency ?? defaults.concurrency ?? 4, 1, 16, 4),
			symlinks: SYMLINK_MODES.has(String(syncRaw.symlinks)) ? String(syncRaw.symlinks) : "skip",
		},
		mappings,
		roots,
		ignore,
		useGlobal: useGlobal || undefined,
		ready: Boolean((host || useGlobal) && remotePath.startsWith("/")),
	};
}

export function normalizeDoc(raw) {
	const doc = isPlainObject(raw) ? raw : {};
	const warnings = [];
	const d = isPlainObject(doc.defaults) ? doc.defaults : {};
	const defaults = {
		ignore: [...new Set([...DEFAULT_IGNORE, ...asStringArray(d.ignore)])],
		concurrency: clampInt(d.concurrency ?? 4, 1, 16, 4),
		delete: DELETE_POLICIES.has(String(d.delete)) ? String(d.delete) : "none",
		compare: COMPARE_MODES.has(String(d.compare)) ? String(d.compare) : "mtime+size",
		conflict: CONFLICT_MODES.has(String(d.conflict)) ? String(d.conflict) : "newer",
		direction: DIRECTIONS.has(String(d.direction)) ? String(d.direction) : "up",
		port: clampInt(d.port ?? 22, 1, 65535, 22),
		username: String(d.username ?? "root"),
	};

	const connsRaw = isPlainObject(doc.connections) ? doc.connections : {};
	const connections = {};
	for (const [name, c] of Object.entries(connsRaw)) {
		if (!/^[\w.-]{1,48}$/.test(name)) {
			warnings.push(`连接名「${name}」含非法字符（只允许字母数字点横线下划线），已跳过`);
			continue;
		}
		connections[name] = normalizeConnection(name, c, defaults, warnings);
	}

	const active = String(doc.active ?? "").trim();
	if (active && !connections[active]) warnings.push(`active 指向的连接「${active}」不存在`);

	return {
		version: 1,
		active: active || Object.keys(connections)[0] || "",
		defaults,
		connections,
		warnings,
	};
}

export async function readConfig(cwd) {
	const files = configPaths(cwd);
	const [base, local] = await Promise.all([readJson(files.base), readJson(files.local)]);
	const merged = deepMerge(base ?? {}, local ?? {});
	return {
		base: base ?? null,
		local: local ?? null,
		raw: merged,
		doc: normalizeDoc(merged),
		files,
		existed: Boolean(base || local),
	};
}

export function pickConnection(doc, profile) {
	const name = String(profile ?? "").trim() || doc.active;
	return { name, conn: name ? doc.connections[name] : undefined };
}

export async function writeBase(cwd, obj) {
	const files = configPaths(cwd);
	await writeJsonAtomic(files.base, obj);
	return files.base;
}

export async function writeLocal(cwd, obj) {
	const files = configPaths(cwd);
	await writeJsonAtomic(files.local, obj);
	return files.local;
}

/**
 * 新增/更新一个连接。
 * @param {string} cwd
 * @param {string} name 连接名
 * @param {object} patch 只写要改的字段（`null` 表示清除该凭据）
 * @param {{ target?: "base"|"local", makeActive?: boolean, credentialToLocal?: boolean }} opts
 */
export async function upsertConnection(cwd, name, patch, opts = {}) {
	const clean = String(name ?? "").trim();
	if (!/^[\w.-]{1,48}$/.test(clean)) throw new Error("连接名只允许字母、数字、点、横线、下划线（1-48 字符）");
	const { base, local } = await readConfig(cwd);
	const target = opts.target === "local" ? "local" : "base";
	const file = target === "local" ? (local ?? {}) : (base ?? {});
	const conns = isPlainObject(file.connections) ? { ...file.connections } : {};
	const prev = isPlainObject(conns[clean]) ? conns[clean] : {};

	const next = { ...prev };
	const put = (k, v) => {
		if (v === undefined) return;
		if (v === null) delete next[k];
		else next[k] = v;
	};

	put("host", patch.host === undefined ? undefined : String(patch.host).trim());
	put("port", patch.port === undefined ? undefined : Number(patch.port) || 22);
	put("username", patch.username === undefined ? undefined : String(patch.username).trim());
	put("remotePath", patch.remotePath === undefined ? undefined : normalizeRemotePath(patch.remotePath));
	put("allowRootRemote", patch.allowRootRemote === undefined ? undefined : Boolean(patch.allowRootRemote));
	if (patch.ignore !== undefined) put("ignore", asStringArray(patch.ignore));
	if (patch.mappings !== undefined) {
		put(
			"mappings",
			(Array.isArray(patch.mappings) ? patch.mappings : [])
				.map((m) => ({ local: safeRel(m?.local ?? "") ?? "", remote: String(m?.remote ?? "").trim() }))
				.filter((m) => m.local && m.remote.startsWith("/")),
		);
	}

	const authKeys = ["method", "password", "passphrase", "privateKey", "privateKeyPath", "agent"];
	const authPatch = isPlainObject(patch.auth) ? { ...patch.auth } : {};
	for (const k of authKeys) {
		if (patch[k] !== undefined) authPatch[k] = patch[k];
	}
	const touchedAuth = Object.keys(authPatch).some((k) => authKeys.includes(k));
	if (touchedAuth) {
		const auth = isPlainObject(prev.auth) ? { ...prev.auth } : {};
		for (const k of authKeys) {
			if (authPatch[k] === undefined) continue;
			if (authPatch[k] === null) delete auth[k];
			else auth[k] = String(authPatch[k]);
		}
		if (Object.keys(auth).length) next.auth = auth;
		else delete next.auth;
		for (const k of ["password", "passphrase", "privateKey", "privateKeyPath", "agent"]) delete next[k];
	}

	if (patch.sync !== undefined && isPlainObject(patch.sync)) {
		const sync = isPlainObject(prev.sync) ? { ...prev.sync } : {};
		for (const [k, v] of Object.entries(patch.sync)) {
			if (v === undefined) continue;
			if (v === null) delete sync[k];
			else sync[k] = v;
		}
		if (Object.keys(sync).length) next.sync = sync;
		else delete next.sync;
	}

	conns[clean] = next;
	file.connections = conns;
	if (file.version === undefined) file.version = 1;
	if (opts.makeActive !== false && !file.active) file.active = clean;
	if (opts.makeActive === true) file.active = clean;

	await (target === "local" ? writeLocal(cwd, file) : writeBase(cwd, file));
	return { name: clean, target };
}

export async function removeConnection(cwd, name) {
	const clean = String(name ?? "").trim();
	const { base, local } = await readConfig(cwd);
	const touched = [];
	for (const [kind, file] of [
		["base", base],
		["local", local],
	]) {
		if (!isPlainObject(file?.connections) || !(clean in file.connections)) continue;
		delete file.connections[clean];
		if (file.active === clean) delete file.active;
		await (kind === "base" ? writeBase(cwd, file) : writeLocal(cwd, file));
		touched.push(kind);
	}
	return { name: clean, removedFrom: touched };
}

export async function setActive(cwd, name) {
	const clean = String(name ?? "").trim();
	const { base, doc } = await readConfig(cwd);
	if (clean && !doc.connections[clean]) throw new Error(`没有名为「${clean}」的连接`);
	const file = base ?? { version: 1, connections: {} };
	if (clean) file.active = clean;
	else delete file.active;
	await writeBase(cwd, file);
	return { active: clean };
}

export async function ensureGitignore(cwd) {
	const gitDir = path.join(cwd, ".git");
	try {
		await fs.access(gitDir);
	} catch {
		return { changed: false, reason: "not-a-git-repo" };
	}
	const file = path.join(cwd, ".gitignore");
	let text = "";
	try {
		text = await fs.readFile(file, "utf8");
	} catch (err) {
		if (err?.code !== "ENOENT") throw err;
	}
	const lines = text.split(/\r?\n/).map((l) => l.trim());
	const wanted = `${CONFIG_DIR}/${LOCAL_FILE}`;
	const covered = lines.some(
		(l) =>
			l === wanted ||
			l === LOCAL_FILE ||
			l === `${CONFIG_DIR}/` ||
			l === CONFIG_DIR ||
			l === `/${wanted}` ||
			l === `/${CONFIG_DIR}/` ||
			l === `**/${LOCAL_FILE}`,
	);
	if (covered) return { changed: false, reason: "already-ignored", file };
	const block = `${text.endsWith("\n") || !text ? "" : "\n"}\n# pi-web-ui SFTP 本机覆盖（可能含明文凭据，勿提交）\n${wanted}\n`;
	await fs.writeFile(file, text + block, "utf8");
	return { changed: true, file };
}

export function plaintextCredentials(doc) {
	const out = [];
	for (const [name, conn] of Object.entries(doc.connections)) {
		for (const k of ["password", "passphrase", "privateKey"]) {
			const v = conn.auth?.[k];
			if (v && !String(v).startsWith("${")) out.push({ connection: name, field: `auth.${k}` });
		}
	}
	return out;
}

export function publicConnection(conn) {
	if (!conn) return null;
	return {
		name: conn.name,
		useGlobal: conn.useGlobal,
		host: conn.host,
		port: conn.port,
		username: conn.username,
		remotePath: conn.remotePath,
		allowRootRemote: conn.allowRootRemote,
		ready: conn.ready,
		sync: { ...conn.sync },
		mappings: conn.mappings.map((m) => ({ ...m })),
		ignore: [...conn.ignore],
		auth: {
			method: conn.auth.method,
			password: describeSafe(conn.auth.password),
			passphrase: describeSafe(conn.auth.passphrase),
			privateKey: describeSafe(conn.auth.privateKey),
			privateKeyPath: conn.auth.privateKeyPath,
			agent: conn.auth.agent,
		},
		hasCredentials: Boolean(
			conn.auth.password ||
			conn.auth.privateKey ||
			conn.auth.privateKeyPath ||
			conn.auth.agent ||
			conn.auth.method === "key",
		),
	};
}

function describeSafe(raw) {
	if (!raw) return "";
	if (!String(raw).startsWith("${")) return "plain";
	const m = /^\$\{(env|secret|file):([^{}]*)\}$/.exec(String(raw).trim());
	return m ? `${m[1]}:${m[2]}` : "invalid";
}

export async function importVscodeSftp(cwd) {
	const src = path.join(cwd, ".vscode", "sftp.json");
	const raw = await readJson(src);
	if (!raw || typeof raw !== "object") return null;
	const name = String(raw.name ?? "").trim() || "default";
	const secrets = {};
	const auth = {};
	if (raw.password) {
		auth.password = `\${secret:${name}-password}`;
		secrets[`${name}-password`] = String(raw.password);
	}
	if (raw.privateKey) {
		auth.privateKey = `\${secret:${name}-privateKey}`;
		secrets[`${name}-privateKey`] = String(raw.privateKey);
	}
	if (raw.privateKeyPath) auth.privateKeyPath = String(raw.privateKeyPath);
	if (raw.passphrase) {
		auth.passphrase = `\${secret:${name}-passphrase}`;
		secrets[`${name}-passphrase`] = String(raw.passphrase);
	}
	if (raw.agent) auth.agent = String(raw.agent);
	return {
		source: src,
		name,
		secrets,
		connection: {
			host: String(raw.host ?? "").trim(),
			port: raw.port ?? 22,
			username: raw.username ?? "root",
			remotePath: normalizeRemotePath(raw.remotePath ?? raw.remoteRoot ?? "/") || "/",
			ignore: asStringArray(raw.ignore ?? raw.exclude),
			uploadOnSaveHint: Boolean(raw.uploadOnSave),
			auth,
		},
	};
}
