import {
	applyBotToolGate,
	botToolGateHostOf,
	DEFAULT_AGENT_PRESET,
	resolveToolLoadout,
	type ChatModeState,
	type PresetState,
} from "../domains/tools/index.js";
import { createProjectMemory } from "../domains/models/index.js";
import { withChatModeGates } from "../adapters/sdk/chat-mode.js";
import { createAskQuestionTool } from "../adapters/tools/ask-question.js";
import { createGuardedBuiltinTools } from "../adapters/tools/guarded.js";
import { makeBrowserPageTool } from "../browser-page-tool.js";
import type { BashKills } from "../domains/background/index.js";
import { gateConversationPreset } from "./preset-handlers.js";
import { subscribePluginSessionEvents } from "./plugin-engine-hooks.js";
import { SessionRegistry } from "./session-registry.js";
import type { OpenedSession } from "../adapters/sdk/session-opener.js";
import type { Conversation } from "../kernel/conversation/index.js";
import type { BotChatPort, BotChatSessionEntry } from "../contracts/bots.js";
import type { TransportPort } from "../contracts/ports.js";
import type { SettingsStorePort } from "../contracts/settings-store.js";
import type { RemoteSdkOperationsFactory } from "../contracts/remote-ops.js";
import type { ToolGuardHook } from "../tool-guards.js";
import type { SubagentRuntime } from "./subagent-runtime.js";
import type { HostFaces } from "./host-faces.js";
import type { ClientRuntime } from "./client-runtime.js";
import type { PluginToolsBinder } from "./plugin-tools-binder.js";
import type { PluginAgentToolFilter } from "../adapters/tools/plugin-agent-tools.js";
import type { PluginRunEvent, PluginToolEvent } from "../contracts/plugin.js";

export interface EngineSessionDeps {
	agentDir: string;
	cwd: string;
	clientId: string;
	stateStore: SettingsStorePort;
	chatModes: ChatModeState;
	presets: PresetState;
	bashKills: BashKills;
	subagents?: () => SubagentRuntime | undefined;
	askWaiter: ReturnType<typeof import("../domains/interactions/index.js").createAskUserWaiter>;
	findAskWaiter?: (
		clientId: string,
	) => ReturnType<typeof import("../domains/interactions/index.js").createAskUserWaiter> | undefined;
	findRuntime?: (clientId: string) => ClientRuntime | undefined;
	approvalWaiter: ReturnType<typeof import("../domains/interactions/index.js").createApprovalWaiter>;
	transport: TransportPort;
	pluginTools: PluginToolsBinder;
	pluginToolFilter(clientId: string, conv: Conversation): PluginAgentToolFilter;
	toolGuard?: () => ToolGuardHook | undefined;
	remoteOpsOf?: RemoteSdkOperationsFactory;
	langOf(clientId: string): string;
	mcpProjects?: () => { retain(cwd: string): () => void; prepare(cwd: string): Promise<unknown> } | undefined;
	bots?: () => BotChatPort | undefined;
	getRuntime(): ClientRuntime;
	getFaces(): HostFaces;
	onToolEvent?(ev: PluginToolEvent): void;
	onRunEvent?(ev: PluginRunEvent): void;
}

export function createEngineSessionRegistry(deps: EngineSessionDeps): SessionRegistry {
	const mcpReleases = new Map<string, () => void>();
	const unsubscribers = new Map<string, () => void>();

	const resumeAgentPreset = (conv: Conversation, opened: OpenedSession): void => {
		const preset = deps.presets.agentPresetOf(conv.id);
		if (!preset || preset === DEFAULT_AGENT_PRESET) return;
		gateConversationPreset({
			session: opened.session,
			preset,
			settings: deps.stateStore.getSettingsSnapshot(deps.clientId),
			modes: {
				planMode: deps.chatModes.planModeOf(conv.id),
				delegateMode: deps.chatModes.delegateModeOf(conv.id),
			},
		});
	};

	/**
	 * 执行客户端是不是一次 Bot 执行（设备任务）：是就拿到它的工具面。
	 * 按 `conv.meta.clientId`（对话转手后归新客户端）解析，与 ask / pageCall 同一口径。
	 */
	const botFaceOf = (conv: Conversation) => {
		const current = conv.meta.clientId;
		const targetClientId = typeof current === "string" && current.length > 0 ? current : deps.clientId;
		return deps.bots?.()?.toolFace?.({ clientId: targetClientId });
	};

	/**
	 * Bot 执行的活动工具集 = 白名单 ∩ 全部工具（老 `applyToolGating` 的 Bot 早返回）。
	 *
	 * 拿不到工具面的写口就什么也不做：真实的 SDK 会话一定有那三件套（`presetToolHostOf` 靠的是
	 * 同一批方法），没有写口的只可能是假体/半成品会话——那种会话本来就没有可放行的工具表，
	 * 在这里抛错只会先在注册表里留一个已 dispose 的脏会话项（`onOpened` 排在登记之后）。
	 */
	const gateBotTools = (conv: Conversation, opened: OpenedSession): void => {
		const face = botFaceOf(conv);
		if (!face) return;
		const host = botToolGateHostOf(opened.session);
		if (!host) return;
		applyBotToolGate({ host, face });
	};

	/**
	 * 进项目：先把该项目记住的 provider key 全部激活，再给「还没开始」的会话套上项目模型。
	 *
	 * 老实现 `server/agent-service.ts:4908-4909`（开会话）、`:14543`（切会话）、`:17167`（换目录）
	 * 三处都是这个顺序与语义：key 先、模型后（模型恢复自己还会再查一次该 provider 的 pin），
	 * 静默 + 自愈（记忆里的 key / 模型已经不在了就当那条记忆失效，不弹错），最后补一帧。
	 */
	const restoreProjectMemory = async (conv: Conversation, opened: OpenedSession): Promise<void> => {
		const runtime = deps.getRuntime();
		const memory = runtime.options.modelMemory;
		if (!memory) return;
		// 对话转手后归新客户端（与 ask / pageCall / 工具门禁同一口径）。
		const owner = conv.meta.clientId;
		const clientId = typeof owner === "string" && owner.length > 0 ? owner : deps.clientId;
		const admin = runtime.options.modelAdmin;
		const project = createProjectMemory({ clientId, memory, ...(admin ? { admin } : {}) });
		try {
			await project.restoreKeysForProject(conv.meta.cwd);
			// Bot / 子代理对话的模型由身份或父对话固定：项目模型只套普通对话（老实现 `!botExecution`）。
			if (conv.meta.kind === "user") {
				await project.restoreModelForProject({
					cwd: conv.meta.cwd,
					session: opened.session,
					resolveModel: deps.getFaces().resolveModel,
					onModelChanged: () => runtime.options.onSessionModelChanged?.(conv.id),
				});
			}
		} catch {}
		// 退役掉的对话不再占出帧：它已经被后一次重绑换下来了（老实现的 `activeId` 比对）。
		if (runtime.isDisposed() || conv.phase === "retired") return;
		runtime.publisher.request();
	};

	return new SessionRegistry({
		agentDir: deps.agentDir,
		// 扩展的 UI 上下文：子代理用 headless（dialog 立刻 null、不等浏览器），真对话用浏览器那份。
		uiContextOf: (conv) => deps.getFaces().uiBridge?.uiContextFor(conv.meta.kind === "subagent" ? undefined : conv.id),
		toolsFor: () => resolveToolLoadout({ switches: deps.stateStore.getSettingsSnapshot(deps.clientId) }).tools,
		customToolsFor: (conv) => [
			...withChatModeGates(
				[
					createAskQuestionTool({
						waiter: {
							askUser: (questions, signal) => {
								const currentClientId = conv.meta.clientId;
								const targetWaiter =
									(typeof currentClientId === "string" && currentClientId.length > 0
										? deps.findAskWaiter?.(currentClientId)
										: undefined) ?? deps.askWaiter;
								return targetWaiter.askUser(questions, signal, conv.id);
							},
						},
						conversationId: conv.id,
					}),
					...(deps.subagents?.() ? [deps.subagents()!.toolFor(() => conv.id)] : []),
					makeBrowserPageTool(
						{
							pageCall: (req, sig) => {
								const currentClientId = conv.meta.clientId;
								const targetRt =
									typeof currentClientId === "string" && currentClientId.length > 0
										? deps.findRuntime?.(currentClientId)
										: undefined;
								const caller = targetRt ?? deps.getRuntime();
								return (
									caller.handlers().pageCall?.(req, sig, conv.id) ??
									Promise.resolve({ ok: false, error: "pageCall not ready" })
								);
							},
						},
						conv.id,
					),
					...createGuardedBuiltinTools({
						cwd: deps.cwd,
						...(deps.remoteOpsOf ? { remoteOpsOf: deps.remoteOpsOf } : {}),
						getLang: () => deps.langOf(deps.clientId),
						conversationId: () => conv.id,
						bashKills: deps.bashKills,
						guard: deps.toolGuard,
						askApproval: (_toolCallId, toolName, params, reason, reasonEn) =>
							deps.approvalWaiter.request({
								conversationId: conv.id,
								toolName,
								params,
								reason: reason ?? reasonEn,
							}),
					}),
				],
				{
					planMode: () => deps.chatModes.planModeOf(conv.id),
					delegateMode: () => deps.chatModes.delegateModeOf(conv.id),
					getLang: () => deps.langOf(deps.clientId),
				},
			),
			...deps.pluginTools.defsFor(deps.clientId, conv.id, deps.pluginToolFilter(deps.clientId, conv)),
			// Bot 执行专属工具（`device_collab`）：老实现 `...(botExecution ? [makeDeviceCollabTool()] : [])`。
			...(botFaceOf(conv)?.tools() ?? []),
		],
		botSessionDir: (botId) => deps.bots?.()?.sessionDir?.(botId),
		bindBotSession: async (conv, opened) => {
			const bots = deps.bots?.();
			if (!bots?.bindTranscriptSession) return;
			const curModel = opened.session.model as { provider?: string; id?: string } | undefined;
			const curModelStr = curModel?.provider && curModel?.id ? `${curModel.provider}/${curModel.id}` : undefined;
			const fallbackModel =
				deps.stateStore.getDefaultModel?.("pi") ??
				deps.stateStore.getProjectModel?.(deps.clientId, conv.meta.cwd, "pi") ??
				curModelStr;
			const binding = await bots.bindTranscriptSession({
				botId: conv.meta.botId,
				cwd: conv.meta.cwd,
				fallbackModel,
				entries: (opened.getEntries?.() ?? []) as readonly BotChatSessionEntry[],
				appendCustomEntry: (type, data) => opened.appendCustomEntry?.(type, data),
			});
			if (binding.bot) {
				conv.setBot(binding.bot.id, binding.bot.name);
			}
			if (binding.readOnly) {
				conv.setReadOnly(true);
			}
			if (binding.warningNotice) {
				deps.transport.send({
					type: "notice",
					level: "warning",
					text: binding.warningNotice.text,
					textEn: binding.warningNotice.textEn,
				});
			}
			if (binding.model && opened.session.setModel) {
				try {
					if (curModel?.provider !== binding.model.provider || curModel?.id !== binding.model.modelId) {
						const modelObj = await deps.getFaces().resolveModel(binding.model.provider, binding.model.modelId);
						if (modelObj) {
							await opened.session.setModel(modelObj);
						}
					}
				} catch {}
			}
		},
		prepare: async (conv) => {
			const release = deps.mcpProjects?.()?.retain(conv.meta.cwd);
			if (release) mcpReleases.set(conv.id, release);
			await deps.mcpProjects?.()?.prepare(conv.meta.cwd);
		},
		onOpened: (conv, opened) => {
			const runtime = deps.getRuntime();
			const faces = deps.getFaces();
			runtime.noteSessionFile(opened.sessionFile);
			faces.chatMode?.restore?.(conv.id);
			deps.presets.setPermission(conv.id, faces.presetTranscript?.readPermission?.(conv.id));
			resumeAgentPreset(conv, opened);
			// Bot 执行的门禁排在预设之后：白名单是最终口径（老实现的早返回）。
			gateBotTools(conv, opened);
			// 项目记忆（该项目的 {模型, provider key}）：晚于预设与门禁，失败不影响会话可用。
			void restoreProjectMemory(conv, opened);
			unsubscribers.set(
				conv.id,
				subscribePluginSessionEvents({
					session: opened.session,
					conv,
					clientId: deps.clientId,
					sessionId: opened.sessionId,
					onChange: () => {
						const currentClientId = conv.meta.clientId;
						const targetRt =
							typeof currentClientId === "string" && currentClientId.length > 0
								? deps.findRuntime?.(currentClientId)
								: undefined;
						(targetRt ?? runtime).publisher.request();
					},
					onToolEvent: (ev) => deps.onToolEvent?.(ev),
					onRunEvent: (ev) => deps.onRunEvent?.(ev),
				}),
			);
		},
		onClosed: (conversationId) => {
			mcpReleases.get(conversationId)?.();
			mcpReleases.delete(conversationId);
			unsubscribers.get(conversationId)?.();
			unsubscribers.delete(conversationId);
			deps.pluginTools.forget(deps.clientId, conversationId);
		},
	});
}
