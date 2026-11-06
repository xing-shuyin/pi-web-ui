import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pick, type ServerLang } from "./i18n.js";
import { getGlobalRemoteSshService, isRemoteWorkspaceUri, shellQuotePosix } from "./remote-ssh-service.js";

const exec = promisify(execFile);

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
	remote?: string | boolean;
}

export interface ScmCommitEntry {
	hash: string;
	shortHash: string;
	author: string;
	date: string;
	subject: string;
	decorations: string;
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
	stats: Record<string, [number, number]>;
}

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

export function isNotRepoError(err: unknown): boolean {
	return /not a git repository/i.test(err instanceof Error ? err.message : String(err));
}

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
			const arrow = path.indexOf(" -> ");
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

function parseCommitHistory(text: string): ScmCommitEntry[] {
	const out: ScmCommitEntry[] = [];
	for (const line of text.split("\n")) {
		const tab = line.indexOf("\t");
		if (tab < 0) continue;
		const prefixAndHash = line.slice(0, tab);
		const match = prefixAndHash.match(/([0-9a-f]{7,40})$/i);
		if (!match || match.index === undefined) continue;
		const fields = line.slice(tab + 1).split("\t");
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

function parseNumStat(text: string): Record<string, [number, number]> {
	const stats: Record<string, [number, number]> = {};
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const tab1 = line.indexOf("\t");
		const tab2 = tab1 < 0 ? -1 : line.indexOf("\t", tab1 + 1);
		if (tab2 < 0) continue;
		let add = Number(line.slice(0, tab1));
		let del = Number(line.slice(tab1 + 1, tab2));
		if (!Number.isFinite(add)) add = 0;
		if (!Number.isFinite(del)) del = 0;
		const path = unquotePath(line.slice(tab2 + 1).trim());
		const prev = stats[path];
		stats[path] = [(prev?.[0] ?? 0) + add, (prev?.[1] ?? 0) + del];
	}
	return stats;
}

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

export async function scmHistory(cwd: string, lang?: () => ServerLang): Promise<ScmCommitEntry[]> {
	return parseCommitHistory(await git(cwd, HISTORY_ARGS, lang));
}

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

export async function scmCommitDetail(cwd: string, hash: string, lang?: () => ServerLang): Promise<string> {
	return git(
		cwd,
		["show", "--no-color", "--no-ext-diff", "--find-renames", "--format=fuller", "--stat", "--patch", hash],
		lang,
	);
}

const MAX_COMMITMSG_PATCH_CHARS = 12_000;

export interface ScmCommitContext {
	subjects: string[];
	emptyRepo: boolean;
	files: ScmFileEntry[];
	stagedStat: Record<string, [number, number]>;
	worktreeStat: Record<string, [number, number]>;
	stagedPatch: string;
	worktreePatch: string;
}

function capPatch(text: string): string {
	if (text.length <= MAX_COMMITMSG_PATCH_CHARS) return text;
	return `${text.slice(0, MAX_COMMITMSG_PATCH_CHARS)}\n… (diff truncated)`;
}

export async function scmCommitContext(cwd: string, lang?: () => ServerLang): Promise<ScmCommitContext> {
	const [stagedPatch, worktreePatch, stagedStatText, worktreeStatText, statusText, subjectText] = await Promise.all([
		git(cwd, ["diff", "--cached", "--no-color", "--no-ext-diff", "--find-renames"], lang).catch(() => ""),
		git(cwd, ["diff", "--no-color", "--no-ext-diff", "--find-renames"], lang).catch(() => ""),
		git(cwd, ["diff", "--cached", "--numstat"], lang).catch(() => ""),
		git(cwd, ["diff", "--numstat"], lang).catch(() => ""),
		git(cwd, ["status", "--porcelain=v1", "--find-renames"], lang),
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
