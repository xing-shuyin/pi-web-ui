import os from "node:os";
import { boundTaskReport as report } from "./task-report.js";
import type { DeviceTaskActivity } from "../protocol.js";
import { createHash } from "node:crypto";
import { createHumanInteractionBridge, type TaskInteraction } from "./human-interaction.js";
import { executionRoot, executionRootsOverlap } from "./execution-workspace.js";
import { isAbsolute, resolve } from "node:path";
import WebSocket from "ws";
import type { ClientMessage, DeviceTaskState, ServerMessage, UiState } from "../protocol.js";
import { DeviceTaskError } from "./task-error.js";
import { selectTaskContext } from "./task-context-budget.js";
import type { GroupTaskContext } from "./group-context.js";
import type { LocalBot } from "./bots.js";
import { registerBotExecution } from "./bot-execution.js";
import { DeviceExecutionError, executionFailure, type ExecutionPhase } from "./execution-failure.js";
import { projectToolLifecycle, type SanitizedToolLifecycle } from "./task-progress.js";

export interface DeviceExecutorTask {
	botId: string;
	botRevision: number;
	deviceId: string;
	roomId?: string;
	id: string;
	attemptId: string;
	text: string;
	context?: GroupTaskContext;
	/** Bounded delivery-time observation; use task_state for authoritative current state. */
	taskState?: DeviceTaskState;
	/** Stable Hub address; never a local transcript path. */
	conversationId?: string;
	sourceConversationId?: string;
	resume?: boolean;
	kind?: "message" | "request" | "reply" | "result";
	requestId?: string;
	parentTaskId?: string;
	resultOfTaskId?: string;
	handoff?: { repository: string; commit: string; branch?: string; instructions: string };
	planOnly?: boolean;
	canvasRef?: { graphId: string; title?: string };
	presetRevision?: number;
}

export interface DeviceTaskExecutorOptions {
	bot: LocalBot;
	localOrigin: string;
	localAuthToken?: string;
	cwd: string;
	allowExecution?: boolean;
	/** SDK sessionManager.getSessionId(), never the UI conversationId. */
	onSession?: (taskId: string, sessionId: string | undefined) => void;
	resumePath?: string;
	onSessionPath?: (taskId: string, path: string) => void;
	onActivity?: () => void;
	onInteractions?: (items: TaskInteraction[]) => void;
	registerInteractionAnswer?: (answer: ((value: unknown) => boolean) | undefined) => void;
	onProgress?: (activity: DeviceTaskActivity) => void;
	onFullReport?: (taskId: string, attemptId: string, fullReport: string) => Promise<void> | void;
	onToolLifecycle?: (lifecycle: SanitizedToolLifecycle) => void;
	onPlanReady?: (taskId: string, plan: import("../protocol.js").DeviceTaskPlanReadyFrame["plan"]) => Promise<boolean>;
}

export type DeviceTaskCallbacks = Pick<
	DeviceTaskExecutorOptions,
	"onActivity" | "onProgress" | "onInteractions" | "onPlanReady" | "onFullReport" | "onToolLifecycle"
> & { onStarted?: () => void };

// Process-local guards survive executor replacement. They deliberately never retry an
// uncertain attempt. Durable delivery must additionally deduplicate in its task store.
const attempted = new Set<string>();
const busyExecutions = new Set<{ origin: string; botId: string; root: string }>();
const TIMEOUT_MS = 20 * 60 * 1000;

function originUrl(value: string): URL {
	const url = new URL(value);
	if (
		url.protocol !== "http:" ||
		!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
		url.username ||
		Reflect.get(url, "pass" + "word") ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		throw new Error("localOrigin must be a credential-free loopback http origin");
	return url;
}

function samePath(a?: string, b?: string): boolean {
	if (!a || !b) return false;
	const fold = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
	return fold(a) === fold(b);
}

export function taskPrompt(task: DeviceExecutorTask): string {
	const context = task.taskState ? selectTaskContext(task.taskState) : undefined;
	return [
		`Device task ${JSON.stringify(task.id)}, attempt ${JSON.stringify(task.attemptId)}.`,
		`Local system (measured by this bridge): ${os.platform()} / ${os.arch()}.`,
		JSON.stringify({
			text: task.text,
			taskState: context?.state,
			taskStateSelection: context?.selection,
			roomId: task.roomId ?? null,
			sourceBotId: task.botId,
			conversationId: task.conversationId,
			sourceConversationId: task.sourceConversationId,
			kind: task.kind,
			requestId: task.requestId,
			parentTaskId: task.parentTaskId,
			resultOfTaskId: task.resultOfTaskId,
			handoff: task.handoff ?? null,
		}),
	].join("\n\n");
}

/** Connects as an independent client; never changes approval settings or retries.
 * close() cancels only this client's locked task conversation. Failures reject with
 * a bounded report; completed sessions remain persisted for local inspection.
 * close() is permanent: after a disconnect, create a fresh executor and explicitly
 * create a new task. Reconnection does not resume or retry an interrupted task.
 */
export function createDeviceTaskExecutor(options: DeviceTaskExecutorOptions) {
	const origin = originUrl(options.localOrigin);
	if (!isAbsolute(options.cwd)) throw new Error("cwd must be an absolute local path");
	const cwd = resolve(options.cwd);
	const root = executionRoot(cwd);
	let closed = false;
	let cancel: (() => void) | undefined;
	let stopped: Promise<void> = Promise.resolve();

	return {
		run(task: DeviceExecutorTask): Promise<string> {
			if (closed) return Promise.reject(new Error("Executor closed"));
			if (options.allowExecution !== true)
				return Promise.reject(
					new DeviceTaskError(
						"目标设备未开启群任务执行权限。请在该设备的设备中心 → 连接设置中开启“允许智能体任务与文件导入”。 / Local task execution is disabled.",
						"Local task execution is disabled",
					),
				);
			if (!task.id || !task.attemptId || !task.text?.trim()) return Promise.reject(new Error("Invalid task"));
			if (
				[...busyExecutions].some(
					(entry) =>
						entry.origin === origin.origin && (entry.botId === task.botId || executionRootsOverlap(entry.root, root)),
				)
			)
				return Promise.reject(
					new DeviceTaskError(
						"目标设备正在执行另一个群任务，请稍后再试。 / Local task executor busy.",
						"Local task executor busy",
					),
				);
			const key = JSON.stringify([origin.origin, task.id]);
			if (attempted.has(key)) return Promise.reject(new Error("Duplicate task: execution will not be repeated"));
			if (
				!options.bot ||
				options.bot.id !== task.botId ||
				options.bot.revision !== task.botRevision ||
				!task.deviceId ||
				resolve(options.bot.cwd) !== cwd
			) {
				return Promise.reject(new Error("Task Bot identity, revision, device and cwd must match the local Bot lease"));
			}
			if (!!task.resume !== !!options.resumePath || (options.resumePath && !isAbsolute(options.resumePath)))
				return Promise.reject(new Error("Resume requires an authorized local transcript path"));
			if (task.planOnly && !options.bot.tools.includes("plan_update"))
				return Promise.reject(
					new DeviceTaskError("Planning requires plan_update authorization in the Bot tool allowlist"),
				);
			const prompt = taskPrompt(task);
			const primary = !!(
				task.context &&
				task.context.roomId === task.roomId &&
				task.context.primaryBotId === task.botId &&
				task.context.members.some((member) => member.id === task.botId)
			);
			if (task.context && task.context.roomId !== task.roomId)
				return Promise.reject(new Error("Group context room must match task room"));
			const binding = registerBotExecution(options.bot, options.resumePath, {
				primary,
				groupContext: task.context,
				planOnly: Boolean(task.planOnly),
			});
			attempted.add(key);
			const lock = { origin: origin.origin, botId: task.botId, root };
			busyExecutions.add(lock);
			return new Promise<string>((resolveRun, rejectRun) => {
				const { clientId, capability } = binding;
				const wsUrl = new URL("/ws", origin);
				wsUrl.protocol = "ws:";
				let ws: WebSocket;
				let phase: "hello" | "initial" | "cwd" | "new" | "run" = "hello";
				let state: UiState | undefined;
				let conversationId: string | undefined;
				let sdkSessionId: string | undefined;
				let sessionBound = false;
				let currentId: string | undefined;
				let prompted = false;
				let sawRunning = false;
				let priorMessageIds = new Set<string>();
				let promptRev = -1;
				let priorPlanFingerprint = "";
				const successfulPlanFingerprints = new Set<string>();
				const planFingerprint = (plan: UiState["plan"]) =>
					createHash("sha256")
						.update(JSON.stringify(plan ?? null))
						.digest("hex");
				let capturedPath: string | undefined;
				let settled = false;
				let idleConfirmed = false;
				let stopUnconfirmed = false;
				let interactions: ReturnType<typeof createHumanInteractionBridge> | undefined;
				// Immediate notifications can precede snapshots. Keep them until an
				// explicit resolution or a snapshot-observed wait has disappeared.
				const humanWaits = new Set<string>();
				let snapshotWaits = new Set<string>();
				let queuedQuestions = new Set<string>();
				let waitingForHuman = false;
				const belongsToTask = (entry: { conversationId?: string }) =>
					!entry.conversationId || entry.conversationId === conversationId;
				const waitsInSnapshot = (value: UiState) => {
					const ids = new Set<string>();
					if (value.pendingQuestion && belongsToTask(value.pendingQuestion))
						ids.add(`question:${value.pendingQuestion.id}`);
					for (const approval of [value.pendingApproval, ...(value.pendingApprovals ?? [])])
						if (approval && belongsToTask(approval)) ids.add(`approval:${approval.id}`);
					return ids;
				};
				let stopBaselineRev = -1;
				let stopTimer: ReturnType<typeof setTimeout> | undefined;
				let resolveStopped!: () => void;
				let rejectStopped!: (error: Error) => void;
				stopped = new Promise<void>((resolve, reject) => {
					resolveStopped = resolve;
					rejectStopped = reject;
				});
				void stopped.catch(() => {});
				const uncertain = () => {
					stopUnconfirmed = true;
					clearTimeout(stopTimer);
					rejectStopped(
						new DeviceTaskError(
							"无法确认群任务已停止，项目已隔离。请在本机确认后重启服务。 / Task stop unconfirmed; workspace blocked until service restart.",
						),
					);
					ws?.terminate();
				};
				const confirmStopped = () => {
					if (stopUnconfirmed) return;
					clearTimeout(stopTimer);
					idleConfirmed = true;
					binding.release();
					if (!ws || ws.readyState === WebSocket.CLOSED) {
						busyExecutions.delete(lock);
						resolveStopped();
						return;
					}
					ws.once("close", () => {
						busyExecutions.delete(lock);
						resolveStopped();
					});
					ws.close();
					const cleanup = setTimeout(() => ws.terminate(), 1000);
					cleanup.unref();
					ws.once("close", () => clearTimeout(cleanup));
				};
				let cwdDone = false;
				let planDeliveryPending = false;
				let baselineRev = -1;
				const send = (message: ClientMessage) => {
					if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
				};
				const context = () =>
					`Task: ${task.id}\nAttempt: ${task.attemptId}\nLocal system: ${os.platform()} / ${os.arch()}\nLocal UI: ${origin.origin}/\nClient: ${clientId}\nConversation: ${conversationId ?? "not created"}`;
				const finish = (error?: string, body = "", failurePhase?: ExecutionPhase) => {
					if (settled) return;
					settled = true;
					interactions?.close();
					options.registerInteractionAnswer?.(undefined);
					capability.revoke();
					// 锁的语义是「这个 bot/root 上还有一条任务在跑」，而 run 一旦 settle（capability
					// 已撤销、不再有任何写入路径），它就不再是在跑。旧实现只在连接 close 时才放锁：
					// ① 用户/守护重试一条刚结束的任务，在 close 到达前一律被判「本地执行器忙」；
					// ② 单测里上一条 run 的 close 还没到，下一条就被误判 busy（CI 随机红）。
					// 这里在 settle 时就放锁（幂等，后面 confirmStopped 的 delete 变成 no-op）；
					// 同 workspace 并发写的护栏仍然是 capability.revoke() + 新的 bot lease。
					busyExecutions.delete(lock);
					try {
						if (sessionBound) options.onSession?.(task.id, undefined);
					} catch {
						error = "Task session ownership cleanup failed";
					} finally {
						sessionBound = false;
					}
					clearTimeout(timer);
					// abort has no conversationId in the wire protocol. Only send while
					// the private connection still points at the conversation we prompted.
					cancel = undefined;
					if (!prompted || idleConfirmed) confirmStopped();
					else if (currentId !== conversationId || ws.readyState !== WebSocket.OPEN) uncertain();
					else {
						stopBaselineRev = state?.rev ?? -1;
						send({ type: "abort" });
						send({ type: "get_state" });
						stopTimer = setTimeout(uncertain, 20_000);
						stopTimer.unref();
					}
					const result = error ? report(`${context()}\n\nExecution interrupted: ${error}`) : report(body);
					const fullReportSaved =
						!error && options.onFullReport
							? Promise.resolve().then(() => options.onFullReport!(task.id, task.attemptId, body))
							: Promise.resolve();
					if (error)
						rejectRun(
							new DeviceExecutionError(
								executionFailure(
									error,
									failurePhase ??
										(phase === "hello"
											? "handshake"
											: phase === "initial" || phase === "cwd"
												? "init"
												: phase === "new"
													? options.resumePath
														? "switch_session"
														: "new_chat"
													: "model"),
								),
								result,
							),
						);
					else void fullReportSaved.then(() => resolveRun(result), rejectRun);
				};
				let timer: ReturnType<typeof setTimeout> | undefined;
				const armTimeout = () => {
					clearTimeout(timer);
					timer = setTimeout(() => finish("20 minute timeout; no automatic retry"), TIMEOUT_MS);
					timer.unref();
				};
				let contentFingerprint: string | undefined;
				let activitySequence = -1;
				let progressMessageId: string | undefined;
				let progressText = "";
				const emittedToolStarts = new Set<string>();
				const emittedToolEnds = new Set<string>();
				const activity = (progress?: { phase: "model" | "tool" | "waiting"; text?: string; toolName?: string }) => {
					if (settled) return;
					if (!waitingForHuman) armTimeout();
					options.onActivity?.();
					if (progress) options.onProgress?.(progress);
				};
				const updateHumanWait = () => {
					const waiting = humanWaits.size > 0 || queuedQuestions.size > 0;
					if (waiting === waitingForHuman) return;
					waitingForHuman = waiting;
					if (waiting) clearTimeout(timer);
					else armTimeout();
				};
				armTimeout();
				cancel = () => finish("Executor closed; task cancelled");
				try {
					ws = new WebSocket(wsUrl, {
						origin: origin.origin,
						headers: options.localAuthToken ? { Authorization: `Bearer ${options.localAuthToken}` } : undefined,
					});
				} catch {
					finish("Failed to open local WebSocket");
					return;
				}
				ws.on("open", () => send({ type: "hello", clientId }));
				ws.on("error", () => finish("Local WebSocket error; no automatic retry"));
				ws.on("close", (code, reason) => {
					finish(
						`Local WebSocket disconnected (${code}); execution outcome uncertain; no automatic retry. ${reason.toString()}`,
					);
					if (prompted && !idleConfirmed) uncertain();
				});
				ws.on("message", (data) => {
					let message: ServerMessage;
					try {
						message = JSON.parse(data.toString()) as ServerMessage;
					} catch {
						finish("Invalid local protocol frame");
						return;
					}
					if (settled && message.type !== "snapshot" && message.type !== "snapshot_delta") return;
					if (message.type === "ready") {
						if (phase !== "hello" || message.clientId !== clientId) {
							finish("Unexpected handshake");
							return;
						}
						phase = "initial";
						return;
					}
					if (
						message.type === "notice" &&
						(message.level === "error" || (phase === "new" && message.level === "warning"))
					) {
						finish(message.textEn || message.text || "Local agent error notice");
						return;
					}
					if (message.type === "transition_progress") {
						if (message.phase === "error") finish(message.text || "Local session transition failed");
						if (phase === "cwd" && message.kind === "cwd" && message.phase === "done") {
							cwdDone = true;
							send({ type: "get_state" });
						}
						return;
					}
					if (phase === "run") {
						interactions?.observe(message);
						if (
							(message.type === "message_delta" || message.type === "tool_delta") &&
							message.conversationId === conversationId
						) {
							if (message.seq <= activitySequence) return;
							activitySequence = message.seq;
							if (message.type === "message_delta") {
								const event = message.assistantMessageEvent;
								if (event.delta) {
									if (event.type === "text_delta") {
										if (progressMessageId !== message.messageId) progressText = "";
										progressMessageId = message.messageId;
										const bytes = Buffer.from(progressText + event.delta);
										let start = Math.max(0, bytes.length - 2048);
										while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
										progressText = bytes.subarray(start).toString("utf8");
										activity({ phase: "model", text: progressText });
									} else activity();
								}
							} else if (message.delta) {
								if (message.toolCallId && !emittedToolStarts.has(message.toolCallId)) {
									emittedToolStarts.add(message.toolCallId);
									const startLifecycle = projectToolLifecycle({
										toolName: message.toolName,
										phase: "start",
										callId: message.toolCallId,
									});
									if (startLifecycle) options.onToolLifecycle?.(startLifecycle);
								}
								const toolActivity = {
									phase: "tool" as const,
									...(/^[A-Za-z0-9_.:-]{1,80}$/.test(message.toolName) ? { toolName: message.toolName } : {}),
									text: typeof message.delta === "string" ? message.delta : undefined,
								};
								const lifecycle = projectToolLifecycle({
									toolName: message.toolName,
									phase: "progress",
									callId: message.toolCallId,
									output: message.delta,
								});
								if (lifecycle) options.onToolLifecycle?.(lifecycle);
								activity(toolActivity);
							}
							return;
						}
						if (message.type === "tool_status") {
							if (message.toolCallId && !emittedToolStarts.has(message.toolCallId)) {
								emittedToolStarts.add(message.toolCallId);
								const startLifecycle = projectToolLifecycle({
									toolName: message.toolName,
									phase: "start",
									callId: message.toolCallId,
								});
								if (startLifecycle) options.onToolLifecycle?.(startLifecycle);
							}
							if (message.toolCallId && !emittedToolEnds.has(message.toolCallId)) {
								emittedToolEnds.add(message.toolCallId);
								const lifecycle = projectToolLifecycle({
									toolName: message.toolName,
									phase: message.isError ? "failed" : "end",
									callId: message.toolCallId,
									durationMs: message.durationMs,
								});
								if (lifecycle) options.onToolLifecycle?.(lifecycle);
							}
							activity({
								phase: "tool",
								...(/^[A-Za-z0-9_.:-]{1,80}$/.test(message.toolName) ? { toolName: message.toolName } : {}),
								text: `[Tool ${message.toolName} ${message.isError ? "failed" : "finished"}]`,
							});
							return;
						}
						if (message.type === "question_pending" || message.type === "tool_approval_pending") {
							if (belongsToTask(message)) {
								humanWaits.add(`${message.type === "question_pending" ? "question" : "approval"}:${message.id}`);
								updateHumanWait();
							}
							return;
						}
						if (message.type === "question_retracted" || message.type === "tool_approval_resolved") {
							const id = `${message.type === "question_retracted" ? "question" : "approval"}:${message.id}`;
							humanWaits.delete(id);
							queuedQuestions.delete(id);
							updateHumanWait();
							send({ type: "get_state" });
							return;
						}
						if (message.type === "question_queue") {
							queuedQuestions = new Set(
								message.questions
									.filter((q) => q.conversationId === conversationId || q.rootConversationId === conversationId)
									.map((q) => `question:${q.id}`),
							);
							for (const id of humanWaits)
								if (id.startsWith("question:") && !queuedQuestions.has(id)) humanWaits.delete(id);
							updateHumanWait();
							return;
						}
					}
					if (message.type === "snapshot") state = message.state;
					else if (message.type === "snapshot_delta") {
						if (!state || state.conversationId !== message.conversationId || state.rev !== message.baseRev) {
							send({ type: "get_state" });
							return;
						}
						state = { ...message.state, messages: [...state.messages, ...message.appended] };
					} else return;
					if (state.clientId !== clientId) {
						finish("Unexpected snapshot client ownership");
						return;
					}
					currentId = state.conversationId;
					if (settled) {
						if (
							state.rev > stopBaselineRev &&
							currentId === conversationId &&
							state.sessionId === sdkSessionId &&
							!state.isStreaming &&
							!state.retry &&
							!state.streamingMessage &&
							waitsInSnapshot(state).size === 0
						)
							confirmStopped();
						return;
					}
					// Initialization/new_chat failures can arrive as snapshots before a
					// task conversation exists. Do not wait for a successful transition.
					const snapshotError: unknown = Reflect.get(state, "error");
					if (state.errorMessage || (typeof snapshotError === "string" && snapshotError)) {
						finish(state.errorMessage || (snapshotError as string));
						return;
					}
					if (phase === "initial" || (phase === "cwd" && cwdDone)) {
						if (resolve(state.cwd) !== cwd) {
							if (phase === "cwd") {
								finish("Workspace switch did not reach requested cwd");
								return;
							}
							finish("Bot workspace initialization did not reach fixed cwd");
						} else {
							phase = "new";
							baselineRev = state.rev;
							if (options.resumePath) send({ type: "switch_session", path: options.resumePath, independent: false });
							else send({ type: "new_chat", ephemeral: false, independent: false });
						}
						return;
					}
					if (phase === "new") {
						if (state.rev <= baselineRev || state.isStreaming) return;
						if (options.resumePath) {
							if (!samePath(state.sessionFile, options.resumePath)) return;
						} else if (state.messages.length || state.historyTotal) return;
						if (state.isEphemeral || resolve(state.cwd) !== cwd) {
							finish("Task session is not persistent in requested cwd");
							return;
						}
						conversationId = currentId;
						if (state.pendingQuestion || state.pendingApproval) {
							finish("New session requires local human input");
							return;
						}
						// AgentSession.sessionId delegates to sessionManager.getSessionId(),
						// the same SDK identifier captured by device_collab tool context.
						if (!state.sessionId) {
							finish("Task session has no SDK session ID");
							return;
						}
						sdkSessionId = state.sessionId;
						sessionBound = true;
						try {
							options.onSession?.(task.id, sdkSessionId);
							if (state.sessionFile) {
								options.onSessionPath?.(task.id, state.sessionFile);
								capturedPath = state.sessionFile;
							}
						} catch {
							finish("Task session ownership registration failed");
							return;
						}
						// A callback may synchronously close the executor.
						if (settled) return;
						priorMessageIds = new Set(state.messages.map((m) => m.id));
						promptRev = state.rev;
						priorPlanFingerprint = planFingerprint(state.plan);
						contentFingerprint = createHash("sha256")
							.update(JSON.stringify([state.messages.map((m) => [m.id, m.content]), state.streamingMessage?.content]))
							.digest("hex");
						phase = "run";
						if (task.roomId && options.onInteractions) {
							interactions = createHumanInteractionBridge(
								{
									taskId: task.id,
									attemptId: task.attemptId,
									botId: task.botId,
									deviceId: task.deviceId,
									roomId: task.roomId,
								},
								{
									conversationId: conversationId!,
									isCurrent: () => !settled && currentId === conversationId && state?.sessionId === sdkSessionId,
									send: (message) => {
										// The bridge has validated task/attempt/conversation and consumed the request ID.
										binding.authorizeInteractionReply(message);
										send(message);
									},
									publish: options.onInteractions,
								},
							);
							options.registerInteractionAnswer?.((value) => interactions!.answer(value));
						}
						prompted = true;
						send({ type: "prompt", text: prompt });
						return;
					}
					if (phase !== "run") return;
					if (currentId !== conversationId) {
						finish("Task conversation ownership changed; refusing to abort another conversation");
						return;
					}
					if (state.sessionId !== sdkSessionId) {
						finish("Task SDK session ownership changed");
						return;
					}
					if (
						resolve(state.cwd) !== cwd ||
						state.isEphemeral ||
						(options.resumePath && !samePath(state.sessionFile, options.resumePath))
					) {
						finish("Task transcript or fixed workspace ownership changed");
						return;
					}
					if (state.sessionFile && !samePath(state.sessionFile, capturedPath)) {
						try {
							options.onSessionPath?.(task.id, state.sessionFile);
							capturedPath = state.sessionFile;
						} catch {
							finish("Task transcript ownership registration failed");
							return;
						}
					}
					// Revisions, get_state responses, transport heartbeats and usage-only
					// snapshots are not evidence that the task is making progress.
					const fingerprint = createHash("sha256")
						.update(JSON.stringify([state.messages.map((m) => [m.id, m.content]), state.streamingMessage?.content]))
						.digest("hex");
					if (fingerprint !== contentFingerprint) {
						contentFingerprint = fingerprint;
						activity();
					}
					interactions?.snapshot(state);
					for (const m of state.messages) {
						if (!priorMessageIds.has(m.id)) {
							if (m.role === "assistant" && Array.isArray(m.content)) {
								for (const c of m.content) {
									if (
										typeof c === "object" &&
										c !== null &&
										((c as any).type === "toolCall" || (c as any).type === "tool_use") &&
										(c as any).name
									) {
										const callId = (c as any).id || (c as any).toolCallId;
										if (callId && !emittedToolStarts.has(callId)) {
											emittedToolStarts.add(callId);
											const lifecycle = projectToolLifecycle({
												toolName: (c as any).name,
												phase: "start",
												callId,
												parameters: (c as any).arguments ?? (c as any).input,
											});
											if (lifecycle) options.onToolLifecycle?.(lifecycle);
										}
									}
								}
							}
							if (m.role === "toolResult" || (m as any).type === "toolResult") {
								if (task.planOnly && m.toolName === "plan_update" && m.isError === false) {
									const resultPlan = (m.details as { plan?: UiState["plan"] } | undefined)?.plan;
									if (resultPlan) successfulPlanFingerprints.add(planFingerprint(resultPlan));
								}
								const callId = (m as any).toolCallId || m.id;
								const toolName = (m as any).toolName;
								if (callId && !emittedToolEnds.has(callId)) {
									emittedToolEnds.add(callId);
									const lifecycle = projectToolLifecycle({
										toolName: toolName || "tool",
										phase: (m as any).isError ? "failed" : "end",
										callId,
										output: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
									});
									if (lifecycle) options.onToolLifecycle?.(lifecycle);
								}
							}
						}
					}
					const nextWaits = waitsInSnapshot(state);
					for (const id of snapshotWaits) if (!nextWaits.has(id)) humanWaits.delete(id);
					for (const id of nextWaits) humanWaits.add(id);
					snapshotWaits = nextWaits;
					updateHumanWait();
					sawRunning ||= state.isStreaming;
					if (waitingForHuman) return;
					if (state.isStreaming || state.retry || state.streamingMessage) return;
					if (state.rev <= promptRev) return;
					const assistant = state.messages.filter((m) => m.role === "assistant" && !priorMessageIds.has(m.id));
					if (!assistant.length && !sawRunning) return;
					idleConfirmed = true;
					const last = assistant.at(-1);
					if (last?.errorMessage || last?.stopReason === "error" || last?.stopReason === "aborted") {
						finish(last.errorMessage ?? `Assistant ${last.stopReason}`);
						return;
					}
					const body = assistant
						.map((m) =>
							m.content
								.filter((b) => b.type === "text")
								.map((b) => ("text" in b && typeof b.text === "string" ? b.text : ""))
								.join(""),
						)
						.filter(Boolean)
						.join("\n\n");

					if (task.planOnly) {
						const currentPlanFingerprint = planFingerprint(state.plan);
						if (
							currentPlanFingerprint === priorPlanFingerprint ||
							!successfulPlanFingerprints.has(currentPlanFingerprint)
						) {
							finish("Planning requires a successful plan_update in this turn; refusing to reuse an old plan");
							return;
						}
						if (planDeliveryPending) return;
						planDeliveryPending = true;
						void (async () => {
							try {
								const accepted = await options.onPlanReady?.(task.id, {
									state: "ready",
									steps: state.plan?.steps ?? [],
									summary: body.slice(0, 500),
								});
								if (!accepted) throw new Error("Plan was not persisted by Hub");
								if (!body.trim()) finish("Execution ended without assistant text");
								else finish(undefined, body);
							} catch (error) {
								finish(error instanceof Error ? error.message : "Plan delivery failed");
							}
						})();
						return;
					}

					if (!body.trim()) finish("Execution ended without assistant text");
					else finish(undefined, body);
				});
			});
		},
		close(): Promise<void> {
			closed = true;
			cancel?.();
			return stopped;
		},
	};
}
