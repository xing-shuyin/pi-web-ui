import { join, resolve } from "node:path";
import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { MobileNotificationCallback } from "./mobile-notification-events.js";
import { VERSION, getAgentDir, ModelRuntime, type AgentSession } from "@earendil-works/pi-coding-agent";
import { ClientStateStore } from "./client-state.js";
import { ClaimStore } from "./claim-store.js";
import { isBotExecutionRegistered } from "./device-center/bot-execution.js";
import { toServiceInfo, launchOrigin } from "./launch-origin.js";
import {
	isPseudoClientId,
	isDeviceTaskClientId,
	isOrphanAdoptionExcludedClientId,
	checkPluginCwd,
} from "./client-id-utils.js";
const isSharedExecutionClientId = (id: string) => isPseudoClientId(id) || isDeviceTaskClientId(id);
import { pickAdoptableOrphan, type OrphanCandidate } from "./orphan-manager.js";
import { findMostRecentSessionFileFast } from "./session-parser.js";
import { isRemoteWorkspaceUri, resolveWorkspaceSessionDir } from "./remote-ssh-service.js";
import { getMaxOpenConversations } from "./agent-formatters.js";
import { collectSubagentDescendantIds } from "./subagents.js";
import { pickLatestClientSnapshot } from "./plugin-conversation-view.js";
import { normalizePluginChatAttachments } from "./plugin-chat-attachments.js";
import type { ToolGuardHook } from "./tool-guards.js";
import type {
	ServerMessage,
	ClientMessage,
	UiServiceInfo,
	QuestionAnswer,
	ElsewhereRunning,
	BgServer,
	AgentEngineCapabilities,
} from "./protocol.js";
import { DEFAULT_PI_CAPABILITIES } from "./engine-capabilities.js";
import type {
	PluginToolEvent,
	PluginRunEvent,
	PluginConversationSnapshot,
	PluginAgentTool,
	PluginCommandDef,
	PluginConversationQuery,
	PluginChatRequest,
	PluginChatResult,
} from "./plugins.js";
import type { SchedulerStore } from "./scheduler-tasks.js";
import {
	ClientSession,
	QuiesceRejectedError,
	OFFLINE_ROW_TTL_MS,
	type Conversation,
	type SessionOwnerInfo,
	type ProjectRunnerInfo,
	type TakeoverPayload,
} from "./agent-service.js";

export class AgentService {
	static isPseudoClientId = isPseudoClientId;
	private sharedViewers = new Map<
		string,
		{
			owner: ClientSession;
			conversation: Conversation;
			ownerClientId: string;
			conversationId: string;
			readOnly: boolean;
			close: () => void;
			send: (message: ServerMessage) => void;
		}
	>();

	openSharedConversation(
		viewerClientId: string,
		ownerClientId: string,
		convId: string,
		send: (message: ServerMessage) => void,
		options: { readOnly?: boolean } = {},
	): boolean {
		const viewer = this.clients.get(viewerClientId);
		const owner = this.clients.get(ownerClientId);
		const conversation = owner?.getConversation(convId);
		const isScheduler = ownerClientId.startsWith("scheduler:");
		if (
			!viewer ||
			!owner ||
			!conversation ||
			(!options.readOnly && ((conversation.independent !== false && !isScheduler) || conversation.isSubagent))
		)
			return false;
		this.closeSharedConversation(viewerClientId);
		const binding = {
			owner,
			conversation,
			ownerClientId,
			conversationId: convId,
			readOnly: options.readOnly === true,
			close: () => {},
			send,
		};
		this.sharedViewers.set(viewerClientId, binding);
		this.subscribeSharedConversation(viewerClientId, binding);
		return true;
	}

	private subscribeSharedConversation(
		viewerClientId: string,
		binding: NonNullable<ReturnType<AgentService["sharedConversationTarget"]>>,
	): void {
		const { owner, conversation, ownerClientId, conversationId: convId, send } = binding;
		binding.close = owner.subscribeConversation(conversation, (message) => {
			if (this.sharedConversationTarget(viewerClientId) !== binding) return;
			if (message.type === "snapshot")
				send({
					...message,
					state: {
						...message.state,
						clientId: viewerClientId,
						sharedConversation: {
							owner: ownerClientId,
							conversationId: convId,
							...(binding.readOnly ? { readOnly: true } : {}),
						},
					},
				});
			else if (message.type === "snapshot_delta")
				send({
					...message,
					state: {
						...message.state,
						clientId: viewerClientId,
						sharedConversation: {
							owner: ownerClientId,
							conversationId: convId,
							...(binding.readOnly ? { readOnly: true } : {}),
						},
					},
				});
			else send(message);
		});
	}

	private resumeSharedConversation(viewerClientId: string, send: (message: ServerMessage) => void): void {
		const binding = this.sharedConversationTarget(viewerClientId);
		if (!binding) return;
		binding.close();
		binding.send = send;
		this.subscribeSharedConversation(viewerClientId, binding);
	}

	private releaseSharedClient(client: ClientSession): void {
		for (const [viewerId, binding] of this.sharedViewers) {
			if (binding.owner === client || this.clients.get(viewerId) === client) this.closeSharedConversation(viewerId);
		}
		const relay = this.sharedInteractionSinks.get(client);
		if (relay) {
			client.detachSink(relay);
			this.sharedInteractionSinks.delete(client);
			const interactions = this.globalInteractions(client);
			for (const [id, viewer] of this.clients) {
				if (viewer !== client && !isSharedExecutionClientId(id)) viewer.emitSharedInteraction(interactions);
			}
		}
	}

	closeSharedConversation(viewerClientId: string): void {
		const binding = this.sharedViewers.get(viewerClientId);
		this.sharedViewers.delete(viewerClientId);
		binding?.close();
	}

	sharedConversationTarget(viewerClientId: string) {
		const binding = this.sharedViewers.get(viewerClientId);
		if (
			binding &&
			this.clients.get(binding.ownerClientId) === binding.owner &&
			binding.owner.getConversation(binding.conversationId) === binding.conversation &&
			(binding.readOnly || binding.conversation.independent === false || binding.ownerClientId.startsWith("scheduler:"))
		)
			return binding;
		if (binding) this.closeSharedConversation(viewerClientId);
		return undefined;
	}

	dispatchSharedConversationMessage(viewerClientId: string, message: ClientMessage): boolean {
		if (
			"ownerKind" in message &&
			message.ownerKind === "client" &&
			[
				"terminal_create",
				"terminal_attach",
				"terminal_input",
				"terminal_cli_paste",
				"terminal_resize",
				"terminal_kill",
				"rename_terminal",
			].includes(message.type)
		)
			return false;
		const binding = this.sharedConversationTarget(viewerClientId);
		if (!binding) return false;
		if (
			[
				"new_chat",
				"new_cli_chat",
				"switch_session",
				"switch_conversation",
				"set_cwd",
				"resume_session",
				"close_shared_conversation",
			].includes(message.type)
		) {
			this.closeSharedConversation(viewerClientId);
			return false;
		}
		const { owner, conversation: conv, send } = binding;
		const fail = (error: unknown) => {
			try {
				send({ type: "notice", level: "error", text: String(error), textEn: String(error) });
			} catch {}
		};
		const run = (action: () => unknown): true => {
			try {
				void Promise.resolve(action()).catch(fail);
			} catch (error) {
				fail(error);
			}
			return true;
		};
		const reject = () =>
			run(() => {
				throw new Error(`Shared conversation operation unavailable: ${message.type}`);
			});
		if (
			binding.readOnly &&
			![
				"get_state",
				"list_files",
				"read_file",
				"search_files",
				"complete_path",
				"scm_status",
				"scm_history",
				"scm_filediff",
				"scm_commit",
				"get_compacted_messages",
				"question_answer",
				"tool_approval_response",
			].includes(message.type)
		)
			return reject();
		if (binding.readOnly && "owner" in message && message.owner && message.owner !== binding.ownerClientId)
			return reject();
		const fileBinding = binding as typeof binding & { files?: ReturnType<ClientSession["createConversationFiles"]> };
		const files = () => {
			if (!fileBinding.files) {
				const service = owner.createConversationFiles(conv, send);
				const close = binding.close;
				binding.close = () => {
					service.unwatchDir();
					service.unwatchGit();
					close();
				};
				fileBinding.files = service;
			}
			return fileBinding.files;
		};
		switch (message.type) {
			case "run_command":
				if (message.conversationId && message.conversationId !== conv.id) return reject();
				return run(() => {
					const tm = owner.getTerminalManager(conv.id);
					if (!tm) throw new Error("Conversation terminal unavailable");
					return tm.runCommand(message.terminalId, message.command, message.cols, message.rows, conv.cwd);
				});
			case "file_open_default":
				return run(() => files().openDefaultEntry(message.path));
			case "make_dir":
				if (message.setAsCwd) return reject();
				return run(() => files().makeDir(message.path));
			case "dsh_preset_select":
			case "dsh_permission_set":
			case "set_workspace_roots":
			case "extensions_reload":
			case "list_commands":
			case "save_commands":
			case "get_commands":
			case "get_tool_info":
			case "get_tool_prompt":
				return reject();
			case "list_files":
				return run(() => files().listFiles(message.path));
			case "read_file":
				return run(() => files().readFile(message.path));
			case "write_file":
				return run(() => files().writeFile(message.path, message.text));
			case "upload_file":
				return run(() =>
					owner
						.createConversationFiles(conv, send)
						.uploadFile(message.dirPath, message.name, message.data, message.uploadId),
				);
			case "search_files":
				return run(() => owner.createConversationFiles(conv, send).searchFiles(message.query, message.reqId));
			case "complete_path":
				return run(() => files().completePath(message.path));
			case "file_create":
				return run(() => files().createEntry(message.dir, message.name, message.kind));
			case "file_rename":
				return run(() => files().renameEntry(message.path, message.newName));
			case "file_delete":
				return run(() => files().deleteEntry(message.path));
			case "file_copy":
				return run(() => files().copyEntry(message.src, message.destDir, message.move));
			case "file_reveal":
				return run(() => files().revealEntry(message.path));
			case "scm_status":
				return run(() => files().scmQuery("status", message.reqId));
			case "scm_history":
				return run(() => files().scmQuery("history", message.reqId));
			case "scm_filediff":
				return run(() => files().scmQuery("filediff", message.reqId, { path: message.path }));
			case "scm_commit":
				return run(() => files().scmQuery("commit", message.reqId, { hash: message.hash }));
			case "scm_commitmsg":
				return run(() => owner.scmGenCommitMessage(message.reqId, conv, send));
			case "terminal_cli_control": {
				if (
					message.conversationId !== conv.id ||
					message.ownerKind !== "conversation" ||
					conv.nativeCli?.terminalId !== message.terminalId ||
					typeof message.requestId !== "string" ||
					!message.requestId ||
					message.requestId.length > 128 ||
					/[\x00-\x1f\x7f-\x9f]/.test(message.requestId) ||
					!["detach", "reconnect", "stop"].includes(message.action)
				)
					return reject();
				return run(async () => {
					try {
						await owner.controlNativeCli(conv.id, message.terminalId, message.action);
						send({
							type: "terminal_cli_control_result",
							requestId: message.requestId,
							terminalId: message.terminalId,
							conversationId: message.conversationId,
							ok: true,
						});
					} catch (error) {
						send({
							type: "terminal_cli_control_result",
							requestId: message.requestId,
							terminalId: message.terminalId,
							conversationId: message.conversationId,
							ok: false,
							error: (error as Error).message,
						});
					}
				});
			}
			case "terminal_create":
			case "terminal_attach":
			case "terminal_input":
			case "terminal_resize":
			case "terminal_kill":
			case "rename_terminal": {
				if (message.conversationId && message.conversationId !== conv.id) return reject();
				const tm = owner.getTerminalManager(conv.id);
				if (
					!tm ||
					(message.type !== "terminal_create" && (message.ownerKind === "client" || !tm.has(message.terminalId)))
				)
					return reject();
				return run(() => {
					switch (message.type) {
						case "terminal_create":
							if (conv.nativeCli?.terminalId === message.terminalId)
								return owner.controlNativeCli(conv.id, message.terminalId, "reconnect");
							return tm.create(message.terminalId, message.cwd, message.cols, message.rows, conv.cwd, message.title, {
								locale: message.locale,
								agentBash: message.agentBash,
							});
						case "terminal_attach":
							return tm.attach(message.terminalId, message.cols, message.rows);
						case "terminal_input":
							return tm.input(message.terminalId, message.data);
						case "terminal_resize":
							return tm.resize(message.terminalId, message.cols, message.rows);
						case "terminal_kill":
							return tm.kill(message.terminalId);
						case "rename_terminal":
							return tm.rename(message.terminalId, message.title);
					}
				});
			}
			case "set_goal":
				return run(() =>
					owner.setGoal(
						message.goal,
						{
							reviewModel: message.reviewModel,
							maxRounds: message.maxRounds,
							locked: message.locked,
							execModel: message.execModel,
						},
						conv,
					),
				);
			case "clear_goal":
				return run(() => owner.clearGoal(conv));
			case "start_goal_wizard":
				return run(() =>
					owner.startGoalWizard(
						message.text,
						{ wizardModel: message.wizardModel, maxRounds: message.maxRounds, locked: message.locked },
						conv,
					),
				);
			case "set_goal_prefs":
				return run(() => owner.setGoalPrefs(message, conv));
			case "apply_preset":
				return run(() => owner.applyPreset(message.name, conv));
			case "persist_conversation":
				return message.id === conv.id ? run(() => owner.persistConversation(conv.id)) : reject();
			case "dismiss_conversation":
				return message.id === conv.id
					? run(() => owner.dismissConversation(conv.id, message.withFinishedSubagents, message.force))
					: reject();
			case "page_response":
				return run(() => owner.resolvePageCall(message.id, message.ok, message.result, message.error, conv.id));
			case "dialog_response":
			case "tui_overlay_input":
			case "tui_overlay_resize":
			case "tui_overlay_cancel":
				return reject();
			case "set_approval_policy":
				return !message.conversationId || message.conversationId === conv.id
					? run(() => owner.setApprovalPolicy({ ...message, conversationId: conv.id }))
					: reject();
		}
		if (message.type === "get_state") {
			this.openSharedConversation(viewerClientId, binding.ownerClientId, conv.id, send, { readOnly: binding.readOnly });
			return true;
		}
		if (message.type === "prompt") {
			if (message.targetConversationId && message.targetConversationId !== conv.id) return reject();
			return run(() => owner.prompt(message.text, message.attachments, message.queue, conv));
		}
		if (message.type === "abort") {
			return run(() => owner.abortConversation(conv));
		}
		if (message.type === "set_model") {
			return run(() => owner.setModel(message.modelId, conv));
		}
		if (message.type === "set_thinking") {
			owner.setThinking(message.level, conv);
			return true;
		}
		switch (message.type) {
			case "abort_bash":
				return run(() => owner.abortBash(conv.id));
			case "rename_conversation":
				return run(() => owner.renameConversation(conv.id, message.name));
			case "pin_conversation":
				return run(() => owner.setConversationPinned(conv.id, message.pinned));
			case "get_compacted_messages":
				return run(() => owner.getCompactedMessages(message.compactionMessageId, conv.id, send));
			case "plan_update":
				return run(() => owner.updatePlan(message.steps, message.activeStepId, conv.id));
			case "plan_step_update":
				return run(() => owner.updatePlanStep(message.stepId, message.patch, conv.id));
			case "plan_step_delete":
				return run(() => owner.deletePlanStep(message.stepId, conv.id));
			case "plan_step_add":
				return run(() => owner.addPlanStep(message.step, message.afterStepId, conv.id));
			case "set_plan_mode":
				return run(() => owner.setPlanMode(message.enabled, conv.id));
			case "set_delegate_mode":
				return run(() => owner.setDelegateMode(message.enabled, conv.id));
			case "fork_session":
				return run(() => owner.forkSession(message.messageId, message.position, conv.id));
			case "rollback_session":
				return run(() => owner.rollbackSession(message.messageId, conv.id, message.restoreWorkspace));
			case "delete_message":
				return run(() => owner.deleteMessage(message.messageId, conv.id));
			case "edit_message":
				return run(() => owner.editMessage(message.messageId, message.text, message.attachments, conv));
			case "retry_last":
				return run(() => owner.retryLast(conv));
			case "queue_remove":
				return run(() => owner.removeQueued(message.kind, message.text, message.index, message.id, conv));
			case "draft_update":
				return run(() => owner.saveDraft(message.sessionId, message.text, message.ts, conv));
			case "dismiss_finished_subagents":
				return !message.parentId || message.parentId === conv.id
					? run(() => owner.dismissFinishedSubagents(conv.id))
					: reject();
			case "plan_clean_handoff":
				send({
					type: "notice",
					level: "warning",
					text: "该操作暂不支持在共享对话中执行",
					textEn: "This operation is not yet supported in shared conversations.",
				});
				return true;
			default:
				return false;
		}
	}

	async dismissConversation(
		requesterClientId: string,
		msg: { id: string; withFinishedSubagents?: boolean; force?: boolean; owner?: string },
	): Promise<boolean> {
		const requester = this.clients.get(requesterClientId);
		if (requester?.getConversation(msg.id)) {
			await requester.dismissConversation(msg.id, msg.withFinishedSubagents, msg.force);
			return true;
		}

		let ownerId = msg.owner;
		let owner = ownerId ? this.clients.get(ownerId) : undefined;
		let conv = owner?.getConversation(msg.id);

		if (!owner || !conv) {
			for (const [cid, c] of this.clients) {
				const found = c.getConversation(msg.id);
				if (found) {
					ownerId = cid;
					owner = c;
					conv = found;
					break;
				}
			}
		}

		if (!owner || !conv || !ownerId) {
			requester?.sendNotice({
				type: "notice",
				level: "warning",
				text: "该对话不存在或已关闭",
				textEn: "This conversation does not exist or is already closed",
			});
			return false;
		}

		const isSharedExecution = isSharedExecutionClientId(ownerId);
		const isOffline = owner.sinkCount() === 0;

		if (isSharedExecution || isOffline) {
			if (owner.conversationStreaming(conv) && !msg.force) {
				requester?.sendNotice({
					type: "notice",
					level: "warning",
					text: `对话「${conv.title}」仍在运行中，请先等待结束或点击强行关闭`,
					textEn: `Conversation "${conv.title}" is still running. Wait for it to finish or force dismiss.`,
				});
				return false;
			}
			if (owner.conversationStreaming(conv)) {
				await owner.abortConversation(conv);
			}
			for (const [viewerId, binding] of this.sharedViewers) {
				if (binding.owner === owner || binding.ownerClientId === ownerId) {
					this.closeSharedConversation(viewerId);
				}
			}
			this.clients.delete(ownerId);
			await owner.dispose().catch(() => {});
			this.pokeExternalRunning(ownerId);
			requester?.sendNotice({
				type: "notice",
				level: "info",
				text: `已关闭并移出对话「${conv.title}」`,
				textEn: `Closed and dismissed conversation "${conv.title}"`,
			});
			return true;
		}

		await owner.dismissConversation(conv.id, msg.withFinishedSubagents, msg.force);
		this.pokeExternalRunning(ownerId);
		return true;
	}

	private offlineSince = new Map<string, number>();
	private offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
	onToolEvent: ((ev: PluginToolEvent) => void) | undefined = undefined;
	toolGuard: ToolGuardHook | undefined = undefined;
	onRunEvent: ((ev: PluginRunEvent) => void) | undefined = undefined;
	onNotificationEvent: MobileNotificationCallback | undefined = undefined;
	onConversationChanged: (() => void) | undefined = undefined;
	onClientModelChanged: ((snap: PluginConversationSnapshot) => void) | undefined = undefined;
	pluginToolsProvider: ((cwd?: string) => PluginAgentTool[]) | undefined = undefined;
	pluginCommandsProvider: (() => PluginCommandDef[]) | undefined = undefined;
	pluginBgTasksProvider: (() => BgServer[]) | undefined = undefined;
	pluginStopBgTask: ((taskId: string) => boolean) | undefined = undefined;
	schedulerStore: SchedulerStore | undefined = undefined;
	private clients = new Map<string, ClientSession>();
	private sharedInteractionSinks = new WeakMap<ClientSession, (msg: ServerMessage) => void>();

	private globalInteractions(excludeOwner?: ClientSession): Extract<ServerMessage, { type: "global_interactions" }> {
		const questions: Extract<ServerMessage, { type: "global_interactions" }>["questions"] = [];
		const approvals: Extract<ServerMessage, { type: "global_interactions" }>["approvals"] = [];
		for (const [ownerId, owner] of this.clients) {
			if (owner === excludeOwner || !isSharedExecutionClientId(ownerId)) continue;
			for (const pending of owner.sharedPendingMessages()) {
				if (pending.type === "question_pending") questions.push({ ...pending, owner: ownerId, global: true });
				if (pending.type === "tool_approval_pending") approvals.push({ ...pending, owner: ownerId, global: true });
			}
		}
		return { type: "global_interactions", questions, approvals };
	}
	private claimStore: ClaimStore;
	private quiesced = false;
	private quiescedAt = 0;
	private socketCount = 0;
	private pending = new Map<string, Promise<ClientSession>>();
	private pendingDetaches = new Map<string, Set<(msg: ServerMessage) => void>>();
	private stateStore: ClientStateStore;
	onQuit: (() => boolean) | undefined = undefined;
	onClientCwdChanged: ((cwd: string, roots: string[]) => void) | undefined = undefined;

	constructor(
		private cwd: string,
		stateFile: string | ClientStateStore,
	) {
		this.stateStore = typeof stateFile === "string" ? new ClientStateStore(stateFile) : stateFile;
		this.claimStore = new ClaimStore(join(this.stateStore.dataDir, "claims.json"));
	}

	private groupRouterModelRuntime: Promise<ModelRuntime> | undefined;

	async getGroupRouterModelRuntime(signal: AbortSignal): Promise<ModelRuntime> {
		signal.throwIfAborted();
		if (!this.groupRouterModelRuntime) {
			const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
			this.groupRouterModelRuntime = ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: join(agentDir, "models.json"),
			}).catch((error) => {
				this.groupRouterModelRuntime = undefined;
				throw error;
			});
		}
		const runtime = await this.groupRouterModelRuntime;
		signal.throwIfAborted();
		return runtime;
	}

	async listGroupRouterModels(signal: AbortSignal): Promise<import("./protocol.js").ModelInfo[]> {
		signal.throwIfAborted();
		const runtime = await this.getGroupRouterModelRuntime(signal);
		await runtime.refresh({ allowNetwork: false, signal });
		const models = await runtime.getAvailable(undefined, { signal });
		return models.map((model) => ({
			id: `${model.provider}/${model.id}`,
			name: model.name,
			provider: model.provider,
			reasoning: model.reasoning,
			vision: model.input?.includes("image") ?? false,
		}));
	}

	isQuiesced(): boolean {
		return this.quiesced;
	}

	quiesce(): void {
		this.quiesced = true;
		this.quiescedAt = Date.now();
	}

	unquiesce(): void {
		this.quiesced = false;
		this.quiescedAt = 0;
	}

	quiesceInfo(): { quiesced: boolean; quiescedSince?: number } {
		return this.quiesced ? { quiesced: true, quiescedSince: this.quiescedAt } : { quiesced: false };
	}

	hasStreamingElsewhere(excludeClientId: string): boolean {
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			try {
				if (cs.activeConversations() > 0) return true;
			} catch {}
		}
		return false;
	}

	async prepareBotSessionResume(targetPath: string, excludeClientId: string): Promise<void> {
		for (const [ownerId, owner] of this.clients) {
			if (ownerId === excludeClientId || !ownerId.startsWith("device-task-") || isBotExecutionRegistered(ownerId))
				continue;
			const conv = owner.findConversationBySessionFile(targetPath);
			if (!conv || owner.conversationStreaming(conv)) continue;
			this.clients.delete(ownerId);
			await owner.dispose();
		}
	}

	findSessionOwner(targetPath: string, excludeClientId: string): SessionOwnerInfo | null {
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			const conv = cs.findConversationBySessionFile(targetPath);
			if (conv) {
				return {
					clientId,
					convId: conv.id,
					title: conv.title,
					cwd: conv.cwd,
					isStreaming: cs.conversationStreaming(conv),
					connected: cs.sinkCount() > 0,
				};
			}
		}
		return null;
	}

	async steerElsewhere(
		excludeClientId: string,
		id: string,
		text: string,
	): Promise<{ ok: boolean; error?: string } | undefined> {
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			try {
				const r = await cs.steerOwnConversation(id, text);
				if (r) return r;
			} catch {}
		}
		return undefined;
	}

	async wakeConversation(
		id: string,
		text: string,
		opts?: { sessionFile?: string; cwd?: string },
	): Promise<{
		ok: boolean;
		conversationId?: string;
		sessionFile?: string;
		clientId?: string;
		busy?: boolean;
		error?: string;
	}> {
		const wantFile = String(opts?.sessionFile ?? "").trim();
		const wantCwd = String(opts?.cwd ?? "").trim();
		if ((!id && !wantFile) || !text.trim()) return { ok: false, error: "唤醒目标或文本为空" };
		if (this.quiesced) return { ok: false, error: "服务器正忙（quiesced），请稍后重试" };
		const liveFile = (c: Conversation): string => {
			try {
				return String(c.session.sessionFile ?? "");
			} catch {
				return "";
			}
		};
		const flush = (cs: ClientSession): void => {
			try {
				cs.flushSnapshot();
			} catch {}
		};
		if (wantFile) {
			const hits: { cs: ClientSession; clientId: string; conv: Conversation }[] = [];
			for (const [clientId, cs] of this.clients) {
				try {
					const conv = cs.resolveSchedulerTarget({ sessionFile: wantFile });
					if (conv) hits.push({ cs, clientId, conv });
				} catch {}
			}
			hits.sort((a, b) => b.conv.lastActiveAt - a.conv.lastActiveAt);
			let busyError: string | undefined;
			for (const h of hits) {
				try {
					const r = await h.cs.trySteerScheduler(h.conv, text);
					if (r.ok) {
						flush(h.cs);
						return { ok: true, conversationId: h.conv.id, sessionFile: liveFile(h.conv), clientId: h.clientId };
					}
					if (r.busy) busyError = r.error;
				} catch {}
			}
			if (hits.length > 0) {
				if (busyError) return { ok: false, busy: true, error: busyError };
				return { ok: false, error: "目标对话投递失败（持有方异常）" };
			}
		}
		if (id) {
			const hits: { cs: ClientSession; clientId: string; conv: Conversation }[] = [];
			for (const [clientId, cs] of this.clients) {
				try {
					const conv = cs.resolveSchedulerTarget({
						conversationId: id,
						...(wantCwd ? { cwd: wantCwd } : {}),
					});
					if (conv) hits.push({ cs, clientId, conv });
				} catch {}
			}
			hits.sort((a, b) => b.conv.lastActiveAt - a.conv.lastActiveAt);
			let busyError: string | undefined;
			for (const h of hits) {
				try {
					const r = await h.cs.trySteerScheduler(h.conv, text);
					if (r.ok) {
						flush(h.cs);
						return { ok: true, conversationId: h.conv.id, sessionFile: liveFile(h.conv), clientId: h.clientId };
					}
					if (r.busy) busyError = r.error;
				} catch {}
			}
			if (busyError) return { ok: false, busy: true, error: busyError };
		}
		return { ok: false, error: "目标对话不在运行中（已关闭或服务重启过）" };
	}

	resolveSharedQuestion(
		viewerId: string,
		id: string,
		answers: QuestionAnswer[],
		cancelled?: boolean,
		cancelReason?: string,
	): boolean {
		if (!this.clients.has(viewerId) || isSharedExecutionClientId(viewerId)) return false;
		const shared = this.sharedConversationTarget(viewerId);
		if (
			shared?.owner
				.sharedPendingMessages()
				.some(
					(pending) =>
						pending.type === "question_pending" &&
						pending.id === id &&
						pending.conversationId === shared.conversationId,
				)
		) {
			return shared.owner.resolveQuestion(id, answers, cancelled, cancelReason);
		}
		for (const [ownerId, owner] of this.clients) {
			if (isSharedExecutionClientId(ownerId) && owner.resolveQuestion(id, answers, cancelled, cancelReason))
				return true;
		}
		return false;
	}

	resolveGlobalQuestion(id: string, answers: QuestionAnswer[], cancelled?: boolean, cancelReason?: string): boolean {
		for (const client of this.clients.values()) {
			if (client.resolveQuestion(id, answers, cancelled, cancelReason)) {
				return true;
			}
		}
		return false;
	}

	resolveSharedToolApproval(viewerId: string, ...args: Parameters<ClientSession["resolveToolApproval"]>): boolean {
		if (!this.clients.has(viewerId) || isSharedExecutionClientId(viewerId)) return false;
		const shared = this.sharedConversationTarget(viewerId);
		if (
			shared?.owner
				.sharedPendingMessages()
				.some(
					(pending) =>
						pending.type === "tool_approval_pending" &&
						pending.id === args[0] &&
						pending.conversationId === shared.conversationId,
				)
		) {
			shared.owner.resolveToolApproval(...args);
			return true;
		}
		for (const [ownerId, owner] of this.clients) {
			if (!isSharedExecutionClientId(ownerId)) continue;
			if (!owner.sharedPendingMessages().some((msg) => msg.type === "tool_approval_pending" && msg.id === args[0]))
				continue;
			owner.resolveToolApproval(...args);
			return true;
		}
		return false;
	}

	async wakeViewportInCwd(
		cwd: string,
		text: string,
		excludeIds?: Set<string>,
	): Promise<{
		ok: boolean;
		conversationId?: string;
		sessionFile?: string;
		clientId?: string;
		busy?: boolean;
		error?: string;
	}> {
		const want = String(cwd ?? "").trim();
		if (!want || !text.trim()) return { ok: false, error: "回退目标或文本为空" };
		if (this.quiesced) return { ok: false, error: "服务器正忙（quiesced），请稍后重试" };
		const cands: { cs: ClientSession; clientId: string; conv: Conversation }[] = [];
		for (const [clientId, cs] of this.clients) {
			try {
				const conv = cs.findViewportInCwd(want, excludeIds);
				if (conv) cands.push({ cs, clientId, conv });
			} catch {}
		}
		cands.sort((a, b) => b.conv.lastActiveAt - a.conv.lastActiveAt);
		if (cands.length === 0) return { ok: false, error: "同项目无存活对话" };
		let busyError: string | undefined;
		for (const c of cands) {
			try {
				const r = await c.cs.trySteerScheduler(c.conv, text);
				if (r.ok) {
					try {
						c.cs.flushSnapshot();
					} catch {}
					let f = "";
					try {
						f = String(c.conv.session.sessionFile ?? "");
					} catch {
						f = "";
					}
					return { ok: true, conversationId: c.conv.id, sessionFile: f, clientId: c.clientId };
				}
				if (r.busy) busyError = r.error;
			} catch {}
		}
		if (busyError) return { ok: false, busy: true, error: busyError };
		return { ok: false, error: "同项目对话投递失败" };
	}

	listProjectRunners(cwd: string, excludeClientId: string): ProjectRunnerInfo[] {
		const out: ProjectRunnerInfo[] = [];
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			for (const r of cs.streamingInCwd(cwd)) out.push({ clientId, title: r.title, sessionFile: r.sessionFile });
		}
		return out;
	}

	findConversationHome(sdkSession: AgentSession): { session: ClientSession; convId: string } | undefined {
		for (const cs of this.clients.values()) {
			try {
				const convId = cs.conversationIdOfSession(sdkSession);
				if (convId) return { session: cs, convId };
			} catch {}
		}
		return undefined;
	}

	findSubagentOwner(convId: string): { session: ClientSession; convId: string } | undefined {
		// Local cN ids are not global addresses. Never let a transfer alias or
		const matches: { session: ClientSession; convId: string }[] = [];
		for (const cs of this.clients.values()) {
			const current = cs.resolveExecutionAddress(convId);
			if (current) matches.push({ session: cs, convId: current });
		}
		return matches.length === 1 ? matches[0] : undefined;
	}

	listExternalRunning(excludeClientId: string): ElsewhereRunning[] {
		const currentCs = this.clients.get(excludeClientId);
		const localFiles = new Set<string>();
		const localCwdTitles = new Set<string>();
		if (currentCs) {
			for (const b of currentCs.takeoverBriefs()) {
				if (b.sessionFile) localFiles.add(resolve(b.sessionFile));
				localCwdTitles.add(`${b.cwd}\0${b.title}`);
			}
		}

		const dedupMap = new Map<string, ElsewhereRunning>();
		const now = Date.now();

		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			const isPseudo = isSharedExecutionClientId(clientId);
			const offline = !isPseudo && cs.sinkCount() === 0;
			if (offline && OFFLINE_ROW_TTL_MS <= 0) continue;
			const offlineSince = offline ? (this.offlineSince.get(clientId) ?? 0) : 0;

			for (const r of cs.streamingSummariesAll()) {
				const { activity, ...rest } = r;
				if (offline && !rest.isStreaming) {
					const latest = Math.max(offlineSince, activity || 0);
					if (latest > 0 && now - latest > OFFLINE_ROW_TTL_MS) continue;
				}
				const normFile = rest.sessionFile ? resolve(rest.sessionFile) : undefined;
				if (normFile && localFiles.has(normFile)) continue;
				if (rest.independent !== false && localCwdTitles.has(`${rest.cwd}\0${rest.title}`)) continue;

				const entry: ElsewhereRunning = {
					...rest,
					owner: clientId,
					...(isPseudo ? { pseudo: true as const } : {}),
					...(offline ? { ownerOffline: true as const } : {}),
				};

				const dedupKey = normFile
					? `file:${normFile}`
					: rest.independent === false
						? `shared:${JSON.stringify([clientId, rest.convId])}`
						: `title:${rest.cwd}\0${rest.title}`;
				const existing = dedupMap.get(dedupKey);
				if (existing) {
					const preferNew =
						(!existing.isStreaming && entry.isStreaming) ||
						(!existing.hasQuestion && entry.hasQuestion) ||
						(Boolean(existing.ownerOffline) && !entry.ownerOffline);
					if (preferNew) {
						dedupMap.set(dedupKey, entry);
					}
					continue;
				}
				dedupMap.set(dedupKey, entry);
			}
		}

		return [...dedupMap.values()];
	}

	private armOfflineRowExpiry(clientId: string, cs: ClientSession): void {
		if (OFFLINE_ROW_TTL_MS <= 0) return;
		const prev = this.offlineTimers.get(clientId);
		if (prev) clearTimeout(prev);
		let activity = 0;
		try {
			activity = cs.latestActivity();
		} catch {
			activity = 0;
		}
		const since = Math.max(this.offlineSince.get(clientId) ?? 0, activity || 0);
		const delay = Math.max(1_000, since + OFFLINE_ROW_TTL_MS - Date.now() + 1_000);
		const timer = setTimeout(() => {
			this.offlineTimers.delete(clientId);
			if (this.clients.get(clientId) === cs && !AgentService.isPseudoClientId(clientId) && cs.sinkCount() === 0) {
				this.notifyExternalRunning(clientId);
			}
		}, delay);
		timer.unref?.();
		this.offlineTimers.set(clientId, timer);
	}

	private clearOfflineRows(clientId: string): void {
		const had = this.offlineSince.delete(clientId);
		const timer = this.offlineTimers.get(clientId);
		if (timer) {
			clearTimeout(timer);
			this.offlineTimers.delete(clientId);
		}
		if (had) this.pokeExternalRunning(clientId);
	}

	releaseSchedulerClient(taskId: string): void {
		const safe = String(taskId ?? "").replace(/[^A-Za-z0-9_-]/g, "") || "task";
		const clientId = `scheduler:${safe}`;
		const cs = this.clients.get(clientId);
		if (!cs) return;
		this.clients.delete(clientId);
		void cs.dispose().catch(() => {});
		this.pokeExternalRunning(clientId);
	}

	pokeExternalRunning(excludeClientId: string): void {
		const offlineCs = this.clients.get(excludeClientId);
		if (offlineCs && !AgentService.isPseudoClientId(excludeClientId) && offlineCs.sinkCount() === 0) {
			this.armOfflineRowExpiry(excludeClientId, offlineCs);
		}
		this.notifyExternalRunning(excludeClientId);
	}

	private notifyExternalRunning(excludeClientId: string): void {
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			try {
				cs.refreshExternalRunning();
			} catch {}
		}
	}

	notifyClientsExcept(
		excludeClientId: string,
		msg: { type: "notice"; level: "info" | "warning" | "error"; text: string; textEn?: string },
	): void {
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			try {
				cs.sendNotice(msg);
			} catch {}
		}
	}

	activeConversations(): number {
		let n = 0;
		for (const cs of this.clients.values()) n += cs.activeConversations();
		return n;
	}

	pendingMessages(): number {
		let n = 0;
		for (const cs of this.clients.values()) n += cs.pendingMessages();
		return n;
	}

	readConversationForPlugins(opts?: PluginConversationQuery): PluginConversationSnapshot | null {
		const want = (opts?.clientId ?? "").trim();
		if (want) {
			const cs = this.clients.get(want);
			if (cs) {
				try {
					const s = cs.readConversationForPlugins({ preferActive: true, includeSubagents: true });
					if (s) return s;
				} catch {}
			}
		}
		const snaps: (PluginConversationSnapshot | null)[] = [];
		for (const cs of this.clients.values()) {
			try {
				snaps.push(cs.readConversationForPlugins());
			} catch {}
		}
		return pickLatestClientSnapshot(snaps);
	}

	async chatFromPlugin(pluginId: string, req: PluginChatRequest): Promise<PluginChatResult> {
		const safe = String(pluginId ?? "plugin").replace(/[^A-Za-z0-9_-]/g, "") || "plugin";
		const acct = String(req?.accountId ?? "default").replace(/[^A-Za-z0-9_-]/g, "") || "default";
		const clientId = `plugin:${safe}:${acct}`;
		const text = String(req?.text ?? "");
		const attachments = normalizePluginChatAttachments(req?.attachments);
		if (!text.trim()) throw new Error("chatFromPlugin: text 为空");
		if (this.quiesced) throw new QuiesceRejectedError("插件无头调用被拒绝，请等服务器恢复后重试");
		const runId = `pr-${randomUUID()}`;
		const target = String(req?.conversationId ?? "").trim();
		if (target) {
			const own = this.clients.get(clientId);
			const ownConv = own?.getConversation(target);
			const hits: { owner: ClientSession; conv: Conversation; ownerId: string }[] = [];
			if (own && ownConv) hits.push({ owner: own, conv: ownConv, ownerId: clientId });
			else {
				for (const [ownerId, owner] of this.clients) {
					const conv = owner.getConversation(target);
					if (conv) hits.push({ owner, conv, ownerId });
				}
			}
			if (hits.length > 1) throw new Error("chatFromPlugin: ambiguous conversation id; rebind the channel");
			if (hits.length === 1) {
				const { owner, conv, ownerId } = hits[0];
				if (req.cwd && resolve(req.cwd) !== resolve(conv.cwd))
					throw new Error("chatFromPlugin: bound conversation cwd differs; start a new channel conversation");
				if (req.model || req.thinkingLevel) {
					if (owner.readConversationForPlugins()?.conversationId !== conv.id)
						throw new Error("chatFromPlugin: cannot change settings of an inactive bound conversation");
					if (req.model) await owner.switchModelOrThrow(req.model);
					if (req.thinkingLevel) owner.setThinking(req.thinkingLevel);
				}
				owner.markPluginRun(runId, conv);
				void owner
					.prompt(text, attachments, false, conv)
					.catch((err) => console.error("[plugin chat] prompt failed", err));
				return { conversationId: conv.id, clientId: ownerId, sessionId: conv.session.sessionId, runId };
			}
		}
		const cwdReq = String(req?.cwd ?? "").trim();
		let cwdAbs = "";
		if (cwdReq) {
			const chk = checkPluginCwd(cwdReq);
			if (!chk.ok) throw new Error(`chatFromPlugin: ${chk.error}`);
			cwdAbs = chk.abs ?? "";
		}
		const cs = await this.attach(clientId, () => {});
		cs.setConversationIndependent(cs.readConversationForPlugins()!.conversationId, req.independent ?? false);
		try {
			if (cwdAbs && cs.cwd !== cwdAbs) await cs.setCwd(cwdAbs);
		} catch (err) {
			throw new Error(`chatFromPlugin: 切换工作目录失败（${cwdAbs}）：${(err as Error).message}`);
		}
		const model = String(req?.model ?? "").trim();
		if (model) {
			try {
				await cs.switchModelOrThrow(model);
			} catch (err) {
				throw new Error(`chatFromPlugin: 切换模型失败（${model}）：${(err as Error).message}`);
			}
		}
		const thinking = String(req?.thinkingLevel ?? "").trim();
		if (thinking) {
			try {
				cs.setThinking(thinking);
			} catch (err) {
				throw new Error(`chatFromPlugin: 切换思考强度失败（${thinking}）：${(err as Error).message}`);
			}
		}
		let stampedId = "";
		try {
			stampedId = cs.markPluginRun(runId);
		} catch {}
		const conversationId = stampedId || (cs.readConversationForPlugins()?.conversationId ?? "");
		const conv = cs.getConversation(conversationId);
		void cs.prompt(text, attachments, false, conv).catch((err) => console.error("[plugin chat] prompt failed", err));
		return { conversationId, clientId, sessionId: conv?.session.sessionId, runId };
	}

	async abortPluginRun(runId: string): Promise<{ ok: boolean; error?: string }> {
		for (const owner of this.clients.values()) {
			if (owner.findPluginRun(runId)) return owner.abortPluginRun(runId);
		}
		return { ok: false, error: "Plugin run is no longer active" };
	}

	async chatFromScheduler(task: {
		id: string;
		name?: string;
		cwd: string;
		prompt: string;
		model?: string;
		thinkingLevel?: string;
	}): Promise<{ ok: boolean; conversationId?: string; error?: string }> {
		const safe = String(task.id ?? "task").replace(/[^A-Za-z0-9_-]/g, "") || "task";
		const clientId = `scheduler:${safe}`;
		const text = String(task.prompt ?? "");
		if (!text.trim()) return { ok: false, error: "触发指令为空" };
		if (this.quiesced) return { ok: false, error: "服务器正忙（quiesced），请稍后重试" };
		const cwd = String(task.cwd ?? "").trim();
		try {
			if (!cwd || !statSync(cwd).isDirectory()) throw new Error("not-a-dir");
		} catch {
			return { ok: false, error: `目标项目不存在或不是目录：${cwd || "（空）"}` };
		}
		try {
			const cs = await this.attach(clientId, () => {});
			if (cs.cwd !== cwd) await cs.setCwd(cwd);
			const model = String(task.model ?? "").trim();
			if (model) {
				try {
					await cs.switchModelOrThrow(model);
				} catch (err) {
					return { ok: false, error: `切换模型失败（${model}）：${(err as Error).message}` };
				}
			}
			const thinking = String(task.thinkingLevel ?? "").trim();
			if (thinking) {
				try {
					cs.setThinking(thinking);
				} catch (err) {
					return { ok: false, error: `切换思考强度失败（${thinking}）：${(err as Error).message}` };
				}
			}
			const conversationId = cs.readConversationForPlugins()?.conversationId ?? "";
			const taskTitle = (task.name || "").trim() || (text.length > 30 ? text.slice(0, 30) : text);
			if (conversationId && taskTitle) {
				void cs.renameConversation(conversationId, taskTitle);
			}
			if (cs.readConversationForPlugins()?.isStreaming === true) {
				return {
					ok: false,
					conversationId: conversationId || undefined,
					error: "上一轮后台任务仍在执行中，跳过本次触发",
				};
			}
			let promptError: string | undefined;
			void cs.prompt(`[定时任务] ${text}`).catch((err) => {
				promptError = String((err as Error)?.message ?? err);
			});
			const deadline = Date.now() + 10 * 60 * 1000;
			for (;;) {
				await new Promise((r) => setTimeout(r, 2000));
				if (promptError) {
					return { ok: false, conversationId: conversationId || undefined, error: promptError };
				}
				let streaming = false;
				let lastError: string | undefined;
				try {
					const snap = cs.readConversationForPlugins();
					streaming = snap?.isStreaming === true;
					const msgs = snap?.messages ?? [];
					for (let i = msgs.length - 1; i >= 0; i--) {
						const m = msgs[i];
						if (m.role === "assistant" && m.errorMessage) {
							lastError = m.errorMessage;
							break;
						}
						if (m.role === "assistant") break;
					}
				} catch {
					streaming = false;
				}
				if (!streaming) {
					if (lastError) return { ok: false, conversationId: conversationId || undefined, error: lastError };
					return { ok: true, conversationId: conversationId || undefined };
				}
				if (Date.now() >= deadline) {
					try {
						await cs.abort();
					} catch {}
					return {
						ok: false,
						conversationId: conversationId || undefined,
						error: "运行超时（10 分钟），已中止后台会话",
					};
				}
			}
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	async completeForPlugins(
		pluginId: string,
		req: { prompt?: string; system?: string; model?: string; maxChars?: number; timeoutMs?: number },
	): Promise<{
		ok: boolean;
		text?: string;
		model?: string;
		usage?: { input: number; output: number };
		error?: string;
	}> {
		try {
			if (this.quiesced) return { ok: false, error: "插件 LLM 调用被拒绝，请等服务器恢复后重试" };
			let env: { cwd: string; agentDir: string; fallbackModel?: { provider: string; id: string } };
			const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
			try {
				const cs = this.pluginClient();
				env = cs?.llmEnvForPlugins() ?? { cwd: this.cwd, agentDir };
			} catch {
				env = { cwd: this.cwd, agentDir };
			}
			const mod = await import("./plugin-llm.js");
			const r = await mod.completeWithIsolatedSession(env, { ...req, prompt: String(req?.prompt ?? "") });
			if (!r.ok) return r;
			console.log(`[plugin:${pluginId}] llm.complete ok（模型 ${r.model}，输出 ${r.text.length} 字）`);
			return r;
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	noteSocketOpen(): void {
		this.socketCount += 1;
	}
	noteSocketClose(): void {
		this.socketCount = Math.max(0, this.socketCount - 1);
	}

	serviceStatus(): {
		pid: number;
		version: string;
		cwd: string;
		quiesced: boolean;
		quiescedSince?: number;
		connectedClients: number;
		activeConversations: number;
		pendingMessages: number;
		service: UiServiceInfo | null;
	} {
		return {
			pid: process.pid,
			version: VERSION,
			cwd: this.cwd,
			...this.quiesceInfo(),
			connectedClients: this.socketCount,
			activeConversations: this.activeConversations(),
			pendingMessages: this.pendingMessages(),
			service: toServiceInfo(launchOrigin()),
		};
	}

	private findAdoptableOrphan(excludeClientId: string): { oldId: string; cs: ClientSession } | null {
		const cands: OrphanCandidate[] = [];
		for (const [id, cs] of this.clients) {
			if (id === excludeClientId) continue;
			const pseudo = isOrphanAdoptionExcludedClientId(id);
			let live = false;
			let streaming = 0;
			let adoptable = false;
			let activity = 0;
			try {
				live = cs.sinkCount() > 0;
			} catch {
				live = false;
			}
			if (!pseudo && !live) {
				try {
					streaming = cs.activeConversations();
				} catch {
					streaming = 0;
				}
				try {
					adoptable = cs.hasAdoptableContent();
				} catch {
					adoptable = false;
				}
				try {
					activity = cs.latestActivity();
				} catch {
					activity = 0;
				}
			}
			cands.push({ id, live, pseudo, streaming, adoptable, activity });
		}
		const picked = pickAdoptableOrphan(cands);
		if (!picked) return null;
		const cs = this.clients.get(picked);
		return cs ? { oldId: picked, cs } : null;
	}

	private wireClient(cs: ClientSession, clientId: string): void {
		if (isSharedExecutionClientId(clientId) && !this.sharedInteractionSinks.has(cs)) {
			const relay = (msg: ServerMessage): void => {
				if (
					msg.type !== "question_pending" &&
					msg.type !== "question_queue" &&
					msg.type !== "question_retracted" &&
					msg.type !== "tool_approval_pending" &&
					msg.type !== "tool_approval_resolved"
				)
					return;
				const interactions = this.globalInteractions();
				for (const [viewerId, viewer] of this.clients) {
					if (!isSharedExecutionClientId(viewerId)) {
						if (msg.type !== "question_queue") viewer.emitSharedInteraction({ ...msg, owner: clientId, global: true });
						viewer.emitSharedInteraction(interactions);
					}
				}
			};
			this.sharedInteractionSinks.set(cs, relay);
			cs.attachSink(relay);
		}
		cs.prepareBotSessionResume = (targetPath) => this.prepareBotSessionResume(targetPath, clientId);
		cs.findSessionOwner = (targetPath) => this.findSessionOwner(targetPath, clientId);
		cs.takeOverConversationElsewhere = (ownerId, convId) => this.takeOverConversation(clientId, ownerId, convId);
		cs.hasStreamingElsewhere = () => this.hasStreamingElsewhere(clientId);
		cs.listProjectRunners = (cwd) => this.listProjectRunners(cwd, clientId);
		cs.getClaimStore = () => this.claimStore;
		cs.findConversationHome = (sdkSession) => this.findConversationHome(sdkSession);
		cs.findSubagentOwner = (convId) => this.findSubagentOwner(convId);
		cs.allSubagentSessions = () => [...this.clients.values()];
		cs.listExternalRunning = () => this.listExternalRunning(clientId);
		cs.notifyExternalClients = (msg) => this.notifyClientsExcept(clientId, msg);
		cs.onRunningChanged = () => this.pokeExternalRunning(clientId);
		cs.steerConversationElsewhere = (id, text) => this.steerElsewhere(clientId, id, text);
		cs.schedulerStore = this.schedulerStore;
	}

	async takeOverConversation(targetId: string, ownerId: string, convId: string): Promise<void> {
		const target = this.clients.get(targetId);
		if (!target) return;
		const fail = (text: string, textEn: string): void => {
			target.sendNotice({ type: "notice", level: "warning", text, textEn });
		};
		if (!ownerId || !convId) {
			fail("过户目标不明确（缺 owner/id），请重试", "Takeover target unclear (missing owner/id), please retry.");
			return;
		}
		if (ownerId === targetId) {
			try {
				await target.switchConversation(convId);
			} catch {}
			return;
		}
		if (ownerId.startsWith("scheduler:")) {
			fail(
				"定时任务会话不支持过户 —— 报告会自动落回绑定的对话，可在后台任务面板查看进度",
				"Scheduler sessions cannot be taken over — reports are saved to the bound conversation automatically; check progress in the Background Tasks panel.",
			);
			return;
		}
		const source = this.clients.get(ownerId);
		if (!source) {
			fail("对方会话已不存在，可从历史对话里直接打开", "The source session is gone; reopen it from History instead.");
			target.refreshExternalRunning();
			return;
		}
		const briefs = source.takeoverBriefs();
		const main = briefs.find((b) => b.id === convId);
		if (!main) {
			fail(
				"对方已经没有这条对话（刚结束或被关闭），左栏稍后自动刷新",
				"That conversation is gone on the other side; the list refreshes shortly.",
			);
			target.refreshExternalRunning();
			return;
		}
		if (main.isSubagent) {
			fail(
				"只能过户主对话（子代理随主对话一起搬）",
				"Only main conversations can be taken over (subagents move with their parent).",
			);
			return;
		}
		const moveIds = [convId, ...collectSubagentDescendantIds(briefs, convId)];
		const moveSet = new Set(moveIds);
		const movedMains = briefs.filter((b) => moveSet.has(b.id) && !b.isSubagent && !b.isEphemeral).length;
		const openInProject =
			target.takeoverBriefs().filter((b) => b.cwd === main.cwd && !b.isSubagent && !b.isEphemeral).length + movedMains;
		const maxOpenConversations = getMaxOpenConversations();
		if (openInProject > maxOpenConversations) {
			fail(
				`目标项目运行的对话已达上限（${maxOpenConversations} 个），请先移出不需要的对话（打开后离开不继续对话即移出；钉住的对话需先取消钉住）`,
				`This project already has the max open conversations (${maxOpenConversations}). Open one and leave it (without continuing) to remove it from the list; pinned chats must be unpinned first.`,
			);
			return;
		}
		try {
			const detached = await source.detachTakeoverConversations(moveIds);
			if (!detached.ok) {
				fail(
					detached.reason === "empty"
						? "对方会话只剩这一条对话且服务排空中，稍后再试"
						: "对方已经没有这条对话（刚结束或被关闭），左栏稍后自动刷新",
					detached.reason === "empty"
						? "The source session only has this conversation and the server is draining; try later."
						: "That conversation is gone on the other side; the list refreshes shortly.",
				);
				if (detached.reason === "missing") target.refreshExternalRunning();
				return;
			}
			let newMainId: string;
			try {
				if (process.env.PI_WEB_TEST_TAKEOVER_FAIL_INSERT === "1") throw new Error("injected takeover insert failure");
				newMainId = target.insertTakeoverConvs(detached.payload);
				await target.switchConversation(newMainId);
				await target.bindSession();
			} catch (err) {
				const where = await this.returnTakeoverPayload(source, target, detached.payload);
				console.error("[takeover] insert/activate failed, payload returned to", where, err);
				if (where === "source") {
					source.sendNotice({
						type: "notice",
						level: "info",
						text: `对方的过户未完成，「${main.title}」已退回本页，可直接继续。`,
						textEn: `The takeover did not complete on the other side — "${main.title}" is back on this page.`,
					});
				}
				fail(
					where === "source"
						? `过户失败（${(err as Error).message}）——对话已退回原页面，可直接重试`
						: `过户失败（${(err as Error).message}）——对话留在本页运行列表里，刷新即可继续`,
					where === "source"
						? `Takeover failed (${(err as Error).message}) — the conversation is back on the source page; retry there.`
						: `Takeover failed (${(err as Error).message}) — the conversation is kept in this page's running list; refresh to pick it up.`,
				);
				return;
			}
			source.sendNotice({
				type: "notice",
				level: "info",
				text: `「${main.title}」已过户到另一处接管，本页不再持有它。`,
				textEn: `"${main.title}" was taken over by another page and is no longer held here.`,
			});
			target.sendNotice({
				type: "notice",
				level: "info",
				text: `已将「${main.title}」过户到当前页面，可直接继续查看与操作。`,
				textEn: `"${main.title}" was moved to this page — pick up right where it left off.`,
			});
		} catch (err) {
			fail(`过户失败：${(err as Error).message}`, `Takeover failed: ${(err as Error).message}`);
		}
	}

	private async returnTakeoverPayload(
		source: ClientSession,
		target: ClientSession,
		payload: TakeoverPayload,
	): Promise<"source" | "target"> {
		target.reclaimTakeoverConvs(payload);
		try {
			const mainId = source.insertTakeoverConvs(payload);
			await source.switchConversation(mainId);
			await source.bindSession();
			return "source";
		} catch (err) {
			console.error("[takeover] rollback to source failed:", err);
			try {
				target.insertTakeoverConvs(payload);
			} catch {}
			return "target";
		}
	}

	async peekElsewhereQuestion(targetId: string, ownerId: string, convId: string): Promise<void> {
		const target = this.clients.get(targetId);
		if (!target) return;
		const fail = (text: string, textEn: string): void => {
			target.sendNotice({ type: "notice", level: "warning", text, textEn });
		};
		if (!ownerId || !convId) {
			fail("问卷目标不明确（缺 owner/id），请重试", "Question target unclear (missing owner/id), please retry.");
			return;
		}
		if (ownerId === targetId) return;
		if (AgentService.isPseudoClientId(ownerId)) {
			fail(
				"定时任务/插件会话的问卷不支持跨页作答 —— 报告会自动落回绑定的对话，可在后台任务面板查看进度",
				"Scheduler/plugin session questions cannot be answered cross-page — reports are saved to the bound conversation automatically; check progress in the Background Tasks panel.",
			);
			return;
		}
		const source = this.clients.get(ownerId);
		const q = source?.peekPendingQuestion(convId);
		if (!q) {
			fail(
				"那张问卷已不在（对方刚回答/取消或对话已结束）",
				"That question is gone (just answered/cancelled there, or the run ended).",
			);
			target.refreshExternalRunning();
			return;
		}
		target.pushElsewhereQuestion(ownerId, convId, q);
	}

	async answerElsewhereQuestion(
		targetId: string,
		ownerId: string,
		id: string,
		answers: QuestionAnswer[],
		cancelled?: boolean,
		cancelReason?: string,
	): Promise<void> {
		const target = this.clients.get(targetId);
		if (!target) return;
		let source = ownerId ? this.clients.get(ownerId) : undefined;
		let ok = source ? source.resolveQuestion(id, answers, cancelled, cancelReason) : false;
		if (!ok) {
			for (const candidate of this.clients.values()) {
				if (candidate !== source && candidate.resolveQuestion(id, answers, cancelled, cancelReason)) {
					ok = true;
					break;
				}
			}
		}
		if (!ok) {
			target.sendNotice({
				type: "notice",
				level: "warning",
				text: "那张问卷已不在（对方刚回答/取消或对话已结束），你的回答没有送出",
				textEn:
					"That question is gone (just answered/cancelled there, or the run ended) — your answer was not delivered.",
			});
			target.refreshExternalRunning();
		}
	}

	async navigateQuestion(targetId: string, id: string): Promise<void> {
		const target = this.clients.get(targetId);
		if (!target) return;
		for (const [ownerId, source] of this.clients) {
			if (AgentService.isPseudoClientId(ownerId)) continue;
			const request = source.getQuestionNavigation(id);
			if (!request || resolve(request.cwd) !== resolve(target.cwd)) continue;
			if (source !== target) await this.takeOverConversation(targetId, ownerId, request.rootConversationId);
			const moved = target.getQuestionNavigation(id);
			if (moved) await target.switchConversation(moved.conversationId);
			return;
		}
		target.sendNotice({
			type: "notice",
			level: "warning",
			text: "问卷已结束，无法定位来源",
			textEn: "The question has ended; its source is no longer available.",
		});
	}

	async attach(
		clientId: string,
		send: (msg: ServerMessage) => void,
		sendShared: (msg: ServerMessage) => void = send,
	): Promise<ClientSession> {
		let cs = this.clients.get(clientId);
		if (!cs) {
			const inflight = this.pending.get(clientId);
			if (inflight) {
				cs = await inflight;
			} else {
				const orphan = isOrphanAdoptionExcludedClientId(clientId) ? null : this.findAdoptableOrphan(clientId);
				if (orphan) {
					this.clients.delete(orphan.oldId);
					this.clearOfflineRows(orphan.oldId);
					this.clients.set(clientId, orphan.cs);
					cs = orphan.cs;
					orphan.cs.updateClientId?.(clientId);
					this.wireClient(cs, clientId);
					cs.noteAdopted();
					const inter = this.stateStore.takeInterrupted(orphan.oldId);
					if (inter?.length) this.stateStore.saveInterrupted(clientId, inter);
				} else {
					if (this.quiesced) {
						throw new QuiesceRejectedError("新连接被拒绝，请等服务器恢复后重试");
					}
					let cwd = this.cwd;
					const saved = this.stateStore.get(clientId);
					if (saved.lastCwd && saved.lastCwd !== this.cwd) {
						if (isRemoteWorkspaceUri(saved.lastCwd)) {
							cwd = saved.lastCwd;
						} else {
							try {
								const { stat } = await import("node:fs/promises");
								if ((await stat(saved.lastCwd)).isDirectory()) cwd = saved.lastCwd;
							} catch {}
						}
					}
					let createOpts: { blank?: boolean; blankTitle?: string; idleHeld?: boolean } | undefined;
					const requiresBlankSession = isOrphanAdoptionExcludedClientId(clientId);
					if (requiresBlankSession) {
						createOpts = { blank: true };
					} else if (this.clients.size > 0) {
						try {
							const sessionBaseDir = resolveWorkspaceSessionDir(this.stateStore.dataDir, cwd);
							const recentPath = await findMostRecentSessionFileFast(sessionBaseDir, cwd);
							const recent = recentPath ? resolve(recentPath) : undefined;
							const owner = recent ? this.findSessionOwner(recent, clientId) : null;
							if (owner && (owner.connected || owner.isStreaming)) {
								createOpts = { blank: true, blankTitle: owner.title, ...(owner.isStreaming ? {} : { idleHeld: true }) };
							}
						} catch {}
					}
					const creating = ClientSession.create(clientId, cwd, this.stateStore, {
						...createOpts,
						onNotificationEvent: (event) => this.onNotificationEvent?.(event),
					}).finally(() => {
						this.pending.delete(clientId);
					});
					this.pending.set(clientId, creating);
					cs = await creating;
					this.clients.set(clientId, cs);
					this.wireClient(cs, clientId);
					this.stateStore.remember(clientId, cwd);
					if (cwd !== this.cwd) {
						send({
							type: "notice",
							level: "info",
							text: `已恢复上次的工作目录：${cwd}`,
							textEn: `Restored the last working directory: ${cwd}`,
						});
					}
				}
			}
		}
		const detachedSinks = this.pendingDetaches.get(clientId);
		if (detachedSinks?.has(send)) {
			detachedSinks.delete(send);
			if (detachedSinks.size === 0) this.pendingDetaches.delete(clientId);
			if (clientId.startsWith("device-task-") && !isBotExecutionRegistered(clientId) && cs.sinkCount() === 0) {
				this.clients.delete(clientId);
				await cs.dispose();
				this.pokeExternalRunning(clientId);
				return cs;
			}
		} else {
			cs.attachSink(send);
			this.resumeSharedConversation(clientId, sendShared);
			if (!isSharedExecutionClientId(clientId)) send(this.globalInteractions());
			this.clearOfflineRows(clientId);
		}
		cs.onDisposed = () => this.releaseSharedClient(cs);
		cs.onQuit = this.onQuit;
		cs.onToolEvent = this.onToolEvent;
		cs.toolGuard = this.toolGuard;
		cs.onRunEvent = this.onRunEvent;
		cs.onConversationChanged = () => this.onConversationChanged?.();
		cs.onClientModelChanged = (snap) => this.onClientModelChanged?.(snap);
		cs.pluginToolsProvider = this.pluginToolsProvider;
		cs.pluginCommandsProvider = this.pluginCommandsProvider;
		cs.pluginBgTasksProvider = this.pluginBgTasksProvider;
		cs.pluginStopBgTask = this.pluginStopBgTask;
		cs.isQuiesced = () => this.quiesced;
		this.wireClient(cs, clientId);
		cs.onCwdChanged = (abs, roots) => this.onClientCwdChanged?.(abs, roots);
		this.onClientCwdChanged?.(cs.cwd, cs.workspaceRoots);
		void cs.resumeInterrupted(this.stateStore.takeInterrupted(clientId));
		return cs;
	}

	applyPluginAgentTools(): void {
		for (const cs of this.clients.values()) cs.refreshPluginTools();
	}

	mcpProjectCwds(): string[] {
		return [...new Set([...this.clients.values()].flatMap((cs) => cs.mcpProjectCwds()))];
	}

	refreshMcpProject(cwd: string): void {
		for (const cs of this.clients.values()) {
			if (resolve(cs.cwd) !== resolve(cwd)) continue;
			cs.broadcastMcpServers();
			cs.pushSettings();
		}
	}

	async setLocale(clientId: string, locale: string): Promise<void> {
		const cs = this.clients.get(clientId);
		if (cs) {
			await cs.setLocale(locale);
			return;
		}
		const inflight = this.pending.get(clientId);
		if (inflight) {
			try {
				await (await inflight).setLocale(locale);
			} catch {}
		}
	}

	applyPluginCommandCatalog(): void {
		for (const cs of this.clients.values()) void cs.pushSlashCommands();
	}

	applyPluginMarkers(): void {
		for (const cs of this.clients.values()) cs.refreshPluginMarkers();
	}

	refreshBackgroundServers(): void {
		for (const cs of this.clients.values()) cs.refreshBgTasks();
	}

	detach(clientId: string, send: (msg: ServerMessage) => void): void {
		const binding = this.sharedViewers.get(clientId);
		if (binding?.send === send) {
			binding.close();
			binding.close = () => {};
		}
		const cs = this.clients.get(clientId);
		if (cs) {
			cs.detachSink(send);
			if (cs.sinkCount() === 0) {
				if (
					clientId.startsWith("canvas:") ||
					clientId.startsWith("canvas-") ||
					(clientId.startsWith("device-task-") && !isBotExecutionRegistered(clientId))
				) {
					this.clients.delete(clientId);
					void cs.dispose().catch(() => {});
					this.pokeExternalRunning(clientId);
					return;
				}
				if (!AgentService.isPseudoClientId(clientId)) {
					this.offlineSince.set(clientId, Date.now());
					this.pokeExternalRunning(clientId);
					this.armOfflineRowExpiry(clientId, cs);
				}
			}
		} else if (this.pending.has(clientId)) {
			let set = this.pendingDetaches.get(clientId);
			if (!set) {
				set = new Set();
				this.pendingDetaches.set(clientId, set);
			}
			set.add(send);
		}
	}

	get(clientId: string): ClientSession | undefined {
		return this.clients.get(clientId);
	}

	pluginClient(): ClientSession | undefined {
		let fallback: ClientSession | undefined;
		for (const cs of this.clients.values()) {
			if (!fallback) fallback = cs;
			try {
				if (cs.activeConversations() > 0) return cs;
			} catch {}
		}
		return fallback;
	}

	recordInterruptedRuns(): void {
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const [clientId, cs] of [...this.clients]) {
			try {
				const running = cs.streamingSummaries();
				if (running.length > 0) {
					this.stateStore.saveInterrupted(
						clientId,
						running.map((r) => ({ ...r, at: Date.now() })),
					);
				}
			} catch {}
		}
	}

	getCapabilities(): AgentEngineCapabilities {
		return DEFAULT_PI_CAPABILITIES;
	}

	async disposeAll(): Promise<void> {
		this.recordInterruptedRuns();
		const all = [...this.clients.values()];
		this.clients.clear();
		await Promise.all(all.map((cs) => cs.dispose()));
	}
}
