import { join } from "node:path";
import type { SettingsFramePort } from "../packages/keel/src/contracts/settings.js";
import type {
	LazyCatalogInput,
	PromptRenderCapable,
	PromptRenderInput,
} from "../packages/keel/src/contracts/prompt-render.js";
import { lazyCatalogInput, lazyEffectiveOf, lazyOnDemandOf } from "../packages/keel/src/domains/tools/lazy-state.js";
import type { McpServerInventory } from "../packages/keel/src/contracts/plugins.js";
import type { CoreSettingsSinks } from "../packages/keel/src/app/core-engine.js";
import { ApprovalRulesStore } from "../packages/keel/src/approval-rules.js";
import { SubagentTemplatesStore } from "../packages/keel/src/subagent-templates.js";
import { isTraditionalLocale, resolveServerLang } from "../packages/keel/src/i18n.js";
import { normalizeRetryMaxAttempts, normalizeSkillList, type ClientStateStore } from "./client-state.js";
import type { MarkerService } from "./marker-service.js";
import { currentCorePluginsHandle } from "./core-plugins-handle.js";
import { SettingsService, type SettingsHost } from "./settings-service.js";
import { applyQueueModesToSession } from "./queue-modes.js";
import { contextWindowOf, modelKeyOf } from "./agent-formatters.js";
import { DEFAULT_COMPACTION_RESERVE_TOKENS, effectiveSoftCap, softCapReserveFor } from "./soft-cap.js";
import {
	applyAgentToolsGating,
	effectiveDisabledAgentTools,
	normalizeLazyOnDemandList,
	lazyLoadingDisabledTools,
	presetShowsSkillCatalog,
} from "../packages/keel/src/tool-catalog.js";
import { LOAD_TOOLS_TOOL_NAME } from "../packages/keel/src/tool-names.js";
import {
	applyToolPromptOverrides,
	effectiveToolPrompt,
	toolPromptOverrideOf,
	type ToolPromptSessionLike,
} from "./tool-prompt-overrides.js";
import {
	BUILTIN_SOUL,
	buildToolsSchemaText,
	resolveSectionTexts,
	type PromptComposerInputs,
	type ToolSchemaEntry,
} from "./prompt-composer.js";
import { renderMainCompose } from "./prompt-assembler.js";
import { formatCompactSignature } from "./tool-signature.js";
import { readPromptBase } from "./prompt-base-store.js";
import { fillSkillContents } from "./skill-content-filler.js";
import { formatCwdForPrompt } from "./remote-ssh-service.js";
import { isRemoteWorkspaceUri, restoreWorkspaceUriFromSessionDir } from "../packages/keel/src/remote-workspace.js";
import { getPkgRoot } from "./pkg-info.js";
import { appendConstraints, buildPlatformConstraints } from "./platform-constraints.js";

export interface CoreSettingsAdapterOptions extends CoreSettingsSinks {
	/** 设置落盘（`client-state.json` 的唯一写入者）：宿主进程里共用一个实例。 */
	stateStore: ClientStateStore;
	/** 标记开关（`disabledMarkers`）的落点；缺省 = 该键暂不支持（内核侧会发一次 warning）。 */
	markers?: MarkerService;
	/** 子代理模板库；缺省按老树同一路径 `stateStore.dataDir/subagent-templates.json` 构造。 */
	templates?: SubagentTemplatesStore;
	/** 审批规则库；缺省按老树同一路径 `stateStore.dataDir/approval-rules.json` 构造。 */
	approvalRules?: ApprovalRulesStore;
}

/** 会话句柄类型从 `SettingsHost` 推导，避免在这里再描述一遍 SDK 的会话实体。 */
type HostSession = ReturnType<SettingsHost["getSession"]>;

/** 插件面未接（或客户端已退）：MCP 清单给空表，不让设置帧停在那里。 */
const EMPTY_MCP: McpServerInventory = { servers: [], globalPath: "", projectPath: "" };

/**
 * 宿主侧组合适配器：构造宿主设置叶子 `SettingsService`（设置帧 / 预设 / 审批规则 / 模板），
 * 与 `MarkerService`（标记开关）、语言落盘一起拼成内核要的 `SettingsFramePort`。
 *
 * 构造也在这里：`SettingsService` 是宿主叶子，内核不认识它（P2 之前这份构造在 keel 里，
 * 现在内核只认 `SettingsFramePort` 窄面）。不重写任何语义：16 个设置面方法逐个直通
 * `SettingsService`；只有三件它没有的能力在这里补：标记开关、`applyRuntime`（`extensions_reload`）、
 * `setLocale`（语言落盘 + 必要时重应用）。
 */
export function createCoreSettingsAdapter(
	options: CoreSettingsAdapterOptions,
): SettingsFramePort & PromptRenderCapable {
	const { service, stateStore, clientId } = createCoreSettingsService(options);
	/**
	 * 会话开好了吗？设置帧里的 `visionModels`（读 `host.getSession().modelRuntime`）、
	 * `effectiveSystemPrompt` / `toolsSchema` 都从当前对话的会话现算：没有会话时它们只能是空值。
	 * 老实现不会有这种帧（`ClientSession.create` 里会话先于一切设置帧建好），所以这里也不发半成品
	 * ——连接期 MCP 项目发布（`refreshMcpProject` → `pushSettings`）确实早于首条会话的 `ensure()`，
	 * 放过去就会让客户端把「模型目录为空」当成基线。正式那一帧由连接期 `pushConnectFrames` 发出。
	 */
	const sessionReady = (): boolean => {
		try {
			options.getSession();
			return true;
		} catch {
			return false;
		}
	};
	return {
		// 通道已关就不再出帧（P2 之前这道闸在 keel 的 pusher 里）。
		push: () => {
			if (options.isClosed()) return;
			if (!sessionReady()) return;
			service.push();
		},
		refreshResources: () => service.refreshResources(),
		set: (partial) => service.set(partial as Parameters<SettingsService["set"]>[0]),

		savePreset: (name, groups) => service.savePreset(name, groups),
		applyPreset: (name) => service.applyPreset(name),
		deletePreset: (name) => service.deletePreset(name),
		exportPreset: (msg) => service.exportPreset(msg),
		importPreset: (msg) => service.importPreset(msg),
		importPresetFromUrl: (msg) => service.importPresetFromUrl(msg),
		pushPresetCatalog: (msg) => service.pushPresetCatalog(msg),
		sharePreset: (msg) => service.sharePreset(msg),

		saveApprovalRule: (rule) => service.saveApprovalRule(rule),
		saveApprovalRules: (rules) => service.saveApprovalRules(rules),
		deleteApprovalRule: (id) => service.deleteApprovalRule(id),
		resetBuiltinApprovalRule: (id) => service.resetBuiltinApprovalRule(id),

		saveTemplate: (template) => service.saveTemplate(template),
		deleteTemplate: (name) => service.deleteTemplate(name),
		// 模板清单只有宿主知道（`SubagentTemplatesStore` 在这里）：子代理工具读的就是设置帧那份投影。
		subagentTemplates: () => service.subagentTemplateViews(),

		applyRuntime: () => service.applyRuntime(),
		// 提示词覆写通道：与上面 `effectiveSystemPrompt` 预览共用同一份渲染体（`computePromptSnapshot`），
		// 只是目录口径换成内核递进来的那一份（`tools`）。内核只在开关开 + 名单非空时才调它。
		promptRender: { render: (input) => renderTurnPrompt(options, input) },
		setDisabledMarkers: options.markers ? (names) => options.markers?.setDisabledMarkers(names) : undefined,
		async setLocale(locale: string): Promise<void> {
			const code = locale.trim().slice(0, 16);
			if (!code) return;
			const prev = options.lang.get();
			const wasTraditional = isTraditionalLocale(options.lang.get());
			stateStore.saveLocale(clientId, code);
			const next = resolveServerLang(code);
			options.lang.set(next);
			// 语言族没变（同语种）：只需重发设置帧；换了语言族才要重应用运行时设置。
			if (next === prev) {
				if (isTraditionalLocale(code) !== wasTraditional) service.push();
				return;
			}
			await service.applyRuntime();
		},
	};
}

/** 构造宿主设置叶子：模板 / 审批规则库按老树同一路径落在 `stateStore.dataDir` 下。 */
export function createCoreSettingsService(options: CoreSettingsAdapterOptions): {
	service: SettingsService;
	stateStore: ClientStateStore;
	clientId: string;
} {
	const templates =
		options.templates ?? new SubagentTemplatesStore(join(options.stateStore.dataDir, "subagent-templates.json"));
	const approvalRules =
		options.approvalRules ?? new ApprovalRulesStore(join(options.stateStore.dataDir, "approval-rules.json"));
	const service = new SettingsService(createCoreSettingsHost(options), templates, approvalRules);
	return { service, stateStore: options.stateStore, clientId: options.clientId };
}

function computePromptSnapshot(
	options: CoreSettingsAdapterOptions,
	sessionArg?: unknown,
	target?: {
		/** 这一轮的 cwd（`before_agent_start` 的 `ctx.cwd`）；缺省 = 适配器构造时那份。 */
		cwd?: string;
		/** 内核算好的目录口径（常驻基线 + 按需目录）；缺省 = 按设置现算（设置帧预览走这条）。 */
		tools?: LazyCatalogInput;
	},
): {
	full: string;
	texts: Record<string, string>;
	toolsSchema: string;
} {
	try {
		let session: any;
		if (sessionArg !== undefined) session = sessionArg;
		else {
			try {
				session = options.getSession();
			} catch {
				return { full: "", texts: {}, toolsSchema: "" };
			}
		}
		if (!session) return { full: "", texts: {}, toolsSchema: "" };

		const cwd = target?.cwd ?? options.cwd;
		const settings = options.stateStore.getSettings(options.clientId);
		const active: string[] = typeof session.getActiveToolNames === "function" ? session.getActiveToolNames() : [];
		const schemaEntries: ToolSchemaEntry[] = [];
		for (const name of active) {
			const def = session.getToolDefinition?.(name);
			if (!def) continue;
			const eff = effectiveToolPrompt(def, toolPromptOverrideOf(settings.toolPromptOverrides, name));
			schemaEntries.push({
				name,
				description: eff.description,
				parameters: def.parameters,
			});
		}
		const toolsSchema = buildToolsSchemaText(schemaEntries);

		const loader = session.resourceLoader;
		const preset = settings.defaultAgentPreset ?? "standard";
		const promptBase = readPromptBase(loader);
		const realCwd = restoreWorkspaceUriFromSessionDir(cwd);

		const onDemandList = lazyOnDemandOf(settings);
		const lazyOn = lazyEffectiveOf(settings);
		// 目录口径（单源在 `domains/tools/lazy-state`）：内核给了就用它的，没给按设置现算。
		// 按需开：目录只列名单工具（不重复列常驻），常驻集当基线；按需关：目录=全量，基线=活跃集。
		const allNames: string[] =
			typeof session.getAllTools === "function" ? session.getAllTools().map((t: any) => t.name) : active;
		const partition =
			target?.tools ??
			(lazyOn ? lazyCatalogInput({ all: allNames, allowed: allNames, onDemand: onDemandList }) : undefined);
		const catalogNames: string[] = partition ? [...partition.catalog] : allNames;
		const snippets: Record<string, string> = {};
		for (const name of catalogNames) {
			const def = session.getToolDefinition?.(name);
			if (!def) continue;
			const ov = toolPromptOverrideOf(settings.toolPromptOverrides, name);
			const eff = effectiveToolPrompt(def, ov);
			if (eff.promptSnippet && eff.promptSnippet.trim() && (lazyOn || ov?.promptSnippet)) {
				snippets[name] = eff.promptSnippet.trim();
			}
		}
		// 目录行的紧凑签名（老实现 `promptToolCatalog().signatures` 同一口径）：只按需目录用得到。
		const signatures: Record<string, string> = {};
		if (partition) {
			for (const name of catalogNames) {
				const def = session.getToolDefinition?.(name);
				if (!def?.parameters) continue;
				const sig = formatCompactSignature(def.parameters);
				if (sig) signatures[name] = sig;
			}
		}

		const rawSkills =
			loader?.getSkills?.()?.skills?.map((s: any) => ({
				name: s.name,
				description: s.description ?? "",
				filePath: s.filePath ?? "",
			})) ?? [];
		const showSkills = presetShowsSkillCatalog(preset);
		const effectiveSkills = showSkills
			? fillSkillContents(rawSkills, settings.skillsFullText, {
					maxFileBytes: settings.skillsMaxFileBytes,
					maxTotalBytes: settings.skillsFullTextMaxBytes,
				})
			: [];

		const inputs: PromptComposerInputs = {
			cwd: formatCwdForPrompt(realCwd),
			systemPromptFile: promptBase.soul || undefined,
			builtinSoul: BUILTIN_SOUL,
			selectedTools: partition ? [...partition.resident] : active,
			toolSnippets: snippets,
			...(lazyOn ? { lazy: true, catalogTools: catalogNames, toolSignatures: signatures } : {}),
			pluginDocs: join(getPkgRoot(), "docs", "architecture-plugins.md"),
			pluginSdk: join(getPkgRoot(), "plugin-sdk"),
			pluginsDir: join(options.stateStore.dataDir, "plugins"),
			appendFiles: [...promptBase.append],
			markersGuidance: options.markers?.buildGuidance?.() ?? "",
			lang: options.lang.get(),
			contextFiles: loader?.getAgentsFiles?.()?.agentsFiles ?? [],
			skills: effectiveSkills,
			skillsFullText: showSkills ? normalizeSkillList(settings.skillsFullText) : [],
			skillsCatalogMaxDesc: settings.skillsCatalogMaxDesc,
			skillsCatalogShowLocation: settings.skillsCatalogShowLocation,
			skillsCatalogBudget: settings.skillsCatalogBudget,
		};

		const texts = resolveSectionTexts(inputs);
		const rendered = renderMainCompose(inputs, {
			promptTemplate: settings.promptTemplate,
			promptOverrides: settings.promptOverrides,
			promptDisabled: settings.promptDisabled ?? [],
			preset,
			disabledToolCount: effectiveDisabledAgentTools(settings).length,
			isLazy: lazyOn,
			hasSkills: effectiveSkills.length > 0,
			hasSkillsFullText: (settings.skillsFullText?.length ?? 0) > 0,
		});

		const constraints = buildPlatformConstraints({
			remoteCwd: isRemoteWorkspaceUri(realCwd) ? realCwd : undefined,
			planMode: false,
			delegateMode: false,
			planPrompt: { mode: settings.planModePromptMode, custom: settings.planModePrompt },
		});
		const full = rendered ? appendConstraints(rendered, constraints) : (session.systemPrompt ?? "");

		return { texts, full, toolsSchema };
	} catch {
		return { full: "", texts: {}, toolsSchema: "" };
	}
}

/**
 * 提示词覆写端口的实现：内核已经把目录口径算好了（`input.tools`），这里只负责渲染。
 * 任何一步不成（会话不在 / 按需没生效 / 渲染抛）都回 `undefined` —— 这一帧不改提示词，
 * 与没有这个端口时逐字节一致（老实现的 `computePromptSnapshot` catch 回空串同理）。
 */
function renderTurnPrompt(options: CoreSettingsAdapterOptions, input: PromptRenderInput): string | undefined {
	const settings = options.stateStore.getSettings(options.clientId);
	if (!lazyEffectiveOf(settings)) return undefined;
	const session = sessionOfConversation(options, input.conversationId);
	if (!session) return undefined;
	const snapshot = computePromptSnapshot(options, session, { cwd: input.cwd, tools: input.tools });
	return snapshot.full.trim() === "" ? undefined : snapshot.full;
}

/** 按对话取会话句柄：宿主面给了按对话取的口就用它，只给了活动会话时退回那一个。 */
function sessionOfConversation(options: CoreSettingsAdapterOptions, conversationId: string): HostSession | undefined {
	try {
		const exact = options.getSessionOf?.(conversationId);
		if (exact) return exact as HostSession;
		if (options.getSessionOf) return undefined;
		return options.getSession() as HostSession;
	} catch {
		return undefined;
	}
}

/**
 * 把 `CoreSettingsSinks` 收窄成「只认注入值」的 `SettingsHost`：设置叶子（`SettingsService`）
 * 不认识新树的会话实体，只拿到这里如实投影出来的成员。
 */
export function createCoreSettingsHost(options: CoreSettingsAdapterOptions): SettingsHost {
	const applyRetry = (): void => {
		try {
			const sess = options.getSession() as any;
			const settings = options.stateStore.getSettings(options.clientId);
			const n = normalizeRetryMaxAttempts(settings.retryMaxAttempts);
			sess?.settingsManager?.applyOverrides?.({ retry: { maxRetries: n } });
		} catch {}
	};

	const applyQueue = (): void => {
		try {
			const sess = options.getSession() as any;
			if (sess) {
				const settings = options.stateStore.getSettings(options.clientId);
				applyQueueModesToSession(sess, settings);
			}
		} catch {}
	};

	const applyCompaction = (): void => {
		try {
			const sess = options.getSession() as any;
			if (sess) {
				const s = options.stateStore.getSettings(options.clientId);
				let reserve = DEFAULT_COMPACTION_RESERVE_TOKENS;
				try {
					const cw = contextWindowOf(sess);
					if (cw > 0) {
						const cap = effectiveSoftCap(s.softCapTokens, s.softCapByModel, modelKeyOf(sess));
						let keepRecent = 0;
						try {
							keepRecent = sess.settingsManager?.getCompactionKeepRecentTokens?.(sess.model) ?? 0;
						} catch {
							keepRecent = 0;
						}
						reserve = softCapReserveFor(cw, cap, keepRecent) ?? DEFAULT_COMPACTION_RESERVE_TOKENS;
					}
				} catch {}
				sess.settingsManager?.applyOverrides?.({ compaction: { reserveTokens: reserve } });
			}
		} catch {}
	};

	const applyCodemode = (): void => {
		try {
			const sess = options.getSession() as any;
			if (sess) {
				const s = options.stateStore.getSettings(options.clientId);
				const mode = s.codemodeMode ?? "on";
				const inlineBudget = s.codemodeInlineBudget ?? 3000;
				sess.settingsManager?.applyOverrides?.({ codemode: { mode, inlineBudget } });
			}
		} catch {}
	};

	const applyToolGating = (): void => {
		try {
			const sess = options.getSession() as any;
			if (!sess) return;
			const settings = options.stateStore.getSettings(options.clientId);
			const targetPreset = settings.defaultAgentPreset ?? "standard";
			const disabled = new Set(effectiveDisabledAgentTools(settings));
			const lazyOn =
				settings.toolLazyLoading === true && normalizeLazyOnDemandList(settings.toolOnDemandTools).length > 0;
			let loadedNames: string[] = [];
			if (lazyOn) {
				const only = new Set(normalizeLazyOnDemandList(settings.toolOnDemandTools));
				const allTools = typeof sess.getAllTools === "function" ? sess.getAllTools().map((t: any) => t.name) : [];
				for (const name of lazyLoadingDisabledTools(allTools, [], undefined, only)) {
					disabled.add(name);
				}
			} else {
				disabled.add(LOAD_TOOLS_TOOL_NAME);
			}
			applyAgentToolsGating(sess, [...disabled], targetPreset, {
				forceActive: lazyOn && targetPreset !== "ask" ? [LOAD_TOOLS_TOOL_NAME, ...loadedNames] : [],
			});
			const sessionOverrides: Record<string, any> = {};
			for (const [k, v] of Object.entries(settings.toolPromptOverrides ?? {})) {
				sessionOverrides[k] = { ...v, promptGuidelines: [] };
			}
			applyToolPromptOverrides(sess as unknown as ToolPromptSessionLike, sessionOverrides);
		} catch {}
	};

	const applySessionOverrides = (): void => {
		applyQueue();
		applyRetry();
		applyCompaction();
		applyCodemode();
		applyToolGating();
	};

	return {
		clientId: options.clientId,
		stateStore: options.stateStore,
		emit: options.emit,
		flushSnapshot: () => options.flushSnapshot?.(),
		isDisposed: () => options.isDisposed(),
		getSession: () => options.getSession() as HostSession,
		getApprovalPolicy: () => options.getApprovalPolicy(),
		cwd: () => options.cwd,
		agentDir: () => options.agentDir,
		isStreaming: () => options.isStreaming(),
		// 技能 / 扩展装或卸之后要让下一轮按新目录重建会话资源：与端口内 `installSkill` 用的是同一个函数。
		reloadSession: async () => {
			const plugins = currentCorePluginsHandle();
			if (plugins) await plugins.reloadSession();
			applySessionOverrides();
		},
		applyRetryOverrides: applyRetry,
		applyQueueModes: applyQueue,
		applyCompactionOverrides: applyCompaction,
		applyCodemodeOverrides: applyCodemode,
		applySessionOverrides: applySessionOverrides,
		applyToolGating,
		onGoalModeDisabled: () => {},
		onSessionsFilterChanged: () => {},
		promptSnapshot: () => computePromptSnapshot(options),
		getMarkerState: options.markers
			? () => ({
					disabledMarkers: [...options.markers!.current.disabledMarkers],
					markers: options.markers!.listForUi(),
				})
			: undefined,
		getLocale: () => options.stateStore.get(options.clientId).locale,
		// MCP 清单不自己拼路径：直读插件面投影（含连接域健康），没接插件面就是空表。
		getMcpServers: () => currentCorePluginsHandle()?.listMcpServers() ?? EMPTY_MCP,
	};
}
