import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ContextManifest, DeviceArtifact, DeviceWorkContract } from "../protocol.js";
import {
	applyBinaryPatch,
	canonicalPath,
	checkSignal,
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
} from "../workspace-handle.js";
import {
	computeArtifactDigest,
	deepFreeze,
	validateContextManifest,
	validateDeviceArtifact,
	validateInputArtifacts,
	validateWorkContract,
} from "./work-contract.js";
import { validateDeviceProject } from "./workspaces.js";

export const MAX_TASK_ARTIFACT_PATCH_BYTES = 128 * 1024;

export interface TaskWorkspaceBinding {
	deviceId: string;
	botId: string;
	botRevision: number;
	taskId: string;
	attemptId: string;
}

export interface TaskWorkspaceHandle {
	readonly handleId: string;
	readonly deviceId: string;
	readonly botId: string;
	readonly taskId: string;
	readonly attemptId: string;
}

export interface PrepareTaskWorkspaceOptions {
	dataDir: string;
	deviceId: string;
	botId: string;
	botRevision: number;
	taskId: string;
	attemptId: string;
	repoRoot: string;
	contract: DeviceWorkContract;
	contextManifest: ContextManifest;
	signal?: AbortSignal;
}

export interface ResolvedTaskWorkspace {
	cwd: string;
	repoRoot: string;
	worktreePath: string;
	baseCommit: string;
	contractDigest: string;
	manifestDigest: string;
	inputTree?: string;
}

export interface TaskWorkspaceCapability {
	readonly handleId: string;
	readonly binding: TaskWorkspaceBinding;
	resolve(): Promise<ResolvedTaskWorkspace>;
	getCwd(): Promise<string>;
	getRepoRoot(): Promise<string>;
	captureArtifact(signal?: AbortSignal): Promise<DeviceArtifact>;
	cleanup(options?: { force?: boolean; signal?: AbortSignal }): Promise<void>;
}

interface TaskWorkspaceRecord {
	handleId: string;
	deviceId: string;
	botId: string;
	botRevision: number;
	taskId: string;
	attemptId: string;
	repoRoot: string;
	worktreePath: string;
	canonicalWorktreePath: string;
	canonicalGitDir: string;
	canonicalCommonDir: string;
	bindingKey: string;
	workspaceRef: string;
	workspaceCommit: string;
	artifactRef: string;
	repositoryId: string;
	baseCommit: string;
	contract: DeviceWorkContract;
	contextManifest: ContextManifest;
	dataDir: string;
	inputTree?: string;
	createdAt: number;
	artifactCaptured?: DeviceArtifact;
	captureFlight?: Promise<DeviceArtifact>;
	cleanupFlight?: Promise<void>;
	closing?: boolean;
}

const workspaceRegistry = new Map<string, TaskWorkspaceRecord>();
const preparingBindings = new Set<string>();
const trustedCapabilities = new WeakMap<object, { handleId: string; binding: TaskWorkspaceBinding }>();

function bindingKey(binding: TaskWorkspaceBinding): string {
	return createHash("sha256")
		.update(JSON.stringify([binding.deviceId, binding.botId, binding.botRevision, binding.taskId, binding.attemptId]))
		.digest("hex");
}

export function isTrustedTaskWorkspaceCapability(value: unknown): value is TaskWorkspaceCapability {
	if (!value || typeof value !== "object") return false;
	const trusted = trustedCapabilities.get(value);
	return !!trusted && workspaceRegistry.has(trusted.handleId);
}

export async function resolveTrustedTaskWorkspace(
	capability: unknown,
	binding: TaskWorkspaceBinding,
): Promise<ResolvedTaskWorkspace> {
	if (!capability || typeof capability !== "object") throw new Error("Untrusted task workspace capability");
	const trusted = trustedCapabilities.get(capability);
	if (!trusted) throw new Error("Untrusted task workspace capability");
	return resolveTaskWorkspace(trusted.handleId, binding);
}

function getRegisteredRecord(handle: TaskWorkspaceHandle | string, binding: TaskWorkspaceBinding): TaskWorkspaceRecord {
	const handleId = typeof handle === "string" ? handle.trim() : handle?.handleId?.trim();
	if (!handleId) {
		throw new Error("Invalid task workspace handle: missing handleId");
	}
	const record = workspaceRegistry.get(handleId);
	if (!record) {
		throw new Error(`Unregistered or expired task workspace handle: ${handleId}`);
	}

	if (
		binding.deviceId !== record.deviceId ||
		binding.botId !== record.botId ||
		binding.botRevision !== record.botRevision ||
		binding.taskId !== record.taskId ||
		binding.attemptId !== record.attemptId
	) {
		throw new Error(
			`Task workspace binding mismatch for handle ${handleId}: caller binding does not match registered capability`,
		);
	}

	return record;
}

export async function prepareTaskWorkspace(options: PrepareTaskWorkspaceOptions): Promise<TaskWorkspaceHandle> {
	checkSignal(options.signal);
	options = { ...options };
	const key = bindingKey(options);
	if (preparingBindings.has(key) || [...workspaceRegistry.values()].some((record) => record.bindingKey === key)) {
		throw new Error("Task workspace binding is already preparing or registered");
	}
	preparingBindings.add(key);
	try {
		return await prepareRegisteredWorkspace(options, key);
	} finally {
		preparingBindings.delete(key);
	}
}

async function prepareRegisteredWorkspace(
	options: PrepareTaskWorkspaceOptions,
	key: string,
): Promise<TaskWorkspaceHandle> {
	const deviceId = safeId(options.deviceId, "deviceId");
	const botId = safeId(options.botId, "botId");
	const taskId = safeId(options.taskId, "taskId");
	const attemptId = safeId(options.attemptId, "attemptId");

	if (!Number.isSafeInteger(options.botRevision) || options.botRevision < 1) {
		throw new Error(`Invalid botRevision: ${options.botRevision}`);
	}

	const contractCheck = validateWorkContract(deepFreeze(structuredClone(options.contract)));
	if (!contractCheck.valid) {
		throw new Error(`Invalid task contract: ${contractCheck.reason}`);
	}
	const contract = contractCheck.contract;

	const manifestCheck = validateContextManifest(deepFreeze(structuredClone(options.contextManifest)), contract);
	if (!manifestCheck.valid) {
		throw new Error(`Invalid context manifest: ${manifestCheck.reason}`);
	}
	const contextManifest = manifestCheck.manifest;

	const validatedProjectRoot = await validateDeviceProject(options.repoRoot, options.dataDir);
	const { repoRoot } = await verifyRepoRoot(validatedProjectRoot, options.signal);
	if (validatedProjectRoot !== repoRoot) {
		throw new Error(
			"Task code workspace requires Bot.cwd at the Git repository root; subdirectory code workspaces are not supported",
		);
	}

	const baselineStatus = (
		await git(repoRoot, ["status", "--porcelain", "--untracked-files=all"], options.signal)
	).trim();
	if (baselineStatus.length > 0) {
		throw new Error("Device task workspace requires a clean baseline repository; commit or stash changes first");
	}

	const canonicalRepoId = await computeCanonicalRepositoryId(repoRoot, options.signal);
	let baseCommit: string;
	if (contract.baseline) {
		const candidateCommit = contract.baseline.commit.trim().toLowerCase();
		try {
			baseCommit = (
				await git(repoRoot, ["rev-parse", "--verify", `${candidateCommit}^{commit}`], options.signal)
			).trim();
		} catch (error) {
			checkSignal(options.signal);
			throw new Error(`Baseline commit ${candidateCommit} does not exist in repository ${repoRoot}`, {
				cause: error,
			});
		}

		const expectedRepoId = contract.baseline.repositoryId.trim();
		if (expectedRepoId !== canonicalRepoId) {
			throw new Error(
				`Repository identity mismatch: baseline specifies '${expectedRepoId}', local repository is '${canonicalRepoId}'`,
			);
		}
	} else {
		baseCommit = (await git(repoRoot, ["rev-parse", "HEAD"], options.signal)).trim();
	}

	const handleId = randomUUID();
	const refNamespace = `${key}/${handleId}`;
	const resolvedDataDir = resolve(options.dataDir);
	const worktreeDir = join(resolvedDataDir, "task-workspaces", handleId);

	if (!inside(resolvedDataDir, worktreeDir)) {
		throw new Error("Task workspace directory escapes dataDir");
	}
	if (inside(repoRoot, worktreeDir)) {
		throw new Error("Task workspace dataDir must be outside the baseline repository");
	}
	if (existsSync(worktreeDir)) {
		throw new Error(`Task workspace directory already exists: ${worktreeDir}; refusing overwrite`);
	}

	let creationAttempted = false;
	let workspaceCommit: string | undefined;
	const workspaceRef = `refs/pi-tasks/workspaces/${refNamespace}`;
	const artifactRef = `refs/pi-tasks/artifacts/${refNamespace}`;

	try {
		creationAttempted = true;
		await createDetachedWorktree(repoRoot, worktreeDir, baseCommit, options.signal);

		const identity = await verifyWorktreeIdentity(worktreeDir, repoRoot, options.signal);
		const canonicalWorktreePath = identity.toplevel;
		const canonicalGitDir = identity.gitDir;

		let inputTree = (await git(repoRoot, ["rev-parse", `${baseCommit}^{tree}`], options.signal)).trim();

		if (contract.inputArtifacts && contract.inputArtifacts.length > 0) {
			const synthCheck = validateInputArtifacts(contract.inputArtifacts, contract.baseline, contract.executionMode);
			if (!synthCheck.valid) {
				throw new Error(`Invalid contract inputArtifacts: ${synthCheck.reason}`);
			}

			const touched = new Set<string>();
			for (const artifact of contract.inputArtifacts) {
				if (!artifact.baseline || !artifact.outputTree) {
					throw new Error(`Input artifact ${artifact.id} requires baseline and outputTree proof`);
				}
				if (
					artifact.baseline.repositoryId !== canonicalRepoId ||
					artifact.baseline.commit.toLowerCase() !== baseCommit
				) {
					throw new Error(`Input artifact ${artifact.id} baseline mismatch`);
				}
				if (artifact.patchBase64 === undefined) {
					throw new Error(`Input artifact ${artifact.id} has no patchBase64`);
				}
				const patchBytes = Buffer.from(artifact.patchBase64, "base64");
				if (patchBytes.length > MAX_TASK_ARTIFACT_PATCH_BYTES) {
					throw new Error(`Input artifact ${artifact.id} patch exceeds size limit of 128 KiB`);
				}
				const computedPatchSha256 = createHash("sha256").update(patchBytes).digest("hex");
				if (computedPatchSha256.toLowerCase() !== artifact.patchSha256?.toLowerCase()) {
					throw new Error(`Input artifact ${artifact.id} patchSha256 checksum mismatch`);
				}

				await verifyPatchProducesTree(
					repoRoot,
					baseCommit,
					patchBytes,
					artifact.outputTree,
					resolvedDataDir,
					options.signal,
				);
				const paths = (
					await git(
						repoRoot,
						[
							"diff",
							"--no-ext-diff",
							"--no-textconv",
							"--no-renames",
							"--name-only",
							"-z",
							baseCommit,
							artifact.outputTree,
							"--",
						],
						options.signal,
					)
				)
					.split("\0")
					.filter(Boolean);
				for (const path of paths) {
					if (
						[...touched].some((other) => path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`))
					) {
						throw new Error(
							`Input artifact conflict: overlapping or ancestor input at ${path}; cumulative layers are not deduplicated`,
						);
					}
					touched.add(path);
				}

				await applyBinaryPatch(worktreeDir, patchBytes, options.signal);
			}

			inputTree = await snapshotTree(
				worktreeDir,
				options.dataDir,
				options.signal,
				join("task-workspaces", "input-indexes"),
			);
		}

		workspaceCommit = (
			await git(repoRoot, ["commit-tree", inputTree, "-p", baseCommit, "-m", "pi-task-workspace"], options.signal)
		).trim();
		checkSignal(options.signal);
		await git(repoRoot, ["update-ref", workspaceRef, workspaceCommit, "0".repeat(baseCommit.length)]);
		const record: TaskWorkspaceRecord = {
			handleId,
			deviceId,
			botId,
			botRevision: options.botRevision,
			taskId,
			attemptId,
			repoRoot,
			worktreePath: worktreeDir,
			canonicalWorktreePath,
			canonicalGitDir,
			canonicalCommonDir: identity.commonDir,
			bindingKey: key,
			workspaceRef,
			workspaceCommit,
			artifactRef,
			repositoryId: canonicalRepoId,
			baseCommit,
			contract,
			contextManifest,
			dataDir: resolvedDataDir,
			inputTree,
			createdAt: Date.now(),
		};

		workspaceRegistry.set(handleId, record);

		return Object.freeze({ handleId, deviceId, botId, taskId, attemptId });
	} catch (error) {
		const failures: unknown[] = [];
		if (creationAttempted && existsSync(worktreeDir)) {
			try {
				const identity = await verifyWorktreeIdentity(worktreeDir, repoRoot);
				if (identity.toplevel !== worktreeDir || identity.headCommit !== baseCommit)
					throw new Error("Failed workspace ownership cannot be verified; retained for inspection");
				await removeDetachedWorktree(repoRoot, worktreeDir, { force: true });
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
		}
		if (workspaceCommit) {
			try {
				await git(repoRoot, ["update-ref", "-d", workspaceRef, workspaceCommit]);
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
		}
		if (failures.length)
			throw new AggregateError(
				[error, ...failures],
				"Workspace preparation failed; cleanup incomplete, retained for inspection",
				{ cause: error },
			);
		throw error;
	}
}

export async function resolveTaskWorkspace(
	handle: TaskWorkspaceHandle | string,
	binding: TaskWorkspaceBinding,
): Promise<ResolvedTaskWorkspace> {
	const record = getRegisteredRecord(handle, binding);
	if (record.closing) throw new Error("Task workspace cleanup is in progress");

	const canonicalCurrent = await canonicalPath(record.worktreePath);
	if (canonicalCurrent !== record.canonicalWorktreePath) {
		throw new Error(
			`Task workspace path redirect detected: expected ${record.canonicalWorktreePath}, resolved to ${canonicalCurrent}`,
		);
	}

	await verifyWorktreeIdentity(
		record.worktreePath,
		record.repoRoot,
		undefined,
		record.canonicalGitDir,
		record.canonicalCommonDir,
	);

	return {
		cwd: record.worktreePath,
		repoRoot: record.repoRoot,
		worktreePath: record.worktreePath,
		baseCommit: record.baseCommit,
		contractDigest: record.contract.digest,
		manifestDigest: record.contextManifest.digest,
		inputTree: record.inputTree,
	};
}

export function getTaskWorkspaceCapability(
	handle: TaskWorkspaceHandle | string,
	binding: TaskWorkspaceBinding,
): TaskWorkspaceCapability {
	const record = getRegisteredRecord(handle, binding);
	const registeredBinding = Object.freeze({
		deviceId: record.deviceId,
		botId: record.botId,
		botRevision: record.botRevision,
		taskId: record.taskId,
		attemptId: record.attemptId,
	});
	const capability: TaskWorkspaceCapability = Object.freeze({
		handleId: record.handleId,
		binding: registeredBinding,
		resolve: () => resolveTaskWorkspace(record.handleId, registeredBinding),
		getCwd: async () => (await resolveTaskWorkspace(record.handleId, registeredBinding)).cwd,
		getRepoRoot: async () => (await resolveTaskWorkspace(record.handleId, registeredBinding)).repoRoot,
		captureArtifact: (signal?: AbortSignal) => captureTaskArtifact(record.handleId, registeredBinding, signal),
		cleanup: (options?: { force?: boolean; signal?: AbortSignal }) =>
			cleanupTaskWorkspace(record.handleId, registeredBinding, options),
	});
	trustedCapabilities.set(capability, { handleId: record.handleId, binding: registeredBinding });
	return capability;
}

export async function captureTaskArtifact(
	handle: TaskWorkspaceHandle | string,
	binding: TaskWorkspaceBinding,
	signal?: AbortSignal,
): Promise<DeviceArtifact> {
	checkSignal(signal);
	const record = getRegisteredRecord(handle, binding);

	if (record.closing) throw new Error("Task workspace cleanup is in progress");
	if (record.artifactCaptured) return record.artifactCaptured;
	if (!record.captureFlight) {
		record.captureFlight = captureRegisteredArtifact(record, signal).finally(() => {
			record.captureFlight = undefined;
		});
	}
	const artifact = await record.captureFlight;
	checkSignal(signal);
	return artifact;
}

async function captureRegisteredArtifact(record: TaskWorkspaceRecord, signal?: AbortSignal): Promise<DeviceArtifact> {
	const canonicalCurrent = await canonicalPath(record.worktreePath);
	if (canonicalCurrent !== record.canonicalWorktreePath) {
		throw new Error(
			`Task workspace path redirect detected during capture: expected ${record.canonicalWorktreePath}, resolved to ${canonicalCurrent}`,
		);
	}

	await verifyWorktreeIdentity(
		record.worktreePath,
		record.repoRoot,
		signal,
		record.canonicalGitDir,
		record.canonicalCommonDir,
	);

	const outputTree = await snapshotTree(
		record.worktreePath,
		record.dataDir,
		signal,
		join("task-workspaces", "output-indexes"),
	);

	await verifyWorktreeIdentity(
		record.worktreePath,
		record.repoRoot,
		signal,
		record.canonicalGitDir,
		record.canonicalCommonDir,
	);

	const baseTree = (await git(record.repoRoot, ["rev-parse", `${record.baseCommit}^{tree}`], signal)).trim();
	const patchStr = await git(
		record.worktreePath,
		["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", baseTree, outputTree, "--"],
		signal,
	);

	const patchBytes = Buffer.from(patchStr, "utf8");
	if (patchBytes.length > MAX_TASK_ARTIFACT_PATCH_BYTES) {
		throw new Error(
			`Artifact patch size (${patchBytes.length} bytes) exceeds maximum limit of ${MAX_TASK_ARTIFACT_PATCH_BYTES} bytes (128 KiB)`,
		);
	}

	const patchSha256 = createHash("sha256").update(patchBytes).digest("hex");
	const patchBase64 = patchBytes.toString("base64");

	const retentionCommit = (
		await git(
			record.repoRoot,
			[
				"commit-tree",
				outputTree,
				"-p",
				record.workspaceCommit,
				"-m",
				`pi-task-artifact: task=${record.taskId} attempt=${record.attemptId}`,
			],
			signal,
		)
	).trim();

	const artifact: DeviceArtifact = {
		id: `artifact-${randomUUID()}`,
		digest: "",
		producer: {
			deviceId: record.deviceId,
			botId: record.botId,
			taskId: record.taskId,
			attemptId: record.attemptId,
			contractDigest: record.contract.digest,
			manifestDigest: record.contextManifest.digest,
		},
		baseline: { repositoryId: record.repositoryId, commit: record.baseCommit },
		inputTree: record.inputTree,
		outputTree,
		patchBase64,
		patchSha256,
		createdAt: Date.now(),
	};

	artifact.digest = computeArtifactDigest(artifact);

	const validated = validateDeviceArtifact(artifact);
	if (!validated.valid) {
		throw new Error(`Constructed invalid artifact: ${validated.reason}`);
	}

	const immutable = deepFreeze(structuredClone(validated.artifact));
	checkSignal(signal);
	await git(record.repoRoot, ["update-ref", record.artifactRef, retentionCommit, "0".repeat(record.baseCommit.length)]);
	record.artifactCaptured = immutable;
	return immutable;
}

export async function cleanupTaskWorkspace(
	handle: TaskWorkspaceHandle | string,
	binding: TaskWorkspaceBinding,
	options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
	checkSignal(options.signal);
	const record = getRegisteredRecord(handle, binding);
	if (!record.cleanupFlight) {
		record.closing = true;
		record.cleanupFlight = cleanupRegisteredWorkspace(record, options).finally(() => {
			record.closing = false;
			record.cleanupFlight = undefined;
		});
	}
	return record.cleanupFlight;
}

async function cleanupRegisteredWorkspace(
	record: TaskWorkspaceRecord,
	options: { force?: boolean; signal?: AbortSignal },
): Promise<void> {
	await record.captureFlight;
	checkSignal(options.signal);
	const canonicalCurrent = await canonicalPath(record.worktreePath);
	if (canonicalCurrent !== record.canonicalWorktreePath) {
		throw new Error(
			`Task workspace path redirect detected during cleanup: expected ${record.canonicalWorktreePath}, resolved to ${canonicalCurrent}`,
		);
	}

	await verifyWorktreeIdentity(
		record.worktreePath,
		record.repoRoot,
		options.signal,
		record.canonicalGitDir,
		record.canonicalCommonDir,
	);

	if (!options.force) {
		const head = (await git(record.worktreePath, ["rev-parse", "HEAD"], options.signal)).trim();
		if (head !== record.baseCommit) {
			throw new Error("Task workspace has additional commits; retained for inspection");
		}
		const status = (
			await git(record.worktreePath, ["status", "--porcelain", "--untracked-files=all"], options.signal)
		).trim();
		if (status.length > 0) {
			throw new Error("Task workspace has uncommitted changes; retained for inspection");
		}
	}

	checkSignal(options.signal);
	await removeDetachedWorktree(record.repoRoot, record.worktreePath, { force: options.force });
	try {
		await git(record.repoRoot, ["update-ref", "-d", record.workspaceRef, record.workspaceCommit]);
	} finally {
		workspaceRegistry.delete(record.handleId);
	}
}

export function getRegisteredWorkspaceCount(): number {
	return workspaceRegistry.size;
}

export function clearTaskWorkspaceRegistry(): void {
	workspaceRegistry.clear();
}
