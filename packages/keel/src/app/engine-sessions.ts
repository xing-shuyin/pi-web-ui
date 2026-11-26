import {
	applyBotToolGate,
	botToolGateHostOf,
	DEFAULT_AGENT_PRESET,
	DEFAULT_PERMISSION_PRESET,
	resolveToolLoadout,
	type ChatModeState,
	type PresetState,
} from "../domains/tools/index.js";
import { createProjectMemory } from "../domains/models/index.js";
import { withChatModeGates } from "../adapters/sdk/chat-mode.js";
import { createAskQuestionTool } from "../adapters/tools/ask-question.js";
import { createGuardedBuiltinTools } from "../adapters/tools/guarded.js";
import { makePatchTool } from "../adapters/tools/patch.js";
import { makeBrowserPageTool } from "../browser-page-tool.js";
import { wrapPatchToolWithPermission } from "../tool-guards.js";
import { LOAD_TOOLS_TOOL_NAME } from "../tool-names.js";
import type { BashKills } from "../domains/background/index.js";
import { gateConversationPreset } from "./preset-handlers.js";
import { subscribePluginSessionEvents } from "./plugin-engine-hooks.js";
import { createToolGating } from "./tool-gating.js";
import { SessionRegistry } from "./session-registry.js";
import type { OpenedSession } from "../adapters/sdk/session-opener.js";
import type { Conversation } from "../kernel/conversation/index.js";
import type { BotChatPort, BotChatSessionEntry } from "../contracts/bots.js";
import type { TransportPort } from "../contracts/ports.js";
import type { SettingsStorePort } from "../contracts/settings-store.js";
import type { ClientSettings } from "../settings-schema.js";
import type { RemoteSdkOperationsFactory } from "../contracts/remote-ops.js";
import type { ToolGuardHook } from "../tool-guards.js";
import type { SubagentRuntime } from "./subagent-runtime.js";
import type { HostFaces } from "./host-faces.js";
import type { ClientRuntime } from "./client-runtime.js";
import type { PluginToolsBinder } from "./plugin-tools-binder.js";
import type { PluginAgentToolFilter } from "../adapters/tools/plugin-agent-tools.js";
import type { PluginRunEvent, PluginToolEvent } from "../contracts/plugin.js";
import type { LspPort } from "../contracts/lsp.js";

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
	/** LSP（宿主叶子 `server/lsp-tool.ts`）：内核只挂载工具定义与转发诊断，不 spawn 语言服务器。 */
	lsp?: LspPort;
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
	/** JIT 自动激活那一份订阅（与插件事件的订阅分开，关会话时各自注销）。 */
	const jitUnsubscribers = new Map<string, () => void>();

	/** 门控相关的设置键（老实现 `applySharedSettings` 的 `changed(...)` 同一批）。 */
	const gatingKeysChanged = (before: Partial<ClientSettings>, after: Partial<ClientSettings>): boolean =>
		(
			[
				"disabledAgentTools",
				"toolOnDemandTools",
				"disabledPluginTools",
				"disabledPlugins",
				"toolPromptOverrides",
				"toolLazyLoading",
				"terminalToolsEnabled",
				"questionnaireEnabled",
			] as const
		).some((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));

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

	/**
	 * `lsp` 工具定义归宿主（`LspPort.tool` 要拉起语言服务器子进程，内核不 spawn），内核只挂载：
	 * 给了就进同一个模式门控数组，没给（缺省 = 能力未接）就一条也不注册。
	 * 数组元素本来就走 `unknown`（宿主给的 SDK 工具定义，形状由 SDK 保证），所以这里不需要 cast。
	 */
	const lspToolsOf = (conv: Conversation): unknown[] => {
		const makeTool = deps.lsp?.tool;
		if (!makeTool) return [];
		return [makeTool({ cwd: conv.meta.cwd, lang: () => deps.langOf(deps.clientId) })];
	};

	return createRegistry();

	function createRegistry(): SessionRegistry {
		/** 门控只需要「按对话取会话」，而会话注册表正是本函数的返回值：先留口子，建好再补上。 */
		let registry: SessionRegistry | undefined;
		const gating = createToolGating({
			clientId: deps.clientId,
			stateStore: deps.stateStore,
			presets: deps.presets,
			chatModes: deps.chatModes,
			langOf: deps.langOf,
			flush: () => deps.getRuntime().publisher.request(),
			sessionOf: (conversationId) => registry?.get(conversationId)?.session,
		});
		/**
		 * 设置变了就重放门控（老实现 `SettingsService` → `host.applyToolGating()` 那一条）。
		 * keel 这条链没有 `subscribeSharedSettings`，所以在这里直接订存储：
		 * 不订就会变成「设置里已经打开的工具，已开的会话永远等不到它」。
		 */
		const unsubscribeSettings = deps.stateStore.subscribeSettings((change) => {
			if (!gatingKeysChanged(change.before, change.settings)) return;
			const opened = registry;
			if (!opened) return;
			for (const conv of deps.getRuntime().registry.list()) {
				const session = opened.get(conv.id)?.session;
				if (!session || botFaceOf(conv)) continue;
				gating.replay(conv, session);
			}
			deps.getRuntime().publisher.request();
		});
		return (registry = new SessionRegistry({
			agentDir: deps.agentDir,
			// 扩展的 UI 上下文：子代理用 headless（dialog 立刻 null、不等浏览器），真对话用浏览器那份。
			uiContextOf: (conv) =>
				deps.getFaces().uiBridge?.uiContextFor(conv.meta.kind === "subagent" ? undefined : conv.id),
			/**
			 * 注册面 = **库存全量**（不是「此刻允许的那一批」）：SDK 只能激活已创建的工具，而设置随时会变
			 * （用户打开一个默认关闭的工具、把工具移进/移出按需名单）。老实现同样是「先把所有工具建出来，
			 * 再用 `setActiveToolsByName` 决定本次哪些活跃」——注册时就按设置减法的活，会让后来才被允许的
			 * 工具永远无法激活。平台不支持的工具不注册（否则会在错的系统上被门控放行）。
			 */
			toolsFor: () => {
				const inventory = resolveToolLoadout({ switches: { disabledAgentTools: [] } }).tools;
				return gating.lazyOn() ? [...inventory, LOAD_TOOLS_TOOL_NAME] : inventory;
			},
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
						...((
							deps.getFaces().terminalOf?.(conv.id, conv.meta.cwd) as
								{ persistentTools?: (cwd: string, lang?: () => string) => unknown[] } | undefined
						)?.persistentTools?.(conv.meta.cwd, () => deps.langOf(deps.clientId)) ?? []),
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
						/**
						 * `patch` 是宿主工具（SDK 没内置它）：不注册就永远不能在活跃集里出现，
						 * 而它又是按需加载的典型样例（名单里最常被加载的一个）。
						 */
						wrapPatchToolWithPermission(
							makePatchTool({
								cwd: conv.meta.cwd,
								lang: () => deps.langOf(deps.clientId),
								// 实时诊断只转发宿主的查询（语言服务器子进程在宿主叶子里，内核不 spawn）。
								...(deps.lsp?.liveDiagnostics ? { liveDiagnostics: deps.lsp.liveDiagnostics } : {}),
							}),
							conv.meta.cwd,
							() =>
								deps.presets.permissionOf(conv.id) ??
								deps.stateStore.getSettingsSnapshot(deps.clientId).defaultPermissionPreset ??
								DEFAULT_PERMISSION_PRESET,
							() => [...deps.getRuntime().roots],
							() => deps.langOf(deps.clientId),
							(_toolCallId, toolName, params, reason, reasonEn) =>
								deps.approvalWaiter.request({
									conversationId: conv.id,
									toolName,
									params,
									reason: reason ?? reasonEn,
								}),
							() => conv.id,
						),
						// `lsp` 工具本体（定义归宿主）：与 `patch` 同一批门控，缺省（宿主没接）= 不注册。
						...lspToolsOf(conv),
					],
					{
						planMode: () => deps.chatModes.planModeOf(conv.id),
						delegateMode: () => deps.chatModes.delegateModeOf(conv.id),
						getLang: () => deps.langOf(deps.clientId),
					},
				),
				// `load_tools` 只在按需加载真的生效时注册（开关开 + 名单非空）：关着时它连库存都不在，
				// 活跃集与模型请求的 tools 数组里也永远不会出现。
				...(gating.lazyOn() ? [gating.loadToolsToolFor(conv)] : []),
				...deps.pluginTools.defsFor(deps.clientId, conv.id, deps.pluginToolFilter(deps.clientId, conv)),
				// Bot 执行专属工具（`device_collab`）：老实现 `...(botExecution ? [makeDeviceCollabTool()] : [])`。
				...(botFaceOf(conv)?.tools() ?? []),
			],
			/** 模式开关拨完之后的重放（老实现 `setPlanMode` / `setDelegateMode` → `applyToolGating`）。 */
			/**
			 * 门控重放：模式开关（setPlanMode / setDelegateMode）与设置变更（宿主 applyToolGating）共用同一份。
			 * 不传 id = 所有已开会话都重放（设置改动对每个会话都成立）。
			 */
			replayToolGating: (conversationId) => {
				const runtime = deps.getRuntime();
				let replayed = false;
				for (const conv of conversationId ? [runtime.registry.get(conversationId)] : runtime.registry.list()) {
					if (!conv || botFaceOf(conv)) continue;
					const session = registry?.get(conv.id)?.session;
					if (!session) continue;
					gating.replay(conv, session);
					replayed = true;
				}
				if (replayed) runtime.publisher.request();
			},
			onCloseAll: () => unsubscribeSettings(),
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
				// 预设与 Bot 之后才重放按需加载门控（老实现同一个函数末尾）。Bot 执行不叠加（早返回）。
				if (!botFaceOf(conv)) gating.replay(conv, opened.session);
				// JIT 自动激活（issue #652）：SDK 先发 `tool_execution_start` 再因不在活跃集回 not found，
				// 这里把这个工具补进已加载集并重放门控——只为下一轮，不改本轮结果。
				// `agent_start`（每轮开跑前）也重放一次：SDK 的 `reload()`（切模式 / 重载扩展）会把
				// 「所有自定义工具」重新激活，不在这里拉回来，计划模式剔掉的写工具、按需未加载的工具会当轮复活。
				const jitUnsubscribe = opened.session.subscribe?.((event) => {
					const ev = event as { type?: string; toolName?: string } | undefined;
					if (ev?.type === "agent_start") {
						if (!botFaceOf(conv)) gating.replay(conv, opened.session);
						return;
					}
					if (ev?.type !== "tool_execution_start" || typeof ev.toolName !== "string") return;
					gating.autoActivate(conv, opened.session, ev.toolName);
				});
				if (jitUnsubscribe) jitUnsubscribers.set(conv.id, jitUnsubscribe);
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
				jitUnsubscribers.get(conversationId)?.();
				jitUnsubscribers.delete(conversationId);
				unsubscribers.get(conversationId)?.();
				unsubscribers.delete(conversationId);
				deps.pluginTools.forget(deps.clientId, conversationId);
			},
		}));
	}
}
