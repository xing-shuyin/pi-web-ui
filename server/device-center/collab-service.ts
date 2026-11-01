import { createHash, randomUUID } from "node:crypto";
import type { DeviceDeliveryRequest, DeviceReviewRequest } from "../protocol.js";
import { resolve } from "node:path";
import type { DeviceCollabContext, DeviceCollabExecutionContext, DeviceCollabService } from "./collab-tool.js";
import type { createDeviceFileSync } from "./file-sync.js";
import { transferSummary } from "./transfers.js";
import { checkedUrl } from "./relay.js";
import { validateDeviceCollabInput } from "./collab-tool.js";
import { getExecutionGuide } from "./execution-guides.js";
import { getGroupContextMetrics } from "./group-context-message.js";

type Config = { hubUrl: string; deviceId: string; credential: string; allowExecution: boolean };
export function createDeviceCollabService(options: {
	getConfig: () => Config | undefined;
	root?: string;
	files?: ReturnType<typeof createDeviceFileSync>;
	workspaceResolver?: (input: {
		roomId: string;
		sourceBotId: string;
		context: DeviceCollabContext;
		signal?: AbortSignal;
	}) => Promise<{ root: string; files: ReturnType<typeof createDeviceFileSync>; release(): void }>;
	fetch?: typeof fetch;
	getExecutionContext?: (context?: DeviceCollabContext) => DeviceCollabExecutionContext | undefined;
	getParentTask?: (context?: DeviceCollabContext) => string | undefined;
	getSourceBot?: (context?: DeviceCollabContext) => string | undefined;
}): DeviceCollabService {
	const root = options.root === undefined ? undefined : resolve(options.root);
	return {
		async execute(action, args, signal, context) {
			let workspace: { root: string; files: ReturnType<typeof createDeviceFileSync>; release(): void } | undefined;
			try {
				signal?.throwIfAborted();
				if (!context) throw new Error("Invalid workspace");
				const bound = options.getExecutionContext?.(context);
				// Resolve authority before workspace acquisition; never mutate caller arguments.
				if (["task_state", "task_update", "task_evidence", "execution_guide", "context_metrics"].includes(action))
					validateDeviceCollabInput({ ...args, action });
				args = { ...args };
				const boundBot = bound?.botId ?? options.getSourceBot?.(context);
				const parentTaskId = bound?.taskId ?? options.getParentTask?.(context);
				if (args.sourceBotId !== undefined && boundBot && args.sourceBotId !== boundBot)
					throw new Error("Invalid source bot");
				if (args.roomId !== undefined && bound && args.roomId !== bound.roomId) throw new Error("Invalid room");
				if (args.parentTaskId !== undefined && args.parentTaskId !== parentTaskId)
					throw new Error("Parent task spoofing denied");
				args.sourceBotId ??= bound?.botId;
				args.roomId ??= bound?.roomId;
				if (
					action === "conversation_attention" ||
					action === "conversation_deliver" ||
					action === "task_state" ||
					action === "task_update" ||
					action === "task_evidence"
				)
					args.conversationId ??= bound?.conversationId;
				if (action === "reply_to_request") {
					if (!bound || bound.kind !== "request" || !bound.sourceConversationId || !bound.requestId)
						throw new Error("Incoming request binding required");
					if (
						(args.conversationId !== undefined && args.conversationId !== bound.sourceConversationId) ||
						(args.requestId !== undefined && args.requestId !== bound.requestId) ||
						(args.kind !== undefined && args.kind !== "reply")
					)
						throw new Error("Reply route mismatch");
					action = "conversation_send";
					args.conversationId = bound.sourceConversationId;
					args.requestId = bound.requestId;
					args.kind = "reply";
				}
				if (
					action === "task_update" &&
					(!bound?.conversationId || !bound.taskId || args.conversationId !== bound.conversationId)
				)
					throw new Error("Task updates require the bound conversation and task.");
				if (["current_task", "execution_guide", "context_metrics"].includes(action) && !bound)
					throw new Error("Task session binding required");
				if (action === "context_metrics" && !context.sessionId) throw new Error("Session binding required");
				const readOnly = action === "list_bots" || action === "list_rooms";
				if (!readOnly && !args.sourceBotId) throw new Error("Source bot required");
				if (options.workspaceResolver && !["list_bots", "list_rooms", "create_room"].includes(action)) {
					if (!args.roomId) throw new Error("Room required");
					if (!args.sourceBotId) throw new Error("Source bot required");
					workspace = await options.workspaceResolver({
						roomId: args.roomId,
						sourceBotId: args.sourceBotId,
						context,
						signal,
					});
					if (resolve(context.cwd) !== resolve(workspace.root)) throw new Error("Invalid workspace");
				} else if (!options.workspaceResolver && resolve(context.cwd) !== root) throw new Error("Invalid workspace");
				const config = options.getConfig();
				if (!config || !config.deviceId || !config.credential) throw new Error("Device unavailable");
				if (!["list_bots", "list_rooms"].includes(action) && !config.allowExecution)
					throw new Error("Device execution disabled");
				signal?.throwIfAborted();
				if (action === "execution_guide") return { topic: args.topic!, guide: getExecutionGuide(args.topic!) };
				if (action === "context_metrics") return getGroupContextMetrics(context.sessionId!);
				const base = checkedUrl(config.hubUrl);
				if (!["http:", "https:"].includes(base.protocol) || base.search) throw new Error("Invalid hub URL");
				if (action === "current_task") {
					const result: Record<string, unknown> = {};
					if (bound?.taskState) result.taskState = bound.taskState;
					for (const key of [
						"roomId",
						"taskId",
						"botId",
						"conversationId",
						"sourceConversationId",
						"requestId",
						"kind",
					] as const) {
						const value = bound![key];
						if (value !== undefined) {
							if (typeof value !== "string" || !value || value.length > 256) throw new Error("Invalid task binding");
							result[key] = value;
						}
					}
					return result;
				}
				if (action === "create_room" && options.workspaceResolver) {
					workspace = await options.workspaceResolver({ roomId: "", sourceBotId: args.sourceBotId!, context, signal });
					if (resolve(context.cwd) !== resolve(workspace.root)) throw new Error("Invalid workspace");
				}
				const request = async (path: string, body?: unknown, query?: URLSearchParams) => {
					signal?.throwIfAborted();
					const url = new URL(base.href);
					url.pathname = `${url.pathname.replace(/\/$/, "")}/api/agent/${path}`;
					if (query) url.search = query.toString();
					const response = await (options.fetch ?? fetch)(url, {
						method: body === undefined ? "GET" : "POST",
						headers: {
							authorization: `Bearer ${config.credential}`,
							"X-Device-Id": config.deviceId,
							...(body === undefined ? {} : { "Content-Type": "application/json" }),
						},
						body: body === undefined ? undefined : JSON.stringify(body),
						signal,
						redirect: "error",
					});
					if (!response.ok) throw new Error("Hub request failed");
					const result: unknown = await response.json();
					signal?.throwIfAborted();
					return result;
				};
				const room = () => {
					if (!args.roomId) throw new Error("Room required");
					return `rooms/${encodeURIComponent(args.roomId)}`;
				};
				switch (action) {
					case "task_state":
					case "task_update": {
						if (!args.conversationId) throw new Error("Conversation required");
						const path = `${room()}/conversations/${encodeURIComponent(args.conversationId)}/task-state`;
						if (action === "task_state") {
							const query = new URLSearchParams({ sourceBotId: args.sourceBotId! });
							if (args.beforeSequence !== undefined) query.set("beforeSequence", String(args.beforeSequence));
							if (args.summaryOnly) query.set("summaryOnly", "true");
							return await request(path, undefined, query);
						}
						return await request(path, {
							sourceBotId: args.sourceBotId!,
							parentTaskId: bound!.taskId,
							expectedRevision: args.expectedRevision!,
							...(args.constraints !== undefined ? { constraints: args.constraints } : {}),
							...(args.progress !== undefined ? { progress: args.progress } : {}),
							...(args.blockers !== undefined ? { blockers: args.blockers } : {}),
							...(args.nextSteps !== undefined ? { nextSteps: args.nextSteps } : {}),
						});
					}
					case "task_evidence": {
						if (!args.conversationId) throw new Error("Conversation required");
						const path = `${room()}/conversations/${encodeURIComponent(args.conversationId)}/evidence`;
						const query = new URLSearchParams({ sourceBotId: args.sourceBotId! });
						if (args.taskId !== undefined) query.set("taskId", args.taskId);
						if (args.deliveryId !== undefined) query.set("deliveryId", args.deliveryId);
						if (args.offset !== undefined) query.set("offset", String(args.offset));
						if (args.limit !== undefined) query.set("limit", String(args.limit));
						if (args.expectedDigest !== undefined) query.set("expectedDigest", args.expectedDigest);
						return await request(path, undefined, query);
					}
					case "list_bots": {
						const result = (await request("bots")) as { bots?: { deviceId: string }[] };
						return { bots: result.bots?.map((bot) => ({ ...bot, local: bot.deviceId === config.deviceId })) ?? [] };
					}
					case "list_rooms":
						return await request("rooms");
					case "read_history": {
						if (
							args.before !== undefined &&
							(typeof args.before !== "string" || !args.before.trim() || args.before.length > 256)
						)
							throw new Error("Invalid history cursor");
						const query = new URLSearchParams({ sourceBotId: args.sourceBotId! });
						if (args.before !== undefined) query.set("before", args.before);
						return await request(`${room()}/history`, undefined, query);
					}
					case "create_room":
						if (!args.targetBotId) throw new Error("Target required");
						return await request("rooms", {
							name: args.name,
							sourceBotId: args.sourceBotId,
							botIds: [...new Set([args.sourceBotId, args.targetBotId])],
						});
					case "send_message":
						return await request(`${room()}/messages`, { text: args.message, sourceBotId: args.sourceBotId });
					case "send_task":
						if (!args.targetBotId) throw new Error("Target required");
						return await request(`${room()}/messages`, {
							text: args.prompt,
							sourceBotId: args.sourceBotId,
							targetBotIds: [args.targetBotId],
							idempotencyKey: randomUUID(),
							...(parentTaskId ? { parentTaskId } : {}),
						});
					case "conversation_list":
					case "conversation_read": {
						if (action === "conversation_read" && !args.conversationId) throw new Error("Conversation required");
						const suffix = action === "conversation_read" ? `/${encodeURIComponent(args.conversationId!)}` : "";
						const query = new URLSearchParams({ sourceBotId: args.sourceBotId! });
						if (action === "conversation_read" && args.before !== undefined) {
							if (typeof args.before !== "string" || !args.before.trim() || args.before.length > 256)
								throw new Error("Invalid conversation cursor");
							query.set("before", args.before);
						}
						return await request(`${room()}/conversations${suffix}`, undefined, query);
					}
					case "conversation_deliver": {
						if (
							!args.conversationId ||
							!parentTaskId ||
							!args.repository ||
							!args.baseCommit ||
							!args.commit ||
							!args.summary ||
							!Array.isArray(args.checks)
						)
							throw new Error("Delivery fields required");
						const body: DeviceDeliveryRequest = {
							sourceBotId: args.sourceBotId!,
							parentTaskId,
							idempotencyKey: args.idempotencyKey ?? randomUUID(),
							repository: args.repository,
							baseCommit: args.baseCommit,
							commit: args.commit,
							branch: args.branch,
							summary: args.summary,
							checks: args.checks,
							limitations: args.limitations ?? [],
						};
						return await request(`${room()}/conversations/${encodeURIComponent(args.conversationId)}/deliveries`, body);
					}
					case "conversation_review": {
						if (
							!args.conversationId ||
							!parentTaskId ||
							!args.deliveryId ||
							!args.commit ||
							!args.summary ||
							!args.verdict
						)
							throw new Error("Review fields required");
						const body: DeviceReviewRequest = {
							sourceBotId: args.sourceBotId!,
							parentTaskId,
							idempotencyKey: args.idempotencyKey ?? randomUUID(),
							deliveryId: args.deliveryId,
							commit: args.commit,
							verdict: args.verdict,
							summary: args.summary,
						};
						return await request(`${room()}/conversations/${encodeURIComponent(args.conversationId)}/reviews`, body);
					}
					case "conversation_attention":
						if (
							!args.conversationId ||
							!args.question ||
							!["answer", "decision"].includes(args.attentionKind ?? "") ||
							!parentTaskId
						)
							throw new Error("Attention fields required");
						return await request(`${room()}/conversations/${encodeURIComponent(args.conversationId)}/attention`, {
							sourceBotId: args.sourceBotId,
							parentTaskId,
							question: args.question,
							kind: args.attentionKind,
						});
					case "conversation_stop":
						if (!args.conversationId) throw new Error("Conversation required");
						return await request(`${room()}/conversations/${encodeURIComponent(args.conversationId)}/stop`, {
							sourceBotId: args.sourceBotId,
						});
					case "conversation_create":
						if (
							!args.targetBotId ||
							!args.prompt ||
							(args.kind !== undefined && !["message", "request"].includes(args.kind)) ||
							(args.requestId && args.kind !== "request")
						)
							throw new Error("Conversation fields required");
						return await request(`${room()}/conversations`, {
							targetBotId: args.targetBotId,
							text: args.prompt,
							...(args.kind ? { kind: args.kind } : {}),
							...(args.requestId ? { requestId: args.requestId } : {}),
							sourceBotId: args.sourceBotId,
							parentTaskId,
							idempotencyKey: args.idempotencyKey ?? randomUUID(),
						});
					case "conversation_send":
						if (
							!args.conversationId ||
							!args.message ||
							(args.kind !== undefined && !["message", "request", "reply"].includes(args.kind)) ||
							(args.kind === "reply" && !args.requestId)
						)
							throw new Error("Conversation fields required");
						return await request(`${room()}/conversations/${encodeURIComponent(args.conversationId)}/messages`, {
							text: args.message,
							sourceBotId: args.sourceBotId,
							parentTaskId,
							kind: args.kind ?? "message",
							requestId: args.requestId,
							idempotencyKey: args.idempotencyKey ?? randomUUID(),
						});
					case "sync_files": {
						if (!args.targetBotId || !args.roomId || !args.sourceBotId || !args.paths?.length)
							throw new Error("Transfer fields required");
						const files = workspace?.files ?? options.files;
						if (!files) throw new Error("File workspace unavailable");

						const transferId =
							(typeof args.transferId === "string" && args.transferId) ||
							computeStableTransferId(args.roomId, args.sourceBotId, args.targetBotId, args.paths);

						if (typeof files.prepareChunked === "function" && typeof files.readChunk === "function") {
							const manifest = await files.prepareChunked({
								paths: args.paths,
								signal,
								recursive: args.recursive,
								transferId,
							});

							const initResponse = await request("transfers", {
								action: "init",
								roomId: args.roomId,
								sourceBotId: args.sourceBotId,
								targetBotId: args.targetBotId,
								manifest,
							});

							const initSummary = summarizeTransfer(initResponse);
							const activeTransferId = initSummary.transferId as string;
							if (!activeTransferId) throw new Error("Transfer ID missing in init response");

							const receivedSet = new Set<number>(
								Array.isArray(initSummary.receivedChunks) ? initSummary.receivedChunks : [],
							);

							for (const file of manifest.files) {
								signal?.throwIfAborted();
								for (let c = 0; c < file.chunkCount; c++) {
									signal?.throwIfAborted();
									const chunkIndex = file.firstChunkIndex + c;
									if (receivedSet.has(chunkIndex)) continue; // Resume skip

									const chunkOffset = c * manifest.chunkSize;
									const chunkSize = Math.min(manifest.chunkSize, file.size - chunkOffset);

									const { buffer, sha256 } = await files.readChunk({
										path: file.path,
										offset: chunkOffset,
										size: chunkSize,
										signal,
									});

									await request("transfers", {
										action: "chunk",
										roomId: args.roomId,
										sourceBotId: args.sourceBotId,
										targetBotId: args.targetBotId,
										transferId: activeTransferId,
										chunk: {
											transferId: activeTransferId,
											chunkIndex,
											path: file.path,
											offset: chunkOffset,
											size: buffer.length,
											sha256,
											data: buffer.toString("base64"),
										},
									});
									receivedSet.add(chunkIndex);
								}
							}

							const previewResponse = await request("transfers", {
								action: "preview",
								roomId: args.roomId,
								sourceBotId: args.sourceBotId,
								targetBotId: args.targetBotId,
								transferId: activeTransferId,
							});

							return {
								...summarizeTransfer(previewResponse),
								transferId: activeTransferId,
								status: "staged",
								totalFiles: manifest.totalFiles,
								totalBytes: manifest.totalBytes,
								totalChunks: manifest.totalChunks,
								...(manifest.exclusions
									? { exclusions: manifest.exclusions, totalExcluded: manifest.totalExcluded }
									: {}),
							};
						}

						const bundle = await files.prepare({ paths: args.paths, signal, recursive: args.recursive });
						const response = await request("transfers", {
							action: "stage",
							roomId: args.roomId,
							sourceBotId: args.sourceBotId,
							targetBotId: args.targetBotId,
							bundle,
						});
						return {
							...summarizeTransfer(response),
							...(bundle.manifest.exclusions
								? { exclusions: bundle.manifest.exclusions, totalExcluded: bundle.manifest.totalExcluded }
								: {}),
						};
					}
					case "transfer_status":
					case "transfer_abort": {
						if (!args.roomId || !args.targetBotId || !args.transferId) throw new Error("Transfer fields required");
						return summarizeTransfer(
							await request("transfers", {
								action: action === "transfer_status" ? "status" : "abort",
								roomId: args.roomId,
								sourceBotId: args.sourceBotId,
								targetBotId: args.targetBotId,
								transferId: args.transferId,
							}),
						);
					}
					case "transfer_preview":
					case "transfer_apply": {
						if (!args.roomId || !args.targetBotId || !args.transferId) throw new Error("Transfer fields required");
						if (action === "transfer_apply" && (!args.revision || !Array.isArray(args.overwritePaths)))
							throw new Error("Explicit apply required");
						return summarizeTransfer(
							await request("transfers", {
								action: action === "transfer_apply" ? "apply" : "preview",
								roomId: args.roomId,
								sourceBotId: args.sourceBotId,
								targetBotId: args.targetBotId,
								transferId: args.transferId,
								...(action === "transfer_apply"
									? { revision: args.revision, overwritePaths: args.overwritePaths }
									: {}),
							}),
						);
					}
					default:
						throw new Error("Unsupported collaboration action");
				}
			} catch {
				// Remote errors, URLs, fetch errors and local file errors may contain secrets.
				throw new Error(signal?.aborted ? "Device collaboration cancelled." : "Device collaboration request failed.");
			} finally {
				workspace?.release();
			}
		},
	};
}
export interface TransferSummaryResult {
	transferId?: string;
	status?: string;
	revision?: string;
	version?: number | string;
	totalBytes?: number;
	totalFiles?: number;
	totalChunks?: number;
	transferredBytes?: number;
	completedFiles?: number;
	receivedChunks?: number[];
	chunkIndex?: number;
	received?: boolean;
	percent?: number;
	truncated?: boolean;
	applied?: string[];
	unchanged?: string[];
	files?: Record<string, unknown>[];
	rejected?: Record<string, unknown>[];
	exclusions?: { path: string; reason: "ignored" | "sensitive" }[];
	totalExcluded?: number;
	manifest?: Record<string, unknown>;
	preview?: Record<string, unknown>;
	[key: string]: unknown;
}

function summarizeTransfer(value: unknown): TransferSummaryResult {
	const id = value && typeof value === "object" ? (value as { transferId?: unknown }).transferId : undefined;
	return {
		...(transferSummary(value) as TransferSummaryResult),
		...(typeof id === "string" ? { transferId: id } : {}),
	};
}

function computeStableTransferId(roomId: string, sourceBotId: string, targetBotId: string, paths: string[]): string {
	const raw = `${roomId}:${sourceBotId}:${targetBotId}:${[...paths].sort().join(",")}`;
	const h = createHash("sha256").update(raw).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
