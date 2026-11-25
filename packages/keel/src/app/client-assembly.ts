import type { ClockPort, TransportPort } from "../contracts/ports.js";
import type { ModelAdminPort } from "../contracts/model-admin.js";
import type { SettingsStorePort } from "../contracts/settings-store.js";
import type { PluginAgentToolFilter } from "../adapters/tools/plugin-agent-tools.js";
import type { PluginToolsBinder } from "./plugin-tools-binder.js";
import type { GoalRunPort } from "../contracts/goals.js";
import { createGoalRunSinks } from "../domains/goals/index.js";
import { isInsideSessionsDir } from "../session-search.js";
import type { createProjectSource } from "../adapters/state/index.js";
import { createModelMemory } from "../adapters/state/model-memory.js";
import { conversationViewFromSession } from "../adapters/sdk/view.js";
import type { PluginRunEvent, PluginToolEvent } from "../contracts/plugin.js";
import { ChatModeState, PresetState } from "../domains/tools/index.js";
import { NativeCliConversations } from "../domains/native-cli/index.js";
import { conversationPresetViewOf } from "./preset-handlers.js";
import {
	InteractionInbox,
	createApprovalWaiter,
	createAskUserWaiter,
	type AskUserWaiter,
} from "../domains/interactions/index.js";
import { renameSessionFile } from "../adapters/sdk/session-info.js";
import { createTerminalHost } from "../domains/terminals/index.js";
import type { SubagentRuntime } from "./subagent-runtime.js";
import { DEFAULT_PI_CAPABILITIES } from "../engine-capabilities.js";
import type { ElsewhereRunning, ServerMessage } from "../protocol.js";
import type { MobileNotificationEvent } from "../mobile-notification-events.js";
import { ClientRuntime } from "./client-runtime.js";
import type { SessionRegistry } from "./session-registry.js";
import { createEngineSessionRegistry } from "./engine-sessions.js";
import type { Conversation } from "../kernel/conversation/index.js";
import { CoreEngineNotReadyError } from "../contracts/core-engine-errors.js";
import type { ServerLang } from "../i18n.js";
import { createHostFaces, type HostFaces } from "./host-faces.js";
import type { FrameSender } from "./core-engine.js";
import { checkHeldSessionNotice } from "./engine-elsewhere.js";
import { BashKills } from "../domains/background/index.js";
import { collectQueuedQuestions } from "./engine-takeover.js";
import type { CoreEngineOptions } from "./core-engine-options.js";
import type { EngineService } from "../engine-service.js";

const systemClock: ClockPort = {
	now: () => Date.now(),
	after: (ms, fn) => {
		const timer = setTimeout(fn, ms);
		return () => clearTimeout(timer);
	},
};

export interface ClientAssemblyContext {
	clientId: string;
	cwd: string;
	options: CoreEngineOptions;
	stateStore: SettingsStorePort;
	projectSource: ReturnType<typeof createProjectSource>;
	pluginTools: PluginToolsBinder;
	deliverTo: (clientId: string, msg: ServerMessage) => void;
	runtimes: Map<string, ClientRuntime>;
	sockets: ReadonlyMap<string, Set<FrameSender>>;
	askWaiters: Map<string, AskUserWaiter>;
	modelAdminPort: () => ModelAdminPort | undefined;
	langOf: (clientId: string) => ServerLang;
	setLang: (clientId: string, lang: ServerLang) => void;
	listExternalRunning: (clientId: string) => ElsewhereRunning[];
	notifyExternalRunning: (clientId?: string) => void;
	toolGuard?: EngineService["toolGuard"];
	pluginToolFilter: (cid: string, conv: Conversation) => PluginAgentToolFilter;
	onToolEvent?: ((ev: PluginToolEvent) => void) | undefined;
	onRunEvent?: ((ev: PluginRunEvent) => void) | undefined;
	onClientCwdChanged?: ((cwd: string, roots: string[]) => void) | undefined;
	onTurnSettledOffline?: ((clientId: string, runtime: ClientRuntime) => void) | undefined;
	onConversationChanged?: (() => void) | undefined;
	onNotificationEvent?: (event: MobileNotificationEvent) => void | Promise<void>;
	pluginCommandsProvider?: EngineService["pluginCommandsProvider"];
	pluginBgTasksProvider?: EngineService["pluginBgTasksProvider"];
	pluginStopBgTask?: EngineService["pluginStopBgTask"];
	notifyPluginModelChange: (clientId: string, conversationId: string) => void;
	subagentsRegistry?: import("../domains/subagents/registry.js").SubagentRegistry;
	findSessionOwner?: (
		sessionFile: string,
		excludeClientId?: string,
	) => { title: string; isStreaming: boolean } | undefined;
	checkParallelWork?: (clientId: string, conv: Conversation | undefined) => void;
}

export function assembleClient(ctx: ClientAssemblyContext): {
	runtime: ClientRuntime;
	faces: HostFaces;
	sessions: SessionRegistry;
	deliver: (msg: ServerMessage) => void;
} {
	const { clientId, cwd, options, stateStore } = ctx;
	let runtime!: ClientRuntime;
	let faces!: HostFaces;
	let subagents: SubagentRuntime | undefined;
	let goalPort: GoalRunPort | undefined;

	const deliver = (msg: ServerMessage) => ctx.deliverTo(runtime?.clientId ?? clientId, msg);
	const transport: TransportPort = {
		send: deliver,
		isClosed: () => !ctx.runtimes.has(runtime?.clientId ?? clientId),
	};

	const terminalHost = createTerminalHost({
		transport,
		cwdOf: (conversationId) => runtime.registry.get(conversationId)?.meta.cwd ?? cwd,
		lang: () => ctx.langOf(clientId),
		createManager: (input) => {
			const factory = options.terminalManager;
			if (!factory) throw new CoreEngineNotReadyError("terminal.manager");
			return factory(input);
		},
	});

	const chatModes = new ChatModeState();
	const cliConversations = new NativeCliConversations();
	const presets = new PresetState();
	const bashKills = new BashKills();
	const inbox = new InteractionInbox(() => {});
	const approvalWaiter = createApprovalWaiter({ inbox, transport });
	const askWaiter = createAskUserWaiter({
		inbox,
		transport,
		onChanged: () => {
			runtime.pushQuestionQueue();
			runtime.pushConversations();
			runtime.publisher.flush({ forceFull: true });
			ctx.notifyExternalRunning(clientId);
			for (const r of ctx.runtimes.values()) {
				if (r !== runtime) r.pushQuestionQueue();
			}
		},
	});
	ctx.askWaiters.set(clientId, askWaiter);

	const sessions = createEngineSessionRegistry({
		agentDir: options.agentDir ?? cwd,
		cwd,
		clientId,
		stateStore,
		chatModes,
		presets,
		bashKills,
		subagents: () => subagents,
		askWaiter,
		findAskWaiter: (cid) => ctx.askWaiters.get(cid),
		findRuntime: (cid) => ctx.runtimes.get(cid),
		approvalWaiter,
		transport,
		pluginTools: ctx.pluginTools,
		pluginToolFilter: (cid, conv) => ctx.pluginToolFilter(cid, conv),
		toolGuard: () => ctx.toolGuard,
		remoteOpsOf: options.remoteOpsOf,
		langOf: (cid) => ctx.langOf(cid),
		mcpProjects: options.mcpProjects,
		bots: options.bots,
		getRuntime: () => runtime,
		getFaces: () => faces,
		onToolEvent: (ev) => ctx.onToolEvent?.(ev),
		onRunEvent: (ev) => ctx.onRunEvent?.(ev),
	});

	runtime = new ClientRuntime({
		clientId,
		cwd,
		workspaceRoots: stateStore.getWorkspaceRoots(clientId, cwd),
		clock: systemClock,
		transport,
		sessions,
		turnEvents: {
			onStreamingChanged: (conversationId, streaming) => {
				runtime.pushConversations();
				ctx.notifyExternalRunning(runtime.clientId);
			},
			onTurnSettled: (conversationId, outcome) => {
				subagents?.settle(conversationId, outcome === "done" ? "done" : outcome === "aborted" ? "stopped" : "failed");
				goalPort?.onTurnSettled?.(conversationId, outcome);
				runtime.pushConversations();
				ctx.notifyExternalRunning(runtime.clientId);
				if ((ctx.sockets.get(runtime.clientId)?.size ?? 0) === 0) {
					ctx.onTurnSettledOffline?.(runtime.clientId, runtime);
				}
			},
		},
		goalRun: options.goalRun
			? (hooks) =>
					(goalPort = options.goalRun!(
						createGoalRunSinks({
							runtime,
							sessions,
							resolveModel: (provider, id) => faces.resolveModel(provider, id),
							emit: deliver,
							isDisposed: () => ctx.runtimes.get(clientId) !== runtime,
							getLang: () => ctx.langOf(clientId),
							...(hooks?.setPlan ? { setPlan: hooks.setPlan } : {}),
						}),
					))
			: undefined,
		getLang: () => ctx.langOf(clientId),
		resolveToolApproval: (id, decision, editedParams, reason) =>
			approvalWaiter.resolve(id, decision, editedParams, reason),
		resolveQuestion: (id, answers, cancelled, cancelReason) => askWaiter.answer(id, answers, cancelled, cancelReason),
		answerQuestion: async (id, answers, cancelled, cancelReason) => {
			askWaiter.answer(id, answers, cancelled, cancelReason);
		},
		persistSessionTitle: (sessionFile, title) => void renameSessionFile({ sessionFile, title }),
		settingsFrame: () => faces.settingsFrame,
		slashCommands: () => faces.slashCommands,
		attachments: () => faces.attachments,
		files: () => faces.files,
		nativeCli: () => faces.nativeCli,
		bots: () => faces.bots,
		chatMode: () => faces.chatMode,
		presets,
		chatModes,
		presetTranscript: () => faces.presetTranscript,
		nativeCliState: cliConversations,
		toolInfo: () => faces.toolInfo,
		quickAskConversation: () => faces.quickAsk,
		uiBridge: () => faces.uiBridge,
		dshPatches: () => faces.dshPatches,
		enginePermissionMode: () => faces.enginePermissionMode,
		plugins: () => faces.plugins,
		background: () => faces.background,
		bashKills,
		scmCommitMessage: () => faces.scmCommitMessage,
		sandbox: () => faces.sandbox,
		stateStore: () => stateStore,
		workspaceHost: () => faces.workspaceHost,
		worktree: () => options.worktree?.(),
		commandCwd: () => runtime.registry.activeConv()?.meta.cwd ?? cwd,
		commandsPathOf: options.commandsPathOf,
		releasePendingApprovals: (reason) => approvalWaiter.settleAll("approve", reason),
		modelAdmin: ctx.modelAdminPort(),
		modelMemory: createModelMemory(stateStore),
		resolveModel: (provider, id) => faces.resolveModel(provider, id),
		onCwdChanged: (nextCwd, roots) => {
			ctx.onClientCwdChanged?.(nextCwd, [...roots]);
			void checkHeldSessionNotice(
				ctx.runtimes,
				ctx.sockets,
				options.agentDir ?? nextCwd,
				nextCwd,
				runtime.clientId,
			).then((heldNotice) => {
				if (heldNotice) ctx.deliverTo(runtime.clientId, heldNotice);
			});
		},
		onConversationChanged: () => ctx.onConversationChanged?.(),
		onSessionModelChanged: (conversationId) => {
			options.onSessionModelChanged?.(clientId, conversationId);
			ctx.notifyPluginModelChange(clientId, conversationId);
		},
		terminalManagerFor: (conversationId) => terminalHost.managerFor(conversationId, cwd),
		isAllowedPath: (target) => isInsideSessionsDir(options.agentDir ?? cwd, target),
		hasQuestionOf: (cid) => askWaiter.pendingForSnapshot(cid).length > 0,
		elsewhere: () => ctx.listExternalRunning(runtime.clientId),
		getQueuedQuestions: () => collectQueuedQuestions(ctx.runtimes, ctx.askWaiters, runtime.clientId),
		findRuntime: (cid) => ctx.runtimes.get(cid),
		findSessionOwner: (target) => ctx.findSessionOwner?.(target, runtime.clientId),
		checkParallelWork: (conv) => ctx.checkParallelWork?.(runtime.clientId, conv),
		viewOf: (conv) => ({
			...conversationViewFromSession(conv, sessions.get(conv.id)?.session),
			planMode: chatModes.planModeOf(conv.id),
			delegateMode: chatModes.delegateModeOf(conv.id),
			delegateConvId: chatModes.delegateConvIdOf(conv.id),
			...conversationPresetViewOf({
				conversationId: conv.id,
				queued: conv.queues.total(),
				session: sessions.get(conv.id)?.session,
				settings: stateStore.getSettingsSnapshot(runtime.clientId),
				presets,
				chatModes,
				lang: ctx.langOf(runtime.clientId),
			}),
			pendingApprovals: approvalWaiter.pendingForSnapshot(conv.id),
			pendingQuestion: askWaiter.pendingForSnapshot(conv.id)[0]
				? {
						id: askWaiter.pendingForSnapshot(conv.id)[0].id,
						questions: askWaiter.pendingForSnapshot(conv.id)[0].questions,
						conversationId: conv.id,
						conversationTitle: conv.meta.title,
					}
				: null,
			bot: conv.meta.botId ? { id: conv.meta.botId, name: conv.meta.botName ?? conv.meta.botId } : null,
		}),
		env: () => ({
			settingsVersion: stateStore.getSettingsVersion(),
			piConfigured: faces.uiBridge?.probe().piConfigured ?? false,
			piAgentInstalled: faces.uiBridge?.probe().piAgentInstalled ?? false,
			capabilities: DEFAULT_PI_CAPABILITIES,
		}),
	});

	faces = createHostFaces({
		settingsFrame: options.settingsFrame,
		slashCommands: options.slashCommands,
		files: options.files,
		plugins: options.plugins,
		background: options.background,
		sandbox: options.sandbox,
		workspaceHost: options.workspaceHost,
		nativeCli: options.nativeCli,
		bots: options.bots,
		chatMode: options.chatMode,
		// SCM 提交信息面：**这张表就是宿主面的总闸**，漏一行 = 端口永远 undefined（`scmGenCommitMessage` 恒抛）。
		scmCommitMessage: options.scmCommitMessage,
		toolInfo: options.toolInfo,
		quickAsk: options.quickAsk,
		uiBridge: options.uiBridge,
		dshPatches: options.dshPatches,
		enginePermissionMode: options.enginePermissionMode,
		subagentsRegistry: ctx.subagentsRegistry,
		getRuntimes: () => ctx.runtimes.values(),
		findRuntime: (cid: string) => ctx.runtimes.get(cid),
		clientId,
		cwd,
		agentDir: options.agentDir ?? cwd,
		transport,
		runtime,
		sessions,
		terminalHost,
		stateStore,
		projectSource: ctx.projectSource,
		langOf: () => ctx.langOf(runtime.clientId),
		setLang: (next) => ctx.setLang(runtime.clientId, next),
		isDisposed: () => ctx.runtimes.get(runtime.clientId) !== runtime,
		applyChatMode: (kind, enabled, conversationId) => chatModes.setMode(kind, enabled, conversationId),
		notifyMobile: (event) => void ctx.onNotificationEvent?.(event),
		...(ctx.pluginCommandsProvider ? { pluginCommands: () => ctx.pluginCommandsProvider?.() ?? [] } : {}),
		...(ctx.pluginBgTasksProvider ? { pluginTasks: () => ctx.pluginBgTasksProvider?.() ?? [] } : {}),
		...(ctx.pluginStopBgTask ? { stopBgTask: (taskId: string) => ctx.pluginStopBgTask?.(taskId) ?? false } : {}),
	});
	subagents = faces.subagents;

	return { runtime, faces, sessions, deliver };
}
