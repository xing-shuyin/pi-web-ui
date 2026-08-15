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
import { dirname, join, relative, resolve, sep } from "node:path";
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
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionUIContext,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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

/** Decode bytes: strict UTF-8 first, falling back to GBK (Windows legacy
 *  Chinese files), then latin1 as a last resort — so previews and inline
 *  attachments never show mojibake for GBK/GB2312 encoded files. */
function decodeText(buf: Buffer): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buf);
	} catch {
		try {
			return new TextDecoder("gbk").decode(buf);
		} catch {
			return buf.toString("latin1");
		}
	}
}

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
 * Snapshot currently LISTENING TCP ports → owning pid. Windows: netstat;
 * POSIX: lsof. Used to detect servers the agent started in the background
 * (the bash tool itself exits, leaving e.g. `npm run dev &` listening).
 */
async function snapshotListeningPorts(): Promise<Map<number, number>> {
	const m = new Map<number, number>();
	try {
		const { execFile } = await import("node:child_process");
		if (process.platform === "win32") {
			const out = await new Promise<string>((resolve, reject) =>
				execFile(
					"netstat",
					["-ano", "-p", "tcp"],
					{ windowsHide: true, timeout: 8000 },
					(err, stdout) => (err ? reject(err) : resolve(stdout)),
				),
			);
			for (const line of out.split(/\r?\n/)) {
				const p = line.trim().split(/\s+/);
				// TCP 0.0.0.0:5173 0.0.0.0:0 LISTENING 12345
				if (p.length >= 5 && p[0] === "TCP" && p[3] === "LISTENING") {
					const port = Number(p[1].split(":").pop());
					const pid = Number(p[4]);
					if (Number.isFinite(port) && Number.isFinite(pid))
						m.set(port, pid);
				}
			}
		} else {
			const out = await new Promise<string>((resolve, reject) =>
				execFile(
					"lsof",
					["-iTCP", "-sTCP:LISTEN", "-P", "-n"],
					{ timeout: 8000 },
					(err, stdout) => (err ? reject(err) : resolve(stdout)),
				),
			);
			for (const line of out.split(/\r?\n/).slice(1)) {
				const p = line.trim().split(/\s+/);
				if (p.length >= 9) {
					// NAME column tail: "*:5173 (LISTEN)" or "[::1]:5173 (LISTEN)"
					const mm = (p[p.length - 1] ?? "").match(/(\d+)\)?\s*$/);
					const port = mm ? Number(mm[1]) : NaN;
					const pid = Number(p[1]);
					if (Number.isFinite(port) && Number.isFinite(pid))
						m.set(port, pid);
				}
			}
		}
	} catch {
		// best effort — snapshot failure just means no tracking this round
	}
	return m;
}

/** Kill a pid and its whole process tree (cross-platform). */
function killPidTree(pid: number): void {
	try {
		if (process.platform === "win32") {
			void import("node:child_process").then(({ spawn }) => {
				spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
					stdio: "ignore",
					detached: true,
					windowsHide: true,
				}).unref();
			});
		} else {
			process.kill(-pid, "SIGKILL");
		}
	} catch {
		// already dead
	}
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

	/** Close every pending dialog as cancelled (used when a goal wizard aborts —
	 *  its unanswered browser dialogs must vanish, not linger). */
	cancelPendingDialogs(): void {
		for (const [id, resolve] of this.pendingDialogs) {
			this.pendingDialogs.delete(id);
			resolve(null);
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
	/** Last-used goal / review preferences (model choice, max rounds, locked) so
	 *  they survive a reload — "全局记忆". maxRounds: 0 means unlimited. The model
	 *  choice is shared by both the goal-reviewer and the goal-wizard. */
	goalPrefs?: {
		reviewModel: string | null;
		maxRounds: number;
		locked: boolean;
	};
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

	/** Last-used goal/review prefs for a client, or undefined if never set. */
	getGoalPrefs(clientId: string): ClientState["goalPrefs"] {
		const s = this.load()[clientId];
		if (!s?.goalPrefs) return undefined;
		return {
			reviewModel: s.goalPrefs.reviewModel ?? null,
			maxRounds: s.goalPrefs.maxRounds ?? 0,
			locked: s.goalPrefs.locked ?? true,
		};
	}

	/** Persist the client's goal/review preferences (model choice, rounds, lock). */
	saveGoalPrefs(clientId: string, prefs: ClientState["goalPrefs"]): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		state.goalPrefs = {
			reviewModel: prefs?.reviewModel ?? null,
			maxRounds: prefs?.maxRounds ?? 0,
			locked: prefs?.locked ?? true,
		};
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

	// -----------------------------------------------------------------------
	// Goal / review state. When a goal is active, every finished agent run
	// (agent_end) is checked by an ISOLATED reviewer agent; a failing review
	// injects its feedback back into the main session to revise. All goal
	// mutation goes through setGoal/clearGoal so UI state stays consistent.
	// -----------------------------------------------------------------------
	private goal: GoalStatus = {
		goal: null,
		reviewModel: null,
		maxRounds: 0, // 0 = unlimited (keep revising until the goal passes)
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
	/** Guard: only one review may run at a time (agent_end fires per turn and
	 *  review is async). */
	private goalReviewing = false;
	/** Guard: the goal wizard and the review loop are mutually exclusive — a
	 *  wizard in flight stops review triggers (and vice versa). */
	private goalWizardRunning = false;
	/** Aborts the currently-running goal wizard (user clicked ✗ / timed out). Drives
	 *  the in-flight goal_ask dialog to resolve as cancelled and (via the run
	 *  signal) stops the wizard session's agent run. Recreated per wizard. */
	private wizardAbort: AbortController | null = null;
	/** The wizard's AgentSession while it runs — lets clearGoal truly terminate it
	 *  (abort the run), not just flip a flag. */
	private wizardSession: AgentSession | null = null;
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
	/** LISTENING-port snapshot taken when the current bash tool started — the
	 *  end-of-execution diff reveals servers the agent left running in the
	 *  background (e.g. `npm run dev &`). Keyed by port → pid. */
	private bashListenBefore: Map<number, number> | null = null;
	/** Background servers the agent started (port → pid). 「中断」kills them. */
	private bgServers = new Map<number, { pid: number; since: number }>();

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

	/** fs.watch on the currently-listed directory — file changes push an instant
	 *  refresh (`file_changed`) so the tree updates without waiting for the 10s
	 *  poll. Only the listed directory is watched (one level); navigating
	 *  re-watches the new target. fs.watch isn't available on every platform /
	 *  filesystem — failures silently fall back to the poll. */
	private fsWatcher: ReturnType<typeof watch> | null = null;
	private watchPath: string | null = null;
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
			cs.goal.reviewModel = gPrefs.reviewModel;
			cs.goal.maxRounds = gPrefs.maxRounds;
			cs.goal.locked = gPrefs.locked;
		}
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
				...(process.platform === "win32"
					? {
							// Windows 专属 persona：bash 工具跑 Git Bash 且无默认超时、终端是
							// 交互式 TTY——注入约束避免 heredoc/交互/长驻命令挂死整个会话；
							// GBK 老中文文件让模型改用终端按正确编码读（iconv/chcp/Get-Content）。
							resourceLoaderOptions: {
								systemPromptOverride: (base?: string) =>
									base ? `${base}\n\n${WINDOWS_PERSONA}` : WINDOWS_PERSONA,
							},
					  }
					: {}),
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
					],
				})),
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
	}

	detachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.delete(send);
		// No sockets left for this client — kill its terminals so processes don't
		// survive a closed tab / dropped connection.
		if (this.sinks.size === 0) {
			this.terminals.killAll();
			// No sockets → nobody to refresh; drop the dir watcher too.
			this.unwatchDir();
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
					void snapshotListeningPorts().then((m) => {
						this.bashListenBefore = m;
					});
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
				if (event.toolName === "bash") void this.trackBackgroundServers();
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
				const g = this.goal;
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
					if (g.goal) {
						this.goal.goal = null;
						this.goal.reviewing = false;
						this.goal.verdict = "pending";
						this.goal.feedback = undefined;
						this.goal.status = "已手动停止，目标审查已中止";
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
					!g.reviewing &&
					!this.goalWizardRunning &&
					conv.id === this.activeId &&
					!this.disposed
				) {
					void this.runGoalReview(conv);
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
			// Native slash commands (see NATIVE_COMMANDS) are executed here and
			// never reach the SDK. Extension / skill / template commands fall
			// through — AgentSession.prompt() handles those itself.
			const slash = this.parseSlash(text);
			if (slash && (await this.execNativeCommand(slash.name, slash.args))) {
				this.flushSnapshot();
				return;
			}
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
									text: `\n<file path="${wirePath}">\n\`\`\`\n${decodeText(buf)}\n\`\`\`\n</file>`,
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
								text: `\n<file path="${rel}">\n\`\`\`\n${decodeText(buf)}\n\`\`\`\n</file>`,
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
				const parts = decodeText(buf).split("\n");
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

	/**
	 * Hard-abort the running agent (Stop button / global 中断). Tries
	 * session.abort() first; if the run is not idle within
	 * HARD_ABORT_TIMEOUT_MS (model stream ignoring the abort signal), the
	 * conversation's runtime is force-disposed and recreated from the last
	 * persisted session so the chat ALWAYS comes back usable — never stuck
	 * overnight. The notice fires only on the forced-reset path.
	 */
	async abort(): Promise<void> {
		await this.interruptRun(this.conv, "已停止");
		// 中断同时清理 AI 在后台启动的服务（npm run dev & 等）——避免用户
		// 测试时发现端口被占用而不知道是什么进程。
		const killed = await this.killBackgroundServers();
		if (killed.length > 0) {
			this.emit({
				type: "notice",
				level: "info",
				text: `已停止 AI 后台服务：端口 ${killed.join("、")}（进程已结束）`,
			});
		}
		this.flushSnapshot();
	}

	/** After a bash tool run, wait briefly for background servers to bind,
	 *  then diff the listening-port snapshot against the pre-run one and
	 *  remember anything new — those are servers the agent left running. */
	private async trackBackgroundServers(): Promise<void> {
		const before = this.bashListenBefore;
		this.bashListenBefore = null;
		if (!before) return;
		await new Promise((r) => setTimeout(r, 1500));
		const after = await snapshotListeningPorts();
		for (const [port, pid] of after) {
			if (!before.has(port) && !this.bgServers.has(port)) {
				this.bgServers.set(port, { pid, since: Date.now() });
				this.emit({
					type: "notice",
					level: "info",
					text: `检测到 AI 启动的后台服务：端口 ${port}（pid ${pid}）——点顶栏「中断」可停止`,
				});
			}
		}
	}

	/** Kill every background server the agent started; returns the freed ports. */
	private async killBackgroundServers(): Promise<string[]> {
		if (this.bgServers.size === 0) return [];
		const killed: string[] = [];
		for (const [port, { pid }] of [...this.bgServers]) {
			killPidTree(pid);
			killed.push(String(port));
		}
		this.bgServers.clear();
		return killed;
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
				this.makeRuntimeFactory(),
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
		this.clearAllToolWatchdogs(conv);
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
			// Watch the listed directory (only after a successful read — a missing
			// dir throws above and must not create a watcher on a phantom path).
			this.watchDir(target, rel);
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


	/** Watch a directory for changes so the file panel refreshes instantly
	 *  instead of waiting for the 10s poll. Watches the directory exactly as
	 *  listed (one level); navigating re-watches the new target. fs.watch is
	 *  unavailable on some platforms/filesystems — failures silently fall back
	 *  to the poll. */
	private watchDir(absPath: string, rel: string): void {
		if (this.disposed || this.watchPath === rel) return;
		this.unwatchDir();
		this.watchPath = rel;
		try {
			// persistent: false — the watcher must not keep the process alive.
			this.fsWatcher = watch(absPath, { persistent: false }, () => {
				// Burst events (npm install, git ops, editor save→rename) are
				// debounced into a single refresh.
				if (this.watchTimer) return;
				this.watchTimer = setTimeout(() => {
					this.watchTimer = null;
					this.emit({ type: "file_changed", path: this.watchPath ?? "" });
				}, 400);
			});
			this.fsWatcher.on("error", () => {
				// Directory deleted / unsupported fs — stop watching; the poll (or
				// the next navigation) restores things.
				this.unwatchDir();
			});
		} catch {
			// fs.watch unsupported (some network mounts, containers) — poll covers it.
			this.fsWatcher = null;
			this.watchPath = null;
		}
	}

	private unwatchDir(): void {
		if (this.watchTimer) {
			clearTimeout(this.watchTimer);
			this.watchTimer = null;
		}
		if (this.fsWatcher) {
			try {
				this.fsWatcher.close();
			} catch {
				// already closed
			}
			this.fsWatcher = null;
		}
		this.watchPath = null;
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
						text: decodeText(data),
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

	/** Push the current goal status to the client (the goal bar UI). */
	private emitGoalStatus(): void {
		this.emit({ type: "goal_status", status: { ...this.goal } });
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
	 * Mutually exclusive with the review loop.
	 */
	async startGoalWizard(
		text: string,
		opts?: {
			wizardModel?: string;
			maxRounds?: number;
			locked?: boolean;
		},
	): Promise<void> {
		const draft = (text ?? "").trim();
		if (!draft) return;
		if (this.goalWizardRunning) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "已有目标调研进行中，请等它完成…",
			});
			return;
		}
		if (this.goalReviewing) {
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
		this.goalWizardRunning = true;
		this.wizardCancelled = false;
		this.wizardAbort = new AbortController();
		this.wizardSession = null;
		this.goal.wizard.active = true;
		this.goal.wizard.draft = draft;
		this.goal.wizard.model = opts?.wizardModel ?? null;
		// Remember the model choice (and persist rounds/lock) — global memory.
		if (opts?.wizardModel !== undefined && opts.wizardModel !== null)
			this.goal.reviewModel = opts.wizardModel || null;
		this.stateStore.saveGoalPrefs(this.clientId, {
			reviewModel: this.goal.reviewModel,
			maxRounds: this.goal.maxRounds,
			locked: this.goal.locked,
		});
		this.goal.wizard.step = 0;
		this.goal.wizard.maxSteps = maxSteps;
		this.goal.wizard.status = "调研中…";
		this.goal.status = "目标调研中…";
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
		let mainSession = this.session;
		try {
			const conv = this.conv;
			mainSession = conv.session;
		} catch {
			// no active conversation yet
		}

		let refinedGoal = "";
		try {
			const wmSpec = opts?.wizardModel
				? this.resolveReviewModel(opts.wizardModel)
				: null; // reuse the honest "provider/id" parser
			const services = await createAgentSessionServices({
				cwd: this.cwd,
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
					this.goal.wizard.step = qStep;
					this.goal.wizard.status = `调研中：请回答第 ${qStep} 题`;
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
			this.goalWizardRunning = false;
			this.goal.wizard.active = false;
			this.goal.wizard.step = 0;
			this.goal.wizard.status = "";
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
		// Auto-set the refined goal. The wizard workflow implies "set a goal and
		// work until it passes", so default LOCKED=true unless the user explicitly
		// turned the lock off (a lock lets the review loop keep revising to pass;
		// without it the review is single-shot).
		const wantLocked = opts?.locked === undefined ? true : opts.locked;
		await this.setGoal(refinedGoal, {
			reviewModel: this.goal.reviewModel ?? undefined,
			maxRounds: opts?.maxRounds,
			locked: wantLocked,
			// The wizard kicks off generation itself below — avoid a double kick.
			autoStart: false,
		});
		const g2 = this.goal;
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
		this.goal.goal = null;
		this.goal.reviewing = false;
		this.goal.verdict = "pending";
		this.goal.feedback = undefined;
		this.goal.wizard.active = false;
		this.goal.wizard.status = "";
		this.goal.status = "";
		this.emitGoalStatus();
		// Abort a running wizard for real (✗ in the goal bar while scoping).
		if (this.goalWizardRunning || this.wizardAbort || this.wizardSession) {
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
		if (!spec) return null;
		const slash = spec.indexOf("/");
		if (slash <= 0 || slash === spec.length - 1) return null;
		return { provider: spec.slice(0, slash), id: spec.slice(slash + 1), spec };
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

	/** Run a git diff (unstaged + staged) in the workspace, or "" when not a repo. */
	private async gitDiff(): Promise<string> {
		try {
			const { code, out } = await this.runAsync(
				"git",
				["diff", "HEAD"],
				10_000,
				this.cwd,
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
	 * Guarded so it never runs two reviews concurrently.
	 */
	private async runGoalReview(conv: Conversation): Promise<void> {
		// The review is bound to the conversation that just ran — but the user may
		// have switched to another conversation meanwhile. Reviews only make sense
		// for the conversation that generated output, so track it locally.
		const mainConv = this.convs.get(conv.id) ?? conv;
		const mainSession = mainConv.session;
		const g = this.goal;
		if (
			!g.goal ||
			this.goalReviewing ||
			this.goalWizardRunning ||
			this.disposed
		)
			return;
		// Narrowed copy — TS control-flow can't narrow `g.goal` (a mutable shared
		// object field) through the entire async body, so capture it here.
		const goalText: string = g.goal;

		// Cap rounds: single-shot (locked=false) always exactly one review.
		// For locked goals, maxRounds 0 = unlimited (keep revising until pass).
		const budget = g.locked ? (g.maxRounds > 0 ? g.maxRounds : Infinity) : 1;
		if (g.locked && g.maxRounds > 0 && g.round >= budget) {
			this.goal.status = `已达最大轮数（${budget}），停止审查`;
			this.goal.reviewing = false;
			this.emitGoalStatus();
			return;
		}

		this.goalReviewing = true;
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
		const diff = await this.gitDiff();

		let reviewerVerdict: "pass" | "fail" = "fail";
		let reviewerFeedback = "（审查无法完成）";

		try {
			const rmSpec = this.resolveReviewModel(g.reviewModel);
			const services = await createAgentSessionServices({
				cwd: this.cwd,
				agentDir: this.agentDir,
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
				sessionManager: SessionManager.inMemory(this.cwd),
				...(model ? { model } : {}),
			});
			const reviewCap = g.locked && g.maxRounds > 0 ? g.maxRounds : 0; // 0 = no cap
			const reviewer = srv.session;
			await reviewer.prompt(
				this.reviewerPrompt(goalText, g.round, reviewCap, finalText, diff),
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

		this.goalReviewing = false;
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
		this.unwatchDir();
		this.webUi.dispose();
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
