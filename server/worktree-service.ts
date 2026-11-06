import { execFile } from "node:child_process";
import { resolve, normalize } from "node:path";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { pick, type ServerLang } from "./i18n.js";
import type { LinkedWorktreeEntry, WorktreeInfo } from "./protocol.js";

const exec = promisify(execFile);

const GIT_TIMEOUT_MS = 15_000;
const FAST_GIT_TIMEOUT_MS = 5_000;

export function normalizeWirePath(p: string): string {
	const resolved = resolve(normalize(p)).replace(/\\/g, "/");
	if (process.platform === "win32" && /^[a-zA-Z]:/.test(resolved)) {
		return resolved[0].toUpperCase() + resolved.slice(1);
	}
	return resolved;
}

async function runGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
	try {
		const { stdout } = await exec("git", ["-c", "core.quotepath=false", ...args], {
			cwd,
			timeout: timeoutMs,
			maxBuffer: 8 * 1024 * 1024,
			windowsHide: true,
		});
		return stdout;
	} catch (err) {
		const e = err as { message?: string; stderr?: string };
		const detail = (e.stderr ?? e.message ?? "").trim().split("\n")[0];
		throw new Error(detail || "Git command failed");
	}
}

export async function isInsideGitRepo(cwd: string): Promise<boolean> {
	try {
		const out = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], FAST_GIT_TIMEOUT_MS);
		return out.trim() === "true";
	} catch {
		return false;
	}
}

export interface RawWorktreeItem {
	path: string;
	head: string;
	branch?: string;
	detached: boolean;
	bare: boolean;
	locked?: boolean | string;
	prunable?: boolean | string;
}

export function parseWorktreePorcelain(text: string): RawWorktreeItem[] {
	const items: RawWorktreeItem[] = [];
	const blocks = text.trim().split(/\n\s*\n/);

	for (const block of blocks) {
		const lines = block
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
		if (lines.length === 0) continue;

		let path = "";
		let head = "";
		let branch: string | undefined;
		let detached = false;
		let bare = false;
		let locked: boolean | string | undefined;
		let prunable: boolean | string | undefined;

		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				path = normalizeWirePath(line.slice("worktree ".length).trim());
			} else if (line.startsWith("HEAD ")) {
				head = line.slice("HEAD ".length).trim();
			} else if (line.startsWith("branch ")) {
				const ref = line.slice("branch ".length).trim();
				branch = ref.replace(/^refs\/heads\//, "");
			} else if (line === "detached") {
				detached = true;
			} else if (line === "bare") {
				bare = true;
			} else if (line.startsWith("locked")) {
				const reason = line.slice("locked".length).trim();
				locked = reason || true;
			} else if (line.startsWith("prunable")) {
				const reason = line.slice("prunable".length).trim();
				prunable = reason || true;
			}
		}

		if (path) {
			items.push({
				path,
				head,
				branch,
				detached,
				bare,
				locked,
				prunable,
			});
		}
	}

	return items;
}

async function getUncommittedCount(worktreePath: string): Promise<{ isDirty: boolean; count: number; error?: string }> {
	if (!existsSync(worktreePath)) {
		return { isDirty: true, count: 0, error: `Worktree does not exist: ${worktreePath}` };
	}
	try {
		const out = await runGit(worktreePath, ["status", "--porcelain"], FAST_GIT_TIMEOUT_MS);
		const lines = out
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
		return {
			isDirty: lines.length > 0,
			count: lines.length,
		};
	} catch (error) {
		return { isDirty: true, count: 0, error: (error as Error).message };
	}
}

async function getAheadCount(worktreePath: string, mainBranch = "main"): Promise<number> {
	if (!existsSync(worktreePath)) return 0;
	try {
		const out = await runGit(worktreePath, ["rev-list", "--count", `HEAD`, `^${mainBranch}`], FAST_GIT_TIMEOUT_MS);
		const num = Number(out.trim());
		return Number.isNaN(num) ? 0 : num;
	} catch {
		if (mainBranch === "main") {
			try {
				const out = await runGit(worktreePath, ["rev-list", "--count", `HEAD`, `^master`], FAST_GIT_TIMEOUT_MS);
				const num = Number(out.trim());
				return Number.isNaN(num) ? 0 : num;
			} catch {
				return 0;
			}
		}
		return 0;
	}
}

export async function listWorktrees(cwd: string): Promise<LinkedWorktreeEntry[]> {
	const inside = await isInsideGitRepo(cwd);
	if (!inside) return [];

	const rawText = await runGit(cwd, ["worktree", "list", "--porcelain"]);
	const rawItems = parseWorktreePorcelain(rawText);
	if (rawItems.length === 0) return [];

	const normCurrent = normalizeWirePath(cwd);
	const mainItem = rawItems[0];
	const mainBranch = mainItem.branch || "main";

	const results: LinkedWorktreeEntry[] = [];

	for (let i = 0; i < rawItems.length; i++) {
		const item = rawItems[i];
		const isMain = i === 0;
		const isCurrent =
			normCurrent === item.path ||
			normCurrent.startsWith(item.path + "/") ||
			(process.platform === "win32" && normCurrent.toLowerCase() === item.path.toLowerCase());

		const { isDirty, count } = await getUncommittedCount(item.path);
		const ahead = isMain ? 0 : await getAheadCount(item.path, mainBranch);

		results.push({
			path: item.path,
			branch: item.branch || (item.detached ? "(detached)" : undefined),
			isCurrent,
			isMain,
			isDirty,
			uncommittedCount: count,
			aheadCount: ahead,
		});
	}

	return results;
}

export interface CreateWorktreeOptions {
	path: string;
	branch?: string;
	newBranch?: boolean | string;
	commit?: string;
}

export async function createWorktree(
	cwd: string,
	opts: CreateWorktreeOptions,
	lang?: () => ServerLang,
): Promise<{ path: string; branch?: string }> {
	const l = lang?.() ?? "en";
	const inside = await isInsideGitRepo(cwd);
	if (!inside) {
		throw new Error(pick(l, "当前目录不是 Git 仓库", "Current directory is not a Git repository", "worktree.not.git"));
	}

	const targetPath = normalizeWirePath(resolve(cwd, opts.path));
	const args: string[] = ["worktree", "add"];

	let branchName = opts.branch;
	if (typeof opts.newBranch === "string" && opts.newBranch.trim()) {
		args.push("-b", opts.newBranch.trim());
		branchName = opts.newBranch.trim();
	} else if (opts.newBranch === true && opts.branch) {
		args.push("-b", opts.branch.trim());
	}

	args.push(targetPath);

	if (opts.commit) {
		args.push(opts.commit.trim());
	} else if (!opts.newBranch && opts.branch) {
		args.push(opts.branch.trim());
	}

	await runGit(cwd, args);
	return { path: targetPath, branch: branchName };
}

export async function removeWorktree(
	cwd: string,
	targetPathInput: string,
	force = false,
	lang?: () => ServerLang,
): Promise<void> {
	const l = lang?.() ?? "en";
	const inside = await isInsideGitRepo(cwd);
	if (!inside) {
		throw new Error(pick(l, "当前目录不是 Git 仓库", "Current directory is not a Git repository", "worktree.not.git"));
	}

	const targetPath = normalizeWirePath(resolve(cwd, targetPathInput));

	if (!force) {
		const { isDirty, count, error } = await getUncommittedCount(targetPath);
		if (error) throw new Error(`Cannot verify worktree status: ${error}`);
		if (isDirty) {
			throw new Error(
				pick(
					l,
					`工作树「${targetPath}」包含 ${count} 个未提交的文件修改；请先提交或传入 force=true 强制删除`,
					`Worktree "${targetPath}" has ${count} uncommitted changes; commit them or pass force=true to remove`,
					"worktree.remove.dirty",
					{ targetPath, count },
				),
			);
		}
	}

	const args = ["worktree", "remove"];
	if (force) args.push("--force");
	args.push(targetPath);

	let lastErr: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await runGit(cwd, args);
			return;
		} catch (err) {
			lastErr = err;
			if (attempt < 2) {
				await new Promise((r) => setTimeout(r, 200));
			}
		}
	}
	throw lastErr;
}

export async function getWorktreeContext(cwd: string): Promise<WorktreeInfo | null> {
	try {
		const inside = await isInsideGitRepo(cwd);
		if (!inside) return null;

		const list = await listWorktrees(cwd);
		if (list.length === 0) return null;

		const mainEntry = list.find((e) => e.isMain) || list[0];
		const currentEntry = list.find((e) => e.isCurrent);

		const isLinkedWorktree = Boolean(currentEntry && !currentEntry.isMain);
		const linkedWorktrees = list.filter((e) => !e.isMain);

		return {
			isLinkedWorktree,
			currentPath: currentEntry ? currentEntry.path : normalizeWirePath(cwd),
			branch: currentEntry?.branch,
			mainPath: mainEntry.path,
			mainBranch: mainEntry.branch,
			linkedWorktrees,
		};
	} catch {
		return null;
	}
}

const repoLocks = new Map<string, Promise<unknown>>();

export async function withRepoLock<T>(repoPath: string, task: () => Promise<T>): Promise<T> {
	const key = normalizeWirePath(repoPath);
	const prev = repoLocks.get(key) ?? Promise.resolve();
	let release: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = prev.catch(() => {}).then(() => gate);
	repoLocks.set(key, queued);
	try {
		await prev.catch(() => {});
		return await task();
	} finally {
		release!();
		if (repoLocks.get(key) === queued) {
			repoLocks.delete(key);
		}
	}
}

export async function ensureWorktreeExcluded(repoPath: string): Promise<void> {
	try {
		const gitCommonDir = (await runGit(repoPath, ["rev-parse", "--git-common-dir"], FAST_GIT_TIMEOUT_MS)).trim();
		const absGitCommon = resolve(repoPath, gitCommonDir);
		const excludeFile = resolve(absGitCommon, "info", "exclude");
		const { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } = await import("node:fs");
		if (existsSync(excludeFile)) {
			const content = readFileSync(excludeFile, "utf-8");
			if (!content.includes(".worktrees")) {
				appendFileSync(excludeFile, "\n# pi-web-ui worktrees\n.worktrees/\n");
			}
		} else {
			mkdirSync(resolve(absGitCommon, "info"), { recursive: true });
			writeFileSync(excludeFile, "# pi-web-ui worktrees\n.worktrees/\n", "utf-8");
		}
	} catch {}
}

export interface SubagentWorktreeContext {
	worktreePath: string;
	mainRepoPath: string;
	branch: string;
	baseCommit: string;
	subagentCwd: string;
	finalized?: boolean;
	cleanedUp?: boolean;
	isDirty?: boolean;
	uncommittedCount?: number;
	aheadCount?: number;
	error?: string;
}

export async function createSubagentWorktree(
	baseCwd: string,
	subagentId: string,
	lang?: () => ServerLang,
): Promise<SubagentWorktreeContext> {
	const l = lang?.() ?? "en";
	const inside = await isInsideGitRepo(baseCwd);
	if (!inside) {
		throw new Error(
			pick(
				l,
				`Git 工作树隔离失败：目录「${baseCwd}」不是 Git 仓库。worktree 隔离模式要求工作区位于有效的 Git 仓库中。`,
				`Git worktree isolation failed: "${baseCwd}" is not a Git repository. Worktree isolation mode requires a valid Git repository.`,
				"worktree.isolation.not_git",
				{ baseCwd },
			),
		);
	}

	const rawText = await runGit(baseCwd, ["worktree", "list", "--porcelain"]);
	const rawItems = parseWorktreePorcelain(rawText);
	const mainRepoPath = rawItems[0]?.path || normalizeWirePath(resolve(baseCwd));
	const worktreeDir = normalizeWirePath(resolve(mainRepoPath, ".worktrees", subagentId));
	const branchName = `subagent/${subagentId}`;

	const baseCommit = (await runGit(baseCwd, ["rev-parse", "HEAD"])).trim();

	const normBase = normalizeWirePath(resolve(baseCwd));
	const normMain = normalizeWirePath(resolve(mainRepoPath));
	let subagentCwd = worktreeDir;
	if (normBase.startsWith(normMain + "/")) {
		const rel = normBase.slice(normMain.length + 1);
		subagentCwd = normalizeWirePath(resolve(worktreeDir, rel));
	}

	await withRepoLock(mainRepoPath, async () => {
		await ensureWorktreeExcluded(mainRepoPath);
		const { mkdirSync, existsSync, symlinkSync } = await import("node:fs");
		mkdirSync(resolve(mainRepoPath, ".worktrees"), { recursive: true });

		await runGit(mainRepoPath, ["worktree", "add", "-B", branchName, worktreeDir, "HEAD"]);

		for (const depDir of ["node_modules", ".venv"]) {
			const src = resolve(mainRepoPath, depDir);
			const dest = resolve(worktreeDir, depDir);
			if (existsSync(src) && !existsSync(dest)) {
				try {
					symlinkSync(src, dest, process.platform === "win32" ? "junction" : "dir");
				} catch {}
			}
		}
	});

	return {
		worktreePath: worktreeDir,
		mainRepoPath,
		branch: branchName,
		baseCommit,
		subagentCwd,
	};
}

export async function finalizeSubagentWorktree(
	wt: SubagentWorktreeContext,
	lang?: () => ServerLang,
	canCleanup: () => boolean = () => true,
): Promise<SubagentWorktreeContext> {
	if (wt.finalized || !canCleanup()) return wt;

	const { existsSync } = await import("node:fs");
	if (!existsSync(wt.worktreePath)) {
		wt.finalized = true;
		wt.cleanedUp = true;
		return wt;
	}

	try {
		const { isDirty, count: uncommittedCount, error } = await getUncommittedCount(wt.worktreePath);
		if (error) throw new Error(`Cannot verify worktree status: ${error}`);
		const currentHead = (await runGit(wt.worktreePath, ["rev-parse", "HEAD"])).trim();
		if (!currentHead) throw new Error("Cannot verify worktree HEAD");
		const aheadCount =
			currentHead === wt.baseCommit ? 0 : Math.max(1, await getAheadCount(wt.worktreePath, wt.baseCommit));

		wt.isDirty = isDirty;
		wt.uncommittedCount = uncommittedCount;
		wt.aheadCount = aheadCount;

		const hasChanges = isDirty || aheadCount > 0;
		if (!hasChanges) {
			await withRepoLock(wt.mainRepoPath, async () => {
				if (!canCleanup()) throw new Error("Worktree acquired an active execution during finalization");
				for (const depDir of ["node_modules", ".venv"]) {
					const p = resolve(wt.worktreePath, depDir);
					if (existsSync(p)) {
						try {
							const { unlinkSync } = await import("node:fs");
							unlinkSync(p);
						} catch {}
					}
				}
				const head = (await runGit(wt.worktreePath, ["rev-parse", "HEAD"])).trim();
				if (head !== wt.baseCommit) throw new Error("Worktree HEAD changed during cleanup");
				if (!canCleanup()) throw new Error("Worktree acquired an active execution during finalization");
				await removeWorktree(wt.mainRepoPath, wt.worktreePath, false, lang);
				try {
					await runGit(wt.mainRepoPath, ["update-ref", "-d", `refs/heads/${wt.branch}`, wt.baseCommit]);
				} catch {}
			});
			wt.cleanedUp = true;
		} else {
			wt.cleanedUp = false;
		}
		wt.finalized = true;
	} catch (err) {
		wt.finalized = true;
		wt.cleanedUp = false;
		wt.error = (err as Error).message;
	}

	return wt;
}

export async function pruneOrphanSubagentWorktrees(cwd: string): Promise<void> {
	try {
		const inside = await isInsideGitRepo(cwd);
		if (!inside) return;
		await runGit(cwd, ["worktree", "prune"], FAST_GIT_TIMEOUT_MS);
	} catch {}
}
