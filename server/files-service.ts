import { Dirent, existsSync, mkdirSync, readFileSync, statSync, watch } from "node:fs";
import { saveFilePreservingMetadata } from "./file-save.js";
import { isUploadDataTooLong, uploadLimitBytes } from "./payload-limits.js";
import { writeUploadExclusiveSync, writeRemoteUploadExclusive } from "./uploads.js";
import { homedir } from "node:os";
import { resolve, relative, sep, isAbsolute, posix } from "node:path";
import type { ServerMessage, FileEntry, FileSearchResult } from "./protocol.js";
import { pick, type ServerLang } from "./i18n.js";
import { previewKind, looksLikeText, decodeText, hexDump, countLines } from "./text-sniff.js";
import { extractOfficeText, isOfficeFile, OFFICE_MAX_FILE_BYTES } from "./office-parse.js";
import { gitDirOf, isNotRepoError, scmStatus, scmHistory, scmFileDiff, scmCommitDetail } from "./scm.js";
import {
	getGlobalRemoteSshService,
	isRemoteWorkspaceUri,
	parseRemoteWorkspaceUri,
	resolveRemoteWorkspacePath,
} from "./remote-ssh-service.js";

export const IS_WIN32 = process.platform === "win32";

export const MACHINE_ROOT = "@root";

export function desktopDirWire(homeWire: string): string {
	const cands: string[] = [];
	if (process.platform === "linux") {
		try {
			const conf = readFileSync(resolve(homedir(), ".config", "user-dirs.dirs"), "utf8");
			const m = /XDG_DESKTOP_DIR="([^"]+)"/.exec(conf);
			if (m) {
				const dir = m[1].replace(/\$HOME/g, homeWire);
				if (dir.startsWith("/")) cands.push(dir);
			}
		} catch {}
	}
	cands.push(`${homeWire}/Desktop`);
	for (const c of cands) {
		try {
			if (statSync(wireToAbs(c)).isDirectory()) return c;
		} catch {}
	}
	return "";
}

export function isAbsoluteWirePath(p: string): boolean {
	if (p === MACHINE_ROOT || p.startsWith("/") || p.startsWith("\\\\")) return true;
	return IS_WIN32 && /^[A-Za-z]:/.test(p);
}

export function normWirePath(p: string): string {
	if (p.endsWith("/") && p !== "/") return p.replace(/\/+$/, "") || "/";
	return p;
}

export function wireToAbs(wire: string): string {
	const w = normWirePath(wire);
	if (IS_WIN32) {
		const m = /^([A-Za-z]):$/.exec(w);
		if (m) return `${m[1].toUpperCase()}:\\`;
	}
	return resolve(w);
}

export function absoluteParent(wire: string): string | null {
	const s = normWirePath(wire);
	if (s === "" || s === MACHINE_ROOT || s === "/") return null;
	const i = s.lastIndexOf("/");
	if (i < 0) return /^[A-Za-z]:$/.test(s) ? MACHINE_ROOT : null;
	if (i === 0) return "/";
	return s.slice(0, i);
}
export const MAX_PREVIEW_BYTES = 512 * 1024;

export {
	MAX_UPLOAD_BYTES,
	MAX_UPLOAD_BASE64_CHARS,
	WS_MAX_PAYLOAD_BYTES,
	isUploadDataTooLong,
} from "./payload-limits.js";

const IGNORED_ENTRIES = new Set([
	"node_modules",
	".git",
	".svn",
	".hg",
	"dist",
	".next",
	".nuxt",
	".cache",
	".venv",
	"venv",
	"__pycache__",
	"coverage",
	".pi-web",
	".DS_Store",
	"Thumbs.db",
]);

const IGNORED_ENTRIES_WIN = new Set(["node_modules", ".git", ".pi-web", ".DS_Store", "Thumbs.db", "desktop.ini"]);

function ignoredEntries(): Set<string> {
	return IS_WIN32 ? IGNORED_ENTRIES_WIN : IGNORED_ENTRIES;
}

export function workspacePath(root: string, raw: string): { abs: string; rel: string } | null {
	const abs = resolve(root, raw);
	const rawRel = relative(root, abs);
	if (rawRel.startsWith("..") || rawRel.includes(`${sep}..`) || isAbsolute(rawRel)) return null;
	return { abs, rel: rawRel.split(sep).join("/") };
}

async function readDirForUI(
	abs: string,
	rel: string,
): Promise<{ entries: FileEntry[]; truncated: boolean; error?: string; errorCode?: string }> {
	const { join } = await import("node:path");
	const fs = await import("node:fs/promises");
	const ignored = ignoredEntries();
	const MAX = IS_WIN32 ? 2000 : 500;

	let dirents: import("node:fs").Dirent[];
	try {
		dirents = await fs.readdir(abs, { withFileTypes: true });
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		return { entries: [], truncated: false, error: e.message, errorCode: e.code };
	}

	const out: FileEntry[] = [];
	for (const d of dirents) {
		if (ignored.has(d.name)) continue;
		let type: "dir" | "file";
		if (d.isSymbolicLink()) {
			try {
				const st = await fs.stat(join(abs, d.name));
				type = st.isDirectory() ? "dir" : "file";
			} catch {
				type = "file";
			}
		} else {
			type = d.isDirectory() ? "dir" : "file";
		}
		const entryPath = rel === "" ? d.name : rel.endsWith("/") ? `${rel.slice(0, -1)}/${d.name}` : `${rel}/${d.name}`;
		const entry: FileEntry = {
			name: d.name,
			path: entryPath,
			type,
		};
		if (type === "file") entry.kind = previewKind(d.name);
		out.push(entry);
	}

	out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
	const truncated = out.length > MAX;
	if (truncated) out.length = MAX;
	return { entries: out, truncated };
}

async function classifyDirent(d: Dirent, absDir: string): Promise<{ name: string; type: "dir" | "file" }> {
	const fs = await import("node:fs/promises");
	const { join } = await import("node:path");
	let type: "dir" | "file";
	if (d.isSymbolicLink()) {
		try {
			type = (await fs.stat(join(absDir, d.name))).isDirectory() ? "dir" : "file";
		} catch {
			type = "file";
		}
	} else {
		type = d.isDirectory() ? "dir" : "file";
	}
	return { name: d.name, type };
}

export interface FilesHost {
	emit: (msg: ServerMessage) => void;
	isDisposed: () => boolean;
	getCwd: () => string;
	getActiveCwd: () => string;
	getLang?: () => ServerLang;
	getUploadMaxBytes?: () => number;
}

export class FilesService {
	private fsWatcher: ReturnType<typeof watch> | null = null;
	private watchPath: string | null = null;
	private watchTimer: ReturnType<typeof setTimeout> | null = null;
	private recursiveWatcher = false;
	private watchRoot: string | null = null;
	private degradedNoticedFor: string | null = null;
	private gitWatcher: ReturnType<typeof watch> | null = null;
	private gitWatchCwd: string | null = null;
	private gitDirtyTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly host: FilesHost) {}

	private async machineRootEntries(): Promise<FileEntry[]> {
		const fsp = await import("node:fs/promises");
		if (IS_WIN32) {
			const out: FileEntry[] = [];
			for (let c = 65; c <= 90; c++) {
				const drive = `${String.fromCharCode(c)}:`;
				try {
					const st = await fsp.stat(`${drive}\\`);
					if (st.isDirectory()) out.push({ name: drive, path: drive, type: "dir" });
				} catch {}
			}
			return out;
		}
		try {
			await fsp.readdir("/");
		} catch {
			const home = homedir();
			const out: FileEntry[] = [{ name: home, path: home, type: "dir" }];
			try {
				await fsp.readdir("/storage/emulated/0");
				out.push({ name: "/storage/emulated/0", path: "/storage/emulated/0", type: "dir" });
			} catch {}
			return out;
		}
		return [{ name: "/", path: "/", type: "dir" }];
	}

	private lang(): ServerLang {
		return this.host.getLang?.() ?? "en";
	}

	private emitListError(path: string, error: string, code?: string): void {
		if (code === "ENOENT") {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: `目录不存在：${path}`,
				textEn: `Directory not found: ${path}`,
			});
			return;
		}
		if (code === "ENOTDIR") {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: `不是目录：${path}`,
				textEn: `Not a directory: ${path}`,
			});
			return;
		}
		this.host.emit({
			type: "notice",
			level: IS_WIN32 ? "warning" : "error",
			text: `目录不可读：${error}`,
			textEn: `Directory is not readable: ${error}`,
		});
	}

	async listFiles(relPath?: string): Promise<void> {
		const rawCwd = this.host.getCwd();
		if (isRemoteWorkspaceUri(rawCwd)) {
			this.unwatchDir();
			await this.listRemoteFiles(rawCwd, relPath);
			return;
		}
		const { resolve, sep, relative } = await import("node:path");
		const root = resolve(rawCwd);
		let raw = relPath ?? "";
		if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) {
			raw = (raw === "~" ? homedir() : homedir() + raw.slice(1)).split(sep).join("/");
		}

		if (raw === MACHINE_ROOT || raw === MACHINE_ROOT + "/") {
			const entries = await this.machineRootEntries();
			this.host.emit({
				type: "files",
				path: MACHINE_ROOT,
				parent: null,
				entries,
				truncated: false,
				absolute: true,
			});
			return;
		}

		if (isAbsoluteWirePath(raw)) {
			const wire = normWirePath(raw);
			const abs = wireToAbs(wire);
			const { entries, truncated, error, errorCode } = await readDirForUI(abs, wire);
			this.host.emit({
				type: "files",
				path: wire,
				parent: absoluteParent(wire),
				entries,
				truncated,
				absolute: true,
			});
			if (error) this.emitListError(wire, error, errorCode);
			return;
		}

		const target = raw ? resolve(root, raw) : root;
		if (raw === "") {
			try {
				const fsp = await import("node:fs/promises");
				await fsp.mkdir(target, { recursive: true });
			} catch {}
		}
		const rawRel = relative(root, target);
		if (rawRel.startsWith("..") || rawRel.includes(`${sep}..`)) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: `路径超出工作区：${relPath ?? ""}`,
				textEn: `Path is outside the workspace: ${relPath ?? ""}`,
			});
			return;
		}
		const rel = rawRel.split(sep).join("/");
		const { entries, truncated, error, errorCode } = await readDirForUI(target, rel);
		if (error) {
			this.emitListError(rel === "" ? root : rel, error, errorCode);
		} else {
			this.watchDir(target, rel);
		}
		const rootWire = normWirePath(root.split(sep).join("/"));
		this.host.emit({
			type: "files",
			path: rel === "" ? "" : rel,
			parent: rel === "" ? absoluteParent(rootWire) : rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
			entries,
			truncated,
		});
	}

	/**
	 * Global search: recursive filename match across the active workspace.
	 * Best-effort bounded walk — ignored dirs (node_modules/.git/…) are
	 * skipped, unreadable dirs silently passed, and hard caps on results /
	 * visited entries / elapsed time keep big repos responsive. Always answers
	 * with a search_files_result echoing reqId so the client's request never
	 * stalls (ok:false on unexpected failure).
	 */
	async searchFiles(query: string, reqId: number): Promise<void> {
		const activeCwd = this.host.getActiveCwd();
		if (isRemoteWorkspaceUri(activeCwd)) {
			await this.searchRemoteFiles(activeCwd, query, reqId);
			return;
		}
		const { join } = await import("node:path");
		const fsp = await import("node:fs/promises");
		const rawQuery = query.trim();
		if (!rawQuery) {
			this.host.emit({ type: "search_files_result", reqId, ok: true, results: [] });
			return;
		}
		const root = resolve(activeCwd);
		const ignored = ignoredEntries();
		const MAX_RESULTS = 50;
		const MAX_VISITED = 20000;
		const MAX_MS = 4000;
		const start = Date.now();
		const results: FileSearchResult[] = [];
		let visited = 0;
		let truncated = false;

		const normQuery = rawQuery.replace(/\\/g, "/");
		const q = normQuery.toLowerCase();
		try {
			if (
				isAbsoluteWirePath(normQuery) ||
				(normQuery.startsWith("~") && (normQuery === "~" || normQuery.startsWith("~/")))
			) {
				const { homedir } = await import("node:os");
				const home = homedir();
				const targetAbs = normQuery.startsWith("~")
					? normQuery === "~"
						? home
						: join(home, normQuery.slice(2))
					: wireToAbs(normQuery);
				const st = await fsp.stat(targetAbs).catch(() => null);
				if (st) {
					const wp = workspacePath(root, targetAbs);
					const wirePath = wp ? wp.rel : targetAbs.split(sep).join("/");
					const baseName = targetAbs.split(/[\\/]/).pop() || wirePath;
					results.push({
						path: wirePath,
						name: baseName,
						type: st.isDirectory() ? "dir" : "file",
					});
				}
			} else {
				const directWp = workspacePath(root, normQuery);
				if (directWp) {
					const st = await fsp.stat(directWp.abs).catch(() => null);
					if (st) {
						const baseName = directWp.abs.split(/[\\/]/).pop() || directWp.rel;
						results.push({
							path: directWp.rel,
							name: baseName,
							type: st.isDirectory() ? "dir" : "file",
						});
					}
				}
			}
		} catch {}

		const budgetLeft = () => results.length < MAX_RESULTS && visited < MAX_VISITED && Date.now() - start < MAX_MS;
		const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
			if (!budgetLeft() || depth > 24) {
				truncated = true;
				return;
			}
			let dirents: import("node:fs").Dirent[];
			try {
				dirents = await fsp.readdir(abs, { withFileTypes: true });
			} catch {
				return;
			}
			for (const d of dirents) {
				visited++;
				if (!budgetLeft()) {
					truncated = true;
					break;
				}
				if (ignored.has(d.name)) continue;
				const childRel = rel ? `${rel}/${d.name}` : d.name;
				let isDir = d.isDirectory();
				if (d.isSymbolicLink()) {
					try {
						isDir = (await fsp.stat(join(abs, d.name))).isDirectory();
					} catch {
						isDir = false;
					}
				}
				const childRelLower = childRel.toLowerCase();
				const nameLower = d.name.toLowerCase();
				if ((nameLower.includes(q) || childRelLower.includes(q)) && !results.some((r) => r.path === childRel)) {
					results.push({
						path: childRel,
						name: d.name,
						type: isDir ? "dir" : "file",
					});
				}
				if (isDir) {
					await walk(join(abs, d.name), childRel, depth + 1);
				}
			}
		};
		try {
			await walk(root, "", 0);
			this.host.emit({
				type: "search_files_result",
				reqId,
				ok: true,
				results,
				...(truncated ? { truncated: true } : {}),
			});
		} catch {
			this.host.emit({ type: "search_files_result", reqId, ok: false, results: [] });
		}
	}

	async scmQuery(
		kind: "status" | "history" | "filediff" | "commit",
		reqId: number,
		arg?: { path?: string; hash?: string },
	): Promise<void> {
		const cwd = this.host.getActiveCwd();
		const isRemote = isRemoteWorkspaceUri(cwd);
		if (kind === "status" && !isRemote) this.watchGitDir(cwd);
		try {
			if (kind === "status") {
				const data = await scmStatus(cwd, () => this.lang());
				this.host.emit({ type: "scm_data", reqId, kind, ok: true, ...data });
				return;
			}
			if (kind === "history") {
				const history = await scmHistory(cwd, () => this.lang());
				this.host.emit({ type: "scm_data", reqId, kind, ok: true, history });
				return;
			}
			if (kind === "filediff" && arg?.path) {
				if (isRemote) {
					const parsed = parseRemoteWorkspaceUri(cwd);
					const resolved = parsed ? resolveRemoteWorkspacePath(parsed.remotePath, arg.path) : null;
					if (!resolved || !resolved.rel) {
						throw new Error(
							pick(this.lang(), "路径超出工作区", "Path is outside the workspace", "files.path.outside.workspace"),
						);
					}
				} else {
					const { resolve, relative } = await import("node:path");
					const rel = relative(resolve(cwd), resolve(cwd, arg.path));
					if (rel.startsWith("..") || rel === "")
						throw new Error(
							pick(this.lang(), "路径超出工作区", "Path is outside the workspace", "files.path.outside.workspace"),
						);
				}
				const { staged, worktree } = await scmFileDiff(cwd, arg.path, () => this.lang());
				this.host.emit({
					type: "scm_data",
					reqId,
					kind,
					ok: true,
					stagedText: staged,
					worktreeText: worktree,
				});
				return;
			}
			if (kind === "commit" && arg?.hash && /^[0-9a-f]{7,40}$/i.test(arg.hash)) {
				const text = await scmCommitDetail(cwd, arg.hash, () => this.lang());
				this.host.emit({ type: "scm_data", reqId, kind, ok: true, text });
				return;
			}
			throw new Error(
				pick(this.lang(), "无效的 scm 查询参数", "Invalid scm query arguments", "files.scm.invalid.args"),
			);
		} catch (err) {
			if (isNotRepoError(err)) {
				this.host.emit({
					type: "scm_data",
					reqId,
					kind,
					ok: true,
					notRepo: true,
					branch: "",
					detached: false,
					upstream: null,
					ahead: 0,
					behind: 0,
					upstreamGone: false,
					files: [],
					branches: [],
					stats: {},
					history: [],
				});
				this.unwatchGit();
				return;
			}
			this.host.emit({
				type: "scm_data",
				reqId,
				kind,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async watchGitDir(cwd: string): Promise<void> {
		if (this.gitWatchCwd === cwd && this.gitWatcher) return;
		this.unwatchGit();
		this.gitWatchCwd = cwd;
		try {
			const gitDir = await gitDirOf(cwd);
			if (!gitDir) return;
			this.gitWatcher = watch(gitDir, { persistent: false }, () => {
				if (this.host.isDisposed() || this.gitDirtyTimer) return;
				this.gitDirtyTimer = setTimeout(() => {
					this.gitDirtyTimer = null;
					this.host.emit({ type: "scm_changed" });
				}, 600);
			});
			this.gitWatcher.on("error", () => {
				this.unwatchGit();
			});
		} catch {
			this.unwatchGit();
		}
	}

	unwatchGit(): void {
		if (this.gitWatcher) {
			try {
				this.gitWatcher.close();
			} catch {}
		}
		this.gitWatcher = null;
		this.gitWatchCwd = null;
		if (this.gitDirtyTimer) {
			clearTimeout(this.gitDirtyTimer);
			this.gitDirtyTimer = null;
		}
	}

	private watchDir(absPath: string, rel: string): void {
		if (this.host.isDisposed()) return;
		if (process.platform === "win32" || process.platform === "darwin") {
			const root = resolve(this.host.getCwd());
			if (this.recursiveWatcher) {
				if (this.watchRoot === root) {
					this.watchPath = rel;
					return;
				}
				this.unwatchDir();
			}
			try {
				const w = watch(root, { persistent: false, recursive: true }, (_event, filename) => {
					if (filename) {
						const f = String(filename).split("\\").join("/");
						const slash = f.indexOf("/");
						const top = slash === -1 ? f : f.slice(0, slash);
						if (top === "node_modules" || top === ".git") return;
					}
					if (this.watchTimer) return;
					this.watchTimer = setTimeout(() => {
						this.watchTimer = null;
						this.host.emit({
							type: "file_changed",
							path: this.watchPath ?? "",
						});
					}, 400);
				});
				w.on("error", () => {
					this.noticeDegraded(root);
					this.unwatchDir();
				});
				this.fsWatcher = w;
				this.watchRoot = root;
				this.recursiveWatcher = true;
				this.watchPath = rel;
				return;
			} catch {
				this.fsWatcher = null;
				this.recursiveWatcher = false;
				this.watchRoot = null;
				this.noticeDegraded(root);
			}
		}
		if (!this.recursiveWatcher && this.watchPath === rel && this.fsWatcher) return;
		this.unwatchDir();
		this.watchPath = rel;
		try {
			this.fsWatcher = watch(absPath, { persistent: false }, () => {
				if (this.watchTimer) return;
				this.watchTimer = setTimeout(() => {
					this.watchTimer = null;
					this.host.emit({ type: "file_changed", path: this.watchPath ?? "" });
				}, 400);
			});
			this.fsWatcher.on("error", () => {
				this.unwatchDir();
			});
		} catch {
			this.fsWatcher = null;
			this.watchPath = null;
			this.noticeDegraded(absPath);
		}
	}

	private noticeDegraded(root: string): void {
		if (this.degradedNoticedFor === root) return;
		this.degradedNoticedFor = root;
		this.host.emit({
			type: "notice",
			level: "info",
			text: "此目录不支持实时文件监听（网络盘/受限目录），文件面板已改为每 10 秒自动刷新。",
			textEn:
				"Live file watching is not supported for this directory (network/restricted); the file panel now refreshes every 10s",
		});
	}

	unwatchDir(): void {
		if (this.watchTimer) {
			clearTimeout(this.watchTimer);
			this.watchTimer = null;
		}
		if (this.fsWatcher) {
			try {
				this.fsWatcher.close();
			} catch {}
			this.fsWatcher = null;
		}
		this.recursiveWatcher = false;
		this.watchRoot = null;
		this.watchPath = null;
	}

	async readFile(relPath: string): Promise<void> {
		const root = this.host.getCwd();
		if (isRemoteWorkspaceUri(root)) {
			await this.readRemoteFile(root, relPath);
			return;
		}
		try {
			const fs = await import("node:fs/promises");
			const absWire = isAbsoluteWirePath(relPath);
			let abs: string;
			let rel: string;
			if (absWire) {
				abs = wireToAbs(relPath);
				rel = abs.split(sep).join("/");
			} else {
				const w = workspacePath(resolve(root), relPath);
				if (!w) {
					this.host.emit({
						type: "notice",
						level: "warning",
						text: `路径超出工作区：${relPath}`,
						textEn: `Path is outside the workspace: ${relPath}`,
					});
					return;
				}
				abs = w.abs;
				rel = w.rel;
			}
			const stat = await fs.stat(abs);
			if (!stat.isFile()) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `不是文件：${relPath}`,
					textEn: `Not a file: ${relPath}`,
				});
				return;
			}
			const name = relPath.split(/[\\/]/).pop() ?? relPath;
			if (isOfficeFile(name) && stat.size <= OFFICE_MAX_FILE_BYTES) {
				try {
					const data = await fs.readFile(abs);
					const office = extractOfficeText(name, data);
					if (office) {
						this.host.emit({
							type: "file_content",
							path: rel,
							name,
							text: office.text,
							truncated: office.truncated || data.length < stat.size,
							binary: false,
							kind: "text",
							lines: countLines(Buffer.from(office.text)),
							size: stat.size,
							slides: office.slides,
						});
						return;
					}
				} catch {}
			}
			const kind = previewKind(name);
			if (kind === "image" || kind === "video" || kind === "audio") {
				this.host.emit({
					type: "file_content",
					path: rel,
					name,
					text: "",
					truncated: false,
					binary: true,
					kind,
					lines: 0,
					size: stat.size,
				});
				return;
			}
			const handle = await fs.open(abs, "r");
			try {
				const buf = Buffer.alloc(Math.min(stat.size, MAX_PREVIEW_BYTES));
				const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
				const data = buf.subarray(0, bytesRead);
				if (looksLikeText(data)) {
					this.host.emit({
						type: "file_content",
						path: rel,
						name,
						text: decodeText(data),
						truncated: bytesRead < stat.size,
						binary: false,
						kind: "text",
						lines: countLines(data),
						size: stat.size,
					});
				} else {
					this.host.emit({
						type: "file_content",
						path: rel,
						name,
						text: hexDump(data),
						truncated: bytesRead < stat.size,
						binary: true,
						kind: kind === "text" ? "text" : "none",
						lines: 0,
						size: stat.size,
					});
				}
			} finally {
				await handle.close();
			}
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `读取文件失败：${(err as Error).message}`,
				textEn: `Failed to read file: ${(err as Error).message}`,
			});
		}
	}

	async writeFile(relPath: string, text: string): Promise<void> {
		const root = this.host.getCwd();
		if (isRemoteWorkspaceUri(root)) {
			await this.writeRemoteFile(root, relPath, text);
			return;
		}
		try {
			const absWire = isAbsoluteWirePath(relPath);
			let abs: string;
			let rel: string;
			if (absWire) {
				abs = wireToAbs(relPath);
				rel = abs.split(sep).join("/");
			} else {
				const w = workspacePath(resolve(root), relPath);
				if (!w) {
					this.host.emit({
						type: "notice",
						level: "warning",
						text: `路径超出工作区：${relPath}`,
						textEn: `Path is outside the workspace: ${relPath}`,
					});
					return;
				}
				abs = w.abs;
				rel = w.rel;
			}
			if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: "文件内容过大，无法保存（上限 2MB）",
					textEn: "File too large to save (2MB max)",
				});
				return;
			}
			const stat = statSync(abs);
			if (!stat.isFile()) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `不是文件：${relPath}`,
					textEn: `Not a file: ${relPath}`,
				});
				return;
			}
			await saveFilePreservingMetadata(abs, text);
			this.host.emit({
				type: "notice",
				level: "info",
				text: `已保存：${rel}`,
				textEn: `Saved: ${rel}`,
			});
			await this.readFile(rel);
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `保存文件失败：${(err as Error).message}`,
				textEn: `Failed to save file: ${(err as Error).message}`,
			});
		}
	}

	async uploadFile(relDir: string, name: string, data: string, uploadId?: string): Promise<void> {
		const root = this.host.getCwd();
		if (isRemoteWorkspaceUri(root)) {
			await this.uploadRemoteFile(root, relDir, name, data, uploadId);
			return;
		}
		const emitErr = (text: string, textEn?: string) => {
			this.host.emit({ type: "notice", level: "error", text, textEn });
			if (typeof uploadId === "string")
				this.host.emit({ type: "file_upload_result", uploadId, ok: false, error: textEn ?? text });
		};
		try {
			const absDir = relDir ? isAbsoluteWirePath(relDir) : false;
			let wp: { abs: string; rel: string } | null;
			if (relDir && !absDir) {
				wp = workspacePath(resolve(root), relDir);
				if (!wp) {
					emitErr(`路径超出工作区：${relDir}`, `Path outside workspace: ${relDir}`);
					return;
				}
			} else if (relDir) {
				wp = { abs: wireToAbs(relDir), rel: wireToAbs(relDir).split(sep).join("/") };
			} else {
				wp = { abs: root, rel: "" };
			}
			const safe = this.sanitizeName(name);
			if (!safe) {
				emitErr(`文件名不合法：${name}`, `Invalid file name: ${name}`);
				return;
			}
			const abs = resolve(wp.abs, safe);
			let uploadRel: string;
			if (absDir) {
				uploadRel = abs.split(sep).join("/");
			} else {
				const rawRel = relative(root, abs);
				if (rawRel.startsWith("..") || rawRel.includes(`${sep}..`)) {
					emitErr(`文件名不合法：${name}`, `Invalid file name: ${name}`);
					return;
				}
				uploadRel = rawRel.split(sep).join("/");
			}
			const maxBytes = this.host.getUploadMaxBytes?.() ?? uploadLimitBytes({}, "workspace");
			if (isUploadDataTooLong(data.length, maxBytes)) {
				emitErr(
					`文件过大：${name}（上限 ${Math.round(maxBytes / 1024 / 1024)}MB）`,
					`File too large: ${name} (max ${Math.round(maxBytes / 1024 / 1024)}MB)`,
				);
				return;
			}
			const buf = Buffer.from(data, "base64");
			if (buf.length === 0) {
				emitErr(`空文件：${name}`, `Empty file: ${name}`);
				return;
			}
			if (buf.length > maxBytes) {
				emitErr(
					`文件过大：${name}（上限 ${Math.round(maxBytes / 1024 / 1024)}MB）`,
					`File too large: ${name} (max ${Math.round(maxBytes / 1024 / 1024)}MB)`,
				);
				return;
			}
			mkdirSync(wp.abs, { recursive: true });
			if (existsSync(abs)) {
				emitErr(`已存在：${uploadRel}`, `Already exists: ${uploadRel}`);
				return;
			}
			writeUploadExclusiveSync(abs, buf);
			this.host.emit({
				type: "notice",
				level: "info",
				text: `已上传：${uploadRel}`,
				textEn: `Uploaded: ${uploadRel}`,
			});
			this.host.emit({
				type: "file_changed",
				path: wp.rel,
			});
			if (typeof uploadId === "string") this.host.emit({ type: "file_upload_result", uploadId, ok: true });
		} catch (err) {
			emitErr(`上传文件失败：${(err as Error).message}`, `Upload failed: ${(err as Error).message}`);
		}
	}

	async makeDir(input: string): Promise<string | null> {
		const rawCwd = this.host.getCwd();
		if (isRemoteWorkspaceUri(rawCwd) || isRemoteWorkspaceUri(input)) {
			try {
				const sshSvc = getGlobalRemoteSshService();
				if (!sshSvc) throw new Error("Remote SSH service not initialized");
				const uri = isRemoteWorkspaceUri(input) ? input.trim() : rawCwd;
				const parsed = parseRemoteWorkspaceUri(uri);
				if (!parsed) throw new Error("Invalid remote workspace URI");
				const targetAbs = isRemoteWorkspaceUri(input)
					? parsed.remotePath
					: input.trim().startsWith("/")
						? posix.normalize(input.trim())
						: posix.resolve(parsed.remotePath, input.trim());
				await sshSvc.sftpMkdirRecursive(uri, targetAbs);
				this.host.emit({
					type: "notice",
					level: "info",
					text: `已创建远程文件夹：${targetAbs}`,
					textEn: `Remote folder created: ${targetAbs}`,
				});
				return isRemoteWorkspaceUri(input) ? uri : targetAbs;
			} catch (err) {
				this.host.emit({
					type: "notice",
					level: "error",
					text: `创建远程文件夹失败：${(err as Error).message}`,
					textEn: `Failed to create remote folder: ${(err as Error).message}`,
				});
				return null;
			}
		}
		try {
			const fs = await import("node:fs/promises");
			const { resolve, sep, isAbsolute } = await import("node:path");
			const { homedir } = await import("node:os");
			const home = homedir();
			let expanded = input.trim();
			if (!expanded) throw new Error(pick(this.lang(), "路径为空", "Empty path", "files.path.empty"));
			if (expanded === "~" || expanded === "~\\") {
				expanded = home;
			} else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
				expanded = home + sep + expanded.slice(2);
			} else if (!isAbsolute(expanded)) {
				expanded = resolve(this.host.getCwd(), expanded);
			}
			const abs = resolve(expanded);
			await fs.mkdir(abs, { recursive: true });
			this.host.emit({
				type: "notice",
				level: "info",
				text: `已创建文件夹：${abs}`,
				textEn: `Folder created: ${abs}`,
			});
			return abs;
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `创建文件夹失败：${(err as Error).message}`,
				textEn: `Failed to create folder: ${(err as Error).message}`,
			});
			return null;
		}
	}

	private resolveOpTarget(raw: string): { abs: string } | null {
		const wire = normWirePath(raw.trim());
		if (!wire || wire === MACHINE_ROOT) return null;
		if (isAbsoluteWirePath(wire)) return { abs: wireToAbs(wire) };
		const w = workspacePath(resolve(this.host.getCwd()), wire);
		return w ? { abs: w.abs } : null;
	}

	private sanitizeName(name: string): string | null {
		const base = name.split(/[\\/]/).pop() ?? "";
		const safe = base
			.replace(/[/:*?"<>|\x00-\x1f]/g, "_")
			.trim()
			.slice(0, 200);
		if (!safe || safe === "." || safe === ".." || /[. ]$/.test(safe)) return null;
		if (IS_WIN32 && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(safe)) return null;
		return safe;
	}

	private wireParent(wire: string): string | null {
		const w = normWirePath(wire.trim());
		if (!w || w === MACHINE_ROOT || w === "/" || /^[A-Za-z]:$/.test(w)) return null;
		const i = w.lastIndexOf("/");
		if (i < 0) return "";
		if (i === 0) return "/";
		return w.slice(0, i);
	}

	private async resolveOpDir(dir: string): Promise<{ abs: string; wire: string } | null> {
		const fsp = await import("node:fs/promises");
		if (!dir.trim()) {
			const rootAbs = resolve(this.host.getCwd());
			try {
				await fsp.mkdir(rootAbs, { recursive: true });
			} catch {}
			return { abs: rootAbs, wire: "" };
		}
		const t = this.resolveOpTarget(dir);
		if (!t) return null;
		const st = await fsp.stat(t.abs).catch(() => null);
		if (!st?.isDirectory()) return null;
		return { abs: t.abs, wire: normWirePath(dir.trim()) };
	}

	async createEntry(dir: string, name: string, kind: "file" | "dir"): Promise<void> {
		const rawCwd = this.host.getCwd();
		if (isRemoteWorkspaceUri(rawCwd)) {
			await this.createRemoteEntry(rawCwd, dir, name, kind);
			return;
		}
		const err = (text: string, textEn?: string) => this.host.emit({ type: "notice", level: "error", text, textEn });
		try {
			const fsp = await import("node:fs/promises");
			const { join } = await import("node:path");
			const safe = this.sanitizeName(name);
			if (!safe) {
				err(`文件名不合法：${name}`, `Invalid name: ${name}`);
				return;
			}
			const target = await this.resolveOpDir(dir);
			if (!target) {
				err(`目录不存在或超出工作区：${dir || "根目录"}`, `Directory not found: ${dir || "root"}`);
				return;
			}
			const abs = join(target.abs, safe);
			if (await fsp.stat(abs).catch(() => null)) {
				err(`已存在：${safe}`, `Already exists: ${safe}`);
				return;
			}
			if (kind === "dir") await fsp.mkdir(abs, { recursive: true });
			else await fsp.writeFile(abs, "");
			this.host.emit({
				type: "notice",
				level: "info",
				text: kind === "dir" ? `已新建文件夹：${safe}` : `已新建文件：${safe}`,
				textEn: kind === "dir" ? `Folder created: ${safe}` : `File created: ${safe}`,
			});
			this.host.emit({ type: "file_changed", path: target.wire });
		} catch (e) {
			err(`新建失败：${(e as Error).message}`, `Create failed: ${(e as Error).message}`);
		}
	}

	async renameEntry(path: string, newName: string): Promise<void> {
		const rawCwd = this.host.getCwd();
		if (isRemoteWorkspaceUri(rawCwd)) {
			await this.renameRemoteEntry(rawCwd, path, newName);
			return;
		}
		const err = (text: string, textEn?: string) => this.host.emit({ type: "notice", level: "error", text, textEn });
		try {
			const fsp = await import("node:fs/promises");
			const { join, dirname } = await import("node:path");
			const t = this.resolveOpTarget(path);
			const parent = this.wireParent(path);
			if (!t || parent === null) {
				err(`此处不可重命名：${path}`, `Cannot rename here: ${path}`);
				return;
			}
			const safe = this.sanitizeName(newName);
			if (!safe) {
				err(`新名称不合法：${newName}`, `Invalid name: ${newName}`);
				return;
			}
			const dest = join(dirname(t.abs), safe);
			if (await fsp.stat(dest).catch(() => null)) {
				err(`已存在：${safe}`, `Already exists: ${safe}`);
				return;
			}
			await fsp.rename(t.abs, dest);
			this.host.emit({
				type: "notice",
				level: "info",
				text: `已重命名为：${safe}`,
				textEn: `Renamed to: ${safe}`,
			});
			this.host.emit({ type: "file_changed", path: parent });
		} catch (e) {
			err(`重命名失败：${(e as Error).message}`, `Rename failed: ${(e as Error).message}`);
		}
	}

	async deleteEntry(path: string): Promise<void> {
		const rawCwd = this.host.getCwd();
		if (isRemoteWorkspaceUri(rawCwd)) {
			await this.deleteRemoteEntry(rawCwd, path);
			return;
		}
		const err = (text: string, textEn?: string) => this.host.emit({ type: "notice", level: "error", text, textEn });
		try {
			const fsp = await import("node:fs/promises");
			const t = this.resolveOpTarget(path);
			const parent = this.wireParent(path);
			if (!t || parent === null) {
				err(`此处不可删除：${path}`, `Cannot delete here: ${path}`);
				return;
			}
			await fsp.rm(t.abs, { recursive: true, force: true });
			this.host.emit({
				type: "notice",
				level: "info",
				text: `已删除：${path.split(/[\\/]/).pop() ?? path}`,
				textEn: `Deleted: ${path.split(/[\\/]/).pop() ?? path}`,
			});
			this.host.emit({ type: "file_changed", path: parent });
		} catch (e) {
			err(`删除失败：${(e as Error).message}`, `Delete failed: ${(e as Error).message}`);
		}
	}

	async copyEntry(src: string, destDir: string, move?: boolean): Promise<void> {
		const rawCwd = this.host.getCwd();
		if (isRemoteWorkspaceUri(rawCwd)) {
			await this.copyRemoteEntry(rawCwd, src, destDir, move);
			return;
		}
		const err = (text: string, textEn?: string) => this.host.emit({ type: "notice", level: "error", text, textEn });
		try {
			const fsp = await import("node:fs/promises");
			const { join, basename, sep } = await import("node:path");
			const s = this.resolveOpTarget(src);
			const srcParent = this.wireParent(src);
			if (!s || srcParent === null) {
				err(`此处不可${move ? "移动" : "复制"}：${src}`, `Cannot ${move ? "move" : "copy"}: ${src}`);
				return;
			}
			const target = await this.resolveOpDir(destDir);
			if (!target) {
				err(`目标目录不存在：${destDir || "根目录"}`, `Target directory not found: ${destDir || "root"}`);
				return;
			}
			if (target.abs === s.abs || target.abs.startsWith(s.abs + sep)) {
				err("不可复制/移动到自身或子目录", "Cannot copy/move into itself");
				return;
			}
			const base = basename(s.abs);
			let dest = join(target.abs, base);
			if (!move) dest = await this.dedupeCopyDest(dest);
			else if (await fsp.stat(dest).catch(() => null)) {
				err(`目标已存在：${base}`, `Already exists at target: ${base}`);
				return;
			}
			const verb = move ? ["已移动", "Moved"] : ["已复制", "Copied"];
			if (move) {
				try {
					await fsp.rename(s.abs, dest);
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
					await fsp.cp(s.abs, dest, { recursive: true, force: false });
					await fsp.rm(s.abs, { recursive: true, force: true });
				}
			} else {
				await fsp.cp(s.abs, dest, { recursive: true, force: false });
			}
			this.host.emit({
				type: "notice",
				level: "info",
				text: `${verb[0]}：${base}`,
				textEn: `${verb[1]}: ${base}`,
			});
			this.host.emit({ type: "file_changed", path: target.wire });
			if (move && target.wire !== srcParent) this.host.emit({ type: "file_changed", path: srcParent });
		} catch (e) {
			err(
				`${move ? "移动" : "复制"}失败：${(e as Error).message}`,
				`${move ? "Move" : "Copy"} failed: ${(e as Error).message}`,
			);
		}
	}

	private async dedupeCopyDest(dest: string): Promise<string> {
		const fsp = await import("node:fs/promises");
		const { join, dirname, basename, extname } = await import("node:path");
		if (!(await fsp.stat(dest).catch(() => null))) return dest;
		const dir = dirname(dest);
		const base = basename(dest);
		const ext = extname(base);
		const stem = ext ? base.slice(0, -ext.length) : base;
		for (let i = 1; i < 100; i++) {
			const cand = join(dir, `${stem} copy${i === 1 ? "" : ` ${i}`}${ext}`);
			if (!(await fsp.stat(cand).catch(() => null))) return cand;
		}
		return join(dir, `${stem} copy ${Date.now()}${ext}`);
	}
	private async spawnDetached(cmd: string, args: string[], okText: string, okTextEn: string): Promise<void> {
		const fail = (detail: string) =>
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "无法打开系统文件管理：" + detail + "（远端/无桌面主机不支持）",
				textEn: "Cannot open system file manager: " + detail + " (unsupported on remote/headless hosts)",
			});
		try {
			const { spawn } = await import("node:child_process");
			const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
			if (typeof child.unref === "function") child.unref();
			const launched = await new Promise<boolean>((resolve) => {
				let done = false;
				const settle = (v: boolean) => {
					if (!done) {
						done = true;
						resolve(v);
					}
				};
				child.on("spawn", () => settle(true));
				child.on("error", () => settle(false));
				setTimeout(() => settle(true), 3000);
			});
			if (!launched) {
				fail(cmd);
				return;
			}
			this.host.emit({ type: "notice", level: "info", text: okText, textEn: okTextEn });
		} catch (e) {
			fail((e as Error).message);
		}
	}

	async revealEntry(path: string): Promise<void> {
		const err = (text: string, textEn?: string) => this.host.emit({ type: "notice", level: "warning", text, textEn });
		try {
			const fsp = await import("node:fs/promises");
			const { dirname } = await import("node:path");
			const trimmed = path.trim();
			const t = !trimmed ? { abs: resolve(this.host.getCwd()) } : this.resolveOpTarget(trimmed);
			if (!t) {
				err("此处不可定位：" + path, "Cannot reveal here: " + path);
				return;
			}
			const abs = t.abs;
			const st = await fsp.stat(abs).catch(() => null);
			if (!st) {
				err("文件不存在：" + path, "Not found: " + path);
				return;
			}
			const isDir = st.isDirectory();
			const segs = trimmed.split("/");
			const base = !trimmed ? t.abs.split(/[\\/]/).pop() || t.abs : (segs[segs.length - 1] ?? trimmed);
			if (process.platform === "win32") {
				await this.spawnDetached(
					"explorer.exe",
					isDir ? ["/n,", abs] : ["/select,", abs],
					"已在资源管理器中显示：" + base,
					"Revealed in File Explorer: " + base,
				);
			} else if (process.platform === "darwin") {
				await this.spawnDetached(
					"open",
					isDir ? [abs] : ["-R", abs],
					"已在访达中显示：" + base,
					"Revealed in Finder: " + base,
				);
			} else {
				await this.spawnDetached(
					"xdg-open",
					[isDir ? abs : dirname(abs)],
					"已打开所在目录：" + base,
					"Opened containing folder: " + base,
				);
			}
		} catch (e) {
			err("定位失败：" + (e as Error).message, "Reveal failed: " + (e as Error).message);
		}
	}

	async openDefaultEntry(path: string): Promise<void> {
		const err = (text: string, textEn?: string) => this.host.emit({ type: "notice", level: "warning", text, textEn });
		try {
			const fsp = await import("node:fs/promises");
			const t = this.resolveOpTarget(path);
			if (!t) {
				err("此处不可打开：" + path, "Cannot open here: " + path);
				return;
			}
			const st = await fsp.stat(t.abs).catch(() => null);
			if (!st) {
				err("文件不存在：" + path, "Not found: " + path);
				return;
			}
			if (!st.isFile()) {
				err("请选择文件（目录请用“在资源管理器中显示”）", 'Please select a file (use "Reveal" for folders)');
				return;
			}
			const segs = path.split("/");
			const base = segs[segs.length - 1] ?? path;
			const cmd = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
			await this.spawnDetached(cmd, [t.abs], "已用默认应用打开：" + base, "Opened with default app: " + base);
		} catch (e) {
			err("打开失败：" + (e as Error).message, "Open failed: " + (e as Error).message);
		}
	}

	async completePath(input: string): Promise<void> {
		const empty = () => this.host.emit({ type: "path_completions", completions: [] });
		const cwd = this.host.getCwd();
		if (isRemoteWorkspaceUri(input) || (isRemoteWorkspaceUri(cwd) && !isAbsoluteWirePath(input.trim()))) {
			await this.completeRemotePath(isRemoteWorkspaceUri(input) ? input.trim() : cwd, input.trim());
			return;
		}
		try {
			const fs = await import("node:fs/promises");
			const { resolve, sep, isAbsolute } = await import("node:path");
			const { homedir } = await import("node:os");
			const home = homedir();
			const isWin = IS_WIN32;
			const rawInput = input.trim();
			if (rawInput === "") {
				empty();
				return;
			}

			if (rawInput === MACHINE_ROOT || rawInput === MACHINE_ROOT + "/") {
				this.host.emit({ type: "path_completions", completions: await this.machineRootEntries() });
				return;
			}

			if (isWin && /^[A-Za-z]:?$/.test(rawInput)) {
				const letter = rawInput[0].toUpperCase();
				const drive = `${letter}:`;
				let st: { isDirectory(): boolean };
				try {
					st = await fs.stat(`${drive}\\`);
				} catch {
					empty();
					return;
				}
				if (!st.isDirectory()) {
					empty();
					return;
				}
				if (rawInput.length === 2) {
					const dirents = await fs.readdir(`${drive}\\`, { withFileTypes: true }).catch(() => null);
					if (!dirents) {
						empty();
						return;
					}
					const items = (
						await Promise.all(
							dirents.filter((d) => !ignoredEntries().has(d.name)).map((d) => classifyDirent(d, `${drive}\\`)),
						)
					)
						.map((e) => ({ ...e, path: `${drive}/${e.name}` }))
						.sort((a, b) => {
							const aHidden = a.name.startsWith(".");
							const bHidden = b.name.startsWith(".");
							if (aHidden !== bHidden) return aHidden ? 1 : -1;
							if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
							return a.name.localeCompare(b.name);
						})
						.slice(0, 100);
					this.host.emit({ type: "path_completions", completions: items });
					return;
				}
				this.host.emit({ type: "path_completions", completions: [{ name: drive, path: drive, type: "dir" }] });
				return;
			}

			let expanded = rawInput;
			if (expanded === "~" || expanded === "~\\") {
				expanded = home;
			} else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
				expanded = home + sep + expanded.slice(2);
			} else if (!isAbsolute(expanded)) {
				expanded = resolve(cwd, expanded);
			}

			const lastSlash = Math.max(expanded.lastIndexOf("/"), expanded.lastIndexOf("\\"));
			const dirPart = lastSlash >= 0 ? expanded.slice(0, lastSlash + 1) : "";
			const prefix = lastSlash >= 0 ? expanded.slice(lastSlash + 1) : expanded;

			const dirents = await fs.readdir(dirPart, { withFileTypes: true }).catch(() => null);
			if (!dirents) {
				empty();
				return;
			}
			const { join } = await import("node:path");
			const completions = (
				await Promise.all(
					dirents
						.filter((d) => d.name.startsWith(prefix) && !ignoredEntries().has(d.name))
						.map((d) => classifyDirent(d, dirPart)),
				)
			)
				.map((e) => ({
					...e,
					path: IS_WIN32 ? join(dirPart, e.name).split(sep).join("/") : dirPart + e.name,
				}))
				.sort((a, b) => {
					const aHidden = a.name.startsWith(".");
					const bHidden = b.name.startsWith(".");
					if (aHidden !== bHidden) return aHidden ? 1 : -1;
					if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
					return a.name.localeCompare(b.name);
				})
				.slice(0, 100);
			this.host.emit({ type: "path_completions", completions });
		} catch {
			empty();
		}
	}

	private resolveRemoteTarget(
		rawCwd: string,
		p: string,
		allowRoot: boolean = false,
	): { abs: string; rel: string; parentRel: string; absolute: boolean } | null {
		const parsed = parseRemoteWorkspaceUri(rawCwd);
		if (!parsed) return null;
		let trimmed = (p || "").trim();
		if (trimmed === MACHINE_ROOT || trimmed === MACHINE_ROOT + "/") return null;
		if (isRemoteWorkspaceUri(trimmed)) {
			const parsedUri = parseRemoteWorkspaceUri(trimmed);
			if (parsedUri) {
				trimmed = parsedUri.remotePath;
			}
		}
		if (!trimmed || trimmed === ".") {
			if (!allowRoot) return null;
			return { abs: parsed.remotePath, rel: "", parentRel: "", absolute: false };
		}
		if (trimmed.startsWith("/")) {
			const abs = posix.normalize(trimmed);
			if (abs === "/" && !allowRoot) return null;
			const parentRel = abs === "/" ? "" : posix.dirname(abs);
			return { abs, rel: abs, parentRel, absolute: true };
		}
		const w = resolveRemoteWorkspacePath(parsed.remotePath, trimmed);
		if (!w || (!allowRoot && w.rel === "")) return null;
		const parentRel = w.rel.includes("/") ? w.rel.slice(0, w.rel.lastIndexOf("/")) : "";
		return { abs: w.abs, rel: w.rel, parentRel, absolute: false };
	}

	private async listRemoteFiles(rawCwd: string, relPath?: string): Promise<void> {
		const sshSvc = getGlobalRemoteSshService();
		const parsed = parseRemoteWorkspaceUri(rawCwd);
		if (!sshSvc || !parsed) {
			this.emitListError(rawCwd, "Remote SSH service is not available");
			return;
		}
		const raw = (relPath ?? "").trim();
		if (raw === MACHINE_ROOT || raw === MACHINE_ROOT + "/") {
			this.host.emit({
				type: "files",
				path: MACHINE_ROOT,
				parent: null,
				entries: [{ name: "/", path: "/", type: "dir" }],
				truncated: false,
				absolute: true,
			});
			return;
		}

		const isAbs = raw.startsWith("/");
		let targetAbs: string;
		let wirePath: string;
		let parentWire: string | null;

		if (isAbs) {
			targetAbs = posix.normalize(raw);
			wirePath = targetAbs;
			parentWire = targetAbs === "/" ? MACHINE_ROOT : posix.dirname(targetAbs) || "/";
		} else {
			const w = resolveRemoteWorkspacePath(parsed.remotePath, raw);
			if (!w) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `路径超出工作区：${relPath ?? ""}`,
					textEn: `Path is outside the workspace: ${relPath ?? ""}`,
				});
				return;
			}
			targetAbs = w.abs;
			wirePath = w.rel;
			parentWire =
				w.rel === ""
					? parsed.remotePath === "/"
						? MACHINE_ROOT
						: posix.dirname(parsed.remotePath)
					: w.rel.includes("/")
						? w.rel.slice(0, w.rel.lastIndexOf("/"))
						: "";
		}

		try {
			const rawEntries = await sshSvc.sftpReaddir(rawCwd, targetAbs);
			const ignored = IGNORED_ENTRIES_WIN;
			const out: FileEntry[] = [];
			for (const d of rawEntries) {
				if (ignored.has(d.name)) continue;
				const entryPath =
					wirePath === ""
						? d.name
						: wirePath.endsWith("/")
							? `${wirePath.slice(0, -1)}/${d.name}`
							: `${wirePath}/${d.name}`;
				const entry: FileEntry = {
					name: d.name,
					path: entryPath,
					type: d.type,
				};
				if (d.type === "file") entry.kind = previewKind(d.name);
				out.push(entry);
			}
			out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
			const MAX = 2000;
			const truncated = out.length > MAX;
			if (truncated) out.length = MAX;

			this.host.emit({
				type: "files",
				path: wirePath,
				parent: parentWire,
				entries: out,
				truncated,
				...(isAbs ? { absolute: true } : {}),
			});
		} catch (err) {
			const e = err as NodeJS.ErrnoException;
			this.host.emit({
				type: "files",
				path: wirePath,
				parent: parentWire,
				entries: [],
				truncated: false,
				...(isAbs ? { absolute: true } : {}),
			});
			this.emitListError(targetAbs, e.message || String(err), e.code);
		}
	}

	private async searchRemoteFiles(rawCwd: string, query: string, reqId: number): Promise<void> {
		const rawQuery = query.trim();
		if (!rawQuery) {
			this.host.emit({ type: "search_files_result", reqId, ok: true, results: [] });
			return;
		}
		const sshSvc = getGlobalRemoteSshService();
		if (!sshSvc) {
			this.host.emit({ type: "search_files_result", reqId, ok: false, results: [] });
			return;
		}
		try {
			const normQuery = rawQuery.replace(/\\/g, "/");
			const q = normQuery.toLowerCase();
			const results: FileSearchResult[] = [];
			let truncated = false;

			const target = this.resolveRemoteTarget(rawCwd, normQuery);
			if (target) {
				try {
					const st = await sshSvc.sftpStat(rawCwd, target.abs);
					const name = posix.basename(target.abs) || target.rel;
					results.push({
						path: target.rel,
						name,
						type: st.isDirectory ? "dir" : "file",
					});
				} catch {}
			}

			const cmd = `find . -maxdepth 8 \\( -name node_modules -o -name .git -o -name .pi-web \\) -prune -o -print 2>/dev/null | head -n 5000`;
			const res = await sshSvc.execInWorkspace(rawCwd, cmd, { timeoutMs: 8000 });
			const lines = res.stdout.split(/\r?\n/);
			for (const line of lines) {
				const clean = line.trim().replace(/^\.\//, "");
				if (!clean || clean === ".") continue;
				const name = posix.basename(clean);
				if (
					(name.toLowerCase().includes(q) || clean.toLowerCase().includes(q)) &&
					!results.some((r) => r.path === clean)
				) {
					results.push({
						path: clean,
						name,
						type: "file",
					});
					if (results.length >= 50) {
						truncated = true;
						break;
					}
				}
			}
			this.host.emit({
				type: "search_files_result",
				reqId,
				ok: true,
				results,
				...(truncated ? { truncated: true } : {}),
			});
		} catch {
			this.host.emit({ type: "search_files_result", reqId, ok: false, results: [] });
		}
	}

	private async readRemoteFile(rawCwd: string, relPath: string): Promise<void> {
		try {
			const sshSvc = getGlobalRemoteSshService();
			if (!sshSvc) throw new Error("Remote SSH service not initialized");
			const t = this.resolveRemoteTarget(rawCwd, relPath);
			if (!t) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `路径超出工作区：${relPath}`,
					textEn: `Path is outside the workspace: ${relPath}`,
				});
				return;
			}
			const st = await sshSvc.sftpStat(rawCwd, t.abs);
			if (!st.isFile) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `不是文件：${relPath}`,
					textEn: `Not a file: ${relPath}`,
				});
				return;
			}
			const name = posix.basename(t.abs) || relPath;
			if (isOfficeFile(name) && st.size <= OFFICE_MAX_FILE_BYTES) {
				try {
					const { data } = await sshSvc.sftpReadFile(rawCwd, t.abs, OFFICE_MAX_FILE_BYTES);
					const office = extractOfficeText(name, data);
					if (office) {
						this.host.emit({
							type: "file_content",
							path: t.rel,
							name,
							text: office.text,
							truncated: office.truncated || data.length < st.size,
							binary: false,
							kind: "text",
							lines: countLines(Buffer.from(office.text)),
							size: st.size,
							slides: office.slides,
						});
						return;
					}
				} catch {}
			}
			const kind = previewKind(name);
			if (kind === "image" || kind === "video" || kind === "audio") {
				this.host.emit({
					type: "file_content",
					path: t.rel,
					name,
					text: "",
					truncated: false,
					binary: true,
					kind,
					lines: 0,
					size: st.size,
				});
				return;
			}
			const { data, size } = await sshSvc.sftpReadFile(rawCwd, t.abs, MAX_PREVIEW_BYTES);
			if (looksLikeText(data)) {
				this.host.emit({
					type: "file_content",
					path: t.rel,
					name,
					text: decodeText(data),
					truncated: data.length < size,
					binary: false,
					kind: "text",
					lines: countLines(data),
					size,
				});
			} else {
				this.host.emit({
					type: "file_content",
					path: t.rel,
					name,
					text: hexDump(data),
					truncated: data.length < size,
					binary: true,
					kind: kind === "text" ? "text" : "none",
					lines: 0,
					size,
				});
			}
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `读取远程文件失败：${(err as Error).message}`,
				textEn: `Failed to read remote file: ${(err as Error).message}`,
			});
		}
	}

	private async writeRemoteFile(rawCwd: string, relPath: string, text: string): Promise<void> {
		try {
			const sshSvc = getGlobalRemoteSshService();
			if (!sshSvc) throw new Error("Remote SSH service not initialized");
			const t = this.resolveRemoteTarget(rawCwd, relPath);
			if (!t) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `路径超出工作区：${relPath}`,
					textEn: `Path is outside the workspace: ${relPath}`,
				});
				return;
			}
			if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: "文件内容过大，无法保存（上限 2MB）",
					textEn: "File too large to save (2MB max)",
				});
				return;
			}
			const info = await sshSvc.sftpStat(rawCwd, t.abs);
			if (!info.isFile || info.size > 2 * 1024 * 1024)
				throw new Error("Remote save target must be a regular file no larger than 2MB");
			await sshSvc.sftpWriteFile(rawCwd, t.abs, text);
			this.host.emit({
				type: "notice",
				level: "info",
				text: `已保存：${t.rel}`,
				textEn: `Saved: ${t.rel}`,
			});
			await this.readRemoteFile(rawCwd, t.rel);
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `保存远程文件失败：${(err as Error).message}`,
				textEn: `Failed to save remote file: ${(err as Error).message}`,
			});
		}
	}

	private async uploadRemoteFile(
		rawCwd: string,
		relDir: string,
		name: string,
		data: string,
		uploadId?: string,
	): Promise<void> {
		const emitErr = (text: string, textEn?: string) => {
			this.host.emit({ type: "notice", level: "error", text, textEn });
			if (typeof uploadId === "string")
				this.host.emit({ type: "file_upload_result", uploadId, ok: false, error: textEn ?? text });
		};
		try {
			const sshSvc = getGlobalRemoteSshService();
			if (!sshSvc) throw new Error("Remote SSH service not initialized");
			const dirTarget = this.resolveRemoteTarget(rawCwd, relDir, true);
			if (!dirTarget) {
				emitErr(`路径超出工作区：${relDir}`, `Path outside workspace: ${relDir}`);
				return;
			}
			const safe = this.sanitizeName(name);
			if (!safe) {
				emitErr(`文件名不合法：${name}`, `Invalid file name: ${name}`);
				return;
			}
			const maxBytes = this.host.getUploadMaxBytes?.() ?? uploadLimitBytes({}, "workspace");
			if (isUploadDataTooLong(data.length, maxBytes)) {
				emitErr(`文件过大：${name}`, `File too large: ${name}`);
				return;
			}
			const buf = Buffer.from(data, "base64");
			if (buf.length === 0 || buf.length > maxBytes) {
				emitErr(`文件大小不合法：${name}`, `Invalid file size: ${name}`);
				return;
			}
			const destAbs = posix.join(dirTarget.abs, safe);
			const exists = await sshSvc.sftpStat(rawCwd, destAbs).catch(() => null);
			if (exists) {
				emitErr(`已存在：${safe}`, `Already exists: ${safe}`);
				return;
			}
			await writeRemoteUploadExclusive(sshSvc, rawCwd, destAbs, buf);
			const uploadRel = dirTarget.rel ? `${dirTarget.rel}/${safe}` : safe;
			this.host.emit({
				type: "notice",
				level: "info",
				text: `已上传：${uploadRel}`,
				textEn: `Uploaded: ${uploadRel}`,
			});
			this.host.emit({
				type: "file_changed",
				path: dirTarget.rel,
			});
			if (typeof uploadId === "string") this.host.emit({ type: "file_upload_result", uploadId, ok: true });
		} catch (err) {
			emitErr(`上传文件失败：${(err as Error).message}`, `Upload failed: ${(err as Error).message}`);
		}
	}

	private async createRemoteEntry(rawCwd: string, dir: string, name: string, kind: "file" | "dir"): Promise<void> {
		const err = (text: string, textEn?: string) => this.host.emit({ type: "notice", level: "error", text, textEn });
		try {
			const sshSvc = getGlobalRemoteSshService();
			if (!sshSvc) throw new Error("Remote SSH service not initialized");
			const safe = this.sanitizeName(name);
			if (!safe) {
				err("名称不合法：" + name, "Invalid name: " + name);
				return;
			}
			const parent = this.resolveRemoteTarget(rawCwd, dir, true);
			if (!parent) {
				err("此处不可新建：" + dir, "Cannot create here: " + dir);
				return;
			}
			const targetAbs = posix.join(parent.abs, safe);
			const existing = await sshSvc.sftpStat(rawCwd, targetAbs).catch(() => null);
			if (existing) {
				err("已存在同名项：" + safe, "Already exists: " + safe);
				return;
			}
			if (kind === "dir") {
				await sshSvc.sftpMkdirRecursive(rawCwd, targetAbs);
			} else {
				await sshSvc.sftpWriteFile(rawCwd, targetAbs, "");
			}
			this.host.emit({
				type: "notice",
				level: "info",
				text: (kind === "dir" ? "已新建文件夹：" : "已新建文件：") + safe,
				textEn: (kind === "dir" ? "Created folder: " : "Created file: ") + safe,
			});
			this.host.emit({ type: "file_changed", path: parent.rel });
		} catch (e) {
			err("新建失败：" + (e as Error).message, "Create failed: " + (e as Error).message);
		}
	}

	private async renameRemoteEntry(rawCwd: string, pathStr: string, newName: string): Promise<void> {
		const err = (text: string, textEn?: string) => this.host.emit({ type: "notice", level: "error", text, textEn });
		try {
			const sshSvc = getGlobalRemoteSshService();
			if (!sshSvc) throw new Error("Remote SSH service not initialized");
			const safe = this.sanitizeName(newName);
			if (!safe) {
				err("新名称不合法：" + newName, "Invalid name: " + newName);
				return;
			}
			const t = this.resolveRemoteTarget(rawCwd, pathStr);
			if (!t) {
				err("此处不可重命名：" + pathStr, "Cannot rename: " + pathStr);
				return;
			}
			const destAbs = posix.join(posix.dirname(t.abs), safe);
			if (destAbs === t.abs) return;
			const existing = await sshSvc.sftpStat(rawCwd, destAbs).catch(() => null);
			if (existing) {
				err("目标已存在：" + safe, "Already exists: " + safe);
				return;
			}
			await sshSvc.sftpRename(rawCwd, t.abs, destAbs);
			this.host.emit({
				type: "notice",
				level: "info",
				text: "已重命名为：" + safe,
				textEn: "Renamed to: " + safe,
			});
			this.host.emit({ type: "file_changed", path: t.parentRel });
		} catch (e) {
			err("重命名失败：" + (e as Error).message, "Rename failed: " + (e as Error).message);
		}
	}

	private async deleteRemoteEntry(rawCwd: string, pathStr: string): Promise<void> {
		const err = (text: string, textEn?: string) => this.host.emit({ type: "notice", level: "error", text, textEn });
		try {
			const sshSvc = getGlobalRemoteSshService();
			if (!sshSvc) throw new Error("Remote SSH service not initialized");
			const t = this.resolveRemoteTarget(rawCwd, pathStr);
			if (!t) {
				err("此处不可删除：" + pathStr, "Cannot delete: " + pathStr);
				return;
			}
			await sshSvc.sftpRemove(rawCwd, t.abs);
			const base = posix.basename(t.abs);
			this.host.emit({
				type: "notice",
				level: "info",
				text: "已删除：" + base,
				textEn: "Deleted: " + base,
			});
			this.host.emit({ type: "file_changed", path: t.parentRel });
		} catch (e) {
			err("删除失败：" + (e as Error).message, "Delete failed: " + (e as Error).message);
		}
	}

	private async copyRemoteEntry(rawCwd: string, src: string, destDir: string, move?: boolean): Promise<void> {
		const err = (text: string, textEn?: string) => this.host.emit({ type: "notice", level: "error", text, textEn });
		try {
			const sshSvc = getGlobalRemoteSshService();
			if (!sshSvc) throw new Error("Remote SSH service not initialized");
			const s = this.resolveRemoteTarget(rawCwd, src);
			const d = this.resolveRemoteTarget(rawCwd, destDir, true);
			if (!s || !d) {
				err("无效的路径", "Invalid path");
				return;
			}
			const base = posix.basename(s.abs);
			let destAbs = posix.join(d.abs, base);
			if (destAbs === s.abs) {
				if (move) return;
				const ext = posix.extname(base);
				const stem = ext ? base.slice(0, -ext.length) : base;
				destAbs = posix.join(d.abs, `${stem} copy${ext}`);
			}
			await sshSvc.sftpCopy(rawCwd, s.abs, destAbs, move);
			this.host.emit({
				type: "notice",
				level: "info",
				text: (move ? "已移动：" : "已复制：") + posix.basename(destAbs),
				textEn: (move ? "Moved: " : "Copied: ") + posix.basename(destAbs),
			});
			this.host.emit({ type: "file_changed", path: d.rel });
			if (move && s.parentRel !== d.rel) {
				this.host.emit({ type: "file_changed", path: s.parentRel });
			}
		} catch (e) {
			err((move ? "移动失败：" : "复制失败：") + (e as Error).message);
		}
	}

	private async completeRemotePath(rawCwd: string, rawInput: string): Promise<void> {
		const empty = () => this.host.emit({ type: "path_completions", completions: [] });
		try {
			const sshSvc = getGlobalRemoteSshService();
			const parsed = parseRemoteWorkspaceUri(rawCwd);
			if (!sshSvc || !parsed) {
				empty();
				return;
			}
			let targetPath = rawInput;
			if (isRemoteWorkspaceUri(rawInput)) {
				const p = parseRemoteWorkspaceUri(rawInput);
				targetPath = p ? p.remotePath + (rawInput.endsWith("/") ? "/" : "") : "/";
			} else if (!targetPath.startsWith("/")) {
				targetPath = posix.resolve(parsed.remotePath, targetPath);
			}
			const lastSlash = targetPath.lastIndexOf("/");
			const dirPart = lastSlash >= 0 ? targetPath.slice(0, lastSlash + 1) || "/" : "/";
			const prefix = lastSlash >= 0 ? targetPath.slice(lastSlash + 1) : targetPath;
			const entries = await sshSvc.sftpReaddir(rawCwd, dirPart).catch(() => null);
			if (!entries) {
				empty();
				return;
			}
			const completions = entries
				.filter((d) => d.name.startsWith(prefix))
				.map((e) => ({
					name: e.name,
					type: e.type,
					path: dirPart === "/" ? `/${e.name}` : `${dirPart.replace(/\/+$/, "")}/${e.name}`,
				}))
				.sort((a, b) => {
					if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
					return a.name.localeCompare(b.name);
				})
				.slice(0, 100);
			this.host.emit({ type: "path_completions", completions });
		} catch {
			empty();
		}
	}
}
