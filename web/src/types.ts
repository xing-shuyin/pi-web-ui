/**
 * Wire protocol types — mirrors server/protocol.ts (kept in sync by hand).
 * Types only; no shared runtime code.
 */

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
	id: string;
	role: string;
	content: UiContentBlock[];
	timestamp?: number;
	model?: string;
	provider?: string;
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	customType?: string;
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
	 * Live partial assistant message while a run is streaming (server sends the
	 * SDK's state.streamingMessage in every snapshot; null when idle). Rendered
	 * after `messages` with a live cursor.
	 */
	streamingMessage?: UiMessage | null;
	isStreaming: boolean;
	model: UiModelInfo | null;
	thinkingLevel: string;
	/** Model-supported thinking levels; UI must only offer these (mirror of protocol.ts). */
	availableThinkingLevels: string[];
	queue: { steering: number; followUp: number };
	errorMessage?: string;
	tools: string[];
	version: number;
	/** Whether the pi agent config looks ready (auth.json has credentials). */
	piConfigured?: boolean;
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

export interface CommandDef {
	name: string;
	/** Shell command to run in the terminal. */
	command: string;
	/** Working directory; supports ${pwd} (= the agent's current workspace dir). */
	cwd?: string;
}

/** A slash command available in the chat input (mirror of SlashCommandInfo). */
export interface SlashCommandInfo {
	/** Invokable command name without the leading slash (e.g. "new",
	 *  "skill:review", "templatename"). */
	name: string;
	description?: string;
	/** Argument placeholder shown in the picker (e.g. "<路径>", "[说明]"). */
	argumentHint?: string;
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
	  }
	| { type: "terminal_input"; terminalId: string; data: string }
	| { type: "terminal_resize"; terminalId: string; cols: number; rows: number }
	| { type: "terminal_kill"; terminalId: string }
	// Runs a command in a new shell; if the terminal already exists it is
	// RESTARTED in place (current process killed, fresh shell runs it again).
	| {
			type: "run_command";
			terminalId: string;
			command: CommandDef;
			cols: number;
			rows: number;
	  }
	// -- command list (.pi/commands.json) ------------------------------------
	| { type: "list_commands" }
	| { type: "save_commands"; commands: CommandDef[] }
	| { type: "abort" }
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
	| { type: "install_pi_agent" }
	| { type: "set_provider_api_key"; provider: string; apiKey: string }
	// -- custom model config (agentDir/models.json) ---------------------------
	| { type: "list_models_config" }
	| { type: "save_model_config"; providerId: string; config: UiProviderConfig }
	| { type: "delete_model_config"; providerId: string }
	| { type: "list_providers" }
	// -- goal / review -------------------------------------------------------
	/** Set (or clear) the active goal. See server/protocol.ts GoalStatus. */
	| {
			type: "set_goal";
			goal: string;
			reviewModel?: string;
			maxRounds: number;
			locked: boolean;
	  }
	| { type: "clear_goal" }
	/** Start the collaborative target wizard (isolated scoping session that
	 *  questions the user and auto-sets the refined goal). */
	| { type: "start_goal_wizard"; text: string; wizardModel?: string; maxRounds?: number; locked?: boolean }
	/** Persist goal/review preference defaults (model, rounds cap, locked). */
	| {
			type: "set_goal_prefs";
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
	  };

export interface SessionSummary {
	path: string;
	name?: string;
	firstMessage: string;
	messageCount: number;
	modified: number;
	/** Where the session lives: this UI's per-client dir, or the pi CLI/TUI dir. */
	source?: "web" | "tui";
}

/** A workspace directory this client has opened before (recent-project picker). */
export interface ProjectSummary {
	/** Absolute path of the workspace directory. */
	path: string;
	/** Last time this workspace was used (ms epoch) — drives the sort order. */
	lastUsed: number;
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

export interface FileListing {
	path: string;
	parent: string | null;
	entries: FileEntry[];
	/**
	 * The directory had more entries than the platform cap (win32: 2000,
	 * posix: 500) — the list was cut short. UI shows a hint when true.
	 */
	truncated: boolean;
}

/** Content of a workspace file fetched for the preview panel. */
export interface FileContent {
	path: string;
	name: string;
	/**
	 * Preview category: media kinds render via the /api/file HTTP endpoint
	 * (text stays empty); "none" means not previewable.
	 */
	kind: "image" | "video" | "text" | "none";
	text: string;
	truncated: boolean;
	binary: boolean;
	lines: number;
	size: number;
}

/** Current state of the goal-review loop, shown in the goal bar UI. */
export interface GoalStatus {
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
	/** Collaborative target-wizard progress (null when no wizard is running). */
	wizard: WizardStatus;
}

/** Progress of the collaborative target wizard (see GoalStatus.wizard). */
export interface WizardStatus {
	active: boolean;
	draft: string;
	model: string | null;
	step: number;
	maxSteps: number;
	status: string;
}

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	/** Whether the model accepts image input (SDK `input` includes "image"). */
	vision: boolean;
}

/** One model definition inside a custom provider (agentDir/models.json). */
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
	api?: string;
	baseUrl?: string;
	apiKey?: string;
	authHeader?: boolean;
	headers?: Record<string, string>;
	models: UiModelConfigEntry[];
}

/** One of pi's built-in providers, with whether auth is configured. */
export interface ProviderStatus {
	id: string;
	name: string;
	configured: boolean;
	source?: string;
}

/** A tool FINISHED executing (mirrors the tool_status ServerMessage). */
export interface ToolStatus {
	toolCallId: string;
	toolName: string;
	isError: boolean;
	/** Exit code when the tool result carries one (bash: parsed from error text). */
	exitCode?: number;
	/** tool_execution_start → tool_execution_end, in ms. */
	durationMs?: number;
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
	| { type: "tool_delta"; toolCallId: string; toolName: string; delta: string }
	/** A tool finished executing (SDK tool_execution_end) — flips the tool card
	 *  to "done" immediately, before the model's next response lands. */
	| {
			type: "tool_status";
			toolCallId: string;
			toolName: string;
			isError: boolean;
			exitCode?: number;
			durationMs?: number;
	  }
	// -- terminal ------------------------------------------------------------
	| { type: "terminal_output"; terminalId: string; data: string }
	| { type: "terminal_exit"; terminalId: string; exitCode: number | null }
	// -- command list (.pi/commands.json) ------------------------------------
	| { type: "commands"; commands: CommandDef[]; path: string }
	/** The slash-command catalog for the chat input (builtin + extension +
	 *  prompt template + skill commands). */
	| { type: "slash_commands"; commands: SlashCommandInfo[] }
	| { type: "notice"; level: "info" | "warning" | "error"; text: string }
	/** Sent every ~10s so clients can detect half-open connections. */
	| { type: "heartbeat" }
	| { type: "sessions"; sessions: SessionSummary[] }
	| { type: "projects"; projects: ProjectSummary[] }
	| {
			type: "files";
			path: string;
			parent: string | null;
			entries: FileEntry[];
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
			kind: "image" | "video" | "text" | "none";
			text: string;
			truncated: boolean;
			binary: boolean;
			lines: number;
			size: number;
	  }
	| { type: "models"; models: ModelInfo[] }
	| { type: "models_config"; providers: UiProviderConfig[] }
	| { type: "providers_status"; providers: ProviderStatus[] }
	| { type: "install_result"; ok: boolean; detail: string }
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
	/** Server resolved (or abandoned) a dialog — the client must close it. */
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
	/** Goal status pushed whenever it changes (drives the goal bar UI). */
	| { type: "goal_status"; status: GoalStatus }
