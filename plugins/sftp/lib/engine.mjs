import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";
import { createGunzip } from "node:zlib";
import { posixDir, posixJoin, safeRel } from "./config.mjs";
import { isInternalPath, makeMatcher, pruneDirNames } from "./ignore.mjs";

export const MAX_SCAN_FILES = 40_000;
export const MAX_SCAN_DEPTH = 32;
export const SCAN_CONCURRENCY = 8;
const MTIME_TOLERANCE_S = 2;
const SFTP_CALL_TIMEOUT_MS = 30_000;
const STREAM_IDLE_TIMEOUT_MS = 45_000;
const DIRECT_IO_MAX_BYTES = 256 * 1024;

export function sftpCall(sftp, method, ...args) {
	return new Promise((resolve, reject) => {
		if (typeof sftp?.[method] !== "function") return reject(new Error(`SFTP 不支持 ${method}`));
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`SFTP ${method} 超时（${Math.round(SFTP_CALL_TIMEOUT_MS / 1000)}s）`));
		}, SFTP_CALL_TIMEOUT_MS);
		if (typeof timer.unref === "function") timer.unref();
		try {
			sftp[method](...args, (err, r) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (err) reject(err);
				else resolve(r);
			});
		} catch (err) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		}
	});
}

export function isSafeRemoteName(name) {
	if (!name || typeof name !== "string") return false;
	if (name === "." || name === "..") return false;
	return !name.includes("/") && !name.includes("\\");
}

export function abortError(msg = "已取消（用户中止）") {
	const err = new Error(msg);
	err.name = "AbortError";
	err.code = "ABORT_ERR";
	return err;
}

export function throwIfAborted(signal) {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : abortError();
}

export function isAbortError(err, signal) {
	if (signal?.aborted) return true;
	if (err?.name === "AbortError" || err?.code === "ABORT_ERR") return true;
	return typeof err?.message === "string" && /aborted/i.test(err.message);
}

export async function runPool(items, limit, worker, { signal } = {}) {
	const out = new Array(items.length);
	let cursor = 0;
	const n = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1));
	const runners = [];
	for (let i = 0; i < n; i++) {
		runners.push(
			(async () => {
				for (;;) {
					if (signal?.aborted) return;
					const idx = cursor++;
					if (idx >= items.length) return;
					out[idx] = await worker(items[idx], idx);
				}
			})(),
		);
	}
	await Promise.all(runners);
	return out;
}

function insideRoot(root, abs) {
	const rel = path.relative(root, abs);
	if (rel === "") return abs;
	if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
	return abs;
}

/**
 * 扫本地一棵树 → Map<rel, {size,mtime,abs}>。
 *
 * **按层并行**：同一层的目录一起 readdir、同一层的文件一起 stat。老实现是一条 `await`
 * 链串到底（目录 → 文件 → 下一个目录），上万个文件时几乎全程在等下一个 syscall 排队，
 * 进度还完全看不见。层序遍历天然给出「已扫 N 个」的进度，也顺手把并发铺满。
 *
 * @param {string} absRoot
 * @param {(rel: string) => boolean} ignore
 * @param {{ signal?: AbortSignal, onProgress?: (p: object) => void, concurrency?: number }} [opts]
 */
export async function scanLocal(absRoot, ignore, { signal, onProgress, concurrency = SCAN_CONCURRENCY } = {}) {
	const files = new Map();
	let truncated = false;
	let dirs = 0;
	let level = [{ dir: absRoot, rel: "", depth: 0 }];
	const report = (scanned) =>
		onProgress?.({ side: "local", files: files.size, dirs, current: scanned[scanned.length - 1]?.rel ?? "" });

	while (level.length) {
		throwIfAborted(signal);
		const next = [];
		const candidates = [];
		await runPool(
			level,
			concurrency,
			async (d) => {
				let ents;
				try {
					ents = await fs.readdir(d.dir, { withFileTypes: true });
				} catch {
					return;
				}
				dirs++;
				for (const e of ents) {
					const childRel = d.rel ? `${d.rel}/${e.name}` : e.name;
					if (isInternalPath(childRel) || ignore(childRel)) continue;
					if (e.isSymbolicLink()) continue;
					if (e.isDirectory()) {
						if (d.depth + 1 <= MAX_SCAN_DEPTH)
							next.push({ dir: path.join(d.dir, e.name), rel: childRel, depth: d.depth + 1 });
						continue;
					}
					if (!e.isFile()) continue;
					if (files.size + candidates.length >= MAX_SCAN_FILES) {
						truncated = true;
						continue;
					}
					candidates.push({ rel: childRel, abs: path.join(d.dir, e.name) });
				}
			},
			{ signal },
		);
		throwIfAborted(signal);
		await runPool(
			candidates,
			concurrency,
			async (c) => {
				throwIfAborted(signal);
				let st;
				try {
					st = await fs.stat(c.abs);
				} catch {
					return;
				}
				if (files.size >= MAX_SCAN_FILES) {
					truncated = true;
					return;
				}
				files.set(c.rel, { rel: c.rel, size: st.size, mtime: Math.floor(st.mtimeMs / 1000), abs: c.abs });
			},
			{ signal },
		);
		const scanned = level;
		level = next;
		report(scanned);
	}
	return { files, truncated };
}

/**
 * 扫远端一棵树 → Map<rel, {size,mtime,path}>（readdir 自带 attrs，不多花往返）。
 *
 * **按层并行**：每层最多 `concurrency` 个 readdir 同时在途。这是远端扫描唯一的杠杆 ——
 * 一次 readdir 一个往返，200ms RTT 下 500 个目录串行要 100 秒，并行 8 路只要十几秒。
 * SSH 服务端一般允许几十个并发 SFTP 请求，8~16 路是安全区（`scanConcurrency` 可调）。
 *
 * @param {any} sftp
 * @param {string} remoteRoot
 * @param {(rel: string) => boolean} ignore
 * @param {{ signal?: AbortSignal, onProgress?: (p: object) => void, concurrency?: number, execScan?: (cmd: string, opts?: object) => Promise<any>, pruneNames?: string[] }} [opts]
 *   `execScan` = 一次 `find` 把整棵树取回来的快通道（仅在 allowExec 打开时由宿主注入）：
 *   给了就先走它，失败/服务端不认 -printf 就无声无息地回落逐目录 readdir —— 慢，但一定对。
 */
export async function scanRemote(
	sftp,
	remoteRoot,
	ignore,
	{ signal, onProgress, concurrency = SCAN_CONCURRENCY, execScan, pruneNames = [] } = {},
) {
	if (typeof execScan === "function") {
		let fast;
		try {
			fast = await scanRemoteViaFind(execScan, remoteRoot, ignore, { signal, pruneNames });
		} catch (err) {
			if (isAbortError(err, signal)) throw err;
			fast = { ok: false, reason: String(err?.message ?? err) };
		}
		if (fast.ok) {
			onProgress?.({ side: "remote", files: fast.files.size, dirs: 0, via: "find" });
			return fast;
		}
		engineNote(`远端快扫不可用，回落逐目录扫描：${fast.reason}`);
	}
	const files = new Map();
	let exists = true;
	let truncated = false;
	let mtimeMissing = false;
	let dirs = 0;
	let level = [{ dir: remoteRoot, rel: "", depth: 0 }];
	const report = (scanned) =>
		onProgress?.({ side: "remote", files: files.size, dirs, current: scanned[scanned.length - 1]?.rel ?? "" });

	while (level.length) {
		throwIfAborted(signal);
		const next = [];
		await runPool(
			level,
			concurrency,
			async (d) => {
				let list;
				try {
					list = await sftpCall(sftp, "readdir", d.dir);
				} catch {
					if (d.depth === 0) exists = false;
					return;
				}
				dirs++;
				const base = d.dir.replace(/\/+$/, "");
				for (const f of list ?? []) {
					const name = f?.filename;
					if (!isSafeRemoteName(name)) continue;
					const childRel = d.rel ? `${d.rel}/${name}` : name;
					if (isInternalPath(childRel) || ignore(childRel)) continue;
					const attrs = f.attrs ?? {};
					if (typeof attrs.isDirectory === "function" && attrs.isDirectory()) {
						if (d.depth + 1 <= MAX_SCAN_DEPTH) next.push({ dir: `${base}/${name}`, rel: childRel, depth: d.depth + 1 });
						continue;
					}
					if (typeof attrs.isFile === "function" && !attrs.isFile()) continue;
					if (files.size >= MAX_SCAN_FILES) {
						truncated = true;
						continue;
					}
					const mt = typeof attrs.mtime === "number" ? Math.floor(attrs.mtime) : null;
					if (mt === null) mtimeMissing = true;
					files.set(childRel, {
						rel: childRel,
						size: Number(attrs.size) || 0,
						mtime: mt,
						path: `${base}/${name}`,
					});
				}
			},
			{ signal },
		);
		const scanned = level;
		level = next;
		report(scanned);
	}
	return { files, exists, truncated, mtimeMissing, via: "sftp" };
}

let lastFallbackReason = "";
/** @type {null | ((reason: string) => void)} */
let noteSink = null;
export function onEngineNote(fn) {
	noteSink = typeof fn === "function" ? fn : null;
}
function engineNote(reason) {
	const r = String(reason ?? "").slice(0, 200);
	if (!r || r === lastFallbackReason) return;
	lastFallbackReason = r;
	try {
		noteSink?.(r);
	} catch {}
}

export function shellQuote(s) {
	return `'${String(s ?? "").replace(/'/g, "'\\''")}'`;
}

const INTERNAL_PRUNE = [".sftp-trash", ".sftp-tmp*"];

function isSafeRelPath(rel) {
	const segs = String(rel ?? "").split("/");
	return segs.length > 0 && segs.every((s) => isSafeRemoteName(s));
}

/**
 * 解析 `find -printf '%y\t%s\t%T@\t%P\0'` 的输出。
 *
 * 优先按 NUL 切（能扛文件名里的换行）；服务端不认 `\0` 时退化为按行切，此时任何一行字段数不对
 * 就返回 null —— 调用方**整批放弃**，绝不半信半疑地用（错误解析可能凭空造出一个远端条目，
 * 删除策略是 both 时会变成删错东西）。
 *
 * @returns {{ records: { type: string, size: number, mtime: number, rel: string }[] } | null}
 */
export function parseFindOutput(stdout) {
	const text = String(stdout ?? "");
	if (!text) return { records: [] };
	const sep = text.includes("\0") ? "\0" : "\n";
	const records = [];
	for (const line of text.split(sep)) {
		if (!line) continue;
		const parts = line.split("\t");
		if (parts.length < 4) return null;
		const [type, size, mtime, ...rest] = parts;
		const rel = rest.join("\t");
		if (!rel) continue;
		records.push({ type, size: Number(size), mtime: Number(mtime), rel });
	}
	return { records };
}

/**
 * 用一次 `find` 把整棵远端树取回来 —— 一次往返抵掉 N 次 readdir（2800 个目录：几十秒 → 不到一秒）。
 *
 * 只在 allowExec 打开时可用，而且**只负责快**：命令退出码非 0、输出被截断、解析不确定，
 * 一律 `{ ok: false }` 让调用方回落 SFTP 逐目录扫描。
 *
 * @param {(cmd: string, opts?: object) => Promise<any>} exec 宿主的远端 exec（带 stdout/stderr/code/truncated）
 * @param {string} remoteRoot 远端扫描基点（绝对路径）
 * @param {(rel: string) => boolean} ignore 逐条判定器（用于过滤 find 给出的条目）
 * @param {{ signal?: AbortSignal, pruneNames?: string[], timeoutMs?: number, maxBytes?: number }} [opts]
 * @returns {Promise<{ ok: false, reason: string } | { ok: true, files: Map<string, object>, exists: boolean, truncated: boolean, mtimeMissing: boolean, via: string }>}
 */
export async function scanRemoteViaFind(
	exec,
	remoteRoot,
	ignore,
	{ signal, pruneNames = [], timeoutMs = 180_000, maxBytes = 8 * 1024 * 1024 } = {},
) {
	throwIfAborted(signal);
	const root = String(remoteRoot || "/").replace(/\/+$/, "") || "/";
	const userNames = pruneDirNames(pruneNames).filter((n) => !INTERNAL_PRUNE.includes(n));
	const names = [...INTERNAL_PRUNE, ...userNames];
	const prune = names.length ? `\\( ${names.map((n) => `-name ${shellQuote(n)}`).join(" -o ")} \\) -prune -o` : "";
	const cmd = `find ${shellQuote(root)} ${prune} -printf ${shellQuote("%y\\t%s\\t%T@\\t%P\\0")}`;
	const res = await exec(cmd, { timeoutMs, maxBytes });
	if (!res || res.code !== 0) {
		return { ok: false, reason: String(res?.stderr ?? "").trim() || `find 退出码 ${res?.code ?? "?"}` };
	}
	if (res.truncated) return { ok: false, reason: "find 输出超过上限" };
	const parsed = parseFindOutput(res.stdout);
	if (!parsed) return { ok: false, reason: "find 输出无法解析" };

	const files = new Map();
	let truncated = false;
	let mtimeMissing = false;
	for (const r of parsed.records) {
		if (r.type !== "f") continue;
		throwIfAborted(signal);
		const rel = r.rel.replace(/^\.\//, "");
		if (!rel || !isSafeRelPath(rel) || isInternalPath(rel) || ignore(rel)) continue;
		if (rel.split("/").length - 1 > MAX_SCAN_DEPTH) continue;
		if (files.size >= MAX_SCAN_FILES) {
			truncated = true;
			continue;
		}
		const mt = Number.isFinite(r.mtime) ? Math.floor(r.mtime) : null;
		if (mt === null) mtimeMissing = true;
		files.set(rel, { rel, size: Number.isFinite(r.size) ? r.size : 0, mtime: mt, path: `${root}/${rel}` });
	}
	return { ok: true, files, exists: true, truncated, mtimeMissing, via: "find" };
}

export async function statRemote(sftp, p) {
	try {
		const st = await sftpCall(sftp, "stat", p);
		return {
			size: Number(st?.size) || 0,
			mtime: typeof st?.mtime === "number" ? Math.floor(st.mtime) : null,
			isDir: typeof st?.isDirectory === "function" ? st.isDirectory() : false,
		};
	} catch {
		return null;
	}
}

export function sameFile(l, r, mode) {
	if (mode === "always") return false;
	if ((l?.size ?? -1) !== (r?.size ?? -1)) return false;
	if (mode === "size") return true;
	if (l?.mtime == null || r?.mtime == null) return true;
	return Math.abs(l.mtime - r.mtime) <= MTIME_TOLERANCE_S;
}

export function resolveScope(conn, scope, target) {
	if (scope === "all") return conn.roots.map((root, index) => ({ index, root, base: "" }));
	const p = safeRel(target ?? "");
	if (p === null) throw new Error(`路径越出工作区：${target}`);
	const index = conn.roots.findIndex((r) => r.local === "" || p === r.local || p.startsWith(`${r.local}/`));
	if (index < 0) {
		throw new Error(
			conn.mappings.length
				? `「${p}」不在任何 mappings 同步根内 —— 配了 mappings 时只同步被映射的子树`
				: `「${p}」不在同步根内`,
		);
	}
	const root = conn.roots[index];
	const base = root.local === "" ? p : p.slice(root.local.length).replace(/^\/+/, "");
	if (scope === "file") {
		if (!base) throw new Error("scope=file 需要一个具体文件路径");
		return [{ index, root, base, single: true }];
	}
	return [{ index, root, base }];
}

/**
 * @param {object} o
 * @param {object} o.conn 归一化连接
 * @param {any} o.sftp SFTP 通道
 * @param {string} o.cwd 工作区根（本地同步根锚点）
 * @param {"all"|"tree"|"file"} o.scope
 * @param {string} [o.target]
 * @param {"up"|"down"|"both"} [o.direction] 覆盖连接里的方向
 * @param {string} [o.deletePolicy] 覆盖连接里的删除策略
 * @param {AbortSignal} [o.signal] 取消信号（扫描期间按下「停止」也立即生效）
 * @param {(p: object) => void} [o.onProgress] 扫描进度（本地/远端两侧各自的文件数、目录数）
 * @param {number} [o.scanConcurrency] 扫描并发（默认 SCAN_CONCURRENCY）
 * @param {(cmd: string, opts?: object) => Promise<any>} [o.execScan] 远端 exec（仅 allowExec 打开时由宿主注入）：
 *   给了就先用一次 `find` 把整棵树取回来，失败自动回落逐目录 readdir
 */
export async function planSync({
	conn,
	sftp,
	cwd,
	scope,
	target,
	direction,
	deletePolicy,
	signal,
	onProgress,
	scanConcurrency = SCAN_CONCURRENCY,
	execScan,
}) {
	const dir = direction ?? conn.sync.direction;
	const policy = deletePolicy ?? conn.sync.delete;
	const compare = conn.sync.compare;
	const ignore = makeMatcher(conn.ignore);
	const scopes = resolveScope(conn, scope, target);

	const roots = [];
	const warnings = [];
	let truncated = false;
	let mtimesUnavailable = false;
	let remoteViaFind = false;

	for (const { index, root, base, single } of scopes) {
		throwIfAborted(signal);
		const localAbs = path.join(cwd, root.local, base);
		const remoteAbs = posixJoin(root.remote, base);
		const localRootAbs = path.join(cwd, root.local);
		let local = new Map();
		let remote = new Map();
		let remoteExists = true;
		let localExists = true;

		try {
			await fs.access(localRootAbs);
		} catch {
			localExists = false;
		}

		const localBaseAbs = single ? localRootAbs : localAbs;
		const remoteBaseAbs = single ? root.remote : remoteAbs;

		if (single) {
			const rel = base;
			if (ignore(rel) || isInternalPath(rel)) throw new Error(`「${rel}」在排除规则内（ignore），不会同步`);
			const abs = insideRoot(cwd, path.join(localRootAbs, rel));
			if (!abs) throw new Error(`路径越出工作区：${rel}`);
			try {
				const st = await fs.stat(abs);
				if (st.isFile()) local.set(rel, { rel, size: st.size, mtime: Math.floor(st.mtimeMs / 1000), abs });
			} catch {}
			const rs = await statRemote(sftp, posixJoin(root.remote, rel));
			if (rs) remote.set(rel, { rel, size: rs.size, mtime: rs.mtime, path: posixJoin(root.remote, rel) });
			else remoteExists = false;
		} else {
			const ls = await scanLocal(localAbs, ignore, { signal, onProgress, concurrency: scanConcurrency });
			local = ls.files;
			truncated ||= ls.truncated;
			const rs = await scanRemote(sftp, remoteAbs, ignore, {
				signal,
				onProgress,
				concurrency: scanConcurrency,
				execScan,
				pruneNames: conn.ignore,
			});
			remote = rs.files;
			remoteExists = rs.exists;
			truncated ||= rs.truncated;
			mtimesUnavailable ||= rs.mtimeMissing;
			if (rs.via === "find") remoteViaFind = true;
		}
		if (truncated) warnings.push(`已扫描到 ${MAX_SCAN_FILES} 个文件上限 —— 结果可能不完整，建议缩小范围或补充 ignore`);

		if (compare === "mtime+size" && typeof execScan === "function") {
			await reconcileSameSizeByHash({
				local,
				remote,
				remoteBaseAbs,
				execScan,
				signal,
				concurrency: scanConcurrency,
			});
		}

		const entries = [];
		const keys = new Set([...local.keys(), ...remote.keys()]);
		for (const rel of [...keys].sort()) {
			const l = local.get(rel) ?? null;
			const r = remote.get(rel) ?? null;
			entries.push(
				buildEntry({
					rel,
					l,
					r,
					dir,
					policy,
					compare,
					conflict: conn.sync.conflict,
					rootIndex: index,
					localBaseAbs,
					remoteBaseAbs,
				}),
			);
		}
		roots.push({
			index,
			localRel: root.local,
			localAbs: localRootAbs,
			remoteAbs,
			remoteRoot: root.remote,
			base,
			localExists,
			remoteExists,
			entries,
			scanned: { local: local.size, remote: remote.size },
		});
	}

	const summary = { upload: 0, download: 0, trashRemote: 0, trashLocal: 0, skip: 0, conflict: 0, total: 0 };
	for (const r of roots) {
		for (const e of r.entries) {
			summary.total++;
			if (e.action === "upload") summary.upload++;
			else if (e.action === "download") summary.download++;
			else if (e.action === "trash-remote") summary.trashRemote++;
			else if (e.action === "trash-local") summary.trashLocal++;
			else if (e.kind === "conflict") summary.conflict++;
			else summary.skip++;
		}
	}
	if (mtimesUnavailable && compare === "mtime+size") {
		warnings.push("部分远端文件没有 mtime（服务端未返回）—— 这些文件退化为「大小相同即视为一致」");
	}
	return {
		profile: conn.name,
		cwd,
		direction: dir,
		deletePolicy: policy,
		compare,
		scope,
		target: target ?? "",
		roots,
		summary,
		warnings,
		truncated,
		remoteScan: remoteViaFind ? "find" : "sftp",
	};
}

async function reconcileSameSizeByHash({ local, remote, remoteBaseAbs, execScan, signal, concurrency = 8 }) {
	const MAX_HASH_FILE_SIZE = 16 * 1024 * 1024;
	const candidates = [];
	for (const [rel, l] of local) {
		const r = remote.get(rel);
		if (!r) continue;
		if (l.size !== r.size || l.size > MAX_HASH_FILE_SIZE) continue;
		if (l.mtime == null || r.mtime == null) continue;
		if (Math.abs(l.mtime - r.mtime) <= MTIME_TOLERANCE_S) continue;
		if (!isSafeRelPath(rel)) continue;
		candidates.push({ rel, l, r });
	}
	if (!candidates.length) return;

	const nonEmpty = [];
	for (const c of candidates) {
		if (c.l.size === 0) {
			c.r.mtime = c.l.mtime;
		} else {
			nonEmpty.push(c);
		}
	}
	if (!nonEmpty.length) return;

	const CHUNK = 200;
	const remoteHashes = new Map();
	for (let i = 0; i < nonEmpty.length; i += CHUNK) {
		throwIfAborted(signal);
		const slice = nonEmpty.slice(i, i + CHUNK);
		const cmd = `cd ${shellQuote(remoteBaseAbs)} && md5sum -- ${slice.map((c) => shellQuote(c.rel)).join(" ")}`;
		let res;
		try {
			res = await execScan(cmd, { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 });
		} catch {
			return;
		}
		if (!res || res.code !== 0 || res.truncated) return;
		for (const line of String(res.stdout ?? "").split(/\r?\n/)) {
			if (!line) continue;
			const m = /^([0-9a-fA-F]{32})\s+[ *]?(.+)$/.exec(line.trim());
			if (m) remoteHashes.set(m[2], m[1].toLowerCase());
		}
	}
	if (!remoteHashes.size) return;

	await runPool(
		nonEmpty,
		concurrency,
		async (c) => {
			throwIfAborted(signal);
			const rHash = remoteHashes.get(c.rel);
			if (!rHash) return;
			try {
				const buf = await fs.readFile(c.l.abs);
				const lHash = createHash("md5").update(buf).digest("hex").toLowerCase();
				if (lHash === rHash) {
					c.r.mtime = c.l.mtime;
				}
			} catch {}
		},
		{ signal },
	);
}

function buildEntry({ rel, l, r, dir, policy, compare, conflict, rootIndex, localBaseAbs, remoteBaseAbs }) {
	const absLocal = l?.abs ?? insideRoot(localBaseAbs, path.join(localBaseAbs, rel)) ?? path.join(localBaseAbs, rel);
	const absRemote = posixJoin(remoteBaseAbs, rel);
	const base = {
		rel,
		rootIndex,
		absLocal,
		absRemote,
		localSize: l?.size ?? null,
		remoteSize: r?.size ?? null,
		localMtime: l?.mtime ?? null,
		remoteMtime: r?.mtime ?? null,
	};
	if (dir === "up") {
		if (l && !r) return { ...base, kind: "add", action: "upload", reason: "远端没有" };
		if (l && r && !sameFile(l, r, compare)) return { ...base, kind: "update", action: "upload", reason: "内容有差异" };
		if (l && r) return { ...base, kind: "same", action: "skip", reason: "一致" };
		const allowed = policy === "remote-only" || policy === "both";
		return allowed
			? { ...base, kind: "remote-only", action: "trash-remote", reason: "远端多余的（删除策略允许清理）" }
			: { ...base, kind: "remote-only", action: "skip", reason: `远端多余的；删除策略为 ${policy}，不清理` };
	}
	if (dir === "down") {
		if (!l && r) return { ...base, kind: "add", action: "download", reason: "本地没有" };
		if (l && r && !sameFile(l, r, compare))
			return { ...base, kind: "update", action: "download", reason: "内容有差异" };
		if (l && r) return { ...base, kind: "same", action: "skip", reason: "一致" };
		const allowed = policy === "both";
		return allowed
			? { ...base, kind: "local-only", action: "trash-local", reason: "本地多余的（删除策略允许清理）" }
			: { ...base, kind: "local-only", action: "skip", reason: `本地多余的；删除策略为 ${policy}，不清理` };
	}
	if (l && !r) return { ...base, kind: "add", action: "upload", reason: "仅本地有" };
	if (!l && r) return { ...base, kind: "add", action: "download", reason: "仅远端有" };
	if (sameFile(l, r, compare)) return { ...base, kind: "same", action: "skip", reason: "一致" };
	if (conflict === "local")
		return { ...base, kind: "conflict", action: "upload", reason: "两侧不同，按策略以本地为准" };
	if (conflict === "remote")
		return { ...base, kind: "conflict", action: "download", reason: "两侧不同，按策略以远端为准" };
	if (conflict === "newer" && l.mtime != null && r.mtime != null && l.mtime !== r.mtime) {
		const localNewer = l.mtime > r.mtime;
		return {
			...base,
			kind: "conflict",
			action: localNewer ? "upload" : "download",
			reason: `两侧不同，${localNewer ? "本地" : "远端"}更新`,
		};
	}
	return { ...base, kind: "conflict", action: "skip", reason: "两侧不同且无法判定新旧，需人工决定" };
}

function counting(onBytes) {
	let n = 0;
	return new Transform({
		transform(chunk, _enc, cb) {
			n += chunk.length;
			onBytes?.(n);
			cb(null, chunk);
		},
	});
}

export async function renameRemote(sftp, from, to) {
	let firstErr;
	try {
		await sftpCall(sftp, "rename", from, to);
		return;
	} catch (err) {
		firstErr = err;
	}
	const st = await sftpCall(sftp, "stat", to).catch(() => null);
	if (!st) {
		throw firstErr;
	}
	const bak = `${to}.pi-ren-bak-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	await sftpCall(sftp, "rename", to, bak);
	try {
		await sftpCall(sftp, "rename", from, to);
	} catch (err) {
		await sftpCall(sftp, "rename", bak, to).catch(() => {});
		throw err;
	}
	await sftpCall(sftp, "unlink", bak).catch(() => {});
}

export function makeRemoteMkdir(sftp) {
	const known = new Set(["/"]);
	return async function mkdirp(dir) {
		const target = String(dir ?? "").replace(/\/+$/, "");
		if (!target || known.has(target)) return;
		const segs = target.split("/").filter(Boolean);
		let cur = target.startsWith("/") ? "" : ".";
		for (const s of segs) {
			cur = cur === "." ? s : `${cur}/${s}`;
			if (known.has(cur)) continue;
			await sftpCall(sftp, "mkdir", cur).catch(() => {});
			known.add(cur);
		}
	};
}

async function pipelineWithTimeout(rs, transform, ws, signal) {
	throwIfAborted(signal);
	let timer = null;
	let abortHandler = null;
	const resetTimer = (reject) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			const err = new Error(`文件流传输超时（${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s 无进展）`);
			try {
				rs.destroy(err);
			} catch {}
			try {
				ws.destroy(err);
			} catch {}
			reject(err);
		}, STREAM_IDLE_TIMEOUT_MS);
		if (typeof timer.unref === "function") timer.unref();
	};
	try {
		await new Promise((resolve, reject) => {
			resetTimer(reject);
			if (signal) {
				abortHandler = () => {
					const err = signal.reason instanceof Error ? signal.reason : abortError();
					try {
						rs.destroy(err);
					} catch {}
					try {
						ws.destroy(err);
					} catch {}
					reject(err);
				};
				if (signal.aborted) return abortHandler();
				signal.addEventListener("abort", abortHandler, { once: true });
			}
			rs.on("data", () => resetTimer(reject));
			pipeline(rs, transform, ws, { signal }).then(resolve, reject);
		});
	} finally {
		if (timer) clearTimeout(timer);
		if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
	}
}

export async function uploadFile(sftp, localAbs, remoteAbs, { onBytes, mkdirp, signal } = {}) {
	throwIfAborted(signal);
	if (mkdirp) await mkdirp(posixDir(remoteAbs));
	const localStat = await fs.stat(localAbs);
	const expected = localStat.size;
	const mtime = Math.floor(localStat.mtimeMs / 1000);
	const tmp = `${posixDir(remoteAbs)}/.sftp-tmp-${process.pid}-${(tmpSeq++).toString(36)}-${path.posix.basename(remoteAbs)}`;
	try {
		if (expected <= DIRECT_IO_MAX_BYTES && typeof sftp?.writeFile === "function") {
			const buf = await fs.readFile(localAbs);
			throwIfAborted(signal);
			await sftpCall(sftp, "writeFile", tmp, buf);
			onBytes?.(buf.length);
		} else {
			await pipelineWithTimeout(createReadStream(localAbs), counting(onBytes), sftp.createWriteStream(tmp), signal);
		}
		if (expected > 0) {
			const st = await statRemote(sftp, tmp);
			if (!st || st.size !== expected) throw new Error(`上传后大小不符（期望 ${expected}，远端 ${st?.size ?? "?"}）`);
		}
		await renameRemote(sftp, tmp, remoteAbs);
		if (mtime > 0 && typeof sftp?.setstat === "function") {
			await sftpCall(sftp, "setstat", remoteAbs, { atime: mtime, mtime }).catch(() => {});
		}
		return expected;
	} catch (err) {
		if (signal?.aborted) {
			void sftpCall(sftp, "unlink", tmp).catch(() => {});
		} else {
			await sftpCall(sftp, "unlink", tmp).catch(() => {});
		}
		throw err;
	}
}

export async function downloadFile(sftp, remoteAbs, localAbs, { onBytes, expectedSize, expectedMtime, signal } = {}) {
	throwIfAborted(signal);
	await fs.mkdir(path.dirname(localAbs), { recursive: true });
	const tmp = path.join(
		path.dirname(localAbs),
		`.sftp-tmp-${process.pid}-${(tmpSeq++).toString(36)}-${path.basename(localAbs)}`,
	);
	let written = 0;
	try {
		if (
			typeof expectedSize === "number" &&
			expectedSize <= DIRECT_IO_MAX_BYTES &&
			typeof sftp?.readFile === "function"
		) {
			const buf = await sftpCall(sftp, "readFile", remoteAbs);
			throwIfAborted(signal);
			written = buf.length;
			onBytes?.(written);
			await fs.writeFile(tmp, buf);
		} else {
			await pipelineWithTimeout(
				sftp.createReadStream(remoteAbs),
				counting((n) => {
					written = n;
					onBytes?.(n);
				}),
				createWriteStream(tmp),
				signal,
			);
		}
		if (typeof expectedSize === "number" && expectedSize !== written) {
			throw new Error(`下载后大小不符（期望 ${expectedSize}，实际 ${written}）`);
		}
		await fs.rename(tmp, localAbs);
		if (typeof expectedMtime === "number" && expectedMtime > 0) {
			await fs.utimes(localAbs, expectedMtime, expectedMtime).catch(() => {});
		}
		return written;
	} catch (err) {
		await fs.rm(tmp, { force: true }).catch(() => {});
		throw err;
	}
}

let tmpSeq = 0;
let batchSeq = 0;

export const BATCH_MIN_FILES = 5;
export const BATCH_MAX_FILES = 2000;
export const BATCH_MAX_BYTES = 32 * 1024 * 1024;

/**
 * 流式 ustar 解析：边读边把每个成员交给 `onEntry` 给的 sink，**不把整包留在内存**。
 *
 * 自己是解析别人给的文本，所以保守到什么程度：不是 ustar、checksum 对不上、尺寸非法、
 * 数据被截断、整体超过 `maxBytes` —— 一律 `{ ok: false }`，调用方整批放弃、回落逐文件。
 * 全零块直接跳过（真 tar 的收尾、以及某些实现给每条目都补齐的写法都能吃）。
 *
 * @param {AsyncIterable<Buffer>} source
 * @param {{
 *   onEntry: (entry: { name: string, size: number, type: string }) =>
 *     Promise<{ write(chunk: Buffer): Promise<void>, close(): Promise<void> } | null> | null,
 *   signal?: AbortSignal,
 *   maxBytes?: number,
 * }} o
 * @returns {Promise<{ ok: true, entries: string[] } | { ok: false, reason: string }>}
 */
export async function readTarStream(source, { onEntry, signal, maxBytes = Infinity } = {}) {
	const it = source[Symbol.asyncIterator]();
	let buf = Buffer.alloc(0);
	let used = 0;
	let total = 0;
	const entries = [];

	const fill = async () => {
		const next = await it.next();
		if (next.done) return false;
		throwIfAborted(signal);
		total += next.value.length;
		if (total > maxBytes) throw new Error("tar 数据超过上限");
		const rest = buf.length > used ? buf.subarray(used) : null;
		buf = rest && rest.length ? Buffer.concat([rest, next.value]) : next.value;
		used = 0;
		return true;
	};
	const available = () => buf.length - used;
	const take = (n) => {
		const out = buf.subarray(used, used + n);
		used += out.length;
		return out;
	};
	const takeExact = async (n) => {
		while (available() < n) if (!(await fill())) return null;
		return take(n);
	};

	try {
		for (;;) {
			const head = await takeExact(512);
			if (!head) break;
			if (!head.some((b) => b !== 0)) continue;
			const str = (o, len) => {
				const raw = head.subarray(o, o + len);
				const idx = raw.indexOf(0);
				return raw.subarray(0, idx < 0 ? raw.length : idx).toString("utf8");
			};
			if (str(257, 6) !== "ustar") return { ok: false, reason: "不是 ustar 流" };
			const stored = parseInt(str(148, 8).trim(), 8);
			const clone = Buffer.from(head);
			clone.fill(0x20, 148, 156);
			let sum = 0;
			for (const b of clone) sum += b;
			if (!Number.isFinite(stored) || sum !== stored) return { ok: false, reason: "tar 头 checksum 对不上" };
			const size = parseInt(str(124, 12).trim() || "0", 8);
			if (!Number.isFinite(size) || size < 0) return { ok: false, reason: "tar 头里的尺寸非法" };
			const type = String.fromCharCode(head[156] || 0x30);
			const prefix = str(345, 155);
			const name = str(0, 100);
			const full = prefix ? `${prefix}/${name}` : name;
			const regular = type === "0" || type === "\0";

			let sink = null;
			if (regular && full) {
				sink = (await onEntry?.({ name: full, size, type })) ?? null;
				if (sink) entries.push(full);
			}
			let left = size;
			while (left > 0) {
				if (!available() && !(await fill())) return { ok: false, reason: "tar 数据被截断" };
				const piece = take(Math.min(left, available()));
				left -= piece.length;
				if (sink) await sink.write(piece);
			}
			if (sink) await sink.close();
			const pad = (512 - (size % 512)) % 512;
			if (pad) {
				const skipped = await takeExact(pad);
				if (!skipped) return { ok: false, reason: "tar 数据被截断" };
			}
		}
	} finally {
		try {
			await it.return?.();
		} catch {}
	}
	return { ok: true, entries };
}

function writeOctal(buf, offset, len, value) {
	const n = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
	const digits = n.toString(8).slice(-(len - 1));
	buf.write(digits.padStart(len - 1, "0"), offset, len - 1, "ascii");
	buf[offset + len - 1] = 0;
}

/**
 * 写一个 ustar 头（512 字节）。路径装不下（name ≤100 且 prefix ≤155）时返回 null，
 * 调用方把那个文件退回逐文件路径 —— 不搞 GNU 长名扩展，简单胜过全能。
 *
 * @param {{ name: string, size: number, mtime?: number, mode?: number }} o
 */
export function tarHeader({ name, size, mtime = 0, mode = 0o644 }) {
	let shortName = name;
	let prefix = "";
	if (Buffer.byteLength(name, "utf8") > 100) {
		let cut = -1;
		for (let i = 0; i < name.length; i++) {
			if (name[i] !== "/") continue;
			if (Buffer.byteLength(name.slice(0, i), "utf8") <= 155 && Buffer.byteLength(name.slice(i + 1), "utf8") <= 100)
				cut = i;
		}
		if (cut < 0) return null;
		prefix = name.slice(0, cut);
		shortName = name.slice(cut + 1);
	}
	const buf = Buffer.alloc(512);
	buf.write(shortName, 0, 100, "utf8");
	writeOctal(buf, 100, 8, mode);
	writeOctal(buf, 108, 8, 0);
	writeOctal(buf, 116, 8, 0);
	writeOctal(buf, 124, 12, size);
	writeOctal(buf, 136, 12, mtime);
	buf.write("        ", 148, 8, "ascii");
	buf.write("0", 156, 1, "ascii");
	buf.write("ustar\0", 257, 6, "ascii");
	buf.write("00", 263, 2, "ascii");
	buf.write(prefix, 345, 155, "utf8");
	let sum = 0;
	for (const b of buf) sum += b;
	buf.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
	return buf;
}

/**
 * 把一批文件打成 ustar **流**（不调本机 tar：Windows 上不一定有）。
 *
 * 异步生成器：每个文件按 64KB 边读边 yield，整包不进内存；文件在打包期间被改动
 * （字节数与计划不符）就直接抛错 —— 调用方整批放弃、回落逐文件，宁可慢不能传错。
 *
 * @param {{ rel: string, abs: string, size: number, mtime?: number }[]} files
 * @param {{ chunkSize?: number, signal?: AbortSignal }} [opts]
 */
export async function* tarStream(files, { chunkSize = 64 * 1024, signal } = {}) {
	for (const f of files) {
		throwIfAborted(signal);
		const head = tarHeader({ name: f.rel, size: f.size, mtime: Math.floor(f.mtime ?? 0) });
		if (!head) throw new Error(`路径太长（ustar 头装不下）：${f.rel}`);
		yield head;
		const rs = createReadStream(f.abs, { highWaterMark: chunkSize });
		let sent = 0;
		try {
			for await (const chunk of rs) {
				throwIfAborted(signal);
				sent += chunk.length;
				if (sent > f.size) throw new Error(`打包期间被改大：${f.rel}`);
				yield chunk;
			}
		} finally {
			rs.destroy();
		}
		if (sent !== f.size) throw new Error(`打包期间被改动：${f.rel}`);
		const pad = (512 - (sent % 512)) % 512;
		if (pad) yield Buffer.alloc(pad);
	}
	yield Buffer.alloc(1024);
}

async function uploadBatchViaTar({ exec, tasks, signal }) {
	if (typeof exec !== "function" || !tasks.length) return null;
	if (tasks.length < BATCH_MIN_FILES || tasks.length > BATCH_MAX_FILES) return null;
	const bytes = tasks.reduce((n, t) => n + (t.localSize ?? 0), 0);
	if (bytes > BATCH_MAX_BYTES) return null;

	const base = String(tasks[0].root?.remoteAbs ?? "").replace(/\/+$/, "");
	if (!base || tasks.some((t) => String(t.root?.remoteAbs ?? "").replace(/\/+$/, "") !== base)) return null;
	const staging = `${base}/.sftp-tmp-stage-${process.pid}-${(batchSeq++).toString(36)}`;
	const cleanup = () => exec(`rm -rf ${shellQuote(staging)}`, { timeoutMs: 30_000, maxBytes: 4096 }).catch(() => {});

	try {
		throwIfAborted(signal);
		const send = [];
		for (const t of tasks) {
			if (!isSafeRelPath(t.rel) || !tarHeader({ name: t.rel, size: 0, mtime: 0 })) continue;
			const st = await fs.stat(t.absLocal).catch(() => null);
			if (!st?.isFile() || st.size !== (t.localSize ?? -1)) continue;
			send.push({ rel: t.rel, abs: t.absLocal, size: st.size, mtime: t.localMtime ?? 0, task: t });
		}
		if (send.length < BATCH_MIN_FILES) return null;
		const packed = send.map((f) => ({ rel: f.rel, size: f.size, absRemote: f.task.absRemote }));

		const unpack = await exec(`mkdir -p ${shellQuote(staging)} && tar -x -f - -C ${shellQuote(staging)}`, {
			inputStream: tarStream(send, { signal }),
			signal,
			timeoutMs: 300_000,
			maxBytes: 64 * 1024,
		});
		throwIfAborted(signal);
		if (!unpack || unpack.code !== 0) {
			engineNote(
				`批量打包解包失败（${unpack ? `退出码 ${unpack.code}：${(unpack.stderr || "").trim().slice(0, 80)}` : "没响应"}），回落逐文件上传`,
			);
			await cleanup();
			return null;
		}

		const verify = await exec(`find ${shellQuote(staging)} -type f -printf ${shellQuote("%s\\t%P\\0")}`, {
			timeoutMs: 60_000,
			maxBytes: 8 * 1024 * 1024,
		});
		if (!verify || verify.code !== 0) {
			engineNote("批量打包后校验失败，回落逐文件上传");
			await cleanup();
			return null;
		}
		const actual = new Map();
		for (const line of String(verify.stdout ?? "").split("\0")) {
			if (!line) continue;
			const i = line.indexOf("\t");
			if (i <= 0) continue;
			actual.set(line.slice(i + 1), Number(line.slice(0, i)));
		}
		if (!packed.every((e) => actual.get(e.rel) === e.size)) {
			engineNote("批量打包后大小对不上，回落逐文件上传");
			await cleanup();
			return null;
		}

		const MV_CHUNK = 200;
		const dirs = [...new Set(packed.map((e) => posixDir(e.absRemote)).filter((d) => d && d !== base))];
		if (packed.length <= MV_CHUNK) {
			const cmds = [];
			if (dirs.length) cmds.push(`mkdir -p ${dirs.map(shellQuote).join(" ")}`);
			for (const e of packed) cmds.push(`mv -f ${shellQuote(posixJoin(staging, e.rel))} ${shellQuote(e.absRemote)}`);
			cmds.push(`rm -rf ${shellQuote(staging)}`);
			const move = await exec(cmds.join(" && "), { timeoutMs: 300_000, maxBytes: 64 * 1024 });
			if (!move || move.code !== 0) {
				engineNote(`批量打包落位失败（退出码 ${move?.code ?? "?"}），回落逐文件上传`);
				await cleanup();
				return null;
			}
		} else {
			for (let i = 0; i < dirs.length; i += MV_CHUNK) {
				const slice = dirs.slice(i, i + MV_CHUNK);
				const mk = await exec(`mkdir -p ${slice.map(shellQuote).join(" ")}`, {
					timeoutMs: 60_000,
					maxBytes: 64 * 1024,
				});
				if (!mk || mk.code !== 0) {
					engineNote(`批量打包建目录失败（退出码 ${mk?.code ?? "?"}），回落逐文件上传`);
					await cleanup();
					return null;
				}
			}
			for (let i = 0; i < packed.length; i += MV_CHUNK) {
				throwIfAborted(signal);
				const slice = packed.slice(i, i + MV_CHUNK);
				const cmds = slice.map((e) => `mv -f ${shellQuote(posixJoin(staging, e.rel))} ${shellQuote(e.absRemote)}`);
				if (i + MV_CHUNK >= packed.length) cmds.push(`rm -rf ${shellQuote(staging)}`);
				const move = await exec(cmds.join(" && "), { timeoutMs: 120_000, maxBytes: 64 * 1024 });
				if (!move || move.code !== 0) {
					engineNote(`批量打包落位失败（退出码 ${move?.code ?? "?"}），回落逐文件上传`);
					await cleanup();
					return null;
				}
			}
		}
		return { rels: packed.map((e) => e.rel), bytes };
	} catch (err) {
		await cleanup();
		if (isAbortError(err, signal)) throw err;
		engineNote(`批量打包出错（${String(err?.message ?? err).slice(0, 120)}），回落逐文件上传`);
		return null;
	}
}

/**
 * 一批文件 ← 远端（`tar -czf -` 一次拉回来 + 本地解包）。
 *
 * 与上传方向对称：远端一条命令打出 gzip 流 → 本地解到工作区内的暂存目录 → 逐个 `rename` 落位
 * （同盘重命名原子，保留「半成品不落位」）→ 删暂存区。
 *
 * 安全边界：
 *   - 只认**这批要下载的那几个 rel**（其余条目一律丢弃 —— 服务端塞什么进来都不好使）；
 *   - rel 必须过 `isSafeRelPath`（无 `..`/空段/分隔符），解包目标拼接后再用 insideRoot 确认
 *     落在同步根内（双重保险：路径穿越不能靠一个函数拦）；
 *   - 每个文件的大小必须与计划里看到的 remoteSize 一致，否则整批放弃。
 *
 * @returns {Promise<null | { rels: string[], bytes: number }>}
 */
async function downloadBatchViaTar({ execStream, tasks, cwd, signal }) {
	if (typeof execStream !== "function" || !tasks.length) return null;
	if (tasks.length < BATCH_MIN_FILES || tasks.length > BATCH_MAX_FILES) return null;
	const bytes = tasks.reduce((n, t) => n + (t.remoteSize ?? 0), 0);
	if (bytes > BATCH_MAX_BYTES) return null;
	const rootAbs = String(cwd ?? "").trim();
	if (!rootAbs) return null;

	const base = String(tasks[0].root?.remoteAbs ?? "").replace(/\/+$/, "");
	if (!base || tasks.some((t) => String(t.root?.remoteAbs ?? "").replace(/\/+$/, "") !== base)) return null;
	const wanted = new Map();
	for (const t of tasks) if (isSafeRelPath(t.rel)) wanted.set(t.rel, t);
	if (wanted.size < BATCH_MIN_FILES) return null;

	const staging = path.join(rootAbs, ".pi", `.sftp-tmp-stage-${process.pid}-${(batchSeq++).toString(36)}`);
	const cleanup = () => fs.rm(staging, { recursive: true, force: true }).catch(() => {});
	try {
		throwIfAborted(signal);
		const list = [...wanted.keys()];
		const got = new Map();
		let received = 0;
		/** @type {any} */
		let parsed = null;
		const gunzip = createGunzip();
		const res = await execStream(`cd ${shellQuote(base)} && tar -czf - ${list.map(shellQuote).join(" ")}`, {
			signal,
			timeoutMs: 300_000,
			consume: async (source) => {
				const pump = (async () => {
					for await (const chunk of source) {
						received += chunk.length;
						if (received > BATCH_MAX_BYTES + 4 * 1024 * 1024) throw new Error("压缩流超过上限");
						if (!gunzip.write(chunk)) await once(gunzip, "drain");
					}
					gunzip.end();
				})().catch((err) => {
					gunzip.destroy(err);
					throw err;
				});
				try {
					parsed = await readTarStream(gunzip, {
						signal,
						maxBytes: BATCH_MAX_BYTES + 1024,
						onEntry: async (entry) => {
							const t = wanted.get(entry.name);
							if (!t) return null;
							if (entry.size !== (t.remoteSize ?? entry.size)) throw new Error(`大小与计划不符：${entry.name}`);
							const dest = path.join(staging, ...entry.name.split("/"));
							if (!insideRoot(staging, dest)) throw new Error(`成员路径越界：${entry.name}`);
							await fs.mkdir(path.dirname(dest), { recursive: true });
							got.set(entry.name, dest);
							return makeFileSink(dest);
						},
					});
				} finally {
					await pump.catch(() => {});
				}
			},
		});
		if (res.code !== 0) {
			engineNote(
				`批量下载打包失败（退出码 ${res.code}${res.stderr ? `：${res.stderr.trim().slice(0, 80)}` : ""}），回落逐文件下载`,
			);
			await cleanup();
			return null;
		}
		if (!parsed) {
			engineNote("批量下载没拿到 tar 流，回落逐文件下载");
			await cleanup();
			return null;
		}
		if (!parsed.ok) {
			engineNote(`批量下载的 tar 流解析失败（${parsed.reason}），回落逐文件下载`);
			await cleanup();
			return null;
		}
		if (got.size !== wanted.size) {
			engineNote(`批量下载少了 ${wanted.size - got.size} 个文件，回落逐文件下载`);
			await cleanup();
			return null;
		}

		for (const [rel, from] of got) {
			const t = wanted.get(rel);
			const to = insideRoot(rootAbs, t.absLocal);
			if (!to) {
				engineNote(`批量下载的目标越出工作区（${rel}），回落逐文件下载`);
				await cleanup();
				return null;
			}
			await fs.mkdir(path.dirname(to), { recursive: true });
			await fs.rename(from, to);
			if (typeof t.remoteMtime === "number" && t.remoteMtime > 0) {
				await fs.utimes(to, t.remoteMtime, t.remoteMtime).catch(() => {});
			}
		}
		await cleanup();
		return { rels: [...got.keys()], bytes };
	} catch (err) {
		await cleanup();
		if (isAbortError(err, signal)) throw err;
		engineNote(`批量下载出错（${String(err?.message ?? err).slice(0, 120)}），回落逐文件下载`);
		return null;
	}
}

function makeFileSink(abs) {
	const ws = createWriteStream(abs);
	let failure = null;
	ws.on("error", (err) => {
		failure = err;
	});
	return {
		async write(chunk) {
			if (failure) throw failure;
			if (ws.write(chunk)) return;
			await once(ws, "drain");
			if (failure) throw failure;
		},
		async close() {
			if (failure) throw failure;
			await new Promise((done) => ws.end(done));
			if (failure) throw failure;
		},
	};
}

export async function trashRemote(sftp, remoteAbs, rootRemoteAbs, stamp, mkdirp) {
	const rel = remoteAbs.slice(rootRemoteAbs.replace(/\/+$/, "").length).replace(/^\/+/, "");
	const target = posixJoin(posixJoin(rootRemoteAbs, `.sftp-trash/${stamp}`), rel);
	await mkdirp(posixDir(target));
	await renameRemote(sftp, remoteAbs, target);
	return target;
}

export async function trashLocal(cwd, localAbs, stamp) {
	const rel = path.relative(cwd, localAbs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`拒绝把工作区外的文件挪进垃圾桶：${localAbs}`);
	const target = path.join(cwd, ".pi", "sftp-trash", stamp, rel);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.rename(localAbs, target);
	return target;
}

/**
 * 执行计划。
 * @param {object} o
 * @param {any} o.sftp
 * @param {object} o.plan planSync 的结果
 * @param {number} [o.concurrency]
 * @param {(p: object) => void} [o.onProgress]
 * @param {string} [o.stamp] 垃圾桶批次名（缺省按时间生成）
 * @param {AbortSignal} [o.signal] 取消信号：不再领新文件，在传的流被掉，半成品清理掉
 * @param {(cmd: string, opts?: object) => Promise<any>} [o.exec] 远端 exec（仅 allowExec 打开时注入）
 * @param {(cmd: string, opts?: object) => Promise<any>} [o.execStream] 远端 exec（stdout 当流用，下载方向）
 * @param {boolean} [o.batchTransfer] 小文件批量打包（上传用 tar 流，下载用 tar -czf -）
 */
export async function applyPlan({
	sftp,
	plan,
	concurrency = 4,
	onProgress,
	stamp,
	signal,
	exec,
	execStream,
	batchTransfer = false,
}) {
	const batch = stamp ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const mkdirp = makeRemoteMkdir(sftp);
	const failed = [];
	const done = { upload: 0, download: 0, trashRemote: 0, trashLocal: 0, skip: 0 };
	let bytes = 0;
	let cancelled = false;

	const tasks = [];
	for (const root of plan.roots) {
		for (const e of root.entries) {
			if (e.action === "skip") {
				done.skip++;
				continue;
			}
			tasks.push({ ...e, root });
		}
	}
	const total = tasks.length;
	let finished = 0;
	const tick = (e, phase) => {
		finished++;
		onProgress?.({ phase, done: finished, total, rel: e.rel, bytes, profile: plan.profile, direction: plan.direction });
	};

	let batchedCount = 0;
	let pending = tasks;
	if (batchTransfer && typeof exec === "function") {
		const handled = { up: new Set(), down: new Set() };
		const groups = [
			{
				dir: "up",
				list: tasks.filter((t) => t.action === "upload" && t.absLocal && typeof t.localSize === "number"),
				bump: () => done.upload++,
			},
			{
				dir: "down",
				list: tasks.filter((t) => t.action === "download" && t.absLocal && typeof t.remoteSize === "number"),
				bump: () => done.download++,
			},
		];
		for (const g of groups) {
			if (!g.list.length) continue;
			try {
				const out =
					g.dir === "up"
						? await uploadBatchViaTar({ exec, tasks: g.list, signal })
						: await downloadBatchViaTar({ execStream, tasks: g.list, cwd: plan.cwd, signal });
				if (!out?.rels.length) continue;
				for (const rel of out.rels) handled[g.dir].add(rel);
				batchedCount += out.rels.length;
				bytes += out.bytes;
				for (const t of g.list) {
					if (!handled[g.dir].has(t.rel)) continue;
					g.bump();
					tick(t, "done");
				}
			} catch (err) {
				if (isAbortError(err, signal)) throw err;
			}
		}
		pending = tasks.filter(
			(t) => !(t.action === "upload" && handled.up.has(t.rel)) && !(t.action === "download" && handled.down.has(t.rel)),
		);
	}

	await runPool(
		pending,
		concurrency,
		async (e) => {
			if (signal?.aborted) {
				cancelled = true;
				return;
			}
			try {
				if (e.action === "upload") {
					const n = await uploadFile(sftp, e.absLocal, e.absRemote, {
						mkdirp,
						signal,
						onBytes: (b) => onProgress?.({ phase: "bytes", rel: e.rel, fileBytes: b }),
					});
					bytes += n;
					done.upload++;
				} else if (e.action === "download") {
					const n = await downloadFile(sftp, e.absRemote, e.absLocal, {
						expectedSize: e.remoteSize ?? undefined,
						expectedMtime: e.remoteMtime ?? undefined,
						signal,
						onBytes: (b) => onProgress?.({ phase: "bytes", rel: e.rel, fileBytes: b }),
					});
					bytes += n;
					done.download++;
				} else if (e.action === "trash-remote") {
					await trashRemote(sftp, e.absRemote, e.root.remoteRoot, batch, mkdirp);
					done.trashRemote++;
				} else if (e.action === "trash-local") {
					await trashLocal(plan.cwd, e.absLocal, batch);
					done.trashLocal++;
				}
				tick(e, "done");
			} catch (err) {
				if (isAbortError(err, signal)) {
					cancelled = true;
					return;
				}
				failed.push({ rel: e.rel, action: e.action, error: String(err?.message ?? err) });
				tick(e, "failed");
			}
		},
		{ signal },
	);
	if (signal?.aborted) cancelled = true;

	return { batch, ok: failed.length === 0 && !cancelled, cancelled, failed, done, bytes, total, batched: batchedCount };
}

export async function pruneTrash(cwd, days) {
	if (!days || days <= 0) return { removed: [] };
	const base = path.join(cwd, ".pi", "sftp-trash");
	let names;
	try {
		names = await fs.readdir(base);
	} catch {
		return { removed: [] };
	}
	const cutoff = Date.now() - days * 24 * 3600 * 1000;
	const removed = [];
	for (const name of names) {
		const p = path.join(base, name);
		try {
			const st = await fs.stat(p);
			if (st.mtimeMs < cutoff) {
				await fs.rm(p, { recursive: true, force: true });
				removed.push(name);
			}
		} catch {}
	}
	return { removed };
}
