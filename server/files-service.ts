/**
 * Files service — 从 agent-service.ts 抽出（文件树列目录 / 预览读写 / 路径补全 /
 * SCM 只读查询 / 目录与 git-dir watcher）。
 *
 * 全部为无状态 fs 操作 + 两个自持的 watcher（当前列出目录、git dir），
 * 经 FilesHost 回调与 ClientSession 解耦。
 */
import { mkdirSync, statSync, writeFileSync, watch } from "node:fs";
import { resolve, relative, sep } from "node:path";
import type { ServerMessage, FileEntry, FileSearchResult } from "./protocol.js";
import { previewKind, looksLikeText, decodeText, hexDump, countLines } from "./text-sniff.js";
import { gitDirOf, isNotRepoError, scmStatus, scmHistory, scmFileDiff, scmCommitDetail } from "./scm.js";

export const IS_WIN32 = process.platform === "win32";
/** 预览只读文件前 512KB。 */
export const MAX_PREVIEW_BYTES = 512 * 1024;

/** 右键上传单文件上限（内存中转 base64 → Buffer）。 */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// mac/linux: hide build & dependency noise (original behavior).
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

// Windows: the file tree is the primary way to navigate a project, so only
// hide what would flood or destabilize the panel (dependency trees, VCS
// internals, session data) plus pure junk. Build output (dist/.next/…) and
// local env dirs (venv/__pycache__/…) stay visible — "所有文件可查看".
const IGNORED_ENTRIES_WIN = new Set(["node_modules", ".git", ".pi-web", ".DS_Store", "Thumbs.db", "desktop.ini"]);

/** The ignore set for the current platform — keeps win/posix lists separate. */
function ignoredEntries(): Set<string> {
	return IS_WIN32 ? IGNORED_ENTRIES_WIN : IGNORED_ENTRIES;
}

/**
 * Resolve a workspace-relative path against a root, refusing traversal
 * (".." escapes). Returns { abs, rel } — rel is normalized and slash-
 * separated — or null when the path leaves the workspace.
 */
export function workspacePath(root: string, raw: string): { abs: string; rel: string } | null {
	const abs = resolve(root, raw);
	const rawRel = relative(root, abs);
	if (rawRel.startsWith("..") || rawRel.includes(`${sep}..`)) return null;
	// Normalize to forward slashes: the wire protocol and the frontend always
	// use "/", but relative() returns "\\" on Windows.
	return { abs, rel: rawRel.split(sep).join("/") };
}

/**
 * Read a directory for the file panel. The two platforms intentionally use
 * different strategies — do NOT unify them:
 *
 * darwin/linux (posix): original behavior — hide build/dependency noise,
 * small cap, hard error notice when the directory itself is unreadable.
 *
 * win32: stability and completeness first, preview second. ACL-protected
 * system dirs (C:\$Recycle.Bin, Program Files internals, OneDrive placeholders)
 * throw EPERM/EACCES on open — that must not kill the panel, so it degrades
 * to an empty listing plus a warning. Directory symlinks/junctions are
 * followed so mklink /D folders stay navigable; broken links still show as
 * files instead of vanishing. The cap is 4x posix and truncation is reported
 * via `truncated` instead of happening silently.
 */
async function readDirForUI(
	abs: string,
	rel: string,
): Promise<{ entries: FileEntry[]; truncated: boolean; error?: string }> {
	const { join } = await import("node:path");
	const fs = await import("node:fs/promises");
	const ignored = ignoredEntries();
	const MAX = IS_WIN32 ? 2000 : 500;

	let dirents: import("node:fs").Dirent[];
	try {
		dirents = await fs.readdir(abs, { withFileTypes: true });
	} catch (err) {
		if (!IS_WIN32) throw err;
		// Windows ACL-protected/system dirs throw EPERM/EACCES on open —
		// degrade to an empty listing; listFiles turns this into a warning.
		return { entries: [], truncated: false, error: (err as Error).message };
	}

	const out: FileEntry[] = [];
	for (const d of dirents) {
		if (ignored.has(d.name)) continue;
		let type: "dir" | "file";
		if (IS_WIN32 && d.isSymbolicLink()) {
			// mklink /D symlinks and junctions are reparse points — libuv
			// classifies them as links, so isDirectory() is false. Follow the
			// target so folder links stay navigable; broken links still show.
			try {
				const st = await fs.stat(join(abs, d.name));
				type = st.isDirectory() ? "dir" : "file";
			} catch {
				type = "file";
			}
		} else {
			type = d.isDirectory() ? "dir" : "file";
		}
		const entry: FileEntry = {
			name: d.name,
			path: rel === "" ? d.name : `${rel}/${d.name}`,
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

/** ClientSession 提供给本服务的宿主能力。 */
export interface FilesHost {
	emit: (msg: ServerMessage) => void;
	isDisposed: () => boolean;
	/** 文件面板 / 预览读写 / 补全的工作区根（服务启动 cwd 或会话 cwd）。 */
	getCwd: () => string;
	/** SCM 查询的工作区（当前活动对话所属项目，可能与 getCwd 不同）。 */
	getActiveCwd: () => string;
}

export class FilesService {
	// ---- 当前列出目录的 watcher ----
	private fsWatcher: ReturnType<typeof watch> | null = null;
	private watchPath: string | null = null;
	private watchTimer: ReturnType<typeof setTimeout> | null = null;
	/** Recursive-watch state (win32/darwin): one native recursive watcher on the
	 *  workspace root covers the WHOLE tree; watchPath just tracks which listed
	 *  directory file_changed should refresh. */
	private recursiveWatcher = false;
	private watchRoot: string | null = null;
	/** 已对哪个工作区根提示过「实时监听不可用，已回落轮询」——只提示一次。 */
	private degradedNoticedFor: string | null = null;
	// ---- git dir watcher ----
	private gitWatcher: ReturnType<typeof watch> | null = null;
	private gitWatchCwd: string | null = null;
	private gitDirtyTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly host: FilesHost) {}

	async listFiles(relPath?: string): Promise<void> {
		const { resolve, sep, relative } = await import("node:path");
		const root = resolve(this.host.getCwd());
		const target = relPath ? resolve(root, relPath) : root;
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
		// Normalize to forward slashes: the wire protocol and the frontend
		// always use "/", but relative() returns "\\" on Windows.
		const rel = rawRel.split(sep).join("/");
		const { entries, truncated, error } = await readDirForUI(target, rel);
		// Watch the listed directory (only after a successful read — a missing
		// dir throws above and must not create a watcher on a phantom path).
		this.watchDir(target, rel);
		if (error) {
			// Windows-only: unreadable system dirs degrade to an empty list
			// with a warning instead of a hard error — the panel stays usable.
			this.host.emit({
				type: "notice",
				level: "warning",
				text: `目录不可读：${error}`,
				textEn: `Directory is not readable: ${error}`,
			});
		}
		this.host.emit({
			type: "files",
			path: rel === "" ? "" : rel,
			parent: rel === "" ? null : rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
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
		const { join } = await import("node:path");
		const fsp = await import("node:fs/promises");
		const q = query.trim().toLowerCase();
		if (!q) {
			this.host.emit({ type: "search_files_result", reqId, ok: true, results: [] });
			return;
		}
		const root = resolve(this.host.getActiveCwd());
		const ignored = ignoredEntries();
		const MAX_RESULTS = 50;
		const MAX_VISITED = 20000;
		const MAX_MS = 4000;
		const start = Date.now();
		const results: FileSearchResult[] = [];
		let visited = 0;
		let truncated = false;
		const budgetLeft = () => results.length < MAX_RESULTS && visited < MAX_VISITED && Date.now() - start < MAX_MS;
		// Breadth-first-ish iterative stack; depth cap is a symlink-cycle guard.
		const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
			if (!budgetLeft() || depth > 24) {
				truncated = true;
				return;
			}
			let dirents: import("node:fs").Dirent[];
			try {
				dirents = await fsp.readdir(abs, { withFileTypes: true });
			} catch {
				return; // unreadable dir (ACL/permissions) — skip silently
			}
			for (const d of dirents) {
				visited++;
				if (!budgetLeft()) {
					truncated = true;
					break;
				}
				if (ignored.has(d.name)) continue;
				const childRel = rel ? `${rel}/${d.name}` : d.name;
				if (d.name.toLowerCase().includes(q)) {
					results.push({
						path: childRel,
						name: d.name,
						type: d.isDirectory() ? "dir" : "file",
					});
				}
				if (d.isDirectory()) {
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

	/**
	 * Source-control panel: read-only git queries via server-side execFile
	 * (no shell, no prompts). Always responds with an scm_data message echoing
	 * reqId so the client's request matching never stalls. Also (re)arms the
	 * git-dir watcher so external repo changes push scm_changed.
	 */
	async scmQuery(
		kind: "status" | "history" | "filediff" | "commit",
		reqId: number,
		arg?: { path?: string; hash?: string },
	): Promise<void> {
		const cwd = this.host.getActiveCwd();
		if (kind === "status") this.watchGitDir(cwd);
		try {
			if (kind === "status") {
				const data = await scmStatus(cwd);
				this.host.emit({ type: "scm_data", reqId, kind, ok: true, ...data });
				return;
			}
			if (kind === "history") {
				const history = await scmHistory(cwd);
				this.host.emit({ type: "scm_data", reqId, kind, ok: true, history });
				return;
			}
			if (kind === "filediff" && arg?.path) {
				// Path stays inside the workspace (defense in depth — paths come
				// from our own listing, and execFile passes args verbatim anyway).
				const { resolve, relative } = await import("node:path");
				const rel = relative(resolve(cwd), resolve(cwd, arg.path));
				if (rel.startsWith("..") || rel === "") throw new Error("路径超出工作区");
				const { staged, worktree } = await scmFileDiff(cwd, arg.path);
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
				const text = await scmCommitDetail(cwd, arg.hash);
				this.host.emit({ type: "scm_data", reqId, kind, ok: true, text });
				return;
			}
			throw new Error("无效的 scm 查询参数");
		} catch (err) {
			if (isNotRepoError(err)) {
				// Not a repo — a valid empty answer so the panel shows its hint.
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

	/**
	 * Watch the active repo's git dir (HEAD / index / packed-refs live at the
	 * top level, which covers commit / stage / checkout). Re-targets when the
	 * queried workspace changes. Uses `git rev-parse --absolute-git-dir` so
	 * worktrees and submodules resolve to the real dir.
	 */
	private async watchGitDir(cwd: string): Promise<void> {
		if (this.gitWatchCwd === cwd && this.gitWatcher) return;
		this.unwatchGit();
		this.gitWatchCwd = cwd;
		try {
			const gitDir = await gitDirOf(cwd);
			if (!gitDir) return;
			this.gitWatcher = watch(gitDir, { persistent: false }, () => {
				if (this.host.isDisposed() || this.gitDirtyTimer) return;
				// Debounce: one checkout/commit fires several fs events.
				this.gitDirtyTimer = setTimeout(() => {
					this.gitDirtyTimer = null;
					this.host.emit({ type: "scm_changed" });
				}, 600);
			});
			this.gitWatcher.on("error", () => {
				// Unsupported filesystem — silently fall back to manual refresh.
				this.unwatchGit();
			});
		} catch {
			// no .git here (or git missing) — watcher stays off; queries still work
			this.unwatchGit();
		}
	}

	unwatchGit(): void {
		if (this.gitWatcher) {
			try {
				this.gitWatcher.close();
			} catch {
				// already gone
			}
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
		// ---- Recursive mode (native on win32 / darwin): watch the workspace
		// root once, so deep changes in NOT-listed subdirectories still refresh
		// the panel (the old per-directory watch only saw the current level).
		if (process.platform === "win32" || process.platform === "darwin") {
			const root = resolve(this.host.getCwd());
			if (this.recursiveWatcher) {
				if (this.watchRoot === root) {
					// Same workspace — only retarget the refresh path.
					this.watchPath = rel;
					return;
				}
				this.unwatchDir(); // cwd switched to another project
			}
			try {
				const w = watch(root, { persistent: false, recursive: true }, (_event, filename) => {
					// Skip high-churn subtrees (npm install storms); .git has its
					// own watcher for the SCM panel. filename may be null on some
					// platforms — let those through (debounce absorbs bursts).
					if (filename) {
						const f = String(filename).split("\\").join("/");
						// Single-segment names (e.g. the dir itself) have no "/" —
						// slice(0, -1) would corrupt them, so special-case that.
						const slash = f.indexOf("/");
						const top = slash === -1 ? f : f.slice(0, slash);
						if (top === "node_modules" || top === ".git") return;
					}
					// Burst events are debounced into a single refresh.
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
					// Directory deleted / unsupported — fall back to poll semantics.
					this.noticeDegraded(root);
					this.unwatchDir();
				});
				this.fsWatcher = w;
				this.watchRoot = root;
				this.recursiveWatcher = true;
				this.watchPath = rel;
				return;
			} catch {
				// recursive unsupported here — fall through to per-directory watch.
				this.fsWatcher = null;
				this.recursiveWatcher = false;
				this.watchRoot = null;
				this.noticeDegraded(root);
			}
		}
		// ---- Fallback: single non-recursive watch on the LISTED directory.
		if (!this.recursiveWatcher && this.watchPath === rel && this.fsWatcher) return;
		this.unwatchDir();
		this.watchPath = rel;
		try {
			// persistent: false — the watcher must not keep the process alive.
			this.fsWatcher = watch(absPath, { persistent: false }, () => {
				// Burst events (npm install, git ops, editor save→rename) are
				// debounced into a single refresh.
				if (this.watchTimer) return;
				this.watchTimer = setTimeout(() => {
					this.watchTimer = null;
					this.host.emit({ type: "file_changed", path: this.watchPath ?? "" });
				}, 400);
			});
			this.fsWatcher.on("error", () => {
				// Directory deleted / unsupported fs — stop watching; the poll (or
				// the next navigation) restores things.
				this.unwatchDir();
			});
		} catch {
			// fs.watch unsupported (some network mounts, containers) — poll covers it.
			this.fsWatcher = null;
			this.watchPath = null;
			this.noticeDegraded(absPath);
		}
	}

	/** 实时监听不可用（网络盘/WSL/受限目录）：一次性告知用户已回落 10s 轮询，
	 *  免得疑惑「面板为什么不实时」。每个工作区根只提示一次。 */
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
			} catch {
				// already closed
			}
			this.fsWatcher = null;
		}
		this.recursiveWatcher = false;
		this.watchRoot = null;
		this.watchPath = null;
	}

	/** Read a workspace file for the preview panel (size-capped, binary-safe). */
	async readFile(relPath: string): Promise<void> {
		try {
			const fs = await import("node:fs/promises");
			const root = this.host.getCwd();
			const wp = workspacePath(resolve(root), relPath);
			if (!wp) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `路径超出工作区：${relPath}`,
					textEn: `Path is outside the workspace: ${relPath}`,
				});
				return;
			}
			const { abs, rel } = wp;
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
			const kind = previewKind(name);
			// Media previews stream over the /api/file HTTP endpoint, so only
			// metadata is sent here — the raw bytes never touch the socket.
			if (kind === "image" || kind === "video") {
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
			// Everything else: read a capped prefix and sniff the content.
			// Anything that looks like text previews as text regardless of its
			// extension (jsonl, .log.1, weird suffixes, …); binary content gets
			// a hex dump of the first few KB instead of being refused.
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

	/** Save text from the file preview panel within the active workspace. */
	async writeFile(relPath: string, text: string): Promise<void> {
		try {
			const root = this.host.getCwd();
			const wp = workspacePath(resolve(root), relPath);
			if (!wp) {
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
			const stat = statSync(wp.abs);
			if (!stat.isFile()) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `不是文件：${relPath}`,
					textEn: `Not a file: ${relPath}`,
				});
				return;
			}
			writeFileSync(wp.abs, text, "utf8");
			this.host.emit({
				type: "notice",
				level: "info",
				text: `已保存：${wp.rel}`,
				textEn: `Saved: ${wp.rel}`,
			});
			// Re-read through the same path as the preview request so the client
			// gets the canonical content, line count and file size after saving.
			await this.readFile(wp.rel);
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `保存文件失败：${(err as Error).message}`,
				textEn: `Failed to save file: ${(err as Error).message}`,
			});
		}
	}

	/**
	 * Upload a file (base64, no data: prefix) INTO a workspace directory —
	 * the file manager's right-click “upload here” action. The target dir may
	 * be nested and is created on demand; the name is basename-sanitized so a
	 * malicious payload can't escape the directory. Emits notice + file_changed
	 * for the target dir (the recursive watcher may not cover it on posix).
	 */
	async uploadFile(relDir: string, name: string, data: string): Promise<void> {
		const emitErr = (text: string) => this.host.emit({ type: "notice", level: "error", text });
		try {
			const root = this.host.getCwd();
			let wp: { abs: string; rel: string } | null;
			if (relDir) {
				wp = workspacePath(resolve(root), relDir);
				if (!wp) {
					emitErr(`路径超出工作区：${relDir}`);
					return;
				}
			} else {
				wp = { abs: root, rel: "" };
			}
			// Basename only — strips any path separators / ".." the name carries;
			// reject empty results and Windows-illegal characters outright.
			const base = name.split(/[\\/]/).pop() ?? "";
			const safe = (base.replace(/[/:*?"<>|\x00-\x1f]/g, "_").trim() || "file").slice(0, 200);
			const abs = resolve(wp.abs, safe);
			const rawRel = relative(root, abs);
			if (rawRel.startsWith("..") || rawRel.includes(`${sep}..`)) {
				emitErr(`文件名不合法：${name}`);
				return;
			}
			const buf = Buffer.from(data, "base64");
			if (buf.length === 0) {
				emitErr(`空文件：${name}`);
				return;
			}
			if (buf.length > MAX_UPLOAD_BYTES) {
				emitErr(`文件过大：${name}（上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）`);
				return;
			}
			mkdirSync(wp.abs, { recursive: true });
			writeFileSync(abs, buf);
			this.host.emit({
				type: "notice",
				level: "info",
				text: `已上传：${rawRel.split(sep).join("/")}`,
				textEn: `Uploaded: ${rawRel.split(sep).join("/")}`,
			});
			// Emit for the target directory itself so the panel refreshes even
			// when the active listing/preview isn't that dir (posix watcher only
			// sees the LISTED directory).
			this.host.emit({
				type: "file_changed",
				path: wp.rel,
			});
		} catch (err) {
			emitErr(`上传文件失败：${(err as Error).message}`);
		}
	}

	/**
	 * Path completion for the cwd input: expand ~/relative paths, list the parent
	 * directory, and return prefix matches (dirs first, capped).
	 */
	async completePath(input: string): Promise<void> {
		const empty = () => this.host.emit({ type: "path_completions", completions: [] });
		try {
			const fs = await import("node:fs/promises");
			const { resolve, sep, isAbsolute } = await import("node:path");
			const { homedir } = await import("node:os");
			const home = homedir();
			const cwd = this.host.getCwd();

			// Expand ~ and relative inputs to an absolute path. Windows users type
			// backslashes (P:\agent) and ~\ — handle both separator styles.
			let expanded = input.trim();
			if (expanded === "") {
				empty();
				return;
			}
			if (expanded === "~" || expanded === "~\\") {
				expanded = home;
			} else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
				expanded = home + sep + expanded.slice(2);
			} else if (!isAbsolute(expanded)) {
				expanded = resolve(cwd, expanded);
			}

			// Split into parent dir + prefix on the LAST separator of either style
			// (Windows accepts both / and \, so P:\agent/de must work too).
			const lastSlash = Math.max(expanded.lastIndexOf("/"), expanded.lastIndexOf("\\"));
			const dirPart = lastSlash >= 0 ? expanded.slice(0, lastSlash + 1) : "";
			const prefix = lastSlash >= 0 ? expanded.slice(lastSlash + 1) : expanded;

			const dirents = await fs.readdir(dirPart, { withFileTypes: true }).catch(() => null);
			if (!dirents) {
				empty();
				return;
			}
			const { join } = await import("node:path");
			const completions = dirents
				.filter((d) => d.name.startsWith(prefix) && !ignoredEntries().has(d.name))
				.map((d) => ({
					name: d.name,
					// Windows users type backslashes — normalize the completion to the
					// wire format ("/") so the picked path round-trips cleanly.
					path: IS_WIN32 ? join(dirPart, d.name).split(sep).join("/") : dirPart + d.name,
					type: (d.isDirectory() ? "dir" : "file") as "dir" | "file",
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
}
