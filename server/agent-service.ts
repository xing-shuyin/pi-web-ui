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
// MUST be the first import: rewrites the SDK's installed remote-catalog
// provider so built-in model lists follow the official pi.dev catalog
// wholesale (no union merge / no stale built-in leftovers).
import "./patch-remote-catalog.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, rmSync, statSync, mkdirSync, watch } from "node:fs";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
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
import { hasActiveSubagentRun, hasPendingWaitSubscription, shouldRetainActive } from "./wait-subscription-scan.js";
import { removeFirstOccurrence } from "./queue-utils.js";
import type {
	PluginAgentTool,
	PluginCommandDef,
	PluginConversationSnapshot,
	PluginRunEvent,
	PluginToolEvent,
} from "./plugins.js";
import { syncPluginToolsIntoSession } from "./plugins.js";
import { SettingsService } from "./settings-service.js";
import { GoalService } from "./goal-service.js";
import { MarkerService } from "./marker-service.js";
import { SlashCommandsService, parseSlash } from "./slash-commands.js";
import { ModelAdminService } from "./model-admin.js";
import { FilesService, MACHINE_ROOT, workspacePath } from "./files-service.js";
import {
	isExtensionDisabled,
	isExtensionEnabled,
	normalizeRetryMaxAttempts,
	normalizeSkillList,
	type PromptMode,
	ClientStateStore,
} from "./client-state.js";
import { bilingual, pick, resolveServerLang, type ServerLang } from "./i18n.js";
import { SubagentTemplatesStore, pickTemplatePrompt, type SubagentTemplate } from "./subagent-templates.js";

import {
	applyHeadTail,
	makePersistentTerminalTools,
	makeTerminalBashTool,
	stripAnsi,
	TERMINAL_TOOLS_GUIDANCE,
} from "./terminals.js";
import {
	applyAgentToolsGating,
	ASK_USER_QUESTION_TOOL_NAME,
	effectiveDisabledAgentTools,
	isTerminalGuidanceOn,
	MARKERS_LIST_TOOL_NAME,
} from "./tool-manager.js";
import { WebUIContext } from "./webui-context.js";
import { decodeText } from "./text-sniff.js";
import { makeEditSoftTool } from "./edit-soft-tool.js";
import {
	collectSubagentDescendantIds,
	makeSubagentTools,
	subagentTitle,
	withSubagentOwner,
	type SubagentSnapshot,
	type SubagentState,
	type SubagentToolHost,
} from "./subagents.js";
import { makeDelegateTaskTool } from "./delegate-task.js";
import { buildAttachmentMessages } from "./attachments.js";
import {
	BUILTIN_SOUL,
	DEFAULT_PROMPT_TEMPLATE,
	buildToolsSchemaText,
	renderPromptTemplate,
	resolveSectionTexts,
	type PromptComposerInputs,
} from "./prompt-composer.js";
import type {
	BgServer,
	CommandDef,
	ConversationSummary,
	GoalStatus,
	MessageAnchor,
	ProjectSummary,
	QuestionAnswer,
	ServerMessage,
	SessionSummary,
	UiMessage,
	UiQuestion,
	UiServiceInfo,
	UiState,
	UiSubagentTemplate,
} from "./protocol.js";
import { launchOrigin, toServiceInfo } from "./launch-origin.js";
import {
	serializeMessage,
	serializeStreamingMessage,
	stripTransientRetryErrors,
	type AgentMessage,
} from "./serialize.js";
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

/** 自家内联扩展名（组合模板渲染，见 prompt-composer.ts）。SDK 以其
 *  "<inline:<name>>" 作为 path；扩展白名单/禁用过滤必须放行它。 */
const INLINE_PERSONA_EXT = "<inline:pi-webui-persona>";

/** Pi 包文档路径（composer 的 {{pi_docs}} 自动内容用）。随安装位置解析一次。 */
const PI_DOC_PATHS = (() => {
	try {
		const requireLocal = createRequire(import.meta.url);
		const root = dirname(requireLocal.resolve("@earendil-works/pi-coding-agent/package.json"));
		return { readme: join(root, "README.md"), docs: join(root, "docs"), examples: join(root, "examples") };
	} catch {
		return { readme: "", docs: "", examples: "" };
	}
})();

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
 * Killable bash tool: wraps the SDK bash tool (native process spawn, NO terminal).
 * Used when the「默认 bash 覆盖」setting is OFF. Registers its own AbortController
 * into a client-level set (kills) so abortBash() kills only these commands while the
 * agent run and the conversation continue. Exposes persist (ignored — native has no
 * terminal) plus head/tail (post-processed on the returned output) so the parameter
 * schema stays consistent with the terminal-backed tool.
 */
export function makeKillableBashTool(
	cwd: string,
	kills: Set<AbortController>,
	/** per-call 返回文本的服务端语言（默认英文）；工具 definition 走 bilingual 内联双语。 */
	lang: () => ServerLang = () => "en",
): ToolDefinition {
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
				result.content![0].text = applyHeadTail(result.content![0].text!, p.head, p.tail, lang());
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
 * 任务列表只读查询工具（todo_list）— 读操作仍走真工具。
 */
function makeMarkersListTool(
	getActiveId: () => string,
	markerSvc: {
		describe: (id: string, tool: string, inc?: boolean) => string;
		getRawState: (id: string, ns: string) => unknown;
	},
): ToolDefinition {
	return {
		name: MARKERS_LIST_TOOL_NAME,
		label: "List marker state",
		description:
			"Read-only query of inline marker state. All WRITE operations must use inline markers ([[todo:new:...]] etc.) in the reply body — never use this tool for writes.\n只读查询内联标记状态。状态【写】操作请一律用内联标记（[[todo:new:...]] 等）写在回答正文里，不要调用本工具做写操作。",
		parameters: Type.Object({
			action: Type.Unsafe<string>({ enum: ["list"] }),
			tool: Type.Optional(Type.Literal("todo")),
			includeDeleted: Type.Optional(
				Type.Boolean({
					description:
						"Whether to include deleted tasks (tombstones, todo only).\n是否包含已删除任务（tombstone，仅 todo）。",
				}),
			),
		}),
		execute: async (_id: string, params: unknown) => {
			const p = params as { action: string; tool?: string; includeDeleted?: boolean };
			const convId = getActiveId();
			const text = markerSvc.describe(convId, "todo", !!p.includeDeleted);
			const state = markerSvc.getRawState(convId, "todo") as { tasks: unknown[]; nextId: number } | undefined;
			const visible = (state?.tasks ?? []).filter(
				(t: unknown) => p.includeDeleted || (t as { status: string }).status !== "deleted",
			);
			return {
				content: [{ type: "text", text }],
				details: { action: "list", todos: visible, nextId: state?.nextId },
			} as never;
		},
	} as unknown as ToolDefinition;
}

/**
 * 标准 pi 引擎的 ask_user_question 工具：模型调用时把问题桥到浏览器（复用 DSH
 * 引擎的 question_pending/question_answer 协议，前端 DshQuestionDialog 富渲染），
 * 阻塞 agent 循环直到用户在浏览器回答或取消。
 *
 * 标准 SDK 没有内建 ask_user_question，故由 pi-web-ui 以 customTool 注册（与
 * bash/edit 同机制）。DSH 引擎走 goal-rpc 的 userQuestions provider，两者互不
 * 冲突（各引擎各走各的）。
 *
 * askUser 签名带 {aborted} 快照而非完整 AbortSignal：customTool 的 execute 信号
 * 服务于整个 agent 生命周期，这里按「已中止即拒绝」的最小语义处理，避免与其它
 * 工具的取消逻辑纠缠。
 */
export function makeAskUserQuestionTool(
	clientSession: {
		askUser: (q: UiQuestion[], sig: { aborted?: boolean }, conversationId?: string) => Promise<QuestionAnswer[] | null>;
	},
	/** 本 runtime 所属会话：提问跟着对话走，快照只把当前对话的问卷推给客户端。 */
	ownerId?: string,
): ToolDefinition {
	const QuestionOptionSchema = Type.Object({
		label: Type.String({ description: "Display label for the option" }),
		description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
		preview: Type.Optional(
			Type.String({
				description:
					"Optional preview rendered below when this option is selected (markdown or HTML — use for mockups/code/config).",
			}),
		),
	});
	const QuestionSchema = Type.Object({
		id: Type.String({ description: "Unique identifier for this question" }),
		question: Type.String({ description: "The full question text to display (markdown/HTML ok)" }),
		detail: Type.Optional(Type.String({ description: "Optional detail/context shown under the question" })),
		header: Type.Optional(Type.String({ description: "Optional short header for this question" })),
		options: Type.Optional(Type.Array(QuestionOptionSchema, { description: "Available options to choose from" })),
		multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options (default: false)" })),
	});
	return {
		name: "ask_user_question",
		label: "Ask the user",
		description:
			"Ask the user focused questions to pin down ambiguous requirements. Use for clarifying the task, confirming decisions, or getting preferences. Each question renders a browser dialog with markdown/HTML rich text; options may carry a `preview`. Submit or cancel to resume.",
		promptSnippet: bilingual(
			"ask the user focused questions to clarify ambiguous requirements (browser dialog with options/preview)",
			"向用户提问以澄清含糊的需求（浏览器对话框，支持选项/预览）",
		),
		promptGuidelines: [
			bilingual(
				"When requirements are ambiguous, use ask_user_question to ask the user instead of guessing; prefer multiple-choice options, each option may carry a preview",
				"需求含糊时用 ask_user_question 向用户提问而不是猜测；优先给多选选项，选项可带 preview 预览",
			),
			bilingual(
				"A cancelled question comes back as a tool error — respect it and continue without re-asking immediately",
				"用户取消提问会以工具错误返回——尊重取消决定，不要马上重复追问",
			),
		],
		parameters: Type.Object({
			questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
		}),
		execute: async (_id: string, params: unknown, signal: AbortSignal | undefined): Promise<unknown> => {
			const qs = (params as { questions: UiQuestion[] }).questions;
			if (!Array.isArray(qs) || qs.length === 0) {
				throw new Error("ask_user_question requires at least one question");
			}
			const answers = await clientSession.askUser(
				qs,
				{
					aborted: signal?.aborted,
				},
				ownerId,
			);
			if (answers === null) {
				throw new Error("User cancelled the question.\n用户取消了提问。");
			}
			// 工具结果：把每道题的回答拼成简洁文本给模型，同时留 details 供 UI 展示。
			const lines = answers.map((a) => {
				const q = qs.find((q) => q.id === a.id);
				const label = a.selected.join(", ");
				const custom = a.custom?.trim() ? ` (wrote: ${a.custom.trim()})` : "";
				return `${q?.header ?? q?.id ?? a.id}: ${label || "(no selection)"}${custom}`;
			});
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { answers },
			} as never;
		},
	} as unknown as ToolDefinition;
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

function extractAssistantTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(c): c is { type: string; text: string } =>
				(c as { type?: string }).type === "text" && typeof (c as { text?: string }).text === "string",
		)
		.map((c) => c.text)
		.join("\n");
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
	/** 这是子代理对话（左栏带「子代理」徽标；inMemory session，不进历史/resume）。 */
	isSubagent: boolean;
	/** 派发它的父对话 id（Running 面板嵌套用；顶层子代理为空）。 */
	parentId?: string;
	/** 子代理类型/角色展示名（explore/implement/review…）。 */
	subagentType?: string;
	/** 子代理最近一次运行报错的文本（快照 error 字段的只读缓存位），消息内容不变 /
	 *  会话重建时保留，避免重复向主对话发 notice（subagentErrorNotified 是去重键）。 */
	subagentError?: string;
	/** 已就当前 subagentError 向主对话发过 notice 的错误文本（去重；文本变化时重置）。 */
	subagentErrorNotified?: string;
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
	/** LLM 瞬时报错自动重试进行中（agent_end willRetry 占位 → auto_retry_start
	 *  填实 → auto_retry_end 清除）。置位期间快照隐藏末尾的 stopReason=error
	 *  assistant 消息（重试成功则用户永远看不到，耗尽才永久标红），前端改显
	 *  温和的「正在重试」条，而非一闪而过的红色报错。 */
	retryState?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string } | null;
	/** 上下文压缩进行中（compaction_start 已到、compaction_end 未到）。置位期间
	 *  快照携带 compaction 字段，前端在消息区常驻「压缩中…」进度条（toast 会
	 *  自动消失，而摘要 LLM 调用可能持续数十秒）；结束/失败/取消时清除。 */
	compactionState?: { reason: string; startedAt: number } | null;
	/** 最近一次压缩成功的 estimatedTokensAfter（SDK 自算的压缩后上下文大小）。
	 *  压缩后 SDK getContextUsage() 故意报 null（压缩前的 usage 不可信），
	 *  下轮模型响应前快照用此值回填并标 estimated；开始下一次压缩时清掉。 */
	lastCompactionTokens?: number | null;
	/** 下一轮 agent_start 消费的用户任务文本（prompt() 暂存，轨迹插件的 run_start 用；
	 *  steer/内部续跑无暂存时为空，由插件回退为「继续执行」）。 */
	pendingTask?: string;
	/** tool_call watchdog timers keyed by toolCallId — a tool that runs past
	 *  TOOL_WATCHDOG_TIMEOUT_MS gets the session aborted instead of hanging
	 *  the conversation forever (the SDK bash tool has no default timeout). */
	toolWatchdogs: Map<string, ReturnType<typeof setTimeout>>;
}

/** 轨迹事件 payload 封顶（可直接广播/持久化，不撑爆 storage.json）。 */
const RUN_TASK_CAP = 500;
const RUN_ARGS_CAP = 4000;
const RUN_RESULT_CAP = 4000;

function truncRun(s: string, cap: number): string {
	return s.length <= cap ? s : `${s.slice(0, cap)}\n… [truncated]`;
}

/** 从 SDK tool result 里抠可读文本预览（text 块拼接，图片/二进制占位，封顶）。 */
function previewToolResult(result: unknown): string {
	try {
		const content = (result as { content?: unknown })?.content;
		if (Array.isArray(content)) {
			const parts: string[] = [];
			for (const c of content) {
				if (c && typeof c === "object" && (c as { type?: unknown }).type === "text") {
					parts.push(String((c as { text?: unknown }).text ?? ""));
				} else {
					parts.push("[…]");
				}
			}
			return truncRun(parts.join("\n"), RUN_RESULT_CAP);
		}
		if (typeof result === "string") return truncRun(result, RUN_RESULT_CAP);
		return truncRun(JSON.stringify(result ?? null), RUN_RESULT_CAP);
	} catch {
		return "[unserializable result]";
	}
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

/** Cap on simultaneously open NON-subagent conversations of ONE project (each keeps a full
 *  runtime alive; conversations of other projects keep their own lists).
 *  子代理不计入：子代理是 inMemory 后台任务，不参与此上限，既不占位也不被此上限拦截。 */
const MAX_OPEN_CONVERSATIONS = 8;
const DEFAULT_CONV_TITLE = "新对话";

/** First user text in a session, truncated for the conversation list. */
function conversationTitle(session: AgentSession): string {
	try {
		const named = session.sessionManager.getSessionName();
		if (named && named.trim()) return named.trim();
	} catch {
		// best-effort — fall through to first-message title
	}
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

/**
 * pi 的会话存储根目录。设置了 `PI_CODING_AGENT_SESSION_DIR` 时，pi 将 transcript
 * 以**扁平布局**直接写在根目录顶层（`<root>/<timestamp>_<uuid>.jsonl`，所属 cwd 是
 * 文件内字段）；未设置时走 SDK 默认的 `<agentDir>/sessions/--<cwd>--/` 每-cwd
 * 子目录布局（此时必须**不传** sessionDir，让 SDK 落回默认路径）。
 *
 * 注意：未设置 env 时**不要**回退返回 `join(getAgentDir(), "sessions")`——那样会把
 * 根目录强塞给 SDK `list()/listAll()`，它们只会扫根目录**顶层** jsonl，默认子目录布局
 * 下顶层为空，历史对话/最近项目会全丢（回归风险，已在 0.84.4 实证）。
 */
export function piSessionsRoot(): string | undefined {
	return process.env.PI_CODING_AGENT_SESSION_DIR || undefined;
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
		// issue #91：文件服务错误文案按客户端 UI 语言出中英（英文默认）。
		getLang: () => this.getLang(),
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
	/** index.ts 注入：把运行轨迹事件转发给插件（PluginManager.emitRunEvent，
	 *  轨迹视图插件靠它聚合时间线）。未设置时不做任何事。 */
	onRunEvent: ((ev: PluginRunEvent) => void) | undefined = undefined;
	/** index.ts 注入：当前打开对话变了（切历史会话/切 running 对话/新对话）时
	 *  通知插件（PluginManager.emitConversationChanged）——轨迹视图靠它重拉。 */
	onConversationChanged: (() => void) | undefined = undefined;
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
		const mgr = new TerminalManager(
			(msg) => this.emitTerminal(conversationId, msg),
			cwd,
			// issue #91：终端输入错误按客户端 UI 语言出中英（英文默认）。
			() => this.getLang(),
		);
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

	/** 创建子代理 conversation（inMemory runtime + 独立 terminals），listed 入左栏，
	 *  并在其上触发一次完整回合。返回 convId（= 工具 runId）。
	 *
	 *  `model`（可选）："provider/id"，显式指定子代理模型。不传时由调用方决定是否
	 *  回退到模板模型 / 设置面板默认模型；null = 跟随主对话当前模型（默认行为，
	 *  runtime 重建时会继承共享 ModelRuntime 的当前默认）。 */
	private async spawnSubagentConversation(
		prompt: string,
		type: string,
		cwd: string,
		apply?: SubagentTemplate,
		model?: string | null,
		parentId?: string,
	): Promise<string> {
		const conversationId = `sa-${randomUUID().slice(0, 8)}`;
		const terminals = this.makeTerminalManager(conversationId, cwd);
		const runtime = await createAgentSessionRuntime(this.makeRuntimeFactory(terminals, apply, conversationId), {
			cwd,
			agentDir: this.agentDir,
			sessionManager: SessionManager.inMemory(cwd),
		});
		const conv = this.makeConversation(runtime, conversationId, terminals);
		conv.isSubagent = true;
		// 父对话 = 真正派发它的会话（按会话归属的 host 包装填入）。直接用 active
		// 会错：后台对话运行时用户可能正看着别的项目对话，孩子会被记到无关
		// 对话名下、沉到别的项目组底部（issue #95）。缺省才回退到 active。
		conv.parentId = parentId ?? this.activeId ?? undefined;
		conv.subagentType = type;
		conv.listed = true;
		conv.title = subagentTitle(prompt);
		this.convs.set(conv.id, conv);
		// 子代理不走 bindSession——这里同样注入面板的重试次数覆盖。
		this.applyRetryOverrides();
		// 扩展绑定（rpc 模式）；用 headless 的 Web UI context：
		// 扩展绑定时不会因缺方法崩，UI 输出也不下发（不会与主对话的 widget/status 冲突）。
		try {
			await conv.session.bindExtensions({
				mode: "rpc",
				// 子代理的扩展照常拿到完整 ExtensionUIContext（扩展调用新增方法不会因
				// 局部 mock 缺失而崩），但它是 headless 的：UI 输出全部丢弃、弹窗按取消返回，
				// 因此既不与主对话的 widget/status 串台，也不会让扩展卡在永远无人应答的弹窗上。
				uiContext: WebUIContext.headless(),
				onError: (err) => this.emit({ type: "notice", level: "error", text: err.error, textEn: err.error }),
			});
		} catch {
			// 绑定失败不阻断运行。
		}
		// 指定模型（显式 model 参数 → 模板 model → 设置面板默认）时，在首回合前
		// 给子代理会话换模型；全都不给 = 跟随主对话：把发起会话当前的模型也
		// 显式搬过来（新 runtime 的默认模型未必等于主对话刚选的模型）。
		const resolvedModel =
			model ?? (apply?.model?.trim() || null) ?? (this.settingsSvc.current.subagentDefaultModel || null);
		const followModel = resolvedModel
			? resolvedModel
			: this.session.model
				? `${this.session.model.provider}/${this.session.model.id}`
				: null;
		if (followModel) {
			const slash = followModel.indexOf("/");
			const m =
				slash > 0 && slash < followModel.length - 1
					? this.sharedModelRuntime?.getModel(followModel.slice(0, slash), followModel.slice(slash + 1))
					: undefined;
			if (m) {
				try {
					// 先恢复该 provider 的项目密钥（setModel 的鉴权检查要用），再换模型。
					await this.restoreKeyForModel(followModel, cwd);
					await conv.session.setModel(m);
				} catch (err) {
					// 换模型失败不阻断运行——沿用默认模型继续。
					this.emit({
						type: "notice",
						level: "warning",
						text: `子代理模型切换失败（将按默认模型运行）：${followModel}（${(err as Error).message}）`,
						textEn: `Failed to set subagent model, running with default: ${followModel} (${(err as Error).message})`,
					});
				}
			} else {
				this.emit({
					type: "notice",
					level: "warning",
					text: `子代理模型不存在，将按默认模型运行：${followModel}`,
					textEn: `Subagent model not found, running with default: ${followModel}`,
				});
			}
		}
		// 触发回合（后台执行；失败转识为通知）。
		void conv.session.sendUserMessage(prompt).catch((err) => {
			this.emit({
				type: "notice",
				level: "error",
				text: `子代理 ${conversationId} 启动失败: ${err instanceof Error ? err.message : String(err)}`,
				textEn: `Subagent ${conversationId} failed to start: ${err instanceof Error ? err.message : String(err)}`,
			});
		});
		this.emitConversations();
		return conv.id;
	}

	private getSubagentSnapshot(convId: string): SubagentSnapshot | undefined {
		const conv = this.convs.get(convId);
		if (!conv?.isSubagent || !conv.session) return undefined;
		return this.toSubagentSnapshot(conv);
	}

	private listSubagentSnapshots(): SubagentSnapshot[] {
		return [...this.convs.values()]
			.filter((c) => c.isSubagent)
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((c) => this.toSubagentSnapshot(c));
	}

	private toSubagentSnapshot(conv: Conversation): SubagentSnapshot {
		const streaming = conv.session.isStreaming;
		const state: SubagentState = streaming ? "running" : "done";
		let messageCount = 0;
		try {
			messageCount = conv.session.getSessionStats().totalMessages;
		} catch {
			// session being replaced — report defaults
		}
		const { error, canceled } = this.subagentRunOutcome(conv);
		return {
			convId: conv.id,
			type: conv.subagentType ?? "general",
			title: conv.title,
			prompt: "",
			state,
			streaming,
			error,
			canceled,
			messageCount,
			model: conv.session.model?.id,
			output: conv.session.getLastAssistantText() ?? "",
		};
	}

	/** 子代理最近一次运行的结局：最后一条 assistant 消息的 errorMessage / stopReason。
	 *  报错 > 中止 > 正常，三者互斥；无 assistant 消息时返回空。 */
	private subagentRunOutcome(conv: Conversation): { error?: string; canceled?: boolean } {
		// 自动重试等待期结局未定：瞬时 error 不算失败，避免向主对话误报
		// 「子代理运行失败」（耗尽后 auto_retry_end 清旗，真正失败照常通知）。
		if (conv.retryState) return {};
		try {
			const msgs = conv.session.agent.state.messages;
			for (let i = msgs.length - 1; i >= 0; i--) {
				const m = msgs[i];
				if ((m as { role?: unknown }).role !== "assistant") continue;
				const err = (m as { errorMessage?: unknown }).errorMessage;
				if (typeof err === "string" && err.trim()) {
					return { error: err.trim() };
				}
				const stop = (m as { stopReason?: unknown }).stopReason;
				if (stop === "aborted" || stop === "cancelled") {
					return { canceled: true };
				}
				break;
			}
		} catch {
			// session being replaced — treat as no outcome yet
		}
		return {};
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

	/** SYSTEM.md 文件内容（最近一次 loader reload 观察到的 base；组合模板下仅作
	 *  {{soul}} 自动内容，SDK 默认分支不受影响）。非空 = 用户有系统提示词文件。 */
	private lastBaseSystemPrompt = "";

	/** SDK APPEND_SYSTEM.md 内容（appendSystemPromptOverride 收到的 base）——
	 *  composer 的 {{append}} 自动内容。仅主会话（无模板）记录。 */
	private lastSdkAppendFiles: string[] = [];

	/** 当前活动会话的工具/资源快照 → composer 输入。cwd 取活动对话的。 */
	private composeInputs(src: {
		cwd: string;
		selectedTools: string[];
		toolSnippets: Record<string, string>;
		toolGuidelines: string[];
		contextFiles: { path: string; content: string }[];
		skills: { name: string; description: string; filePath: string }[];
	}): PromptComposerInputs {
		return {
			cwd: src.cwd,
			systemPromptFile: this.lastBaseSystemPrompt || undefined,
			builtinSoul: BUILTIN_SOUL,
			selectedTools: src.selectedTools,
			toolSnippets: src.toolSnippets,
			toolGuidelines: src.toolGuidelines,
			piReadme: PI_DOC_PATHS.readme,
			piDocs: PI_DOC_PATHS.docs,
			piExamples: PI_DOC_PATHS.examples,
			appendFiles: this.lastSdkAppendFiles,
			windowsPersona: process.platform === "win32" ? WINDOWS_PERSONA : "",
			terminalGuidance: isTerminalGuidanceOn(effectiveDisabledAgentTools(this.settingsSvc.current))
				? TERMINAL_TOOLS_GUIDANCE
				: "",
			markersGuidance: this.markerSvc.buildGuidance(),
			// issue #91：组合模板各来源段按客户端 UI 语言渲染（英文默认）。
			lang: this.getLang(),
			contextFiles: src.contextFiles,
			skills: this.fillSkillContents(src.skills),
			skillsFullText: normalizeSkillList(this.settingsSvc.current.skillsFullText),
		};
	}

	/** skill 全文注入（{{skills}} 全文模式）：最好努力读名单里技能的文件正文。
	 * 单文件 8KB、总量 32KB 封顶，失败/超限/不在名单回落名录（无 content）。
	 * 名单为空时零开销：原样返回，不碰磁盘。 */
	private fillSkillContents(
		skills: { name: string; description: string; filePath: string }[],
	): { name: string; description: string; filePath: string; content?: string }[] {
		const wanted = new Set(normalizeSkillList(this.settingsSvc.current.skillsFullText));
		if (wanted.size === 0) return skills;
		let budget = 32 * 1024;
		return skills.map((s) => {
			if (!wanted.has(s.name) || !s.filePath || budget <= 0) return s;
			try {
				const st = statSync(s.filePath);
				if (!st.isFile() || st.size <= 0 || st.size > 8192) return s;
				const raw = decodeText(readFileSync(s.filePath).subarray(0, Math.min(st.size, budget))).trim();
				budget -= raw.length;
				return raw ? { ...s, content: raw } : s;
			} catch {
				return s;
			}
		});
	}

	/** 渲染当前组合模板。模板为空且无任何覆盖时返回 undefined（用 SDK 默认拼装，
	 *  零开销且与原始行为逐字节一致）。 */
	private renderMainCompose(src: {
		cwd: string;
		selectedTools: string[];
		toolSnippets: Record<string, string>;
		toolGuidelines: string[];
		contextFiles: { path: string; content: string }[];
		skills: { name: string; description: string; filePath: string }[];
	}): string | undefined {
		const tpl = (this.settingsSvc.current.promptTemplate ?? "").trim();
		const ovs = this.settingsSvc.current.promptOverrides ?? {};
		const hasOverride = Object.values(ovs).some((v) => typeof v === "string" && v.trim());
		if (!tpl && !hasOverride) return undefined;
		const texts = resolveSectionTexts(this.composeInputs(src));
		return renderPromptTemplate(tpl || DEFAULT_PROMPT_TEMPLATE, texts, ovs);
	}

	/** 从活动会话收集工具/资源快照 → 一次算出 ①各来源默认(自动)内容 ②实际生效的
	 *  完整提示词。会话未就绪（或出错）返回 undefined，调用方给空值。 */
	private sessionPromptSnapshot():
		| {
				texts: Record<string, string>;
				full: string;
				toolsSchema: string;
		  }
		| undefined {
		try {
			const sess = this.session;
			if (!sess) return undefined;
			const cwd = this.conv?.cwd ?? this.cwd;
			const active = sess.getActiveToolNames();
			const snippets: Record<string, string> = {};
			const guidelines: string[] = [];
			const schemaEntries: import("./prompt-composer.js").ToolSchemaEntry[] = [];
			for (const name of active) {
				const def = sess.getToolDefinition(name);
				if (!def) continue;
				if (def.promptSnippet && def.promptSnippet.trim()) snippets[name] = def.promptSnippet;
				if (def.promptGuidelines) guidelines.push(...def.promptGuidelines);
				schemaEntries.push({
					name,
					description: def.description,
					parameters: def.parameters,
				});
			}
			const loader = sess.resourceLoader;
			const texts = resolveSectionTexts(
				this.composeInputs({
					cwd,
					selectedTools: active,
					toolSnippets: snippets,
					toolGuidelines: guidelines,
					contextFiles: loader.getAgentsFiles().agentsFiles,
					skills: loader.getSkills().skills.map((s) => ({
						name: s.name,
						description: s.description ?? "",
						filePath: (s as { filePath?: string }).filePath ?? "",
					})),
				}),
			);
			// 模板/覆盖渲染（无则保持 SDK 默认拼装，与 renderMainCompose 同规则）。
			const tpl = (this.settingsSvc.current.promptTemplate ?? "").trim();
			const ovs = this.settingsSvc.current.promptOverrides ?? {};
			const hasOverride = Object.values(ovs).some((v) => typeof v === "string" && v.trim());
			const rendered =
				!tpl && !hasOverride ? undefined : renderPromptTemplate(tpl || DEFAULT_PROMPT_TEMPLATE, texts, ovs);
			return { texts, full: rendered ?? sess.systemPrompt, toolsSchema: buildToolsSchemaText(schemaEntries) };
		} catch {
			// Session not ready yet.
			return undefined;
		}
	}

	/** 设置面板预览用的 host 回调（见 SettingsHost.promptSnapshot）：完整生效提示词
	 *  + 各来源默认（自动）内容。会话未就绪时给空值，面板保持可编辑但不预览。 */
	private promptSnapshot(): { full: string; texts: Record<string, string>; toolsSchema: string } {
		return this.sessionPromptSnapshot() ?? { full: "", texts: {}, toolsSchema: "" };
	}

	/** Web-facing extension UI context (widgets, notifications). */
	private webUi = new WebUIContext((msg) => this.emit(msg));

	/**
	 * 第一方子代理 host（见 subagents.ts 设计头注）。子代理 = 一个标记
	 * isSubagent 的普通 Conversation：inMemory runtime（不落盘、不进
	 * 历史/resume 列表）、listed=true 出现在左栏「运行的对话」并向用户可见——
	 * 切换查看 / 输入补充（steer）/ 中止（abort）/ 移出全部复用现有对话机制。
	 */
	private subagentHost: SubagentToolHost = {
		spawnSubagent: (prompt, type, cwd, templateName, model, parentId) => {
			// 模板：存在且启用时应用；传了名字但不可用 → 抛错让工具转给 AI。
			const tpl = templateName ? this.subagentTemplates.get(templateName) : undefined;
			if (templateName && (!tpl || !tpl.enabled)) {
				throw new Error(
					pick(
						this.getLang(),
						`子代理模板不可用：${templateName}（不存在或已停用）`,
						`Subagent template unavailable: ${templateName} (missing or disabled)`,
						"agent.subagent.template.unavailable",
						{ templateName: templateName },
					),
				);
			}
			// 模型优先级：显式 model 参数 > 模板自带模型 > 设置面板默认模型；都不给 = 跟随主对话。
			return this.spawnSubagentConversation(prompt, type, cwd, tpl, model, parentId);
		},
		getSubagent: (convId) => this.getSubagentSnapshot(convId),
		listSubagents: () => this.listSubagentSnapshots(),
		steerSubagent: async (convId, message) => {
			const conv = this.convs.get(convId);
			if (!conv?.session) return;
			await conv.session.sendUserMessage(message, conv.session.isStreaming ? { deliverAs: "steer" } : undefined);
		},
		stopSubagent: async (convId) => {
			const conv = this.convs.get(convId);
			if (conv && (conv.session.isStreaming || !conv.session.isIdle)) {
				await this.interruptRun(
					conv,
					pick(this.getLang(), "用户停止子代理", "User stopped the subagent", "agent.subagent.stop.user"),
				);
			}
		},
		// issue #91：子代理工具返回按客户端 UI 语言出中英（英文默认）。
		lang: () => this.getLang(),
		// 只向 AI 暴露 enabled 的模板（停用的对 AI 不可见）。
		listTemplates: () =>
			this.subagentTemplates
				.list()
				.filter((t) => t.enabled)
				.map((t) => ({ name: t.name, description: t.description, descriptionEn: t.descriptionEn, model: t.model })),
		isTemplateUsable: (name) => {
			const t = this.subagentTemplates.get(name);
			return !!t && t.enabled;
		},
	};
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

	/** 子代理模板库（全局共享，<dataDir>/subagent-templates.json）。 */
	private readonly subagentTemplates: SubagentTemplatesStore;
	/** 内置标记服务（todo/notify/svc/rename 等，可全局/分组开关）。 */
	private readonly markerSvc: MarkerService;

	// -----------------------------------------------------------------------
	// 用户提问桥（标准 pi 引擎的 ask_user_question customTool）：与 DSH 引擎的
	// question_pending/question_answer 同协议。模型调 ask_user_question 工具 →
	// 本桥发 question_pending 给浏览器 → 等 question_answer → resolve/reject
	// 工具结果（agent 循环阻塞）。一次只展示一个提问（agent 阻塞在工具执行）。
	// -----------------------------------------------------------------------
	private questionSeq = 0;
	/** 待答提问（id → 载荷 + resolve）。一次正常只有一个（agent 阻塞在工具执行）；
	 *  conversationId 记录谁问的：看门狗豁免、快照恢复都靠它。 */
	private pendingQuestions = new Map<
		string,
		{ resolve: (value: QuestionAnswer[] | null) => void; questions: UiQuestion[]; conversationId?: string }
	>();

	private constructor(clientId: string, cwd: string, agentDir: string, stateStore: ClientStateStore) {
		this.clientId = clientId;
		this.cwd = cwd;
		this.agentDir = agentDir;
		this.stateStore = stateStore;
		this.subagentTemplates = new SubagentTemplatesStore(join(stateStore.dataDir, "subagent-templates.json"));
		this.markerSvc = new MarkerService({
			clientId,
			stateStore,
			emit: (msg) => this.emit(msg),
			isDisposed: () => this.disposed,
			getActiveConversationId: () => this.activeId,
			getSessionManager: (id) => {
				const c = this.convs.get(id);
				return c
					? (c.session.sessionManager as unknown as {
							getBranch: () => unknown[];
							appendCustomEntry?: (t: string, d: unknown) => unknown;
						})
					: undefined;
			},
			renameConversation: (convId, title) => {
				// 复用现有重命名路径（内存标题 + 磁盘 session_info）
				void this.renameConversation(convId, title);
			},
			// 标记 widget 合并进扩展 widget 里，跟随当前活动会话渲染（切换会话即刷新）。
			refreshMarkers: () => this.webUi.refresh(),
			// issue #91：标记引导/错误按客户端 UI 语言出中英（英文默认）。
			lang: () => this.getLang(),
		});
		// 标记 widget 动态渲染「当前活动会话」的 todo/overlay：切换会话时只要刷新
		// webUi（见 switchConversation/setCwd/newChat）就会显示对应会话的标记，
		// 且与扩展 widget 合并下发、不会互相覆盖。
		this.webUi.setDynamicWidget("markers", () => this.markerSvc.overlayLines(this.activeId));
		this.settingsSvc = new SettingsService(
			{
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
					// reload() 重读磁盘 settings.json，会丢掉内存 applyOverrides
					// （含重试次数覆盖）——依次重放：重试覆盖 → 终端门控。
					this.applyRetryOverrides();
					// reload() 会把 custom 工具重新加回活跃集——重放终端开关。
					this.applyToolGating(this.session);
					await this.pushSlashCommands();
				},
				applyRetryOverrides: () => this.applyRetryOverrides(),
				applyToolGating: () => this.applyToolGating(this.session),
				promptSnapshot: () => this.promptSnapshot(),
				getMarkerState: () => ({
					markersEnabled: this.markerSvc.current.markersEnabled,
					disabledMarkers: [...this.markerSvc.current.disabledMarkers],
					markers: this.markerSvc.listForUi(),
				}),
			},
			this.subagentTemplates,
		);
		this.goalSvc = new GoalService({
			clientId,
			agentDir,
			stateStore,
			webUi: this.webUi,
			emit: (msg) => this.emit(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			quiesceBlocked: () => this.quiesceBlocked(),
			// issue #91：目标/审查文案按客户端 UI 语言出中英（英文默认）。
			lang: () => this.getLang(),
			// 目标模式总开关（设置面板「目标审查」页）：关 → 目标入口一律拒绝。
			goalModeEnabled: () => this.settingsSvc.current.goalModeEnabled !== false,
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
		const runtime = await createAgentSessionRuntime(cs.makeRuntimeFactory(terminals, undefined, conversationId), {
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
					textEn: d.message,
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
	 *
	 * `apply`（可选）：子代理模板 —— 会话的 system prompt / 技能 / 扩展按模板
	 * 应用（prompt replace/append + 白名单），其余（终端接管、Windows persona
	 * 等）仍跟随主会话设置。undefined = 按主会话设置（普通对话/不选模板的子代理）。
	 */
	private makeRuntimeFactory(
		terminals: TerminalManager,
		apply?: SubagentTemplate,
		ownerId?: string,
	): CreateAgentSessionRuntimeFactory {
		return async ({ cwd: effectiveCwd, sessionManager }) => {
			const services = await createAgentSessionServices({
				cwd: effectiveCwd,
				modelRuntime: this.sharedModelRuntime,
				// 设置面板钩子（官方 SDK 的 resourceLoader overrides）：三个 override
				// 在每次 resourceLoader.reload() 时重放，且读取 this.settings 的当前
				// 值——因此 session.reload() 即可让系统提示词 / 技能 / 插件开关生效，
				// 新对话（新 runtime）也会自动带上当前设置。
				// 子代理带模板（apply）时：prompt/skills/extensions 改读模板视图——
				// replace 模式：无 SYSTEM.md 时把灵魂段替换为模板提示词（见下方
				// pi-webui-persona 内联扩展）；有 SYSTEM.md 时仍由 systemPromptOverride
				// 整体替换 base。append 模式把模板提示词追加到
				// 末尾（此时主会话的自定义 prompt 不再叠加，角色由模板定义）；非空
				// 白名单取代主会话开关（只启用这些），空白名单 = 跟随主会话。
				resourceLoaderOptions: {
					// 系统提示词 base：主会话（组合模板）恒返回 undefined → SDK 走默认分支，
					// 工具列表/Guidelines/文档指引等自动段照常拼装；SYSTEM.md 内容仅在
					// 此处捕获（lastBaseSystemPrompt）作 {{soul}} 自动内容。子代理模板
					// replace 在存在 SYSTEM.md base 时整体替换该 base。
					systemPromptOverride: (base?: string) => {
						if (typeof base === "string" && base) {
							this.lastBaseSystemPrompt = base;
							if (apply && apply.promptMode === "replace" && pickTemplatePrompt(apply, this.getLang()).trim()) {
								return pickTemplatePrompt(apply, this.getLang());
							}
						}
						return undefined;
					},
					appendSystemPromptOverride: (base: string[]) => {
						// 记录 SDK APPEND_SYSTEM.md base（composer {{append}} 自动内容）。
						if (!apply) this.lastSdkAppendFiles = base.slice();
						const out = [...base];
						if (apply && apply.promptMode === "append" && pickTemplatePrompt(apply, this.getLang()).trim()) {
							out.push(pickTemplatePrompt(apply, this.getLang()));
						}
						// 主会话自定义「追加」已并入组合模板的 {{append}} 覆盖，不再在此注入。
						if (process.platform === "win32") {
							// Windows 专属 persona：bash 工具跑 Git Bash 且无默认超时、终端
							// 是交互式 TTY——注入约束避免 heredoc/交互/长驻命令挂死整个会话；
							// GBK 老中文文件让模型改用终端按正确编码读（iconv/chcp/Get-Content）。
							out.push(WINDOWS_PERSONA);
						}
						if (isTerminalGuidanceOn(effectiveDisabledAgentTools(this.settingsSvc.current))) {
							// 终端工具使用引导（全平台）：告诉模型什么场景该用持久终端
							// 而不是一次性 bash——没有这段模型几乎从不主动选终端工具。
							// 组内工具全关时不注入（不教 AI 用不存在的工具）。
							out.push(TERMINAL_TOOLS_GUIDANCE);
						}
						// bash 管道限制已并入 bash 工具自身的 description，不再作为独立提示段注入。
						// 内置标记工具引导（按总开关/分组开关过滤）
						const markerGuidance = this.markerSvc.buildGuidance();
						if (markerGuidance) out.push(markerGuidance);
						return out;
					},
					// 技能：模板非空白名单时只启用白名单里的；否则按主会话禁用集过滤。
					skillsOverride: (res) => {
						if (apply && apply.enabledSkills.length > 0) {
							const set = new Set(apply.enabledSkills);
							return { ...res, skills: res.skills.filter((s) => set.has(s.name)) };
						}
						return {
							...res,
							skills: res.skills.filter((s) => !this.settingsSvc.current.disabledSkills.includes(s.name)),
						};
					},
					// 插件：模板非空扩展白名单时只加载白名单里的；否则按主会话禁用集过滤。
					// 注意 SDK 在 extensionsOverride 之后才补 sourceInfo，包扩展此处只能靠路径
					// 匹配 —— isExtensionDisabled / isExtensionEnabled 同时比对 npm:<pkg> 候选键。
					extensionsOverride: (res) => {
						// 自家内联扩展（灵魂替换）是基础设施，不参与白名单/禁用过滤。
						const keepOwn = (e: { path: string }) => !e.path.startsWith(INLINE_PERSONA_EXT);
						if (apply && apply.enabledExtensions.length > 0) {
							const set = new Set(apply.enabledExtensions);
							return {
								...res,
								extensions: res.extensions.filter((e) => keepOwn(e) || isExtensionEnabled(e, [...set])),
							};
						}
						return {
							...res,
							extensions: res.extensions.filter(
								(e) => keepOwn(e) || !isExtensionDisabled(e, this.settingsSvc.current.disabledExtensions),
							),
						};
					},
					// 组合模板渲染（主会话）+ 模板灵魂替换（子代理）：before_agent_start 在每个
					// agent run 前触发，SDK 此时已用最新工具/资源拼好基础提示词；若配置了模板或
					// 覆盖，则用 composer 把 {{token}} 展开为各来源文本（工具列表/项目上下文/技能
					// 等都取自本次 run 的 systemPromptOptions，永远最新）。
					extensionFactories: [
						{
							name: "pi-webui-persona",
							hidden: true,
							factory: (pi) => {
								pi.on("before_agent_start", (event) => {
									// 子代理模板 replace（无 SYSTEM.md 时）：默认分支拼好的提示词里
									// 把灵魂段换成模板提示词，自动段保留；SYSTEM.md 情形已在
									// systemPromptOverride 整体替换，此处边界不存在会自然跳过。
									if (apply) {
										if (apply.promptMode !== "replace" || !pickTemplatePrompt(apply, this.getLang()).trim())
											return undefined;
										const boundary = event.systemPrompt.indexOf("\n\nAvailable tools:");
										if (boundary === -1) return undefined;
										const swapped =
											pickTemplatePrompt(apply, this.getLang()).trimEnd() + event.systemPrompt.slice(boundary);
										return swapped === event.systemPrompt ? undefined : { systemPrompt: swapped };
									}
									// 主会话：组合模板渲染（模板为空且无覆盖时返回 undefined = 用 SDK 默认）。
									const opts = event.systemPromptOptions as
										| {
												cwd?: string;
												selectedTools?: string[];
												toolSnippets?: Record<string, string>;
												promptGuidelines?: string[];
												contextFiles?: { path: string; content: string }[];
												skills?: { name: string; description?: string; filePath?: string }[];
										  }
										| undefined;
									const rendered = this.renderMainCompose({
										cwd: typeof opts?.cwd === "string" ? opts.cwd : this.cwd,
										selectedTools: opts?.selectedTools ?? [],
										toolSnippets: opts?.toolSnippets ?? {},
										toolGuidelines: opts?.promptGuidelines ?? [],
										contextFiles: opts?.contextFiles ?? [],
										skills: (opts?.skills ?? []).map((s) => ({
											name: s.name,
											description: s.description ?? "",
											filePath: s.filePath ?? "",
										})),
									});
									return rendered ? { systemPrompt: rendered } : undefined;
								});
							},
						},
					],
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
						// issue #91：bash 返回按客户端 UI 语言出中英（英文默认）。
						makeKillableBashTool(effectiveCwd, this.bashKills, () => this.getLang()),
						makeTerminalBashTool(terminals, {
							cwd: effectiveCwd,
							// 设置开 = 用终端；此分支里 persist 未显式给时默认一次性（false）。
							defaultPersist: () => false,
							idleMs: () => Math.max(0, Math.floor(this.settingsSvc.current.terminalBashIdleMs) || 0),
							kills: this.bashKills,
							notifyBackgroundDone: (info) => this.notifyTerminalBashDone(terminals, info),
							// issue #91：bash 返回按客户端 UI 语言出中英（英文默认）。
							lang: () => this.getLang(),
						}),
						// 设置关 → 原生 bash；开 → 终端 bash。
						() => this.settingsSvc.current.terminalBash,
					),
					...makePersistentTerminalTools(terminals, effectiveCwd, () => this.getLang()),
					// 不覆盖内置 edit 的独立宽松编辑工具（缩进不敏感匹配；开关看设置）。
					makeEditSoftTool(effectiveCwd, () => this.getLang()),
					// 插件注册的 AI 工具（创建时刻的实时快照；后续注册经
					// refreshPluginTools 动态补入已有会话）。
					...(this.pluginToolsProvider?.() ?? []).map(pluginToolToDefinition),
					// 第一方子代理工具（spawn/get_result/steer/list/stop）。子代理会话
					// 也注册了它们，因此可自然嵌套派发。host 按 ownerId 包装：子代理的
					// 父对话 = 真正调用 spawn 的那个会话（本 runtime 所属会话），而不是
					// 派发瞬间的 active——后台对话继续产出时用户可能已切到别的项目，用
					// activeId 会把孩子记到无关会话名下、沉到别的组/底部（issue #95）。
					// ownerId 即本 runtime 所属会话（创建时就已知，见各调用点），一身二任：
					// spawn 的 parentId（子代理记到真正的派发会话名下）+ wait_all 的
					// selfConvId（调用者自身永不计入等待，防 self-wait deadlock）。
					...(ownerId
						? makeSubagentTools(withSubagentOwner(this.subagentHost, ownerId), undefined, ownerId)
						: makeSubagentTools(this.subagentHost)),
					// 结构化派单（六段式 + 服务端校验；执行体复用子代理 spawn 通道）。
					// owner 包装与上面同理：子代理记到真正的派发会话名下。
					...(ownerId
						? [makeDelegateTaskTool(withSubagentOwner(this.subagentHost, ownerId))]
						: [makeDelegateTaskTool(this.subagentHost)]),
					// 内置标记只读查询工具（todo/svc 状态查询，写操作走内联标记）。
					makeMarkersListTool(() => this.activeId, this.markerSvc),
					// 标准引擎的 ask_user_question：模型调用 → 浏览器富渲染问卷（复用 DSH
					// 的 question_pending/question_answer 协议，前端 DshQuestionDialog）。
					// DSH 引擎不经此（它走 goal-rpc 的 userQuestions provider）。
					makeAskUserQuestionTool(this, ownerId),
				],
			});
			// 终端工具开关从创建起就生效（工具始终注册进注册表，只调活跃集）。
			this.applyToolGating(created.session);
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
			isSubagent: false,
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
				this.emit({ type: "notice", level: "error", text: err.error, textEn: err.error });
			},
		});
		conv.unsubscribe = conv.session.subscribe((event) => this.onEvent(conv, event));
		// 新会话 / 切换会话 / 强杀重建的必经之路：刚创建的 runtime 用的是 SDK
		// 默认重试 3 次——这里把面板的 retryMaxAttempts 覆盖注入，否则“设了 6
		// 次还是按 3 次重试”。已存在会话重复注入是幂等的（同值覆盖）。
		this.applyRetryOverrides();
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
				// 正在等用户回答的对话本就该「无声」——那是人在想，不是失联。
				if (
					!conv.stallNoticed &&
					conv.session.isStreaming &&
					!this.isWaitingOnUser(conv.id) &&
					now - conv.lastSdkEventAt > STALL_NOTIFY_MS
				) {
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

	/** 发一条运行轨迹事件给插件（host.onRunEvent 订阅者，如轨迹视图插件）。
	 *  异常隔离——序列化/插件坏了只记日志，绝不影响主流程。 */
	private emitRun(conv: Conversation, ev: Omit<PluginRunEvent, "conversationId" | "at">): void {
		if (!this.onRunEvent) return;
		try {
			this.onRunEvent({ ...ev, conversationId: conv.id, at: Date.now() });
		} catch (err) {
			console.error("[agent-service] onRunEvent failed:", err);
		}
	}

	/** 当前打开对话变了 → 通知插件重拉（切历史会话/切 running 对话/新对话）。
	 *  异常隔离——插件坏了只记日志，绝不影响切换流程。 */
	private notifyConversationChanged(): void {
		if (!this.onConversationChanged) return;
		try {
			this.onConversationChanged();
		} catch (err) {
			console.error("[agent-service] onConversationChanged failed:", err);
		}
	}

	/** 插件用：本客户端最近活跃对话的快照（轨迹视图直接显示打开对话的时间线）。
	 *  messages/streamingMessage 为引用稳定的只读缓存对象——调用方只读、不得修改。 */
	readConversationForPlugins(): PluginConversationSnapshot | null {
		try {
			let target: Conversation | null = null;
			for (const c of this.convs.values()) {
				if (!target || c.lastActiveAt > target.lastActiveAt) target = c;
			}
			if (!target) return null;
			const state = target.session.agent.state;
			let stats: PluginConversationSnapshot["stats"] = {
				totalMessages: 0,
				tokens: { input: 0, output: 0, total: 0 },
				cost: 0,
			};
			try {
				const s = target.session.getSessionStats();
				stats = { totalMessages: s.totalMessages, tokens: s.tokens, cost: s.cost };
			} catch {
				/* stats 尽力而为 */
			}
			let streamingMessage: UiMessage | null = null;
			try {
				streamingMessage = state.streamingMessage ? serializeStreamingMessage(state.streamingMessage) : null;
			} catch {
				/* 尽力而为 */
			}
			return {
				conversationId: target.id,
				title: target.title,
				at: target.lastActiveAt,
				isStreaming: target.session.isStreaming,
				messages: this.messagesOf(target),
				streamingMessage,
				stats,
			};
		} catch (err) {
			console.error("[agent-service] readConversationForPlugins failed:", err);
			return null;
		}
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
				// 看门狗豁免：ask_user_question 阻塞等的是「人类回答」，不是挂死的工具
				// （默认 20 分钟会把还在思考的用户连对话一起剁掉）。它的收场自有路子：
				// 用户回答/取消、会话 dispose（cancelPendingQuestions），不限时。
				if (event.toolName !== ASK_USER_QUESTION_TOOL_NAME) {
					this.armToolWatchdog(conv, event.toolCallId);
				}
				// 插件扩展点：工具开始执行（异常由 emitToolEvent 隔离）。
				this.onToolEvent?.({
					phase: "start",
					toolName: event.toolName,
					conversationId: conv.id,
					toolCallId: event.toolCallId,
				});
				// 轨迹事件：带参数预览（JSON 封顶；超大参数只记截断）。
				let argsText = "null";
				try {
					argsText = truncRun(JSON.stringify(event.args ?? null), RUN_ARGS_CAP);
				} catch {
					argsText = "[unserializable args]";
				}
				this.emitRun(conv, {
					type: "tool_start",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					argsText,
				});
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
					toolCallId: event.toolCallId,
					...(durationMs !== undefined ? { durationMs } : {}),
					isError: event.isError,
				});
				// 轨迹事件：带结果预览（封顶）+ 耗时/错误标志。
				this.emitRun(conv, {
					type: "tool_end",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					resultText: previewToolResult(event.result),
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
			// 手动 /compact 或阈值/溢出自动压缩开始——常驻进度条（快照 compaction
			// 字段），而不是一次性 toast（toast 几秒就消失，而摘要生成可能持续
			// 数十秒，用户会以为「没反应」）。立即 flush 让进度条第一时间出现。
			case "compaction_start": {
				conv.compactionState = { reason: event.reason, startedAt: Date.now() };
				conv.lastCompactionTokens = null;
				this.flushSnapshot();
				break;
			}
			case "compaction_end": {
				conv.compactionState = null;
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
					// 记住压缩后大小：SDK 在下轮响应前报 null，快照用此回填底栏。
					conv.lastCompactionTokens = estimatedTokensAfter ?? null;
					this.emit({
						type: "notice",
						level: "info",
						text: `上下文压缩完成：${tokensBefore.toLocaleString()} → ${after.toLocaleString()} tokens（摘要已插入消息区）`,
						textEn: `Context compacted: ${tokensBefore.toLocaleString()} → ${after.toLocaleString()} tokens (summary inserted into the message list)`,
					});
				}
				break;
			}
			case "auto_retry_start": {
				// 大模型 API 瞬时报错，SDK 退避重试：填实重试信息。末尾 error
				// 消息已被（或即将被）SDK 从 state 摘掉，currentMessages() 凭此旗
				// 过滤，快照只显示温和的重试条。落盘由底部检查点立即 flush。
				conv.retryState = {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
				};
				break;
			}
			case "auto_retry_end": {
				// 重试结束：成功 → 新内容照常显示；耗尽 → error 消息留驻，
				// 快照永久标红。落盘由底部检查点立即 flush。
				conv.retryState = null;
				break;
			}
			// A run finished or a new entry was persisted — keep the session list fresh
			// (new chat + first message, completed turns, compaction, etc.).
			case "agent_end": {
				// 可重试错误：SDK 随后发 auto_retry_start 并把末尾 error 消息从
				// state 摘掉。这里先立占位，让本次立即 flush 的快照就不含瞬时红错
				// ——否则快照先画红、摘掉后又消失，即「红色报错一闪而过」。
				if (event.willRetry) {
					let errorMessage = "";
					for (let i = event.messages.length - 1; i >= 0; i--) {
						const m = event.messages[i] as { role?: unknown; errorMessage?: unknown };
						if (m.role === "assistant" && typeof m.errorMessage === "string") {
							errorMessage = m.errorMessage;
							break;
						}
					}
					conv.retryState = { attempt: 0, maxAttempts: 0, delayMs: 0, errorMessage };
				} else {
					// 本轮结束且无后续重试：任何残留占位都是过期的（会话替换、
					// 结束信号丢失等），清掉，否则横幅会卡住不消失。
					conv.retryState = null;
				}
				// 轨迹事件：本轮结束（放最前——aborted 中断路径也会 break，
				// 轨迹里必须留下「已停止」而不是凭空消失）。
				try {
					const lastAssistant = [...(event.messages as unknown[])].reverse().find((m) => {
						const a = m as { role?: string; stopReason?: string };
						return a.role === "assistant" && typeof a.stopReason === "string";
					}) as { stopReason?: string } | undefined;
					this.emitRun(
						conv,
						lastAssistant?.stopReason ? { type: "run_end", stopReason: lastAssistant.stopReason } : { type: "run_end" },
					);
				} catch {
					/* 轨迹尽力而为 */
				}
				this.scheduleSessionsRefresh();
				this.refreshConversationTitle(conv);
				// 内联标记不在此兜底扫最后一条 assistant：每条气泡结束已走 message_end
				// 即时解析（含中间文本块）；这里再扫会把最后一条标记重复执行（todo 重复建号）。

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
						this.emit({ type: "notice", level: "warning", text: stopNotice.text, textEn: stopNotice.textEn });
					}
					break;
				}
				// 子代理运行报错（provider 400 / 超时等）→ 通知主对话，让用户/AI 知道
				// 拿回的结果可能是空或无意义的（否则子代理只是安静地停在「done」，
				// 主对话永远收不到失败信号）。错误文本变化时允许再次通知（去重）。
				if (conv.isSubagent) {
					const { error } = this.subagentRunOutcome(conv);
					if (error && error !== conv.subagentErrorNotified) {
						conv.subagentError = error;
						conv.subagentErrorNotified = error;
						this.emit({
							type: "notice",
							level: "error",
							text: `子代理 ${conv.id.slice(0, 8)}（${conv.subagentType ?? "general"}）运行失败：${error}`,
							textEn: `Subagent ${conv.id.slice(0, 8)} (${conv.subagentType ?? "general"}) failed: ${error}`,
						});
					} else if (error) {
						conv.subagentError = error;
					}
					this.emitConversations();
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
			case "entry_appended": {
				// SDK 仅在扩展 appendEntry 时发 entry_appended（entry 恒为 custom），
				// assistant 消息不会走这里——气泡级解析见 case "message_end"。
				this.scheduleSessionsRefresh();
				this.refreshConversationTitle(conv);
				break;
			}
			case "message_end": {
				// 轨迹事件：一条消息定稿（user/assistant 都收；custom display:false
				// 的 serializeMessage 返回 null 时跳过）。
				try {
					const ui = serializeMessage(event.message as AgentMessage, 0);
					if (ui) this.emitRun(conv, { type: "message", message: ui });
				} catch {
					/* 轨迹尽力而为 */
				}
				// 每条 assistant 气泡流式结束 → 立即解析其中的内联标记：每个气泡各自
				// 每条 assistant 气泡流式结束 → 立即解析其中的内联标记：每个气泡各自
				// 生效（不再等整轮 agent_end），同一轮里先前消息的标记也不再丢。
				const mm = event.message as { role?: string; stopReason?: unknown; content?: unknown };
				if (mm?.role !== "assistant") break;
				// 非 error 的 assistant 定稿 = 重试周期结束（与 SDK 重置
				// _retryAttempt 的条件一致）：即使 auto_retry_end 丢失，横幅也不会卡住。
				if (mm.stopReason !== "error") conv.retryState = null;
				const text = extractAssistantTextFromContent(mm.content);
				if (text && text.includes("[[")) void this.markerSvc.handleAssistantText(conv.id, text);
				break;
			}
			case "agent_start": {
				// 轨迹事件：新一轮开始（任务文本由 prompt() 暂存；steer/内部续跑
				// 无暂存时省略，插件回退为「继续执行」）。
				const task = conv.pendingTask;
				conv.pendingTask = undefined;
				this.emitRun(conv, task ? { type: "run_start", task } : { type: "run_start" });
				break;
			}
			case "turn_start": {
				this.emitRun(conv, { type: "turn_start" });
				break;
			}
			case "turn_end": {
				this.emitRun(conv, { type: "turn_end" });
				break;
			}
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
		if (
			event.type === "agent_end" ||
			event.type === "tool_execution_end" ||
			event.type === "compaction_end" ||
			event.type === "auto_retry_start" ||
			event.type === "auto_retry_end"
		) {
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
		return this.serializeCachedFor(this.conv, m);
	}

	/** serializeCached 的按对话版本（插件快照读非活跃对话用；缓存仍按对话隔离）。 */
	private serializeCachedFor(conv: Conversation, m: AgentMessage): UiMessage | null {
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
		return this.messagesOf(this.conv);
	}

	/** currentMessages 的按对话版本（插件快照读非活跃对话用）。 */
	private messagesOf(conv: Conversation): UiMessage[] {
		let rawMessages = conv.session.agent.state.messages
			.map((m) => this.serializeCachedFor(conv, m))
			.filter((m): m is NonNullable<typeof m> => m !== null);
		// 自动重试等待期：SDK 暂留在 state 末尾的 error 气泡只是中间态（随后被
		// 摘掉重跑），不进快照——成功则用户永远看不到，耗尽才标红。否则 agent_end
		// 的立即 flush 会先画红、摘掉后又消失（红色一闪而过）。
		rawMessages = stripTransientRetryErrors(rawMessages, !!conv.retryState);
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
				contextUsage: (() => {
					const cu = s.contextUsage;
					if (!cu) return stats.contextUsage;
					// 压缩刚结束、下轮响应未到：SDK 报 null，用压缩结果回填约数。
					if (cu.tokens == null && conv.lastCompactionTokens != null && cu.contextWindow > 0) {
						return {
							tokens: conv.lastCompactionTokens,
							contextWindow: cu.contextWindow,
							percent: (conv.lastCompactionTokens / cu.contextWindow) * 100,
							estimated: true,
						};
					}
					return {
						tokens: cu.tokens,
						contextWindow: cu.contextWindow,
						percent: cu.percent,
					};
				})(),
			};
		} catch {
			// stats are best-effort
		}
		// 流式 error 同样是中间态（定稿走 message_end/agent_end）：先藏起
		// errorMessage，避免红色在 streaming 气泡里闪一下。最终失败会经由
		// messages 永久标红，不影响告警。
		let streamingMessage = state.streamingMessage ? serializeStreamingMessage(state.streamingMessage) : null;
		if (streamingMessage?.stopReason === "error") {
			streamingMessage = { ...streamingMessage, errorMessage: undefined };
		}
		return {
			clientId: this.clientId,
			cwd: this.cwd,
			sessionId: this.session.sessionId,
			sessionFile: this.session.sessionFile,
			conversationId: this.activeId,
			rev,
			streamingMessage,
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
			retry: conv.retryState ?? null,
			compaction: conv.compactionState ?? null,
			pendingQuestion: this.pendingQuestionForSnapshot(),
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

	// -----------------------------------------------------------------------
	// 用户提问桥（标准 pi 引擎 ask_user_question customTool）
	// -----------------------------------------------------------------------

	/** 标准引擎模型调 ask_user_question：发 question_pending 给浏览器并阻塞等待
	 *  question_answer。sig 为工具执行信号的当前状态（aborted → 立即 reject）。
	 *  返回 answers（用户选中/自定义），或 null（用户取消）。
	 *
	 *  不设超时：等的是「人类回答」，不是挂死的工具。因此也不进工具挂死看门狗
	 *  （见 tool_execution_start）、不算 stall 失联（见 startStallTimer）。 */
	askUser(
		questions: UiQuestion[],
		sig: { aborted?: boolean },
		conversationId?: string,
	): Promise<QuestionAnswer[] | null> {
		return new Promise((resolve, reject) => {
			if (sig?.aborted || this.disposed) {
				reject(new Error("ask_user_question 已中止"));
				return;
			}
			// 问卷开关（默认开）：关 → 不弹对话框，立即报错让模型得知已禁用。
			// 与统一工具门控双保险：工具 tab 里单独关掉 ask_user_question 也一样拒收。
			if (
				this.settingsSvc.current.questionnaireEnabled === false ||
				(this.settingsSvc.current.disabledAgentTools ?? []).includes(ASK_USER_QUESTION_TOOL_NAME)
			) {
				reject(new Error("问卷功能已关闭，可在设置中重新开启"));
				return;
			}
			const id = `q-${++this.questionSeq}`;
			this.pendingQuestions.set(id, { resolve, questions, conversationId });
			this.emit({
				type: "question_pending",
				id,
				questions,
			});
		});
	}

	/** 前端回答模型提问（question_answer → 恢复 askUser 的 Promise）。id 需匹配
	 *  pendingQuestions 中键；cancelled 或未匹配（例如用户早已切走）时按「取消」处理
	 *  —— 把挂起的提问全部 reject，让模型知道用户离开了。 */
	resolveQuestion(id: string, answers: QuestionAnswer[], cancelled?: boolean): void {
		const pending = this.pendingQuestions.get(id);
		if (pending) {
			this.pendingQuestions.delete(id);
			pending.resolve(cancelled ? null : answers);
		}
	}

	/** 快照侧的待答提问（UiState.pendingQuestion）：只带当前对话的问卷——切回
	 *  原对话会重推快照，对话框随之回来（重连/刷新/第二标签页的恢复通道）。 */
	private pendingQuestionForSnapshot(): UiState["pendingQuestion"] {
		for (const [id, p] of this.pendingQuestions) {
			if (p.conversationId !== undefined && p.conversationId !== this.activeId) continue;
			return { id, questions: p.questions };
		}
		return null;
	}

	/** 对话是否阻塞在等用户回答上（用于 stall 失联判定豁免）。 */
	private isWaitingOnUser(conversationId: string): boolean {
		for (const p of this.pendingQuestions.values()) {
			if (p.conversationId === undefined || p.conversationId === conversationId) return true;
		}
		return false;
	}

	/** 标准引擎的 question_answer 路由入口（index.ts 经 cs.answerQuestion?. 转发）。
	 *  DSH 引擎的 AgentService 也实现了同名方法，此处为 ClientSession 的转发。 */
	answerQuestion(id: string, answers: QuestionAnswer[], cancelled?: boolean): Promise<void> {
		this.resolveQuestion(id, answers, cancelled);
		return Promise.resolve();
	}

	/** 关闭所有挂起提问（dispose 时清理）：以「取消」解析，避免模型挂死。 */
	cancelPendingQuestions(): void {
		for (const [, p] of this.pendingQuestions) {
			p.resolve(null);
		}
		this.pendingQuestions.clear();
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
	 *
	 * The probe is FORK-FREE: it scans PATH for the pi executable instead of
	 * spawning `pi --version`. Do not reintroduce a spawn here — ANY fork on
	 * the main thread of this multi-threaded server can deadlock the whole
	 * process on Android/Termux (issue #78): libuv's uv_spawn blocks its
	 * caller reading the child's error pipe, and that pipe never closes when
	 * the forked child deadlocks between fork and exec. This applies to
	 * asynchronous spawns too — the previous async probe reproduced the hang.
	 */
	private static piCliProbe: { at: number; installed: boolean } | null = null;
	private static readonly PI_CLI_PROBE_TTL_MS = 10_000;

	private isPiCliInstalled(): boolean {
		const now = Date.now();
		const cached = ClientSession.piCliProbe;
		if (cached && now - cached.at < ClientSession.PI_CLI_PROBE_TTL_MS) return cached.installed;
		const installed = ClientSession.piCliOnPath();
		ClientSession.piCliProbe = { at: now, installed };
		return installed;
	}

	private static piCliOnPath(): boolean {
		const dirs = (process.env.PATH ?? "").split(delimiter);
		for (const dir of dirs) {
			if (dir && existsSync(join(dir, "pi"))) return true;
		}
		return false;
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
			const items = await checkAllUpdates(targets, undefined, () => this.getLang());
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
		// /new <prompt>: deliver the text as the new session's first prompt.
		prompt: (text) => this.prompt(text),
		setModel: (id) => this.setModel(id),
		setCwd: (path) => this.setCwd(path),
		setThinking: (level) => this.setThinking(level),
		renameSession: async (name) => {
			this.session.setSessionName(name);
			this.conv.title = name;
			this.invalidateSessionInfos();
			this.emitConversations();
			await this.pushSessions();
			this.emit({
				type: "notice",
				level: "info",
				text: `已重命名当前会话为「${name}」`,
				textEn: `Renamed current session to "${name}"`,
			});
			this.flushSnapshot();
		},
		refreshSessions: () => this.refreshSessions(),
		afterReload: () => {
			// /reload 同样重读磁盘 settings.json——重放重试覆盖 + 终端门控。
			this.applyRetryOverrides();
			this.applyToolGating(this.session);
		},
		pluginCommands: () => this.pluginCommandsProvider?.() ?? [],
		execPluginCommand: async (name, args) => {
			const def = this.pluginCommandsProvider?.().find((c) => c.name === name);
			if (!def) return false;
			try {
				const result = await def.run(args, { clientId: this.clientId });
				// 字符串返回值 → 通知条回显给发起人；富展示用 broadcast/sendTo。
				if (typeof result === "string" && result.trim()) {
					this.emit({ type: "notice", level: "info", text: result, textEn: result });
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
	async clearProviderApiKey(provider: string): Promise<void> {
		await this.modelAdmin.clearProviderApiKey(provider);
		// The provider is back to unconfigured — drop its key preference in
		// EVERY project, otherwise each project switch re-tries a restore.
		this.stateStore.deleteProviderEverywhere(provider.trim());
	}
	listProviders(): Promise<void> {
		return this.modelAdmin.listProviders();
	}
	listModelsConfig(): Promise<void> {
		return this.modelAdmin.listModelsConfig();
	}
	reloadModelsConfig(): Promise<void> {
		return this.modelAdmin.reloadModelsConfig();
	}
	fetchModelsList(reqId: number, baseUrl: string, apiKey?: string, authHeader?: boolean, api?: string): Promise<void> {
		return this.modelAdmin.fetchModelsList(reqId, baseUrl, apiKey, authHeader, api, () => this.getLang());
	}
	refreshProviderModels(providerId: string, reqId: number): Promise<void> {
		return this.modelAdmin.refreshProviderModels(providerId, reqId, () => this.getLang());
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
		const ok = await this.modelAdmin.activateProviderKey(provider, keyName);
		// Only remember existing keys — a failed switch (deleted key) must not
		// plant a stale reference that errors on every later project switch.
		if (ok) this.stateStore.saveProjectProviderKey(this.clientId, this.cwd, provider, keyName);
		else this.stateStore.deleteProjectProviderKey(this.clientId, this.cwd, provider);
	}
	async removeProviderKey(provider: string, keyName: string): Promise<void> {
		await this.modelAdmin.removeProviderKey(provider, keyName);
		// The deletion may have been made from another project: every project
		// still pinned to the deleted key must follow the key that took over
		// (or drop the pin when no keys remain), not just the current one.
		const active = this.modelAdmin.getActiveKeyName(provider);
		this.stateStore.repointDeletedKeyEverywhere(provider, keyName, active);
	}

	/** Restore per-project provider keys when entering a project. For each
	 *  provider that has a saved key for `cwd`, activate it if it differs from
	 *  the current global active. Silent + self-healing: a saved key deleted
	 *  elsewhere is dropped without notifying (a noisy error here is what
	 *  haunted project switches after a key deletion). */
	private async restoreProjectProviderKeysForCwd(cwd: string): Promise<void> {
		const saved = this.stateStore.getProjectProviderKeys(this.clientId, cwd);
		if (!saved) return;
		for (const [provider, keyName] of Object.entries(saved)) {
			const cur = this.modelAdmin.getActiveKeyName(provider);
			if (cur === keyName) continue;
			if (!this.modelAdmin.hasProviderKey(provider, keyName)) {
				this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
				continue;
			}
			const ok = await this.modelAdmin.activateProviderKey(provider, keyName, { silent: true });
			if (!ok) this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
		}
	}

	/** When a model is set, ensure its provider's per-project key is restored.
	 *  Silent + self-healing like the bulk restore above. */
	private async restoreKeyForModel(modelId: string, cwd: string): Promise<void> {
		const slash = modelId.indexOf("/");
		if (slash <= 0) return;
		const provider = modelId.slice(0, slash);
		const saved = this.stateStore.getProjectProviderKey(this.clientId, cwd, provider);
		if (!saved) return;
		const cur = this.modelAdmin.getActiveKeyName(provider);
		if (cur === saved) return;
		if (!this.modelAdmin.hasProviderKey(provider, saved)) {
			this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
			return;
		}
		const ok = await this.modelAdmin.activateProviderKey(provider, saved, { silent: true });
		if (!ok) this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
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

	/** 把设置面板的出错重试次数注入全部存活会话的 SDK SettingsManager。
	 *  applyOverrides 只改内存合并视图（不碰 ~/.pi/agent/settings.json），
	 *  且 SDK 每次退避前都重读 getRetrySettings()——即时生效、无需 reload。
	 *  但 session.reload() 会重读磁盘丢掉覆盖，每次 reload 后必须重放
	 *  （reloadSession / afterReload / 标记开关直载路径均已接）。 */
	applyRetryOverrides(): void {
		const n = normalizeRetryMaxAttempts(this.settingsSvc.current.retryMaxAttempts);
		for (const c of this.convs.values()) {
			try {
				c.session.settingsManager.applyOverrides({ retry: { maxRetries: n } });
			} catch {
				// 会话未就绪或已释放 → 其 runtime 创建时统一注入。
			}
		}
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
		promptTemplate?: string;
		promptOverrides?: Record<string, string>;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		disabledAgentTools?: string[];
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		editSoftEnabled?: boolean;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: PromptMode;
		visionBridgePrompt?: string;
		subagentDefaultModel?: string | null;
		retryMaxAttempts?: number;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
		disabledPlugins?: string[];
		markersEnabled?: boolean;
		disabledMarkers?: string[];
		quickPhrases?: string[];
		quickPhrasesEnabled?: boolean;
	}): Promise<void> {
		const { markersEnabled, disabledMarkers, quickPhrasesSeeded, ...rest } = partial as {
			markersEnabled?: boolean;
			disabledMarkers?: string[];
			quickPhrasesSeeded?: boolean;
		} & typeof partial;
		// 快捷短语「已 seed」是全局标记（非 per-clientId）：置位一次后永久生效。
		if (quickPhrasesSeeded) this.stateStore.markQuickPhrasesSeeded();
		let markerChanged = false;
		if (markersEnabled !== undefined || disabledMarkers !== undefined) {
			this.markerSvc.setAll({
				...(markersEnabled !== undefined ? { markersEnabled } : {}),
				...(disabledMarkers !== undefined ? { disabledMarkers } : {}),
			});
			markerChanged = true;
		}
		await this.settingsSvc.set(rest as never);
		if (markerChanged) {
			// 标记开关影响 system prompt 引导，需重载生效（流式中则延迟）
			this.pushSettings();
			this.flushSnapshot();
			// 尝试立即重载，若流式中会由 SettingsService 延迟到 agent_end
			if (!this.session.isStreaming) {
				try {
					await this.session.reload();
					this.applyRetryOverrides();
					this.applyToolGating(this.session);
					await this.pushSlashCommands();
					this.pushSettings();
				} catch {}
			}
		}
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

	/** Upsert 一个子代理模板（全局共享）。 */
	async saveSubagentTemplate(template: UiSubagentTemplate): Promise<void> {
		return this.settingsSvc.saveTemplate(template);
	}

	/** 删除一个子代理模板。 */
	async deleteSubagentTemplate(name: string): Promise<void> {
		return this.settingsSvc.deleteTemplate(name);
	}

	/** Make settings effective in the running runtime（流式中则延迟到 agent_end）。 */
	private async applyRuntimeSettings(): Promise<void> {
		return this.settingsSvc.applyRuntime();
	}

	/** 统一工具门控（tool_manage 唯一落点）：按 disabledAgentTools 把目录内工具
	 *  逐个加回/剔除活跃集（工具仍留在注册表，重开可直接加回；live 生效无需
	 *  reload）。session.reload() 与新会话创建都会把 custom 工具加回活跃集，
	 *  所以这两条路径之后都要重放本方法（见 reloadSession/创建处）。 */
	private applyToolGating(session: AgentSession): void {
		applyAgentToolsGating(session, effectiveDisabledAgentTools(this.settingsSvc.current));
		// SDK 的 setActiveToolsByName 只改 agent.state.tools，不派发任何事件——门控后
		// 主动推一次快照，否则快照里的 tools 要等下一个 SDK 事件才对齐（会话空闲时永远
		// 等不到；回归：tests/terminal-smoke-test.mjs「agent exposes persistent terminal tools」）。
		// 只在被门控的就是活跃会话时推（创建早期活跃对话可能还没绑定；创建流程自带快照）。
		const active = this.convs.get(this.activeId);
		if (active && active.session === session) this.flushSnapshot();
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

	/** Server language for this client (issue #91): resolved LIVE from the
	 *  persisted UI locale — "zh" only for zh*; everything else (including
	 *  never-reported) is English. Per-call tool return values read this on
	 *  every invocation, so they follow language switches with no rebuild. */
	getLang(): ServerLang {
		return resolveServerLang(this.stateStore.get(this.clientId).locale);
	}

	/** Persist the browser UI locale (hello.locale / set_locale) and refresh
	 *  lang-aware prompt segments. Reuses the settings reload path, so it is
	 *  streaming-safe (deferred to agent_end mid-run, same as settings). */
	async setLocale(locale: string): Promise<void> {
		const code = locale.trim().slice(0, 16);
		if (!code) return;
		const prev = this.getLang();
		this.stateStore.saveLocale(this.clientId, code);
		if (this.getLang() === prev) return; // same server language — nothing to re-render
		await this.applySettingsReload();
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
			// 轨迹用：暂存本轮任务文本，下一轮 agent_start 消费（steer/内部续跑
			// 不经此处，届时 task 缺省，插件回退为「继续执行」）。
			conv.pendingTask = text.trim() ? truncRun(text.trim(), RUN_TASK_CAP) : undefined;
			// Name the conversation from its FIRST prompt immediately, before any
			// await: the typed text IS the name. The `conv` reference was captured
			// before the try block, so a concurrent switch/new_chat while prompt()
			// is in flight can never rename a DIFFERENT conversation — or miss the
			// rename entirely. A failed send still leaves the name, which matches
			// what the user typed intent-wise; the entry_appended fallback below
			// re-derives it from the persisted transcript when needed.
			if (conv.title === DEFAULT_CONV_TITLE && text.trim() && !conv.session.sessionName?.trim()) {
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
					// issue #91：附件/视觉桥文案按客户端 UI 语言出中英（英文默认）。
					getLang: () => this.getLang(),
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

	/** 手动重试上次失败的模型调用：自动重试次数（retryMaxAttempts）用完后
	 *  本轮已停止并标红，用户点「重试」再触发一轮 LLM 调用。不新增用户气泡——
	 *  用 display:false 的 custom 消息 triggerTurn 续跑，模型基于完整上下文
	 * （含上次报错）继续生成。流式中 / 无可重试失败时只发 notice 拒绝。 */
	async retryLast(): Promise<void> {
		const conv = this.conv;
		try {
			if (this.quiesceBlocked()) return;
			const s = this.session;
			if (s.isStreaming) {
				this.emit({
					type: "notice",
					level: "info",
					text: "对话正在生成中，无需重试",
					textEn: "The conversation is still generating — no need to retry",
				});
				return;
			}
			if (conv.retryState) {
				this.emit({
					type: "notice",
					level: "info",
					text: "正在自动重试中，稍候即可",
					textEn: "Auto-retry is in progress — please wait",
				});
				return;
			}
			// 最后一轮失败的证据：末尾 stopReason=error 的 assistant 消息。
			let failed: { errorMessage?: unknown; stopReason?: unknown } | null = null;
			try {
				const msgs = s.agent.state.messages;
				for (let i = msgs.length - 1; i >= 0; i--) {
					const m = msgs[i] as { role?: unknown; errorMessage?: unknown; stopReason?: unknown };
					if (m.role !== "assistant") continue;
					if ((typeof m.errorMessage === "string" && m.errorMessage.trim()) || m.stopReason === "error") {
						failed = m;
					}
					break;
				}
			} catch {
				// 会话替换中——按无可重试处理
			}
			if (!failed) {
				this.emit({
					type: "notice",
					level: "info",
					text: "没有可重试的失败：上一轮没有报错结束",
					textEn: "Nothing to retry: the last turn did not end with an error",
				});
				return;
			}
			// 轨迹用：下一轮 agent_start 消费（否则插件回退为「继续执行」）。
			conv.pendingTask = "手动重试上次失败的模型请求";
			await s.sendCustomMessage(
				{
					customType: "manual-retry",
					content: [
						{
							type: "text",
							text: "（系统：用户点击了「重试」。请基于完整上下文重新发起上一次失败的模型请求，继续完成用户的任务。）",
						},
					],
					display: false,
				},
				{ triggerTurn: true },
			);
			conv.promptedSinceActive = true;
			conv.lastActiveAt = Date.now();
			conv.lastSdkEventAt = Date.now();
			conv.stallNoticed = false;
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `手动重试失败：${(err as Error).message}`,
				textEn: `Manual retry failed: ${(err as Error).message}`,
			});
		}
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
		// 只移除第一条匹配：气泡 ✕ 对应的是「一条」消息，重复文本不能连带删除
		// （旧实现用值过滤会把所有同文本项一起删掉，与本地显示镜像不一致）。
		const keptSteering = kind === "steer" ? removeFirstOccurrence(steering, text) : steering;
		const keptFollowUp = kind === "followUp" ? removeFirstOccurrence(followUp, text) : followUp;
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
	emitNotice(level: "info" | "warning" | "error", text: string, textEn?: string): void {
		this.emit({ type: "notice", level, text, textEn });
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
			const runtime = await createAgentSessionRuntime(this.makeRuntimeFactory(conv.terminals, undefined, conv.id), {
				cwd: conv.cwd,
				agentDir: this.agentDir,
				sessionManager: SessionManager.continueRecent(conv.cwd),
			});
			conv.runtime = runtime;
			conv.session = runtime.session;
			this.emit({
				type: "notice",
				level: "warning",
				text: reason,
				textEn: `${reason} (forced reset: run did not terminate)`,
			});
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

	/** 新建/切到一个空白对话。返回值 = 「当前活动对话就是一个可以接收首条的
	 *  空白新对话」——/new <prompt> 只在 true 时投递首条提示；false 表示没能进入
	 *  新对话（准入关闭 / 同项目对话数达上限 / runtime 创建失败），此时照发会把
	 *  首条提示投进用户原本正在用的那个对话里。 */
	async newChat(): Promise<boolean> {
		if (this.quiesceBlocked()) return false;
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
			return true;
		}
		for (const conv of this.convs.values()) {
			if (conv.id === this.activeId) continue;
			if (isBlank(conv)) {
				await this.switchConversation(conv.id);
				this.flushSnapshot();
				return true;
			}
		}
		// Cap is per project — conversations of other projects keep their own
		// lists and don't consume this project's slots. Subagents don't count
		// (inMemory 后台任务，不占位）。
		const openInProject = [...this.convs.values()].filter((c) => c.cwd === this.cwd && !c.isSubagent).length;
		if (openInProject >= MAX_OPEN_CONVERSATIONS) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `当前项目运行的对话已达上限（${MAX_OPEN_CONVERSATIONS} 个），请先打开某个对话并离开（不继续对话）以移出列表`,
				textEn: `This project already has the max open conversations (${MAX_OPEN_CONVERSATIONS}). Open one and leave it (without continuing) to remove it from the list.`,
			});
			return false;
		}
		// The outgoing conversation is left behind — apply the running-list
		// lifecycle. Removal is deferred until the new chat exists so the active
		// conversation stays valid during the (async) runtime creation.
		const displaced = this.displaceActive();
		// Carry the model chosen in the active chat over to the new chat so it
		// doesn't silently revert to the ModelRuntime default model.
		const prevModel = this.conv.session.agent.state.model ?? null;
		let ready = false;
		try {
			const conversationId = this.nextConversationId();
			const terminals = this.makeTerminalManager(conversationId, this.cwd);
			const runtime = await createAgentSessionRuntime(this.makeRuntimeFactory(terminals, undefined, conversationId), {
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
			// 新对话即当前打开 → 插件重拉（轨迹视图跟随）。
			this.notifyConversationChanged();
			ready = true;
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `新建对话失败：${(err as Error).message}`,
				textEn: `Failed to create chat: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
		return ready;
	}

	/**
	 * The active conversation is being left (new_chat / switch_conversation /
	 * set_cwd). Runs the running-list lifecycle:
	 *
	 * - 子代理豁免：活动的是子代理时永远保留（listed=true，返回 null）——点开
	 *   查看后切走也不释放 runtime，后台任务继续跑、随时可点开看；清理走
	 *   dismiss_conversation / dismiss_finished_subagents（用户显式动作）。
	 * - still streaming → it becomes a background run: ensure it is listed;
	 * - idle + listed + continued → keep it (the user did continue it);
	 * - any retained terminal state → keep it listed until the terminals are closed;
	 * - idle + listed + opened-but-not-continued, or never listed at all → the
	 *   caller must drop it (returns it so removal happens only after the
	 *   active conversation has been switched away).
	 */
	private displaceActive(): Conversation | null {
		const conv = this.conv;
		// 子代理不受切换关闭影响（见上）。
		if (conv.isSubagent) {
			conv.listed = true;
			return null;
		}
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
		// 更靠前的阶段：run 本身还在 queued/running（workflow 编排中）时释放
		// runtime 同样杀死扩展宿主并 abort 所有 live workflow controller，比
		// wake 订阅早一步——磁盘 .active-runs marker + status.json 探测（pi-web-ui #52）。
		// Retain while the session has active (queued/running) pi-subagents async
		// runs on disk — the extension host would otherwise be torn down and its
		// workflow controllers aborted mid-flight.
		// Also retain a parent while any live first-party subagent conversation
		// points at it: dropping an idle in-memory parent orphans the child row
		// (the child vanishes from Running Chats with no result available).
		const hasLiveChild = [...this.convs.values()].some((child) => child.parentId === conv.id);
		const retained =
			hasLiveChild ||
			shouldRetainActive({
				reviewing: conv.goal.reviewing,
				wizardRunning: conv.wizardRunning,
				streaming: conv.session.isStreaming,
				openTerminals: conv.terminals.countLive(),
				listed: conv.listed,
				promptedSinceActive: conv.promptedSinceActive,
				hasActiveSubagentRun: () => hasActiveSubagentRun({ sessionId: conv.session.sessionFile }),
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
		// 当前打开对话变了 → 插件重拉（轨迹视图切会话后即刷新，不等轮询）。
		this.notifyConversationChanged();
		this.flushSnapshot();
	}

	/** Push every running conversation across ALL projects to the client. The
	 *  running-conversation list is global so a background run from another
	 *  workspace stays visible; clicking one switches both the conversation and
	 *  its project (see switchConversation). The client groups the list by cwd. */
	private emitConversations(): void {
		const conversations: ConversationSummary[] = [];
		// Active parents are normally absent from Running. Keep them visible while
		// listed subagents hang under them, so both rows remain clickable.
		const visibleParents = new Set(
			[...this.convs.values()]
				.filter((conv) => conv.listed)
				.map((conv) => conv.parentId)
				.filter(Boolean),
		);
		for (const conv of this.convs.values()) {
			if (!conv.listed && !visibleParents.has(conv.id)) continue;
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
				isSubagent: !!conv.isSubagent,
				// 子代理带 error 标记：左栏红点提示（普通对话不参与）。
				...(conv.isSubagent ? this.subagentRunOutcome(conv) : {}),
				parentId: conv.parentId,
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
		const infos = await SessionManager.list(this.cwd, piSessionsRoot());
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
				const infos = await SessionManager.list(this.cwd, piSessionsRoot());
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
						textEn: stillRunning
							? "Conversation is still running in the background; delete aborted — wait for it to finish and retry"
							: "Could not switch to another conversation; delete cancelled",
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

	/** Rename a persisted session by appending a session_info entry — the same
	 *  mechanism pi's /name uses (SessionManager.appendSessionInfo). Works on
	 *  any transcript under the sessions root, live or not; no session switch. */
	async renameSession(path: string, name: string): Promise<void> {
		try {
			const trimmed = (name ?? "").trim();
			if (!trimmed) return;
			const abs = resolve(path);
			const sessionsRoot = resolve(this.agentDir, "sessions");
			if (!abs.startsWith(sessionsRoot + sep)) {
				this.emit({
					type: "notice",
					level: "error",
					text: "只能重命名会话目录中的对话记录",
					textEn: "Only transcripts inside the session directory can be renamed",
				});
				return;
			}
			const mgr = SessionManager.open(abs);
			mgr.appendSessionInfo(trimmed);
			this.setConversationTitleForFile(abs, trimmed);
			this.invalidateSessionInfos();
			await this.refreshSessions();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `重命名会话失败：${(err as Error).message}`,
				textEn: `Failed to rename session: ${(err as Error).message}`,
			});
		}
	}

	/** Rename a live conversation by id: retitle in memory AND persist a
	 *  session_info entry to its transcript so History matches immediately. */
	async renameConversation(id: string, name: string): Promise<void> {
		try {
			const trimmed = (name ?? "").trim();
			if (!trimmed) return;
			const conv = this.convs.get(id);
			if (!conv) return;
			conv.title = trimmed;
			try {
				const file = conv.session.sessionFile;
				if (file !== undefined) SessionManager.open(resolve(file)).appendSessionInfo(trimmed);
			} catch {
				// in-memory title still updated; transcript write is best-effort
			}
			this.emitConversations();
			this.invalidateSessionInfos();
			await this.refreshSessions();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `重命名对话失败：${(err as Error).message}`,
				textEn: `Failed to rename conversation: ${(err as Error).message}`,
			});
		}
	}

	/** Point every live conversation holding this transcript file at a new title. */
	private setConversationTitleForFile(abs: string, title: string): void {
		let changed = false;
		for (const conv of this.convs.values()) {
			const file = conv.session.sessionFile;
			if (file !== undefined && resolve(file) === abs) {
				conv.title = title;
				changed = true;
			}
		}
		if (changed) this.emitConversations();
	}

	/** Dismiss 口径的「已结束子代理」：非 streaming 且无保留态（存活终端/
	 *  审查/后台唤醒等），与 dismissFinishedSubagents 的候选口径一致。 */
	private isDismissableFinishedSubagent(conv: Conversation): boolean {
		let streaming = true;
		try {
			streaming = conv.session.isStreaming;
		} catch {
			// 会话替换中——按运行中处理，绝不误删。
		}
		if (streaming) return false;
		return !shouldRetainActive({
			reviewing: conv.goal.reviewing,
			wizardRunning: conv.wizardRunning,
			streaming: false,
			openTerminals: conv.terminals.countLive(),
			listed: false,
			promptedSinceActive: false,
			hasActiveSubagentRun: () => hasActiveSubagentRun({ sessionId: conv.session.sessionFile }),
			hasPendingWake: () => hasPendingWaitSubscription({ sessionId: conv.session.sessionFile }),
		});
	}

	/** Dismiss a running conversation from the left-panel list without deleting its
	 *  transcript file. Only idle (non-streaming) conversations that are not
	 *  retained by terminal/wake/review state can be dismissed. The session stays
	 *  in history and can be reopened.
	 *
	 *  withFinishedSubagents=true 时连带关闭该对话下已结束的子代理（传递后代，
	 *  与 dismissFinishedSubagents 同口径；active 的子代理跳过）——只关不运行的：
	 *  运行中的后代不受影响；关完后若还有后代剩下（运行中/保留中/active），父级
	 *  暂留并提示。只有运行中的后代（无可关的）时拒绝。不传 + 存在已结束子代理
	 *  后代时拒绝并提示（由前端确认框先问用户，避免静默 orphan）。 */
	async dismissConversation(id: string, withFinishedSubagents?: boolean, force?: boolean): Promise<void> {
		const conv = this.convs.get(id);
		if (!conv) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "该对话不存在或已关闭",
				textEn: "This conversation does not exist or is already closed",
			});
			return;
		}
		if (!conv.listed) {
			// Not in list anyway — nothing to do.
			this.emitConversations();
			return;
		}
		// Streaming / retained conversations refuse dismissal — mirrors displaceActive retention.
		// 运行中的子代理后代也阻止关闭（绝不连带 abort）；已结束的子代理后代：
		// withFinishedSubagents 才连带，否则拒绝并提示（前端确认框先问用户）。
		const isStreaming = (c: Conversation): boolean => {
			try {
				return c.session.isStreaming;
			} catch {
				return true;
			}
		};
		const descendants = collectSubagentDescendantIds(
			[...this.convs.values()].map((c) => ({ id: c.id, parentId: c.parentId, isSubagent: c.isSubagent })),
			id,
		)
			.map((did) => this.convs.get(did))
			.filter((c): c is Conversation => !!c);
		if (force) {
			await this.forceDismissConversation(conv, descendants, isStreaming);
			return;
		}
		const runningKids = descendants.filter((c) => isStreaming(c));
		// 父对话自身的保留态（流式/终端/审查/后台唤醒）——子代理后代另算。
		const selfStreaming = (() => {
			try {
				return conv.session.isStreaming;
			} catch {
				return true;
			}
		})();
		if (selfStreaming) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `对话「${conv.title}」仍在运行中，请先等待结束或点击停止后再移出`,
				textEn: `Conversation "${conv.title}" is still running — wait for it to finish or press Stop before removing`,
			});
			return;
		}
		if (conv.terminals.countLive() > 0) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `对话「${conv.title}」还有未关闭的终端，请先关闭终端后再移出`,
				textEn: `Conversation "${conv.title}" still has open terminals — close them before removing`,
			});
			return;
		}
		if (
			shouldRetainActive({
				reviewing: conv.goal.reviewing,
				wizardRunning: conv.wizardRunning,
				streaming: false,
				openTerminals: 0,
				listed: conv.listed,
				promptedSinceActive: conv.promptedSinceActive,
				hasActiveSubagentRun: () => hasActiveSubagentRun({ sessionId: conv.session.sessionFile }),
				hasPendingWake: () => hasPendingWaitSubscription({ sessionId: conv.session.sessionFile }),
			})
		) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `对话「${conv.title}」暂时无法移出（存在待处理的后台任务/审查）`,
				textEn: `Conversation "${conv.title}" cannot be removed right now (pending background task/review)`,
			});
			return;
		}
		const finishedKids = descendants.filter(
			(c) => c.listed && c.id !== this.activeId && this.isDismissableFinishedSubagent(c),
		);
		if (runningKids.length > 0 && finishedKids.length === 0) {
			// 只有运行中的后代：连 flag 也变不出可关的，拒绝（绝不连带 abort）。
			this.emit({
				type: "notice",
				level: "warning",
				text: `对话「${conv.title}」还有 ${runningKids.length} 个运行中的子代理，请先等待结束或停止后再移出`,
				textEn: `Conversation "${conv.title}" still has ${runningKids.length} running subagent(s) — wait for them to finish or stop them before removing`,
			});
			return;
		}
		if (finishedKids.length > 0 && !withFinishedSubagents) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `对话「${conv.title}」下还有 ${finishedKids.length} 个已结束的子代理：连带关闭请确认，仅关闭父级请先在右键菜单清理子代理`,
				textEn: `Conversation "${conv.title}" still has ${finishedKids.length} finished subagent(s): confirm to dismiss them together, or clear the subagents first (right-click menu) to dismiss only the parent`,
			});
			return;
		}
		// 只关不运行的：运行中的后代绝不连带 abort；关完后若还有后代剩下
		// （运行中/保留中/active），父级暂留并提示。
		let removedKids = 0;
		for (const kid of finishedKids) {
			if (kid.id === this.activeId) continue;
			if (this.convs.get(kid.id) !== kid) continue;
			this.removeConversation(kid.id);
			removedKids++;
		}
		if (withFinishedSubagents && removedKids > 0) {
			const remaining = descendants.filter((c) => this.convs.get(c.id) === c);
			if (remaining.length > 0) {
				const stillRunning = remaining.filter((c) => isStreaming(c)).length;
				this.emit({
					type: "notice",
					level: "info",
					text: `已关闭 ${removedKids} 个已结束的子代理，还有 ${remaining.length} 个子代理未关闭${stillRunning > 0 ? `（${stillRunning} 个运行中）` : ""}，父对话暂留`,
					textEn: `Dismissed ${removedKids} finished subagent(s); ${remaining.length} subagent(s) remain${stillRunning > 0 ? ` (${stillRunning} running)` : ""}, keeping the parent`,
				});
				this.emitConversations();
				this.flushSnapshot();
				return;
			}
		}
		// Dismissing the ACTIVE conversation: move active elsewhere first
		// (another listed conversation, else a fresh chat), then remove.
		if (id === this.activeId) {
			const vacated = await this.vacateActive(id);
			if (!vacated) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `当前对话「${conv.title}」暂时无法移出（无法创建接替对话）`,
					textEn: `Cannot dismiss the active conversation "${conv.title}" right now (no replacement chat available)`,
				});
				this.emitConversations();
				this.flushSnapshot();
				return;
			}
		}
		this.removeConversation(id);
		this.emitConversations();
		this.flushSnapshot();
	}
	/** Move the active marker away from id so that conversation can be removed.
	 *  Prefers another listed conversation; falls back to creating a fresh chat.
	 *  Returns true when id is no longer active. */
	private async vacateActive(id: string): Promise<boolean> {
		if (id !== this.activeId) return true;
		const other = [...this.convs.values()].find((c) => c.id !== id && c.listed);
		if (other) {
			await this.switchConversation(other.id);
		} else {
			await this.newChat();
		}
		return this.activeId !== id;
	}
	/** 强行关闭：中止自身运行（如在跑）与全部子代理后代（运行中的也停），
	 *  再整体移出；终端/审查/后台唤醒等保留态一并放行。active 的目标先让出
	 *  active（vacateActive），active 的后代跳过、让出后再补移。 */
	private async forceDismissConversation(
		conv: Conversation,
		descendants: Conversation[],
		isStreaming: (c: Conversation) => boolean,
	): Promise<void> {
		const title = conv.title;
		let stopped = 0;
		for (const d of descendants) {
			if (d.id === conv.id) continue;
			if (this.convs.get(d.id) !== d) continue;
			if (isStreaming(d)) {
				try {
					await this.subagentHost.stopSubagent(d.id);
					stopped++;
				} catch {
					// best effort — removal below disposes the runtime anyway.
				}
			}
		}
		let selfAborted = false;
		if (isStreaming(conv)) {
			selfAborted = true;
			await this.interruptRun(conv, "已强行关闭");
		}
		let removedKids = 0;
		const deferred: Conversation[] = [];
		for (const d of descendants) {
			const cur = this.convs.get(d.id);
			if (!cur || cur.id === conv.id) continue;
			if (cur.id === this.activeId) {
				deferred.push(cur);
				continue;
			}
			this.removeConversation(cur.id);
			removedKids++;
		}
		if (conv.id === this.activeId) {
			const vacated = await this.vacateActive(conv.id);
			if (!vacated) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `对话「${title}」暂时无法强行关闭（无法创建接替对话）`,
					textEn: `Cannot force-dismiss conversation "${title}" right now (no replacement chat available)`,
				});
				this.emitConversations();
				this.flushSnapshot();
				return;
			}
		}
		for (const d of deferred) {
			if (this.convs.get(d.id) === d && d.id !== this.activeId) {
				this.removeConversation(d.id);
				removedKids++;
			}
		}
		if (this.convs.get(conv.id) === conv && conv.id !== this.activeId) {
			this.removeConversation(conv.id);
		}
		this.emitConversations();
		this.flushSnapshot();
		const remaining = descendants.filter((c) => this.convs.get(c.id) === c).length;
		this.emit({
			type: "notice",
			level: "info",
			text: `已强行关闭对话「${title}」${removedKids > 0 ? `（含 ${removedKids} 个子代理）` : ""}${selfAborted ? "，本轮运行已中止" : ""}${stopped > 0 ? `，${stopped} 个运行中的子代理已中止` : ""}${remaining > 0 ? `；还有 ${remaining} 个子代理未关闭（已切为当前对话）` : ""}`,
			textEn: `Force-dismissed conversation "${title}"${removedKids > 0 ? ` (incl. ${removedKids} subagent(s))` : ""}${selfAborted ? ", its run was aborted" : ""}${stopped > 0 ? `, ${stopped} running subagent(s) stopped` : ""}${remaining > 0 ? `; ${remaining} subagent(s) remain (now active)` : ""}`,
		});
	}
	/** Bulk-dismiss finished subagents (left-panel right-click menu).
	 *
	 *  parentId omitted = every finished subagent in the running list;
	 *  given = the transitive subagent descendants of that conversation
	 *  (children, grandchildren, … — parentId chain followed recursively),
	 *  plus the conversation itself when IT is a finished subagent.
	 *  Finished = idle (not streaming, no retained terminal/review/wake
	 *  state). Running ones are skipped, never aborted. Children are removed
	 *  before parents so the "parent with live children refuses" guard in
	 *  dismissConversation never blocks the batch. The active conversation is
	 *  never removed. */
	async dismissFinishedSubagents(parentId?: string): Promise<void> {
		const root = parentId?.trim() ? parentId.trim() : undefined;
		if (root && !this.convs.has(root)) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "该对话不存在或已关闭",
				textEn: "This conversation does not exist or is already closed",
			});
			return;
		}
		// Collect the subtree: every conversation whose parentId chain leads to
		// root (or every subagent when root is omitted). Child-before-parent
		// order via depth so parents become dismissable as children leave.
		const depthOf = (id: string): number => {
			let d = 0;
			let cur = this.convs.get(id);
			const seen = new Set<string>([id]);
			while (cur?.parentId) {
				if (seen.has(cur.parentId)) break;
				seen.add(cur.parentId);
				d++;
				cur = this.convs.get(cur.parentId);
				if (!cur) break;
			}
			return d;
		};
		const inScope = (conv: Conversation): boolean => {
			if (!conv.isSubagent) return false;
			if (conv.id === this.activeId) return false;
			if (!conv.listed) return false;
			if (!root) return true;
			if (conv.id === root) return true;
			let cur: Conversation | undefined = conv;
			const seen = new Set<string>();
			while (cur?.parentId) {
				if (cur.parentId === root) return true;
				if (seen.has(cur.parentId)) return false;
				seen.add(cur.parentId);
				cur = this.convs.get(cur.parentId);
				if (!cur) return false;
			}
			return false;
		};
		const isStreaming = (conv: Conversation): boolean => {
			try {
				return conv.session.isStreaming;
			} catch {
				return true;
			}
		};
		const candidates = [...this.convs.values()]
			.filter(inScope)
			// Running first would be pointless — drop streaming/retained up front.
			.filter((conv) => !isStreaming(conv))
			.filter(
				(conv) =>
					!shouldRetainActive({
						reviewing: conv.goal.reviewing,
						wizardRunning: conv.wizardRunning,
						streaming: false,
						openTerminals: conv.terminals.countLive(),
						listed: false,
						promptedSinceActive: false,
						hasActiveSubagentRun: () => hasActiveSubagentRun({ sessionId: conv.session.sessionFile }),
						hasPendingWake: () => hasPendingWaitSubscription({ sessionId: conv.session.sessionFile }),
					}),
			)
			.sort((a, b) => depthOf(b.id) - depthOf(a.id));
		if (candidates.length === 0) {
			this.emit({
				type: "notice",
				level: "info",
				text: "没有可关闭的已结束子代理",
				textEn: "No finished subagents to dismiss",
			});
			return;
		}
		let removed = 0;
		let skippedRunning = 0;
		for (const conv of candidates) {
			const cur = this.convs.get(conv.id);
			if (!cur || cur.id === this.activeId) continue;
			if (isStreaming(cur)) {
				skippedRunning++;
				continue;
			}
			// Re-check live children: earlier removals in this same batch may
			// have cleared the guard; still-running children block the parent.
			const liveChild = [...this.convs.values()].some((child) => child.parentId === cur.id && isStreaming(child));
			if (liveChild) {
				skippedRunning++;
				continue;
			}
			this.removeConversation(cur.id);
			removed++;
		}
		this.emitConversations();
		this.flushSnapshot();
		if (removed > 0) {
			this.emit({
				type: "notice",
				level: "info",
				text: `已关闭 ${removed} 个已结束的子代理${skippedRunning > 0 ? `（${skippedRunning} 个仍在运行，已跳过）` : ""}`,
				textEn: `Dismissed ${removed} finished subagent(s)${skippedRunning > 0 ? ` (${skippedRunning} still running, skipped)` : ""}`,
			});
		} else {
			this.emit({
				type: "notice",
				level: "info",
				text: "没有可关闭的已结束子代理（剩余的仍在运行）",
				textEn: "No finished subagents to dismiss (the rest are still running)",
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
			openedRuntime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(openedTerminals, undefined, conversationId),
				{
					cwd: targetCwd,
					agentDir: this.agentDir,
					sessionManager,
				},
			);

			// Only displace the old active conversation after the replacement runtime
			// is known-good. This keeps a failed history open entirely non-destructive.
			const oldListed = this.conv.listed;
			const displaced = this.displaceActive();
			const openInProject =
				[...this.convs.values()].filter((c) => c.cwd === targetCwd && !c.isSubagent).length +
				1 -
				(displaced?.cwd === targetCwd && !displaced?.isSubagent ? 1 : 0);
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
			// 切历史会话成功 → 插件重拉（轨迹视图立即显示该会话时间线）。
			this.notifyConversationChanged();
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
			const all = await SessionManager.listAll(piSessionsRoot());
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

	async makeDir(relPath: string): Promise<void> {
		return this.files.makeDir(relPath);
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
			const { resolve, sep } = await import("node:path");
			this.files.unwatchGit(); // stale repo's watcher must not fire across projects
			const fs = await import("node:fs/promises");
			const trimmed = newCwd.trim();
			if (trimmed === MACHINE_ROOT) {
				// 机器根是虚拟层（盘符列表），不能作工作目录——指引用户选具体目录。
				this.emit({
					type: "notice",
					level: "warning",
					text: "请选择一个具体目录作为工作目录（此电脑本身不是目录）",
					textEn: "Pick a concrete directory as the workspace (This PC itself is not a directory)",
				});
				return;
			}
			// Windows 裸盘符（"C:"）：resolve 会按该盘当前目录解析，必须显式指到盘根；
			// 仅 win32 生效——posix 下 "C:" 仍是普通相对路径，避免误伤同名目录。
			const abs =
				process.platform === "win32" && /^[A-Za-z]:$/.test(trimmed)
					? `${trimmed.toUpperCase()}${sep}`
					: resolve(trimmed);
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
				const newRuntime = await createAgentSessionRuntime(
					this.makeRuntimeFactory(terminals, undefined, conversationId),
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
						this.emit({ type: "notice", level: d.type, text: d.message, textEn: d.message });
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
			// 切项目即换了当前打开对话 → 插件重拉。
			this.notifyConversationChanged();
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

	/** Strip the "(New)" freshness marker some catalogs append to display names
	 *  (pi.dev data, e.g. "DeepSeek V4 Pro (New)") — display-only; the model id
	 *  is untouched so switching still uses the exact official id. */
	private cleanModelDisplayName(name: string): string {
		return name.replace(/\s*\(new\)$/i, "").trim();
	}

	/** List models that have valid authentication configured. */
	async listModels(): Promise<void> {
		try {
			const mr = this.runtime.services.modelRuntime;
			// Reconcile built-in provider catalogs with the official pi.dev
			// endpoint before listing: within the SDK's 4h freshness window this
			// is a fast 304; past it the newest catalog is downloaded WHOLESALE
			// (patch-remote-catalog.ts) — no union merge, no stale built-in
			// leftovers, no "新增 N 个模型" noise. Network failure falls back to
			// the cached catalog silently.
			await mr.refresh({ allowNetwork: true, signal: AbortSignal.timeout(15_000) }).catch(() => {
				// list must never fail because the catalog sync did
			});
			const available = await mr.getAvailable();
			const models = available.map((m) => ({
				id: `${m.provider}/${m.id}`,
				name: this.cleanModelDisplayName(m.name),
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
		const { commands, path, warning, warningEn } = await loadCommands(this.cwd);
		if (warning) {
			this.emit({ type: "notice", level: "warning", text: warning, textEn: warningEn });
		}
		this.emit({ type: "commands", commands, path });
	}

	/** Persist the user command list (.pi/commands.json). */
	async saveCommands(commands: CommandDef[]): Promise<void> {
		const { path, error, errorEn } = await saveCommandsFile(this.cwd, commands);
		if (error) {
			this.emit({ type: "notice", level: "error", text: error, textEn: errorEn });
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
		// 关闭所有挂起的用户提问（dispose 时以「取消」解析，避免模型挂死）。
		this.cancelPendingQuestions();
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
	/** index.ts 注入：运行轨迹事件的插件转发钩子，attach 时拷贝到每个新会话。 */
	onRunEvent: ((ev: PluginRunEvent) => void) | undefined = undefined;
	/** index.ts 注入：对话切换通知钩子，attach 时拷贝到每个新会话。 */
	onConversationChanged: (() => void) | undefined = undefined;
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

	/** 插件用：全客户端最近活跃对话的快照（at 最大者即“当前打开的对话”）。 */
	readConversationForPlugins(): PluginConversationSnapshot | null {
		let best: PluginConversationSnapshot | null = null;
		for (const cs of this.clients.values()) {
			try {
				const s = cs.readConversationForPlugins();
				if (s && (!best || s.at > best.at)) best = s;
			} catch {
				/* 单客户端坏了不影响其他 */
			}
		}
		return best;
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
		/** 托管本实例的平台服务（null = 前台/dev/Docker）——CLI 的
		 *  `server status` 据此显示启动方式，见 launch-origin.ts。 */
		service: UiServiceInfo | null;
	} {
		return {
			pid: process.pid,
			version: VERSION,
			cwd: this.cwd,
			...this.quiesceInfo(),
			connectedClients: this.socketCount,
			activeConversations: this.activeConversations(),
			pendingMessages: this.pendingMessages(),
			service: toServiceInfo(launchOrigin()),
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
		cs.onRunEvent = this.onRunEvent;
		cs.onConversationChanged = () => this.onConversationChanged?.();
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

	/** Browser UI locale report (hello.locale / set_locale): persist per client
	 *  and refresh lang-aware prompts (streaming-safe via ClientSession). */
	async setLocale(clientId: string, locale: string): Promise<void> {
		const cs = this.clients.get(clientId);
		if (cs) {
			await cs.setLocale(locale);
			return;
		}
		// hello race: session still being created — wait for it, then apply.
		const inflight = this.pending.get(clientId);
		if (inflight) {
			try {
				await (await inflight).setLocale(locale);
			} catch {
				/* attach failed — nothing to apply to */
			}
		}
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
