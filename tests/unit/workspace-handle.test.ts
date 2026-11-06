import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	canonicalRemoteIdentity,
	computeCanonicalRepositoryId,
	createDetachedWorktree,
	git,
	inside,
	removeDetachedWorktree,
	safeId,
	snapshotTree,
	verifyPatchProducesTree,
	verifyRepoRoot,
	verifyWorktreeIdentity,
} from "../../server/workspace-handle.js";

const exec = promisify(execFile);
const tempDirs: string[] = [];

async function gitExec(cwd: string, ...args: string[]): Promise<string> {
	return (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();
}

async function fixtureRepo(): Promise<{ repo: string; baseCommit: string; dataDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "handle-test-"));
	tempDirs.push(root);
	const repo = join(root, "repo");
	const dataDir = join(root, "data");
	await mkdir(join(repo, "src"), { recursive: true });
	await mkdir(dataDir, { recursive: true });

	await gitExec(repo, "init", "-b", "main");
	await gitExec(repo, "config", "user.name", "Handle Test");
	await gitExec(repo, "config", "user.email", "handle@example.invalid");
	await gitExec(repo, "config", "core.autocrlf", "false");
	await writeFile(join(repo, "src", "index.ts"), 'console.log("hello");\n');
	await writeFile(join(repo, ".gitignore"), ".env\n*.tmp\n");
	await gitExec(repo, "add", ".");
	await gitExec(repo, "commit", "-m", "init");
	const baseCommit = await gitExec(repo, "rev-parse", "HEAD");

	return { repo, baseCommit, dataDir };
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

describe("workspace-handle neutral primitives", { timeout: 30_000 }, () => {
	it("seeds raw snapshots from a validated prepared tree including newly tracked ignored paths", async () => {
		const { repo, dataDir, baseCommit } = await fixtureRepo();
		const headTree = await gitExec(repo, "rev-parse", "HEAD^{tree}");
		await writeFile(join(repo, ".env"), "new ignored content\n");
		await gitExec(repo, "add", "-f", ".env");
		const preparedTree = await gitExec(repo, "write-tree");
		expect(await snapshotTree(repo, dataDir)).toBe(headTree);
		expect(await snapshotTree(repo, dataDir, undefined, "verification-indexes", preparedTree)).toBe(preparedTree);
		await writeFile(join(repo, ".env"), "changed bytes\n");
		expect(await snapshotTree(repo, dataDir, undefined, "verification-indexes", preparedTree)).not.toBe(preparedTree);
		await expect(snapshotTree(repo, dataDir, undefined, "verification-indexes", "--reset")).rejects.toThrow(
			"Snapshot seed",
		);
		await expect(snapshotTree(repo, dataDir, undefined, "verification-indexes", baseCommit)).rejects.toThrow(
			"Snapshot seed",
		);
	});
	it("validates identifiers and prevents path traversal", () => {
		expect(safeId("valid-id_123.test")).toBe("valid-id_123.test");
		expect(() => safeId("..")).toThrow();
		expect(() => safeId(".")).toThrow();
		expect(() => safeId("path/traversal")).toThrow();
		expect(() => safeId("path\\traversal")).toThrow();
		expect(() => safeId("")).toThrow();
	});

	it("evaluates path containment strictly", () => {
		const root = join(tmpdir(), "root-dir");
		expect(inside(root, join(root, "child", "file.txt"))).toBe(true);
		expect(inside(root, root)).toBe(true);
		expect(inside(root, join(root, "..", "outside"))).toBe(false);
	});

	it("asynchronously verifies git repo roots and computes canonical repo ids", async () => {
		const { repo, dataDir } = await fixtureRepo();
		const { repoRoot, commonDir } = await verifyRepoRoot(join(repo, "src"));
		expect(repoRoot.toLowerCase()).toBe(repo.toLowerCase());
		expect(commonDir.toLowerCase()).toContain(".git");

		await expect(verifyRepoRoot(dataDir)).rejects.toThrow("Directory is not a Git repository");

		const rootCommitSha = await gitExec(repo, "rev-list", "--max-parents=0", "HEAD");
		const canonicalId = await computeCanonicalRepositoryId(repo);
		expect(canonicalId).toBe(`repo-${createHash("sha256").update(`roots:${rootCommitSha}`).digest("hex")}`);

		await gitExec(repo, "remote", "add", "origin", "git@github.com:example/repo.git");
		const canonicalWithRemote = await computeCanonicalRepositoryId(repo);
		expect(canonicalWithRemote).toMatch(/^repo-[0-9a-f]{64}$/);
	});

	it("preserves remote path case, strips auth, and equates common SSH/SCP/HTTPS identities", async () => {
		const scp = canonicalRemoteIdentity("git@GitHub.com:Org/Repo.git");
		const authenticated = new URL("https://github.com/Org/Repo.git");
		authenticated.username = "sample";
		authenticated.password = "sample";
		expect(canonicalRemoteIdentity(authenticated.href)).toBe(scp);
		expect(canonicalRemoteIdentity("ssh://git@github.com:22/Org/Repo.git")).toBe(scp);
		expect(canonicalRemoteIdentity("https://github.com/org/repo.git")).not.toBe(scp);
		expect(canonicalRemoteIdentity("ssh://git@github.com:2222/Org/Repo.git")).not.toBe(scp);
		expect(scp).not.toContain("secret");
		for (const remote of [
			"file:///local/repo",
			"C:\\repo",
			"C:repo",
			"ext::some-command",
			"../repo",
			"https://host/repo?secret=1",
		]) {
			expect(() => canonicalRemoteIdentity(remote)).toThrow();
		}
		const { repo } = await fixtureRepo();
		authenticated.hostname = "example.invalid";
		await gitExec(repo, "remote", "add", "origin", authenticated.href);
		const id = await computeCanonicalRepositoryId(repo);
		await gitExec(repo, "remote", "set-url", "origin", "git@example.invalid:Org/Repo.git");
		expect(await computeCanonicalRepositoryId(repo)).toBe(id);
		await gitExec(repo, "remote", "set-url", "origin", "https://example.invalid/org/repo.git");
		expect(await computeCanonicalRepositoryId(repo)).not.toBe(id);
	});

	it("discovers remote-less identity across clones using every root commit, and rejects path fallback", async () => {
		const { repo, dataDir } = await fixtureRepo();
		const first = await computeCanonicalRepositoryId(repo);
		const tree = await gitExec(repo, "rev-parse", "HEAD^{tree}");
		const secondRoot = await gitExec(repo, "commit-tree", tree, "-m", "independent root");
		await gitExec(repo, "update-ref", "refs/heads/other", secondRoot);
		const rootsId = await computeCanonicalRepositoryId(repo);
		expect(rootsId).not.toBe(first);
		const clone = join(dataDir, "clone");
		await gitExec(dataDir, "clone", "--no-local", repo, clone);
		await gitExec(clone, "remote", "remove", "origin");
		await gitExec(clone, "update-ref", "refs/heads/independent", secondRoot);
		expect(await computeCanonicalRepositoryId(clone)).toBe(rootsId);
		await gitExec(dataDir, "init", "empty");
		await expect(computeCanonicalRepositoryId(join(dataDir, "empty"))).rejects.toThrow("empty repository");
	});

	it("disables hooks, fsmonitor and included command filters; snapshots raw bytes despite attributes", async () => {
		const { repo, baseCommit, dataDir } = await fixtureRepo();
		const marker = join(dataDir, "executed");
		const command = `printf executed >> '${marker.replace(/\\/g, "/")}'`;
		await writeFile(join(repo, ".gitattributes"), "*.ts filter=hostile\n*.txt text eol=lf ident\n");
		await gitExec(repo, "add", ".gitattributes");
		await gitExec(repo, "commit", "-m", "attributes");
		const base = await gitExec(repo, "rev-parse", "HEAD");
		const included = join(dataDir, "filters.config");
		await writeFile(
			included,
			`[filter "hostile"]\n clean = ${command}\n smudge = ${command}\n process = ${command}\n required = true\n`,
		);
		await gitExec(repo, "config", "includeIf.gitdir:**/worktrees/**.path", included);
		await gitExec(repo, "config", "core.fsmonitor", command);
		await writeFile(join(repo, ".git", "hooks", "post-checkout"), `#!/bin/sh\n${command}\n`, { mode: 0o755 });
		const worktree = join(dataDir, "safe-checkout");
		await createDetachedWorktree(repo, worktree, base);
		expect(await gitExec(worktree, "config", "--get", "filter.hostile.clean")).toBe(command);
		await git(worktree, ["checkout", "--detach", base]);
		const raw = Buffer.from("$Id$\r\nexact bytes\r\n");
		await writeFile(join(worktree, "raw.txt"), raw);
		await writeFile(join(worktree, "src", "index.ts"), "filter must not run\n");
		const snapshot = await snapshotTree(worktree, dataDir);
		const blob = await exec("git", ["cat-file", "blob", `${snapshot}:raw.txt`], { cwd: repo, encoding: "buffer" });
		expect(blob.stdout).toEqual(raw);
		expect(await git(worktree, ["show", `${snapshot}:src/index.ts`])).toBe("filter must not run\n");
		await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await git(repo, ["rev-parse", "main"])).not.toBe(baseCommit);
		await removeDetachedWorktree(repo, worktree, { force: true });
	});

	it("snapshots working tree without touching HEAD, git branch, or user index", async () => {
		const { repo, dataDir } = await fixtureRepo();
		await writeFile(join(repo, "src", "new.ts"), "const x = 1;\n");
		await writeFile(join(repo, "src", "space name.ts"), "quoted paths\n");
		await writeFile(join(repo, ".env"), "SECRET=123\n");
		const tree = await snapshotTree(repo, dataDir);
		expect(tree).toMatch(/^[0-9a-fA-F]{40}$/);

		const indexDiff = await gitExec(repo, "diff", "--cached");
		expect(indexDiff).toBe("");
		const treeContent = await gitExec(repo, "ls-tree", tree);
		expect(treeContent).not.toContain(".env");
		expect(treeContent).toContain("src");
	});

	it("creates and deeply verifies detached worktree identity", async () => {
		const { repo, baseCommit, dataDir } = await fixtureRepo();
		const worktreePath = join(dataDir, "worktree-1");
		await createDetachedWorktree(repo, worktreePath, baseCommit);

		const identity = await verifyWorktreeIdentity(worktreePath, repo);
		expect(identity.isClean).toBe(true);
		expect(identity.headCommit).toBe(baseCommit);
		expect(identity.toplevel.toLowerCase()).toBe(worktreePath.toLowerCase());

		await gitExec(worktreePath, "checkout", "-b", "attached-branch");
		await expect(verifyWorktreeIdentity(worktreePath, repo)).rejects.toThrow("attached to branch");

		await gitExec(worktreePath, "checkout", "--detach", baseCommit);
		expect((await verifyWorktreeIdentity(worktreePath, repo)).isClean).toBe(true);

		await expect(verifyWorktreeIdentity(worktreePath, repo, undefined, join(dataDir, "fake-gitdir"))).rejects.toThrow(
			"Worktree gitdir mismatch",
		);

		await removeDetachedWorktree(repo, worktreePath, { force: true });
	});

	it("proves binary patch produces declared outputTree and rejects counterfeit outputTree", async () => {
		const { repo, baseCommit, dataDir } = await fixtureRepo();
		const worktreePath = join(dataDir, "worktree-proof");
		await createDetachedWorktree(repo, worktreePath, baseCommit);

		await writeFile(join(worktreePath, "src", "index.ts"), 'console.log("hello world!");\n');
		const outputTree = await snapshotTree(worktreePath, dataDir);

		const baseTree = await gitExec(repo, "rev-parse", `${baseCommit}^{tree}`);
		const patchStr = await git(worktreePath, [
			"diff",
			"--binary",
			"--full-index",
			"--no-ext-diff",
			"--no-textconv",
			baseTree,
			outputTree,
			"--",
		]);
		const patchBytes = Buffer.from(patchStr, "utf8");

		await expect(verifyPatchProducesTree(repo, baseCommit, patchBytes, outputTree, dataDir)).resolves.toBeUndefined();

		const fakeTree = "0000000000000000000000000000000000000000";
		await expect(verifyPatchProducesTree(repo, baseCommit, patchBytes, fakeTree, dataDir)).rejects.toThrow(
			"Artifact patch does not produce declared outputTree",
		);

		await removeDetachedWorktree(repo, worktreePath, { force: true });
	});
});
