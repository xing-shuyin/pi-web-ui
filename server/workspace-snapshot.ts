import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gitFailureMessage, runGit, runGitText } from "./git-run.js";
import { gitDirOf } from "./scm.js";

const pendingRestores = new Map<string, Promise<void>>();

export interface GitRepoInfo {
	gitDir: string;
	indexFile: string;
	prefix: string;
}

export async function probeGitRepo(cwd: string): Promise<GitRepoInfo | null> {
	try {
		const out = await runGitText(["rev-parse", "--git-dir", "--git-path", "index", "--show-prefix"], { cwd });
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
		listed = await runGitText(["ls-files", "-z", "--full-name", "--", ":(top)"], { cwd, env });
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
			const seeded = await runGit(["update-index", "--index-info"], { cwd, env, input: info });
			if (!seeded.ok) throw new Error(gitFailureMessage(seeded, "git update-index failed"));
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
			await runGitText(["add", "-A", "--", "."], { cwd, env });
			tree = await runGitText(["write-tree"], { cwd, env });
		} catch (stageErr) {
			await rm(tempIndex, { force: true }).catch(() => {});
			await rm(cachePath, { force: true }).catch(() => {});
			try {
				await runGitText(["add", "-A", "--", "."], { cwd, env });
				tree = await runGitText(["write-tree"], { cwd, env });
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
			await runGitText(["rev-parse", "--verify", "HEAD"], { cwd });
			hasHead = true;
		} catch {
			hasHead = false;
		}

		const commitArgs = ["commit-tree", tree];
		if (hasHead) {
			commitArgs.push("-p", "HEAD");
		}
		commitArgs.push("-m", `pi-web-ui: workspace shadow snapshot ${new Date().toISOString()}`);

		const commitHash = await runGitText(commitArgs, { cwd, env });
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
		await runGitText(["rev-parse", "--verify", snapshotRef], { cwd });

		const prefix = await runGitText(["rev-parse", "--show-prefix"], { cwd });

		if (!prefix) {
			await runGitText(["read-tree", "-u", "--reset", snapshotRef], { cwd });
			await runGitText(["clean", "-fd"], { cwd });

			lastSnapshotByCwd.delete(resolve(cwd));
			const cachePath = snapshotCachePath(gitDir, cwd);
			void rm(cachePath, { force: true }).catch(() => {});

			return { success: true };
		}

		const pathspec = `:(top)${prefix}`;

		indexRealPath = resolve(cwd, await runGitText(["rev-parse", "--git-path", "index"], { cwd }));
		indexBackup = join(gitDir, `temp-index-backup-${randomUUID()}`);
		try {
			await copyFile(indexRealPath, indexBackup);
			indexBackedUp = true;
		} catch {}

		await runGitText(["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", pathspec], { cwd });

		const listed = await runGitText(
			["ls-tree", "-r", "--name-only", snapshotRef, "--", `:(top)${prefix.replace(/\/+$/, "")}`],
			{ cwd },
		);
		if (listed.trim()) {
			await runGitText(["checkout", snapshotRef, "--", pathspec], { cwd });
		}

		await runGitText(["clean", "-fd", "--", pathspec], { cwd });

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
