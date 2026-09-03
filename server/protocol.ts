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
	/** Monotonic snapshot revision — increments on every snapshot/snapshot_delta
	 *  emission. snapshot_delta.baseRev must equal the client's current rev;
	 *  a mismatch means the client missed an update and must get_state resync. */
	rev: number;
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
	/** Queued prompt TEXTS per conversation. steering = 插队（当前回合结算后
	 *  立即注入），followUp = 排队（整个 run 结束后才发送）。UI renders them
	 *  as pending user bubbles in the real message list. */
	queue: { steering: string[]; followUp: string[] };
	errorMessage?: string;
	tools: string[];
	/** Monotonic snapshot sequence — clients can use it to drop stale snapshots. */
	version: number;
	/**
	 * Whether the pi agent has at least one usable model. The SDK resolves
	 * models.json together with auth.json, environment credentials, OAuth, and
	 * runtime API-key overrides. False → offer the one-time setup flow.
	 */
	piConfigured: boolean;
	/**
	 * Whether the pi CLI binary is installed and runnable (`pi --version`
	 * probe). True → the setup modal skips the install step and offers the
	 * API key form directly; false → offer auto-install first.
	 */
	piAgentInstalled: boolean;
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
	/** true = 终端接管 bash 的持久终端（'ai-bash'）：不计入终端数量上限，
	 *  前端把它单独归到「AI bash」折叠分组里。缺省 false = 用户终端。 */
	agentBash?: boolean;
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
	 *  prompt template / skill / UI plugin（registerCommand）。 */
	source: "builtin" | "extension" | "prompt" | "skill" | "plugin";
}

/** Attachment spec shared by "prompt" and "edit_message" client messages:
 *  workspace-path attachments (inline/reference/lines), raw pasted/dropped
 *  images (imageData) and raw uploaded files (fileData). */
export interface PromptAttachment {
	path: string;
	mode?: "inline" | "reference" | "lines";
	/** 1-based inclusive line range (mode "lines" only). */
	lines?: { start: number; end: number };
	/**
	 * Raw image data (base64, no data: prefix) for images pasted, dropped or
	 * uploaded directly in the browser — no workspace path involved. When
	 * present the server sends it to the model as image content and ignores
	 * path/mode.
	 */
	imageData?: string;
	/**
	 * Raw uploaded file bytes (base64, no data: prefix) for files dropped/
	 * uploaded directly in the browser — no workspace path involved. The
	 * server persists them under the data dir and attaches as a path
	 * reference (or inlines small text files).
	 */
	fileData?: string;
	/**
	 * Absolute path of a previously-UPLOADED file (fileData) that was
	 * persisted under the data dir's uploads/ folder. When the browser
	 * restores an uploaded file while editing & re-asking a question it
	 * re-sends the server-generated upload path instead of the original
	 * base64 — the server re-reads the bytes from disk (no base64
	 * round-trip / snapshot bloat). Mutually exclusive with imageData /
	 * fileData / path.
	 */
	uploadPath?: string;
	mimeType?: string;
	/** Display name for the attachment card (filename, or "粘贴图片.png"). */
	name?: string;
	/** Decoded byte size, for the card's size hint. */
	size?: number;
}

export type ClientMessage =
	| { type: "hello"; clientId: string; protocolVersion?: number }
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
			attachments?: PromptAttachment[];
	  }
	// -- queued prompt management ---------------------------------------------
	/** Remove ONE queued prompt (steer = 插队, followUp = 排队) by text — the
	 *  ✕ delete button on a pending user bubble. Removes the FIRST occurrence of
	 *  `text` in the matching queue and pushes a fresh snapshot so the bubble
	 *  disappears immediately. */
	| {
			type: "queue_remove";
			kind: "steer" | "followUp";
			text: string;
	  }
	// -- terminal ------------------------------------------------------------
	| {
			type: "terminal_create";
			terminalId: string;
			title?: string;
			/** UI locale ("zh" | "en") — server picks the exit-banner language. */
			locale?: string;
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
	// Re-discover extensions/skills/prompt templates from disk after an
	// external change (e.g. `pi remove npm:<pkg>` finished in the terminal).
	// Streaming-safe: deferred to agent_end while a run is in flight.
	| { type: "extensions_reload" }
	// -- command list (.pi/commands.json) ------------------------------------
	| { type: "list_commands" }
	| { type: "save_commands"; commands: CommandDef[] }
	| { type: "abort" }
	/** Kill only the running bash command(s) — the agent run itself continues. */
	| { type: "abort_bash" }
	// -- background tasks (AI-started servers) ------------------------------
	/** Kill ONE background server the agent started (by listening port). */
	| { type: "kill_background_server"; port?: number; taskId?: string }
	/** Kill EVERY background server the agent started (frees all ports). */
	| { type: "kill_background_servers" }
	/** Re-push the current background-server list (the server also refreshes it
	 *  on its own and prunes entries whose process exited). */
	| { type: "list_bg_servers" }
	/** Global-search recursive filename match across the active workspace.
	 *  Server-side bounded walk; reqId echoes back in search_files_result. */
	| { type: "search_files"; reqId: number; query: string }
	/** Global-search conversation-content match across this workspace's
	 *  persisted session transcripts — every user AND assistant message,
	 *  AI output included. reqId echoes back in session_search_results. */
	| { type: "search_sessions"; reqId: number; query: string }
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
	| {
			type: "edit_message";
			messageId: string;
			text: string;
			/**
			 * Attachments to send along with the re-asked question. The editor
			 * pre-fills it with the original message's attachments (images →
			 * imageData, uploaded files → uploadPath, workspace paths →
			 * path+mode; fork drops the persisted attachment asides — they live
			 * on the old branch, past the fork point) and accepts newly
			 * pasted/dropped images and files.
			 */
			attachments?: PromptAttachment[];
	  }
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
	/**
	 * Upload one file INTO a workspace directory (file manager right-click
	 * context menu — blank area or a folder entry). data = raw base64 with
	 * NO data: prefix; name is basename-sanitized server-side. The server
	 * answers with a notice (+ file_changed so the listing refreshes).
	 */
	| { type: "upload_file"; dirPath: string; name: string; data: string }
	| { type: "list_models" }
	| { type: "set_model"; modelId: string }
	| { type: "set_thinking"; level: string }
	| { type: "set_cwd"; path: string }
	| { type: "complete_path"; path: string }
	| { type: "dialog_response"; id: number; value: string | boolean | null }
	// -- self-update ----------------------------------------------------------
	/** Check the npm registry for a newer pi-web-ui version. */
	| { type: "check_update" }
	| { type: "check_updates_all"; force?: true } // webui + direct pi extensions (manifest)
	// -- pi agent setup ------------------------------------------------------
	/** Auto-install the pi agent (mkdir config dir + npm i -g the CLI). */
	| { type: "install_pi_agent" }
	/** Persist an api-key credential for a provider (auth.json) and apply it now. */
	| { type: "set_provider_api_key"; provider: string; apiKey: string }
	/** Clear a built-in provider's stored key (auth.json entry + runtime
	 *  override) so it returns to the unconfigured state. Only meaningful for
	 *  keys whose auth status reports source "stored". */
	| { type: "clear_provider_api_key"; provider: string }
	// -- built-in provider multiple keys (one provider, several API keys) -----
	/** List every stored API key for each built-in provider (NICKNAMES only — raw
	 *  apiKey and masked fragments NEVER leave the server). Pushed on attach and
	 *  after any change. */
	| { type: "list_provider_keys" }
	/** Add a SECONDARY API key to a built-in provider's key list. `name` is the
	 *  only thing the frontend ever sees (auto-generated when blank); the key
	 *  value travels here ONCE and is stored server-side. The added key stays
	 *  INACTIVE so the current active key keeps routing; the user switches to it
	 *  by clicking a model under the key's group in the picker — or by name. When
	 *  the provider has no key yet, the added key becomes the active one. */
	| { type: "add_provider_key"; provider: string; apiKey: string; name?: string }
	/** Make a stored API key the ACTIVE one for a built-in provider by NAME
	 *  (syncs auth.json + runtime override + refreshes models). The server
	 *  resolves the stored key value from the name. */
	| { type: "activate_provider_key"; provider: string; keyName: string }
	/** Remove a stored API key from a built-in provider by NAME. If it was the
	 *  active key, the first remaining key becomes active (or the provider
	 *  returns to unconfigured when no key is left). */
	| { type: "remove_provider_key"; provider: string; keyName: string }
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
	/** Re-probe a SAVED provider's /models endpoint and merge the result into
	 *  its models.json entry. Credentials stay server-side (the browser never
	 *  sees apiKey/headers); reqId is echoed in refresh_provider_result. */
	| { type: "refresh_provider_models"; providerId: string; reqId: number }
	/** Copy a BUILT-IN provider (baseUrl + current model catalog) into an
	 *  editable custom-provider draft — the point is running a second API key
	 *  alongside the built-in one without overwriting it. Nothing is saved
	 *  until save_model_config; the draft comes back in clone_provider_result
	 *  with a fresh provider id and an EMPTY apiKey for the user to fill. */
	| { type: "clone_provider"; provider: string; reqId: number }
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
			/** Installed UI plugins hidden in the settings panel (UI-only toggle,
			 *  never triggers a runtime reload). */
			disabledPlugins?: string[];
			/** Persistent-terminal tools on/off (default on). Off → terminal_* tools
			 *  are removed from the active tool set and the built-in usage guidance
			 *  disappears from the system prompt. */
			terminalToolsEnabled?: boolean;
			/** 终端接管 bash 开关 + 静默解阻阈值毫秒（0 = 一直等到命令结束）。 */
			terminalBash?: boolean;
			terminalBashIdleMs?: number;
			/** 思考文本是否换行（默认开）。纯 UI 偏好，不需要 reload runtime。 */
			thinkingWrap?: boolean;
			/** 工具调用是否默认展开（默认开）。纯 UI 偏好，不需要 reload runtime。 */
			toolsWrap?: boolean;
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
	// -- plugins (<dataDir>/plugins) -----------------------------------------
	/** App-level message from a plugin's client bundle to its server side.
	 *  Routed by pluginId; unknown/failed plugins are silently ignored. */
	| { type: "plugin_message"; pluginId: string; payload: unknown }
	/** Re-scan the plugin directory: deactivate removed entries, activate new
	 *  ones, bump the epoch and re-push the catalog. Same spirit as
	 *  extensions_reload but for pi-web-ui's own UI plugins. */
	| { type: "plugins_reload" }
	/** Save the CURRENT settings as a named preset (overwrites if it exists). */
	| { type: "save_preset"; name: string }
	/** Save a UI plugin's declarative settings (manifest "settings" schema).
	 *  The host validates against the schema, persists to storage.json and
	 *  notifies the plugin (host.onSettingsChanged). */
	| { type: "plugin_settings"; pluginId: string; values: Record<string, unknown> }
	// -- DSH engine user patches (<dataDir>/dsh-patches) ---------------------
	/** List <dataDir>/dsh-patches/*.yml (DSH engine only; pi engine ignores). */
	| { type: "dsh_patches_list" }
	/** Re-scan <dataDir>/dsh-patches and restart the DSH runtime so new/edited
	 *  patch files take effect (patches are only loaded at runtime boot). */
	| { type: "dsh_patches_rescan" }
	/** DSH engine: answer a model ask_user_question dialog (id echoes
	 *  question_pending.id). `cancelled` (user ✗) rejects the pending ask. */
	| {
			type: "question_answer";
			id: string;
			answers: { id: string; selected: string[]; custom?: string }[];
			cancelled?: boolean;
	  }
	/** Replace the current settings with the named preset and apply it. */
	| { type: "apply_preset"; name: string }
	/** Remove the named preset. */
	| { type: "delete_preset"; name: string }
	/** Drop one workspace from this client's recent-project list (UI state
	 *  only — nothing on disk is touched). */
	| { type: "remove_project"; path: string }
	/** Permanently delete a persisted session transcript file (history list). */
	| { type: "delete_session"; path: string };

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

/** 会话转录中一条命中消息的定位锚点：会话载入后按 role + timestamp 在
 *  UiMessage[] 里找到对应消息，用于「搜索会话 → 跳到对应位置」。 */
export interface MessageAnchor {
	role: string;
	timestamp: number;
}

/** 会话内容搜索结果：会话摘要 + 命中消息锚点（可能为空 ——
 *  仅元数据/文件名命中时无从定位，跳转退化为直接打开会话）。 */
export interface SessionSearchResult extends SessionSummary {
	/** 按转录顺序排列的命中消息（最多若干条）；客户端取第一条做跳转。 */
	anchors: MessageAnchor[];
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
	/** Port the server listens on (the stable key for agent-started servers).
	 *  Plugin-registered tasks have no port — they carry taskId/plugin instead. */
	port?: number;
	/** Process id of the listening process (agent-started servers). */
	pid?: number;
	/** Plugin task id (host.registerBackgroundTask) — present for plugin tasks. */
	taskId?: string;
	/** Plugin id that registered this task (kill routing). */
	plugin?: string;
	/** When the server/task was first detected or registered (ms epoch). */
	since: number;
	/** Best-effort process name (tasklist / ps), undefined when unknown. */
	name?: string;
	/** Best-effort full command line (PowerShell CIM / ps -o command=) so the
	 *  panel can show WHAT is actually running, undefined when unknown. */
	command?: string;
	/** 插件任务的活动状态文案（如轮询间隔、连接数），可经 update 刷新。 */
	status?: string;
}

/** One filename match from the global-search recursive workspace walk. */
export interface FileSearchResult {
	/** Workspace-relative path ("/"-separated). */
	path: string;
	name: string;
	type: "file" | "dir";
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
	/** Human-readable status line (e.g. "审查中", "已通过", "本轮不通过"). UI locale at emit time (zh default). */
	status: string;
	/** English status line (client shows it when locale is en). */
	statusEn?: string;
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
	/** Short status line for the goal bar (e.g. "调研中：请回答第 2 题"). UI locale at emit time (zh default). */
	status: string;
	/** English wizard status line (client shows it when locale is en). */
	statusEn?: string;
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

// ---------------------------------------------------------------------------
// Plugins (optional UI components dropped into <dataDir>/plugins/<id>/)
// ---------------------------------------------------------------------------

/** One installed pi-web-ui plugin (see server/plugins.ts). A plugin is a
 *  directory under <dataDir>/plugins/<id>/ with a manifest.json and optional
 *  server entry (index.mjs) + client view bundle (client/entry.mjs). Not
 *  bundled with the app — users install by dropping the directory in and
 *  restarting (or reconnecting: the list is re-scanned on every attach). */

/** 一个声明式设置字段（manifest "settings" 数组里的元素）。 */
export interface UiPluginSettingField {
	/** 字段 key（storage.json settings 对象里的键；同一插件内唯一）。 */
	key: string;
	/** 控件类型：文本 / 密码 / 数字 / 开关 / 下拉。 */
	type: "text" | "password" | "number" | "boolean" | "select";
	/** 表单里的显示名。 */
	label: string;
	/** 未保存过时的默认值。 */
	default?: string | number | boolean;
	/** number 用：范围。 */
	min?: number;
	max?: number;
	/** select 用：候选值。 */
	options?: string[];
	/** 帮助文案（悬浮提示/小字）。 */
	hint?: string;
}

export interface UiPluginInfo {
	/** Directory name; must match ^[A-Za-z0-9_-]+$ (path-safety). */
	id: string;
	/** Display label from manifest.json (shown as the view tab). */
	name: string;
	version?: string;
	description?: string;
	/** A client/entry.mjs exists → the frontend should load its view bundle. */
	hasClient: boolean;
	/** Optional emoji/single-char icon from manifest.json — shown instead of
	 *  the generic puzzle glyph on the view tab. */
	icon?: string;
	/** The plugin failed to activate (bad entry / thrown error) — UI shows it
	 *  greyed out instead of a dead tab. */
	error?: string;
	/** Declared capabilities from manifest.json (e.g. "fs", "net", "tools") —
	 *  informational for now: surfaced in the settings panel so users can see
	 *  what a plugin claims to touch before trusting it. */
	permissions?: string[];
	/** Declarative settings schema from manifest.json "settings" — rendered as a
	 *  form in the main ⚙ panel (type/label/default/min/max/options). */
	settingsSchema?: UiPluginSettingField[];
	/** Current stored values (storage.json "settings" key, defaults applied). */
	settingsValues?: Record<string, unknown>;
	/** Install source recorded by `pi-web-ui install` (<dir>/.pi-source.json):
	 *  the original spec the user typed (owner/repo, URL or local path). The
	 *  settings panel offers an Update button only when this exists. */
	source?: string;
}

/** One of pi's built-in providers, with whether auth is configured. */
export interface ProviderStatus {
	id: string;
	name: string;
	configured: boolean;
	/** Where auth came from: stored / runtime / environment / models_json_key … */
	source?: string;
}

/** One stored API key for a built-in provider (NICKNAME only — the raw apiKey
 *  and any masked fragment never leave the server). A provider can hold several
 *  keys — exactly one is active and routes the provider's requests. The UI groups
 *  models by key name so clicking a model under a key activates that key on the
 *  fly; the server resolves the stored value from the name. */
export interface ProviderKeyInfo {
	/** User-chosen (or auto-generated) name — the ONLY identifier the frontend
	 *  sees. Unique per provider. */
	name: string;
	/** true = this key currently routes requests for the provider. */
	active: boolean;
}
/** ONE RUNNING conversation (each runs its own session in parallel). The
 *  list is GLOBAL across projects — a background run from another workspace
 *  stays visible until it is opened and left without continuing — and only
 *  contains conversations that were displaced to the background while still
 *  streaming; background-finish keeps them listed, opening-and-leaving-
 *  without-continuing removes them. cwd lets the client group by project. */
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
	/** Persistent-terminal tools on/off (default on). Off → terminal_* tools are
	 *  removed from the active set and the guidance prompt is not injected. */
	terminalToolsEnabled: boolean;
	/** 终端接管 bash（默认关）：bash 执行体改为持久终端（可见/保留状态/静默转后台）。 */
	terminalBash: boolean;
	/** 接管模式下 bash 的静默解阻阈值毫秒数（0 = 一直等到命令结束）。 */
	terminalBashIdleMs: number;
	/** 思考文本是否换行（默认开 = pre-wrap；关 = 长行横向滚动）。 */
	thinkingWrap: boolean;
	/** 工具调用是否默认展开（默认开 = 展开；关 = 折叠）。 */
	toolsWrap: boolean;
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
	/** Installed UI plugins the user hid in the settings panel (UI-only:
	 *  hidden tabs/views; server-side handlers stay reachable). */
	disabledPlugins: string[];
	/** The built-in default system prompt (what replace mode would otherwise
	 *  replace) — prefill source for the replace-mode editor. Empty until the
	 *  resource-loader has run at least once. */
	defaultSystemPrompt: string;
	/** The FULL system prompt actually in effect for the active conversation
	 *  (custom append/replace text + project context + skills + tool guidance).
	 *  Read-only view source for the settings panel; empty until the session
	 *  is ready. */
	effectiveSystemPrompt: string;
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
	| {
			type: "ready";
			clientId: string;
			serverVersion: string;
			/** 引擎标识（pi | dsh）—— 前端据此显示引擎徽标（只读展示）。 */
			engine?: string;
			/** Wire-protocol version (server/protocol-version.ts). The client
			 *  compares it against its own copy — a mismatch means the page was
			 *  loaded before an app update and must be refreshed. */
			protocolVersion?: number;
	  }
	| { type: "snapshot"; state: UiState }
	| {
			/** Incremental snapshot: everything EXCEPT `messages` travels in
			 *  `state`, and only messages appended since baseRev ride in
			 *  `appended`. Persisted messages are content-immutable with stable
			 *  ids, so any mid-array change/truncation (switch session, fork,
			 *  compaction) makes the server fall back to a full snapshot instead.
			 *
			 *  Droppable under backpressure exactly like `snapshot`: a dropped
			 *  delta breaks the client's rev chain, and the next surviving full
			 *  snapshot (or the client's get_state after detecting the gap)
			 *  reconciles — memory stays bounded, correctness self-heals. */
			type: "snapshot_delta";
			conversationId: string;
			rev: number;
			baseRev: number;
			appended: UiMessage[];
			state: Omit<UiState, "messages" | "rev"> & { rev: number };
	  }
	| {
			// Global running-conversation list (see ConversationSummary): all
			// listed conversations across every project. activeId is the active
			// conversation even when it isn't listed (fresh chat).
			type: "conversations";
			conversations: ConversationSummary[];
			activeId: string;
	  }
	| {
			type: "tool_delta";
			conversationId: string;
			/** Per-conversation monotonic sequence, shared with message_delta —
			 *  a gap tells the client to resync via get_state. */
			seq: number;
			toolCallId: string;
			toolName: string;
			delta: string;
	  }
	/** Live assistant-message increment (thinking/text deltas + usage) that
	 *  deliberately BYPASSES the snapshot channel: send() drops snapshots under
	 *  backpressure, but this message is small and must always get through, so
	 *  big sessions keep rendering live even when full snapshots are dropped.
	 *  seq is per-conversation monotonic — a gap tells the client to resync via
	 *  get_state. The next snapshot remains authoritative and reconciles any
	 *  drift (deltas only patch streamingMessage + stats.tokens). */
	| {
			type: "message_delta";
			conversationId: string;
			seq: number;
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
	| { type: "notice"; level: "info" | "warning" | "error"; text: string; textEn?: string }
	/** The watched git dir changed outside the panel (terminal commit,
	 *  CLI, IDE) — the client should re-run its scm_status query. */
	| { type: "scm_changed" }
	/** Sent every ~10s so clients can detect half-open connections. */
	| { type: "heartbeat" }
	| { type: "sessions"; sessions: SessionSummary[] }
	/** Filename matches for the global search panel (reqId echo). Always sent
	 *  in reply to a search_files request — ok:false means the walk failed. */
	| {
			type: "search_files_result";
			reqId: number;
			ok: boolean;
			results: FileSearchResult[];
			/** Walk stopped early (result/time/entry budget hit). */
			truncated?: boolean;
	  }
	/** Conversation-content matches for the global search panel (reqId echo).
	 *  ok:false means the transcript scan failed — treat as no results. */
	| {
			type: "session_search_results";
			reqId: number;
			query: string;
			ok: boolean;
			results: SessionSearchResult[];
	  }
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
	/** All stored API keys per built-in provider (masked). Keyed by providerId. */
	| { type: "provider_keys"; keys: Record<string, ProviderKeyInfo[]> }
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
	/** Result of refresh_provider_models: merged into the saved entry; added =
	 *  newly-discovered model ids, total = models now in the saved config. */
	| {
			type: "refresh_provider_result";
			reqId: number;
			ok: boolean;
			added?: number;
			total?: number;
			error?: string;
	  }
	/** Result of clone_provider: a ready-to-edit custom-provider draft
	 *  (baseUrl + model catalog copied from the built-in provider; apiKey
	 *  intentionally empty). Not persisted until save_model_config.
	 *  Multi-api providers (e.g. opencode) return `configs` (one per api) —
	 *  `config` is kept as configs[0] for backward compat. */
	| {
			type: "clone_provider_result";
			reqId: number;
			ok: boolean;
			config?: UiProviderConfig;
			configs?: UiProviderConfig[];
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
			error?: string;
	  }
	/** Result of a check_updates_all run — one item per checked component
	 *  (webui, the pi core, direct pi extensions). Failed lookups degrade
	 *  per-item. */
	| {
			type: "update_status_all";
			items: {
				name: string;
				kind: "webui" | "pi-core" | "package";
				current: string;
				latest: string | null;
				latestPublishedAt?: string | null;
				upToDate: boolean;
				error?: string;
			}[];
	  }
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
	// -- plugins (<dataDir>/plugins) -----------------------------------------
	/** Installed-plugin catalog. Pushed on attach (the dir is re-scanned each
	 *  time so freshly dropped plugins appear without a server restart) and
	 *  after every plugins_reload. `epoch` increments on every server-side
	 *  reload; the frontend uses it as an import-cache buster so changed
	 *  bundles are actually re-fetched. */
	| { type: "plugins"; plugins: UiPluginInfo[]; epoch: number }
	/** App-level message from a plugin's server side to its client bundles.
	 *  Broadcast to every connected socket (plugins have no per-client state
	 *  in v1); the frontend fans it out to the matching loaded view. */
	| { type: "plugin_data"; pluginId: string; payload: unknown }
	// -- DSH engine user patches --------------------------------------------
	/** List of <dataDir>/dsh-patches/*.yml files (DSH engine only; pi engine
	 *  never emits it). Pushed on request (dsh_patches_list) and after a
	 *  rescan (dsh_patches_rescan). */
	| { type: "dsh_patches"; patchDir: string; files: { name: string; path: string; size: number; mtimeMs: number }[] }
	/** DSH engine: the model asked the user (ask_user_question tool). The
	 *  frontend shows a dialog and answers via question_answer. One pending
	 *  question at a time per client (the runtime blocks the agent loop). */
	| {
			type: "question_pending";
			id: string;
			/** 服务端超时时间戳（epoch ms，P0-6）；前端显示倒计时，归零自动取消。 */
			deadline?: number;
			questions: {
				id: string;
				question: string;
				detail?: string;
				header?: string;
				options?: { label: string; description?: string }[];
				multiSelect?: boolean;
			}[];
	  }
	// -- background tasks ---------------------------------------------------
	/** The background-server list (servers the agent left running, detected via
	 *  listening-port diffs around bash tool runs). Per CLIENT, not per
	 *  conversation — the list survives conversation switches/ends and only
	 *  empties when the tasks are stopped (individually or all at once) or the
	 *  process exits on its own. Pushed on change, on attach and on request. */
	| { type: "bg_servers"; servers: BgServer[] }
