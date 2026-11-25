import {
	DEFAULT_AGENT_PRESET,
	resolveToolLoadout,
	type ChatModeState,
	type PresetState,
} from "../domains/tools/index.js";
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

	return new SessionRegistry({
		agentDir: deps.agentDir,
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
