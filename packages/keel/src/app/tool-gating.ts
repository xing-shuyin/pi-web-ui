import type { LoadableToolInfo, LoadToolsHost } from "../adapters/tools/load-tools.js";
import { makeLoadToolsTool } from "../adapters/tools/load-tools.js";
import { firstSentence } from "../agent-formatters.js";
import type { ChatModeState } from "../domains/tools/chat-mode.js";
import { autoActivateLazyTool, replayToolGate } from "../domains/tools/gate-replay.js";
import {
	lazyEffectiveOf,
	lazyOnDemandOf,
	loadedLazyToolsOf,
	markLazyToolsLoaded,
} from "../domains/tools/lazy-state.js";
import { pendingLazyToolNames, planLazyTools } from "../domains/tools/lazy-load.js";
import { DEFAULT_AGENT_PRESET, presetGateDisabledTools, type PresetState } from "../domains/tools/presets.js";
import type { Conversation } from "../kernel/conversation/index.js";
import type { SettingsStorePort } from "../contracts/settings-store.js";
import type { ServerLang } from "../i18n.js";
import type { ClientSettings } from "../settings-schema.js";
import type { ActiveToolSet } from "../tool-catalog.js";

/**
 * 按需加载的三件宿主动作，全部收在这一个文件里（`load_tools` / JIT / 门控重放）：
 *
 * | 动作 | 老实现 | 谁调 |
 * | --- | --- | --- |
 * | `replay()` | `applyToolGating()` | 会话一开（`SessionRegistry.onOpened`） |
 * | `loadToolsHostFor()` | `loadToolsHost()` + `loadLazyTools()` | `load_tools` 工具的 `execute` |
 * | `autoActivate()` | `autoActivateToolIfLoadable()`（#652） | SDK 的 `tool_execution_start` |
 *
 * 判定本身在 `domains/tools/{gate-replay,lazy-load}.ts`（纯函数），这里只把
 * 「设置快照 / 预设 / 模式 / 会话库存 / 出帧」这几块接起来，不重写任何一条门控规则。
 */
export interface ToolGatingDeps {
	clientId: string;
	stateStore: SettingsStorePort;
	presets: PresetState;
	chatModes: ChatModeState;
	langOf(clientId: string): string;
	/** 出帧（`publisher.request()`）：加载/激活之后状态变了要推一帧。 */
	flush(): void;
	/** 按对话取已开的会话（宿主口在开会话之前装配，所以要 getter 不能是值）。 */
	sessionOf(conversationId: string): unknown;
}

/** 门控只认这三个方法 + 一个可选的工具文案读口（结构判定，假体拿不到就当没有）。 */
interface GatingSession extends ActiveToolSet {
	getToolDefinition?(name: string): ToolDefinitionViewLike | undefined;
}

interface ToolDefinitionViewLike {
	description?: unknown;
	promptSnippet?: unknown;
	promptGuidelines?: unknown;
}

export interface ToolGating {
	/** 按需加载此刻是否生效（开关开 + 名单非空）：`customToolsFor` 据此决定要不要注册 `load_tools`。 */
	lazyOn(): boolean;
	/** 重放门控（活动集只由 `replayToolGate` 写）：会话一开、加载成功、JIT 之后都走这里。 */
	replay(conv: Conversation, session: unknown): void;
	/** JIT 自动激活（下一轮起活跃）；返回 `true` = 真的补进了已加载集。 */
	autoActivate(conv: Conversation, session: unknown, toolName: string): boolean;
	/** `load_tools` 的宿主口（`listLoadable` / `listLoaded` / `load`）。 */
	loadToolsHostFor(conv: Conversation): LoadToolsHost;
	/** 装配好的 `load_tools` 工具定义（只在按需生效时调用）。 */
	loadToolsToolFor(conv: Conversation): unknown;
}

function gatingSessionOf(session: unknown): GatingSession | undefined {
	const surface = session as Partial<GatingSession> | undefined;
	if (!surface) return undefined;
	if (typeof surface.getAllTools !== "function") return undefined;
	if (typeof surface.getActiveToolNames !== "function") return undefined;
	if (typeof surface.setActiveToolsByName !== "function") return undefined;
	return surface as GatingSession;
}

function textOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function createToolGating(deps: ToolGatingDeps): ToolGating {
	const settingsOf = (): ClientSettings => deps.stateStore.getSettingsSnapshot(deps.clientId);
	const lang = (): ServerLang => deps.langOf(deps.clientId);
	const hasTranscript = (session: unknown): boolean =>
		((session as { messages?: readonly unknown[] } | undefined)?.messages?.length ?? 0) > 0;

	/** 与 `replayToolGate` 同一批输入，判定的备料只在这里算一次。 */
	const gatingInput = (conv: Conversation, session: GatingSession) => {
		const settings = settingsOf();
		return {
			session,
			settings,
			preset: deps.presets.agentPresetOf(conv.id) ?? settings.defaultAgentPreset ?? DEFAULT_AGENT_PRESET,
			planMode: deps.chatModes.planModeOf(conv.id),
			delegateMode: deps.chatModes.delegateModeOf(conv.id),
			hasTranscript: hasTranscript(session),
		};
	};

	const infoOf = (session: GatingSession, name: string): LoadableToolInfo => {
		const def = session.getToolDefinition?.(name);
		const description = textOf(def?.description);
		const summary = textOf(def?.promptSnippet).trim() || firstSentence(description);
		const guidelines = Array.isArray(def?.promptGuidelines)
			? (def.promptGuidelines as unknown[]).filter((rule): rule is string => typeof rule === "string")
			: undefined;
		return {
			name,
			...(summary ? { summary } : {}),
			...(description ? { description } : {}),
			...(guidelines && guidelines.length > 0 ? { guidelines } : {}),
		};
	};

	const replay = (conv: Conversation, session: unknown): void => {
		const host = gatingSessionOf(session);
		if (!host) return;
		replayToolGate(gatingInput(conv, host));
	};

	const autoActivate = (conv: Conversation, session: unknown, toolName: string): boolean => {
		const host = gatingSessionOf(session);
		if (!host) return false;
		const activated = autoActivateLazyTool({ ...gatingInput(conv, host), toolName });
		if (activated) deps.flush();
		return activated;
	};

	const loadToolsHostFor = (conv: Conversation): LoadToolsHost => {
		const live = (): GatingSession | undefined => gatingSessionOf(deps.sessionOf(conv.id));
		return {
			listLoadable: () => {
				const host = live();
				if (!host) return [];
				const settings = settingsOf();
				if (!lazyEffectiveOf(settings)) return [];
				const onDemand = lazyOnDemandOf(settings);
				const active = host.getActiveToolNames();
				const loaded = loadedLazyToolsOf(host, hasTranscript(host) ? active : [], onDemand);
				const all = host.getAllTools().map((tool) => tool.name);
				return pendingLazyToolNames({ all, active, onDemand, loaded }).map((name) => infoOf(host, name));
			},
			listLoaded: () => {
				const host = live();
				if (!host) return [];
				try {
					return host.getActiveToolNames();
				} catch {
					return [];
				}
			},
			load: (names) => {
				const host = live();
				if (!host) return { loaded: [], rejected: [] };
				const input = gatingInput(conv, host);
				const settings = input.settings;
				if (!lazyEffectiveOf(settings)) return { loaded: [], rejected: [] };
				const onDemand = lazyOnDemandOf(settings);
				const active = host.getActiveToolNames();
				const loaded = loadedLazyToolsOf(host, hasTranscript(host) ? active : [], onDemand);
				const all = host.getAllTools().map((tool) => tool.name);
				const disabled = new Set(
					presetGateDisabledTools({
						settings,
						planMode: input.planMode,
						delegateMode: input.delegateMode,
					}),
				);
				const plan = planLazyTools({
					names,
					all,
					active,
					loaded,
					onDemand,
					disabled,
					preset: input.preset,
					lang: lang(),
				});
				if (plan.accepted.length === 0) return { loaded: [], rejected: plan.rejected };
				markLazyToolsLoaded(host, plan.accepted);
				// 加载 = 同一条门控重放的触发点（老实现 `loadLazyTools` 成功后立刻 `applyToolGating`）。
				replayToolGate(input);
				deps.flush();
				return { loaded: plan.accepted.map((name) => infoOf(host, name)), rejected: plan.rejected };
			},
		};
	};

	return {
		lazyOn: () => lazyEffectiveOf(settingsOf()),
		replay,
		autoActivate,
		loadToolsHostFor,
		loadToolsToolFor: (conv) => makeLoadToolsTool(loadToolsHostFor(conv), lang),
	};
}
