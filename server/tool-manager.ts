/**
 * tool-manager.ts — Agent 工具开关的唯一事实源 + 统一出入口（tool_manage）。
 *
 * 背景：工具启用散在 4 种写法里——applyToolGating 只会 terminal_* + edit_soft、
 * “子代理系列”/delegate_task/ask_user_question/markers_list 注册即常驻（无开关）、
 * skills/extensions 走 resourceLoader 过滤（要 reload）、terminalBash 等是行为
 * 分支。本模块只收 **ActiveSet 层**（SDK customTools 经
 * getActiveToolNames/setActiveToolsByName 的启用/禁用，live 生效、无需 reload）；
 * skills/extensions（资源过滤，另一生命周期）与行为开关不进此表。
 *
 * 持久化只有 `ClientSettings.disabledAgentTools: string[]`（禁用的工具名）；
 * 旧的 terminalToolsEnabled/editSoftEnabled/questionnaireEnabled 作为遗留别名
 * 保留（协议兼容），由本模块的 legacy*  helper 双向同步。
 *
 * 纯模块：零 node 依赖（不 import 任何 server 模块），前端可直接 import
 * （vite 构建不断），单测零开销。
 */

import type { UiAgentPreset, DshPermissionOption } from "./protocol.js";

/** 画布流水线编辑工具（定义见 canvas/canvas-agent-tool.ts，单 action：list/get/add_node/update_node/delete_node/add_edge/delete_edge/apply_dag）。 */
export const CANVAS_TOOL_NAME = "canvas";
/** 持久终端工具（定义见 terminals.ts，工具名在此唯一登记）。 */
export const TERMINAL_TOOL_NAMES = [
	"terminal_create",
	"terminal_list",
	"terminal_close",
	"terminal_input",
	"terminal_key",
	"terminal_read",
	"terminal_wait",
] as const;

/** 第一方子代理工具（定义见 subagents.ts，统一为单 action 工具）。 */
export const SUBAGENT_TOOL_NAME = "subagent";
export const SUBAGENT_TOOL_NAMES = [SUBAGENT_TOOL_NAME] as const;

/** 旧版 8 个独立子代理工具名（持久化配置迁移用）。 */
export const LEGACY_SUBAGENT_TOOL_NAMES = [
	"subagent_spawn",
	"subagent_get_result",
	"subagent_steer",
	"subagent_list",
	"subagent_stop",
	"subagent_wait_all",
	"subagent_templates",
	"subagent_handoff",
] as const;

/** 独立宽松编辑工具（定义见 edit-soft-tool.ts）。 */
export const EDIT_SOFT_TOOL_NAME = "edit_soft";
/** 结构化派单工具（定义见 delegate-task.ts，执行体复用子代理 spawn 通道）。 */
export const DELEGATE_TASK_TOOL_NAME = "delegate_task";
/** 问卷提问工具（定义见 agent-service.ts makeAskUserQuestionTool）。 */
export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
/** 浏览器页面操作工具（定义见 agent-service.ts makeBrowserPageTool）：模型经
 *  page-picker 浏览器扩展读/操作用户已授权的页面。 */
export const BROWSER_PAGE_TOOL_NAME = "browser_page";
/** 别的对话读取工具（定义见 conversation-read-tool.ts）：运行中对话（含子代理）+
 *  历史会话转录，只读。 */
export const CONVERSATION_READ_TOOL_NAME = "conversation_read";
/** 技能全文按名加载工具（定义见 skill-tool.ts）：名录见 {{skills}} 段，
 *  全文走本工具按需取，不再让模型拼路径调 read。 */
export const SKILL_TOOL_NAME = "skill";
/** 定时任务工具（定义见 schedule-agent-tool.ts）：单 action 工具，create 建任务 /
 *  list 查看 / cancel 取消；到期自动唤醒发起对话执行 prompt 并汇报。 */
export const SCHEDULE_TOOL_NAME = "schedule";
/** 旧版 3 个独立定时任务工具名（持久化配置迁移用：用户在旧版本关掉的任一个
 *  都迁移为关闭合并后的 schedule 工具）。 */
export const LEGACY_SCHEDULE_TOOL_NAMES = ["schedule_task", "schedule_list", "schedule_cancel"] as const;
/** 持久代码求值沙箱工具（定义见 eval-tool.ts）：在受控持久内核中执行 Python 或 JS/TS 代码。 */
export const EVAL_TOOL_NAME = "eval";
/** 展示文件工具（定义见 present-files-tool.ts）：把图片/视频/文本作为预览卡片
 *  推到对话里，卡片带预览/本地打开/在文件夹中显示/下载/复制路径。 */
export const PRESENT_FILES_TOOL_NAME = "present_files";
/** 文件认领工具（定义见 claim-files-tool.ts）：声明要改哪些文件，让同项目的
 *  并行对话绕行（纯建议，不拦编辑）。 */
export const CLAIM_FILES_TOOL_NAME = "claim_files";
/** 任务计划看板更新工具（定义见 plan-manager.ts，Plan Mode / 步骤状态机）。 */
export const PLAN_UPDATE_TOOL_NAME = "plan_update";
/** 主动上下文压缩工具（定义见 compact-context-tool.ts）。 */
export const COMPACT_CONTEXT_TOOL_NAME = "compact_context";
/** 高可靠结构化补丁工具（定义见 patch-tool.ts）：基于内容哈希锚点与语法块的行补丁工具。 */
export const PATCH_TOOL_NAME = "patch";
/** 原生语言服务器工具（定义见 lsp-tool.ts）：代码定义跳转、引用查询、类型悬停与诊断。 */
export const LSP_TOOL_NAME = "lsp";
/** MCP 服务器检测与安装管理工具（定义见 mcp-agent-tool.ts）：检查/安装/移除/重载 MCP 服务器。 */
export const MCP_MANAGE_TOOL_NAME = "mcp_manage";
/** 隔离沙盒项目管理工具（定义见 sandbox-tool.ts）：创建空白/导入型隔离沙盒、查看 diff、重置或销毁。 */
export const SANDBOX_TOOL_NAME = "sandbox";
/** Git 工作树管理工具（定义见 worktree-tool.ts）：创建/切换/清理工作树，保持多 PR 开发与界面工作区同步。 */
export const WORKTREE_TOOL_NAME = "worktree";
/** QuickJS WASM 沙箱代码执行与批量调用工具（SDK 内置 codemode 扩展）。 */
export const CODEMODE_TOOL_NAME = "codemode";
/** 基于 BM25 算法的延迟工具检索与激活工具（SDK 内置 tool-search 扩展）。 */
export const TOOL_SEARCH_TOOL_NAME = "tool_search";
/** 按需加载工具（定义见 load-tools-tool.ts）：延迟加载模式下模型的唯一入口 ——
 *  系统提示词只给全部工具的**名字 + 一行摘要**，模型先把要用的名字交给它，那些
 *  工具的完整参数 schema 才会进入会话（SDK 中途新增工具，支持 defer_loading /
 *  tool_search 的供应商不会把它们堆在首轮）。 */
export const LOAD_TOOLS_TOOL_NAME = "load_tools";
/** 延迟加载模式下**永远活跃**的核心工具（其余全部先当未加载）。 */
export const LAZY_CORE_TOOL_NAMES = ["bash", "read", "edit", "write"] as const;

export type AgentToolGroup = "core" | "terminal" | "subagent" | "other";

export interface AgentToolEntry {
	name: string;
	group: AgentToolGroup;
	/** 默认开关（终端组/edit_soft/browser_page/powershell 默认关，其余默认开）。 */
	defaultOn: boolean;
	/** 操作系统限制（如 "win32"；未定义表示跨平台通用）。 */
	platform?: "win32" | "posix";
	/** 安全维度：是否允许 AI 自主开关（默认 true；bash/read 等核心底层工具为 false，显式防自杀）。 */
	allowAgentToggle?: boolean;
	/** DSH 引擎是否展示（DSH 无子代理/edit_soft 概念；目前 DSH 不用本表，预留）。 */
	dshVisible: boolean;
	/**
	 * 设置页「其他」组开关行的文案 key（SettingsModal 用 tt 按名取；缺失回落工具名）。
	 * 终端/子代理组走各自的通用文案不用填；「其他」组必填（单测强制），否则新工具
	 * 的行就没有说明。顺序即设置页渲染顺序。
	 */
	descKey?: string;
	offHintKey?: string;
}

/** 可开关的 Agent 工具总目录（共 24 个）。核心内置工具 bash/read/edit/write 不进
 *  目录——目录条目 = OTHER_AGENT_TOOLS 自动渲染的设置行，而这四个在设置页
 *  「核心工具」区单独开关（见 SettingsModal 的 CORE_BUILTIN_TOOL_NAMES 区块），
 *  禁用名单同样接受它们（normalizeDisabledAgentTools）。 */
export const AGENT_TOOL_CATALOG: AgentToolEntry[] = [
	...TERMINAL_TOOL_NAMES.map((name): AgentToolEntry => ({
		name,
		group: "terminal",
		defaultOn: false,
		dshVisible: true,
	})),
	...SUBAGENT_TOOL_NAMES.map((name): AgentToolEntry => ({
		name,
		group: "subagent",
		defaultOn: true,
		dshVisible: false,
	})),
	{
		name: EDIT_SOFT_TOOL_NAME,
		group: "other",
		defaultOn: false,
		dshVisible: false,
		descKey: "editSoftEnabledDesc",
		offHintKey: "editSoftOffHint",
	},
	{
		name: DELEGATE_TASK_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "delegateTaskEnabledDesc",
		offHintKey: "delegateTaskOffHint",
	},
	{
		name: ASK_USER_QUESTION_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: true,
		descKey: "questionnaireEnabledDesc",
		offHintKey: "questionnaireOffHint",
	},
	// 默认关（AI 动用户浏览器，opt-in 才开）且 dshVisible=false：DSH 引擎没有页面桥
	// （page_request 由 pi 引擎的 customTool 发出），列在那里只会让用户关一个不存在的工具。
	{
		name: BROWSER_PAGE_TOOL_NAME,
		group: "other",
		defaultOn: false,
		dshVisible: false,
		descKey: "browserPageEnabledDesc",
		offHintKey: "browserPageOffHint",
	},
	// 只读别的对话（含子代理实时消息与历史转录），默认开；DSH 引擎没有该 customTool。
	{
		name: CONVERSATION_READ_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "conversationReadEnabledDesc",
		offHintKey: "conversationReadOffHint",
	},
	// 文件认领（事前打招呼，纯 advisory）：默认开，不打开 AI 不知道能认领；
	// 关掉只少一路提醒（事后触碰集照常工作）；DSH 引擎没有该 customTool
	// （走 goal-rpc，无 customTool 注册面），提醒是服务端算的、DSH 照样能看到。
	{
		name: CLAIM_FILES_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "claimFilesEnabledDesc",
		offHintKey: "claimFilesOffHint",
	},
	// 结构化任务计划更新（Plan Mode / Step State Machine），默认开。
	{
		name: PLAN_UPDATE_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: true,
		descKey: "planUpdateEnabledDesc",
		offHintKey: "planUpdateOffHint",
	},
	{
		name: PATCH_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "patchToolEnabledDesc",
		offHintKey: "patchToolOffHint",
	},
	{
		name: LSP_TOOL_NAME,
		group: "other",
		defaultOn: false,
		dshVisible: false,
		descKey: "lspToolEnabledDesc",
		offHintKey: "lspToolOffHint",
	},
	// 展示文件给用户（图片/视频内联、文本开预览弹窗、本地打开按钮）：默认开，
	// 不打开模型根本不知道能“给用户看”；DSH 引擎没有该 customTool（走 shipped preset）。
	{
		name: PRESENT_FILES_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "presentFilesEnabledDesc",
		offHintKey: "presentFilesOffHint",
	},
	// 技能全文按名加载（名录仍在 {{skills}} 段），默认开；DSH 引擎没有该 customTool
	// （走 goal-rpc，无 customTool 注册面）。
	{
		name: SKILL_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "skillEnabledDesc",
		offHintKey: "skillOffHint",
	},
	// 持久代码求值沙箱（Python / Node.js）：默认关（opt-in，防工具挤占）；
	// DSH 引擎没有该 customTool。
	{
		name: EVAL_TOOL_NAME,
		group: "other",
		defaultOn: false,
		dshVisible: false,
		descKey: "evalEnabledDesc",
		offHintKey: "evalOffHint",
	},
	// QuickJS WASM 沙箱代码执行与批量调用工具：默认关（opt-in）；DSH 引擎无此扩展。
	{
		name: CODEMODE_TOOL_NAME,
		group: "other",
		defaultOn: false,
		dshVisible: false,
		descKey: "codemodeEnabledDesc",
		offHintKey: "codemodeOffHint",
	},
	// 基于 BM25 的延迟工具检索与激活（特别适用于大规模 MCP 场景）：默认关（opt-in）。
	{
		name: TOOL_SEARCH_TOOL_NAME,
		group: "other",
		defaultOn: false,
		dshVisible: false,
		descKey: "toolSearchEnabledDesc",
		offHintKey: "toolSearchOffHint",
	},
	// 定时/延时唤醒（单 action：create/list/cancel）：默认开（不打开 AI 根本不知道能定时；
	// 60s 间隔底线＋面板可随时取消），DSH 引擎没有该 customTool（走 goal-rpc，无 customTool 注册面）。
	{
		name: SCHEDULE_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "scheduleTaskEnabledDesc",
		offHintKey: "scheduleTaskOffHint",
	},
	// 主动上下文压缩：默认开（让 AI 可以根据当前问题主动精简上下文）。
	// DSH 引擎无 customTool 注册面，不接。
	{
		name: COMPACT_CONTEXT_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "compactContextEnabledDesc",
		offHintKey: "compactContextOffHint",
	},
	// MCP 服务器检测与安装管理（单 action：list/check/install/remove/reload）：默认关（opt-in），
	// 开启后 AI 可检查某个 MCP 是否已安装并一键写入 mcp.json 热加载挂载。
	{
		name: MCP_MANAGE_TOOL_NAME,
		group: "other",
		defaultOn: false,
		dshVisible: false,
		descKey: "mcpManageEnabledDesc",
		offHintKey: "mcpManageOffHint",
	},
	// 隔离沙盒项目管理（单 action：list/create/diff/reset/persist/promote/apply_to_source/destroy）：默认开，
	// 支持 AI 自主创建空白或导入型隔离副本实验，写回源项目强制经过用户审批。
	{
		name: SANDBOX_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "sandboxEnabledDesc",
		offHintKey: "sandboxOffHint",
	},
	{
		name: WORKTREE_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "toolsWorktreeDesc",
		offHintKey: "toolsWorktreeOffHint",
	},
	{
		name: CANVAS_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "canvasToolEnabledDesc",
		offHintKey: "canvasToolOffHint",
	},
];

/** SDK 核心内置工具名（可被门控显式禁用或被预设白名单过滤）。 */
export const CORE_BUILTIN_TOOL_NAMES = ["bash", "read", "edit", "write", "powershell", "ls", "grep", "find"] as const;

export type CoreBuiltinToolName = (typeof CORE_BUILTIN_TOOL_NAMES)[number];

export interface CoreToolEntry {
	name: CoreBuiltinToolName;
	group: "core";
	defaultOn: boolean;
	platform?: "win32" | "posix";
	allowAgentToggle?: boolean;
	descKey: string;
}

/**
 * SDK 核心内置工具的声明式元数据目录。
 * 核心工具不进 AGENT_TOOL_CATALOG（避免被 AI 自杀式通过 tool_manage 禁用，且不占设置页「其他」组目录行），
 * 但拥有与目录工具完全对齐的元数据（默认开关、文案 key、分类、平台与安全维度），共同构成全系统统一的工具事实源。
 */
export const CORE_TOOL_CATALOG: readonly CoreToolEntry[] = [
	{ name: "bash", group: "core", defaultOn: true, allowAgentToggle: false, descKey: "toolCoreBashDesc" },
	{ name: "read", group: "core", defaultOn: true, allowAgentToggle: false, descKey: "toolCoreReadDesc" },
	{ name: "edit", group: "core", defaultOn: true, allowAgentToggle: false, descKey: "toolCoreEditDesc" },
	{ name: "write", group: "core", defaultOn: true, allowAgentToggle: false, descKey: "toolCoreWriteDesc" },
	{
		name: "powershell",
		group: "core",
		defaultOn: false,
		platform: "win32",
		allowAgentToggle: false,
		descKey: "toolCorePowershellDesc",
	},
	{ name: "ls", group: "core", defaultOn: true, allowAgentToggle: false, descKey: "toolCoreLsDesc" },
	{ name: "grep", group: "core", defaultOn: true, allowAgentToggle: false, descKey: "toolCoreGrepDesc" },
	{ name: "find", group: "core", defaultOn: true, allowAgentToggle: false, descKey: "toolCoreFindDesc" },
] as const;

/** 系统全部已知可开关工具的统一声明式条目集合（核心内置 8 个 ∪ 宿主扩展 28 个，共 36 个）。 */
export const ALL_AGENT_TOOL_ENTRIES: readonly AgentToolEntry[] = [
	...CORE_TOOL_CATALOG.map((c): AgentToolEntry => ({
		name: c.name,
		group: "core",
		defaultOn: c.defaultOn,
		platform: c.platform,
		allowAgentToggle: c.allowAgentToggle,
		dshVisible: false,
		descKey: c.descKey,
	})),
	...AGENT_TOOL_CATALOG,
];

const ALL_AGENT_TOOL_MAP = new Map<string, AgentToolEntry>(ALL_AGENT_TOOL_ENTRIES.map((t) => [t.name, t]));

/** 获取任意已知工具的元数据规范条目。未知名返回 undefined。 */
export function getAgentToolEntry(name: string): AgentToolEntry | undefined {
	return ALL_AGENT_TOOL_MAP.get(name);
}

/** 判断工具是否在指定操作系统平台上受支持（默认检查当前宿主 process.platform）。 */
export function isToolSupportedOnPlatform(name: string, platform: NodeJS.Platform = process.platform): boolean {
	const entry = ALL_AGENT_TOOL_MAP.get(name);
	if (!entry?.platform) return true;
	if (entry.platform === "win32") return platform === "win32";
	if (entry.platform === "posix") return platform !== "win32";
	return true;
}

export function isCoreBuiltinTool(name: string): name is CoreBuiltinToolName {
	return (CORE_BUILTIN_TOOL_NAMES as readonly string[]).includes(name);
}

const ALL_KNOWN_SET = new Set(ALL_AGENT_TOOL_ENTRIES.map((t) => t.name));

/** 全部已知可开关工具与核心内置工具全集（共 36 个）。用于白名单收敛与默认关闭推导。 */
export const ALL_KNOWN_AGENT_TOOL_NAMES: readonly string[] = ALL_AGENT_TOOL_ENTRIES.map((t) => t.name);

/** 是否为 AI 可通过 tool_manage 自主开关的工具（显式检查 allowAgentToggle !== false，防自杀式关核心工具）。 */
export function isKnownAgentTool(name: string): boolean {
	const entry = ALL_AGENT_TOOL_MAP.get(name);
	return Boolean(entry && entry.allowAgentToggle !== false);
}

/**
 * 是否为受宿主配置统一管辖的工具（宿主受管工具 Host-Managed Tools）：
 * 即核心内置工具（bash/read/edit/write/powershell 等）∪ AGENT_TOOL_CATALOG 目录登记工具。
 * 只有这类工具的开关受 Web UI 的设置面板（disabledAgentTools）与模式闸门管辖。
 * 其余工具（第三方扩展动态注册的工具如 url_context 等）归扩展自主管辖。
 */
export function isHostManagedTool(name: string): boolean {
	return ALL_KNOWN_SET.has(name);
}

/** 是否为预设可配置的有效工具（宿主目录登记工具 ∪ 核心内置工具，对齐 isHostManagedTool）。 */
export function isConfigurableAgentTool(name: string): boolean {
	return isHostManagedTool(name);
}

/** 根据禁用名单计算出当前系统中真正启用的可用工具列表（只取当前系统可用的配置）。 */
export function resolveEnabledAgentTools(disabled: readonly string[]): string[] {
	const disabledSet = new Set(disabled);
	return ALL_KNOWN_AGENT_TOOL_NAMES.filter((name) => !disabledSet.has(name));
}

/**
 * 依据显式启用的工具白名单推导禁用列表：**默认没有开的工具就是关**。
 * 凡是不在 enabled 列表里的当前系统已知工具，一律归入禁用名单，防止系统升级增加新工具时意外隐式开启。
 */
export function resolveDisabledAgentToolsFromEnabled(enabled: readonly string[]): string[] {
	const enabledSet = new Set(enabled);
	return ALL_KNOWN_AGENT_TOOL_NAMES.filter((name) => !enabledSet.has(name));
}

/** 归一化禁用名单：非数组回落默认（= 默认关的那些）；数组则只保留已知工具名
 *  （去重；未知名丢弃，防旧文件/手写脏数据污染）。支持登记核心内置工具。 */
export function normalizeDisabledAgentTools(v: unknown): string[] {
	if (!Array.isArray(v)) return defaultDisabledAgentTools();
	const out: string[] = [];
	for (const x of v) {
		let name = x;
		// 旧版子代理工具迁移：任意旧 subagent_* 关闭均迁移为关闭 subagent 工具。
		if (typeof name === "string" && (LEGACY_SUBAGENT_TOOL_NAMES as readonly string[]).includes(name)) {
			name = SUBAGENT_TOOL_NAME;
		}
		// 旧版定时任务三件套迁移：任意旧 schedule_* 关闭均迁移为关闭 schedule 工具（#193）。
		if (typeof name === "string" && (LEGACY_SCHEDULE_TOOL_NAMES as readonly string[]).includes(name)) {
			name = SCHEDULE_TOOL_NAME;
		}
		if (typeof name === "string" && ALL_KNOWN_SET.has(name) && !out.includes(name)) {
			out.push(name);
		}
	}
	return out;
}

/** 默认禁用名单：统一由全部工具条目的 !defaultOn 声明式推导，绝无任何手写特例。 */
export function defaultDisabledAgentTools(): string[] {
	return ALL_AGENT_TOOL_ENTRIES.filter((t) => !t.defaultOn).map((t) => t.name);
}

/** 单个工具是否启用（禁用名单里没有 = 启用）。 */
export function isAgentToolEnabled(name: string, disabled: readonly string[]): boolean {
	return !disabled.includes(name);
}

/** ActiveSet 子集（SDK AgentSession 的门控面；结构化类型便于单测传假对象）。 */
export interface ActiveToolSet {
	getActiveToolNames(): string[];
	setActiveToolsByName(names: string[]): void;
	/** 全量工具基线（含被禁用的）。SDK 会话自带；没有它就无法区分「从未有过」
	 *  与「被禁用」，门控复原会失真，因此必选。 */
	getAllTools(): Array<{
		name: string;
		namespace?: { name?: string };
		exposure?: string;
	}>;
}

/**
 * 统一出入口 tool_manage：开关任意一个已登记的工具（live 生效，无需 reload；
 * 工具仍留在注册表，重开可直接加回）。未知工具名返回 false（不抛错，
 * 调用方据此给 AI/用户报错）；session 未就绪同样返回 false。
 */
export function setAgentToolEnabled(session: ActiveToolSet, name: string, on: boolean): boolean {
	if (!isKnownAgentTool(name)) return false;
	try {
		const names = new Set(session.getActiveToolNames());
		if (on) names.add(name);
		else names.delete(name);
		session.setActiveToolsByName([...names]);
		return true;
	} catch {
		return false;
	}
}

/** 批量版（组头全开/全关用；含未知名时照常处理已知部分，返回实际处理数）。 */
export function setAgentToolsEnabled(session: ActiveToolSet, names: readonly string[], on: boolean): number {
	const known = names.filter(isKnownAgentTool);
	if (known.length === 0) return 0;
	try {
		const active = new Set(session.getActiveToolNames());
		for (const n of known) {
			if (on) active.add(n);
			else active.delete(n);
		}
		session.setActiveToolsByName([...active]);
		return known.length;
	} catch {
		return 0;
	}
}

/**
 * 全量重放（创建会话 / reload 后 / 设置变更后调）：
 *
 * 采用管辖权差异化门控模型（Authority Boundary Gating）：
 * 1. 宿主受管工具（Host-Managed Tools，即核心内置工具 + AGENT_TOOL_CATALOG 工具）：
 *    由 Web UI 的 disabledAgentTools 开关、模式硬闸门与预设白名单完全掌控状态。
 * 2. 扩展自主工具（Extension-Owned Tools，如 pi-web-search 的 url_context 等）：
 *    Web UI 默认信任其在活跃集中的既有状态（getActiveToolNames），绝不擅自重新启用
 *    已被扩展主动关闭的外部工具，避免破坏模型的 Prompt 缓存前缀。
 * 3. 预设安全过滤：预设（Preset）只对最终候选集做安全收缩（例如 ask 纯对话清空所有工具，
 *    minimal 仅保留 bash+read 等）。
 *
 * Session 未就绪时静默跳过（下次创建/reload 会再应用）。
 */
export function applyAgentToolsGating(
	session: ActiveToolSet,
	disabled: readonly string[],
	preset?: string,
	options?: {
		/** 预设过滤后强制加回的活跃工具（延迟加载模式的 `load_tools` 用：它不在任何
		 *  预设白名单里，又必须永远可用）。 */
		forceActive?: readonly string[];
	},
): void {
	try {
		const off = new Set(disabled);
		const allNames = session.getAllTools().map((t) => t.name);
		const initialActiveNames = new Set(session.getActiveToolNames());

		// 明确管辖权分界：
		// - 宿主受管工具：以全集为基线，依据 disabled 名单全量重放；
		// - 扩展自主工具：以 session.getActiveToolNames() 为准继承当前活跃态，未激活的绝不自动开启。
		const names = new Set<string>();
		for (const name of allNames) {
			if (isHostManagedTool(name)) {
				names.add(name);
			} else if (initialActiveNames.has(name)) {
				names.add(name);
			}
		}

		for (const t of AGENT_TOOL_CATALOG) {
			if (off.has(t.name)) {
				// issue #481: 若第三方扩展注册了同名工具（如 nicobailon/pi-subagents 的 subagent），
				// 关闭内置工具时允许扩展工具透传，不从活跃名单删除；其余由扩展自身注册的工具（如 codemode）正常随禁用名单剔除
				const isShadowedCustomTool = t.name === "subagent";
				const hasExtensionTool =
					isShadowedCustomTool &&
					Boolean(
						(
							session as {
								extensionRunner?: { getAllRegisteredTools?: () => Array<{ definition?: { name?: string } }> };
							}
						)?.extensionRunner
							?.getAllRegisteredTools?.()
							?.some((tool) => tool.definition?.name === t.name),
					);
				if (!hasExtensionTool) {
					names.delete(t.name);
				}
			} else {
				names.add(t.name);
			}
		}
		for (const core of CORE_BUILTIN_TOOL_NAMES) {
			if (off.has(core)) names.delete(core);
			else if (allNames.includes(core)) names.add(core);
		}
		// load_tools 是延迟加载模式下的脚手架工具：非延迟加载模式下绝不暴露给模型。
		// 默认从候选集中剔除；仅当延迟加载开启且由 options.forceActive 显式指定时才加回。
		names.delete(LOAD_TOOLS_TOOL_NAME);
		// PATCH-B1: MCP 工具尊重 exposure——codemode/deferred/hidden 不进门控基线。
		// 全集基线会把非 direct 的 MCP 工具强制激活（schema 全量注入每轮请求，pi 本体的
		// tool_search 按需加载被绕过，实测 deferred 配置下 241 个工具回归全量）。
		// 现交给 pi 本体机制管理；存在 deferred 工具时保活 tool_search 发现通道
		// （用户在禁用名单显式关掉 tool_search 时尊重其选择）。options.forceActive 可越过。
		const allToolsSnapshot = session.getAllTools?.() ?? [];
		let hasDeferredMcp = false;
		for (const t of allToolsSnapshot) {
			const ns = t?.namespace?.name ?? "";
			if (typeof ns !== "string" || !ns.startsWith("mcp__")) continue;
			const exp = t.exposure ?? "codemode";
			if (exp === "direct" || exp === "model-only") continue;
			names.delete(t.name);
			if (exp === "deferred") hasDeferredMcp = true;
		}
		if (hasDeferredMcp && allNames.includes("tool_search") && !off.has("tool_search")) names.add("tool_search");
		const filtered = filterToolsByPreset(names, preset);
		const active = new Set(filtered);
		const baseline = new Set(allNames);
		for (const name of options?.forceActive ?? []) {
			if (baseline.has(name) && !off.has(name)) active.add(name);
		}
		session.setActiveToolsByName([...active]);
	} catch {
		// Session 未就绪——下次创建/reload 会再应用。
	}
}

/**
 * 延迟加载：把「除核心工具 / 已加载 / load_tools 之外的已登记工具」算成临时禁用名单，
 * 直接交给 applyAgentToolsGating。
 *
 * 用禁用名单而不是另加一套机制：`applyAgentToolsGating` 本来就是「按名字加减活跃集」，
 * 于是延迟加载不引入第二条门控路径，与用户禁用名单 / 计划·审查闸门同一条链——
 * 加载只是把名字从这份名单里拿出来。
 */
export function lazyLoadingDisabledTools(
	allNames: readonly string[],
	loaded: Iterable<string>,
	core: readonly string[] = LAZY_CORE_TOOL_NAMES,
): string[] {
	const keep = new Set<string>([...core, LOAD_TOOLS_TOOL_NAME, ...loaded]);
	return allNames.filter((n) => !keep.has(n));
}

/** pi 引擎内置 Agent 预设名录（对齐 DSH 预设体系，会话级工具白名单）。 */
export const PI_AGENT_PRESETS: UiAgentPreset[] = [
	{
		id: "standard",
		trust: "system",
		isDefault: true,
		name: "全功能",
		nameEn: "Full access",
		description: "提供全部可用工具与扩展能力（默认）",
		descriptionEn: "All available tools and extension capabilities (default)",
		order: 0,
	},
	{
		id: "minimal",
		trust: "system",
		isDefault: false,
		name: "极简模式",
		nameEn: "Minimal",
		description: "仅保留 bash 与 read；插件工具、技能名录与终端引导同步隐藏",
		descriptionEn: "Keeps only bash and read; plugin tools, skill catalog and terminal guidance are hidden too",
		order: 1,
	},
	{
		id: "code",
		trust: "system",
		isDefault: false,
		name: "代码开发",
		nameEn: "Code development",
		description: "专注于代码读写与执行（bash, read, edit, write, edit_soft）；插件工具与技能名录同步隐藏",
		descriptionEn:
			"Focused on reading, writing and running code (bash, read, edit, write, edit_soft); plugin tools and skill catalog are hidden too",
		order: 2,
	},
	{
		id: "reader",
		trust: "system",
		isDefault: false,
		name: "只读分析",
		nameEn: "Read-only analysis",
		description: "仅保留只读工具，禁止写操作；插件工具同步隐藏（读写未知，保守处理）",
		descriptionEn:
			"Keeps only read-only tools and forbids writes; plugin tools are hidden too (read/write unknown, handled conservatively)",
		order: 3,
	},
	{
		id: "ask",
		trust: "system",
		isDefault: false,
		name: "纯对话",
		nameEn: "Chat only",
		description: "无工具问答模式，模型不调用任何工具；插件工具与技能名录同步隐藏",
		descriptionEn: "No-tools Q&A: the model never calls a tool; plugin tools and skill catalog are hidden too",
		order: 4,
	},
];

/** pi 引擎权限预设选项（三档沙箱策略）。 */
export const PI_PERMISSION_OPTIONS: DshPermissionOption[] = [
	{
		value: "read-only",
		name: "只读模式",
		nameEn: "Read Only",
		description: "禁止所有文件修改（write/edit/edit_soft）及任何非只读操作",
		descriptionEn: "Forbids all file modification (write/edit/edit_soft) and any non-read-only operation",
	},
	{
		value: "workspace-write-never",
		name: "工作区内修改",
		nameEn: "Workspace Write",
		description: "仅允许在当前工作区目录下修改文件，工作区外写操作一律拒绝",
		descriptionEn: "Only files under the current workspace may be modified; writes outside it are always denied",
	},
	{
		value: "danger-full-access",
		name: "完全权限",
		nameEn: "Full access",
		description: "允许修改任意目录文件及执行全量操作（需要二次确认）",
		descriptionEn: "Allows modifying files anywhere and running any operation (needs a second confirmation)",
	},
];

/**
 * 预设/权限文案随界面语言落定：中文界面用服务端默认文案，其它语言用
 * nameEn ?? name（与审批规则的 labelEn/reasonEn、插件的 label/labelEn 同一约定；
 * 其它语言包同理回落英文）。服务端 notice 的 textEn 也走这里，否则英文界面会看到
 * `Switched to preset "全功能"`。
 *
 * lang 是 ServerLang（resolveServerLang 的产物）：只有 "zh" 算中文。
 * 本文件保持零依赖，故直接比字符串而不 import server/i18n.js。
 */
export function localizedName(
	item: { name?: string; nameEn?: string } | undefined,
	lang: string,
	fallback = "",
): string {
	if (!item) return fallback;
	return lang === "zh" ? (item.name ?? item.nameEn ?? fallback) : (item.nameEn ?? item.name ?? fallback);
}

/** localizedName 的描述版本（description 两边都可缺省 → undefined）。 */
export function localizedDescription(
	item: { description?: string; descriptionEn?: string } | undefined,
	lang: string,
): string | undefined {
	if (!item) return undefined;
	return lang === "zh" ? (item.description ?? item.descriptionEn) : (item.descriptionEn ?? item.description);
}

/** 按预设过滤活跃工具名。 */
export function filterToolsByPreset(tools: Iterable<string>, preset?: string): string[] {
	const all = Array.from(tools);
	if (!preset || preset === "standard") return all;
	if (preset === "ask") return [];
	if (preset === "minimal") {
		return all.filter((n) => n === "bash" || n === "read");
	}
	if (preset === "code") {
		const codeSet = new Set(["bash", "read", "edit", "write", "edit_soft"]);
		return all.filter((n) => codeSet.has(n));
	}
	if (preset === "reader") {
		const writeTools = new Set([
			"write",
			"edit",
			"edit_soft",
			"bash",
			"powershell",
			"terminal_create",
			"terminal_input",
			"terminal_close",
			"terminal_key",
			"codemode",
		]);
		return all.filter((n) => !writeTools.has(n));
	}
	return all;
}

/**
 * pi 预设语义总表（唯一事实源，本文件是唯一定义处）：
 *
 * 预设是「禁用名单之外」的第二层门控，按会话生效（conv.agentPreset），新对话
 * 取默认预设、首轮发言后锁定。标准预设不过滤；其余预设同时约束四处：
 *
 * - 目录/内置工具（ActiveSet）：filterToolsByPreset 直接过滤活跃集
 *   （standard 全留 / ask 全拔 / minimal 仅 bash+read /
 *   code 仅 bash+read+edit+write+edit_soft / reader 拔写类）。
 * - 插件工具（registerAgentTool 动态注册）：presetAllowsPluginTools —— 只有
 *   standard 保留，其余已知预设一律拔掉。插件工具读写性质未知，保守按最严处理
 *   （minimal/code/ask 是白名单语义本来就过不去；reader 是 deny 名单，
 *   未知工具同样不放行；未知预设 id 按不过滤，与 filterToolsByPreset 同口径）。
 * - 技能名录段（{{skills}} 名录＋全文注入）：presetShowsSkillCatalog —— 与
 *   skill 加载工具同进退（minimal/code/ask 下 loader 不在，列出来只是噪音；
 *   reader 下 loader 可用，保留）。子代理模板的技能白名单是显式配置，
 *   优先级高于预设，不参与此门控。
 * - 终端引导（TERMINAL_TOOLS_GUIDANCE）：isTerminalGuidanceOn(disabled, preset) ——
 *   只教「开关开着且预设下仍可用」的终端工具，不教不存在的工具。
 * - 并行提醒（parallel-work-reminder）：信息层，不按预设开关（只看
 *   parallelReminderEnabled 开关）；但文案里的问卷指引按
 *   presetHasQuestionnaire 切换措辞——有问卷工具时调工具，否则正文提问。
 *   认领信息是事实层，照常展示（store 是按项目全局的）。
 *
 * 显式配置永远优先于预设：disabledAgentTools / disabledPluginTools /
 * disabledSkills / 子代理模板白名单照常生效，预设只做减法不做加法
 * （开关关掉的东西，standard 也不会加回来）。
 */

/**
 * 预设是否允许插件工具（动态注册，读写未知）：只有 standard 允许；
 * 其余已知预设一律拒绝。未知 id 按不过滤（与 filterToolsByPreset 同口径，
 * 防手写脏配置把插件工具全灭）。
 */
export function presetAllowsPluginTools(preset?: string): boolean {
	if (!preset || preset === "standard") return true;
	return !PI_AGENT_PRESETS.some((p) => p.id === preset);
}

/**
 * 预设下是否展示技能名录段（与 skill 加载工具同进退，由 filterToolsByPreset
 * 单源推导，不另维护名单：minimal/code/ask 藏，standard/reader 留）。
 */
export function presetShowsSkillCatalog(preset?: string): boolean {
	return filterToolsByPreset([SKILL_TOOL_NAME], preset).includes(SKILL_TOOL_NAME);
}

/**
 * 预设下问卷工具是否可用（并行提醒等服务端文案用：有则指引调工具，
 * 无则指引正文提问——不教不存在的工具）。同样单源推导。
 */
export function presetHasQuestionnaire(preset?: string): boolean {
	return filterToolsByPreset([ASK_USER_QUESTION_TOOL_NAME], preset).includes(ASK_USER_QUESTION_TOOL_NAME);
}

// ---------------------------------------------------------------------------
// 遗留别名同步（terminalToolsEnabled / editSoftEnabled / questionnaireEnabled）
// ---------------------------------------------------------------------------

/** 遗留三开关的结构视图（client-state / settings-service 共用，避免循环 import）。 */
export interface LegacyToolSwitches {
	terminalToolsEnabled?: boolean;
	editSoftEnabled?: boolean;
	questionnaireEnabled?: boolean;
	disabledAgentTools?: unknown;
}

/**
 * 旧存档迁移：已有新字段直接归一化；否则按遗留三开关折算。
 * 以统一默认禁用名单为基底，遗留三开关仅在显式指定时加减偏好。
 */
export function legacyToDisabled(s: LegacyToolSwitches): string[] {
	if (Array.isArray(s.disabledAgentTools)) return normalizeDisabledAgentTools(s.disabledAgentTools);
	const off = new Set(defaultDisabledAgentTools());
	if (s.terminalToolsEnabled === true) {
		for (const n of TERMINAL_TOOL_NAMES) off.delete(n);
	}
	if (s.editSoftEnabled === true) off.delete(EDIT_SOFT_TOOL_NAME);
	if (s.questionnaireEnabled === false) off.add(ASK_USER_QUESTION_TOOL_NAME);
	return normalizeDisabledAgentTools([...off]);
}

/** 由禁用名单推导遗留三开关（协议兼容用；终端组按“全开才算开”的全有/全无视图）。 */
export function deriveLegacy(disabled: readonly string[]): {
	terminalToolsEnabled: boolean;
	editSoftEnabled: boolean;
	questionnaireEnabled: boolean;
} {
	const off = new Set(disabled);
	return {
		terminalToolsEnabled: TERMINAL_TOOL_NAMES.every((n) => !off.has(n)),
		editSoftEnabled: !off.has(EDIT_SOFT_TOOL_NAME),
		questionnaireEnabled: !off.has(ASK_USER_QUESTION_TOOL_NAME),
	};
}

/**
 * 遗留单开关写入时折回新字段（只动开关覆盖的组，其余条目原样保留）：
 * 传 true = 把该组从禁用名单移除，false = 加入，未传 = 不动。
 */
export function foldLegacyIntoDisabled(
	current: readonly string[],
	legacy: Pick<LegacyToolSwitches, "terminalToolsEnabled" | "editSoftEnabled" | "questionnaireEnabled">,
): string[] {
	const next = new Set(normalizeDisabledAgentTools(current));
	const applyGroup = (names: readonly string[], v: boolean | undefined) => {
		if (v === undefined) return;
		for (const n of names) {
			if (v) next.delete(n);
			else next.add(n);
		}
	};
	applyGroup(TERMINAL_TOOL_NAMES, legacy.terminalToolsEnabled);
	applyGroup([EDIT_SOFT_TOOL_NAME], legacy.editSoftEnabled);
	applyGroup([ASK_USER_QUESTION_TOOL_NAME], legacy.questionnaireEnabled);
	return [...next];
}

/**
 * 门控实效名单：新字段 + 问卷别名合并（问卷关 = ask 工具必关，双保险；
 * 两处平时由 set() 同步一致，合并只防陈旧会话/旧客户端的半边状态）。
 */
export function effectiveDisabledAgentTools(s: LegacyToolSwitches): string[] {
	const next = new Set(legacyToDisabled({ ...s, disabledAgentTools: s.disabledAgentTools }));
	if (s.questionnaireEnabled === false) next.add(ASK_USER_QUESTION_TOOL_NAME);
	return [...next];
}

/**
 * 终端使用引导是否注入：组内有任一工具「开关开着且预设下仍可用」才教 AI 用，
 * 否则就是教不存在的工具（preset 缺省/standard = 只看开关，保持旧语义）。
 */
export function isTerminalGuidanceOn(disabled: readonly string[], preset?: string): boolean {
	const on = TERMINAL_TOOL_NAMES.filter((n) => !disabled.includes(n));
	if (on.length === 0) return false;
	if (!preset || preset === "standard") return true;
	return filterToolsByPreset(on, preset).length > 0;
}
