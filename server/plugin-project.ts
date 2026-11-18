import { existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { readdir as fspReaddir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gitEnv, runGit } from "./git-run.js";
import { runProcess, type RunProcessResult } from "./run-process.js";

/** 调用方（`deps.gitTimeoutMs`）缺省值：clone 是慢命令，不能用 git-run 的 15s 默认。 */
const DEFAULT_CALLER_GIT_TIMEOUT_MS = 5 * 60_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 32;
const MAX_LINE_CHARS = 400;
const MAX_LOG_LINES = 500;
const MAX_STDERR_TAIL = 1200;
const MAX_ANCESTOR_HOPS = 64;

export interface ProjectRepoSpec {
	url: string;
	subdir?: string;
	ref?: string;
	replace?: boolean;
}

export interface ProjectCreateSpec {
	dir: string;
	repos?: ProjectRepoSpec[];
	files?: Record<string, string>;
	gitInit?: boolean;
}

export interface ProjectCreateResult {
	ok: boolean;
	error?: string;
	log: string[];
	dir: string;
}

export interface ProjectCreateDeps {
	onProgress?: (line: string) => void;
	gitTimeoutMs?: number;
	gitBin?: string;
}

function foldCase(p: string): string {
	return process.platform === "win32" ? p.toLowerCase() : p;
}

export function samePath(a: string, b: string): boolean {
	return foldCase(resolve(a)) === foldCase(resolve(b));
}

export function isInsideRoot(root: string, abs: string): boolean {
	const rel = relative(foldCase(root), foldCase(abs));
	if (rel === "") return true;
	if (isAbsolute(rel)) return false;
	return rel !== ".." && !rel.startsWith(`..${sep}`);
}

export function resolveInsideRoot(root: string, raw: string): string | null {
	if (typeof raw !== "string") return null;
	if (raw === "" || raw.includes("\0")) return null;
	if (isAbsolute(raw)) return null;
	const abs = resolve(root, raw);
	return isInsideRoot(root, abs) ? abs : null;
}

function realpathOf(p: string): string {
	try {
		return realpathSync.native(p);
	} catch {
		return realpathSync(p);
	}
}

export function realPathOfNearest(abs: string): string | null {
	let probe = abs;
	for (let i = 0; i < MAX_ANCESTOR_HOPS; i++) {
		try {
			return realpathOf(probe);
		} catch {
			const parent = dirname(probe);
			if (parent === probe) return null;
			probe = parent;
		}
	}
	return null;
}

function toSlash(p: string): string {
	return p.split(sep).join("/");
}

async function findSymlinks(dir: string): Promise<string[]> {
	const out: string[] = [];
	let entries: Dirent[];
	try {
		entries = await fspReaddir(dir, { recursive: true, withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (!e.isSymbolicLink()) continue;
		const parent = e.parentPath ?? dir;
		out.push(join(parent, e.name));
	}
	return out;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function gitEnvExtra(): NodeJS.ProcessEnv {
	return {
		GIT_PAGER: "cat",
		GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
	};
}

interface GitRunResult {
	code: number;
	spawnError?: string;
	timedOut: boolean;
	stderrTail: string;
}

/**
 * 跑一条 git 命令：默认走单源 `runGit`（逐行日志走 `onLine` / `onStderrLine`）；
 * 只有显式注入了 `deps.gitBin`（单测的注入点）才退回 `runProcess`，因为 `runGit` 只会跑 `git`。
 */
async function gitRun(
	bin: string,
	args: string[],
	opts: { cwd: string; timeoutMs: number; onLine: (line: string) => void },
): Promise<GitRunResult> {
	const stderrLines: string[] = [];
	// 归一行内残留的 \r（git 进度条），保留旧实现的日志形态。
	const normalize = (raw: string): string | null => {
		const line = raw.replace(/\r/g, " ").trimEnd();
		return line === "" ? null : line;
	};
	const onLine = (raw: string) => {
		const line = normalize(raw);
		if (line) opts.onLine(`git: ${line}`);
	};
	const onStderrLine = (raw: string) => {
		const line = normalize(raw);
		if (!line) return;
		stderrLines.push(line);
		opts.onLine(`git: ${line}`);
	};
	const common = { cwd: opts.cwd, timeoutMs: opts.timeoutMs, onLine, onStderrLine };
	const result: RunProcessResult =
		bin === "git"
			? await runGit(args, { ...common, env: gitEnvExtra() })
			: await runProcess({
					cmd: bin,
					args: ["-c", "core.quotepath=false", ...args],
					...common,
					env: gitEnv(gitEnvExtra()),
				});
	let tail = stderrLines.join("\n");
	if (tail.length > MAX_STDERR_TAIL) tail = `…${tail.slice(-MAX_STDERR_TAIL)}`;
	return {
		code: result.code ?? -1,
		timedOut: result.timedOut,
		stderrTail: tail,
		...(result.spawnError ? { spawnError: `无法启动 git（${bin}）：${result.spawnError}` } : {}),
	};
}

interface PlannedRepo {
	url: string;
	ref?: string;
	dest: string;
	destRel: string;
	replace: boolean;
}

interface PlannedFile {
	rel: string;
	abs: string;
	content: string;
}

export async function createProject(
	spec: ProjectCreateSpec,
	deps: ProjectCreateDeps = {},
): Promise<ProjectCreateResult> {
	const log: string[] = [];
	let truncated = false;
	const emit = (line: string) => {
		const text = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
		if (log.length >= MAX_LOG_LINES) {
			truncated = true;
			return;
		}
		log.push(text);
		try {
			deps.onProgress?.(text);
		} catch {}
	};
	let root = typeof spec?.dir === "string" ? spec.dir : "";
	const finish = (ok: boolean, error?: string): ProjectCreateResult => {
		if (truncated) {
			truncated = false;
			log.push(`…（输出超过 ${MAX_LOG_LINES} 行，已截断）`);
		}
		return error === undefined ? { ok, log, dir: root } : { ok, error, log, dir: root };
	};
	const fail = (error: string): ProjectCreateResult => {
		emit(`失败：${error}`);
		return finish(false, error);
	};

	const rawDir = spec?.dir;
	if (typeof rawDir !== "string" || rawDir === "") return fail("缺少项目根目录 dir（必须是非空绝对路径）");
	if (!isAbsolute(rawDir)) return fail(`项目根目录必须是绝对路径：${rawDir}`);
	root = resolve(rawDir);
	try {
		if (!statSync(root).isDirectory()) return fail(`项目根目录不是文件夹：${root}`);
	} catch {
		return fail(`项目根目录不存在：${root}（本模块不创建新的根目录）`);
	}
	const rootReal = realPathOfNearest(root) ?? root;

	const rawRepos = spec?.repos;
	if (rawRepos !== undefined && !Array.isArray(rawRepos)) return fail("repos 必须是数组");
	const plannedRepos: PlannedRepo[] = [];
	const repoItems = rawRepos ?? [];
	for (let i = 0; i < repoItems.length; i++) {
		const item = repoItems[i] as ProjectRepoSpec | undefined;
		const url = typeof item?.url === "string" ? item.url.trim() : "";
		if (url === "") return fail(`repos[${i}].url 必须是非空字符串`);
		if (url.startsWith("-")) return fail(`repos[${i}].url 不能以 "-" 开头（防 git 选项注入）：${url}`);
		const rawRef = item?.ref;
		let ref: string | undefined;
		if (rawRef !== undefined && rawRef !== null && rawRef !== "") {
			if (typeof rawRef !== "string") return fail(`repos[${i}].ref 必须是字符串`);
			ref = rawRef.trim();
			if (ref === "" || ref.startsWith("-")) return fail(`repos[${i}].ref 非法：${String(rawRef)}`);
		}
		const rawSubdir = item?.subdir;
		let dest = root;
		let destRel = ".";
		if (rawSubdir !== undefined && rawSubdir !== null && rawSubdir !== "") {
			if (typeof rawSubdir !== "string") return fail(`repos[${i}].subdir 必须是字符串`);
			const abs = resolveInsideRoot(root, rawSubdir);
			if (abs === null) return fail(`repos[${i}].subdir 路径越界（必须落在 dir 之内）：${rawSubdir}`);
			dest = abs;
			destRel = toSlash(relative(root, abs));
		}
		plannedRepos.push({ url, dest, destRel, replace: item?.replace === true, ...(ref ? { ref } : {}) });
	}

	for (let i = 0; i < plannedRepos.length; i++) {
		const r = plannedRepos[i];
		if (r.replace && samePath(r.dest, root)) {
			return fail(`repos[${i}]: replace 不能用于项目根目录（拒绝删除 dir 本身）`);
		}
		const real = realPathOfNearest(r.dest);
		if (real === null) return fail(`repos[${i}].subdir 无法解析真实路径：${r.destRel}`);
		if (!isInsideRoot(rootReal, real)) {
			return fail(`repos[${i}].subdir 路径越界（符号链接指向 dir 之外）：${r.destRel}`);
		}
	}

	const rawFiles = spec?.files;
	if (rawFiles !== undefined && (rawFiles === null || typeof rawFiles !== "object" || Array.isArray(rawFiles))) {
		return fail("files 必须是「相对路径 → 文本内容」的对象");
	}
	const fileEntries = Object.entries(rawFiles ?? {});
	if (fileEntries.length > MAX_FILES) return fail(`files 条目数超限：${fileEntries.length} > ${MAX_FILES}`);
	const plannedFiles: PlannedFile[] = [];
	for (const [rel, content] of fileEntries) {
		const abs = resolveInsideRoot(root, rel);
		if (abs === null) return fail(`files 路径越界或非法（必须是 dir 内的相对路径）：${rel}`);
		if (typeof content !== "string") return fail(`files["${rel}"] 必须是字符串内容`);
		const bytes = Buffer.byteLength(content, "utf8");
		if (bytes > MAX_FILE_BYTES) return fail(`files["${rel}"] 超过单文件上限 1MB（${bytes} 字节）`);
		const real = realPathOfNearest(abs);
		if (real === null || !isInsideRoot(rootReal, real)) {
			return fail(`files 路径越界（符号链接指向 dir 之外）：${rel}`);
		}
		plannedFiles.push({ rel: toSlash(relative(root, abs)), abs, content });
	}

	const gitBin = deps.gitBin && deps.gitBin.trim() !== "" ? deps.gitBin : "git";
	const timeoutMs = deps.gitTimeoutMs && deps.gitTimeoutMs > 0 ? deps.gitTimeoutMs : DEFAULT_CALLER_GIT_TIMEOUT_MS;
	const gitFailReason = (what: string, res: GitRunResult): string | undefined => {
		if (res.spawnError) return res.spawnError;
		if (res.timedOut) return `${what} 超时（> ${Math.round(timeoutMs / 1000)}s）`;
		if (res.code !== 0) return `${what} 失败（退出码 ${res.code}）`;
		return undefined;
	};
	try {
		const clonedThisRun = plannedRepos.filter((r) => !samePath(r.dest, root)).map((r) => r.dest);
		const writtenThisRun: string[] = [];
		const cleanupThisRun = (): void => {
			for (const f of writtenThisRun) {
				try {
					rmSync(f, { force: true });
				} catch {}
			}
			for (const d of clonedThisRun) {
				try {
					rmSync(d, { recursive: true, force: true });
				} catch {}
			}
		};
		for (const r of plannedRepos) {
			const atRoot = samePath(r.dest, root);
			if (!atRoot && existsSync(r.dest)) {
				if (!r.replace) return fail(`目标目录已存在：${r.destRel}（要覆盖请显式 replace:true）`);
				emit(`rm -rf ${r.destRel}`);
				rmSync(r.dest, { recursive: true, force: true });
			}
			if (!atRoot) {
				emit(`mkdir ${r.destRel}`);
				mkdirSync(r.dest, { recursive: true });
			}
			emit(`clone ${r.url} → ${r.destRel}`);
			const args = ["clone", "--depth", "1"];
			if (r.ref) args.push("--branch", r.ref);
			args.push(r.url, r.dest);
			const res = await gitRun(gitBin, args, { cwd: root, timeoutMs, onLine: emit });
			const why = gitFailReason("git clone", res);
			if (why) return fail(`${why}${res.stderrTail === "" ? "" : `：${res.stderrTail}`}`);
		}

		for (const dest of clonedThisRun) {
			const offenders = await findSymlinks(dest);
			if (offenders.length > 0) {
				cleanupThisRun();
				return fail(`仓库包含符号链接（视为恶意仓库拒绝），例如：${toSlash(relative(root, offenders[0]!))}`);
			}
		}

		for (const f of plannedFiles) {
			const real = realPathOfNearest(f.abs);
			if (real === null || !isInsideRoot(rootReal, real)) {
				cleanupThisRun();
				return fail(`files 路径越界（clone 后复核：符号链接指向 dir 之外）：${f.rel}`);
			}
			emit(`write ${f.rel}`);
			mkdirSync(dirname(f.abs), { recursive: true });
			writeFileSync(f.abs, f.content, "utf8");
			writtenThisRun.push(f.abs);
		}

		if (spec?.gitInit === true) {
			emit("git init");
			const res = await gitRun(gitBin, ["init"], { cwd: root, timeoutMs, onLine: emit });
			const why = gitFailReason("git init", res);
			if (why) return fail(`${why}${res.stderrTail === "" ? "" : `：${res.stderrTail}`}`);
		}

		return finish(true);
	} catch (err) {
		return fail(`组装失败：${errMessage(err)}`);
	}
}
