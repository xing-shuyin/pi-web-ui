/**
 * Read-only git queries backing the source-control panel.
 *
 * Replaces the old hidden-PTY + text-scraping approach: every query is a
 * plain `execFile("git", …)` — no shell, no prompts, no echo, no sentinel
 * parsing. Output is parsed into structured JSON on the server; the client
 * just renders it.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pick, type ServerLang } from "./i18n.js";
import { getGlobalRemoteSshService, isRemoteWorkspaceUri, shellQuotePosix } from "./remote-ssh-service.js";

const exec = promisify(execFile);

/** Per-command timeout / output cap — a stuck repo must not hang the panel. */
const GIT_TIMEOUT_MS = 15_000;
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

export interface ScmFileEntry {
	path: string;
	x: string;
	y: string;
}

export interface ScmBranchEntry {
	name: string;
	current: boolean;
	/** Remote name for remote-tracking refs ("origin/main" → "origin");
	 *  true when the remote can't be determined. */
	remote?: string | boolean;
}

export interface ScmCommitEntry {
	hash: string;
	shortHash: string;
	author: string;
	date: string;
	subject: string;
	decorations: string;
	/** The graph prefix emitted by `git log --graph` (for example `| * `). */
	graph: string;
}

export interface ScmStatusData {
	notRepo: boolean;
	branch: string;
	detached: boolean;
	upstream: string | null;
	ahead: number;
	behind: number;
	upstreamGone: boolean;
	files: ScmFileEntry[];
	branches: ScmBranchEntry[];
	/** path → [added, deleted] line counts (worktree + staged combined). */
	stats: Record<string, [number, number]>;
}

/** Run one git command; throws Error with a readable message on failure. */
async function git(cwd: string, args: string[], lang?: () => ServerLang): Promise<string> {
	const l = lang?.() ?? "en";
	if (isRemoteWorkspaceUri(cwd)) {
		const sshSvc = getGlobalRemoteSshService();
		if (!sshSvc) {
			throw new Error("Remote SSH service is not initialized");
		}
		const cmd = `git -c core.quotepath=false ${args.map(shellQuotePosix).join(" ")}`;
		const res = await sshSvc.execInWorkspace(cwd, cmd, { timeoutMs: GIT_TIMEOUT_MS });
		if (res.exitCode !== 0) {
			const detail = (res.stderr || res.stdout || "").trim().split("\n")[0];
			throw new Error(detail || pick(l, "git 命令失败", "git command failed", "scm.git.failed"));
		}
		return res.stdout;
	}
	try {
		const { stdout } = await exec("git", ["-c", "core.quotepath=false", ...args], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: MAX_GIT_OUTPUT,
			windowsHide: true,
		});
		return stdout;
	} catch (err) {
		const e = err as { message?: string; stderr?: string; killed?: boolean; code?: string };
		if (e.code === "ENOENT")
			throw new Error(
				pick(
					l,
					"未找到 git 命令——请确认已安装 Git 并在 PATH 中",
					"git command not found — make sure Git is installed and on PATH",
					"scm.git.not.found",
				),
			);
		if (e.killed) throw new Error(pick(l, "git 命令超时", "git command timed out", "scm.git.timeout"));
		const detail = (e.stderr ?? e.message ?? "").trim().split("\n")[0];
		throw new Error(detail || pick(l, "git 命令失败", "git command failed", "scm.git.failed"));
	}
}

/** Absolute path of the repo's git dir (handles worktrees/submodules), or
 *  null when cwd isn't inside a repository. */
export async function gitDirOf(cwd: string): Promise<string | null> {
	if (isRemoteWorkspaceUri(cwd)) return null;
	try {
		const { stdout } = await exec("git", ["rev-parse", "--absolute-git-dir"], {
			cwd,
			timeout: 5_000,
			windowsHide: true,
		});
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

/** True when the error is "this directory isn't a git repository". */
export function isNotRepoError(err: unknown): boolean {
	return /not a git repository/i.test(err instanceof Error ? err.message : String(err));
}

/* ------------------------------------------------------------------ */
/* parsers                                                             */
/* ------------------------------------------------------------------ */

/** Undo git's C-style quoting for unusual file names ("a\tb" → a<TAB>b).
 *  core.quotepath=false already handles non-ASCII; this covers control chars. */
function unquotePath(s: string): string {
	if (!s.startsWith('"')) return s;
	const inner = s.endsWith('"') ? s.slice(1, -1) : s.slice(1);
	return inner.replace(/\\(.)/g, (_m, c: string) => {
		switch (c) {
			case "n":
				return "\n";
			case "t":
				return "\t";
			case "r":
				return "\r";
			case "b":
				return "\b";
			case "a":
				// eslint-disable-next-line no-useless-escape -- bell escape for git C-style quoting
				return "\a";
			case "f":
				return "\f";
			case "v":
				return "\v";
			case "\\":
				return "\\";
			case '"':
				return '"';
			default:
				return c;
		}
	});
}

interface StatusHeader {
	branch: string;
	detached: boolean;
	upstream: string | null;
	ahead: number;
	behind: number;
	upstreamGone: boolean;
}

function parseStatusHeader(rest: string): StatusHeader {
	const out: StatusHeader = {
		branch: "HEAD",
		detached: false,
		upstream: null,
		ahead: 0,
		behind: 0,
		upstreamGone: false,
	};
	let branchPart = rest;
	let flags = "";
	const bi = rest.indexOf(" [");
	if (bi >= 0) {
		branchPart = rest.slice(0, bi);
		flags = rest.slice(bi + 2);
		if (flags.endsWith("]")) flags = flags.slice(0, -1);
	}
	if (branchPart === "HEAD (no branch)" || branchPart === "HEAD") {
		out.detached = true;
	} else {
		if (branchPart.startsWith("No commits yet on ")) branchPart = branchPart.slice("No commits yet on ".length);
		const up = branchPart.indexOf("...");
		if (up >= 0) {
			out.branch = branchPart.slice(0, up);
			out.upstream = branchPart.slice(up + 3);
		} else {
			out.branch = branchPart;
		}
	}
	if (flags) {
		for (const part of flags.split(",")) {
			const p = part.trim();
			const m = p.match(/^(ahead|behind) (\d+)$/);
			if (m) {
				if (m[1] === "ahead") out.ahead = Number(m[2]);
				else out.behind = Number(m[2]);
			} else if (p === "gone") {
				out.upstreamGone = true;
			}
		}
	}
	return out;
}

function parseStatusFiles(text: string): ScmFileEntry[] {
	const out: ScmFileEntry[] = [];
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trimEnd();
		if (!line || line.startsWith("## ")) continue;
		if (line.length >= 3) {
			let path = line.slice(3);
			const arrow = path.indexOf(" -> "); // rename: "R  old -> new"
			if (arrow >= 0) path = path.slice(arrow + 4);
			out.push({ path: unquotePath(path), x: line[0], y: line[1] });
		}
	}
	return out;
}

function parseBranches(text: string): ScmBranchEntry[] {
	const out: ScmBranchEntry[] = [];
	for (const line of text.split("\n")) {
		const parts = line.split("\t");
		if (parts.length < 2) continue;
		const ref = parts[0];
		const isHead = parts[1] === "*";
		if (ref.startsWith("refs/heads/")) {
			out.push({ name: ref.slice("refs/heads/".length), current: isHead });
		} else if (ref.startsWith("refs/remotes/")) {
			const short = ref.slice("refs/remotes/".length);
			// Skip the "origin/HEAD -> origin/main" symlink.
			if (short.endsWith("/HEAD")) continue;
			const slash = short.indexOf("/");
			out.push({
				name: short,
				current: false,
				remote: slash > 0 ? short.slice(0, slash) : true,
			});
		}
	}
	return out;
}

/** Parse `git log --graph --pretty=format:%H%x09…` preserving graph prefixes. */
function parseCommitHistory(text: string): ScmCommitEntry[] {
	const out: ScmCommitEntry[] = [];
	for (const line of text.split("\n")) {
		const tab = line.indexOf("\t");
		if (tab < 0) continue; // connector-only graph line
		const prefixAndHash = line.slice(0, tab);
		const match = prefixAndHash.match(/([0-9a-f]{7,40})$/i);
		if (!match || match.index === undefined) continue;
		const fields = line.slice(tab + 1).split("\t");
		// An empty decoration field removes the final tab — four fields is a
		// valid undecorated commit.
		if (fields.length < 4) continue;
		out.push({
			hash: match[1],
			shortHash: fields[0],
			author: fields[1],
			date: fields[2],
			subject: fields[3],
			decorations: fields[4] ?? "",
			graph: prefixAndHash.slice(0, match.index),
		});
	}
	return out;
}

/** Parse `git diff --numstat` output: "12\t3\tpath" → { path: [add, del] }. */
function parseNumStat(text: string): Record<string, [number, number]> {
	const stats: Record<string, [number, number]> = {};
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const tab1 = line.indexOf("\t");
		const tab2 = tab1 < 0 ? -1 : line.indexOf("\t", tab1 + 1);
		if (tab2 < 0) continue;
		let add = Number(line.slice(0, tab1));
		let del = Number(line.slice(tab1 + 1, tab2));
		if (!Number.isFinite(add)) add = 0; // binary file → "-"
		if (!Number.isFinite(del)) del = 0;
		const path = unquotePath(line.slice(tab2 + 1).trim());
		const prev = stats[path];
		stats[path] = [(prev?.[0] ?? 0) + add, (prev?.[1] ?? 0) + del];
	}
	return stats;
}

/* ------------------------------------------------------------------ */
/* queries                                                             */
/* ------------------------------------------------------------------ */

const HISTORY_ARGS = [
	"log",
	"--all",
	"--graph",
	"--decorate=short",
	"--date=short",
	"--pretty=format:%H%x09%h%x09%an%x09%ad%x09%s%x09%D",
	"-n",
	"120",
];

/** Commit graph for the history tab — fetched lazily so the common
 *  "changes" view never pays for it on huge repos. */
export async function scmHistory(cwd: string, lang?: () => ServerLang): Promise<ScmCommitEntry[]> {
	return parseCommitHistory(await git(cwd, HISTORY_ARGS, lang));
}

/** Status refresh payload (status + branches + numstat) — parallel. */
export async function scmStatus(cwd: string, lang?: () => ServerLang): Promise<Omit<ScmStatusData, "history">> {
	const [statusText, branchText, statText, cachedStatText] = await Promise.all([
		git(cwd, ["status", "--porcelain=v1", "-b", "--find-renames"], lang),
		git(cwd, ["for-each-ref", "refs/heads", "refs/remotes", "--format=%(refname)%09%(HEAD)"], lang),
		git(cwd, ["diff", "--numstat"], lang),
		git(cwd, ["diff", "--cached", "--numstat"], lang),
	]);
	const header = parseStatusHeader(
		statusText
			.split("\n")
			.find((l) => l.startsWith("## "))
			?.slice(3) ?? "",
	);
	// Worktree + staged line counts, merged per path.
	const merged: Record<string, [number, number]> = {};
	for (const [path, pair] of Object.entries(parseNumStat(statText))) {
		merged[path] = pair;
	}
	for (const [path, pair] of Object.entries(parseNumStat(cachedStatText))) {
		const prev = merged[path];
		merged[path] = [(prev?.[0] ?? 0) + pair[0], (prev?.[1] ?? 0) + pair[1]];
	}
	return {
		notRepo: false,
		branch: header.branch,
		detached: header.detached,
		upstream: header.upstream,
		ahead: header.ahead,
		behind: header.behind,
		upstreamGone: header.upstreamGone,
		files: parseStatusFiles(statusText),
		branches: parseBranches(branchText),
		stats: merged,
	};
}

/** Staged + worktree diffs for one file (empty strings when no diff). */
export async function scmFileDiff(
	cwd: string,
	path: string,
	lang?: () => ServerLang,
): Promise<{ staged: string; worktree: string }> {
	const [staged, worktree] = await Promise.all([
		git(cwd, ["diff", "--cached", "--no-color", "--no-ext-diff", "--", path], lang).catch(() => ""),
		git(cwd, ["diff", "--no-color", "--no-ext-diff", "--", path], lang).catch(() => ""),
	]);
	return { staged, worktree };
}

/** Full patch of one commit (`git show`). */
export async function scmCommitDetail(cwd: string, hash: string, lang?: () => ServerLang): Promise<string> {
	return git(
		cwd,
		["show", "--no-color", "--no-ext-diff", "--find-renames", "--format=fuller", "--stat", "--patch", hash],
		lang,
	);
}

/* ------------------------------------------------------------------ */
/* AI commit-message context                                           */
/* ------------------------------------------------------------------ */

/** Cap per patch (staged / worktree) fed to the commit-message prompt —
 *  enough for the model to see what most commits are about without letting
 *  one huge repo blow up the one-off completion request. */
const MAX_COMMITMSG_PATCH_CHARS = 12_000;

/** Everything the commit-message generator needs, gathered in one pass.
 *  Structured on purpose: rendering/truncation decisions live in the pure
 *  prompt builder (scm-commitmsg.ts) so they are unit-testable. */
export interface ScmCommitContext {
	/** Recent commit subjects, newest first — style & language reference. */
	subjects: string[];
	/** True when the repo has no commits yet (no style reference exists). */
	emptyRepo: boolean;
	/** porcelain entries (staged + unstaged + untracked; renames resolved). */
	files: ScmFileEntry[];
	/** path → [added, deleted] for the staged diff. */
	stagedStat: Record<string, [number, number]>;
	/** path → [added, deleted] for the worktree diff. */
	worktreeStat: Record<string, [number, number]>;
	/** Staged patch (capped at MAX_COMMITMSG_PATCH_CHARS; marker appended). */
	stagedPatch: string;
	/** Worktree patch (capped the same way). */
	worktreePatch: string;
}

/** Cap one patch at MAX_COMMITMSG_PATCH_CHARS, keeping the head (early files
 *  matter most for a commit message) and marking the cut. */
function capPatch(text: string): string {
	if (text.length <= MAX_COMMITMSG_PATCH_CHARS) return text;
	return `${text.slice(0, MAX_COMMITMSG_PATCH_CHARS)}\n… (diff truncated)`;
}

/** Gather staged/worktree patches, numstats, status and recent subjects for
 *  the AI commit-message generator. Throws the usual git errors (including
 *  "not a git repository") — the caller maps them to friendly replies. */
export async function scmCommitContext(cwd: string, lang?: () => ServerLang): Promise<ScmCommitContext> {
	const [stagedPatch, worktreePatch, stagedStatText, worktreeStatText, statusText, subjectText] = await Promise.all([
		git(cwd, ["diff", "--cached", "--no-color", "--no-ext-diff", "--find-renames"], lang).catch(() => ""),
		git(cwd, ["diff", "--no-color", "--no-ext-diff", "--find-renames"], lang).catch(() => ""),
		git(cwd, ["diff", "--cached", "--numstat"], lang).catch(() => ""),
		git(cwd, ["diff", "--numstat"], lang).catch(() => ""),
		git(cwd, ["status", "--porcelain=v1", "--find-renames"], lang),
		// Empty repos (no commits yet) make `git log` fail — that's a valid
		// "no style reference" answer, not an error worth failing the request.
		git(cwd, ["log", "-n", "15", "--pretty=format:%s"], lang).then(
			(s) => s,
			() => "",
		),
	]);
	const subjects = subjectText
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	return {
		subjects,
		emptyRepo: subjects.length === 0,
		files: parseStatusFiles(statusText),
		stagedStat: parseNumStat(stagedStatText),
		worktreeStat: parseNumStat(worktreeStatText),
		stagedPatch: capPatch(stagedPatch),
		worktreePatch: capPatch(worktreePatch),
	};
}
