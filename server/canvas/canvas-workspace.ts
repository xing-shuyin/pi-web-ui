import { CanvasRuntimeError } from "./canvas-runtime-messages.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
	canonicalPath,
	checkSignal,
	createDetachedWorktree,
	git,
	inside,
	safeId,
	snapshotTree,
	verifyWorktreeIdentity,
} from "../workspace-handle.js";

export interface CanvasArtifactLayer {
	id: string;
	patchPath: string;
	sha256: string;
}

export interface CanvasWorkspaceArtifact {
	graphId?: string;
	runId?: string;
	nodeId?: string;
	repoRoot: string;
	baseCommit: string;
	patchPath: string;
	outputTree: string;
	layers: CanvasArtifactLayer[];
}

export interface CanvasWorkspace {
	cwd: string;
	dataDir: string;
	graphId: string;
	runId: string;
	nodeId: string;
	isolated: boolean;
	repoRoot?: string;
	worktreePath?: string;
	baseCommit?: string;
	inputTree?: string;
	upstreamArtifacts: CanvasWorkspaceArtifact[];
}

export interface PrepareCanvasWorkspaceOptions {
	baseCwd: string;
	dataDir: string;
	graphId: string;
	runId: string;
	nodeId: string;
	cwd?: string;
	useWorktree?: boolean;
	baseCommit?: string;
	upstreamArtifacts?: CanvasWorkspaceArtifact[];
	signal?: AbortSignal;
}

function workspaceDir(
	workspace: Pick<CanvasWorkspace, "dataDir" | "graphId" | "runId" | "nodeId">,
	kind: string,
): string {
	return join(
		resolve(workspace.dataDir),
		"canvas",
		kind,
		safeId(workspace.graphId),
		safeId(workspace.runId),
		safeId(workspace.nodeId),
	);
}

function layersOf(artifacts: CanvasWorkspaceArtifact[]): CanvasArtifactLayer[] {
	const layers = new Map<string, CanvasArtifactLayer>();
	for (const artifact of artifacts) {
		for (const layer of artifact.layers) {
			const prior = layers.get(layer.id);
			if (prior && prior.sha256 !== layer.sha256)
				throw new CanvasRuntimeError(
					`Conflicting canvas artifact identity: ${layer.id}`,
					"error.artifactIdentityConflict",
					{ id: layer.id },
				);
			if (!prior) layers.set(layer.id, layer);
		}
	}
	return [...layers.values()];
}

async function trustedArtifactPath(workspace: CanvasWorkspace, path: string, nodeId?: string): Promise<string> {
	const root = join(workspace.dataDir, "canvas", "artifacts");
	const runRoot = join(root, workspace.graphId, workspace.runId);
	const resolved = resolve(path);
	const parts = relative(runRoot, resolved).split(sep);
	if (parts.length !== 2 || (nodeId && parts[0] !== nodeId) || !/^[a-zA-Z0-9-]+\.patch$/.test(parts[1] ?? "")) {
		throw new CanvasRuntimeError("Untrusted canvas artifact path", "error.untrustedArtifactPath");
	}
	safeId(parts[0]);
	if (!inside(runRoot, resolved) || (await realpath(resolved)) !== resolved || (await realpath(root)) !== root) {
		throw new CanvasRuntimeError(
			"Untrusted canvas artifact path: canonical location mismatch",
			"error.artifactLocationMismatch",
		);
	}
	return resolved;
}

const workspaceIdentities = new WeakMap<CanvasWorkspace, { gitDir: string; commonDir: string }>();

async function assertWorkspaceIdentity(workspace: CanvasWorkspace, signal?: AbortSignal): Promise<void> {
	const expected = workspaceDir(workspace, "workspaces");
	if (
		!workspace.worktreePath ||
		!workspace.repoRoot ||
		resolve(workspace.worktreePath) !== expected ||
		(await realpath(expected)) !== expected
	) {
		throw new CanvasRuntimeError(
			"Canvas worktree identity mismatch: canonical path changed",
			"error.worktreePathChanged",
		);
	}
	try {
		const identity = workspaceIdentities.get(workspace);
		if (!identity) throw new CanvasRuntimeError("Unregistered canvas workspace", "error.workspaceUnregistered");
		await verifyWorktreeIdentity(expected, workspace.repoRoot, signal, identity.gitDir, identity.commonDir);
	} catch (error) {
		throw new CanvasRuntimeError(
			"Canvas worktree identity mismatch: Git repository changed",
			"error.worktreeRepoChanged",
			undefined,
			{ cause: error },
		);
	}
}

export async function prepareCanvasWorkspace(options: PrepareCanvasWorkspaceOptions): Promise<CanvasWorkspace> {
	checkSignal(options.signal);
	for (const value of [options.baseCwd, options.cwd ?? ""]) {
		if (/^(?:ssh:\/\/|[^/\\]+@[^:]+:)/i.test(value))
			throw new CanvasRuntimeError("Remote SSH canvas workspaces are not supported", "error.remoteUnsupported");
	}
	const baseCwd = resolve(options.baseCwd);
	const cwd = resolve(baseCwd, options.cwd ?? ".");
	const upstreamArtifacts = options.upstreamArtifacts ?? [];
	const workspace: CanvasWorkspace = {
		cwd,
		dataDir: resolve(options.dataDir),
		graphId: safeId(options.graphId),
		runId: safeId(options.runId),
		nodeId: safeId(options.nodeId),
		isolated: Boolean(options.useWorktree || upstreamArtifacts.length),
		upstreamArtifacts,
	};
	if (!workspace.isolated) return workspace;
	let repoRoot: string;
	try {
		repoRoot = (await git(baseCwd, ["rev-parse", "--show-toplevel"], options.signal)).trim();
	} catch (error) {
		checkSignal(options.signal);
		throw new CanvasRuntimeError(
			"Canvas isolation requires a local Git repository",
			"error.localGitRequired",
			undefined,
			{ cause: error },
		);
	}
	repoRoot = await realpath(repoRoot);
	const canonicalCwd = await canonicalPath(cwd);
	workspace.dataDir = await canonicalPath(workspace.dataDir);
	if (!inside(repoRoot, canonicalCwd))
		throw new CanvasRuntimeError("Canvas cwd must be within the baseline repository", "error.cwdOutsideRepo");
	if (inside(repoRoot, workspace.dataDir))
		throw new CanvasRuntimeError(
			"Canvas isolation dataDir must be outside the baseline repository",
			"error.dataDirInsideRepo",
		);
	if ((await git(repoRoot, ["status", "--porcelain", "--untracked-files=all"], options.signal)).trim()) {
		throw new CanvasRuntimeError(
			"Canvas isolation refuses a dirty baseline; commit or stash changes explicitly first",
			"error.dirtyBaseline",
		);
	}
	const requestedBase = options.baseCommit ?? upstreamArtifacts[0]?.baseCommit ?? "HEAD";
	if (requestedBase.startsWith("-"))
		throw new CanvasRuntimeError("Invalid canvas base commit", "error.invalidBaseCommit");
	const baseCommit = (
		await git(repoRoot, ["rev-parse", "--verify", `${requestedBase}^{commit}`], options.signal)
	).trim();
	for (const artifact of upstreamArtifacts) {
		if (resolve(artifact.repoRoot) !== resolve(repoRoot) || artifact.baseCommit !== baseCommit) {
			throw new CanvasRuntimeError(
				"Canvas upstream artifacts must share the repository and baseline commit",
				"error.upstreamBaselineMismatch",
			);
		}
	}
	const patches: { layer: CanvasArtifactLayer; bytes: Buffer }[] = [];
	for (const artifact of upstreamArtifacts) {
		if (
			(artifact.graphId && artifact.graphId !== workspace.graphId) ||
			(artifact.runId && artifact.runId !== workspace.runId)
		) {
			throw new CanvasRuntimeError("Untrusted canvas artifact graph/run", "error.untrustedArtifactRun");
		}
		await trustedArtifactPath(workspace, artifact.patchPath, artifact.nodeId);
	}
	for (const layer of layersOf(upstreamArtifacts)) {
		const [graphId, runId, nodeId, tree, ...extra] = layer.id.split("/");
		if (
			graphId !== workspace.graphId ||
			runId !== workspace.runId ||
			!nodeId ||
			!/^[a-f0-9]{40,64}$/.test(tree ?? "") ||
			extra.length
		) {
			throw new CanvasRuntimeError("Untrusted canvas artifact layer identity", "error.untrustedArtifactLayer");
		}
		const patchPath = await trustedArtifactPath(workspace, layer.patchPath, safeId(nodeId));
		const bytes = await readFile(patchPath, { signal: options.signal });
		if (createHash("sha256").update(bytes).digest("hex") !== layer.sha256)
			throw new CanvasRuntimeError(`Canvas artifact checksum mismatch: ${layer.id}`, "error.artifactChecksum", {
				id: layer.id,
			});
		patches.push({ layer, bytes });
	}
	const worktreePath = workspaceDir(workspace, "workspaces");
	await mkdir(resolve(worktreePath, ".."), { recursive: true });
	if ((await canonicalPath(worktreePath)) !== worktreePath)
		throw new CanvasRuntimeError("Canvas worktree path is redirected", "error.worktreeRedirected");
	await createDetachedWorktree(repoRoot, worktreePath, baseCommit, options.signal);
	for (const { layer, bytes } of patches) {
		checkSignal(options.signal);
		if (!bytes.length) continue;
		try {
			await git(worktreePath, ["apply", "--check", "-"], options.signal, undefined, bytes);
			await git(worktreePath, ["apply", "-"], options.signal, undefined, bytes);
		} catch (error) {
			checkSignal(options.signal);
			throw new CanvasRuntimeError(
				`Canvas upstream artifact conflict: ${layer.id}; workspace retained at ${worktreePath}`,
				"error.artifactConflict",
				{ id: layer.id, path: worktreePath },
				{ cause: error },
			);
		}
	}
	const preparedCwd = join(worktreePath, relative(repoRoot, canonicalCwd));
	if (!inside(worktreePath, await canonicalPath(preparedCwd)))
		throw new CanvasRuntimeError("Canvas integrated cwd escapes its worktree", "error.cwdEscapesWorktree");
	checkSignal(options.signal);
	const prepared: CanvasWorkspace = {
		...workspace,
		cwd: preparedCwd,
		repoRoot,
		worktreePath,
		baseCommit,
		inputTree: await snapshotTree(worktreePath, workspace.dataDir, options.signal),
	};
	const identity = await verifyWorktreeIdentity(worktreePath, repoRoot, options.signal);
	workspaceIdentities.set(prepared, { gitDir: identity.gitDir, commonDir: identity.commonDir });
	return prepared;
}

export async function captureCanvasWorkspaceArtifact(
	workspace: CanvasWorkspace,
	options: { signal?: AbortSignal } = {},
): Promise<CanvasWorkspaceArtifact> {
	checkSignal(options.signal);
	if (
		!workspace.isolated ||
		!workspace.worktreePath ||
		!workspace.repoRoot ||
		!workspace.baseCommit ||
		!workspace.inputTree
	) {
		throw new CanvasRuntimeError(
			"Canvas artifact capture requires a prepared isolated workspace",
			"error.captureRequiresWorkspace",
		);
	}
	await assertWorkspaceIdentity(workspace, options.signal);
	const outputTree = await snapshotTree(workspace.worktreePath, workspace.dataDir, options.signal);
	await assertWorkspaceIdentity(workspace, options.signal);
	const patch = await git(
		workspace.worktreePath,
		["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", workspace.inputTree, outputTree, "--"],
		options.signal,
	);
	const directory = workspaceDir(workspace, "artifacts");
	await mkdir(directory, { recursive: true });
	if ((await realpath(directory)) !== directory)
		throw new CanvasRuntimeError("Untrusted canvas artifact output directory", "error.untrustedArtifactOutput");
	// Immutable capture paths keep already-prepared consumers independent of subsequent captures.
	const patchPath = join(directory, `${randomUUID()}.patch`);
	checkSignal(options.signal);
	await writeFile(patchPath, patch, { flag: "wx", mode: 0o600, signal: options.signal });
	const layer: CanvasArtifactLayer = {
		id: `${workspace.graphId}/${workspace.runId}/${workspace.nodeId}/${outputTree}`,
		patchPath,
		sha256: createHash("sha256").update(patch).digest("hex"),
	};
	return {
		graphId: workspace.graphId,
		runId: workspace.runId,
		nodeId: workspace.nodeId,
		repoRoot: workspace.repoRoot,
		baseCommit: workspace.baseCommit,
		patchPath,
		outputTree,
		layers: [...layersOf(workspace.upstreamArtifacts), layer],
	};
}

export async function cleanupCanvasWorkspace(
	workspace: CanvasWorkspace,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	checkSignal(options.signal);
	if (!workspace.isolated || !workspace.worktreePath || !workspace.repoRoot || !workspace.baseCommit) return;
	if (resolve(workspace.worktreePath) !== workspaceDir(workspace, "workspaces"))
		throw new CanvasRuntimeError("Invalid canvas cleanup path", "error.invalidCleanupPath");
	await assertWorkspaceIdentity(workspace, options.signal);
	const head = (await git(workspace.worktreePath, ["rev-parse", "HEAD"], options.signal)).trim();
	if (
		head !== workspace.baseCommit ||
		(await git(workspace.worktreePath, ["status", "--porcelain", "--untracked-files=all"], options.signal)).trim()
	) {
		throw new CanvasRuntimeError(
			"Canvas workspace has pending artifacts or commits; retained for explicit adoption",
			"error.pendingArtifacts",
		);
	}
	await git(workspace.repoRoot, ["worktree", "remove", workspace.worktreePath], options.signal);
	workspaceIdentities.delete(workspace);
}
