import type { ParsedToken, ApplyResult, MarkerOverlay, MarkerContext, MarkerTool } from "./markers/index.js";
import { registerMarker, unregisterMarker, isBuiltinMarker } from "./markers/index.js";
import {
	ensurePluginAsset,
	getPluginAssetStatus,
	type PluginAssetSpec,
	type PluginAssetStatus,
	type PluginAssetResult,
	type PluginAssetProgress,
} from "./plugin-assets.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { ttsService, type TtsClient, type TtsEngine } from "./tts-service.js";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, watch as fsWatch, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { writeJsonAtomicSync } from "./atomic-file.js";
import { normalizePluginChatAttachments } from "./plugin-chat-attachments.js";
import {
	type ServerMessage,
	type UiMessage,
	type UiPluginAgentTool,
	type UiPluginInfo,
	type PluginRequires,
	type PluginApiCatalog,
	type UiContribution,
	type UiAlign,
	type UiArrangeOp,
	type UiPluginUi,
	type BgServer,
	type UiPluginSettingField,
	type UiSelectOption,
	type UiPluginCatalogEntry,
	type PluginBusEvent,
	type PluginModelInfo,
	type PluginStats,
	type PromptAttachment,
} from "./protocol.js";
import { UI_SLOTS } from "./plugin-ui-slots.js";
import { LeftPanelRunningStore } from "./left-panel-running.js";
import type { PluginPanelGroup } from "./protocol.js";
import { pick, type ServerLang } from "./i18n.js";
import {
	PluginStorage,
	PluginSecrets,
	ensurePluginDeps,
	WorkspaceFS,
	withFileRmwLockSync,
} from "./plugin-facilities.js";
import {
	parseCronSpec,
	armDelay,
	nextCronFire,
	loadScheduleRecords,
	saveScheduleRecords,
	type CronParts,
} from "./plugin-schedule.js";
import { PluginPermissionStore, type PermissionFamily } from "./plugin-permissions.js";
import { getAppVersion } from "./pkg-info.js";
import { readCatalog, addCustomEntry, removeCustomEntry, type CatalogAddInput } from "./plugin-catalog.js";
import { PluginGrantsStore, normalizeGrantPath } from "./plugin-grants.js";
import { normalizeIconSvg } from "./icon-svg.js";
import { cleanupRemovedPlugins } from "./plugin-removal.js";
import { prepareBundledPlugins } from "./plugin-bundled.js";
import { PluginDomConsent, declarationWantsDom } from "./plugin-dom.js";
import { validatePluginManifest, formatManifestIssue, isKnownPermission } from "./plugin-manifest-validate.js";
import { buildPluginApiCatalog } from "./plugin-api-catalog.js";
import { AGENT_TOOL_CATALOG } from "./tool-manager.js";
import {
	applyPostEdit,
	denialText,
	freezeParams,
	isBlockingDecision,
	normalizePostEdit,
	normalizePreDecision,
	withGuardTimeout,
	type ToolPostHandler,
	type ToolPostRequest,
	type ToolPreHandler,
	type ToolPreRequest,
} from "./plugin-tool-guard.js";
import { normalizeWorkspaceRoots } from "./client-state.js";
import { compareVersions, ensureBackup } from "./plugin-updater.js";
import {
	createProject,
	isInsideRoot,
	realPathOfNearest,
	type ProjectCreateSpec,
	type ProjectCreateResult,
} from "./plugin-project.js";
import {
	listAllMcpServers,
	checkMcpServer,
	installMcpServer,
	type McpCheckResult,
	type McpInstallSpec,
	type McpInstallResult,
} from "./mcp-manager.js";
import type { McpProjectRuntimeRegistry } from "./mcp-project-runtime.js";
import type { UiMcpServer } from "./protocol.js";
import type { Request, Response } from "express";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const ID_RE = /^[A-Za-z0-9_-]+$/;

const SERVICE_NAME_RE = /^[A-Za-z0-9_.-]+$/;

export interface PluginToolEvent {
	phase: "start" | "end";
	toolName: string;
	conversationId?: string;
	toolCallId?: string;
	durationMs?: number;
	isError?: boolean;
}

export interface PluginConversationQuery {
	clientId?: string;
	fallback?: "latest-non-subagent";
}

function copySnapshotForPlugins(snap: PluginConversationSnapshot): PluginConversationSnapshot {
	return {
		...snap,
		messages: snap.messages.map((m) => {
			try {
				return structuredClone(m);
			} catch {
				try {
					return JSON.parse(JSON.stringify(m)) as typeof m;
				} catch {
					return { ...m };
				}
			}
		}),
	};
}

export interface PluginConversationSnapshot {
	clientId: string;
	conversationId: string;
	isSubagent: boolean;
	sessionId?: string;
	sessionFile?: string;
	sessionDir?: string;
	title: string;
	model?: string;
	at: number;
	isStreaming: boolean;
	messages: UiMessage[];
	streamingMessage: UiMessage | null;
	stats: {
		totalMessages: number;
		tokens: { input: number; output: number; total: number };
		cost: number;
	};
}

export interface PluginRunEvent {
	sessionId?: string;
	type:
		"run_start" | "run_end" | "turn_start" | "turn_end" | "turn_first_token" | "message" | "tool_start" | "tool_end";
	conversationId?: string;
	clientId?: string;
	runId?: string;
	at: number;
	task?: string;
	message?: UiMessage;
	toolCallId?: string;
	toolName?: string;
	argsText?: string;
	resultText?: string;
	durationMs?: number;
	isError?: boolean;
	stopReason?: string;
}

export interface PluginChatRequest {
	independent?: boolean;
	attachments?: PromptAttachment[];
	text: string;
	accountId?: string;
	cwd?: string;
	conversationId?: string;
	model?: string;
	thinkingLevel?: string;
}

export interface PluginChatResult {
	sessionId?: string;
	conversationId: string;
	clientId: string;
	runId?: string;
}
export interface PluginConversationListItem {
	id: string;
	title: string;
	cwd: string;
	kind: string;
	isStreaming: boolean;
}

export interface PluginMarkerDef<State = unknown> {
	name: string;
	label?: string;
	guidance: string[];
	getGuidance?: (lang: ServerLang) => string[];
	apply: (
		token: ParsedToken,
		ctx: MarkerContext,
		state: State,
		lang?: ServerLang,
	) => Promise<ApplyResult> | ApplyResult;
	overlay?: (state: State, ctx: MarkerContext) => MarkerOverlay | undefined;
	init?: () => State;
}

export interface PluginAgentTool {
	pluginId?: string;
	name: string;
	label?: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: Record<string, unknown>;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partial: unknown) => void,
	): Promise<unknown>;
}

export type PluginLogLevel = "debug" | "info" | "warn" | "error";

export interface PluginLogEntry {
	ts: number;
	level: PluginLogLevel;
	text: string;
}

export const PLUGIN_LOG_CAP = 200;
export const PLUGIN_LOG_TEXT_MAX = 500;

const PLUGIN_LOG_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

export function normalizePluginLogLevel(first: unknown): PluginLogLevel {
	return typeof first === "string" && PLUGIN_LOG_LEVELS.has(first) ? (first as PluginLogLevel) : "info";
}

export function formatPluginLogText(args: unknown[]): string {
	const parts = args.map((a) => {
		if (typeof a === "string") return a;
		try {
			const s = JSON.stringify(a);
			return typeof s === "string" ? s : String(a);
		} catch {
			try {
				return String(a);
			} catch {
				return "[unprintable]";
			}
		}
	});
	const text = parts.join(" ");
	return text.length > PLUGIN_LOG_TEXT_MAX ? text.slice(0, PLUGIN_LOG_TEXT_MAX) : text;
}

export const PLUGIN_LOGS_HOST_KEY = "__host";

export interface PluginLogsWireUp {
	__host: "logs";
	op: "get" | "clear";
}

export interface PluginLogsWireDown {
	__host: "logs";
	logs: PluginLogEntry[];
	cleared?: boolean;
}

export function isPluginLogsRequest(p: unknown): p is PluginLogsWireUp {
	if (!p || typeof p !== "object") return false;
	const o = p as Record<string, unknown>;
	return o[PLUGIN_LOGS_HOST_KEY] === "logs" && (o.op === "get" || o.op === "clear" || o.op === undefined);
}

export interface PluginHost {
	broadcast(payload: unknown): void;
	notify(level: "info" | "warning" | "error", text: string, textEn?: string): void;
	onMessage(handler: (payload: unknown, from?: string) => void): () => void;
	onClientMessage(handler: (msg: unknown, reply: (payload: unknown) => void) => void | Promise<void>): () => void;
	sendTo(clientId: string, payload: unknown): void;
	onAttach(handler: (clientId: string) => void): () => void;
	onToolEvent(handler: (ev: PluginToolEvent) => void): () => void;
	onToolPre(handler: ToolPreHandler): () => void;
	onToolPost(handler: ToolPostHandler): () => void;
	onRunEvent(handler: (ev: PluginRunEvent) => void): () => void;
	getActiveConversation(options?: PluginConversationQuery): PluginConversationSnapshot | null;
	onClientModelChanged(handler: (snap: PluginConversationSnapshot) => void): () => void;
	chat(req: PluginChatRequest): Promise<PluginChatResult>;
	workItems: import("../plugin-sdk/index.js").PluginWorkItems;
	chatWait(
		req: PluginChatRequest,
		opts?: { timeoutMs?: number },
	): Promise<{ ok: boolean; conversationId?: string; error?: string }>;
	llm: {
		readonly supportsImages: true;
		complete(req: import("./plugin-llm.js").PluginLlmRequest): Promise<{
			ok: boolean;
			text?: string;
			model?: string;
			usage?: { input: number; output: number };
			error?: string;
		}>;
	};
	requestPermission(req: {
		family: "net" | "llm";
		hosts?: string[];
		models?: string[];
		reason?: string;
	}): Promise<boolean>;
	conversations: {
		list(): Array<PluginConversationListItem> | Promise<Array<PluginConversationListItem>>;
		get(id: string): PluginConversationSnapshot | null;
		search(
			query: string,
			limit?: number,
		): Array<{ id: string; title: string }> | Promise<Array<{ id: string; title: string }>>;
	};
	prompt(
		conversationId: string,
		req: { text: string; attachments?: Array<{ path: string; mode?: string }> },
	): Promise<{ ok: boolean; error?: string }>;
	steer(conversationId: string, text: string): Promise<{ ok: boolean; error?: string }>;
	abortRun(conversationId: string): Promise<{ ok: boolean; error?: string }>;
	onConversationChanged(handler: () => void): () => void;
	registerAgentTool(tool: PluginAgentTool): () => void;
	registerTool(tool: {
		name: string;
		description: string;
		label?: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters?: Record<string, unknown>;
		execute(args: Record<string, unknown>): Promise<unknown>;
	}): () => void;
	registerMarker<State = unknown>(marker: PluginMarkerDef<State>): () => void;
	dir: string;
	dataDir: string;
	get cwd(): string;
	onCwdChange(handler: (cwd: string) => void): () => void;
	registerCommand(cmd: PluginCommandDef): () => void;
	execCommand?(
		name: string,
		args: string,
		context?: { clientId?: string },
	): Promise<{ ok: boolean; result?: string; error?: string }>;
	getPluginCommands?(): PluginCommandDef[];
	ui: {
		register(items: unknown[] | unknown): () => void;
		update(id: string, patch: Record<string, unknown>): void;
		remove(id: string): void;
		arrange(ops: unknown[] | unknown): void;
		list(): UiPluginUi;
		patch?(arg1: unknown, arg2?: unknown, arg3?: unknown): void;
	};
	storage: {
		get<T>(key: string, fallback?: T): T | undefined;
		set(key: string, value: unknown): void;
		delete(key: string): void;
		has(key: string): boolean;
		keys(): string[];
		clear(preserveSettings?: boolean): void;
		all(): Record<string, unknown>;
	};
	services: {
		provide<T>(name: string, service: T): () => void;
		get<T>(name: string): T | undefined;
		has(name: string): boolean;
		list(): Array<{ name: string; pluginId: string }>;
		on<T>(name: string, handler: (service: T | undefined) => void): () => void;
	};
	provide<T>(name: string, service: T): () => void;
	get<T>(name: string): T | undefined;
	onService<T>(name: string, handler: (service: T | undefined) => void): () => void;
	secrets: {
		set(name: string, value: string): void;
		get(name: string): string | undefined;
		has(name: string): boolean;
		delete(name: string): void;
		list(): string[];
		getAll(): Record<string, string>;
	};
	tts: TtsClient & { registerEngine(engine: TtsEngine): () => void };
	ensureDeps(specs: string[], opts?: { onProgress?: (msg: string) => void }): Promise<boolean>;
	route(
		method: "GET" | "POST" | "PUT" | "DELETE" | "OPTIONS",
		path: string,
		handler: (req: Request, res: Response) => void,
	): () => void;
	registerProxy(prefix: string, target: number | { port: number; host?: string }): () => void;
	fs: {
		list(relDir?: string): Promise<{ name: string; type: "file" | "dir" }[]>;
		read(relPath: string): Promise<Buffer>;
		readText(relPath: string, maxBytes?: number): Promise<string>;
		write(relPath: string, data: string | Uint8Array): Promise<void>;
		remove(relPath: string): Promise<void>;
		stat(relPath: string): Promise<{ name: string; type: "file" | "dir"; size: number; mtime: number }>;
		mkdir(relDir: string): Promise<void>;
		append(relPath: string, data: string | Uint8Array): Promise<void>;
		glob(pattern: string, relDir?: string): Promise<string[]>;
		requestAccess(dir: string, reason?: string): Promise<boolean>;
		authorizedDirs(): string[];
		listPath(absDir: string): Promise<{ name: string; type: "file" | "dir" }[]>;
		readPath(absPath: string): Promise<Buffer>;
		readTextPath(absPath: string, maxBytes?: number): Promise<string>;
		writePath(absPath: string, data: string | Uint8Array): Promise<void>;
		removePath(absPath: string): Promise<void>;
		statPath(absPath: string): Promise<{ name: string; type: "file" | "dir"; size: number; mtime: number }>;
		mkdirPath(absDir: string): Promise<void>;
		appendPath(absPath: string, data: string | Uint8Array): Promise<void>;
		globPath(absDir: string, pattern: string): Promise<string[]>;
		watch(relPath: string, handler: (ev: { type: string; path: string }) => void): () => void;
	};
	project: {
		create(spec: ProjectCreateSpec): Promise<ProjectCreateResult>;
	};
	registerBackgroundTask(task: {
		id: string;
		label: string;
		stop?: () => void;
		status?: string;
		check?: () =>
			boolean | { alive: boolean; status?: string } | Promise<boolean | { alive: boolean; status?: string }>;
		intervalMs?: number;
		maxFailures?: number;
		onDead?: (reason?: string) => void;
	}): {
		update(next: Partial<{ label: string; status: string; stop: () => void }>): void;
		unregister(): void;
	};
	leftPanel: {
		setRunning(items: unknown[], opts?: { ttlMs?: number }): void;
		clear(): void;
	};
	getSettings(): Record<string, unknown>;
	onSettingsChanged(handler: (values: Record<string, unknown>) => void): () => void;
	scm: {
		status(): Promise<unknown>;
		log(path?: string, limit?: number): Promise<unknown>;
	};
	bash(
		cmd: string,
		opts?: { cwd?: string; timeoutMs?: number },
	): Promise<{
		ok: boolean;
		output: string;
		exitCode?: number;
		error?: string;
	}>;
	schedule(
		cronOrMs: string | number,
		fn: () => void,
		opts?: { id?: string; persistent?: boolean; catchUp?: "skip" | "once"; label?: string },
	): () => void;
	models: {
		list(): PluginModelInfo[] | Promise<PluginModelInfo[]>;
	};
	mcp: {
		list(): Promise<UiMcpServer[]>;
		check(query: string): Promise<McpCheckResult>;
		install(spec: McpInstallSpec): Promise<McpInstallResult>;
		promptInstall(
			target: string | McpInstallSpec,
			opts?: { conversationId?: string; scope?: "global" | "project" },
		): Promise<{ ok: boolean; conversationId?: string; error?: string }>;
	};
	onStats(handler: (s: PluginStats) => void): () => void;
	onStreaming(handler: (ev: { conversationId?: string; delta: string }) => void): () => void;
	net: {
		fetch(
			url: string,
			init?: { method?: string; body?: string; headers?: Record<string, string> },
		): Promise<{ ok: boolean; status?: number; text?: string; error?: string }>;
	};
	events: {
		emit(topic: string, payload?: unknown): void;
		on(topic: string, handler: (ev: PluginBusEvent) => void): () => void;
	};
	log(level?: string, ...args: unknown[]): void;
	effect(label: string, dispose: () => void): () => void;
	resolveInWorkspace(relOrAbsPath: string): string;
	fetch(
		input: string | URL | globalThis.Request,
		init?: RequestInit & { timeoutMs?: number },
	): Promise<globalThis.Response>;
	assets: {
		ensure(
			spec: PluginAssetSpec,
			opts?: { onProgress?: (progress: PluginAssetProgress) => void; timeoutMs?: number },
		): Promise<PluginAssetResult>;
		status(spec: PluginAssetSpec): PluginAssetStatus;
	};
}

interface UiRuntimeUi {
	items: Map<string, UiContribution>;
	removed: Set<string>;
	arrange: UiArrangeOp[];
}

interface GateRecord {
	permsDeclared?: string[];
	permFamilies?: Set<string>;
	strictMode?: boolean;
	legacyWarned?: boolean;
}

export class PluginEffectStack {
	private readonly items: PluginEffect[] = [];
	private released = false;

	constructor(
		readonly pluginId: string,
		private readonly diag?: (msg: string) => void,
	) {}

	add(label: string, dispose: () => void): () => void {
		const item: PluginEffect = { label, dispose };
		if (this.released) {
			try {
				dispose();
			} catch (err) {
				this.report(label, err);
			}
			return () => {};
		}
		this.items.push(item);
		return () => this.remove(item);
	}

	get isReleased(): boolean {
		return this.released;
	}

	get size(): number {
		return this.items.length;
	}

	labels(): string[] {
		return this.items.map((i) => i.label);
	}

	private remove(item: PluginEffect): void {
		const i = this.items.indexOf(item);
		if (i < 0) return;
		this.items.splice(i, 1);
		try {
			item.dispose();
		} catch (err) {
			this.report(item.label, err);
		}
	}

	release(): string[] {
		if (this.released) return [];
		this.released = true;
		const failed: string[] = [];
		while (this.items.length > 0) {
			const item = this.items.pop()!;
			try {
				item.dispose();
			} catch (err) {
				failed.push(item.label);
				this.report(item.label, err);
			}
		}
		return failed;
	}

	private report(label: string, err: unknown): void {
		console.warn(`[plugin:${this.pluginId}] effect "${label}" cleanup failed:`, err);
		this.diag?.(`effect "${label}" cleanup failed: ${(err as Error)?.message ?? String(err)}`);
	}
}

export interface PluginEffect {
	label: string;
	dispose: () => void;
}

interface LoadedPlugin {
	info: UiPluginInfo;
	deactivate?: () => void;
	effects?: PluginEffectStack;
	toolHandlers: Set<(ev: PluginToolEvent) => void>;
	preGuards?: Set<ToolPreHandler>;
	postGuards?: Set<ToolPostHandler>;
	runHandlers: Set<(ev: PluginRunEvent) => void>;
	convChangeHandlers: Set<() => void>;
	modelChangeHandlers?: Set<(snap: PluginConversationSnapshot) => void>;
	attachHandlers: Set<(clientId: string) => void>;
	cwdHandlers: Set<(cwd: string) => void>;
	httpRoutes: Map<string, (req: Request, res: Response) => void>;
	permsDeclared?: string[];
	permFamilies?: Set<string>;
	strictMode?: boolean;
	legacyWarned?: boolean;
	settingsHandlers: Set<(values: Record<string, unknown>) => void>;
}

export const PLUGIN_API_VERSION = 2;

export interface PluginCommandDef {
	name: string;
	description?: string;
	descriptionEn?: string;
	argumentHint?: string;
	argumentHintEn?: string;
	run(args: string, ctx: { clientId?: string }): unknown | Promise<unknown>;
}

type AgentToolTable = Map<string, PluginAgentTool>;

export interface PluginBgTask {
	id: string;
	label: string;
	stop?: () => void;
	status?: string;
	since: number;
}

const MESSAGE_TIMEOUT_MS = 30_000;

const NO_FS_PROMISE = Promise.reject(new Error('插件未声明能力 "fs"（manifest.permissions）——请求被拒'));
NO_FS_PROMISE.catch(() => {});

const NO_FS_WRITE_PROMISE = Promise.reject(
	new Error('缺少写能力：需要 "fs"/"fs:write"（manifest.permissions）——请求被拒'),
);
NO_FS_WRITE_PROMISE.catch(() => {});

const execFileAsync = promisify(execFile);

function parseVer(v: string): [number, number, number] | null {
	const m = String(v ?? "")
		.trim()
		.match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpVerTuple(a: [number, number, number], b: [number, number, number]): number {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i]! - b[i]!;
	}
	return 0;
}

export function satisfiesEnginesConstraint(constraint: string, current: string): boolean | null {
	const c = String(constraint ?? "").trim();
	let kind: ">=" | "^" | "=", req: string;
	if (c.startsWith(">=")) {
		kind = ">=";
		req = c.slice(2).trim();
	} else if (c.startsWith("^")) {
		kind = "^";
		req = c.slice(1).trim();
	} else if (c.startsWith("=")) {
		kind = "=";
		req = c.slice(1).trim();
	} else {
		kind = "=";
		req = c;
	}
	const r = parseVer(req);
	const cur = parseVer(current);
	if (!r || !cur) return null;
	if (kind === ">=") return cmpVerTuple(cur, r) >= 0;
	if (kind === "=") return cmpVerTuple(cur, r) === 0;
	return cur[0] === r[0] && cmpVerTuple(cur, r) >= 0;
}

export function readHostVersion(): string | null {
	const ver = getAppVersion();
	return ver ? ver : null;
}

interface Sender {
	cid: () => string | null;
	send: (msg: ServerMessage) => void;
}

const SETTING_TYPES = new Set(["text", "password", "number", "boolean", "select", "secret"]);

const SETTING_OPTIONS_FROM = new Set(["models", "thinkingLevels"]);

export { UI_SLOTS };

export const UI_SLOT_ALIASES: Readonly<Record<string, string>> = {
	topbar: "topbar.primary",
	"topbar.more": "topbar.overflow",
	composer: "composer.actions",
	message: "message.actions",
	rightpanel: "rightpanel.tabs",
	settings: "settings.pages",
	modal: "modal.dialog",
	sidebar: "sidebar.left",
	"sidebar.left": "sidebar.left",
	"sidebar.right": "sidebar.right",
	leftbar: "sidebar.left",
	rightbar: "sidebar.right",
	"tool.footer": "tool.card.footer",
	statusbar: "bottombar",
	statusBar: "bottombar",
	"status.bar": "bottombar",
	bottom: "bottombar",
	footer: "bottombar",
};

export const UI_STRUCTURAL_KEYS: ReadonlySet<string> = new Set(["items", "arrange", "views", "commands", "menus"]);

export const UI_KINDS: ReadonlySet<string> = new Set([
	"view",
	"action",
	"badge",
	"menu",
	"page",
	"organizer",
	"divider",
	"toggle",
	"input",
	"progress",
	"select",
]);
const UI_ALIGNS: ReadonlySet<string> = new Set(["start", "center", "end"]);

export function parseUiAlign(raw: unknown): UiAlign | undefined {
	return typeof raw === "string" && UI_ALIGNS.has(raw) ? (raw as UiAlign) : undefined;
}

function trimStr(v: unknown, max = 60): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

function wasTruncated(v: unknown, max: number): boolean {
	return typeof v === "string" && v.trim().length > max;
}

export function parseUiItem(raw: unknown, slot: string, diagnostics?: string[]): UiContribution | null {
	const diag = (m: string): void => {
		diagnostics?.push(m);
	};
	if (!raw || typeof raw !== "object") {
		diag(`ui item in slot "${slot}": not an object, dropped`);
		return null;
	}
	const o = raw as Record<string, unknown>;
	const rawIdHint = typeof o.id === "string" && o.id.trim() ? o.id.trim().slice(0, 32) : "?";
	const id = trimStr(o.id, 64);
	if (!id || !ID_RE.test(id)) {
		diag(`ui item in slot "${slot}": invalid id "${rawIdHint}", dropped`);
		return null;
	}
	if (wasTruncated(o.id, 64)) diag(`ui item "${id}": id truncated to 64 chars`);
	const label = trimStr(o.label, 60);
	if (!label) {
		diag(`ui item "${id}": missing label, dropped`);
		return null;
	}
	if (wasTruncated(o.label, 60)) diag(`ui item "${id}": label truncated to 60 chars`);
	const kindRaw = trimStr(o.kind, 16);
	let kind: UiContribution["kind"] = kindRaw && UI_KINDS.has(kindRaw) ? (kindRaw as UiContribution["kind"]) : undefined;

	let actionStr: string | undefined;
	let viewFromAction: string | undefined;
	if (typeof o.action === "string") {
		actionStr = trimStr(o.action, 64);
	} else if (o.action && typeof o.action === "object" && !Array.isArray(o.action)) {
		const actObj = o.action as Record<string, unknown>;
		if (actObj.type === "view") {
			if (!kindRaw && !kind) kind = "view";
			if (typeof actObj.viewId === "string" && actObj.viewId.trim()) {
				const vid = actObj.viewId.trim();
				viewFromAction = vid.startsWith("plugin:") ? vid : `plugin:${vid}`;
			}
		}
	}

	if (kindRaw && !kind) diag(`ui item "${id}": unknown kind "${kindRaw}", fallback to default`);
	if (!kind) kind = slot === "settings.pages" ? "page" : "action";
	const children: UiContribution[] = [];
	if (Array.isArray(o.children)) {
		if (o.children.length > 16) diag(`ui item "${id}": children capped at 16 (${o.children.length - 16} dropped)`);
		const sliced = o.children.slice(0, 16);
		for (let i = 0; i < sliced.length; i++) {
			const before = diagnostics?.length ?? 0;
			const child = parseUiItem(sliced[i], slot, diagnostics);
			if (child) {
				if (child.children?.length)
					diag(`ui item "${id}": child "${child.id}" nested children cleared (only one level kept)`);
				children.push({ ...child, children: undefined });
			} else if ((diagnostics?.length ?? 0) === before) {
				diag(`ui item "${id}": child #${i} dropped`);
			}
		}
	} else if (o.children !== undefined) {
		diag(`ui item "${id}": children is not an array, ignored`);
	}
	let when: string[] | undefined;
	if (o.when !== undefined) {
		if (!Array.isArray(o.when)) {
			diag(`ui item "${id}": when is not an array, ignored`);
		} else {
			const valid = o.when.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
			if (valid.length < o.when.length)
				diag(`ui item "${id}": when dropped ${o.when.length - valid.length} invalid entries`);
			if (valid.length > 8) diag(`ui item "${id}": when capped at 8 (${valid.length - 8} dropped)`);
			const capped = valid.slice(0, 8);
			if (capped.length) when = capped;
		}
	}
	const num = Number(o.order);
	if (o.order !== undefined && !Number.isFinite(num)) diag(`ui item "${id}": invalid order, ignored`);
	const align = parseUiAlign(o.align);
	if (o.align !== undefined && !align) diag(`ui item "${id}": unknown align, default used`);
	let options: UiContribution["options"] | undefined;
	if ((kind === "select" || !kindRaw) && Array.isArray(o.options)) {
		if (o.options.length > 32) diag(`ui item "${id}": options capped at 32 (${o.options.length - 32} dropped)`);
		const list: NonNullable<UiContribution["options"]> = [];
		let droppedOpts = 0;
		for (const r of o.options.slice(0, 32)) {
			if (!r || typeof r !== "object") {
				droppedOpts++;
				continue;
			}
			const ro = r as Record<string, unknown>;
			const value = typeof ro.value === "string" ? ro.value.slice(0, 64) : "";
			if (!value || list.some((x) => x.value === value)) {
				droppedOpts++;
				continue;
			}
			list.push({
				value,
				...(trimStr(ro.label, 60) ? { label: trimStr(ro.label, 60) } : {}),
				...(trimStr(ro.labelEn, 60) ? { labelEn: trimStr(ro.labelEn, 60) } : {}),
			});
		}
		if (droppedOpts) diag(`ui item "${id}": options dropped ${droppedOpts} invalid/duplicate entries`);
		if (list.length) {
			if (!kindRaw) diag(`ui item "${id}": kind inferred as select from options`);
			options = list;
			kind = "select";
		} else if (o.options.length) {
			diag(`ui item "${id}": options all invalid, ignored`);
		}
	}
	const hintRaw = o.hint ?? o.title;
	const view = trimStr(o.view, 64) ?? viewFromAction;
	if (wasTruncated(o.labelEn, 60)) diag(`ui item "${id}": labelEn truncated to 60 chars`);
	if (wasTruncated(o.icon, 16)) diag(`ui item "${id}": icon truncated to 16 chars`);
	if (wasTruncated(hintRaw, 200)) diag(`ui item "${id}": hint truncated to 200 chars`);
	if (wasTruncated(o.hintEn, 200)) diag(`ui item "${id}": hintEn truncated to 200 chars`);
	if (wasTruncated(o.group, 40)) diag(`ui item "${id}": group truncated to 40 chars`);
	if (wasTruncated(actionStr, 64)) diag(`ui item "${id}": action truncated to 64 chars`);
	if (wasTruncated(view, 64)) diag(`ui item "${id}": view truncated to 64 chars`);
	if (wasTruncated(o.badge, 24)) diag(`ui item "${id}": badge truncated to 24 chars`);
	if (typeof o.value === "string" && o.value.length > 500) diag(`ui item "${id}": value truncated to 500 chars`);
	if (typeof o.progress === "number" && Number.isFinite(o.progress) && (o.progress < 0 || o.progress > 100))
		diag(`ui item "${id}": progress out of range, clamped to 0-100`);
	return {
		id,
		slot: slot as UiContribution["slot"],
		label,
		...(align ? { align } : {}),
		...(trimStr(o.labelEn, 60) ? { labelEn: trimStr(o.labelEn, 60) } : {}),
		...(trimStr(o.icon, 16) ? { icon: trimStr(o.icon, 16) } : {}),
		...(normalizeIconSvg((o as { iconSvg?: unknown }).iconSvg)
			? { iconSvg: normalizeIconSvg((o as { iconSvg?: unknown }).iconSvg) }
			: {}),
		...(trimStr(hintRaw, 200) ? { hint: trimStr(hintRaw, 200) } : {}),
		...(trimStr(o.hintEn, 200) ? { hintEn: trimStr(o.hintEn, 200) } : {}),
		kind,
		...(children.length ? { children } : {}),
		...(Number.isFinite(num) ? { order: num } : {}),
		...(trimStr(o.group, 40) ? { group: trimStr(o.group, 40) } : {}),
		...(o.hidden === true ? { hidden: true } : {}),
		...(actionStr ? { action: actionStr } : {}),
		...(view ? { view } : {}),
		...(when?.length ? { when } : {}),
		...(trimStr(o.badge, 24) ? { badge: trimStr(o.badge, 24) } : {}),
		...(typeof o.checked === "boolean" ? { checked: o.checked } : {}),
		...(typeof o.value === "string" ? { value: o.value.slice(0, 500) } : {}),
		...(typeof o.progress === "number" && Number.isFinite(o.progress)
			? { progress: Math.max(0, Math.min(100, o.progress)) }
			: {}),
		...(options ? { options } : {}),
	};
}

export function parseUiContributions(raw: unknown, diagnostics?: string[]): UiPluginUi | undefined {
	const diag = (m: string): void => {
		diagnostics?.push(m);
	};
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		diag("ui: expected object, ignored");
		return undefined;
	}
	const o = raw as Record<string, unknown>;
	const items: UiContribution[] = [];
	let capNoted = false;
	const noteCap = (): void => {
		if (!capNoted) {
			capNoted = true;
			diag("ui: total items capped at 32, remaining dropped");
		}
	};
	const push = (it: UiContribution | null) => {
		if (!it) return;
		if (items.length < 32) items.push(it);
		else noteCap();
	};
	if (o.items !== undefined && !Array.isArray(o.items)) diag('ui: "items" is not an array, ignored');
	if (Array.isArray(o.items)) {
		if (o.items.length > 32) diag(`ui: flat items capped at 32 (${o.items.length - 32} dropped)`);
		for (let i = 0; i < o.items.slice(0, 32).length; i++) {
			const it = o.items[i];
			const slotRaw = trimStr((it as Record<string, unknown>)?.slot, 32) ?? "";
			const slot = slotRaw ? (UI_SLOT_ALIASES[slotRaw] ?? slotRaw) : "";
			if (!slot || !UI_SLOTS.has(slot)) {
				diag(`ui: flat items[#${i}] unknown slot "${slotRaw || "(missing)"}", dropped`);
				continue;
			}
			const before = diagnostics?.length ?? 0;
			const parsed = parseUiItem(it, slot, diagnostics);
			if (!parsed && (diagnostics?.length ?? 0) === before) diag(`ui: flat items[#${i}] in slot "${slot}" dropped`);
			push(parsed);
		}
	}
	for (const [rawKey, val] of Object.entries(o)) {
		if (UI_STRUCTURAL_KEYS.has(rawKey)) continue;
		const key = UI_SLOT_ALIASES[rawKey] ?? rawKey;
		if (!UI_SLOTS.has(key)) {
			const n = Array.isArray(val) ? val.length : 1;
			diag(`ui: unknown slot group "${rawKey}", dropped (${n} items)`);
			continue;
		}
		if (!Array.isArray(val)) {
			diag(`ui: slot "${key}" value is not an array, dropped`);
			continue;
		}
		if (val.length > 32) diag(`ui: slot "${key}" capped at 32 (${val.length - 32} dropped)`);
		for (let i = 0; i < val.slice(0, 32).length; i++) {
			const before = diagnostics?.length ?? 0;
			const parsed = parseUiItem(val[i], key, diagnostics);
			if (!parsed && (diagnostics?.length ?? 0) === before) diag(`ui: slot "${key}"[#${i}] dropped`);
			push(parsed);
		}
	}
	const arrange = o.arrange === undefined ? [] : parseUiArrange(o.arrange, diagnostics);
	if (!items.length && !arrange.length) {
		diag("ui: no valid items/arrange, ignored");
		return undefined;
	}
	return { items, arrange };
}

export function parseUiArrange(raw: unknown, diagnostics?: string[]): UiArrangeOp[] {
	const diag = (m: string): void => {
		diagnostics?.push(m);
	};
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		diag("ui arrange: expected array, ignored");
		return [];
	}
	if (raw.length > 64) diag(`ui arrange: capped at 64 (${raw.length - 64} dropped)`);
	const out: UiArrangeOp[] = [];
	const sliced = raw.slice(0, 64);
	for (let i = 0; i < sliced.length; i++) {
		const it = sliced[i];
		if (!it || typeof it !== "object") {
			diag(`ui arrange[#${i}]: not an object, dropped`);
			continue;
		}
		const o = it as Record<string, unknown>;
		const id = trimStr(o.id, 96);
		if (!id || !/^[A-Za-z0-9_-]+:[A-Za-z0-9_.:-]+$/.test(id)) {
			const hint = typeof o.id === "string" && o.id.trim() ? o.id.trim().slice(0, 32) : "?";
			diag(`ui arrange[#${i}]: invalid id "${hint}", dropped`);
			continue;
		}
		if (typeof o.id === "string" && o.id.trim().length > 96) diag(`ui arrange "${id}": id truncated to 96 chars`);
		const slotRaw = trimStr(o.slot, 32);
		if (o.slot !== undefined && (!slotRaw || !UI_SLOTS.has(slotRaw)))
			diag(`ui arrange "${id}": unknown slot "${String(o.slot).slice(0, 32)}", slot ignored`);
		const num = Number(o.order);
		if (o.order !== undefined && !Number.isFinite(num)) diag(`ui arrange "${id}": invalid order, ignored`);
		const align = parseUiAlign(o.align);
		if (o.align !== undefined && !align) diag(`ui arrange "${id}": unknown align, ignored`);
		if (typeof o.group === "string" && o.group.trim().length > 40)
			diag(`ui arrange "${id}": group truncated to 40 chars`);
		if (typeof o.label === "string" && o.label.trim().length > 60)
			diag(`ui arrange "${id}": label truncated to 60 chars`);
		if (typeof o.hint === "string" && o.hint.trim().length > 200)
			diag(`ui arrange "${id}": hint truncated to 200 chars`);
		if (typeof o.icon === "string" && o.icon.trim().length > 16) diag(`ui arrange "${id}": icon truncated to 16 chars`);
		out.push({
			id,
			...(slotRaw && UI_SLOTS.has(slotRaw) ? { slot: slotRaw as UiArrangeOp["slot"] } : {}),
			...(o.hide === true ? { hide: true } : {}),
			...(o.hide === false ? { hide: false } : {}),
			...(trimStr(o.group, 40) ? { group: trimStr(o.group, 40) } : {}),
			...(Number.isFinite(num) ? { order: num } : {}),
			...(align ? { align } : {}),
			...(trimStr(o.label, 60) ? { label: trimStr(o.label, 60) } : {}),
			...(trimStr(o.hint, 200) ? { hint: trimStr(o.hint, 200) } : {}),
			...(trimStr(o.icon, 16) ? { icon: trimStr(o.icon, 16) } : {}),
			...(normalizeIconSvg((o as { iconSvg?: unknown }).iconSvg)
				? { iconSvg: normalizeIconSvg((o as { iconSvg?: unknown }).iconSvg) }
				: {}),
		});
	}
	return out;
}

export function parseRequires(raw: unknown): PluginRequires | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const o = raw as Record<string, unknown>;
	const out: PluginRequires = {};
	if (typeof o.hostApi === "number" && Number.isInteger(o.hostApi) && o.hostApi >= 1) out.hostApi = o.hostApi;
	if (Array.isArray(o.families)) {
		const fams = o.families
			.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
			.map((x) => x.trim())
			.slice(0, 8);
		if (fams.length) out.families = fams;
	}
	if (Array.isArray(o.plugins)) {
		const deps = o.plugins
			.filter((x): x is string => typeof x === "string" && ID_RE.test(x.trim()))
			.map((x) => x.trim())
			.slice(0, 16);
		if (deps.length) out.plugins = deps;
	}
	return out.hostApi !== undefined || out.families !== undefined || out.plugins !== undefined ? out : undefined;
}

export function sortByRequires(ids: string[], depsOf: (id: string) => string[]): { order: string[]; cyclic: string[] } {
	const indeg = new Map<string, number>();
	const edges = new Map<string, string[]>();
	const idSet = new Set(ids);
	for (const id of ids) {
		indeg.set(id, 0);
		edges.set(id, []);
	}
	for (const id of ids) {
		const seen = new Set<string>();
		for (const dep of depsOf(id)) {
			if (!idSet.has(dep) || dep === id || seen.has(dep)) continue;
			seen.add(dep);
			edges.get(dep)!.push(id);
			indeg.set(id, (indeg.get(id) ?? 0) + 1);
		}
	}
	const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
	const order: string[] = [];
	while (queue.length) {
		const cur = queue.shift()!;
		order.push(cur);
		for (const next of edges.get(cur) ?? []) {
			const d = (indeg.get(next) ?? 1) - 1;
			indeg.set(next, d);
			if (d === 0) queue.push(next);
		}
	}
	const ordered = new Set(order);
	return { order, cyclic: ids.filter((id) => !ordered.has(id)) };
}

function mergeUiPluginUi(base: UiPluginUi | undefined, rt: UiRuntimeUi | undefined): UiPluginUi | undefined {
	const items = new Map<string, UiContribution>();
	for (const it of base?.items ?? []) items.set(it.id, it);
	for (const it of rt?.items.values() ?? []) items.set(it.id, it);
	for (const id of rt?.removed ?? []) items.delete(id);
	const arrange = [...(base?.arrange ?? []), ...(rt?.arrange ?? [])];
	if (!items.size && !arrange.length) return undefined;
	return { items: [...items.values()], arrange };
}

function parseSettingsSchema(raw: unknown): UiPluginSettingField[] {
	if (!Array.isArray(raw)) return [];
	const out: UiPluginSettingField[] = [];
	for (const f of raw) {
		if (!f || typeof f !== "object") continue;
		const o = f as Record<string, unknown>;
		const key = typeof o.key === "string" ? o.key.trim() : "";
		const optionsFrom =
			typeof o.optionsFrom === "string" && SETTING_OPTIONS_FROM.has(o.optionsFrom)
				? (o.optionsFrom as UiPluginSettingField["optionsFrom"])
				: undefined;
		const type = (typeof o.type === "string" && o.type ? o.type : optionsFrom ? "select" : "") as string;
		if (!key || !SETTING_TYPES.has(type) || out.some((x) => x.key === key)) continue;
		let options: UiPluginSettingField["options"];
		if (Array.isArray(o.options)) {
			const parsed: (string | UiSelectOption)[] = [];
			for (const opt of o.options) {
				if (typeof opt === "string") {
					parsed.push(opt);
				} else if (opt && typeof opt === "object" && typeof (opt as Record<string, unknown>).value === "string") {
					const val = (opt as Record<string, unknown>).value as string;
					const item: UiSelectOption = { value: val };
					if (typeof (opt as Record<string, unknown>).label === "string") {
						item.label = (opt as Record<string, unknown>).label as string;
					}
					if (typeof (opt as Record<string, unknown>).labelEn === "string") {
						item.labelEn = (opt as Record<string, unknown>).labelEn as string;
					}
					parsed.push(item);
				}
			}
			if (parsed.length > 0) options = parsed;
		}
		const field: UiPluginSettingField = {
			key,
			type: type as UiPluginSettingField["type"],
			label: typeof o.label === "string" && o.label ? o.label : key,
			...(o.default !== undefined ? { default: o.default as string | number | boolean } : {}),
			...(typeof o.min === "number" ? { min: o.min } : {}),
			...(typeof o.max === "number" ? { max: o.max } : {}),
			...(options ? { options } : {}),
			...(type === "select" && optionsFrom ? { optionsFrom } : {}),
			...(typeof o.hint === "string" ? { hint: o.hint } : {}),
		};
		out.push(field);
		if (out.length >= 32) break;
	}
	return out;
}

function secretSettingKey(key: string): string {
	return `setting:${key}`;
}
function readSettingsOverlayFile(
	dataDir: string,
	pluginId: string,
): { raw: Record<string, unknown>; warnings: string[] } {
	const empty = { raw: {}, warnings: [] as string[] };
	if (!ID_RE.test(pluginId)) return empty;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(dataDir, "plugin-overrides", `${pluginId}.json`), "utf8"));
	} catch {
		return empty;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { raw: {}, warnings: [`settings override ignored: ${pluginId}.json must be an object`] };
	}
	const o = parsed as Record<string, unknown>;
	if (o.settings === undefined) return empty;
	if (!o.settings || typeof o.settings !== "object" || Array.isArray(o.settings)) {
		return { raw: {}, warnings: [`settings override ignored: ${pluginId}.json settings must be an object`] };
	}
	return { raw: o.settings as Record<string, unknown>, warnings: [] };
}

function cleanOverlaySettings(
	schema: UiPluginSettingField[],
	raw: Record<string, unknown>,
	lang: ServerLang,
): { values: Record<string, unknown>; warnings: string[] } {
	const values: Record<string, unknown> = {};
	const warnings: string[] = [];
	const byKey = new Map(schema.map((f) => [f.key, f]));
	for (const [k, v] of Object.entries(raw)) {
		const f = byKey.get(k);
		if (!f) {
			warnings.push(`settings override ignored: unknown key "${k.slice(0, 64)}"`);
			continue;
		}
		if (f.type === "secret") {
			warnings.push(`settings override ignored: secret "${k.slice(0, 64)}" never comes from overlay`);
			continue;
		}
		const r = cleanNonSecretSettingsField(f, v, lang);
		if (r.error) {
			warnings.push(`settings override ignored: "${k.slice(0, 64)}": ${r.error}`);
			continue;
		}
		values[k] = r.value;
	}
	return { values, warnings };
}

function resolveSettingsValues(
	schema: UiPluginSettingField[],
	stored: Record<string, unknown>,
	overlay: Record<string, unknown>,
	secrets?: { has?: (k: string) => boolean; get?: (k: string) => string | undefined },
): { values: Record<string, unknown>; sources: Record<string, "default" | "override" | "stored"> } {
	const values: Record<string, unknown> = {};
	const sources: Record<string, "default" | "override" | "stored"> = {};
	for (const f of schema) {
		if (f.type === "secret") {
			if (secrets?.get) {
				const got = secrets.get(secretSettingKey(f.key));
				values[f.key] = got ?? f.default ?? "";
				sources[f.key] = got !== undefined ? "stored" : "default";
			} else if (secrets?.has) {
				const has = secrets.has(secretSettingKey(f.key));
				values[f.key] = has;
				sources[f.key] = has ? "stored" : "default";
			} else {
				values[f.key] = false;
				sources[f.key] = "default";
			}
			continue;
		}
		const s = stored[f.key];
		if (s !== undefined && s !== null) {
			values[f.key] = s;
			sources[f.key] = "stored";
		} else if (f.key in overlay) {
			values[f.key] = overlay[f.key];
			sources[f.key] = "override";
		} else {
			values[f.key] = f.default;
			sources[f.key] = "default";
		}
	}
	return { values, sources };
}

function readStoredSettings(dir: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, "storage.json"), "utf8")) as Record<string, unknown>;
		if (parsed && typeof parsed === "object" && parsed.settings && typeof parsed.settings === "object") {
			return parsed.settings as Record<string, unknown>;
		}
	} catch {}
	return {};
}

function runtimeSettingsValues(
	dir: string,
	schema: UiPluginSettingField[],
	secrets: Pick<PluginSecrets, "get">,
	overlay: Record<string, unknown> = {},
): Record<string, unknown> {
	return resolveSettingsValues(schema, readStoredSettings(dir), overlay, { get: (k) => secrets.get(k) }).values;
}

function cleanNonSecretSettingsField(
	f: UiPluginSettingField,
	v: unknown,
	lang: ServerLang,
): { error?: string; value?: unknown } {
	if (f.type === "number") {
		const n = v === undefined ? Number(f.default ?? 0) : Number(v);
		if (!Number.isFinite(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
			return {
				error: pick(lang, `${f.label} 超出范围`, `${f.label} out of range`, "plugins.settings.out.of.range", {
					"f.label": f.label,
				}),
			};
		}
		return { value: n };
	}
	if (f.type === "boolean") {
		return { value: v === undefined ? Boolean(f.default) : Boolean(v) };
	}
	if (f.type === "select") {
		const s = v === undefined ? "" : String(v);
		if (f.optionsFrom) {
			if (s.length > 200) {
				return {
					error: pick(lang, `${f.label} 过长`, `${f.label} too long`, "plugins.settings.too.long", {
						"f.label": f.label,
					}),
				};
			}
			return { value: v === undefined ? (f.default ?? "") : s };
		}
		const hasOptions = Array.isArray(f.options);
		const allowedValues = f.options?.map((opt) => (typeof opt === "string" ? opt : opt.value));
		if (v !== undefined && (!hasOptions || !allowedValues?.includes(s)))
			return {
				error: pick(lang, `${f.label} 值非法`, `Invalid value for ${f.label}`, "plugins.settings.invalid.value", {
					"f.label": f.label,
				}),
			};
		return { value: v === undefined ? f.default : s };
	}
	return { value: v === undefined ? (f.default ?? "") : String(v) };
}

function saveSettingsValues(
	dir: string,
	schema: UiPluginSettingField[],
	values: Record<string, unknown> | undefined,
	lang?: () => ServerLang,
	secrets?: PluginSecrets,
): { error?: string; clean: Record<string, unknown> } {
	const l = lang?.() ?? "en";
	const clean: Record<string, unknown> = {};
	const secretUpdates: Record<string, string> = {};
	try {
		for (const f of schema) {
			const v = values?.[f.key];
			if (f.type !== "secret") {
				const r = cleanNonSecretSettingsField(f, v, l);
				if (r.error) return { error: r.error, clean };
				clean[f.key] = r.value;
			} else if (f.type === "secret") {
				if (v === undefined || v === "") {
					clean[f.key] = secrets?.get(secretSettingKey(f.key)) ?? f.default ?? "";
				} else {
					const s = String(v);
					if (s.length > 4096) {
						return {
							error: pick(l, `${f.label} 过长`, `${f.label} too long`, "plugins.settings.too.long", {
								"f.label": f.label,
							}),
							clean,
						};
					}
					secretUpdates[secretSettingKey(f.key)] = s;
					clean[f.key] = s;
				}
			} else {
				clean[f.key] = v === undefined ? (f.default ?? "") : String(v);
			}
		}
		const secretKeys = new Set(schema.filter((f) => f.type === "secret").map((f) => f.key));
		const persist: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(clean)) if (!secretKeys.has(k)) persist[k] = v;
		const file = join(dir, "storage.json");
		withFileRmwLockSync(file, () => {
			if (secrets) secrets.commitSettings(persist, secretUpdates);
			else {
				let existing: Record<string, unknown> = {};
				try {
					const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid plugin storage");
					existing = parsed as Record<string, unknown>;
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
				}
				writeJsonAtomicSync(file, { ...existing, settings: persist }, 0);
			}
		});
	} catch (err) {
		console.error(`[plugins] settings persist failed (${dir}):`, err);
		return { error: (err as Error).message, clean };
	}
	return { clean };
}

export class PluginManager {
	private loaded = new Map<string, LoadedPlugin>();
	private attempted = new Set<string>();
	private senders = new Set<Sender>();
	private messageHandlers = new Map<string, Set<(payload: unknown, from?: string) => void>>();
	private agentTools = new Map<string, AgentToolTable>();
	onAgentToolsChanged: (() => void) | undefined = undefined;
	private pluginCommands = new Map<string, Map<string, PluginCommandDef>>();
	onCommandsChanged: (() => void) | undefined = undefined;
	private pluginBgTasks = new Map<string, Map<string, PluginBgTask>>();
	onBgTasksChanged: (() => void) | undefined = undefined;
	private pluginMarkers = new Map<string, Map<string, MarkerTool<unknown>>>();
	onMarkersChanged: (() => void) | undefined = undefined;
	readonly panelRunning = new LeftPanelRunningStore();
	private panelPushTimer: ReturnType<typeof setTimeout> | null = null;
	private panelSweepTimer: ReturnType<typeof setInterval> | null = null;
	private epochCounter = 0;
	private lifecycleGeneration = 0;
	private loading: Promise<UiPluginInfo[]> | undefined;
	private reloading: Promise<UiPluginInfo[]> | undefined;
	private activatingEffects = new Set<PluginEffectStack>();
	private catalogEpoch = 0;
	private globalCwd!: string;
	private readonly httpWorkspace = new AsyncLocalStorage<{ cwd: string; roots: string[] }>();
	private get cwdValue(): string {
		return this.httpWorkspace.getStore()?.cwd ?? this.globalCwd;
	}
	private set cwdValue(value: string) {
		this.globalCwd = value;
	}
	private globalWorkspaceRoots: string[] = [];
	private get workspaceRoots(): string[] {
		return this.httpWorkspace.getStore()?.roots ?? this.globalWorkspaceRoots;
	}
	private set workspaceRoots(value: string[]) {
		this.globalWorkspaceRoots = value;
	}
	readonly grants: PluginGrantsStore;
	private readonly domConsentStore: PluginDomConsent;
	private readonly domWants = new Map<string, boolean>();
	pathAccessRequester: ((pluginId: string, dir: string, reason?: string) => Promise<boolean>) | undefined = undefined;
	onGrantsChanged: (() => void) | undefined = undefined;
	private uiRuntime = new Map<string, UiRuntimeUi>();
	private proxyRoutes = new Map<string, { pluginId: string; host: string; port: number }>();
	private uiBase = new Map<string, UiPluginUi>();
	private manifestDiags = new Map<string, string[]>();
	private runtimeDiags = new Map<string, string[]>();
	private pluginLogs = new Map<string, PluginLogEntry[]>();
	private pluginServices = new Map<string, { pluginId: string; service: unknown }>();
	private serviceListeners = new Map<string, Set<(service: unknown | undefined) => void>>();

	constructor(
		private readonly dataDir: string,
		cwd: string,
		private readonly builtinCatalogPath?: string,
	) {
		cleanupRemovedPlugins(dataDir);
		this.cwdValue = resolve(cwd);
		this.grants = new PluginGrantsStore(dataDir);
		this.permGrants = new PluginPermissionStore(dataDir);
		this.domConsentStore = new PluginDomConsent(dataDir);
	}

	notifyCwd(next: string): void {
		const abs = resolve(next);
		if (abs === this.cwdValue) return;
		this.cwdValue = abs;
		for (const [id, p] of this.loaded) {
			for (const h of p.cwdHandlers) {
				try {
					h(abs);
				} catch (err) {
					console.error(`[plugin:${id}] cwd-change handler failed:`, err);
				}
			}
		}
	}

	notifyWorkspaceRoots(roots: string[] | undefined): void {
		const next = normalizeWorkspaceRoots(roots ?? []);
		if (next.length === this.workspaceRoots.length && next.every((p, i) => p === this.workspaceRoots[i])) return;
		this.workspaceRoots = next;
	}

	get pluginsDir(): string {
		return join(this.dataDir, "plugins");
	}

	listCommands(): PluginCommandDef[] {
		const out: PluginCommandDef[] = [];
		for (const id of [...this.pluginCommands.keys()].sort()) {
			out.push(...this.pluginCommands.get(id)!.values());
		}
		return out;
	}

	findCommand(name: string): { def: PluginCommandDef; pluginId: string } | null {
		for (const [pluginId, table] of this.pluginCommands) {
			if (table.has(name)) return { def: table.get(name)!, pluginId };
		}
		return null;
	}

	bgTasks(): BgServer[] {
		const out: BgServer[] = [];
		for (const [pluginId, table] of this.pluginBgTasks) {
			for (const t of table.values()) {
				out.push({
					taskId: t.id,
					plugin: pluginId,
					since: t.since,
					name: t.label,
					...(t.status ? { status: t.status } : {}),
				});
			}
		}
		return out;
	}

	stopPluginBgTask(taskId: string): boolean {
		for (const [pluginId, table] of this.pluginBgTasks) {
			const t = table.get(taskId);
			if (!t) continue;
			try {
				t.stop?.();
			} catch (err) {
				console.error(`[plugin:${pluginId}] background task ${taskId} stop failed:`, err);
			}
			table.delete(taskId);
			if (table.size === 0) this.pluginBgTasks.delete(pluginId);
			try {
				this.onBgTasksChanged?.();
			} catch {}
			return true;
		}
		return false;
	}

	savePluginSettings(pluginId: string, values: Record<string, unknown>, lang?: () => ServerLang): { error?: string } {
		const l = lang?.() ?? "en";
		if (!ID_RE.test(pluginId)) return { error: pick(l, "非法的插件 id", "Invalid plugin id", "plugins.id.invalid") };
		const dir = join(this.pluginsDir, pluginId);
		const info = this.loaded.get(pluginId)?.info;
		const schema = info?.settingsSchema ?? [];
		if (!schema.length)
			return {
				error: pick(
					l,
					"该插件没有声明式设置（manifest 未声明 settings）",
					"This plugin has no declarative settings (manifest declares no settings)",
					"plugins.settings.no.declarative",
				),
			};
		let result: ReturnType<typeof saveSettingsValues>;
		try {
			result = saveSettingsValues(dir, schema, values, lang, new PluginSecrets(this.dataDir, dir));
		} catch (err) {
			return { error: (err as Error).message };
		}
		const { error, clean } = result;
		if (error) return { error };
		for (const h of this.loaded.get(pluginId)?.settingsHandlers ?? []) {
			try {
				h(clean);
			} catch (err) {
				console.error(`[plugin:${pluginId}] onSettingsChanged handler failed:`, err);
			}
		}
		void this.pushToAll().catch(() => {});
		return {};
	}

	get epoch(): number {
		return this.epochCounter;
	}

	get customCatalogPath(): string {
		return join(this.dataDir, "plugin-catalog.json");
	}

	get communityCatalogPath(): string {
		return join(this.dataDir, "community-catalog.json");
	}

	catalog(): UiPluginCatalogEntry[] {
		return this.builtinCatalogPath
			? readCatalog(this.builtinCatalogPath, this.customCatalogPath, this.communityCatalogPath)
			: [];
	}

	get catalogEpochValue(): number {
		return this.catalogEpoch;
	}

	async pushCatalog(): Promise<void> {
		this.deliverAll({ type: "plugin_catalog", entries: this.catalog(), epoch: this.catalogEpoch });
	}

	async pushPermissions(): Promise<void> {
		this.deliverAll({ type: "plugin_permissions", grants: this.permGrants.list() });
	}

	addCatalogEntry(input: CatalogAddInput, lang?: () => ServerLang): { error?: string } {
		try {
			addCustomEntry(this.customCatalogPath, input, lang);
			this.catalogEpoch += 1;
			void this.pushCatalog();
			return {};
		} catch (err) {
			return { error: (err as Error).message };
		}
	}

	removeCatalogEntry(id: string, lang?: () => ServerLang): { error?: string } {
		const l = lang?.() ?? "en";
		try {
			const ok = removeCustomEntry(this.customCatalogPath, id);
			if (!ok)
				return {
					error: pick(
						l,
						"未找到该条目，或它是内置/社区条目（不可移除）",
						"Entry not found, or it is a built-in/community entry (cannot be removed)",
						"plugins.catalog.entry.cannot.remove",
					),
				};
			this.catalogEpoch += 1;
			void this.pushCatalog();
			return {};
		} catch (err) {
			return { error: (err as Error).message };
		}
	}

	addSender(send: (msg: ServerMessage) => void, cid: () => string | null): () => void {
		const s: Sender = { cid, send };
		this.senders.add(s);
		return () => this.senders.delete(s);
	}

	onlineClientIds(): string[] {
		const out = new Set<string>();
		for (const s of this.senders) {
			const cid = s.cid();
			if (cid) out.add(cid);
		}
		return [...out];
	}

	handleMessage(pluginId: string, payload: unknown, from?: string): void {
		if (!ID_RE.test(pluginId)) return;
		if (isPluginLogsRequest(payload)) {
			if (!from) return;
			const cleared = payload.op === "clear";
			if (cleared) this.clearPluginLogs(pluginId);
			const down: PluginLogsWireDown = {
				__host: "logs",
				logs: this.getPluginLogs(pluginId),
				...(cleared ? { cleared: true as const } : {}),
			};
			this.sendTo(from, pluginId, down);
			return;
		}
		const handlers = this.messageHandlers.get(pluginId);
		if (!handlers) return;
		for (const h of handlers) {
			try {
				const ret = h(payload, from) as unknown;
				if (ret instanceof Promise) {
					ret.catch((err) => {
						console.error(`[plugin:${pluginId}] async message handler failed:`, err);
					});
					const timer = setTimeout(() => {
						console.error(`[plugin:${pluginId}] message handler 超时（>${MESSAGE_TIMEOUT_MS}ms），已不再等待`);
					}, MESSAGE_TIMEOUT_MS);
					void ret.finally(() => clearTimeout(timer));
				}
			} catch (err) {
				console.error(`[plugin:${pluginId}] message handler failed:`, err);
			}
		}
	}

	private async maybeConsentNotice(info: UiPluginInfo, dir: string, perms: string[]): Promise<void> {
		try {
			const markerFile = join(dir, ".pi-approved");
			const key = createHash("sha256").update(JSON.stringify(perms)).digest("hex").slice(0, 32);
			let prev = "";
			try {
				prev = JSON.parse(readFileSync(markerFile, "utf8"))?.key ?? "";
			} catch {}
			if (prev === key) return;
			const list = perms.length ? perms.join(", ") : "无";
			this.notifyAll(
				perms.length ? "warning" : "info",
				`插件「${info.name}」已激活（${prev ? "能力清单变更" : "首次安装"}；声明能力：${list}）——请确认来源可信`,
				`Plugin "${info.name}" activated (${prev ? "capability list changed" : "first install"}; declared: ${list}) — verify the source is trusted`,
			);
			writeFileSync(markerFile, JSON.stringify({ v: 1, key, perms }), "utf8");
		} catch (err) {
			console.error(`[plugin:${info.id}] consent notice failed:`, err);
		}
	}

	handleHttp(
		pluginId: string,
		method: string,
		pathIn: string,
		req: Request,
		res: Response,
		workspace?: { cwd: string; roots?: readonly string[] },
	): void {
		const context = {
			cwd: resolve(workspace?.cwd ?? this.globalCwd),
			roots: [...(workspace?.roots ?? (workspace ? [] : this.globalWorkspaceRoots))],
		};
		this.httpWorkspace.run(context, () => this.handleHttpInWorkspace(pluginId, method, pathIn, req, res));
	}

	private handleHttpInWorkspace(pluginId: string, method: string, pathIn: string, req: Request, res: Response): void {
		if (!ID_RE.test(pluginId)) {
			res.status(404).end("plugin not found");
			return;
		}
		const table = this.loaded.get(pluginId)?.httpRoutes;
		const path = "/" + pathIn.replace(/^\/+/, "");
		let handler = table?.get(`${method.toUpperCase()} ${path}`);
		if (!handler && table) {
			const m = method.toUpperCase();
			for (const [key, fn] of table.entries()) {
				if (!key.startsWith(`${m} `)) continue;
				const routePath = key.slice(m.length + 1);
				if (routePath.endsWith("/*")) {
					const prefix = routePath.slice(0, -2);
					if (path === prefix || path.startsWith(prefix + "/")) {
						handler = fn;
						break;
					}
				}
			}
		}
		if (!handler) {
			res.status(404).end("not found");
			return;
		}
		try {
			(req as unknown as { pluginPath?: string }).pluginPath = path;
			void Promise.resolve(handler(req, res)).catch((err: unknown) => {
				console.error(`[plugin:${pluginId}] http ${method} ${path} failed:`, err);
				if (!res.headersSent) res.status(500).end("internal error");
				else res.end();
			});
		} catch (err) {
			console.error(`[plugin:${pluginId}] http ${method} ${path} failed:`, err);
			if (!res.headersSent) res.status(500).end("internal error");
			else res.end();
		}
	}

	registerProxy(pluginId: string, prefix: string, target: unknown): string | null {
		const p = normalizeProxyPrefix(prefix);
		const t = normalizeProxyTarget(target);
		if (!p || !t) return null;
		const taken = this.proxyRoutes.get(p);
		if (taken && taken.pluginId !== pluginId) return null;
		this.proxyRoutes.set(p, { pluginId, host: t.host, port: t.port });
		return p;
	}

	unregisterProxy(pluginId: string, prefix: string): boolean {
		const p = normalizeProxyPrefix(prefix);
		if (!p) return false;
		if (this.proxyRoutes.get(p)?.pluginId !== pluginId) return false;
		return this.proxyRoutes.delete(p);
	}

	provideService(pluginId: string, name: string, service: unknown): () => void {
		const trimmed = String(name ?? "").trim();
		if (!trimmed || !SERVICE_NAME_RE.test(trimmed) || trimmed.length > 64) {
			throw new Error(`provide: 非法服务名 "${name}"（需由字母、数字、下划线、点或短横线组成，1-64 字符）`);
		}
		const existing = this.pluginServices.get(trimmed);
		if (existing && existing.pluginId !== pluginId) {
			throw new Error(`provide: 服务 "${trimmed}" 已由插件 "${existing.pluginId}" 注册`);
		}
		this.pluginServices.set(trimmed, { pluginId, service });
		const listeners = this.serviceListeners.get(trimmed);
		if (listeners) {
			for (const fn of listeners) {
				try {
					fn(service);
				} catch (err) {
					console.error(`[plugin:${pluginId}] service listener failed for "${trimmed}":`, err);
				}
			}
		}
		let revoked = false;
		return () => {
			if (revoked) return;
			revoked = true;
			const current = this.pluginServices.get(trimmed);
			if (current && current.pluginId === pluginId) {
				this.pluginServices.delete(trimmed);
				const currentListeners = this.serviceListeners.get(trimmed);
				if (currentListeners) {
					for (const fn of currentListeners) {
						try {
							fn(undefined);
						} catch (err) {
							console.error(`[plugin:${pluginId}] service revoked listener failed for "${trimmed}":`, err);
						}
					}
				}
			}
		};
	}

	getService<T>(name: string): T | undefined {
		const trimmed = String(name ?? "").trim();
		return this.pluginServices.get(trimmed)?.service as T | undefined;
	}

	hasService(name: string): boolean {
		const trimmed = String(name ?? "").trim();
		return this.pluginServices.has(trimmed);
	}

	listServices(): Array<{ name: string; pluginId: string }> {
		const res: Array<{ name: string; pluginId: string }> = [];
		for (const [name, entry] of this.pluginServices.entries()) {
			res.push({ name, pluginId: entry.pluginId });
		}
		return res;
	}

	onService<T>(name: string, handler: (service: T | undefined) => void): () => void {
		const trimmed = String(name ?? "").trim();
		if (!trimmed || typeof handler !== "function") return () => {};
		let set = this.serviceListeners.get(trimmed);
		if (!set) {
			set = new Set();
			this.serviceListeners.set(trimmed, set);
		}
		set.add(handler as (service: unknown | undefined) => void);
		const current = this.pluginServices.get(trimmed);
		if (current !== undefined) {
			try {
				handler(current.service as T);
			} catch (err) {
				console.error(`[service:${trimmed}] initial onService handler failed:`, err);
			}
		}
		return () => {
			set?.delete(handler as (service: unknown | undefined) => void);
			if (set && set.size === 0) {
				this.serviceListeners.delete(trimmed);
			}
		};
	}

	findProxy(path: string): { prefix: string; pluginId: string; host: string; port: number } | undefined {
		const p = matchProxyPrefix(String(path ?? "").toLowerCase(), this.proxyRoutes.keys());
		if (!p) return undefined;
		const hit = this.proxyRoutes.get(p);
		if (!hit) return undefined;
		return { prefix: p, ...hit };
	}

	broadcast(pluginId: string, payload: unknown): void {
		this.deliverAll({ type: "plugin_data", pluginId, payload });
	}

	notifyAll(level: "info" | "warning" | "error", text: string, textEn?: string): void {
		this.deliverAll({ type: "notice", level, text, textEn });
	}

	sendTo(clientId: string, pluginId: string, payload: unknown): void {
		for (const s of this.senders) {
			if (s.cid() !== clientId) continue;
			try {
				s.send({ type: "plugin_data", pluginId, payload });
			} catch {}
		}
	}

	async pushToAll(): Promise<void> {
		const list = await this.scan();
		this.deliverAll({ type: "plugins", plugins: list, epoch: this.epochCounter });
	}

	isDomBundleBlocked(pluginId: string): boolean {
		if (!this.domWants.get(pluginId)) return false;
		return !this.domConsentStore.has(pluginId);
	}

	isDomPlugin(pluginId: string): boolean {
		return this.domWants.get(pluginId) === true;
	}

	async setDomConsent(pluginId: string, granted: boolean): Promise<{ changed: boolean; error?: string }> {
		const id = String(pluginId ?? "").trim();
		if (!ID_RE.test(id)) return { changed: false, error: "非法插件 id" };
		if (!this.domWants.get(id)) return { changed: false, error: "该插件未声明 dom 能力，无需授权" };
		const changed = this.domConsentStore.set(id, granted);
		if (!changed) return { changed: false };
		this.epochCounter += 1;
		void this.pushToAll().catch(() => {});
		return { changed: true };
	}

	reload(lang?: () => ServerLang): Promise<UiPluginInfo[]> {
		if (this.reloading) return this.reloading;
		this.dispose();
		this.epochCounter += 1;
		const generation = this.lifecycleGeneration;
		const pending = this.ensureLoaded(lang)
			.then((list) => {
				if (generation !== this.lifecycleGeneration) return [];
				for (const s of this.senders) {
					const cid = s.cid();
					if (cid) this.notifyAttach(cid);
				}
				return list;
			})
			.finally(() => {
				if (this.reloading === pending) this.reloading = undefined;
			});
		this.reloading = pending;
		return pending;
	}

	notifyAttach(clientId: string): void {
		for (const [id, p] of this.loaded) {
			for (const h of p.attachHandlers) {
				try {
					h(clientId);
				} catch (err) {
					console.error(`[plugin:${id}] onAttach handler failed:`, err);
				}
			}
		}
	}

	emitToolEvent(ev: PluginToolEvent): void {
		for (const p of this.loaded.values()) {
			for (const h of p.toolHandlers) {
				try {
					h(ev);
				} catch (err) {
					console.error(`[plugin:${p.info.id}] tool-event handler failed:`, err);
				}
			}
		}
	}

	async evaluateToolPre(
		req: ToolPreRequest,
		_lang: string = "en",
	): Promise<{
		verdict:
			| { decision: "allow" }
			| { decision: "deny"; reason?: string; reasonEn?: string }
			| { decision: "ask"; reason?: string; reasonEn?: string };
		pluginId?: string;
	}> {
		const frozen: ToolPreRequest = {
			toolName: req.toolName,
			params: freezeParams(req.params),
			conversationId: req.conversationId,
		};
		const loadedSnapshot = [...this.loaded.values()];
		for (const p of loadedSnapshot) {
			for (const h of p.preGuards ?? []) {
				let raw: unknown;
				try {
					raw = await withGuardTimeout(Promise.resolve().then(() => (h as ToolPreHandler)(frozen)));
				} catch (err) {
					console.error(`[plugin:${p.info.id}] tool-pre guard failed (abstained):`, err);
					this.pushRuntimeDiag(p.info.id, `tool-pre guard threw, abstained (${req.toolName})`);
					continue;
				}
				if (raw === undefined) continue;
				const d = normalizePreDecision(raw);
				if (!isBlockingDecision(d)) continue;
				this.pushRuntimeDiag(p.info.id, `tool-pre ${d.decision} ${req.toolName} (by ${p.info.id})`);
				return { verdict: d, pluginId: p.info.id };
			}
		}
		return { verdict: { decision: "allow" } };
	}

	async evaluateToolPost(
		req: ToolPostRequest,
		lang: string = "en",
	): Promise<{ content?: Array<{ type: string; text?: string }>; pluginIds: string[] } | undefined> {
		let content = Array.isArray((req.result as { content?: unknown } | null)?.content)
			? ([...(req.result as { content: Array<{ type: string; text?: string }> }).content] as Array<{
					type: string;
					text?: string;
				}>)
			: undefined;
		const base = { ...(req.result as Record<string, unknown>), ...(content ? { content: [...content] } : {}) } as {
			content?: Array<{ type: string; text?: string }>;
			[k: string]: unknown;
		};
		let touched = false;
		const pluginIds: string[] = [];
		const frozenReq: ToolPostRequest = {
			toolName: req.toolName,
			params: freezeParams(req.params),
			result: req.result,
			conversationId: req.conversationId,
		};
		const postLoadedSnapshot = [...this.loaded.values()];
		for (const p of postLoadedSnapshot) {
			for (const h of p.postGuards ?? []) {
				let raw: unknown;
				try {
					raw = await withGuardTimeout(Promise.resolve().then(() => (h as ToolPostHandler)(frozenReq)));
				} catch (err) {
					console.error(`[plugin:${p.info.id}] tool-post guard failed (skipped):`, err);
					this.pushRuntimeDiag(p.info.id, `tool-post guard threw, skipped (${req.toolName})`);
					continue;
				}
				const edit = normalizePostEdit(raw);
				if (!edit) continue;
				const merged = applyPostEdit(base, edit, lang);
				base.content = merged.content;
				Object.assign(base, merged);
				touched = true;
				pluginIds.push(p.info.id);
				this.pushRuntimeDiag(p.info.id, `tool-post edited ${req.toolName} (by ${p.info.id})`);
			}
		}
		if (!touched) return undefined;
		return { content: base.content, pluginIds };
	}

	guardDenialText(
		verdict:
			| { decision: "deny"; reason?: string; reasonEn?: string }
			| { decision: "ask"; reason?: string; reasonEn?: string },
		pluginId: string,
		lang: string = "en",
	): string {
		return denialText(verdict, pluginId, lang);
	}

	conversationProvider: ((options?: PluginConversationQuery) => PluginConversationSnapshot | null) | undefined =
		undefined;
	chatProvider: ((pluginId: string, req: PluginChatRequest) => Promise<PluginChatResult>) | undefined = undefined;
	workItemsProvider:
		| ((
				pluginId: string,
				method: keyof import("../plugin-sdk/index.js").PluginWorkItems,
				args: Record<string, unknown>,
		  ) => Promise<unknown>)
		| undefined = undefined;
	llmProvider:
		| ((
				pluginId: string,
				req: Partial<import("./plugin-llm.js").PluginLlmRequest>,
		  ) => Promise<{
				ok: boolean;
				text?: string;
				model?: string;
				usage?: { input: number; output: number };
				error?: string;
		  }>)
		| undefined = undefined;
	conversationLister:
		(() => Array<PluginConversationListItem> | Promise<Array<PluginConversationListItem>>) | undefined = undefined;
	conversationSearcher:
		| ((
				query: string,
				limit?: number,
		  ) => Array<{ id: string; title: string }> | Promise<Array<{ id: string; title: string }>>)
		| undefined = undefined;
	conversationWriter:
		| ((
				conversationId: string,
				text: string,
				attachments?: Array<{ path: string; mode?: string }>,
		  ) => Promise<{ ok: boolean; error?: string }>)
		| undefined = undefined;
	runSteerer: ((conversationId: string, text: string) => Promise<{ ok: boolean; error?: string }>) | undefined =
		undefined;
	runAborter: ((conversationId: string) => Promise<{ ok: boolean; error?: string }>) | undefined = undefined;
	modelLister: (() => PluginModelInfo[] | Promise<PluginModelInfo[]>) | undefined = undefined;
	mcpProjects: McpProjectRuntimeRegistry | undefined = undefined;
	readonly permGrants: PluginPermissionStore;
	permissionRequester:
		| ((
				pluginId: string,
				req: { family: PermissionFamily; hosts?: string[]; models?: string[]; reason?: string },
		  ) => Promise<{ ok: boolean; remember: boolean }>)
		| undefined = undefined;
	onPermGrantsChanged: (() => void) | undefined = undefined;
	readonly statsHandlers = new Set<(s: PluginStats) => void>();
	readonly streamingHandlers = new Set<(ev: { conversationId?: string; delta: string }) => void>();
	readonly busHandlers = new Map<string, Set<(ev: PluginBusEvent) => void>>();
	private chatWaiters: Array<{ conversationId: string; runId?: string; done: (ended: boolean) => void }> = [];
	private activatingGates = new Map<string, GateRecord>();

	emitStats(s: PluginStats): void {
		for (const h of this.statsHandlers) {
			try {
				h(s);
			} catch (err) {
				console.error("[plugins] stats handler failed:", err);
			}
		}
	}

	emitStreaming(ev: { conversationId?: string; delta: string }): void {
		for (const h of this.streamingHandlers) {
			try {
				h(ev);
			} catch (err) {
				console.error("[plugins] streaming handler failed:", err);
			}
		}
	}

	private canUse(pluginId: string, family: string): boolean {
		const rec: GateRecord | undefined = this.activatingGates.get(pluginId) ?? this.loaded.get(pluginId);
		const fam = String(family ?? "");
		const deny = (what: string): boolean => {
			console.error(`[plugin:${pluginId}] 缺少能力声明 "${what}"（manifest.permissions）——请求被拒`);
			this.pushRuntimeDiag(pluginId, `missing capability "${what}" (manifest.permissions) — request denied`);
			return false;
		};
		if (!rec) return deny(fam);
		const full = new Set(rec.permsDeclared ?? []);
		const strict = rec.strictMode ?? (rec.permsDeclared?.length ?? 0) > 0;
		const legacy = (what: string): boolean => {
			if (!strict) {
				if (!rec.legacyWarned) {
					rec.legacyWarned = true;
					console.warn(
						`[plugin:${pluginId}] manifest 未声明 permissions（旧格式全权模式）——已放行 "${what}"；apiVersion 2 起将默认拒绝，请尽快声明`,
					);
				}
				return true;
			}
			return deny(what);
		};
		if (fam === "fs:read" || fam === "fs:write") {
			if (full.has("fs") || full.has(fam)) return true;
			return legacy(fam);
		}
		if (fam === "fs") {
			if (full.has("fs")) return true;
			return legacy(fam);
		}
		if ((rec.permFamilies ?? new Set<string>()).has(fam)) return true;
		return legacy(fam);
	}

	private waitRunEnd(conversationId: string, timeoutMs: number, runId?: string): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const entry = {
				conversationId,
				...(runId ? { runId } : {}),
				done: (ended: boolean) => {
					clearTimeout(timer);
					const i = this.chatWaiters.indexOf(entry);
					if (i >= 0) this.chatWaiters.splice(i, 1);
					resolve(ended);
				},
			};
			const timer = setTimeout(() => entry.done(false), timeoutMs);
			this.chatWaiters.push(entry);
		});
	}

	getActiveConversation(options?: PluginConversationQuery): PluginConversationSnapshot | null {
		let snap: PluginConversationSnapshot | null;
		try {
			snap = this.conversationProvider?.(options) ?? null;
		} catch (err) {
			console.error("[plugins] conversationProvider failed:", err);
			return null;
		}
		return snap ? copySnapshotForPlugins(snap) : null;
	}

	emitClientModelChanged(snap: PluginConversationSnapshot): void {
		const copy = copySnapshotForPlugins(snap);
		for (const p of this.loaded.values()) {
			const hs = p.modelChangeHandlers;
			if (!hs || hs.size === 0) continue;
			for (const h of hs) {
				try {
					h(copy);
				} catch (err) {
					console.error(`[plugin:${p.info.id}] client-model-changed handler failed:`, err);
				}
			}
		}
	}

	emitConversationChanged(): void {
		for (const p of this.loaded.values()) {
			if (p.convChangeHandlers.size === 0) continue;
			for (const h of p.convChangeHandlers) {
				try {
					h();
				} catch (err) {
					console.error(`[plugin:${p.info.id}] conversation-changed handler failed:`, err);
				}
			}
		}
	}

	emitRunEvent(ev: PluginRunEvent): void {
		if (ev.type === "run_end" && (ev.conversationId || ev.runId)) {
			for (const w of this.chatWaiters) {
				const byRun = Boolean(ev.runId && w.runId && ev.runId === w.runId);
				const byConv = Boolean(ev.conversationId) && w.conversationId === ev.conversationId && !w.runId;
				if (!byRun && !byConv) continue;
				try {
					w.done(true);
				} catch (err) {
					console.error(`[plugins] chatWait waiter failed:`, err);
				}
			}
		}
		for (const p of this.loaded.values()) {
			if (p.runHandlers.size === 0) continue;
			for (const h of p.runHandlers) {
				try {
					h(ev);
				} catch (err) {
					console.error(`[plugin:${p.info.id}] run-event handler failed:`, err);
				}
			}
		}
	}

	agentToolsSnapshot(pluginId: string): UiPluginAgentTool[] {
		const table = this.agentTools.get(pluginId);
		if (!table) return [];
		return [...table.values()]
			.map((t) => ({
				name: t.name,
				...(t.label ? { label: t.label } : {}),
				...(t.description ? { description: t.description } : {}),
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	getAgentToolsGrouped(): { pluginId: string; tools: UiPluginAgentTool[] }[] {
		const out: { pluginId: string; tools: UiPluginAgentTool[] }[] = [];
		for (const pid of [...this.agentTools.keys()].sort()) {
			const tools = this.agentToolsSnapshot(pid);
			if (tools.length) out.push({ pluginId: pid, tools });
		}
		return out;
	}

	getAgentTools(): PluginAgentTool[] {
		const out: PluginAgentTool[] = [];
		for (const [pid, table] of [...this.agentTools.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			for (const tool of table.values()) {
				out.push({ ...tool, pluginId: pid });
			}
		}
		return out;
	}
	private registerAgentTool(pluginId: string, tool: PluginAgentTool): () => void {
		if (!tool || typeof tool.execute !== "function" || !tool.name || !tool.description) {
			console.error(`[plugin:${pluginId}] registerAgentTool: 缺少 name/description/execute，忽略`);
			this.pushRuntimeDiag(pluginId, "registerAgentTool: missing name/description/execute, ignored");
			return () => {};
		}
		for (const [pid, other] of this.agentTools) {
			if (pid !== pluginId && other.has(tool.name)) {
				console.error(`[plugin:${pluginId}] AI 工具 "${tool.name}" 已被插件 ${pid} 注册，忽略重复`);
				this.pushRuntimeDiag(pluginId, `agent tool "${tool.name}": already registered by plugin ${pid}, ignored`);
				return () => {};
			}
		}
		let table = this.agentTools.get(pluginId);
		if (!table) this.agentTools.set(pluginId, (table = new Map()));
		if (table.has(tool.name)) {
			console.error(`[plugin:${pluginId}] AI 工具 "${tool.name}" 重复注册，忽略`);
			this.pushRuntimeDiag(pluginId, `agent tool "${tool.name}": duplicate registration, ignored`);
			return () => {};
		}
		table.set(tool.name, tool);
		console.log(`[plugin:${pluginId}] registered AI tool: ${tool.name}`);
		try {
			this.onAgentToolsChanged?.();
		} catch (err) {
			console.error("[plugins] onAgentToolsChanged failed:", err);
		}
		return () => {
			if (table.delete(tool.name)) {
				if (table.size === 0) this.agentTools.delete(pluginId);
				try {
					this.onAgentToolsChanged?.();
				} catch {}
			}
		};
	}

	private registerMarker<State = unknown>(pluginId: string, marker: PluginMarkerDef<State>): () => void {
		if (!marker || typeof marker !== "object") {
			console.error(`[plugin:${pluginId}] registerMarker: 缺少 marker 参数，忽略`);
			this.pushRuntimeDiag(pluginId, "registerMarker: missing marker parameter, ignored");
			return () => {};
		}
		const name = String(marker.name ?? "").trim();
		if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
			console.error(
				`[plugin:${pluginId}] registerMarker: 非法名称「${marker.name}」（需英文字母开头，只允许字母数字_-），忽略`,
			);
			this.pushRuntimeDiag(
				pluginId,
				`registerMarker: invalid name "${String(marker.name ?? "").slice(0, 32)}", ignored`,
			);
			return () => {};
		}
		if (isBuiltinMarker(name)) {
			console.error(`[plugin:${pluginId}] registerMarker: 名称「${name}」为系统内置标记保留名称，忽略冲突注册`);
			this.pushRuntimeDiag(pluginId, `registerMarker: "${name}" conflicts with built-in marker, ignored`);
			return () => {};
		}
		if (typeof marker.apply !== "function") {
			console.error(`[plugin:${pluginId}] registerMarker: ${name} 缺少 apply 函数，忽略`);
			this.pushRuntimeDiag(pluginId, `marker "${name}": missing apply function, ignored`);
			return () => {};
		}
		if (!Array.isArray(marker.guidance) || marker.guidance.length === 0) {
			console.error(`[plugin:${pluginId}] registerMarker: ${name} 缺少 guidance 引导说明，忽略`);
			this.pushRuntimeDiag(pluginId, `marker "${name}": missing guidance, ignored`);
			return () => {};
		}
		for (const [pid, other] of this.pluginMarkers) {
			if (pid !== pluginId && other.has(name)) {
				console.error(`[plugin:${pluginId}] 标记 "${name}" 已被插件 ${pid} 注册，忽略重复`);
				this.pushRuntimeDiag(pluginId, `marker "${name}": already registered by plugin ${pid}, ignored`);
				return () => {};
			}
		}
		let table = this.pluginMarkers.get(pluginId);
		if (!table) this.pluginMarkers.set(pluginId, (table = new Map()));
		if (table.has(name)) {
			console.error(`[plugin:${pluginId}] 标记 "${name}" 重复注册，忽略`);
			this.pushRuntimeDiag(pluginId, `marker "${name}": duplicate registration, ignored`);
			return () => {};
		}

		const markerTool: MarkerTool = {
			name,
			label: marker.label ? String(marker.label).slice(0, 80) : undefined,
			pluginId,
			guidance: [...marker.guidance],
			getGuidance: marker.getGuidance,
			apply: marker.apply as MarkerTool["apply"],
			overlay: marker.overlay,
			init: marker.init,
		};

		table.set(name, markerTool);
		registerMarker(markerTool);
		console.log(`[plugin:${pluginId}] registered inline marker: ${name}`);

		try {
			this.onMarkersChanged?.();
		} catch (err) {
			console.error("[plugins] onMarkersChanged failed:", err);
		}

		return () => {
			if (table.delete(name)) {
				if (table.size === 0) this.pluginMarkers.delete(pluginId);
				unregisterMarker(name);
				try {
					this.onMarkersChanged?.();
				} catch {}
			}
		};
	}

	private registerCommand(pluginId: string, cmd: PluginCommandDef): () => void {
		const name = String(cmd?.name ?? "").replace(/^\/+/, "");
		if (!/^[a-zA-Z][a-zA-Z0-9:_-]*$/.test(name)) {
			console.error(
				`[plugin:${pluginId}] registerCommand: 非法名称「${cmd?.name}」（需字母开头，允许字母数字:_-），忽略`,
			);
			this.pushRuntimeDiag(
				pluginId,
				`registerCommand: invalid name "${String(cmd?.name ?? "").slice(0, 32)}", ignored`,
			);
			return () => {};
		}
		if (typeof cmd?.run !== "function") {
			console.error(`[plugin:${pluginId}] registerCommand: ${name} 缺少 run，忽略`);
			this.pushRuntimeDiag(pluginId, `command "/${name}": missing run, ignored`);
			return () => {};
		}
		for (const [pid, table] of this.pluginCommands) {
			if (table.has(name) && pid !== pluginId) {
				console.error(`[plugin:${pluginId}] 命令 /${name} 已被插件 ${pid} 注册，忽略重复`);
				this.pushRuntimeDiag(pluginId, `command "/${name}": already registered by plugin ${pid}, ignored`);
				return () => {};
			}
		}
		let table = this.pluginCommands.get(pluginId);
		if (!table) this.pluginCommands.set(pluginId, (table = new Map()));
		if (table.has(name)) {
			console.error(`[plugin:${pluginId}] 命令 /${name} 重复注册，忽略`);
			this.pushRuntimeDiag(pluginId, `command "/${name}": duplicate registration, ignored`);
			return () => {};
		}
		const def: PluginCommandDef = { ...cmd, name };
		table.set(name, def);
		console.log(`[plugin:${pluginId}] registered command: /${name}`);
		try {
			this.onCommandsChanged?.();
		} catch (err) {
			console.error("[plugins] onCommandsChanged failed:", err);
		}
		return () => {
			if (table!.delete(name)) {
				if (table!.size === 0) this.pluginCommands.delete(pluginId);
				try {
					this.onCommandsChanged?.();
				} catch {}
			}
		};
	}

	private uiRuntimeFor(pluginId: string): UiRuntimeUi {
		let rt = this.uiRuntime.get(pluginId);
		if (!rt) this.uiRuntime.set(pluginId, (rt = { items: new Map(), removed: new Set(), arrange: [] }));
		return rt;
	}

	private removeUiItem(pluginId: string, itemId: string): void {
		const rt = this.uiRuntimeFor(pluginId);
		rt.items.delete(itemId);
		rt.removed.add(itemId);
	}

	isInsideWorkspace(abs: string): boolean {
		for (const root of [this.cwdValue, ...this.workspaceRoots]) {
			const rel = relative(root, abs);
			if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return true;
		}
		return false;
	}

	uiOf(pluginId: string): UiPluginUi | undefined {
		return mergeUiPluginUi(this.uiBase.get(pluginId), this.uiRuntime.get(pluginId));
	}

	private pushRuntimeDiag(pluginId: string, msg: string): void {
		if (!ID_RE.test(pluginId)) return;
		let arr = this.runtimeDiags.get(pluginId);
		if (!arr) this.runtimeDiags.set(pluginId, (arr = []));
		if (arr.includes(msg)) return;
		if (arr.length < 100) arr.push(msg);
		const p = this.loaded.get(pluginId);
		if (p) {
			const combined = this.diagnosticsOf(pluginId);
			if (combined) p.info.diagnostics = combined;
			else delete p.info.diagnostics;
		}
	}

	private diagnosticsOf(pluginId: string): string[] | undefined {
		const m = this.manifestDiags.get(pluginId) ?? [];
		const r = this.runtimeDiags.get(pluginId) ?? [];
		if (!m.length && !r.length) return undefined;
		return [...m, ...r].slice(0, 100);
	}

	appendPluginLog(pluginId: string, level: PluginLogLevel, text: string): void {
		if (!ID_RE.test(pluginId)) return;
		let arr = this.pluginLogs.get(pluginId);
		if (!arr) this.pluginLogs.set(pluginId, (arr = []));
		arr.push({
			ts: Date.now(),
			level,
			text: text.length > PLUGIN_LOG_TEXT_MAX ? text.slice(0, PLUGIN_LOG_TEXT_MAX) : text,
		});
		if (arr.length > PLUGIN_LOG_CAP) arr.splice(0, arr.length - PLUGIN_LOG_CAP);
	}

	getPluginLogs(pluginId: string): PluginLogEntry[] {
		return (this.pluginLogs.get(pluginId) ?? []).map((e) => ({ ...e }));
	}

	clearPluginLogs(pluginId: string): void {
		if (!ID_RE.test(pluginId)) return;
		this.pluginLogs.set(pluginId, []);
	}

	private deliverAll(msg: ServerMessage): void {
		for (const s of this.senders) {
			try {
				s.send(msg);
			} catch {}
		}
	}

	schedulePanelPush(): void {
		if (this.panelPushTimer) return;
		this.panelPushTimer = setTimeout(() => {
			this.panelPushTimer = null;
			this.deliverAll({ type: "plugin_panel_items", groups: this.panelRunning.groups() });
		}, 500);
		this.panelPushTimer.unref?.();
	}
	ensurePanelSweep(): void {
		if (this.panelSweepTimer) return;
		this.panelSweepTimer = setInterval(() => {
			const expired = this.panelRunning.sweep();
			if (expired.length) this.schedulePanelPush();
			if (this.panelRunning.size === 0 && this.panelSweepTimer) {
				clearInterval(this.panelSweepTimer);
				this.panelSweepTimer = null;
			}
		}, 5000);
		this.panelSweepTimer.unref?.();
	}
	panelGroups(): PluginPanelGroup[] {
		return this.panelRunning.groups();
	}

	async list(lang?: () => ServerLang): Promise<UiPluginInfo[]> {
		return this.scan(lang);
	}

	getApiCatalog(): PluginApiCatalog {
		const counts = new Map<string, Map<string, number>>();
		const add = (pluginId: string, slot: string): void => {
			let m = counts.get(slot);
			if (!m) counts.set(slot, (m = new Map()));
			m.set(pluginId, (m.get(pluginId) ?? 0) + 1);
		};
		for (const [pid, base] of this.uiBase) for (const it of base.items ?? []) add(pid, it.slot);
		for (const [pid, rt] of this.uiRuntime) for (const it of rt.items.values()) add(pid, it.slot);
		return buildPluginApiCatalog({
			slots: [...UI_SLOTS],
			aliases: { ...UI_SLOT_ALIASES },
			kinds: [...UI_KINDS],
			agentTools: AGENT_TOOL_CATALOG.map((t) => ({
				name: t.name,
				group: t.group,
				defaultOn: t.defaultOn,
				dshVisible: t.dshVisible,
			})),
			occupantsOf: (slot) => {
				const m = counts.get(slot);
				if (!m) return [];
				return [...m].map(([pluginId, items]) => ({ pluginId, items }));
			},
		});
	}

	ensureLoaded(lang?: () => ServerLang): Promise<UiPluginInfo[]> {
		if (this.loading) return this.loading;
		const pending = this.loadGeneration(this.lifecycleGeneration, lang).finally(() => {
			if (this.loading === pending) this.loading = undefined;
		});
		this.loading = pending;
		return pending;
	}

	private async loadGeneration(generation: number, lang?: () => ServerLang): Promise<UiPluginInfo[]> {
		const l = lang?.() ?? "en";
		const found = await this.scan(lang);
		if (generation !== this.lifecycleGeneration) return [];
		const byId = new Map(found.map((f) => [f.id, f]));
		const scannedIds = new Set(byId.keys());
		const { order, cyclic } = sortByRequires(
			found.map((f) => f.id),
			(id) => (byId.get(id)?.requires?.plugins ?? []).filter((d) => scannedIds.has(d)),
		);
		for (const cycId of cyclic) {
			const info = byId.get(cycId)!;
			if (this.loaded.has(info.id) || this.attempted.has(info.id)) continue;
			const msg = pick(
				l,
				`插件 requires 存在循环依赖（${cycId}）—— 请先解环再激活`,
				`Plugin has cyclic requires (${cycId}) — break the cycle first`,
				"plugins.requires.cycle",
				{ id: cycId },
			);
			this.setFrozenRefusal(info, msg, `cyclic requires (${cycId})`);
		}
		for (const id of order) {
			const info = byId.get(id)!;
			if (this.loaded.has(info.id) || this.attempted.has(info.id)) continue;
			if (!existsSync(join(this.pluginsDir, info.id, "index.mjs"))) continue;
			await this.activate(info, lang);
			if (generation !== this.lifecycleGeneration) return [];
		}
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const [id, p] of [...this.loaded]) {
			if (!found.some((f) => f.id === id)) {
				this.deactivateEntry(id, p);
			}
		}
		this.cascadeRequiresRefusals(found, lang);
		return found.map((f) => {
			const base = this.loaded.get(f.id)?.info ?? f;
			const withPhase = { ...base, active: this.loaded.has(f.id) };
			const agentTools = this.agentToolsSnapshot(f.id);
			if (agentTools.length) return { ...withPhase, agentTools };
			const { agentTools: _drop, ...rest } = withPhase as UiPluginInfo & { agentTools?: unknown };
			return rest;
		});
	}

	private releaseEntry(p: LoadedPlugin): void {
		const failed = p.effects?.release() ?? [];
		if (failed.length > 0)
			console.warn(`[plugin:${p.info.id}] ${failed.length} effect(s) failed to clean up: ${failed.join(", ")}`);
		for (const [prefix, hit] of this.proxyRoutes) {
			if (hit.pluginId === p.info.id) this.proxyRoutes.delete(prefix);
		}
		for (const [name, hit] of this.pluginServices) {
			if (hit.pluginId === p.info.id) {
				this.pluginServices.delete(name);
				const listeners = this.serviceListeners.get(name);
				if (listeners) {
					for (const fn of listeners) {
						try {
							fn(undefined);
						} catch {}
					}
				}
			}
		}
	}

	private runDeactivate(id: string, deactivate?: () => void): void {
		try {
			void Promise.resolve(deactivate?.()).catch((err: unknown) => {
				console.error(`[plugin:${id}] deactivate failed:`, err);
			});
		} catch (err) {
			console.error(`[plugin:${id}] deactivate failed:`, err);
		}
	}

	private deactivateEntry(id: string, p: LoadedPlugin): void {
		this.runDeactivate(id, p.deactivate);
		this.releaseEntry(p);
		this.loaded.delete(id);
		this.messageHandlers.delete(id);
		this.attempted.delete(id);
		this.uiRuntime.delete(id);
		this.uiBase.delete(id);
		this.manifestDiags.delete(id);
		this.runtimeDiags.delete(id);
		this.pluginLogs.delete(id);
		this.epochCounter += 1;
		console.log(`[plugin:${id}] removed`);
	}

	dispose(): void {
		this.lifecycleGeneration += 1;
		this.loading = undefined;
		this.reloading = undefined;
		this.attempted.clear();
		this.activatingGates.clear();
		for (const effects of this.activatingEffects) effects.release();
		this.activatingEffects.clear();
		const pluginIds = new Set<string>();
		for (const [id, p] of this.loaded) {
			pluginIds.add(id);
			this.runDeactivate(id, p.deactivate);
		}
		for (const [id, p] of this.loaded) {
			p.effects?.release();
			this.loaded.delete(id);
		}
		for (const id of pluginIds) {
			for (const t of this.pluginBgTasks.get(id)?.values() ?? []) {
				try {
					t.stop?.();
				} catch {}
			}
		}
		for (const prefix of this.proxyRoutes.keys()) {
			if (pluginIds.has(this.proxyRoutes.get(prefix)!.pluginId)) this.proxyRoutes.delete(prefix);
		}
		this.pluginServices.clear();
		this.serviceListeners.clear();
		if (this.panelPushTimer) {
			clearTimeout(this.panelPushTimer);
			this.panelPushTimer = null;
		}
		if (this.panelSweepTimer) {
			clearInterval(this.panelSweepTimer);
			this.panelSweepTimer = null;
		}
		this.agentTools.clear();
		this.pluginMarkers.clear();
		this.pluginCommands.clear();
		this.uiRuntime.clear();
		this.uiBase.clear();
		this.proxyRoutes.clear();
		this.pluginBgTasks.clear();
		this.loaded.clear();
		this.messageHandlers.clear();
		this.manifestDiags.clear();
		this.runtimeDiags.clear();
		this.pluginLogs.clear();
	}

	private syncBuiltinPlugins(): void {
		if (!this.builtinCatalogPath || !existsSync(this.builtinCatalogPath)) return;
		const builtinDir = dirname(this.builtinCatalogPath);
		if (!existsSync(builtinDir)) return;

		const builtinSdkDir = join(dirname(builtinDir), "plugin-sdk");
		const targetSdkDir = join(this.dataDir, "plugin-sdk");
		if (existsSync(builtinSdkDir)) {
			try {
				cpSync(builtinSdkDir, targetSdkDir, { recursive: true });
			} catch {}
		}

		try {
			prepareBundledPlugins(
				this.dataDir,
				this.builtinCatalogPath,
				new Set(
					this.catalog()
						.filter((entry) => entry.origin === "custom")
						.map((entry) => entry.id),
				),
			);
		} catch (err) {
			console.warn("[plugins] Preparing bundled modules failed:", err);
		}

		let names: string[];
		try {
			names = readdirSync(this.pluginsDir);
		} catch {
			return;
		}

		let builtinCatalogIds: Set<string>;
		try {
			const catalogEntries = JSON.parse(readFileSync(this.builtinCatalogPath, "utf8")) as Array<{ id?: string }>;
			builtinCatalogIds = new Set(
				catalogEntries.map((e) => e?.id).filter((id): id is string => typeof id === "string"),
			);
		} catch {
			builtinCatalogIds = new Set();
		}

		for (const name of names) {
			if (!ID_RE.test(name) || !builtinCatalogIds.has(name)) continue;
			const targetDir = join(this.pluginsDir, name);
			const sourceDir = join(builtinDir, name);

			try {
				if (lstatSync(targetDir).isSymbolicLink()) {
					continue;
				}
			} catch {}

			const targetManifest = join(targetDir, "manifest.json");
			const sourceManifest = join(sourceDir, "manifest.json");

			if (!existsSync(sourceDir) || !existsSync(sourceManifest) || !existsSync(targetManifest)) {
				continue;
			}

			try {
				const srcRaw = JSON.parse(readFileSync(sourceManifest, "utf8")) as { version?: string };
				const tgtRaw = JSON.parse(readFileSync(targetManifest, "utf8")) as { version?: string };
				const srcVer = typeof srcRaw.version === "string" ? srcRaw.version.trim() : "";
				const tgtVer = typeof tgtRaw.version === "string" ? tgtRaw.version.trim() : "";

				if (srcVer && tgtVer && compareVersions(srcVer, tgtVer) > 0) {
					ensureBackup(this.dataDir, name, { source: `builtin:${srcVer}` });
					cpSync(sourceDir, targetDir, {
						recursive: true,
						filter: (s) => !/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(s),
					});
					console.log(`[plugins] 内置插件 ${name} 随宿主自动同步升级：${tgtVer} → ${srcVer}`);
				}
			} catch (err) {
				console.warn(`[plugins] 自动同步内置插件 ${name} 失败:`, err);
			}
		}
	}

	private async scan(lang?: () => ServerLang): Promise<UiPluginInfo[]> {
		const generation = this.lifecycleGeneration;
		this.syncBuiltinPlugins();
		const l = lang?.() ?? "en";
		let names: string[];
		try {
			names = await readdir(this.pluginsDir);
			if (generation !== this.lifecycleGeneration) return [];
		} catch {
			return [];
		}
		const out: UiPluginInfo[] = [];
		for (const name of names.sort()) {
			if (!ID_RE.test(name)) continue;
			const dir = join(this.pluginsDir, name);
			try {
				const st = await stat(dir);
				if (generation !== this.lifecycleGeneration) return [];
				if (!st.isDirectory()) continue;
			} catch {
				continue;
			}
			try {
				const raw = await readFile(join(dir, "manifest.json"), "utf8");
				if (generation !== this.lifecycleGeneration) return [];
				const m = JSON.parse(raw) as {
					id?: string;
					name?: string;
					version?: string;
					description?: string;
					homepage?: string;
					icon?: string;
					iconSvg?: string;
					apiVersion?: number;
					permissions?: unknown;
					netAllowlist?: unknown;
					engines?: unknown;
					peerPlugins?: unknown;
					requires?: unknown;
					settings?: unknown;
					renderers?: unknown;
					messageWidgets?: unknown;
					attachmentCards?: unknown;
					composerProviders?: unknown;
					fileHandlers?: unknown;
					view?: unknown;
					preload?: unknown;
					ui?: unknown;
					isolated?: unknown;
					shadow?: unknown;
				};
				const wantsDom = declarationWantsDom(m.permissions);
				this.domWants.set(name, wantsDom);
				const uiDiags: string[] = [];
				const mv = validatePluginManifest(m, name);
				for (const w of mv.warnings) uiDiags.push(formatManifestIssue(w));
				if (mv.errors.length > 0) {
					for (const e of mv.errors) uiDiags.push(formatManifestIssue(e));
					const first = mv.errors[0]!;
					const msg = pick(
						l,
						`manifest 校验失败：${first.message}（${name}/）—— 修复后点“重新扫描”`,
						`manifest validation failed: ${first.messageEn} (${name}/) — fix it, then hit Rescan`,
						"plugins.manifest.invalid",
						{ name, path: first.path, message: first.messageEn },
					);
					console.error(`[plugin:${name}] ${msg}`);
					this.manifestDiags.set(name, uiDiags);
					const refused = [...uiDiags, ...(this.runtimeDiags.get(name) ?? [])].slice(0, 100);
					out.push({
						id: name,
						name: typeof m.name === "string" && m.name ? m.name : name,
						hasClient: existsSync(join(dir, "client", "entry.mjs")),
						error: msg,
						view: false,
						...(refused.length ? { diagnostics: refused } : {}),
					});
					const lpRefused = this.loaded.get(name);
					if (lpRefused) {
						if (refused.length) lpRefused.info.diagnostics = [...refused];
						else delete lpRefused.info.diagnostics;
					}
					continue;
				}
				const settingsSchemaForScan = parseSettingsSchema(m.settings);
				const overlayFileForScan = readSettingsOverlayFile(this.dataDir, name);
				const overlayForScan = cleanOverlaySettings(settingsSchemaForScan, overlayFileForScan.raw, "en");
				for (const w of [...overlayFileForScan.warnings, ...overlayForScan.warnings]) uiDiags.push(`override: ${w}`);
				const resolvedSettingsForScan = resolveSettingsValues(
					settingsSchemaForScan,
					readStoredSettings(dir),
					overlayForScan.values,
					{ has: (k) => new PluginSecrets(this.dataDir, dir).has(k) },
				);
				const hasClient = existsSync(join(dir, "client", "entry.mjs"));
				out.push({
					id: name,
					name: typeof m.name === "string" && m.name ? m.name : name,
					version: typeof m.version === "string" ? m.version : undefined,
					description: typeof m.description === "string" ? m.description : undefined,
					homepage: typeof m.homepage === "string" && m.homepage.trim() ? m.homepage.trim() : undefined,
					icon: typeof m.icon === "string" && m.icon.trim() ? m.icon.trim() : undefined,
					iconSvg: normalizeIconSvg(m.iconSvg),
					hasClient,
					error: this.loaded.get(name)?.info.error,
					permissions: Array.isArray(m.permissions)
						? m.permissions.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, 16)
						: undefined,
					netAllowlist: Array.isArray(m.netAllowlist)
						? m.netAllowlist
								.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
								.map((x) => x.trim().toLowerCase())
								.slice(0, 32)
						: undefined,
					engines:
						m.engines && typeof m.engines === "object" && !Array.isArray(m.engines)
							? (Object.fromEntries(
									Object.entries(m.engines as Record<string, unknown>)
										.filter(([, v]) => typeof v === "string")
										.slice(0, 8),
								) as Record<string, string>)
							: undefined,
					peerPlugins: Array.isArray(m.peerPlugins)
						? m.peerPlugins.filter((x): x is string => typeof x === "string" && ID_RE.test(x)).slice(0, 16)
						: undefined,
					requires: parseRequires(m.requires),
					...(wantsDom
						? {
								wantsDom: true as const,
								domGranted: this.domConsentStore.has(name),
								...(this.domConsentStore.has(name)
									? {}
									: {
											error: this.loaded.get(name)?.info.error ?? "需授权完全 DOM 访问后加载（设置 → 界面插件 → 授权）",
										}),
							}
						: {}),
					settingsSchema: settingsSchemaForScan,
					settingsValues: resolvedSettingsForScan.values,
					settingsSources: resolvedSettingsForScan.sources,
					isolated: m.isolated === true || m.shadow === true ? true : undefined,
					renderers: Array.isArray(m.renderers)
						? m.renderers.filter((r): r is string => typeof r === "string" && r.length > 0).slice(0, 32)
						: undefined,
					messageWidgets: Array.isArray(m.messageWidgets)
						? m.messageWidgets.filter((r): r is string => typeof r === "string" && r.length > 0).slice(0, 32)
						: undefined,
					attachmentCards: Array.isArray(m.attachmentCards)
						? m.attachmentCards.filter((r): r is string => typeof r === "string" && r.length > 0).slice(0, 32)
						: undefined,
					composerProviders: Array.isArray(m.composerProviders)
						? m.composerProviders.filter((r): r is string => typeof r === "string" && r.length > 0).slice(0, 32)
						: undefined,
					fileHandlers: (() => {
						if (!Array.isArray(m.fileHandlers)) return undefined;
						const rows = m.fileHandlers
							.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x))
							.slice(0, 32)
							.map((x) => {
								const extensions = Array.isArray(x.extensions)
									? x.extensions
											.filter(
												(e): e is string => typeof e === "string" && /^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(e.trim()),
											)
											.map((e) => e.trim().toLowerCase())
											.slice(0, 32)
									: [];
								if (!extensions.length) return null;
								const id = typeof x.id === "string" && /^[A-Za-z0-9_-]+$/.test(x.id) ? x.id : "default";
								return {
									id,
									extensions: [...new Set(extensions)],
									priority: Number.isFinite(Number(x.priority))
										? Math.max(-1000, Math.min(1000, Number(x.priority)))
										: 0,
									...(typeof x.label === "string" && x.label.trim() ? { label: x.label.trim().slice(0, 120) } : {}),
									...(typeof x.labelEn === "string" && x.labelEn.trim()
										? { labelEn: x.labelEn.trim().slice(0, 120) }
										: {}),
								};
							})
							.filter((x): x is NonNullable<typeof x> => x !== null);
						return rows.length ? rows : undefined;
					})(),
					view: typeof m.view === "boolean" ? m.view : hasClient,
					preload: m.preload === true,
					ui: (() => {
						const perms = Array.isArray(m.permissions)
							? m.permissions.filter((x): x is string => typeof x === "string")
							: [];
						const apiVersion = Number(m.apiVersion ?? 1) || 1;
						const strict = perms.length > 0 || apiVersion >= 2;
						if (strict && !perms.some((x) => x.split(":")[0] === "ui")) {
							this.uiBase.delete(name);
							if (m.ui !== undefined)
								uiDiags.push('ui ignored: strict mode requires "ui" capability (manifest.permissions)');
							return undefined;
						}
						const base = m.ui === undefined ? undefined : parseUiContributions(m.ui, uiDiags);
						if (base) this.uiBase.set(name, base);
						else this.uiBase.delete(name);
						return this.uiOf(name);
					})(),
					source: await readFile(join(dir, ".pi-source.json"), "utf8")
						.then((raw) => {
							try {
								const s = JSON.parse(raw) as { source?: unknown };
								return typeof s.source === "string" && s.source ? s.source : undefined;
							} catch {
								return undefined;
							}
						})
						.catch(() => undefined),
				});
				if (generation !== this.lifecycleGeneration) return [];
				this.manifestDiags.set(name, uiDiags);
				const agentTools = this.agentToolsSnapshot(name);
				if (agentTools.length) out[out.length - 1]!.agentTools = agentTools;
				const scanned = [...uiDiags, ...(this.runtimeDiags.get(name) ?? [])].slice(0, 100);
				if (scanned.length) out[out.length - 1]!.diagnostics = scanned;
				const lp = this.loaded.get(name);
				if (lp) {
					if (scanned.length) lp.info.diagnostics = [...scanned];
					else delete lp.info.diagnostics;
				}
			} catch {
				if (generation !== this.lifecycleGeneration) return [];
				const msg = pick(
					l,
					`manifest.json 缺失或解析失败（${name}/），不是有效插件 —— 修复或移走该目录后点“重新扫描”`,
					`manifest.json missing or unparsable (${name}/), not a valid plugin — fix or remove the directory, then hit Rescan`,
					"plugins.manifest.broken",
					{ name },
				);
				console.error(`[plugin:${name}] ${msg}`);
				const brokenDiags = this.diagnosticsOf(name);
				out.push({
					id: name,
					name,
					hasClient: existsSync(join(dir, "client", "entry.mjs")),
					error: msg,
					view: false,
					...(brokenDiags ? { diagnostics: brokenDiags } : {}),
				});
			}
		}
		for (const key of this.domWants.keys()) {
			if (!out.some((p) => p.id === key)) this.domWants.delete(key);
		}
		for (const key of [...this.manifestDiags.keys(), ...this.runtimeDiags.keys(), ...this.pluginLogs.keys()]) {
			if (!out.some((p) => p.id === key)) {
				this.manifestDiags.delete(key);
				this.runtimeDiags.delete(key);
				this.pluginLogs.delete(key);
			}
		}
		return out;
	}

	private setFrozenRefusal(info: UiPluginInfo, msg: string, diagEn: string): void {
		console.error(`[plugin:${info.id}] ${msg}`);
		this.pushRuntimeDiag(info.id, diagEn);
		this.loaded.set(info.id, {
			info: { ...info, error: msg, diagnostics: this.diagnosticsOf(info.id) },
			toolHandlers: new Set(),
			runHandlers: new Set(),
			convChangeHandlers: new Set(),
			attachHandlers: new Set(),
			cwdHandlers: new Set(),
			httpRoutes: new Map(),
			settingsHandlers: new Set(),
		});
	}

	private cascadeRequiresRefusals(found: UiPluginInfo[], lang?: () => ServerLang): string[] {
		const l = lang?.() ?? "en";
		const byId = new Map(found.map((f) => [f.id, f]));
		const hit: string[] = [];
		for (;;) {
			let changed = false;
			for (const [id, p] of this.loaded) {
				if (p.info.error) continue;
				const req = byId.get(id)?.requires ?? p.info.requires;
				if (!req?.plugins?.length) continue;
				for (const dep of req.plugins) {
					let why = "";
					let whyEn = "";
					if (dep === id) {
						why = `插件 requires 依赖了自己（${dep}）—— 请删掉这条自依赖`;
						whyEn = `Plugin requires itself (${dep}) — remove the self-dependency`;
					} else if (!byId.has(dep)) {
						why = `插件 requires 对等插件「${dep}」但它已不在（被删/被拒）—— 装回来或去掉这条依赖`;
						whyEn = `Plugin requires peer "${dep}" which is gone (removed or refused) — reinstall it or drop the dependency`;
					} else if (existsSync(join(this.pluginsDir, dep, "index.mjs"))) {
						const peer = this.loaded.get(dep);
						if (!peer || peer.info.error) {
							why = `插件 requires 对等插件「${dep}」但它已失败/停止：${peer?.info.error ?? "未激活"}—— 修好它或去掉这条依赖`;
							whyEn = `Plugin requires peer "${dep}" which failed/stopped: ${peer?.info.error ?? "inactive"} — fix it or drop the dependency`;
						}
					}
					if (!why) continue;
					const msg = pick(l, why, whyEn, "plugins.requires.cascade", { dep });
					this.deactivateEntry(id, p);
					this.setFrozenRefusal(byId.get(id) ?? p.info, msg, whyEn);
					hit.push(id);
					changed = true;
					break;
				}
			}
			if (!changed) break;
		}
		return hit;
	}

	private async activate(info: UiPluginInfo, lang?: () => ServerLang): Promise<void> {
		const l = lang?.() ?? "en";
		this.attempted.add(info.id);
		const dir = join(this.pluginsDir, info.id);
		try {
			const rawManifest = readFileSync(join(dir, "manifest.json"), "utf8");
			const parsedManifest: unknown = JSON.parse(rawManifest);
			const mvActivate = validatePluginManifest(parsedManifest, info.id);
			if (mvActivate.errors.length > 0) {
				const first = mvActivate.errors[0]!;
				const msg = pick(
					l,
					`manifest 校验失败：${first.message} —— 修复后点“重新扫描”`,
					`manifest validation failed: ${first.messageEn} — fix it, then hit Rescan`,
					"plugins.manifest.invalid",
					{ name: info.id, path: first.path, message: first.messageEn },
				);
				console.error(`[plugin:${info.id}] ${msg}`);
				for (const e of mvActivate.errors) this.pushRuntimeDiag(info.id, formatManifestIssue(e));
				for (const w of mvActivate.warnings) this.pushRuntimeDiag(info.id, formatManifestIssue(w));
				this.loaded.set(info.id, {
					info: { ...info, error: msg, diagnostics: this.diagnosticsOf(info.id) },
					toolHandlers: new Set(),
					runHandlers: new Set(),
					convChangeHandlers: new Set(),
					attachHandlers: new Set(),
					cwdHandlers: new Set(),
					httpRoutes: new Map(),
					settingsHandlers: new Set(),
				});
				return;
			}
		} catch {}
		const handlers = new Set<(payload: unknown) => void>();
		this.messageHandlers.set(info.id, handlers);
		const toolHandlers = new Set<(ev: PluginToolEvent) => void>();
		const preGuards = new Set<ToolPreHandler>();
		const postGuards = new Set<ToolPostHandler>();
		const runHandlers = new Set<(ev: PluginRunEvent) => void>();
		const convChangeHandlers = new Set<() => void>();
		const modelChangeHandlers = new Set<(snap: PluginConversationSnapshot) => void>();
		const attachHandlers = new Set<(clientId: string) => void>();
		const cwdHandlers = new Set<(cwd: string) => void>();
		const httpRoutes = new Map<string, (req: Request, res: Response) => void>();
		const bgTaskTable = new Map<string, PluginBgTask>();
		let leftPanelOwned = false;
		const settingsHandlers = new Set<(values: Record<string, unknown>) => void>();
		const generation = this.lifecycleGeneration;
		const effects = new PluginEffectStack(info.id, (m) => {
			if (generation === this.lifecycleGeneration) this.pushRuntimeDiag(info.id, m);
		});
		const isCurrent = () => generation === this.lifecycleGeneration && !effects.isReleased;
		let apiVersion = 1;
		try {
			apiVersion = Number(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).apiVersion ?? 1) || 1;
		} catch {}
		if (apiVersion > PLUGIN_API_VERSION) {
			const msg = pick(
				l,
				`插件要求宿主 API v${apiVersion}，当前宿主 v${PLUGIN_API_VERSION} —— 请升级 pi-web-ui`,
				`Plugin requires host API v${apiVersion} but the host is v${PLUGIN_API_VERSION} — please upgrade pi-web-ui`,
				"plugins.host.api.mismatch",
				{ apiVersion, PLUGIN_API_VERSION },
			);
			console.error(`[plugin:${info.id}] ${msg}`);
			this.pushRuntimeDiag(
				info.id,
				`requires host API v${apiVersion} but host is v${PLUGIN_API_VERSION} — please upgrade pi-web-ui`,
			);
			this.loaded.set(info.id, {
				info: { ...info, error: msg, diagnostics: this.diagnosticsOf(info.id) },
				toolHandlers,
				runHandlers,
				convChangeHandlers,
				attachHandlers,
				cwdHandlers,
				httpRoutes,
				settingsHandlers: new Set(),
			});
			return;
		}
		const permsDeclared = (info.permissions ?? []).slice();
		const strict = permsDeclared.length > 0 || apiVersion >= 2;
		const permFamilies = new Set(permsDeclared.map((x) => x.split(":")[0]!));
		const req = info.requires;
		if (req) {
			const refuseRequires = (zh: string, en: string, key: string, vars?: Record<string, unknown>): boolean => {
				const msg = pick(l, zh, en, key, vars);
				console.error(`[plugin:${info.id}] ${msg}`);
				this.pushRuntimeDiag(info.id, en);
				this.loaded.set(info.id, {
					info: { ...info, error: msg, diagnostics: this.diagnosticsOf(info.id) },
					toolHandlers,
					runHandlers,
					convChangeHandlers,
					attachHandlers,
					cwdHandlers,
					httpRoutes,
					settingsHandlers: new Set(),
				});
				return true;
			};
			if (req.hostApi !== undefined && req.hostApi > PLUGIN_API_VERSION) {
				refuseRequires(
					`插件要求宿主 API v${req.hostApi}+，当前宿主 v${PLUGIN_API_VERSION} —— 请升级 pi-web-ui`,
					`Plugin requires host API v${req.hostApi}+ but the host is v${PLUGIN_API_VERSION} — please upgrade pi-web-ui`,
					"plugins.requires.hostapi",
					{ hostApi: req.hostApi, PLUGIN_API_VERSION },
				);
				return;
			}
			let refused = false;
			for (const f of req.families ?? []) {
				if (!isKnownPermission(f)) {
					refuseRequires(
						`插件 requires 声明了未知能力族「${f}」（拼写？或需要更新 pi-web-ui）—— 请修正 manifest.requires.families`,
						`Plugin requires unknown family "${f}" (typo? or needs newer pi-web-ui) — fix manifest.requires.families`,
						"plugins.requires.family.unknown",
						{ family: f },
					);
					refused = true;
					break;
				}
				const fam = f.split(":")[0]!;
				if (!permFamilies.has(fam)) {
					refuseRequires(
						`插件 requires 需要「${fam}」族，但 permissions 里没声明 —— 加上它，否则运行时必被门控拒绝`,
						`Plugin requires family "${fam}" but does not declare it in permissions — add it, otherwise every call will be denied`,
						"plugins.requires.family.undeclared",
						{ family: fam },
					);
					refused = true;
					break;
				}
			}
			if (refused) return;
			for (const dep of req.plugins ?? []) {
				if (dep === info.id) {
					refuseRequires(
						`插件 requires 依赖了自己（${dep}）—— 请删掉这条自依赖`,
						`Plugin requires itself (${dep}) — remove the self-dependency`,
						"plugins.requires.self",
						{ dep },
					);
					refused = true;
					break;
				}
				if (!existsSync(join(this.pluginsDir, dep, "manifest.json"))) {
					refuseRequires(
						`插件 requires 对等插件「${dep}」但它没安装（plugins/${dep}/ 缺失）—— 先装上它`,
						`Plugin requires peer "${dep}" which is not installed (plugins/${dep}/ missing) — install it first`,
						"plugins.requires.peer.missing",
						{ dep },
					);
					refused = true;
					break;
				}
				if (existsSync(join(this.pluginsDir, dep, "index.mjs"))) {
					const peer = this.loaded.get(dep);
					if (!peer) {
						refuseRequires(
							`插件 requires 对等插件「${dep}」但它尚未激活 —— 请先解决它的问题`,
							`Plugin requires peer "${dep}" which is not active yet — fix it first`,
							"plugins.requires.peer.inactive",
							{ dep },
						);
						refused = true;
						break;
					}
					if (peer.info.error) {
						refuseRequires(
							`插件 requires 对等插件「${dep}」但它激活失败：${peer.info.error}`,
							`Plugin requires peer "${dep}" which failed to activate: ${peer.info.error}`,
							"plugins.requires.peer.failed",
							{ dep },
						);
						refused = true;
						break;
					}
				}
			}
			if (refused) return;
		}
		const enginesReq = info.engines?.["pi-web-ui"];
		if (typeof enginesReq === "string" && enginesReq.trim()) {
			const hostVer = readHostVersion();
			const verdict = hostVer ? satisfiesEnginesConstraint(enginesReq, hostVer) : null;
			if (verdict === false) {
				const msg = pick(
					l,
					`插件要求 pi-web-ui ${enginesReq}，当前宿主版本 ${hostVer} —— 请升级 pi-web-ui`,
					`Plugin requires pi-web-ui ${enginesReq} but the host is ${hostVer} — please upgrade pi-web-ui`,
					"plugins.host.engines.mismatch",
					{ enginesReq, hostVer },
				);
				console.error(`[plugin:${info.id}] ${msg}`);
				this.pushRuntimeDiag(
					info.id,
					`requires pi-web-ui ${enginesReq} but host is ${hostVer} — please upgrade pi-web-ui`,
				);
				this.loaded.set(info.id, {
					info: { ...info, error: msg, diagnostics: this.diagnosticsOf(info.id) },
					toolHandlers,
					runHandlers,
					convChangeHandlers,
					attachHandlers,
					cwdHandlers,
					httpRoutes,
					settingsHandlers: new Set(),
				});
				return;
			}
			if (verdict === null) {
				console.warn(`[plugin:${info.id}] engines 约束「${enginesReq}」解析失败，已放行（不阻断激活）`);
				this.pushRuntimeDiag(info.id, `engines constraint "${enginesReq}" unparseable, allowed without blocking`);
			}
		}
		for (const peer of info.peerPlugins ?? []) {
			if (!existsSync(join(this.pluginsDir, peer))) {
				console.warn(`[plugin:${info.id}] 对等插件缺失：${peer}（仅警告，不阻断激活）`);
				this.pushRuntimeDiag(info.id, `peer plugin missing: ${peer} (warn only, activation continues)`);
			}
		}
		const netAllow = info.netAllowlist ?? [];
		const storage = new PluginStorage(join(dir, "storage.json"));
		const secrets = new PluginSecrets(this.dataDir, dir);
		const workspaceFs = new WorkspaceFS(() => self.cwdValue);
		const allowAbs = (p: string): string => {
			const abs = normalizeGrantPath(p);
			if (!abs) throw new Error("路径必须是绝对路径");
			if (self.isInsideWorkspace(abs) || self.grants.has(info.id, abs)) return abs;
			throw new Error(`目录未授权：先 await host.fs.requestAccess(dir)（${abs}）`);
		};
		const assertRealInsideGrant = async (abs: string): Promise<void> => {
			const targetReal = realPathOfNearest(abs);
			if (!targetReal) throw new Error(`无法解析真实路径：${abs}`);
			const granted = self.grants.list().find((g) => g.pluginId === info.id)?.paths ?? [];
			for (const r of [self.cwdValue, ...self.workspaceRoots, ...granted]) {
				const rootReal = realPathOfNearest(resolve(r)) ?? resolve(r);
				if (isInsideRoot(rootReal, targetReal)) return;
			}
			throw new Error(`路径越界（符号链接指向授权范围之外）：${abs}`);
		};
		const crossDirFs = {
			list: async (absDir: string) => {
				const abs = allowAbs(absDir);
				const ents = await readdir(abs, { withFileTypes: true });
				return ents.slice(0, 2000).map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }) as const);
			},
			read: async (absPath: string) => readFile(allowAbs(absPath)),
			readText: async (absPath: string, maxBytes?: number) => {
				const buf = await readFile(allowAbs(absPath));
				const cap = Math.max(1024, Math.min(Number(maxBytes ?? 2 * 1024 * 1024), 8 * 1024 * 1024));
				return buf.subarray(0, cap).toString("utf8");
			},
			write: async (absPath: string, data: string | Uint8Array) => {
				const abs = allowAbs(absPath);
				await assertRealInsideGrant(abs);
				await mkdir(dirname(abs), { recursive: true });
				await writeFile(abs, data);
			},
			remove: async (absPath: string) => {
				const abs = allowAbs(absPath);
				await assertRealInsideGrant(abs);
				await rm(abs, { recursive: true, force: true });
			},
			stat: async (absPath: string) => {
				const abs = allowAbs(absPath);
				const st = await stat(abs);
				const base =
					abs
						.replace(/[/\\]+$/, "")
						.split("/")
						.pop() ?? abs;
				return {
					name: base,
					type: (st.isDirectory() ? "dir" : "file") as "file" | "dir",
					size: st.isDirectory() ? 0 : st.size,
					mtime: Number(st.mtimeMs) || 0,
				};
			},
			mkdir: async (absDir: string) => {
				await mkdir(allowAbs(absDir), { recursive: true });
			},
			append: async (absPath: string, data: string | Uint8Array) => {
				const abs = allowAbs(absPath);
				await mkdir(dirname(abs), { recursive: true });
				await writeFile(abs, data, { flag: "a" });
			},
			glob: async (absDir: string, pattern: string) => {
				const { globToRegExp } = await import("./plugin-facilities.js");
				const pat = String(pattern ?? "")
					.trim()
					.replace(/\\/g, "/");
				if (!pat) throw new Error("globPath: pattern 为空");
				const re = globToRegExp(pat);
				const base = allowAbs(absDir);
				const out: string[] = [];
				const stack: string[] = [base];
				let walked = 0;
				while (stack.length && walked < 2000 && out.length < 500) {
					const dir = stack.pop()!;
					let ents;
					try {
						ents = await readdir(dir, { withFileTypes: true });
					} catch {
						continue;
					}
					for (const e of ents) {
						if (walked++ >= 2000 || out.length >= 500) break;
						const abs = join(dir, e.name);
						const rel = abs
							.slice(base.length)
							.replace(/\\/g, "/")
							.split("/")
							.filter((s) => s.length > 0)
							.join("/");
						if (e.isDirectory()) {
							if (re.test(rel) || re.test(`${rel}/`)) out.push(abs);
							stack.push(abs);
						} else if (re.test(rel)) {
							out.push(abs);
						}
					}
				}
				return out;
			},
		};
		const self = this;
		self.activatingGates.set(info.id, { permsDeclared, permFamilies, strictMode: strict, legacyWarned: false });
		const can = (family: string): boolean => self.canUse(info.id, family);
		const canRead = (): boolean => self.canUse(info.id, "fs:read");
		const canWrite = (): boolean => self.canUse(info.id, "fs:write");
		const sendChat = (req: PluginChatRequest): Promise<PluginChatResult> => {
			if (!can("chat")) return Promise.reject(new Error(`插件未声明能力 "chat"（manifest.permissions）——请求被拒`));
			if (!self.chatProvider) {
				return Promise.reject(new Error("宿主未提供无头调用（chatProvider 未接入）——请升级 pi-web-ui"));
			}
			const text = String((req as PluginChatRequest | undefined)?.text ?? "").trim();
			if (!text) return Promise.reject(new Error("chat: text 为空"));
			if (text.length > 8000) return Promise.reject(new Error("chat: text 超长（>8000 字），请裁剪后重发"));
			const accountId = String((req as PluginChatRequest | undefined)?.accountId ?? "default").slice(0, 64);
			const r = ((req as PluginChatRequest | undefined) ?? {}) as PluginChatRequest;
			const passthrough: PluginChatRequest = { text, accountId };
			try {
				const attachments = normalizePluginChatAttachments(r.attachments);
				if (attachments?.length) passthrough.attachments = attachments;
			} catch (err) {
				return Promise.reject(err);
			}
			const cwd = String(r.cwd ?? "").trim();
			if (cwd) passthrough.cwd = cwd.slice(0, 1024);
			const conversationId = String(r.conversationId ?? "").trim();
			if (conversationId) passthrough.conversationId = conversationId.slice(0, 128);
			const model = String(r.model ?? "").trim();
			if (model) passthrough.model = model.slice(0, 256);
			const thinkingLevel = String(r.thinkingLevel ?? "").trim();
			if (thinkingLevel) passthrough.thinkingLevel = thinkingLevel.slice(0, 64);
			return self.chatProvider(info.id, passthrough);
		};
		const workItemsCall = async <T>(
			method: keyof import("../plugin-sdk/index.js").PluginWorkItems,
			args: Record<string, unknown>,
		): Promise<T> => {
			if (!can("chat")) throw new Error('Work items require the "chat" capability');
			if (!self.workItemsProvider) throw new Error("Work item service unavailable");
			return (await self.workItemsProvider(info.id, method, args)) as T;
		};
		let pluginAbort: AbortController | null = null;
		const host: PluginHost = {
			broadcast: (payload) => this.broadcast(info.id, payload),
			notify: (level, text, textEn) => this.notifyAll(level, text, textEn),
			sendTo: (clientId, payload) => this.sendTo(clientId, info.id, payload),
			onMessage: (h) => {
				handlers.add(h);
				return () => handlers.delete(h);
			},
			onClientMessage: (h) => {
				return host.onMessage((payload, from) => {
					const reply = (res: unknown) => {
						if (from) {
							host.sendTo(from, res);
						} else {
							host.broadcast(res);
						}
					};
					try {
						const ret = h(payload, reply);
						if (ret instanceof Promise) {
							ret.catch((err) => {
								console.error(`[plugin:${info.id}] onClientMessage async handler failed:`, err);
							});
						}
					} catch (err) {
						console.error(`[plugin:${info.id}] onClientMessage handler failed:`, err);
					}
				});
			},
			onToolEvent: (h) => {
				toolHandlers.add(h);
				return () => toolHandlers.delete(h);
			},
			onToolPre: (h) => {
				if (!can("tools")) return () => {};
				preGuards.add(h);
				return () => preGuards.delete(h);
			},
			onToolPost: (h) => {
				if (!can("tools")) return () => {};
				postGuards.add(h);
				return () => postGuards.delete(h);
			},
			onRunEvent: (h) => {
				runHandlers.add(h);
				return () => runHandlers.delete(h);
			},
			onConversationChanged: (h) => {
				convChangeHandlers.add(h);
				return () => convChangeHandlers.delete(h);
			},
			onClientModelChanged: (h) => {
				modelChangeHandlers.add(h);
				return () => modelChangeHandlers.delete(h);
			},
			getActiveConversation: (opts) => self.getActiveConversation(opts),
			chat: (req) => sendChat(req),
			workItems: {
				rooms: () => workItemsCall("rooms", {}),
				ingest: (input) => workItemsCall("ingest", { ...input }),
				list: (opts) => workItemsCall("list", { ...opts }),
				get: (id) => workItemsCall("get", { id }),
				update: (id, patch) => workItemsCall("update", { id, patch }),
				claimDelivery: (opts) => workItemsCall("claimDelivery", { ...opts }),
				completeDelivery: (id, result) => workItemsCall("completeDelivery", { id, ...result }),
				failDelivery: (id, result) => workItemsCall("failDelivery", { id, ...result }),
			},
			chatWait: async (req, opts) => {
				try {
					const sent = await sendChat(req);
					const cid = sent?.conversationId ?? "";
					if (!cid) return { ok: false, error: "无头调用未返回 conversationId" };
					const timeoutMs = Math.max(1000, Math.min(Number(opts?.timeoutMs ?? 120_000) || 120_000, 600_000));
					const ended = await self.waitRunEnd(cid, timeoutMs, sent?.runId);
					if (!ended)
						return { ok: false, conversationId: cid, error: `等待运行结束超时（约${Math.round(timeoutMs / 1000)}s）` };
					return { ok: true, conversationId: cid };
				} catch (err) {
					return { ok: false, error: (err as Error).message };
				}
			},
			llm: {
				supportsImages: true,
				complete: async (req) => {
					if (!can("llm")) return { ok: false, error: `插件未声明能力 "llm"（manifest.permissions）——请求被拒` };
					const model = typeof req?.model === "string" ? req.model.trim() : "";
					if (model && !self.permGrants.modelAllowed(info.id, model))
						return {
							ok: false,
							error: `llm: 模型 ${model} 不在用户批准的作用域内（可 host.requestPermission 重新申请）`,
						};
					if (!self.llmProvider) return { ok: false, error: "宿主未提供 LLM 直调（llmProvider 未接入）" };
					try {
						return await self.llmProvider(info.id, req ?? { prompt: "" });
					} catch (err) {
						return { ok: false, error: (err as Error).message };
					}
				},
			},
			requestPermission: async (req) => {
				const family = (req as { family?: unknown } | undefined)?.family;
				if (family !== "net" && family !== "llm")
					throw new Error(`requestPermission: 不支持的能力族「${String(family)}」（目前只收 net/llm）`);
				if (!can(family)) return false;
				const hosts =
					family === "net" && Array.isArray((req as { hosts?: unknown }).hosts)
						? (req as { hosts: unknown[] }).hosts
								.filter((x): x is string => typeof x === "string" && x.trim() !== "")
								.map((x) => x.trim().toLowerCase())
								.slice(0, 32)
						: undefined;
				if (family === "net" && (!hosts || hosts.length === 0))
					throw new Error("requestPermission: family=net 必须给 hosts（要批准的主机列表）");
				const models =
					family === "llm" && Array.isArray((req as { models?: unknown }).models)
						? (req as { models: unknown[] }).models
								.filter((x): x is string => typeof x === "string" && x.includes("/"))
								.map((x) => x.trim())
								.slice(0, 32)
						: undefined;
				const reason =
					typeof (req as { reason?: unknown }).reason === "string"
						? String((req as { reason?: string }).reason).slice(0, 200)
						: undefined;
				if (family === "net" && hosts!.every((h) => netAllow.some((entry) => h === entry || h.endsWith(`.${entry}`))))
					return true;
				if (family === "net" && hosts!.every((h) => self.permGrants.has(info.id, "net", { host: h }))) return true;
				if (family === "llm" && self.permGrants.has(info.id, "llm", models?.[0] ? { model: models[0] } : undefined))
					return true;
				if (!self.permissionRequester) return false;
				let ans: { ok: boolean; remember: boolean };
				try {
					ans = await self.permissionRequester(info.id, {
						family,
						...(hosts ? { hosts } : {}),
						...(models ? { models } : {}),
						...(reason ? { reason } : {}),
					});
				} catch {
					return false;
				}
				if (!ans?.ok) return false;
				try {
					self.permGrants.grant(info.id, family, { hosts, models, reason, remember: ans.remember === true });
				} catch (err) {
					console.error(`[plugin:${info.id}] permission grant failed:`, err);
					return false;
				}
				try {
					self.onPermGrantsChanged?.();
				} catch {}
				return true;
			},
			conversations: {
				list: () => {
					try {
						const r = self.conversationLister?.();
						if (r instanceof Promise) {
							return r.catch((err) => {
								console.error(`[plugin:${info.id}] conversationLister failed:`, err);
								return [];
							});
						}
						return r ?? [];
					} catch (err) {
						console.error(`[plugin:${info.id}] conversationLister failed:`, err);
						return [];
					}
				},
				get: (id) => {
					try {
						const s = self.getActiveConversation();
						return s && s.conversationId === String(id) ? s : null;
					} catch {
						return null;
					}
				},
				search: (query, limit) => {
					try {
						const q = String(query ?? "");
						const n = Math.max(1, Math.min(Number(limit ?? 20) || 20, 100));
						if (self.conversationSearcher) {
							const r = self.conversationSearcher(q, n);
							if (r instanceof Promise) return r.catch(() => []);
							return r ?? [];
						}
						const lq = q.trim().toLowerCase();
						if (!lq) return [];
						const pick = (arr: Array<PluginConversationListItem>): Array<{ id: string; title: string }> =>
							arr
								.filter((c) => c.title.toLowerCase().includes(lq))
								.slice(0, n)
								.map((c) => ({ id: c.id, title: c.title }));
						const all = self.conversationLister?.();
						if (all instanceof Promise) return all.then(pick, () => []);
						return pick(all ?? []);
					} catch {
						return [];
					}
				},
			},
			prompt: async (conversationId, req) => {
				try {
					if (!self.conversationWriter) return { ok: false, error: "宿主未接入对话写入（仅标准 pi 引擎支持）" };
					const text = String(req?.text ?? "");
					if (!text.trim()) return { ok: false, error: "投递文本为空" };
					if (text.length > 8000) return { ok: false, error: "投递文本超长（>8000 字），请裁剪后重发" };
					const atts = Array.isArray(req?.attachments) ? req.attachments.slice(0, 16) : undefined;
					return await self.conversationWriter(String(conversationId), text, atts);
				} catch (err) {
					return { ok: false, error: (err as Error).message };
				}
			},
			steer: async (conversationId, text) => {
				try {
					if (!self.runSteerer) return { ok: false, error: "宿主未接入运行插队（仅标准 pi 引擎支持）" };
					return await self.runSteerer(String(conversationId), String(text ?? ""));
				} catch (err) {
					return { ok: false, error: (err as Error).message };
				}
			},
			abortRun: async (conversationId) => {
				try {
					if (!self.runAborter) return { ok: false, error: "宿主未接入运行中止（仅标准 pi 引擎支持）" };
					return await self.runAborter(String(conversationId));
				} catch (err) {
					return { ok: false, error: (err as Error).message };
				}
			},
			onAttach: (h) => {
				attachHandlers.add(h);
				return () => attachHandlers.delete(h);
			},
			onCwdChange: (h) => {
				cwdHandlers.add(h);
				return () => cwdHandlers.delete(h);
			},
			registerCommand: (cmd) => {
				const off = this.registerCommand(info.id, cmd);
				return effects.add(`command:/${String(cmd?.name ?? "?").replace(/^\/+/, "")}`, off);
			},
			execCommand: async (name, args, context) => {
				const hit = this.findCommand(name);
				if (!hit) return { ok: false, error: `未找到命令 /${name}` };
				try {
					const res = await hit.def.run(args, context ?? { clientId: `plugin:${info.id}` });
					return { ok: true, result: typeof res === "string" ? res : "" };
				} catch (err) {
					return { ok: false, error: (err as Error).message };
				}
			},
			getPluginCommands: () => this.listCommands(),
			storage,
			services: {
				provide: (name, service) => {
					const revoke = self.provideService(info.id, name, service);
					return effects.add(`service:${name}`, revoke);
				},
				get: (name) => self.getService(name),
				has: (name) => self.hasService(name),
				list: () => self.listServices(),
				on: (name, handler) => {
					const off = self.onService(name, handler);
					return effects.add(`service_listener:${name}`, off);
				},
			},
			tts: {
				registerEngine: (engine) => effects.add(`tts:${engine.id}`, ttsService.registerEngine(info.id, engine)),
				listEngines: () => ttsService.listEngines(),
				listVoices: (engine, options) => ttsService.listVoices(engine, options),
				synthesize: (request) => ttsService.synthesize(request),
			},
			provide: (name, service) => host.services.provide(name, service),
			get: (name) => host.services.get(name),
			onService: (name, handler) => host.services.on(name, handler),
			secrets,
			ensureDeps: (specs, opts) => ensurePluginDeps(dir, specs ?? [], opts?.onProgress),
			route: (method, path, handler) => {
				if (!can("http")) return () => {};
				const m = String(method ?? "GET").toUpperCase();
				if (
					!["GET", "POST", "PUT", "DELETE", "OPTIONS"].includes(m) ||
					typeof path !== "string" ||
					!path.startsWith("/") ||
					typeof handler !== "function"
				) {
					console.error(`[plugin:${info.id}] route: 非法参数（method=${method} path=${path}），忽略`);
					self.pushRuntimeDiag(
						info.id,
						`route: invalid method/path (method=${String(method)} path=${String(path)}), ignored`,
					);
					return () => {};
				}
				const key = `${m} ${path}`;
				httpRoutes.set(key, handler);
				return effects.add(`route:${key}`, () => httpRoutes.delete(key));
			},
			registerProxy: (prefix, target) => {
				if (!can("http")) return () => {};
				const p = self.registerProxy(info.id, String(prefix ?? ""), target);
				if (!p) {
					console.error(`[plugin:${info.id}] registerProxy: 非法前缀/目标或被占用（prefix=${String(prefix)}），忽略`);
					self.pushRuntimeDiag(
						info.id,
						`registerProxy: invalid prefix/target or taken (prefix=${String(prefix)}), ignored`,
					);
					return () => {};
				}
				return effects.add(`proxy:${p}`, () => {
					self.unregisterProxy(info.id, p);
				});
			},
			registerAgentTool: (tool) => {
				if (!can("tools")) return () => {};
				const off = this.registerAgentTool(info.id, tool);
				return effects.add(`agentTool:${String(tool?.name ?? "?")}`, off);
			},
			registerMarker: (marker) => {
				if (!can("tools")) return () => {};
				const off = this.registerMarker(info.id, marker as PluginMarkerDef<any>);
				return effects.add(`marker:${String(marker?.name ?? "?")}`, off);
			},
			registerTool: (tool) => {
				if (!can("tools")) return () => {};
				if (!tool || typeof tool !== "object") return () => {};
				const exec = tool.execute;
				const adaptedTool: PluginAgentTool = {
					name: tool.name,
					description: tool.description,
					label: tool.label,
					promptSnippet: tool.promptSnippet,
					promptGuidelines: tool.promptGuidelines,
					parameters: tool.parameters,
					execute: async (
						toolCallId: string,
						params: Record<string, unknown>,
						signal?: AbortSignal,
						onUpdate?: (partial: unknown) => void,
					) => {
						if (typeof exec !== "function") return "";
						if (exec.length <= 1) {
							return await (exec as (args: Record<string, unknown>) => Promise<unknown>)(params);
						}
						const multiFn = exec as unknown as (
							toolCallId: string,
							params: Record<string, unknown>,
							signal?: AbortSignal,
							onUpdate?: (partial: unknown) => void,
						) => Promise<unknown>;
						return await multiFn(toolCallId, params, signal, onUpdate);
					},
				};
				return host.registerAgentTool(adaptedTool);
			},
			dir,
			dataDir: this.dataDir,
			get cwd() {
				return self.cwdValue;
			},
			fs: {
				list: (relDir) => (canRead() ? workspaceFs.list(relDir) : NO_FS_PROMISE),
				read: (p) => (canRead() ? workspaceFs.read(p) : NO_FS_PROMISE),
				readText: (p, max) => (canRead() ? workspaceFs.readText(p, max) : NO_FS_PROMISE),
				write: (p, data) => (canWrite() ? workspaceFs.write(p, data) : NO_FS_WRITE_PROMISE),
				remove: (p) => (canWrite() ? workspaceFs.remove(p) : NO_FS_WRITE_PROMISE),
				stat: (p) => (canRead() ? workspaceFs.stat(p) : NO_FS_PROMISE),
				mkdir: (p) => (canWrite() ? workspaceFs.mkdir(p) : NO_FS_WRITE_PROMISE),
				append: (p, data) => (canWrite() ? workspaceFs.append(p, data) : NO_FS_WRITE_PROMISE),
				glob: (pat, dir) => (canRead() ? workspaceFs.glob(pat, dir) : NO_FS_PROMISE),
				requestAccess: async (dir, reason) => {
					if (!canRead()) return false;
					const abs = normalizeGrantPath(String(dir ?? ""));
					if (!abs) return false;
					if (self.isInsideWorkspace(abs)) return true;
					if (self.grants.has(info.id, abs)) return true;
					if (!self.pathAccessRequester) return false;
					const ok = await self.pathAccessRequester(info.id, abs, reason);
					if (ok) {
						self.grants.grant(info.id, abs);
						try {
							self.onGrantsChanged?.();
						} catch {}
					}
					return ok;
				},
				authorizedDirs: () => (canRead() ? self.grants.get(info.id) : []),
				listPath: (absDir) => (canRead() ? crossDirFs.list(absDir) : NO_FS_PROMISE),
				readPath: (absPath) => (canRead() ? crossDirFs.read(absPath) : NO_FS_PROMISE),
				readTextPath: (absPath, max) => (canRead() ? crossDirFs.readText(absPath, max) : NO_FS_PROMISE),
				writePath: (absPath, data) => (canWrite() ? crossDirFs.write(absPath, data) : NO_FS_WRITE_PROMISE),
				removePath: (absPath) => (canWrite() ? crossDirFs.remove(absPath) : NO_FS_WRITE_PROMISE),
				statPath: (absPath) => (canRead() ? crossDirFs.stat(absPath) : NO_FS_PROMISE),
				mkdirPath: (absDir) => (canWrite() ? crossDirFs.mkdir(absDir) : NO_FS_WRITE_PROMISE),
				appendPath: (absPath, data) => (canWrite() ? crossDirFs.append(absPath, data) : NO_FS_WRITE_PROMISE),
				globPath: (absDir, pat) => (canRead() ? crossDirFs.glob(absDir, pat) : NO_FS_PROMISE),
				watch: (relPath, handler) => {
					if (!canRead()) throw new Error('插件未声明读能力 "fs"/"fs:read"（manifest.permissions）——请求被拒');
					if (typeof handler !== "function") throw new Error("watch: handler 必须是函数");
					const target = resolve(self.cwdValue, String(relPath ?? ""));
					if (!self.isInsideWorkspace(target)) throw new Error(`路径越界：${String(relPath)}`);
					const watcher = fsWatch(target, (eventType, filename) => {
						try {
							handler({ type: String(eventType), path: String(filename ?? relPath) });
						} catch (err) {
							console.error(`[plugin:${info.id}] watch handler failed:`, err);
						}
					});
					watcher.on("error", (err) => console.error(`[plugin:${info.id}] watch failed:`, err));
					const off = (): void => {
						try {
							watcher.close();
						} catch {}
					};
					return effects.add(`watch:${String(relPath)}`, off);
				},
			},
			project: {
				create: async (spec) => {
					if (!canWrite())
						return {
							ok: false,
							error: '缺少写能力：project.create 需要 "fs"/"fs:write"（manifest.permissions）',
							log: [],
							dir: "",
						};
					const dir = normalizeGrantPath(String((spec as { dir?: unknown })?.dir ?? ""));
					if (!dir) return { ok: false, error: "项目目录必须是绝对路径", log: [], dir: "" };
					if (!self.isInsideWorkspace(dir) && !self.grants.has(info.id, dir)) {
						return { ok: false, dir, log: [], error: `项目目录未授权：先 await host.fs.requestAccess("${dir}")` };
					}
					return createProject(spec, { onProgress: (line) => self.notifyAll("info", line) });
				},
			},
			leftPanel: {
				setRunning: (items, opts) => {
					if (!can("ui")) return;
					if (!leftPanelOwned) {
						leftPanelOwned = true;
						effects.add("leftPanel", () => {
							leftPanelOwned = false;
							if (self.panelRunning.clear(info.id)) self.schedulePanelPush();
						});
					}
					const outcome = self.panelRunning.set(info.id, info.name || info.id, items, opts);
					for (const d of outcome.diags) self.pushRuntimeDiag(info.id, d);
					if (outcome.changed) self.schedulePanelPush();
					self.ensurePanelSweep();
				},
				clear: () => {
					if (!can("ui")) return;
					if (self.panelRunning.clear(info.id)) self.schedulePanelPush();
				},
			},
			registerBackgroundTask: (task) => {
				const id = String(task?.id ?? "").trim();
				if (!id || bgTaskTable.has(id)) {
					console.error(`[plugin:${info.id}] registerBackgroundTask: 非法/重复 id「${task?.id}」，忽略`);
					self.pushRuntimeDiag(
						info.id,
						`registerBackgroundTask: invalid/duplicate id "${String(task?.id ?? "").slice(0, 32)}", ignored`,
					);
					return { update: () => {}, unregister: () => {} };
				}
				const entry: PluginBgTask = {
					id,
					label: String(task?.label ?? id),
					since: Date.now(),
					...(typeof task?.stop === "function" ? { stop: task.stop } : {}),
					...(typeof task?.status === "string" ? { status: task.status } : {}),
				};
				bgTaskTable.set(id, entry);
				this.pluginBgTasks.set(info.id, bgTaskTable);
				const fire = () => {
					try {
						this.onBgTasksChanged?.();
					} catch {}
				};
				fire();

				let heartbeatTimer: NodeJS.Timeout | null = null;
				const stopHeartbeat = () => {
					if (heartbeatTimer) {
						clearInterval(heartbeatTimer);
						heartbeatTimer = null;
					}
				};

				const cleanup = () => {
					stopHeartbeat();
					if (bgTaskTable.delete(id)) {
						if (bgTaskTable.size === 0) self.pluginBgTasks.delete(info.id);
						fire();
					}
				};

				const removeEffect = effects.add(`bgTask:${id}`, cleanup);

				if (typeof task?.check === "function") {
					const checkFn = task.check;
					const interval = Math.max(50, Math.floor(task.intervalMs ?? 3000));
					const maxFailures = Math.max(1, Math.floor(task.maxFailures ?? 2));
					let consecutiveFailures = 0;
					let inFlight = false;

					heartbeatTimer = setInterval(async () => {
						if (inFlight || !bgTaskTable.has(id)) return;
						inFlight = true;
						try {
							const res = await checkFn();
							if (!isCurrent() || !bgTaskTable.has(id)) return;
							let alive = false;
							let nextStatus: string | undefined;
							if (typeof res === "boolean") {
								alive = res;
							} else if (res && typeof res === "object") {
								alive = !!res.alive;
								if (typeof res.status === "string") {
									nextStatus = res.status;
								}
							}
							if (alive) {
								consecutiveFailures = 0;
								if (nextStatus !== undefined && nextStatus !== entry.status) {
									entry.status = nextStatus;
									fire();
								}
							} else {
								consecutiveFailures++;
							}
						} catch {
							consecutiveFailures++;
						} finally {
							inFlight = false;
						}

						if (!isCurrent() || !bgTaskTable.has(id)) return;
						if (consecutiveFailures >= maxFailures) {
							removeEffect();
							try {
								task.onDead?.("heartbeat_failed");
							} catch (e) {
								console.error(`[plugin:${info.id}] bgTask onDead error:`, e);
							}
						}
					}, interval);

					heartbeatTimer.unref?.();
				}

				return {
					update: (next) => {
						if (!bgTaskTable.has(id)) return;
						if (next.label !== undefined) entry.label = String(next.label);
						if (next.status !== undefined) entry.status = next.status;
						if (typeof next.stop === "function") entry.stop = next.stop;
						fire();
					},
					unregister: () => {
						removeEffect();
					},
				};
			},
			ui: {
				register: (items) => {
					if (!can("ui")) return () => {};
					const list = Array.isArray(items) ? items : [items];
					if (list.length > 32)
						self.pushRuntimeDiag(info.id, `ui.register: capped at 32 items (${list.length - 32} dropped)`);
					const added: string[] = [];
					const rt = self.uiRuntimeFor(info.id);
					const sliced = list.slice(0, 32);
					for (let idx = 0; idx < sliced.length; idx++) {
						const raw = sliced[idx];
						const slotRaw =
							typeof (raw as { slot?: unknown })?.slot === "string" ? String((raw as { slot: string }).slot) : "";
						const slot = UI_SLOT_ALIASES[slotRaw] ?? slotRaw;
						if (!slot || !UI_SLOTS.has(slot)) {
							self.pushRuntimeDiag(
								info.id,
								`ui.register[#${idx}]: unknown slot "${slotRaw || "(missing)"}", item dropped`,
							);
							continue;
						}
						const itemDiags: string[] = [];
						const parsed = parseUiItem(raw, slot, itemDiags);
						for (const m of itemDiags) self.pushRuntimeDiag(info.id, `ui.register: ${m}`);
						if (!parsed) {
							if (!itemDiags.length)
								self.pushRuntimeDiag(info.id, `ui.register[#${idx}]: item in slot "${slot}" dropped`);
							continue;
						}
						rt.items.set(parsed.id, parsed);
						rt.removed.delete(parsed.id);
						added.push(parsed.id);
					}
					if (added.length) void self.pushToAll().catch(() => {});
					return effects.add(`ui:register(${added.join(",") || "none"})`, () => {
						if (!added.length) return;
						for (const id of added) self.removeUiItem(info.id, id);
						void self.pushToAll().catch(() => {});
					});
				},
				update: (id, patch) => {
					if (!can("ui")) return;
					const base = self.uiOf(info.id)?.items.find((x) => x.id === id);
					if (!base) {
						self.pushRuntimeDiag(info.id, `ui.update: unknown id "${String(id).slice(0, 32)}", ignored`);
						return;
					}
					const diags: string[] = [];
					const mergedRaw =
						typeof patch === "object" && patch !== null && !Array.isArray(patch)
							? { ...base, ...(patch as Record<string, unknown>), id, slot: base.slot }
							: { ...base, id, slot: base.slot };
					const parsed = parseUiItem(mergedRaw, base.slot, diags);
					for (const m of diags) self.pushRuntimeDiag(info.id, `ui.update: ${m}`);
					if (!parsed) {
						self.pushRuntimeDiag(info.id, `ui.update: merged item invalid, update ignored`);
						return;
					}
					self.uiRuntimeFor(info.id).items.set(id, parsed);
					void self.pushToAll().catch(() => {});
				},
				patch: (arg1: unknown, arg2?: unknown, arg3?: unknown) => {
					if (!can("ui")) return;
					const targetId = typeof arg3 === "object" && arg3 !== null ? String(arg2) : String(arg1);
					const patchObj = (typeof arg3 === "object" && arg3 !== null ? arg3 : arg2) as
						Record<string, unknown> | undefined;
					if (!patchObj || typeof patchObj !== "object" || Array.isArray(patchObj)) return;
					const base = self.uiOf(info.id)?.items.find((x) => x.id === targetId);
					if (!base) {
						self.pushRuntimeDiag(info.id, `ui.patch: unknown id "${String(targetId).slice(0, 32)}", ignored`);
						return;
					}
					const diags: string[] = [];
					const mergedRaw = { ...base, ...patchObj, id: targetId, slot: base.slot };
					const parsed = parseUiItem(mergedRaw, base.slot, diags);
					for (const m of diags) self.pushRuntimeDiag(info.id, `ui.patch: ${m}`);
					if (!parsed) {
						self.pushRuntimeDiag(info.id, `ui.patch: merged item invalid, patch ignored`);
						return;
					}
					self.uiRuntimeFor(info.id).items.set(targetId, parsed);
					void self.pushToAll().catch(() => {});
				},
				remove: (id) => {
					if (!can("ui")) return;
					self.removeUiItem(info.id, id);
					void self.pushToAll().catch(() => {});
				},
				arrange: (ops) => {
					if (!can("ui")) return;
					const arr = Array.isArray(ops) ? ops : [ops];
					const arrangeDiags: string[] = [];
					const list = parseUiArrange(arr, arrangeDiags);
					for (const m of arrangeDiags) self.pushRuntimeDiag(info.id, `ui.arrange: ${m}`);
					if (!list.length) return;
					self.uiRuntimeFor(info.id).arrange.push(...list);
					void self.pushToAll().catch(() => {});
				},
				list: () => self.uiOf(info.id) ?? { items: [], arrange: [] },
			},
			getSettings: () => {
				const schema = info.settingsSchema ?? [];
				const overlayFile = readSettingsOverlayFile(self.dataDir, info.id);
				const overlay = cleanOverlaySettings(schema, overlayFile.raw, "en");
				return runtimeSettingsValues(dir, schema, secrets, overlay.values);
			},
			onSettingsChanged: (h) => {
				settingsHandlers.add(h);
				return () => settingsHandlers.delete(h);
			},
			scm: {
				status: async () => {
					if (!canRead()) throw new Error('插件未声明读能力 "fs"/"fs:read"（manifest.permissions）——请求被拒');
					try {
						const mod = await import("./scm.js");
						return await mod.scmStatus(self.cwdValue);
					} catch (err) {
						return { ok: false, error: (err as Error).message };
					}
				},
				log: async (path, limit) => {
					if (!canRead()) throw new Error('插件未声明读能力 "fs"/"fs:read"（manifest.permissions）——请求被拒');
					try {
						const mod = await import("./scm.js");
						const all = await mod.scmHistory(self.cwdValue);
						const n = Math.max(1, Math.min(Number(limit ?? 50) || 50, 200));
						return all.slice(0, n);
					} catch (err) {
						return { ok: false, error: (err as Error).message };
					}
				},
			},
			bash: async (cmd, opts) => {
				if (!can("tools"))
					return { ok: false, output: "", error: '插件未声明能力 "tools"（manifest.permissions）——请求被拒' };
				try {
					const parts = String(cmd ?? "")
						.trim()
						.split(/\s+/)
						.filter(Boolean);
					const file = parts[0];
					if (!file) return { ok: false, output: "", error: "bash: cmd 为空" };
					const cwd = opts?.cwd ? resolve(self.cwdValue, opts.cwd) : self.cwdValue;
					if (!self.isInsideWorkspace(cwd)) return { ok: false, output: "", error: `工作目录越界：${opts?.cwd}` };
					const timeout = Math.max(1000, Math.min(Number(opts?.timeoutMs ?? 60_000) || 60_000, 600_000));
					const { stdout, stderr } = await execFileAsync(file, parts.slice(1), {
						cwd,
						timeout,
						windowsHide: true,
						maxBuffer: 4 * 1024 * 1024,
						encoding: "utf8",
					});
					const output = `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.slice(0, 256 * 1024);
					return { ok: true, output, exitCode: 0 };
				} catch (err) {
					const e = err as { message?: unknown; stdout?: unknown; stderr?: unknown; code?: unknown };
					const out = [typeof e.stdout === "string" ? e.stdout : "", typeof e.stderr === "string" ? e.stderr : ""]
						.filter(Boolean)
						.join("\n")
						.slice(0, 256 * 1024);
					return {
						ok: false,
						output: out,
						...(typeof e.code === "number" ? { exitCode: e.code } : {}),
						error: String(e.message ?? err).slice(0, 2000),
					};
				}
			},
			schedule: (cronOrMs, fn, opts) => {
				if (typeof fn !== "function") throw new Error("schedule: fn 必须是函数");
				const persistent = (opts as { persistent?: unknown } | undefined)?.persistent === true;
				const catchUp = (opts as { catchUp?: unknown } | undefined)?.catchUp === "once" ? "once" : "skip";
				const label =
					typeof (opts as { label?: unknown } | undefined)?.label === "string" &&
					String((opts as { label?: string }).label).trim()
						? String((opts as { label?: string }).label)
								.trim()
								.slice(0, 60)
						: undefined;
				let ms = 0;
				let parts: CronParts | undefined;
				let specText: string;
				if (typeof cronOrMs === "number") {
					ms = Math.floor(cronOrMs) || 0;
					if (!(ms > 0)) throw new Error("schedule: 间隔毫秒数必须大于 0");
					ms = Math.min(ms, 2_147_483_647);
					ms = Math.max(ms, persistent ? 60_000 : 10_000);
					specText = String(ms);
				} else if (typeof cronOrMs === "string") {
					specText = cronOrMs.trim().replace(/\s+/g, " ");
					const parsed = parseCronSpec(specText);
					if (!parsed)
						throw new Error(`schedule: 不支持的 cron 形状「${cronOrMs}」（要 5 字段：分 时 日 月 周，如 "0 9 * * *"）`);
					parts = parsed;
				} else {
					throw new Error("schedule: 参数必须是间隔毫秒数或 cron 字符串");
				}
				let sid = "";
				if (persistent) {
					sid =
						typeof (opts as { id?: unknown } | undefined)?.id === "string"
							? String((opts as { id?: string }).id).trim()
							: "";
					if (!sid || !ID_RE.test(sid))
						throw new Error("schedule: persistent 任务必须给合法 id（字母/数字/下划线/连字符），重启后靠它重建");
					const records = loadScheduleRecords(dir);
					const prev = records[sid];
					records[sid] = {
						spec: specText,
						catchUp,
						...(label ? { label } : {}),
						...(prev?.lastRun !== undefined ? { lastRun: prev.lastRun } : {}),
						createdAt: prev?.createdAt ?? Date.now(),
					};
					saveScheduleRecords(dir, records);
				}
				let timer: NodeJS.Timeout | undefined;
				let grace: NodeJS.Timeout | undefined;
				let cancelled = false;
				const nextText = (): string | null => {
					if (parts) {
						try {
							const at = nextCronFire(parts, Date.now());
							return at === null ? null : new Date(at).toLocaleString();
						} catch {
							return specText;
						}
					}
					return `每 ${Math.round(ms / 1000)}s`;
				};
				const statusText = (): string => {
					const next = nextText();
					return next === null ? "不再触发（表达式在一年内不会命中）" : `下次 ${next}`;
				};
				let bgRefresh: (() => void) | undefined;
				let bgUnreg: (() => void) | undefined;
				if (persistent) {
					const taskId = `schedule:${sid}`;
					bgTaskTable.delete(taskId);
					const entry: PluginBgTask = {
						id: taskId,
						label: `⏰ ${label ?? sid}`,
						since: Date.now(),
						status: statusText(),
						stop: () => off(),
					};
					bgTaskTable.set(taskId, entry);
					self.pluginBgTasks.set(info.id, bgTaskTable);
					const fireBg = (): void => {
						try {
							self.onBgTasksChanged?.();
						} catch {}
					};
					bgRefresh = () => {
						if (!bgTaskTable.has(taskId)) return;
						entry.status = statusText();
						fireBg();
					};
					bgUnreg = () => {
						if (bgTaskTable.delete(taskId)) {
							if (bgTaskTable.size === 0) self.pluginBgTasks.delete(info.id);
							fireBg();
						}
					};
					fireBg();
				}
				const fire = (): void => {
					if (cancelled) return;
					if (persistent) {
						const records = loadScheduleRecords(dir);
						const rec = records[sid];
						if (rec) {
							rec.lastRun = Date.now();
							saveScheduleRecords(dir, records);
						}
					}
					try {
						const r = (fn as () => unknown)();
						if (r instanceof Promise) {
							r.catch((err) => console.error(`[plugin:${info.id}] scheduled task failed:`, err));
						}
					} catch (err) {
						console.error(`[plugin:${info.id}] scheduled task failed:`, err);
					}
					bgRefresh?.();
				};
				let dueAt = parts ? nextCronFire(parts, Date.now()) : null;
				const armCron = (): void => {
					if (cancelled || !parts || dueAt === null) return;
					timer = setTimeout(
						() => {
							if (cancelled || dueAt === null) return;
							if (Date.now() >= dueAt) {
								fire();
								dueAt = nextCronFire(parts, Date.now());
							}
							armCron();
						},
						armDelay(dueAt, Date.now()),
					);
					timer.unref?.();
				};
				if (parts) armCron();
				else {
					timer = setInterval(fire, ms);
					timer.unref?.();
				}
				if (persistent && catchUp === "once") {
					const refTime =
						loadScheduleRecords(dir)[sid]?.lastRun ?? loadScheduleRecords(dir)[sid]?.createdAt ?? Date.now();
					const missed = parts
						? (() => {
								const at = nextCronFire(parts, refTime);
								return at !== null && at <= Date.now();
							})()
						: refTime + ms <= Date.now();
					if (missed) {
						grace = setTimeout(() => fire(), 15_000);
						grace.unref?.();
					}
				}
				const cancelTimer = (): void => {
					cancelled = true;
					if (timer !== undefined) {
						clearTimeout(timer);
						clearInterval(timer);
					}
					if (grace !== undefined) clearTimeout(grace);
				};
				const off = (): void => {
					if (!isCurrent()) return;
					cancelTimer();
					bgUnreg?.();
					if (persistent) {
						const records = loadScheduleRecords(dir);
						if (sid in records) {
							delete records[sid];
							saveScheduleRecords(dir, records);
						}
					}
				};
				effects.add(`schedule:${sid}`, cancelTimer);
				return off;
			},
			models: {
				list: () => {
					try {
						const r = self.modelLister?.();
						if (r instanceof Promise) {
							return r.catch((err) => {
								console.error(`[plugin:${info.id}] modelLister failed:`, err);
								return [];
							});
						}
						return r ?? [];
					} catch (err) {
						console.error(`[plugin:${info.id}] modelLister failed:`, err);
						return [];
					}
				},
			},
			mcp: {
				list: async () => {
					try {
						const cwd = self.cwdValue;
						const bridge = await self.mcpProjects?.prepare(cwd);
						const res = listAllMcpServers({
							agentDir: bridge?.getAgentDir(),
							cwd,
							dataDir: self.dataDir,
							bridge,
						});
						return res.servers;
					} catch (err) {
						console.error(`[plugin:${info.id}] mcp.list failed:`, err);
						return [];
					}
				},
				check: async (query) => {
					try {
						const cwd = self.cwdValue;
						const bridge = await self.mcpProjects?.prepare(cwd);
						return checkMcpServer({
							agentDir: bridge?.getAgentDir(),
							cwd,
							dataDir: self.dataDir,
							bridge,
							query: String(query ?? ""),
						});
					} catch (err) {
						console.error(`[plugin:${info.id}] mcp.check failed:`, err);
						return { installed: false, running: false, enabled: false, server: null, matches: [], tools: [] };
					}
				},
				install: async (spec) => {
					if (!can("tools")) {
						return { ok: false, error: '插件未声明能力 "tools"（manifest.permissions）——请求被拒' };
					}
					try {
						const cwd = self.cwdValue;
						const bridge = await self.mcpProjects?.prepare(cwd);
						const res = await installMcpServer({
							agentDir: bridge?.getAgentDir(),
							cwd,
							dataDir: self.dataDir,
							spec: spec ?? {},
						});
						if (res.ok) {
							await self.mcpProjects?.reload(cwd, res.scope ?? "project");
							const server = checkMcpServer({
								agentDir: bridge?.getAgentDir(),
								cwd,
								dataDir: self.dataDir,
								bridge,
								query: res.name!,
							}).matches.find((s) => s.name === res.name && s.scope === res.scope);
							if (server)
								Object.assign(res, { server, status: server.status, tools: server.tools, error: server.error });
							try {
								self.onAgentToolsChanged?.();
							} catch {}
						}
						return res;
					} catch (err) {
						return { ok: false, error: (err as Error).message };
					}
				},
				promptInstall: async (target, opts) => {
					if (!can("chat") && !can("tools")) {
						return { ok: false, error: '插件未声明能力 "chat" 或 "tools"（manifest.permissions）——请求被拒' };
					}
					const scope = opts?.scope === "global" ? "global" : "project";
					let desc = "";
					if (typeof target === "string") {
						desc = target.trim();
					} else if (target && typeof target === "object") {
						const parts: string[] = [];
						if (target.name) parts.push(`name="${target.name}"`);
						if (target.package) parts.push(`package="${target.package}"`);
						if (target.command) parts.push(`command="${target.command}"`);
						if (target.args?.length) parts.push(`args=${JSON.stringify(target.args)}`);
						if (target.url) parts.push(`url="${target.url}"`);
						desc = parts.join(", ");
					}
					if (!desc) {
						return { ok: false, error: "mcp.promptInstall: target 不能为空" };
					}
					const cfgFile = scope === "global" ? "~/.pi/agent/mcp.json" : ".pi/mcp.json";
					const promptText =
						`请检查并安装以下 MCP 服务器（作用域：${scope}，配置文件：\`${cfgFile}\`）：${desc}。\n` +
						`- 若当前会话已启用 \`mcp_manage\` 工具，请先调用 \`mcp_manage({ action: "check", query: ... })\` 确认是否已安装，未安装则调用 \`mcp_manage({ action: "install", scope: "${scope}", ... })\` 完成安装并验证状态；\n` +
						`- 若未启用 \`mcp_manage\` 工具，请用 \`read\` 检查 \`${cfgFile}\`，并在 \`mcpServers\` 字段下写入对应的服务器配置（例如 \`{ "command": "npx", "args": ["-y", "<package>"] }\`），保存后系统会自动热加载该 MCP 服务器。`;
					const targetConvId =
						(typeof opts?.conversationId === "string" && opts.conversationId.trim()) ||
						self.conversationProvider?.()?.conversationId;
					if (targetConvId && self.conversationWriter) {
						try {
							const r = await self.conversationWriter(targetConvId, promptText);
							return { ok: r.ok, conversationId: targetConvId, ...(r.error ? { error: r.error } : {}) };
						} catch (err) {
							return { ok: false, error: (err as Error).message };
						}
					}
					if (self.chatProvider) {
						try {
							const r = await self.chatProvider(info.id, { text: promptText });
							return { ok: true, conversationId: r.conversationId };
						} catch (err) {
							return { ok: false, error: (err as Error).message };
						}
					}
					return { ok: false, error: "无可用对话通道（conversationWriter / chatProvider 未接入）" };
				},
			},
			onStats: (h) => {
				self.statsHandlers.add(h);
				return effects.add("onStats", () => {
					self.statsHandlers.delete(h);
				});
			},
			onStreaming: (h) => {
				self.streamingHandlers.add(h);
				return effects.add("onStreaming", () => {
					self.streamingHandlers.delete(h);
				});
			},
			net: {
				fetch: async (url, init) => {
					if (!can("net")) return { ok: false, error: '插件未声明能力 "net"（manifest.permissions）——请求被拒' };
					return pluginNetFetch(url, init, {
						hostAllowed: (hostname) =>
							netAllow.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`)) ||
							self.permGrants.has(info.id, "net", { host: hostname }),
						fetchImpl: (input, reqInit) => globalThis.fetch(input, reqInit),
					});
				},
			},
			events: {
				emit: (topic, payload) => {
					const t = String(topic ?? "");
					if (!t) return;
					let p: unknown;
					try {
						const s = JSON.stringify(payload);
						p = s.length > 4096 ? s.slice(0, 4096) : JSON.parse(s);
					} catch {
						try {
							p = String(payload).slice(0, 4096);
						} catch {
							p = undefined;
						}
					}
					const ev: PluginBusEvent = { topic: t, from: info.id, payload: p };
					const handlers = self.busHandlers.get(t);
					if (!handlers) return;
					for (const h of handlers) {
						try {
							h(ev);
						} catch (err) {
							console.error(`[plugin:${info.id}] bus handler failed:`, err);
						}
					}
				},
				on: (topic, handler) => {
					const t = String(topic ?? "");
					if (!t || typeof handler !== "function") return () => {};
					let set = self.busHandlers.get(t);
					if (!set) self.busHandlers.set(t, (set = new Set()));
					set.add(handler);
					return effects.add(`bus:${t}`, () => {
						set.delete(handler);
						if (set.size === 0) self.busHandlers.delete(t);
					});
				},
			},
			log: (levelOrArg, ...args) => {
				const level = normalizePluginLogLevel(levelOrArg);
				const text = formatPluginLogText(levelOrArg === level ? args : [levelOrArg, ...args]);
				self.appendPluginLog(info.id, level, text);
				const line = `[plugin:${info.id}]${text ? ` ${text}` : ""}`;
				if (level === "error") console.error(line);
				else if (level === "warn") console.warn(line);
				else if (level === "debug") console.debug(line);
				else console.log(line);
			},
			effect: (label, dispose) => {
				if (typeof dispose !== "function") return () => {};
				const name =
					String(label ?? "")
						.trim()
						.slice(0, 64) || "anonymous";
				return effects.add(`plugin:${name}`, dispose);
			},
			resolveInWorkspace: (relOrAbsPath: string) => {
				const target = resolve(self.cwdValue, String(relOrAbsPath ?? ""));
				if (!self.isInsideWorkspace(target)) {
					const err: any = new Error("路径超出工作区范围");
					err.statusCode = 403;
					throw err;
				}
				return target;
			},
			fetch: async (input, init) => {
				if (!pluginAbort) {
					pluginAbort = new AbortController();
					effects.add("plugin:fetch-abort", () => {
						try {
							pluginAbort?.abort();
						} catch {}
					});
				}
				const timeoutMs = Math.max(100, Math.min(Number(init?.timeoutMs ?? 30_000) || 30_000, 600_000));
				const timeoutSignal = AbortSignal.timeout(timeoutMs);
				const signals = [pluginAbort.signal, timeoutSignal];
				if (init?.signal) signals.push(init.signal);
				const combinedSignal = (AbortSignal as any).any
					? (AbortSignal as any).any(signals)
					: init?.signal || timeoutSignal;
				return await fetch(input as any, {
					...init,
					signal: combinedSignal,
				});
			},
			assets: {
				ensure: (spec, opts) => {
					return ensurePluginAsset(dir, spec, {
						...opts,
						signal: pluginAbort?.signal,
						log: (msg) => host.log(msg),
					});
				},
				status: (spec) => getPluginAssetStatus(dir, spec),
			},
		};
		const facades = new WeakMap<object, object>();
		const guard = <T extends object>(target: T): T => {
			const cached = facades.get(target);
			if (cached) return cached as T;
			const proxy = new Proxy(target, {
				get: (obj, key) => {
					const value = Reflect.get(obj, key);
					if (typeof value === "function")
						return (...args: unknown[]) => {
							if (obj === host && key === "log" && !isCurrent()) return;
							if (!(obj === host && key === "effect") && !isCurrent())
								throw new Error(`Plugin ${info.id} activation has been disposed`);
							return Reflect.apply(value, obj, args);
						};
					if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
						return guard(value);
					return value;
				},
			});
			facades.set(target, proxy);
			return proxy;
		};
		const guardedHost = guard(host);
		this.activatingEffects.add(effects);
		try {
			const mod = (await import(pathToFileURL(join(dir, "index.mjs")).href + `?e=${this.epochCounter}`)) as {
				default?:
					| ((host: PluginHost) => void | (() => void) | Promise<void | (() => void)>)
					| {
							activate?: (host: PluginHost) => void | (() => void) | Promise<void | (() => void)>;
					  };
			};
			if (!isCurrent()) return;
			const activateFn = typeof mod.default === "function" ? mod.default : mod.default?.activate;
			const ret = await activateFn?.(guardedHost);
			if (!isCurrent()) {
				if (typeof ret === "function") this.runDeactivate(info.id, ret);
				return;
			}
			const gateWarned = self.activatingGates.get(info.id)?.legacyWarned;
			self.activatingGates.delete(info.id);
			const combined = this.diagnosticsOf(info.id);
			this.loaded.set(info.id, {
				info: { ...info, ...(combined ? { diagnostics: combined } : {}) },
				deactivate: typeof ret === "function" ? ret : undefined,
				toolHandlers,
				preGuards,
				postGuards,
				runHandlers,
				convChangeHandlers,
				modelChangeHandlers,
				attachHandlers,
				cwdHandlers,
				effects,
				httpRoutes,
				permsDeclared,
				permFamilies,
				strictMode: strict,
				legacyWarned: gateWarned,
				settingsHandlers,
			});
			console.log(`[plugin:${info.id}] activated (v${info.version ?? "?"})`);
			void this.maybeConsentNotice(info, dir, permsDeclared);
		} catch (err) {
			const failed = effects.release();
			httpRoutes.clear();
			if (generation !== this.lifecycleGeneration) return;
			self.activatingGates.delete(info.id);
			this.pushRuntimeDiag(info.id, `activate failed: ${(err as Error).message}`);
			if (failed.length > 0)
				this.pushRuntimeDiag(
					info.id,
					`activate failed with ${failed.length} effect(s) not cleaned: ${failed.join(", ")}`,
				);
			this.loaded.set(info.id, {
				info: { ...info, error: (err as Error).message, diagnostics: this.diagnosticsOf(info.id) },
				toolHandlers,
				runHandlers,
				convChangeHandlers,
				attachHandlers,
				cwdHandlers,
				httpRoutes,
				settingsHandlers: new Set(),
			});
			console.error(`[plugin:${info.id}] activate failed:`, err);
		} finally {
			this.activatingEffects.delete(effects);
		}
	}
}

export function resolvePluginClientFile(pluginsDir: string, id: string, rest: string): string | null {
	if (!ID_RE.test(id)) return null;
	const root = resolve(join(pluginsDir, id, "client"));
	const abs = resolve(root, rest);
	if (abs !== root && !abs.startsWith(root + sep)) return null;
	return abs;
}

export function resolvePluginSharedFile(sharedDir: string, rest: string): string | null {
	const root = resolve(sharedDir);
	const abs = resolve(root, rest);
	if (abs !== root && !abs.startsWith(root + sep)) return null;
	return abs;
}

export const PROXY_RESERVED_PREFIXES = [
	"/api",
	"/ws",
	"/plugins",
	"/plugins-api",
	"/plugins-shared",
	"/assets",
	"/icons",
	"/themes",
] as const;

export interface PluginProxyTarget {
	host: string;
	port: number;
}

export function normalizeProxyPrefix(prefix: string): string | null {
	if (typeof prefix !== "string") return null;
	let p = prefix.trim();
	if (!p.startsWith("/") || p.length < 2) return null;
	while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
	if (!/^[A-Za-z0-9/_-]+$/.test(p) || p.includes("//")) return null;
	const lower = p.toLowerCase();
	for (const r of PROXY_RESERVED_PREFIXES) {
		if (lower === r || lower.startsWith(`${r}/`)) return null;
	}
	return lower;
}

export function normalizeProxyTarget(target: unknown): PluginProxyTarget | null {
	const port = typeof target === "number" ? target : (target as { port?: unknown })?.port;
	const hostRaw =
		typeof target === "number" ? "127.0.0.1" : String((target as { host?: unknown })?.host ?? "127.0.0.1");
	const host = hostRaw.trim().toLowerCase();
	if (host !== "127.0.0.1" && host !== "localhost") return null;
	if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return null;
	return { host: "127.0.0.1", port: port as number };
}

export function matchProxyPrefix(path: string, prefixes: Iterable<string>): string | undefined {
	let best: string | undefined;
	for (const p of prefixes) {
		if (path === p || path.startsWith(`${p}/`)) {
			if (!best || p.length > best.length) best = p;
		}
	}
	return best;
}

export function syncPluginToolsIntoSession(
	session: {
		_customTools?: Array<{ name: string } & Record<string, unknown>>;
		_refreshToolRegistry?: () => void;
	},
	defs: Array<{ name: string } & Record<string, unknown>>,
	prevNames: ReadonlySet<string>,
): ReadonlySet<string> | null {
	if (!Array.isArray(session._customTools) || typeof session._refreshToolRegistry !== "function") return null;
	const byName = new Map(session._customTools.map((d) => [d.name, d]));
	let changed = false;
	for (const d of defs) {
		if (byName.get(d.name) !== d) {
			byName.set(d.name, d);
			changed = true;
		}
	}
	for (const name of prevNames) {
		if (!defs.some((d) => d.name === name) && byName.has(name)) {
			byName.delete(name);
			changed = true;
		}
	}
	if (!changed) return new Set(defs.map((d) => d.name));
	session._customTools = [...byName.values()];
	session._refreshToolRegistry();
	return new Set(defs.map((d) => d.name));
}

const NET_FETCH_MAX_REDIRECTS = 5;

export interface PluginNetFetchInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

export type PluginNetFetchResult = { ok: true; status: number; text: string } | { ok: false; error: string };

type FetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>;
type FetchLike = (input: string, init?: RequestInit) => Promise<FetchResponse>;

export async function pluginNetFetch(
	url: string,
	init: PluginNetFetchInit | undefined,
	deps: {
		hostAllowed: (hostname: string) => boolean;
		fetchImpl: FetchLike;
		timeoutMs?: number;
	},
): Promise<PluginNetFetchResult> {
	const deadline = Date.now() + Math.max(1000, Number(deps.timeoutMs ?? 15_000));
	let current = String(url ?? "");
	let method = init?.method;
	let headers: Record<string, string> | undefined = init?.headers;
	let body = init?.body;
	for (let hop = 0; ; hop++) {
		let u: URL;
		try {
			u = new URL(current);
		} catch {
			return { ok: false, error: `net: 无效 URL ${current}` };
		}
		if (u.protocol !== "http:" && u.protocol !== "https:") {
			return { ok: false, error: `net: 不支持的协议 ${u.protocol}` };
		}
		if (!deps.hostAllowed(u.hostname.toLowerCase())) {
			return {
				ok: false,
				error: `net: 主机 ${u.hostname} 未授权（manifest.netAllowlist 或 host.requestPermission 申请）`,
			};
		}
		if (body !== undefined && Buffer.byteLength(String(body), "utf8") > 1024 * 1024) {
			return { ok: false, error: "net: body 超过 1MB 上限" };
		}
		let res: FetchResponse;
		try {
			res = await deps.fetchImpl(current, {
				...(method ? { method } : {}),
				...(headers ? { headers } : {}),
				...(body !== undefined ? { body } : {}),
				redirect: "manual",
				signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
			});
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get("location");
			if (loc) {
				if (hop >= NET_FETCH_MAX_REDIRECTS) {
					return { ok: false, error: `net: 重定向超过 ${NET_FETCH_MAX_REDIRECTS} 跳上限` };
				}
				let next: URL;
				try {
					next = new URL(loc, u);
				} catch {
					return { ok: false, error: `net: 重定向目标无效 ${loc}` };
				}
				if (next.hostname.toLowerCase() !== u.hostname.toLowerCase() && headers) {
					const stripped: Record<string, string> = {};
					for (const [k, v] of Object.entries(headers)) {
						const key = k.toLowerCase();
						if (key === "authorization" || key === "cookie") continue;
						stripped[k] = v;
					}
					headers = stripped;
				}
				if (res.status === 303) {
					method = "GET";
					body = undefined;
				}
				current = next.toString();
				continue;
			}
		}
		try {
			const text = (await res.text()).slice(0, 512 * 1024);
			return { ok: true, status: res.status, text };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}
}
