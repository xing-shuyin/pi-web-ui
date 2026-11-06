import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	createWorkspaceSnapshot,
	findMatchingWorkspaceSnapshot,
	isGitWorkspace,
	restoreWorkspaceSnapshot,
	probeGitRepo,
	snapshotCachePath,
	clearWorkspaceSnapshotCaches,
	readWorkspaceSnapshotsFromSession,
	appendWorkspaceSnapshotToSession,
	withWorkspaceSnapshotGate,
	type WorkspaceSnapshotRecord,
} from "../../server/workspace-snapshot.js";

describe("工作区版本影子快照与双向联动回滚 (Dual-State Rollback)", () => {
	let testDir: string;
	let gitTemplateDir: string;

	function git(args: string[], cwd = testDir): string {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	}

	function copyGitRepo() {
		cpSync(gitTemplateDir, testDir, { recursive: true });
	}

	beforeAll(() => {
		gitTemplateDir = mkdtempSync(join(tmpdir(), "pi-test-snap-template-"));
		git(["init"], gitTemplateDir);
		git(["config", "user.name", "test"], gitTemplateDir);
		git(["config", "user.email", "test@test.com"], gitTemplateDir);
	});

	afterAll(() => {
		rmSync(gitTemplateDir, { recursive: true, force: true });
	});

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-test-snap-"));
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {}
	});

	it("非 Git 目录下能够安全降级并返回 null", async () => {
		const isGit = await isGitWorkspace(testDir);
		expect(isGit).toBe(false);

		const snapshot = await createWorkspaceSnapshot(testDir);
		expect(snapshot).toBeNull();

		const restoreRes = await restoreWorkspaceSnapshot(testDir, "dummy-ref");
		expect(restoreRes.success).toBe(false);
		expect(restoreRes.error).toContain("not a Git repository");
	});

	it("在 Git 仓库中创建快照，并在文件被篡改后完整还原 (Dual-State Rollback)", async () => {
		copyGitRepo();

		writeFileSync(join(testDir, "file1.txt"), "hello v1\n");
		writeFileSync(join(testDir, "file2.txt"), "config v1\n");
		git(["add", "."]);
		git(["commit", "-m", "initial"]);

		const snapshot1 = await createWorkspaceSnapshot(testDir);
		expect(snapshot1).toBeTruthy();
		expect(typeof snapshot1).toBe("string");

		writeFileSync(join(testDir, "file1.txt"), "hello v2 MODIFIED\n");
		writeFileSync(join(testDir, "untracked.txt"), "untracked file content\n");

		const snapshot2 = await createWorkspaceSnapshot(testDir);
		expect(snapshot2).toBeTruthy();
		expect(snapshot2).not.toEqual(snapshot1);

		rmSync(join(testDir, "file2.txt"));
		writeFileSync(join(testDir, "junk.txt"), "junk content\n");
		writeFileSync(join(testDir, "file1.txt"), "hello v3 DESTROYED\n");

		const restore2 = await restoreWorkspaceSnapshot(testDir, snapshot2!);
		expect(restore2.success).toBe(true);

		expect(readFileSync(join(testDir, "file1.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("hello v2 MODIFIED\n");
		expect(readFileSync(join(testDir, "file2.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("config v1\n");
		expect(readFileSync(join(testDir, "untracked.txt"), "utf8").replace(/\r\n/g, "\n")).toBe(
			"untracked file content\n",
		);
		expect(existsSync(join(testDir, "junk.txt"))).toBe(false);

		const restore1 = await restoreWorkspaceSnapshot(testDir, snapshot1!);
		expect(restore1.success).toBe(true);

		expect(readFileSync(join(testDir, "file1.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("hello v1\n");
		expect(readFileSync(join(testDir, "file2.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("config v1\n");
		expect(existsSync(join(testDir, "untracked.txt"))).toBe(false);
	}, 20000);

	it("快照只覆盖 cwd 子树：子目录快照的顶层只有该子目录", async () => {
		copyGitRepo();

		writeFileSync(join(testDir, "root.txt"), "root v1\n");
		mkdirSync(join(testDir, "proj"));
		writeFileSync(join(testDir, "proj", "a.txt"), "a v1\n");
		writeFileSync(join(testDir, "proj", "b.txt"), "b v1\n");
		mkdirSync(join(testDir, "other"));
		writeFileSync(join(testDir, "other", "keep.txt"), "keep v1\n");
		git(["add", "."]);
		git(["commit", "-m", "initial"]);

		const projDir = join(testDir, "proj");
		const snapshot = await createWorkspaceSnapshot(projDir);
		expect(snapshot).toBeTruthy();

		const tree = git(["ls-tree", "--name-only", snapshot!]).trim();
		expect(tree).toBe("proj");

		const snapA = git(["show", `${snapshot}:proj/a.txt`]);
		expect(snapA.replace(/\r\n/g, "\n")).toBe("a v1\n");
	}, 20000);

	it("子目录 cwd 的还原只影响该子树，兄弟目录与仓库根不受影响", async () => {
		copyGitRepo();

		writeFileSync(join(testDir, "root.txt"), "root v1\n");
		mkdirSync(join(testDir, "proj"));
		writeFileSync(join(testDir, "proj", "a.txt"), "a v1\n");
		writeFileSync(join(testDir, "proj", "b.txt"), "b v1\n");
		mkdirSync(join(testDir, "other"));
		writeFileSync(join(testDir, "other", "keep.txt"), "keep v1\n");
		git(["add", "."]);
		git(["commit", "-m", "initial"]);

		const projDir = join(testDir, "proj");
		const otherDir = join(testDir, "other");

		const snapshot = await createWorkspaceSnapshot(projDir);
		expect(snapshot).toBeTruthy();

		writeFileSync(join(projDir, "a.txt"), "a v2 DESTROYED\n");
		rmSync(join(projDir, "b.txt"));
		writeFileSync(join(projDir, "untracked.txt"), "untracked content\n");
		writeFileSync(join(projDir, "tracked-add.txt"), "staged after snapshot\n");
		git(["add", "proj/tracked-add.txt"]);
		writeFileSync(join(otherDir, "keep.txt"), "keep v2 TOUCHED\n");
		writeFileSync(join(otherDir, "stray.txt"), "stranger\n");

		const restoreRes = await restoreWorkspaceSnapshot(projDir, snapshot!);
		expect(restoreRes.success).toBe(true);

		expect(readFileSync(join(projDir, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("a v1\n");
		expect(readFileSync(join(projDir, "b.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("b v1\n");
		expect(existsSync(join(projDir, "untracked.txt"))).toBe(false);
		expect(existsSync(join(projDir, "tracked-add.txt"))).toBe(false);

		expect(readFileSync(join(otherDir, "keep.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("keep v2 TOUCHED\n");
		expect(existsSync(join(otherDir, "stray.txt"))).toBe(true);
		expect(readFileSync(join(testDir, "root.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("root v1\n");

		const indexFiles = git(["ls-files"]).trim().split("\n").sort();
		expect(indexFiles).toEqual(["other/keep.txt", "proj/a.txt", "proj/b.txt", "root.txt"]);
	}, 20000);

	it("嵌套子目录 cwd 的还原同样只作用于该深层子树", async () => {
		copyGitRepo();

		mkdirSync(join(testDir, "proj", "sub"), { recursive: true });
		writeFileSync(join(testDir, "proj", "sibling.txt"), "sibling v1\n");
		writeFileSync(join(testDir, "proj", "sub", "deep.txt"), "deep v1\n");
		git(["add", "."]);
		git(["commit", "-m", "initial"]);

		const subDir = join(testDir, "proj", "sub");
		const snapshot = await createWorkspaceSnapshot(subDir);
		expect(snapshot).toBeTruthy();

		writeFileSync(join(subDir, "deep.txt"), "deep v2 DESTROYED\n");
		writeFileSync(join(subDir, "new.txt"), "post-snapshot\n");
		writeFileSync(join(testDir, "proj", "sibling.txt"), "sibling v2 TOUCHED\n");

		expect((await restoreWorkspaceSnapshot(subDir, snapshot!)).success).toBe(true);

		expect(readFileSync(join(subDir, "deep.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("deep v1\n");
		expect(existsSync(join(subDir, "new.txt"))).toBe(false);
		expect(readFileSync(join(testDir, "proj", "sibling.txt"), "utf8").replace(/\r\n/g, "\n")).toBe(
			"sibling v2 TOUCHED\n",
		);
	}, 20000);

	it("空子目录快照在有新增文件后能够安全还原为空", async () => {
		copyGitRepo();

		writeFileSync(join(testDir, "root.txt"), "root v1\n");
		mkdirSync(join(testDir, "empty-sub"));
		git(["add", "root.txt"]);
		git(["commit", "-m", "initial"]);

		const subDir = join(testDir, "empty-sub");
		const snapshot = await createWorkspaceSnapshot(subDir);
		expect(snapshot).toBeTruthy();

		writeFileSync(join(subDir, "created.txt"), "created by ai\n");
		git(["add", "."], subDir);

		const res = await restoreWorkspaceSnapshot(subDir, snapshot!);
		expect(res.error).toBeUndefined();
		expect(res.success).toBe(true);
		expect(existsSync(join(subDir, "created.txt"))).toBe(false);
	}, 20000);

	it("空仓库根目录快照在有新增文件后能够安全还原为空", async () => {
		copyGitRepo();

		const snapshot = await createWorkspaceSnapshot(testDir);
		expect(snapshot).toBeTruthy();

		writeFileSync(join(testDir, "created.txt"), "created by ai\n");
		git(["add", "."]);

		const res = await restoreWorkspaceSnapshot(testDir, snapshot!);
		expect(res.error).toBeUndefined();
		expect(res.success).toBe(true);
		expect(existsSync(join(testDir, "created.txt"))).toBe(false);
	}, 20000);

	it("种入真实 index 后仍只快照 cwd 子树，且不改用户暂存区", async () => {
		copyGitRepo();
		writeFileSync(join(testDir, "root.txt"), "root v1\n");
		mkdirSync(join(testDir, "proj"));
		writeFileSync(join(testDir, "proj", "a.txt"), "a v1\n");
		mkdirSync(join(testDir, "other"));
		writeFileSync(join(testDir, "other", "keep.txt"), "keep v1\n");
		git(["add", "."]);
		git(["commit", "-m", "initial"]);
		writeFileSync(join(testDir, "other", "staged.txt"), "staged only\n");
		git(["add", "other/staged.txt"]);

		const projDir = join(testDir, "proj");
		writeFileSync(join(projDir, "a.txt"), "a v2\n");
		writeFileSync(join(projDir, "new.txt"), "new\n");
		const snapshot = await createWorkspaceSnapshot(projDir);
		expect(snapshot).toBeTruthy();

		const top = git(["ls-tree", "--name-only", snapshot!]).trim();
		expect(top).toBe("proj");
		expect(git(["show", `${snapshot}:proj/a.txt`]).replace(/\r\n/g, "\n")).toBe("a v2\n");
		expect(git(["show", `${snapshot}:proj/new.txt`]).replace(/\r\n/g, "\n")).toBe("new\n");
		expect(() => git(["cat-file", "-e", `${snapshot}:other/keep.txt`])).toThrow();

		const staged = git(["diff", "--cached", "--name-only"]).trim();
		expect(staged).toBe("other/staged.txt");
	}, 20000);

	it("probeGitRepo 一次性获取 gitDir、indexFile 与 prefix", async () => {
		copyGitRepo();
		mkdirSync(join(testDir, "sub", "pkg"), { recursive: true });

		const repoRoot = await probeGitRepo(testDir);
		expect(repoRoot).toBeTruthy();
		expect(repoRoot?.gitDir).toContain(".git");
		expect(repoRoot?.indexFile).toContain(".git");
		expect(repoRoot?.prefix).toBe("");

		const repoSub = await probeGitRepo(join(testDir, "sub", "pkg"));
		expect(repoSub).toBeTruthy();
		expect(repoSub?.prefix).toBe("sub/pkg");
	});

	it("影子 index 缓存文件按 cwd 生成并在快照后持久化，后续快照复用它", async () => {
		clearWorkspaceSnapshotCaches();
		copyGitRepo();
		writeFileSync(join(testDir, "a.txt"), "v1\n");
		git(["add", "a.txt"]);
		git(["commit", "-m", "init"]);

		const repo = await probeGitRepo(testDir);
		expect(repo).toBeTruthy();
		const cachePath = snapshotCachePath(repo!.gitDir, testDir);
		expect(existsSync(cachePath)).toBe(false);

		const snap1 = await createWorkspaceSnapshot(testDir);
		expect(snap1).toBeTruthy();
		expect(existsSync(cachePath)).toBe(true);

		writeFileSync(join(testDir, "a.txt"), "v2\n");
		writeFileSync(join(testDir, "b.txt"), "new b\n");
		const snap2 = await createWorkspaceSnapshot(testDir);
		expect(snap2).toBeTruthy();
		expect(snap2).not.toBe(snap1);

		const snap3 = await createWorkspaceSnapshot(testDir);
		expect(snap3).toBe(snap2);
	}, 20000);

	it("影子 index 缓存损坏时自动回退兜底，不阻断快照生成", async () => {
		clearWorkspaceSnapshotCaches();
		copyGitRepo();
		writeFileSync(join(testDir, "a.txt"), "v1\n");
		git(["add", "a.txt"]);
		git(["commit", "-m", "init"]);

		const repo = await probeGitRepo(testDir);
		const cachePath = snapshotCachePath(repo!.gitDir, testDir);

		writeFileSync(cachePath, "corrupted binary junk index content");

		const snap = await createWorkspaceSnapshot(testDir);
		expect(snap).toBeTruthy();
	}, 20000);

	it("readWorkspaceSnapshotsFromSession 与 appendWorkspaceSnapshotToSession 编解码持久化", () => {
		const mockEntries: unknown[] = [];
		const mockSm = {
			getEntries: () => mockEntries,
			appendCustomEntry: (customType: string, data: unknown) => {
				mockEntries.push({ type: "custom", customType, data });
			},
		};

		expect(readWorkspaceSnapshotsFromSession(mockSm)).toEqual([]);

		const rec1: WorkspaceSnapshotRecord = { entryId: "e1", timestamp: 1000, snapshotRef: "ref-1" };
		const rec2: WorkspaceSnapshotRecord = { entryId: "e2", timestamp: 2000, snapshotRef: "ref-2" };
		appendWorkspaceSnapshotToSession(mockSm, rec1);
		appendWorkspaceSnapshotToSession(mockSm, rec2);

		const restored = readWorkspaceSnapshotsFromSession(mockSm);
		expect(restored).toHaveLength(2);
		expect(restored[0]).toEqual(rec1);
		expect(restored[1]).toEqual(rec2);
	});

	it("withWorkspaceSnapshotGate 门禁在工具执行前等待 pending 快照完成", async () => {
		let snapshotResolved = false;
		let toolExecuted = false;

		const pendingSnapshot = new Promise<void>((resolve) => {
			setTimeout(() => {
				snapshotResolved = true;
				resolve();
			}, 30);
		});

		const dummyTool = {
			name: "test_write",
			description: "test write",
			execute: async () => {
				expect(snapshotResolved).toBe(true);
				toolExecuted = true;
				return { content: [{ type: "text", text: "ok" }] };
			},
		};

		const gatedTool = withWorkspaceSnapshotGate(dummyTool as any, () => pendingSnapshot);
		expect(snapshotResolved).toBe(false);

		await gatedTool.execute("call-1", {}, undefined, undefined, {} as any);
		expect(toolExecuted).toBe(true);
		expect(snapshotResolved).toBe(true);
	});

	describe("findMatchingWorkspaceSnapshot 匹配决策纯函数", () => {
		const snaps: WorkspaceSnapshotRecord[] = [
			{ entryId: "e1", timestamp: 1000, snapshotRef: "ref-1" },
			{ entryId: "e2", timestamp: 5000, snapshotRef: "ref-2" },
			{ entryId: "e3", timestamp: 9000, snapshotRef: "ref-3" },
		];

		it("空快照列表安全返回 undefined", () => {
			expect(findMatchingWorkspaceSnapshot([])).toBeUndefined();
			expect(findMatchingWorkspaceSnapshot([], "e1", 1000)).toBeUndefined();
		});

		it("精确匹配 entryId 优先命中", () => {
			const found = findMatchingWorkspaceSnapshot(snaps, "e2", 9999);
			expect(found?.snapshotRef).toBe("ref-2");
		});

		it("时间戳窗口内匹配最贴近的快照（<= entryTs + 2000 的最后一份）", () => {
			const found = findMatchingWorkspaceSnapshot(snaps, "non-existent", 4000);
			expect(found?.snapshotRef).toBe("ref-2");
		});

		it("超出窗口无更早快照时回退到列表首个快照兜底", () => {
			const found = findMatchingWorkspaceSnapshot([{ timestamp: 20000, snapshotRef: "ref-future" }], "unknown", 100);
			expect(found?.snapshotRef).toBe("ref-future");
		});
	});
});
