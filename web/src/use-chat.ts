import { useCallback, useEffect, useReducer, useRef } from "react";
import { randomUuid } from "./uuid";
import { withToken } from "./auth-token";
import type {
	ClientMessage,
	BgServer,
	CommandDef,
	ConversationSummary,
	FileContent,
	FileListing,
	GoalStatus,
	ModelInfo,
	ProjectSummary,
	ProviderStatus,
	ServerMessage,
	SessionSummary,
	SlashCommandInfo,
	ToolStatus,
	TerminalInfo,
	UiModelConfigEntry,
	UiProviderConfig,
	UiSettingsState,
	UiState,
	UiMessage,
	UiTextBlock,
	UiThinkingBlock,
} from "./types";

export type ConnStatus = "connecting" | "open" | "closed";

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	text: string;
}

/** A terminal tab. The output stream itself lives in the xterm instance
 * (via the terminal bridge) — this is just the tab metadata. */
export interface TerminalMeta extends TerminalInfo {
	conversationId: string;
}

export interface ChatState {
	status: ConnStatus;
	/** True once the server confirmed the agent session is ready (hello processed). */
	ready: boolean;
	state: UiState | null;
	/** Live tool output accumulated from tool_delta messages, keyed by toolCallId. */
	liveOutputs: Map<string, { toolName: string; text: string }>;
	/**
	 * Tools that FINISHED executing (tool_status from tool_execution_end), keyed
	 * by toolCallId. Lets the card show "done · waiting for the model" even
	 * while the session is still streaming. Cleared once the toolResult message
	 * lands in the snapshot (it carries the authoritative result).
	 */
	toolStatuses: Map<string, ToolStatus>;
	notices: Notice[];
	serverVersion?: string;
	/** Persisted session list for the left panel. */
	sessions: SessionSummary[];
	/** Open conversations (each runs its own session in parallel). */
	conversations: ConversationSummary[];
	/** Id of the conversation the current snapshot belongs to. */
	activeConversationId: string;
	/** Recent workspaces this client opened (left panel project picker). */
	projects: ProjectSummary[];
	/** Workspace file listing for the right panel. */
	files: FileListing | null;
	/** Latest file content fetched for the preview panel (path-matched in the modal). */
	fileContent: FileContent | null;

	/** Last dir-changed push from the server fs.watch (path = listed directory). */
	fileChanged: { path: string } | null;
	/** Models with valid auth, for the model dropdown. */
	models: ModelInfo[];
	/** True while a model list request is in flight. */
	modelsLoading: boolean;
	/** Custom providers from agentDir/models.json (model config panel). */
	modelsConfig: UiProviderConfig[];
	/** Built-in providers with auth status (key-only config). */
	providers: ProviderStatus[];
	/** Result of the last install_pi_agent run (null while not started/running). */
	installResult: { ok: boolean; detail: string } | null;
	/** Path completions for the cwd input. */
	pathCompletions: { name: string; path: string; type: "dir" | "file" }[];
	/** Self-update status (result of check_update). */
	update: {
		current: string;
		latest: string | null;
		latestPublishedAt: string | null;
		upToDate: boolean;
		pendingRestart: boolean;
		error?: string;
	} | null;
	/** Result of an update_app run (npm i -g). */
	updateResult: { ok: boolean; detail: string } | null;
	/** Extension widgets (TUI overlays bridged to the web UI). */
	widgets: { key: string; lines: string[] }[];
	/** Extension footer statuses (setStatus bridge). */
	statuses: { key: string; text: string | undefined }[];
	/** Active extension dialog (select/confirm/input) awaiting a response. */
	dialog: {
		id: number;
		kind: "select" | "confirm" | "input";
		title: string;
		args: unknown[];
	} | null;
	/** User command list from .pi/commands.json (terminal left panel). */
	commands: CommandDef[];
	commandsPath: string;
	/** Slash-command catalog for the chat input (builtin + extension +
	 *  template + skill). */
	slashCommands: SlashCommandInfo[];
	/** Open terminal tabs (metadata only; streams go through the bridge). */
	terminals: TerminalMeta[];
	/** Goal / review status (set via the goal bar). */
	goal: GoalStatus;
	/** Settings-panel state (system prompt, skill/extension toggles, presets). */
	settings: UiSettingsState | null;
	/** AI-started background servers (managed from the 后台任务 panel). The
	 *  list lives on the client session, so it survives conversation ends. */
	bgServers: BgServer[];
	/** Last fetch_models probe result (custom-provider model list), matched by
	 *  reqId in the model config modal. */
	fetchModelsResult: {
		reqId: number;
		ok: boolean;
		models?: UiModelConfigEntry[];
		error?: string;
	} | null;
	/** Last source-control query result (scm_status / scm_filediff /
	 *  scm_commit), matched by reqId in the SCM panel. */
	scmData: ServerMessage | null;
	/** Increments when the server reports the watched git dir changed
	 *  outside the panel — SCMPanel refreshes on change while visible. */
	scmDirty: number;
}

type Action =
	| { type: "status"; status: ConnStatus }
	| { type: "snapshot"; state: UiState }
	| { type: "tool_delta"; toolCallId: string; toolName: string; delta: string }
	| {
			type: "message_delta";
			messageId: string;
			usage: { input: number; output: number; total: number } | null;
			assistantMessageEvent: { type: string; contentIndex?: number; delta?: string };
	  }
	| { type: "tool_status"; status: ToolStatus }
	| { type: "notice"; notice: Notice }
	| { type: "dismiss_notice"; id: number }
	| { type: "ready"; serverVersion: string }
	| { type: "sessions"; sessions: SessionSummary[] }
	| {
			type: "conversations";
			conversations: ConversationSummary[];
			activeId: string;
	  }
	| { type: "projects"; projects: ProjectSummary[] }
	| { type: "files"; files: FileListing }

	| { type: "file_changed"; path: string }
	| { type: "file_content"; content: FileContent }
	| { type: "models"; models: ModelInfo[]; loading: boolean }
	| { type: "models_config"; providers: UiProviderConfig[] }
	| { type: "providers_status"; providers: ProviderStatus[] }
	| { type: "fetch_models_result"; result: { reqId: number; ok: boolean; models?: UiModelConfigEntry[]; error?: string } }
	| { type: "scm_data"; data: ServerMessage }
	| { type: "scm_changed" }
	| { type: "install_result"; result: { ok: boolean; detail: string } }
	| {
			type: "path_completions";
			completions: { name: string; path: string; type: "dir" | "file" }[];
	  }
	| {
			type: "update_status";
			status: {
				current: string;
				latest: string | null;
				latestPublishedAt: string | null;
				upToDate: boolean;
				pendingRestart: boolean;
				error?: string;
			};
	  }
	| { type: "update_result"; result: { ok: boolean; detail: string } }
	| { type: "widgets"; widgets: { key: string; lines: string[] }[] }
	| { type: "statuses"; statuses: { key: string; text: string | undefined }[] }
	| {
			type: "dialog";
			dialog: {
				id: number;
				kind: "select" | "confirm" | "input";
				title: string;
				args: unknown[];
			} | null;
	  }
	| { type: "commands"; commands: CommandDef[]; path: string }
	| { type: "slash_commands"; commands: SlashCommandInfo[] }
	| { type: "terminal_add"; meta: TerminalMeta }
	| { type: "terminal_remove"; id: string }
	| { type: "terminal_exit"; conversationId?: string; terminalId: string; exitCode: number | null }
	| { type: "terminal_restart"; terminalId: string }
	| { type: "terminal_list"; conversationId?: string; terminals: TerminalInfo[] }
	| { type: "goal_status"; status: GoalStatus }
	| { type: "settings"; settings: UiSettingsState }
	| { type: "bg_servers"; servers: BgServer[] };

const MAX_LIVE_OUTPUT = 200_000;
const MAX_TERM_BUFFER = 200_000;

/** Initial (inactive) goal status before the server pushes the first one. */
const DEFAULT_GOAL: GoalStatus = {
	conversationId: null,
	goal: null,
	reviewModel: null,
	maxRounds: 3,
	locked: true,
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

/**
 * Bridges terminal output from the socket to live xterm instances. Output for
 * a terminal whose component isn't mounted yet (or that this tab doesn't know
 * about) is buffered (capped) so nothing is lost during mount/reconnect.
 */
interface TerminalWriter {
	write: (data: string) => void;
	dispose: () => void;
}

function makeTerminalBridge() {
	/** Multiple writers may subscribe to the same (conversation, terminal) pair —
	 *  e.g. the SCM panel's hidden query terminal parses output through its own
	 *  writer while a (hidden) xterm instance may also be registered for it.
	 *  A Set keeps them all: later registrations no longer shadow earlier ones. */
	const writers = new Map<string, Set<TerminalWriter>>();
	const buffers = new Map<string, string>();
	const key = (conversationId: string, terminalId: string) => `${conversationId}:${terminalId}`;
	return {
		write(conversationId: string, terminalId: string, data: string): void {
			const writerKey = key(conversationId, terminalId);
			const set = writers.get(writerKey);
			if (set && set.size > 0) {
				for (const w of set) {
					try {
						w.write(data);
					} catch {
						// best effort
					}
				}
				return;
			}
			const prev = buffers.get(writerKey) ?? "";
			const next =
				prev.length + data.length > MAX_TERM_BUFFER ? data : prev + data;
			buffers.set(writerKey, next);
		},
		/** Register a writer (xterm instance / output parser); flushes buffered
		 *  output to the new subscriber. Returns an unregister fn. */
		register(conversationId: string, terminalId: string, writer: TerminalWriter): () => void {
			const writerKey = key(conversationId, terminalId);
			let set = writers.get(writerKey);
			if (!set) {
				set = new Set();
				writers.set(writerKey, set);
			}
			set.add(writer);
			const buffered = buffers.get(writerKey);
			if (buffered) {
				try {
					writer.write(buffered);
				} catch {
					// best effort
				}
				buffers.delete(writerKey);
			}
			return () => {
				const s = writers.get(writerKey);
				if (s) {
					s.delete(writer);
					if (s.size === 0) writers.delete(writerKey);
				}
				buffers.delete(writerKey);
			};
		},
		clear(): void {
			writers.clear();
			buffers.clear();
		},
	};
}

function pruneLiveOutputs(
	live: Map<string, { toolName: string; text: string }>,
	state: UiState,
): Map<string, { toolName: string; text: string }> {
	const completed = new Set<string>();
	for (const m of state.messages) {
		if (m.role === "toolResult" && m.toolCallId) completed.add(m.toolCallId);
		// bashExecution transcript messages supersede live bash deltas
		if (m.role === "bashExecution") completed.add(`bash-${m.id}`);
	}
	let changed = false;
	for (const id of live.keys()) {
		if (completed.has(id)) {
			live.delete(id);
			changed = true;
		}
	}
	return changed ? new Map(live) : live;
}

/** Drop tool_status entries once the authoritative toolResult message lands. */
function pruneToolStatuses(
	statuses: Map<string, ToolStatus>,
	state: UiState,
): Map<string, ToolStatus> {
	let changed = false;
	for (const id of statuses.keys()) {
		const landed = state.messages.some(
			(m) => m.role === "toolResult" && m.toolCallId === id,
		);
		if (landed) {
			statuses.delete(id);
			changed = true;
		}
	}
	return changed ? new Map(statuses) : statuses;
}

function reducer(state: ChatState, action: Action): ChatState {
	switch (action.type) {
		case "status":
			return {
				...state,
				status: action.status,
				// A new socket is not ready until its hello/ready round-trip completes.
				ready: action.status === "open" ? state.ready : false,
				// PTYs are conversation-owned and survive socket reconnects. Clear only
				// the browser views so xterm writers remount when the server replays them.
				terminals: action.status === "closed" ? [] : state.terminals,
			};
		case "ready":
			return { ...state, serverVersion: action.serverVersion, ready: true };
		case "snapshot":
			return {
				...state,
				ready: true,
				state: action.state,
				activeConversationId: action.state.conversationId,
				liveOutputs: pruneLiveOutputs(state.liveOutputs, action.state),
				toolStatuses: pruneToolStatuses(state.toolStatuses, action.state),
			};
		case "tool_delta": {
			const prev = state.liveOutputs.get(action.toolCallId);
			const text = (prev?.text ?? "") + action.delta;
			const capped =
				text.length > MAX_LIVE_OUTPUT ? text.slice(0, MAX_LIVE_OUTPUT) : text;
			const liveOutputs = new Map(state.liveOutputs);
			liveOutputs.set(action.toolCallId, {
				toolName: action.toolName,
				text: capped,
			});
			return { ...state, liveOutputs };
		}
		case "message_delta": {
			const ui = state.state;
			if (!ui) return state;
			const ame = action.assistantMessageEvent;
			const delta = ame.delta;
			const stats = action.usage
				? { ...ui.stats, tokens: { ...ui.stats.tokens, ...(action.usage as Record<string, number>) } }
				: ui.stats;
			if (ame.type === "text_delta" || ame.type === "thinking_delta") {
				if (!delta) return { ...state, state: { ...ui, stats } };
				const id = action.messageId;
				const prev = ui.streamingMessage;
				const base: UiMessage = prev && prev.id === id ? prev : { id, role: "assistant", content: [] };
				const content = [...base.content];
				const idx = ame.contentIndex ?? content.length - 1;
				const blockType = ame.type === "thinking_delta" ? "thinking" : "text";
				if (idx >= 0 && idx < content.length && content[idx].type === blockType) {
					if (blockType === "thinking") {
						const b = content[idx] as UiThinkingBlock;
						b.thinking = (b.thinking ?? "") + delta;
					} else {
						const b = content[idx] as UiTextBlock;
						b.text = (b.text ?? "") + delta;
					}
				} else {
					content.push(
						blockType === "thinking"
							? { type: "thinking", thinking: delta }
							: { type: "text", text: delta },
					);
				}
				return { ...state, state: { ...ui, stats, streamingMessage: { ...base, content, id } } };
			}
			return { ...state, state: { ...ui, stats } };
		}
		case "tool_status":
			return {
				...state,
				toolStatuses: new Map(state.toolStatuses).set(
					action.status.toolCallId,
					action.status,
				),
			};
		case "notice":
			return { ...state, notices: [...state.notices, action.notice].slice(-6) };
		case "dismiss_notice":
			return {
				...state,
				notices: state.notices.filter((n) => n.id !== action.id),
			};
		case "sessions":
			return { ...state, sessions: action.sessions };
		case "conversations":
			return {
				...state,
				conversations: action.conversations,
				activeConversationId: action.activeId,
			};
		case "projects":
			return { ...state, projects: action.projects };
		case "files":
			return { ...state, files: action.files };
		case "file_changed":
			return { ...state, fileChanged: { path: action.path } };
		case "file_content":
			return { ...state, fileContent: action.content };
		case "models":
			return { ...state, models: action.models, modelsLoading: action.loading };
		case "models_config":
			return { ...state, modelsConfig: action.providers };
		case "providers_status":
			return { ...state, providers: action.providers };
		case "fetch_models_result":
			return { ...state, fetchModelsResult: action.result };
		case "install_result":
			return { ...state, installResult: action.result };
		case "scm_data":
			return { ...state, scmData: action.data };
		case "scm_changed":
			return { ...state, scmDirty: state.scmDirty + 1 };
		case "path_completions":
			return { ...state, pathCompletions: action.completions };
		case "update_status":
			return { ...state, update: action.status };
		case "update_result":
			return { ...state, updateResult: action.result };
		case "widgets":
			return { ...state, widgets: action.widgets };
		case "statuses":
			return { ...state, statuses: action.statuses };
		case "dialog":
			return { ...state, dialog: action.dialog };
		case "commands":
			return {
				...state,
				commands: action.commands,
				commandsPath: action.path,
			};
		case "slash_commands":
			return { ...state, slashCommands: action.commands };
		case "goal_status":
			return { ...state, goal: action.status };
		case "settings":
			return { ...state, settings: action.settings };
		case "bg_servers":
			return { ...state, bgServers: action.servers };
		case "terminal_add":
			return { ...state, terminals: [...state.terminals, action.meta] };
		case "terminal_remove":
			return {
				...state,
				terminals: state.terminals.filter((t) => t.id !== action.id),
			};
		case "terminal_exit":
			if (
				action.conversationId &&
				(state.activeConversationId || state.state?.conversationId) &&
				action.conversationId !== (state.activeConversationId || state.state?.conversationId)
			) return state;
			return {
				...state,
				terminals: state.terminals.map((t) =>
					t.id === action.terminalId
						? { ...t, running: false, exitCode: action.exitCode }
						: t,
				),
			};
		case "terminal_restart":
			// The command is re-running in the same tab (server restarted the PTY).
			return {
				...state,
				terminals: state.terminals.map((t) =>
					t.id === action.terminalId
						? { ...t, running: true, exitCode: null }
						: t,
				),
			};
		case "terminal_list":
			if (
				action.conversationId &&
				(state.activeConversationId || state.state?.conversationId) &&
				action.conversationId !== (state.activeConversationId || state.state?.conversationId)
			) {
				return state;
			}
			return {
				...state,
				terminals: action.terminals.map((terminal) => ({
					...terminal,
					conversationId: action.conversationId ?? state.state?.conversationId ?? "",
				})),
			};
		default:
			return state;
	}
}

const CLIENT_ID_KEY = "pi-web-client-id";
let cachedClientId: string | null = null;

/**
 * 客户端标识 —— **每标签页独立**（sessionStorage 而非 localStorage）。
 *
 * 曾用 localStorage：同源所有标签页共享同一 clientId，后端把它们挂到同一个
 * ClientSession 上互为镜像——B 标签页切换对话会同步切走 A 页、甚至把 A 页
 * 正在输出的 agent 强制中断且状态持久化（issue #10）。改为 sessionStorage 后
 * 新开标签页即新客户端；刷新本页仍保留同一 id，client-state（最近项目等）不丢。
 */
export function getClientId(): string {
	if (cachedClientId) return cachedClientId;
	let id: string | null = null;
	try {
		id = sessionStorage.getItem(CLIENT_ID_KEY);
		if (!id) {
			id = randomUuid();
			sessionStorage.setItem(CLIENT_ID_KEY, id);
		}
	} catch {
		// storage 不可用（隐私模式等）：退化为页面生命周期内的一次性 id
		id = id ?? randomUuid();
	}
	cachedClientId = id;
	return id;
}

/** Resolve the WebSocket URL: same host when served by the backend, or the Vite proxy in dev. */
function wsUrl(): string {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	return withToken(`${proto}//${location.host}/ws`);
}

export function useChat() {
	const [chat, dispatch] = useReducer(reducer, {
		status: "connecting",
		ready: false,
		state: null,
		liveOutputs: new Map(),
		toolStatuses: new Map(),
		notices: [],
		sessions: [],
		conversations: [],
		activeConversationId: "",
		projects: [],
		files: null,

		fileChanged: null,
		fileContent: null,
		models: [],
		modelsLoading: false,
		modelsConfig: [],
		providers: [],
		installResult: null,
		pathCompletions: [],
		update: null,
		updateResult: null,
		widgets: [],
		statuses: [],
		dialog: null,
		commands: [],
		commandsPath: "",
		slashCommands: [],
		terminals: [],
		goal: DEFAULT_GOAL,
		bgServers: [],
		settings: null,
		fetchModelsResult: null,
		scmData: null,
		scmDirty: 0,
	});
	const wsRef = useRef<WebSocket | null>(null);
	/** Terminal output bridge (writers keyed by terminalId). */
	const bridgeRef = useRef(makeTerminalBridge());
	/** Reconnect backoff counter — ref so it never causes re-renders. */
	const retryRef = useRef(0);
	/** Pending reconnect timer. */
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** False once the hook is unmounted/cleaned up — stops stale onclose handlers from reconnecting. */
	const aliveRef = useRef(true);
	/** Last time any server message arrived — used to detect half-open connections. */
	const lastBeatRef = useRef(0);
	const noticeId = useRef(0);

	const pushNotice = useCallback((level: Notice["level"], text: string) => {
		const id = ++noticeId.current;
		dispatch({ type: "notice", notice: { id, level, text } });
		// 自动消失计时由通知组件（NoticeToast）管理：悬浮暂停、移开继续。
	}, []);

	const send = useCallback((msg: ClientMessage) => {
		const ws = wsRef.current;
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(msg));
			return true;
		}
		return false;
	}, []);

	/** Stable across renders — the reconnect loop lives entirely inside this closure. */
	const connect = useCallback(() => {
		if (!aliveRef.current) return;
		dispatch({ type: "status", status: "connecting" });
		const ws = new WebSocket(wsUrl());
		wsRef.current = ws;

		ws.onopen = () => {
			if (wsRef.current !== ws) return; // stale socket
			dispatch({ type: "status", status: "open" });
			retryRef.current = 0;
			lastBeatRef.current = Date.now();
			ws.send(
				JSON.stringify({
					type: "hello",
					clientId: getClientId(),
				} satisfies ClientMessage),
			);
		};

		ws.onmessage = (ev) => {
			if (wsRef.current !== ws) return; // stale socket
			lastBeatRef.current = Date.now(); // any traffic proves the connection is alive
			let msg: ServerMessage;
			try {
				msg = JSON.parse(ev.data as string) as ServerMessage;
			} catch {
				return;
			}
			switch (msg.type) {
				case "ready":
					dispatch({ type: "ready", serverVersion: msg.serverVersion });
					// Ensure a fresh snapshot on (re)connect.
					ws.send(
						JSON.stringify({ type: "get_state" } satisfies ClientMessage),
					);
					// Sessions + recent projects are LAZY: LeftPanel requests them
					// when it is actually shown — listing scans every session file
					// on disk (listAll scans ALL projects), too heavy for the
					// connect critical path.
					ws.send(
						JSON.stringify({ type: "list_files" } satisfies ClientMessage),
					);
					ws.send(
						JSON.stringify({ type: "list_models" } satisfies ClientMessage),
					);
					ws.send(
						JSON.stringify({ type: "list_commands" } satisfies ClientMessage),
					);
					ws.send(
						JSON.stringify({ type: "get_commands" } satisfies ClientMessage),
					);
					ws.send(
						JSON.stringify({ type: "check_update" } satisfies ClientMessage),
					);
					break;
				case "snapshot":
					dispatch({ type: "snapshot", state: msg.state });
					break;
				case "tool_delta":
					dispatch({
						type: "tool_delta",
						toolCallId: msg.toolCallId,
						toolName: msg.toolName,
						delta: msg.delta,
					});
					break;
				case "message_delta":
					dispatch({
						type: "message_delta",
						messageId: msg.messageId,
						usage: msg.usage,
						assistantMessageEvent: msg.assistantMessageEvent,
					});
					break;
				case "tool_status":
					dispatch({ type: "tool_status", status: msg });
					break;
				case "notice": {
					const id = ++noticeId.current;
					dispatch({
						type: "notice",
						notice: { id, level: msg.level, text: msg.text },
					});
					break;
				}
				case "sessions":
					dispatch({ type: "sessions", sessions: msg.sessions });
					break;
				case "conversations":
					dispatch({
						type: "conversations",
						conversations: msg.conversations,
						activeId: msg.activeId,
					});
					break;
				case "projects":
					dispatch({ type: "projects", projects: msg.projects });
					break;
				case "files":
					dispatch({ type: "files", files: msg });
					break;
				case "file_changed":
					dispatch({ type: "file_changed", path: msg.path });
					break;
				case "file_content":
					dispatch({ type: "file_content", content: msg });
					break;
				case "models":
					dispatch({ type: "models", models: msg.models, loading: false });
					break;
				case "models_config":
					dispatch({ type: "models_config", providers: msg.providers });
					break;
				case "providers_status":
					dispatch({ type: "providers_status", providers: msg.providers });
					break;
				case "fetch_models_result":
					dispatch({
						type: "fetch_models_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							models: msg.models,
							error: msg.error,
						},
					});
					break;
				case "scm_data":
					dispatch({ type: "scm_data", data: msg });
					break;
				case "scm_changed":
					dispatch({ type: "scm_changed" });
					break;
				case "install_result":
					dispatch({ type: "install_result", result: msg });
					break;
				case "path_completions":
					dispatch({ type: "path_completions", completions: msg.completions });
					break;
				case "update_status":
					dispatch({ type: "update_status", status: msg });
					break;
				case "update_result":
					dispatch({ type: "update_result", result: msg });
					break;
				case "widgets":
					dispatch({ type: "widgets", widgets: msg.widgets });
					break;
				case "statuses":
					dispatch({ type: "statuses", statuses: msg.statuses });
					break;
				case "dialog":
					dispatch({
						type: "dialog",
						dialog: {
							id: msg.id,
							kind: msg.kind,
							title: msg.title,
							args: msg.args,
						},
					});
					break;
				case "dialog_closed":
					dispatch({ type: "dialog", dialog: null });
					break;
				case "terminal_output":
					bridgeRef.current.write(
						msg.conversationId ?? chatApi.current.chat.activeConversationId,
						msg.terminalId,
						msg.data,
					);
					break;
				case "terminal_exit":
					dispatch({
						type: "terminal_exit",
						conversationId: msg.conversationId,
						terminalId: msg.terminalId,
						exitCode: msg.exitCode,
					});
					break;
				case "terminal_list":
					dispatch({
						type: "terminal_list",
						conversationId: msg.conversationId,
						terminals: msg.terminals,
					});
					break;
				case "commands":
					dispatch({
						type: "commands",
						commands: msg.commands,
						path: msg.path,
					});
					break;
				case "slash_commands":
					dispatch({ type: "slash_commands", commands: msg.commands });
					break;
				case "goal_status":
					dispatch({ type: "goal_status", status: msg.status });
					break;
				case "settings_state":
					dispatch({ type: "settings", settings: msg.settings });
					break;
				case "bg_servers":
					dispatch({ type: "bg_servers", servers: msg.servers });
					break;
				default:
					break;
			}
		};

		ws.onclose = () => {
			if (wsRef.current === ws) wsRef.current = null;
			// Terminals died with the server-side PTYs — drop writers/buffers.
			bridgeRef.current.clear();
			// Cleanup closed this socket on purpose — do not reconnect.
			if (!aliveRef.current) return;
			// A newer socket already took over (e.g. a StrictMode remount raced
			// this socket's close) — do not spawn a third connection that would
			// shadow the live one and drop its incoming messages.
			if (wsRef.current && wsRef.current !== ws) return;
			dispatch({ type: "status", status: "closed" });
			// Reconnect with exponential backoff (1s → 2s → 4s → … capped at 10s).
			const delay = Math.min(1000 * 2 ** retryRef.current, 10_000);
			retryRef.current += 1;
			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				connect();
			}, delay);
		};

		ws.onerror = () => {
			// onclose fires after onerror, triggering reconnect.
			// Do NOT call ws.close() here: it's redundant and causes a browser
			// warning "WebSocket is closed before the connection is established"
			// when the connection is still in CONNECTING state.
		};
	}, []);

	// Mount once; all reconnection is self-contained in `connect`.
	useEffect(() => {
		aliveRef.current = true;
		connect();
		// Watchdog: if no server message arrives for 30s, assume the connection is
		// half-open and force a close, which triggers the normal reconnect path.
		const watchdog = setInterval(() => {
			if (!aliveRef.current) return;
			const ws = wsRef.current;
			if (
				ws &&
				ws.readyState === WebSocket.OPEN &&
				Date.now() - lastBeatRef.current > 30_000
			) {
				ws.close();
			}
		}, 5_000);
		return () => {
			aliveRef.current = false;
			clearInterval(watchdog);
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			wsRef.current?.close();
			wsRef.current = null;
		};
	}, [connect]);

	const dismissNotice = useCallback(
		(id: number) => dispatch({ type: "dismiss_notice", id }),
		[],
	);

	// -- terminal tab management ----------------------------------------------

	const terminalCreate = useCallback(
		(meta: TerminalMeta) => dispatch({ type: "terminal_add", meta }),
		[],
	);
	const terminalClose = useCallback(
		(id: string) => dispatch({ type: "terminal_remove", id }),
		[],
	);
	const terminalRestart = useCallback(
		(id: string) => dispatch({ type: "terminal_restart", terminalId: id }),
		[],
	);
	const terminalRegister = useCallback(
		(conversationId: string, id: string, writer: TerminalWriter) =>
			bridgeRef.current.register(conversationId, id, writer),
		[],
	);

	const chatApi = useRef({
		chat,
		send,
		pushNotice,
		dismissNotice,
		terminal: {
			create: terminalCreate,
			close: terminalClose,
			register: terminalRegister,
			restart: terminalRestart,
		},
	});
	chatApi.current = {
		chat,
		send,
		pushNotice,
		dismissNotice,
		terminal: {
			create: terminalCreate,
			close: terminalClose,
			register: terminalRegister,
			restart: terminalRestart,
		},
	};
	return chatApi.current;
}
