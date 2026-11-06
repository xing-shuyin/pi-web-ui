import { startTurnTiming, finishTurnTiming } from "../turn-timing.js";
import { DEFAULT_DSH_CAPABILITIES } from "../engine-capabilities.js";
import type { AgentEngineCapabilities } from "../protocol.js";
import { mergeQuickAskSettings, normalizeQuickAskSettings, type QuickAskSettings } from "../quick-ask-settings.js";
import { captureQuickAskConversation } from "../quick-ask-context.js";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { BG_CLEANUP_FALLBACK_MIN, BgServerTracker } from "../bg-servers.js";
import {
	ClientStateStore,
	DEFAULT_RETRY_MAX_ATTEMPTS,
	normalizeBgCleanupMinutes,
	normalizePathKey,
	normalizeToolWatchdogTimeoutMs,
	settingsPresetToUi,
} from "../client-state.js";
import {
	normalizeUiLayout,
	normalizeKeepRecentMessages,
	DEFAULT_KEEP_RECENT_MESSAGES,
	RECENT_PROJECTS_MAX,
} from "../client-state.js";
import { PLAN_MODE_SYSTEM_PROMPT } from "../plan-mode.js";
import { buildToolsSchemaText, type ToolSchemaEntry } from "../prompt-composer.js";
import { FilesService, workspacePath, desktopDirWire } from "../files-service.js";
import { SandboxManager, isSameOrSubpath, evaluateSandboxJail } from "../sandbox-service.js";
import { assertEngineWorkspaceSupported } from "../sandbox-engines.js";
import { QuiesceRejectedError } from "../agent-service.js";

import { NATIVE_COMMANDS, parseSlash } from "../slash-commands.js";
import { discoverDiskSkills, readSkillInstruction } from "../skill-discovery.js";
import {
	scanAtMentions,
	formatPromptWithSkills,
	formatUnavailableCanvasReference,
} from "../universal/universal-attachments.js";
import type { ProjectRunnerInfo, SessionOwnerInfo } from "../agent-service.js";
import { bilingual, pick, resolveServerLang, type ServerLang } from "../i18n.js";
import { ModelAdminService } from "../model-admin.js";
import { normalizeToolInfo, unsupportedToolInfo } from "../tool-info.js";
import { TerminalManager, loadCommands, saveCommandsFile } from "../terminals.js";
import { saveUpload } from "../uploads.js";
import type { PluginCommandDef } from "../plugins.js";
import { checkAll as checkAllUpdates, collectTargets, resolveNpmRegistry } from "../update-check.js";
import { collectInstalledEngineTargets } from "../engine-probe.js";
import { previewKind } from "../text-sniff.js";
import { removeQueuedByIndexOrText } from "../queue-utils.js";
import { ensureCredentialFilePermissions } from "../model-admin.js";
import type {
	BgServer,
	ClientMessage,
	CommandDef,
	ConversationSummary,
	DshPermissionOption,
	ElsewhereRunning,
	GoalStatus,
	ProjectSummary,
	PromptAttachment,
	ServerMessage,
	SessionSearchResult,
	SessionSummary,
	UiMessage,
	UiServiceInfo,
	UiSettingsState,
	UiSkillInfo,
	UiState,
	UiLayoutPrefs,
	DshPatchFileInfo,
} from "../protocol.js";
import { launchOrigin, toServiceInfo } from "../launch-origin.js";
import { DshRuntime, loadDeepSeekKey, type DshAgentPreset } from "./dsh-client.js";
import {
	resolveProviderCredential,
	listCustomModelsFromConfig,
	isModelProtocolSupportedByEngine,
} from "../model-resolver.js";
import { loadDshMarketData } from "./dsh-market-service.js";
import { formatTextQuote, readTextQuote, messageTextWithQuotes } from "../text-quote.js";
import { writeAtomicSync } from "../atomic-file.js";
import { zstdCompressSync } from "node:zlib";
import { MarkerService } from "../marker-service.js";
import {
	DshStreamAccumulator,
	assistantMessageEventToUiMessage,
	extractDshAssistantRawText,
	toolResultEventToUiMessage,
	userMessageEventToUiMessage,
} from "./dsh-serialize.js";
import {
	firstUserText,
	findSessionFilesForCwd,
	isDshInternalUserMessage,
	readSessionLog,
	replayEventsToMessages,
	sessionLogPermission,
	sessionLogPreset,
	sessionLogTitle,
} from "./dsh-sessions.js";
import { generatePresetClones, PRESET_DEFAULT_ID } from "./preset-clones.js";
import { dshContextUsage, lastUsageFromEvents, normalizeDshUsage } from "./dsh-usage.js";
import {
	exportPresetVia,
	importPresetFromUrlVia,
	importPresetVia,
	packageVersion,
	pushPresetCatalogVia,
	sharePresetVia,
	sanitizePresetSettings,
	type PresetSharePort,
} from "../preset-share.js";
import { getAppVersion } from "../pkg-info.js";
import { getMaxOpenConversations } from "../agent-formatters.js";
import type { PluginChatRequest, PluginConversationQuery, PluginConversationSnapshot } from "../plugins.js";

const SNAPSHOT_INTERVAL_MS = 60;
const HOME_WIRE = homedir().replace(/\\/g, "/");
const DESKTOP_WIRE = desktopDirWire(HOME_WIRE);
const PERMISSION_DEFAULT_PRESET = "workspace-write-never";
const PERMISSION_OFFERED = ["read-only", "workspace-write-never", "danger-full-access"];
const DEFAULT_CONV_TITLE = "新对话";
const DEFAULT_CONV_TITLE_EN = "New chat";
const DEFAULT_MODEL = "deepseek-v4-flash";

const DSH_MODELS = [
	{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "deepseek", vision: false },
	{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: "deepseek", vision: false },
	{
		id: "deepseek-v4-flash-vision-exp",
		name: "DeepSeek V4 Flash Vision (exp)",
		provider: "deepseek",
		vision: true,
	},
];

const DSH_CONTEXT_WINDOW = 1_000_000;
const DSH_PRICE_INPUT = 0.14;
const DSH_PRICE_CACHE_READ = 0.0028;
const DSH_PRICE_OUTPUT = 0.28;

function dshSessionRoot(dataDir: string): string {
	return join(dataDir, "dsh-sessions");
}

function estimateCost(t: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
	if (t.input + t.output === 0) return 0;
	return (
		((t.input + (t.cacheWrite ?? 0)) * DSH_PRICE_INPUT +
			(t.cacheRead ?? 0) * DSH_PRICE_CACHE_READ +
			t.output * DSH_PRICE_OUTPUT) /
		1e6
	);
}

interface DshConversation {
	id: string;
	sessionId: string;
	sessionFile?: string;
	agentPreset: string;
	presetLocked: boolean;
	assignedGen: number;
	permissionPreset: string | null;
	fromDisk?: boolean;
	dsGoal: {
		id: string;
		revision: number;
		phase: string;
		objective: string;
		maxGoalRounds: number;
		roundsStarted: number;
		blockedReason?: string;
	} | null;
	goal: GoalStatus;
	turnWaiter?: {
		resolve: () => void;
		reject: (err: Error) => void;
	};
	title: string;
	cwd: string;
	createdAt: number;
	messages: UiMessage[];
	messageIds: Set<string>;
	streaming: DshStreamAccumulator | null;
	isStreaming: boolean;
	turnTiming?: UiState["turnTiming"];
	queue: { steering: string[]; followUp: string[] };
	deltaSeq: number;
	lastEventAt: number;
	listed: boolean;
	promptedSinceActive: boolean;
	terminals: TerminalManager;
	toolStartTimes: Map<string, number>;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	usageSeen: boolean;
	liveChunks: boolean;
	streamAnchor: number;
	streamTurn: number;
}

interface DshSettings {
	promptMode: "append" | "replace";
	customSystemPrompt: string;
	disabledSkills: string[];
	disabledExtensions: string[];
	terminalToolsEnabled: boolean;
	terminalBash: boolean;
	terminalBashIdleMs: number;
	terminalBashMaxForegroundMs: number;
	toolWatchdogTimeoutMs: number;
	bgAutoCleanupMin: number;
	editSoftEnabled: boolean;
	questionnaireEnabled: boolean;
	toolApprovalEnabled: boolean;
	parallelReminderEnabled: boolean;
	goalModeEnabled: boolean;
	thinkingWrap: boolean;
	toolsWrap: boolean;
	toolImagesEnabled: boolean;
	keepRecentMessages: number;
	showForkedParentSessions: boolean;
	retainFinishedConversations: boolean;
	openRecentSessionOnProjectSwitch: boolean;
	disabledPlugins: string[];
	uiLayout: UiLayoutPrefs;
	reviewPrompt: string;
	defaultAgentPreset: string;
	defaultPermissionPreset: string;
	quickPhrases: string[];
	quickPhrasesEnabled: boolean;
	minimalNewChat: boolean;
	preserveDraftAcrossConversations: boolean;
	promptTemplate?: string;
	promptOverrides?: Record<string, string>;
	promptDisabled?: string[];
}

function normalizeToolResult(result: unknown): string {
	if (typeof result === "string") return result;
	if (result === null || result === undefined) return "";
	if (typeof result === "object") {
		const content = (result as { content?: unknown }).content;
		if (Array.isArray(content)) {
			const texts = content
				.filter(
					(b): b is { type: string; text?: unknown } =>
						!!b && typeof b === "object" && (b as { type?: unknown }).type === "text",
				)
				.map((b) => String(b.text ?? ""));
			if (texts.length) return texts.join("\n");
		}
		try {
			return JSON.stringify(result);
		} catch {
			return String(result);
		}
	}
	return String(result);
}

const DEFAULT_SETTINGS: DshSettings = {
	promptMode: "append",
	customSystemPrompt: "",
	disabledSkills: [],
	disabledExtensions: [],
	terminalToolsEnabled: false,
	terminalBash: false,
	terminalBashIdleMs: 15_000,
	terminalBashMaxForegroundMs: 60_000,
	toolWatchdogTimeoutMs: 20 * 60_000,
	bgAutoCleanupMin: 0,
	editSoftEnabled: false,
	questionnaireEnabled: true,
	toolApprovalEnabled: true,
	goalModeEnabled: true,
	parallelReminderEnabled: true,
	thinkingWrap: false,
	toolsWrap: true,
	toolImagesEnabled: true,
	keepRecentMessages: DEFAULT_KEEP_RECENT_MESSAGES,
	showForkedParentSessions: false,
	retainFinishedConversations: false,
	openRecentSessionOnProjectSwitch: true,
	disabledPlugins: [],
	uiLayout: {},
	reviewPrompt: "",
	defaultAgentPreset: PRESET_DEFAULT_ID,
	defaultPermissionPreset: PERMISSION_DEFAULT_PRESET,
	quickPhrases: [],
	quickPhrasesEnabled: true,
	minimalNewChat: false,
	preserveDraftAcrossConversations: false,
	promptTemplate: "",
	promptOverrides: {},
	promptDisabled: [],
};

export class DshClientSession {
	readonly clientId: string;
	cwd: string;
	private roots: string[] = [];
	private readonly stateStore: ClientStateStore;
	private readonly sessionRoot: string;
	private readonly dataDir: string;
	private readonly agentDir: string;
	private userTerminals: TerminalManager;

	private runtime!: DshRuntime;
	private convs = new Map<string, DshConversation>();
	private activeId = "";
	private convSeq = 0;
	private pendingQuestion: NonNullable<UiState["pendingQuestion"]> | null = null;

	private goalPrefs = { reviewModel: null as string | null, maxRounds: 2, locked: false };

	private sinks = new Set<(msg: ServerMessage) => void>();
	private pendingNotices: ServerMessage[] = [];
	private readonly sessionDrafts = new Map<string, { text: string; ts: number }>();
	private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
	private snapRev = 0;
	private version = 0;
	private emittedMessages: UiMessage[] | null = null;
	private emittedRev = 0;
	private disposed = false;
	private switchingWorkspace = false;
	private workspaceGeneration = 0;

	private model = DEFAULT_MODEL;
	private modelProvider = "deepseek";
	private modelDisplayName = "DeepSeek V4 Flash";
	private modelVision = false;
	thinkingLevel = "high";

	private static readonly RUNTIME_RESTART_WINDOW_MS = 60_000;
	private static readonly RUNTIME_MAX_RESTARTS = 2;
	private runtimeRestart = { count: 0, windowStart: 0 };

	private static readonly RECLAIM_INTERVAL_MS = 5 * 60_000;
	private static readonly CONV_RECLAIM_IDLE_MS = 30 * 60_000;
	private static readonly CONV_RECLAIM_LISTED_IDLE_MS = 24 * 3600_000;
	private reclaimTimer: ReturnType<typeof setInterval> | null = null;

	private static readonly SESSION_RETENTION_MS =
		(Number(process.env.PI_WEB_DSH_SESSION_RETENTION_DAYS) || 90) * 24 * 3600_000;
	private retentionTimer: ReturnType<typeof setInterval> | null = null;
	private retentionOnce: ReturnType<typeof setTimeout> | null = null;

	private settings: DshSettings = { ...DEFAULT_SETTINGS };
	private skillsCache: UiSkillInfo[] = [];
	private runtimeGen = 0;
	private agentPresets: DshAgentPreset[] = [];
	private agentPresetDefault = PRESET_DEFAULT_ID;
	private agentPresetsAvailable = false;
	private permissionOptions: DshPermissionOption[] = [];
	private presetCloneIds: string[] = [];

	private cachedEffectiveSystemPrompt = "";
	private cachedToolsSchema = "";
	private cachedPromptSections: { name: string; text: string; chars: number }[] = [];
	private cachedPromptSourceDefaults: Record<string, string> = {};

	private readonly files: FilesService;
	private readonly bg: BgServerTracker;
	private readonly sandboxes: SandboxManager;
	private bridgeCancellation = new AbortController();
	private cancelBridgedTools(): void {
		this.bridgeCancellation.abort();
		this.bridgeCancellation = new AbortController();
	}
	private readonly markerSvc: MarkerService;
	private readonly modelAdmin: ModelAdminService;

	onToolEvent:
		| ((ev: {
				phase: string;
				toolName: string;
				conversationId: string;
				durationMs?: number;
				isError?: boolean;
		  }) => void)
		| undefined;
	pluginToolsProvider: ((cwd?: string) => unknown[]) | undefined;
	pluginCommandsProvider: (() => PluginCommandDef[]) | undefined;
	pluginBgTasksProvider: (() => BgServer[]) | undefined;
	pluginStopBgTask: ((taskId: string) => boolean) | undefined;
	onQuit: (() => boolean) | undefined;
	isQuiesced: (() => boolean) | undefined;
	onCwdChanged: ((cwd: string) => void) | undefined;
	findSessionOwnerById: ((sessionId: string) => SessionOwnerInfo | null) | undefined = undefined;
	listProjectRunners: ((cwd: string) => ProjectRunnerInfo[]) | undefined = undefined;
	listExternalRunning: (() => ElsewhereRunning[]) | undefined = undefined;
	notifyExternalClients:
		| ((msg: { type: "notice"; level: "info" | "warning" | "error"; text: string; textEn?: string }) => void)
		| undefined = undefined;
	onRunningChanged: (() => void) | undefined = undefined;
	private lastRunningSig = "";

	private constructor(clientId: string, cwd: string, stateStore: ClientStateStore, dataDir: string, agentDir: string) {
		this.clientId = clientId;
		this.cwd = cwd;
		this.stateStore = stateStore;
		this.roots = stateStore.getWorkspaceRoots(clientId, cwd);
		this.dataDir = dataDir;
		this.agentDir = agentDir;
		ensureCredentialFilePermissions(this.agentDir);
		this.sessionRoot = dshSessionRoot(dataDir);
		this.sandboxes = new SandboxManager(dataDir);
		try {
			mkdirSync(this.sessionRoot, { recursive: true });
		} catch {}
		this.files = new FilesService({
			emit: (msg) => this.emit(msg),
			isDisposed: () => this.disposed,
			getCwd: () => this.cwd,
			getActiveCwd: () => this.cwd,
			getUploadMaxBytes: () =>
				(this.stateStore.getSettingsSnapshot(this.clientId).workspaceUploadMaxMb ?? 100) * 1024 * 1024,
		});
		this.modelAdmin = new ModelAdminService({
			agentDir: this.agentDir,
			emit: (msg) => this.emit(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			pushModels: async () => this.listModels(),
		});
		this.bg = new BgServerTracker({
			emit: (msg) => this.emit(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			pluginTasks: () => this.pluginBgTasksProvider?.() ?? [],
			cleanupMinutes: () => Number(this.settings.bgAutoCleanupMin ?? 0),
			workspaceCwd: () => this.cwd,
		});
		this.markerSvc = new MarkerService({
			clientId,
			stateStore,
			emit: (msg) => this.emit(msg),
			isDisposed: () => this.disposed,
			getActiveConversationId: () => this.activeId,
			getSessionManager: () => undefined,
			renameConversation: (convId, title) => {
				void this.renameConversation(convId, title);
			},
			refreshMarkers: () => this.flushSnapshot(),
			onActionsChange: (convId) => {
				if (convId === this.activeId) this.flushSnapshot();
			},
			lang: () => this.getLang(),
		});
		this.userTerminals = new TerminalManager(
			(msg) => {
				if (msg.type === "terminal_list") {
					this.pushTerminals();
					return;
				}
				this.emit(msg);
			},
			() => this.cwd,
			() => this.getLang(),
			"client",
		);
	}

	static create(
		clientId: string,
		cwd: string,
		stateStore: ClientStateStore,
		dataDir: string,
		agentDir?: string,
	): DshClientSession {
		const cs = new DshClientSession(clientId, cwd, stateStore, dataDir, agentDir ?? join(homedir(), ".pi", "agent"));
		const gPrefs = stateStore.getGoalPrefs(clientId);
		if (gPrefs) {
			cs.goalPrefs = {
				reviewModel: gPrefs.reviewModel,
				maxRounds: gPrefs.maxRounds,
				locked: gPrefs.locked,
			};
		}
		const savedModel = stateStore.getProjectModel(clientId, cwd, "dsh") ?? stateStore.getDefaultModel("dsh");
		if (savedModel) {
			cs.applySavedModel(savedModel);
		}
		const savedSettings = stateStore.getSettings(clientId);
		if (savedSettings) {
			cs.settings = {
				promptMode: savedSettings.promptMode,
				customSystemPrompt: savedSettings.customSystemPrompt,
				disabledSkills: savedSettings.disabledSkills ?? [],
				disabledExtensions: savedSettings.disabledExtensions ?? [],
				terminalToolsEnabled: savedSettings.terminalToolsEnabled,
				terminalBash: savedSettings.terminalBash,
				terminalBashIdleMs: savedSettings.terminalBashIdleMs,
				terminalBashMaxForegroundMs: savedSettings.terminalBashMaxForegroundMs ?? 60_000,
				toolWatchdogTimeoutMs: savedSettings.toolWatchdogTimeoutMs ?? 20 * 60_000,
				bgAutoCleanupMin: Number(savedSettings.bgAutoCleanupMin ?? 0),
				editSoftEnabled: savedSettings.editSoftEnabled,
				questionnaireEnabled: savedSettings.questionnaireEnabled ?? true,
				toolApprovalEnabled: savedSettings.toolApprovalEnabled ?? true,
				goalModeEnabled: savedSettings.goalModeEnabled ?? true,
				parallelReminderEnabled: savedSettings.parallelReminderEnabled ?? true,
				thinkingWrap: savedSettings.thinkingWrap,
				toolsWrap: savedSettings.toolsWrap,
				toolImagesEnabled: savedSettings.toolImagesEnabled ?? true,
				keepRecentMessages: normalizeKeepRecentMessages(savedSettings.keepRecentMessages),
				showForkedParentSessions: savedSettings.showForkedParentSessions ?? false,
				retainFinishedConversations: savedSettings.retainFinishedConversations ?? false,
				openRecentSessionOnProjectSwitch: savedSettings.openRecentSessionOnProjectSwitch ?? true,
				disabledPlugins: savedSettings.disabledPlugins ?? [],
				uiLayout: normalizeUiLayout(savedSettings.uiLayout),
				reviewPrompt: savedSettings.reviewPrompt,
				quickPhrases: savedSettings.quickPhrases ?? [],
				quickPhrasesEnabled: savedSettings.quickPhrasesEnabled ?? true,
				minimalNewChat: savedSettings.minimalNewChat ?? false,
				preserveDraftAcrossConversations: savedSettings.preserveDraftAcrossConversations ?? false,
				promptTemplate: savedSettings.promptTemplate ?? "",
				promptOverrides: savedSettings.promptOverrides ?? {},
				promptDisabled: savedSettings.promptDisabled ?? [],
				defaultAgentPreset: savedSettings.defaultAgentPreset ?? PRESET_DEFAULT_ID,
				defaultPermissionPreset:
					savedSettings.defaultPermissionPreset && PERMISSION_OFFERED.includes(savedSettings.defaultPermissionPreset)
						? savedSettings.defaultPermissionPreset
						: PERMISSION_DEFAULT_PRESET,
			};
		}
		cs.makeRuntime();
		const recentFiles = findSessionFilesForCwd(cs.sessionRoot, cwd).filter(
			(f) => !basename(dirname(f)).startsWith("review-"),
		);
		let resumedConv: DshConversation | null = null;
		for (const file of recentFiles) {
			try {
				const { events } = readSessionLog(file);
				const hasRealMessages = events.some(
					(e) =>
						(e.type === "user/message" && !isDshInternalUserMessage(e.data as Record<string, unknown>)) ||
						e.type === "assistant/message",
				);
				if (hasRealMessages) {
					const sid = basename(dirname(file));
					const conv = cs.addConversation(sid, cwd, true, cs.settings.defaultAgentPreset, file);
					conv.fromDisk = true;
					conv.sessionFile = file;
					resumedConv = conv;
					break;
				}
			} catch {
				continue;
			}
		}
		if (resumedConv) {
			cs.activeId = resumedConv.id;
		} else {
			const first = cs.addConversation(`web-${randomUUID().slice(0, 12)}`, cwd, false, cs.settings.defaultAgentPreset);
			cs.activeId = first.id;
		}
		cs.attachRuntimeEvents();
		cs.runtime.onStarted = () => {
			if (cs.switchingWorkspace) return;
			cs.runtimeGen += 1;
			void cs.syncPluginTools();
			void cs.pushDisabledSkillsToRuntime();
			void cs.refreshSkillsFromRuntime();
			void cs.refreshAgentPresets();
			void cs.refreshPermissionOptions().catch(() => {});
			void cs.refreshActivePermission().catch(() => {});
			void cs.refreshPromptInfo().catch(() => {});
		};
		cs.runtime.onExit = (code, signal, intentional) => {
			cs.cancelBridgedTools();
			if (intentional) return;
			cs.handleRuntimeExit(code, signal);
		};
		void cs.startWithRetry().catch((err) => {
			console.error(`[dsh] runtime.start 失败 (client=${clientId}): ${(err as Error).message}`);
			const errMsg = (err as Error).message || "";
			const isDepOrRuntimeIssue =
				/找不到 DSH 运行时树|版本族不匹配|version mismatch|dsh-base|typert|codec|launcher|spawn|node_modules|not found|exit.*code/i.test(
					errMsg,
				);
			const hintZh = isDepOrRuntimeIssue
				? "请检查 @deepseek-ai/dsh 依赖安装与版本匹配（详见 docs/dsh-engine.md）。"
				: "请检查 DeepSeek API key（~/.pi/agent/auth.json）与 dsh 依赖安装。";
			const hintEn = isDepOrRuntimeIssue
				? "Check @deepseek-ai/dsh installation and version compatibility (see docs/dsh-engine.md)."
				: "Check the DeepSeek API key (~/.pi/agent/auth.json) and dsh dependencies.";
			cs.pendingNotices.push({
				type: "notice",
				level: "error",
				text: `DSH 运行时启动失败：${errMsg}。${hintZh}`,
				textEn: `DSH runtime failed to start: ${errMsg}. ${hintEn}`,
			});
		});
		cs.reclaimTimer = setInterval(() => cs.reclaimIdleConversations(), DshClientSession.RECLAIM_INTERVAL_MS);
		cs.reclaimTimer.unref?.();
		cs.retentionOnce = setTimeout(() => void cs.cleanupExpiredSessions(), 10_000);
		cs.retentionOnce.unref?.();
		cs.retentionTimer = setInterval(() => void cs.cleanupExpiredSessions(), 24 * 3600_000);
		cs.retentionTimer.unref?.();
		cs.bg.start();
		return cs;
	}

	private async startWithRetry(): Promise<void> {
		const delays = [1000, 3000, 9000];
		let lastErr: unknown;
		for (let i = 0; i <= delays.length; i++) {
			try {
				await this.runtime.start();
				return;
			} catch (err) {
				lastErr = err;
				if (i === delays.length) break;
				await new Promise((r) => setTimeout(r, delays[i]!));
			}
		}
		throw lastErr;
	}

	private handleRuntimeExit(code: number | null, signal: string | null): void {
		if (this.disposed) return;
		console.error(`[dsh] runtime 意外退出 (client=${this.clientId}) code=${code} signal=${signal}`);
		for (const conv of this.convs.values()) {
			finishTurnTiming(conv);
			conv.isStreaming = false;
			conv.streaming = null;
			conv.liveChunks = false;
		}
		this.emitConversations();
		const now = Date.now();
		if (now - this.runtimeRestart.windowStart > DshClientSession.RUNTIME_RESTART_WINDOW_MS) {
			this.runtimeRestart.windowStart = now;
			this.runtimeRestart.count = 0;
		}
		this.runtimeRestart.count += 1;
		if (this.runtimeRestart.count > DshClientSession.RUNTIME_MAX_RESTARTS) {
			console.error(`[dsh] runtime 反复崩溃 (code=${code} signal=${signal})，停止自动重启`);
			const tail = this.runtime.getStderrTail();
			const isDepOrRuntimeIssue = /找不到 DSH 运行时树|版本族不匹配|version mismatch|dsh-base|typert|codec/i.test(tail);
			const hintZh = isDepOrRuntimeIssue
				? "DSH 运行时反复崩溃，已停止自动重启。请检查 dsh 运行时依赖安装与版本匹配（详见 docs/dsh-engine.md）。"
				: "DSH 运行时反复崩溃，已停止自动重启。请检查 DeepSeek API key 与 dsh 依赖安装。";
			const hintEn = isDepOrRuntimeIssue
				? "DSH runtime keeps crashing; auto-restart stopped. Check dsh runtime dependencies and version compatibility (see docs/dsh-engine.md)."
				: "DSH runtime keeps crashing; auto-restart stopped. Check the DeepSeek API key and dsh dependencies.";
			this.emit({
				type: "notice",
				level: "error",
				text: hintZh,
				textEn: hintEn,
			});
			this.flushSnapshot();
			return;
		}
		this.emit({
			type: "notice",
			level: "warning",
			text: "DSH 运行时意外退出，正在自动重启…",
			textEn: "DSH runtime exited unexpectedly; restarting…",
		});
		void this.startWithRetry().catch((err) => {
			this.emit({
				type: "notice",
				level: "error",
				text: `自动重启失败：${(err as Error).message}`,
				textEn: `Auto-restart failed: ${(err as Error).message}`,
			});
		});
		this.flushSnapshot();
	}

	private reclaimIdleConversations(): void {
		if (this.disposed) return;
		const now = Date.now();
		let changed = false;
		for (const [id, conv] of this.convs) {
			if (id === this.activeId) continue;
			if (conv.isStreaming) continue;
			if (conv.terminals.countBlockingLive() > 0) continue;
			const idle = now - conv.lastEventAt;
			const limit = conv.listed ? DshClientSession.CONV_RECLAIM_LISTED_IDLE_MS : DshClientSession.CONV_RECLAIM_IDLE_MS;
			if (idle > limit) {
				this.removeConversation(id);
				changed = true;
			}
		}
		if (changed) {
			this.emitConversations();
			this.flushSnapshot();
		}
	}

	private async cleanupExpiredSessions(): Promise<void> {
		if (this.disposed) return;
		const cutoff = Date.now() - DshClientSession.SESSION_RETENTION_MS;
		try {
			const { readdirSync, rmSync } = await import("node:fs");
			const dirLastModified = (dir: string, cutoffMs: number): number => {
				let max = 0;
				try {
					for (const e of readdirSync(dir, { withFileTypes: true })) {
						const p = join(dir, e.name);
						try {
							if (e.isDirectory()) {
								const subMax = dirLastModified(p, cutoffMs);
								if (subMax >= cutoffMs) return subMax;
								max = Math.max(max, subMax);
							} else {
								const m = statSync(p).mtimeMs;
								if (m >= cutoffMs) return m;
								max = Math.max(max, m);
							}
						} catch {}
					}
				} catch {}
				return max;
			};
			let removed = 0;
			const scan = (dir: string): void => {
				let entries: { name: string; isDirectory: () => boolean }[];
				try {
					entries = readdirSync(dir, { withFileTypes: true });
				} catch {
					return;
				}
				for (const e of entries) {
					const p = join(dir, e.name);
					if (!e.isDirectory()) continue;
					const lastMod = dirLastModified(p, cutoff);
					if (lastMod === 0) continue;
					if (lastMod < cutoff) {
						rmSync(p, { recursive: true, force: true });
						removed++;
					} else {
						scan(p);
					}
				}
			};
			scan(this.sessionRoot);
			if (removed > 0) {
				console.error(`[dsh] 已清理 ${removed} 个超过保留期的会话目录`);
				this.scheduleSessionsRefresh();
			}
		} catch {}
	}

	private makeRuntime(): void {
		let presetPatch: string | undefined;
		try {
			const clones = generatePresetClones(this.dataDir);
			if (clones) {
				presetPatch = clones.patchFile;
				if (clones.warnings.length > 0) {
					console.error(`[dsh] preset clone warnings: ${clones.warnings.join("; ")}`);
				}
				this.presetCloneIds = clones.presetIds;
			} else {
				this.presetCloneIds = [];
			}
		} catch (err) {
			console.error(`[dsh] preset clone 生成失败，回落 legacy: ${(err as Error).message}`);
			this.presetCloneIds = [];
		}
		this.runtime = new DshRuntime({
			beforeStart: (cwd) => assertEngineWorkspaceSupported(this.sandboxes, cwd, "dsh"),
			onStopping: () => this.cancelBridgedTools(),
			cwd: this.cwd,
			provider: "deepseek-official",
			model: this.model,
			modelProvider: this.modelProvider,
			sessionRoot: this.sessionRoot,
			dataDir: this.dataDir,
			agentDir: this.agentDir,
			env: {
				...(presetPatch ? { PI_WEB_DSH_PRESET_PATCH: presetPatch } : {}),
				...this.buildPersonaEnv(),
			},
		});
	}

	private attachRuntimeEvents(): void {
		this.runtime.onNotification((method, params) => {
			if (this.disposed) return;
			try {
				if (method === "session.event") {
					this.handleSessionEvent(
						params as {
							sessionId: string;
							event: { type: string; seq: number; time: number; data: Record<string, unknown> };
						},
					);
				} else if (method === "assistant.stream") {
					this.handleAssistantStream(params as { sessionId: string; frame: Record<string, unknown> });
				} else if (method === "session.status") {
					this.handleSessionStatus(params as { sessionId: string; status: string });
				} else if (method === "question.pending") {
					const params0 = params as { id: string; questions?: unknown[]; deadline?: unknown };
					if (this.settings.questionnaireEnabled === false) {
						void this.answerQuestion(params0.id, [], true);
						return;
					}
					const mapped = (params0.questions ?? []).map((q) => ({
						id: String((q as { id?: unknown }).id ?? ""),
						question: String((q as { question?: unknown }).question ?? ""),
						...(typeof (q as { detail?: unknown }).detail === "string"
							? { detail: (q as { detail: string }).detail }
							: {}),
						...(typeof (q as { header?: unknown }).header === "string"
							? { header: (q as { header: string }).header }
							: {}),
						...(Array.isArray((q as { options?: unknown }).options)
							? {
									options: (q as { options: { label?: string; description?: string; preview?: string }[] }).options.map(
										(o) => ({
											label: String(o.label ?? ""),
											...(typeof o.description === "string" ? { description: o.description } : {}),
											...(typeof o.preview === "string" ? { preview: o.preview } : {}),
										}),
									),
								}
							: {}),
						...((q as { multiSelect?: unknown }).multiSelect ? { multiSelect: true } : {}),
					}));
					const dshConv = this.convs.get(this.activeId);
					const conversationTitle = dshConv?.title;
					this.pendingQuestion = {
						id: params0.id,
						...(typeof params0.deadline === "number" ? { deadline: params0.deadline } : {}),
						questions: mapped,
						...(this.activeId ? { conversationId: this.activeId } : {}),
						...(conversationTitle ? { conversationTitle } : {}),
					};
					this.emit({
						type: "question_pending",
						id: params0.id,
						...(typeof params0.deadline === "number" ? { deadline: params0.deadline } : {}),
						questions: mapped,
						...(this.activeId ? { conversationId: this.activeId } : {}),
						...(conversationTitle ? { conversationTitle } : {}),
					});
					this.flushSnapshot();
				} else if (method === "tools.call.request") {
					void this.handleToolCallRequest(params as { id: string; name: string; args?: Record<string, unknown> });
				}
			} catch (err) {
				console.error("[dsh] event handler error:", err);
			}
		});
	}

	private pendingQuestionForSnapshot(): NonNullable<UiState["pendingQuestion"]> | null {
		const p = this.pendingQuestion;
		if (!p) return null;
		if (p.deadline !== undefined && p.deadline <= Date.now()) return null;
		return p;
	}

	async answerQuestion(
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
	): Promise<void> {
		if (this.pendingQuestion?.id === id) this.pendingQuestion = null;
		this.flushSnapshot();
		try {
			await this.runtime.answerQuestion(id, answers, cancelled);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `回答失败：${(err as Error).message}`,
				textEn: `Answer failed: ${(err as Error).message}`,
			});
		}
	}

	private bridgedTool(t: unknown):
		| {
				name: string;
				description: string;
				parameters?: Record<string, unknown>;
				execute: (
					callId: string,
					params: Record<string, unknown>,
					signal?: AbortSignal,
					onUpdate?: (p: unknown) => void,
				) => Promise<unknown>;
		  }
		| undefined {
		const tool = t as { name?: unknown; description?: unknown; parameters?: unknown; execute?: unknown };
		if (
			!tool ||
			typeof tool.name !== "string" ||
			typeof tool.description !== "string" ||
			typeof tool.execute !== "function"
		)
			return undefined;
		return {
			name: tool.name,
			description: tool.description,
			...(tool.parameters && typeof tool.parameters === "object"
				? { parameters: tool.parameters as Record<string, unknown> }
				: {}),
			execute: tool.execute as (
				callId: string,
				params: Record<string, unknown>,
				signal?: AbortSignal,
				onUpdate?: (p: unknown) => void,
			) => Promise<unknown>,
		};
	}

	mcpProjectCwds(): string[] {
		return [...new Set([this.cwd, ...[...this.convs.values()].map((conv) => conv.cwd)])];
	}

	async syncPluginTools(): Promise<void> {
		if (!this.runtime.alive) return;
		const provider = this.pluginToolsProvider;
		if (!provider) return;
		const tools = (provider(this.cwd) ?? [])
			.map((t) => this.bridgedTool(t))
			.filter((t): t is NonNullable<typeof t> => t !== undefined);
		const defs = tools.map((t) => ({
			name: t.name,
			description: t.description,
			...(t.parameters ? { parameters: t.parameters } : {}),
		}));
		try {
			await this.runtime.syncTools(defs);
		} catch (err) {
			console.error(`[dsh] syncPluginTools 失败 (client=${this.clientId}):`, err);
		}
	}

	async getToolInfo(name: string): Promise<void> {
		if (!this.runtime.alive) {
			this.emit({ type: "tool_info", ...unsupportedToolInfo(name) });
			return;
		}
		try {
			const res = await this.runtime.listTools();
			const found = (res.tools ?? []).find((t) => t.name === name);
			this.emit({ type: "tool_info", ...normalizeToolInfo(name, found) });
		} catch (err) {
			console.error(`[dsh] listTools 失败 (client=${this.clientId}):`, err);
			this.emit({ type: "tool_info", ...unsupportedToolInfo(name) });
		}
	}

	async refreshSkillsFromRuntime(): Promise<void> {
		if (!this.runtime.alive) return;
		try {
			const res = await this.runtime.listSkills();
			const disabled = new Set(this.settings.disabledSkills);
			this.skillsCache = (res.skills ?? []).map((s) => ({
				name: s.name,
				description: s.description ?? "",
				enabled: !disabled.has(s.name),
			}));
		} catch (err) {
			console.error(`[dsh] listSkills 失败 (client=${this.clientId}):`, err);
			return;
		}
		try {
			this.pushSettings();
		} catch {}
	}

	async pushDisabledSkillsToRuntime(): Promise<void> {
		if (!this.runtime.alive) return;
		try {
			await this.runtime.setDisabledSkills(this.settings.disabledSkills);
		} catch (err) {
			console.error(`[dsh] setDisabledSkills 失败 (client=${this.clientId}):`, err);
		}
	}

	private async handleToolCallRequest(params: {
		id: string;
		name: string;
		args?: Record<string, unknown>;
	}): Promise<void> {
		const id = String(params?.id ?? "");
		const name = String(params?.name ?? "");
		const args = (params?.args && typeof params.args === "object" ? params.args : {}) as Record<string, unknown>;
		if (!id) return;
		const lang = this.getLang();
		const runtime = this.runtime;
		const cwd = runtime.cwd;
		const signal = this.bridgeCancellation.signal;
		if (!name) {
			void this.runtime
				.toolsCallResult(id, pick(lang, "工具名缺失", "Missing tool name", "dsh.tool.missing.name"), true)
				.catch(() => {});
			return;
		}
		try {
			const tool = this.bridgedTool(
				(this.pluginToolsProvider?.(this.cwd) ?? []).find((t) => (t as { name?: unknown }).name === name),
			);
			if (!tool) {
				await this.runtime.toolsCallResult(
					id,
					pick(lang, `未知插件工具：${name}`, `Unknown plugin tool: ${name}`, "dsh.tool.unknown.plugin", { name }),
					true,
				);
				return;
			}
			signal.throwIfAborted();
			const sandbox = this.sandboxes.getExecutionIdentity(cwd);
			const release = this.sandboxes.acquireExecution(cwd, sandbox);
			try {
				const denied = sandbox && evaluateSandboxJail(sandbox, name, args, cwd);
				if (denied) throw new Error(denied.reasonEn);
				signal.throwIfAborted();
				const raw = await tool.execute(id, args, signal);
				signal.throwIfAborted();
				await runtime.toolsCallResult(id, normalizeToolResult(raw), false);
			} finally {
				release();
			}
		} catch (err) {
			if (signal.aborted) return;
			const msg = (err as Error)?.message ?? String(err);
			await runtime.toolsCallResult(id, msg, true);
		}
	}

	private nextConversationId(): string {
		return `c${++this.convSeq}-${randomUUID().slice(0, 8)}`;
	}

	private makeGoalStatus(): GoalStatus {
		return {
			conversationId: null,
			goal: null,
			reviewModel: this.goalPrefs.reviewModel,
			maxRounds: this.goalPrefs.maxRounds,
			locked: this.goalPrefs.locked,
			reviewing: false,
			round: 0,
			status: "",
			verdict: "pending",
			wizard: { active: false, draft: "", model: null, step: 0, maxSteps: 3, status: "" },
		};
	}

	private defaultTitle(): string {
		return pick(this.getLang(), DEFAULT_CONV_TITLE, DEFAULT_CONV_TITLE_EN, "dsh.conv.default.title");
	}

	private static isDefaultTitle(title: string): boolean {
		return title === DEFAULT_CONV_TITLE || title === DEFAULT_CONV_TITLE_EN;
	}

	private addConversation(
		sessionId: string,
		cwd: string,
		replay = true,
		preset?: string,
		sessionFilePath?: string,
	): DshConversation {
		const id = this.nextConversationId();
		const conv: DshConversation = {
			id,
			sessionId,
			sessionFile: sessionFilePath,
			agentPreset: this.resolvePreset(preset),
			presetLocked: false,
			assignedGen: -1,
			permissionPreset: null,
			dsGoal: null,
			goal: this.makeGoalStatus(),
			title: this.defaultTitle(),
			cwd,
			createdAt: Date.now(),
			messages: [],
			messageIds: new Set(),
			streaming: null,
			isStreaming: false,
			queue: { steering: [], followUp: [] },
			deltaSeq: 0,
			lastEventAt: Date.now(),
			listed: false,
			promptedSinceActive: false,
			terminals: new TerminalManager(
				(msg) => this.emit(msg),
				cwd,
				() => this.getLang(),
			),
			toolStartTimes: new Map(),
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			usageSeen: false,
			liveChunks: false,
			streamAnchor: 0,
			streamTurn: 0,
		};
		if (replay) {
			try {
				let targetFile = sessionFilePath && existsSync(sessionFilePath) ? sessionFilePath : null;
				if (!targetFile) {
					const files = findSessionFilesForCwd(this.sessionRoot, cwd).filter((f) => basename(dirname(f)) === sessionId);
					if (files.length > 0) targetFile = files[0];
				}
				if (targetFile) {
					conv.sessionFile = targetFile;
					const { header, events } = readSessionLog(targetFile);
					conv.messages = replayEventsToMessages(events);
					for (const m of conv.messages) conv.messageIds.add(m.id);
					conv.title = firstUserText(events, this.getLang());
					const logged = sessionLogPreset({ header, events });
					conv.agentPreset = this.resolvePreset(logged ?? preset);
					conv.permissionPreset = sessionLogPermission({ header, events });
					const loggedUsage = lastUsageFromEvents(events);
					if (loggedUsage) {
						conv.tokens = loggedUsage;
						conv.usageSeen = true;
					}
					if (conv.messages.length > 0) conv.presetLocked = true;
				}
			} catch {}
		}
		this.convs.set(conv.id, conv);
		return conv;
	}

	private get conv(): DshConversation {
		return this.convs.get(this.activeId)!;
	}

	private findConv(sessionId: string): DshConversation | undefined {
		for (const conv of this.convs.values()) {
			if (conv.sessionId === sessionId) return conv;
		}
		return undefined;
	}

	private handleSessionEvent(params: {
		sessionId: string;
		event: { type: string; seq: number; time: number; data: Record<string, unknown> };
	}): void {
		const conv = this.findConv(params.sessionId);
		if (!conv) return;
		conv.lastEventAt = Date.now();
		const ev = params.event;
		switch (ev.type) {
			case "user/message": {
				const srcKind = (ev.data as { source?: { kind?: string } }).source?.kind;
				if (srcKind === "goal") {
					const round = (ev.data as { source?: { round?: number } }).source?.round;
					if (round && conv.goal.goal && conv.id === this.activeId) {
						conv.goal.round = round;
						conv.goal.reviewing = true;
						const max = conv.goal.maxRounds || conv.dsGoal?.maxGoalRounds || 0;
						conv.goal.status =
							max > 0 && round >= max ? `已达轮数上限（${round}/${max}），目标未完成` : `目标进行中（第 ${round} 轮）…`;
						conv.goal.statusEn =
							max > 0 && round >= max
								? `Round cap reached (${round}/${max}), goal incomplete`
								: `Goal in progress (round ${round})…`;
						this.emitGoalStatus();
					}
					break;
				}
				if (isDshInternalUserMessage(ev.data as Record<string, unknown>)) break;
				const msg = userMessageEventToUiMessage(ev.data as never);
				const text = messageTextWithQuotes(msg);
				const cleanText = text
					.replace(/\n\[(?:文件引用|File reference|上传文件|Uploaded file|图片附件|Image attachment):[\s\S]*$/u, "")
					.trim();

				const pendingIdx = conv.messages.findIndex(
					(m) => m.role === "user" && typeof m.id === "string" && m.id.startsWith("u-pending-"),
				);
				if (pendingIdx !== -1) {
					const pendingMsg = conv.messages[pendingIdx];
					const pendingText = messageTextWithQuotes(pendingMsg).trim();
					if (pendingText === text || pendingText === cleanText || text.startsWith(pendingText)) {
						conv.messageIds.delete(pendingMsg.id);
						conv.messageIds.add(msg.id);
						conv.messages[pendingIdx] = msg;
						const imgRefs = ((ev.data as { content?: unknown[] }).content ?? [])
							.filter((b) => (b as { type?: string })?.type === "image")
							.map((b) => (b as { attachment?: { attachmentId?: string; mediaType?: string } }).attachment)
							.filter(
								(r): r is { attachmentId: string; mediaType: string } =>
									!!r && typeof r.attachmentId === "string" && typeof r.mediaType === "string",
							);
						if (imgRefs.length > 0) {
							void this.hydrateImageBlocks(conv, msg, imgRefs);
						}
						break;
					}
				}

				if (
					cleanText &&
					conv.messages.some((m) => {
						if (m.role !== "user") return false;
						const mt = messageTextWithQuotes(m).trim();
						return mt === text || mt === cleanText;
					})
				) {
					break;
				}
				this.appendMessage(conv, msg);
				const imgRefs = ((ev.data as { content?: unknown[] }).content ?? [])
					.filter((b) => (b as { type?: string })?.type === "image")
					.map((b) => (b as { attachment?: { attachmentId?: string; mediaType?: string } }).attachment)
					.filter(
						(r): r is { attachmentId: string; mediaType: string } =>
							!!r && typeof r.attachmentId === "string" && typeof r.mediaType === "string",
					);
				if (imgRefs.length > 0) {
					void this.hydrateImageBlocks(conv, msg, imgRefs);
				}
				if (DshClientSession.isDefaultTitle(conv.title)) {
					const t = conv.messages
						.find((m) => m.role === "user")
						?.content?.map((c) => ("text" in c ? c.text : ""))
						.join(" ")
						.trim();
					if (t) conv.title = t.length > 30 ? `${t.slice(0, 30)}…` : t;
				}
				break;
			}
			case "assistant/message": {
				const msg = assistantMessageEventToUiMessage(ev.data as never);
				if (msg) {
					conv.streaming = null;
					this.appendMessage(conv, msg);
				}
				const rawText = extractDshAssistantRawText(ev.data as never);
				if (rawText && rawText.includes("[[")) {
					void this.markerSvc.handleAssistantText(conv.id, rawText);
				}
				this.applyUsage(conv, (ev.data as { usage?: unknown }).usage);
				break;
			}
			case "tool/result": {
				const msg = toolResultEventToUiMessage(ev.data as never);
				if (msg) this.appendMessage(conv, msg);
				const startedAt = conv.toolStartTimes.get(msg?.toolCallId ?? "");
				if (msg) conv.toolStartTimes.delete(msg.toolCallId ?? "");
				const toolName = (ev.data as { toolName?: string }).toolName;
				if (toolName === "bash") void this.bg.trackAfterBash();
				this.onToolEvent?.({
					phase: "end",
					toolName: toolName ?? "tool",
					conversationId: conv.id,
					...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {}),
					isError: msg?.isError === true,
				});
				if (msg) {
					this.emit({
						type: "tool_status",
						toolCallId: msg.toolCallId ?? "",
						toolName: toolName ?? "tool",
						isError: msg.isError === true,
					});
				}
				this.flushSnapshot();
				break;
			}
			case "assistant/chunk": {
				if (conv.liveChunks) break;
				const chunk = ev.data?.chunk as Record<string, unknown> | undefined;
				if (!chunk) break;
				this.applyStreamChunk(conv, chunk, ev.seq, (ev.data?.turn as number) ?? 0);
				break;
			}
			case "tool/call": {
				const callId = ev.data?.callId as string;
				const name = ev.data?.name as string;
				if (callId) conv.toolStartTimes.set(callId, Date.now());
				if (name === "bash") this.bg.snapshotBefore();
				this.onToolEvent?.({ phase: "start", toolName: name ?? "tool", conversationId: conv.id });
				break;
			}
			case "goal/change": {
				this.applyGoalChange(conv, ev.data as never);
				break;
			}
			case "turn/end": {
				conv.streaming = null;
				const reason = (ev.data?.reason as { kind?: string; error?: { message?: string } }) ?? {};
				if (reason.kind === "error" && /id collision/i.test(reason.error?.message ?? "") && !conv.fromDisk) {
					this.forkAndReprompt(conv);
				} else if (conv.turnWaiter) {
					const w = conv.turnWaiter;
					conv.turnWaiter = undefined;
					if (reason.kind === "completed") w.resolve();
					else
						w.reject(
							new Error(
								reason.error?.message ??
									pick(
										this.getLang(),
										`本轮异常结束（${reason.kind}）`,
										`Round ended abnormally (${reason.kind})`,
										"dsh.round.ended.abnormally",
										{ "reason.kind": reason.kind },
									),
							),
						);
				}
				break;
			}
			case "session/title": {
				const title = (ev.data?.title as string) ?? "";
				if (title) conv.title = title;
				break;
			}
			case "agent/inbox/spliced": {
				const inserted = (ev.data?.inserted as { content?: { type?: string; text?: string }[] }[] | undefined) ?? [];
				const texts = inserted.map((m) => m.content?.find((c) => c.type === "text")?.text ?? "").filter(Boolean);
				if (texts.length > 0) {
					for (const t of texts) {
						const i = conv.queue.followUp.indexOf(t);
						if (i >= 0) conv.queue.followUp.splice(i, 1);
					}
				}
				break;
			}
			default:
				break;
		}
		if (
			ev.type === "turn/end" ||
			ev.type === "tool/result" ||
			ev.type === "assistant/message" ||
			ev.type === "agent/inbox/spliced"
		) {
			this.flushSnapshot();
		} else {
			this.scheduleSnapshot();
		}
	}

	private handleAssistantStream(params: { sessionId: string; frame?: Record<string, unknown> }): void {
		const conv = this.findConv(params.sessionId);
		const frame = params.frame;
		if (!conv || !frame || typeof frame.type !== "string") return;
		conv.lastEventAt = Date.now();
		if (frame.type === "start") {
			conv.liveChunks = true;
			conv.streaming = null;
			conv.streamAnchor = typeof frame.time === "number" && Number.isFinite(frame.time) ? frame.time : Date.now();
			conv.streamTurn = typeof frame.turn === "number" ? frame.turn : 0;
			this.scheduleSnapshot();
			return;
		}
		if (frame.type !== "chunk") return;
		conv.liveChunks = true;
		const chunk = frame.chunk as Record<string, unknown> | undefined;
		if (!chunk) return;
		if (!conv.streamAnchor) {
			conv.streamAnchor = typeof frame.time === "number" && Number.isFinite(frame.time) ? frame.time : Date.now();
			conv.streamTurn = typeof frame.turn === "number" ? frame.turn : 0;
		}
		this.applyStreamChunk(conv, chunk, conv.streamAnchor, conv.streamTurn);
		this.scheduleSnapshot();
	}

	private applyStreamChunk(
		conv: DshConversation,
		chunk: Record<string, unknown>,
		anchorId: number,
		turn: number,
	): void {
		if (chunk.type === "usage") {
			this.applyUsage(conv, chunk.usage);
			return;
		}
		if (!conv.streaming) conv.streaming = new DshStreamAccumulator(anchorId, turn);
		conv.streaming.apply(chunk);
		if (conv.id === this.conv.id && (chunk.type === "text-delta" || chunk.type === "reasoning-delta")) {
			this.emit({
				type: "message_delta",
				conversationId: conv.id,
				seq: ++conv.deltaSeq,
				messageId: conv.streaming.id,
				usage: null,
				assistantMessageEvent: {
					type: chunk.type === "text-delta" ? "text_delta" : "thinking_delta",
					contentIndex: chunk.index as number,
					delta: chunk.text as string,
				},
			});
		}
	}

	private applyUsage(conv: DshConversation, usage: unknown): void {
		const next = normalizeDshUsage(usage);
		if (!next) return;
		conv.tokens = next;
		conv.usageSeen = true;
	}

	private handleSessionStatus(params: { sessionId: string; status: string }): void {
		const conv = this.findConv(params.sessionId);
		if (!conv) return;
		const was = conv.isStreaming;
		conv.isStreaming = params.status === "running";
		if (conv.isStreaming) startTurnTiming(conv);
		else finishTurnTiming(conv);
		conv.lastEventAt = Date.now();
		if (was && !conv.isStreaming) {
			conv.streaming = null;
			this.refreshConversationTitle(conv);
			this.scheduleSessionsRefresh();
			this.emitConversations();
		}
		this.flushSnapshot();
	}

	private appendMessage(conv: DshConversation, msg: UiMessage): void {
		if (!msg || conv.messageIds.has(msg.id)) return;
		conv.messageIds.add(msg.id);
		conv.messages.push(msg);
	}

	private refreshConversationTitle(conv: DshConversation): void {
		if (!DshClientSession.isDefaultTitle(conv.title)) return;
		const t = conv.messages
			.find((m) => m.role === "user")
			?.content?.map((c) => ("text" in c ? c.text : ""))
			.join(" ")
			.trim();
		if (t) {
			conv.title = t.length > 30 ? `${t.slice(0, 30)}…` : t;
			this.emitConversations();
		}
	}

	flushSnapshot(forceFull = false): void {
		if (this.disposed) return;
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		this.emitSnapshotNow(forceFull);
	}

	private scheduleSnapshot(): void {
		if (this.snapshotTimer || this.disposed) return;
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = null;
			if (!this.disposed) this.emitSnapshotNow();
		}, SNAPSHOT_INTERVAL_MS);
	}

	private emitSnapshotNow(forceFull = false): void {
		if (this.disposed) return;
		const conv = this.conv;
		const cur = [...conv.messages];
		const prev = this.emittedMessages;
		const rev = ++this.snapRev;
		let incremental = !forceFull && prev !== null && this.emittedRev > 0 && prev.length <= cur.length;
		if (incremental && prev) {
			for (let i = 0; i < prev.length; i++) {
				if (prev[i] !== cur[i]) {
					incremental = false;
					break;
				}
			}
		}
		this.emittedMessages = cur;
		this.emittedRev = rev;
		if (incremental && prev) {
			this.emit({
				type: "snapshot_delta",
				conversationId: this.activeId,
				rev,
				baseRev: this.emittedRev - 1,
				appended: cur.slice(prev.length),
				state: this.buildLightState(rev),
			});
		} else {
			this.emit({
				type: "snapshot",
				state: { ...this.buildLightState(rev), messages: cur },
			});
		}
	}

	private guessSessionFile(conv: DshConversation): string | undefined {
		if (conv.sessionFile && existsSync(conv.sessionFile)) return conv.sessionFile;
		try {
			const files = findSessionFilesForCwd(this.sessionRoot, conv.cwd).filter(
				(f) => basename(dirname(f)) === conv.sessionId,
			);
			if (files.length > 0) {
				conv.sessionFile = files[0];
				return files[0];
			}
		} catch {}
		return undefined;
	}

	private buildLightState(rev: number): Omit<UiState, "messages" | "rev"> & { rev: number } {
		const conv = this.conv;
		const tokens = conv.tokens;
		const stats: UiState["stats"] = {
			totalMessages: conv.messages.length,
			tokens: {
				input: tokens.input,
				output: tokens.output,
				cacheRead: tokens.cacheRead,
				cacheWrite: tokens.cacheWrite,
				total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
			},
			cost: estimateCost(tokens),
			contextUsage: dshContextUsage(conv.usageSeen ? tokens : null, DSH_CONTEXT_WINDOW),
		};
		return {
			clientId: this.clientId,
			cwd: this.cwd,
			workspaceRoots: this.roots,
			homeDir: HOME_WIRE,
			desktopDir: DESKTOP_WIRE,
			sessionId: conv.sessionId,
			sessionFile: this.guessSessionFile(conv),
			conversationId: this.activeId,
			sandbox: this.sandboxes.getByCwd(this.cwd) ?? null,
			rev,
			streamingMessage: conv.streaming ? conv.streaming.toUiMessage(conv.lastEventAt, this.model, "deepseek") : null,
			isStreaming: conv.isStreaming,
			turnTiming: conv.turnTiming ?? null,
			draft: this.sessionDrafts.get(conv.sessionId) ?? null,
			model: {
				id: this.model,
				name: this.modelDisplayName || (DSH_MODELS.find((m) => m.id === this.model)?.name ?? this.model),
				provider: this.modelProvider || "deepseek",
				vision: this.modelVision,
			},
			thinkingLevel: this.thinkingLevel,
			availableThinkingLevels: ["high"],
			engineCapabilities: DEFAULT_DSH_CAPABILITIES,
			agentPreset: { id: conv.agentPreset, name: this.presetName(conv.agentPreset), locked: conv.presetLocked },
			permission: conv.permissionPreset ?? null,
			queue: { steering: conv.queue.steering, followUp: conv.queue.followUp },
			pendingQuestion: this.pendingQuestionForSnapshot(),
			actionSuggestions: this.markerSvc.getActionSuggestions(this.activeId) ?? null,
			tools: [],
			version: ++this.version,
			piConfigured: this.isDshConfigured(),
			piAgentInstalled: true,
			stats,
		};
	}

	getCapabilities(): AgentEngineCapabilities {
		return DEFAULT_DSH_CAPABILITIES;
	}

	attachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.add(send);
		for (const msg of this.pendingNotices) send(msg);
		this.pendingNotices = [];
		this.emitConversations();
		this.emitGoalStatus();
		this.pushSettings();
		this.pushDefaultModel();
		this.pushAgentPresets();
		this.pushPermission();
		void this.refreshPermissionOptions().catch(() => {});
		void this.refreshActivePermission().catch(() => {});
		this.bg.push();
		this.pushTerminals();
	}

	detachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.delete(send);
		if (this.sinks.size === 0) this.files.unwatchDir();
	}

	private emit(msg: ServerMessage): void {
		if (this.disposed) return;
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const sink of [...this.sinks]) sink(msg);
	}

	emitNotice(level: "info" | "warning" | "error", text: string, textEn?: string): void {
		this.emit({ type: "notice", level, text, textEn });
	}

	private pushTerminals(): void {
		const userList = this.userTerminals ? this.userTerminals.list() : [];
		const activeConv = this.convs.get(this.activeId) ?? this.conv;
		const convList = activeConv ? activeConv.terminals.list() : [];
		const allTerminals = [...userList, ...convList];
		this.emit({ type: "terminal_list", conversationId: activeConv?.id, terminals: allTerminals });
		if (this.userTerminals) {
			for (const output of this.userTerminals.replay()) {
				this.emit({
					type: "terminal_output",
					conversationId: activeConv?.id,
					ownerKind: "client",
					terminalId: output.terminalId,
					data: output.data,
					reset: true,
				});
			}
		}
		if (activeConv) {
			for (const output of activeConv.terminals.replay()) {
				this.emit({
					type: "terminal_output",
					conversationId: activeConv.id,
					ownerKind: "conversation",
					terminalId: output.terminalId,
					data: output.data,
					reset: true,
				});
			}
		}
	}

	getUserTerminalManager(): TerminalManager {
		return this.userTerminals;
	}

	findTerminalManager(
		terminalId: string,
		conversationId?: string,
		ownerKind?: "client" | "conversation",
	): TerminalManager | undefined {
		if (ownerKind === "client") return this.userTerminals?.has(terminalId) ? this.userTerminals : undefined;
		if (ownerKind === "conversation") {
			const manager = this.getTerminalManager(conversationId);
			return manager?.has(terminalId) ? manager : undefined;
		}
		if (this.userTerminals?.has(terminalId)) return this.userTerminals;
		if (conversationId) {
			const convTm = this.convs.get(conversationId)?.terminals;
			if (convTm?.has(terminalId)) return convTm;
		}
		if (this.conv?.terminals.has(terminalId)) return this.conv.terminals;
		for (const conv of this.convs.values()) {
			if (conv.terminals.has(terminalId)) return conv.terminals;
		}
		return this.getTerminalManager(conversationId);
	}

	getTerminalManager(conversationId?: string): TerminalManager | undefined {
		return (conversationId ? this.convs.get(conversationId) : this.conv)?.terminals;
	}

	getTerminalCwd(conversationId?: string): string {
		return (conversationId ? this.convs.get(conversationId) : this.conv)?.cwd ?? this.cwd;
	}

	activeConversations(): number {
		let n = 0;
		for (const conv of this.convs.values()) if (conv.isStreaming) n++;
		return n;
	}

	pendingMessages(): number {
		return 0;
	}

	sinkCount(): number {
		return this.sinks.size;
	}

	findConversationBySessionId(sessionId: string): DshConversation | undefined {
		for (const conv of this.convs.values()) if (conv.sessionId === sessionId) return conv;
		return undefined;
	}

	streamingInCwd(cwd: string): { convId: string; title: string; sessionId: string }[] {
		const out: { convId: string; title: string; sessionId: string }[] = [];
		for (const conv of this.convs.values()) {
			if (conv.cwd !== cwd || !conv.isStreaming) continue;
			out.push({ convId: conv.id, title: conv.title, sessionId: conv.sessionId });
		}
		return out;
	}

	streamingSummariesAll(): { title: string; cwd: string; isStreaming: boolean }[] {
		const out: { title: string; cwd: string; isStreaming: boolean }[] = [];
		for (const conv of this.convs.values()) {
			if (!conv.isStreaming) continue;
			out.push({ title: conv.title, cwd: conv.cwd, isStreaming: true });
		}
		return out;
	}

	refreshExternalRunning(): void {
		if (this.disposed) return;
		this.emitConversations();
	}

	private shownInRunningList(conv: DshConversation): boolean {
		return conv.id === this.activeId && conv.messages.length > 0;
	}

	private emitConversations(): void {
		const list: ConversationSummary[] = [];
		for (const conv of this.convs.values()) {
			if (!conv.listed && !this.shownInRunningList(conv)) continue;
			const sf = this.guessSessionFile(conv);
			const isPinned = Boolean(
				this.stateStore?.isSessionPinned(this.cwd, sf || "") ||
				this.stateStore?.isSessionPinned(this.cwd, conv.sessionId),
			);
			list.push({
				id: conv.id,
				sessionId: conv.sessionId,
				...(sf ? { sessionFile: sf } : {}),
				title: conv.title,
				cwd: conv.cwd,
				messageCount: conv.messages.length,
				isStreaming: conv.isStreaming,
				isSubagent: false,
				pinned: isPinned,
				...(conv.terminals.countUserBlockingLive() > 0 ? { hasUserTerminals: true as const } : {}),
				agentPreset: conv.agentPreset,
				presetLocked: conv.presetLocked,
			});
		}
		const sig = JSON.stringify(
			[...this.convs.values()]
				.filter((c) => c.isStreaming)
				.map((c) => c.id)
				.sort(),
		);
		if (sig !== this.lastRunningSig) {
			this.lastRunningSig = sig;
			this.onRunningChanged?.();
		}
		const elsewhere = this.listExternalRunning?.() ?? [];
		this.emit({
			type: "conversations",
			conversations: list,
			activeId: this.activeId,
			...(elsewhere.length > 0 ? { elsewhere } : {}),
		});
	}

	private shouldRetainDshConversation(conv: DshConversation): boolean {
		if (conv.isStreaming) return true;
		if (conv.terminals.countBlockingLive() > 0) return true;
		if (conv.promptedSinceActive) return true;
		if (this.settings?.retainFinishedConversations && (conv.messages.length > 0 || conv.listed)) return true;
		return false;
	}

	async newChat(preset?: string, _ephemeral?: boolean, onReady?: (id: string) => void): Promise<boolean> {
		if (this.switchingWorkspace) return false;
		if (this.quiesceBlocked()) return false;
		const active = this.conv;
		if (active.messages.length === 0 && active.terminals.list().length === 0) {
			if (preset) await this.selectAgentPreset(preset);
			else {
				this.pushSettings();
				this.flushSnapshot();
			}
			onReady?.(active.id);
			return true;
		}
		for (const conv of this.convs.values()) {
			if (conv.id === this.activeId) continue;
			if (conv.messages.length === 0) {
				this.switchConversation(conv.id);
				if (preset) await this.selectAgentPreset(preset);
				else this.flushSnapshot();
				onReady?.(conv.id);
				return true;
			}
		}
		const openInProject = [...this.convs.values()].filter((c) => c.cwd === this.cwd).length;
		const maxOpenConversations = getMaxOpenConversations();
		if (openInProject >= maxOpenConversations) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `当前项目运行的对话已达上限（${maxOpenConversations} 个）`,
				textEn: `This project already has the max open conversations (${maxOpenConversations}).`,
			});
			return false;
		}
		const prevModel = this.model;
		active.listed = this.shouldRetainDshConversation(active);
		const conv = this.addConversation(`chat-${randomUUID().slice(0, 12)}`, this.cwd, false, preset);
		this.activeId = conv.id;
		this.model = prevModel;
		this.emitConversations();
		this.emitGoalStatus();
		this.pushTerminals();
		this.pushSettings();
		this.flushSnapshot();
		void this.refreshActivePermission().catch(() => {});
		onReady?.(conv.id);
		return true;
	}

	async switchConversation(id: string): Promise<void> {
		const targetCwd = this.convs.get(id)?.cwd ?? this.cwd;
		assertEngineWorkspaceSupported(this.sandboxes, targetCwd, "dsh");
		if (this.switchingWorkspace || !this.convs.has(id) || id === this.activeId) return;
		const target = this.convs.get(id)!;
		if (target.cwd !== this.cwd) {
			await this.setCwd(target.cwd);
			if (this.cwd !== target.cwd) return;
		}
		const prev = this.conv;
		prev.listed = this.shouldRetainDshConversation(prev);
		this.activeId = id;
		this.emitConversations();
		this.emitGoalStatus();
		this.pushTerminals();
		this.pushSettings();
		this.flushSnapshot(true);
		void this.refreshActivePermission().catch(() => {});
	}

	private removeConversation(id: string): void {
		const conv = this.convs.get(id);
		if (!conv || id === this.activeId) return;
		this.convs.delete(id);
		conv.terminals.killAll();
	}

	async prompt(text: string, attachments?: PromptAttachment[], queue = false): Promise<void> {
		if (this.switchingWorkspace) return;
		let conv = this.conv;
		const trimmedText = (text ?? "").trim();
		const hasAttachments = Boolean(attachments && attachments.length > 0);
		if (!trimmedText && !hasAttachments) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "发送已忽略：提示词为空且未附带文件或上下文引用。",
				textEn: "Prompt ignored: text is empty and no attachments were provided.",
			});
			this.flushSnapshot();
			return;
		}

		const parsed = parseSlash(text);
		if (parsed && !attachments?.length) {
			const handled = await this.execSlash(parsed.name, parsed.args);
			if (handled) {
				this.flushSnapshot();
				return;
			}
		}
		if (this.conv !== conv || this.switchingWorkspace) return;
		this.markerSvc.clearActions(conv.id);
		const fileOwner = this.findSessionOwnerById?.(conv.sessionId);
		if (fileOwner && fileOwner.isStreaming) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `发送已拦截：该对话正在另一处运行中（「${fileOwner.title}」）。请等它结束后再发，或回到原窗口继续 —— 否则两个 agent 会同时写同一份记录，其中一支事后不可见。`,
				textEn: `Prompt blocked: this conversation is running in another window ("${fileOwner.title}"). Wait for it to finish or continue there — two writers on one transcript would leave one run permanently invisible.`,
			});
			this.flushSnapshot();
			return;
		}
		let sysPrefix = "";
		if (!conv.isStreaming && this.settings.parallelReminderEnabled !== false) {
			const localTitles = [...this.convs.values()]
				.filter((c) => c.id !== conv.id && c.cwd === conv.cwd && c.isStreaming)
				.map((c) => `本窗口「${c.title}」`);
			const externalRunners = (this.listProjectRunners?.(conv.cwd) ?? []).filter(
				(r) => r.sessionFile === undefined || basename(dirname(resolve(r.sessionFile))) !== conv.sessionId,
			);
			const runnerTitles = [...localTitles, ...externalRunners.map((r) => `另一处「${r.title}」`)];
			if (runnerTitles.length > 0) {
				const shown = runnerTitles.slice(0, 3).join("、");
				const more = runnerTitles.length > 3 ? `等 ${runnerTitles.length} 处` : "";
				this.emit({
					type: "notice",
					level: "info",
					text: `同项目并行提醒：${shown}${more}正在同一项目运行。你可以继续（适合改不同文件），改动同一文件前请先确认；拿不准就等它跑完。`,
					textEn: `Parallel-work notice: ${shown}${more ? " and more" : ""} running in the same project. You may continue (fine for different files); confirm before touching the same files, or wait for it to finish when unsure.`,
				});
				sysPrefix =
					`(System reminder: ${runnerTitles.length} other run(s) [${runnerTitles.join("; ").slice(0, 600)}] are currently running in the same project directory. ` +
					`You may work in parallel on different files, but before reading/writing files or running commands, assess the conflict probability with the other run(s). ` +
					`If a conflict is likely or you are unsure, use ask_user_question to let the user choose: continue in parallel / wait / watch read-only.)\n` +
					`（系统提醒：同一项目另有 ${runnerTitles.length} 处运行（${shown}${more}）。改不同文件可并行；读写文件或跑命令前先评估冲突概率，拿不准就用 ask_user_question 让用户选择：并行 / 等它跑完 / 只读围观。）\n\n`;
				if (externalRunners.length > 0) {
					this.notifyExternalClients?.({
						type: "notice",
						level: "info",
						text: `同项目并行提醒：另一处在「${conv.cwd}」开始了对话（「${conv.title}」），可能与你正在跑的任务并行改动同一项目。`,
						textEn: `Parallel-work notice: another window started a conversation ("${conv.title}") in "${conv.cwd}", possibly editing the same project in parallel with your running task.`,
					});
				}
			}
		}
		if (conv.fromDisk) {
			const runtime = this.runtime;
			const sessionId = conv.sessionId;
			const generation = this.workspaceGeneration;
			await runtime.start();
			if (
				conv.sessionId !== sessionId ||
				this.convs.get(conv.id) !== conv ||
				this.disposed ||
				this.switchingWorkspace ||
				generation !== this.workspaceGeneration ||
				this.runtime !== runtime
			)
				return;
			await (runtime as unknown as { _request(method: string, params: unknown): Promise<unknown> })._request(
				"session/resume",
				{ sessionId },
			);
			if (
				conv.sessionId !== sessionId ||
				this.convs.get(conv.id) !== conv ||
				this.disposed ||
				this.switchingWorkspace ||
				generation !== this.workspaceGeneration ||
				this.runtime !== runtime
			)
				return;
			conv.fromDisk = false;
		}
		if (DshClientSession.isDefaultTitle(conv.title) && text.trim()) {
			const trimmed = text.trim().replace(/\s+/g, " ");
			conv.title = trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed;
			this.emitConversations();
		}
		await this.promptConv(conv, text, attachments, queue, sysPrefix);
	}

	removeQueued(kind: "steer" | "followUp", text: string, index?: number, _id?: string): void {
		const conv = this.conv;
		const arr = kind === "steer" ? conv.queue.steering : conv.queue.followUp;
		const next = removeQueuedByIndexOrText(arr, text, index);
		if (next.length !== arr.length) {
			arr.splice(0, arr.length, ...next);
		}
		this.flushSnapshot();
	}

	private quiesceBlocked(): boolean {
		if (!this.isQuiesced?.()) return false;
		this.emit({
			type: "notice",
			level: "error",
			text: "服务器正在排空存量工作（quiesce），已拒绝新的对话/消息/编辑。存量运行会继续跑完；用 pi-web-ui server unquiesce 可恢复。",
			textEn:
				"Server is draining (quiesce); new chats/messages/edits rejected. Existing runs continue; resume with pi-web-ui server unquiesce.",
		});
		this.flushSnapshot();
		return true;
	}

	private async hydrateImageBlocks(
		conv: DshConversation,
		msg: UiMessage,
		refs: { attachmentId: string; mediaType: string }[],
	): Promise<void> {
		if (this.disposed) return;
		try {
			const dataUrls: string[] = [];
			for (const ref of refs) {
				const r = await this.runtime.attachmentRead(ref);
				dataUrls.push(`data:${r.mediaType ?? "image/png"};base64,${r.data}`);
			}
			if (this.disposed) return;
			const target = conv.messages.find((m) => m.id === msg.id);
			if (!target) return;
			let i = 0;
			for (const block of target.content) {
				if (block.type === "image" && "dataUrl" in block && !block.dataUrl && i < dataUrls.length) {
					(block as { dataUrl?: string }).dataUrl = dataUrls[i++]!;
				}
			}
			if (i > 0) this.flushSnapshot();
		} catch {}
	}

	private async promptConv(
		conv: DshConversation,
		text: string,
		attachments?: PromptAttachment[],
		_queue = false,
		sysPrefix = "",
	): Promise<void> {
		if (this.switchingWorkspace) return;
		const generation = this.workspaceGeneration;
		let optimisticId: string | undefined;
		let followUpAdded = false;
		try {
			assertEngineWorkspaceSupported(this.sandboxes, conv.cwd, "dsh");
			if (this.quiesceBlocked()) return;
			startTurnTiming(conv);
			conv.promptedSinceActive = true;
			conv.lastEventAt = Date.now();
			if (conv.assignedGen !== this.runtimeGen) {
				try {
					await this.runtime.assignPreset(conv.sessionId, conv.agentPreset);
					conv.assignedGen = this.runtimeGen;
				} catch {}
			}
			if (this.switchingWorkspace || generation !== this.workspaceGeneration) return;
			await this.ensurePermissionDefault(conv);
			if (this.switchingWorkspace || generation !== this.workspaceGeneration) return;
			this.flushSnapshot();
			const allSkills = [
				...this.skillsCache.map((s) => ({
					name: s.name,
					description: s.description,
					filePath: "",
					dirPath: "",
				})),
				...discoverDiskSkills({ cwd: this.cwd, agentDir: this.agentDir }),
			];
			const scanResult = scanAtMentions(text, this.cwd, allSkills, attachments ?? []);
			const effectiveAttachments = [...(attachments ?? []), ...scanResult.detectedAttachments];
			const promptText = formatPromptWithSkills(text, scanResult.detectedSkills);

			const blocks = await this.buildContentBlocks(
				sysPrefix ? `${sysPrefix}${promptText}` : promptText,
				effectiveAttachments,
			);
			if (this.switchingWorkspace || generation !== this.workspaceGeneration || conv.cwd !== this.cwd) return;
			const optimistic: UiMessage = {
				id: `u-pending-${Date.now()}-${conv.deltaSeq++}`,
				role: "user",
				content: [
					{ type: "text", text },
					...(Array.isArray(attachments)
						? attachments.filter((a) => a.imageData).map((a) => ({ type: "image" as const, dataUrl: a.imageData! }))
						: []),
				],
				timestamp: Date.now(),
				details: {
					quotes: (attachments ?? [])
						.filter((a) => a.mode === "quote")
						.map((a) => readTextQuote(a.quote))
						.filter((q) => q !== null),
				},
			};
			optimisticId = optimistic.id;
			this.appendMessage(conv, optimistic);
			if (conv.isStreaming) {
				conv.queue.followUp.push(text);
				followUpAdded = true;
				this.flushSnapshot();
				await this.runtime.prompt(conv.sessionId, blocks);
				const qIdx = conv.queue.followUp.indexOf(text);
				if (qIdx !== -1) conv.queue.followUp.splice(qIdx, 1);
				followUpAdded = false;
			} else {
				this.flushSnapshot();
				await this.runtime.prompt(conv.sessionId, blocks);
			}
			if (!conv.presetLocked) {
				conv.presetLocked = true;
				this.emitConversations();
			}
		} catch (err) {
			if (!conv.isStreaming) finishTurnTiming(conv);
			if (optimisticId) {
				const optIdx = conv.messages.findIndex((m) => m.id === optimisticId);
				if (optIdx !== -1) {
					conv.messages.splice(optIdx, 1);
					conv.messageIds.delete(optimisticId);
				}
			}
			if (followUpAdded) {
				const qIdx = conv.queue.followUp.indexOf(text);
				if (qIdx !== -1) conv.queue.followUp.splice(qIdx, 1);
			}
			this.emit({
				type: "notice",
				level: "error",
				text: `提示发送失败：${(err as Error).message}`,
				textEn: `Failed to send prompt: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	private histToContext(conv: DshConversation): string {
		return conv.messages
			.map((m) => {
				const blocks = messageTextWithQuotes(m);
				return blocks ? `[${m.role === "assistant" ? "AI" : m.role}] ${blocks}` : "";
			})
			.filter(Boolean)
			.join("\n");
	}

	private forkConversation(prev: DshConversation): DshConversation {
		const fork = this.addConversation(`fork-${randomUUID().slice(0, 12)}`, this.cwd, false, prev.agentPreset);
		fork.title = prev.title;
		fork.messages = [...prev.messages];
		fork.messageIds = new Set(prev.messageIds);
		this.activeId = fork.id;
		const hadGoal = prev.goal.goal !== null && prev.goal.verdict === "pending";
		this.emitConversations();
		this.emit({
			type: "notice",
			level: "info",
			text: hadGoal
				? "已新建分支继续对话（DSH 引擎不支持原地续聊旧会话）；原目标已随旧会话存档，如需继续请重新设置目标"
				: "已新建分支继续对话（DSH 引擎不支持原地续聊旧会话）",
			textEn: hadGoal
				? "Started a branch to continue (DSH engine cannot resume an old session in place); the old goal was archived with it — set a new goal to continue"
				: "Started a branch to continue (DSH engine cannot resume an old session in place)",
		});
		return fork;
	}

	private forkAndReprompt(conv: DshConversation): void {
		if (this.disposed) return;
		let lastUser = "";
		for (let i = conv.messages.length - 1; i >= 0; i--) {
			const m = conv.messages[i]!;
			if (m.role === "user") {
				lastUser = messageTextWithQuotes(m).trim();
				if (lastUser) break;
			}
		}
		const hist = this.histToContext(conv);
		this.forkConversation(conv);
		const lang = this.getLang();
		const text = lastUser
			? hist.trim()
				? `${lastUser}\n\n${pick(lang, "（以下为原对话上下文，仅作参考）：", "(Previous conversation context below for reference only):", "dsh.prompt.context.short")}\n${hist}`
				: lastUser
			: pick(lang, "请继续", "Please continue", "dsh.prompt.continue");
		this.emit({
			type: "notice",
			level: "info",
			text: "已自动重发（原会话不可续聊）",
			textEn: "Auto-resent (the original session cannot be resumed)",
		});
		void this.prompt(text);
	}

	private static splitImageDataUrl(data: string): { mediaType: string; base64: string } {
		const m = /^data:([^;,]+);base64,([\s\S]*)$/u.exec(data);
		if (m && m[2]) return { mediaType: m[1] ?? "image/png", base64: m[2] };
		return { mediaType: "image/png", base64: data };
	}

	private async buildContentBlocks(text: string, attachments?: PromptAttachment[]): Promise<Record<string, unknown>[]> {
		const blocks: Record<string, unknown>[] = [{ type: "text", text }];
		const lang = this.getLang();
		if (!Array.isArray(attachments)) return blocks;
		for (const a of attachments) {
			if (a.mode === "quote") {
				const quote = readTextQuote(a.quote);
				if (quote) blocks.push({ type: "text", text: formatTextQuote(quote) });
				else
					this.emit({
						type: "notice",
						level: "warning",
						text: "引用内容无效，请重新选择文字",
						textEn: "Select the text again to add a quote.",
					});
				continue;
			}
			if (a.mode === "canvas") {
				blocks.push({ type: "text", text: formatUnavailableCanvasReference(a) });
				continue;
			}
			const resolved = a.path ? workspacePath(this.cwd, a.path) : null;
			if (a.imageData) {
				try {
					const { mediaType, base64 } = DshClientSession.splitImageDataUrl(a.imageData);
					const saved = await this.runtime.attachmentSave(mediaType, base64, a.name);
					blocks.push({ type: "image", attachment: saved.ref });
				} catch (err) {
					blocks.push({
						type: "text",
						text: pick(
							lang,
							`\n[图片附件: ${a.name ?? "image"}（保存失败 ${(err as Error).message}）]`,
							`\n[Image attachment: ${a.name ?? "image"} (save failed: ${(err as Error).message})]`,
							"dsh.attach.image.save.failed",
							{ 'a.name ?? "image"': a.name ?? "image", "(err as Error).message": (err as Error).message },
						),
					});
				}
			} else if (a.fileData) {
				try {
					const maxBytes = (this.stateStore.getSettingsSnapshot(this.clientId).chatUploadMaxMb ?? 20) * 1024 * 1024;
					if (a.fileData.length > Math.ceil(maxBytes / 3) * 4)
						throw new Error(`File too large (max ${maxBytes / 1024 / 1024} MB)`);
					const buffer = Buffer.from(a.fileData, "base64");
					if (buffer.length > maxBytes) throw new Error(`File too large (max ${maxBytes / 1024 / 1024} MB)`);
					const saved = saveUpload(this.clientId, a.name ?? "upload", buffer, this.dataDir);
					blocks.push({
						type: "text",
						text: pick(
							lang,
							`\n[上传文件: ${saved.abs}]`,
							`\n[Uploaded file: ${saved.abs}]`,
							"dsh.attach.upload.saved",
							{ "saved.abs": saved.abs },
						),
					});
				} catch (err) {
					blocks.push({
						type: "text",
						text: pick(
							lang,
							`\n[上传文件: ${a.name ?? "upload"}（落盘失败 ${(err as Error).message}）]`,
							`\n[Uploaded file: ${a.name ?? "upload"} (failed to save: ${(err as Error).message})]`,
							"dsh.attach.upload.save.failed",
							{ 'a.name ?? "upload"': a.name ?? "upload", "(err as Error).message": (err as Error).message },
						),
					});
				}
			} else if (resolved) {
				const refText =
					pick(lang, `\n[文件引用: ${resolved.rel}]`, `\n[File reference: ${resolved.rel}]`, "dsh.attach.file.ref", {
						"resolved.rel": resolved.rel,
					}) +
					(a.mode === "lines" && a.lines
						? pick(lang, `（第 ${a.lines.start}-${a.lines.end} 行）`, ` (lines ${a.lines.start}-${a.lines.end})`)
						: "");
				let isImage = false;
				try {
					const st = statSync(resolved.abs);
					isImage = st.isFile() && st.size > 0 && st.size <= 512 * 1024 && previewKind(resolved.abs) === "image";
				} catch {}
				if (isImage) {
					try {
						const buf = readFileSync(resolved.abs);
						const ext = (resolved.rel.match(/\.([a-z0-9]+)$/iu)?.[1] ?? "png").toLowerCase();
						const mediaType =
							ext === "jpg" || ext === "jpeg"
								? "image/jpeg"
								: ext === "webp"
									? "image/webp"
									: ext === "gif"
										? "image/gif"
										: "image/png";
						const saved = await this.runtime.attachmentSave(mediaType, buf.toString("base64"), resolved.rel);
						blocks.push({ type: "image", attachment: saved.ref });
					} catch {
						blocks.push({
							type: "text",
							text: pick(
								lang,
								`\n[图片附件: ${resolved.rel}]`,
								`\n[Image attachment: ${resolved.rel}]`,
								"dsh.attach.image.ref",
								{ "resolved.rel": resolved.rel },
							),
						});
					}
				} else {
					blocks.push({ type: "text", text: refText });
				}
			} else if (a.name) {
				blocks.push({
					type: "text",
					text: pick(lang, `\n[附件: ${a.name}]`, `\n[Attachment: ${a.name}]`, "dsh.attach.generic", { name: a.name }),
				});
			}
		}
		return blocks;
	}

	async abort(): Promise<void> {
		this.cancelBridgedTools();
		if (!this.runtime.alive) return;
		const conv = this.conv;
		finishTurnTiming(conv);
		conv.isStreaming = false;
		conv.streaming = null;
		this.emitConversations();
		if (conv.dsGoal || conv.goal.goal) {
			try {
				await this.runtime.goalClear(conv.sessionId);
			} catch {}
			conv.dsGoal = null;
			conv.goal.goal = null;
			conv.goal.conversationId = null;
			conv.goal.reviewing = false;
			conv.goal.verdict = "pending";
			conv.goal.feedback = undefined;
			conv.goal.status = "已手动停止，目标已中止";
			conv.goal.statusEn = "Stopped manually, goal aborted";
			this.emitGoalStatus();
		}
		this.emit({
			type: "notice",
			level: "info",
			text: "已停止（DSH 中止 = 重启运行时，进行中的其他对话也会停止）",
			textEn: "Stopped (DSH abort restarts the runtime; other running conversations stop too)",
		});
		try {
			await this.runtime.restart(this.model);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `中止后重启失败：${(err as Error).message}`,
				textEn: `Failed to restart after abort: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot(true);
	}

	async abortBash(): Promise<void> {
		this.emit({
			type: "notice",
			level: "info",
			text: "DSH 引擎暂不支持单独中止 bash（可整体停止对话）",
			textEn: "The DSH engine cannot stop bash alone (stop the whole conversation instead)",
		});
	}

	async retryLast(): Promise<void> {
		const conv = this.conv;
		try {
			if (this.quiesceBlocked()) return;
			if (conv.isStreaming) {
				this.emit({
					type: "notice",
					level: "info",
					text: "对话正在生成中，无需重试",
					textEn: "The conversation is still generating — no need to retry",
				});
				return;
			}
			let failed = false;
			for (let i = conv.messages.length - 1; i >= 0; i--) {
				const m = conv.messages[i]!;
				if (m.role !== "assistant") continue;
				failed = !!m.errorMessage;
				break;
			}
			if (!failed) {
				this.emit({
					type: "notice",
					level: "info",
					text: "没有可重试的失败：上一轮没有报错结束",
					textEn: "Nothing to retry: the last turn did not end with an error",
				});
				return;
			}
			let lastUser = "";
			for (let i = conv.messages.length - 1; i >= 0; i--) {
				const m = conv.messages[i]!;
				if (m.role !== "user") continue;
				lastUser = m.content
					.map((c) => ("text" in c ? (c.text as string) : ""))
					.join("")
					.trim();
				if (lastUser) break;
			}
			const lang = this.getLang();
			await this.prompt(lastUser || pick(lang, "请继续", "Please continue", "dsh.prompt.continue"));
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `手动重试失败：${(err as Error).message}`,
				textEn: `Manual retry failed: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	async listBgServers(): Promise<void> {
		await this.bg.listAndPush();
	}

	refreshBgTasks(): void {
		this.bg.push();
	}

	async killBackgroundServer(port?: number, taskId?: string): Promise<boolean> {
		if (taskId && this.pluginStopBgTask) {
			const ok = this.pluginStopBgTask(taskId);
			if (ok) this.bg.push();
			return ok;
		}
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

	setBackgroundKeep(port: number, keep: boolean): boolean {
		return this.bg.setKeep(port, keep);
	}

	async cleanBackgroundLeftovers(minutesOverride?: number): Promise<number[]> {
		const override = Number(minutesOverride);
		const policy = Number(this.settings.bgAutoCleanupMin ?? 0);
		const minutes = Number.isFinite(override) && override > 0 ? override : policy;
		const thresholdMs = (minutes > 0 ? minutes : BG_CLEANUP_FALLBACK_MIN) * 60_000;
		return this.bg.cleanStale(thresholdMs, { manual: true });
	}

	private sessionsTimer: ReturnType<typeof setTimeout> | null = null;

	private scheduleSessionsRefresh(): void {
		if (this.sessionsTimer) return;
		this.sessionsTimer = setTimeout(() => {
			this.sessionsTimer = null;
			if (this.disposed) return;
			this.emitConversations();
			void this.pushSessions();
		}, 800);
	}

	async refreshSessions(): Promise<void> {
		await this.pushSessions();
	}

	private async pushSessions(): Promise<void> {
		try {
			const files = findSessionFilesForCwd(this.sessionRoot, this.cwd);
			const summaries: SessionSummary[] = [];
			for (const file of files) {
				try {
					const sessionId = basename(dirname(file));
					if (sessionId.startsWith("review-")) continue;
					const { events } = readSessionLog(file);
					const count = events.filter(
						(e) =>
							(e.type === "user/message" && !isDshInternalUserMessage(e.data as Record<string, unknown>)) ||
							e.type === "assistant/message" ||
							e.type === "tool/result",
					).length;
					if (count === 0) continue;
					const isPinned = Boolean(
						this.stateStore?.isSessionPinned(this.cwd, file) || this.stateStore?.isSessionPinned(this.cwd, sessionId),
					);
					const storedTitle =
						this.stateStore?.getSessionTitle(this.cwd, file) ?? this.stateStore?.getSessionTitle(this.cwd, sessionId);
					const explicitTitle =
						storedTitle ??
						sessionLogTitle(events) ??
						[...this.convs.values()].find((c) => c.sessionId === sessionId && !DshClientSession.isDefaultTitle(c.title))
							?.title;
					const firstMsg = firstUserText(events, this.getLang());
					const displayName = this.resolveSessionDisplayName(sessionId, explicitTitle, firstMsg);

					summaries.push({
						path: file,
						sessionId,
						cwd: this.cwd,
						name: explicitTitle,
						displayName,
						firstMessage: firstMsg,
						messageCount: count,
						modified: statSync(file).mtimeMs,
						source: "web",
						pinned: isPinned,
					});
				} catch {}
			}
			this.emit({ type: "sessions", sessions: summaries });
		} catch {
			this.emit({ type: "sessions", sessions: [] });
		}
	}

	resolveSessionDisplayName(sessionId: string, explicitTitle?: string, firstMsg?: string): string {
		const storedTitle = this.stateStore?.getSessionTitle(this.cwd, sessionId);
		if (storedTitle && !DshClientSession.isDefaultTitle(storedTitle)) {
			return storedTitle;
		}
		if (explicitTitle && !DshClientSession.isDefaultTitle(explicitTitle)) {
			return explicitTitle;
		}
		if (firstMsg && !DshClientSession.isDefaultTitle(firstMsg)) {
			return firstMsg;
		}
		return this.defaultTitle();
	}

	async pinSession(path: string, pinned: boolean): Promise<void> {
		const target = path.trim() || this.conv.sessionFile || this.conv.sessionId;
		if (this.stateStore && target) {
			this.stateStore.setSessionPinned(this.cwd, target, pinned);
		}
		this.emitConversations();
		void this.pushSessions();
	}

	async setConversationPinned(id: string, pinned: boolean): Promise<void> {
		const conv = this.convs.get(id);
		if (conv) {
			const key = conv.sessionFile || conv.sessionId;
			if (this.stateStore && key) {
				this.stateStore.setSessionPinned(this.cwd, key, pinned);
			}
			this.emitConversations();
			void this.pushSessions();
		}
	}

	saveDraft(sessionId: string, text: string, ts: number): void {
		if (!text) {
			this.sessionDrafts.delete(sessionId);
		} else {
			this.sessionDrafts.set(sessionId, { text, ts: ts || Date.now() });
		}
	}

	async renameSession(path: string, name: string): Promise<void> {
		const trimmed = (name ?? "").trim();
		if (!trimmed) return;
		const absPath = path.trim() ? resolve(path.trim()) : "";
		const sid = absPath ? basename(dirname(absPath)) : "";
		for (const conv of this.convs.values()) {
			if (conv.sessionId === sid || conv.sessionFile === absPath || conv.id === path.trim()) {
				conv.title = trimmed;
			}
		}
		if (this.stateStore) {
			if (absPath) this.stateStore.saveSessionTitle(this.cwd, absPath, trimmed);
			if (sid) this.stateStore.saveSessionTitle(this.cwd, sid, trimmed);
		}
		this.emitConversations();
		this.flushSnapshot();
		await this.pushSessions();
		this.emit({
			type: "notice",
			level: "info",
			text: `已重命名会话为「${trimmed}」`,
			textEn: `Renamed session to "${trimmed}"`,
		});
	}

	getToolPrompt(name: string): void {
		this.emit({
			type: "tool_prompt",
			name,
			found: false,
			unsupported: true,
		});
	}

	getCompactedMessages(compactionMessageId: string, conversationId?: string): void {
		const conv = conversationId ? this.convs.get(conversationId) : this.conv;
		const msg = conv?.messages.find((m) => m.id === compactionMessageId);
		const compacted = (msg?.details as { compactedMessages?: UiMessage[] } | undefined)?.compactedMessages ?? [];
		this.emit({
			type: "compacted_messages_result",
			compactionMessageId,
			conversationId: conv?.id ?? this.activeId,
			messages: compacted,
		});
	}

	async renameConversation(id: string, name: string): Promise<void> {
		const trimmed = (name ?? "").trim();
		if (!trimmed) return;
		const conv = this.convs.get(id);
		if (!conv) return;
		conv.title = trimmed;
		const key = conv.sessionFile || conv.sessionId;
		if (this.stateStore && key) {
			this.stateStore.saveSessionTitle(this.cwd, key, trimmed);
			if (conv.sessionId && conv.sessionFile) {
				this.stateStore.saveSessionTitle(this.cwd, conv.sessionId, trimmed);
			}
		}
		this.emitConversations();
		this.flushSnapshot();
		await this.pushSessions();
	}

	async deleteSession(path: string): Promise<void> {
		try {
			const { rmSync } = await import("node:fs");
			const abs = resolve(path);
			if (!abs.startsWith(this.sessionRoot + sep)) {
				this.emit({
					type: "notice",
					level: "error",
					text: "拒绝删除会话目录之外的路径",
					textEn: "Refusing to delete a path outside the session directory",
				});
				return;
			}
			rmSync(abs, { recursive: true, force: true });
			await this.pushSessions();
			this.emit({ type: "notice", level: "info", text: "会话已删除", textEn: "Session deleted" });
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `删除失败：${(err as Error).message}`,
				textEn: `Delete failed: ${(err as Error).message}`,
			});
		}
	}

	async dismissConversation(id: string, _withFinishedSubagents?: boolean, force?: boolean): Promise<void> {
		const conv = this.convs.get(id);
		if (!conv) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "该对话不存在或已关闭",
				textEn: "This conversation does not exist or is already closed",
			});
			return;
		}
		if (id === this.activeId && !force) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "当前对话不能直接移出，请先切换到其他对话",
				textEn: "The active conversation cannot be removed directly — switch to another conversation first",
			});
			return;
		}
		if (!conv.listed && !this.shownInRunningList(conv)) {
			this.emitConversations();
			return;
		}
		if (conv.isStreaming) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `对话「${conv.title}」仍在运行中，请先等待结束或停止后再移出`,
				textEn: `Conversation "${conv.title}" is still running — wait for it to finish or press Stop before removing`,
			});
			return;
		}
		if (conv.terminals.countUserBlockingLive() > 0 && !force) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `对话「${conv.title}」还有未关闭的终端，请先关闭终端或右键选择「强行关闭」后再移出`,
				textEn: `Conversation "${conv.title}" still has open terminals — close them or right-click to force-dismiss`,
			});
			return;
		}
		if (id === this.activeId) {
			const other = [...this.convs.values()].find((c) => c.id !== id);
			if (other) await this.switchConversation(other.id);
			else await this.newChat();
			if (id === this.activeId) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `当前对话「${conv.title}」暂时无法移出（无法创建接替对话）`,
					textEn: `Cannot dismiss the active conversation "${conv.title}" right now (no replacement chat available)`,
				});
				return;
			}
		}
		this.removeConversation(id);
		this.emitConversations();
		this.flushSnapshot();
	}

	async dismissFinishedSubagents(_parentId?: string): Promise<void> {
		this.emit({
			type: "notice",
			level: "info",
			text: "没有可关闭的已结束子代理",
			textEn: "No finished subagents to dismiss",
		});
	}

	async switchSession(path: string, wantSessionId?: string): Promise<void> {
		assertEngineWorkspaceSupported(this.sandboxes, this.cwd, "dsh");
		try {
			const resolvedPath = path.trim() ? resolve(path.trim()) : "";
			const explicitSid = wantSessionId?.trim() ?? "";
			const sessionId = explicitSid || (resolvedPath ? basename(dirname(resolvedPath)) : "");
			for (const conv of this.convs.values()) {
				if (conv.sessionId === sessionId || conv.id === sessionId) {
					await this.switchConversation(conv.id);
					this.emit({
						type: "transition_progress",
						kind: "session",
						target: path,
						phase: "done",
						progress: 100,
						text: "会话加载完成",
						textEn: "Session loaded",
					});
					return;
				}
			}
			if (!resolvedPath && explicitSid) {
				const candidateFile = join(this.sessionRoot, explicitSid, "session.jsonl");
				if (!existsSync(candidateFile)) {
					this.emit({
						type: "notice",
						level: "warning",
						text: `未找到会话：${explicitSid}`,
						textEn: `Session not found: ${explicitSid}`,
					});
					this.flushSnapshot(true);
					return;
				}
			}
			const owner = this.findSessionOwnerById?.(sessionId);
			if (owner && owner.isStreaming) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `该对话正在另一处运行中（「${owner.title}」），为避免两个 agent 同时写同一份记录，已停止打开。请等它结束后再试，或回到原窗口继续。`,
					textEn: `This conversation is running in another window ("${owner.title}"). Opening it here would create a second writer for the same transcript, so it was blocked. Wait for it to finish, or continue in the original window.`,
				});
				this.flushSnapshot(true);
				return;
			}
			if (owner) {
				if (owner.connected) {
					this.emit({
						type: "notice",
						level: "info",
						text: `提醒：该对话在另一处也开着（「${owner.title}」，当前空闲）。请只留一处发送消息，否则两边轮流发送会让历史分叉、其中一支事后不可见。`,
						textEn: `Note: this conversation is also open in another window ("${owner.title}", currently idle). Send new messages from only one place — alternating between two writers forks the history and hides one branch.`,
					});
				}
			}
			const prev = this.conv;
			prev.listed = this.shouldRetainDshConversation(prev);
			const conv = this.addConversation(sessionId, this.cwd, true, undefined, resolvedPath || undefined);
			conv.fromDisk = true;
			if (resolvedPath) conv.sessionFile = resolvedPath;
			this.activeId = conv.id;
			this.emitConversations();
			this.pushTerminals();
			this.pushSettings();
			this.flushSnapshot(true);
			this.emit({
				type: "transition_progress",
				kind: "session",
				target: path,
				phase: "done",
				progress: 100,
				text: "会话加载完成",
				textEn: "Session loaded",
			});
		} catch (err) {
			this.emit({
				type: "transition_progress",
				kind: "session",
				target: path,
				phase: "error",
				progress: 100,
				text: `切换会话失败：${(err as Error).message}`,
				textEn: `Failed to switch session: ${(err as Error).message}`,
			});
			this.emit({
				type: "notice",
				level: "error",
				text: `切换会话失败：${(err as Error).message}`,
				textEn: `Failed to switch session: ${(err as Error).message}`,
			});
		}
	}

	private userPatchDir(): string {
		return join(this.dataDir, "dsh-patches");
	}

	async listDshPatches(): Promise<void> {
		const dir = this.userPatchDir();
		const files: DshPatchFileInfo[] = [];
		try {
			const { readdirSync } = await import("node:fs");
			for (const name of readdirSync(dir)) {
				if (name.startsWith(".")) continue;
				const isYaml = /\.ya?ml$/iu.test(name);
				const isDisabledYaml = /\.ya?ml\.disabled$/iu.test(name);
				if (!isYaml && !isDisabledYaml) continue;
				try {
					const st = statSync(join(dir, name));
					if (st.isFile()) {
						files.push({
							name,
							path: join(dir, name),
							size: st.size,
							mtimeMs: st.mtimeMs,
							disabled: isDisabledYaml,
						});
					}
				} catch {}
			}
		} catch {}
		files.sort((a, b) => a.name.localeCompare(b.name));
		this.emit({ type: "dsh_patches", patchDir: dir, files });
	}

	async rescanDshPatches(): Promise<void> {
		try {
			if (this.runtime.alive) {
				await this.runtime.restart(this.model);
			}
			this.emit({
				type: "notice",
				level: "info",
				text: "已重扫用户 patch 并重启运行时",
				textEn: "Rescanned user patches and restarted the runtime",
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `重扫用户 patch 失败：${(err as Error).message}`,
				textEn: `Failed to rescan user patches: ${(err as Error).message}`,
			});
		}
		await this.listDshPatches();
	}

	async installDshPatch(rawSpec: string, rawId?: string): Promise<void> {
		const spec = rawSpec.trim().replace(/^['"]|['"]$/g, "");
		if (!spec) {
			this.emit({
				type: "notice",
				level: "error",
				text: "补丁包名或路径不能为空",
				textEn: "Patch package name or path cannot be empty",
			});
			return;
		}

		let id = (rawId ?? "").trim();
		if (!id) {
			const base = basename(spec.replace(/[\\/]+$/, ""));
			id = base.replace(/^dsh-plugin-|^dsh-/, "").replace(/[^a-zA-Z0-9_-]+/g, "-");
		}
		id = id.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || `patch-${Date.now().toString(36)}`;

		const dir = this.userPatchDir();
		mkdirSync(dir, { recursive: true });

		const normalizedSpec = spec.replace(/\\/g, "/");
		const escapedName = normalizedSpec.replace(/'/g, "''");

		const yamlContent = `# DSH user patch generated by pi-web-ui\n- insert:\n    - id: ${id}\n      name: '${escapedName}'\n      config: {}\n`;
		const targetFile = join(dir, `${id}.yml`);
		const disabledFile = join(dir, `${id}.yml.disabled`);

		try {
			if (existsSync(disabledFile)) {
				rmSync(disabledFile, { force: true });
			}
			writeFileSync(targetFile, yamlContent, "utf8");
			this.emit({
				type: "notice",
				level: "info",
				text: `已添加补丁 ${id}，正在重启 DSH 运行时...`,
				textEn: `Added patch ${id}, restarting DSH runtime...`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `写入补丁失败：${(err as Error).message}`,
				textEn: `Failed to write patch: ${(err as Error).message}`,
			});
			return;
		}

		await this.rescanDshPatches();
	}

	async toggleDshPatch(name: string, enabled: boolean): Promise<void> {
		const safeName = basename(name);
		if (!safeName || safeName !== name) {
			return;
		}

		const dir = this.userPatchDir();
		const currentPath = join(dir, safeName);
		if (!existsSync(currentPath)) {
			await this.listDshPatches();
			return;
		}

		try {
			if (enabled && safeName.endsWith(".disabled")) {
				const activeName = safeName.replace(/\.disabled$/, "");
				renameSync(currentPath, join(dir, activeName));
			} else if (!enabled && !safeName.endsWith(".disabled")) {
				renameSync(currentPath, join(dir, `${safeName}.disabled`));
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换补丁状态失败：${(err as Error).message}`,
				textEn: `Failed to toggle patch state: ${(err as Error).message}`,
			});
			return;
		}

		await this.rescanDshPatches();
	}

	async deleteDshPatch(name: string): Promise<void> {
		const safeName = basename(name);
		if (!safeName || safeName !== name) {
			return;
		}

		const dir = this.userPatchDir();
		const filePath = join(dir, safeName);
		if (!existsSync(filePath)) {
			await this.listDshPatches();
			return;
		}

		try {
			rmSync(filePath, { force: true });
			this.emit({
				type: "notice",
				level: "info",
				text: `已删除补丁 ${safeName}，正在重载...`,
				textEn: `Deleted patch ${safeName}, reloading...`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `删除补丁失败：${(err as Error).message}`,
				textEn: `Failed to delete patch: ${(err as Error).message}`,
			});
			return;
		}

		await this.rescanDshPatches();
	}

	async fetchDshMarket(force = false): Promise<void> {
		try {
			const data = await loadDshMarketData(this.dataDir, force);
			this.emit({
				type: "dsh_market_data",
				count: data.count,
				updated: data.updated,
				categories: data.categories,
				plugins: data.plugins,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `拉取 DSH 插件市场失败：${(err as Error).message}`,
				textEn: `Failed to fetch DSH plugin market: ${(err as Error).message}`,
			});
		}
	}

	async pushProjects(): Promise<void> {
		const recent = await this.stateStore.getRecentProjects(this.clientId);
		const removedKeys = new Set(this.stateStore.getRemovedProjects(this.clientId).map(normalizePathKey));
		const projects = new Map<string, number>();
		for (const p of recent) {
			if (!removedKeys.has(normalizePathKey(p.path))) {
				projects.set(p.path, p.lastUsed);
			}
		}
		const cwdProjects = new Set<string>();
		try {
			const { readdirSync } = await import("node:fs");
			const entries = readdirSync(this.sessionRoot, { withFileTypes: true });
			for (const e of entries) {
				if (e.isDirectory()) {
					const cwd = this.decodeProjectKey(e.name);
					if (cwd && !projects.has(cwd) && !removedKeys.has(normalizePathKey(cwd))) cwdProjects.add(cwd);
				}
			}
		} catch {}
		for (const cwd of cwdProjects) projects.set(cwd, Date.now());
		if (!removedKeys.has(normalizePathKey(this.cwd))) {
			projects.set(this.cwd, Date.now());
		}
		for (const sbx of this.sandboxes.list()) {
			if (!removedKeys.has(normalizePathKey(sbx.path)) && !projects.has(sbx.path)) {
				projects.set(sbx.path, sbx.createdAt);
			}
		}
		const list: ProjectSummary[] = [...projects.entries()]
			.filter(([path]) => {
				if (isSameOrSubpath(path, this.sandboxes.sandboxesRoot)) {
					return Boolean(this.sandboxes.getByCwd(path));
				}
				return true;
			})
			.map(([path, lastUsed]) => {
				const sbx = this.sandboxes.getByCwd(path);
				return sbx ? { path, lastUsed, sandbox: sbx } : { path, lastUsed };
			})
			.sort((a, b) => b.lastUsed - a.lastUsed)
			.slice(0, RECENT_PROJECTS_MAX);
		this.emit({ type: "projects", projects: list });
	}

	private decodeProjectKey(key: string): string | null {
		if (!key.startsWith("--") || !key.endsWith("--")) return null;
		const inner = key.slice(2, -2);
		let out = "";
		for (let i = 0; i < inner.length; i++) {
			if (inner[i] === "-") {
				out += "/";
			} else if (inner[i] === "~" && i + 4 < inner.length) {
				const hex = inner.slice(i + 1, i + 5);
				if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
					out += String.fromCharCode(parseInt(hex, 16));
					i += 4;
				} else {
					out += "~";
				}
			} else {
				out += inner[i];
			}
		}
		return out || null;
	}

	async removeProject(path: string): Promise<void> {
		const sbx = this.sandboxes.get(path) ?? this.sandboxes.getByCwd(path);
		if (sbx) {
			await this.destroySandbox(sbx.path);
			return;
		}
		this.stateStore.removeProject(this.clientId, path);
		await this.pushProjects();
	}

	async createSandbox(_opts: { name?: string; sourcePath?: string; ephemeral?: boolean }): Promise<void> {
		try {
			throw new Error(
				"DSH 不支持受管沙盒执行，请使用 pi 引擎。 DSH does not support managed sandbox execution; use the pi engine.",
			);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `创建沙盒失败：${(err as Error).message}`,
				textEn: `Failed to create sandbox: ${(err as Error).message}`,
			});
		}
	}

	async resetSandbox(path?: string): Promise<void> {
		const target = path?.trim() || this.cwd;
		try {
			const { sandbox, copiedFiles } = await this.sandboxes.withLifecycle(target, async (_info, lifecycle) =>
				lifecycle.reset(),
			);
			await this.listFiles();
			this.flushSnapshot();
			this.emit({
				type: "notice",
				level: "info",
				text: sandbox.sourcePath
					? `🔄 已重置沙盒「${sandbox.name}」（重新从源项目同步 ${copiedFiles} 个文件）`
					: `🔄 已清空并重置沙盒「${sandbox.name}」`,
				textEn: sandbox.sourcePath
					? `🔄 Reset sandbox "${sandbox.name}" (re-synced ${copiedFiles} files from source)`
					: `🔄 Cleared and reset sandbox "${sandbox.name}"`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `重置沙盒失败：${(err as Error).message}`,
				textEn: `Failed to reset sandbox: ${(err as Error).message}`,
			});
		}
	}

	async persistSandbox(path?: string): Promise<void> {
		const target = path?.trim() || this.cwd;
		try {
			const sandbox = this.sandboxes.persist(target);
			await this.pushProjects();
			this.flushSnapshot();
			this.emit({
				type: "notice",
				level: "info",
				text: `📌 沙盒「${sandbox.name}」已转为永久保留`,
				textEn: `📌 Sandbox "${sandbox.name}" is now saved permanently`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `转换永久沙盒失败：${(err as Error).message}`,
				textEn: `Failed to persist sandbox: ${(err as Error).message}`,
			});
		}
	}

	async promoteSandbox(targetPath: string, path?: string, switchToTarget = true): Promise<void> {
		const sbxTarget = path?.trim() || this.cwd;
		try {
			const { sandbox, targetPath: resolvedTarget, copiedFiles } = await this.sandboxes.promote(sbxTarget, targetPath);
			if (switchToTarget) {
				await this.setCwd(resolvedTarget);
			} else {
				await this.pushProjects();
			}
			this.emit({
				type: "notice",
				level: "info",
				text: `📤 已将沙盒「${sandbox.name}」导出为正式项目：${resolvedTarget}（共 ${copiedFiles} 个文件）`,
				textEn: `📤 Exported sandbox "${sandbox.name}" to formal project: ${resolvedTarget} (${copiedFiles} files)`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `导出沙盒失败：${(err as Error).message}`,
				textEn: `Failed to export sandbox: ${(err as Error).message}`,
			});
		}
	}

	async diffSandbox(path?: string, requestId?: string): Promise<void> {
		const target = path?.trim() || this.cwd;
		try {
			const res = await this.sandboxes.diffWithSource(target);
			this.emit({
				type: "sandbox_diff",
				diff: {
					requestId,
					expectedRevision: res.expectedRevision,
					sandboxId: res.sandbox.id,
					path: res.sandbox.path,
					sourcePath: res.sourcePath,
					added: res.added,
					modified: res.modified,
					deleted: res.deleted,
					unchangedCount: res.unchangedCount,
				},
			});
		} catch (err) {
			this.emit({
				type: "sandbox_diff",
				diff: {
					requestId,
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

	async applySandboxToSource(path: string | undefined, expectedRevision: string): Promise<void> {
		const target = path?.trim() || this.cwd;
		try {
			const { sandbox, sourcePath, copiedFiles, deletedFiles } = await this.sandboxes.withLifecycle(
				target,
				async (_info, lifecycle) => lifecycle.applyToSource(expectedRevision),
			);
			const delSuffixZh = deletedFiles ? `，清理 ${deletedFiles} 个已删除文件` : "";
			const delSuffixEn = deletedFiles ? `, pruned ${deletedFiles} deleted files` : "";
			this.emit({
				type: "notice",
				level: "info",
				text: `✅ 已将沙盒「${sandbox.name}」中的改动同步回源项目：${sourcePath}（同步 ${copiedFiles} 个文件${delSuffixZh}）`,
				textEn: `✅ Applied changes from sandbox "${sandbox.name}" back to source project: ${sourcePath} (${copiedFiles} files synced${delSuffixEn})`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `写回源项目失败：${(err as Error).message}`,
				textEn: `Failed to apply sandbox changes to source: ${(err as Error).message}`,
			});
		}
	}

	async destroySandbox(path: string): Promise<void> {
		const target = path?.trim() || this.cwd;
		try {
			const sbx = await this.sandboxes.withLifecycle(target, async (sbx, lifecycle) => {
				const activeInSbx = isSameOrSubpath(this.cwd, sbx.path);
				if (activeInSbx) {
					let fallbackCwd = sbx.sourcePath && existsSync(sbx.sourcePath) ? sbx.sourcePath : "";
					if (!fallbackCwd) {
						const recent = await this.stateStore.getRecentProjects(this.clientId);
						const other = recent.find((p) => {
							const pk = normalizePathKey(p.path);
							return pk !== normalizePathKey(sbx.path) && existsSync(p.path);
						});
						fallbackCwd = other?.path || homedir();
					}
					await this.setCwd(fallbackCwd);
				}
				for (const [id, conv] of this.convs) {
					if (id !== this.activeId && isSameOrSubpath(conv.cwd, sbx.path)) {
						this.removeConversation(id);
					}
				}
				await lifecycle.destroy();
				return sbx;
			});
			this.stateStore.removeProject(this.clientId, sbx.path);
			await this.pushProjects();
			this.flushSnapshot();
			this.emit({
				type: "notice",
				level: "info",
				text: `🗑️ 已销毁沙盒项目「${sbx.name}」并清理隔离目录`,
				textEn: `🗑️ Destroyed sandbox project "${sbx.name}" and cleaned up isolated directory`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `销毁沙盒失败：${(err as Error).message}`,
				textEn: `Failed to destroy sandbox: ${(err as Error).message}`,
			});
		}
	}

	async listFiles(relPath?: string): Promise<void> {
		await this.files.listFiles(relPath);
	}

	async searchFiles(query: string, reqId: number): Promise<void> {
		await this.files.searchFiles(query, reqId);
	}

	async searchSessions(query: string, reqId: number): Promise<void> {
		const q = query.trim().toLowerCase();
		if (!q) {
			this.emit({ type: "session_search_results", reqId, query, ok: true, results: [] });
			return;
		}
		try {
			const files = findSessionFilesForCwd(this.sessionRoot, this.cwd);
			const results: SessionSearchResult[] = [];
			for (const file of files) {
				try {
					const { events } = readSessionLog(file);
					const texts: string[] = [];
					const anchors: { role: string; timestamp: number }[] = [];
					for (const ev of events) {
						if (ev.type === "user/message" || ev.type === "assistant/message" || ev.type === "tool/result") {
							if (ev.type === "user/message" && isDshInternalUserMessage(ev.data as Record<string, unknown>)) continue;
							const blocks =
								(
									ev.data?.message as
										| { content?: { type?: string; text?: string; content?: { type?: string; text?: string }[] }[] }
										| undefined
								)?.content ??
								(ev.data?.content as
									{ type?: string; text?: string; content?: { type?: string; text?: string }[] }[] | undefined) ??
								[];
							let text = blocks.map((b) => (b?.type === "text" ? (b.text ?? "") : "")).join("\n");
							if (ev.type === "tool/result") {
								const nested = blocks
									.filter((b) => b?.type === "tool-result")
									.flatMap((b) => b.content ?? [])
									.map((b) => (b?.type === "text" ? (b.text ?? "") : ""))
									.join("\n");
								if (nested) text = `${text}\n${nested}`;
							}
							if (text) {
								texts.push(text);
								if (text.toLowerCase().includes(q)) {
									const evData = ev.data as { message?: { role?: string }; content?: unknown };
									const role = evData?.message?.role === "assistant" ? "assistant" : "user";
									anchors.push({ role, timestamp: ev.time });
								}
							}
						}
					}
					const all = texts.join("\n").toLowerCase();
					const sessionId = basename(dirname(file));
					if (sessionId.startsWith("review-")) continue;
					const firstMsg = firstUserText(events, this.getLang());
					if (all.includes(q) || sessionId.toLowerCase().includes(q) || firstMsg.toLowerCase().includes(q)) {
						const storedTitle =
							this.stateStore?.getSessionTitle(this.cwd, file) ?? this.stateStore?.getSessionTitle(this.cwd, sessionId);
						const explicitTitle =
							storedTitle ??
							sessionLogTitle(events) ??
							[...this.convs.values()].find(
								(c) => c.sessionId === sessionId && !DshClientSession.isDefaultTitle(c.title),
							)?.title;
						const displayName = this.resolveSessionDisplayName(sessionId, explicitTitle, firstMsg);
						results.push({
							path: file,
							name: explicitTitle ?? sessionId,
							displayName,
							firstMessage: firstMsg,
							messageCount: events.filter(
								(e) =>
									(e.type === "user/message" && !isDshInternalUserMessage(e.data as Record<string, unknown>)) ||
									e.type === "assistant/message" ||
									e.type === "tool/result",
							).length,
							modified: statSync(file).mtimeMs,
							source: "web",
							anchors: anchors.slice(0, 10),
						});
					}
				} catch {}
			}
			results.sort((a, b) => b.modified - a.modified);
			this.emit({ type: "session_search_results", reqId, query, ok: true, results: results.slice(0, 50) });
		} catch {
			this.emit({ type: "session_search_results", reqId, query, ok: false, results: [] });
		}
	}

	async scmQuery(
		kind: "status" | "history" | "filediff" | "commit",
		reqId: number,
		opts?: { path?: string; hash?: string },
	): Promise<void> {
		await this.files.scmQuery(kind, reqId, opts);
	}

	async readFile(relPath: string): Promise<void> {
		await this.files.readFile(relPath);
	}

	async writeFile(relPath: string, text: string): Promise<void> {
		await this.files.writeFile(relPath, text);
	}

	async uploadFile(dirRel: string, name: string, data: string, uploadId?: string): Promise<void> {
		await this.files.uploadFile(dirRel, name, data, uploadId);
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

	async completePath(input: string): Promise<void> {
		await this.files.completePath(input);
	}

	async makeDir(input: string, setAsCwd = false): Promise<void> {
		const created = await this.files.makeDir(input);
		if (created && setAsCwd) {
			await this.setCwd(created);
		}
	}

	private dynamicModels = new Set<string>();
	private customModelsMap = new Map<
		string,
		{ id: string; bareId: string; name: string; provider: string; reasoning: boolean; vision: boolean }
	>();

	async listModels(): Promise<void> {
		const known = new Map(DSH_MODELS.map((m) => [m.id, m]));
		let dynamic: { id: string; name?: string; inputModalities?: string[] }[] = [];
		try {
			const res = await this.runtime.listModels();
			dynamic = res.models ?? [];
		} catch {}
		const seen = new Set<string>();
		const models: { id: string; name: string; provider: string; reasoning: boolean; vision: boolean }[] = [];
		this.dynamicModels.clear();
		this.customModelsMap.clear();

		for (const m of DSH_MODELS) {
			const canonicalId = `deepseek/${m.id}`;
			seen.add(m.id);
			seen.add(canonicalId);
			this.dynamicModels.add(m.id);
			this.dynamicModels.add(canonicalId);
			const meta = {
				id: canonicalId,
				bareId: m.id,
				name: m.name,
				provider: m.provider,
				reasoning: true,
				vision: m.vision,
			};
			this.customModelsMap.set(canonicalId, meta);
			this.customModelsMap.set(m.id, meta);
			models.push({
				id: canonicalId,
				name: m.name,
				provider: m.provider,
				reasoning: true,
				vision: m.vision,
			});
		}

		for (const m of dynamic) {
			const canonicalId = m.id.includes("/") ? m.id : `deepseek/${m.id}`;
			const bareId = m.id.includes("/") ? m.id.slice(m.id.indexOf("/") + 1) : m.id;
			if (seen.has(m.id) || seen.has(canonicalId)) continue;
			seen.add(m.id);
			seen.add(canonicalId);
			this.dynamicModels.add(m.id);
			this.dynamicModels.add(canonicalId);
			const local = known.get(bareId) ?? known.get(m.id);
			const vision = local?.vision ?? m.inputModalities?.includes("image") ?? false;
			const name = local?.name ?? m.name ?? bareId;
			const meta = {
				id: canonicalId,
				bareId,
				name,
				provider: "deepseek",
				reasoning: true,
				vision,
			};
			this.customModelsMap.set(canonicalId, meta);
			this.customModelsMap.set(bareId, meta);
			models.push({
				id: canonicalId,
				name,
				provider: "deepseek",
				reasoning: true,
				vision,
			});
		}

		try {
			const custom = listCustomModelsFromConfig(this.agentDir, (entry) =>
				isModelProtocolSupportedByEngine("dsh", entry),
			);
			for (const c of custom) {
				const canonicalId = `${c.providerId}/${c.modelId}`;
				if (seen.has(canonicalId)) continue;
				seen.add(canonicalId);
				seen.add(c.modelId);
				this.dynamicModels.add(canonicalId);
				this.dynamicModels.add(c.modelId);
				const meta = {
					id: canonicalId,
					bareId: c.modelId,
					name: c.name,
					provider: c.providerId,
					reasoning: c.reasoning ?? true,
					vision: c.vision ?? false,
				};
				this.customModelsMap.set(canonicalId, meta);
				this.customModelsMap.set(c.modelId, meta);
				models.push({
					id: canonicalId,
					name: c.name,
					provider: c.providerId,
					reasoning: c.reasoning ?? true,
					vision: c.vision ?? false,
				});
			}
		} catch {}

		this.emit({ type: "models", models });
	}

	resolveModelMeta(modelId: string): {
		meta?: {
			id: string;
			bareId: string;
			name: string;
			provider: string;
			reasoning?: boolean;
			vision?: boolean;
		};
		targetProvider: string;
		bareModelId: string;
		known: boolean;
	} {
		const normId = modelId.trim();
		const hasSlash = normId.includes("/");
		let targetProvider = hasSlash ? normId.slice(0, normId.indexOf("/")) : "";
		let bareModelId = hasSlash ? normId.slice(normId.indexOf("/") + 1) : normId;

		let meta = this.customModelsMap.get(normId) ?? this.customModelsMap.get(bareModelId);
		if (!meta) {
			const localDsh = DSH_MODELS.find((m) => m.id === normId || m.id === bareModelId || `deepseek/${m.id}` === normId);
			if (localDsh) {
				meta = {
					id: `deepseek/${localDsh.id}`,
					bareId: localDsh.id,
					name: localDsh.name,
					provider: "deepseek",
					reasoning: true,
					vision: localDsh.vision,
				};
			} else {
				try {
					const customList = listCustomModelsFromConfig(this.agentDir, (entry) =>
						isModelProtocolSupportedByEngine("dsh", entry),
					);
					const hit = customList.find(
						(c) => `${c.providerId}/${c.modelId}` === normId || c.modelId === normId || c.modelId === bareModelId,
					);
					if (hit) {
						meta = {
							id: `${hit.providerId}/${hit.modelId}`,
							bareId: hit.modelId,
							name: hit.name,
							provider: hit.providerId,
							reasoning: hit.reasoning ?? true,
							vision: hit.vision ?? false,
						};
					}
				} catch {}
			}
		}

		if (meta) {
			targetProvider = meta.provider;
			bareModelId = meta.bareId;
		} else if (!targetProvider) {
			targetProvider = "deepseek";
		}

		const known =
			!!meta ||
			DSH_MODELS.some((m) => m.id === normId || m.id === bareModelId) ||
			this.dynamicModels.has(normId) ||
			this.dynamicModels.has(bareModelId);

		return { meta, targetProvider, bareModelId, known };
	}

	private applySavedModel(modelId: string): void {
		const res = this.resolveModelMeta(modelId);
		if (res.known || res.meta) {
			this.model = res.bareModelId;
			this.modelProvider = res.targetProvider;
			this.modelDisplayName = res.meta?.name ?? res.bareModelId;
			this.modelVision = res.meta?.vision ?? false;
		}
	}

	async setModel(modelId: string): Promise<void> {
		const { meta, targetProvider, bareModelId, known } = this.resolveModelMeta(modelId);
		if (!known) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `未知模型：${modelId}`,
				textEn: `Unknown model: ${modelId}`,
			});
			return;
		}

		if (bareModelId === this.model && targetProvider === this.modelProvider) return;

		const cred = resolveProviderCredential(this.agentDir, targetProvider);
		if (targetProvider !== "deepseek" && !cred.apiKey && !process.env.DEEPSEEK_API_KEY) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `服务商「${targetProvider}」未配置 API Key，请在模型与服务商设置中填写`,
				textEn: `Provider "${targetProvider}" has no API Key configured. Please configure it in Model Settings.`,
			});
		}

		if ([...this.convs.values()].some((c) => c.isStreaming)) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "有对话正在运行，切换模型将中止当前所有运行（DSH 换模型 = 重启运行时）",
				textEn:
					"Conversations are running; switching models aborts all of them (DSH model switch restarts the runtime)",
			});
		}

		this.model = bareModelId;
		this.modelProvider = targetProvider;
		this.modelDisplayName = meta?.name ?? bareModelId;
		this.modelVision = meta?.vision ?? false;
		this.stateStore?.saveProjectModel(this.clientId, this.cwd, modelId, "dsh");

		try {
			await this.runtime.restart(bareModelId, targetProvider);
			this.emit({
				type: "notice",
				level: "info",
				text: `已切换到 ${this.modelDisplayName}`,
				textEn: `Switched to ${this.modelDisplayName}`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换模型失败：${(err as Error).message}`,
				textEn: `Failed to switch model: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot(true);
	}

	async setDefaultModel(modelId: string): Promise<void> {
		try {
			const res = this.resolveModelMeta(modelId);
			if (!res.known && !res.meta) {
				throw new Error(`未知模型：${modelId}`);
			}
			this.stateStore?.saveDefaultModel(modelId, "dsh");
			this.pushDefaultModel();
			this.emit({
				type: "notice",
				level: "info",
				text: `🌍 已设全局默认模型 ${modelId}（新项目自动使用，项目记忆优先）`,
				textEn: `🌍 Global default model set to ${modelId} (new projects follow it; project memory wins)`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `设置全局默认模型失败：${(err as Error).message}`,
				textEn: `Failed to set global default model: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	clearDefaultModel(): void {
		this.stateStore?.saveDefaultModel("", "dsh");
		this.pushDefaultModel();
		this.emit({
			type: "notice",
			level: "info",
			text: "🌍 已清除全局默认模型（新项目回到系统默认）",
			textEn: "🌍 Global default model cleared (new projects use the system default)",
		});
		this.flushSnapshot();
	}

	pushDefaultModel(): void {
		const def = this.stateStore?.getDefaultModel("dsh");
		this.emit({ type: "default_model", modelId: def ? def : null });
	}

	setThinking(level: string): void {
		if (level !== "high") {
			this.emit({
				type: "notice",
				level: "info",
				text: "DeepSeek V4 仅支持高思考强度",
				textEn: "DeepSeek V4 only supports high thinking intensity",
			});
			return;
		}
		this.thinkingLevel = level;
		this.flushSnapshot();
	}

	private buildFallbackPromptSections(): { name: string; text: string; chars: number }[] {
		const identity = "You are an AI agent powered by DeepSeek Harness.";
		const custom = this.settings.customSystemPrompt.trim();
		const markerGuidance = this.markerSvc.buildGuidance().trim();
		const effectiveCustom = [custom, markerGuidance].filter(Boolean).join("\n\n");
		const sections: { name: string; text: string; chars: number }[] = [
			{ name: "harness:identity", text: identity, chars: identity.length },
		];
		if (this.settings.promptMode === "replace") {
			const persona =
				effectiveCustom ||
				`You are a coding agent powered by the ${this.model} model. Your working directory is ${this.cwd}.`;
			sections.push({ name: "deployment:persona-prefix", text: persona, chars: persona.length });
		} else {
			const persona = `You are a coding agent powered by the ${this.model} model. Your working directory is ${this.cwd}.`;
			sections.push({ name: "deployment:persona-prefix", text: persona, chars: persona.length });
			if (effectiveCustom) {
				sections.push({ name: "pi-webui:custom-prompt", text: effectiveCustom, chars: effectiveCustom.length });
			}
		}
		return sections;
	}

	private buildFallbackSystemPrompt(): string {
		return this.buildFallbackPromptSections()
			.map((s) => s.text)
			.filter(Boolean)
			.join("\n\n");
	}

	private buildFallbackPromptSourceDefaults(): Record<string, string> {
		const defs: Record<string, string> = {};
		for (const s of this.buildFallbackPromptSections()) {
			defs[s.name] = s.text;
		}
		return defs;
	}

	refreshSettings(): void {
		this.pushSettings();
	}

	pushSettings(): void {
		if (this.runtime?.alive && !this.cachedEffectiveSystemPrompt) {
			void this.refreshPromptInfo().catch(() => {});
		}
		const effectiveSystemPrompt = this.cachedEffectiveSystemPrompt || this.buildFallbackSystemPrompt();
		const promptSourceDefaults =
			Object.keys(this.cachedPromptSourceDefaults).length > 0
				? this.cachedPromptSourceDefaults
				: this.buildFallbackPromptSourceDefaults();
		const promptSections =
			this.cachedPromptSections.length > 0 ? this.cachedPromptSections : this.buildFallbackPromptSections();
		const settings: UiSettingsState = {
			nativeCliInheritModel: { ...this.stateStore.getSettingsSnapshot(this.clientId).nativeCliInheritModel },
			...normalizeQuickAskSettings(this.stateStore.getSettingsSnapshot(this.clientId)),
			steeringMode: "all",
			followUpMode: "all",
			promptMode: this.settings.promptMode,
			customSystemPrompt: this.settings.customSystemPrompt,
			disabledSkills: this.settings.disabledSkills,
			disabledExtensions: this.settings.disabledExtensions,
			disabledAgentTools: [],
			disabledPluginTools: [],
			terminalToolsEnabled: this.settings.terminalToolsEnabled,
			terminalBash: this.settings.terminalBash,
			terminalBashIdleMs: this.settings.terminalBashIdleMs,
			terminalBashMaxForegroundMs: this.settings.terminalBashMaxForegroundMs,
			toolWatchdogTimeoutMs: this.settings.toolWatchdogTimeoutMs,
			readDirEnabled: true,
			bgAutoCleanupMin: Number(this.settings.bgAutoCleanupMin ?? 0),
			toolLazyLoading: false,
			codemodeMode: "on",
			codemodeInlineBudget: 3000,
			editSoftEnabled: this.settings.editSoftEnabled,
			retryMaxAttempts: DEFAULT_RETRY_MAX_ATTEMPTS,
			softCapTokens: 0,
			softCapByModel: {},
			autoCompactionInstructions: "",
			questionnaireEnabled: this.settings.questionnaireEnabled,
			toolApprovalEnabled: this.settings.toolApprovalEnabled !== false,
			approvalPolicy: { allowAll: false, categories: [] },
			approvalRules: [],
			goalModeEnabled: this.settings.goalModeEnabled,
			parallelReminderEnabled: this.settings.parallelReminderEnabled,
			thinkingWrap: this.settings.thinkingWrap,
			toolsWrap: this.settings.toolsWrap,
			toolImagesEnabled: this.settings.toolImagesEnabled,
			keepRecentMessages: normalizeKeepRecentMessages(this.settings.keepRecentMessages),
			showForkedParentSessions: this.settings.showForkedParentSessions ?? false,
			retainFinishedConversations: this.settings.retainFinishedConversations ?? false,
			openRecentSessionOnProjectSwitch: this.settings.openRecentSessionOnProjectSwitch ?? true,
			skillsFullText: [],
			skillsCatalogMaxDesc: 250,
			skillsCatalogShowLocation: false,
			skillsCatalogBudget: 20000,
			skillsMaxFileBytes: 8192,
			skillsFullTextMaxBytes: 32768,
			chatUploadMaxMb: this.stateStore.getSettingsSnapshot(this.clientId).chatUploadMaxMb ?? 20,
			workspaceUploadMaxMb: this.stateStore.getSettingsSnapshot(this.clientId).workspaceUploadMaxMb ?? 100,
			folderUploadMaxMb: this.stateStore.getSettingsSnapshot(this.clientId).folderUploadMaxMb ?? 32,
			visionBridgeEnabled: false,
			visionBridgeModel: null,
			visionBridgePromptMode: "append",
			visionBridgePrompt: "",
			scmCommitMsgPromptMode: "append",
			scmCommitMsgPrompt: "",
			planModePromptMode: "append",
			planModePrompt: "",
			planModeDefaultPrompt: PLAN_MODE_SYSTEM_PROMPT,
			reviewPrompt: this.settings.reviewPrompt,
			reviewDisabledSkills: [],
			disabledPlugins: this.settings.disabledPlugins,
			uiLayout: normalizeUiLayout(this.settings.uiLayout),
			promptTemplate: this.settings.promptTemplate ?? "",
			promptOverrides: this.settings.promptOverrides ?? {},
			promptDisabled: [...(this.settings.promptDisabled ?? [])],
			toolPromptOverrides: {},
			effectiveSystemPrompt,
			promptSourceDefaults,
			promptSections,
			toolsSchema: this.cachedToolsSchema,
			visionBridgeDefaultPrompt: "",
			scmCommitMsgDefaultPrompt: "",
			visionModels: [],
			skills: this.skillsCache,
			reviewSkills: [],
			extensions: [],
			presets: this.stateStore.getPresets(this.clientId).map(settingsPresetToUi),
			markersEnabled: this.markerSvc.current.markersEnabled,
			disabledMarkers: [...this.markerSvc.current.disabledMarkers],
			markers: this.markerSvc.listForUi(),
			subagentTemplates: [],
			subagentDefaultTemplates: [],
			subagentDefaultModel: null,
			subagentModels: [],
			quickPhrases: [...this.settings.quickPhrases],
			quickPhrasesEnabled: this.settings.quickPhrasesEnabled,
			minimalNewChat: this.settings.minimalNewChat,
			preserveDraftAcrossConversations: this.settings.preserveDraftAcrossConversations ?? false,
			quickPhrasesSeeded: this.stateStore.getQuickPhrasesSeeded(),
		};
		this.emit({ type: "settings_state", settings });
	}

	async setSettings(partial: {
		nativeCliInheritModel?: UiSettingsState["nativeCliInheritModel"];
		quickAskEnabled?: QuickAskSettings["quickAskEnabled"];
		quickAskModel?: QuickAskSettings["quickAskModel"];
		quickAskThinking?: QuickAskSettings["quickAskThinking"];
		quickAskSystemPrompt?: QuickAskSettings["quickAskSystemPrompt"];
		quickAskExplainPrompt?: QuickAskSettings["quickAskExplainPrompt"];
		quickAskTranslateEnabled?: QuickAskSettings["quickAskTranslateEnabled"];
		quickAskTranslateTarget?: QuickAskSettings["quickAskTranslateTarget"];
		quickAskTranslateStyle?: QuickAskSettings["quickAskTranslateStyle"];
		quickAskTranslatePrompt?: QuickAskSettings["quickAskTranslatePrompt"];
		quickAskShowOriginal?: QuickAskSettings["quickAskShowOriginal"];
		quickAskReferenceMenus?: QuickAskSettings["quickAskReferenceMenus"];
		quickAskConversationScope?: QuickAskSettings["quickAskConversationScope"];
		quickAskFolderScope?: QuickAskSettings["quickAskFolderScope"];
		promptMode?: "append" | "replace";
		customSystemPrompt?: string;
		promptTemplate?: string;
		promptOverrides?: Record<string, string>;
		promptDisabled?: string[];
		disabledSkills?: string[];
		disabledExtensions?: string[];
		disabledPlugins?: string[];
		uiLayout?: UiLayoutPrefs;
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		terminalBashMaxForegroundMs?: number;
		toolWatchdogTimeoutMs?: number;
		bgAutoCleanupMin?: number;
		editSoftEnabled?: boolean;
		questionnaireEnabled?: boolean;
		toolApprovalEnabled?: boolean;
		goalModeEnabled?: boolean;
		parallelReminderEnabled?: boolean;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		toolImagesEnabled?: boolean;
		keepRecentMessages?: number;
		showForkedParentSessions?: boolean;
		retainFinishedConversations?: boolean;
		openRecentSessionOnProjectSwitch?: boolean;
		chatUploadMaxMb?: number;
		workspaceUploadMaxMb?: number;
		folderUploadMaxMb?: number;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: "append" | "replace";
		visionBridgePrompt?: string;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
		markersEnabled?: boolean;
		disabledMarkers?: string[];
		quickPhrases?: string[];
		quickPhrasesEnabled?: boolean;
		minimalNewChat?: boolean;
		preserveDraftAcrossConversations?: boolean;
		quickPhrasesSeeded?: boolean;
	}): Promise<void> {
		if (partial.quickPhrasesSeeded) this.stateStore.markQuickPhrasesSeeded();
		if (partial.promptMode !== undefined) this.settings.promptMode = partial.promptMode;
		if (partial.customSystemPrompt !== undefined) this.settings.customSystemPrompt = partial.customSystemPrompt;
		if (partial.promptTemplate !== undefined) this.settings.promptTemplate = partial.promptTemplate;
		if (partial.promptOverrides !== undefined) this.settings.promptOverrides = partial.promptOverrides;
		if (partial.promptDisabled !== undefined) this.settings.promptDisabled = [...partial.promptDisabled];
		if (partial.disabledSkills !== undefined) this.settings.disabledSkills = partial.disabledSkills;
		if (partial.disabledExtensions !== undefined) this.settings.disabledExtensions = partial.disabledExtensions;
		if (partial.terminalToolsEnabled !== undefined) this.settings.terminalToolsEnabled = partial.terminalToolsEnabled;
		if (partial.terminalBash !== undefined) this.settings.terminalBash = partial.terminalBash;
		if (partial.terminalBashIdleMs !== undefined) this.settings.terminalBashIdleMs = partial.terminalBashIdleMs;
		if (partial.terminalBashMaxForegroundMs !== undefined)
			this.settings.terminalBashMaxForegroundMs = partial.terminalBashMaxForegroundMs;
		if (partial.toolWatchdogTimeoutMs !== undefined)
			this.settings.toolWatchdogTimeoutMs = normalizeToolWatchdogTimeoutMs(partial.toolWatchdogTimeoutMs);
		if (partial.bgAutoCleanupMin !== undefined)
			this.settings.bgAutoCleanupMin = normalizeBgCleanupMinutes(partial.bgAutoCleanupMin);
		if (partial.editSoftEnabled !== undefined) this.settings.editSoftEnabled = partial.editSoftEnabled;
		if (partial.questionnaireEnabled !== undefined) this.settings.questionnaireEnabled = partial.questionnaireEnabled;
		if (partial.toolApprovalEnabled !== undefined) this.settings.toolApprovalEnabled = partial.toolApprovalEnabled;
		if (partial.goalModeEnabled !== undefined) this.settings.goalModeEnabled = partial.goalModeEnabled;
		if (partial.parallelReminderEnabled !== undefined)
			this.settings.parallelReminderEnabled = partial.parallelReminderEnabled;
		if (partial.thinkingWrap !== undefined) this.settings.thinkingWrap = partial.thinkingWrap;
		if (partial.toolsWrap !== undefined) this.settings.toolsWrap = partial.toolsWrap;
		if (partial.toolImagesEnabled !== undefined) this.settings.toolImagesEnabled = partial.toolImagesEnabled;
		if (partial.keepRecentMessages !== undefined)
			this.settings.keepRecentMessages = normalizeKeepRecentMessages(partial.keepRecentMessages);
		if (partial.showForkedParentSessions !== undefined)
			this.settings.showForkedParentSessions = Boolean(partial.showForkedParentSessions);
		if (partial.retainFinishedConversations !== undefined)
			this.settings.retainFinishedConversations = Boolean(partial.retainFinishedConversations);
		if (partial.openRecentSessionOnProjectSwitch !== undefined)
			this.settings.openRecentSessionOnProjectSwitch = Boolean(partial.openRecentSessionOnProjectSwitch);
		if (partial.disabledPlugins !== undefined) this.settings.disabledPlugins = partial.disabledPlugins;
		if (partial.uiLayout !== undefined) this.settings.uiLayout = normalizeUiLayout(partial.uiLayout);
		if (partial.reviewPrompt !== undefined) this.settings.reviewPrompt = partial.reviewPrompt;
		if (partial.quickPhrases !== undefined) {
			const seen = new Set<string>();
			this.settings.quickPhrases = (Array.isArray(partial.quickPhrases) ? partial.quickPhrases : [])
				.map((p) => String(p).trim().slice(0, 200))
				.filter((p) => p && !seen.has(p) && (seen.add(p), true))
				.slice(0, 30);
		}
		if (partial.quickPhrasesEnabled !== undefined) this.settings.quickPhrasesEnabled = partial.quickPhrasesEnabled;
		if (partial.minimalNewChat !== undefined) this.settings.minimalNewChat = partial.minimalNewChat;
		if (partial.preserveDraftAcrossConversations !== undefined)
			this.settings.preserveDraftAcrossConversations = partial.preserveDraftAcrossConversations;
		const prevMarkerGuidance = this.markerSvc.buildGuidance();
		this.markerSvc.setAll({
			markersEnabled: partial.markersEnabled,
			disabledMarkers: partial.disabledMarkers,
		});
		const markerGuidanceChanged = this.markerSvc.buildGuidance() !== prevMarkerGuidance;
		this.stateStore.saveSettings(this.clientId, {
			nativeCliInheritModel: partial.nativeCliInheritModel,
			...mergeQuickAskSettings(this.stateStore.getSettingsSnapshot(this.clientId), partial),
			chatUploadMaxMb: partial.chatUploadMaxMb,
			workspaceUploadMaxMb: partial.workspaceUploadMaxMb,
			folderUploadMaxMb: partial.folderUploadMaxMb,
			promptMode: this.settings.promptMode,
			customSystemPrompt: this.settings.customSystemPrompt,
			disabledSkills: this.settings.disabledSkills,
			disabledExtensions: this.settings.disabledExtensions,
			terminalToolsEnabled: this.settings.terminalToolsEnabled,
			terminalBash: this.settings.terminalBash,
			terminalBashIdleMs: this.settings.terminalBashIdleMs,
			terminalBashMaxForegroundMs: this.settings.terminalBashMaxForegroundMs,
			editSoftEnabled: this.settings.editSoftEnabled,
			retryMaxAttempts: DEFAULT_RETRY_MAX_ATTEMPTS,
			softCapTokens: 0,
			softCapByModel: {},
			autoCompactionInstructions: "",
			questionnaireEnabled: this.settings.questionnaireEnabled,
			toolApprovalEnabled: this.settings.toolApprovalEnabled !== false,
			goalModeEnabled: this.settings.goalModeEnabled,
			parallelReminderEnabled: this.settings.parallelReminderEnabled,
			thinkingWrap: this.settings.thinkingWrap,
			toolsWrap: this.settings.toolsWrap,
			toolImagesEnabled: this.settings.toolImagesEnabled,
			keepRecentMessages: normalizeKeepRecentMessages(this.settings.keepRecentMessages),
			showForkedParentSessions: this.settings.showForkedParentSessions ?? false,
			retainFinishedConversations: this.settings.retainFinishedConversations ?? false,
			openRecentSessionOnProjectSwitch: this.settings.openRecentSessionOnProjectSwitch ?? true,
			disabledPlugins: this.settings.disabledPlugins,
			uiLayout: normalizeUiLayout(this.settings.uiLayout),
			reviewPrompt: this.settings.reviewPrompt,
			quickPhrases: this.settings.quickPhrases,
			quickPhrasesEnabled: this.settings.quickPhrasesEnabled,
			minimalNewChat: this.settings.minimalNewChat,
			preserveDraftAcrossConversations: this.settings.preserveDraftAcrossConversations,
			defaultAgentPreset: this.settings.defaultAgentPreset,
			promptTemplate: this.settings.promptTemplate ?? "",
			promptOverrides: this.settings.promptOverrides ?? {},
			promptDisabled: [...(this.settings.promptDisabled ?? [])],
		});
		const personaChanged =
			partial.promptMode !== undefined || partial.customSystemPrompt !== undefined || markerGuidanceChanged;
		if (personaChanged) {
			await this.applyPersona();
			void this.refreshPromptInfo().catch(() => {});
		}
		if (partial.disabledSkills !== undefined) {
			void this.pushDisabledSkillsToRuntime();
			void this.refreshSkillsFromRuntime();
		}
		this.pushSettings();
		this.flushSnapshot();
	}

	private buildPersonaEnv(): { DSH_PERSONA: string; PI_WEB_DSH_CUSTOM_PROMPT: string } {
		const custom = this.settings.customSystemPrompt.trim();
		const markerGuidance = this.markerSvc.buildGuidance().trim();
		const effectiveCustom = [custom, markerGuidance].filter(Boolean).join("\n\n");
		const persona =
			this.settings.promptMode === "replace" && custom
				? effectiveCustom
				: effectiveCustom
					? `\n\n${effectiveCustom}`
					: "";
		return { DSH_PERSONA: persona, PI_WEB_DSH_CUSTOM_PROMPT: effectiveCustom };
	}

	private applyPersona(): Promise<void> {
		this.runtime.env = { ...this.runtime.env, ...this.buildPersonaEnv() };
		if (this.runtime.alive) {
			return this.runtime.restart(this.model).catch(() => {});
		}
		return Promise.resolve();
	}

	async refreshPromptInfo(): Promise<void> {
		try {
			if (!this.runtime.alive) return;
			const res = await this.runtime.inspectPrompt();
			if (res && !res.error) {
				if (typeof res.prompt === "string" && res.prompt) {
					this.cachedEffectiveSystemPrompt = res.prompt;
				}
				if (Array.isArray(res.sections)) {
					this.cachedPromptSections = res.sections;
					const defaults: Record<string, string> = {};
					for (const s of res.sections) {
						if (s.name) defaults[s.name] = s.text ?? "";
					}
					this.cachedPromptSourceDefaults = defaults;
				}
				if (Array.isArray(res.tools) && res.tools.length > 0) {
					this.cachedToolsSchema = buildToolsSchemaText(res.tools as ToolSchemaEntry[]);
				}
				this.pushSettings();
			}
		} catch {}
	}

	async reloadExtensions(): Promise<void> {
		this.emit({
			type: "notice",
			level: "info",
			text: "DSH 引擎不支持 pi 扩展热重载",
			textEn: "The DSH engine does not support pi extension hot-reload",
		});
	}

	async refreshAgentPresets(): Promise<void> {
		try {
			const res = await this.runtime.listPresets();
			if (res.unavailable || !Array.isArray(res.presets) || res.presets.length === 0) {
				this.agentPresets = [];
				this.agentPresetsAvailable = false;
				this.agentPresetDefault = PRESET_DEFAULT_ID;
			} else {
				this.agentPresets = res.presets;
				this.agentPresetDefault = res.defaultPreset || PRESET_DEFAULT_ID;
				this.agentPresetsAvailable = true;
			}
		} catch {
			this.agentPresets = [];
			this.agentPresetsAvailable = false;
			this.agentPresetDefault = PRESET_DEFAULT_ID;
		}
		this.pushAgentPresets();
		this.flushSnapshot();
	}

	resolvePreset(requested?: string): string {
		if (requested) {
			const hit = this.agentPresets.find((p) => p.id === requested && !p.broken);
			if (hit) return hit.id;
			if (this.presetCloneIds.includes(requested)) return requested;
		}
		const def = this.settings.defaultAgentPreset;
		if (def) {
			const hit = this.agentPresets.find((p) => p.id === def && !p.broken);
			if (hit) return hit.id;
			if (this.presetCloneIds.includes(def)) return def;
		}
		return PRESET_DEFAULT_ID;
	}

	pushAgentPresets(): void {
		this.emit({
			type: "dsh_presets",
			presets: this.agentPresets.map((p) => ({ ...p })),
			defaultPreset: this.resolvePreset(),
		});
	}

	async setDefaultAgentPreset(preset: string): Promise<void> {
		const hit = this.agentPresets.find((p) => p.id === preset && !p.broken);
		const valid = hit ? hit.id : this.presetCloneIds.includes(preset) ? preset : null;
		if (!valid) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `未知预设「${preset}」，默认预设未改`,
				textEn: `Unknown preset "${preset}"; default preset unchanged`,
			});
			return;
		}
		this.settings.defaultAgentPreset = valid;
		this.stateStore.saveSettings(this.clientId, { defaultAgentPreset: valid });
		this.pushSettings();
		this.pushAgentPresets();
		this.flushSnapshot();
	}

	async selectAgentPreset(preset: string): Promise<void> {
		const conv = this.conv;
		if (conv.presetLocked || conv.messages.length > 0) {
			conv.presetLocked = true;
			this.emit({
				type: "notice",
				level: "warning",
				text: `会话已开始，预设锁定为「${this.presetName(conv.agentPreset)}」（空白会话可切换）`,
				textEn: `Session already started; preset locked to "${this.presetName(conv.agentPreset)}" (only blank sessions can switch)`,
			});
			this.flushSnapshot();
			return;
		}
		const target = this.resolvePreset(preset);
		if (target === conv.agentPreset) {
			this.flushSnapshot();
			return;
		}
		try {
			const res = await this.runtime.selectPreset(conv.sessionId, target);
			if (!res.ok) {
				if (res.code === "agent-preset/locked") conv.presetLocked = true;
				this.emit({
					type: "notice",
					level: "warning",
					text: `预设切换失败：${res.code === "agent-preset/locked" ? "会话已开始，预设已锁定" : (res.message ?? res.code ?? "未知错误")}`,
					textEn: `Preset switch failed: ${res.code === "agent-preset/locked" ? "session already started; preset is locked" : (res.message ?? res.code ?? "unknown error")}`,
				});
				this.flushSnapshot();
				return;
			}
			conv.agentPreset = res.preset ?? target;
			this.emitConversations();
			this.pushSettings();
			void this.refreshPromptInfo().catch(() => {});
			this.flushSnapshot();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `预设切换失败：${(err as Error).message}`,
				textEn: `Preset switch failed: ${(err as Error).message}`,
			});
		}
	}

	presetName(id: string): string {
		return this.agentPresets.find((p) => p.id === id)?.name ?? id;
	}

	resolvePermissionPreset(requested?: string): string {
		if (requested && PERMISSION_OFFERED.includes(requested)) return requested;
		const def = this.settings.defaultPermissionPreset;
		if (def && PERMISSION_OFFERED.includes(def)) return def;
		return PERMISSION_DEFAULT_PRESET;
	}

	pushPermission(): void {
		this.emit({
			type: "dsh_permission",
			options: this.permissionOptions.map((o) => ({ ...o })),
			defaultPreset: this.settings.defaultPermissionPreset,
		});
	}

	async refreshPermissionOptions(): Promise<void> {
		try {
			const res = await this.runtime.getPermission(this.conv.sessionId);
			this.permissionOptions = Array.isArray(res.options) ? res.options : [];
		} catch {
			this.permissionOptions = [];
		}
		this.pushPermission();
	}

	async refreshActivePermission(): Promise<void> {
		const conv = this.conv;
		try {
			const res = await this.runtime.getPermission(conv.sessionId);
			const cur = typeof res.currentValue === "string" ? res.currentValue : null;
			if (cur && cur !== conv.permissionPreset) {
				conv.permissionPreset = cur;
				this.flushSnapshot();
				return;
			}
			if (cur) conv.permissionPreset = cur;
		} catch {}
		this.flushSnapshot();
	}

	async setDefaultPermissionPreset(preset: string): Promise<void> {
		if (!PERMISSION_OFFERED.includes(preset)) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `未知权限预设「${preset}」，默认未改`,
				textEn: `Unknown permission preset "${preset}"; default unchanged`,
			});
			return;
		}
		this.settings.defaultPermissionPreset = preset;
		this.stateStore.saveSettings(this.clientId, { defaultPermissionPreset: preset });
		this.pushPermission();
		this.flushSnapshot();
	}

	async ensurePermissionDefault(conv: DshConversation): Promise<void> {
		const target = this.resolvePermissionPreset();
		try {
			if (!conv.permissionPreset) {
				const res = await this.runtime.getPermission(conv.sessionId);
				if (typeof res.currentValue === "string" && res.currentValue) conv.permissionPreset = res.currentValue;
			}
			if (conv.permissionPreset && conv.permissionPreset !== target) {
				const res = await this.runtime.setPermission(conv.sessionId, target);
				if (res.ok) conv.permissionPreset = res.currentValue || target;
			}
		} catch {}
	}

	async setPermissionPreset(preset: string): Promise<void> {
		const conv = this.conv;
		const target = this.resolvePermissionPreset(preset);
		if (preset !== target) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `未知权限预设「${preset}」，已回落「${target}」`,
				textEn: `Unknown permission preset "${preset}"; fell back to "${target}"`,
			});
		}
		try {
			const res = await this.runtime.setPermission(conv.sessionId, target);
			if (!res.ok) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `权限切换失败：${res.message ?? res.code ?? "未知错误"}`,
					textEn: `Permission switch failed: ${res.message ?? res.code ?? "unknown error"}`,
				});
				this.flushSnapshot();
				return;
			}
			conv.permissionPreset = res.currentValue || target;
			if (Array.isArray(res.options) && res.options.length > 0) {
				this.permissionOptions = res.options;
				this.pushPermission();
			}
			this.emitConversations();
			this.flushSnapshot();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `权限切换失败：${(err as Error).message}`,
				textEn: `Permission switch failed: ${(err as Error).message}`,
			});
		}
	}

	async setDelegateMode(enabled: boolean): Promise<void> {
		if (!enabled) return;
		this.emit({
			type: "notice",
			level: "warning",
			text: "审查者模式仅支持 pi 引擎（DSH 没有工具硬闸门的注册面），未开启。",
			textEn: "Reviewer mode needs the pi engine (DSH has no tool-gate registration surface); not enabled.",
		});
		this.flushSnapshot();
	}

	async savePreset(name: string): Promise<void> {
		const presets = this.stateStore.getPresets(this.clientId);
		const existing = presets.find((p) => p.name === name);
		const preset = {
			name,
			promptMode: this.settings.promptMode,
			customSystemPrompt: this.settings.customSystemPrompt,
			promptTemplate: "",
			promptOverrides: {},
			promptDisabled: [],
			disabledSkills: this.settings.disabledSkills,
			disabledExtensions: this.settings.disabledExtensions,
			disabledAgentTools: [],
			terminalToolsEnabled: this.settings.terminalToolsEnabled,
			terminalBash: this.settings.terminalBash,
			terminalBashIdleMs: this.settings.terminalBashIdleMs,
			terminalBashMaxForegroundMs: this.settings.terminalBashMaxForegroundMs,
			editSoftEnabled: this.settings.editSoftEnabled,
			skillsFullText: [],
			retryMaxAttempts: DEFAULT_RETRY_MAX_ATTEMPTS,
			softCapTokens: 0,
			softCapByModel: {},
			autoCompactionInstructions: "",
			visionBridgePromptMode: "append" as const,
			visionBridgePrompt: "",
			reviewPrompt: this.settings.reviewPrompt,
			reviewDisabledSkills: [],
		};
		this.stateStore.savePresets(
			this.clientId,
			existing ? presets.map((p) => (p.name === name ? preset : p)) : [...presets, preset],
		);
		this.emit({
			type: "notice",
			level: "info",
			text: `预设「${name}」已保存`,
			textEn: `Preset "${name}" saved`,
		});
		this.pushSettings();
	}

	async applyPreset(name: string): Promise<void> {
		const preset = this.stateStore.getPresets(this.clientId).find((p) => p.name === name);
		if (!preset) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `预设「${name}」不存在`,
				textEn: `Preset "${name}" does not exist`,
			});
			return;
		}
		const { settings } = sanitizePresetSettings(preset);
		this.stateStore.saveSettings(this.clientId, settings);
		Object.assign(this.settings, settings);
		await this.applyPersona();
		this.pushSettings();
		this.flushSnapshot();
	}

	async deletePreset(name: string): Promise<void> {
		const presets = this.stateStore.getPresets(this.clientId);
		this.stateStore.savePresets(
			this.clientId,
			presets.filter((p) => p.name !== name),
		);
		this.pushSettings();
	}

	private sharePort(): PresetSharePort {
		return {
			lang: () => this.getLang(),
			appVersion: () => packageVersion(),
			presets: () => this.stateStore.getPresets(this.clientId),
			currentSettings: () => {
				const s = this.settings;
				return {
					promptMode: s.promptMode,
					customSystemPrompt: s.customSystemPrompt,
					promptTemplate: "",
					promptOverrides: {},
					promptDisabled: [],
					disabledSkills: [...(s.disabledSkills ?? [])],
					disabledExtensions: [...(s.disabledExtensions ?? [])],
					disabledAgentTools: [],
					disabledPluginTools: [],
					terminalToolsEnabled: s.terminalToolsEnabled,
					terminalBash: s.terminalBash,
					terminalBashIdleMs: s.terminalBashIdleMs,
					terminalBashMaxForegroundMs: s.terminalBashMaxForegroundMs,
					editSoftEnabled: s.editSoftEnabled,
					skillsFullText: [],
					reviewPrompt: s.reviewPrompt ?? "",
					reviewDisabledSkills: [],
				};
			},
			upsertPreset: (preset) => {
				const presets = this.stateStore.getPresets(this.clientId);
				this.stateStore.savePresets(
					this.clientId,
					presets.some((p) => p.name === preset.name)
						? presets.map((p) => (p.name === preset.name ? preset : p))
						: [...presets, preset],
				);
			},
			applyPreset: (name) => this.applyPreset(name),
			pushSettings: () => this.pushSettings(),
			emit: (msg) => this.emit(msg),
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

	async saveSubagentTemplate(): Promise<void> {
		this.emit({
			type: "notice",
			level: "info",
			text: "DSH 引擎不支持子代理模板（请在 pi 引擎中使用）",
			textEn: "Subagent templates are not supported by the DSH engine (use the pi engine instead)",
		});
	}

	async deleteSubagentTemplate(): Promise<void> {
		this.emit({
			type: "notice",
			level: "info",
			text: "DSH 引擎不支持子代理模板（请在 pi 引擎中使用）",
			textEn: "Subagent templates are not supported by the DSH engine (use the pi engine instead)",
		});
	}

	private emitGoalStatus(): void {
		this.emit({ type: "goal_status", status: { ...this.conv.goal } });
	}

	private applyGoalChange(
		conv: DshConversation,
		data: {
			operation?: string;
			goal?: {
				id?: string;
				revision?: number;
				objective?: string;
				phase?: string;
				maxGoalRounds?: number;
				blockedReason?: string;
			};
			roundsStarted?: number;
			cleared?: { id?: string; revision?: number };
		},
	): void {
		const g = conv.goal;
		if (data.operation === "clear" || (!data.goal && data.cleared)) {
			conv.dsGoal = null;
			g.goal = null;
			g.conversationId = null;
			g.reviewing = false;
			g.verdict = "pending";
			g.feedback = undefined;
			g.status = "";
			g.statusEn = "";
		} else if (data.goal?.objective) {
			conv.dsGoal = {
				id: data.goal.id ?? "",
				revision: data.goal.revision ?? 0,
				phase: data.goal.phase ?? "active",
				objective: data.goal.objective,
				maxGoalRounds: data.goal.maxGoalRounds ?? 0,
				roundsStarted: data.roundsStarted ?? 0,
				...(data.goal.blockedReason ? { blockedReason: data.goal.blockedReason } : {}),
			};
			g.goal = data.goal.objective;
			g.conversationId = conv.id;
			g.round = data.roundsStarted ?? 0;
			if (data.goal.maxGoalRounds) g.maxRounds = data.goal.maxGoalRounds;
			const phase = data.goal.phase ?? "active";
			if (phase === "active") {
				g.reviewing = true;
				g.verdict = "pending";
				g.feedback = undefined;
				const rounds = g.round ?? 0;
				const max = data.goal.maxGoalRounds ?? g.maxRounds ?? 0;
				g.status =
					max > 0 && rounds >= max
						? `已达轮数上限（${rounds}/${max}），目标未完成`
						: `目标进行中（第 ${rounds + 1} 轮）…`;
				g.statusEn =
					max > 0 && rounds >= max
						? `Round cap reached (${rounds}/${max}), goal incomplete`
						: `Goal in progress (round ${rounds + 1})…`;
			} else if (phase === "complete") {
				g.reviewing = false;
				g.verdict = "pass";
				g.status = "✅ 目标已达成";
				g.statusEn = "✅ Goal achieved";
			} else if (phase === "blocked") {
				g.reviewing = false;
				g.verdict = "fail";
				g.feedback =
					data.goal.blockedReason ??
					pick(this.getLang(), "（模型报告受阻）", "(Model reported blocked)", "dsh.goal.blocked");
				g.status = "目标受阻";
				g.statusEn = "Goal blocked";
			} else if (phase === "paused") {
				g.reviewing = false;
				g.verdict = "pending";
				g.status = "目标已暂停";
				g.statusEn = "Goal paused";
			} else {
				g.reviewing = false;
			}
		}
		if (conv.id === this.activeId) {
			this.emitGoalStatus();
			this.flushSnapshot();
		}
	}

	async setGoal(
		goal: string,
		opts?: {
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
			execModel?: string;
		},
	): Promise<void> {
		if (goal.trim() === "") {
			await this.clearGoal();
			return;
		}
		if (this.quiesceBlocked()) return;
		if (this.settings.goalModeEnabled === false) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "目标模式已关闭：请先在设置「目标审查」中启用目标模式。",
				textEn: "Goal mode is off: enable it under Settings → Goal review first.",
			});
			return;
		}
		const conv = this.conv;
		const text = goal.trim();
		const g = conv.goal;
		g.goal = text;
		g.conversationId = conv.id;
		g.reviewModel = opts?.reviewModel ?? g.reviewModel;
		g.maxRounds = opts?.maxRounds ?? g.maxRounds;
		g.locked = opts?.locked ?? g.locked;
		const effectiveMax = g.locked ? g.maxRounds : 1;
		g.round = 0;
		g.reviewing = true;
		g.verdict = "pending";
		g.feedback = undefined;
		g.status = "目标已设，等待生成…";
		g.statusEn = "Goal set, waiting to generate…";
		this.goalPrefs = { reviewModel: g.reviewModel, maxRounds: g.maxRounds, locked: g.locked };
		this.stateStore.saveGoalPrefs(this.clientId, {
			reviewModel: g.reviewModel,
			maxRounds: g.maxRounds,
			locked: g.locked,
		});
		this.emitGoalStatus();
		this.emit({
			type: "notice",
			level: "info",
			text: `🎯 已设目标：${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`,
			textEn: `🎯 Goal set: ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`,
		});
		try {
			const res = (await this.runtime.goalSet(conv.sessionId, text, effectiveMax > 0 ? effectiveMax : undefined)) as {
				goal?: { maxGoalRounds?: number } | null;
			};
			if (res?.goal?.maxGoalRounds) g.maxRounds = res.goal.maxGoalRounds;
		} catch (err) {
			g.reviewing = false;
			g.status = `目标设置失败：${(err as Error).message}`;
			g.statusEn = `Goal setup failed: ${(err as Error).message}`;
			this.emit({
				type: "notice",
				level: "error",
				text: `目标设置失败：${(err as Error).message}`,
				textEn: `Goal setup failed: ${(err as Error).message}`,
			});
		}
		this.emitGoalStatus();
		this.flushSnapshot();
	}

	async clearGoal(): Promise<void> {
		const conv = this.conv;
		if (conv.turnWaiter) {
			const w = conv.turnWaiter;
			conv.turnWaiter = undefined;
			w.reject(new Error(pick(this.getLang(), "调研已取消", "Survey cancelled", "dsh.survey.cancelled")));
		}
		if (conv.dsGoal) {
			try {
				await this.runtime.goalClear(conv.sessionId);
			} catch {}
		}
		conv.dsGoal = null;
		const g = conv.goal;
		g.goal = null;
		g.conversationId = null;
		g.reviewing = false;
		g.verdict = "pending";
		g.feedback = undefined;
		g.status = "";
		g.statusEn = "";
		this.emitGoalStatus();
		this.flushSnapshot();
	}

	async startGoalWizard(
		text: string,
		opts?: { wizardModel?: string; maxRounds?: number; locked?: boolean },
	): Promise<void> {
		if (this.quiesceBlocked()) return;
		if (this.settings.goalModeEnabled === false) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "目标模式已关闭：请先在设置「目标审查」中启用目标模式。",
				textEn: "Goal mode is off: enable it under Settings → Goal review first.",
			});
			return;
		}
		const conv = this.conv;
		const draft = (text ?? "").trim();
		if (!draft) return;
		const g = conv.goal;
		if (g.goal || g.reviewing || g.wizard.active) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "已有目标或调研进行中，请先完成或清除",
				textEn: "A goal or survey is already active — finish or clear it first",
			});
			return;
		}
		g.wizard.active = true;
		g.wizard.draft = draft;
		g.wizard.model = opts?.wizardModel ?? null;
		g.wizard.step = 0;
		g.wizard.maxSteps = 6;
		g.wizard.status = "调研中…";
		g.wizard.statusEn = "Scoping…";
		g.status = "目标调研中…";
		g.statusEn = "Scoping the goal…";
		this.emitGoalStatus();
		this.emit({
			type: "notice",
			level: "info",
			text: `🔍 正在围绕需求展开调研：${draft.slice(0, 60)}${draft.length > 60 ? "…" : ""}`,
			textEn: `🔍 Surveying the requirement: ${draft.slice(0, 60)}${draft.length > 60 ? "…" : ""}`,
		});
		try {
			const waiter = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(
					() =>
						reject(
							new Error(
								pick(this.getLang(), "调研超时（10 分钟）", "Survey timed out (10 minutes)", "dsh.survey.timeout"),
							),
						),
					10 * 60_000,
				);
				timer.unref?.();
				conv.turnWaiter = {
					resolve: () => {
						clearTimeout(timer);
						resolve();
					},
					reject: (err) => {
						clearTimeout(timer);
						reject(err);
					},
				};
			});
			await this.promptConv(conv, this.wizardPrompt(draft));
			await waiter;
		} catch (err) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `目标调研中断：${(err as Error).message}`,
				textEn: `Goal survey interrupted: ${(err as Error).message}`,
			});
		}
		conv.turnWaiter = undefined;
		g.wizard.active = false;
		g.wizard.step = 0;
		g.wizard.status = "";
		g.wizard.statusEn = "";
		const finalText = this.lastAssistantText(conv);
		const goalMatch = finalText.match(/GOAL\s*[:：]\s*([\s\S]*)/i);
		let refined = goalMatch ? goalMatch[1]!.trim() : "";
		if (!refined) {
			refined =
				finalText
					.split("\n")
					.filter((l) => l.trim())
					.pop()
					?.trim() ?? "";
			if (refined.length > 300) refined = refined.slice(0, 300);
		}
		if (!refined && g.goal) {
			this.emitGoalStatus();
			this.emit({
				type: "notice",
				level: "info",
				text: "🎯 调研完成，目标已由模型创建",
				textEn: "🎯 Survey done; the model created the goal",
			});
			return;
		}
		this.emitGoalStatus();
		if (refined) {
			await this.setGoal(refined, {
				reviewModel: opts?.wizardModel,
				maxRounds: opts?.maxRounds,
				locked: opts?.locked,
			});
			this.emit({
				type: "notice",
				level: "info",
				text: `🎯 调研完成，目标已设为：${refined.slice(0, 80)}${refined.length > 80 ? "…" : ""}`,
				textEn: `🎯 Survey done, goal set: ${refined.slice(0, 80)}${refined.length > 80 ? "…" : ""}`,
			});
		} else {
			this.emit({
				type: "notice",
				level: "warning",
				text: "调研未产出有效目标，请重试",
				textEn: "The survey produced no usable goal — retry",
			});
		}
	}

	private wizardPrompt(draft: string): string {
		return [
			`You are a goal-clarification wizard. The user stated a raw requirement. Your job is to turn it into ONE precise, actionable goal that a coding agent can fully satisfy.`,
			``,
			`# User's raw requirement`,
			draft,
			``,
			`Use the ask_user_question tool to ask the user focused questions to pin down the essential, ambiguous details. Ask ONE question at a time, strictly 1 to 3 questions total: what exactly to build/do, scope boundaries (what NOT to do), acceptance criteria / done-definition, and any constraints (style, performance, environment). Prefer 2 to 4 mutually exclusive options with the recommended choice placed FIRST, and explain the tradeoff in description.`,
			`Once you have enough to write an unambiguous, reviewable goal, STOP asking and reply with EXACTLY this format and nothing else (no preamble, no bullets):`,
			`GOAL: <one concrete, verifiable sentence describing the deliverable and its acceptance criteria>`,
			`Do NOT call create_goal or update_goal — just output the GOAL: line. If the user cancels or stops answering, still produce a sensible best-effort GOAL from what you already know.`,
		].join("\n");
	}

	private lastAssistantText(conv: DshConversation): string {
		for (let i = conv.messages.length - 1; i >= 0; i--) {
			const m = conv.messages[i]!;
			if (m.role === "assistant") {
				return m.content.map((c) => ("text" in c ? c.text : "")).join("");
			}
		}
		return "";
	}

	async setGoalPrefs(opts?: {
		reviewModel?: string;
		maxRounds?: number;
		locked?: boolean;
		execModel?: string;
	}): Promise<void> {
		const g = this.conv.goal;
		if (opts?.reviewModel !== undefined) g.reviewModel = opts.reviewModel;
		if (opts?.maxRounds !== undefined) g.maxRounds = opts.maxRounds;
		if (opts?.locked !== undefined) g.locked = opts.locked;
		this.goalPrefs = { reviewModel: g.reviewModel, maxRounds: g.maxRounds, locked: g.locked };
		this.stateStore.saveGoalPrefs(this.clientId, {
			reviewModel: g.reviewModel,
			maxRounds: g.maxRounds,
			locked: g.locked,
		});
		this.emitGoalStatus();
	}

	async listCommands(): Promise<void> {
		const { commands, path } = await loadCommands(this.cwd);
		this.emit({ type: "commands", commands, path });
	}

	async saveCommands(commands: CommandDef[]): Promise<void> {
		const { path, error } = await saveCommandsFile(this.cwd, commands);
		if (error) {
			this.emit({
				type: "notice",
				level: "error",
				text: `保存命令失败：${error}`,
				textEn: `Failed to save command: ${error}`,
			});
		} else {
			this.emit({ type: "notice", level: "info", text: `命令已保存（${path}）`, textEn: `Command saved (${path})` });
		}
	}

	async pushSlashCommands(): Promise<void> {
		const commands: {
			name: string;
			description?: string;
			descriptionEn?: string;
			argumentHint?: string;
			argumentHintEn?: string;
			source: "builtin" | "plugin" | "skill";
		}[] = [];
		const seen = new Set<string>();
		for (const c of NATIVE_COMMANDS) {
			commands.push({ ...c, source: "builtin" });
			seen.add(c.name);
		}
		for (const s of this.skillsCache) {
			const name = `skill:${s.name}`;
			if (seen.has(name)) continue;
			commands.push({
				name,
				description: s.description,
				source: "skill",
			});
			seen.add(name);
		}
		const diskSkills = discoverDiskSkills({ cwd: this.cwd, agentDir: this.agentDir });
		for (const s of diskSkills) {
			const name = `skill:${s.name}`;
			if (seen.has(name)) continue;
			commands.push({
				name,
				description: s.description,
				source: "skill",
			});
			seen.add(name);
		}
		for (const cmd of this.pluginCommandsProvider?.() ?? []) {
			if (seen.has(cmd.name)) continue;
			commands.push({
				name: cmd.name,
				description: cmd.description,
				descriptionEn: cmd.descriptionEn,
				argumentHint: cmd.argumentHint,
				argumentHintEn: cmd.argumentHintEn,
				source: "plugin",
			});
			seen.add(cmd.name);
		}
		this.emit({ type: "slash_commands", commands });
	}

	private async execSlash(name: string, args: string): Promise<boolean> {
		if (name.startsWith("skill:")) {
			const skillName = name.slice(6);
			const diskSkills = discoverDiskSkills({ cwd: this.cwd, agentDir: this.agentDir });
			const found = diskSkills.find((s) => s.name.toLowerCase() === skillName.toLowerCase());
			if (found) {
				const instruction = readSkillInstruction(found.filePath);
				const skillPrompt = instruction
					? `[Skill: ${found.name}]\n${instruction}\n\n[User Prompt]\n${args || "执行此技能"}`
					: args || name;
				await this.prompt(skillPrompt);
				return true;
			}
		}
		switch (name) {
			case "new": {
				const first = args.trim();
				if ((await this.newChat()) && first) await this.prompt(first);
				return true;
			}
			case "model": {
				if (!args.trim()) {
					this.emit({
						type: "notice",
						level: "info",
						text: `当前模型：${this.model}。用法：/model <名称>`,
						textEn: `Current model: ${this.model}. Usage: /model <name>`,
					});
					return true;
				}
				const q = args.trim().toLowerCase();
				const all = [
					...DSH_MODELS,
					...[...this.dynamicModels].map((id) => ({ id, name: id })),
					...[...this.customModelsMap.values()].map((m) => ({ id: m.id, name: m.name })),
				];
				const hit = all.find((m) => m.id === q || m.name?.toLowerCase().includes(q));
				if (hit) {
					await this.setModel(hit.id);
				} else {
					this.emit({
						type: "notice",
						level: "error",
						text: `没有匹配到模型：${args.trim()}（可用模型见顶栏模型列表）`,
						textEn: `No matching model: ${args.trim()} (see the model list in the top bar)`,
					});
				}
				return true;
			}
			case "cwd": {
				if (!args.trim()) {
					this.emit({
						type: "notice",
						level: "info",
						text: `当前工作目录：${this.cwd}`,
						textEn: `Current directory: ${this.cwd}`,
					});
					return true;
				}
				await this.setCwd(args.trim());
				return true;
			}
			case "resume":
				await this.refreshSessions();
				return true;
			case "help":
				return true;
			case "copy":
				return true;
			case "reload":
				this.emit({
					type: "notice",
					level: "info",
					text: "已重新加载（DSH 引擎无扩展/技能热重载，运行时能力内置）",
					textEn: "Reloaded (the DSH engine has no extension/skill hot-reload; runtime capabilities are built in)",
				});
				await this.pushSlashCommands();
				return true;
			case "compact":
				this.emit({
					type: "notice",
					level: "info",
					text: "DSH 引擎不支持上下文压缩（运行时自动管理）",
					textEn: "The DSH engine does not support context compaction (the runtime manages it)",
				});
				return true;
			case "thinking":
				this.emit({
					type: "notice",
					level: "info",
					text: "DeepSeek V4 仅支持高思考强度",
					textEn: "DeepSeek V4 only supports high thinking intensity",
				});
				return true;
			case "pi-web-ui:quit":
				this.onQuit?.();
				return true;
		}
		const def = this.pluginCommandsProvider?.().find((c) => c.name === name);
		if (def) {
			try {
				const result = await def.run(args, { clientId: this.clientId });
				if (typeof result === "string" && result.trim()) {
					this.emit({ type: "notice", level: "info", text: result, textEn: result });
				}
			} catch (err) {
				this.emit({
					type: "notice",
					level: "error",
					text: `插件命令 /${name} 执行失败：${(err as Error).message}`,
					textEn: `Plugin command /${name} failed: ${(err as Error).message}`,
				});
			}
			return true;
		}
		return false;
	}

	static currentAppVersion(): string {
		return getAppVersion() || "0.0.0";
	}

	async checkUpdate(): Promise<void> {
		try {
			const npmRegistry = resolveNpmRegistry(join(homedir(), ".pi", "agent"));
			const latest = await checkAllUpdates(
				[{ name: "pi-web-ui", version: DshClientSession.currentAppVersion(), kind: "webui" }],
				undefined,
				() => this.getLang(),
				npmRegistry,
			);
			const item = latest[0];
			this.emit({
				type: "update_status",
				current: item.current,
				latest: item.latest,
				latestPublishedAt: item.latestPublishedAt ?? null,
				upToDate: item.upToDate,
				error: item.error,
			});
		} catch (err) {
			this.emit({
				type: "update_status",
				current: DshClientSession.currentAppVersion(),
				latest: null,
				latestPublishedAt: null,
				upToDate: true,
				error: (err as Error).message,
			});
		}
	}

	async checkUpdatesAll(force = false): Promise<void> {
		try {
			const targets = collectTargets(join(homedir(), ".pi", "agent"), DshClientSession.currentAppVersion(), undefined, {
				projectCwd: this.cwd,
				extraTargets: collectInstalledEngineTargets(),
			});
			const items = await checkAllUpdates(
				targets,
				undefined,
				() => this.getLang(),
				resolveNpmRegistry(join(homedir(), ".pi", "agent")),
			);
			if (force) {
				void items;
			}
			this.emit({
				type: "update_status_all",
				items: items.map((i) => ({
					name: i.name,
					kind: i.kind,
					current: i.current,
					latest: i.latest,
					latestPublishedAt: i.latestPublishedAt ?? null,
					upToDate: i.upToDate,
					error: i.error,
					...(i.source ? { source: i.source } : {}),
				})),
			});
		} catch {
			this.emit({ type: "update_status_all", items: [] });
		}
	}

	async installPiAgent(): Promise<void> {
		this.emit({
			type: "install_result",
			ok: true,
			detail: pick(
				this.getLang(),
				"DSH 引擎不需要 pi CLI",
				"The DSH engine does not need the pi CLI",
				"dsh.engine.no.cli",
			),
		});
	}

	private isDshConfigured(): boolean {
		if (loadDeepSeekKey(this.agentDir) || process.env.DEEPSEEK_API_KEY) return true;
		if (this.modelProvider && this.modelProvider !== "deepseek") {
			const cred = resolveProviderCredential(this.agentDir, this.modelProvider);
			if (cred.apiKey) return true;
		}
		try {
			const custom = listCustomModelsFromConfig(this.agentDir, (entry) =>
				isModelProtocolSupportedByEngine("dsh", entry),
			);
			if (custom.length > 0) {
				for (const c of custom) {
					if (resolveProviderCredential(this.agentDir, c.providerId).apiKey) return true;
				}
			}
		} catch {}
		return false;
	}

	private normalizeDshProvider(provider: string): string {
		const pid = provider.trim();
		return pid === "deepseek-official" ? "deepseek" : pid;
	}

	async setProviderApiKey(provider: string, apiKey: string): Promise<void> {
		await this.modelAdmin.setProviderApiKey(provider, apiKey);
		if (this.runtime.alive && (provider === "deepseek" || provider === "deepseek-official")) {
			await this.runtime.restart(this.model);
		}
		this.flushSnapshot();
	}

	async clearProviderApiKey(provider: string): Promise<void> {
		await this.modelAdmin.clearProviderApiKey(provider);
		if (this.runtime.alive && (provider === "deepseek" || provider === "deepseek-official")) {
			await this.runtime.restart(this.model);
		}
		this.flushSnapshot();
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

	async logoutProviderOAuth(provider: string): Promise<void> {
		return this.modelAdmin.logoutProviderOAuth(provider);
	}

	async listModelsConfig(): Promise<void> {
		return this.modelAdmin.listModelsConfig();
	}

	async reloadModelsConfig(): Promise<void> {
		return this.modelAdmin.reloadModelsConfig();
	}

	async saveModelConfig(providerId: string, config: unknown): Promise<void> {
		await this.modelAdmin.saveModelConfig(providerId, config as any);
		if (this.runtime.alive && (providerId === "deepseek" || providerId === "deepseek-official")) {
			await this.runtime.restart(this.model);
		}
	}

	deleteModelConfig(providerId: string): Promise<void> {
		return this.modelAdmin.deleteModelConfig(providerId).then(async () => {
			if (this.runtime.alive && (providerId === "deepseek" || providerId === "deepseek-official")) {
				await this.runtime.restart(this.model);
			}
		});
	}

	async listProviders(): Promise<void> {
		return this.modelAdmin.listProviders();
	}

	listProviderKeys(): void {
		this.modelAdmin.listProviderKeys();
	}

	async addProviderKey(provider: string, apiKey: string, name?: string): Promise<void> {
		await this.modelAdmin.addProviderKey(provider, apiKey, name);
		if (this.runtime.alive && (provider === "deepseek" || provider === "deepseek-official")) {
			await this.runtime.restart(this.model);
		}
	}

	async activateProviderKey(provider: string, keyName: string): Promise<void> {
		await this.modelAdmin.activateProviderKey(provider, keyName);
		if (this.runtime.alive && (provider === "deepseek" || provider === "deepseek-official")) {
			await this.runtime.restart(this.model);
		}
	}

	async removeProviderKey(provider: string, keyName: string): Promise<void> {
		await this.modelAdmin.removeProviderKey(provider, keyName);
		if (this.runtime.alive && (provider === "deepseek" || provider === "deepseek-official")) {
			await this.runtime.restart(this.model);
		}
	}

	async fetchModelsList(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		providerId?: string,
	): Promise<void> {
		return this.modelAdmin.fetchModelsList(reqId, baseUrl, apiKey, authHeader, api, () => this.getLang(), providerId);
	}

	async testModelConnection(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		providerId?: string,
	): Promise<void> {
		return this.modelAdmin.testConnection(reqId, baseUrl, apiKey, authHeader, api, () => this.getLang(), providerId);
	}

	async refreshProviderModels(providerId: string, reqId: number): Promise<void> {
		return this.modelAdmin.refreshProviderModels(providerId, reqId, () => this.getLang());
	}

	async refreshBuiltinModels(reqId: number): Promise<void> {
		return this.modelAdmin.refreshBuiltinModels(reqId);
	}

	async appendBuiltinModel(providerId: string, model: unknown, reqId: number): Promise<void> {
		return this.modelAdmin.appendBuiltinModel(providerId, model as any, reqId);
	}

	async cloneProvider(provider: string, reqId: number): Promise<void> {
		return this.modelAdmin.cloneProvider(provider, reqId);
	}

	async enrichModels(reqId: number, ids: string[], hints?: Record<string, string>): Promise<void> {
		return this.modelAdmin.enrichModels(reqId, ids, hints);
	}

	abortEnrichModels(reqId?: number): void {
		this.modelAdmin.abortEnrichModels(reqId);
	}

	resolveDialog(_id: number, _value: string | boolean | null): void {}

	async editMessage(messageId: string, text: string, attachments?: PromptAttachment[]): Promise<void> {
		if (this.quiesceBlocked() || this.switchingWorkspace || this.disposed) return;
		if (!text.trim() && !attachments?.length) return;
		let recoverRuntime: (() => Promise<void>) | undefined;
		try {
			const conv = this.conv;
			const idx = conv.messages.findIndex((m) => m.id === messageId);
			if (idx < 0) {
				this.emit({
					type: "notice",
					level: "warning",
					text: "找不到要编辑的消息",
					textEn: "Message to edit not found",
				});
				return;
			}
			if (conv.messages[idx]?.role !== "user") return;
			if ([...this.convs.values()].some((c) => c.isStreaming)) {
				throw new Error("Wait for running conversations to finish before editing DSH history");
			}
			const runtime = this.runtime;
			const sessionId = conv.sessionId;
			const generation = this.workspaceGeneration;
			const current = () =>
				!this.disposed &&
				!this.switchingWorkspace &&
				this.workspaceGeneration === generation &&
				this.runtime === runtime &&
				conv.sessionId === sessionId &&
				this.convs.get(conv.id) === conv;
			const file = this.guessSessionFile(conv);
			if (!file) throw new Error("Persisted DSH session log not found; history was not changed");
			const loaded = [...this.convs.values()].filter((c) => !c.fromDisk && this.guessSessionFile(c));
			recoverRuntime = async () => {
				if (!current()) return;
				await runtime.start();
			};
			for (const sibling of loaded) sibling.fromDisk = true;
			await runtime.kill();
			if (!current()) return;
			const log = readSessionLog(file);
			const eventIndex = log.events.findIndex((e) => e.type === "user/message" && `u-${e.data.id}` === messageId);
			if (!log.header || eventIndex < 0) throw new Error("Question not found in persisted DSH history");
			const saved =
				[{ ...log.header, type: "session" }, ...log.events.slice(0, eventIndex)]
					.map((e) => JSON.stringify(e))
					.join("\n") + "\n";
			writeAtomicSync(file, file.endsWith(".zstd") ? zstdCompressSync(Buffer.from(saved)) : saved, { fsync: true });
			let cutIdx = idx;
			while (
				cutIdx > 0 &&
				conv.messages[cutIdx - 1]?.role === "custom" &&
				(conv.messages[cutIdx - 1] as { customType?: string })?.customType === "file"
			) {
				cutIdx--;
			}
			conv.messages.splice(cutIdx);
			conv.messageIds = new Set(conv.messages.map((m) => m.id));
			conv.queue.steering.length = 0;
			conv.queue.followUp.length = 0;
			this.flushSnapshot(true);
			await runtime.start();
			if (!current()) return;
			await (runtime as unknown as { _request(method: string, params: unknown): Promise<unknown> })._request(
				"session/resume",
				{ sessionId },
			);
			if (!current()) return;
			conv.fromDisk = false;
			await this.promptConv(conv, text, attachments);
			this.emitConversations();
			this.flushSnapshot(true);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `编辑重问失败：${(err as Error).message}`,
				textEn: `Edit-and-reask failed: ${(err as Error).message}`,
			});
		} finally {
			try {
				await recoverRuntime?.();
			} catch (err) {
				this.emit({
					type: "notice",
					level: "error",
					text: `运行时恢复失败：${(err as Error).message}`,
					textEn: `Runtime recovery failed: ${(err as Error).message}`,
				});
			}
		}
	}

	getLang(): ServerLang {
		return resolveServerLang(this.stateStore.get(this.clientId).locale);
	}

	async setLocale(locale: string): Promise<void> {
		const code = locale.trim().slice(0, 16);
		if (!code) return;
		this.stateStore.saveLocale(this.clientId, code);
	}

	async setWorkspaceRoots(roots?: string[]): Promise<void> {
		const before = this.stateStore.getWorkspaceRoots(this.clientId, this.cwd);
		this.stateStore.saveWorkspaceRoots(this.clientId, this.cwd, roots ?? []);
		const saved = this.stateStore.getWorkspaceRoots(this.clientId, this.cwd);
		if (saved.length === before.length && saved.every((p, i) => p === before[i])) return;
		this.roots = saved;
		this.flushSnapshot();
	}

	async setCwd(newCwd: string): Promise<void> {
		assertEngineWorkspaceSupported(this.sandboxes, resolve(newCwd), "dsh");
		if (this.switchingWorkspace) return;
		this.switchingWorkspace = true;
		this.workspaceGeneration++;
		try {
			const abs = resolve(newCwd);
			if (!existsSync(abs) || !statSync(abs).isDirectory()) {
				this.emit({
					type: "transition_progress",
					kind: "cwd",
					target: newCwd,
					phase: "error",
					progress: 100,
					text: `切换工作目录失败：目录不存在：${newCwd}`,
					textEn: `Failed to switch directory; does not exist: ${newCwd}`,
				});
				this.emit({
					type: "notice",
					level: "error",
					text: `切换工作目录失败：目录不存在：${newCwd}`,
					textEn: `Failed to switch directory; does not exist: ${newCwd}`,
				});
				return;
			}
			if (abs === this.cwd) {
				this.emit({
					type: "transition_progress",
					kind: "cwd",
					target: abs,
					phase: "done",
					progress: 100,
					text: `已在工作目录：${abs}`,
					textEn: `Already in directory: ${abs}`,
				});
				return;
			}
			this.emit({
				type: "transition_progress",
				kind: "cwd",
				target: abs,
				phase: "runtime",
				progress: 45,
				text: `正在切换工作目录并重启运行环境：${abs}`,
				textEn: `Switching workspace & restarting runtime: ${abs}`,
			});
			await new Promise<void>((r) => setImmediate(r));
			const savedModel =
				this.stateStore.getProjectModel(this.clientId, abs, "dsh") ?? this.stateStore.getDefaultModel("dsh");
			const previousModel = this.model;
			const previousProvider = this.modelProvider;
			if (savedModel) this.applySavedModel(savedModel);
			try {
				await this.runtime.restart(this.model, this.modelProvider, abs);
			} catch (err) {
				this.model = previousModel;
				this.modelProvider = previousProvider;
				await this.runtime.kill();
				this.runtime.cwd = this.cwd;
				this.runtime.model = previousModel;
				this.runtime.modelProvider = previousProvider;
				throw err;
			}
			this.cwd = abs;
			this.roots = this.stateStore.getWorkspaceRoots(this.clientId, abs);
			this.stateStore.remember(this.clientId, abs);
			const prev = this.conv;
			prev.listed = this.shouldRetainDshConversation(prev) || prev.messages.length > 0;
			const openRecent = this.settings.openRecentSessionOnProjectSwitch ?? true;
			const recentFiles = openRecent
				? findSessionFilesForCwd(this.sessionRoot, abs).filter((f) => !basename(dirname(f)).startsWith("review-"))
				: [];
			let resumedConv: DshConversation | null = null;
			for (const file of recentFiles) {
				try {
					const { events } = readSessionLog(file);
					const hasRealMessages = events.some(
						(e) =>
							(e.type === "user/message" && !isDshInternalUserMessage(e.data as Record<string, unknown>)) ||
							e.type === "assistant/message",
					);
					if (hasRealMessages) {
						const sid = basename(dirname(file));
						const conv = this.addConversation(sid, abs, true, undefined, file);
						conv.fromDisk = true;
						conv.sessionFile = file;
						resumedConv = conv;
						break;
					}
				} catch {
					continue;
				}
			}
			this.activeId = (resumedConv ?? this.addConversation(`web-${randomUUID().slice(0, 12)}`, abs, false)).id;
			// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
			for (const [id, c] of [...this.convs]) {
				if (id === this.activeId) continue;
				if (c.cwd === abs) continue;
				if (c.listed) continue;
				if (c.isStreaming) continue;
				this.removeConversation(id);
			}
			this.onCwdChanged?.(abs);
			this.emit({
				type: "transition_progress",
				kind: "cwd",
				target: abs,
				phase: "done",
				progress: 100,
				text: `已切换到工作目录：${abs}`,
				textEn: `Switched to directory: ${abs}`,
			});
			this.emitConversations();
			void this.pushSessions();
			void this.pushProjects();
			void this.listFiles(undefined);
			this.pushTerminals();
			this.pushSettings();
			this.flushSnapshot(true);
		} catch (err) {
			this.emit({
				type: "transition_progress",
				kind: "cwd",
				target: newCwd,
				phase: "error",
				progress: 100,
				text: `切换目录失败：${(err as Error).message}`,
				textEn: `Failed to switch directory: ${(err as Error).message}`,
			});
			this.emit({
				type: "notice",
				level: "error",
				text: `切换目录失败：${(err as Error).message}`,
				textEn: `Failed to switch directory: ${(err as Error).message}`,
			});
		} finally {
			this.switchingWorkspace = false;
			if (this.runtime.cwd === this.cwd && this.runtime.alive) this.runtime.onStarted?.();
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelBridgedTools();
		if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
		if (this.sessionsTimer) clearTimeout(this.sessionsTimer);
		if (this.reclaimTimer) {
			clearInterval(this.reclaimTimer);
			this.reclaimTimer = null;
		}
		if (this.retentionTimer) {
			clearInterval(this.retentionTimer);
			this.retentionTimer = null;
		}
		if (this.retentionOnce) {
			clearTimeout(this.retentionOnce);
			this.retentionOnce = null;
		}
		this.bg.stop();
		this.modelAdmin.dispose();
		for (const conv of this.convs.values()) conv.terminals.killAll();
		this.userTerminals?.killAll();
		try {
			await this.runtime.close();
		} catch {}
	}

	async readQuickAskConversation(
		source: import("../quick-ask-context.js").QuickAskConversationSource,
		signal: AbortSignal,
	): Promise<import("../quick-ask-context.js").QuickAskConversationSnapshot | undefined> {
		signal.throwIfAborted();
		const conv = source.conversationId
			? this.convs.get(source.conversationId)
			: source.sessionFile
				? [...this.convs.values()].find(
						(candidate) =>
							candidate.sessionFile &&
							normalizePathKey(candidate.sessionFile) === normalizePathKey(source.sessionFile!),
					)
				: undefined;
		if (conv) {
			const file = this.guessSessionFile(conv);
			if (source.sessionFile && (!file || normalizePathKey(file) !== normalizePathKey(source.sessionFile)))
				return undefined;
			return captureQuickAskConversation(conv.title, file ?? undefined, conv.messages, conv.cwd);
		}
		if (!source.sessionFile) return undefined;
		const cwd = this.cwd;
		const file = findSessionFilesForCwd(this.sessionRoot, cwd).find(
			(candidate) => normalizePathKey(candidate) === normalizePathKey(source.sessionFile!),
		);
		if (!file || statSync(file).size > 16 * 1024 * 1024) return undefined;
		const { events } = readSessionLog(file);
		signal.throwIfAborted();
		return captureQuickAskConversation(
			sessionLogTitle(events) || basename(dirname(file)),
			file,
			replayEventsToMessages(events),
			cwd,
		);
	}

	activeConversationId(): string {
		return this.activeId;
	}

	readConversationForPlugins(opts?: { clientId?: string }): PluginConversationSnapshot | null {
		if (opts?.clientId && opts.clientId !== this.clientId) return null;
		const conv = this.convs.get(this.activeId) ?? [...this.convs.values()][0];
		if (!conv) return null;
		return {
			clientId: this.clientId,
			conversationId: conv.id,
			isSubagent: false,
			sessionId: conv.sessionId,
			sessionFile: conv.sessionFile,
			title: conv.title,
			model: `${this.modelProvider}/${this.model}`,
			at: conv.lastEventAt || conv.createdAt,
			isStreaming: conv.isStreaming,
			messages: conv.messages,
			streamingMessage: conv.isStreaming && conv.messages.length ? conv.messages[conv.messages.length - 1] : null,
			stats: {
				totalMessages: conv.messages.length,
				tokens: { input: 0, output: 0, total: 0 },
				cost: 0,
			},
		};
	}

	listRunningForPlugins(): { id: string; title: string; cwd: string; kind: "running"; isStreaming: boolean }[] {
		const out: { id: string; title: string; cwd: string; kind: "running"; isStreaming: boolean }[] = [];
		for (const conv of this.convs.values()) {
			out.push({ id: conv.id, title: conv.title, cwd: conv.cwd, kind: "running", isStreaming: conv.isStreaming });
		}
		return out;
	}

	async listHistoryForPlugins(
		limit = 50,
	): Promise<{ id: string; title: string; cwd: string; kind: "history"; isStreaming: false }[]> {
		try {
			const files = findSessionFilesForCwd(this.sessionRoot, this.cwd);
			const out: { id: string; title: string; cwd: string; kind: "history"; isStreaming: false }[] = [];
			for (const file of files.slice(0, Math.max(0, limit))) {
				try {
					const { events } = readSessionLog(file);
					const title = sessionLogTitle(events) || firstUserText(events, this.getLang()) || basename(dirname(file));
					out.push({
						id: file,
						title: title.slice(0, 60),
						cwd: this.cwd,
						kind: "history",
						isStreaming: false,
					});
				} catch {}
			}
			return out;
		} catch {
			return [];
		}
	}

	async searchForPlugins(query: string, limit = 20): Promise<{ id: string; title: string }[]> {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		const out: { id: string; title: string }[] = [];
		for (const conv of this.convs.values()) {
			if (conv.title.toLowerCase().includes(q)) out.push({ id: conv.id, title: conv.title });
			if (out.length >= limit) return out;
		}
		try {
			const files = findSessionFilesForCwd(this.sessionRoot, this.cwd);
			for (const file of files) {
				try {
					const { events } = readSessionLog(file);
					const title = sessionLogTitle(events) || firstUserText(events, this.getLang()) || basename(dirname(file));
					if (title.toLowerCase().includes(q)) {
						out.push({ id: file, title: title.slice(0, 60) });
						if (out.length >= limit) break;
					}
				} catch {}
			}
		} catch {}
		return out;
	}

	async writeForPlugins(id: string, text: string): Promise<{ ok: boolean; error?: string }> {
		try {
			const conv = this.convs.get(id);
			if (!conv) return { ok: false, error: `未知对话：${id}` };
			if (!text.trim()) return { ok: false, error: "投递文本为空" };
			if (id !== this.activeId) await this.switchConversation(id);
			await this.prompt(text);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	async abortForPlugins(id: string): Promise<{ ok: boolean; error?: string }> {
		try {
			const conv = this.convs.get(id);
			if (!conv) return { ok: false, error: `未知对话：${id}` };
			if (conv.isStreaming) {
				await this.abort();
			}
			return { ok: true };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	async steerForPlugins(conversationId: string, text: string): Promise<{ ok: boolean; error?: string }> {
		try {
			if (!text.trim()) return { ok: false, error: "空消息" };
			const conv = this.convs.get(conversationId);
			if (!conv) return { ok: false, error: `未知对话：${conversationId}` };
			conv.queue.followUp.push(text.trim());
			return { ok: true };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	async listModelsForPlugins(): Promise<{ id: string; provider: string; vision: boolean }[]> {
		return [{ id: `${this.modelProvider}/${this.model}`, provider: this.modelProvider, vision: this.modelVision }];
	}
}

export class DshAgentService {
	private clients = new Map<string, DshClientSession>();
	private quiesced = false;
	private quiescedAt = 0;
	private socketCount = 0;
	private pending = new Map<string, Promise<DshClientSession>>();
	private stateStore: ClientStateStore;
	private dataDir: string;

	onQuit: (() => boolean) | undefined;
	onClientCwdChanged: ((cwd: string) => void) | undefined;
	onToolEvent:
		| ((ev: {
				phase: string;
				toolName: string;
				conversationId: string;
				durationMs?: number;
				isError?: boolean;
		  }) => void)
		| undefined;
	pluginToolsProvider: ((cwd?: string) => unknown[]) | undefined;
	pluginCommandsProvider: (() => PluginCommandDef[]) | undefined;
	pluginBgTasksProvider: (() => BgServer[]) | undefined;
	pluginStopBgTask: ((taskId: string) => boolean) | undefined;

	constructor(
		private cwd: string,
		stateFile: string | ClientStateStore,
		dataDir: string,
		private agentDir?: string,
	) {
		this.stateStore = typeof stateFile === "string" ? new ClientStateStore(stateFile) : stateFile;
		this.dataDir = dataDir;
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
			version: DshClientSession["currentAppVersion"] ? DshClientSession.currentAppVersion() : "0.0.0",
			cwd: this.cwd,
			...this.quiesceInfo(),
			connectedClients: this.socketCount,
			activeConversations: this.activeConversations(),
			pendingMessages: this.pendingMessages(),
			service: toServiceInfo(launchOrigin()),
		};
	}

	findSessionOwner(sessionId: string, excludeClientId: string): SessionOwnerInfo | null {
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			const conv = cs.findConversationBySessionId(sessionId);
			if (conv)
				return {
					clientId,
					convId: conv.id,
					title: conv.title,
					cwd: conv.cwd,
					isStreaming: conv.isStreaming,
					connected: cs.sinkCount() > 0,
				};
		}
		return null;
	}

	listProjectRunners(cwd: string, excludeClientId: string): ProjectRunnerInfo[] {
		const out: ProjectRunnerInfo[] = [];
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			for (const r of cs.streamingInCwd(cwd)) out.push({ clientId, title: r.title });
		}
		return out;
	}

	listExternalRunning(excludeClientId: string): ElsewhereRunning[] {
		const out: ElsewhereRunning[] = [];
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			for (const r of cs.streamingSummariesAll()) out.push(r);
		}
		return out;
	}

	pokeExternalRunning(excludeClientId: string): void {
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
				cs.emitNotice(msg.level, msg.text, msg.textEn);
			} catch {}
		}
	}

	async attach(clientId: string, send: (msg: ServerMessage) => void): Promise<DshClientSession> {
		let cs = this.clients.get(clientId);
		if (!cs) {
			if (this.quiesced) {
				throw new QuiesceRejectedError(
					bilingual("New connections rejected; retry after the server resumes", "新连接被拒绝，请等服务器恢复后重试"),
				);
			}
			let cwd = this.cwd;
			const saved = this.stateStore.get(clientId);
			if (saved.lastCwd && saved.lastCwd !== this.cwd) {
				try {
					if (statSync(saved.lastCwd).isDirectory()) cwd = saved.lastCwd;
				} catch {}
			}
			cs = DshClientSession.create(clientId, cwd, this.stateStore, this.dataDir, this.agentDir);
			this.clients.set(clientId, cs);
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
		cs.attachSink(send);
		cs.onQuit = this.onQuit;
		cs.onToolEvent = this.onToolEvent;
		cs.pluginToolsProvider = this.pluginToolsProvider;
		cs.pluginCommandsProvider = this.pluginCommandsProvider;
		cs.pluginBgTasksProvider = this.pluginBgTasksProvider;
		cs.pluginStopBgTask = this.pluginStopBgTask;
		cs.isQuiesced = () => this.quiesced;
		cs.findSessionOwnerById = (sessionId) => this.findSessionOwner(sessionId, clientId);
		cs.listProjectRunners = (cwd) => this.listProjectRunners(cwd, clientId);
		cs.listExternalRunning = () => this.listExternalRunning(clientId);
		cs.notifyExternalClients = (msg) => this.notifyClientsExcept(clientId, msg);
		cs.onRunningChanged = () => this.pokeExternalRunning(clientId);
		cs.onCwdChanged = (abs) => this.onClientCwdChanged?.(abs);
		this.onClientCwdChanged?.(cs.cwd);
		return cs;
	}

	async setLocale(clientId: string, locale: string): Promise<void> {
		const cs = this.clients.get(clientId);
		if (cs) await cs.setLocale(locale);
	}

	mcpProjectCwds(): string[] {
		return [...new Set([...this.clients.values()].flatMap((cs) => cs.mcpProjectCwds()))];
	}

	applyPluginAgentTools(): void {
		for (const cs of this.clients.values()) void cs.syncPluginTools();
	}

	applyPluginCommandCatalog(): void {
		for (const cs of this.clients.values()) void cs.pushSlashCommands();
	}

	applyPluginMarkers(): void {
		for (const cs of this.clients.values()) cs.pushSettings();
	}

	refreshBackgroundServers(): void {
		for (const cs of this.clients.values()) cs.refreshBgTasks();
	}

	detach(clientId: string, send: (msg: ServerMessage) => void): void {
		this.clients.get(clientId)?.detachSink(send);
	}

	get(clientId: string): DshClientSession | undefined {
		return this.clients.get(clientId);
	}

	async disposeAll(): Promise<void> {
		for (const cs of this.clients.values()) {
			try {
				await cs.dispose();
			} catch {}
		}
		this.clients.clear();
	}

	getCapabilities(): AgentEngineCapabilities {
		return DEFAULT_DSH_CAPABILITIES;
	}

	recordInterruptedRuns(): void {}

	pluginClient(): DshClientSession | undefined {
		let fallback: DshClientSession | undefined;
		for (const cs of this.clients.values()) {
			if (!fallback) fallback = cs;
			try {
				if (cs.activeConversations() > 0) return cs;
			} catch {}
		}
		return fallback;
	}

	readConversationForPlugins(opts?: PluginConversationQuery): PluginConversationSnapshot | null {
		const targetId = opts?.clientId;
		if (targetId) {
			const cs = this.clients.get(targetId);
			return cs ? cs.readConversationForPlugins({ clientId: targetId }) : null;
		}
		for (const cs of this.clients.values()) {
			const s = cs.readConversationForPlugins();
			if (s) return s;
		}
		return null;
	}

	async chatFromPlugin(
		pluginId: string,
		req: PluginChatRequest,
	): Promise<{ conversationId: string; clientId: string }> {
		const cs = this.pluginClient();
		if (!cs) throw new Error("无可用客户端会话");
		const targetConvId = req.conversationId || cs.activeConversationId();
		await cs.prompt(req.text);
		return { conversationId: targetConvId, clientId: cs.clientId };
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
			const cs = this.pluginClient();
			const agentDir = this.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? "";
			const env = { cwd: cs?.cwd ?? this.cwd, agentDir };
			const mod = await import("../plugin-llm.js");
			const r = await mod.completeWithIsolatedSession(env, { ...req, prompt: String(req?.prompt ?? "") });
			if (!r.ok) return r;
			console.log(`[plugin:${pluginId}] dsh llm.complete ok（模型 ${r.model}，输出 ${r.text.length} 字）`);
			return r;
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}
}
