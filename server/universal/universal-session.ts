/**
 * universal-session.ts — 通用 Agent 会话控制器（实现 DispatchSession）。
 *
 * 职责：
 *   1. 桥接 BaseAgentDriver 与 Web 前端 Wire 协议；
 *   2. 自动维护严格线性的 UiMessage[] 历史与流式 streamingMessage；
 *   3. 60ms 节流下发 snapshot / message_delta，实现高帧率低开销的前端流式渲染；
 *   4. 无缝复用宿主 FilesService（文件树/预览/SCM/上传）、TerminalManager（终端）与 BgServerTracker（后台服务）。
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DispatchSession, TerminalManagerLike } from "../index.js";
import type {
	ClientMessage,
	CommandDef,
	ConversationSummary,
	ModelInfo,
	PromptAttachment,
	ServerMessage,
	SessionSummary,
	SessionSearchResult,
	UiMessage,
	UiState,
	UiSettingsState,
	UiContentBlock,
	UiTextBlock,
	UiThinkingBlock,
	UiModelConfigEntry,
	WorktreeInfo,
	SlashCommandInfo,
} from "../protocol.js";
import { FilesService } from "../files-service.js";
import { TerminalManager, makePersistentTerminalTools } from "../terminals.js";
import { TERMINAL_TOOL_NAMES } from "../tool-manager.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BgServerTracker } from "../bg-servers.js";
import { ModelAdminService } from "../model-admin.js";
import { WebUIContext } from "../webui-context.js";
import type { BaseAgentDriver, AgentEventSink, AgentTurnMeta } from "./driver-base.js";
import { ClaudeCodeDriver, probeClaudeCode } from "./drivers/claude-code.js";
import type { UniversalSessionStore } from "./session-store.js";
import type { UniversalConversation } from "./universal-types.js";
import { type ClientStateStore, normalizeUiLayout, type ClientSettings, settingsPresetToUi } from "../client-state.js";
import { readModelsJson } from "../model-resolver.js";
import { DEFAULT_UNIVERSAL_CAPABILITIES } from "../engine-capabilities.js";
import { unsupportedToolInfo } from "../tool-info.js";
import { SandboxManager } from "../sandbox-service.js";
import { getWorktreeContext, removeWorktree } from "../worktree-service.js";
import { MarkerService } from "../marker-service.js";
import { SlashCommandsService, parseSlash } from "../slash-commands.js";
import { discoverDiskSkills, readSkillInstruction, type DiscoveredSkill } from "../skill-discovery.js";
import { scanAtMentions, createAttachmentUiMessages, formatPromptWithSkills } from "./universal-attachments.js";
import type { PluginCommandDef } from "../plugins.js";
import { scmCommitContext } from "../scm.js";
import { buildCommitMsgInput, sanitizeCommitMessage } from "../scm-commitmsg.js";
import { getAppVersion } from "../pkg-info.js";
import { createQueuedEntry, removeQueuedEntry, toQueuedPromptItems, type QueuedMessageEntry } from "../queue-utils.js";
import {
	SubagentTemplatesStore,
	DEFAULT_TEMPLATES,
	type SubagentTemplate,
	pickTemplatePrompt,
} from "../subagent-templates.js";
import {
	type SubagentToolHost,
	type SubagentSnapshot,
	type SubagentState,
	subagentTitle,
	isSubagentTerminal,
	computeWaitCapMs,
	makeSubagentTools,
} from "../subagents.js";
import {
	recordSubagentHandoff,
	formatSubagentHandoffMessage,
	type SubagentHandoffRecord,
} from "../subagent-handoff.js";
import type { DriverFactory } from "./universal-service.js";
import { pick, type ServerLang } from "../i18n.js";
import { fetchRemoteSkillMarket, fetchRemoteSkillContent, fetchRemoteMcpMarket } from "../market-service.js";
import {
	exportPresetVia,
	importPresetVia,
	importPresetFromUrlVia,
	pushPresetCatalogVia,
	sharePresetVia,
	type PresetSharePort,
} from "../preset-share.js";

const SNAPSHOT_INTERVAL_MS = 60;

export class UniversalSession implements DispatchSession {
	public cwd: string;
	private readonly clientId: string;
	private readonly sinks = new Set<(msg: ServerMessage) => void>();
	private readonly store: UniversalSessionStore;
	private readonly stateStore?: ClientStateStore;
	private readonly driver: BaseAgentDriver;
	private readonly sandboxes: SandboxManager;
	private readonly markerSvc: MarkerService;
	private worktreeInfo: WorktreeInfo | null = null;
	private readonly dataDir: string;

	private readonly files: FilesService;
	private readonly terminals: TerminalManager;
	private readonly bg: BgServerTracker;
	private readonly modelAdmin: ModelAdminService;
	private readonly agentDir: string;

	private readonly slash: SlashCommandsService;
	private readonly pluginCommandsProvider?: () => PluginCommandDef[];
	private readonly onQuit?: () => boolean;
	private readonly subagentTemplates: SubagentTemplatesStore;
	private skillsCache: DiscoveredSkill[] = [];

	private disposed = false;
	private rev = 1;
	private version = 1;
	private activeConvId: string;
	private conversations = new Map<string, UniversalConversation>();

	public isStreaming = false;
	/** 在途回合归属的会话 id（#700/#701）：prompt 开始时锚定，finalizeTurn 收尾时消费并清空。
	 *  会话切换/回滚不再让流式回写与回合收尾锚错会话，避免跨对话内容污染落盘。 */
	private turnConvId: string | null = null;
	private streamingMessage: UiMessage | null = null;
	private streamingThinking = "";
	private streamingText = "";
	private deltaSeq = 0;
	private snapshotTimer: NodeJS.Timeout | null = null;
	private pendingToolResults: UiMessage[] = [];
	private readonly sessionDrafts = new Map<string, { text: string; ts: number }>();
	private followUpQueue: QueuedMessageEntry[] = [];

	private readonly engine: string;
	private currentModel = "claude-3-7-sonnet-20250219";
	private thinkingLevel = "medium";
	private lang = "zh";
	private readonly modelsMap = new Map<string, { id: string; name: string; provider: string; vision: boolean }>();

	private readonly driverFactory?: DriverFactory;
	private readonly subagentDrivers = new Map<string, BaseAgentDriver>();
	private subagentHandoffs: SubagentHandoffRecord[] = [];
	private readonly subagentWaitListeners = new Set<() => void>();
	public readonly subagentHost: SubagentToolHost;
	public readonly webUi: WebUIContext;

	constructor(opts: {
		clientId: string;
		cwd: string;
		dataDir?: string;
		agentDir?: string;
		send: (msg: ServerMessage) => void;
		store: UniversalSessionStore;
		stateStore?: ClientStateStore;
		driver: BaseAgentDriver;
		driverFactory?: DriverFactory;
		lang?: string;
		engine?: string;
		pluginCommandsProvider?: () => PluginCommandDef[];
		onQuit?: () => boolean;
	}) {
		this.clientId = opts.clientId;
		this.cwd = opts.cwd;
		this.dataDir = opts.dataDir ?? (opts.stateStore as any)?.dataDir ?? "";
		this.agentDir = opts.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? "";
		this.engine = opts.engine ?? (opts.driver.id === "claude-code" ? "claude" : opts.driver.id);
		this.sinks.add(opts.send);
		this.store = opts.store;
		this.stateStore = opts.stateStore;
		this.driver = opts.driver;
		this.driverFactory = opts.driverFactory;
		this.pluginCommandsProvider = opts.pluginCommandsProvider;
		this.onQuit = opts.onQuit;
		this.sandboxes = new SandboxManager(this.dataDir);
		void this.refreshWorktreeInfo();
		this.lang = opts.lang ?? "zh";
		this.webUi = new WebUIContext((msg) => this.send(msg));

		const templatesPath = join(
			this.dataDir || process.env.PI_WEB_DATA_DIR || join(homedir(), ".pi-web"),
			"subagent-templates.json",
		);
		this.subagentTemplates = new SubagentTemplatesStore(templatesPath);

		this.subagentHost = {
			spawnSubagent: async (
				prompt,
				type,
				cwd,
				templateName,
				model,
				parentId,
				persist,
				thinking,
				notifyOnDone,
				_isolation,
			) => {
				const { convId } = await this.spawnSubagent(
					prompt,
					type,
					cwd,
					templateName,
					model,
					parentId,
					persist,
					undefined,
					thinking,
					notifyOnDone,
				);
				return convId;
			},
			finalizeSubagentWorktree: async (_convId: string) => {},
			getSubagent: (convId: string) => {
				const conv = this.conversations.get(convId);
				if (!conv || !conv.isSubagent) return undefined;
				return this.subagentToSnapshot(conv);
			},
			listSubagents: (scope?: "all" | "subagent" | "persistent") => this.listSubagents(scope),
			steerSubagent: (convId: string, message: string) => this.steerSubagent(convId, message),
			stopSubagent: (convId: string) => this.stopSubagent(convId),
			markSubagentsConsumed: (_runIds: string[]) => {},
			listTemplates: () =>
				this.subagentTemplates
					.list()
					.filter((t) => t.enabled !== false)
					.map((t) => ({
						name: t.name,
						description: t.description,
						descriptionEn: t.descriptionEn,
						model: t.model,
						thinkingLevel: t.thinkingLevel,
					})),
			isTemplateUsable: (name: string) => {
				const t = this.subagentTemplates.get(name);
				return !!t && t.enabled !== false;
			},
			getWatchdogTimeoutMs: () => 20 * 60_000,
			handoffSubagent: (fromRunId: string, toRunId: string, payload: string) =>
				this.handoffSubagent(fromRunId, toRunId, payload),
			lang: () => this.lang as ServerLang,
		};

		this.slash = new SlashCommandsService({
			emit: (msg) => this.send(msg),
			cwd: () => this.cwd,
			newChat: () => this.newChat(),
			prompt: (text) => this.prompt(text),
			setModel: (id) => this.setModel(id),
			setCwd: (path) => this.setCwd(path),
			setThinking: (level) => this.setThinking(level),
			renameSession: async (name) => {
				await this.renameConversation(this.activeConvId, name);
				this.emitNotice("info", `已重命名当前会话为「${name}」`, `Renamed current session to "${name}"`);
			},
			getSessionName: () => this.activeConv.title,
			refreshSessions: () => this.refreshSessions(),
			onQuit: () => this.onQuit?.() ?? false,
			getModel: () => this.resolveCurrentModelInfo(),
			getAvailableModels: async () => this.listAvailableModelsForSlash(),
			getSkills: async () => this.collectUniversalSkills(),
			getExtraCommands: async () => {
				const driverCmds = this.driver.getSlashCommands ? await this.driver.getSlashCommands() : [];
				const subagentCmd: SlashCommandInfo = {
					name: "subagent",
					description:
						this.lang === "zh"
							? "派发后台异步轻量子代理执行任务（用法: /subagent <提示词>）"
							: "Spawn a background subagent to execute a task (/subagent <prompt>)",
					argumentHint: "<提示词>",
					argumentHintEn: "<prompt>",
					source: "builtin",
				};
				return [subagentCmd, ...driverCmds];
			},
			execExtraCommand: async (name, args) =>
				this.driver.execSlashCommand
					? await this.driver.execSlashCommand(name, args, {
							emitNotice: (lvl, txt, txtEn) => this.emitNotice(lvl, txt, txtEn),
						})
					: false,
			compact: async (args) => {
				await this.compactActiveConversation(args);
			},
			reload: async () => {
				await this.reloadSessionResources();
			},
			pluginCommands: () => this.pluginCommandsProvider?.() ?? [],
			execPluginCommand: async (name, args) => {
				const def = this.pluginCommandsProvider?.().find((c) => c.name === name);
				if (!def) return false;
				try {
					const result = await def.run(args, {
						clientId: this.clientId,
						uiContext: this.webUi,
						webUi: this.webUi,
					} as any);
					if (typeof result === "string" && result.trim()) {
						this.emitNotice("info", result, result);
					}
				} catch (err) {
					const msg = (err as Error).message;
					this.emitNotice("error", `插件命令 /${name} 执行失败：${msg}`, `Plugin command /${name} failed: ${msg}`);
				}
				return true;
			},
		});

		const markerStateStore =
			this.stateStore ??
			({
				getMarkerSettings: () => ({ markersEnabled: true, disabledMarkers: [] }),
				saveMarkerSettings: () => {},
			} as unknown as ClientStateStore);

		this.markerSvc = new MarkerService({
			clientId: this.clientId,
			stateStore: markerStateStore,
			emit: (msg) => this.send(msg),
			isDisposed: () => this.disposed,
			getActiveConversationId: () => this.activeConvId,
			getSessionManager: () => undefined,
			renameConversation: (convId, title) => {
				void this.renameConversation(convId, title);
			},
			refreshMarkers: () => this.flushSnapshot(),
			onActionsChange: (convId) => {
				if (convId === this.activeConvId) this.flushSnapshot();
			},
			lang: () => this.getLang() as any,
		});
		if (opts.driver.id === "claude-code") {
			this.currentModel = "claude-3-7-sonnet-20250219";
			this.seedDefaultClaudeModels();
		} else if (opts.driver.id === "dsh") {
			this.currentModel = "deepseek/deepseek-v4-flash";
			this.thinkingLevel = "high";
			this.seedDefaultDshModels();
		} else {
			this.currentModel = (opts.driver as any).currentModel ?? "default";
		}
		// 恢复上次使用的模型（按引擎独立记录：项目记忆优先 > 全局默认）
		const savedModel =
			opts.stateStore?.getProjectModel(opts.clientId, opts.cwd, this.engine) ??
			opts.stateStore?.getDefaultModel(this.engine);
		if (savedModel) {
			this.currentModel = savedModel;
		}

		if (typeof this.driver.setThinkingLevel === "function") {
			this.driver.setThinkingLevel(this.thinkingLevel);
		}

		this.modelAdmin = new ModelAdminService({
			agentDir: this.agentDir,
			emit: (msg) => this.send(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			pushModels: async () => this.listModels(),
		});

		this.files = new FilesService({
			emit: (msg) => this.send(msg),
			isDisposed: () => this.disposed,
			getCwd: () => this.cwd,
			getActiveCwd: () => this.cwd,
		});

		this.terminals = new TerminalManager(
			(msg) => this.send(msg),
			this.cwd,
			() => this.getLang(),
		);

		this.bg = new BgServerTracker({
			emit: (msg) => this.send(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			pluginTasks: () => [],
			cleanupMinutes: () => 0,
			workspaceCwd: () => this.cwd,
		});

		// 加载现有会话或创建初始会话
		const existing = this.store.listConversations(this.cwd);
		if (existing.length > 0) {
			for (const conv of existing) {
				this.conversations.set(conv.id, conv);
			}
			this.activeConvId = existing[0].id;
		} else {
			const initialConv = this.createEmptyConversation("新对话");
			this.activeConvId = initialConv.id;
			this.conversations.set(initialConv.id, initialConv);
			this.store.saveConversation(this.cwd, initialConv);
		}

		// 记录当前客户端访问的工作区
		if (typeof this.stateStore?.remember === "function" && this.cwd) {
			this.stateStore.remember(this.clientId, this.cwd);
		}

		// 若驱动为 Claude Code，异步探测环境并下发安装指引
		if (this.driver instanceof ClaudeCodeDriver) {
			void probeClaudeCode().then((probe) => {
				if (!probe.installed && !this.disposed) {
					this.emitNotice(
						"warning",
						"未检测到全局安装的 Claude Code CLI。请在终端执行 npm i -g @anthropic-ai/claude-code 安装并运行 claude 登录。",
						"Claude Code CLI not found; run: npm i -g @anthropic-ai/claude-code and log in with claude.",
					);
				}
			});
		}
	}

	private seedDefaultClaudeModels(): void {
		const defaults = [
			{ id: "claude-3-7-sonnet-20250219", name: "Claude 3.7 Sonnet" },
			{ id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet" },
			{ id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku" },
			{ id: "claude-3-opus-20240229", name: "Claude 3 Opus" },
		];
		for (const d of defaults) {
			const canonicalId = `${this.driver.id}/${d.id}`;
			const entry = { id: d.id, name: d.name, provider: this.driver.id, vision: true };
			this.modelsMap.set(canonicalId, entry);
			this.modelsMap.set(d.id, entry);
		}
	}

	private seedDefaultDshModels(): void {
		const defaults = [
			{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", vision: false },
			{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", vision: false },
			{ id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision (exp)", vision: true },
		];
		for (const d of defaults) {
			const canonicalId = `deepseek/${d.id}`;
			const entry = { id: d.id, name: d.name, provider: "deepseek", vision: d.vision };
			this.modelsMap.set(canonicalId, entry);
			this.modelsMap.set(d.id, entry);
		}
	}

	private resolveCurrentModelInfo(): { id: string; name: string; provider: string; vision: boolean } {
		const found = this.modelsMap.get(this.currentModel);
		if (found) return found;

		if (this.currentModel.includes("/")) {
			const slash = this.currentModel.indexOf("/");
			const provider = this.currentModel.slice(0, slash);
			const bareId = this.currentModel.slice(slash + 1);
			return {
				id: bareId,
				name: bareId,
				provider,
				vision: true,
			};
		}

		return {
			id: this.currentModel,
			name:
				this.currentModel === "claude-3-7-sonnet-20250219"
					? "Claude 3.7 Sonnet"
					: this.currentModel === "deepseek-v4-flash"
						? "DeepSeek V4 Flash"
						: this.currentModel,
			provider: this.driver.id === "dsh" ? "deepseek" : this.driver.id,
			vision: true,
		};
	}

	private resolveCurrentModelContextWindow(): number {
		const { providers } = readModelsJson(this.agentDir);
		for (const p of Object.values(providers)) {
			if (Array.isArray(p.models)) {
				for (const m of p.models) {
					const row = m as Record<string, unknown>;
					if (
						typeof row.id === "string" &&
						(row.id === this.currentModel || this.currentModel.endsWith(`/${row.id}`))
					) {
						if (typeof row.contextWindow === "number" && row.contextWindow > 0) {
							return row.contextWindow;
						}
					}
				}
			}
		}
		return 200_000;
	}

	private get activeConv(): UniversalConversation {
		let conv = this.conversations.get(this.activeConvId);
		if (!conv) {
			conv = this.createEmptyConversation("新对话");
			this.activeConvId = conv.id;
			this.conversations.set(conv.id, conv);
		}
		return conv;
	}

	private createEmptyConversation(title: string, ephemeral = false): UniversalConversation {
		const now = Date.now();
		return {
			id: `uconv-${now}-${randomUUID().slice(0, 8)}`,
			title,
			createdAt: now,
			updatedAt: now,
			messages: [],
			isEphemeral: Boolean(ephemeral),
			stats: {
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
				contextUsage: { tokens: null, contextWindow: this.resolveCurrentModelContextWindow(), percent: null },
			},
		};
	}

	attachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.add(send);
		this.pushSettings();
		void this.pushSlashCommands();
		const defModel = this.stateStore?.getDefaultModel(this.engine);
		if (defModel) {
			send({ type: "default_model", modelId: defModel });
		}
		const terminals = this.terminals.list();
		if (terminals.length > 0) {
			this.send({ type: "terminal_list", conversationId: this.activeConvId, terminals });
		}
		this.bg.push();
		void this.refreshSessions();
		void this.pushProjects();
		this.flushSnapshot(true);
	}

	detachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.delete(send);
	}

	sinkCount(): number {
		return this.sinks.size;
	}

	private send(msg: ServerMessage): void {
		for (const sink of this.sinks) {
			try {
				sink(msg);
			} catch {
				/* ignore send error on broken pipe */
			}
		}
	}

	flushSnapshot(_forceFull = false): void {
		if (this.disposed) return;
		this.rev++;
		this.version++;

		const conv = this.activeConv;
		const curModel = this.resolveCurrentModelInfo();
		const win = this.resolveCurrentModelContextWindow();
		const convStats = conv.stats ?? {
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			contextUsage: { tokens: null, contextWindow: win, percent: null },
		};
		const contextUsage = {
			...convStats.contextUsage,
			contextWindow: win,
			percent:
				convStats.contextUsage.tokens !== null && win > 0
					? Math.min(100, Math.round((convStats.contextUsage.tokens / win) * 100))
					: null,
		};
		const state: UiState = {
			clientId: this.clientId,
			cwd: this.cwd,
			sessionId: conv.id,
			sessionFile: conv.id,
			conversationId: conv.id,
			rev: this.rev,
			messages: conv.messages,
			// 回合归属会话才携带流式态：切走后的前台会话快照不再混入后台回合内容（#701）
			streamingMessage: !this.turnConvId || this.turnConvId === conv.id ? this.streamingMessage : null,
			isStreaming: !this.turnConvId || this.turnConvId === conv.id ? this.isStreaming : false,
			isEphemeral: Boolean(conv.isEphemeral),
			draft: this.sessionDrafts.get(conv.id) ?? null,
			model: {
				id: curModel.id,
				name: curModel.name,
				provider: curModel.provider,
				vision: curModel.vision,
			},
			thinkingLevel: this.thinkingLevel,
			availableThinkingLevels:
				typeof this.driver.getSupportedThinkingLevels === "function"
					? this.driver.getSupportedThinkingLevels()
					: ["off", "low", "medium", "high"],
			queue: {
				steering: [],
				followUp: this.followUpQueue.map((q) => q.text),
				entries: {
					steering: [],
					followUp: toQueuedPromptItems(this.followUpQueue),
				},
			},
			tools: [],
			version: this.version,
			engineCapabilities: this.driver.getEngineCapabilities?.() ?? DEFAULT_UNIVERSAL_CAPABILITIES,
			sandbox: this.sandboxes.getByCwd(this.cwd) ?? null,
			worktree: this.worktreeInfo,
			workspaceRoots: this.stateStore?.getWorkspaceRoots(this.clientId, this.cwd) ?? [],
			actionSuggestions: this.markerSvc.getActionSuggestions(conv.id) ?? null,
			subagentHandoffs: this.subagentHandoffs.length > 0 ? [...this.subagentHandoffs] : undefined,
			piConfigured: true,
			piAgentInstalled: true,
			stats: {
				totalMessages: conv.messages.length,
				tokens: convStats.tokens,
				cost: convStats.cost,
				contextUsage,
			},
		};

		this.send({ type: "snapshot", state });
	}

	getCapabilities() {
		return this.driver.getEngineCapabilities?.() ?? DEFAULT_UNIVERSAL_CAPABILITIES;
	}

	private scheduleThrottledSnapshot(): void {
		if (this.snapshotTimer) return;
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = null;
			this.flushSnapshot();
		}, SNAPSHOT_INTERVAL_MS);
	}

	// ---------------------------------------------------------------------------
	// 核心 Prompt 流程
	// ---------------------------------------------------------------------------

	private static isDefaultTitle(title?: string): boolean {
		const t = (title ?? "").trim();
		return !t || t === "新对话" || t === "New chat" || t === "New Chat" || t === "对话" || t === "Chat";
	}

	async prompt(text: string, attachments?: PromptAttachment[], _queue?: boolean): Promise<void> {
		if (this.isStreaming) {
			if (_queue === true) {
				const entry = createQueuedEntry(text, { attachments });
				this.followUpQueue.push(entry);
				this.flushSnapshot();
				this.emitNotice(
					"info",
					"已加入排队，将在当前回复生成完成后自动发送",
					"Queued — will send after current response settles",
				);
				return;
			}
			// 插队（steer）：中断当前轮次并提交新问题
			this.emitNotice(
				"info",
				"正在插队，中断当前生成并提交新问题...",
				"Steering: aborting current turn and submitting prompt...",
			);
			await this.abort();
		}

		// 1. 拦截与执行斜杠命令（内置 / 插件 / 驱动扩展 / 技能指令 / 子代理命令）
		const slash = parseSlash(text);
		if (slash) {
			if (slash.name === "subagent" || slash.name.startsWith("subagent:")) {
				const type = slash.name.startsWith("subagent:") ? slash.name.slice(9) : "general";
				const subPrompt = slash.args.trim();
				if (!subPrompt) {
					this.emitNotice(
						"warning",
						"请提供子代理的任务指令，如 /subagent 探索当前代码库",
						"Please provide a prompt for the subagent, e.g. /subagent explore code repository",
					);
					return;
				}
				try {
					const { convId } = await this.spawnSubagent(subPrompt, type, this.cwd);
					this.emitNotice(
						"info",
						`已派发子代理（ID: ${convId.slice(0, 8)}），可在左侧对话列表查看其流式进展`,
						`Spawned subagent (${convId.slice(0, 8)}). Track its progress in the left conversation list`,
					);
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					this.emitNotice("error", `派发子代理失败: ${msg}`, `Failed to spawn subagent: ${msg}`);
				}
				return;
			}
			if (slash.name.startsWith("skill:")) {
				const skillName = slash.name.slice(6);
				const skills = await this.collectUniversalSkills();
				const found = skills.find(
					(s) =>
						s.name.toLowerCase() === skillName.toLowerCase() ||
						`skill:${s.name}`.toLowerCase() === slash.name.toLowerCase(),
				);
				if (found) {
					const instruction = readSkillInstruction(found.filePath);
					const skillPrompt = instruction
						? `[Skill: ${found.name}]\n${instruction}\n\n[User Prompt]\n${slash.args || "执行此技能"}`
						: slash.args || text;
					return this.prompt(skillPrompt, attachments, _queue);
				}
			}
			const handled = await this.slash.exec(slash.name, slash.args);
			if (handled) return;
		}

		this.isStreaming = true;
		const conv = this.activeConv;
		this.turnConvId = conv.id;
		const now = Date.now();

		// 2. 扫描用户文本中的 @ 提及（文件路径与技能指令）
		const availableSkills = await this.collectUniversalSkills();
		const scanResult = scanAtMentions(text, this.cwd, availableSkills, attachments ?? []);
		const effectiveAttachments = [...(attachments ?? []), ...scanResult.detectedAttachments];
		const finalPrompt = formatPromptWithSkills(text, scanResult.detectedSkills);

		// 3. 自动根据首条提问为新会话命名（首条提问立即刷新左侧栏运行与历史列表）
		const hasNoUserMessages = !conv.messages.some((m) => m.role === "user");
		if (UniversalSession.isDefaultTitle(conv.title) && hasNoUserMessages && text.trim()) {
			const trimmed = text.trim().replace(/\s+/g, " ");
			const cleanTitle = trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed;
			conv.title = cleanTitle;
			if (this.stateStore) {
				this.stateStore.saveSessionTitle(this.cwd, conv.id, cleanTitle);
			}
			if (!conv.isEphemeral) {
				this.store.saveConversation(this.cwd, conv);
			}
			void this.refreshSessions();
		}

		// 4. 插入用户消息以及附件卡片（保证 Web UI 附件卡片折叠呈现与历史复原）
		const userMsg: UiMessage = {
			id: `u-${now}-${randomUUID().slice(0, 6)}`,
			role: "user",
			content: [{ type: "text", text }],
			timestamp: now,
		};
		conv.messages.push(userMsg);

		if (effectiveAttachments.length > 0) {
			const attCards = createAttachmentUiMessages(effectiveAttachments, now);
			for (const card of attCards) {
				conv.messages.push(card);
			}
		}

		conv.updatedAt = now;
		if (!conv.isEphemeral) {
			this.store.saveConversation(this.cwd, conv);
		}

		// 用户发送了提示词，消费并清除当前会话的草稿
		this.sessionDrafts.delete(conv.id);

		// 确保底层驱动与当前对话的 driverSessionId 上下文同步（保证多轮对话连续且新建对话隔离）
		if (conv.driverSessionId) {
			await this.driver.resumeSession(conv.driverSessionId);
		} else {
			const sid = await this.driver.createSession();
			conv.driverSessionId = sid;
			if (!conv.isEphemeral) {
				this.store.saveConversation(this.cwd, conv);
			}
		}

		// 3. 准备助手流式消息
		const assistantMsgId = `a-${now}-${randomUUID().slice(0, 6)}`;
		this.streamingThinking = "";
		this.streamingText = "";
		this.streamingMessage = {
			id: assistantMsgId,
			role: "assistant",
			content: [],
			timestamp: now,
			model: this.currentModel,
		};

		this.flushSnapshot();

		// 4. 构建 AgentEventSink（时序保真：思考 -> 前置正文 -> 工具调用 -> 总结正文）
		const sink: AgentEventSink = {
			onThinkingDelta: (delta: string) => {
				this.streamingThinking += delta;
				if (!this.streamingMessage) return;
				let thinkBlock = this.streamingMessage.content.find((b) => b.type === "thinking") as
					UiThinkingBlock | undefined;
				if (!thinkBlock) {
					thinkBlock = { type: "thinking", thinking: "" };
					this.streamingMessage.content.unshift(thinkBlock);
				}
				thinkBlock.thinking = this.streamingThinking;
				this.emitDelta({ type: "thinking_delta", delta });
				this.scheduleThrottledSnapshot();
			},
			onTextDelta: (delta: string) => {
				this.streamingText += delta;
				if (!this.streamingMessage) return;
				const lastBlock = this.streamingMessage.content[this.streamingMessage.content.length - 1];
				if (lastBlock && lastBlock.type === "text" && !lastBlock.truncated) {
					(lastBlock as UiTextBlock).text += delta;
				} else {
					this.streamingMessage.content.push({ type: "text", text: delta });
				}
				this.emitDelta({ type: "text_delta", delta });
				this.scheduleThrottledSnapshot();
			},
			onToolStart: (callId: string, toolName: string, args: Record<string, unknown>) => {
				if (!this.streamingMessage) return;
				const toolBlock: UiContentBlock = {
					type: "toolCall",
					id: callId,
					name: toolName,
					argumentsText: JSON.stringify(args, null, 2),
				};
				this.streamingMessage.content.push(toolBlock);
				this.scheduleThrottledSnapshot();
			},
			onToolEnd: (callId: string, result: { output?: string; error?: string }) => {
				const toolMsg: UiMessage = {
					id: `t-${callId}`,
					role: "toolResult",
					toolCallId: callId,
					content: [{ type: "text", text: result.output ?? result.error ?? "" }],
					isError: Boolean(result.error),
					timestamp: Date.now(),
				};
				this.pendingToolResults.push(toolMsg);
				this.scheduleThrottledSnapshot();
			},
			onTurnComplete: (meta) => {
				this.finalizeTurn(meta);
			},
			onError: (err) => {
				const errText = typeof err === "string" ? err : err.message;
				this.emitNotice("error", `执行出错: ${errText}`, `Execution error: ${errText}`);
				this.finalizeTurn();
			},
		};

		try {
			await this.driver.sendPrompt(finalPrompt, effectiveAttachments, sink);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			this.emitNotice("error", `驱动执行异常: ${msg}`, `Driver execution error: ${msg}`);
			this.finalizeTurn();
		}
	}

	private updateStreamingContent(): void {
		if (!this.streamingMessage) return;
		const content: UiContentBlock[] = [];
		if (this.streamingThinking) {
			content.push({ type: "thinking", thinking: this.streamingThinking });
		}
		if (this.streamingText) {
			content.push({ type: "text", text: this.streamingText });
		}
		// 保留之前追加的 toolCall blocks
		for (const b of this.streamingMessage.content) {
			if (b.type === "toolCall") {
				content.push(b);
			}
		}
		this.streamingMessage.content = content;
	}

	private emitDelta(assistantMessageEvent: { type: string; delta?: string }): void {
		if (!this.streamingMessage) return;
		this.send({
			type: "message_delta",
			conversationId: this.turnConvId ?? this.activeConvId,
			seq: ++this.deltaSeq,
			messageId: this.streamingMessage.id,
			usage: null,
			assistantMessageEvent,
		});
	}

	private finalizeTurn(meta?: AgentTurnMeta): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}

		// 回合收尾锚定回合归属会话：中途切走/回滚不再把本轮内容写进别的会话（#700/#701）
		const turnId = this.turnConvId;
		this.turnConvId = null;
		const conv = (turnId && this.conversations.get(turnId)) || this.activeConv;

		if (this.streamingMessage) {
			conv.messages.push(this.streamingMessage);
			this.streamingMessage = null;
		}

		if (this.pendingToolResults.length > 0) {
			conv.messages.push(...this.pendingToolResults);
			this.pendingToolResults = [];
		}

		// 累计会话统计与上下文占用（底座统一驱动底栏上下文环、Token 计数、缓存命中率与累计成本）
		if (!conv.stats) {
			conv.stats = {
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
				contextUsage: { tokens: null, contextWindow: this.resolveCurrentModelContextWindow(), percent: null },
			};
		}

		if (meta?.usage) {
			const u = meta.usage;
			conv.stats.tokens.input += u.inputTokens ?? 0;
			conv.stats.tokens.output += u.outputTokens ?? 0;
			conv.stats.tokens.cacheRead += u.cacheReadTokens ?? 0;
			conv.stats.tokens.cacheWrite += u.cacheWriteTokens ?? 0;
			conv.stats.tokens.total = conv.stats.tokens.input + conv.stats.tokens.output;

			const turnCost = meta.costUSD ?? u.costUSD ?? 0;
			conv.stats.cost += turnCost;

			const win = meta.contextWindow ?? u.contextWindow ?? this.resolveCurrentModelContextWindow();
			const promptTokens = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
			const turnOutput = u.outputTokens ?? 0;
			const totalCtx = meta.contextTokens ?? u.contextTokens ?? (promptTokens > 0 ? promptTokens + turnOutput : null);

			conv.stats.contextUsage = {
				tokens: totalCtx,
				contextWindow: win,
				percent: totalCtx !== null && win > 0 ? Math.min(100, Math.round((totalCtx / win) * 100)) : null,
			};
		}

		// 回写 Claude 分配的 session ID（保证多轮上下文连续）
		if (typeof (this.driver as any).getActiveSessionId === "function") {
			const activeSid = (this.driver as any).getActiveSessionId();
			if (activeSid && conv.driverSessionId !== activeSid) {
				conv.driverSessionId = activeSid;
			}
		}

		this.isStreaming = false;
		this.streamingThinking = "";
		// 先取本轮全文再清空：内联标记解析在清空之后读 streamingText，
		// 条件恒为 false，[[conv:rename]]/[[action:suggest]] 在 universal
		// 引擎（claude/durable 等驱动）下从不被解析。
		const finalText = this.streamingText;
		this.streamingText = "";
		conv.updatedAt = Date.now();
		if (!conv.isEphemeral) {
			this.store.saveConversation(this.cwd, conv);
		}
		// 解析本轮生成的内联标记（如 [[conv:rename:...]] / [[action:suggest:...]]）
		if (finalText && finalText.includes("[[")) {
			void this.markerSvc.handleAssistantText(conv.id, finalText);
		}
		this.flushSnapshot();
		void this.refreshSessions();

		// 检查排队消息并自动处理
		if (this.followUpQueue.length > 0) {
			const next = this.followUpQueue.shift()!;
			this.flushSnapshot(true);
			void this.prompt(next.text, next.attachments);
		}
	}

	async abort(): Promise<void> {
		if (this.isStreaming) {
			await this.driver.abort();
			this.finalizeTurn();
			this.emitNotice("info", "已停止生成", "Generation stopped");
		}
	}

	async abortBash(): Promise<void> {
		await this.abort();
	}

	async retryLast(): Promise<void> {
		const conv = this.activeConv;
		// 找到最后一条 user 消息重新发送
		for (let i = conv.messages.length - 1; i >= 0; i--) {
			const m = conv.messages[i];
			if (m.role === "user") {
				const textBlock = m.content.find((b) => b.type === "text");
				if (textBlock && "text" in textBlock && typeof textBlock.text === "string") {
					await this.prompt(textBlock.text);
					return;
				}
			}
		}
	}

	removeQueued(kind: "steer" | "followUp", text: string, index?: number, id?: string): void {
		if (kind === "followUp") {
			const next = removeQueuedEntry(this.followUpQueue, { id, text, index });
			if (next.length !== this.followUpQueue.length) {
				this.followUpQueue = next;
				this.flushSnapshot();
			}
		}
	}

	// ---------------------------------------------------------------------------
	// 对话生命周期
	// ---------------------------------------------------------------------------

	async newChat(_preset?: string, ephemeral = false): Promise<boolean | void> {
		const newConv = this.createEmptyConversation("新对话", Boolean(ephemeral));
		this.conversations.set(newConv.id, newConv);
		this.activeConvId = newConv.id;
		if (!newConv.isEphemeral) {
			this.store.saveConversation(this.cwd, newConv);
		}
		this.flushSnapshot(true);
		void this.refreshSessions();
		return true;
	}

	async switchConversation(id: string): Promise<void> {
		let conv = this.conversations.get(id);
		if (!conv) {
			conv = this.store.loadConversation(this.cwd, id) ?? undefined;
			if (conv) this.conversations.set(conv.id, conv);
		}
		if (conv) {
			this.activeConvId = conv.id;
			// 同步底层驱动会话上下文（若存在）
			if (conv.driverSessionId) {
				await this.driver.resumeSession(conv.driverSessionId).catch(() => {});
			}
		} else {
			this.emitNotice(
				"warning",
				"未能找到目标会话，已保持在当前对话",
				"Target conversation not found, staying on current conversation",
			);
		}
		this.flushSnapshot(true);
		void this.refreshSessions();
	}

	async switchSession(path: string, sessionId?: string): Promise<void> {
		const targetId = sessionId || path;
		if (targetId) {
			await this.switchConversation(targetId);
		} else {
			this.flushSnapshot(true);
		}
		this.send({
			type: "transition_progress",
			kind: "session",
			target: path,
			phase: "done",
			progress: 100,
			text: "会话加载完成",
			textEn: "Session loaded",
		});
	}

	async renameConversation(id: string, name: string): Promise<void> {
		const trimmed = (name ?? "").trim();
		if (!trimmed) return;
		const conv = this.conversations.get(id);
		if (conv) {
			conv.title = trimmed;
			conv.updatedAt = Date.now();
			if (!conv.isEphemeral) {
				this.store.saveConversation(this.cwd, conv);
			}
			if (this.stateStore) {
				this.stateStore.saveSessionTitle(this.cwd, id, trimmed);
			}
			this.flushSnapshot();
			void this.refreshSessions();
		}
	}

	async renameSession(path: string, name: string): Promise<void> {
		const trimmed = (name ?? "").trim();
		if (!trimmed) return;
		const id = path.trim() || this.activeConvId;
		const conv = this.conversations.get(id) ?? (this.activeConvId === id ? this.activeConv : null);
		if (conv) {
			conv.title = trimmed;
			conv.updatedAt = Date.now();
			if (!conv.isEphemeral) {
				this.store.saveConversation(this.cwd, conv);
			}
			this.flushSnapshot();
			void this.refreshSessions();
		}
	}

	async deleteSession(path: string): Promise<void> {
		const targetId = path.trim() || this.activeConvId;
		// 1. 从磁盘删除持久化会话记录
		this.store.deleteConversation(this.cwd, targetId);
		// 2. 若内存中存在该会话，将其从内存中移除
		if (this.conversations.has(targetId)) {
			await this.dismissConversation(targetId, true, true);
		} else {
			void this.refreshSessions();
			this.flushSnapshot();
		}
	}

	async dismissConversation(id: string, withFinishedSubagents = false, force = false): Promise<void> {
		const conv = this.conversations.get(id);
		if (!conv) return;

		// 若指定 withFinishedSubagents，级联清理该父会话下的已结束子代理
		if (withFinishedSubagents) {
			const kids = Array.from(this.conversations.values()).filter(
				(c) => c.isSubagent && c.subagentParentId === id && !c.subagentStreaming,
			);
			for (const kid of kids) {
				await this.dismissConversation(kid.id, false, force);
			}
		}

		// 若清理的本身是运行中的子代理，立即中止并清理其驱动
		if (conv.isSubagent && conv.subagentStreaming) {
			await this.stopSubagent(id);
		}

		// 仅从运行中会话映射与草稿中移除，保留磁盘持久化记录（供历史面板随时回溯打开）
		this.conversations.delete(id);
		this.sessionDrafts.delete(id);

		if (this.activeConvId === id) {
			const nonSubagents = Array.from(this.conversations.values()).filter((c) => !c.isSubagent);
			if (nonSubagents.length > 0) {
				this.activeConvId = nonSubagents[0].id;
			} else {
				const anyRemaining = Array.from(this.conversations.values());
				if (anyRemaining.length > 0) {
					this.activeConvId = anyRemaining[0].id;
				} else {
					await this.newChat();
					return;
				}
			}
		}
		this.flushSnapshot();
		void this.refreshSessions();
	}

	async dismissFinishedSubagents(parentId?: string): Promise<void> {
		const targets = Array.from(this.conversations.values()).filter(
			(c) => c.isSubagent && !c.subagentStreaming && (!parentId || c.subagentParentId === parentId),
		);
		for (const t of targets) {
			await this.dismissConversation(t.id, false, true);
		}
	}

	async pinSession(path: string, pinned: boolean): Promise<void> {
		const targetId = path.trim() || this.activeConvId;
		await this.setConversationPinned(targetId, pinned);
	}

	async setConversationPinned(id: string, pinned: boolean): Promise<void> {
		const conv = this.conversations.get(id);
		if (conv) {
			conv.pinned = pinned;
			if (!conv.isEphemeral) {
				this.store.pinConversation(this.cwd, id, pinned);
			}
			if (this.stateStore) {
				this.stateStore.setSessionPinned(this.cwd, id, pinned);
			}
			this.flushSnapshot();
			void this.refreshSessions();
		}
	}

	saveDraft(sessionId: string, text: string, ts: number): void {
		if (!text) {
			this.sessionDrafts.delete(sessionId);
		} else {
			this.sessionDrafts.set(sessionId, { text, ts: ts || Date.now() });
		}
	}

	async rollbackSession(messageId: string, conversationId?: string, _restoreWorkspace?: boolean): Promise<void> {
		let targetConv = conversationId
			? (this.conversations.get(conversationId) ?? this.store.loadConversation(this.cwd, conversationId) ?? undefined)
			: undefined;
		if (!targetConv) {
			targetConv = this.activeConv;
		}

		// 回滚与在途回合互斥：先落定在途回合再截断，否则 finalize 与 slice 交错导致截断/错位（#700）
		if (targetConv.id === this.activeConvId && (this.isStreaming || this.streamingMessage)) {
			await this.abort();
			targetConv = this.activeConv;
		}

		const idx = targetConv.messages.findIndex((m) => m.id === messageId);
		if (idx < 0) {
			this.emitNotice("error", "找不到指定的回滚目标消息", "Rollback target message not found");
			this.flushSnapshot();
			return;
		}

		// 回滚截断到该消息之前
		targetConv.messages = targetConv.messages.slice(0, idx);
		targetConv.updatedAt = Date.now();
		if (!targetConv.isEphemeral) {
			this.store.saveConversation(this.cwd, targetConv);
		}
		this.flushSnapshot(true);
		void this.refreshSessions();
		this.emitNotice("info", "已回滚到指定历史位置", "Rolled back to message");
	}

	async persistConversation(id: string): Promise<void> {
		const conv = this.conversations.get(id) ?? (this.activeConvId === id ? this.activeConv : null);
		if (!conv) {
			this.emitNotice("warning", "该对话不存在或已关闭", "This conversation does not exist or is already closed");
			return;
		}
		if (!conv.isEphemeral) {
			this.emitNotice(
				"info",
				`对话「${conv.title}」已是持久化对话，无需固化`,
				`Conversation "${conv.title}" is already persistent`,
			);
			return;
		}
		conv.isEphemeral = false;
		conv.updatedAt = Date.now();
		this.store.saveConversation(this.cwd, conv);
		this.flushSnapshot(true);
		void this.refreshSessions();
		this.emitNotice(
			"info",
			`临时对话「${conv.title}」已转为正式对话`,
			`Ephemeral conversation "${conv.title}" persisted`,
		);
	}

	async forkSession(messageId: string, position: "before" | "at" = "before", targetConvId?: string): Promise<void> {
		let targetConv = targetConvId
			? (this.conversations.get(targetConvId) ?? this.store.loadConversation(this.cwd, targetConvId) ?? undefined)
			: undefined;
		if (!targetConv) {
			targetConv = this.activeConv;
		}

		const idx = targetConv.messages.findIndex((m) => m.id === messageId);
		if (idx < 0) {
			this.emitNotice("error", "找不到指定的消息节点（可能不在当前分支）", "Message node to fork from not found");
			this.flushSnapshot();
			return;
		}

		const count = position === "at" ? idx + 1 : idx;
		const forkedMessages = structuredClone(targetConv.messages.slice(0, count));
		const forkedConv = this.createEmptyConversation(`${targetConv.title} (分支)`, Boolean(targetConv.isEphemeral));
		forkedConv.messages = forkedMessages;
		if (forkedMessages.length > 0) {
			forkedConv.updatedAt = Date.now();
		}

		// 若底层驱动支持原生会话分叉（如 Durable 引擎的原生 CoW 分叉），保持事务级上下文关联
		if (targetConv.driverSessionId && typeof this.driver.forkSession === "function") {
			try {
				const forkedSid = await this.driver.forkSession(targetConv.driverSessionId);
				if (forkedSid) {
					forkedConv.driverSessionId = forkedSid;
				}
			} catch {
				/* fallback */
			}
		}

		this.conversations.set(forkedConv.id, forkedConv);
		if (!forkedConv.isEphemeral) {
			this.store.saveConversation(this.cwd, forkedConv);
		}
		this.activeConvId = forkedConv.id;
		this.flushSnapshot(true);
		void this.refreshSessions();
		this.emitNotice("info", "已从指定消息分叉新会话", "Forked new session from message");
	}

	async editMessage(messageId: string, text: string, attachments?: PromptAttachment[]): Promise<void> {
		if (this.isStreaming) {
			this.emitNotice(
				"warning",
				"当前轮次正在生成中，请等待完成或点击停止",
				"Generation in progress, please wait or abort",
			);
			return;
		}

		const trimmed = text.trim();
		const hasAttachments = Boolean(attachments && attachments.length > 0);
		if (!trimmed && !hasAttachments) {
			this.emitNotice("warning", "编辑内容为空，已取消", "Edited content is empty — cancelled");
			this.flushSnapshot();
			return;
		}

		const conv = this.activeConv;
		const idx = conv.messages.findIndex((m) => m.id === messageId);
		if (idx < 0) {
			this.emitNotice("warning", "找不到要编辑的消息", "Message to edit not found");
			this.flushSnapshot();
			return;
		}

		// 截断到编辑点之前的所有历史消息（跳过属于本轮提问的前置附件卡片，避免 prompt 重新注入后附件重复），
		// fork 一个新的 UniversalConversation
		let cutIdx = idx;
		while (
			cutIdx > 0 &&
			conv.messages[cutIdx - 1]?.role === "custom" &&
			(conv.messages[cutIdx - 1] as { customType?: string })?.customType === "file"
		) {
			cutIdx--;
		}
		const headMessages = structuredClone(conv.messages.slice(0, cutIdx));
		const forkedConv = this.createEmptyConversation(conv.title, Boolean(conv.isEphemeral));
		forkedConv.messages = headMessages;
		if (headMessages.length > 0) {
			forkedConv.updatedAt = Date.now();
		}

		// 若底层驱动支持原生会话分叉（如 Durable 引擎），继承前序不可变记录
		if (conv.driverSessionId && typeof this.driver.forkSession === "function") {
			try {
				const forkedSid = await this.driver.forkSession(conv.driverSessionId);
				if (forkedSid) {
					forkedConv.driverSessionId = forkedSid;
				}
			} catch {
				/* fallback */
			}
		}

		this.conversations.set(forkedConv.id, forkedConv);
		if (!forkedConv.isEphemeral) {
			this.store.saveConversation(this.cwd, forkedConv);
		}
		this.activeConvId = forkedConv.id;
		this.flushSnapshot(true);
		void this.refreshSessions();

		// 将编辑后的内容作为新 prompt 投递执行，实现无缝编辑重试
		await this.prompt(text, attachments);
	}

	async refreshSessions(): Promise<void> {
		const memoryConvs = Array.from(this.conversations.values());
		const diskConvs = this.store.listConversations(this.cwd);
		const convMap = new Map<string, UniversalConversation>();
		for (const c of diskConvs) {
			convMap.set(c.id, c);
		}
		for (const c of memoryConvs) {
			convMap.set(c.id, c);
		}
		for (const c of convMap.values()) {
			const savedTitle = this.stateStore?.getSessionTitle(this.cwd, c.id);
			if (savedTitle && !UniversalSession.isDefaultTitle(savedTitle)) {
				c.title = savedTitle;
			}
		}
		const allList = Array.from(convMap.values()).sort((a, b) => b.updatedAt - a.updatedAt);

		const convs: ConversationSummary[] = allList.map((c) => ({
			id: c.id,
			title: c.title,
			updatedAt: c.updatedAt,
			createdAt: c.createdAt,
			pinned: Boolean(c.pinned),
			sessionPath: c.id,
			active: c.id === this.activeConvId,
			cwd: this.cwd,
			messageCount: c.messages.length,
			isStreaming: Boolean(c.id === this.activeConvId ? this.isStreaming : c.subagentStreaming),
			isSubagent: Boolean(c.isSubagent),
			subagentType: c.subagentType,
			subagentParentId: c.subagentParentId,
			subagentState: c.subagentState,
			subagentStreaming: c.subagentStreaming,
			subagentError: c.subagentError,
			subagentCanceled: c.subagentCanceled,
			isEphemeral: Boolean(c.isEphemeral),
		}));
		this.send({ type: "conversations", conversations: convs, activeId: this.activeConvId });

		// 左侧栏历史对话读取的是 sessions 消息（轻量临时子代理不污染长期历史列表）：
		const sessionSummaries: SessionSummary[] = allList
			.filter((c) => !c.isSubagent || !c.isEphemeral)
			.map((c) => {
				const firstUser = c.messages.find((m) => m.role === "user");
				const firstText = firstUser?.content.find((b) => b.type === "text");
				const firstMsg =
					firstText && "text" in firstText && typeof (firstText as UiTextBlock).text === "string"
						? (firstText as UiTextBlock).text
						: c.title;
				const displayName = this.resolveSessionDisplayName(c, firstMsg);
				return {
					path: c.id,
					sessionId: c.id,
					name: c.title,
					displayName,
					firstMessage: firstMsg,
					messageCount: c.messages.length,
					modified: c.updatedAt,
					pinned: Boolean(c.pinned),
				};
			});
		this.send({ type: "sessions", sessions: sessionSummaries });
	}

	/** 引擎自属的会话展示名解析回调（定制 Universal/Claude 的首条截断 + 自定义命名策略） */
	resolveSessionDisplayName(conv: UniversalConversation, firstMsg: string): string {
		if (conv.title && !UniversalSession.isDefaultTitle(conv.title)) {
			return conv.title;
		}
		if (firstMsg && !UniversalSession.isDefaultTitle(firstMsg)) {
			const t = firstMsg.trim().replace(/\s+/g, " ");
			return t.length > 30 ? `${t.slice(0, 30)}…` : t;
		}
		return conv.title || (this.lang === "zh" ? "新对话" : "New chat");
	}

	async pushProjects(): Promise<void> {
		if (typeof this.stateStore?.getRecentProjects !== "function") return;
		const projects = await this.stateStore.getRecentProjects(this.clientId);
		this.send({ type: "projects", projects });
	}

	async removeProject(path: string): Promise<void> {
		if (typeof this.stateStore?.removeProject !== "function") return;
		this.stateStore.removeProject(this.clientId, path);
		await this.pushProjects();
	}

	async searchSessions(query: string, reqId: number): Promise<void> {
		const q = query.trim().toLowerCase();
		if (!q) {
			this.send({ type: "session_search_results", reqId, query, ok: true, results: [] });
			return;
		}
		try {
			const memoryConvs = Array.from(this.conversations.values());
			const diskConvs = this.store.listConversations(this.cwd);
			const convMap = new Map<string, UniversalConversation>();
			for (const c of diskConvs) {
				convMap.set(c.id, c);
			}
			for (const c of memoryConvs) {
				convMap.set(c.id, c);
			}

			const results: SessionSearchResult[] = [];
			for (const conv of convMap.values()) {
				const titleMatches = conv.title.toLowerCase().includes(q);
				const anchors: { role: string; timestamp: number }[] = [];
				let anyMessageMatches = false;

				for (const m of conv.messages) {
					let msgText = "";
					for (const b of m.content) {
						if (b.type === "text" && typeof (b as UiTextBlock).text === "string") {
							msgText += (b as UiTextBlock).text + "\n";
						}
					}
					if (msgText.toLowerCase().includes(q)) {
						anyMessageMatches = true;
						anchors.push({
							role: m.role,
							timestamp: m.timestamp ?? conv.updatedAt,
						});
					}
				}

				if (titleMatches || anyMessageMatches) {
					const firstUser = conv.messages.find((m) => m.role === "user");
					const firstText = firstUser?.content.find((b) => b.type === "text");
					const firstMsg =
						firstText && "text" in firstText && typeof (firstText as UiTextBlock).text === "string"
							? (firstText as UiTextBlock).text
							: conv.title;

					results.push({
						path: conv.id,
						sessionId: conv.id,
						name: conv.title,
						displayName: this.resolveSessionDisplayName(conv, firstMsg),
						firstMessage: firstMsg,
						messageCount: conv.messages.length,
						modified: conv.updatedAt,
						source: "web",
						anchors: anchors.slice(0, 10),
					});
				}
			}

			results.sort((a, b) => b.modified - a.modified);
			const payload: ServerMessage = {
				type: "session_search_results",
				reqId,
				query,
				ok: true,
				results: results.slice(0, 50),
			};
			(payload as Record<string, unknown>).hits = payload.results;
			this.send(payload);
		} catch {
			this.send({ type: "session_search_results", reqId, query, ok: false, results: [] });
		}
	}

	// ---------------------------------------------------------------------------
	// 文件、终端与 Git SCM 委托
	// ---------------------------------------------------------------------------

	async listFiles(path?: string): Promise<void> {
		await this.files.listFiles(path);
	}

	async searchFiles(query: string, reqId: number): Promise<void> {
		await this.files.searchFiles(query, reqId);
	}

	async readFile(path: string): Promise<void> {
		await this.files.readFile(path);
	}

	async writeFile(path: string, text: string): Promise<void> {
		await this.files.writeFile(path, text);
	}

	async uploadFile(dirPath: string, name: string, data: string): Promise<void> {
		await this.files.uploadFile(dirPath, name, data);
	}

	async createEntry(dir: string, name: string, kind: "file" | "dir"): Promise<void> {
		await this.files.createEntry(dir, name, kind);
	}

	async renameEntry(path: string, newName: string): Promise<void> {
		await this.files.renameEntry(path, newName);
	}

	async deleteEntry(path: string): Promise<void> {
		await this.files.deleteEntry(path);
	}

	async copyEntry(src: string, destDir: string, move?: boolean): Promise<void> {
		await this.files.copyEntry(src, destDir, move);
	}

	async revealEntry(path: string): Promise<void> {
		await this.files.revealEntry(path);
	}

	async openDefaultEntry(path: string): Promise<void> {
		await this.files.openDefaultEntry(path);
	}

	async scmQuery(
		kind: "status" | "history" | "filediff" | "commit",
		reqId: number,
		opts?: { path?: string; hash?: string },
	): Promise<void> {
		await this.files.scmQuery(kind, reqId, opts);
	}

	getTerminalManager(): TerminalManagerLike {
		return this.terminals;
	}

	getTerminalCwd(): string {
		return this.cwd;
	}

	// ---------------------------------------------------------------------------
	// 后台服务生命周期委托
	// ---------------------------------------------------------------------------

	async killBackgroundServer(port?: number, _taskId?: string): Promise<boolean> {
		if (port === undefined) return false;
		const killed = await this.bg.killOne(port);
		if (killed) this.bg.push();
		return killed;
	}

	async killAllBackgroundServers(): Promise<string[]> {
		const killed = await this.bg.killAll();
		this.bg.push();
		return killed;
	}

	async listBgServers(): Promise<void> {
		this.bg.push();
	}

	setBackgroundKeep(port: number, keep: boolean): boolean {
		return this.bg.setKeep(port, keep);
	}

	async cleanBackgroundLeftovers(minutesOverride?: number): Promise<number[]> {
		const override = Number(minutesOverride);
		const minutes = Number.isFinite(override) && override > 0 ? override : 30;
		return this.bg.cleanStale(minutes * 60_000, { manual: true });
	}

	// ---------------------------------------------------------------------------
	// 模型与偏好控制
	// ---------------------------------------------------------------------------

	async listModels(): Promise<void> {
		if (this.driver.listModels) {
			const models = await this.driver.listModels();
			const modelInfos: ModelInfo[] = models.map((m) => {
				const hasSlash = m.id.includes("/");
				const provider = hasSlash ? m.id.split("/")[0] : this.driver.id;
				const bareId = hasSlash ? m.id.slice(m.id.indexOf("/") + 1) : m.id;
				const canonicalId = hasSlash ? m.id : `${this.driver.id}/${m.id}`;
				const entry = {
					id: bareId,
					name: m.name,
					provider,
					vision: true,
				};
				this.modelsMap.set(canonicalId, entry);
				this.modelsMap.set(bareId, entry);
				return {
					id: canonicalId,
					name: m.name,
					provider,
					reasoning: true,
					vision: true,
				};
			});
			this.send({
				type: "models",
				models: modelInfos,
			});
			this.flushSnapshot();
		}
	}

	async setModel(modelId: string): Promise<void> {
		this.currentModel = modelId;
		if (this.stateStore) {
			this.stateStore.saveProjectModel(this.clientId, this.cwd, modelId, this.engine);
		}
		if (this.driver.setModel) {
			await this.driver.setModel(modelId);
		}
		const info = this.resolveCurrentModelInfo();
		this.emitNotice("info", `已切换到模型：${info.name}`, `Switched to model: ${info.name}`);
		this.flushSnapshot();
	}

	async setDefaultModel(modelId: string): Promise<void> {
		if (this.stateStore) {
			this.stateStore.saveDefaultModel(modelId, this.engine);
		}
		this.send({ type: "default_model", modelId });
		this.emitNotice(
			"info",
			`🌍 已设全局默认模型 ${modelId}（新项目自动使用，项目记忆优先）`,
			`🌍 Global default model set to ${modelId}`,
		);
		this.flushSnapshot();
	}

	clearDefaultModel(): void {
		if (this.stateStore) {
			this.stateStore.saveDefaultModel("", this.engine);
		}
		this.send({ type: "default_model", modelId: null });
		this.emitNotice("info", "🌍 已清除全局默认模型", "🌍 Global default model cleared");
		this.flushSnapshot();
	}

	setThinking(level: string): void {
		this.thinkingLevel = level;
		if (typeof this.driver.setThinkingLevel === "function") {
			this.driver.setThinkingLevel(level);
		}
		this.flushSnapshot();
	}

	async setCwd(path: string): Promise<void> {
		this.cwd = path;
		this.driver.setCwd(path);

		// 切换工作区 CWD：清空旧目录会话缓存与草稿，并加载属于新目录的会话
		this.conversations.clear();
		this.sessionDrafts.clear();
		const existing = this.store.listConversations(this.cwd);
		if (existing.length > 0) {
			for (const conv of existing) {
				this.conversations.set(conv.id, conv);
			}
			this.activeConvId = existing[0].id;
		} else {
			const initialConv = this.createEmptyConversation("新对话");
			this.activeConvId = initialConv.id;
			this.conversations.set(initialConv.id, initialConv);
			this.store.saveConversation(this.cwd, initialConv);
		}

		await this.refreshSessions();
		await this.refreshWorktreeInfo();
		if (typeof this.stateStore?.remember === "function") {
			this.stateStore.remember(this.clientId, path);
		}
		void this.pushProjects();
		// 切换目录后恢复该目录按引擎隔离的项目记忆模型
		const savedModel =
			this.stateStore?.getProjectModel(this.clientId, path, this.engine) ??
			this.stateStore?.getDefaultModel(this.engine);
		if (savedModel && savedModel !== this.currentModel) {
			void this.setModel(savedModel).catch(() => {});
		}
		this.flushSnapshot(true);
	}

	async setWorkspaceRoots(roots?: string[]): Promise<void> {
		if (this.stateStore) {
			this.stateStore.saveWorkspaceRoots(this.clientId, this.cwd, roots ?? []);
		}
		this.flushSnapshot();
	}

	private async refreshWorktreeInfo(): Promise<void> {
		try {
			this.worktreeInfo = await getWorktreeContext(this.cwd);
		} catch {
			this.worktreeInfo = null;
		}
	}

	/** 获取通用底座持有的持久终端交互工具集 */
	getTerminalTools(): ToolDefinition[] {
		return makePersistentTerminalTools(this.terminals, this.cwd, () => this.lang as ServerLang);
	}

	/** 执行通用底座持久终端工具（供外部驱动或模型调用） */
	async execTerminalTool(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<{ output: string; details?: unknown }> {
		const tools = this.getTerminalTools();
		const tool = tools.find((t) => t.name === name);
		if (!tool) {
			throw new Error(`Terminal tool "${name}" not found`);
		}
		const res = (await tool.execute(
			`call_${Date.now()}`,
			args as never,
			signal as any,
			undefined as any,
			undefined as any,
		)) as { content?: Array<{ type: string; text?: string }>; details?: unknown };
		const text = (res.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
		return { output: text, details: res.details };
	}

	getToolInfo(name: string): void {
		if (name === "subagent") {
			const tools = makeSubagentTools(this.subagentHost);
			const target = tools.find((t) => t.name === "subagent") ?? tools[0];
			if (target) {
				this.send({
					type: "tool_info",
					name: target.name,
					found: true,
					description: target.description,
					promptSnippet: (target as any).promptSnippet,
					parameters: target.parameters as Record<string, unknown>,
				});
				return;
			}
		}

		if ((TERMINAL_TOOL_NAMES as readonly string[]).includes(name)) {
			const tools = this.getTerminalTools();
			const target = tools.find((t) => t.name === name);
			if (target) {
				this.send({
					type: "tool_info",
					name: target.name,
					found: true,
					label: (target as any).label,
					description: target.description,
					promptSnippet: (target as any).promptSnippet,
					promptGuidelines: (target as any).promptGuidelines,
					parameters: target.parameters as Record<string, unknown>,
				});
				return;
			}
		}

		this.send({ type: "tool_info", ...unsupportedToolInfo(name) });
	}

	getToolPrompt(name: string): void {
		let targetTool: ToolDefinition | undefined;
		if (name === "subagent") {
			const tools = makeSubagentTools(this.subagentHost);
			targetTool = tools.find((t) => t.name === "subagent") ?? tools[0];
		} else if ((TERMINAL_TOOL_NAMES as readonly string[]).includes(name)) {
			const tools = this.getTerminalTools();
			targetTool = tools.find((t) => t.name === name);
		}

		if (targetTool) {
			this.send({
				type: "tool_prompt",
				name,
				found: true,
				defaultDescription: targetTool.description,
				defaultPromptSnippet: (targetTool as any).promptSnippet,
				defaultPromptGuidelines: (targetTool as any).promptGuidelines,
			});
			return;
		}

		this.send({
			type: "tool_prompt",
			name,
			found: false,
			unsupported: true,
		});
	}

	getCompactedMessages(compactionMessageId: string, conversationId?: string): void {
		const conv = conversationId ? this.conversations.get(conversationId) : this.activeConv;
		const msg = conv?.messages.find((m) => m.id === compactionMessageId);
		const compacted = (msg?.details as { compactedMessages?: UiMessage[] } | undefined)?.compactedMessages ?? [];
		this.send({
			type: "compacted_messages_result",
			compactionMessageId,
			conversationId: conv?.id ?? this.activeConvId,
			messages: compacted,
		});
	}

	async createSandbox(opts: { name?: string; sourcePath?: string; ephemeral?: boolean }): Promise<void> {
		try {
			const { sandbox, copiedFiles } = await this.sandboxes.create(opts);
			await this.setCwd(sandbox.path);
			const modeZh = sandbox.sourcePath ? `已从源项目导入 ${copiedFiles} 个文件` : "空白隔离环境";
			const modeEn = sandbox.sourcePath ? `imported ${copiedFiles} files from source` : "blank isolated workspace";
			this.emitNotice(
				"info",
				`🧪 沙盒「${sandbox.name}」已启动（${modeZh}，一切修改与原项目完全隔离）`,
				`🧪 Sandbox "${sandbox.name}" started (${modeEn}; all changes are strictly isolated)`,
			);
		} catch (err) {
			this.emitNotice(
				"error",
				`创建沙盒失败：${(err as Error).message}`,
				`Failed to create sandbox: ${(err as Error).message}`,
			);
		}
	}

	async resetSandbox(path?: string): Promise<void> {
		const target = path?.trim() || this.cwd;
		try {
			const { sandbox, copiedFiles } = await this.sandboxes.reset(target);
			this.flushSnapshot();
			this.emitNotice(
				"info",
				sandbox.sourcePath
					? `🔄 已重置沙盒「${sandbox.name}」（重新从源项目同步 ${copiedFiles} 个文件）`
					: `🔄 已清空并重置沙盒「${sandbox.name}」`,
				sandbox.sourcePath
					? `🔄 Reset sandbox "${sandbox.name}" (re-synced ${copiedFiles} files from source)`
					: `🔄 Cleared and reset sandbox "${sandbox.name}"`,
			);
		} catch (err) {
			this.emitNotice(
				"error",
				`重置沙盒失败：${(err as Error).message}`,
				`Failed to reset sandbox: ${(err as Error).message}`,
			);
		}
	}

	async persistSandbox(path?: string): Promise<void> {
		const target = path?.trim() || this.cwd;
		try {
			const sandbox = this.sandboxes.persist(target);
			this.flushSnapshot();
			this.emitNotice(
				"info",
				`📌 沙盒「${sandbox.name}」已转为永久保留`,
				`📌 Sandbox "${sandbox.name}" is now saved permanently`,
			);
		} catch (err) {
			this.emitNotice(
				"error",
				`转换永久沙盒失败：${(err as Error).message}`,
				`Failed to persist sandbox: ${(err as Error).message}`,
			);
		}
	}

	async promoteSandbox(targetPath: string, path?: string, switchToTarget = true): Promise<void> {
		const sbxTarget = path?.trim() || this.cwd;
		try {
			const { sandbox, targetPath: resolvedTarget, copiedFiles } = await this.sandboxes.promote(sbxTarget, targetPath);
			if (switchToTarget) {
				await this.setCwd(resolvedTarget);
			}
			this.emitNotice(
				"info",
				`📤 已将沙盒「${sandbox.name}」导出为正式项目：${resolvedTarget}（共 ${copiedFiles} 个文件）`,
				`📤 Exported sandbox "${sandbox.name}" to formal project: ${resolvedTarget} (${copiedFiles} files)`,
			);
		} catch (err) {
			this.emitNotice(
				"error",
				`导出沙盒失败：${(err as Error).message}`,
				`Failed to export sandbox: ${(err as Error).message}`,
			);
		}
	}

	async diffSandbox(path?: string): Promise<void> {
		const target = path?.trim() || this.cwd;
		try {
			const res = await this.sandboxes.diffWithSource(target);
			this.send({
				type: "sandbox_diff",
				diff: {
					sandboxId: res.sandbox.id,
					path: res.sandbox.path,
					sourcePath: res.sourcePath,
					added: res.added.slice(0, 200),
					modified: res.modified.slice(0, 200),
					deleted: res.deleted.slice(0, 200),
					unchangedCount: res.unchangedCount,
				},
			});
		} catch (err) {
			this.send({
				type: "sandbox_diff",
				diff: {
					sandboxId: "",
					path: target,
					added: [],
					modified: [],
					deleted: [],
					unchangedCount: 0,
					error: (err as Error).message,
				},
			});
		}
	}

	async applySandboxToSource(path?: string): Promise<void> {
		const target = path?.trim() || this.cwd;
		try {
			const { sandbox, sourcePath, copiedFiles, deletedFiles } = await this.sandboxes.applyToSource(target);
			const delSuffixZh = deletedFiles ? `，清理 ${deletedFiles} 个已删除文件` : "";
			const delSuffixEn = deletedFiles ? `, pruned ${deletedFiles} deleted files` : "";
			this.emitNotice(
				"info",
				`✅ 已将沙盒「${sandbox.name}」中的改动同步回源项目：${sourcePath}（同步 ${copiedFiles} 个文件${delSuffixZh}）`,
				`✅ Applied changes from sandbox "${sandbox.name}" back to source project: ${sourcePath} (${copiedFiles} files synced${delSuffixEn})`,
			);
		} catch (err) {
			this.emitNotice(
				"error",
				`写回源项目失败：${(err as Error).message}`,
				`Failed to apply sandbox changes to source: ${(err as Error).message}`,
			);
		}
	}

	async destroySandbox(path: string): Promise<void> {
		const target = path?.trim() || this.cwd;
		const sbx = this.sandboxes.get(target) ?? this.sandboxes.getByCwd(target);
		if (!sbx) return;
		try {
			if (this.cwd === sbx.path || this.cwd.startsWith(sbx.path + "/")) {
				const fallback = sbx.sourcePath && existsSync(sbx.sourcePath) ? sbx.sourcePath : homedir();
				await this.setCwd(fallback);
			}
			await this.sandboxes.destroy(sbx.path);
			this.emitNotice("info", `🗑️ 已销毁沙盒「${sbx.name}」`, `🗑️ Destroyed sandbox "${sbx.name}"`);
		} catch (err) {
			this.emitNotice(
				"error",
				`销毁沙盒失败：${(err as Error).message}`,
				`Failed to destroy sandbox: ${(err as Error).message}`,
			);
		}
	}

	async switchWorktree(targetPath: string): Promise<void> {
		await this.setCwd(targetPath);
	}

	async removeWorktree(targetPath: string, force = false): Promise<void> {
		try {
			await removeWorktree(this.cwd, targetPath, force, () => this.getLang() as any);
			await this.refreshWorktreeInfo();
			this.emitNotice("info", `🗑️ 已移除 Git 工作树：${targetPath}`, `🗑️ Removed Git worktree: ${targetPath}`);
		} catch (err) {
			this.emitNotice(
				"error",
				`移除工作树失败：${(err as Error).message}`,
				`Failed to remove worktree: ${(err as Error).message}`,
			);
		}
	}

	async completePath(path: string): Promise<void> {
		await this.files.completePath(path);
	}

	async makeDir(path: string): Promise<void> {
		await this.files.makeDir(path);
	}

	// ---------------------------------------------------------------------------
	// 辅助方法与空实现
	// ---------------------------------------------------------------------------

	emitNotice(level: "info" | "warning" | "error", text: string, textEn?: string): void {
		this.send({ type: "notice", level, text, textEn });
	}

	getLang(): string {
		return this.lang;
	}

	async setLocale(locale: string): Promise<void> {
		this.lang = locale;
	}

	activeConversations(): number {
		return this.isStreaming ? 1 : 0;
	}

	pendingMessages(): number {
		return 0;
	}

	async pushSlashCommands(): Promise<void> {
		await this.slash.push();
	}

	async listAvailableModelsForSlash(): Promise<Array<{ id: string; name: string; provider?: string }>> {
		const out: Array<{ id: string; name: string; provider?: string }> = [];
		for (const m of this.modelsMap.values()) {
			if (!out.some((x) => x.id === m.id)) {
				out.push({ id: m.id, name: m.name, provider: m.provider });
			}
		}
		if (this.driver.listModels) {
			try {
				const driverModels = await this.driver.listModels();
				for (const dm of driverModels) {
					if (!out.some((x) => x.id === dm.id)) {
						out.push({ id: dm.id, name: dm.name, provider: this.driver.id });
					}
				}
			} catch {
				/* ignore driver model query error */
			}
		}
		return out;
	}

	async collectUniversalSkills(): Promise<DiscoveredSkill[]> {
		const disk = discoverDiskSkills({ cwd: this.cwd, agentDir: this.agentDir });
		const out = [...disk];
		if (this.driver.getSkills) {
			try {
				const extra = await this.driver.getSkills();
				for (const es of extra) {
					if (!out.some((s) => s.name === es.name)) {
						out.push({
							name: es.name,
							description: es.description,
							filePath: es.filePath || "",
							dirPath: this.cwd,
						});
					}
				}
			} catch {
				/* ignore driver skills query error */
			}
		}
		this.skillsCache = out;
		return out;
	}

	async compactActiveConversation(instructions?: string): Promise<void> {
		const conv = this.activeConv;
		if (conv.messages.length <= 4) {
			this.emitNotice("info", "当前对话上下文较短，无需压缩", "Conversation context is short, no compaction needed");
			return;
		}
		const first = conv.messages.slice(0, 2);
		const recent = conv.messages.slice(-4);
		const summaryMsg: UiMessage = {
			id: `compaction-${Date.now()}`,
			role: "compactionSummary",
			content: [
				{
					type: "text",
					text: instructions ? `上下文已根据说明压缩: ${instructions}` : "历史消息已由通用底座自动压缩归纳",
				},
			],
			timestamp: Date.now(),
		};
		conv.messages = [...first, summaryMsg, ...recent];
		if (!conv.isEphemeral) {
			this.store.saveConversation(this.cwd, conv);
		}
		this.flushSnapshot();
		this.emitNotice("info", "已压缩当前会话上下文", "Current conversation context compacted");
	}

	async reloadSessionResources(): Promise<void> {
		await this.collectUniversalSkills();
		if (this.modelAdmin) {
			await this.listModels();
		}
		await this.pushSlashCommands();
	}

	async listCommands(): Promise<void> {
		this.send({ type: "commands", commands: [], path: "" });
	}

	async saveCommands(_commands: CommandDef[]): Promise<void> {
		/* no-op */
	}

	pushSettings(): void {
		const s = this.stateStore?.getSettings(this.clientId);
		const settings: UiSettingsState = {
			promptMode: s?.promptMode ?? "append",
			customSystemPrompt: s?.customSystemPrompt ?? "",
			disabledSkills: s?.disabledSkills ?? [],
			disabledExtensions: s?.disabledExtensions ?? [],
			disabledAgentTools: [],
			disabledPluginTools: [],
			terminalToolsEnabled: s?.terminalToolsEnabled ?? true,
			terminalBash: s?.terminalBash ?? true,
			terminalBashIdleMs: s?.terminalBashIdleMs ?? 3000,
			terminalBashMaxForegroundMs: s?.terminalBashMaxForegroundMs ?? 15000,
			toolWatchdogTimeoutMs: s?.toolWatchdogTimeoutMs ?? 1200000,
			readDirEnabled: true,
			bgAutoCleanupMin: s?.bgAutoCleanupMin ?? 0,
			// 同一字段的含义在本引擎不适用（无 pi 工具注册面）：恒为 false 占位，保协议完整。
			toolLazyLoading: false,
			codemodeMode: "on",
			codemodeInlineBudget: 3000,
			editSoftEnabled: false,
			retryMaxAttempts: 0,
			softCapTokens: 0,
			softCapByModel: {},
			questionnaireEnabled: false,
			toolApprovalEnabled: true,
			approvalPolicy: { allowAll: false, categories: [] },
			approvalRules: [],
			goalModeEnabled: false,
			parallelReminderEnabled: false,
			thinkingWrap: s?.thinkingWrap ?? false,
			toolsWrap: s?.toolsWrap ?? false,
			toolImagesEnabled: s?.toolImagesEnabled ?? true,
			keepRecentMessages: s?.keepRecentMessages ?? 0,
			showForkedParentSessions: false,
			retainFinishedConversations: false,
			openRecentSessionOnProjectSwitch: true,
			skillsFullText: [],
			skillsCatalogMaxDesc: 250,
			skillsCatalogShowLocation: false,
			skillsCatalogBudget: 20000,
			visionBridgeEnabled: false,
			visionBridgeModel: null,
			visionBridgePromptMode: "append",
			visionBridgePrompt: "",
			scmCommitMsgPromptMode: "append",
			scmCommitMsgPrompt: "",
			planModePromptMode: "append",
			planModePrompt: "",
			planModeDefaultPrompt: "",
			reviewPrompt: "",
			reviewDisabledSkills: [],
			disabledPlugins: s?.disabledPlugins ?? [],
			uiLayout: normalizeUiLayout(s?.uiLayout),
			promptTemplate: s?.promptTemplate ?? "",
			promptOverrides: s?.promptOverrides ?? {},
			promptDisabled: [...(s?.promptDisabled ?? [])],
			toolPromptOverrides: {},
			effectiveSystemPrompt: "",
			promptSourceDefaults: {},
			toolsSchema: "",
			visionBridgeDefaultPrompt: "",
			scmCommitMsgDefaultPrompt: "",
			visionModels: [],
			skills: this.skillsCache.map((sk) => ({
				name: sk.name,
				description: sk.description,
				enabled: !(s?.disabledSkills ?? []).includes(sk.name),
			})),
			reviewSkills: [],
			extensions: [],
			presets: (this.stateStore?.getPresets(this.clientId) ?? []).map(settingsPresetToUi),
			markersEnabled: this.markerSvc.current.markersEnabled,
			disabledMarkers: [...this.markerSvc.current.disabledMarkers],
			markers: this.markerSvc.listForUi(),
			subagentTemplates: this.subagentTemplates.list(),
			subagentDefaultTemplates: DEFAULT_TEMPLATES.map((t) => t.name),
			subagentDefaultModel: null,
			subagentModels: [],
			quickPhrases: s?.quickPhrases ?? [],
			quickPhrasesEnabled: s?.quickPhrasesEnabled ?? true,
			minimalNewChat: s?.minimalNewChat ?? false,
			preserveDraftAcrossConversations: s?.preserveDraftAcrossConversations ?? false,
			quickPhrasesSeeded: this.stateStore?.getQuickPhrasesSeeded() ?? true,
		};
		this.send({ type: "settings_state", settings });
	}

	async setSettings(partial: Record<string, unknown>): Promise<void> {
		if (this.stateStore) {
			this.stateStore.saveSettings(this.clientId, partial as Partial<ClientSettings>);
		}
		this.pushSettings();
	}

	async reloadExtensions(): Promise<void> {
		/* no-op */
	}

	async checkUpdate(): Promise<void> {
		/* no-op */
	}

	async checkUpdatesAll(): Promise<void> {
		/* no-op */
	}

	resolveDialog(id: number, value: string | boolean | null): void {
		this.webUi.resolveDialog(id, value);
	}

	handleTuiOverlayInput(id: number, data: string): void {
		this.webUi.handleTuiOverlayInput(id, data);
	}

	handleTuiOverlayResize(id: number, cols: number, rows: number): void {
		this.webUi.handleTuiOverlayResize(id, cols, rows);
	}

	handleTuiOverlayCancel(id: number): void {
		this.webUi.handleTuiOverlayCancel(id);
	}

	installPiAgent(): Promise<void> {
		/* no-op */
		return Promise.resolve();
	}

	setProviderApiKey(provider: string, apiKey: string): Promise<void> {
		return this.modelAdmin.setProviderApiKey(provider, apiKey);
	}

	clearProviderApiKey(provider: string): Promise<void> {
		return this.modelAdmin.clearProviderApiKey(provider);
	}

	startProviderOAuth(provider: string): void {
		this.modelAdmin.startProviderOAuth(provider);
	}

	replyProviderOAuth(flowId: string, promptId: string, value: string): void {
		this.modelAdmin.replyProviderOAuth(flowId, promptId, value);
	}

	cancelProviderOAuth(flowId: string): void {
		this.modelAdmin.cancelProviderOAuth(flowId);
	}

	listProviderOAuthFlows(): void {
		this.modelAdmin.listProviderOAuthFlows();
	}

	logoutProviderOAuth(provider: string): Promise<void> {
		return this.modelAdmin.logoutProviderOAuth(provider);
	}

	listModelsConfig(): Promise<void> {
		return this.modelAdmin.listModelsConfig();
	}

	reloadModelsConfig(): Promise<void> {
		return this.modelAdmin.reloadModelsConfig();
	}

	saveModelConfig(providerId: string, config: unknown): Promise<void> {
		return this.modelAdmin.saveModelConfig(providerId, config as any);
	}

	deleteModelConfig(providerId: string): Promise<void> {
		return this.modelAdmin.deleteModelConfig(providerId);
	}

	listProviders(): Promise<void> {
		return this.modelAdmin.listProviders();
	}

	listProviderKeys(): void {
		this.modelAdmin.listProviderKeys();
	}

	addProviderKey(provider: string, apiKey: string, name?: string): Promise<void> {
		return this.modelAdmin.addProviderKey(provider, apiKey, name);
	}

	async activateProviderKey(provider: string, keyName: string): Promise<void> {
		await this.modelAdmin.activateProviderKey(provider, keyName);
	}

	removeProviderKey(provider: string, keyName: string): Promise<void> {
		return this.modelAdmin.removeProviderKey(provider, keyName);
	}

	fetchModelsList(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		providerId?: string,
	): Promise<void> {
		return this.modelAdmin.fetchModelsList(reqId, baseUrl, apiKey, authHeader, api, () => this.getLang(), providerId);
	}

	testModelConnection(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		providerId?: string,
	): Promise<void> {
		return this.modelAdmin.testConnection(reqId, baseUrl, apiKey, authHeader, api, () => this.getLang(), providerId);
	}

	refreshProviderModels(providerId: string, reqId: number): Promise<void> {
		return this.modelAdmin.refreshProviderModels(providerId, reqId, () => this.getLang());
	}

	refreshBuiltinModels(reqId: number): Promise<void> {
		return this.modelAdmin.refreshBuiltinModels(reqId);
	}

	appendBuiltinModel(providerId: string, model: UiModelConfigEntry, reqId: number): Promise<void> {
		return this.modelAdmin.appendBuiltinModel(providerId, model, reqId);
	}

	cloneProvider(provider: string, reqId: number): Promise<void> {
		return this.modelAdmin.cloneProvider(provider, reqId);
	}

	enrichModels(reqId: number, ids: string[], hints?: Record<string, string>): Promise<void> {
		return this.modelAdmin.enrichModels(reqId, ids, hints);
	}

	abortEnrichModels(reqId?: number): void {
		this.modelAdmin.abortEnrichModels(reqId);
	}

	setGoal(): Promise<void> {
		this.emitNotice("warning", "通用 Agent 模式暂不支持目标模式", "Goal mode not supported in universal agent");
		return Promise.resolve();
	}

	clearGoal(): Promise<void> {
		/* no-op */
		return Promise.resolve();
	}

	startGoalWizard(): Promise<void> {
		/* no-op */
		return Promise.resolve();
	}

	setGoalPrefs(): Promise<void> {
		/* no-op */
		return Promise.resolve();
	}

	async savePreset(name: string): Promise<void> {
		if (!this.stateStore) return;
		const s = this.stateStore.getSettings(this.clientId);
		const currentPresets = this.stateStore.getPresets(this.clientId);
		const filtered = currentPresets.filter((p) => p.name !== name);
		filtered.push({
			name,
			promptMode: s.promptMode,
			customSystemPrompt: s.customSystemPrompt,
			promptTemplate: s.promptTemplate,
			promptOverrides: s.promptOverrides ? { ...s.promptOverrides } : {},
			promptDisabled: [...(s.promptDisabled ?? [])],
			disabledSkills: [...(s?.disabledSkills ?? [])],
			disabledExtensions: [...(s?.disabledExtensions ?? [])],
			reviewPrompt: s.reviewPrompt ?? "",
			reviewDisabledSkills: [...(s?.reviewDisabledSkills ?? [])],
			retryMaxAttempts: s.retryMaxAttempts,
			softCapTokens: s.softCapTokens,
			softCapByModel: s.softCapByModel,
		});
		this.stateStore.savePresets(this.clientId, filtered);
		this.pushSettings();
		this.emitNotice("info", `已保存设置预设「${name}」`, `Settings preset "${name}" saved`);
	}

	async applyPreset(name: string): Promise<void> {
		if (!this.stateStore) return;
		const currentPresets = this.stateStore.getPresets(this.clientId);
		const found = currentPresets.find((p) => p.name === name);
		if (!found) {
			this.emitNotice("error", `未找到名为「${name}」的设置预设`, `Settings preset "${name}" not found`);
			return;
		}
		this.stateStore.saveSettings(this.clientId, {
			promptMode: found.promptMode,
			customSystemPrompt: found.customSystemPrompt,
			promptDisabled: [...(found.promptDisabled ?? [])],
			disabledSkills: [...(found.disabledSkills ?? [])],
			disabledExtensions: [...(found.disabledExtensions ?? [])],
			reviewPrompt: found.reviewPrompt ?? "",
			reviewDisabledSkills: [...(found.reviewDisabledSkills ?? [])],
			retryMaxAttempts: found.retryMaxAttempts,
			softCapTokens: found.softCapTokens,
			softCapByModel: found.softCapByModel,
		});
		this.pushSettings();
		this.emitNotice("info", `已应用设置预设「${name}」`, `Settings preset "${name}" applied`);
	}

	async deletePreset(name: string): Promise<void> {
		if (!this.stateStore) return;
		const currentPresets = this.stateStore.getPresets(this.clientId);
		const filtered = currentPresets.filter((p) => p.name !== name);
		this.stateStore.savePresets(this.clientId, filtered);
		this.pushSettings();
		this.emitNotice("info", `已删除设置预设「${name}」`, `Settings preset "${name}" deleted`);
	}

	async scmGenCommitMessage(reqId: number): Promise<void> {
		const reply = (ok: boolean, extra: { text?: string; error?: string }) => {
			this.send({ type: "scm_data", reqId, kind: "commitmsg", ok, ...extra });
		};
		try {
			const ctx = await scmCommitContext(this.cwd, () => this.getLang() as any);
			const input = buildCommitMsgInput(ctx, this.lang === "zh" ? "zh" : "en");
			if (!input) {
				reply(false, {
					error: this.lang === "zh" ? "没有可描述的更改（工作区干净）" : "Nothing to describe (working tree clean)",
				});
				return;
			}
			let commitText = "";
			const prompt = `Based on the following git changes, write a single-line conventional commit message (e.g. feat(...): ..., fix(...): ...):\n\n${input}`;
			let doneResolve!: () => void;
			const p = new Promise<void>((res) => {
				doneResolve = res;
			});
			const sink: AgentEventSink = {
				onThinkingDelta: () => {},
				onTextDelta: (d) => {
					commitText += d;
				},
				onToolStart: () => {},
				onToolEnd: () => {},
				onTurnComplete: () => doneResolve(),
				onError: () => doneResolve(),
			};
			await this.driver.sendPrompt(prompt, undefined, sink);
			await p;
			const clean = sanitizeCommitMessage(commitText.trim());
			if (clean) {
				reply(true, { text: clean });
			} else {
				reply(false, {
					error: this.lang === "zh" ? "未能生成提交信息" : "Failed to generate commit message",
				});
			}
		} catch (err: unknown) {
			reply(false, { error: err instanceof Error ? err.message : String(err) });
		}
	}

	private sharePort(): PresetSharePort {
		return {
			lang: () => this.getLang() as any,
			appVersion: () => getAppVersion(),
			presets: () => this.stateStore?.getPresets(this.clientId) ?? [],
			currentSettings: () => (this.stateStore?.getSettings(this.clientId) as any) ?? {},
			upsertPreset: (preset) => {
				const presets = this.stateStore?.getPresets(this.clientId) ?? [];
				const filtered = presets.filter((p) => p.name !== preset.name);
				filtered.push(preset);
				this.stateStore?.savePresets(this.clientId, filtered);
			},
			applyPreset: async (name) => this.applyPreset(name),
			pushSettings: () => this.pushSettings(),
			emit: (msg) => this.send(msg),
		};
	}

	async exportPreset(msg: Extract<ClientMessage, { type: "preset_export" }>): Promise<void> {
		exportPresetVia(this.sharePort(), msg);
	}

	async importPreset(msg: Extract<ClientMessage, { type: "preset_import" }>): Promise<void> {
		await importPresetVia(this.sharePort(), msg);
	}

	async importPresetFromUrl(msg: Extract<ClientMessage, { type: "preset_import_url" }>): Promise<void> {
		await importPresetFromUrlVia(this.sharePort(), msg);
	}

	async pushPresetCatalog(msg: Extract<ClientMessage, { type: "preset_catalog" }>): Promise<void> {
		await pushPresetCatalogVia(this.sharePort(), msg);
	}

	async sharePreset(msg: Extract<ClientMessage, { type: "preset_share" }>): Promise<void> {
		await sharePresetVia(this.sharePort(), msg);
	}

	async saveSubagentTemplate(template: Parameters<SubagentTemplatesStore["upsert"]>[0]): Promise<void> {
		const err = this.subagentTemplates.upsert(template);
		if (err) {
			this.emitNotice("error", `子代理模板保存失败：${err}`, `Failed to save subagent template: ${err}`);
			return;
		}
		this.pushSettings();
		const n = (template as { name?: string })?.name?.trim() ?? "";
		this.emitNotice("info", `子代理模板已保存：${n}`, `Subagent template saved: ${n}`);
	}

	async deleteSubagentTemplate(name: string): Promise<void> {
		this.subagentTemplates.remove(name);
		this.pushSettings();
		this.emitNotice("info", `子代理模板已删除：${name}`, `Subagent template deleted: ${name}`);
	}

	async installSkill(name: string, scope: "global" | "project", content: string): Promise<void> {
		const cleanName = name.trim();
		if (!cleanName || !/^[a-zA-Z0-9_-]+$/.test(cleanName)) {
			this.emitNotice(
				"error",
				"技能名称非法，仅允许包含英文字母、数字、下划线及中划线",
				"Invalid skill name: only letters, numbers, underscores and hyphens are allowed",
			);
			return;
		}

		const baseDir = scope === "global" ? join(this.agentDir, "skills") : join(this.cwd, ".pi", "skills");
		const targetDir = join(baseDir, cleanName);
		try {
			mkdirSync(targetDir, { recursive: true });
			writeFileSync(join(targetDir, "SKILL.md"), content.trim() + "\n", "utf8");

			await this.reloadSessionResources();
			this.pushSettings();
			this.emitNotice(
				"info",
				`技能「${cleanName}」已成功安装至${scope === "global" ? "全局" : "当前项目"}`,
				`Skill "${cleanName}" installed successfully to ${scope === "global" ? "global" : "project"}`,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.emitNotice("error", `安装技能失败：${msg}`, `Failed to install skill: ${msg}`);
		}
	}

	async uninstallSkill(name: string, scope: "global" | "project"): Promise<void> {
		const cleanName = name.trim();
		const baseDir = scope === "global" ? join(this.agentDir, "skills") : join(this.cwd, ".pi", "skills");
		const targetDir = join(baseDir, cleanName);
		const singleFile = join(baseDir, `${cleanName}.md`);
		try {
			let deleted = false;
			if (existsSync(targetDir)) {
				rmSync(targetDir, { recursive: true, force: true });
				deleted = true;
			}
			if (existsSync(singleFile)) {
				rmSync(singleFile, { force: true });
				deleted = true;
			}

			if (!deleted) {
				this.emitNotice(
					"warning",
					`未找到技能「${cleanName}」的安装文件`,
					`Skill "${cleanName}" installation file not found`,
				);
				return;
			}

			await this.reloadSessionResources();
			this.pushSettings();
			this.emitNotice(
				"info",
				`技能「${cleanName}」已从${scope === "global" ? "全局" : "当前项目"}卸载`,
				`Skill "${cleanName}" uninstalled from ${scope === "global" ? "global" : "project"}`,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.emitNotice("error", `卸载技能失败：${msg}`, `Failed to uninstall skill: ${msg}`);
		}
	}

	async fetchMcpMarket(source?: string, query?: string, page?: number, refresh?: boolean): Promise<void> {
		const res = await fetchRemoteMcpMarket({
			source,
			query,
			page,
			refresh,
			dataDir: this.dataDir,
		});
		this.send({
			type: "mcp_market_result",
			ok: res.ok,
			servers: res.servers,
			source: res.source,
			total: res.total,
			error: res.error,
		});
	}

	async fetchSkillMarket(repo?: string, refresh?: boolean): Promise<void> {
		const res = await fetchRemoteSkillMarket({
			repo,
			refresh,
			dataDir: this.dataDir,
		});
		this.send({
			type: "skill_market_result",
			ok: res.ok,
			skills: res.skills,
			repo: res.repo,
			error: res.error,
		});
	}

	async fetchSkillContent(repo: string, skillId: string): Promise<void> {
		const res = await fetchRemoteSkillContent({
			repo,
			skillId,
			dataDir: this.dataDir,
		});
		this.send({
			type: "skill_content_result",
			ok: res.ok,
			skillId: res.skillId,
			content: res.content,
			error: res.error,
		});
	}

	// ---------------------------------------------------------------------------
	// 通用底座第一方子代理（Subagent）生命周期与调度管理
	// ---------------------------------------------------------------------------

	/** 统计当前活跃（流式运行中）的子代理数量 */
	private getLiveSubagentsCount(): number {
		let count = 0;
		for (const conv of this.conversations.values()) {
			if (conv.isSubagent && conv.subagentStreaming) {
				count++;
			}
		}
		return count;
	}

	/** 创建并启动一个子代理会话 */
	async spawnSubagent(
		prompt: string,
		type: string,
		cwd: string,
		templateName?: string,
		model?: string,
		parentId?: string,
		persist = false,
		title?: string,
		_thinking?: string,
		_notifyOnDone?: boolean,
	): Promise<{ convId: string }> {
		const maxSubagents = Number(process.env.PI_WEB_MAX_SUBAGENTS) || 8;
		const liveCount = this.getLiveSubagentsCount();
		if (liveCount >= maxSubagents) {
			throw new Error(
				pick(
					this.lang as ServerLang,
					`同时运行的子代理数量已达上限（${maxSubagents} 个），请先用 wait 等一部分完成、或用 stop 停掉不需要的再派发`,
					`Active subagent limit reached (${maxSubagents} live). Wait for some with wait_all or stop unneeded ones with stop before spawning more`,
				),
			);
		}

		// 检查并解析模板
		let template: SubagentTemplate | undefined;
		let effectivePrompt = prompt;
		if (templateName) {
			template = this.subagentTemplates.get(templateName);
			if (!template) {
				throw new Error(`Subagent template "${templateName}" not found`);
			}
			if (template.enabled === false) {
				throw new Error(`Subagent template "${templateName}" is disabled`);
			}
			const tplPrompt = pickTemplatePrompt(template, this.lang as ServerLang);
			if (tplPrompt?.trim()) {
				effectivePrompt = `${tplPrompt.trim()}\n\n${prompt}`;
			}
		}

		const now = Date.now();
		const convId = `subconv-${now}-${randomUUID().slice(0, 8)}`;
		const effectiveParentId = parentId || this.activeConvId;
		const effectiveType = type || "general";
		const effectiveTitle = title ?? subagentTitle(prompt);
		const effectiveModel = model ?? (template?.model?.trim() || null) ?? this.currentModel;
		const targetCwd = cwd || this.cwd;

		const subConv: UniversalConversation = {
			id: convId,
			title: effectiveTitle,
			createdAt: now,
			updatedAt: now,
			messages: [
				{
					id: `u-${now}-${randomUUID().slice(0, 6)}`,
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: now,
				},
			],
			isEphemeral: !persist,
			isSubagent: true,
			subagentType: effectiveType,
			subagentPrompt: prompt,
			subagentParentId: effectiveParentId,
			subagentState: "running",
			subagentStreaming: true,
			subagentTemplate: template,
			subagentModel: effectiveModel,
			stats: {
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
				contextUsage: { tokens: null, contextWindow: this.resolveCurrentModelContextWindow(), percent: null },
			},
		};

		this.conversations.set(convId, subConv);
		if (persist) {
			this.store.saveConversation(targetCwd, subConv);
		}

		this.flushSnapshot();
		void this.refreshSessions();

		// 为该子代理创建独立的 Driver 实例
		let subDriver: BaseAgentDriver;
		if (this.driverFactory) {
			subDriver = this.driverFactory(targetCwd);
		} else if ((this.driver.constructor as any) && typeof (this.driver.constructor as any) === "function") {
			try {
				subDriver = new (this.driver.constructor as any)(targetCwd);
			} catch {
				subDriver = this.driver;
			}
		} else {
			subDriver = this.driver;
		}

		this.subagentDrivers.set(convId, subDriver);

		// 若驱动支持 setModel，应用子代理指定的模型
		if (effectiveModel && subDriver.setModel) {
			try {
				await subDriver.setModel(effectiveModel);
			} catch {
				// 驱动不支持或模型设置失败时平滑降级
			}
		}

		// 异步启动子代理执行流程
		void this.runSubagent(convId, subDriver, effectivePrompt, targetCwd);

		return { convId };
	}

	/** 后台异步执行子代理 Prompt */
	private async runSubagent(convId: string, subDriver: BaseAgentDriver, prompt: string, cwd: string): Promise<void> {
		const conv = this.conversations.get(convId);
		if (!conv) return;

		const now = Date.now();
		const assistantMsgId = `a-${now}-${randomUUID().slice(0, 6)}`;
		let thinkingText = "";
		let assistantText = "";

		const assistantMsg: UiMessage = {
			id: assistantMsgId,
			role: "assistant",
			content: [],
			timestamp: now,
			model: conv.subagentModel,
		};
		conv.messages.push(assistantMsg);

		const sink: AgentEventSink = {
			onThinkingDelta: (delta: string) => {
				thinkingText += delta;
				let thinkBlock = assistantMsg.content.find((b) => b.type === "thinking") as UiThinkingBlock | undefined;
				if (!thinkBlock) {
					thinkBlock = { type: "thinking", thinking: "" };
					assistantMsg.content.unshift(thinkBlock);
				}
				thinkBlock.thinking = thinkingText;
				if (this.activeConvId === convId) {
					this.emitDelta({ type: "thinking_delta", delta });
					this.scheduleThrottledSnapshot();
				}
			},
			onTextDelta: (delta: string) => {
				assistantText += delta;
				const lastBlock = assistantMsg.content[assistantMsg.content.length - 1];
				if (lastBlock && lastBlock.type === "text" && !lastBlock.truncated) {
					(lastBlock as UiTextBlock).text += delta;
				} else {
					assistantMsg.content.push({ type: "text", text: delta });
				}
				if (this.activeConvId === convId) {
					this.emitDelta({ type: "text_delta", delta });
					this.scheduleThrottledSnapshot();
				}
			},
			onToolStart: (callId: string, toolName: string, args: Record<string, unknown>) => {
				const toolBlock: UiContentBlock = {
					type: "toolCall",
					id: callId,
					name: toolName,
					argumentsText: JSON.stringify(args, null, 2),
				};
				assistantMsg.content.push(toolBlock);
				if (this.activeConvId === convId) {
					this.scheduleThrottledSnapshot();
				}
			},
			onToolEnd: (callId: string, result: { output?: string; error?: string }) => {
				const toolMsg: UiMessage = {
					id: `t-${callId}`,
					role: "toolResult",
					toolCallId: callId,
					content: [{ type: "text", text: result.output ?? result.error ?? "" }],
					isError: Boolean(result.error),
					timestamp: Date.now(),
				};
				conv.messages.push(toolMsg);
				if (this.activeConvId === convId) {
					this.scheduleThrottledSnapshot();
				}
			},
			onTurnComplete: (meta?: AgentTurnMeta) => {
				conv.subagentStreaming = false;
				conv.subagentState = conv.subagentCanceled ? "canceled" : "done";
				conv.updatedAt = Date.now();
				if (meta?.usage && conv.stats) {
					conv.stats.tokens.input += meta.usage.inputTokens ?? 0;
					conv.stats.tokens.output += meta.usage.outputTokens ?? 0;
					conv.stats.tokens.cacheRead += meta.usage.cacheReadTokens ?? 0;
					conv.stats.tokens.cacheWrite += meta.usage.cacheWriteTokens ?? 0;
					conv.stats.tokens.total = conv.stats.tokens.input + conv.stats.tokens.output;
					if (typeof meta.costUSD === "number") {
						conv.stats.cost += meta.costUSD;
					}
				}
				if (!conv.isEphemeral) {
					this.store.saveConversation(cwd, conv);
				}
				this.subagentDrivers.delete(convId);
				try {
					void subDriver.dispose();
				} catch {
					// 忽略 dispose 异常
				}
				this.notifySubagentWaitListeners();
				this.flushSnapshot();
				void this.refreshSessions();
			},
			onError: (err: Error | string) => {
				const errMsg = typeof err === "string" ? err : err.message;
				conv.subagentError = errMsg;
				conv.subagentStreaming = false;
				conv.subagentState = "done";
				conv.updatedAt = Date.now();
				if (!conv.isEphemeral) {
					this.store.saveConversation(cwd, conv);
				}
				this.subagentDrivers.delete(convId);
				try {
					void subDriver.dispose();
				} catch {
					// 忽略 dispose 异常
				}
				this.notifySubagentWaitListeners();
				this.flushSnapshot();
				void this.refreshSessions();

				this.emitNotice(
					"error",
					`子代理 ${conv.id.slice(0, 8)}（${conv.subagentType ?? "general"}）运行失败：${errMsg}`,
					`Subagent ${conv.id.slice(0, 8)} (${conv.subagentType ?? "general"}) failed: ${errMsg}`,
				);
			},
		};

		try {
			if (subDriver.createSession) {
				const sid = await subDriver.createSession();
				conv.driverSessionId = sid;
			}
			await subDriver.sendPrompt(prompt, undefined, sink);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			sink.onError(msg);
		}
	}

	/** 获取单个子代理运行态快照结果 */
	async getSubagentResult(convId: string): Promise<SubagentSnapshot> {
		const conv = this.conversations.get(convId);
		if (!conv || !conv.isSubagent) {
			throw new Error(`Subagent ${convId} not found`);
		}
		return this.subagentToSnapshot(conv);
	}

	/** 提取子代理会话的最终 assistant 正文输出 */
	private extractSubagentOutput(conv: UniversalConversation): string {
		const assistantMsgs = conv.messages.filter((m) => m.role === "assistant");
		const pieces: string[] = [];
		for (const m of assistantMsgs) {
			for (const b of m.content) {
				if (b.type === "text" && typeof (b as UiTextBlock).text === "string") {
					pieces.push((b as UiTextBlock).text);
				}
			}
		}
		return pieces.join("\n").trim();
	}

	/** 将 UniversalConversation 转换成标准 SubagentSnapshot */
	private subagentToSnapshot(conv: UniversalConversation): SubagentSnapshot {
		const output = this.extractSubagentOutput(conv);
		const state: SubagentState =
			conv.subagentState ?? (conv.subagentStreaming ? "running" : conv.subagentCanceled ? "canceled" : "done");
		return {
			convId: conv.id,
			type: conv.subagentType ?? "general",
			title: conv.title,
			prompt: conv.subagentPrompt ?? "",
			state,
			streaming: Boolean(conv.subagentStreaming),
			error: conv.subagentError,
			canceled: conv.subagentCanceled,
			messageCount: conv.messages.length,
			model: conv.subagentModel,
			output,
			parentId: conv.subagentParentId,
			persisted: !conv.isEphemeral,
			handoffTo: conv.subagentHandoffTo ? [...conv.subagentHandoffTo] : undefined,
			handoffFrom: conv.subagentHandoffFrom ? [...conv.subagentHandoffFrom] : undefined,
		};
	}

	/** 停止指定的子代理运行 */
	async stopSubagent(convId: string): Promise<void> {
		const conv = this.conversations.get(convId);
		if (!conv) return;

		conv.subagentCanceled = true;
		conv.subagentStreaming = false;
		conv.subagentState = "canceled";
		conv.updatedAt = Date.now();

		const driver = this.subagentDrivers.get(convId);
		if (driver) {
			this.subagentDrivers.delete(convId);
			try {
				await driver.abort();
				void driver.dispose();
			} catch {
				// 忽略驱动中止失败
			}
		}

		this.notifySubagentWaitListeners();
		this.flushSnapshot();
		void this.refreshSessions();
	}

	/** 等待指定的子代理到达终态 */
	async waitSubagents(timeoutSeconds?: number, runIds?: string[], callerId?: string): Promise<SubagentSnapshot[]> {
		const waitCapMs = computeWaitCapMs();
		const requestedMs =
			typeof timeoutSeconds === "number" && timeoutSeconds > 0 ? Math.floor(timeoutSeconds * 1000) : waitCapMs;
		const effectiveTimeoutMs = Math.min(requestedMs, waitCapMs);

		const targetIds =
			runIds && runIds.length > 0
				? new Set(runIds)
				: new Set(
						Array.from(this.conversations.values())
							.filter((c) => c.isSubagent && (!callerId || c.subagentParentId === callerId))
							.map((c) => c.id),
					);

		const checkFinished = (): { finished: boolean; snapshots: SubagentSnapshot[] } => {
			const snapshots: SubagentSnapshot[] = [];
			let allDone = true;
			for (const id of targetIds) {
				const conv = this.conversations.get(id);
				if (!conv) continue;
				const snap = this.subagentToSnapshot(conv);
				snapshots.push(snap);
				if (!isSubagentTerminal(snap)) {
					allDone = false;
				}
			}
			return { finished: allDone, snapshots };
		};

		const initial = checkFinished();
		if (initial.finished) {
			return initial.snapshots;
		}

		return new Promise<SubagentSnapshot[]>((resolve) => {
			let timer: NodeJS.Timeout | null = null;

			const onUpdate = () => {
				const result = checkFinished();
				if (result.finished) {
					cleanup();
					resolve(result.snapshots);
				}
			};

			const cleanup = () => {
				if (timer) {
					clearTimeout(timer);
					timer = null;
				}
				this.subagentWaitListeners.delete(onUpdate);
			};

			timer = setTimeout(() => {
				cleanup();
				const result = checkFinished();
				resolve(result.snapshots);
			}, effectiveTimeoutMs);

			this.subagentWaitListeners.add(onUpdate);
		});
	}

	/** 唤醒所有等待中的子代理监听者 */
	private notifySubagentWaitListeners(): void {
		for (const listener of this.subagentWaitListeners) {
			try {
				listener();
			} catch {
				// 忽略监听者异常
			}
		}
	}

	/** 列出子代理快照列表 */
	listSubagents(scope: "all" | "subagent" | "persistent" = "all"): SubagentSnapshot[] {
		const snaps: SubagentSnapshot[] = [];
		for (const conv of this.conversations.values()) {
			if (!conv.isSubagent) continue;
			if (scope === "persistent" && conv.isEphemeral) continue;
			if (scope === "subagent" && !conv.isEphemeral) continue;
			snaps.push(this.subagentToSnapshot(conv));
		}
		return snaps;
	}

	/** 向指定子代理发送引导/追加消息 */
	async steerSubagent(convId: string, message: string): Promise<void> {
		const conv = this.conversations.get(convId);
		if (!conv || !conv.isSubagent) {
			throw new Error(`Subagent ${convId} not found`);
		}
		conv.messages.push({
			id: `u-${Date.now()}-${randomUUID().slice(0, 6)}`,
			role: "user",
			content: [{ type: "text", text: message }],
			timestamp: Date.now(),
		});
		conv.updatedAt = Date.now();
		this.flushSnapshot();
	}

	/** 跨代理协作交接 */
	async handoffSubagent(fromRunId: string, toRunId: string, payload: string): Promise<void> {
		const fromConv = this.conversations.get(fromRunId);
		const toConv = this.conversations.get(toRunId);
		if (!toConv) {
			throw new Error(`Target subagent ${toRunId} not found`);
		}

		if (fromConv) {
			fromConv.subagentHandoffTo = fromConv.subagentHandoffTo ? [...fromConv.subagentHandoffTo, toRunId] : [toRunId];
		}
		toConv.subagentHandoffFrom = toConv.subagentHandoffFrom ? [...toConv.subagentHandoffFrom, fromRunId] : [fromRunId];

		const record: SubagentHandoffRecord = {
			fromRunId,
			toRunId,
			timestamp: Date.now(),
		};
		this.subagentHandoffs = recordSubagentHandoff(this.subagentHandoffs, record, 50);

		// 向目标子代理注入交接卡片消息
		const now = Date.now();
		const fromType = fromConv?.subagentType ?? "peer";
		toConv.messages.push({
			id: `handoff-${now}-${randomUUID().slice(0, 6)}`,
			role: "user",
			content: [{ type: "text", text: formatSubagentHandoffMessage(fromType, fromRunId, payload) }],
			timestamp: now,
		});
		toConv.updatedAt = now;
		this.flushSnapshot();
	}

	dispose(): void {
		this.disposed = true;
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		for (const driver of this.subagentDrivers.values()) {
			try {
				void driver.abort();
				void driver.dispose();
			} catch {
				// 忽略驱动释放异常
			}
		}
		this.subagentDrivers.clear();
		this.subagentWaitListeners.clear();
		this.files.unwatchDir();
		this.modelAdmin.dispose();
		this.webUi.dispose();
		this.terminals.killAll({ shutdown: true });
		this.driver.dispose();
	}
}
