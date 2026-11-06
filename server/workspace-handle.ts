import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export function checkSignal(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}

export function safeId(value: string, context = "workspace"): string {
	if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/.test(value) || value === "." || value === "..") {
		throw new Error(`Invalid ${context} identifier: ${value}`);
	}
	return value;
}

export function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function quoteGitPath(path: string): string {
	return `"${path.replace(/[\\"\x00-\x1f\x7f]/g, (character) =>
		character === "\\" || character === '"'
			? `\\${character}`
			: `\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`,
	)}"`;
}

export async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = resolve(path, "..");
		if (parent === path) throw error;
		return join(await canonicalPath(parent), relative(parent, path));
	}
}

export async function git(
	cwd: string,
	args: string[],
	signal?: AbortSignal,
	index?: string,
	input?: Buffer,
): Promise<string> {
	checkSignal(signal);
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (/^GIT_/i.test(key)) delete env[key];
	}
	if (index) env.GIT_INDEX_FILE = index;

	const execute = (command: string[], stdin?: Buffer, overrides: string[] = []) =>
		new Promise<string>((done, reject) => {
			const child = execFile(
				"git",
				[
					"-c",
					"core.hooksPath=/dev/null",
					"-c",
					"core.fsmonitor=false",
					"-c",
					"core.longpaths=true",
					"-c",
					"commit.gpgsign=false",
					...overrides,
					...command,
				],
				{
					cwd,
					signal,
					windowsHide: true,
					timeout: 60_000,
					maxBuffer: 64 * 1024 * 1024,
					env,
				},
				(error, stdout) => (error ? reject(error) : done(stdout)),
			);
			child.stdin?.on("error", () => {});
			child.stdin?.end(stdin);
		});
	let filters: string;
	try {
		filters = await execute(["config", "--null", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"]);
	} catch (error) {
		checkSignal(signal);
		if ((error as { code?: unknown }).code !== 1) throw error;
		filters = "";
	}
	const drivers = new Set(
		filters
			.split("\0")
			.filter(Boolean)
			.map((entry) => entry.slice(0, entry.indexOf("\n")).replace(/\.(clean|smudge|process)$/, "")),
	);
	const overrides = [...drivers].flatMap((driver) =>
		["clean", "smudge", "process", "required"].flatMap((setting) => [
			"-c",
			`${driver}.${setting}=${setting === "required" ? "false" : ""}`,
		]),
	);
	const stdout = await execute(args, input, overrides);
	checkSignal(signal);
	return stdout;
}

export async function snapshotTree(
	cwd: string,
	dataDir: string,
	signal?: AbortSignal,
	namespace = join("canvas", "indexes"),
	seed = "HEAD",
): Promise<string> {
	if (
		seed !== "HEAD" &&
		(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(seed) ||
			(await git(cwd, ["cat-file", "-t", seed], signal)).trim() !== "tree")
	)
		throw new Error("Snapshot seed must be HEAD or a Git tree object ID");
	const scratch = join(resolve(dataDir), namespace);
	await mkdir(scratch, { recursive: true });
	const index = join(scratch, randomUUID());
	try {
		await git(cwd, ["read-tree", seed], signal, index);
		const tracked = await git(cwd, ["ls-files", "--stage", "-z"], signal, index);
		const files = new Map<string, { mode: string; oid: string }>();
		for (const entry of tracked.split("\0").filter(Boolean)) {
			const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
			if (!match || match[3] !== "0") throw new Error("Cannot snapshot an unmerged Git index");
			files.set(match[4], { mode: match[1], oid: match[2] });
		}
		const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], signal, index);
		for (const path of untracked.split("\0").filter(Boolean)) files.set(path, { mode: "100644", oid: "" });
		let filemode = "true";
		try {
			filemode = (await git(cwd, ["config", "--get", "core.filemode"], signal)).trim();
		} catch (error) {
			checkSignal(signal);
			if ((error as { code?: unknown }).code !== 1) throw error;
		}
		const entries: string[] = [];
		const rawFiles: { path: string; absolute: string; mode: string }[] = [];
		for (const [path, original] of files) {
			checkSignal(signal);
			const absolute = join(cwd, path);
			const parent = resolve(absolute, "..");
			if ((await canonicalPath(parent)) !== parent) throw new Error(`Snapshot path is redirected: ${path}`);
			const stat = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return undefined;
				throw error;
			});
			if (!stat) continue;
			let mode = original.mode;
			let oid: string;
			if (mode === "160000" && stat.isDirectory()) {
				const [top, head] = (await git(absolute, ["rev-parse", "--show-toplevel", "HEAD"], signal))
					.trim()
					.split(/\r?\n/);
				oid = (await canonicalPath(top)) === absolute ? head : original.oid;
			} else {
				if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported snapshot file: ${path}`);
				mode = stat.isSymbolicLink()
					? "120000"
					: filemode === "false"
						? mode === "100755"
							? mode
							: "100644"
						: stat.mode & 0o111
							? "100755"
							: "100644";
				if (!stat.isSymbolicLink()) {
					rawFiles.push({ path, absolute, mode });
					continue;
				}
				const bytes = Buffer.from(await readlink(absolute));
				oid = (await git(cwd, ["hash-object", "-w", "--no-filters", "--stdin"], signal, undefined, bytes)).trim();
			}
			entries.push(`${mode} ${oid}\t${path}\0`);
		}
		if (rawFiles.length) {
			const paths =
				rawFiles
					.map(({ absolute }) => quoteGitPath(sep === "\\" ? absolute.replace(/\\/g, "/") : absolute))
					.join("\n") + "\n";
			const oids = (
				await git(cwd, ["hash-object", "-w", "--no-filters", "--stdin-paths"], signal, undefined, Buffer.from(paths))
			)
				.trim()
				.split(/\r?\n/);
			if (oids.length !== rawFiles.length) throw new Error("Incomplete raw Git snapshot");
			for (const [i, file] of rawFiles.entries()) entries.push(`${file.mode} ${oids[i]}\t${file.path}\0`);
		}
		await git(cwd, ["read-tree", "--empty"], signal, index);
		await git(cwd, ["update-index", "-z", "--index-info"], signal, index, Buffer.from(entries.join("")));
		return (await git(cwd, ["write-tree"], signal, index)).trim();
	} finally {
		await rm(index, { force: true });
		await rm(`${index}.lock`, { force: true });
	}
}

export async function verifyRepoRoot(
	candidatePath: string,
	signal?: AbortSignal,
): Promise<{ repoRoot: string; commonDir: string }> {
	checkSignal(signal);
	const canonical = await canonicalPath(resolve(candidatePath));
	let top: string;
	try {
		top = (await git(canonical, ["rev-parse", "--show-toplevel"], signal)).trim();
	} catch (error) {
		checkSignal(signal);
		throw new Error(`Directory is not a Git repository: ${candidatePath}`, { cause: error });
	}
	const canonicalTop = await canonicalPath(top);
	const common = (await git(canonicalTop, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)).trim();
	const canonicalCommon = await canonicalPath(common);
	return { repoRoot: canonicalTop, commonDir: canonicalCommon };
}

export function canonicalRemoteIdentity(remote: string): string {
	const value = remote.trim();
	let host: string;
	let path: string;
	let transport = "hosted";
	if (value.includes("://")) {
		const url = new URL(value);
		if (!["ssh:", "https:", "http:", "git:"].includes(url.protocol) || url.search || url.hash) {
			throw new Error("Unsupported repository remote identity transport or query/fragment");
		}
		host = url.hostname.toLowerCase();
		path = url.pathname;
		const defaultPort = { "ssh:": "22", "https:": "443", "http:": "80", "git:": "9418" }[url.protocol];
		if (url.port && url.port !== defaultPort) transport = `${url.protocol}${url.port}`;
		else if (url.protocol !== "ssh:" && url.protocol !== "https:") transport = url.protocol;
	} else {
		const match = /^(?:[^@/\s]+@)?(\[[^\]]+\]|[^:/\\\s]+):(.+)$/.exec(value);
		if (!match || /^[a-zA-Z]:/.test(value) || /^[a-zA-Z][a-zA-Z0-9+.-]*::/.test(value))
			throw new Error("Unsupported local repository remote identity");
		host = match[1].toLowerCase();
		path = match[2];
	}
	path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
	if (!host || !path || path.split("/").some((part) => part === "." || part === "..")) {
		throw new Error("Invalid repository remote identity path");
	}
	return JSON.stringify([transport, host, path]);
}

export async function computeCanonicalRepositoryId(repoRoot: string, signal?: AbortSignal): Promise<string> {
	checkSignal(signal);
	const canonical = await canonicalPath(resolve(repoRoot));
	let remote = "";
	try {
		remote = (await git(canonical, ["config", "--get", "remote.origin.url"], signal)).trim();
	} catch (error) {
		checkSignal(signal);
		if ((error as { code?: unknown }).code !== 1) throw error;
	}
	let identity: string;
	if (remote) {
		identity = `remote:${canonicalRemoteIdentity(remote)}`;
	} else {
		const roots = (await git(canonical, ["rev-list", "--max-parents=0", "--all"], signal))
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.sort();
		if (!roots.length)
			throw new Error("Cannot discover transportable identity for an empty repository without a remote");
		identity = `roots:${[...new Set(roots)].join("\n")}`;
	}
	return `repo-${createHash("sha256").update(identity).digest("hex")}`;
}

export interface WorktreeIdentity {
	toplevel: string;
	commonDir: string;
	gitDir: string;
	headCommit: string;
	isClean: boolean;
}

export async function verifyWorktreeIdentity(
	worktreePath: string,
	expectedRepoRoot: string,
	signal?: AbortSignal,
	expectedGitDir?: string,
	expectedCommonDir?: string,
): Promise<WorktreeIdentity> {
	checkSignal(signal);
	const resolvedWorktree = resolve(worktreePath);
	const canonicalWorktree = await canonicalPath(resolvedWorktree);
	const canonicalRepoRoot = await canonicalPath(resolve(expectedRepoRoot));

	let top: string;
	try {
		top = (await git(canonicalWorktree, ["rev-parse", "--show-toplevel"], signal)).trim();
	} catch (error) {
		throw new Error(`Worktree identity error: directory is not a valid Git worktree (${worktreePath})`, {
			cause: error,
		});
	}

	const canonicalTop = await canonicalPath(top);
	if (canonicalTop !== canonicalWorktree) {
		throw new Error(
			`Worktree identity mismatch: toplevel (${canonicalTop}) does not match expected (${canonicalWorktree})`,
		);
	}

	const common = (
		await git(canonicalWorktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)
	).trim();
	const canonicalCommon = await canonicalPath(common);
	const sourceCommon = (
		await git(canonicalRepoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)
	).trim();
	const canonicalSourceCommon = await canonicalPath(sourceCommon);

	if (expectedCommonDir && canonicalCommon !== expectedCommonDir) {
		throw new Error("Worktree git-common-dir changed since registration");
	}
	if (canonicalCommon !== canonicalSourceCommon) {
		throw new Error("Worktree git-common-dir mismatch: worktree does not belong to expected repository");
	}

	const gitDir = (await git(canonicalWorktree, ["rev-parse", "--absolute-git-dir"], signal)).trim();
	const canonicalGitDir = await canonicalPath(gitDir);

	if (canonicalGitDir === canonicalCommon) {
		throw new Error("Worktree identity error: path is the main repository, not an isolated worktree");
	}

	if (!inside(join(canonicalCommon, "worktrees"), canonicalGitDir)) {
		throw new Error("Worktree gitdir is not inside repository worktrees metadata directory");
	}

	if (expectedGitDir) {
		if (canonicalGitDir !== expectedGitDir) {
			throw new Error("Worktree gitdir mismatch: worktree pointer has been substituted");
		}
	}

	const gitdirContent = (await readFile(join(canonicalGitDir, "gitdir"), "utf8")).trim();
	if (resolve(gitdirContent) !== join(canonicalWorktree, ".git")) {
		throw new Error("Worktree gitdir pointer mismatch: .git file redirect is altered");
	}

	const currentBranch = (await git(canonicalWorktree, ["branch", "--show-current"], signal)).trim();
	if (currentBranch.length > 0) {
		throw new Error(`Worktree is attached to branch '${currentBranch}'; detached HEAD is strictly required`);
	}

	const headCommit = (await git(canonicalWorktree, ["rev-parse", "HEAD"], signal)).trim();
	if (!/^[0-9a-fA-F]{40}$/.test(headCommit)) {
		throw new Error(`Worktree HEAD is invalid: ${headCommit}`);
	}

	const status = (await git(canonicalWorktree, ["status", "--porcelain", "--untracked-files=all"], signal)).trim();
	const isClean = status.length === 0;

	return {
		toplevel: canonicalTop,
		commonDir: canonicalCommon,
		gitDir: canonicalGitDir,
		headCommit,
		isClean,
	};
}

export async function applyBinaryPatch(worktreePath: string, patchBytes: Buffer, signal?: AbortSignal): Promise<void> {
	checkSignal(signal);
	if (!patchBytes.length) return;
	try {
		await git(worktreePath, ["apply", "--binary", "--check", "-"], signal, undefined, patchBytes);
		await git(worktreePath, ["apply", "--binary", "-"], signal, undefined, patchBytes);
	} catch (error) {
		checkSignal(signal);
		throw new Error(`Failed to apply binary patch to worktree ${worktreePath}`, { cause: error });
	}
}

export async function verifyPatchProducesTree(
	repoRoot: string,
	baseCommit: string,
	patchBytes: Buffer,
	expectedOutputTree: string,
	dataDir: string,
	signal?: AbortSignal,
): Promise<void> {
	checkSignal(signal);
	const scratch = join(resolve(dataDir), "task-workspaces", "verify-indexes");
	await mkdir(scratch, { recursive: true });
	const index = join(scratch, randomUUID());
	try {
		await git(repoRoot, ["read-tree", `${baseCommit}^{tree}`], signal, index);
		if (patchBytes.length > 0) {
			await git(repoRoot, ["apply", "--cached", "--binary", "-"], signal, index, patchBytes);
		}
		const computedTree = (await git(repoRoot, ["write-tree"], signal, index)).trim();
		if (computedTree.toLowerCase() !== expectedOutputTree.toLowerCase()) {
			throw new Error(
				`Artifact patch does not produce declared outputTree: expected ${expectedOutputTree}, computed ${computedTree}`,
			);
		}
	} finally {
		await rm(index, { force: true });
		await rm(`${index}.lock`, { force: true });
	}
}

export async function createDetachedWorktree(
	repoRoot: string,
	worktreePath: string,
	baseCommit: string,
	signal?: AbortSignal,
): Promise<void> {
	checkSignal(signal);
	const resolvedWorktree = resolve(worktreePath);
	await mkdir(resolve(resolvedWorktree, ".."), { recursive: true });
	if ((await canonicalPath(resolvedWorktree)) !== resolvedWorktree) {
		throw new Error(`Worktree path is redirected: ${resolvedWorktree}`);
	}
	await git(repoRoot, ["worktree", "add", "--detach", "--no-checkout", resolvedWorktree, baseCommit], signal);
	await git(resolvedWorktree, ["reset", "--hard", baseCommit], signal);
}

export async function removeDetachedWorktree(
	repoRoot: string,
	worktreePath: string,
	options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
	checkSignal(options.signal);
	const args = ["worktree", "remove"];
	if (options.force) args.push("--force");
	args.push(resolve(worktreePath));
	await git(repoRoot, args, options.signal);
}
