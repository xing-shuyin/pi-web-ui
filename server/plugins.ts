/**
 * pi-web-ui 插件管理器 —— 可选界面组件的加载与桥接。
 *
 * 一个插件 = <dataDir>/plugins/<id>/ 目录：
 *   manifest.json   元数据 { id?, name, version?, description? }（id 缺省取目录名）
 *   index.mjs       服务端入口（可选）：export default { activate(host) → deactivate? }
 *   client/         前端资源（可选），经 /plugins/<id>/client/* 以静态文件暴露；
 *     entry.mjs      视图入口：export default { mount(el, ctx) → cleanup? }
 *
 * 设计要点：
 * - 不装即不存在：目录不在就没有任何协议/UI 痕迹；每次客户端 attach 时重扫目录，
 *   新丢进来的插件无需重启服务即可出现在顶栏（import 只做一次并缓存）。
 * - id 必须匹配 ID_RE，防路径穿越；client 静态服务同样逐段校验。
 * - host 窄接口：broadcast(pluginId, payload) 广播 plugin_data、onMessage 注册
 *   客户端上行处理、dataDir/cwd/log 环境。发送通道由 index.ts 注入（每个 socket
 *   的 send 函数），插件本身不接触 ws。
 * - activate 抛错只标记 error 字段并记日志，绝不影响主进程。
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { cpSync, existsSync, readFileSync, readdirSync, renameSync, watch as fsWatch, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
	type ServerMessage,
	type UiMessage,
	type UiPluginAgentTool,
	type UiPluginInfo,
	type PluginRequires,
	type PluginApiCatalog,
	type UiContribution,
	type UiAlign,
	type UiArrangeOp,
	type UiPluginUi,
	type BgServer,
	type UiPluginSettingField,
	type UiPluginCatalogEntry,
	type PluginBusEvent,
	type PluginModelInfo,
	type PluginStats,
} from "./protocol.js";
import { UI_SLOTS } from "./plugin-ui-slots.js";
import { LeftPanelRunningStore } from "./left-panel-running.js";
import type { PluginPanelGroup } from "./protocol.js";
import { pick, type ServerLang } from "./i18n.js";
import { PluginStorage, PluginSecrets, ensurePluginDeps, WorkspaceFS, withFileRmwLock } from "./plugin-facilities.js";
import {
	parseCronSpec,
	armDelay,
	nextCronFire,
	loadScheduleRecords,
	saveScheduleRecords,
	type CronParts,
} from "./plugin-schedule.js";
import { PluginPermissionStore, type PermissionFamily } from "./plugin-permissions.js";
import { getAppVersion } from "./pkg-info.js";
import { readCatalog, addCustomEntry, removeCustomEntry, type CatalogAddInput } from "./plugin-catalog.js";
import { PluginGrantsStore, normalizeGrantPath } from "./plugin-grants.js";
import { normalizeIconSvg } from "./icon-svg.js";
import { PluginDomConsent, declarationWantsDom } from "./plugin-dom.js";
import { validatePluginManifest, formatManifestIssue, isKnownPermission } from "./plugin-manifest-validate.js";
import { buildPluginApiCatalog } from "./plugin-api-catalog.js";
import { AGENT_TOOL_CATALOG } from "./tool-manager.js";
import {
	applyPostEdit,
	denialText,
	freezeParams,
	isBlockingDecision,
	normalizePostEdit,
	normalizePreDecision,
	withGuardTimeout,
	type ToolPostHandler,
	type ToolPostRequest,
	type ToolPreHandler,
	type ToolPreRequest,
} from "./plugin-tool-guard.js";
// 工作区根的归一化与 client-state 共用一份（同一份语义：只收绝对路径 / 去重 / 上限）。
import { normalizeWorkspaceRoots } from "./client-state.js";
import { compareVersions, ensureBackup } from "./plugin-updater.js";
import {
	createProject,
	isInsideRoot,
	realPathOfNearest,
	type ProjectCreateSpec,
	type ProjectCreateResult,
} from "./plugin-project.js";
import {
	listAllMcpServers,
	checkMcpServer,
	installMcpServer,
	type McpCheckResult,
	type McpInstallSpec,
	type McpInstallResult,
} from "./mcp-manager.js";
import type { McpBridge } from "./mcp-bridge.js";
import type { UiMcpServer } from "./protocol.js";
import type { Request, Response } from "express";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** 合法插件 id：字母/数字/下划线/连字符，防路径穿越（同 themes.ts 的做法）。 */
const ID_RE = /^[A-Za-z0-9_-]+$/;

/** 插件收到的工具执行事件（agent-service 的 SDK tool_execution_start/end 转发）。 */
export interface PluginToolEvent {
	phase: "start" | "end";
	toolName: string;
	/** 事件所属对话（会话未就绪时可能为空）。 */
	conversationId?: string;
	/** SDK 工具调用 id（start/end 成对关联；旧插件忽略即可）。 */
	toolCallId?: string;
	/** end 独有：真实执行耗时毫秒 / 是否报错。 */
	durationMs?: number;
	isError?: boolean;
}

/** `host.getActiveConversation` 的取用参数（#542，纯新增）。
 *  - `clientId`：取该客户端（标签页）当前打开的对话；不给 = 全局回落。
 *  - `fallback`：回落口径。目前只有一种（默认也是它）：最近活跃的**非子代理**会话。
 *  插件不得借 `clientId` 读别的标签页之外的任何隐私：它只能拿到同一服务内已被
 *  hello 过的客户端 id。 */
export interface PluginConversationQuery {
	clientId?: string;
	fallback?: "latest-non-subagent";
}

/** 交给插件前的防御性拷贝：provider 回的是快照管线的**活引用** —— messages 数组与
 *  元素对象都被 60ms 推送管线缓存复用（lastMessagesArray / uiMessageCache），插件原地
 *  改一个字段/挪一个元素，污染的就是推给真实客户端的快照。浅拷数组 + 元素对象
 *  structuredClone；元素是纯 JSON 结构（details 已过 JSON.stringify 闸），structuredClone
 *  不会失败，JSON 往返只是万一携带不可克隆值时的兜底。
 *  `getActiveConversation` 与 `emitClientModelChanged` 共用（两处都要发快照给插件）。 */
function copySnapshotForPlugins(snap: PluginConversationSnapshot): PluginConversationSnapshot {
	return {
		...snap,
		messages: snap.messages.map((m) => {
			try {
				return structuredClone(m);
			} catch {
				try {
					return JSON.parse(JSON.stringify(m)) as typeof m;
				} catch {
					return { ...m }; // 连 JSON 往返都失败（循环引用）：至少不共享顶层对象
				}
			}
		}),
	};
}

/**
 * 当前打开对话的快照（host.getActiveConversation 返回，轨迹类插件用）。
 * messages/streamingMessage 是服务端只读缓存对象的引用——插件只读、不得修改，
 * 要广播/持久化必须先抽成摘要（截断封顶），禁止原样下发（单条可达 200K）。
 */
export interface PluginConversationSnapshot {
	/** 该快照归属的浏览器客户端（每标签页一个 clientId —— 插件用
	 *  `host.getActiveConversation({clientId})` 就能拿到「本页在看哪个对话」）。 */
	clientId: string;
	conversationId: string;
	/** 这是子代理对话（后台派发、无头）：缺省回落口径会跳过它，见
	 *  `server/plugin-conversation-view.ts`。显式带 clientId 时不跳过滤 ——
	 *  那时返回的就是该标签页真正在看的东西，由插件自己按本字段决定要不要用。 */
	isSubagent: boolean;
	/** 底层 Pi 会话的持久化 UUID（如 "01a0e6cd-00a5-7068-b3f2-1c62e7dd180f"；inMemory 为 undefined）。 */
	sessionId?: string;
	/** 会话持久化 JSONL 文件绝对路径。 */
	sessionFile?: string;
	/** 会话所属物理目录（即 <agentDir>/sessions/<encodedCwd>）。 */
	sessionDir?: string;
	title: string;
	/** 当前对话选中模型的 canonical id（如 "openai-codex/gpt-5"；未选/无为 undefined）。 */
	model?: string;
	/** 该对话最近活跃毫秒时间戳（多客户端时取最新者为“当前打开”）。 */
	at: number;
	isStreaming: boolean;
	messages: UiMessage[];
	streamingMessage: UiMessage | null;
	stats: {
		totalMessages: number;
		tokens: { input: number; output: number; total: number };
		cost: number;
	};
}

/**
 * 插件收到的智能体运行轨迹事件（agent-service 的 SDK 事件流转发，
 * host.onRunEvent 订阅）。一次用户任务对应一组事件：
 * run_start → (turn_start/message/tool_start/tool_end…交错) → run_end。
 *
 * 轨迹视图插件（如 run-trace）靠它把「收到任务 → 思考 → 工具调用 →
 * 文件改动 → 产出结果」聚成时间线；payload 全部截断封顶，可直接存/广播。
 */
export interface PluginRunEvent {
	type: "run_start" | "run_end" | "turn_start" | "turn_end" | "message" | "tool_start" | "tool_end";
	/** 事件所属对话。 */
	conversationId?: string;
	/** 事件毫秒时间戳（服务端时钟）。 */
	at: number;
	/** run_start：触发本轮的用户任务文本（截断 500 字；steer 等内部续跑为空）。 */
	task?: string;
	/** message：已定稿的一条消息（serialize.ts 同形，文本/参数已截断）。 */
	message?: UiMessage;
	/** tool_start/tool_end：SDK 工具调用 id（成对关联）。 */
	toolCallId?: string;
	/** tool_start/tool_end：工具名。 */
	toolName?: string;
	/** tool_start：调用参数 JSON（截断 4k）。 */
	argsText?: string;
	/** tool_end：结果文本预览（截断 4k）。 */
	resultText?: string;
	/** tool_end：真实执行耗时毫秒 / 是否报错。 */
	durationMs?: number;
	isError?: boolean;
	/** run_end：末条 assistant 的 stopReason（"aborted" 等，无则省略）。 */
	stopReason?: string;
}

/** 插件发起的无头 agent 调用请求（微信通道等外部消息驱动 agent 用）。
 *  fire-and-forget：prompt 投递即返回，运行结果经 onRunEvent(run_end)
 *  按 conversationId 关联（插件侧收尾回包）。
 *  issue #226：对齐定时任务（chatFromScheduler）的四件套——cwd 不传时回落
 *  该伪客户端当前目录（首次即宿主启动目录），传了则做存在性 + 系统目录校验。 */
export interface PluginChatRequest {
	/** 送给 agent 的任务文本（插件应已拼好发送者前缀、裁剪封顶）。 */
	text: string;
	/** 通道内的账号标识（多账号隔离：每个 accountId 独立伪客户端/会话）。 */
	accountId?: string;
	/** 可选：指定工作空间目录（须存在且为目录；Windows 下拒绝 SystemRoot
	 *  及其子树如 System32，防后台启动时 cwd 飘到 system32）。 */
	cwd?: string;
	/** 可选：绑定已有会话 ID（命中运行中对话时走 steer 语义投递，网页端实时
	 *  可见；miss/已回收时回落无头伪客户端执行，不静默丢消息）。 */
	conversationId?: string;
	/** 可选：指定模型（`provider/id` 格式，投递前切换，失败即拒绝不回落）。 */
	model?: string;
	/** 可选：指定思考强度（投递前切换，失败即拒绝不回落）。 */
	thinkingLevel?: string;
}

/** host.chat 的投递回执（运行中，结论经 run_end 事件）。 */
export interface PluginChatResult {
	conversationId: string;
	clientId: string;
}
/** host.conversations.list 的条目（running/history 等，kind 原样透传）。 */
export interface PluginConversationListItem {
	id: string;
	title: string;
	cwd: string;
	kind: string;
	isStreaming: boolean;
}

/**
 * 插件注册的 AI 工具（结构化定义，与 SDK ToolDefinition 解耦——由
 * agent-service 负责转换）。execute 返回 { content, details? }（content 为
 * [{type:"text",text}] 或图片块），或直接返回字符串/对象（自动包成文本）。
 */
export interface PluginAgentTool {
	/** 所属插件 ID（由 getAgentTools 等组装时附带）。 */
	pluginId?: string;
	/** 工具名（全局唯一；单 action 工具直接用具名，如 mail，重复注册后者被拒）。 */
	name: string;
	/** UI 显示标签。 */
	label?: string;
	/** 给 LLM 的工具描述。 */
	description: string;
	/** 可选：出现在系统提示词 Available tools 区的一行摘要。 */
	promptSnippet?: string;
	/** 可选：追加到系统提示词 Guidelines 的要点。 */
	promptGuidelines?: string[];
	/** 参数 JSON Schema（TypeBox/JSON Schema 兼容）。缺省为空对象。 */
	parameters?: Record<string, unknown>;
	/** 执行体；onUpdate 可流式上报部分结果（同形结构）。 */
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partial: unknown) => void,
	): Promise<unknown>;
}

/** 插件运行时日志级别（host.log 分级，缺省 info）。 */
export type PluginLogLevel = "debug" | "info" | "warn" | "error";

/** 插件运行时日志条目（内存环形缓冲，按需下发，不进 60ms 快照）。 */
export interface PluginLogEntry {
	/** 毫秒时间戳（服务端时钟）。 */
	ts: number;
	level: PluginLogLevel;
	/** 日志文本（截断 500 字符）。 */
	text: string;
}

/** 每插件保留最近 N 条运行时日志（内存封顶，防刷爆）。 */
export const PLUGIN_LOG_CAP = 200;
/** 单条日志文本截断上限（字符）。 */
export const PLUGIN_LOG_TEXT_MAX = 500;

const PLUGIN_LOG_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

/** host.log 首参归一：是合法级别即当级别，否则缺省 info
 *  （老插件 host.log(...args) 的兼容口径）。纯函数，可单测。 */
export function normalizePluginLogLevel(first: unknown): PluginLogLevel {
	return typeof first === "string" && PLUGIN_LOG_LEVELS.has(first) ? (first as PluginLogLevel) : "info";
}

/** host.log 参数 → 文本（string 原样，其余 JSON/String 化，空格拼接，截断封顶）。
 *  纯函数，可单测。 */
export function formatPluginLogText(args: unknown[]): string {
	const parts = args.map((a) => {
		if (typeof a === "string") return a;
		try {
			const s = JSON.stringify(a);
			return typeof s === "string" ? s : String(a);
		} catch {
			try {
				return String(a);
			} catch {
				return "[unprintable]";
			}
		}
	});
	const text = parts.join(" ");
	return text.length > PLUGIN_LOG_TEXT_MAX ? text.slice(0, PLUGIN_LOG_TEXT_MAX) : text;
}

/** 宿主保留的日志通道键（plugin_message 上行 / plugin_data 下行共用）。
 *  插件自己的 onMessage 收不到它（handleMessage 顶部拦截），插件视图侧同理
 *  由前端 ingestPluginLogsData 拦截——插件协议与宿主通道互不干扰。 */
export const PLUGIN_LOGS_HOST_KEY = "__host";

/** 日志拉取上行（前端点某插件“日志”时经 plugin_message 发送）。 */
export interface PluginLogsWireUp {
	__host: "logs";
	op: "get" | "clear";
}

/** 日志回包下行（经 plugin_data 定向回给请求方）。 */
export interface PluginLogsWireDown {
	__host: "logs";
	logs: PluginLogEntry[];
	cleared?: boolean;
}

/** 是否为宿主保留的日志拉取请求（op 缺省按 get 容错）。 */
export function isPluginLogsRequest(p: unknown): p is PluginLogsWireUp {
	if (!p || typeof p !== "object") return false;
	const o = p as Record<string, unknown>;
	return o[PLUGIN_LOGS_HOST_KEY] === "logs" && (o.op === "get" || o.op === "clear" || o.op === undefined);
}

/** 插件服务端入口拿到的宿主接口。 */
export interface PluginHost {
	/** 向所有已连接的浏览器广播一条本插件的消息（plugin_data）。 */
	broadcast(payload: unknown): void;
	/** 发一条系统通知条（notice）给所有已连接的浏览器。 */
	notify(level: "info" | "warning" | "error", text: string, textEn?: string): void;
	/** 注册客户端上行消息（plugin_message）处理器；回调第二参为发送方 clientId
	 *  （可用于 sendTo 定向回复）。返回注销函数。 */
	onMessage(handler: (payload: unknown, from?: string) => void): () => void;
	/** 注册客户端上行消息处理器（RPC 模式）：
	 *  回调提供 (msg, reply)，调用 reply(payload) 可直接向来源客户端回包（缺省定向，无 from 广播回退）。
	 *  返回注销函数。内部通过 onMessage 实现。 */
	onClientMessage(handler: (msg: unknown, reply: (payload: unknown) => void) => void | Promise<void>): () => void;
	/** 给指定客户端定向发一条本插件消息（不广播）；clientId 来自 onMessage。 */
	sendTo(clientId: string, payload: unknown): void;
	/** 注册「新客户端接入」钩子：每次浏览器 attach（含插件刚激活时已在场的连接、
	 *  以及 plugins_reload 后的重新接入）都会以 clientId 回调。插件应借此主动
	 *  推送自身完整状态（kind:"state" 等）——服务端是唯一事实源，不要依赖客户端
	 *  挂载后自己来拉（裸 ctx.send({action:"state"}) 无 reqId，响应会被客户端的
	 *  pending 匹配静默丢弃，这是已踩过两次的坑）。返回注销函数。 */
	onAttach(handler: (clientId: string) => void): () => void;
	/** 订阅智能体的工具执行事件（bash/读写文件等，start+end 成对）；返回注销函数。 */
	onToolEvent(handler: (ev: PluginToolEvent) => void): () => void;
	/** 注册工具 pre 拦截守卫（只对 bash/read 生效）：allow 放行、deny 拒绝（带原因
	 *  给模型看）、ask 待确认（暂按拒绝执行，审批 UI 以后再加）。首个非 allow 胜出；
	 *  抛错/超时按弃权。需要能力 tools。返回注销函数。 */
	onToolPre(handler: ToolPreHandler): () => void;
	/** 注册工具 post 编辑守卫（只对 bash/read 生效）：回 content 整体换掉结果正文
	 *  （脱敏/改写）、additionalContext 给模型补上下文。逐个顺序合并，抛错跳过。
	 *  需要能力 tools。返回注销函数。 */
	onToolPost(handler: ToolPostHandler): () => void;
	/** 订阅智能体的运行轨迹事件（run_start/message/tool_start/tool_end/run_end…
	 *  —— 轨迹/时间线类插件用它聚合「任务 → 思考 → 工具 → 文件改动 → 结果」。
	 *  返回注销函数）。 */
	onRunEvent(handler: (ev: PluginRunEvent) => void): () => void;
	/** 读取对话快照（标题/消息/流式消息/统计——轨迹视图直接显示打开对话的
	 *  时间线，不只收录插件安装后的运行）。
	 *  传 `{clientId}` = 该标签页正在看的对话（本页多标签页互不干扰，#542）；
	 *  不传 = 最近活跃的非子代理会话。返回 null = 暂无对话。 */
	getActiveConversation(options?: PluginConversationQuery): PluginConversationSnapshot | null;
	/** 订阅「某客户端的对话模型切换成功」（#542）。回调收到切换后的快照
	 *  （含 clientId / conversationId / model），按 clientId 过滤即可只看本页；
	 *  只在这会话的模型**真的变了**时触发（重复选同一个模型 / 重连重放
	 *  set_model 不重复发；切换失败不发）。返回注销函数。 */
	onClientModelChanged(handler: (snap: PluginConversationSnapshot) => void): () => void;
	/** 无头调用：把外部通道文本投给 agent（微信等，无浏览器也能跑）。
	 *  fire-and-forget，运行结果经 onRunEvent(run_end) 按 conversationId 关联。
	 *  需要能力 "chat"（manifest.permissions）。宿主未接 chatProvider 时拒绝。 */
	chat(req: PluginChatRequest): Promise<PluginChatResult>;
	/** 等待无头调用的运行结束：先经 chat() 投递，再订阅 onRunEvent 的 run_end
	 *  按 conversationId 关联（默认 120s 超时）。无 chat 注入/超时/失败一律
	 *  回 {ok:false}，绝不抛错。 */
	chatWait(
		req: PluginChatRequest,
		opts?: { timeoutMs?: number },
	): Promise<{ ok: boolean; conversationId?: string; error?: string }>;
	/** 直调模型：孤立无工具的一次性补全（总结/翻译/分类等，不建对话、不进历史）。
	 *  model 缺省 = 主会话当前模型；输出按 maxChars 截断（缺省 8000）；timeoutMs 缺省 90s。
	 *  需要能力 "llm"（manifest.permissions，花的是用户自己的模型额度）。
	 *  宿主未接 llmProvider（如 DSH 引擎）时回 {ok:false}，绝不抛错。 */
	llm: {
		complete(req: { prompt: string; system?: string; model?: string; maxChars?: number; timeoutMs?: number }): Promise<{
			ok: boolean;
			text?: string;
			model?: string;
			usage?: { input: number; output: number };
			error?: string;
		}>;
	};
	/** 运行时申请能力范围（动态授权）：基础族必须已在 manifest 声明（net/llm），
	 *  这里只放行「具体范围」——net 补 manifest 白名单之外的主机，llm 限模型作用域。
	 *  用户在浏览器里逐条确认（可记住）；无浏览器/超时/拒绝一律回 false。
	 *  例：`await host.requestPermission({ family: "net", hosts: ["api.example.com"], reason: "同步笔记本" })`。 */
	requestPermission(req: {
		family: "net" | "llm";
		hosts?: string[];
		models?: string[];
		reason?: string;
	}): Promise<boolean>;
	/** 对话读写（只读组装 + 定向投递）：底层是 PluginManager 的
	 *  conversationLister/conversationSearcher/conversationWriter 注入点
	 *  （server/index.ts 接入 agent-service）。无注入时 list/search 回 []、
	 *  get 回 null，绝不抛错。list() 的注入可能是同步数组也可能是 Promise
	 *  （index.ts 接线是 async 的）——插件侧 await 后再用，两边都兼容。 */
	conversations: {
		list(): Array<PluginConversationListItem> | Promise<Array<PluginConversationListItem>>;
		get(id: string): PluginConversationSnapshot | null;
		search(
			query: string,
			limit?: number,
		): Array<{ id: string; title: string }> | Promise<Array<{ id: string; title: string }>>;
	};
	/** 向指定对话发一条用户消息（经 conversationWriter 注入点；无注入回
	 *  {ok:false}，绝不抛错）。attachments 只收工作区路径三件套。 */
	prompt(
		conversationId: string,
		req: { text: string; attachments?: Array<{ path: string; mode?: string }> },
	): Promise<{ ok: boolean; error?: string }>;
	/** 插队指定对话的当前运行（经 runSteerer 注入点；无注入回 {ok:false}）。 */
	steer(conversationId: string, text: string): Promise<{ ok: boolean; error?: string }>;
	/** 中止指定对话的运行（经 runAborter 注入点；无注入回 {ok:false}）。 */
	abortRun(conversationId: string): Promise<{ ok: boolean; error?: string }>;
	/** 订阅「当前打开对话变了」（切历史会话 / 切 running 对话 / 新对话——
	 *  轨迹类插件靠它重拉时间线，否则切会话后视图一直是旧的）。返回注销函数。 */
	onConversationChanged(handler: () => void): () => void;
	/** 注册一个供 AI 调用的工具（新对话创建时带上，已有会话动态注入）；
	 *  返回注销函数——插件可按自己的配置开关随时注册/注销（如邮箱插件的
	 *  「让 AI 管理邮件」开关）。 */
	registerAgentTool(tool: PluginAgentTool): () => void;
	/** 注册一个供 AI 调用的工具（单参数 execute(args) 兼容接口，内部适配并转调 registerAgentTool）。
	 *  返回注销函数。 */
	registerTool(tool: {
		name: string;
		description: string;
		label?: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters?: Record<string, unknown>;
		execute(args: Record<string, unknown>): Promise<unknown>;
	}): () => void;
	/** 插件自己的持久化目录（<dataDir>/plugins/<id>）——凭据等放这里。 */
	dir: string;
	/** 全局数据目录（~/.pi-web）。 */
	dataDir: string;
	/** 当前智能体工作区——**活的**：跟随任意客户端 set_cwd 成功后的新根，
	 *  插件可随时读；想主动感知变化用 onCwdChange。 */
	get cwd(): string;
	/** 注册工作区切换回调（主应用 set_cwd 成功后以新绝对路径触发）。
	 *  返回注销函数。旧版宿主无此方法（可选链兼容）。 */
	onCwdChange(handler: (cwd: string) => void): () => void;
	/** 注册一个斜杠命令（/name），出现在输入框命令选择器里，服务端拦截执行。
	 *  返回注销函数；重名拒绝（内置命令优先，先注册的插件优先）。 */
	registerCommand(cmd: PluginCommandDef): () => void;
	/**
	 * 宿主 UI 贡献（slot 框架，issue #146 完整版）。需要能力 "ui"。
	 *
	 * 声明式基线写在 manifest 的 "ui" 字段（推荐，随插件开关一起可见）；这里的运行时
	 * API 给"按用户配置动态增删"的场景（例如插件设置里勾选"在顶栏显示收件箱"）。
	 * 两边合并规则：同 id 运行时覆盖 manifest，remove 掉的即使是 manifest 声明的也不出现。
	 *
	 * 宿主负责渲染 / 排序 / 溢出 / 可访问性 / 用户偏好 / 审计（谁改了什么）；
	 * 插件只声明条目 + 提供动作回调（浏览器侧 host.onUiAction），**不碰 DOM**。
	 */
	ui: {
		/** 注册/覆盖条目（同 id 覆盖；最多 32 条）。返回注销函数（移除本次注册的 id）。 */
		register(items: unknown[] | unknown): () => void;
		/** 部分更新一个已存在条目（典型用途：刷新 badge 状态文案 / toggle 的 checked /
		 *  input-select 的 value / progress 的进度 / select 的 options）。 */
		update(id: string, patch: Record<string, unknown>): void;
		/** 移除一个条目（manifest 里声明的也能移除，直到 reload 重新解析）。 */
		remove(id: string): void;
		/** 追加整理意图：对宿主内置条目（`host:<name>`）或其它插件条目生效。 */
		arrange(ops: unknown[] | unknown): void;
		/** 当前生效的贡献快照（调试 / 自查用）。 */
		list(): UiPluginUi;
	};
	/** 插件私有 KV 存储（<pluginDir>/storage.json，原子写、卸载即删除）。 */
	storage: {
		get<T>(key: string, fallback?: T): T | undefined;
		set(key: string, value: unknown): void;
		delete(key: string): void;
		all(): Record<string, unknown>;
	};
	/** 加密机密存储（AES-256-GCM；存密码/API key/token 等）。
	 *  明文绝不落盘；拷到别的机器因无宿主密钥解不开。 */
	secrets: {
		set(name: string, value: string): void;
		get(name: string): string | undefined;
		has(name: string): boolean;
		delete(name: string): void;
		list(): string[];
		getAll(): Record<string, string>;
	};
	/** 确保依赖就绪：缺了自动 npm install 到插件目录（单飞合并）。
	 *  resolve 后的 import 才能成功——插件动态加载重型依赖前应 await 它。 */
	ensureDeps(specs: string[], opts?: { onProgress?: (msg: string) => void }): Promise<boolean>;
	/** 挂载 HTTP 路由：实际暴露为 /plugins-api/<id><path>（GET/POST/PUT/DELETE）。
	 *  主站的 PI_WEB_TOKEN 鉴权自动覆盖这些路由；body 已过 express.json 解析。
	 *  handler 抛错由宿主转成 500，不炸进程。返回注销函数。需要能力 "http"。 */
	route(
		method: "GET" | "POST" | "PUT" | "DELETE",
		path: string,
		handler: (req: Request, res: Response) => void,
	): () => void;
	/** 注册通用反向代理前缀：该前缀下的全部子路径原样透传到 127.0.0.1:port
	 *  （去前缀转发，相对路径/Range/SSE 天然可用；ws upgrade 同前缀透传）。
	 *  目标只允许回环地址（防 SSRF），鉴权继承主站 PI_WEB_TOKEN。
	 *  前缀如 "/liveserver"，需要能力 "http"。返回注销函数，反激活时自动注销。 */
	registerProxy(prefix: string, target: number | { port: number; host?: string }): () => void;
	/** 受限工作区文件访问（读/写/列/删）：路径永远锚定「当前工作区根」
	 *  （活值，跟随 set_cwd），越界拒绝——与插件自己 import node:fs 不同，
	 *  这一层是宿主强制执行的。需要能力 "fs"。 */
	fs: {
		list(relDir?: string): Promise<{ name: string; type: "file" | "dir" }[]>;
		read(relPath: string): Promise<Buffer>;
		readText(relPath: string, maxBytes?: number): Promise<string>;
		write(relPath: string, data: string | Uint8Array): Promise<void>;
		remove(relPath: string): Promise<void>;
		/** 文件元信息（size/mtime；不存在抛错）。读门。 */
		stat(relPath: string): Promise<{ name: string; type: "file" | "dir"; size: number; mtime: number }>;
		/** 建目录（递归幂等）。写门。 */
		mkdir(relDir: string): Promise<void>;
		/** 追加写（日志/队列场景）。写门。 */
		append(relPath: string, data: string | Uint8Array): Promise<void>;
		/** 极简 glob（星号/双星匹配，最多 500 条）。读门。 */
		glob(pattern: string, relDir?: string): Promise<string[]>;
		/** 请求访问**工作区之外**的目录（issue #146）：宿主在浏览器里弹确认，用户同意后
		 *  记进全局授权表（<dataDir>/plugin-grants.json），之后 requestAccess 直接通过。
		 *  父目录已授权时子目录也算已授权（授权 = 这棵子树交给你了）。 */
		requestAccess(dir: string, reason?: string): Promise<boolean>;
		/** 本插件当前已授权的目录（设置面板里可撤销）。 */
		authorizedDirs(): string[];
		/** 跨目录读写：路径必须已授权（否则抛错，错误信息告诉你先 requestAccess）。
		 *  读系列要 "fs"/"fs:read"，写系列要 "fs"/"fs:write"（只读插件写即拒）。 */
		listPath(absDir: string): Promise<{ name: string; type: "file" | "dir" }[]>;
		readPath(absPath: string): Promise<Buffer>;
		readTextPath(absPath: string, maxBytes?: number): Promise<string>;
		writePath(absPath: string, data: string | Uint8Array): Promise<void>;
		removePath(absPath: string): Promise<void>;
		/** 跨目录 stat/mkdir/append/glob（读/写门与工作区侧同口径）。 */
		statPath(absPath: string): Promise<{ name: string; type: "file" | "dir"; size: number; mtime: number }>;
		mkdirPath(absDir: string): Promise<void>;
		appendPath(absPath: string, data: string | Uint8Array): Promise<void>;
		globPath(absDir: string, pattern: string): Promise<string[]>;
		/** 订阅工作区内文件/目录变更（node:fs.watch）：目标必须在工作区内否则抛错；
		 *  返回取消函数；插件反激活时自动全部关闭。要能力 "fs"/"fs:read"。 */
		watch(relPath: string, handler: (ev: { type: string; path: string }) => void): () => void;
	};
	/** 项目组装（issue #146）：在**已授权**的目录里建目录、clone 仓库、写文件。
	 *  典型用法：拿几个仓库拼出一个工作区，再 host.openSession({cwd, roots}) 打开它。
	 *  进度经 notify 广播；失败返回 {ok:false,error}（已完成的步骤在 log 里，不留半成品）。 */
	project: {
		create(spec: ProjectCreateSpec): Promise<ProjectCreateResult>;
	};
	/** 注册一个常驻后台任务（轮询器/连接池/后台 worker…）：出现在顶栏「后台任务」
	 *  面板，用户可一键停止。返回 { update, unregister }。id 在插件内唯一。 */
	registerBackgroundTask(task: {
		id: string;
		/** 面板显示名（如「📬 邮件轮询」）。 */
		label: string;
		/** 停止回调（面板「停止」按钮触发；用户也可能直接 kill 进程树）。 */
		stop?: () => void;
		/** 可选初始状态文案，之后可经 update() 刷新。 */
		status?: string;
	}): {
		update(next: Partial<{ label: string; status: string; stop: () => void }>): void;
		unregister(): void;
	};
	/** P3：左栏「运行的对话」里的插件运行条目（仅展示，需要能力 "ui"）。
	 *  setRunning 整体替换本插件的条目，同时作为心跳：超过 ttlMs（缺省 60 秒，夹取 5 秒–1 小时）
	 *  没有再次调用，本插件的条目整组自动清空；clear() 立即清空。反激活时自动清空。 */
	leftPanel: {
		setRunning(items: unknown[], opts?: { ttlMs?: number }): void;
		clear(): void;
	};
	/** 读取宿主管理的设置值（manifest "settings" 声明的字段，storage.json
	 *  存值 + 默认值合并）。插件应以此为准做运行时行为。 */
	getSettings(): Record<string, unknown>;
	/** 订阅「用户在 ⚙ 面板改了这个插件的声明式设置」事件（保存后触发，
	 *  参数为新值对象）；返回注销函数。改完应自行重读 getSettings()。 */
	onSettingsChanged(handler: (values: Record<string, unknown>) => void): () => void;
	/** 只读 git 查询（execFile 直跑，不过 shell）：status/log；失败回
	 *  {ok:false,error} 对象而非抛错。要能力 "fs"/"fs:read"（无即抛门控错误）。 */
	scm: {
		status(): Promise<unknown>;
		log(path?: string, limit?: number): Promise<unknown>;
	};
	/** 受限 shell（execFile 直跑，不过 shell，cmd 按空格切分 argv）：cwd 缺省当前
	 *  工作区、必须在工作区内否则 {ok:false}；默认超时 60s。要能力 "tools"。 */
	bash(
		cmd: string,
		opts?: { cwd?: string; timeoutMs?: number },
	): Promise<{
		ok: boolean;
		output: string;
		exitCode?: number;
		error?: string;
	}>;
	/** 定时任务：number = 间隔毫秒（最小 10s 钳制）；string = 5 字段 cron
	 *  （分 时 日 月 周，`"0 9 * * *"` 每天 9 点，月/周支持英文名，服务器本地时区）。
	 *  返回取消函数；反激活时自动停表。回调异常只记日志，不炸进程
	 *  （async 回调的 rejection 也接住）。
	 *  opts.persistent = 重启不丢：声明落盘 `<pluginDir>/schedules.json`，下次 activate
	 *  重调 schedule() 即重建（必须带合法 id，且每次 activate 都重调——只调一次的话
	 *  反激活后就停了）。catchUp "once" = 重启发现漏跑补一次（15s 缓冲），"skip"
	 *  （缺省）= 跳过。持久任务自动进顶栏「后台任务」面板（⏰，可停止；停止=删声明）。
	 *  持久任务的毫秒间隔底线 60s（内存版 10s）。 */
	schedule(
		cronOrMs: string | number,
		fn: () => void,
		opts?: { id?: string; persistent?: boolean; catchUp?: "skip" | "once"; label?: string },
	): () => void;
	/** 插件可见的模型列表（经 modelLister 注入点；无注入回 []）。 */
	models: {
		list(): PluginModelInfo[] | Promise<PluginModelInfo[]>;
	};
	/** MCP 服务器检测与便捷安装接口：
	 *  - `list()`：列出全局与项目级已配置的全部 MCP 服务器及运行态/工具列表（只读免权限）；
	 *  - `check(query)`：按服务器名、npm 包名、启动命令或 URL 检查某个 MCP 是否已安装/运行中（只读免权限）；
	 *  - `install(spec)`：直接写入配置（支持 `package` 快捷方式转为 `npx -y <package>`）并触发热加载（需 `"tools"` 权限）；
	 *  - `promptInstall(target, opts?)`：向当前或指定对话发送结构化指令，让 AI 协助检查并安装配置该 MCP（需 `"chat"` 或 `"tools"` 权限）。 */
	mcp: {
		list(): Promise<UiMcpServer[]>;
		check(query: string): Promise<McpCheckResult>;
		install(spec: McpInstallSpec): Promise<McpInstallResult>;
		promptInstall(
			target: string | McpInstallSpec,
			opts?: { conversationId?: string; scope?: "global" | "project" },
		): Promise<{ ok: boolean; conversationId?: string; error?: string }>;
	};
	/** 订阅会话统计（PluginManager.emitStats 扇出，异常隔离）；返回注销函数。 */
	onStats(handler: (s: PluginStats) => void): () => void;
	/** 订阅流式增量（emitStreaming 透传，发送方负责节流）；返回注销函数。 */
	onStreaming(handler: (ev: { conversationId?: string; delta: string }) => void): () => void;
	/** 出站网络（globalThis.fetch + 15s 超时）：permissions 必须含 "net" 否则
	 *  直接 {ok:false}；URL 主机必须命中 manifest netAllowlist（相等或 .后缀，
	 *  空表即全拒）——重定向用 manual 手动循环，每一跳的目标主机同样过白名单
	 *  （至多 5 跳，超限/未授权即 {ok:false}）；body 上限 1MB。失败一律
	 *  {ok:false,error}，绝不抛错。 */
	net: {
		fetch(
			url: string,
			init?: { method?: string; body?: string; headers?: Record<string, string> },
		): Promise<{ ok: boolean; status?: number; text?: string; error?: string }>;
	};
	/** 插件间事件总线：emit 回填 from=本插件 id，payload 经 JSON 往返（超 4KB
	 *  截断字符串化）；on 返回取消函数；反激活时清理本插件全部订阅。 */
	events: {
		emit(topic: string, payload?: unknown): void;
		on(topic: string, handler: (ev: PluginBusEvent) => void): () => void;
	};
	/** 分级运行时日志：host.log(level?, ...args)（level 缺省 "info"）。
	 *  首参是 "debug"|"info"|"warn"|"error" 之一即当级别（老插件的
	 *  host.log(...args) 照旧按 info 走）；全部进内存环形缓冲（每插件最近
	 *  200 条，单条截断 500 字符），设置面板“界面插件”页按需拉取查看；
	 *  error 级同时走 console.error（既有行为保留）。 */
	log(level?: string, ...args: unknown[]): void;
	/** 登记一条**自建**的可逆副作用（event 监听 / setInterval / WebSocket / 自建 cache…）：
	 *  返回的注销函数与反激活**都会**调 dispose。宿主自己的每个注册面已在内部走同一
	 *  个栈，插件侧只需把「宿主管不到的那些」挂进来：activate → deactivate 后自己没留
	 *  任何孤儿，热重载不会叠加定时器/监听器。
	 *
	 *  dispose 幂等由调用方保证（宿主可能先经返回值撤一次、再在反激活时逆序回卷一次）；
	 *  dispose 抛错只记一条诊断，不阻断其它清理。 */
	effect(label: string, dispose: () => void): () => void;
}

/** 插件运行时 UI 注册（host.ui.*）——与 manifest 基线合并后随 plugins 清单下发。 */
interface UiRuntimeUi {
	/** 运行时注册/覆盖的条目（id → 条目）。 */
	items: Map<string, UiContribution>;
	/** 运行时移除的条目 id（连 manifest 声明的也压住，直到 reload 重解析）。 */
	removed: Set<string>;
	/** 追加的整理意图（与 manifest 的 arrange 顺序拼接）。 */
	arrange: UiArrangeOp[];
}

/** 能力门控快照：激活期（activatingGates）与已加载条目（LoadedPlugin 同名字段）共用形状，canUse 统一读它。 */
interface GateRecord {
	/** manifest.permissions 原始声明。 */
	permsDeclared?: string[];
	/** 声明中的能力族（去冒号前缀）。 */
	permFamilies?: Set<string>;
	/** 严格门控模式（声明了 permissions 或 apiVersion>=2）。 */
	strictMode?: boolean;
	/** 旧全权警告是否已发过。 */
	legacyWarned?: boolean;
}

/**
 * per-plugin 可逆副作用栈（effect 栈）。
 *
 * 宿主每个注册面（事件订阅 / AI 工具 / 命令 / HTTP 路由 / 反向代理 / fs.watch /
 * 定时任务 / 后台任务 / UI 条目 / 设置回调…）在内部 `add(label, dispose)` 登记一条
 * disposer，反激活时**逆序**回卷 —— 插件不必记得注销，也不会因为漏掉一处就留下
 * 孤儿订阅、定时器、路由或事件处理器（热重载后事件双触发、定时器叠加、watcher
 * 堆积都是这个漏法的症状）。
 *
 * 与「每个注册函数自己返回注销函数」（插件主动调用）是**同一件事的两面**：
 * 返回给插件的注销函数 = `remove(item)`（只撤这一条、幂等），反激活 = `release()`。
 * 插件自建的副作用（自己的 setInterval、EventEmitter 监听…）可经 `host.effect()`
 * 挂进来，同样享受逆序回卷 + 泄漏归因。
 */
export class PluginEffectStack {
	private readonly items: PluginEffect[] = [];
	private released = false;

	constructor(
		readonly pluginId: string,
		/** 记录一条诊断（cleanup 抛错时调用；不抛错、不阻断回卷）。 */
		private readonly diag?: (msg: string) => void,
	) {}

	/** 登记一条副作用；返回「只撤这一条」的注销函数（幂等，重复调用无副作用）。 */
	add(label: string, dispose: () => void): () => void {
		const item: PluginEffect = { label, dispose };
		this.items.push(item);
		return () => this.remove(item);
	}

	/** 当前未回卷的副作用数（单测断言「activate → deactivate 后栈空」）。 */
	get size(): number {
		return this.items.length;
	}

	/** 未回卷的副作用标签（按登记顺序，排障用）。 */
	labels(): string[] {
		return this.items.map((i) => i.label);
	}

	/** 撤销单条：先从栈里摘掉，再跑它的 dispose（幂等 —— 摘不到说明已撤过）。 */
	private remove(item: PluginEffect): void {
		const i = this.items.indexOf(item);
		if (i < 0) return;
		this.items.splice(i, 1);
		try {
			item.dispose();
		} catch (err) {
			this.report(item.label, err);
		}
	}

	/** 逆序回卷全部副作用；返回**失败**（dispose 抛错）的标签列表，绝不抛出。 */
	release(): string[] {
		if (this.released) return [];
		this.released = true;
		const failed: string[] = [];
		while (this.items.length > 0) {
			const item = this.items.pop()!;
			try {
				item.dispose();
			} catch (err) {
				failed.push(item.label);
				this.report(item.label, err);
			}
		}
		return failed;
	}

	private report(label: string, err: unknown): void {
		console.warn(`[plugin:${this.pluginId}] effect "${label}" cleanup failed:`, err);
		this.diag?.(`effect "${label}" cleanup failed: ${(err as Error)?.message ?? String(err)}`);
	}
}

/** 一条已登记的副作用：label 用于排障（谁没清干净），dispose 幂等由调用方保证。 */
export interface PluginEffect {
	label: string;
	dispose: () => void;
}

interface LoadedPlugin {
	info: UiPluginInfo;
	/** deactivate() if the entry provided one. */
	deactivate?: () => void;
	/** 该插件的可逆副作用栈（反激活时逆序回卷；激活失败/版本门占位行没有）。 */
	effects?: PluginEffectStack;
	toolHandlers: Set<(ev: PluginToolEvent) => void>;
	/** 工具 pre 拦截守卫（host.onToolPre，仅 bash/read 生效；错误占位行可缺省）。 */
	preGuards?: Set<ToolPreHandler>;
	/** 工具 post 编辑守卫（host.onToolPost，仅 bash/read 生效；错误占位行可缺省）。 */
	postGuards?: Set<ToolPostHandler>;
	/** 运行轨迹事件订阅（host.onRunEvent）。 */
	runHandlers: Set<(ev: PluginRunEvent) => void>;
	/** 对话切换订阅（host.onConversationChanged）。 */
	convChangeHandlers: Set<() => void>;
	/** 模型切换订阅（host.onClientModelChanged，#542）。错误占位行可缺省。 */
	modelChangeHandlers?: Set<(snap: PluginConversationSnapshot) => void>;
	/** onAttach 钩子（新客户端接入时逐个回调）。 */
	attachHandlers: Set<(clientId: string) => void>;
	/** onCwdChange 钩子（工作区切换时逐个回调）。 */
	cwdHandlers: Set<(cwd: string) => void>;
	/** 该插件挂载的 HTTP 路由表："METHOD /path" → handler。 */
	httpRoutes: Map<string, (req: Request, res: Response) => void>;
	/** manifest.permissions 原始声明（空/缺省 = 未声明，旧全权模式）。错误路径占位可缺省。 */
	permsDeclared?: string[];
	/** 声明中的能力族（去冒号前缀）：fs/net/tools/http/terminal… */
	permFamilies?: Set<string>;
	/** 严格门控模式（声明了 permissions 或 apiVersion>=2）：canUse 的判定依据。 */
	strictMode?: boolean;
	/** 旧格式全权模式的「未声明」警告是否已发过（每次激活一次）。 */
	legacyWarned?: boolean;
	/** onSettingsChanged 钩子（⚙ 面板保存声明式设置后触发）。 */
	settingsHandlers: Set<(values: Record<string, unknown>) => void>;
}

/** 宿主提供的插件设施版本——manifest 声明的 apiVersion 高于此值则拒绝激活，
 *  插件能拿到明确的「请升级 pi-web-ui」而不是在新接口上莫名 undefined。
 *  1 = 初始：storage/secrets/命令/HTTP 路由/工具注册/受限 fs/后台任务。
 *  2 = issue #146：UI 扩展点（manifest "ui" + host.ui.*）、跨目录 fs（requestAccess /
 *      *Path 族）、项目组装（host.project.create）、多根工作区（set_workspace_roots）。
 *      同时把「未声明 permissions」从旧全权模式改为**默认拒绝**（versionGuard 前移）。 */
export const PLUGIN_API_VERSION = 2;

/** 插件通过 host.registerCommand 注册的斜杠命令。run 的返回值若为非空字符串，
 *  会作为系统通知条回显给发起人；需要富展示的视图插件应改用 broadcast/sendTo。
 *  命令是纯配置动作（不消耗 token），与内置命令同级拦截执行。 */
export interface PluginCommandDef {
	name: string;
	description?: string;
	descriptionEn?: string;
	argumentHint?: string;
	argumentHintEn?: string;
	run(args: string, ctx: { clientId?: string }): unknown | Promise<unknown>;
}

/** 每个插件的 AI 工具注册表（name → 定义）。 */
type AgentToolTable = Map<string, PluginAgentTool>;

/** 插件注册的常驻后台任务（经 host.registerBackgroundTask）。 */
export interface PluginBgTask {
	id: string;
	label: string;
	stop?: () => void;
	status?: string;
	since: number;
}

/** 消息处理器超时：仅作为不再等待的日志阈值（响应由 handler 自己发出）。 */
const MESSAGE_TIMEOUT_MS = 30_000;

/** host.fs 被能力门控拒绝时的共享 rejected promise（类型对齐用）。 */
const NO_FS_PROMISE = Promise.reject(new Error('插件未声明能力 "fs"（manifest.permissions）——请求被拒'));
NO_FS_PROMISE.catch(() => {}); // 避免未处理 rejection 噪音；调用方 await 时拿到错误

/** 只读插件（仅声明 fs:read）撞到写操作时的共享 rejected promise：提示缺 fs/fs:write。 */
const NO_FS_WRITE_PROMISE = Promise.reject(
	new Error('缺少写能力：需要 "fs"/"fs:write"（manifest.permissions）——请求被拒'),
);
NO_FS_WRITE_PROMISE.catch(() => {}); // 同上：调用方 await 时拿到错误

/** host.bash 的执行体：execFile 直跑（不过 shell），与宿主其它 git/scm 查询同口径。 */
const execFileAsync = promisify(execFile);

/** 简单版本号三元组（x.y.z，忽略 -prerelease/+build 后缀）。 */
function parseVer(v: string): [number, number, number] | null {
	const m = String(v ?? "")
		.trim()
		.match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpVerTuple(a: [number, number, number], b: [number, number, number]): number {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i]! - b[i]!;
	}
	return 0;
}

/** manifest engines["pi-web-ui"] 约束判定（支持 >=x.y.z / ^x.y.z / =x.y.z/裸 x.y.z）。
 *  返回 null = 约束或当前版本解析失败（调用方警告放行，不阻断激活）。 */
export function satisfiesEnginesConstraint(constraint: string, current: string): boolean | null {
	const c = String(constraint ?? "").trim();
	let kind: ">=" | "^" | "=", req: string;
	if (c.startsWith(">=")) {
		kind = ">=";
		req = c.slice(2).trim();
	} else if (c.startsWith("^")) {
		kind = "^";
		req = c.slice(1).trim();
	} else if (c.startsWith("=")) {
		kind = "=";
		req = c.slice(1).trim();
	} else {
		kind = "=";
		req = c;
	}
	const r = parseVer(req);
	const cur = parseVer(current);
	if (!r || !cur) return null;
	if (kind === ">=") return cmpVerTuple(cur, r) >= 0;
	if (kind === "=") return cmpVerTuple(cur, r) === 0;
	return cur[0] === r[0] && cmpVerTuple(cur, r) >= 0; // ^：同主版本且不低于
}

/** 宿主自身版本（package.json version，读一次缓存；读不到回 null——调用方放行）。 */
export function readHostVersion(): string | null {
	const ver = getAppVersion();
	return ver ? ver : null;
}

/** 每个 WS 连接注册一个 sender；cid() 返回该 socket 的 clientId（attach 前 null）。 */
interface Sender {
	cid: () => string | null;
	send: (msg: ServerMessage) => void;
}

// ---------------------------------------------------------------------------
// 声明式设置 schema（manifest "settings"）
// ---------------------------------------------------------------------------

const SETTING_TYPES = new Set(["text", "password", "number", "boolean", "select", "secret"]);

/** select 字段可由宿主现算的候选数据源（manifest `optionsFrom`）：
 *  models = 已配置鉴权的模型；thinkingLevels = SDK 思考强度档位。
 *  清单在浏览器侧现算（模型配置会变，静态表会过期），服务端不做候选值校验。 */
const SETTING_OPTIONS_FROM = new Set(["models", "thinkingLevels"]);

/**
 * 解析 manifest "ui" 的某个 slot 数组 → 规范化条目（issue #146 完整版）。
 *
 * 宽容但不放任：坏字段跳过、id 非法或重复跳过、children 只收一层、文本截断；
 * 不认识的 slot / kind / when 直接丢弃（旧宿主读到新字段也不会崩，新宿主读到旧字段同理）。
 * 归属由宿主决定：全局 id = `<pluginId>:<itemId>`。
 */
export { UI_SLOTS };

/** manifest 里可以写更自然的简写（作者少踩坑）：解析时映射到完整 slot 名。 */
export const UI_SLOT_ALIASES: Readonly<Record<string, string>> = {
	topbar: "topbar.primary",
	"topbar.more": "topbar.overflow",
	composer: "composer.actions",
	message: "message.actions",
	rightpanel: "rightpanel.tabs",
	settings: "settings.pages",
	modal: "modal.dialog",
	sidebar: "sidebar.left",
	"sidebar.left": "sidebar.left",
	"sidebar.right": "sidebar.right",
	leftbar: "sidebar.left",
	rightbar: "sidebar.right",
};

/** 合法的条目种类（缺省 action；settings.pages 缺省 page）。 */
export const UI_KINDS: ReadonlySet<string> = new Set([
	"view",
	"action",
	"badge",
	"menu",
	"page",
	"organizer",
	"divider",
	"toggle",
	"input",
	"progress",
	"select",
]);
/** 合法的对齐取值（UiAlign）：起首/居中/行尾，非法值丢弃（条目保留，align 回缺省）。 */
const UI_ALIGNS: ReadonlySet<string> = new Set(["start", "center", "end"]);

/** 原始值 → 合法 UiAlign（非法/缺失一律 undefined，调用方填缺省）。 */
export function parseUiAlign(raw: unknown): UiAlign | undefined {
	return typeof raw === "string" && UI_ALIGNS.has(raw) ? (raw as UiAlign) : undefined;
}

function trimStr(v: unknown, max = 60): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

/** 原字符串 trim 后是否超出上限（截断诊断用）。 */
function wasTruncated(v: unknown, max: number): boolean {
	return typeof v === "string" && v.trim().length > max;
}

/** 规范化一个条目；非法返回 null（slot 由调用方给）。
 *
 *  第三个参数可选：传了就把“为什么丢弃/为什么被改”（未知 kind 回落、字段截断、
 *  children 嵌套被清、when/options 丢项等）逐条 push 进去；不传则行为与原来完全一致。 */
export function parseUiItem(raw: unknown, slot: string, diagnostics?: string[]): UiContribution | null {
	const diag = (m: string): void => {
		diagnostics?.push(m);
	};
	if (!raw || typeof raw !== "object") {
		diag(`ui item in slot "${slot}": not an object, dropped`);
		return null;
	}
	const o = raw as Record<string, unknown>;
	const rawIdHint = typeof o.id === "string" && o.id.trim() ? o.id.trim().slice(0, 32) : "?";
	const id = trimStr(o.id, 64);
	// id 必须匹配插件 id 字符集（它与 pluginId 拼成全局 key，直接进 DOM 的 data 属性）
	if (!id || !ID_RE.test(id)) {
		diag(`ui item in slot "${slot}": invalid id "${rawIdHint}", dropped`);
		return null;
	}
	if (wasTruncated(o.id, 64)) diag(`ui item "${id}": id truncated to 64 chars`);
	const label = trimStr(o.label, 60);
	if (!label) {
		diag(`ui item "${id}": missing label, dropped`);
		return null;
	}
	if (wasTruncated(o.label, 60)) diag(`ui item "${id}": label truncated to 60 chars`);
	const kindRaw = trimStr(o.kind, 16);
	let kind: UiContribution["kind"] = kindRaw && UI_KINDS.has(kindRaw) ? (kindRaw as UiContribution["kind"]) : undefined;
	if (kindRaw && !kind) diag(`ui item "${id}": unknown kind "${kindRaw}", fallback to default`);
	if (!kind) kind = slot === "settings.pages" ? "page" : "action";
	const children: UiContribution[] = [];
	if (Array.isArray(o.children)) {
		if (o.children.length > 16) diag(`ui item "${id}": children capped at 16 (${o.children.length - 16} dropped)`);
		const sliced = o.children.slice(0, 16);
		for (let i = 0; i < sliced.length; i++) {
			const before = diagnostics?.length ?? 0;
			const child = parseUiItem(sliced[i], slot, diagnostics);
			// 子项不再递归（一层够用）：清掉它自己的 children 防嵌套刷栈
			if (child) {
				if (child.children?.length)
					diag(`ui item "${id}": child "${child.id}" nested children cleared (only one level kept)`);
				children.push({ ...child, children: undefined });
			} else if ((diagnostics?.length ?? 0) === before) {
				diag(`ui item "${id}": child #${i} dropped`);
			}
		}
	} else if (o.children !== undefined) {
		diag(`ui item "${id}": children is not an array, ignored`);
	}
	let when: string[] | undefined;
	if (o.when !== undefined) {
		if (!Array.isArray(o.when)) {
			diag(`ui item "${id}": when is not an array, ignored`);
		} else {
			const valid = o.when.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
			if (valid.length < o.when.length)
				diag(`ui item "${id}": when dropped ${o.when.length - valid.length} invalid entries`);
			if (valid.length > 8) diag(`ui item "${id}": when capped at 8 (${valid.length - 8} dropped)`);
			const capped = valid.slice(0, 8);
			if (capped.length) when = capped;
		}
	}
	const num = Number(o.order);
	if (o.order !== undefined && !Number.isFinite(num)) diag(`ui item "${id}": invalid order, ignored`);
	const align = parseUiAlign(o.align);
	if (o.align !== undefined && !align) diag(`ui item "${id}": unknown align, default used`);
	// kind="select" 的候选项（最多 32；value 必填，label 缺省回落 value）。
	// 没写 kind 但给了合法 options = 视为 select（少让作者踩坑）。
	let options: UiContribution["options"] | undefined;
	if ((kind === "select" || !kindRaw) && Array.isArray(o.options)) {
		if (o.options.length > 32) diag(`ui item "${id}": options capped at 32 (${o.options.length - 32} dropped)`);
		const list: NonNullable<UiContribution["options"]> = [];
		let droppedOpts = 0;
		for (const r of o.options.slice(0, 32)) {
			if (!r || typeof r !== "object") {
				droppedOpts++;
				continue;
			}
			const ro = r as Record<string, unknown>;
			const value = typeof ro.value === "string" ? ro.value.slice(0, 64) : "";
			if (!value || list.some((x) => x.value === value)) {
				droppedOpts++;
				continue;
			}
			list.push({
				value,
				...(trimStr(ro.label, 60) ? { label: trimStr(ro.label, 60) } : {}),
				...(trimStr(ro.labelEn, 60) ? { labelEn: trimStr(ro.labelEn, 60) } : {}),
			});
		}
		if (droppedOpts) diag(`ui item "${id}": options dropped ${droppedOpts} invalid/duplicate entries`);
		if (list.length) {
			if (!kindRaw) diag(`ui item "${id}": kind inferred as select from options`);
			options = list;
			kind = "select";
		} else if (o.options.length) {
			diag(`ui item "${id}": options all invalid, ignored`);
		}
	}
	if (wasTruncated(o.labelEn, 60)) diag(`ui item "${id}": labelEn truncated to 60 chars`);
	if (wasTruncated(o.icon, 16)) diag(`ui item "${id}": icon truncated to 16 chars`);
	if (wasTruncated(o.hint, 200)) diag(`ui item "${id}": hint truncated to 200 chars`);
	if (wasTruncated(o.hintEn, 200)) diag(`ui item "${id}": hintEn truncated to 200 chars`);
	if (wasTruncated(o.group, 40)) diag(`ui item "${id}": group truncated to 40 chars`);
	if (wasTruncated(o.action, 64)) diag(`ui item "${id}": action truncated to 64 chars`);
	if (wasTruncated(o.view, 64)) diag(`ui item "${id}": view truncated to 64 chars`);
	if (wasTruncated(o.badge, 24)) diag(`ui item "${id}": badge truncated to 24 chars`);
	if (typeof o.value === "string" && o.value.length > 500) diag(`ui item "${id}": value truncated to 500 chars`);
	if (typeof o.progress === "number" && Number.isFinite(o.progress) && (o.progress < 0 || o.progress > 100))
		diag(`ui item "${id}": progress out of range, clamped to 0-100`);
	return {
		id,
		slot: slot as UiContribution["slot"],
		label,
		...(align ? { align } : {}),
		...(trimStr(o.labelEn, 60) ? { labelEn: trimStr(o.labelEn, 60) } : {}),
		...(trimStr(o.icon, 16) ? { icon: trimStr(o.icon, 16) } : {}),
		...(normalizeIconSvg((o as { iconSvg?: unknown }).iconSvg)
			? { iconSvg: normalizeIconSvg((o as { iconSvg?: unknown }).iconSvg) }
			: {}),
		...(trimStr(o.hint, 200) ? { hint: trimStr(o.hint, 200) } : {}),
		...(trimStr(o.hintEn, 200) ? { hintEn: trimStr(o.hintEn, 200) } : {}),
		kind,
		...(children.length ? { children } : {}),
		...(Number.isFinite(num) ? { order: num } : {}),
		...(trimStr(o.group, 40) ? { group: trimStr(o.group, 40) } : {}),
		...(o.hidden === true ? { hidden: true } : {}),
		...(trimStr(o.action, 64) ? { action: trimStr(o.action, 64) } : {}),
		...(trimStr(o.view, 64) ? { view: trimStr(o.view, 64) } : {}),
		...(when?.length ? { when } : {}),
		...(trimStr(o.badge, 24) ? { badge: trimStr(o.badge, 24) } : {}),
		...(typeof o.checked === "boolean" ? { checked: o.checked } : {}),
		...(typeof o.value === "string" ? { value: o.value.slice(0, 500) } : {}),
		...(typeof o.progress === "number" && Number.isFinite(o.progress)
			? { progress: Math.max(0, Math.min(100, o.progress)) }
			: {}),
		...(options ? { options } : {}),
	};
}

/**
 * 解析 manifest "ui" → 规范化贡献。
 *
 * 形状两种都收（都是为了少让插件作者踩坑）：
 *   "ui": { "topbar": [...] }                       // 按 slot 分组（推荐）
 *   "ui": { "items": [{ slot, ... }, ...] }         // 平铺（运行时注册同形，便于两边复用）
 * 单条目上限 32、arrange 上限 64 —— 防一份 manifest 把前端顶爆。
 */
export function parseUiContributions(raw: unknown, diagnostics?: string[]): UiPluginUi | undefined {
	const diag = (m: string): void => {
		diagnostics?.push(m);
	};
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		diag("ui: expected object, ignored");
		return undefined;
	}
	const o = raw as Record<string, unknown>;
	const items: UiContribution[] = [];
	let capNoted = false;
	const noteCap = (): void => {
		if (!capNoted) {
			capNoted = true;
			diag("ui: total items capped at 32, remaining dropped");
		}
	};
	const push = (it: UiContribution | null) => {
		if (!it) return;
		if (items.length < 32) items.push(it);
		else noteCap();
	};
	// 入参级截断也要记一笔（total cap 消息只在“有效条目溢出”时出现，
	// 这里记的是“写法层面的切片”——两者正交）。
	if (o.items !== undefined && !Array.isArray(o.items)) diag('ui: "items" is not an array, ignored');
	if (Array.isArray(o.items)) {
		if (o.items.length > 32) diag(`ui: flat items capped at 32 (${o.items.length - 32} dropped)`);
		for (let i = 0; i < o.items.slice(0, 32).length; i++) {
			const it = o.items[i];
			const slotRaw = trimStr((it as Record<string, unknown>)?.slot, 32) ?? "";
			const slot = slotRaw ? (UI_SLOT_ALIASES[slotRaw] ?? slotRaw) : "";
			if (!slot || !UI_SLOTS.has(slot)) {
				diag(`ui: flat items[#${i}] unknown slot "${slotRaw || "(missing)"}", dropped`);
				continue;
			}
			const before = diagnostics?.length ?? 0;
			const parsed = parseUiItem(it, slot, diagnostics);
			if (!parsed && (diagnostics?.length ?? 0) === before) diag(`ui: flat items[#${i}] in slot "${slot}" dropped`);
			push(parsed);
		}
	}
	for (const [rawKey, val] of Object.entries(o)) {
		if (rawKey === "items" || rawKey === "arrange") continue;
		const key = UI_SLOT_ALIASES[rawKey] ?? rawKey;
		if (!UI_SLOTS.has(key)) {
			const n = Array.isArray(val) ? val.length : 1;
			diag(`ui: unknown slot group "${rawKey}", dropped (${n} items)`);
			continue;
		}
		if (!Array.isArray(val)) {
			diag(`ui: slot "${key}" value is not an array, dropped`);
			continue;
		}
		if (val.length > 32) diag(`ui: slot "${key}" capped at 32 (${val.length - 32} dropped)`);
		for (let i = 0; i < val.slice(0, 32).length; i++) {
			const before = diagnostics?.length ?? 0;
			const parsed = parseUiItem(val[i], key, diagnostics);
			if (!parsed && (diagnostics?.length ?? 0) === before) diag(`ui: slot "${key}"[#${i}] dropped`);
			push(parsed);
		}
	}
	const arrange = o.arrange === undefined ? [] : parseUiArrange(o.arrange, diagnostics);
	if (!items.length && !arrange.length) {
		diag("ui: no valid items/arrange, ignored");
		return undefined;
	}
	return { items, arrange };
}

/** 规范化整理意图（对内置/其它插件的条目）。非法/越界形状丢弃。
 *
 *  第三个参数可选：传了就把丢弃/忽略原因逐条 push 进去；不传则行为与原来完全一致。 */
export function parseUiArrange(raw: unknown, diagnostics?: string[]): UiArrangeOp[] {
	const diag = (m: string): void => {
		diagnostics?.push(m);
	};
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		diag("ui arrange: expected array, ignored");
		return [];
	}
	if (raw.length > 64) diag(`ui arrange: capped at 64 (${raw.length - 64} dropped)`);
	const out: UiArrangeOp[] = [];
	const sliced = raw.slice(0, 64);
	for (let i = 0; i < sliced.length; i++) {
		const it = sliced[i];
		if (!it || typeof it !== "object") {
			diag(`ui arrange[#${i}]: not an object, dropped`);
			continue;
		}
		const o = it as Record<string, unknown>;
		// 目标 id：`host:<name>` 或 `<pluginId>:<itemId>`
		const id = trimStr(o.id, 96);
		if (!id || !/^[A-Za-z0-9_-]+:[A-Za-z0-9_.:-]+$/.test(id)) {
			const hint = typeof o.id === "string" && o.id.trim() ? o.id.trim().slice(0, 32) : "?";
			diag(`ui arrange[#${i}]: invalid id "${hint}", dropped`);
			continue;
		}
		if (typeof o.id === "string" && o.id.trim().length > 96) diag(`ui arrange "${id}": id truncated to 96 chars`);
		const slotRaw = trimStr(o.slot, 32);
		if (o.slot !== undefined && (!slotRaw || !UI_SLOTS.has(slotRaw)))
			diag(`ui arrange "${id}": unknown slot "${String(o.slot).slice(0, 32)}", slot ignored`);
		const num = Number(o.order);
		if (o.order !== undefined && !Number.isFinite(num)) diag(`ui arrange "${id}": invalid order, ignored`);
		const align = parseUiAlign(o.align);
		if (o.align !== undefined && !align) diag(`ui arrange "${id}": unknown align, ignored`);
		if (typeof o.group === "string" && o.group.trim().length > 40)
			diag(`ui arrange "${id}": group truncated to 40 chars`);
		if (typeof o.label === "string" && o.label.trim().length > 60)
			diag(`ui arrange "${id}": label truncated to 60 chars`);
		if (typeof o.hint === "string" && o.hint.trim().length > 200)
			diag(`ui arrange "${id}": hint truncated to 200 chars`);
		if (typeof o.icon === "string" && o.icon.trim().length > 16) diag(`ui arrange "${id}": icon truncated to 16 chars`);
		out.push({
			id,
			...(slotRaw && UI_SLOTS.has(slotRaw) ? { slot: slotRaw as UiArrangeOp["slot"] } : {}),
			...(o.hide === true ? { hide: true } : {}),
			...(o.hide === false ? { hide: false } : {}),
			...(trimStr(o.group, 40) ? { group: trimStr(o.group, 40) } : {}),
			...(Number.isFinite(num) ? { order: num } : {}),
			...(align ? { align } : {}),
			...(trimStr(o.label, 60) ? { label: trimStr(o.label, 60) } : {}),
			...(trimStr(o.hint, 200) ? { hint: trimStr(o.hint, 200) } : {}),
			...(trimStr(o.icon, 16) ? { icon: trimStr(o.icon, 16) } : {}),
			...(normalizeIconSvg((o as { iconSvg?: unknown }).iconSvg)
				? { iconSvg: normalizeIconSvg((o as { iconSvg?: unknown }).iconSvg) }
				: {}),
		});
	}
	return out;
}

/** 解析 manifest.requires → 归一化硬依赖声明（P2-8，坏形状宽容忽略：
 *  形状错在 P1-6 校验层已拒，这里只管把合法部分抽出来供展示 + activate 判定）。 */
export function parseRequires(raw: unknown): PluginRequires | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const o = raw as Record<string, unknown>;
	const out: PluginRequires = {};
	if (typeof o.hostApi === "number" && Number.isInteger(o.hostApi) && o.hostApi >= 1) out.hostApi = o.hostApi;
	if (Array.isArray(o.families)) {
		const fams = o.families
			.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
			.map((x) => x.trim())
			.slice(0, 8);
		if (fams.length) out.families = fams;
	}
	if (Array.isArray(o.plugins)) {
		const deps = o.plugins
			.filter((x): x is string => typeof x === "string" && ID_RE.test(x.trim()))
			.map((x) => x.trim())
			.slice(0, 16);
		if (deps.length) out.plugins = deps;
	}
	return out.hostApi !== undefined || out.families !== undefined || out.plugins !== undefined ? out : undefined;
}

/** 依赖拓扑排序（P2-8）：按 requires.plugins 把被依赖者排前面；同层保持扫描顺序。
 *  返回 { order }（可激活顺序）+ { cyclic }（环/挂在环上的，调用方直接拒）。
 *  边只连「本次扫描里存在」的对等端；缺失的对端由 activate 判定点名拒绝。 */
export function sortByRequires(ids: string[], depsOf: (id: string) => string[]): { order: string[]; cyclic: string[] } {
	const indeg = new Map<string, number>();
	const edges = new Map<string, string[]>();
	const idSet = new Set(ids);
	for (const id of ids) {
		indeg.set(id, 0);
		edges.set(id, []);
	}
	for (const id of ids) {
		const seen = new Set<string>();
		for (const dep of depsOf(id)) {
			if (!idSet.has(dep) || dep === id || seen.has(dep)) continue;
			seen.add(dep);
			edges.get(dep)!.push(id);
			indeg.set(id, (indeg.get(id) ?? 0) + 1);
		}
	}
	const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
	const order: string[] = [];
	while (queue.length) {
		const cur = queue.shift()!;
		order.push(cur);
		for (const next of edges.get(cur) ?? []) {
			const d = (indeg.get(next) ?? 1) - 1;
			indeg.set(next, d);
			if (d === 0) queue.push(next);
		}
	}
	const ordered = new Set(order);
	return { order, cyclic: ids.filter((id) => !ordered.has(id)) };
}

/** 合并 manifest 基线与运行时注册：运行时同 id 覆盖，removed 里的删除；arrange 追加。 */
function mergeUiPluginUi(base: UiPluginUi | undefined, rt: UiRuntimeUi | undefined): UiPluginUi | undefined {
	const items = new Map<string, UiContribution>();
	for (const it of base?.items ?? []) items.set(it.id, it);
	for (const it of rt?.items.values() ?? []) items.set(it.id, it);
	for (const id of rt?.removed ?? []) items.delete(id);
	const arrange = [...(base?.arrange ?? []), ...(rt?.arrange ?? [])];
	if (!items.size && !arrange.length) return undefined;
	return { items: [...items.values()], arrange };
}

/** 解析 manifest.settings → 合法 schema（坏字段跳过，最多 32 个）。 */
function parseSettingsSchema(raw: unknown): UiPluginSettingField[] {
	if (!Array.isArray(raw)) return [];
	const out: UiPluginSettingField[] = [];
	for (const f of raw) {
		if (!f || typeof f !== "object") continue;
		const o = f as Record<string, unknown>;
		const key = typeof o.key === "string" ? o.key.trim() : "";
		// 宿主数据源（models / thinkingLevels）：合法值才认，非法当成没写（回落静态 options）。
		// 只写 optionsFrom 没写 type = 视为 select（少让作者踩坑，与 options 的写法一致）。
		const optionsFrom =
			typeof o.optionsFrom === "string" && SETTING_OPTIONS_FROM.has(o.optionsFrom)
				? (o.optionsFrom as UiPluginSettingField["optionsFrom"])
				: undefined;
		const type = (typeof o.type === "string" && o.type ? o.type : optionsFrom ? "select" : "") as string;
		if (!key || !SETTING_TYPES.has(type) || out.some((x) => x.key === key)) continue;
		const field: UiPluginSettingField = {
			key,
			type: type as UiPluginSettingField["type"],
			label: typeof o.label === "string" && o.label ? o.label : key,
			...(o.default !== undefined ? { default: o.default as string | number | boolean } : {}),
			...(typeof o.min === "number" ? { min: o.min } : {}),
			...(typeof o.max === "number" ? { max: o.max } : {}),
			...(Array.isArray(o.options) ? { options: o.options.filter((x): x is string => typeof x === "string") } : {}),
			...(type === "select" && optionsFrom ? { optionsFrom } : {}),
			...(typeof o.hint === "string" ? { hint: o.hint } : {}),
		};
		out.push(field);
		if (out.length >= 32) break;
	}
	return out;
}

/** secret 设置在 secrets 里的键（与插件手搓的机密键冲突概率极低的前缀）。 */
function secretSettingKey(key: string): string {
	return `setting:${key}`;
}
/** 用户 overlay 原文件（P2-9）：`<dataDir>/plugin-overrides/<id>.json` 的 settings 节。
 *  缺文件 = 没写（不警告）；坏形状 → 警告并整体忽略（用户自己的文件，不连坐插件）。
 *  顶层未知键忽略（前向兼容）；每键校验在 cleanOverlaySettings 里按 schema 做。 */
function readSettingsOverlayFile(
	dataDir: string,
	pluginId: string,
): { raw: Record<string, unknown>; warnings: string[] } {
	const empty = { raw: {}, warnings: [] as string[] };
	if (!ID_RE.test(pluginId)) return empty;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(dataDir, "plugin-overrides", `${pluginId}.json`), "utf8"));
	} catch {
		return empty;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { raw: {}, warnings: [`settings override ignored: ${pluginId}.json must be an object`] };
	}
	const o = parsed as Record<string, unknown>;
	if (o.settings === undefined) return empty;
	if (!o.settings || typeof o.settings !== "object" || Array.isArray(o.settings)) {
		return { raw: {}, warnings: [`settings override ignored: ${pluginId}.json settings must be an object`] };
	}
	return { raw: o.settings as Record<string, unknown>, warnings: [] };
}

/** 按 schema 清洗 overlay 值（P2-9）：secret 一律拒绝（明文永不进加密 store）+
 *  诊断；类型不对/越界/非法候选 → 警告并丢该键；schema 外的键 → 警告并忽略（拼写检查）。 */
function cleanOverlaySettings(
	schema: UiPluginSettingField[],
	raw: Record<string, unknown>,
	lang: ServerLang,
): { values: Record<string, unknown>; warnings: string[] } {
	const values: Record<string, unknown> = {};
	const warnings: string[] = [];
	const byKey = new Map(schema.map((f) => [f.key, f]));
	for (const [k, v] of Object.entries(raw)) {
		const f = byKey.get(k);
		if (!f) {
			warnings.push(`settings override ignored: unknown key "${k.slice(0, 64)}"`);
			continue;
		}
		if (f.type === "secret") {
			warnings.push(`settings override ignored: secret "${k.slice(0, 64)}" never comes from overlay`);
			continue;
		}
		const r = cleanNonSecretSettingsField(f, v, lang);
		if (r.error) {
			warnings.push(`settings override ignored: "${k.slice(0, 64)}": ${r.error}`);
			continue;
		}
		values[k] = r.value;
	}
	return { values, warnings };
}

/** 三层合并（P2-9）：schema 默认 < overlay（用户钉住的新默认，不 fork）< storage.json
 *  （面板保存，最高）。stored 不清洗（保存路径已洗过，可信）；overlay 已预洗。
 *  secret 走加密 store，overlay 永不参与。 */
function resolveSettingsValues(
	schema: UiPluginSettingField[],
	stored: Record<string, unknown>,
	overlay: Record<string, unknown>,
	secrets?: { has?: (k: string) => boolean; get?: (k: string) => string | undefined },
): { values: Record<string, unknown>; sources: Record<string, "default" | "override" | "stored"> } {
	const values: Record<string, unknown> = {};
	const sources: Record<string, "default" | "override" | "stored"> = {};
	for (const f of schema) {
		if (f.type === "secret") {
			if (secrets?.get) {
				const got = secrets.get(secretSettingKey(f.key));
				values[f.key] = got ?? f.default ?? "";
				sources[f.key] = got !== undefined ? "stored" : "default";
			} else if (secrets?.has) {
				const has = secrets.has(secretSettingKey(f.key));
				values[f.key] = has;
				sources[f.key] = has ? "stored" : "default";
			} else {
				values[f.key] = false;
				sources[f.key] = "default";
			}
			continue;
		}
		const s = stored[f.key];
		if (s !== undefined && s !== null) {
			values[f.key] = s;
			sources[f.key] = "stored";
		} else if (f.key in overlay) {
			values[f.key] = overlay[f.key];
			sources[f.key] = "override";
		} else {
			values[f.key] = f.default;
			sources[f.key] = "default";
		}
	}
	return { values, sources };
}

/** 从 <pluginDir>/storage.json 读 settings 存值，按 schema 并默认值。
 *  secret 字段不返回明文：有 secrets 时返回有无（布尔），调用方是浏览器；
 *  插件运行时要真值请用 runtimeSettingsValues。 */
function readStoredSettings(dir: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, "storage.json"), "utf8")) as Record<string, unknown>;
		if (parsed && typeof parsed === "object" && parsed.settings && typeof parsed.settings === "object") {
			return parsed.settings as Record<string, unknown>;
		}
	} catch {
		/* 无存储文件 = 全默认 */
	}
	return {};
}

/** 插件运行时视角的设置值：非 secret 与 storedSettingsValues 同口径；secret 返回真值
 *  （无则回落默认值/空串）。只给插件服务端代码用，绝不下发浏览器。 */
function runtimeSettingsValues(
	dir: string,
	schema: UiPluginSettingField[],
	secrets: Pick<PluginSecrets, "get">,
	overlay: Record<string, unknown> = {},
): Record<string, unknown> {
	return resolveSettingsValues(schema, readStoredSettings(dir), overlay, { get: (k) => secrets.get(k) }).values;
}

/** 清洗单个非 secret 设置值（P2-9 抽出：保存路径与 overlay 复用同一套口径）。
 *  v === undefined → 回落 schema 默认；类型不对/越界/非法候选 → error（调用方丢弃该键）。
 *  secret 字段不在这里处理（overlay 直接拒绝，明文永不进加密 store）。 */
function cleanNonSecretSettingsField(
	f: UiPluginSettingField,
	v: unknown,
	lang: ServerLang,
): { error?: string; value?: unknown } {
	if (f.type === "number") {
		const n = v === undefined ? Number(f.default ?? 0) : Number(v);
		if (!Number.isFinite(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
			return {
				error: pick(lang, `${f.label} 超出范围`, `${f.label} out of range`, "plugins.settings.out.of.range", {
					"f.label": f.label,
				}),
			};
		}
		return { value: n };
	}
	if (f.type === "boolean") {
		return { value: v === undefined ? Boolean(f.default) : Boolean(v) };
	}
	if (f.type === "select") {
		const s = v === undefined ? "" : String(v);
		// optionsFrom（宿主数据源）：候选值在浏览器侧现算，服务端无从校验，
		// 只做个长度护栏；非法值由用的时候（如 host.chat 切模型）报错。
		if (f.optionsFrom) {
			if (s.length > 200) {
				return {
					error: pick(lang, `${f.label} 过长`, `${f.label} too long`, "plugins.settings.too.long", {
						"f.label": f.label,
					}),
				};
			}
			return { value: v === undefined ? (f.default ?? "") : s };
		}
		if (v !== undefined && !f.options?.includes(s))
			return {
				error: pick(lang, `${f.label} 值非法`, `Invalid value for ${f.label}`, "plugins.settings.invalid.value", {
					"f.label": f.label,
				}),
			};
		return { value: v === undefined ? f.default : s };
	}
	return { value: v === undefined ? (f.default ?? "") : String(v) };
}

/** 校验并写回 settings（storage.json 的 settings 键，原子写）；返回错误信息或 null。
 *  secret 字段写加密 secrets（明文永不落盘、不进 storage.json）：空串/缺省 = 不改；
 *  返回的 clean 含 secret 真值（给 onSettingsChanged 用），调用方不得下发浏览器。 */
function saveSettingsValues(
	dir: string,
	schema: UiPluginSettingField[],
	values: Record<string, unknown> | undefined,
	/** 错误文案语言（默认英文）；调用方可传 () => getLang() 实现跟随。 */
	lang?: () => ServerLang,
	secrets?: PluginSecrets,
): { error?: string; clean: Record<string, unknown> } {
	const l = lang?.() ?? "en";
	const clean: Record<string, unknown> = {};
	for (const f of schema) {
		const v = values?.[f.key];
		if (f.type !== "secret") {
			const r = cleanNonSecretSettingsField(f, v, l);
			if (r.error) return { error: r.error, clean };
			clean[f.key] = r.value;
		} else if (f.type === "secret") {
			// 空串/缺省 = 不改（浏览器侧回显的本来就是有无布尔，前端把“没碰”发成空串）。
			if (v === undefined || v === "") {
				clean[f.key] = secrets?.get(secretSettingKey(f.key)) ?? f.default ?? "";
			} else {
				const s = String(v);
				if (s.length > 4096) {
					return {
						error: pick(l, `${f.label} 过长`, `${f.label} too long`, "plugins.settings.too.long", {
							"f.label": f.label,
						}),
						clean,
					};
				}
				try {
					secrets?.set(secretSettingKey(f.key), s);
				} catch (err) {
					return { error: (err as Error).message, clean };
				}
				clean[f.key] = s;
			}
		} else {
			clean[f.key] = v === undefined ? (f.default ?? "") : String(v);
		}
	}
	try {
		// 保留 storage.json 里其它键（插件自己的数据），只动 settings。
		// secret 真值永不进 storage.json（只进加密 secrets），这里整份剥掉。
		const secretKeys = new Set(schema.filter((f) => f.type === "secret").map((f) => f.key));
		const persist: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(clean)) if (!secretKeys.has(k)) persist[k] = v;
		const file = join(dir, "storage.json");
		// 与 PluginStorage.set/delete 同一把按文件路径的 RMW 锁（见 plugin-facilities.ts
		// 的 withFileRmwLock）：两个「读-改-写」者串行，谁也不会拿旧快照抹掉对方刚写的键。
		withFileRmwLock(file, () => {
			let existing: Record<string, unknown> = {};
			try {
				existing = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			} catch {
				/* 首次 */
			}
			const tmp = `${file}.tmp-${process.pid}`;
			writeFileSync(tmp, JSON.stringify({ ...existing, settings: persist }));
			renameSync(tmp, file);
		});
	} catch (err) {
		console.error(`[plugins] settings persist failed (${dir}):`, err);
	}
	return { clean };
}

export class PluginManager {
	private loaded = new Map<string, LoadedPlugin>();
	/** 已 import 过但无入口/失败的目录——避免重复 import 与重复报错。 */
	private attempted = new Set<string>();
	private senders = new Set<Sender>();
	private messageHandlers = new Map<string, Set<(payload: unknown, from?: string) => void>>();
	/** 插件注册的 AI 工具：pluginId → (name → 定义)。宿主经 agentTools() 读取。 */
	private agentTools = new Map<string, AgentToolTable>();
	/** AI 工具集合变化回调（index.ts 接到 AgentService，把新工具推入活跃会话）。 */
	onAgentToolsChanged: (() => void) | undefined = undefined;
	/** 插件斜杠命令注册表：pluginId → (name → 定义)。宿主经 listCommands() 读取。 */
	private pluginCommands = new Map<string, Map<string, PluginCommandDef>>();
	/** 命令集合变化回调（index.ts 接到 AgentService，刷新各客户端命令目录）。 */
	onCommandsChanged: (() => void) | undefined = undefined;
	/** 插件常驻任务：pluginId → Map<taskId, PluginBgTask>。宿主经 bgTasks() 读取。 */
	private pluginBgTasks = new Map<string, Map<string, PluginBgTask>>();
	/** 任务集合变化回调（index.ts 接到 AgentService，重推 bg_servers）。 */
	onBgTasksChanged: (() => void) | undefined = undefined;
	/** P3：左栏插件运行条目（见 left-panel-running.ts）。 */
	readonly panelRunning = new LeftPanelRunningStore();
	private panelPushTimer: ReturnType<typeof setTimeout> | null = null;
	private panelSweepTimer: ReturnType<typeof setInterval> | null = null;
	/** 服务端重载纪元：每次 reload() +1，前端用作 import 缓存击穿参数。 */
	private epochCounter = 0;
	/** 插件市场列表纪元：每次 add/remove +1，前端据此重渲。 */
	private catalogEpoch = 0;
	/** 当前全局工作区（host.cwd 的背后存储）——随 notifyCwd 更新。 */
	private cwdValue: string;
	/** 当前项目的**额外工作区根**（宿主侧多根，见 protocol 的 set_workspace_roots）——
	 *  由 index.ts 在 set_cwd / set_workspace_roots 后调 notifyWorkspaceRoots 同步。
	 *  它们只影响「哪些路径算工作区内」（免授权的受支持路径），不改变 cwd 本身。 */
	private workspaceRoots: string[] = [];
	/** 插件目录授权表（<dataDir>/plugin-grants.json，issue #146）。 */
	readonly grants: PluginGrantsStore;
	/** 特权 DOM 授权表（<dataDir>/plugin-dom.json）：wantsDom 插件的 bundle 门禁。 */
	private readonly domConsentStore: PluginDomConsent;
	/** scan() 顺手维护的 wantsDom 快照：静态门禁查它，不必每次 readdir。未知 id = 不拦。 */
	private readonly domWants = new Map<string, boolean>();
	/** 由 index.ts 注入：向浏览器请求「插件要访问这个目录」的用户确认。 */
	pathAccessRequester: ((pluginId: string, dir: string, reason?: string) => Promise<boolean>) | undefined = undefined;
	/** 由 index.ts 注入：授权表**变了**（新授权落表）时触发 —— 设置面板的「已授权目录」
	 *  靠它即时刷新（以前只在 attach / 撤销时推，「点了允许但列表里还没出现」很难不被当成 bug）。 */
	onGrantsChanged: (() => void) | undefined = undefined;
	/** 插件运行时注册的 UI 贡献（host.ui.register/arrange），随 plugins 清单推送。 */
	private uiRuntime = new Map<string, UiRuntimeUi>();
	/** 通用反向代理注册表：归一化前缀 → { 插件 id, 回环目标 }（index.ts 按最长前缀命中透传）。 */
	private proxyRoutes = new Map<string, { pluginId: string; host: string; port: number }>();
	/** manifest "ui" 基线（每次 scan 刷新；host.ui.list 与合并都读它）。 */
	private uiBase = new Map<string, UiPluginUi>();
	/** manifest 解析诊断（每次 scan 重算；合法插件无诊断时记空数组）。 */
	private manifestDiags = new Map<string, string[]>();
	/** 运行时诊断（工具/命令/路由/门控拒绝、激活失败等；反激活时随插件一起清）。
	 *  只做可观测性：存一份 console.error/console.warn 之外的摘要，随 UiPluginInfo
	 *  下发给设置面板“界面插件”页展开查看，不改变任何隔离/权限语义。 */
	private runtimeDiags = new Map<string, string[]>();
	/** 运行时分级日志（host.log 写入）：内存环形缓冲，每插件最近 200 条。
	 *  不落盘、随进程走；只经 plugin_data 按需拉取，绝不进 60ms 快照
	 *  （与 diagnostics 的“只读诊断随清单下发”正交，互不冲突）。 */
	private pluginLogs = new Map<string, PluginLogEntry[]>();

	constructor(
		private readonly dataDir: string,
		cwd: string,
		/** 随包发布的默认插件列表（<pkgRoot>/plugins/catalog.json）。缺省 = 无内置列表。 */
		private readonly builtinCatalogPath?: string,
	) {
		this.cwdValue = resolve(cwd);
		this.grants = new PluginGrantsStore(dataDir);
		this.permGrants = new PluginPermissionStore(dataDir);
		this.domConsentStore = new PluginDomConsent(dataDir);
	}

	/** index.ts 在客户端 set_cwd 成功后调用：更新全局工作区并扇出给
	 *  所有已激活插件的 onCwdChange 钩子（异常隔离，不炸主进程）。 */
	notifyCwd(next: string): void {
		const abs = resolve(next);
		if (abs === this.cwdValue) return; // 幂等：重复通知/同路径 no-op
		this.cwdValue = abs;
		for (const [id, p] of this.loaded) {
			for (const h of p.cwdHandlers) {
				try {
					h(abs);
				} catch (err) {
					console.error(`[plugin:${id}] cwd-change handler failed:`, err);
				}
			}
		}
	}

	/** index.ts 在客户端改动「额外工作区根」后调用（新增/移除/切项目都算）：归一化后存下，
	 *  同一份就是 no-op。刻意**不发** onCwdChange 钩子：工作区根变化不动 cwd，那个钩子的
	 *  语义就是「当前目录变了」（插件该切根的时机）。 */
	notifyWorkspaceRoots(roots: string[] | undefined): void {
		const next = normalizeWorkspaceRoots(roots ?? []);
		if (next.length === this.workspaceRoots.length && next.every((p, i) => p === this.workspaceRoots[i])) return;
		this.workspaceRoots = next;
	}

	get pluginsDir(): string {
		return join(this.dataDir, "plugins");
	}

	/** 全部插件注册的斜杠命令（按插件 id 稳定排序）。 */
	listCommands(): PluginCommandDef[] {
		const out: PluginCommandDef[] = [];
		for (const id of [...this.pluginCommands.keys()].sort()) {
			out.push(...this.pluginCommands.get(id)!.values());
		}
		return out;
	}

	/** 按名查找命令（供 prompt() 拦截执行；找不到返回 null）。 */
	findCommand(name: string): { def: PluginCommandDef; pluginId: string } | null {
		for (const [pluginId, table] of this.pluginCommands) {
			if (table.has(name)) return { def: table.get(name)!, pluginId };
		}
		return null;
	}

	/** 全部插件注册的常驻后台任务（扁平化为 BgServer 形状）。 */
	bgTasks(): BgServer[] {
		const out: BgServer[] = [];
		for (const [pluginId, table] of this.pluginBgTasks) {
			for (const t of table.values()) {
				out.push({
					taskId: t.id,
					plugin: pluginId,
					since: t.since,
					name: t.label,
					...(t.status ? { status: t.status } : {}),
				});
			}
		}
		return out;
	}

	/** 停止一个插件任务（kill_background_server with taskId）；返回是否命中。 */
	stopPluginBgTask(taskId: string): boolean {
		for (const [pluginId, table] of this.pluginBgTasks) {
			const t = table.get(taskId);
			if (!t) continue;
			try {
				t.stop?.();
			} catch (err) {
				console.error(`[plugin:${pluginId}] background task ${taskId} stop failed:`, err);
			}
			table.delete(taskId);
			if (table.size === 0) this.pluginBgTasks.delete(pluginId);
			try {
				this.onBgTasksChanged?.();
			} catch {
				// best-effort：可选 UI 刷新，失败忽略。
			}
			return true;
		}
		return false;
	}

	/** 保存某插件的声明式设置（⚙ 面板 → plugin_settings 消息）：按 schema 校验、
	 *  原子写 storage.json 的 settings 键、通知插件 onSettingsChanged、重推清单
	 *  让前端回显。返回错误信息或 null（成功）。 */
	savePluginSettings(
		pluginId: string,
		values: Record<string, unknown>,
		/** 错误文案语言（默认英文）；调用方可传 () => getLang() 实现跟随。 */
		lang?: () => ServerLang,
	): { error?: string } {
		const l = lang?.() ?? "en";
		if (!ID_RE.test(pluginId)) return { error: pick(l, "非法的插件 id", "Invalid plugin id", "plugins.id.invalid") };
		const dir = join(this.pluginsDir, pluginId);
		const info = this.loaded.get(pluginId)?.info;
		const schema = info?.settingsSchema ?? [];
		if (!schema.length)
			return {
				error: pick(
					l,
					"该插件没有声明式设置（manifest 未声明 settings）",
					"This plugin has no declarative settings (manifest declares no settings)",
					"plugins.settings.no.declarative",
				),
			};
		const { error, clean } = saveSettingsValues(dir, schema, values, lang, new PluginSecrets(this.dataDir, dir));
		if (error) return { error };
		// 通知插件（异常隔离）
		for (const h of this.loaded.get(pluginId)?.settingsHandlers ?? []) {
			try {
				h(clean);
			} catch (err) {
				console.error(`[plugin:${pluginId}] onSettingsChanged handler failed:`, err);
			}
		}
		// 重推 plugins 清单（含新 settingsValues），前端回显。
		void this.pushToAll().catch(() => {});
		return {};
	}

	/** 当前重载纪元（随 plugins 消息下发）。 */
	get epoch(): number {
		return this.epochCounter;
	}

	/** 用户自定义插件列表文件（<dataDir>/plugin-catalog.json）。 */
	get customCatalogPath(): string {
		return join(this.dataDir, "plugin-catalog.json");
	}

	/** 合并后的插件市场列表（builtin + 用户自定义，同 id 用户覆盖）。 */
	catalog(): UiPluginCatalogEntry[] {
		return this.builtinCatalogPath ? readCatalog(this.builtinCatalogPath, this.customCatalogPath) : [];
	}

	/** 插件市场列表纪元（随 plugin_catalog 消息下发）。 */
	get catalogEpochValue(): number {
		return this.catalogEpoch;
	}

	/** 把插件市场列表推给所有 socket。 */
	async pushCatalog(): Promise<void> {
		this.deliverAll({ type: "plugin_catalog", entries: this.catalog(), epoch: this.catalogEpoch });
	}

	/** 把能力授权表推给所有 socket（attach 推 + 授权/撤销后重推）。 */
	async pushPermissions(): Promise<void> {
		this.deliverAll({ type: "plugin_permissions", grants: this.permGrants.list() });
	}

	/** 往用户自定义列表加一条（同 id 覆盖）；返回错误信息或 null（成功）。
	 *  成功后 epoch+1 并重推列表。 */
	addCatalogEntry(input: CatalogAddInput, lang?: () => ServerLang): { error?: string } {
		try {
			addCustomEntry(this.customCatalogPath, input, lang);
			this.catalogEpoch += 1;
			void this.pushCatalog();
			return {};
		} catch (err) {
			return { error: (err as Error).message };
		}
	}

	/** 移除一条用户自定义条目（builtin 不可经此删除）；返回错误信息或 null。 */
	removeCatalogEntry(id: string, lang?: () => ServerLang): { error?: string } {
		const l = lang?.() ?? "en";
		try {
			const ok = removeCustomEntry(this.customCatalogPath, id);
			if (!ok)
				return {
					error: pick(
						l,
						"未找到该条目，或它是内置条目（不可移除）",
						"Entry not found, or it is a built-in entry (cannot be removed)",
						"plugins.catalog.entry.cannot.remove",
					),
				};
			this.catalogEpoch += 1;
			void this.pushCatalog();
			return {};
		} catch (err) {
			return { error: (err as Error).message };
		}
	}

	addSender(send: (msg: ServerMessage) => void, cid: () => string | null): () => void {
		const s: Sender = { cid, send };
		this.senders.add(s);
		return () => this.senders.delete(s);
	}

	/** 当前在线（hello 过）的 clientId 去重集合。插件授权弹窗广播后按它做应答
	 *  来源绑定——广播后才连上的端没见过弹窗，不许代答（index.ts 三类授权应答校验）。 */
	onlineClientIds(): string[] {
		const out = new Set<string>();
		for (const s of this.senders) {
			const cid = s.cid();
			if (cid) out.add(cid);
		}
		return [...out];
	}

	/** 客户端上行：路由给对应插件的处理器；未知/未激活的插件静默丢弃。
	 *  插件代码不可信——同步抛错与返回的 Promise rejection 都必须隔离在
	 *  这里，绝不能炸主进程。 */
	handleMessage(pluginId: string, payload: unknown, from?: string): void {
		if (!ID_RE.test(pluginId)) return;
		// 宿主保留通道：运行时日志按需拉取/清空（directed plugin_data 回包）。
		// 不进插件 onMessage（插件不可见），from 缺席时无法定向回包则静默丢弃。
		if (isPluginLogsRequest(payload)) {
			if (!from) return;
			const cleared = payload.op === "clear";
			if (cleared) this.clearPluginLogs(pluginId);
			const down: PluginLogsWireDown = {
				__host: "logs",
				logs: this.getPluginLogs(pluginId),
				...(cleared ? { cleared: true as const } : {}),
			};
			this.sendTo(from, pluginId, down);
			return;
		}
		const handlers = this.messageHandlers.get(pluginId);
		if (!handlers) return;
		for (const h of handlers) {
			try {
				const ret = h(payload, from) as unknown;
				if (ret instanceof Promise) {
					ret.catch((err) => {
						console.error(`[plugin:${pluginId}] async message handler failed:`, err);
					});
					// 超时护栏：响应由 handler 自己 sendTo/broadcast 发出，超时只是记
					// 日志不再等待——绝不能让单条消息把客户端 pending 管线无限拖死。
					const timer = setTimeout(() => {
						console.error(`[plugin:${pluginId}] message handler 超时（>${MESSAGE_TIMEOUT_MS}ms），已不再等待`);
					}, MESSAGE_TIMEOUT_MS);
					void ret.finally(() => clearTimeout(timer));
				}
			} catch (err) {
				console.error(`[plugin:${pluginId}] message handler failed:`, err);
			}
		}
	}

	/** 首次安装/能力变更时提醒在线用户（marker 文件记录上次激活时的声明）。 */
	private async maybeConsentNotice(info: UiPluginInfo, dir: string, perms: string[]): Promise<void> {
		try {
			const markerFile = join(dir, ".pi-approved");
			const key = createHash("sha256").update(JSON.stringify(perms)).digest("hex").slice(0, 32);
			let prev = "";
			try {
				prev = JSON.parse(readFileSync(markerFile, "utf8"))?.key ?? "";
			} catch {
				/* 无 marker = 首次安装 */
			}
			if (prev === key) return; // 同版本能力清单，不再打扰
			const list = perms.length ? perms.join(", ") : "无";
			this.notifyAll(
				perms.length ? "warning" : "info",
				`插件「${info.name}」已激活（${prev ? "能力清单变更" : "首次安装"}；声明能力：${list}）——请确认来源可信`,
				`Plugin "${info.name}" activated (${prev ? "capability list changed" : "first install"}; declared: ${list}) — verify the source is trusted`,
			);
			writeFileSync(markerFile, JSON.stringify({ v: 1, key, perms }), "utf8");
		} catch (err) {
			console.error(`[plugin:${info.id}] consent notice failed:`, err);
		}
	}

	/** index.ts 的 /plugins-api/:id/* 挂载点转发到这里：找到对应插件的已注册
	 *  路由并执行；未知插件/路径 → 404，handler 抛错 → 500（不炸进程）。 */
	handleHttp(pluginId: string, method: string, pathIn: string, req: Request, res: Response): void {
		if (!ID_RE.test(pluginId)) {
			res.status(404).end("plugin not found");
			return;
		}
		const table = this.loaded.get(pluginId)?.httpRoutes;
		const path = "/" + pathIn.replace(/^\/+/, "");
		const handler = table?.get(`${method.toUpperCase()} ${path}`);
		if (!handler) {
			res.status(404).end("not found");
			return;
		}
		try {
			// 异步 handler（`async (req, res) => …`）的 rejection 不会被这里的 try 接住，
			// 会变成 unhandledRejection 直接杀掉整个服务（插件读文件失败、host.fs 越界
			// 拒绝、上游超时…都会走到这条路上）——用 Promise.resolve().catch 兜住，
			// 与同步抛错同样转 500。
			void Promise.resolve(handler(req, res)).catch((err: unknown) => {
				console.error(`[plugin:${pluginId}] http ${method} ${path} failed:`, err);
				if (!res.headersSent) res.status(500).end("internal error");
				else res.end();
			});
		} catch (err) {
			console.error(`[plugin:${pluginId}] http ${method} ${path} failed:`, err);
			if (!res.headersSent) res.status(500).end("internal error");
			else res.end();
		}
	}

	/** 注册通用代理前缀（host.registerProxy 的本体，index.ts 只读 findProxy）。
	 *  成功返回归一化前缀；前缀非法/目标非法/被其它插件占用返回 null（调用方记诊断）。 */
	registerProxy(pluginId: string, prefix: string, target: unknown): string | null {
		const p = normalizeProxyPrefix(prefix);
		const t = normalizeProxyTarget(target);
		if (!p || !t) return null;
		const taken = this.proxyRoutes.get(p);
		if (taken && taken.pluginId !== pluginId) return null;
		this.proxyRoutes.set(p, { pluginId, host: t.host, port: t.port });
		return p;
	}

	/** 注销代理前缀（同插件才能注销自己的；返回是否真删掉了）。 */
	unregisterProxy(pluginId: string, prefix: string): boolean {
		const p = normalizeProxyPrefix(prefix);
		if (!p) return false;
		if (this.proxyRoutes.get(p)?.pluginId !== pluginId) return false;
		return this.proxyRoutes.delete(p);
	}

	/** index.ts 转发/upgrade 共用：请求路径的最长前缀命中（无命中返回 undefined）。
	 *  查表前小写化：注册前缀统一小写归一，大小写混写也命中同一条。 */
	findProxy(path: string): { prefix: string; pluginId: string; host: string; port: number } | undefined {
		const p = matchProxyPrefix(String(path ?? "").toLowerCase(), this.proxyRoutes.keys());
		if (!p) return undefined;
		const hit = this.proxyRoutes.get(p);
		if (!hit) return undefined;
		return { prefix: p, ...hit };
	}

	broadcast(pluginId: string, payload: unknown): void {
		this.deliverAll({ type: "plugin_data", pluginId, payload });
	}

	/** 系统通知：发给所有 socket（复用 notice 消息，前端 toast 展示）。 */
	notifyAll(level: "info" | "warning" | "error", text: string, textEn?: string): void {
		this.deliverAll({ type: "notice", level, text, textEn });
	}

	/** 给指定客户端定向发一条插件消息；找不到该 socket 时静默忽略。 */
	sendTo(clientId: string, pluginId: string, payload: unknown): void {
		for (const s of this.senders) {
			if (s.cid() !== clientId) continue;
			try {
				s.send({ type: "plugin_data", pluginId, payload });
			} catch {
				/* dead socket */
			}
		}
	}

	/** 目录清单 + 当前 epoch 推给所有 socket。 */
	async pushToAll(): Promise<void> {
		const list = await this.scan();
		this.deliverAll({ type: "plugins", plugins: list, epoch: this.epochCounter });
	}

	/** index.ts 静态门禁查这个：wantsDom 且未授权 → 403。 */
	isDomBundleBlocked(pluginId: string): boolean {
		if (!this.domWants.get(pluginId)) return false;
		return !this.domConsentStore.has(pluginId);
	}

	/** plugin_dom_consent 两步握手的预检（index.ts 用）：只有声明了 dom 能力的
	 *  插件才允许生成在途 consent 请求——任意 pluginId 进不来，在途表不膨胀。 */
	isDomPlugin(pluginId: string): boolean {
		return this.domWants.get(pluginId) === true;
	}

	/** 特权 DOM 授权/撤销（设置面板 plugin_dom_consent）。
	 *  返回 { changed }：变了才 epoch+1 重推（浏览器按新 epoch 重拉 bundle，
	 *  失败缓存随 syncPluginViews 的 epoch 切换清掉）；目标不是 wantsDom 插件
	 *  或 id 非法 → { changed: false, error }。 */
	async setDomConsent(pluginId: string, granted: boolean): Promise<{ changed: boolean; error?: string }> {
		const id = String(pluginId ?? "").trim();
		if (!ID_RE.test(id)) return { changed: false, error: "非法插件 id" };
		if (!this.domWants.get(id)) return { changed: false, error: "该插件未声明 dom 能力，无需授权" };
		const changed = this.domConsentStore.set(id, granted);
		if (!changed) return { changed: false };
		// 授权前后 bundle 的 403/200 状态翻转：epoch+1 让浏览器丢掉旧模块缓存重拉。
		this.epochCounter += 1;
		void this.pushToAll().catch(() => {});
		return { changed: true };
	}

	/** 服务端热重载：反激活全部 → 清缓存 → 重扫重激活 → epoch+1。
	 *  返回新目录清单（含激活结果）。重激活后的插件实例是新模块，
	 *  内存状态为初始值——逐个客户端触发 onAttach 让它们重推自身状态。 */
	async reload(lang?: () => ServerLang): Promise<UiPluginInfo[]> {
		this.dispose();
		this.attempted.clear();
		this.epochCounter += 1;
		const list = await this.ensureLoaded(lang);
		for (const s of this.senders) {
			const cid = s.cid();
			if (cid) this.notifyAttach(cid);
		}
		return list;
	}

	/** 每个客户端 attach 后调用：让各插件向该客户端推送自身完整状态。
	 *  异常隔离——单个插件钩子报错不影响其他插件与其他钩子。 */
	notifyAttach(clientId: string): void {
		for (const [id, p] of this.loaded) {
			for (const h of p.attachHandlers) {
				try {
					h(clientId);
				} catch (err) {
					console.error(`[plugin:${id}] onAttach handler failed:`, err);
				}
			}
		}
	}

	/** agent-service 调：把 SDK 工具执行事件扇出给所有插件（异常隔离）。 */
	emitToolEvent(ev: PluginToolEvent): void {
		for (const p of this.loaded.values()) {
			for (const h of p.toolHandlers) {
				try {
					h(ev);
				} catch (err) {
					console.error(`[plugin:${p.info.id}] tool-event handler failed:`, err);
				}
			}
		}
	}

	/** agent-service 调（P1-5）：bash/read 执行前的守卫求值。首个 deny/ask 胜出；
	 *  守卫抛错/超时一律按弃权（不阻断）。无守卫时回 allow，调用方可直接放行。 */
	async evaluateToolPre(
		req: ToolPreRequest,
		_lang: string = "en",
	): Promise<{
		verdict:
			| { decision: "allow" }
			| { decision: "deny"; reason?: string; reasonEn?: string }
			| { decision: "ask"; reason?: string; reasonEn?: string };
		pluginId?: string;
	}> {
		const frozen: ToolPreRequest = {
			toolName: req.toolName,
			params: freezeParams(req.params),
			conversationId: req.conversationId,
		};
		// #489：对 this.loaded 取快照再迭代——下面的 withGuardTimeout 是 await 点，
		// 期间插件 reload/uninstall 会原地 clear 同一个 Map（实例不变），Map 迭代器
		// 立即 done → 剩余插件的 pre 守卫一次都不被求值 → fail-open 直接放行。
		const loadedSnapshot = [...this.loaded.values()];
		for (const p of loadedSnapshot) {
			for (const h of p.preGuards ?? []) {
				let raw: unknown;
				try {
					raw = await withGuardTimeout(Promise.resolve().then(() => (h as ToolPreHandler)(frozen)));
				} catch (err) {
					console.error(`[plugin:${p.info.id}] tool-pre guard failed (abstained):`, err);
					this.pushRuntimeDiag(p.info.id, `tool-pre guard threw, abstained (${req.toolName})`);
					continue;
				}
				if (raw === undefined) continue;
				const d = normalizePreDecision(raw);
				if (!isBlockingDecision(d)) continue;
				this.pushRuntimeDiag(p.info.id, `tool-pre ${d.decision} ${req.toolName} (by ${p.info.id})`);
				return { verdict: d, pluginId: p.info.id };
			}
		}
		return { verdict: { decision: "allow" } };
	}

	/** agent-service 调（P1-5）：bash/read 执行后的守卫合并。逐个顺序合进结果；
	 *  抛错/超时的那个被跳过（其余继续）。返回合并后的 content（无编辑回 undefined）。 */
	async evaluateToolPost(
		req: ToolPostRequest,
		lang: string = "en",
	): Promise<{ content?: Array<{ type: string; text?: string }>; pluginIds: string[] } | undefined> {
		let content = Array.isArray((req.result as { content?: unknown } | null)?.content)
			? ([...(req.result as { content: Array<{ type: string; text?: string }> }).content] as Array<{
					type: string;
					text?: string;
				}>)
			: undefined;
		const base = { ...(req.result as Record<string, unknown>), ...(content ? { content: [...content] } : {}) } as {
			content?: Array<{ type: string; text?: string }>;
			[k: string]: unknown;
		};
		let touched = false;
		const pluginIds: string[] = [];
		const frozenReq: ToolPostRequest = {
			toolName: req.toolName,
			params: freezeParams(req.params),
			result: req.result,
			conversationId: req.conversationId,
		};
		// #489：同 evaluateToolPre——await 点期间 reload 原地 clear Map 会让迭代器
		// 提前终止，取快照迭代保证本轮请求遍历的是发起时的插件集合。
		const postLoadedSnapshot = [...this.loaded.values()];
		for (const p of postLoadedSnapshot) {
			for (const h of p.postGuards ?? []) {
				let raw: unknown;
				try {
					raw = await withGuardTimeout(Promise.resolve().then(() => (h as ToolPostHandler)(frozenReq)));
				} catch (err) {
					console.error(`[plugin:${p.info.id}] tool-post guard failed (skipped):`, err);
					this.pushRuntimeDiag(p.info.id, `tool-post guard threw, skipped (${req.toolName})`);
					continue;
				}
				const edit = normalizePostEdit(raw);
				if (!edit) continue;
				const merged = applyPostEdit(base, edit, lang);
				base.content = merged.content;
				Object.assign(base, merged);
				touched = true;
				pluginIds.push(p.info.id);
				this.pushRuntimeDiag(p.info.id, `tool-post edited ${req.toolName} (by ${p.info.id})`);
			}
		}
		if (!touched) return undefined;
		return { content: base.content, pluginIds };
	}

	/** 阻断时给模型看的一句话（pre 守卫命中后由 agent-service 取用）。 */
	guardDenialText(
		verdict:
			| { decision: "deny"; reason?: string; reasonEn?: string }
			| { decision: "ask"; reason?: string; reasonEn?: string },
		pluginId: string,
		lang: string = "en",
	): string {
		return denialText(verdict, pluginId, lang);
	}

	/** index.ts 注入：读取对话快照（轨迹类插件经 host.getActiveConversation 调用）。
	 *  #542：按 clientId 取「该标签页正在看的对话」；缺省回落「最近活跃的非子代理」。 */
	conversationProvider: ((options?: PluginConversationQuery) => PluginConversationSnapshot | null) | undefined =
		undefined;
	/** index.ts 注入：插件无头调用 agent（微信通道等经 host.chat 调用）。 */
	chatProvider: ((pluginId: string, req: PluginChatRequest) => Promise<PluginChatResult>) | undefined = undefined;
	/** 由 index.ts 接入 agent-service：插件直调模型（host.llm.complete 的底层，孤立无工具会话）。
	 *  无注入回 {ok:false}（如 DSH 引擎），绝不抛错。 */
	llmProvider:
		| ((
				pluginId: string,
				req: { prompt?: string; system?: string; model?: string; maxChars?: number; timeoutMs?: number },
		  ) => Promise<{
				ok: boolean;
				text?: string;
				model?: string;
				usage?: { input: number; output: number };
				error?: string;
		  }>)
		| undefined = undefined;
	/** 由 index.ts 接入 agent-service：对话列表（host.conversations.list 的底层）。
	 *  同步数组与 Promise 都收（index.ts 接线是 async 的），host 侧归一化。无注入回 []。 */
	conversationLister:
		(() => Array<PluginConversationListItem> | Promise<Array<PluginConversationListItem>>) | undefined = undefined;
	/** 由 index.ts 接入 agent-service：对话搜索（host.conversations.search 的底层）。无注入时
	 *  host 回退用 conversationLister 做标题过滤；两者都无回 []。 */
	conversationSearcher:
		| ((
				query: string,
				limit?: number,
		  ) => Array<{ id: string; title: string }> | Promise<Array<{ id: string; title: string }>>)
		| undefined = undefined;
	/** 由 index.ts 接入 agent-service：向指定对话发用户消息（host.prompt 的底层）。
	 *  无注入回 {ok:false}，绝不抛错。 */
	conversationWriter:
		| ((
				conversationId: string,
				text: string,
				attachments?: Array<{ path: string; mode?: string }>,
		  ) => Promise<{ ok: boolean; error?: string }>)
		| undefined = undefined;
	/** 由 index.ts 接入 agent-service：插队指定对话的运行（host.steer 的底层）。无注入回 {ok:false}。 */
	runSteerer: ((conversationId: string, text: string) => Promise<{ ok: boolean; error?: string }>) | undefined =
		undefined;
	/** 由 index.ts 接入 agent-service：中止指定对话的运行（host.abortRun 的底层）。无注入回 {ok:false}。 */
	runAborter: ((conversationId: string) => Promise<{ ok: boolean; error?: string }>) | undefined = undefined;
	/** 由 index.ts 接入 agent-service：模型列表（host.models.list 的底层）。无注入回 []。 */
	modelLister: (() => PluginModelInfo[] | Promise<PluginModelInfo[]>) | undefined = undefined;
	/** 由 index.ts 接入 McpBridge：供 host.mcp 读取实时运行状态与热重载。 */
	mcpBridge: McpBridge | undefined = undefined;
	/** 插件能力动态授权表（host.requestPermission 的底层，见 server/plugin-permissions.ts）。 */
	readonly permGrants: PluginPermissionStore;
	/** 由 index.ts 注入：向浏览器请求能力授权的用户确认（{ok, remember}）。
	 *  未注入（DSH/无浏览器）时 requestPermission 直接回 false。 */
	permissionRequester:
		| ((
				pluginId: string,
				req: { family: PermissionFamily; hosts?: string[]; models?: string[]; reason?: string },
		  ) => Promise<{ ok: boolean; remember: boolean }>)
		| undefined = undefined;
	/** 授权表**变了**（新授权落盘/撤销）时触发 —— 设置面板「已授权能力」即时刷新。 */
	onPermGrantsChanged: (() => void) | undefined = undefined;
	/** 会话统计订阅（host.onStats 注册到这里；emitStats 异常隔离扇出）。 */
	readonly statsHandlers = new Set<(s: PluginStats) => void>();
	/** 流式增量订阅（host.onStreaming 注册到这里；emitStreaming 只透传，发送方负责节流）。 */
	readonly streamingHandlers = new Set<(ev: { conversationId?: string; delta: string }) => void>();
	/** 插件间总线订阅：topic → 处理器集合（host.events.on 注册；反激活时清理该插件全部订阅）。 */
	readonly busHandlers = new Map<string, Set<(ev: PluginBusEvent) => void>>();
	/** host.chatWait 的 run_end 等待者（emitRunEvent 里按 conversationId 唤醒）。 */
	private chatWaiters: Array<{ conversationId: string; done: (ended: boolean) => void }> = [];
	/** 激活期插件的能力门控快照（activate 开头写入、落盘 loaded 或失败即删）：
	 *  canUse 在 host 对象可用之前（loaded.set 之前）也要能判定。 */
	private activatingGates = new Map<string, GateRecord>();

	/** 会话统计扇出（异常隔离；订阅者崩了只记日志）。发送方（如定期推送快照统计处）负责节流。 */
	emitStats(s: PluginStats): void {
		for (const h of this.statsHandlers) {
			try {
				h(s);
			} catch (err) {
				console.error("[plugins] stats handler failed:", err);
			}
		}
	}

	/** 流式增量透传（异常隔离；宿主不做节流，由发送方保证频率）。 */
	emitStreaming(ev: { conversationId?: string; delta: string }): void {
		for (const h of this.streamingHandlers) {
			try {
				h(ev);
			} catch (err) {
				console.error("[plugins] streaming handler failed:", err);
			}
		}
	}

	/** 能力门控统一入口（原 activate 内联 can() 的抽出）：
	 *  - 声明 "fs" = 读写全开（向后兼容）；仅声明 "fs:read" 时 "fs" 全量不算拥有
	 *    （读放行、写与 project.create 被拒，错误提示缺 fs/fs:write）；
	 *  - 其它族精确匹配；"dom:anchor" 与 "dom" 互不相干（各管各的族）；
	 *  - 未声明 permissions 且 apiVersion<2 = 旧全权模式（警告一次后放行）。 */
	private canUse(pluginId: string, family: string): boolean {
		const rec: GateRecord | undefined = this.activatingGates.get(pluginId) ?? this.loaded.get(pluginId);
		const fam = String(family ?? "");
		const deny = (what: string): boolean => {
			console.error(`[plugin:${pluginId}] 缺少能力声明 "${what}"（manifest.permissions）——请求被拒`);
			this.pushRuntimeDiag(pluginId, `missing capability "${what}" (manifest.permissions) — request denied`);
			return false;
		};
		if (!rec) return deny(fam);
		const full = new Set(rec.permsDeclared ?? []);
		const strict = rec.strictMode ?? (rec.permsDeclared?.length ?? 0) > 0;
		const legacy = (what: string): boolean => {
			if (!strict) {
				if (!rec.legacyWarned) {
					rec.legacyWarned = true;
					console.warn(
						`[plugin:${pluginId}] manifest 未声明 permissions（旧格式全权模式）——已放行 "${what}"；apiVersion 2 起将默认拒绝，请尽快声明`,
					);
				}
				return true;
			}
			return deny(what);
		};
		if (fam === "fs:read" || fam === "fs:write") {
			if (full.has("fs") || full.has(fam)) return true;
			return legacy(fam);
		}
		if (fam === "fs") {
			if (full.has("fs")) return true;
			return legacy(fam);
		}
		if ((rec.permFamilies ?? new Set<string>()).has(fam)) return true;
		return legacy(fam);
	}

	/** host.chatWait 等待指定对话的 run_end（默认 120s 超时由调用方钳制后传入）。 */
	private waitRunEnd(conversationId: string, timeoutMs: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const entry = {
				conversationId,
				done: (ended: boolean) => {
					clearTimeout(timer);
					const i = this.chatWaiters.indexOf(entry);
					if (i >= 0) this.chatWaiters.splice(i, 1);
					resolve(ended);
				},
			};
			const timer = setTimeout(() => entry.done(false), timeoutMs);
			this.chatWaiters.push(entry);
		});
	}

	/** 当前打开对话的快照（无提供者/暂无对话时返回 null）。
	 *  #542：options.clientId 取该标签页正在看的对话；缺省 = 全局回落
	 *  （最近活跃的**非子代理**会话，子代理不再把用户正在看的对话挤出去）。 */
	getActiveConversation(options?: PluginConversationQuery): PluginConversationSnapshot | null {
		let snap: PluginConversationSnapshot | null;
		try {
			snap = this.conversationProvider?.(options) ?? null;
		} catch (err) {
			console.error("[plugins] conversationProvider failed:", err);
			return null;
		}
		return snap ? copySnapshotForPlugins(snap) : null;
	}

	/** agent-service 调：某客户端的对话模型切换成功（#542）—— 订阅
	 *  host.onClientModelChanged 的插件立即收到新快照（异常隔离，不会拖慢切换）。 */
	emitClientModelChanged(snap: PluginConversationSnapshot): void {
		const copy = copySnapshotForPlugins(snap);
		for (const p of this.loaded.values()) {
			const hs = p.modelChangeHandlers;
			if (!hs || hs.size === 0) continue;
			for (const h of hs) {
				try {
					h(copy);
				} catch (err) {
					console.error(`[plugin:${p.info.id}] client-model-changed handler failed:`, err);
				}
			}
		}
	}

	/** agent-service 调：当前打开对话变了（切历史会话/切 running 对话/新对话）——
	 *  轨迹类插件靠它重拉时间线（异常隔离）。 */
	emitConversationChanged(): void {
		for (const p of this.loaded.values()) {
			if (p.convChangeHandlers.size === 0) continue;
			for (const h of p.convChangeHandlers) {
				try {
					h();
				} catch (err) {
					console.error(`[plugin:${p.info.id}] conversation-changed handler failed:`, err);
				}
			}
		}
	}

	/** agent-service 调：把运行轨迹事件扇出给所有插件（异常隔离，
	 *  与 emitToolEvent 同级；订阅者崩了只记日志，不影响主流程）。
	 *  run_end 顺带唤醒 host.chatWait 的等待者（按 conversationId 匹配）。 */
	emitRunEvent(ev: PluginRunEvent): void {
		if (ev.type === "run_end" && ev.conversationId) {
			for (const w of this.chatWaiters) {
				if (w.conversationId !== ev.conversationId) continue;
				try {
					w.done(true);
				} catch (err) {
					console.error(`[plugins] chatWait waiter failed:`, err);
				}
			}
		}
		for (const p of this.loaded.values()) {
			if (p.runHandlers.size === 0) continue;
			for (const h of p.runHandlers) {
				try {
					h(ev);
				} catch (err) {
					console.error(`[plugin:${p.info.id}] run-event handler failed:`, err);
				}
			}
		}
	}

	/** 某插件的 AI 工具展示快照（设置面板用；按工具名稳定排序；无工具回 []）。
	 *  纯展示字段，不含 execute。 */
	agentToolsSnapshot(pluginId: string): UiPluginAgentTool[] {
		const table = this.agentTools.get(pluginId);
		if (!table) return [];
		return [...table.values()]
			.map((t) => ({
				name: t.name,
				...(t.label ? { label: t.label } : {}),
				...(t.description ? { description: t.description } : {}),
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** 全部分组快照（设置面板“按插件分组”展示用；无工具的插件不出现；按插件 id 排序）。 */
	getAgentToolsGrouped(): { pluginId: string; tools: UiPluginAgentTool[] }[] {
		const out: { pluginId: string; tools: UiPluginAgentTool[] }[] = [];
		for (const pid of [...this.agentTools.keys()].sort()) {
			const tools = this.agentToolsSnapshot(pid);
			if (tools.length) out.push({ pluginId: pid, tools });
		}
		return out;
	}

	/** 当前全部插件注册的 AI 工具（扁平化，按插件 id 稳定排序，附带所属 pluginId）。 */
	getAgentTools(): PluginAgentTool[] {
		const out: PluginAgentTool[] = [];
		for (const [pid, table] of [...this.agentTools.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			for (const tool of table.values()) {
				out.push({ ...tool, pluginId: pid });
			}
		}
		return out;
	}
	/** 注册一个供 AI 调用的工具；重名拒绝并返回空操作注销函数。
	 *  跨插件重名同样拒绝（与 registerCommand 同口径）：工具进会话时按名字合入
	 *  （syncPluginToolsIntoSession 的 byName 覆盖），重名意味着后注册者静默抢注
	 *  前者的工具，必须在这里挡下。 */
	private registerAgentTool(pluginId: string, tool: PluginAgentTool): () => void {
		if (!tool || typeof tool.execute !== "function" || !tool.name || !tool.description) {
			console.error(`[plugin:${pluginId}] registerAgentTool: 缺少 name/description/execute，忽略`);
			this.pushRuntimeDiag(pluginId, "registerAgentTool: missing name/description/execute, ignored");
			return () => {};
		}
		for (const [pid, other] of this.agentTools) {
			if (pid !== pluginId && other.has(tool.name)) {
				console.error(`[plugin:${pluginId}] AI 工具 "${tool.name}" 已被插件 ${pid} 注册，忽略重复`);
				this.pushRuntimeDiag(pluginId, `agent tool "${tool.name}": already registered by plugin ${pid}, ignored`);
				return () => {};
			}
		}
		let table = this.agentTools.get(pluginId);
		if (!table) this.agentTools.set(pluginId, (table = new Map()));
		if (table.has(tool.name)) {
			console.error(`[plugin:${pluginId}] AI 工具 "${tool.name}" 重复注册，忽略`);
			this.pushRuntimeDiag(pluginId, `agent tool "${tool.name}": duplicate registration, ignored`);
			return () => {};
		}
		table.set(tool.name, tool);
		console.log(`[plugin:${pluginId}] registered AI tool: ${tool.name}`);
		try {
			this.onAgentToolsChanged?.();
		} catch (err) {
			console.error("[plugins] onAgentToolsChanged failed:", err);
		}
		return () => {
			if (table.delete(tool.name)) {
				if (table.size === 0) this.agentTools.delete(pluginId);
				try {
					this.onAgentToolsChanged?.();
				} catch {
					/* shutting down */
				}
			}
		};
	}

	/** 注册斜杠命令：跨插件重名拒绝（先注册者胜出），onCommandsChanged 通知目录刷新。 */
	private registerCommand(pluginId: string, cmd: PluginCommandDef): () => void {
		const name = String(cmd?.name ?? "").replace(/^\/+/, ""); // 容忍误带的前导 /
		if (!/^[a-zA-Z][a-zA-Z0-9:_-]*$/.test(name)) {
			console.error(
				`[plugin:${pluginId}] registerCommand: 非法名称「${cmd?.name}」（需字母开头，允许字母数字:_-），忽略`,
			);
			this.pushRuntimeDiag(
				pluginId,
				`registerCommand: invalid name "${String(cmd?.name ?? "").slice(0, 32)}", ignored`,
			);
			return () => {};
		}
		if (typeof cmd?.run !== "function") {
			console.error(`[plugin:${pluginId}] registerCommand: ${name} 缺少 run，忽略`);
			this.pushRuntimeDiag(pluginId, `command "/${name}": missing run, ignored`);
			return () => {};
		}
		for (const [pid, table] of this.pluginCommands) {
			if (table.has(name) && pid !== pluginId) {
				console.error(`[plugin:${pluginId}] 命令 /${name} 已被插件 ${pid} 注册，忽略重复`);
				this.pushRuntimeDiag(pluginId, `command "/${name}": already registered by plugin ${pid}, ignored`);
				return () => {};
			}
		}
		let table = this.pluginCommands.get(pluginId);
		if (!table) this.pluginCommands.set(pluginId, (table = new Map()));
		if (table.has(name)) {
			console.error(`[plugin:${pluginId}] 命令 /${name} 重复注册，忽略`);
			this.pushRuntimeDiag(pluginId, `command "/${name}": duplicate registration, ignored`);
			return () => {};
		}
		const def: PluginCommandDef = { ...cmd, name };
		table.set(name, def);
		console.log(`[plugin:${pluginId}] registered command: /${name}`);
		try {
			this.onCommandsChanged?.();
		} catch (err) {
			console.error("[plugins] onCommandsChanged failed:", err);
		}
		return () => {
			if (table!.delete(name)) {
				if (table!.size === 0) this.pluginCommands.delete(pluginId);
				try {
					this.onCommandsChanged?.();
				} catch {
					/* shutting down */
				}
			}
		};
	}

	/** 取（或建）某插件的运行时 UI 状态。 */
	private uiRuntimeFor(pluginId: string): UiRuntimeUi {
		let rt = this.uiRuntime.get(pluginId);
		if (!rt) this.uiRuntime.set(pluginId, (rt = { items: new Map(), removed: new Set(), arrange: [] }));
		return rt;
	}

	/** 移除一个条目（运行时注册的或 manifest 声明的都记进 removed，保证合并时不复活）。 */
	private removeUiItem(pluginId: string, itemId: string): void {
		const rt = this.uiRuntimeFor(pluginId);
		rt.items.delete(itemId);
		rt.removed.add(itemId);
	}

	/** 该绝对路径是否落在当前工作区（或其额外根）内：工作区内的路径本来就能访问，
	 *  不必走授权。多根语义见 protocol 的 set_workspace_roots —— 用户把一个目录加成
	 *  工作区根，就是「我认它是我工作区的一部分」，插件读它无需再问。 */
	isInsideWorkspace(abs: string): boolean {
		for (const root of [this.cwdValue, ...this.workspaceRoots]) {
			const rel = relative(root, abs);
			if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return true;
		}
		return false;
	}

	/** 某插件当前生效的 UI 贡献 = manifest 基线 + 运行时注册（同 id 覆盖、removed 删除）。 */
	uiOf(pluginId: string): UiPluginUi | undefined {
		return mergeUiPluginUi(this.uiBase.get(pluginId), this.uiRuntime.get(pluginId));
	}

	/** 追加一条运行时诊断（去重 + 100 条封顶），并同步到已加载条目的 info 快照。
	 *  去重是因为门控拒绝（canUse）会在每次调用时触发，重复调用不应刷屏。 */
	private pushRuntimeDiag(pluginId: string, msg: string): void {
		if (!ID_RE.test(pluginId)) return;
		let arr = this.runtimeDiags.get(pluginId);
		if (!arr) this.runtimeDiags.set(pluginId, (arr = []));
		if (arr.includes(msg)) return;
		if (arr.length < 100) arr.push(msg);
		const p = this.loaded.get(pluginId);
		if (p) {
			const combined = this.diagnosticsOf(pluginId);
			if (combined) p.info.diagnostics = combined;
			else delete p.info.diagnostics;
		}
	}

	/** 合并某插件的诊断（manifest 解析 + 运行时），无诊断返回 undefined。
	 *  返回的是快照拷贝，调用方可直接挂到 UiPluginInfo 上。 */
	private diagnosticsOf(pluginId: string): string[] | undefined {
		const m = this.manifestDiags.get(pluginId) ?? [];
		const r = this.runtimeDiags.get(pluginId) ?? [];
		if (!m.length && !r.length) return undefined;
		return [...m, ...r].slice(0, 100);
	}

	/** 追加一条运行时日志（封顶丢弃最旧的；文本截断封顶）。 */
	appendPluginLog(pluginId: string, level: PluginLogLevel, text: string): void {
		if (!ID_RE.test(pluginId)) return;
		let arr = this.pluginLogs.get(pluginId);
		if (!arr) this.pluginLogs.set(pluginId, (arr = []));
		arr.push({
			ts: Date.now(),
			level,
			text: text.length > PLUGIN_LOG_TEXT_MAX ? text.slice(0, PLUGIN_LOG_TEXT_MAX) : text,
		});
		if (arr.length > PLUGIN_LOG_CAP) arr.splice(0, arr.length - PLUGIN_LOG_CAP);
	}

	/** 读某插件的运行时日志（快照拷贝；未知插件回 []）。 */
	getPluginLogs(pluginId: string): PluginLogEntry[] {
		return (this.pluginLogs.get(pluginId) ?? []).map((e) => ({ ...e }));
	}

	/** 清空某插件的运行时日志（设置面板“清空”按钮用）。 */
	clearPluginLogs(pluginId: string): void {
		if (!ID_RE.test(pluginId)) return;
		this.pluginLogs.set(pluginId, []);
	}

	private deliverAll(msg: ServerMessage): void {
		for (const s of this.senders) {
			try {
				s.send(msg);
			} catch {
				/* dead socket — index.ts cleans it up */
			}
		}
	}

	/** P3：节流广播左栏运行条目（同一窗口内的多次变更合并成一条，约 500ms）。 */
	schedulePanelPush(): void {
		if (this.panelPushTimer) return;
		this.panelPushTimer = setTimeout(() => {
			this.panelPushTimer = null;
			this.deliverAll({ type: "plugin_panel_items", groups: this.panelRunning.groups() });
		}, 500);
		this.panelPushTimer.unref?.();
	}
	/** P3：心跳扫描（有条目才跑，每 5 秒）：过期即清空并广播；条目全无则停表。 */
	ensurePanelSweep(): void {
		if (this.panelSweepTimer) return;
		this.panelSweepTimer = setInterval(() => {
			const expired = this.panelRunning.sweep();
			if (expired.length) this.schedulePanelPush();
			if (this.panelRunning.size === 0 && this.panelSweepTimer) {
				clearInterval(this.panelSweepTimer);
				this.panelSweepTimer = null;
			}
		}, 5000);
		this.panelSweepTimer.unref?.();
	}
	/** P3：attach 时补发的全量（index.ts 用）。 */
	panelGroups(): PluginPanelGroup[] {
		return this.panelRunning.groups();
	}

	/** 当前目录清单（重扫 manifest，不重新 import）。 */
	async list(lang?: () => ServerLang): Promise<UiPluginInfo[]> {
		return this.scan(lang);
	}

	/** 机器可读的注册面目录（P2-7）：slot 别名/kind/例子 + 工具目录 +
	 *  宿主方法表 + 当前占用者（现算）。只读装配，无副作用。 */
	getApiCatalog(): PluginApiCatalog {
		const counts = new Map<string, Map<string, number>>();
		const add = (pluginId: string, slot: string): void => {
			let m = counts.get(slot);
			if (!m) counts.set(slot, (m = new Map()));
			m.set(pluginId, (m.get(pluginId) ?? 0) + 1);
		};
		for (const [pid, base] of this.uiBase) for (const it of base.items ?? []) add(pid, it.slot);
		for (const [pid, rt] of this.uiRuntime) for (const it of rt.items.values()) add(pid, it.slot);
		return buildPluginApiCatalog({
			slots: [...UI_SLOTS],
			aliases: { ...UI_SLOT_ALIASES },
			kinds: [...UI_KINDS],
			agentTools: AGENT_TOOL_CATALOG.map((t) => ({
				name: t.name,
				group: t.group,
				defaultOn: t.defaultOn,
				dshVisible: t.dshVisible,
			})),
			occupantsOf: (slot) => {
				const m = counts.get(slot);
				if (!m) return [];
				return [...m].map(([pluginId, items]) => ({ pluginId, items }));
			},
		});
	}

	/**
	 * attach 时调用：重扫目录 + 激活尚未加载的新插件。
	 * 返回给浏览器的目录（含激活失败的条目，前端显示为不可用）。
	 */
	async ensureLoaded(lang?: () => ServerLang): Promise<UiPluginInfo[]> {
		const l = lang?.() ?? "en";
		const found = await this.scan(lang);
		const byId = new Map(found.map((f) => [f.id, f]));
		const scannedIds = new Set(byId.keys());
		// P2-8：依赖拓扑排序激活（被依赖者先行；决定启动时机的是依赖，不是目录顺序）。
		// 边只连本次扫描里存在的对端；缺失的对端由 activate 点名拒绝。环上节点直接拒。
		const { order, cyclic } = sortByRequires(
			found.map((f) => f.id),
			(id) => (byId.get(id)?.requires?.plugins ?? []).filter((d) => scannedIds.has(d)),
		);
		for (const cycId of cyclic) {
			const info = byId.get(cycId)!;
			if (this.loaded.has(info.id) || this.attempted.has(info.id)) continue;
			const msg = pick(
				l,
				`插件 requires 存在循环依赖（${cycId}）—— 请先解环再激活`,
				`Plugin has cyclic requires (${cycId}) — break the cycle first`,
				"plugins.requires.cycle",
				{ id: cycId },
			);
			this.setFrozenRefusal(info, msg, `cyclic requires (${cycId})`);
		}
		for (const id of order) {
			const info = byId.get(id)!;
			if (this.loaded.has(info.id) || this.attempted.has(info.id)) continue;
			if (!existsSync(join(this.pluginsDir, info.id, "index.mjs"))) continue; // 纯前端插件
			await this.activate(info, lang);
		}
		// 已被删除的插件：调用 deactivate 并移出缓存
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const [id, p] of [...this.loaded]) {
			if (!found.some((f) => f.id === id)) {
				this.deactivateEntry(id, p);
			}
		}
		// P2-8 级联：提供方刚坏（被删/失败/被拒）→ 仍在跑的消费方一并反激活 + 教学占位。
		this.cascadeRequiresRefusals(found, lang);
		return found.map((f) => {
			const base = this.loaded.get(f.id)?.info ?? f;
			// 运行相位（设置面板清单用）：宿主持有实例即 active（含激活失败的占位行；
			// 纯前端插件无 index.mjs、从未进 loaded 表，保持非 active）。
			const withPhase = { ...base, active: this.loaded.has(f.id) };
			const agentTools = this.agentToolsSnapshot(f.id);
			if (agentTools.length) return { ...withPhase, agentTools };
			const { agentTools: _drop, ...rest } = withPhase as UiPluginInfo & { agentTools?: unknown };
			return rest;
		});
	}

	/** 反激活清理：把该插件名下全部订阅/注册一次收完。
	 *
	 *  两段：① 副作用栈逆序回卷（插件注册的全部可逆副作用都在里面 —— 工具/命令/路由/
	 *  代理/watch/定时/后台任务/事件订阅/UI 条目…；跑不干净的记一条诊断）；
	 *  ② 兜底回收全局表里按 pluginId 索引的残留（老宿主激活的实例没有栈、或
	 *  插件绕过 host 自己往表里塞过东西：代理前缀按 id 过滤清一遍，幂等）。 */
	private releaseEntry(p: LoadedPlugin): void {
		// ① 逆序回卷。失败项已在栈内打过诊断，这里不再重复。
		const failed = p.effects?.release() ?? [];
		if (failed.length > 0)
			console.warn(`[plugin:${p.info.id}] ${failed.length} effect(s) failed to clean up: ${failed.join(", ")}`);
		// ② 兜底：代理前缀随反激活一起回收（全局表按 pluginId 过滤；
		// Map 迭代中删除是良定义的：删过的条目不会再被访问到）。
		for (const [prefix, hit] of this.proxyRoutes) {
			if (hit.pluginId === p.info.id) this.proxyRoutes.delete(prefix);
		}
	}

	/** 反激活单个插件：deactivate + 注销 AI 工具 + 清缓存。
	 *
	 *  注意这里必须把 id 从 attempted 里摘掉：目录一时不在（`pi-web-ui install --force`
	 *  先 rm 再 cp，扫描正好撞上窗口期）只是「暂时看成卸载」，目录回来后还要能重新激活；
	 *  留在 attempted 里 = 本进程内永远不再激活，插件的 HTTP 路由 / AI 工具全没了，
	 *  前端只会看到「代理请求失败 404 <url>」（插件的 /proxy 路由不存在），且 CLI 承诺的
	 *  「刷新浏览器即可加载」失效，必须重启服务才能恢复。 */
	private deactivateEntry(id: string, p: LoadedPlugin): void {
		try {
			p.deactivate?.();
		} catch (err) {
			console.error(`[plugin:${id}] deactivate failed:`, err);
		}
		this.releaseEntry(p);
		this.loaded.delete(id);
		this.messageHandlers.delete(id);
		this.attempted.delete(id);
		// 运行时 UI 注册随插件一起消失（manifest 基线留着，重扫时会重算）。
		this.uiRuntime.delete(id);
		this.uiBase.delete(id);
		// 诊断随插件一起清：目录回来重新激活时会重算（旧诊断留着会误导）。
		this.manifestDiags.delete(id);
		this.runtimeDiags.delete(id);
		// 运行时日志同样随插件走（内存缓冲，不落盘）。
		this.pluginLogs.delete(id);
		// 重新激活时会 import 磁盘上的 index.mjs：Node 的 ESM 缓存按 URL（含 ?e=）
		// 命中，epoch 不变就会拿到旧模块（更新插件后还是旧代码）——所以这里也 +1，
		// 顺带让浏览器端 ?e= 变化、重拉插件的 client bundle。
		this.epochCounter += 1;
		console.log(`[plugin:${id}] removed`);
	}

	/** 关机 / reload 时反激活全部插件（dispose 后 loaded 为空，后续 releaseEntry 是 no-op）。 */
	dispose(): void {
		const pluginIds = new Set<string>();
		for (const [id, p] of this.loaded) {
			pluginIds.add(id);
			try {
				p.deactivate?.();
			} catch (err) {
				console.error(`[plugin:${id}] deactivate failed:`, err);
			}
		}
		// ① 先回卷全部 effect 栈（含 bgTask 停表、工具/命令/路由/watch/UI 条目注销），
		//    并把 loaded 清掉 —— 之后逐个走 releaseEntry 的兜底回收。
		for (const [id, p] of this.loaded) {
			p.effects?.release();
			this.loaded.delete(id);
		}
		// ② 兜底：停掉任何没经 effect 栈登记的常驻后台任务，不留孤儿计时器。
		for (const id of pluginIds) {
			for (const t of this.pluginBgTasks.get(id)?.values() ?? []) {
				try {
					t.stop?.();
				} catch {
					// best-effort：反激活清理，单个任务失败不阻断。
				}
			}
		}
		// ③ 兜底：清掉插件名下的代理前缀（该插件名下但未经栈登记的残留）。
		for (const prefix of this.proxyRoutes.keys()) {
			if (pluginIds.has(this.proxyRoutes.get(prefix)!.pluginId)) this.proxyRoutes.delete(prefix);
		}
		this.pluginBgTasks.clear();
		this.loaded.clear();
		this.messageHandlers.clear();
		// reload() 走 dispose→ensureLoaded：诊断清掉重算，不跨代累积。
		this.manifestDiags.clear();
		this.runtimeDiags.clear();
		this.pluginLogs.clear();
	}

	/**
	 * 检查随包内置官方插件（<pkgRoot>/plugins/）与用户数据目录（<dataDir>/plugins/）的版本。
	 * 若用户已安装的官方插件版本落后于当前随包版本，自动备份旧版本并增量同步更新代码（保留用户数据/设置）。
	 */
	private syncBuiltinPlugins(): void {
		if (!this.builtinCatalogPath || !existsSync(this.builtinCatalogPath)) return;
		const builtinDir = dirname(this.builtinCatalogPath);
		if (!existsSync(builtinDir)) return;

		let names: string[];
		try {
			names = readdirSync(this.pluginsDir);
		} catch {
			return;
		}

		// 只有在官方 catalog.json 中登记的官方插件，才属于随宿主自动同步维护的对象（避免误覆盖测试或非 catalog 目录）
		let builtinCatalogIds: Set<string>;
		try {
			const catalogEntries = JSON.parse(readFileSync(this.builtinCatalogPath, "utf8")) as Array<{ id?: string }>;
			builtinCatalogIds = new Set(
				catalogEntries.map((e) => e?.id).filter((id): id is string => typeof id === "string"),
			);
		} catch {
			builtinCatalogIds = new Set();
		}

		for (const name of names) {
			if (!ID_RE.test(name) || !builtinCatalogIds.has(name)) continue;
			const targetDir = join(this.pluginsDir, name);
			const sourceDir = join(builtinDir, name);
			const targetManifest = join(targetDir, "manifest.json");
			const sourceManifest = join(sourceDir, "manifest.json");

			if (!existsSync(sourceDir) || !existsSync(sourceManifest) || !existsSync(targetManifest)) {
				continue;
			}

			try {
				const srcRaw = JSON.parse(readFileSync(sourceManifest, "utf8")) as { version?: string };
				const tgtRaw = JSON.parse(readFileSync(targetManifest, "utf8")) as { version?: string };
				const srcVer = typeof srcRaw.version === "string" ? srcRaw.version.trim() : "";
				const tgtVer = typeof tgtRaw.version === "string" ? tgtRaw.version.trim() : "";

				if (srcVer && tgtVer && compareVersions(srcVer, tgtVer) > 0) {
					ensureBackup(this.dataDir, name, { source: `builtin:${srcVer}` });
					cpSync(sourceDir, targetDir, {
						recursive: true,
						filter: (s) => !/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(s),
					});
					console.log(`[plugins] 内置插件 ${name} 随宿主自动同步升级：${tgtVer} → ${srcVer}`);
				}
			} catch (err) {
				console.warn(`[plugins] 自动同步内置插件 ${name} 失败:`, err);
			}
		}
	}

	/** 读 manifest 清单；坏目录（无 manifest/id 非法）直接跳过。 */
	private async scan(lang?: () => ServerLang): Promise<UiPluginInfo[]> {
		this.syncBuiltinPlugins();
		const l = lang?.() ?? "en";
		let names: string[];
		try {
			names = await readdir(this.pluginsDir);
		} catch {
			return []; // 目录不存在 = 没装任何插件
		}
		const out: UiPluginInfo[] = [];
		for (const name of names.sort()) {
			if (!ID_RE.test(name)) continue;
			const dir = join(this.pluginsDir, name);
			try {
				if (!(await stat(dir)).isDirectory()) continue;
				const raw = await readFile(join(dir, "manifest.json"), "utf8");
				// wantsDom 快照供静态门禁用（manifest 坏了 → JSON.parse 抛 → catch 跳过，旧快照残留无害：门禁只拦「快照里要且没授权」的）。
				const m = JSON.parse(raw) as {
					id?: string;
					name?: string;
					version?: string;
					description?: string;
					homepage?: string;
					icon?: string;
					iconSvg?: string;
					apiVersion?: number;
					permissions?: unknown;
					netAllowlist?: unknown;
					engines?: unknown;
					peerPlugins?: unknown;
					requires?: unknown;
					settings?: unknown;
					renderers?: unknown;
					messageWidgets?: unknown;
					attachmentCards?: unknown;
					composerProviders?: unknown;
					fileHandlers?: unknown;
					view?: unknown;
					preload?: unknown;
					ui?: unknown;
				};
				const wantsDom = declarationWantsDom(m.permissions);
				this.domWants.set(name, wantsDom);
				// 本轮 manifest 解析的诊断（重算覆盖；运行时诊断另存在 runtimeDiags）。
				const uiDiags: string[] = [];
				// P1-6：manifest 本体先校验，失败即拒（坏配置不进运行时）。
				const mv = validatePluginManifest(m, name);
				for (const w of mv.warnings) uiDiags.push(formatManifestIssue(w));
				if (mv.errors.length > 0) {
					for (const e of mv.errors) uiDiags.push(formatManifestIssue(e));
					const first = mv.errors[0]!;
					const msg = pick(
						l,
						`manifest 校验失败：${first.message}（${name}/）—— 修复后点“重新扫描”`,
						`manifest validation failed: ${first.messageEn} (${name}/) — fix it, then hit Rescan`,
						"plugins.manifest.invalid",
						{ name, path: first.path },
					);
					console.error(`[plugin:${name}] ${msg}`);
					this.manifestDiags.set(name, uiDiags);
					const refused = [...uiDiags, ...(this.runtimeDiags.get(name) ?? [])].slice(0, 100);
					out.push({
						id: name,
						name: typeof m.name === "string" && m.name ? m.name : name,
						hasClient: existsSync(join(dir, "client", "entry.mjs")),
						error: msg,
						view: false,
						...(refused.length ? { diagnostics: refused } : {}),
					});
					const lpRefused = this.loaded.get(name);
					if (lpRefused) {
						if (refused.length) lpRefused.info.diagnostics = [...refused];
						else delete lpRefused.info.diagnostics;
					}
					continue;
				}
				// P2-9：声明式设置的三层合并（schema 默认 < 用户 overlay < 面板保存值）。
				// overlay 先读先洗，警告进诊断（英文短句，随清单下发）；secret 永不来自 overlay。
				const settingsSchemaForScan = parseSettingsSchema(m.settings);
				const overlayFileForScan = readSettingsOverlayFile(this.dataDir, name);
				const overlayForScan = cleanOverlaySettings(settingsSchemaForScan, overlayFileForScan.raw, "en");
				for (const w of [...overlayFileForScan.warnings, ...overlayForScan.warnings]) uiDiags.push(`override: ${w}`);
				const resolvedSettingsForScan = resolveSettingsValues(
					settingsSchemaForScan,
					readStoredSettings(dir),
					overlayForScan.values,
					{ has: (k) => new PluginSecrets(this.dataDir, dir).has(k) },
				);
				out.push({
					id: name,
					name: typeof m.name === "string" && m.name ? m.name : name,
					version: typeof m.version === "string" ? m.version : undefined,
					description: typeof m.description === "string" ? m.description : undefined,
					homepage: typeof m.homepage === "string" && m.homepage.trim() ? m.homepage.trim() : undefined,
					icon: typeof m.icon === "string" && m.icon.trim() ? m.icon.trim() : undefined,
					iconSvg: normalizeIconSvg(m.iconSvg),
					hasClient: existsSync(join(dir, "client", "entry.mjs")),
					error: this.loaded.get(name)?.info.error,
					// manifest 声明的能力清单（fs/net/tools…）——设置面板展示用
					permissions: Array.isArray(m.permissions)
						? m.permissions.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, 16)
						: undefined,
					// 出站网络白名单（permissions 含 "net" 时生效；空/缺省 = 全拒，fail-closed）。
					netAllowlist: Array.isArray(m.netAllowlist)
						? m.netAllowlist
								.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
								.map((x) => x.trim().toLowerCase())
								.slice(0, 32)
						: undefined,
					// 引擎约束（{ "pi-web-ui": ">=x.y.z" }，不满足即拒绝激活，见 activate）。
					engines:
						m.engines && typeof m.engines === "object" && !Array.isArray(m.engines)
							? (Object.fromEntries(
									Object.entries(m.engines as Record<string, unknown>)
										.filter(([, v]) => typeof v === "string")
										.slice(0, 8),
								) as Record<string, string>)
							: undefined,
					// 可选对等依赖（其它插件 id，缺失只警告不断活，见 activate）。
					peerPlugins: Array.isArray(m.peerPlugins)
						? m.peerPlugins.filter((x): x is string => typeof x === "string" && ID_RE.test(x)).slice(0, 16)
						: undefined,
					// 硬依赖声明（manifest "requires"，P2-8）：形状坏的在 P1-6 校验层已拒，
					// 这里只做宽容解析供展示 + activate 语义判定（缺失/失败/环/版本/能力即拒）。
					requires: parseRequires(m.requires),
					// 特权 DOM：permissions 含 dom 族 → bundle 默认 403，需用户逐个授权。
					// wantsDom 缓进 domWants（静态门禁查它，不必每次 readdir）；error 在未授权时
					// 直接写明原因（tab 置灰 + 设置行提示），授权后下次 scan 自动清除。
					...(wantsDom
						? {
								wantsDom: true as const,
								domGranted: this.domConsentStore.has(name),
								...(this.domConsentStore.has(name)
									? {}
									: {
											error: this.loaded.get(name)?.info.error ?? "需授权完全 DOM 访问后加载（设置 → 界面插件 → 授权）",
										}),
							}
						: {}),
					// 声明式设置 schema + 当前存值（⚙ 面板自动渲染表单用）
					settingsSchema: settingsSchemaForScan,
					settingsValues: resolvedSettingsForScan.values,
					settingsSources: resolvedSettingsForScan.sources,
					// 可渲染的 fenced-code 语言（manifest "renderers"）——前端据此按需加载
					renderers: Array.isArray(m.renderers)
						? m.renderers.filter((r): r is string => typeof r === "string" && r.length > 0).slice(0, 32)
						: undefined,
					// 自定义消息部件 / 附件卡 / 输入框补全源（与 renderers 同一过滤口径）
					messageWidgets: Array.isArray(m.messageWidgets)
						? m.messageWidgets.filter((r): r is string => typeof r === "string" && r.length > 0).slice(0, 32)
						: undefined,
					attachmentCards: Array.isArray(m.attachmentCards)
						? m.attachmentCards.filter((r): r is string => typeof r === "string" && r.length > 0).slice(0, 32)
						: undefined,
					composerProviders: Array.isArray(m.composerProviders)
						? m.composerProviders.filter((r): r is string => typeof r === "string" && r.length > 0).slice(0, 32)
						: undefined,
					// 文件单击查看器声明：只下发扩展名/处理器 id/优先级，实际 DOM
					// 渲染仍由客户端 bundle 提供，避免 manifest 携带可执行内容。
					fileHandlers: (() => {
						if (!Array.isArray(m.fileHandlers)) return undefined;
						const rows = m.fileHandlers
							.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x))
							.slice(0, 32)
							.map((x) => {
								const extensions = Array.isArray(x.extensions)
									? x.extensions
											.filter(
												(e): e is string => typeof e === "string" && /^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(e.trim()),
											)
											.map((e) => e.trim().toLowerCase())
											.slice(0, 32)
									: [];
								if (!extensions.length) return null;
								const id = typeof x.id === "string" && /^[A-Za-z0-9_-]+$/.test(x.id) ? x.id : "default";
								return {
									id,
									extensions: [...new Set(extensions)],
									priority: Number.isFinite(Number(x.priority))
										? Math.max(-1000, Math.min(1000, Number(x.priority)))
										: 0,
									...(typeof x.label === "string" && x.label.trim() ? { label: x.label.trim().slice(0, 120) } : {}),
									...(typeof x.labelEn === "string" && x.labelEn.trim()
										? { labelEn: x.labelEn.trim().slice(0, 120) }
										: {}),
								};
							})
							.filter((x): x is NonNullable<typeof x> => x !== null);
						return rows.length ? rows : undefined;
					})(),
					// 是否有独立视图 tab（manifest "view"，缺省 true）；纯 renderer 插件写 false
					view: typeof m.view === "boolean" ? m.view : true,
					// 客户端 bundle 是否常驻加载（manifest "preload"，缺省 false）：无视图
					// （view:false）却要顶层代码一直跑（提醒轮询/快捷键/常驻浮窗…）的插件用它。
					preload: m.preload === true,
					// 插件对宿主 UI 的贡献（manifest "ui"：slot 框架 + 整理意图，issue #146）。
					// 权限：与 activate 的 can("ui") **同一口径**（严格模式 = 声明了 permissions
					// 或 apiVersion>=2）：严格模式下必须含 "ui" 族，否则整份忽略；旧全权格式放行。
					ui: (() => {
						const perms = Array.isArray(m.permissions)
							? m.permissions.filter((x): x is string => typeof x === "string")
							: [];
						const apiVersion = Number(m.apiVersion ?? 1) || 1;
						const strict = perms.length > 0 || apiVersion >= 2;
						if (strict && !perms.some((x) => x.split(":")[0] === "ui")) {
							this.uiBase.delete(name);
							if (m.ui !== undefined)
								uiDiags.push('ui ignored: strict mode requires "ui" capability (manifest.permissions)');
							return undefined;
						}
						const base = m.ui === undefined ? undefined : parseUiContributions(m.ui, uiDiags);
						if (base) this.uiBase.set(name, base);
						else this.uiBase.delete(name);
						return this.uiOf(name);
					})(),
					// 安装来源（pi-web-ui install 写入的 .pi-source.json）——
					// 设置面板据此显示「更新」按钮；手工拷入的插件没有此文件。
					source: await readFile(join(dir, ".pi-source.json"), "utf8")
						.then((raw) => {
							try {
								const s = JSON.parse(raw) as { source?: unknown };
								return typeof s.source === "string" && s.source ? s.source : undefined;
							} catch {
								return undefined;
							}
						})
						.catch(() => undefined),
				});
				// 诊断随清单下发：manifest 解析 + 到目前为止的运行时诊断。
				this.manifestDiags.set(name, uiDiags);
				const agentTools = this.agentToolsSnapshot(name);
				if (agentTools.length) out[out.length - 1]!.agentTools = agentTools;
				const scanned = [...uiDiags, ...(this.runtimeDiags.get(name) ?? [])].slice(0, 100);
				if (scanned.length) out[out.length - 1]!.diagnostics = scanned;
				const lp = this.loaded.get(name);
				if (lp) {
					if (scanned.length) lp.info.diagnostics = [...scanned];
					else delete lp.info.diagnostics;
				}
			} catch {
				// 无 manifest.json / JSON 解析失败 —— 占位行展示（坏插件不跳过，
				// 设置面板清单标红 + 给原因；ensureLoaded 照例跳过激活）。
				const msg = pick(
					l,
					`manifest.json 缺失或解析失败（${name}/），不是有效插件 —— 修复或移走该目录后点“重新扫描”`,
					`manifest.json missing or unparsable (${name}/), not a valid plugin — fix or remove the directory, then hit Rescan`,
					"plugins.manifest.broken",
					{ name },
				);
				console.error(`[plugin:${name}] ${msg}`);
				const brokenDiags = this.diagnosticsOf(name);
				out.push({
					id: name,
					name,
					hasClient: existsSync(join(dir, "client", "entry.mjs")),
					error: msg,
					view: false,
					...(brokenDiags ? { diagnostics: brokenDiags } : {}),
				});
			}
		}
		// 删掉的目录不同时清快照：门禁会把不存在的 id 当 403，正确的应该是 404。
		for (const key of this.domWants.keys()) {
			if (!out.some((p) => p.id === key)) this.domWants.delete(key);
		}
		for (const key of [...this.manifestDiags.keys(), ...this.runtimeDiags.keys(), ...this.pluginLogs.keys()]) {
			if (!out.some((p) => p.id === key)) {
				this.manifestDiags.delete(key);
				this.runtimeDiags.delete(key);
				this.pluginLogs.delete(key);
			}
		}
		return out;
	}

	/** 非 activate 上下文的拒绝占位（P2-8 环/级联）：空集合 + error + 诊断，
	 *  与各门控的占位行同形（ensureLoaded 照例跳过，reload 重算刷新）。 */
	private setFrozenRefusal(info: UiPluginInfo, msg: string, diagEn: string): void {
		console.error(`[plugin:${info.id}] ${msg}`);
		this.pushRuntimeDiag(info.id, diagEn);
		this.loaded.set(info.id, {
			info: { ...info, error: msg, diagnostics: this.diagnosticsOf(info.id) },
			toolHandlers: new Set(),
			runHandlers: new Set(),
			convChangeHandlers: new Set(),
			attachHandlers: new Set(),
			cwdHandlers: new Set(),
			httpRoutes: new Map(),
			settingsHandlers: new Set(),
		});
	}

	/** 级联（P2-8）：提供方刚坏掉（被删/失败/被拒）→ 仍在跑的消费方一并反激活 +
	 *  留教学占位。循环直到一轮无变化（链式依赖一轮收敛），返回受影响的 id。
	 *  hostApi/families 运行时不变，这里只查 plugins 对端（目录在 + 后端 peer 激活成功）。 */
	private cascadeRequiresRefusals(found: UiPluginInfo[], lang?: () => ServerLang): string[] {
		const l = lang?.() ?? "en";
		const byId = new Map(found.map((f) => [f.id, f]));
		const hit: string[] = [];
		for (;;) {
			let changed = false;
			for (const [id, p] of this.loaded) {
				if (p.info.error) continue;
				const req = byId.get(id)?.requires ?? p.info.requires;
				if (!req?.plugins?.length) continue;
				for (const dep of req.plugins) {
					let why = "";
					let whyEn = "";
					if (dep === id) {
						why = `插件 requires 依赖了自己（${dep}）—— 请删掉这条自依赖`;
						whyEn = `Plugin requires itself (${dep}) — remove the self-dependency`;
					} else if (!byId.has(dep)) {
						why = `插件 requires 对等插件「${dep}」但它已不在（被删/被拒）—— 装回来或去掉这条依赖`;
						whyEn = `Plugin requires peer "${dep}" which is gone (removed or refused) — reinstall it or drop the dependency`;
					} else if (existsSync(join(this.pluginsDir, dep, "index.mjs"))) {
						const peer = this.loaded.get(dep);
						if (!peer || peer.info.error) {
							why = `插件 requires 对等插件「${dep}」但它已失败/停止：${peer?.info.error ?? "未激活"}—— 修好它或去掉这条依赖`;
							whyEn = `Plugin requires peer "${dep}" which failed/stopped: ${peer?.info.error ?? "inactive"} — fix it or drop the dependency`;
						}
					}
					if (!why) continue;
					const msg = pick(l, why, whyEn, "plugins.requires.cascade", { dep });
					this.deactivateEntry(id, p);
					this.setFrozenRefusal(byId.get(id) ?? p.info, msg, whyEn);
					hit.push(id);
					changed = true;
					break;
				}
			}
			if (!changed) break;
		}
		return hit;
	}

	private async activate(info: UiPluginInfo, lang?: () => ServerLang): Promise<void> {
		const l = lang?.() ?? "en";
		this.attempted.add(info.id);
		const dir = join(this.pluginsDir, info.id);
		// P1-6：manifest 本体失败即拒（scan 缓存可能过期，这里重读重判，半途注册的副作用不留）。
		try {
			const rawManifest = readFileSync(join(dir, "manifest.json"), "utf8");
			const parsedManifest: unknown = JSON.parse(rawManifest);
			const mvActivate = validatePluginManifest(parsedManifest, info.id);
			if (mvActivate.errors.length > 0) {
				const first = mvActivate.errors[0]!;
				const msg = pick(
					l,
					`manifest 校验失败：${first.message} —— 修复后点“重新扫描”`,
					`manifest validation failed: ${first.messageEn} — fix it, then hit Rescan`,
					"plugins.manifest.invalid",
					{ name: info.id, path: first.path },
				);
				console.error(`[plugin:${info.id}] ${msg}`);
				for (const e of mvActivate.errors) this.pushRuntimeDiag(info.id, formatManifestIssue(e));
				for (const w of mvActivate.warnings) this.pushRuntimeDiag(info.id, formatManifestIssue(w));
				this.loaded.set(info.id, {
					info: { ...info, error: msg, diagnostics: this.diagnosticsOf(info.id) },
					toolHandlers: new Set(),
					runHandlers: new Set(),
					convChangeHandlers: new Set(),
					attachHandlers: new Set(),
					cwdHandlers: new Set(),
					httpRoutes: new Map(),
					settingsHandlers: new Set(),
				});
				return;
			}
		} catch {
			// 读不到/解析失败 → 走原有的 broken 占位逻辑（scan 里已产出，不在这里重复拒绝）。
		}
		const handlers = new Set<(payload: unknown) => void>();
		this.messageHandlers.set(info.id, handlers);
		const toolHandlers = new Set<(ev: PluginToolEvent) => void>();
		const preGuards = new Set<ToolPreHandler>();
		const postGuards = new Set<ToolPostHandler>();
		const runHandlers = new Set<(ev: PluginRunEvent) => void>();
		const convChangeHandlers = new Set<() => void>();
		const modelChangeHandlers = new Set<(snap: PluginConversationSnapshot) => void>();
		const attachHandlers = new Set<(clientId: string) => void>();
		const cwdHandlers = new Set<(cwd: string) => void>();
		const httpRoutes = new Map<string, (req: Request, res: Response) => void>();
		const bgTaskTable = new Map<string, PluginBgTask>();
		let leftPanelOwned = false;
		const settingsHandlers = new Set<(values: Record<string, unknown>) => void>();
		// 可逆副作用栈：本插件的全部注册面（工具/命令/路由/代理/watch/定时/后台任务/
		// UI 条目/事件订阅…）都经 effects.add 登记，反激活时**逆序**回卷 —— 插件忘写
		// 注销也不会留下孤儿订阅/定时器/路由（热重载后事件双触发、定时器叠加、watcher
		// 堆积都是这个漏法的症状）。cleanup 抛错只记诊断，不阻断回卷。
		const effects = new PluginEffectStack(info.id, (m) => this.pushRuntimeDiag(info.id, m));
		// 宿主 API 版本协商：插件要的比宿主新 → 明确拒绝（而不是让它在运行期
		// 撞 undefined 接口莫名其妙地坏）。与激活失败同一处理：error 字段 + 置灰。
		let apiVersion = 1;
		try {
			apiVersion = Number(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).apiVersion ?? 1) || 1;
		} catch {
			// best-effort：无 manifest/JSON 坏 → 按 apiVersion 1 处理。
		}
		if (apiVersion > PLUGIN_API_VERSION) {
			const msg = pick(
				l,
				`插件要求宿主 API v${apiVersion}，当前宿主 v${PLUGIN_API_VERSION} —— 请升级 pi-web-ui`,
				`Plugin requires host API v${apiVersion} but the host is v${PLUGIN_API_VERSION} — please upgrade pi-web-ui`,
				"plugins.host.api.mismatch",
				{ apiVersion, PLUGIN_API_VERSION },
			);
			console.error(`[plugin:${info.id}] ${msg}`);
			this.pushRuntimeDiag(
				info.id,
				`requires host API v${apiVersion} but host is v${PLUGIN_API_VERSION} — please upgrade pi-web-ui`,
			);
			this.loaded.set(info.id, {
				info: { ...info, error: msg, diagnostics: this.diagnosticsOf(info.id) },
				toolHandlers,
				runHandlers,
				convChangeHandlers,
				attachHandlers,
				cwdHandlers,
				httpRoutes,
				settingsHandlers: new Set(),
			});
			return;
		}
		// 能力声明：写了 permissions → 严格模式（受控宿主 API 按声明族强制执行）；
		// 未写且 apiVersion < 2 → 旧全权模式（首次使用受控 API 时警告一次，v2 起默认拒绝）。
		const permsDeclared = (info.permissions ?? []).slice();
		const strict = permsDeclared.length > 0 || apiVersion >= 2;
		const permFamilies = new Set(permsDeclared.map((x) => x.split(":")[0]!));
		// 硬依赖声明（manifest "requires"，P2-8）：任一条不满足即拒绝激活 + 教学式错误
		// （peerPlugins 仍是缺失只警告的软依赖）。形状坏的在 P1-6 校验层已提前拒，
		// 这里只做语义判定：hostApi 下限、能力族已知+已声明、对等插件已安装且激活成功。
		const req = info.requires;
		if (req) {
			const refuseRequires = (zh: string, en: string, key: string, vars?: Record<string, unknown>): boolean => {
				const msg = pick(l, zh, en, key, vars);
				console.error(`[plugin:${info.id}] ${msg}`);
				this.pushRuntimeDiag(info.id, en);
				this.loaded.set(info.id, {
					info: { ...info, error: msg, diagnostics: this.diagnosticsOf(info.id) },
					toolHandlers,
					runHandlers,
					convChangeHandlers,
					attachHandlers,
					cwdHandlers,
					httpRoutes,
					settingsHandlers: new Set(),
				});
				return true;
			};
			if (req.hostApi !== undefined && req.hostApi > PLUGIN_API_VERSION) {
				refuseRequires(
					`插件要求宿主 API v${req.hostApi}+，当前宿主 v${PLUGIN_API_VERSION} —— 请升级 pi-web-ui`,
					`Plugin requires host API v${req.hostApi}+ but the host is v${PLUGIN_API_VERSION} — please upgrade pi-web-ui`,
					"plugins.requires.hostapi",
					{ hostApi: req.hostApi, PLUGIN_API_VERSION },
				);
				return;
			}
			let refused = false;
			for (const f of req.families ?? []) {
				if (!isKnownPermission(f)) {
					refuseRequires(
						`插件 requires 声明了未知能力族「${f}」（拼写？或需要更新 pi-web-ui）—— 请修正 manifest.requires.families`,
						`Plugin requires unknown family "${f}" (typo? or needs newer pi-web-ui) — fix manifest.requires.families`,
						"plugins.requires.family.unknown",
						{ family: f },
					);
					refused = true;
					break;
				}
				const fam = f.split(":")[0]!;
				if (!permFamilies.has(fam)) {
					refuseRequires(
						`插件 requires 需要「${fam}」族，但 permissions 里没声明 —— 加上它，否则运行时必被门控拒绝`,
						`Plugin requires family "${fam}" but does not declare it in permissions — add it, otherwise every call will be denied`,
						"plugins.requires.family.undeclared",
						{ family: fam },
					);
					refused = true;
					break;
				}
			}
			if (refused) return;
			for (const dep of req.plugins ?? []) {
				if (dep === info.id) {
					refuseRequires(
						`插件 requires 依赖了自己（${dep}）—— 请删掉这条自依赖`,
						`Plugin requires itself (${dep}) — remove the self-dependency`,
						"plugins.requires.self",
						{ dep },
					);
					refused = true;
					break;
				}
				if (!existsSync(join(this.pluginsDir, dep, "manifest.json"))) {
					refuseRequires(
						`插件 requires 对等插件「${dep}」但它没安装（plugins/${dep}/ 缺失）—— 先装上它`,
						`Plugin requires peer "${dep}" which is not installed (plugins/${dep}/ missing) — install it first`,
						"plugins.requires.peer.missing",
						{ dep },
					);
					refused = true;
					break;
				}
				if (existsSync(join(this.pluginsDir, dep, "index.mjs"))) {
					const peer = this.loaded.get(dep);
					if (!peer) {
						refuseRequires(
							`插件 requires 对等插件「${dep}」但它尚未激活 —— 请先解决它的问题`,
							`Plugin requires peer "${dep}" which is not active yet — fix it first`,
							"plugins.requires.peer.inactive",
							{ dep },
						);
						refused = true;
						break;
					}
					if (peer.info.error) {
						refuseRequires(
							`插件 requires 对等插件「${dep}」但它激活失败：${peer.info.error}`,
							`Plugin requires peer "${dep}" which failed to activate: ${peer.info.error}`,
							"plugins.requires.peer.failed",
							{ dep },
						);
						refused = true;
						break;
					}
				}
				// 纯前端对等端（无 index.mjs）：目录存在即满足，它没有激活态。
			}
			if (refused) return;
		}
		// 引擎约束（manifest engines["pi-web-ui"]）：不满足即拒绝激活（与 apiVersion 超前同级处理）。
		// 解析失败 → 警告放行不阻断；对等依赖缺失 → 只警告不断活。
		const enginesReq = info.engines?.["pi-web-ui"];
		if (typeof enginesReq === "string" && enginesReq.trim()) {
			const hostVer = readHostVersion();
			const verdict = hostVer ? satisfiesEnginesConstraint(enginesReq, hostVer) : null;
			if (verdict === false) {
				const msg = pick(
					l,
					`插件要求 pi-web-ui ${enginesReq}，当前宿主版本 ${hostVer} —— 请升级 pi-web-ui`,
					`Plugin requires pi-web-ui ${enginesReq} but the host is ${hostVer} — please upgrade pi-web-ui`,
					"plugins.host.engines.mismatch",
					{ enginesReq, hostVer },
				);
				console.error(`[plugin:${info.id}] ${msg}`);
				this.pushRuntimeDiag(
					info.id,
					`requires pi-web-ui ${enginesReq} but host is ${hostVer} — please upgrade pi-web-ui`,
				);
				this.loaded.set(info.id, {
					info: { ...info, error: msg, diagnostics: this.diagnosticsOf(info.id) },
					toolHandlers,
					runHandlers,
					convChangeHandlers,
					attachHandlers,
					cwdHandlers,
					httpRoutes,
					settingsHandlers: new Set(),
				});
				return;
			}
			if (verdict === null) {
				console.warn(`[plugin:${info.id}] engines 约束「${enginesReq}」解析失败，已放行（不阻断激活）`);
				this.pushRuntimeDiag(info.id, `engines constraint "${enginesReq}" unparseable, allowed without blocking`);
			}
		}
		for (const peer of info.peerPlugins ?? []) {
			if (!existsSync(join(this.pluginsDir, peer))) {
				console.warn(`[plugin:${info.id}] 对等插件缺失：${peer}（仅警告，不阻断激活）`);
				this.pushRuntimeDiag(info.id, `peer plugin missing: ${peer} (warn only, activation continues)`);
			}
		}
		// 新增订阅的取消函数（反激活时经 effects 栈统一逆序释放）。
		// 出站网络白名单（scan 解析的 manifest netAllowlist 快照）。
		const netAllow = info.netAllowlist ?? [];
		// 每插件的私有设施：KV 存储 + 加密 secrets + 依赖自动补装（单飞）。
		const storage = new PluginStorage(join(dir, "storage.json"));
		const secrets = new PluginSecrets(this.dataDir, dir);
		// 受限工作区文件访问（能力 "fs" 门控；根随 set_cwd 活值移动）。
		const workspaceFs = new WorkspaceFS(() => self.cwdValue);
		/** 跨目录读写（issue #146）：每次操作都要求路径已在授权表里（或落在工作区内）。
		 *  与 workspaceFs 的分工：那个锚定当前工作区、越界拒绝；这个锚定「用户点过头的目录」。
		 *  两者都不允许插件无告知地碰任意路径 —— 这就是「受支持路径」与裸 node:fs 的差别。 */
		const allowAbs = (p: string): string => {
			const abs = normalizeGrantPath(p);
			if (!abs) throw new Error("路径必须是绝对路径");
			if (self.isInsideWorkspace(abs) || self.grants.has(info.id, abs)) return abs;
			throw new Error(`目录未授权：先 await host.fs.requestAccess(dir)（${abs}）`);
		};
		/** 写类操作（write/remove）的 realpath 复核：allowAbs 是纯字符串判定，
		 *  授权目录里的符号链接/junction 能把写入/递归删除引到授权范围之外。
		 *  取目标最近已存在祖先的 realpath，要求它仍落在（工作区或该插件任一
		 *  已授权目录）的 realpath 内。读/list/stat 保持字符串校验（高频路径，
		 *  且读不存在「把内容写到别处」的风险）。 */
		const assertRealInsideGrant = async (abs: string): Promise<void> => {
			const targetReal = realPathOfNearest(abs);
			if (!targetReal) throw new Error(`无法解析真实路径：${abs}`);
			const granted = self.grants.list().find((g) => g.pluginId === info.id)?.paths ?? [];
			for (const r of [self.cwdValue, ...granted]) {
				const rootReal = realPathOfNearest(resolve(r)) ?? resolve(r);
				if (isInsideRoot(rootReal, targetReal)) return;
			}
			throw new Error(`路径越界（符号链接指向授权范围之外）：${abs}`);
		};
		const crossDirFs = {
			list: async (absDir: string) => {
				const abs = allowAbs(absDir);
				const ents = await readdir(abs, { withFileTypes: true });
				return ents.slice(0, 2000).map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }) as const);
			},
			read: async (absPath: string) => readFile(allowAbs(absPath)),
			readText: async (absPath: string, maxBytes?: number) => {
				const buf = await readFile(allowAbs(absPath));
				const cap = Math.max(1024, Math.min(Number(maxBytes ?? 2 * 1024 * 1024), 8 * 1024 * 1024));
				return buf.subarray(0, cap).toString("utf8");
			},
			write: async (absPath: string, data: string | Uint8Array) => {
				const abs = allowAbs(absPath);
				await assertRealInsideGrant(abs);
				await mkdir(dirname(abs), { recursive: true });
				await writeFile(abs, data);
			},
			remove: async (absPath: string) => {
				const abs = allowAbs(absPath);
				await assertRealInsideGrant(abs);
				await rm(abs, { recursive: true, force: true });
			},
			stat: async (absPath: string) => {
				const abs = allowAbs(absPath);
				const st = await stat(abs);
				const base =
					abs
						.replace(/[/\\]+$/, "")
						.split("/")
						.pop() ?? abs;
				return {
					name: base,
					type: (st.isDirectory() ? "dir" : "file") as "file" | "dir",
					size: st.isDirectory() ? 0 : st.size,
					mtime: Number(st.mtimeMs) || 0,
				};
			},
			mkdir: async (absDir: string) => {
				await mkdir(allowAbs(absDir), { recursive: true });
			},
			append: async (absPath: string, data: string | Uint8Array) => {
				const abs = allowAbs(absPath);
				await mkdir(dirname(abs), { recursive: true });
				await writeFile(abs, data, { flag: "a" });
			},
			glob: async (absDir: string, pattern: string) => {
				const { globToRegExp } = await import("./plugin-facilities.js");
				const pat = String(pattern ?? "")
					.trim()
					.replace(/\\/g, "/");
				if (!pat) throw new Error("globPath: pattern 为空");
				const re = globToRegExp(pat);
				const base = allowAbs(absDir);
				const out: string[] = [];
				const stack: string[] = [base];
				let walked = 0;
				while (stack.length && walked < 2000 && out.length < 500) {
					const dir = stack.pop()!;
					let ents;
					try {
						ents = await readdir(dir, { withFileTypes: true });
					} catch {
						continue;
					}
					for (const e of ents) {
						if (walked++ >= 2000 || out.length >= 500) break;
						const abs = join(dir, e.name);
						// 跨目录返回绝对路径（调用方直接可用）；匹配仍按相对 base 的部分。
						// 先转分隔符再去前导斜杠（顺序反了会留下 "/n.txt" 导致匹配失败）。
						const rel = abs
							.slice(base.length)
							.replace(/\\/g, "/")
							.split("/")
							.filter((s) => s.length > 0)
							.join("/");
						if (e.isDirectory()) {
							if (re.test(rel) || re.test(`${rel}/`)) out.push(abs);
							stack.push(abs);
						} else if (re.test(rel)) {
							out.push(abs);
						}
					}
				}
				return out;
			},
		};
		const self = this; // 对象字面量 getter 里不能用插件宿主的 this (oxlint no-this-alias: 誤報, getter closure 需要 host)
		// 能力门控快照：host 对象可用之前（loaded.set 之前）canUse 也要能判定。
		self.activatingGates.set(info.id, { permsDeclared, permFamilies, strictMode: strict, legacyWarned: false });
		/** 能力门控：统一走 canUse（fs 读写分级/旧全权警告都在里面）。
		 *  返回 false = 已记日志，调用方应拒绝。 */
		const can = (family: string): boolean => self.canUse(info.id, family);
		/** 读门："fs" 全开，或精确声明 "fs:read"。 */
		const canRead = (): boolean => self.canUse(info.id, "fs:read");
		/** 写门："fs" 全开，或精确声明 "fs:write"（只读插件写即拒，提示缺 fs/fs:write）。 */
		const canWrite = (): boolean => self.canUse(info.id, "fs:write");
		/** 无头调用落地（host.chat 与 host.chatWait 共用）：能力 "chat" 门控 +
		 *  文本校验 + chatProvider 投递。宿主未接入时拒绝（不抛到插件侧，由调用方包 {ok:false}）。 */
		const sendChat = (req: PluginChatRequest): Promise<PluginChatResult> => {
			if (!can("chat")) return Promise.reject(new Error(`插件未声明能力 "chat"（manifest.permissions）——请求被拒`));
			if (!self.chatProvider) {
				return Promise.reject(new Error("宿主未提供无头调用（chatProvider 未接入）——请升级 pi-web-ui"));
			}
			const text = String((req as PluginChatRequest | undefined)?.text ?? "").trim();
			if (!text) return Promise.reject(new Error("chat: text 为空"));
			if (text.length > 8000) return Promise.reject(new Error("chat: text 超长（>8000 字），请裁剪后重发"));
			const accountId = String((req as PluginChatRequest | undefined)?.accountId ?? "default").slice(0, 64);
			// issue #226：透传定时任务对齐的四件套（各按长度封顶，语义校验归宿主 chatFromPlugin）。
			const r = ((req as PluginChatRequest | undefined) ?? {}) as PluginChatRequest;
			const passthrough: PluginChatRequest = { text, accountId };
			const cwd = String(r.cwd ?? "").trim();
			if (cwd) passthrough.cwd = cwd.slice(0, 1024);
			const conversationId = String(r.conversationId ?? "").trim();
			if (conversationId) passthrough.conversationId = conversationId.slice(0, 128);
			const model = String(r.model ?? "").trim();
			if (model) passthrough.model = model.slice(0, 256);
			const thinkingLevel = String(r.thinkingLevel ?? "").trim();
			if (thinkingLevel) passthrough.thinkingLevel = thinkingLevel.slice(0, 64);
			return self.chatProvider(info.id, passthrough);
		};
		const host: PluginHost = {
			broadcast: (payload) => this.broadcast(info.id, payload),
			notify: (level, text, textEn) => this.notifyAll(level, text, textEn),
			sendTo: (clientId, payload) => this.sendTo(clientId, info.id, payload),
			onMessage: (h) => {
				handlers.add(h);
				return () => handlers.delete(h);
			},
			onClientMessage: (h) => {
				return host.onMessage((payload, from) => {
					const reply = (res: unknown) => {
						if (from) {
							host.sendTo(from, res);
						} else {
							host.broadcast(res);
						}
					};
					try {
						const ret = h(payload, reply);
						if (ret instanceof Promise) {
							ret.catch((err) => {
								console.error(`[plugin:${info.id}] onClientMessage async handler failed:`, err);
							});
						}
					} catch (err) {
						console.error(`[plugin:${info.id}] onClientMessage handler failed:`, err);
					}
				});
			},
			onToolEvent: (h) => {
				toolHandlers.add(h);
				return () => toolHandlers.delete(h);
			},
			onToolPre: (h) => {
				if (!can("tools")) return () => {};
				preGuards.add(h);
				return () => preGuards.delete(h);
			},
			onToolPost: (h) => {
				if (!can("tools")) return () => {};
				postGuards.add(h);
				return () => postGuards.delete(h);
			},
			onRunEvent: (h) => {
				runHandlers.add(h);
				return () => runHandlers.delete(h);
			},
			onConversationChanged: (h) => {
				convChangeHandlers.add(h);
				return () => convChangeHandlers.delete(h);
			},
			onClientModelChanged: (h) => {
				modelChangeHandlers.add(h);
				return () => modelChangeHandlers.delete(h);
			},
			getActiveConversation: (opts) => self.getActiveConversation(opts),
			chat: (req) => sendChat(req),
			chatWait: async (req, opts) => {
				try {
					const sent = await sendChat(req);
					const cid = sent?.conversationId ?? "";
					if (!cid) return { ok: false, error: "无头调用未返回 conversationId" };
					// 默认 120s 超时；上下钳制防 100ms 误杀与无限等待。
					const timeoutMs = Math.max(1000, Math.min(Number(opts?.timeoutMs ?? 120_000) || 120_000, 600_000));
					const ended = await self.waitRunEnd(cid, timeoutMs);
					if (!ended)
						return { ok: false, conversationId: cid, error: `等待运行结束超时（约${Math.round(timeoutMs / 1000)}s）` };
					return { ok: true, conversationId: cid };
				} catch (err) {
					return { ok: false, error: (err as Error).message };
				}
			},
			llm: {
				complete: async (req) => {
					if (!can("llm")) return { ok: false, error: `插件未声明能力 "llm"（manifest.permissions）——请求被拒` };
					// 有模型作用域授权时收紧到批准的模型（无授权=声明即全开，向后兼容）。
					const model = typeof req?.model === "string" ? req.model.trim() : "";
					if (model && !self.permGrants.modelAllowed(info.id, model))
						return {
							ok: false,
							error: `llm: 模型 ${model} 不在用户批准的作用域内（可 host.requestPermission 重新申请）`,
						};
					if (!self.llmProvider) return { ok: false, error: "宿主未提供 LLM 直调（llmProvider 未接入）" };
					try {
						return await self.llmProvider(info.id, req ?? { prompt: "" });
					} catch (err) {
						return { ok: false, error: (err as Error).message };
					}
				},
			},
			requestPermission: async (req) => {
				const family = (req as { family?: unknown } | undefined)?.family;
				if (family !== "net" && family !== "llm")
					throw new Error(`requestPermission: 不支持的能力族「${String(family)}」（目前只收 net/llm）`);
				// 基础族必须已声明（与 requestAccess 要求 fs:read 同口径，fail-closed）。
				if (!can(family)) return false;
				const hosts =
					family === "net" && Array.isArray((req as { hosts?: unknown }).hosts)
						? (req as { hosts: unknown[] }).hosts
								.filter((x): x is string => typeof x === "string" && x.trim() !== "")
								.map((x) => x.trim().toLowerCase())
								.slice(0, 32)
						: undefined;
				if (family === "net" && (!hosts || hosts.length === 0))
					throw new Error("requestPermission: family=net 必须给 hosts（要批准的主机列表）");
				const models =
					family === "llm" && Array.isArray((req as { models?: unknown }).models)
						? (req as { models: unknown[] }).models
								.filter((x): x is string => typeof x === "string" && x.includes("/"))
								.map((x) => x.trim())
								.slice(0, 32)
						: undefined;
				const reason =
					typeof (req as { reason?: unknown }).reason === "string"
						? String((req as { reason?: string }).reason).slice(0, 200)
						: undefined;
				// 已有授权（静态白名单算在执行期，动态表在这里）：直接通过，不打扰用户。
				if (family === "net" && hosts!.every((h) => netAllow.some((entry) => h === entry || h.endsWith(`.${entry}`))))
					return true;
				if (family === "net" && hosts!.every((h) => self.permGrants.has(info.id, "net", { host: h }))) return true;
				if (family === "llm" && self.permGrants.has(info.id, "llm", models?.[0] ? { model: models[0] } : undefined))
					return true;
				if (!self.permissionRequester) return false;
				let ans: { ok: boolean; remember: boolean };
				try {
					ans = await self.permissionRequester(info.id, {
						family,
						...(hosts ? { hosts } : {}),
						...(models ? { models } : {}),
						...(reason ? { reason } : {}),
					});
				} catch {
					return false;
				}
				if (!ans?.ok) return false;
				try {
					self.permGrants.grant(info.id, family, { hosts, models, reason, remember: ans.remember === true });
				} catch (err) {
					console.error(`[plugin:${info.id}] permission grant failed:`, err);
					return false;
				}
				try {
					self.onPermGrantsChanged?.();
				} catch {
					/* 推送失败不影响已完成的授权 */
				}
				return true;
			},
			conversations: {
				list: () => {
					try {
						const r = self.conversationLister?.();
						if (r instanceof Promise) {
							return r.catch((err) => {
								console.error(`[plugin:${info.id}] conversationLister failed:`, err);
								return [];
							});
						}
						return r ?? [];
					} catch (err) {
						console.error(`[plugin:${info.id}] conversationLister failed:`, err);
						return [];
					}
				},
				get: (id) => {
					try {
						// conversationProvider 只给当前打开对话：id 对上才回，否则 null。
						const s = self.getActiveConversation();
						return s && s.conversationId === String(id) ? s : null;
					} catch {
						return null;
					}
				},
				search: (query, limit) => {
					try {
						const q = String(query ?? "");
						const n = Math.max(1, Math.min(Number(limit ?? 20) || 20, 100));
						if (self.conversationSearcher) {
							const r = self.conversationSearcher(q, n);
							if (r instanceof Promise) return r.catch(() => []);
							return r ?? [];
						}
						// 无 searcher 注入时退化为 lister 标题过滤；两者都无回 []。
						const lq = q.trim().toLowerCase();
						if (!lq) return [];
						const pick = (arr: Array<PluginConversationListItem>): Array<{ id: string; title: string }> =>
							arr
								.filter((c) => c.title.toLowerCase().includes(lq))
								.slice(0, n)
								.map((c) => ({ id: c.id, title: c.title }));
						const all = self.conversationLister?.();
						if (all instanceof Promise) return all.then(pick, () => []);
						return pick(all ?? []);
					} catch {
						return [];
					}
				},
			},
			prompt: async (conversationId, req) => {
				try {
					if (!self.conversationWriter) return { ok: false, error: "宿主未接入对话写入（仅标准 pi 引擎支持）" };
					const text = String(req?.text ?? "");
					if (!text.trim()) return { ok: false, error: "投递文本为空" };
					if (text.length > 8000) return { ok: false, error: "投递文本超长（>8000 字），请裁剪后重发" };
					const atts = Array.isArray(req?.attachments) ? req.attachments.slice(0, 16) : undefined;
					return await self.conversationWriter(String(conversationId), text, atts);
				} catch (err) {
					return { ok: false, error: (err as Error).message };
				}
			},
			steer: async (conversationId, text) => {
				try {
					if (!self.runSteerer) return { ok: false, error: "宿主未接入运行插队（仅标准 pi 引擎支持）" };
					return await self.runSteerer(String(conversationId), String(text ?? ""));
				} catch (err) {
					return { ok: false, error: (err as Error).message };
				}
			},
			abortRun: async (conversationId) => {
				try {
					if (!self.runAborter) return { ok: false, error: "宿主未接入运行中止（仅标准 pi 引擎支持）" };
					return await self.runAborter(String(conversationId));
				} catch (err) {
					return { ok: false, error: (err as Error).message };
				}
			},
			onAttach: (h) => {
				attachHandlers.add(h);
				return () => attachHandlers.delete(h);
			},
			onCwdChange: (h) => {
				cwdHandlers.add(h);
				return () => cwdHandlers.delete(h);
			},
			registerCommand: (cmd) => {
				const off = this.registerCommand(info.id, cmd);
				return effects.add(`command:/${String(cmd?.name ?? "?").replace(/^\/+/, "")}`, off);
			},
			storage,
			secrets,
			ensureDeps: (specs, opts) => ensurePluginDeps(dir, specs ?? [], opts?.onProgress),
			route: (method, path, handler) => {
				if (!can("http")) return () => {};
				const m = String(method ?? "GET").toUpperCase();
				if (
					!["GET", "POST", "PUT", "DELETE"].includes(m) ||
					typeof path !== "string" ||
					!path.startsWith("/") ||
					typeof handler !== "function"
				) {
					console.error(`[plugin:${info.id}] route: 非法参数（method=${method} path=${path}），忽略`);
					self.pushRuntimeDiag(
						info.id,
						`route: invalid method/path (method=${String(method)} path=${String(path)}), ignored`,
					);
					return () => {};
				}
				const key = `${m} ${path}`;
				httpRoutes.set(key, handler);
				return effects.add(`route:${key}`, () => httpRoutes.delete(key));
			},
			registerProxy: (prefix, target) => {
				if (!can("http")) return () => {};
				const p = self.registerProxy(info.id, String(prefix ?? ""), target);
				if (!p) {
					console.error(`[plugin:${info.id}] registerProxy: 非法前缀/目标或被占用（prefix=${String(prefix)}），忽略`);
					self.pushRuntimeDiag(
						info.id,
						`registerProxy: invalid prefix/target or taken (prefix=${String(prefix)}), ignored`,
					);
					return () => {};
				}
				return effects.add(`proxy:${p}`, () => {
					self.unregisterProxy(info.id, p);
				});
			},
			// 包一层：插件反激活时自动注销它注册的全部 AI 工具，不留悬挂项。
			registerAgentTool: (tool) => {
				if (!can("tools")) return () => {};
				const off = this.registerAgentTool(info.id, tool);
				return effects.add(`agentTool:${String(tool?.name ?? "?")}`, off);
			},
			registerTool: (tool) => {
				if (!can("tools")) return () => {};
				if (!tool || typeof tool !== "object") return () => {};
				const exec = tool.execute;
				const adaptedTool: PluginAgentTool = {
					name: tool.name,
					description: tool.description,
					label: tool.label,
					promptSnippet: tool.promptSnippet,
					promptGuidelines: tool.promptGuidelines,
					parameters: tool.parameters,
					execute: async (
						toolCallId: string,
						params: Record<string, unknown>,
						signal?: AbortSignal,
						onUpdate?: (partial: unknown) => void,
					) => {
						if (typeof exec !== "function") return "";
						if (exec.length <= 1) {
							return await (exec as (args: Record<string, unknown>) => Promise<unknown>)(params);
						}
						const multiFn = exec as unknown as (
							toolCallId: string,
							params: Record<string, unknown>,
							signal?: AbortSignal,
							onUpdate?: (partial: unknown) => void,
						) => Promise<unknown>;
						return await multiFn(toolCallId, params, signal, onUpdate);
					},
				};
				return host.registerAgentTool(adaptedTool);
			},
			dir,
			dataDir: this.dataDir,
			get cwd() {
				return self.cwdValue;
			},
			fs: {
				list: (relDir) => (canRead() ? workspaceFs.list(relDir) : NO_FS_PROMISE),
				read: (p) => (canRead() ? workspaceFs.read(p) : NO_FS_PROMISE),
				readText: (p, max) => (canRead() ? workspaceFs.readText(p, max) : NO_FS_PROMISE),
				write: (p, data) => (canWrite() ? workspaceFs.write(p, data) : NO_FS_WRITE_PROMISE),
				remove: (p) => (canWrite() ? workspaceFs.remove(p) : NO_FS_WRITE_PROMISE),
				stat: (p) => (canRead() ? workspaceFs.stat(p) : NO_FS_PROMISE),
				mkdir: (p) => (canWrite() ? workspaceFs.mkdir(p) : NO_FS_WRITE_PROMISE),
				append: (p, data) => (canWrite() ? workspaceFs.append(p, data) : NO_FS_WRITE_PROMISE),
				glob: (pat, dir) => (canRead() ? workspaceFs.glob(pat, dir) : NO_FS_PROMISE),
				requestAccess: async (dir, reason) => {
					if (!canRead()) return false;
					const abs = normalizeGrantPath(String(dir ?? ""));
					if (!abs) return false;
					// 工作区内的路径本来就能用，不必打扰用户。
					if (self.isInsideWorkspace(abs)) return true;
					if (self.grants.has(info.id, abs)) return true;
					if (!self.pathAccessRequester) return false;
					const ok = await self.pathAccessRequester(info.id, abs, reason);
					if (ok) {
						self.grants.grant(info.id, abs);
						// 授权表变了 → 通知宿主重推（设置面板即时可见）。 throws 不能拖塔授权本身。
						try {
							self.onGrantsChanged?.();
						} catch {
							/* 推送失败不影响已完成的授权 */
						}
					}
					return ok;
				},
				authorizedDirs: () => (canRead() ? self.grants.get(info.id) : []),
				listPath: (absDir) => (canRead() ? crossDirFs.list(absDir) : NO_FS_PROMISE),
				readPath: (absPath) => (canRead() ? crossDirFs.read(absPath) : NO_FS_PROMISE),
				readTextPath: (absPath, max) => (canRead() ? crossDirFs.readText(absPath, max) : NO_FS_PROMISE),
				writePath: (absPath, data) => (canWrite() ? crossDirFs.write(absPath, data) : NO_FS_WRITE_PROMISE),
				removePath: (absPath) => (canWrite() ? crossDirFs.remove(absPath) : NO_FS_WRITE_PROMISE),
				statPath: (absPath) => (canRead() ? crossDirFs.stat(absPath) : NO_FS_PROMISE),
				mkdirPath: (absDir) => (canWrite() ? crossDirFs.mkdir(absDir) : NO_FS_WRITE_PROMISE),
				appendPath: (absPath, data) => (canWrite() ? crossDirFs.append(absPath, data) : NO_FS_WRITE_PROMISE),
				globPath: (absDir, pat) => (canRead() ? crossDirFs.glob(absDir, pat) : NO_FS_PROMISE),
				watch: (relPath, handler) => {
					if (!canRead()) throw new Error('插件未声明读能力 "fs"/"fs:read"（manifest.permissions）——请求被拒');
					if (typeof handler !== "function") throw new Error("watch: handler 必须是函数");
					// 锚定活 cwd 根：目标必须在工作区内（复用 WorkspaceFS 的越界校验思想）。
					const target = resolve(self.cwdValue, String(relPath ?? ""));
					if (!self.isInsideWorkspace(target)) throw new Error(`路径越界：${String(relPath)}`);
					const watcher = fsWatch(target, (eventType, filename) => {
						try {
							handler({ type: String(eventType), path: String(filename ?? relPath) });
						} catch (err) {
							console.error(`[plugin:${info.id}] watch handler failed:`, err);
						}
					});
					watcher.on("error", (err) => console.error(`[plugin:${info.id}] watch failed:`, err));
					const off = (): void => {
						try {
							watcher.close();
						} catch {
							/* already closed */
						}
					};
					return effects.add(`watch:${String(relPath)}`, off);
				},
			},
			project: {
				create: async (spec) => {
					// 写门：只读插件（仅 fs:read）与无 fs 声明的一律拒绝，错误提示缺 fs/fs:write。
					if (!canWrite())
						return {
							ok: false,
							error: '缺少写能力：project.create 需要 "fs"/"fs:write"（manifest.permissions）',
							log: [],
							dir: "",
						};
					const dir = normalizeGrantPath(String((spec as { dir?: unknown })?.dir ?? ""));
					if (!dir) return { ok: false, error: "项目目录必须是绝对路径", log: [], dir: "" };
					if (!self.isInsideWorkspace(dir) && !self.grants.has(info.id, dir)) {
						return { ok: false, dir, log: [], error: `项目目录未授权：先 await host.fs.requestAccess("${dir}")` };
					}
					return createProject(spec, { onProgress: (line) => self.notifyAll("info", line) });
				},
			},
			leftPanel: {
				setRunning: (items, opts) => {
					if (!can("ui")) return;
					if (!leftPanelOwned) {
						leftPanelOwned = true;
						effects.add("leftPanel", () => {
							leftPanelOwned = false;
							if (self.panelRunning.clear(info.id)) self.schedulePanelPush();
						});
					}
					const outcome = self.panelRunning.set(info.id, info.name || info.id, items, opts);
					for (const d of outcome.diags) self.pushRuntimeDiag(info.id, d);
					if (outcome.changed) self.schedulePanelPush();
					self.ensurePanelSweep();
				},
				clear: () => {
					if (!can("ui")) return;
					if (self.panelRunning.clear(info.id)) self.schedulePanelPush();
				},
			},
			registerBackgroundTask: (task) => {
				const id = String(task?.id ?? "").trim();
				if (!id || bgTaskTable.has(id)) {
					console.error(`[plugin:${info.id}] registerBackgroundTask: 非法/重复 id「${task?.id}」，忽略`);
					self.pushRuntimeDiag(
						info.id,
						`registerBackgroundTask: invalid/duplicate id "${String(task?.id ?? "").slice(0, 32)}", ignored`,
					);
					return { update: () => {}, unregister: () => {} };
				}
				const entry: PluginBgTask = {
					id,
					label: String(task?.label ?? id),
					since: Date.now(),
					...(typeof task?.stop === "function" ? { stop: task.stop } : {}),
					...(typeof task?.status === "string" ? { status: task.status } : {}),
				};
				bgTaskTable.set(id, entry);
				this.pluginBgTasks.set(info.id, bgTaskTable);
				const fire = () => {
					try {
						this.onBgTasksChanged?.();
					} catch {
						// best-effort：可选 UI 刷新，失败忽略。
					}
				};
				fire();
				effects.add(`bgTask:${id}`, () => {
					if (bgTaskTable.delete(id)) {
						if (bgTaskTable.size === 0) self.pluginBgTasks.delete(info.id);
						fire();
					}
				});
				return {
					update: (next) => {
						if (!bgTaskTable.has(id)) return;
						if (next.label !== undefined) entry.label = String(next.label);
						if (next.status !== undefined) entry.status = next.status;
						if (typeof next.stop === "function") entry.stop = next.stop;
						fire();
					},
					unregister: () => {
						if (bgTaskTable.delete(id)) {
							if (bgTaskTable.size === 0) this.pluginBgTasks.delete(info.id);
							fire();
						}
					},
				};
			},
			ui: {
				register: (items) => {
					if (!can("ui")) return () => {};
					const list = Array.isArray(items) ? items : [items];
					if (list.length > 32)
						self.pushRuntimeDiag(info.id, `ui.register: capped at 32 items (${list.length - 32} dropped)`);
					const added: string[] = [];
					const rt = self.uiRuntimeFor(info.id);
					const sliced = list.slice(0, 32);
					for (let idx = 0; idx < sliced.length; idx++) {
						const raw = sliced[idx];
						const slotRaw =
							typeof (raw as { slot?: unknown })?.slot === "string" ? String((raw as { slot: string }).slot) : "";
						// 与 manifest 解析同口径：先查别名（topbar → topbar.primary）、再校枚举。
						// 运行时注册不校验的话，插件给个别名（或写错）会得到一个前端不认识的 slot
						// —— buildUiSlots 会静默丢掉它，表现为「注册了但界面上没有」，最难排。
						const slot = UI_SLOT_ALIASES[slotRaw] ?? slotRaw;
						if (!slot || !UI_SLOTS.has(slot)) {
							self.pushRuntimeDiag(
								info.id,
								`ui.register[#${idx}]: unknown slot "${slotRaw || "(missing)"}", item dropped`,
							);
							continue;
						}
						const itemDiags: string[] = [];
						const parsed = parseUiItem(raw, slot, itemDiags);
						for (const m of itemDiags) self.pushRuntimeDiag(info.id, `ui.register: ${m}`);
						if (!parsed) {
							if (!itemDiags.length)
								self.pushRuntimeDiag(info.id, `ui.register[#${idx}]: item in slot "${slot}" dropped`);
							continue;
						}
						rt.items.set(parsed.id, parsed);
						rt.removed.delete(parsed.id);
						added.push(parsed.id);
					}
					if (added.length) void self.pushToAll().catch(() => {});
					return effects.add(`ui:register(${added.join(",") || "none"})`, () => {
						if (!added.length) return;
						for (const id of added) self.removeUiItem(info.id, id);
						void self.pushToAll().catch(() => {});
					});
				},
				update: (id, patch) => {
					if (!can("ui")) return;
					// 只能更新"当前生效"的条目：manifest 声明的与运行时注册的都算，
					// 不存在的一律忽略（避免插件凭空造条目绕过声明审查）。
					const base = self.uiOf(info.id)?.items.find((x) => x.id === id);
					if (!base) {
						self.pushRuntimeDiag(info.id, `ui.update: unknown id "${String(id).slice(0, 32)}", ignored`);
						return;
					}
					// 与注册同一条校验管线：patch 合进 base 后整体过 parseUiItem，
					// 非法字段按 parse 语义丢弃/回落（未知键清掉、iconSvg 重新归一化、
					// 超长截断、progress 夹取），id 与 slot 不可被 patch 改写。
					const diags: string[] = [];
					const mergedRaw =
						typeof patch === "object" && patch !== null && !Array.isArray(patch)
							? { ...base, ...(patch as Record<string, unknown>), id, slot: base.slot }
							: { ...base, id, slot: base.slot };
					const parsed = parseUiItem(mergedRaw, base.slot, diags);
					for (const m of diags) self.pushRuntimeDiag(info.id, `ui.update: ${m}`);
					if (!parsed) {
						// 合并结果不合法（典型：patch 把 label 改成空）——按现有 parse 语义
						// 视为无效更新，保留原条目。
						self.pushRuntimeDiag(info.id, `ui.update: merged item invalid, update ignored`);
						return;
					}
					self.uiRuntimeFor(info.id).items.set(id, parsed);
					void self.pushToAll().catch(() => {});
				},
				remove: (id) => {
					if (!can("ui")) return;
					self.removeUiItem(info.id, id);
					void self.pushToAll().catch(() => {});
				},
				arrange: (ops) => {
					if (!can("ui")) return;
					const arr = Array.isArray(ops) ? ops : [ops];
					const arrangeDiags: string[] = [];
					const list = parseUiArrange(arr, arrangeDiags);
					for (const m of arrangeDiags) self.pushRuntimeDiag(info.id, `ui.arrange: ${m}`);
					if (!list.length) return;
					self.uiRuntimeFor(info.id).arrange.push(...list);
					void self.pushToAll().catch(() => {});
				},
				list: () => self.uiOf(info.id) ?? { items: [], arrange: [] },
			},
			getSettings: () => {
				// P2-9：运行时视角同样走三层合并（警告已在 scan 落诊断，这里静默用值）。
				const schema = info.settingsSchema ?? [];
				const overlayFile = readSettingsOverlayFile(self.dataDir, info.id);
				const overlay = cleanOverlaySettings(schema, overlayFile.raw, "en");
				return runtimeSettingsValues(dir, schema, secrets, overlay.values);
			},
			onSettingsChanged: (h) => {
				settingsHandlers.add(h);
				return () => settingsHandlers.delete(h);
			},
			scm: {
				status: async () => {
					if (!canRead()) throw new Error('插件未声明读能力 "fs"/"fs:read"（manifest.permissions）——请求被拒');
					try {
						const mod = await import("./scm.js");
						return await mod.scmStatus(self.cwdValue);
					} catch (err) {
						return { ok: false, error: (err as Error).message };
					}
				},
				log: async (path, limit) => {
					if (!canRead()) throw new Error('插件未声明读能力 "fs"/"fs:read"（manifest.permissions）——请求被拒');
					try {
						const mod = await import("./scm.js");
						const all = await mod.scmHistory(self.cwdValue);
						const n = Math.max(1, Math.min(Number(limit ?? 50) || 50, 200));
						return all.slice(0, n);
					} catch (err) {
						return { ok: false, error: (err as Error).message };
					}
				},
			},
			bash: async (cmd, opts) => {
				// 门控语义沿用 registerAgentTool：无 "tools" 声明即拒绝（结果对象形态，不断路抛错）。
				if (!can("tools"))
					return { ok: false, output: "", error: '插件未声明能力 "tools"（manifest.permissions）——请求被拒' };
				try {
					const parts = String(cmd ?? "")
						.trim()
						.split(/\s+/)
						.filter(Boolean);
					const file = parts[0];
					if (!file) return { ok: false, output: "", error: "bash: cmd 为空" };
					const cwd = opts?.cwd ? resolve(self.cwdValue, opts.cwd) : self.cwdValue;
					if (!self.isInsideWorkspace(cwd)) return { ok: false, output: "", error: `工作目录越界：${opts?.cwd}` };
					const timeout = Math.max(1000, Math.min(Number(opts?.timeoutMs ?? 60_000) || 60_000, 600_000));
					const { stdout, stderr } = await execFileAsync(file, parts.slice(1), {
						cwd,
						timeout,
						windowsHide: true,
						maxBuffer: 4 * 1024 * 1024,
						encoding: "utf8",
					});
					const output = `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.slice(0, 256 * 1024);
					return { ok: true, output, exitCode: 0 };
				} catch (err) {
					const e = err as { message?: unknown; stdout?: unknown; stderr?: unknown; code?: unknown };
					const out = [typeof e.stdout === "string" ? e.stdout : "", typeof e.stderr === "string" ? e.stderr : ""]
						.filter(Boolean)
						.join("\n")
						.slice(0, 256 * 1024);
					return {
						ok: false,
						output: out,
						...(typeof e.code === "number" ? { exitCode: e.code } : {}),
						error: String(e.message ?? err).slice(0, 2000),
					};
				}
			},
			schedule: (cronOrMs, fn, opts) => {
				if (typeof fn !== "function") throw new Error("schedule: fn 必须是函数");
				const persistent = (opts as { persistent?: unknown } | undefined)?.persistent === true;
				const catchUp = (opts as { catchUp?: unknown } | undefined)?.catchUp === "once" ? "once" : "skip";
				const label =
					typeof (opts as { label?: unknown } | undefined)?.label === "string" &&
					String((opts as { label?: string }).label).trim()
						? String((opts as { label?: string }).label)
								.trim()
								.slice(0, 60)
						: undefined;
				// 归一化声明：毫秒间隔 或 全 5 字段 cron（旧的 "*/N * * * *" 是它的子集，照常工作）。
				let ms = 0;
				let parts: CronParts | undefined;
				let specText: string;
				if (typeof cronOrMs === "number") {
					ms = Math.floor(cronOrMs) || 0;
					if (!(ms > 0)) throw new Error("schedule: 间隔毫秒数必须大于 0");
					ms = Math.min(ms, 2_147_483_647); // setInterval 上限（约 24.8 天），防溢出立即触发
					ms = Math.max(ms, persistent ? 60_000 : 10_000);
					specText = String(ms);
				} else if (typeof cronOrMs === "string") {
					specText = cronOrMs.trim().replace(/\s+/g, " ");
					const parsed = parseCronSpec(specText);
					if (!parsed)
						throw new Error(`schedule: 不支持的 cron 形状「${cronOrMs}」（要 5 字段：分 时 日 月 周，如 "0 9 * * *"）`);
					parts = parsed;
				} else {
					throw new Error("schedule: 参数必须是间隔毫秒数或 cron 字符串");
				}
				// 持久化：声明落盘（幂等——activate 重调时保留 lastRun/createdAt，只更新声明）。
				let sid = "";
				if (persistent) {
					sid =
						typeof (opts as { id?: unknown } | undefined)?.id === "string"
							? String((opts as { id?: string }).id).trim()
							: "";
					if (!sid || !ID_RE.test(sid))
						throw new Error("schedule: persistent 任务必须给合法 id（字母/数字/下划线/连字符），重启后靠它重建");
					const records = loadScheduleRecords(dir);
					const prev = records[sid];
					records[sid] = {
						spec: specText,
						catchUp,
						...(label ? { label } : {}),
						...(prev?.lastRun !== undefined ? { lastRun: prev.lastRun } : {}),
						createdAt: prev?.createdAt ?? Date.now(),
					};
					saveScheduleRecords(dir, records);
				}
				let timer: NodeJS.Timeout | undefined;
				let grace: NodeJS.Timeout | undefined;
				let cancelled = false;
				/** 下一次触发时刻的展示串；`null` = 一年内没有下一次（如 2 月 31 日）。 */
				const nextText = (): string | null => {
					if (parts) {
						try {
							const at = nextCronFire(parts, Date.now());
							return at === null ? null : new Date(at).toLocaleString();
						} catch {
							return specText;
						}
					}
					return `每 ${Math.round(ms / 1000)}s`;
				};
				const statusText = (): string => {
					const next = nextText();
					return next === null ? "不再触发（表达式在一年内不会命中）" : `下次 ${next}`;
				};
				// 后台面板条目（持久任务独有）：看得见下次时间，停止=删声明（不再复活）。
				let bgRefresh: (() => void) | undefined;
				let bgUnreg: (() => void) | undefined;
				if (persistent) {
					const taskId = `schedule:${sid}`;
					bgTaskTable.delete(taskId);
					const entry: PluginBgTask = {
						id: taskId,
						label: `⏰ ${label ?? sid}`,
						since: Date.now(),
						status: statusText(),
						stop: () => off(),
					};
					bgTaskTable.set(taskId, entry);
					self.pluginBgTasks.set(info.id, bgTaskTable);
					const fireBg = (): void => {
						try {
							self.onBgTasksChanged?.();
						} catch {
							/* 推送失败不影响定时本身 */
						}
					};
					bgRefresh = () => {
						if (!bgTaskTable.has(taskId)) return;
						entry.status = statusText();
						fireBg();
					};
					bgUnreg = () => {
						if (bgTaskTable.delete(taskId)) {
							if (bgTaskTable.size === 0) self.pluginBgTasks.delete(info.id);
							fireBg();
						}
					};
					fireBg();
				}
				const fire = (): void => {
					if (cancelled) return;
					if (persistent) {
						const records = loadScheduleRecords(dir);
						const rec = records[sid];
						if (rec) {
							rec.lastRun = Date.now();
							saveScheduleRecords(dir, records);
						}
					}
					try {
						const r = (fn as () => unknown)();
						if (r instanceof Promise) {
							r.catch((err) => console.error(`[plugin:${info.id}] scheduled task failed:`, err));
						}
					} catch (err) {
						console.error(`[plugin:${info.id}] scheduled task failed:`, err);
					}
					bgRefresh?.();
				};
				/**
				 * 排下一次触发。两个要点：
				 *  - `nextCronFire` 回 null = 一年内没有下一次（如 `0 0 31 2 *`）→ 不再排；
				 *  - 延迟走 `armDelay` 分片（默认 ≤6 小时），因为 Node 的 setTimeout 延迟超过
				 *    2^31-1ms（≈24.8 天）会**溢出成 1ms**，配上「下次在 42 天/一年后」的
				 *    合法 cron 就是「1ms 后再触发」的死循环（触发还会回调插件 → 写盘 + 广播）。
				 *    分片醒来后重新计算，真到点才 fire。
				 */
				const armCron = (): void => {
					if (cancelled || !parts) return;
					const next = nextCronFire(parts, Date.now());
					if (next === null) return;
					timer = setTimeout(
						() => {
							if (cancelled) return;
							const at = nextCronFire(parts, Date.now());
							if (at === null) return;
							if (at <= Date.now() + 1000) fire();
							armCron();
						},
						armDelay(next, Date.now()),
					);
					timer.unref?.();
				};
				if (parts) armCron();
				else {
					timer = setInterval(fire, ms);
					timer.unref?.();
				}
				// 漏跑补跑：以上次触发（没跑过按创建时间）为锚，下一次已在过去=漏了。
				if (persistent && catchUp === "once") {
					const refTime =
						loadScheduleRecords(dir)[sid]?.lastRun ?? loadScheduleRecords(dir)[sid]?.createdAt ?? Date.now();
					const missed = parts
						? (() => {
								const at = nextCronFire(parts, refTime);
								return at !== null && at <= Date.now(); // null = 一年内没有下一次，不算漏跑
							})()
						: refTime + ms <= Date.now();
					if (missed) {
						// 15s 缓冲：刚启动时模型/网络可能还没就绪，补跑不等那 15 秒可能白跑。
						grace = setTimeout(() => fire(), 15_000);
						grace.unref?.();
					}
				}
				const cancelTimer = (): void => {
					cancelled = true;
					if (timer !== undefined) {
						clearTimeout(timer);
						clearInterval(timer);
					}
					if (grace !== undefined) clearTimeout(grace);
				};
				const off = (): void => {
					cancelTimer();
					bgUnreg?.();
					if (persistent) {
						const records = loadScheduleRecords(dir);
						if (sid in records) {
							delete records[sid];
							saveScheduleRecords(dir, records);
						}
					}
				};
				// 反激活只停表、不断持久化：下次 activate 重调 schedule() 即按落盘声明重建。
				effects.add(`schedule:${sid}`, cancelTimer);
				return off;
			},
			models: {
				list: () => {
					try {
						const r = self.modelLister?.();
						if (r instanceof Promise) {
							return r.catch((err) => {
								console.error(`[plugin:${info.id}] modelLister failed:`, err);
								return [];
							});
						}
						return r ?? [];
					} catch (err) {
						console.error(`[plugin:${info.id}] modelLister failed:`, err);
						return [];
					}
				},
			},
			mcp: {
				list: async () => {
					try {
						const res = listAllMcpServers({
							agentDir: self.mcpBridge?.getAgentDir(),
							cwd: self.cwdValue,
							dataDir: self.dataDir,
							bridge: self.mcpBridge,
						});
						return res.servers;
					} catch (err) {
						console.error(`[plugin:${info.id}] mcp.list failed:`, err);
						return [];
					}
				},
				check: async (query) => {
					try {
						return checkMcpServer({
							agentDir: self.mcpBridge?.getAgentDir(),
							cwd: self.cwdValue,
							dataDir: self.dataDir,
							bridge: self.mcpBridge,
							query: String(query ?? ""),
						});
					} catch (err) {
						console.error(`[plugin:${info.id}] mcp.check failed:`, err);
						return { installed: false, running: false, enabled: false, server: null, matches: [], tools: [] };
					}
				},
				install: async (spec) => {
					if (!can("tools")) {
						return { ok: false, error: '插件未声明能力 "tools"（manifest.permissions）——请求被拒' };
					}
					try {
						const res = await installMcpServer({
							agentDir: self.mcpBridge?.getAgentDir(),
							cwd: self.cwdValue,
							dataDir: self.dataDir,
							bridge: self.mcpBridge,
							spec: spec ?? {},
						});
						if (res.ok) {
							try {
								self.onAgentToolsChanged?.();
							} catch {
								/* ignore */
							}
						}
						return res;
					} catch (err) {
						return { ok: false, error: (err as Error).message };
					}
				},
				promptInstall: async (target, opts) => {
					if (!can("chat") && !can("tools")) {
						return { ok: false, error: '插件未声明能力 "chat" 或 "tools"（manifest.permissions）——请求被拒' };
					}
					const scope = opts?.scope === "global" ? "global" : "project";
					let desc = "";
					if (typeof target === "string") {
						desc = target.trim();
					} else if (target && typeof target === "object") {
						const parts: string[] = [];
						if (target.name) parts.push(`name="${target.name}"`);
						if (target.package) parts.push(`package="${target.package}"`);
						if (target.command) parts.push(`command="${target.command}"`);
						if (target.args?.length) parts.push(`args=${JSON.stringify(target.args)}`);
						if (target.url) parts.push(`url="${target.url}"`);
						desc = parts.join(", ");
					}
					if (!desc) {
						return { ok: false, error: "mcp.promptInstall: target 不能为空" };
					}
					const cfgFile = scope === "global" ? "~/.pi/agent/mcp.json" : ".pi/mcp.json";
					const promptText =
						`请检查并安装以下 MCP 服务器（作用域：${scope}，配置文件：\`${cfgFile}\`）：${desc}。\n` +
						`- 若当前会话已启用 \`mcp_manage\` 工具，请先调用 \`mcp_manage({ action: "check", query: ... })\` 确认是否已安装，未安装则调用 \`mcp_manage({ action: "install", scope: "${scope}", ... })\` 完成安装并验证状态；\n` +
						`- 若未启用 \`mcp_manage\` 工具，请用 \`read\` 检查 \`${cfgFile}\`，并在 \`mcpServers\` 字段下写入对应的服务器配置（例如 \`{ "command": "npx", "args": ["-y", "<package>"] }\`），保存后系统会自动热加载该 MCP 服务器。`;
					const targetConvId =
						(typeof opts?.conversationId === "string" && opts.conversationId.trim()) ||
						self.conversationProvider?.()?.conversationId;
					if (targetConvId && self.conversationWriter) {
						try {
							const r = await self.conversationWriter(targetConvId, promptText);
							return { ok: r.ok, conversationId: targetConvId, ...(r.error ? { error: r.error } : {}) };
						} catch (err) {
							return { ok: false, error: (err as Error).message };
						}
					}
					if (self.chatProvider) {
						try {
							const r = await self.chatProvider(info.id, { text: promptText });
							return { ok: true, conversationId: r.conversationId };
						} catch (err) {
							return { ok: false, error: (err as Error).message };
						}
					}
					return { ok: false, error: "无可用对话通道（conversationWriter / chatProvider 未接入）" };
				},
			},
			onStats: (h) => {
				self.statsHandlers.add(h);
				return effects.add("onStats", () => {
					self.statsHandlers.delete(h);
				});
			},
			onStreaming: (h) => {
				self.streamingHandlers.add(h);
				return effects.add("onStreaming", () => {
					self.streamingHandlers.delete(h);
				});
			},
			net: {
				fetch: async (url, init) => {
					if (!can("net")) return { ok: false, error: '插件未声明能力 "net"（manifest.permissions）——请求被拒' };
					return pluginNetFetch(url, init, {
						// 白名单：主机相等或 .后缀匹配；空表即全拒（fail-closed）。
						// 用户动态批准的主机（host.requestPermission）同样放行，免改 manifest 重装。
						hostAllowed: (hostname) =>
							netAllow.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`)) ||
							self.permGrants.has(info.id, "net", { host: hostname }),
						fetchImpl: (input, reqInit) => globalThis.fetch(input, reqInit),
					});
				},
			},
			events: {
				emit: (topic, payload) => {
					const t = String(topic ?? "");
					if (!t) return;
					// 载荷 JSON 往返截断：4KB 内还原对象，超了取截断后的字符串化形态。
					let p: unknown;
					try {
						const s = JSON.stringify(payload);
						p = s.length > 4096 ? s.slice(0, 4096) : JSON.parse(s);
					} catch {
						try {
							p = String(payload).slice(0, 4096);
						} catch {
							p = undefined;
						}
					}
					const ev: PluginBusEvent = { topic: t, from: info.id, payload: p };
					const handlers = self.busHandlers.get(t);
					if (!handlers) return;
					for (const h of handlers) {
						try {
							h(ev);
						} catch (err) {
							console.error(`[plugin:${info.id}] bus handler failed:`, err);
						}
					}
				},
				on: (topic, handler) => {
					const t = String(topic ?? "");
					if (!t || typeof handler !== "function") return () => {};
					let set = self.busHandlers.get(t);
					if (!set) self.busHandlers.set(t, (set = new Set()));
					set.add(handler);
					return effects.add(`bus:${t}`, () => {
						set.delete(handler);
						if (set.size === 0) self.busHandlers.delete(t);
					});
				},
			},
			log: (levelOrArg, ...args) => {
				const level = normalizePluginLogLevel(levelOrArg);
				// 首参是级别即剥掉（不进文本）；否则全部参数都是日志内容（老插件兼容）。
				const text = formatPluginLogText(levelOrArg === level ? args : [levelOrArg, ...args]);
				self.appendPluginLog(info.id, level, text);
				const line = `[plugin:${info.id}]${text ? ` ${text}` : ""}`;
				// console 既有行为保留：级别只决定走哪个 console 方法。
				if (level === "error") console.error(line);
				else if (level === "warn") console.warn(line);
				else if (level === "debug") console.debug(line);
				else console.log(line);
			},
			effect: (label, dispose) => {
				if (typeof dispose !== "function") return () => {};
				const name =
					String(label ?? "")
						.trim()
						.slice(0, 64) || "anonymous";
				return effects.add(`plugin:${name}`, dispose);
			},
		};
		try {
			// Node 对同一 URL 的 import() 永远返回缓存模块——追加 epoch 作查询串
			// 击穿缓存，让 plugins_reload 后的重新激活能拿到磁盘上的新代码。
			const mod = (await import(pathToFileURL(join(dir, "index.mjs")).href + `?e=${this.epochCounter}`)) as {
				default?: {
					activate?: (host: PluginHost) => void | (() => void) | Promise<void | (() => void)>;
				};
			};
			const ret = await mod.default?.activate?.(host);
			const gateWarned = self.activatingGates.get(info.id)?.legacyWarned;
			self.activatingGates.delete(info.id);
			// activate() 执行期间经 host 注册产生的运行时诊断（重复工具/命令、ui 丢弃等）
			// 已经进了 runtimeDiags，这里合并进快照一起下发。
			const combined = this.diagnosticsOf(info.id);
			this.loaded.set(info.id, {
				info: { ...info, ...(combined ? { diagnostics: combined } : {}) },
				deactivate: typeof ret === "function" ? ret : undefined,
				toolHandlers,
				preGuards,
				postGuards,
				runHandlers,
				convChangeHandlers,
				modelChangeHandlers,
				attachHandlers,
				cwdHandlers,
				effects,
				httpRoutes,
				permsDeclared,
				permFamilies,
				strictMode: strict,
				legacyWarned: gateWarned,
				settingsHandlers,
			});
			console.log(`[plugin:${info.id}] activated (v${info.version ?? "?"})`);
			// 首次安装/能力变更提醒（尽力而为）：<dir>/.pi-approved 记录上次激活时
			// 的能力清单——新装或 permissions 变更后向在线客户端推一条警告通知，
			// 用户装前可见、日常启动不打扰。
			void this.maybeConsentNotice(info, dir, permsDeclared);
		} catch (err) {
			// 激活失败：先把这一轮已经登记的可逆副作用逆序回卷（半途注册的工具/路由/
			// 定时器不能留着 —— 插件已经坏了，谁也不会来撤它们），再留一条错误占位行。
			const failed = effects.release();
			httpRoutes.clear();
			self.activatingGates.delete(info.id);
			this.pushRuntimeDiag(info.id, `activate failed: ${(err as Error).message}`);
			if (failed.length > 0)
				this.pushRuntimeDiag(
					info.id,
					`activate failed with ${failed.length} effect(s) not cleaned: ${failed.join(", ")}`,
				);
			this.loaded.set(info.id, {
				info: { ...info, error: (err as Error).message, diagnostics: this.diagnosticsOf(info.id) },
				toolHandlers,
				runHandlers,
				convChangeHandlers,
				attachHandlers,
				cwdHandlers,
				httpRoutes,
				settingsHandlers: new Set(),
			});
			console.error(`[plugin:${info.id}] activate failed:`, err);
		}
	}
}

/**
 * 把 /plugins/:id/client/<rest> 安全映射到 <pluginsDir>/<id>/client/<rest>。
 * 返回绝对路径；任何越界/非法 id 返回 null（调用方回 404）。
 */
export function resolvePluginClientFile(pluginsDir: string, id: string, rest: string): string | null {
	if (!ID_RE.test(id)) return null;
	const root = resolve(join(pluginsDir, id, "client"));
	// rest 由 express 路由保证不带 ".."，但双保险：resolve 后必须仍在 root 内
	const abs = resolve(root, rest);
	if (abs !== root && !abs.startsWith(root + sep)) return null;
	return abs;
}

/** 通用代理前缀的保留字：命中即拒绝注册（宿主自用路径，代理抢了会吞掉主站功能）。 */
export const PROXY_RESERVED_PREFIXES = [
	"/api",
	"/ws",
	"/plugins",
	"/plugins-api",
	"/assets",
	"/icons",
	"/themes",
] as const;

/** 代理目标（只允许回环，防 SSRF：插件借宿主端口只能把本机服务露出来）。 */
export interface PluginProxyTarget {
	host: string;
	port: number;
}

/** 校验并归一化代理前缀：合法返回去尾斜杠的小写形式，否则返回 null（纯函数，单测覆盖）。 */
export function normalizeProxyPrefix(prefix: string): string | null {
	if (typeof prefix !== "string") return null;
	let p = prefix.trim();
	if (!p.startsWith("/") || p.length < 2) return null;
	// 去尾斜杠（"/liveserver/" → "/liveserver"）
	while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
	if (!/^[A-Za-z0-9/_-]+$/.test(p) || p.includes("//")) return null;
	const lower = p.toLowerCase();
	for (const r of PROXY_RESERVED_PREFIXES) {
		if (lower === r || lower.startsWith(`${r}/`)) return null;
	}
	return lower;
}

/** 校验代理目标：只收 127.0.0.1/localhost + 合法端口（纯函数，单测覆盖）。 */
export function normalizeProxyTarget(target: unknown): PluginProxyTarget | null {
	const port = typeof target === "number" ? target : (target as { port?: unknown })?.port;
	const hostRaw =
		typeof target === "number" ? "127.0.0.1" : String((target as { host?: unknown })?.host ?? "127.0.0.1");
	const host = hostRaw.trim().toLowerCase();
	if (host !== "127.0.0.1" && host !== "localhost") return null;
	if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return null;
	return { host: "127.0.0.1", port: port as number };
}

/** 在请求路径上做最长前缀匹配（边界对齐：prefix 本身或 prefix + "/" 开头才算命中）。 */
export function matchProxyPrefix(path: string, prefixes: Iterable<string>): string | undefined {
	let best: string | undefined;
	for (const p of prefixes) {
		if (path === p || path.startsWith(`${p}/`)) {
			if (!best || p.length > best.length) best = p;
		}
	}
	return best;
}

/**
 * 把插件 AI 工具定义同步进一个「会话状对象」（SDK AgentSession 的结构子集：
 * 内部 _customTools 数组 + _refreshToolRegistry()——refresh 会重读数组，且新
 * 工具名自动加入活跃集）。新增/更新/移除三向 diff；对象不兼容（SDK 改名）返回
 * null 由调用方静默降级。返回新的已注入名单。
 *
 * 纯函数、不 import SDK —— vitest 直接测（tests/unit/plugin-tools.test.ts）。
 */
export function syncPluginToolsIntoSession(
	session: {
		_customTools?: Array<{ name: string } & Record<string, unknown>>;
		_refreshToolRegistry?: () => void;
	},
	defs: Array<{ name: string } & Record<string, unknown>>,
	prevNames: ReadonlySet<string>,
): ReadonlySet<string> | null {
	if (!Array.isArray(session._customTools) || typeof session._refreshToolRegistry !== "function") return null;
	const byName = new Map(session._customTools.map((d) => [d.name, d]));
	let changed = false;
	for (const d of defs) {
		if (byName.get(d.name) !== d) {
			byName.set(d.name, d);
			changed = true;
		}
	}
	for (const name of prevNames) {
		if (!defs.some((d) => d.name === name) && byName.has(name)) {
			byName.delete(name);
			changed = true;
		}
	}
	if (!changed) return new Set(defs.map((d) => d.name));
	session._customTools = [...byName.values()];
	session._refreshToolRegistry();
	return new Set(defs.map((d) => d.name));
}

/** net.fetch 的手动重定向跳数上限。 */
const NET_FETCH_MAX_REDIRECTS = 5;

/** host.net.fetch 的 init 形状（与 PluginHost 接口一致，抽出便于单测）。 */
export interface PluginNetFetchInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

export type PluginNetFetchResult = { ok: true; status: number; text: string } | { ok: false; error: string };

/** 全局 fetch 的 Response 形状（plugins.ts 里 express 的 Response 遮蔽了全局名）。 */
type FetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>;
/** net.fetch 的 fetch 实现形状（与 globalThis.fetch 一致，单测用替身注入）。 */
type FetchLike = (input: string, init?: RequestInit) => Promise<FetchResponse>;

/**
 * net.fetch 的白名单 + 手动重定向循环（抽出为纯可注入函数，vitest 直测）。
 *
 * 为什么不用 redirect:"follow"：跟随重定向不复查白名单，会把「只授权了 A 主机」
 * 变成「A 主机一跳把你带到任意主机/内网地址」（经典白名单绕过跳板）。所以：
 *  - 每一跳（含首次）的目标 host 都重新过 allowHost（manifest 白名单 + 用户动态批准）；
 *  - redirect:"manual"，至多 NET_FETCH_MAX_REDIRECTS 跳；
 *  - 跨宿主重定向剥掉 authorization/cookie 头（浏览器同款语义，防凭据外带）；
 *  - 303 一律转 GET 并丢 body；其余 3xx 保持原 method/body（307/308 语义）；
 *  - 响应文本整体回给插件的现状保留（512KB 截断不变）；
 *  - timeout 是整条请求链（含所有跳）共享的墙钟预算（与原实现 15s 同量级）。
 */
export async function pluginNetFetch(
	url: string,
	init: PluginNetFetchInit | undefined,
	deps: {
		/** 目标主机是否在白名单/授权表内（每一跳都要过）。 */
		hostAllowed: (hostname: string) => boolean;
		/** fetch 实现（单测替身注入）。 */
		fetchImpl: FetchLike;
		/** 整条请求链的墙钟上限毫秒（默认 15000）。 */
		timeoutMs?: number;
	},
): Promise<PluginNetFetchResult> {
	const deadline = Date.now() + Math.max(1000, Number(deps.timeoutMs ?? 15_000));
	let current = String(url ?? "");
	let method = init?.method;
	let headers: Record<string, string> | undefined = init?.headers;
	let body = init?.body;
	for (let hop = 0; ; hop++) {
		let u: URL;
		try {
			u = new URL(current);
		} catch {
			return { ok: false, error: `net: 无效 URL ${current}` };
		}
		if (u.protocol !== "http:" && u.protocol !== "https:") {
			return { ok: false, error: `net: 不支持的协议 ${u.protocol}` };
		}
		// 白名单：主机相等或 .后缀匹配；空表即全拒（fail-closed）。每一跳都查。
		if (!deps.hostAllowed(u.hostname.toLowerCase())) {
			return {
				ok: false,
				error: `net: 主机 ${u.hostname} 未授权（manifest.netAllowlist 或 host.requestPermission 申请）`,
			};
		}
		if (body !== undefined && Buffer.byteLength(String(body), "utf8") > 1024 * 1024) {
			return { ok: false, error: "net: body 超过 1MB 上限" };
		}
		let res: FetchResponse;
		try {
			res = await deps.fetchImpl(current, {
				...(method ? { method } : {}),
				...(headers ? { headers } : {}),
				...(body !== undefined ? { body } : {}),
				redirect: "manual",
				signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
			});
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
		// 3xx 且带 location → 手动跳下一跳（目标 host 重新过上面的白名单）。
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get("location");
			if (loc) {
				if (hop >= NET_FETCH_MAX_REDIRECTS) {
					return { ok: false, error: `net: 重定向超过 ${NET_FETCH_MAX_REDIRECTS} 跳上限` };
				}
				let next: URL;
				try {
					next = new URL(loc, u);
				} catch {
					return { ok: false, error: `net: 重定向目标无效 ${loc}` };
				}
				if (next.hostname.toLowerCase() !== u.hostname.toLowerCase() && headers) {
					// 跨宿主：凭据类头不外带。
					const stripped: Record<string, string> = {};
					for (const [k, v] of Object.entries(headers)) {
						const key = k.toLowerCase();
						if (key === "authorization" || key === "cookie") continue;
						stripped[k] = v;
					}
					headers = stripped;
				}
				if (res.status === 303) {
					method = "GET";
					body = undefined;
				}
				current = next.toString();
				continue;
			}
		}
		try {
			const text = (await res.text()).slice(0, 512 * 1024);
			return { ok: true, status: res.status, text };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}
}
