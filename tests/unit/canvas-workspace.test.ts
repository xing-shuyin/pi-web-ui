import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureCanvasWorkspaceArtifact,
	cleanupCanvasWorkspace,
	prepareCanvasWorkspace,
	type PrepareCanvasWorkspaceOptions,
} from "../../server/canvas/canvas-workspace.js";

const exec = promisify(execFile);
const roots: string[] = [];
async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();
}
async function fixture(): Promise<PrepareCanvasWorkspaceOptions> {
	const root = await mkdtemp(join(tmpdir(), "canvas-workspace-"));
	roots.push(root);
	const repo = join(root, "repo");
	await mkdir(join(repo, "src"), { recursive: true });
	await git(repo, "init");
	await git(repo, "config", "user.name", "Canvas Test");
	await git(repo, "config", "user.email", "canvas@example.invalid");
	await git(repo, "config", "core.autocrlf", "false");
	await writeFile(join(repo, "src", "base.txt"), "baseline\n");
	await writeFile(join(repo, ".gitignore"), ".env\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-m", "baseline");
	return {
		baseCwd: repo,
		dataDir: join(root, "data"),
		graphId: "graph",
		runId: "run",
		nodeId: "node",
		cwd: "src",
		useWorktree: true,
	};
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Real Git worktrees need a separate budget when parallel suites contend for disk I/O.
describe("canvas workspace isolation", { timeout: 20_000 }, () => {
	it("uses detached graph/run/node paths, preserves subdirectories, and never resets existing worktrees", async () => {
		const options = await fixture();
		const branch = await git(options.baseCwd, "branch", "--show-current");
		const workspace = await prepareCanvasWorkspace(options);
		expect(workspace.cwd).toBe(join(options.dataDir, "canvas", "workspaces", "graph", "run", "node", "src"));
		expect(await git(workspace.cwd, "branch", "--show-current")).toBe("");
		await writeFile(join(workspace.cwd, "base.txt"), "keep me\n");
		await expect(prepareCanvasWorkspace(options)).rejects.toThrow();
		expect(await readFile(join(workspace.cwd, "base.txt"), "utf8")).toBe("keep me\n");
		expect(await git(options.baseCwd, "branch", "--show-current")).toBe(branch);
		expect(await git(options.baseCwd, "status", "--porcelain")).toBe("");
	});

	it("captures tracked, binary untracked, and deleted files without touching the real index; QA integrates automatically", async () => {
		const options = await fixture();
		const workspace = await prepareCanvasWorkspace(options);
		await rm(join(workspace.cwd, "base.txt"));
		const binary = Buffer.from([0, 255, 10, 0, 128, 42]);
		await writeFile(join(workspace.cwd, "new.bin"), binary);
		await writeFile(join(workspace.worktreePath!, ".env"), "secret ignored\n");
		const indexBefore = await git(workspace.cwd, "diff", "--cached");
		const artifact = await captureCanvasWorkspaceArtifact(workspace);
		expect(await git(workspace.cwd, "diff", "--cached")).toBe(indexBefore);
		const patch = await readFile(artifact.patchPath, "utf8");
		expect(patch).toContain("GIT binary patch");
		expect(patch).not.toContain("secret ignored");
		expect(artifact.patchPath).toContain(join("artifacts", "graph", "run", "node"));
		const qa = await prepareCanvasWorkspace({
			...options,
			nodeId: "qa",
			useWorktree: false,
			upstreamArtifacts: [artifact],
		});
		expect(qa.isolated).toBe(true);
		expect(await readFile(join(qa.cwd, "new.bin"))).toEqual(binary);
		await expect(readFile(join(qa.cwd, "base.txt"))).rejects.toThrow();
		expect(await readFile(join(options.baseCwd, "src", "base.txt"), "utf8")).toBe("baseline\n");
		await expect(cleanupCanvasWorkspace(workspace)).rejects.toThrow("retained");
		expect(await readFile(artifact.patchPath, "utf8")).toBe(patch);
	});

	it("deduplicates ancestor layers at a diamond join and fixes downstream input snapshots", async () => {
		const options = await fixture();
		const a = await prepareCanvasWorkspace(options);
		await writeFile(join(a.cwd, "base.txt"), "upstream\n");
		const aa = await captureCanvasWorkspaceArtifact(a);
		const b = await prepareCanvasWorkspace({ ...options, nodeId: "b", upstreamArtifacts: [aa] });
		await writeFile(join(b.cwd, "b.txt"), "B\n");
		const ba = await captureCanvasWorkspaceArtifact(b);
		const c = await prepareCanvasWorkspace({ ...options, nodeId: "c", upstreamArtifacts: [aa] });
		await writeFile(join(c.cwd, "c.txt"), "C\n");
		const ca = await captureCanvasWorkspaceArtifact(c);
		expect(await readFile(ba.patchPath, "utf8")).not.toContain("upstream");
		await writeFile(join(a.cwd, "base.txt"), "later mutation\n");
		await captureCanvasWorkspaceArtifact(a);
		const qa = await prepareCanvasWorkspace({ ...options, nodeId: "qa", upstreamArtifacts: [ba, ca] });
		expect(await readFile(join(qa.cwd, "base.txt"), "utf8")).toBe("upstream\n");
		expect(await readFile(join(qa.cwd, "b.txt"), "utf8")).toBe("B\n");
		expect(await readFile(join(qa.cwd, "c.txt"), "utf8")).toBe("C\n");
	});

	it("reports incompatible sibling edits instead of testing the main tree", async () => {
		const options = await fixture();
		const a = await prepareCanvasWorkspace(options);
		const b = await prepareCanvasWorkspace({ ...options, nodeId: "b" });
		await writeFile(join(a.cwd, "base.txt"), "A\n");
		await writeFile(join(b.cwd, "base.txt"), "B\n");
		const aa = await captureCanvasWorkspaceArtifact(a);
		const ba = await captureCanvasWorkspaceArtifact(b);
		await expect(prepareCanvasWorkspace({ ...options, nodeId: "qa", upstreamArtifacts: [aa, ba] })).rejects.toThrow(
			"artifact conflict",
		);
		expect(await git(options.baseCwd, "status", "--porcelain")).toBe("");
	});

	it("rejects dirty tracked and untracked baselines, SSH, non-Git isolation, and escaping cwd", async () => {
		const options = await fixture();
		await writeFile(join(options.baseCwd, "untracked.txt"), "pending");
		await expect(prepareCanvasWorkspace(options)).rejects.toThrow("dirty baseline");
		await rm(join(options.baseCwd, "untracked.txt"));
		await writeFile(join(options.baseCwd, "src", "base.txt"), "dirty\n");
		await expect(prepareCanvasWorkspace(options)).rejects.toThrow("dirty baseline");
		await git(options.baseCwd, "restore", ".");
		await expect(prepareCanvasWorkspace({ ...options, cwd: "../outside" })).rejects.toThrow("within");
		await expect(prepareCanvasWorkspace({ ...options, baseCwd: "ssh://host/repo" })).rejects.toThrow("SSH");
		await expect(prepareCanvasWorkspace({ ...options, baseCwd: options.dataDir })).rejects.toThrow("local Git");
		await expect(prepareCanvasWorkspace({ ...options, graphId: "../escape" })).rejects.toThrow("identifier");
	});

	it("verifies artifact integrity and baseline identity", async () => {
		const options = await fixture();
		const workspace = await prepareCanvasWorkspace(options);
		await writeFile(join(workspace.cwd, "base.txt"), "changed\n");
		const artifact = await captureCanvasWorkspaceArtifact(workspace);
		await expect(
			prepareCanvasWorkspace({
				...options,
				nodeId: "wrong",
				upstreamArtifacts: [{ ...artifact, baseCommit: "0".repeat(40) }],
				baseCommit: workspace.baseCommit,
			}),
		).rejects.toThrow("baseline commit");
		await writeFile(artifact.patchPath, "tampered");
		await expect(
			prepareCanvasWorkspace({ ...options, nodeId: "tampered", upstreamArtifacts: [artifact] }),
		).rejects.toThrow("checksum mismatch");
	});

	it("rejects imported patches outside the trusted graph/run even with matching self-declared checksums", async () => {
		const options = await fixture();
		const workspace = await prepareCanvasWorkspace(options);
		await writeFile(join(workspace.cwd, "base.txt"), "changed\n");
		const artifact = await captureCanvasWorkspaceArtifact(workspace);
		const bytes = await readFile(artifact.patchPath);
		const outside = join(options.dataDir, "outside.patch");
		await writeFile(outside, bytes);
		const forged = {
			...artifact,
			patchPath: outside,
			layers: [{ ...artifact.layers[0], patchPath: outside, sha256: createHash("sha256").update(bytes).digest("hex") }],
		};
		await expect(
			prepareCanvasWorkspace({ ...options, nodeId: "outside", upstreamArtifacts: [forged] }),
		).rejects.toThrow("Untrusted canvas artifact path");
		// A legitimate top-level path must not hide a forged layer path.
		await expect(
			prepareCanvasWorkspace({
				...options,
				nodeId: "layer",
				upstreamArtifacts: [{ ...forged, patchPath: artifact.patchPath }],
			}),
		).rejects.toThrow("Untrusted canvas artifact path");
		await expect(
			prepareCanvasWorkspace({
				...options,
				runId: "other-run",
				nodeId: "qa",
				upstreamArtifacts: [{ ...artifact, graphId: undefined, runId: undefined }],
			}),
		).rejects.toThrow("Untrusted canvas artifact path");
		await expect(
			prepareCanvasWorkspace({ ...options, graphId: "other-graph", nodeId: "qa", upstreamArtifacts: [artifact] }),
		).rejects.toThrow("graph/run");
		expect(await git(options.baseCwd, "status", "--porcelain")).toBe("");
	});

	it("rejects artifact directory junctions that redirect trusted-looking paths", async () => {
		const options = await fixture();
		const workspace = await prepareCanvasWorkspace(options);
		await writeFile(join(workspace.cwd, "base.txt"), "changed\n");
		const artifact = await captureCanvasWorkspaceArtifact(workspace);
		const directory = join(options.dataDir, "canvas", "artifacts", "graph", "run", "node");
		const redirected = join(options.dataDir, "redirected");
		await rename(directory, redirected);
		await symlink(redirected, directory, process.platform === "win32" ? "junction" : "dir");
		await expect(prepareCanvasWorkspace({ ...options, nodeId: "qa", upstreamArtifacts: [artifact] })).rejects.toThrow(
			"canonical location mismatch",
		);
	});

	it("rejects capture and cleanup after a worktree is replaced by a junction to the main tree", async () => {
		const options = await fixture();
		const workspace = await prepareCanvasWorkspace(options);
		await rename(workspace.worktreePath!, `${workspace.worktreePath}-saved`);
		await symlink(options.baseCwd, workspace.worktreePath!, process.platform === "win32" ? "junction" : "dir");
		await expect(captureCanvasWorkspaceArtifact(workspace)).rejects.toThrow("identity mismatch");
		await expect(cleanupCanvasWorkspace(workspace)).rejects.toThrow("identity mismatch");
		expect(await readFile(join(options.baseCwd, "src", "base.txt"), "utf8")).toBe("baseline\n");
		expect(await git(options.baseCwd, "status", "--porcelain")).toBe("");
	});

	it("rejects capture when the worktree Git pointer is redirected to the main tree", async () => {
		const options = await fixture();
		const workspace = await prepareCanvasWorkspace(options);
		await rename(join(workspace.worktreePath!, ".git"), join(workspace.worktreePath!, ".git.saved"));
		await writeFile(join(workspace.worktreePath!, ".git"), `gitdir: ${join(options.baseCwd, ".git")}\n`);
		await expect(captureCanvasWorkspaceArtifact(workspace)).rejects.toThrow("Git repository changed");
		expect(await git(options.baseCwd, "status", "--porcelain")).toBe("");
	});

	it("propagates cancellation and only explicitly cleans unchanged workspaces", async () => {
		const options = await fixture();
		const controller = new AbortController();
		controller.abort();
		await expect(prepareCanvasWorkspace({ ...options, signal: controller.signal })).rejects.toThrow();
		const running = new AbortController();
		const pending = prepareCanvasWorkspace({ ...options, nodeId: "cancel-running", signal: running.signal });
		running.abort(new Error("cancel during preparation"));
		await expect(pending).rejects.toThrow("cancel during preparation");
		const workspace = await prepareCanvasWorkspace(options);
		await expect(captureCanvasWorkspaceArtifact(workspace, { signal: controller.signal })).rejects.toThrow();
		await expect(cleanupCanvasWorkspace(workspace, { signal: controller.signal })).rejects.toThrow();
		const artifact = await captureCanvasWorkspaceArtifact(workspace);
		await cleanupCanvasWorkspace(workspace);
		await expect(readFile(join(workspace.cwd, "base.txt"))).rejects.toThrow();
		expect(await readFile(artifact.patchPath, "utf8")).toBe("");
	});
});
