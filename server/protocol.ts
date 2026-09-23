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
	UiTextBlock | UiThinkingBlock | UiToolCallBlock | UiImageBlock | UiBashBlock | { type: string; [k: string]: unknown };

export interface UiMessage {
	/** Stable-ish id for React keys: u-<ts>-<seq> / a-<ts>-<seq> / t-<toolCallId>. */
	id: string;
	role: string;
	content: UiContentBlock[];
	timestamp?: number;
	model?: string;
	provider?: string;
	/** Assistant message usage cost in USD (from SDK usage.cost.total).
	 *  Useful for plugins tracking per-provider or metered costs. */
	usageCost?: number;
	stopReason?: string;
	errorMessage?: string;
	/** Present on toolResult messages; links to the assistant message's toolCall block. */
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	/** Extension-injected custom messages. */
	customType?: string;
	/** Extension-provided metadata (e.g. attachment file name/path). Also carried on
	 *  toolResult messages (the tool's own `details`, ≤64KB or dropped — serialize.ts):
	 *  present_files' preview cards read kind/size/excerpt from it. */
	details?: unknown;
	/** Present on compactionSummary messages: context size (tokens) before
	 *  compaction — the card header renders "compacted from N tokens" like
	 *  the pi CLI. Absent on older snapshots. */
	tokensBefore?: number;
}

export interface UiModelInfo {
	id: string;
	name: string;
	provider: string;
	/** Whether the model accepts image input (SDK `input` includes "image"). */
	vision: boolean;
}

/** Platform service manager supervising this instance: someone restarts the
 *  process after it exits. Detected at boot by server/launch-origin.ts. */
export type ServiceSupervisor = "launchd" | "systemd" | "windows-watchdog";

/** How this instance was launched, when a supervisor manages it.
 *
 *  `pi-web-ui server start|install` registers a service (launchd / systemd /
 *  Windows watchdog launcher); the browser uses this to offer "restart
 *  service" in the UPDATE panel — meaningless for a foreground `pi-web-ui`
 *  or `npm run dev` instance, whose process would simply be gone. */
export interface UiServiceInfo {
	/** Service name (`server install --name`, default "pi-web-ui"). */
	name: string;
	supervisor: ServiceSupervisor;
}

export interface UiHostMetrics {
	cpuPercent: number | null;
	memoryPercent: number;
}

export interface UiState {
	clientId: string;
	cwd: string;
	sessionId: string;
	sessionFile?: string;
	/** 额外工作区根（宿主侧多根，见 set_workspace_roots）：按项目（cwd）持久化。
	 *  AI 仍只在主 cwd 里干活（pi SDK 是单 cwd 模型）；右栏文件树可跨这些根浏览，
	 *  插件的受支持路径（host.fs / host.project.create）也把这些根当作「工作区内」。
	 *  空数组/缺省 = 单根。DSH 引擎不提供该字段。 */
	workspaceRoots?: string[];
	/** 服务进程所在机器的用户主目录（wire 格式，`/` 分隔）：右栏 🏠 一键直达。
	 *  缺省/空串 = 旧服务（不提供）→ 前端不渲染 🏠。DSH 与 pi 双引擎都填。 */
	homeDir?: string;
	/** 桌面目录（wire 格式，同 homeDir 口径）：存在才提供，否则空串/缺省 → 前端不渲染 🖥️。
	 *  DSH 与 pi 双引擎都填。 */
	desktopDir?: string;
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
	/** DSH 当前会话的 Agent 预设（standard/ptc/minimal/cordis/自建；
	 *  pi 引擎不填。locked = 首轮后锁定，空白可切换）。 */
	agentPreset?: { id: string; name: string; locked: boolean } | null;
	/** DSH 当前会话的权限预设值（read-only/workspace-write-never/danger-full-access/custom；
	 *  pi 引擎不填。null = 运行时未就绪/legacy）。 */
	permission?: string | null;
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
	/**
	 * Transient LLM auto-retry state — set while the SDK backs off and retries
	 *  a failed API call (agent_end willRetry → auto_retry_start → auto_retry_end).
	 *  While present the trailing stopReason=error assistant message is withheld
	 *  from `messages` (it only turns red permanently once retries are exhausted),
	 *  and the UI shows a calm "retrying…" hint instead of a flashing red error.
	 *  Absent/null when idle or on final failure.
	 */
	retry?: {
		/** 1-based attempt about to run (0 = announced by agent_end willRetry, details follow). */
		attempt: number;
		maxAttempts: number;
		delayMs: number;
		errorMessage: string;
	} | null;
	/**
	 * Context compaction in progress (compaction_start arrived, compaction_end
	 *  not yet). While present the UI shows a persistent "compacting…"
	 *  progress banner with elapsed time (a toast would auto-dismiss while
	 *  the summarization LLM call is still running). Absent/null when idle.
	 */
	compaction?: {
		/** Why compaction started: manual (/compact), threshold or overflow. */
		reason: string;
		/** Server-side start timestamp (ms) — drives the elapsed timer. */
		startedAt: number;
	} | null;
	/**
	 * 待用户回答的模型提问（ask_user_question）——对话框的服务端事实源。
	 *  `question_pending` 只在提问发生的那一刻推给「当前激活且匹配该会话」的连接；刷新页面 /
	 *  WS 重连 / 切换会话接入后本字段让快照把属于当前会话的对话框恢复出来（见 web/src/use-chat.ts
	 *  的 syncPendingQuestion）。
	 *  只携带当前对话的提问（切回原对话会重推快照，对话框随之回来）。
	 *  null / 缺省 = 当前对话没有待答提问。
	 */
	pendingQuestion?: UiPendingQuestion | null;
	/**
	 * 当前对话的未发送输入框草稿（issue #166，单中心文件方案）。
	 *  只在**全量快照**里携带（切会话 / new_chat / get_state）：增量
	 *  snapshot_delta 永远不带 —— 同一标签页的草稿本来就是自己打的，不需要
	 *  每 60ms 回显；刷新/重连/切会话时的那次全量快照负责恢复。
	 *  null / 缺省 = 当前会话没有存过的草稿。pi 引擎独有（DSH 不填）。
	 */
	draft?: { text: string; ts: number } | null;
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
			/** true = 压缩后 SDK 暂报 null（下轮模型响应前不可信），此处用
			 *  compaction_end 的 estimatedTokensAfter 回填的约数，UI 加 `~` 标识。 */
			estimated?: boolean;
			/** 当前模型的生效压缩软上限（tokens；null = 关闭，底栏不画标记线）。 */
			softCap?: number | null;
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
 *  workspace-path attachments (inline/reference/lines), an already-granted web
 *  page (page), raw pasted/dropped images (imageData) and raw uploaded files
 *  (fileData). */
export interface PromptAttachment {
	/** Workspace path — except for mode "page", where it is the page's origin
	 *  (e.g. "https://example.com"), which is also the browser_page `target`,
	 *  and mode "conversation", where it is unused ("") — the reference
	 *  travels in conversationId/sessionPath instead. */
	path: string;
	/** "page" = a web page granted to the AI via the page-picker extension:
	 *  the server never stats/reads it — it only tells the model which
	 *  browser_page target to use. `name` carries the page title.
	 *  "conversation" = another conversation quoted by the user (left-panel
	 *  right-click / global-search quote): the server emits a small
	 *  <conversation-ref> aside pointing at it, and the model fetches the
	 *  transcript on demand with the conversation_read tool. */
	mode?: "inline" | "reference" | "lines" | "page" | "conversation";
	/** mode "conversation" + 引用运行中对话：conversation id（如 "c3"，含子代理）。 */
	conversationId?: string;
	/** mode "conversation" + 引用历史会话：会话转录文件 path（左栏历史行 / 全局搜索）。 */
	sessionPath?: string;
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
	| { type: "hello"; clientId: string; protocolVersion?: number; locale?: string }
	/** Browser UI language changed (or first report after hello) — server
	 *  persists it per client and uses it for tool return values / AI-facing
	 *  prompts. "zh" (zh-CN/…) → Chinese; anything else → English
	 *  (English default, issue #91). */
	| { type: "set_locale"; locale: string }
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
	/** Remove ONE queued prompt (steer = 插队, followUp = 排队) — the
	 *  ✕ delete button on a pending user bubble. `index` is the bubble's position
	 *  in the snapshot queue the user clicked (identity); `text` is a fallback
	 *  for old clients. Removes the item AT `index` when it still holds `text`,
	 *  else the FIRST occurrence of `text`, and pushes a fresh snapshot so the
	 *  bubble disappears immediately. */
	| {
			type: "queue_remove";
			kind: "steer" | "followUp";
			text: string;
			/** Bubble position in queue.steering / queue.followUp. Optional: old
			 *  clients send text only (first-occurrence fallback). */
			index?: number;
	  }
	// -- unsent composer draft (issue #166, 单中心文件方案) -------------------------
	/** Save the current unsent composer text for the ACTIVE conversation
	 *  (server keys it by sessionId in <dataDir>/composer-drafts.json).
	 *  Debounced client-side; empty text deletes the stored draft. The server
	 *  clears it when a prompt is accepted, and replays it in full snapshots
	 *  (switch/get_state) so refresh/reconnect restores the composer.
	 *  pi engine only — DSH clients never send this (gated by useIsDsh). */
	| {
			type: "draft_update";
			/** 归属会话（uuidv7）：切会话时的「离开刷盘」晚于服务端切换到达，
			 *  不能按 active 会话落键，必须自带 id。 */
			sessionId: string;
			text: string;
			ts: number;
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
			/** true = AI bash terminal (terminal-bash takeover). The client echoes it
			 *  back when it re-creates an exited terminal so the rebuilt one keeps its
			 *  identity (issue #147: without it, AI terminals were reborn as user
			 *  terminals and blew the 16-slot cap). Absent = false; the server also
			 *  inherits the prior value from history for old clients. */
			agentBash?: boolean;
	  }
	| { type: "terminal_input"; terminalId: string; data: string; conversationId?: string }
	| { type: "terminal_resize"; terminalId: string; cols: number; rows: number; conversationId?: string }
	| { type: "terminal_kill"; terminalId: string; conversationId?: string }
	| { type: "rename_terminal"; terminalId: string; title: string; conversationId?: string }
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
	/** Manually retry the last failed model call after the auto-retry budget
	 *  (settings retryMaxAttempts) ran out: the turn ended with a red error
	 *  and is idle. Server re-triggers one LLM turn without adding a new user
	 *  message; refused while streaming. */
	| { type: "retry_last" }
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
	/** Ask the active model to draft a commit message from the current
	 *  changes (one-off completion, NOT routed through the conversation).
	 *  Answered exactly once by an scm_data with kind "commitmsg" — text
	 *  carries the generated single-line message; ok:false on any failure. */
	| { type: "scm_commitmsg"; reqId: number }
	| { type: "new_chat"; preset?: string }
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
	/** 按需取一条工具定义（工具卡右键菜单 → 「显示工具详细信息」）。定义是静态大对象，
	 *  不进快照（否则每次节流推送都要重传一遍），改为点开时现取一次；
	 *  应答 `tool_info`。引擎不支持枚举工具定义时回 `unsupported: true`。 */
	| { type: "get_tool_info"; name: string }
	| { type: "list_sessions" }
	| { type: "switch_session"; path: string }
	| { type: "switch_conversation"; id: string }
	/** 手动过户：把另一处（elsewhere 行，owner/convId 标识）的对话整体搬到本页
	 *  （含等答复的问卷/页调用），搬完自动切过去. */
	| { type: "take_over_conversation"; owner: string; id: string }
	/** 跨页作答预告请求：把另一处的等答复问卷原文取回本页展示（id = 对方 convId）。
	 *  回答仍经 question_answer（带 owner）回去，不搬迁对话. */
	| { type: "peek_elsewhere_question"; owner: string; id: string }
	| { type: "list_projects" }
	| { type: "list_files"; path?: string }
	/** 列目录：path 省略 = 工作区根；也接受工作区外绝对路径（Windows "C:/…"、
	 *  posix "/…"）与机器根 "@root"（盘符列表，见 files-service.ts MACHINE_ROOT）。
	 *  机器浏览时返回的 entry.path 为绝对 wire 路径，可直接再用于列目录/预览/附件。 */
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
	/**
	 * 文件树右键菜单的文件操作（`contextmenu.file` 槽位，见 RightPanel.tsx）。
	 * path/dir/src/destDir 接受工作区相对路径与绝对 wire 路径（Windows "C:/…"、
	 * posix "/…"），与 list_files/read_file/upload_file 同口径；机器根 "@root"
	 * 本身不可作为操作对象。服务端一律回答 notice（+ file_changed 刷新列表）。
	 */
	/** 在 dir 下新建空文件或空文件夹（name 只取 basename，多余分隔符服务端清洗）。 */
	| { type: "file_create"; dir: string; name: string; kind: "file" | "dir" }
	/** 同目录内重命名（newName 只取 basename，不跨目录移动；跨目录请用 file_copy+move）。 */
	| { type: "file_rename"; path: string; newName: string }
	/** 删除文件或目录（目录递归；工作区根/机器根/盘符根拒绝）。 */
	| { type: "file_delete"; path: string }
	/** 复制或移动：move=true 即剪切粘贴（同盘 rename，跨盘复制+删源）；
	 *  destDir 与 src 同目录时即「创建副本」（重名自动加 " copy" 后缀）。 */
	| { type: "file_copy"; src: string; destDir: string; move?: boolean }
	/** 在系统资源管理器中定位（issue #187）：文件→打开目录并选中，目录→直接打开。
	 *  只读操作，保护根也允许；远端/headless 主机上服务端会回 warning notice。 */
	| { type: "file_reveal"; path: string }
	/** 用系统默认应用打开文件（issue #187）：仅文件，目录请用 file_reveal。 */
	| { type: "file_open_default"; path: string }
	| { type: "list_models" }
	| { type: "set_model"; modelId: string }
	/** 设全局默认模型（"provider/id"）：无项目记忆的新项目回落到它（项目记忆优先）。
	 *  服务端回 default_model 广播；pi 引擎专有。 */
	| { type: "set_default_model"; modelId: string }
	/** 清除全局默认模型（新项目回落到 SDK 默认）。 */
	| { type: "clear_default_model" }
	| { type: "set_thinking"; level: string }
	| { type: "set_cwd"; path: string }
	| { type: "complete_path"; path: string }
	/** Create a folder for the cwd picker (absolute, ~- or session-relative).
	 *  The server answers with a notice (success/failure) — the picker
	 *  refreshes its own listing afterwards. When setAsCwd is true, switches cwd to it atomically. */
	| { type: "make_dir"; path: string; setAsCwd?: boolean }
	| { type: "dialog_response"; id: number; value: string | boolean | null }
	// -- self-update ----------------------------------------------------------
	/** Check the npm registry for a newer pi-web-ui version. */
	| { type: "check_update" }
	| { type: "check_updates_all"; force?: true } // webui + direct pi extensions (manifest)
	/** Restart the supervised service (same effect as `pi-web-ui server restart`:
	 *  this process exits and its supervisor brings it back). The server refuses
	 *  when no supervisor manages this instance (foreground / dev / Docker). */
	| { type: "restart_service" }
	// -- pi agent setup ------------------------------------------------------
	/** Auto-install the pi agent (mkdir config dir + npm i -g the CLI). */
	| { type: "install_pi_agent" }
	/** Persist an api-key credential for a provider (auth.json) and apply it now. */
	| { type: "set_provider_api_key"; provider: string; apiKey: string }
	/** Start an SDK-backed OAuth login flow for a built-in provider. */
	| { type: "provider_oauth_start"; provider: string }
	/** Reply to the currently pending prompt in an OAuth flow. */
	| { type: "provider_oauth_reply"; flowId: string; promptId: string; value: string }
	/** Cancel one in-flight OAuth login. */
	| { type: "provider_oauth_cancel"; flowId: string }
	/** Request the public state of in-flight OAuth logins after reconnecting. */
	| { type: "list_provider_oauth_flows" }
	/** Remove the provider's stored OAuth credential through the SDK. */
	| { type: "provider_oauth_logout"; provider: string }
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
	/** Re-read models.json from disk into the model runtime and repush the
	 *  model list — for edits made outside the UI (hand edits, scripts).
	 *  Same refresh tail that save_model_config runs. */
	| { type: "reload_models_config" }
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
	/** Force-refresh BUILT-IN providers' official pi.dev catalogs, bypassing
	 *  the SDK's 4h freshness window (mr.refresh force:true). For when a new
	 *  cheap model (e.g. a fresh Union release on opencode) is already on
	 *  pi.dev but the local models-store.json cache is still serving stale
	 *  data. reqId is echoed in refresh_builtin_result. */
	| { type: "refresh_builtin_models"; reqId: number }
	/** Append ONE model to a BUILT-IN provider via a models.json overlay entry
	 *  (first-day access before pi.dev lists it). Only `models[]` is written —
	 *  no baseUrl/api — so the entry stays a pure overlay: api/baseUrl are
	 *  inherited from the provider's existing models at compose time, and a
	 *  later official catalog refresh never drops the row. Only id (+ optional
	 *  display fields) is needed; reqId is echoed in append_builtin_result. */
	| { type: "append_builtin_model"; providerId: string; model: UiModelConfigEntry; reqId: number }
	/** Copy a BUILT-IN provider (baseUrl + current model catalog) into an
	 *  editable custom-provider draft — the point is running a second API key
	 *  alongside the built-in one without overwriting it. Nothing is saved
	 *  until save_model_config; the draft comes back in clone_provider_result
	 *  with a fresh provider id and an EMPTY apiKey for the user to fill. */
	| { type: "clone_provider"; provider: string; reqId: number }
	/** Enrich custom-provider draft rows with catalog params (contextWindow /
	 *  maxTokens / vision input / reasoning) from public directories
	 *  (OpenRouter primary, models.dev secondary). Runs SERVER-side; ids are
	 *  matched fuzzily (proxy aliases like gemini-3-pro-high). `hints` pins
	 *  rows: "draft-id" -> catalog id (e.g. anthropic/claude-sonnet-4-5) or
	 *  model page URL. Only blanks are filled by the UI. reqId is echoed in
	 *  enrich_models_result. */
	| {
			type: "enrich_models";
			reqId: number;
			ids: string[];
			hints?: Record<string, string>;
	  }
	/** Cancel an ongoing enrich_models request. If reqId is provided, aborts
	 *  only if that request is still running; otherwise aborts any active one. */
	| {
			type: "abort_enrich_models";
			reqId?: number;
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
	/** Apply a partial settings update: compose template / per-source overrides or
	 *  skill/extension toggles. Each change is persisted per client; prompt
	 *  template changes reload the runtime, while review changes affect the next review. */
	| {
			type: "set_settings";
			promptMode?: "append" | "replace";
			customSystemPrompt?: string;
			/** 组合模板文本（{{token}} 自由拼装，空 = 默认模板，见 prompt-composer）。 */
			promptTemplate?: string;
			/** 各来源 token 的独立覆盖（空 = 用自动内容）。 */
			promptOverrides?: Record<string, string>;
			disabledSkills?: string[];
			disabledExtensions?: string[];
			/** 统一 Agent 工具禁用名单（见 server/tool-manager.ts；live 生效无需 reload）。 */
			disabledAgentTools?: string[];
			/** 插件 AI 工具禁用名单（工具名；live 生效无需 reload）。 */
			disabledPluginTools?: string[];
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
			/** 终端接管 bash 前台最长等待毫秒（0 = 不限；达到后无论是否有输出均自动转后台）。 */
			terminalBashMaxForegroundMs?: number;
			/** 工具执行看门狗超时（毫秒，0 = 禁用；默认 20 分钟即 1200000）。 */
			toolWatchdogTimeoutMs?: number;
			/** read 工具读目录开关（默认开）。开 → read(目录路径) 列出目录条目，
			 *  关 → 原样交回内置 read（目录报 EISDIR）。行为开关（read 本体不可关），
			 *  覆盖定义每次调用实时读取，live 生效无需 reload。 */
			readDirEnabled?: boolean;
			/** edit_soft 工具开关（默认关）。开 → AI 可用不严格要求缩进的 edit_soft 工具。 */
			editSoftEnabled?: boolean;
			/** 问卷提问（ask_user_question）开关（默认开）。关 → 模型不再弹问卷。 */
			questionnaireEnabled?: boolean;
			/** 同项目并行提醒开关（默认开）。关 → 同项目另有对话在跑时不发 notice、不给 AI 注提醒、不通知对端。纯运行开关，无需 reload。 */
			parallelReminderEnabled?: boolean;
			/** 目标模式（目标条 + 调研向导 + 审查循环）总开关（默认开）。关 → 目标条
			 *  隐藏、无法设目标/启动调研/触发审查。纯运行开关，无需 reload。 */
			goalModeEnabled?: boolean;
			/** 思考文本是否换行（默认开）。纯 UI 偏好，不需要 reload runtime。 */
			thinkingWrap?: boolean;
			/** 工具调用是否默认展开（默认开）。纯 UI 偏好，不需要 reload runtime。 */
			toolsWrap?: boolean;
			/** 工具结果里的图片直接显示（默认开）。关 → 工具卡不渲染缩略图
				（快照仍带图，纯 UI 偏好，不需要 reload runtime）。 */
			toolImagesEnabled?: boolean;
			/** skill 全文注入名单（默认空 = 名录模式）。名单里的技能 {{skills}} 展开正文。 */
			skillsFullText?: string[];
			/** 子代理默认模型（"provider/id"；null/未设 = 子代理跟随主对话当前模型）。
			 * 不改主会话模型，只在派生子代理时生效。 */
			subagentDefaultModel?: string | null;
			/** Vision bridge on/off + preferred "provider/id" model (null = auto). */
			visionBridgeEnabled?: boolean;
			visionBridgeModel?: string | null;
			/** Vision-bridge transcription prompt: mode (append/replace, same
			 *  semantics as promptMode) + custom text (empty = built-in default). */
			visionBridgePromptMode?: "append" | "replace";
			visionBridgePrompt?: string;
			/** SCM「AI 生成提交信息」提示词：模式（append/replace，语义同 promptMode）
			 *  + 自定义文本（空 = 内置默认）。pi 引擎的 scm_commitmsg 生成用。 */
			scmCommitMsgPromptMode?: "append" | "replace";
			scmCommitMsgPrompt?: string;
			/** Extra instructions and independently disabled skills for review. */
			reviewPrompt?: string;
			reviewDisabledSkills?: string[];
			/** 大模型 API 出错自动重试次数（默认 6；0 = 失败即停）。即时生效，无需 reload。 */
			retryMaxAttempts?: number;
			/** 上下文压缩软上限（tokens，0 = 关闭）+ 按模型覆盖（"provider/id" → tokens）。
			 *  即时生效（compaction reserveTokens 覆盖），无需 reload。 */
			softCapTokens?: number;
			softCapByModel?: Record<string, number>;
			/** 内置标记总开关 + 按 marker 禁用（markersEnabled=false 时全部停用）。 */
			markersEnabled?: boolean;
			disabledMarkers?: string[];
			/** 宿主 UI 布局的用户偏好（插件 UI 贡献 + 内置条目的隐藏/排序/分组）。
			 *  纯 UI 偏好，per-client 持久化，不触发 reload。 */
			uiLayout?: UiLayoutPrefs;
			/** 输入框上方的快捷短语（点击即发送）。纯 UI 偏好，不需要 reload runtime。 */
			quickPhrases?: string[];
			quickPhrasesEnabled?: boolean;
			/** 上报「已 seed 一次默认快捷短语」（首次见空列表时客户端按语言填一批默认并置位；
			 *  服务端存全局标记，跨会话/跨浏览器生效，避免删除默认后又被填回）。 */
			quickPhrasesSeeded?: boolean;
	  }
	// -- plugins (<dataDir>/plugins) -----------------------------------------
	/** App-level message from a plugin's client bundle to its server side.
	 *  Routed by pluginId; unknown/failed plugins are silently ignored. */
	| { type: "plugin_message"; pluginId: string; payload: unknown }
	/** Re-scan the plugin directory: deactivate removed entries, activate new
	 *  ones, bump the epoch and re-push the catalog. Same spirit as
	 *  extensions_reload but for pi-web-ui's own UI plugins. */
	| { type: "plugins_reload" }
	/** 特权 DOM 访问授权（wantsDom 插件）：granted=true 即写入 <dataDir>/plugin-dom.json
	 *  并 epoch+1 重推清单（浏览器按新 epoch 重拉 bundle）；false = 撤销。 */
	| { type: "plugin_dom_consent"; pluginId: string; granted: boolean }
	/** Save the CURRENT settings as a named preset (overwrites if it exists). */
	| { type: "save_preset"; name: string }
	/** Upsert 一个子代理模板（同名覆盖；全局共享，所有客户端一致）。停用标记
	 *  enabled 一起保存 —— 关闭的模板设置面板可见、可重开，但 AI 工具查询不到。 */
	| { type: "save_subagent_template"; template: UiSubagentTemplate }
	/** 删除一个子代理模板。 */
	| { type: "delete_subagent_template"; name: string }
	/** Save a UI plugin's declarative settings (manifest "settings" schema).
	 *  The host validates against the schema, persists to storage.json and
	 *  notifies the plugin (host.onSettingsChanged). */
	| { type: "plugin_settings"; pluginId: string; values: Record<string, unknown> }
	/** Add a third-party plugin to the user's installable-plugin list
	 *  (<dataDir>/plugin-catalog.json). `source` is required
	 *  (owner/repo or owner/repo/subdir[#ref]); id/name/description/icon are
	 *  optional — the server normalizes defaults (id falls back to the CLI's
	 *  repo/subdir naming, name falls back to id). */
	| {
			type: "plugin_catalog_add";
			entry: { source: string; id?: string; name?: string; description?: string; icon?: string };
	  }
	/** Remove a user-added plugin from the installable-plugin list (builtin
	 *  entries from the shipped catalog can't be removed via the UI). */
	| { type: "plugin_catalog_remove"; id: string }
	/** Run a plugin install / update / uninstall as a BACKGROUND JOB
	 *  (server/plugin-installer.ts) instead of a visible terminal tab: the
	 *  settings panel stays open, the job keeps running page-side, and
	 *  progress/results come back as `plugin_job` messages to the caller.
	 *  One job at a time (a second start while one runs is refused with a
	 *  notice); on success the server reloads plugins + re-pushes the
	 *  catalog/list to every client. Refused on managed instances (they
	 *  install through their deploy). */
	| {
			type: "plugin_job";
			/** Client-generated job id, echoed back on every update. */
			jobId: string;
			action: "install" | "update" | "uninstall";
			/** Plugin id: install target dir name / uninstall target. */
			id: string;
			/** install/update: remote source owner/repo[/subdir][#ref] (local paths
			 *  stay CLI-only on purpose). */
			source?: string;
			/** install/update: build the plugin from source first (isolated build,
			 *  same as CLI `--build`). */
			build?: boolean;
			/** install/update: never build, even for source-only plugins (same as
			 *  CLI `--no-build`; mutually exclusive with build). */
			noBuild?: boolean;
	  }
	/** Cancel a running plugin job (kills its process tree; finished jobs are
	 *  unaffected). */
	| { type: "plugin_job_cancel"; jobId: string }
	/** 用户对「插件请求访问工作区外目录」的答复（id 回显 plugin_path_request.id）。
	 *  remember=true 时把授权记进 <dataDir>/plugin-grants.json（下次不再问）。 */
	| { type: "plugin_path_response"; id: string; ok: boolean; remember?: boolean }
	/** 撤销插件目录授权（设置面板）：给 pluginId 清掉它的全部授权，给了 path 只清
	 *  该目录；两者都不给 = 清空整张表。 */
	| { type: "plugin_path_revoke"; pluginId?: string; path?: string }
	/** 用户对「插件请求能力授权」的答复（id 回显 plugin_permission_request.id）。
	 *  remember=true 记进 <dataDir>/plugin-permissions.json（下次不再问），
	 *  false/缺省 = 仅本次运行有效。 */
	| { type: "plugin_permission_response"; id: string; ok: boolean; remember?: boolean }
	/** 撤销能力授权（设置面板）：给 pluginId 清它的全部，给 family 缩到该族，
	 *  给 host/model 缩到命中该范围的条目；全不给 = 清空整张表（含内存授权）。 */
	| { type: "plugin_permission_revoke"; pluginId?: string; family?: "net" | "llm"; host?: string; model?: string }
	/** 设置当前项目的**额外工作区根**（宿主侧多根）：AI 仍只在主 cwd 里干活（pi SDK
	 *  是单 cwd 模型），文件树与插件的受支持路径可跨这些根。空数组 = 回到单根。
	 *  只收绝对路径（相对路径直接丢弃）、去重、最多 8 个；按项目（cwd）持久化在
	 *  client-state.json，改了立刻推一次快照并在插件宿主里同步。 */
	| { type: "set_workspace_roots"; roots?: string[] }
	/** Sync the plugin marketplace list from a remote/local JSON document
	 *  (array or the documented `{ entries: [...] }` shape): validated, written
	 *  atomically to <dataDir>/plugin-catalog.json, optionally installed/
	 *  updated, then plugins are reloaded and the refreshed list is pushed to
	 *  every client. Result → `plugin_catalog_sync_result` (requestId echoed). */
	| {
			type: "plugin_catalog_sync";
			requestId: string;
			/** http(s) URL or a local JSON file path. */
			source: string;
			/** Also install/update every entry (default false). */
			install?: boolean;
			/** Replace the user list wholesale instead of merging (default false =
			 *  upsert by id, keep entries the document doesn't mention). */
			replace?: boolean;
	  }
	// -- DSH engine user patches (<dataDir>/dsh-patches) ---------------------
	/** List <dataDir>/dsh-patches/*.yml (DSH engine only; pi engine ignores). */
	| { type: "dsh_patches_list" }
	/** DSH Agent 预设名录（DSH only；名录变化/attach 后推；legacy 下 presets 空）。 */
	| { type: "dsh_preset_list" }
	/** 空白会话切换预设（DSH only；首轮后锁定，失败收 warning notice）。 */
	| { type: "dsh_preset_select"; preset: string }
	/** 新会话默认预设（DSH only；非法 id 拒绝并提示）。 */
	| { type: "dsh_preset_default"; preset: string }
	/** 当前会话切换权限预设（DSH only；热切换，无需重启；失败收 warning notice）。 */
	| { type: "dsh_permission_set"; preset: string }
	/** 新会话默认权限预设（DSH only；非法 id 拒绝并提示）。 */
	| { type: "dsh_permission_default"; preset: string }
	/** Re-scan <dataDir>/dsh-patches and restart the DSH runtime so new/edited
	 *  patch files take effect (patches are only loaded at runtime boot). */
	| { type: "dsh_patches_rescan" }
	/** DSH engine: answer a model ask_user_question dialog (id echoes
	 *  question_pending.id). `cancelled` (user ✗) rejects the pending ask.
	 *  owner = 跨页作答：转给持有方会话（elsewhere_question 预告的那张问卷）。 */
	| {
			type: "question_answer";
			id: string;
			answers: QuestionAnswer[];
			cancelled?: boolean;
			owner?: string;
	  }
	/** Answer to page_request (id echoes page_request.id). `ok:false` carries a
	 *  human-readable `error` — no browser/extension, page not allowed, or the
	 *  action itself failed. The server never inspects `result`'s shape; it is
	 *  handed to the model as-is (JSON). */
	| {
			type: "page_response";
			id: string;
			ok: boolean;
			result?: unknown;
			error?: string;
	  }
	/** Replace the current settings with the named preset and apply it. */
	| { type: "apply_preset"; name: string }
	/** Remove the named preset. */
	| { type: "delete_preset"; name: string }
	/** Drop one workspace from this client's recent-project list (UI state
	 *  only — nothing on disk is touched). */
	| { type: "remove_project"; path: string }
	/** Permanently delete a persisted session transcript file (history list). */
	| { type: "delete_session"; path: string }
	/** Append a session_info name entry to a persisted session transcript (history rename). */
	| { type: "rename_session"; path: string; name: string }
	/** Rename a live conversation: retitle + persist a session_info entry so History matches. */
	| { type: "rename_conversation"; id: string; name: string }
	/** Dismiss a running conversation from the left-panel list (frees its runtime
	 *  but keeps the persisted transcript in history). Only non-streaming
	 *  conversations can be dismissed; streaming ones refuse with a notice.
	 *  withFinishedSubagents = 连带关闭该对话下已结束的子代理（传递后代；运行
	 *  中的子代理仍会阻止关闭，绝不连带 abort）。不传 + 存在已结束子代理后代
	 *  时拒绝并提示（避免静默 orphan，由前端确认框先问用户）。
	 *  force = 强行关闭：中止自身运行（如在跑）+ 中止全部子代理后代
	 *  （运行中的也停）再整体移出；终端/审查/后台唤醒等保留态一并放行。
	 *  active 对话也可关闭（后端自动切到其他对话或新建后再移）。 */
	| { type: "dismiss_conversation"; id: string; withFinishedSubagents?: boolean; force?: boolean }
	/** 将一个内存子代理（inMemory）固化为普通持久化对话：写入磁盘 .jsonl 文件，
	 *  清除 isSubagent 标记，使其进入历史会话列表并长久保留。 */
	| { type: "persist_conversation"; id: string }
	/** Bulk-dismiss FINISHED subagents from the running list (right-click menu).
	 *  parentId omitted = all finished subagents; given = the transitive
	 *  subagent descendants of that conversation (children, grandchildren, …),
	 *  plus the parent itself when it is a finished subagent. Running
	 *  (streaming/retained) subagents are never touched. */
	| { type: "dismiss_finished_subagents"; parentId?: string }
	// -- scheduled tasks (issue #184, server/scheduler-tasks.ts) -----------------
	/** Re-push the built-in scheduler task list (also pushed on attach / change). */
	| { type: "schedule_list" }
	/** Create or fully update a scheduled task (same id = overwrite). */
	| { type: "schedule_save"; task: SchedulerTaskInput }
	/** Delete a scheduled task. */
	| { type: "schedule_delete"; id: string }
	/** Manually trigger a task once right now (does not shift its next fire). */
	| { type: "schedule_run"; id: string }
	/** Enable / disable a scheduled task (re-arms its next fire). */
	| { type: "schedule_toggle"; id: string; enabled: boolean };

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

/** 一个可选项：模型的 ask_user_question 问卷选项。preview 为选项被选中后
 *  在右侧展开的富文本（model 自选 markdown 或 HTML，前端走 Markdown(rawHtml)）。 */
export interface UiQuestionOption {
	label: string;
	description?: string;
	preview?: string;
}

/** 模型 ask_user_question 的一道题。question/detail/header 允许 markdown/HTML
 *  混排（前端走 Markdown(rawHtml)），由模型自选、信任模型。 */
export interface UiQuestion {
	id: string;
	question: string;
	detail?: string;
	header?: string;
	options?: UiQuestionOption[];
	multiSelect?: boolean;
}

/** 一道题的用户回答（question_answer 回传）。selected 为选中的选项 label
 *  列表；custom 为用户在「Type something」里填的额外文本（可选）。 */
export interface QuestionAnswer {
	id: string;
	selected: string[];
	custom?: string;
}

/** 待用户回答的模型提问（ask_user_question）——服务端侧的事实源。
 *  `question_pending` 是即时通道（模型刚提问时推一次）；本类型同时挂在
 *  UiState.pendingQuestion 上，让重连/刷新/第二个标签页的客户端从快照里把
 *  对话框恢复出来（否则问卷只在「当时在线的那条连接」上可见）。 */
export interface UiPendingQuestion {
	/** 提问 id，question_answer 回传时原样带回。 */
	id: string;
	questions: UiQuestion[];
	/** 服务端超时时间戳（epoch ms）——前端显示倒计时，归零自动取消。
	 *  缺省 = 不限时（标准 pi 引擎：等人回答不设上限）。 */
	deadline?: number;
	/** 所属会话 id（缺省 = 不限会话 / 全局）。用于前端切换会话时自动收起/恢复面板。 */
	conversationId?: string;
	/** 所属会话标题/名称（可选），用于在提问弹窗中展示来源对话。 */
	conversationTitle?: string;
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

/** One run of a built-in scheduled task (issue #184): trigger time, outcome,
 *  duration and the headless conversation it ran in (if any). */
export interface SchedulerRunInfo {
	at: number;
	ok: boolean;
	durationMs: number;
	conversationId?: string;
	error?: string;
	manual?: boolean;
}

/** Built-in scheduled task (CRUD input): cron = 5-field expression,
 *  interval = milliseconds (as string or number, min 60s). */
export interface SchedulerTaskInput {
	id?: string;
	name?: string;
	description?: string;
	cwd?: string;
	kind?: "cron" | "interval";
	spec?: string | number;
	prompt?: string;
	enabled?: boolean;
	model?: string;
	thinkingLevel?: string;
	catchUp?: "skip" | "once";
	/** 发起对话 id（Agent 工具创建时填）：触发时优先唤醒它，找不到再无头执行。空 = 无头。
	 *  注意：内存对话 id（c1/c2…）重启即失效，跨压缩/重启认同一会话靠 sessionFile（issue #231）。 */
	conversationId?: string;
	/** 发起对话的落盘会话文件（压缩/重启后稳定，触发时优先按它重认会话）。 */
	sessionFile?: string;
	/** 单次任务：触发执行一次后自动删除（Agent 工具 recurring=false 时置 true）。 */
	oneShot?: boolean;
}

/** Built-in scheduled task with runtime state (server -> client). */
export interface SchedulerTaskView {
	id: string;
	name: string;
	description: string;
	cwd: string;
	kind: "cron" | "interval";
	spec: string;
	prompt: string;
	enabled: boolean;
	model: string;
	thinkingLevel: string;
	catchUp: "skip" | "once";
	/** 发起对话 id（空 = 无头执行）。易失的内存 id，只做首选唤醒键；稳定键是 sessionFile（issue #231）。 */
	conversationId: string;
	/** 发起对话的落盘会话文件（压缩/重启后依然稳定；空 = 面板任务/老任务）。 */
	sessionFile: string;
	/** 单次任务：触发执行一次后自动删除。 */
	oneShot: boolean;
	createdAt: number;
	updatedAt: number;
	nextFire: number | null;
	lastRun: SchedulerRunInfo | null;
	history: SchedulerRunInfo[];
	running: boolean;
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
	/** Path relative to the workspace root ('' for the root itself); in machine
	 *  browse mode (files.absolute) this carries the absolute wire path. */
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

/** One enriched row from enrich_models: only fields the catalog actually
 *  provided are present (never invented) — the UI fills blanks. `source` is
 *  a ready-to-display label composed server-side (e.g. "OpenRouter",
 *  "models.dev（别名）", "依据", "网页"). */
export interface UiEnrichResult {
	id: string;
	status: "matched" | "suggested" | "unmatched";
	contextWindow?: number;
	maxTokens?: number;
	input?: string[];
	reasoning?: boolean;
	name?: string;
	source?: string;
	matchType?: "exact" | "normalized" | "family" | "hint" | "hint-url";
	/** Suggested catalog ids for suggested rows (paste as evidence). */
	suggestions?: string[];
	/** Why unmatched / low-confidence note. */
	note?: string;
}
/** One model definition inside a custom provider. */
export interface UiModelConfigEntry {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	/** Per-model override (rarely needed): api type (openai-completions /
	 *  openai-responses / anthropic-messages / google-generative-ai) and/or
	 *  baseUrl. When absent they are inherited from sibling models of the
	 *  same provider at compose time (append_builtin_model relies on this). */
	api?: string;
	baseUrl?: string;
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
	/** 控件类型：文本 / 密码 / 数字 / 开关 / 下拉 / 机密。
	 *  secret 与 password 的区别：password 只是前端掩码、值仍明文存 storage.json；
	 *  secret 存加密 secrets（AES-256-GCM），浏览器侧 settingsValues 只看到有无（布尔），
	 *  插件运行时 getSettings() 才拿到真值；保存时空串 = 不改。 */
	type: "text" | "password" | "number" | "boolean" | "select" | "secret";
	/** 表单里的显示名。 */
	label: string;
	/** 未保存过时的默认值。 */
	default?: string | number | boolean;
	/** number 用：范围。 */
	min?: number;
	max?: number;
	/** select 用：静态候选值。 */
	options?: string[];
	/** select 用：候选项由**宿主**按数据源在浏览器侧现算（插件不必自己维护清单，
	 *  也就不会随模型配置变化而过期）：
	 *  "models" = 已配置鉴权的模型（值 `provider/id`，标签同设置面板的模型选择器）；
	 *  "thinkingLevels" = SDK 思考强度档位（`off`…`max`，标签走 `thinking.<值>`）。
	 *  两者渲染时都会在最前面加一个空值选项（= 跟随全局默认，插件侧拿到空串自行回落）；
	 *  服务端不做候选值校验（清单在宿主侧、随配置变化），非法值由用的时候（如 `host.chat`）报错。 */
	optionsFrom?: "models" | "thinkingLevels";
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
	/** Optional inline SVG icon (manifest.json `iconSvg`) — rendered in place
	 *  of `icon` wherever the plugin badge is shown (topbar view tab,
	 *  right-panel tab, settings lists). Server-validated shape only; the
	 *  frontend sanitizes again before injecting. */
	iconSvg?: string;
	/** The plugin failed to activate (bad entry / thrown error) — UI shows it
	 *  greyed out instead of a dead tab. */
	error?: string;
	/** 宿主当前持有该插件实例（loaded 表里有它；激活失败的占位行也有）。
	 *  设置面板据此合成运行相位：error→失败 / 用户禁用→已禁用 /
	 *  active→运行中 / 其他→纯前端（无 index.mjs，从未激活）。
	 *  可选字段：缺省 = 未知（旧服务端）。 */
	active?: boolean;
	/** Declared capabilities from manifest.json (e.g. "fs", "net", "tools") —
	 *  informational for now: surfaced in the settings panel so users can see
	 *  what a plugin claims to touch before trusting it. */
	permissions?: string[];
	/** 出站网络白名单（permissions 含 "net" 时生效：主机后缀匹配，空 = 全拒）。 */
	netAllowlist?: string[];
	/** 引擎约束（{ "pi-web-ui": ">=1.2.0" }，不满足即拒绝激活）。 */
	engines?: Record<string, string>;
	/** 可选对等依赖（其它插件 id，缺失只警告不断活）。 */
	peerPlugins?: string[];
	/** Declarative settings schema from manifest.json "settings" — rendered as a
	 *  form in the main ⚙ panel (type/label/default/min/max/options). */
	settingsSchema?: UiPluginSettingField[];
	/** Current stored values (storage.json "settings" key, defaults applied). */
	settingsValues?: Record<string, unknown>;
	/** Install source recorded by `pi-web-ui install` (<dir>/.pi-source.json):
	 *  the original spec the user typed (owner/repo, URL or local path). The
	 *  settings panel offers an Update button only when this exists. */
	source?: string;
	/** manifest.permissions 含 "dom" 族 = 该插件请求特权 DOM 访问（直接碰宿主外壳的
	 *  DOM，不走 slot 框架）。有此声明时 client bundle 默认 403，需用户在设置面板
	 *  逐个授权（plugin_dom_consent）后才下发。 */
	wantsDom?: boolean;
	/** 用户已授权该插件的特权 DOM 访问（<dataDir>/plugin-dom.json，全局共享）。 */
	domGranted?: boolean;
	/** Fenced-code languages this plugin can render (manifest "renderers"). The
	 *  frontend builds a language→plugin map and lazily loads the plugin's
	 *  bundle the first time such a fence actually renders in a message. */
	renderers?: string[];
	/** 自定义消息部件类型（manifest "messageWidgets"）：`customType === <type>`
	 *  的消息由该插件渲染（Markdown 经 loadMessageWidget 按需加载
	 *  `default.messageWidgets[type]`，载荷 JSON 序列化后传入）。 */
	messageWidgets?: string[];
	/** 自定义附件卡类型（manifest "attachmentCards"，预留：附件 details.kind
	 *  命中时由插件渲染卡片）。 */
	attachmentCards?: string[];
	/** 输入框补全源（manifest "composerProviders"，预留：@提及/斜杠补全增补）。 */
	composerProviders?: string[];
	/** Whether the plugin exposes a standalone view tab (manifest "view",
	 *  default true). Renderer-only plugins set false so the frontend skips
	 *  eagerly loading their bundle for the tab and only loads it on demand. */
	view?: boolean;
	/** manifest "preload" (default false): keep the client bundle loaded even
	 *  though the plugin has no view tab (view:false). Needed by plugins whose
	 *  top-level code must keep running across page reloads (reminder polling,
	 *  keyboard shortcuts, an always-available floating panel …). The bundle is
	 *  executed once per page load and may omit `export default { mount }`. */
	preload?: boolean;
	/** 这个插件对宿主 UI 的全部贡献（manifest "ui" + 运行时 host.ui.register
	 *  合并后的快照，见 UiPluginUi）。宿主负责渲染/排序/溢出/可访问性，
	 *  插件只做声明 + 回调 —— 不碰 DOM。 */
	ui?: UiPluginUi;
	/** 运行时诊断记录（manifest/ui 解析丢弃原因 + 工具/命令/路由重复或非法等
	 *  warning/error 摘要，英文短句、供设置面板“界面插件”页展开查看）。
	 *  可选字段：缺省/空 = 无可报告的诊断；只做可观测性，不影响隔离/权限语义。 */
	diagnostics?: string[];
	/** 该插件经 registerAgentTool 注册的 AI 工具快照（设置面板展示 + 逐工具开关用；
	 *  缺省/空 = 该插件未注册 AI 工具）。只含展示字段，不含 execute。 */
	agentTools?: UiPluginAgentTool[];
}

/** 插件注册的 AI 工具在 UiPluginInfo 上的只读快照（设置面板展示用）。 */
export interface UiPluginAgentTool {
	/** 全局唯一的工具名（如 mail_list）。 */
	name: string;
	/** UI 显示标签（缺省 = name）。 */
	label?: string;
	/** 给 LLM 的工具描述（面板里做悬浮提示）。 */
	description?: string;
}

/**
 * 宿主支持的**挂载点**（slot）。这是宿主 UI 扩展点的唯一枚举：新增一个挂载点 =
 * 宿主加一个常量 + 一处渲染位置，**插件侧契约不变**（不用再改 manifest 结构）。
 *
 * 命名：`<区域>[.<子区>]`。contextmenu.* 是五处右键菜单。
 */
export type UiSlotId =
	/** 顶栏主栏（与内置 tab 同排）。 */
	| "topbar.primary"
	/** 顶栏溢出菜单（主栏放不下的、以及声明 hidden 的条目）。 */
	| "topbar.overflow"
	/** 底栏（上下文/成本那一条）。 */
	| "bottombar"
	/** 输入框前置区（文件上传按钮左侧，纯插件新增位，无内置条目）。 */
	| "composer.leading"
	/** 输入框动作区（发送按钮旁边）。 */
	| "composer.actions"
	/** 每条消息 hover 时的工具条。 */
	| "message.actions"
	/** 右侧面板的 tab（默认是文件树）。 */
	| "rightpanel.tabs"
	/** 顶栏条目右键菜单。 */
	| "contextmenu.topbar"
	/** 消息右键菜单。 */
	| "contextmenu.message"
	/** 左栏会话右键菜单。 */
	| "contextmenu.session"
	/** 文件树条目右键菜单。 */
	| "contextmenu.file"
	/** 工具调用卡片的**工具名**右键菜单（ToolCallBlock；宿主内置条目只有「显示工具详细信息」）。 */
	| "contextmenu.toolcall"
	/** 设置面板里的一整页（插件用 mount() 自己渲染）。 */
	| "settings.pages"
	/** 左栏会话行内嵌区（会话标题旁的徽标/快捷按钮）。 */
	| "leftpanel.sessions"
	/** 对话头部条（标题旁的操作区）。 */
	| "chat.header"
	/** 空对话占位区（新对话的快捷入口）。 */
	| "chat.empty"
	/** 文件预览工具条。 */
	| "file.preview.toolbar"
	/** 终端工具条。 */
	| "terminal.toolbar"
	/** SCM 面板工具条。 */
	| "scm.toolbar"
	/** 目标条动作区。 */
	| "goalbar.actions"
	/** 通知条动作区（notice 上的快捷按钮）。 */
	| "notice.actions"
	/** 弹窗（插件声明 kind="view" 的条目，经宿主桥 openModal 按需打开）。 */
	| "modal.dialog";

/** 条目行为种类（决定宿主怎么渲染、点击怎么分发）。 */
export type UiItemKind =
	/** 切到某个视图（缺省 `plugin:<id>`）。 */
	| "view"
	/** 触发插件回调（host.onUiAction）。 */
	| "action"
	/** 只显示状态文本/角标（可选点击）。 */
	| "badge"
	/** 展开子菜单（children）。 */
	| "menu"
	/** 插件自定义设置页（slot="settings.pages"）。 */
	| "page"
	/** 整理器：可经 host.ui.arrange() 调整其它条目（含宿主内置）。 */
	| "organizer"
	/** 纯分隔线。 */
	| "divider"
	/** 开关（checked 状态经 host.ui.update 刷新，点击回 onUiAction）。 */
	| "toggle"
	/** 单行输入（value 经 host.ui.update 刷新，回车/失焦回 onUiAction）。 */
	| "input"
	/** 进度条（0-100 经 host.ui.update 刷新，只展示）。 */
	| "progress"
	/** 下拉选择（options 候选 + value 当前值；切换回 onUiAction(itemId, value)）。 */
	| "select";

/** 条目在槽位内的对齐（逻辑方向）：start = 行首组、center = 行中组、end = 行尾组。
 *  缺省 start。是否真分组渲染由各槽位的渲染层决定（当前只有输入框动作区
 *  composer.actions 落成左/中/右三组；composer.leading 与其余槽位按顺序渲染，
 *  align 只参与合并与偏好）。 */
export type UiAlign = "start" | "center" | "end";

/** kind="select" 的一个候选项（value 必填；label 缺省回落 value）。 */
export interface UiSelectOption {
	value: string;
	label?: string;
	labelEn?: string;
}

/** 插件声明的一个 UI 条目（manifest.ui.<slot> 数组元素 / host.ui.register 入参）。 */
export interface UiContribution {
	/** 条目 id（同一插件内唯一；全局 id = `<pluginId>:<id>`）。 */
	id: string;
	/** 挂载点（manifest 里由所在数组决定；运行时注册可显式给）。 */
	slot: UiSlotId;
	/** 文案（中文界面）与英文回落。 */
	label: string;
	labelEn?: string;
	/** emoji/单字符图标 或 宿主图标名。 */
	icon?: string;
	/** 内联 SVG 图标（与 UiPluginInfo.iconSvg 同语义；有则优先于 icon 渲染）。 */
	iconSvg?: string;
	/** 悬浮提示。 */
	hint?: string;
	hintEn?: string;
	/** 行为种类（缺省 "action"；仅 slot="settings.pages" 时缺省为 "page"）。 */
	kind?: UiItemKind;
	/** kind="menu" 的子项（一层足够，宿主不再递归）。 */
	children?: UiContribution[];
	/** 排序权重（小的靠前；缺省 100）。 */
	order?: number;
	/** 对齐组（缺省 start；同组内仍按 order/声明顺序排）。 */
	align?: UiAlign;
	/** 分组标签（同组连续排布并加分隔）。 */
	group?: string;
	/** 默认隐藏（进溢出菜单/布局页，用户可打开）。 */
	hidden?: boolean;
	/** kind="action"/"menu" 子项：点击时回给插件 host.onUiAction(action, itemId)。 */
	action?: string;
	/** kind="view"：目标视图（缺省 `plugin:<id>`）。 */
	view?: string;
	/** 宿主上下文条件（宿主不认识的值直接忽略，不报错）。
	 *  已知词表（右键菜单求值，见 web/src/context-menu-state.ts）：
	 *  `"disabled"`（恒置灰）/ `"always"`（恒可用）/ `"never"`（恒置灰）；
	 *  `"!x"`（要求 x 为真，如 `"!message.hasSelection"`，为假则置灰）；
	 *  肯定形适用条件：`file.isDir` / `file.isFile`（文件菜单）、
	 *  `session.isRunning`（会话菜单）、`message.hasSelection`（消息菜单）——
	 *  为假则置灰。其它槽位暂不求值（保留但不置灰）。 */
	when?: string[];
	/** 角标/状态文案（kind="badge"；插件运行时可经 host.ui.update 刷新）。 */
	badge?: string;
	/** kind="toggle" 的开关态 / kind="input" 的输入值 / kind="progress" 的 0-100 进度
	 *  （运行时经 host.ui.update 刷新；progress 越界由宿主钳制）。
	 *  kind="select" 复用 value 存当前选中值（options 候选见下）。 */
	checked?: boolean;
	value?: string;
	progress?: number;
	/** kind="select" 的候选项（最多 32 个；其它 kind 下忽略）。 */
	options?: UiSelectOption[];
}

/** 插件对**其它条目**（宿主内置 / 其它插件）的整理意图（issue #146 的"顶栏整理器"）。 */
export interface UiArrangeOp {
	/** 目标全局 id：`host:<name>`（内置）或 `<pluginId>:<itemId>`。 */
	id: string;
	/** 移到哪个槽位（缺省 = 目标当前槽位）。 */
	slot?: UiSlotId;
	/** 隐藏 / 显式显示（undefined = 不动）。 */
	hide?: boolean;
	group?: string;
	order?: number;
	/** 改对齐组（undefined = 不动）。 */
	align?: UiAlign;
	label?: string;
	/** 改悬浮提示（与 label 同一路：宿主渲染层把它当 `title`）。 */
	hint?: string;
	icon?: string;
	/** 改内联 SVG 图标（与 icon 同一路；空串 = 清掉）。 */
	iconSvg?: string;
}

/**
 * 宿主 UI 布局的**用户偏好**——优先级最高：用户手动 > 插件 arrange > 宿主默认。
 * key = 全局条目 id（`host:<name>` 内置条目，或 `<pluginId>:<itemId>` 插件条目）。
 * 插件能隐藏/分组任何条目（含宿主内置），但用户随时能在这里覆盖回去，
 * 设置面板「界面布局」页据此列出每一项的**来源**并支持逐条/一键恢复。
 */
export interface UiLayoutPrefs {
	/** 用户手动隐藏的条目（覆盖插件 arrange）。 */
	hidden?: string[];
	/** 用户手动显示的条目（覆盖宿主默认/插件声明的 hidden）。 */
	shown?: string[];
	/** 用户排序（key 列表，靠前的先排；未列出的按插件 order → 声明顺序）。 */
	order?: string[];
	/** 用户自定义分组。 */
	groups?: Record<string, string>;
	/** 用户自定义对齐（最高优先级，覆盖插件声明与 arrange）。 */
	align?: Record<string, UiAlign>;
	/** 用户自定义文案。 */
	labels?: Record<string, string>;
	/** 顶栏按钮文字总开关（默认开；false = 只剩图标，数字角标保留，溢出菜单仍带文字）。 */
	topbarText?: boolean;
}

/** 一个插件下发的全部 UI 贡献（manifest "ui" 与运行时注册合并后的快照）。 */
export interface UiPluginUi {
	/** 本插件贡献的条目（按 slot 分组由前端做，此处是平铺数组）。 */
	items: UiContribution[];
	/** 本插件对其它条目的整理意图。 */
	arrange: UiArrangeOp[];
}

/** 插件能力族（manifest.permissions 条目冒号前的族名）。
 *  fs:read / fs:write 由宿主从 "fs" 派生：只声明 fs:read = 跨目录写与
 *  project.create 被拒；声明 "fs" = 读写全开（向后兼容）。
 *  net = 出站网络白名单（manifest.netAllowlist 未命中即拒）；
 *  llm = host.llm.complete 孤立补全（花用户模型额度）；
 *  dom:anchor = 仅限 anchors 挂载点的范围 DOM（免用户授权，完整 document
 *  仍需 "dom" + 用户授权）。 */
export type PluginPermissionFamily =
	"fs" | "fs:read" | "fs:write" | "ui" | "tools" | "http" | "chat" | "llm" | "net" | "dom" | "dom:anchor";

/** 插件间事件总线的一条事件（host.events.emit/on）。 */
export interface PluginBusEvent {
	/** 事件名（建议 `<pluginId>:<name>` 前缀防撞）。 */
	topic: string;
	/** 发送方插件 id（宿主回填，发送方不可伪造）。 */
	from?: string;
	/** 事件载荷（JSON 可序列化，4KB 截断）。 */
	payload?: unknown;
}

/** 插件可见的模型信息（host.models.list）。 */
export interface PluginModelInfo {
	id: string;
	provider: string;
	vision: boolean;
}

/** 插件可见的会话统计（host.onStats）。 */
export interface PluginStats {
	conversationId?: string;
	tokens: { input: number; output: number; total: number };
	cost: number;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

/** 插件请求的用户对话框（host.dialog.*，对齐扩展 ui.select/confirm/input）。 */
export interface PluginDialogOption {
	label: string;
	description?: string;
}

/**  manifest 引擎约束（host 校验，不满足即拒绝激活并提示升级）。 */
export interface PluginEngines {
	"pi-web-ui"?: string;
}

/** One installable plugin in the "plugin list / marketplace" (see
 *  server/plugin-catalog.ts). Unlike {@link UiPluginInfo} (an INSTALLED
 *  plugin), a catalog entry is a one-click install candidate shown in the
 *  settings panel. Two sources are merged:
 *    - builtin : <pkgRoot>/plugins/catalog.json shipped with pi-web-ui (the
 *      maintained list — plugin authors contribute by adding an entry + PR)
 *    - custom  : <dataDir>/plugin-catalog.json, user-added entries (anyone
 *      can drop a third-party plugin into the list via the settings UI)
 *  Custom entries override a builtin entry of the same id (so users can
 *  adjust the maintained defaults). */
export interface UiPluginCatalogEntry {
	/** Install id — the plugin lands in <dataDir>/plugins/<id>. Must match
	 *  ^[A-Za-z0-9_-]+$. Installing always runs `pi-web-ui install <source>
	 *  --name <id>` so the on-disk dir name matches this id (this is what the
	 *  settings panel uses to detect installed/not-installed state). */
	id: string;
	/** Display name (falls back to id). */
	name: string;
	description?: string;
	descriptionEn?: string;
	/** Optional emoji/single-char icon. */
	icon?: string;
	/** Optional inline SVG icon (same semantics as UiPluginInfo.iconSvg). */
	iconSvg?: string;
	/** Install source for the CLI: owner/repo[/subdir][#ref]. */
	source: string;
	/** true = from the shipped catalog; false = user added in the UI
	 *  (only custom entries can be removed). */
	builtin: boolean;
	/** Optional project/homepage URL. */
	homepage?: string;
}

/** One of pi's built-in providers, with whether auth is configured. */
export interface ProviderStatus {
	id: string;
	name: string;
	configured: boolean;
	/** Where auth came from: stored / runtime / environment / models_json_key … */
	source?: string;
	/** Whether the provider accepts an API key credential. */
	supportsApiKey: boolean;
	/** Whether the provider supports an OAuth login flow. */
	supportsOAuth: boolean;
	/** Provider-specific account name shown in the OAuth action. */
	oauthName?: string;
	/** Whether the active stored credential is OAuth. */
	usingOAuth: boolean;
}

export type ProviderOAuthPromptPayload =
	| { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
	| {
			type: "select";
			message: string;
			options: { id: string; label: string; description?: string }[];
	  };

export type ProviderOAuthEventPayload =
	| { type: "info"; message: string; links?: { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

export interface ProviderOAuthFlowState {
	flowId: string;
	provider: string;
	promptId?: string;
	prompt?: ProviderOAuthPromptPayload;
	event?: ProviderOAuthEventPayload;
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
 *  stays visible until it is opened and left without continuing — and holds
 *  every conversation displaced to the background while still streaming
 *  (background-finish keeps them listed, opening-and-leaving-without-
 *  continuing removes them), PLUS the ACTIVE conversation once it has content
 *  (issue #140: the chat you are looking at must not be missing from the list;
 *  a blank new chat stays out). cwd lets the client group by project. */
export interface ConversationSummary {
	id: string;
	/** Display title: first user prompt (truncated) or the default. */
	title: string;
	cwd: string;
	messageCount: number;
	isStreaming: boolean;
	/** 这是子代理对话（左栏带「子代理」徽标；可点开查看/补充/中止）。 */
	isSubagent: boolean;
	/** DSH Agent 预设 id（standard/ptc/minimal/cordis/自建；pi 引擎不填）。 */
	agentPreset?: string;
	/** 预设已锁定（首轮用户发言后；空白会话可切换）。 */
	presetLocked?: boolean;
	/** 子代理最近一次运行报错（左栏红点；普通对话不带）。 */
	error?: string;
	/** 子代理最近一次运行被中止。 */
	canceled?: boolean;
	/** 父对话 id（Running 面板嵌套展示用）。 */
	parentId?: string;
	/** 落盘会话文件（persisted conversation 才有；inMemory 子代理缺省）。
	 *  右键「复制会话文件路径」与 AI 按 path 读历史时用。 */
	sessionFile?: string;
	/** 有问卷正在等答复（本会话 + elsewhere 行都挂「?」角标；点进去即可回答）。 */
	hasQuestion?: boolean;
	/** 等答复问卷的 ID（如 q-1），用于客户端去重与精准识别。 */
	questionId?: string;
	/** 等答复问卷的简短标题/题目（首题 header 或 question 文本），供横幅与列表展示。 */
	questionTitle?: string;
}

/** A conversation open on ANOTHER client (different tab / device) —
 *  read-only awareness for issue #145. The owning client holds the only
 *  writer for that transcript; this entry lets other tabs discover that
 *  "someone else is running in this project" without creating a second
 *  writer. Finished-but-still-held conversations stay listed (isStreaming:
 *  false) so they can still be taken over and viewed after the run ends.
 *  Rows ARE actionable since manual takeover: owner/convId identify
 *  the takeover target (take_over_conversation); absent = legacy sender
 *  (e.g. DSH engine) that cannot be taken over. */
export interface ElsewhereRunning {
	/** Display title of the remote conversation. */
	title: string;
	/** Workspace it runs in (lets the client group by project). */
	cwd: string;
	isStreaming: boolean;
	/** 落盘会话文件（有则前端可直接按路径打开；缺省 = inMemory/未知）。 */
	sessionFile?: string;
	/** Owning client id (takeover target's holder). Absent = 不可过户. */
	owner?: string;
	/** Conversation id inside the owning client (takeover target). */
	convId?: string;
	/** 有问卷正在等答复 —— 过户后可在本页直接回答. */
	hasQuestion?: boolean;
	/** 等答复问卷的简短标题/题目，供横幅与列表展示。 */
	questionTitle?: string;
}

/** DSH Agent 预设名录行（字段以运行时树为准；broken = 名录可见但不可挂载）。 */
export interface UiAgentPreset {
	id: string;
	trust: "system" | "user";
	isDefault: boolean;
	name?: string;
	description?: string;
	order?: number;
	broken?: string;
}

/** DSH 权限预设选项（官方 permissions projection 同源；custom 仅展示，不可切换）。 */
export interface DshPermissionOption {
	/** 预设值（read-only/workspace-write(-never)/danger-full-access/custom）。 */
	value: string;
	name: string;
	description?: string;
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

/** A named combination of prompt (compose template + per-source overrides) +
 *  disabled skills/extensions that the user can re-apply in one click. Persisted
 *  per client. promptMode/customSystemPrompt 是遗留字段（旧预设）。 */
export interface UiSettingsPreset {
	name: string;
	promptMode: "append" | "replace";
	customSystemPrompt: string;
	promptTemplate: string;
	promptOverrides: Record<string, string>;
	disabledSkills: string[];
	disabledExtensions: string[];
	/** Extra instructions and skill toggles for the isolated goal-reviewer. */
	reviewPrompt: string;
	reviewDisabledSkills: string[];
}

/** 一个子代理模板（设置面板「子代理模板」区的 CRUD 实体，也是 AI 派生子代理
 *  时可选的预设）：角色系统提示词（replace/append）+ 技能/扩展白名单。白名单
 *  空 = 该维度跟随主会话设置。`enabled: false` 的模板停用 —— 设置面板仍可见
 *  可重新启用，但不出现在 AI 工具（subagent_templates / subagent_spawn）里。 */
export interface UiSubagentTemplate {
	/** 唯一标识（AI 在 subagent_spawn 的 template 参数里传这个名字）。 */
	name: string;
	/** 给 AI / 设置面板看的简介（选模板时判断适用场景）。 */
	description: string;
	/** English variant of description (missing/empty = fall back to description;
	 *  server seeds both, panel edits the active UI language's field). */
	descriptionEn?: string;
	promptMode: "append" | "replace";
	/** 模板系统提示词（replace 模式必填；append 模式可空 = 只用白名单限定）。 */
	systemPrompt: string;
	/** English variant of systemPrompt (missing/empty = fall back to
	 *  systemPrompt; subagent_spawn picks by caller language). */
	systemPromptEn?: string;
	/** 技能白名单：非空 → 子代理只启用这些；空 → 跟随主会话技能开关。 */
	enabledSkills: string[];
	/** 扩展白名单（npm:<pkg> / 入口路径）：非空 → 只加载这些；空 → 跟随主会话。 */
	enabledExtensions: string[];
	/** 子代理模型 "provider/id"；空 = 跟随主对话当前模型。 */
	model: string;
	/** 子代理思考强度（"off"…"max"）；空 = 跟随主对话当前思考强度。模型不支持的
	 *  挡位由 SDK 自动收敛（如非推理模型只会是 "off"）。 */
	thinkingLevel: string;
	/** false = 停用（对 AI 不可见）。 */
	enabled: boolean;
}

/** One vision-capable model the vision bridge can use (picker option). */
export interface UiVisionBridgeModel {
	provider: string;
	id: string;
	/** Human-readable label: "qwen3-vl-plus (dashscope)". */
	label: string;
}

export interface UiMarkerInfo {
	name: string;
	enabled: boolean;
	guidance: string[];
}

/** Full settings state pushed to the browser (settings_state). */
export interface UiSettingsState {
	promptMode: "append" | "replace";
	customSystemPrompt: string;
	/** 组合模板 + 各来源覆盖（见 server/prompt-composer.ts）。主会话系统提示词
	 *  = 模板里 {{token}} 展开各来源提示词；覆盖优先于自动内容。 */
	promptTemplate: string;
	promptOverrides: Record<string, string>;
	disabledSkills: string[];
	disabledExtensions: string[];
	/** 统一 Agent 工具禁用名单（单源；live 生效无需 reload）。 */
	disabledAgentTools: string[];
	/** 插件 AI 工具禁用名单（工具名全局唯一；live 生效无需 reload；
	 *  未知/已卸载插件的条目保留，下次重装仍保持关闭）。 */
	disabledPluginTools: string[];
	/** @deprecated 遗留别名（由 disabledAgentTools 推导）：全开才算开。Off → terminal_*
	 *  tools are removed from the active set and the guidance prompt is not injected. */
	terminalToolsEnabled: boolean;
	/** 终端接管 bash（默认关）：bash 执行体改为持久终端（可见/保留状态/静默转后台）。 */
	terminalBash: boolean;
	/** 接管模式下 bash 的静默解阻阈值毫秒数（0 = 一直等到命令结束）。 */
	terminalBashIdleMs: number;
	/** 接管模式下 bash 前台最长等待毫秒数（0 = 不限；达到后自动转后台）。 */
	terminalBashMaxForegroundMs: number;
	/** 工具执行看门狗超时毫秒数（0 = 禁用；默认 20 分钟即 1200000）。 */
	toolWatchdogTimeoutMs: number;
	/** read 工具读目录开关（默认开）：开 → read(目录路径) 列出目录条目（见
	 *  server/read-tool.ts；行为开关，live 生效无需 reload）。DSH 引擎无该覆盖面，恒为 true。 */
	readDirEnabled: boolean;
	/** @deprecated 遗留别名（由 disabledAgentTools 推导）。开 → AI 可用不严格要求缩进的 edit_soft 工具。 */
	editSoftEnabled: boolean;
	/** 问卷提问开关（默认开）。关 → 模型不再弹问卷对话框。 */
	questionnaireEnabled: boolean;
	/** 同项目并行提醒开关（默认开）。关 → 同项目并行时不发 notice、不给 AI 注提醒、不通知对端。纯运行开关，无需 reload。 */
	parallelReminderEnabled: boolean;
	/** 目标模式（目标条 + 调研向导 + 审查循环）总开关（默认开）。关 → 目标条
	 *  隐藏、无法设目标/启动调研/触发审查。纯运行开关，无需 reload。 */
	goalModeEnabled: boolean;
	/** 思考文本是否换行（默认开 = pre-wrap；关 = 长行横向滚动）。 */
	thinkingWrap: boolean;
	/** 开发模式：index.html 不缓存。默认跟安装方式（源码开/安装包关），设置可覆盖。 */
	devNoCache?: boolean;
	/** 新构建就绪自动重载页面。默认跟安装方式（源码开/安装包关），设置可覆盖。 */
	autoReload?: boolean;
	/** 工具调用是否默认展开（默认开 = 展开；关 = 折叠）。 */
	toolsWrap: boolean;
	/** 工具结果里的图片直接显示（默认开）。关 → 工具卡不渲染缩略图。
	 *  纯 UI 偏好，不进预设。 */
	toolImagesEnabled: boolean;
	/** skill 全文注入名单（默认空 = 名录模式）：名单里的技能 {{skills}} 展开正文。 */
	skillsFullText: string[];
	/** Vision bridge on/off (default on). Off → images are sent as-is. */
	visionBridgeEnabled: boolean;
	/** Preferred vision model as "provider/id", or null = auto-detect first. */
	visionBridgeModel: string | null;
	/** Vision-bridge transcription prompt mode: append to the built-in default
	 *  prompt, or replace it entirely (empty text = built-in default). */
	visionBridgePromptMode: "append" | "replace";
	/** Custom vision-bridge transcription prompt text. */
	visionBridgePrompt: string;
	/** SCM「AI 生成提交信息」提示词模式：追加/替换内置默认（空文本 = 内置默认）。 */
	scmCommitMsgPromptMode: "append" | "replace";
	/** SCM「AI 生成提交信息」自定义提示词。 */
	scmCommitMsgPrompt: string;
	/** Extra instructions appended to the built-in goal-review prompt. */
	reviewPrompt: string;
	/** Skills disabled only for the isolated goal-reviewer. */
	reviewDisabledSkills: string[];
	/** Installed UI plugins the user hid in the settings panel (UI-only:
	 *  hidden tabs/views; server-side handlers stay reachable). */
	disabledPlugins: string[];
	/** 宿主 UI 布局的用户偏好（见 UiLayoutPrefs）。 */
	uiLayout: UiLayoutPrefs;
	/** The FULL system prompt actually in effect for the active conversation
	 *  (compose render: template + per-source overrides + project context +
	 *  skills + tool guidance). Read-only view source for the settings panel;
	 *  empty until the session is ready. */
	effectiveSystemPrompt: string;
	/** 每个来源 token 当前的默认（自动）内容 —— {{token}} 未覆盖时展开成的文本
	 *  （设置面板「各来源」行只读预览用；键 = prompt-composer token，空串 =
	 *  该来源目前无自动内容；会话未就绪时为空对象）。 */
	promptSourceDefaults: Record<string, string>;
	/** 发给模型的 function-calling 工具定义（name + description + parameters
	 *  JSON Schema）只读文本 —— 设置面板「查看当前完整提示词」里与系统提示词
	 *  正文并排展示，方便看到完整初始上下文；会话未就绪时为空串。 */
	toolsSchema: string;
	/** The built-in default vision-bridge transcription prompt. */
	visionBridgeDefaultPrompt: string;
	/** SCM「AI 生成提交信息」的内置默认提示词（设置面板 replace 模式预填用）。 */
	scmCommitMsgDefaultPrompt: string;
	/** Vision-capable configured models available on this machine. */
	visionModels: UiVisionBridgeModel[];
	skills: UiSkillInfo[];
	/** Same skill catalog with enabled flags evaluated for the reviewer. */
	reviewSkills: UiSkillInfo[];
	extensions: UiExtensionInfo[];
	presets: UiSettingsPreset[];
	/** 内置标记工具开关（全局 + 按 marker）。 */
	markersEnabled: boolean;
	disabledMarkers: string[];
	markers: UiMarkerInfo[];
	/** 子代理模板（含停用的；面板据此渲染开关，AI 只在 enabled 的里选）。 */
	subagentTemplates: UiSubagentTemplate[];
	/** 子代理默认模型（"provider/id"；null = 跟随主对话当前模型）。 */
	subagentDefaultModel: string | null;
	/** 大模型 API 出错自动重试次数（默认 6；0 = 失败即停）。 */
	retryMaxAttempts: number;
	/** 上下文压缩软上限（tokens，0 = 关闭）：达到即触发压缩（issue #229）。 */
	softCapTokens: number;
	/** 按模型覆盖软上限（key = "provider/id"）。 */
	softCapByModel: Record<string, number>;
	/** 输入框上方的快捷短语（点击即发送；空 = 不显示）。 */
	quickPhrases: string[];
	/** 快捷短语总开关（默认开；关 = 输入框上方不显示）。 */
	quickPhrasesEnabled: boolean;
	/** 是否已在服务端 seed 过一次默认快捷短语（跨会话/跨浏览器，用于避免删除后被填回默认）。 */
	quickPhrasesSeeded: boolean;
	/** 已配置鉴权的全部模型（子代理默认模型/模板模型选择器）。 */
	subagentModels: UiVisionBridgeModel[];
	/** 内置默认模板名（settings_state 里供面板标「默认」徽标；用户文件为准时可能
	 *  已删除/改名，长度可与 subagentTemplates 不同）。 */
	subagentDefaultTemplates: string[];
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
			/** This package's own version (`serverVersion` is the pi SDK's). The
			 *  client used to learn it from the update check, which a managed
			 *  instance never runs. */
			appVersion?: string;
			/** Web-build id (Vite __BUILD_ID__). The client compares it against
			 *  its own baked-in id — a mismatch means the server rebuilt since
			 *  this page loaded and the page should reload itself. */
			buildId?: string;
			/** PI_WEB_MANAGED=1 — updates come from outside, so the client hides
			 *  the update badge, the UPDATE panel and the plugin market. The
			 *  server refuses those messages anyway (server/managed.ts). */
			managed?: boolean;
			/** PI_WEB_TABS — the tabs this instance offers; absent means all of
			 *  them. The client does not draw the others and the server refuses
			 *  their messages (server/tabs.ts). */
			tabs?: string[];
			/** Supervising service manager, when this instance was started by
			 *  `pi-web-ui server start|install` (server/launch-origin.ts). Absent =
			 *  foreground/dev/Docker: no supervisor, so the client hides the
			 *  "restart service" action and the server refuses restart_service. */
			service?: UiServiceInfo;
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
			// listed conversations across every project, plus the active one once
			// it has content (#140). activeId is the active conversation — the
			// client marks that row as “current” (it is absent from the list only
			// while it is still a blank chat).
			type: "conversations";
			conversations: ConversationSummary[];
			activeId: string;
			/** issue #145：在其他客户端（标签页/设备）上正在跑的对话（只读感知，
			 *  不可点）。为空时缺省（老快照字节一致）。Only set when non-empty. */
			elsewhere?: ElsewhereRunning[];
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
	/** Sent every ~2s so clients can detect half-open connections and display host metrics. */
	| { type: "heartbeat"; hostMetrics?: UiHostMetrics }
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
			/**
			 * true = 机器浏览模式：path/entries 为绝对路径（盘符根 "C:"、"@root"
			 *  机器根，或 "/" 开头的 posix 路径），允许越过工作区根导航到别的盘。
			 *  false/缺省 = 工作区相对视图（原语义）。
			 */
			absolute?: boolean;
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
	/** `get_tool_info` 的应答：一条工具的**定义说明**（不含本次调用数据）。
	 *  parameters 是 JSON Schema（SDK 的 TypeBox schema 直接 JSON 化），超限整丢并置
	 *  `parametersDropped`（同 toolResult.details 的口径，见 serialize.ts）。 */
	| {
			type: "tool_info";
			name: string;
			/** 找到定义了没有（没找到时其余字段缺席，前端显示「未找到工具定义」）。 */
			found: boolean;
			/** 当前引擎不支持枚举工具定义（DSH 运行时拿不到时）。 */
			unsupported?: boolean;
			/** SDK 的展示名（label）；缺省时前端用 name。 */
			label?: string;
			description?: string;
			/** 系统提示词里的一行摘要（部分工具才有）。 */
			promptSnippet?: string;
			/** 追加到系统提示词 Guidelines 段的要点。 */
			promptGuidelines?: string[];
			/** 参数 JSON Schema（超 64KB 时缺席，见 parametersDropped）。 */
			parameters?: unknown;
			parametersDropped?: boolean;
			/** 该工具**当前是否启用**（禁用名单里的工具仍在目录里，但模型看不到）。 */
			active?: boolean;
			/** 来源标识（SDK SourceInfo.source，如 builtin / 扩展名 / 插件名）。 */
			source?: string;
			/** 来源作用域：user / project / temporary。 */
			scope?: string;
	  }
	| { type: "models"; models: ModelInfo[] }
	| { type: "models_config"; providers: UiProviderConfig[] }
	| { type: "providers_status"; providers: ProviderStatus[] }
	| { type: "provider_oauth_started"; flowId: string; provider: string }
	| { type: "provider_oauth_flows"; flows: ProviderOAuthFlowState[] }
	| {
			type: "provider_oauth_prompt";
			flowId: string;
			provider: string;
			promptId: string;
			prompt: ProviderOAuthPromptPayload;
	  }
	| {
			type: "provider_oauth_event";
			flowId: string;
			provider: string;
			event: ProviderOAuthEventPayload;
	  }
	| {
			type: "provider_oauth_result";
			flowId: string;
			provider: string;
			ok: boolean;
			cancelled?: boolean;
			error?: string;
	  }
	| { type: "provider_oauth_logout_result"; provider: string; ok: boolean; error?: string }
	/** All stored API keys per built-in provider (masked). Keyed by providerId. */
	| { type: "provider_keys"; keys: Record<string, ProviderKeyInfo[]> }
	/** 全局默认模型（"provider/id"，null = 未设置）。attach 与每次变更后推送。 */
	| { type: "default_model"; modelId: string | null }
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
	/** Progress notification for enrich_models while downloading catalogs or matching. */
	| {
			type: "enrich_models_progress";
			reqId: number;
			phase: "catalog" | "page" | "matching" | "aborted";
			current?: number;
			total?: number;
			message?: string;
	  }
	/** Result of enrich_models: per-id enrichment (matched fills + suggested
	 *  catalog ids + unmatched notes), or an error string. */
	| {
			type: "enrich_models_result";
			reqId: number;
			ok: boolean;
			results?: UiEnrichResult[];
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
	/** Result of refresh_builtin_models: the official pi.dev catalogs were
	 *  re-fetched (force) and the picker was repushed. Per-provider fetch
	 *  failures (if any) are joined into error; the cached catalog still
	 *  applies for those providers. */
	| {
			type: "refresh_builtin_result";
			reqId: number;
			ok: boolean;
			error?: string;
	  }
	/** Result of append_builtin_model: the model row was appended to the
	 *  provider's models.json overlay entry and the picker was repushed.
	 *  The entry also shows up under "custom providers" (same id) where it
	 *  can be edited / removed. */
	| {
			type: "append_builtin_result";
			reqId: number;
			ok: boolean;
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
			kind: "status" | "history" | "filediff" | "commit" | "commitmsg";
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
			/** commit payload / commitmsg payload (generated message) */
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
				kind: "webui" | "pi-core" | "package" | "git-extension";
				current: string;
				latest: string | null;
				latestPublishedAt?: string | null;
				upToDate: boolean;
				error?: string;
				/** git-extension only: `host/path` shorthand (prepend `git:` for the `pi update` command). */
				source?: string;
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
	/** Installable-plugin list (marketplace). Pushed on attach and after every
	 *  plugin_catalog_add/remove. Merges the shipped catalog
	 *  (<pkgRoot>/plugins/catalog.json) with user-added entries
	 *  (<dataDir>/plugin-catalog.json). `epoch` increments on every add/remove
	 *  so the frontend can re-render. */
	| { type: "plugin_catalog"; entries: UiPluginCatalogEntry[]; epoch: number }
	/** App-level message from a plugin's server side to its client bundles.
	 *  Broadcast to every connected socket (plugins have no per-client state
	 *  in v1); the frontend fans it out to the matching loaded view. */
	| { type: "plugin_data"; pluginId: string; payload: unknown }
	/** Plugin job progress — sent ONLY to the client that started the job. One
	 *  `start`, N `log`, one `done`. `done` carries `ok` plus the tail of the
	 *  job output so the settings panel can show what happened in place. */
	| {
			type: "plugin_job";
			jobId: string;
			action: "install" | "update" | "uninstall";
			pluginId: string;
			phase: "start" | "log" | "done";
			/** phase="log": one output line (stdout/stderr merged). */
			line?: string;
			/** phase="done": job success. */
			ok?: boolean;
			/** phase="done" + failure: human-readable reason. */
			error?: string;
			/** phase="done": output tail (bounded), for inline details. */
			output?: string;
	  }
	/** 插件请求访问工作区外的目录：宿主弹确认（文案按 kind 本地化），用户答复经
	 *  plugin_path_response 回传。未答复超时视为拒绝。 */
	| { type: "plugin_path_request"; id: string; pluginId: string; path: string; reason?: string }
	/** 插件目录授权表（设置面板展示 + 撤销后刷新）。 */
	| { type: "plugin_grants"; grants: { pluginId: string; paths: string[] }[] }
	/** 插件请求能力授权（net 主机 / llm 模型作用域）：宿主弹确认，用户答复经
	 *  plugin_permission_response 回传（remember=true 记盘）。未答复超时视为拒绝。 */
	| {
			type: "plugin_permission_request";
			id: string;
			pluginId: string;
			family: "net" | "llm";
			hosts?: string[];
			models?: string[];
			reason?: string;
	  }
	/** 能力授权表快照（attach 推 + 授权/撤销后重推；session 授权带 session:true）。 */
	| {
			type: "plugin_permissions";
			grants: {
				pluginId: string;
				family: "net" | "llm";
				hosts?: string[];
				models?: string[];
				reason?: string;
				grantedAt: number;
				session?: boolean;
			}[];
	  }
	/** 一条能力授权请求已被某端答复（多标签页互斥：先答复者胜，其余静默收起）。 */
	| { type: "plugin_permission_resolved"; id: string }
	/** Result of a plugin_catalog_sync (requestId echoed). */
	| {
			type: "plugin_catalog_sync_result";
			requestId: string;
			ok: boolean;
			error?: string;
			/** The merged marketplace list after the sync. */
			entries?: UiPluginCatalogEntry[];
			/** Per-entry install results when install:true was asked. */
			installed?: { id: string; ok: boolean; error?: string }[];
	  }
	// -- DSH engine user patches --------------------------------------------
	/** List of <dataDir>/dsh-patches/*.yml files (DSH engine only; pi engine
	 *  never emits it). Pushed on request (dsh_patches_list) and after a
	 *  rescan (dsh_patches_rescan). */
	| { type: "dsh_patches"; patchDir: string; files: { name: string; path: string; size: number; mtimeMs: number }[] }
	/** DSH Agent 预设名录（DSH only；attach/启动/默认变化后推；legacy 下 presets 空）。 */
	| {
			type: "dsh_presets";
			presets: UiAgentPreset[];
			defaultPreset: string;
	  }
	/** DSH 权限预设选项表 + 新会话默认（DSH only；attach/启动/默认变化后推）。 */
	| { type: "dsh_permission"; options: DshPermissionOption[]; defaultPreset: string }
	/** The model asked the user (ask_user_question tool) — both engines
	 *  (DSH via goal-rpc userQuestions provider, standard pi via the
	 *  pi-web-ui ask_user_question customTool) forward here. The frontend
	 *  shows a dialog and answers via question_answer. Pushed to the active
	 *  conversation; background conversations carry the question in their snapshot
	 *  when switched to. */
	| {
			type: "question_pending";
			id: string;
			/** 服务端超时时间戳（epoch ms，P0-6）；前端显示倒计时，归零自动取消。 */
			deadline?: number;
			questions: UiQuestion[];
			/** 所属会话 id（缺省 = 不限会话 / 全局）。 */
			conversationId?: string;
			/** 所属会话标题/名称（可选），用于在提问弹窗中展示来源对话。 */
			conversationTitle?: string;
	  }
	/** 待答问卷被搬走/取消：前端若正展示该 id 的对话框立即收起（不过户/不恢复）。
	 *  手动过户把问卷搬到另一会话时，源页面靠它收起旧对话框（快照为 null 只能收
	 *  snapshot 来源的面板，即时通道弹出的收不到 —— 见 pending-question.ts）。 */
	| { type: "question_retracted"; id: string }
	/** 跨页作答预告（peek_elsewhere_question 的回包）：另一处问卷的原文，
	 *  本页弹框展示、经 question_answer（带 owner）回去作答。 */
	| {
			type: "elsewhere_question";
			owner: string;
			convId: string;
			id: string;
			questions: UiQuestion[];
			/** 所属会话标题/名称（可选），用于在提问弹窗中展示来源对话。 */
			conversationTitle?: string;
	  }
	// -- browser page control (browser_page tool) ---------------------------
	/** The model wants to act on a page in the user's browser
	 *  (`browser_page` customTool; implemented by the page-picker browser
	 *  extension — see plugins/page-picker/README.md「AI 操作页面」).
	 *
	 *  The frontend forwards this to the extension via
	 *  `window.__piWebUiHost.pageCall()` and answers with page_response.
	 *  `op` is the **extension-side** action name (`read` / `click` / `type` /
	 *  `scroll` / `goto` / `wait` / `eval` / `pages`); the server never
	 *  interprets it, so the op vocabulary lives with the extension.
	 *
	 *  Not stored in the snapshot: unlike a question there is nothing for the
	 *  user to answer, and a reload mid-action just fails the tool call. */
	| {
			type: "page_request";
			id: string;
			op: string;
			args?: Record<string, unknown>;
			/** Target page origin (required when several pages are allowed). */
			target?: string;
			/** How long the server waits for the browser before failing the tool. */
			timeoutMs: number;
	  }
	// -- background tasks ---------------------------------------------------
	/** The background-server list (servers the agent left running, detected via
	 *  listening-port diffs around bash tool runs). Per CLIENT, not per
	 *  conversation — the list survives conversation switches/ends and only
	 *  empties when the tasks are stopped (individually or all at once) or the
	 *  process exits on its own. Pushed on change, on attach and on request. */
	| { type: "bg_servers"; servers: BgServer[] }
	// -- scheduled tasks (issue #184) ----------------------------------------
	/** Built-in scheduler task list (global, all projects). Pushed on attach,
	 *  on request (schedule_list) and on every change (save/delete/toggle/run). */
	| { type: "scheduler_tasks"; tasks: SchedulerTaskView[] };
