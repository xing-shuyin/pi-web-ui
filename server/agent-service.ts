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
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionUIContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type {
	CommandDef,
	ConversationSummary,
	FileEntry,
	ProjectSummary,
	ServerMessage,
	SessionSummary,
	UiMessage,
	UiProviderConfig,
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

const SNAPSHOT_INTERVAL_MS = 60;
const WIDGET_REFRESH_MS = 2000;
const WIDGET_WIDTH = 80;
/** Preview panel cap: only the first 512KB of a file is ever read/sent. */
const MAX_PREVIEW_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Preview kind classification. The preview panel only opens image / video /
// text-editable files; everything else (exe, jar, archives, …) is refused so
// it is never read or sent to the browser. Media files are served over the
// /api/file HTTP endpoint instead of the WebSocket, so they are classified
// here but never read into the snapshot path.
// ---------------------------------------------------------------------------

export type PreviewKind = "image" | "video" | "text" | "none";

const PREVIEW_IMAGE_EXTS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"bmp",
	"ico",
	"avif",
	"jfif",
	"tif",
	"tiff",
]);
const PREVIEW_VIDEO_EXTS = new Set([
	"mp4",
	"webm",
	"mov",
	"mkv",
	"avi",
	"m4v",
	"ogv",
	"mpg",
	"mpeg",
	"wmv",
	"flv",
]);
const PREVIEW_TEXT_EXTS = new Set([
	// code
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"jsm",
	"es6",
	"vue",
	"svelte",
	"py",
	"pyw",
	"ipynb",
	"go",
	"rs",
	"c",
	"h",
	"cpp",
	"hpp",
	"cc",
	"cxx",
	"hh",
	"csh",
	"java",
	"kt",
	"kts",
	"scala",
	"sc",
	"cs",
	"fs",
	"fsx",
	"fsi",
	"sh",
	"bash",
	"zsh",
	"fish",
	"bat",
	"cmd",
	"ps1",
	"psd1",
	"psm1",
	"rb",
	"php",
	"pl",
	"pm",
	"tcl",
	"lua",
	"r",
	"rmd",
	"sql",
	"swift",
	"dart",
	"groovy",
	"gradle",
	"tf",
	"tfvars",
	"hcl",
	"nim",
	"zig",
	"v",
	"vala",
	"d",
	"clj",
	"cljs",
	"cljc",
	"edn",
	"ex",
	"exs",
	"erl",
	"hrl",
	"ml",
	"mli",
	// markup / config / data
	"json",
	"jsonc",
	"json5",
	"jsonl",
	"md",
	"mdx",
	"markdown",
	"html",
	"htm",
	"xhtml",
	"css",
	"scss",
	"sass",
	"less",
	"styl",
	"xml",
	"dtd",
	"yaml",
	"yml",
	"toml",
	"ini",
	"cfg",
	"conf",
	"properties",
	"env",
	"log",
	"txt",
	"text",
	"csv",
	"tsv",
	"lock",
	"sqlite",
	"graphql",
	"gql",
	"proto",
	"prisma",
	"asm",
	"s",
]);

/**
 * Classify a file name into its preview category. Files with no extension
 * (README, Makefile, .gitignore, …) are treated as text. Everything not in an
 * allowlist (exe, jar, dll, zip, …) is "none" — never previewed.
 */
export function previewKind(name: string): PreviewKind {
	const dot = name.lastIndexOf(".");
	// A leading dot with nothing after it (.gitignore, .env) counts as no ext.
	const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
	if (PREVIEW_IMAGE_EXTS.has(ext)) return "image";
	if (PREVIEW_VIDEO_EXTS.has(ext)) return "video";
	if (ext === "" || PREVIEW_TEXT_EXTS.has(ext)) return "text";
	return "none";
}

/**
 * Content sniff for the preview: any data that has no NUL bytes and no
 * meaningful control-char ratio is treated as text — so files with unknown
 * or absent extensions (jsonl, .log.1, …) still open as text. NULs catch
 * zip/sqlite/png/… even when the extension claims text.
 */
function looksLikeText(buf: Buffer): boolean {
	if (buf.length === 0) return true;
	if (buf.includes(0)) return false;
	const text = buf.toString("utf8");
	let control = 0;
	for (const ch of text) {
		const c = ch.charCodeAt(0);
		// Keep \t \n \r \f (and \b); everything else < 0x20 is binary-ish.
		if (c < 0x20 && c !== 9 && c !== 10 && c !== 12 && c !== 13) control++;
	}
	return control / Math.max(text.length, 1) < 0.02;
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

/** First few KB of binary data as a classic hex + ASCII dump (preview only). */
function hexDump(buf: Buffer, maxBytes = 4096): string {
	const data = buf.subarray(0, Math.min(buf.length, maxBytes));
	const rows: string[] = [];
	for (let off = 0; off < data.length; off += 16) {
		const chunk = data.subarray(off, off + 16);
		const hex = [...chunk]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join(" ");
		const ascii = [...chunk]
			.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
			.join("");
		rows.push(
			`${off.toString(16).padStart(8, "0")}  ${hex.padEnd(47, " ")}  ${ascii}`,
		);
	}
	return rows.join("\n");
}

// ---------------------------------------------------------------------------
// Web UI context adapter — bridges extension UI calls (setWidget/notify) to the
// browser. Extensions like rpiv-todo render a TUI widget via
// `ui.setWidget(key, (tui, theme) => comp)`; we capture the component, render it
// with a mock theme to plain text lines, and push them to the client.
// ---------------------------------------------------------------------------

/** Mock theme: TUI color functions degrade to identity so widget text survives. */
const mockTheme = new Proxy(
	{
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
		dim: (text: string) => text,
	},
	{
		get(target, prop) {
			if (prop in target)
				return (target as Record<string, unknown>)[prop as string];
			// Unknown theme methods → no-op passthrough.
			return (_arg: unknown, text?: unknown) =>
				text !== undefined ? text : "";
		},
	},
) as unknown as Theme;

/** Mock TUI: any method call is a safe no-op. */
const mockTui = new Proxy(
	{
		requestRender: () => {},
		render: () => {},
	},
	{
		get(target, prop) {
			if (prop in target)
				return (target as Record<string, unknown>)[prop as string];
			return () => {};
		},
	},
);

interface WidgetEntry {
	/** Renders the widget to plain text lines, or undefined when empty. */
	render: (width: number) => string[] | undefined;
	/** Whether the widget can be disposed. */
	dispose?: () => void;
}

/**
 * Implements the subset of ExtensionUIContext that makes sense for a web UI.
 * TUI-only affordances (select/confirm/input dialogs, terminal input, custom
 * footer) are inert: dialogs resolve to cancellation instead of blocking.
 */
export class WebUIContext {
	readonly theme = mockTheme;
	private widgets = new Map<string, WidgetEntry>();
	private lastLines = new Map<string, string[]>();
	private emit: (msg: ServerMessage) => void;

	constructor(emit: (msg: ServerMessage) => void) {
		this.emit = emit;
	}

	// -- widgets -------------------------------------------------------------

	/** Matches ExtensionUIContext's overloaded setWidget exactly. */
	setWidget: ExtensionUIContext["setWidget"] = (key, content, options) => {
		void options;
		if (content === undefined) {
			this.widgets.delete(key);
			this.lastLines.delete(key);
			this.push();
			return;
		}
		if (typeof content === "function") {
			let comp:
				| { render?: (w: number) => string[] | undefined; dispose?: () => void }
				| undefined;
			try {
				// Mock TUI/theme: extensions only read a handful of theme helpers;
				// everything else is a no-op, so the widget renders to plain text.
				comp = content(mockTui as never, mockTheme as never) as typeof comp;
			} catch {
				comp = undefined;
			}
			this.widgets.set(key, {
				render: (w) => comp?.render?.(w),
				dispose: comp?.dispose,
			});
		} else {
			this.widgets.set(key, { render: () => content });
		}
		this.push();
	};

	/** Re-render all widgets and push when content changed (polled + on demand). */
	refresh(): void {
		let changed = false;
		for (const [key, w] of this.widgets) {
			let lines: string[] | undefined;
			try {
				lines = w.render(WIDGET_WIDTH);
			} catch {
				lines = undefined;
			}
			const prev = this.lastLines.get(key);
			if (JSON.stringify(lines ?? null) !== JSON.stringify(prev ?? null)) {
				this.lastLines.set(key, lines ?? []);
				changed = true;
			}
		}
		if (changed) this.push();
	}

	private push(): void {
		const widgets = this.snapshot();
		this.emit({ type: "widgets", widgets });
	}

	/** Render all widgets to their current text lines (without emitting). */
	snapshot(): { key: string; lines: string[] }[] {
		return [...this.widgets.entries()].map(([key, w]) => {
			let lines: string[] | undefined;
			try {
				lines = w.render(WIDGET_WIDTH);
			} catch {
				lines = undefined;
			}
			this.lastLines.set(key, lines ?? []);
			return { key, lines: lines ?? [] };
		});
	}

	// -- notifications --------------------------------------------------------

	notify(message: string, type?: "info" | "warning" | "error"): void {
		this.emit({ type: "notice", level: type ?? "info", text: message });
	}

	// -- footer status (pi-lens "LSP Inactive", pi-cache-optimizer cache stats) --

	private statuses = new Map<string, string>();

	setStatus(key: string, text: string | undefined): void {
		if (text === undefined || text === "") {
			this.statuses.delete(key);
		} else {
			this.statuses.set(key, text);
		}
		this.pushStatuses();
	}

	private pushStatuses(): void {
		this.emit({
			type: "statuses",
			statuses: [...this.statuses.entries()].map(([k, v]) => ({
				key: k,
				text: v,
			})),
		});
	}

	/** Current footer status entries (for replay on socket attach). */
	statusSnapshot(): { key: string; text: string | undefined }[] {
		return [...this.statuses.entries()].map(([k, v]) => ({ key: k, text: v }));
	}

	// -- dialogs (select/confirm/input bridged to the browser) ---------------

	private dialogSeq = 0;
	private pendingDialogs = new Map<
		number,
		(value: string | boolean | null) => void
	>();

	select = (title: string, options: string[]): Promise<string | undefined> =>
		this.openDialog("select", title, [options]) as Promise<string | undefined>;
	confirm = (title: string, message: string): Promise<boolean> =>
		this.openDialog("confirm", title, [message]) as Promise<boolean>;
	input = (title: string, placeholder?: string): Promise<string | undefined> =>
		this.openDialog("input", title, [placeholder ?? ""]) as Promise<
			string | undefined
		>;

	private openDialog(
		kind: "select" | "confirm" | "input",
		title: string,
		args: unknown[],
	): Promise<string | boolean | null> {
		return new Promise((resolve) => {
			const id = ++this.dialogSeq;
			this.pendingDialogs.set(id, resolve);
			this.emit({ type: "dialog", id, kind, title, args });
		});
	}

	/** Resolve a pending dialog with the user's choice (called from the client). */
	resolveDialog(id: number, value: string | boolean | null): void {
		const resolve = this.pendingDialogs.get(id);
		if (resolve) {
			this.pendingDialogs.delete(id);
			resolve(value);
			this.emit({ type: "dialog_closed", id });
		}
	}

	// -- inert TUI-only affordances ------------------------------------------

	onTerminalInput = (): (() => void) => () => {};
	setWorkingMessage = (): void => {};
	setWorkingVisible = (): void => {};
	setWorkingIndicator = (): void => {};
	setHiddenThinkingLabel = (): void => {};
	setFooter = (): void => {};
	setHeader = (): void => {};
	setTitle = (): void => {};
	custom = <T>(_factory: unknown, _done?: unknown): Promise<T> =>
		new Promise<T>(() => {});
	pasteToEditor = (): void => {};
	setEditorText = (): void => {};
	getEditorText = (): string => "";
	editor = async (): Promise<string | undefined> => undefined;
	addAutocompleteProvider = (): void => {};
	setEditorComponent = (): void => {};
	getEditorComponent = (): undefined => undefined;
	getAllThemes = (): { name: string; path: string | undefined }[] => [];
	getTheme = (): undefined => undefined;
	setTheme = (): { success: boolean; error?: string } => ({ success: false });
	getToolsExpanded = (): boolean => false;
	setToolsExpanded = (): void => {};

	/** Dispose all widgets (extension reload / session teardown). */
	dispose(): void {
		for (const w of this.widgets.values()) {
			try {
				w.dispose?.();
			} catch {
				// best effort
			}
		}
		this.widgets.clear();
		this.lastLines.clear();
		// Cancel any pending dialogs.
		for (const [id, resolve] of this.pendingDialogs) {
			resolve(null);
			this.emit({ type: "dialog_closed", id });
		}
		this.pendingDialogs.clear();
	}
}


const IS_WIN32 = process.platform === "win32";

// mac/linux: hide build & dependency noise (original behavior).
const IGNORED_ENTRIES = new Set([
	"node_modules",
	".git",
	".svn",
	".hg",
	"dist",
	".next",
	".nuxt",
	".cache",
	".venv",
	"venv",
	"__pycache__",
	"coverage",
	".pi-web",
	".DS_Store",
	"Thumbs.db",
]);

// Windows: the file tree is the primary way to navigate a project, so only
// hide what would flood or destabilize the panel (dependency trees, VCS
// internals, session data) plus pure junk. Build output (dist/.next/…) and
// local env dirs (venv/__pycache__/…) stay visible — "所有文件可查看".
const IGNORED_ENTRIES_WIN = new Set([
	"node_modules",
	".git",
	".pi-web",
	".DS_Store",
	"Thumbs.db",
	"desktop.ini",
]);

/** The ignore set for the current platform — keeps win/posix lists separate. */
function ignoredEntries(): Set<string> {
	return IS_WIN32 ? IGNORED_ENTRIES_WIN : IGNORED_ENTRIES;
}

function countLines(buf: Buffer): number {
	if (buf.length === 0) return 0;
	const hasTrailingNewline = buf[buf.length - 1] === 10; /* \n */
	let lines = 0;
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] === 10) lines++;
	}
	// A trailing newline terminates the last line instead of starting an empty
	// one — matches the client preview's split-based line numbering.
	return hasTrailingNewline ? lines : lines + 1;
}

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

/**
 * Resolve a workspace-relative path against a root, refusing traversal
 * (".." escapes). Returns { abs, rel } — rel is normalized and slash-
 * separated — or null when the path leaves the workspace.
 */
export function workspacePath(
	root: string,
	raw: string,
): { abs: string; rel: string } | null {
	const abs = resolve(root, raw);
	const rawRel = relative(root, abs);
	if (rawRel.startsWith("..") || rawRel.includes(`${sep}..`)) return null;
	// Normalize to forward slashes: the wire protocol and the frontend always
	// use "/", but relative() returns "\\" on Windows.
	return { abs, rel: rawRel.split(sep).join("/") };
}

/**
 * Read a directory for the file panel. The two platforms intentionally use
 * different strategies — do NOT unify them:
 *
 * darwin/linux (posix): original behavior — hide build/dependency noise,
 * small cap, hard error notice when the directory itself is unreadable.
 *
 * win32: stability and completeness first, preview second. ACL-protected
 * system dirs (C:\$Recycle.Bin, Program Files internals, OneDrive placeholders)
 * throw EPERM/EACCES on open — that must not kill the panel, so it degrades
 * to an empty listing plus a warning. Directory symlinks/junctions are
 * followed so mklink /D folders stay navigable; broken links still show as
 * files instead of vanishing. The cap is 4x posix and truncation is reported
 * via `truncated` instead of happening silently.
 */
async function readDirForUI(
	abs: string,
	rel: string,
): Promise<{ entries: FileEntry[]; truncated: boolean; error?: string }> {
	const fs = await import("node:fs/promises");
	const ignored = ignoredEntries();
	const MAX = IS_WIN32 ? 2000 : 500;

	let dirents: import("node:fs").Dirent[];
	try {
		dirents = await fs.readdir(abs, { withFileTypes: true });
	} catch (err) {
		if (!IS_WIN32) throw err;
		// Windows ACL-protected/system dirs throw EPERM/EACCES on open —
		// degrade to an empty listing; listFiles turns this into a warning.
		return { entries: [], truncated: false, error: (err as Error).message };
	}

	const out: FileEntry[] = [];
	for (const d of dirents) {
		if (ignored.has(d.name)) continue;
		let type: "dir" | "file";
		if (IS_WIN32 && d.isSymbolicLink()) {
			// mklink /D symlinks and junctions are reparse points — libuv
			// classifies them as links, so isDirectory() is false. Follow the
			// target so folder links stay navigable; broken links still show.
			try {
				const st = await fs.stat(join(abs, d.name));
				type = st.isDirectory() ? "dir" : "file";
			} catch {
				type = "file";
			}
		} else {
			type = d.isDirectory() ? "dir" : "file";
		}
		const entry: FileEntry = {
			name: d.name,
			path: rel === "" ? d.name : `${rel}/${d.name}`,
			type,
		};
		if (type === "file") entry.kind = previewKind(d.name);
		out.push(entry);
	}

	out.sort((a, b) =>
		a.type === b.type
			? a.name.localeCompare(b.name)
			: a.type === "dir"
				? -1
				: 1,
	);
	const truncated = out.length > MAX;
	if (truncated) out.length = MAX;
	return { entries: out, truncated };
}

// ---------------------------------------------------------------------------
// Per-client persisted UI state (<dataDir>/client-state.json)
// ---------------------------------------------------------------------------

interface ClientState {
	/** Absolute path of the workspace this client last used. */
	lastCwd?: string;
	/** Workspaces this client opened before, most recent first (capped at 30). */
	projects: { path: string; lastUsed: number }[];
}

/**
 * Persists which workspace each browser client last used + which workspaces it
 * has opened, so a server restart / page reload restores the same project and
 * the UI can offer a one-click recent-project list. File I/O is best-effort:
 * persistence problems must never crash the server or block a session.
 */
class ClientStateStore {
	private cache: Record<string, ClientState> | null = null;

	constructor(private filePath: string) {}

	private load(): Record<string, ClientState> {
		if (this.cache) return this.cache;
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<
				string,
				ClientState
			>;
			this.cache = parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			this.cache = {};
		}
		return this.cache;
	}

	private save(): void {
		try {
			mkdirSync(dirname(this.filePath), { recursive: true });
			writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2) + "\n");
		} catch {
			// best effort
		}
	}

	get(clientId: string): ClientState {
		return this.load()[clientId] ?? { projects: [] };
	}

	/** Remember which workspace a client last used; bumps its project entry. */
	remember(clientId: string, cwd: string): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		state.lastCwd = cwd;
		const now = Date.now();
		state.projects = [
			{ path: cwd, lastUsed: now },
			...state.projects.filter((p) => p.path !== cwd),
		].slice(0, 30);
		this.save();
	}
}

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
	/** Session event subscription — events are routed to THIS conversation. */
	unsubscribe?: () => void;
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
	queueSteering: number;
	queueFollowUp: number;
	/** tool_execution_start timestamps keyed by toolCallId — lets tool_status
	 *  report how long a tool actually ran (vs. waiting on the model). */
	toolStartTimes: Map<string, number>;
}

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

export class ClientSession {
	readonly clientId: string;
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

	/** PTY terminals for this client (killed when the last socket detaches). */
	readonly terminals = new TerminalManager((msg) => this.emit(msg));

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
	}

	static async create(
		clientId: string,
		cwd: string,
		stateStore: ClientStateStore,
	): Promise<ClientSession> {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();

		const cs = new ClientSession(clientId, cwd, agentDir, stateStore);
		const runtime = await createAgentSessionRuntime(cs.makeRuntimeFactory(), {
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
		const conv = cs.makeConversation(runtime);
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
	private makeRuntimeFactory(): CreateAgentSessionRuntimeFactory {
		return async ({ cwd: effectiveCwd, sessionManager }) => {
			const services = await createAgentSessionServices({
				cwd: effectiveCwd,
				modelRuntime: this.sharedModelRuntime,
			});
			return {
				...(await createAgentSessionFromServices({ services, sessionManager })),
				services,
				diagnostics: services.diagnostics,
			};
		};
	}

	/** Wrap a fresh runtime as a new conversation record. */
	private makeConversation(runtime: AgentSessionRuntime): Conversation {
		return {
			id: `c${++this.convSeq}`,
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
			msgIds: new Map(),
			nextMsgId: 1,
			userSeqByTs: new Map(),
			uiMessageCache: new Map(),
			lastMessagesSig: "",
			lastMessagesArray: [],
			queueSteering: 0,
			queueFollowUp: 0,
			toolStartTimes: new Map(),
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
	}

	detachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.delete(send);
		// No sockets left for this client — kill its terminals so processes don't
		// survive a closed tab / dropped connection.
		if (this.sinks.size === 0) this.terminals.killAll();
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
				break;
			}
			case "tool_execution_end": {
				const startedAt = conv.toolStartTimes.get(event.toolCallId);
				conv.toolStartTimes.delete(event.toolCallId);
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
			case "agent_end":
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
		if (msg) conv.uiMessageCache.set(cacheKey, msg);
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
		const rawMessages = state.messages
			.map((m) => this.serializeCached(m))
			.filter((m): m is NonNullable<typeof m> => m !== null);
		// Reuse the previous array when nothing changed: the element objects are
		// cached (reference-stable) anyway, and a stable array reference lets the
		// frontend memoize derived maps instead of rebuilding them every 60ms.
		const sig = rawMessages.map((m) => m.id).join("\u0001");
		const messages =
			conv.lastMessagesSig === sig ? conv.lastMessagesArray : rawMessages;
		conv.lastMessagesSig = sig;
		conv.lastMessagesArray = rawMessages;
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
	): Promise<{ code: number | null; out: string }> {
		return new Promise((resolve) => {
			let p;
			try {
				p = spawn(cmd, args, {
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
					headers: p.headers as Record<string, string> | undefined,
					models,
				};
			},
		);
		this.emit({ type: "models_config", providers: list });
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
			providers[pid] = {
				...(config.name?.trim() ? { name: config.name.trim() } : {}),
				...(config.api?.trim() ? { api: config.api.trim() } : {}),
				...(config.baseUrl?.trim() ? { baseUrl: config.baseUrl.trim() } : {}),
				...(config.apiKey?.trim() ? { apiKey: config.apiKey.trim() } : {}),
				...(config.authHeader ? { authHeader: true } : {}),
				...(config.headers && Object.keys(config.headers).length > 0
					? { headers: config.headers }
					: {}),
				models,
			};
			mkdirSync(this.agentDir, { recursive: true });
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

	private scheduleSnapshot(): void {
		if (this.snapshotTimer || this.disposed) return;
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = null;
			if (!this.disposed)
				this.emit({ type: "snapshot", state: this.snapshot() });
		}, SNAPSHOT_INTERVAL_MS);
	}

	// ---------------------------------------------------------------------------
	// Commands
	// ---------------------------------------------------------------------------

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
	): Promise<void> {
		try {
			const s = this.session;
			// Attach files as independent nextTurn context messages (asides) so the
			// user message stays clean; they render as separate attachment cards.
			const asides = await this.buildAttachmentMessages(attachments);
			for (const aside of asides) {
				await s.sendCustomMessage(aside.message, { deliverAs: "nextTurn" });
			}
			if (s.isStreaming) {
				// Steer: interrupts the current run — the message is delivered right
				// after the current assistant turn settles (remaining planned tool
				// calls are skipped) and the agent immediately responds to it. This
				// is the pi CLI Enter-during-streaming semantic (docs/usage: Enter
				// queues a steering message); followUp would wait for the whole run
				// to finish, which users perceive as ordinary queueing.
				await s.prompt(text, { streamingBehavior: "steer" });
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
	private async buildAttachmentMessages(
		attachments:
			| {
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
			  }[]
			| undefined,
	): Promise<{ message: Parameters<AgentSession["sendCustomMessage"]>[0] }[]> {
		if (!attachments || attachments.length === 0) return [];
		const fs = await import("node:fs/promises");
		const { resolve, sep, relative, extname, join } = await import("node:path");

		const root = resolve(this.cwd);
		const MAX_ATTACHMENT_BYTES = 200 * 1024;
		// Files at or below this size are inlined; larger files are referenced by
		// path only (the model reads them on demand — saves tokens for small edits).
		const MAX_INLINE_BYTES = Number(
			process.env.PI_WEB_INLINE_FILE_MAX ?? 12 * 1024,
		);
		const IMAGE_EXT = new Set([
			".png",
			".jpg",
			".jpeg",
			".gif",
			".webp",
			".bmp",
			".svg",
		]);
		const MIME: Record<string, string> = {
			".png": "image/png",
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".gif": "image/gif",
			".webp": "image/webp",
			".bmp": "image/bmp",
			".svg": "image/svg+xml",
		};

		const out: { message: Parameters<AgentSession["sendCustomMessage"]>[0] }[] =
			[];
		/** Cap for reading a file in "lines" mode (selected slice is inlined). */
		const MAX_LINES_READ_BYTES = 2 * 1024 * 1024;

		for (const att of attachments) {
			// Raw pasted/dropped/uploaded image — no workspace path involved (the
			// browser downscales client-side; this guard only prevents abuse).
			if (att.imageData) {
				const raw = att.imageData.replace(/^data:[^;]*;base64,/, "");
				const mimeType =
					att.mimeType?.startsWith("image/") ? att.mimeType : "image/png";
				const bytes = Buffer.byteLength(raw, "base64");
				const MAX_PASTED_IMAGE_BYTES = 2 * 1024 * 1024;
				if (bytes === 0) {
					this.emit({
						type: "notice",
						level: "error",
						text: `图片数据为空，已跳过`,
					});
					continue;
				}
				if (bytes > MAX_PASTED_IMAGE_BYTES) {
					this.emit({
						type: "notice",
						level: "warning",
						text: `图片过大已跳过（>2MB）：${att.name ?? "粘贴图片"}`,
					});
					continue;
				}
				out.push({
					message: {
						customType: "file",
						content: [{ type: "image", data: raw, mimeType }],
						display: true,
						details: {
							name: att.name ?? "image.png",
							// No workspace path — the card renders without the path line.
							path: undefined,
							mode: "image",
							size: bytes,
						},
					},
				});
				continue;
			}

			// Raw uploaded file (base64) — no workspace path involved. The bytes are
			// persisted under <dataDir>/uploads/<clientId>/ so the model can read
			// them on demand with its read tool (absolute path, no traversal guard
			// needed — the path is server-generated). Small text uploads are inlined
			// so the model sees them immediately; everything else becomes a path
			// reference.
			if (att.fileData) {
				const buf = Buffer.from(att.fileData, "base64");
				const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
				if (buf.length === 0) {
					this.emit({
						type: "notice",
						level: "error",
						text: `文件数据为空，已跳过`,
					});
					continue;
				}
				if (buf.length > MAX_UPLOAD_BYTES) {
					this.emit({
						type: "notice",
						level: "warning",
						text: `文件过大已跳过（>20MB）：${att.name ?? "上传文件"}`,
					});
					continue;
				}
				// Uploaded files live in a GLOBAL per-user dir (not inside the project
				// or the per-client session store) so browsing a repo never picks up
				// uploaded junk: <home>/.pi-web/uploads/<clientId>/.
				const { homedir } = await import("node:os");
				const uploadsDir = join(
					homedir(),
					".pi-web",
					"uploads",
					this.clientId,
				);
				const safeName = (att.name ?? "file")
					.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
					.slice(0, 80);
				const abs = join(uploadsDir, `${Date.now()}-${safeName}`);
				await fs.mkdir(uploadsDir, { recursive: true });
				await fs.writeFile(abs, buf);
				// Wire format: forward-slash absolute path (the read tool accepts
				// absolute paths; Windows uses "C:/..." — safe inside the XML-ish tag).
				const wirePath = abs.split(sep).join("/");
				if (buf.length <= MAX_INLINE_BYTES && looksLikeText(buf)) {
					const lines = countLines(buf);
					out.push({
						message: {
							customType: "file",
							content: [
								{
									type: "text",
									text: `\n<file path="${wirePath}">\n\`\`\`\n${buf.toString("utf8")}\n\`\`\`\n</file>`,
								},
							],
							display: true,
							details: {
								name: safeName,
								path: wirePath,
								mode: "inline",
								size: buf.length,
								lines,
							},
						},
					});
				} else {
					out.push({
						message: {
							customType: "file",
							content: [
								{
									type: "text",
									text: `<file path="${wirePath}" size="${buf.length}" />`,
								},
							],
							display: true,
							details: {
								name: safeName,
								path: wirePath,
								mode: "reference",
								size: buf.length,
							},
						},
					});
				}
				continue;
			}

			const abs = resolve(root, att.path);
			const rawRel = relative(root, abs);
			if (rawRel.startsWith("..") || rawRel.includes(`${sep}..`)) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `附件路径超出工作区：${att.path}`,
				});
				continue;
			}
			// Normalize to forward slashes (relative() returns "\\" on Windows);
			// <file path> and details.path must use the wire format.
			const rel = rawRel.split(sep).join("/");
			let stat:
				| { size: number; isFile(): boolean; isDirectory(): boolean }
				| undefined;
			try {
				stat = await fs.stat(abs);
			} catch {
				this.emit({
					type: "notice",
					level: "error",
					text: `附件不存在：${att.path}`,
				});
				continue;
			}

			const name = att.path.split(/[\\/]/).pop() ?? att.path;

			// Folders can't be inlined — always a path reference the model browses
			// on demand with its own tools (ls/read).
			if (stat.isDirectory()) {
				out.push({
					message: {
						customType: "file",
						content: [{ type: "text", text: `<folder path="${rel}" />` }],
						display: true,
						details: {
							name,
							path: rel,
							mode: "reference",
							type: "folder",
						},
					},
				});
				continue;
			}

			if (!stat.isFile()) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `跳过非文件附件：${att.path}`,
				});
				continue;
			}

			const ext = extname(att.path).toLowerCase();
			if (IMAGE_EXT.has(ext)) {
				// Images can't be referenced — they must be inlined, so keep a hard cap.
				if (stat.size > MAX_ATTACHMENT_BYTES) {
					this.emit({
						type: "notice",
						level: "warning",
						text: `图片附件过大已跳过（>200KB）：${att.path}`,
					});
					continue;
				}
				const data = await fs.readFile(abs, "base64");
				out.push({
					message: {
						customType: "file",
						content: [
							{ type: "image", data, mimeType: MIME[ext] ?? "image/png" },
						],
						display: true,
						details: { name, path: rel, mode: "image", size: stat.size },
					},
				});
				continue;
			}

			const makeReference = (): {
				message: Parameters<AgentSession["sendCustomMessage"]>[0];
			} => ({
				message: {
					customType: "file",
					content: [
						{
							type: "text",
							text: `<file path="${rel}" size="${stat.size}" />`,
						},
					],
					display: true,
					details: { name, path: rel, mode: "reference", size: stat.size },
				},
			});
			const makeInline = (
				buf: Buffer,
			): {
				message: Parameters<AgentSession["sendCustomMessage"]>[0];
			} => {
				const lines = countLines(buf);
				return {
					message: {
						customType: "file",
						content: [
							{
								type: "text",
								text: `\n<file path="${rel}">\n\`\`\`\n${buf.toString("utf8")}\n\`\`\`\n</file>`,
							},
						],
						display: true,
						details: {
							name,
							path: rel,
							mode: "inline",
							size: stat.size,
							lines,
						},
					},
				};
			};

			// Reference mode is always honored and never reads the file.
			if (att.mode === "reference") {
				out.push(makeReference());
				continue;
			}

			// Line-range mode: inline only the selected 1-based inclusive range.
			// Reading is capped so a huge file can't exhaust memory even though
			// the selected slice is small.
			if (att.mode === "lines") {
				const range = att.lines;
				if (!range || range.start < 1 || range.end < range.start) {
					this.emit({
						type: "notice",
						level: "warning",
						text: `行范围无效，已改为仅引用：${att.path}`,
					});
					out.push(makeReference());
					continue;
				}
				if (stat.size > MAX_LINES_READ_BYTES) {
					this.emit({
						type: "notice",
						level: "warning",
						text: `文件过大，已改为仅引用：${att.path}`,
					});
					out.push(makeReference());
					continue;
				}
				const buf = await fs.readFile(abs);
				if (buf.includes(0)) {
					this.emit({
						type: "notice",
						level: "warning",
						text: `二进制文件已改为仅引用：${att.path}`,
					});
					out.push(makeReference());
					continue;
				}
				const parts = buf.toString("utf8").split("\n");
				// A trailing newline yields an empty phantom line — drop it so line
				// numbers match the preview panel.
				if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
				const start = Math.min(range.start, parts.length);
				const end = Math.min(range.end, parts.length);
				if (start < 1 || end < start) {
					this.emit({
						type: "notice",
						level: "warning",
						text: `选中行超出文件范围，已改为仅引用：${att.path}`,
					});
					out.push(makeReference());
					continue;
				}
				const selected = parts.slice(start - 1, end).join("\n");
				out.push({
					message: {
						customType: "file",
						content: [
							{
								type: "text",
								text: `\n<file path="${rel}" lines="${start}-${end}">\n\`\`\`\n${selected}\n\`\`\`\n</file>`,
							},
						],
						display: true,
						details: {
							name,
							path: rel,
							mode: "lines",
							size: stat.size,
							lines: end - start + 1,
							startLine: start,
							endLine: end,
						},
					},
				});
				continue;
			}

			// Forced inline has a hard cap to protect the model context.
			if (att.mode === "inline") {
				if (stat.size > MAX_INLINE_BYTES) {
					this.emit({
						type: "notice",
						level: "warning",
						text: `文件过大，已改为仅引用：${att.path}`,
					});
					out.push(makeReference());
					continue;
				}
				const buf = await fs.readFile(abs);
				if (buf.includes(0)) {
					this.emit({
						type: "notice",
						level: "warning",
						text: `二进制文件已改为仅引用：${att.path}`,
					});
					out.push(makeReference());
					continue;
				}
				out.push(makeInline(buf));
				continue;
			}

			// Auto: small files inline, large files reference by path.
			if (stat.size > MAX_INLINE_BYTES) {
				out.push(makeReference());
				continue;
			}
			const buf = await fs.readFile(abs);
			if (buf.includes(0)) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `二进制文件已跳过（仅引用路径）：${att.path}`,
				});
				out.push(makeReference());
				continue;
			}
			out.push(makeInline(buf));
		}
		return out;
	}

	async abort(): Promise<void> {
		try {
			await this.session.abort();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `中止失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	async newChat(): Promise<void> {
		// Reuse an already-open blank conversation instead of piling up new ones
		// on every click: if the active chat has no messages it IS the new chat
		// (focus already on it); otherwise switch to the first blank one (under
		// the per-project running-list model displaced blanks are disposed, so
		// this branch normally can't exist — kept as a safety net).
		const isBlank = (c: Conversation): boolean => {
			try {
				return c.session.getSessionStats().totalMessages === 0;
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
			const runtime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(),
				{
					cwd: this.cwd,
					agentDir: this.agentDir,
					sessionManager: SessionManager.create(this.cwd),
				},
			);
			const conv = this.makeConversation(runtime);
			this.convs.set(conv.id, conv);
			this.activeId = conv.id;
			if (displaced) this.removeConversation(displaced.id);
			await this.bindSession();
			this.emitConversations();
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
	 * - idle + listed + opened-but-not-continued, or never listed at all → the
	 *   caller must drop it (returns it so removal happens only after the
	 *   active conversation has been switched away).
	 */
	private displaceActive(): Conversation | null {
		const conv = this.conv;
		if (conv.session.isStreaming) {
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
	/** Push the persisted session list to the client (client-requested). */
	async refreshSessions(): Promise<void> {
		await this.pushSessions();
	}

	private async pushSessions(): Promise<void> {
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
			const sorted = [...sessions.values()].sort(
				(a, b) => b.modified - a.modified,
			);
			this.emit({ type: "sessions", sessions: sorted });
		} catch {
			this.emit({ type: "sessions", sessions: [] });
		}
	}

	/** Switch the active session to a persisted one (from listSessions). */
	async switchSession(path: string): Promise<void> {
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
		try {
			const { resolve, sep, relative } = await import("node:path");
			const root = resolve(this.cwd);
			const target = relPath ? resolve(root, relPath) : root;
			const rawRel = relative(root, target);
			if (rawRel.startsWith("..") || rawRel.includes(`${sep}..`)) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `路径超出工作区：${relPath ?? ""}`,
				});
				return;
			}
			// Normalize to forward slashes: the wire protocol and the frontend
			// always use "/", but relative() returns "\\" on Windows.
			const rel = rawRel.split(sep).join("/");
			const { entries, truncated, error } = await readDirForUI(target, rel);
			if (error) {
				// Windows-only: unreadable system dirs degrade to an empty list
				// with a warning instead of a hard error — the panel stays usable.
				this.emit({
					type: "notice",
					level: "warning",
					text: `目录不可读：${error}`,
				});
			}
			this.emit({
				type: "files",
				path: rel === "" ? "" : rel,
				parent:
					rel === ""
						? null
						: rel.includes("/")
							? rel.slice(0, rel.lastIndexOf("/"))
							: "",
				entries,
				truncated,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `读取目录失败：${(err as Error).message}`,
			});
		}
	}

	/** Read a workspace file for the preview panel (size-capped, binary-safe). */
	async readFile(relPath: string): Promise<void> {
		try {
			const fs = await import("node:fs/promises");
			const root = resolve(this.cwd);
			const wp = workspacePath(root, relPath);
			if (!wp) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `路径超出工作区：${relPath}`,
				});
				return;
			}
			const { abs, rel } = wp;
			const stat = await fs.stat(abs);
			if (!stat.isFile()) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `不是文件：${relPath}`,
				});
				return;
			}
			const name = relPath.split(/[\\/]/).pop() ?? relPath;
			const kind = previewKind(name);
			// Media previews stream over the /api/file HTTP endpoint, so only
			// metadata is sent here — the raw bytes never touch the socket.
			if (kind === "image" || kind === "video") {
				this.emit({
					type: "file_content",
					path: rel,
					name,
					text: "",
					truncated: false,
					binary: true,
					kind,
					lines: 0,
					size: stat.size,
				});
				return;
			}
			// Everything else: read a capped prefix and sniff the content.
			// Anything that looks like text previews as text regardless of its
			// extension (jsonl, .log.1, weird suffixes, …); binary content gets
			// a hex dump of the first few KB instead of being refused.
			const handle = await fs.open(abs, "r");
			try {
				const buf = Buffer.alloc(Math.min(stat.size, MAX_PREVIEW_BYTES));
				const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
				const data = buf.subarray(0, bytesRead);
				if (looksLikeText(data)) {
					this.emit({
						type: "file_content",
						path: rel,
						name,
						text: data.toString("utf8"),
						truncated: bytesRead < stat.size,
						binary: false,
						kind: "text",
						lines: countLines(data),
						size: stat.size,
					});
				} else {
					this.emit({
						type: "file_content",
						path: rel,
						name,
						text: hexDump(data),
						truncated: bytesRead < stat.size,
						binary: true,
						kind: kind === "text" ? "text" : "none",
						lines: 0,
						size: stat.size,
					});
				}
			} finally {
				await handle.close();
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `读取文件失败：${(err as Error).message}`,
			});
		}
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
		const empty = () =>
			this.emit({ type: "path_completions", completions: [] });
		try {
			const fs = await import("node:fs/promises");
			const { resolve, sep, isAbsolute } = await import("node:path");
			const { homedir } = await import("node:os");
			const home = homedir();

			// Expand ~ and relative inputs to an absolute path. Windows users type
			// backslashes (P:\agent) and ~\ — handle both separator styles.
			let expanded = input.trim();
			if (expanded === "") {
				empty();
				return;
			}
			if (expanded === "~" || expanded === "~\\") {
				expanded = home;
			} else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
				expanded = home + sep + expanded.slice(2);
			} else if (!isAbsolute(expanded)) {
				expanded = resolve(this.cwd, expanded);
			}

			// Split into parent dir + prefix on the LAST separator of either style
			// (Windows accepts both / and \, so P:\agent/de must work too).
			const lastSlash = Math.max(
				expanded.lastIndexOf("/"),
				expanded.lastIndexOf("\\"),
			);
			const dirPart = lastSlash >= 0 ? expanded.slice(0, lastSlash + 1) : "";
			const prefix = lastSlash >= 0 ? expanded.slice(lastSlash + 1) : expanded;

			const dirents = await fs
				.readdir(dirPart, { withFileTypes: true })
				.catch(() => null);
			if (!dirents) {
				empty();
				return;
			}
			const completions = dirents
				.filter(
					(d) => d.name.startsWith(prefix) && !ignoredEntries().has(d.name),
				)
				.map((d) => ({
					name: d.name,
					// Windows users type backslashes — normalize the completion to the
					// wire format ("/") so the picked path round-trips cleanly.
					path: IS_WIN32
						? join(dirPart, d.name).split(sep).join("/")
						: dirPart + d.name,
					type: (d.isDirectory() ? "dir" : "file") as "dir" | "file",
				}))
				.sort((a, b) => {
					const aHidden = a.name.startsWith(".");
					const bHidden = b.name.startsWith(".");
					if (aHidden !== bHidden) return aHidden ? 1 : -1;
					if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
					return a.name.localeCompare(b.name);
				})
				.slice(0, 30);
			this.emit({ type: "path_completions", completions });
		} catch {
			empty();
		}
	}

	/**
	 * Switch the agent's working directory by switching the ACTIVE conversation
	 * to the target project's own most recently active conversation (creating a
	 * fresh one that resumes that project's most recent session on first
	 * visit). Conversations of other projects keep running untouched in their
	 * own per-project lists — nothing is rebuilt, so titles/cwds never leak
	 * between projects.
	 */
	async setCwd(newCwd: string): Promise<void> {
		try {
			const { resolve } = await import("node:path");
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
				const newRuntime = await createAgentSessionRuntime(
					this.makeRuntimeFactory(),
					{
						cwd: abs,
						agentDir: this.agentDir,
						sessionManager: SessionManager.continueRecent(abs),
					},
				);
				const conv = this.makeConversation(newRuntime);
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

			this.conv.promptedSinceActive = false;
			this.conv.lastActiveAt = Date.now();
			this.cwd = abs;
			// Remember the new workspace (restore target + recent-project entry).
			this.stateStore.remember(this.clientId, abs);
			void this.pushProjects();
			this.webUi.refresh();
			this.emitConversations();
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
		this.terminals.killAll();
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
		this.webUi.dispose();
		for (const conv of this.convs.values()) {
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
	private pending = new Map<string, Promise<ClientSession>>();
	private stateStore: ClientStateStore;
	/**
	 * Set by index.ts: called by a client session after a successful
	 * self-update; returns whether the process will restart itself.
	 */
	onUpdateReady: (() => boolean) | undefined = undefined;

	constructor(
		private cwd: string,
		stateFile: string,
	) {
		this.stateStore = new ClientStateStore(stateFile);
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
		// Forward the update hook (set once by index.ts) to every session.
		cs.onUpdateReady = this.onUpdateReady;
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
