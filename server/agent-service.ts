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
import { spawn } from "node:child_process";
import {
	existsSync,
	readFileSync,
	statSync,
	writeFileSync,
	mkdirSync,
	watch,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createBashTool,
	createLocalBashOperations,
	defineTool,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	VERSION,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionUIContext,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BgServerTracker } from "./bg-servers.js";
import { SettingsService } from "./settings-service.js";
import { FilesService, workspacePath } from "./files-service.js";
import {
	extensionKey,
	type PromptMode,
	ClientStateStore,
} from "./client-state.js";
import { saveUpload } from "./uploads.js";
import { makePersistentTerminalTools } from "./terminals.js";
import { WebUIContext } from "./webui-context.js";
import {
	buildAttachmentMessages,
	parseModelSpec,
} from "./attachments.js";
import type {
		CommandDef,
		ConversationSummary,
		FileEntry,
		GoalStatus,
		ProjectSummary,
		ServerMessage,
		SessionSummary,
		SlashCommandInfo,
		UiMessage,
		UiModelConfigEntry,
		UiProviderConfig,
		UiSettingsState,
		UiVisionBridgeModel,
		UiState,
} from "./protocol.js";
import {
	serializeMessage,
	serializeStreamingMessage,
	type AgentMessage,
} from "./serialize.js";
import {
	loadCommands,
	saveCommandsFile,
	TerminalManager,
} from "./terminals.js";
import {
	buildVisionBridgePrompt,
	SYSTEM_PROMPT,
	transcribeImages,
} from "./vision-bridge.js";

const SNAPSHOT_INTERVAL_MS = 60;
/** Snapshot windowing: beyond the recent window deliver collapsed summaries
 * (mirrors browser KEEP_RECENT in MessageList). Only kicks in once a
 * conversation exceeds SNAPSHOT_COLLAPSE_MIN. */
const SNAPSHOT_KEEP_RECENT = 15;
const SNAPSHOT_COLLAPSE_MIN = 30;
const WIDGET_REFRESH_MS = 2000;
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
/**
 * Killable bash tool: wraps the SDK bash tool with operations that register
 * their own AbortController into a client-level set. abortBash() aborts only
 * those controllers → the command's process tree is killed while the agent
 * run and the conversation continue (the tool returns an aborted error and
 * the model moves on). Injected as a customTool overriding the builtin bash.
 */
function makeKillableBashTool(
	cwd: string,
	kills: Set<AbortController>,
): ToolDefinition {
	const base = createLocalBashOperations();
	const tool = createBashTool(cwd, {
		operations: {
			exec: async (command, c, opts) => {
				const ac = new AbortController();
				kills.add(ac);
				try {
					const signals = [opts.signal, ac.signal].filter(
						(s): s is AbortSignal => s !== undefined,
					);
					return await base.exec(command, c, {
						...opts,
						signal:
							signals.length > 1 ? AbortSignal.any(signals) : signals[0],
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
		description: tool.description,
		parameters: tool.parameters,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: (toolCallId, params, signal, onUpdate) =>
			tool.execute(
				toolCallId,
				params as { command: string; timeout?: number },
				signal,
				onUpdate,
			),
	} as ToolDefinition;
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
/** System prompt for the goal-wizard session. The wizard asks the user a few
 *  questions (via its goal_ask tool) to scope a raw requirement into a precise,
 *  reviewable goal, then emits ONLY the final goal text as its last message. */
function wizardPrompt(draft: string): string {
	return [
		`You are a goal-clarification wizard. The user has stated a raw requirement. Your job is to turn it into ONE precise, actionable goal that a coding agent can fully satisfy and that can be strictly reviewed.`, // eslint-disable-line max-len
		``,
		`# User's raw requirement`, // eslint-disable-line no-regex-spaces
		draft,
		``,
		`Use your goal_ask tool to ask the user focused questions to pin down the essential, ambiguous details. Keep it concise — usually 2 to 4 questions: what exactly to build/do, scope boundaries (what NOT to do), acceptance criteria / done-definition, and any constraints (style, performance, environment).`, // eslint-disable-line max-len
		`Prefer multiple-choice (goal_ask with options) when you can offer clear choices; use open questions only for things that genuinely need free text.`, // eslint-disable-line max-len
		`Once you have enough to write an unambiguous, reviewable goal, STOP asking and reply with EXACTLY this format and nothing else (no preamble, no bullets):`, // eslint-disable-line max-len
		`GOAL: <one concrete, verifiable sentence describing the deliverable and its acceptance criteria>`, // eslint-disable-line max-len
		`If the user cancels or stops answering (the tool reports a cancellation), still produce a sensible best-effort goal from what you already know.`, // eslint-disable-line max-len
	].join("\n");
}

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
	const content = (partial as { content?: unknown } | null | undefined)
		?.content;
	if (Array.isArray(content)) {
		const text = content
			.map((c) =>
				(c as { type?: string; text?: string })?.type === "text"
					? (c as { text: string }).text
					: "",
			)
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
	/** Independent goal/review state for this conversation. */
	goal: GoalStatus;
	goalGeneration: number;
	goalReviewGeneration: number;
	/** Wizard execution is per conversation; dialog transport itself remains
	 * client-wide because the browser can display one dialog at a time. */
	wizardRunning: boolean;
	/** Session event subscription — events are routed to THIS conversation. */
	unsubscribe?: () => void;
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
	msgById: Map<string, AgentMessage>;
	/** id → collapsed summary object (stable reference). */
	collapsedCache: Map<string, UiMessage>;
	lastMessagesSig: string;
	lastMessagesArray: UiMessage[];
	queueSteering: number;
	queueFollowUp: number;
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

/** Turn a full UiMessage into a lightweight collapsed summary (keeps the
 * same id so the browser can get_message the full). Unchanged if already
 * collapsed or has no content. */
function collapseMessage(m: UiMessage, cache: Map<string, UiMessage>): UiMessage {
	// Only collapse assistant messages. user messages are kept FULL because the
	// question-nav rail and edit_message read their content; toolResult/bash
	// entries are role-matched (not content-matched) by prune helpers. Collapsing
	// assistant messages is what actually shrinks big snapshots (thinking/tool
	// output dominate).
	if (m.role !== "assistant") return m;
	if (m.collapsed || !m.content || m.content.length === 0) return m;
	const hit = cache.get(m.id);
	if (hit) return hit;
	let preview = ""; let thinking = 0, toolCall = 0, bash = 0, image = 0;
	for (const b of m.content) {
		if (b.type === "text" && !preview && typeof b.text === "string") {
			const t = b.text.replace(/\s+/g, " ").trim();
			if (t) preview = t.length > 90 ? t.slice(0, 90) + "…" : t;
		} else if (b.type === "thinking") thinking++;
		else if (b.type === "toolCall") toolCall++;
		else if (b.type === "bash") bash++;
		else if (b.type === "image") image++;
	}
	const collapsed = { ...m, content: [], collapsed: true, summary: { preview: preview || undefined, thinking, toolCall, bash, image } };
	cache.set(m.id, collapsed);
	return collapsed;
}
/** Apply snapshot windowing: collapse everything outside the recent window. */
function collapseForWindow(messages: UiMessage[], keepRecent: number, cache: Map<string, UiMessage>): UiMessage[] {
	if (messages.length <= SNAPSHOT_COLLAPSE_MIN) return messages;
	const boundary = Math.max(0, messages.length - keepRecent);
	const out = messages.slice();
	for (let i = 0; i < boundary; i++) out[i] = collapseMessage(out[i], cache);
	return out;
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
	private sharedModelRuntime:
		| Awaited<ReturnType<typeof createAgentSessionServices>>["modelRuntime"]
		| undefined;

	// -----------------------------------------------------------------------
	// Goal / review state. When a goal is active, every finished agent run
	// (agent_end) is checked by an ISOLATED reviewer agent; a failing review
	// injects its feedback back into the main session to revise. All goal
	// mutation goes through setGoal/clearGoal so UI state stays consistent.
	// -----------------------------------------------------------------------
	/** Defaults remembered for newly-created conversations. Each conversation
	 * receives its own GoalStatus, so reviews can run concurrently. */
	private goalReviewPrefs = {
		reviewModel: null as string | null,
		maxRounds: 0,
		locked: true,
	};
	/** Goal state exposed by the goal bar for the ACTIVE conversation. */
	private get goal(): GoalStatus {
		return this.conv.goal;
	}
	/** The browser has one dialog at a time, so wizard UI plumbing remains
	 * client-wide; review execution itself is per conversation. */
	/** Settings-panel state (system prompt + disabled skills/extensions) —
	 *  自包含模块，见 settings-service.ts。resource-loader overrides 在每次
	 *  reload() 时读 current 的最新值，session.reload() 即可应用到运行中 runtime。 */
	private settingsSvc!: SettingsService; // 构造函数里创建（需要 clientId/stateStore）
	/** Aborts the currently-running goal wizard (user clicked ✗ / timed out). Drives
	 *  the in-flight goal_ask dialog to resolve as cancelled and (via the run
	 *  signal) stops the wizard session's agent run. Recreated per wizard. */
	private wizardAbort: AbortController | null = null;
	/** The wizard's AgentSession while it runs — lets clearGoal truly terminate it
	 *  (abort the run), not just flip a flag. */
	private wizardSession: AgentSession | null = null;
	/** Conversation that owns the one browser wizard currently in flight. */
	private wizardOwnerId: string | null = null;
	/** True when the wizard was cancelled externally (✗ / clear_goal / timeout) —
	 *  startGoalWizard reads this after the run to avoid setting a goal. */
	private wizardCancelled = false;
	/** Idle-timeout for the wizard: if no answer arrives within this window (a
	 *  dialog is up but the user doesn't respond), the wizard is auto-cancelled. */
	private static readonly WIZARD_IDLE_TIMEOUT_MS = 5 * 60_000;
	/** Absolute deadline for the whole wizard session (model latency guard). */
	private static readonly WIZARD_MAX_TOTAL_MS = 20 * 60_000;
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
	});

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
		return new TerminalManager((msg) => this.emitTerminal(conversationId, msg), cwd);
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

	/** Web-facing extension UI context (widgets, notifications). */
	private webUi = new WebUIContext((msg) => this.emit(msg));
	private widgetsTimer: ReturnType<typeof setInterval> | null = null;

	/** Connected sockets for this client (multiple tabs share the session). */
	private sinks = new Set<(msg: ServerMessage) => void>();
	private pendingNotices: ServerMessage[] = [];
	private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
	private sessionsTimer: ReturnType<typeof setTimeout> | null = null;
	private version = 0;
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

	private constructor(
		clientId: string,
		cwd: string,
		agentDir: string,
		stateStore: ClientStateStore,
	) {
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
			isStreaming: () => this.session.isStreaming,
			reloadSession: async () => {
				await this.session.reload();
				await this.pushSlashCommands();
			},
			effectiveDefaultSystemPrompt: () => this.effectiveDefaultSystemPrompt(),
		});
		// Prune dead background tasks every 30s (only spawns netstat/lsof while
		// the list is non-empty). unref: must not keep the process alive.
		this.bg.start();
	}

	static async create(
		clientId: string,
		cwd: string,
		stateStore: ClientStateStore,
	): Promise<ClientSession> {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();

		const cs = new ClientSession(clientId, cwd, agentDir, stateStore);
		// Restore last-used goal/review preferences so model & rounds survive reload.
		const gPrefs = stateStore.getGoalPrefs(clientId);
		if (gPrefs) {
			cs.goalReviewPrefs = {
				reviewModel: gPrefs.reviewModel,
				maxRounds: gPrefs.maxRounds,
				locked: gPrefs.locked,
			};
		}
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
						return out;
					},
					// 技能开关：禁用的技能从系统提示词和 /skill: 目录中剔除。
					skillsOverride: (res) => ({
						...res,
						skills: res.skills.filter(
							(s) => !this.settingsSvc.current.disabledSkills.includes(s.name),
						),
					}),
					// 插件开关：禁用的扩展整个卸载（工具 / 命令随之消失）。
					extensionsOverride: (res) => ({
						...res,
						extensions: res.extensions.filter(
							(e) => !this.settingsSvc.current.disabledExtensions.includes(extensionKey(e)),
						),
					}),
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					// 可手动停止的 bash 工具：覆盖 SDK 内置 bash（customTools 按 name
					// 覆盖），执行时把自己的 AbortController 注册进客户端集合——
					// abortBash() 只杀这些命令，agent run 与对话继续。
					customTools: [
						makeKillableBashTool(effectiveCwd, this.bashKills),
						...makePersistentTerminalTools(terminals, effectiveCwd),
					],
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
	}

	/** Create independent goal state for one conversation. Preferences are
	 * client-wide defaults, while goal text/review progress is not shared. */
	private makeGoalStatus(): GoalStatus {
		return {
			conversationId: null,
			goal: null,
			reviewModel: this.goalReviewPrefs.reviewModel,
			maxRounds: this.goalReviewPrefs.maxRounds,
			locked: this.goalReviewPrefs.locked,
			reviewing: false,
			round: 0,
			status: "",
			verdict: "pending",
			wizard: {
				active: false,
				draft: "",
				model: null,
				step: 0,
				maxSteps: 6,
				status: "",
			},
		};
	}

	/** Allocate a stable conversation id before constructing its runtime/tools. */
	private nextConversationId(): string {
		return `c${++this.convSeq}`;
	}

	/** Wrap a fresh runtime as a new conversation record. */
	private makeConversation(
		runtime: AgentSessionRuntime,
		id: string,
		terminals: TerminalManager,
	): Conversation {
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
			goal: this.makeGoalStatus(),
			goalGeneration: 0,
			goalReviewGeneration: 0,
			wizardRunning: false,
			terminals,
			msgIds: new Map(),
			nextMsgId: 1,
			userSeqByTs: new Map(),
			uiMessageCache: new Map(),
			msgById: new Map(),
			collapsedCache: new Map(),
			lastMessagesSig: "",
			lastMessagesArray: [],
			queueSteering: 0,
			queueFollowUp: 0,
			toolStartTimes: new Map(),
			toolWatchdogs: new Map(),
		};
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
		this.emitGoalStatus();
		// Reconnect: push the settings panel state (prompt text/mode, skill &
		// extension toggles, saved presets).
		this.pushSettings();
		// Reconnect: push the background-task list — it must survive reconnects
		// and outlive the conversation that started the tasks.
		this.bg.push();
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
		conv.unsubscribe = conv.session.subscribe((event) =>
			this.onEvent(conv, event),
		);
		this.scheduleSnapshot();
		this.webUi.refresh();
		this.startWidgetsTimer();
	}

	/** Poll extension widgets so TUI-only overlays (e.g. rpiv-todo) stay live. */
	private startWidgetsTimer(): void {
		if (this.widgetsTimer) return;
		this.widgetsTimer = setInterval(() => {
			if (!this.disposed) this.webUi.refresh();
		}, WIDGET_REFRESH_MS);
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
		switch (event.type) {
			case "bash_execution_update": {
				if (event.id) {
					this.emit({
						type: "tool_delta",
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
				break;
			}
			case "tool_execution_end": {
				const startedAt = conv.toolStartTimes.get(event.toolCallId);
				conv.toolStartTimes.delete(event.toolCallId);
				this.clearToolWatchdog(conv, event.toolCallId);
				// Bash finished — wait briefly for background servers to bind their
				// ports, then diff against the pre-run snapshot and record them.
				if (event.toolName === "bash") void this.bg.trackAfterBash();
				const durationMs =
					startedAt !== undefined ? Date.now() - startedAt : undefined;
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
									(typeof c === "object" &&
										c !== null &&
										(c as { type?: unknown }).type === "text")
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
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						delta: text,
					});
				}
				break;
			}
			case "queue_update":
				conv.queueSteering = event.steering.length;
				conv.queueFollowUp = event.followUp.length;
				break;
			// A run finished or a new entry was persisted — keep the session list fresh
			// (new chat + first message, completed turns, compaction, etc.).
			case "agent_end": {
				this.scheduleSessionsRefresh();
				const g = conv.goal;
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
					if (g.goal && g.conversationId === conv.id) {
						conv.goalGeneration += 1;
						g.conversationId = null;
						g.goal = null;
						g.reviewing = false;
						g.verdict = "pending";
						g.feedback = undefined;
						g.status = "已手动停止，目标审查已中止";
						this.emitGoalStatus();
						this.emit({
							type: "notice",
							level: "warning",
							text: "⏹ 已手动停止，目标审查已中止（想继续可重新设定目标）",
						});
					}
					break;
				}
				// Goal review hook: after the run finished normally, if a goal is
				// active (and it belonged to the ACTIVE conversation) and we're not
				// already mid-review, spawn the isolated reviewer.
				if (
					g.goal &&
					g.conversationId === conv.id &&
					!g.reviewing &&
					!conv.wizardRunning &&
					!this.disposed
				) {
					void this.runGoalReview(conv);
				}
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
				break;
			default:
				break;
		}
		this.scheduleSnapshot();
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

	/** Serialize a persisted message with a STABLE id + cached object reference. */
	private serializeCached(m: AgentMessage): UiMessage | null {
		const conv = this.conv;
		// toolResult messages are keyed by toolCallId; everything else by
		// role+timestamp. A single prompt can emit several same-role messages
		// within the SAME millisecond (multiple attachment asides), so the
		// timestamp alone collides in the cache and only the first one renders
		// — append a cheap content fingerprint to keep them distinct while
		// staying stable across snapshots (content never changes once persisted).
		const key =
			m.role === "toolResult"
				? `t:${m.toolCallId}`
				: `${m.role}:${m.timestamp}:${contentFingerprint(m)}`;
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
			conv.msgById.set(msg.id, m);
		}
		return msg;
	}

	snapshot(): UiState {
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
		const allMessages = state.messages
			.map((m) => this.serializeCached(m))
			.filter((m): m is NonNullable<typeof m> => m !== null);
		const collapsedCache = this.conv.collapsedCache;
		const windowed = collapseForWindow(allMessages, SNAPSHOT_KEEP_RECENT, collapsedCache);
		const sig = windowed.map((m) => m.id + (m.collapsed ? ":c" : ":f")).join("");
		const messages = conv.lastMessagesSig === sig ? conv.lastMessagesArray : windowed;
		conv.lastMessagesSig = sig;
		conv.lastMessagesArray = windowed;
		// Reuse the previous array when nothing changed: the element objects are
		// cached (reference-stable) anyway, and a stable array reference lets the
		// frontend memoize derived maps instead of rebuilding them every 60ms.
		return {
			clientId: this.clientId,
			cwd: this.cwd,
			sessionId: this.session.sessionId,
			sessionFile: this.session.sessionFile,
			conversationId: this.activeId,
			messages,
			// The in-progress assistant message lives in state.streamingMessage
			// (the SDK only pushes it into state.messages at message_end). Surfacing
			// it here is what makes thinking + text stream into the browser at
			// ~60ms granularity instead of appearing only when the turn finishes.
			streamingMessage: state.streamingMessage
				? serializeStreamingMessage(state.streamingMessage)
				: null,
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
			stats,
		};
	}

	/** Resolve a browser-bridged dialog (select/confirm/input) for this session. */
	resolveDialog(id: number, value: string | boolean | null): void {
		this.webUi.resolveDialog(id, value);
	}

	/**
	 * Whether the pi agent config looks ready: the agent dir exists and
	 * auth.json has at least one provider credential. Cached for 2s.
	 */
	isPiConfigured(): boolean {
		const now = Date.now();
		const cached = this.piCheckCache;
		if (cached && now - cached.at < 2000) return cached.configured;
		let configured = false;
		try {
			const authPath = join(this.agentDir, "auth.json");
			if (existsSync(authPath)) {
				const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<
					string,
					unknown
				>;
				configured =
					typeof data === "object" &&
					data !== null &&
					Object.keys(data).length > 0;
			}
		} catch {
			configured = false;
		}
		this.piCheckCache = { at: now, configured };
		return configured;
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
			const pkg = JSON.parse(
				readFileSync(join(pkgRoot, "package.json"), "utf8"),
			) as { version?: string };
			return pkg.version ?? "0.0.0";
		} catch {
			return "0.0.0";
		}
	}

	/** Simple numeric semver compare: >0 means a newer than b. */
	private static compareVersions(a: string, b: string): number {
		const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
		const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
		for (let i = 0; i < 3; i++) {
			const x = pa[i] ?? 0;
			const y = pb[i] ?? 0;
			if (x !== y) return x - y;
		}
		return 0;
	}

	/** True once updateApp succeeded — the process must restart to run new code. */
	private pendingRestart = false;
	/**
	 * Set by index.ts: called after a successful self-update; returns whether
	 * the process is going to restart itself (so the notice can say so).
	 */
	onUpdateReady: (() => boolean) | undefined = undefined;
	/** Set by index.ts: called when /pi-web-ui:quit is invoked. */
	onQuit: (() => boolean) | undefined = undefined;

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
			const latestPublishedAt =
				latest && data.time ? (data.time[latest] ?? null) : null;
			const upToDate =
				latest === null || ClientSession.compareVersions(current, latest) >= 0;
			this.emit({
				type: "update_status",
				current,
				latest,
				latestPublishedAt,
				upToDate,
				pendingRestart: this.pendingRestart,
			});
		} catch (err) {
			this.emit({
				type: "update_status",
				current,
				latest: null,
				latestPublishedAt: null,
				upToDate: false,
				pendingRestart: this.pendingRestart,
				error: `检查更新失败：${(err as Error).message}`,
			});
		}
	}

	/**
	 * After `npm i -g`, confirm the on-disk package this process serves from
	 * actually changed to the new version and is complete. Windows npm updates
	 * can fail partway (locked files / Defender / npm rollback) and leave the
	 * global install without its bin links — restarting into that is a silent
	 * crash (web/dist missing + `pi-web-ui` no longer on PATH). Returns null
	 * when OK, else a human-readable problem description.
	 */
	private static verifyGlobalInstall(): string | null {
		try {
			const here = dirname(fileURLToPath(import.meta.url));
			const pkgRoot = resolve(here, "..", "..");
			const pkg = JSON.parse(
				readFileSync(join(pkgRoot, "package.json"), "utf8"),
			) as { version?: string };
			if (!pkg.version || pkg.version === ClientSession.currentAppVersion()) {
				return `安装目录版本未变化（${pkg.version ?? "未知"}）`;
			}
			if (!existsSync(join(pkgRoot, "web", "dist", "index.html"))) {
				return "web/dist/index.html 缺失（前端产物未安装完整）";
			}
			if (!existsSync(join(pkgRoot, "bin", "pi-web-ui.mjs"))) {
				return "bin/pi-web-ui.mjs 缺失";
			}
			if (process.platform === "win32") {
				const prefix = dirname(process.execPath);
				const hasShim =
					existsSync(join(prefix, "pi-web-ui.cmd")) ||
					existsSync(join(prefix, "pi-web-ui.ps1"));
				if (!hasShim) return "pi-web-ui 命令入口（bin 链接）未生成";
			}
			return null;
		} catch (err) {
			return `读取安装目录失败：${(err as Error).message}`;
		}
	}

	/** npm i -g pi-web-ui@latest — the new code only takes effect after a restart. */
	async updateApp(): Promise<void> {
		try {
			this.emit({
				type: "notice",
				level: "info",
				text: "正在更新 pi-web-ui（npm i -g pi-web-ui@latest）…",
			});
			const { code, out } = await this.runAsync(
				"npm",
				["i", "-g", "pi-web-ui@latest"],
				180_000,
			);
			if (code !== 0) {
				this.emit({
					type: "update_result",
					ok: false,
					detail: `npm i 失败（${code ?? "timeout"}）：${out.slice(0, 400)}`,
				});
				this.emit({
					type: "notice",
					level: "error",
					text: `更新 pi-web-ui 失败（${code ?? "timeout"}）：${out.slice(0, 300)}`,
				});
				return;
			}
			// npm reported success, but on Windows the replacement can be partial
			// (locked files, rollback) — restarting into a broken install is a
			// crash with no hint. Verify before handing over.
			const problem = ClientSession.verifyGlobalInstall();
			if (problem) {
				this.emit({
					type: "update_result",
					ok: false,
					detail: `npm i 成功但安装不完整（${problem}）。请手动执行 npm i -g pi-web-ui@latest 修复后再重启服务。`,
				});
				this.emit({
					type: "notice",
					level: "error",
					text: `更新未完整生效（${problem}）。请手动执行 npm i -g pi-web-ui@latest 修复`,
				});
				return;
			}
			this.pendingRestart = true;
			this.emit({
				type: "update_result",
				ok: true,
				detail: out.slice(0, 400),
			});
			const autoRestart = this.onUpdateReady?.() ?? false;
			this.emit({
				type: "notice",
				level: "info",
				text: autoRestart
					? "✅ 已更新 pi-web-ui，正在自动重启…"
					: "✅ 已更新 pi-web-ui，重启服务后生效（pi-web-ui server restart）",
			});
		} catch (err) {
			this.emit({
				type: "update_result",
				ok: false,
				detail: String(err),
			});
			this.emit({
				type: "notice",
				level: "error",
				text: `更新 pi-web-ui 失败：${(err as Error).message}`,
			});
		}
		// Re-check so the UI reflects the new state (pendingRestart included).
		void this.checkUpdate();
	}
	async installPiAgent(): Promise<void> {
		try {
			mkdirSync(this.agentDir, { recursive: true });
			this.emit({
				type: "notice",
				level: "info",
				text: "正在安装 pi agent CLI（npm i -g @earendil-works/pi-coding-agent）…",
			});
			const { code, out } = await this.runAsync(
				"npm",
				["i", "-g", "@earendil-works/pi-coding-agent"],
				180_000,
			);
			if (code === 0) {
				this.emit({
					type: "notice",
					level: "info",
					text: "✅ pi agent CLI 安装完成。填入 API 密钥即可开始，或在终端运行 pi 完成登录。",
				});
				this.emit({ type: "install_result", ok: true, detail: "" });
			} else {
				this.emit({
					type: "notice",
					level: "error",
					text: `pi agent 安装失败（${code ?? "timeout"}）：${out.slice(0, 400)}`,
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
			});
		}
		this.flushSnapshot();
	}

	/** Persist an api-key credential for a provider (auth.json) and apply it now. */
	async setProviderApiKey(provider: string, apiKey: string): Promise<void> {
		const key = apiKey.trim();
		if (!provider.trim()) {
			this.emit({ type: "notice", level: "error", text: "请填写服务商 ID" });
			return;
		}
		if (!key) {
			this.emit({ type: "notice", level: "error", text: "请填写 API 密钥" });
			return;
		}
		try {
			// Persist to auth.json (auth.json shape: { <provider>: { type: "api_key", key } }).
			const authPath = join(this.agentDir, "auth.json");
			mkdirSync(this.agentDir, { recursive: true });
			let data: Record<string, unknown> = {};
			try {
				data = JSON.parse(readFileSync(authPath, "utf8")) as Record<
					string,
					unknown
				>;
			} catch {
				// no file yet / unparsable — start fresh
			}
			data[provider.trim()] = { type: "api_key", key };
			writeFileSync(authPath, JSON.stringify(data, null, 2) + "\n");
			// Apply immediately for this session (runtime credentials are cached), then
			// refresh models. allowNetwork downloads the provider's official model
			// catalog (openai/anthropic/… are dynamic providers with no built-in list).
			const mr = this.runtime.services.modelRuntime;
			await mr.setRuntimeApiKey(provider.trim(), key);
			await mr.refresh({ allowNetwork: true });
			this.piCheckCache = null;
			this.emit({
				type: "notice",
				level: "info",
				text: `✅ 已保存 ${provider.trim()} 的 API 密钥并刷新模型列表`,
			});
			await this.listModels();
			await this.listProviders();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `保存 API 密钥失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Enumerate pi's built-in providers with auth status (key-only config). */
	async listProviders(): Promise<void> {
		const mr = this.runtime.services.modelRuntime;
		let providers;
		try {
			providers = mr.getProviders().map((p) => {
				try {
					const st = mr.getProviderAuthStatus(p.id);
					return {
						id: p.id,
						name: p.name,
						configured: st?.configured ?? false,
						source: st?.source,
					};
				} catch {
					// One odd provider must not blank the whole list.
					return { id: p.id, name: p.name, configured: false };
				}
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `获取服务商列表失败：${(err as Error).message}`,
			});
			return;
		}
		if (providers.length === 0) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "服务商列表为空——pi 运行时未注册任何提供商",
			});
		}
		this.emit({ type: "providers_status", providers });
	}

	// ---------------------------------------------------------------------------
	// Custom model config (agentDir/models.json)
	// ---------------------------------------------------------------------------

	private modelsConfigPath(): string {
		return join(this.agentDir, "models.json");
	}

	/** Strip // and /* *\/ comments without touching string literals (URLs contain //). */
	private static stripJsonComments(src: string): string {
		let out = "";
		let inString = false;
		let i = 0;
		while (i < src.length) {
			const c = src[i];
			const next = src[i + 1];
			if (inString) {
				out += c;
				if (c === "\\") {
					out += next ?? "";
					i += 2;
					continue;
				}
				if (c === '"') inString = false;
				i++;
				continue;
			}
			if (c === '"') {
				inString = true;
				out += c;
				i++;
				continue;
			}
			if (c === "/" && next === "/") {
				while (i < src.length && src[i] !== "\n") i++;
				continue;
			}
			if (c === "/" && next === "*") {
				i += 2;
				while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
				i += 2;
				continue;
			}
			out += c;
			i++;
		}
		return out;
	}

	/** Read + parse models.json (tolerating // and /* *\/ comments like the SDK). */
	private readModelsConfig(): {
		providers: Record<string, Record<string, unknown>>;
	} {
		const path = this.modelsConfigPath();
		try {
			const raw = readFileSync(path, "utf8");
			const parsed = JSON.parse(ClientSession.stripJsonComments(raw)) as {
				providers?: Record<string, Record<string, unknown>>;
			};
			return { providers: parsed?.providers ?? {} };
		} catch {
			return { providers: {} };
		}
	}

	/** Send the current models.json custom providers to the client. */
	async listModelsConfig(): Promise<void> {
		const { providers } = this.readModelsConfig();
		const list: UiProviderConfig[] = Object.entries(providers).map(
			([providerId, p]) => {
				const models = Array.isArray(p.models)
					? (p.models as Record<string, unknown>[]).map((m) => ({
							id: String(m.id ?? ""),
							name: m.name as string | undefined,
							reasoning: m.reasoning as boolean | undefined,
							input: Array.isArray(m.input) ? (m.input as string[]) : undefined,
							contextWindow: m.contextWindow as number | undefined,
							maxTokens: m.maxTokens as number | undefined,
						}))
					: [];
				return {
					providerId,
					name: p.name as string | undefined,
					api: p.api as string | undefined,
					baseUrl: p.baseUrl as string | undefined,
					apiKey: p.apiKey as string | undefined,
					authHeader: p.authHeader as boolean | undefined,
					// headers are intentionally NOT sent to the browser — they may
					// contain Authorization / API-key values; kept server-side only.
					models,
				};
			},
		);
		this.emit({ type: "models_config", providers: list });
	}

	/** Numeric metadata value (NaN/string "unknown" → undefined). */
	private static numMeta(v: unknown): number | undefined {
		return typeof v === "number" && Number.isFinite(v) ? v : undefined;
	}

	private static boolMeta(v: unknown): boolean | undefined {
		return typeof v === "boolean" ? v : undefined;
	}

	private static strArrMeta(v: unknown): string[] | undefined {
		return Array.isArray(v)
			? v.filter((x): x is string => typeof x === "string")
			: undefined;
	}

	/** Best-effort extraction of model metadata from an OpenAI-compatible
	 *  /models `data[]` item. Most endpoints only return `{ id }` — the extra
	 *  fields (context_window / max_model_len / modalities / supports_vision /
	 *  reasoning / display_name) come from vLLM and other extended
	 *  implementations, and are filled into the form when present. */
	private static parseOpenAiModel(m: unknown): UiModelConfigEntry {
		const r = (m ?? {}) as Record<string, unknown>;
		const id = typeof r.id === "string" ? r.id : "";
		const name =
			(typeof r.name === "string" && r.name.trim() ? r.name : undefined) ??
			(typeof r.display_name === "string" && r.display_name.trim()
				? r.display_name
				: undefined);
		const modalities =
			ClientSession.strArrMeta(r.modalities) ??
			ClientSession.strArrMeta(r.input_modalities);
		const vision =
			modalities?.includes("image") === true ||
			ClientSession.boolMeta(r.supports_vision) === true ||
			ClientSession.boolMeta(r.vision) === true ||
			ClientSession.strArrMeta(r.input)?.includes("image") === true;
		const reasoning =
			ClientSession.boolMeta(r.reasoning) === true ||
			ClientSession.boolMeta(r.supports_reasoning) === true ||
			modalities?.includes("reasoning") === true;
		const contextWindow =
			ClientSession.numMeta(r.context_window) ??
			ClientSession.numMeta(r.context_length) ??
			ClientSession.numMeta(r.max_model_len) ??
			ClientSession.numMeta(r.max_context_length);
		const maxTokens =
			ClientSession.numMeta(r.max_tokens) ??
			ClientSession.numMeta(r.max_output_tokens) ??
			ClientSession.numMeta(r.max_completion_tokens);
		return {
			id,
			...(name ? { name } : {}),
			...(reasoning ? { reasoning: true } : {}),
			...(vision ? { input: ["text", "image"] } : {}),
			...(contextWindow ? { contextWindow } : {}),
			...(maxTokens ? { maxTokens } : {}),
		};
	}

	/** google-generative-ai /models shape:
	 *  { models: [{ name: "models/gemini-flash", displayName, inputTokenLimit,
	 *               outputTokenLimit, supportedGenerationMethods }] } */
	private static parseGoogleModel(m: unknown): UiModelConfigEntry {
		const r = (m ?? {}) as Record<string, unknown>;
		const rawName = typeof r.name === "string" ? r.name : "";
		const id = rawName.replace(/^models\//, "");
		const displayName = typeof r.displayName === "string" ? r.displayName : undefined;
		return {
			id,
			...(displayName && displayName !== id ? { name: displayName } : {}),
			...(ClientSession.numMeta(r.inputTokenLimit)
				? { contextWindow: ClientSession.numMeta(r.inputTokenLimit) }
				: {}),
			...(ClientSession.numMeta(r.outputTokenLimit)
				? { maxTokens: ClientSession.numMeta(r.outputTokenLimit) }
				: {}),
		};
	}

	/** Probe a custom provider's OpenAI-compatible /models endpoint (server-side
	 *  because the baseUrl is often a LAN/loopback host the browser can't reach
	 *  cross-origin) and return the advertised models. reqId is echoed back
	 *  in fetch_models_result so the UI can match concurrent requests. */
	async fetchModelsList(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
	): Promise<void> {
		const emitError = (error: string) =>
			this.emit({ type: "fetch_models_result", reqId, ok: false, error });

		const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
		if (!base) return emitError("请先填写 baseUrl");
		let url: URL;
		try {
			url = new URL(base);
		} catch {
			return emitError(`baseUrl 无效：${base}`);
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return emitError("baseUrl 仅支持 http/https");
		}

		const headers: Record<string, string> = {};
		// Per-api auth conventions (mirror pi's built-in provider configs):
		//   openai-*:      Authorization: Bearer <key>
		//   anthropic:     x-api-key + anthropic-version
		//   google:        x-goog-api-key
		// authHeader=false → no auth header at all (custom gateways).
		if (apiKey?.trim() && authHeader !== false) {
			const key = apiKey.trim();
			if (api === "anthropic-messages") {
				headers["x-api-key"] = key;
				headers["anthropic-version"] = "2023-06-01";
			} else if (api === "google-generative-ai") {
				headers["x-goog-api-key"] = key;
			} else {
				headers["Authorization"] = `Bearer ${key}`;
			}
		}

		const tryFetch = async (u: string): Promise<Response | null> => {
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), 15000);
			try {
				return await fetch(u, { headers, signal: ac.signal });
			} catch (err) {
				if ((err as Error).name === "AbortError") {
					emitError("请求超时（15 秒）");
				} else {
					emitError(`请求失败：${(err as Error).message}`);
				}
				return null;
			} finally {
				clearTimeout(timer);
			}
		};

		let res = await tryFetch(`${base}/models`);
		// BaseUrls that omit the /v1 prefix (e.g. https://api.openai.com) 404 on
		// the bare path — retry under /v1.
		if (res && res.status === 404 && !/\/v\d+[a-z-]*$/.test(base)) {
			res = await tryFetch(`${base}/v1/models`);
		}
		if (!res) return;
		if (!res.ok) {
			let detail = "";
			try {
				detail = (await res.text()).slice(0, 200);
			} catch {
				// response body already consumed / not text — ignore
			}
			return emitError(
				`接口返回 HTTP ${res.status}${detail ? `：${detail}` : ""}`,
			);
		}
		let models: UiModelConfigEntry[] = [];
		try {
			const json = (await res.json()) as Record<string, unknown>;
			const data = Array.isArray(json.data) ? json.data : null;
			if (data) {
				// OpenAI-compatible: { data: [{ id, context_window, modalities, … }] }
				models = data
					.map((m) => ClientSession.parseOpenAiModel(m))
					.filter((m) => m.id);
			} else if (Array.isArray(json.models)) {
				// Google: { models: [{ name: "models/…", displayName, … }] }
				models = (json.models as unknown[])
					.map((m) => ClientSession.parseGoogleModel(m))
					.filter((m) => m.id);
			}
		} catch {
			return emitError("响应不是有效的 JSON");
		}
		// Dedupe by id (keep the first, most complete entry) and sort by id.
		const seen = new Set<string>();
		models = models
			.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
			.sort((a, b) => a.id.localeCompare(b.id));
		if (models.length === 0) return emitError("接口未返回任何模型");
		this.emit({ type: "fetch_models_result", reqId, ok: true, models });
	}

	/** Upsert one provider into models.json and hot-reload the model runtime. */
	async saveModelConfig(
		providerId: string,
		config: UiProviderConfig,
	): Promise<void> {
		const pid = providerId.trim();
		if (!pid || !/^[\w.-]+$/.test(pid)) {
			this.emit({
				type: "notice",
				level: "error",
				text: "服务商 ID 无效（仅字母/数字/._-）",
			});
			return;
		}
		const models = (config.models ?? [])
			.filter((m) => m.id && m.id.trim())
			.map((m) => ({
				id: m.id.trim(),
				...(m.name?.trim() ? { name: m.name.trim() } : {}),
				...(m.reasoning ? { reasoning: true } : {}),
				...(m.input?.length ? { input: m.input } : {}),
				...(m.contextWindow ? { contextWindow: Number(m.contextWindow) } : {}),
				...(m.maxTokens ? { maxTokens: Number(m.maxTokens) } : {}),
			}));
		if (models.length === 0) {
			this.emit({ type: "notice", level: "error", text: "至少需要一个模型" });
			return;
		}
		try {
			const { providers } = this.readModelsConfig();
			// headers never reach the browser, so the incoming config can't carry
			// them — preserve the previously stored values when they are absent.
			const prevHeaders = providers[pid]?.headers;
			providers[pid] = {
				...(config.name?.trim() ? { name: config.name.trim() } : {}),
				...(config.api?.trim() ? { api: config.api.trim() } : {}),
				...(config.baseUrl?.trim() ? { baseUrl: config.baseUrl.trim() } : {}),
				...(config.apiKey?.trim() ? { apiKey: config.apiKey.trim() } : {}),
				...(config.authHeader ? { authHeader: true } : {}),
				...(prevHeaders && Object.keys(prevHeaders).length > 0
					? { headers: prevHeaders }
					: {}),
				models,
			};
			mkdirSync(this.agentDir, { recursive: true });
			writeFileSync(
				this.modelsConfigPath(),
				JSON.stringify({ providers }, null, 2) + "\n",
			);

			// Allow a custom models.json entry to reuse the provider credential
			// already stored in auth.json.  Seed the shared runtime too, because
			// older pi-ai versions did not always fall back to stored credentials
			// for a newly-created custom provider.  Never copy the secret into
			// models.json.
			try {
				const auth = JSON.parse(
					readFileSync(join(this.agentDir, "auth.json"), "utf8"),
				) as Record<string, unknown>;
				const credential = auth[pid];
				if (
					credential &&
					typeof credential === "object" &&
					"key" in credential &&
					typeof credential.key === "string" &&
					credential.key.trim()
				) {
					await this.runtime.services.modelRuntime.setRuntimeApiKey(
						pid,
						credential.key,
					);
				}
			} catch {
				// auth.json is optional; models.json can still use its own apiKey.
			}
			await this.runtime.services.modelRuntime.refresh();
			await this.listModelsConfig();
			await this.listModels();
			this.emit({
				type: "notice",
				level: "info",
				text: `✅ 已保存服务商 ${pid}（${models.length} 个模型）并刷新模型列表`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `保存模型配置失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Remove a provider from models.json and hot-reload. */
	async deleteModelConfig(providerId: string): Promise<void> {
		try {
			const { providers } = this.readModelsConfig();
			if (!(providerId in providers)) {
				this.emit({
					type: "notice",
					level: "info",
					text: `服务商 ${providerId} 不存在`,
				});
				return;
			}
			delete providers[providerId];
			writeFileSync(
				this.modelsConfigPath(),
				JSON.stringify({ providers }, null, 2) + "\n",
			);
			await this.runtime.services.modelRuntime.refresh();
			await this.listModelsConfig();
			await this.listModels();
			this.emit({
				type: "notice",
				level: "info",
				text: `🗑  已删除服务商 ${providerId}`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `删除模型配置失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Send a snapshot immediately (cancels any pending throttled one). */
	flushSnapshot(): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		if (!this.disposed) this.emit({ type: "snapshot", state: this.snapshot() });
	}

	/** get_message: full content of a collapsed message. Uses msgById,
	 * else scans session messages for the serialized id. */
	async getMessage(id: string): Promise<void> {
		const conv = this.conv;
		let found = conv.msgById.get(id);
		if (!found) {
			try { for (const m of (this.session.agent.state.messages as AgentMessage[])) { const s = this.serializeCached(m); if (s && s.id === id) { found = m; break; } } } catch {}
		}
		if (!found) { this.emit({ type: "notice", level: "warning", text: `找不到消息(id=${id})` }); return; }
		const full = this.serializeCached(found); if (!full) return;
		this.emit({ type: "message_full", id, message: full } as ServerMessage);
	}

	private scheduleSnapshot(): void {
		if (this.snapshotTimer || this.disposed) return;
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = null;
			if (!this.disposed)
				this.emit({ type: "snapshot", state: this.snapshot() });
		}, SNAPSHOT_INTERVAL_MS);
	}

	// ---------------------------------------------------------------------------
	// Slash commands
	// ---------------------------------------------------------------------------

	/**
	 * Slash commands implemented natively by the web server (the pi CLI's built-in
	 * interactive commands like /model and /new are NOT handled by the SDK's
	 * prompt() — without this they'd be sent to the model as plain text). Keep in
	 * sync with execNativeCommand(). /help and /copy are client-side UI actions
	 * (they never reach the server) but stay listed so the picker shows them.
	 */
	static NATIVE_COMMANDS: {
		name: string;
		description: string;
		descriptionEn: string;
		argumentHint?: string;
		argumentHintEn?: string;
	}[] = [
		{ name: "new", description: "新建对话", descriptionEn: "New chat" },
		{ name: "model", description: "切换模型", descriptionEn: "Switch model", argumentHint: "[名称]", argumentHintEn: "[name]" },
		{ name: "compact", description: "压缩上下文", descriptionEn: "Compact context", argumentHint: "[说明]", argumentHintEn: "[instructions]" },
		{ name: "cwd", description: "切换工作目录", descriptionEn: "Switch workspace", argumentHint: "<路径>", argumentHintEn: "<path>" },
		{
			name: "thinking",
			description: "设置思考强度",
			descriptionEn: "Set thinking level",
			argumentHint: "<off|low|medium|high|xhigh|max>",
			argumentHintEn: "<off|low|medium|high|xhigh|max>",
		},
		{ name: "resume", description: "刷新会话列表", descriptionEn: "Refresh session list" },
		{ name: "reload", description: "重新加载扩展、技能与模板", descriptionEn: "Reload extensions, skills & templates" },
		{ name: "help", description: "显示全部命令", descriptionEn: "Show all commands" },
		{ name: "copy", description: "复制上一条助手回复", descriptionEn: "Copy last assistant reply" },
		{ name: "pi-web-ui:quit", description: "退出服务", descriptionEn: "Quit server (supervisor will restart)" },
	];

	/** Parse a prompt into "/command args" — returns null when it isn't one. */
	private parseSlash(text: string): { name: string; args: string } | null {
		const trimmed = text.trim();
		if (!trimmed.startsWith("/")) return null;
		const m = trimmed.match(/^\/([^\s]+)\s*([\s\S]*)$/);
		if (!m || !m[1]) return null;
		return { name: m[1], args: m[2].trim() };
	}

	/** Run a native slash command (see NATIVE_COMMANDS). Returns false when the
	 *  name is not a native command (the prompt falls through to the SDK). */
	private async execNativeCommand(
		name: string,
		args: string,
	): Promise<boolean> {
		switch (name) {
			case "new":
				await this.newChat();
				return true;
			case "model": {
				if (!args) {
					const current = this.session.model;
					this.emit({
						type: "notice",
						level: "info",
						text: current
							? `当前模型：${current.name}（${current.provider}/${current.id}）。用法：/model <名称>`
							: `用法：/model <名称>`,
					});
					return true;
				}
				const query = args.toLowerCase();
				const available = await this.session.modelRuntime.getAvailable();
				// Prefer an exact "provider/id" match, else id/name substring.
				const exact = available.find(
					(m) => m.provider + "/" + m.id === args.trim(),
				);
				const matches = exact
					? [exact]
					: available.filter(
							(m) =>
								m.id.toLowerCase().includes(query) ||
								m.name.toLowerCase().includes(query) ||
								m.provider.toLowerCase().includes(query),
						);
				if (matches.length === 0) {
					this.emit({
						type: "notice",
						level: "error",
						text: `没有匹配到模型：${args}（可用模型见顶栏模型列表）`,
					});
					return true;
				}
				const pick = matches[0];
				if (matches.length > 1) {
					this.emit({
						type: "notice",
						level: "warning",
						text: `找到 ${matches.length} 个匹配模型，已选用：${pick.name}（精确匹配请用 provider/id）`,
					});
				}
				await this.setModel(`${pick.provider}/${pick.id}`);
				return true;
			}
			case "compact":
				try {
					await this.session.compact(args || undefined);
				} catch (err) {
					this.emit({
						type: "notice",
						level: "error",
						text: `压缩上下文失败：${(err as Error).message}`,
					});
				}
				return true;
			case "cwd":
				if (!args) {
					this.emit({
						type: "notice",
						level: "info",
						text: `当前工作目录：${this.cwd}。用法：/cwd <路径>`,
					});
				} else {
					await this.setCwd(args);
				}
				return true;
			case "thinking": {
				const ALIAS: Record<string, string> = {
					off: "off",
					minimal: "minimal",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: "max",
					关闭: "off",
					极简: "minimal",
					低: "low",
					中: "medium",
					高: "high",
					极高: "xhigh",
					最大: "max",
				};
				const level = ALIAS[args.trim().toLowerCase()];
				if (!level) {
					this.emit({
						type: "notice",
						level: "error",
						text: `无效的思考强度：${args || "（空）"}。可用：off / minimal / low / medium / high / xhigh / max`,
					});
					return true;
				}
				this.setThinking(level);
				return true;
			}
			case "resume":
				await this.refreshSessions();
				this.emit({
					type: "notice",
					level: "info",
					text: "会话列表已刷新，请在左侧「历史对话」中选择",
				});
				return true;
			case "reload":
				try {
					// Re-discovers extensions / skills / prompt templates from disk and
					// re-pushes the picker catalog (the CLI's /reload semantics).
					await this.session.reload();
					await this.pushSlashCommands();
					this.emit({
						type: "notice",
						level: "info",
						text: "已重新加载扩展、技能与提示模板",
					});
				} catch (err) {
					this.emit({
						type: "notice",
						level: "error",
						text: `重新加载失败：${(err as Error).message}`,
					});
				}
				return true;
			case "pi-web-ui:quit": {
				this.emit({
					type: "notice",
					level: "info",
					text: "正在退出 pi-web-ui… supervisor 将自动重启服务",
				});
				setTimeout(() => {
					const didSchedule = this.onQuit?.() ?? false;
					if (!didSchedule) {
						setTimeout(() => process.exit(0), 100);
					}
				}, 300);
				return true;
			}
			case "help":
			case "copy":
				// Client-side UI actions — the client handles them before sending;
				// swallow here so the SDK never sees them as plain prompt text.
				return true;
			default:
				return false;
		}
	}

	/**
	 * Catalog of slash commands for the chat input: web-native builtins first,
	 * then the SDK's invokable commands for the ACTIVE conversation (extension
	 * commands, prompt templates, skills) — the same set the SDK expands when a
	 * prompt text starts with "/" (see AgentSession.prompt).
	 */
	async pushSlashCommands(): Promise<void> {
		const commands: SlashCommandInfo[] = [];
		const seen = new Set<string>();
		for (const c of ClientSession.NATIVE_COMMANDS) {
			commands.push({ ...c, source: "builtin" });
			seen.add(c.name);
		}
		try {
			const s = this.session;
			// Extension commands — the SDK already suffixes collisions with builtin
			// names ("new:2"), and those still reach the SDK since execNativeCommand
			// only intercepts the exact native names.
			for (const cmd of s.extensionRunner.getRegisteredCommands()) {
				if (seen.has(cmd.invocationName)) continue;
				commands.push({
					name: cmd.invocationName,
					description: cmd.description,
					source: "extension",
				});
				seen.add(cmd.invocationName);
			}
			// Prompt templates: /templatename args
			for (const t of s.promptTemplates) {
				if (seen.has(t.name)) continue;
				commands.push({
					name: t.name,
					description: t.description,
					source: "prompt",
				});
				seen.add(t.name);
			}
			// Skills: /skill:name args
			for (const skill of s.resourceLoader.getSkills().skills) {
				const name = `skill:${skill.name}`;
				if (seen.has(name)) continue;
				commands.push({
					name,
					description: skill.description,
					source: "skill",
				});
			}
		} catch {
			// Session not ready yet — native-only catalog still serves the picker.
		}
		this.emit({ type: "slash_commands", commands });
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

	/** Persist + apply a partial settings update (prompt text/mode, toggles). */
	async setSettings(partial: {
		promptMode?: PromptMode;
		customSystemPrompt?: string;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: PromptMode;
		visionBridgePrompt?: string;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
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
		for (const c of this.convs.values()) n += c.queueFollowUp + c.queueSteering;
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
		try {
			const s = this.session;
			// Native slash commands (see NATIVE_COMMANDS) are executed here and
			// never reach the SDK. Extension / skill / template commands fall
			// through — AgentSession.prompt() handles those itself.
			const slash = this.parseSlash(text);
			if (slash && (await this.execNativeCommand(slash.name, slash.args))) {
				this.flushSnapshot();
				return;
			}
			// Native commands above are pure config tweaks (no tokens) — allow them
			// even while quiesced. Everything that reaches the SDK is NEW work and
			// is refused until admission reopens.
			if (this.quiesceBlocked()) return;
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
			});
		}
		// Name the conversation after its first user prompt.
		const conv = this.conv;
		if (conv.title === DEFAULT_CONV_TITLE && text.trim()) {
			const trimmed = text.trim().replace(/\s+/g, " ");
			conv.title = trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed;
			this.emitConversations();
		}
		// The active conversation has been continued since it was opened — it
		// must not be dismissed when the user switches away. (Also bumps the
		// per-project "most recently active" order used by set_cwd.)
		conv.promptedSinceActive = true;
		conv.lastActiveAt = Date.now();
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

	/** Re-push the current list on request (panel opened); prunes dead entries first. */
	async listBgServers(): Promise<void> {
		await this.bg.listAndPush();
	}

	/** Kill ONE background server (by port); returns whether anything was killed. */
	async killBackgroundServer(port: number): Promise<boolean> {
		return this.bg.killOne(port);
	}

	/** Kill every background server the agent started; returns the freed ports. */
	async killAllBackgroundServers(): Promise<string[]> {
		return this.bg.killAll();
	}

	/** Kill only the running bash command(s) — the agent run itself continues
	 *  (the bash tool returns an aborted error and the model moves on). Uses
	 *  the per-client AbortController set registered by
	 *  makeKillableBashTool. */
	async abortBash(): Promise<void> {
		if (this.bashKills.size === 0) {
			this.emit({
				type: "notice",
				level: "info",
				text: "当前没有正在运行的 bash 命令",
			});
			this.flushSnapshot();
			return;
		}
		for (const ac of [...this.bashKills]) ac.abort();
		this.emit({
			type: "notice",
			level: "info",
			text: "已停止 bash 命令（对话继续）",
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
			void this.forceResetConversation(
				conv,
				`${reason}：运行未终止，已强制重置当前对话`,
			);
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
			const runtime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(conv.terminals),
				{
					cwd: conv.cwd,
					agentDir: this.agentDir,
					sessionManager: SessionManager.continueRecent(conv.cwd),
				},
			);
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
		const openInProject = [...this.convs.values()].filter(
			(c) => c.cwd === this.cwd,
		).length;
		if (openInProject >= MAX_OPEN_CONVERSATIONS) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `当前项目运行的对话已达上限（${MAX_OPEN_CONVERSATIONS} 个），请先打开某个对话并离开（不继续对话）以移出列表`,
			});
			return;
		}
		// The outgoing conversation is left behind — apply the running-list
		// lifecycle. Removal is deferred until the new chat exists so the active
		// conversation stays valid during the (async) runtime creation.
		const displaced = this.displaceActive();
		try {
			const conversationId = this.nextConversationId();
			const terminals = this.makeTerminalManager(conversationId, this.cwd);
			const runtime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(terminals),
				{
					cwd: this.cwd,
					agentDir: this.agentDir,
					sessionManager: SessionManager.create(this.cwd),
				},
			);
			const conv = this.makeConversation(runtime, conversationId, terminals);
			this.convs.set(conv.id, conv);
			this.activeId = conv.id;
			if (displaced) this.removeConversation(displaced.id);
			await this.bindSession();
			this.emitConversations();
			this.emitGoalStatus();
			this.pushTerminals();
			// The new runtime re-discovered skills/templates — refresh the catalog
			// so the picker stops showing the previous runtime's list.
			void this.pushSlashCommands();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `新建对话失败：${(err as Error).message}`,
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
		if (conv.goal.reviewing || conv.wizardRunning) {
			conv.listed = true;
			return null;
		}
		if (conv.session.isStreaming) {
			conv.listed = true;
			return null;
		}
		// Terminal state is a reason to keep an otherwise idle conversation alive:
		// switching chats must not kill a PTY the user or agent may still need.
		if (conv.terminals.list().length > 0) {
			conv.listed = true;
			return null;
		}
		if (conv.listed && conv.promptedSinceActive) return null;
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
		this.cwd = this.conv.cwd;
		// All listed conversations share the current project's cwd, so this is
		// normally a no-op — kept defensive for stale clients.
		if (displaced) this.removeConversation(displaced.id);
		this.conv.promptedSinceActive = false;
		this.conv.lastActiveAt = Date.now();
		this.webUi.refresh();
		this.emitConversations();
		this.emitGoalStatus();
		this.pushTerminals();
		// The switched-to conversation has its own runtime (own resource cache).
		void this.pushSlashCommands();
		this.flushSnapshot();
	}

	/** Push the current project's running-conversation list to the client. */
	private emitConversations(): void {
		const conversations: ConversationSummary[] = [];
		for (const conv of this.convs.values()) {
			// The running-conversation list is per project and only contains
			// conversations that were displaced to the background while running.
			if (conv.cwd !== this.cwd || !conv.listed) continue;
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
			const infos = await SessionManager.list(this.cwd);

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
			const sorted = [...sessions.values()]
				.sort((a, b) => b.modified - a.modified)
				.slice(0, 200); // newest first — the panel shows recent history
			this.emit({ type: "sessions", sessions: sorted });
		} catch {
			this.emit({ type: "sessions", sessions: [] });
		}
	}

	/** Switch the active session to a persisted one (from listSessions). */
	async switchSession(path: string): Promise<void> {
		if (this.quiesceBlocked()) return;
		try {
			await this.runtime.switchSession(path);
			await this.bindSession();
			// The resumed session carries its own cwd — sync it into the ACTIVE
			// conversation (other open conversations are untouched).
			this.conv.cwd = this.runtime.cwd;
			this.cwd = this.runtime.cwd;
			this.conv.title = conversationTitle(this.runtime.session);
			// Deliberately resumed — must not be dismissed when the user later
			// switches away without sending a new message.
			this.conv.promptedSinceActive = true;
			this.emitConversations();
			// switchSession replaced the runtime — its resource cache is fresh.
			void this.pushSlashCommands();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换会话失败：${(err as Error).message}`,
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
	 */
	async editMessage(messageId: string, text: string): Promise<void> {
		if (this.quiesceBlocked()) return;
		const trimmed = text.trim();
		if (!trimmed) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "编辑内容为空，已取消",
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
			});
			this.flushSnapshot();
			return;
		}
		try {
			const result = await this.runtime.fork(entryId);
			if (result.cancelled) {
				this.emit({
					type: "notice",
					level: "info",
					text: "已取消编辑重问",
				});
				this.flushSnapshot();
				return;
			}
			await this.bindSession();
			await this.prompt(trimmed);
			this.emit({
				type: "notice",
				level: "info",
				text: "已从该问题重新提问（原对话保留在会话列表中）",
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `编辑重问失败：${(err as Error).message}`,
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
			// is useless in the picker.
			const projects: ProjectSummary[] = [...map.entries()]
				.filter(([path]) => existsSync(path))
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

	async cycleModel(): Promise<void> {
		try {
			await this.session.cycleModel();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换模型失败：${(err as Error).message}`,
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
				if (
					c.cwd === abs &&
					(!target || c.lastActiveAt > target.lastActiveAt)
				) {
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
				const newRuntime = await createAgentSessionRuntime(
					this.makeRuntimeFactory(terminals),
					{
						cwd: abs,
						agentDir: this.agentDir,
						sessionManager: SessionManager.continueRecent(abs),
					},
				);
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
			// Remember the new workspace (restore target + recent-project entry).
			this.stateStore.remember(this.clientId, abs);
			void this.pushProjects();
			this.webUi.refresh();
			this.emitConversations();
			this.emitGoalStatus();
			// Skills / prompt templates are project-bound — refresh the catalog.
			void this.pushSlashCommands();
			this.emit({
				type: "notice",
				level: "info",
				text: `已切换到工作目录：${abs}`,
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
			});
		}
	}

	// ---------------------------------------------------------------------------
	// Goal / review
	// ---------------------------------------------------------------------------

	/** Push the active conversation's goal status to the client (the goal bar
	 * UI). Conversations without an active goal reflect the client's remembered
	 * defaults; an existing goal keeps its own review settings. */
	private emitGoalStatus(): void {
		const goal = this.goal;
		if (!goal.goal && !goal.reviewing && !goal.wizard.active) {
			goal.reviewModel = this.goalReviewPrefs.reviewModel;
			goal.maxRounds = this.goalReviewPrefs.maxRounds;
			goal.locked = this.goalReviewPrefs.locked;
		}
		this.emit({ type: "goal_status", status: { ...goal } });
	}

	/**
	 * Set (or clear) the active goal. `goal === ""` clears it. The goal is
	 * applied to the CURRENT active conversation of this project; reviews check
	 * whatever run finishes next (agent_end).
	 */
	async setGoal(
		goalText: string,
		opts?: {
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
			/** Kick the main agent into generating as soon as the goal is set.
			 *  Default true (set from the goal bar). The wizard passes false — it
			 *  kicks off its own generation after auto-setting the refined goal. */
			autoStart?: boolean;
		},
	): Promise<void> {
		const text = (goalText ?? "").trim();
		if (!text) {
			await this.clearGoal();
			return;
		}
		// A goal is scoped to the conversation that is active when it is set.
		// This prevents an agent_end from a newly-created/switched conversation
		// from consuming the previous conversation's goal.
		const goalConversationId = this.activeId;
		this.conv.goalGeneration += 1;
		this.goal.reviewing = false;
		this.goal.conversationId = goalConversationId;
		this.goal.goal = text;
		// Model & rounds preference semantics ("全局记忆"):
		//  - reviewModel undefined → keep the remembered choice; empty → main model.
		//  - maxRounds 0 = unlimited (default); >0 = finite cap (clamped to 50).
		if (opts?.reviewModel !== undefined) this.goal.reviewModel = opts.reviewModel || null;
		if (typeof opts?.maxRounds === "number") {
			const mr = Math.round(opts.maxRounds);
			this.goal.maxRounds = mr >= 1 ? Math.min(mr, 50) : 0;
		}
		if (opts?.locked !== undefined) this.goal.locked = opts.locked;
		this.goalReviewPrefs = {
			reviewModel: this.goal.reviewModel,
			maxRounds: this.goal.maxRounds,
			locked: this.goal.locked,
		};
		// Persist the chosen preferences so they survive reload.
		this.stateStore.saveGoalPrefs(this.clientId, {
			reviewModel: this.goal.reviewModel,
			maxRounds: this.goal.maxRounds,
			locked: this.goal.locked,
		});
		// Reset the loop for a freshly-set goal (single-shot goals start at 0).
		this.goal.round = 0;
		this.goal.reviewing = false;
		this.goal.verdict = "pending";
		this.goal.feedback = undefined;
		this.goal.wizard.active = false;
		this.goal.wizard.status = "";
		this.goal.status = "目标已设，等待生成…";
		this.emitGoalStatus();
		this.emit({
			type: "notice",
			level: "info",
			text: `🎯 已设目标：${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`,
		});
		// Auto-start generation right after setting the goal (unless this setGoal is
		// the wizard's internal one, which kicks off itself). This makes the direct
		// goal-bar path behave like the AI-提炼 path: set a target → agent begins.
		if (opts?.autoStart !== false) {
			try {
				const s = this.conv.session;
				await s.sendUserMessage(
					`【目标已设定】\n\n${text}\n\n请现在开始实现这个目标。`,
					{ deliverAs: s.isStreaming ? "steer" : "followUp" },
				);
			} catch {
				// Best-effort; the user can still prompt manually.
			}
			this.flushSnapshot();
		}
	}

	/**
	 * Collaborative target wizard. Turns a raw user requirement into a refined
	 * goal by spinning up an ISOLATED wizard session (own fresh ModelRuntime +
	 * in-memory session, so its model choice is its own) that questions the user
	 * via `goal_ask` (multiple-choice + free-text, bridged to the browser through
	 * the existing select/input dialog), converging on a goal, then auto-sets it.
	 * Mutually exclusive with the review loop of the same conversation.
	 */
	async startGoalWizard(
		text: string,
		opts?: {
			wizardModel?: string;
			maxRounds?: number;
			locked?: boolean;
		},
	): Promise<void> {
		if (this.quiesceBlocked()) return;
		const draft = (text ?? "").trim();
		if (!draft) return;
		// The wizard and its progress cards belong to the conversation that
		// launched it. If the user switches away, do not later set a goal on the
		// new active conversation while the wizard is still finishing.
		const wizardConversationId = this.activeId;
		const wizardConversation = this.conv;
		if (wizardConversation.wizardRunning || this.wizardOwnerId !== null) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "已有目标调研进行中，请等它完成…",
			});
			return;
		}
		if (wizardConversation.goal.reviewing) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "正在审查中，无法开始目标调研，请稍等…",
			});
			return;
		}

		// Questions are NOT capped (调研不限制) — the wizard converges on its own;
		// the idle- and total-timeouts are the only guards. maxSteps is purely a
		// soft UI indicator, not a hard stop.
		const maxSteps = 20;
		wizardConversation.wizardRunning = true;
		this.wizardOwnerId = wizardConversationId;
		this.wizardCancelled = false;
		this.wizardAbort = new AbortController();
		this.wizardSession = null;
		wizardConversation.goal.wizard.active = true;
		wizardConversation.goal.wizard.draft = draft;
		wizardConversation.goal.wizard.model = opts?.wizardModel ?? null;
		// Remember the model choice (and persist rounds/lock) — global memory.
		if (opts?.wizardModel !== undefined && opts.wizardModel !== null)
			wizardConversation.goal.reviewModel = opts.wizardModel || null;
		if (typeof opts?.maxRounds === "number") {
			const mr = Math.round(opts.maxRounds);
			wizardConversation.goal.maxRounds = mr >= 1 ? Math.min(mr, 50) : 0;
		}
		if (opts?.locked !== undefined) wizardConversation.goal.locked = opts.locked;
		this.goalReviewPrefs = {
			reviewModel: wizardConversation.goal.reviewModel,
			maxRounds: wizardConversation.goal.maxRounds,
			locked: wizardConversation.goal.locked,
		};
		this.stateStore.saveGoalPrefs(this.clientId, {
			reviewModel: wizardConversation.goal.reviewModel,
			maxRounds: wizardConversation.goal.maxRounds,
			locked: wizardConversation.goal.locked,
		});
		wizardConversation.goal.wizard.step = 0;
		wizardConversation.goal.wizard.maxSteps = maxSteps;
		wizardConversation.goal.wizard.status = "调研中…";
		wizardConversation.goal.status = "目标调研中…";
		this.emitGoalStatus();
		// Idle-timeout: cancel the wizard if no question is answered within the
		// window (a stale dialog with no user response must not run forever). A
		// fresh timer is armed for each question; cleared once the run ends.
		const ac = this.wizardAbort;
		let idleTimer: ReturnType<typeof setTimeout> | null = null;
		const armIdle = () => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				if (!ac.signal.aborted) {
					this.wizardCancelled = true;
					ac.abort(new Error("目标调研超时（等待回答过久）"));
				}
			}, ClientSession.WIZARD_IDLE_TIMEOUT_MS);
			idleTimer.unref?.();
		};
		const clearIdle = () => {
			if (idleTimer) {
				clearTimeout(idleTimer);
				idleTimer = null;
			}
		};
		armIdle();
		// Total-duration guard: hard cap on the whole wizard session (model
		// latency / unexpected loops must not run forever).
		const totalTimer = setTimeout(() => {
			if (!ac.signal.aborted) {
				this.wizardCancelled = true;
				ac.abort(new Error("目标调研超过总时长上限"));
			}
		}, ClientSession.WIZARD_MAX_TOTAL_MS);
		totalTimer.unref?.();
		this.emit({
			type: "notice",
			level: "info",
			text: `🔍 正在围绕需求展开调研：${draft.slice(0, 60)}${
				draft.length > 60 ? "…" : ""
			}`,
		});

		// The main conversation to show wizard progress cards in.
		const mainSession = wizardConversation.session;

		let refinedGoal = "";
		try {
			const wmSpec = opts?.wizardModel
				? this.resolveReviewModel(opts.wizardModel)
				: null; // reuse the honest "provider/id" parser
			const services = await createAgentSessionServices({
				cwd: wizardConversation.cwd,
				agentDir: this.agentDir,
				modelRuntime: await ModelRuntime.create({
					authPath: join(this.agentDir, "auth.json"),
					modelsPath: join(this.agentDir, "models.json"),
				}),
			});

			let model;
			if (wmSpec) model = services.modelRuntime.getModel(wmSpec.provider, wmSpec.id);
			if (!model) {
				const mainModel = mainSession.model as {
					provider?: string;
					id?: string;
				} | undefined;
				if (mainModel?.provider && mainModel.id)
					model = services.modelRuntime.getModel(mainModel.provider, mainModel.id);
			}

			// The wizard asks the user questions via this tool; each call bridges one
			// select/input dialog to the browser and returns the user's answer.
			let qStep = 0;
			const goalAsk = defineTool({
				name: "goal_ask",
				label: "Ask the user",
				description:
					"Ask the user ONE question at a time to scope down the goal. Provide a clear question and 2-4 concise options; or ask an open question. Returns the user's chosen answer.",
				parameters: Type.Object({
					question: Type.String({ description: "The question to ask" }),
					options: Type.Optional(Type.Array(Type.String())),
				}),
				// ONE question at a time. Sequential execution prevents the agent from
				// firing parallel goal_ask calls whose dialogs would overwrite each other
				// in the single browser modal (leaving earlier ones deadlocked — the
				// reported "调研卡住").
				executionMode: "sequential",
				execute: async (_id, params, _sig, _onUpdate, ctx) => {
					qStep += 1;
					if (qStep > maxSteps) {
						return {
							content: [
								{
									type: "text",
									text: "(达到最大提问数，请直接给出收敛后的目标文本作为最终答案)",
								},
							],
							details: {},
						};
					}
					// Show the question in the main flow BEFORE blocking on the dialog, so
					// the user sees the wizard working even before answering.
					wizardConversation.goal.wizard.step = qStep;
					wizardConversation.goal.wizard.status = `调研中：请回答第 ${qStep} 题`;
					this.emitGoalStatus();
					try {
						armIdle();
						const isChoice = !!(params.options && params.options.length > 0);
						await this.pushWizardCard(
							mainSession,
							`🔍 第 ${qStep} 题：${params.question}${
								isChoice ? `【${params.options!.join(" / ")}】` : ""
							}`,
							{ question: params.question },
						);
						// Resolve the pending dialog as cancelled if the wizard is aborted.
						let aborted = false;
						const onAbort = () => {
							aborted = true;
						};
						ac.signal.addEventListener("abort", onAbort, { once: true });
						const choose = isChoice
							? ctx.ui.select(`🔍 第 ${qStep} 题：${params.question}`, params.options!)
							: ctx.ui.input(`🔍 第 ${qStep} 题：${params.question}`);
						const ans = (await choose) as string | boolean | undefined;
						ac.signal.removeEventListener("abort", onAbort);
						if (aborted || ac.signal.aborted) {
							return {
								content: [
									{
										type: "text",
										text: "(调研已取消，请不要继续提问，直接结束对话)",
									},
								],
								details: {},
							};
						}
						if (ans === undefined || ans === null || ans === false || ans === "") {
							return {
								content: [
									{
										type: "text",
										text: "(用户已取消调研，请直接给出你当前收敛的目标文本作为最终答案)",
									},
								],
								details: {},
							};
						}
						// Record the answer in the flow too (instant append, main session idle).
						await this.pushWizardCard(
							mainSession,
							`↳ 您的回答：${ans}`,
							{ question: params.question, answer: String(ans) },
						);
						return {
							content: [{ type: "text", text: `用户回答：${ans}` }],
							details: {},
						};
					} catch (err) {
						return {
							content: [
								{
									type: "text",
									text: ac.signal.aborted
										? "(调研已取消，请不要继续提问，直接结束对话)"
										: `提问失败：${(err as Error).message}`,
								},
							],
							details: {},
						};
					}
				},
			});

			const srv = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(this.cwd),
				customTools: [goalAsk],
				...(model ? { model } : {}),
			});
				const wizard = srv.session;
			this.wizardSession = wizard;
			await wizard.bindExtensions({ mode: "rpc", uiContext: this.webUi });
			// Cancel watcher: when the user ✗s / idle-timeout fires, truly stop the
			// wizard's agent run (not just mark it).
			if (!ac.signal.aborted) {
				ac.signal.addEventListener(
					"abort",
					() => {
						void wizard.abort().catch(() => {});
						// Close the unanswered browser dialog(s) the wizard may have up.
						this.webUi.cancelPendingDialogs();
					},
					{ once: true },
				);
			}
			await wizard.prompt(wizardPrompt(draft));
			refinedGoal = wizard.getLastAssistantText()?.trim() ?? "";
			// The wizard is prompted to emit "GOAL: <text>". Parse past the marker;
			// if it didn't follow, strip a leading preamble line and keep the rest.
			const goalMatch = refinedGoal.match(/GOAL\s*[:：]\s*([\s\S]*)/i);
			if (goalMatch) {
				refinedGoal = goalMatch[1].trim();
			} else {
				const lines = refinedGoal.split("\n").filter((l) => l.trim());
				if (lines.length > 1 && !/[。.!?？]\s*$/.test(lines[0])) {
					// First line looks like preamble (no sentence-ending punctuation).
					refinedGoal = lines.slice(1).join(" ").trim();
				}
			}
			await srv.session.dispose();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `目标调研失败：${(err as Error).message}`,
			});
		} finally {
			clearIdle();
			clearTimeout(totalTimer);
			wizardConversation.wizardRunning = false;
			if (this.wizardOwnerId === wizardConversationId) this.wizardOwnerId = null;
			wizardConversation.goal.wizard.active = false;
			wizardConversation.goal.wizard.step = 0;
			wizardConversation.goal.wizard.status = "";
			this.wizardSession = null;
			this.emitGoalStatus();
		}

		// Aborted externally (✗ / clear_goal / idle-timeout): do NOT set a goal.
		if (ac.signal.aborted || this.wizardCancelled) {
			this.emit({
				type: "notice",
				level: "info",
				text: `目标调研已取消${
					ac.signal.reason ? `：${String((ac.signal.reason as Error)?.message ?? ac.signal.reason)}` : ""
				}`,
			});
			this.wizardAbort = null;
			return;
		}
		if (!refinedGoal.trim()) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "调研未产出有效目标，请重试",
			});
			return;
		}
		if (this.activeId !== wizardConversationId) {
			this.emit({
				type: "notice",
				level: "info",
				text: "已切换对话，目标调研结果已丢弃",
			});
			return;
		}
		// Auto-set the refined goal. The wizard workflow implies "set a goal and
		// work until it passes", so default LOCKED=true unless the user explicitly
		// turned the lock off (a lock lets the review loop keep revising to pass;
		// without it the review is single-shot).
		const wantLocked = opts?.locked === undefined ? true : opts.locked;
		await this.setGoal(refinedGoal, {
			reviewModel: wizardConversation.goal.reviewModel ?? undefined,
			maxRounds: opts?.maxRounds,
			locked: wantLocked,
			// The wizard kicks off generation itself below — avoid a double kick.
			autoStart: false,
		});
		const g2 = wizardConversation.goal;
		this.wizardCancelled = false;
		this.wizardAbort = null;
		this.emit({
			type: "notice",
			level: "info",
			text: `🎯 调研完成，目标已设为：${refinedGoal.slice(0, 80)}${
				refinedGoal.length > 80 ? "…" : ""
			}`,
		});
		// Kick the main agent into generating right away (no manual "开始吧").
		// The kick-off is a user message so it appears in the flow and triggers a
		// normal turn; the finishing agent_end then runs the review loop.
		try {
			await mainSession.sendUserMessage(
				`【目标已设定】\n\n${g2.goal}\n\n请现在开始实现这个目标。`,
				{ deliverAs: mainSession.isStreaming ? "steer" : "followUp" },
			);
		} catch {
			// Generation kick-off is best-effort; the user can still prompt manually.
		}
	}

	/** Persist goal/review preference defaults (model, rounds cap, locked) without
	 *  touching the active goal — so changes in the goal bar are remembered across
	 *  reloads. maxRounds 0 = unlimited. Emits goal_status so the UI stays synced. */
	async setGoalPrefs(opts?: {
		reviewModel?: string;
		maxRounds?: number;
		locked?: boolean;
	}): Promise<void> {
		if (opts?.reviewModel !== undefined) this.goal.reviewModel = opts.reviewModel || null;
		if (typeof opts?.maxRounds === "number") {
			const mr = Math.round(opts.maxRounds);
			this.goal.maxRounds = mr >= 1 ? Math.min(mr, 50) : 0;
		}
		if (opts?.locked !== undefined) this.goal.locked = opts.locked;
		this.goalReviewPrefs = {
			reviewModel: this.goal.reviewModel,
			maxRounds: this.goal.maxRounds,
			locked: this.goal.locked,
		};
		this.stateStore.saveGoalPrefs(this.clientId, {
			reviewModel: this.goal.reviewModel,
			maxRounds: this.goal.maxRounds,
			locked: this.goal.locked,
		});
		this.emitGoalStatus();
	}

	/** Clear the active goal (cancels the review loop AND aborts a running
	 *  goal wizard — truly terminating its in-flight dialog + agent run). */
	async clearGoal(): Promise<void> {
		this.conv.goalGeneration += 1;
		this.goal.reviewing = false;
		this.goal.conversationId = null;
		this.goal.goal = null;
		this.goal.reviewing = false;
		this.goal.verdict = "pending";
		this.goal.feedback = undefined;
		this.goal.wizard.active = false;
		this.goal.wizard.status = "";
		this.goal.status = "";
		this.emitGoalStatus();
		// Abort a running wizard for real (✗ in the goal bar while scoping).
		if (this.wizardOwnerId === this.activeId) {
			this.wizardCancelled = true;
			this.webUi.cancelPendingDialogs();
			this.wizardAbort?.abort();
			const ws2 = this.wizardSession;
			this.wizardSession = null;
			if (ws2) {
				await ws2.abort().catch(() => {});
				ws2.dispose();
			}
			this.wizardAbort = null;
		}
	}

	/** Build a "provider/id" or null for the reviewer model, validating it exists. */
	private resolveReviewModel(spec?: string | null): {
		provider: string;
		id: string;
		spec: string;
	} | null {
		return parseModelSpec(spec);
	}

	/**
	 * The whitelisted reviewer plan — tell the reviewer what to decide and how
	 * to report, regardless of which model it runs on.
	 */
	private reviewerPrompt(
		goal: string,
		round: number,
		maxRounds: number,
		output: string,
		gitDiff: string,
		customPrompt = "",
	): string {
		return [
			`You are a strict, independent goal-reviewer. Your ONLY job is to judge whether the agent's work fully satisfies the stated goal, by checking the agent's final output and, when present, its git diff.`, // eslint-disable-line max-len
			``,
			`# Goal`,                 // eslint-disable-line no-regex-spaces
			goal,
			``,
			`# Agent's final output`,  // eslint-disable-line no-regex-spaces
			output.length > 0 ? output : "(the agent produced no text — inspect the diff)",  // eslint-disable-line max-len
			``,
			`# Git diff (if any)`,     // eslint-disable-line no-regex-spaces
			gitDiff.length > 0 ? gitDiff : "(no staged/committed changes detected)",  // eslint-disable-line max-len
			``,
			`This is review round ${round}${maxRounds > 0 ? ` of up to ${maxRounds}` : " (no round cap — keep revising until it passes)"}.`,   // eslint-disable-line max-len
			...(customPrompt.trim()
				? [``, `# Additional reviewer instructions`, customPrompt.trim()]
				: []),
			``,
			`Decide: does the work satisfy the goal? If yes, respond with ONLY a JSON object with this exact shape (no markdown fences, no extra text):`, // eslint-disable-line max-len
			`{"verdict":"pass","feedback":"<one short sentence: what was satisfied>"}`, // eslint-disable-line max-len
			`If NO, respond with ONLY: {"verdict":"fail","feedback":"<concise, actionable list of what the agent must fix to satisfy the goal>"}`, // eslint-disable-line max-len
			`The feedback for a fail must be specific enough that the agent can act on it directly.`, // eslint-disable-line max-len
		].join("\n");
	}

	/** Insert a wizard progress card into the MAIN conversation flow and render it
	 *  IMMEDIATELY (the main session is idle while the wizard runs in its own
	 *  session, so — unlike nextTurn, which queues until the next user prompt —
	 *  sending without a delivery option appends + persists + emits at once). */
	private async pushWizardCard(
		sess: AgentSession,
		text: string,
		details?: { question?: string; answer?: string },
	): Promise<void> {
		try {
			await sess.sendCustomMessage(
				{
					customType: "goal-wizard",
					content: [{ type: "text", text }],
					display: true,
					details: { type: "goal-wizard", ...details },
				},
				// No deliverAs / triggerTurn → immediate append while idle.
			);
		} catch {
			// Non-fatal
		}
	}

	/** Run a git diff (unstaged + staged) in a conversation's workspace, or
	 * "" when not a repo. */
	private async gitDiff(cwd: string): Promise<string> {
		try {
			const { code, out } = await this.runAsync(
				"git",
				["diff", "HEAD"],
				10_000,
				cwd,
			);
			if (code !== 0) return "";
			return out.slice(0, 60_000);
		} catch {
			return "";
		}
	}

	/**
	 * The review loop: build an ISOLATED reviewer session (own fresh
	 * AgentSession + own ModelRuntime so the reviewer truly runs on a different
	 * model without touching the main session), ask it to judge the goal, then:
	 *   - pass  → set status "已通过", insert a verdict card, end the loop;
	 *   - fail  → inject the feedback as a user message into the main session
	 *             to steer a revision; the next agent_end re-reviews with the
	 *             same round budget.
	 * Guarded per conversation so separate conversations can review concurrently.
	 */
	private isCurrentGoalReview(
		conv: Conversation,
		goalGeneration: number,
		reviewGeneration: number,
	): boolean {
		return (
			!this.disposed &&
			this.convs.get(conv.id) === conv &&
			conv.goal.conversationId === conv.id &&
			conv.goalGeneration === goalGeneration &&
			conv.goalReviewGeneration === reviewGeneration &&
			!!conv.goal.goal
		);
	}

	/** Drop the result of a review that became stale while it was awaiting the
	 * reviewer model (most commonly because the user switched conversations). */
	private discardStaleGoalReview(
		conv: Conversation,
		goalGeneration: number,
		reviewGeneration: number,
	): void {
		if (conv.goalReviewGeneration !== reviewGeneration) return;
		if (
			conv.goalGeneration === goalGeneration &&
			conv.goal.conversationId === conv.id
		) {
			conv.goal.reviewing = false;
			conv.goal.status = "审查已中止，目标已更新或取消";
			this.emitGoalStatus();
		}
	}

	private async runGoalReview(conv: Conversation): Promise<void> {
		// The review is bound to the conversation that just ran. Capture both the
		// owner and a generation so a later switch/set/clear cannot let an old,
		// asynchronous reviewer mutate the new conversation's goal state.
		const mainConv = this.convs.get(conv.id) ?? conv;
		const mainSession = mainConv.session;
		const g = conv.goal;
		if (
			!g.goal ||
			g.conversationId !== conv.id ||
			g.reviewing ||
			conv.wizardRunning ||
			this.disposed
		)
			return;
		const goalGeneration = conv.goalGeneration;
		const reviewGeneration = ++conv.goalReviewGeneration;
		// Narrowed copy — TS control-flow can't narrow `g.goal` (a mutable shared
		// object field) through the entire async body, so capture it here.
		const goalText: string = g.goal;
		// Capture review-only settings for this run. Changing settings while a
		// review is in flight affects the next review, never this one.
		const reviewPrefs = this.settingsSvc.reviewPrefs;
		const reviewPrompt = reviewPrefs.reviewPrompt;
		const reviewDisabledSkills = new Set(reviewPrefs.reviewDisabledSkills);

		// Cap rounds: single-shot (locked=false) always exactly one review.
		// For locked goals, maxRounds 0 = unlimited (keep revising until pass).
		const budget = g.locked ? (g.maxRounds > 0 ? g.maxRounds : Infinity) : 1;
		if (g.locked && g.maxRounds > 0 && g.round >= budget) {
			g.status = `已达最大轮数（${budget}），停止审查`;
			g.reviewing = false;
			this.emitGoalStatus();
			return;
		}

		g.reviewing = true;
		g.round += 1;
		g.verdict = "pending";
		g.feedback = undefined;
		g.status = `审查中（第 ${g.round} 轮）…`;
		this.emitGoalStatus();

		// Collect the review inputs.
		let finalText = "";
		try {
			finalText = mainSession.getLastAssistantText() ?? "";
		} catch {
			finalText = "";
		}
		const diff = await this.gitDiff(mainConv.cwd);
		if (!this.isCurrentGoalReview(conv, goalGeneration, reviewGeneration)) {
			this.discardStaleGoalReview(conv, goalGeneration, reviewGeneration);
			return;
		}

		let reviewerVerdict: "pass" | "fail" = "fail";
		let reviewerFeedback = "（审查无法完成）";

		try {
			const rmSpec = this.resolveReviewModel(g.reviewModel);
			const services = await createAgentSessionServices({
				cwd: mainConv.cwd,
				agentDir: this.agentDir,
				// The reviewer has its own skill allow/deny list. It deliberately does
				// not reuse the main session's disabledSkills setting.
				resourceLoaderOptions: {
					skillsOverride: (res) => ({
						...res,
						skills: res.skills.filter((s) => !reviewDisabledSkills.has(s.name)),
					}),
				},
				// A FRESH ModelRuntime for the reviewer — isolated from the shared
				// one used by the main conversations, so its model choice is its own.
				modelRuntime: await ModelRuntime.create({
					authPath: join(this.agentDir, "auth.json"),
					modelsPath: join(this.agentDir, "models.json"),
				}),
			});

			// Model resolution: explicit reviewer model, else the main session's
			// current model (so a goal works even when no reviewer model is given).
			let model;
			if (rmSpec) {
				model = services.modelRuntime.getModel(rmSpec.provider, rmSpec.id);
			}
			if (!model) {
				const mainModel = mainSession.model as { provider?: string; id?: string } | undefined;
				if (mainModel?.provider && mainModel.id) {
					model = services.modelRuntime.getModel(mainModel.provider, mainModel.id);
				}
			}

			const srv = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(mainConv.cwd),
				...(model ? { model } : {}),
			});
			const reviewCap = g.locked && g.maxRounds > 0 ? g.maxRounds : 0; // 0 = no cap
			const reviewer = srv.session;
			await reviewer.prompt(
				this.reviewerPrompt(
					goalText,
					g.round,
					reviewCap,
					finalText,
					diff,
					reviewPrompt,
				),
			);

			// Parse the reviewer's final output (expected to be a JSON object).
			const raw = reviewer.getLastAssistantText() ?? "";
			const m = raw.match(/\{\s*"verdict"\s*:\s*"(pass|fail)"[^}]*\}/);
			if (m) {
				reviewerVerdict = m[1] as "pass" | "fail";
				const fm = raw.match(/"feedback"\s*:\s*"([^"]*)"/);
				reviewerFeedback = fm?.[1] ?? "";
			} else {
				// No JSON — assume fail with the raw output as feedback.
				reviewerVerdict = "fail";
				reviewerFeedback = raw.slice(0, 2000);
			}
			await srv.session.dispose();
		} catch (err) {
			reviewerVerdict = "fail";
			reviewerFeedback = `审查过程中出错：${(err as Error).message}`;
		}

		// The user may have switched chats or replaced/cleared the goal while the
		// isolated reviewer was running. Never apply a stale verdict or inject it
		// into the old session after that point.
		if (!this.isCurrentGoalReview(conv, goalGeneration, reviewGeneration)) {
			this.discardStaleGoalReview(conv, goalGeneration, reviewGeneration);
			return;
		}
		g.reviewing = false;
		g.verdict = reviewerVerdict;
		g.feedback = reviewerFeedback;

		const round = g.round;
		// Display cap: 0 means "unlimited" (keep revising until pass).
		const budgetForCard = g.locked ? (Number.isFinite(budget) ? budget : 0) : 1;
		const verdict = reviewerVerdict;
		const feedback = reviewerFeedback;
		/** Format "round/cap" for user-facing strings; cap 0 → 不限. */
		const capFmt = (cap: number): string =>
			cap > 0 ? `第 ${round}/${cap} 轮` : `第 ${round} 轮（不限）`;

		if (verdict === "pass") {
			g.status = "✅ 已通过目标审查";
			this.emit({ type: "notice", level: "info", text: "✅ 目标已通过审查" });
			g.conversationId = null;
			g.goal = null; // a passed goal is done and cleared
			this.emitGoalStatus();
			// Pass = the review result goes straight into the conversation as an
			// ordinary user message (NO separate goal-review card). It both tells the
			// USER the outcome and hands the main agent back out of "goal mode", so a
			// follow-up instruction like "发布" is a normal request — not a confirm echo.
			try {
				await mainSession.sendUserMessage(
					`✅ 目标已达成并通过审查（第 ${round} 轮）。\n\n目标：${goalText}\n\n${feedback}\n\n（目标模式已解除，接下来按你的普通指令响应。）`,
					{ deliverAs: mainSession.isStreaming ? "steer" : "followUp" },
				);
			} catch {
				// Best-effort.
			}
			this.flushSnapshot();
			return;
		}

		// Failure: if rounds remain, steer a revision; else report the loop done.
		// For unlimited (budget=0) isLastRound is always false → keeps revising.
		const isLastRound = !g.locked ? true : g.maxRounds > 0 && g.round >= g.maxRounds;
		if (!isLastRound) {
			g.status = `本轮不通过，正在把意见交给 agent 修改（${capFmt(budgetForCard)}）…`;
			this.emit({
				type: "notice",
				level: "warning",
				text: `目标审查第 ${g.round}/${budgetForCard > 0 ? budgetForCard : "不限"} 轮未通过，把意见交给 agent 修改…`,
			});
			// Inject the reviewer's feedback into the main session to revise (this IS
			// the fail review result, as an ordinary user message — no separate card).
			try {
				const steerText =
					`【目标审查：第 ${g.round}/${budgetForCard > 0 ? budgetForCard : "不限"} 轮未通过】\n\n目标：${goalText}\n\n` +
					`审查意见：${feedback}\n\n请根据以上意见修改你的成果，使其完全满足目标。`;
				await mainSession.sendUserMessage(steerText, {
					deliverAs: mainSession.isStreaming ? "steer" : "followUp",
				});
			} catch (err) {
				g.status = `意见注入失败：${(err as Error).message}`;
			}
			this.emitGoalStatus();
			this.flushSnapshot();
			return;
		}

		// Rounds exhausted (finite cap reached / single-shot failed). Deliver the
		// fail result as an ordinary user message (no separate card), like the pass
		// and revise paths — the review result always lands in the conversation.
		g.status =
			g.locked && g.maxRounds > 0
				? `已达最大轮数（${g.maxRounds}），目标仍未通过`
				: `目标未通过（${capFmt(budgetForCard)}）`;
		try {
			await mainSession.sendUserMessage(
				`❌ 目标未通过审查（第 ${round}/${budgetForCard > 0 ? budgetForCard : "不限"} 轮）。\n\n目标：${goalText}\n\n审查意见：${feedback}`,
				{ deliverAs: mainSession.isStreaming ? "steer" : "followUp" },
			);
		} catch {
			// Best-effort.
		}
		this.emit({ type: "notice", level: "warning", text: "目标未通过审查（已达最大轮数）" });
		g.conversationId = null;
		g.goal = null; // loop exhausted — clear the active goal
		this.emitGoalStatus();
		this.flushSnapshot();
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
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换模型失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Set the thinking level for future turns. */
	setThinking(level: string): void {
		try {
			this.session.setThinkingLevel(
				level as Parameters<AgentSession["setThinkingLevel"]>[0],
			);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换思考强度失败：${(err as Error).message}`,
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
		this.emit({ type: "notice", level: "info", text: `命令已保存：${path}` });
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
	/**
	 * Set by index.ts: called by a client session after a successful
	 * self-update; returns whether the process will restart itself.
	 */
	onUpdateReady: (() => boolean) | undefined = undefined;
	/** Set by index.ts: called when /pi-web-ui:quit is invoked. */
	onQuit: (() => boolean) | undefined = undefined;

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
		return this.quiesced
			? { quiesced: true, quiescedSince: this.quiescedAt }
			: { quiesced: false };
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
	async attach(
		clientId: string,
		send: (msg: ServerMessage) => void,
	): Promise<ClientSession> {
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
				const creating = ClientSession.create(
					clientId,
					cwd,
					this.stateStore,
				).finally(() => {
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
					});
				}
			}
		}
		cs.attachSink(send);
		// Forward hooks (set once by index.ts) to every session.
		cs.onUpdateReady = this.onUpdateReady;
		cs.onQuit = this.onQuit;
		cs.isQuiesced = () => this.quiesced;
		return cs;
	}

	/** Remove a socket from a client's broadcast set (called on socket close). */
	detach(clientId: string, send: (msg: ServerMessage) => void): void {
		this.clients.get(clientId)?.detachSink(send);
	}

	get(clientId: string): ClientSession | undefined {
		return this.clients.get(clientId);
	}

	async disposeAll(): Promise<void> {
		const all = [...this.clients.values()];
		this.clients.clear();
		await Promise.all(all.map((cs) => cs.dispose()));
	}
}
