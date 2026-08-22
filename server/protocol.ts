/**
 * Wire protocol between the browser client and the pi-web-ui server.
 * Pure JSON over WebSocket. The web frontend mirrors these types in
 * web/src/types.ts (kept in sync by hand — types only, no shared runtime code).
 */

// ---------------------------------------------------------------------------
// Serialized messages (server -> client snapshot)
// ---------------------------------------------------------------------------

export interface UiTextBlock {
	type: "text";
	text: string;
	truncated?: boolean;
}

export interface UiThinkingBlock {
	type: "thinking";
	thinking: string;
}

export interface UiToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	argumentsText?: string;
	argumentsTruncated?: boolean;
}

export interface UiImageBlock {
	type: "image";
	dataUrl?: string;
	mimeType?: string;
}

/** Live bash execution (the `!` command / bashExecution transcript message). */
export interface UiBashBlock {
	type: "bash";
	command: string;
	output: string;
	exitCode?: number;
	cancelled?: boolean;
	truncated?: boolean;
}

export type UiContentBlock =
	| UiTextBlock
	| UiThinkingBlock
	| UiToolCallBlock
	| UiImageBlock
	| UiBashBlock
	| { type: string; [k: string]: unknown };

export interface UiMessage {
	/** Stable-ish id for React keys: u-<ts>-<seq> / a-<ts>-<seq> / t-<toolCallId>. */
	id: string;
	role: string;
	content: UiContentBlock[];
	timestamp?: number;
	model?: string;
	provider?: string;
	stopReason?: string;
	errorMessage?: string;
	/** Present on toolResult messages; links to the assistant message's toolCall block. */
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	/** Extension-injected custom messages. */
	customType?: string;
	/** Extension-provided metadata (e.g. attachment file name/path). */
	details?: unknown;
}

export interface UiModelInfo {
	id: string;
	name: string;
	provider: string;
	/** Whether the model accepts image input (SDK `input` includes "image"). */
	vision: boolean;
}

export interface UiState {
	clientId: string;
	cwd: string;
	sessionId: string;
	sessionFile?: string;
	/** Id of the ACTIVE conversation (see `conversations` message). */
	conversationId: string;
	messages: UiMessage[];
	/**
	 * Live partial assistant message while a run is streaming. The SDK keeps the
	 * in-progress message in agent.state.streamingMessage — it only enters
	 * `messages` once the turn finishes (message_end). Null when idle.
	 */
	streamingMessage: UiMessage | null;
	isStreaming: boolean;
	model: UiModelInfo | null;
	thinkingLevel: string;
	/**
	 * Thinking levels the CURRENT model actually supports (SDK clamps any
	 * request outside this set). The UI must only offer these — selecting an
	 * unsupported level silently snaps to a nearby one, which reads as "cannot
	 * change the level". Empty/absent → fall back to the full list.
	 */
	availableThinkingLevels: string[];
	queue: { steering: number; followUp: number };
	errorMessage?: string;
	tools: string[];
	/** Monotonic snapshot sequence — clients can use it to drop stale snapshots. */
	version: number;
	/**
	 * Whether the pi agent config looks ready (agentDir + auth.json with at
	 * least one provider credential). False → the client should offer the
	 * one-time auto-install flow.
	 */
	piConfigured: boolean;
	/** Live session stats for the footer status bar. */
	stats: {
		totalMessages: number;
		tokens: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
		cost: number;
		contextUsage: {
			tokens: number | null;
			contextWindow: number;
			percent: number | null;
		};
	};
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

/** A user-defined command shown in the terminal command list (.pi/commands.json). */
export interface CommandDef {
	name: string;
	/** Shell command to run in the terminal. */
	command: string;
	/** Working directory; supports ${pwd} (= the agent's current workspace dir). */
	cwd?: string;
}

/** Metadata for a persistent PTY owned by one conversation. */
export interface TerminalInfo {
	id: string;
	title: string;
	cwd: string;
	cols: number;
	rows: number;
	running: boolean;
	exitCode: number | null;
	/** Command that started this terminal, when it came from the command list. */
	command?: CommandDef;
}

/** A slash command available in the chat input (the web counterpart of the
 *  pi CLI's "/" command menu). Names carry no leading slash. */
export interface SlashCommandInfo {
	/** Invokable command name without the leading slash (e.g. "new",
	 *  "skill:review", "templatename"). Extension collisions with builtin
	 *  names are suffixed by the SDK ("new:2"), like the CLI. */
	name: string;
	description?: string;
	descriptionEn?: string;
	/** Argument placeholder shown in the picker (e.g. "<路径>", "[说明]"). */
	argumentHint?: string;
	argumentHintEn?: string;
	/** Where the command comes from: web-native builtin / SDK extension /
	 *  prompt template / skill. */
	source: "builtin" | "extension" | "prompt" | "skill";
}

export type ClientMessage =
	| { type: "hello"; clientId: string }
	/** Re-request the slash-command catalog (also pushed on attach / cwd change). */
	| { type: "get_commands" }
	| {
			type: "prompt";
			text: string;
			/**
			 * While the agent is streaming: queue this prompt and deliver it after
			 * the WHOLE run finishes (followUp) instead of steering (injecting it
			 * right after the current turn settles, skipping remaining tool calls).
			 * The 补充 (supplement) button sends queue=true; plain Enter keeps the
			 * steer semantic.
			 */
			queue?: boolean;
			attachments?: {
				path: string;
				mode?: "inline" | "reference" | "lines";
				/** 1-based inclusive line range (mode "lines" only). */
				lines?: { start: number; end: number };
				/**
				 * Raw image data (base64, no data: prefix) for images pasted,
				 * dropped or uploaded directly in the browser — no workspace path
				 * involved. When present the server sends it to the model as image
				 * content and ignores path/mode.
				 */
				imageData?: string;
				/**
				 * Raw uploaded file bytes (base64, no data: prefix) for files
				 * dropped/uploaded directly in the browser — no workspace path
				 * involved. The server persists them under the data dir and
				 * attaches as a path reference (or inlines small text files).
				 */
				fileData?: string;
				mimeType?: string;
				/** Display name for the attachment card (filename, or "粘贴图片.png"). */
				name?: string;
				/** Decoded byte size, for the card's size hint. */
				size?: number;
			}[];
	  }
	// -- terminal ------------------------------------------------------------
	| {
			type: "terminal_create";
			terminalId: string;
			cwd: string;
			cols: number;
			rows: number;
			/** Optional because old UI clients target the active conversation. */
			conversationId?: string;
	  }
	| { type: "terminal_input"; terminalId: string; data: string; conversationId?: string }
	| { type: "terminal_resize"; terminalId: string; cols: number; rows: number; conversationId?: string }
	| { type: "terminal_kill"; terminalId: string; conversationId?: string }
	// Runs a command in a new shell; if the terminal already exists it is
	// RESTARTED in place (current process killed, fresh shell runs it again).
	| {
			type: "run_command";
			terminalId: string;
			command: CommandDef;
			cols: number;
			rows: number;
			conversationId?: string;
	  }
	// -- command list (.pi/commands.json) ------------------------------------
	| { type: "list_commands" }
	| { type: "save_commands"; commands: CommandDef[] }
	| { type: "abort" }
	/** Kill only the running bash command(s) — the agent run itself continues. */
	| { type: "abort_bash" }
	// -- background tasks (AI-started servers) ------------------------------
	/** Kill ONE background server the agent started (by listening port). */
	| { type: "kill_background_server"; port: number }
	/** Kill EVERY background server the agent started (frees all ports). */
	| { type: "kill_background_servers" }
	/** Re-push the current background-server list (the server also refreshes it
	 *  on its own and prunes entries whose process exited). */
	| { type: "list_bg_servers" }
	// -- source-control panel (read-only git queries, server-side execFile) --
	/** SCM refresh payload: status + branches + numstat (history loads
	 *  lazily via scm_history so big repos don't pay for it every refresh). */
	| { type: "scm_status"; reqId: number }
	/** Commit graph for the history tab (lazy-loaded). */
	| { type: "scm_history"; reqId: number }
	/** Staged + worktree diffs for one file. */
	| { type: "scm_filediff"; reqId: number; path: string }
	/** Full patch of one commit. */
	| { type: "scm_commit"; reqId: number; hash: string }
	| { type: "new_chat" }
	/** Edit a past user question and re-ask it (forks a new session at that point). */
	| { type: "edit_message"; messageId: string; text: string }
	| { type: "cycle_model" }
	| { type: "cycle_thinking" }
	| { type: "get_state" }
	| { type: "list_sessions" }
	| { type: "switch_session"; path: string }
	| { type: "switch_conversation"; id: string }
	| { type: "list_projects" }
	| { type: "list_files"; path?: string }
	/** Read a workspace file for the preview panel (size-capped, binary-safe). */
	| { type: "read_file"; path: string }
	/** Save text edited in the file preview panel. */
	| { type: "write_file"; path: string; text: string }
	| { type: "list_models" }
	| { type: "set_model"; modelId: string }
	| { type: "set_thinking"; level: string }
	| { type: "set_cwd"; path: string }
	| { type: "complete_path"; path: string }
	| { type: "dialog_response"; id: number; value: string | boolean | null }
	// -- self-update ----------------------------------------------------------
	/** Check the npm registry for a newer pi-web-ui version. */
	| { type: "check_update" }
	/** npm i -g pi-web-ui@latest (restart required to take effect). */
	| { type: "update_app" }
	// -- pi agent setup ------------------------------------------------------
	/** Auto-install the pi agent (mkdir config dir + npm i -g the CLI). */
	| { type: "install_pi_agent" }
	/** Persist an api-key credential for a provider (auth.json) and apply it now. */
	| { type: "set_provider_api_key"; provider: string; apiKey: string }
	// -- custom model config (agentDir/models.json) ---------------------------
	| { type: "list_models_config" }
	/** Upsert one provider (api/baseUrl/apiKey + its models) into models.json. */
	| { type: "save_model_config"; providerId: string; config: UiProviderConfig }
	/** Remove a provider from models.json. */
	| { type: "delete_model_config"; providerId: string }
	/** List pi's built-in providers with their auth status (key-only config). */
	| { type: "list_providers" }
	/** Probe a custom provider's OpenAI-compatible /models endpoint and return
	 *  the advertised model ids. Runs SERVER-side (the baseUrl is often a
	 *  LAN/loopback host the browser can't reach cross-origin). reqId is echoed
	 *  back in fetch_models_result so the UI can match concurrent requests. */
	| {
			type: "fetch_models";
			reqId: number;
			baseUrl: string;
			apiKey?: string;
			authHeader?: boolean;
			/** api type: openai-completions / openai-responses / anthropic-messages / google-generative-ai. */
			api?: string;
	  }
	// -- goal / review -------------------------------------------------------
	/** Set (or clear) the active goal. When set, each finished agent run is
	 *  reviewed by an isolated reviewer agent; a failing review steers the main
	 *  session to revise until `maxRounds` runs out. `locked: true` keeps the
	 *  goal active across every subsequent turn; `false` clears it after the
	 *  next turn (single-shot). `reviewModel` ("provider/id", optional) selects
	 *  a different model for the reviewer. */
	| { type: "set_goal"; goal: string; reviewModel?: string; maxRounds: number; locked: boolean }
	| { type: "clear_goal" }
	/** Start the collaborative target wizard: a user requirement goes into an
	 *  ISOLATED wizard session which questions the user (multiple-choice + free
	 *  text bridges) to scope details, then AUTO-SETS the refined goal. `text` is
	 *  the user's raw requirement. `wizardModel` ("provider/id", optional) picks
	 *  a different model for the wizard; default is the main conversation model.
	 *  Mutually exclusive with an active review and with a running wizard. */
	| { type: "start_goal_wizard"; text: string; wizardModel?: string; maxRounds?: number; locked?: boolean }
	/** Persist the client's goal/review preference defaults (model choice, review
	 *  rounds cap, locked) so they survive reload. maxRounds 0 = unlimited.
	 *  Sent by the goal bar whenever a preference changes (model picker, rounds,
	 *  lock toggle). */
	| {
			type: "set_goal_prefs";
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
	  }
	// -- settings (system prompt / skills / extensions / presets) ------------
	/** Request the current settings state (also pushed automatically on attach). */
	| { type: "get_settings" }
	/** Apply a partial settings update: main-session prompt/toggles or isolated
	 *  reviewer prompt/skill toggles. Each change is persisted per client; main
	 *  session changes reload the runtime, while review changes affect the next review. */
	| {
			type: "set_settings";
			promptMode?: "append" | "replace";
			customSystemPrompt?: string;
			disabledSkills?: string[];
			disabledExtensions?: string[];
			/** Vision bridge on/off + preferred "provider/id" model (null = auto). */
			visionBridgeEnabled?: boolean;
			visionBridgeModel?: string | null;
			/** Vision-bridge transcription prompt: mode (append/replace, same
			 *  semantics as promptMode) + custom text (empty = built-in default). */
			visionBridgePromptMode?: "append" | "replace";
			visionBridgePrompt?: string;
			/** Extra instructions and independently disabled skills for review. */
			reviewPrompt?: string;
			reviewDisabledSkills?: string[];
	  }
	/** Save the CURRENT settings as a named preset (overwrites if it exists). */
	| { type: "save_preset"; name: string }
	/** Replace the current settings with the named preset and apply it. */
	| { type: "apply_preset"; name: string }
	/** Remove the named preset. */
	| { type: "delete_preset"; name: string };

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export interface SessionSummary {
	path: string;
	name?: string;
	firstMessage: string;
	messageCount: number;
	modified: number;
	/** Where the session lives: this UI's per-client dir, or the pi CLI/TUI dir. */
	source?: "web" | "tui";
}

/**
 * A workspace directory this client has opened before (persisted per client in
 * <dataDir>/client-state.json, merged with cwds found in the session store).
 */
export interface ProjectSummary {
	/** Absolute path of the workspace directory. */
	path: string;
	/** Last time this workspace was used (ms epoch) — drives the sort order. */
	lastUsed: number;
}

/** A background server the agent left running (listening-port diff around a
 *  bash tool run). Keyed by port. Managed from the 后台任务 panel: each entry
 *  can be stopped individually or all at once, and the list persists even
 *  after the conversation that started them ends. */
export interface BgServer {
	/** Port the server listens on (the stable key). */
	port: number;
	/** Process id of the listening process. */
	pid: number;
	/** When the server was first detected (ms epoch). */
	since: number;
	/** Best-effort process name (tasklist / ps), undefined when unknown. */
	name?: string;
}
export interface FileEntry {
	name: string;
	/** Path relative to the workspace root ('' for the root itself). */
	path: string;
	type: "file" | "dir";
	/**
	 * Preview category (files only; undefined for dirs). "none" files are
	 * never previewed — the UI doesn't open them and read_file refuses them.
	 */
	kind?: "image" | "video" | "text" | "none";
}

// -- source-control panel (wire shapes shared by scm_data) -------------------

export interface ScmFileEntry {
	/** Repo-relative path. */
	path: string;
	/** porcelain index (staged) status letter. */
	x: string;
	/** porcelain worktree status letter. */
	y: string;
}

export interface ScmBranchEntry {
	name: string;
	current: boolean;
	/** Remote name for remote-tracking refs ("origin/main" → "origin"). */
	remote?: string | boolean;
}

export interface ScmCommitEntry {
	hash: string;
	shortHash: string;
	author: string;
	date: string;
	subject: string;
	decorations: string;
	/** The graph prefix emitted by `git log --graph` (for example `| * `). */
	graph: string;
}

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	/** Whether the model accepts image input (SDK `input` includes "image"). */
	vision: boolean;
}

// ---------------------------------------------------------------------------
// Goal / review status (server -> client snapshot)
// ---------------------------------------------------------------------------

/** Current state of the goal-review loop, shown in the goal bar UI. */
export interface GoalStatus {
	/** Conversation that owns this goal; null when no goal is set. */
	conversationId: string | null;
	/** Active goal text; null when no goal is set. */
	goal: string | null;
	/** Reviewer model id ("provider/id"), or null to use the main model. */
	reviewModel: string | null;
	/** Maximum number of review rounds per goal run. */
	maxRounds: number;
	/** Whether the goal persists across turns (locked) or just the next one. */
	locked: boolean;
	/** True while a review is running right now. */
	reviewing: boolean;
	/** 1-based round counter for the current goal (review rounds). */
	round: number;
	/** Human-readable status line (e.g. "审查中", "已通过", "本轮不通过"). */
	status: string;
	/** Latest review verdict: "pending" | "pass" | "fail". */
	verdict: "pending" | "pass" | "fail";
	/** Latest review feedback text (reviewer's verdict reason, pass or fail). */
	feedback?: string;
	/** Collaborative target-wizard progress (null when no wizard is running).
	 *  The wizard turns a raw user requirement into a refined goal by asking
	 *  questions, then auto-sets the goal. */
	wizard: WizardStatus;
}

/** Progress of the collaborative target wizard (see GoalStatus.wizard). */
export interface WizardStatus {
	/** True while the wizard session is asking the user questions. */
	active: boolean;
	/** The user's raw requirement being scoped. */
	draft: string;
	/** Wizard model id ("provider/id"), or null for the main model default. */
	model: string | null;
	/** Question count asked so far (UI shows the step). */
	step: number;
	/** Max questions the wizard may ask before forcing a conclusion. */
	maxSteps: number;
	/** Short status line for the goal bar (e.g. "调研中：请回答第 2 题"). */
	status: string;
}

// ---------------------------------------------------------------------------
// Custom model configuration (agentDir/models.json) — browser-editable shape
// ---------------------------------------------------------------------------

/** One model definition inside a custom provider. */
export interface UiModelConfigEntry {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
}

/** A custom provider block in models.json (providers.<id>). */
export interface UiProviderConfig {
	providerId: string;
	name?: string;
	/** api type: openai-completions / openai-responses / anthropic-messages / google-generative-ai. */
	api?: string;
	baseUrl?: string;
	apiKey?: string;
	authHeader?: boolean;
	/** headers are NOT returned to the browser — they can contain Authorization
	 *  / API-key values; saveModelConfig preserves them server-side. */
	models: UiModelConfigEntry[];
}

/** One of pi's built-in providers, with whether auth is configured. */
export interface ProviderStatus {
	id: string;
	name: string;
	configured: boolean;
	/** Where auth came from: stored / runtime / environment / models_json_key … */
	source?: string;
}
/** One RUNNING conversation of the current project (each runs its own session
 *  in parallel). The list is per project and only contains conversations that
 *  were displaced to the background while still streaming; background-finish
 *  keeps them listed, opening-and-leaving-without-continuing removes them. */
export interface ConversationSummary {
	id: string;
	/** Display title: first user prompt (truncated) or the default. */
	title: string;
	cwd: string;
	messageCount: number;
	isStreaming: boolean;
}

// ---------------------------------------------------------------------------
// Settings (system prompt / skills / extensions / presets)
// ---------------------------------------------------------------------------

/** One loaded skill, with whether it is currently enabled. Disabled skills are
 *  excluded from the system prompt and from the /skill: command catalog. */
export interface UiSkillInfo {
	name: string;
	description: string;
	enabled: boolean;
}

/** One loaded extension, with whether it is currently enabled. Disabled
 *  extensions are unloaded from the runtime (tools/commands disappear). */
export interface UiExtensionInfo {
	/** Stable identity for the toggle: the npm spec for packages, the resolved
	 *  entry path otherwise. */
	id: string;
	/** Display label: npm package spec (npm:pi-foo) or the path basename. */
	name: string;
	/** Resolved entry path. */
	path: string;
	enabled: boolean;
}

/** A named combination of prompt mode/text + disabled skills/extensions that
 *  the user can re-apply in one click. Persisted per client. */
export interface UiSettingsPreset {
	name: string;
	promptMode: "append" | "replace";
	customSystemPrompt: string;
	disabledSkills: string[];
	disabledExtensions: string[];
	/** Extra instructions and skill toggles for the isolated goal-reviewer. */
	reviewPrompt: string;
	reviewDisabledSkills: string[];
}

/** One vision-capable model the vision bridge can use (picker option). */
export interface UiVisionBridgeModel {
	provider: string;
	id: string;
	/** Human-readable label: "qwen3-vl-plus (dashscope)". */
	label: string;
}

/** Full settings state pushed to the browser (settings_state). */
export interface UiSettingsState {
	promptMode: "append" | "replace";
	customSystemPrompt: string;
	disabledSkills: string[];
	disabledExtensions: string[];
	/** Vision bridge on/off (default on). Off → images are sent as-is. */
	visionBridgeEnabled: boolean;
	/** Preferred vision model as "provider/id", or null = auto-detect first. */
	visionBridgeModel: string | null;
	/** Vision-bridge transcription prompt mode: append to the built-in default
	 *  prompt, or replace it entirely (empty text = built-in default). */
	visionBridgePromptMode: "append" | "replace";
	/** Custom vision-bridge transcription prompt text. */
	visionBridgePrompt: string;
	/** Extra instructions appended to the built-in goal-review prompt. */
	reviewPrompt: string;
	/** Skills disabled only for the isolated goal-reviewer. */
	reviewDisabledSkills: string[];
	/** The built-in default system prompt (what replace mode would otherwise
	 *  replace) — prefill source for the replace-mode editor. Empty until the
	 *  resource-loader has run at least once. */
	defaultSystemPrompt: string;
	/** The built-in default vision-bridge transcription prompt. */
	visionBridgeDefaultPrompt: string;
	/** Vision-capable configured models available on this machine. */
	visionModels: UiVisionBridgeModel[];
	skills: UiSkillInfo[];
	/** Same skill catalog with enabled flags evaluated for the reviewer. */
	reviewSkills: UiSkillInfo[];
	extensions: UiExtensionInfo[];
	presets: UiSettingsPreset[];
}
export type ServerMessage =
	| { type: "ready"; clientId: string; serverVersion: string }
	| { type: "snapshot"; state: UiState }
	| {
			// Per-project running-conversation list (see ConversationSummary):
			// only conversations of the CURRENT cwd that are listed. activeId is
			// the active conversation even when it isn't listed (fresh chat).
			type: "conversations";
			conversations: ConversationSummary[];
			activeId: string;
	  }
	| {
			type: "tool_delta";
			toolCallId: string;
			toolName: string;
			delta: string;
	  }
	| {
			type: "message_delta";
			messageId: string;
			usage: { input: number; output: number; total: number } | null;
			assistantMessageEvent: { type: string; contentIndex?: number; delta?: string };
	  }
	/** A tool FINISHED executing (SDK tool_execution_end). Unlike toolResult
	 *  snapshot messages, this arrives the moment the command exits — before
	 *  the model's next response starts — so the UI can show "done, waiting
	 *  for the model" instead of an indefinite "running". */
	| {
			type: "tool_status";
			toolCallId: string;
			toolName: string;
			isError: boolean;
			/** Exit code when the tool result carries one (bash returns it in details). */
			exitCode?: number;
			/** tool_execution_start → tool_execution_end, in ms. */
			durationMs?: number;
	  }
	// -- terminal ------------------------------------------------------------
	| { type: "terminal_output"; conversationId?: string; terminalId: string; data: string }
	| { type: "terminal_exit"; conversationId?: string; terminalId: string; exitCode: number | null }
	| { type: "terminal_list"; conversationId?: string; terminals: TerminalInfo[] }
	// -- command list (.pi/commands.json) ------------------------------------
	| { type: "commands"; commands: CommandDef[]; path: string }
	/** The slash-command catalog for the chat input (builtin + extension +
	 *  prompt template + skill commands). Pushed on attach, on project switch
	 *  and on request (get_commands). */
	| { type: "slash_commands"; commands: SlashCommandInfo[] }
	| { type: "notice"; level: "info" | "warning" | "error"; text: string }
	/** The watched git dir changed outside the panel (terminal commit,
	 *  CLI, IDE) — the client should re-run its scm_status query. */
	| { type: "scm_changed" }
	/** Sent every ~10s so clients can detect half-open connections. */
	| { type: "heartbeat" }
	| { type: "sessions"; sessions: SessionSummary[] }
	| { type: "projects"; projects: ProjectSummary[] }
	| {
			type: "files";
			path: string;
			parent: string | null;
			entries: FileEntry[];
			/**
			 * The directory had more entries than the platform cap (win32: 2000,
			 * posix: 500) — the list was cut short. UI shows a hint when true.
			 */
			truncated: boolean;
	  }
	/** Content of a workspace file for the preview panel. */
	/** The server fs.watches the currently-listed directory and pushes this on
	 *  any file change so the client can refresh the listing instantly
	 *  (path = the listed directory; unknown/unsupported fs falls back to the
	 *  10s polling). */
	| { type: "file_changed"; path: string }
	| {
			type: "file_content";
			path: string;
			name: string;
			/**
			 * Preview category: media kinds render via the /api/file HTTP
			 * endpoint (text stays empty); "none" means not previewable.
			 */
			kind: "image" | "video" | "text" | "none";
			text: string;
			truncated: boolean;
			binary: boolean;
			/** Total line count of the *read* portion (equal to lines in text). */
			lines: number;
			/** Total file size in bytes. */
			size: number;
	  }
	| { type: "models"; models: ModelInfo[] }
	| { type: "models_config"; providers: UiProviderConfig[] }
	| { type: "providers_status"; providers: ProviderStatus[] }
	/** Result of a fetch_models probe: ok + the advertised models (id plus
	 *  whatever metadata the endpoint provided — contextWindow / vision input /
	 *  reasoning / name / maxTokens — same shape as models.json rows), or an
	 *  error string. */
	| {
			type: "fetch_models_result";
			reqId: number;
			ok: boolean;
			models?: UiModelConfigEntry[];
			error?: string;
	  }
	/** Result of an install_pi_agent run (npm i -g finished or failed). */
	| { type: "install_result"; ok: boolean; detail: string }
	// -- source-control panel results (see scm_status / scm_filediff / scm_commit) --
	| {
			type: "scm_data";
			reqId: number;
			kind: "status" | "history" | "filediff" | "commit";
			ok: boolean;
			error?: string;
			/** status payload — fields optional so one wire type carries every
			 *  kind; the client reads the ones matching `kind`. */
			notRepo?: boolean;
			branch?: string;
			detached?: boolean;
			upstream?: string | null;
			ahead?: number;
			behind?: number;
			upstreamGone?: boolean;
			files?: ScmFileEntry[];
			branches?: ScmBranchEntry[];
			stats?: Record<string, [number, number]>;
			history?: ScmCommitEntry[];
			/** filediff payload */
			stagedText?: string;
			worktreeText?: string;
			untracked?: boolean;
			/** commit payload */
			text?: string;
  }
	| {
			type: "path_completions";
			completions: { name: string; path: string; type: "dir" | "file" }[];
	  }
	| { type: "widgets"; widgets: { key: string; lines: string[] }[] }
	| { type: "statuses"; statuses: { key: string; text: string | undefined }[] }
	| {
			type: "dialog";
			id: number;
			kind: "select" | "confirm" | "input";
			title: string;
			args: unknown[];
	  }
	/** The server resolved (or abandoned) a dialog — the client must close it. */
	| { type: "dialog_closed"; id: number }
	// -- self-update ----------------------------------------------------------
	/** Result of a check_update run (current/latest from the npm registry). */
	| {
			type: "update_status";
			/** Version of the RUNNING process (from its own package.json). */
			current: string;
			latest: string | null;
			/** Publish timestamp (ISO) of the latest version — lets the UI hint
			 * when it was just published and registry caches may lag. */
			latestPublishedAt: string | null;
			upToDate: boolean;
			/** True after a successful update — restart required to take effect. */
			pendingRestart: boolean;
			error?: string;
	  }
	/** Result of an update_app run (npm i -g). */
	| { type: "update_result"; ok: boolean; detail: string }
	// -- goal / review -------------------------------------------------------
	/** Goal status pushed whenever it changes (set / review start-end / verdict).
	 *  Review result CARDS are inserted into the main conversation flow as real
	 *  custom messages (rendered like an attachment card), so they persist across
	 *  snapshots/reconnects — this only drives the goal bar status. */
	| { type: "goal_status"; status: GoalStatus }
	/** Current settings state (system prompt mode/text, enabled skills &
	 *  extensions, saved presets). Pushed on attach and after every settings
	 *  change. */
	| { type: "settings_state"; settings: UiSettingsState }
	// -- background tasks ---------------------------------------------------
	/** The background-server list (servers the agent left running, detected via
	 *  listening-port diffs around bash tool runs). Per CLIENT, not per
	 *  conversation — the list survives conversation switches/ends and only
	 *  empties when the tasks are stopped (individually or all at once) or the
	 *  process exits on its own. Pushed on change, on attach and on request. */
	| { type: "bg_servers"; servers: BgServer[] }
