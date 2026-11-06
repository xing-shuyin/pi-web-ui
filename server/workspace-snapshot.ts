import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gitDirOf } from "./scm.js";

const exec = promisify(execFile);

const GIT_SNAPSHOT_TIMEOUT_MS = 15_000;

const pendingRestores = new Map<string, Promise<void>>();

async function runGit(cwd: string, args: string[], envExtra?: NodeJS.ProcessEnv): Promise<string> {
	const { stdout } = await exec("git", ["-c", "core.quotepath=false", ...args], {
		cwd,
		env: envExtra ? { ...process.env, ...envExtra } : process.env,
		timeout: GIT_SNAPSHOT_TIMEOUT_MS,
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true,
	});
	return stdout.trim();
}

function runGitInput(cwd: string, args: string[], input: string, envExtra?: NodeJS.ProcessEnv): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("git", ["-c", "core.quotepath=false", ...args], {
			cwd,
			env: envExtra ? { ...process.env, ...envExtra } : process.env,
			windowsHide: true,
			stdio: ["pipe", "ignore", "pipe"],
		});
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(new Error(`git ${args[0] ?? ""} timed out`));
		}, GIT_SNAPSHOT_TIMEOUT_MS);
		child.stdin?.on("error", () => {});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code === 0) resolvePromise();
			else reject(new Error(stderr.trim() || `git exited ${code}`));
		});
		try {
			child.stdin.end(input);
		} catch {}
	});
}

export interface GitRepoInfo {
	gitDir: string;
	indexFile: string;
	prefix: string;
}

export async function probeGitRepo(cwd: string): Promise<GitRepoInfo | null> {
	try {
		const out = await runGit(cwd, ["rev-parse", "--git-dir", "--git-path", "index", "--show-prefix"]);
		const lines = out.split("\n").map((l) => l.trim());
		if (lines.length < 2) return null;
		const rawGitDir = lines[0];
		const rawIndex = lines[1];
		const rawPrefix = lines[2] ?? "";
		if (!rawGitDir || !rawIndex) return null;
		return {
			gitDir: resolve(cwd, rawGitDir),
			indexFile: resolve(cwd, rawIndex),
			prefix: rawPrefix.replace(/\\/g, "/").replace(/\/+$/, ""),
		};
	} catch {
		return null;
	}
}

export function snapshotCachePath(gitDir: string, cwd: string): string {
	const hash = createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 16);
	return join(gitDir, `pi-snapshot-cache-${hash}`);
}

async function seedSnapshotIndex(
	cwd: string,
	tempIndex: string,
	repo: GitRepoInfo,
	env: NodeJS.ProcessEnv,
): Promise<{ fromCache: boolean }> {
	const cachePath = snapshotCachePath(repo.gitDir, cwd);
	if (existsSync(cachePath)) {
		try {
			await copyFile(cachePath, tempIndex);
			return { fromCache: true };
		} catch {
			await rm(cachePath, { force: true }).catch(() => {});
		}
	}

	try {
		await copyFile(repo.indexFile, tempIndex);
	} catch {
		return { fromCache: false };
	}

	const prefix = repo.prefix;
	if (!prefix) return { fromCache: false };
	const prefixSlash = `${prefix}/`;
	let listed = "";
	try {
		listed = await runGit(cwd, ["ls-files", "-z", "--full-name", "--", ":(top)"], env);
	} catch {
		await rm(tempIndex, { force: true }).catch(() => {});
		return { fromCache: false };
	}
	const outside = listed.split("\0").filter((path) => {
		if (!path || path.includes("\n")) return false;
		const norm = path.replace(/\\/g, "/");
		return norm !== prefix && !norm.startsWith(prefixSlash);
	});
	if (listed.includes("\n") && listed.split("\0").some((path) => path.includes("\n"))) {
		await rm(tempIndex, { force: true }).catch(() => {});
		return { fromCache: false };
	}
	if (outside.length > 0) {
		const info = outside.map((path) => `0 0000000000000000000000000000000000000000\t${path}\n`).join("");
		try {
			await runGitInput(cwd, ["update-index", "--index-info"], info, env);
		} catch {
			await rm(tempIndex, { force: true }).catch(() => {});
		}
	}
	return { fromCache: false };
}

interface LastSnapshotCache {
	treeSha: string;
	snapshotRef: string;
	timestamp: number;
}
const lastSnapshotByCwd = new Map<string, LastSnapshotCache>();

export function clearWorkspaceSnapshotCaches(cwd?: string): void {
	if (cwd) {
		lastSnapshotByCwd.delete(resolve(cwd));
	} else {
		lastSnapshotByCwd.clear();
	}
}

export async function isGitWorkspace(cwd: string): Promise<boolean> {
	const info = await probeGitRepo(cwd);
	if (info) return true;
	return (await gitDirOf(cwd)) !== null;
}

export async function createWorkspaceSnapshot(cwd: string): Promise<string | null> {
	const repo = await probeGitRepo(cwd);
	if (!repo) return null;

	const tempIndex = join(repo.gitDir, `temp-index-snapshot-${randomUUID()}`);
	const env = { GIT_INDEX_FILE: tempIndex };
	const cachePath = snapshotCachePath(repo.gitDir, cwd);

	try {
		await seedSnapshotIndex(cwd, tempIndex, repo, env);

		let tree: string | null = null;
		try {
			await runGit(cwd, ["add", "-A", "--", "."], env);
			tree = await runGit(cwd, ["write-tree"], env);
		} catch (stageErr) {
			await rm(tempIndex, { force: true }).catch(() => {});
			await rm(cachePath, { force: true }).catch(() => {});
			try {
				await runGit(cwd, ["add", "-A", "--", "."], env);
				tree = await runGit(cwd, ["write-tree"], env);
			} catch {
				throw stageErr;
			}
		}
		if (!tree) return null;

		await copyFile(tempIndex, cachePath).catch(() => {});

		const normCwd = resolve(cwd);
		const last = lastSnapshotByCwd.get(normCwd);
		if (last && last.treeSha === tree) {
			return last.snapshotRef;
		}

		let hasHead = false;
		try {
			await runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
			hasHead = true;
		} catch {
			hasHead = false;
		}

		const commitArgs = ["commit-tree", tree];
		if (hasHead) {
			commitArgs.push("-p", "HEAD");
		}
		commitArgs.push("-m", `pi-web-ui: workspace shadow snapshot ${new Date().toISOString()}`);

		const commitHash = await runGit(cwd, commitArgs, env);
		if (commitHash) {
			lastSnapshotByCwd.set(normCwd, {
				treeSha: tree,
				snapshotRef: commitHash,
				timestamp: Date.now(),
			});
			return commitHash;
		}
		return null;
	} catch (err) {
		console.warn(`[workspace-snapshot] 创建快照失败 (${cwd}):`, (err as Error).message);
		return null;
	} finally {
		try {
			await rm(tempIndex, { force: true });
		} catch {}
	}
}

export async function restoreWorkspaceSnapshot(
	cwd: string,
	snapshotRef: string,
): Promise<{ success: boolean; error?: string }> {
	const key = resolve(cwd);
	const prev = pendingRestores.get(key);
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const mine = (prev ?? Promise.resolve()).then(() => gate);
	pendingRestores.set(key, mine);
	if (prev) {
		try {
			await prev;
		} catch {}
	}
	try {
		return await restoreWorkspaceSnapshotInner(cwd, snapshotRef);
	} finally {
		if (pendingRestores.get(key) === mine) pendingRestores.delete(key);
		release();
	}
}

async function restoreWorkspaceSnapshotInner(
	cwd: string,
	snapshotRef: string,
): Promise<{ success: boolean; error?: string }> {
	const gitDir = await gitDirOf(cwd);
	if (!gitDir) {
		return { success: false, error: "Workspace is not a Git repository" };
	}

	let indexRealPath = "";
	let indexBackup = "";
	let indexBackedUp = false;

	try {
		await runGit(cwd, ["rev-parse", "--verify", snapshotRef]);

		const prefix = await runGit(cwd, ["rev-parse", "--show-prefix"]);

		if (!prefix) {
			await runGit(cwd, ["read-tree", "-u", "--reset", snapshotRef]);
			await runGit(cwd, ["clean", "-fd"]);

			lastSnapshotByCwd.delete(resolve(cwd));
			const cachePath = snapshotCachePath(gitDir, cwd);
			void rm(cachePath, { force: true }).catch(() => {});

			return { success: true };
		}

		const pathspec = `:(top)${prefix}`;

		indexRealPath = resolve(cwd, (await runGit(cwd, ["rev-parse", "--git-path", "index"])).trim());
		indexBackup = join(gitDir, `temp-index-backup-${randomUUID()}`);
		try {
			await copyFile(indexRealPath, indexBackup);
			indexBackedUp = true;
		} catch {}

		await runGit(cwd, ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", pathspec]);

		const listed = await runGit(cwd, [
			"ls-tree",
			"-r",
			"--name-only",
			snapshotRef,
			"--",
			`:(top)${prefix.replace(/\/+$/, "")}`,
		]);
		if (listed.trim()) {
			await runGit(cwd, ["checkout", snapshotRef, "--", pathspec]);
		}

		await runGit(cwd, ["clean", "-fd", "--", pathspec]);

		lastSnapshotByCwd.delete(resolve(cwd));
		const cachePath = snapshotCachePath(gitDir, cwd);
		void rm(cachePath, { force: true }).catch(() => {});

		return { success: true };
	} catch (err) {
		if (indexBackedUp) {
			try {
				await copyFile(indexBackup, indexRealPath);
			} catch {}
		}
		const msg = (err as Error).message;
		console.error(`[workspace-snapshot] 还原快照失败 (${cwd}, ${snapshotRef}):`, msg);
		return { success: false, error: msg };
	} finally {
		try {
			await rm(indexBackup, { force: true });
		} catch {}
	}
}

export interface WorkspaceSnapshotRecord {
	entryId?: string;
	timestamp: number;
	snapshotRef: string;
}

export function findMatchingWorkspaceSnapshot(
	snapshots: WorkspaceSnapshotRecord[],
	entryId?: string,
	entryTs: number = 0,
): WorkspaceSnapshotRecord | undefined {
	if (!snapshots || snapshots.length === 0) return undefined;
	if (entryId) {
		const exact = snapshots.find((s) => s.entryId === entryId);
		if (exact) return exact;
	}
	const eligible = snapshots.filter((s) => entryTs === 0 || s.timestamp <= entryTs + 2000);
	if (eligible.length > 0) {
		return eligible[eligible.length - 1];
	}
	return snapshots[0];
}

export function readWorkspaceSnapshotsFromSession(sm: unknown): WorkspaceSnapshotRecord[] {
	try {
		const mgr = sm as { getEntries?: () => unknown[] };
		if (typeof mgr?.getEntries !== "function") return [];
		const entries = mgr.getEntries();
		const records: WorkspaceSnapshotRecord[] = [];
		for (const e of entries) {
			const entry = e as
				| {
						type?: string;
						customType?: string;
						data?: WorkspaceSnapshotRecord;
				  }
				| undefined;
			if (entry?.type === "custom" && entry.customType === "pi-web-ui/workspace-snapshot" && entry.data?.snapshotRef) {
				records.push({
					entryId: entry.data.entryId,
					timestamp: Number(entry.data.timestamp) || 0,
					snapshotRef: String(entry.data.snapshotRef),
				});
			}
		}
		return records.slice(-50);
	} catch {
		return [];
	}
}

export function appendWorkspaceSnapshotToSession(sm: unknown, record: WorkspaceSnapshotRecord): void {
	try {
		const mgr = sm as { appendCustomEntry?: (customType: string, data: unknown) => void };
		mgr?.appendCustomEntry?.("pi-web-ui/workspace-snapshot", record);
	} catch {}
}

export function withWorkspaceSnapshotGate<T extends { execute: (...args: any[]) => any }>(
	def: T,
	awaitPendingSnapshot: () => Promise<void>,
): T {
	const originalExecute = def.execute;
	return {
		...def,
		execute: async (...args: any[]) => {
			await awaitPendingSnapshot();
			return originalExecute.apply(def, args);
		},
	};
}
