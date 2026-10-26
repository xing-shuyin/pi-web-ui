/**
 * server/worktree-service.ts
 *
 * Git 工作树（Git Worktree）核心服务层。
 *
 * 功能：
 * 1. 结构化解析 `git worktree list --porcelain`，获取主工作树与所有子工作树（Linked Worktrees）；
 * 2. 检测各工作树状态（分支名、HEAD SHA、未提交文件数、是否为当前工作区、是否为主仓库）；
 * 3. 规范化创建（create）、清理（remove）、剪枝（prune）工作树；
 * 4. 组装 `WorktreeInfo` 上下文供 UI 横幅与 AI 工具消费。
 */

import { execFile } from "node:child_process";
import { resolve, normalize } from "node:path";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { pick, type ServerLang } from "./i18n.js";
import type { LinkedWorktreeEntry, WorktreeInfo } from "./protocol.js";

const exec = promisify(execFile);

const GIT_TIMEOUT_MS = 15_000;
const FAST_GIT_TIMEOUT_MS = 5_000;

/** 统一路径分隔符为 '/'，兼顾 Windows 盘符大小写归一化。 */
export function normalizeWirePath(p: string): string {
	const resolved = resolve(normalize(p)).replace(/\\/g, "/");
	if (process.platform === "win32" && /^[a-zA-Z]:/.test(resolved)) {
		return resolved[0].toUpperCase() + resolved.slice(1);
	}
	return resolved;
}

/** 运行单条 git 命令，失败时抛出友好错误。 */
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

/** 检查指定目录是否位于 Git 仓库中。 */
export async function isInsideGitRepo(cwd: string): Promise<boolean> {
	try {
		const out = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], FAST_GIT_TIMEOUT_MS);
		return out.trim() === "true";
	} catch {
		return false;
	}
}

/** 单个工作树的内部解析条目。 */
export interface RawWorktreeItem {
	path: string;
	head: string;
	branch?: string;
	detached: boolean;
	bare: boolean;
	locked?: boolean | string;
	prunable?: boolean | string;
}

/** 解析 `git worktree list --porcelain` 文本输出。 */
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

/** 快速检测指定工作树目录中的未提交更改数（status --porcelain）。 */
async function getUncommittedCount(worktreePath: string): Promise<{ isDirty: boolean; count: number }> {
	if (!existsSync(worktreePath)) {
		return { isDirty: false, count: 0 };
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
	} catch {
		return { isDirty: false, count: 0 };
	}
}

/** 计算当前工作树相对于主分支领先的 commit 数。 */
async function getAheadCount(worktreePath: string, mainBranch = "main"): Promise<number> {
	if (!existsSync(worktreePath)) return 0;
	try {
		const out = await runGit(worktreePath, ["rev-list", "--count", `HEAD`, `^${mainBranch}`], FAST_GIT_TIMEOUT_MS);
		const num = Number(out.trim());
		return Number.isNaN(num) ? 0 : num;
	} catch {
		// 主分支名可能是 master
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

/** 列出当前 Git 仓库的所有工作树，包含主工作树与关联子工作树。 */
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

/** 创建新的 Git 工作树。 */
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

/** 移除指定 Git 工作树。 */
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
		const { isDirty, count } = await getUncommittedCount(targetPath);
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

/** 获取当前目录的完整工作树上下文元数据（用于 UI 横幅与快照）。 */
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

/** 仓库级异步操作互斥锁（防止多个子代理并发创建/删除工作树时碰撞 Git 内部文件锁）。 */
const repoLocks = new Map<string, Promise<unknown>>();

export async function withRepoLock<T>(repoPath: string, task: () => Promise<T>): Promise<T> {
	const key = normalizeWirePath(repoPath);
	const prev = repoLocks.get(key) ?? Promise.resolve();
	let release: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	repoLocks.set(
		key,
		prev.catch(() => {}).then(() => gate),
	);
	try {
		await prev.catch(() => {});
		return await task();
	} finally {
		release!();
		if (repoLocks.get(key) === gate) {
			repoLocks.delete(key);
		}
	}
}

/** 自动将 .worktrees/ 加入 .git/info/exclude（零污染：防止未在 .gitignore 忽略此目录的用户仓库出现 untracked 脏状态）。 */
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
	} catch {
		// non-fatal
	}
}

/** 子代理专用的 Git 工作树上下文元数据 */
export interface SubagentWorktreeContext {
	/** 工作树根目录绝对路径 */
	worktreePath: string;
	/** 关联的主仓库根目录绝对路径 */
	mainRepoPath: string;
	/** 本次子代理专用的 Git 分支名（例如 subagent/sa-xxxx） */
	branch: string;
	/** 创建工作树时的基准 HEAD commit SHA */
	baseCommit: string;
	/** 子代理的工作区 cwd（若派发时在子目录中，则定位到工作树中对应的子目录；否则为 worktreePath） */
	subagentCwd: string;
	/** 是否已完成终态判定与清理（避免重复执行清理） */
	finalized?: boolean;
	/** 终态检查时是否因无修改而被自动清理 */
	cleanedUp?: boolean;
	/** 是否有未提交的改动 */
	isDirty?: boolean;
	/** 未提交的改动文件数 */
	uncommittedCount?: number;
	/** 相对于 baseCommit 的新 commit 数 */
	aheadCount?: number;
	/** 清理或检查失败时的错误信息（若有） */
	error?: string;
}

/**
 * 为子代理创建专用的 Git 工作树与分支（issue #728）。
 * 自动从当前 HEAD 检出，并建立依赖软链接（node_modules/.venv 等），使子代理可立即执行测试。
 */
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

	// 获取创建时刻的当前 HEAD SHA 作为基准
	const baseCommit = (await runGit(baseCwd, ["rev-parse", "HEAD"])).trim();

	// 确定子代理的执行目录（若 baseCwd 在 mainRepoPath 的子目录中，则映射至工作树对应子目录）
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

		// 使用 -B 确保分支已存在时安全重置，HEAD 确保从当前状态检出
		await runGit(mainRepoPath, ["worktree", "add", "-B", branchName, worktreeDir, "HEAD"]);

		// 依赖桥接：若主仓库根有 node_modules 或 .venv，在工作树中建立目录软连接/Junction，
		// 这样子代理可立即运行 npm test / python 测试，无需耗时重装依赖
		for (const depDir of ["node_modules", ".venv"]) {
			const src = resolve(mainRepoPath, depDir);
			const dest = resolve(worktreeDir, depDir);
			if (existsSync(src) && !existsSync(dest)) {
				try {
					symlinkSync(src, dest, process.platform === "win32" ? "junction" : "dir");
				} catch {
					// 软链接失败不阻断工作树核心流程
				}
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

/**
 * 终态判定与清理（issue #728）：
 * 双重判定改动（未提交修改 + 领先 commit 数）：
 * - 无改动：自动安全清理工作树并删除临时分支；
 * - 有改动：保留工作树与分支供父对话审阅、合并或清理。
 */
export async function finalizeSubagentWorktree(
	wt: SubagentWorktreeContext,
	lang?: () => ServerLang,
): Promise<SubagentWorktreeContext> {
	if (wt.finalized) return wt;

	const { existsSync } = await import("node:fs");
	if (!existsSync(wt.worktreePath)) {
		wt.finalized = true;
		wt.cleanedUp = true;
		return wt;
	}

	try {
		const { isDirty, count: uncommittedCount } = await getUncommittedCount(wt.worktreePath);
		let aheadCount = 0;
		try {
			const currentHead = (await runGit(wt.worktreePath, ["rev-parse", "HEAD"])).trim();
			if (currentHead !== wt.baseCommit) {
				aheadCount = await getAheadCount(wt.worktreePath, wt.baseCommit);
				if (aheadCount === 0 && currentHead !== wt.baseCommit) {
					aheadCount = 1;
				}
			}
		} catch {
			aheadCount = 0;
		}

		wt.isDirty = isDirty;
		wt.uncommittedCount = uncommittedCount;
		wt.aheadCount = aheadCount;

		const hasChanges = isDirty || aheadCount > 0;
		if (!hasChanges) {
			// 没有改动 -> 自动清理工作树与临时分支
			await withRepoLock(wt.mainRepoPath, async () => {
				// 先移除建立的软链接/Junction，防止 Windows 下锁死目录句柄
				for (const depDir of ["node_modules", ".venv"]) {
					const p = resolve(wt.worktreePath, depDir);
					if (existsSync(p)) {
						try {
							const { unlinkSync } = await import("node:fs");
							unlinkSync(p);
						} catch {}
					}
				}
				await removeWorktree(wt.mainRepoPath, wt.worktreePath, true, lang);
				try {
					await runGit(wt.mainRepoPath, ["branch", "-D", wt.branch]);
				} catch {}
			});
			wt.cleanedUp = true;
		} else {
			// 有改动 -> 完整保留，由父对话决定合并还是清理
			wt.cleanedUp = false;
		}
		wt.finalized = true;
	} catch (err) {
		wt.finalized = true;
		wt.error = (err as Error).message;
	}

	return wt;
}

/** 剪枝清理已损坏或残留的孤儿工作树 */
export async function pruneOrphanSubagentWorktrees(cwd: string): Promise<void> {
	try {
		const inside = await isInsideGitRepo(cwd);
		if (!inside) return;
		await runGit(cwd, ["worktree", "prune"], FAST_GIT_TIMEOUT_MS);
	} catch {}
}
