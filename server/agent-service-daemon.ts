/**
 * agent-service-daemon — pi-web-ui 多客户端顶层连接服务与过户事务编排引擎。
 *
 * 负责：
 * - 多客户端会话池管理（ClientSession registry & attach/detach 连接池）
 * - 服务排空门禁与状态机（Quiesce / Draining state machine）
 * - 跨标签页会话查重与同项目并行感知（SessionOwnerInfo & ElsewhereRunning）
 * - 跨端手动过户事务与夭折回滚（Takeover Transactions & Rollback）
 * - 跨端问卷预告与答复路由（Peek & Answer Elsewhere Questions）
 * - 插件/调度器无头客户端隔离执行（completeForPlugins & scheduler dispatch）
 * - 服务端运行状态快照（serviceStatus）
 *
 * 从 agent-service.ts 抽出为独立模块。
 */
import { join, resolve } from "node:path";
import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { VERSION, getAgentDir, type AgentSession } from "@earendil-works/pi-coding-agent";
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
			close: () => void;
			send: (message: ServerMessage) => void;
		}
	>();

	openSharedConversation(
		viewerClientId: string,
		ownerClientId: string,
		convId: string,
		send: (message: ServerMessage) => void,
	): boolean {
		const viewer = this.clients.get(viewerClientId);
		const owner = this.clients.get(ownerClientId);
		const conversation = owner?.getConversation(convId);
		if (!viewer || !owner || !conversation || conversation.independent !== false || conversation.isSubagent)
			return false;
		this.closeSharedConversation(viewerClientId);
		const binding = { owner, conversation, ownerClientId, conversationId: convId, close: () => {}, send };
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
						sharedConversation: { owner: ownerClientId, conversationId: convId },
					},
				});
			else if (message.type === "snapshot_delta")
				send({
					...message,
					state: {
						...message.state,
						clientId: viewerClientId,
						sharedConversation: { owner: ownerClientId, conversationId: convId },
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
			binding.conversation.independent === false
		)
			return binding;
		if (binding) this.closeSharedConversation(viewerClientId);
		return undefined;
	}

	dispatchSharedConversationMessage(viewerClientId: string, message: ClientMessage): boolean {
		const binding = this.sharedConversationTarget(viewerClientId);
		if (!binding) return false;
		if (["new_chat", "switch_session", "switch_conversation", "set_cwd", "resume_session"].includes(message.type)) {
			this.closeSharedConversation(viewerClientId);
			return false;
		}
		const { owner, conversation: conv, send } = binding;
		const fail = (error: unknown) => {
			try {
				send({ type: "notice", level: "error", text: String(error), textEn: String(error) });
			} catch {
				/* disconnected viewer */
			}
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
		// One workspace service per binding; close its watchers with the subscription.
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
			this.openSharedConversation(viewerClientId, binding.ownerClientId, conv.id, send);
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

	/** 客户端 -> 最后一个浏览器断开的时刻（离线行宽限期起点；重连/认领即删）。 */
	private offlineSince = new Map<string, number>();
	/** 客户端 -> 离线行宽限期到期定时器（到期后让其他客户端重推，行消失）。 */
	private offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** index.ts 注入：SDK 工具执行事件的插件转发钩子，attach 时拷贝到每个新会话。 */
	onToolEvent: ((ev: PluginToolEvent) => void) | undefined = undefined;
	/** index.ts 注入：bash/read 插件拦截钩子，attach 时拷贝到每个新会话。 */
	toolGuard: ToolGuardHook | undefined = undefined;
	/** index.ts 注入：运行轨迹事件的插件转发钩子，attach 时拷贝到每个新会话。 */
	onRunEvent: ((ev: PluginRunEvent) => void) | undefined = undefined;
	/** index.ts 注入：对话切换通知钩子，attach 时拷贝到每个新会话。 */
	onConversationChanged: (() => void) | undefined = undefined;
	/** index.ts 注入：模型切换成功通知钩子（#542），attach 时拷贝到每个新会话。 */
	onClientModelChanged: ((snap: PluginConversationSnapshot) => void) | undefined = undefined;
	/** index.ts 注入：读取插件当前注册的 AI 工具（attach 时拷贝到每个新会话）。 */
	pluginToolsProvider: ((cwd?: string) => PluginAgentTool[]) | undefined = undefined;
	/** index.ts 注入：读取插件当前注册的斜杠命令（attach 时拷贝到每个新会话）。 */
	pluginCommandsProvider: (() => PluginCommandDef[]) | undefined = undefined;
	/** index.ts 注入：读取插件注册的常驻后台任务（并入 bg_servers 面板）。 */
	pluginBgTasksProvider: (() => BgServer[]) | undefined = undefined;
	/** index.ts 注入：停止插件任务（kill_background_server with taskId）。 */
	pluginStopBgTask: ((taskId: string) => boolean) | undefined = undefined;
	/** index.ts 注入：内置调度存储（attach 时拷贝到每个新会话，供 schedule_* 工具）。 */
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
	/** 全局认领表（跨浏览器标签页共享；<dataDir>/claims.json，best-effort 持久化）。 */
	private claimStore: ClaimStore;
	/** Quiesce (draining) state — the service refuses NEW work (prompts, forks,
	 *  session resumes, new clients) so a deploy/upgrade/backup can stop cleanly
	 *  once existing runs finish. Controlled via the local control socket:
	 *  `pi-web-ui server quiesce|unquiesce`. */
	private quiesced = false;
	private quiescedAt = 0;
	/** Attached browser sockets (reported by index.ts on open/close) — the
	 *  control socket reports real sockets, not cached client-session objects. */
	private socketCount = 0;
	private pending = new Map<string, Promise<ClientSession>>();
	private pendingDetaches = new Map<string, Set<(msg: ServerMessage) => void>>();
	private stateStore: ClientStateStore;
	/** Set by index.ts: called when /pi-web-ui:quit is invoked. */
	onQuit: (() => boolean) | undefined = undefined;
	/** 任意客户端成功切换工作区后触发（新绝对路径 + 该项目的额外工作区根）。
	 *  index.ts 接到 PluginManager.notifyCwd / notifyWorkspaceRoots，让插件宿主的
	 *  host.cwd 实时跟随当前项目、受支持路径范围跟着多根变。 */
	onClientCwdChanged: ((cwd: string, roots: string[]) => void) | undefined = undefined;

	constructor(
		private cwd: string,
		stateFile: string | ClientStateStore,
	) {
		this.stateStore = typeof stateFile === "string" ? new ClientStateStore(stateFile) : stateFile;
		this.claimStore = new ClaimStore(join(this.stateStore.dataDir, "claims.json"));
	}

	/** Get or create the session for a client, racing attach calls safely. */
	/** True while the service is draining — new work is refused. */
	isQuiesced(): boolean {
		return this.quiesced;
	}

	/** Enter quiesce: stop admitting new work. Existing runs keep going. */
	quiesce(): void {
		this.quiesced = true;
		this.quiescedAt = Date.now();
	}

	/** Leave quiesce: admit new work again. */
	unquiesce(): void {
		this.quiesced = false;
		this.quiescedAt = 0;
	}

	/** Snapshot for the control socket / status command. */
	quiesceInfo(): { quiesced: boolean; quiescedSince?: number } {
		return this.quiesced ? { quiesced: true, quiescedSince: this.quiescedAt } : { quiesced: false };
	}

	/** issue #145：除请求方外是否有客户端正在跑（扫目录查重前置的无 I/O 判断）。 */
	hasStreamingElsewhere(excludeClientId: string): boolean {
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			try {
				if (cs.activeConversations() > 0) return true;
			} catch {
				// 单客户端坏了不影响判断
			}
		}
		return false;
	}

	/** Dispose confirmed-stopped Bot owners before reopening their authorized transcript. */
	async prepareBotSessionResume(targetPath: string, excludeClientId: string): Promise<void> {
		for (const [ownerId, owner] of this.clients) {
			if (ownerId === excludeClientId || !ownerId.startsWith("device-task-") || isBotExecutionRegistered(ownerId))
				continue;
			const conv = owner.findConversationBySessionFile(targetPath);
			if (!conv || owner.conversationStreaming(conv)) continue;
			// Registration is released only after confirmed stop. Retire the old
			// runtime before reopening, even if its socket close is still in flight.
			this.clients.delete(ownerId);
			await owner.dispose();
		}
	}

	/** issue #145：打开转录前查重，禁止同一文件出现第二个 writer。 */
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

	/** 插件 steer 跨客户端兜底：除请求方外逐个问其他客户端的 conversations，
	 *  找到持有方由其执行 steer（只调 steerOwnConversation，不碰钩子，无递归）；
	 *  都找不到回 undefined，调用方回未知对话。单客户端异常跳过，不影响其他。 */
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
			} catch {
				// 单客户端坏了继续找下一个
			}
		}
		return undefined;
	}

	/** issue #193：定时任务唤醒发起对话。逐个客户端找持有方，用 steer 语义投递
	 *  （运行时插队、未跑时普通投递，不切用户当前对话）；都找不到回 ok:false，
	 *  调用方（index.ts executor）回落视口/无头执行。quiesced 时直接拒绝。
	 *  issue #226：成功时带回持有方 clientId（插件绑定网页会话时原样回执）。
	 *  issue #231：opts.sessionFile 是跨压缩/重启的稳定键 —— 优先按它认同一会话
	 *  （内存对话 id 重启即失效，压缩后同文件对话可能已换新 id，成功时带回**实际**
	 *  投递的 conversationId + sessionFile，调用方据此重绑定任务）；id 相位带 cwd
	 *  护栏（各客户端计数器都从 c1 开始，不校验会把报告投进无关项目）。压缩进行中
	 *  的持有方回 busy:true（调用方另寻视口兄弟，而不是当成“不在”静默转无头）。 */
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
			} catch {
				// 推送失败不影响已投递的唤醒
			}
		};
		// 相位一：落盘会话文件（稳定键）。同文件可能在多处打开，取最近活跃者；
		// 全部忙（压缩中）则报 busy，调用方去找视口兄弟。
		if (wantFile) {
			const hits: { cs: ClientSession; clientId: string; conv: Conversation }[] = [];
			for (const [clientId, cs] of this.clients) {
				try {
					const conv = cs.resolveSchedulerTarget({ sessionFile: wantFile });
					if (conv) hits.push({ cs, clientId, conv });
				} catch {
					// 单客户端坏了继续找下一个
				}
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
					// 非忙失败（投递异常）试下一个同文件持有方
				} catch {
					// 单客户端坏了继续找下一个
				}
			}
			if (hits.length > 0) {
				if (busyError) return { ok: false, busy: true, error: busyError };
				// 同文件持有方都在但都投递失败 —— id 相位大概率指向同一批，无需再试
				return { ok: false, error: "目标对话投递失败（持有方异常）" };
			}
			// 无同文件持有方 —— 老任务只有 id，继续相位二
		}
		// 相位二：内存对话 id（易失键，必须配 cwd 护栏防跨项目串台）。
		if (id) {
			const hits: { cs: ClientSession; clientId: string; conv: Conversation }[] = [];
			for (const [clientId, cs] of this.clients) {
				try {
					const conv = cs.resolveSchedulerTarget({
						conversationId: id,
						...(wantCwd ? { cwd: wantCwd } : {}),
					});
					if (conv) hits.push({ cs, clientId, conv });
				} catch {
					// 单客户端坏了继续找下一个
				}
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
				} catch {
					// 单客户端坏了继续找下一个
				}
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

	/** issue #231：同项目视口回退 —— 原绑定对话不在时，把唤醒投给该项目最近活跃
	 *  的对话（用户当前正看着的面），而不是静默转无头。excludeIds 跳过已知忙对话；
	 *  候选全部忙回 busy:true；无候选回 ok:false。成功带回实际投递方（调用方重绑定）。 */
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
			} catch {
				// 单客户端坏了继续找下一个
			}
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
					} catch {
						// 推送失败不影响已投递的唤醒
					}
					let f = "";
					try {
						f = String(c.conv.session.sessionFile ?? "");
					} catch {
						f = "";
					}
					return { ok: true, conversationId: c.conv.id, sessionFile: f, clientId: c.clientId };
				}
				if (r.busy) busyError = r.error;
			} catch {
				// 单客户端坏了继续找下一个
			}
		}
		if (busyError) return { ok: false, busy: true, error: busyError };
		return { ok: false, error: "同项目对话投递失败" };
	}

	/** issue #145：别处在某 cwd 下正在跑的对话（同项目并行感知用，不含请求方）。 */
	listProjectRunners(cwd: string, excludeClientId: string): ProjectRunnerInfo[] {
		const out: ProjectRunnerInfo[] = [];
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			for (const r of cs.streamingInCwd(cwd)) out.push({ clientId, title: r.title, sessionFile: r.sessionFile });
		}
		return out;
	}

	/** 按 SDK 会话（runtime 身份）找它当前归属的客户端会话与对话 id（过户后归属会变）：
	 *  桥接工具（问卷 / 页面）在调用瞬间用它投递，见 ClientSession.bridgeTarget。
	 *  一条对话任一时刻只属于一个会话（过户先摘后插），扫一遍即可 —— 问卷/截图都是
	 *  低频调用，不值得为此再维护一张全局索引。 */
	findConversationHome(sdkSession: AgentSession): { session: ClientSession; convId: string } | undefined {
		for (const cs of this.clients.values()) {
			try {
				const convId = cs.conversationIdOfSession(sdkSession);
				if (convId) return { session: cs, convId };
			} catch {
				// 单客户端坏了不影响解析
			}
		}
		return undefined;
	}

	/** Stable execution addresses resolve exactly; legacy display ids must be globally unique. */
	findSubagentOwner(convId: string): { session: ClientSession; convId: string } | undefined {
		// Local cN ids are not global addresses. Never let a transfer alias or
		// insertion order choose between clients owning the same display id.
		const matches: { session: ClientSession; convId: string }[] = [];
		for (const cs of this.clients.values()) {
			const current = cs.resolveExecutionAddress(convId);
			if (current) matches.push({ session: cs, convId: current });
		}
		return matches.length === 1 ? matches[0] : undefined;
	}

	/** issue #145：别处所有正在跑的对话（左栏 elsewhere 只读感知 + 手动过户用）。
	 *  owner/convId 标识过户目标（手动过户入口）；DSH 引擎不填（不可过户）。 */
	listExternalRunning(excludeClientId: string): ElsewhereRunning[] {
		// 1) 收集当前请求客户端自己持有的对话（按 sessionFile 与 cwd+title 双维度），
		// 本机已经持有的对话绝不作为 elsewhere 行推给本机（避免左栏同一对话既是“当前”又是“另一处”）。
		const currentCs = this.clients.get(excludeClientId);
		const localFiles = new Set<string>();
		const localCwdTitles = new Set<string>();
		if (currentCs) {
			for (const b of currentCs.takeoverBriefs()) {
				if (b.sessionFile) localFiles.add(resolve(b.sessionFile));
				localCwdTitles.add(`${b.cwd}\0${b.title}`);
			}
		}

		// 2) 遍历其他客户端，收集条目并按 sessionFile / cwd+title 去重。
		// 若多个客户端持有同会话（如断连竞争、多标签残留），保留正在运行（streaming）或有问卷的更活跃者，
		// 杜绝“一堆同一个对话的另一处”在左栏堆积。
		const dedupMap = new Map<string, ElsewhereRunning>();
		const now = Date.now();

		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			// 伪客户端（scheduler:/plugin:）不走浏览器，sinkCount 永远为 0，保留。
			const isPseudo = isSharedExecutionClientId(clientId);
			// 无浏览器连接的残骸（sinkCount=0 = 断连留存）：宽限期内仍下发（标
			// ownerOffline，可接管），过期或 TTL=0 时按 issue #291 不入列表。
			const offline = !isPseudo && cs.sinkCount() === 0;
			if (offline && OFFLINE_ROW_TTL_MS <= 0) continue;
			const offlineSince = offline ? (this.offlineSince.get(clientId) ?? 0) : 0;

			for (const r of cs.streamingSummariesAll()) {
				// activity 只服务宽限期判定，不进 wire（ElsewhereRunning 无此字段）。
				const { activity, ...rest } = r;
				if (offline && !rest.isStreaming) {
					// 宽限期从「断开时刻」与「最后一次活动」里取较晚者：跑动的后台任务
					// 每有事件就续期，不会跑到一半从别人列表里消失。
					const latest = Math.max(offlineSince, activity || 0);
					if (latest > 0 && now - latest > OFFLINE_ROW_TTL_MS) continue;
				}
				const normFile = rest.sessionFile ? resolve(rest.sessionFile) : undefined;
				// 本机已持有该会话文件，或本机在同项目下已有同名可见对话：排除
				if (normFile && localFiles.has(normFile)) continue;
				if (rest.independent !== false && localCwdTitles.has(`${rest.cwd}\0${rest.title}`)) continue;

				const entry: ElsewhereRunning = {
					...rest,
					owner: clientId,
					...(isPseudo ? { pseudo: true as const } : {}),
					...(offline ? { ownerOffline: true as const } : {}),
				};

				// 跨客户端去重键：有文件按规范路径去重，无文件按 cwd + title 去重
				const dedupKey = normFile
					? `file:${normFile}`
					: rest.independent === false
						? `shared:${JSON.stringify([clientId, rest.convId])}`
						: `title:${rest.cwd}\0${rest.title}`;
				const existing = dedupMap.get(dedupKey);
				if (existing) {
					// 优先保留 streaming，其次保留 hasQuestion，最后才轮到离线行让位在线行
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

	/** 离线行宽限期到期 → 让其他客户端重推一次（行随之从列表消失，回到 #291 口径）。
	 *
	 *  到期时刻取「断开时刻」与「最后一次活动」的较晚者：断开后 run 还在跑的后台任务
	 *  每有流式变化都会重排（见 pokeExternalRunning），跑完那一刻的推送把宽限期从新起算。
	 *  到期回调只推送、**不再重排**，否则「行已过期」会被无限排成 1s 轮询。 */
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
			// 期间重连/被认领/被回收都算作废：只推真实还存在的离线残骸。
			if (this.clients.get(clientId) === cs && !AgentService.isPseudoClientId(clientId) && cs.sinkCount() === 0) {
				this.notifyExternalRunning(clientId);
			}
		}, delay);
		timer.unref?.();
		this.offlineTimers.set(clientId, timer);
	}

	/** 又有浏览器连上（或残骸被认领/回收）：离线行状态作废，别的页面按在线行重推。 */
	private clearOfflineRows(clientId: string): void {
		const had = this.offlineSince.delete(clientId);
		const timer = this.offlineTimers.get(clientId);
		if (timer) {
			clearTimeout(timer);
			this.offlineTimers.delete(clientId);
		}
		if (had) this.pokeExternalRunning(clientId);
	}

	/** issue #291：删除定时任务后回收对应伪客户端，避免残留在 elsewhere 列表。 */
	releaseSchedulerClient(taskId: string): void {
		const safe = String(taskId ?? "").replace(/[^A-Za-z0-9_-]/g, "") || "task";
		const clientId = `scheduler:${safe}`;
		const cs = this.clients.get(clientId);
		if (!cs) return;
		// 伪客户端常驻一个 noop sink（chatFromScheduler 的 attach），所以不能按
		// sinkCount 判断「有没有浏览器」—— 它永远为 1。这里就是它的回收点。
		this.clients.delete(clientId);
		// 先摘出 map 再异步 dispose：只删 map 的话，对话的 runtime/终端/看门狗
		// 计时器全都留在内存里（泄漏），转录还挂着活 writer（同文件双写者风险）。
		void cs.dispose().catch(() => {
			// 回收失败不拦主流程：尽力而为，进程退出时 OS 兜底
		});
		// 通知其他客户端刷新 elsewhere 列表。
		this.pokeExternalRunning(clientId);
	}

	/** issue #145: 某客户端流式集合变化 → 其他客户端重推 conversations。 */
	pokeExternalRunning(excludeClientId: string): void {
		// 离线残骸刚有状态变化（run 跑完 / 又有事件）：离线行宽限期重新起算，
		// 定时器顺延到「最后一次活动 + TTL」——否则任务跑完后再没人推它。
		const offlineCs = this.clients.get(excludeClientId);
		if (offlineCs && !AgentService.isPseudoClientId(excludeClientId) && offlineCs.sinkCount() === 0) {
			this.armOfflineRowExpiry(excludeClientId, offlineCs);
		}
		this.notifyExternalRunning(excludeClientId);
	}

	/** 只让其他客户端重推一次（不碰离线宽限期定时器）。 */
	private notifyExternalRunning(excludeClientId: string): void {
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			try {
				cs.refreshExternalRunning();
			} catch {
				// 单客户端坏了不影响其他
			}
		}
	}

	/** issue #145：向除请求方外的所有客户端发一条 notice（并行通告用）。 */
	notifyClientsExcept(
		excludeClientId: string,
		msg: { type: "notice"; level: "info" | "warning" | "error"; text: string; textEn?: string },
	): void {
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			try {
				// 经 ClientSession.emit 才能进该客户端的 sink 组播；用公开发送面。
				cs.sendNotice(msg);
			} catch {
				// 单客户端坏了不影响其他
			}
		}
	}

	/** Aggregate across every client session: conversations with in-flight runs. */
	activeConversations(): number {
		let n = 0;
		for (const cs of this.clients.values()) n += cs.activeConversations();
		return n;
	}

	/** Aggregate across every client session: messages queued in the SDK. */
	pendingMessages(): number {
		let n = 0;
		for (const cs of this.clients.values()) n += cs.pendingMessages();
		return n;
	}

	/** 插件用：全客户端最近活跃对话的快照（#542：按 clientId 取某个标签页正在看的
	 *  对话；缺省回落「最近活跃的**非子代理**会话」——子代理跑得再勤也不会把用户
	 *  正在看的对话挤出快照）。clientId 不认识/该客户端暂无对话时同样走回落。 */
	readConversationForPlugins(opts?: PluginConversationQuery): PluginConversationSnapshot | null {
		const want = (opts?.clientId ?? "").trim();
		if (want) {
			const cs = this.clients.get(want);
			if (cs) {
				try {
					// 显式客户端：返回它**真正在看**的对话（含子代理对话——那是事实，
					// 快照带 isSubagent 由插件自己判）。
					const s = cs.readConversationForPlugins({ preferActive: true, includeSubagents: true });
					if (s) return s;
				} catch {
					/* 单客户端坏了不影响回落 */
				}
			}
		}
		const snaps: (PluginConversationSnapshot | null)[] = [];
		for (const cs of this.clients.values()) {
			try {
				snaps.push(cs.readConversationForPlugins());
			} catch {
				/* 单客户端坏了不影响其他 */
			}
		}
		return pickLatestClientSnapshot(snaps);
	}

	/** 插件无头调用（host.chat 的落地）：外部通道（微信等）把文本投给 agent。
	 *  每个 (pluginId, accountId) 独立伪客户端——复用 attach 完整链路
	 *  （会话恢复/持久化/工具注入/快照），无浏览器也能跑；sink 是空函数，
	 *  快照/notice 发了即丢，不攒内存。fire-and-forget：prompt 投递即返回，
	 *  运行结果经 onRunEvent(run_end) 按 conversationId 关联。
	 *  v1 语义：与该服务 cwd 下最近会话共享（单用户视角连续）；peer 名由插件
	 *  拼进文本前缀，per-peer 会话隔离以后再加。
	 *  issue #226：对齐定时任务的四件套——conversationId 命中时走 steer 语义
	 *  投递（网页端实时可见，miss 则回落无头）；cwd 显式 pin 住（不存在/系统
	 *  目录即拒绝，不默默跑错目录）；model/thinkingLevel 投递前应用（失败即
	 *  拒绝，不回落，避免账单/效果与预期不符）。 */
	async chatFromPlugin(pluginId: string, req: PluginChatRequest): Promise<PluginChatResult> {
		const safe = String(pluginId ?? "plugin").replace(/[^A-Za-z0-9_-]/g, "") || "plugin";
		const acct = String(req?.accountId ?? "default").replace(/[^A-Za-z0-9_-]/g, "") || "default";
		const clientId = `plugin:${safe}:${acct}`;
		const text = String(req?.text ?? "");
		const attachments = normalizePluginChatAttachments(req?.attachments);
		if (!text.trim()) throw new Error("chatFromPlugin: text 为空");
		if (this.quiesced) throw new QuiesceRejectedError("插件无头调用被拒绝，请等服务器恢复后重试");
		// 本轮运行的稳定标识：随该轮所有 run 事件下发。为何需要：过户会把对话搬到
		// 别的客户端会话（clientId 变），目标会话已有同名 id 时还会就地改名
		// （conversationId 变）——两个键全失效，通道插件靠它认领自己的回包。
		const runId = `pr-${randomUUID()}`;
		// 1. 绑定已有会话：steer 语义投递，网页端实时可见（微信当远程遥控器用）。
		// miss/已回收时不抛错，回落无头伪客户端（浏览器关着时微信照常可用）。
		const target = String(req?.conversationId ?? "").trim();
		if (target) {
			// Conversation ids are local to a client. Prefer this channel's own
			// client; otherwise require an unambiguous target instead of guessing.
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
					// Apply overrides only when the captured conversation is active;
					// these APIs address the owner's active conversation.
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
		// 2. 工作空间：不传回落伪客户端当前目录；传了必须存在且非系统目录。
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
		// 打运行 token（没真跑起来就不认领，不会污染用户自己下一轮的事件归属）。
		let stampedId = "";
		try {
			stampedId = cs.markPluginRun(runId);
		} catch {
			/* 打标尽力而为 */
		}
		const conversationId = stampedId || (cs.readConversationForPlugins()?.conversationId ?? "");
		const conv = cs.getConversation(conversationId);
		void cs.prompt(text, attachments, false, conv).catch((err) => console.error("[plugin chat] prompt failed", err));
		return { conversationId, clientId, sessionId: conv?.session.sessionId, runId };
	}

	/** Abort by the stable plugin run token, including after conversation takeover. */
	async abortPluginRun(runId: string): Promise<{ ok: boolean; error?: string }> {
		for (const owner of this.clients.values()) {
			if (owner.findPluginRun(runId)) return owner.abortPluginRun(runId);
		}
		return { ok: false, error: "Plugin run is no longer active" };
	}

	/** 内置定时任务的无头执行（issue #184，server/scheduler-tasks.ts 的 executor）。
	 *  每个任务独立伪客户端 `scheduler:<taskId>`（专属会话连续、无浏览器也能跑）；
	 *  cwd 按任务配置 pin 住（不存在即失败，不默默跑错目录）；可选模型/思考强度
	 *  在投递前应用（失败即返回错误，不回落，避免账单/效果与预期不符）。
	 *  fire-and-forget 投递后等待运行结束（最长 10 分钟轮询），回填真实 outcome
	 * （成功/失败/耗时/会话 id）供历史记录与通知使用；超时按失败记录（运行本身
	 *  不中止，继续在后台跑完）。 */
	async chatFromScheduler(task: {
		id: string;
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
			void cs.prompt(`[定时任务] ${text}`);
			// 等待运行结束：每 2s 轮询，最长 10 分钟。超时按失败记录（运行继续）。
			const deadline = Date.now() + 10 * 60 * 1000;
			for (;;) {
				await new Promise((r) => setTimeout(r, 2000));
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
				if (Date.now() >= deadline)
					return { ok: false, conversationId: conversationId || undefined, error: "运行超时（10 分钟），仍在后台继续" };
			}
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	/** 插件直调模型（host.llm.complete 的落地）：孤立无工具的一次性补全。
	 *  不建对话、不进历史、不碰任何会话状态；花费走用户自己的模型额度。
	 *  quiesced 时拒绝；无客户端时用进程 cwd + 默认模型照常跑。 */
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

	/** index.ts calls this when a browser socket opens/closes. */
	noteSocketOpen(): void {
		this.socketCount += 1;
	}
	noteSocketClose(): void {
		this.socketCount = Math.max(0, this.socketCount - 1);
	}

	/** Full status for the control socket / `server status` command. */
	serviceStatus(): {
		pid: number;
		version: string;
		cwd: string;
		quiesced: boolean;
		quiescedSince?: number;
		connectedClients: number;
		activeConversations: number;
		pendingMessages: number;
		/** 托管本实例的平台服务（null = 前台/dev/Docker）——CLI 的
		 *  `server status` 据此显示启动方式，见 launch-origin.ts。 */
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

	// （原 private static isPseudoClientId 已抽到模块级导出并挂为 static 属性）

	/**
	 * 浏览器重启认领：给 fresh clientId 找一个可接管的断开残留会话（返回旧 id）。
	 * 有别的在线浏览器时返回 null（issue #10 隔离优先）。
	 * 全同步：attach 里的认领段不含 await，并发的新标签后到者看到 sinkCount>0，
	 * 不会抢走同一个残留。
	 */
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

	/**
	 * 跨客户端感知接线（同会话查重 / 同项目并行 / elsewhere 列表 / 跨端 steer）。
	 * attach 尾部与认领分支共用 —— 认领换了 map 键，必须在首帧推送（attachSink）
	 * 前就按新 id 重接，否则 self-exclusion 失效：把自己当成“另一处”（elsewhere
	 * 误报 + prompt/switch 自拦）。尾部会再调一次，幂等。
	 */
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
		// B20：过户后 subagent 工具族的跨会话解析（旧 host 闭包搬不动，按 id 现查持有方）。
		cs.findSubagentOwner = (convId) => this.findSubagentOwner(convId);
		cs.allSubagentSessions = () => [...this.clients.values()];
		cs.listExternalRunning = () => this.listExternalRunning(clientId);
		cs.notifyExternalClients = (msg) => this.notifyClientsExcept(clientId, msg);
		cs.onRunningChanged = () => this.pokeExternalRunning(clientId);
		cs.steerConversationElsewhere = (id, text) => this.steerElsewhere(clientId, id, text);
		cs.schedulerStore = this.schedulerStore;
	}

	/**
	 * 手动过户（take_over_conversation）：把 owner 会话的某主对话（含子代理后代、
	 * 等答复问卷/页调用）整体搬到 target 会话并切过去。搬的是 runtime 本体不是
	 * 副本，单 writer 不变 —— 从在线标签页手里接管也是安全的；源会话修好 active
	 * 并推全量刷新，双方都收到去向通知。quiesce 排空期也放行（重连既有工作）。
	 */
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
			// 自己的对话 → 退化为普通切换。
			try {
				await target.switchConversation(convId);
			} catch {
				/* switch 内部已用 notice 报错 */
			}
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
		// 容量：与 switchSession 同口径（目标项目非子代理且非临时会话 8 个）。
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
			// 测试专用故障注入（默认情况下一行不生效）：让「接进目标」这一步必错，用来回归
			// 「过户夭折不得变成幽灵」（tests/takeover-rollback-test.mjs）。
			let newMainId: string;
			try {
				if (process.env.PI_WEB_TEST_TAKEOVER_FAIL_INSERT === "1") throw new Error("injected takeover insert failure");
				newMainId = target.insertTakeoverConvs(detached.payload);
				await target.switchConversation(newMainId);
				await target.bindSession();
			} catch (err) {
				// 夭折回滚：对话已经从源会话摘下来了（源侧 map 已删、订阅已断），接进目标或切换失败就是
				// 「还在跑但谁的列表里都没有」的幽灵 —— 只有重启服务才能靠落盘恢复（issue #556）。
				// 原样搬回源会话，两边都拿到诚实的回执。
				const where = await this.returnTakeoverPayload(source, target, detached.payload);
				console.error("[takeover] insert/activate failed, payload returned to", where, err);
				if (where === "source") {
					// 源页面也得知道发生了什么：它的对话刚才静默地从列表里消失过一瞬间。
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
			// 源会话修好 active（detach 内部已处理）→ 推全量刷新 + 告知去向；
			// 无 sink 时 emit 即丢，无需判断。
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

	/**
	 * 过户夭折回滚：把已经摘下来的对话搬回源会话（及其运行列表）。
	 *
	 * 为什么要它：detach 与 insert 之间是唯一的空档期 —— 源侧已经删了 map、断了订阅，
	 * 一旦 insert 报错，对话就两头不挂，但 runtime 还在跑（“幽灵会话”，只有重启服务
	 * 才能靠落盘会话恢复，issue #556）。这里用同一套 insert 接线原样搬回去。
	 *
	 * 搬不回去（二次失败，理论上不该发生）时把它们**留在目标会话**：宁可留在新页面
	 * 的运行列表里（insert 已给主对话置 listed），也绝不落到“没人持有”的空档。
	 * 返回最终归属方，调用方据此给用户出对应文案。
	 */
	private async returnTakeoverPayload(
		source: ClientSession,
		target: ClientSession,
		payload: TakeoverPayload,
	): Promise<"source" | "target"> {
		// 先摘掉已部分插进目标的残留（不 dispose：runtime 要原样搬）。
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
			} catch {
				/* 双失败：对象还在 payload 里，不要再次搬运 —— 不抛，不让 handler 崩 */
			}
			return "target";
		}
	}

	/**
	 * 跨页作答预告（peek_elsewhere_question）：把 owner 会话里某对话的等答复问卷
	 *  原文取回 target 页展示。只读，不搬迁对话；问卷已不在则直说（并刷新左栏）。
	 */
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
		if (ownerId === targetId) return; // 自己的问卷走本地通道，不需要预告
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

	/**
	 * 跨页作答（question_answer 带 owner）：把本页提交的答案送到持有方会话。
	 * 问卷已不在（对方刚回答/取消）则明确告知，答案不吞不丢两不沾 —— 没送出就是没送出。
	 */
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
		const source = this.clients.get(ownerId);
		const ok = source ? source.resolveQuestion(id, answers, cancelled, cancelReason) : false;
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

	/** Locate the live request again after takeover; conversation IDs may have changed. */
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

	/** Get or create the session for a client, racing attach calls safely. */
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
				// 浏览器重启认领（clientId 存 sessionStorage，关浏览器即失；服务端残留
				// ClientSession 的运行中对话否则永远卡在“另一处”只读，连看都看不了）：
				// 无其他在线浏览器时，把最近断开的残留会话整体过户给这个新 id
				// （只换 map 键，不搬 runtime：对话/终端/订阅/cwd 原样保留，
				// 流式增量经尾部 attachSink 直接推给新 socket）。
				// 有其他在线标签时不认领（issue #10 隔离优先）；quiesce 排空期也放行
				// （这是重连既有工作，不是新工作）。本段无 await，并发 attach 原子。
				// 伪客户端（含 device-task- 私有 Bot capability）绝不认领；
				// 候选端同样排除伪客户端，禁止浏览器接管 Bot 或新任务复用旧 capability。
				const orphan = isOrphanAdoptionExcludedClientId(clientId) ? null : this.findAdoptableOrphan(clientId);
				if (orphan) {
					this.clients.delete(orphan.oldId);
					// 残骸被本页认领：它的离线行状态随 id 作废（行归到新 id 名下）。
					this.clearOfflineRows(orphan.oldId);
					this.clients.set(clientId, orphan.cs);
					cs = orphan.cs;
					// 先按新 id 重接（首帧 attachSink 的 elsewhere/self-exclusion 依赖它）。
					this.wireClient(cs, clientId);
					cs.noteAdopted();
					// 服务重启前记在旧 id 名下的中断记录搬到新 id 名下，尾部
					// resumeInterrupted 按新 id 消费（只认领一次，不重复恢复）。
					const inter = this.stateStore.takeInterrupted(orphan.oldId);
					if (inter?.length) this.stateStore.saveInterrupted(clientId, inter);
				} else {
					// Restore this client's last-used workspace when it still exists;
					// Admission gate: while quiesced, only clients with an EXISTING
					// session may attach (they can watch their runs drain); brand-new
					// clients are refused — index.ts closes their socket (4403) and the
					// browser reconnect loop retries after admission reopens.
					if (this.quiesced) {
						throw new QuiesceRejectedError("新连接被拒绝，请等服务器恢复后重试");
					}
					// otherwise fall back to the server's configured default cwd.
					let cwd = this.cwd;
					const saved = this.stateStore.get(clientId);
					if (saved.lastCwd && saved.lastCwd !== this.cwd) {
						if (isRemoteWorkspaceUri(saved.lastCwd)) {
							cwd = saved.lastCwd;
						} else {
							try {
								// issue #295：异步 stat —— 同步 stat 落在坏挂载（已卸载的外部卷/
								// autofs 触发点）上会在内核里挂起，冻住整个事件循环（含控制
								// socket 与其他客户端的心跳）；异步版本只挡本连接，超时提示照发。
								const { stat } = await import("node:fs/promises");
								if ((await stat(saved.lastCwd)).isDirectory()) cwd = saved.lastCwd;
							} catch {
								// gone (unmounted drive / deleted / hanging mount) — fall back to the default
							}
						}
					}
					// Sessions use the SDK default per-project dir — no per-client dir.
					// issue #145：新标签页默认恢复项目最近的会话 —— 若那条仍被别处持有
					// （跑着或空闲），建之前就决定空白（第二个 writer 根本不会被打开，
					// 也无需事后拆 runtime）。之前只拦 running：空闲持有照样恢复出双
					// writer，两边轮流发送分叉历史。其他客户端不存在时不扫目录。
					let createOpts: { blank?: boolean; blankTitle?: string; idleHeld?: boolean } | undefined;
					const requiresBlankSession = isOrphanAdoptionExcludedClientId(clientId);
					if (requiresBlankSession) {
						// 伪客户端（插件、调度、Canvas、Bot）：禁止自动恢复工作区历史或旧任务，强制空白
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
						} catch {
							// 列表失败不挡正常恢复
						}
					}
					const creating = ClientSession.create(clientId, cwd, this.stateStore, createOpts).finally(() => {
						this.pending.delete(clientId);
					});
					this.pending.set(clientId, creating);
					cs = await creating;
					this.clients.set(clientId, cs);
					// issue #145 接线提前：首帧 elsewhere 依赖它。
					this.wireClient(cs, clientId);
					// Make sure the restored/default workspace appears in the project list.
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
		// First attach after a restart: reopen sessions that were streaming
		// when the previous process shut down and continue them (consumed
		// once, then cleared). Fire-and-forget AFTER attachSink + hooks:
		// resume emits directly to sinks and needs the owner guards.
		// Progress arrives over the socket as usual.
		const detachedSinks = this.pendingDetaches.get(clientId);
		if (detachedSinks?.has(send)) {
			detachedSinks.delete(send);
			if (detachedSinks.size === 0) this.pendingDetaches.delete(clientId);
			if (clientId.startsWith("device-task-") && !isBotExecutionRegistered(clientId) && cs.sinkCount() === 0) {
				this.clients.delete(clientId);
				await cs.dispose();
				return cs;
			}
		} else {
			cs.attachSink(send);
			this.resumeSharedConversation(clientId, sendShared);
			if (!isSharedExecutionClientId(clientId)) send(this.globalInteractions());
			// 又有浏览器连上：离线行状态作废（别的页面按在线行重推，去掉离线标记）。
			this.clearOfflineRows(clientId);
		}
		// Forward hooks (set once by index.ts) to every session.
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
		// issue #145 跨客户端感知接线（同会话查重 / 同项目并行 / elsewhere 列表）。
		this.wireClient(cs, clientId);
		// 插件宿主工作区跟随：初次接入也同步一次（恢复的 lastCwd 可能≠服务启动目录），
		// notifyCwd 幂等去重；此后 set_cwd 成功时由 cs.onCwdChanged 继续驱动。
		cs.onCwdChanged = (abs, roots) => this.onClientCwdChanged?.(abs, roots);
		this.onClientCwdChanged?.(cs.cwd, cs.workspaceRoots);
		void cs.resumeInterrupted(this.stateStore.takeInterrupted(clientId));
		return cs;
	}

	/** 插件 AI 工具集合变化（注册/注销）时由 index.ts 触发：推送到所有客户端的全部会话。 */
	applyPluginAgentTools(): void {
		for (const cs of this.clients.values()) cs.refreshPluginTools();
	}

	mcpProjectCwds(): string[] {
		return [...new Set([...this.clients.values()].flatMap((cs) => cs.mcpProjectCwds()))];
	}

	/** Runtime initialization/reload also updates management UI, including clients without conversations. */
	refreshMcpProject(cwd: string): void {
		for (const cs of this.clients.values()) {
			if (resolve(cs.cwd) !== resolve(cwd)) continue;
			cs.broadcastMcpServers();
			cs.pushSettings();
		}
	}

	/** Browser UI locale report (hello.locale / set_locale): persist per client
	 *  and refresh lang-aware prompts (streaming-safe via ClientSession). */
	async setLocale(clientId: string, locale: string): Promise<void> {
		const cs = this.clients.get(clientId);
		if (cs) {
			await cs.setLocale(locale);
			return;
		}
		// hello race: session still being created — wait for it, then apply.
		const inflight = this.pending.get(clientId);
		if (inflight) {
			try {
				await (await inflight).setLocale(locale);
			} catch {
				/* attach failed — nothing to apply to */
			}
		}
	}

	/** 插件斜杠命令集合变化时由 index.ts 触发：重推各客户端的命令目录。 */
	applyPluginCommandCatalog(): void {
		for (const cs of this.clients.values()) void cs.pushSlashCommands();
	}

	/** 插件内联标记变化时由 index.ts 触发：重推各客户端 markers 与设置状态。 */
	applyPluginMarkers(): void {
		for (const cs of this.clients.values()) cs.refreshPluginMarkers();
	}

	/** 插件常驻后台任务变化时由 index.ts 触发：重推各客户端的 bg_servers。 */
	refreshBackgroundServers(): void {
		for (const cs of this.clients.values()) cs.refreshBgTasks();
	}

	/** Remove a socket from a client's broadcast set (called on socket close). */
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
					// Bot registration is released only after the executor confirms stop.
					// Keep uncertain/disconnected executions owned until that confirmation.
					this.clients.delete(clientId);
					void cs.dispose().catch(() => {});
					return;
				}
				// 最后一个 sink 断开 = 该客户端不再在线 → 它的行从「另一处」变成「另一处
				// （离线）」。立刻让其他客户端重推一次补上离线标记；宽限期
				// （OFFLINE_ROW_TTL_MS）到期后再推一次，行随之消失（issue #291 的
				// 「残骸不永久占位」仍然成立）。
				if (!AgentService.isPseudoClientId(clientId)) {
					this.offlineSince.set(clientId, Date.now());
					this.pokeExternalRunning(clientId);
					this.armOfflineRowExpiry(clientId, cs);
				}
			}
		} else if (this.pending.has(clientId)) {
			// 连接在 attach 异步创建期间断开：记录待 detach 的 sink，attach 完成后清理，避免死连接泄漏
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

	/** 插件扩展点 v2：挑一个最合适的客户端会话供无浏览器调用的插件 API 用
	 *  （conversationLister/Searcher/Writer、modelLister、runAborter）。
	 *  有运行中对话的优先，否则任意残留客户端；一个没有时返回 undefined，
	 *  调用方（index.ts 注入）回退空列表 / {ok:false}，绝不抛错。 */
	pluginClient(): ClientSession | undefined {
		let fallback: ClientSession | undefined;
		for (const cs of this.clients.values()) {
			if (!fallback) fallback = cs;
			try {
				if (cs.activeConversations() > 0) return cs;
			} catch {
				// 单客户端坏了不影响挑选
			}
		}
		return fallback;
	}

	/** Snapshot still-streaming conversations for post-restart resume.
	 *  Called during graceful shutdown AND from the restart_service handler
	 *  (which exits without shutdown under systemd — without this, the
	 *  interrupted-run record would silently never be written there). */
	recordInterruptedRuns(): void {
		// Record still-streaming conversations BEFORE tearing anything down, so
		// the next attach can tell the user what was lost (SIGTERM / update).
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
			} catch {
				// best effort — never block shutdown on bookkeeping
			}
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
