import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
	DeviceArtifact,
	DeviceDeliveryArtifactRef,
	DeviceIntegrationVerificationFacts,
	DeviceIntegrationVerificationPlan,
} from "../protocol.js";
import {
	canonicalPath,
	computeCanonicalRepositoryId,
	git,
	safeId,
	verifyPatchProducesTree,
	verifyRepoRoot,
	verifyWorktreeIdentity,
	snapshotTree,
} from "../workspace-handle.js";
import { canonicalizeJson, validateDeviceArtifact } from "./work-contract.js";
import {
	runVerificationCommand,
	validateLocalVerificationPlan,
	VERIFICATION_COMMAND_TIMEOUT_MS,
	VERIFICATION_TOTAL_TIMEOUT_MS,
	VerificationStopUnconfirmedError,
} from "./local-verification.js";
import { integrationError } from "./integration-errors.js";

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const MAX_DIFF_BYTES = 64 * 1024;

export interface DeviceIntegrationSession {
	integrationId: string;
	targetBotId: string;
	targetBotRevision: number;
	worktreePath: string;
	repoRoot: string;
	branch: string;
	expectedTargetSha: string;
	deliveryCommit: string;
	preparedTreeSha: string;
	newCommitSha?: string;
	applied?: boolean;
	createdAt: number;
	gitDir?: string;
	commonDir?: string;
	artifactRef?: DeviceDeliveryArtifactRef;
	retainedRef?: string;
	localVerification?: DeviceIntegrationVerificationFacts;
	verifiedPlan?: DeviceIntegrationVerificationPlan;
	stopUnconfirmed?: boolean;
	verificationInFlight?: boolean;
	verificationStopConfirmed?: boolean;
}

/** 持久化会话映射表文件路径 */
function sessionsFilePath(dataDir: string): string {
	return join(dataDir, "integration-sessions.json");
}

/** 从磁盘读取持久化的集成会话记录 */
export async function loadPersistentSessions(dataDir: string): Promise<Map<string, DeviceIntegrationSession>> {
	const filePath = sessionsFilePath(dataDir);
	const map = new Map<string, DeviceIntegrationSession>();
	if (!existsSync(filePath)) return map;
	try {
		const raw = await readFile(filePath, "utf8");
		const data = JSON.parse(raw);
		if (Array.isArray(data)) {
			for (const item of data) {
				if (item && typeof item.integrationId === "string") {
					map.set(item.integrationId, item);
				}
			}
		}
	} catch {
		// ignore corrupted read
	}
	return map;
}

/** 原子保存持久化的集成会话记录 */
export async function savePersistentSessions(
	dataDir: string,
	sessionsMap: Map<string, DeviceIntegrationSession>,
): Promise<void> {
	const filePath = sessionsFilePath(dataDir);
	const tempPath = `${filePath}.tmp.${randomUUID()}`;
	const data = Array.from(sessionsMap.values());
	await writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
	const { rename } = await import("node:fs/promises");
	await rename(tempPath, filePath);
}

const sessionWrites = new Map<string, Promise<void>>();
function persistSession(dataDir: string, integrationId: string, session?: DeviceIntegrationSession): Promise<void> {
	const key = resolve(dataDir);
	const snapshot = session && structuredClone(session);
	const operation = (sessionWrites.get(key) ?? Promise.resolve())
		.catch(() => {})
		.then(async () => {
			const sessions = await loadPersistentSessions(dataDir);
			if (snapshot) sessions.set(integrationId, snapshot);
			else sessions.delete(integrationId);
			await savePersistentSessions(dataDir, sessions);
		});
	sessionWrites.set(key, operation);
	void operation
		.finally(() => {
			if (sessionWrites.get(key) === operation) sessionWrites.delete(key);
		})
		.catch(() => {});
	return operation;
}

/** 内存活跃会话映射及操作中断控制器 */
const memorySessions = new Map<string, DeviceIntegrationSession>();
type IntegrationIdentity = {
	integrationId: string;
	targetBotId: string;
	targetBotRevision: number;
	repoRoot: string;
	dataDir: string;
};
type LocalOperation = {
	controller: AbortController;
	identity: IntegrationIdentity;
	done: Promise<unknown>;
	blocked?: unknown;
};
const activeOperations = new Map<string, LocalOperation>();
const sessionKey = (params: Pick<IntegrationIdentity, "dataDir" | "integrationId">) =>
	JSON.stringify([resolve(params.dataDir), params.integrationId]);
function sameIdentity(a: IntegrationIdentity, b: IntegrationIdentity) {
	return (
		a.targetBotId === b.targetBotId &&
		a.targetBotRevision === b.targetBotRevision &&
		resolve(a.repoRoot) === resolve(b.repoRoot)
	);
}
function localOperation<T>(
	params: IntegrationIdentity,
	signal: AbortSignal | undefined,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	safeId(params.integrationId, "integration");
	const key = sessionKey(params);
	if (activeOperations.has(key))
		return Promise.reject(new Error("Integration operation already active or stop unconfirmed"));
	const operation: LocalOperation = {
		controller: new AbortController(),
		identity: { ...params },
		done: Promise.resolve(),
	};
	activeOperations.set(key, operation);
	operation.done = Promise.resolve()
		.then(() => run(AbortSignal.any([operation.controller.signal, ...(signal ? [signal] : [])])))
		.catch(async (error) => {
			if (error instanceof VerificationStopUnconfirmedError) {
				operation.blocked = error;
				const session = memorySessions.get(key);
				if (session) {
					session.stopUnconfirmed = true;
					await persistSession(params.dataDir, params.integrationId, session).catch(() => {});
				}
			}
			throw error;
		})
		.finally(() => {
			if (!operation.blocked && activeOperations.get(key) === operation) activeOperations.delete(key);
		});
	return operation.done as Promise<T>;
}

function sanitizeError(error: unknown): string {
	if (!error) return "Unknown error";
	const msg = error instanceof Error ? error.message : String(error);
	return msg
		.replace(/\/\/[^@\s]+@/g, "//***@")
		.split("\n")[0]
		.trim()
		.slice(0, 500);
}

/** 确保受控的空 Git 配置文件以移植跨平台禁用全局配置 */
async function getVerifiedEmptyConfigFile(dataDir: string): Promise<string> {
	const file = resolve(dataDir, ".safe-empty-gitconfig");
	if (!existsSync(file)) {
		await writeFile(file, "", "utf8");
	}
	return file.replace(/\\/g, "/");
}

/** 确保受控的临时空 Home 目录，防验证命令读取宿主真实 ~/.ssh, ~/.gitconfig 或 ~/.npmrc 等密钥配置 */
async function getVerifiedEmptyHomeDir(dataDir: string): Promise<string> {
	const dir = resolve(dataDir, ".safe-empty-home");
	if (!existsSync(dir)) {
		await mkdir(dir, { recursive: true });
	}
	return dir.replace(/\\/g, "/");
}

/** 构造受限的隔离环境变量，剥离所有宿主 Token、密钥与真实 Home 配置（大小写不敏感兼容 Windows） */
async function buildIsolatedEnv(dataDir: string): Promise<NodeJS.ProcessEnv> {
	const emptyConfig = await getVerifiedEmptyConfigFile(dataDir);
	const emptyHome = await getVerifiedEmptyHomeDir(dataDir);
	const allowedUpperKeys = new Set([
		"PATH",
		"PATHEXT",
		"SYSTEMROOT",
		"WINDIR",
		"SYSTEMDRIVE",
		"COMSPEC",
		"TEMP",
		"TMP",
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
	]);
	const env: NodeJS.ProcessEnv = {
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: emptyConfig,
		HOME: emptyHome,
		USERPROFILE: emptyHome,
	};
	for (const [key, val] of Object.entries(process.env)) {
		if (val !== undefined && allowedUpperKeys.has(key.toUpperCase())) {
			env[key] = val;
		}
	}
	return env;
}

/** 确保受控的空 hook 目录，通过 lstat 严格验证不是软链接且内部为空 */
async function getVerifiedEmptyHooksDir(dataDir: string): Promise<string> {
	const dir = resolve(dataDir, ".safe-git-hooks");
	if (!existsSync(dir)) {
		await mkdir(dir, { recursive: true });
	}
	const stat = await lstat(dir);
	if (stat.isSymbolicLink()) {
		await unlink(dir);
		await mkdir(dir, { recursive: true });
	}
	const entries = await readdir(dir);
	if (entries.length > 0) {
		for (const entry of entries) {
			await rm(join(dir, entry), { recursive: true, force: true });
		}
	}
	return dir.replace(/\\/g, "/");
}

/** 严格核验仓库无外部可执行 merge/filter/diff 驱动配置 */
export async function verifyNoExternalDrivers(repoRoot: string, dataDir: string): Promise<void> {
	const env = await buildIsolatedEnv(dataDir);
	try {
		const { stdout } = await exec(
			"git",
			["config", "--get-regexp", "^(merge\\..*\\.driver|filter\\..*\\.(clean|smudge|process)|diff\\..*\\.command)$"],
			{ cwd: repoRoot, windowsHide: true, timeout: 5000, env },
		);
		if (stdout.trim().length > 0) {
			throw integrationError("INTEGRATION_CUSTOM_DRIVER");
		}
	} catch (error) {
		const err = error as { code?: number | string; message?: string };
		if (err.code === 1) return;
		if (err.code === "INTEGRATION_CUSTOM_DRIVER") throw error;
	}
}

/** 检查 .gitattributes 中是否定义了外部自定义驱动 */
export async function verifyGitAttributesSafe(cwd: string, _dataDir: string): Promise<void> {
	const attrPath = join(cwd, ".gitattributes");
	if (!existsSync(attrPath)) return;
	const stat = await lstat(attrPath);
	if (stat.isSymbolicLink()) {
		throw new Error(".gitattributes symbolic link rejected for safety");
	}
	const content = await readFile(attrPath, "utf8");
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		if (/\b(?:filter|merge|diff)=\s*(?!binary\b|text\b|union\b|unset\b|set\b)[a-zA-Z0-9_-]+/i.test(trimmed)) {
			throw integrationError("INTEGRATION_CUSTOM_DRIVER");
		}
	}
}

/** 严格校验分支名：拒绝以 '-' 开头，并通过 git check-ref-format --branch 检验 */
export async function validateBranchName(cwd: string, branch: string): Promise<string> {
	const trimmed = (branch || "").trim();
	if (!trimmed || trimmed.startsWith("-")) {
		throw new Error("Invalid branch name");
	}
	try {
		await exec("git", ["check-ref-format", "--branch", trimmed], {
			cwd,
			windowsHide: true,
			timeout: 5000,
		});
		return trimmed;
	} catch {
		throw new Error(`Invalid branch format: ${trimmed}`);
	}
}

/** 安全参数执行 Git 命令：强制空 hooks、禁用 gpg 签名、禁用 autocrlf */
export async function runIsolatedGit(
	cwd: string,
	dataDir: string,
	args: string[],
	timeoutMs = GIT_TIMEOUT_MS,
	options?: { signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
	const emptyHooks = await getVerifiedEmptyHooksDir(dataDir);
	const env = await buildIsolatedEnv(dataDir);
	const safeArgs = [
		"-c",
		`core.hooksPath=${emptyHooks}`,
		"-c",
		"commit.gpgSign=false",
		"-c",
		"core.autocrlf=false",
		"-c",
		"core.fsmonitor=false",
		"-c",
		"core.eol=lf",
		"-c",
		"core.quotepath=false",
		...args,
	];
	try {
		const result = await exec("git", safeArgs, {
			cwd,
			timeout: timeoutMs,
			maxBuffer: 8 * 1024 * 1024,
			windowsHide: true,
			env,
			signal: options?.signal,
		});
		return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	} catch (error) {
		const err = error as { message?: string; stderr?: string; stdout?: string; code?: number };
		const sanitized = sanitizeError(err.stderr || err.stdout || err.message);
		throw Object.assign(new Error(sanitized), {
			exitCode: err.code,
		});
	}
}

/** 获取隔离工作树根目录，通过 lstat + realpath 链与 within 验证，禁止逃逸出 dataDir */
export async function getVerifiedWorktreesRoot(dataDir: string): Promise<string> {
	const dataDirStat = await lstat(dataDir);
	if (dataDirStat.isSymbolicLink()) {
		throw new Error("dataDir must not be a symbolic link");
	}
	const dataDirReal = await realpath(dataDir);

	const root = resolve(dataDirReal, "integration-worktrees");
	if (!existsSync(root)) {
		await mkdir(root, { recursive: true });
	}
	const rootStat = await lstat(root);
	if (rootStat.isSymbolicLink()) {
		throw new Error("Worktrees root must not be a symbolic link");
	}
	const rootReal = await realpath(root);

	const relative = resolve(rootReal);
	const dataNorm = resolve(dataDirReal);
	const isContained =
		process.platform === "win32"
			? relative.toLowerCase().startsWith(dataNorm.toLowerCase()) && relative.toLowerCase() !== dataNorm.toLowerCase()
			: relative.startsWith(dataNorm) && relative !== dataNorm;
	if (!isContained) {
		throw new Error("Worktrees root must be securely contained within dataDir");
	}
	return rootReal;
}

/** 检查仓库是否为 Git 且获取指定分支的当前 HEAD commit SHA 及未提交改动状态 */
export async function inspectLocalTarget(
	repoRoot: string,
	dataDir: string,
	branch: string,
	options?: { signal?: AbortSignal },
): Promise<{ headSha: string; isDirty: boolean }> {
	const validBranch = await validateBranchName(repoRoot, branch);
	const inside = await runIsolatedGit(
		repoRoot,
		dataDir,
		["rev-parse", "--is-inside-work-tree"],
		GIT_TIMEOUT_MS,
		options,
	).catch(() => null);
	if (!inside || inside.stdout.trim() !== "true") {
		throw new Error("Target workspace is not a valid Git repository");
	}

	await verifyNoExternalDrivers(repoRoot, dataDir);
	await verifyGitAttributesSafe(repoRoot, dataDir);

	const status = await runIsolatedGit(repoRoot, dataDir, ["status", "--porcelain"], GIT_TIMEOUT_MS, options);
	const isDirty = status.stdout.trim().length > 0;

	const rev = await runIsolatedGit(
		repoRoot,
		dataDir,
		["rev-parse", "--verify", `refs/heads/${validBranch}`],
		GIT_TIMEOUT_MS,
		options,
	).catch(() => {
		throw new Error(`Target branch '${validBranch}' not found in refs/heads/`);
	});
	const headSha = rev.stdout.trim();
	if (!/^[a-f0-9]{40,64}$/i.test(headSha)) {
		throw new Error(`Could not resolve branch refs/heads/${validBranch} HEAD commit`);
	}
	return { headSha, isDirty };
}

/** 安全非强制移除工作树 */
export async function safeRemoveWorktree(repoRoot: string, dataDir: string, worktreePath: string): Promise<void> {
	if (!existsSync(worktreePath)) return;
	const normalizedPath = worktreePath.replace(/\\/g, "/");
	const sessions = await loadPersistentSessions(dataDir);
	const session = [...sessions.values()].find((item) => resolve(item.worktreePath) === resolve(worktreePath));
	// Only discard the exact staged merge we prepared; preserve modified or unpinned workspaces.
	if (session) {
		if (session.stopUnconfirmed || session.verificationInFlight) throw new VerificationStopUnconfirmedError();
		await assertPreparedTree(session, dataDir);
		await runIsolatedGit(worktreePath, dataDir, ["merge", "--abort"]).catch(() => {});
	}
	try {
		await runIsolatedGit(repoRoot, dataDir, ["worktree", "remove", normalizedPath]);
	} catch (error) {
		const msg = sanitizeError(error);
		throw new Error(`Failed to safely remove worktree (cleanup_pending): ${msg}`);
	}
}

/** 扫描并清理孤儿工作树目录 */
export async function recoverOrphanWorktrees(
	dataDir: string,
	repoRootFinder?: (integrationId: string) => string | undefined,
): Promise<{ recoveredCount: number; pendingCount: number }> {
	const persisted = await loadPersistentSessions(dataDir);
	const worktreesRoot = await getVerifiedWorktreesRoot(dataDir).catch(() => undefined);
	if (!worktreesRoot || !existsSync(worktreesRoot)) return { recoveredCount: 0, pendingCount: 0 };

	const entries = await readdir(worktreesRoot).catch(() => []);
	let recoveredCount = 0;
	let pendingCount = 0;

	for (const entry of entries) {
		if (!entry.startsWith("int-")) continue;
		const id = entry.slice("int-".length);
		const fullPath = join(worktreesRoot, entry);
		const session = persisted.get(id);
		const repoRoot = session?.repoRoot ?? repoRootFinder?.(id);

		if (
			!session ||
			session.verificationStopConfirmed !== true ||
			session.stopUnconfirmed ||
			session?.verificationInFlight ||
			activeOperations.has(sessionKey({ dataDir, integrationId: id }))
		) {
			pendingCount++;
			continue;
		}
		if (repoRoot && existsSync(repoRoot)) {
			try {
				await safeRemoveWorktree(repoRoot, dataDir, fullPath);
				await persistSession(dataDir, id);
				recoveredCount++;
			} catch {
				pendingCount++;
			}
		} else {
			pendingCount++;
		}
	}
	return { recoveredCount, pendingCount };
}

/** 获取会话对象并严格核验多租户 Bot 身份、Revision 与工作区归属 */
async function getVerifiedSession(
	dataDir: string,
	params: {
		integrationId: string;
		targetBotId: string;
		targetBotRevision: number;
		repoRoot: string;
	},
	allowUnpinned = false,
): Promise<DeviceIntegrationSession> {
	const key = sessionKey({ dataDir, integrationId: params.integrationId });
	let session = memorySessions.get(key);
	if (!session) {
		const persisted = await loadPersistentSessions(dataDir);
		session = persisted.get(params.integrationId);
		if (session) memorySessions.set(key, session);
	}
	if (!session || !existsSync(session.worktreePath)) {
		throw new Error("Active integration worktree session not found on this device");
	}
	if (session.stopUnconfirmed || session.verificationInFlight) throw new VerificationStopUnconfirmedError();
	// 严格跨 Bot 隔离校验：防止 opaque ID 借由另一 Bot 的 lease 跨权操作
	if (
		session.targetBotId !== params.targetBotId ||
		session.targetBotRevision !== params.targetBotRevision ||
		resolve(session.repoRoot) !== resolve(params.repoRoot)
	) {
		throw new Error("Integration session Bot identity, revision or workspace mismatch");
	}
	if ((await verifyRepoRoot(params.repoRoot)).repoRoot !== (await canonicalPath(params.repoRoot)))
		throw new Error("Integration Bot workspace must be the canonical repository root");
	const identity = await verifyWorktreeIdentity(
		session.worktreePath,
		session.repoRoot,
		undefined,
		session.gitDir,
		session.commonDir,
	);
	if (
		(!allowUnpinned && (!session.gitDir || !session.commonDir)) ||
		(identity.headCommit !== session.expectedTargetSha && identity.headCommit !== session.newCommitSha)
	)
		throw new Error("Integration workspace identity changed or unpinned session");
	return session;
}

/** 设备本地：准备集成（创建隔离 worktree，尝试预合并并提取 diff 或冲突） */
async function prepareIntegration(
	params: {
		integrationId: string;
		targetBotId: string;
		targetBotRevision: number;
		repoRoot: string;
		dataDir: string;
		targetBranch: string;
		commit?: string;
		artifactRef?: DeviceDeliveryArtifactRef;
		artifact?: DeviceArtifact;
	},
	options?: { signal?: AbortSignal },
): Promise<{
	status: "prepared" | "conflict";
	materializedCommit?: string;
	preparedTree?: string;
	expectedTargetSha: string;
	conflicts?: string[];
	diff?: string;
}> {
	const { integrationId, targetBotId, targetBotRevision, dataDir, targetBranch } = params;
	const repoRoot = await canonicalPath(params.repoRoot);
	const repository = await verifyRepoRoot(repoRoot, options?.signal);
	if (repository.repoRoot !== repoRoot)
		throw new Error("Integration Bot workspace must be the canonical repository root");
	let commit = params.commit;
	let retainedRef: string | undefined;
	const { headSha: expectedTargetSha, isDirty } = await inspectLocalTarget(repoRoot, dataDir, targetBranch, options);
	if (isDirty) {
		const statusRes = await runIsolatedGit(repoRoot, dataDir, ["status", "--porcelain"], GIT_TIMEOUT_MS, options).catch(
			() => ({ stdout: "" }),
		);
		throw new Error(
			`Target repository has uncommitted changes (dirty state: ${statusRes.stdout.trim()}); cannot integrate`,
		);
	}

	if (params.artifactRef) {
		const ref = params.artifactRef;
		const checked = validateDeviceArtifact(params.artifact);
		if (!checked.valid || !checked.artifact) throw new Error("Invalid artifact payload");
		const artifact = checked.artifact;
		if (
			artifact.digest !== ref.artifactDigest ||
			artifact.id !== ref.artifactId ||
			artifact.producer.taskId !== ref.artifactTaskId ||
			artifact.producer.attemptId !== ref.attemptId ||
			artifact.producer.contractDigest !== ref.contractDigest ||
			artifact.producer.manifestDigest !== ref.manifestDigest ||
			artifact.baseline?.commit !== ref.baselineCommit ||
			artifact.baseline.repositoryId !== ref.repositoryId ||
			artifact.inputTree !== ref.inputTree ||
			artifact.outputTree !== ref.outputTree
		)
			throw new Error("Artifact subject mismatch");
		if ((await computeCanonicalRepositoryId(repoRoot, options?.signal)) !== ref.repositoryId)
			throw new Error("Canonical repository identity mismatch");
		if (expectedTargetSha !== ref.baselineCommit) throw new Error("Artifact target HEAD must equal baseline commit");
		await verifyPatchProducesTree(
			repoRoot,
			ref.baselineCommit,
			Buffer.from(artifact.patchBase64 ?? "", "base64"),
			ref.outputTree,
			dataDir,
			options?.signal,
		);
		commit = (
			await git(
				repoRoot,
				[
					"-c",
					"user.name=Device Hub Integration",
					"-c",
					"user.email=integration@local",
					"commit-tree",
					ref.outputTree,
					"-p",
					ref.baselineCommit,
					"-m",
					`Materialize artifact ${ref.artifactDigest}`,
				],
				options?.signal,
			)
		).trim();
		retainedRef = `refs/pi/integrations/${safeId(integrationId)}/${randomUUID()}`;
		await git(repoRoot, ["update-ref", retainedRef, commit], options?.signal);
	}
	if (!commit || !/^[a-f0-9]{40,64}$/i.test(commit)) throw new Error("Delivery commit required");
	const commitValid = await runIsolatedGit(
		repoRoot,
		dataDir,
		["cat-file", "-e", `${commit}^{commit}`],
		GIT_TIMEOUT_MS,
		options,
	)
		.then(() => true)
		.catch(() => false);
	if (!commitValid) {
		throw new Error(`Delivery commit ${commit} is missing in local repository`);
	}

	const worktreesRoot = await getVerifiedWorktreesRoot(dataDir);
	const worktreePath = resolve(worktreesRoot, `int-${integrationId}`);
	if (!worktreePath.startsWith(worktreesRoot)) {
		throw new Error("Worktree path traversal attempt rejected");
	}

	if (existsSync(worktreePath)) throw new Error("Integration worktree already exists; explicit cancellation required");

	// 检出 expectedTargetSha 的 detached 隔离工作树
	await runIsolatedGit(
		repoRoot,
		dataDir,
		["worktree", "add", "--detach", worktreePath, expectedTargetSha],
		GIT_TIMEOUT_MS,
		options,
	);
	await verifyGitAttributesSafe(worktreePath, dataDir);
	const identity = await verifyWorktreeIdentity(
		worktreePath,
		repoRoot,
		options?.signal,
		undefined,
		repository.commonDir,
	);

	const session: DeviceIntegrationSession = {
		integrationId,
		targetBotId,
		targetBotRevision,
		worktreePath,
		repoRoot,
		branch: targetBranch,
		expectedTargetSha,
		deliveryCommit: commit,
		preparedTreeSha: "",
		createdAt: Date.now(),
		gitDir: identity.gitDir,
		commonDir: identity.commonDir,
		artifactRef: params.artifactRef,
		retainedRef,
		verificationStopConfirmed: true,
	};

	try {
		await runIsolatedGit(worktreePath, dataDir, ["merge", "--no-commit", "--no-ff", commit], GIT_TIMEOUT_MS, options);

		const diffRes = await runIsolatedGit(worktreePath, dataDir, ["diff", "HEAD"], GIT_TIMEOUT_MS, options);
		const statRes = await runIsolatedGit(worktreePath, dataDir, ["diff", "--stat", "HEAD"], GIT_TIMEOUT_MS, options);
		const treeRes = await runIsolatedGit(worktreePath, dataDir, ["write-tree"], GIT_TIMEOUT_MS, options);
		session.preparedTreeSha = treeRes.stdout.trim();
		if (params.artifactRef && session.preparedTreeSha !== params.artifactRef.outputTree)
			throw new Error("Prepared tree does not match artifact outputTree");

		// 保存到内存和持久化磁盘
		memorySessions.set(sessionKey(params), session);
		await persistSession(dataDir, integrationId, session);

		const fullDiff = `${statRes.stdout}\n\n${diffRes.stdout}`.trim();
		const diff =
			fullDiff.length > MAX_DIFF_BYTES ? `${fullDiff.slice(0, MAX_DIFF_BYTES)}\n... [diff truncated]` : fullDiff;
		return {
			status: "prepared",
			expectedTargetSha,
			materializedCommit: commit,
			preparedTree: session.preparedTreeSha,
			diff,
		};
	} catch (mergeError) {
		const statusRes = await runIsolatedGit(
			worktreePath,
			dataDir,
			["status", "--porcelain"],
			GIT_TIMEOUT_MS,
			options,
		).catch(() => ({
			stdout: "",
		}));
		const conflictFiles: string[] = [];
		for (const line of statusRes.stdout.split("\n")) {
			const trimmed = line.trim();
			if (/^(?:UU|AA|UD|DU|DD|AU|UA)\s+(.+)$/.test(trimmed)) {
				const match = trimmed.match(/^(?:UU|AA|UD|DU|DD|AU|UA)\s+(.+)$/);
				if (match) conflictFiles.push(match[1]);
			}
		}
		if (conflictFiles.length > 0) {
			const diffRes = await runIsolatedGit(worktreePath, dataDir, ["diff"], GIT_TIMEOUT_MS, options).catch(() => ({
				stdout: "",
			}));
			const diff = diffRes.stdout.slice(0, MAX_DIFF_BYTES);
			await runIsolatedGit(worktreePath, dataDir, ["merge", "--abort"], GIT_TIMEOUT_MS, options).catch(() => {});
			return {
				status: "conflict",
				expectedTargetSha,
				conflicts: conflictFiles,
				diff,
			};
		}
		await safeRemoveWorktree(repoRoot, dataDir, worktreePath).catch(() => {});
		memorySessions.delete(sessionKey(params));
		throw mergeError;
	}
}

/** 设备本地：在隔离 worktree 中执行显式选择的验证命令（全量透传 signal 并支持 cancel 中断） */
async function assertPreparedTree(
	session: DeviceIntegrationSession,
	dataDir: string,
	signal?: AbortSignal,
): Promise<string> {
	const identity = await verifyWorktreeIdentity(
		session.worktreePath,
		session.repoRoot,
		signal,
		session.gitDir,
		session.commonDir,
	);
	if (identity.headCommit !== session.expectedTargetSha && identity.headCommit !== session.newCommitSha)
		throw new Error("Integration worktree HEAD changed");
	if (session.artifactRef) {
		const tree = (
			await runIsolatedGit(
				session.repoRoot,
				dataDir,
				["rev-parse", `${session.deliveryCommit}^{tree}`],
				GIT_TIMEOUT_MS,
				{ signal },
			)
		).stdout.trim();
		const parent = (
			await runIsolatedGit(session.repoRoot, dataDir, ["rev-parse", `${session.deliveryCommit}^`], GIT_TIMEOUT_MS, {
				signal,
			})
		).stdout.trim();
		const retained =
			session.retainedRef &&
			(
				await runIsolatedGit(session.repoRoot, dataDir, ["rev-parse", session.retainedRef], GIT_TIMEOUT_MS, { signal })
			).stdout.trim();
		if (
			tree !== session.artifactRef.outputTree ||
			parent !== session.artifactRef.baselineCommit ||
			retained !== session.deliveryCommit
		)
			throw new Error("Materialized artifact commit or retained ref changed");
	}
	const flags = (
		await runIsolatedGit(session.worktreePath, dataDir, ["ls-files", "-v", "-z"], GIT_TIMEOUT_MS, { signal })
	).stdout;
	if (flags.split("\0").some((entry) => /^[a-zS] /.test(entry)))
		throw new Error("Integration index has hidden assume-unchanged or skip-worktree flags");
	const rawTree = await snapshotTree(
		session.worktreePath,
		dataDir,
		signal,
		"integration-indexes",
		session.preparedTreeSha,
	);
	if (rawTree !== session.preparedTreeSha)
		throw new Error("Integration prepared tree is dirty or changed (raw working tree byte mismatch)");
	const unstaged = await runIsolatedGit(session.worktreePath, dataDir, ["diff", "--name-only"], GIT_TIMEOUT_MS, {
		signal,
	});
	const untracked = await runIsolatedGit(
		session.worktreePath,
		dataDir,
		["ls-files", "--others", "--exclude-standard"],
		GIT_TIMEOUT_MS,
		{ signal },
	);
	const tree = (
		await runIsolatedGit(session.worktreePath, dataDir, ["write-tree"], GIT_TIMEOUT_MS, { signal })
	).stdout.trim();
	if (unstaged.stdout.trim() || untracked.stdout.trim() || !session.preparedTreeSha || tree !== session.preparedTreeSha)
		throw new Error("Integration prepared tree is dirty or changed");
	await verifyWorktreeIdentity(session.worktreePath, session.repoRoot, signal, session.gitDir, session.commonDir);
	return tree;
}

async function assertTarget(session: DeviceIntegrationSession, dataDir: string, signal?: AbortSignal) {
	const repo = await verifyRepoRoot(session.repoRoot, signal);
	if (repo.commonDir !== session.commonDir || repo.repoRoot !== session.repoRoot)
		throw new Error("Integration target repository identity changed");
	const target = await inspectLocalTarget(session.repoRoot, dataDir, session.branch, { signal });
	if (target.isDirty || target.headSha !== session.expectedTargetSha)
		throw new Error("Integration target dirty or moved");
}

async function verifyIntegration(
	params: IntegrationIdentity & {
		verificationPlan: DeviceIntegrationVerificationPlan;
		artifactRef?: DeviceDeliveryArtifactRef;
		materializedCommit: string;
		preparedTree: string;
		expectedTargetSha: string;
	},
	options?: { signal?: AbortSignal; commandTimeoutMs?: number; totalTimeoutMs?: number },
): Promise<DeviceIntegrationVerificationFacts & { status: "verified" | "failed" }> {
	const plan = validateLocalVerificationPlan(params.verificationPlan);
	const session = await getVerifiedSession(params.dataDir, params);
	if (session.localVerification) throw new Error("Successful verification is immutable; create another integration");
	if (
		params.materializedCommit !== session.deliveryCommit ||
		params.preparedTree !== session.preparedTreeSha ||
		params.expectedTargetSha !== session.expectedTargetSha ||
		canonicalizeJson(params.artifactRef ?? null) !== canonicalizeJson(session.artifactRef ?? null)
	)
		throw new Error("Verification subject mismatch");
	await assertTarget(session, params.dataDir, options?.signal);
	const treeBefore = await assertPreparedTree(session, params.dataDir, options?.signal);
	const env = await buildIsolatedEnv(params.dataDir);
	const deadline = Date.now() + (options?.totalTimeoutMs ?? VERIFICATION_TOTAL_TIMEOUT_MS);
	const results: DeviceIntegrationVerificationFacts["results"] = [];
	session.verificationInFlight = true;
	session.verificationStopConfirmed = false;
	await persistSession(params.dataDir, params.integrationId, session);
	let stopConfirmed = true;
	try {
		for (const command of plan.commands) {
			options?.signal?.throwIfAborted();
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error("Verification aggregate deadline exceeded");
			results.push(
				await runVerificationCommand(command, {
					cwd: session.worktreePath,
					env,
					signal: options?.signal,
					timeoutMs: Math.min(options?.commandTimeoutMs ?? VERIFICATION_COMMAND_TIMEOUT_MS, remaining),
				}),
			);
		}
		const treeAfter = await assertPreparedTree(session, params.dataDir, options?.signal);
		await assertTarget(session, params.dataDir, options?.signal);
		const facts: DeviceIntegrationVerificationFacts = {
			planDigest: plan.digest,
			artifactDigest: session.artifactRef?.artifactDigest,
			materializedCommit: session.deliveryCommit,
			treeBefore,
			treeAfter,
			results,
		};
		const status = results.every((result) => result.status === "passed" && result.exitCode === 0)
			? "verified"
			: "failed";
		if (status === "verified") {
			session.localVerification = structuredClone(facts);
			session.verifiedPlan = plan;
		}
		return { status, ...facts };
	} catch (error) {
		if (error instanceof VerificationStopUnconfirmedError) {
			stopConfirmed = false;
			session.stopUnconfirmed = true;
		}
		throw error;
	} finally {
		if (stopConfirmed) {
			delete session.verificationInFlight;
			session.verificationStopConfirmed = true;
		}
		await persistSession(params.dataDir, params.integrationId, session).catch((error) => {
			if (stopConfirmed) throw error;
		});
	}
}

/**
 * 设备本地：用户确认写入目标分支
 * 1. 严格排他锁：不能在当前有在途验证命令执行时并发 apply
 * 2. 多租户会话与 Bot 身份、Revision 强校验
 * 3. 检查未被验证命令污染或篡改（diff / untracked / write-tree 三重验证）
 * 4. 验证生成的 merge commit 父链（HEAD^1 === expectedTargetSha 且 HEAD^2 === deliveryCommit）
 * 5. 前置紧邻二次检查目标仓库 dirty 状态与目标分支 HEAD SHA
 * 6. 执行原子 CAS update-ref 写入目标分支
 * 7. 若目标分支为 checked-out 分支，使用安全无覆盖 read-tree -u -m 同步当前工作区（绝不 hard reset！）
 */
async function confirmIntegration(
	params: {
		integrationId: string;
		targetBotId: string;
		targetBotRevision: number;
		repoRoot: string;
		dataDir: string;
		deliveryId: string;
		commit?: string;
		materializedCommit?: string;
		expectedTargetSha: string;
	},
	options?: { signal?: AbortSignal },
): Promise<{
	status: "applied";
	newCommitSha: string;
}> {
	const session = await getVerifiedSession(params.dataDir, params);
	if (session.stopUnconfirmed) throw new VerificationStopUnconfirmedError();
	const receipt = session.localVerification;
	const plan = validateLocalVerificationPlan(session.verifiedPlan);
	if (
		!receipt ||
		receipt.planDigest !== plan.digest ||
		receipt.materializedCommit !== session.deliveryCommit ||
		receipt.artifactDigest !== session.artifactRef?.artifactDigest ||
		receipt.treeBefore !== session.preparedTreeSha ||
		receipt.treeAfter !== session.preparedTreeSha ||
		receipt.results.length !== plan.commands.length ||
		!receipt.results.every(
			(result, index) =>
				result.command === plan.commands[index] &&
				result.status === "passed" &&
				result.exitCode === 0 &&
				/^[a-f0-9]{64}$/.test(result.outputDigest) &&
				typeof result.outputPreview === "string",
		)
	)
		throw new Error("Successful local verification receipt required");
	const deliveryCommit = params.materializedCommit ?? params.commit;
	if (deliveryCommit !== session.deliveryCommit) throw new Error("Confirmation materialized commit mismatch");
	await assertPreparedTree(session, params.dataDir, options?.signal);

	// 1. 幂等性防护：若本地已记录 CAS applied 成功（如重试或重启确认），直接幂等返回已生效的新提交 SHA
	if (session.applied && session.newCommitSha) {
		return {
			status: "applied",
			newCommitSha: session.newCommitSha,
		};
	}

	// 2. 前置安全校验：在任何 commit 操作前完成所有检查，确保 409 拒绝后重试保持干净幂等
	// 2.1 检查目标分支在任何工作树中未被检出（前置拦截，防止 commit 后才报错导致切离重试无改动）
	const wtList = await runIsolatedGit(
		session.repoRoot,
		params.dataDir,
		["worktree", "list", "--porcelain"],
		GIT_TIMEOUT_MS,
		options,
	);
	const targetBranchRef = `refs/heads/${session.branch}`;
	for (const line of wtList.stdout.split("\n")) {
		if (line.trim() === `branch ${targetBranchRef}`) {
			throw integrationError("INTEGRATION_TARGET_CHECKED_OUT");
		}
	}

	// 2.2 紧邻当下二次检查目标仓库 dirty 状态与目标分支 HEAD SHA
	const { headSha: currentHeadSha, isDirty } = await inspectLocalTarget(
		session.repoRoot,
		params.dataDir,
		session.branch,
		options,
	);
	if (isDirty) {
		throw new Error("Target repository has uncommitted changes (dirty state); cannot apply integration");
	}
	if (currentHeadSha !== params.expectedTargetSha || currentHeadSha !== session.expectedTargetSha) {
		throw integrationError("INTEGRATION_TARGET_MOVED");
	}

	// 2.3 验证命令完整性校验：验证命令绝不能篡改代码或修改工作树内容
	const unstaged = await runIsolatedGit(
		session.worktreePath,
		params.dataDir,
		["diff", "--name-only"],
		GIT_TIMEOUT_MS,
		options,
	);
	if (unstaged.stdout.trim().length > 0) {
		throw new Error("Worktree content modified by validation commands; integration rejected for security");
	}
	const untracked = await runIsolatedGit(
		session.worktreePath,
		params.dataDir,
		["ls-files", "--others", "--exclude-standard"],
		GIT_TIMEOUT_MS,
		options,
	);
	if (untracked.stdout.trim().length > 0) {
		throw new Error("Untracked files created by validation commands; integration rejected for security");
	}
	const treeRes = await runIsolatedGit(session.worktreePath, params.dataDir, ["write-tree"], GIT_TIMEOUT_MS, options);
	const currentTreeSha = treeRes.stdout.trim();
	if (session.preparedTreeSha && currentTreeSha !== session.preparedTreeSha) {
		throw new Error(
			"Worktree content tree SHA mismatch; validation commands altered repository contents, integration rejected for security",
		);
	}

	// 3. 幂等生成或复用 merge commit
	let newCommitSha = session.newCommitSha;
	if (!newCommitSha) {
		await runIsolatedGit(
			session.worktreePath,
			params.dataDir,
			[
				"-c",
				"user.name=Device Hub Integration",
				"-c",
				"user.email=integration@local",
				"commit",
				"-m",
				`Merge delivery ${params.deliveryId.slice(0, 8)} (${deliveryCommit.slice(0, 8)}) into ${session.branch}`,
			],
			GIT_TIMEOUT_MS,
			options,
		);

		const rev = await runIsolatedGit(
			session.worktreePath,
			params.dataDir,
			["rev-parse", "HEAD"],
			GIT_TIMEOUT_MS,
			options,
		);
		newCommitSha = rev.stdout.trim();
		if (!/^[a-f0-9]{40,64}$/i.test(newCommitSha)) {
			throw new Error("Failed to resolve integrated commit SHA");
		}

		// 严格核验父提交链拓扑：HEAD^1 必须等于 expectedTargetSha，HEAD^2 必须等于 deliveryCommit
		const p1 = (
			await runIsolatedGit(session.worktreePath, params.dataDir, ["rev-parse", "HEAD^1"], GIT_TIMEOUT_MS, options)
		).stdout.trim();
		const p2 = (
			await runIsolatedGit(session.worktreePath, params.dataDir, ["rev-parse", "HEAD^2"], GIT_TIMEOUT_MS, options)
		).stdout.trim();
		if (p1 !== session.expectedTargetSha || p2 !== deliveryCommit) {
			throw new Error("Integrated commit parent chain mismatch; foreign commits or altered ancestry detected");
		}

		session.newCommitSha = newCommitSha;
		await persistSession(params.dataDir, params.integrationId, session);
	}

	await assertPreparedTree(session, params.dataDir, options?.signal);
	await assertTarget(session, params.dataDir, options?.signal);
	// 4. 执行原子 CAS update-ref 写入目标分支
	await runIsolatedGit(
		session.repoRoot,
		params.dataDir,
		["update-ref", `refs/heads/${session.branch}`, newCommitSha, params.expectedTargetSha],
		GIT_TIMEOUT_MS,
		options,
	);

	// 5. CAS 成功：立即落盘 applied receipt，保证掉电或崩溃不可重做
	session.applied = true;
	await persistSession(params.dataDir, params.integrationId, session);

	// 6. 工作树安全清理
	let cleanupPending = false;
	try {
		await safeRemoveWorktree(session.repoRoot, params.dataDir, session.worktreePath);
		memorySessions.delete(sessionKey(params));
		if (session.retainedRef)
			await git(session.repoRoot, ["update-ref", "-d", session.retainedRef, session.deliveryCommit]);
		await persistSession(params.dataDir, params.integrationId);
	} catch (cleanupErr) {
		cleanupPending = true;
		console.warn(`[IntegrationCleanup] Worktree cleanup deferred: ${sanitizeError(cleanupErr)}`);
	}

	return {
		status: "applied",
		newCommitSha,
		...(cleanupPending ? { cleanupPending: true } : {}),
	};
}

/** 设备本地：取消集成并清理隔离工作树（中断在途命令并核验租约归属） */
async function cancelIntegration(
	params: IntegrationIdentity & { priorStatus?: string; verificationMayBeRunning?: boolean },
	options?: { signal?: AbortSignal; stopConfirmed?: boolean },
): Promise<{ status: "cancelled" }> {
	const stored = (await loadPersistentSessions(params.dataDir)).get(params.integrationId);
	if (
		stored &&
		(stored.targetBotId !== params.targetBotId ||
			stored.targetBotRevision !== params.targetBotRevision ||
			resolve(stored.repoRoot) !== resolve(params.repoRoot))
	)
		throw new Error("Integration cancellation identity mismatch");
	if (
		(stored ||
			params.verificationMayBeRunning ||
			["verifying", "verified", "failed"].includes(params.priorStatus ?? "")) &&
		(params.verificationMayBeRunning || params.priorStatus !== "prepared") &&
		!options?.stopConfirmed &&
		stored?.verificationStopConfirmed !== true &&
		!stored?.localVerification
	) {
		if (stored) {
			stored.stopUnconfirmed = true;
			await persistSession(params.dataDir, params.integrationId, stored).catch(() => {});
		}
		throw new VerificationStopUnconfirmedError();
	}
	const session = await getVerifiedSession(
		params.dataDir,
		params,
		params.priorStatus === "prepared" || stored?.verificationStopConfirmed === true || !!stored?.localVerification,
	).catch((error) => {
		if (String(error).includes("not found")) return undefined;
		throw error;
	});
	if (!session) {
		const path = resolve(await getVerifiedWorktreesRoot(params.dataDir), `int-${safeId(params.integrationId)}`);
		if (existsSync(path)) throw new VerificationStopUnconfirmedError();
		if (stored) {
			if (stored.retainedRef) {
				const repo = await verifyRepoRoot(stored.repoRoot);
				if (repo.commonDir !== stored.commonDir) throw new Error("Original integration repository identity changed");
				await git(stored.repoRoot, ["update-ref", "-d", stored.retainedRef, stored.deliveryCommit]);
			}
			await persistSession(params.dataDir, params.integrationId);
			memorySessions.delete(sessionKey(params));
		}
		return { status: "cancelled" };
	}
	await assertPreparedTree(session, params.dataDir);
	await safeRemoveWorktree(session.repoRoot, params.dataDir, session.worktreePath);
	if (session.retainedRef)
		await git(session.repoRoot, ["update-ref", "-d", session.retainedRef, session.deliveryCommit]);
	memorySessions.delete(sessionKey(params));
	await persistSession(params.dataDir, params.integrationId);
	return { status: "cancelled" };
}

export function devicePrepareIntegration(
	params: Parameters<typeof prepareIntegration>[0],
	options?: { signal?: AbortSignal },
) {
	params = structuredClone(params);
	return localOperation(params, options?.signal, (signal) => prepareIntegration(params, { signal }));
}
export function deviceVerifyIntegration(
	params: Parameters<typeof verifyIntegration>[0],
	options?: Parameters<typeof verifyIntegration>[1],
) {
	params = structuredClone(params);
	return localOperation(params, options?.signal, (signal) => verifyIntegration(params, { ...options, signal }));
}
export function deviceConfirmIntegration(
	params: Parameters<typeof confirmIntegration>[0],
	options?: { signal?: AbortSignal },
) {
	params = structuredClone(params);
	return localOperation(params, options?.signal, (signal) => confirmIntegration(params, { signal }));
}
export async function deviceCancelIntegration(
	params: Parameters<typeof cancelIntegration>[0],
	options?: { signal?: AbortSignal },
) {
	params = structuredClone(params);
	const operation = activeOperations.get(sessionKey(params));
	if (operation) {
		if (!sameIdentity(operation.identity, params)) throw new Error("Integration cancellation identity mismatch");
		operation.controller.abort(new Error("Integration cancelled"));
		await operation.done.catch((error) => {
			if (operation.blocked) throw error;
		});
		if (operation.blocked) throw operation.blocked;
	}
	return localOperation(params, options?.signal, () =>
		cancelIntegration(params, { ...options, stopConfirmed: !!operation }),
	);
}
