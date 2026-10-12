import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createWorkspaceSnapshot,
	findMatchingWorkspaceSnapshot,
	isGitWorkspace,
	restoreWorkspaceSnapshot,
	type WorkspaceSnapshotRecord,
} from "../../server/workspace-snapshot.js";

describe("工作区版本影子快照与双向联动回滚 (Dual-State Rollback)", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-test-snap-"));
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
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
		// 1. 初始化 Git 仓库
		execSync("git init", { cwd: testDir, stdio: "ignore" });
		execSync("git config user.name test && git config user.email test@test.com", {
			cwd: testDir,
			stdio: "ignore",
		});

		// 初始文件
		writeFileSync(join(testDir, "file1.txt"), "hello v1\n");
		writeFileSync(join(testDir, "file2.txt"), "config v1\n");
		execSync("git add . && git commit -m 'initial'", { cwd: testDir, stdio: "ignore" });

		// 2. 创建快照 1（工作区干净状态）
		const snapshot1 = await createWorkspaceSnapshot(testDir);
		expect(snapshot1).toBeTruthy();
		expect(typeof snapshot1).toBe("string");

		// 3. 修改文件并新增未跟踪文件
		writeFileSync(join(testDir, "file1.txt"), "hello v2 MODIFIED\n");
		writeFileSync(join(testDir, "untracked.txt"), "untracked file content\n");

		// 4. 创建快照 2（包含未跟踪文件和修改）
		const snapshot2 = await createWorkspaceSnapshot(testDir);
		expect(snapshot2).toBeTruthy();
		expect(snapshot2).not.toEqual(snapshot1);

		// 5. 再次对工作区进行破坏性修改：删除 file2，新增 junk.txt
		rmSync(join(testDir, "file2.txt"));
		writeFileSync(join(testDir, "junk.txt"), "junk content\n");
		writeFileSync(join(testDir, "file1.txt"), "hello v3 DESTROYED\n");

		// 6. 还原到快照 2
		const restore2 = await restoreWorkspaceSnapshot(testDir, snapshot2!);
		expect(restore2.success).toBe(true);

		// 验证还原状态与快照 2 一致
		expect(readFileSync(join(testDir, "file1.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("hello v2 MODIFIED\n");
		expect(readFileSync(join(testDir, "file2.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("config v1\n");
		expect(readFileSync(join(testDir, "untracked.txt"), "utf8").replace(/\r\n/g, "\n")).toBe(
			"untracked file content\n",
		);
		expect(existsSync(join(testDir, "junk.txt"))).toBe(false);

		// 7. 还原到快照 1
		const restore1 = await restoreWorkspaceSnapshot(testDir, snapshot1!);
		expect(restore1.success).toBe(true);

		// 验证还原状态与快照 1 一致（未跟踪文件也被清理）
		expect(readFileSync(join(testDir, "file1.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("hello v1\n");
		expect(readFileSync(join(testDir, "file2.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("config v1\n");
		expect(existsSync(join(testDir, "untracked.txt"))).toBe(false);
	}, 20000);

	it("快照只覆盖 cwd 子树：子目录快照的顶层只有该子目录", async () => {
		// 1. 初始化带子目录的 Git 仓库
		execSync("git init", { cwd: testDir, stdio: "ignore" });
		execSync("git config user.name test && git config user.email test@test.com", {
			cwd: testDir,
			stdio: "ignore",
		});

		writeFileSync(join(testDir, "root.txt"), "root v1\n");
		mkdirSync(join(testDir, "proj"));
		writeFileSync(join(testDir, "proj", "a.txt"), "a v1\n");
		writeFileSync(join(testDir, "proj", "b.txt"), "b v1\n");
		mkdirSync(join(testDir, "other"));
		writeFileSync(join(testDir, "other", "keep.txt"), "keep v1\n");
		execSync("git add . && git commit -m 'initial'", { cwd: testDir, stdio: "ignore" });

		// 2. 从子目录创建快照
		const projDir = join(testDir, "proj");
		const snapshot = await createWorkspaceSnapshot(projDir);
		expect(snapshot).toBeTruthy();

		// 3. 快照树的顶层条目只有 proj/——快照里不含仓库根文件与兄弟目录
		const tree = execSync(`git ls-tree --name-only ${snapshot}`, { cwd: testDir }).toString().trim();
		expect(tree).toBe("proj");

		// 快照内容就是 proj 子树本身
		const snapA = execSync(`git show ${snapshot}:proj/a.txt`, { cwd: testDir }).toString();
		expect(snapA.replace(/\r\n/g, "\n")).toBe("a v1\n");
	}, 20000);

	it("子目录 cwd 的还原只影响该子树，兄弟目录与仓库根不受影响", async () => {
		// 1. 初始化带子目录的 Git 仓库
		execSync("git init", { cwd: testDir, stdio: "ignore" });
		execSync("git config user.name test && git config user.email test@test.com", {
			cwd: testDir,
			stdio: "ignore",
		});

		writeFileSync(join(testDir, "root.txt"), "root v1\n");
		mkdirSync(join(testDir, "proj"));
		writeFileSync(join(testDir, "proj", "a.txt"), "a v1\n");
		writeFileSync(join(testDir, "proj", "b.txt"), "b v1\n");
		mkdirSync(join(testDir, "other"));
		writeFileSync(join(testDir, "other", "keep.txt"), "keep v1\n");
		execSync("git add . && git commit -m 'initial'", { cwd: testDir, stdio: "ignore" });

		const projDir = join(testDir, "proj");
		const otherDir = join(testDir, "other");

		// 2. 在子目录创建快照
		const snapshot = await createWorkspaceSnapshot(projDir);
		expect(snapshot).toBeTruthy();

		// 3. 破坏性修改：proj 内改/删/新增（含一个已 git add 的新文件），同时动手脚到兄弟目录
		writeFileSync(join(projDir, "a.txt"), "a v2 DESTROYED\n");
		rmSync(join(projDir, "b.txt"));
		writeFileSync(join(projDir, "untracked.txt"), "untracked content\n");
		writeFileSync(join(projDir, "tracked-add.txt"), "staged after snapshot\n");
		execSync("git add proj/tracked-add.txt", { cwd: testDir, stdio: "ignore" });
		writeFileSync(join(otherDir, "keep.txt"), "keep v2 TOUCHED\n");
		writeFileSync(join(otherDir, "stray.txt"), "stranger\n");

		// 4. 以 proj 为 cwd 还原
		const restoreRes = await restoreWorkspaceSnapshot(projDir, snapshot!);
		expect(restoreRes.success).toBe(true);

		// 5. proj 子树与快照一致：修改被回滚、删除的跟踪文件被恢复、快照后的新增（未跟踪与已暂存）都被清除
		expect(readFileSync(join(projDir, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("a v1\n");
		expect(readFileSync(join(projDir, "b.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("b v1\n");
		expect(existsSync(join(projDir, "untracked.txt"))).toBe(false);
		expect(existsSync(join(projDir, "tracked-add.txt"))).toBe(false);

		// 6. 兄弟目录与仓库根完全不受影响（含快照之后的新增与修改）
		expect(readFileSync(join(otherDir, "keep.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("keep v2 TOUCHED\n");
		expect(existsSync(join(otherDir, "stray.txt"))).toBe(true);
		expect(readFileSync(join(testDir, "root.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("root v1\n");

		// 7. index 中 proj 之外条目原样保留
		const indexFiles = execSync("git ls-files", { cwd: testDir }).toString().trim().split("\n").sort();
		expect(indexFiles).toEqual(["other/keep.txt", "proj/a.txt", "proj/b.txt", "root.txt"]);
	}, 20000);

	it("嵌套子目录 cwd 的还原同样只作用于该深层子树", async () => {
		// 1. 初始化仓库：proj/sub 为 cwd，proj/sibling.txt 为同层兄弟
		execSync("git init", { cwd: testDir, stdio: "ignore" });
		execSync("git config user.name test && git config user.email test@test.com", {
			cwd: testDir,
			stdio: "ignore",
		});

		mkdirSync(join(testDir, "proj", "sub"), { recursive: true });
		writeFileSync(join(testDir, "proj", "sibling.txt"), "sibling v1\n");
		writeFileSync(join(testDir, "proj", "sub", "deep.txt"), "deep v1\n");
		execSync("git add . && git commit -m 'initial'", { cwd: testDir, stdio: "ignore" });

		const subDir = join(testDir, "proj", "sub");
		const snapshot = await createWorkspaceSnapshot(subDir);
		expect(snapshot).toBeTruthy();

		// 2. 破坏：sub 内修改 + 新增未跟踪；proj/sibling.txt 被改
		writeFileSync(join(subDir, "deep.txt"), "deep v2 DESTROYED\n");
		writeFileSync(join(subDir, "new.txt"), "post-snapshot\n");
		writeFileSync(join(testDir, "proj", "sibling.txt"), "sibling v2 TOUCHED\n");

		// 3. 以 proj/sub 为 cwd 还原
		expect((await restoreWorkspaceSnapshot(subDir, snapshot!)).success).toBe(true);

		// 4. sub 子树回到快照，兄弟文件保持被篡改后的状态
		expect(readFileSync(join(subDir, "deep.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("deep v1\n");
		expect(existsSync(join(subDir, "new.txt"))).toBe(false);
		expect(readFileSync(join(testDir, "proj", "sibling.txt"), "utf8").replace(/\r\n/g, "\n")).toBe(
			"sibling v2 TOUCHED\n",
		);
	}, 20000);

	it("空子目录快照在有新增文件后能够安全还原为空", async () => {
		execSync("git init", { cwd: testDir, stdio: "ignore" });
		execSync("git config user.name test && git config user.email test@test.com", {
			cwd: testDir,
			stdio: "ignore",
		});

		writeFileSync(join(testDir, "root.txt"), "root v1\n");
		mkdirSync(join(testDir, "empty-sub"));
		execSync("git add root.txt && git commit -m initial", { cwd: testDir, stdio: "ignore" });

		const subDir = join(testDir, "empty-sub");
		const snapshot = await createWorkspaceSnapshot(subDir);
		expect(snapshot).toBeTruthy();

		// AI 新增了文件
		writeFileSync(join(subDir, "created.txt"), "created by ai\n");
		execSync("git add .", { cwd: subDir, stdio: "ignore" });

		// 还原
		const res = await restoreWorkspaceSnapshot(subDir, snapshot!);
		expect(res.error).toBeUndefined();
		expect(res.success).toBe(true);
		expect(existsSync(join(subDir, "created.txt"))).toBe(false);
	}, 20000);

	it("空仓库根目录快照在有新增文件后能够安全还原为空", async () => {
		execSync("git init", { cwd: testDir, stdio: "ignore" });
		execSync("git config user.name test && git config user.email test@test.com", {
			cwd: testDir,
			stdio: "ignore",
		});

		const snapshot = await createWorkspaceSnapshot(testDir);
		expect(snapshot).toBeTruthy();

		// AI 新增了文件
		writeFileSync(join(testDir, "created.txt"), "created by ai\n");
		execSync("git add .", { cwd: testDir, stdio: "ignore" });

		// 还原
		const res = await restoreWorkspaceSnapshot(testDir, snapshot!);
		expect(res.error).toBeUndefined();
		expect(res.success).toBe(true);
		expect(existsSync(join(testDir, "created.txt"))).toBe(false);
	}, 20000);

	it("种入真实 index 后仍只快照 cwd 子树，且不改用户暂存区", async () => {
		execSync("git init", { cwd: testDir, stdio: "ignore" });
		execSync("git config user.name test && git config user.email test@test.com", {
			cwd: testDir,
			stdio: "ignore",
		});
		writeFileSync(join(testDir, "root.txt"), "root v1\n");
		mkdirSync(join(testDir, "proj"));
		writeFileSync(join(testDir, "proj", "a.txt"), "a v1\n");
		mkdirSync(join(testDir, "other"));
		writeFileSync(join(testDir, "other", "keep.txt"), "keep v1\n");
		execSync("git add . && git commit -m 'initial'", { cwd: testDir, stdio: "ignore" });
		writeFileSync(join(testDir, "other", "staged.txt"), "staged only\n");
		execSync("git add other/staged.txt", { cwd: testDir, stdio: "ignore" });

		const projDir = join(testDir, "proj");
		writeFileSync(join(projDir, "a.txt"), "a v2\n");
		writeFileSync(join(projDir, "new.txt"), "new\n");
		const snapshot = await createWorkspaceSnapshot(projDir);
		expect(snapshot).toBeTruthy();

		const top = execSync(`git ls-tree --name-only ${snapshot}`, { cwd: testDir }).toString().trim();
		expect(top).toBe("proj");
		expect(execSync(`git show ${snapshot}:proj/a.txt`, { cwd: testDir }).toString().replace(/\r\n/g, "\n")).toBe(
			"a v2\n",
		);
		expect(execSync(`git show ${snapshot}:proj/new.txt`, { cwd: testDir }).toString().replace(/\r\n/g, "\n")).toBe(
			"new\n",
		);
		expect(() => execSync(`git cat-file -e ${snapshot}:other/keep.txt`, { cwd: testDir, stdio: "ignore" })).toThrow();

		const staged = execSync("git diff --cached --name-only", { cwd: testDir }).toString().trim();
		expect(staged).toBe("other/staged.txt");
	}, 20000);

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
			// entryTs = 4000: 4000 + 2000 = 6000 -> 命中 timestamp <= 6000 的最后一份（e2, ts 5000）
			const found = findMatchingWorkspaceSnapshot(snaps, "non-existent", 4000);
			expect(found?.snapshotRef).toBe("ref-2");
		});

		it("超出窗口无更早快照时回退到列表首个快照兜底", () => {
			const found = findMatchingWorkspaceSnapshot(
				[{ timestamp: 20000, snapshotRef: "ref-future" }],
				"unknown",
				100, // 100 + 2000 = 2100 < 20000
			);
			expect(found?.snapshotRef).toBe("ref-future");
		});
	});
});
