/**
 * Files service — 从 agent-service.ts 抽出（文件树列目录 / 预览读写 / 路径补全 /
 * SCM 只读查询 / 目录与 git-dir watcher）。
 *
 * 全部为无状态 fs 操作 + 两个自持的 watcher（当前列出目录、git dir），
 * 经 FilesHost 回调与 ClientSession 解耦。
 */
import { Dirent, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, watch } from "node:fs";
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
	shellQuotePosix,
} from "./remote-ssh-service.js";

export const IS_WIN32 = process.platform === "win32";

/** 机器根虚拟路径：工作区「上一级」到达此处，列出所有盘符（Windows）/ "/"（posix）。
 *  这是 wire 字面量，前端 web/src/components/{RightPanel,FooterBar}.tsx 里同值使用。 */
export const MACHINE_ROOT = "@root";

/** 桌面目录（wire 格式）：存在且为目录才返回，否则空串（前端不渲染 🖥️）。
 *  Linux 优先读 XDG user-dirs（中文环境可能是 ~/桌面），其余平台即 ~/Desktop。 */
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
		} catch {
			// 无 XDG 配置就回落 ~/Desktop
		}
	}
	cands.push(`${homeWire}/Desktop`);
	for (const c of cands) {
		try {
			if (statSync(wireToAbs(c)).isDirectory()) return c;
		} catch {
			// 不存在就试下一个
		}
	}
	return "";
}

/** wire 路径统一用 "/"。绝对 = posix "/..."；win32 还有 "C:/..." / 裸 "C:"。
 *  机器浏览（越过工作区根换盘符）发送这些路径；工作区相对树不会产生它们（Windows
 *  文件名不能含 ":"，相对路径经 relative() 归一化后也不以 "/" 开头）。
 *  win32 还必须把盘符相对路径（"D:x"，冒号后无分隔符 —— resolve 会落到该盘的
 *  当前目录）与 UNC（"\\host\share"；"//host/share" 已被上面的 "/" 前缀覆盖）
 *  判为绝对：这些形态若被当工作区相对路径处理，会在跨盘/UNC 下绕过 ".." 检查
 *  逃出工作区。posix 上 "C:x" 是合法文件名，故盘符检查必须限定在 win32。 */
export function isAbsoluteWirePath(p: string): boolean {
	if (p === MACHINE_ROOT || p.startsWith("/") || p.startsWith("\\\\")) return true;
	return IS_WIN32 && /^[A-Za-z]:/.test(p);
}

/** 去掉结尾 "/"（保留 posix 根 "/" 本身），归一成规范的 wire 形式。前端面包屑
 *  不产生结尾斜杠，这里只对补全/直接输入做防御性清理。 */
export function normWirePath(p: string): string {
	if (p.endsWith("/") && p !== "/") return p.replace(/\/+$/, "") || "/";
	return p;
}

/** wire 绝对路径（"C:/Users/x" / "/Users/x" / "C:"）→ 原生绝对路径。
 *  裸盘符根（"C:"）在 win32 的 resolve 里会落到「C: 上的当前目录」，必须显式转 "C:\\"。 */
export function wireToAbs(wire: string): string {
	const w = normWirePath(wire);
	if (IS_WIN32) {
		const m = /^([A-Za-z]):$/.exec(w);
		if (m) return `${m[1].toUpperCase()}:\\`;
	}
	return resolve(w);
}

/** 机器浏览模式下某目录的父级 wire 路径：盘符根（"C:"）→ 机器根；posix "/" 无父级。 */
export function absoluteParent(wire: string): string | null {
	const s = normWirePath(wire);
	if (s === "" || s === MACHINE_ROOT || s === "/") return null;
	const i = s.lastIndexOf("/");
	if (i < 0) return /^[A-Za-z]:$/.test(s) ? MACHINE_ROOT : null;
	if (i === 0) return "/"; // posix "/a" → "/"
	return s.slice(0, i);
}
/** 预览只读文件前 512KB。 */
export const MAX_PREVIEW_BYTES = 512 * 1024;

/** 右键上传单文件上限（内存中转 base64 → Buffer）。 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** 上传 cap 对应的 base64 文本长度上限（4/3 膨胀，向上取整到 4 字符边界）。 */
export const MAX_UPLOAD_BASE64_CHARS = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;
/** WS 入站帧上限：base64 上限 + 1MB JSON 包络余量（dirPath/name/type）。
 *  server/index.ts 的 maxPayload 由此取值，两处上限保持对齐。 */
export const WS_MAX_PAYLOAD_BYTES = MAX_UPLOAD_BASE64_CHARS + 1024 * 1024;
/** base64 文本长度是否必定超 cap（解码前快拒，不分配 Buffer）。 */
export function isUploadDataTooLong(dataLength: number, capBytes: number = MAX_UPLOAD_BYTES): boolean {
	return dataLength > Math.ceil(capBytes / 3) * 4;
}

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
	// 只查 ".." 拦不住 Windows 的跨盘/UNC：relative("C:/a","D:/x") 与
	// relative("C:/a","//h/s") 返回绝对路径（"D:\x"、"\\h\s\"），不以 ".." 开头；
	// 盘符相对路径（"D:x"）经 resolve 落到该盘当前目录后也归此形 —— 必须同时
	// 拒绝 isAbsolute 的结果，否则 "D:x" 这类输入可逃出工作区根。
	if (rawRel.startsWith("..") || rawRel.includes(`${sep}..`) || isAbsolute(rawRel)) return null;
	// Normalize to forward slashes: the wire protocol and the frontend always
	// use "/", but relative() returns "\\" on Windows.
	return { abs, rel: rawRel.split(sep).join("/") };
}

/**
 * Read a directory for the file panel. The two platforms intentionally use
 * different strategies — do NOT unify them:
 *
 * darwin/linux (posix): hide build/dependency noise, small cap; a listing
 * failure (deleted/renamed dir → ENOENT/ENOTDIR, permission → EACCES/EPERM)
 * degrades to an empty listing plus a notice chosen by errorCode — the server
 * must NEVER crash on a vanished directory (issue #74).
 *
 * win32: stability and completeness first, preview second. ACL-protected
 * system dirs (C:\$Recycle.Bin, Program Files internals, OneDrive placeholders)
 * throw EPERM/EACCES on open — that must not kill the panel, so it degrades
 * to an empty listing plus a warning. Directory symlinks/junctions are
 * followed (all platforms — Android/Termux's ~/storage/* entries are symlinks
 * too) so folder links stay navigable; broken links still show as files
 * instead of vanishing. The cap is 4x posix and truncation is reported
 * via `truncated` instead of happening silently.
 */
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
		// 任何 readdir 失败都降级为“空列表 + notice”，绝不向上抛：listFiles 以
		// fire-and-forget（void …）调用，未处理的 rejection 会成为 unhandled
		// rejection 直接杀掉整个服务进程（issue #74：目录被删除/改名后刷新即崩）。
		// 缺失（ENOENT/ENOTDIR）、权限拒绝（EACCES/EPERM）、系统 ACL 目录全部归此，
		// 文案由 listFiles 按 errorCode 分类：缺失 = 软提示“目录不存在”，
		// 权限/其余 = posix 硬错误 notice / win32 软提示（ACL 系统目录是常态）。
		const e = err as NodeJS.ErrnoException;
		return { entries: [], truncated: false, error: e.message, errorCode: e.code };
	}

	const out: FileEntry[] = [];
	for (const d of dirents) {
		if (ignored.has(d.name)) continue;
		let type: "dir" | "file";
		if (d.isSymbolicLink()) {
			// Symlinks (mklink /D reparse points on win32, but also the directory
			// links under Termux's ~/storage) are followed on ALL platforms so
			// folder links stay navigable; broken links still show as files.
			try {
				const st = await fs.stat(join(abs, d.name));
				type = st.isDirectory() ? "dir" : "file";
			} catch {
				type = "file";
			}
		} else {
			type = d.isDirectory() ? "dir" : "file";
		}
		// 机器浏览（绝对路径）下 rel 是绝对 wire 路径；posix 根 "/" 特殊处理避免 "//name"。
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

/** dirent → FileEntry classification: directory symlinks are resolved via
 *  stat() on ALL platforms (#262 — Termux's ~/storage/* entries are symlinks;
 *  the directory-only cwd picker renders an empty list if they type as files). */
async function classifyDirent(d: Dirent, absDir: string): Promise<{ name: string; type: "dir" | "file" }> {
	const fs = await import("node:fs/promises");
	const { join } = await import("node:path");
	let type: "dir" | "file";
	if (d.isSymbolicLink()) {
		try {
			type = (await fs.stat(join(absDir, d.name))).isDirectory() ? "dir" : "file";
		} catch {
			type = "file"; // broken link
		}
	} else {
		type = d.isDirectory() ? "dir" : "file";
	}
	return { name: d.name, type };
}

/** ClientSession 提供给本服务的宿主能力。 */
export interface FilesHost {
	emit: (msg: ServerMessage) => void;
	isDisposed: () => boolean;
	/** 文件面板 / 预览读写 / 补全的工作区根（服务启动 cwd 或会话 cwd）。 */
	getCwd: () => string;
	/** SCM 查询的工作区（当前活动对话所属项目，可能与 getCwd 不同）。 */
	getActiveCwd: () => string;
	/**
	 * 服务端语言（issue #91）：单字段错误通道（scm_data.error、抛错 message 插值）
	 * 经 pick 按此选中文/英文；推 UI 的 notice 已是 text+textEn 双字段，不用它。
	 * 缺省英文。agent-service 接线 () => this.getLang()。
	 */
	getLang?: () => ServerLang;
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

	/** 机器根列目录（此电脑/盘符列表）；posix 上就是根 "/"。 */
	private async machineRootEntries(): Promise<FileEntry[]> {
		const fsp = await import("node:fs/promises");
		if (IS_WIN32) {
			const out: FileEntry[] = [];
			for (let c = 65; c <= 90; c++) {
				const drive = `${String.fromCharCode(c)}:`;
				try {
					const st = await fsp.stat(`${drive}\\`);
					if (st.isDirectory()) out.push({ name: drive, path: drive, type: "dir" });
				} catch {
					// 空口/未挂载盘符 —— 跳过
				}
			}
			return out;
		}
		// Android/Termux: "/" itself is not listable (even `ls /` is denied),
		// so fall back to $HOME + shared storage as the machine-root landing
		// spots — otherwise machine browsing is a dead end on Android.
		try {
			await fsp.readdir("/");
		} catch {
			const home = homedir();
			const out: FileEntry[] = [{ name: home, path: home, type: "dir" }];
			try {
				await fsp.readdir("/storage/emulated/0");
				out.push({ name: "/storage/emulated/0", path: "/storage/emulated/0", type: "dir" });
			} catch {
				// no shared storage
			}
			return out;
		}
		return [{ name: "/", path: "/", type: "dir" }];
	}

	/** 单字段错误文本的语言（host 未接线时英文默认）。 */
	private lang(): ServerLang {
		return this.host.getLang?.() ?? "en";
	}

	/** 目录列表失败的 notice：缺失路径（ENOENT/ENOTDIR）是删除/改名等正常场景，
	 *  软提示“目录不存在”；其余（权限拒绝等）保留原平台语义——win32 软提示
	 *  （ACL 系统目录常见），posix 硬错误（error 级 notice，取代曾经的 throw）。 */
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
		// Expand a leading "~/" (path-bar input) to the home directory — same
		// rules as completePath/makeDir. The result is absolute, so it lands in
		// the machine-browse branch below; wire paths always use "/".
		if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) {
			raw = (raw === "~" ? homedir() : homedir() + raw.slice(1)).split(sep).join("/");
		}

		// ---- 机器根（此电脑：盘符列表）—— 工作区之上的虚拟层 ----
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

		// ---- 绝对路径浏览（Windows 盘符 / posix "/"）：允许越过工作区根 ----
		// 机器模式不设 watcher（工作区递归 watch 不覆盖别的盘），文件变动靠 10s 轮询。
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

		// ---- 工作区相对视图（原有行为） ----
		const target = raw ? resolve(root, raw) : root;
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
		const { entries, truncated, error, errorCode } = await readDirForUI(target, rel);
		// Watch the listed directory only after a successful read — a missing
		// dir must not create a watcher on a phantom path (issue #74).
		if (error) {
			this.emitListError(rel === "" ? root : rel, error, errorCode);
		} else {
			this.watchDir(target, rel);
		}
		const rootWire = normWirePath(root.split(sep).join("/"));
		this.host.emit({
			type: "files",
			path: rel === "" ? "" : rel,
			// 工作区根也允许「上一级」→ 项目文件夹的上一级（盘符根则到机器根，posix 根无父级）。
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
		const q = query.trim().toLowerCase();
		if (!q) {
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
				let isDir = d.isDirectory();
				if (d.isSymbolicLink()) {
					// Follow directory symlinks (Termux's ~/storage/*); the depth
					// cap doubles as a symlink-cycle guard, budgets bound the cost.
					try {
						isDir = (await fsp.stat(join(abs, d.name))).isDirectory();
					} catch {
						isDir = false; // broken link — treat as file
					}
				}
				if (d.name.toLowerCase().includes(q)) {
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
					// Path stays inside the workspace (defense in depth — paths come
					// from our own listing, and execFile passes args verbatim anyway).
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
				// 机器浏览：绝对路径直接读；回显用绝对 wire 形式（前端按 path 匹配）。
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
			// Office 文档（docx/xlsx/xlsm）：转 Markdown 文本下发，前端按 Markdown
			// 渲染表格/段落——文件树、附件、预览弹窗随处可看。失败回落到底下旧分支。
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
						});
						return;
					}
				} catch {
					/* 解析失败（加密/损坏/非预期结构）→ 回落旧的二进制嗅探分支 */
				}
			}
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
			writeFileSync(abs, text, "utf8");
			this.host.emit({
				type: "notice",
				level: "info",
				text: `已保存：${rel}`,
				textEn: `Saved: ${rel}`,
			});
			// Re-read through the same path as the preview request so the client
			// gets the canonical content, line count and file size after saving.
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

	/**
	 * Upload a file (base64, no data: prefix) INTO a workspace directory —
	 * the file manager's right-click “upload here” action. The target dir may
	 * be nested and is created on demand; the name is basename-sanitized so a
	 * malicious payload can't escape the directory. Emits notice + file_changed
	 * for the target dir (the recursive watcher may not cover it on posix).
	 */
	async uploadFile(relDir: string, name: string, data: string): Promise<void> {
		const root = this.host.getCwd();
		if (isRemoteWorkspaceUri(root)) {
			await this.uploadRemoteFile(root, relDir, name, data);
			return;
		}
		const emitErr = (text: string, textEn?: string) => this.host.emit({ type: "notice", level: "error", text, textEn });
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
				// 机器浏览的目录（可能是盘符根 "C:"）：按绝对路径解析。
				wp = { abs: wireToAbs(relDir), rel: wireToAbs(relDir).split(sep).join("/") };
			} else {
				wp = { abs: root, rel: "" };
			}
			// 与 createEntry/renameEntry 同口径（this.sanitizeName）：只取 basename，
			// 空 / "." / ".." / Windows 保留名 / 尾点空格一律拒绝 —— 旧的内联替换
			// 会放过 "con.txt"、"a.." 这类「建了删不掉」的名字。
			const safe = this.sanitizeName(name);
			if (!safe) {
				emitErr(`文件名不合法：${name}`, `Invalid file name: ${name}`);
				return;
			}
			const abs = resolve(wp.abs, safe);
			let uploadRel: string;
			if (absDir) {
				// 绝对目录模式不再校验工作区归属（机器浏览）。
				uploadRel = abs.split(sep).join("/");
			} else {
				const rawRel = relative(root, abs);
				if (rawRel.startsWith("..") || rawRel.includes(`${sep}..`)) {
					emitErr(`文件名不合法：${name}`, `Invalid file name: ${name}`);
					return;
				}
				uploadRel = rawRel.split(sep).join("/");
			}
			if (isUploadDataTooLong(data.length)) {
				emitErr(
					`文件过大：${name}（上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）`,
					`File too large: ${name} (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)`,
				);
				return;
			}
			const buf = Buffer.from(data, "base64");
			if (buf.length === 0) {
				emitErr(`空文件：${name}`, `Empty file: ${name}`);
				return;
			}
			if (buf.length > MAX_UPLOAD_BYTES) {
				emitErr(
					`文件过大：${name}（上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）`,
					`File too large: ${name} (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)`,
				);
				return;
			}
			mkdirSync(wp.abs, { recursive: true });
			if (existsSync(abs)) {
				emitErr(`已存在：${uploadRel}`, `Already exists: ${uploadRel}`);
				return;
			}
			// wx：与预检之间存在窗口（TOCTOU），并发同名上传走 EEXIST 落到 catch
			// 报错 —— 两个上传路径语义统一为「目标已存在拒绝」，绝不静默截断覆盖
			// （/api/file-transfer/upload 一直是 open(dest, "wx") 拒绝）。
			writeFileSync(abs, buf, { flag: "wx" });
			this.host.emit({
				type: "notice",
				level: "info",
				text: `已上传：${uploadRel}`,
				textEn: `Uploaded: ${uploadRel}`,
			});
			// Emit for the target directory itself so the panel refreshes even
			// when the active listing/preview isn't that dir (posix watcher only
			// sees the LISTED directory).
			this.host.emit({
				type: "file_changed",
				path: wp.rel,
			});
		} catch (err) {
			emitErr(`上传文件失败：${(err as Error).message}`, `Upload failed: ${(err as Error).message}`);
		}
	}

	/**
	 * Create a folder. Accepts absolute, ~-prefixed or session-relative paths
	 * (same expansion rules as completePath — the cwd picker may browse outside
	 * the session root, and set_cwd itself accepts any directory). Answers
	 * with a notice; the picker refreshes its listing on its own.
	 */
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

	/* ---- 文件树右键菜单的文件操作（`contextmenu.file`，见 protocol.ts file_*） ---- */

	/** 右键文件操作共用的路径解析：绝对 wire（机器浏览）直接转原生绝对路径；
	 *  相对路径限定在工作区内（越界 → null，与 readFile/writeFile 同口径）。
	 *  空串（工作区根须由调用方特判）与机器根 "@root" 本身不可作为操作对象 → null。 */
	private resolveOpTarget(raw: string): { abs: string } | null {
		const wire = normWirePath(raw.trim());
		if (!wire || wire === MACHINE_ROOT) return null;
		if (isAbsoluteWirePath(wire)) return { abs: wireToAbs(wire) };
		const w = workspacePath(resolve(this.host.getCwd()), wire);
		return w ? { abs: w.abs } : null;
	}

	/** 文件名清洗（与 uploadFile 同口径再收紧）：只取 basename，去 Windows 非法字符；
	 *  空/纯点/尾点空格/Windows 保留名 → null（建了删不掉的东西不如直接拒绝）。 */
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

	/** wire 路径的父目录（wire 字符串层面切分，保证 file_changed 与前端 currentPath 同形）。
	 *  工作区根 "" / 机器根 / posix 根 "/" / 盘符根 → null（这些不可重命名/删除/作复制源）。 */
	private wireParent(wire: string): string | null {
		const w = normWirePath(wire.trim());
		if (!w || w === MACHINE_ROOT || w === "/" || /^[A-Za-z]:$/.test(w)) return null;
		const i = w.lastIndexOf("/");
		if (i < 0) return ""; // 工作区相对单层 → 工作区根
		if (i === 0) return "/"; // "/a" → "/"
		return w.slice(0, i);
	}

	/** destDir（wire，空串 = 工作区根）→ 原生绝对目录；不存在/非目录 → null（调用方报错）。 */
	private async resolveOpDir(dir: string): Promise<{ abs: string; wire: string } | null> {
		const fsp = await import("node:fs/promises");
		if (!dir.trim()) return { abs: resolve(this.host.getCwd()), wire: "" };
		const t = this.resolveOpTarget(dir);
		if (!t) return null;
		const st = await fsp.stat(t.abs).catch(() => null);
		if (!st?.isDirectory()) return null;
		return { abs: t.abs, wire: normWirePath(dir.trim()) };
	}

	/** 在 dir 下新建空文件或空文件夹。已存在不覆盖（报错）；成功后对 dir 推 file_changed。 */
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
			if (kind === "dir") await fsp.mkdir(abs);
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

	/** 同目录内重命名（newName 只取 basename，不跨目录）。成功后对父目录推 file_changed。 */
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

	/** 删除文件或目录（目录递归删）。工作区根/机器根/盘符根拒绝；成功后对父目录推 file_changed。 */
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

	/** 复制或移动（move=true 即剪切粘贴）。destDir 与源同目录即「创建副本」；
	 *  重名自动加 " copy" 后缀；目录搬进自身/子目录拒绝；跨盘移动回落为复制+删源。 */
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
			// 目录搬进自身或子目录 → 无限递归，必须拒绝（文件无此问题，但统一判一次）。
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
					// 跨盘/跨挂载点 rename 报 EXDEV → 回落复制+删源（与文件管理器同行为）。
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

	/** 副本目标去重："a.txt" → "a copy.txt" → "a copy 2.txt"…（目录/无后缀同理）。 */
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
	/** 系统原生打开/定位的公共执行体（issue #187）：cmd/args 已按平台组装好。
	 *  spawn 成功即算送达（explorer/open 都是 daemon 式返回，exit code 不可信）；
	 *  ENOENT（headless/无桌面）等失败一律 warning notice，绝不抛。 */
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
			// ⚠ 这里绝不能加 windowsHide: true：它经 STARTF_USESHOWWINDOW + SW_HIDE 压住子进程首窗口，
			// explorer/open 起的是 GUI（无控制台可藏），加了之后进程在、窗口永远不出来
			// （2026-09 实测：notepad/explorer 同参数起，进程 session 1 正常、桌面无窗口；去掉即现）。
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
				// 极端平台无 spawn 事件时兜底放行（进程已脱离，成败不再可知）。
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

	/** 在系统资源管理器中定位（issue #187）：文件→打开目录并选中该文件，目录→直接打开。
	 *  只读操作（不改文件），保护根/盘符根也允许；@root 本体与越界路径拒绝。 */
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
				// /select, 与路径分两个 argv 传（explorer 对此格式稳定支持，路径含空格也无碍）。
				// 目录传 /n, 强制打开新窗口，防止若该目录已在后台打开时被 Windows 静默复用且因反抢焦点机制不置顶。
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
				// Linux 无统一选中语义：打开其父目录（目录则打开自身）。
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

	/** 用系统默认应用打开文件（issue #187）：仅文件；目录请用 reveal。 */
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
			// explorer 直接跟路径即走默认关联打开（含空格路径单 argv，无拆分问题）。
			const cmd = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
			await this.spawnDetached(cmd, [t.abs], "已用默认应用打开：" + base, "Opened with default app: " + base);
		} catch (e) {
			err("打开失败：" + (e as Error).message, "Open failed: " + (e as Error).message);
		}
	}

	/**
	 * Path completion for the cwd input: expand ~/relative paths, list the parent
	 * directory, and return prefix matches (dirs first, capped).
	 */
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

			// ---- 机器根（此电脑/盘符列表）----
			if (rawInput === MACHINE_ROOT || rawInput === MACHINE_ROOT + "/") {
				this.host.emit({ type: "path_completions", completions: await this.machineRootEntries() });
				return;
			}

			// ---- Windows 盘符输入："D"（补全到盘符，Tab 即换盘）/ "D:"（列盘根）----
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
					// 已带冒号：直接列出盘根条目。
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
				// 只有字母：补全到盘符本身。
				this.host.emit({ type: "path_completions", completions: [{ name: drive, path: drive, type: "dir" }] });
				return;
			}

			// Expand ~ and relative inputs to an absolute path. Windows users type
			// backslashes (P:\agent) and ~\ — handle both separator styles.
			let expanded = rawInput;
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
			const completions = (
				await Promise.all(
					dirents
						.filter((d) => d.name.startsWith(prefix) && !ignoredEntries().has(d.name))
						.map((d) => classifyDirent(d, dirPart)),
				)
			)
				.map((e) => ({
					...e,
					// Windows users type backslashes — normalize the completion to the
					// wire format ("/") so the picked path round-trips cleanly.
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

	// =========================================================================
	// 远程 SSH 工作区 (ssh://...) 专属文件操作实现
	// =========================================================================

	private resolveRemoteTarget(
		rawCwd: string,
		p: string,
		allowRoot: boolean = false,
	): { abs: string; rel: string; parentRel: string; absolute: boolean } | null {
		const parsed = parseRemoteWorkspaceUri(rawCwd);
		if (!parsed) return null;
		const trimmed = (p || "").trim();
		if (trimmed === MACHINE_ROOT || trimmed === MACHINE_ROOT + "/") return null;
		if (!trimmed) {
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
		const q = query.trim().toLowerCase();
		if (!q) {
			this.host.emit({ type: "search_files_result", reqId, ok: true, results: [] });
			return;
		}
		const sshSvc = getGlobalRemoteSshService();
		if (!sshSvc) {
			this.host.emit({ type: "search_files_result", reqId, ok: false, results: [] });
			return;
		}
		try {
			const cmd = `find . -maxdepth 8 \\( -name node_modules -o -name .git -o -name .pi-web \\) -prune -o -print 2>/dev/null | head -n 5000`;
			const res = await sshSvc.execInWorkspace(rawCwd, cmd, { timeoutMs: 8000 });
			const lines = res.stdout.split(/\r?\n/);
			const results: FileSearchResult[] = [];
			let truncated = false;
			for (const line of lines) {
				const clean = line.trim().replace(/^\.\//, "");
				if (!clean || clean === ".") continue;
				const name = posix.basename(clean);
				if (name.toLowerCase().includes(q)) {
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
						});
						return;
					}
				} catch {}
			}
			const kind = previewKind(name);
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

	private async uploadRemoteFile(rawCwd: string, relDir: string, name: string, data: string): Promise<void> {
		const emitErr = (text: string, textEn?: string) => this.host.emit({ type: "notice", level: "error", text, textEn });
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
			if (isUploadDataTooLong(data.length)) {
				emitErr(`文件过大：${name}`, `File too large: ${name}`);
				return;
			}
			const buf = Buffer.from(data, "base64");
			if (buf.length === 0 || buf.length > MAX_UPLOAD_BYTES) {
				emitErr(`文件大小不合法：${name}`, `Invalid file size: ${name}`);
				return;
			}
			const destAbs = posix.join(dirTarget.abs, safe);
			const exists = await sshSvc.sftpStat(rawCwd, destAbs).catch(() => null);
			if (exists) {
				emitErr(`已存在：${safe}`, `Already exists: ${safe}`);
				return;
			}
			await sshSvc.sftpWriteFile(rawCwd, destAbs, buf, { createParents: true });
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
