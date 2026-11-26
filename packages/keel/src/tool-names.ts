/**
 * 工具名登记表（单源）：内置工具名、旧别名、命名规则与折叠。
 *
 * 宿主目录（`server/tool-manager.ts` 的 `AGENT_TOOL_CATALOG`）与内核的工具门控都从这里取名字：
 * 两边各写一份名单，改名那天必然漏一边。
 */
export const CANVAS_TOOL_NAME = "canvas";
export const TERMINAL_TOOL_NAME = "terminal";
export const TERMINAL_TOOL_NAMES = [TERMINAL_TOOL_NAME] as const;
export const LEGACY_TERMINAL_TOOL_NAMES = [
	"terminal_create",
	"terminal_list",
	"terminal_close",
	"terminal_input",
	"terminal_key",
	"terminal_read",
	"terminal_wait",
] as const;

export const CONVERSATION_TOOL_NAME = "conversation";
export const COMMUNICATE_TOOL_NAME = "communicate";

/** Tool names that fold into `conversation`: the pre-rename subagent_* family plus the retired `subagent` alias. */
export const LEGACY_SUBAGENT_TOOL_NAMES = [
	"subagent",
	"subagent_spawn",
	"subagent_get_result",
	"subagent_steer",
	"subagent_list",
	"subagent_stop",
	"subagent_wait_all",
	"subagent_templates",
	"subagent_handoff",
] as const;

export const DELEGATE_TASK_TOOL_NAME = "delegate_task";
export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
export const BROWSER_PAGE_TOOL_NAME = "browser_page";
export const BROWSER_SCRIPT_TOOL_NAME = "browser_script";
export const BROWSER_DESIGN_TOOL_NAME = "browser_design";
export const PHONE_TOOL_NAME = "phone";
export const CONVERSATION_READ_TOOL_NAME = CONVERSATION_TOOL_NAME;
export const SKILL_TOOL_NAME = "skill";
export const SCHEDULE_TOOL_NAME = "schedule";
export const BG_TASK_TOOL_NAME = "bg_task";
export const LEGACY_SCHEDULE_TOOL_NAMES = ["schedule_task", "schedule_list", "schedule_cancel"] as const;
export const EVAL_TOOL_NAME = "eval";
export const PRESENT_FILES_TOOL_NAME = "present_files";
export const CLAIM_FILES_TOOL_NAME = "claim_files";
export const PLAN_UPDATE_TOOL_NAME = "plan_update";
export const COMPACT_CONTEXT_TOOL_NAME = "compact_context";
export const PATCH_TOOL_NAME = "patch";
export const LSP_TOOL_NAME = "lsp";
export const MCP_MANAGE_TOOL_NAME = "mcp_manage";
export const SANDBOX_TOOL_NAME = "sandbox";
export const WORKTREE_TOOL_NAME = "worktree";
export const DEVICE_COLLAB_TOOL_NAME = "device_collab";
/** Bot 个人记忆（独立 memory 目录）。只对"有记忆目录的 Bot 执行"注册，不进普通设置目录。 */
export const BOT_MEMORY_TOOL_NAME = "memory";
/** 一句话创建 Bot：只写待确认草案，不直接建 Bot。 */
export const AGENT_BOT_TOOL_NAME = "agent_bot";
export const CODEMODE_TOOL_NAME = "codemode";
export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const LOAD_TOOLS_TOOL_NAME = "load_tools";
export const LAZY_CORE_TOOL_NAMES = ["bash", "read", "edit", "write"] as const;

/**
 * 工具名统一规则（架构单源）：内置 + 插件 + MCP + 未来工具共用。
 * 内置在 `ALL_KNOWN_SET` 里；插件/MCP/未来工具按此正则收，不写死名单，自动包含插件。
 * 与 `normalizeDisabledPluginTools`（client-state.ts）的 128/256 上限对齐。
 */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
export const TOOL_NAME_MAX_LENGTH = 128;
export const TOOL_LIST_MAX_ENTRIES = 256;

export function isValidToolName(name: string): boolean {
	if (!name || name.length > TOOL_NAME_MAX_LENGTH) return false;
	return TOOL_NAME_PATTERN.test(name);
}

/** 旧别名统一折叠（禁用列表与按需名单共用，免得旧存档丢项）。 */
export function foldLegacyToolName(name: string): string {
	if ((LEGACY_TERMINAL_TOOL_NAMES as readonly string[]).includes(name)) return TERMINAL_TOOL_NAME;
	if ((LEGACY_SUBAGENT_TOOL_NAMES as readonly string[]).includes(name)) return CONVERSATION_TOOL_NAME;
	if (name === "conversation_read") return CONVERSATION_TOOL_NAME;
	if ((LEGACY_SCHEDULE_TOOL_NAMES as readonly string[]).includes(name)) return SCHEDULE_TOOL_NAME;
	return name;
}

/** 永不延迟：核心 4 件套 + load_tools 本体。前端置灰与后端过滤共用此语义（前端见 LAZY_CORE 注）。 */
export function isNeverLazyTool(name: string): boolean {
	return name === LOAD_TOOLS_TOOL_NAME || (LAZY_CORE_TOOL_NAMES as readonly string[]).includes(name);
}
