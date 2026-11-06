import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { writeJsonAtomicSync } from "../atomic-file.js";
import type { DeviceArtifact, DeviceDeliveryArtifactRef, DeviceIntegrationVerificationPlan } from "../protocol.js";
import { VerificationStopUnconfirmedError } from "./local-verification.js";
import { canonicalPath, computeCanonicalRepositoryId, git, verifyRepoRoot } from "../workspace-handle.js";
import type { LocalBotRegistry } from "./bots.js";
import { createDeviceCollabService } from "./collab-service.js";
import type { DeviceCollabExecutionContext } from "./collab-tool.js";
import {
	deviceCancelIntegration,
	deviceConfirmIntegration,
	devicePublicationStatus,
	deviceCancelPublication,
	devicePrepareIntegration,
	deviceVerifyIntegration,
	loadPersistentSessions,
} from "./device-integration.js";
import { executionRoot, executionRootsOverlap } from "./execution-workspace.js";
import { createDeviceTaskExecutor, type DeviceExecutorTask, type DeviceTaskExecutorOptions } from "./executor.js";
import { loadExecutionSettings, saveExecutionSettings, type DeviceExecutionSettings } from "./execution-settings.js";
import { createDeviceFileSync } from "./file-sync.js";
import { reportUploadMetadata } from "./report-metadata.js";
import { DeviceTaskError } from "./task-error.js";
import { TaskRecoveryManager } from "./task-recovery.js";
import { createTaskReportOutbox } from "./task-report-outbox.js";
import { DeviceTaskScheduler, type TaskSchedulerSnapshot } from "./task-scheduler.js";
import {
	cleanupTaskWorkspace,
	captureTaskArtifact,
	prepareTaskWorkspace,
	resolveTrustedTaskWorkspace,
	getTaskWorkspaceCapability,
	type TaskWorkspaceCapability,
	type TaskWorkspaceBinding,
	type TaskWorkspaceHandle,
} from "./task-workspace.js";
import { canonicalizeJson, validateContextManifest, validateWorkContract } from "./work-contract.js";
import { assertPublishIntentScope, validatePublishIntent } from "./publish-intent.js";
import { readPublicationJournal, loadPublicationJournals } from "./publication-journal.js";
import { PublicationStopUnconfirmedError } from "./local-publication.js";

type Config = { hubUrl: string; deviceId: string; credential: string; allowExecution: boolean; accountId?: string };
type Files = ReturnType<typeof createDeviceFileSync>;
type Executor = {
	run(task: DeviceExecutorTask): Promise<string>;
	close(): void | Promise<void>;
	steer?(text: string): boolean;
};
type Owner = DeviceCollabExecutionContext & { root: string };
type TaskOwner = {
	controller: AbortController;
	executor?: Executor;
	done?: Promise<unknown>;
	botId: string;
	root: string;
	taskId: string;
	attemptId: string;
	answer?: (value: unknown) => boolean;
	blocked?: unknown;
};
type Transcript = { binding: string; path: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function samePath(a?: string, b?: string): boolean {
	if (!a || !b) return false;
	const fold = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
	return fold(a) === fold(b);
}

export class DeviceTaskStopUnconfirmedError extends Error {
	readonly stopUnconfirmed = true;
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : "Task executor stop unconfirmed", { cause });
		this.name = "DeviceTaskStopUnconfirmedError";
	}
}

export function createDeviceRuntime(options: {
	config: Config;
	localOrigin: string;
	localAuthToken?: string;
	dataDir?: string;
	bots: LocalBotRegistry;
	executorFactory?: (options: DeviceTaskExecutorOptions) => Executor;
}) {
	const { config, bots } = options;
	const sessions = new Map<string, Owner>();
	const files = new Map<string, { roomId: string; botId: string; revision: string; files: Files }>();
	const receipts = new Map<string, { roomId: string; botId: string; revision: string; files: Files }>();
	const operations = new Set<Promise<unknown>>();
	let closed = false;
	let generation = new AbortController();
	const active = new Set<TaskOwner>();
	const transferOperations = new Set<Promise<unknown>>();
	const recovery = new TaskRecoveryManager({
		dataDir: options.dataDir,
		deviceId: config.deviceId,
		hubUrl: config.hubUrl,
	});
	const reportOutbox = createTaskReportOutbox(options.dataDir, config.deviceId, config.hubUrl);
	const schedulerFile = options.dataDir ? join(options.dataDir, "task-scheduler-state.json") : undefined;
	let schedulerSaveTimer: ReturnType<typeof setTimeout> | undefined;
	let schedulerStatePending = false;
	function loadSchedulerState(): unknown {
		if (!schedulerFile) return undefined;
		try {
			return JSON.parse(readFileSync(schedulerFile, "utf8"));
		} catch {
			return undefined;
		}
	}
	function flushSchedulerState() {
		if (!schedulerFile || !schedulerStatePending) return;
		schedulerStatePending = false;
		try {
			writeJsonAtomicSync(schedulerFile, scheduler.snapshotState());
		} catch {}
	}
	function scheduleSchedulerStateSave() {
		if (!schedulerFile) return;
		schedulerStatePending = true;
		if (schedulerSaveTimer) return;
		schedulerSaveTimer = setTimeout(() => {
			schedulerSaveTimer = undefined;
			flushSchedulerState();
		}, 250);
		schedulerSaveTimer.unref?.();
	}
	const scheduler = new DeviceTaskScheduler({
		initialSettings: loadExecutionSettings(options.dataDir),
		persistedState: loadSchedulerState(),
		onChange: scheduleSchedulerStateSave,
	});
	const conflicts = (a: { botId: string; root: string }, b: { botId: string; root: string }) =>
		a.botId === b.botId || executionRootsOverlap(a.root, b.root);
	function drain() {
		scheduler.drain();
	}
	const transcriptFile = options.dataDir ? join(options.dataDir, "bot-execution-conversations.json") : undefined;
	let transcripts: Record<string, Transcript> = Object.create(null);
	let transcriptLoadError: unknown;
	if (transcriptFile) {
		try {
			const stored: unknown = JSON.parse(readFileSync(transcriptFile, "utf8"));
			if (!stored || typeof stored !== "object" || Array.isArray(stored))
				throw new Error("Invalid transcript registry");
			for (const [id, entry] of Object.entries(stored)) {
				const value = entry as Transcript;
				if (
					!UUID.test(id) ||
					!value ||
					typeof value.binding !== "string" ||
					typeof value.path !== "string" ||
					!isAbsolute(value.path)
				)
					throw new Error("Invalid transcript registry");
			}
			transcripts = Object.assign(Object.create(null), stored);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") transcriptLoadError = error;
		}
	}
	function enabled(signal?: AbortSignal) {
		signal?.throwIfAborted();
		if (closed) throw new Error("Device runtime closed");

		if (!config.allowExecution)
			throw new DeviceTaskError("目标设备未开启群任务执行权限。 / Local task execution is disabled.");
	}
	function track<T>(operation: Promise<T>): Promise<T> {
		operations.add(operation);
		void operation.catch(() => {}).finally(() => operations.delete(operation));
		return operation;
	}
	async function sweep() {
		for (const [key, entry] of files) {
			const bot = bots.get(entry.botId);
			if (bot?.enabled && `${bot.id}:${bot.revision}` === entry.revision) continue;
			files.delete(key);
			for (const [id, receipt] of receipts) if (receipt.files === entry.files) receipts.delete(id);
			await entry.files.close();
		}
	}
	async function assertPublicationWorkspaceIdle(botId: string, root: string) {
		if (!options.dataDir) return;
		try {
			const journals = await loadPublicationJournals(options.dataDir);
			if (
				journals.some(
					(journal) =>
						journal.casStarted &&
						!journal.processStopped &&
						!journal.stop?.stopConfirmed &&
						(journal.intent.targetBotId === botId ||
							(!!journal.repository &&
								executionRootsOverlap(executionRoot(journal.repository.repoRoot), executionRoot(root)))),
				)
			)
				throw new Error("Publication process stop unconfirmed; original workspace blocked");
		} catch (error) {
			throw new DeviceTaskStopUnconfirmedError(error);
		}
	}
	async function acquire(botId: string, signal?: AbortSignal, cancellationId?: string) {
		enabled(signal);
		await sweep();
		const lease = await bots.acquire(botId);
		try {
			enabled(signal);
			await assertPublicationWorkspaceIdle(botId, lease.root);
			if (options.dataDir) {
				const pending = await loadPersistentSessions(options.dataDir);
				for (const session of pending.values()) {
					const legacyStopUnknown = session.verificationStopConfirmed !== true && !session.localVerification;
					if (!session.verificationInFlight && !session.stopUnconfirmed && !legacyStopUnknown) continue;
					if (
						session.targetBotId !== botId &&
						!executionRootsOverlap(executionRoot(session.repoRoot), executionRoot(lease.root))
					)
						continue;
					const canCancel =
						cancellationId === session.integrationId &&
						((!session.verificationInFlight && !session.stopUnconfirmed && legacyStopUnknown) ||
							[...active].some(
								(owner) => !owner.blocked && owner.taskId === `integration:${cancellationId}` && owner.botId === botId,
							));
					if (!canCancel)
						throw new DeviceTaskStopUnconfirmedError(
							new Error("Integration process stop unconfirmed; workspace blocked"),
						);
				}
			}
			if ([...active].some((owner) => owner.blocked && conflicts(owner, { botId, root: executionRoot(lease.root) })))
				throw new DeviceTaskError("Task stop unconfirmed; workspace blocked until service restart");
			return lease;
		} catch (error) {
			lease.release();
			throw error;
		}
	}
	function roomFiles(roomId: string, botId: string, lease: { root: string; revision: string }) {
		const key = JSON.stringify([roomId, botId, lease.revision]);
		let entry = files.get(key);
		if (!entry) {
			if (!options.dataDir) throw new Error("File synchronization storage unavailable");
			const canonicalRoot = resolve(lease.root);
			const scopeToken = createHash("sha256")
				.update(JSON.stringify([config.hubUrl, config.deviceId, roomId, botId, lease.revision, canonicalRoot]))
				.digest("hex")
				.slice(0, 32);
			const scopedDataDir = join(options.dataDir, "scoped-transfers", scopeToken);
			const currentSettings = scheduler.getSettings();
			entry = {
				roomId,
				botId,
				revision: lease.revision,
				files: createDeviceFileSync({
					root: lease.root,
					dataDir: scopedDataDir,
					allowReceive: config.allowExecution,
					limits: {
						bytes: currentSettings.fileSyncMaxBytes,
						files: currentSettings.fileSyncMaxFiles,
						stagedBytes: currentSettings.fileSyncStagedBytes,
					},
				}),
			};
			files.set(key, entry);
		}
		return entry;
	}
	const service = createDeviceCollabService({
		getConfig: () => (closed ? undefined : config),
		getExecutionContext: (context) => {
			const owner = context?.sessionId ? sessions.get(context.sessionId) : undefined;
			return owner && samePath(context?.cwd, owner.root) ? owner : undefined;
		},
		getParentTask: (context) => (context?.sessionId ? sessions.get(context.sessionId)?.taskId : undefined),
		getSourceBot: (context) => (context?.sessionId ? sessions.get(context.sessionId)?.botId : undefined),
		async workspaceResolver({ roomId, sourceBotId, context, signal }) {
			const boundSignal = AbortSignal.any([generation.signal, ...(signal ? [signal] : [])]);
			const lease = await acquire(sourceBotId, boundSignal);
			try {
				const owner = context.sessionId ? sessions.get(context.sessionId) : undefined;
				if (
					!owner ||
					resolve(context.cwd) !== resolve(lease.root) ||
					(roomId && owner.roomId !== roomId) ||
					owner.root !== lease.root ||
					owner.botId !== sourceBotId
				)
					throw new Error("Task workspace ownership mismatch");
				return { ...lease, botId: sourceBotId, files: roomFiles(roomId, sourceBotId, lease).files };
			} catch (error) {
				lease.release();
				throw error;
			}
		},
	});
	const collabService: typeof service = {
		execute(action, args, signal, context) {
			if (action === "send_task") {
				const owner = context?.sessionId ? sessions.get(context.sessionId) : undefined;
				if (!owner || (args.roomId !== undefined && owner.roomId !== args.roomId))
					return Promise.reject(new Error("Task session is not bound to this room"));
			}
			const commandSignal = AbortSignal.any([generation.signal, ...(signal ? [signal] : [])]);
			return track(service.execute(action, args, commandSignal, context));
		},
	};
	function onTask(
		task: DeviceExecutorTask & { roomId: string },
		signal?: AbortSignal,
		callbacks?: import("./executor.js").DeviceTaskCallbacks,
	): Promise<string> {
		try {
			enabled(signal);
			if (
				task.deviceId !== config.deviceId ||
				![task.id, task.attemptId, task.botId, task.roomId].every(
					(value) => typeof value === "string" && value.length > 0 && value.length <= 128,
				) ||
				!Number.isSafeInteger(task.botRevision) ||
				task.botRevision < 1
			)
				throw new DeviceTaskError("Invalid task route or execution identity");
		} catch (error) {
			return Promise.reject(error);
		}
		const taskSignal = signal ?? new AbortController().signal;
		const root = executionRoot(bots.get(task.botId)?.cwd ?? options.dataDir ?? process.cwd());
		return track(
			new Promise<string>((resolve, reject) => {
				let queued: ReturnType<typeof scheduler.enqueue> = null;
				const onAbort = () => {
					if (queued) scheduler.removeWaiting(queued);
					taskSignal.removeEventListener("abort", onAbort);
					reject(taskSignal.reason ?? new DeviceTaskError("Task cancelled"));
					scheduler.drain();
				};
				try {
					queued = scheduler.enqueue(
						{
							id: task.id,
							attemptId: task.attemptId,
							roomId: task.roomId,
							botId: task.botId,
							botRevision: String(task.botRevision),
							root,
						},
						{
							start() {
								taskSignal.removeEventListener("abort", onAbort);
								void runTask(task, root, taskSignal, callbacks).then(resolve, reject).finally(drain);
							},
							reject(error) {
								taskSignal.removeEventListener("abort", onAbort);
								reject(error);
							},
							cancel() {
								taskSignal.removeEventListener("abort", onAbort);
								reject(taskSignal.reason ?? new DeviceTaskError("Task cancelled"));
								scheduler.drain();
							},
						},
						taskSignal,
					);
				} catch (err) {
					reject(err);
					return;
				}
				taskSignal.addEventListener("abort", onAbort, { once: true });
				if (taskSignal.aborted) onAbort();
			}),
		);
	}
	function runTask(
		task: DeviceExecutorTask & { roomId: string; leaseToken?: string; leaseGeneration?: number },
		root: string,
		signal?: AbortSignal,
		callbacks?: import("./executor.js").DeviceTaskCallbacks,
	): Promise<string> {
		try {
			enabled(signal);
		} catch (error) {
			return Promise.reject(error);
		}

		task = structuredClone(task);
		if (typeof task.leaseToken !== "string" || !task.leaseToken) {
			return Promise.reject(new DeviceTaskError("Hub task lease grant required"));
		}

		const capacityCheck = recovery.hasOutboxCapacity();
		if (!capacityCheck.available) {
			return Promise.reject(new DeviceTaskError(capacityCheck.reason ?? "Recovery outbox capacity reached"));
		}

		const isCode = task.executionMode === "code" || task.contract?.executionMode === "code";
		let contract = task.contract;
		let contextManifest = task.contextManifest;
		if (contract) {
			const cCheck = validateWorkContract(contract);
			if (!cCheck.valid) {
				return Promise.reject(new DeviceTaskError(`Invalid work contract: ${cCheck.reason}`));
			}
			contract = cCheck.contract;
		}
		if (contextManifest) {
			const mCheck = validateContextManifest(contextManifest, contract);
			if (!mCheck.valid) {
				return Promise.reject(new DeviceTaskError(`Invalid context manifest: ${mCheck.reason}`));
			}
			contextManifest = mCheck.manifest;
		}

		if (contextManifest?.executionPolicy) {
			const policy = contextManifest.executionPolicy;
			if (
				policy.deviceId !== config.deviceId ||
				policy.botId !== task.botId ||
				policy.botRevision !== task.botRevision
			) {
				return Promise.reject(
					new DeviceTaskError(
						`Context manifest execution policy mismatch: expected device=${config.deviceId}, bot=${task.botId}@${task.botRevision}; manifest specifies device=${policy.deviceId}, bot=${policy.botId}@${policy.botRevision}`,
					),
				);
			}
		}

		let effectiveContext = task.context;
		let effectiveTaskState = task.taskState;
		if (contextManifest) {
			if (contextManifest.context !== null && contextManifest.context !== undefined) {
				if (
					task.context !== undefined &&
					canonicalizeJson(task.context) !== canonicalizeJson(contextManifest.context)
				) {
					return Promise.reject(new DeviceTaskError("Task wire context does not match sealed contextManifest"));
				}
				effectiveContext = contextManifest.context as import("./group-context.js").GroupTaskContext;
			} else {
				if (task.context !== undefined && task.context !== null)
					return Promise.reject(new DeviceTaskError("Task wire context does not match sealed contextManifest"));
				effectiveContext = undefined;
			}
			if (contextManifest.taskState !== null && contextManifest.taskState !== undefined) {
				if (
					task.taskState !== undefined &&
					canonicalizeJson(task.taskState) !== canonicalizeJson(contextManifest.taskState)
				) {
					return Promise.reject(new DeviceTaskError("Task wire taskState does not match sealed contextManifest"));
				}
				effectiveTaskState = contextManifest.taskState as import("../protocol.js").DeviceTaskState;
			} else {
				if (task.taskState !== undefined && task.taskState !== null)
					return Promise.reject(new DeviceTaskError("Task wire taskState does not match sealed contextManifest"));
				effectiveTaskState = undefined;
			}
		}

		if (isCode) {
			if (task.resume) {
				return Promise.reject(new DeviceTaskError("Code execution mode refuses resuming old sessions in first slice"));
			}
			if (!contract || contract.executionMode !== "code") {
				return Promise.reject(new DeviceTaskError("Code task requires a valid code work contract"));
			}
			if (!contextManifest) {
				return Promise.reject(new DeviceTaskError("Code task requires sealed contextManifest"));
			}
		}

		const owner: TaskOwner = {
			controller: new AbortController(),
			botId: task.botId,
			root,
			taskId: task.id,
			attemptId: task.attemptId,
		};

		let leaseRecorded = false;
		let activeItem: ReturnType<typeof scheduler.registerActive> | undefined;
		try {
			active.add(owner);
			recovery.recordTaskStart({
				taskId: task.id,
				attemptId: task.attemptId,
				botId: task.botId,
				deviceId: config.deviceId,
				roomId: task.roomId,
				leaseToken: task.leaseToken,
				leaseGeneration: task.leaseGeneration ?? 1,
				conversationId: task.conversationId,
				contractDigest: contract?.digest,
				manifestDigest: contextManifest?.digest,
				executionMode: isCode ? "code" : "chat",
			});
			leaseRecorded = true;

			activeItem = scheduler.registerActive(
				{
					id: task.id,
					attemptId: task.attemptId,
					roomId: task.roomId,
					botId: task.botId,
					botRevision: String(task.botRevision),
					root,
				},
				owner.controller,
			);
		} catch (admissionError) {
			if (leaseRecorded) {
				recovery.removeActiveLease(task.id, task.attemptId);
			}
			active.delete(owner);
			return Promise.reject(admissionError);
		}

		callbacks?.onStarted?.();
		const taskSignal = AbortSignal.any([owner.controller.signal, ...(signal ? [signal] : [])]);
		const operation = (async () => {
			let publishingOutcome = false;
			const outcomeTask = {
				id: task.id,
				attemptId: task.attemptId,
				botId: task.botId,
				deviceId: config.deviceId,
				roomId: task.roomId,
				leaseToken: task.leaseToken,
				leaseGeneration: task.leaseGeneration ?? 1,
				contractDigest: contract?.digest,
				manifestDigest: contextManifest?.digest,
			};
			let lease: Awaited<ReturnType<typeof acquire>> | undefined;
			let workspaceHandle: TaskWorkspaceHandle | undefined;
			let workspaceCapability: TaskWorkspaceCapability | undefined;
			let workspaceBinding: TaskWorkspaceBinding | undefined;
			let executionCwd = root;
			let executionCompleted = false;
			let artifactProduced = false;
			let capturedArtifact: DeviceArtifact | undefined;
			let stopping: Promise<void> | undefined;
			const stop = () => {
				if (!stopping) stopping = Promise.resolve().then(() => owner.executor?.close());
				void stopping.catch(() => {});
			};
			const confirmStop = async () => {
				stop();
				try {
					await stopping;
				} catch (error) {
					const failure =
						error instanceof DeviceTaskStopUnconfirmedError ? error : new DeviceTaskStopUnconfirmedError(error);
					owner.blocked = failure;
					scheduler.markBlocked(task.id, task.attemptId, failure);
					throw failure;
				}
			};
			try {
				if (!task.roomId) throw new DeviceTaskError("Task room required");
				try {
					if (task.deviceId !== config.deviceId || !task.botId) throw new Error("Task Bot route mismatch");
					lease = await acquire(task.botId, taskSignal);
					if (task.botRevision !== lease.bot.revision || executionRoot(lease.root) !== root)
						throw new Error("Task Bot revision or workspace mismatch");
					const policy = contextManifest?.executionPolicy;
					if (
						policy &&
						(policy.deviceId !== config.deviceId ||
							policy.botId !== lease.bot.id ||
							policy.botRevision !== lease.bot.revision)
					)
						throw new Error("Context manifest execution policy mismatch with acquired lease");
				} catch (error) {
					if (taskSignal.aborted) throw error;
					throw new DeviceTaskError("目标 Bot 不可用、配置已变更或正在忙碌。 / Target Bot unavailable or busy.");
				}
				executionCwd = lease.root;
				if (isCode) {
					if (contract?.baseline) {
						const canonicalRepoId = await computeCanonicalRepositoryId(lease.root, taskSignal);
						const expectedRepoId = contract.baseline.repositoryId.trim();
						if (expectedRepoId !== canonicalRepoId && expectedRepoId !== "default" && expectedRepoId !== "local") {
							let matchesRoot = false;
							try {
								const roots = (await git(lease.root, ["rev-list", "--max-parents=0", "HEAD"], taskSignal))
									.trim()
									.split("\n")
									.map((c) => c.trim().toLowerCase());
								matchesRoot = roots.includes(expectedRepoId.toLowerCase());
							} catch {}
							if (!matchesRoot) {
								throw new DeviceTaskError(
									`Repository identity mismatch: baseline specifies '${expectedRepoId}', local repository is '${canonicalRepoId}'`,
								);
							}
						}
					}
					workspaceBinding = {
						deviceId: config.deviceId,
						botId: task.botId,
						botRevision: lease.bot.revision,
						taskId: task.id,
						attemptId: task.attemptId,
					};
					workspaceHandle = await prepareTaskWorkspace({
						dataDir: options.dataDir ?? process.cwd(),
						deviceId: config.deviceId,
						botId: task.botId,
						botRevision: lease.bot.revision,
						taskId: task.id,
						attemptId: task.attemptId,
						repoRoot: lease.root,
						contract: contract!,
						contextManifest: contextManifest!,
						signal: taskSignal,
					});
					workspaceCapability = getTaskWorkspaceCapability(workspaceHandle, workspaceBinding);
					const resolved = await resolveTrustedTaskWorkspace(workspaceCapability, workspaceBinding);
					executionCwd = resolved.cwd;
				}
				let binding: string | undefined;
				let resumePath: string | undefined;
				let transcriptPath: string | undefined;
				let boundSession: string | undefined;
				if (task.resume !== undefined && typeof task.resume !== "boolean")
					throw new DeviceTaskError("Invalid resume flag");
				if (task.resume && !task.conversationId) throw new DeviceTaskError("Resume conversation address required");
				if (!isCode && task.conversationId !== undefined) {
					if (!UUID.test(task.conversationId) || !transcriptFile || transcriptLoadError)
						throw new DeviceTaskError("Persistent conversation storage unavailable or invalid address");
					binding = createHash("sha256")
						.update(
							JSON.stringify([
								config.hubUrl,
								config.deviceId,
								task.roomId,
								lease.bot.id,
								lease.bot.revision,
								resolve(lease.root),
							]),
						)
						.digest("hex");
					const stored = transcripts[task.conversationId];
					if (task.resume) {
						if (!stored || stored.binding !== binding)
							throw new DeviceTaskError("Conversation unavailable or configuration changed");
						try {
							if (!statSync(stored.path).isFile()) throw new Error();
						} catch {
							throw new DeviceTaskError("Conversation transcript unavailable");
						}
						resumePath = stored.path;
					} else if (stored) throw new DeviceTaskError("Conversation already exists; explicit resume required");
				}
				owner.executor = (options.executorFactory ?? createDeviceTaskExecutor)({
					...callbacks,
					onActivity() {
						recovery.recordActivity(task.id, task.attemptId);
						callbacks?.onActivity?.();
					},
					onProgress(progress) {
						recovery.recordActivity(task.id, task.attemptId);
						callbacks?.onProgress?.(progress);
					},
					onInteractions(items) {
						recovery.recordActivity(task.id, task.attemptId);
						callbacks?.onInteractions?.(items);
					},
					onFullReport(taskId, attemptId, fullReport) {
						recovery.recordActivity(taskId, attemptId);
						if (taskId !== task.id || attemptId !== task.attemptId) throw new Error("Report task binding mismatch");
						reportOutbox.capture(task, fullReport);
						return callbacks?.onFullReport?.(taskId, attemptId, fullReport);
					},
					onPlanReady(taskId, plan) {
						taskSignal.throwIfAborted();
						if (taskId !== task.id) return Promise.resolve(false);
						recovery.recordActivity(taskId, task.attemptId);
						return callbacks?.onPlanReady?.(taskId, plan) ?? Promise.resolve(false);
					},
					onToolLifecycle(lifecycle) {
						recovery.recordActivity(task.id, task.attemptId);
						callbacks?.onToolLifecycle?.(lifecycle);
					},
					registerInteractionAnswer(answer) {
						owner.answer = answer;
					},
					localOrigin: options.localOrigin,
					localAuthToken: options.localAuthToken,
					cwd: lease.root,
					executionCwd,
					executionMode: isCode ? "code" : "chat",
					workspaceHandleId: workspaceHandle?.handleId,
					workspaceCapability,
					bot: lease.bot,
					allowExecution: config.allowExecution,
					resumePath,
					onSessionPath(taskId, path) {
						taskSignal.throwIfAborted();
						if (
							taskId !== task.id ||
							!boundSession ||
							sessions.get(boundSession)?.taskId !== task.id ||
							!isAbsolute(path) ||
							(resumePath && !samePath(path, resumePath))
						)
							throw new Error("Transcript ownership mismatch");
						if (!isCode && task.conversationId) {
							const currentBot = bots.get(task.botId);
							if (
								!binding ||
								!currentBot?.enabled ||
								currentBot.revision !== lease!.bot.revision ||
								resolve(currentBot.cwd) !== resolve(lease!.root)
							)
								throw new DeviceTaskError("Conversation transcript ownership changed");
							try {
								if (resumePath && !statSync(path).isFile()) throw new Error();
								const next = { ...transcripts, [task.conversationId]: { binding, path } };
								writeJsonAtomicSync(transcriptFile!, next);
								transcripts = next;
							} catch {
								throw new DeviceTaskError("Conversation transcript persistence failed");
							}
						}
						transcriptPath = path;
					},
					onSession(taskId, sessionId) {
						if (taskId !== task.id) throw new Error("Task session ownership mismatch");
						boundSession = sessionId;
						for (const [id, bound] of sessions)
							if (bound.taskId === taskId && bound.roomId === task.roomId) sessions.delete(id);
						if (sessionId && !taskSignal.aborted)
							sessions.set(sessionId, {
								taskId,
								...(effectiveTaskState ? { taskState: structuredClone(effectiveTaskState) } : {}),
								roomId: task.roomId,
								root: executionCwd,
								botId: task.botId,
								conversationId: task.conversationId,
								sourceConversationId: task.sourceConversationId,
								requestId: task.requestId,
								kind: task.kind,
							});
					},
				});
				taskSignal.addEventListener("abort", stop, { once: true });
				taskSignal.throwIfAborted();
				const result = await owner.executor.run({
					...task,
					context: effectiveContext,
					taskState: effectiveTaskState,
					executionMode: isCode ? "code" : "chat",
					contract,
					contextManifest,
					workspaceHandleId: workspaceHandle?.handleId,
					executionCwd,
				});
				await confirmStop();
				taskSignal.throwIfAborted();
				executionCompleted = true;

				if (isCode && workspaceHandle && workspaceBinding) {
					try {
						capturedArtifact = await captureTaskArtifact(workspaceHandle, workspaceBinding, taskSignal);
						artifactProduced = true;
					} catch (captureErr) {
						const msg =
							captureErr instanceof Error
								? `Task artifact capture failed: ${captureErr.message}`
								: "Task artifact capture failed";
						throw new DeviceTaskError(msg, msg);
					}
				}

				if (!isCode && task.conversationId) {
					const currentBot = bots.get(task.botId);
					if (
						!transcriptPath ||
						!binding ||
						!currentBot?.enabled ||
						currentBot.revision !== lease.bot.revision ||
						resolve(currentBot.cwd) !== resolve(lease.root)
					)
						throw new DeviceTaskError("Conversation transcript capture failed");
					try {
						if (!statSync(transcriptPath).isFile()) throw new Error();
					} catch {
						throw new DeviceTaskError("Conversation transcript unavailable after execution");
					}
				}
				publishingOutcome = true;
				recovery.recordTaskFinish(outcomeTask, {
					status: "completed",
					report: result,
					reportMetadata: reportUploadMetadata(reportOutbox.get(task) ?? reportOutbox.markMissing(task)),
					artifact: capturedArtifact,
					executionCompleted,
					artifactProduced,
				});
				return result;
			} catch (error) {
				if (publishingOutcome) throw error;
				let failure = error;
				try {
					await confirmStop();
				} catch (stopError) {
					failure = stopError;
				}
				if (owner.blocked || failure instanceof DeviceTaskStopUnconfirmedError) {
					throw failure;
				}
				const interrupted = taskSignal.aborted;
				recovery.recordTaskFinish(outcomeTask, {
					status: interrupted ? "interrupted" : "failed",
					error: failure,
					reportMetadata: reportUploadMetadata(reportOutbox.get(task) ?? reportOutbox.markMissing(task)),
					artifact: capturedArtifact,
					executionCompleted,
					artifactProduced,
				});
				throw failure;
			} finally {
				taskSignal.removeEventListener("abort", stop);
				let stoppedCleanly = false;
				try {
					await confirmStop();
					stoppedCleanly = true;
				} catch {}
				for (const [id, bound] of sessions)
					if (bound.taskId === task.id && bound.roomId === task.roomId) sessions.delete(id);
				if (stoppedCleanly && !owner.blocked && workspaceHandle && workspaceBinding) {
					try {
						await cleanupTaskWorkspace(workspaceHandle, workspaceBinding, { force: false });
					} catch {}
				}
				if (!owner.blocked && stoppedCleanly) {
					lease?.release();
					if (activeItem) scheduler.releaseActive(activeItem);
					active.delete(owner);
				}
			}
		})();
		owner.done = operation;
		return track(operation);
	}
	async function originalPublicationCommand(command: Record<string, unknown>, historical: boolean) {
		const intent = validatePublishIntent(command.publishIntent);
		assertPublishIntentScope(intent, {
			accountId: config.accountId ?? intent.accountId,
			targetDeviceId: config.deviceId,
		});
		if (
			command.accountId !== intent.accountId ||
			command.roomId !== intent.roomId ||
			command.conversationId !== intent.conversationId ||
			command.integrationId !== intent.integrationId ||
			command.targetBotId !== intent.targetBotId ||
			command.targetBotRevision !== intent.targetBotRevision
		)
			throw new Error("Publication command original scope mismatch");
		const original = await readPublicationJournal(options.dataDir ?? process.cwd(), intent);
		if (!config.accountId) {
			if (!historical || !original) throw new Error("Authenticated publication account context required");
		}
		return intent;
	}
	async function ownerCleanup(command: Record<string, unknown>, signal: AbortSignal) {
		if (!options.dataDir || typeof command.integrationId !== "string")
			throw new Error("Original integration session required for owner cleanup");
		const session = (await loadPersistentSessions(options.dataDir)).get(command.integrationId);
		if (
			!session ||
			session.targetBotId !== command.targetBotId ||
			session.targetBotRevision !== command.targetBotRevision
		)
			throw new Error("Original integration cleanup identity mismatch");
		await assertPublicationWorkspaceIdle(session.targetBotId, session.repoRoot);
		const identity = { botId: session.targetBotId, root: executionRoot(session.repoRoot) };
		const existing = [...active].find(
			(owner) => owner.taskId === `integration:${session.integrationId}` && owner.botId === session.targetBotId,
		);
		if ([...active].some((owner) => conflicts(owner, identity) && owner !== existing))
			throw new Error("Target Bot or workspace is busy");
		let owner: TaskOwner | undefined;
		let item: ReturnType<typeof scheduler.registerActive> | undefined;
		if (!existing) {
			owner = {
				...identity,
				controller: new AbortController(),
				taskId: `integration:${session.integrationId}`,
				attemptId: randomUUID(),
			};
			item = scheduler.registerActive(
				{
					id: owner.taskId,
					attemptId: owner.attemptId,
					roomId: "integration",
					botId: owner.botId,
					botRevision: String(session.targetBotRevision),
					root: owner.root,
				},
				owner.controller,
			);
			active.add(owner);
		}
		try {
			return await deviceCancelIntegration(
				{
					integrationId: session.integrationId,
					targetBotId: session.targetBotId,
					targetBotRevision: session.targetBotRevision,
					repoRoot: session.repoRoot,
					dataDir: options.dataDir,
					priorStatus: command.priorStatus as string | undefined,
					verificationMayBeRunning: command.verificationMayBeRunning === true,
				},
				{ signal },
			);
		} catch (error) {
			if (error instanceof VerificationStopUnconfirmedError && owner) {
				owner.blocked = error;
				scheduler.markBlocked(owner.taskId, owner.attemptId, error);
			}
			throw error;
		} finally {
			if (owner && !owner.blocked) {
				if (item) scheduler.releaseActive(item);
				active.delete(owner);
				drain();
			}
		}
	}
	function onCommand(action: string, payload: unknown, signal: AbortSignal) {
		const integrationController = new AbortController();
		const commandSignal = AbortSignal.any([signal, generation.signal, integrationController.signal]);
		if (action === "transfer_fence") {
			return track(
				(async () => {
					enabled(commandSignal);
					await Promise.allSettled(Array.from(operations));
					return { ok: true, settled: true, remaining: 0 };
				})(),
			);
		}
		const operation = (async () => {
			if (!payload || typeof payload !== "object" || Array.isArray(payload))
				throw new Error("Invalid transfer command");
			const command = payload as Record<string, unknown>;
			if (action === "integration_publication_status" || (action === "integration_cancel" && command.publishIntent)) {
				const intent = await originalPublicationCommand(command, true);
				const historical = { dataDir: options.dataDir ?? process.cwd(), publishIntent: intent };
				return action === "integration_publication_status"
					? devicePublicationStatus(historical)
					: deviceCancelPublication(historical);
			}
			enabled(commandSignal);
			if (action === "integration_confirm") await originalPublicationCommand(command, false);
			if (typeof command.roomId !== "string" && !action.startsWith("integration_")) throw new Error("Room required");
			if (typeof command.targetBotId !== "string" || !command.targetBotId) throw new Error("Target Bot required");
			if (action === "integration_cancel" && command.ownerCleanup === true) return ownerCleanup(command, commandSignal);
			const lease = await acquire(
				command.targetBotId,
				commandSignal,
				action === "integration_cancel" ? String(command.integrationId) : undefined,
			);
			let integrationOwner: TaskOwner | undefined;
			let integrationItem: ReturnType<typeof scheduler.registerActive> | undefined;
			try {
				if (
					!action.startsWith("integration_")
						? command.targetBotRevision !== lease.bot.revision
						: command.targetBotRevision !== undefined && command.targetBotRevision !== lease.bot.revision
				)
					throw new Error("Transfer Bot revision mismatch");
				if (action.startsWith("integration_")) {
					const repo = await verifyRepoRoot(lease.root, commandSignal);
					if (repo.repoRoot !== (await canonicalPath(lease.root)))
						throw new Error("Integration Bot workspace must be the canonical repository root");
				}
				if (
					action === "integration_cancel" &&
					[...active].some(
						(owner) =>
							conflicts(owner, { botId: lease.bot.id, root: executionRoot(lease.root) }) &&
							owner.taskId !== `integration:${String(command.integrationId)}`,
					)
				)
					throw new Error("Target Bot or workspace is busy");
				if (
					action.startsWith("integration_") &&
					!(
						action === "integration_cancel" &&
						[...active].some(
							(owner) =>
								owner.taskId === `integration:${String(command.integrationId)}` && owner.botId === lease.bot.id,
						)
					)
				) {
					integrationOwner = {
						controller: integrationController,
						botId: lease.bot.id,
						root: executionRoot(lease.root),
						taskId: `integration:${String(command.integrationId)}`,
						attemptId: randomUUID(),
					};
					integrationItem = scheduler.registerActive(
						{
							id: integrationOwner.taskId,
							attemptId: integrationOwner.attemptId,
							roomId: typeof command.roomId === "string" ? command.roomId : "integration",
							botId: lease.bot.id,
							botRevision: String(lease.bot.revision),
							root: integrationOwner.root,
						},
						integrationController,
					);
					active.add(integrationOwner);
				}
				if (action === "integration_prepare") {
					return await devicePrepareIntegration(
						{
							integrationId: command.integrationId as string,
							targetBotId: lease.bot.id,
							targetBotRevision: lease.bot.revision,
							repoRoot: lease.root,
							dataDir: options.dataDir ?? process.cwd(),
							targetBranch: command.targetBranch as string,
							commit: command.commit as string | undefined,
							artifactRef: command.artifactRef as DeviceDeliveryArtifactRef | undefined,
							artifact: command.artifact as DeviceArtifact | undefined,
							accountId: config.accountId,
							roomId: command.roomId as string,
							conversationId: command.conversationId as string,
							targetDeviceId: config.deviceId,
						},
						{ signal: commandSignal },
					);
				}
				if (action === "integration_verify") {
					if (!lease.bot.tools.includes("bash")) throw new Error("Target Bot bash command permission required");
					return await deviceVerifyIntegration(
						{
							integrationId: command.integrationId as string,
							targetBotId: lease.bot.id,
							targetBotRevision: lease.bot.revision,
							repoRoot: lease.root,
							dataDir: options.dataDir ?? process.cwd(),
							verificationPlan: command.verificationPlan as DeviceIntegrationVerificationPlan,
							artifactRef: command.artifactRef as DeviceDeliveryArtifactRef | undefined,
							materializedCommit: command.materializedCommit as string,
							preparedTree: command.preparedTree as string,
							expectedTargetSha: command.expectedTargetSha as string,
						},
						{ signal: commandSignal },
					);
				}
				if (action === "integration_confirm") {
					return await deviceConfirmIntegration(
						{
							integrationId: command.integrationId as string,
							targetBotId: lease.bot.id,
							targetBotRevision: lease.bot.revision,
							repoRoot: lease.root,
							dataDir: options.dataDir ?? process.cwd(),
							deliveryId: command.deliveryId as string,
							commit: command.commit as string | undefined,
							materializedCommit: command.materializedCommit as string | undefined,
							expectedTargetSha: command.expectedTargetSha as string,
							publishIntent: validatePublishIntent(command.publishIntent),
							mode: command.mode === "resume" ? "resume" : "first",
						},
						{ signal: commandSignal },
					);
				}
				if (action === "integration_cancel") {
					return await deviceCancelIntegration(
						{
							integrationId: command.integrationId as string,
							targetBotId: lease.bot.id,
							targetBotRevision: lease.bot.revision,
							repoRoot: lease.root,
							dataDir: options.dataDir ?? process.cwd(),
							priorStatus: command.priorStatus as string | undefined,
							verificationMayBeRunning: command.verificationMayBeRunning === true,
						},
						{ signal: commandSignal },
					);
				}
				if (action === "transfer_fence") {
					const snapshot = Array.from(transferOperations);
					await Promise.allSettled(snapshot);
					commandSignal.throwIfAborted();
					return { ok: true };
				}
				if (action === "transfer_stage") {
					const entry = roomFiles(command.roomId as string, command.targetBotId as string, lease);
					const preview = await entry.files.stage(command.bundle, { signal: commandSignal });
					commandSignal.throwIfAborted();
					receipts.set(preview.id, entry);
					return preview;
				}
				if (action === "transfer_init") {
					const entry = roomFiles(command.roomId as string, command.targetBotId as string, lease);
					const res = await entry.files.initChunkedTransfer(command.manifest as any, { signal: commandSignal });
					commandSignal.throwIfAborted();
					receipts.set(res.transferId, entry);
					return res;
				}
				if (action === "transfer_prepare_export") {
					const entry = roomFiles(command.roomId as string, command.targetBotId as string, lease);
					return await entry.files.prepareChunked({
						paths: command.paths as string[],
						recursive: command.recursive === true,
						transferId: command.transferId as string | undefined,
						signal: commandSignal,
					});
				}
				if (action === "transfer_read_chunk") {
					const entry = roomFiles(command.roomId as string, command.targetBotId as string, lease);
					const res = await entry.files.readChunk({
						path: command.path as string,
						offset: command.offset as number,
						size: command.size as number,
						expectedFileSize:
							typeof command.expectedFileSize === "number"
								? command.expectedFileSize
								: typeof command.expectedSize === "number"
									? command.expectedSize
									: undefined,
						expectedChunkSha256:
							typeof command.expectedChunkSha256 === "string"
								? command.expectedChunkSha256
								: typeof command.expectedSha256 === "string"
									? command.expectedSha256
									: undefined,
						signal: commandSignal,
					});
					return { data: res.buffer.toString("base64"), sha256: res.sha256 };
				}
				const receipt = typeof command.transferId === "string" ? receipts.get(command.transferId) : undefined;
				if (action === "transfer_abort") {
					if (receipt) {
						if (
							receipt.roomId !== command.roomId ||
							receipt.botId !== command.targetBotId ||
							receipt.revision !== lease.revision
						) {
							throw new Error("Transfer workspace changed or transfer unavailable");
						}
						receipts.delete(command.transferId as string);
						const res = await receipt.files.abortChunkedTransfer(command.transferId as string);
						return { ...res, status: "cancelled" };
					}
					if (typeof command.transferId === "string") {
						const entry = roomFiles(command.roomId as string, command.targetBotId as string, lease);
						const res = await entry.files.abortChunkedTransfer(command.transferId);
						return { ...res, status: "cancelled" };
					}
					return { ok: true, status: "cancelled" };
				}
				if (
					!receipt ||
					receipt.roomId !== command.roomId ||
					receipt.botId !== command.targetBotId ||
					receipt.revision !== lease.revision
				)
					throw new Error("Transfer workspace changed or transfer unavailable");
				if (action === "transfer_chunk")
					return await receipt.files.writeTransferChunk(command.chunk as any, { signal: commandSignal });
				if (action === "transfer_status") return await receipt.files.getTransferStatus(command.transferId as string);
				if (action === "transfer_preview") {
					try {
						return await receipt.files.previewChunked(command.transferId as string, { signal: commandSignal });
					} catch {
						return await receipt.files.preview(command.transferId as string, { signal: commandSignal });
					}
				}
				if (
					action === "transfer_apply" &&
					typeof command.revision === "string" &&
					Array.isArray(command.overwritePaths) &&
					command.overwritePaths.every((path) => typeof path === "string")
				) {
					const decisions = Object.fromEntries(command.overwritePaths.map((path) => [path, "overwrite" as const]));
					try {
						return await receipt.files.applyChunked({
							transferId: command.transferId as string,
							revision: command.revision,
							decisions,
							signal: commandSignal,
						});
					} catch {
						return await receipt.files.apply({
							id: command.transferId as string,
							revision: command.revision,
							decisions,
							signal: commandSignal,
						});
					}
				}
				throw new Error("Unsupported device command");
			} catch (error) {
				if (
					(error instanceof VerificationStopUnconfirmedError || error instanceof PublicationStopUnconfirmedError) &&
					integrationOwner
				) {
					integrationOwner.blocked = error;
					scheduler.markBlocked(integrationOwner.taskId, integrationOwner.attemptId, error);
				}
				throw error;
			} finally {
				if (!integrationOwner?.blocked) {
					lease.release();
					if (integrationItem) scheduler.releaseActive(integrationItem);
					if (integrationOwner) active.delete(integrationOwner);
					drain();
				}
			}
		})();
		if (action.startsWith("transfer_") && action !== "transfer_fence") {
			transferOperations.add(operation);
			void operation.then(
				() => transferOperations.delete(operation),
				() => transferOperations.delete(operation),
			);
		}
		return track(operation);
	}
	async function onDisconnect(optionsDisconnect?: { abortTasks?: boolean }) {
		const previous = generation;
		generation = new AbortController();
		if (optionsDisconnect?.abortTasks === true) {
			previous.abort();
			for (const owner of active) owner.controller.abort();
		}
		await Promise.allSettled(operations);
		await sweep();
		const blocked = [...active].find((owner) => owner.blocked)?.blocked;
		if (blocked) throw blocked;
	}
	return {
		onTask,
		recovery,
		reportOutbox,
		getSchedulerSnapshot(): TaskSchedulerSnapshot {
			return scheduler.getSnapshot();
		},
		updateExecutionSettings(next: unknown): DeviceExecutionSettings {
			if (options.dataDir) {
				const saved = saveExecutionSettings(options.dataDir, next);
				return scheduler.updateSettings(saved);
			}
			return scheduler.updateSettings(next);
		},
		cancelScheduledTask(taskId: string, attemptId?: string): boolean {
			return scheduler.cancelTask(taskId, attemptId);
		},
		async steerTask(taskId: string, text: string): Promise<boolean> {
			const owner = [...active].find((item) => item.taskId === taskId);
			if (!owner || owner.controller.signal.aborted || owner.blocked || !owner.executor?.steer) {
				return false;
			}
			return owner.executor.steer(text);
		},
		answerTaskInteraction(taskId: string, attemptId: string, answer: unknown): boolean {
			const owner = [...active].find((item) => item.taskId === taskId && item.attemptId === attemptId);
			return !!owner && !owner.controller.signal.aborted && !owner.blocked && !!owner.answer?.(answer);
		},
		onCommand,
		collabService,
		onDisconnect,
		async close() {
			closed = true;
			if (schedulerSaveTimer) clearTimeout(schedulerSaveTimer);
			schedulerSaveTimer = undefined;
			flushSchedulerState();
			await onDisconnect({ abortTasks: true });
			await Promise.allSettled([...files.values()].map((entry) => entry.files.close()));
			files.clear();
			receipts.clear();
		},
	};
}
