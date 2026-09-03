/**
 * AgentService — wraps the pi SDK (@earendil-works/pi-coding-agent) for the web
 * frontend. Each browser client (identified by a persistent clientId) gets its
 * own AgentSessionRuntime, but sessions live in the SDK default per-project
 * directory (<agentDir>/sessions/--<cwd>--/) — the same transcript files the
 * pi CLI/TUI use — so every conversation of a folder shows up everywhere.
 *
 * Streaming model: the SDK emits AgentSessionEvents; we forward lightweight
 * `tool_delta` messages for live tool output and schedule throttled full-state
 * snapshots. The frontend is snapshot-driven (server is the source of truth),
 * so reconnects just re-request a snapshot.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, mkdirSync, watch } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createBashTool,
	createLocalBashOperations,
	getAgentDir,
	SessionManager,
	VERSION,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type SessionInfo,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BgServerTracker } from "./bg-servers.js";
import {
	checkAll as checkAllUpdates,
	collectTargets,
	compareVersions as compareSemver,
	type UpdateItem,
} from "./update-check.js";
import { hasPendingWaitSubscription, shouldRetainActive } from "./wait-subscription-scan.js";
import type { PluginAgentTool, PluginCommandDef, PluginToolEvent } from "./plugins.js";
import { syncPluginToolsIntoSession } from "./plugins.js";
import { SettingsService } from "./settings-service.js";
import { GoalService } from "./goal-service.js";
import { SlashCommandsService, parseSlash } from "./slash-commands.js";
import { ModelAdminService } from "./model-admin.js";
import { FilesService, workspacePath } from "./files-service.js";
import { isExtensionDisabled, type PromptMode, ClientStateStore } from "./client-state.js";

import {
	applyHeadTail,
	makePersistentTerminalTools,
	makeTerminalBashTool,
	stripAnsi,
	TERMINAL_TOOLS_GUIDANCE,
	TERMINAL_TOOL_NAMES,
} from "./terminals.js";
import { WebUIContext } from "./webui-context.js";
import { buildAttachmentMessages } from "./attachments.js";
import type {
	BgServer,
	CommandDef,
	ConversationSummary,
	GoalStatus,
	MessageAnchor,
	ProjectSummary,
	ServerMessage,
	SessionSummary,
	UiMessage,
	UiState,
} from "./protocol.js";
import { serializeMessage, serializeStreamingMessage, type AgentMessage } from "./serialize.js";
import { loadCommands, saveCommandsFile, TerminalManager } from "./terminals.js";

const SNAPSHOT_INTERVAL_MS = 60;
/** While assistant deltas are flowing, live rendering is carried by
 *  message_delta — full snapshots become pure reconciliation checkpoints, so
 *  send them on a slow event-driven cadence (see flushSnapshot call-sites:
 *  agent_end / tool_execution_end always checkpoint immediately). */
const STREAMING_SNAPSHOT_INTERVAL_MS = 2000;
/** Deltas newer than this keep the streaming (low-frequency) snapshot cadence. */
const DELTA_ACTIVE_WINDOW_MS = 1500;
const WIDGET_REFRESH_MS = 2000;
/** Model-stall watchdog: warn (don't abort — deep thinking can be legitimately
 *  quiet for minutes) when a streaming run produced NO SDK events for this long.
 *  Covers the failure class the per-tool watchdog cannot see: half-open API
 *  connections / hung proxies where no tool is running and no error is thrown.
 *  Override: PI_WEB_STALL_NOTIFY_MS (milliseconds; 0 disables). */
const STALL_NOTIFY_MS = (() => {
	const v = Number(process.env.PI_WEB_STALL_NOTIFY_MS);
	return Number.isFinite(v) && v >= 0 ? v : 180_000;
})();
/** Serialization-cache cap per conversation (see serializeCached): cached
 *  UiMessage objects are pure-function results, so eviction only costs a
 *  recompute on next access. Bounds memory for marathon sessions. */
const UI_MESSAGE_CACHE_CAP = 4096;
/** Preview panel cap: only the first 512KB of a file is ever read/sent. */

/** Thrown when the service is quiesced (draining) and the request is NEW work
 *  the admission controller refuses: a brand-new client attach, a prompt,
 *  a fork, a session resume, or a goal wizard start. index.ts closes the
 *  WebSocket with 4403 so the browser reconnect loop can retry after the
 *  server reopens admission (see AgentService.quiesce). */
export class QuiesceRejectedError extends Error {
	readonly code = "QUIESCED";
	constructor(detail: string) {
		super(`服务器正在排空存量工作（quiesce）——${detail}`);
		this.name = "QuiesceRejectedError";
	}
}

// ---------------------------------------------------------------------------
// Preview kind classification. The preview panel only opens image / video /
// text-editable files; everything else (exe, jar, archives, …) is refused so
// it is never read or sent to the browser. Media files are served over the
// /api/file HTTP endpoint instead of the WebSocket, so they are classified
// here but never read into the snapshot path.
// ---------------------------------------------------------------------------

/** Windows persona appendix — appended to the SDK system prompt on win32 only.
 *  Two failure modes it guards against: (1) the SDK bash tool has NO default
 *  timeout, so a long-running command hangs the whole conversation forever;
 *  (2) the in-app terminal is an interactive TTY where heredocs / interactive
 *  programs wait for input that never comes. Legacy Chinese files are often
 *  GBK/GB2312 — read them with the right encoding, never paste mojibake into
 *  reasoning/answers. */
const WINDOWS_PERSONA = `You are a coding agent running on Windows. The bash tool runs Git Bash (bash.exe), not PowerShell. Follow these rules to avoid hanging the session:



- ALWAYS pass a timeout parameter to the bash tool (in seconds). There is NO default timeout — a command that never finishes (servers, watchers, infinite loops, slow downloads/installs) will hang the entire conversation indefinitely. Pick a generous timeout for long-running work, but never omit it.
- NEVER run interactive or foreground long-running commands through the bash tool (vi, less, top, python -, node -, npm run dev, sleep 10000). For servers/daemons use background execution with output redirected to a log file, then poll the log; stop them when done.
- In the interactive terminal (TTY) — which is Git Bash too, not PowerShell — NEVER use heredocs (<<'EOF' ... EOF) or here-strings, and NEVER start interactive programs (vi, less, python -, node -, npm init): they wait for keyboard input that never arrives and hang the terminal forever. Prefer writing a temp script file (e.g. .pi-tmp.sh) and running it non-interactively. ALWAYS pass a timeout to long-running commands (e.g. \`timeout 120 npm run dev\`).

Many legacy Chinese text files (.html/.txt/.md/.log, exported documents) are GBK/GB2312 encoded: the read tool decodes UTF-8 only and will show mojibake (乱码) for them. If a file's content looks garbled, read it through the terminal instead: in Git Bash use \`cat file | iconv -f GBK -t UTF-8\` (or \`iconv -f GBK -t UTF-8 file\`); in cmd use \`chcp 65001 && type file\`; in PowerShell use \`Get-Content -Encoding Default file\`. Never paste mojibake into your reasoning or answer — describe the decoded content instead.`;

/** bash 工具输出限制/过滤管道引导：模型习惯套 `| tail/-n`、`| head`、`| grep`、`| less`
 *  等限输出。这些管道在持久终端里会①缓冲（可见终端全程哑火、看不到实时进度）②把退出码
 *  错报成管道末尾命令（tail 恒 0、grep 无命中恒 1，灾难性掩盖真实失败）③长驻/出错命令会挂到超时。
 *  让模型改用 bash 的 `tail` 参数限输出；长驻/交互任务改走持久终端工具。 */
const PIPELESS_BASH_GUIDANCE = `Bash tool output-limiting/filtering: do NOT chain shell pipes to trim or filter output. Avoid \`| tail\`, \`| head\`, \`| grep\`, \`| less\`, \`| more\`, \`| cat\`, \`| sort\`, \`| awk\`, \`| sed\`. They buffer output (so the visible terminal shows nothing live), turn the real exit code into the last pipe command's (tail always 0, grep 1 when no match — hiding the actual failure), and can hang a long-running or failing command until timeout. Instead:\n- To limit returned output use the bash \`tail\` parameter (e.g. \`bash(command=..., tail=20)\`) — the underlying command still streams live to the visible terminal.\n- For a long-running server / watcher / interactive program, use the persistent terminal tools (terminal_create then terminal_read / terminal_input / terminal_key / terminal_wait) instead of piping through bash.\nThe bash tool auto-detects a trailing \`| tail\`/\`| grep\` etc. and runs the underlying command directly so it never hides a failure — but you should still prefer the \`tail\` parameter.`;
/**
 * Killable bash tool: wraps the SDK bash tool (native process spawn, NO terminal).
 * Used when the「默认 bash 覆盖」setting is OFF. Registers its own AbortController
 * into a client-level set (kills) so abortBash() kills only these commands while the
 * agent run and the conversation continue. Exposes persist (ignored — native has no
 * terminal) plus head/tail (post-processed on the returned output) so the parameter
 * schema stays consistent with the terminal-backed tool.
 */
export function makeKillableBashTool(cwd: string, kills: Set<AbortController>): ToolDefinition {
	const base = createLocalBashOperations();
	const tool = createBashTool(cwd, {
		operations: {
			exec: async (command, c, opts) => {
				const ac = new AbortController();
				kills.add(ac);
				try {
					const signals = [opts.signal, ac.signal].filter((s): s is AbortSignal => s !== undefined);
					return await base.exec(command, c, {
						...opts,
						signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
					});
				} finally {
					kills.delete(ac);
				}
			},
		},
	});
	// AgentTool → ToolDefinition (same fields; customTools expects definitions).
	return {
		name: tool.name,
		label: tool.label,
		description:
			"Run a shell command natively (process spawn, no terminal) and return its full output plus exit code — the SDK's plain bash tool. persist is ignored here (no terminal); use head/tail to trim the returned output.",
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run" }),
			timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds" })),
			persist: Type.Optional(
				Type.Boolean({
					description: "Ignored in native mode (no terminal). Only meaningful when the terminal-backed bash is active.",
				}),
			),
			head: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 5000,
					description: "Only return the FIRST N lines of output (like `| head -N`).",
				}),
			),
			tail: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 5000,
					description: "Only return the LAST N lines of output (like `| tail -N`).",
				}),
			),
		}),
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const result = (await tool.execute(
				toolCallId,
				params as { command: string; timeout?: number },
				signal,
				onUpdate,
			)) as { content?: Array<{ type: string; text?: string }> };
			// head/tail 后处理（native 无终端，直接截返回行即可）。
			const p = params as { head?: number; tail?: number };
			if ((p?.head || p?.tail) && result?.content?.[0]?.text != null) {
				result.content![0].text = applyHeadTail(result.content![0].text!, p.head, p.tail);
			}
			return result as never;
		},
	} as ToolDefinition;
}

/**
 * 动态分流 bash：按「默认 bash 覆盖」设置（terminalBash）在调用时决定走哪套——
 * 关 = 原生 SDK bash（纯进程、不开终端）；开 = 终端接管 bash（persist 决定一次性/
 * 持久）。开关因此即时生效（customTools 固定于 runtime 创建，不能在创建时二选一）。
 */
export function makeAdaptiveBashTool(
	killable: ToolDefinition,
	terminalBacked: ToolDefinition,
	useTerminal: () => boolean,
): ToolDefinition {
	return {
		...killable,
		description:
			"Run a shell command and return its full output plus exit code. Behavior depends on the「default bash override」setting (terminalBash):\n" +
			"Setting OFF → runs natively (process spawn, no terminal) — the SDK's plain bash tool. persist has no effect.\n" +
			"Setting ON → runs in a visible terminal. persist=true keeps that terminal alive ('ai-bash': shell state such as cd/venv/ssh retained across calls, silent commands move to the background and notify when done); persist=false (default in terminal mode) creates a one-shot terminal that exits when the command finishes while its output stays for review.\n" +
			"Run the bare command — do NOT pipe through head/tail/more/less (use the head/tail parameters to trim the returned output instead; piping also hides live progress in the visible terminal). For interactive commands (REPLs, prompts, installers asking y/n) set persist=true (terminal mode) and drive them with terminal_input / terminal_key.",
		promptSnippet: "run shell commands",
		execute: (id, params, signal, onUpdate, ctx) =>
			(useTerminal() ? terminalBacked : killable).execute(id, params as never, signal, onUpdate, ctx),
	};
}

/**
 * 插件结构化工具 → SDK ToolDefinition。
 * execute 返回值宽容处理：{content,details} 原样收编；字符串/对象包成文本块。
 */
function pluginToolToDefinition(tool: PluginAgentTool): ToolDefinition {
	const normalize = (
		result: unknown,
	): {
		content: Array<{ type: "text"; text: string }>;
		details?: unknown;
	} => {
		if (result && typeof result === "object" && Array.isArray((result as { content?: unknown }).content)) {
			return result as {
				content: Array<{ type: "text"; text: string }>;
				details?: unknown;
			};
		}
		const text = typeof result === "string" ? result : JSON.stringify(result ?? null, null, 2);
		return { content: [{ type: "text", text }] };
	};
	return {
		name: tool.name,
		label: tool.label ?? tool.name,
		description: tool.description,
		promptSnippet: tool.promptSnippet,
		promptGuidelines: tool.promptGuidelines,
		parameters: (tool.parameters ?? {
			type: "object",
			properties: {},
		}) as ToolDefinition["parameters"],
		execute: async (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: ((partial: unknown) => void) | undefined,
		) => {
			const raw = await tool.execute(
				toolCallId,
				params as Record<string, unknown>,
				signal,
				onUpdate ? (partial) => onUpdate(normalize(partial) as never) : undefined,
			);
			return normalize(raw) as never;
		},
	} as unknown as ToolDefinition;
}

/**
 * Cheap per-message discriminator for the serialization cache key. Persisted
 * message content never changes, so this is stable across snapshots, while
 * several same-role messages created within one millisecond (attachment
 * asides) get distinct keys. Text blocks are fingerprinted by a short hash of
 * their head (paths embedded in <file> tags can share long prefixes — e.g.
 * uploads created in the same millisecond differ only at the tail); image
 * payloads by data length (identical lengths within the same ms are far too
 * unlikely to matter).
 */
function contentFingerprint(m: AgentMessage): string {
	const content = (m as unknown as { content?: unknown }).content;
	if (!Array.isArray(content) || content.length === 0) return "empty";
	const first = content[0] as { type?: string; text?: string; data?: string };
	if (first?.type === "image") {
		return `img:${(first.data ?? "").length}`;
	}
	const text = typeof first?.text === "string" ? first.text : "";
	// djb2 — fast enough to run per snapshot, distinct enough for asides.
	let h = 5381;
	for (let i = 0; i < text.length && i < 512; i++) {
		h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
	}
	return `txt:${h.toString(36)}:${text.length}`;
}

// ---------------------------------------------------------------------------
// Web UI context adapter — bridges extension UI calls (setWidget/notify) to the
// browser. Extensions like rpiv-todo render a TUI widget via
// `ui.setWidget(key, (tui, theme) => comp)`; we capture the component, render it
// with a mock theme to plain text lines, and push them to the client.
// ---------------------------------------------------------------------------

function extractPartialText(partial: unknown): string | null {
	const content = (partial as { content?: unknown } | null | undefined)?.content;
	if (Array.isArray(content)) {
		const text = content
			.map((c) => ((c as { type?: string; text?: string })?.type === "text" ? (c as { text: string }).text : ""))
			.join("");
		return text.length > 0 ? text : null;
	}
	return null;
}

export { workspacePath };
// ---------------------------------------------------------------------------
// Per-client persisted UI state (<dataDir>/client-state.json)
// ---------------------------------------------------------------------------

/**
 * One open conversation (chat thread) of a client. Each conversation owns its
 * OWN AgentSessionRuntime, so starting a new chat or switching between chats
 * never interrupts another conversation's in-flight run.
 */
interface Conversation {
	id: string;
	/** Display title: first user prompt (truncated) or the default. */
	title: string;
	runtime: AgentSessionRuntime;
	session: AgentSession;
	cwd: string;
	createdAt: number;
	/** In the per-project "running conversations" list. A conversation enters
	 *  the list when it is displaced to the background while still streaming;
	 *  it leaves (and its runtime is freed) when it is opened again and left
	 *  without continuing. */
	listed: boolean;
	/** A prompt was sent while this conversation was active (cleared whenever
	 *  it becomes active). A listed conversation that is displaced while idle
	 *  with this still false counts as "opened but not continued" and is
	 *  dismissed from the list. */
	promptedSinceActive: boolean;
	/** Last time this conversation became active — set_cwd picks the target
	 *  project's most recently active conversation. */
	lastActiveAt: number;
	/** Last time ANY SDK event arrived for this conversation — drives the
	 *  model-stall watchdog (#7): a run that produces no events at all for
	 *  STALL_NOTIFY_MS is probably a half-open API connection. */
	lastSdkEventAt: number;
	/** Set once the stall notice has been sent for the current silent period;
	 *  cleared on every SDK event and on each new prompt. */
	stallNoticed: boolean;
	/** Independent goal/review state for this conversation. */
	goal: GoalStatus;
	goalGeneration: number;
	goalReviewGeneration: number;
	/** Wizard execution is per conversation; dialog transport itself remains
	 * client-wide because the browser can display one dialog at a time. */
	wizardRunning: boolean;
	/** Session event subscription — events are routed to THIS conversation. */
	unsubscribe?: () => void;
	/** Monotonic sequence for message_delta/tool_delta pushes of this conversation —
	 *  a gap on the client triggers a get_state resync. */
	deltaSeq: number;
	/** PTYs belong to the conversation, not the browser socket or client. */
	terminals: TerminalManager;
	// Per-conversation serialization caches. Message ids derive from
	// (role, timestamp); two conversations can produce identical pairs, so
	// these must never be shared across conversations.
	msgIds: Map<string, number>;
	nextMsgId: number;
	/** Per-timestamp 1-based user-message seq (drives the `u-<ts>-<seq>` id suffix). */
	userSeqByTs: Map<number, number>;
	uiMessageCache: Map<string, UiMessage>;
	lastMessagesSig: string;
	lastMessagesArray: UiMessage[];
	/** Actual queued prompt TEXTS (steer = 插队, followUp = 排队) — the UI
	 *  renders them as pending bubbles in the real message list. */
	queueSteering: string[];
	queueFollowUp: string[];
	/** tool_execution_start timestamps keyed by toolCallId — lets tool_status
	 *  report how long a tool actually ran (vs. waiting on the model). */
	toolStartTimes: Map<string, number>;
	/** tool_call watchdog timers keyed by toolCallId — a tool that runs past
	 *  TOOL_WATCHDOG_TIMEOUT_MS gets the session aborted instead of hanging
	 *  the conversation forever (the SDK bash tool has no default timeout). */
	toolWatchdogs: Map<string, ReturnType<typeof setTimeout>>;
}

/** Hard cap on how long ONE tool call may run before the watchdog aborts the
 *  session. The SDK bash tool has NO default timeout, so a command that never
 *  finishes (servers, watchers, infinite loops) would otherwise hang the whole
 *  conversation indefinitely. Override with the PI_WEB_TOOL_TIMEOUT_MS env var
 *  (milliseconds). */
const TOOL_WATCHDOG_TIMEOUT_MS = (() => {
	const v = Number(process.env.PI_WEB_TOOL_TIMEOUT_MS);
	return Number.isFinite(v) && v > 0 ? v : 20 * 60_000;
})();

/** Cap on simultaneously open conversations of ONE project (each keeps a full
 *  runtime alive; conversations of other projects keep their own lists). */
const MAX_OPEN_CONVERSATIONS = 8;
const DEFAULT_CONV_TITLE = "新对话";

/** First user text in a session, truncated for the conversation list. */
function conversationTitle(session: AgentSession): string {
	try {
		for (const m of session.agent.state.messages) {
			if (m.role !== "user") continue;
			const content = m.content as unknown;
			let text = "";
			if (typeof content === "string") {
				text = content;
			} else if (Array.isArray(content)) {
				for (const p of content) {
					if (
						p &&
						typeof p === "object" &&
						(p as { type?: unknown }).type === "text" &&
						typeof (p as { text?: unknown }).text === "string"
					) {
						text = (p as { text: string }).text;
						break;
					}
				}
			}
			const trimmed = text.trim().replace(/\s+/g, " ");
			if (trimmed.length > 0) {
				return trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed;
			}
		}
	} catch {
		// best-effort
	}
	return DEFAULT_CONV_TITLE;
}

/** 全局搜索的会话匹配：大小写不敏感，命中任一项即算 ——
 *  显示名、当前项目内的文件名片段、首条消息，以及完整转录文本
 *  （SDK 的 allMessagesText 包含每一段 user 与 assistant 消息，AI 输出也在内）。 */
function sessionMatchesSearch(q: string, s: SessionInfo): boolean {
	if (s.name && s.name.toLowerCase().includes(q)) return true;
	if (basename(s.path).toLowerCase().includes(q)) return true;
	if (s.firstMessage.toLowerCase().includes(q)) return true;
	if (s.allMessagesText.toLowerCase().includes(q)) return true;
	return false;
}

/** 抽取一条 AgentMessage 的可搜索文本（user/assistant 的 text 块；
 *  镜像 SDK buildSessionInfo 的 allMessagesText 范围，保证搜索与定位一致）。 */
function messageSearchText(m: { content?: unknown }): string {
	const c = m.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	const parts: string[] = [];
	for (const b of c) {
		if (!b || typeof b !== "object") continue;
		const blk = b as { type?: unknown; text?: unknown };
		if (blk.type === "text" && typeof blk.text === "string") parts.push(blk.text);
	}
	return parts.join("\n");
}

/** 扫描一个会话转录文件，收集文本命中查询的消息锚点（role + timestamp，
 *  按转录顺序，最多 cap 个）。仅 user/assistant 消息参与，与搜索范围一致。 */
function collectSessionAnchors(filePath: string, q: string, cap = 10): MessageAnchor[] {
	const anchors: MessageAnchor[] = [];
	if (!q) return anchors;
	try {
		const lines = readFileSync(filePath, "utf8").split("\n");
		for (const line of lines) {
			if (!line.trim()) continue;
			let e: {
				type?: unknown;
				message?: { role?: unknown; timestamp?: unknown; content?: unknown };
			};
			try {
				e = JSON.parse(line);
			} catch {
				continue;
			}
			if (e?.type !== "message") continue;
			const m = e.message;
			if (!m) continue;
			if (m.role !== "user" && m.role !== "assistant") continue;
			if (typeof m.timestamp !== "number") continue;
			const text = messageSearchText(m);
			if (!text || !text.toLowerCase().includes(q)) continue;
			anchors.push({ role: m.role, timestamp: m.timestamp });
			if (anchors.length >= cap) break;
		}
	} catch {
		// 单个转录损坏不影响其余会话
	}
	return anchors;
}

export class ClientSession {
	readonly clientId: string;
	/** Set by AgentService.attach: reflects the SERVICE-wide quiesce flag
	 *  (server draining — new work rejected). Default false for direct use. */
	isQuiesced: () => boolean = () => false;
	cwd: string;
	/** pi config dir (auth/models/skills). */
	private readonly agentDir: string;
	/** Persisted per-client UI state (last workspace + recent projects). */
	private readonly stateStore: ClientStateStore;
	/** Open conversations — each owns its OWN runtime, so starting a new chat
	 *  or switching chats never interrupts an in-flight run. `runtime` and
	 *  `session` accessors below target the ACTIVE conversation. */
	private convs = new Map<string, Conversation>();
	private activeId = "";
	private convSeq = 0;
	/** One ModelRuntime shared by all conversations — the model chosen in the
	 *  top bar applies to every chat, not just the one that set it. Seeded by
	 *  the first conversation and reused by later ones. */
	private sharedModelRuntime: Awaited<ReturnType<typeof createAgentSessionServices>>["modelRuntime"] | undefined;

	// -----------------------------------------------------------------------
	// Goal / review / wizard —— 自包含模块，见 goal-service.ts。每个对话有独立
	// 的 GoalStatus，审查可并发；宿主回调在构造函数里接入。
	// -----------------------------------------------------------------------
	private readonly goalSvc: GoalService;
	/** Settings-panel state (system prompt + disabled skills/extensions) —
	 *  自包含模块，见 settings-service.ts。resource-loader overrides 在每次
	 *  reload() 时读 current 的最新值，session.reload() 即可应用到运行中 runtime。 */
	private settingsSvc!: SettingsService; // 构造函数里创建（需要 clientId/stateStore）
	/** How long a hard abort waits for session.abort() to make the run idle
	 *  before force-resetting the conversation (model streams that ignore the
	 *  abort signal would otherwise leave the chat stuck forever). */
	private static readonly HARD_ABORT_TIMEOUT_MS = 15_000;
	/** Extra settle window after session.abort() returns: the run is only
	 *  considered stopped once its agent_end event arrives. If it doesn't
	 *  (model stream stuck before the run even started), force-reset. */
	private static readonly HARD_ABORT_SETTLE_MS = 8_000;
	/** Live AbortControllers of THIS client's running bash tool calls — aborting
	 *  them kills only the command (agent run and conversation continue). */
	private bashKills = new Set<AbortController>();
	/** Background-server tracking (port snapshots + 后台任务 panel state) —
	 *  自包含模块，见 bg-servers.ts。列表按 CLIENT 存活，不随对话切换/结束消失。 */
	/** 文件树 / 预览读写 / SCM 查询 / watcher —— 自包含模块，见 files-service.ts。 */
	private readonly files = new FilesService({
		emit: (msg) => this.emit(msg),
		isDisposed: () => this.disposed,
		getCwd: () => this.cwd,
		getActiveCwd: () => this.conv?.cwd ?? this.cwd,
	});
	private readonly bg = new BgServerTracker({
		emit: (msg) => this.emit(msg),
		flushSnapshot: () => this.flushSnapshot(),
		isDisposed: () => this.disposed,
		// 插件注册的常驻任务（host.registerBackgroundTask）并入同一「后台任务」面板。
		pluginTasks: () => this.pluginBgTasksProvider?.() ?? [],
	});

	/** index.ts 注入（经 AgentService 拷贝到每个新会话）：把 SDK 工具执行事件转发给
	 *  插件（PluginManager.emitToolEvent）。未设置时不做任何事。 */
	onToolEvent: ((ev: PluginToolEvent) => void) | undefined = undefined;
	/** index.ts 注入：读取插件当前注册的 AI 工具（attach 时拷贝到每个新会话）。 */
	pluginToolsProvider: (() => PluginAgentTool[]) | undefined = undefined;
	/** index.ts 注入：读取插件当前注册的斜杠命令（目录展示 + prompt 拦截执行）。 */
	pluginCommandsProvider: (() => PluginCommandDef[]) | undefined = undefined;
	/** index.ts 注入：读取插件注册的常驻后台任务（并入 bg_servers 面板）。 */
	pluginBgTasksProvider: (() => BgServer[]) | undefined = undefined;
	/** index.ts 注入：停止插件任务（kill_background_server with taskId）。 */
	pluginStopBgTask: ((taskId: string) => boolean) | undefined = undefined;
	/** 上一轮注入会话的插件工具名集合（用于检测注销/移除）。 */
	private appliedPluginToolNames = new Set<string>();

	/** The active conversation (all session operations target it). */
	private get conv(): Conversation {
		const conv = this.convs.get(this.activeId);
		if (!conv) throw new Error("no active conversation");
		return conv;
	}
	/** Runtime of the active conversation. */
	get runtime(): AgentSessionRuntime {
		return this.conv.runtime;
	}
	/** Session of the active conversation. */
	get session(): AgentSession {
		return this.conv.session;
	}

	/** PTYs are owned by individual conversations; this getter targets the active one
	 * for compatibility with the existing terminal-panel dispatch path. */
	get terminals(): TerminalManager {
		return this.conv.terminals;
	}

	getTerminalManager(conversationId?: string): TerminalManager | undefined {
		return (conversationId ? this.convs.get(conversationId) : this.conv)?.terminals;
	}

	getTerminalCwd(conversationId?: string): string {
		return (conversationId ? this.convs.get(conversationId) : this.conv)?.cwd ?? this.cwd;
	}

	private makeTerminalManager(conversationId: string, cwd: string): TerminalManager {
		const mgr = new TerminalManager((msg) => this.emitTerminal(conversationId, msg), cwd);
		// 终端活力检测：AI 触碰过的终端静默 ≥ 阈值（PI_WEB_TERMINAL_IDLE_MS，
		// 默认 15s）且该对话正在运行时，注入一条 steer 消息唤醒 AI 去检查。
		mgr.onAgentIdle = (terminalId, idleMs, title, lastLines) =>
			this.notifyTerminalIdle(conversationId, terminalId, idleMs, title, lastLines);
		return mgr;
	}

	/** 终端活力提醒：仅在该对话正在流式运行时注入（sendUserMessage 在流式中
	 *  即 steer 语义——当前回合结算后送达，agent 立即响应）；空闲时不打扰。
	 *  一次性语义由 TerminalManager 保证（触发后解除武装，agent 再次触碰才
	 *  重新计时），不会反复刷屏。 */
	private notifyTerminalIdle(
		conversationId: string,
		terminalId: string,
		idleMs: number,
		title: string,
		lastLines = "",
	): void {
		const conv = this.convs.get(conversationId);
		if (!conv || this.disposed) return;
		if (!conv.runtime.session.isStreaming) return;
		const seconds = Math.max(1, Math.round(idleMs / 1000));
		void conv.runtime.session
			.sendUserMessage(
				`（系统自动提醒：你启动的终端「${title}」（id=${terminalId}）已连续 ${seconds} 秒没有任何新输出。` +
					`进程可能在等待输入、卡住或已挂起。\n最近输出：\n${lastLines || "（无输出）"}\n` +
					`请用 terminal_read(terminalId="${terminalId}") 查看/搜索它的当前状态；` +
					`若在等交互就用 terminal_input / terminal_key 回应；确认不再需要就 terminal_close 关掉它。）`,
			)
			.catch(() => {
				// best effort —— 注入失败不影响终端本身
			});
	}

	/**
	 * 终端接管的 bash 静默转后台后的完成通知：命令真正结束时主动告诉 AI。
	 * 流式中 → sendUserMessage（steer，立即唤醒处理）；空闲时 → sendCustomMessage
	 * nextTurn 排队（不唤醒 agent、不耗 token，下次对话自动带上）。
	 */
	private notifyTerminalBashDone(
		terminals: TerminalManager,
		info: { terminalId: string; command: string; exitCode: number | null },
	): void {
		const conv = [...this.convs.values()].find((c) => c.terminals === terminals);
		if (!conv || this.disposed) return;
		let tail = "";
		try {
			const end = terminals.endCursor(info.terminalId);
			if (end !== null) {
				tail = terminals.read(info.terminalId, Math.max(0, end - 4000))?.data ?? "";
			}
		} catch {
			// 终端可能已被关闭
		}
		const exitText = info.exitCode === null ? "终端已关闭" : `退出码 ${info.exitCode}`;
		const cmdShort = info.command.length > 120 ? `${info.command.slice(0, 120)}…` : info.command;
		const text =
			`（系统：你之前在终端 ${info.terminalId} 后台运行的命令已结束（${exitText}）：${cmdShort}\n` +
			`最后输出：\n${stripAnsi(tail).trim() || "（无输出）"}）`;
		const session = conv.runtime.session;
		if (session.isStreaming) {
			void session.sendUserMessage(text).catch(() => {});
		} else {
			// 空闲时不唤醒 agent——排队为 nextTurn 上下文，下次对话自动可见。
			void session
				.sendCustomMessage({
					customType: "terminal-bash-done",
					content: [{ type: "text", text }],
					display: true,
				})
				.catch(() => {});
		}
	}

	private emitTerminal(conversationId: string, msg: ServerMessage): void {
		// Background conversations keep collecting output in their own PTY buffer.
		// Do not stream it into the active xterm; push the retained window on switch.
		if (msg.type === "terminal_output" && conversationId !== this.activeId) return;
		if (msg.type === "terminal_output" || msg.type === "terminal_exit" || msg.type === "terminal_list") {
			this.emit({ ...msg, conversationId } as ServerMessage);
			return;
		}
		this.emit(msg);
	}

	private pushTerminals(conversation = this.conv): void {
		this.emit({
			type: "terminal_list",
			conversationId: conversation.id,
			terminals: conversation.terminals.list(),
		});
		for (const output of conversation.terminals.replay()) {
			this.emit({
				type: "terminal_output",
				conversationId: conversation.id,
				terminalId: output.terminalId,
				data: output.data,
			});
		}
	}

	/**
	 * Vision-bridge transcript cache (batch hash → text). A re-sent / re-asked
	 * prompt with the same images skips the vision API call entirely — editing
	 * a question doesn't re-burn tokens on re-transcribing identical screenshots.
	 */

	/** Most recent built-in (default) system prompt observed by the
	 *  resource-loader override — surfaced via settings_state so the
	 *  replace-mode editor can show the prompt it would otherwise replace.
	 *  Only non-empty when the user has a system-prompt file. */
	private lastBaseSystemPrompt = "";

	/** The system prompt the replace-mode editor should show as its seed:
	 *  the user's system-prompt file content if one exists, otherwise the
	 *  SDK's built-in default actually in effect (agent.state.systemPrompt,
	 *  which the loader rebuilds at session init). If the user HAS a custom
	 *  prompt the seed is only cosmetic — an unmodified seed is saved as
	 *  empty and the server falls back to the true base. */
	private effectiveDefaultSystemPrompt(): string {
		if (this.lastBaseSystemPrompt) return this.lastBaseSystemPrompt;
		try {
			const sp = this.session.agent.state.systemPrompt;
			if (typeof sp === "string" && sp) return sp;
		} catch {
			// Session not ready yet.
		}
		return "";
	}

	/** The FULL system prompt actually in effect right now (AgentSession getter,
	 *  includes the append/replace override + auto-appended sections like
	 *  project context, skills and tool guidance). Read-only view source for
	 *  the settings panel. */
	private effectiveSystemPrompt(): string {
		try {
			const sp = this.session.systemPrompt;
			return typeof sp === "string" ? sp : "";
		} catch {
			// Session not ready yet.
			return "";
		}
	}

	/** Web-facing extension UI context (widgets, notifications). */
	private webUi = new WebUIContext((msg) => this.emit(msg));
	private widgetsTimer: ReturnType<typeof setInterval> | null = null;
	/** Model-stall watchdog interval (see startStallTimer). */
	private stallTimer: ReturnType<typeof setInterval> | null = null;

	/** Connected sockets for this client (multiple tabs share the session). */
	private sinks = new Set<(msg: ServerMessage) => void>();
	private pendingNotices: ServerMessage[] = [];
	private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
	/** Timestamp of the most recent message_delta push — while fresh, snapshots
	 *  use the slower STREAMING_SNAPSHOT_INTERVAL_MS cadence. */
	private lastDeltaAt = 0;
	private sessionsTimer: ReturnType<typeof setTimeout> | null = null;
	private version = 0;
	/** Snapshot revision counter (see emitSnapshotNow / protocol snapshot_delta). */
	private snapRev = 0;
	/** Messages array as of the last emitted snapshot/delta — identity-walked
	 *  against the current array to detect append-only growth. */
	private emittedMessages: UiMessage[] | null = null;
	/** Conversation whose messages emittedMessages belongs to. A conversation
	 *  switch (set_cwd / new_chat / switch_*) must fall back to a FULL snapshot:
	 *  two empty conversations have identical (empty) arrays, so the identity
	 *  walk alone would misread the switch as "nothing changed" → delta. */
	private emittedConvId: string | null = null;
	/** snapRev value at which emittedMessages was captured. */
	private emittedRev = 0;
	/**
	 * Per-conversation serialization caches (stable message ids, UiMessage
	 * object cache, message-array signature, queue counts) live inside each
	 * Conversation — see Conversation above.
	 */
	private disposed = false;
	/** pi-config readiness check, cached briefly so 60ms snapshots don't hit disk. */
	private piCheckCache: { at: number; configured: boolean } | null = null;

	/** fs.watch on the currently-listed directory — file changes push an instant
	 *  refresh (`file_changed`) so the tree updates without waiting for the 10s
	 *  poll. Only the listed directory is watched (one level); navigating
	 *  re-watches the new target. fs.watch isn't available on every platform /
	 *  filesystem — failures silently fall back to the poll. */
	private fsWatcher: ReturnType<typeof watch> | null = null;
	private watchPath: string | null = null;
	/** fs.watch on the active repo's git dir — external changes (CLI commit,
	 *  IDE branch switch) push `scm_changed` so the panel refreshes itself.
	 *  One watcher per client session, re-targeted when the queried cwd
	 *  changes; failures (bare repo, unsupported fs) silently disable it. */
	private gitWatcher: ReturnType<typeof watch> | null = null;
	private gitWatchCwd: string | null = null;
	private gitDirtyTimer: ReturnType<typeof setTimeout> | null = null;
	private watchTimer: ReturnType<typeof setTimeout> | null = null;

	private constructor(clientId: string, cwd: string, agentDir: string, stateStore: ClientStateStore) {
		this.clientId = clientId;
		this.cwd = cwd;
		this.agentDir = agentDir;
		this.stateStore = stateStore;
		this.settingsSvc = new SettingsService({
			clientId,
			stateStore,
			emit: (msg) => this.emit(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			getSession: () => this.session,
			cwd: () => this.cwd,
			agentDir: () => this.agentDir,
			isStreaming: () => this.session.isStreaming,
			reloadSession: async () => {
				await this.session.reload();
				// reload() 会把 custom 工具重新加回活跃集——重放终端开关。
				this.applyTerminalToolGating(this.session);
				await this.pushSlashCommands();
			},
			effectiveDefaultSystemPrompt: () => this.effectiveDefaultSystemPrompt(),
			effectiveSystemPrompt: () => this.effectiveSystemPrompt(),
		});
		this.goalSvc = new GoalService({
			clientId,
			agentDir,
			stateStore,
			webUi: this.webUi,
			emit: (msg) => this.emit(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			quiesceBlocked: () => this.quiesceBlocked(),
			activeConvId: () => this.activeId,
			activeConv: () => this.conv,
			getConv: (id) => this.convs.get(id),
			cwd: () => this.cwd,
			reviewSettings: () => this.settingsSvc.reviewPrefs,
			gitDiff: (dir) => this.gitDiff(dir),
		});

		this.modelAdmin = new ModelAdminService({
			agentDir,
			emit: (msg) => this.emit(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			modelRuntime: () => this.runtime.services.modelRuntime,
			invalidatePiConfig: () => {
				this.piCheckCache = null;
			},
			pushModels: async () => this.listModels(),
		});
		// Prune dead background tasks every 30s (only spawns netstat/lsof while
		// the list is non-empty). unref: must not keep the process alive.
		this.bg.start();
	}

	static async create(clientId: string, cwd: string, stateStore: ClientStateStore): Promise<ClientSession> {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();

		const cs = new ClientSession(clientId, cwd, agentDir, stateStore);
		const conversationId = cs.nextConversationId();
		const terminals = cs.makeTerminalManager(conversationId, cwd);
		const runtime = await createAgentSessionRuntime(cs.makeRuntimeFactory(terminals), {
			cwd,
			agentDir,
			// Resume the most recent session for this project — the SDK default
			// per-project dir (<agentDir>/sessions/--<cwd>--/, shared with the
			// pi CLI/TUI) — or start a fresh one on first visit.
			sessionManager: SessionManager.continueRecent(cwd),
		});
		// First conversation = the resumed session; it also seeds the shared
		// ModelRuntime that every later conversation reuses.
		cs.sharedModelRuntime = runtime.services.modelRuntime;
		const conv = cs.makeConversation(runtime, conversationId, terminals);
		cs.convs.set(conv.id, conv);
		cs.activeId = conv.id;
		for (const d of runtime.diagnostics) {
			if (d.type !== "info") {
				cs.pendingNotices.push({
					type: "notice",
					level: d.type,
					text: d.message,
				});
			}
		}
		await cs.bindSession();
		await cs.restoreProjectProviderKeysForCwd(cwd);
		await cs.restoreProjectModelForCwd(cwd);
		return cs;
	}

	/**
	 * Factory for cwd-bound runtimes. All conversations share ONE ModelRuntime
	 * (the model choice is client-wide), so later conversations reuse the
	 * instance created with the first one.
	 */
	private makeRuntimeFactory(terminals: TerminalManager): CreateAgentSessionRuntimeFactory {
		return async ({ cwd: effectiveCwd, sessionManager }) => {
			const services = await createAgentSessionServices({
				cwd: effectiveCwd,
				modelRuntime: this.sharedModelRuntime,
				// 设置面板钩子（官方 SDK 的 resourceLoader overrides）：三个 override
				// 在每次 resourceLoader.reload() 时重放，且读取 this.settings 的当前
				// 值——因此 session.reload() 即可让系统提示词 / 技能 / 插件开关生效，
				// 新对话（新 runtime）也会自动带上当前设置。
				resourceLoaderOptions: {
					// 系统提示词：replace 模式整体替换；append 模式追加到提示词末尾。
					systemPromptOverride: (base?: string) => {
						// Remember the built-in default so the settings panel can show
						// it when the user edits in replace mode.
						if (typeof base === "string" && base) {
							this.lastBaseSystemPrompt = base;
						}
						return this.settingsSvc.current.promptMode === "replace" &&
							this.settingsSvc.current.customSystemPrompt.trim()
							? this.settingsSvc.current.customSystemPrompt
							: base;
					},
					appendSystemPromptOverride: (base: string[]) => {
						const out = [...base];
						const custom = this.settingsSvc.current.customSystemPrompt.trim();
						if (this.settingsSvc.current.promptMode === "append" && custom) {
							out.push(custom);
						}
						if (process.platform === "win32") {
							// Windows 专属 persona：bash 工具跑 Git Bash 且无默认超时、终端
							// 是交互式 TTY——注入约束避免 heredoc/交互/长驻命令挂死整个会话；
							// GBK 老中文文件让模型改用终端按正确编码读（iconv/chcp/Get-Content）。
							out.push(WINDOWS_PERSONA);
						}
						if (this.settingsSvc.current.terminalToolsEnabled !== false) {
							// 终端工具使用引导（全平台）：告诉模型什么场景该用持久终端
							// 而不是一次性 bash——没有这段模型几乎从不主动选终端工具。
							out.push(TERMINAL_TOOLS_GUIDANCE);
						}
						// bash 工具输出限制/过滤管道引导：模型习惯套 `| tail/-n`、`| head`、
						// `| grep` 等限输出。这些管道会缓冲（终端全程哑火）、把退出码错报成
						// 管道末尾命令（tail 恒 0、grep 无命中 1）、长驻/出错命令挂到超时。
						// 让模型改用 bash 的 tail 参数，长驻/交互改走持久终端。
						out.push(PIPELESS_BASH_GUIDANCE);
						return out;
					},
					// 技能开关：禁用的技能从系统提示词和 /skill: 目录中剔除。
					skillsOverride: (res) => ({
						...res,
						skills: res.skills.filter((s) => !this.settingsSvc.current.disabledSkills.includes(s.name)),
					}),
					// 插件开关：禁用的扩展整个卸载（工具 / 命令随之消失）。
					// 注意 SDK 在 extensionsOverride 之后才补 sourceInfo，包扩展此处只能靠路径
					// 匹配 —— isExtensionDisabled 同时比对 npm:<pkg> 候选键。
					extensionsOverride: (res) => ({
						...res,
						extensions: res.extensions.filter(
							(e) => !isExtensionDisabled(e, this.settingsSvc.current.disabledExtensions),
						),
					}),
				},
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				// 覆盖 SDK 内置 bash（customTools 按 name 覆盖）。双实现分流：
				// 「默认 bash 覆盖」开关（terminalBash）关 → 原生 SDK bash（纯进程、不开终端）；
				// 开 → 终端接管 bash（persist 决定一次性/持久，可静默自动转后台）。
				customTools: [
					makeAdaptiveBashTool(
						makeKillableBashTool(effectiveCwd, this.bashKills),
						makeTerminalBashTool(terminals, {
							cwd: effectiveCwd,
							// 设置开 = 用终端；此分支里 persist 未显式给时默认一次性（false）。
							defaultPersist: () => false,
							idleMs: () => Math.max(0, Math.floor(this.settingsSvc.current.terminalBashIdleMs) || 0),
							kills: this.bashKills,
							notifyBackgroundDone: (info) => this.notifyTerminalBashDone(terminals, info),
						}),
						// 设置关 → 原生 bash；开 → 终端 bash。
						() => this.settingsSvc.current.terminalBash,
					),
					...makePersistentTerminalTools(terminals, effectiveCwd),
					// 插件注册的 AI 工具（创建时刻的实时快照；后续注册经
					// refreshPluginTools 动态补入已有会话）。
					...(this.pluginToolsProvider?.() ?? []).map(pluginToolToDefinition),
				],
			});
			// 终端工具开关从创建起就生效（工具始终注册进注册表，只调活跃集）。
			this.applyTerminalToolGating(created.session);
			return {
				...created,
				services,
				diagnostics: services.diagnostics,
			};
		};
	}

	/** Create independent goal state for one conversation. Preferences are
	 * client-wide defaults, while goal text/review progress is not shared. */
	private makeGoalStatus(): GoalStatus {
		return this.goalSvc.makeGoalStatus();
	}

	/** Allocate a stable conversation id before constructing its runtime/tools. */
	private nextConversationId(): string {
		return `c${++this.convSeq}`;
	}

	/** Wrap a fresh runtime as a new conversation record. */
	private makeConversation(runtime: AgentSessionRuntime, id: string, terminals: TerminalManager): Conversation {
		return {
			id,
			title: conversationTitle(runtime.session),
			runtime,
			session: runtime.session,
			cwd: runtime.cwd,
			createdAt: Date.now(),
			// A brand-new conversation is not yet in the running list — it enters
			// only when it is displaced to the background while still streaming.
			listed: false,
			promptedSinceActive: false,
			lastActiveAt: Date.now(),
			lastSdkEventAt: Date.now(),
			stallNoticed: false,
			goal: this.makeGoalStatus(),
			goalGeneration: 0,
			goalReviewGeneration: 0,
			wizardRunning: false,
			deltaSeq: 0,
			terminals,
			msgIds: new Map(),
			nextMsgId: 1,
			userSeqByTs: new Map(),
			uiMessageCache: new Map(),
			lastMessagesSig: "",
			lastMessagesArray: [],
			queueSteering: [],
			queueFollowUp: [],
			toolStartTimes: new Map(),
			toolWatchdogs: new Map(),
		};
	}

	/** Summaries of conversations currently streaming — captured at shutdown
	 *  so the next attach can tell the user their run was interrupted. */
	streamingSummaries(): { title: string; cwd: string }[] {
		const out: { title: string; cwd: string }[] = [];
		for (const conv of this.convs.values()) {
			if (conv.session.isStreaming) out.push({ title: conv.title, cwd: conv.cwd });
		}
		return out;
	}

	/** Tell the user about runs lost to the last server restart (once). */
	notifyInterrupted(list: { title: string; cwd: string; at: number }[] | undefined): void {
		if (!list || list.length === 0) return;
		const names = list.map((r) => `「${r.title}」（${r.cwd}）`).join("、");
		this.pendingNotices.push({
			type: "notice",
			level: "warning",
			text: `上次服务重启时有 ${list.length} 个进行中的对话被中断：${names}。可在历史对话中恢复继续。`,
			textEn: `${list.length} running conversation(s) were interrupted by the last restart: ${names}. Resume them from History.`,
		});
	}

	/** Add a socket to this client's broadcast set; flushes buffered startup notices. */
	attachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.add(send);
		for (const msg of this.pendingNotices) send(msg);
		this.pendingNotices = [];
		// Replay current extension widgets (setWidget may have fired during
		// session creation, before any socket was attached).
		const widgets = this.webUi.snapshot();
		if (widgets.length > 0) send({ type: "widgets", widgets });
		const statuses = this.webUi.statusSnapshot();
		if (statuses.length > 0) send({ type: "statuses", statuses });
		// Reconnect: push the current project's running-conversation list so the
		// left panel shows every background chat (a fresh socket never got the
		// newChat/switch pushes).
		this.emitConversations();
		// Reconnect: same for the slash-command catalog (the picker needs it even
		// before the client asks).
		void this.pushSlashCommands();
		// Reconnect: push the remembered goal prefs (model choice, rounds cap,
		// locked) so the goal bar restores them on reload — "全局记忆".
		this.goalSvc.emitGoalStatus();
		// Reconnect: push the settings panel state (prompt text/mode, skill &
		// extension toggles, saved presets).
		this.pushSettings();
		// Reconnect: push the background-task list — it must survive reconnects
		// and outlive the conversation that started the tasks.
		this.bg.push();
		// Reconnect: push the built-in provider key list (multi-key grouping in the
		// model picker needs it even before the client asks).
		this.modelAdmin.listProviderKeys();
		// PTYs are conversation-owned and survive a socket reconnect.
		this.pushTerminals();
	}

	detachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.delete(send);
		// PTYs intentionally survive a socket drop: they are owned by the
		// conversation and can be inspected after reconnecting. Only conversation
		// disposal or server shutdown kills them.
		if (this.sinks.size === 0) {
			this.files.unwatchDir();
		}
	}

	/** Broadcast to every connected socket of this client. */
	private emit(msg: ServerMessage): void {
		if (this.disposed) return;
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const sink of [...this.sinks]) sink(msg);
	}

	/** (Re)attach event plumbing to the ACTIVE conversation's session. */
	private async bindSession(): Promise<void> {
		const conv = this.conv;
		conv.unsubscribe?.();
		conv.session = conv.runtime.session;
		await conv.session.bindExtensions({
			mode: "rpc",
			uiContext: this.webUi,
			onError: (err) => {
				this.emit({ type: "notice", level: "error", text: err.error });
			},
		});
		conv.unsubscribe = conv.session.subscribe((event) => this.onEvent(conv, event));
		this.scheduleSnapshot();
		this.webUi.refresh();
		this.startWidgetsTimer();
		this.startStallTimer();
	}

	/** Poll extension widgets so TUI-only overlays (e.g. rpiv-todo) stay live. */
	private startWidgetsTimer(): void {
		if (this.widgetsTimer) return;
		this.widgetsTimer = setInterval(() => {
			if (!this.disposed) this.webUi.refresh();
		}, WIDGET_REFRESH_MS);
	}

	/** Model-stall watchdog: warn when a streaming run went completely silent
	 *  (no SDK events at all) for STALL_NOTIFY_MS. Deliberately does NOT abort:
	 *  deep-thinking models can legitimately be quiet for minutes — the notice
	 *  just tells the user the run looks stuck so they can Stop it themselves. */
	private startStallTimer(): void {
		if (this.stallTimer || STALL_NOTIFY_MS === 0) return;
		this.stallTimer = setInterval(() => {
			if (this.disposed) return;
			const now = Date.now();
			for (const conv of this.convs.values()) {
				if (!conv.stallNoticed && conv.session.isStreaming && now - conv.lastSdkEventAt > STALL_NOTIFY_MS) {
					conv.stallNoticed = true;
					const mins = Math.round((now - conv.lastSdkEventAt) / 60_000);
					this.emit({
						type: "notice",
						level: "warning",
						text: `对话「${conv.title}」已 ${mins} 分钟无任何响应，可能已失联（网络中断或服务端挂起）。可点击停止后重试。`,
						textEn: `Conversation "${conv.title}" has been silent for ${mins} min — possibly disconnected (network or hung server). Stop it and retry.`,
					});
				}
			}
		}, 30_000);
	}

	/** Arm the hang-guard for a tool call: if it is still running after
	 *  TOOL_WATCHDOG_TIMEOUT_MS, abort the session instead of letting the
	 *  conversation hang forever (the SDK bash tool has no default timeout). */
	private armToolWatchdog(conv: Conversation, toolCallId: string): void {
		const t = setTimeout(() => {
			conv.toolWatchdogs.delete(toolCallId);
			// The tool finished before the deadline — nothing to do.
			if (!conv.toolStartTimes.has(toolCallId)) return;
			this.emit({
				type: "notice",
				level: "warning",
				text: `工具执行超过 ${Math.round(TOOL_WATCHDOG_TIMEOUT_MS / 60_000)} 分钟，已自动终止（防止挂死）。可调整超时：环境变量 PI_WEB_TOOL_TIMEOUT_MS（毫秒）。`,
				textEn: `Tool ran over ${Math.round(TOOL_WATCHDOG_TIMEOUT_MS / 60_000)} min and was auto-terminated (hang guard). Tune via PI_WEB_TOOL_TIMEOUT_MS (ms).`,
			});
			conv.toolStartTimes.delete(toolCallId);
			// Abort the run (kills the process tree via the SDK's abort signal);
			// agent_end will fire with stopReason "aborted" and existing logic
			// clears any goal / review loop. interruptRun adds a force-reset
			// fallback in case the model stream ignores the abort signal.
			void this.interruptRun(conv, "工具执行超时");
		}, TOOL_WATCHDOG_TIMEOUT_MS);
		t.unref?.();
		conv.toolWatchdogs.set(toolCallId, t);
	}

	/** Cancel a tool's watchdog — called when the tool finishes normally. */
	private clearToolWatchdog(conv: Conversation, toolCallId: string): void {
		const t = conv.toolWatchdogs.get(toolCallId);
		if (t) {
			clearTimeout(t);
			conv.toolWatchdogs.delete(toolCallId);
		}
	}

	/** Cancel every watchdog of a conversation (removeConversation / dispose). */
	private clearAllToolWatchdogs(conv: Conversation): void {
		for (const t of conv.toolWatchdogs.values()) clearTimeout(t);
		conv.toolWatchdogs.clear();
	}

	private onEvent(conv: Conversation, event: AgentSessionEvent): void {
		// Any SDK event proves the run is alive — feeds the stall watchdog below.
		conv.lastSdkEventAt = Date.now();
		conv.stallNoticed = false;
		switch (event.type) {
			case "bash_execution_update": {
				if (event.id) {
					this.emit({
						type: "tool_delta",
						conversationId: conv.id,
						seq: ++conv.deltaSeq,
						toolCallId: event.id,
						toolName: "bash",
						delta: event.delta,
					});
				}
				break;
			}
			case "tool_execution_start": {
				// Record the moment the tool actually starts so tool_status can
				// report real execution time (vs. time spent waiting on the model).
				conv.toolStartTimes.set(event.toolCallId, Date.now());
				// Snapshot listeners before a bash run — the post-run diff catches
				// servers the agent started in the background.
				if (event.toolName === "bash") {
					this.bg.snapshotBefore();
				}
				this.armToolWatchdog(conv, event.toolCallId);
				// 插件扩展点：工具开始执行（异常由 emitToolEvent 隔离）。
				this.onToolEvent?.({ phase: "start", toolName: event.toolName, conversationId: conv.id });
				break;
			}
			case "tool_execution_end": {
				const startedAt = conv.toolStartTimes.get(event.toolCallId);
				conv.toolStartTimes.delete(event.toolCallId);
				this.clearToolWatchdog(conv, event.toolCallId);
				// Bash finished — wait briefly for background servers to bind their
				// ports, then diff against the pre-run snapshot and record them.
				if (event.toolName === "bash") void this.bg.trackAfterBash();
				const durationMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
				// 插件扩展点：工具结束执行（带耗时与错误标志）。
				this.onToolEvent?.({
					phase: "end",
					toolName: event.toolName,
					conversationId: conv.id,
					...(durationMs !== undefined ? { durationMs } : {}),
					isError: event.isError,
				});
				// The bash tool does not put its exit code in result.details — on
				// failure it throws "Command exited with code N" and the agent
				// wraps that into the error result text. Try details first (future
				// tools / SDK changes), then parse the error text.
				const details = (event.result as { details?: unknown })?.details;
				let exitCode: number | undefined;
				if (
					typeof details === "object" &&
					details !== null &&
					typeof (details as { exitCode?: unknown }).exitCode === "number"
				) {
					exitCode = (details as { exitCode: number }).exitCode;
				} else if (event.isError) {
					const content = (event.result as { content?: unknown })?.content;
					const text = Array.isArray(content)
						? content
								.map((c) =>
									typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text"
										? ((c as { text?: unknown }).text ?? "")
										: "",
								)
								.join("\n")
						: "";
					const m = text.match(/exited with code (\d+)/);
					if (m) exitCode = Number(m[1]);
				}
				this.emit({
					type: "tool_status",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
					exitCode,
					durationMs,
				});
				break;
			}
			case "tool_execution_update": {
				const text = extractPartialText(event.partialResult);
				if (text) {
					this.emit({
						type: "tool_delta",
						conversationId: conv.id,
						seq: ++conv.deltaSeq,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						delta: text,
					});
				}
				break;
			}
			case "queue_update":
				conv.queueSteering = [...event.steering];
				conv.queueFollowUp = [...event.followUp];
				break;
			// 手动 /compact 或阈值/溢出自动压缩开始——立即反馈，避免「没反应」
			// （此前 compaction_start/end 事件被 switch 静默丢弃，issue #33）。
			case "compaction_start": {
				this.emit({
					type: "notice",
					level: "info",
					text: "正在压缩上下文…（压缩摘要将显示在消息区）",
					textEn: "Compacting context… (the summary will appear in the message list)",
				});
				break;
			}
			case "compaction_end": {
				if (event.errorMessage) {
					this.emit({
						type: "notice",
						level: "error",
						text: `压缩上下文失败：${event.errorMessage}`,
						textEn: `Context compaction failed: ${event.errorMessage}`,
					});
				} else if (event.aborted) {
					this.emit({
						type: "notice",
						level: "warning",
						text: "压缩上下文已取消",
						textEn: "Context compaction cancelled",
					});
				} else if (event.result) {
					const { tokensBefore, estimatedTokensAfter } = event.result;
					const after = estimatedTokensAfter ?? tokensBefore;
					this.emit({
						type: "notice",
						level: "info",
						text: `上下文压缩完成：${tokensBefore.toLocaleString()} → ${after.toLocaleString()} tokens（摘要已插入消息区）`,
						textEn: `Context compacted: ${tokensBefore.toLocaleString()} → ${after.toLocaleString()} tokens (summary inserted into the message list)`,
					});
				}
				break;
			}
			// A run finished or a new entry was persisted — keep the session list fresh
			// (new chat + first message, completed turns, compaction, etc.).
			case "agent_end": {
				this.scheduleSessionsRefresh();
				this.refreshConversationTitle(conv);
				// Manual interrupt (Stop button / abort): the last assistant message
				// carries stopReason "aborted". A half-finished run should NOT be
				// reviewed (it would fail and inject a revision, only to be stopped
				// again → an endless review loop). Clear the goal so the review loop
				// stops too, then let the user give a fresh instruction.
				const aborted = (event.messages as unknown[]).some((m) => {
					const a = m as { role?: string; stopReason?: string };
					return a.role === "assistant" && a.stopReason === "aborted";
				});
				if (aborted) {
					const stopNotice = this.goalSvc.onAgentEnd(conv, true);
					if (stopNotice) {
						this.emit({ type: "notice", level: "warning", text: stopNotice });
					}
					break;
				}
				// Goal review hook lives in GoalService.onAgentEnd(conv, false).
				this.goalSvc.onAgentEnd(conv, false);
				// Deferred settings reload: settings (system prompt / skills /
				// extensions) changed while the run was streaming — applying now
				// would have torn down the in-flight run.
				if (this.settingsSvc.hasPendingReload() && !this.disposed) {
					this.settingsSvc.consumePendingReload();
					void this.applySettingsReload();
				}
				break;
			}
			case "entry_appended":
				this.scheduleSessionsRefresh();
				this.refreshConversationTitle(conv);
				break;
			case "message_update": {
				// Live assistant-message increment, deliberately OUTSIDE the snapshot
				// channel: send() drops snapshots under backpressure (big sessions),
				// but this small message must always get through or the UI freezes on
				// stale state. Only the ACTIVE conversation streams to the browser —
				// background conversations would clobber the streaming view; their
				// state arrives via snapshot when switched to.
				if (conv.id !== this.conv.id) break;
				const ame = event.assistantMessageEvent;
				const m = event.message as { timestamp?: number };
				this.lastDeltaAt = Date.now();
				this.emit({
					type: "message_delta",
					conversationId: conv.id,
					seq: ++conv.deltaSeq,
					// Must match serializeStreamingMessage()'s stable id so deltas
					// patch onto the snapshot's streamingMessage and reconcile.
					messageId: `stream-${m?.timestamp ?? 0}`,
					usage: (() => {
						try {
							const t = this.session.getSessionStats().tokens;
							return t ? { input: t.input, output: t.output, total: t.total } : null;
						} catch {
							return null;
						}
					})(),
					// Strip `partial` (the cumulative message): re-serializing it per
					// token is exactly what we're trying to avoid. The next snapshot
					// carries the authoritative full message anyway.
					assistantMessageEvent: {
						type: ame.type,
						contentIndex: "contentIndex" in ame ? ame.contentIndex : undefined,
						delta: "delta" in ame ? ame.delta : undefined,
					},
				});
				break;
			}
			default:
				break;
		}
		// Snapshot checkpoint policy: deltas carry live rendering during streaming;
		// full snapshots are reconciliation checkpoints taken immediately at
		// run/tool boundaries and on a slow timer otherwise.
		if (event.type === "agent_end" || event.type === "tool_execution_end" || event.type === "compaction_end") {
			this.flushSnapshot();
		} else {
			this.scheduleSnapshot();
		}
	}

	/** Debounced push of the persisted session list + open conversations. */
	private scheduleSessionsRefresh(): void {
		if (this.sessionsTimer) return;
		this.sessionsTimer = setTimeout(() => {
			this.sessionsTimer = null;
			if (this.disposed) return;
			this.emitConversations();
			void this.pushSessions();
		}, 800);
		// pushSessions no-ops unless the client opted in via list_sessions.
	}

	/** Refresh a conversation's title from its persisted first user message
	 *  while it is still unnamed. Runs off the event stream (entry_appended /
	 *  agent_end) rather than the prompt() call site, so ANY entry path that
	 *  lands a message names the chat the moment it is persisted — a rename
	 *  skipped by the prompt-start fast path (e.g. a concurrent switch) is
	 *  recovered here instead of leaving a permanent “新对话”. */
	private refreshConversationTitle(conv: Conversation): void {
		if (conv.title !== DEFAULT_CONV_TITLE) return;
		const title = conversationTitle(conv.session);
		if (title === DEFAULT_CONV_TITLE) return;
		conv.title = title;
		this.emitConversations();
	}

	/** Serialize a persisted message with a STABLE id + cached object reference. */
	private serializeCached(m: AgentMessage): UiMessage | null {
		const conv = this.conv;
		// toolResult messages are keyed by toolCallId; everything else by
		// role+timestamp. A single prompt can emit several same-role messages
		// within the SAME millisecond (multiple attachment asides), so the
		// timestamp alone collides in the cache and only the first one renders
		// — append a cheap content fingerprint to keep them distinct while
		// staying stable across snapshots (content never changes once persisted).
		const key = m.role === "toolResult" ? `t:${m.toolCallId}` : `${m.role}:${m.timestamp}:${contentFingerprint(m)}`;
		let n = conv.msgIds.get(key);
		if (n === undefined) {
			n = conv.nextMsgId++;
			conv.msgIds.set(key, n);
		}
		const cacheKey = `${key}#${n}`;
		const cached = conv.uiMessageCache.get(cacheKey);
		if (cached) return cached;
		// User-message id suffix is a 1-based count of user messages sharing
		// this timestamp (that's what resolveUserMessageEntryId() expects). n is
		// a global per-conversation counter across ALL roles, so it can't be
		// reused as the seq — otherwise editing anything but the first question
		// fails to resolve ("找不到要编辑的消息").
		let seq = n;
		if (m.role === "user") {
			const ts = m.timestamp ?? 0;
			seq = (conv.userSeqByTs.get(ts) ?? 0) + 1;
			conv.userSeqByTs.set(ts, seq);
		}
		const msg = serializeMessage(m, seq);
		if (msg) {
			conv.uiMessageCache.set(cacheKey, msg);
			// Bound the cache (marathon sessions otherwise grow without limit;
			// single messages can reach TEXT_CAP = 200K chars). Map iteration is
			// insertion order, so dropping from the front evicts the oldest —
			// recent messages (the ones every snapshot touches) always survive.
			// Safe: a miss just recomputes an identical object on next access.
			let excess = conv.uiMessageCache.size - UI_MESSAGE_CACHE_CAP;
			while (excess-- > 0) {
				const oldest = conv.uiMessageCache.keys().next().value;
				if (oldest === undefined) break;
				conv.uiMessageCache.delete(oldest);
			}
		}
		return msg;
	}

	/** Current messages array (with the existing sig-reuse optimization).
	 *  Element objects are reference-stable (serializeCached cache), which is
	 *  what lets emitSnapshotNow detect append-only growth via identity walk. */
	private currentMessages(): UiMessage[] {
		const conv = this.conv;
		const rawMessages = conv.session.agent.state.messages
			.map((m) => this.serializeCached(m))
			.filter((m): m is NonNullable<typeof m> => m !== null);
		// Reuse the previous array when nothing changed: the element objects are
		// cached (reference-stable) anyway, and a stable array reference lets the
		// frontend memoize derived maps instead of rebuilding them every 60ms.
		const sig = rawMessages.map((m) => m.id).join("\u0001");
		const messages = conv.lastMessagesSig === sig ? conv.lastMessagesArray : rawMessages;
		conv.lastMessagesSig = sig;
		conv.lastMessagesArray = rawMessages;
		return messages;
	}

	/** Build every UiState field EXCEPT messages (the expensive part). */
	private buildLightState(rev: number): Omit<UiState, "messages" | "rev"> & { rev: number } {
		const conv = this.conv;
		const state = conv.session.agent.state;
		const model = state.model;
		let stats: UiState["stats"] = {
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			contextUsage: { tokens: null, contextWindow: 0, percent: null },
		};
		try {
			const s = this.session.getSessionStats();
			stats = {
				totalMessages: s.totalMessages,
				tokens: s.tokens,
				cost: s.cost,
				contextUsage: s.contextUsage
					? {
							tokens: s.contextUsage.tokens,
							contextWindow: s.contextUsage.contextWindow,
							percent: s.contextUsage.percent,
						}
					: stats.contextUsage,
			};
		} catch {
			// stats are best-effort
		}
		return {
			clientId: this.clientId,
			cwd: this.cwd,
			sessionId: this.session.sessionId,
			sessionFile: this.session.sessionFile,
			conversationId: this.activeId,
			rev,
			// The in-progress assistant message lives in state.streamingMessage
			// (the SDK only pushes it into state.messages at message_end). Surfacing
			// it here is what makes thinking + text stream into the browser at
			// ~60ms granularity instead of appearing only when the turn finishes.
			streamingMessage: state.streamingMessage ? serializeStreamingMessage(state.streamingMessage) : null,
			isStreaming: this.session.isStreaming,
			model: model
				? {
						id: model.id,
						name: model.name,
						provider: model.provider,
						vision: model.input?.includes("image") ?? false,
					}
				: null,
			thinkingLevel: state.thinkingLevel,
			// Only the levels the current model actually supports — the SDK clamps
			// anything else, so the UI must not offer (or must disable) the rest.
			availableThinkingLevels: this.session.getAvailableThinkingLevels(),
			queue: { steering: conv.queueSteering, followUp: conv.queueFollowUp },
			errorMessage: state.errorMessage,
			tools: state.tools.map((t) => t.name),
			version: ++this.version,
			piConfigured: this.isPiConfigured(),
			piAgentInstalled: this.isPiCliInstalled(),
			stats,
		};
	}

	/** Emit one snapshot update — incremental when possible, full otherwise.
	 *
	 *  Persisted messages are content-immutable with reference-stable objects
	 *  (serializeCached), so an IDENTITY WALK over the previous array detects
	 *  append-only growth in O(n) pointer compares. Appends travel as
	 *  snapshot_delta carrying only the new tail + light fields; any mid-array
	 *  change/truncation (switch session, edit fork, compaction) or a forced
	 *  resync falls back to a full snapshot. The 10MB-stringify-per-checkpoint
	 *  cost of big sessions collapses to a few hundred bytes for the common
	 *  "nothing but stats/version changed" checkpoint. */
	private emitSnapshotNow(forceFull = false): void {
		if (this.disposed) return;
		const cur = this.currentMessages();
		const prev = this.emittedMessages;
		let incremental = !forceFull && prev !== null && this.emittedConvId === this.activeId && prev.length <= cur.length;
		if (incremental && prev) {
			for (let i = 0; i < prev.length; i++) {
				if (prev[i] !== cur[i]) {
					incremental = false;
					break;
				}
			}
		}
		const rev = ++this.snapRev;
		if (incremental && prev) {
			const baseRev = this.emittedRev;
			this.emittedMessages = cur;
			this.emittedConvId = this.activeId;
			this.emittedRev = rev;
			this.emit({
				type: "snapshot_delta",
				conversationId: this.activeId,
				rev,
				baseRev,
				appended: cur.slice(prev.length),
				state: this.buildLightState(rev),
			});
		} else {
			this.emittedMessages = cur;
			this.emittedConvId = this.activeId;
			this.emittedRev = rev;
			this.emit({
				type: "snapshot",
				state: { ...this.buildLightState(rev), messages: cur },
			});
		}
	}

	/** Resolve a browser-bridged dialog (select/confirm/input) for this session. */
	resolveDialog(id: number, value: string | boolean | null): void {
		this.webUi.resolveDialog(id, value);
	}

	/**
	 * Whether the pi agent has at least one usable model. ModelRuntime's
	 * available snapshot already accounts for models.json, auth.json, env-var
	 * credentials, OAuth, and runtime API-key overrides. Cached for 2s because
	 * this is called while building frequent snapshots.
	 */
	isPiConfigured(): boolean {
		const now = Date.now();
		const cached = this.piCheckCache;
		if (cached && now - cached.at < 2000) return cached.configured;
		const configured = (this.sharedModelRuntime?.getAvailableSnapshot().length ?? 0) > 0;
		this.piCheckCache = { at: now, configured };
		return configured;
	}

	/**
	 * Whether the pi CLI binary is installed and runnable (`pi --version`
	 * probe). Cached machine-wide (same binary for every client) for 10s —
	 * the check is only rerun after install or when the cache expires.
	 */
	private static piCliProbe: { at: number; installed: boolean } | null = null;
	private static readonly PI_CLI_PROBE_TTL_MS = 10_000;

	private isPiCliInstalled(): boolean {
		const now = Date.now();
		const cached = ClientSession.piCliProbe;
		if (cached && now - cached.at < ClientSession.PI_CLI_PROBE_TTL_MS) return cached.installed;
		let installed = false;
		try {
			const res = spawnSync("pi", ["--version"], {
				timeout: 5000,
				stdio: "ignore",
				// Windows: `pi` resolves to a pi.cmd shim — spawnSync can only
				// exec those through a shell (else ENOENT).
				shell: process.platform === "win32",
			});
			installed = !res.error && res.status === 0;
		} catch {
			installed = false;
		}
		ClientSession.piCliProbe = { at: now, installed };
		return installed;
	}

	private static invalidatePiCliProbe(): void {
		ClientSession.piCliProbe = null;
	}

	/**
	 * Run a command async, collecting stdout+stderr; kills on timeout.
	 * Never throws / never crashes the server: spawn errors (ENOENT etc.)
	 * resolve with code -1 so callers can report them as notices.
	 */
	private runAsync(
		cmd: string,
		args: string[],
		timeoutMs: number,
		cwd?: string,
	): Promise<{ code: number | null; out: string }> {
		return new Promise((resolve) => {
			let p;
			try {
				p = spawn(cmd, args, {
					...(cwd ? { cwd } : {}),
					stdio: ["ignore", "pipe", "pipe"],
					// Windows: npm and friends are .cmd shims — Node can only exec
					// them through the shell (otherwise spawn npm → ENOENT).
					shell: process.platform === "win32",
				});
			} catch (err) {
				resolve({ code: -1, out: String(err) });
				return;
			}
			let out = "";
			let settled = false;
			const done = (code: number | null, text?: string) => {
				if (settled) return;
				settled = true;
				clearTimeout(t);
				resolve({ code, out: text ?? out });
			};
			const t = setTimeout(() => p.kill(), timeoutMs);
			p.stdout?.on("data", (d: Buffer) => (out += d.toString()));
			p.stderr?.on("data", (d: Buffer) => (out += d.toString()));
			p.on("error", (err) => done(-1, String(err)));
			p.on("close", (code) => done(code));
		});
	}

	/**
	 * Auto-install the pi agent: ensure the config dir exists and install the
	 * pi CLI globally (npm i -g). Auth is configured afterwards via the API key
	 * form or by running `pi` in a terminal.
	 */

	/**
	 * Version of the RUNNING pi-web-ui package (read from its own package.json,
	 * resolved from this compiled module: <pkg>/dist/server → <pkg>).
	 */
	private static currentAppVersion(): string {
		try {
			const here = dirname(fileURLToPath(import.meta.url));
			const pkgRoot = resolve(here, "..", "..");
			const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { version?: string };
			return pkg.version ?? "0.0.0";
		} catch {
			return "0.0.0";
		}
	}

	/** Simple numeric semver compare: >0 means a newer than b. */
	private static compareVersions(a: string, b: string): number {
		return compareSemver(a, b);
	}

	/** Set by index.ts: called when /pi-web-ui:quit is invoked. */
	onQuit: (() => boolean) | undefined = undefined;
	/** 本客户端成功切换工作区（set_cwd）后触发，参数为新绝对路径。
	 *  attach 时由 AgentService 接到全局 onClientCwdChanged —— 编辑器等
	 *  工作区跟随型插件借此把根目录切到用户当前项目。 */
	onCwdChanged: ((abs: string) => void) | undefined = undefined;

	/** Ask the npm registry for the latest pi-web-ui version and report it. */
	async checkUpdate(): Promise<void> {
		const current = ClientSession.currentAppVersion();
		try {
			// Fetch the full package doc (not /latest): it carries the per-version
			// publish timestamps so the UI can hint when a version was JUST
			// published and the registry/CDN caches may not have caught up yet.
			const res = await fetch("https://registry.npmjs.org/pi-web-ui", {
				signal: AbortSignal.timeout(8_000),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as {
				"dist-tags"?: { latest?: string };
				time?: Record<string, string>;
			};
			const latest = data["dist-tags"]?.latest ?? null;
			const latestPublishedAt = latest && data.time ? (data.time[latest] ?? null) : null;
			const upToDate = latest === null || ClientSession.compareVersions(current, latest) >= 0;
			this.emit({
				type: "update_status",
				current,
				latest,
				latestPublishedAt,
				upToDate,
			});
		} catch (err) {
			this.emit({
				type: "update_status",
				current,
				latest: null,
				latestPublishedAt: null,
				upToDate: false,
				error: `检查更新失败：${(err as Error).message}`,
			});
		}
	}

	/** Cache window for the all-source check: 30 minutes. */
	static UPDATE_ALL_CACHE_MS = 30 * 60_000;
	private updatesAllCache: { at: number; items: UpdateItem[] } | null = null;

	/**
	 * All-source update check: pi-web-ui + the pi core + direct pi extensions
	 * from the agent manifest (fallback: raw walk). Re-emits the cached list
	 * within UPDATE_ALL_CACHE_MS; pass force=true (explicit refresh) to bypass.
	 */
	async checkUpdatesAll(force = false): Promise<void> {
		if (!force && this.updatesAllCache && Date.now() - this.updatesAllCache.at < ClientSession.UPDATE_ALL_CACHE_MS) {
			this.emit({
				type: "update_status_all",
				items: this.updatesAllCache.items,
			});
			return;
		}
		try {
			const targets = collectTargets(this.agentDir, ClientSession.currentAppVersion());
			const items = await checkAllUpdates(targets);
			this.updatesAllCache = { at: Date.now(), items };
			this.emit({ type: "update_status_all", items });
		} catch (err) {
			// checkAll degrades per-item; only local enumeration blowing up lands
			// here — still report a usable (webui-only) error item.
			const items: UpdateItem[] = [
				{
					name: "pi-web-ui",
					kind: "webui",
					current: ClientSession.currentAppVersion(),
					latest: null,
					latestPublishedAt: null,
					upToDate: false,
					error: `检查更新失败：${(err as Error).message}`,
				},
			];
			this.emit({ type: "update_status_all", items });
		}
	}

	async installPiAgent(): Promise<void> {
		try {
			mkdirSync(this.agentDir, { recursive: true });
			this.emit({
				type: "notice",
				level: "info",
				text: "正在安装 pi agent CLI（npm i -g @earendil-works/pi-coding-agent）…",
				textEn: "Installing pi agent CLI (npm i -g @earendil-works/pi-coding-agent)…",
			});
			const { code, out } = await this.runAsync("npm", ["i", "-g", "@earendil-works/pi-coding-agent"], 180_000);
			if (code === 0) {
				this.emit({
					type: "notice",
					level: "info",
					text: "✅ pi agent CLI 安装完成。填入 API 密钥即可开始，或在终端运行 pi 完成登录。",
					textEn: "✅ pi agent CLI installed. Enter an API key to start, or run pi in a terminal to log in.",
				});
				this.emit({ type: "install_result", ok: true, detail: "" });
			} else {
				this.emit({
					type: "notice",
					level: "error",
					text: `pi agent 安装失败（${code ?? "timeout"}）：${out.slice(0, 400)}`,
					textEn: `pi agent install failed (${code ?? "timeout"}): ${out.slice(0, 400)}`,
				});
				this.emit({
					type: "install_result",
					ok: false,
					detail: out.slice(0, 600),
				});
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `pi agent 安装失败：${(err as Error).message}`,
				textEn: `pi agent install failed: ${(err as Error).message}`,
			});
		}
		// The CLI may just have landed on PATH (or the install may have failed) —
		// drop the probe cache so the next snapshot re-checks.
		ClientSession.invalidatePiCliProbe();
		this.flushSnapshot();
	}

	/** Send a snapshot immediately (cancels any pending throttled one).
	 *  forceFull skips the incremental path — used by get_state so a (re)
	 *  connecting or desynced client always receives an authoritative full
	 *  state it can rebuild from. */
	flushSnapshot(forceFull = false): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		this.emitSnapshotNow(forceFull);
	}

	private scheduleSnapshot(): void {
		if (this.snapshotTimer || this.disposed) return;
		// During active streaming the deltas carry live rendering — full snapshots
		// are just a periodic reconciliation checkpoint, so send them far less
		// often (they serialize the whole session; big sessions made this path OOM).
		const interval =
			Date.now() - this.lastDeltaAt < DELTA_ACTIVE_WINDOW_MS ? STREAMING_SNAPSHOT_INTERVAL_MS : SNAPSHOT_INTERVAL_MS;
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = null;
			this.emitSnapshotNow();
		}, interval);
	}

	/** Slash-command catalog + native command execution — 自包含模块，见
	 *  slash-commands.ts（内置命令拦截 + 扩展/模板/技能目录推送）。 */
	private readonly slash = new SlashCommandsService({
		emit: (msg) => this.emit(msg),
		cwd: () => this.cwd,
		getSession: () => this.session,
		newChat: () => this.newChat(),
		setModel: (id) => this.setModel(id),
		setCwd: (path) => this.setCwd(path),
		setThinking: (level) => this.setThinking(level),
		refreshSessions: () => this.refreshSessions(),
		afterReload: () => this.applyTerminalToolGating(this.session),
		pluginCommands: () => this.pluginCommandsProvider?.() ?? [],
		execPluginCommand: async (name, args) => {
			const def = this.pluginCommandsProvider?.().find((c) => c.name === name);
			if (!def) return false;
			try {
				const result = await def.run(args, { clientId: this.clientId });
				// 字符串返回值 → 通知条回显给发起人；富展示用 broadcast/sendTo。
				if (typeof result === "string" && result.trim()) {
					this.emit({ type: "notice", level: "info", text: result });
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
		},
		onQuit: () => this.onQuit?.() ?? false,
	});

	/** Catalog push — index.ts get_commands / attach / cwd 切换等都会调用。 */
	pushSlashCommands(): Promise<void> {
		return this.slash.push();
	}

	/** 模型/服务商配置管理 —— 自包含模块，见 model-admin.ts。 */
	private readonly modelAdmin!: ModelAdminService;

	/** Persist an api-key credential for a provider (auth.json). */
	setProviderApiKey(provider: string, apiKey: string): Promise<void> {
		return this.modelAdmin.setProviderApiKey(provider, apiKey);
	}
	clearProviderApiKey(provider: string): Promise<void> {
		return this.modelAdmin.clearProviderApiKey(provider);
	}
	listProviders(): Promise<void> {
		return this.modelAdmin.listProviders();
	}
	listModelsConfig(): Promise<void> {
		return this.modelAdmin.listModelsConfig();
	}
	fetchModelsList(reqId: number, baseUrl: string, apiKey?: string, authHeader?: boolean, api?: string): Promise<void> {
		return this.modelAdmin.fetchModelsList(reqId, baseUrl, apiKey, authHeader, api);
	}
	refreshProviderModels(providerId: string, reqId: number): Promise<void> {
		return this.modelAdmin.refreshProviderModels(providerId, reqId);
	}
	/** Copy a built-in provider into an editable custom-provider draft
	 *  (clone_provider_result) — lets the user run a second API key without
	 *  overwriting the built-in one. */
	cloneProvider(providerId: string, reqId: number): Promise<void> {
		return this.modelAdmin.cloneProvider(providerId, reqId);
	}
	saveModelConfig(providerId: string, config: unknown): Promise<void> {
		return this.modelAdmin.saveModelConfig(providerId, config as never);
	}
	deleteModelConfig(providerId: string): Promise<void> {
		return this.modelAdmin.deleteModelConfig(providerId);
	}
	listProviderKeys(): void {
		return this.modelAdmin.listProviderKeys();
	}
	async addProviderKey(provider: string, apiKey: string, name?: string): Promise<void> {
		await this.modelAdmin.addProviderKey(provider, apiKey, name);
		const active = this.modelAdmin.getActiveKeyName(provider);
		if (active) this.stateStore.saveProjectProviderKey(this.clientId, this.cwd, provider, active);
	}
	async activateProviderKey(provider: string, keyName: string): Promise<void> {
		await this.modelAdmin.activateProviderKey(provider, keyName);
		this.stateStore.saveProjectProviderKey(this.clientId, this.cwd, provider, keyName);
	}
	async removeProviderKey(provider: string, keyName: string): Promise<void> {
		await this.modelAdmin.removeProviderKey(provider, keyName);
		const saved = this.stateStore.getProjectProviderKey(this.clientId, this.cwd, provider);
		if (saved === keyName) {
			const active = this.modelAdmin.getActiveKeyName(provider);
			if (active) this.stateStore.saveProjectProviderKey(this.clientId, this.cwd, provider, active);
			else this.stateStore.deleteProjectProviderKey(this.clientId, this.cwd, provider);
		}
	}

	/** Restore per-project provider keys when entering a project. For each
	 *  provider that has a saved key for `cwd`, activate it if it differs from
	 *  the current global active. Silent — no notice spam on project switch. */
	private async restoreProjectProviderKeysForCwd(cwd: string): Promise<void> {
		const saved = this.stateStore.getProjectProviderKeys(this.clientId, cwd);
		if (!saved) return;
		for (const [provider, keyName] of Object.entries(saved)) {
			const cur = this.modelAdmin.getActiveKeyName(provider);
			if (cur === keyName) continue;
			try {
				await this.modelAdmin.activateProviderKey(provider, keyName);
			} catch {
				// saved key may have been deleted — ignore
			}
		}
	}

	/** When a model is set, ensure its provider's per-project key is restored. */
	private async restoreKeyForModel(modelId: string, cwd: string): Promise<void> {
		const slash = modelId.indexOf("/");
		if (slash <= 0) return;
		const provider = modelId.slice(0, slash);
		const saved = this.stateStore.getProjectProviderKey(this.clientId, cwd, provider);
		if (!saved) return;
		const cur = this.modelAdmin.getActiveKeyName(provider);
		if (cur === saved) return;
		try {
			await this.modelAdmin.activateProviderKey(provider, saved);
		} catch {}
	}

	/** Remember the just-selected model (and the key that was active for its
	 *  provider) for the current project. Called IMMEDIATELY on model selection —
	 *  not only after a turn — so switching back to the project restores the exact
	 *  {model, key} left behind, even for a fresh conversation with no assistant
	 *  message yet (the SDK only flushes a model_change to disk once one exists). */
	private rememberProjectModel(modelId: string): void {
		const cwd = this.cwd;
		this.stateStore.saveProjectModel(this.clientId, cwd, modelId);
		const slash = modelId.indexOf("/");
		if (slash <= 0) return;
		const provider = modelId.slice(0, slash);
		const active = this.modelAdmin.getActiveKeyName(provider);
		if (active) this.stateStore.saveProjectProviderKey(this.clientId, cwd, provider, active);
	}

	/** Restore the project's remembered model (and its provider's key) onto the
	 *  ACTIVE conversation — but ONLY for a conversation the user hasn't really
	 *  started (no messages yet). A conversation that already has content keeps its
	 *  own per-session model: switching back to a RUNNING / completed chat must not
	 *  silently overwrite its model with the project default. So a fresh chat in the
	 *  project gets the remembered model; an in-progress one keeps what it had and
	 *  the user switches via the picker. Silent on failure (model no longer in catalog). */
	private async restoreProjectModelForCwd(cwd: string): Promise<void> {
		const savedModel = this.stateStore.getProjectModel(this.clientId, cwd);
		if (!savedModel) return;
		try {
			if (this.conv.session.getSessionStats().totalMessages > 0) return;
		} catch {
			return;
		}
		try {
			const mr = this.runtime.services.modelRuntime;
			const slash = savedModel.indexOf("/");
			if (slash <= 0 || slash === savedModel.length - 1) return;
			const model = mr.getModel(savedModel.slice(0, slash), savedModel.slice(slash + 1));
			if (!model) return;
			const cur = this.session.model;
			const curId = cur ? `${cur.provider}/${cur.id}` : null;
			// Restore the model's provider key first so setModel's auth check passes.
			await this.restoreKeyForModel(savedModel, cwd);
			if (curId === savedModel) return;
			await this.session.setModel(model);
		} catch {
			// model no longer resolvable / key gone — keep the conversation default
		}
	}

	// ---------------------------------------------------------------------------
	// Settings (system prompt / skills / extensions / presets)
	// ---------------------------------------------------------------------------

	/** Push the full settings state (current settings + loaded skills/extensions
	 *  with enabled flags + saved presets). Pushed on attach and after every
	 *  settings change. */
	pushSettings(): void {
		this.settingsSvc.push();
	}

	/** Extensions/skills changed externally (e.g. `pi remove` finished in the
	 *  terminal): re-run session.reload() and re-push state. Streaming-safe —
	 *  deferred to agent_end, same as settings reloads. */
	async reloadExtensions(): Promise<void> {
		return this.settingsSvc.applyRuntime();
	}

	/** Persist + apply a partial settings update (prompt text/mode, toggles). */
	async setSettings(partial: {
		promptMode?: PromptMode;
		customSystemPrompt?: string;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: PromptMode;
		visionBridgePrompt?: string;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
		disabledPlugins?: string[];
	}): Promise<void> {
		await this.settingsSvc.set(partial);
	}

	/** Save the CURRENT settings as a named preset (overwrites if exists). */
	async savePreset(name: string): Promise<void> {
		return this.settingsSvc.savePreset(name);
	}

	/** Replace the current settings with the named preset and apply it. */
	async applyPreset(name: string): Promise<void> {
		return this.settingsSvc.applyPreset(name);
	}

	/** Remove a named preset. */
	async deletePreset(name: string): Promise<void> {
		return this.settingsSvc.deletePreset(name);
	}

	/** Make settings effective in the running runtime（流式中则延迟到 agent_end）。 */
	private async applyRuntimeSettings(): Promise<void> {
		return this.settingsSvc.applyRuntime();
	}

	/** 把终端工具开关应用到 session 的活跃工具集：关闭时从活跃集中剔除
	 *  terminal_*（工具仍留在注册表，重开时可直接加回）。session.reload() 与新
	 *  会话创建都会把 custom 工具加回活跃集，所以这两条路径之后都要重放本方法。 */
	private applyTerminalToolGating(session: AgentSession): void {
		try {
			const enabled = this.settingsSvc.current.terminalToolsEnabled !== false;
			const names = new Set(session.getActiveToolNames());
			for (const n of TERMINAL_TOOL_NAMES) {
				if (enabled) names.add(n);
				else names.delete(n);
			}
			session.setActiveToolsByName([...names]);
		} catch {
			// Session 未就绪——下次创建/reload 会再应用。
		}
	}

	/** 把插件 AI 工具同步进一个已存在的会话（新增/更新/移除）。
	 *  实际 diff 逻辑在 plugins.ts 的 syncPluginToolsIntoSession（可单测）。 */
	private syncPluginTools(session: AgentSession): void {
		try {
			const defs = (this.pluginToolsProvider?.() ?? []).map(pluginToolToDefinition);
			const next = syncPluginToolsIntoSession(
				session as unknown as Parameters<typeof syncPluginToolsIntoSession>[0],
				defs as unknown as Parameters<typeof syncPluginToolsIntoSession>[1],
				this.appliedPluginToolNames,
			);
			if (next) this.appliedPluginToolNames = new Set(next);
		} catch (err) {
			console.error("[plugins] sync tools to session failed:", err);
		}
	}

	/** index.ts 经 pluginMgr.onAgentToolsChanged 触发：把插件 AI 工具推入全部会话。 */
	refreshPluginTools(): void {
		for (const conv of this.convs.values()) this.syncPluginTools(conv.session);
	}

	private async applySettingsReload(): Promise<void> {
		// 兼容旧入口：reload + 刷目录在宿主回调里完成
		return this.settingsSvc.applyRuntime();
	}

	// ---------------------------------------------------------------------------
	// Commands
	// ---------------------------------------------------------------------------

	/** True when the service is draining (quiesced): emits a rejection notice
	 *  and returns true. Guards every NEW-work entry point (prompt / new chat /
	 *  edit-resend / session resume / goal wizard) — existing runs keep going.
	 *  Called BEFORE any LLM/token work starts so quiesce is a hard admission
	 *  gate, not a best-effort hint. */
	private quiesceBlocked(): boolean {
		if (!this.isQuiesced()) return false;
		this.emit({
			type: "notice",
			level: "error",
			text: "服务器正在排空存量工作（quiesce），已拒绝新的对话/消息/编辑。存量运行会继续跑完；用 pi-web-ui server unquiesce 可恢复。",
			textEn:
				"Server is draining (quiesce) and rejected the new chat/message/edit. Existing runs continue; resume with pi-web-ui server unquiesce.",
		});
		this.flushSnapshot();
		return true;
	}

	/** Conversations with an in-flight run — active work for quiesce status. */
	activeConversations(): number {
		let n = 0;
		for (const c of this.convs.values()) {
			try {
				if (c.session.isStreaming) n += 1;
			} catch {
				// session being replaced — not running
			}
		}
		return n;
	}

	/** Messages queued in the SDK (steer + follow-up) — pending work for
	 *  quiesce status. Quiesce refuses to add more, so this only drains. */
	pendingMessages(): number {
		let n = 0;
		for (const c of this.convs.values()) n += c.queueFollowUp.length + c.queueSteering.length;
		return n;
	}

	async prompt(
		text: string,
		attachments?: {
			path: string;
			mode?: "inline" | "reference" | "lines";
			lines?: { start: number; end: number };
			/** Raw pasted/dropped/uploaded image (base64) — bypasses workspace path. */
			imageData?: string;
			/** Raw uploaded file bytes (base64) — persisted, attached as reference. */
			fileData?: string;
			mimeType?: string;
			name?: string;
			size?: number;
		}[],
		/**
		 * true = followUp: while streaming, queue the prompt and deliver it only
		 * after the WHOLE run finishes (补充 button — "AI 生成结束才发送").
		 * false/undefined = steer: the pi CLI Enter semantic — injected right
		 * after the current turn settles, skipping remaining planned tool calls.
		 */
		queue = false,
	): Promise<void> {
		// Captured at the START (before any await): the conversation being
		// addressed by this prompt. See the naming block below — a concurrent
		// switch/new_chat while prompt() is in flight must never target a
		// different conversation.
		const conv = this.conv;
		try {
			const s = this.session;
			// Native slash commands (see NATIVE_COMMANDS) are executed here and
			// never reach the SDK. Extension / skill / template commands fall
			// through — AgentSession.prompt() handles those itself.
			const slash = parseSlash(text);
			if (slash && (await this.slash.exec(slash.name, slash.args))) {
				this.flushSnapshot();
				return;
			}
			// Native commands above are pure config tweaks (no tokens) — allow them
			// even while quiesced. Everything that reaches the SDK is NEW work and
			// is refused until admission reopens.
			if (this.quiesceBlocked()) return;
			// Name the conversation from its FIRST prompt immediately, before any
			// await: the typed text IS the name. The `conv` reference was captured
			// before the try block, so a concurrent switch/new_chat while prompt()
			// is in flight can never rename a DIFFERENT conversation — or miss the
			// rename entirely. A failed send still leaves the name, which matches
			// what the user typed intent-wise; the entry_appended fallback below
			// re-derives it from the persisted transcript when needed.
			if (conv.title === DEFAULT_CONV_TITLE && text.trim()) {
				const trimmed = text.trim().replace(/\s+/g, " ");
				conv.title = trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed;
				this.emitConversations();
			}
			// Attach files as independent nextTurn context messages (asides) so the
			// user message stays clean; they render as separate attachment cards.
			const asides = await buildAttachmentMessages(
				{
					cwd: this.cwd,
					clientId: this.clientId,
					emit: (msg) => this.emit(msg),
					settings: this.settingsSvc.current,
					session: this.session,
				},
				attachments,
			);
			for (const aside of asides) {
				await s.sendCustomMessage(aside.message, { deliverAs: "nextTurn" });
			}
			if (s.isStreaming) {
				// queue=true (补充 button) → followUp: the message is delivered only
				// after the whole run finishes — the agent finishes what it started,
				// then responds to the queued message. queue=false/undefined
				// (plain Enter) → steer: interrupts the current run — the message
				// is delivered right after the current assistant turn settles
				// (remaining planned tool calls are skipped) and the agent
				// immediately responds to it. This is the pi CLI
				// Enter-during-streaming semantic (docs/usage: Enter queues a
				// steering message); followUp would wait for the whole run
				// to finish, which users perceive as ordinary queueing.
				await s.prompt(text, {
					streamingBehavior: queue ? "followUp" : "steer",
				});
			} else {
				await s.prompt(text);
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `提示发送失败：${(err as Error).message}`,
				textEn: `Failed to send prompt: ${(err as Error).message}`,
			});
		}
		// The active conversation (captured at prompt start — see above) has been
		// continued since it was opened — it must not be dismissed when the user
		// switches away. (Also bumps the per-project "most recently active"
		// order used by set_cwd.)
		conv.promptedSinceActive = true;
		conv.lastActiveAt = Date.now();
		// Fresh run — restart the stall watchdog window.
		conv.lastSdkEventAt = Date.now();
		conv.stallNoticed = false;
		this.flushSnapshot();
	}

	/**
	 * Turn attached files into custom-message payloads.
	 *
	 * Text files are size-aware: small files are inlined into the message so the
	 * model sees them immediately; large files are passed as a <file path="...">
	 * reference and the model reads them on demand with its read tool (which has
	 * built-in truncation). Images are always passed as image content. Mode
	 * "lines" inlines only a 1-based inclusive line range of the file. Raw
	 * pasted/dropped/uploaded images (attachment.imageData) skip the workspace
	 * path entirely and go straight to the model as image content. Raw uploaded
	 * files (attachment.fileData) are persisted under <dataDir>/uploads/ and
	 * attached as absolute-path references (small text ones are inlined).
	 */

	/**
	 * Hard-abort the running agent (Stop button / global 中断). Tries
	 * session.abort() first; if the run is not idle within
	 * HARD_ABORT_TIMEOUT_MS (model stream ignoring the abort signal), the
	 * conversation's runtime is force-disposed and recreated from the last
	 * persisted session so the chat ALWAYS comes back usable — never stuck
	 * overnight. The notice fires only on the forced-reset path.
	 */
	async abort(): Promise<void> {
		// 只停止智能体运行本身；AI 在后台启动的服务由「后台任务」面板单独
		// 管理（可逐个停止或全部关闭），不会在停止对话时被连带杀掉。
		await this.interruptRun(this.conv, "已停止");
		this.flushSnapshot();
	}

	/**
	 * Remove ONE queued prompt text (the ✕ on a pending bubble) so it is neither
	 * shown nor eventually delivered. The pi SDK has no per-item queue API, so we
	 * drain the SDK queue (clearQueue), drop the target text and re-queue the rest
	 * in their original order; the SDK re-emits queue_update which re-syncs
	 * conv.queueSteering / conv.queueFollowUp.
	 */
	async removeQueued(kind: "steer" | "followUp", text: string): Promise<void> {
		const conv = this.conv;
		// Always-defined display mirrors; also the provenance of bubble rendering.
		const local = kind === "steer" ? conv.queueSteering : conv.queueFollowUp;
		if (!local.includes(text)) {
			// Already gone (delivered / cleared elsewhere) — just refresh the display.
			this.flushSnapshot();
			return;
		}
		const s = this.conv.session;
		if (!s) {
			// Runtime not bound yet (fresh conversation) — drop the display mirror;
			// a later queue_update reconciles any SDK-side state.
			const i = local.indexOf(text);
			if (i >= 0) local.splice(i, 1);
			this.flushSnapshot();
			return;
		}
		const { steering, followUp } = s.clearQueue();
		const keptSteering = steering.filter((t) => !(kind === "steer" && t === text));
		const keptFollowUp = followUp.filter((t) => !(kind === "followUp" && t === text));
		// Re-queue the survivors in original order. Guard each call so a single
		// failure can't leave the queue half-drained silently.
		for (const t of keptSteering) {
			try {
				await s.steer(t);
			} catch (err) {
				this.emit({
					type: "notice",
					level: "error",
					text: `重新入队插队消息失败：${(err as Error).message}`,
					textEn: `Failed to re-queue the steer message: ${(err as Error).message}`,
				});
			}
		}
		for (const t of keptFollowUp) {
			try {
				await s.followUp(t);
			} catch (err) {
				this.emit({
					type: "notice",
					level: "error",
					text: `重新入队排队消息失败：${(err as Error).message}`,
					textEn: `Failed to re-queue the queued message: ${(err as Error).message}`,
				});
			}
		}
		this.flushSnapshot();
	}

	/** Re-push the current list on request (panel opened); prunes dead entries first. */
	async listBgServers(): Promise<void> {
		await this.bg.listAndPush();
	}

	/** 插件任务集合变化时由宿主调用：重推一次 bg_servers（含插件任务）。 */
	refreshBgTasks(): void {
		this.bg.push();
	}

	/** 插件设置保存结果等需要从 index.ts 发 notice 时用（emit 是私有的）。 */
	emitNotice(level: "info" | "warning" | "error", text: string): void {
		this.emit({ type: "notice", level, text });
	}

	/** Kill ONE background server (by port); returns whether anything was killed. */
	/** Kill ONE background server (by port) OR a plugin task (by taskId). */
	async killBackgroundServer(port: number | undefined, taskId?: string): Promise<boolean> {
		if (taskId) {
			// 插件任务：交给插件管理器 stop 回调（不杀进程树——任务在宿主进程内）。
			const ok = this.pluginStopBgTask?.(taskId) ?? false;
			if (!ok) {
				this.emit({
					type: "notice",
					level: "info",
					text: `后台任务「${taskId}」不存在或已结束`,
					textEn: `Background task "${taskId}" does not exist or has ended`,
				});
			}
			this.bg.push();
			this.flushSnapshot();
			return ok;
		}
		if (typeof port !== "number") return false;
		return this.bg.killOne(port);
	}

	/** Kill every background server the agent started; returns the freed ports. */
	async killAllBackgroundServers(): Promise<string[]> {
		return this.bg.killAll();
	}

	/** Kill only the running bash command(s) — the agent run itself continues
	 *  (the bash tool returns an aborted error and the model moves on). Uses
	 *  the per-client AbortController set registered by the bash tool paths
	 *  ({@link makeKillableBashTool} / {@link makeTerminalBashTool}). */
	async abortBash(): Promise<void> {
		if (this.bashKills.size === 0) {
			this.emit({
				type: "notice",
				level: "info",
				text: "当前没有正在运行的 bash 命令",
				textEn: "No bash command is running",
			});
			this.flushSnapshot();
			return;
		}
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const ac of [...this.bashKills]) ac.abort();
		this.emit({
			type: "notice",
			level: "info",
			text: "已停止 bash 命令（对话继续）",
			textEn: "Bash command stopped (conversation continues)",
		});
		// 让 AI 明确知道是用户手动停止：sendUserMessage 触发下一轮，agent
		// 会看到「命令被用户中止」而不是普通失败，并据此继续（不会困惑于
		// 为什么命令失败了）。
		try {
			await this.conv.runtime.session.sendUserMessage(
				"（系统：用户手动停止了刚才的 bash 命令——命令被中止，终止前已输出的内容在对应工具结果里。请据此继续，不要重跑被中止的命令，除非确实必要。）",
			);
		} catch {
			// best effort — 消息注入失败不影响命令已停止的事实
		}
		this.flushSnapshot();
	}

	/** Interrupt a run: abort, with a force-reset fallback on timeout. */
	private async interruptRun(conv: Conversation, reason: string): Promise<void> {
		// The run is only truly stopped when its agent_end event arrives:
		// session.abort() can return without stopping anything when the run is
		// stuck before the agent even started (e.g. a model stream that never
		// begins), so we watch for agent_end and force-reset when it never
		// comes — abort 卡住（超时）或空转（结算窗口）两条路都覆盖。
		let ended = false;
		let forced = false;
		const off = conv.session.subscribe((e) => {
			if (e.type === "agent_end") {
				ended = true;
			}
		});
		const force = () => {
			if (forced) return;
			forced = true;
			void this.forceResetConversation(conv, `${reason}：运行未终止，已强制重置当前对话`);
		};
		// 1) abort itself hangs (model stream ignores the signal) → hard kill.
		const abortTimer = setTimeout(() => {
			if (!ended) force();
		}, ClientSession.HARD_ABORT_TIMEOUT_MS);
		abortTimer.unref?.();
		// 2) abort itself (Stop semantics: kills the process tree, emits
		//    agent_end with stopReason "aborted" on the normal path).
		try {
			await conv.runtime.session.abort();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `中止失败：${(err as Error).message}`,
				textEn: `Abort failed: ${(err as Error).message}`,
			});
		}
		// 3) abort returned but no agent_end within the settle window → the
		//    run was stuck before it started; force-reset to recover.
		if (!ended) {
			await new Promise((r) => setTimeout(r, ClientSession.HARD_ABORT_SETTLE_MS));
		}
		clearTimeout(abortTimer);
		off();
		if (!ended) force();
	}

	/** Force-reset a conversation: dispose the stuck runtime (kills the hung
	 *  model stream / child processes) and rebuild it from the most recent
	 *  persisted session. The conversation record itself is kept (same id,
	 *  same cwd, same serialization caches), so the UI stays attached. */
	private async forceResetConversation(conv: Conversation, reason: string): Promise<void> {
		try {
			conv.unsubscribe?.();
			conv.unsubscribe = undefined;
			this.clearAllToolWatchdogs(conv);
			conv.toolStartTimes.clear();
			await conv.runtime.dispose();
			const runtime = await createAgentSessionRuntime(this.makeRuntimeFactory(conv.terminals), {
				cwd: conv.cwd,
				agentDir: this.agentDir,
				sessionManager: SessionManager.continueRecent(conv.cwd),
			});
			conv.runtime = runtime;
			conv.session = runtime.session;
			this.emit({ type: "notice", level: "warning", text: reason });
			await this.bindSession();
			this.emitConversations();
			void this.pushSlashCommands();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `强制中断失败：${(err as Error).message}`,
				textEn: `Force-stop failed: ${(err as Error).message}`,
			});
		}
	}

	async newChat(): Promise<void> {
		if (this.quiesceBlocked()) return;
		// Reuse an already-open blank conversation instead of piling up new ones
		// on every click: if the active chat has no messages it IS the new chat
		// (focus already on it); otherwise switch to the first blank one (under
		// the per-project running-list model displaced blanks are disposed, so
		// this branch normally can't exist — kept as a safety net).
		const isBlank = (c: Conversation): boolean => {
			try {
				return c.session.getSessionStats().totalMessages === 0 && c.terminals.list().length === 0;
			} catch {
				// session being replaced — treat as used so we don't switch onto it
				return false;
			}
		};
		const active = this.conv;
		if (active && isBlank(active)) {
			this.flushSnapshot();
			return;
		}
		for (const conv of this.convs.values()) {
			if (conv.id === this.activeId) continue;
			if (isBlank(conv)) {
				await this.switchConversation(conv.id);
				this.flushSnapshot();
				return;
			}
		}
		// Cap is per project — conversations of other projects keep their own
		// lists and don't consume this project's slots.
		const openInProject = [...this.convs.values()].filter((c) => c.cwd === this.cwd).length;
		if (openInProject >= MAX_OPEN_CONVERSATIONS) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `当前项目运行的对话已达上限（${MAX_OPEN_CONVERSATIONS} 个），请先打开某个对话并离开（不继续对话）以移出列表`,
				textEn: `This project already has the max open conversations (${MAX_OPEN_CONVERSATIONS}). Open one and leave it (without continuing) to remove it from the list.`,
			});
			return;
		}
		// The outgoing conversation is left behind — apply the running-list
		// lifecycle. Removal is deferred until the new chat exists so the active
		// conversation stays valid during the (async) runtime creation.
		const displaced = this.displaceActive();
		// Carry the model chosen in the active chat over to the new chat so it
		// doesn't silently revert to the ModelRuntime default model.
		const prevModel = this.conv.session.agent.state.model ?? null;
		try {
			const conversationId = this.nextConversationId();
			const terminals = this.makeTerminalManager(conversationId, this.cwd);
			const runtime = await createAgentSessionRuntime(this.makeRuntimeFactory(terminals), {
				cwd: this.cwd,
				agentDir: this.agentDir,
				sessionManager: SessionManager.create(this.cwd),
			});
			const conv = this.makeConversation(runtime, conversationId, terminals);
			this.convs.set(conv.id, conv);
			this.activeId = conv.id;
			if (displaced) this.removeConversation(displaced.id);
			await this.bindSession();
			// A fresh transcript appeared in the sessions dir — the next listing
			// must see it, not the pre-newChat fridge snapshot.
			this.invalidateSessionInfos();
			// New session seeds with the ModelRuntime default model — restore the
			// model the user had selected in the previous chat.
			if (prevModel && this.sharedModelRuntime) {
				try {
					await this.session.setModel(prevModel);
					const p = (prevModel as unknown as { provider: string }).provider;
					const mid = `${p}/${(prevModel as unknown as { id: string }).id}`;
					await this.restoreKeyForModel(mid, this.cwd);
				} catch {
					// model no longer resolvable — keep the default
				}
			}
			this.emitConversations();
			this.goalSvc.emitGoalStatus();
			this.pushTerminals();
			// The new runtime re-discovered skills/templates — refresh the catalog
			// so the picker stops showing the previous runtime's list.
			void this.pushSlashCommands();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `新建对话失败：${(err as Error).message}`,
				textEn: `Failed to create chat: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * The active conversation is being left (new_chat / switch_conversation /
	 * set_cwd). Runs the running-list lifecycle:
	 *
	 * - still streaming → it becomes a background run: ensure it is listed;
	 * - idle + listed + continued → keep it (the user did continue it);
	 * - any retained terminal state → keep it listed until the terminals are closed;
	 * - idle + listed + opened-but-not-continued, or never listed at all → the
	 *   caller must drop it (returns it so removal happens only after the
	 *   active conversation has been switched away).
	 */
	private displaceActive(): Conversation | null {
		const conv = this.conv;
		// An isolated reviewer can keep working while the main session is idle;
		// retain that conversation so its review is not disposed when the user
		// switches away without sending another prompt.
		// 同时检查磁盘上的未过期 wait-subscription 记录：后台子代理运行结束后
		// 仍欠本会话一次唤醒回合；此时释放运行时会杀死 pi-subagents 扩展宿主，
		// 唤醒永远无法送达（会话表现为无限期停摆）。保留是自限的：记录过期后
		// 不再阻止释放。
		// Also retain when a non-expired pi-subagents wait-subscription record
		// exists on disk for this session: a finished background subagent run
		// still owes this conversation a wake-up turn.
		const retained = shouldRetainActive({
			reviewing: conv.goal.reviewing,
			wizardRunning: conv.wizardRunning,
			streaming: conv.session.isStreaming,
			openTerminals: conv.terminals.list().length,
			listed: conv.listed,
			promptedSinceActive: conv.promptedSinceActive,
			hasPendingWake: () => hasPendingWaitSubscription({ sessionId: conv.session.sessionFile }),
		});
		if (retained) {
			conv.listed = true;
			return null;
		}
		return conv;
	}

	/** Remove a conversation from the running list and free its runtime. The
	 *  session stays persisted on disk, so it remains recoverable from the
	 *  history list. Never removes the active conversation. */
	private removeConversation(id: string): void {
		const conv = this.convs.get(id);
		if (!conv || id === this.activeId) return;
		this.convs.delete(id);
		this.clearAllToolWatchdogs(conv);
		conv.terminals.killAll();
		conv.unsubscribe?.();
		conv.unsubscribe = undefined;
		void conv.runtime.dispose().catch(() => {});
	}

	/** Switch the ACTIVE conversation without interrupting any other chat. */
	async switchConversation(id: string): Promise<void> {
		if (!this.convs.has(id) || id === this.activeId) return;
		const displaced = this.displaceActive();
		this.activeId = id;
		const newCwd = this.conv.cwd;
		// A listed conversation may belong to ANOTHER project (cross-project
		// running list). Switching to it must also switch the active workspace
		// — otherwise the file tree / session history / recent-projects order
		// would keep showing the OLD project while the chat shows the new one.
		const cwdChanged = newCwd !== this.cwd;
		if (displaced) this.removeConversation(displaced.id);
		this.conv.promptedSinceActive = false;
		this.conv.lastActiveAt = Date.now();
		this.webUi.refresh();
		this.emitConversations();
		this.goalSvc.emitGoalStatus();
		this.pushTerminals();
		// The switched-to conversation has its own runtime (own resource cache).
		void this.pushSlashCommands();
		if (cwdChanged) {
			this.cwd = newCwd;
			await this.restoreProjectProviderKeysForCwd(newCwd);
			await this.restoreProjectModelForCwd(newCwd);
			// Mirror set_cwd's project-switch side-effects so the whole UI follows
			// the new workspace, not just the chat pane.
			try {
				this.onCwdChanged?.(newCwd);
			} catch {
				/* hook failure must not break the switch */
			}
			this.stateStore.remember(this.clientId, newCwd);
			void this.pushProjects();
			void this.refreshSessions();
			void this.listFiles(undefined);
			void this.listCommands();
		}
		this.flushSnapshot();
	}

	/** Push every running conversation across ALL projects to the client. The
	 *  running-conversation list is global so a background run from another
	 *  workspace stays visible; clicking one switches both the conversation and
	 *  its project (see switchConversation). The client groups the list by cwd. */
	private emitConversations(): void {
		const conversations: ConversationSummary[] = [];
		for (const conv of this.convs.values()) {
			// Only conversations that were displaced to the background while running.
			if (!conv.listed) continue;
			let messageCount = 0;
			let isStreaming = false;
			try {
				messageCount = conv.session.getSessionStats().totalMessages;
				isStreaming = conv.session.isStreaming;
			} catch {
				// session being replaced — report defaults
			}
			conversations.push({
				id: conv.id,
				title: conv.title,
				cwd: conv.cwd,
				messageCount,
				isStreaming,
			});
		}
		this.emit({
			type: "conversations",
			conversations,
			activeId: this.activeId,
		});
	}

	/** List persisted sessions for this client, newest first. */
	/** The client asked for the session list at least once (lazy loading) —
	 *  background refreshes only re-push when this is true, so a mobile
	 *  client that never opened the panel never pays the disk scan. */
	private sessionsRequested = false;

	/**
	 * Last parsed session list for this cwd, cached briefly so repeated
	 * global-search keystrokes don't re-parse every transcript file on each
	 * request (a project can hold 100+ sessions of several MB each).
	 * pushSessions() and searchSessions() share this fridge — opening the
	 * panel warms it, then every keystroke inside the TTL is free.
	 */
	private sessionInfosCache: { cwd: string; infos: SessionInfo[]; at: number } | null = null;
	private static readonly SESSION_INFO_CACHE_TTL = 3000;

	private async loadSessionInfos(): Promise<SessionInfo[]> {
		const now = Date.now();
		const c = this.sessionInfosCache;
		if (c && c.cwd === this.cwd && now - c.at < ClientSession.SESSION_INFO_CACHE_TTL) {
			return c.infos;
		}
		const infos = await SessionManager.list(this.cwd);
		this.sessionInfosCache = { cwd: this.cwd, infos, at: now };
		return infos;
	}

	/** Session files on disk changed (delete / new-transcript) — drop the brief
	 *  TTL fridge so the NEXT listing re-reads the directory instead of serving
	 *  the pre-mutation snapshot (delete-then-refresh commonly runs inside the
	 *  window, which would re-push the just-removed session). */
	private invalidateSessionInfos(): void {
		this.sessionInfosCache = null;
	}

	/** Push the persisted session list to the client (client-requested). */
	async refreshSessions(): Promise<void> {
		this.sessionsRequested = true;
		await this.pushSessions();
	}

	private async pushSessions(): Promise<void> {
		if (!this.sessionsRequested) return;
		if (!this.sessionsRequested) return;
		try {
			// Sessions live in the SDK default per-project dir
			// (<agentDir>/sessions/--<cwd>--/), the same files the pi CLI/TUI
			// use — one listing covers every conversation of the current folder.
			const infos = await this.loadSessionInfos();

			const sessions = new Map<string, SessionSummary>();
			for (const s of infos) {
				sessions.set(s.path, {
					path: s.path,
					name: s.name,
					firstMessage: s.firstMessage,
					messageCount: s.messageCount,
					modified: s.modified.getTime(),
					source: "web",
				});
			}
			const sorted = [...sessions.values()].sort((a, b) => b.modified - a.modified).slice(0, 200); // newest first — the panel shows recent history
			this.emit({ type: "sessions", sessions: sorted });
		} catch {
			this.emit({ type: "sessions", sessions: [] });
		}
	}

	/** Remove an entry from the client's recent-project list (UI state only). */
	async removeProject(path: string): Promise<void> {
		this.stateStore.removeProject(this.clientId, path);
		await this.pushProjects();
	}

	/** Permanently delete a persisted session transcript file (history list ✕).
	 *
	 * Deleting the ACTIVE conversation's own transcript is allowed: the session
	 * first switches away to the next-latest persisted chat (or a fresh blank
	 * chat when no other history exists). If the displacement could not release
	 * the file (streaming / open terminals / pending wake subscription /
	 * conversation cap), the deletion is aborted with a notice instead of
	 * yanking the file out of a live runtime. Background conversations still
	 * block deletion outright.
	 */
	async deleteSession(path: string): Promise<void> {
		try {
			const abs = resolve(path);
			// Guardrail: only transcripts under the shared sessions root
			// (<agentDir>/sessions/) may be deleted — never arbitrary files.
			const sessionsRoot = resolve(this.agentDir, "sessions");
			if (!abs.startsWith(sessionsRoot + sep)) {
				this.emit({
					type: "notice",
					level: "error",
					text: "只能删除会话目录中的对话记录",
					textEn: "Only transcripts inside the session directory can be deleted",
				});
				return;
			}
			// A live conversation may hold the target transcript. A BACKGROUND
			// conversation must still block deletion outright, but when the ACTIVE
			// conversation holds it the request can be satisfied by switching away
			// first (next-latest history chat, or a fresh blank one) and letting
			// the displacement drop the old runtime.
			const holdsTarget = (conv: Conversation): boolean => {
				const file = conv.session.sessionFile;
				return file !== undefined && resolve(file) === abs;
			};
			const holder = [...this.convs.values()].find(holdsTarget);
			if (holder && holder.id !== this.activeId) {
				this.emit({
					type: "notice",
					level: "warning",
					text: "该对话正在后台运行，请先停止或关闭该对话再删除",
					textEn: "This conversation is still running — stop or close it before deleting",
				});
				return;
			}
			if (holder) {
				// Same source the history panel uses (refreshSessions): newest first.
				const infos = await SessionManager.list(this.cwd);
				const next = infos
					.filter((s) => resolve(s.path) !== abs)
					.sort((a, b) => b.modified.getTime() - a.modified.getTime())[0];
				if (next) await this.switchSession(next.path);
				else await this.newChat();
				// displaceActive() may have RETAINED the old conversation as a
				// background run (streaming, open terminals, pending wake
				// subscription, conversation cap) — in every such case the file is
				// still held, so abort instead of yanking it from a live runtime.
				// Only a conversation that is genuinely still running in the
				// background (streaming / listed) keeps the "wait for it" notice;
				// a retained-but-idle hold means the switch itself failed (cap,
				// quiesce, runtime creation) — say that instead.
				const stillHeld = [...this.convs.values()].find(holdsTarget);
				if (stillHeld) {
					let stillRunning = stillHeld.listed;
					try {
						stillRunning = stillHeld.session.isStreaming || stillRunning;
					} catch {
						// session being replaced — keep the listed-flag fallback
					}
					this.emit({
						type: "notice",
						level: "warning",
						text: stillRunning
							? "对话仍在后台运行，已停止删除；请等待其结束后再删除"
							: "未能切换到其他对话，已取消删除本次操作",
					});
					return;
				}
			}
			rmSync(abs, { force: true });
			// Bust the brief session-info fridge: refreshSessions() below usually
			// lands inside its 3s TTL and would otherwise re-serve a listing that
			// still contains the deleted transcript.
			this.invalidateSessionInfos();
			await this.refreshSessions();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `删除会话失败：${(err as Error).message}`,
				textEn: `Failed to delete session: ${(err as Error).message}`,
			});
		}
	}

	/** Open a persisted session as the active conversation (from listSessions).
	 *
	 * A persisted-session click must follow the same ownership rule as
	 * new_chat/switch_conversation: every open conversation keeps its own
	 * runtime. AgentSessionRuntime.switchSession() tears down (and aborts) the
	 * current runtime, which would otherwise stop a response merely because the
	 * user opened history while it was streaming.
	 */
	async switchSession(path: string): Promise<void> {
		if (this.quiesceBlocked()) return;
		let openedRuntime: AgentSessionRuntime | null = null;
		let openedTerminals: TerminalManager | null = null;
		try {
			const targetPath = resolve(path);

			// A session may already be open in the running-conversation map. Reuse it
			// instead of creating a second writer for the same JSONL transcript.
			for (const conv of this.convs.values()) {
				const sessionFile = conv.session.sessionFile;
				if (sessionFile && resolve(sessionFile) === targetPath) {
					await this.switchConversation(conv.id);
					return;
				}
			}

			const sessionManager = SessionManager.open(targetPath);
			const targetCwd = sessionManager.getCwd();
			const conversationId = this.nextConversationId();
			openedTerminals = this.makeTerminalManager(conversationId, targetCwd);
			openedRuntime = await createAgentSessionRuntime(this.makeRuntimeFactory(openedTerminals), {
				cwd: targetCwd,
				agentDir: this.agentDir,
				sessionManager,
			});

			// Only displace the old active conversation after the replacement runtime
			// is known-good. This keeps a failed history open entirely non-destructive.
			const oldListed = this.conv.listed;
			const displaced = this.displaceActive();
			const openInProject =
				[...this.convs.values()].filter((c) => c.cwd === targetCwd).length + 1 - (displaced?.cwd === targetCwd ? 1 : 0);
			if (openInProject > MAX_OPEN_CONVERSATIONS) {
				// displaceActive() may have promoted a streaming conversation into the
				// running list. Roll that presentation-only mutation back because no
				// switch will take place.
				this.conv.listed = oldListed;
				openedTerminals.killAll();
				await openedRuntime.dispose();
				openedRuntime = null;
				openedTerminals = null;
				this.emit({
					type: "notice",
					level: "warning",
					text: `当前项目运行的对话已达上限（${MAX_OPEN_CONVERSATIONS} 个），请先打开某个对话并离开（不继续对话）以移出列表`,
					textEn: `This project already has the max open conversations (${MAX_OPEN_CONVERSATIONS}). Open one and leave it (without continuing) to remove it from the list.`,
				});
				return;
			}

			const conv = this.makeConversation(openedRuntime, conversationId, openedTerminals);
			// Deliberately resumed — must not be dismissed when the user later
			// switches away without sending a new message.
			conv.promptedSinceActive = true;
			this.convs.set(conv.id, conv);
			this.activeId = conv.id;
			openedRuntime = null;
			openedTerminals = null;
			if (displaced) this.removeConversation(displaced.id);
			await this.bindSession();
			this.cwd = targetCwd;
			await this.restoreProjectProviderKeysForCwd(targetCwd);
			await this.restoreProjectModelForCwd(targetCwd);
			this.conv.lastActiveAt = Date.now();
			this.webUi.refresh();
			this.emitConversations();
			this.goalSvc.emitGoalStatus();
			this.pushTerminals();
			// The restored conversation has a fresh project-bound resource cache.
			void this.pushSlashCommands();
		} catch (err) {
			openedTerminals?.killAll();
			if (openedRuntime) await openedRuntime.dispose().catch(() => {});
			this.emit({
				type: "notice",
				level: "error",
				text: `切换会话失败：${(err as Error).message}`,
				textEn: `Failed to switch session: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Map a rendered user-message id (`u-<timestamp>-<seq>`, assigned in
	 * serialize.ts) back to its append-only session entry id. The seq handles
	 * two user messages sharing the same millisecond timestamp.
	 */
	private resolveUserMessageEntryId(messageId: string): string | null {
		const m = /^u-(\d+)(?:-(\d+))?$/.exec(messageId);
		if (!m) return null;
		const ts = Number(m[1]);
		const seq = m[2] ? Number(m[2]) : 1;
		let count = 0;
		// Resolve against the compaction-aware current leaf path — the same list
		// the UI renders (state.messages). Scanning the whole file (getEntries)
		// could match a summarized entry or one on a different branch.
		for (const entry of this.session.sessionManager.buildContextEntries()) {
			if (entry.type !== "message") continue;
			const msg = (entry as unknown as { message?: AgentMessage }).message;
			if (!msg || msg.role !== "user" || msg.timestamp !== ts) continue;
			count += 1;
			if (count === seq) return entry.id;
		}
		return null;
	}

	/**
	 * Edit a past user question and re-ask it: forks a NEW session file that
	 * keeps everything up to (but not including) that question, then sends the
	 * edited text there. The original thread is untouched and stays in the
	 * session list, so nothing is ever lost.
	 *
	 * Attachments (attachments) travel through the SAME pipeline as prompt()
	 * — the fork intentionally drops the original attachment asides because
	 * they live on the old branch past the fork point, so the browser re-sends
	 * the images it kept in the edit composer (original image blocks + any
	 * newly pasted/dropped ones). Text-only edits pass undefined.
	 */
	async editMessage(
		messageId: string,
		text: string,
		attachments?: Parameters<ClientSession["prompt"]>[1],
	): Promise<void> {
		if (this.quiesceBlocked()) return;
		const trimmed = text.trim();
		if (!trimmed) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "编辑内容为空，已取消",
				textEn: "Edited content is empty — cancelled",
			});
			this.flushSnapshot();
			return;
		}
		const entryId = this.resolveUserMessageEntryId(messageId);
		if (!entryId) {
			this.emit({
				type: "notice",
				level: "error",
				text: "找不到要编辑的消息（可能已被压缩或不在当前分支）",
				textEn: "Message to edit not found (may have been compacted or is on another branch)",
			});
			this.flushSnapshot();
			return;
		}
		try {
			// Preserve the model the user had selected — fork() seeds a new
			// branch with the ModelRuntime default model otherwise.
			const prevModel = this.session.agent.state.model ?? null;
			const result = await this.runtime.fork(entryId);
			if (result.cancelled) {
				this.emit({
					type: "notice",
					level: "info",
					text: "已取消编辑重问",
					textEn: "Edit-and-reask cancelled",
				});
				this.flushSnapshot();
				return;
			}
			await this.bindSession();
			// Restore the previously-selected model on the forked branch.
			if (prevModel && this.sharedModelRuntime) {
				try {
					await this.session.setModel(prevModel);
					const pm = prevModel as unknown as { provider: string; id: string };
					await this.restoreKeyForModel(`${pm.provider}/${pm.id}`, this.cwd);
				} catch {
					// model no longer resolvable — keep the default
				}
			}
			await this.prompt(trimmed, attachments);
			this.emit({
				type: "notice",
				level: "info",
				text: "已从该问题重新提问（原对话保留在会话列表中）",
				textEn: "Re-asked from that question (the original stays in the session list)",
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `编辑重问失败：${(err as Error).message}`,
				textEn: `Edit-and-reask failed: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Push the recent-project list (persisted per client, merged with every cwd
	 * that has persisted sessions in this client's session store — so workspaces
	 * opened before the recent-list feature existed still show up).
	 */
	async pushProjects(): Promise<void> {
		try {
			const saved = this.stateStore.get(this.clientId);
			const removedProjects = new Set(this.stateStore.getRemovedProjects(this.clientId));
			const map = new Map<string, number>();
			for (const p of saved.projects) map.set(p.path, p.lastUsed);
			const all = await SessionManager.listAll();
			for (const s of all) {
				if (s.cwd) {
					const t = s.modified.getTime();
					const prev = map.get(s.cwd);
					if (prev === undefined || t > prev) map.set(s.cwd, t);
				}
			}
			// Only keep directories that still exist — a deleted/unmounted workspace
			// is useless in the picker. Tombstoned entries (explicitly removed by
			// the user) stay hidden even though session files still mention them.
			const projects: ProjectSummary[] = [...map.entries()]
				.filter(([path]) => !removedProjects.has(path) && existsSync(path))
				.map(([path, lastUsed]) => ({ path, lastUsed }))
				.sort((a, b) => b.lastUsed - a.lastUsed)
				.slice(0, 20);
			this.emit({ type: "projects", projects });
		} catch {
			this.emit({ type: "projects", projects: [] });
		}
	}

	/** List a workspace directory (relative to the configured cwd). */
	async listFiles(relPath?: string): Promise<void> {
		return this.files.listFiles(relPath);
	}

	/** 全局搜索：递归文件名匹配（结果经 search_files_result 回推，reqId 匹配）。 */
	async searchFiles(query: string, reqId: number): Promise<void> {
		return this.files.searchFiles(query, reqId);
	}

	/** 全局搜索：在当前工作区的会话转录全文里做大小写不敏感匹配 ——
	 *  不止首条消息，而是每一段 user 与 assistant 文本（AI 输出也在内）。
	 *  结果经 session_search_results 回推（reqId 匹配）；复用 loadSessionInfos()
	 *  缓存，避免每个按键都重新解析全部转录文件。 */
	async searchSessions(query: string, reqId: number): Promise<void> {
		const q = query.trim().toLowerCase();
		if (!q) {
			this.emit({ type: "session_search_results", reqId, query, ok: true, results: [] });
			return;
		}
		try {
			const infos = await this.loadSessionInfos();
			const results = infos
				.filter((s) => sessionMatchesSearch(q, s))
				.sort((a, b) => b.modified.getTime() - a.modified.getTime())
				.slice(0, 50)
				.map((s) => {
					const base: SessionSummary = {
						path: s.path,
						name: s.name,
						firstMessage: s.firstMessage,
						messageCount: s.messageCount,
						modified: s.modified.getTime(),
						source: "web",
					};
					// 命中会话里再定位具体消息（供点击跳转）；仅元数据命中则无锚点
					return { ...base, anchors: collectSessionAnchors(s.path, q) };
				});
			this.emit({ type: "session_search_results", reqId, query, ok: true, results });
		} catch {
			this.emit({ type: "session_search_results", reqId, query, ok: false, results: [] });
		}
	}

	/** SCM 只读查询（结构化 JSON，reqId 匹配）。 */
	async scmQuery(
		kind: "status" | "history" | "filediff" | "commit",
		reqId: number,
		arg?: { path?: string; hash?: string },
	): Promise<void> {
		return this.files.scmQuery(kind, reqId, arg);
	}

	/** Read a workspace file for the preview panel (size-capped, binary-safe). */
	async readFile(relPath: string): Promise<void> {
		return this.files.readFile(relPath);
	}

	/** Save text from the file preview panel within the active workspace. */
	async writeFile(relPath: string, text: string): Promise<void> {
		return this.files.writeFile(relPath, text);
	}

	async uploadFile(relDir: string, name: string, data: string): Promise<void> {
		return this.files.uploadFile(relDir, name, data);
	}

	async cycleModel(): Promise<void> {
		try {
			const result = await this.session.cycleModel();
			if (result?.model) {
				const mid = `${result.model.provider}/${result.model.id}`;
				await this.restoreKeyForModel(mid, this.cwd);
				// Remember per-project like setModel — cycling is also a model switch.
				this.rememberProjectModel(mid);
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换模型失败：${(err as Error).message}`,
				textEn: `Failed to switch model: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Path completion for the cwd input: expand ~/relative paths, list the parent
	 * directory, and return prefix matches (dirs first, capped).
	 */
	async completePath(input: string): Promise<void> {
		return this.files.completePath(input);
	}

	async setCwd(newCwd: string): Promise<void> {
		try {
			const { resolve } = await import("node:path");
			this.files.unwatchGit(); // stale repo's watcher must not fire across projects
			const fs = await import("node:fs/promises");
			const abs = resolve(newCwd);
			const st = await fs.stat(abs);
			if (!st.isDirectory()) {
				throw new Error("路径不是目录");
			}
			if (abs === this.cwd) {
				this.emit({
					type: "notice",
					level: "info",
					text: `已在工作目录：${abs}`,
					textEn: `Already in directory: ${abs}`,
				});
				this.flushSnapshot();
				return;
			}

			// The outgoing conversation is left behind — apply the running-list
			// lifecycle (removal is deferred until the active conversation is
			// safely switched away).
			const displaced = this.displaceActive();

			// Prefer the target project's own most recently active conversation;
			// only create a fresh one (resuming its most recent session) when the
			// project has none open yet.
			let target: Conversation | undefined;
			for (const c of this.convs.values()) {
				if (c.cwd === abs && (!target || c.lastActiveAt > target.lastActiveAt)) {
					target = c;
				}
			}

			if (target) {
				this.activeId = target.id;
				if (displaced) this.removeConversation(displaced.id);
			} else {
				// First visit to this project: resume its most recent session.
				const conversationId = this.nextConversationId();
				const terminals = this.makeTerminalManager(conversationId, abs);
				const newRuntime = await createAgentSessionRuntime(this.makeRuntimeFactory(terminals), {
					cwd: abs,
					agentDir: this.agentDir,
					sessionManager: SessionManager.continueRecent(abs),
				});
				const conv = this.makeConversation(newRuntime, conversationId, terminals);
				this.convs.set(conv.id, conv);
				this.activeId = conv.id;
				if (displaced) this.removeConversation(displaced.id);
				for (const d of newRuntime.diagnostics) {
					if (d.type !== "info") {
						this.emit({ type: "notice", level: d.type, text: d.message });
					}
				}
				await this.bindSession();
			}

			this.pushTerminals();
			this.conv.promptedSinceActive = false;
			this.conv.lastActiveAt = Date.now();
			this.cwd = abs;
			await this.restoreProjectProviderKeysForCwd(abs);
			await this.restoreProjectModelForCwd(abs);
			// 工作区跟随型插件（编辑器文件树等）同步切根。
			try {
				this.onCwdChanged?.(abs);
			} catch {
				/* 钩子异常不影响主流程 */
			}
			// Remember the new workspace (restore target + recent-project entry).
			this.stateStore.remember(this.clientId, abs);
			void this.pushProjects();
			this.webUi.refresh();
			this.emitConversations();
			this.goalSvc.emitGoalStatus();
			// Skills / prompt templates are project-bound — refresh the catalog.
			void this.pushSlashCommands();
			this.emit({
				type: "notice",
				level: "info",
				text: `已切换到工作目录：${abs}`,
				textEn: `Switched to directory: ${abs}`,
			});
			void this.refreshSessions();
			void this.listFiles(undefined);
			// Commands are per-project (.pi/commands.json in the current cwd).
			void this.listCommands();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换工作目录失败：${(err as Error).message}`,
				textEn: `Failed to switch directory: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** List models that have valid authentication configured. */
	async listModels(): Promise<void> {
		try {
			const mr = this.runtime.services.modelRuntime;
			const available = await mr.getAvailable();
			const models = available.map((m) => ({
				id: `${m.provider}/${m.id}`,
				name: m.name,
				provider: m.provider,
				reasoning: m.reasoning,
				vision: m.input?.includes("image") ?? false,
			}));
			this.emit({ type: "models", models });
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `获取模型列表失败：${(err as Error).message}`,
				textEn: `Failed to fetch model list: ${(err as Error).message}`,
			});
		}
	}

	// ---------------------------------------------------------------------------
	// Goal / review
	// ---------------------------------------------------------------------------

	/** Goal family delegates to GoalService (see goal-service.ts). */
	async setGoal(
		goalText: string,
		opts?: {
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
			autoStart?: boolean;
		},
	): Promise<void> {
		return this.goalSvc.setGoal(goalText, opts);
	}

	async startGoalWizard(
		text: string,
		opts?: {
			wizardModel?: string;
			maxRounds?: number;
			locked?: boolean;
		},
	): Promise<void> {
		return this.goalSvc.startGoalWizard(text, opts);
	}

	async setGoalPrefs(opts?: { reviewModel?: string; maxRounds?: number; locked?: boolean }): Promise<void> {
		return this.goalSvc.setGoalPrefs(opts);
	}

	async clearGoal(): Promise<void> {
		return this.goalSvc.clearGoal();
	}

	/** Run a git diff (unstaged + staged) in a conversation's workspace, or
	 * "" when not a repo. */
	private async gitDiff(cwd: string): Promise<string> {
		try {
			const { code, out } = await this.runAsync("git", ["diff", "HEAD"], 10_000, cwd);
			if (code !== 0) return "";
			return out.slice(0, 60_000);
		} catch {
			return "";
		}
	}

	/** Switch to a specific model by "provider/id" (e.g. "anthropic/claude-sonnet-5"). */
	async setModel(modelId: string): Promise<void> {
		try {
			const mr = this.runtime.services.modelRuntime;
			const slash = modelId.indexOf("/");
			if (slash <= 0 || slash === modelId.length - 1) {
				throw new Error(`无效的模型 ID：${modelId}`);
			}
			const provider = modelId.slice(0, slash);
			const id = modelId.slice(slash + 1);
			const model = mr.getModel(provider, id);
			if (!model) throw new Error(`模型不存在：${modelId}`);
			await this.session.setModel(model);
			await this.restoreKeyForModel(modelId, this.cwd);
			// Immediately remember the model + the key it uses for the current
			// project (not only after a turn). This is what makes project switching
			// restore both the model and the provider key.
			this.rememberProjectModel(modelId);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换模型失败：${(err as Error).message}`,
				textEn: `Failed to switch model: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Set the thinking level for future turns. */
	setThinking(level: string): void {
		try {
			this.session.setThinkingLevel(level as Parameters<AgentSession["setThinkingLevel"]>[0]);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换思考强度失败：${(err as Error).message}`,
				textEn: `Failed to switch thinking level: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	cycleThinking(): void {
		try {
			this.session.cycleThinkingLevel();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换思考强度失败：${(err as Error).message}`,
				textEn: `Failed to switch thinking level: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Push the user command list (.pi/commands.json) to the client. */
	async listCommands(): Promise<void> {
		const { commands, path, warning } = await loadCommands(this.cwd);
		if (warning) {
			this.emit({ type: "notice", level: "warning", text: warning });
		}
		this.emit({ type: "commands", commands, path });
	}

	/** Persist the user command list (.pi/commands.json). */
	async saveCommands(commands: CommandDef[]): Promise<void> {
		const { path, error } = await saveCommandsFile(this.cwd, commands);
		if (error) {
			this.emit({ type: "notice", level: "error", text: error });
			return;
		}
		this.emit({ type: "commands", commands, path });
		this.emit({ type: "notice", level: "info", text: `命令已保存：${path}`, textEn: `Command saved: ${path}` });
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		for (const conv of this.convs.values()) conv.terminals.killAll();
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		if (this.sessionsTimer) {
			clearTimeout(this.sessionsTimer);
			this.sessionsTimer = null;
		}
		if (this.widgetsTimer) {
			clearInterval(this.widgetsTimer);
			this.widgetsTimer = null;
		}
		if (this.stallTimer) {
			clearInterval(this.stallTimer);
			this.stallTimer = null;
		}
		this.files.unwatchDir();
		this.files.unwatchGit();
		this.webUi.dispose();
		this.bg.stop();
		for (const conv of this.convs.values()) {
			this.clearAllToolWatchdogs(conv);
			conv.unsubscribe?.();
			try {
				await conv.runtime.dispose();
			} catch {
				// best effort
			}
		}
	}
}

export class AgentService {
	/** index.ts 注入：SDK 工具执行事件的插件转发钩子，attach 时拷贝到每个新会话。 */
	onToolEvent: ((ev: PluginToolEvent) => void) | undefined = undefined;
	/** index.ts 注入：读取插件当前注册的 AI 工具（attach 时拷贝到每个新会话）。 */
	pluginToolsProvider: (() => PluginAgentTool[]) | undefined = undefined;
	/** index.ts 注入：读取插件当前注册的斜杠命令（attach 时拷贝到每个新会话）。 */
	pluginCommandsProvider: (() => PluginCommandDef[]) | undefined = undefined;
	/** index.ts 注入：读取插件注册的常驻后台任务（并入 bg_servers 面板）。 */
	pluginBgTasksProvider: (() => BgServer[]) | undefined = undefined;
	/** index.ts 注入：停止插件任务（kill_background_server with taskId）。 */
	pluginStopBgTask: ((taskId: string) => boolean) | undefined = undefined;
	private clients = new Map<string, ClientSession>();
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
	private stateStore: ClientStateStore;
	/** Set by index.ts: called when /pi-web-ui:quit is invoked. */
	onQuit: (() => boolean) | undefined = undefined;
	/** 任意客户端成功切换工作区后触发（新绝对路径）。index.ts 接到
	 *  PluginManager.notifyCwd，让插件宿主的 host.cwd 实时跟随当前项目。 */
	onClientCwdChanged: ((cwd: string) => void) | undefined = undefined;

	constructor(
		private cwd: string,
		stateFile: string,
	) {
		this.stateStore = new ClientStateStore(stateFile);
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
	} {
		return {
			pid: process.pid,
			version: VERSION,
			cwd: this.cwd,
			...this.quiesceInfo(),
			connectedClients: this.socketCount,
			activeConversations: this.activeConversations(),
			pendingMessages: this.pendingMessages(),
		};
	}

	/** Get or create the session for a client, racing attach calls safely. */
	async attach(clientId: string, send: (msg: ServerMessage) => void): Promise<ClientSession> {
		let cs = this.clients.get(clientId);
		if (!cs) {
			const inflight = this.pending.get(clientId);
			if (inflight) {
				cs = await inflight;
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
					try {
						if (statSync(saved.lastCwd).isDirectory()) cwd = saved.lastCwd;
					} catch {
						// gone (unmounted drive / deleted) — fall back to the default
					}
				}
				// Sessions use the SDK default per-project dir — no per-client dir.
				const creating = ClientSession.create(clientId, cwd, this.stateStore).finally(() => {
					this.pending.delete(clientId);
				});
				this.pending.set(clientId, creating);
				cs = await creating;
				this.clients.set(clientId, cs);
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
		// First attach after a restart: report runs that were interrupted when
		// the previous process shut down (consumed once, then cleared). Queue
		// BEFORE attachSink so the notice rides the initial pending-notice flush.
		cs.notifyInterrupted(this.stateStore.takeInterrupted(clientId));
		cs.attachSink(send);
		// Forward hooks (set once by index.ts) to every session.
		cs.onQuit = this.onQuit;
		cs.onToolEvent = this.onToolEvent;
		cs.pluginToolsProvider = this.pluginToolsProvider;
		cs.pluginCommandsProvider = this.pluginCommandsProvider;
		cs.pluginBgTasksProvider = this.pluginBgTasksProvider;
		cs.pluginStopBgTask = this.pluginStopBgTask;
		cs.isQuiesced = () => this.quiesced;
		// 插件宿主工作区跟随：初次接入也同步一次（恢复的 lastCwd 可能≠服务启动目录），
		// notifyCwd 幂等去重；此后 set_cwd 成功时由 cs.onCwdChanged 继续驱动。
		cs.onCwdChanged = (abs) => this.onClientCwdChanged?.(abs);
		this.onClientCwdChanged?.(cs.cwd);
		return cs;
	}

	/** 插件 AI 工具集合变化（注册/注销）时由 index.ts 触发：推送到所有客户端的全部会话。 */
	applyPluginAgentTools(): void {
		for (const cs of this.clients.values()) cs.refreshPluginTools();
	}

	/** 插件斜杠命令集合变化时由 index.ts 触发：重推各客户端的命令目录。 */
	applyPluginCommandCatalog(): void {
		for (const cs of this.clients.values()) void cs.pushSlashCommands();
	}

	/** 插件常驻后台任务变化时由 index.ts 触发：重推各客户端的 bg_servers。 */
	refreshBackgroundServers(): void {
		for (const cs of this.clients.values()) cs.refreshBgTasks();
	}

	/** Remove a socket from a client's broadcast set (called on socket close). */
	detach(clientId: string, send: (msg: ServerMessage) => void): void {
		this.clients.get(clientId)?.detachSink(send);
	}

	get(clientId: string): ClientSession | undefined {
		return this.clients.get(clientId);
	}

	async disposeAll(): Promise<void> {
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
		const all = [...this.clients.values()];
		this.clients.clear();
		await Promise.all(all.map((cs) => cs.dispose()));
	}
}
