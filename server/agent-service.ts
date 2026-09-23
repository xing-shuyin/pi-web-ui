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
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { appendFileSync, existsSync, readFileSync, rmSync, statSync, mkdirSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createBashToolDefinition,
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
	resolveNpmRegistry,
	sortUpdateItems,
	type UpdateItem,
} from "./update-check.js";
import { hasActiveSubagentRun, hasPendingWaitSubscription, shouldRetainActive } from "./wait-subscription-scan.js";
import {
	COMPACTION_PENDING_TYPE,
	looksLikeChainCorruption,
	makeCompactionMarkerId,
	repairSessionFile,
	type SessionFileRepair,
} from "./compaction-markers.js";
import {
	DANGLING_TOOL_RESULT_TEXT,
	DANGLING_TOOL_RESULT_TEXT_EN,
	findDanglingToolCalls,
	healDanglingToolCallFile,
} from "./dangling-tools.js";
import { removeQueuedByIndexOrText } from "./queue-utils.js";
import type {
	PluginAgentTool,
	PluginChatRequest,
	PluginChatResult,
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
import { FilesService, MACHINE_ROOT, desktopDirWire, workspacePath } from "./files-service.js";
import {
	DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS,
	effectiveToolWatchdogMs,
	isExtensionDisabled,
	isExtensionEnabled,
	normalizeDisabledPluginTools,
	normalizeRetryMaxAttempts,
	normalizeSkillList,
	type PromptMode,
	ClientStateStore,
} from "./client-state.js";
import { bilingual, pick, resolveServerLang, type ServerLang } from "./i18n.js";
import { SubagentTemplatesStore, pickTemplatePrompt, type SubagentTemplate } from "./subagent-templates.js";
import { ComposerDraftsStore } from "./composer-drafts.js";

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
	BROWSER_PAGE_TOOL_NAME,
	effectiveDisabledAgentTools,
	isAgentToolEnabled,
	isTerminalGuidanceOn,
	MARKERS_LIST_TOOL_NAME,
	PRESENT_FILES_TOOL_NAME,
} from "./tool-manager.js";
import { WebUIContext } from "./webui-context.js";
import { DEFAULT_COMPACTION_RESERVE_TOKENS, effectiveSoftCap, softCapToReserve } from "./soft-cap.js";
import { decodeText } from "./text-sniff.js";
import { makeEditSoftTool } from "./edit-soft-tool.js";
// 覆盖 SDK 内置 read：路径是目录时列出目录条目（行为开关 readDirEnabled，默认开）。
import { makeReadDirTool } from "./read-tool.js";
// 展示文件给用户（present_files）：图片/视频内联、文本开预览弹窗、本地打开按钮。
import { makePresentFilesTool } from "./present-files-tool.js";
// 持久代码求值沙箱（eval）：Python / Node.js 沙箱内核。
import { disposeAllEvalKernels, disposeEvalSession, makeEvalTool } from "./eval-tool.js";
// 工具定义说明的归一化（工具卡右键 → 「显示工具详细信息」，见 getToolInfo）。
import { normalizeToolInfo, type RawToolDefinition } from "./tool-info.js";
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
import {
	makeConversationReadTool,
	parseTranscriptLines,
	toTranscriptInput,
	type ConversationReadHost,
	type TranscriptInputMessage,
} from "./conversation-read-tool.js";
import { extractTouches, formatTouchesCompact, intersectTouches } from "./conversation-touches.js";
import { ClaimStore, matchClaims, mergeTouchSidecar, readTouchSidecar, removeTouchSidecar } from "./claim-store.js";
import { makeClaimFilesTool, type ClaimFilesHost } from "./claim-files-tool.js";
import { makeSkillTool, type SkillToolHost } from "./skill-tool.js";
import { makeScheduleTools, type ScheduleToolHost } from "./schedule-agent-tool.js";
import { sameSessionFile, type SchedulerStore } from "./scheduler-tasks.js";
import { buildAttachmentMessages, parseModelSpec } from "./attachments.js";
import { buildVisionBridgePrompt, findVisionModels, transcribeImages } from "./vision-bridge.js";
import { isNotRepoError, scmCommitContext } from "./scm.js";
import { buildCommitMsgInput, buildCommitMsgPrompt, sanitizeCommitMessage } from "./scm-commitmsg.js";
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
	ElsewhereRunning,
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
/** 服务进程所在机器的用户主目录（wire 格式）：进程内不变，模块加载时求值一次，
 *  快照热路径直接引用（右栏 🏠 一键直达，见 protocol.ts 的 UiState.homeDir）。 */
const HOME_WIRE = homedir().replace(/\\/g, "/");
/** 桌面目录（wire 格式）：进程内不变（见 files-service.ts 的 desktopDirWire），
 *  不存在则空串 → 前端不渲染 🖥️。 */
const DESKTOP_WIRE = desktopDirWire(HOME_WIRE);
/** While assistant deltas are flowing, live rendering is carried by
 *  message_delta — full snapshots become pure reconciliation checkpoints, so
 *  send them on a slow event-driven cadence (see flushSnapshot call-sites:
 *  agent_end / tool_execution_end always checkpoint immediately). */
const STREAMING_SNAPSHOT_INTERVAL_MS = 2000;
/** Deltas newer than this keep the streaming (low-frequency) snapshot cadence. */
const DELTA_ACTIVE_WINDOW_MS = 1500;
/**
 * `session.getSessionStats()` 会遍历整份转写，而 `message_delta` 曾经**每一帧**都调它
 * （只为了填 usage）。实测 6000 条转写 × 6002 帧时这一条链占了流式阶段 **27.6%** 的 CPU
 * （2123ms），而一个「最多旧 250ms」的读数对进度条/上下文指示器来说与实时值无法区分。
 * 加这层短缓存后实测流式 CPU 4.859s → 1.328s（3.7×），快照字节数完全不变（issue #259）。
 */
const STATS_CACHE_MS = 250;
const WIDGET_REFRESH_MS = 2000;
/** SCM「AI 生成提交信息」的单次补全超时——慢供应商不该让按钮转圈到天荒地老。 */
const SCM_COMMITMSG_TIMEOUT_MS = 60_000;
/** Model-stall watchdog: warn (don't abort — deep thinking can be legitimately
 *  quiet for minutes) when a streaming run produced NO SDK events for this long.
 *  Covers the failure class the per-tool watchdog cannot see: half-open API
 *  connections / hung proxies where no tool is running and no error is thrown.
 *  Override: PI_WEB_STALL_NOTIFY_MS (milliseconds; 0 disables). */
const STALL_NOTIFY_MS = (() => {
	const v = Number(process.env.PI_WEB_STALL_NOTIFY_MS);
	return Number.isFinite(v) && v >= 0 ? v : 180_000;
})();
/** Serialization-cache soft cap per conversation (see serializeCachedFor /
 *  pruneMessageCache). Cached UiMessage objects are pure-function results, so a
 *  miss only costs a recompute — but a miss on a message that is STILL in the
 *  transcript is not free: it hands back a fresh object identity, which fails
 *  emitSnapshotNow's identity walk and degrades every checkpoint to a full
 *  snapshot (issue #259). Eviction is therefore by "no longer in the
 *  transcript", never FIFO; this constant only says when that sweep runs. */
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
	const tool = createBashToolDefinition(cwd, {
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
	// Keep the SDK definition so execute receives the current session context.
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
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const result = (await tool.execute(
				toolCallId,
				params as { command: string; timeout?: number },
				signal,
				onUpdate,
				ctx,
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
		execute: (id, params, signal, onUpdate, ctx) => {
			const p = params as { persist?: boolean };
			// Windows 下 ConPTY 架构限制（MSYS2 全局控制台上限 128，且高频创建销毁容易句柄耗尽/卡顿）：
			// 一次性命令（persist !== true）走原生 spawn（基于 pipe，无需分配控制台，速度快 60 倍且免死锁，issue #269）；
			// 只有明确需要持久交互（persist === true）才进可见终端 ai-bash。
			const shouldUseTerminal = useTerminal() && (process.platform !== "win32" || p?.persist === true);
			return (shouldUseTerminal ? terminalBacked : killable).execute(id, params as never, signal, onUpdate, ctx);
		},
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

/** 判定是否应当即时向前端推送问卷弹窗（只推给当前前台会话，未指定会话按全局放行）。 */
export function shouldPopQuestion(conversationId: string | undefined, activeId: string): boolean {
	return conversationId === undefined || conversationId === activeId;
}

// ---------------------------------------------------------------------------
// 浏览器页面工具（标准 pi 引擎的 browser_page customTool）
//
// 模型调 browser_page → 服务端发 page_request 给浏览器 → 前端转 page-picker
// 扩展 → 扩展操作目标页面 → 前端回 page_response → 工具结果回到模型。
//
// op 的语义（read/click/type/…）属于**扩展侧**，服务端只透传，不解读也不校验
// ——所以参数说明写在 tool description 里让模型知道怎么用，不在这里分支处理。
// ---------------------------------------------------------------------------

/** timeoutMs 默认值。对面是扩展不是人，超时必须自己兜住。 */
const PAGE_CALL_DEFAULT_TIMEOUT_MS = 30_000;
/** 夹取区间：太小会误杀慢页面（拿不到结果还白跑一趟），太大就把模型拖到
 *  工具看门狗（20 分钟）附近了。 */
const PAGE_CALL_MIN_TIMEOUT_MS = 1_000;
const PAGE_CALL_MAX_TIMEOUT_MS = 120_000;

/** 客户端/扩展回来的页面调用结果（pageCall 的返回值）。失败一律带人话原因，
 *  由工具转成 Error 抛给模型（模型看到 error 才会改变策略）。 */
export type PageCallResult = { ok: true; result?: unknown } | { ok: false; error: string };

/** pageCall 的入参 = 协议 page_request 去掉 id/type（id 由 ClientSession 生成，
 *  type 由 emit 补上）。从 protocol.ts 派生而非手写：契约单源，协议改字段这里
 *  跟着报错。 */
export type PageCallRequest = Omit<Extract<ServerMessage, { type: "page_request" }>, "id" | "type">;

/** timeoutMs 归一：非有限数字/缺省 → 默认；其余夹在 [1000, 120000]。
 *  工具入口与页桥（pageCall）共用，防手写脏值绕过 schema。 */
export function normalizePageCallTimeoutMs(v: unknown): number {
	const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : PAGE_CALL_DEFAULT_TIMEOUT_MS;
	return Math.min(PAGE_CALL_MAX_TIMEOUT_MS, Math.max(PAGE_CALL_MIN_TIMEOUT_MS, n));
}

/** 除 op/target/timeoutMs 外的扁平参数名（保持扩展侧原名：what/selector/…）。
 *  列表即 schema 里的可选字段——改 schema 忘改这里，单测会炸（见
 *  tests/unit/browser-page-tool.test.ts）。 */
const BROWSER_PAGE_ARG_KEYS = ["what", "selector", "text", "url", "code", "all", "index", "maxEdge"] as const;

/** 只收模型**确实传了**的参数：undefined 不入包，否则扩展拿到一堆
 *  `"selector": undefined` 会覆盖自己的默认值。 */
export function collectBrowserPageArgs(params: Record<string, unknown>): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	for (const k of BROWSER_PAGE_ARG_KEYS) {
		if (params[k] !== undefined) args[k] = params[k];
	}
	return args;
}

/** 页面调用结果 → 给模型的文本：字符串原样（read 的正文就是这样，别再加引号），
 *  其余 JSON 缩进；空结果给一句说明，免得模型以为工具没输出。 */
export function formatPageCallResult(result: unknown): string {
	if (typeof result === "string") return result.length > 0 ? result : "(empty)";
	if (result === undefined || result === null) return "(no result)";
	try {
		return JSON.stringify(result, null, 2) ?? String(result);
	} catch {
		// 循环引用/含大整数等不可序列化结果：别让格式化把工具调用炸掉。
		return String(result);
	}
}

/** 失败文本：带上 op 与原因，再补一句**可执行的**下一步（模型只有知道该让
 *  用户干什么，才不会再盲目重试同一个调用）。 */
export function formatBrowserPageError(op: string, error: string): string {
	return [
		`browser_page "${op}" failed: ${error}`,
		`browser_page "${op}" 失败：${error}`,
		'Next: make sure a pi-web-ui page is open with the page-picker extension enabled and paired, then try op:"pages" to see which pages are available. If the target page is not allowed yet, ask the user to allow it in the extension.',
		'下一步：确认 pi-web-ui 页面已打开、page-picker 扩展已启用并与该页面配对，再用 op:"pages" 看有哪些可操作页面；若目标页面尚未授权，请让用户先在扩展里授权。',
	].join("\n");
}

/**
 * 标准 pi 引擎的 browser_page 工具：模型调用时把请求桥到用户浏览器里的
 * pi-web-ui 页面（page_request/page_response 协议），由 page-picker 扩展真正
 * 操作用户授权的页面。
 *
 * 与 ask_user_question 同样以 customTool 注册（标准 SDK 没有这个工具；DSH 引擎
 * 走自己的运行时，也不经此）。写法严格比照 makeAskUserQuestionTool。
 *
 * pageCall 签名同样带 {aborted} 快照而非完整 AbortSignal（customTool 的 execute
 * 信号服务于整个 agent 生命周期，这里只要「已中止即失败」的最小语义）。
 */
export function makeBrowserPageTool(
	clientSession: {
		pageCall: (req: PageCallRequest, sig: { aborted?: boolean }, conversationId?: string) => Promise<PageCallResult>;
		/** 主模型能不能直接看图 —— 决定 `op:"shot"` 是「给图」还是「走视觉桥转写」。
		 *  两者都可选：老测试替身不实现时，截图退化成「看不到图 + 说明原因」。 */
		canSeeImages?: () => boolean;
		transcribeToolImage?: (
			image: { data: string; mimeType: string },
			signal?: AbortSignal,
		) => Promise<{ text?: string; reason?: string }>;
	},
	/** 本 runtime 所属会话（语义与 ask_user_question 的 ownerId 一致）。 */
	ownerId?: string,
): ToolDefinition {
	return {
		name: BROWSER_PAGE_TOOL_NAME,
		label: "Browser page",
		description: [
			'Read or act on a page in the USER\'S OWN browser through the pi-web-ui page-picker extension (the extension talks to this page; the server only forwards the request). Only pages the user has explicitly allowed/paired in that extension can be touched. Call it with op:"pages" first to see which pages are currently available, and use it ONLY when the user asked you to read or operate a web page — never click/type on their pages on your own initiative.',
			"ops (forwarded to the extension as-is, the server does not interpret them):",
			"  pages  — no args; lists the pages you may act on",
			'  read   — { what?: "text" | "html" | "title" | "url" | "query", selector?, all? }',
			"  click  — { selector, index? }",
			"  type   — { selector, text, clear?, submit? } (submit: true presses Enter)",
			"  scroll — { selector?, to?: { x, y }, by?: { x, y } }",
			"  goto   — { url }",
			"  wait   — { selector?, text?, timeoutMs? } waits for the element/text to appear; that timeoutMs is the op's own",
			"  eval   — { code } runs JS inside the page (extension-side switch, off by default)",
			"Op options that are not fields of this tool (e.g. read's `limit`) fall back to the extension's defaults. `target` selects the page by origin when more than one is allowed; `timeoutMs` is how long the SERVER waits for the browser (1000-120000, default 30000) before failing the call.",
		].join("\n"),
		promptSnippet: bilingual(
			"read or operate a page in the user's browser (page-picker extension; allowed pages only)",
			"读取/操作用户浏览器里已授权的页面（page-picker 扩展，仅限已授权页面）",
		),
		promptGuidelines: [
			bilingual(
				"Only use browser_page when the user asked you to read or act on a page in their browser; never click or type on their pages on your own initiative",
				"只在用户明确要求读取/操作浏览器页面时才用 browser_page；不要自作主张去点用户的页面",
			),
			bilingual(
				'Start with op:"pages" to see which pages are available; the target page must already be allowed in the page-picker extension — when it fails, tell the user what to enable instead of retrying blindly',
				'先用 op:"pages" 看有哪些可操作页面；目标页面必须已在 page-picker 扩展里授权——失败时把需要开什么告诉用户，不要盲目重试',
			),
		],
		parameters: Type.Object({
			op: Type.String({
				description:
					"Action name (extension-side): pages | read | click | type | scroll | goto | wait | eval | shot — see the tool description for each op and its options.",
			}),
			target: Type.Optional(
				Type.String({
					description: "Target page origin (e.g. https://example.com). Only needed when several pages are allowed.",
				}),
			),
			what: Type.Optional(
				Type.String({ description: 'For op:read — "text" | "html" | "title" | "url" | "query" (default: text).' }),
			),
			selector: Type.Optional(
				Type.String({ description: "CSS selector, for op:read / click / type / scroll / wait." }),
			),
			text: Type.Optional(
				Type.String({ description: "For op:type — the text to enter; for op:wait — the text to wait for." }),
			),
			url: Type.Optional(Type.String({ description: "For op:goto — the absolute URL to navigate to." })),
			code: Type.Optional(
				Type.String({
					description: "For op:eval — JavaScript to run inside the page (extension-side switch, disabled by default).",
				}),
			),
			all: Type.Optional(
				Type.Boolean({ description: "For op:read — return every match instead of only the first one." }),
			),
			index: Type.Optional(Type.Number({ description: "For op:click — which match to click (default: 0)." })),
			maxEdge: Type.Optional(
				Type.Number({
					description:
						"For op:shot — max size of the longer side in px (320-1568, default 1280). Bigger = more tokens.",
				}),
			),
			timeoutMs: Type.Optional(
				Type.Number({
					description: "How long the server waits for the browser before failing (1000-120000 ms, default 30000).",
				}),
			),
		}),
		execute: async (_id: string, params: unknown, signal: AbortSignal | undefined): Promise<unknown> => {
			const p = (params ?? {}) as Record<string, unknown>;
			const op = typeof p.op === "string" ? p.op.trim() : "";
			if (!op) {
				throw new Error(
					'browser_page requires a non-empty `op` (e.g. "pages", "read", "click").\nbrowser_page 需要非空的 op（如 pages/read/click）。',
				);
			}
			const resolved = await clientSession.pageCall(
				{
					op,
					args: collectBrowserPageArgs(p),
					target: typeof p.target === "string" && p.target.length > 0 ? p.target : undefined,
					timeoutMs: normalizePageCallTimeoutMs(p.timeoutMs),
				},
				{
					aborted: signal?.aborted,
				},
				ownerId,
			);
			if (!resolved.ok) {
				// 抛 Error 而不是回一段失败文本：模型需要看到「工具失败」才会改策略。
				throw new Error(formatBrowserPageError(op, resolved.error));
			}
			const shot = extractShotImage(resolved.result);
			if (!shot) {
				// 工具结果：read 的正文原样给模型，结构化结果 JSON 缩进；details 留 UI/轨迹。
				return {
					content: [{ type: "text", text: formatPageCallResult(resolved.result) }],
					details: { op, args: collectBrowserPageArgs(p), target: p.target, result: resolved.result },
				} as never;
			}
			// 截图：**主模型能看图就直接把图给回去**（当轮就能看到，不用等下一轮）；
			// 看不到图（纯文本模型）就交给视觉桥转写成文字证据 —— 与用户粘贴图片走同一套
			// 选择逻辑与提示词，设置里开着就自动生效，模型侧不需要任何额外配置。
			const where = `${p.target ?? "the page"}${shot.selector ? ` (element ${shot.selector})` : ""}`;
			const caption = [
				`Screenshot of ${where} — ${shot.width ?? "?"}×${shot.height ?? "?"} px.`,
				`页面截图：${where} — ${shot.width ?? "?"}×${shot.height ?? "?"} px。`,
			].join("\n");
			const details = {
				op,
				args: collectBrowserPageArgs(p),
				target: p.target,
				result: { ...(resolved.result as Record<string, unknown>), image: "[image]" },
			};
			if (clientSession.canSeeImages?.() === true) {
				return {
					content: [
						{ type: "text", text: caption },
						{ type: "image", data: shot.data, mimeType: shot.mimeType },
					],
					details,
				} as never;
			}
			const bridged = await clientSession.transcribeToolImage?.(shot, signal);
			const note = bridged?.text
				? `

<vision-bridge>
${bridged.text}
</vision-bridge>`
				: [
						`

（当前模型看不到图片：${bridged?.reason ?? "视觉桥不可用"} —— 可让用户改用支持识图的模型，或在模型配置里加一个支持图片的模型）`,
						`(The current model cannot see images: ${bridged?.reason ?? "vision bridge unavailable"})`,
					].join("\n");
			return {
				content: [{ type: "text", text: caption + note }],
				details,
			} as never;
		},
	} as unknown as ToolDefinition;
}

/**
 * 从扩展的截图结果里取出图片。
 *
 * 扩展回的是 `{ image: { dataUrl, mimeType, width, height }, selector?, rect?, viewport? }`；
 * dataUrl 带 `data:image/jpeg;base64,` 前缀，而模型 API 要的是**纯 base64** —— 剥前缀这一步
 * 很容易忘（忘了就是「图片解析失败」）。
 */
export function extractShotImage(
	result: unknown,
): { data: string; mimeType: string; width?: number; height?: number; selector?: string } | undefined {
	if (!result || typeof result !== "object") return undefined;
	const image = (result as { image?: unknown }).image;
	if (!image || typeof image !== "object") return undefined;
	const src = image as { dataUrl?: unknown; mimeType?: unknown; width?: unknown; height?: unknown };
	if (typeof src.dataUrl !== "string") return undefined;
	const match = /^data:([^;,]+);base64,(.+)$/s.exec(src.dataUrl);
	if (!match) return undefined;
	const selector = (result as { selector?: unknown }).selector;
	return {
		data: match[2],
		mimeType: typeof src.mimeType === "string" && src.mimeType ? src.mimeType : match[1],
		...(typeof src.width === "number" ? { width: src.width } : {}),
		...(typeof src.height === "number" ? { height: src.height } : {}),
		...(typeof selector === "string" && selector ? { selector } : {}),
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
 *
 * 导出给过户载荷类型（TakeoverPayload）用：对话对象本身在会话之间整体搬迁。
 */
export interface Conversation {
	id: string;
	/** Display title: first user prompt (truncated) or the default. */
	title: string;
	/** 这是子代理对话（左栏带「子代理」徽标；inMemory session，不进历史/resume）。 */
	isSubagent: boolean;
	/** 派发它的父对话 id（Running 面板嵌套用；顶层子代理为空）。 */
	parentId?: string;
	/** 子代理类型/角色展示名（explore/implement/review…）。 */
	subagentType?: string;
	/** 派发子代理时的原始 prompt（快照 SubagentSnapshot.prompt 的来源，按
	 *  SUBAGENT_PROMPT_SNAPSHOT_CAP 截断后下发，避免 list  payload 被长 prompt 撑大）。 */
	subagentPrompt?: string;
	/** 子代理模板带非空扩展白名单时为 true：插件/MCP 工具不进该会话（工厂期不注
	 *  册、refreshPluginTools 不补），与 skills/extensionsOverride 的白名单语义对齐。 */
	subagentBarsPluginTools?: boolean;
	/** 子代理最近一次运行报错的文本（快照 error 字段的只读缓存位），消息内容不变 /
	 *  会话重建时保留，避免重复向主对话发 notice（subagentErrorNotified 是去重键）。 */
	subagentError?: string;
	/** 已就当前 subagentError 向主对话发过 notice 的错误文本（去重；文本变化时重置）。 */
	subagentErrorNotified?: string;
	runtime: AgentSessionRuntime;
	session: AgentSession;
	cwd: string;
	createdAt: number;
	/** 触碰 sidecar 节流：上次写入时的消息条数（条数没涨就不写，不在热路径）。 */
	touchSidecarCount?: number;
	/** 真正的「后台运行 / 被保留」标记：被换到后台且仍在跑（或有保留态）时置位，
	 *  再次打开并离开（未继续对话）时清除（并释放 runtime）。
	 *  它在左栏「运行的对话」里的可见性还额外包括「当前对话 + 已经有内容」——
	 *  见 shownInRunningList（#140），那是纯展示口径，不改这个标记的语义。 */
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
	/** #280：转录链悬空标记——forceReset 后修复没落盘（文件被删/只读）时置位，
	 *  后续 prompt 响亮拒绝而不是静默黑洞；修复成功即清除。 */
	transcriptBlocked?: boolean;
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

/** Cap on simultaneously open NON-subagent conversations of ONE project (each keeps a full
 *  runtime alive; conversations of other projects keep their own lists).
 *  子代理不计入：子代理是 inMemory 后台任务，不参与此上限，既不占位也不被此上限拦截。 */
const MAX_OPEN_CONVERSATIONS = 8;
/** 同时存活的子代理上限（按客户端计，含嵌套派生的孙子辈）。每个子代理都是一个完整
 *  runtime + TerminalManager，无上限时 AI 一次并行派发几十个会把服务进程拖垮。
 *  主对话的 8 个上限是按项目计的，子代理按客户端全局计（wait_all 本来就是全局口径）。 */
const MAX_SUBAGENTS = 16;
/** SubagentSnapshot.prompt 下发上限：存的是全量 prompt，快照里只带前 N 字符，
 *  避免 subagent_list 一次把几个长 prompt 全推给模型烧 token。 */
const SUBAGENT_PROMPT_SNAPSHOT_CAP = 2000;
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

/** Guardrail: only transcripts under a sessions root may be opened/deleted/renamed
 *  — never arbitrary files. Two roots count as “a sessions root”, and they must stay
 *  the **same two** the history list reads from (`loadSessionInfos` →
 *  `SessionManager.list(cwd, piSessionsRoot())`):
 *
 *   1. `<agentDir>/sessions/`（SDK 默认的每-cwd 子目录布局）
 *   2. `PI_CODING_AGENT_SESSION_DIR`（扁平「额外会话根」，设了就以它为准扫盘）
 *
 *  只认第 1 条会让设了该变量的用户「历史列得出来、却点不开/删不掉/改不了名」
 *  （列表与打开两边口径不一致）。守卫的意图是「不许开任意文件」，不是「只许开
 *  默认目录下的文件」，所以放宽到两个根仍然成立。
 *  Shared by deleteSession/renameSession/switchSession so the open path cannot
 *  escape the confinement the write paths already enforce. */
export function isInsideSessionsDir(agentDir: string, targetPath: string): boolean {
	const abs = resolve(targetPath);
	const roots = [resolve(agentDir, "sessions")];
	const extra = piSessionsRoot();
	if (extra) roots.push(resolve(extra));
	return roots.some((root) => abs.startsWith(root + sep));
}

/** 会话当前模型的 "provider/id"（无模型时 null；软上限按模型覆盖用，issue #229）。 */
function modelKeyOf(session: { model?: { provider?: unknown; id?: unknown } | null }): string | null {
	const m = session?.model;
	if (!m || typeof m.provider !== "string" || typeof m.id !== "string") return null;
	return `${m.provider}/${m.id}`;
}

/** 会话当前模型的上下文窗口（未知时 0）：live 统计优先，模型定义回落。 */
function contextWindowOf(session: {
	getSessionStats?: () => { contextUsage?: { contextWindow?: unknown } | null };
	model?: { contextWindow?: unknown } | null;
}): number {
	try {
		const live = session?.getSessionStats?.()?.contextUsage?.contextWindow;
		if (typeof live === "number" && live > 0) return Math.floor(live);
	} catch {
		// 会话未就绪 → 回落模型定义。
	}
	const def = (session as { model?: { contextWindow?: unknown } | null })?.model?.contextWindow;
	return typeof def === "number" && def > 0 ? Math.floor(def) : 0;
}

/** issue #145：跨客户端同会话持有者（AgentService.clients 全局查重的结果）。
 *  connected=false = 对端已断开（标签页关了，ClientSession 残留）：
 *  streaming 照拦（后台 run 不随标签页消失），idle 警告不再打扰。 */
export interface SessionOwnerInfo {
	clientId: string;
	title: string;
	cwd: string;
	isStreaming: boolean;
	connected: boolean;
}

/** issue #145：别处在同一项目下正在跑的对话（同项目并行感知用）。 */
export interface ProjectRunnerInfo {
	clientId: string;
	title: string;
	sessionFile?: string;
}

/**
 * 浏览器重启认领（orphan adoption）的候选快照 —— 纯数据，决策逻辑见
 * pickAdoptableOrphan（纯函数，可单测）。live = 还有浏览器连着（sinkCount>0）；
 * pseudo = 插件/调度伪客户端（sink 常驻，不能按浏览器存活判断，永远不参与认领）。
 */
export interface OrphanCandidate {
	id: string;
	live: boolean;
	pseudo: boolean;
	/** 正在跑的对话数（主对话 + 子代理都算）。 */
	streaming: number;
	/** 是否有值得认领的内容（跑着 / 后台挂着 / 有消息历史；纯空白会话不算）。 */
	adoptable: boolean;
	/** 最近活跃时间（各对话 lastActiveAt/lastSdkEventAt 的最大值）。 */
	activity: number;
}

/**
 * 选一个断开的残留会话给新标签认领（纯函数）：
 * - 还有别的在线浏览器（非伪客户端且 live）→ 不认领（新标签是第二块屏，
 *   issue #10 的隔离必须保留，跑着的对话继续走 elsewhere 只读感知）。
 * - 否则在断开 + 非伪 + 有内容的候选中按（streaming 多 → 最近活跃）取最优；
 *   没有返回 null（调用方走正常新建流程）。
 */
export function pickAdoptableOrphan(cands: OrphanCandidate[]): string | null {
	if (cands.some((c) => !c.pseudo && c.live)) return null;
	let best: OrphanCandidate | null = null;
	for (const c of cands) {
		if (c.pseudo || c.live || !c.adoptable) continue;
		if (!best || c.streaming > best.streaming || (c.streaming === best.streaming && c.activity > best.activity)) {
			best = c;
		}
	}
	return best?.id ?? null;
}

/** 手动过户时跟着对话一起搬走的等答复问卷（id 在目标会话重排）. */
export interface TakeoverQuestion {
	resolve: (value: QuestionAnswer[] | null) => void;
	questions: UiQuestion[];
	conversationId: string;
}

/** 手动过户时跟着对话一起搬走的页调用（id/计时器在目标会话重建）. */
export interface TakeoverPageCall {
	resolve: (r: PageCallResult) => void;
	req: PageCallRequest;
	timeoutMs: number;
	conversationId: string;
}

/** 手动过户载荷：对话对象（含 runtime/终端/队列/缓存）整体搬迁 + 桥接中的问卷/页调用. */
export interface TakeoverPayload {
	convs: Conversation[];
	questions: TakeoverQuestion[];
	pageCalls: TakeoverPageCall[];
}

/** 同项目判定（纯函数）：调度视口回退与 id 唤醒的 cwd 护栏用。
 *  Windows 大小写/分隔符差异归一，空串永不相等。 */
export function sameCwd(a: string, b: string): boolean {
	const x = String(a ?? "").trim();
	const y = String(b ?? "").trim();
	if (!x || !y) return false;
	const norm = (s: string): string => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	if (norm(x) === norm(y)) return true;
	try {
		return norm(resolve(x)) === norm(resolve(y));
	} catch {
		return false;
	}
}

export class ClientSession {
	readonly clientId: string;
	/** Set by AgentService.attach: reflects the SERVICE-wide quiesce flag
	 *  (server draining — new work rejected). Default false for direct use. */
	isQuiesced: () => boolean = () => false;
	cwd: string;
	/** 当前项目的额外工作区根（宿主侧多根，见 protocol 的 set_workspace_roots）——
	 *  按 cwd 存在 client-state 里，这里只存一份内存缓存给快照热路径读。 */
	private roots: string[] = [];
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
	/** index.ts 经 AgentService 注入：内置调度存储（定时任务 Agent 工具用；未注入时工具直接报错）。 */
	schedulerStore: SchedulerStore | undefined = undefined;
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
		persist?: boolean,
	): Promise<string> {
		// 数量上限先行：每个子代理都是完整 runtime + TerminalManager，无上限时一次
		// 并行派发几十个会把服务进程拖垮。持久化普通对话则受项目会话上限限制。
		if (persist) {
			const baseCwdForLimit = parentId ? (this.convs.get(parentId)?.cwd ?? this.cwd) : this.cwd;
			const resolvedCwdForLimit = cwd ? resolve(baseCwdForLimit, cwd) : baseCwdForLimit;
			const openInProject = [...this.convs.values()].filter(
				(c) => c.cwd === resolvedCwdForLimit && !c.isSubagent,
			).length;
			if (openInProject >= MAX_OPEN_CONVERSATIONS) {
				throw new Error(
					pick(
						this.getLang(),
						`目标项目运行的普通对话已达上限（${MAX_OPEN_CONVERSATIONS} 个），无法创建持久化对话。请先关闭不需要的对话，或以轻量子代理（persist=false）方式运行`,
						`The project already has max open regular conversations (${MAX_OPEN_CONVERSATIONS}). Please close some or run as a lightweight subagent (persist=false)`,
						"agent.conv.limit.reached",
						{ limit: MAX_OPEN_CONVERSATIONS },
					),
				);
			}
		} else {
			const liveSubagents = [...this.convs.values()].filter((c) => c.isSubagent).length;
			if (liveSubagents >= MAX_SUBAGENTS) {
				throw new Error(
					pick(
						this.getLang(),
						`子代理数量已达上限（${MAX_SUBAGENTS} 个），请先用 subagent_wait_all 等一部分完成、或用 subagent_stop 停掉不需要的再派发`,
						`Subagent limit reached (${MAX_SUBAGENTS} live). Wait for some with subagent_wait_all or stop unneeded ones with subagent_stop before spawning more`,
						"agent.subagent.limit.reached",
						{ limit: MAX_SUBAGENTS },
					),
				);
			}
		}
		// 真正的派发者（withSubagentOwner 按 runtime 归属填入）：cwd 基准 / 跟随模型 /
		// 跟随思考强度一律读它，而不是派发瞬间的 active——后台对话产出时用户可能正
		// 看着别的项目，读 active 会跟错模型、把相对 cwd 解析到错误的项目下。
		const spawner = parentId ? this.convs.get(parentId) : undefined;
		const spawnerSession = spawner?.session ?? this.session;
		const baseCwd = spawner?.cwd ?? this.cwd;
		// 相对 cwd 按派发者所在目录解析：直接透传会相对 server 进程 cwd 落到别处。
		const resolvedCwd = cwd ? resolve(baseCwd, cwd) : baseCwd;
		const conversationId = persist ? `conv-${randomUUID().slice(0, 8)}` : `sa-${randomUUID().slice(0, 8)}`;
		const terminals = this.makeTerminalManager(conversationId, resolvedCwd);
		const sessionManager = persist ? SessionManager.create(resolvedCwd) : SessionManager.inMemory(resolvedCwd);
		const runtime = await createAgentSessionRuntime(this.makeRuntimeFactory(terminals, apply, conversationId), {
			cwd: resolvedCwd,
			agentDir: this.agentDir,
			sessionManager,
		});
		const conv = this.makeConversation(runtime, conversationId, terminals);
		conv.isSubagent = !persist;
		// 父对话 = 真正派发它的会话（按会话归属的 host 包装填入）。直接用 active
		// 会错：后台对话运行时用户可能正看着别的项目对话，孩子会被记到无关
		// 对话名下、沉到别的项目组底部（issue #95）。缺省才回退到 active。
		conv.parentId = parentId ?? this.activeId ?? undefined;
		conv.subagentType = type;
		conv.subagentPrompt = prompt;
		// 插件工具门与模板扩展白名单对齐：白名单非空时插件/MCP 工具（无 SDK
		// extensionKey 身份）不进该会话。工厂期 customTools 不注册 + 下面的
		// syncPluginTools 不回补，模板热改不影响已运行的子代理（与 prompt/技能一致）。
		conv.subagentBarsPluginTools = !!apply && apply.enabledExtensions.length > 0;
		conv.listed = true;
		conv.title = subagentTitle(prompt);
		this.convs.set(conv.id, conv);
		// 子代理会话同样订阅 SDK 事件：否则 onEvent 永不触发，点开查看时没有
		// message_delta 流式增量、快照也不刷新，只能靠切走切回时的 flushSnapshot
		// 看到新内容（dismiss/释放流程本来就会 unsubscribe，不泄漏）。
		conv.unsubscribe = conv.session.subscribe((event) => this.onEvent(conv, event));
		// 子代理不走 bindSession——这里同样注入面板的重试次数覆盖。
		this.applyRetryOverrides();
		// 软上限覆盖同样重放（子代理跟随主对话的压缩阈值，issue #229）。
		this.applyCompactionOverrides();
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
			: spawnerSession.model
				? `${spawnerSession.model.provider}/${spawnerSession.model.id}`
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
					// 按子代理自己的目录恢复（跨目录派发时派发者的密钥不一定适用）。
					await this.restoreKeyForModel(followModel, resolvedCwd);
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
		// 思考强度：模板指定则固定用它，否则跟随派发者当前强度（与「跟随派发者模型」
		// 同一取数源：spawnerSession）。所以子代理默认与派发者一致，而不是默默回到
		// SDK 默认档位。放在换模型之后：setModel 会按模型能力重算强度，我们先让它
		// 算完再覆盖。不传 persist：只影响这个子代理会话，不动全局默认强度；模型不
		// 支持的档位由 SDK 自动收敛（reasoning:false 的模型只能是 off）。
		const thinkingLevel = apply?.thinkingLevel?.trim() || spawnerSession.thinkingLevel;
		if (thinkingLevel) {
			try {
				conv.session.setThinkingLevel(thinkingLevel as Parameters<AgentSession["setThinkingLevel"]>[0]);
			} catch (err) {
				// 强度不合法/会话未就绪都不阻断运行（沿用当前档位）。
				this.emit({
					type: "notice",
					level: "warning",
					text: `子代理思考强度设置失败（将按当前档位运行）：${thinkingLevel}（${(err as Error).message}）`,
					textEn: `Failed to set subagent thinking level, keeping the current one: ${thinkingLevel} (${(err as Error).message})`,
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
		if (persist) {
			this.pushProjects().catch(() => {});
		}
		this.emitConversations();
		return conv.id;
	}

	private getSubagentSnapshot(convId: string): SubagentSnapshot | undefined {
		const conv = this.convs.get(convId);
		if (!conv?.session) return undefined;
		return this.toSubagentSnapshot(conv);
	}

	private listSubagentSnapshots(scope?: "all" | "subagent" | "persistent"): SubagentSnapshot[] {
		return [...this.convs.values()]
			.filter((c) => {
				const isPersisted = !c.isSubagent;
				if (scope === "subagent") return c.isSubagent;
				if (scope === "persistent") return isPersisted;
				return c.isSubagent || Boolean(c.parentId) || Boolean(c.subagentPrompt);
			})
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((c) => this.toSubagentSnapshot(c));
	}

	private toSubagentSnapshot(conv: Conversation): SubagentSnapshot {
		const streaming = conv.session.isStreaming;
		const { error, canceled } = this.subagentRunOutcome(conv);
		// state 如实反映终态：之前 canceled 的子代理报的也是 done，只能靠独立 flag
		// 分辨。"queued" 保留给未来（排队调度），当前 spawn 即运行，无排队态。
		const state: SubagentState = streaming ? "running" : canceled ? "canceled" : "done";
		let messageCount = 0;
		try {
			messageCount = conv.session.getSessionStats().totalMessages;
		} catch {
			// session being replaced — report defaults
		}
		const fullPrompt = conv.subagentPrompt ?? "";
		const sm = (conv.session as unknown as { sessionManager?: { isPersisted?: () => boolean } }).sessionManager;
		const isPersisted = !conv.isSubagent || (typeof sm?.isPersisted === "function" && sm.isPersisted());
		return {
			convId: conv.id,
			type: conv.subagentType ?? "general",
			title: conv.title,
			prompt:
				fullPrompt.length > SUBAGENT_PROMPT_SNAPSHOT_CAP
					? `${fullPrompt.slice(0, SUBAGENT_PROMPT_SNAPSHOT_CAP)}\n… [truncated]`
					: fullPrompt,
			state,
			streaming,
			error,
			canceled,
			messageCount,
			model: conv.session.model?.id,
			output: conv.session.getLastAssistantText() ?? "",
			parentId: conv.parentId,
			persisted: isPersisted,
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
		// 技能名录指纹观测（只打日志，不干预组装；预览与 run 共用此入口，
		// 变化才记一行，首轮静默）。用未注文的目录（fill 前），全文注入不影响指纹。
		this.noteSkillCatalogDigest(src.skills);
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
		spawnSubagent: (prompt, type, cwd, templateName, model, parentId, persist) => {
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
			return this.spawnSubagentConversation(prompt, type, cwd, tpl, model, parentId, persist);
		},
		getSubagent: (convId) => this.getSubagentSnapshot(convId),
		listSubagents: (scope) => this.listSubagentSnapshots(scope),
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
		getWatchdogTimeoutMs: () => this.getBaseToolWatchdogTimeoutMs(),
		// issue #91：子代理工具返回按客户端 UI 语言出中英（英文默认）。
		lang: () => this.getLang(),
		// 只向 AI 暴露 enabled 的模板（停用的对 AI 不可见）。
		listTemplates: () =>
			this.subagentTemplates
				.list()
				.filter((t) => t.enabled)
				.map((t) => ({
					name: t.name,
					description: t.description,
					descriptionEn: t.descriptionEn,
					model: t.model,
					thinkingLevel: t.thinkingLevel,
				})),
		isTemplateUsable: (name) => {
			const t = this.subagentTemplates.get(name);
			return !!t && t.enabled;
		},
	};

	/** schedule_* 工具的数据宿主：全局调度存储＋创建时刻 live 的 cwd/活动对话。
	 *  issue #231：同时快照 owner 对话的落盘会话文件（压缩/重启后稳定），触发时
	 *  先按 sessionFile 认同一会话（内存对话 id 重启即失效，不可单独做持久键）。 */
	private scheduleToolHost(): ScheduleToolHost {
		return {
			store: () => this.schedulerStore,
			cwd: () => this.cwd,
			activeConversationId: () => this.activeId,
			conversationInfo: (id?: string) => {
				try {
					const target = (id ?? "").trim() ? this.convs.get((id ?? "").trim()) : this.convs.get(this.activeId);
					if (!target) return undefined;
					let sessionFile = "";
					try {
						sessionFile = String(target.session.sessionFile ?? "");
					} catch {
						sessionFile = "";
					}
					return { cwd: target.cwd ?? this.cwd, sessionFile };
				} catch {
					return undefined;
				}
			},
		};
	}

	/** conversation_read 工具的数据宿主：读本客户端的 conversation 体系 +
	 *  落盘会话目录。运行中对话按 id（实时消息，含未落盘的）；历史按 path，
	 *  且必须是会话列表里的路径（任意文件不给读）。跨标签页的实时运行不在
	 *  this.convs 里——以落盘历史为准（工具 description 会告诉模型）。 */
	private conversationReadHost(): ConversationReadHost {
		return {
			listRunningConversations: () => {
				const out: {
					id: string;
					title: string;
					cwd: string;
					messageCount: number;
					isStreaming: boolean;
					isSubagent: boolean;
					parentId?: string;
				}[] = [];
				for (const c of this.convs.values()) {
					let messageCount = 0;
					let isStreaming = false;
					try {
						messageCount = c.session.getSessionStats().totalMessages;
						isStreaming = c.session.isStreaming;
					} catch {
						// 会话替换中——报默认值
					}
					out.push({
						id: c.id,
						title: c.title,
						cwd: c.cwd,
						messageCount,
						isStreaming,
						isSubagent: !!c.isSubagent,
						...(c.parentId ? { parentId: c.parentId } : {}),
					});
				}
				return out;
			},
			readRunningConversation: (id) => {
				const c = this.convs.get(id);
				if (!c) return undefined;
				// 取数与并行提醒的触碰集同一路径（convTranscript），不另起读取逻辑。
				return { title: c.title, cwd: c.cwd, isSubagent: !!c.isSubagent, messages: this.convTranscript(c) };
			},
			listHistorySessions: async (scope, cwd) => {
				const infos =
					scope === "all"
						? await SessionManager.listAll(piSessionsRoot())
						: await SessionManager.list(cwd || this.cwd, piSessionsRoot());
				return infos.map((s) => ({
					path: s.path,
					name: s.name,
					firstMessage: s.firstMessage,
					messageCount: s.messageCount,
					modified: s.modified.getTime(),
					cwd: s.cwd,
				}));
			},
			readTouchSidecar: (id, path) => {
				// sidecar 让 files/status 在压缩后仍有答案（additive 可选方法：
				// 读不到就回 undefined，调用方回落现算转录 —— 绝不抛错阻塞工具）。
				try {
					if (id) {
						const c = this.convs.get(id);
						let file: string | undefined;
						try {
							file = c?.session.sessionFile ?? undefined;
						} catch {
							file = undefined;
						}
						return readTouchSidecar(file);
					}
					if (path) return readTouchSidecar(path);
					return undefined;
				} catch {
					return undefined;
				}
			},
			readHistorySession: async (path) => {
				const all = await SessionManager.listAll(piSessionsRoot());
				const hit = all.find((s) => resolve(s.path) === resolve(path));
				if (!hit) return undefined;
				try {
					if (statSync(hit.path).size > 16 * 1024 * 1024) return undefined;
					const text = readFileSync(hit.path, "utf8");
					return {
						title: hit.name || hit.firstMessage,
						cwd: hit.cwd,
						sessionPath: hit.path,
						messages: parseTranscriptLines(text),
					};
				} catch {
					return undefined;
				}
			},
		};
	}

	/** claim_files 工具的数据宿主：owner 口径同 subagent/skill（本 runtime 所属会话）。
	 *  常驻注册、不进 AGENT_TOOL_CATALOG（例外：目录工具必须有设置页行，见
	 *  settings-tool-rows.test.ts，而 web/src 正被并行任务占用；advisory 工具常驻
	 *  默认开可接受，目录项 + 设置行等 web/src 空出来后补）。 */
	private claimToolHost(ownerId?: string): ClaimFilesHost {
		const target = (): Conversation | undefined => {
			try {
				return (ownerId ?? "").trim() !== "" ? this.convs.get(ownerId!.trim()) : this.convs.get(this.activeId);
			} catch {
				return undefined;
			}
		};
		return {
			cwd: () => target()?.cwd ?? this.cwd,
			self: () => {
				const t = target();
				return { convId: t?.id ?? this.activeId, title: t?.title ?? "" };
			},
			store: () => this.getClaimStore?.(),
		};
	}

	/** skill 工具的数据宿主：读所属会话 loader 的实时技能表 + 主会话禁用集过滤
	 * （与 skillsOverride 主会话语义一致）。ownerId 语义同 browser_page（本
	 * runtime 所属会话，不是派发瞬间的 active）。失败回空目录，不抛错。 */
	private skillToolHost(ownerId?: string): SkillToolHost {
		return {
			listSkills: () => {
				try {
					const target =
						(ownerId ?? "").trim() !== "" ? this.convs.get(ownerId!.trim()) : this.convs.get(this.activeId);
					const all = target?.session.resourceLoader.getSkills().skills ?? [];
					const disabled = new Set(this.settingsSvc.current.disabledSkills);
					return all
						.filter((s) => !disabled.has(s.name))
						.map((s) => ({
							name: s.name,
							description: s.description ?? "",
							filePath: (s as { filePath?: string }).filePath ?? "",
						}));
				} catch {
					return [];
				}
			},
		};
	}

	/** 技能名录指纹（sha256 over name+description，非正文）：变化才打一行日志，
	 * 首轮静默。只观测不干预组装（digest 第一步：日志；复用以后再说）。 */
	private lastSkillCatalogDigest = "";

	private noteSkillCatalogDigest(skills: { name: string; description: string }[]): void {
		const d = createHash("sha256")
			.update(skills.map((s) => `${s.name}\n${s.description}`).join("\n"))
			.digest("hex")
			.slice(0, 16);
		if (d === this.lastSkillCatalogDigest) return;
		const prev = this.lastSkillCatalogDigest;
		this.lastSkillCatalogDigest = d;
		if (prev) console.log(`[skills] catalog digest ${prev}→${d} (${skills.length} skills)`);
	}
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
	/** Short-lived `getSessionStats()` memo — see STATS_CACHE_MS. Keyed by the
	 *  session instance so a conversation switch never serves the previous one. */
	private sessionStatsCache: {
		at: number;
		session: AgentSession;
		value: ReturnType<AgentSession["getSessionStats"]>;
	} | null = null;
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
	/** 未发送输入框草稿（全局共享，<dataDir>/composer-drafts.json，按 sessionId 键入，见 server/composer-drafts.ts）。 */
	private readonly drafts: ComposerDraftsStore;
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

	// -----------------------------------------------------------------------
	// 浏览器页面桥（标准 pi 引擎的 browser_page customTool）：模型调工具 → 发
	// page_request 给浏览器 → 前端转 page-picker 扩展 → page_response 回到这里
	// resolve 工具结果。
	//
	// 与用户提问桥的关键差别：对面是**程序**（扩展）而不是人，所以必须有超时——
	// 前端没开/扩展没装时不会有人来答，无限等只会把模型卡死；也因此它**不进**
	// 看门狗豁免（见 tool_execution_start 的注释），就是一件普通工具。
	// -----------------------------------------------------------------------
	private pageSeq = 0;
	/** 待回页面请求（id → resolve 与计时器）。同上，一次正常只有一个
	 *  （agent 阻塞在工具执行）；conversationId 仅存档用于诊断（页请求不进快照，
	 *  协议 page_request 也没有这个字段）。 */
	private pendingPageCalls = new Map<
		string,
		{
			resolve: (r: PageCallResult) => void;
			timer: ReturnType<typeof setTimeout>;
			conversationId?: string;
			/** 过户重发 page_request 用（op/args/target）. */
			req: PageCallRequest;
			timeoutMs: number;
		}
	>();

	private constructor(clientId: string, cwd: string, agentDir: string, stateStore: ClientStateStore) {
		this.clientId = clientId;
		this.cwd = cwd;
		this.agentDir = agentDir;
		this.stateStore = stateStore;
		this.roots = stateStore.getWorkspaceRoots(clientId, cwd);
		this.subagentTemplates = new SubagentTemplatesStore(join(stateStore.dataDir, "subagent-templates.json"));
		this.drafts = new ComposerDraftsStore(join(stateStore.dataDir, "composer-drafts.json"));
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
					// （含重试次数覆盖）——依次重放：重试覆盖 → 软上限覆盖 → 终端门控。
					this.applyRetryOverrides();
					this.applyCompactionOverrides();
					// reload() 会把 custom 工具重新加回活跃集——重放终端开关。
					this.applyToolGating(this.session);
					await this.pushSlashCommands();
				},
				applyRetryOverrides: () => this.applyRetryOverrides(),
				applyCompactionOverrides: () => this.applyCompactionOverrides(),
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
			onOAuthActivated: (provider) => this.stateStore.deleteProviderEverywhere(provider),
		});
		// Prune dead background tasks every 30s (only spawns netstat/lsof while
		// the list is non-empty). unref: must not keep the process alive.
		this.bg.start();
	}

	static async create(
		clientId: string,
		cwd: string,
		stateStore: ClientStateStore,
		opts?: { blank?: boolean; blankTitle?: string; idleHeld?: boolean },
	): Promise<ClientSession> {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();

		const cs = new ClientSession(clientId, cwd, agentDir, stateStore);
		const conversationId = cs.nextConversationId();
		const terminals = cs.makeTerminalManager(conversationId, cwd);
		// Resume the most recent session for this project — the SDK default
		// per-project dir (<agentDir>/sessions/--<cwd>--/, shared with the
		// pi CLI/TUI) — or start a fresh one on first visit.
		// issue #145: opts.blank = 跳过恢复（最近那条在别处跑着），直接空白新对话。
		// issue #235：坏转录（重复压缩标记成环）修一次再试，否则整项目首屏
		// "Failed to initialize session"。
		const opened = await cs.openManagerAndRuntime(
			() => (opts?.blank ? SessionManager.create(cwd) : SessionManager.continueRecent(cwd)),
			(m) =>
				createAgentSessionRuntime(cs.makeRuntimeFactory(terminals, undefined, conversationId), {
					cwd,
					agentDir,
					sessionManager: m,
				}),
			async () => (await SessionManager.list(cwd))[0]?.path,
		);
		const runtime = opened.runtime;
		if (opened.repair) {
			for (const n of cs.transcriptRepairNotices(opened.repair)) cs.pendingNotices.push(n);
		}
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
		// issue #145：因别处仍持有而跳过恢复 —— 首帧即被告之（pendingNotices 随 attachSink 下发）。
		// 跑着/空闲都拦：直接恢复会造出第二个写者（两边轮流发送分叉历史）。
		if (opts?.blank && opts?.blankTitle) {
			cs.pendingNotices.push(
				opts.idleHeld
					? {
							type: "notice",
							level: "info",
							text: `该项目最近的对话「${opts.blankTitle}」在另一处开着（当前空闲），为你停在了空白新对话 —— 可在左栏「运行的对话」里把它过户过来继续看，或从历史对话里打开（只留一处发送消息，否则历史分叉）。`,
							textEn: `The most recent conversation ("${opts.blankTitle}") is still open in another window (currently idle), so you landed on a blank chat instead — take it over from Running chats (tagged "Elsewhere") or reopen it from History (send new messages from only one place, or the history will fork).`,
						}
					: {
							type: "notice",
							level: "info",
							text: `该项目最近的对话「${opts.blankTitle}」正在另一处运行，为你停在了新对话 —— 直接打开会造出第二个写者。左栏「运行的对话」里能看到它（标着“另一处”），等它跑完再打开。`,
							textEn: `The most recent conversation ("${opts.blankTitle}") is running in another window, so you landed on a new chat instead — opening it here would create a second writer. It is listed under Running chats (tagged "Elsewhere"); open it after it finishes.`,
						},
			);
		}
		await cs.bindSession();
		// 同步全局默认模型至 SDK settingsManager（若 settings.json 尚未写入），防底层 session 创建时 findInitialModel 兜底回退硬编码模型
		const globalDefault = stateStore.getDefaultModel();
		if (globalDefault) {
			const slash = globalDefault.indexOf("/");
			if (slash > 0 && slash < globalDefault.length - 1) {
				const p = globalDefault.slice(0, slash);
				const id = globalDefault.slice(slash + 1);
				try {
					if (!cs.session.settingsManager.getDefaultModel()) {
						cs.session.settingsManager.setDefaultModelAndProvider(p, id);
					}
				} catch {
					/* 会话未就绪时忽略 */
				}
			}
		}
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
		initialModel?: Parameters<AgentSession["setModel"]>[0],
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
										const tplPrompt = pickTemplatePrompt(apply, this.getLang()).trim();
										if (apply.promptMode !== "replace" || !tplPrompt) return undefined;
										const boundary = event.systemPrompt.indexOf("\n\nAvailable tools:");
										// 边界串是 SDK 提示词的内部格式：版本一变就可能对不上。
										// 对不上时不再静默回退默认 persona（模板等于没生效），而是把模板
										// 提示词前置拼接——角色约束仍在，只是灵魂段没被精确替换。
										if (boundary === -1) {
											const fallback = `${tplPrompt}\n\n${event.systemPrompt}`;
											return fallback === event.systemPrompt ? undefined : { systemPrompt: fallback };
										}
										const swapped = tplPrompt + event.systemPrompt.slice(boundary);
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
			// 桥接工具目标（问卷 / 页面）：每次调用都解析「现在谁持有这条对话」，
			// 而不是认这个 runtime 是在哪个 ClientSession 里建出来的（过户会换主）。
			// anchor 在拿到 created.session 后回填（SDK 的 runtime.session 就是它）。
			const bridgeAnchor: { session?: AgentSession } = {};
			const bridge = this.bridgeTarget(bridgeAnchor, ownerId);

			// 为全新会话（0 条消息的空白对话/新对话）提前解析目标模型并注入，
			// 避免 SDK findInitialModel 在无 model 时回退到内置硬编码默认（如 deepseek-v4-pro）：
			let sessionModel: Parameters<AgentSession["setModel"]>[0] | undefined = initialModel;
			if (!sessionModel) {
				const isBlank = sessionManager.buildSessionContext().messages.length === 0;
				if (isBlank) {
					const savedModelId =
						this.stateStore.getProjectModel(this.clientId, effectiveCwd) ?? this.stateStore.getDefaultModel();
					if (savedModelId) {
						const slash = savedModelId.indexOf("/");
						if (slash > 0 && slash < savedModelId.length - 1) {
							const p = savedModelId.slice(0, slash);
							const id = savedModelId.slice(slash + 1);
							const found = services.modelRuntime.getModel(p, id);
							if (found) {
								try {
									await this.restoreKeyForModel(savedModelId, effectiveCwd);
									if (services.modelRuntime.hasConfiguredAuth(p)) {
										sessionModel = found;
									}
								} catch {
									/* 密钥恢复失败则由 SDK 自行解析 */
								}
							}
						}
					}
				}
			}

			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				model: sessionModel,
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
					// 覆盖 SDK 内置 read（customTools 按 name 覆盖）：路径是目录时列出目录
					// 条目（复用 SDK ls 的排序/`/` 后缀/截断口径），其余情况原样转发内置实现。
					// 开关是行为开关（read 本体不可关），每次调用实时读设置——不进
					// tool-manager 的 ActiveSet 目录。DSH 引擎无 customTool 注册面，不接。
					makeReadDirTool(effectiveCwd, {
						dirEnabled: () => this.settingsSvc.current.readDirEnabled !== false,
						getLang: () => this.getLang(),
					}),
					// 不覆盖内置 edit 的独立宽松编辑工具（缩进不敏感匹配；开关看设置）。
					makeEditSoftTool(effectiveCwd, () => this.getLang()),
					// 插件注册的 AI 工具（创建时刻的实时快照，已按 disabledPluginTools 过滤；
					// 后续注册经 refreshPluginTools 动态补入已有会话）。
					// 子代理模板带非空扩展白名单时不注入：插件/MCP 工具没有 SDK extensionKey
					// 身份、无法参与白名单匹配，全放行等于白名单没关门，全收编才符合「只加载这些」。
					// 空白名单 = 跟随主会话（插件工具照常进入子代理）。
					...(apply && apply.enabledExtensions.length > 0 ? [] : this.enabledPluginToolDefs()),
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
					makeAskUserQuestionTool(bridge, ownerId),
					// 浏览器页面工具：模型调用 → page_request 给浏览器 → page-picker 扩展
					// 操作用户授权的页面 → page_response 回来。ownerId 语义同上（本 runtime
					// 所属会话，不是派发瞬间的 active）。
					makeBrowserPageTool(bridge, ownerId),
					// 别的对话读取（运行中含子代理 + 历史转录，只读）：用户引用了别的
					// 对话（引用 chip / 粘过来的 id / “看看之前那个对话”）时用。子代理
					// 会话同样注册了它，可自然嵌套读取。不需要 ownerId——读的是本
					// 客户端的 conversation 体系与落盘历史，与派发者无关。
					// extras 认领表：files/status 顺带展示（AgentService 级共享）。
					makeConversationReadTool(this.conversationReadHost(), () => this.getLang(), {
						listClaims: (cwd) =>
							(this.getClaimStore?.().list(cwd) ?? []).map((c) => ({
								path: c.path,
								ownerTitle: c.ownerTitle,
								...(c.note ? { note: c.note } : {}),
							})),
					}),
					// 文件认领（claim_files）：开关走统一工具 tab（ActiveSet 门控）。
					// ownerId 语义同 subagent/skill（本 runtime 所属会话）。
					// DSH 引擎无 customTool 注册面，不接（提醒里照样能看到认领）。
					makeClaimFilesTool(this.claimToolHost(ownerId), () => this.getLang()),
					// 展示文件给用户（present_files，issue #231）：模型给路径清单，服务端
					// 只做只读探测（stat + 未知扩展嗅探 + 文本摘录），结构化 items 走 tool
					// result 的 details 下发，前端渲染成图片/视频内联 + 预览/本地打开/
					// 在文件夹中显示/下载/复制路径的卡片。不打开任何窗口，系统级动作
					// 一律由用户点卡片触发（file_open_default / file_reveal）。
					// 开关走统一工具 tab（ActiveSet 门控；enabled 兜底只做报错文案）。
					// DSH 引擎无 customTool 注册面，不接。
					makePresentFilesTool(effectiveCwd, {
						enabled: () =>
							isAgentToolEnabled(PRESENT_FILES_TOOL_NAME, effectiveDisabledAgentTools(this.settingsSvc.current)),
						getLang: () => this.getLang(),
					}),
					// 技能全文按名加载（名录在 {{skills}} 段）：模型不再拼路径调 read。
					// 子代理会话同样注册（owner 即真正派发的父对话，读该会话 loader）。
					// DSH 引擎无 customTool 注册面，不接。开关走统一工具 tab。
					makeSkillTool(this.skillToolHost(ownerId), () => this.getLang()),
					// 定时唤醒三件套（schedule_task/list/cancel，issue #193）：默认绑定
					// 发起对话（ownerId，无则活动对话），到期 steer 语义唤醒它；子代理
					// 会话同样注册（owner 即真正派发的父对话）。开关走统一工具 tab。
					// DSH 引擎无 customTool 注册面，不接。
					...makeScheduleTools(this.scheduleToolHost(), ownerId, () => this.getLang()),
					// 持久代码求值沙箱（eval）：开关走统一工具 tab（ActiveSet 门控，默认关）。
					// ownerId 绑定当前会话；DSH 引擎无 customTool 注册面，不接。
					makeEvalTool({
						cwd: effectiveCwd,
						ownerId,
						lang: () => this.getLang(),
					}),
				],
			});
			// 桥接工具归属锚点：SDK 会话对象在本 runtime 生命周期内稳定，过户只搬对话
			// 不改它（见 ClientSession.findConversationHome）。
			bridgeAnchor.session = created.session;
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
			// A brand-new conversation is not yet LISTED — it enters the running
			// list only when it is displaced to the background while still
			// streaming (its runtime is what `listed` protects). A blank chat is
			// also kept out of the left panel's running list; it shows up there as
			// soon as it has content while it is the active chat — see
			// shownInRunningList (#140).
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
	 *  so the next attach can reopen them and continue their runs. */
	streamingSummaries(): { title: string; cwd: string; sessionFile?: string }[] {
		const out: { title: string; cwd: string; sessionFile?: string }[] = [];
		for (const conv of this.convs.values()) {
			if (!conv.session.isStreaming) continue;
			let sessionFile: string | undefined;
			try {
				sessionFile = conv.session.sessionFile ?? undefined;
			} catch {
				sessionFile = undefined;
			}
			out.push({ title: conv.title, cwd: conv.cwd, sessionFile });
		}
		return out;
	}

	/** Reopen sessions interrupted by the last restart and continue them.
	 *
	 *  For each record WITH a session file: reopen it (listed, keeps running
	 *  when displaced) and send a short Continue prompt so the run resumes
	 *  from the persisted context. Records WITHOUT a file fall back to the
	 *  warning notice. The conversation active before the resume is restored
	 *  at the end, so the user lands where they were and clicks whichever
	 *  resumed run they want — nothing steals the view.
	 *
	 *  Called once on the first attach after a restart (fire-and-forget from
	 *  the attach path — each step is internally guarded and never throws). */
	async resumeInterrupted(
		list: { title: string; cwd: string; at: number; sessionFile?: string }[] | undefined,
	): Promise<void> {
		if (!list || list.length === 0) return;
		const resumable = list.filter((r) => r.sessionFile);
		const orphaned = list.filter((r) => !r.sessionFile);
		if (orphaned.length > 0) {
			const names = orphaned.map((r) => `「${r.title}」（${r.cwd}）`).join("、");
			this.emit({
				type: "notice",
				level: "warning",
				text: `上次服务重启时有 ${orphaned.length} 个进行中的对话被中断且无法自动恢复：${names}。可在历史对话中手动恢复继续。`,
				textEn: `${orphaned.length} running conversation(s) were interrupted by the last restart and could not be resumed automatically: ${names}. Resume them manually from History.`,
			});
		}
		if (resumable.length === 0) return;
		const continueText = this.getLang() === "zh" ? "继续" : "Continue";
		const restoreId = this.activeId;
		for (const r of resumable) {
			try {
				this.emit({
					type: "notice",
					level: "info",
					text: `上次服务重启中断了「${r.title}」，正在自动恢复并继续。`,
					textEn: `Restart interrupted "${r.title}" — reopening it and continuing automatically.`,
				});
				await this.switchSession(r.sessionFile!);
				await this.prompt(continueText);
			} catch {
				// switchSession/prompt already surface failures as notices;
				// one bad session must not block the rest.
			}
		}
		// Hand the view back: the user lands where they were, resumed runs
		// keep going in the background list.
		try {
			if (restoreId && this.convs.has(restoreId) && restoreId !== this.activeId) {
				await this.switchConversation(restoreId);
			}
		} catch {
			/* staying on the last resumed session is a fine fallback */
		}
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
		this.modelAdmin.listProviderOAuthFlows();
		// Reconnect: push the global default model (the picker's ★ marker +
		// "set as global default" button state).
		this.pushDefaultModel();
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
		// 软上限覆盖同路重放（新 runtime 的 SettingsManager 是干净的，issue #229）。
		this.applyCompactionOverrides();
		this.scheduleSnapshot();
		this.webUi.refresh();
		this.startWidgetsTimer();
		this.startStallTimer();
	}

	/** Poll extension widgets so TUI-only overlays (e.g. rpiv-todo) stay live.
	 *  Skips the refresh when no widgets are mounted — the common case. */
	private startWidgetsTimer(): void {
		if (this.widgetsTimer) return;
		this.widgetsTimer = setInterval(() => {
			if (!this.disposed && this.webUi.hasWidgets()) this.webUi.refresh();
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

	/** 当前生效的基础工具看门狗超时（毫秒）。0 = 禁用看门狗。
	 *  Hard cap on how long ONE tool call may run before the watchdog aborts the
	 *  session. The SDK bash tool has NO default timeout, so a command that never
	 *  finishes (servers, watchers, infinite loops) would otherwise hang the whole
	 *  conversation indefinitely. 优先取设置面板「工具」页的
	 *  ClientSettings.toolWatchdogTimeoutMs（逐 run 实时读取，无需 reload）；
	 *  未设时回落 PI_WEB_TOOL_TIMEOUT_MS 环境变量，再回落默认 20 分钟。 */
	getBaseToolWatchdogTimeoutMs(): number {
		const fromSettings = this.settingsSvc.current.toolWatchdogTimeoutMs;
		if (typeof fromSettings === "number" && Number.isFinite(fromSettings) && fromSettings >= 0) {
			return fromSettings;
		}
		return DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS;
	}

	/** Arm the hang-guard for a tool call: if it is still running after
	 *  TOOL_WATCHDOG_TIMEOUT_MS, abort the session instead of letting the
	 *  conversation hang forever (the SDK bash tool has no default timeout).
	 *  若工具调用显式指定了更长超时（如 bash args.timeout），看门狗自动顺延。 */
	private armToolWatchdog(conv: Conversation, toolCallId: string, toolName?: string, args?: unknown): void {
		const timeoutMs = effectiveToolWatchdogMs(this.getBaseToolWatchdogTimeoutMs(), toolName, args);
		// 0 = 用户显式禁用看门狗（设置面板填 0）。
		if (timeoutMs <= 0) return;
		this.rearmToolWatchdog(conv, toolCallId, timeoutMs, timeoutMs);
	}

	/** （重）布工具挂死看门狗：delayMs 后仍在跑则 abort 整轮。过户时用剩余时间重布
	 *  （已逾期的立即触发，语义不变）. */
	private rearmToolWatchdog(conv: Conversation, toolCallId: string, delayMs: number, totalTimeoutMs?: number): void {
		const totalMs = totalTimeoutMs ?? delayMs;
		const t = setTimeout(
			() => {
				conv.toolWatchdogs.delete(toolCallId);
				// The tool finished before the deadline — nothing to do.
				if (!conv.toolStartTimes.has(toolCallId)) return;
				const durationMin = Math.round(totalMs / 60_000);
				const durationDescZh = durationMin >= 1 ? `${durationMin} 分钟` : `${Math.round(totalMs / 1000)} 秒`;
				const durationDescEn = durationMin >= 1 ? `${durationMin} min` : `${Math.round(totalMs / 1000)}s`;
				this.emit({
					type: "notice",
					level: "warning",
					text: `工具执行超过 ${durationDescZh}，已自动终止（防止挂死）。可调整超时：设置面板「工具」或环境变量 PI_WEB_TOOL_TIMEOUT_MS。`,
					textEn: `Tool ran over ${durationDescEn} and was auto-terminated (hang guard). Tune via Settings -> Tools or PI_WEB_TOOL_TIMEOUT_MS env var.`,
				});
				conv.toolStartTimes.delete(toolCallId);
				// Abort the run (kills the process tree via the SDK's abort signal);
				// agent_end will fire with stopReason "aborted" and existing logic
				// clears any goal / review loop. interruptRun adds a force-reset
				// fallback in case the model stream ignores the abort signal.
				void this.interruptRun(conv, "工具执行超时");
			},
			Math.max(0, delayMs),
		);
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
			const curModel = target.session.model;
			const modelId = curModel ? `${curModel.provider}/${curModel.id}` : undefined;
			return {
				conversationId: target.id,
				title: target.title,
				model: modelId,
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

	/** 插件扩展点 v2（只读组装，供 index.ts 注入给 PluginManager 的 conversationLister）。
	 *  本客户端运行中对话（kind:"running"）+ 当前项目历史会话摘要（kind:"history"，最多 50 条）。
	 *  纯数据组装，不 emit、不改任何状态；历史会话读失败时只回运行中部分。 */
	listRunningForPlugins(): { id: string; title: string; cwd: string; kind: "running"; isStreaming: boolean }[] {
		const out: { id: string; title: string; cwd: string; kind: "running"; isStreaming: boolean }[] = [];
		for (const conv of this.convs.values()) {
			let isStreaming = false;
			try {
				isStreaming = conv.session.isStreaming;
			} catch {
				// 会话替换中——按未跑处理
			}
			out.push({ id: conv.id, title: conv.title, cwd: conv.cwd, kind: "running", isStreaming });
		}
		return out;
	}

	/** 插件扩展点 v2（conversationLister 的历史一半）：当前项目历史会话摘要，最多 50 条。
	 *  复用 refreshSessions/searchSessions 共用的 loadSessionInfos 缓存（3s TTL，不扫两遍盘）。 */
	async listHistoryForPlugins(
		limit = 50,
	): Promise<{ id: string; title: string; cwd: string; kind: "history"; isStreaming: false }[]> {
		try {
			const infos = await this.loadSessionInfos();
			return infos.slice(0, Math.max(0, limit)).map((s) => ({
				id: s.path,
				title: (s.name?.trim() || s.firstMessage.trim() || basename(s.path)).slice(0, 60),
				cwd: this.cwd,
				kind: "history" as const,
				isStreaming: false as const,
			}));
		} catch {
			return [];
		}
	}

	/** 插件扩展点 v2（供 conversationSearcher）：运行中对话标题 + 历史会话全文匹配，返回前 N 个 {id,title}。
	 *  复用 searchSessions 的 sessionMatchesSearch 判定（含转录全文），只读不 emit。 */
	async searchForPlugins(query: string, limit = 20): Promise<{ id: string; title: string }[]> {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		const out: { id: string; title: string }[] = [];
		for (const conv of this.convs.values()) {
			if (conv.title.toLowerCase().includes(q)) out.push({ id: conv.id, title: conv.title });
			if (out.length >= limit) return out;
		}
		try {
			const infos = await this.loadSessionInfos();
			for (const s of infos) {
				if (!sessionMatchesSearch(q, s)) continue;
				out.push({
					id: s.path,
					title: (s.name?.trim() || s.firstMessage.trim() || basename(s.path)).slice(0, 60),
				});
				if (out.length >= limit) break;
			}
		} catch {
			// 读盘失败只回运行中部分
		}
		return out;
	}

	/** 插件扩展点 v2（供 conversationWriter）：向指定对话投递 prompt，复用现有 prompt 投递路径。
	 *  目标非当前对话时先 switchConversation（复用跨项目切换副作用），再走 this.prompt
	 *  （斜杠拦截/排空门禁/并行提醒/首条命名全在里面）；找不到对话返回 {ok:false,error}。 */
	async writeForPlugins(id: string, text: string): Promise<{ ok: boolean; error?: string }> {
		try {
			const conv = this.convs.get(id);
			if (!conv) return { ok: false, error: `未知对话：${id}` };
			if (!text.trim()) return { ok: false, error: "投递文本为空" };
			if (id !== this.activeId) await this.switchConversation(id);
			await this.prompt(text);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	/** 插件扩展点 v2（供 runAborter）：中止指定对话的运行，复用 abort 的 interruptRun 路径
	 *  （abort 卡住/空转时的强制重置语义一并继承）。未在跑时直接 {ok:true}（幂等）。 */
	async abortForPlugins(id: string): Promise<{ ok: boolean; error?: string }> {
		try {
			const conv = this.convs.get(id);
			if (!conv) return { ok: false, error: `未知对话：${id}` };
			if (this.conversationStreaming(conv)) {
				await this.interruptRun(conv, "插件已中止运行");
				this.flushSnapshot();
			}
			return { ok: true };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	/** 插件扩展点（供 runSteerer 跨客户端兜底复用）：只在本客户端 conversations 里找对话，
	 *  持有则执行 steer 并返回结果，未持有回 undefined（不碰钩子，无递归）。 */
	async steerOwnConversation(id: string, text: string): Promise<{ ok: boolean; error?: string } | undefined> {
		const conv = this.convs.get(id);
		if (!conv?.session) return undefined;
		await conv.session.sendUserMessage(text, conv.session.isStreaming ? { deliverAs: "steer" } : undefined);
		return { ok: true };
	}

	/** issue #231：本客户端内按稳定键定位调度唤醒目标。
	 *  sessionFile 优先（压缩/重启后内存对话 id 已变，落盘会话文件才是同一会话）；
	 *  只有没给 sessionFile 时才按内存 id 找，且 id 必须附带 cwd 一致才认 ——
	 *  各客户端计数器都从 c1 开始，跨项目同 id 必然撞车，不校验 cwd 会把巡检
	 *  报告投进完全无关的项目对话。
	 *  excludeIds 用于视口回退时跳过已知的忙对话。 */
	resolveSchedulerTarget(opts: {
		conversationId?: string;
		sessionFile?: string;
		cwd?: string;
		excludeIds?: Set<string>;
	}): Conversation | null {
		const wantFile = String(opts.sessionFile ?? "").trim();
		const wantId = String(opts.conversationId ?? "").trim();
		const wantCwd = String(opts.cwd ?? "").trim();
		const excluded = opts.excludeIds;
		if (wantFile) {
			let best: Conversation | null = null;
			for (const c of this.convs.values()) {
				if (!c?.session || (excluded && excluded.has(c.id))) continue;
				let f = "";
				try {
					f = String(c.session.sessionFile ?? "");
				} catch {
					continue;
				}
				if (!sameSessionFile(f, wantFile)) continue;
				if (!best || c.lastActiveAt > best.lastActiveAt) best = c;
			}
			if (best) return best;
		}
		if (wantId) {
			const c = this.convs.get(wantId);
			if (!c?.session || (excluded && excluded.has(c.id))) return null;
			if (wantCwd && !sameCwd(c.cwd, wantCwd)) return null;
			return c;
		}
		return null;
	}

	/** issue #231：本客户端内同项目的最近活跃对话（视口回退目标）。
	 *  主对话优先（用户正看着的面），没有主对话时才考虑子代理行；
	 *  最近活跃者即用户当前的视口。 */
	findViewportInCwd(cwd: string, excludeIds?: Set<string>): Conversation | null {
		const want = String(cwd ?? "").trim();
		if (!want) return null;
		let best: Conversation | null = null;
		let bestSub: Conversation | null = null;
		for (const c of this.convs.values()) {
			if (!c?.session || (excludeIds && excludeIds.has(c.id))) continue;
			if (!sameCwd(c.cwd, want)) continue;
			if (c.isSubagent) {
				if (!bestSub || c.lastActiveAt > bestSub.lastActiveAt) bestSub = c;
			} else if (!best || c.lastActiveAt > best.lastActiveAt) {
				best = c;
			}
		}
		return best ?? bestSub;
	}

	/** issue #231：带压缩忙检测的调度 steer。压缩进行中时 SDK 直接抛错
	 *  （Cannot submit a prompt while compaction is in progress），调用方据 busy
	 *  另寻视口兄弟或稍后重试，而不是当成“对话不在”静默转无头。 */
	async trySteerScheduler(
		conv: Conversation,
		text: string,
	): Promise<{ ok: true } | { ok: false; busy: boolean; error?: string }> {
		try {
			try {
				if ((conv.session as unknown as { isCompacting?: boolean }).isCompacting === true) {
					return { ok: false, busy: true, error: "上下文压缩进行中，稍后重试" };
				}
			} catch {
				/* 读不到压缩态就直接投递，失败按异常走 */
			}
			await conv.session.sendUserMessage(text, conv.session.isStreaming ? { deliverAs: "steer" } : undefined);
			return { ok: true };
		} catch (err) {
			const msg = String((err as Error)?.message ?? err);
			if (/compaction is in progress/i.test(msg)) return { ok: false, busy: true, error: msg };
			return { ok: false, busy: false, error: msg };
		}
	}

	/** 插件扩展点（供 runSteerer）：向指定对话插队一条用户消息，复用子代理 steer 的
	 *  sendUserMessage + deliverAs:'steer' 路径（运行时插队；未跑时按普通消息投递）。
	 *  先找本客户端 conversations，找不到再经 steerConversationElsewhere 问其他客户端；
	 *  空文本回 {ok:false}；异常 catch 透传 message。 */
	async steerForPlugins(conversationId: string, text: string): Promise<{ ok: boolean; error?: string }> {
		try {
			if (!text.trim()) return { ok: false, error: "空消息" };
			const own = await this.steerOwnConversation(conversationId, text);
			if (own) return own;
			if (typeof this.steerConversationElsewhere === "function") {
				const r = await this.steerConversationElsewhere(conversationId, text);
				if (r) return r;
			}
			return { ok: false, error: `未知对话：${conversationId}` };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	/** 插件扩展点（供 llmProvider）：孤立补全的环境（cwd/agentDir/回落模型）。
	 *  取最近活跃的主对话（跳过子代理）；model 读不到就只给 cwd（调用方再回落默认模型）。
	 *  纯数据组装，不 emit、不改状态。 */
	llmEnvForPlugins(): { cwd: string; agentDir: string; fallbackModel?: { provider: string; id: string } } {
		let target: Conversation | null = null;
		try {
			for (const c of this.convs.values()) {
				if (c.isSubagent) continue;
				if (!target || c.lastActiveAt > target.lastActiveAt) target = c;
			}
			if (!target) {
				for (const c of this.convs.values()) {
					if (!target || c.lastActiveAt > target.lastActiveAt) target = c;
				}
			}
		} catch {
			target = null;
		}
		const cwd = target?.cwd ?? this.cwd;
		let fallbackModel: { provider: string; id: string } | undefined;
		try {
			const m = target?.session?.model as { provider?: string; id?: string } | undefined;
			if (m?.provider && m.id) fallbackModel = { provider: m.provider, id: m.id };
		} catch {
			/* model 读不到就回落默认 */
		}
		return { cwd, agentDir: this.agentDir, ...(fallbackModel ? { fallbackModel } : {}) };
	}

	/** 插件扩展点 v2（供 modelLister）：复用 listModels 的模型列表映射 {id,provider,vision}。
	 *  与 listModels 唯一差别：不做网络 refresh（插件列表走缓存目录，15s 超时也不等），只读不 emit。 */
	async listModelsForPlugins(): Promise<{ id: string; provider: string; vision: boolean }[]> {
		try {
			const available = await this.runtime.services.modelRuntime.getAvailable();
			return available.map((m) => ({
				id: `${m.provider}/${m.id}`,
				provider: m.provider,
				vision: m.input?.includes("image") ?? false,
			}));
		} catch {
			return [];
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
					this.armToolWatchdog(conv, event.toolCallId, event.toolName, event.args);
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
			// 服务端重启会杀死压缩中的 LLM 调用且 compaction_end 永远不会到：
			// 把带时间戳的待处理标记写进会话文件（与 SDK 条目同格式、可追加），
			// 重启后打开该会话时检测到它即报「上次压缩被中断，可重试」，而不是
			// 静默丢失。标记在 compaction_end 到达时删除（正常完成不留痕）。
			case "compaction_start": {
				conv.compactionState = { reason: event.reason, startedAt: Date.now() };
				conv.lastCompactionTokens = null;
				this.markCompactionPending(conv);
				// 进度条只有激活对话看得到（后台对话的快照没有接收方，见 onEvent 末尾）。
				if (conv.id === this.conv.id) this.flushSnapshot();
				break;
			}
			case "compaction_end": {
				this.clearCompactionPending(
					conv,
					event.errorMessage
						? { status: "failed", error: event.errorMessage }
						: event.aborted
							? { status: "cancelled" }
							: event.result
								? {
										status: "completed",
										tokensBefore: event.result.tokensBefore,
										tokensAfter: event.result.estimatedTokensAfter ?? event.result.tokensBefore,
									}
								: undefined,
				);
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
				// 触碰 sidecar 落盘：压缩后旧消息被摘要替代，files 回落现算会丢历史；
				// 条数没涨就不写（不在热路径）；子代理 inMemory 无转录文件，merge 内 no-op。
				try {
					let count = conv.touchSidecarCount ?? -1;
					try {
						count = conv.session.getSessionStats().totalMessages;
					} catch {
						// 会话替换中 —— 按上次条数处理（多半直接跳过）
					}
					if (count !== (conv.touchSidecarCount ?? -1)) {
						conv.touchSidecarCount = count;
						let file: string | undefined;
						try {
							file = conv.session.sessionFile ?? undefined;
						} catch {
							file = undefined;
						}
						void mergeTouchSidecar(file, extractTouches(this.convTranscript(conv)));
					}
				} catch {
					// sidecar 只是加速 + 防压缩丢失，失败了下次重算
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
				// #140：本轮真的开跑了（session.isStreaming 此刻已为 true）—— 左栏
				// 那行的「流式中」标识要立刻亮起来：首条提示词的入列 emit 早于本轮
				// 启动，那时它还是 false；后台对话被唤醒重跑也靠这里刷新。
				this.emitConversations();
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
							const t = this.sessionStats().tokens;
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
		//
		// 只服务**激活对话**（口径同上面的 message_update）：flushSnapshot /
		// scheduleSnapshot 推的都是 this.conv 的整份状态，而这里的事件可能来自后台
		// 对话——运行中的子代理每次 tool_execution_end / agent_end 都会走到这一点。
		// 不按 conv.id 分流 = 子代理的每一次工具调用都替激活对话做一次快照：issue
		// #259 实测 8 子代理 × 5 次 bash → 8 条全量快照共 39.5MB，而激活对话一个
		// 字节都没变。后台对话的内容在切过去时取（switch_session / get_state 强制
		// 全量），它在左栏的运行态由 emitConversations 走另一条通道。
		if (conv.id !== this.conv.id) return;
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

	/** 稳定缓存键 + 该消息的序号种子 n（见 serializeCachedFor）。
	 *
	 *  messagesOf 一次扫描里同时要 key（建 live 集合）与 n（算 user seq），所以
	 *  两者一起返回、只算一次；单独调用的路径不传 key，按需现算。 */
	private uiMessageKey(conv: Conversation, m: AgentMessage): { cacheKey: string; n: number } {
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
		return { cacheKey: `${key}#${n}`, n };
	}

	/** serializeCached 的按对话版本（插件快照读非活跃对话用；缓存仍按对话隔离）。
	 *  key 可由 messagesOf 预计算传入（同一次扫描里它已经算过一遍）。 */
	private serializeCachedFor(
		conv: Conversation,
		m: AgentMessage,
		key?: { cacheKey: string; n: number },
	): UiMessage | null {
		const k = key ?? this.uiMessageKey(conv, m);
		const cached = conv.uiMessageCache.get(k.cacheKey);
		if (cached) return cached;
		// User-message id suffix is a 1-based count of user messages sharing
		// this timestamp (that's what resolveUserMessageEntryId() expects). n is
		// a global per-conversation counter across ALL roles, so it can't be
		// reused as the seq — otherwise editing anything but the first question
		// fails to resolve ("找不到要编辑的消息").
		let seq = k.n;
		if (m.role === "user") {
			const ts = m.timestamp ?? 0;
			seq = (conv.userSeqByTs.get(ts) ?? 0) + 1;
			conv.userSeqByTs.set(ts, seq);
		}
		const msg = serializeMessage(m, seq);
		// 上界在 messagesOf 的 pruneMessageCache 里按 live 集合处理：见那里的注释
		// （FIFO 淘汰仍在转写里的条目会让每次快照都退化成全量，issue #259）。
		if (msg) conv.uiMessageCache.set(k.cacheKey, msg);
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
		// 一次扫描同时收齐「当前转写里的全部缓存键」（live 集合，供
		// pruneMessageCache 精确回收死条目）与各自的序列化结果。
		const live = new Set<string>();
		let rawMessages = conv.session.agent.state.messages
			.map((m) => {
				const k = this.uiMessageKey(conv, m);
				live.add(k.cacheKey);
				return this.serializeCachedFor(conv, m, k);
			})
			.filter((m): m is NonNullable<typeof m> => m !== null);
		// 自动重试等待期：SDK 暂留在 state 末尾的 error 气泡只是中间态（随后被
		// 摘掉重跑），不进快照——成功则用户永远看不到，耗尽才标红。否则 agent_end
		// 的立即 flush 会先画红、摘掉后又消失（红色一闪而过）。
		rawMessages = stripTransientRetryErrors(rawMessages, !!conv.retryState);
		this.pruneMessageCache(conv, live);
		// Reuse the previous array when nothing changed: the element objects are
		// cached (reference-stable) anyway, and a stable array reference lets the
		// frontend memoize derived maps instead of rebuilding them every 60ms.
		const sig = rawMessages.map((m) => m.id).join("\u0001");
		const messages = conv.lastMessagesSig === sig ? conv.lastMessagesArray : rawMessages;
		conv.lastMessagesSig = sig;
		conv.lastMessagesArray = rawMessages;
		return messages;
	}

	/** 序列化缓存上界：**先按「还在转写里」淘汰，绝不为省内存淘汰仍在转写里的条目**。
	 *
	 *  为什么不能 FIFO 淘汰（issue #259 实测的机理）：缓存上限一旦低于转写长度，
	 *  每次快照扫描前缀条目全部 miss → 重新序列化出**新对象**，emitSnapshotNow 的
	 *  identity walk 在 i=0 就失配 ⇒ 每个 checkpoint 都退化成整份全量快照，且每次
	 *  都要重算整份转写（颠簸，成本随转写线性甚至更差）。实测 6000 条转写的激活
	 *  对话 + 8 子代理 × 5 次 bash：40 次工具调用换来 8 条全量快照共 39.5MB，
	 *  `snapshot_delta` 一条都没有。
	 *
	 *  按 live 集合淘汰后：仍在转写里的消息对象恒定（identity walk 命中，增量通路
	 *  恢复），被回收的只有 fork / 压缩 / 换会话留下的死条目 —— 内存上界仍等于
	 *  「当前转写」本身（这份数组本来就要常驻），不再随历史累积。 */
	private pruneMessageCache(conv: Conversation, live: ReadonlySet<string>): void {
		const cache = conv.uiMessageCache;
		// 只有「超上限」且「确实有死条目」时才扫一遍；转写单调增长时这里是零成本。
		if (cache.size <= UI_MESSAGE_CACHE_CAP || cache.size <= live.size) return;
		for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
	}

	/** Build every UiState field EXCEPT messages (the expensive part). */
	private buildLightState(rev: number, withDraft = false): Omit<UiState, "messages" | "rev"> & { rev: number } {
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
			const s = this.sessionStats();
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
							softCap: this.activeSoftCap(cu.contextWindow),
						};
					}
					return {
						tokens: cu.tokens,
						contextWindow: cu.contextWindow,
						percent: cu.percent,
						softCap: this.activeSoftCap(cu.contextWindow),
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
			// 判重：直接读缓存字段，不在快照热路径上重读 client-state。
			workspaceRoots: this.roots,
			// 用户主目录（右栏 🏠）：进程内不变，模块级求值一次，不在热路径调 homedir()。
			homeDir: HOME_WIRE,
			desktopDir: DESKTOP_WIRE,
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
			// 未发送草稿只跟全量快照走（切会话/new_chat/get_state）：增量 delta 里
			// 这个 key 必须整个缺席（不能是显式的 undefined——前端 delta 合并是
			// {...ui, ...d.state} 整批覆盖，显式 undefined 会把上次全量带回的草稿洗掉）。
			...(withDraft ? { draft: this.draftForSnapshot() } : {}),
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
				state: this.buildLightState(rev, false),
			});
		} else {
			this.emittedMessages = cur;
			this.emittedConvId = this.activeId;
			this.emittedRev = rev;
			this.emit({
				type: "snapshot",
				// 全量快照一律带草稿（切会话/new_chat/改写分支/重连 get_state 全走这里）；
				// 60ms 热帧是上面的 snapshot_delta，本来就不带。
				state: { ...this.buildLightState(rev, true), messages: cur },
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

	/**
	 * 桥接工具目标（ask_user_question / browser_page）：**调用瞬间**按 runtime 身份
	 *  解析当前持有它的会话与对话 id，而不是用建 runtime 时捕获的 `this` + ownerId
	 *  （过户会把 runtime 搬到另一个 ClientSession，闭包里的会话引用与 id 都不跟着
	 *  搬 —— 详见 findConversationHome）。
	 *
	 *  工厂（makeAskUserQuestionTool / makeBrowserPageTool）是鸭子类型，只要求这几个
	 *  方法，所以这里给的是一个按需转发的小适配器：工厂传进来的 convId 是**建时**的
	 *  旧 id（过户撞车改名后它要么查不到、要么撞到别的对话），一律以解析结果为准。
	 *  解析不到（未接线 / 会话被替换 / 对话已关闭）时兜底建时的会话与 id —— 与改动前
	 *  行为一致。anchor 由 runtime 创建处在拿到 `created.session` 后回填。
	 */
	private bridgeTarget(anchor: { session?: AgentSession }, ownerId?: string) {
		const home = (): { session: ClientSession; convId: string | undefined } => {
			const found = anchor.session ? this.findConversationHome?.(anchor.session) : undefined;
			return found ?? { session: this, convId: ownerId };
		};
		return {
			askUser: (questions: UiQuestion[], sig: { aborted?: boolean }) => {
				const h = home();
				return h.session.askUser(questions, sig, h.convId);
			},
			pageCall: (req: PageCallRequest, sig: { aborted?: boolean }) => {
				const h = home();
				return h.session.pageCall(req, sig, h.convId);
			},
			// 截图「给图还是走视觉桥」按当前持有方的模型与设置判定（过户后由它驱动）。
			canSeeImages: () => home().session.canSeeImages(),
			transcribeToolImage: (image: { data: string; mimeType: string }, signal?: AbortSignal) =>
				home().session.transcribeToolImage(image, signal),
		};
	}

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
			// 运行列表的「?」角标靠 conversations 推送（问卷登记/解决不经过快照通道）。
			this.emitConversations();
			// 只向目标会话的当前激活端推送弹窗，避免后台问卷污染当前前台会话。
			if (shouldPopQuestion(conversationId, this.activeId)) {
				const conv = conversationId ? this.convs.get(conversationId) : this.conv;
				const conversationTitle = conv?.title;
				this.emit({
					type: "question_pending",
					id,
					questions,
					...(conversationId !== undefined ? { conversationId } : {}),
					...(conversationTitle ? { conversationTitle } : {}),
				});
			}
		});
	}

	/** 前端回答模型提问（question_answer → 恢复 askUser 的 Promise）。id 需匹配
	 *  pendingQuestions 中键；未匹配（对方刚回答/取消、页面刷新重发）静默忽略。
	 *  成功 resolve 后同步推 question_retracted + conversations：本页 live 对话框
	 *  靠前者收起（跨页作答时源页就靠它），别处的「?」角标靠后者即时消失。
	 *  返回是否真的恢复了一个挂起提问（跨页作答的送达回执用）。 */
	resolveQuestion(id: string, answers: QuestionAnswer[], cancelled?: boolean): boolean {
		const pending = this.pendingQuestions.get(id);
		if (!pending) return false;
		this.pendingQuestions.delete(id);
		pending.resolve(cancelled ? null : answers);
		this.emit({ type: "question_retracted", id });
		// 同上：角标消失也要即时推送（否则要等到 run 结束别处才知道问完了）。
		this.emitConversations();
		return true;
	}

	/** 快照侧的待答提问（UiState.pendingQuestion）：只带当前对话的问卷——切回
	 *  原对话会重推快照，对话框随之回来（重连/刷新/第二标签页的恢复通道）。 */
	private pendingQuestionForSnapshot(): UiState["pendingQuestion"] {
		for (const [id, p] of this.pendingQuestions) {
			if (p.conversationId !== undefined && p.conversationId !== this.activeId) continue;
			const conv = p.conversationId !== undefined ? this.convs.get(p.conversationId) : this.conv;
			const conversationTitle = conv?.title;
			return {
				id,
				questions: p.questions,
				...(p.conversationId !== undefined ? { conversationId: p.conversationId } : {}),
				...(conversationTitle ? { conversationTitle } : {}),
			};
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

	/** 取某对话的等答复问卷原文（跨页作答的 peek 用；只读，不改变状态）。 */
	peekPendingQuestion(convId: string): { id: string; questions: UiQuestion[]; conversationTitle?: string } | undefined {
		for (const [id, p] of this.pendingQuestions) {
			if (p.conversationId === convId) {
				const conv = this.convs.get(convId);
				return { id, questions: p.questions, conversationTitle: conv?.title };
			}
		}
		return undefined;
	}

	/** 取某对话的等答复问卷简要信息（用于会话列表与横幅展示）。 */
	private getPendingQuestionForConv(convId: string): { id: string; title?: string } | undefined {
		for (const [id, p] of this.pendingQuestions) {
			if (p.conversationId === undefined || p.conversationId === convId) {
				const q0 = p.questions[0];
				const title = q0?.header?.trim() || q0?.question?.trim() || undefined;
				return { id, title };
			}
		}
		return undefined;
	}

	/** 跨页作答：把别处问卷的原文推给本页弹框（回答经 answerElsewhereQuestion 回去）。 */
	pushElsewhereQuestion(
		owner: string,
		convId: string,
		q: { id: string; questions: UiQuestion[]; conversationTitle?: string },
	): void {
		this.emit({
			type: "elsewhere_question",
			owner,
			convId,
			id: q.id,
			questions: q.questions,
			...(q.conversationTitle ? { conversationTitle: q.conversationTitle } : {}),
		});
	}

	/** 关闭所有挂起提问（dispose 时清理）：以「取消」解析，避免模型挂死。 */
	cancelPendingQuestions(): void {
		for (const [, p] of this.pendingQuestions) {
			p.resolve(null);
		}
		this.pendingQuestions.clear();
	}

	// -----------------------------------------------------------------------
	// 浏览器页面桥（标准 pi 引擎 browser_page customTool）
	// -----------------------------------------------------------------------

	/** 标准引擎模型调 browser_page：发 page_request 给浏览器并等 page_response。
	 *
	 *  与 askUser 的不同点都在超时上：对面是扩展不是人，没人回答时必须自己收场
	 *  （否则就是挂死的工具）。因此 timeoutMs 到点即按失败 resolve，并且：
	 *  - sig.aborted / disposed → 立即失败（会话已中止，发出去也没意义）；
	 *  - 没有前端在线 → 立即给出**可执行**的错误（page_request 不进快照，浏览器
	 *    刷新也不会补发，硬等一个超时对模型毫无信息量）。 */
	/** 当前对话模型能不能直接看图 —— 决定截图是「给图」还是「走视觉桥」。 */
	canSeeImages(): boolean {
		return this.session?.model?.input?.includes("image") === true;
	}

	/**
	 * 把**工具里的截图**交给视觉桥转写（主模型看不到图时）。
	 *
	 * 与用户粘贴图片走同一套选择逻辑（设置里指定的视觉模型 → 自动探测）与同一套提示词，
	 * 所以「视觉桥开着就自动生效」对工具截图同样成立 —— 这里只是多了一个入口，
	 * 不是另立一套判定。
	 *
	 * 失败**不抛**：返回 `{reason}`，由工具把它写进结果文本（模型至少知道「图没看到，为什么」）。
	 */
	async transcribeToolImage(
		image: { data: string; mimeType: string },
		signal?: AbortSignal,
	): Promise<{ text?: string; reason?: string }> {
		const settings = this.settingsSvc.current;
		if (settings.visionBridgeEnabled === false) {
			return { reason: "视觉桥已在设置里关闭（设置 → 视觉桥）" };
		}
		const runtime = this.session?.modelRuntime;
		if (!runtime) return { reason: "拿不到模型运行时" };
		const lang = this.getLang?.() ?? "en";
		let chosen = findVisionModels(runtime)[0] ?? null;
		const pref = settings.visionBridgeModel;
		if (pref) {
			const spec = parseModelSpec(pref);
			if (spec) {
				const pm = runtime.getModel(spec.provider, spec.id);
				if (pm?.input?.includes("image")) {
					chosen = { provider: spec.provider, id: spec.id, label: `${pm.name ?? pm.id} (${spec.provider})` };
				}
			}
		}
		if (!chosen) return { reason: "没有可用的视觉模型（在模型配置里加一个支持图片的模型即可）" };
		const model = runtime.getModel(chosen.provider, chosen.id);
		if (!model) return { reason: "视觉模型已不可用" };
		try {
			const text = await transcribeImages(
				runtime,
				[{ data: image.data, mimeType: image.mimeType, name: "page-shot.jpg" }],
				{
					model,
					...(signal ? { signal } : {}),
					lang,
					systemPrompt: buildVisionBridgePrompt(settings.visionBridgePromptMode, settings.visionBridgePrompt, lang),
				},
			);
			return text.trim() ? { text } : { reason: "视觉桥返回了空转写" };
		} catch (err) {
			return { reason: `视觉桥转写失败：${err instanceof Error ? err.message : String(err)}` };
		}
	}

	/** 页调用超时计时器：到点按失败 resolve（晚到的 page_response 在
	 *  resolvePageCall 里找不到 id 会静默忽略）。过户重建时复用（计时重走）. */
	private armPageCallTimeout(
		id: string,
		resolve: (r: PageCallResult) => void,
		timeoutMs: number,
	): ReturnType<typeof setTimeout> {
		return setTimeout(() => {
			// 到点：先删再 resolve——晚到的 page_response 在 resolvePageCall 里找
			// 找不到 id，会静默忽略（见那里的注释）。
			if (this.pendingPageCalls.delete(id)) {
				resolve({
					ok: false,
					error: `${Math.round(timeoutMs / 1000)} 秒内没有收到浏览器响应（timeout ${timeoutMs}ms）。请确认 pi-web-ui 页面已打开且 page-picker 扩展已启用。`,
				});
			}
		}, timeoutMs);
	}

	pageCall(req: PageCallRequest, sig: { aborted?: boolean }, conversationId?: string): Promise<PageCallResult> {
		return new Promise((resolve) => {
			if (sig?.aborted || this.disposed) {
				resolve({ ok: false, error: "页面调用已中止（browser_page aborted）。" });
				return;
			}
			if (this.sinks.size === 0) {
				resolve({
					ok: false,
					error:
						"没有已连接的 pi-web-ui 页面（no browser connected）。请打开 pi-web-ui 页面，并确认 page-picker 扩展已启用且已与该页面配对。",
				});
				return;
			}
			const id = `p-${++this.pageSeq}`;
			// 夹取与工具入口同一套规则（防手写脏值/其它调用方绕过 schema）。
			const timeoutMs = normalizePageCallTimeoutMs(req.timeoutMs);
			const timer = this.armPageCallTimeout(id, resolve, timeoutMs);
			// 先登记再发：同步回包（同进程假客户端）也不能漏掉。
			this.pendingPageCalls.set(id, { resolve, timer, conversationId, req, timeoutMs });
			this.emit({ type: "page_request", id, op: req.op, args: req.args, target: req.target, timeoutMs });
		});
	}

	/** 前端回页面调用结果（index.ts 的 page_response → cs.resolvePageCall）。
	 *  找不到 id 就静默忽略：那是正常竞态（超时后才迟到、页面刷新后重发、旧链接
	 *  残留），不是错误，也没人能处理。 */
	resolvePageCall(id: string, ok: boolean, result?: unknown, error?: string): void {
		const pending = this.pendingPageCalls.get(id);
		if (!pending) return;
		this.pendingPageCalls.delete(id);
		clearTimeout(pending.timer);
		pending.resolve(
			ok
				? { ok: true, result }
				: { ok: false, error: error?.trim() || "浏览器操作失败（no error message from the page）" },
		);
	}

	/** 关闭所有挂起页面调用（dispose 时）：以失败解析，避免模型/工具挂死。 */
	cancelPendingPageCalls(): void {
		for (const [, p] of this.pendingPageCalls) {
			clearTimeout(p.timer);
			p.resolve({ ok: false, error: "会话已关闭，挂起中的页面调用被取消（conversation closed）。" });
		}
		this.pendingPageCalls.clear();
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
	/** 本客户端成功切换工作区（set_cwd）后触发，参数为新绝对路径 + 该项目的额外
	 *  工作区根（多根由用户/插件经 set_workspace_roots 设置，见 protocol）。
	 *  attach 时由 AgentService 接到全局 onClientCwdChanged —— 编辑器等
	 *  工作区跟随型插件借此把根目录切到用户当前项目。 */
	onCwdChanged: ((abs: string, roots: string[]) => void) | undefined = undefined;
	/** 过户后的桥接投递解析（attach 时由 AgentService 接线）：给一个 SDK 会话（＝
	 *  一个 runtime 的身份），返回**当前**持有它的客户端会话 + 该对话**当前** id。
	 *
	 *  为什么需要它：runtime 创建时把 `this`（当时的 ClientSession）与当时的
	 *  conversationId 闭包进桥接工具（ask_user_question / browser_page），而
	 *  `take_over_conversation` 只搬对话（runtime/终端/订阅/看门狗/在途问卷与页
	 *  调用），搬不动闭包里的会话引用。过户后模型再提问/截图，用捕获的 `this` 就会把
	 *  question_pending / page_request 推给过户前那台设备 —— 持有方收不到，问卷还会
	 *  挂在老设备的注册表里（且不进它的快照：该 conv 已不在它名下）→ 刷新即丢，
	 *  而 pi 引擎问卷不超时，那一轮 run 就永远挂住。
	 *
	 *  用 SDK 会话对象（稳定标识）而不是建时的 conversationId：过户遇到 id 撞车会把
	 *  对话改名（c1→c2），那时旧 id 要么查不到、要么查到老会话里的另一条对话，都会
	 *  投错。（注意不能用 runtime 对象比：SDK 会把工厂返回值包成新的 AgentSessionRuntime
	 *  实例，而 `runtime.session` 与本工厂的 `created.session` 是同一个对象。） */
	findConversationHome:
		((sdkSession: AgentSession) => { session: ClientSession; convId: string } | undefined) | undefined = undefined;
	/** issue #145 跨客户端同会话感知 —— attach 时由 AgentService 接线：
	 *  - findSessionOwner：别处是否已持有同一 session 文件（查重建第二个 writer 用）；
	 *  - listProjectRunners：别处在同一 cwd 下正在跑的对话（同项目并行感知用）；
	 *  - listExternalRunning：别处所有正在跑的对话（左栏「另一处正在运行」用）；
	 *  - notifyExternalClients：向其他客户端广播一条 notice（并行打开时互相通告）；
	 *  - onRunningChanged：本实例流式集合变化时触发，AgentService 借此让其他
	 *    客户端重推 conversations（elsewhere 列表近实时）。 */
	findSessionOwner: ((targetPath: string) => SessionOwnerInfo | null) | undefined = undefined;
	/** 插件 steer 跨客户端兜底钩子：attach 时由 AgentService 接线（见 steerElsewhere），
	 *  在其他客户端的 conversations 里找对话并由持有方执行 steer，未持有回 undefined。 */
	steerConversationElsewhere:
		((id: string, text: string) => Promise<{ ok: boolean; error?: string } | undefined>) | undefined = undefined;
	/** issue #145：除本客户端外是否有人在跑（扫目录查重前置的无 I/O 判断）。 */
	hasStreamingElsewhere: (() => boolean) | undefined = undefined;
	listProjectRunners: ((cwd: string) => ProjectRunnerInfo[]) | undefined = undefined;
	/** issue #145 同款接线：全局认领表（AgentService 级单例，attach 时由 AgentService 接线）。 */
	getClaimStore: (() => ClaimStore) | undefined = undefined;
	listExternalRunning: (() => ElsewhereRunning[]) | undefined = undefined;
	notifyExternalClients:
		| ((msg: { type: "notice"; level: "info" | "warning" | "error"; text: string; textEn?: string }) => void)
		| undefined = undefined;
	onRunningChanged: (() => void) | undefined = undefined;

	/** Ask the npm registry for the latest pi-web-ui version and report it. */
	async checkUpdate(): Promise<void> {
		const current = ClientSession.currentAppVersion();
		try {
			// registry 遵从 <agentDir>/npm/.npmrc（与 `pi update` 经 npm 的行为一致，
			// issue #151）；私有源的 token 也一并带上，否则直接 401。
			const { registry, authHeader } = resolveNpmRegistry(this.agentDir);
			// Fetch the full package doc (not /latest): it carries the per-version
			// publish timestamps so the UI can hint when a version was JUST
			// published and the registry/CDN caches may not have caught up yet.
			const res = await fetch(`${registry}/pi-web-ui`, {
				signal: AbortSignal.timeout(8_000),
				...(authHeader ? { headers: { authorization: authHeader } } : {}),
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
			const targets = collectTargets(this.agentDir, ClientSession.currentAppVersion(), undefined, {
				projectCwd: this.conv?.cwd ?? this.cwd,
			});
			const items = sortUpdateItems(
				await checkAllUpdates(targets, undefined, () => this.getLang(), resolveNpmRegistry(this.agentDir)),
			);
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

	/**
	 * Cached `session.getSessionStats()` — the SDK computes it by walking the whole
	 * transcript, and the message_delta path used to call it per streaming frame
	 * (measured: 27.6% of streaming CPU at 6000 messages, see STATS_CACHE_MS).
	 * Callers that need the authoritative value can still call the session
	 * directly; every cache hit here is at most STATS_CACHE_MS stale.
	 */
	private sessionStats(): ReturnType<AgentSession["getSessionStats"]> {
		const now = Date.now();
		const hit = this.sessionStatsCache;
		if (hit && hit.session === this.session && now - hit.at < STATS_CACHE_MS) return hit.value;
		const value = this.session.getSessionStats();
		this.sessionStatsCache = { at: now, session: this.session, value };
		return value;
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
			// /reload 同样重读磁盘 settings.json——重放重试覆盖 + 软上限覆盖 + 终端门控。
			this.applyRetryOverrides();
			this.applyCompactionOverrides();
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

	/**
	 * 取一条工具的**定义说明**（工具卡右键 → 「显示工具详细信息」）→ `tool_info`。
	 *
	 * 定义从活动会话现取（`getAllTools` 是目录全集，含被禁用的工具），
	 * `getActiveToolNames` 只用来标记「当前是否启用」—— 禁用名单里的工具仍在目录里，
	 * 用户点开看定义是合理的，只是模型看不到它。
	 *
	 * 失败（会话未就绪 / 引擎抛错）一律回 `found: false`：这是只读的展示请求，
	 * 不该因为拿不到定义就在 UI 上报警。
	 */
	getToolInfo(name: string): void {
		let raw: RawToolDefinition | undefined;
		try {
			const defs = this.session.getAllTools();
			const found = defs.find((d) => d.name === name);
			if (found) raw = { ...found, active: this.session.getActiveToolNames().includes(name) };
		} catch {
			// Session not ready (or the engine threw) — fall through to found:false.
		}
		this.emit({ type: "tool_info", ...normalizeToolInfo(name, raw) });
	}

	/** 模型/服务商配置管理 —— 自包含模块，见 model-admin.ts。 */
	private readonly modelAdmin!: ModelAdminService;

	/** Persist an api-key credential for a provider (auth.json). */
	setProviderApiKey(provider: string, apiKey: string): Promise<void> {
		return this.modelAdmin.setProviderApiKey(provider, apiKey);
	}
	async clearProviderApiKey(provider: string): Promise<void> {
		const usingOAuth = this.runtime.services.modelRuntime.isUsingOAuth(provider.trim());
		await this.modelAdmin.clearProviderApiKey(provider);
		// The provider is back to unconfigured — drop its key preference in
		// EVERY project, otherwise each project switch re-tries a restore.
		if (!usingOAuth) {
			this.stateStore.deleteProviderEverywhere(provider.trim());
			const defKey = this.stateStore.getDefaultProviderKey(provider.trim());
			if (defKey) this.stateStore.repointDeletedKeyInDefault(provider.trim(), defKey, null);
		}
	}
	startProviderOAuth(provider: string): void {
		this.modelAdmin.startProviderOAuth(provider);
	}
	replyProviderOAuth(flowId: string, promptId: string, value: string): void {
		this.modelAdmin.replyProviderOAuth(flowId, promptId, value);
	}
	cancelProviderOAuth(flowId: string): void {
		this.modelAdmin.cancelProviderOAuth(flowId);
	}
	listProviderOAuthFlows(): void {
		this.modelAdmin.listProviderOAuthFlows();
	}
	logoutProviderOAuth(provider: string): Promise<void> {
		return this.modelAdmin.logoutProviderOAuth(provider);
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
	/** Force-refresh built-in providers' official pi.dev catalogs (bypass the
	 *  SDK's 4h freshness window) — refresh_builtin_result. */
	refreshBuiltinModels(reqId: number): Promise<void> {
		return this.modelAdmin.refreshBuiltinModels(reqId);
	}
	/** Append one model to a built-in provider's models.json overlay entry. */
	appendBuiltinModel(providerId: string, model: unknown, reqId: number): Promise<void> {
		return this.modelAdmin.appendBuiltinModel(providerId, model as never, reqId);
	}
	/** Copy a built-in provider into an editable custom-provider draft
	 *  (clone_provider_result) — lets the user run a second API key without
	 *  overwriting the built-in one. */
	cloneProvider(providerId: string, reqId: number): Promise<void> {
		return this.modelAdmin.cloneProvider(providerId, reqId);
	}
	/** Enrich custom-provider draft rows from public catalogs (enrich_models_result). */
	enrichModels(reqId: number, ids: string[], hints?: Record<string, string>): Promise<void> {
		return this.modelAdmin.enrichModels(reqId, ids, hints, () => this.getLang());
	}
	/** Abort in-flight enrich_models request. */
	abortEnrichModels(reqId?: number): void {
		this.modelAdmin.abortEnrichModels(reqId);
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
		this.stateStore.repointDeletedKeyInDefault(provider, keyName, active);
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
	 *  Silent + self-healing like the bulk restore above. Falls back to the
	 *  GLOBAL default key when the project has no pin for this provider (new
	 *  project following the global default model). */
	private async restoreKeyForModel(modelId: string, cwd: string): Promise<void> {
		const slash = modelId.indexOf("/");
		if (slash <= 0) return;
		const provider = modelId.slice(0, slash);
		const projectPin = this.stateStore.getProjectProviderKey(this.clientId, cwd, provider);
		if (projectPin) {
			const cur = this.modelAdmin.getActiveKeyName(provider);
			if (cur === projectPin) return;
			if (!this.modelAdmin.hasProviderKey(provider, projectPin)) {
				this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
				return;
			}
			const ok = await this.modelAdmin.activateProviderKey(provider, projectPin, { silent: true });
			if (!ok) this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
			return;
		}
		// No project pin — follow the global default key (if any). No
		// self-healing deletes here: the ref belongs to the global default,
		// not this project (key deletions already repoint it, see
		// repointDeletedKeyInDefault).
		const globalPin = this.stateStore.getDefaultProviderKey(provider);
		if (!globalPin) return;
		if (this.modelAdmin.getActiveKeyName(provider) === globalPin) return;
		if (!this.modelAdmin.hasProviderKey(provider, globalPin)) return;
		await this.modelAdmin.activateProviderKey(provider, globalPin, { silent: true });
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
	 *  the user switches via the picker. Silent on failure (model no longer in catalog).
	 *  Fallback chain: project memory > GLOBAL default model > SDK default (no-op). */
	private async restoreProjectModelForCwd(cwd: string): Promise<void> {
		const savedModel = this.stateStore.getProjectModel(this.clientId, cwd) ?? this.stateStore.getDefaultModel();
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
			if (curId === savedModel) {
				// 即使模型已是目标模型，也确保恢复其专属思考强度或全局默认思考强度
				const sm = this.session.settingsManager;
				const targetThinking = sm.getModelThinkingLevel(model.provider, model.id) ?? sm.getDefaultThinkingLevel();
				if (targetThinking && this.session.thinkingLevel !== targetThinking) {
					try {
						this.session.setThinkingLevel(targetThinking);
					} catch {
						/* 模型可能不支持该强度 */
					}
				}
				return;
			}
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

	/** 把压缩软上限换算成各存活会话的 compaction reserveTokens 覆盖
	 *  （issue #229）。与重试覆盖同一 live 机制：applyOverrides 只改内存
	 *  合并视图，SDK 每次自动压缩检查前都重读 getCompactionSettings()，
	 *  无需 reload；软上限关闭时回填 SDK 默认 reserve（不让旧覆盖泄漏）。
	 *  窗口未知（会话未就绪/无模型）的会话跳过——创建/就绪/换模型路径
	 *  会重放（见各 applyRetryOverrides 调用点）。 */
	applyCompactionOverrides(): void {
		const s = this.settingsSvc.current;
		for (const c of this.convs.values()) {
			try {
				const modelId = modelKeyOf(c.session);
				const contextWindow = contextWindowOf(c.session);
				const cap = effectiveSoftCap(s.softCapTokens, s.softCapByModel, modelId);
				const reserve = softCapToReserve(contextWindow, cap);
				c.session.settingsManager.applyOverrides({
					compaction: { reserveTokens: reserve ?? DEFAULT_COMPACTION_RESERVE_TOKENS },
				});
			} catch {
				// 会话未就绪或已释放 → 其 runtime 创建时统一注入。
			}
		}
	}

	/** 当前活动对话的生效软上限（快照底栏标记线用；null = 关闭/未知）。 */
	activeSoftCap(contextWindow: number): number | null {
		try {
			const s = this.settingsSvc.current;
			const cap = effectiveSoftCap(s.softCapTokens, s.softCapByModel, modelKeyOf(this.session));
			return softCapToReserve(contextWindow, cap) === null ? null : cap;
		} catch {
			return null;
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
		disabledPluginTools?: string[];
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		toolWatchdogTimeoutMs?: number;
		/** read 工具读目录开关（默认开；见 server/read-tool.ts）。 */
		readDirEnabled?: boolean;
		editSoftEnabled?: boolean;
		questionnaireEnabled?: boolean;
		parallelReminderEnabled?: boolean;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		toolImagesEnabled?: boolean;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: PromptMode;
		visionBridgePrompt?: string;
		scmCommitMsgPromptMode?: PromptMode;
		scmCommitMsgPrompt?: string;
		subagentDefaultModel?: string | null;
		retryMaxAttempts?: number;
		softCapTokens?: number;
		softCapByModel?: Record<string, number>;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
		disabledPlugins?: string[];
		/** 插件顶栏条目的隐藏/排序偏好（纯 UI，per-client）。 */
		pluginTopbarHidden?: string[];
		pluginTopbarOrder?: string[];
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
		if ((rest as { disabledPluginTools?: unknown }).disabledPluginTools !== undefined) {
			this.refreshPluginTools();
			this.flushSnapshot();
		}
		if (markerChanged) {
			// 标记开关影响 system prompt 引导，需重载生效（流式中则延迟）
			this.pushSettings();
			this.flushSnapshot();
			// 尝试立即重载，若流式中会由 SettingsService 延迟到 agent_end
			if (!this.session.isStreaming) {
				try {
					await this.session.reload();
					this.applyRetryOverrides();
					this.applyCompactionOverrides();
					this.applyToolGating(this.session);
					await this.pushSlashCommands();
					this.pushSettings();
				} catch (err) {
					console.error(`[settings] marker reload failed (conv ${this.activeId}):`, err);
					this.emit({
						type: "notice",
						level: "error",
						text: `设置应用失败：${(err as Error).message}`,
						textEn: `Failed to apply settings: ${(err as Error).message}`,
					});
				}
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
		this.syncPluginTools(session);
		// SDK 的 setActiveToolsByName 只改 agent.state.tools，不派发任何事件——门控后
		// 主动推一次快照，否则快照里的 tools 要等下一个 SDK 事件才对齐（会话空闲时永远
		// 等不到；回归：tests/terminal-smoke-test.mjs「agent exposes persistent terminal tools」）。
		// 只在被门控的就是活跃会话时推（创建早期活跃对话可能还没绑定；创建流程自带快照）。
		const active = this.convs.get(this.activeId);
		if (active && active.session === session) this.flushSnapshot();
	}

	/** 当前启用的插件 AI 工具定义（provider 快照按 disabledPluginTools 过滤；
	 *  未知/已卸载插件的禁用条目保留但不影响现有工具）。 */
	private enabledPluginToolDefs(): ToolDefinition[] {
		const off = new Set(normalizeDisabledPluginTools(this.settingsSvc.current.disabledPluginTools));
		return (this.pluginToolsProvider?.() ?? []).filter((t) => !off.has(t.name)).map(pluginToolToDefinition);
	}

	/** 把插件 AI 工具同步进一个已存在的会话（新增/更新/移除；禁用工具同步移除）。
	 *  实际 diff 逻辑在 plugins.ts 的 syncPluginToolsIntoSession（可单测）。
	 *  模板白名单的子代理（subagentBarsPluginTools）跳过：工厂期就没注册，这里
	 *  不回补，否则白名单等于没关门。 */
	private syncPluginTools(session: AgentSession): void {
		for (const conv of this.convs.values()) {
			if (conv.session === session && conv.subagentBarsPluginTools) return;
		}
		try {
			const defs = this.enabledPluginToolDefs();
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

	/** issue #145：本实例连接的 socket 数（0 = 标签页全关了，ClientSession 残留）。 */
	sinkCount(): number {
		return this.sinks.size;
	}

	/** issue #145：按下 session 文件找本实例持有的对话（跨客户端查重的本机一半）。 */
	findConversationBySessionFile(targetPath: string): Conversation | undefined {
		for (const conv of this.convs.values()) {
			try {
				const sessionFile = conv.session.sessionFile;
				if (sessionFile && resolve(sessionFile) === targetPath) return conv;
			} catch {
				// session being replaced — skip
			}
		}
		return undefined;
	}

	/** issue #145：某对话是否正在流式运行（替换中按未跑处理，不误拦）。 */
	conversationStreaming(conv: Conversation): boolean {
		try {
			return conv.session.isStreaming;
		} catch {
			return false;
		}
	}

	/** 某对话的转录最小结构（内存实时消息，含未落盘的；与 conversationReadHost
	 *  的 readRunningConversation 同一取数逻辑 —— 并行提醒算触碰集时复用，
	 *  不另起读取路径）。 */
	convTranscript(conv: Conversation): TranscriptInputMessage[] {
		let raw: AgentMessage[] = [];
		try {
			raw = ((conv.session as unknown as { messages?: AgentMessage[] }).messages ??
				conv.session.agent.state.messages ??
				[]) as AgentMessage[];
		} catch {
			raw = [];
		}
		return raw.map(toTranscriptInput);
	}

	/** issue #145：当前活动对话的 session 文件（resolved），无则 undefined。 */
	activeSessionFileResolved(): string | undefined {
		try {
			const conv = this.convs.get(this.activeId);
			const f = conv?.session.sessionFile;
			return f ? resolve(f) : undefined;
		} catch {
			return undefined;
		}
	}

	/** issue #145：本实例在某 cwd 下正在跑的对话摘要（同项目并行感知用）。 */
	streamingInCwd(cwd: string): { convId: string; title: string; sessionFile?: string }[] {
		const out: { convId: string; title: string; sessionFile?: string }[] = [];
		for (const conv of this.convs.values()) {
			if (conv.cwd !== cwd || conv.isSubagent) continue;
			if (!this.conversationStreaming(conv)) continue;
			let sessionFile: string | undefined;
			try {
				sessionFile = conv.session.sessionFile ?? undefined;
			} catch {
				sessionFile = undefined;
			}
			out.push({ convId: conv.id, title: conv.title, sessionFile });
		}
		return out;
	}

	/** issue #145：本实例别处可见的对话摘要（elsewhere 列表的本机一半 +
	 *  手动过户的目标定位：convId + 是否有等答复问卷）。
	 *
	 *  口径 = 运行中 + 已结束但本会话仍持有的可见对话（shownInRunningList：
	 *  listed 或当前有内容的对话；空白新对话不入列）。只推 running 时，对话
	 *  一结束 elsewhere 行就消失，另一处想过户查看只能趁运行中动手 —— 跑完
	 *  即失联。空闲行带 isStreaming:false + sessionFile，照样可过户（搬 runtime
	 *  本体，单 writer 不变；takeoverBriefs 本来就含空闲对话）。子代理不单列
	 *  （随主对话一起搬）。 */
	streamingSummariesAll(): {
		title: string;
		cwd: string;
		isStreaming: boolean;
		convId: string;
		hasQuestion: boolean;
		questionTitle?: string;
		sessionFile?: string;
	}[] {
		const out: {
			title: string;
			cwd: string;
			isStreaming: boolean;
			convId: string;
			hasQuestion: boolean;
			questionTitle?: string;
			sessionFile?: string;
		}[] = [];
		for (const conv of this.convs.values()) {
			if (conv.isSubagent) continue;
			const streaming = this.conversationStreaming(conv);
			if (!streaming && !this.shownInRunningList(conv)) continue;
			const pq = this.getPendingQuestionForConv(conv.id);
			let sessionFile: string | undefined;
			try {
				sessionFile = conv.session.sessionFile ?? undefined;
			} catch {
				sessionFile = undefined;
			}
			out.push({
				title: conv.title,
				cwd: conv.cwd,
				isStreaming: streaming,
				convId: conv.id,
				hasQuestion: !!pq,
				...(pq?.title ? { questionTitle: pq.title } : {}),
				...(sessionFile ? { sessionFile } : {}),
			});
		}
		return out;
	}

	/**
	 * 浏览器重启认领用：本会话是否有值得新标签接管的内容。
	 * 跑着的（主对话/子代理都算）、后台挂着的（listed）、有消息历史的都算；
	 * 纯空白会话（刚建就关了标签）不算 —— 认领它与新建无异，不如走新建流程。
	 * 零 token 冒烟测试的残留会话永远是空白的，因此认领逻辑不会改变它们的行为。
	 */
	hasAdoptableContent(): boolean {
		for (const c of this.convs.values()) {
			try {
				if (c.session.isStreaming) return true;
			} catch {
				// 会话替换中 —— 按未跑处理
			}
			if (c.isSubagent) continue;
			if (c.listed) return true;
			try {
				if (c.session.getSessionStats().totalMessages > 0) return true;
			} catch {
				// 会话替换中 —— 按无消息处理
			}
		}
		return false;
	}

	/** 各对话最近活跃时间的最大值（认领时多个残留按此排序，新的优先）。 */
	latestActivity(): number {
		let at = 0;
		for (const c of this.convs.values()) {
			at = Math.max(at, c.lastActiveAt || 0, c.lastSdkEventAt || 0);
		}
		return at;
	}

	/** 被新标签认领后首帧即被告之（pendingNotices 随 attachSink 下发）。 */
	noteAdopted(): void {
		this.pendingNotices.push({
			type: "notice",
			level: "info",
			text: "已恢复你关闭浏览器前的工作会话（含运行中的对话），可直接继续查看与操作。",
			textEn:
				"Restored the workspace session from before the browser was closed, including its running conversations — pick up right where you left off.",
		});
	}

	/** issue #145：让其他客户端重推 conversations（elsewhere 刷新用；
	 *  流式集合签名驱动，外层循环安全）。 */
	refreshExternalRunning(): void {
		if (this.disposed) return;
		this.emitConversations();
	}

	/** issue #145：AgentService 代其他客户端向本客户端广播 notice（并行通告用）。 */
	sendNotice(msg: { type: "notice"; level: "info" | "warning" | "error"; text: string; textEn?: string }): void {
		this.emit(msg);
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
		// 输入框内容被消费（发送/斜杠执行）→ 清掉该会话存过的草稿（best-effort）。
		// 快捷短语发送（不碰输入框）同样清：客户端发送成功后会把当前草稿重存回来。
		// clear() 同时记录 clear 时间戳水位：清掉之后才 landing 的旧 draft_update
		// （防抖延迟 / 跨 tab 陈旧写，ts <= 水位）由 store 直接丢弃，不复活。
		try {
			this.drafts.clear(conv.session.sessionId);
		} catch {
			// ignore
		}
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
			// #280：悬空 toolCall 守卫——转录尾是「有调用、无结果」时直接 prompt
			// 会把非法链喂给 provider（有发起迹象但零落盘、零报错的黑洞）。
			// 非流式时先补合成结果再继续；补不上则响亮拒绝。
			if (conv.transcriptBlocked && !s.isStreaming) {
				this.emit({
					type: "notice",
					level: "error",
					text: `发送已拒绝：该对话的记录尾是一个没有结果的工具调用（上次运行被强制终止），且自动修复失败。请从历史记录重新打开该对话，或新建对话后重试。`,
					textEn: `Prompt refused: this transcript ends with a tool call that never got a result (last run was force-terminated) and auto-repair failed. Reopen it from history or start a new conversation.`,
				});
				this.flushSnapshot();
				return;
			}
			if (!s.isStreaming) {
				try {
					const live = s.agent.state.messages as unknown[];
					const dangling = Array.isArray(live) ? findDanglingToolCalls(live) : [];
					if (dangling.length > 0) {
						let healed = 0;
						try {
							const sm = s.sessionManager as unknown as {
								appendMessage?: (m: unknown) => void;
							};
							if (typeof sm?.appendMessage === "function") {
								for (const d of dangling) {
									sm.appendMessage({
										role: "toolResult",
										toolCallId: d.toolCallId,
										toolName: d.toolName,
										content: [
											{
												type: "text",
												text: `${DANGLING_TOOL_RESULT_TEXT}
${DANGLING_TOOL_RESULT_TEXT_EN}`,
											},
										],
										isError: true,
										timestamp: Date.now(),
									});
									healed += 1;
								}
							}
						} catch {
							// 落盘失败走下面的拒绝分支。
						}
						if (healed === dangling.length && healed > 0) {
							conv.transcriptBlocked = false;
							this.emit({
								type: "notice",
								level: "warning",
								text: `检测到上次运行残留的 ${dangling.length} 个无结果工具调用，已自动填入合成结果后继续。如任务未完成请重新执行该工具。`,
								textEn: `Found ${dangling.length} tool call(s) without results from the last run; synthetic results were inserted automatically before continuing. Re-run the tool if the task is incomplete.`,
							});
						} else {
							conv.transcriptBlocked = true;
							this.emit({
								type: "notice",
								level: "error",
								text: `发送已拒绝：该对话的记录尾是一个没有结果的工具调用（上次运行被强制终止），且自动修复失败。请从历史记录重新打开该对话，或新建对话后重试。`,
								textEn: `Prompt refused: this transcript ends with a tool call that never got a result (last run was force-terminated) and auto-repair failed. Reopen it from history or start a new conversation.`,
							});
							this.flushSnapshot();
							return;
						}
					} else {
						conv.transcriptBlocked = false;
					}
				} catch {
					// 守卫本身绝不挡发送：查不到就按原路径走。
				}
			}
			// issue #145：发之前再查一次同文件持有者 —— 拦住「打开时空闲、发送时在跑」的竞态。
			// 没有第二个 writer，就不可能有看不见的第二个 agent。
			const activeFile = this.activeSessionFileResolved();
			if (activeFile) {
				const owner = this.findSessionOwner?.(activeFile);
				if (owner && owner.isStreaming) {
					this.emit({
						type: "notice",
						level: "warning",
						text: `发送已拦截：该对话正在另一处运行中（「${owner.title}」）。请等它结束后再发，或回到原窗口继续 —— 否则两个 agent 会同时写同一份记录，其中一支事后不可见。`,
						textEn: `Prompt blocked: this conversation is running in another window ("${owner.title}"). Wait for it to finish or continue there — two writers on one transcript would leave one run permanently invisible.`,
					});
					this.flushSnapshot();
					return;
				}
			}
			// issue #145：同项目并行感知 —— 同一 cwd 下别处（或其他对话）正在跑时，
			// 允许并行（可以同时改不同部分），但用户与 AI 都必须知道。只在新一轮启动时
			// 通告一次（steer/排队等流式中发送不重复打扰）。
			// parallelReminderEnabled=false 时整段跳过（不发 notice、不注 AI、不通知对端）。
			if (!conv.isSubagent && !s.isStreaming && this.settingsSvc.current.parallelReminderEnabled !== false) {
				// 认领心跳：本对话发 prompt = 还活着，自己名下的认领续期（同步内存操作）。
				try {
					this.getClaimStore?.().touch(conv.id);
				} catch {
					// ignore
				}
				let projectClaims: { path: string; ownerConvId: string; ownerTitle: string; note?: string }[] = [];
				try {
					projectClaims = this.getClaimStore?.().list(conv.cwd) ?? [];
				} catch {
					projectClaims = [];
				}
				// 本窗口正在跑的：子代理也算进来（以前 !c.isSubagent 把它们排除在外，
				// 对方用子代理干活时 AI 完全收不到提示），标明归属。触碰集就地从内存
				// 消息算，无 I/O，不阻塞发送路径。
				const localRunners = [...this.convs.values()]
					.filter((c) => c.id !== conv.id && c.cwd === conv.cwd && this.conversationStreaming(c))
					.map((c) => {
						let label: string;
						if (c.isSubagent) {
							const parent = c.parentId ? this.convs.get(c.parentId) : undefined;
							label = parent ? `本窗口「${parent.title}」的子代理「${c.title}」` : `本窗口子代理「${c.title}」`;
						} else {
							label = `本窗口「${c.title}」`;
						}
						return { label, touches: extractTouches(this.convTranscript(c)) };
					});
				const externalRunners = (this.listProjectRunners?.(conv.cwd) ?? []).filter(
					(r) => r.sessionFile === undefined || (activeFile !== undefined && resolve(r.sessionFile) !== activeFile),
				);
				// 取舍（诚实降级）：外部运行只有 title + sessionFile，触碰集要读对方
				// 转录文件 —— 同步文件 I/O 会阻塞发送路径，不做；提醒里如实写
				// 「外部运行的文件触碰未知」，不编造。
				// 每条 ≤60 字符（以前整串 slice(0, 600)，经常从半截路径处拦腰截断）。
				const capItem = (st: string): string => (st.length <= 60 ? st : `${st.slice(0, 59)}…`);
				const noticeTitles = [
					...localRunners.map((r) => r.label),
					...externalRunners.map((r) => `另一处「${r.title}」`),
				].map(capItem);
				const aiItems = [
					...localRunners.map((r) => `${r.label}·${r.touches.length} files`),
					...externalRunners.map((r) => `另一处「${r.title}」·touches unknown`),
				].map(capItem);
				if (noticeTitles.length > 0) {
					const shown = noticeTitles.slice(0, 3).join("、");
					const more = noticeTitles.length > 3 ? `等 ${noticeTitles.length} 处` : "";
					this.emit({
						type: "notice",
						level: "info",
						text: `同项目并行提醒：${shown}${more}正在同一项目运行。你可以继续（适合改不同文件），改动同一文件前请先确认；拿不准就等它跑完。`,
						textEn: `Parallel-work notice: ${shown}${more ? " and more" : ""} running in the same project. You may continue (fine for different files); confirm before touching the same files, or wait for it to finish when unsure.`,
					});
					// 给 AI 的上下文：交集由服务端算好写明“⚠ 双方都动过 X”，AI 不用自己
					// 算；拿不准就 ask_user_question 让用户选（并行 / 等它跑完 / 只读围观）。
					// display:false —— 用户界面只看上面的 notice。分两档：无交集只给一行
					// （省 token），有交集才展开细节。
					const mine = extractTouches(this.convTranscript(conv));
					// 认领升级（advisory，但比触碰更强：这是对方的事前意图）：
					// 我动过 + 对方认领 → 最强信号单独点名；其他认领只给一行汇总。
					const othersClaims = projectClaims.filter((c) => c.ownerConvId !== conv.id);
					const myClaimed = matchClaims(
						mine,
						othersClaims.map((c) => ({
							path: c.path,
							ownerConvId: c.ownerConvId,
							ownerTitle: c.ownerTitle,
							claimedAt: 0,
							expiresAt: 0,
						})),
						conv.cwd,
					);
					const claimHitEn = myClaimed
						.slice(0, 3)
						.map((h) => `${h.touch.path} (claimed by ${h.claim.ownerTitle})`)
						.join("; ");
					const claimHitZh = myClaimed
						.slice(0, 3)
						.map((h) => `${h.touch.path}（${h.claim.ownerTitle}已认领）`)
						.join("、");
					const claimMore = myClaimed.length > 3 ? ` (+${myClaimed.length - 3})` : "";
					const claimsSummaryEn =
						othersClaims.length > 0
							? ` Claimed by others (steer clear): ${othersClaims
									.slice(0, 3)
									.map((c) => `${c.path} ("${c.ownerTitle}")`)
									.join("; ")}${othersClaims.length > 3 ? ` (+${othersClaims.length - 3})` : ""}.`
							: "";
					const claimsSummaryZh =
						othersClaims.length > 0
							? ` 对方认领（绕行）：${othersClaims
									.slice(0, 3)
									.map((c) => `${c.path}（「${c.ownerTitle}」）`)
									.join("、")}${othersClaims.length > 3 ? `（等 ${othersClaims.length - 3} 处）` : ""}。`
							: "";
					const clashes = localRunners
						.map((r) => ({ label: r.label, hits: intersectTouches(r.touches, mine) }))
						.filter((r) => r.hits.length > 0);
					const extNoteEn = externalRunners.length > 0 ? ` Touched files of external run(s) are unknown.` : "";
					const extNoteZh = externalRunners.length > 0 ? `外部运行的文件触碰未知。` : "";
					let aiReminder: string;
					if (clashes.length === 0 && myClaimed.length === 0) {
						aiReminder =
							`(System reminder: ${aiItems.length} other run(s) [${aiItems.join("; ")}] ` +
							`are currently running in the same project directory. No file written by both you and them was detected, ` +
							`so working on different files in parallel is fine; before writing the same files or running project-wide ` +
							`commands, assess the conflict risk first, and use ask_user_question when unsure ` +
							`(continue in parallel / wait / watch read-only).${extNoteEn}${claimsSummaryEn})\n` +
							`（系统提醒：同一项目另有 ${aiItems.length} 处运行（${shown}${more}）。未发现双方都写过的文件，` +
							`改不同文件可并行；动同一文件或跑全局命令前先评估冲突，拿不准就用 ask_user_question 让用户选择：` +
							`并行 / 等它跑完 / 只读围观。${extNoteZh}${claimsSummaryZh}）`;
					} else {
						// 有交集档：每处 ≤3 条完整路径 + 计数（路径永不截断，见 conversation-touches）。
						const clashPartsEn = clashes.map((h) => `${h.label} — you both wrote: ${formatTouchesCompact(h.hits)}`);
						if (myClaimed.length > 0) {
							clashPartsEn.push(
								`⚠ you touched and others claimed: ${claimHitEn}${claimMore} — ask the user before touching these again`,
							);
						}
						const clashEn = clashPartsEn.join("; ");
						const clashPartsZh = clashes.map((h) => `⚠ ${h.label}双方都动过：${formatTouchesCompact(h.hits)}`);
						if (myClaimed.length > 0) {
							clashPartsZh.push(`⚠ 你动过、对方已认领：${claimHitZh}${claimMore} —— 动之前先问用户`);
						}
						const clashZh = clashPartsZh.join("；");
						aiReminder =
							`(System reminder: ${aiItems.length} other run(s) [${aiItems.join("; ")}] ` +
							`are currently running in the same project directory. ⚠ ${clashEn} — re-read these files before ` +
							`touching them again, and use ask_user_question when unsure ` +
							`(continue in parallel / wait / watch read-only).${extNoteEn})\n` +
							`（系统提醒：同一项目另有 ${aiItems.length} 处运行（${shown}${more}）。` +
							`${clashZh} —— 再动这些文件前先读最新内容，拿不准就用 ask_user_question 让用户选择：` +
							`并行 / 等它跑完 / 只读围观。${extNoteZh}）`;
					}
					try {
						await s.sendCustomMessage(
							{
								customType: "parallel-work-reminder",
								content: [{ type: "text", text: aiReminder }],
								display: false,
							},
							{ deliverAs: "nextTurn" },
						);
					} catch {
						// best effort —— 注入失败不影响发送本身
					}
					// 让对端也知道：有人在同项目开了并行工作（只通知其他客户端，不打扰自己）。
					if (externalRunners.length > 0) {
						this.notifyExternalClients?.({
							type: "notice",
							level: "info",
							text: `同项目并行提醒：另一处在「${conv.cwd}」开始了对话（「${conv.title}」），可能与你正在跑的任务并行改动同一项目。`,
							textEn: `Parallel-work notice: another window started a conversation ("${conv.title}") in "${conv.cwd}", possibly editing the same project in parallel with your running task.`,
						});
					}
				}
			}
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
				// 同时也是 #140 的入列时刻：这条对话从此有内容了，左栏「运行的对话」
				// 立刻要有它（此刻还在流式输出，不能等 agent_end 的防抖刷新）。
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
	 * Remove ONE queued prompt (the ✕ on a pending bubble) so it is neither
	 * shown nor eventually delivered. The pi SDK has no per-item queue API, so we
	 * drain the SDK queue (clearQueue), drop the target item and re-queue the rest
	 * in their original order; the SDK re-emits queue_update which re-syncs
	 * conv.queueSteering / conv.queueFollowUp.
	 *
	 * `index` identifies WHICH bubble was clicked (same duplicate text can be
	 * queued twice — text alone drops the wrong one). It is checked against the
	 * item still at that position; on any mismatch we fall back to first-occurrence
	 * text match (old clients, or the queue shifted between click and handling).
	 */
	async removeQueued(kind: "steer" | "followUp", text: string, index?: number): Promise<void> {
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
			const next = removeQueuedByIndexOrText(local, text, index);
			if (next.length !== local.length) {
				local.splice(0, local.length, ...next);
			}
			this.flushSnapshot();
			return;
		}
		const { steering, followUp } = s.clearQueue();
		// 气泡 ✕ 对应的是「第几个气泡」（index），不是「哪段文本」：同一文本排队两次时
		// 按文本只会删掉第一条，点第二个气泡却删掉第一个。用 index 定位，位置对不上
		// （队列在点击与执行之间变化）或旧客户端没发 index 时回落到第一处文本匹配。
		const keptSteering = kind === "steer" ? removeQueuedByIndexOrText(steering, text, index) : steering;
		const keptFollowUp = kind === "followUp" ? removeQueuedByIndexOrText(followUp, text, index) : followUp;
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

	// -----------------------------------------------------------------------
	// 未发送输入框草稿（issue #166，单中心文件方案，见 server/composer-drafts.ts）
	// -----------------------------------------------------------------------

	/** 存指定会话的未发送草稿（`draft_update` 入口，经 DispatchSession.saveDraft）。
	 *  按消息自带的 sessionId 落键（不按 active 会话：切会话时的「离开刷盘」
	 *  晚于服务端的切换到达）。空白新会话的转录还没落盘，但 id 内存里已有。
	 *  存完不推快照：同页的草稿本来就是自己打的；恢复走全量快照的 draft 字段。
	 *  陈旧写由 ComposerDraftsStore 的 clear 水位丢弃（ts <= clearTs 不复活）。 */
	saveDraft(sessionId: string, text: string, ts: number): void {
		try {
			if (!sessionId) return;
			this.drafts.save(sessionId, text, ts);
		} catch {
			// best-effort：草稿丢了可以重打
		}
	}

	/** 当前活跃对话的草稿（全量快照用；增量 snapshot_delta 传 withDraft=false 不带）。 */
	private draftForSnapshot(): UiState["draft"] {
		try {
			return this.drafts.get(this.conv.session.sessionId) ?? null;
		} catch {
			return null;
		}
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
		// #280：先记下本次对话自己的会话文件——重建必须回到同一个文件，
		// 不能用 continueRecent(cwd) 按 mtime 取「最近」（同 cwd 多会话时会接错文件）。
		const ownFile = (() => {
			try {
				const f = conv.session.sessionFile;
				return typeof f === "string" && f ? f : undefined;
			} catch {
				return undefined;
			}
		})();
		try {
			conv.unsubscribe?.();
			conv.unsubscribe = undefined;
			this.clearAllToolWatchdogs(conv);
			conv.toolStartTimes.clear();
			disposeEvalSession(conv.id);
			await conv.runtime.dispose();
			// #280：dispose 丢弃了内存里的在飞状态（未落盘的工具结果蒸发），
			// 文件尾可能留下一个悬空 toolCall——先补合成 toolResult 再重建，
			// 否则重建后的 prompt 会把非法转录链喂给 provider（零落盘黑洞）。
			let healedCount = 0;
			if (ownFile && existsSync(ownFile)) {
				try {
					const n = healDanglingToolCallFile(ownFile);
					if (n > 0) healedCount = n;
				} catch {
					// best-effort：修不好就按原路径重建，下面的守卫会在 prompt 前再拦。
				}
			}
			// #235：转录链损坏时修一次再试（见 openManagerAndRuntime）。
			const opened = await this.openManagerAndRuntime(
				() => (ownFile && existsSync(ownFile) ? SessionManager.open(ownFile) : SessionManager.continueRecent(conv.cwd)),
				(m) =>
					createAgentSessionRuntime(this.makeRuntimeFactory(conv.terminals, undefined, conv.id), {
						cwd: conv.cwd,
						agentDir: this.agentDir,
						sessionManager: m,
					}),
				async () => (ownFile && existsSync(ownFile) ? ownFile : (await SessionManager.list(conv.cwd))[0]?.path),
			);
			const runtime = opened.runtime;
			if (opened.repair) {
				for (const n of this.transcriptRepairNotices(opened.repair)) this.emit(n);
			}
			conv.runtime = runtime;
			conv.session = runtime.session;
			if (healedCount > 0) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `上次运行被强制终止，${healedCount} 个无结果的工具调用已自动填入合成结果（转录链已修复）。建议检查任务状态，必要时重新执行该工具。`,
					textEn: `The last run was force-terminated; ${healedCount} tool call(s) without results were filled with synthetic results (transcript healed). Verify task state and re-run the tool if needed.`,
				});
			}
			// #280：重建后复查——新 runtime 仍以悬空 toolCall 开头说明修复没落盘
			// （文件被删/只读等），此时响亮拒绝后续 prompt 而不是静默黑洞。
			try {
				const msgs = conv.session.agent.state.messages as unknown[];
				const still = Array.isArray(msgs) ? findDanglingToolCalls(msgs) : [];
				if (still.length > 0) conv.transcriptBlocked = true;
				else conv.transcriptBlocked = false;
			} catch {
				// ignore：守卫是兜底，查不到就让 prompt 路径再查。
			}
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
	async newChat(_preset?: string): Promise<boolean> {
		// _preset: DSH Agent 预设（pi 引擎无此概念，忽略；wire 统一见 protocol new_chat）。
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
		const prevThinking = this.conv.session.thinkingLevel ?? null;
		let ready = false;
		try {
			const conversationId = this.nextConversationId();
			const terminals = this.makeTerminalManager(conversationId, this.cwd);
			const runtime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(terminals, undefined, conversationId, prevModel ?? undefined),
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
			// A fresh transcript appeared in the sessions dir — the next listing
			// must see it, not the pre-newChat fridge snapshot.
			this.invalidateSessionInfos();
			// New session seeds with the ModelRuntime default model — restore the
			// model the user had selected in the previous chat.
			let modelRestored = !!this.session.model;
			if (!modelRestored && prevModel && this.sharedModelRuntime) {
				try {
					const p = (prevModel as unknown as { provider: string }).provider;
					const mid = `${p}/${(prevModel as unknown as { id: string }).id}`;
					// 先恢复 provider key，再 setModel（否则 checkAuth 鉴权失败）
					await this.restoreKeyForModel(mid, this.cwd);
					await this.session.setModel(prevModel);
					modelRestored = true;
				} catch {
					// model no longer resolvable
				}
			}
			if (!modelRestored) {
				// 上个会话模型未能恢复（或无上个会话）：回落项目记忆或全局默认模型
				try {
					await this.restoreProjectModelForCwd(this.cwd);
				} catch {
					/* 保持默认 */
				}
			}
			if (prevThinking) {
				try {
					this.session.setThinkingLevel(prevThinking as Parameters<AgentSession["setThinkingLevel"]>[0]);
				} catch {
					// model may not support previous thinking level
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
	/** Write a pending-compaction marker into the session file. The SDK treats
	 *  unknown custom entries as inert data, so a crash/restart-safe "we were
	 *  compacting" record survives in the transcript itself — no sidecar file
	 *  to orphan or clean up. Removed on compaction_end. */
	private markCompactionPending(conv: Conversation): void {
		try {
			const file = conv.session.sessionFile;
			if (!file) return;
			// parentId joins the live chain: a null-parent marker would become a
			// second root and hijack the leaf, corrupting the transcript.
			// #235: id 必须唯一——硬编码共享 id ＋ SDK byId last-wins ＋ 标记恰为末行
			// 时新消息 parent 记成共享 id ＝ 下次 open 回溯成环，整个会话打不开。
			const marker = {
				type: "custom",
				id: makeCompactionMarkerId("pending"),
				parentId: conv.session.sessionManager.getLeafId(),
				timestamp: new Date().toISOString(),
				customType: "pi-web-ui/compaction-pending",
				data: {
					reason: conv.compactionState?.reason ?? "manual",
					startedAt: conv.compactionState?.startedAt ?? Date.now(),
				},
			};
			appendFileSync(file, `${JSON.stringify(marker)}\n`);
		} catch {
			// Marker is best-effort: compaction still runs without it, only the
			// restart-detection below is lost.
		}
	}

	/** Close out the pending-compaction marker (called on compaction_end). The
	 *  session file is append-only through the SDK, so rewrite the file with the
	 *  pending marker replaced by a completion marker carrying the outcome
	 *  (completed / failed / cancelled + token counts). The transcript then holds
	 *  a durable started→finished record instead of a silent gap. No-op when the
	 *  file or marker is absent. */
	private clearCompactionPending(
		conv: Conversation,
		outcome?: {
			status: "completed" | "failed" | "cancelled";
			tokensBefore?: number;
			tokensAfter?: number;
			error?: string;
		},
	): void {
		try {
			const file = conv.session.sessionFile;
			if (!file || !existsSync(file)) return;
			const raw = readFileSync(file, "utf8");
			const lines = raw.split("\n");
			// #235：按 customType 定位（id 自本 fix 起唯一，老文件仍是硬编码 id，
			// 按 id 找已不可靠）。取最后一个：重叠压缩时它属于本次，旧残留留给
			// 下次 open 的 repair/notice 处理。
			let idx = -1;
			for (let i = lines.length - 1; i >= 0; i--) {
				if (lines[i].includes(`"${COMPACTION_PENDING_TYPE}"`)) {
					idx = i;
					break;
				}
			}
			if (idx < 0) return;
			// ponytail: full-file rewrite on compaction end — compactions are rare
			// (seconds apart at most), session files are KBs; no streaming needed.
			if (!outcome) {
				lines.splice(idx, 1);
			} else {
				let parentId: string | null = null;
				try {
					parentId = conv.session.sessionManager.getLeafId();
				} catch {
					// fall through with null parent
				}
				const done = {
					type: "custom",
					id: makeCompactionMarkerId("done"),
					parentId,
					timestamp: new Date().toISOString(),
					customType: "pi-web-ui/compaction-done",
					data: { reason: conv.compactionState?.reason ?? "manual", ...outcome },
				};
				lines[idx] = JSON.stringify(done);
			}
			writeFileSync(file, lines.join("\n"));
		} catch {
			// Best-effort, same as the write path.
		}
	}

	/** Check a freshly opened session for a leftover compaction-pending marker.
	 *  A marker with no matching compaction_end means the server died mid-compaction
	 *  (restart/crash): the in-flight summary is gone, but the session is intact.
	 *  Surface a warning notice with a one-click retry (/compact) instead of
	 *  silently dropping it. Consumes the marker either way. */
	private noticeInterruptedCompaction(conv: Conversation): void {
		try {
			const file = conv.session.sessionFile;
			if (!file || !existsSync(file)) return;
			// Match on the stable customType (conversation ids change every restart).
			const raw = readFileSync(file, "utf8");
			if (!raw.includes('"pi-web-ui/compaction-pending"')) return;
			const kept = raw.split("\n").filter((line) => !line.includes("pi-web-ui/compaction-pending"));
			writeFileSync(file, kept.join("\n"));
			this.emitCompactionInterruptedNotice();
		} catch {
			// Best-effort, same as the write path.
		}
	}

	private emitCompactionInterruptedNotice(): void {
		this.emit({
			type: "notice",
			level: "warning",
			text: "上次压缩上下文被服务端重启打断，未完成。可发送 /compact 重试。",
			textEn:
				"The last context compaction was interrupted by a server restart and did not finish. Send /compact to retry.",
		});
	}

	/** #235 修复产生的提示（调用方决定 emit 还是进 pendingNotices）。 */
	private transcriptRepairNotices(
		repair: SessionFileRepair,
	): Array<{ type: "notice"; level: "warning"; text: string; textEn: string }> {
		const out: Array<{ type: "notice"; level: "warning"; text: string; textEn: string }> = [];
		if (repair.interrupted) {
			out.push({
				type: "notice",
				level: "warning",
				text: "上次压缩上下文被服务端重启打断，未完成。可发送 /compact 重试。",
				textEn:
					"The last context compaction was interrupted by a server restart and did not finish. Send /compact to retry.",
			});
		}
		if (repair.renamedIds > 0 || repair.rewiredParents > 0 || repair.cyclesBroken > 0) {
			out.push({
				type: "notice",
				level: "warning",
				text: `对话记录链损坏已自动修复（重复的压缩标记），原文件备份在 ${repair.backup ?? "同目录 .bak 文件"}。如内容异常可手动恢复。`,
				textEn: `The conversation transcript had a corrupted parent chain (duplicate compaction markers) and was auto-repaired. The original file is backed up at ${repair.backup ?? "a .bak file next to it"}; restore it manually if anything looks off.`,
			});
		}
		return out;
	}

	/**
	 * #235：已知路径先修后开（openConversation 走这条——单文件预扫描零负担）。
	 * 返回 null = 文件健康或无需处理；返回 repair = 修过，调用方弹提示。
	 * #280：顺带修悬空 toolCall（强制重置/崩溃残留的有调用无结果），修过同样弹提示。
	 */
	private repairTranscriptFileBeforeOpen(filePath: string): SessionFileRepair | null {
		let repair: SessionFileRepair | null = null;
		try {
			repair = repairSessionFile(filePath);
		} catch {
			return null;
		}
		if (!repair?.changed) {
			// #280：压缩链健康时仍要查悬空 toolCall（崩溃/强制重置残留）。
			let healed = 0;
			try {
				const n = healDanglingToolCallFile(filePath);
				if (n > 0) healed = n;
			} catch {
				// best-effort
			}
			if (healed <= 0) return null;
			this.emit({
				type: "notice",
				level: "warning",
				text: `该对话上次运行残留 ${healed} 个无结果的工具调用，已自动填入合成结果。如任务未完成请重新执行该工具。`,
				textEn: `${healed} tool call(s) without results from the last run were filled with synthetic results. Re-run the tool if the task is incomplete.`,
			});
			return null;
		}
		for (const n of this.transcriptRepairNotices(repair)) this.emit(n);
		return repair;
	}

	/**
	 * #235：manager＋runtime 一起建，链损坏报错则修最近文件后重试一次。
	 * SessionManager.open 本身不走 parent 链（真正死循环的是 runtime 初始化里的
	 * getBranch），所以重试必须把两步都包进来；修完用全新 manager 重读。
	 */
	private async openManagerAndRuntime(
		makeManager: () => SessionManager,
		makeRuntime: (m: SessionManager) => Promise<AgentSessionRuntime>,
		locateFile: () => Promise<string | undefined>,
	): Promise<{ manager: SessionManager; runtime: AgentSessionRuntime; repair: SessionFileRepair | null }> {
		try {
			const manager = makeManager();
			const runtime = await makeRuntime(manager);
			return { manager, runtime, repair: null };
		} catch (err) {
			if (!looksLikeChainCorruption(err)) throw err;
			const file = await locateFile().catch(() => undefined);
			const repair = file ? repairSessionFile(file) : null;
			if (!repair?.changed) throw err;
			const manager = makeManager();
			const runtime = await makeRuntime(manager);
			return { manager, runtime, repair };
		}
	}

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
				compacting: conv.session.isCompacting,
				// 只看“用过”的存活终端：没动过的空 shell（点开终端 tab 自动建的
				// 那个）不保留对话，切走即随对话释放（见 countBlockingLive）。
				openTerminals: conv.terminals.countBlockingLive(),
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
		// 对话真关闭（dismiss/释放）→ 放掉它的认领。过户不走这里（对话换个会话
		// 继续，owner 不变，认领继续有效），所以只在此处释放。
		try {
			this.getClaimStore?.().releaseByOwner(id);
		} catch {
			// ignore
		}
		this.convs.delete(id);
		this.clearAllToolWatchdogs(conv);
		// 关对话 → 连它的 eval 内核（Python/Node 子进程 + 临时沙箱目录）一起回收：
		// 这些进程是 detached 进程组，父进程退出不会自动带走它们。
		disposeEvalSession(id);
		conv.terminals.killAll();
		conv.unsubscribe?.();
		conv.unsubscribe = undefined;
		void conv.runtime.dispose().catch(() => {});
	}

	/** 本会话是否持有这个 SDK 会话对应的对话；命中则给出它的**当前** id
	 *  （AgentService 按 runtime 身份解析过户后的归属方用，见 findConversationHome）。 */
	conversationIdOfSession(sdkSession: AgentSession): string | undefined {
		for (const c of this.convs.values()) {
			if (c.session === sdkSession) return c.id;
		}
		return undefined;
	}

	/** 过户用的对话摘要（AgentService 拼移动集合 + 容量检查用）。 */
	takeoverBriefs(): { id: string; title: string; cwd: string; parentId?: string; isSubagent: boolean }[] {
		return [...this.convs.values()].map((c) => ({
			id: c.id,
			title: c.title,
			cwd: c.cwd,
			...(c.parentId ? { parentId: c.parentId } : {}),
			isSubagent: c.isSubagent,
		}));
	}

	/**
	 * 过户转出：把指定对话（含事件订阅/看门狗计时器/等答复问卷/页调用）从本会话摘除。
	 * - 先修 active：active 被搬且还有剩余 → 切过去（优先主对话）；active 被搬且掏空 →
	 *   建空白兜底，建不出来（quiesce）则拒绝搬出（ok:false），绝不留悬空 active。
	 * - 看门狗计时器清掉（toolStartTimes 保留，目标按剩余时间重布）。
	 * - 只搬归属被搬对话的问卷/页调用（conversationId 对得上的；未记归属的留在源会话）。
	 */
	async detachTakeoverConversations(
		ids: string[],
	): Promise<{ ok: true; payload: TakeoverPayload } | { ok: false; reason: "missing" | "empty" }> {
		const set = new Set(ids);
		const convs = [...this.convs.values()].filter((c) => set.has(c.id));
		if (convs.length === 0) return { ok: false, reason: "missing" };
		if (set.has(this.activeId)) {
			const remaining =
				[...this.convs.values()].find((c) => !set.has(c.id) && !c.isSubagent) ??
				[...this.convs.values()].find((c) => !set.has(c.id));
			if (remaining) {
				await this.switchConversation(remaining.id);
			} else if (!(await this.newChat())) {
				return { ok: false, reason: "empty" };
			}
		}
		for (const conv of convs) {
			this.convs.delete(conv.id);
			this.clearAllToolWatchdogs(conv);
			conv.unsubscribe?.();
			conv.unsubscribe = undefined;
		}
		const questions: TakeoverQuestion[] = [];
		for (const [qid, p] of this.pendingQuestions) {
			if (p.conversationId !== undefined && set.has(p.conversationId)) {
				this.pendingQuestions.delete(qid);
				questions.push({ resolve: p.resolve, questions: p.questions, conversationId: p.conversationId });
				// 源页面的对话框可能是即时通道弹出的（live），快照为 null 收不掉它 ——
				// 明确撤回，让源页面立即收起（目标页主对话由转入方重推 question_pending 或快照呈现）。
				this.emit({ type: "question_retracted", id: qid });
			}
		}
		const pageCalls: TakeoverPageCall[] = [];
		for (const [pid, p] of this.pendingPageCalls) {
			if (p.conversationId !== undefined && set.has(p.conversationId)) {
				this.pendingPageCalls.delete(pid);
				clearTimeout(p.timer);
				pageCalls.push({ resolve: p.resolve, req: p.req, timeoutMs: p.timeoutMs, conversationId: p.conversationId });
			}
		}
		this.emitConversations();
		this.flushSnapshot();
		return { ok: true, payload: { convs, questions, pageCalls } };
	}

	/**
	 * 过户转入：把另一会话摘除的对话整体接过来，返回主对话的新 id。
	 * - id 冲突（两边计数器都从 c1 开始，大概率撞上）→ 给搬入方分配新 id，move
	 *   集合内的 parentId/问卷归属同步改写。模型手里旧 runId 的后续子代理工具调用
	 *   会报 unknown（可经列表查新 id）；定时唤醒的旧 id 同理回落无头执行。
	 * - 事件订阅/终端投递/问卷/页调用全部重接到本会话，迁入的主对话立即触发弹窗
	 *   （子代理待答问卷通过角标与快照呈现）。看门狗按剩余时间重布（已逾期的立即触发）。
	 */
	insertTakeoverConvs(payload: TakeoverPayload): string {
		const remap = new Map<string, string>();
		for (const conv of payload.convs) {
			if (this.convs.has(conv.id)) {
				remap.set(conv.id, this.nextConversationId());
			}
		}
		const fix = (id: string): string => remap.get(id) ?? id;
		let mainId = "";
		for (const conv of payload.convs) {
			conv.id = fix(conv.id);
			if (conv.parentId) conv.parentId = fix(conv.parentId);
			if (!conv.isSubagent && !mainId) mainId = conv.id;
			conv.lastActiveAt = Date.now();
			conv.terminals.rebindEmit((msg) => this.emitTerminal(conv.id, msg));
			conv.terminals.onAgentIdle = (terminalId, idleMs, title, lastLines) =>
				this.notifyTerminalIdle(conv.id, terminalId, idleMs, title, lastLines);
			conv.unsubscribe?.();
			conv.unsubscribe = conv.session.subscribe((event) => this.onEvent(conv, event));
			for (const [toolCallId, start] of conv.toolStartTimes) {
				if (!conv.toolWatchdogs.has(toolCallId)) {
					const baseMs = this.getBaseToolWatchdogTimeoutMs();
					if (baseMs > 0) {
						this.rearmToolWatchdog(conv, toolCallId, baseMs - (Date.now() - start), baseMs);
					}
				}
			}
			this.convs.set(conv.id, conv);
		}
		if (!mainId) mainId = payload.convs[0]?.id ?? "";
		for (const q of payload.questions) {
			const nid = `q-${++this.questionSeq}`;
			const qConvId = fix(q.conversationId);
			this.pendingQuestions.set(nid, {
				resolve: q.resolve,
				questions: q.questions,
				conversationId: qConvId,
			});
			// 迁入的主对话立即触发弹窗（子代理问卷留在后台，由角标与切换会话呈现）。
			if (qConvId === mainId) {
				const conv = this.convs.get(qConvId);
				this.emit({
					type: "question_pending",
					id: nid,
					questions: q.questions,
					conversationId: qConvId,
					...(conv?.title ? { conversationTitle: conv.title } : {}),
				});
			}
		}
		for (const p of payload.pageCalls) {
			const nid = `p-${++this.pageSeq}`;
			const timer = this.armPageCallTimeout(nid, p.resolve, p.timeoutMs);
			this.pendingPageCalls.set(nid, {
				resolve: p.resolve,
				timer,
				conversationId: fix(p.conversationId),
				req: p.req,
				timeoutMs: p.timeoutMs,
			});
			this.emit({
				type: "page_request",
				id: nid,
				op: p.req.op,
				args: p.req.args,
				target: p.req.target,
				timeoutMs: p.timeoutMs,
			});
		}
		return mainId;
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
			this.roots = this.stateStore.getWorkspaceRoots(this.clientId, newCwd);
			// 模型/key 恢复不挡快照：后台做，带代际 guard（用户又切走就跳过），
			// 做完补一次 flush 刷新模型栏。
			{
				const convId = id;
				void (async () => {
					try {
						await this.restoreProjectProviderKeysForCwd(newCwd);
						if (this.disposed || this.activeId !== convId || this.cwd !== newCwd) return;
						await this.restoreProjectModelForCwd(newCwd);
						if (this.disposed || this.activeId !== convId || this.cwd !== newCwd) return;
						this.flushSnapshot();
					} catch {
						/* 静默：恢复失败保持会话默认 */
					}
				})();
			}
			// Mirror set_cwd's project-switch side-effects so the whole UI follows
			// the new workspace, not just the chat pane.
			try {
				this.onCwdChanged?.(newCwd, this.roots);
			} catch {
				/* hook failure must not break the switch */
			}
			this.stateStore.remember(this.clientId, newCwd);
			void this.pushProjects();
			this.refreshSessionsOnSwitch();
			void this.listFiles(undefined);
			void this.listCommands();
		}
		// 当前打开对话变了 → 插件重拉（轨迹视图切会话后即刷新，不等轮询）。
		this.notifyConversationChanged();
		this.flushSnapshot();
	}

	/** 左栏「运行的对话」的展示口径（issue #140）。
	 *
	 *  老口径只有 listed：新对话要等「被换到后台且仍在跑」才入列 —— 用户正在聊的
	 *  那条反而不在列表里（只有它一条时，左栏连「运行的对话」标题都不渲染，观感
	 *  像是对话丢了）。新口径把「当前对话 + 已经有内容」也算进来：有消息的对话
	 *  （或已被首条提示词命名 —— 命名与首条消息是同一时刻，见 prompt() 里的
	 *  rename 块）立刻出现在列表里；空白新对话仍然不入列（防连点「新建对话」
	 *  堆出一排空条目）。
	 *
	 *  只影响「列表里推什么」：listed 本身的语义、以及 displaceActive /
	 *  shouldRetainActive / MAX_OPEN_CONVERSATIONS 那套「什么算运行中」的规则
	 *  完全不变（换走时该释放的仍然释放，不会被这次展示口径改动永久钉在列表里）。
	 *  Display-only: retention and disposal rules are deliberately untouched. */
	private shownInRunningList(conv: Conversation): boolean {
		if (conv.listed) return true;
		if (conv.id !== this.activeId) return false;
		// 首条提示词给对话命名 = 用户真的开始聊了（此刻消息可能还没落进会话统计）。
		if (conv.title !== DEFAULT_CONV_TITLE) return true;
		try {
			return conv.session.getSessionStats().totalMessages > 0;
		} catch {
			// 会话替换中 —— 先不列，下一次 emit 会补上
			return false;
		}
	}

	/** Push every running conversation across ALL projects to the client. The
	 *  running-conversation list is global so a background run from another
	 *  workspace stays visible; clicking one switches both the conversation and
	 *  its project (see switchConversation). The client groups the list by cwd.
	 *  推什么见 shownInRunningList（listed + 当前对话有内容时）。 */
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
			if (!this.shownInRunningList(conv) && !visibleParents.has(conv.id)) continue;
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
				// 落盘会话才有文件（inMemory 子代理缺省）：右键复制路径 / AI 按 path 读历史时用。
				...(() => {
					try {
						const f = conv.session.sessionFile;
						return f ? { sessionFile: f } : {};
					} catch {
						return {};
					}
				})(),
				// 子代理带 error 标记：左栏红点提示（普通对话不参与）。
				...(conv.isSubagent ? this.subagentRunOutcome(conv) : {}),
				// 等答复的问卷：左栏「?」角标（主对话/子代理各自挂名下，切过去即可回答）。
				...(() => {
					const pq = this.getPendingQuestionForConv(conv.id);
					return pq ? { hasQuestion: true as const, questionId: pq.id, questionTitle: pq.title } : {};
				})(),
				parentId: conv.parentId,
			});
		}
		// issue #145：流式集合签名变化 → 通知其他客户端重推（左栏「另一处正在运行」近实时）。
		// 签名含等问卷态（问卷挂起/解决不改变流式集合，不带它已打开的别处页面永远看不到 `?`）。
		// elsewhere 口径含已结束的空闲行：签名同样覆盖它们（流式位 + 等问卷位），
		// 否则对方跑完（streaming→idle）或空闲行出现/消失时这边收不到重推。
		try {
			const sig = JSON.stringify(
				[...this.convs.values()]
					.filter((c) => this.conversationStreaming(c) || (!c.isSubagent && this.shownInRunningList(c)))
					.map((c) => `${c.id}:${this.conversationStreaming(c) ? 1 : 0}:${this.isWaitingOnUser(c.id) ? 1 : 0}`)
					.sort(),
			);
			if (sig !== this.lastRunningSig) {
				this.lastRunningSig = sig;
				this.onRunningChanged?.();
			}
		} catch {
			// 会话替换中——跳过本轮签名比较
		}
		const elsewhere = this.listExternalRunning?.() ?? [];
		this.emit({
			type: "conversations",
			conversations,
			activeId: this.activeId,
			// 为空时缺省（老快照字节一致）
			...(elsewhere.length > 0 ? { elsewhere } : {}),
		});
	}

	/** List persisted sessions for this client, newest first. */
	/** issue #145：上次 emit 时本实例流式对话 id 集合签名（含等问卷态，见 emitConversations）。
	 *  变化时经 onRunningChanged 让其他客户端重推 conversations（elsewhere 近实时）；
	 *  签名相等即停，天然防 ping-pong 循环。 */
	private lastRunningSig = "";

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

	/** 最近项目列表缓存：pushProjects 的全量扫盘（SessionManager.listAll +
	 *  existsSync 逐个校验）昂贵，切项目/新对话/跨客户端通知时频繁触发 ——
	 *  TTL 内直接复用并把当前 cwd 合并进去，不反复扫盘。 */
	private projectsCache: { at: number; projects: ProjectSummary[] } | null = null;
	private static readonly PROJECTS_CACHE_TTL = 15_000;
	private projectsInFlight: Promise<ProjectSummary[] | null> | null = null;

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

	/** 切项目时的会话列表刷新：历史面板没打开过就不扫盘（只清缓存），打开过
	 *  才重推 —— 首访切项目的转录解析不在关键路径上。 */
	private refreshSessionsOnSwitch(): void {
		this.invalidateSessionInfos();
		if (this.sessionsRequested) void this.refreshSessions();
	}

	private async pushSessions(): Promise<void> {
		if (!this.sessionsRequested) return;
		try {
			// Sessions live in the SDK default per-project dir
			// (<agentDir>/sessions/--<cwd>--/), the same files the pi CLI/TUI
			// use — one listing covers every conversation of the current folder.
			const infos = await this.loadSessionInfos();

			// 隐藏「被 fork 掉的父会话」，历史列表只保留每条 fork 链最新的链尾会话
			// （全文搜索 searchSessions 保留全部会话，不受此影响）。
			const normSessionPath = (p: string) => String(p).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
			const forkedParentPaths = new Set<string>();
			for (const info of infos) {
				if (typeof info.parentSessionPath === "string" && info.parentSessionPath) {
					forkedParentPaths.add(normSessionPath(info.parentSessionPath));
				}
			}
			const visibleInfos =
				forkedParentPaths.size > 0
					? (() => {
							const kept = infos.filter((info) => !forkedParentPaths.has(normSessionPath(info.path)));
							return kept.length > 0 ? kept : infos;
						})()
					: infos;

			const sessions = new Map<string, SessionSummary>();
			for (const s of visibleInfos) {
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
		this.invalidateProjectsCache();
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
			if (!isInsideSessionsDir(this.agentDir, abs)) {
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
			// 转录删了，sidecar 再留着就是孤儿，一起清掉（不存在不报错）。
			removeTouchSidecar(abs);
			// 转录删了，未发送草稿再留着就是孤儿，一起清掉。
			try {
				this.drafts.pruneSessionFile(abs);
			} catch {
				// ignore
			}
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
			if (!isInsideSessionsDir(this.agentDir, abs)) {
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
	 *  审查/后台唤醒等），与 dismissFinishedSubagents 的候选口径一致。
	 *  issue #181：终端只看用户终端，残留 AI bash 不算（随移出一起释放）。 */
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
			// Dismiss 口径：只看“用过”的用户终端（AI bash 不钉住，见上）。
			openTerminals: conv.terminals.countUserBlockingLive(),
			listed: false,
			promptedSinceActive: false,
			hasActiveSubagentRun: () => hasActiveSubagentRun({ sessionId: conv.session.sessionFile }),
			hasPendingWake: () => hasPendingWaitSubscription({ sessionId: conv.session.sessionFile }),
		});
	}

	/**
	 * 将内存子代理（inMemory）固化为普通持久化对话：
	 * 写入磁盘 .jsonl 会话文件，清除 isSubagent 标记，使它进入历史会话列表并长久保留。
	 */
	async persistConversation(id: string): Promise<void> {
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
		const sm = (conv.session as unknown as { sessionManager?: SessionManager }).sessionManager;
		if (!conv.isSubagent && sm?.isPersisted?.()) {
			this.emit({
				type: "notice",
				level: "info",
				text: `对话「${conv.title}」已是持久化对话，无需固化`,
				textEn: `Conversation "${conv.title}" is already persistent`,
			});
			return;
		}
		try {
			const cwd = conv.cwd || this.cwd;
			const sampleSm = SessionManager.create(cwd);
			const sessionDir = sampleSm.getSessionDir();
			if (!existsSync(sessionDir)) {
				mkdirSync(sessionDir, { recursive: true });
			}
			const timestamp = new Date().toISOString();
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
			const sessionId = sm?.getSessionId?.() || randomUUID();
			const sessionFile = join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);

			// 获取所有已存在的 entries 并写盘
			const entries = (sm as unknown as { fileEntries?: unknown[] })?.fileEntries ?? [];
			let entriesToWrite = entries;
			if (!entriesToWrite.some((e: unknown) => (e as { type?: string })?.type === "session")) {
				const header = {
					type: "session",
					version: 3,
					id: sessionId,
					timestamp,
					cwd,
				};
				entriesToWrite = [header, ...entriesToWrite];
			}
			writeFileSync(sessionFile, entriesToWrite.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

			// 切换 SessionManager 内部状态，后续消息自动追加写盘
			if (sm) {
				sm.setSessionFile(sessionFile);
				(sm as unknown as { sessionDir: string }).sessionDir = sessionDir;
				(sm as unknown as { persist: boolean }).persist = true;
				(sm as unknown as { flushed: boolean }).flushed = true;
			}
			conv.isSubagent = false;

			this.emitConversations();
			await this.pushProjects();
			this.flushSnapshot();

			this.emit({
				type: "notice",
				level: "info",
				text: `已将子代理「${conv.title}」固化为普通对话，并保存至历史记录`,
				textEn: `Solidified subagent "${conv.title}" into a regular conversation saved to history`,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.emit({
				type: "notice",
				level: "error",
				text: `固化子代理失败：${msg}`,
				textEn: `Failed to persist subagent: ${msg}`,
			});
		}
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
		if (!this.shownInRunningList(conv)) {
			// Not in list anyway — nothing to do. 展示口径见 shownInRunningList
			// （当前对话有内容时也在列表里，对它的 ✕ 必须真的移出，不能静默 no-op）。
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
		// issue #181：只看用户终端——AI bash（agentBash）是 agent 的内部执行记录，
		// 随对话一起释放（removeConversation 里 killAll），不得阻断移出；否则残留的
		// ai-bash-98/99 会把会话永久钉在列表里。用户亲手开且用过的终端仍拦截。
		if (conv.terminals.countUserBlockingLive() > 0) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `对话「${conv.title}」还有未关闭的终端，请先关闭终端后再移出`,
				textEn: `Conversation "${conv.title}" still has open terminals — close them before removing`,
			});
			return;
		}
		// 没动过的空 shell（点开终端 tab 自动建的那个）与 AI bash 不拦截：随对话一起释放
		// （removeConversation 里 killAll）。
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
						// Dismiss 口径：只看“用过”的用户终端（issue #181，AI bash 不钉住）。
						openTerminals: conv.terminals.countUserBlockingLive(),
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
			if (!isInsideSessionsDir(this.agentDir, targetPath)) {
				this.emit({
					type: "notice",
					level: "error",
					text: "只能打开会话目录中的对话记录",
					textEn: "Only transcripts inside the session directory can be opened",
				});
				this.flushSnapshot();
				return;
			}

			// A session may already be open in the running-conversation map. Reuse it
			// instead of creating a second writer for the same JSONL transcript.
			for (const conv of this.convs.values()) {
				const sessionFile = conv.session.sessionFile;
				if (sessionFile && resolve(sessionFile) === targetPath) {
					await this.switchConversation(conv.id);
					return;
				}
			}

			// issue #145：同一文件在别处已有持有者 —— 绝不建第二个 writer。
			// 正在跑：直接拒绝（否则两支 run 并发写同一份 JSONL，事后只有一支可读）；
			// 空闲：放行打开（只剩一处能发送时不会分叉），但提醒用户别处也开着，
			// 发消息前的 prompt() 守卫会再查一次（开时空闲、发时在跑的竞态也拦得住）。
			const owner = this.findSessionOwner?.(targetPath);
			if (owner && owner.isStreaming) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `该对话正在另一处运行中（「${owner.title}」），为避免两个 agent 同时写同一份记录，已停止打开。请等它结束后再试，或回到原窗口继续。`,
					textEn: `This conversation is running in another window ("${owner.title}"). Opening it here would create a second writer for the same transcript, so it was blocked. Wait for it to finish, or continue in the original window.`,
				});
				this.flushSnapshot();
				return;
			}
			if (owner) {
				// 对端已断开（标签页关了）只剩残留会话 —— 不打扰，直接开。
				if (owner.connected) {
					this.emit({
						type: "notice",
						level: "info",
						text: `提醒：该对话在另一处也开着（「${owner.title}」，当前空闲）。请只留一处发送消息，否则两边轮流发送会让历史分叉、其中一支事后不可见。`,
						textEn: `Note: this conversation is also open in another window ("${owner.title}", currently idle). Send new messages from only one place — alternating between two writers forks the history and hides one branch.`,
					});
				}
			}

			// #235：先修后开——坏转录到 open 后的 getBranch 会死循环，修完再读。
			// 单文件预扫描，健康文件只多一次小读；修过即弹提示（含压缩被打断）。
			this.repairTranscriptFileBeforeOpen(targetPath);
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
			this.noticeInterruptedCompaction(conv);
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
			const prevThinking = this.session.thinkingLevel ?? null;
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
					const pm = prevModel as unknown as { provider: string; id: string };
					// 先恢复 provider key，再 setModel（否则 checkAuth 鉴权失败）
					await this.restoreKeyForModel(`${pm.provider}/${pm.id}`, this.cwd);
					await this.session.setModel(prevModel);
				} catch {
					// model no longer resolvable — keep the default
				}
			}
			if (prevThinking) {
				try {
					this.session.setThinkingLevel(prevThinking as Parameters<AgentSession["setThinkingLevel"]>[0]);
				} catch {
					// model no longer supports previous thinking level
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
		const now = Date.now();
		const cached = this.projectsCache;
		// TTL 命中：直接复用（把当前 cwd 合并进去，刚 remember 的新项目也可见）。
		if (cached && now - cached.at < ClientSession.PROJECTS_CACHE_TTL) {
			this.emit({ type: "projects", projects: this.withCurrentCwd(cached.projects, now) });
			return;
		}
		// 已有扫描在跑：搭车等它，不要并发扫两遍盘。
		if (this.projectsInFlight) {
			try {
				const projects = await this.projectsInFlight;
				if (projects) this.emit({ type: "projects", projects: this.withCurrentCwd(projects, Date.now()) });
			} catch {
				/* 首发扫描已自行 emit 错误结果，这里不再补 */
			}
			return;
		}
		const run: Promise<ProjectSummary[] | null> = (async () => {
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
				this.projectsCache = { at: Date.now(), projects };
				this.emit({ type: "projects", projects });
				return projects;
			} catch {
				this.emit({ type: "projects", projects: [] });
				return null;
			} finally {
				this.projectsInFlight = null;
			}
		})();
		this.projectsInFlight = run;
		await run;
	}

	/** 缓存命中时把当前 cwd 并进去：命中则刷新 lastUsed 重排，未命中则补到首位
	 *  （remember 刚写入的新项目在 TTL 窗口内也可见，不必等下一次扫盘）。 */
	private withCurrentCwd(projects: ProjectSummary[], now: number): ProjectSummary[] {
		if (projects.some((p) => p.path === this.cwd)) {
			return projects
				.map((p) => (p.path === this.cwd && p.lastUsed < now ? { ...p, lastUsed: now } : p))
				.sort((a, b) => b.lastUsed - a.lastUsed);
		}
		return [{ path: this.cwd, lastUsed: now }, ...projects].slice(0, 20);
	}

	/** 最近项目缓存失效（用户显式移除项目后，下一次推送必须重扫）。 */
	private invalidateProjectsCache(): void {
		this.projectsCache = null;
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

	/**
	 * SCM「AI 生成提交信息」：用当前对话模型做一次 completeSimple 一次性补全
	 * （与视觉桥同一条通路）——不进对话上下文、不打断正在流式的回复。
	 * 恰好应答一次：任何失败都以 ok:false 的 scm_data（kind "commitmsg"）收尾，
	 * 前端按钮不会卡在转圈。
	 */
	async scmGenCommitMessage(reqId: number): Promise<void> {
		const lang = this.getLang();
		const cwd = this.conv?.cwd ?? this.cwd;
		const reply = (ok: boolean, extra: { text?: string; error?: string }) => {
			this.emit({ type: "scm_data", reqId, kind: "commitmsg", ok, ...extra });
		};
		const fail = (err: unknown) => {
			reply(false, { error: err instanceof Error ? err.message : String(err) });
		};
		try {
			const runtime = this.runtime.services.modelRuntime;
			const model = this.session?.model;
			if (!model) {
				throw new Error(
					pick(
						lang,
						"当前没有可用模型——先在顶栏选择一个模型再生成",
						"No model available — pick one in the top bar first",
						"scm.commitmsg.no.model",
					),
				);
			}
			const ctx = await scmCommitContext(cwd, () => lang);
			const input = buildCommitMsgInput(ctx, lang === "zh" ? "zh" : "en");
			if (!input) {
				throw new Error(
					pick(
						lang,
						"没有可描述的更改（工作区干净）",
						"Nothing to describe (working tree clean)",
						"scm.commitmsg.no.changes",
					),
				);
			}

			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), SCM_COMMITMSG_TIMEOUT_MS);
			// 提示词可配置（设置 → 提示词 → AI 提交信息）：追加/替换内置默认。
			const commitSettings = this.settingsSvc.current;
			const systemPrompt = buildCommitMsgPrompt(
				commitSettings.scmCommitMsgPromptMode === "replace" ? "replace" : "append",
				commitSettings.scmCommitMsgPrompt ?? "",
			);
			let msg: Awaited<ReturnType<typeof runtime.completeSimple>>;
			try {
				msg = await runtime.completeSimple(
					model,
					{
						systemPrompt,
						messages: [
							{
								role: "user",
								timestamp: Date.now(),
								content: [{ type: "text", text: input }],
							},
						],
					},
					{ signal: ac.signal, maxTokens: 400 },
				);
			} finally {
				clearTimeout(timer);
			}
			if (msg.stopReason === "error" || msg.stopReason === "aborted") {
				throw new Error(
					msg.errorMessage ||
						pick(
							lang,
							`模型异常终止（${msg.stopReason}）`,
							`Model terminated abnormally (${msg.stopReason})`,
							"scm.commitmsg.model.terminated",
						),
				);
			}
			const raw = msg.content
				.filter((b) => b.type === "text")
				.map((b) => (b as { text?: string }).text ?? "")
				.join("\n");
			const text = sanitizeCommitMessage(raw);
			if (!text) {
				throw new Error(
					pick(lang, "模型返回了空的提交信息", "The model returned an empty commit message", "scm.commitmsg.empty"),
				);
			}
			reply(true, { text });
		} catch (err) {
			if (isNotRepoError(err)) {
				fail(
					new Error(
						pick(lang, "当前目录不是 Git 仓库", "Current directory is not a Git repository", "scm.commitmsg.not.repo"),
					),
				);
				return;
			}
			if (err instanceof Error && /abort/i.test(`${err.name} ${err.message}`)) {
				fail(
					new Error(
						pick(
							lang,
							`生成提交信息超时（${Math.round(SCM_COMMITMSG_TIMEOUT_MS / 1000)} 秒）`,
							`Commit-message generation timed out (${Math.round(SCM_COMMITMSG_TIMEOUT_MS / 1000)}s)`,
							"scm.commitmsg.timeout",
						),
					),
				);
				return;
			}
			fail(err);
		}
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

	/** 文件树右键菜单：新建（空文件/空文件夹）。 */
	async createEntry(dir: string, name: string, kind: "file" | "dir"): Promise<void> {
		return this.files.createEntry(dir, name, kind);
	}

	/** 文件树右键菜单：同目录内重命名。 */
	async renameEntry(path: string, newName: string): Promise<void> {
		return this.files.renameEntry(path, newName);
	}

	/** 文件树右键菜单：删除文件/目录。 */
	async deleteEntry(path: string): Promise<void> {
		return this.files.deleteEntry(path);
	}

	/** 文件树右键菜单：复制/移动（move=true 即剪切粘贴）。 */
	async copyEntry(src: string, destDir: string, move?: boolean): Promise<void> {
		return this.files.copyEntry(src, destDir, move);
	}

	/** 文件树右键菜单：在系统资源管理器中定位（issue #187）。 */
	async revealEntry(path: string): Promise<void> {
		return this.files.revealEntry(path);
	}

	/** 文件树右键菜单：用系统默认应用打开文件（issue #187）。 */
	async openDefaultEntry(path: string): Promise<void> {
		return this.files.openDefaultEntry(path);
	}

	async makeDir(relPath: string, setAsCwd = false): Promise<void> {
		const created = await this.files.makeDir(relPath);
		if (created && setAsCwd) {
			await this.setCwd(created);
		}
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

	/** 当前项目的额外工作区根（空数组 = 单根）。 */
	get workspaceRoots(): string[] {
		return this.roots;
	}

	/**
	 * 设置当前项目的额外工作区根（宿主侧多根，见 protocol 的 set_workspace_roots）。
	 *
	 * 语义：AI 仍只在主 cwd 里干活（pi SDK 是单 cwd 模型），多根只影响「哪些路径算
	 * 工作区内」—— 右栏文件树可跨根浏览，插件的 host.fs / host.project.create 不必
	 * 再走授权就能读这些根（所以它是用户/宿主侧动作，不是插件能静默做的）。
	 *
	 * 归一化交给 ClientStateStore（只收绝对路径 / 去重 / 上限 8）。刻意**不**校验
	 * 目录是否存在：根可能是暂时断开的盘或挂载点，不该把用户设过的根静默清掉。
	 */
	async setWorkspaceRoots(roots: string[] | undefined): Promise<void> {
		const before = this.stateStore.getWorkspaceRoots(this.clientId, this.cwd);
		this.stateStore.saveWorkspaceRoots(this.clientId, this.cwd, roots ?? []);
		const saved = this.stateStore.getWorkspaceRoots(this.clientId, this.cwd);
		if (saved.length === before.length && saved.every((p, i) => p === before[i])) {
			// 没变化（重复点 / 重放的旧命令）：不打扰插件、不推快照。
			return;
		}
		this.roots = saved;
		try {
			// 同一个钩子：插件宿主要跟着把「工作区内的路径」重新算一遍。
			this.onCwdChanged?.(this.cwd, this.roots);
		} catch {
			/* 钩子异常不影响主流程 */
		}
		this.flushSnapshot();
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
				// 冷切换的 runtime 创建要 1~2s（扫技能/扩展）—— 先回一条 ack +
				// 快照，点击看起来不再 frozen；落地后再推第二次全量。
				this.emit({
					type: "notice",
					level: "info",
					text: `正在切换到工作目录：${abs}`,
					textEn: `Switching to directory: ${abs}`,
				});
				this.flushSnapshot();
				// First visit to this project: resume its most recent session —
				// unless that transcript is still held on another client (#145):
				// default-opening it would strand the tab on a conversation it
				// cannot use (the prompt guard refuses while streaming) with a
				// stale leaf that forks history once both sides send (idle-held
				// files fork the same way — 第二个写者不只跑着时才危险). Land
				// blank instead.
				let resumeSkipped: SessionOwnerInfo | null = null;
				// 别处无可见行时不扫目录（首访切项目的常见情形零开销）。
				if ((this.listExternalRunning?.() ?? []).length > 0) {
					try {
						const infos = await SessionManager.list(abs, piSessionsRoot());
						const recent = infos[0]?.path ? resolve(infos[0].path) : undefined;
						const owner = recent ? this.findSessionOwner?.(recent) : null;
						if (owner && (owner.connected || owner.isStreaming)) {
							resumeSkipped = owner;
						}
					} catch {
						// 列表失败不挡正常恢复
					}
				}
				const conversationId = this.nextConversationId();
				const terminals = this.makeTerminalManager(conversationId, abs);
				// #235：manager＋runtime 一起建，转录链损坏时修最近文件后重试一次
				// （见 openManagerAndRuntime）。blank（别处在跑）是全新空会话，不会坏。
				const opened = await this.openManagerAndRuntime(
					() => (resumeSkipped ? SessionManager.create(abs) : SessionManager.continueRecent(abs)),
					(m) =>
						createAgentSessionRuntime(this.makeRuntimeFactory(terminals, undefined, conversationId), {
							cwd: abs,
							agentDir: this.agentDir,
							sessionManager: m,
						}),
					async () => (await SessionManager.list(abs))[0]?.path,
				);
				const newRuntime = opened.runtime;
				if (opened.repair) {
					for (const n of this.transcriptRepairNotices(opened.repair)) this.emit(n);
				}
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
				if (resumeSkipped) {
					this.emit(
						resumeSkipped.isStreaming
							? {
									type: "notice",
									level: "info",
									text: `该项目最近的对话「${resumeSkipped.title}」正在另一处运行，为你停在了新对话 —— 直接打开会造出第二个写者。左栏「运行的对话」里能看到它（标着“另一处”），等它跑完再打开。`,
									textEn: `The most recent conversation ("${resumeSkipped.title}") is running in another window, so you landed on a new chat instead — opening it here would create a second writer. It is listed under Running chats (tagged "Elsewhere"); open it after it finishes.`,
								}
							: {
									type: "notice",
									level: "info",
									text: `该项目最近的对话「${resumeSkipped.title}」在另一处开着（当前空闲），为你停在了空白新对话 —— 可在左栏「运行的对话」里把它过户过来继续看，或从历史对话里打开（只留一处发送消息，否则历史分叉）。`,
									textEn: `The most recent conversation ("${resumeSkipped.title}") is still open in another window (currently idle), so you landed on a blank chat instead — take it over from Running chats (tagged "Elsewhere") or reopen it from History (send new messages from only one place, or the history will fork).`,
								},
					);
				}
			}

			this.pushTerminals();
			this.conv.promptedSinceActive = false;
			this.conv.lastActiveAt = Date.now();
			this.cwd = abs;
			this.roots = this.stateStore.getWorkspaceRoots(this.clientId, abs);
			// 模型/key 恢复不挡快照：后台做，带切换代际 guard（用户又切走就跳过，
			// 否则会把旧项目的 key 套到新对话上），做完补一次 flush 刷新模型栏。
			{
				const convId = this.activeId;
				void (async () => {
					try {
						await this.restoreProjectProviderKeysForCwd(abs);
						if (this.disposed || this.activeId !== convId || this.cwd !== abs) return;
						await this.restoreProjectModelForCwd(abs);
						if (this.disposed || this.activeId !== convId || this.cwd !== abs) return;
						this.flushSnapshot();
					} catch {
						/* 静默：恢复失败保持会话默认 */
					}
				})();
			}
			// 工作区跟随型插件（编辑器文件树等）同步切根。
			try {
				this.onCwdChanged?.(abs, this.roots);
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
			this.refreshSessionsOnSwitch();
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

	/** Switch to a specific model by "provider/id" (e.g. "anthropic/claude-sonnet-5").
	 *  失败时只发 notice 不抛错（UI 路径靠 notice 提示，见 cycleModel 等调用方）。
	 *  需要「失败即拒绝」的无头路径（插件/定时任务）用 switchModelOrThrow。 */
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
			// 先恢复 provider key，再 setModel（否则 checkAuth 鉴权失败）
			await this.restoreKeyForModel(modelId, this.cwd);
			await this.session.setModel(model);
			// Immediately remember the model + the key it uses for the current
			// project (not only after a turn). This is what makes project switching
			// restore both the model and the provider key.
			this.rememberProjectModel(modelId);
			// 换模型后按新模型的窗口重算软上限覆盖（按模型覆盖可能不同，issue #229）。
			this.applyCompactionOverrides();
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

	/** Set the GLOBAL default model ("provider/id"): projects with no memory
	 *  fall back to it (project memory wins). Also remembers the provider's
	 *  currently-active key globally so new projects restore the same {model,
	 *  key} pair. Shared across clients, persisted server-side. */
	async setDefaultModel(modelId: string): Promise<void> {
		try {
			const mr = this.runtime.services.modelRuntime;
			const slash = modelId.indexOf("/");
			if (slash <= 0 || slash === modelId.length - 1) {
				throw new Error(`无效的模型 ID：${modelId}`);
			}
			const provider = modelId.slice(0, slash);
			const id = modelId.slice(slash + 1);
			if (!mr.getModel(provider, id)) throw new Error(`模型不存在：${modelId}`);
			this.stateStore.saveDefaultModel(modelId);
			const active = this.modelAdmin.getActiveKeyName(provider);
			if (active) this.stateStore.saveDefaultProviderKey(provider, active);
			// 同步写入 SDK 的 settingsManager，使底层 session 创建时 findInitialModel 也能识别该默认模型
			try {
				this.session.settingsManager.setDefaultModelAndProvider(provider, id);
			} catch {
				/* 会话未就绪时忽略 */
			}
			this.pushDefaultModel();
			this.emit({
				type: "notice",
				level: "info",
				text: `🌍 已设全局默认模型 ${modelId}（新项目自动使用，项目记忆优先）`,
				textEn: `🌍 Global default model set to ${modelId} (new projects follow it; project memory wins)`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `设置全局默认模型失败：${(err as Error).message}`,
				textEn: `Failed to set global default model: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Clear the GLOBAL default model (new projects fall back to the SDK default). */
	clearDefaultModel(): void {
		this.stateStore.clearDefaultModel();
		try {
			this.session.settingsManager.setDefaultModelAndProvider(
				undefined as unknown as string,
				undefined as unknown as string,
			);
		} catch {
			/* 忽略 */
		}
		this.pushDefaultModel();
		this.emit({
			type: "notice",
			level: "info",
			text: "🌍 已清除全局默认模型（新项目回到 SDK 默认）",
			textEn: "🌍 Global default model cleared (new projects use the SDK default)",
		});
		this.flushSnapshot();
	}

	/** Push the current global default model (attach + after every change). */
	pushDefaultModel(): void {
		this.emit({ type: "default_model", modelId: this.stateStore.getDefaultModel() ?? null });
	}

	/** 切换模型，失败时抛出（无头路径专用：插件 host.chat / 定时任务）。
	 *  setModel 为兼容 UI 把异常吞成 notice（面板要能看到原因、调用方是 fire-and-forget），
	 *  无头路径拿不到那个 notice，于是「模型 ID 打错/没配密钥」会变成静默按旧模型跑 ——
	 *  账单与效果都和用户预期不符。这里统一改成响亮失败。 */
	async switchModelOrThrow(modelId: string): Promise<void> {
		await this.setModel(modelId);
		// 复核结果：读不到（无活跃对话）不阻断，读得到且不符才拒绝。
		// 注意 session 是 getter，无活跃对话时会抛，不能用 `?.` 兜底。
		let curId = "";
		try {
			const cur = this.session?.model;
			curId = cur ? `${cur.provider}/${cur.id}` : "";
		} catch {
			curId = "";
		}
		if (curId && curId !== modelId)
			throw new Error(`切换模型失败（${modelId}），当前仍是 ${curId} —— 请检查模型 ID 与供应商密钥`);
	}

	/** Set the thinking level for future turns. */
	setThinking(level: string): void {
		try {
			const thinkingLevel = level as Parameters<AgentSession["setThinkingLevel"]>[0];
			this.session.setThinkingLevel(thinkingLevel, { persist: true });
			const cur = this.session.model;
			if (cur) {
				this.session.settingsManager.setModelThinkingLevel(cur.provider, cur.id, thinkingLevel);
			}
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
			const nextLevel = this.session.cycleThinkingLevel({ persist: true });
			const cur = this.session.model;
			if (cur && nextLevel) {
				this.session.settingsManager.setModelThinkingLevel(cur.provider, cur.id, nextLevel);
			}
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
		this.modelAdmin.dispose();
		// 关机路径：Windows 下跳过 pty.kill()（issue #215 ConPTY 死锁），只做
		// TerminateProcess + 状态清理，句柄由 OS 在进程退出时回收。
		for (const conv of this.convs.values()) conv.terminals.killAll({ shutdown: true });
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
		// 同理关闭挂起的页面调用（以失败解析：对面是扩展，没有答可等）。
		this.cancelPendingPageCalls();
		this.bg.stop();
		for (const conv of this.convs.values()) {
			this.clearAllToolWatchdogs(conv);
			// 逐个对话回收 eval 内核；下面的兜底再清一次表（含已 delete 的残留）。
			disposeEvalSession(conv.id);
			conv.unsubscribe?.();
			try {
				await conv.runtime.dispose();
			} catch {
				// best effort
			}
		}
		disposeAllEvalKernels();
	}
}

/** issue #226：插件无头调用的工作目录校验（纯函数，可单测）。
 *  存在性语义与定时任务一致（须存在且为目录，不默默跑错目录）；另在
 *  Windows 下拒绝 SystemRoot 及其子树（如 C:\Windows\System32）——后台服务/
 *  快捷方式启动时宿主 cwd 常飘到 system32，直接跑就是高危误操作。 */
export function checkPluginCwd(cwd: string): { ok: boolean; abs?: string; error?: string } {
	const trimmed = String(cwd ?? "").trim();
	if (!trimmed) return { ok: false, error: "工作目录为空" };
	let abs: string;
	try {
		abs =
			process.platform === "win32" && /^[A-Za-z]:$/.test(trimmed) ? `${trimmed.toUpperCase()}${sep}` : resolve(trimmed);
	} catch {
		return { ok: false, error: `工作目录非法：${trimmed}` };
	}
	try {
		if (!statSync(abs).isDirectory()) throw new Error("not-a-dir");
	} catch {
		return { ok: false, error: `目标项目不存在或不是目录：${trimmed}` };
	}
	if (process.platform === "win32") {
		const sysRoot = (process.env.SystemRoot || process.env.windir || "C:\\Windows")
			.replace(/\//g, "\\")
			.replace(/\\+$/, "");
		const norm = abs.replace(/\//g, "\\").replace(/\\+$/, "");
		const low = norm.toLowerCase();
		const rootLow = sysRoot.toLowerCase();
		if (low === rootLow || low.startsWith(`${rootLow}\\`)) {
			return { ok: false, error: `拒绝在系统目录执行：${abs}（请在插件设置里指定项目工作目录）` };
		}
	}
	return { ok: true, abs };
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
	/** index.ts 注入：内置调度存储（attach 时拷贝到每个新会话，供 schedule_* 工具）。 */
	schedulerStore: SchedulerStore | undefined = undefined;
	private clients = new Map<string, ClientSession>();
	/** 全局认领表（跨浏览器标签页共享；<dataDir>/claims.json，best-effort 持久化）。 */
	private claimStore: ClaimStore;
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
	/** 任意客户端成功切换工作区后触发（新绝对路径 + 该项目的额外工作区根）。
	 *  index.ts 接到 PluginManager.notifyCwd / notifyWorkspaceRoots，让插件宿主的
	 *  host.cwd 实时跟随当前项目、受支持路径范围跟着多根变。 */
	onClientCwdChanged: ((cwd: string, roots: string[]) => void) | undefined = undefined;

	constructor(
		private cwd: string,
		stateFile: string,
	) {
		this.stateStore = new ClientStateStore(stateFile);
		this.claimStore = new ClaimStore(join(this.stateStore.dataDir, "claims.json"));
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

	/** issue #145：除请求方外是否有客户端正在跑（扫目录查重前置的无 I/O 判断）。 */
	hasStreamingElsewhere(excludeClientId: string): boolean {
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			try {
				if (cs.activeConversations() > 0) return true;
			} catch {
				// 单客户端坏了不影响判断
			}
		}
		return false;
	}

	/** issue #145：跨客户端同会话查重 —— 找持有某 session 文件的别处对话。
	 *  调用方在 SessionManager.open() 之前问这一句，就造不出第二个 writer。 */
	findSessionOwner(targetPath: string, excludeClientId: string): SessionOwnerInfo | null {
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			const conv = cs.findConversationBySessionFile(targetPath);
			if (conv) {
				return {
					clientId,
					title: conv.title,
					cwd: conv.cwd,
					isStreaming: cs.conversationStreaming(conv),
					connected: cs.sinkCount() > 0,
				};
			}
		}
		return null;
	}

	/** 插件 steer 跨客户端兜底：除请求方外逐个问其他客户端的 conversations，
	 *  找到持有方由其执行 steer（只调 steerOwnConversation，不碰钩子，无递归）；
	 *  都找不到回 undefined，调用方回未知对话。单客户端异常跳过，不影响其他。 */
	async steerElsewhere(
		excludeClientId: string,
		id: string,
		text: string,
	): Promise<{ ok: boolean; error?: string } | undefined> {
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			try {
				const r = await cs.steerOwnConversation(id, text);
				if (r) return r;
			} catch {
				// 单客户端坏了继续找下一个
			}
		}
		return undefined;
	}

	/** issue #193：定时任务唤醒发起对话。逐个客户端找持有方，用 steer 语义投递
	 *  （运行时插队、未跑时普通投递，不切用户当前对话）；都找不到回 ok:false，
	 *  调用方（index.ts executor）回落视口/无头执行。quiesced 时直接拒绝。
	 *  issue #226：成功时带回持有方 clientId（插件绑定网页会话时原样回执）。
	 *  issue #231：opts.sessionFile 是跨压缩/重启的稳定键 —— 优先按它认同一会话
	 *  （内存对话 id 重启即失效，压缩后同文件对话可能已换新 id，成功时带回**实际**
	 *  投递的 conversationId + sessionFile，调用方据此重绑定任务）；id 相位带 cwd
	 *  护栏（各客户端计数器都从 c1 开始，不校验会把报告投进无关项目）。压缩进行中
	 *  的持有方回 busy:true（调用方另寻视口兄弟，而不是当成“不在”静默转无头）。 */
	async wakeConversation(
		id: string,
		text: string,
		opts?: { sessionFile?: string; cwd?: string },
	): Promise<{
		ok: boolean;
		conversationId?: string;
		sessionFile?: string;
		clientId?: string;
		busy?: boolean;
		error?: string;
	}> {
		const wantFile = String(opts?.sessionFile ?? "").trim();
		const wantCwd = String(opts?.cwd ?? "").trim();
		if ((!id && !wantFile) || !text.trim()) return { ok: false, error: "唤醒目标或文本为空" };
		if (this.quiesced) return { ok: false, error: "服务器正忙（quiesced），请稍后重试" };
		const liveFile = (c: Conversation): string => {
			try {
				return String(c.session.sessionFile ?? "");
			} catch {
				return "";
			}
		};
		const flush = (cs: ClientSession): void => {
			try {
				cs.flushSnapshot();
			} catch {
				// 推送失败不影响已投递的唤醒
			}
		};
		// 相位一：落盘会话文件（稳定键）。同文件可能在多处打开，取最近活跃者；
		// 全部忙（压缩中）则报 busy，调用方去找视口兄弟。
		if (wantFile) {
			const hits: { cs: ClientSession; clientId: string; conv: Conversation }[] = [];
			for (const [clientId, cs] of this.clients) {
				try {
					const conv = cs.resolveSchedulerTarget({ sessionFile: wantFile });
					if (conv) hits.push({ cs, clientId, conv });
				} catch {
					// 单客户端坏了继续找下一个
				}
			}
			hits.sort((a, b) => b.conv.lastActiveAt - a.conv.lastActiveAt);
			let busyError: string | undefined;
			for (const h of hits) {
				try {
					const r = await h.cs.trySteerScheduler(h.conv, text);
					if (r.ok) {
						flush(h.cs);
						return { ok: true, conversationId: h.conv.id, sessionFile: liveFile(h.conv), clientId: h.clientId };
					}
					if (r.busy) busyError = r.error;
					// 非忙失败（投递异常）试下一个同文件持有方
				} catch {
					// 单客户端坏了继续找下一个
				}
			}
			if (hits.length > 0) {
				if (busyError) return { ok: false, busy: true, error: busyError };
				// 同文件持有方都在但都投递失败 —— id 相位大概率指向同一批，无需再试
				return { ok: false, error: "目标对话投递失败（持有方异常）" };
			}
			// 无同文件持有方 —— 老任务只有 id，继续相位二
		}
		// 相位二：内存对话 id（易失键，必须配 cwd 护栏防跨项目串台）。
		if (id) {
			const hits: { cs: ClientSession; clientId: string; conv: Conversation }[] = [];
			for (const [clientId, cs] of this.clients) {
				try {
					const conv = cs.resolveSchedulerTarget({
						conversationId: id,
						...(wantCwd ? { cwd: wantCwd } : {}),
					});
					if (conv) hits.push({ cs, clientId, conv });
				} catch {
					// 单客户端坏了继续找下一个
				}
			}
			hits.sort((a, b) => b.conv.lastActiveAt - a.conv.lastActiveAt);
			let busyError: string | undefined;
			for (const h of hits) {
				try {
					const r = await h.cs.trySteerScheduler(h.conv, text);
					if (r.ok) {
						flush(h.cs);
						return { ok: true, conversationId: h.conv.id, sessionFile: liveFile(h.conv), clientId: h.clientId };
					}
					if (r.busy) busyError = r.error;
				} catch {
					// 单客户端坏了继续找下一个
				}
			}
			if (busyError) return { ok: false, busy: true, error: busyError };
		}
		return { ok: false, error: "目标对话不在运行中（已关闭或服务重启过）" };
	}

	/** issue #231：同项目视口回退 —— 原绑定对话不在时，把唤醒投给该项目最近活跃
	 *  的对话（用户当前正看着的面），而不是静默转无头。excludeIds 跳过已知忙对话；
	 *  候选全部忙回 busy:true；无候选回 ok:false。成功带回实际投递方（调用方重绑定）。 */
	async wakeViewportInCwd(
		cwd: string,
		text: string,
		excludeIds?: Set<string>,
	): Promise<{
		ok: boolean;
		conversationId?: string;
		sessionFile?: string;
		clientId?: string;
		busy?: boolean;
		error?: string;
	}> {
		const want = String(cwd ?? "").trim();
		if (!want || !text.trim()) return { ok: false, error: "回退目标或文本为空" };
		if (this.quiesced) return { ok: false, error: "服务器正忙（quiesced），请稍后重试" };
		const cands: { cs: ClientSession; clientId: string; conv: Conversation }[] = [];
		for (const [clientId, cs] of this.clients) {
			try {
				const conv = cs.findViewportInCwd(want, excludeIds);
				if (conv) cands.push({ cs, clientId, conv });
			} catch {
				// 单客户端坏了继续找下一个
			}
		}
		cands.sort((a, b) => b.conv.lastActiveAt - a.conv.lastActiveAt);
		if (cands.length === 0) return { ok: false, error: "同项目无存活对话" };
		let busyError: string | undefined;
		for (const c of cands) {
			try {
				const r = await c.cs.trySteerScheduler(c.conv, text);
				if (r.ok) {
					try {
						c.cs.flushSnapshot();
					} catch {
						// 推送失败不影响已投递的唤醒
					}
					let f = "";
					try {
						f = String(c.conv.session.sessionFile ?? "");
					} catch {
						f = "";
					}
					return { ok: true, conversationId: c.conv.id, sessionFile: f, clientId: c.clientId };
				}
				if (r.busy) busyError = r.error;
			} catch {
				// 单客户端坏了继续找下一个
			}
		}
		if (busyError) return { ok: false, busy: true, error: busyError };
		return { ok: false, error: "同项目对话投递失败" };
	}

	/** issue #145：别处在某 cwd 下正在跑的对话（同项目并行感知用，不含请求方）。 */
	listProjectRunners(cwd: string, excludeClientId: string): ProjectRunnerInfo[] {
		const out: ProjectRunnerInfo[] = [];
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			for (const r of cs.streamingInCwd(cwd)) out.push({ clientId, title: r.title, sessionFile: r.sessionFile });
		}
		return out;
	}

	/** 按 SDK 会话（runtime 身份）找它当前归属的客户端会话与对话 id（过户后归属会变）：
	 *  桥接工具（问卷 / 页面）在调用瞬间用它投递，见 ClientSession.bridgeTarget。
	 *  一条对话任一时刻只属于一个会话（过户先摘后插），扫一遍即可 —— 问卷/截图都是
	 *  低频调用，不值得为此再维护一张全局索引。 */
	findConversationHome(sdkSession: AgentSession): { session: ClientSession; convId: string } | undefined {
		for (const cs of this.clients.values()) {
			try {
				const convId = cs.conversationIdOfSession(sdkSession);
				if (convId) return { session: cs, convId };
			} catch {
				// 单客户端坏了不影响解析
			}
		}
		return undefined;
	}

	/** issue #145：别处所有正在跑的对话（左栏 elsewhere 只读感知 + 手动过户用）。
	 *  owner/convId 标识过户目标（手动过户入口）；DSH 引擎不填（不可过户）。 */
	listExternalRunning(excludeClientId: string): ElsewhereRunning[] {
		const out: ElsewhereRunning[] = [];
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			for (const r of cs.streamingSummariesAll()) out.push({ ...r, owner: clientId });
		}
		return out;
	}

	/** issue #145：某客户端流式集合变化 → 其他客户端重推 conversations。 */
	pokeExternalRunning(excludeClientId: string): void {
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			try {
				cs.refreshExternalRunning();
			} catch {
				// 单客户端坏了不影响其他
			}
		}
	}

	/** issue #145：向除请求方外的所有客户端发一条 notice（并行通告用）。 */
	notifyClientsExcept(
		excludeClientId: string,
		msg: { type: "notice"; level: "info" | "warning" | "error"; text: string; textEn?: string },
	): void {
		for (const [clientId, cs] of this.clients) {
			if (clientId === excludeClientId) continue;
			try {
				// 经 ClientSession.emit 才能进该客户端的 sink 组播；用公开发送面。
				cs.sendNotice(msg);
			} catch {
				// 单客户端坏了不影响其他
			}
		}
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

	/** 插件无头调用（host.chat 的落地）：外部通道（微信等）把文本投给 agent。
	 *  每个 (pluginId, accountId) 独立伪客户端——复用 attach 完整链路
	 *  （会话恢复/持久化/工具注入/快照），无浏览器也能跑；sink 是空函数，
	 *  快照/notice 发了即丢，不攒内存。fire-and-forget：prompt 投递即返回，
	 *  运行结果经 onRunEvent(run_end) 按 conversationId 关联。
	 *  v1 语义：与该服务 cwd 下最近会话共享（单用户视角连续）；peer 名由插件
	 *  拼进文本前缀，per-peer 会话隔离以后再加。
	 *  issue #226：对齐定时任务的四件套——conversationId 命中时走 steer 语义
	 *  投递（网页端实时可见，miss 则回落无头）；cwd 显式 pin 住（不存在/系统
	 *  目录即拒绝，不默默跑错目录）；model/thinkingLevel 投递前应用（失败即
	 *  拒绝，不回落，避免账单/效果与预期不符）。 */
	async chatFromPlugin(pluginId: string, req: PluginChatRequest): Promise<PluginChatResult> {
		const safe = String(pluginId ?? "plugin").replace(/[^A-Za-z0-9_-]/g, "") || "plugin";
		const acct = String(req?.accountId ?? "default").replace(/[^A-Za-z0-9_-]/g, "") || "default";
		const clientId = `plugin:${safe}:${acct}`;
		const text = String(req?.text ?? "");
		if (!text.trim()) throw new Error("chatFromPlugin: text 为空");
		if (this.quiesced) throw new QuiesceRejectedError("插件无头调用被拒绝，请等服务器恢复后重试");
		// 1. 绑定已有会话：steer 语义投递，网页端实时可见（微信当远程遥控器用）。
		// miss/已回收时不抛错，回落无头伪客户端（浏览器关着时微信照常可用）。
		const target = String(req?.conversationId ?? "").trim();
		if (target) {
			const w = await this.wakeConversation(target, text);
			if (w.ok) return { conversationId: target, clientId: w.clientId ?? clientId };
		}
		// 2. 工作空间：不传回落伪客户端当前目录；传了必须存在且非系统目录。
		const cwdReq = String(req?.cwd ?? "").trim();
		let cwdAbs = "";
		if (cwdReq) {
			const chk = checkPluginCwd(cwdReq);
			if (!chk.ok) throw new Error(`chatFromPlugin: ${chk.error}`);
			cwdAbs = chk.abs ?? "";
		}
		const cs = await this.attach(clientId, () => {});
		try {
			if (cwdAbs && cs.cwd !== cwdAbs) await cs.setCwd(cwdAbs);
		} catch (err) {
			throw new Error(`chatFromPlugin: 切换工作目录失败（${cwdAbs}）：${(err as Error).message}`);
		}
		const model = String(req?.model ?? "").trim();
		if (model) {
			try {
				await cs.switchModelOrThrow(model);
			} catch (err) {
				throw new Error(`chatFromPlugin: 切换模型失败（${model}）：${(err as Error).message}`);
			}
		}
		const thinking = String(req?.thinkingLevel ?? "").trim();
		if (thinking) {
			try {
				cs.setThinking(thinking);
			} catch (err) {
				throw new Error(`chatFromPlugin: 切换思考强度失败（${thinking}）：${(err as Error).message}`);
			}
		}
		const conversationId = cs.readConversationForPlugins()?.conversationId ?? "";
		void cs.prompt(text);
		return { conversationId, clientId };
	}

	/** 内置定时任务的无头执行（issue #184，server/scheduler-tasks.ts 的 executor）。
	 *  每个任务独立伪客户端 `scheduler:<taskId>`（专属会话连续、无浏览器也能跑）；
	 *  cwd 按任务配置 pin 住（不存在即失败，不默默跑错目录）；可选模型/思考强度
	 *  在投递前应用（失败即返回错误，不回落，避免账单/效果与预期不符）。
	 *  fire-and-forget 投递后等待运行结束（最长 10 分钟轮询），回填真实 outcome
	 * （成功/失败/耗时/会话 id）供历史记录与通知使用；超时按失败记录（运行本身
	 *  不中止，继续在后台跑完）。 */
	async chatFromScheduler(task: {
		id: string;
		cwd: string;
		prompt: string;
		model?: string;
		thinkingLevel?: string;
	}): Promise<{ ok: boolean; conversationId?: string; error?: string }> {
		const safe = String(task.id ?? "task").replace(/[^A-Za-z0-9_-]/g, "") || "task";
		const clientId = `scheduler:${safe}`;
		const text = String(task.prompt ?? "");
		if (!text.trim()) return { ok: false, error: "触发指令为空" };
		if (this.quiesced) return { ok: false, error: "服务器正忙（quiesced），请稍后重试" };
		const cwd = String(task.cwd ?? "").trim();
		try {
			if (!cwd || !statSync(cwd).isDirectory()) throw new Error("not-a-dir");
		} catch {
			return { ok: false, error: `目标项目不存在或不是目录：${cwd || "（空）"}` };
		}
		try {
			const cs = await this.attach(clientId, () => {});
			if (cs.cwd !== cwd) await cs.setCwd(cwd);
			const model = String(task.model ?? "").trim();
			if (model) {
				try {
					await cs.switchModelOrThrow(model);
				} catch (err) {
					return { ok: false, error: `切换模型失败（${model}）：${(err as Error).message}` };
				}
			}
			const thinking = String(task.thinkingLevel ?? "").trim();
			if (thinking) {
				try {
					cs.setThinking(thinking);
				} catch (err) {
					return { ok: false, error: `切换思考强度失败（${thinking}）：${(err as Error).message}` };
				}
			}
			const conversationId = cs.readConversationForPlugins()?.conversationId ?? "";
			void cs.prompt(`[定时任务] ${text}`);
			// 等待运行结束：每 2s 轮询，最长 10 分钟。超时按失败记录（运行继续）。
			const deadline = Date.now() + 10 * 60 * 1000;
			for (;;) {
				await new Promise((r) => setTimeout(r, 2000));
				let streaming = false;
				let lastError: string | undefined;
				try {
					const snap = cs.readConversationForPlugins();
					streaming = snap?.isStreaming === true;
					const msgs = snap?.messages ?? [];
					for (let i = msgs.length - 1; i >= 0; i--) {
						const m = msgs[i];
						if (m.role === "assistant" && m.errorMessage) {
							lastError = m.errorMessage;
							break;
						}
						if (m.role === "assistant") break;
					}
				} catch {
					streaming = false;
				}
				if (!streaming) {
					if (lastError) return { ok: false, conversationId: conversationId || undefined, error: lastError };
					return { ok: true, conversationId: conversationId || undefined };
				}
				if (Date.now() >= deadline)
					return { ok: false, conversationId: conversationId || undefined, error: "运行超时（10 分钟），仍在后台继续" };
			}
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	/** 插件直调模型（host.llm.complete 的落地）：孤立无工具的一次性补全。
	 *  不建对话、不进历史、不碰任何会话状态；花费走用户自己的模型额度。
	 *  quiesced 时拒绝；无客户端时用进程 cwd + 默认模型照常跑。 */
	async completeForPlugins(
		pluginId: string,
		req: { prompt?: string; system?: string; model?: string; maxChars?: number; timeoutMs?: number },
	): Promise<{
		ok: boolean;
		text?: string;
		model?: string;
		usage?: { input: number; output: number };
		error?: string;
	}> {
		try {
			if (this.quiesced) return { ok: false, error: "插件 LLM 调用被拒绝，请等服务器恢复后重试" };
			let env: { cwd: string; agentDir: string; fallbackModel?: { provider: string; id: string } };
			const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
			try {
				const cs = this.pluginClient();
				env = cs?.llmEnvForPlugins() ?? { cwd: this.cwd, agentDir };
			} catch {
				env = { cwd: this.cwd, agentDir };
			}
			const mod = await import("./plugin-llm.js");
			const r = await mod.completeWithIsolatedSession(env, { ...req, prompt: String(req?.prompt ?? "") });
			if (!r.ok) return r;
			console.log(`[plugin:${pluginId}] llm.complete ok（模型 ${r.model}，输出 ${r.text.length} 字）`);
			return r;
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
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

	/** 插件/调度伪客户端：sink 常驻（fire-and-forget 的空函数），不能按浏览器存活判断。 */
	private static isPseudoClientId(id: string): boolean {
		return id.startsWith("plugin:") || id.startsWith("scheduler:");
	}

	/**
	 * 浏览器重启认领：给 fresh clientId 找一个可接管的断开残留会话（返回旧 id）。
	 * 有别的在线浏览器时返回 null（issue #10 隔离优先）。
	 * 全同步：attach 里的认领段不含 await，并发的新标签后到者看到 sinkCount>0，
	 * 不会抢走同一个残留。
	 */
	private findAdoptableOrphan(excludeClientId: string): { oldId: string; cs: ClientSession } | null {
		const cands: OrphanCandidate[] = [];
		for (const [id, cs] of this.clients) {
			if (id === excludeClientId) continue;
			const pseudo = AgentService.isPseudoClientId(id);
			let live = false;
			let streaming = 0;
			let adoptable = false;
			let activity = 0;
			try {
				live = cs.sinkCount() > 0;
			} catch {
				live = false;
			}
			if (!pseudo && !live) {
				try {
					streaming = cs.activeConversations();
				} catch {
					streaming = 0;
				}
				try {
					adoptable = cs.hasAdoptableContent();
				} catch {
					adoptable = false;
				}
				try {
					activity = cs.latestActivity();
				} catch {
					activity = 0;
				}
			}
			cands.push({ id, live, pseudo, streaming, adoptable, activity });
		}
		const picked = pickAdoptableOrphan(cands);
		if (!picked) return null;
		const cs = this.clients.get(picked);
		return cs ? { oldId: picked, cs } : null;
	}

	/**
	 * 跨客户端感知接线（同会话查重 / 同项目并行 / elsewhere 列表 / 跨端 steer）。
	 * attach 尾部与认领分支共用 —— 认领换了 map 键，必须在首帧推送（attachSink）
	 * 前就按新 id 重接，否则 self-exclusion 失效：把自己当成“另一处”（elsewhere
	 * 误报 + prompt/switch 自拦）。尾部会再调一次，幂等。
	 */
	private wireClient(cs: ClientSession, clientId: string): void {
		cs.findSessionOwner = (targetPath) => this.findSessionOwner(targetPath, clientId);
		cs.hasStreamingElsewhere = () => this.hasStreamingElsewhere(clientId);
		cs.listProjectRunners = (cwd) => this.listProjectRunners(cwd, clientId);
		cs.getClaimStore = () => this.claimStore;
		cs.findConversationHome = (sdkSession) => this.findConversationHome(sdkSession);
		cs.listExternalRunning = () => this.listExternalRunning(clientId);
		cs.notifyExternalClients = (msg) => this.notifyClientsExcept(clientId, msg);
		cs.onRunningChanged = () => this.pokeExternalRunning(clientId);
		cs.steerConversationElsewhere = (id, text) => this.steerElsewhere(clientId, id, text);
		cs.schedulerStore = this.schedulerStore;
	}

	/**
	 * 手动过户（take_over_conversation）：把 owner 会话的某主对话（含子代理后代、
	 * 等答复问卷/页调用）整体搬到 target 会话并切过去。搬的是 runtime 本体不是
	 * 副本，单 writer 不变 —— 从在线标签页手里接管也是安全的；源会话修好 active
	 * 并推全量刷新，双方都收到去向通知。quiesce 排空期也放行（重连既有工作）。
	 */
	async takeOverConversation(targetId: string, ownerId: string, convId: string): Promise<void> {
		const target = this.clients.get(targetId);
		if (!target) return;
		const fail = (text: string, textEn: string): void => {
			target.sendNotice({ type: "notice", level: "warning", text, textEn });
		};
		if (!ownerId || !convId) {
			fail("过户目标不明确（缺 owner/id），请重试", "Takeover target unclear (missing owner/id), please retry.");
			return;
		}
		if (ownerId === targetId) {
			// 自己的对话 → 退化为普通切换。
			try {
				await target.switchConversation(convId);
			} catch {
				/* switch 内部已用 notice 报错 */
			}
			return;
		}
		if (AgentService.isPseudoClientId(ownerId)) {
			fail("定时任务/插件会话不支持过户", "Scheduler/plugin sessions cannot be taken over.");
			return;
		}
		const source = this.clients.get(ownerId);
		if (!source) {
			fail("对方会话已不存在，可从历史对话里直接打开", "The source session is gone; reopen it from History instead.");
			target.refreshExternalRunning();
			return;
		}
		const briefs = source.takeoverBriefs();
		const main = briefs.find((b) => b.id === convId);
		if (!main) {
			fail(
				"对方已经没有这条对话（刚结束或被关闭），左栏稍后自动刷新",
				"That conversation is gone on the other side; the list refreshes shortly.",
			);
			target.refreshExternalRunning();
			return;
		}
		if (main.isSubagent) {
			fail(
				"只能过户主对话（子代理随主对话一起搬）",
				"Only main conversations can be taken over (subagents move with their parent).",
			);
			return;
		}
		const moveIds = [convId, ...collectSubagentDescendantIds(briefs, convId)];
		const moveSet = new Set(moveIds);
		// 容量：与 switchSession 同口径（目标项目非子代理 8 个）。
		const movedMains = briefs.filter((b) => moveSet.has(b.id) && !b.isSubagent).length;
		const openInProject =
			target.takeoverBriefs().filter((b) => b.cwd === main.cwd && !b.isSubagent).length + movedMains;
		if (openInProject > MAX_OPEN_CONVERSATIONS) {
			fail(
				`目标项目运行的对话已达上限（${MAX_OPEN_CONVERSATIONS} 个），请先打开某个对话并离开（不继续对话）以移出列表`,
				`This project already has the max open conversations (${MAX_OPEN_CONVERSATIONS}). Open one and leave it (without continuing) to remove it from the list.`,
			);
			return;
		}
		try {
			const detached = await source.detachTakeoverConversations(moveIds);
			if (!detached.ok) {
				fail(
					detached.reason === "empty"
						? "对方会话只剩这一条对话且服务排空中，稍后再试"
						: "对方已经没有这条对话（刚结束或被关闭），左栏稍后自动刷新",
					detached.reason === "empty"
						? "The source session only has this conversation and the server is draining; try later."
						: "That conversation is gone on the other side; the list refreshes shortly.",
				);
				if (detached.reason === "missing") target.refreshExternalRunning();
				return;
			}
			const newMainId = target.insertTakeoverConvs(detached.payload);
			// 源会话修好 active（detach 内部已处理）→ 推全量刷新 + 告知去向；
			// 无 sink 时 emit 即丢，无需判断。
			source.sendNotice({
				type: "notice",
				level: "info",
				text: `「${main.title}」已过户到另一处接管，本页不再持有它。`,
				textEn: `"${main.title}" was taken over by another page and is no longer held here.`,
			});
			target.sendNotice({
				type: "notice",
				level: "info",
				text: `已将「${main.title}」过户到当前页面，可直接继续查看与操作。`,
				textEn: `"${main.title}" was moved to this page — pick up right where it left off.`,
			});
			await target.switchConversation(newMainId);
		} catch (err) {
			fail(`过户失败：${(err as Error).message}`, `Takeover failed: ${(err as Error).message}`);
		}
	}

	/**
	 * 跨页作答预告（peek_elsewhere_question）：把 owner 会话里某对话的等答复问卷
	 *  原文取回 target 页展示。只读，不搬迁对话；问卷已不在则直说（并刷新左栏）。
	 */
	async peekElsewhereQuestion(targetId: string, ownerId: string, convId: string): Promise<void> {
		const target = this.clients.get(targetId);
		if (!target) return;
		const fail = (text: string, textEn: string): void => {
			target.sendNotice({ type: "notice", level: "warning", text, textEn });
		};
		if (!ownerId || !convId) {
			fail("问卷目标不明确（缺 owner/id），请重试", "Question target unclear (missing owner/id), please retry.");
			return;
		}
		if (ownerId === targetId) return; // 自己的问卷走本地通道，不需要预告
		if (AgentService.isPseudoClientId(ownerId)) {
			fail(
				"定时任务/插件会话的问卷不支持跨页作答",
				"Scheduler/plugin session questions cannot be answered cross-page.",
			);
			return;
		}
		const source = this.clients.get(ownerId);
		const q = source?.peekPendingQuestion(convId);
		if (!q) {
			fail(
				"那张问卷已不在（对方刚回答/取消或对话已结束）",
				"That question is gone (just answered/cancelled there, or the run ended).",
			);
			target.refreshExternalRunning();
			return;
		}
		target.pushElsewhereQuestion(ownerId, convId, q);
	}

	/**
	 * 跨页作答（question_answer 带 owner）：把本页提交的答案送到持有方会话。
	 * 问卷已不在（对方刚回答/取消）则明确告知，答案不吞不丢两不沾 —— 没送出就是没送出。
	 */
	async answerElsewhereQuestion(
		targetId: string,
		ownerId: string,
		id: string,
		answers: QuestionAnswer[],
		cancelled?: boolean,
	): Promise<void> {
		const target = this.clients.get(targetId);
		if (!target) return;
		const source = this.clients.get(ownerId);
		const ok = source ? source.resolveQuestion(id, answers, cancelled) : false;
		if (!ok) {
			target.sendNotice({
				type: "notice",
				level: "warning",
				text: "那张问卷已不在（对方刚回答/取消或对话已结束），你的回答没有送出",
				textEn:
					"That question is gone (just answered/cancelled there, or the run ended) — your answer was not delivered.",
			});
			target.refreshExternalRunning();
		}
	}

	/** Get or create the session for a client, racing attach calls safely. */
	async attach(clientId: string, send: (msg: ServerMessage) => void): Promise<ClientSession> {
		let cs = this.clients.get(clientId);
		if (!cs) {
			const inflight = this.pending.get(clientId);
			if (inflight) {
				cs = await inflight;
			} else {
				// 浏览器重启认领（clientId 存 sessionStorage，关浏览器即失；服务端残留
				// ClientSession 的运行中对话否则永远卡在“另一处”只读，连看都看不了）：
				// 无其他在线浏览器时，把最近断开的残留会话整体过户给这个新 id
				// （只换 map 键，不搬 runtime：对话/终端/订阅/cwd 原样保留，
				// 流式增量经尾部 attachSink 直接推给新 socket）。
				// 有其他在线标签时不认领（issue #10 隔离优先）；quiesce 排空期也放行
				// （这是重连既有工作，不是新工作）。本段无 await，并发 attach 原子。
				const orphan = this.findAdoptableOrphan(clientId);
				if (orphan) {
					this.clients.delete(orphan.oldId);
					this.clients.set(clientId, orphan.cs);
					cs = orphan.cs;
					// 先按新 id 重接（首帧 attachSink 的 elsewhere/self-exclusion 依赖它）。
					this.wireClient(cs, clientId);
					cs.noteAdopted();
					// 服务重启前记在旧 id 名下的中断记录搬到新 id 名下，尾部
					// resumeInterrupted 按新 id 消费（只认领一次，不重复恢复）。
					const inter = this.stateStore.takeInterrupted(orphan.oldId);
					if (inter?.length) this.stateStore.saveInterrupted(clientId, inter);
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
					// issue #145：新标签页默认恢复项目最近的会话 —— 若那条仍被别处持有
					// （跑着或空闲），建之前就决定空白（第二个 writer 根本不会被打开，
					// 也无需事后拆 runtime）。之前只拦 running：空闲持有照样恢复出双
					// writer，两边轮流发送分叉历史。其他客户端不存在时不扫目录。
					let createOpts: { blank?: boolean; blankTitle?: string; idleHeld?: boolean } | undefined;
					if (this.clients.size > 0) {
						try {
							const infos = await SessionManager.list(cwd, piSessionsRoot());
							const recent = infos[0]?.path ? resolve(infos[0].path) : undefined;
							const owner = recent ? this.findSessionOwner(recent, clientId) : null;
							if (owner && (owner.connected || owner.isStreaming)) {
								createOpts = { blank: true, blankTitle: owner.title, ...(owner.isStreaming ? {} : { idleHeld: true }) };
							}
						} catch {
							// 列表失败不挡正常恢复
						}
					}
					const creating = ClientSession.create(clientId, cwd, this.stateStore, createOpts).finally(() => {
						this.pending.delete(clientId);
					});
					this.pending.set(clientId, creating);
					cs = await creating;
					this.clients.set(clientId, cs);
					// issue #145 接线提前：首帧 elsewhere 依赖它。
					this.wireClient(cs, clientId);
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
		}
		// First attach after a restart: reopen sessions that were streaming
		// when the previous process shut down and continue them (consumed
		// once, then cleared). Fire-and-forget AFTER attachSink + hooks:
		// resume emits directly to sinks and needs the owner guards.
		// Progress arrives over the socket as usual.
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
		// issue #145 跨客户端感知接线（同会话查重 / 同项目并行 / elsewhere 列表）。
		this.wireClient(cs, clientId);
		// 插件宿主工作区跟随：初次接入也同步一次（恢复的 lastCwd 可能≠服务启动目录），
		// notifyCwd 幂等去重；此后 set_cwd 成功时由 cs.onCwdChanged 继续驱动。
		cs.onCwdChanged = (abs, roots) => this.onClientCwdChanged?.(abs, roots);
		this.onClientCwdChanged?.(cs.cwd, cs.workspaceRoots);
		void cs.resumeInterrupted(this.stateStore.takeInterrupted(clientId));
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

	/** 插件扩展点 v2：挑一个最合适的客户端会话供无浏览器调用的插件 API 用
	 *  （conversationLister/Searcher/Writer、modelLister、runAborter）。
	 *  有运行中对话的优先，否则任意残留客户端；一个没有时返回 undefined，
	 *  调用方（index.ts 注入）回退空列表 / {ok:false}，绝不抛错。 */
	pluginClient(): ClientSession | undefined {
		let fallback: ClientSession | undefined;
		for (const cs of this.clients.values()) {
			if (!fallback) fallback = cs;
			try {
				if (cs.activeConversations() > 0) return cs;
			} catch {
				// 单客户端坏了不影响挑选
			}
		}
		return fallback;
	}

	/** Snapshot still-streaming conversations for post-restart resume.
	 *  Called during graceful shutdown AND from the restart_service handler
	 *  (which exits without shutdown under systemd — without this, the
	 *  interrupted-run record would silently never be written there). */
	recordInterruptedRuns(): void {
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
	}

	async disposeAll(): Promise<void> {
		this.recordInterruptedRuns();
		const all = [...this.clients.values()];
		this.clients.clear();
		await Promise.all(all.map((cs) => cs.dispose()));
	}
}
