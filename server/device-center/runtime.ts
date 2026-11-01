import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { writeJsonAtomicSync } from "../atomic-file.js";
import { createDeviceCollabService } from "./collab-service.js";
import { createDeviceTaskExecutor, type DeviceExecutorTask, type DeviceTaskExecutorOptions } from "./executor.js";
import { createDeviceFileSync } from "./file-sync.js";
import { DeviceTaskError } from "./task-error.js";
import { TaskRecoveryManager } from "./task-recovery.js";
import { createTaskReportOutbox } from "./task-report-outbox.js";
import { reportUploadMetadata } from "./report-metadata.js";
import { DeviceTaskScheduler, type TaskSchedulerSnapshot } from "./task-scheduler.js";
import { loadExecutionSettings, saveExecutionSettings, type DeviceExecutionSettings } from "./execution-settings.js";
import type { LocalBotRegistry } from "./bots.js";
import type { DeviceCollabExecutionContext } from "./collab-tool.js";
import { executionRoot, executionRootsOverlap } from "./execution-workspace.js";
import {
	devicePrepareIntegration,
	deviceVerifyIntegration,
	deviceConfirmIntegration,
	deviceCancelIntegration,
} from "./device-integration.js";

type Config = { hubUrl: string; deviceId: string; credential: string; allowExecution: boolean };
type Files = ReturnType<typeof createDeviceFileSync>;
type Executor = { run(task: DeviceExecutorTask): Promise<string>; close(): void | Promise<void> };
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

/** The task settled, but its executor has not confirmed that execution stopped. */
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
	const scheduler = new DeviceTaskScheduler({
		initialSettings: loadExecutionSettings(options.dataDir),
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
	async function acquire(botId: string, signal?: AbortSignal) {
		enabled(signal);
		await sweep();
		const lease = await bots.acquire(botId);
		try {
			enabled(signal);
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
			entry = {
				roomId,
				botId,
				revision: lease.revision,
				files: createDeviceFileSync({
					root: lease.root,
					dataDir: scopedDataDir,
					allowReceive: config.allowExecution,
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

		if (typeof task.leaseToken !== "string" || !task.leaseToken) {
			return Promise.reject(new DeviceTaskError("Hub task lease grant required"));
		}

		const capacityCheck = recovery.hasOutboxCapacity();
		if (!capacityCheck.available) {
			return Promise.reject(new DeviceTaskError(capacityCheck.reason ?? "Recovery outbox capacity reached"));
		}

		const owner: TaskOwner = {
			controller: new AbortController(),
			botId: task.botId,
			root,
			taskId: task.id,
			attemptId: task.attemptId,
		};

		// Transactional Admission: reverse cleanup on any failure before execution starts
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
			let lease: Awaited<ReturnType<typeof acquire>> | undefined;
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
				} catch (error) {
					if (taskSignal.aborted) throw error;
					throw new DeviceTaskError("目标 Bot 不可用、配置已变更或正在忙碌。 / Target Bot unavailable or busy.");
				}
				let binding: string | undefined;
				let resumePath: string | undefined;
				let transcriptPath: string | undefined;
				let boundSession: string | undefined;
				if (task.resume !== undefined && typeof task.resume !== "boolean")
					throw new DeviceTaskError("Invalid resume flag");
				if (task.resume && !task.conversationId) throw new DeviceTaskError("Resume conversation address required");
				if (task.conversationId !== undefined) {
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
						// Persist the original before notifying transport or settling the task.
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
						if (task.conversationId) {
							const currentBot = bots.get(task.botId);
							if (
								!binding ||
								!currentBot?.enabled ||
								currentBot.revision !== lease!.bot.revision ||
								resolve(currentBot.cwd) !== resolve(lease!.root)
							)
								throw new DeviceTaskError("Conversation transcript ownership changed");
							try {
								// Fresh SDK sessions allocate a path before the first message creates
								// the file. Bind it now so failed first turns remain recoverable.
								// Existing resume paths must still refer to a real transcript.
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
								...(task.taskState ? { taskState: structuredClone(task.taskState) } : {}),
								roomId: task.roomId,
								root: lease!.root,
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
				const result = await owner.executor.run(task);
				await confirmStop();
				taskSignal.throwIfAborted();
				if (task.conversationId) {
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
				// Commit to durable outbox ONLY after all outcomes and transcripts are verified
				recovery.recordTaskFinish(
					{
						id: task.id,
						attemptId: task.attemptId,
						botId: task.botId,
						deviceId: config.deviceId,
						roomId: task.roomId,
					},
					{
						status: "completed",
						report: result,
						reportMetadata: reportUploadMetadata(reportOutbox.get(task) ?? reportOutbox.markMissing(task)),
					},
				);
				return result;
			} catch (error) {
				const isUnconfirmed =
					!!owner.blocked ||
					error instanceof DeviceTaskStopUnconfirmedError ||
					(error && typeof error === "object" && (error as any).stopUnconfirmed === true);
				try {
					recovery.recordTaskFinish(
						{
							id: task.id,
							attemptId: task.attemptId,
							botId: task.botId,
							deviceId: config.deviceId,
							roomId: task.roomId,
						},
						{
							status: isUnconfirmed ? "interrupted" : "failed",
							error,
							reportMetadata: reportUploadMetadata(reportOutbox.get(task) ?? reportOutbox.markMissing(task)),
						},
					);
				} catch {}
				throw error;
			} finally {
				taskSignal.removeEventListener("abort", stop);
				let stoppedCleanly = false;
				try {
					await confirmStop();
					stoppedCleanly = true;
				} catch {}
				for (const [id, bound] of sessions)
					if (bound.taskId === task.id && bound.roomId === task.roomId) sessions.delete(id);
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
	function onCommand(action: string, payload: unknown, signal: AbortSignal) {
		const commandSignal = AbortSignal.any([signal, generation.signal]);
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
			enabled(commandSignal);
			if (!payload || typeof payload !== "object" || Array.isArray(payload))
				throw new Error("Invalid transfer command");
			const command = payload as Record<string, unknown>;
			if (typeof command.roomId !== "string" && !action.startsWith("integration_")) throw new Error("Room required");
			if (typeof command.targetBotId !== "string" || !command.targetBotId) throw new Error("Target Bot required");
			const lease = await acquire(command.targetBotId, commandSignal);
			try {
				if (
					!action.startsWith("integration_")
						? command.targetBotRevision !== lease.bot.revision
						: command.targetBotRevision !== undefined && command.targetBotRevision !== lease.bot.revision
				)
					throw new Error("Transfer Bot revision mismatch");
				if (action === "integration_prepare") {
					return await devicePrepareIntegration(
						{
							integrationId: command.integrationId as string,
							targetBotId: lease.bot.id,
							targetBotRevision: lease.bot.revision,
							repoRoot: lease.root,
							dataDir: options.dataDir ?? process.cwd(),
							targetBranch: command.targetBranch as string,
							commit: command.commit as string,
						},
						{ signal: commandSignal },
					);
				}
				if (action === "integration_verify") {
					return await deviceVerifyIntegration(
						{
							integrationId: command.integrationId as string,
							targetBotId: lease.bot.id,
							targetBotRevision: lease.bot.revision,
							repoRoot: lease.root,
							dataDir: options.dataDir ?? process.cwd(),
							commands: command.commands as string[],
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
							commit: command.commit as string,
							expectedTargetSha: command.expectedTargetSha as string,
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
			} finally {
				lease.release();
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
		answerTaskInteraction(taskId: string, attemptId: string, answer: unknown): boolean {
			const owner = [...active].find((item) => item.taskId === taskId && item.attemptId === attemptId);
			return !!owner && !owner.controller.signal.aborted && !owner.blocked && !!owner.answer?.(answer);
		},
		onCommand,
		collabService,
		onDisconnect,
		async close() {
			closed = true;
			await onDisconnect({ abortTasks: true });
			await Promise.allSettled([...files.values()].map((entry) => entry.files.close()));
			files.clear();
			receipts.clear();
		},
	};
}
